import { createHash, randomUUID } from "node:crypto";

const DEFAULT_URL = "https://chatgpt.com/backend-api/codex/responses";
const REDACTED_KEYS = new Set([
  "access_token",
  "authorization",
  "cookie",
  "encrypted_content",
  "refresh_token",
  "session_token",
]);
const IMAGE_VALUE_KEYS = new Set([
  "b64_json",
  "image_base64",
  "image_url",
  "partial_image_b64",
  "result",
  "url",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function summarizedValue(value, kind) {
  return {
    redacted: kind,
    characters: value.length,
    sha256: sha256(value),
  };
}

function summarizedImageValue(value) {
  const summary = summarizedValue(value, "image data");
  const dataUrl = value.match(/^data:([^;,]+)(?:;base64)?,(.*)$/s);
  if (!dataUrl) return summary;
  return {
    ...summary,
    mediaType: dataUrl[1],
    encodedCharacters: dataUrl[2].length,
  };
}

function sanitizedUrl(value) {
  try {
    const parsed = new URL(value);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return summarizedValue(value, "unparseable URL");
  }
}

function sanitizeForLog(value, key = "", depth = 0) {
  const normalizedKey = key.toLowerCase();
  if (REDACTED_KEYS.has(normalizedKey)) return { redacted: normalizedKey };
  if (typeof value === "string") {
    if (IMAGE_VALUE_KEYS.has(normalizedKey)) {
      if (/^https?:\/\//i.test(value)) return sanitizedUrl(value);
      return summarizedImageValue(value);
    }
    if (value.length > 2_000) {
      return { preview: value.slice(0, 2_000), ...summarizedValue(value, "long text") };
    }
    return value;
  }
  if (value === null || typeof value !== "object") return value;
  if (depth >= 12) return { redacted: "maximum trace depth" };
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, key, depth + 1));
  }
  return Object.fromEntries(
    Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeForLog(childValue, childKey, depth + 1),
    ]),
  );
}

function safeResponseHeaders(headers) {
  const names = [
    "content-type",
    "openai-request-id",
    "x-request-id",
    "x-envoy-upstream-service-time",
  ];
  return Object.fromEntries(
    names.map((name) => [name, headers.get(name)]).filter(([, value]) => value),
  );
}

function createRequestTrace({ requestId, url, payload, accountId }) {
  return {
    requestId,
    request: {
      method: "POST",
      url: sanitizedUrl(url),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: { redacted: "bearer token" },
        "chatgpt-account-id": summarizedValue(String(accountId || ""), "account identifier"),
        "content-type": "application/json",
        originator: "telegram-sticker-bot",
        "session-id": requestId,
        "user-agent": "telegram-sticker-bot/0.1",
      },
      body: sanitizeForLog(payload),
    },
    response: {
      status: null,
      headers: {},
      events: [],
    },
  };
}

function imageValue(value) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return null;
  return value.result || value.image_base64 || value.b64_json || value.url || value.image?.url || value.image?.b64_json || null;
}

function collectImageFromOutput(output) {
  for (const item of output || []) {
    if (item?.type === "image_generation_call") {
      const value = imageValue(item);
      if (value) return value;
    }
    if (item?.type === "output_image" && (item.image_base64 || item.b64_json || item.url)) {
      return item.image_base64 || item.b64_json || item.url;
    }
  }
  return null;
}

function outputItems(event) {
  return [
    event?.item,
    event?.output_item,
    ...(Array.isArray(event?.output) ? event.output : []),
    ...(Array.isArray(event?.response?.output) ? event.response.output : []),
  ].filter(Boolean);
}

function errorMessage(value) {
  const candidates = [
    value?.message,
    value?.error?.message,
    typeof value?.error === "string" ? value.error : null,
    value?.response?.error?.message,
    typeof value?.response?.error === "string" ? value.response.error : null,
  ];
  return candidates.find((candidate) => typeof candidate === "string" && candidate.trim()) || null;
}

function errorCode(value) {
  const candidates = [
    value?.code,
    value?.error?.code,
    value?.response?.error?.code,
  ];
  return candidates.find((candidate) => typeof candidate === "string" && candidate.trim()) || null;
}

