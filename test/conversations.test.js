import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildConversationContext, ConversationStore } from "../src/conversations.js";

test("persists and reconstructs a Telegram reply branch across user and bot messages", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stickergen-conversations-"));
  try {
    const filePath = path.join(directory, "conversations.json");
    const store = new ConversationStore(filePath, { now: () => 1_000 });
    await store.init();
    await store.rememberIncoming({
      message_id: 10,
      chat: { id: -100 },
      from: { id: 123, is_bot: false },
      text: "Make me an Advance Wars commander",
      photo: [{ file_id: "small" }, { file_id: "original-photo" }],
    });
    await store.rememberOutgoing({
      chatId: -100,
      message: { message_id: 11, sticker: { file_id: "generated-sticker" } },
      replyToMessageId: 10,
      text: "I generated and sent the requested sticker.",
      requestText: "Render it as a 1950s newspaper cartoon",
      media: { fileId: "generated-sticker", kind: "sticker", mimeType: "image/webp" },
    });
    await store.rememberIncoming({
      message_id: 12,
      chat: { id: -100 },
      from: { id: 123, is_bot: false },
      text: "Make the uniform blue",
      reply_to_message: {
        message_id: 11,
        from: { is_bot: true },
        sticker: { file_id: "generated-sticker" },
      },
    });

    const reloaded = new ConversationStore(filePath, { now: () => 1_000 });
    await reloaded.init();
    assert.deepEqual(
      reloaded.thread(-100, 12).map(({ messageId, replyToMessageId, role }) => ({ messageId, replyToMessageId, role })),
      [
        { messageId: 10, replyToMessageId: null, role: "user" },
        { messageId: 11, replyToMessageId: 10, role: "assistant" },
        { messageId: 12, replyToMessageId: 11, role: "user" },
      ],
    );

    const downloaded = [];
    const context = await buildConversationContext({
      store: reloaded,
      chatId: -100,
      messageId: 12,
      includeTarget: false,
      async downloadTelegramFile(fileId) {
        downloaded.push(fileId);
        return Buffer.from(fileId);
      },
      async sourceToDataUrl(source) {
        return `data:image/png;base64,${source.toString("base64")}`;
      },
      logger: { warn() {} },
    });

    assert.deepEqual(downloaded, ["original-photo"]);
    assert.equal(context[0].role, "user");
    assert.match(context[0].text, /Advance Wars commander/);
    assert.match(context[0].sourceDataUrl, /^data:image\/png;base64,/);
    assert.deepEqual(context[1], {
      role: "user",
      text: "Render it as a 1950s newspaper cartoon",
      sourceDataUrl: null,
    });
    assert.deepEqual(context[2], {
      role: "assistant",
      text: "I generated and sent the requested sticker.\n[The assistant sent a generated sticker.]",
      sourceDataUrl: null,
    });

    const persisted = await readFile(filePath, "utf8");
    assert.doesNotMatch(persisted, /data:image|base64/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("redacts temporary account-linking details from conversation storage", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stickergen-conversations-"));
  try {
    const filePath = path.join(directory, "conversations.json");
    const store = new ConversationStore(filePath, { now: () => 1_000 });
    await store.init();
    await store.rememberIncoming({
      message_id: 20,
      chat: { id: 123 },
      from: { is_bot: false },
      text: "continue",
      reply_to_message: {
        message_id: 19,
        from: { is_bot: true },
        text: "Enter this code: SECRET-CODE\nThe code expires in 15 minutes. Waiting for authorization…",
      },
    });
    const persisted = await readFile(filePath, "utf8");
    assert.doesNotMatch(persisted, /SECRET-CODE/);
    assert.match(persisted, /temporary details were omitted/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
