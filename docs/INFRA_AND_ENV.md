# INFRA_AND_ENV — Infrastructure, Environment & Deployment
> Last updated: 2026-03-26 · Branch: main
>
> **Note:** Domain is transitioning from `wishlistik.ru` to `wish.board-hub.com` `NEEDS_VERIFICATION`. Many code blocks below still reference the old domain. Update commands accordingly once the domain migration is confirmed.

## Server

| Property | Value |
|----------|-------|
| Provider | Timeweb (VPS) |
| Hostname | wish.board-hub.com `NEEDS_VERIFICATION` |
| SSH | `ssh -i ~/.ssh/timeweb_wishlist root@wish.board-hub.com` `NEEDS_VERIFICATION` |
| Project path | `/opt/wishlist` |
| OS | Debian 12 (bookworm) |
| Node.js | 20 (via Docker images) |

---

## Domain & SSL

| Property | Value |
|----------|-------|
| Domain | wish.board-hub.com `NEEDS_VERIFICATION` |
| Alt domain | www.wish.board-hub.com (redirected to non-www) `NEEDS_VERIFICATION` |
| SSL | Let's Encrypt |
| Certificate | `/etc/letsencrypt/live/wishlistik.ru/fullchain.pem` |
| Private key | `/etc/letsencrypt/live/wishlistik.ru/privkey.pem` |
| Auto-renewal | Certbot timer recommended; verify with `certbot renew --dry-run` |

---

## Nginx Configuration

**File**: `/etc/nginx/sites-enabled/wishlistik.ru`

