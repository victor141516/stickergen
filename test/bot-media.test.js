import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  imageFileIdFromMessage,
  generationProgressText,
  inlineCachedStickerResult,
  inlinePlaceholderResult,
  promptFromBotMention,
  registerBotHandlers,
  replyOptions,
  startGenerationProgress,
  startStickerChatAction,
} from "../src/bot.js";

test("selects the largest Telegram photo variant", () => {
  const fileId = imageFileIdFromMessage({
    photo: [{ file_id: "small" }, { file_id: "large" }],
  });
  assert.equal(fileId, "large");
});

test("accepts image documents and static stickers as source images", () => {
  assert.equal(
    imageFileIdFromMessage({ document: { file_id: "document", mime_type: "image/jpeg" } }),
    "document",
  );
  assert.equal(imageFileIdFromMessage({ sticker: { file_id: "sticker" } }), "sticker");
  assert.equal(
    imageFileIdFromMessage({ document: { file_id: "pdf", mime_type: "application/pdf" } }),
    null,
  );
});

test("extracts a group prompt from a bot mention", () => {
  assert.equal(
    promptFromBotMention("@StickerGen_MiraMacho_bot, as an Advance Wars character", "stickergen_miramacho_bot"),
    "as an Advance Wars character",
  );
  assert.equal(
    promptFromBotMention("Make it @stickergen_miramacho_bot in a Paint style", "stickergen_miramacho_bot"),
    "Make it in a Paint style",
  );
  assert.equal(promptFromBotMention("@another_bot turn it into a sticker", "stickergen_miramacho_bot"), null);
});

test("builds an actionable inline placeholder and a cached sticker result", () => {
  const jobId = "12345678-1234-1234-1234-123456789abc";
  const placeholder = inlinePlaceholderResult(jobId, "an astronaut cat");
  assert.equal(placeholder.type, "article");
  assert.match(placeholder.input_message_content.message_text, /0% · ETA/);
  assert.match(placeholder.input_message_content.message_text, /an astronaut cat/);
  assert.equal(placeholder.reply_markup.inline_keyboard[0][0].text, "✨ Starting…");
  assert.equal(placeholder.reply_markup.inline_keyboard[0][0].callback_data, `inline:${jobId}`);
  assert.deepEqual(inlineCachedStickerResult(jobId, "telegram-file-id"), {
    type: "sticker",
    id: `ready-${jobId}`,
    sticker_file_id: "telegram-file-id",
  });
});

