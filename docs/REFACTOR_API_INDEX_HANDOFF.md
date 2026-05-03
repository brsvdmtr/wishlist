# Refactor handoff — `apps/api/src/index.ts` decomposition

Status as of 2026-05-03. Single-file monolith reduction.

This document is **self-contained**: an agent picking up P5 should not need to read prior conversation. Everything required is here, in `git log`, or in the files listed.

---

## TL;DR

- **P1–P4 done** (commits `a5a5fc5` and `30839b2`). 31 modules extracted, 3 prefix-bound routers split out via factory functions. `index.ts` shrank from ~21 580 → 19 636 lines.
- **P5 still pending**: split `tgRouter` (238 handlers, the majority of the remaining mass) into domain routers using the same factory pattern.
- **Constraints unchanged**: handler bodies must be byte-identical, no behavior change, no Prisma schema change without an explicit proposal+approval cycle, baseline tests must stay green (247 pass / 3 fail in `sort.test.ts` — the 3 are pre-existing).

---

## What P1–P4 produced

### File map (after `30839b2`)

```
apps/api/src/
├── index.ts                                    19 636 lines (still the monolith)
├── logger.ts                                       46 lines
├── trackAnalyticsEvent.ts                          (existed)
├── url-parser.ts                                   (existed)
├── browser-network-extractor.ts                    (existed)
├── seed.ts / sort.ts / profile.ts / *.test.ts      (existed)
│
├── bootstrap/
│   ├── dns.ts                  13   ipv6first DNS, MUST be first import in index.ts
│   ├── env.ts                  33   dotenv resolution (apps/api/.env → root .env)
│   └── sentry.ts               21   GlitchTip init + flush helper
│
├── lib/
│   ├── asyncHandler.ts         13   express async-error wrapper
│   ├── crypto.ts               13   secureCompare (timing-safe, length-prefixed)
│   ├── http.ts                 13   zodError(res, error)
│   └── locale.ts               13   localeFromHeader(req)
│
├── middleware/
│   ├── cors.ts                 29   corsMiddleware (uses CORS_ALLOWED_ORIGINS)
│   └── requestLogger.ts        21   pino-http with redact
│
├── telegram/
│   ├── botApi.ts              100   sendTgNotification + sendTgBotMessage (6 s × 2 retry)
│   ├── deepLinks.ts            18   buildBotDeepLink, buildMiniAppDeepLink
│   ├── html.ts                  9   escapeHtml
│   └── invoiceLink.ts          52   createTgInvoiceLink (Stars billing)
│
├── notifications/
│   ├── adminAlerts.ts          25   sendAdminAlert (parallel fan-out to ADMIN_ALERT_CHAT_IDS)
│   └── commentNotificationQueue.ts   95   debounced comment notifier
│
├── placements/
│   ├── orderBy.ts              15   PLACEMENT_ORDER_BY (Prisma orderBy clause)
│   ├── slotResolvers.ts        35   resolvePlacementSlot* helpers
│   ├── ensureItemPlacement.ts  46   create primary placement on item-create
│   ├── countActivePlacementsInWishlist.ts  23
│   └── relocateItemPrimary.ts  74   reassign primary on wishlist-delete
│
├── wishlists/
│   ├── slug.ts                 35   generateUniqueSlug
│   └── shareToken.ts           19   generateShareToken
│
├── health/
│   └── health.routes.ts        60   GET /health (liveness) + /health/deep (DB + bot heartbeat)
│
├── uploads/
│   ├── upload.config.ts        35   multer config (limits, mime allowlist)
│   ├── imageProcessor.ts       38   sharp resize/strip
│   ├── uploadCleanup.ts        28   orphan-asset sweeper
│   └── registerUploads.ts      17   mounts POST /uploads + GET /uploads/* on app
│
└── routes/
    ├── public.routes.ts       805   /public/* — anonymous, rate-limited
    ├── internal.routes.ts     390   /internal/* — bot↔API, X-INTERNAL-KEY auth
    └── admin.routes.ts        829   /wishlists,/items,/tags,/admin/referral/*  X-ADMIN-KEY auth
```

### Commit map

| Commit | Date | Phase | What |
|---|---|---|---|
| `a5a5fc5` | 2026-05-01 12:24 +03 | P1+P2+P3 | 27 helper modules extracted (bootstrap/, lib/, middleware/, telegram/, notifications/, placements/, wishlists/, health/, uploads/) |
| `30839b2` | 2026-05-01 19:27 +03 | P4 | 3 routers split via factory pattern (`registerInternalRouter`, `registerAdminRouter`, `registerPublicRouter`) |

