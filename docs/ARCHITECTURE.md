# Architecture

**Date:** 2026-04-02
**Project:** Wishlist Telegram Mini App (wishlistik.ru)

---

## 1. Product Overview

Wishlist is a Telegram Mini App that allows users to create and share gift wishlists. The app operates inside Telegram's WebApp frame and communicates with a backend API over HTTPS.

### Core scenarios

**Owner** — an authenticated Telegram user who creates wishlists and items, manages privacy settings, receives reservation and comment notifications, and can purchase a PRO subscription via Telegram Stars.

**Guest** — an anonymous visitor who opens a shared wishlist link, reserves or purchases items, and may leave comments (if the wishlist owner has PRO and comments are enabled). Guest identity is tracked by a client-generated UUID (`actorHash`).

**Subscriber** — an authenticated Telegram user who follows a public wishlist. Subscribers receive Telegram push notifications when items are added or updated, and can see unread indicators in the Mini App.

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────┐
│                     Telegram Clients                      │
│  (Mini App WebApp + Bot DMs + Guest shared-link browser)  │
└───────────────┬──────────────────────┬────────────────────┘
                │                      │
                │ HTTPS                │ Telegram Bot API
                ▼                      ▼
┌──────────────────────┐    ┌─────────────────────┐
│   apps/web           │    │   apps/bot           │
│   Next.js 14 :3000   │    │   Telegraf 4.16      │
│   MiniApp.tsx        │    │   Long polling       │
└──────────┬───────────┘    └──────────┬────────────┘
           │ fetch (X-TG-INIT-DATA)     │ HTTP (X-INTERNAL-KEY)
           ▼                            ▼
