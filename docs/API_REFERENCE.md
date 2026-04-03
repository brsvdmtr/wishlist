# API_REFERENCE.md — Complete Endpoint Reference

> Last updated: 2026-04-02. Verified from `apps/api/src/index.ts` (~11,964 lines, 157+ route handlers).

---

## Base URLs

| Environment | URL |
|-------------|-----|
| Production | `https://<domain>/api` (Nginx proxies `/api/*` to port 3001) |
| Development | `http://localhost:3001` |

Uploads are served as static files at `/api/uploads/<filename>`.

---

## Auth Headers

| Tier | Header | Value | Used by |
|------|--------|-------|---------|
| Public | — | none | Anonymous clients, public wishlist page |
| Telegram | `X-TG-INIT-DATA` | Telegram WebApp `initData` string (HMAC-validated) | Mini App |
| Admin | `X-ADMIN-KEY` | `ADMIN_KEY` env var (timing-safe compare) | Admin panel (Next.js pages) |
| Internal | `X-INTERNAL-KEY` | `BOT_TOKEN` env var (timing-safe compare) | Bot to API server-to-server |
| Dev bypass | `X-TG-DEV` | Telegram ID number (non-production only) | Local development |

---

## Rate Limiters

| Limiter | Window | Limit | Applied to |
|---------|--------|-------|-----------|
| `publicReadLimiter` | 60 s | 120 req | `GET /public/*` |
| `publicActionLimiter` | 15 min | 30 req | `POST /public/items/*` |
| `importUrlLimiter` | 60 s | 10 req/user | `POST /tg/import-url` |
| `internalImportLimiter` | 60 s | 30 req | `POST /internal/import-url` |
| `promoLimiter` | 60 s | 5 req/user | `POST /tg/promo/apply` |
| `onboardingImportLimiter` | 60 s | 3 req/user | `POST /tg/onboarding/try-import` |

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
| GET | `/public/share/:token` | Resolve share token to wishlist + items. Increments `shareOpenCount` (fire-and-forget). 404 if token not found. Response same shape as `/public/wishlists/:slug` |
| GET | `/public/profiles/:username` | Public user profile. Respects `profileVisibility`: NOBODY returns 404. ALL includes `wishlists[]` (PUBLIC_PROFILE, non-archived only). Respects `avatarPublic` setting. Response: `{ profile, wishlists[] }` |

### Reservations (anonymous / public page)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/public/items/:id/reserve` | actorHash in body | Reserve an item. Body: `{ actorHash: uuid, comment?: string }`. 409 if already reserved. Response: `{ item }` |
| POST | `/public/items/:id/unreserve` | actorHash in body | Unreserve. Verifies actorHash matches most recent RESERVED event. 403 if mismatch. 409 if not reserved |
| POST | `/public/items/:id/purchase` | actorHash in body | Mark item as PURCHASED. Body: `{ actorHash, comment? }`. 409 if already purchased |

---

## Telegram Routes (`/tg/*`)

All routes require `X-TG-INIT-DATA` (HMAC-validated). User is auto-upserted on every request via `getOrCreateTgUser()`.

