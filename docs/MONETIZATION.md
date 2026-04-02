# MONETIZATION

> Source of truth for plans, limits, entitlements, billing flow, and paywall content.
> Last updated: 2026-04-02 · Branch: main

---

## 1. Plans

| | **FREE** | **PRO** |
|---|---|---|
| **Code** | `FREE` | `PRO` |
| **Price** | — | 100 Telegram Stars / month |
| **Renewal** | — | Auto-renew (soft cancel: access until period end) |

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

## 2. PRO Benefits (Paywall — 8 items)

These 8 items are shown on the paywall and in the "What you unlock with Pro" block.
They are rendered via **`getProBenefits(locale)`** in `apps/web/app/miniapp/MiniApp.tsx`.
Text is sourced from `packages/shared/src/i18n.ts` keys `plan_pro_f1`–`plan_pro_f8` (titles) and `plan_pro_sub1`–`plan_pro_sub8` (subtitles).

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

### Client-only gate (no server enforcement)

| Feature | Location | Note |
|---------|----------|------|
| Recommended guest sort | `apps/web/app/miniapp/MiniApp.tsx` | `pro: true` chip; upsell shown to FREE; no server check. Low risk (requires custom client to bypass). Not advertised on paywall. |

---

## 4. Two-Layer Entitlement System

Entitlements are resolved in two layers:

### Layer 1: Base Plan — `getUserEntitlement(userId, godMode?)`

Determines the user's base plan (`FREE` or `PRO`) and `proSource`. Resolution order (first match wins):