### Bug-fix commits applied on top (out of refactor scope, but live in `main`)

| Commit | Subject |
|---|---|
| `1cf4fb8` | fix(hints): stabilize friend hint flow |
| `25f8e84` | fix(items): open wish photo in fullscreen viewer on tap |
| `91a1c22` | fix(hints): dedupe duplicate users_shared and rework fallback flow |
| `dc5a0af` | fix(hints): auto-retry transient TG outage + visible loading state |
| `6c4de80` | fix(hints): claim hint atomically to prevent duplicate users_shared processing |
| `491a2ba` | fix(hints): make first-click delivery fast and idempotent |
| `5ac98e8` → `1e9f65d` | (deployed + reverted) IPv6-first DNS for bot — current network state has IPv6 path dead, so verbatim DNS is safer |
| `fa0b52d` | fix(hints): retry recipient sendMessage on network failure (3× 5 s) |
| `1e85ab6` | fix(bot): replace pino-roll worker with main-thread multistream + structured logs |
| `6574323` | fix(hints): cancel stale SENT hints + match bot's 30-min lookup window |
| `b517c1d` | fix: reduce bot startup config noise |
| `95c5707` | fix: classify bot startup aborts as transient |
| `02e2975` | fix: improve hint delivery confirmation copy |
| `0e7a9f6` | chore: migrate production ops to vultr (Timeweb → Vultr Amsterdam) |
| `d26720f`, `f6b32c0`, `e4a4de9` | docs: vultr migration runbook + ops alignment |
| `efcefe4` | docs(comments): retire RKN/Timeweb SNAT narrative in active code |

These are intermixed with refactor commits — P5 must rebase / pick the same baseline `main` (currently `efcefe4` or later).

---

## The factory pattern (must follow in P5)

P4 establishes the convention that P5 must reuse. Read [`apps/api/src/routes/internal.routes.ts`](../apps/api/src/routes/internal.routes.ts) — it is the smallest example.

```ts
// 1. The factory takes an explicit `deps` object: every helper / schema /
//    constant the handler bodies reference but that hasn't been extracted
//    out of index.ts yet. Types are minimised to the structural shape the
//    handlers actually use (so changes upstream don't ripple).
export type InternalRouterDeps = {
  getUserEntitlement: (...) => Promise<{ plan: { features: readonly string[] } }>;
  importUrlForUser: (...) => Promise<unknown>;
  DRAFTS_ITEM_LIMIT: number;
  recordMaintenanceExposure: (...) => Promise<string>;
  trackEvent: (...) => void;
};

// 2. requireInternalAuth (auth gate used only by this router) lives at
//    module scope here, NOT inside the factory. Keeps the closure light.
function requireInternalAuth(req, res, next) { ... }

// 3. The factory returns the Router. Inside, deps are destructured at the
//    top so handler bodies stay byte-identical to the in-place originals
//    (no `deps.X` rewriting).
export function registerInternalRouter(deps: InternalRouterDeps): Router {
  const { getUserEntitlement, importUrlForUser, DRAFTS_ITEM_LIMIT, ... } = deps;
  const internalRouter = Router();
  internalRouter.use(requireInternalAuth);
  // ... handler bodies copy-pasted unchanged
  return internalRouter;
}
```

Wired in [`apps/api/src/index.ts:15284-15312`](../apps/api/src/index.ts):

```ts
const internalRouter = registerInternalRouter({ getUserEntitlement, importUrlForUser, DRAFTS_ITEM_LIMIT, recordMaintenanceExposure, trackEvent });
const privateRouter  = registerAdminRouter({ ItemStatusSchema, PrioritySchema, zUrl, reassignPrimaryBeforeWishlistDelete, trackAnalyticsEvent, notifyReferralInviterRewarded });
const publicRouter   = registerPublicRouter({ ACTIVE_STATUSES, actorBodySchema, getUserEntitlement, trackEvent, trackAnalyticsEvent });

app.use('/public', publicRouter);
app.use('/tg', tgRouter);
app.use('/internal', internalRouter);
app.use(privateRouter);          // no prefix — prefixes live on each handler
```

**Rule of thumb for `deps` shape:** narrow tuple types where Prisma needs literal narrowing (e.g. `readonly ('AVAILABLE' | 'RESERVED' | 'PURCHASED')[]`, NOT `readonly string[]`). See [`public.routes.ts:31`](../apps/api/src/routes/public.routes.ts) for the comment.