function outputMessage(event) {
  const directText = event?.text || event?.part?.text || event?.part?.refusal;
  if (typeof directText === "string" && directText.trim()) return directText.trim().slice(0, 500);
  for (const item of outputItems(event)) {
    if (item?.type !== "message" || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      const text = part?.refusal || part?.text;
      if (typeof text === "string" && text.trim()) return text.trim().slice(0, 500);
    }
  }
  return null;
}

function failureFromEvent(event) {
  if (event?.type === "error" || event?.type === "response.failed" || event?.response?.status === "failed") {
    return errorMessage(event) || "Codex could not generate the sticker";
  }

  if (event?.type === "response.incomplete" || event?.response?.status === "incomplete") {
    const reason = event?.response?.incomplete_details?.reason || event?.incomplete_details?.reason;
    return reason
      ? `Codex returned an incomplete response: ${reason}`
      : "Codex returned an incomplete response";
  }

  if (event?.type === "response.refusal.done" && typeof event.refusal === "string") {
    return `Codex refused to generate the sticker: ${event.refusal}`;
  }
  return null;
}

function createDiagnostics() {
  return {
    eventTypes: new Set(),
    responseStatus: null,
    imageStatus: null,
    imageFailure: null,
    outputMessage: null,
  };
}

function recordDiagnostics(diagnostics, event) {
  if (!diagnostics || !event || typeof event !== "object") return;
  if (typeof event.type === "string" && diagnostics.eventTypes.size < 20) {
    diagnostics.eventTypes.add(event.type);
  }
  if (typeof event.response?.status === "string") diagnostics.responseStatus = event.response.status;
  diagnostics.outputMessage ||= outputMessage(event);
  for (const item of outputItems(event)) {
    if (item?.type === "image_generation_call" && typeof item.status === "string") {
      diagnostics.imageStatus = item.status;
    }
    if (item?.type === "image_generation_call" && (item.status === "failed" || item.error)) {
      const detail = errorMessage(item);
      const code = errorCode(item);
      diagnostics.imageFailure = detail
        ? `Codex image generation failed: ${detail}`
        : `Codex image generation failed${code ? ` (${code})` : ""}`;
    }
  }
}

function missingImageError(diagnostics) {
  const details = [];
  if (diagnostics?.eventTypes?.size) {
    details.push(`events: ${[...diagnostics.eventTypes].join(", ")}`);
  }
  if (diagnostics?.responseStatus) details.push(`response status: ${diagnostics.responseStatus}`);
  if (diagnostics?.imageStatus) details.push(`image status: ${diagnostics.imageStatus}`);
  const base = diagnostics?.imageFailure || "Codex did not return an image";
  const modelDetail = diagnostics?.outputMessage ? `: ${diagnostics.outputMessage}` : "";
  return new Error(`${base}${modelDetail}${details.length ? ` (${details.join("; ")})` : ""}`);
}

function findImageInEvent(event) {
  const candidates = [
    event?.image,
    event?.result,
    event?.image_base64,
    event?.b64_json,
    event?.url,
    event?.response?.output && collectImageFromOutput(event.response.output),
    event?.item && collectImageFromOutput([event.item]),
    event?.output_item && collectImageFromOutput([event.output_item]),
  ];
  return candidates.find((value) => typeof value === "string" && value.length > 100) || null;
}

function parseSseFrame(frame, diagnostics, trace) {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data || data === "[DONE]") return { image: null };

  let event;
  try {
    event = JSON.parse(data);
  } catch {
    trace?.response.events.push({
      invalidJson: summarizedValue(data, "invalid SSE data"),
    });
    throw new Error("Codex returned an invalid SSE event");
  }
  trace?.response.events.push(sanitizeForLog(event));
  recordDiagnostics(diagnostics, event);
  const failure = failureFromEvent(event);
  if (failure) throw new Error(failure);
  return { image: findImageInEvent(event) };
}

function parseSseDocument(text, trace) {
  let image = null;
  const diagnostics = createDiagnostics();
  const frames = text.replace(/\r\n/g, "\n").split("\n\n");
  for (const frame of frames) {
    if (!frame.trim()) continue;
    image = parseSseFrame(frame, diagnostics, trace).image || image;
  }
  if (!image) throw missingImageError(diagnostics);
  return image;
}

