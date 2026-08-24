import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export class UserStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = { users: {} };
    this.writeChain = Promise.resolve();
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.users) this.state = parsed;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.persist();
    }
    try { await chmod(path.dirname(this.filePath), 0o700); } catch {}
  }

  get(telegramUserId) {
    return this.state.users[String(telegramUserId)] || null;
  }

  async setSession(telegramUserId, sessionToken, identity) {
    const key = String(telegramUserId);
    this.state.users[key] = {
      ...(this.state.users[key] || {}),
      sessionToken,
      identity: identity || this.state.users[key]?.identity || null,
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
  }

  async setStylePreset(telegramUserId, stylePresetId) {
    const key = String(telegramUserId);
    this.state.users[key] = {
      ...(this.state.users[key] || {}),
      stylePresetId,
      updatedAt: new Date().toISOString(),
    };
    await this.persist();
  }

  async clearStylePreset(telegramUserId) {
    const key = String(telegramUserId);
    const user = this.state.users[key];
    if (!user?.stylePresetId) return;
    delete user.stylePresetId;
    user.updatedAt = new Date().toISOString();
    await this.persist();
  }

  async clear(telegramUserId) {
    delete this.state.users[String(telegramUserId)];
    await this.persist();
  }

  async persist() {
    const content = JSON.stringify(this.state, null, 2);
    this.writeChain = this.writeChain.then(async () => {
      const temp = `${this.filePath}.tmp`;
      await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.filePath);
      try { await chmod(this.filePath, 0o600); } catch {}
    });
    return this.writeChain;
  }
}
