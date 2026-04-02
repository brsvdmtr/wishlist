# Operations Runbook (Light)

Essential operational procedures for the Wishlist production environment.

**Last updated:** 2026-04-02

---

## Health Checks

| Endpoint        | Type    | Details                                              |
|-----------------|---------|------------------------------------------------------|
| `/health`       | Shallow | Simple liveness check                                |
| `/health/deep`  | Deep    | Validates DB connectivity + bot heartbeat (120s stale threshold) |

## Infrastructure

### Docker Services (4)

1. `postgres` — PostgreSQL database
2. `api` — Express + Prisma backend
3. `web` — Next.js frontend
4. `bot` — Telegram bot process

### Server Location

- Path: `/opt/wishlist` on VPS

## Deployment

```bash
cd /opt/wishlist
git pull
docker compose -f docker-compose.prod.yml up -d --build api web bot
```

Only `api`, `web`, and `bot` are rebuilt on deploy. The `postgres` service persists.

## Maintenance Mode

Set `MAINTENANCE_MODE=true` to block:

- `/tg/*` routes (Telegram bot webhooks)
- `/public/*` routes (public API)

Use during migrations, major deployments, or incidents.

## Scheduled Jobs

- **Hourly TTL cleanup**: purges expired comments and archived items older than 90 days

## Alerting

- Admin alerts sent via Telegram to chat IDs in `ADMIN_ALERT_CHAT_IDS` env var
- Covers: deep health check failures, critical errors

## Common Operations

### Full Restart

```bash
cd /opt/wishlist
docker compose -f docker-compose.prod.yml down
docker compose -f docker-compose.prod.yml up -d
```

### View Logs

```bash
docker compose -f docker-compose.prod.yml logs -f api
docker compose -f docker-compose.prod.yml logs -f web
docker compose -f docker-compose.prod.yml logs -f bot
```

### Database Access

```bash
docker compose -f docker-compose.prod.yml exec postgres psql -U <user> -d <db>
```

## Source Paths

- Health endpoints: `apps/api/src/` (health routes)
- Scheduled jobs: `apps/api/src/` (cron/scheduler)
- Docker config: `docker-compose.prod.yml`
