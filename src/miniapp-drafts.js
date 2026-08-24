import { randomUUID } from "node:crypto";

const DEFAULT_TTL_MS = 60 * 60 * 1000;

export class MiniAppDraftStore {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxDrafts = 500, now = Date.now } = {}) {
    this.ttlMs = ttlMs;
    this.maxDrafts = maxDrafts;
    this.now = now;
    this.drafts = new Map();
  }

  prune() {
    const currentTime = this.now();
    for (const [id, draft] of this.drafts) {
      if (draft.expiresAt <= currentTime) this.drafts.delete(id);
    }
    while (this.drafts.size >= this.maxDrafts) {
      this.drafts.delete(this.drafts.keys().next().value);
    }
  }

  create({
    userId,
    fileId,
    chatId,
    messageId,
    name = "Telegram sticker",
    mimeType = "image/webp",
  }) {
    this.prune();
    const id = randomUUID();
    const draft = {
      id,
      userId: String(userId),
      fileId,
      chatId,
      messageId,
      name,
      mimeType,
      createdAt: this.now(),
      expiresAt: this.now() + this.ttlMs,
    };
    this.drafts.set(id, draft);
    return draft;
  }

  get(id, userId) {
    this.prune();
    const draft = this.drafts.get(id);
    if (!draft || draft.userId !== String(userId)) return null;
    return draft;
  }
}
