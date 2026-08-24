import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bot, webhookCallback } from "grammy";
import { AuthService, createDevelopmentSecret } from "./auth.js";
import { registerBotHandlers } from "./bot.js";
import { buildConversationContext, ConversationStore } from "./conversations.js";
import { MiniAppDraftStore } from "./miniapp-drafts.js";
import { createMiniAppService } from "./miniapp.js";
import { stickerDataUrl } from "./stickers.js";
import { UserStore } from "./store.js";

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("TELEGRAM_BOT_TOKEN is required");

const publicBaseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, "");
const webhookPath = process.env.TELEGRAM_WEBHOOK_PATH || "/telegram/webhook";
const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!publicBaseUrl) throw new Error("PUBLIC_BASE_URL is required to use the webhook");
if (!webhookSecret) throw new Error("TELEGRAM_WEBHOOK_SECRET is required to use the webhook");

const secret = process.env.SESSION_SECRET || createDevelopmentSecret();
if (!process.env.SESSION_SECRET) console.warn("SESSION_SECRET is not set; sessions will be invalidated after a restart");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = process.env.DATA_DIR || path.join(root, "data");
const miniAppUrl = process.env.MINI_APP_URL || `${publicBaseUrl}/app`;
if (new URL(miniAppUrl).protocol !== "https:") throw new Error("MINI_APP_URL must use HTTPS");
const store = new UserStore(path.join(dataDir, "users.json"));
await store.init();
const conversationStore = new ConversationStore(path.join(dataDir, "conversations.json"));
await conversationStore.init();

const authService = new AuthService({ secret });
const bot = new Bot(token);
const miniAppDraftStore = new MiniAppDraftStore();

async function downloadTelegramFile(fileId) {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram did not return a file path");
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok) throw new Error(`Telegram download failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

const botHandlers = registerBotHandlers({
  bot,
  authService,
  userStore: store,
  downloadTelegramFile,
  estimatedGenerationMs: Number(process.env.GENERATION_ETA_MS || 80_000),
  miniAppUrl,
  miniAppDraftStore,
  conversationStore,
});

const miniApp = createMiniAppService({
  bot,
  botToken: token,
  draftStore: miniAppDraftStore,
  downloadTelegramFile,
  loadCredentials: botHandlers.loadCredentials,
  webRoot: path.join(root, "web"),
  estimatedGenerationMs: Number(process.env.GENERATION_ETA_MS || 80_000),
  conversationStore,
  loadConversationContext: ({
    chatId,
    messageId,
    includeTarget = true,
    excludeFileId = null,
  }) => buildConversationContext({
    store: conversationStore,
    chatId,
    messageId,
    includeTarget,
    excludeFileId,
    downloadTelegramFile,
    sourceToDataUrl: stickerDataUrl,
  }),
});

bot.catch((error) => console.error("telegram update failed", error));

const port = Number(process.env.PORT || 3000);
const handleUpdate = webhookCallback(bot, "http", { secretToken: webhookSecret });
async function routeRequest(request, response) {
  if (request.url === "/healthz") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "codex-telegram-sticker-bot" }));
    return;
  }
  if (request.method === "POST" && request.url === webhookPath) {
    handleUpdate(request, response).catch((error) => {
      console.error("telegram webhook failed", error);
      if (!response.headersSent) {
        response.writeHead(500, { "Content-Type": "text/plain" });
        response.end("webhook error");
      }
    });
    return;
  }
  if (await miniApp.handleRequest(request, response)) return;
  response.writeHead(404);
  response.end("not found");
}

const server = createServer((request, response) => {
  routeRequest(request, response).catch((error) => {
    console.error("http request failed", error);
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain" });
    response.end("internal error");
  });
});
server.listen(port, "0.0.0.0", () => console.log(`Health endpoint listening on ${port}`));

await bot.api.setWebhook(`${publicBaseUrl}${webhookPath}`, {
  secret_token: webhookSecret,
  allowed_updates: ["message", "inline_query", "callback_query"],
  max_connections: 40,
});
console.log(`Telegram webhook configured at ${publicBaseUrl}${webhookPath}`);

await bot.api.setMyCommands([
  { command: "app", description: "Open the studio or edit a replied image" },
  { command: "sticker", description: "Create a sticker from a description" },
  { command: "edit", description: "Edit a replied-to sticker or photo" },
  { command: "style", description: "Choose a style for your next sticker" },
  { command: "login", description: "Link your OpenAI/Codex account" },
  { command: "whoami", description: "Show the linked account" },
  { command: "logout", description: "Remove your linked session" },
  { command: "help", description: "Show usage help" },
]);
console.log("Telegram command menu configured");

await bot.api.setChatMenuButton({
  menu_button: {
    type: "web_app",
    text: "Create sticker",
    web_app: { url: miniAppUrl },
  },
});
console.log(`Telegram Mini App menu configured at ${miniAppUrl}`);