### Wishlists

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/wishlists` | Owner | My wishlists (REGULAR, non-archived). Response includes `plan`, `subscription`, `proSource`, `promoPro`, `giftNotes`, `godMode`, `canGodMode`, `drafts`, `reservationsCount`, `addOns`, `credits`, `skus`, `cardDisplayMode`. Each wishlist includes `readOnly` flag |
| POST | `/tg/wishlists` | Any auth | Create wishlist. Body: `{ title, deadline? }`. **402** if count >= effective wishlist limit. Inherits `commentPolicy` and insert position from profile settings |
| PATCH | `/tg/wishlists/:id` | Owner | Update title, deadline, visibility, allowSubscriptions, commentPolicy. **403** if FREE user sets `visibility=PUBLIC_PROFILE|PRIVATE`, `allowSubscriptions=NOBODY`, or `commentPolicy=SUBSCRIBERS`. Notifies subscribers of title/deadline changes |
| DELETE | `/tg/wishlists/:id` | Owner | Hard-delete wishlist. Blocks if linked to active Santa campaign. Repacks positions |
| POST | `/tg/wishlists/reorder` | Owner | Drag-and-drop reorder. Body: `{ orderedIds: string[] }`. Updates `position` field transactionally |
| POST | `/tg/wishlists/:id/share-token` | Owner | Get or create 12-char URL-safe share token. Idempotent |
| POST | `/tg/wishlists/:id/archive` | Owner | Soft-archive: sets `archivedAt`. Blocks if linked to active Santa campaign. 409 if already archived |
| POST | `/tg/wishlists/:id/unarchive` | Owner | Restore: clears `archivedAt` |
| POST | `/tg/wishlists/:id/transfer-items` | Owner | Move RESERVED items to another wishlist before deletion. Body: `{ targetWishlistId }`. 409 if target is archived or has insufficient capacity |
| POST | `/tg/wishlists/:id/subscribe` | Non-owner | Follow wishlist. **402** if subscriber count >= effective subscription limit. **403** if `allowSubscriptions=NOBODY` or owner `subscribePolicy=NOBODY` |
| DELETE | `/tg/wishlists/:id/subscribe` | Subscriber | Unfollow wishlist |
| GET | `/tg/wishlists/:id/subscribe` | Any auth | Subscription status + subscriber count. Response: `{ subscribed, subscriberCount }` |

### Items — Owner View

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/wishlists/:id/items` | Owner | Active items in wishlist. Owner view: no reserver names |
| POST | `/tg/wishlists/:id/items` | Owner | Add item. Body: `{ title, url?, price?, priority?(1-3), imageUrl?, currency? }`. **402** if itemCount >= effective item limit. Currency falls back to profile default |
| POST | `/tg/wishlists/:id/items/reorder` | Owner | Reorder items within priority groups. Body: `{ groups: [{ priority, orderedIds }] }` |
| GET | `/tg/items` | Owner | Flat list of all active items across non-archived wishlists. Includes `wishlistTitle`, `wishlistSlug` |
| PATCH | `/tg/items/:id` | Owner | Edit item fields: title, url, price, priority, imageUrl, description, currency. Notifies subscribers. If reserved + description changed, creates SYSTEM comment and notifies reserver |
| DELETE | `/tg/items/:id` | Owner | Soft-delete: `status=DELETED`, `archivedAt=now`, `purgeAfter=+90d`. Cancels hints. Notifies reserver |
| POST | `/tg/items/:id/complete` | Owner | Mark as received: `status=COMPLETED`, `archivedAt=now`, `purgeAfter=+90d`. Sets 30-day TTL on comments. Cancels hints. Notifies reserver |
| POST | `/tg/items/:id/restore` | Owner | Restore DELETED or COMPLETED item to AVAILABLE. Clears `archivedAt`, `purgeAfter` |
| POST | `/tg/items/:id/move` | Owner | Move item to different wishlist. Body: `{ targetWishlistId }`. **402** if target is read-only or at item limit. Triggers onboarding completion if demo item moved |
| POST | `/tg/items/:id/copy` | Owner | Copy item to another wishlist (clean copy, no reservations/comments). Body: `{ targetWishlistId }`. **402** if at limit |

