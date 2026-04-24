# MONETIZATION

> Source of truth for plans, limits, entitlements, billing flow, and paywall content.
> Last updated: 2026-04-24 · Branch: main

---

## 1. Plans

| | **FREE** | **PRO Monthly** | **PRO Yearly** |
|---|---|---|---|
| **Code** | `FREE` | `PRO` | `PRO` |
| **Price** | — | 100 Telegram Stars / month | 800 Telegram Stars (one-time) |
| **Renewal** | — | Auto-renew (soft cancel: access until period end) | No auto-renewal; manual renewal required |
| **Duration** | — | 30 days per period | 365 days (one-time payment) |
| **Savings** | — | — | ~33% vs 12 monthly payments |

**Yearly plan** is a non-recurring Telegram Stars invoice. When paid, the bot extends `Subscription.currentPeriodEnd` by `PRO_YEARLY_EXTEND_SECONDS` (default: 31 536 000 = 365 days). Yearly subscriptions and monthly ones with `cancelAtPeriodEnd=true` receive bot renewal reminder DMs at 7 days and 1 day before expiry.

All limits and feature flags are defined in a single constant in `apps/api/src/index.ts`:

```typescript
const PLANS = {
  FREE: {
    code: 'FREE',
    wishlists: 2,
    items: 20,
    participants: 5,
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
| 5 | `plan_pro_f5` | Добавление по ссылке | Ozon, Wildberries, Яндекс Маркет, Lamoda, Goldapple и другие. | server (`features.includes('url_import')` → 402) |
| 6 | `plan_pro_f6` | Намекнуть на подарок | Подскажи друзьям конкретную идею деликатно и быстро. | server (`features.includes('hints')` → 402) |
| 7 | `plan_pro_f7` | До 5 подписок на вишлисты друзей | Следи за изменениями у друзей и получай обновления. | server (count >= plan.subscriptions → 402) |
| 8 | `plan_pro_f8` | Расширенная приватность | Управляй видимостью, подписками и комментариями в своих вишлистах. | server (isPro check → 403) |
| 10 | `plan_pro_f10` | История броней | Все прошлые и завершенные бронирования в одном месте. | server (hasReservationPro → 403) |
| 11 | `plan_pro_f11` | Заметки к подаркам | Личные записки к забронированным желаниям — видишь только ты. | server (hasReservationPro → 403) |
| 12 | `plan_pro_f12` | Напоминания о броне | Поставь напоминание, чтобы не забыть купить или вручить подарок. | server (hasReservationPro → 403) |
| 13 | `plan_pro_f13` | Статус «Уже купил» | Отмечай купленные подарки и держи всё под контролем. | server (hasReservationPro → 403) |
| 14 | `plan_pro_f14` | Фильтры и сортировка броней | Находи нужную бронь за секунду среди десятков подарков. | server (hasReservationPro → 403) |

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
| URL Import | `POST /tg/import-url` | `features.includes('url_import')` |
| Hints | `POST /tg/items/:id/hint` | `features.includes('hints')` |
| Visibility `PUBLIC_PROFILE` / `PRIVATE` | `PATCH /tg/wishlists/:id` | `isPro` → 403 |
| `allowSubscriptions=NOBODY` | `PATCH /tg/wishlists/:id` | `isPro` → 403 |
| `commentPolicy=SUBSCRIBERS` | `PATCH /tg/wishlists/:id` | `isPro` → 403 |
| Notification settings (comments, subscriptions) | `PATCH /tg/me/settings` | `isPro` — silently ignored if FREE |
| New wishlist position `bottom` | `PATCH /tg/me/settings` | `isPro` — silently ignored if FREE |
| Showcase (public profile page) | `PATCH /tg/me/showcase` | `isPro` → 403 |
| Curated Selections | `POST /tg/curated-selections` | `isPro` → 403 |
| Profile Subscriptions | `POST /tg/profiles/:id/subscribe` | `isPro` → 403 |

### Reservation PRO — Beta-gated via `hasReservationPro()`

Currently limited to focus-group users via `RESERVATION_PRO_BETA_IDS` env var. Phase 2 will open to all PRO users.

| Feature | Endpoint | Check |
|---------|----------|-------|
| Reservation history | `GET /tg/reservations/history` | `hasReservationPro()` → 403 |
| Private notes | `PATCH /tg/reservations/:itemId/meta` | `hasReservationPro()` → 403 |
| Purchased flag | `PATCH /tg/reservations/:itemId/meta` | `hasReservationPro()` → 403 |
| Reminders | `POST /tg/reservations/:itemId/reminder` | `hasReservationPro()` → 403 |
| Filters & sort | Client-side | `reservationPro` flag from API |

### Client-only gate (no server enforcement)

| Feature | Location | Note |
|---------|----------|------|
| Recommended guest sort | `apps/web/app/miniapp/MiniApp.tsx` | `pro: true` chip; upsell shown to FREE; no server check. Low risk (requires custom client to bypass). Not advertised on paywall. |

---

## 4. Entitlement Resolution

Function: `getUserEntitlement(userId, godMode?)` — `apps/api/src/index.ts`

### Base Entitlement — `getUserEntitlement(userId, godMode?)`

**Resolution order (priority):**
1. Active `Subscription` with `planCode='PRO'`, `status IN ('ACTIVE','CANCELLED')`, `currentPeriodEnd > now()` → `proSource: 'subscription'`
2. Active `PromoRedemption` with `status='ACTIVE'`, not expired → `proSource: 'promo'`
3. `godMode=true` (user's `telegramId` in `GOD_MODE_TELEGRAM_IDS` env) → `proSource: 'god_mode'`
4. Otherwise → `PLANS.FREE`, `isPro: false`

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

### Checkout Flow

```
User selects monthly or yearly plan in paywall
  → POST /tg/billing/pro/checkout { plan: 'monthly' | 'yearly' }
  → createTgInvoiceLink() — wraps TG API call with 1 retry on network failure
      ok=true  → url returned
      ok=false, retryable  → 503 telegram_unavailable (client should show retry toast)
      ok=false, !retryable → 502 (Telegram rejected payload)
  → Returns { invoiceUrl, checkoutSessionId, plan }
  → Frontend opens invoice via Telegram.WebApp.openInvoice()
  → User pays in Telegram
  → Telegram sends pre_checkout_query → bot answers ok
  → Telegram sends successful_payment → bot creates/extends Subscription
      monthly: sets currentPeriodEnd = now + PRO_SUBSCRIPTION_PERIOD
      yearly:  extends currentPeriodEnd by PRO_YEARLY_EXTEND_SECONDS; billingPeriod='yearly'
  → Frontend polls POST /tg/billing/pro/sync to confirm
  → Returns updated plan + subscription
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/tg/me/plan` | Current plan, subscription, usage counters |
| `POST` | `/tg/billing/pro/checkout` | Create Telegram Stars invoice link |
| `POST` | `/tg/billing/pro/sync` | Verify subscription after payment |
| `GET` | `/tg/billing/history` | Payment history (last 20 events) |
| `POST` | `/tg/billing/subscription/cancel` | Soft-cancel: sets `cancelAtPeriodEnd=true` |
| `POST` | `/tg/billing/subscription/reactivate` | Re-enable auto-renewal |

### Subscription States

| Status | `cancelAtPeriodEnd` | Effect |
|--------|---------------------|--------|
| `ACTIVE` | `false` | Auto-renews at period end |
| `ACTIVE` | `true` | Access until period end, then FREE |
| `CANCELLED` | — | Was cancelled; if `currentPeriodEnd > now` still PRO |
| `EXPIRED` | — | Past period end; marked EXPIRED by hourly job |

### PRO Renewal Reminders

Hourly cron job sends bot DM reminders to users whose PRO is expiring soon. Only fires for yearly subscriptions and monthly ones with `cancelAtPeriodEnd=true` (auto-renewing monthly subscribers receive no reminder — Telegram charges automatically).

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
| **Cancel flow** | `MiniApp.tsx` | Lists 8 features: wishlists, items, participants, comments, url, hints, subs, privacy |
| **Wishlist creation** | `MiniApp.tsx` | Shows counter "X из Y"; upsell on 402 |
| **Item add** | `MiniApp.tsx` | Shows counter; upsell on 402 |
| **Comments** | `MiniApp.tsx` | Locked behind PRO badge + upsell |
| **URL Import** | `MiniApp.tsx` | Locked behind PRO; upsell on 402 |
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
  | 'participant_limit' // triggered on reserve 402
  | 'subscription_limit'// triggered on follow 402 (показывает до 5 подписок)
  | 'sort_recommended'; // triggered on recommended sort click (client-only)
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

Credits enable FREE users to access PRO-gated features (hints, URL import) on a per-use basis without subscribing.

### Credit Types

| Credit | Model field | Consumed by | PRO behavior |
|--------|------------|-------------|-------------|
| Hint credits | `UserCredits.hintCredits` | `POST /tg/items/:id/hint` | PRO bypasses — unlimited |
| Import credits | `UserCredits.importCredits` | `POST /tg/import-url` | PRO bypasses — unlimited |

### How Credits Work

1. User purchases a consumable SKU (e.g., `hints_pack_5`)
2. `UserCredits` record is upserted with incremented balance
3. On feature use, if user is FREE, one credit is deducted
4. If balance = 0 and user is FREE, the feature gate returns 402

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
