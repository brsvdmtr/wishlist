# WishBoard API — Security Layer

Idempotency keys, rate limits, and IP throttling for the Wishlist Mini App.

**Last updated:** 2026-04-27 · **Wave:** 1 (P0)

---

## 1. Security model

The security layer protects against three classes of misuse — none of them
authentication. Telegram `initData` validation in `requireTelegramAuth`
remains the **only** authentication mechanism on `/tg/*`; this layer sits on
top of it.

| Threat | Defence |
|---|---|
| Double-tap on a button creates two wishes / charges two payments | **Idempotency-Key** — same key + same body returns the cached response |
| User taps "Buy" 5 times during a Telegram flow → 5 invoices, 5 Stars charges | **Idempotency-Key** + **rate limit** on `payment` category |
| Retry storm after a 502 / network blip floods the API | **Idempotency-Key** holds a lock; **rate limit** caps per-actor |
| Scraper or attacker probes `/tg/bootstrap` with bad initData | **IP throttle** on `auth_rejected` trips after 10 failures / minute |
| Comment / wish title spam from one account | **Rate limit** category-by-category (comments: 10/min, 50/h) |

**Out of scope for this layer**

- Authentication (`requireTelegramAuth` already validates initData HMAC).
- Authorisation / row-level access (per-route business logic).
- Input validation (`zod` schemas already in place).
- Anti-fraud for referrals (separate `packages/db/referral.ts` system).

---

## 2. Idempotency-Key

### Header & validation

- **Header:** `Idempotency-Key: <16–128 chars, [A-Za-z0-9_-]>` (case-insensitive).
- Generated client-side via `crypto.randomUUID()`; fallback `idem_<base36ts>_<rand>`.
- **Methods:** only POST, PATCH, DELETE. GET / HEAD / OPTIONS ignore the header.
- Malformed key → `400 INVALID_IDEMPOTENCY_KEY` (key cleared client-side).

### Soft-require policy

