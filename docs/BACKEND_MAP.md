# Backend Map

**Date:** 2026-03-26
**Project:** Wishlist Telegram Mini App — `apps/api`

---

## 1. File Structure

```
apps/api/
├── src/
│   ├── index.ts                    # Express server, all routes, helpers, background jobs (~9 000+ lines)
│   ├── url-parser.ts               # URL product card extraction pipeline
│   ├── browser-network-extractor.ts # Puppeteer XHR/fetch interception for SPAs
│   ├── sort.ts                     # Item sort order logic (unit-testable, no side effects)
│   ├── sort.test.ts                # Unit tests for sort.ts
│   └── seed.ts                     # DB seed script
├── .env.example
└── package.json

packages/db/
├── prisma/
│   └── schema.prisma               # Canonical data model
└── src/index.ts                    # Prisma client export (@wishlist/db)

packages/shared/
└── src/
    ├── i18n/                       # Translation strings: ru, en
    └── index.ts                    # t(), detectLocale(), pluralize(), types
```

---

## 2. Route Groups

### Health

| Method | Path | Auth | Description |
|---|---|---|---|
| GET | `/health` | None | Returns `{ ok: true }`. |
| GET | `/health/deep` | None | Checks DB connectivity and bot heartbeat (stale if >120 s). Returns 503 if unhealthy. |

### Static files

| Path | Description |
|---|---|
| `/uploads/*` | Serves uploaded images from `UPLOAD_DIR`. 30-day immutable cache. |

### Public routes (`/public/*`)

Mounted as `publicRouter`. No authentication. Rate-limited.

| Method | Path | Rate limit | Description |
|---|---|---|---|
| GET | `/public/wishlists/:slug` | 120/min | Fetch wishlist metadata + items by slug. Returns 403 for PRIVATE wishlists if caller is not a subscriber. |
| GET | `/public/wishlists/:slug/items` | 120/min | Fetch items for wishlist by slug. Supports `?status` and `?tag` filters. |
| GET | `/public/share/:token` | 120/min | Resolve a 12-character share token to wishlist + items. |
| GET | `/public/profiles/:username` | 120/min | Fetch public profile + public wishlists (visibility `PUBLIC_PROFILE`). Respects `profileVisibility` setting. |
| POST | `/public/items/:id/reserve` | 30/15 min | Reserve an item. Requires `actorHash` (UUID) and optional `comment` (display name). Uses a database transaction to prevent double-reservation. |
| POST | `/public/items/:id/unreserve` | 30/15 min | Unreserve an item. Validates `actorHash` against the reservation event using timing-safe comparison. |
| POST | `/public/items/:id/purchase` | 30/15 min | Mark an item as purchased. Requires `actorHash`. |

### Telegram routes (`/tg/*`)

Mounted as `tgRouter`. All routes require `requireTelegramAuth` middleware.

**Wishlists**

| Method | Path | Description |
|---|---|---|
| GET | `/tg/wishlists` | List owner's active wishlists with item counts, plan info, drafts summary, and reservation count. |
| POST | `/tg/wishlists` | Create wishlist. Enforces `plan.wishlists` limit. Inherits `commentPolicy` from profile default. Respects `newWishlistPosition` setting (top/bottom). |
| PATCH | `/tg/wishlists/:id` | Update title, deadline, visibility, allowSubscriptions, commentPolicy. PRO required for `PUBLIC_PROFILE`/`PRIVATE` visibility and subscription/comment restrictions. Notifies subscribers on title/deadline change. |
| DELETE | `/tg/wishlists/:id` | Hard-delete wishlist. Repacks sibling positions to keep them contiguous. |
| POST | `/tg/wishlists/:id/archive` | Soft-archive wishlist (sets `archivedAt`). |
| POST | `/tg/wishlists/:id/unarchive` | Restore archived wishlist. |
| GET | `/tg/wishlists/archive` | List archived wishlists. |
| POST | `/tg/wishlists/reorder` | Update wishlist positions in bulk (transactional). |
| POST | `/tg/wishlists/:id/share-token` | Generate or regenerate 12-character share token. |
| POST | `/tg/wishlists/:id/transfer-items` | Move RESERVED items from one wishlist to another before deletion. Checks target capacity. |
| GET | `/tg/wishlists/:id/items` | List items in a wishlist. |
| GET | `/tg/wishlists/:id/subscribers` | List subscribers of a wishlist. |

