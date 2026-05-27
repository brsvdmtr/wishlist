# MONETIZATION

> Source of truth for plans, limits, entitlements, billing flow, and paywall content.
> Last updated: 2026-05-22 · Branch: main

---

## 1. Plans

| | **FREE** | **PRO Monthly** | **PRO Yearly** | **PRO Lifetime** |
|---|---|---|---|---|
| **Code** | `FREE` | `PRO` | `PRO` | `PRO` |
| **Price** | — | 100 Telegram Stars / month | 800 Telegram Stars (one-time) | 2 490 Telegram Stars (one-time) |
| **Renewal** | — | Auto-renew (soft cancel: access until period end) | No auto-renewal; manual renewal required | None — permanent entitlement |
| **Duration** | — | 30 days per period | 365 days (one-time payment) | Forever |
| **Savings** | — | — | ~33% vs 12 monthly payments | One-time replaces all future renewals |

**Yearly plan** is a non-recurring Telegram Stars invoice. When paid, the bot extends `Subscription.currentPeriodEnd` by `PRO_YEARLY_EXTEND_SECONDS` (default: 31 536 000 = 365 days). Yearly subscriptions and monthly ones with `cancelAtPeriodEnd=true` receive bot renewal reminder DMs at 7 days and 1 day before expiry.

**Lifetime plan** is a non-recurring Telegram Stars invoice that grants permanent Pro. The bot writes a `Subscription` row with `billingPeriod='lifetime'`, `currentPeriodEnd = 2099-12-31` (sentinel), `cancelAtPeriodEnd = false`. Lifetime overrides any prior monthly/yearly row on upsert; once active, subsequent `pro_monthly` / `pro_yearly` charges (e.g. a still-active Telegram-side monthly auto-renewal) are recorded as `payment_success_post_lifetime` PaymentEvents and do **not** downgrade the Subscription. Lifetime never receives renewal reminders and is excluded from the subscription-expiry sweep cron via an explicit `billingPeriod !== 'lifetime'` filter (defensive — the sentinel date already keeps it out of the window).

All limits and feature flags are defined in a single constant in `apps/api/src/index.ts`:

```typescript
const PLANS = {
  FREE: {
    code: 'FREE',
    wishlists: 2,
    items: 20,
    participants: 10,
    subscriptions: 2,
    features: [],
  },
  PRO: {
    code: 'PRO',
    wishlists: 10,
    items: 70,
    participants: 20,
    subscriptions: 5,
    features: ['comments', 'url_import', 'hints'],
  },
};
```

**This is the single source of truth for all numeric limits and feature flags.**
Price and period are configurable via env vars: `PRO_PRICE_XTR` (default: 100), `PRO_SUBSCRIPTION_PERIOD` (default: 2592000 = 30 days).

---

## 2. PRO Benefits (Paywall — 13 items)

These 13 items are shown on the paywall and in the "What you unlock with Pro" block.
They are rendered via **`getProBenefits(locale)`** in `apps/web/app/miniapp/MiniApp.tsx`.
Text is sourced from `packages/shared/src/i18n.ts` keys `plan_pro_f1`–`plan_pro_f14` (titles) and `plan_pro_sub1`–`plan_pro_sub14` (subtitles).

| # | Key | Title (RU) | Subtitle (RU) | Gate |
|---|-----|-----------|---------------|------|
| 1 | `plan_pro_f1` | До 10 вишлистов | Разделяй желания по событиям, людям и поводам. | server (count >= plan.wishlists → 402) |
| 2 | `plan_pro_f2` | До 70 желаний в каждом | Больше места для хотелок без лишних ограничений. | server (count >= plan.items → 402) |
| 3 | `plan_pro_f3` | До 20 участников | Собирай друзей и близких в одном вишлисте. | server (distinct reservers → 402) |
| 4 | `plan_pro_f4` | Комментарии к желаниям | Обсуждайте подарок прямо в карточке. | server (`features.includes('comments')` → 402) |
| 5 | `plan_pro_f5` | Добавление по ссылке | Ozon, Wildberries, Яндекс Маркет, Lamoda, Goldapple и другие. | server — FREE 5 импортов/мес, далее 402 upsell; PRO без лимита (`import-credits.ts`) |
| 6 | `plan_pro_f6` | Намекнуть на подарок | Подскажи друзьям конкретную идею деликатно и быстро. | server (`features.includes('hints')` → 402) |
| 7 | `plan_pro_f7` | До 5 подписок на вишлисты друзей | Следи за изменениями у друзей и получай обновления. | server (count >= plan.subscriptions → 402) |
| 8 | `plan_pro_f8` | Расширенная приватность | Управляй видимостью, подписками и комментариями в своих вишлистах. | server (isPro check → 403) |
| 10 | `plan_pro_f10` | История броней | Все прошлые и завершенные бронирования в одном месте. | server (hasReservationPro → 402 `pro_required`) |
| 11 | `plan_pro_f11` | Заметки к подаркам | Личные записки к забронированным желаниям — видишь только ты. | server (hasReservationPro → 402 `pro_required`) |
| 12 | `plan_pro_f12` | Напоминания о броне | Поставь напоминание, чтобы не забыть купить или вручить подарок. | server (hasReservationPro → 402 `pro_required`) |
| 13 | `plan_pro_f13` | Статус «Уже купил» | Отмечай купленные подарки и держи всё под контролем. | server (hasReservationPro → 402 `pro_required`) |
| 14 | `plan_pro_f14` | Фильтры и сортировка броней | Находи нужную бронь за секунду среди десятков подарков. | client flag `reservationPro` + server gate on actions |

