# ACCESS_MATRIX.md — Access Control Matrix

> Date: 2026-04-02. Verified from source code (`apps/api/src/index.ts`, `apps/web/middleware.ts`).

---

## 1. Auth Tiers

| Tier | Identity | How established | Endpoints |
|------|----------|----------------|-----------|
| **Anonymous** | actorHash in localStorage | Client-computed SHA-256 of a random UUID stored in localStorage | `GET /public/*`, `POST /public/items/:id/reserve|unreserve|purchase` |
| **Telegram user** | Telegram ID + HMAC-validated initData | `X-TG-INIT-DATA` header, validated with `BOT_TOKEN` | All `/tg/*` routes |
| **Admin** | Basic Auth credentials | `Authorization: Basic <base64>` in Next.js middleware, then `X-ADMIN-KEY` to API | `/admin/*` UI, admin API routes |
| **Internal (bot)** | Shared secret = BOT_TOKEN | `X-INTERNAL-KEY` header | `/internal/*` routes |

Telegram auth flow:
1. Client reads `window.Telegram.WebApp.initData`
2. Sends as `X-TG-INIT-DATA` header
3. API validates HMAC using `BOT_TOKEN` via `validateTelegramInitData()`
4. User is auto-upserted in DB (`getOrCreateTgUser()`)

---

## 2. Role Definitions

Within the Telegram auth tier, each request is further classified by **data role**:

| Role | Definition | How determined |
|------|-----------|---------------|
| **owner** | Created the wishlist containing the item | `wishlist.ownerId === user.id` |
| **reserver** | Currently holds a reservation on the specific item | `item.reserverUserId === user.id` (verified via actorHash timing-safe compare) |
| **third_party** | Authenticated Telegram user who is neither owner nor reserver of this item | Default fallback in `getItemRole()` |
| **subscriber** | Follows a wishlist (has a WishlistSubscription row) | `WishlistSubscription.subscriberId === user.id` |

The `getItemRole(itemId, tgUser)` helper returns one of `{ role: 'owner' | 'reserver' | 'third_party', actorHash, item, user }`.

---

## 3. Route-Level Access Matrix

### Health & Static

| Method | Path | Anonymous | TG User | Admin | Internal |
|--------|------|:---------:|:-------:|:-----:|:--------:|
| GET | `/health` | Yes | Yes | Yes | Yes |
| GET | `/health/deep` | Yes | Yes | Yes | Yes |
| GET | `/uploads/:filename` | Yes | Yes | Yes | Yes |

### Public Routes

| Method | Path | Anonymous | TG User | Notes |
|--------|------|:---------:|:-------:|-------|
| GET | `/public/wishlists/:slug` | Yes | Yes | PRIVATE wishlists: 403 unless owner/subscriber |
| GET | `/public/wishlists/:slug/items` | Yes | Yes | Active items only |
| GET | `/public/share/:token` | Yes | Yes | Anyone with token |
| GET | `/public/profiles/:username` | Yes | Yes | Respects profileVisibility |
| POST | `/public/items/:id/reserve` | Yes (actorHash) | Yes | Verified by actorHash; plan.participants limit enforced on owner |
| POST | `/public/items/:id/unreserve` | Yes (actorHash) | Yes | Must own the reservation (actorHash match) |
| POST | `/public/items/:id/purchase` | Yes (actorHash) | Yes | Marks as PURCHASED |

### Telegram Routes — Wishlists

| Method | Path | Requirement | Notes |
|--------|------|------------|-------|
| GET | `/tg/wishlists` | Any TG user | Returns only own wishlists |
| POST | `/tg/wishlists` | Any TG user | 402 at plan.wishlists limit |
| POST | `/tg/wishlists/reorder` | Owner only | All IDs must belong to caller |
| PATCH | `/tg/wishlists/:id` | Owner only | PRO gates on visibility/subscription/comment settings |
| DELETE | `/tg/wishlists/:id` | Owner only | Hard-delete |
| POST | `/tg/wishlists/:id/share-token` | Owner only | Idempotent token generation |
| POST | `/tg/wishlists/:id/archive` | Owner only | |
| POST | `/tg/wishlists/:id/unarchive` | Owner only | |
| POST | `/tg/wishlists/:id/transfer-items` | Owner of both wishlists | |
| POST | `/tg/wishlists/:id/subscribe` | Non-owner TG user | 402 at plan.subscriptions; 403 if subscriptions closed |
| DELETE | `/tg/wishlists/:id/subscribe` | Subscriber | Silently succeeds if not subscribed |
| GET | `/tg/wishlists/:id/subscribe` | Any TG user | Returns subscription status + count |

### Telegram Routes — Items