A missing `Idempotency-Key` header **never blocks** a request. The middleware
short-circuits to `next()` — exactly what an old cached Mini App version (or
the bot's internal calls) sees. This is by design — the rollout cannot
self-DOS by 400-ing all clients that don't yet send the header.

For **critical endpoints** (`billing/*`, `account.delete`) the absence is
logged as `api.idem_missing_on_critical_endpoint` so adoption can be
monitored, but the request still runs.

### Storage

One `IdempotencyKey` row per `(key, actorKey, method, path)`. The unique
index serialises concurrent first-arrivers; one wins, others fall through to
the existing-row branch via `P2002` catch.

- `path` = stable route pattern (e.g. `POST /tg/wishlists/:id/items`)
- `requestHash` = `sha256(method | originalUrl | actorKey | stableJSON(body) | stableJSON(query))`
  — `originalUrl` carries literal `:id` values, so reusing a key across
  different items trips conflict instead of replaying a stale response.
- `actorKey` — `tgActorHash` UUID for auth'd users; `ip:<hash>` for unauth
  (kept non-null because Postgres composite-unique whereUnique inputs can't
  carry NULLs).
- Volatile body fields are stripped before hashing — see
  [`packages/shared`](../apps/api/src/security/types.ts) `VOLATILE_BODY_FIELDS`:
  `clientEventId`, `__retryAttempt`, `__telemetry`, `clientTimestamp`,
  `localTimestamp`, `traceId`, `requestId`, `analyticsSessionId`,
  `bootSessionId`. Adding telemetry fields to a body never invalidates idempotency.

### TTL

| Endpoint class | TTL |
|---|---|
| Billing / Stars / Telegram payments | **7 days** |
| Everything else | **24 hours** |

Expired rows are purged hourly by `startIdempotencyCleanupJob`.

### Lock states

| State | What happens on a re-request with same key |
|---|---|
| `processing` + `lockedUntil > now` | **409 `IDEMPOTENCY_REQUEST_IN_PROGRESS`** + `Retry-After: 5`. Client keeps the key. |
| `processing` + `lockedUntil <= now` | **409 `IDEMPOTENCY_KEY_STALE`**. Client must mint a new key — we never auto-take-over a possibly-still-running handler. |
| `completed` + same `requestHash` | Replay: `responseStatus` + cached `responseBody` + `Content-Type: application/json` + `X-Idempotent-Replay: 1`. **No** Set-Cookie, no Location, no other headers from the original response. |
| `completed` + different `requestHash` | **409 `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST`**. Client bug — key is cleared client-side and logged. |
| `completed` + `responseTruncated=true` (multipart or >64 KB body) | **409 `IDEMPOTENCY_RESPONSE_NOT_REPLAYABLE`**. Client should verify state (re-fetch) and proceed. |
| `failed` (5xx) + `lockedUntil > now` (cooldown 5 min) | **409 `IDEMPOTENCY_FAILED_RECENTLY`** + `Retry-After: <sec>`. Server-side breather to avoid hammering a flaky downstream. |
| `failed` + `lockedUntil <= now` | Take over: row → `processing`, log `api.idempotency_retry_after_failed`, run handler. |

### Multipart / large responses

`POST /me/profile/avatar`, `POST /me/showcase/cover`, `POST /items/:id/photo`
opt out via `noResponseReplay: true`. The middleware still locks the key
(prevents double-execution), but stores `responseBody = null`. Replay returns
`409 IDEMPOTENCY_RESPONSE_NOT_REPLAYABLE`. Same path is taken for any
response > 64 KB (`responseTruncated = true`).

### Failure modes (fail-open)

If the `IdempotencyKey` table itself becomes unavailable (DB down, schema
out of sync mid-deploy, etc.), the middleware logs `api.idempotency_db_error`
and **passes the request through unprotected**. Better to lose idempotency
for 30 seconds than to 5xx every legitimate POST during an outage.

---

## 3. Protected endpoints — Wave 1

Wave 1 covers all P0 state-changing endpoints. ~70 routes, all on `tgRouter`.

### Wishlists / items / placements

`POST /wishlists`, `PATCH/DELETE /wishlists/:id`,
`POST /wishlists/:id/{archive,unarchive,transfer-items}`, `POST /wishlists/reorder`,
`POST /wishlists/:id/items`, `PATCH/DELETE /items/:id`,
`POST /items/:id/{complete,restore}`, `POST/DELETE /items/:id/photo`,
`POST/DELETE /items/:id/placements[/:wishlistId]`

### Bulk item actions

`POST /items/bulk-{move,delete,archive,restore,copy,hard-delete}`

### Reservations

`POST /items/:id/{reserve,unreserve,secret-reserve,extend-reservation}`,
`POST /secret-reservations/:id/{cancel,acknowledge,promote}`,
`PATCH /reservations/:itemId/meta`,
`POST/DELETE /reservations/:itemId/reminder`

### Comments

`POST /items/:id/comments` (replies via `parentCommentId` in body),
`DELETE /items/:id/comments/:commentId`

### Share / selections / subscribe

`POST/DELETE /wishlists/:id/share-token`,
`POST /wishlists/:id/selections`, `DELETE /selections/:id`,
`POST/DELETE /selections/:id/subscribe`,
`POST/DELETE /wishlists/:id/subscribe`

### Billing / Telegram Stars (TTL = 7 days, `critical = true`)

`POST /billing/pro/{checkout,sync}`,
`POST /billing/subscription/{cancel,reactivate}`,
`POST /billing/addon/{checkout,sync}`,
`POST /billing/gift-notes/{checkout,sync}`

### Onboarding (no narrow rate limit — global only)

`POST /onboarding/{start,dismiss,complete,manual-add,catalog-select,update-step,create-wishlist,try-import}`

### Group gifts

`POST /items/:id/group-gift`,
`POST /group-gifts/:id/{join,leave,complete,cancel,messages}`,
`PATCH /group-gifts/:id/{amount,pinned}`

### Profile / showcase / settings

`PATCH /me/profile`, `POST/DELETE /me/profile/avatar` (multipart),
`PATCH /me/showcase`, `POST/DELETE /me/showcase/cover` (multipart),
`PATCH /me/settings`,
`DELETE /me/account` (`critical = true`)

---

## 4. Intentionally not covered (Wave 2 / by-design)

| Group | Why not in Wave 1 |
|---|---|
| Santa campaigns (~30 endpoints) | Wave 2 — too much surface to land in a single rollout |
| Wishlist categories (CRUD, reorder, bulk-move-category) | Wave 2 |
| Hints (`POST /items/:id/hint`) | Wave 2 |
| `/me/subscriptions/:id/read`, `/items/:id/comments/mark-read` | Fire-and-forget read markers — duplicate-safe by design |
| `/maintenance-{return,exposure}`, `/analytics/attribution`, `/telemetry` | Telemetry — duplicate writes are acceptable / already deduped |
| `/promo/apply` | Already protected by `promoLimiter` (5/min/user) |
| `/me/god-mode`, `/santa/season/test-mode` | Admin / debug only |
| `/gift-occasions/*` (calendar) | Separate feature surface, not P0 |

These will be revisited only after Wave 1 has lived in prod for 24–48 h
without false-positive 429s or 409s on legitimate flows.

---

## 5. Rate limits

All categories are `actorHash`-keyed unless noted. Implemented in
[`apps/api/src/security/rateLimits.ts`](../apps/api/src/security/rateLimits.ts).

| Category | Limit | Where applied |
|---|---|---|
| `global.auth` | 300 / 5 min per actor | Every `/tg/*` request |
| `state.changing` | 60 / 5 min per actor | Every `/tg/*` POST / PATCH / DELETE |
| `wishlist.create` | 10 / 1 h | `POST /tg/wishlists` |
| `item.create` | 20 / 10 min | `POST /tg/wishlists/:id/items` |
| `item.bulk` | 10 / 10 min | All 6 `POST /tg/items/bulk-*` |
| `reservation.short` | 10 / 5 min | `reserve`, `unreserve`, `secret-reserve`, `extend-reservation` |
| `reservation.day` | 50 / day | `reserve` (stacked with `.short`) |
| `comment.minute` | 10 / 1 min | `POST /tg/items/:id/comments` |
| `comment.hour` | 50 / 1 h | `POST /tg/items/:id/comments` (stacked with `.minute`) |
| `share.hour` | 10 / 1 h | `POST /tg/wishlists/:id/{share-token,selections}` |
| `payment` | 5 / 10 min | **`/checkout` only** — never on `/sync`. Recovery flows must keep working |
| `global.unauth` | 30 / 1 min per IP | Defined; not yet wired in Wave 1 |
| `import.{short,day}` | 5 / 10 min · 30 / day | Defined; existing custom limiters cover today |
| `referral.{hour,day}` | 5 / 1 h · 20 / day | Defined; no public referral endpoints in Wave 1 |
| `public.share.view` | 120 / 1 min per IP | Defined; existing `publicReadLimiter` covers today |
| `health.deep` | 10 / 1 min per IP | Defined; not wired |

**Onboarding endpoints carry no narrow category** — only `global.auth` +
`state.changing` apply. The Mini App may re-fire `/onboarding/start` on
bootstrap or reopen, and tighter limits would 429 first-time users.

**Sync endpoints carry no `payment` category.** A user whose `/sync` failed
mid-payment must be able to retry until PRO activates. Idempotency replay on
the same key returns the cached answer cheaply; new attempts mint new keys.

### 429 response shape

```json
{ "error": "RATE_LIMITED", "limitKey": "comment.minute", "retryAfterSec": 60 }
```

Plus header `Retry-After: <sec>`.

### Storage

In-process `MemoryStore` (one Docker API instance today). For multi-instance
deployment, swap to `rate-limit-redis` — category names stay the same; only
the `store` field on each `rateLimit({...})` changes. See TODO in
`rateLimits.ts`.

---

## 6. IP throttle

Sliding-window in-memory cap on misbehaving IPs. Implemented in
[`apps/api/src/security/ipThrottle.ts`](../apps/api/src/security/ipThrottle.ts).

| Trigger | Threshold | Throttle | When fired |
|---|---|---|---|
| `auth_rejected` | 10 / 60 s | 5 min | `requireTelegramAuth` rejects (missing or invalid initData) |
| `not_found` | 30 / 60 s | 5 min | Defined; not yet auto-recorded — reserved for future scanner detection |
| `unauth_post` | 30 / 60 s | 5 min | `suspiciousUnauthPostGate` (defined; not wired in Wave 1) |

**Never permanent.** Throttles always expire; no manual ban list, no DB
table. Buckets garbage-collect after 10 minutes of inactivity.

**NAT / mobile-carrier caveat.** Thresholds are intentionally lenient — many
mobile carriers and corporate NATs share a single egress IP across thousands
of users. We'd rather miss a slow attacker than wrongly throttle a NAT'd
user. If false positives appear in prod, raise thresholds or disable via env
(see § 9).

**Always hashed.** Only `ipHash = sha256(IP_HASH_SALT + ip).slice(0,16)`
ever touches logs or memory. Raw IPs leave the request handler only via
`req.ip` (already used by `pino-http` request logs — out of scope for this
layer).

The `ipThrottleGate(['auth_rejected'])` runs **before** `requireTelegramAuth`
on `tgRouter`, so a known-bad IP gets `429 IP_THROTTLED` without burning
HMAC validation.

---

## 7. Frontend contract

### `tgFetch` option

```ts
tgFetch(path, {
  method: 'POST',
  body: JSON.stringify(...),
  idempotency: { action: 'wishlist.create' },   // managed lifecycle
  // OR
  idempotency: 'literal-key-string',            // advanced: caller-controlled
});
```

GET / HEAD / OPTIONS ignore the option. `idempotency` omitted ⇒ no header sent
⇒ backend treats as a non-idempotent request (no replay protection).

### Action-key naming

| Pattern | Example |
|---|---|
| Singleton action | `wishlist.create`, `me.profile`, `billing.pro.sync` |
| Entity-scoped | `item.delete:${itemId}`, `wishlist.archive:${wishlistId}` |
| Composite-scoped | `item.placement.add:${itemId}:${wishlistId}` |
| Bulk (set-equality) | `item.bulk-delete:${[...ids].sort().join(',')}` |
| Per-attempt parameter | `billing.pro.checkout:${plan}` (one cached key per plan) |

**Same action name from two simultaneous in-flight calls** → second sees
`409 IDEMPOTENCY_REQUEST_IN_PROGRESS`. That's the dedupe working as
designed.

**Different business operations must use different action names** — e.g.
don't reuse `me.profile` for an avatar upload. (See known issue — Phase 3.1
splits `me.profile` into per-field actions.)

