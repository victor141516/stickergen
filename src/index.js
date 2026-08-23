import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Bot, webhookCallback } from "grammy";
import { AuthService, createDevelopmentSecret } from "./auth.js";
import { registerBotHandlers } from "./bot.js";
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
const store = new UserStore(path.join(dataDir, "users.json"));
await store.init();

const authService = new AuthService({ secret });
const bot = new Bot(token);

async function downloadTelegramFile(fileId) {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error("Telegram did not return a file path");
  const response = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
  if (!response.ok) throw new Error(`Telegram download failed (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

registerBotHandlers({
  bot,
  authService,
  userStore: store,
  downloadTelegramFile,
});

bot.catch((error) => console.error("telegram update failed", error));

const port = Number(process.env.PORT || 3000);
const handleUpdate = webhookCallback(bot, "http", { secretToken: webhookSecret });
const server = createServer((request, response) => {
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
  response.writeHead(404);
  response.end("not found");
});
server.listen(port, "0.0.0.0", () => console.log(`Health endpoint listening on ${port}`));

await bot.api.setWebhook(`${publicBaseUrl}${webhookPath}`, {
  secret_token: webhookSecret,
  allowed_updates: ["message", "inline_query", "callback_query"],
  max_connections: 40,
});
console.log(`Telegram webhook configured at ${publicBaseUrl}${webhookPath}`);
