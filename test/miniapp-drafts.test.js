import assert from "node:assert/strict";
import test from "node:test";
import { MiniAppDraftStore } from "../src/miniapp-drafts.js";

test("keeps Mini App sticker drafts private to their Telegram user and expires them", () => {
  let currentTime = 1_000;
  const store = new MiniAppDraftStore({ ttlMs: 500, now: () => currentTime });
  const draft = store.create({
    userId: "123",
    fileId: "telegram-file",
    chatId: 123,
    messageId: 456,
  });

  assert.equal(store.get(draft.id, "123")?.fileId, "telegram-file");
  assert.equal(store.get(draft.id, "999"), null);
  currentTime += 501;
  assert.equal(store.get(draft.id, "123"), null);
});
