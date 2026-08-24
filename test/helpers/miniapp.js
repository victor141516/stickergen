import { createHmac } from "node:crypto";

export const BOT_TOKEN = "123456:test-bot-token";
export const NOW_MS = 1_800_000_000_000;

export function signedInitData(values, token = BOT_TOKEN) {
  const params = new URLSearchParams(values);
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(dataCheckString).digest("hex"));
  return params.toString();
}
