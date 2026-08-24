import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_MAX_MESSAGES = 5_000;
const DEFAULT_CONTEXT_MESSAGES = 16;
const DEFAULT_CONTEXT_IMAGES = 3;

function messageKey(chatId, messageId) {
  return `${chatId}:${messageId}`;
}

function imageFromMessage(message) {
  if (message?.sticker && !message.sticker.is_animated && !message.sticker.is_video) {
    return { fileId: message.sticker.file_id, kind: "sticker", mimeType: "image/webp" };
  }
  if (Array.isArray(message?.photo) && message.photo.length) {
    return { fileId: message.photo.at(-1).file_id, kind: "photo", mimeType: "image/jpeg" };
  }
  if (message?.document?.mime_type?.startsWith("image/")) {
    return {
      fileId: message.document.file_id,
      kind: "image document",
      mimeType: message.document.mime_type,
    };
  }
  return null;
}

function visibleText(message) {
  const value = message?.text || message?.caption || "";
  return typeof value === "string" ? value.trim().slice(0, 4_000) : "";
}

function safeConversationText(text, role) {
  if (role === "assistant" && /enter this code:|waiting for authorization|code expires in/i.test(text)) {
    return "[The assistant sent an account-linking message; its temporary details were omitted.]";
  }
  return text;
}

function mediaDescription(media, role) {
  if (!media) return "";
  if (role === "assistant") return `[The assistant sent a generated ${media.kind}.]`;
  return `[The user sent a ${media.kind}.]`;
}

export class ConversationStore {
  constructor(filePath, {
    now = Date.now,
    ttlMs = DEFAULT_TTL_MS,
    maxMessages = DEFAULT_MAX_MESSAGES,
  } = {}) {
    this.filePath = filePath;
    this.now = now;
    this.ttlMs = ttlMs;
    this.maxMessages = maxMessages;
    this.state = { messages: {} };
    this.writeChain = Promise.resolve();
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.messages) this.state = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    this.prune();
    await this.persist();
    try { await chmod(path.dirname(this.filePath), 0o700); } catch {}
  }

  prune() {
    const cutoff = this.now() - this.ttlMs;
    const entries = Object.entries(this.state.messages)
      .filter(([, message]) => Number(message.createdAt) >= cutoff)
      .sort(([, left], [, right]) => Number(left.createdAt) - Number(right.createdAt));
    const kept = entries.slice(-this.maxMessages);
    this.state.messages = Object.fromEntries(kept);
  }

  normalize(message, {
    chatId = message?.chat?.id,
    role = message?.from?.is_bot ? "assistant" : "user",
    replyToMessageId = message?.reply_to_message?.message_id,
    text = visibleText(message),
    media = imageFromMessage(message),
    requestText = "",
  } = {}) {
    if (chatId === undefined || chatId === null || !message?.message_id) return null;
    const normalizedRole = role === "assistant" ? "assistant" : "user";
    return {
      chatId,
      messageId: message.message_id,
      replyToMessageId: replyToMessageId || null,
      role: normalizedRole,
      text: safeConversationText(String(text || "").slice(0, 4_000), normalizedRole),
      requestText: normalizedRole === "assistant" ? String(requestText || "").slice(0, 4_000) : "",
      media: media?.fileId ? media : null,
      createdAt: Number(message.date) > 0 ? Number(message.date) * 1_000 : this.now(),
    };
  }

  async rememberIncoming(message, chatId = message?.chat?.id) {
    if (message?.reply_to_message) {
      const replied = this.normalize(message.reply_to_message, { chatId });
      if (replied) {
        const key = messageKey(chatId, replied.messageId);
        this.state.messages[key] = { ...replied, ...this.state.messages[key] };
      }
    }
    const current = this.normalize(message, { chatId });
    if (current) this.state.messages[messageKey(chatId, current.messageId)] = current;
    this.prune();
    await this.persist();
    return current;
  }

  async rememberOutgoing({
    chatId,
    message,
    replyToMessageId,
    text = "",
    media = null,
    requestText = "",
  }) {
    const normalized = this.normalize(message, {
      chatId,
      role: "assistant",
      replyToMessageId,
      text,
      media,
      requestText,
    });
    if (!normalized) return null;
    this.state.messages[messageKey(chatId, normalized.messageId)] = normalized;
    this.prune();
    await this.persist();
    return normalized;
  }

  thread(chatId, messageId, { includeTarget = true, limit = DEFAULT_CONTEXT_MESSAGES } = {}) {
    const messages = [];
    const visited = new Set();
    let currentId = messageId;
    while (currentId && messages.length < limit + (includeTarget ? 0 : 1)) {
      const key = messageKey(chatId, currentId);
      if (visited.has(key)) break;
      visited.add(key);
      const message = this.state.messages[key];
      if (!message) break;
      messages.push(message);
      currentId = message.replyToMessageId;
    }
    messages.reverse();
    if (!includeTarget && messages.at(-1)?.messageId === messageId) messages.pop();
    return messages.slice(-limit);
  }

  async persist() {
    const content = JSON.stringify(this.state, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      const temp = `${this.filePath}.tmp`;
      await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.filePath);
      try { await chmod(this.filePath, 0o600); } catch {}
    });
    return this.writeChain;
  }
}

export async function buildConversationContext({
  store,
  chatId,
  messageId,
  includeTarget = false,
  downloadTelegramFile,
  sourceToDataUrl,
  logger = console,
  maxImages = DEFAULT_CONTEXT_IMAGES,
  excludeFileId = null,
}) {
  if (!store || chatId === undefined || chatId === null || !messageId) return [];
  const messages = store.thread(chatId, messageId, { includeTarget });
  const context = [];
  let images = 0;
  for (const message of messages) {
    let sourceDataUrl = null;
    if (
      message.role === "user"
      && message.media?.fileId
      && message.media.fileId !== excludeFileId
      && images < maxImages
    ) {
      try {
        const source = await downloadTelegramFile(message.media.fileId);
        sourceDataUrl = await sourceToDataUrl(source);
        images += 1;
      } catch (error) {
        logger.warn("conversation_context_image_unavailable", JSON.stringify({
          kind: message.media.kind,
          error: error?.message || String(error),
        }));
      }
    }
    const description = mediaDescription(message.media, message.role);
    const text = [message.text, description].filter(Boolean).join("\n");
    if (message.role === "assistant" && message.requestText) {
      context.push({ role: "user", text: message.requestText, sourceDataUrl: null });
    }
    if (text || sourceDataUrl) context.push({ role: message.role, text, sourceDataUrl });
  }
  return context;
}
