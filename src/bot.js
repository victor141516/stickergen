import { randomUUID } from "node:crypto";
import { InputFile, InlineKeyboard } from "grammy";
import { generateStickerImage } from "./codex.js";
import { buildConversationContext } from "./conversations.js";
import { stickerDataUrl, toStickerWebp, transparencyStats } from "./stickers.js";
import { getStylePreset, listStylePresets, promptWithStylePreset } from "./styles.js";

const HELP = [
  "I am a Codex-powered sticker bot.",
  "",
  "/login — link your OpenAI/Codex account",
  "/sticker <description> — create a sticker",
  "/edit <change> — reply to a sticker or photo to edit it",
  "/app — open the studio, or reply to an image to edit it",
  "/style — choose an optional style for your next sticker",
  "/whoami — show the linked account",
  "/logout — remove your session from this bot",
  "",
  "You can also send a photo, with or without instructions in its caption.",
  "In the bot's private chat, any plain text message can be a new sticker prompt.",
  "In a group, reply to a photo or sticker with /edit and your request.",
  "You can also reply to an image with @bot_username <instructions>.",
].join("\n");

const DEFAULT_SOURCE_IMAGE_PROMPT =
  "Turn the main subject of this source image into a faithful and recognizable Telegram sticker. Remove the background, preserve important features, and use a clean, expressive outline.";

const DEFAULT_STICKER_RESTYLE_PROMPT =
  "Recreate this existing sticker as a polished new variation. Preserve its subject, pose, expression, composition, and identifying details while rendering it in the requested style.";

const INLINE_JOB_TTL_MS = 60 * 60 * 1000;
const DEFAULT_GENERATION_ETA_MS = 80_000;
const PROGRESS_INTERVAL_MS = 8_000;
const PROGRESS_BLOCKS = 10;

function startKeyboard(miniAppUrl = null) {
  const rows = [];
  if (miniAppUrl) {
    rows.push([{ text: "✦ Open StickerGen", web_app: { url: miniAppUrl } }]);
  }
  rows.push([
    { text: "🎨 Choose style", callback_data: "style:open" },
    { text: "ℹ️ Help", callback_data: "help:open" },
  ]);
  return {
    inline_keyboard: rows,
  };
}

function miniAppDraftUrl(miniAppUrl, draftId) {
  const url = new URL(miniAppUrl);
  url.searchParams.set("draft", draftId);
  return url.toString();
}

function miniAppSourceFromMessage(message) {
  if (message?.sticker && !message.sticker.is_animated && !message.sticker.is_video) {
    return {
      fileId: message.sticker.file_id,
      mimeType: "image/webp",
      name: "Telegram sticker",
    };
  }
  const photos = message?.photo;
  if (Array.isArray(photos) && photos.length) {
    return {
      fileId: photos.at(-1).file_id,
      mimeType: "image/jpeg",
      name: "Telegram photo",
    };
  }
  if (message?.document?.mime_type?.startsWith("image/")) {
    return {
      fileId: message.document.file_id,
      mimeType: message.document.mime_type,
      name: message.document.file_name || "Telegram image",
    };
  }
  return null;
}

function styleKeyboard(selectedId = null) {
  const buttons = listStylePresets().map((preset) => ({
    text: `${preset.id === selectedId ? "✓ " : ""}${preset.buttonText}`,
    callback_data: `style:set:${preset.id}`,
  }));
  const rows = [];
  for (let index = 0; index < buttons.length; index += 2) {
    rows.push(buttons.slice(index, index + 2));
  }
  rows.push([{
    text: `${selectedId ? "" : "✓ "}✨ No preset`,
    callback_data: "style:set:none",
  }]);
  rows.push([{ text: "Close", callback_data: "style:close" }]);
  return { inline_keyboard: rows };
}

function styleSelectorText(selectedPreset) {
  const current = selectedPreset?.name || "No preset";
  const description = selectedPreset?.description
    || "Your prompt alone decides the visual style.";
  return [
    "🎨 Style for your next sticker",
    "",
    `Current: ${current}`,
    description,
    "",
    "A preset is optional, applies once, and resets after your next private-chat request. Any style you write in that prompt takes priority.",
  ].join("\n");
}

function selectedStyleKeyboard() {
  return {
    inline_keyboard: [[
      { text: "Change style", callback_data: "style:open" },
      { text: "Clear preset", callback_data: "style:set:none" },
    ]],
  };
}

function userId(ctx) {
  return ctx.from?.id ? String(ctx.from.id) : null;
}

