import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import {
  imageFileIdFromMessage,
  inlineCachedStickerResult,
  inlinePlaceholderResult,
  promptFromBotMention,
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
    promptFromBotMention("@StickerGen_MiraMacho_bot, como personaje de Advance Wars", "stickergen_miramacho_bot"),
    "como personaje de Advance Wars",
  );
  assert.equal(
    promptFromBotMention("Hazlo @stickergen_miramacho_bot con estilo Paint", "stickergen_miramacho_bot"),
    "Hazlo con estilo Paint",
  );
  assert.equal(promptFromBotMention("@otro_bot hazlo sticker", "stickergen_miramacho_bot"), null);
});

test("builds an actionable inline placeholder and a cached sticker result", () => {
  const jobId = "12345678-1234-1234-1234-123456789abc";
  const placeholder = inlinePlaceholderResult(jobId, "un gato astronauta");
  assert.equal(placeholder.type, "article");
  assert.equal(placeholder.reply_markup.inline_keyboard[0][0].callback_data, `inline:${jobId}`);
  assert.deepEqual(inlineCachedStickerResult(jobId, "telegram-file-id"), {
    type: "sticker",
    id: `ready-${jobId}`,
    sticker_file_id: "telegram-file-id",
  });
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