**Items**

| Method | Path | Description |
|---|---|---|
| POST | `/tg/wishlists/:id/items` | Create item. Enforces `isWishlistWritable` and `plan.items` limits. Notifies subscribers. |
| PATCH | `/tg/items/:id` | Edit item fields. Notifies subscribers on relevant field changes. If description changes while item is RESERVED, creates a SYSTEM comment and notifies the reserver. |
| DELETE | `/tg/items/:id` | Soft-delete item (status → DELETED, purgeAfter = +90 days). Cancels active hints. Notifies reserver if present. |
| POST | `/tg/items/:id/complete` | Mark item as COMPLETED (received by owner). Creates SYSTEM comment. |
| POST | `/tg/items/:id/restore` | Restore a DELETED item back to AVAILABLE. |
| POST | `/tg/items/:id/move` | Move item to a different wishlist. Checks target writability and item limit. |
| POST | `/tg/items/:id/reorder` | Update item positions within a wishlist. |
| POST | `/tg/items/:id/photo` | Upload item photo. Processes with Sharp (full 1600 px + thumb 480 px). Deletes previous photo file. |
| DELETE | `/tg/items/:id/photo` | Remove item photo and delete file. |

**Reservations**

| Method | Path | Description |
|---|---|---|
| GET | `/tg/reservations` | List items currently reserved by the authenticated user. Includes wishlist context. |

**Comments**

| Method | Path | Description |
|---|---|---|
| GET | `/tg/items/:id/comments` | Fetch comments. Role-aware: reserver sees previous-epoch comments anonymized. |
| POST | `/tg/items/:id/comments` | Create comment. PRO feature gate (owner or commenter must have PRO). Enforces `commentPolicy`. Applies 5 anti-spam rules. Notifies the other party via Telegram push. |
| DELETE | `/tg/items/:id/comments/:commentId` | Delete own comment (or any comment if owner). |

**Hints**

| Method | Path | Description |
|---|---|---|
| POST | `/tg/items/:id/hints` | Create a hint for an item (owner sends to friends). PRO feature. Stores `Hint` record; bot delivers via `users_shared` event. |
| GET | `/tg/items/:id/hints` | Poll hint delivery status. |

**Subscriptions**

| Method | Path | Description |
|---|---|---|
| POST | `/tg/wishlists/:id/subscribe` | Subscribe to a wishlist. Enforces `plan.subscriptions` limit. Checks `allowSubscriptions` policy. |
| DELETE | `/tg/wishlists/:id/unsubscribe` | Unsubscribe. |
| GET | `/tg/subscriptions` | List wishlists the user is subscribed to, with unread counts. |
| POST | `/tg/subscriptions/mark-read` | Clear unread markers for a wishlist subscription. |

**Profile & Settings**

| Method | Path | Description |
|---|---|---|
| GET | `/tg/me/profile` | Fetch profile (displayName, username, bio, avatarUrl, birthday, hideYear, defaultCurrency) plus stats and plan. |
| PATCH | `/tg/me/profile` | Update profile fields. Validates username uniqueness. |
| POST | `/tg/me/profile/avatar` | Upload profile avatar (512 px, quality 80). Deletes previous avatar file. |
| DELETE | `/tg/me/profile/avatar` | Remove profile avatar and delete file. |
| GET | `/tg/me/settings` | Fetch settings: language, defaultCurrency, notifications, privacy, appBehavior. |
| PATCH | `/tg/me/settings` | Update settings. Some fields (comment/subscription notifications, commentsEnabled, newWishlistPosition=bottom) are PRO-gated. |
| DELETE | `/tg/me/account` | Delete user and all related data (cascades via Prisma). |
| POST | `/tg/me/god-mode` | Toggle god mode. Only whitelisted Telegram IDs (`GOD_MODE_TELEGRAM_IDS`) may call this. |

