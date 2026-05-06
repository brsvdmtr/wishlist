# Refactor handoff — `apps/api/src/index.ts` decomposition

**Status as of 2026-05-06.** P1–P5 + P5r-1..6 are **DONE**. `index.ts`
is now a composition root: 0 inline `tg` handlers, 0 actual scheduler
calls, 91 `protectTgRoute` entries, 24 `register*Router` factory calls,
9 `start*Scheduler` factory calls. The single-file monolith is retired.

Active follow-up: docs refresh (this PR), Wave-2 Santa security, and
P5s service extraction (~10 services, ~2340 LOC of helpers still inline
in `index.ts`).

This document is **self-contained**: an agent picking up the next phase
should not need to read prior conversation. Everything required is
here, in `git log`, or in the files listed.

---

## TL;DR

| Phase | Status | Commits | Δ on `index.ts` |
|---|---|---|---|
| **P1+P2+P3** | done | `a5a5fc5` | helper modules extracted: `bootstrap/`, `lib/`, `middleware/`, `telegram/`, `notifications/`, `placements/`, `wishlists/`, `health/`, `uploads/`. `~21,580` → `~19,636`. |
| **P4** | done | `30839b2` | 3 prefix-bound routers via factory pattern: `internal`, `admin`, `public`. |
| **P5** | done | series of P5a–P5q (route extractions) + P5r-1..6 (scheduler extractions) | every `tgRouter` handler split into `routes/<domain>.routes.ts`. `~19,636` → `4,740` after route extraction; then **4,740 → 3,110** through P5r scheduler extractions. |
| **P5r-1..6** | done | `73f76e9`, `5a76659`, `774b59d`, `9b77aca`, `d2fdaf9`, `0f60904` | every scheduler `setInterval` / `setTimeout` moved to `apps/api/src/schedulers/<name>.ts`. Two cross-cutting services landed: `services/lifecycle.ts` and `services/birthday-reminders.ts`. |

**Cumulative reduction:** `index.ts` 12,924 → 3,110 LOC (-9,814 LOC,
-75.9% from the pre-P5r baseline; the original peak was ~21,580).

**Composition-root state (verified 2026-05-06 after `0f60904`):**
- 0 inline `tgRouter.<verb>(...)` handlers.
- 0 actual `setInterval` / `setTimeout` scheduler calls (one
  `setTimeout(r, PAUSE_MS)` Promise sleep helper inside a route helper
  is the sole exception, and it is not a cron).
- 27 `tgRouter.use(...)` mounts; 12 `app.use(...)` mounts; 91
  `protectTgRoute(...)` entries; 24 `register*Router(...)` calls; 9
  `start*Scheduler(...)` factory calls.
- ~50 helper functions and ~30 top-level `const`s remain inline —
  these are the P5s extraction surface (see [SERVICES.md](SERVICES.md)).

---

## Current file map (`apps/api/src/`)

