import { randomUUID } from "node:crypto";
import { InputFile, InlineKeyboard } from "grammy";
import { generateStickerImage } from "./codex.js";
import { stickerDataUrl, toStickerWebp, transparencyStats } from "./stickers.js";
import { InProcessQueue } from "./queue.js";

const HELP = [
  "Soy un bot de stickers con Codex.",
  "",
  "/login — enlaza tu cuenta de OpenAI/Codex",
  "/sticker <descripción> — crea un sticker",
  "/edit <cambio> — responde a un sticker o foto para modificarlo",
  "/whoami — muestra la cuenta enlazada",
  "/logout — elimina tu sesión de este bot",
  "",
  "También puedes enviar una foto, con o sin instrucciones en el caption.",
  "En un grupo, responde a una foto o sticker con /edit y tu petición.",
  "También puedes responder a una imagen con @nombre_del_bot <instrucciones>.",
].join("\n");

const DEFAULT_PHOTO_PROMPT =
  "Convierte el sujeto principal de esta foto en un sticker de Telegram fiel y reconocible. Elimina el fondo, conserva los rasgos importantes y usa un contorno limpio y expresivo.";

const INLINE_JOB_TTL_MS = 60 * 60 * 1000;

function userId(ctx) {
  return ctx.from?.id ? String(ctx.from.id) : null;
}

function displayName(ctx) {
  return ctx.from?.first_name || ctx.from?.username || "usuario";
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
    .replace(/^[,;:!¡?¿\-–—]+\s*/, "")
    .trim();
}

