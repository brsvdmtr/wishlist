# API Services

**Last updated:** 2026-05-06 (after P5r-6) · **Owner:** backend

The `services/` layer holds cross-cutting helpers that don't belong to a
single route module. Currently two services exist (created during P5r-5
and P5r-6 to back the lifecycle and birthday-reminders schedulers); a
larger P5s service-extraction wave is planned to drain ~50 helper
functions still inline in `apps/api/src/index.ts`.

`services/` is the canonical home for:

- Helpers consumed by **3+ routers / schedulers**.
- Pure utilities that are pivotal enough to warrant a dedicated module
  (e.g. timezone math used by both routes and a scheduler).
- Stateless functions that wrap a side effect (e.g. a Telegram DM
  factory closing over the bot token + logger).

It is **not** the right home for:

- Single-router business logic (that stays in `routes/<domain>.routes.ts`
  or moves to `services/<domain>.service.ts` only when handler size
  passes the ~80–120 LOC smell test).
- Pure JSON parsing or schema-only utilities (those live in `lib/` —
  asyncHandler, http, locale, crypto).
- Telegram Bot API send wrappers that already exist in `telegram/`
  (botApi.ts, deepLinks.ts, html.ts, invoiceLink.ts).

---

## 1. Existing services

### `services/lifecycle.ts` (P5r-5, ~93 LOC)

**Purpose:** factory for `sendLifecycleDM`, the Telegram DM helper
shared by `schedulers/lifecycle.ts` and `schedulers/pro-renewal.ts`.
Lives in `services/` because it has cross-scheduler consumers.

**Exports:**
- `type SendDmOutcome` — `'delivered' | 'bot_blocked' | 'chat_not_found' | 'permanent_failure' | 'transient_failure'`.
- `type SendLifecycleDM = (chatId: string, text: string, webAppUrl?: string) => Promise<SendDmOutcome>`.
- `function createSendLifecycleDM({ botToken, logger }): SendLifecycleDM`.

**Behaviour:**
- `POST https://api.telegram.org/bot<TOKEN>/sendMessage` with
  `parse_mode: 'HTML'` and a single inline `web_app` button
  (`'Открыть WishBoard ✨'`) if `webAppUrl` is provided.
- Classifies Telegram-side rejection: `403` → `bot_blocked`,
  `400` + 'chat not found' / 'user is deactivated' → `chat_not_found`,
  `429` or `5xx` → `transient_failure`, other 4xx → `permanent_failure`.
- Network errors → `transient_failure` (always retryable next cycle).
- Logs `'lifecycle DM rejected by Telegram'` (warn) on TG-side rejects;
  `'lifecycle DM fetch error (transient)'` (warn) on network errors.
  Returns `permanent_failure` when bot token or chat ID is empty.

**Consumers:**
- `schedulers/lifecycle.ts` — main consumer (every win-back DM).
- `schedulers/pro-renewal.ts` — secondary consumer (renewal reminders).

**Why not `telegram/`?** The existing `telegram/botApi.ts` exposes
`sendTgNotification` (boolean-returning) and `sendTgBotMessage`
(boolean-returning, with reply markup). `sendLifecycleDM` predates
those API shapes and returns the structured `SendDmOutcome` so the
caller can distinguish bot-blocked permanent failures from retryable
transient ones. The two API shapes have not been merged. P5s may
reconsider.

---

### `services/birthday-reminders.ts` (P5r-6, ~106 LOC)

**Purpose:** pure helpers for birthday timezone math + display name
picking. Lives in `services/` because two of them
(`daysUntilNextBirthday`, `pickBirthdayDisplayName`) are consumed by
both `routes/birthday-reminders.routes.ts` (resolve-deeplink handler)
and `schedulers/birthday-reminders.ts` (the cron + delivery logic).

**Exports:**
- `BIRTHDAY_TZ_OFFSET_HOURS: number = 3` — MSK offset; matches
  `GiftOccasionReminder` cron.
- `getMskBirthdayDay(birthday)` — returns `{ month, day }` in MSK or
  `null` if no birthday.
- `getMskToday(now)` — returns `{ year, month, day, hour }` in MSK.
- `daysUntilNextBirthday(birthday, now)` — 0..365 or `null`. Handles
  Feb-29 → Feb-28 collapse in non-leap years.
- `buildOccurrenceKey(birthday, todayMsk, offsetDays)` — `YYYY-MM-DD`
  string used in the `BirthdayReminderDelivery` unique constraint.
  Handles Feb-29 collapse.
