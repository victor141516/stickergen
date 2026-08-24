# Repository guide

## Project overview

StickerGen is a Node.js 22 Telegram bot that generates static stickers through a per-user OpenAI/Codex session. It supports private chats, group commands and mentions, photo/sticker editing, and Telegram inline mode. Production traffic arrives through an HTTPS webhook.

## Commands

- Install dependencies: `npm install`
- Start locally: `npm start`
- Run the complete test suite: `npm test`
- Build the container: `docker compose build`
- Start the container: `docker compose up -d`

Run `npm test` after every behavioral change. Do not run `src/e2e-test.js` unless the user explicitly authorizes a real Codex generation and a Telegram message; it consumes account usage and sends a sticker.

## Code map

- `src/index.js`: HTTP health endpoint, Telegram webhook, and update registration.
- `src/bot.js`: bot commands, media routing, mentions, inline placeholders, generation jobs, and user-visible messages.
- `src/miniapp.js`: Mini App assets/API, concurrent generation jobs, SSE progress, and result delivery.
- `src/miniapp-auth.js`: Telegram `initData` signature and freshness validation.
- `src/miniapp-drafts.js`: temporary user-bound references to Telegram sticker sources.
- `src/auth.js`: Codex device login, refresh, identity extraction, and encrypted JWE sessions.
- `src/codex.js`: private Codex Responses request and JSON/SSE response parsing.
- `src/conversations.js`: bounded persistent Telegram reply graph and multimodal Codex context reconstruction.
- `src/stickers.js`: image decoding and the technical WebP conversion required by Telegram.
- `src/styles.json`: ordered style preset catalog, including button copy and prompt instructions.
- `src/styles.js`: style catalog validation and user-prompt precedence.
- `src/store.js`: JSON-backed per-Telegram-user session store.
- `test/`: Node test-runner coverage for the modules above.
- `web/`: dependency-free Telegram Mini App frontend served by the bot process.

## Behavioral invariants

- Generate exactly once per user request. Do not reject, retry, or suppress an image based on transparency.
- Do not remove backgrounds, segment subjects, or otherwise alter generated image content locally.
- Preserve alpha when OpenAI returns alpha. Opaque OpenAI images must remain valid and be sent.
- Limit local image work to decoding, orientation, resizing, WebP encoding, and compression needed for Telegram's static sticker limits.
- Keep authentication isolated per Telegram user. Never reuse one user's Codex session for another user.
- Start each generation as an independent asynchronous job. Do not serialize requests or add an internal or external queue.
- Allow multiple concurrent generations from the same Telegram user.
- Coalesce overlapping credential refreshes per user so concurrent generations do not rotate the same refresh token twice.
- In regular chats, reply with the generated sticker to the user's original request when its message ID is available.
- Make every newly sent regular-chat bot message a Telegram reply when a triggering or source message ID is available.
- Persist the bounded reply graph without image bytes, reconstruct the available branch before each regular or draft-based generation, and pass earlier user/assistant turns before the current Codex input.
- Treat unavailable or expired historical Telegram images as optional context: log a safe warning and continue the single generation without them.
- Inline queries do not contain the replied-to Telegram message. Do not claim inline editing can access that image when the bot is absent from the chat.
- Group free-text handling must require a mention so the bot does not intercept unrelated conversation.
- Keep `choose_sticker` refreshed while a normal chat generation is pending and stop it on every completion or failure path.
- Keep each request's progress message updating independently, cap estimated progress at 90% until completion, and stop its timer on every success or failure path.
- Keep style presets optional and one-use. Apply them only to private-chat requests, and always give an explicit style in the current user prompt priority over the preset.
- Accept a static sticker sent directly in private chat as a source image so a selected preset can restyle it. Do not intercept standalone stickers in groups.
- When `/app` replies to a static sticker, photo, or image document in private chat, create a user-bound Mini App draft for that exact source message regardless of the currently selected chat preset.
- Validate Mini App `initData` on every protected API request and bind jobs, drafts, previews, and Telegram file identifiers to the validated user ID.
- Keep Mini App jobs concurrent and in-process. Stream progress with SSE; do not introduce a queue, worker, or external persistence service.
- Never put Mini App `initData`, source images, output images, Telegram file identifiers, or Codex credentials in URLs or logs.

## Style

- Use ESM, two-space indentation, semicolons, and small focused functions.
- Keep user-facing Telegram copy in English.
- Use stable, machine-searchable English event names for structured logs.
- Prefer dependency injection for networked code so behavior can be unit tested without Telegram or OpenAI.
- Preserve existing error context while avoiding tokens, authorization headers, image payloads, and session blobs in logs.
- Keep a temporary sanitized trace for each Codex call. Log the full trace only on failure; discard it after successful calls. Replace image data with metadata and a hash, and redact credentials and account identifiers.

## Security and secrets

- Never commit `.env`, `data/`, Telegram tokens, webhook secrets, session secrets, OAuth tokens, or generated user data.
- `.env.example` must contain placeholders only.
- Treat `CODEX_RESPONSES_URL` and the ChatGPT/Codex device flow as private compatibility surfaces that may change.
- Do not print or inspect production secret files during deployment. Pass them to the container through the configured environment file.
- Validate the exact target before changing webhook, reverse-proxy, Docker, or remote service configuration.

## Testing expectations

- Add or update focused tests for every routing, parsing, concurrency, authentication, or image-conversion change.
- Mock OpenAI and Telegram for normal tests.
- Confirm both transparent and opaque inputs remain valid through `toStickerWebp`.
- Keep SSE coverage for correct content types and mislabeled JSON responses.
- Verify chat-action timers and detached generation promises are always handled on success, rejection, and error paths.
- Verify private-chat, group, and Mini App edits replay only their own reply branch and retain the current source image as the final user turn.

## Documentation and deployment

- Keep `README.md`, `.env.example`, and `DEPLOY.md` aligned with user-visible behavior and configuration.
- Configure the Bot API menu button from code when the Mini App is enabled. Treat BotFather's Main Mini App/profile configuration as a separate manual operation.
- Follow `DEPLOY.md` for the original Docker/Caddy deployment, plus any instructions present on the target host.
- The user has given standing authorization to deploy every completed and verified code change to the existing production service. Do not mutate the webhook, reverse proxy, or secrets unless the user explicitly requests that separate change.