function displayName(ctx) {
  return ctx.from?.first_name || ctx.from?.username || "there";
}

export function imageFileIdFromMessage(message, { includeSticker = true } = {}) {
  const photos = message?.photo;
  if (Array.isArray(photos) && photos.length > 0) return photos.at(-1).file_id;
  if (message?.document?.mime_type?.startsWith("image/")) return message.document.file_id;
  if (includeSticker && message?.sticker) return message.sticker.file_id;
  return null;
}

export function promptFromBotMention(text, botUsername) {
  if (!text || !botUsername) return null;
  const escapedUsername = botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mention = new RegExp(`@${escapedUsername}(?![A-Za-z0-9_])`, "i");
  if (!mention.test(text)) return null;
  return text
    .replace(mention, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[,;:!?\-–—]+\s*/, "")
    .trim();
}

export function inlinePlaceholderResult(jobId, prompt, estimatedMs = DEFAULT_GENERATION_ETA_MS) {
  return {
    type: "article",
    id: jobId,
    title: "Generate sticker",
    description: prompt.slice(0, 100),
    input_message_content: {
      message_text: `${generationProgressText(0, estimatedMs)}\n\n${prompt}`,
    },
    reply_markup: {
      inline_keyboard: [[{
        text: "✨ Starting…",
        callback_data: `inline:${jobId}`,
      }]],
    },
  };
}

export function inlineCachedStickerResult(jobId, stickerFileId) {
  return {
    type: "sticker",
    id: `ready-${jobId}`,
    sticker_file_id: stickerFileId,
  };
}