async function parseResponse(response, trace) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const text = await response.text();
    if (/^\s*(?:event|data):/i.test(text)) return parseSseDocument(text, trace);
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      trace.response.body = summarizedValue(text, "non-JSON response body");
      throw new Error("Codex returned a response that is neither JSON nor SSE");
    }
    trace.response.body = sanitizeForLog(body);
    const diagnostics = createDiagnostics();
    recordDiagnostics(diagnostics, body);
    const failure = failureFromEvent(body);
    if (failure) throw new Error(failure);
    const image = collectImageFromOutput(body.output) || collectImageFromOutput(body.data) || imageValue(body) || findImageInEvent(body);
    if (!image) throw missingImageError(diagnostics);
    return image;
  }
  if (!response.body) throw new Error("Codex returned an empty stream");
  const decoder = new TextDecoder();
  let buffer = "";
  let image = null;
  const diagnostics = createDiagnostics();

  const processFrame = (frame) => {
    image = parseSseFrame(frame, diagnostics, trace).image || image;
  };

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      processFrame(frame);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) processFrame(buffer);
  if (!image) throw missingImageError(diagnostics);
  return image;
}

function conversationInput(conversation = []) {
  return conversation.flatMap((turn) => {
    const role = turn?.role === "assistant" ? "assistant" : "user";
    const content = [];
    if (typeof turn?.text === "string" && turn.text.trim()) {
      content.push({
        type: role === "assistant" ? "output_text" : "input_text",
        text: turn.text.trim(),
      });
    }
    if (role === "user" && typeof turn?.sourceDataUrl === "string") {
      content.push({ type: "input_image", image_url: turn.sourceDataUrl });
    }
    return content.length ? [{ type: "message", role, content }] : [];
  });
}

function imageInput(prompt, sourceDataUrl, conversation = []) {
  const content = [{ type: "input_text", text: prompt }];
  if (sourceDataUrl) content.push({ type: "input_image", image_url: sourceDataUrl });
  return [
    ...conversationInput(conversation),
    { type: "message", role: "user", content },
  ];
}

function requestPayload(prompt, sourceDataUrl, conversation, model, sessionId = randomUUID()) {
  return {
    model,
    instructions: "Create a single Telegram sticker image. Follow the user's requested subject, style, and background. If the user requests transparency, use genuine alpha pixels rather than drawing a gray-and-white checkerboard or transparency preview. Do not add a border or text unless the user explicitly asks for it. Return only the generated image.",
    input: imageInput(prompt, sourceDataUrl, conversation),
    // gpt-image-2-codex currently rejects background/input_fidelity controls,
    // so transparency can only be requested semantically.
    tools: [{ type: "image_generation" }],
    tool_choice: "required",
    parallel_tool_calls: false,
    store: false,
    stream: true,
    client_metadata: { session_id: sessionId },
  };
}

export async function generateStickerImage({
  oauth,
  prompt,
  sourceDataUrl,
  conversation = [],
  fetchImpl = fetch,
  logger = console,
}) {
  const url = process.env.CODEX_RESPONSES_URL || DEFAULT_URL;
  const model = process.env.CODEX_MODEL || "gpt-5.6-sol";
  const requestId = randomUUID();
  const payload = requestPayload(prompt, sourceDataUrl, conversation, model, requestId);
  const trace = createRequestTrace({ requestId, url, payload, accountId: oauth.accountId });
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${oauth.accessToken}`,
        "ChatGPT-Account-Id": oauth.accountId,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        originator: "telegram-sticker-bot",
        "session-id": requestId,
        "User-Agent": "telegram-sticker-bot/0.1",
      },
      body: JSON.stringify(payload),
    });
    trace.response.status = response.status;
    trace.response.headers = safeResponseHeaders(response.headers);
    if (!response.ok) {
      const detail = await response.text();
      try {
        trace.response.body = sanitizeForLog(JSON.parse(detail));
      } catch {
        trace.response.body = sanitizeForLog(detail);
      }
      throw new Error(`Codex rejected the generation request (${response.status})${detail ? `: ${detail.slice(0, 500)}` : ""}`);
    }
    return await parseResponse(response, trace);
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.codexRequestId = requestId;
    trace.failure = { name: failure.name, message: failure.message };
    try {
      logger.error("codex_request_failed_trace", JSON.stringify(trace));
    } catch {}
    throw failure;
  }
}