```nginx
server {
  listen 80;
  server_name wishlistik.ru www.wishlistik.ru;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  server_name wishlistik.ru www.wishlistik.ru;

  ssl_certificate     /etc/letsencrypt/live/wishlistik.ru/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/wishlistik.ru/privkey.pem;

  location /api/ {
    client_max_body_size 30m;
    proxy_pass http://127.0.0.1:3001/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

**Key notes**:
- `/api/*` -> `http://127.0.0.1:3001/` (trailing slash strips `/api` prefix)
- `client_max_body_size 30m` for photo uploads
- WebSocket upgrade headers for Next.js HMR (dev, not needed in prod but harmless)

---

## Docker Architecture

### Services (docker-compose.prod.yml)

| Service | Image | Port | Depends On |
|---------|-------|------|------------|
| postgres | postgres:16-alpine | internal only | - |
| api | Dockerfile.api (node:20-bookworm-slim) | 3001:3001 | postgres (healthy) |
| web | Dockerfile.web (node:20-alpine) | 3000:3000 | api (started) |
| bot | Dockerfile.bot (node:20-bookworm-slim) | none | api (started) |

### Volumes

| Volume | Mount | Purpose |
|--------|-------|---------|
| wishlist_pg_data | postgres:/var/lib/postgresql/data | Database persistence |
| wishlist_uploads | api:/data/uploads | Image uploads persistence |

### Network
- `wishlist-network` (bridge driver)
- All services on same network
- Internal DNS: `postgres`, `api`, `web`, `bot`

---

## Environment Variables

### Required (Production)

| Variable | Service | Example | Description |
|----------|---------|---------|-------------|
| DATABASE_URL | api, (bot indirect) | postgresql://wishlist:PASS@postgres:5432/wishlist | PostgreSQL connection |
| POSTGRES_USER | postgres | wishlist | DB user |
| POSTGRES_PASSWORD | postgres | (secret) | DB password |
| POSTGRES_DB | postgres | wishlist | DB name |
| WEB_ORIGIN | api | https://wishlistik.ru | CORS allowed origin |
| ADMIN_KEY | api, web | (secret) | Admin auth key |
| BOT_TOKEN | api, bot | (secret) | Telegram bot token |
| SYSTEM_USER_EMAIL | api | owner@local | System user email |
| NEXT_PUBLIC_API_BASE_URL | web | https://wishlistik.ru/api | Client-side API URL |
| NEXT_PUBLIC_SITE_URL | web | https://wishlistik.ru | Site URL for links |
| NEXT_PUBLIC_BOT_USERNAME | web | WishHub_bot | Bot username for deep links |
| ADMIN_BASIC_USER | web | admin | Admin panel basic auth user |
| ADMIN_BASIC_PASS | web | (secret) | Admin panel basic auth pass |
| MINI_APP_URL | bot | https://wishlistik.ru/miniapp | Mini App URL |
| SITE_URL | bot | https://wishlistik.ru | Site URL |
| API_BASE_URL | bot | http://api:3001 | Internal API URL |

### Optional

| Variable | Service | Default | Description |
|----------|---------|---------|-------------|
| PORT | api | 3001 | API port |
| AUTH_SECRET | api | (empty) | Defined in compose for forward compatibility; not currently read by API code |
| LOG_LEVEL | api | info | Defined in compose for forward compatibility; not currently read by API code |
| UPLOAD_DIR | api | /data/uploads (Docker), ./uploads (local) | Upload directory |
| NEXT_PUBLIC_MINIAPP_SHORT_NAME | web | (empty) | Not used in current code |
| INTERNAL_API_BASE_URL | web | http://api:3001 | SSR API URL |
| MAINTENANCE_MODE | api, bot | false | Set to `true` to block all /tg/* and /public/* with 503+MAINTENANCE code |
| ONBOARDING_V2_ROLLOUT | api | 0 | Percentage (0-100) of new users who see onboarding v2 flow |
| GOD_MODE_TELEGRAM_IDS | api | (empty) | Comma-separated Telegram user IDs allowed to toggle god mode |
| ADMIN_ALERT_CHAT_IDS | api, bot | (empty) | Comma-separated Telegram chat IDs for startup/crash alerts |
| WATCHDOG_BASE_URL | watchdog | (required) | Base URL to check, e.g. `https://wishlistik.ru` |
| WATCHDOG_STATE_FILE | watchdog | /tmp/watchdog-state.json | State file for deduplicating alerts |
| WATCHDOG_TIMEOUT_MS | watchdog | 8000 | HTTP timeout for watchdog checks |

### .env.example (root) `VERIFIED_FROM_CONFIG`
Full template with all variables and comments available in `.env.example` (root of repo).
See also: [BACKUP_CHECKLIST.md](./BACKUP_CHECKLIST.md) for backup procedures.

**Production .env** is on server at `/opt/wishlist/.env`. Must be backed up separately.

---

## Build & Deploy Commands

### Local Development
```bash
# Start PostgreSQL
docker compose -f docker-compose.dev.yml up -d

# Install dependencies
pnpm install

# Generate Prisma client
pnpm db:generate

# Run migrations
pnpm db:migrate

# Seed demo data
pnpm seed

# Start all services (api + web + bot)
pnpm dev

# Start individually
pnpm dev:api    # API on port 3001
pnpm dev:web    # Web on port 3000
```

### Production Deployment
```bash
# On server:
cd /opt/wishlist
git pull origin main  # Production runs main branch

# Rebuild and restart specific service:
docker compose -f docker-compose.prod.yml up -d --build api
docker compose -f docker-compose.prod.yml up -d --build web
docker compose -f docker-compose.prod.yml up -d --build bot

# Rebuild all:
docker compose -f docker-compose.prod.yml up -d --build

# Force rebuild (no cache):
docker compose -f docker-compose.prod.yml build --no-cache api

# View logs (use `docker compose exec` to avoid hardcoded container names):
docker compose -f docker-compose.prod.yml logs --tail 50 api
docker compose -f docker-compose.prod.yml logs --tail 50 web
docker compose -f docker-compose.prod.yml logs --tail 50 bot
```

> **Note on container names**: The examples below use `wishlist-prod-api-1` etc.
> Actual names depend on the compose project name (set by directory or `-p` flag).
> Prefer `docker compose -f docker-compose.prod.yml exec <service>` over hardcoded names.

### Database Migrations `VERIFIED_FROM_CODE`

**Migrations run automatically on API container start** (non-fatal):
```
Dockerfile.api CMD:
  sh -c "npx prisma migrate deploy --schema=... 2>&1 || echo '[api] migration skipped'; exec node ..."
```
- If migration fails (DB down, permissions), API still starts
- Web and Bot containers do NOT run migrations
- Startup order: postgres (healthy) → api (runs migrations + starts) → web/bot

**Manual migration (if auto didn't run):**
```bash
docker compose -f docker-compose.prod.yml exec api \
  npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma
```

### Database Operations
```bash
# DB studio (development):
pnpm db:studio

# Direct SQL access:
docker compose -f docker-compose.prod.yml exec postgres psql -U wishlist -d wishlist
```

---

## Package Manager

- **pnpm 10.15.0** (enforced via `packageManager` field in root package.json)
- **corepack**: Used in Dockerfiles to install exact pnpm version
- **Workspace protocol**: `workspace:*` for internal deps

---

## Key Libraries

| Library | Version | Service | Purpose |
|---------|---------|---------|---------|
| express | 4.19.2 | api | HTTP server |
| prisma | 5.18.0 | db | ORM + migrations |
| @prisma/client | 5.18.0 | api, bot | Database client |
| next | 14.2.0 | web | React SSR framework |
| react | 18.2.0 | web | UI library |
| telegraf | 4.16.3 | bot | Telegram bot framework |
| sharp | ^0.34.5 | api | Image processing |
| multer | ^2.1.0 | api | File uploads |
| zod | 3.23.8 | api, shared | Schema validation |
| cors | 2.8.5 | api | CORS middleware |
| express-rate-limit | ^8.2.1 | api | Rate limiting |
| dotenv | 16.4.5 | api, bot | Env loading |
| tailwindcss | 3.4.10 | web | CSS framework (public pages only) |
| chromium | system | api | Headless browser for URL import (installed in Dockerfile.api) |

---

## CI/CD

**Current state**: NO CI/CD pipeline. Manual deployment via SSH + git pull + docker compose.

**Git branch**: Production runs `main` branch.

**GAP**: No automated tests in CI, no automated deployment, no staging environment.

---

## Background Jobs `VERIFIED_FROM_CODE`

| Job | Location | Interval | Purpose |
|-----|----------|----------|---------|
| Comment TTL cleanup | api/src/index.ts | Every 1 hour | Deletes comments with `expiresAt < now` |
| Subscription expiry | api/src/index.ts | Every 1 hour | Marks Subscription records where `currentPeriodEnd < now` as EXPIRED |
| Hint expiry | api/src/index.ts | Every 1 hour | Marks Hint records where `expiresAt < now` as EXPIRED |
| Bot heartbeat | bot/src/index.ts | Every 60 s | Upserts `ServiceHeartbeat` record so /health/deep can detect bot absence |

---

## Monitoring

### Health Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/health` | Shallow: returns `{ok:true}` if API is reachable |
| `GET /api/health/deep` | Deep: checks DB connectivity + bot heartbeat age; returns 503 if any critical check fails |

### Admin Alerts (Telegram)

Set `ADMIN_ALERT_CHAT_IDS=chatId1,chatId2` in `.env`.

Events that trigger alerts:
- API container starts → `🟢 API started`
- Bot container starts → `🟢 Bot started`
- `uncaughtException` in API or Bot → `🔴 uncaughtException`
- `unhandledRejection` in API or Bot → `🔴 unhandledRejection`
- Watchdog detects downtime → `🔴 Wishlistik DOWN`
- Watchdog detects recovery → `🟢 Wishlistik RECOVERED`

### Watchdog Script

`ops/watchdog/health-watchdog.mjs` — cron-runnable Node.js script.

**Setup on server:**
```bash
# Install cron (runs every 5 minutes):
crontab -e
# Add:
*/5 * * * * /usr/bin/node /opt/wishlist/ops/watchdog/health-watchdog.mjs >> /var/log/wishlist-watchdog.log 2>&1
```

**Required env vars** (in `.env` or exported):
- `WATCHDOG_BASE_URL=https://wishlistik.ru`
- `BOT_TOKEN=...`
- `ADMIN_ALERT_CHAT_IDS=...`

