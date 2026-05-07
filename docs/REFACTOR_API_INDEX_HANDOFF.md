# Refactor handoff — `apps/api/src/index.ts` decomposition

**Status as of 2026-05-07.** P1–P5 + P5r-1..6 + **P5s-1..10** are
**DONE**. The full decomposition track is **closed**. `index.ts` is
**1 789 LOC** of pure composition root: bootstrap, middleware, security
gate registration, router mounts, scheduler registration, `app.listen`,
process handlers — and a thin layer of factory wirings for services
that close over runtime deps.

This document is **self-contained**: an agent picking up future API
work should not need to read prior conversation. Everything required is
here, in `git log`, or in the files listed.

---

## TL;DR

| Phase | Status | Δ on `index.ts` |
|---|---|---|
| **P1+P2+P3** | done | helper modules extracted: `bootstrap/`, `lib/`, `middleware/`, `telegram/`, `notifications/`, `placements/`, `wishlists/`, `health/`, `uploads/`. `~21,580` → `~19,636`. |
| **P4** | done | 3 prefix-bound routers via factory pattern: `internal`, `admin`, `public`. |
| **P5** | done | every `tgRouter` handler split into `routes/<domain>.routes.ts`. `~19,636` → `4,740`. |
| **P5r-1..6** | done | every scheduler `setInterval` / `setTimeout` moved to `apps/api/src/schedulers/<name>.ts`. Two cross-cutting services landed (`lifecycle`, `birthday-reminders`). `4,740 → 3,110`. |
| **P5s-1..10** | done | 11 helper services extracted (`entitlement`, `telegram-auth`, `onboarding`, `santa-season`, `items`, `wishlists`, `calendar`, `url-import`, `locale`, `analytics`, `referral-hooks`). `3,110 → 1,789`. |
| **Wave-2 security** | done | 165 `protectTgRoute` entries cover every state-changing endpoint; documented exclusions only (read-markers, telemetry, onboarding-flags). |

**Cumulative reduction:** `index.ts` 12 924 (P5r baseline) → **1 789 LOC**
(−11 135 LOC, **−86.2%** off the post-P5 baseline; **−91.7%** off the
original ~21 580 monolith peak).

**Composition-root state (verified 2026-05-07 after `098fc59`):**
- 0 inline `tgRouter.<verb>(...)` handlers.
- 0 actual `setInterval` / `setTimeout` scheduler calls in `index.ts`.
- 27 `tgRouter.use(...)` mounts; 12 `app.use(...)` mounts.
- **165** `protectTgRoute(...)` entries (Wave-2 closure).
- **24** `register*Router(...)` calls.
- **11** scheduler factory call-sites.
- **13** services in `apps/api/src/services/`.
- 0 helpers remaining inline that meet the extraction threshold (3+ consumers, cross-domain coupling, factory closure).

---

## Current file map (`apps/api/src/`)

```
apps/api/src/
├── index.ts                                        1 789 lines (composition root)
├── url-parser.ts, browser-network-extractor.ts     marketplace strategies
├── sort.ts, sort.test.ts                           pure
├── seed.ts, profile.ts                             one-off
├── logger.ts                                       pino logger singleton
├── trackAnalyticsEvent.ts                          stranded duplicate (0 importers — flag for cleanup PR)
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
├── services/                   ── 13 modules (P5r-5..6 + P5s-1..10) ──
│   ├── analytics.ts            trackEvent + trackAnalyticsEvent (stateless)
│   ├── birthday-reminders.ts   6 pure helpers + BIRTHDAY_TZ_OFFSET_HOURS
│   ├── calendar.ts             3 pure date helpers (gift-notes / events scheduler)
│   ├── entitlement.ts          PLANS, prices, SKUs, getUserEntitlement,
│   │                           getEffectiveEntitlements, isWishlistWritable,
│   │                           requireGiftNotes (Pro feature gate)
│   ├── items.ts                ACTIVE_STATUSES, mapTgItem, getItemRole,
│   │                           cancelItemHints, notifySubscribersOfChange,
│   │                           countItemPlacements, extractNumericPrice,
│   │                           priorityToNum, numToPriority
│   ├── lifecycle.ts            createSendLifecycleDM factory
│   ├── locale.ts               resolveUserFirstName
│   ├── onboarding.ts           hello_activation state machine + demo-item
│   │                           dictionaries + completion factory
│   ├── referral-hooks.ts       runReferralProgressHook, notifyReferralInviterRewarded,
│   │                           resolveProactiveUserLocale (private)
│   ├── santa-season.ts         season window math + alias system + seasonal
│   │                           broadcasts + maybeRunSeasonalEvents cron entry
│   ├── telegram-auth.ts        validateTelegramInitData, tgActorHash,
│   │                           requireTelegramAuth, getOrCreateTgUser,
│   │                           SYSTEM_ACTOR_HASH, INIT_DATA_*
│   ├── url-import.ts           createImportUrlForUser factory (URL → draft item)
│   └── wishlists.ts            DRAFTS_ITEM_LIMIT, reassignPrimaryBeforeWishlistDelete,
│                               createGetOrCreateDraftsWishlist factory
│
├── schedulers/                 ── 9 cron modules ──
│   ├── billing.ts              hourly: subscription/promo/degradation expiry
│   ├── birthday-reminders.ts   hourly + 30s startup kick
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
    ├── santa.routes.ts             3 763 lines, 74 handlers
    ├── me.routes.ts                2 358 lines, 27 handlers
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

**Services** are catalogued in [SERVICES.md](SERVICES.md) — 13 live
modules with consumer lists and strategy choices.

---

## What lives inside `index.ts` today (1 789 LOC)

This is **only** composition root — bootstrap, security wiring, factory
wirings, mounts, listen.

| Block | LOC (approx) |
|---|---|
| Bootstrap (DNS, env, Sentry, prisma+logger init, multer, express app + middleware chain) | ~250 |
| Top-level imports (24 router factories, 9 scheduler factories, 13 services, security middleware, shared utilities) | ~200 |
| Service factory wirings (`createGetOrCreateDraftsWishlist`, `createImportUrlForUser`, `createCompleteOnboarding`) | ~10 |
| 165 `protectTgRoute(...)` security wiring chain | ~250 |
| 24 `register*Router(...)` factory calls + `tgRouter.use(...)` mounts | ~150 |
| 11 `start*Scheduler(...)` factory calls | ~60 |
| `runSantaStartupJobs()` invocation inside app.listen | ~5 |
| `app.listen(...)` + process handlers (uncaughtException, unhandledRejection) + admin-alert wiring | ~30 |
| Comment blocks documenting extraction history (P5s-1..10 markers, deferred wiring TDZ rationales) | ~830 |

The comment density is intentional. Future agents reading `index.ts`
get history-of-decisions inline (why this wiring sits where it sits,
which P5s phase moved what, which order matters for TDZ-safety, etc.).

---

## Composition-root contract (binding for new work)

After P5/P5r/P5s, `apps/api/src/index.ts` is a **composition root**.
New API code follows the iron rules in
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

## Hard constraints (preserved through P1 → P5s-10)

1. **Byte-identical handler bodies.** Every route handler, scheduler
   body, and service helper extracted via P5/P5r/P5s matched the
   original token-for-token. Only allowed deltas: file location +
   import vs deps wiring + export keyword + factory wrapping where the
   body closes over a runtime dep. This rule prevented behaviour
   regressions across all 11 P5s commits.
2. **No middleware-order changes** (`cors → express.json → requestLogger
   → /uploads → /health → routers → error handler`).
3. **No Prisma schema change without explicit proposal + approval.**
4. **No "small refactor along the way".** If you spot dead code, naming
   churn, or duplication while extracting, open a separate commit.
5. **Test baseline:** 247 pass / 3 fail. The 3 failures are in
   [`apps/api/src/sort.test.ts`](../apps/api/src/sort.test.ts) and
   predate this work.
6. **Type-check baseline:** clean apart from the 3 sort.test.ts errors.

---

## Verification recipe (used after every P5s step)

```bash
# 1. Type-check
npx tsc --project apps/api/tsconfig.build.json --noEmit