| Method | Path | Requirement | Notes |
|--------|------|------------|-------|
| GET | `/tg/wishlists/:id/items` | Owner only | No reserver names revealed |
| POST | `/tg/wishlists/:id/items` | Owner only | 402 at plan.items or if wishlist is read-only |
| POST | `/tg/wishlists/:id/items/reorder` | Owner only | Within-priority-group reorder only |
| GET | `/tg/items` | Any TG user | Own items only (across own wishlists) |
| PATCH | `/tg/items/:id` | Owner only | |
| DELETE | `/tg/items/:id` | Owner only | Soft-delete, 90-day TTL |
| POST | `/tg/items/:id/complete` | Owner only | |
| POST | `/tg/items/:id/restore` | Owner only | |
| POST | `/tg/items/:id/move` | Owner only | 402 if target read-only or at limit |
| POST | `/tg/items/:id/reserve` | Non-owner TG user | 402 at owner's plan.participants |
| POST | `/tg/items/:id/unreserve` | Reserver only | actorHash verified |
| POST | `/tg/items/:id/photo` | Owner only | Multipart |
| DELETE | `/tg/items/:id/photo` | Owner only | |

### Telegram Routes — Comments

| Method | Path | Requirement | Notes |
|--------|------|------------|-------|
| GET | `/tg/items/:id/comments` | Owner or Reserver | third_party → 403 |
| POST | `/tg/items/:id/comments` | Owner or Reserver | PRO gate + commentPolicy check |
| DELETE | `/tg/items/:id/comments/:id` | Owner (any comment) or Reserver (own only) | SYSTEM comments undeletable |
| POST | `/tg/items/:id/comments/mark-read` | Any TG user | Upserts read cursor |

### Telegram Routes — Hints

| Method | Path | Requirement | Notes |
|--------|------|------------|-------|
| POST | `/tg/items/:id/hint` | Owner (PRO only) | 402 if FREE; 403 if hintsEnabled=false |
| GET | `/tg/hints/:hintId` | Hint sender (owner) | |

### Telegram Routes — Archive

| Method | Path | Requirement |
|--------|------|------------|
| GET | `/tg/wishlists/:id/archive` | Owner only |
| GET | `/tg/archive` | Any TG user (own items only) |

### Telegram Routes — Profile, Settings, Reservations

| Method | Path | Requirement |
|--------|------|------------|
| GET | `/tg/reservations` | Any TG user (own reservations only) |
| GET/PATCH | `/tg/me/profile` | Any TG user (own profile only) |
| POST/DELETE | `/tg/me/profile/avatar` | Any TG user (own profile only) |
| GET/PATCH | `/tg/me/settings` | Any TG user (own settings only) |
| DELETE | `/tg/me/account` | Any TG user (self-deletion only) |
| GET/POST | `/tg/me/subscriptions` | Any TG user (own subscriptions only) |
| POST | `/tg/me/subscriptions/:id/read` | Subscription owner |
| GET/POST | `/tg/me/plan` and `/tg/billing/*` | Any TG user (own billing only) |
| POST | `/tg/me/god-mode` | Whitelisted TG IDs only |

### Telegram Routes — Billing & Add-ons

| Method | Path | Requirement | Notes |
|--------|------|------------|-------|
| GET | `/tg/me/plan` | Any TG user | Own plan + usage counters |
| POST | `/tg/billing/pro/checkout` | Any TG user | Creates Telegram Stars invoice |
| POST | `/tg/billing/pro/sync` | Any TG user | Verifies subscription after payment |
| GET | `/tg/billing/history` | Any TG user | Own payment history |
| POST | `/tg/billing/subscription/cancel` | Subscriber | Soft-cancel |
| POST | `/tg/billing/subscription/reactivate` | Subscriber | Re-enable auto-renewal |
| POST | `/tg/billing/addon/checkout` | Any TG user | Creates Stars invoice for SKU. Body: `{ sku, targetId? }` |
| POST | `/tg/billing/addon/sync` | Any TG user | Verifies add-on purchase |
| GET | `/tg/billing/addon/status` | Any TG user | Own add-on inventory |
| POST | `/tg/billing/gift-notes/checkout` | Any TG user | Creates Stars invoice for Gift Notes unlock |
| POST | `/tg/billing/gift-notes/sync` | Any TG user | Verifies Gift Notes purchase |

### Telegram Routes — Gift Occasions

| Method | Path | Requirement | Notes |
|--------|------|------------|-------|
| GET | `/tg/gift-occasions` | Any TG user | Own occasions. Requires Gift Notes access (PRO or unlocked) |
| POST | `/tg/gift-occasions` | Any TG user | Create occasion. Requires Gift Notes access |
| PATCH | `/tg/gift-occasions/:id` | Occasion owner | |
| DELETE | `/tg/gift-occasions/:id` | Occasion owner | |

