import assert from "node:assert/strict";
import test from "node:test";
import { validateTelegramInitData } from "../src/miniapp-auth.js";
import { BOT_TOKEN, NOW_MS, signedInitData } from "./helpers/miniapp.js";

test("validates signed Telegram Mini App data and returns a stable user id", () => {
  const initData = signedInitData({
    auth_date: String(Math.floor(NOW_MS / 1000) - 30),
    query_id: "query-123",
    user: JSON.stringify({ id: 987654321, first_name: "Ada" }),
  });
  const result = validateTelegramInitData(initData, BOT_TOKEN, { now: () => NOW_MS });
  assert.equal(result.user.id, "987654321");
  assert.equal(result.user.first_name, "Ada");
  assert.equal(result.queryId, "query-123");
});

test("rejects altered, expired, and duplicated Telegram Mini App data", () => {
  const valid = signedInitData({
    auth_date: String(Math.floor(NOW_MS / 1000) - 30),
    user: JSON.stringify({ id: 123 }),
  });
  assert.throws(
    () => validateTelegramInitData(valid.replace("123", "124"), BOT_TOKEN, { now: () => NOW_MS }),
    /invalid/,
  );

  const expired = signedInitData({
    auth_date: String(Math.floor(NOW_MS / 1000) - 86_401),
    user: JSON.stringify({ id: 123 }),
  });
  assert.throws(
    () => validateTelegramInitData(expired, BOT_TOKEN, { now: () => NOW_MS }),
    /expired/,
  );

  assert.throws(
    () => validateTelegramInitData(`${valid}&auth_date=1`, BOT_TOKEN, { now: () => NOW_MS }),
    /duplicate/,
  );
});
