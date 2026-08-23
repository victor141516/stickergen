import assert from "node:assert/strict";
import test from "node:test";
import { AuthService } from "../src/auth.js";

test("Codex OAuth session is encrypted and round-trips", async () => {
  const service = new AuthService({ secret: "test-secret-with-at-least-thirty-two-bytes" });
  const oauth = { accessToken: "access-secret", refreshToken: "refresh-secret", expiresAt: Math.floor(Date.now() / 1000) + 3600, accountId: "account-123", email: "reader@example.com", plan: "plus" };
  const token = await service.issueSession(oauth);
  assert.equal(token.split(".").length, 5);
  assert.ok(!token.includes("access-secret"));
  assert.deepEqual(await service.readSession(token), oauth);
});

test("sessions cannot be decrypted with another secret", async () => {
  const first = new AuthService({ secret: "first-test-secret-with-thirty-two-bytes" });
  const second = new AuthService({ secret: "second-test-secret-with-thirty-two-bytes" });
  const token = await first.issueSession({ accessToken: "secret" });
  await assert.rejects(() => second.readSession(token));
});