### Lifecycle

| Outcome | Cached key |
|---|---|
| 2xx success | **Cleared** — next user attempt mints a fresh key |
| 4xx (business error, e.g. 402 paywall) | **Cleared** — same as success: business outcome was returned |
| 5xx | **Kept** — manual retry uses the same key; server may replay or take over |
| Network error / timeout | **Kept** |
| `429 RATE_LIMITED` / `IP_THROTTLED` | **Kept** |
| `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` | **Kept** |
| `409 IDEMPOTENCY_KEY_STALE` | **Cleared** — must mint new |
| `409 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST` | **Cleared** + `miniapp.idempotency_error` event |
| `409 IDEMPOTENCY_RESPONSE_NOT_REPLAYABLE` / `_TOO_LARGE` / `_ACTOR_MISMATCH` | **Cleared** |
| `400 INVALID_IDEMPOTENCY_KEY` | **Cleared** + `miniapp.idempotency_error` event |

### Don'ts

- **Don't generate a new key inside a retry loop.** Use `getOrCreateActionKey`
  — it's cached per-action so retries reuse it.
- **Don't reuse the same `action` for different business operations.** That
  causes `KEY_REUSED_WITH_DIFFERENT_REQUEST`.
- **Don't log the raw key.** Telemetry uses `hashKeyForLog(key)` (8-hex djb2
  fingerprint) only.
