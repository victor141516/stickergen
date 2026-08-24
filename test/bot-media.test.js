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
  assert.equal(placeholder.reply_markup.inline_keyboard[0][0].callback_data, `inline:${jobId}`);
  assert.deepEqual(inlineCachedStickerResult(jobId, "telegram-file-id"), {
    type: "sticker",
    id: `ready-${jobId}`,
    sticker_file_id: "telegram-file-id",
  });
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
      return {};
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

test("keeps presets out of groups, generates from private text, and consumes a preset once", async () => {
  const handlers = new Map();
  const generatedPrompts = [];
  const sentStickers = [];
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
      return {};
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
    async downloadTelegramFile() {
      throw new Error("No source image expected");
    },
    async generateImage({ prompt }) {
      generatedPrompts.push(prompt);
      return Buffer.from("generated-image");
    },
    async convertToSticker() {
      return Buffer.from("webp");
    },
    async getTransparencyStats() {
      return { hasAlpha: false, transparentPixels: 0 };
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  let statusId = 800;
  const context = (messageId, text, chatType = "private") => ({
    api,
    from: { id: 123 },
    chat: { id: 456, type: chatType },
    me: { username: "stickergen_bot" },
    message: { message_id: messageId, text },
    async reply() {
      statusId += 1;
      return { message_id: statusId };
    },
  });

  const textHandler = handlers.get("message:text");
  await textHandler(context(100, "@stickergen_bot A green dragon", "group"));
  await delay(10);
  assert.equal(user.stylePresetId, "1950s-newspaper");
  await textHandler(context(101, "A red robot in watercolor"));
  await delay(10);
  await textHandler(context(102, "A blue cat"));
  await delay(10);

  assert.equal(generatedPrompts.length, 3);
  assert.equal(generatedPrompts[0], "A green dragon");
  assert.match(generatedPrompts[1], /A red robot in watercolor/);
  assert.match(generatedPrompts[1], /1950s newspaper cartoon/i);
  assert.match(generatedPrompts[1], /ignore the preset/i);
  assert.equal(generatedPrompts[2], "A blue cat");
  assert.deepEqual(
    sentStickers.map(({ options }) => options.reply_parameters.message_id),
    [100, 101, 102],
  );
});