### Telegram Routes — Promo

| Method | Path | Requirement | Notes |
|--------|------|------------|-------|
| POST | `/tg/promo/apply` | Any TG user | Rate limited: 5/60s. Body: `{ code }` |

### Internal Routes

| Method | Path | Requirement |
|--------|------|------------|
| POST | `/internal/import-url` | X-INTERNAL-KEY (= BOT_TOKEN) |

### Admin Routes (private router)

| Method | Path | Requirement |
|--------|------|------------|
| POST/PATCH/DELETE | `/wishlists`, `/wishlists/:id` | X-ADMIN-KEY |
| POST/PATCH/DELETE | `/wishlists/:id/items`, `/items/:id` | X-ADMIN-KEY |
| POST/PATCH/DELETE | `/wishlists/:id/tags`, `/tags/:id` | X-ADMIN-KEY |
| POST/DELETE | `/items/:itemId/tags/:tagId` | X-ADMIN-KEY |

---

## 4. PRO vs FREE Feature Access

All gates are **server-side enforced**. The client UI shows upsell prompts but cannot bypass the API checks.

### Quantitative Limits

| Resource | FREE limit | PRO limit | HTTP error on exceed |
|----------|:----------:|:---------:|:-------------------:|
| Wishlists (REGULAR, non-archived) | 2 | 10 | 402 |
| Items per wishlist (active) | 20 | 70 | 402 |
| Distinct reservers per wishlist | 5 | 20 | 402 |
| Subscriptions (wishlists followed) | 2 | 5 | 402 |
| Items in SYSTEM_DRAFTS | 50 | 50 | 402 (same for both) |

When the wishlist count exceeds plan.wishlists, excess wishlists become `readOnly: true` — they are still visible but items cannot be added to them (402).

### Effective Limits (Base + Add-ons)

Add-ons extend base plan limits. `getEffectiveEntitlements()` computes the actual limits used for enforcement:

| Resource | FREE base | FREE max (with add-ons) | PRO base | PRO max (with add-ons) |
|----------|:---------:|:----------------------:|:--------:|:---------------------:|
| Wishlists | 2 | 5 (max 3 slots) | 10 | 15 (max 5 slots) |
| Items per wishlist | 20 | 50 (+5×3 or +15×1) | 70 | 100 (+5×3 or +15×1) |
| Subscriptions | 2 | 5 (max 3 slots) | 5 | 8 (max 3 slots) |

### Credits-Based Feature Access

FREE users can access PRO-gated features via credits purchased as consumable add-ons:

| Feature | FREE without credits | FREE with credits | PRO |
|---------|:-------------------:|:-----------------:|:---:|
| Hints | 402 blocked | 1 credit per use | Unlimited |
| URL import | 402 blocked | 1 credit per use | Unlimited |
| Comments | 402 blocked (unless other party is PRO) | No credit path | Unlimited |

### Gift Notes Access

| User type | Access |
|-----------|--------|
| PRO | Included |
| FREE + `gift_notes_unlock` purchased | Full access |
| FREE without unlock | 403 (paywall shown, 19 XTR) |
| God Mode | Included |

### Feature Gates

| Feature | FREE | PRO | Gate behavior |
|---------|:----:|:---:|--------------|
| Comments (read + write) | No | Yes | 402 `{ error: 'Pro feature', feature: 'comments' }` — the code checks if **both** parties lack the feature; if **either** party (owner or commenter) has PRO, access is granted (OR logic) |
| URL import (`/tg/import-url`) | No | Yes | 402 `{ error: 'Pro feature', feature: 'url_import' }` |
| Hint waves (`/tg/items/:id/hint`) | No | Yes | 402 `{ error: 'Pro feature', feature: 'hints' }` |
| Wishlist visibility `PUBLIC_PROFILE` | No | Yes | 403 `{ error: 'pro_required' }` |
| Wishlist visibility `PRIVATE` | No | Yes | 403 `{ error: 'pro_required' }` |
| `allowSubscriptions=NOBODY` | No | Yes | 403 `{ error: 'pro_required' }` |
| `commentPolicy=SUBSCRIBERS` | No | Yes | 403 `{ error: 'pro_required' }` |
| Sort: `recommended` | Client only (no API gate) | Yes | Upsell shown in UI; API has no gate on sort |

### Settings Fields Silently Ignored for FREE Users

When FREE users submit these fields in `PATCH /tg/me/settings`, they are **silently dropped** (no error):

| Field | PRO required |
|-------|:------------:|
| `notifications.comments` | Yes |
| `notifications.subscriptions` | Yes |
| `privacy.commentsEnabled` | Yes |
| `appBehavior.newWishlistPosition = 'bottom'` | Yes |