- **Don't persist keys across reloads.** The cache is module-scoped on
  purpose — Mini App reopen mints fresh keys, so no stale ghosts.

### Multipart uploads

Avatar / cover endpoints bypass `tgFetch` (FormData needs no
`Content-Type`). The `Idempotency-Key` header is added manually:

```ts
const idemKey = getOrCreateActionKey('me.avatar.upload');
const res = await fetch(`${apiBase}/tg/me/profile/avatar`, {
  method: 'POST',
  headers: { 'X-TG-INIT-DATA': initDataRef.current, 'Idempotency-Key': idemKey },
  body: formData,
});
if (res.ok) clearActionKey('me.avatar.upload');
```

---

## 8. Error codes (reference)

Full list of security-layer codes returned in the response body's `error`
field.

| Code | HTTP | Meaning | Frontend behaviour | Cached key |
|---|---|---|---|---|
| `RATE_LIMITED` | 429 | Per-actor or per-IP category cap exceeded | Toast `error_rate_limited` with `retryAfterSec` | **Keep** |
| `IP_THROTTLED` | 429 | IP throttle tripped (auth abuse / scanner) | Toast `error_ip_throttled` | **Keep** |
| `INVALID_IDEMPOTENCY_KEY` | 400 | Header doesn't match `^[A-Za-z0-9_-]{16,128}$` | Toast `error_action_failed_retry`; log `miniapp.idempotency_error` | **Clear** |
| `IDEMPOTENCY_REQUEST_IN_PROGRESS` | 409 | Same key still locked + `lockedUntil > now` | Toast `error_action_already_processing`; do not retry yet | **Keep** |
| `IDEMPOTENCY_KEY_STALE` | 409 | Same key, `processing`, lock expired (handler likely crashed) | Generic toast; mint a new key on next attempt | **Clear** |
| `IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST` | 409 | Same key, `completed`, body / URL / actor differ | Generic toast; log `miniapp.idempotency_error` (client bug) | **Clear** |
| `IDEMPOTENCY_RESPONSE_NOT_REPLAYABLE` | 409 | Endpoint opted out of body replay (multipart) or body > 64 KB | Generic toast; client should re-fetch state to verify outcome | **Clear** |
| `IDEMPOTENCY_RESPONSE_TOO_LARGE` | 409 | Same as above (alternate flag for >64 KB) | Same as above | **Clear** |
| `IDEMPOTENCY_FAILED_RECENTLY` | 409 | Server cooldown after a 5xx (5 min) | Generic toast; respect `Retry-After` | **Keep** |
| `IDEMPOTENCY_ACTOR_MISMATCH` | 409 | Same key landed on a row owned by a different actor | Generic toast; client bug or session swap | **Clear** |

