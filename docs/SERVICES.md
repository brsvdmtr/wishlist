# API Services

**Last updated:** 2026-05-07 (after P5s-4 — full closure) · **Owner:** backend

The `services/` layer holds cross-cutting helpers that don't belong to a
single route module. As of **2026-05-07** the P5s extraction wave is
**complete**: all 13 service modules are live and `apps/api/src/index.ts`
is **1 789 LOC** (down from a peak of ~21 580 — −91.7% off the original
monolith, −51.6% off the post-P5r baseline of 3 700).

`services/` is the canonical home for:

- Helpers consumed by **3+ routers / schedulers**.
- Pure utilities that are pivotal enough to warrant a dedicated module
  (e.g. timezone math used by both routes and a scheduler).
- Stateless functions that wrap a side effect (e.g. a Telegram DM
  factory closing over the bot token + logger).
- Factories that close over runtime deps (e.g. `trackEvent`) and need
  to be wired once at composition-root, then passed via factory deps.

It is **not** the right home for:

- Single-router business logic (that stays in `routes/<domain>.routes.ts`
  or moves to `services/<domain>.service.ts` only when handler size
  passes the ~80–120 LOC smell test).
- Pure JSON parsing or schema-only utilities (those live in `lib/` —
  asyncHandler, http, locale, crypto).
- Telegram Bot API send wrappers that already exist in `telegram/`
  (botApi.ts, deepLinks.ts, html.ts, invoiceLink.ts).

---

## 1. Live services (13 modules)

| # | Module | Phase | Δ LOC out of index.ts | Strategy | Consumers |
|---|---|---|---|---|---|
| 1 | `services/lifecycle.ts` | P5r-5 | ~93 (factory) | A — factory passed via deps | `schedulers/lifecycle.ts`, `schedulers/pro-renewal.ts` |
| 2 | `services/birthday-reminders.ts` | P5r-6 | ~106 (pure) | B — direct import | `routes/birthday-reminders.routes.ts`, `schedulers/birthday-reminders.ts` |
| 3 | `services/entitlement.ts` | P5s-1 | ~280 | A — deps preserved | 15 routes + 5 schedulers; `requireGiftNotes` appended in P5s-5 |
| 4 | `services/telegram-auth.ts` | P5s-2 | ~250 | A — deps preserved | every router, every protected route |
| 5 | `services/onboarding.ts` | P5s-3 | ~310 | hybrid B+A (12 direct + `completeOnboarding` factory) | `routes/onboarding.routes.ts`, `routes/items.routes.ts` |
| 6 | `services/items.ts` | P5s-6 | ~250 | A — deps preserved | 9 routes (items, wishlists, reservations, comments, santa, selections-archive, onboarding, public, me) |
| 7 | `services/wishlists.ts` | P5s-7 | ~50 | A — deps preserved + `getOrCreateDraftsWishlist` factory | 6 routes |
| 8 | `services/calendar.ts` | P5s-8 | ~30 | B — direct import | `routes/gift-notes.routes.ts`, `schedulers/events.ts` |
| 9 | `services/url-import.ts` | P5s-9 | ~85 | A — factory closing over `trackEvent` + `getOrCreateDraftsWishlist` | `routes/import.routes.ts`, `routes/internal.routes.ts`, `routes/onboarding.routes.ts` |
| 10 | `services/locale.ts` | P5s-10 | ~30 | B — direct import | `routes/reservations.routes.ts` |
| 11 | `services/analytics.ts` | P5s-5 | ~75 | A — deps preserved | 21+ files (every router + most schedulers) |
| 12 | `services/referral-hooks.ts` | P5s-5 | ~180 | A — deps preserved | `routes/wishlists.routes.ts`, `routes/onboarding.routes.ts`, `routes/admin.routes.ts` |
| 13 | `services/santa-season.ts` | P5s-4 | ~382 | A — deps preserved | `routes/santa.routes.ts`, `schedulers/santa.ts`, `runSantaStartupJobs` |

**Total moved out of index.ts:** ~2 121 LOC (P5s alone) + 199 (P5r-5/-6) ≈ **2 320 LOC** across the entire services layer.

---

## 2. Per-service detail

### `services/lifecycle.ts` (P5r-5, ~93 LOC)

**Purpose:** factory for `sendLifecycleDM`, the Telegram DM helper
shared by `schedulers/lifecycle.ts` and `schedulers/pro-renewal.ts`.
Lives in `services/` because it has cross-scheduler consumers.