┌──────────────────────────────────────────────────────────┐
│                   apps/api  :3001                         │
│                   Express 4.x + TypeScript                │
│                                                          │
│  /public/*   (no auth)                                   │
│  /tg/*       (X-TG-INIT-DATA HMAC)                       │
│  /internal/* (X-INTERNAL-KEY)                            │
│  /*          (X-ADMIN-KEY, legacy admin router)          │
└──────────────────────────┬───────────────────────────────┘
                           │ Prisma ORM
                           ▼
               ┌───────────────────────┐
               │  PostgreSQL 16        │
               │  packages/db schema   │
               └───────────────────────┘
```

---

## 3. Production Network Diagram

```
Internet
    │
    ▼ HTTPS :443
┌──────────────────────────────────────┐
│  Nginx (wishlistik.ru)          │
│                                      │
│  location /api/  → api:3001          │
│  location /      → web:3000          │
└───────────────┬──────────────────────┘
                │ Docker network: wishlist-network
     ┌──────────┼──────────────────────┐
     ▼          ▼                      ▼
 api:3001    web:3000         bot (no port exposed)    cron (no port exposed)
     │                           │                         │
     └──────────┬────────────────┤─────────────────────────┘
                ▼                ▼
           postgres:5432
```

All four services run as Docker containers defined in `docker-compose.prod.yml`. The `api` and `web` services expose ports 3001 and 3000 respectively; Nginx acts as the TLS terminator and reverse proxy. The `bot` container has no exposed port and communicates outbound to the Telegram Bot API and inbound to `api:3001` over the Docker internal network. The `cron` container runs scheduled lifecycle, degradation, and promo-reminder jobs against the database directly.

Uploaded files are stored in a named Docker volume `wishlist_uploads`, mounted at `/data/uploads` inside the `api` container and served as static files at `/uploads/*` by the API process itself (with a 30-day immutable cache header). Nginx forwards `/api/uploads/*` to the API.

---

## 4. Module Responsibilities

| Module | Path | Responsibility |
|---|---|---|
| `api` | `apps/api/src/index.ts` (~11,964 lines) | Express HTTP server. All business logic: wishlists, items, reservations, comments, hints, subscriptions, billing, profile, settings, URL import, image processing, background jobs, add-on SKU store, promo code system, lifecycle/degradation engine, locale segments analytics, Secret Santa subsystem, gift notes/occasions. |
| `api` | `apps/api/src/url-parser.ts` (~1,059 lines) | Multi-strategy product card extractor: Cheerio + Puppeteer, in-memory cache, 7 domain adapters. |
| `api` | `apps/api/src/browser-network-extractor.ts` | Puppeteer-based XHR/fetch interception for SPA product pages. |
| `api` | `apps/api/src/sort.ts` | Item sort order logic (side-effect-free, unit-tested). |
| `bot` | `apps/bot/src/index.ts` (~1,190 lines) | Telegraf bot. Commands, payment handlers, URL import relay, hints delivery, support ticket bridge, heartbeat, add-on purchase flow, promo code redemption, Secret Santa notifications. |
| `web` | `apps/web/` (MiniApp.tsx ~16,663 lines) | Next.js 14 app. Single-page Mini App (`MiniApp.tsx`), server-side admin routes (Basic Auth middleware). |
| `db` | `packages/db/` | Prisma schema for PostgreSQL 16. Shared client exported as `@wishlist/db`. Both `api` and `bot` import this package directly. |
| `shared` | `packages/shared/` | i18n strings (6 locales: ru, en, zh-CN, hi, es, ar), `t()` translation function, `normalizeLocale()`, `isRTL()`, `resolveEffectiveLocale()`, TypeScript types shared across packages. |

---

## 5. Auth System

### Tier 1 — Public (`/public/*`)

No authentication required. Used by guests who open a shared wishlist link. Rate-limited: 120 requests/min for reads (`publicReadLimiter`), 30 requests/15 min for write actions (reserve, unreserve, purchase — `publicActionLimiter`). Guest identity for reservations is a client-generated UUID (`actorHash`) passed in the request body; the server uses timing-safe comparison (`crypto.timingSafeEqual`) to verify ownership before allowing unreserve.

### Tier 2 — Telegram (`/tg/*`)

Authenticated via the `X-TG-INIT-DATA` header. The middleware (`requireTelegramAuth`) validates the header by:
1. Parsing the URL-encoded init data string.
2. Removing the `hash` field and lexicographically sorting remaining key=value pairs.
3. Computing HMAC-SHA256 of the sorted string using a key derived as `HMAC-SHA256("WebAppData", BOT_TOKEN)`.
4. Comparing the expected hash with the provided `hash` value.

On success, the parsed `TelegramUser` object (id, first_name, language_code) is attached to `req.tgUser`. A development bypass exists via `X-TG-DEV: <telegram_id>` when `NODE_ENV !== 'production'`.

### Tier 3 — Internal (`/internal/*`)

Used exclusively for bot-to-API communication. The middleware (`requireInternalAuth`) compares the `X-INTERNAL-KEY` header against the `BOT_TOKEN` environment variable using SHA-256 digest comparison with `crypto.timingSafeEqual`. This avoids exposing a separate secret; the bot already possesses `BOT_TOKEN`.

### Tier 4 — Admin (`/*` via `privateRouter`)

The legacy `privateRouter` (wishlist/item/tag CRUD for system users) uses an `X-ADMIN-KEY` header compared against `ADMIN_KEY`. The Next.js web server's admin routes use HTTP Basic Auth (`ADMIN_BASIC_USER` / `ADMIN_BASIC_PASS`).

---

## 6. Data Flow: User Opens Mini App

```
1. User taps bot menu button → Telegram opens WebApp frame
2. Telegram injects window.Telegram.WebApp.initData (signed init data string)
3. MiniApp.tsx reads initData from Telegram WebApp SDK
4. Frontend sends GET /tg/wishlists with header X-TG-INIT-DATA: <initData>
5. requireTelegramAuth validates HMAC → extracts TelegramUser
6. getOrCreateTgUser() upserts User row by telegramId
7. getUserEntitlement() checks active Subscription → returns FREE or PRO plan
8. Response includes wishlists array, plan limits, drafts count, reservationsCount
9. MiniApp.tsx renders home screen (wishlists tab)
```

For subsequent API calls, the same `X-TG-INIT-DATA` header is sent on every fetch request. The Telegram init data string has a short validity window enforced by Telegram itself.

---

## 7. Background Jobs

All jobs run as `setInterval` loops started when the API process boots. Interval: **every 60 minutes**.

| Job | What it does |
|---|---|
| Comment TTL cleanup | Hard-deletes `Comment` rows where `scheduledDeleteAt <= now`. |
| Archive item purge | Finds `Item` rows where `purgeAfter <= now` (set 90 days after soft-delete). Hard-deletes up to 100 per run; also deletes associated upload files. |
| Subscription expiry | Updates `Subscription` rows with `status IN (ACTIVE, CANCELLED)` and `currentPeriodEnd <= now` to `status = EXPIRED`. |
| Hint expiry | Updates `Hint` rows with `status = SENT` and `expiresAt <= now` to `status = EXPIRED`. |

---

## 8. File Storage

Uploaded files are stored on the local filesystem in the directory specified by `UPLOAD_DIR` (default: `./uploads`). In production this is a named Docker volume.

**Upload flow:**
1. Multer receives the multipart request into memory (no temp files). Max size: 30 MB. Allowed MIME types: `image/jpeg`, `image/png`, `image/webp`, `image/gif`.
2. `processImage()` processes the buffer with Sharp:
   - Auto-rotates based on EXIF orientation.
   - Strips all EXIF/metadata.
   - Resizes to fit within `maxDim × maxDim` (preserving aspect ratio, no enlargement).
   - Converts to JPEG using mozjpeg encoder.
3. Output file is written to `UPLOAD_DIR/<uuid>-<suffix>.jpg`.
4. The relative URL `/api/uploads/<filename>` is stored in the database.

**Per-upload-type settings:**

| Upload type | maxDim | quality | Suffix |
|---|---|---|---|
| Item photo (full) | 1600 px | 80 | `full` |
| Item photo (thumb) | 480 px | 70 | `thumb` |
| Profile avatar | 512 px | 80 | `avatar` |

When an item photo or avatar is replaced or deleted, the old file is removed via `deleteUploadFile()`, which also removes the corresponding `-thumb.jpg` variant. External URLs (starting with `http://` or `https://`) are never deleted.

---

## 9. Telegram Integration Points

### Long Polling

The bot connects to Telegram via Telegraf using long polling (`bot.launch()` with no arguments). The bot updates a `ServiceHeartbeat` database record on each processed message; the API's `GET /health/deep` endpoint checks that this heartbeat is not older than 120 seconds.

### Payment flow (Telegram Stars)

1. User taps "Buy PRO" in the Mini App → frontend calls `POST /tg/billing/pro/checkout`.
2. API creates a Telegram invoice link via the `createInvoiceLink` Bot API method (currency `XTR`, amount from env var `PRO_PRICE_XTR`, period from `PRO_SUBSCRIPTION_PERIOD`).
3. Telegram displays the Stars payment UI; user pays.
4. Telegram sends `pre_checkout_query` to the bot → bot validates user existence and calls `answerPreCheckoutQuery(true)`.
5. Telegram sends `successful_payment` message to the bot → bot upserts `Subscription` (status `ACTIVE`, period from `subscription_expiration_date` or +30 days) and records `PaymentEvent`. Idempotent: duplicate `telegram_payment_charge_id` is skipped.
6. Frontend polls `POST /tg/billing/pro/sync` to detect the activated subscription.

### Push notifications

The API sends Telegram messages directly via `https://api.telegram.org/bot<TOKEN>/sendMessage`. All sends are fire-and-forget (`sendTgNotification` never throws). The following events trigger push notifications:

| Event | Recipient |
|---|---|
| Item reserved | Wishlist owner |
| Item completed (purchased) | Wishlist owner |
| Comment posted by reserver | Wishlist owner |
| Comment posted by owner | Current item reserver |
| Item description updated while reserved | Current item reserver |
| Item soft-deleted while reserved | Current item reserver |
| Item added to subscribed wishlist | All wishlist subscribers |
| Item updated in subscribed wishlist | All wishlist subscribers |
| Wishlist title or deadline updated | All wishlist subscribers |
| Hint delivered | Hint recipients (via bot direct message) |

Comment notifications use a 30-second debounce per item+recipient: the first comment sends immediately; subsequent comments within the window increment a counter, and one batched notification is sent when the timer fires.

### Hint delivery

The owner triggers a hint by initiating Telegram's `KeyboardButtonRequestUsers` contact picker. When the user selects contacts, Telegram sends a `users_shared` update to the bot. The bot reads the `Hint` record from the database and sends a direct message to each selected user. If direct delivery fails (recipient has not started the bot), the sender receives a deep link to share manually. Hint delivery counts (`sentCount`, `pendingCount`) are written back to the `Hint` record for Mini App polling.

### Support ticket bridge

The bot maintains a ForceReply-based support flow. When a user starts a support session, the bot sends a ForceReply prompt and stores a `SupportSession` record. The user's reply creates a `SupportTicket` and relays the message to the `SUPPORT_CHAT_ID` group with a generated ticket code (`SUP-NNNN`). Replies from the support group are relayed back to the user's DM. A `SupportMessage` table links user-side and group-side Telegram message IDs to enable threading across turns.

---

## 10. Add-on SKU Store

The platform offers 10 one-time-purchase SKUs via Telegram Stars, defined in an `ADDON_CAPS` constant. SKUs include extra wishlist slots, subscription slots, per-wishlist item upgrades (5 or 15), seasonal decorations, hint credit packs, and import credit packs. Each purchase creates a `Purchase` audit record (idempotent on `telegramChargeId`). Permanent add-ons are tracked in `UserAddOn` rows; consumable balances (hints, imports) are stored in `UserCredits`. PRO users bypass credit checks entirely.

---

## 11. Gift Notes / Occasions

A personal gift idea notebook (`GiftOccasion` + `GiftOccasionIdea`) allows users to track gift ideas organized by occasion (birthday, anniversary, holiday, other). Each occasion has a person name, optional recurring event date, and a list of ideas with optional links, prices, and notes. Occasions support `ACTIVE`, `DONE`, and `ARCHIVED` statuses.

---

## 12. Lifecycle & Degradation

When a PRO or promo-PRO subscription expires, the user enters a four-phase degradation lifecycle tracked by `DegradationState`:

| Phase | Meaning |
|---|---|
| `NONE` | Active PRO or never subscribed |
| `GRACE_PERIOD` | 14-day window after downgrade; PRO features still available |
| `ARCHIVED` | Grace ended; excess wishlists/items archived to fit FREE limits |
| `PURGED` | 90 days after archive; archived items hard-deleted |

The `LifecycleTouch` table drives a multi-touch winback messaging sequence (segments S1-S4) with attribution tracking (returnedAt, targetCompletedAt, promoRedeemedAt). Each touch has a scheduled delivery time, message kind (activation, winback, promo_offer), and optional promo offer code.

---

## 13. Promo Code System

`PromoCampaign` defines reusable promo codes (e.g., `WISHPRO`). Each campaign specifies a reward type, duration in days, active flag, and optional max redemptions. `PromoRedemption` tracks per-user usage with status machine: `PENDING` -> `ACTIVE` -> `EXPIRED`, plus `ACCEPTED_FOR_PAID` (user already has paid PRO) and `FAILED`. Redemptions include lifecycle attribution fields (`offeredAt`, `offeredVia`, reminder flags).

---

## 14. Locale Segments Analytics

God Mode includes a locale segments analytics dashboard. The API computes per-locale user segments and tracks feature gate hits via `AnalyticsEvent`. The `packages/shared` module provides 6 locales (ru, en, zh-CN, hi, es, ar) with `normalizeLocale()`, `isRTL()`, and `resolveEffectiveLocale()`.

---

## 15. Secret Santa Subsystem

A full-featured Secret Santa platform built as a subsystem within the API. Key components:

- **Campaigns** (`SantaCampaign`): CLASSIC or MULTI_WAVE type, seasonal (Nov-Feb), with invite tokens and budget ranges.
- **Participants** (`SantaParticipant`): JOINED/LEFT/REMOVED status, optional linked wishlist, PARTICIPANT or ADMIN role.
- **Rounds & Draw** (`SantaRound`, `SantaAssignment`): Multi-round support with constraint-respecting random draw. Exclusion groups prevent pairs within families/teams.
- **Gift Progress** (`SantaGiftProgress`, `SantaGiftStatus`): 9-state gift lifecycle from PENDING through RECEIVED, with ORPHANED for approved exits.
- **Anonymous Hints** (`SantaHintRequest`): Giver anonymously requests receiver to select wishlist items; 48h TTL; identity never leaked across sides.
- **Campaign Chat** (`SantaChatMessage`, `SantaChatReadCursor`, `SantaChatMute`): In-campaign group messaging with unread tracking and per-participant mute.
- **Polls** (`SantaPoll`, `SantaPollVote`): Campaign-scoped polls with optional anonymity and deadlines.
- **Exit Requests** (`SantaExitRequest`): Participants can request to leave active campaigns; organizer approves/denies.
- **Aliases** (`SantaParticipantAlias`): Round-scoped anonymous identities (adjective + animal + emoji), locale-independent keys.
- **Season Control** (`SantaGlobalConfig`, `SantaSeasonConfig`, `SantaSeasonalBroadcastLog`): Global kill switch, per-year overrides, duplicate broadcast prevention.
- **Notifications** (`SantaNotification`): 16 notification types with dedup keys; push via bot DMs.
- **Audit** (`SantaAdminAuditLog`): Immutable log of organizer actions.
- **Item Reservations** (`SantaItemReservation`): Santa-specific item claims distinct from general reservations; receiver identity never exposed.

---

## 16. Support Bridge

The bot maintains a ForceReply-based support flow. `SupportSession` stores short-lived routing context for ForceReply prompts. `SupportTicket` tracks conversation threads bridging user DMs and a staff Telegram group (`SUPPORT_CHAT_ID`). `SupportMessage` links user-side and group-side Telegram message IDs with support for text, photo, video, and document media types.

---

## 17. Key Design Decisions

**Single-file API (`index.ts`, ~11,964 lines)**
All route handlers, middleware, helpers, and background jobs live in one file. This avoids module boundary complexity at this project scale and keeps cross-cutting concerns (e.g., `sendTgNotification`, `getUserEntitlement`, `processImage`) directly accessible from any handler without import chains.

**Single-file frontend (`MiniApp.tsx`, ~16,663 lines)**
The Mini App is a single React component tree with screen state managed as a `screen` discriminated union. This avoids client-side routing inside the Telegram WebApp frame, where standard Next.js navigation would trigger full page reloads and lose Telegram WebApp state.

**Prisma used by both `api` and `bot`**
Both services connect directly to PostgreSQL via the shared `@wishlist/db` Prisma client. The bot performs reads and writes directly (upsert user on `/start`, upsert subscription on payment) rather than calling the API HTTP layer, avoiding latency and a circular authentication dependency.

**Bot token as internal API key**
`X-INTERNAL-KEY` is validated against `BOT_TOKEN`. This eliminates a separate secret to manage; since the bot already holds `BOT_TOKEN`, no additional credential is needed for bot-to-API calls.

**Plan limits enforced server-side at write time**
The `PLANS` constant defines per-plan limits. `getUserEntitlement()` checks the database for an active subscription. All limit checks (`wishlists`, `items`, `subscriptions`) occur in route handlers before any write, returning `HTTP 402` with `planCode` on violations.

**Soft delete with 90-day TTL**
Items are not hard-deleted immediately. `DELETE /tg/items/:id` sets `status = DELETED`, `archivedAt = now`, and `purgeAfter = now + 90 days`. The hourly purge job performs the hard delete in batches of 100. This preserves reservation and comment history for a grace period and makes accidental deletions recoverable by support.