Server source of truth: [`apps/api/src/security/types.ts`](../apps/api/src/security/types.ts) `SecurityErrorCode`.
Client source of truth: [`apps/web/app/miniapp/idempotency.ts`](../apps/web/app/miniapp/idempotency.ts) `KEY_CLEAR_CODES`, `KEY_KEEP_CODES`, `SECURITY_TOAST_CODES`.

---

## 9. Env flags

All defaults: **on in prod**, **off in `NODE_ENV=test`** (unless explicitly set).

| Variable | Default | Effect |
|---|---|---|
| `SECURITY_IDEMPOTENCY_ENABLED` | on | Disable to skip the entire idempotency middleware (returns to pre-Wave-1 behaviour) |
| `SECURITY_RATE_LIMIT_ENABLED` | on | Disable to skip `createRateLimiter` checks (limiters return next() unconditionally) |
| `SECURITY_IP_THROTTLE_ENABLED` | on | Disable to skip `recordIpEvent` and `ipThrottleGate` |
| `SECURITY_CLEANUP_JOB_ENABLED` | on | Set to `false` to stop hourly purge of expired `IdempotencyKey` rows |
| `IP_HASH_SALT` | dev fallback string | **Set in prod.** Salts the IP hash used for log fingerprints + throttle buckets |
| `UA_HASH_SALT` | dev fallback string | **Set in prod.** Salts the User-Agent hash used in rate-limit logs |
| `CLEANUP_JOB_IN_TEST` | unset | Set to `true` in tests that explicitly need the cleanup job to run |
| `SECURITY_IP_THROTTLE_GC_IN_TEST` | unset | Set to `true` in tests that explicitly need IP throttle bucket GC |

