import sharp from "sharp";

async function decodeImage(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value.startsWith("data:")) {
    const match = value.match(/^data:[^;]+;base64,(.+)$/s);
    if (match) return Buffer.from(match[1], "base64");
  }
  if (/^https?:\/\//i.test(value)) {
    const response = await fetch(value);
    if (!response.ok) throw new Error(`Image download failed (${response.status})`);
    return Buffer.from(await response.arrayBuffer());
  }
  if (/^[A-Za-z0-9+/=_-]+$/.test(value) && value.length > 100) {
    try { return Buffer.from(value, "base64"); } catch {}
  }
  return null;
}

export async function transparencyStats(imageValue) {
  const input = await decodeImage(imageValue);
  if (!input) throw new Error("The image is not in a usable format");
  const { data, info } = await sharp(input)
    .rotate()
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let transparentPixels = 0;
  let clearPixels = 0;
  let minAlpha = 255;
  for (let index = 3; index < data.length; index += info.channels) {
    const alpha = data[index];
    if (alpha < 255) transparentPixels += 1;
    if (alpha <= 8) clearPixels += 1;
    if (alpha < minAlpha) minAlpha = alpha;
  }
  const pixels = info.width * info.height;
  return {
    hasTransparentPixels: transparentPixels > 0,
    transparentPixelRatio: transparentPixels / pixels,
    clearPixelRatio: clearPixels / pixels,
    minAlpha,
    width: info.width,
    height: info.height,
  };
}

export async function toStickerWebp(imageValue) {
  if (typeof imageValue !== "string") throw new Error("The Codex image response is not in a usable format");
  const input = await decodeImage(imageValue);
  if (!input) throw new Error("The Codex image response is not in a usable format");

  const sizes = [512, 480, 448, 384];
  const qualities = [90, 80, 70, 60];
  for (const size of sizes) {
    for (const quality of qualities) {
      const output = await sharp(input)
        .rotate()
        .resize({ width: size, height: size, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .webp({ quality, effort: 6 })
        .toBuffer();
      if (output.length <= 512 * 1024) return output;
    }
  }
  throw new Error("The generated image is too large for a Telegram sticker");
}

export async function stickerDataUrl(buffer) {
  const png = await sharp(buffer).png().toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}
