# INFRA_AND_ENV — Infrastructure, Environment & Deployment
> Last updated: 2026-05-07 · Branch: main
>

## Server

| Property | Value |
|----------|-------|
| Provider | Vultr (Amsterdam VPS) |
| Hostname | `wishboard-bot-vultr-ams-1` |
| Public IP | `199.247.24.125` |
| SSH | `ssh vultr` (alias in `~/.ssh/config`); equivalent to `ssh -i ~/.ssh/vultr_wishlist root@199.247.24.125` |
| Project path | `/opt/wishlist` |
| OS | Debian 12 (bookworm) |
| Node.js | 20 in Docker images; host Node 18 for watchdog cron |

---

## Domain & SSL

| Property | Value |
|----------|-------|
| Domain | wishlistik.ru |
| Alt domain | www.wishlistik.ru (redirected to non-www) |
| SSL | Let's Encrypt (issued Apr 17 2026, expires Jul 16 2026) |
| Certificate | `/etc/letsencrypt/live/wishlistik.ru/fullchain.pem` |
| Private key | `/etc/letsencrypt/live/wishlistik.ru/privkey.pem` |
| Auto-renewal | **NOT YET CONFIGURED ON VULTR** — see [KNOWN_GAPS_AND_RISKS.md](./KNOWN_GAPS_AND_RISKS.md) #28. Action required before ~2026-07-16: `apt-get install certbot python3-certbot-nginx && certbot --nginx -d wishlistik.ru -d www.wishlistik.ru`, then verify `certbot renew --dry-run` and `systemctl is-active certbot.timer`. |

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
| api | Dockerfile.api (node:20-bookworm-slim) | `127.0.0.1:3001` only | postgres (healthy) |
| web | Dockerfile.web (node:20-alpine) | `127.0.0.1:3000` only | api (started) |
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

## Logging, Cleanup & Retention

> Last hardened: 2026-05-07. Source-of-truth files: `docker-compose.prod.yml`
> (logging anchor), `ops/logrotate/wishlist-ops`, `ops/cron/root.crontab`.

### Logging architecture

Every service writes to **two** destinations simultaneously:

1. **Container stdout → Docker `json-file`** with a per-container cap of
   `max-size: 20m × max-file: 5` (~100 MB rolling window). File at
   `/var/lib/docker/containers/<id>/<id>-json.log{,.N}`.
   **Wiped on container recreate** (e.g. `docker compose up -d` after a build).
2. **Bind-mounted file on host** (api/bot only) at
   `/opt/wishlist/logs/<service>/`. **Survives recreate.**

Per-service durability table:

| Service | Bind mount | In-process rotation | Durable across recreate? |
|---------|-----------|---------------------|--------------------------|
| api | `./logs/api:/app/logs` | pino-roll, daily, 100 MB cap, 14-file retention | ✅ via host file |
| bot | `./logs/bot:/app/logs` | pino multistream, no rotation (intentional, see `apps/bot/src/logger.ts` — pino-roll worker stalled mid-rollover on 2026-05-02) | ✅ via host file (single growing `bot.log` ~50 KB/day) |
| web | none | none | ❌ — only the rolling Docker window |
| postgres | none | none | ❌ — only the rolling Docker window |

The Docker cap is set in `docker-compose.prod.yml` via a single YAML anchor
(`x-logging: &default-logging`) that all four services reference. To change
the cap, edit the anchor only.

### Verify the logging cap is applied

```bash
docker inspect $(docker ps -q) \
  --format='{{.Name}} | {{.HostConfig.LogConfig.Type}} | {{json .HostConfig.LogConfig.Config}}'
# Expect for every container:
#   json-file | {"max-file":"5","max-size":"20m"}
```

If postgres still shows `{}`, recreate it once with
`docker compose -f /opt/wishlist/docker-compose.prod.yml up -d postgres` —
GitHub Actions doesn't rebuild postgres on its own (public image, source
unchanged), so the first `up -d` after the compose change must be done by
hand.

### Read logs

```bash
# Durable (api/bot) — survives every redeploy
ls -lah /opt/wishlist/logs/api/
ls -lah /opt/wishlist/logs/bot/

# Errors only on a specific day
jq -c 'select(.level >= 50)' /opt/wishlist/logs/api/api.log.YYYY-MM-DD.1 | head

# Hourly idempotency cleanup events
jq -c 'select(.event=="api.idempotency_cleanup_completed")' \
  /opt/wishlist/logs/api/api.log.YYYY-MM-DD.1

# Rolling-only (web/postgres) — limited to the current container lifetime
docker compose -f /opt/wishlist/docker-compose.prod.yml logs --since=24h web
docker compose -f /opt/wishlist/docker-compose.prod.yml logs --since=72h postgres
```

### Incident investigation after a redeploy