Accepted truthy values: `true`, `1`, `yes`, `on`. Falsy: `false`, `0`, `no`, `off`.

---

## 10. Logging

All security events go through Pino (already redacts `X-TG-INIT-DATA`,
`X-ADMIN-KEY`, `Authorization`). The events themselves are defined in
[`apps/api/src/security/securityEvents.ts`](../apps/api/src/security/securityEvents.ts).

### Server-side events

| Event | Severity | Fields |
|---|---|---|
| `api.rate_limited` | info | `path, method, actorHash, ipHash, limitKey, retryAfterSec, uaHash` |
| `api.idempotency_replay` | info | `path, method, actorHash, ipHash, keyHash, originalCreatedAt` |
| `api.idempotency_conflict` | warn | `path, method, actorHash, ipHash, keyHash, reason` (`different_request` / `actor_mismatch` / `response_not_replayable`) |
| `api.idempotency_in_progress` | info | `path, method, actorHash, ipHash, keyHash` |
| `api.idempotency_key_stale` | warn | `path, method, actorHash, ipHash, keyHash` |
| `api.idempotency_retry_after_failed` | info | `path, method, actorHash, ipHash, keyHash, previousFailedAt` |
| `api.idempotency_db_error` | error | `path, method, phase, error` (no actor / IP — DB layer) |
| `api.idem_missing_on_critical_endpoint` | warn | `path, method, actorHash, ipHash, reason` (`no_header` / `invalid_header`) |
| `api.suspicious_activity` | warn | `path, method, actorHash, ipHash, reason` |
| `api.ip_throttled` | warn | `ipHash, reason, retryAfterSec, path, method` |
| `api.idempotency_cleanup_completed` | info | `deletedCount, durationMs` |

### Frontend events

| Event | When |
|---|---|
| `miniapp.rate_limited` | Server returned `RATE_LIMITED` or `IP_THROTTLED` |
| `miniapp.idempotency_error` | Client bug codes — `INVALID_IDEMPOTENCY_KEY`, `KEY_REUSED_WITH_DIFFERENT_REQUEST`, `ACTOR_MISMATCH` |
| `miniapp.action_retryable_error` | Other `IDEMPOTENCY_*` codes (stale, in-progress, not-replayable) |

### Hard rules — never log

- Raw IP. Use `hashIp(ip)`.
- Raw `Idempotency-Key`. Use `hashIdempotencyKey(key)` server-side or
  `hashKeyForLog(key)` client-side.
- Raw Telegram `initData`. Already redacted by Pino at the request-log layer.
- Raw User-Agent string (full). Use `hashUserAgent(ua)`.
- User-generated content — comment text, item titles, wishlist names, profile
  bio. Security logs reference rows by ID only.

---

## 11. Operational runbook

### Disable a feature in production

Edit `/opt/wishlist/.env` on the prod server:

```bash
SECURITY_RATE_LIMIT_ENABLED=false
SECURITY_IP_THROTTLE_ENABLED=false
SECURITY_IDEMPOTENCY_ENABLED=false
```

Then restart the API container:

```bash
ssh timeweb 'cd /opt/wishlist && docker compose restart api'
```

Each switch is independent — disable just the one causing pain.