### Bulk Item Operations

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| POST | `/tg/items/bulk-move` | Owner | Move multiple items to target wishlist. Body: `{ itemIds, targetWishlistId }`. Returns `{ moved, failed }` |
| POST | `/tg/items/bulk-delete` | Owner | Soft-delete multiple items (`status=DELETED`, `purgeAfter=+90d`). Body: `{ itemIds }` |
| POST | `/tg/items/bulk-restore` | Owner | Restore multiple archived items to AVAILABLE. Body: `{ itemIds }`. Returns `{ restored, failed }` |
| POST | `/tg/items/bulk-archive` | Owner | Archive AVAILABLE items (`status=ARCHIVED`, no purge TTL). Body: `{ itemIds }`. Cannot archive RESERVED items |
| POST | `/tg/items/bulk-copy` | Owner | Copy multiple items to another wishlist. Body: `{ itemIds, targetWishlistId }`. Returns `{ successCount, failureCount, results }` |
| POST | `/tg/items/bulk-hard-delete` | Owner | Permanently delete archived items (DELETED, COMPLETED, or ARCHIVED only). Body: `{ itemIds }` |
| POST | `/tg/archive/purge` | Owner | Permanently delete ALL DELETED/COMPLETED items for the user |

### Items — Guest Actions

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| POST | `/tg/items/:id/reserve` | Non-owner | Reserve item. Body: `{ displayName? }`. **402** if distinct reservers >= owner's plan.participants. Notifies owner. Cancels hints |
| POST | `/tg/items/:id/unreserve` | Reserver | Unreserve own reservation. Verified by actorHash. Sets 30-day TTL on comments |

### Archive

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/wishlists/:id/archive` | Owner | Archived items (DELETED + COMPLETED) for specific wishlist |
| GET | `/tg/archive` | Owner | Global archive: all DELETED + COMPLETED items across all wishlists. Includes `wishlistTitle`, `wishlistId`, `wishlistIsArchived`. Ordered by `updatedAt DESC` |

### Reservations

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/reservations` | Auth user | Items reserved by the current user (status=RESERVED, reserverUserId=me). Includes `ownerName`, `ownerAvatarUrl`, `ownerId`, `unreadComments` per item. For Reservation-PRO users also includes `reservationMeta` (note, purchased, reminderAt) and `reservationPro: true` flag |

### Reservations PRO (beta-gated)

Access controlled by `hasReservationPro()` — currently limited to focus-group users via `RESERVATION_PRO_BETA_IDS` env var (default: `8747175307`). Will open to all PRO users in Phase 2.

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/reservations/history` | Reservation-PRO | Past reservations (active=false). Returns items with `endedAt`, `endReason` ('unreserved' / 'completed' / 'archived'), owner info. Grouped by owner on client. **403** if not Reservation-PRO |
| PATCH | `/tg/reservations/:itemId/meta` | Reservation-PRO | Update private note and/or purchased flag. Body: `{ note?: string (max 500), purchased?: boolean }`. Upserts `ReservationMeta`. **403** if not Reservation-PRO |
| POST | `/tg/reservations/:itemId/reminder` | Reservation-PRO | Set reminder. Body: `{ reminderAt: ISO8601 }`. Must be in the future. Upserts `ReservationMeta`. **403** if not Reservation-PRO. **400** if date is in the past |
| DELETE | `/tg/reservations/:itemId/reminder` | Reservation-PRO | Remove reminder. Sets `reminderAt=null`, `reminderSent=false`. **403** if not Reservation-PRO |

### Comments (PRO-gated)

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/items/:id/comments` | Owner or Reserver | List comments. Third-party returns 403. Previous-epoch comments anonymized for reserver |
| POST | `/tg/items/:id/comments` | Owner or Reserver | Create comment. Body: `{ text: string (max 300) }`. **402** if neither owner nor commenter has PRO. **403** if `commentPolicy=SUBSCRIBERS` and commenter is not subscriber. Anti-spam: 10 s cooldown, no duplicates, max 3 consecutive without reply, max 10/hour, max 20/30 days. Notifies other party via Telegram (30 s batched debounce) |
| DELETE | `/tg/items/:id/comments/:commentId` | Owner or author | Delete comment. Owner can delete any USER comment. Reserver can only delete own. SYSTEM comments cannot be deleted |
| POST | `/tg/items/:id/comments/mark-read` | Auth user | Upsert read cursor to current timestamp |