1. **api** — `/opt/wishlist/logs/api/api.log.YYYY-MM-DD.1` (full continuous file). ✅
2. **bot** — `/opt/wishlist/logs/bot/bot.log` (single accumulating file). ✅
3. **web** — only `docker compose logs web` from the current container's lifetime. ⚠️ Lost on recreate.
4. **postgres** — only `docker compose logs postgres`. ⚠️ Lost on recreate.
5. **nginx (host-level)** — `/var/log/nginx/access.log{,.1}` and `error.log{,.1}`, weekly logrotate, 4 generations.

**Remaining gap (not closed in 2026-05-07 hardening):** web and postgres
have no durable archive outside the running container. Acceptable as long
as nginx covers user-visible 5xx and Prisma surfaces pg errors into the
api log. **Do not redeploy web during an active incident** — first capture
`docker compose logs web` to a file, then redeploy. Long-term fix when it's
time: ship to a centralized logging stack (Loki/Promtail or Vector). Not
in scope of this hardening — see `docs/KNOWN_GAPS_AND_RISKS.md`.

### Host-level logrotate for ops logs

Three append-only files written by the root crontab grow unbounded
otherwise:
- `/var/log/watchdog.log` — every 5 min (~25 MB/year)
- `/var/log/wishlist-backup.log` — daily
- `/var/log/docker-prune.log` — weekly

Config lives at `/etc/logrotate.d/wishlist-ops`, source-of-truth at
`ops/logrotate/wishlist-ops` in the repo (weekly · 8 rotations · gzip ·
delaycompress · copytruncate · missingok · notifempty).

**Install (one-time on prod host):**
```bash
sudo cp /opt/wishlist/ops/logrotate/wishlist-ops /etc/logrotate.d/wishlist-ops
sudo chmod 0644 /etc/logrotate.d/wishlist-ops
sudo logrotate -d /etc/logrotate.d/wishlist-ops    # dry-run; safe
```

`copytruncate` is required because cron writes via shell append (`>> file`)
which keeps an open fd; default rename-based rotation would orphan it.

### Disk cleanup (cron)

Cron is host-level. Source-of-truth in repo at `ops/cron/root.crontab`.

| Cadence | Job | What it does |
|---------|-----|--------------|
| `*/5 * * * *` | `ops/watchdog/health-watchdog.mjs` | Pings `/api/health/deep`, alerts via Telegram bot. State at `/var/lib/wishlist/watchdog/state.json`. |
| `0 3 * * *` | `ops/backup.sh` | Dumps DB + uploads + .env, gzips, sha256, uploads to `wishlist-s3`. Local 14d / S3 30d retention. |
| `0 4 * * 0` | `docker system prune -af --filter "until=72h"` | Removes stopped containers, dangling images, build-cache items >72 h. **Never** uses `--volumes`. |

**Apply / re-sync the crontab from the repo file:**
```bash
sudo crontab -l > /tmp/cron.bak.$(date +%Y%m%d-%H%M%S)
sudo crontab /opt/wishlist/ops/cron/root.crontab
sudo crontab -l       # verify
diff -u /tmp/cron.bak.* <(sudo crontab -l)
```

### Disk-space sanity checks

```bash
df -h /                                                # root disk (alert >80%)
docker system df                                       # images, containers, volumes, cache
du -sh /var/lib/containerd/io.containerd.snapshotter.v1.overlayfs  # build cache
du -sh /opt/backups/wishlist /opt/wishlist/logs        # backup + app logs

ls -lh /var/log/{watchdog,wishlist-backup,docker-prune}.log
```

### Forbidden commands

Never run on prod without an explicit go-ahead:

```bash
docker system prune --volumes ...    # destroys named volumes (DB, uploads)
docker volume prune                  # same
docker volume rm wishlist-prod_*     # same
docker compose down --volumes        # same
```

These would erase `wishlist_pg_data` (the database) and
`wishlist_uploads` (user-uploaded images). The weekly cron prune is
explicitly scoped with no `--volumes`.

### Backup verification

Daily smoke test (read-only):

```bash
# Latest backup, local + S3
ls -lh /opt/backups/wishlist/ | tail
rclone size wishlist-s3:wishlist-backups
rclone ls   wishlist-s3:wishlist-backups | sort -k1 -n | tail -5

# Integrity of the most recent local
LATEST=$(ls -t /opt/backups/wishlist/wishlist_*.tar.gz | head -1)
gzip -t "$LATEST" && echo "gzip OK"
(cd /opt/backups/wishlist && sha256sum -c "$(basename "$LATEST").sha256")

# Restore-readiness — read pg_dump TOC without touching the live DB
TMP=$(mktemp -d)
tar -xzf "$LATEST" -C "$TMP" ./db.dump
docker run --rm -v "$TMP:/work" postgres:16-alpine pg_restore -l /work/db.dump | head
rm -rf "$TMP"
```

