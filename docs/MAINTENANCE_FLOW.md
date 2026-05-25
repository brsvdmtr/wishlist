# Maintenance flow (L1 / L2 / L3)

End-to-end documentation of WishBoard's "service is down" UX and recovery
notification machinery — across the three failure layers the system
recognises.

> **TL;DR:** the user sees the same warm v2.1 maintenance UI regardless of
> *why* WishBoard is unreachable, and they receive a recovery message in the
> bot when service comes back — even when the original outage took out the
> origin server entirely (L1).

## The three layers

```
                          ┌───────────────────────────────────────────────┐
                          │            User opens Mini App                │
                          └────────────────────┬──────────────────────────┘
                                               │
                                               ▼
                          ┌───────────────────────────────────────────────┐
                          │          Cloudflare edge (POP)                │
                          │                                               │
                          │  L1 case: origin unreachable from CF          │
                          │  → maintenance worker (this repo:             │
                          │    infra/cloudflare/maintenance-worker/)      │
                          │    serves ops/maintenance/maintenance.html    │
                          │    and buffers user exposure in KV.           │
                          └────────────────────┬──────────────────────────┘
                                               │  (pass-through if origin healthy
                                               │   or non-HTML caller)
                                               ▼
                          ┌───────────────────────────────────────────────┐
                          │      Origin: nginx on Vultr Amsterdam         │
                          │                                               │
                          │  L2 case: nginx up but upstream (Next.js /    │
                          │  API) returns 5xx → nginx error_page 502/503/ │
                          │  504 serves SAME ops/maintenance/maintenance. │
                          │  html via local file root.                    │
                          └────────────────────┬──────────────────────────┘
                                               │
                                               ▼
                          ┌───────────────────────────────────────────────┐
                          │      apps/api (Express + Prisma)              │
                          │                                               │
                          │  L3 case: API healthy but in MAINTENANCE_MODE │
                          │  → /tg/* and /public/* return 503 + JSON      │
                          │  { code: 'MAINTENANCE' }. Mini App renders    │
                          │  in-app screen 'maintenance' (MiniApp.tsx).   │
                          └───────────────────────────────────────────────┘
```

## Layer responsibilities

| Layer | Trigger | Who shows the UI | Exposure path |
|-------|---------|------------------|---------------|
| **L1** | Cloudflare can't reach origin (HTTP 520-527, 502/503/504 from CF). Whole-host outage. | CF Worker `wishlist-maintenance-worker` serves bundled HTML. | Static stub fires `POST /__cf-maintenance-exposure` → CF Worker validates Telegram initData HMAC → writes KV with 7-day TTL. |
| **L2** | nginx is up, upstream Next.js or API replies 5xx. Container-level outage. | nginx `error_page 502 503 504 /maintenance.html` serves the same file from `/opt/wishlist/ops/maintenance/`. | Static stub fires the same `POST /__cf-maintenance-exposure` (CF Worker intercepts the worker-owned path even though origin is up — workers always run before origin for matched routes). |
| **L3** | API reachable but `MAINTENANCE_MODE=true`. Planned downtime. | Mini App React renders screen `'maintenance'` in `apps/web/app/miniapp/MiniApp.tsx`. | `tgFetch('/tg/maintenance-exposure', …)` writes a `MaintenanceExposure` row directly via `recordMaintenanceExposure` (no KV detour). |

The static stub (`ops/maintenance/maintenance.html`) is **bit-for-bit
identical** in both the nginx and CF Worker deployments — the worker bundles
the file at build time via `scripts/bundle-html.mjs`. If you edit one, the
other regenerates on the next `pnpm run deploy` of the worker.

## Recovery notification flow

```
  health-watchdog.mjs                            CF Worker                              API
  ─────────────────                              ─────────                              ───
  cron tick every 5 min
    │
    ▼
  probe wishlistik.ru/{,/api/health/deep,/api/tg/bootstrap}
    │
    ├── still DOWN          → write MaintenanceIncident row, send Telegram alert
    │
    └── now HEALTHY (3 consecutive ticks)
          │
          ▼
        GET /__cf-maintenance-drain ──────────── ▶  returns {records, has_more}
          │
          │                                          (records = users who
          │                                           hit L1 stub but never
          │                                           reached the API)
          ▼
        POST /internal/maintenance/ingest-buffered ──────────────────────────── ▶  upsert MaintenanceExposure rows
          │                                                                          (idempotent on incident+user+surface)
          ◀ ─ {ingestedKeys}
          │
          ▼
        DELETE /__cf-maintenance-drain ────────── ▶  KV.delete(...ingestedKeys)
          │  (loops up to CF_DRAIN_MAX_BATCHES = 10 if has_more)
          │
          ▼
        POST /internal/maintenance/send-recovery-notifications ─────────────── ▶  for each unnotified exposure:
                                                                                     bot.sendMessage(t('maintenance_recovery_text', locale))
```

## Failure modes

**Worker bug.** Set `MAINTENANCE_WORKER_DISABLED=1` in `wrangler.toml` and run
`pnpm run deploy`. Worker becomes a pure pass-through; CF default 5xx pages
return for outages but nothing else is affected. Faster: unbind the routes in
CF dashboard (`Workers & Pages → wishlist-maintenance-worker → Triggers →
Delete`).

**Watchdog crashes between drain and ingest.** Records have been returned by
the drain endpoint but not yet ingested. They remain in KV (we don't delete
until ingest acknowledges). Next watchdog tick re-pulls and re-ingests. Ingest
is idempotent (`@@unique([incidentId, userId, surface])` on
`MaintenanceExposure`), so no duplicate notifications. Worst case: a record
sits in KV until the 7-day TTL.

