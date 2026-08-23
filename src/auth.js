import { createHash, randomBytes } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";

const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const SESSION_TTL = "30d";

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function encryptionKey(secret) {
  return createHash("sha256").update(secret).digest();
}

function decodeJwtPayload(token) {
  try {
    const payload = token.split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

function identityFromTokens(tokens, previous = {}) {
  const claims = decodeJwtPayload(tokens.id_token || tokens.access_token);
  const auth = claims["https://api.openai.com/auth"] || {};
  const accountId =
    claims.chatgpt_account_id || auth.chatgpt_account_id || previous.accountId;

  if (!accountId) throw new Error("OpenAI did not return an account identifier");

  return {
    accountId,
    email: claims.email || previous.email || null,
    plan: auth.chatgpt_plan_type || previous.plan || null,
  };
}

function oauthFromTokenResponse(tokens, previous = {}) {
  if (!tokens.access_token) throw new Error("OpenAI did not return an access token");
  const identity = identityFromTokens(tokens, previous);
  const refreshToken = tokens.refresh_token || previous.refreshToken;
  if (!refreshToken) throw new Error("OpenAI did not return a refresh token");

  return {
    accessToken: tokens.access_token,
    refreshToken,
    expiresAt: nowSeconds() + Number(tokens.expires_in || 3600),
    ...identity,
  };
}

async function readJson(response, description) {
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${description} returned an invalid response`);
  }
  if (!response.ok) throw new Error(`${description} failed (${response.status})`);
  return body;
}

export class AuthService {
  constructor({
    secret,
    issuer = process.env.CODEX_ISSUER || "https://auth.openai.com",
    clientId = process.env.CODEX_CLIENT_ID || DEFAULT_CLIENT_ID,
    fetchImpl = fetch,
  } = {}) {
    if (!secret) throw new Error("SESSION_SECRET is required");
    this.key = encryptionKey(secret);
    this.issuer = issuer.replace(/\/$/, "");
    this.clientId = clientId;
    this.fetch = fetchImpl;
    this.pending = new Map();
    this.cleanupTimer = setInterval(() => this.prunePending(), 60_000);
    this.cleanupTimer.unref?.();
  }

  prunePending() {
    const now = Date.now();
    for (const [loginId, pending] of this.pending) {
      if (pending.expiresAt <= now) this.pending.delete(loginId);
    }
  }

  async startDeviceLogin() {
    this.prunePending();
    if (this.pending.size >= 1_000) throw new Error("There are too many pending login attempts");

    const response = await this.fetch(`${this.issuer}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.clientId }),
    });
    const data = await readJson(response, "Codex login");
    const interval = Math.max(1, Number(data.interval || 5));
    const loginId = randomBytes(32).toString("base64url");
    const userCode = data.user_code || data.usercode;
    if (!data.device_auth_id || !userCode) throw new Error("The login flow returned incomplete data");

    this.pending.set(loginId, {
      deviceAuthId: data.device_auth_id,
      userCode,
      interval,
      nextPollAt: 0,
      expiresAt: Date.now() + 15 * 60 * 1000,
    });

    return {
      loginId,
      userCode,
      verificationUrl: `${this.issuer}/codex/device`,
      interval,
      expiresIn: 15 * 60,
    };
  }

  async pollDeviceLogin(loginId) {
    const pending = this.pending.get(loginId);
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pending.delete(loginId);
      return { status: "expired" };
    }
    if (pending.nextPollAt > Date.now()) return { status: "pending", retryAfter: pending.interval };
    pending.nextPollAt = Date.now() + pending.interval * 1000;

    const response = await this.fetch(`${this.issuer}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_auth_id: pending.deviceAuthId, user_code: pending.userCode }),
    });
    if (response.status === 403 || response.status === 404) {
      await response.arrayBuffer();
      return { status: "pending", retryAfter: pending.interval };
    }

    const code = await readJson(response, "Codex device authorization");
    const tokens = await this.exchangeCode(code.authorization_code, code.code_verifier);
    const oauth = oauthFromTokenResponse(tokens);
    const token = await this.issueSession(oauth);
    this.pending.delete(loginId);
    return { status: "complete", token, user: this.publicIdentity(oauth) };
  }

  async exchangeCode(code, verifier) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${this.issuer}/deviceauth/callback`,
      client_id: this.clientId,
      code_verifier: verifier,
    });
    const response = await this.fetch(`${this.issuer}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    return readJson(response, "Intercambio de token de Codex");
  }

  async issueSession(oauth) {
    return new EncryptJWT({ oauth })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "JWT" })
      .setIssuedAt()
      .setExpirationTime(SESSION_TTL)
      .encrypt(this.key);
  }

  async readSession(token) {
    const { payload } = await jwtDecrypt(token, this.key, {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    if (!payload.oauth || typeof payload.oauth !== "object") throw new Error("Invalid session");
    return payload.oauth;
  }

  async credentials(token) {
    let oauth = await this.readSession(token);
    let refreshedToken = null;
    if (Number(oauth.expiresAt) <= nowSeconds() + 300) {
      oauth = await this.refresh(oauth);
      refreshedToken = await this.issueSession(oauth);
    }
    return { oauth, refreshedToken };
  }

  async refresh(previous) {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: previous.refreshToken,
      client_id: this.clientId,
    });
    const response = await this.fetch(`${this.issuer}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    return oauthFromTokenResponse(await readJson(response, "OpenAI session refresh"), previous);
  }

  publicIdentity(oauth) {
    return { email: oauth.email || null, plan: oauth.plan || null, accountId: oauth.accountId };
  }
}

export function createDevelopmentSecret() {
  return randomBytes(32).toString("hex");
}