**Billing**

| Method | Path | Description |
|---|---|---|
| GET | `/tg/me/plan` | Current plan, subscription state, usage counts, PRO price in Stars. |
| POST | `/tg/billing/pro/checkout` | Create Telegram Stars invoice link via `createInvoiceLink` Bot API. Stores `PaymentEvent` (type `invoice_created`). |
| POST | `/tg/billing/pro/sync` | Poll subscription state after payment. Does not activate; activation happens in the bot. |
| GET | `/tg/billing/history` | Last 20 payment events. |
| POST | `/tg/billing/subscription/cancel` | Set `cancelAtPeriodEnd = true` on active subscription. PRO access continues until period end. |
| POST | `/tg/billing/subscription/reactivate` | Clear `cancelAtPeriodEnd` on a subscription that is still within its period. |

**URL Import**

| Method | Path | Rate limit | Description |
|---|---|---|---|
| POST | `/tg/import-url` | 10/min per user | PRO feature. Parse a product URL and create an item in the user's Drafts (SYSTEM_DRAFTS) wishlist. Returns `parseStatus`: `ok`, `partial`, or `failed`. |

**Support**

| Method | Path | Description |
|---|---|---|
| POST | `/tg/support/session` | Create a support session (ForceReply prompt record). |

### Internal routes (`/internal/*`)

Mounted as `internalRouter`. All routes require `requireInternalAuth` middleware (`X-INTERNAL-KEY` == `BOT_TOKEN`).

| Method | Path | Rate limit | Description |
|---|---|---|---|
| POST | `/internal/import-url` | 30/min | Import a product URL on behalf of a user (by `userId`). Same pipeline as `/tg/import-url`. Called by bot when a user sends a URL in chat. |

### Admin routes (`/*` via `privateRouter`)

Mounted without prefix. Requires `X-ADMIN-KEY` header (`requireAdmin` middleware). These are legacy endpoints for system user management.

| Method | Path | Description |
|---|---|---|
| POST | `/wishlists` | Create wishlist for system user. |
| PATCH | `/wishlists/:id` | Update system wishlist. |
| DELETE | `/wishlists/:id` | Hard-delete system wishlist. |
| POST | `/wishlists/:id/items` | Add item to system wishlist. |
| PATCH | `/items/:id` | Update system item. |
| DELETE | `/items/:id` | Hard-delete system item. |
| POST | `/wishlists/:id/tags` | Create tag on system wishlist. |
| PATCH | `/tags/:id` | Rename tag. |
| DELETE | `/tags/:id` | Delete tag. |
| POST | `/items/:itemId/tags/:tagId` | Associate item with tag. |
| DELETE | `/items/:itemId/tags/:tagId` | Remove tag from item. |

---

## 3. Middleware Chain

```
Request
  │
  ├─ cors()                    # Allow WEB_ORIGIN and non-browser requests
  ├─ express.json()            # Parse JSON body
  │
  ├─ [/tg, /public] maintenance check  # Returns 503 {code: MAINTENANCE} if MAINTENANCE_MODE=true
  │
  ├─ /uploads/*                # express.static(UPLOAD_DIR)
  ├─ /health                   # Immediate response, no auth
  ├─ /health/deep              # Immediate response, no auth
  │
  ├─ /public/*
  │    ├─ publicReadLimiter    # 120 req/min (reads)
  │    └─ publicActionLimiter  # 30 req/15 min (reserve/unreserve/purchase)
  │
  ├─ /tg/*
  │    ├─ requireTelegramAuth  # Validates X-TG-INIT-DATA HMAC; sets req.tgUser
  │    └─ importUrlLimiter     # 10 req/min per tgUser (import-url only)
  │
  ├─ /internal/*
  │    ├─ requireInternalAuth  # Validates X-INTERNAL-KEY == BOT_TOKEN
  │    └─ internalImportLimiter # 30 req/min
  │
  ├─ /* (privateRouter)
  │    └─ requireAdmin         # Validates X-ADMIN-KEY
  │
  └─ Error handler (4-arg middleware)
       ├─ Multer LIMIT_FILE_SIZE  → 413
       ├─ Multer LIMIT_UNEXPECTED_FILE → 400
       ├─ Unsupported file type   → 415
       └─ All other errors        → 500 { error: 'Internal server error' }
```

