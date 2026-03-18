# API_REFERENCE.md — Complete Endpoint Reference

> Date: 2026-03-17. Verified from `apps/api/src/index.ts`.

---

## Base URLs

| Environment | URL |
|-------------|-----|
| Production | `https://<domain>/api` (Nginx proxies `/api/*` → port 3001) |
| Development | `http://localhost:3001` |

Uploads are served as static files at `/api/uploads/<filename>`.

---

## Auth Headers

| Tier | Header | Value | Used by |
|------|--------|-------|---------|
| Public | — | none | Anonymous clients, public wishlist page |
| Telegram | `X-TG-INIT-DATA` | Telegram WebApp `initData` string (HMAC-validated) | Mini App |
| Admin | `X-ADMIN-KEY` | `ADMIN_KEY` env var (timing-safe compare) | Admin panel (Next.js pages) |
| Internal | `X-INTERNAL-KEY` | `BOT_TOKEN` env var (timing-safe compare) | Bot → API server-to-server |
| Dev bypass | `X-TG-DEV` | Telegram ID number (non-production only) | Local development |

---

## Rate Limiters

| Limiter | Window | Limit | Applied to |
|---------|--------|-------|-----------|
| `publicReadLimiter` | 60 s | 120 req | `GET /public/*` |
| `publicActionLimiter` | 15 min | 30 req | `POST /public/items/*` |
| `importUrlLimiter` | 60 s | 10 req/user | `POST /tg/import-url` |
| `internalImportLimiter` | 60 s | 30 req | `POST /internal/import-url` |

---

## Health

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | None | Returns `{ ok: true }` |
| GET | `/health/deep` | None | Checks DB (`SELECT 1`) + bot heartbeat (stale if >120 s). Returns `{ ok, checks: { db, bot, version } }`. Status 200 if all ok, 503 if any check fails |

---

## Public Routes (`/public/*`)

No authentication required. Rate limited.

### Wishlists

| Method | Path | Description |
|--------|------|-------------|
| GET | `/public/wishlists/:slug` | Fetch wishlist by slug + active items. Respects `visibility`: PRIVATE wishlists return 403 `wishlist_private` unless the requester is the owner or a subscriber (TG auth optional). Response: `{ wishlist, items[], tags[] }` |
| GET | `/public/wishlists/:slug/items` | Fetch items for a wishlist by slug. Query params: `status` (AVAILABLE/RESERVED/PURCHASED), `tag` (tag id). Response: `{ items[] }` |
| GET | `/public/share/:token` | Resolve share token → same response shape as `/public/wishlists/:slug`. 404 if token not found or migration not applied |
| GET | `/public/profiles/:username` | Public user profile. Respects `profileVisibility`: NOBODY → 404. ALL → includes `wishlists[]` (PUBLIC_PROFILE, non-archived only). Response: `{ profile: { displayName, username, bio, avatarUrl, isPublic }, wishlists[] }` |

### Reservations (anonymous / public page)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/public/items/:id/reserve` | actorHash in body | Reserve an item. Body: `{ actorHash: uuid, comment?: string }`. 409 if already reserved. Response: `{ item }` |
| POST | `/public/items/:id/unreserve` | actorHash in body | Unreserve. Verifies actorHash matches most recent RESERVED event. 403 if not owner of reservation. 409 if not reserved |
| POST | `/public/items/:id/purchase` | actorHash in body | Mark item as PURCHASED. Body: `{ actorHash, comment? }`. 409 if already purchased |

---

## Telegram Routes (`/tg/*`)

All routes require `X-TG-INIT-DATA` (HMAC-validated). User is auto-upserted on every request via `getOrCreateTgUser()`.