---

## What P5 needs to do

Split [`tgRouter`](../apps/api/src/index.ts) (defined at line 104, 238 handlers) into per-domain factory routers under `apps/api/src/routes/`.

### Current `tgRouter` shape

- Mounted at line 15310: `app.use('/tg', tgRouter)`.
- Auth chain (lines 1448–1545, **must stay in this exact order**):
  1. `tgRouter.use(ipThrottleGate(['auth_rejected']))`
  2. `tgRouter.use(requireTelegramAuth)` — verifies `X-TG-INIT-DATA`, attaches `req.user`
  3. inline middleware that sets `req.userId` from `req.user.id` (line 1455+)
  4. inline middleware that sets `req.locale` from header / user profile (line 1488+)
  5. `tgRouter.use(createRateLimiter('global.auth'))` — global token bucket
  6. inline middleware for shadow-mode read tracking (line 1545+)
  7. blanket maintenance gate using `tgRouter.all(path, ...)` per path (line 1551+)
- Then 238 route handlers (line ~1849 to ~19 543).

### Route inventory by first path segment

```
Domain                  Count   Suggested module
─────────────────────────────────────────────────────────────────
/santa                     58   santa.routes.ts                ★ split into 2 if too big
/items                     32   items.routes.ts
/wishlists                 26   wishlists.routes.ts
/me                        25   me.routes.ts                   (profile + settings + entitlements + godmode)
/group-gifts               11   groupGifts.routes.ts
/gift-occasions            11   giftOccasions.routes.ts        (group with /gift-occasion-ideas — 16 total)
/gift-occasion-ideas        5     ↑ included above
/calendar                  10   calendar.routes.ts
/onboarding                 9   onboarding.routes.ts
/billing                    9   billing.routes.ts              (Telegram Stars / Pro)
/secret-reservations        7   secretReservations.routes.ts
/selections                 6   selections.routes.ts
/reservations               5   reservations.routes.ts
/referral                   4   referral.routes.ts
/birthday-reminders         4   birthdayReminders.routes.ts
/profiles                   3   profiles.routes.ts
/support                    2   support.routes.ts
/promo                      2   promo.routes.ts
/archive                    2   archive.routes.ts
/telemetry                  1   miscellaneous.routes.ts        ★ group small leaves
/maintenance-return         1     ↑
/maintenance-exposure       1     ↑
/import-url                 1     ↑
/hints                      1     ↑   (separate from item-scoped /tg/items/:id/hint)
/analytics                  1     ↑
/admin                      1     ↑
─────────────────────────────────────────────────────────────────
                          238
```

★ = judgment call:
- `/santa` at 58 handlers is bigger than `admin.routes.ts` (829 lines, 22 handlers); consider splitting into `santa.core.routes.ts` (campaigns + assignments + reveal + hints) and `santa.social.routes.ts` (chat, polls, exit-requests, organizer summary, mute) along the line groups visible in `tgRouter.get/post('/santa/...')` blocks at lines 14000+.
- The "miscellaneous" bucket (telemetry / maintenance-* / import-url / hints / analytics / admin — 7 routes total) doesn't belong under any domain. Group as `miscellaneous.routes.ts` or, if uncomfortable with that name, split each into its own one-handler file (the precedent is `admin.routes.ts` which is also `app.use(privateRouter)` no-prefix).

### Recommended split order

The user has explicitly required **one PR per logical unit** and a deploy + smoke-test gap between them. Suggested cadence:

1. **P5a** — `me.routes.ts` (25 handlers). Self-contained domain, no Santa entanglement, well-bounded set of helpers.
2. **P5b** — `items.routes.ts` (32 handlers). Touches item lifecycle helpers (`cancelItemHints`, `notifySubscribersOfChange`, `ItemStatusSchema`, `ACTIVE_STATUSES`, etc.) — these will need to enter `deps`.
3. **P5c** — `wishlists.routes.ts` (26 handlers). Often paired with items in tests, but cleanly separable in routes.
4. **P5d** — `santa.routes.ts` (or `santa.core` + `santa.social`) — the largest single domain. Do this last so by then `deps` shapes for shared helpers are stable.
5. **P5e** — everything else (`calendar`, `onboarding`, `billing`, `gift-occasions` + `ideas`, `secret-reservations`, `selections`, `reservations`, `referral`, `birthday-reminders`, `group-gifts`, `profiles`, `support`, `promo`, `archive`, the misc bucket).

