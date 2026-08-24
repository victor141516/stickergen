import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UserStore } from "../src/store.js";

test("stores and consumes a style preset without removing the linked session", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "stickergen-store-"));
  try {
    const filePath = path.join(directory, "users.json");
    const store = new UserStore(filePath);
    await store.init();
    await store.setSession("123", "encrypted-session", { email: "test@example.com" });
    await store.setStylePreset("123", "1950s-newspaper");
    assert.equal(store.get("123").stylePresetId, "1950s-newspaper");

    await store.clearStylePreset("123");
    assert.equal(store.get("123").stylePresetId, undefined);
    assert.equal(store.get("123").sessionToken, "encrypted-session");

    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(persisted.users["123"].sessionToken, "encrypted-session");
    assert.equal(persisted.users["123"].stylePresetId, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
