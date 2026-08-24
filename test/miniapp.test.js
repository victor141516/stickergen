import assert from "node:assert/strict";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { MiniAppDraftStore } from "../src/miniapp-drafts.js";
import { createMiniAppService } from "../src/miniapp.js";
import { BOT_TOKEN, NOW_MS, signedInitData } from "./helpers/miniapp.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function authData(userId = 123) {
  return signedInitData({
    auth_date: String(Math.floor(NOW_MS / 1000) - 10),
    user: JSON.stringify({ id: userId, first_name: "Test" }),
  });
}

async function startService(overrides = {}) {
  const sentStickers = [];
  const generatedRequests = [];
  const downloadedFiles = [];
  const draftStore = overrides.draftStore || new MiniAppDraftStore({ now: () => NOW_MS });
  const bot = {
    api: {
      async sendChatAction() {},
      async sendSticker(chatId, file, options) {
        sentStickers.push({ chatId, file, options });
        return { message_id: 777 };
      },
    },
  };
  const service = createMiniAppService({
    bot,
    botToken: BOT_TOKEN,
    draftStore,
    webRoot: path.join(root, "web"),
    now: () => NOW_MS,
    async downloadTelegramFile(fileId) {
      downloadedFiles.push(fileId);
      return Buffer.from("telegram-webp");
    },
    async loadCredentials() {
      return { accessToken: "oauth-token", accountId: "account" };
    },
    async generateImage(request) {
      generatedRequests.push(request);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "data:image/png;base64,ZmFrZS1wbmc=";
    },
    async convertToSticker() {
      return Buffer.from("ready-webp");
    },
    async getTransparencyStats() {
      return { hasTransparentPixels: true };
    },
    async sourceToDataUrl() {
      return "data:image/png;base64,c291cmNl";
    },
    logger: { info() {}, warn() {}, error() {} },
    ...overrides,
  });
  const server = createServer((request, response) => {
    service.handleRequest(request, response).then((handled) => {
      if (!handled) {
        response.writeHead(404);
        response.end();
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
    downloadedFiles,
    draftStore,
    generatedRequests,
    sentStickers,
  };
}

test("serves the Mini App and its JSON-defined style catalog", async () => {
  const running = await startService();
  try {
    const appResponse = await fetch(`${running.baseUrl}/app`);
    assert.equal(appResponse.status, 200);
    assert.match(await appResponse.text(), /Make the sticker in your head/);
    assert.match(appResponse.headers.get("content-security-policy"), /telegram\.org/);

    const stylesResponse = await fetch(`${running.baseUrl}/api/miniapp/styles`);
    const styles = await stylesResponse.json();
    assert.equal(styles.length, 6);
    assert.ok(styles.every(({ id, buttonText, description }) => id && buttonText && description));
  } finally {
    await running.close();
  }
});

test("authenticates a generation, streams completion, and sends the sticker", async () => {
  const running = await startService();
  const initData = authData();
  try {
    const unauthorized = await fetch(`${running.baseUrl}/api/miniapp/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "a cat" }),
    });
    assert.equal(unauthorized.status, 401);

    const startResponse = await fetch(`${running.baseUrl}/api/miniapp/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Init-Data": initData,
      },
      body: JSON.stringify({
        prompt: "A red robot in watercolor",
        presetId: "1950s-newspaper",
        sourceDataUrl: "data:image/png;base64,c291cmNl",
      }),
    });
    assert.equal(startResponse.status, 202);
    const { jobId } = await startResponse.json();

    const hiddenFromAnotherUser = await fetch(`${running.baseUrl}/api/miniapp/generations/${jobId}/events`, {
      headers: { "X-Telegram-Init-Data": authData(999) },
    });
    assert.equal(hiddenFromAnotherUser.status, 404);

    const eventsResponse = await fetch(`${running.baseUrl}/api/miniapp/generations/${jobId}/events`, {
      headers: { "X-Telegram-Init-Data": initData },
    });
    const events = await eventsResponse.text();
    assert.match(events, /"status":"complete"/);
    assert.match(events, /"progress":100/);

    const imageResponse = await fetch(`${running.baseUrl}/api/miniapp/generations/${jobId}/image`, {
      headers: { "X-Telegram-Init-Data": initData },
    });
    assert.equal(imageResponse.headers.get("content-type"), "image/webp");
    assert.equal(Buffer.from(await imageResponse.arrayBuffer()).toString(), "ready-webp");

    assert.equal(running.sentStickers.length, 1);
    assert.equal(running.sentStickers[0].chatId, "123");
    assert.match(running.generatedRequests[0].prompt, /A red robot in watercolor/);
    assert.match(running.generatedRequests[0].prompt, /1950s newspaper cartoon/i);
    assert.equal(running.generatedRequests[0].sourceDataUrl, "data:image/png;base64,c291cmNl");
  } finally {
    await running.close();
  }
});

test("loads an owned Telegram sticker draft and replies to its source message", async () => {
  const running = await startService();
  const initData = authData();
  const draft = running.draftStore.create({
    userId: "123",
    fileId: "telegram-sticker-file",
    chatId: 123,
    messageId: 456,
  });
  try {
    const forbiddenDraft = await fetch(`${running.baseUrl}/api/miniapp/drafts/${draft.id}`, {
      headers: { "X-Telegram-Init-Data": authData(999) },
    });
    assert.equal(forbiddenDraft.status, 404);

    const draftImage = await fetch(`${running.baseUrl}/api/miniapp/drafts/${draft.id}/image`, {
      headers: { "X-Telegram-Init-Data": initData },
    });
    assert.equal(draftImage.status, 200);
    assert.equal(Buffer.from(await draftImage.arrayBuffer()).toString(), "telegram-webp");

    const startResponse = await fetch(`${running.baseUrl}/api/miniapp/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Telegram-Init-Data": initData,
      },
      body: JSON.stringify({ draftId: draft.id, presetId: "gba-tactics", prompt: "" }),
    });
    const { jobId } = await startResponse.json();
    const events = await fetch(`${running.baseUrl}/api/miniapp/generations/${jobId}/events`, {
      headers: { "X-Telegram-Init-Data": initData },
    });
    assert.match(await events.text(), /"status":"complete"/);

    assert.deepEqual(running.downloadedFiles, ["telegram-sticker-file", "telegram-sticker-file"]);
    assert.match(running.generatedRequests[0].prompt, /Advance Wars on Game Boy Advance/);
    assert.equal(running.generatedRequests[0].sourceDataUrl, "data:image/png;base64,c291cmNl");
    assert.equal(running.sentStickers[0].options.reply_parameters.message_id, 456);
  } finally {
    await running.close();
  }
});
