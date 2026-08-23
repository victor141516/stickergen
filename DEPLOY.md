# Deploying to Tilde

The deployment uses Docker Compose. On the remote host:

```console
mkdir -p ~/codex-telegram-sticker-bot
mkdir -p /home/victor141516/secrets/codex-telegram-sticker-bot
cd ~/codex-telegram-sticker-bot
# Copy the project here.
cp .env.example /home/victor141516/secrets/codex-telegram-sticker-bot/env
chmod 600 /home/victor141516/secrets/codex-telegram-sticker-bot/env
# BuildKit may not be available to the SSH user on Tilde.
DOCKER_BUILDKIT=0 docker compose build
docker compose up -d
docker compose logs -f --tail=100
```

Required variables:

- `TELEGRAM_BOT_TOKEN`: token issued by BotFather.
- `SESSION_SECRET`: stable random secret that allows restarts without invalidating every linked session.
- `TELEGRAM_WEBHOOK_SECRET`: random secret sent by Telegram in the webhook request header.
- `PUBLIC_BASE_URL`: public HTTPS URL that Caddy proxies to the container.

The `docker-compose.yml` file does not publish the HTTP port on the host. The service joins the external `caddywork` Docker network, and Caddy terminates HTTPS for the webhook. The `/healthz` endpoint is used from inside the container.

After configuring Caddy for `stickers.viti.site`, the process automatically registers its webhook with Telegram. Check the deployment with:

```console
docker exec caddy caddy validate --config /etc/caddy/Caddyfile
docker logs --tail=100 codex-telegram-sticker-bot
```

Before deploying, read `~/AGENTS.md` on Tilde and follow its local operating instructions. Never upload a token to the repository.