# 2. Builds
pnpm -C apps/api build
pnpm -C apps/bot build
pnpm -C apps/web build

# 3. Tests (baseline: 247 pass / 3 fail)
pnpm -C apps/api test 2>&1 | tail -10

# 4. Static composition-root invariants (must not change)
grep -cE "protectTgRoute\(" apps/api/src/index.ts          # 165
grep -cE "register[A-Z][A-Za-z]+Router\(" apps/api/src/index.ts  # 24
grep -cE "^tgRouter\.(get|post|patch|put|delete)\(" apps/api/src/index.ts  # 0
grep -cE "^setInterval\(|^cron\." apps/api/src/index.ts    # 0

# 5. index.ts LOC
wc -l apps/api/src/index.ts                                 # 1789
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

---

## Closure status

**Decomposition track:** 100% complete as of 2026-05-07.

**Wave-2 security:** 100% complete as of 2026-05-07. 165 `protectTgRoute`
entries cover every state-changing endpoint. 10 documented exclusions
(5 read-markers, 4 telemetry/analytics, 1 onboarding-seen flag).

**Open backlog after closure:**

| Item | Where | Notes |
|---|---|---|
| Dead-code cleanup | `apps/api/src/trackAnalyticsEvent.ts` | Stranded near-duplicate of `services/analytics.ts:trackAnalyticsEvent` (different signature, different truncation strategy). 0 importers. Safe-delete in a tiny follow-up PR. |
| Doc-guard regressions | `docs/DESIGN_DECISIONS.md`, `docs/DATA_MODEL.md`, `docs/FRONTEND_MAP.md` | 3 pre-existing CI doc-guard failures, unrelated to API track. Predates this work. |

There is **no open extraction work**. New helpers added to `index.ts`
that meet the on-touch threshold (3+ consumers OR cross-router/scheduler
coupling OR factory over runtime dep) immediately violate the
composition-root contract — they MUST go to `services/<name>.ts`.

---

## Production network reality (historical, resolved 2026-05-03)

This section used to read "do NOT chase Telegram outbound flakiness in
P5". That caveat is retired. Production runs on Vultr Amsterdam VPS
(commit `0e7a9f6`); both IPv4 and IPv6 reach `api.telegram.org` in
~30 ms.

References:
- [BUGFIX_LESSONS.md](BUGFIX_LESSONS.md) — 2026-05-03 entry.
- [VULTR_MIGRATION_RUNBOOK.md](VULTR_MIGRATION_RUNBOOK.md).
- [INFRA_AND_ENV.md](INFRA_AND_ENV.md).

---

*Maintainer note*: this doc is now a snapshot of the closed track. The
file map's `index.ts` LOC, the `What lives inside index.ts` table, and
the closure status reflect the 2026-05-07 final state. Future API work
on top of this codebase does not need to update this file unless the
refactor track is somehow re-opened (no current trigger for that).