**Ingest succeeds, DELETE fails.** Records were ingested but their KV keys
weren't cleaned up. Next watchdog tick re-pulls + re-ingests + re-deletes.
Idempotent upsert means the same `MaintenanceExposure` row is touched, no new
notification fires.

**CF_DRAIN_SECRET mismatch.** Watchdog gets 403 from drain, logs the error,
proceeds to send notifications anyway (using whatever `MaintenanceExposure`
rows already exist from L2/L3). L1 users for that incident are not notified.
Audit env var on prod and the worker secret.

**User not in DB.** Buffered KV record references `telegramId` that's not in
`User`. Ingest skips them but still ACKs the KV key (to avoid infinite retry
of the same orphaned record). Should be vanishingly rare — to have valid
initData a user must have opened the bot at least once.

## Configuration

### CF Worker secrets (set via `wrangler secret put`)

| Secret | What | Where mirrored |
|--------|------|----------------|
| `BOT_TOKEN` | Telegram bot token (HMAC verifier) | `/opt/wishlist/.env` (`BOT_TOKEN`) |
| `CF_DRAIN_SECRET` | Watchdog ↔ worker shared secret | `/opt/wishlist/.env` (`CF_DRAIN_SECRET`) |

### Worker vars (in `wrangler.toml`)

- `ORIGIN_HOST = "wishlistik.ru"` — for logging.
- `MAINTENANCE_WORKER_DISABLED = "0"` — kill switch (`"1"` = pass-through).

### KV namespace

- Binding: `MAINTENANCE_EXPOSURES`
- ID: see `infra/cloudflare/maintenance-worker/wrangler.toml`
- Key pattern: `exposure:<UTC-date>:<telegram_user_id>` (one record per user per day; same-day duplicates collapse)
- Value: `{ tg_user_id, chat_id, locale, surface, ts }`
- TTL: 7 days

### `/opt/wishlist/.env` (prod)

```
BOT_TOKEN=...              # already present
CF_DRAIN_SECRET=...        # NEW — same value as `wrangler secret put CF_DRAIN_SECRET`
```

## Operator runbook

### Smoke-tests after worker deploy

```bash
# Worker health
curl https://wishlistik.ru/__cf-maintenance-health
# → 200 ok

# Drain auth
curl -i https://wishlistik.ru/__cf-maintenance-drain
# → 403 (no secret)

curl -s -H "x-drain-secret: $CF_DRAIN_SECRET" https://wishlistik.ru/__cf-maintenance-drain
# → 200 {"ok":true,"count":0,"records":[]}

# Origin pass-through (non-maintenance time)
curl -s https://wishlistik.ru/api/health
# → {"ok":true,"maintenance":false,...}
```

### Verifying a recovery cycle (manual fire-drill)

```bash
# 1. Inject a fake exposure record into KV
wrangler kv key put --binding MAINTENANCE_EXPOSURES \
  "exposure:$(date -u +%Y-%m-%d):999999" \
  '{"tg_user_id":999999,"chat_id":999999,"locale":"ru","surface":"static","ts":"2026-05-25T00:00:00Z"}'

# 2. Run the watchdog one shot
ssh vultr 'sudo -u www-data /opt/wishlist/ops/watchdog/run-health-watchdog.sh'

# 3. Watchdog log will show:
#    [watchdog] CF drain: 1 drained, 0 ingested, 1 skipped in 1 batch(es)
# (skipped because user 999999 doesn't exist; key gets ACKed and deleted)

# 4. Verify KV is empty
wrangler kv key list --binding MAINTENANCE_EXPOSURES | jq '.[] | .name'
```

### Rotating the drain secret

```bash
# 1. Generate new secret
NEW=$(openssl rand -base64 36 | tr -d '\n=/+ ' | head -c 44)

# 2. Update worker
echo -n "$NEW" | wrangler secret put CF_DRAIN_SECRET

# 3. Update prod .env (atomic)
ssh vultr "sudo sed -i 's|^CF_DRAIN_SECRET=.*|CF_DRAIN_SECRET=$NEW|' /opt/wishlist/.env"

# 4. Next watchdog cron tick picks up the new value — no service restart needed.
```

### Rotating the Cloudflare API token

```bash
# CF Dashboard → API Tokens → wishlist-maintenance-worker → Roll
# Save the new token in ~/.config/cloudflare/credentials
# No worker redeploy needed — the token is only used by `wrangler deploy` from
# operator machines / CI, not by the worker runtime.
```

## File map

- `ops/maintenance/maintenance.html` — canonical static stub (nginx + CF)
- `ops/vultr/nginx-wishlistik.conf.template` — nginx `error_page` wiring
- `ops/watchdog/health-watchdog.mjs` — recovery flow (drain + ingest + notify)
- `ops/watchdog/README.md` — watchdog operator guide
- `infra/cloudflare/maintenance-worker/` — CF Worker package
- `apps/web/app/miniapp/MiniApp.tsx` — in-app L3 screen `'maintenance'`
- `apps/api/src/routes/maintenance.routes.ts` — L3 exposure POST endpoint
- `apps/api/src/routes/internal.routes.ts` — recovery/ingest/check endpoints
- `apps/api/src/index.ts` — `recordMaintenanceExposure` helper (single source of truth for exposure upsert)
- `packages/shared/src/i18n.ts` — `maintenance_*` + `bot_maintenance` + `maintenance_recovery_*` strings
- `packages/db/prisma/schema.prisma` — `MaintenanceIncident` + `MaintenanceExposure` models
- `docs/design-system/mockups/approved/maintenance-{stub,screen}-v2.1.html` — design source
- `docs/design-system/DESIGN_DECISIONS.md` — 2026-05-25 entry approving v2.1 maintenance UX