export function startStickerChatAction(api, chatId, { messageThreadId, intervalMs = 4000 } = {}) {
  let stopped = false;
  let warningLogged = false;
  const options = messageThreadId ? { message_thread_id: messageThreadId } : {};
  const refresh = async () => {
    if (stopped) return;
    try {
      await api.sendChatAction(chatId, "choose_sticker", options);
    } catch (error) {
      if (!warningLogged) {
        console.warn("could not set choose_sticker chat action", error?.message || error);
        warningLogged = true;
      }
    }
  };
  void refresh();
  const timer = setInterval(refresh, intervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export function replyOptions(messageId) {
  if (!messageId) return {};
  return {
    reply_parameters: {
      message_id: messageId,
      allow_sending_without_reply: true,
    },
  };
}

function formatEta(milliseconds) {
  const roundedSeconds = Math.max(5, Math.ceil(milliseconds / 5_000) * 5);
  if (roundedSeconds < 60) return `${roundedSeconds}s`;
  const minutes = Math.floor(roundedSeconds / 60);
  const seconds = roundedSeconds % 60;
  return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

export function generationProgressText(elapsedMs, estimatedMs = DEFAULT_GENERATION_ETA_MS, {
  complete = false,
  styleName = null,
} = {}) {
  const safeEstimate = Math.max(1, Number(estimatedMs) || DEFAULT_GENERATION_ETA_MS);
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  const filled = complete
    ? PROGRESS_BLOCKS
    : Math.min(PROGRESS_BLOCKS - 1, Math.floor((elapsed / safeEstimate) * PROGRESS_BLOCKS));
  const bar = `${"🟩".repeat(filled)}${"⬜".repeat(PROGRESS_BLOCKS - filled)}`;
  const styleLine = styleName ? `\nStyle: ${styleName} · prompt overrides` : "";
  if (complete) return `🎨 Sticker ready — sending…\n\n${bar}\n100%${styleLine}`;
  const eta = elapsed < safeEstimate ? `~${formatEta(safeEstimate - elapsed)}` : "finishing…";
  return `🎨 Generating your sticker…\n\n${bar}\n${filled * 10}% · ETA ${eta}${styleLine}`;
}

export function startGenerationProgress({
  update,
  estimatedMs = DEFAULT_GENERATION_ETA_MS,
  intervalMs = PROGRESS_INTERVAL_MS,
  now = Date.now,
  logger = console,
  styleName = null,
}) {
  const startedAt = now();
  let stopped = false;
  let inFlight = Promise.resolve();
  let lastText = generationProgressText(0, estimatedMs, { styleName });
  let warningLogged = false;

  const edit = (text) => {
    if (text === lastText) return inFlight;
    lastText = text;
    inFlight = inFlight.then(async () => {
      try {
        await update(text);
      } catch (error) {
        if (!warningLogged) {
          logger.warn("could not update sticker generation progress", error?.message || error);
          warningLogged = true;
        }
      }
    });
    return inFlight;
  };

  const timer = setInterval(() => {
    if (!stopped) void edit(generationProgressText(now() - startedAt, estimatedMs, { styleName }));
  }, intervalMs);
  timer.unref?.();

  return {
    async complete() {
      if (stopped) return inFlight;
      stopped = true;
      clearInterval(timer);
      return edit(generationProgressText(now() - startedAt, estimatedMs, { complete: true, styleName }));
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      return inFlight;
    },
  };
}

function sourceImageFileId(ctx, { includeCurrent = false } = {}) {
  if (includeCurrent) {
    const current = imageFileIdFromMessage(ctx.message, { includeSticker: false });
    if (current) return current;
  }
  return imageFileIdFromMessage(ctx.message?.reply_to_message);
}

export function registerBotHandlers({
  bot,
  authService,
  userStore,
  downloadTelegramFile,
  generateImage = generateStickerImage,
  convertToSticker = toStickerWebp,
  getTransparencyStats = transparencyStats,
  sourceToDataUrl = stickerDataUrl,
  logger = console,
  estimatedGenerationMs = DEFAULT_GENERATION_ETA_MS,
  miniAppUrl = null,
  miniAppDraftStore = null,
  conversationStore = null,
}) {
  const pendingLogins = new Map();
  const inlineJobs = new Map();
  const credentialLoads = new Map();

  async function rememberOutgoing({
    chatId,
    message,
    replyToMessageId,
    text = "",
    media = null,
    requestText = "",
  }) {
    if (!conversationStore) return;
    try {
      await conversationStore.rememberOutgoing({
        chatId,
        message,
        replyToMessageId,
        text,
        media,
        requestText,
      });
    } catch (error) {
      logger.error("conversation_message_store_failed", error?.message || error);
    }
  }

  async function reply(ctx, text, options = {}, replyToMessageId = null) {
    const targetMessageId = replyToMessageId
      || options.reply_parameters?.message_id
      || ctx.message?.message_id;
    const sentMessage = await ctx.reply(text, {
      ...replyOptions(targetMessageId),
      ...options,
    });
    await rememberOutgoing({
      chatId: ctx.chat?.id,
      message: sentMessage,
      replyToMessageId: targetMessageId,
      text,
    });
    return sentMessage;
  }

  async function sendMessage(chatId, text, options = {}) {
    const sentMessage = await bot.api.sendMessage(chatId, text, options);
    await rememberOutgoing({
      chatId,
      message: sentMessage,
      replyToMessageId: options.reply_parameters?.message_id,
      text,
    });
    return sentMessage;
  }

  async function sendSticker(
    chatId,
    sticker,
    options = {},
    requestText = "",
    text = "I generated and sent the requested sticker.",
  ) {
    const sentMessage = await bot.api.sendSticker(chatId, sticker, options);
    await rememberOutgoing({
      chatId,
      message: sentMessage,
      replyToMessageId: options.reply_parameters?.message_id,
      text,
      requestText,
      media: sentMessage?.sticker?.file_id
        ? { fileId: sentMessage.sticker.file_id, kind: "sticker", mimeType: "image/webp" }
        : null,
    });
    return sentMessage;
  }

  if (bot.use && conversationStore) {
    bot.use(async (ctx, next) => {
      if (ctx.message) {
        try {
          await conversationStore.rememberIncoming(ctx.message, ctx.chat?.id);
        } catch (error) {
          logger.error("conversation_message_store_failed", error?.message || error);
        }
      }
      await next();
    });
  }

  const sendLoginRequired = (ctx) => reply(ctx, "Link your account with /login first. Each Telegram user has their own OpenAI session.");

  async function offerMiniAppDraft(ctx, sourceMessage, source) {
    const id = userId(ctx);
    const record = userStore.get(id);
    if (!record?.sessionToken) {
      await sendLoginRequired(ctx);
      return;
    }
    const draft = miniAppDraftStore.create({
      userId: id,
      fileId: source.fileId,
      chatId: ctx.chat.id,
      messageId: sourceMessage.message_id,
      name: source.name,
      mimeType: source.mimeType,
    });
    await reply(ctx, "This image is ready in StickerGen. Choose a style, add optional instructions, and generate your edited sticker.", {
      ...replyOptions(sourceMessage.message_id),
      reply_markup: {
        inline_keyboard: [[{
          text: "✦ Edit in StickerGen",
          web_app: { url: miniAppDraftUrl(miniAppUrl, draft.id) },
        }]],
      },
    }, sourceMessage.message_id);
  }

  function pruneInlineJobs() {
    const now = Date.now();
    for (const [jobId, job] of inlineJobs) {
      if (job.expiresAt <= now) inlineJobs.delete(jobId);
    }
    while (inlineJobs.size > 500) inlineJobs.delete(inlineJobs.keys().next().value);
  }

  async function loadCredentials(id) {
    const existing = credentialLoads.get(id);
    if (existing) return existing;
    const load = (async () => {
      const record = id && userStore.get(id);
      if (!record?.sessionToken) return null;
      try {
        const credentials = await authService.credentials(record.sessionToken);
        if (credentials.refreshedToken) {
          await userStore.setSession(id, credentials.refreshedToken, authService.publicIdentity(credentials.oauth));
        }
        return credentials.oauth;
      } catch (error) {
        await userStore.clear(id);
        throw error;
      }
    })();
    credentialLoads.set(id, load);
    try {
      return await load;
    } finally {
      if (credentialLoads.get(id) === load) credentialLoads.delete(id);
    }
  }

  async function processStickerJob({
    id,
    chatId,
    statusMessageId,
    replyToMessageId,
    prompt,
    sourceFileId,
    conversation,
    stopChatAction,
    progress,
  }) {
    const generationId = randomUUID();
    try {
      const oauth = await loadCredentials(id);
      if (!oauth) {
        await sendMessage(
          chatId,
          "Link your account with /login first. Each Telegram user has their own OpenAI session.",
          replyOptions(replyToMessageId),
        );
        return;
      }

      let sourceDataUrl = null;
      if (sourceFileId) {
        const source = await downloadTelegramFile(sourceFileId);
        sourceDataUrl = await sourceToDataUrl(source);
      }

      logger.info("sticker_generation_started", JSON.stringify({
        generationId,
        sourceImage: Boolean(sourceFileId),
        prompt: prompt.slice(0, 1000),
      }));
      const rawImage = await generateImage({ oauth, prompt, sourceDataUrl, conversation });
      const generatedTransparency = await getTransparencyStats(rawImage);
      logger.info("sticker_generation_output", JSON.stringify({
        generationId,
        ...generatedTransparency,
      }));
      const webp = await convertToSticker(rawImage);
      const webpTransparency = await getTransparencyStats(webp);
      await progress?.complete();
      await sendSticker(chatId, new InputFile(webp, "sticker.webp"), {
        ...replyOptions(replyToMessageId),
      }, prompt);
      logger.info("sticker_generation_sent", JSON.stringify({
        generationId,
        stickerBytes: webp.length,
        ...webpTransparency,
      }));
    } catch (error) {
      const message = error?.message || "unknown error";
      logger.error("sticker_generation_failed", JSON.stringify({
        generationId,
        codexRequestId: error?.codexRequestId || null,
        error: message,
      }));
      try {
        await sendMessage(
          chatId,
          `I could not generate the sticker: ${message}`,
          replyOptions(replyToMessageId),
        );
      } catch (sendError) {
        logger.error("sticker_generation_error_message_failed", sendError?.message || sendError);
      }
    } finally {
      stopChatAction?.();
      await progress?.stop();
      try { await bot.api.deleteMessage(chatId, statusMessageId); } catch {}
    }
  }

  async function processInlineStickerJob({ jobId, inlineMessageId, progress }) {
    const job = inlineJobs.get(jobId);
    if (!job) return;
    const generationId = randomUUID();
    try {
      const oauth = await loadCredentials(job.userId);
      if (!oauth) throw new Error("Link your account with /login in the bot's private chat first.");

      logger.info("inline_sticker_generation_started", JSON.stringify({
        generationId,
        jobId,
        prompt: job.prompt.slice(0, 1000),
      }));
      const rawImage = await generateImage({ oauth, prompt: job.prompt });
      const generatedTransparency = await getTransparencyStats(rawImage);
      logger.info("inline_sticker_generation_output", JSON.stringify({
        generationId,
        jobId,
        ...generatedTransparency,
      }));
      const webp = await convertToSticker(rawImage);

      // Inline messages cannot upload new files while being edited. Upload the
      // sticker silently to the user's private chat to obtain a reusable file_id.
      const cachedMessage = await bot.api.sendSticker(
        job.userId,
        new InputFile(webp, "inline-sticker.webp"),
        { disable_notification: true },
      );
      const stickerFileId = cachedMessage.sticker?.file_id;
      if (!stickerFileId) throw new Error("Telegram did not return an identifier for the inline sticker");
      try { await bot.api.deleteMessage(job.userId, cachedMessage.message_id); } catch {}

      job.status = "ready";
      job.stickerFileId = stickerFileId;
      job.expiresAt = Date.now() + INLINE_JOB_TTL_MS;
      const readyQuery = `ready:${jobId}`;
      const replyMarkup = {
        inline_keyboard: [[{
          text: "Send sticker",
          switch_inline_query_current_chat: readyQuery,
        }]],
      };

      await progress?.complete();
      await bot.api.editMessageTextInline(
        inlineMessageId,
        "✅ Sticker ready. Tap below, then choose the sticker to insert it here.",
        { reply_markup: replyMarkup },
      );
      logger.info("inline_sticker_generation_ready", JSON.stringify({
        generationId,
        jobId,
        stickerBytes: webp.length,
      }));
    } catch (error) {
      const message = error?.message || "unknown error";
      job.status = "failed";
      logger.error("inline_sticker_generation_failed", JSON.stringify({
        generationId,
        jobId,
        codexRequestId: error?.codexRequestId || null,
        error: message,
      }));
      await progress?.stop();
      try {
        await bot.api.editMessageTextInline(
          inlineMessageId,
          `I could not generate the sticker: ${message}`,
          { reply_markup: { inline_keyboard: [] } },
        );
      } catch {}
    } finally {
      await progress?.stop();
    }
  }

  async function startInlineStickerJob({ jobId, inlineMessageId, requesterId }) {
    pruneInlineJobs();
    const job = inlineJobs.get(jobId);
    if (!job || !inlineMessageId) return "expired";
    if (job.userId !== requesterId) return "forbidden";
    if (job.status === "running") return "running";
    if (job.status === "ready") return "ready";
    if (job.status !== "pending") return "expired";

    job.status = "running";
    job.inlineMessageId = inlineMessageId;
    try {
      await bot.api.editMessageTextInline(
        inlineMessageId,
        generationProgressText(0, estimatedGenerationMs),
        { reply_markup: { inline_keyboard: [] } },
      );
    } catch (error) {
      job.status = "pending";
      delete job.inlineMessageId;
      throw error;
    }
    const progress = startGenerationProgress({
      estimatedMs: estimatedGenerationMs,
      logger,
      update: (text) => bot.api.editMessageTextInline(inlineMessageId, text),
    });
    void processInlineStickerJob({ jobId, inlineMessageId, progress })
      .catch((error) => logger.error("detached_inline_sticker_generation_failed", error));
    return "started";
  }

  async function createSticker(ctx, prompt, sourceFileId = null) {
    const id = userId(ctx);
    if (!id) return;
    if (!prompt?.trim()) {
      await reply(ctx, "Write a description. Example: /sticker an astronaut fox with a transparent helmet");
      return;
    }
    const record = userStore.get(id);
    if (!record?.sessionToken) {
      await sendLoginRequired(ctx);
      return;
    }

    const usePreset = ctx.chat.type === "private";
    const selectedPreset = usePreset ? getStylePreset(record.stylePresetId) : null;
    if (selectedPreset) await userStore.clearStylePreset(id);
    const effectivePrompt = promptWithStylePreset(prompt.trim(), selectedPreset);
    const styleName = selectedPreset?.name || "No preset";

    const replyToMessageId = ctx.message?.message_id;
    const conversation = await buildConversationContext({
      store: conversationStore,
      chatId: ctx.chat.id,
      messageId: replyToMessageId,
      includeTarget: false,
      downloadTelegramFile,
      sourceToDataUrl,
      logger,
      excludeFileId: sourceFileId,
    });
    const status = await reply(
      ctx,
      generationProgressText(0, estimatedGenerationMs, { styleName }),
      replyOptions(replyToMessageId),
    );
    const stopChatAction = startStickerChatAction(ctx.api, ctx.chat.id, {
      messageThreadId: ctx.message?.message_thread_id,
    });
    const progress = startGenerationProgress({
      estimatedMs: estimatedGenerationMs,
      logger,
      styleName,
      update: (text) => ctx.api.editMessageText(ctx.chat.id, status.message_id, text),
    });
    void processStickerJob({
      id,
      chatId: ctx.chat.id,
      statusMessageId: status.message_id,
      replyToMessageId,
      prompt: effectivePrompt,
      sourceFileId,
      conversation,
      stopChatAction,
      progress,
    }).catch((error) => logger.error("detached_sticker_generation_failed", error));
  }

  async function pollLogin(id, chatId, messageId, loginId) {
    const state = pendingLogins.get(id);
    if (!state || state.loginId !== loginId) return;
    try {
      const result = await authService.pollDeviceLogin(loginId);
      if (result.status === "complete") {
        await userStore.setSession(id, result.token, result.user);
        pendingLogins.delete(id);
        await bot.api.editMessageText(chatId, messageId, `Session linked successfully${result.user.email ? ` as ${result.user.email}` : ""}. You can now use /sticker.`);
        return;
      }
      if (result.status === "expired") {
        pendingLogins.delete(id);
        await bot.api.editMessageText(chatId, messageId, "The login code has expired. Use /login to start again.");
        return;
      }
      state.timer = setTimeout(() => pollLogin(id, chatId, messageId, loginId), Math.max(1, result.retryAfter || state.interval) * 1000);
    } catch (error) {
      pendingLogins.delete(id);
      await bot.api.editMessageText(chatId, messageId, `I could not complete the login: ${error.message}`);
    }
  }

  bot.command("start", (ctx) => {
    const inlineHint = ctx.match === "inline-login"
      ? "\n\nTo use inline mode, link your account with /login first."
      : "";
    const selectedPreset = getStylePreset(userStore.get(userId(ctx))?.stylePresetId);
    return reply(ctx, [
      "🎨 StickerGen",
      "",
      `Hi, ${displayName(ctx)}. Describe any sticker or send a photo. You can include both the subject and its style in your prompt.`,
      "",
      `Style: ${selectedPreset?.name || "No preset"} · your prompt decides`,
      inlineHint,
    ].join("\n"), {
      reply_markup: startKeyboard(ctx.chat.type === "private" ? miniAppUrl : null),
    });
  });
  bot.command("help", (ctx) => reply(ctx, HELP));
  bot.command("login", async (ctx) => {
    const id = userId(ctx);
    if (!id) return;
    const existing = pendingLogins.get(id);
    if (existing) {
      await reply(ctx, "A login is already pending. Open the previous link or wait for it to expire.");
      return;
    }
    try {
      const details = await authService.startDeviceLogin();
      const text = [
        "To link your OpenAI account:",
        `1. Open ${details.verificationUrl}`,
        `2. Enter this code: ${details.userCode}`,
        "",
        "The code expires in 15 minutes. Do not share it with anyone.",
        "Waiting for authorization…",
      ].join("\n");
      const message = await reply(ctx, text, {
        reply_markup: new InlineKeyboard().url("Open Codex login", details.verificationUrl),
      });
      pendingLogins.set(id, { loginId: details.loginId, interval: details.interval, timer: null });
      await pollLogin(id, ctx.chat.id, message.message_id, details.loginId);
    } catch (error) {
      await reply(ctx, `I could not start the OpenAI login: ${error.message}`);
    }
  });

  bot.command("logout", async (ctx) => {
    const id = userId(ctx);
    if (id) await userStore.clear(id);
    await reply(ctx, "I removed the OpenAI session associated with your Telegram account.");
  });

  bot.command("whoami", async (ctx) => {
    const id = userId(ctx);
    const record = id && userStore.get(id);
    if (!record?.identity) return sendLoginRequired(ctx);
    await reply(ctx, `Linked account: ${record.identity.email || "email unavailable"}${record.identity.plan ? ` (${record.identity.plan})` : ""}`);
  });

  bot.command("app", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await reply(ctx, "Open my private chat to use the StickerGen Mini App.");
      return;
    }
    if (!miniAppUrl) {
      await reply(ctx, "The StickerGen Mini App is not configured yet.");
      return;
    }
    const repliedMessage = ctx.message?.reply_to_message;
    if (repliedMessage?.sticker?.is_animated || repliedMessage?.sticker?.is_video) {
      await reply(ctx, "I can currently open static stickers in the Mini App. Use a still image for animated or video stickers.");
      return;
    }
    const source = miniAppSourceFromMessage(repliedMessage);
    if (source && miniAppDraftStore) {
      await offerMiniAppDraft(ctx, repliedMessage, source);
      return;
    }
    await reply(ctx, "Open the sticker studio to create from a prompt, upload an image, or choose a style.", {
      reply_markup: {
        inline_keyboard: [[{ text: "✦ Open StickerGen", web_app: { url: miniAppUrl } }]],
      },
    });
  });

  bot.command("style", async (ctx) => {
    if (ctx.chat.type !== "private") {
      await reply(ctx, "Style presets can be selected in my private chat. Group and inline requests use the style written in their prompt.");
      return;
    }
    const id = userId(ctx);
    const selectedPreset = getStylePreset(userStore.get(id)?.stylePresetId);
    await reply(ctx, styleSelectorText(selectedPreset), {
      reply_markup: styleKeyboard(selectedPreset?.id),
    });
  });

  bot.callbackQuery("help:open", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(HELP, {
      reply_markup: startKeyboard(ctx.chat?.type === "private" ? miniAppUrl : null),
    });
  });

  bot.callbackQuery("style:open", async (ctx) => {
    if (ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery({ text: "Open my private chat to choose a style.", show_alert: true });
      return;
    }
    const id = userId(ctx);
    const selectedPreset = getStylePreset(userStore.get(id)?.stylePresetId);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(styleSelectorText(selectedPreset), {
      reply_markup: styleKeyboard(selectedPreset?.id),
    });
  });

  bot.callbackQuery(/^style:set:([a-z0-9-]+)$/, async (ctx) => {
    if (ctx.chat?.type !== "private") {
      await ctx.answerCallbackQuery({ text: "Open my private chat to choose a style.", show_alert: true });
      return;
    }
    const id = userId(ctx);
    const presetId = ctx.match[1];
    const selectedPreset = presetId === "none" ? null : getStylePreset(presetId);
    if (presetId !== "none" && !selectedPreset) {
      await ctx.answerCallbackQuery({ text: "That style is no longer available.", show_alert: true });
      return;
    }
    if (presetId === "none" && !userStore.get(id)?.stylePresetId) {
      await ctx.answerCallbackQuery({ text: "No preset is already active." });
      return;
    }
    if (selectedPreset) await userStore.setStylePreset(id, selectedPreset.id);
    else await userStore.clearStylePreset(id);
    await ctx.answerCallbackQuery({ text: selectedPreset ? `${selectedPreset.name} selected` : "Preset cleared" });
    const text = selectedPreset
      ? [
          "✅ Style ready",
          "",
          `Preset: ${selectedPreset.name}`,
          selectedPreset.description,
          "",
          "It applies to your next private-chat sticker only. Now send a prompt, photo, existing sticker, or edit. Your prompt's own style always takes priority.",
        ].join("\n")
      : styleSelectorText(null);
    await ctx.editMessageText(text, {
      reply_markup: selectedPreset ? selectedStyleKeyboard() : styleKeyboard(),
    });
  });

  bot.callbackQuery("style:close", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText("Style selector closed. Send a prompt or photo whenever you are ready.", {
      reply_markup: startKeyboard(miniAppUrl),
    });
  });

  bot.on("inline_query", async (ctx) => {
    pruneInlineJobs();
    const id = userId(ctx);
    const query = ctx.inlineQuery.query.trim();
    const record = id && userStore.get(id);
    if (!record?.sessionToken) {
      await ctx.answerInlineQuery([], {
        cache_time: 0,
        is_personal: true,
        button: { text: "Link OpenAI account", start_parameter: "inline-login" },
      });
      return;
    }
    if (query.startsWith("ready:")) {
      const jobId = query.slice("ready:".length);
      const job = inlineJobs.get(jobId);
      const results = job?.userId === id && job.status === "ready" && job.stickerFileId
        ? [inlineCachedStickerResult(jobId, job.stickerFileId)]
        : [];
      await ctx.answerInlineQuery(results, { cache_time: 0, is_personal: true });
      return;
    }
    if (!query) {
      await ctx.answerInlineQuery([], { cache_time: 0, is_personal: true });
      return;
    }

    const jobId = randomUUID();
    inlineJobs.set(jobId, {
      userId: id,
      prompt: query,
      status: "pending",
      expiresAt: Date.now() + INLINE_JOB_TTL_MS,
    });
    await ctx.answerInlineQuery([inlinePlaceholderResult(jobId, query, estimatedGenerationMs)], {
      cache_time: 0,
      is_personal: true,
    });
  });

  bot.on("chosen_inline_result", async (ctx) => {
    const chosen = ctx.chosenInlineResult;
    const id = userId(ctx);
    if (!chosen || !id) return;

    if (chosen.result_id.startsWith("ready-")) {
      const jobId = chosen.result_id.slice("ready-".length);
      const job = inlineJobs.get(jobId);
      if (job?.userId !== id || job.status !== "ready" || !job.inlineMessageId) return;
      job.status = "sent";
      job.expiresAt = Date.now() + INLINE_JOB_TTL_MS;
      try {
        await bot.api.editMessageTextInline(
          job.inlineMessageId,
          "✅ Sticker sent.",
          { reply_markup: { inline_keyboard: [] } },
        );
      } catch (error) {
        logger.warn("inline_sticker_sent_status_update_failed", error?.message || error);
      }
      return;
    }

    if (!/^[0-9a-f-]{36}$/.test(chosen.result_id) || !chosen.inline_message_id) return;
    try {
      await startInlineStickerJob({
        jobId: chosen.result_id,
        inlineMessageId: chosen.inline_message_id,
        requesterId: id,
      });
    } catch (error) {
      logger.error("chosen_inline_sticker_start_failed", error?.message || error);
    }
  });

  bot.callbackQuery(/^inline:([0-9a-f-]{36})$/, async (ctx) => {
    const jobId = ctx.match[1];
    const id = userId(ctx);
    const inlineMessageId = ctx.callbackQuery.inline_message_id;
    let status;
    try {
      status = await startInlineStickerJob({
        jobId,
        inlineMessageId,
        requesterId: id,
      });
    } catch (error) {
      logger.error("inline_sticker_fallback_start_failed", error?.message || error);
      await ctx.answerCallbackQuery({ text: "I could not start this sticker. Try the inline request again.", show_alert: true });
      return;
    }
    if (status === "expired") {
      await ctx.answerCallbackQuery({ text: "This request has expired. Open inline mode again." });
      return;
    }
    if (status === "forbidden") {
      await ctx.answerCallbackQuery({ text: "Only the person who created this placeholder can generate the sticker.", show_alert: true });
      return;
    }
    if (status === "running") {
      await ctx.answerCallbackQuery({ text: "This sticker is already being generated." });
      return;
    }
    if (status === "ready") {
      await ctx.answerCallbackQuery({ text: "The sticker is already ready." });
      return;
    }
    await ctx.answerCallbackQuery({ text: "Generating sticker…" });
  });

  bot.command("sticker", async (ctx) => {
    const sourceFileId = sourceImageFileId(ctx, { includeCurrent: true });
    const prompt = ctx.match?.trim() || (sourceFileId ? DEFAULT_SOURCE_IMAGE_PROMPT : "");
    await createSticker(ctx, prompt, sourceFileId);
  });

  bot.command("edit", async (ctx) => {
    const sourceFileId = sourceImageFileId(ctx);
    if (!sourceFileId) {
      await reply(ctx, "Reply to a sticker or photo with /edit and describe the change you want.");
      return;
    }
    await createSticker(ctx, ctx.match, sourceFileId);
  });

  bot.on("message:text", async (ctx) => {
    const sourceFileId = sourceImageFileId(ctx);
    const text = ctx.message.text.trim();
    if (text.startsWith("/")) return;
    const isPrivate = ctx.chat.type === "private";
    const mentionedPrompt = promptFromBotMention(text, ctx.me.username);
    if (!isPrivate && mentionedPrompt === null) return;
    const prompt = mentionedPrompt ?? text;
    await createSticker(ctx, prompt || (sourceFileId ? DEFAULT_SOURCE_IMAGE_PROMPT : ""), sourceFileId);
  });

  bot.on(["message:photo", "message:document"], async (ctx) => {
    const sourceFileId = imageFileIdFromMessage(ctx.message, { includeSticker: false });
    if (!sourceFileId) return;
    const caption = ctx.message.caption?.trim() || "";
    if (caption.startsWith("/")) return;
    const isPrivate = ctx.chat.type === "private";
    const mentionedPrompt = promptFromBotMention(caption, ctx.me.username);
    if (!isPrivate && mentionedPrompt === null) return;
    await createSticker(ctx, mentionedPrompt || caption || DEFAULT_SOURCE_IMAGE_PROMPT, sourceFileId);
  });

  bot.on("message:sticker", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    if (ctx.message.sticker.is_animated || ctx.message.sticker.is_video) {
      await reply(ctx, "I can currently restyle static stickers only. Send a static sticker, or use a still image from this one.");
      return;
    }
    const id = userId(ctx);
    const record = userStore.get(id);
    if (miniAppUrl && miniAppDraftStore && !record?.stylePresetId) {
      await offerMiniAppDraft(ctx, ctx.message, miniAppSourceFromMessage(ctx.message));
      return;
    }
    await createSticker(ctx, DEFAULT_STICKER_RESTYLE_PROMPT, ctx.message.sticker.file_id);
  });

  return { pendingLogins, inlineJobs, loadCredentials };
}