---

## 3. Server-Side Enforcement (All Confirmed)

All limits and feature gates are **enforced server-side**. The client performs pre-checks for UX (showing upsell early), but bypass without a real PRO subscription is not possible.

### Numeric limits → HTTP 402

| Check | Endpoint | Logic |
|-------|----------|-------|
| Wishlist count | `POST /tg/wishlists` | `count >= plan.wishlists` |
| Item count per list | `POST /tg/wishlists/:id/items` | `itemCount >= plan.items` |
| Participants per list | `POST /tg/items/:id/reserve` | distinct `reserverUserId` count |
| Friend subscriptions | `POST /tg/wishlists/:id/subscribe` | `count >= plan.subscriptions` |

### Feature flags → HTTP 402 / 403

| Feature | Endpoint | Check |
|---------|----------|-------|
| Comments | `POST /tg/items/:id/comments` | `features.includes('comments')` — both sides, either-or |
| URL Import | `POST /tg/import-url` | credit-gated — `getImportAllowance()`: PRO unlimited; FREE 5/mo + paid `importCredits`; else 402 `import_quota_exhausted` |
| Hints | `POST /tg/items/:id/hint` | `features.includes('hints')` |
| Visibility `PUBLIC_PROFILE` / `PRIVATE` | `PATCH /tg/wishlists/:id` | `isPro` → 403 |
| `allowSubscriptions=NOBODY` | `PATCH /tg/wishlists/:id` | `isPro` → 403 |
| `commentPolicy=SUBSCRIBERS` | `PATCH /tg/wishlists/:id` | `isPro` → 403 |
| Notification settings (comments, subscriptions) | `PATCH /tg/me/settings` | `isPro` — silently ignored if FREE |
| New wishlist position `bottom` | `PATCH /tg/me/settings` | `isPro` — silently ignored if FREE |
| Showcase (public profile page) | `PATCH /tg/me/showcase` | `isPro` → 403 |
| Curated Selections | `POST /tg/curated-selections` | `isPro` → 403 |
| Profile Subscriptions | `POST /tg/profiles/:id/subscribe` | `isPro` → 403 |
| Birthday Reminders advanced (audience EXTENDED, primary wishlist, custom message, 7d/1d friend + 14d/7d owner windows) | `PATCH /tg/me/birthday-settings` | `isPro` → 402 `{ error: 'pro_required', feature: 'birthday_reminders_advanced', context: '<field>' }` |
| Secret Santa multi-wave campaign | `POST /tg/santa/campaigns` (type `MULTI_WAVE`) | `isPro` → 402 `{ error: 'pro_required', feature: 'santa_multi_wave' }` |
| Secret Santa exclusion pairs | `POST /tg/santa/campaigns/:id/exclusions` | `isPro` → 402 `{ error: 'pro_required', feature: 'santa_exclusions' }` |
| Secret Santa exclusion groups | `POST /tg/santa/campaigns/:id/exclusions/groups` (+ `.../groups/:gid/members`) | `isPro` → 402 `{ error: 'pro_required', feature: 'santa_exclusion_groups' }` |

### Reservation PRO — `hasReservationPro()` cluster

**Contract (since 2026-05-24):** the full Reservation PRO cluster — history,
private notes, reminders, "purchased" flag, filters & sort — is unlocked by
EITHER

1. **An active PRO subscription** (monthly / yearly / lifetime / promo-PRO),
2. **One-time add-on `reservation_pro_unlock`** (50 ⭐, permanent — for FREE
   users who want the cluster without committing to PRO), or
3. **`godMode`** (admin override).

The paywall **promises** these five features (PRO benefits cards
`plan_pro_f10..f14` + the add-on `addon_desc_reservation_pro_unlock`); the
backend **delivers** the same set via `hasReservationPro(user, isPro, addOns)`
in [`apps/api/src/services/entitlement.ts`](../apps/api/src/services/entitlement.ts).
There is no longer a beta gate — the previous `isReservationBeta()` /
`RESERVATION_PRO_BETA_IDS` env var was retired once the feature opened to all.

Gate emits `feature_gate_hit_reservation_pro` with `{ feature: <sub-feature> }`
props for funnel attribution. Centralised by `requireReservationPro()` in
[`apps/api/src/routes/reservations.routes.ts`](../apps/api/src/routes/reservations.routes.ts).

| Feature | Endpoint | Check on miss |
|---------|----------|---------------|
| Reservation history | `GET /tg/reservations/history` | `requireReservationPro()` → 402 `{ error: 'pro_required', feature: 'reservation_history' }` |
| Private notes | `PATCH /tg/reservations/:itemId/meta` | `requireReservationPro()` → 402 `{ error: 'pro_required', feature: 'reservation_meta' }` |
| Purchased flag | `PATCH /tg/reservations/:itemId/meta` | Same gate as private notes (same endpoint) |
| Reminders | `POST /tg/reservations/:itemId/reminder` | `requireReservationPro()` → 402 `{ error: 'pro_required', feature: 'reservation_reminder' }` |
| Filters & sort | Client-side toggle | `reservationPro` flag from `GET /tg/me` / `GET /tg/reservations` — same `hasReservationPro()` result |

