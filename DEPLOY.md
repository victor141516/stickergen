# Despliegue en Tilde

El despliegue está preparado para Docker Compose. En el host remoto:

```console
mkdir -p ~/codex-telegram-sticker-bot
mkdir -p /home/victor141516/secrets/codex-telegram-sticker-bot
cd ~/codex-telegram-sticker-bot
# copiar aquí el proyecto
cp .env.example /home/victor141516/secrets/codex-telegram-sticker-bot/env
chmod 600 /home/victor141516/secrets/codex-telegram-sticker-bot/env
# En Tilde el builder BuildKit puede no estar disponible para el usuario SSH.
DOCKER_BUILDKIT=0 docker compose build
docker compose up -d
docker compose logs -f --tail=100
```

Variables obligatorias:

- `TELEGRAM_BOT_TOKEN`: token entregado por BotFather.
- `SESSION_SECRET`: secreto estable y aleatorio para poder reiniciar sin cerrar
  todas las sesiones enlazadas.
- `TELEGRAM_WEBHOOK_SECRET`: secreto aleatorio usado en el header que Telegram
  envía al webhook.
- `PUBLIC_BASE_URL`: URL HTTPS pública que Caddy proxyará al contenedor.

El `docker-compose.yml` no publica el puerto HTTP en el host. El servicio se
conecta a la red Docker externa `caddywork` y Caddy termina HTTPS para el
webhook; `/healthz` se utiliza desde dentro del contenedor.

Después de configurar Caddy para `stickers.viti.site`, el proceso registra el
webhook automáticamente con Telegram. Comprueba el estado con:

```console
docker exec caddy caddy validate --config /etc/caddy/Caddyfile
docker logs --tail=100 codex-telegram-sticker-bot
```

Antes de desplegar, revisar `~/AGENTS.md` en Tilde y seguir sus instrucciones
locales de operación. No se sube ningún token al repositorio.