```
apps/api/src/
├── index.ts                                        3 110 lines (composition root)
├── url-parser.ts, browser-network-extractor.ts     marketplace strategies
├── sort.ts, sort.test.ts                           pure
├── seed.ts, profile.ts                             one-off
├── logger.ts, trackAnalyticsEvent.ts                bootstrap-time singletons
│
├── bootstrap/
│   ├── dns.ts                  ipv6first DNS, MUST be first import in index.ts
│   ├── env.ts                  dotenv resolution (apps/api/.env → root .env)
│   └── sentry.ts               GlitchTip init + flush helper
│
├── lib/                        asyncHandler, crypto (timing-safe), http (zodError),
│                               locale (localeFromHeader)
│
├── middleware/                 cors, requestLogger (pino-http with redact)
│
├── telegram/                   sendTgNotification, sendTgBotMessage,
│                               buildBotDeepLink, escapeHtml, createTgInvoiceLink
│
├── notifications/              adminAlerts, commentNotificationQueue (debounced)
│
├── security/                   idempotency, rateLimits, ipThrottle, ipHash,
│                               requestHash, securityEvents, cleanupJob, types
│
├── placements/                 PLACEMENT_ORDER_BY, slotResolvers, ensureItemPlacement,
│                               countActivePlacementsInWishlist, relocateItemPrimary
│
├── wishlists/                  generateUniqueSlug, generateShareToken
│
├── health/                     health.routes.ts (GET /health + /health/deep)
│
├── uploads/                    upload.config (multer), imageProcessor (sharp),
│                               uploadCleanup, registerUploads (mounts /uploads)
│
├── services/                   ── NEW (P5r-5, P5r-6) ──
│   ├── lifecycle.ts            createSendLifecycleDM factory + SendDmOutcome type.
│   │                           Used by schedulers/lifecycle.ts and pro-renewal.ts.
│   └── birthday-reminders.ts   6 pure helpers (timezone math, occurrence-key,
│                               display-name picker) + BIRTHDAY_TZ_OFFSET_HOURS.
│                               Used by routes + scheduler.
│
├── schedulers/                 ── NEW (P5r-1..6) ──
│   ├── billing.ts              hourly: subscription/promo/degradation expiry
│   ├── birthday-reminders.ts   hourly + 30s startup kick (P5r-6)
│   ├── cleanup.ts              hourly: TTL comments + curated + archive purge
│   ├── events.ts               5-min: gift-occasion calendar reminders
│   ├── lifecycle.ts            hourly: win-back DM (segments S1–S4) + dead-air alarm
│   ├── pro-renewal.ts          hourly: PRO renewal reminders (7d / 1d milestones)
│   ├── referral.ts             15-min: expired-attribution sweep
│   ├── reservations.ts         15-min reservation reminder + 5-min smart-res release
│   │                           + 15-min smart-res reminder
│   └── santa.ts                hourly × 4: hint expiry + deadline missed +
│                               deadline warning + seasonal events. Plus
│                               runSantaStartupJobs() called from app.listen.
│
└── routes/                     24 domain routers + 1 admin / 1 internal / 1 public:
    ├── santa.routes.ts             3 763 lines, 74 handlers — biggest.
    ├── me.routes.ts                2 358 lines, 27 handlers — fattest avg (87 LOC/handler).
    ├── wishlists.routes.ts         1 842 lines, 31 handlers
    ├── items.routes.ts             1 496 lines, 23 handlers
    ├── reservations.routes.ts      1 366 lines, 29 handlers
    ├── onboarding.routes.ts          886 lines,  9 handlers
    ├── admin.routes.ts               829 lines, 20 handlers (X-ADMIN-KEY, no protectTgRoute)
    ├── gift-notes.routes.ts          817 lines, 29 handlers
    ├── public.routes.ts              805 lines,  8 handlers (no auth, rate-limited)
    ├── group-gifts.routes.ts         743 lines, 14 handlers
    ├── comments.routes.ts            562 lines,  4 handlers
    ├── billing.routes.ts             559 lines,  9 handlers
    ├── referral.routes.ts            489 lines,  4 handlers
    ├── birthday-reminders.routes.ts  408 lines,  5 handlers
    ├── internal.routes.ts            390 lines,  7 handlers (X-INTERNAL-KEY)
    ├── hints.routes.ts               375 lines,  2 handlers
    ├── selections-archive.routes.ts  308 lines,  8 handlers
    ├── support.routes.ts             287 lines,  2 handlers
    ├── promo.routes.ts               286 lines,  2 handlers
    ├── import.routes.ts              138 lines,  1 handler
    ├── telemetry.routes.ts           131 lines,  1 handler
    ├── profiles.routes.ts            107 lines,  3 handlers
    ├── maintenance.routes.ts          93 lines,  2 handlers
    └── analytics.routes.ts            65 lines,  1 handler
```

**Schedulers** are catalogued in [SCHEDULERS.md](SCHEDULERS.md) with
cadence, what they do, tables touched, log labels, and monitoring
notes.

**Services** (existing + planned) are catalogued in [SERVICES.md](SERVICES.md).

---

## What still lives inside `index.ts` (3,110 LOC)

This is **not** business logic — it is the composition root plus the
helper layer that has not yet been extracted into `services/`.

