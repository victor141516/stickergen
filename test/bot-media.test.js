import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  imageFileIdFromMessage,
  inlineCachedStickerResult,
  inlinePlaceholderResult,
  promptFromBotMention,
  registerBotHandlers,
  replyOptions,
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