### Hints (PRO-gated)

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| POST | `/tg/items/:id/hint` | Owner (PRO) | Create hint wave. **402** if not PRO. **403** if `hintsEnabled=false`. **400** if item is not AVAILABLE. **429** if >3 hints for item in 30 days or >5 hints per sender per day (godMode bypasses). Sends contact picker to owner's chat |
| GET | `/tg/hints/:hintId` | Owner | Poll hint delivery status. Response: `{ hintId, status, sentCount, pendingCount, deliveredAt, itemTitle }` |

### Photos

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| POST | `/tg/items/:id/photo` | Owner | Upload item photo (multipart `photo` field). Sharp: resize to 1600px full + 480px thumb, JPEG 80%/70%. Deletes previous file. Max 30 MB |
| DELETE | `/tg/items/:id/photo` | Owner | Remove item photo. Deletes local file |

### URL Import (PRO-gated)

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| POST | `/tg/import-url` | Auth user (PRO) | Parse URL and create item in SYSTEM_DRAFTS. Body: `{ url, note?, source? }`. **402** if not PRO. **402** if SYSTEM_DRAFTS >= 50 items. Rate-limited: 10 req/min per user. Supports `X-Parse-No-Cache: 1` header |

### Subscriptions (Following)

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/me/subscriptions` | Auth user | Wishlists the user follows with unread counts. Includes `unreadItemCounts` per-item breakdown |
| GET | `/tg/me/subscriptions/meta` | Auth user | Lightweight unread summary for boot badge. Response: `{ unreadCount, hasUnread, subscriptionsWithUnread }` |
| POST | `/tg/me/subscriptions/:id/read` | Subscriber | Mark all unread items for a subscription as read (deletes SubscriptionUnread rows) |

### Profile

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/me/profile` | Auth user | Profile + stats + plan info. Includes `supportId`, `avatarThumbUrl`, `avatarUpdatedAt`, `avatarPublic`, `language` |
| PATCH | `/tg/me/profile` | Auth user | Update displayName, username (3-30 chars `[a-zA-Z0-9_]`), bio (max 300), birthday, hideYear, avatarPublic. 409 if username taken |
| POST | `/tg/me/profile/avatar` | Auth user | Upload avatar photo (multipart `avatar` field). Generates full 512px + thumb 256px. Deletes previous |
| DELETE | `/tg/me/profile/avatar` | Auth user | Remove avatar. Deletes local files |

### Settings

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/me/settings` | Auth user | All settings. Includes `languageMode`, `manualLanguage`, `effectiveLanguage`, `supportId`. FREE users: all notifications normalized to ON |
| PATCH | `/tg/me/settings` | Auth user | Update settings. `languageMode` (auto/manual), `manualLanguage` (ru/en/zh-CN/hi/es/ar). PRO-gated: all notification preferences, `commentsEnabled`, `newWishlistPosition=top`, `cardDisplayMode` non-auto |
| DELETE | `/tg/me/account` | Auth user | Permanently delete account. Blocks if user owns active Santa campaigns |

### Plan & Billing

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/me/plan` | Auth user | Current plan, subscription, usage, add-ons, credits, SKU catalog. Includes `proSource`, `promoPro`, `reservationPro` (boolean — Reservation PRO access flag) |
| POST | `/tg/billing/pro/checkout` | Auth user | Create Telegram Stars invoice link (100 XTR/month). Returns `{ alreadySubscribed }` if active PRO. Creates `invoice_created` payment event |
| POST | `/tg/billing/pro/sync` | Auth user | Re-query subscription state after payment. Does NOT activate (bot does). Returns `{ plan, subscription }` |
| GET | `/tg/billing/history` | Auth user | Last 20 payment events |
| POST | `/tg/billing/subscription/cancel` | Auth user (PRO) | Soft-cancel: `cancelAtPeriodEnd=true`. PRO continues until period end. 404 if no active subscription |
| POST | `/tg/billing/subscription/reactivate` | Auth user (cancelled PRO) | Re-enable auto-renewal. 404 if no cancelled subscription in period |