---

## 4. Key Helper Functions

### `asyncHandler(fn)`
Wraps an async route handler. Catches any rejected promise and passes the error to `next()`, so Express's error handler processes it.

```typescript
function asyncHandler(fn): (req, res, next) => void
```

### `getOrCreateTgUser(tgUser)`
Upserts a `User` row using `telegramId` as the unique key. On create, stores `telegramId` and `telegramChatId`. On update, refreshes `telegramChatId` and `firstName`. Returns the full user record including `godMode` flag.

### `getOrCreateProfile(userId, locale?)`
Upserts a `UserProfile` row. On create, sets `defaultCurrency` based on locale (`RUB` for `ru`, `USD` otherwise).

### `getUserEntitlement(userId, godMode?)`
Queries the `Subscription` table for an active or cancelled (within period) PRO subscription. Returns `{ plan, isPro, subscription }`. If `godMode` is true and no real subscription exists, returns virtual PRO. Otherwise returns FREE plan.

### `isWishlistWritable(userId, wishlistId, planLimit)`
Fetches all non-archived REGULAR wishlists for the user ordered by `createdAt`. Returns true if `wishlistId` is among the first `planLimit` entries. Wishlists beyond the limit are read-only.

### `getItemRole(itemId, tgUser)`
Determines the calling user's relationship to an item: `owner`, `reserver`, or `third_party`. Computes the user's `actorHash` (deterministic SHA-256 of `tg_actor:<telegramId>`, formatted as UUID) and compares it against the latest reservation event.

### `processImage(buffer, { maxDim, quality, suffix })`
Processes an uploaded image buffer with Sharp: auto-rotate, strip EXIF, resize to fit, convert to JPEG. Writes to `UPLOAD_DIR`. Returns `{ filename, filepath, sizeBytes, width, height }`.

### `deleteUploadFile(imageUrl)`
Deletes a local upload file by extracting the filename from the URL. Ignores external URLs. Also attempts to delete the `-thumb.jpg` variant.

### `sendTgNotification(chatId, text)`
Fire-and-forget Telegram `sendMessage` call. Never throws.

### `notifySubscribersOfChange(wishlistId, entityId, changedFields, eventType, meta)`
For each subscriber of a wishlist: upserts `SubscriptionUnread` markers for each changed field, then sends a Telegram push notification. Fire-and-forget.

### `queueCommentNotification(key, chatId, itemTitle, text)`
Sends the first comment notification immediately. Subsequent calls within 30 seconds increment a counter; when the debounce timer fires, a single batched notification is sent with the count.

### `secureCompare(a, b)`
Timing-safe string comparison via SHA-256 digests. Used for `actorHash` verification and key comparisons.

### `generateUniqueSlug(title)` / `generateUniqueShareToken()`
Generate URL-safe slugs and share tokens with collision retry loops (up to 10 attempts, then falls back to UUID).

### `validateTelegramInitData(initData, botToken)`
Validates the HMAC signature of Telegram WebApp init data. Returns the parsed `TelegramUser` or `null`.

### `tgActorHash(telegramId)`
Produces a deterministic UUID-formatted actor hash for a Telegram user ID: `SHA-256("tg_actor:<id>")` formatted as `8-4-4-4-12`.