**Exports:**
- `type SendDmOutcome` — `'delivered' | 'bot_blocked' | 'chat_not_found' | 'permanent_failure' | 'transient_failure'`.
- `type SendLifecycleDM = (chatId: string, text: string, webAppUrl?: string) => Promise<SendDmOutcome>`.
- `function createSendLifecycleDM({ botToken, logger }): SendLifecycleDM`.

**Behaviour:** `POST https://api.telegram.org/bot<TOKEN>/sendMessage`
with `parse_mode: 'HTML'` and a single inline `web_app` button. Classifies
Telegram-side rejection: `403` → `bot_blocked`, `400` + 'chat not found' /
'user is deactivated' → `chat_not_found`, `429` or `5xx` →
`transient_failure`, other 4xx → `permanent_failure`.

### `services/birthday-reminders.ts` (P5r-6, ~106 LOC)

**Purpose:** pure helpers for birthday timezone math + display name
picking. Lives in `services/` because two of them
(`daysUntilNextBirthday`, `pickBirthdayDisplayName`) are consumed by
both `routes/birthday-reminders.routes.ts` and
`schedulers/birthday-reminders.ts`.

**Exports:**
- `BIRTHDAY_TZ_OFFSET_HOURS: number = 3` — MSK offset.
- `getMskBirthdayDay`, `getMskToday`, `daysUntilNextBirthday`,
  `buildOccurrenceKey`, `nextMskMorning`, `pickBirthdayDisplayName`.

### `services/entitlement.ts` (P5s-1, ~280 LOC + `requireGiftNotes` appended in P5s-5)

**Purpose:** plan limits, pricing, SKU catalogue, add-on caps, and the
entitlement resolvers (`getUserEntitlement`, `getEffectiveEntitlements`,
`isWishlistWritable`) plus the small reservation/smart-res predicate
helpers. After P5s-5 also hosts `requireGiftNotes` (the gift-notes
feature gate that calls `trackEvent`, deferred from P5s-1).

**Exports include:** `PLANS`, `PRO_PRICE_XTR`, `PRO_YEARLY_PRICE_XTR`,
`PRO_SUBSCRIPTION_PERIOD`, `PRO_YEARLY_EXTEND_SECONDS`, `PRO_PLAN_CODE`,
`GIFT_NOTES_PRICE_XTR`, `GIFT_NOTES_SKU`, `GROUP_GIFT_PRICE_XTR`,
`GROUP_GIFT_SKU`, `SECRET_RESERVATION_PRICE_XTR`, `SECRET_RESERVATION_SKU`,
`ONE_TIME_SKUS`, `ADDON_CAPS`, `isReservationBeta`, `hasReservationPro`,
`getSmartResLeadHours`, `hasSmartReservations`, `getUserEntitlement`,
`getEffectiveEntitlements`, `isWishlistWritable`, `requireGiftNotes`,
plus the canonical return-shape types.

### `services/telegram-auth.ts` (P5s-2, ~250 LOC)

**Purpose:** Telegram initData identity service. Single source of truth
for HMAC validation, actor-hash derivation, the auth middleware, and
the User upsert used by every authenticated route handler.

**Exports:** `validateTelegramInitData`, `tgActorHash`,
`requireTelegramAuth`, `getOrCreateTgUser`, `INIT_DATA_MAX_AGE_SECONDS`,
`INIT_DATA_CLOCK_SKEW_SECONDS`, `SYSTEM_ACTOR_HASH`, `TelegramUser` type.

**Note:** `protectTgRoute`, `idem`, `billingIdem`, the `tgRouter`
instance, the 165 `protectTgRoute(...)` registrations, and the
`Express.Request.tgUser?` global type augmentation **stay in
index.ts** by design (composition-root concern; `protectTgRoute` closes
over `tgRouter` via lexical scope).

### `services/onboarding.ts` (P5s-3, ~310 LOC)

**Purpose:** the `hello_activation` onboarding state machine — variant
assignment, demo-item dictionaries, eligibility, dismissal, completion.

**Exports:** `ONBOARDING_KEY`, `ONBOARDING_VERSION`, `RU_VARIANTS`,
`GLOBAL_VARIANTS`, `FORCED_ROLLOUT_USERS`, `resolveMarketSegment`,
`variantKeyToSegment`, `assignOnboardingVariant`, `getDemoTemplate`,
`isDemoItemUntouched`, `isMeaningfulEdit`, `checkOnboardingEligibility`,
`countRealItemsForActivation`, `hasDraftsUserContent`, plus types
(`VariantKey`, `MarketSegment`, `CompletionReason`, `DemoItemTemplate`,
`EligibilityResult`) and demo-item records (`DEMO_ITEMS`,
`GLOBAL_DEMO_ITEMS`).