test("automatically starts a chosen inline result and reveals the send button only when ready", async () => {
  const handlers = new Map();
  const callbackHandlers = [];
  const inlineAnswers = [];
  const edits = [];
  const generated = [];
  const whatsappExports = [];
  let finishGeneration;
  const api = {
    async editMessageTextInline(inlineMessageId, text, options) {
      edits.push({ inlineMessageId, text, options });
      return true;
    },
    async sendSticker() {
      return { message_id: 700, sticker: { file_id: "ready-sticker-file" } };
    },
    async sendDocument(chatId, file, options) {
      whatsappExports.push({ chatId, file, options });
      return { message_id: 701 };
    },
    async deleteMessage() {},
  };
  const bot = {
    api,
    command() {},
    callbackQuery(trigger, handler) {
      callbackHandlers.push({ trigger, handler });
    },
    on(event, handler) {
      handlers.set(Array.isArray(event) ? event.join(",") : event, handler);
    },
  };

  registerBotHandlers({
    bot,
    userStore: {
      get() {
        return { sessionToken: "encrypted-session" };
      },
    },
    authService: {
      async credentials() {
        return { oauth: { accessToken: "test-token" } };
      },
      publicIdentity() {
        return {};
      },
    },
    async downloadTelegramFile() {},
    async generateImage(request) {
      generated.push(request);
      return new Promise((resolve) => {
        finishGeneration = () => resolve(Buffer.from("generated"));
      });
    },
    async convertToSticker() {
      return Buffer.from("webp");
    },
    async convertToWhatsAppExport() {
      return Buffer.from("png");
    },
    async getTransparencyStats() {
      return { hasAlpha: false, transparentPixels: 0 };
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  await handlers.get("inline_query")({
    from: { id: 123 },
    inlineQuery: { query: "a moonwalking corgi" },
    async answerInlineQuery(results, options) {
      inlineAnswers.push({ results, options });
    },
  });
  const jobId = inlineAnswers[0].results[0].id;
  assert.match(inlineAnswers[0].results[0].input_message_content.message_text, /0% · ETA/);

  await handlers.get("chosen_inline_result")({
    from: { id: 123 },
    chosenInlineResult: {
      result_id: jobId,
      inline_message_id: "inline-message-1",
      query: "a moonwalking corgi",
    },
  });
  await delay(0);

  assert.equal(generated.length, 1);
  assert.equal(generated[0].prompt, "a moonwalking corgi");
  assert.deepEqual(edits[0].options, { reply_markup: { inline_keyboard: [] } });

  const inlineCallback = callbackHandlers.find(({ trigger }) => String(trigger).includes("inline:"));
  const callbackAnswers = [];
  await inlineCallback.handler({
    from: { id: 123 },
    match: [null, jobId],
    callbackQuery: { inline_message_id: "inline-message-1" },
    async answerCallbackQuery(answer) {
      callbackAnswers.push(answer);
    },
  });
  assert.equal(generated.length, 1);
  assert.match(callbackAnswers[0].text, /already being generated/i);

  finishGeneration();
  await delay(20);
  const readyEdit = edits.find(({ text }) => text.includes("Tap below"));
  assert.equal(readyEdit.options.reply_markup.inline_keyboard[0][0].text, "Send sticker");
  assert.equal(
    readyEdit.options.reply_markup.inline_keyboard[0][0].switch_inline_query_current_chat,
    `ready:${jobId}`,
  );
  assert.equal(whatsappExports.length, 0);

  await handlers.get("inline_query")({
    from: { id: 123 },
    inlineQuery: { query: `ready:${jobId}` },
    async answerInlineQuery(results) {
      inlineAnswers.push({ results });
    },
  });
  assert.deepEqual(inlineAnswers.at(-1).results, [inlineCachedStickerResult(jobId, "ready-sticker-file")]);

  await handlers.get("chosen_inline_result")({
    from: { id: 123 },
    chosenInlineResult: {
      result_id: `ready-${jobId}`,
      query: `ready:${jobId}`,
    },
  });
  assert.equal(edits.at(-1).text, "✅ Sticker sent.");
  assert.deepEqual(edits.at(-1).options, { reply_markup: { inline_keyboard: [] } });
});

test("builds reply parameters for the original user message", () => {
  assert.deepEqual(replyOptions(321), {
    reply_parameters: {
      message_id: 321,
      allow_sending_without_reply: true,
    },
  });
  assert.deepEqual(replyOptions(), {});
});

test("normal bot messages reply to the triggering Telegram message", async () => {
  const commands = new Map();
  const replies = [];
  const bot = {
    api: {},
    command(name, handler) {
      commands.set(name, handler);
    },
    callbackQuery() {},
    on() {},
  };
  registerBotHandlers({
    bot,
    userStore: { get() { return null; } },
    authService: {},
    async downloadTelegramFile() {},
  });

  await commands.get("help")({
    from: { id: 123 },
    chat: { id: 123, type: "private" },
    message: { message_id: 456 },
    async reply(text, options) {
      replies.push({ text, options });
      return { message_id: 457 };
    },
  });

  assert.equal(replies[0].options.reply_parameters.message_id, 456);
});

test("renders estimated sticker generation progress without reaching 100% early", () => {
  assert.equal(
    generationProgressText(0, 80_000),
    "🎨 Generating your sticker…\n\n⬜⬜⬜⬜⬜⬜⬜⬜⬜⬜\n0% · ETA ~1m 20s",
  );
  assert.equal(
    generationProgressText(40_000, 80_000),
    "🎨 Generating your sticker…\n\n🟩🟩🟩🟩🟩⬜⬜⬜⬜⬜\n50% · ETA ~40s",
  );
  assert.equal(
    generationProgressText(90_000, 80_000),
    "🎨 Generating your sticker…\n\n🟩🟩🟩🟩🟩🟩🟩🟩🟩⬜\n90% · ETA finishing…",
  );
  assert.equal(
    generationProgressText(90_000, 80_000, { complete: true }),
    "🎨 Sticker ready — sending…\n\n🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩\n100%",
  );
  assert.equal(
    generationProgressText(0, 80_000, { styleName: "1950s Newspaper Cartoon" }),
    "🎨 Generating your sticker…\n\n⬜⬜⬜⬜⬜⬜⬜⬜⬜⬜\n0% · ETA ~1m 20s\nStyle: 1950s Newspaper Cartoon · prompt overrides",
  );
});

test("updates generation progress independently and stops after completion", async () => {
  let currentTime = 0;
  const updates = [];
  const progress = startGenerationProgress({
    estimatedMs: 100,
    intervalMs: 5,
    now: () => currentTime,
    update: async (text) => updates.push(text),
    logger: { warn() {} },
  });

  currentTime = 50;
  await delay(8);
  currentTime = 120;
  await delay(8);
  await progress.complete();

  assert.ok(updates.some((text) => text.includes("50% · ETA ~5s")));
  assert.ok(updates.some((text) => text.includes("90% · ETA finishing…")));
  assert.equal(updates.at(-1).includes("100%"), true);

  const updatesAtCompletion = updates.length;
  currentTime = 200;
  await delay(10);
  assert.equal(updates.length, updatesAtCompletion);
});

test("runs multiple requests from one user concurrently and replies to each original message", async () => {
  const commands = new Map();
  const generations = [];
  const statusReplies = [];
  const sentStickers = [];
  const whatsappExports = [];
  let credentialCalls = 0;
  let resolveCredentials;
  let nextStatusMessageId = 900;
  const credentialsReady = new Promise((resolve) => {
    resolveCredentials = resolve;
  });
  const api = {
    async sendChatAction() {},
    async sendSticker(chatId, sticker, options) {
      sentStickers.push({ chatId, sticker, options });
      return { message_id: 800 + sentStickers.length };
    },
    async sendDocument(chatId, document, options) {
      whatsappExports.push({ chatId, document, options });
      return { message_id: 900 + whatsappExports.length };
    },
    async deleteMessage() {},
  };
  const bot = {
    api,
    command(name, handler) {
      commands.set(name, handler);
    },
    on() {},
    callbackQuery() {},
  };
  const userStore = {
    get() {
      return { sessionToken: "encrypted-session" };
    },
    async setSession() {},
    async clear() {},
  };
  const authService = {
    async credentials() {
      credentialCalls += 1;
      return credentialsReady;
    },
    publicIdentity() {
      return {};
    },
  };
  const logger = { info() {}, warn() {}, error() {} };

  registerBotHandlers({
    bot,
    authService,
    userStore,
    async downloadTelegramFile() {
      throw new Error("No source image expected");
    },
    generateImage({ prompt }) {
      return new Promise((resolve) => generations.push({ prompt, resolve }));
    },
    async convertToSticker(image) {
      return Buffer.from(image);
    },
    async convertToWhatsAppExport(image) {
      return Buffer.from(`png-${image}`);
    },
    async getTransparencyStats() {
      return { hasAlpha: false, transparentPixels: 0 };
    },
    logger,
  });

  const context = (messageId, prompt) => ({
    api,
    from: { id: 123 },
    chat: { id: 456, type: "private" },
    message: { message_id: messageId },
    match: prompt,
    async reply(text, options) {
      statusReplies.push({ text, options });
      nextStatusMessageId += 1;
      return { message_id: nextStatusMessageId };
    },
  });

  const stickerHandler = commands.get("sticker");
  await stickerHandler(context(101, "first sticker"));
  await stickerHandler(context(102, "second sticker"));
  await delay(0);

  assert.equal(credentialCalls, 1);
  assert.equal(generations.length, 0);
  resolveCredentials({ oauth: { accessToken: "test-token" } });
  await delay(0);

  assert.deepEqual(generations.map(({ prompt }) => prompt), ["first sticker", "second sticker"]);
  assert.deepEqual(
    statusReplies.map(({ options }) => options.reply_parameters.message_id),
    [101, 102],
  );

  generations[1].resolve("second");
  generations[0].resolve("first");
  await delay(10);

  assert.deepEqual(
    sentStickers.map(({ options }) => options.reply_parameters.message_id),
    [102, 101],
  );
  assert.deepEqual(
    whatsappExports.map(({ options }) => options.reply_parameters.message_id),
    [801, 802],
  );
});

test("keeps the choosing-sticker action active until stopped", async () => {
  const calls = [];
  const api = {
    async sendChatAction(chatId, action, options) {
      calls.push({ chatId, action, options });
    },
  };
  const stop = startStickerChatAction(api, 123, { messageThreadId: 456, intervalMs: 10 });
  await delay(35);
  stop();
  const callsWhenStopped = calls.length;
  await delay(20);

  assert.ok(callsWhenStopped >= 3);
  assert.equal(calls.length, callsWhenStopped);
  assert.deepEqual(calls[0], {
    chatId: 123,
    action: "choose_sticker",
    options: { message_thread_id: 456 },
  });
});

test("keeps presets out of groups and consumes them once for private text or existing stickers", async () => {
  const handlers = new Map();
  const generatedRequests = [];
  const sentStickers = [];
  const whatsappExports = [];
  const replyTexts = [];
  const user = {
    sessionToken: "encrypted-session",
    stylePresetId: "1950s-newspaper",
  };
  const api = {
    async sendChatAction() {},
    async editMessageText() {},
    async deleteMessage() {},
    async sendSticker(chatId, sticker, options) {
      sentStickers.push({ chatId, sticker, options });
      return { message_id: 700 + sentStickers.length };
    },
    async sendDocument(chatId, document, options) {
      whatsappExports.push({ chatId, document, options });
      return { message_id: 750 + whatsappExports.length };
    },
  };
  const bot = {
    api,
    command() {},
    callbackQuery() {},
    on(event, handler) {
      handlers.set(Array.isArray(event) ? event.join(",") : event, handler);
    },
  };
  const userStore = {
    get() {
      return user;
    },
    async setSession() {},
    async clear() {},
    async clearStylePreset() {
      delete user.stylePresetId;
    },
  };

  registerBotHandlers({
    bot,
    userStore,
    authService: {
      async credentials() {
        return { oauth: { accessToken: "test-token" } };
      },
      publicIdentity() {
        return {};
      },
    },
    async downloadTelegramFile(fileId) {
      return Buffer.from(fileId);
    },
    async sourceToDataUrl(source) {
      return `data:image/webp;base64,${source.toString("base64")}`;
    },
    async generateImage({ prompt, sourceDataUrl }) {
      generatedRequests.push({ prompt, sourceDataUrl });
      return Buffer.from("generated-image");
    },
    async convertToSticker() {
      return Buffer.from("webp");
    },
    async convertToWhatsAppExport() {
      return Buffer.from("png");
    },
    async getTransparencyStats() {
      return { hasAlpha: false, transparentPixels: 0 };
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  let statusId = 800;
  const context = (messageId, text, chatType = "private", message = null) => ({
    api,
    from: { id: 123 },
    chat: { id: 456, type: chatType },
    me: { username: "stickergen_bot" },
    message: message || { message_id: messageId, text },
    async reply(replyText) {
      replyTexts.push(replyText);
      statusId += 1;
      return { message_id: statusId };
    },
  });

  const textHandler = handlers.get("message:text");
  await textHandler(context(100, "@stickergen_bot A green dragon", "group"));
  await delay(10);
  assert.equal(user.stylePresetId, "1950s-newspaper");
  assert.equal(whatsappExports.length, 0);
  await textHandler(context(101, "A red robot in watercolor"));
  await delay(10);
  await textHandler(context(102, "A blue cat"));
  await delay(10);

  user.stylePresetId = "gba-tactics";
  const stickerHandler = handlers.get("message:sticker");
  await stickerHandler(context(103, "", "private", {
    message_id: 103,
    sticker: { file_id: "animated-sticker", is_animated: true, is_video: false },
  }));
  assert.equal(user.stylePresetId, "gba-tactics");
  await stickerHandler(context(104, "", "private", {
    message_id: 104,
    sticker: { file_id: "static-sticker", is_animated: false, is_video: false },
  }));
  await delay(10);

  assert.equal(generatedRequests.length, 4);
  assert.equal(generatedRequests[0].prompt, "A green dragon");
  assert.match(generatedRequests[1].prompt, /A red robot in watercolor/);
  assert.match(generatedRequests[1].prompt, /1950s newspaper cartoon/i);
  assert.match(generatedRequests[1].prompt, /ignore the preset/i);
  assert.equal(generatedRequests[2].prompt, "A blue cat");
  assert.match(generatedRequests[3].prompt, /Recreate this existing sticker/);
  assert.equal(whatsappExports.length, 3);
  assert.match(generatedRequests[3].prompt, /Advance Wars on Game Boy Advance/);
  assert.equal(
    generatedRequests[3].sourceDataUrl,
    `data:image/webp;base64,${Buffer.from("static-sticker").toString("base64")}`,
  );
  assert.equal(user.stylePresetId, undefined);
  assert.ok(replyTexts.some((text) => text.includes("static stickers only")));
  assert.deepEqual(
    sentStickers.map(({ options }) => options.reply_parameters.message_id),
    [100, 101, 102, 104],
  );
});

test("offers an unstyled private sticker to the Mini App as an owned draft", async () => {
  const handlers = new Map();
  const replies = [];
  const createdDrafts = [];
  const bot = {
    api: {},
    command() {},
    callbackQuery() {},
    on(event, handler) {
      handlers.set(Array.isArray(event) ? event.join(",") : event, handler);
    },
  };
  const userStore = {
    get() {
      return { sessionToken: "encrypted-session" };
    },
  };
  registerBotHandlers({
    bot,
    userStore,
    authService: {},
    async downloadTelegramFile() {},
    miniAppUrl: "https://stickers.example/app",
    miniAppDraftStore: {
      create(draft) {
        createdDrafts.push(draft);
        return { ...draft, id: "12345678-1234-1234-1234-123456789abc" };
      },
    },
  });

  await handlers.get("message:sticker")({
    from: { id: 123 },
    chat: { id: 123, type: "private" },
    message: {
      message_id: 456,
      sticker: { file_id: "telegram-sticker", is_animated: false, is_video: false },
    },
    async reply(text, options) {
      replies.push({ text, options });
    },
  });

  assert.deepEqual(createdDrafts, [{
    userId: "123",
    fileId: "telegram-sticker",
    chatId: 123,
    messageId: 456,
    name: "Telegram sticker",
    mimeType: "image/webp",
  }]);
  assert.equal(replies[0].options.reply_parameters.message_id, 456);
  assert.equal(
    replies[0].options.reply_markup.inline_keyboard[0][0].web_app.url,
    "https://stickers.example/app?draft=12345678-1234-1234-1234-123456789abc",
  );
});

test("opens a replied Telegram sticker in the Mini App regardless of the selected chat preset", async () => {
  const commands = new Map();
  const replies = [];
  const createdDrafts = [];
  const bot = {
    api: {},
    command(name, handler) {
      commands.set(name, handler);
    },
    callbackQuery() {},
    on() {},
  };
  registerBotHandlers({
    bot,
    userStore: {
      get() {
        return { sessionToken: "encrypted-session", stylePresetId: "gba-tactics" };
      },
    },
    authService: {},
    async downloadTelegramFile() {},
    miniAppUrl: "https://stickers.example/app",
    miniAppDraftStore: {
      create(draft) {
        createdDrafts.push(draft);
        return { ...draft, id: "abcdefab-1234-1234-1234-abcdefabcdef" };
      },
    },
  });

  await commands.get("app")({
    from: { id: 123 },
    chat: { id: 123, type: "private" },
    message: {
      message_id: 500,
      reply_to_message: {
        message_id: 456,
        sticker: { file_id: "replied-sticker", is_animated: false, is_video: false },
      },
    },
    async reply(text, options) {
      replies.push({ text, options });
    },
  });

  assert.deepEqual(createdDrafts, [{
    userId: "123",
    fileId: "replied-sticker",
    chatId: 123,
    messageId: 456,
    name: "Telegram sticker",
    mimeType: "image/webp",
  }]);
  assert.equal(replies[0].options.reply_parameters.message_id, 456);
  assert.equal(
    replies[0].options.reply_markup.inline_keyboard[0][0].web_app.url,
    "https://stickers.example/app?draft=abcdefab-1234-1234-1234-abcdefabcdef",
  );
});

test("reconstructs reply context for private edits and mentioned group edits", async () => {
  const commands = new Map();
  const handlers = new Map();
  const generatedRequests = [];
  const api = {
    async sendChatAction() {},
    async editMessageText() {},
    async deleteMessage() {},
    async sendSticker(_chatId, _sticker, options) {
      return {
        message_id: 900 + generatedRequests.length,
        sticker: { file_id: `result-${generatedRequests.length}` },
        reply_to_message: { message_id: options.reply_parameters.message_id },
      };
    },
  };
  const bot = {
    api,
    command(name, handler) {
      commands.set(name, handler);
    },
    callbackQuery() {},
    on(event, handler) {
      handlers.set(Array.isArray(event) ? event.join(",") : event, handler);
    },
  };
  const branches = new Map([
    ["123:30", [
      {
        chatId: 123,
        messageId: 10,
        replyToMessageId: null,
        role: "user",
        text: "Turn my portrait into an old newspaper cartoon",
        media: { fileId: "portrait", kind: "photo", mimeType: "image/jpeg" },
      },
      {
        chatId: 123,
        messageId: 20,
        replyToMessageId: 10,
        role: "assistant",
        text: "I generated and sent the requested sticker.",
        media: { fileId: "private-result", kind: "sticker", mimeType: "image/webp" },
      },
    ]],
    ["-100:60", [
      {
        chatId: -100,
        messageId: 40,
        replyToMessageId: null,
        role: "user",
        text: "@stickergen_bot Make this an Advance Wars commander",
        media: null,
      },
      {
        chatId: -100,
        messageId: 50,
        replyToMessageId: 40,
        role: "assistant",
        text: "I generated and sent the requested sticker.",
        media: { fileId: "group-result", kind: "sticker", mimeType: "image/webp" },
      },
    ]],
  ]);
  const conversationStore = {
    thread(chatId, messageId) {
      return branches.get(`${chatId}:${messageId}`) || [];
    },
    async rememberOutgoing() {},
  };

  registerBotHandlers({
    bot,
    userStore: {
      get() {
        return { sessionToken: "encrypted-session" };
      },
    },
    authService: {
      async credentials() {
        return { oauth: { accessToken: "test-token" } };
      },
      publicIdentity() {
        return {};
      },
    },
    conversationStore,
    async downloadTelegramFile(fileId) {
      return Buffer.from(fileId);
    },
    async sourceToDataUrl(source) {
      return `data:image/png;base64,${source.toString("base64")}`;
    },
    async generateImage(request) {
      generatedRequests.push(request);
      return Buffer.from("generated");
    },
    async convertToSticker() {
      return Buffer.from("webp");
    },
    async getTransparencyStats() {
      return { hasAlpha: false, transparentPixels: 0 };
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  const context = ({ chatId, chatType, messageId, text, replyFileId, match }) => ({
    api,
    from: { id: 123 },
    chat: { id: chatId, type: chatType },
    me: { username: "stickergen_bot" },
    match,
    message: {
      message_id: messageId,
      text,
      reply_to_message: {
        message_id: messageId - 10,
        sticker: { file_id: replyFileId, is_animated: false, is_video: false },
      },
    },
    async reply(_text, options) {
      return { message_id: messageId + 1, reply_to_message: { message_id: options.reply_parameters.message_id } };
    },
  });

  await commands.get("edit")(context({
    chatId: 123,
    chatType: "private",
    messageId: 30,
    text: "/edit Make the shirt blue",
    replyFileId: "private-result",
    match: "Make the shirt blue",
  }));
  await handlers.get("message:text")(context({
    chatId: -100,
    chatType: "group",
    messageId: 60,
    text: "@stickergen_bot Give him a red helmet",
    replyFileId: "group-result",
  }));
  await delay(20);

  assert.equal(generatedRequests.length, 2);
  assert.match(generatedRequests[0].conversation[0].text, /old newspaper cartoon/);
  assert.match(generatedRequests[0].conversation[0].sourceDataUrl, /^data:image\/png;base64,/);
  assert.equal(generatedRequests[0].conversation[1].role, "assistant");
  assert.equal(
    generatedRequests[0].sourceDataUrl,
    `data:image/png;base64,${Buffer.from("private-result").toString("base64")}`,
  );
  assert.match(generatedRequests[1].conversation[0].text, /Advance Wars commander/);
  assert.equal(generatedRequests[1].conversation[1].role, "assistant");
  assert.equal(
    generatedRequests[1].sourceDataUrl,
    `data:image/png;base64,${Buffer.from("group-result").toString("base64")}`,
  );
});