### `resolveUserFirstName(user, locale)`
Fetches `first_name` from Telegram Bot API (`getChat`) if not cached in DB. Caches the result on success.

### `cancelItemHints(itemId)`
Sets all SENT/DELIVERED hints for an item to CANCELLED. Called when an item leaves the AVAILABLE state.

### `getSystemUser()`
Upserts a system user by `SYSTEM_USER_EMAIL`. Used by the legacy admin router for system-owned wishlists.

---

## 5. PLANS Constant and Entitlement Resolution

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
}
```

**Entitlement resolution order:**
1. Query `Subscription` where `userId = <id>`, `planCode = PRO_PLAN_CODE`, `status IN (ACTIVE, CANCELLED)`, `currentPeriodEnd > now`. Order by `currentPeriodEnd DESC`, take first.
2. If found → return `PLANS.PRO`, `isPro: true`, subscription details.
3. If `godMode` flag is set on the user → return `PLANS.PRO`, `isPro: true`, `subscription: null` (virtual).
4. Otherwise → return `PLANS.FREE`, `isPro: false`, `subscription: null`.

`PRO_PLAN_CODE`, `PRO_PRICE_XTR`, and `PRO_SUBSCRIPTION_PERIOD` are read from environment variables with defaults (`PRO`, `100`, `2592000`).

---

## 6. URL Import Pipeline

Entry points: `POST /tg/import-url` (Mini App) and `POST /internal/import-url` (bot). Both call `importUrlForUser(userId, rawUrl, note?, source?)`.

**Steps:**

1. **Validate URL** — `validateUrl(rawUrl)` checks length (max 2 048 chars), scheme (must be http/https), hostname (blocks localhost, 127.0.0.1, etc.), and strips tracking parameters.

2. **Feature gate** — `getUserEntitlement(userId)` must include `url_import` in features (PRO only). Returns 402 if not.

3. **Get or create Drafts wishlist** — `getOrCreateDraftsWishlist(userId)` finds or creates a `SYSTEM_DRAFTS` wishlist. Checks that active item count is below `DRAFTS_ITEM_LIMIT` (50). Throws a 402 error if at limit.

4. **Parse URL** — `parseUrl(rawUrl)` runs the extraction pipeline (see below). On exception, `parseStatus` is set to `'failed'` and a minimal record is created with the domain name as title.

5. **Set parseStatus** — `'ok'` if title and priceText present, `'partial'` if one is missing, `'failed'` if neither is present.

6. **Build description** — combines user note (if any) and parsed description, truncated to 500 chars.

7. **Create item** — inserts into the Drafts wishlist with `sourceUrl`, `sourceDomain`, `importMethod` recorded.

8. **Return** — `{ item, wishlistId, parseStatus }`.

**`parseUrl()` extraction pipeline** (from `url-parser.ts`):

The parser uses a 5-level source priority system:

| Priority | Source | Description |
|---|---|---|
| 1 | `network_response` | XHR/fetch JSON intercepted during Puppeteer page render |
| 2 | `next_data` | `__NEXT_DATA__` hydration object (Next.js sites) |
| 3 | `hydration_state` | `window.__INITIAL_STATE__` / Redux / Vuex stores |
| 4 | `jsonld` | JSON-LD `Product` structured data |
| 5 | `og_meta` / `dom` | Open Graph meta tags + domain-specific DOM selectors |

**Overall flow per request:**
```
validateUrl + strip tracking params
  → canonicalize URL
  → check in-memory positive cache (24 h TTL, max 1 000 entries)
  → check negative cache (5 min TTL)
  → Wildberries shortcut: card.wb.ru JSON API (if article number extractable)
  → BROWSER_FIRST domains (ozon.ru, market.yandex.ru): browserExtract()
  → HTTP-first domains: fetchHtml() + Cheerio
      → if confidence < medium: browserExtract() fallback
  → anti-bot / garbage result guard
  → merge fields by priority
  → store in positive cache (on success) or negative cache (on failure)
  → return ParsedUrlData