**State file**: `/tmp/watchdog-state.json` — deduplicates repeated down/recovery alerts.

### Nginx Maintenance Page

`ops/maintenance/maintenance.html` — static dark-themed page, no external dependencies.

**Setup** (one-time):
```bash
scp ops/maintenance/maintenance.html root@wishlistik.ru:/opt/wishlist/ops/maintenance/
```

Add to `/etc/nginx/sites-enabled/wishlistik.ru` (see `ops/nginx/wishlistik-maintenance.conf.snippet`):
```nginx
error_page 502 503 504 /maintenance.html;
location = /maintenance.html {
    root /opt/wishlist/ops/maintenance;
    internal;
}
# Add to each proxy location block:
proxy_intercept_errors on;
```

### Maintenance Mode

To enable planned downtime:
1. Set `MAINTENANCE_MODE=true` in `.env`
2. `docker compose -f docker-compose.prod.yml up -d api bot`

To disable:
1. Remove or set `MAINTENANCE_MODE=false`
2. `docker compose -f docker-compose.prod.yml up -d api bot`

nginx will serve the static maintenance page for 502/503/504 automatically.

---

## Dockerfile Notes

### Dockerfile.api (node:20-bookworm-slim)
- Installs chromium, chromium-sandbox via apt-get
- Sets CHROMIUM_PATH=/usr/bin/chromium
- Runs `prisma migrate deploy` before starting API
- Uses pnpm via corepack

### Dockerfile.web (node:20-alpine)
- Builds Next.js app
- Standalone output mode

### Dockerfile.bot (node:20-bookworm-slim)
- Minimal: runs compiled bot/src/index.js
- No migrations, no http server