Available to all (FREE and PRO): `defaultCurrency`, `notifications.reservations`, `notifications.marketing`, `privacy.profileVisibility`, `privacy.subscribePolicy`, `privacy.hintsEnabled`.

---

## 5. Data Visibility Rules

### What Different Roles Can See on an Item

| Data | Owner | Reserver | Third party | Anonymous (public page) |
|------|:-----:|:--------:|:-----------:|:-----------------------:|
| Item title, price, description, URL, image | Yes | Yes | Yes | Yes |
| Item priority | Yes | Yes | Yes | Yes |
| Item status (available/reserved/purchased) | Yes | Yes | Yes | Yes |
| WHO reserved (name/Telegram ID) | **No** | Own name only | No | No |
| reservedByDisplayName (for guest UI "reserved by X") | No (hidden from owner) | Yes (own) | Yes | Yes |
| reservedByActorHash | No | Yes (own) | Yes (for "reserved by me" detection) | Yes |
| Comments | Yes (own PRO or reserver PRO) | Yes (own PRO or owner PRO) | **No** (403) | **No** |
| Archive (DELETED/COMPLETED) | Yes | No | No | No |

### Wishlist-Level Visibility

Owner's wishlist visibility setting (`WishlistVisibility`) controls who can access `GET /public/wishlists/:slug`:

| Setting | Effect |
|---------|--------|
| `LINK_ONLY` (default) | Anyone with the link/slug can view |
| `PUBLIC_PROFILE` (PRO) | Anyone can view; wishlist appears on public profile page |
| `PRIVATE` (PRO) | Only owner and subscribers can view; 403 for everyone else |

### Profile Visibility

`profileVisibility` setting controls `GET /public/profiles/:username`:

| Setting | Effect |
|---------|--------|
| `ALL` | Profile + public wishlists visible to anyone |
| `LINK_ONLY` | Profile visible but wishlists not listed (isPublic=false) |
| `SUBSCRIBERS` | Profile visible to subscribers only (not enforced for direct URL — returns profile without wishlists) |
| `NOBODY` | Returns 404 for everyone |

### Subscription Policy

`subscribePolicy` (profile-level) and `allowSubscriptions` (wishlist-level) control who can subscribe:

| allowSubscriptions (wishlist) | subscribePolicy (owner profile) | Result |
|:-----------------------------:|:-------------------------------:|--------|
| `ALL` | `ALL` | Anyone can subscribe |
| `ALL` | `NOBODY` | 403 `subscriptions_closed` |
| `NOBODY` (PRO) | Any | 403 `subscriptions_closed` |

Subscription check order: wishlist-level `allowSubscriptions` is checked first, then owner's `subscribePolicy`.

### Comment Policy

`commentPolicy` (wishlist-level) controls non-owner comment access:

| commentPolicy | Effect |
|:-------------:|--------|
| `ALL` (default) | Any reserver with PRO access can comment |
| `SUBSCRIBERS` (PRO) | Only reservers who are also wishlist subscribers can comment; 403 `comments_restricted` for others |

---

## 6. Privacy: Reserver Anonymity

This is a core design principle. The owner **never** learns the identity of a reserver through any API response:

- `GET /tg/wishlists/:id/items` (owner view): no reservation events, no reserver names, no actorHash
- Owner-side comments: owner sees `authorDisplayName` (the name the reserver provided at reservation time), but never the Telegram ID
- Owner Telegram notification on reservation: includes `displayName` only (the name the reserver chose)
- The `reservedByActorHash` field is exposed in the **public** and **guest** item views to allow "is this reserved by me?" detection client-side, but the owner's owner-view endpoint does not return it

The server uses `actorHash = SHA-256('tg_actor:' + telegramId)` formatted as UUID as the opaque identifier for reservers.

---

## 7. God Mode

God Mode is a virtual PRO entitlement for whitelisted Telegram accounts. It is never available in production to regular users.

| Behavior | Details |
|----------|---------|
| **Activation** | `POST /tg/me/god-mode` toggles it; only TG IDs in `GOD_MODE_TELEGRAM_IDS` env var can toggle |
| **Effect on entitlements** | `getUserEntitlement(userId, godMode=true)` returns `PLANS.PRO` without a real subscription row |
| **Effect on hints** | Hint spam limits (3/item/30d, 5/day) are bypassed |
| **No real subscription** | `subscription` field is `null` even when godMode is active |
| **Visibility** | `godMode: bool` and `canGodMode: bool` are returned in `/tg/wishlists`, `/tg/me/plan`, and `/tg/me/profile` responses |
| **Not billable** | God mode does not create any payment events and does not affect Telegram Stars billing |