- `nextMskMorning(now)` — Date pointing at the next MSK 10:00, used
  for `deferredUntil` on daily-cap-deferred deliveries.
- `pickBirthdayDisplayName({ displayName, username, firstName })` —
  fallback chain returning the displayable name (or `'WishBoard'`).

**Behaviour:** all pure, no Prisma / Telegram / logger access. Module
exposes only typed functions and the offset constant.

**Consumers:**
- `routes/birthday-reminders.routes.ts` — resolve handler (uses
  `daysUntilNextBirthday` + `pickBirthdayDisplayName`).
- `schedulers/birthday-reminders.ts` — uses all six helpers + offset
  const.
- `index.ts` — imports `daysUntilNextBirthday` and
  `pickBirthdayDisplayName` to thread them through to the routes
  factory (preserves the P5e factory contract).

**Why include `BIRTHDAY_TZ_OFFSET_HOURS` here despite the audit
calling it a scheduler-internal const?** All five other helpers in
this file reference it, plus `recipientHitDailyCap` in the scheduler
imports it from here. Placing it adjacent to the helpers that use it
keeps the service module self-contained and avoids a
scheduler→service circular concern.

---

## 2. Planned P5s services

The list below summarises the P5s extraction roadmap from the
post-P5r audit. **Not yet implemented.** Each entry records what
would move out of `apps/api/src/index.ts`, current consumers, and
risk.

Status legend: 🟢 low risk · 🟡 medium · 🔴 high · 🟣 highest
(touches every request path).

| Service | What moves | Consumers (count) | Δ LOC | Risk |
|---|---|---|---|---|
| `services/entitlement.ts` | `getUserEntitlement`, `getEffectiveEntitlements`, `requireGiftNotes`, `isReservationBeta`, `hasReservationPro`, `getSmartResLeadHours`, `hasSmartReservations`, `PLANS`, `PRO_PRICE_XTR`, `PRO_YEARLY_PRICE_XTR`, `PRO_SUBSCRIPTION_PERIOD`, `PRO_YEARLY_EXTEND_SECONDS`, `PRO_PLAN_CODE`, `GIFT_NOTES_PRICE_XTR`, `GIFT_NOTES_SKU`, `GROUP_GIFT_PRICE_XTR`, `GROUP_GIFT_SKU`, `SECRET_RESERVATION_PRICE_XTR`, `SECRET_RESERVATION_SKU`, `ONE_TIME_SKUS`, `ADDON_CAPS` | ~20+ files (most routers, billing + lifecycle + birthday schedulers) | ~280 | 🔴 cross-cutting; entitlement bug = paywall regression |
| `services/telegram-auth.ts` | `validateTelegramInitData`, `tgActorHash`, `requireTelegramAuth`, `protectTgRoute`, `getOrCreateTgUser`, `INIT_DATA_MAX_AGE_SECONDS`, `INIT_DATA_CLOCK_SKEW_SECONDS`, `SYSTEM_ACTOR_HASH` | every router, every protected route | ~250 | 🟣 auth chain — bug = mass-401 or auth bypass |
| `services/onboarding.ts` | `resolveMarketSegment`, `variantKeyToSegment`, `assignOnboardingVariant`, `getDemoTemplate`, `countRealItemsForActivation`, `hasDraftsUserContent`, `checkOnboardingEligibility`, `isDemoItemUntouched`, `isMeaningfulEdit`, `completeOnboarding`, `ONBOARDING_KEY`, `ONBOARDING_VERSION`, `FORCED_ROLLOUT_USERS` | `routes/onboarding.routes.ts`, `routes/items.routes.ts`, possibly `routes/me.routes.ts` | ~300 | 🟡 clear domain boundary; onboarding is conversion-critical |
| `services/santa-season.ts` | `getSeasonStartYear`, `getSeasonCalendar`, `getSantaSeasonInfo`, `santaSeededRng`, `santaHashStr`, `santaShuffle`, `generateSantaAliases`, `sendSeasonalBroadcast`, `maybeRunSeasonalEvents`, `recordMaintenanceExposure`, `SANTA_ADJ_KEYS`, `SANTA_ANIMAL_KEYS` (and `SANTA_ADJECTIVES`/`SANTA_ANIMALS` dictionaries) | `routes/santa.routes.ts`, `schedulers/santa.ts`, `runSantaStartupJobs` | ~600 | 🟡 offseason — low live risk |
| `services/items.ts` | `countItemPlacements`, `getItemRole`, `mapTgItem`, `cancelItemHints`, `notifySubscribersOfChange`, `extractNumericPrice`, `priorityToNum`, `numToPriority`, `ACTIVE_STATUSES` | `routes/items.routes.ts`, `routes/comments.routes.ts`, `routes/reservations.routes.ts`, `routes/santa.routes.ts` | ~250 | 🟡 used in many handlers |
| `services/wishlists.ts` | `reassignPrimaryBeforeWishlistDelete`, `isWishlistWritable`, `getOrCreateDraftsWishlist`, `DRAFTS_ITEM_LIMIT` | `routes/wishlists.routes.ts`, `routes/items.routes.ts` | ~150 | 🟢 |
| `services/analytics.ts` + `services/referral-hooks.ts` | `trackEvent`, `trackAnalyticsEvent`, `notifyReferralInviterRewarded`, `runReferralProgressHook`, `resolveProactiveUserLocale`, `ANALYTICS_EVENTS_SET` | every router + most schedulers | ~300 | 🔴 every callsite |
| `services/calendar.ts` | `getNextOccurrenceDate`, `computeReminderSchedule`, `buildReminderEpisodeKey` | `routes/gift-notes.routes.ts`, `schedulers/events.ts` | ~30 | 🟢 three pure functions |
| `services/url-import.ts` | `importUrlForUser` | `routes/items.routes.ts` (URL prefill flow), `routes/internal.routes.ts` | ~150 | 🟡 touches marketplace strategies |
| `services/locale.ts` | `resolveUserFirstName` | `notifications/`, reservation flows, scattered places | ~30 | 🟢 |

