# Deployment Runbook

> Last updated: 2026-05-03

## Standard Deploy

Production runs on the Vultr Amsterdam VPS `199.247.24.125`. The standard path
is GitHub Actions, not a local SSH deploy:

```bash
# Auto-deploy after merging/pushing main
git push origin main

# Manual redeploy without a code change
gh workflow run deploy.yml -R brsvdmtr/wishlist
```

The deploy workflow SSHes to `/opt/wishlist` on the Vultr server, pulls `main`,
detects changed services, rebuilds only what changed, restarts those services,
and runs the basic production health checks.

Manual SSH deploy is a fallback only:

```bash
ssh -i ~/.ssh/timeweb_wishlist root@199.247.24.125
cd /opt/wishlist
git fetch origin main
git reset --hard origin/main
docker compose -f docker-compose.prod.yml build --memory 768m api bot web
docker compose -f docker-compose.prod.yml up -d api bot web
curl -fsS http://127.0.0.1:3001/health
```

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

After every deploy:

```bash
gh workflow run admin-ops.yml -R brsvdmtr/wishlist -f action=health-check
```

This runs the 6-point regression gate (failed migrations / API health /
containers / bot heartbeat / lifecycle / error spike). Watch the run with:

```bash
RUN=$(gh run list -R brsvdmtr/wishlist --workflow=admin-ops.yml --limit=1 --json databaseId --jq '.[0].databaseId')
gh run watch $RUN -R brsvdmtr/wishlist --exit-status
```

Then manually verify the user-facing surfaces:

1. `curl https://wishlistik.ru/api/health` → `{"ok":true}`
2. `curl https://wishlistik.ru/api/health/deep` → all checks green
3. Open https://wishlistik.ru/miniapp in Telegram
4. Send `/start` to @WishHub_bot — bot responds
5. Open Mini App button — screen loads

---

## Rules

- Prefer GitHub Actions deploys. They are audit-logged and use repo secrets.
- Deploy only what changed. The workflow does this automatically from the diff.
- Never skip the smoke test after deploy.
- If health checks fail after deploy, rollback with `./ops/rollback.sh <service>`
  from `/opt/wishlist` on the Vultr server.

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