### Add-ons & Credits

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| POST | `/tg/billing/addon/checkout` | Auth user | Create Stars invoice for a one-time SKU. Body: `{ skuCode, targetId? }`. Validates caps. Response: `{ invoiceUrl, sessionId }` |
| POST | `/tg/billing/addon/sync` | Auth user | Return current add-ons and credits after purchase |

**10 Add-on SKUs:**

| SKU Code | Price (XTR) | Type | Target | Description |
|----------|-------------|------|--------|-------------|
| `extra_wishlist_slot` | 39 | permanent | no | +1 wishlist slot (cap: FREE 3, PRO 5) |
| `extra_subscription_slot` | 25 | permanent | no | +1 subscription slot (cap: 3) |
| `extra_items_5` | 19 | permanent | wishlist | +5 items for specific wishlist (cap: 3 per wl) |
| `extra_items_15` | 39 | permanent | wishlist | +15 items for specific wishlist (cap: 1 per wl) |
| `hints_pack_5` | 29 | consumable | no | 5 hint credits |
| `hints_pack_10` | 49 | consumable | no | 10 hint credits |
| `import_pack_10` | 39 | consumable | no | 10 import credits |
| `import_pack_25` | 79 | consumable | no | 25 import credits |
| `seasonal_decoration` | 29 | cosmetic | wishlist | Seasonal wishlist decoration |
| `gift_notes_unlock` | 19 | permanent | no | Unlock Gift Notes feature |

### Gift Notes (19 XTR one-time unlock)

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| POST | `/tg/billing/gift-notes/checkout` | Auth user | Create invoice for Gift Notes unlock. Returns `{ alreadyUnlocked }` if already owned |
| POST | `/tg/billing/gift-notes/sync` | Auth user | Return Gift Notes status after purchase |

**Occasions CRUD:**

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/gift-occasions` | Owner (GN) | List occasions sorted by upcoming date. Includes `ideasCount`, `nextDate`, `daysUntil` |
| POST | `/tg/gift-occasions` | Owner (GN) | Create occasion. Body: `{ title, type?, personName?, eventDate?, recurrence?, note? }`. Types: BIRTHDAY, ANNIVERSARY, HOLIDAY, OTHER |
| GET | `/tg/gift-occasions/:id` | Owner (GN) | Get occasion with ideas |
| PATCH | `/tg/gift-occasions/:id` | Owner (GN) | Update occasion fields |
| DELETE | `/tg/gift-occasions/:id` | Owner (GN) | Hard-delete occasion (cascades to ideas) |
| POST | `/tg/gift-occasions/:id/archive` | Owner (GN) | Archive occasion |
| POST | `/tg/gift-occasions/:id/complete` | Owner (GN) | Mark occasion as DONE |

**Ideas CRUD:**

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| POST | `/tg/gift-occasions/:id/ideas` | Owner (GN) | Add idea. Body: `{ text, link?, price?, currency?, note? }` |
| PATCH | `/tg/gift-occasion-ideas/:ideaId` | Owner (GN) | Update idea |
| DELETE | `/tg/gift-occasion-ideas/:ideaId` | Owner (GN) | Soft-delete idea (status=ARCHIVED) |
| POST | `/tg/gift-occasion-ideas/:ideaId/complete` | Owner (GN) | Mark idea as DONE |

### Promo Codes

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| POST | `/tg/promo/apply` | Auth user | Apply promo code. Body: `{ code, source? }`. Normalizes input (trim, uppercase). Rate-limited: 5/min. Activates 30-day promo PRO for FREE users. Paid PRO users get `accepted_for_paid` status. Checks campaign eligibility, max redemptions, and per-user dedup |

### Onboarding

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/onboarding/status` | Auth user | Check onboarding eligibility, current state, market segment |
| POST | `/tg/onboarding/start` | Auth user | Begin onboarding: A/B variant assignment (v1_demo or v2_try), create demo item or initialize state. Body: `{ onboardingKey, entryPoint }` |
| POST | `/tg/onboarding/dismiss` | Auth user | Dismiss onboarding. Deletes untouched demo item if present |
| POST | `/tg/onboarding/complete` | Auth user | Mark onboarding complete. Body: `{ onboardingKey, reason }`. Reasons: demo_converted, real_item_created, demo_deleted_then_real_created, demo_moved_to_user_wishlist, try_import_completed, catalog_selected, manual_created |
| POST | `/tg/onboarding/try-import` | Auth user | v2: Import URL without PRO gate. Rate-limited: 3/min. Max 30 attempts, 20 successes. Body: `{ url, onboardingStateId }` |
| POST | `/tg/onboarding/catalog-select` | Auth user | v2: Create items from catalog templates. Body: `{ catalogKeys, onboardingStateId }`. Max 6 catalog items |
| POST | `/tg/onboarding/update-step` | Auth user | Persist lastStep + optional acquisitionPath for resume |
| POST | `/tg/onboarding/create-wishlist` | Auth user | v2: Create first wishlist and auto-attach onboarding items. Body: `{ title, onboardingStateId }`. Moves items from SYSTEM_DRAFTS |

