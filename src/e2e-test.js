import path from "node:path";
import { Bot, InputFile } from "grammy";
import sharp from "sharp";
import { AuthService } from "./auth.js";
import { generateStickerImage } from "./codex.js";
import { toStickerWebp, transparencyStats } from "./stickers.js";
import { UserStore } from "./store.js";

const sessionSecret = process.env.SESSION_SECRET;
const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
if (!sessionSecret || !telegramToken) throw new Error("Required runtime secrets are missing");

const dataDir = process.env.DATA_DIR || "/app/data";
const store = new UserStore(path.join(dataDir, "users.json"));
await store.init();

const telegramUserIds = Object.keys(store.state.users);
if (telegramUserIds.length !== 1) {
  throw new Error(`The E2E test requires exactly one stored session; found ${telegramUserIds.length}`);
}

const telegramUserId = telegramUserIds[0];
const record = store.get(telegramUserId);
const authService = new AuthService({ secret: sessionSecret });
const credentials = await authService.credentials(record.sessionToken);
if (credentials.refreshedToken) {
  await store.setSession(
    telegramUserId,
    credentials.refreshedToken,
    authService.publicIdentity(credentials.oauth),
  );
}

const withSourceImage = process.env.TEST_WITH_SOURCE_IMAGE === "1";
let sourceDataUrl = null;
if (withSourceImage) {
  const svg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="512" height="512">
      <rect width="512" height="512" fill="#dff4ff"/>
      <circle cx="256" cy="230" r="135" fill="#ff9f43"/>
      <circle cx="210" cy="205" r="18" fill="#17202a"/>
      <circle cx="302" cy="205" r="18" fill="#17202a"/>
      <path d="M200 280 Q256 330 312 280" stroke="#17202a" stroke-width="18" fill="none" stroke-linecap="round"/>
    </svg>
  `);
  const png = await sharp(svg).png().toBuffer();
  sourceDataUrl = `data:image/png;base64,${png.toString("base64")}`;
}

const prompt = process.env.TEST_STICKER_PROMPT || (withSourceImage
  ? "Transform this exact orange smiling character into a polished Telegram sticker, keeping its face recognizable and removing the blue background"
  : "A cheerful orange cat astronaut waving from a tiny silver rocket, bold clean silhouette, transparent background, Telegram sticker style");
const rawImage = await generateStickerImage({ oauth: credentials.oauth, prompt, sourceDataUrl });
const generatedTransparency = await transparencyStats(rawImage);
const webp = await toStickerWebp(rawImage);
const stickerTransparency = await transparencyStats(webp);

const bot = new Bot(telegramToken);
const message = await bot.api.sendSticker(
  telegramUserId,
  new InputFile(webp, "e2e-test-sticker.webp"),
);

console.log(JSON.stringify({
  sessions: telegramUserIds.length,
  generatedImageCharacters: rawImage.length,
  stickerBytes: webp.length,
  generatedTransparency,
  stickerTransparency,
  usedSourceImage: withSourceImage,
  sent: true,
  telegramMessageId: message.message_id,
}));