### Wishlists

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/wishlists` | Owner | My wishlists (REGULAR, non-archived). Response: `{ wishlists[], plan, subscription, godMode, canGodMode, drafts, reservationsCount }`. Each wishlist includes `readOnly: idx >= plan.wishlists` |
| POST | `/tg/wishlists` | Any auth user | Create wishlist. Body: `{ title, deadline? }`. **402** if count >= plan.wishlists limit. Inherits `commentPolicy` and insert position from profile settings |
| PATCH | `/tg/wishlists/:id` | Owner | Update title, deadline, visibility, allowSubscriptions, commentPolicy. **403** if FREE user sets `visibility=PUBLIC_PROFILE|PRIVATE`, `allowSubscriptions=NOBODY`, or `commentPolicy=SUBSCRIBERS`. Notifies subscribers of title/deadline changes |
| DELETE | `/tg/wishlists/:id` | Owner | Hard-delete wishlist. Repacks positions of remaining wishlists |
| POST | `/tg/wishlists/reorder` | Owner | Drag-and-drop reorder. Body: `{ orderedIds: string[] }`. Validates all IDs belong to owner. Updates `position` field transactionally |
| POST | `/tg/wishlists/:id/share-token` | Owner | Get or create 12-char URL-safe share token. Idempotent. Response: `{ shareToken }` |
| POST | `/tg/wishlists/:id/archive` | Owner | Soft-archive: sets `archivedAt`. 409 if already archived |
| POST | `/tg/wishlists/:id/unarchive` | Owner | Restore: clears `archivedAt` |
| POST | `/tg/wishlists/:id/transfer-items` | Owner | Move RESERVED items to another wishlist before deletion. Body: `{ targetWishlistId }`. 409 if target is archived or has insufficient capacity |
| POST | `/tg/wishlists/:id/subscribe` | Non-owner | Follow wishlist. **402** if subscriber count >= plan.subscriptions. **403** if `allowSubscriptions=NOBODY` or owner `subscribePolicy=NOBODY`. Response: `{ subscription: { id, wishlistId } }` |
| DELETE | `/tg/wishlists/:id/subscribe` | Subscriber | Unfollow wishlist |
| GET | `/tg/wishlists/:id/subscribe` | Any auth user | Subscription status + subscriber count. Response: `{ subscribed: bool, subscriberCount: number }` |

### Items — Owner View

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/wishlists/:id/items` | Owner | Active items in wishlist (status in AVAILABLE/RESERVED/PURCHASED). Owner view: no reserver names. Response: `{ items[] }` |
| POST | `/tg/wishlists/:id/items` | Owner | Add item. Body: `{ title, url?, price?, priority?(1-3), imageUrl?, currency? }`. **402** if itemCount >= plan.items. **402** if wishlist is read-only (over plan.wishlists). Currency falls back to profile default |
| POST | `/tg/wishlists/:id/items/reorder` | Owner | Reorder items within priority groups. Body: `{ groups: [{ priority: LOW|MEDIUM|HIGH, orderedIds: string[] }] }`. Validates IDs match declared priority |
| GET | `/tg/items` | Owner | Flat list of all active items across all non-archived wishlists. Includes `wishlistTitle` and `wishlistSlug`. Response: `{ items[] }` |
| PATCH | `/tg/items/:id` | Owner | Edit item fields: title, url, price, priority, imageUrl, description, currency. Notifies subscribers and (if reserved + description changed) the reserver via Telegram |
| DELETE | `/tg/items/:id` | Owner | Soft-delete: sets `status=DELETED`, `archivedAt=now`, `purgeAfter=+90d`. Cancels active hints. Notifies reserver |
| POST | `/tg/items/:id/complete` | Owner | Mark as received: `status=COMPLETED`, `archivedAt=now`, `purgeAfter=+90d`. Sets 30-day TTL on comments. Cancels hints. Notifies reserver |
| POST | `/tg/items/:id/restore` | Owner | Restore DELETED or COMPLETED item to AVAILABLE. Clears `archivedAt`, `purgeAfter`. Response: `{ item, wishlistId, wishlistTitle }` |
| POST | `/tg/items/:id/move` | Owner | Move item to different wishlist. Body: `{ targetWishlistId }`. **402** if target is read-only or at item limit |

### Items — Guest Actions

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| POST | `/tg/items/:id/reserve` | Non-owner | Reserve item. Body: `{ displayName? }`. **402** if distinct reservers >= owner's plan.participants. Notifies owner. Cancels active hints |
| POST | `/tg/items/:id/unreserve` | Reserver | Unreserve own reservation. Verified by actorHash matching. Sets 30-day TTL on comments |

### Archive

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/wishlists/:id/archive` | Owner | Archived items (DELETED + COMPLETED) for specific wishlist. Response: `{ items[] }` |
| GET | `/tg/archive` | Owner | Global archive: all DELETED + COMPLETED items across all wishlists. Includes `wishlistTitle`, `wishlistId`, `wishlistIsArchived`. Ordered by `updatedAt DESC` |

### Reservations

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/reservations` | Auth user | Items reserved by the current user (status=RESERVED, reserverUserId=me). Includes `ownerName`, `ownerId`, `unreadComments` per item. Response: `{ reservations[] }` |