**Factory:** `createCompleteOnboarding({ trackEvent })` — closes over
`trackEvent` (in `services/analytics.ts`); index.ts wires the resulting
function and threads it through onboarding/items routers via deps.

### `services/santa-season.ts` (P5s-4, ~382 LOC)

**Purpose:** Secret Santa season window math, anonymous alias system,
seasonal broadcast pipeline.

**Exports:** `getSeasonStartYear`, `getSeasonCalendar`,
`getSantaSeasonInfo`, `SANTA_ADJECTIVES`, `SANTA_ANIMALS`,
`SANTA_ADJ_KEYS`, `SANTA_ANIMAL_KEYS`, `santaSeededRng`, `santaHashStr`,
`santaShuffle`, `generateSantaAliases`, `sendSeasonalBroadcast`,
`maybeRunSeasonalEvents`.

**Off-season note:** extracted in May 2026 (off-season). All paths are
byte-identical with stable already-extracted deps. `runSantaStartupJobs`
exercises the alias chain on every boot; `maybeRunSeasonalEvents` is
called hourly by `schedulers/santa.ts` (silent early-return outside
Nov 1 / Feb 1 dates).

### `services/analytics.ts` (P5s-5, ~75 LOC)

**Purpose:** the two analytics-event helpers — `trackEvent` (logs +
conditional Prisma persist gated by 11-prefix allowlist) and
`trackAnalyticsEvent` (allowlist from `@wishlist/shared` + truncation +
unconditional persist).

**Module-state:** `ANALYTICS_EVENTS_SET` (immutable Set built once at
import time). **No buffer, no flush timer, no shutdown drain** — every
call is a fire-and-forget atomic `prisma.analyticsEvent.create(...).catch(...)`.

### `services/referral-hooks.ts` (P5s-5, ~180 LOC)

**Purpose:** the post-milestone referral pipeline (qualify → reward →
notify inviter) and the proactive locale resolver used by referral
notifications.

**Exports:** `notifyReferralInviterRewarded`, `runReferralProgressHook`.
`resolveProactiveUserLocale` is module-private (only consumer is
`notifyReferralInviterRewarded`).

**Cross-service dependency:** imports `trackAnalyticsEvent` directly
from `./analytics`. One-way coupling.

### `services/items.ts` (P5s-6, ~250 LOC)

**Purpose:** item-domain helpers used across many routers — mappers,
hints cancellation, subscriber notifications, placement counters, role
resolution.

**Exports:** `ACTIVE_STATUSES`, `cancelItemHints`,
`notifySubscribersOfChange`, `countItemPlacements`, `extractNumericPrice`,
`priorityToNum`, `numToPriority`, `mapTgItem`, `getItemRole`,
`type ItemRole`.

### `services/wishlists.ts` (P5s-7, ~50 LOC)

**Purpose:** wishlist-domain helpers — primary-placement reassignment
on delete, drafts wishlist factory, drafts capacity constant.

**Exports:** `DRAFTS_ITEM_LIMIT`, `reassignPrimaryBeforeWishlistDelete`,
`createGetOrCreateDraftsWishlist({ trackEvent })` factory.
`isWishlistWritable` lives in `services/entitlement.ts` (P5s-1).

### `services/calendar.ts` (P5s-8, ~30 LOC)

**Purpose:** three pure date-arithmetic helpers for the Events Calendar
/ Gift Notes feature.

**Exports:** `getNextOccurrenceDate`, `computeReminderSchedule`,
`buildReminderEpisodeKey`. No Prisma, no fetch, no logger — only native
Date math + string formatting.

### `services/url-import.ts` (P5s-9, ~85 LOC)

**Purpose:** the URL → draft-item flow. Parses the URL via
`./url-parser.js`, enforces the SYSTEM_DRAFTS capacity cap, creates the
Item with dual-placement write, fires `item_created` analytics.

**Factory:** `createImportUrlForUser({ trackEvent, getOrCreateDraftsWishlist })` —
closes over both deps. Index.ts wires the result and threads it through
`registerImportRouter`, `registerInternalRouter`, `registerOnboardingRouter`
via existing factory deps.

### `services/locale.ts` (P5s-10, ~30 LOC)