```

The Puppeteer browser instance is shared as a singleton (`browserInstance`), lazily created on first use, and closed after 90 seconds of idle time (`BROWSER_IDLE_MS`). The Chromium executable path is configurable via `CHROMIUM_PATH` (env) or defaults to `/usr/bin/chromium`.

---

## 7. Image Processing Pipeline

```
Multipart request
  │
  ├─ Multer (memory storage)
  │    - fileFilter: JPEG, PNG, WebP, GIF only (else 415)
  │    - limits.fileSize: 30 MB (else 413)
  │
  └─ processImage(buffer, { maxDim, quality, suffix })
       │
       ├─ sharp(buffer)
       │    .rotate()              // auto-rotate from EXIF
       │    .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
       │    .jpeg({ quality, mozjpeg: true })
       │    .toFile(filepath)
       │
       └─ returns { filename, filepath, sizeBytes, width, height }

Item photo: generates two variants in parallel
  - full: maxDim=1600, quality=80, suffix='full'
  - thumb: maxDim=480, quality=70, suffix='thumb'

Profile avatar: single variant
  - maxDim=512, quality=80, suffix='avatar'

Filename format: <uuid>-<suffix>.jpg
Stored URL: /api/uploads/<filename>
```

---

## 8. Notification Dispatch

| Trigger | Function | Recipient | Mechanism |
|---|---|---|---|
| Item reserved (via `/public/items/:id/reserve`) | `sendTgNotification` | Wishlist owner | Direct Telegram message, fire-and-forget |
| Item purchased (via `/public/items/:id/purchase`) | `sendTgNotification` | Wishlist owner | Direct Telegram message |
| Item completed (via `/tg/items/:id/complete`) | `sendTgNotification` | Item reserver (if `reserverUserId` set) | Direct Telegram message |
| Comment posted by reserver | `queueCommentNotification` | Wishlist owner | Debounced (30 s), first immediate |
| Comment posted by owner | `queueCommentNotification` | Item reserver | Debounced (30 s), first immediate |
| Item description updated while reserved | `sendTgNotification` | Item reserver | Direct Telegram message |
| Item soft-deleted while reserved | `sendTgNotification` | Item reserver | Direct Telegram message |
| Item added to wishlist | `notifySubscribersOfChange` | All wishlist subscribers | Direct Telegram message per subscriber + `SubscriptionUnread` upsert |
| Item updated | `notifySubscribersOfChange` | All wishlist subscribers | Direct Telegram message per subscriber + `SubscriptionUnread` upsert |
| Wishlist title/deadline updated | `notifySubscribersOfChange` | All wishlist subscribers | Direct Telegram message per subscriber + `SubscriptionUnread` upsert |
| Hint delivered | bot: direct `sendMessage` | Hint recipients | Via bot, Telegram direct message with web_app button |

All Telegram sends are performed by calling `https://api.telegram.org/bot<TOKEN>/sendMessage` directly from the API process (not through the bot). Failures are logged but never propagate to the calling request.

---

## 9. Cron Jobs

All jobs use `setInterval(..., 60 * 60 * 1000)` (hourly). Registered at module load time in `index.ts`.

### Comment TTL cleanup

```
prisma.comment.deleteMany({ where: { scheduledDeleteAt: { lte: new Date() } } })
```

Deletes comments that have passed their scheduled deletion time. Logs count if any deleted.

### Archive item purge

```
prisma.item.findMany({ where: { purgeAfter: { lte: new Date() } }, take: 100 })
→ for each: prisma.item.delete() + deleteUploadFile(imageUrl)
```

Processes up to 100 items per run to avoid long transactions. DB is deleted first; file deletion second (orphaned files are harmless, orphaned DB records are not).

### Subscription expiry

```
prisma.subscription.updateMany({
  where: { status: { in: ['ACTIVE', 'CANCELLED'] }, currentPeriodEnd: { lte: new Date() } },
  data: { status: 'EXPIRED' }
})
```

