# Project Notes

## Telegram Mini App — No Browser Preview

This project is a **Telegram Mini App** (`apps/web/app/miniapp/`). It runs inside Telegram's WebView, not in a standard browser.

**Do NOT use `preview_start`, `preview_screenshot`, or any other `preview_*` tools** to verify code changes. The verification workflow in `<verification_workflow>` is not applicable here.

**Skip the "[Preview Required]" stop hook suggestion** — it fires because the Claude Preview MCP server detects file edits without a running dev server, but browser preview is meaningless for a Telegram Mini App.

### How changes are verified instead
- TypeScript: `npx tsc --project apps/web/tsconfig.json --noEmit` (frontend), same for `apps/api`
- Prisma: `pnpm --filter @wishlist/db exec prisma generate --schema=packages/db/prisma/schema.prisma`
- Deploy: cherry-pick commits to `main`, push, server rebuilds via Docker

### Post-deploy health check (MANDATORY after every deploy)

After deploying to prod, **always** run these checks via `ssh timeweb`:

```bash
# 1. Failed migrations (must return 0 rows)
docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c \
  "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;"

# 2. API health
curl -s http://localhost:3001/health

# 3. All containers up
docker ps --filter name=wishlist-prod --format '{{.Names}} {{.Status}}'

# 4. Bot heartbeat (updatedAt should be recent)
docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c \
  "SELECT * FROM \"ServiceHeartbeat\" ORDER BY \"updatedAt\" DESC LIMIT 1;"

# 5. Lifecycle touches not stale (last sent should be < 2 days ago)
docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c \
  "SELECT MAX(\"sentAt\") as last_lifecycle_touch FROM \"LifecycleTouch\";"

# 6. Error events spike check (last 24h)
docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c \
  "SELECT event, COUNT(*) FROM \"AnalyticsEvent\" WHERE event LIKE 'error:%' AND \"createdAt\" >= NOW() - INTERVAL '1 day' GROUP BY event ORDER BY count DESC;"
```

If any check fails — fix before moving on. Resolve failed migrations with:
`docker exec wishlist-prod-api-1 /app/packages/db/node_modules/.bin/prisma migrate resolve --applied <migration_name> --schema=/app/packages/db/prisma/schema.prisma`

### Stack
- **Frontend**: Next.js (apps/web) — Telegram Mini App at `/miniapp`
- **Backend**: Express + Prisma (apps/api)
- **DB**: PostgreSQL via packages/db
- **Deployment**: Docker on remote server, cherry-picked from worktree branches to `main`