### Analytics / God Mode

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| POST | `/tg/me/god-mode` | Whitelisted TG IDs | Toggle godMode boolean. Controlled by `GOD_MODE_TELEGRAM_IDS` env var |
| GET | `/tg/me/god-stats` | God mode user | Full analytics dashboard: overview (users, DAU/WAU/MAU, wishlists, items, reservations, PRO), funnel (activation, share, reservation), engagement (comments, hints, subs), PRO limits 24h, errors 24h, onboarding A/B metrics, locale segments. Query: `?localeScope=active30d|new7d|all` |
| GET | `/tg/me/retention-stats` | God mode user | Lifecycle/winback analytics: touches sent/delivered, return rates (24h/72h/7d), promo assignment/delivery/redemption, by-segment breakdown (S1-S4), by-touch-number. Query: `?period=30` |
| GET | `/tg/me/retention-recent` | God mode user | Last 30 lifecycle touches + last 10 promo redemptions for debugging |

### Support / Telegram Bridge

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/support/lookup/:ticketCode` | God mode user | Lookup support ticket with messages, user info, and recent context. For Mini App investigation UI |

### Secret Santa

**Season & Admin:**

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/santa/season` | Auth user | Season status + canCreate flag. Season window: Nov 15 to Feb 15 |
| POST | `/tg/santa/season/test-mode` | God mode | Toggle santa test mode (bypass season window) |
| GET | `/tg/santa/admin/global-config` | God mode | Read global Santa master switch |
| PATCH | `/tg/santa/admin/global-config` | God mode | Toggle global Santa enable/disable |
| GET | `/tg/santa/admin/season-broadcasts` | God mode | View sent seasonal broadcast history |
| POST | `/tg/santa/admin/season-broadcasts` | God mode | Manually trigger seasonal broadcast. Body: `{ type, seasonYear, force? }` |

**Campaigns:**

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| POST | `/tg/santa/campaigns` | Auth user | Create campaign. Body: `{ title, description?, type?, minBudget?, maxBudget?, currency?, drawAt? }`. MULTI_WAVE requires PRO |
| GET | `/tg/santa/campaigns` | Auth user | List user's campaigns (owned + participating) |
| GET | `/tg/santa/campaigns/:id` | Participant | Get campaign details |
| PATCH | `/tg/santa/campaigns/:id` | Organizer | Update campaign settings |
| POST | `/tg/santa/campaigns/:id/open` | Organizer | Open campaign for joining |
| POST | `/tg/santa/campaigns/:id/lock` | Organizer | Lock campaign (no more joins) |
| POST | `/tg/santa/campaigns/:id/cancel` | Organizer | Cancel campaign |
| POST | `/tg/santa/campaigns/:id/complete` | Organizer | Mark campaign as completed |