After each P5*: deploy, run the post-deploy health check (next section), let the user observe prod. Do not chain P5a→P5b without that gap unless the user explicitly says "chain through".

---

## Hard constraints (the same ones P1–P4 followed)

1. **Byte-identical handler bodies.** When you grep the new file for any cluster of 5+ unique tokens from the original handler, the result must match. This is the one quality bar that has prevented behavior regressions across P1–P4.
2. **No middleware-order changes** (`cors → express.json → requestLogger → /uploads → /health → routers → error handler`). Same for the `tgRouter.use(...)` chain — P5 must preserve auth gate, locale gate, rate-limiter, and maintenance gate ordering exactly.
3. **No Prisma schema change without an explicit proposal + pause for approval.** This is a load-bearing rule from the user.
4. **No "small refactor along the way".** If you spot something tempting to fix in `index.ts` while you're touching it (dead code, naming, duplication), open a separate commit AFTER the P5 split is in. The user has called this out as a per-PR rule.
5. **Test baseline:** 247 pass / 3 fail. The 3 failures are in [`apps/api/src/sort.test.ts`](../apps/api/src/sort.test.ts) and predate this work. Any P5 commit that changes either number is rejected.
6. **Type-check baseline:** clean (apart from the 3 sort.test.ts compile errors above). `npx tsc --project apps/api/tsconfig.json --noEmit` after each P5 step.
7. **Mockup / design system:** P5 touches no UI — out of scope, but if you accidentally drift into web/ files: see [docs/design-system/UI_IMPLEMENTATION_RULES.md](design-system/UI_IMPLEMENTATION_RULES.md).

### Subtle gotchas seen in P1–P4

- **`getUserEntitlement` deps type was initially too narrow** — handlers in `internal.routes` use only `{ plan: { features: readonly string[] } }` but the runtime returns more. Use the structural minimum the handlers actually access; widen later if a handler reads more.
- **`ACTIVE_STATUSES: readonly string[]`** loses Prisma's `ItemStatus[]` narrowing. Use a tuple literal type: `readonly ('AVAILABLE' | 'RESERVED' | 'PURCHASED')[]`. See `public.routes.ts:31`.
- **`Edit` tool race**: if you `sed` then `Edit` the same file, re-read it in between. Lost ~10 minutes during P3 to a "File modified since read" loop.
- **External `git stash` race**: P1+P2 work on a feature branch was disrupted mid-session by an outside `git stash`. The user chose "full replay on new HEAD" rather than reconcile. Worth surfacing the branch state before starting P5.

---

## Verification recipe (run after every P5 step)

```bash
# 1. Type-check (ignore sort.test.ts — pre-existing baseline)
npx tsc --project apps/api/tsconfig.json --noEmit 2>&1 | grep -v "sort.test.ts" | head

# 2. Build
pnpm --filter @wishlist/api build

# 3. Tests (baseline: 247 pass / 3 fail in sort.test.ts)
pnpm --filter @wishlist/api test 2>&1 | tail -20

# 4. Bot still type-checks (in case shared types in deps drifted)
npx tsc --project apps/bot/tsconfig.json --noEmit

# 5. Visual sanity: line count delta on index.ts
wc -l apps/api/src/index.ts
```

After deploy (cherry-pick → push → GHA `Deploy to Vultr`):

```bash
# Mandatory post-deploy health check from CLAUDE.md:
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;"'
ssh vultr 'curl -s http://localhost:3001/health'
ssh vultr 'docker ps --filter name=wishlist-prod --format "{{.Names}} {{.Status}}"'
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "SELECT * FROM \"ServiceHeartbeat\" ORDER BY \"updatedAt\" DESC LIMIT 1;"'
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "SELECT MAX(\"sentAt\") as last_lifecycle_touch FROM \"LifecycleTouch\";"'
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "SELECT event, COUNT(*) FROM \"AnalyticsEvent\" WHERE event LIKE '\''error:%'\'' AND \"createdAt\" >= NOW() - INTERVAL '\''1 day'\'' GROUP BY event ORDER BY count DESC;"'
```

Failed migrations get resolved with:
```bash
ssh vultr 'docker exec wishlist-prod-api-1 /app/packages/db/node_modules/.bin/prisma migrate resolve --applied <migration_name> --schema=/app/packages/db/prisma/schema.prisma'
```

---

## Open backlog (NOT P5, parked separately)