### Comments (PRO-gated)

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/items/:id/comments` | Owner or Reserver | List comments. Third-party → 403. Previous-epoch comments anonymized for reserver. Response: `{ comments[], role }` |
| POST | `/tg/items/:id/comments` | Owner or Reserver | Create comment. Body: `{ text: string (max 300) }`. **402** if neither owner nor commenter has PRO. **403** if `commentPolicy=SUBSCRIBERS` and commenter is not a subscriber. Anti-spam: 10 s cooldown, no duplicates, max 3 consecutive without reply, max 10/hour, max 20/30 days. Notifies the other party via Telegram (30 s batched debounce) |
| DELETE | `/tg/items/:id/comments/:commentId` | Owner or comment author | Delete comment. Owner can delete any user comment. Reserver can only delete own. SYSTEM comments cannot be deleted |
| POST | `/tg/items/:id/comments/mark-read` | Auth user | Upsert read cursor to current timestamp. Used to compute `unreadComments` count |

### Hints (PRO-gated)

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| POST | `/tg/items/:id/hint` | Owner (PRO) | Create hint wave. **402** if not PRO. **403** if `hintsEnabled=false`. **400** if item is not AVAILABLE. **429** if >3 hints for this item in 30 days or >5 hints per sender per day (godMode bypasses spam limits). Sends Telegram contact picker to owner's chat. Response: `{ hintId, status: 'pending_selection' }` |
| GET | `/tg/hints/:hintId` | Owner | Poll hint delivery status. Response: `{ hintId, status, sentCount, pendingCount, deliveredAt, itemTitle }` |

### Photos

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| POST | `/tg/items/:id/photo` | Owner | Upload item photo (multipart `photo` field). Processed with sharp: resize to 1600px, JPEG 80%, strip EXIF. Thumbnail generated at 480px. Deletes previous file. Max upload 30 MB. Response: `{ photoUrl, thumbUrl, width, height, sizeBytes }` |
| DELETE | `/tg/items/:id/photo` | Owner | Remove item photo. Deletes local file |

### URL Import (PRO-gated)

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| POST | `/tg/import-url` | Auth user (PRO) | Parse URL and create item in SYSTEM_DRAFTS. Body: `{ url, note?, source? }`. **402** if not PRO. **402** if SYSTEM_DRAFTS has >= 50 items. Rate-limited: 10 req/min per user. Response: `{ item, wishlistId, parseStatus: 'ok'|'partial'|'failed' }` |

### Subscriptions (Following)

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/me/subscriptions` | Auth user | Wishlists the user follows with unread counts. Response: `{ subscriptions[] }` each with `{ id, wishlist: { id, slug, title, deadline, archivedAt, itemCount, ownerName }, unreadCount, unreadEntityIds[] }` |
| POST | `/tg/me/subscriptions/:id/read` | Subscriber | Mark all unread items for a subscription as read (deletes SubscriptionUnread rows) |

### Profile

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/me/profile` | Auth user | Profile + stats + plan info. Response: `{ profile: { displayName, username, bio, avatarUrl, birthday, hideYear, defaultCurrency }, stats: { wishlists, wishlistsLimit, totalWishes, wishesLimit, reservedByMe, archived }, plan, subscription, godMode, canGodMode }` |
| PATCH | `/tg/me/profile` | Auth user | Update displayName (nullable), username (nullable, 3-30 chars, `[a-zA-Z0-9_]`), bio (nullable, max 300), birthday (nullable date string), hideYear (bool). 409 if username already taken |
| POST | `/tg/me/profile/avatar` | Auth user | Upload avatar photo (multipart `avatar` field). Resized to 512px, JPEG 80%. Deletes previous avatar. Response: `{ avatarUrl }` |
| DELETE | `/tg/me/profile/avatar` | Auth user | Remove avatar. Deletes local file |

### Settings

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/me/settings` | Auth user | All settings. Response: `{ language, defaultCurrency, notifications: { comments, reservations, subscriptions, marketing }, privacy: { profileVisibility, subscribePolicy, commentsEnabled, hintsEnabled }, appBehavior: { newWishlistPosition }, isPro }` |
| PATCH | `/tg/me/settings` | Auth user | Update settings. PRO-gated fields silently ignored for FREE users: `notifications.comments`, `notifications.subscriptions`, `privacy.commentsEnabled`, `appBehavior.newWishlistPosition='bottom'`. `hintsEnabled` and `defaultCurrency` are available to all. `notifyReservations` and `notifyMarketing` are available to all |
| DELETE | `/tg/me/account` | Auth user | Permanently delete account and all related data (cascades via Prisma) |

