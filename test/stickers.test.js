import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  stickerDataUrl,
  toStickerWebp,
  toWhatsAppExportPng,
  transparencyStats,
} from "../src/stickers.js";

test("generated image is converted to a Telegram-compatible webp sticker", async () => {
  const source = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
  const webp = await toStickerWebp(source);
  assert.equal(webp.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(webp.subarray(8, 12).toString("ascii"), "WEBP");
  assert.ok(webp.length <= 512 * 1024);
  assert.match(await stickerDataUrl(webp), /^data:image\/png;base64,/);
});

test("transparency check verifies actual alpha pixels", async () => {
  const transparent = await sharp({
    create: { width: 2, height: 2, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } },
  }).png().toBuffer();
  const opaque = await sharp({
    create: { width: 2, height: 2, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).png().toBuffer();

  assert.equal((await transparencyStats(transparent)).hasTransparentPixels, true);
  assert.equal((await transparencyStats(opaque)).hasTransparentPixels, false);
  assert.equal((await transparencyStats(transparent)).clearPixelRatio, 1);
  assert.equal((await transparencyStats(opaque)).clearPixelRatio, 0);
});

test("sticker conversion preserves transparent and opaque backgrounds", async () => {
  const transparentCanvas = await sharp({
    create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).composite([{
    input: await sharp({
      create: { width: 24, height: 24, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer(),
  }]).png().toBuffer();
  const opaqueCanvas = await sharp({
    create: { width: 64, height: 64, channels: 3, background: { r: 30, g: 60, b: 90 } },
  }).png().toBuffer();

  const transparentSticker = await toStickerWebp(`data:image/png;base64,${transparentCanvas.toString("base64")}`);
  const opaqueSticker = await toStickerWebp(`data:image/png;base64,${opaqueCanvas.toString("base64")}`);

  assert.ok((await transparencyStats(transparentSticker)).clearPixelRatio > 0.5);
  assert.equal((await transparencyStats(opaqueSticker)).clearPixelRatio, 0);
});

test("WhatsApp export is a PNG that preserves transparent and opaque backgrounds", async () => {
  const transparent = await sharp({
    create: { width: 32, height: 32, channels: 4, background: { r: 10, g: 20, b: 30, alpha: 0 } },
  }).png().toBuffer();
  const opaque = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 10, g: 20, b: 30 } },
  }).jpeg().toBuffer();

  const transparentExport = await toWhatsAppExportPng(transparent);
  const opaqueExport = await toWhatsAppExportPng(opaque);

  assert.equal(transparentExport.subarray(1, 4).toString("ascii"), "PNG");
  assert.equal(opaqueExport.subarray(1, 4).toString("ascii"), "PNG");
  assert.ok((await transparencyStats(transparentExport)).clearPixelRatio > 0.9);
  assert.equal((await transparencyStats(opaqueExport)).clearPixelRatio, 0);
});
