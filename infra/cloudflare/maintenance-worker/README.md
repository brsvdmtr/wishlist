# WishBoard maintenance worker

Cloudflare Worker that:

1. Serves the canonical `ops/maintenance/maintenance.html` when origin is
   unreachable from the CF edge (HTTP 5xx, connection failure).
2. Receives fire-and-forget exposure POSTs from the static stub, validates
   the Telegram `initData` HMAC, and buffers `{telegram_user_id, locale,
   chat_id, ts}` records in a KV namespace with 7-day TTL.
3. Exposes a drain endpoint (HMAC-secret guarded) for the watchdog to pull
   buffered exposures after recovery so they become regular
   `MaintenanceExposure` rows in Postgres and benefit from the existing
   `/internal/maintenance/send-recovery-notifications` fan-out.

End-to-end picture: [`docs/MAINTENANCE_FLOW.md`](../../../docs/MAINTENANCE_FLOW.md).

## Quickstart

```bash
# from repo root
pnpm install
cd infra/cloudflare/maintenance-worker

# One-time setup
pnpm run kv:create
# → paste returned id into wrangler.toml [[kv_namespaces]].id
pnpm run secret:bot-token        # paste Telegram bot token
pnpm run secret:drain            # paste a long random secret; mirror it
                                 # into /opt/wishlist/.env on prod as
                                 # CF_DRAIN_SECRET (watchdog uses it)

# Deploy
pnpm run deploy

# Smoke check
curl https://wishlistik.ru/__cf-maintenance-health
# → 200 OK
```

## Endpoints

| Path                              | When         | Purpose                                     |
|-----------------------------------|--------------|---------------------------------------------|
| `*` (HTML accept) + origin 5xx    | origin down  | Serve `maintenance.html`                    |
| `POST /__cf-maintenance-exposure` | static stub  | Validate `initData` HMAC → write KV record  |
| `GET /__cf-maintenance-drain`     | watchdog     | List + delete KV records → JSON             |
| `GET /__cf-maintenance-health`    | any time     | `200 OK` (worker liveness probe)            |
| everything else                   | always       | Pass-through to origin                      |

## Kill switch

Set `MAINTENANCE_WORKER_DISABLED = "1"` in `wrangler.toml` and redeploy. The
worker becomes a pure pass-through and never intercepts. Use during incident
debugging if the worker itself misbehaves.

To unbind the worker from routes entirely without redeploy, remove the routes
in CF dashboard (`Workers & Pages → wishlist-maintenance-worker → Triggers`).

## Local dev

```bash
pnpm run dev   # wrangler dev — local server with hot reload
pnpm run test  # vitest — HMAC unit tests + worker integration
pnpm run tail  # wrangler tail — live prod logs
```

## Files

- `src/index.ts` — fetch handler (routing, origin-failure detection, KV ops)
- `src/initdata.ts` — Telegram initData HMAC validator (Web Crypto SHA-256)
- `src/maintenance-html.generated.ts` — bundled HTML (auto-gen from ops/)
- `scripts/bundle-html.mjs` — sync script (runs on every build/test/deploy)
- `wrangler.toml` — routes, KV binding, env vars, observability
- `test/` — vitest suite

## Secret rotation

Token rotation cadence: every 6 months minimum, or immediately if compromised.

```bash
# 1. CF dashboard → API Tokens → wishlist-maintenance-worker → Roll
# 2. Update ~/.config/cloudflare/credentials with new token
# 3. No worker redeploy needed — token is only used for deployment, not runtime.
```

For runtime secrets (`BOT_TOKEN`, `CF_DRAIN_SECRET`):

```bash
wrangler secret put BOT_TOKEN
wrangler secret put CF_DRAIN_SECRET
# Bump the watchdog's CF_DRAIN_SECRET in /opt/wishlist/.env at the same time.
```
