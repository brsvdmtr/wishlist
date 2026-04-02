# Backend Map

**Last updated:** 2026-04-02
**Project:** Wishlist Telegram Mini App — `apps/api`

---

## 1. File Structure

```
apps/api/
├── src/
│   ├── index.ts                    # Express server, all routes, helpers, background jobs (~11,964 lines, 157+ route handlers)
│   ├── url-parser.ts               # URL product card extraction pipeline (~1,059 lines)
│   ├── browser-network-extractor.ts # Puppeteer XHR/fetch interception for SPAs
│   ├── sort.ts                     # Item sort order logic (unit-testable, no side effects)
│   ├── sort.test.ts                # Unit tests for sort.ts
│   └── seed.ts                     # DB seed script
├── .env.example
└── package.json

packages/db/
├── prisma/
│   └── schema.prisma               # Canonical data model (51 models, 30 enums)
└── src/index.ts                    # Prisma client export (@wishlist/db)

packages/shared/
└── src/
    ├── i18n/                       # Translation strings: ru, en, zh-CN, hi, es, ar (6 locales)
    └── index.ts                    # t(), detectLocale(), resolveEffectiveLocale(), pluralize(), getOnboardingMeta(), getCatalogForSegment(), types
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
| GET | `/tg/wishlists` | List owner's active wishlists with item counts, plan info, drafts summary, reservation count, and card display mode. |
| POST | `/tg/wishlists` | Create wishlist. Enforces `plan.wishlists` limit (including add-on slots). Inherits `commentPolicy` from profile default. Respects `newWishlistPosition` setting (top/bottom). |
| PATCH | `/tg/wishlists/:id` | Update title, deadline, visibility, allowSubscriptions, commentPolicy. PRO required for `PUBLIC_PROFILE`/`PRIVATE` visibility and subscription/comment restrictions. Notifies subscribers on title/deadline change. |
| DELETE | `/tg/wishlists/:id` | Hard-delete wishlist. Repacks sibling positions to keep them contiguous. |
| POST | `/tg/wishlists/:id/archive` | Soft-archive wishlist (sets `archivedAt`). |
| POST | `/tg/wishlists/:id/unarchive` | Restore archived wishlist. |
| POST | `/tg/wishlists/reorder` | Update wishlist positions in bulk (transactional). |
| POST | `/tg/wishlists/:id/share-token` | Generate or regenerate 12-character share token. |
| POST | `/tg/wishlists/:id/transfer-items` | Move RESERVED items from one wishlist to another before deletion. Checks target capacity. |
| GET | `/tg/wishlists/:id/items` | List items in a wishlist. |
| GET | `/tg/wishlists/:id/subscribers` | List subscribers of a wishlist. |

**Items**

| Method | Path | Description |
|---|---|---|
| POST | `/tg/wishlists/:id/items` | Create item. Enforces `isWishlistWritable` and plan item limits (base + per-wishlist add-ons). Notifies subscribers. |
| PATCH | `/tg/items/:id` | Edit item fields. Notifies subscribers on relevant field changes. If description changes while item is RESERVED, creates a SYSTEM comment and notifies the reserver. |
| DELETE | `/tg/items/:id` | Soft-delete item (status -> DELETED, purgeAfter = +90 days). Cancels active hints. Notifies reserver if present. |
| POST | `/tg/items/:id/complete` | Mark item as COMPLETED (received by owner). Creates SYSTEM comment. |
| POST | `/tg/items/:id/restore` | Restore a DELETED item back to AVAILABLE. |
| POST | `/tg/items/:id/move` | Move item to a different wishlist. Checks target writability and item limit. |
| POST | `/tg/items/:id/copy` | Copy item to a different wishlist. Creates a new item record. |
| POST | `/tg/items/:id/reorder` | Update item positions within a wishlist. |
| POST | `/tg/items/:id/photo` | Upload item photo. Processes with Sharp (full 1600 px + thumb 480 px). Deletes previous photo file. |
| DELETE | `/tg/items/:id/photo` | Remove item photo and delete file. |

**Bulk Item Operations**

| Method | Path | Description |
|---|---|---|
| POST | `/tg/wishlists/:id/items/bulk-move` | Move multiple items to a target wishlist. Validates ownership and target capacity. |
| POST | `/tg/wishlists/:id/items/bulk-delete` | Soft-delete multiple items (status -> DELETED, purgeAfter = +90 days). |
| POST | `/tg/wishlists/:id/items/bulk-restore` | Restore multiple DELETED items back to AVAILABLE. |
| POST | `/tg/wishlists/:id/items/bulk-archive` | Archive multiple items. |
| POST | `/tg/wishlists/:id/items/bulk-copy` | Copy multiple items to a target wishlist. |
| POST | `/tg/wishlists/:id/items/bulk-hard-delete` | Permanently delete multiple items (no recovery). Deletes associated files. |

**Archive View**

| Method | Path | Description |
|---|---|---|
| GET | `/tg/wishlists/:id/archive` | List archived items (DELETED, COMPLETED, ARCHIVED) within a specific wishlist. |

**Guest Actions (Reserve / Unreserve)**

Separate from public routes; these are TG-authenticated endpoints for the Mini App.

| Method | Path | Description |
|---|---|---|
| POST | `/tg/items/:id/reserve` | Reserve item as an authenticated TG user. Uses `tgActorHash`. |
| POST | `/tg/items/:id/unreserve` | Unreserve item. Validates actor hash. |

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
| POST | `/tg/items/:id/comments/mark-read` | Mark comments as read for the current user. |

**Hints**

| Method | Path | Description |
|---|---|---|
| POST | `/tg/items/:id/hints` | Create a hint for an item (owner sends to friends). PRO feature (or hint credits). Stores `Hint` record; bot delivers via `users_shared` event. |
| GET | `/tg/items/:id/hints` | Poll hint delivery status. |

**Subscriptions**

| Method | Path | Description |
|---|---|---|
| POST | `/tg/wishlists/:id/subscribe` | Subscribe to a wishlist. Enforces effective subscription limit (base + add-on slots). Checks `allowSubscriptions` policy. |
| DELETE | `/tg/wishlists/:id/unsubscribe` | Unsubscribe. |
| GET | `/tg/subscriptions` | List wishlists the user is subscribed to, with unread counts. |
| GET | `/tg/me/subscriptions/meta` | Subscription metadata (counts, limits). |
| POST | `/tg/subscriptions/mark-read` | Clear unread markers for a wishlist subscription. |

**Profile & Settings**

| Method | Path | Description |
|---|---|---|
| GET | `/tg/me/profile` | Fetch profile (displayName, username, bio, avatarUrl, birthday, hideYear, defaultCurrency) plus stats and plan. |
| PATCH | `/tg/me/profile` | Update profile fields. Validates username uniqueness. |
| POST | `/tg/me/profile/avatar` | Upload profile avatar (512 px, quality 80). Deletes previous avatar file. |
| DELETE | `/tg/me/profile/avatar` | Remove profile avatar and delete file. |
| GET | `/tg/me/settings` | Fetch settings: language, defaultCurrency, notifications, privacy, appBehavior, cardDisplayMode. |
| PATCH | `/tg/me/settings` | Update settings. Some fields (comment/subscription notifications, commentsEnabled, newWishlistPosition=bottom) are PRO-gated. |
| DELETE | `/tg/me/account` | Delete user and all related data (cascades via Prisma). |
| POST | `/tg/me/god-mode` | Toggle god mode. Only whitelisted Telegram IDs (`GOD_MODE_TELEGRAM_IDS`) may call this. |

**Plan & Billing**

| Method | Path | Description |
|---|---|---|
| GET | `/tg/me/plan` | Current plan, subscription state, usage counts, PRO price in Stars, effective entitlements (including add-ons). |
| POST | `/tg/billing/pro/checkout` | Create Telegram Stars invoice link via `createInvoiceLink` Bot API. Stores `PaymentEvent` (type `invoice_created`). |
| POST | `/tg/billing/pro/sync` | Poll subscription state after payment. Does not activate; activation happens in the bot. |
| GET | `/tg/billing/history` | Last 20 payment events. |
| POST | `/tg/billing/subscription/cancel` | Set `cancelAtPeriodEnd = true` on active subscription. PRO access continues until period end. |
| POST | `/tg/billing/subscription/reactivate` | Clear `cancelAtPeriodEnd` on a subscription that is still within its period. |

**Add-ons & Credits**

| Method | Path | Description |
|---|---|---|
| POST | `/tg/billing/addon/checkout` | Create Telegram Stars invoice for a one-time SKU. Validates SKU code, caps, and targetId requirements. |
| POST | `/tg/billing/addon/sync` | Poll add-on purchase state after payment. Provisions `UserAddOn` or `UserCredits` based on SKU type. |

**Gift Notes (Occasions & Ideas)**

| Method | Path | Description |
|---|---|---|
| POST | `/tg/billing/gift-notes/checkout` | Create Telegram Stars invoice for Gift Notes unlock (19 XTR). |
| POST | `/tg/billing/gift-notes/sync` | Poll Gift Notes purchase state after payment. |
| GET | `/tg/gift-notes/occasions` | List user's occasions (birthdays, holidays, etc.) with next occurrence dates. |
| POST | `/tg/gift-notes/occasions` | Create an occasion. Requires Gift Notes access (PRO or one-time unlock). |
| PATCH | `/tg/gift-notes/occasions/:id` | Update occasion fields. |
| DELETE | `/tg/gift-notes/occasions/:id` | Delete occasion and its ideas. |
| GET | `/tg/gift-notes/occasions/:id/ideas` | List ideas for a specific occasion. |
| POST | `/tg/gift-notes/occasions/:id/ideas` | Create an idea for an occasion. |
| PATCH | `/tg/gift-notes/ideas/:id` | Update idea fields. |
| DELETE | `/tg/gift-notes/ideas/:id` | Delete idea. |
| GET | `/tg/gift-notes/ideas/all` | List all ideas across all occasions. |
| GET | `/tg/gift-notes/status` | Check Gift Notes feature access status (unlocked, unlock type, price). |
| POST | `/tg/gift-notes/occasions/:id/ideas/reorder` | Reorder ideas within an occasion. |

**Promo Codes**

| Method | Path | Description |
|---|---|---|
| POST | `/tg/promo/apply` | Redeem a promotional code (e.g., WISHPRO). Rate-limited to 5/min. Validates campaign, checks eligibility, creates `PromoRedemption`. |
| GET | `/tg/promo/check` | Check if current user has an active promo redemption. |

**Onboarding**

| Method | Path | Description |
|---|---|---|
| GET | `/tg/onboarding/status` | Check onboarding eligibility and current state. Returns variant assignment, entry point, and demo item info. |
| POST | `/tg/onboarding/start` | Start onboarding flow. Assigns variant (v2_try), creates demo item in Drafts wishlist, creates `UserOnboardingState`. |
| POST | `/tg/onboarding/complete` | Mark onboarding as completed with a reason. Idempotent. |
| POST | `/tg/onboarding/dismiss` | Dismiss onboarding. Deletes untouched demo items. |
| POST | `/tg/onboarding/try-import` | Import URL from onboarding v2 (NO PRO gate). Rate-limited to 3/min. |
| GET | `/tg/onboarding/catalog` | Get catalog templates for the user's market segment (ru/global). |
| POST | `/tg/onboarding/catalog/select` | Select catalog template items to import during onboarding. |
| POST | `/tg/onboarding/trigger` | Trigger onboarding for eligible users (entry point: manual_cta or auto_after_first_wishlist). |

**URL Import**

| Method | Path | Rate limit | Description |
|---|---|---|---|
| POST | `/tg/import-url` | 10/min per user | PRO feature (or import credits). Parse a product URL and create an item in the user's Drafts (SYSTEM_DRAFTS) wishlist. Returns `parseStatus`: `ok`, `partial`, or `failed`. |

**Analytics / God Mode**

| Method | Path | Description |
|---|---|---|
| GET | `/tg/god-stats` | Comprehensive analytics dashboard data: funnel metrics, engagement stats, feature gate hits, error rates, promo stats, onboarding funnel, locale segments, add-on revenue. God mode required. |
| GET | `/tg/retention-stats` | Retention cohort analysis with configurable period. God mode required. |
| GET | `/tg/retention-recent` | Recent user activity timeline for retention debugging. God mode required. |
| GET | `/tg/analytics/locale-segments` | Locale segment distribution (language_code grouping with canonical locale mapping). God mode required. |

**Support**

| Method | Path | Description |
|---|---|---|
| POST | `/tg/support/session` | Create a support session (ForceReply prompt record). |
| GET | `/tg/support/lookup` | Lookup support ticket by support ID. |

**Secret Santa** (~55+ endpoints)

The Secret Santa system is seasonal (Nov 15 - Feb 15) and includes campaigns, participants, draws, exclusions, assignments, anonymous chat, polls, exit requests, hint requests, and notifications.

| Method | Path | Description |
|---|---|---|
| GET | `/tg/santa/status` | Check if Secret Santa feature is globally enabled. |
| GET | `/tg/santa/campaigns` | List user's Santa campaigns (as owner or participant). |
| POST | `/tg/santa/campaigns` | Create a Santa campaign. |
| GET | `/tg/santa/campaigns/:id` | Get campaign details with participant list. |
| PATCH | `/tg/santa/campaigns/:id` | Update campaign settings (title, budget, deadline). |
| DELETE | `/tg/santa/campaigns/:id` | Delete campaign (owner only, before draw). |
| POST | `/tg/santa/campaigns/:id/join` | Join a campaign via invite link. |
| POST | `/tg/santa/campaigns/:id/leave` | Leave a campaign (before draw). |
| POST | `/tg/santa/campaigns/:id/remove/:participantId` | Remove a participant (owner only). |
| POST | `/tg/santa/campaigns/:id/draw` | Execute the Secret Santa draw. Creates round, assignments, and anonymous aliases. |
| GET | `/tg/santa/campaigns/:id/assignment` | Get current user's assignment (who they are gifting). |
| PATCH | `/tg/santa/campaigns/:id/assignment` | Update gift status (PENDING -> BUYING -> BOUGHT -> DELIVERED). |
| GET | `/tg/santa/campaigns/:id/progress` | Campaign progress overview for organizer. |
| POST | `/tg/santa/campaigns/:id/cancel` | Cancel campaign (owner only). |
| POST | `/tg/santa/campaigns/:id/complete` | Mark campaign as completed. |
| GET/POST/PATCH/DELETE | `/tg/santa/campaigns/:id/exclusions` | Manage draw exclusions (who should not be paired). |
| GET | `/tg/santa/campaigns/:id/chat` | List campaign chat messages (keyset pagination). Anonymous aliases used. |
| POST | `/tg/santa/campaigns/:id/chat` | Send a chat message. JOINED participants only. |
| GET | `/tg/santa/campaigns/:id/polls` | List polls in a campaign. |
| POST | `/tg/santa/campaigns/:id/polls` | Create a poll (organizer only). |
| POST | `/tg/santa/campaigns/:id/polls/:pollId/vote` | Vote on a poll option. |
| DELETE | `/tg/santa/campaigns/:id/polls/:pollId` | Delete a poll (organizer only). |
| POST | `/tg/santa/campaigns/:id/exit-request` | Request to exit after draw (creates ExitRequest for organizer approval). |
| PATCH | `/tg/santa/campaigns/:id/exit-request/:requestId` | Approve/reject exit request (organizer). |
| GET | `/tg/santa/campaigns/:id/notifications` | List user's notifications for a campaign. |
| POST | `/tg/santa/campaigns/:id/notifications/mark-read` | Mark notifications as read. |
| POST | `/tg/santa/campaigns/:id/redraw` | Re-execute draw after participant changes (owner only). |
| POST | `/tg/santa/campaigns/:id/hint-request` | Request a hint from the person you are gifting. |
| GET | `/tg/santa/campaigns/:id/hint-request` | Check status of outgoing hint request. |
| GET | `/tg/santa/campaigns/:id/incoming-hints` | List incoming hint requests (from your Santa). |
| POST | `/tg/santa/campaigns/:id/incoming-hints/:hintId/fulfill` | Fulfill a hint request by selecting wishlist items. |
| GET | `/tg/santa/invite/:code` | Resolve invite code to campaign preview (public-ish). |

### Internal routes (`/internal/*`)

Mounted as `internalRouter`. All routes require `requireInternalAuth` middleware (`X-INTERNAL-KEY` == `BOT_TOKEN`).

| Method | Path | Rate limit | Description |
|---|---|---|---|
| POST | `/internal/import-url` | 30/min | Import a product URL on behalf of a user (by `userId`). Same pipeline as `/tg/import-url`. Called by bot when a user sends a URL in chat. |
| GET | `/internal/support/lookup` | — | Lookup support ticket by support ID. Used by bot for support flow resolution. |

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
  |
  +- cors()                    # Allow WEB_ORIGIN and non-browser requests
  +- express.json()            # Parse JSON body
  |
  +- /uploads/*                # express.static(UPLOAD_DIR), 30-day immutable cache
  +- /health                   # Immediate response, no auth
  +- /health/deep              # Immediate response, no auth
  |
  +- [/tg, /public] maintenance check  # Returns 503 {code: MAINTENANCE} if MAINTENANCE_MODE=true
  |
  +- /public/*
  |    +- publicReadLimiter    # 120 req/min (reads)
  |    +- publicActionLimiter  # 30 req/15 min (reserve/unreserve/purchase)
  |
  +- /tg/*
  |    +- requireTelegramAuth  # Validates X-TG-INIT-DATA HMAC; sets req.tgUser
  |    +- language persist     # Fire-and-forget: writes raw language_code to UserProfile.language
  |    +- error tracking       # Fire-and-forget: records 4xx/5xx responses to AnalyticsEvent
  |    +- importUrlLimiter     # 10 req/min per tgUser (import-url only)
  |    +- promoLimiter         # 5 req/min per tgUser (promo/apply only)
  |    +- onboardingImportLimiter  # 3 req/min per tgUser (onboarding/try-import only)
  |
  +- /internal/*
  |    +- requireInternalAuth  # Validates X-INTERNAL-KEY == BOT_TOKEN
  |    +- internalImportLimiter # 30 req/min
  |
  +- /* (privateRouter)
  |    +- requireAdmin         # Validates X-ADMIN-KEY
  |
  +- Error handler (4-arg middleware)
       +- Multer LIMIT_FILE_SIZE  -> 413
       +- Multer LIMIT_UNEXPECTED_FILE -> 400
       +- Unsupported file type   -> 415
       +- All other errors        -> 500 { error: 'Internal server error' }
```

---

## 4. Key Helper Functions

### `asyncHandler(fn)`
Wraps an async route handler. Catches any rejected promise and passes the error to `next()`, so Express's error handler processes it.

### `getOrCreateTgUser(tgUser)`
Upserts a `User` row using `telegramId` as the unique key. On create, stores `telegramId` and `telegramChatId`. On update, refreshes `telegramChatId` and `firstName`. Returns the full user record including `godMode` flag.

### `getOrCreateProfile(userId, locale?)`
Upserts a `UserProfile` row. On create, sets `defaultCurrency` based on locale (`RUB` for `ru`, `USD` otherwise). Generates a unique 16-char hex `supportId` on creation (or lazy-backfills if missing).

### `getUserEntitlement(userId, godMode?)`
Queries the `Subscription` table and `PromoRedemption` table for active PRO access. Returns `{ plan, isPro, proSource, subscription, promoPro }`. Resolution order: (1) paid subscription, (2) active promo redemption, (3) god mode, (4) FREE plan.

### `getEffectiveEntitlements(userId, godMode?)`
Unified entitlement resolver. Combines base plan with add-on slots and credits. Returns effective limits for wishlists, subscriptions, per-wishlist item slots, seasonal decorations, hint/import credits, and Gift Notes access.

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

### `sendTgBotMessage(chatId, text, replyMarkup?)`
Sends a Telegram message with optional reply markup (inline keyboard). Returns true on success. Used for bot-style messages with buttons.

### `sendAdminAlert(text)`
Sends an alert message to all `ADMIN_ALERT_CHAT_IDS`. Best-effort, never throws.

### `notifySubscribersOfChange(wishlistId, entityId, changedFields, eventType, meta)`
For each subscriber of a wishlist: upserts `SubscriptionUnread` markers for each changed field, then sends a Telegram push notification. Fire-and-forget.

### `queueCommentNotification(key, chatId, itemTitle, text)`
Sends the first comment notification immediately. Subsequent calls within 30 seconds increment a counter; when the debounce timer fires, a single batched notification is sent with the count.

### `secureCompare(a, b)`
Timing-safe string comparison via SHA-256 digests. Used for `actorHash` verification and key comparisons.

### `generateUniqueSlug(title)` / `generateUniqueShareToken()`
Generate URL-safe slugs and share tokens with collision retry loops (up to 10 attempts, then falls back to UUID).

### `generateUniqueSupportId()`
Generates a 16-char lowercase hex support ID. Not derived from any user-identifying data. Retries up to 10 times for uniqueness.

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

### `trackEvent(event, userId?, props?)`
Analytics logging stub. Persists events starting with `feature_gate_hit_`, `onboarding_`, `demo_item_`, `gift_`, or `error:` to `AnalyticsEvent` table. Fire-and-forget.

### `getOrCreateDraftsWishlist(userId)`
Finds or creates a `SYSTEM_DRAFTS` wishlist for the user. Used by URL import and onboarding flows. Checks that active item count is below `DRAFTS_ITEM_LIMIT` (50).

### `importUrlForUser(userId, rawUrl, note?, source?, opts?)`
Full URL import pipeline: validates URL, checks PRO entitlement (or import credits), gets/creates Drafts wishlist, parses URL via `url-parser.ts`, creates item. Returns `{ item, wishlistId, parseStatus }`.

### `normalizePromoCode(raw)`
Trims, uppercases, and strips spaces/hyphens from a promo code string.

### `completeOnboarding(userId, reason)`
Completes the onboarding for a user. Idempotent (no-op if already COMPLETED/DISMISSED). Fires analytics event on first real completion. Sets `becameRealAt` on demo item if reason is `demo_converted`.

### `attributeLifecycleReturn(userId)`
Marks the user's most recent lifecycle touch as "returned" (within 7-day window). Checks if the target action was completed (e.g., created wishlist, added item). Fire-and-forget.

### `classifyLifecycleSegment(userId)`
Classifies a user into lifecycle segments: S1 (started, no wishlist, 6h+ inactive), S2 (has wishlist, no items, 1d+ inactive), S3 (has items, 5d+ inactive), S4 (fully active, churned 7d+). Returns null if not in any churn segment.

### `sendLifecycleDM(chatId, text, webAppUrl?)`
Sends a Telegram DM via bot API with optional web_app button. Returns true if delivered.

### `getSeasonStartYear(now)`
Determines the canonical season year for Secret Santa. Jan 1 - Feb 15 maps to previous year (season started Nov of Y-1).

### `generateSantaAliases(roundId, participantIds)`
Generates deterministic anonymous aliases for Santa participants using seeded PRNG. Each alias combines an adjective, emoji, and animal (e.g., "Friendly Fox").

### `loadSantaAliasMap(roundId)` / `resolveSantaAlias(map, participantId)`
Load alias records from DB for a round. Resolve a participant ID to their anonymous alias (fallback: "Participant").

### `createSystemMessage(campaignId, systemEvent, payload?)`
Creates a SYSTEM-type chat message in a Santa campaign. Used at lifecycle events (join, leave, draw, cancel, complete). Never blocks the caller.

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

### One-Time SKU Catalogue

```typescript
const ONE_TIME_SKUS = {
  extra_wishlist_slot:     { price: 39,  type: 'permanent',  addonType: 'wishlist_slot'       },
  extra_subscription_slot: { price: 25,  type: 'permanent',  addonType: 'subscription_slot'   },
  extra_items_5:           { price: 19,  type: 'permanent',  addonType: 'item_slot_5',         targetRequired: true  },
  extra_items_15:          { price: 39,  type: 'permanent',  addonType: 'item_slot_15',        targetRequired: true  },
  hints_pack_5:            { price: 29,  type: 'consumable', creditKey: 'hint',   creditAmount: 5  },
  hints_pack_10:           { price: 49,  type: 'consumable', creditKey: 'hint',   creditAmount: 10 },
  import_pack_10:          { price: 39,  type: 'consumable', creditKey: 'import', creditAmount: 10 },
  import_pack_25:          { price: 79,  type: 'consumable', creditKey: 'import', creditAmount: 25 },
  seasonal_decoration:     { price: 29,  type: 'cosmetic',   addonType: 'seasonal_decoration', targetRequired: true  },
  gift_notes_unlock:       { price: 19,  type: 'permanent',  addonType: 'gift_notes_unlock'   },
}
```

All prices are in Telegram Stars (XTR). SKU types:
- **permanent**: provisioned as `UserAddOn`, persists indefinitely
- **consumable**: provisioned as `UserCredits` (hintCredits or importCredits), decremented on use
- **cosmetic**: provisioned as `UserAddOn` with `targetId` (specific wishlist)

### Add-on Caps

```typescript
const ADDON_CAPS = {
  extraWishlistSlots:      { FREE: 3, PRO: 5 },   // FREE total<=5; PRO total<=15
  extraSubscriptionSlots:  3,                      // any plan: +3 max
  extraItems5PerWishlist:  3,                      // +5x3 = +15 items per wishlist
  extraItems15PerWishlist: 1,                      // +15x1 = +15 items per wishlist
}
```

### Entitlement resolution order
1. Query `Subscription` where `userId = <id>`, `planCode = PRO_PLAN_CODE`, `status IN (ACTIVE, CANCELLED)`, `currentPeriodEnd > now`. Order by `currentPeriodEnd DESC`, take first.
2. If found: return `PLANS.PRO`, `isPro: true`, `proSource: 'subscription'`.
3. Check `PromoRedemption` where `userId = <id>`, `status = ACTIVE`, `expiresAt > now OR expiresAt IS NULL`.
4. If found: return `PLANS.PRO`, `isPro: true`, `proSource: 'promo'`.
5. If `godMode` flag is set on the user: return `PLANS.PRO`, `isPro: true`, `proSource: 'god_mode'`.
6. Otherwise: return `PLANS.FREE`, `isPro: false`.

`getEffectiveEntitlements()` further resolves: add-on extra slots (wishlists, subscriptions, per-wishlist items), seasonal decoration wishlist IDs, hint/import credits, and Gift Notes access.

`PRO_PLAN_CODE`, `PRO_PRICE_XTR`, and `PRO_SUBSCRIPTION_PERIOD` are read from environment variables with defaults (`PRO`, `100`, `2592000`).

---

## 6. URL Import Pipeline

Entry points: `POST /tg/import-url` (Mini App), `POST /internal/import-url` (bot), and `POST /tg/onboarding/try-import` (onboarding, no PRO gate).

All call `importUrlForUser(userId, rawUrl, note?, source?)`.

**Steps:**

1. **Validate URL** -- `validateUrl(rawUrl)` checks length (max 2,048 chars), scheme (must be http/https), hostname (blocks localhost, 127.0.0.1, etc.), and strips tracking parameters.

2. **Feature gate** -- `getUserEntitlement(userId)` must include `url_import` in features (PRO only), OR user must have available import credits. Returns 402 if neither. (Onboarding try-import bypasses this gate.)

3. **Get or create Drafts wishlist** -- `getOrCreateDraftsWishlist(userId)` finds or creates a `SYSTEM_DRAFTS` wishlist. Checks that active item count is below `DRAFTS_ITEM_LIMIT` (50). Throws a 402 error if at limit.

4. **Parse URL** -- `parseUrl(rawUrl)` runs the extraction pipeline (see below). On exception, `parseStatus` is set to `'failed'` and a minimal record is created with the domain name as title.

5. **Set parseStatus** -- `'ok'` if title and priceText present, `'partial'` if one is missing, `'failed'` if neither is present.

6. **Build description** -- combines user note (if any) and parsed description, truncated to 500 chars.

7. **Create item** -- inserts into the Drafts wishlist with `sourceUrl`, `sourceDomain`, `importMethod` recorded.

8. **Return** -- `{ item, wishlistId, parseStatus }`.

**`parseUrl()` extraction pipeline** (from `url-parser.ts`, ~1,059 lines):

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
  -> canonicalize URL
  -> check in-memory positive cache (24 h TTL, max 1,000 entries)
  -> check negative cache (5 min TTL)
  -> Wildberries shortcut: card.wb.ru JSON API (if article number extractable)
  -> BROWSER_FIRST domains (ozon.ru, market.yandex.ru): browserExtract()
  -> HTTP-first domains: fetchHtml() + Cheerio
      -> if confidence < medium: browserExtract() fallback
  -> anti-bot / garbage result guard
  -> merge fields by priority
  -> store in positive cache (on success) or negative cache (on failure)
  -> return ParsedUrlData
```

The Puppeteer browser instance is shared as a singleton (`browserInstance`), lazily created on first use, and closed after 90 seconds of idle time (`BROWSER_IDLE_MS`). The Chromium executable path is configurable via `CHROMIUM_PATH` (env) or defaults to `/usr/bin/chromium`.

---

## 7. Image Processing Pipeline

```
Multipart request
  |
  +- Multer (memory storage)
  |    - fileFilter: JPEG, PNG, WebP, GIF only (else 415)
  |    - limits.fileSize: 30 MB (else 413)
  |
  +- processImage(buffer, { maxDim, quality, suffix })
       |
       +- sharp(buffer)
       |    .rotate()              // auto-rotate from EXIF
       |    .resize(maxDim, maxDim, { fit: 'inside', withoutEnlargement: true })
       |    .jpeg({ quality, mozjpeg: true })
       |    .toFile(filepath)
       |
       +- returns { filename, filepath, sizeBytes, width, height }

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
| Lifecycle winback | `sendLifecycleDM` | Churn segment users (S1-S4) | Scheduled DM with optional web_app button |
| Santa seasonal broadcast | `sendTgNotification` | All users with chatId | Batch broadcast (Nov 1 promo, Feb 1 closing-soon) |

All Telegram sends are performed by calling `https://api.telegram.org/bot<TOKEN>/sendMessage` directly from the API process (not through the bot). Failures are logged but never propagate to the calling request.

---

## 9. Onboarding Engine

The onboarding system uses variant-based A/B testing. The v2_try variant won and is now the default for all new users. Historical v1_demo flows are still supported.

**Key constants:**
- `ONBOARDING_KEY = 'hello_activation'`
- `ONBOARDING_VERSION = 1`
- `RU_VARIANTS`: wildberries, goldapple, ozon, yandex_market
- `GLOBAL_VARIANTS`: amazon, zalando, sephora, apple

**Market segments:** `ru` (Russian locale) and `global` (all other locales).

**Demo item templates:** Each variant has a pre-defined gift certificate item (title, URL, price, image, description). RU variants use RUB currency, global variants use USD.

**Eligibility:** User must have no real (non-demo) items and no completed/dismissed onboarding state. Forced rollout users bypass eligibility checks.

**Completion reasons:** `demo_converted`, `real_item_created`, `demo_deleted_then_real_created`, `demo_moved_to_user_wishlist`, `try_import_completed`, `catalog_selected`, `manual_created`.

---

## 10. Degradation Lifecycle

When a user loses PRO access (subscription expires or promo expires), the system follows a three-phase degradation lifecycle:

```
PRO expires
  |
  +- GRACE_PERIOD (14 days)
  |    User retains all data, can upgrade to restore PRO
  |
  +- ARCHIVED (90 days)
  |    Over-limit wishlists and items are soft-archived
  |    Wishlists beyond FREE limit (2) are archived
  |    Items beyond FREE limit (20) per remaining wishlist are archived
  |
  +- PURGED
       Archived data is permanently deleted
       If user regained PRO before purge, data is restored instead
```

Managed by `DegradationState` model. Each phase transition is handled by a separate hourly cron job.

---

## 11. Secret Santa System

Seasonal feature available Nov 15 - Feb 15, controlled by `SantaGlobalConfig`.

**Core entities:**
- `SantaCampaign` -- organizer creates, sets budget/deadline
- `SantaParticipant` -- users join via invite link, status: JOINED/LEFT/REMOVED
- `SantaRound` -- represents a draw round (supports re-draw)
- `SantaAssignment` -- giver-receiver pair, with gift status tracking
- `SantaExclusion` -- pairs that should not be matched in the draw
- `SantaParticipantAlias` -- anonymous identities for chat (seeded PRNG)
- `SantaChatMessage` -- campaign group chat with USER and SYSTEM message types
- `SantaPoll` / `SantaPollVote` -- in-campaign polls
- `SantaExitRequest` -- post-draw exit requests requiring organizer approval
- `SantaHintRequest` -- request wishlist item hints from the person you are gifting
- `SantaNotification` -- in-app notifications with deduplication via `dedupeKey`
- `SantaSeasonalBroadcastLog` -- deduplication for seasonal broadcasts

**Draw algorithm:** Random assignment with exclusion constraints. Validates that a valid Hamiltonian cycle exists. Falls back if constraints make a full cycle impossible.

**Anonymous aliases:** Deterministic PRNG seeded from round ID. Each participant gets an adjective + emoji + animal combination (e.g., "Friendly Fox"). Aliases are stable per round.

---

## 12. Cron Jobs

All jobs use `setInterval(..., 60 * 60 * 1000)` (hourly). Registered at module load time in `index.ts`.

### 1. Comment TTL cleanup
Deletes comments that have passed their `scheduledDeleteAt` time. Logs count if any deleted.

### 2. Archive item purge
Hard-deletes items past their 90-day `purgeAfter` TTL. Processes up to 100 items per run (batch limit). DB record deleted first, then file cleanup (orphaned files are harmless).

### 3. Subscription expiry
Marks overdue subscriptions as EXPIRED (`status IN (ACTIVE, CANCELLED)` with `currentPeriodEnd <= now`). Revokes PRO entitlement.

### 4. Promo expiry
Marks ACTIVE promo redemptions past their `expiresAt` as EXPIRED. Starts GRACE_PERIOD degradation for users who lost PRO (no paid subscription either). Creates `DegradationState` with 14-day grace period.

### 5. Degradation archive
Archives over-limit data after grace period ends. Checks if user regained PRO (restores to NONE if so). Archives newest wishlists beyond FREE limit (2), then newest items beyond FREE limit (20) per remaining wishlist. Sets phase to ARCHIVED with 90-day purge schedule.

### 6. Degradation purge
Permanently deletes archived data after 90 days. If user regained PRO before purge, restores all archived wishlists and items instead. Sets phase to PURGED on completion.

### 7. Lifecycle / Win-back scheduler
Scans users for churn (up to 200 per batch, oldest-first). Classifies into segments S1-S4 based on activity patterns. Checks stop conditions (unsubscribed, bought PRO, returned), frequency caps (72h cooldown, 45-day max 5 touches, 60-day promo cooldown), and cadence timing. Sends Telegram DMs with i18n-aware message templates. Optionally offers WISHPRO promo code on eligible touches (S3 touch 3, S4 touches 2-3).

### 8. Santa hint expiry
Marks PENDING `SantaHintRequest` records past their `expiresAt` as EXPIRED.

### 9. Santa deadline enforcement
Marks overdue PENDING/BUYING assignments as MISSED_DEADLINE for rounds belonging to ACTIVE campaigns whose `drawAt` has passed. Creates DEADLINE_MISSED notifications (deduplicated). Status is recoverable -- giver can still update.

### 10. Santa deadline warning
Notifies PENDING/BUYING givers 3-4 days before `drawAt`. Creates DEADLINE_WARNING notifications (deduplicated via `dedupeKey`). Fires once in the 72-96 hour window before deadline.

### 11. Santa seasonal broadcasts
Checks calendar milestones hourly. Triggers broadcasts on Nov 1 (PROMO: "Secret Santa opening soon") and Feb 1 (CLOSING_SOON: "closes Feb 15"). Deduplication via `SantaSeasonalBroadcastLog` table (unique constraint on year+type). Sends to all users with `telegramChatId`, batch of 25 with 1.2s pause.

---

## 13. Error Handling Patterns

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
| 403 | Ownership check failed, PRO-gated setting, feature gate (e.g., gift_notes_required) |
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
- Maps Multer error codes (`LIMIT_FILE_SIZE` -> 413, `LIMIT_UNEXPECTED_FILE` -> 400).
- Maps `Unsupported file type` message -> 415.
- Logs all other errors to stderr and returns `{ error: 'Internal server error' }` with 500.

### Startup / crash alerts

On startup, the API sends a Telegram message to all `ADMIN_ALERT_CHAT_IDS`. `process.on('uncaughtException')` sends an alert and exits; `process.on('unhandledRejection')` sends an alert without exiting.

---

## 14. Internal API (Bot to API)

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
  "item": { "..." },
  "wishlistId": "<drafts wishlist id>",
  "parseStatus": "ok | partial | failed"
}
```

This endpoint is called by the bot when a user sends a URL message in the Telegram chat. The bot first upserts the user in the database, then calls this endpoint with the internal key.

### `GET /internal/support/lookup`

Lookup a support ticket by support ID. Used by the bot's support flow to resolve user context from the opaque support ID.