For full restore procedure see [DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md)
and [MASTER_RESTORE_GUIDE.md](./MASTER_RESTORE_GUIDE.md).

### Rollback for the compose logging change

If the cap ever bites (e.g. you suspect logs being truncated mid-incident),
the `x-logging` anchor in `docker-compose.prod.yml` is a one-line knob:

```yaml
# Bump or relax — both safe, no service restart needed beyond up -d:
x-logging: &default-logging
  driver: json-file
  options:
    max-size: "100m"   # was 20m
    max-file: "10"     # was 5
```

To fully revert, delete the `x-logging` anchor and the four `logging: *default-logging` lines, then `docker compose -f /opt/wishlist/docker-compose.prod.yml up -d` (each affected service recreates with no logging cap, matching pre-hardening default).

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
| ONBOARDING_V2_ROLLOUT | api | ab50 | Percentage (0-100) of new users who see onboarding v2 flow |
| GOD_MODE_TELEGRAM_IDS | api | (empty) | Comma-separated Telegram user IDs allowed to toggle god mode |
| ADMIN_ALERT_CHAT_IDS | api, bot | (empty) | Comma-separated Telegram chat IDs for startup/crash alerts |
| MARKETPLACE_PARSER_DISABLED | api | (empty) | Set to `1` to disable the marketplace orchestrator and route all marketplace URLs through the legacy parser |
| NEXT_TELEMETRY_DISABLED | web | 1 | Disables Next.js anonymous telemetry collection |
| WATCHDOG_BASE_URL | watchdog | (required) | Base URL to check, e.g. `https://wishlistik.ru` |
| WATCHDOG_STATE_FILE | watchdog | /var/lib/wishlist/watchdog/state.json | State file for deduplicating alerts |
| WATCHDOG_TIMEOUT_MS | watchdog | 15000 | HTTP timeout for watchdog checks (bumped from 8000 after 2026-05-17 DNS-flap false alert) |
| WATCHDOG_LOCK_FILE | watchdog | /var/lock/wishlist-watchdog.lock | Non-blocking flock lock file used by `run-health-watchdog.sh` |
| WATCHDOG_REQUIRE_FLOCK | watchdog | true | Fail-closed if `flock(1)` is missing; only literal `false` allows unguarded dev fallback |
| WATCHDOG_NODE_BIN | watchdog | node | Node executable used by `run-health-watchdog.sh` wrapper; override only for tests / dev sandboxes |
| DNS_RESULT_ORDER | api | ipv4first | Node DNS order; Vultr uses IPv4 to Telegram from Docker |
| RCLONE_REMOTE | backup | wishlist-s3:wishlist-backups | Selectel/S3 backup target |

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

Use GitHub Actions as the normal deployment path. The `deploy.yml` workflow SSHes
to the Vultr server from repo secrets and rebuilds only changed services.

```bash
# Auto-deploy after merging/pushing main
git push origin main

# Manual redeploy without a code change
gh workflow run deploy.yml -R brsvdmtr/wishlist
```

Manual server deploy is a fallback only:

```bash
ssh -i ~/.ssh/vultr_wishlist root@199.247.24.125
cd /opt/wishlist
git fetch origin main
git reset --hard origin/main
docker compose -f docker-compose.prod.yml build --memory 768m api bot web
docker compose -f docker-compose.prod.yml up -d api bot web
curl -fsS http://127.0.0.1:3001/health
```

**Rollback** (to last successful release):
```bash
./ops/rollback.sh bot
./ops/rollback.sh api web
./ops/rollback.sh all
```

**View logs:**
```bash
docker compose -f docker-compose.prod.yml logs --tail 50 api
docker compose -f docker-compose.prod.yml logs --tail 50 web
docker compose -f docker-compose.prod.yml logs --tail 50 bot
```

> **Note on container names**: Actual names depend on the compose project name (set by directory or `-p` flag).
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

**Current state**: GitHub Actions is the primary deploy/ops path. Manual SSH is fallback only.

| Workflow | Trigger | Purpose |
|---------|---------|---------|
| `.github/workflows/deploy.yml` | push to `main` (or manual `workflow_dispatch`) | Selective rebuild on Vultr — only services whose source actually changed; runs basic prod health checks |
| `.github/workflows/admin-ops.yml` | manual `workflow_dispatch` | Day-to-day ops: `health-check`, `tail-logs`, `watch-logs`, `restart-service`, `run-sql`, `download-file`, `upload-file`, `exec-shell`, `resolve-migration`, `edit-env-var`, referral-specific actions |
| `.github/workflows/doc-guard.yml` | PR | Documentation-link sanity |
| `.github/workflows/referral-monitor.yml` | scheduled | Referral funnel monitoring |
| `.github/workflows/ssh-test.yml` | manual | SSH credential smoke test |