**Total potential reduction:** ~2340 LOC out of the remaining
3110 LOC in `apps/api/src/index.ts`. Target post-P5s: ~770 LOC of
true composition root (bootstrap + 24 router mounts + 9 scheduler
mounts + `app.listen` + process handlers).

---

## 3. Pattern: import directly vs receive via deps

| Service | Routers consume via | Why |
|---|---|---|
| `entitlement` | direct import | Stable API, used in 20+ files; threading through deps is pure indirection. |
| `telegram-auth` | direct import | Same. |
| `onboarding` | direct import | Three consumers, but the helpers are stateless. |
| `santa-season` | direct import | Used by routes + scheduler; same justification. |
| `analytics` + `referral-hooks` | direct import | Cross-cutting. |
| `calendar` | direct import | Three pure functions. |
| `url-import` | direct import | Single function; clearer when imported. |
| `locale` | direct import | Pure utility. |
| `items` | **continue via deps** | Closely paired with router-specific business logic; dep injection makes them testable per-router. |
| `wishlists` | **continue via deps** | Same. |

Existing services (`lifecycle`, `birthday-reminders`) follow this
matrix already: lifecycle is a factory passed via deps to two
schedulers (because it closes over bot token + logger);
birthday-reminders pure helpers are imported directly by both routes
and scheduler.

---

## 4. Risk classification — global

The order of P5s extractions matters. **Lower-risk first, then attack
the auth core.**

Recommended order (matches the post-P5r audit):

1. `entitlement` — biggest single LOC reduction; high fan-out but
   well-bounded behaviour. Get it shipped + monitored.
2. `telegram-auth` — only after entitlement is stable. Auth is the
   highest-stakes change in the P5s series.
3. `onboarding` — clean boundary, conversion-critical so deploy
   during low-traffic window if possible.
4. `santa-season` — offseason; safe.
5. `items` / `wishlists` / `analytics` / `referral-hooks` / `calendar` /
   `url-import` / `locale` — opportunistic; no global ordering required.

Each PR follows the established P5r pattern:
audit → user confirmation → byte-identical extraction → verify (TS +
build + tests) → commit → deploy → immediate health → first-tick (or
analogous) check.

---

## Pointers

- API architecture rules: [API_ARCHITECTURE_RULES.md](API_ARCHITECTURE_RULES.md).
- Active refactor handoff: [REFACTOR_API_INDEX_HANDOFF.md](REFACTOR_API_INDEX_HANDOFF.md).
- Sibling layer for cron jobs: [SCHEDULERS.md](SCHEDULERS.md).
- Existing routes inventory: [BACKEND_MAP.md](BACKEND_MAP.md).