Status code is **402** (Payment Required) — not 403 — because the feature can
be purchased. Frontend reads `reservationPro` from `/tg/me` to decide
upsell-vs-feature; bot has no Reservation PRO consumer (URL-import is the
only bot-facing 402 path).

### Client-only gate (no server enforcement)

| Feature | Location | Note |
|---------|----------|------|
| Recommended guest sort | `apps/web/app/miniapp/MiniApp.tsx` | `pro: true` chip; upsell shown to FREE; no server check. Low risk (requires custom client to bypass). Not advertised on paywall. |

---

## 4. Entitlement Resolution

Function: `getUserEntitlement(userId, godMode?)` — `apps/api/src/index.ts`

### Base Entitlement — `getUserEntitlement(userId, godMode?)`

**Resolution order (priority):**
1. Active `Subscription` with `planCode='PRO'`, `status IN ('ACTIVE','CANCELLED')`, `currentPeriodEnd > now()` → `proSource: 'subscription'`. Lifetime is the highest-priority sub because each user has at most one `Subscription` row (`@@unique([userId, planCode])`); `pro_lifetime` payments upsert and overwrite any monthly/yearly row, leaving `billingPeriod='lifetime'` as the resolver's view of truth.
2. Active `PromoRedemption` with `status='ACTIVE'`, not expired → `proSource: 'promo'`
3. `godMode=true` (user's `telegramId` in `GOD_MODE_TELEGRAM_IDS` env) → `proSource: 'god_mode'`
4. Otherwise → `PLANS.FREE`, `isPro: false`

**Lifetime discriminator:** `subscription.billingPeriod === 'lifetime'`. UI and downstream services MUST use this field — never compare `currentPeriodEnd` against a far-future heuristic. `proSource` stays `'subscription'` for lifetime users (semantically lifetime IS a subscription, just with no expiry).

**Lifetime + active promo PRO co-existence.** A user can have both an active `PromoRedemption` (granted PRO via a campaign code) and a paid lifetime `Subscription` row. The resolver's priority order picks the paid subscription first, so the user reads as `proSource: 'subscription'` and `subscription.billingPeriod = 'lifetime'`. The `promoPro` field on the response is still populated from the live `PromoRedemption` so downstream UI (Settings promo block) keeps showing the original campaign acknowledgement; this is intentional — losing the promo display on a paid upgrade would feel like a regression. Revoking the promo administratively does not affect lifetime entitlement.

### Effective Entitlements — `getEffectiveEntitlements(userId, godMode?)`

Two-layer system. Base plan (from `getUserEntitlement`) is augmented with add-ons and credits:

```
effectiveWishlistLimit      = plan.wishlists + Σ(UserAddOn where addonType='wishlist_slot')
effectiveSubscriptionLimit  = plan.subscriptions + Σ(UserAddOn where addonType='subscription_slot')
extraItemsPerWishlist[wId]  = Σ(UserAddOn where addonType IN ('item_slot_5','item_slot_15') AND targetId=wId)
hintCredits                 = UserCredits.hintCredits (PRO bypasses)
importCredits               = UserCredits.importCredits (PRO bypasses)
hasGiftNotes                = isPro OR UserAddOn(addonType='gift_notes_unlock') exists
hasSecretReservation        = UserAddOn(addonType='secret_reservation_unlock') exists
hasSmartReservations[wId]   = UserAddOn(addonType='smart_reservations_unlock' AND targetId=wId) exists
```

**God Mode:** Virtual PRO for testing/development. Activated via `GOD_MODE_TELEGRAM_IDS` env var. No billing involved. Visible in Settings as "⚡ Режим бога".

---

## 5. Billing Flow (Telegram Stars)

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PRO_PRICE_XTR` | `100` | Stars price per monthly period |
| `PRO_SUBSCRIPTION_PERIOD` | `2592000` | Monthly subscription length in seconds (30 days) |
| `PRO_PLAN_CODE` | `PRO` | Plan code string |
| `PRO_YEARLY_PRICE_XTR` | `800` | Stars price for yearly one-time purchase |
| `PRO_YEARLY_EXTEND_SECONDS` | `31536000` | Seconds added to `currentPeriodEnd` on yearly purchase (365 days) |
| `PRO_LIFETIME_PRICE_XTR` | `2490` | Stars price for lifetime one-time purchase (permanent Pro) |

### Checkout Flow

```
User selects monthly, yearly, or lifetime plan in paywall
  → POST /tg/billing/pro/checkout { plan: 'monthly' | 'yearly' | 'lifetime' }
  → If user is already lifetime → { alreadySubscribed: true, lifetime: true } (no invoice)
  → If user is already monthly+!cancelAtPeriodEnd and plan=monthly → { alreadySubscribed: true }
  → createTgInvoiceLink() — wraps TG API call with 1 retry on network failure
      ok=true  → url returned
      ok=false, retryable  → 503 telegram_unavailable (client should show retry toast)
      ok=false, !retryable → 502 (Telegram rejected payload)
  → Returns { invoiceUrl, checkoutSessionId, plan }
  → Frontend opens invoice via Telegram.WebApp.openInvoice()
  → User pays in Telegram
  → Telegram sends pre_checkout_query → bot answers ok
  → Telegram sends successful_payment → bot creates/extends Subscription
      monthly:  sets currentPeriodEnd = now + PRO_SUBSCRIPTION_PERIOD; billingPeriod='monthly'
      yearly:   extends currentPeriodEnd by PRO_YEARLY_EXTEND_SECONDS; billingPeriod='yearly'
      lifetime: sets currentPeriodEnd = 2099-12-31 (sentinel); billingPeriod='lifetime';
                cancelAtPeriodEnd=false; OVERWRITES any prior monthly/yearly row
  → Frontend polls POST /tg/billing/pro/sync to confirm
  → Returns updated plan + subscription
```

### Invoice payload formats

| Plan | Payload |
|------|---------|
| Monthly | `pro_monthly:<tgId>:<sessionId>` |
| Yearly | `pro_yearly:<tgId>:<sessionId>` |
| Lifetime | `pro_lifetime:<tgId>:<sessionId>` |
| Add-on | `addon:<sku>:<tgId>:<targetId|_>:<sessionId>` |

### Lifetime override / downgrade protection

When the bot receives a `pro_monthly` or `pro_yearly` `successful_payment` for a user whose existing `Subscription` already has `billingPeriod='lifetime'`, the handler:

1. **Does NOT** overwrite the Subscription row (no downgrade).
2. **Records** a `PaymentEvent` with `eventType='payment_success_post_lifetime'` for audit + Stars-balance reconciliation.
3. **Returns silently** — no bot DM (lifetime user already knows they have permanent Pro).

This protects users who buy lifetime while a Telegram-side monthly auto-renewal is still active. Telegram will keep charging the monthly subscription until the user cancels it client-side; our DB stays on lifetime regardless. The Settings UI surfaces a static informational banner (`pro_lifetime_existing_monthly_warning`) reminding the user to cancel any prior monthly auto-renewal separately.

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/tg/me/plan` | Current plan, subscription, usage counters |
| `POST` | `/tg/billing/pro/checkout` | Create Telegram Stars invoice link |
| `POST` | `/tg/billing/pro/sync` | Verify subscription after payment |
| `GET` | `/tg/billing/history` | Payment history (last 20 events) |
| `POST` | `/tg/billing/subscription/cancel` | Soft-cancel: sets `cancelAtPeriodEnd=true`. Returns **409 `lifetime_cannot_cancel`** if active subscription is lifetime — the Mini App also hides the cancel CTA, this is the backend backstop |
| `POST` | `/tg/billing/subscription/reactivate` | Re-enable auto-renewal. Returns **409 `lifetime_cannot_cancel`** if user has a lifetime row (no auto-renewal to manage) |

### Subscription States

| Status | `billingPeriod` | `cancelAtPeriodEnd` | Effect |
|--------|-----------------|---------------------|--------|
| `ACTIVE` | `monthly` | `false` | Auto-renews at period end |
| `ACTIVE` | `monthly` | `true` | Access until period end, then FREE |
| `ACTIVE` | `yearly` | (n/a) | One-time, expires at `currentPeriodEnd` then FREE |
| `ACTIVE` | `lifetime` | `false` | Permanent Pro. `currentPeriodEnd = 2099-12-31` sentinel; never expires; cancel/reactivate not applicable |
| `CANCELLED` | (any) | — | Was cancelled; if `currentPeriodEnd > now` still PRO |
| `EXPIRED` | (any non-`lifetime`) | — | Past period end; marked EXPIRED by hourly job. Lifetime is excluded from the sweep via `billingPeriod !== 'lifetime'` |

### PRO Renewal Reminders

Hourly cron job sends bot DM reminders to users whose PRO is expiring soon. Only fires for yearly subscriptions and monthly ones with `cancelAtPeriodEnd=true` (auto-renewing monthly subscribers receive no reminder — Telegram charges automatically). **Lifetime subscriptions are excluded** via an explicit `NOT { billingPeriod: 'lifetime' }` filter on the cron query — defensive, since the 2099 sentinel `currentPeriodEnd` already keeps lifetime out of the 7d/1d windows.

| Milestone | Window | i18n Key |
|-----------|--------|----------|
| 7 days before expiry | 6–8 days before `currentPeriodEnd` | `bot_pro_renewal_7d` |
| 1 day before expiry | 12–36 hours before `currentPeriodEnd` | `bot_pro_renewal_1d` |

Idempotency: synthetic `PaymentEvent.telegramPaymentChargeId = "reminder:{milestone}:{subId}:{periodEndISO}"` prevents duplicate sends.

### Anti-Churn Cancel Flow

When user taps "Отменить продление", a bottom sheet appears listing what they'll lose (8 PRO features). The user must explicitly confirm with "Отменить подписку". Primary CTA is "Оставить Pro".

---

## 6. UI Screens Using Entitlements

| Screen / Component | Locale path | What changes |
|--------------------|-------------|--------------|
| **`ProUpsellSheet`** | `MiniApp.tsx` | Context-aware upsell; comparison table uses `getProBenefits()` |
| **Settings → FREE plan card** | `MiniApp.tsx` | Shows 8 PRO benefits with title+subtitle via `getProBenefits()` |
| **Settings → PRO plan card** | `MiniApp.tsx` | Shows limits (wishlists/items/participants) + feature rows (comments, url_import, hints, subscriptions, privacy) |
| **Cancel flow** | `MiniApp.tsx` | Lists 9 features: wishlists, items, participants, comments, url, hints, subs, privacy, calendar |
| **Wishlist creation** | `MiniApp.tsx` | Shows counter "X из Y"; upsell on 402 |
| **Item add** | `MiniApp.tsx` | Shows counter; upsell on 402 |
| **Comments** | `MiniApp.tsx` | Locked behind PRO badge + upsell |
| **URL Import** | `MiniApp.tsx` | FREE: 5/mo with "X из 5" counter; quota-exhausted upsell (buy pack / PRO / add manually) |
| **Hints** | `MiniApp.tsx` | Locked behind PRO; upsell on 402 |
| **Guest sort (recommended)** | `MiniApp.tsx` | Client-only; upsell on click if FREE |
| **Subscribe to wishlist** | `MiniApp.tsx` | Shows count "X из Y"; upsell on 402 |
| **Wishlist privacy settings** | `MiniApp.tsx` | OPTIONS silently ignored server-side if FREE |
| **showcase-editor / showcase-preview** | `MiniApp.tsx` | Locked behind PRO; upsell on access |
| **secret-reservation-paywall** | `MiniApp.tsx` | Add-on paywall (24 XTR) |

---

## 7. Upsell Contexts

```typescript
type UpsellContext =
  | 'comments'          // triggered on comment attempt by FREE user
  | 'url_import'        // triggered on link import attempt
  | 'hints'             // triggered on hint attempt
  | 'wishlist_limit'    // triggered on wishlist creation 402
  | 'item_limit'        // triggered on item add 402
  | 'participant_limit' // defined; not wired — reserve 402 shows toast_max_participants, not this upsell
  | 'subscription_limit'// triggered on follow 402 (показывает до 5 подписок)
  | 'sort_recommended'  // triggered on recommended sort click (client-only)
  | 'birthday_reminders_advanced' // triggered on PATCH /tg/me/birthday-settings 402
  | 'santa_multi_wave'      // triggered on POST /tg/santa/campaigns 402 (type MULTI_WAVE)
  | 'santa_exclusions'      // triggered on POST /tg/santa/campaigns/:id/exclusions 402
  | 'santa_exclusion_groups'; // triggered on POST /tg/santa/campaigns/:id/exclusions/groups 402
```

Each context has a dedicated `emoji`, `title`, `subtitle`, and optional `benefits[]` list, defined in `getUpsellContent(locale)` in `MiniApp.tsx`. Keys are in `packages/shared/src/i18n.ts`.

---

## 8. i18n Keys — Source of Truth

All paywall text lives in `packages/shared/src/i18n.ts`.

### Plan benefits (titles)
`plan_pro_f1` … `plan_pro_f8`

### Plan benefits (subtitles)
`plan_pro_sub1` … `plan_pro_sub8`

### Free plan baseline
`plan_free_f1` … `plan_free_f3`

### Cancel flow features
`cancel_feat_wishlists`, `cancel_feat_items`, `cancel_feat_participants`,
`cancel_feat_comments`, `cancel_feat_url`, `cancel_feat_hints`,
`cancel_feat_subs`, `cancel_feat_privacy`

### PRO plan screen descriptors (Settings)
`settings_wishlists` + `settings_desc_wishlists`
`settings_wishes_each` + `settings_desc_wishes`
`settings_participants` + `settings_desc_participants`
`settings_comments` + `settings_desc_comments`
`settings_url_import` + `settings_desc_url_import`
`settings_hints` + `settings_desc_hints`
`settings_subscriptions` + `settings_desc_subscriptions` ← new
`settings_privacy_pro` + `settings_desc_privacy_pro` ← new

### Secret Santa PRO gates
`santa_create_type_pro_hint` (create-form disclosure)
`santa_excl_pairs_pro_hint` · `santa_excl_groups_pro_hint` (exclusions-screen disclosure)
`upsell_santa_multi_wave_*` · `upsell_santa_excl_*` · `upsell_santa_excl_groups_*` (upsell sheet)

---

## 9. Adding or Changing a PRO Benefit

To add a new PRO benefit to the paywall:

1. **Backend** — add limit/flag to `PLANS.PRO` in `apps/api/src/index.ts`; add server-side enforcement in the relevant endpoint
2. **i18n** — add `plan_pro_fN` (title) and `plan_pro_subN` (subtitle) for both `ru` and `en` in `packages/shared/src/i18n.ts`
3. **Frontend** — add `{ icon, title, subtitle }` entry to `getProBenefits(locale)` in `apps/web/app/miniapp/MiniApp.tsx`
4. **Cancel flow** — add `cancel_feat_X` i18n key and entry to `cancelFeatures` array in `MiniApp.tsx`
5. **Settings PRO card** — add row to the feature rows section in the PRO plan card

To change a limit value (e.g., raise PRO wishlists from 10 to 15):
1. Change `PLANS.PRO.wishlists` in `apps/api/src/index.ts`
2. Update `plan_pro_f1` text in `packages/shared/src/i18n.ts`

---

## 10. Known Non-Advertised PRO Gates

These are server-side enforced but not shown on the main paywall (intentionally):

| Feature | Gate type | Rationale |
|---------|-----------|-----------|
| `visibility=PUBLIC_PROFILE` / `PRIVATE` | server 403 | Covered by benefit #8 "Расширенная приватность" |
| `allowSubscriptions=NOBODY` | server 403 | Covered by benefit #8 |
| `commentPolicy=SUBSCRIBERS` | server 403 | Covered by benefit #8 |
| Notification settings (comments/subs) | silent ignore | Advanced feature, not paywall-worthy standalone |
| New wishlist position `bottom` | silent ignore | Minor UX preference |

---

## 11. Add-on SKU Store

One-time purchases via Telegram Stars. Defined in `ONE_TIME_SKUS` constant in `apps/api/src/index.ts`.

### SKU Catalogue (14 add-on SKUs)

| SKU Code | Price (XTR) | Type | Effect |
|----------|-------------|------|--------|
| `extra_wishlist_slot` | 39 | permanent | +1 wishlist slot |
| `extra_subscription_slot` | 25 | permanent | +1 subscription slot |
| `extra_items_5` | 19 | permanent | +5 item slots (per wishlist, target required) |
| `extra_items_15` | 39 | permanent | +15 item slots (per wishlist, target required) |
| `hints_pack_5` | 29 | consumable | +5 hint credits |
| `hints_pack_10` | 49 | consumable | +10 hint credits |
| `import_pack_10` | 39 | consumable | +10 import credits |
| `import_pack_25` | 79 | consumable | +25 import credits |
| `seasonal_decoration` | 29 | cosmetic | Seasonal decoration for a wishlist (target required) |
| `gift_notes_unlock` | 19 | permanent | Unlock Gift Notes feature |
| `reservation_pro_unlock` | 50 | permanent | Unlock reservation PRO features (purchase status tracking, notes, reminders, history) |
| `group_gift_unlock` | 79 | permanent | Unlock ability to create group gift collections. Not included in PRO subscription |
| `secret_reservation_unlock` | 24 | permanent | Unlock secret reservations — reserve an item without the owner seeing who reserved it |
| `smart_reservations_unlock` | 15 | permanent | Per-wishlist: enable time-limited reservations with auto-release and reminders (targetId required) |

### Add-on Caps (`ADDON_CAPS`)

Prevent add-ons from substituting PRO:

| Cap | FREE | PRO |
|-----|------|-----|
| Extra wishlist slots | max 3 (total ≤ 5) | max 5 (total ≤ 15) |
| Extra subscription slots | max 3 (any plan) | max 3 |
| Extra items +5 per wishlist | max 3 (= +15) | max 3 |
| Extra items +15 per wishlist | max 1 (= +15) | max 1 |

### Add-on API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/tg/billing/addon/checkout` | Create Stars invoice for a SKU. Body: `{ sku, targetId? }` |
| `POST` | `/tg/billing/addon/sync` | Verify add-on purchase after payment |
| `GET` | `/tg/billing/addon/status` | Current add-on inventory for user |

---

## 12. Credits System

Credits let FREE users use credit-gated features without subscribing. URL
import additionally grants a **monthly free quota** before any paid credit is
needed (see § 12.1).

### Credit Types

| Credit | Model field | Consumed by | PRO behavior |
|--------|------------|-------------|-------------|
| Hint credits | `UserCredits.hintCredits` | `POST /tg/items/:id/hint` | PRO bypasses — unlimited |
| Import credits | `UserCredits.importCredits` | `POST /tg/import-url`, `POST /internal/import-url` | PRO bypasses — unlimited |

### How Credits Work

1. User purchases a consumable SKU (e.g., `hints_pack_5`, `import_pack_10`)
2. `UserCredits` record is upserted with incremented balance
3. On feature use, if user is FREE, one credit is deducted
4. If balance = 0 and user is FREE, the feature gate returns 402

### 12.1. URL-import monthly free quota

URL import is **not** a hard PRO gate. The credit model
(`services/import-credits.ts`, live 2026-05-20):

- **FREE** users get `FREE_IMPORT_QUOTA_PER_MONTH` imports per UTC calendar
  month (default **5**, env-tunable). Tracked on `UserCredits.freeImportsUsed`
  / `freeImportsPeriod` (a `"YYYY-MM"` bucket); the counter resets lazily on
  the first import of a new month — no scheduler.
- **PRO** is unlimited and never decrements.
- Consumption order on a successful import: free monthly quota first, then
  paid `importCredits` (`import_pack_10` / `import_pack_25`).
- A credit is spent only when an item is actually created (`parseStatus`
  `ok` or `partial`); a failed parse never decrements.
- When the FREE quota **and** paid credits are both exhausted, the route
  returns `402 { error: 'import_quota_exhausted', feature: 'url_import',
  freeLimit, freeUsed, paidCredits }` — the Mini App shows a buy-pack / PRO /
  "add manually" upsell instead of a hard wall.
- Analytics: `import.free_quota_used`, `import.free_quota_exhausted`,
  `import.credit_pack_suggested`.

---

## 13. Gift Notes / Occasions

One-time unlock (19 XTR) or included with PRO. Enables occasion-based gift planning.

- **Price**: `GIFT_NOTES_PRICE_XTR` (default: 19)
- **SKU**: `gift_notes_unlock`
- **Access**: PRO users get it free; FREE users purchase via add-on checkout
- **Occasion types**: `BIRTHDAY`, `ANNIVERSARY`, `HOLIDAY`, `OTHER`
- **Features**: Recurrence, ideas per occasion, deep link `startapp=occasion_{id}`

### Gift Notes API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/tg/billing/gift-notes/checkout` | Create Stars invoice for Gift Notes unlock |
| `POST` | `/tg/billing/gift-notes/sync` | Verify purchase |
| `GET` | `/tg/gift-occasions` | List user's occasions |
| `POST` | `/tg/gift-occasions` | Create occasion |
| `PATCH` | `/tg/gift-occasions/:id` | Update occasion |
| `DELETE` | `/tg/gift-occasions/:id` | Delete occasion |

---

## 14. Group Gift Monetization

One-time unlock (79 XTR). **Not bundled with PRO subscription** -- purchased separately.

- **Price**: 79 Telegram Stars (permanent)
- **SKU**: `group_gift_unlock`
- **Access**: Gives permanent access to create group gift collections. PRO users must still purchase separately.
- **Gate**: `hasGroupGiftAccess()` -- checks for `UserAddOn(addonType='group_gift_unlock')`
- **Features unlocked**: Create group gift collections, set target amount, invite participants, manage contributions

### Group Gift API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/tg/billing/group-gift/checkout` | Create Stars invoice for Group Gift unlock |
| `POST` | `/tg/billing/group-gift/sync` | Verify purchase |

---

## 15. Secret Reservations Monetization

One-time unlock (24 XTR). Available to all users (FREE and PRO) as an add-on.

- **Price**: 24 Telegram Stars (permanent)
- **SKU**: `secret_reservation_unlock`
- **Access**: Add-on only — not included in PRO subscription. Any user can purchase.
- **Gate**: `hasSecretReservation()` — checks for `UserAddOn(addonType='secret_reservation_unlock')`
- **Features unlocked**: Reserve a wish item without the owner seeing who made the reservation. Includes onboarding flow.
- **Screens**: secret-reservation-detail, secret-reservation-paywall

### Secret Reservations API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/tg/billing/addon/checkout` | Body: `{ sku: 'secret_reservation_unlock' }` |
| `POST` | `/tg/billing/addon/sync` | Verify purchase |

---

## 16. Smart Reservations Monetization

Per-wishlist unlock (15 XTR each). Available to all users as an add-on.

- **Price**: 15 Telegram Stars per wishlist (permanent, per-wishlist)
- **SKU**: `smart_reservations_unlock`
- **Access**: Add-on only — not included in PRO subscription. `targetId` (wishlist ID) is required at checkout.
- **Gate**: `hasSmartReservations(wishlistId)` — checks for `UserAddOn(addonType='smart_reservations_unlock' AND targetId=wishlistId)`
- **Features unlocked**: Time-limited reservations with configurable TTL, auto-release on expiry, reminders, and extensions. Wishlist settings control: TTL hours, max extensions, allow-extend flag.

### Smart Reservations API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/tg/billing/addon/checkout` | Body: `{ sku: 'smart_reservations_unlock', targetId: wishlistId }` |
| `POST` | `/tg/billing/addon/sync` | Verify purchase |

---

## 16a. Birthday Reminders Monetization

Birthday reminders themselves are free (everyone with a birthday set can opt in to bot-driven 14d + day-of friend reminders, plus 30d owner self-reminders). A small set of advanced controls is gated behind PRO via the `birthday_reminders_advanced` paywall context.

### Pro-gated fields

| Field | FREE behaviour | PRO unlocks |
|---|---|---|
| `birthdayAudience: 'EXTENDED'` | 402 `pro_required` | Adds reservers (`ReservationMeta`) + secret reservers (`SecretReservation`) to the friend-reminder audience, on top of the SUBSCRIBERS baseline (profile + wishlist subscribers) |
| `birthdayPrimaryWishlistId` | 402 `pro_required` | Override which wishlist the friend bot DM's CTA deep-links into; otherwise the scheduler auto-picks |
| `birthdayCustomMessage` (max 200 chars) | 402 `pro_required` | An italicised line in the friend bot DM template |
| `birthdayAdvancedWindowsEnabled: true` | 402 `pro_required` | Adds the 7d / 1d friend windows and the 14d / 7d owner windows. FREE keeps 14d + day-of (friend) and 30d (owner) only |

### Paywall context

`UpsellContext = 'birthday_reminders_advanced'`. Triggered by **402** from `PATCH /tg/me/birthday-settings`. The 402 response includes `{ error: 'pro_required', feature: 'birthday_reminders_advanced', context: '<field>' }` — never a silent 200.

i18n: `plan_pro_f_birthday` (title) and `plan_pro_sub_birthday` (subtitle) for the paywall benefit row.

### Downgrade behaviour

When a PRO user downgrades to FREE, the DB values for `birthdayAudience`, `birthdayPrimaryWishlistId`, `birthdayCustomMessage`, `birthdayAdvancedWindowsEnabled` are **preserved** (no destructive write). The scheduler treats those flags as inactive — friend deliveries fall back to SUBSCRIBERS audience and the FREE 14d + day-of windows; the corresponding deliveries are skipped with `skipReason: 'pro_required'` and surface in the God Mode dashboard. Re-upgrading restores the previously configured values without re-entry.

### Source files

- API: `apps/api/src/index.ts` — `PATCH /tg/me/birthday-settings`, `processBirthdayReminders` scheduler.
- Mini App: `apps/web/app/miniapp/MiniApp.tsx` — Settings → 🎂 День рождения section, paywall context wiring, `getUpsellContent('birthday_reminders_advanced')`.
- Schema: `packages/db/prisma/schema.prisma` — `UserProfile.birthday*` fields, `BirthdayReminderDelivery`, `BirthdayReminderMute`.

---

## 16b. Secret Santa PRO Gates

The Secret Santa domain ships three PRO-gated features. A **basic (classic) campaign is free** — any user can create one, invite participants, run the draw, and exchange gifts. The three gates below add organizer power-features and are enforced server-side in `apps/api/src/routes/santa.routes.ts`.

### Pro-gated features

| Feature | Endpoint(s) | FREE behaviour | PRO unlocks |
|---|---|---|---|
| **Multi-wave campaign** (`type: 'MULTI_WAVE'`) | `POST /tg/santa/campaigns` | 402 `pro_required` | A campaign type that runs several gift rounds in one campaign. `CLASSIC` is the free default. |
| **Exclusion pairs** | `POST /tg/santa/campaigns/:id/exclusions` | 402 `pro_required` | Block specific participant pairs from drawing each other (couples, relatives). |
| **Exclusion groups** | `POST /tg/santa/campaigns/:id/exclusions/groups`, `POST .../groups/:gid/members` | 402 `pro_required` | Named groups — no member draws another member. One rule replaces many pairs. |

All three checks are `getUserEntitlement(userId).isPro`. The 402 body is `{ error: 'pro_required', feature }` where `feature` is `santa_multi_wave`, `santa_exclusions`, or `santa_exclusion_groups`. Read endpoints (`GET .../exclusions`) and the delete/rename endpoints are owner-only but **not** PRO-gated — a user who downgrades keeps read access and can still remove existing rules.

### Paywall contexts

`UpsellContext` gains `santa_multi_wave`, `santa_exclusions`, `santa_exclusion_groups` (see § 7). `getUpsellContent(locale)` renders each with its own title / subtitle / benefits. i18n key prefixes: `upsell_santa_multi_wave_*`, `upsell_santa_excl_*`, `upsell_santa_excl_groups_*`.

### Pre-submit disclosure (no surprise 402s)

The Mini App discloses each gate **before** the user submits, so a FREE user never first learns of a gate from an error:

- **Create screen** — a campaign-type selector offers `Classic` (free) and `Multi-wave 🔒`. A FREE user selecting multi-wave sees an inline PRO hint (`santa_create_type_pro_hint`) above the submit button; the hint opens the upsell. Submitting anyway still returns a clean 402 → upsell.
- **Exclusions screen** — FREE users see a tappable locked hint (`santa_excl_pairs_pro_hint` / `santa_excl_groups_pro_hint`) in place of the add buttons; tapping it opens the upsell.

### Analytics

| Event | Source | When |
|---|---|---|
| `santa.gate_hit` | server | A 402 `pro_required` is returned by one of the three gates. `props.feature` names the gate. |
| `santa.paywall_viewed` | client | A Santa upsell sheet is rendered. `props.context`. |
| `santa.paywall_cta_clicked` | client | The upgrade CTA is tapped from a Santa upsell. `props.context`, `props.plan`. |

All three are registered in `PRODUCT_EVENTS` (`packages/shared/src/analyticsEvents.ts`). `santa.gate_hit` is server-only (hard-denied at `/tg/telemetry` so a client cannot spoof it); the two `paywall_*` events are client-emitted from the Mini App.

---

## 17. Promo System

Promo codes (e.g. `WISHPRO`) grant entitlements without Telegram Stars payment.

### PromoCampaign model

Each promo code is a `PromoCampaign` record with: code, grant type, grant duration, max redemptions, active date range.

### Redemption Flow

1. User enters promo code on Settings screen
2. `POST /tg/promo/apply` with `{ code }` — code is uppercased/trimmed
3. Server validates: campaign exists, active, not expired, redemption cap not reached
4. **FREE user**: Creates `PromoRedemption` with `status='ACTIVE'`, grants PRO for campaign duration
5. **Paid PRO user**: Creates `PromoRedemption` with `status='ACCEPTED_FOR_PAID'` — recorded but not applied (already has PRO)
6. Rate limited: 5 attempts per 60 seconds per user

### Redemption Statuses

| Status | Meaning |
|--------|---------|
| `ACTIVE` | Promo PRO is currently active |
| `EXPIRED` | Promo period ended |
| `ACCEPTED_FOR_PAID` | User already had paid PRO; promo recorded |
| `REVOKED` | Manually revoked by admin |

### Degradation Flow

When PRO access expires (subscription lapses, promo grant expires), a `DegradationState` record tracks the transition. Phases: `NONE` → `GRACE_PERIOD` (14 days) → `ARCHIVED` → `PURGED` (90 days).

---

## 18. Lifecycle Messaging

The system sends targeted messages via bot DM based on user lifecycle state:
- **Winback**: Users who had PRO and lost it receive re-engagement messages with promo codes
- **LifecycleTouch** model logs all lifecycle messages to prevent spam
- **DegradationState** tracks phase transitions for triggering appropriate messages

---

## 19. Paywall error envelope

All state-changing routes that return a 402/403/409 paywall response emit the
**unified envelope** from [`services/paywall.ts`](../apps/api/src/services/paywall.ts).
Full contract, status-code rules, builder usage, migration log, and
per-endpoint contract tests are in **[docs/PAYWALL_ENVELOPE.md](PAYWALL_ENVELOPE.md)**.

TL;DR:
- **402** = user can buy/upgrade (`pro_required`, `addon_required`, `plan_limit_reached`).
- **403** = denied; purchase wouldn't help.
- **409** = state conflict (e.g., guest hit owner's plan limit).
- Use `makeProRequired` / `makeAddonRequired` / `makePlanLimitReached` + `sendPaywall(res, status, body)`. Never construct the envelope inline.