**Draw:**

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/santa/campaigns/:id/draw/validate` | Organizer | Pre-validate draw (check for impossible exclusion combinations) |
| POST | `/tg/santa/campaigns/:id/draw` | Organizer | Execute draw with exclusion constraints |

**Participants:**

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/santa/invite/:token` | Auth user | Resolve invite token to campaign info |
| POST | `/tg/santa/campaigns/:id/join` | Auth user | Join campaign via invite |
| POST | `/tg/santa/campaigns/:id/leave` | Participant | Leave campaign |
| DELETE | `/tg/santa/campaigns/:id/participants/:userId` | Organizer | Remove participant |
| PATCH | `/tg/santa/campaigns/:id/participants/:userId/role` | Organizer | Change participant role |
| PATCH | `/tg/santa/campaigns/:id/wishlist` | Participant | Link/update wishlist for Santa campaign |
| GET | `/tg/santa/my-reservations` | Auth user | Santa items reserved by the current user (giver view) |

**Exclusions:**

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/santa/campaigns/:id/exclusions` | Organizer | List all exclusions and exclusion groups |
| POST | `/tg/santa/campaigns/:id/exclusions` | Organizer | Add pair exclusion |
| DELETE | `/tg/santa/campaigns/:id/exclusions/:exclusionId` | Organizer | Remove pair exclusion |
| POST | `/tg/santa/campaigns/:id/exclusions/groups` | Organizer | Create exclusion group |
| PATCH | `/tg/santa/campaigns/:id/exclusions/groups/:gid` | Organizer | Update exclusion group name |
| DELETE | `/tg/santa/campaigns/:id/exclusions/groups/:gid` | Organizer | Delete exclusion group |
| POST | `/tg/santa/campaigns/:id/exclusions/groups/:gid/members` | Organizer | Add member to group |
| DELETE | `/tg/santa/campaigns/:id/exclusions/groups/:gid/members/:uid` | Organizer | Remove member from group |

**Rounds & Gifts:**

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| POST | `/tg/santa/campaigns/:id/rounds` | Organizer | Create new round (for MULTI_WAVE campaigns) |
| PATCH | `/tg/santa/campaigns/:id/gift-status` | Participant | Update gift status (SELECTING, BOUGHT, SHIPPED, SELECTED_OUTSIDE) |
| POST | `/tg/santa/campaigns/:id/confirm-received` | Recipient | Confirm gift was received |

**Assignment & Reveal:**

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/santa/campaigns/:id/assignment` | Participant | Get giver's assignment (who they give to) |
| GET | `/tg/santa/campaigns/:id/reveal` | Participant | Get reveal info (who gave to you) |

**Inbound (recipient wishlist for giver):**

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/santa/campaigns/:id/inbound/wishlist` | Giver | View recipient's linked wishlist items |
| POST | `/tg/santa/campaigns/:id/inbound/reserve` | Giver | Reserve an item from recipient's wishlist |
| DELETE | `/tg/santa/campaigns/:id/inbound/reserve/:itemId` | Giver | Unreserve item |
| GET | `/tg/santa/campaigns/:id/inbound/status` | Giver | Check reservation status for all items |

**Hints (Santa):**

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| POST | `/tg/santa/campaigns/:id/hints` | Participant | Send anonymous hint to giver |
| GET | `/tg/santa/campaigns/:id/hints` | Participant | View sent hints |
| GET | `/tg/santa/campaigns/:id/inbound/hint` | Giver | View received hints from recipient |
| POST | `/tg/santa/campaigns/:id/inbound/hint/fulfill` | Giver | Mark hint as fulfilled |

**Chat:**

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/santa/campaigns/:id/chat` | Participant | Get chat messages (anonymous via aliases) |
| POST | `/tg/santa/campaigns/:id/chat` | Participant | Send chat message |
| POST | `/tg/santa/campaigns/:id/chat/read` | Participant | Mark chat as read |
| POST | `/tg/santa/campaigns/:id/mute` | Participant | Mute chat notifications |
| DELETE | `/tg/santa/campaigns/:id/mute` | Participant | Unmute chat notifications |