1. **Paid subscription** — `Subscription` with `planCode='PRO'`, `status IN ('ACTIVE','CANCELLED')`, `currentPeriodEnd > now()` → `proSource: 'subscription'`
2. **Promo-PRO** — `PromoRedemption` with `status='ACTIVE'`, `expiresAt > now()` (or `null` for lifetime) → `proSource: 'promo'`
3. **God Mode** — `godMode=true` (user's `telegramId` in `GOD_MODE_TELEGRAM_IDS` env) → `proSource: 'god_mode'`
4. **Fallback** → `PLANS.FREE`, `isPro: false`, `proSource: null`

**God Mode:** Virtual PRO for testing/development. No billing involved. Visible in Settings as "⚡ Режим бога".

### Layer 2: Effective Entitlements — `getEffectiveEntitlements(userId, godMode?)`

Layers add-ons, credits, and Gift Notes access on top of the base plan. Returns:

| Field | Source |
|-------|--------|
| `effectiveWishlistLimit` | `plan.wishlists + extraWishlistSlots` (from `UserAddOn` rows with `addonType='wishlist_slot'`) |
| `effectiveSubscriptionLimit` | `plan.subscriptions + extraSubscriptionSlots` (from `addonType='subscription_slot'`) |
| `extraItemsPerWishlist` | Map of `wishlistId → extra items` (from `item_slot_5` / `item_slot_15` add-ons) |
| `seasonalWishlists` | Set of wishlist IDs with seasonal decoration add-on |
| `hintCredits` | `UserCredits.hintCredits` (0 if no row) |
| `importCredits` | `UserCredits.importCredits` (0 if no row) |
| `hasGiftNotes` | `isPro OR godMode OR has 'gift_notes_unlock' add-on` |
| `giftNotes.unlockType` | `'PRO'` / `'ONE_TIME'` / `'GOD'` / `null` |

All limit-check endpoints use `getEffectiveEntitlements()`, not the raw plan values.

---

## 5. Add-on SKU Store

One-time Telegram Stars purchases that extend limits beyond the base plan. Defined in `ONE_TIME_SKUS` in `apps/api/src/index.ts`.

### SKU Catalogue

| SKU Code | Price (XTR) | Type | What it does |
|----------|:-----------:|------|-------------|
| `extra_wishlist_slot` | 39 | permanent | +1 wishlist slot |
| `extra_subscription_slot` | 25 | permanent | +1 subscription (follow) slot |
| `extra_items_5` | 19 | permanent | +5 item slots for a specific wishlist |
| `extra_items_15` | 39 | permanent | +15 item slots for a specific wishlist |
| `hints_pack_5` | 29 | consumable | +5 hint credits |
| `hints_pack_10` | 49 | consumable | +10 hint credits |
| `import_pack_10` | 39 | consumable | +10 URL-import credits |
| `import_pack_25` | 79 | consumable | +25 URL-import credits |
| `seasonal_decoration` | 29 | cosmetic | Seasonal decoration for a specific wishlist |
| `gift_notes_unlock` | 19 | permanent | Unlock Gift Notes feature (one-time) |

- **permanent** add-ons persist forever and are stored as `UserAddOn` rows.
- **consumable** add-ons increment `UserCredits.hintCredits` or `UserCredits.importCredits`.
- **cosmetic** add-ons attach to a target wishlist (visual only).
- SKUs with `targetRequired: true` require a `targetId` (wishlist ID) at checkout.

### Per-SKU Caps (`ADDON_CAPS`)

| Cap | FREE | PRO |
|-----|:----:|:---:|
| Extra wishlist slots | 3 (total limit 5) | 5 (total limit 15) |
| Extra subscription slots | 3 (any plan) | 3 (any plan) |
| Extra items +5 per wishlist | 3 max (+15 items) | 3 max (+15 items) |
| Extra items +15 per wishlist | 1 max (+15 items) | 1 max (+15 items) |

Caps prevent add-ons from fully substituting a PRO subscription.

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/tg/billing/addon/checkout` | Create Telegram Stars invoice for a SKU (requires `skuCode`, optional `targetId`) |
| `POST` | `/tg/billing/addon/sync` | Return current add-ons and credits after purchase |

---

## 6. Credits System

Credits allow FREE users to access PRO-gated features (hints, URL import) on a per-use basis via purchased credit packs.

### `UserCredits` Model

| Field | Type | Description |
|-------|------|-------------|
| `hintCredits` | `Int` (default 0) | Remaining hint sends |
| `importCredits` | `Int` (default 0) | Remaining URL imports |

### Behavior

- **PRO users** bypass the credit check entirely (server-side). They have unlimited hints and imports within their plan features.
- **FREE users** must have `hintCredits > 0` to send a hint or `importCredits > 0` to import a URL. Each use decrements the counter.
- Credits are replenished by purchasing consumable SKU packs (`hints_pack_5`, `hints_pack_10`, `import_pack_10`, `import_pack_25`).

---

## 7. Gift Notes (Поводы и идеи)

A personal gift idea notebook organized by occasions. One-time unlock at 19 XTR, or included with PRO.

### Access

| User type | How they get access |
|-----------|-------------------|
| PRO subscriber | Included automatically |
| God Mode | Included automatically |
| FREE user | One-time purchase of `gift_notes_unlock` SKU (19 XTR) |

### Occasion Types

| Type | Description |
|------|-------------|
| `BIRTHDAY` | Birthday occasions |
| `ANNIVERSARY` | Anniversary occasions |
| `HOLIDAY` | Holiday occasions |
| `OTHER` | Custom/other occasions |

### Data Model

- `GiftOccasion` — an occasion (title, type, personName, targetDate, etc.) owned by a user
- `GiftOccasionIdea` — individual gift ideas linked to an occasion

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/tg/billing/gift-notes/checkout` | Create Telegram Stars invoice for Gift Notes unlock |
| `POST` | `/tg/billing/gift-notes/sync` | Verify unlock status after payment |
| `GET` | `/tg/gift-occasions` | List user's occasions (requires Gift Notes access) |

---

## 8. Promo System

Promotional codes grant entitlements without Telegram Stars payment.

### Flow

```
User enters promo code
  → POST /tg/promo/apply { code: "WISHPRO" }
  → Code normalized: trim, uppercase, remove spaces/dashes
  → Validated against PromoCampaign (active, within date range, not exhausted)
  → Redemption created/updated
  → Returns plan + entitlements
```

### Redemption Logic

| User state | Result |
|-----------|--------|
| FREE user | `PromoRedemption` created with `status='ACTIVE'`, `expiresAt` set per campaign grant duration. User gets PRO for the promo period. |
| Paid PRO user (active subscription) | `PromoRedemption` created with `status='ACCEPTED_FOR_PAID'`. Code is recorded but promo period does not activate (subscription takes priority). |
| Already redeemed (active/expired) | `409 already_used` |
| Campaign exhausted (max redemptions hit) | `409 campaign_exhausted` |

### Rate Limiting

`POST /tg/promo/apply` is rate-limited to **5 requests per 60 seconds** per user (`promoLimiter`).

### Models

- **`PromoCampaign`** — code, grant type, grant duration, max redemptions, active date range
- **`PromoRedemption`** — tracks which user redeemed which campaign, status (`ACTIVE`, `EXPIRED`, `ACCEPTED_FOR_PAID`), expiry
- **`EntitlementGrant`** — records promo-granted entitlements as add-ons to base plan

---

## 9. Billing Flow (Telegram Stars)

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PRO_PRICE_XTR` | `100` | Stars price per period |
| `PRO_SUBSCRIPTION_PERIOD` | `2592000` | Subscription length in seconds (30 days) |
| `PRO_PLAN_CODE` | `PRO` | Plan code string |

### Checkout Flow

```
User taps "Подключить Pro"
  → POST /tg/billing/pro/checkout
  → Creates Telegram Stars invoice link
  → Returns { invoiceLink }
  → Frontend opens invoice via Telegram.WebApp.openInvoice()
  → User pays in Telegram
  → Telegram sends pre_checkout_query → bot answers ok
  → Telegram sends successful_payment → bot creates/extends Subscription
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

### Anti-Churn Cancel Flow

When user taps "Отменить продление", a bottom sheet appears listing what they'll lose (8 PRO features). The user must explicitly confirm with "Отменить подписку". Primary CTA is "Оставить Pro".

---

## 10. UI Screens Using Entitlements

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

---

## 11. Upsell Contexts

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

## 12. i18n Keys — Source of Truth

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

## 13. Adding or Changing a PRO Benefit

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

## 14. Known Non-Advertised PRO Gates

These are server-side enforced but not shown on the main paywall (intentionally):

| Feature | Gate type | Rationale |
|---------|-----------|-----------|
| `visibility=PUBLIC_PROFILE` / `PRIVATE` | server 403 | Covered by benefit #8 "Расширенная приватность" |
| `allowSubscriptions=NOBODY` | server 403 | Covered by benefit #8 |
| `commentPolicy=SUBSCRIBERS` | server 403 | Covered by benefit #8 |
| Notification settings (comments/subs) | silent ignore | Advanced feature, not paywall-worthy standalone |
| New wishlist position `bottom` | silent ignore | Minor UX preference |

---

## 15. Degradation Flow

When a user's PRO access expires (subscription lapses, promo grant expires), a `DegradationState` record tracks the transition. This is used by the lifecycle messaging system to send winback messages.

---

## 16. Lifecycle Messaging

The system sends targeted messages via bot DM based on user lifecycle state:
- **Winback**: Users who had PRO and lost it receive re-engagement messages
- **LifecycleTouch** model logs all lifecycle messages to prevent spam
