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
- `src/auth.js`: Codex device login, refresh, identity extraction, and encrypted JWE sessions.
- `src/codex.js`: private Codex Responses request and JSON/SSE response parsing.
- `src/stickers.js`: image decoding and the technical WebP conversion required by Telegram.
- `src/queue.js`: bounded in-process concurrency. Keep the queue inside this process.
- `src/store.js`: JSON-backed per-Telegram-user session store.
- `test/`: Node test-runner coverage for the modules above.

## Behavioral invariants

- Generate exactly once per user request. Do not reject, retry, or suppress an image based on transparency.
- Do not remove backgrounds, segment subjects, or otherwise alter generated image content locally.
- Preserve alpha when OpenAI returns alpha. Opaque OpenAI images must remain valid and be sent.
- Limit local image work to decoding, orientation, resizing, WebP encoding, and compression needed for Telegram's static sticker limits.
- Keep authentication isolated per Telegram user. Never reuse one user's Codex session for another user.
- Keep generation concurrency in `InProcessQueue`; do not add Redis, RabbitMQ, or another external queue.
- Inline queries do not contain the replied-to Telegram message. Do not claim inline editing can access that image when the bot is absent from the chat.
- Group free-text handling must require a mention so the bot does not intercept unrelated conversation.
- Keep `choose_sticker` refreshed while a normal chat generation is pending and stop it on every completion or failure path.

## Style

- Use ESM, two-space indentation, semicolons, and small focused functions.
- Keep user-facing Telegram copy in Spanish.
- Use stable, machine-searchable English event names for structured logs.
- Prefer dependency injection for networked code so behavior can be unit tested without Telegram or OpenAI.
- Preserve existing error context while avoiding tokens, authorization headers, image payloads, and session blobs in logs.

## Security and secrets

- Never commit `.env`, `data/`, Telegram tokens, webhook secrets, session secrets, OAuth tokens, or generated user data.
- `.env.example` must contain placeholders only.
- Treat `CODEX_RESPONSES_URL` and the ChatGPT/Codex device flow as private compatibility surfaces that may change.
- Do not print or inspect production secret files during deployment. Pass them to the container through the configured environment file.
- Validate the exact target before changing webhook, reverse-proxy, Docker, or remote service configuration.

## Testing expectations

- Add or update focused tests for every routing, parsing, queue, authentication, or image-conversion change.
- Mock OpenAI and Telegram for normal tests.
- Confirm both transparent and opaque inputs remain valid through `toStickerWebp`.
- Keep SSE coverage for correct content types and mislabeled JSON responses.
- Verify timers and queue jobs are always released on success, rejection, and error paths.

## Documentation and deployment

- Keep `README.md`, `.env.example`, and `DEPLOY.md` aligned with user-visible behavior and configuration.
- Follow `DEPLOY.md` for the original Docker/Caddy deployment, plus any instructions present on the target host.
- A code change does not authorize a production deployment, webhook mutation, or secret rotation unless the user explicitly requests it.