### Plan & Billing

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/me/plan` | Auth user | Current plan, subscription, usage counters. Response: `{ plan: { code, wishlists, items, participants, features[] }, subscription, usage: { wishlists }, proPriceStars, godMode, canGodMode }` |
| POST | `/tg/billing/pro/checkout` | Auth user | Create Telegram Stars invoice link. Returns `{ alreadySubscribed: true }` if already active PRO. Creates `invoice_created` payment event. Response: `{ invoiceUrl, checkoutSessionId }` |
| POST | `/tg/billing/pro/sync` | Auth user | Re-query subscription state (poll after payment). Does NOT activate — bot activates via direct DB write. Response: `{ plan, subscription }` |
| GET | `/tg/billing/history` | Auth user | Last 20 payment events. Response: `{ events[] }` |
| POST | `/tg/billing/subscription/cancel` | Auth user (PRO) | Soft-cancel: sets `cancelAtPeriodEnd=true`, `cancelledAt=now`. PRO access continues until period end. 404 if no active subscription |
| POST | `/tg/billing/subscription/reactivate` | Auth user (PRO cancelled) | Re-enable auto-renewal: clears `cancelAtPeriodEnd` and `cancelledAt`. 404 if no cancelled subscription in period |

### Dev / God Mode

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| POST | `/tg/me/god-mode` | Whitelisted TG IDs | Toggle godMode boolean on user record. Controlled by `GOD_MODE_TELEGRAM_IDS` env var. When godMode=true: user has virtual PRO entitlement, hint spam limits are bypassed |

---

## Internal Routes (`/internal/*`)

Requires `X-INTERNAL-KEY` header equal to `BOT_TOKEN`. Used by the bot process for server-to-server calls.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/internal/import-url` | Parse URL and create item in SYSTEM_DRAFTS for a given `userId`. Body: `{ userId, url, note?, source? }`. **402** if user is not PRO. **402** if SYSTEM_DRAFTS >= 50 items. Rate-limited: 30 req/min. Response: `{ item, wishlistId, parseStatus }` |

Note: Subscription activation is handled directly by the bot process writing to the database (not via an internal HTTP endpoint).

---

## Admin Routes (private router, no path prefix)

Requires `X-ADMIN-KEY` header. Used by the Next.js admin panel pages. These routes operate on behalf of the system user, not a Telegram user.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/wishlists` | Create wishlist. Body: `{ title, description? }` |
| PATCH | `/wishlists/:id` | Update title / description |
| DELETE | `/wishlists/:id` | Hard-delete wishlist |
| POST | `/wishlists/:id/items` | Add item to wishlist. Body: `{ title, url, priceText?, commentOwner?, priority?, deadline?, imageUrl? }` |
| PATCH | `/items/:id` | Edit item fields including status |
| DELETE | `/items/:id` | Hard-delete item |
| POST | `/wishlists/:id/tags` | Create tag for wishlist. Body: `{ name }` |
| PATCH | `/tags/:id` | Rename tag |
| DELETE | `/tags/:id` | Delete tag |
| POST | `/items/:itemId/tags/:tagId` | Associate tag with item |
| DELETE | `/items/:itemId/tags/:tagId` | Remove tag from item |

---

## Static Files

| Path | Description |
|------|-------------|
| GET `/uploads/:filename` | Serve uploaded files (photos, avatars). `Cache-Control: max-age=30d, immutable` |

---

## Maintenance Mode

When `MAINTENANCE_MODE=true` env var is set, all `/tg/*` and `/public/*` routes return:

```json
{ "error": "Service temporarily unavailable", "code": "MAINTENANCE" }
```

HTTP status 503. Routes `/health`, `/health/deep`, `/uploads/*`, `/internal/*` remain accessible.

---

## Background Jobs (in-process, hourly interval)

| Job | Action |
|-----|--------|
| Comment TTL cleanup | Hard-deletes `Comment` rows where `scheduledDeleteAt <= now` |
| Archive purge | Hard-deletes `Item` rows where `purgeAfter <= now` (batch 100). Deletes associated media files |
| Subscription expiry | Sets `status=EXPIRED` on subscriptions where `currentPeriodEnd <= now` |
| Hint expiry | Sets `status=EXPIRED` on hints where `status=SENT` and `expiresAt <= now` |

---

## Key Response Shapes

### Item (TG view)

```typescript
{
  id: string;
  wishlistId: string;
  title: string;
  url: string | null;
  price: number | null;          // parsed from priceText
  currency: 'RUB' | 'USD' | null;
  imageUrl: string | null;
  priority: 1 | 2 | 3;          // 1=LOW, 2=MEDIUM, 3=HIGH
  position: number;
  status: 'available' | 'reserved' | 'purchased' | 'completed' | 'deleted';
  description: string | null;
  sourceUrl: string | null;
  sourceDomain: string | null;
  importMethod: string | null;
}
```

### Plan

```typescript
{
  code: 'FREE' | 'PRO';
  wishlists: 2 | 10;
  items: 30 | 100;
  participants: 5 | 20;
  features: [] | ['comments', 'url_import', 'hints'];
}
```

### Subscription

```typescript
{
  id: string;
  status: 'ACTIVE' | 'CANCELLED' | 'EXPIRED';
  periodEnd: string;             // ISO 8601
  cancelledAt: string | null;
  cancelAtPeriodEnd: boolean;
} | null
```

### Comment

```typescript
{
  id: string;
  type: 'USER' | 'SYSTEM';
  authorActorHash: string | null;
  authorDisplayName: string | null;
  text: string;
  reservationEpoch: number;
  createdAt: string;             // ISO 8601
}
```
