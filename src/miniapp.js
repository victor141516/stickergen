import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { InputFile } from "grammy";
import { generateStickerImage } from "./codex.js";
import { stickerDataUrl, toStickerWebp, transparencyStats } from "./stickers.js";
import { getStylePreset, listStylePresets, promptWithStylePreset } from "./styles.js";
import { validateTelegramInitData } from "./miniapp-auth.js";

const MAX_JSON_BYTES = 15 * 1024 * 1024;
const MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const JOB_TTL_MS = 60 * 60 * 1000;
const JOB_LIMIT = 200;
const PROGRESS_INTERVAL_MS = 2_000;
const SSE_HEARTBEAT_MS = 15_000;
const DEFAULT_GENERATION_ETA_MS = 80_000;

const DEFAULT_SOURCE_PROMPT =
  "Turn the main subject of this source image into a faithful and recognizable Telegram sticker. Preserve important features, render it in the requested style, and use genuine background transparency unless the user asks for a scene or opaque background.";
const DEFAULT_STICKER_PROMPT =
  "Recreate this existing sticker as a polished new variation. Preserve its subject, pose, expression, composition, and identifying details while rendering it in the requested style.";

const STATIC_FILES = new Map([
  ["/app", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app/", { file: "index.html", type: "text/html; charset=utf-8" }],
  ["/app/app.js", { file: "app.js", type: "text/javascript; charset=utf-8" }],
  ["/app/styles.css", { file: "styles.css", type: "text/css; charset=utf-8" }],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new HttpError(413, "The request is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new HttpError(400, "The request body is not valid JSON");
  }
}

function validateSourceDataUrl(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") throw new HttpError(400, "The source image is invalid");
  const match = value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/s);
  if (!match) throw new HttpError(400, "The source image must be PNG, JPG, or WebP");
  const decodedBytes = Buffer.from(match[2], "base64").length;
  if (!decodedBytes) throw new HttpError(400, "The source image is empty");
  if (decodedBytes > MAX_SOURCE_BYTES) throw new HttpError(413, "The source image is larger than 10 MB");
  return value;
}

function formatEta(milliseconds) {
  const seconds = Math.max(5, Math.ceil(milliseconds / 5_000) * 5);
  if (seconds < 60) return `ETA ~${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `ETA ~${minutes}m${remainder ? ` ${remainder}s` : ""}`;
}

function publicJob(job) {
  return {
    error: job.status === "failed" ? job.error : undefined,
    eta: job.status === "complete" ? "Complete" : job.eta,
    id: job.id,
    message: job.message,
    progress: job.progress,
    status: job.status,
  };
}

function sendEvent(response, job) {
  response.write(`event: job\ndata: ${JSON.stringify(publicJob(job))}\n\n`);
}

function safeMiniAppError(error) {
  const message = error?.message || "Sticker generation failed";
  return message.length > 500 ? `${message.slice(0, 500)}…` : message;
}

function contentSecurityPolicy() {
  return [
    "default-src 'self'",
    "script-src 'self' https://telegram.org",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors https://web.telegram.org https://*.telegram.org",
  ].join("; ");
}

export function createMiniAppService({
  bot,
  botToken,
  draftStore,
  downloadTelegramFile,
  loadCredentials,
  webRoot,
  generateImage = generateStickerImage,
  convertToSticker = toStickerWebp,
  getTransparencyStats = transparencyStats,
  sourceToDataUrl = stickerDataUrl,
  estimatedGenerationMs = DEFAULT_GENERATION_ETA_MS,
  logger = console,
  now = Date.now,
}) {
  const jobs = new Map();

  function authenticate(request) {
    const initData = request.headers["x-telegram-init-data"];
    try {
      return validateTelegramInitData(Array.isArray(initData) ? initData[0] : initData, botToken, { now });
    } catch (error) {
      throw new HttpError(401, error.message);
    }
  }

  function pruneJobs() {
    const currentTime = now();
    for (const [id, job] of jobs) {
      if (job.expiresAt <= currentTime && job.status !== "running") jobs.delete(id);
    }
    if (jobs.size < JOB_LIMIT) return;
    for (const [id, job] of jobs) {
      if (jobs.size < JOB_LIMIT) break;
      if (job.status !== "running") jobs.delete(id);
    }
  }

  function broadcast(job) {
    for (const response of job.subscribers) {
      try {
        sendEvent(response, job);
        if (job.status === "complete" || job.status === "failed") response.end();
      } catch {}
    }
    if (job.status === "complete" || job.status === "failed") job.subscribers.clear();
  }

  function updateJob(job, values) {
    Object.assign(job, values);
    broadcast(job);
  }

  function startChatAction(chatId) {
    let stopped = false;
    const refresh = async () => {
      if (stopped) return;
      try { await bot.api.sendChatAction(chatId, "choose_sticker"); } catch {}
    };
    void refresh();
    const timer = setInterval(refresh, 4_000);
    timer.unref?.();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  async function runGeneration(job, requestBody, telegramUser) {
    const generationId = randomUUID();
    const startedAt = now();
    const stopChatAction = startChatAction(telegramUser.id);
    const progressTimer = setInterval(() => {
      const elapsed = now() - startedAt;
      const progress = Math.min(90, Math.floor((elapsed / Math.max(1, estimatedGenerationMs)) * 100));
      updateJob(job, {
        eta: elapsed < estimatedGenerationMs ? formatEta(estimatedGenerationMs - elapsed) : "Finishing…",
        progress,
      });
    }, PROGRESS_INTERVAL_MS);
    progressTimer.unref?.();

    try {
      updateJob(job, { message: "Checking your linked Codex account" });
      const oauth = await loadCredentials(telegramUser.id);
      if (!oauth) throw new Error("Link your OpenAI/Codex account with /login first");

      const preset = requestBody.presetId ? getStylePreset(requestBody.presetId) : null;
      if (requestBody.presetId && !preset) throw new HttpError(400, "That style preset is no longer available");

      const draft = requestBody.draftId
        ? draftStore.get(requestBody.draftId, telegramUser.id)
        : null;
      if (requestBody.draftId && !draft) throw new HttpError(404, "That sticker draft has expired");

      let sourceDataUrl = validateSourceDataUrl(requestBody.sourceDataUrl);
      if (draft && sourceDataUrl) throw new HttpError(400, "Choose either the Telegram sticker or an uploaded image");
      if (draft) {
        const source = await downloadTelegramFile(draft.fileId);
        sourceDataUrl = await sourceToDataUrl(source);
      }

      const userPrompt = typeof requestBody.prompt === "string" ? requestBody.prompt.trim() : "";
      if (userPrompt.length > 2_000) throw new HttpError(400, "The prompt is longer than 2000 characters");
      const basePrompt = userPrompt || (draft ? DEFAULT_STICKER_PROMPT : sourceDataUrl ? DEFAULT_SOURCE_PROMPT : "");
      if (!basePrompt) throw new HttpError(400, "Describe a sticker or add a source image first");
      const prompt = promptWithStylePreset(basePrompt, preset);

      logger.info("miniapp_sticker_generation_started", JSON.stringify({
        generationId,
        jobId: job.id,
        presetId: preset?.id || null,
        sourceImage: Boolean(sourceDataUrl),
      }));
      updateJob(job, { message: "Creating your sticker image" });
      const rawImage = await generateImage({ oauth, prompt, sourceDataUrl });
      const generatedTransparency = await getTransparencyStats(rawImage);
      updateJob(job, { message: "Preparing the Telegram sticker", progress: 94, eta: "Almost there…" });
      const webp = await convertToSticker(rawImage);
      const outputTransparency = await getTransparencyStats(webp);

      updateJob(job, { message: "Sending it to your Telegram chat", progress: 98, eta: "Almost there…" });
      const replyParameters = draft?.messageId
        ? { reply_parameters: { message_id: draft.messageId, allow_sending_without_reply: true } }
        : {};
      const sentMessage = await bot.api.sendSticker(
        draft?.chatId || telegramUser.id,
        new InputFile(webp, "stickergen-miniapp.webp"),
        replyParameters,
      );

      job.image = webp;
      job.telegramMessageId = sentMessage.message_id;
      job.expiresAt = now() + JOB_TTL_MS;
      updateJob(job, {
        eta: "Complete",
        message: "Sent to your Telegram chat",
        progress: 100,
        status: "complete",
      });
      logger.info("miniapp_sticker_generation_sent", JSON.stringify({
        generationId,
        jobId: job.id,
        stickerBytes: webp.length,
        generatedTransparency,
        outputTransparency,
      }));
    } catch (error) {
      const message = safeMiniAppError(error);
      job.expiresAt = now() + JOB_TTL_MS;
      updateJob(job, {
        error: message,
        eta: "Stopped",
        message: "Generation failed",
        status: "failed",
      });
      logger.error("miniapp_sticker_generation_failed", JSON.stringify({
        generationId,
        jobId: job.id,
        codexRequestId: error?.codexRequestId || null,
        error: message,
      }));
    } finally {
      clearInterval(progressTimer);
      stopChatAction();
    }
  }

  async function serveStatic(response, pathname) {
    const asset = STATIC_FILES.get(pathname);
    if (!asset) return false;
    const content = await readFile(path.join(webRoot, asset.file));
    response.writeHead(200, {
      "Cache-Control": asset.file === "index.html" ? "no-cache" : "public, max-age=300",
      "Content-Security-Policy": contentSecurityPolicy(),
      "Content-Type": asset.type,
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
    return true;
  }

  async function handleRequest(request, response) {
    const url = new URL(request.url, "http://localhost");
    try {
      if (request.method === "GET" && await serveStatic(response, url.pathname)) return true;

      if (request.method === "GET" && url.pathname === "/api/miniapp/styles") {
        json(response, 200, listStylePresets().map(({ id, name, buttonText, description }) => ({
          id,
          name,
          buttonText,
          description,
        })), { "Cache-Control": "public, max-age=300" });
        return true;
      }

      const draftMatch = url.pathname.match(/^\/api\/miniapp\/drafts\/([0-9a-f-]{36})(\/image)?$/);
      if (request.method === "GET" && draftMatch) {
        const { user } = authenticate(request);
        const draft = draftStore.get(draftMatch[1], user.id);
        if (!draft) throw new HttpError(404, "That sticker draft has expired");
        if (draftMatch[2]) {
          const source = await downloadTelegramFile(draft.fileId);
          response.writeHead(200, {
            "Cache-Control": "private, no-store",
            "Content-Type": draft.mimeType,
            "X-Content-Type-Options": "nosniff",
          });
          response.end(source);
        } else {
          json(response, 200, { id: draft.id, name: draft.name, mimeType: draft.mimeType });
        }
        return true;
      }

      if (request.method === "POST" && url.pathname === "/api/miniapp/generations") {
        pruneJobs();
        const { user } = authenticate(request);
        const requestBody = await readJson(request);
        const job = {
          id: randomUUID(),
          userId: user.id,
          status: "running",
          progress: 0,
          eta: formatEta(estimatedGenerationMs),
          message: "Preparing your request",
          error: null,
          image: null,
          subscribers: new Set(),
          createdAt: now(),
          expiresAt: now() + JOB_TTL_MS,
        };
        jobs.set(job.id, job);
        void runGeneration(job, requestBody, user)
          .catch((error) => logger.error("detached_miniapp_generation_failed", error));
        json(response, 202, { jobId: job.id });
        return true;
      }

      const jobMatch = url.pathname.match(/^\/api\/miniapp\/generations\/([0-9a-f-]{36})(\/(?:events|image))$/);
      if (request.method === "GET" && jobMatch) {
        const { user } = authenticate(request);
        const job = jobs.get(jobMatch[1]);
        if (!job || job.userId !== user.id) throw new HttpError(404, "That generation was not found");
        if (jobMatch[2] === "/image") {
          if (job.status !== "complete" || !job.image) throw new HttpError(409, "The sticker is not ready yet");
          response.writeHead(200, {
            "Cache-Control": "private, no-store",
            "Content-Disposition": "inline; filename=sticker.webp",
            "Content-Type": "image/webp",
            "X-Content-Type-Options": "nosniff",
          });
          response.end(job.image);
          return true;
        }

        response.writeHead(200, {
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Accel-Buffering": "no",
        });
        response.flushHeaders?.();
        sendEvent(response, job);
        if (job.status === "complete" || job.status === "failed") {
          response.end();
          return true;
        }
        job.subscribers.add(response);
        const heartbeat = setInterval(() => {
          try { response.write(": ping\n\n"); } catch {}
        }, SSE_HEARTBEAT_MS);
        heartbeat.unref?.();
        response.on("close", () => {
          clearInterval(heartbeat);
          job.subscribers.delete(response);
        });
        return true;
      }

      return false;
    } catch (error) {
      const status = error?.status || 500;
      if (status >= 500) logger.error("miniapp_http_request_failed", error?.message || error);
      if (!response.headersSent) json(response, status, {
        error: status >= 500 ? "StickerGen could not complete the request" : error.message,
      });
      else response.end();
      return true;
    }
  }

  return { handleRequest, jobs };
}