### Inspect security logs

```bash
# All rate-limit hits in the last hour
ssh timeweb 'jq -c "select(.event == \"api.rate_limited\")" \
  /opt/wishlist/logs/api/api.log.$(date -u +%Y-%m-%d) | tail -50'

# Idempotency conflicts (likely client bugs)
ssh timeweb 'jq -c "select(.event == \"api.idempotency_conflict\")" \
  /opt/wishlist/logs/api/api.log.$(date -u +%Y-%m-%d)'

# IP throttling events
ssh timeweb 'jq -c "select(.event == \"api.ip_throttled\")" \
  /opt/wishlist/logs/api/api.log.$(date -u +%Y-%m-%d)'

# Critical endpoints called without a key (adoption monitor)
ssh timeweb 'jq -c "select(.event == \"api.idem_missing_on_critical_endpoint\")" \
  /opt/wishlist/logs/api/api.log.$(date -u +%Y-%m-%d) | wc -l'
```

### Identify rate-limit false positives

A burst of `api.rate_limited` from one `actorHash` for `state.changing`
within a few seconds is usually:

1. A user behind a flaky network firing the same POST 3–5 times. Check whether
   the same `actorHash` also has `api.idempotency_in_progress` events on the
   same path — if so, idempotency is doing its job, the rate-limit is just the
   ambient cap.
2. A bug in the Mini App calling an endpoint in a render loop. Check
   `api.rate_limited` distribution by `path` — a single actor flooding one
   path is suspicious; spread across many paths is more likely UI lag.
3. A legitimate bulk action user (rare). Raise the relevant category in
   `rateLimits.ts` and ship.

### Check the cleanup job

```bash
# Last cleanup run + how many it deleted
ssh timeweb 'jq -c "select(.event == \"api.idempotency_cleanup_completed\")" \
  /opt/wishlist/logs/api/api.log.$(date -u +%Y-%m-%d) | tail -3'

# Row count by status (sanity check)
ssh timeweb 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c \
  "SELECT status, COUNT(*) FROM \"IdempotencyKey\" GROUP BY status;"'

# Are there overdue rows? (cleanup should have purged these)
ssh timeweb 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c \
  "SELECT COUNT(*) FROM \"IdempotencyKey\" WHERE \"expiresAt\" < NOW();"'
```

### Users report unexpected 429 / 409

1. Get the user's `actorHash` (deterministic from their Telegram ID — via
   support ticket or asking them to read it from frontend dev tools).
2. Grep events:
   ```bash
   ssh timeweb 'jq -c "select(.actorHash == \"<hash>\")" \
     /opt/wishlist/logs/api/api.log.$(date -u +%Y-%m-%d) | head -50'
   ```
3. Look at the sequence — `api.rate_limited` clusters, `api.idempotency_*`
   patterns. Often shows the same POST fired 4× in 200 ms (Telegram WebView
   double-tap, no native debounce).
4. If it's a rate-limit false positive, kill-switch the category via env or
   tweak the limit and ship.
5. If it's `api.idempotency_conflict` with `reason: different_request`, it's
   a client bug — same `action` reused across business operations. File a
   frontend fix.

---

## 12. Rollout checklist

### Pre-deploy

- [ ] `IP_HASH_SALT` set in `/opt/wishlist/.env` (random ≥ 32 chars)
- [ ] `UA_HASH_SALT` set in `/opt/wishlist/.env`
- [ ] All four `SECURITY_*_ENABLED` flags either unset (defaults on) or `=true`
- [ ] `prisma migrate deploy` ready to apply `20260429000000_add_idempotency_keys`

### Deploy order

1. **Backend first.** API accepts `Idempotency-Key`, but doesn't require it.
   Old Mini App versions keep working because of soft-require.
2. **Frontend second.** Mini App starts sending keys on P0 actions. Idempotency
   begins to actually deduplicate.

### Post-deploy verification (mandatory — see CLAUDE.md health-check block)

