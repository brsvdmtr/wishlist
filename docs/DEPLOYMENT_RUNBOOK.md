# Deployment Runbook

> Last updated: 2026-04-02

## Standard Deploy

```bash
ssh timeweb
cd /opt/wishlist
git pull origin main

# Deploy one service
./ops/deploy.sh bot
./ops/deploy.sh api
./ops/deploy.sh web

# Deploy multiple
./ops/deploy.sh api web

# Deploy everything
./ops/deploy.sh all
```

The deploy script handles: build, restart, health checks, maintenance mode, and success recording.

---

## What `deploy.sh` Does

1. Validates `.env` exists, records current commit SHA
2. For api/web: enables `MAINTENANCE_MODE=true` (suppresses watchdog alerts)
3. `docker compose build <services>`
4. `docker compose up -d <services>`
5. Waits for containers to start (10s)
6. Prints container status and recent logs
7. Checks `/api/health` (200?)
8. For bot: waits 75s for heartbeat to propagate
9. Checks `/api/health/deep` (200? bot heartbeat fresh?)
10. For api/web: disables `MAINTENANCE_MODE`
11. Records SHA in `.deploy/last-successful-release`
12. Prints success summary

If any health check fails, the script exits non-zero and **does not disable maintenance mode** — investigate manually before lifting it.

---

## Rollback

```bash
cd /opt/wishlist
./ops/rollback.sh bot
./ops/rollback.sh api
./ops/rollback.sh all
```

Reads `.deploy/last-successful-release`, checks out that commit's code, rebuilds, deploys, runs health checks, then returns the repo to `main`.

After rollback: fix the issue on `main`, then deploy again normally.

---

## Maintenance Mode

```bash
# Enable (suppresses watchdog alerts during planned work)
./ops/maintenance/on.sh

# Disable
./ops/maintenance/off.sh
```

`MAINTENANCE_MODE=true` does two things:
- API returns 503 for `/tg/*` and `/public/*` endpoints
- Watchdog skips alerting

Health endpoints (`/health`, `/health/deep`) and uploads remain available.

Nginx separately serves `maintenance.html` on 502/503/504 — this is automatic during container restarts.

---

## Post-Deploy Smoke Test

After every deploy, manually verify:

1. `curl https://wishlistik.ru/api/health` → `{"ok":true}`
2. `curl https://wishlistik.ru/api/health/deep` → all checks green
3. Open https://wishlistik.ru/miniapp in Telegram
4. Send `/start` to @WishHub_bot — bot responds
5. Open Mini App button — screen loads

---

## Rules

- **Always use `./ops/deploy.sh`**, not raw `docker compose up -d --build`
- Deploy only what changed: `./ops/deploy.sh bot`, not `./ops/deploy.sh all`
- Never skip the smoke test after deploy
- If health checks fail after deploy, rollback: `./ops/rollback.sh <service>`

---

## Key Files

| File | Purpose |
|------|---------|
| `ops/deploy.sh` | Standard deploy with health checks |
| `ops/rollback.sh` | Rollback to last successful release |
| `ops/maintenance/on.sh` | Enable maintenance mode |
| `ops/maintenance/off.sh` | Disable maintenance mode |
| `.deploy/last-successful-release` | SHA of last known-good deploy |
| `.deploy/last-attempted-release` | SHA of last attempted deploy |
| `ops/backup.sh` | Daily backup (pg_dump + uploads + .env) |
| `ops/watchdog/health-watchdog.mjs` | Deep health monitoring every 5 min |

---

## Cron Jobs (Production)

```
*/5 * * * *  node /opt/wishlist/ops/watchdog/health-watchdog.mjs >> /var/log/watchdog.log 2>&1
0 3 * * *    /opt/wishlist/ops/backup.sh >> /var/log/wishlist-backup.log 2>&1
0 4 * * 0    docker system prune -af --filter "until=168h" >> /var/log/docker-prune.log 2>&1
```