| Block | LOC (approx) | Status |
|---|---|---|
| Bootstrap (DNS, env, Sentry, prisma+logger init, multer, express app + middleware chain) | ~600 | stays |
| ~30 top-level `const` declarations (PLANS, prices, SKUs, ONBOARDING_*, BIRTHDAY_REMINDERS_ENABLED, BOT_TOKEN_FOR_DM, MINI_APP_URL_FOR_DM, LIFECYCLE_PROMO_CODE, PRO_*) | ~50 | most → `services/entitlement.ts` (P5s-1) |
| ~50 helper functions (entitlement, telegram-auth, onboarding, santa-season, item helpers, wishlist helpers, analytics, referral hooks, calendar, locale, url-import) | ~1,500 | targets for P5s — full inventory in [SERVICES.md § 2](SERVICES.md#2-planned-p5s-services) |
| 91 `protectTgRoute(...)` security wiring chain | ~150 | stays in composition root (gate registration is correct here) |
| 24 `register*Router(...)` factory calls | ~50 | stays (composition root) |
| 9 `start*Scheduler(...)` factory calls | ~25 | stays (composition root) |
| `app.listen(...)` + process handlers + `runSantaStartupJobs()` | ~30 | stays |

**Target after the P5s wave:** ~770 LOC of pure composition root +
auth-gate registration. The remaining ~2,340 LOC of helpers move into
~10 new services modules.

---

## Composition-root contract (P5+ binding)

After P5/P5r, `apps/api/src/index.ts` is a **composition root**. New
API code follows the iron rules in
[API_ARCHITECTURE_RULES.md](API_ARCHITECTURE_RULES.md):

- New endpoints land in `routes/<domain>.routes.ts`, never in `index.ts`.
- Route handlers stay thin (~80–120 LOC soft cap; past that, extract a
  service).
- State transitions (`Item.status`, `archivedAt`, `Subscription.status`,
  `SantaCampaign.status`, `Hint.status`, `*At = now` fields) live in
  service / domain layer, never inline in handlers.
- Side effects (Telegram, billing, analytics, external HTTP) live in
  `integrations/`, `notifications/`, `telegram/`, or service layer.
- Schedulers live in `apps/api/src/schedulers/`. Route modules never
  start cron / `setInterval`.
- No dumping-ground routers (`misc`, `common`, `new`, `helpers`,
  `other`).
- Every state-changing endpoint (POST/PATCH/DELETE) explicitly answers
  idempotency / rate-limit / analytics — see
  [API_SECURITY.md](API_SECURITY.md).

---

## Roadmap — what comes next

### #1 — `docs(api): refresh post-P5r architecture docs` (this PR)

Pure-doc PR. Updates:
- This handoff doc.
- Creates [SCHEDULERS.md](SCHEDULERS.md) and [SERVICES.md](SERVICES.md).
- Refreshes [API_ARCHITECTURE_RULES.md](API_ARCHITECTURE_RULES.md),
  [BACKEND_MAP.md](BACKEND_MAP.md), [ARCHITECTURE.md](ARCHITECTURE.md),
  [API_SECURITY.md](API_SECURITY.md) (Wave-2 status), and
  [../CLAUDE.md](../CLAUDE.md).

### #2 — `security(api): Wave-2 Santa idempotency + rate-limits`

Add `protectTgRoute` to all 42 state-changing `routes/santa.routes.ts`
endpoints. Choose rate-limit categories
(`santa.campaign-mutate`, `santa.participant-action`,
`santa.message-write`, `santa.vote`, etc.). Add
`idempotency: { critical: true }` for `draw` / `complete` / `cancel` /
`exit-approve`. Santa is offseason (Nov 15 – Feb 15 calendar), so
adoption can ship without breaking real users.

### #3 — `refactor(api): extract entitlement service` (P5s-1)

Move `getUserEntitlement`, `getEffectiveEntitlements`,
`requireGiftNotes`, `isReservationBeta`, `hasReservationPro`,
`getSmartResLeadHours`, `hasSmartReservations`, `PLANS`, prices, SKUs,
`ADDON_CAPS`, `ONE_TIME_SKUS`, `PRO_*` constants to
`services/entitlement.ts`. ~280 LOC out. Highest fan-out (~20 files).

### #4 — `refactor(api): extract telegram-auth service` (P5s-2)

Move `validateTelegramInitData`, `tgActorHash`, `requireTelegramAuth`,
`protectTgRoute`, `getOrCreateTgUser`, `SYSTEM_ACTOR_HASH`,
`INIT_DATA_*` constants to `services/telegram-auth.ts`. **Highest
risk — ship #3 first and observe before touching auth.**

### #5 — `refactor(api): extract onboarding service` (P5s-3)

Move 10 onboarding state-machine functions + `ONBOARDING_KEY` /
`ONBOARDING_VERSION` / `FORCED_ROLLOUT_USERS` to
`services/onboarding.ts`. ~300 LOC out.

**Subsequent P5s candidates** (no global ordering required): santa-season,
items helpers, wishlists helpers, analytics + referral hooks,
calendar, url-import, locale. Full inventory in [SERVICES.md § 2](SERVICES.md#2-planned-p5s-services).

---

## Hard constraints (preserved through P1 → P5r-6)

1. **Byte-identical handler bodies.** Every route handler and scheduler
   body extracted via P5/P5r matched the original token-for-token.
   Only allowed deltas: `tgRouter.X` → `<router>.X`, indent +2 (when
   moving inside a factory), and dep destructuring at the top of the
   factory. This rule prevented behaviour regressions across all
   phases.
2. **No middleware-order changes** (`cors → express.json → requestLogger
   → /uploads → /health → routers → error handler`).
3. **No Prisma schema change without explicit proposal + approval.**
4. **No "small refactor along the way".** If you spot dead code, naming
   churn, or duplication while extracting, open a separate commit.
5. **Test baseline:** 247 pass / 3 fail. The 3 failures are in
   [`apps/api/src/sort.test.ts`](../apps/api/src/sort.test.ts) and
   predate this work. Any commit that changes either number is rejected.
6. **Type-check baseline:** clean apart from the 3 sort.test.ts errors.
   `npx tsc --project apps/api/tsconfig.json --noEmit` after every step.

---

## Verification recipe (run after every P5s step)

```bash
# 1. Type-check (filter pre-existing sort.test.ts noise)
npx tsc --project apps/api/tsconfig.json --noEmit 2>&1 | grep -v "sort.test.ts" | head

# 2. Build
pnpm -C apps/api build

# 3. Tests (baseline: 247 pass / 3 fail)
pnpm -C apps/api test 2>&1 | tail -20

# 4. Bot still type-checks (in case shared types drifted)
pnpm -C apps/bot build

# 5. Web still builds
pnpm -C apps/web build

# 6. Visual sanity: line count delta on index.ts
wc -l apps/api/src/index.ts
```

After deploy (push to `main` → GitHub Actions `Deploy to Vultr`):

```bash
# Mandatory post-deploy health check from CLAUDE.md:
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;"'
ssh vultr 'curl -s http://localhost:3001/health/deep'
ssh vultr 'docker ps --filter name=wishlist-prod --format "{{.Names}} {{.Status}}"'
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "SELECT * FROM \"ServiceHeartbeat\" ORDER BY \"updatedAt\" DESC LIMIT 5;"'
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "SELECT event, COUNT(*) FROM \"AnalyticsEvent\" WHERE event LIKE '\''error:%'\'' AND \"createdAt\" >= NOW() - INTERVAL '\''1 day'\'' GROUP BY event ORDER BY count DESC;"'
```

For scheduler-relevant changes, also see the per-cron monitoring
windows in [SCHEDULERS.md § Deploy monitoring](SCHEDULERS.md#deploy-monitoring).

Failed migrations resolved with:
```bash
ssh vultr 'docker exec wishlist-prod-api-1 /app/packages/db/node_modules/.bin/prisma migrate resolve --applied <migration_name> --schema=/app/packages/db/prisma/schema.prisma'
```

---

## Open backlog (post-P5r)

| Item | Where | Notes |
|---|---|---|
| Wave-2 Santa security | `routes/santa.routes.ts` (42 state-changing endpoints, 0 `protectTgRoute` coverage) | See [API_SECURITY.md § 4](API_SECURITY.md#4-wave-2-status). Highest-priority gap; santa is offseason so safe rollout window. |
| Wave-2 gift-notes / hints / promo / profiles / selections-archive / comments / maintenance | various routes | ~17 endpoints, lower priority than santa. Detail in [API_SECURITY.md § 4](API_SECURITY.md#4-wave-2-status). |
| `services/entitlement.ts` (P5s-1) | `index.ts` → `services/entitlement.ts` | Highest LOC reduction; first P5s extraction. |
| `services/telegram-auth.ts` (P5s-2) | `index.ts` → `services/telegram-auth.ts` | Auth core; ship after entitlement is monitored. |
| `services/onboarding.ts` (P5s-3) | `index.ts` → `services/onboarding.ts` | Conversion-critical; deploy off-peak. |
| Subsequent P5s services | `index.ts` → `services/<name>.ts` | santa-season / items / wishlists / analytics / referral-hooks / calendar / url-import / locale. See [SERVICES.md § 2](SERVICES.md#2-planned-p5s-services). |

---

## Production network reality (historical, resolved 2026-05-03)

This section used to read "do NOT chase Telegram outbound flakiness in
P5". That caveat is retired. Production runs on Vultr Amsterdam VPS
(commit `0e7a9f6`); both IPv4 and IPv6 reach `api.telegram.org` in
~30 ms. The bot's recipient retry (`fa0b52d`) and API's idempotency
window alignment (`6574323`) remain in place as defence-in-depth, but
they no longer mask anything visible.

References:
- [BUGFIX_LESSONS.md](BUGFIX_LESSONS.md) — 2026-05-03 entry.
- [VULTR_MIGRATION_RUNBOOK.md](VULTR_MIGRATION_RUNBOOK.md).
- [INFRA_AND_ENV.md](INFRA_AND_ENV.md).

---

## Quick start for the next agent

```bash
# 1. Make sure local main matches origin and tests are green
git fetch origin && git checkout main && git pull origin main
pnpm -C apps/api test 2>&1 | tail -5     # expect 247 pass / 3 fail

# 2. Pick the next phase from § Roadmap. Read SERVICES.md § 2 to find
#    which helpers move where.

# 3. For service extraction, follow the P5r pattern:
#    audit → confirm → byte-identical extraction → verify → commit →
#    deploy → immediate health → first-tick (or analogous) check.

# 4. Verification recipe above. Push to main on green; GitHub Actions
#    handles deploy.
```

---

*Maintainer note*: this doc is a snapshot. After every P5s step, update
the file map's `index.ts` LOC, the helper-block table, and the roadmap
checkmarks. The intent is that a future agent at any P5s stage can
read this single doc and pick up cleanly.