```bash
# 1. Migrations applied
ssh timeweb 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c \
  "SELECT migration_name FROM _prisma_migrations \
   WHERE finished_at IS NULL AND rolled_back_at IS NULL;"'

# 2. API health
ssh timeweb 'curl -s http://localhost:3001/health'

# 3. New table is reachable
ssh timeweb 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c \
  "SELECT COUNT(*) FROM \"IdempotencyKey\";"'

# 4. Cleanup job started
ssh timeweb 'docker logs wishlist-prod-api-1 2>&1 | grep idempotency_cleanup | tail -3'
```

### Observation window — **24 to 48 hours** before deciding on Wave 2

Watch for:

- **`api.rate_limited`** — should be < 100/day in steady state. Spikes per
  category indicate a tight limit, per `actorHash` indicate UI bug.
- **`api.idempotency_conflict`** — should be ~0. Any volume here is a client
  bug (same key reused).
- **`api.idempotency_key_stale`** — small volume expected (handler crashes,
  network-killed POSTs). A flood = handler-side hang.
- **`api.idem_missing_on_critical_endpoint`** — should drop to ~0 once the
  Mini App update propagates through Telegram cache. If it stays high after
  72 h, frontend wiring is incomplete somewhere.
- **`api.ip_throttled`** — expect ~0 from real users. Spikes = scanner.

Only after a clean window decide on Wave 2 (Santa, Categories, Hints,
Subscriptions). See [`feedback_adoption_wave_pause.md`](https://github.com/anthropics/.../memory) — pause between waves is policy.

### Rollback

If anything goes wrong, the kill switches in § 9 take everything back to
pre-Wave-1 behaviour without a code change or redeploy. Restart the API
container after editing `/opt/wishlist/.env`.

---

## Appendix A — file map

| Concern | File |
|---|---|
| DB model + migration | [packages/db/prisma/schema.prisma](../packages/db/prisma/schema.prisma) `IdempotencyKey`, [migrations/20260429000000_add_idempotency_keys/](../packages/db/prisma/migrations/20260429000000_add_idempotency_keys) |
| Idempotency middleware | [apps/api/src/security/idempotency.ts](../apps/api/src/security/idempotency.ts) |
| Rate-limit factory + categories | [apps/api/src/security/rateLimits.ts](../apps/api/src/security/rateLimits.ts) |
| IP throttle | [apps/api/src/security/ipThrottle.ts](../apps/api/src/security/ipThrottle.ts) |
| IP / UA / key hashing | [apps/api/src/security/ipHash.ts](../apps/api/src/security/ipHash.ts) |
| Stable JSON + request hash | [apps/api/src/security/requestHash.ts](../apps/api/src/security/requestHash.ts) |
| Structured log helpers | [apps/api/src/security/securityEvents.ts](../apps/api/src/security/securityEvents.ts) |
| Cleanup job | [apps/api/src/security/cleanupJob.ts](../apps/api/src/security/cleanupJob.ts) |
| Constants + error codes | [apps/api/src/security/types.ts](../apps/api/src/security/types.ts) |
| Wiring (registry on `tgRouter`) | [apps/api/src/index.ts](../apps/api/src/index.ts) — `// ─── Wave 1 P0 security protections ───` block |
| Frontend helper | [apps/web/app/miniapp/idempotency.ts](../apps/web/app/miniapp/idempotency.ts) |
| Frontend wiring (`tgFetch`) | [apps/web/app/miniapp/MiniApp.tsx](../apps/web/app/miniapp/MiniApp.tsx) — search `idempotency: { action:` |
| i18n keys | [packages/shared/src/i18n.ts](../packages/shared/src/i18n.ts) — `error_rate_limited`, `error_ip_throttled`, `error_idempotency_in_progress`, `error_action_failed_retry`, `error_action_already_processing` |
| Tests | [apps/api/src/security-helpers.test.ts](../apps/api/src/security-helpers.test.ts), [apps/api/src/security-idempotency.test.ts](../apps/api/src/security-idempotency.test.ts) |