| Item | Where | Notes |
|---|---|---|
| `ACTIVE_STATUSES` extraction | `apps/api/src/items/itemStatus.ts` (proposed) | Tech-debt noted in P3 report. Trivial; ship as a separate ~10-line PR before or after P5. |
| Bot logger transport regression | closed | Fixed `1e85ab6` — main-thread `pino.multistream`, no worker. |
| Outbound network reliability to Telegram | **RESOLVED 2026-05-03** by migration to Vultr Amsterdam | Both IPv4 and IPv6 paths reach `api.telegram.org` in ~30 ms. No proxy required. See [VULTR_MIGRATION_RUNBOOK.md](VULTR_MIGRATION_RUNBOOK.md) and the 2026-05-03 entry in [BUGFIX_LESSONS.md](BUGFIX_LESSONS.md). |
| `bot_users_shared_no_hint` UX text | `packages/shared/src/i18n.ts` | Was load-bearing on Timeweb when network blackouts hit it for legitimate sends. On Vultr the rate is near-zero, so this is now a low-pri polish item rather than a UX bug. Still worth differentiating "really stale" vs "transient TG hiccup". ~30 lines. |
| `bot/src/index.ts` `getHintContactWord` + `pluralize` import | live in `main` | Pluralization helper for hint summary (n contacts / n contactов). Untouched by refactor — just be aware the file moves slightly between commits. |

---

## Production network reality (resolved 2026-05-03 — historical note)

**Was**: Timeweb prod VPS lost outbound IPv4 to `api.telegram.org` to RKN
throttling (~40-60 % per-attempt success) while the only global IPv6 on the
host was `deprecated` upstream and silently dropped TCP. This produced
`fetch failed: Connect Timeout Error (attempted addresses: ..., timeout:
10000ms)` in API and bot logs and masked a separate logical bug
(idempotency window mismatch — fixed in `6574323`) for weeks.

**Now**: production runs on Vultr Amsterdam VPS (commit `0e7a9f6` migrated
ops, 2026-05-03). Both families reach `api.telegram.org` in ~30 ms; the
SNAT script and systemd unit (`docker-ipv6-snat.sh` /
`docker-ipv6-snat.service`) are absent from the new host. The bot's
recipient retry (`fa0b52d`) and API's idempotency window alignment
(`6574323`) remain in place as defence-in-depth, but they no longer mask
anything visible.

**Implication for P5**: this section used to read "do NOT chase this in
P5". That caveat is retired — there is no upstream network constraint on
new work. P5 only needs to follow the byte-identical-handler-body
discipline; behaviour-preservation is no longer about working around
flaky outbound TG calls.

References:
- [BUGFIX_LESSONS.md](BUGFIX_LESSONS.md) — 2026-05-03 entry on the masking effect.
- [VULTR_MIGRATION_RUNBOOK.md](VULTR_MIGRATION_RUNBOOK.md) — migration record.
- [INFRA_AND_ENV.md](INFRA_AND_ENV.md) — current infra layout.

---

## Quick start for the next agent

```bash
# 1. Make sure local main matches origin and tests are green
git fetch origin && git checkout main && git pull origin main
pnpm --filter @wishlist/api test 2>&1 | tail -5     # expect 247 pass / 3 fail

# 2. Pick the next P5 step from § "Recommended split order"; read the
#    pattern in apps/api/src/routes/internal.routes.ts top to bottom.

# 3. For the chosen domain, find every tgRouter handler (use the inventory
#    in this doc, then verify with):
grep -nE "^tgRouter\.(get|post|patch|delete|put)\(['\"](/me/|...)" apps/api/src/index.ts

# 4. Move handlers into the new file under registerXRouter(deps); identify
#    the closure-captures that must enter `deps`. Replace the in-index
#    block with a single `tgRouter.use(registerXRouter({...}))` mounted on
#    the same prefix the handlers were using (so the prefix lives in the
#    handler paths, NOT in app.use — same as admin.routes).
#    OR: lift the prefix and mount as `app.use('/tg/me', meRouter)` — but
#    this only works if every handler in the new file has the same prefix.

# 5. Run § Verification recipe. If clean, commit one PR per domain:
git add apps/api/src/routes/me.routes.ts apps/api/src/index.ts
git commit -m "refactor(api): split /me handlers into me.routes"

# 6. Push, deploy, run the post-deploy health check, wait for the user's
#    smoke confirmation BEFORE starting the next P5 step.
```

---

*Maintainer note*: this doc is a snapshot. After every P5 step, update the "File map", "Route inventory", and "TL;DR" sections. The intent is that a future agent at any P5 stage can read this single doc and pick up cleanly.