**Purpose:** `resolveUserFirstName` — best-effort resolver that returns
a user's first_name, falling back to Telegram Bot API `getChat` if the
firstName field is empty, then caching the result on the User row.

**Sole consumer:** `routes/reservations.routes.ts`.

---

## 3. Pattern: import directly vs receive via deps

| Service | Routers consume via | Why |
|---|---|---|
| `entitlement` | direct import | Stable API, used in 20+ files. |
| `telegram-auth` | direct import | Same. |
| `onboarding` | hybrid: 12 direct, `completeOnboarding` via deps | Pure helpers go direct; the factory-wired one preserves deps contract. |
| `santa-season` | deps factory | 5 helpers in santa.routes.ts deps + 2 in santa scheduler deps; signatures stable. |
| `analytics` | deps factory | Cross-cutting; preserves existing 21+ deps signatures. |
| `referral-hooks` | deps factory | Same. |
| `items` | deps factory | Closely paired with router-specific business logic. |
| `wishlists` | deps factory | Same. |
| `calendar` | direct import | Three pure functions. |
| `url-import` | deps factory | Single function but 3 router consumers; factory closure keeps `trackEvent` + drafts wiring centralised. |
| `locale` | direct import | Single function, single consumer. |
| `lifecycle` | deps factory | Factory closing over botToken+logger. |
| `birthday-reminders` | direct import | Pure utilities. |

The blanket pattern: **Strategy A (deps preserved)** when fan-out is
high or when the helper closes over a runtime dep that lives in
index.ts; **Strategy B (direct import)** when the helper is pure and
the consumer count is small.

---

## 4. Risk classification — historical

The order of P5s extractions mattered. Lower-risk first, then attack
the cross-cutting cores. Final order shipped:

1. **`entitlement`** — biggest single LOC reduction; high fan-out but
   well-bounded behaviour.
2. **`telegram-auth`** — auth core, shipped after entitlement was stable.
3. **`onboarding`** — clean boundary, conversion-critical.
4. **Combined PR (calendar + locale + wishlists + onboarding-deps + items)** —
   small/safe + medium-risk in one combined extraction PR.
5. **`url-import`** — small, after combined PR's services were available.
6. **`analytics + referral-hooks`** — deferred until last in the
   cross-cutting set; turned out to be stateless extract (no buffer/timer
   migration needed; original audit assumption was wrong).
7. **`santa-season`** — last; off-season window in May 2026 made the
   deferred-confidence path acceptable.

Each PR followed the established pattern:
audit → user confirmation → byte-identical extraction → verify (TS +
build + tests) → commit → deploy → immediate health → first-tick (or
analogous) check.

**Composition-root invariants preserved across all 11 P5s commits:**
- `protectTgRoute` count: **165** (Wave-2 closure adds; not P5s-related)
- `register*Router` count: **24** unchanged
- Inline `tg` handlers: **0** unchanged
- Actual scheduler calls in index.ts: **0** unchanged
- Bot/web/packages/Prisma schema: **0 lines diff** across P5s

---

## 5. P5s extraction track — closure

**Status: 100% complete as of 2026-05-07.**

| Stage | Service | Status |
|---|---|---|
| P5s-1 | entitlement | ✓ done |
| P5s-2 | telegram-auth | ✓ done |
| P5s-3 | onboarding | ✓ done |
| P5s-4 | santa-season | ✓ done |
| P5s-5 | analytics + referral-hooks (+ requireGiftNotes append) | ✓ done |
| P5s-6 | items | ✓ done |
| P5s-7 | wishlists | ✓ done |
| P5s-8 | calendar | ✓ done |
| P5s-9 | url-import | ✓ done |
| P5s-10 | locale | ✓ done |

There is no further P5s phase. Future helper extractions are governed
by the on-touch rule (**§ When to extract a helper into `services/`**
in `API_ARCHITECTURE_RULES.md`): if a new helper hits 3+ consumers OR
crosses scheduler/route boundary, it goes to `services/<name>.ts`. The
extraction track itself is **closed**.

---

## Pointers

- API architecture rules: [API_ARCHITECTURE_RULES.md](API_ARCHITECTURE_RULES.md).
- Refactor decomposition history: [REFACTOR_API_INDEX_HANDOFF.md](REFACTOR_API_INDEX_HANDOFF.md).
- Sibling layer for cron jobs: [SCHEDULERS.md](SCHEDULERS.md).
- Routes inventory: [BACKEND_MAP.md](BACKEND_MAP.md).
