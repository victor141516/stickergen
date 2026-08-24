import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_MAX_AGE_SECONDS = 24 * 60 * 60;

function equalHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left) || !/^[a-f0-9]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

export function validateTelegramInitData(initData, botToken, {
  maxAgeSeconds = DEFAULT_MAX_AGE_SECONDS,
  now = () => Date.now(),
} = {}) {
  if (typeof initData !== "string" || !initData) throw new Error("Telegram authorization is required");
  if (typeof botToken !== "string" || !botToken) throw new Error("Bot token is required to validate Telegram authorization");

  const params = new URLSearchParams(initData);
  const seen = new Set();
  for (const key of params.keys()) {
    if (seen.has(key)) throw new Error("Telegram authorization contains duplicate fields");
    seen.add(key);
  }

  const receivedHash = params.get("hash") || "";
  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
  if (!equalHex(receivedHash, expectedHash)) throw new Error("Telegram authorization is invalid");

  const authDate = Number(params.get("auth_date"));
  const currentSeconds = Math.floor(now() / 1000);
  if (!Number.isSafeInteger(authDate) || authDate <= 0) throw new Error("Telegram authorization date is invalid");
  if (authDate > currentSeconds + 60) throw new Error("Telegram authorization date is in the future");
  if (currentSeconds - authDate > maxAgeSeconds) throw new Error("Telegram authorization has expired");

  let user;
  try {
    user = JSON.parse(params.get("user") || "null");
  } catch {
    throw new Error("Telegram user data is invalid");
  }
  if (!user?.id || !Number.isSafeInteger(Number(user.id))) throw new Error("Telegram user identity is missing");

  return {
    authDate,
    queryId: params.get("query_id") || null,
    startParam: params.get("start_param") || null,
    user: {
      ...user,
      id: String(user.id),
    },
  };
}