**Polls:**

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/santa/campaigns/:id/polls` | Participant | List polls |
| POST | `/tg/santa/campaigns/:id/polls` | Organizer | Create poll |
| POST | `/tg/santa/campaigns/:id/polls/:pollId/vote` | Participant | Vote on poll |
| POST | `/tg/santa/campaigns/:id/polls/:pollId/close` | Organizer | Close poll |

**Organizer Tools:**

| Method | Path | Who | Description |
|--------|------|-----|-------------|
| GET | `/tg/santa/campaigns/:id/organizer/summary` | Organizer | Get campaign summary with participant statuses |
| POST | `/tg/santa/campaigns/:id/exit-request` | Participant | Request to leave after draw |
| GET | `/tg/santa/campaigns/:id/exit-requests` | Organizer | List pending exit requests |
| POST | `/tg/santa/campaigns/:id/exit-requests/:requestId/approve` | Organizer | Approve exit request (re-assigns) |
| POST | `/tg/santa/campaigns/:id/exit-requests/:requestId/deny` | Organizer | Deny exit request |

---

## Internal Routes (`/internal/*`)

Requires `X-INTERNAL-KEY` header equal to `BOT_TOKEN`. Used by the bot process for server-to-server calls.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/internal/import-url` | Parse URL and create item in SYSTEM_DRAFTS for a given `userId`. Body: `{ userId, url, note?, source? }`. **402** if not PRO or Drafts >= 50. Rate-limited: 30 req/min |
| GET | `/internal/support/tickets/:ticketCode` | Lookup support ticket with full message history, user info, and recent context for incident investigation |

Note: Subscription activation is handled directly by the bot process writing to the database (not via an internal HTTP endpoint).

---

## Admin Routes (private router, no path prefix)

Requires `X-ADMIN-KEY` header. Used by the Next.js admin panel pages. Routes operate on behalf of the system user.

| Method | Path | Description |
|--------|------|-------------|
| POST | `/wishlists` | Create wishlist for system user |
| PATCH | `/wishlists/:id` | Update system wishlist |
| DELETE | `/wishlists/:id` | Hard-delete system wishlist |
| POST | `/wishlists/:id/items` | Add item to system wishlist |
| PATCH | `/items/:id` | Update system item |
| DELETE | `/items/:id` | Hard-delete system item |
| POST | `/wishlists/:id/tags` | Create tag |
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
| Promo expiry | Sets `status=EXPIRED` on promo redemptions past `expiresAt`. Initiates 14-day grace period degradation for users who lose PRO |
| Degradation archive | After grace period: archives over-limit wishlists/items for degraded users. Restores if user regains PRO |
| Degradation purge | After 90 days: permanently deletes archived data from degraded users. Restores if user regains PRO |
| Lifecycle / Win-back | Classifies inactive users into segments S1-S4, sends Telegram DMs, offers WISHPRO promo code. Respects 72h cooldown and 5-per-45d cap |
| Santa seasonal broadcasts | On Nov 1: sends PROMO broadcast. On Feb 1: sends CLOSING_SOON broadcast. Deduped per year |
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
  price: number | null;
  currency: 'RUB' | 'USD' | 'EUR' | 'GBP' | null;
  imageUrl: string | null;
  priority: 1 | 2 | 3;          // 1=LOW, 2=MEDIUM, 3=HIGH
  position: number;
  status: 'available' | 'reserved' | 'purchased' | 'completed' | 'deleted' | 'archived';
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
  wishlists: number;       // effective limit (base + add-ons)
  items: 20 | 70;
  participants: 5 | 20;
  subscriptions: number;   // effective limit (base + add-ons)
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