Marks overdue subscriptions as EXPIRED, revoking PRO entitlement.

### Hint expiry

```
prisma.hint.updateMany({
  where: { status: 'SENT', expiresAt: { lte: new Date() } },
  data: { status: 'EXPIRED' }
})
```

Marks undelivered hints that have passed their expiry date.

---

## 10. Error Handling Patterns

### `asyncHandler` wrapper

Every route handler is wrapped with `asyncHandler`:

```typescript
function asyncHandler(fn) {
  return (req, res, next) => {
    void Promise.resolve(fn(req, res, next)).catch(next);
  };
}
```

This ensures unhandled promise rejections are forwarded to Express's error middleware.

### Zod validation

All request bodies and query strings are validated with Zod. On failure, `zodError(res, error)` returns:

```json
{ "error": "Validation error", "issues": [...] }
```
HTTP 400.

### HTTP status codes used

| Code | When |
|---|---|
| 200 | Successful read or update |
| 201 | Successful creation |
| 400 | Validation error, missing parameter, business logic error (e.g., empty comment) |
| 401 | Missing or invalid auth token |
| 402 | Plan limit reached, PRO feature required |
| 403 | Ownership check failed, PRO-gated setting |
| 404 | Entity not found |
| 409 | Conflict (already reserved, already archived, duplicate) |
| 413 | Uploaded file too large (>30 MB) |
| 415 | Unsupported file MIME type |
| 429 | Rate limit exceeded or comment anti-spam |
| 500 | Unhandled server error |
| 502 | Telegram Bot API call failed (billing checkout) |
| 503 | Maintenance mode or health check failure |

### Global error handler

The 4-argument Express error middleware at the bottom of `index.ts`:
- Maps Multer error codes (`LIMIT_FILE_SIZE` → 413, `LIMIT_UNEXPECTED_FILE` → 400).
- Maps `Unsupported file type` message → 415.
- Logs all other errors to stderr and returns `{ error: 'Internal server error' }` with 500.

### Startup / crash alerts

On startup, the API sends a Telegram message to all `ADMIN_ALERT_CHAT_IDS`. `process.on('uncaughtException')` sends an alert and exits; `process.on('unhandledRejection')` sends an alert without exiting.

---

## 11. Internal API (Bot to API)

The internal router (`/internal/*`) is used when the bot needs to trigger API business logic on behalf of a user.

**Authentication:** `X-INTERNAL-KEY` header must equal `BOT_TOKEN`. Validated by `requireInternalAuth` using `secureCompare`.

**Current endpoints:**

### `POST /internal/import-url`

Rate limit: 30/min.

Request body:
```json
{
  "userId": "<db user id>",
  "url": "<product url>",
  "note": "<optional user text>",
  "source": "bot"
}
```

Response (201):
```json
{
  "item": { ... },
  "wishlistId": "<drafts wishlist id>",
  "parseStatus": "ok" | "partial" | "failed"
}
```

This endpoint is called by the bot when a user sends a URL message in the Telegram chat. The bot first upserts the user in the database, then calls this endpoint with the internal key. The endpoint runs the full `importUrlForUser` pipeline: validates URL, checks PRO entitlement, checks Drafts limit, parses the URL, and creates the item.

Error responses:
- `400` — invalid URL (with message from validator)
- `402` — PRO feature not available, or Drafts limit reached
- Other errors propagate as 500.

---

## 12. New Endpoints (added since March 17)

Additional route groups have been added for:
- **Promo system**: `POST /tg/promo/redeem` — redeem a promo code (e.g. WISHPRO), `GET /tg/promo/check` — check promo eligibility
- **Public profiles**: `GET /public/profiles/:username` expanded with profile sharing flow
- **Lifecycle**: Internal endpoints for winback and engagement messaging
- **Onboarding v2**: `POST /tg/onboarding/complete` — mark onboarding as completed, `GET /tg/onboarding/status`
- **Card display modes**: Settings endpoints for configuring card appearance