export function inlinePlaceholderResult(jobId, prompt) {
  return {
    type: "article",
    id: jobId,
    title: "Generar sticker",
    description: prompt.slice(0, 100),
    input_message_content: {
      message_text: `🎨 ${prompt}\n\nPulsa «Generar sticker» para empezar.`,
    },
    reply_markup: {
      inline_keyboard: [[{
        text: "Generar sticker",
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
  cooldownMs = 5000,
  queue = new InProcessQueue({ concurrency: 2, maxPending: 100 }),
}) {
  const pendingLogins = new Map();
  const inlineJobs = new Map();
  const activeUsers = new Set();
  const lastGeneration = new Map();

  const sendLoginRequired = (ctx) => ctx.reply("Primero enlaza tu cuenta con /login. Cada usuario de Telegram tiene su propia sesión de OpenAI.");

  function pruneInlineJobs() {
    const now = Date.now();
    for (const [jobId, job] of inlineJobs) {
      if (job.expiresAt <= now) inlineJobs.delete(jobId);
    }
    while (inlineJobs.size > 500) inlineJobs.delete(inlineJobs.keys().next().value);
  }

  async function loadCredentials(id) {
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
  }

  async function processStickerJob({ id, chatId, statusMessageId, prompt, sourceFileId, stopChatAction }) {
    const generationId = randomUUID();
    try {
      const oauth = await loadCredentials(id);
      if (!oauth) {
        await bot.api.sendMessage(chatId, "Primero enlaza tu cuenta con /login. Cada usuario de Telegram tiene su propia sesión de OpenAI.");
        return;
      }

      let sourceDataUrl = null;
      if (sourceFileId) {
        const source = await downloadTelegramFile(sourceFileId);
        sourceDataUrl = await stickerDataUrl(source);
      }

      console.info("sticker_generation_started", JSON.stringify({
        generationId,
        sourceImage: Boolean(sourceFileId),
        prompt: prompt.slice(0, 1000),
      }));
      const rawImage = await generateStickerImage({ oauth, prompt, sourceDataUrl });
      const generatedTransparency = await transparencyStats(rawImage);
      console.info("sticker_generation_output", JSON.stringify({
        generationId,
        ...generatedTransparency,
      }));
      const webp = await toStickerWebp(rawImage);
      const webpTransparency = await transparencyStats(webp);
      await bot.api.sendSticker(chatId, new InputFile(webp, "sticker.webp"), {
        reply_parameters: { message_id: statusMessageId },
      });
      console.info("sticker_generation_sent", JSON.stringify({
        generationId,
        stickerBytes: webp.length,
        ...webpTransparency,
      }));
    } catch (error) {
      const message = error?.message || "error desconocido";
      console.error("sticker_generation_failed", JSON.stringify({ generationId, error: message }));
      await bot.api.sendMessage(chatId, `No pude generar el sticker: ${message}`);
    } finally {
      stopChatAction?.();
      activeUsers.delete(id);
      try { await bot.api.deleteMessage(chatId, statusMessageId); } catch {}
    }
  }

  async function processInlineStickerJob({ jobId, inlineMessageId }) {
    const job = inlineJobs.get(jobId);
    if (!job) return;
    const generationId = randomUUID();
    try {
      const oauth = await loadCredentials(job.userId);
      if (!oauth) throw new Error("Primero enlaza tu cuenta con /login en el chat privado del bot.");

      console.info("inline_sticker_generation_started", JSON.stringify({
        generationId,
        jobId,
        prompt: job.prompt.slice(0, 1000),
      }));
      const rawImage = await generateStickerImage({ oauth, prompt: job.prompt });
      const generatedTransparency = await transparencyStats(rawImage);
      console.info("inline_sticker_generation_output", JSON.stringify({
        generationId,
        jobId,
        ...generatedTransparency,
      }));
      const webp = await toStickerWebp(rawImage);

      // Inline messages cannot upload new files while being edited. Upload the
      // sticker silently to the user's private chat to obtain a reusable file_id.
      const cachedMessage = await bot.api.sendSticker(
        job.userId,
        new InputFile(webp, "inline-sticker.webp"),
        { disable_notification: true },
      );
      const stickerFileId = cachedMessage.sticker?.file_id;
      if (!stickerFileId) throw new Error("Telegram no devolvió un identificador para el sticker inline");
      try { await bot.api.deleteMessage(job.userId, cachedMessage.message_id); } catch {}

      job.status = "ready";
      job.stickerFileId = stickerFileId;
      job.expiresAt = Date.now() + INLINE_JOB_TTL_MS;
      const readyQuery = `ready:${jobId}`;
      const replyMarkup = {
        inline_keyboard: [[{
          text: "Enviar como sticker",
          switch_inline_query_current_chat: readyQuery,
        }]],
      };

      try {
        await bot.api.editMessageMediaInline(inlineMessageId, {
          type: "document",
          media: stickerFileId,
          caption: "Sticker generado. Pulsa abajo para enviarlo como sticker nativo.",
        }, { reply_markup: replyMarkup });
      } catch (mediaError) {
        console.warn("inline sticker could not replace placeholder as media", mediaError?.message || mediaError);
        await bot.api.editMessageTextInline(
          inlineMessageId,
          "✅ Sticker generado. Pulsa abajo para insertarlo como sticker nativo.",
          { reply_markup: replyMarkup },
        );
      }
      console.info("inline_sticker_generation_ready", JSON.stringify({
        generationId,
        jobId,
        stickerBytes: webp.length,
      }));
    } catch (error) {
      const message = error?.message || "error desconocido";
      job.status = "failed";
      console.error("inline_sticker_generation_failed", JSON.stringify({ generationId, jobId, error: message }));
      try {
        await bot.api.editMessageTextInline(inlineMessageId, `No pude generar el sticker: ${message}`);
      } catch {}
    } finally {
      activeUsers.delete(job.userId);
    }
  }

  async function createSticker(ctx, prompt, sourceFileId = null) {
    const id = userId(ctx);
    if (!id) return;
    if (!prompt?.trim()) {
      await ctx.reply("Escribe una descripción. Ejemplo: /sticker un zorro astronauta con casco transparente");
      return;
    }
    const now = Date.now();
    const previous = lastGeneration.get(id) || 0;
    if (now - previous < cooldownMs) {
      await ctx.reply(`Espera ${Math.ceil((cooldownMs - (now - previous)) / 1000)} s antes de pedir otro sticker.`);
      return;
    }
    if (activeUsers.has(id)) {
      await ctx.reply("Ya estoy generando un sticker para ti. Te lo envío en cuanto termine.");
      return;
    }

    const record = userStore.get(id);
    if (!record?.sessionToken) {
      await sendLoginRequired(ctx);
      return;
    }

    const status = await ctx.reply("Generando tu sticker…");
    const stopChatAction = startStickerChatAction(ctx.api, ctx.chat.id, {
      messageThreadId: ctx.message?.message_thread_id,
    });
    activeUsers.add(id);
    lastGeneration.set(id, now);
    if (!queue.enqueue(() => processStickerJob({
      id,
      chatId: ctx.chat.id,
      statusMessageId: status.message_id,
      prompt: prompt.trim(),
      sourceFileId,
      stopChatAction,
    }))) {
      stopChatAction();
      activeUsers.delete(id);
      try { await ctx.api.deleteMessage(ctx.chat.id, status.message_id); } catch {}
      await ctx.reply("Hay demasiadas generaciones en cola. Inténtalo de nuevo en unos minutos.");
    }
  }

  async function pollLogin(id, chatId, messageId, loginId) {
    const state = pendingLogins.get(id);
    if (!state || state.loginId !== loginId) return;
    try {
      const result = await authService.pollDeviceLogin(loginId);
      if (result.status === "complete") {
        await userStore.setSession(id, result.token, result.user);
        pendingLogins.delete(id);
        await bot.api.editMessageText(chatId, messageId, `Sesión enlazada correctamente${result.user.email ? ` como ${result.user.email}` : ""}. Ya puedes usar /sticker.`);
        return;
      }
      if (result.status === "expired") {
        pendingLogins.delete(id);
        await bot.api.editMessageText(chatId, messageId, "El código de inicio de sesión ha caducado. Usa /login para empezar otro.");
        return;
      }
      state.timer = setTimeout(() => pollLogin(id, chatId, messageId, loginId), Math.max(1, result.retryAfter || state.interval) * 1000);
    } catch (error) {
      pendingLogins.delete(id);
      await bot.api.editMessageText(chatId, messageId, `No pude completar el inicio de sesión: ${error.message}`);
    }
  }

  bot.command("start", (ctx) => {
    const inlineHint = ctx.match === "inline-login"
      ? "\n\nPara usar el modo inline, enlaza primero tu cuenta con /login."
      : "";
    return ctx.reply(`${HELP}\n\nHola, ${displayName(ctx)}.${inlineHint}`);
  });
  bot.command("help", (ctx) => ctx.reply(HELP));
  bot.command("login", async (ctx) => {
    const id = userId(ctx);
    if (!id) return;
    const existing = pendingLogins.get(id);
    if (existing) {
      await ctx.reply("Ya hay un inicio de sesión pendiente. Abre el enlace anterior o espera a que caduque.");
      return;
    }
    try {
      const details = await authService.startDeviceLogin();
      const text = [
        "Para enlazar tu cuenta de OpenAI:",
        `1. Abre ${details.verificationUrl}`,
        `2. Introduce el código: ${details.userCode}`,
        "",
        "El código caduca en 15 minutos. No lo compartas con nadie.",
        "Esperando autorización…",
      ].join("\n");
      const message = await ctx.reply(text, {
        reply_markup: new InlineKeyboard().url("Abrir inicio de sesión de Codex", details.verificationUrl),
      });
      pendingLogins.set(id, { loginId: details.loginId, interval: details.interval, timer: null });
      await pollLogin(id, ctx.chat.id, message.message_id, details.loginId);
    } catch (error) {
      await ctx.reply(`No pude iniciar el enlace con OpenAI: ${error.message}`);
    }
  });

  bot.command("logout", async (ctx) => {
    const id = userId(ctx);
    if (id) await userStore.clear(id);
    await ctx.reply("He eliminado la sesión de OpenAI asociada a tu cuenta de Telegram.");
  });

  bot.command("whoami", async (ctx) => {
    const id = userId(ctx);
    const record = id && userStore.get(id);
    if (!record?.identity) return sendLoginRequired(ctx);
    await ctx.reply(`Cuenta enlazada: ${record.identity.email || "correo no disponible"}${record.identity.plan ? ` (${record.identity.plan})` : ""}`);
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
        button: { text: "Enlazar cuenta de OpenAI", start_parameter: "inline-login" },
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
    await ctx.answerInlineQuery([inlinePlaceholderResult(jobId, query)], {
      cache_time: 0,
      is_personal: true,
    });
  });

  bot.callbackQuery(/^inline:([0-9a-f-]{36})$/, async (ctx) => {
    pruneInlineJobs();
    const jobId = ctx.match[1];
    const job = inlineJobs.get(jobId);
    const id = userId(ctx);
    const inlineMessageId = ctx.callbackQuery.inline_message_id;
    if (!job || !inlineMessageId) {
      await ctx.answerCallbackQuery({ text: "Esta solicitud ha caducado. Vuelve a abrir el modo inline." });
      return;
    }
    if (job.userId !== id) {
      await ctx.answerCallbackQuery({ text: "Solo quien creó este placeholder puede generar el sticker.", show_alert: true });
      return;
    }
    if (job.status === "running" || activeUsers.has(id)) {
      await ctx.answerCallbackQuery({ text: "Ya estoy generando un sticker para ti." });
      return;
    }
    if (job.status === "ready") {
      await ctx.answerCallbackQuery({ text: "El sticker ya está listo." });
      return;
    }

    job.status = "running";
    activeUsers.add(id);
    await ctx.answerCallbackQuery({ text: "Generando sticker…" });
    await bot.api.editMessageTextInline(inlineMessageId, "⏳ Generando sticker…");
    if (!queue.enqueue(() => processInlineStickerJob({ jobId, inlineMessageId }))) {
      activeUsers.delete(id);
      job.status = "pending";
      await bot.api.editMessageTextInline(inlineMessageId, "Hay demasiadas generaciones en cola. Inténtalo de nuevo.");
    }
  });

  bot.command("sticker", async (ctx) => {
    const sourceFileId = sourceImageFileId(ctx, { includeCurrent: true });
    const prompt = ctx.match?.trim() || (sourceFileId ? DEFAULT_PHOTO_PROMPT : "");
    await createSticker(ctx, prompt, sourceFileId);
  });

  bot.command("edit", async (ctx) => {
    const sourceFileId = sourceImageFileId(ctx);
    if (!sourceFileId) {
      await ctx.reply("Responde a un sticker o una foto con /edit y describe el cambio que quieres.");
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
    if (!sourceFileId && isPrivate) return;
    await createSticker(ctx, prompt || (sourceFileId ? DEFAULT_PHOTO_PROMPT : ""), sourceFileId);
  });

  bot.on(["message:photo", "message:document"], async (ctx) => {
    const sourceFileId = imageFileIdFromMessage(ctx.message, { includeSticker: false });
    if (!sourceFileId) return;
    const caption = ctx.message.caption?.trim() || "";
    if (caption.startsWith("/")) return;
    const isPrivate = ctx.chat.type === "private";
    const mentionedPrompt = promptFromBotMention(caption, ctx.me.username);
    if (!isPrivate && mentionedPrompt === null) return;
    await createSticker(ctx, mentionedPrompt || caption || DEFAULT_PHOTO_PROMPT, sourceFileId);
  });

  return { pendingLogins, inlineJobs, queue };
}