**Production server**: Vultr Amsterdam VPS `199.247.24.125`. Workflow secrets `SSH_HOST`, `SSH_USER`, `SSH_KEY` point at Vultr.

**Standard deploy**: `git push origin main`. Selective rebuild detects changes by path:
- `apps/api/** | packages/db/** | packages/shared/** | pnpm-lock.yaml | Dockerfile.api` → api
- `apps/bot/** | packages/db/** | packages/shared/** | pnpm-lock.yaml | Dockerfile.bot` → bot
- `apps/web/** | packages/shared/** | pnpm-lock.yaml | Dockerfile.web` → web
- `docker-compose.prod.yml` → all three
- `.github/**`, docs-only → no rebuild (~3s)

**Post-deploy** (mandatory): `gh workflow run admin-ops.yml -R brsvdmtr/wishlist -f action=health-check` runs the 6-point regression gate (failed migrations / API health / containers / bot heartbeat / lifecycle / error spike).

**Git branch**: Production runs `main`.

**Gaps that remain**: no automated test suite in CI beyond a few unit tests; no staging environment.

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

`ops/watchdog/health-watchdog.mjs` — cron-runnable Node.js script, invoked
via the flock wrapper `ops/watchdog/run-health-watchdog.sh` so two cron
ticks can never race on the state file.

**Setup on server:**
```bash
# Install cron (runs every 5 minutes):
crontab -e
# Add (matches the production crontab on Vultr):
*/5 * * * * /opt/wishlist/ops/watchdog/run-health-watchdog.sh >> /var/log/watchdog.log 2>&1
```

The wrapper takes a non-blocking `flock -n` on `WATCHDOG_LOCK_FILE`
(default `/var/lock/wishlist-watchdog.lock`). If the previous tick is
still running, the new invocation exits cleanly with `exit 0` and a log
line — no queueing, no false incident.

`WATCHDOG_REQUIRE_FLOCK` is `true` by default: if `flock(1)` is not on
`PATH`, the wrapper refuses to run (`exit 2`) instead of silently
degrading to an unguarded execution. Only the literal value `false`
opts out — intended for dev/macOS hosts without `util-linux`.

**Required env vars** (in `.env` or exported):
- `WATCHDOG_BASE_URL=https://wishlistik.ru`
- `BOT_TOKEN=...`
- `ADMIN_ALERT_CHAT_IDS=...`

**State file**: `/var/lib/wishlist/watchdog/state.json` — deduplicates repeated down/recovery alerts. Lives in a dedicated private directory `/var/lib/wishlist/watchdog/` (mode 0700, file 0600). The watchdog no longer uses `/tmp` as default, and it does NOT chmod the shared parent `/var/lib/wishlist/`. Legacy paths `/var/lib/wishlist/watchdog-state.json` and `/tmp/watchdog-state.json` are read once as fallback/migration if the new file is missing — the next save then writes to the new location; legacy files are not deleted.

### Nginx Maintenance Page

`ops/maintenance/maintenance.html` — static dark-themed page, no external dependencies.

**Setup** (one-time):
```bash
scp -i ~/.ssh/vultr_wishlist ops/maintenance/maintenance.html \
  root@199.247.24.125:/opt/wishlist/ops/maintenance/
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

```bash
# Enable (suppresses watchdog alerts, blocks /tg/* and /public/* with 503):
./ops/maintenance/on.sh

# Disable:
./ops/maintenance/off.sh
```

> `deploy.sh` manages maintenance mode automatically for api/web deploys.
> Manual use only needed for planned work outside of deployments.

nginx will serve the static maintenance page for 502/503/504 automatically.

---

## Observability Environment Variables

| Variable | Used by | Default | Description |
|----------|---------|---------|-------------|
| `LOG_LEVEL` | api, bot | `info` | Pino log level (trace/debug/info/warn/error/fatal) |
| `LOG_PRETTY` | api, bot | `false` | Human-readable log output (dev only) |
| `APP_RELEASE` | api, bot, web | `unknown` | Git SHA or version tag for release tracking |
| `GLITCHTIP_DSN` | api, bot | — | GlitchTip/Sentry DSN for server-side error tracking |
| `GLITCHTIP_ENVIRONMENT` | api, bot | `production` | Environment tag for error reports |
| `NEXT_PUBLIC_GLITCHTIP_DSN` | web | — | GlitchTip DSN for frontend error tracking |
| `ENABLE_ERROR_TRACKING` | api, bot | `false` | Master switch for error tracking |
| `DAILY_REPORT_HOUR` | cron | `9` | UTC hour for daily digest delivery |
| `GRAFANA_ADMIN_PASSWORD` | grafana | `wishboard` | Admin password for Grafana UI |

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
