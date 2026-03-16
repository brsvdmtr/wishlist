# ARCHITECTURE.md - WishBoard System Architecture

## 1. Product Overview

**WishBoard** (wishlistik.ru) - Telegram Mini App for managing personal wishlists. Users create wish lists, add items, and share them with friends via Telegram deep links. Friends can anonymously reserve gifts without the list owner knowing who reserved what.

### Key User Scenarios
1. **Owner**: Creates wishlist -> Adds items (title, price, photo, priority, description) -> Shares link via Telegram -> Sees items but NOT who reserved them
2. **Guest**: Opens shared link in Telegram -> Sees wishlist -> Reserves item (anonymous to owner) -> Can comment (visible only to owner and reserver)
3. **Reserver**: Reserved item -> Can comment with owner -> Can unreserve

### Platforms
- **Telegram Mini App** (primary) - opened via Telegram bot menu button or deep link
- **Public web** (secondary) - `/w/:slug` pages for non-Telegram access
- **Admin panel** - `/admin` for manual management

---

## 2. High-Level Architecture

```
                    +-------------------+
                    |   Telegram API    |
                    +--------+----------+
                             |
              +--------------+--------------+
              |                             |
    +---------v---------+        +----------v---------+
    |  Telegram Bot     |        |  Telegram WebApp   |
    |  (apps/bot)       |        |  (MiniApp.tsx)     |
    |  Telegraf 4.16    |        |  React SPA         |
    +-------------------+        +----------+---------+
              |                             |
              | Prisma (direct DB)          | HTTP (fetch)
              |                             |
              |                  +----------v---------+
              |                  |   API Server       |
              |                  |   (apps/api)       |
              |                  |   Express 4.19     |
              |                  |   Port 3001        |
              |                  +----------+---------+
              |                             |
              +-------------+---------------+
                            |
                 +----------v---------+
                 |   PostgreSQL 16    |
                 |   (Prisma ORM)    |
                 +--------------------+
                            |
                 +----------v---------+
                 |   File Storage     |
                 |   /data/uploads    |
                 |   (Docker volume)  |
                 +--------------------+
```

### Production Network (Docker Compose)

```
Internet -> Nginx (wishlistik.ru:443)
               |
               +-- /api/*  -> api:3001  (Express)
               +-- /*      -> web:3000  (Next.js)

Internal (wishlist-network bridge):
  api:3001 -> postgres:5432
  bot      -> Telegram API (outbound)
  bot      -> postgres:5432 (direct Prisma)
  web:3000 -> api:3001 (internal, SSR)
```

---

## 3. Module Responsibilities

### apps/api (Express REST API)
- **Role**: Central backend. All data access, business logic, auth, image processing
- **Auth**: Three tiers: Public (no auth), Admin (X-ADMIN-KEY), Telegram (X-TG-INIT-DATA)
- **Image processing**: Sharp (resize, EXIF strip, JPEG compress)
- **Notifications**: Telegram bot API for sending messages to users
- **Entry point**: `apps/api/src/index.ts` (single file, ~1840 lines)

### apps/web (Next.js 14)
- **Role**: Serves the Telegram Mini App and public wishlist pages
- **Key page**: `/miniapp` - Single-page React app (`MiniApp.tsx`, ~2170 lines)
- **Public pages**: `/w/:slug` - Server-rendered wishlist pages
- **Admin**: `/admin` - Protected admin panel
- **Entry point**: `apps/web/app/layout.tsx`

### apps/bot (Telegraf)
- **Role**: Telegram bot for deep linking and notifications
- **Commands**: `/start`, `/help`
- **Deep links**: `?startapp=<payload>` opens Mini App with context
- **DB access**: Direct Prisma client (stores telegramChatId)
- **Entry point**: `apps/bot/src/index.ts` (single file, ~100 lines)

### packages/db (Prisma)
- **Role**: Database schema, migrations, Prisma client singleton
- **Tables**: User, Wishlist, Item, Tag, ItemTag, ReservationEvent, Comment
- **Entry point**: `packages/db/src/index.ts`

### packages/shared
- **Role**: Shared utilities and types
- **Exports**: Zod schemas, deep link builders, share URL builders

---

## 4. Data Flow: Key Sequences

### Owner Creates Wishlist
```
MiniApp.tsx -> POST /tg/wishlists (X-TG-INIT-DATA)
           -> API validates Telegram signature
           -> API upserts User (by telegramId)
           -> API checks plan limits (2 wishlists)
           -> API generates unique slug
           -> Prisma creates Wishlist
           -> Returns { wishlist } to frontend
           -> Frontend updates local state
```

### Guest Opens Shared Link
```
Telegram deep link: t.me/BotName?startapp=share_TOKEN
  -> Bot /start handler -> Sends inline button "Smotri wishlist"
  -> User clicks button -> Opens MiniApp with ?startapp=share_TOKEN
  -> MiniApp reads startapp param
  -> GET /public/share/TOKEN (no auth)
  -> API resolves shareToken -> Wishlist
  -> Returns { wishlist, items, tags }
  -> MiniApp renders guest view
```

### Guest Reserves Item
```
MiniApp.tsx -> POST /tg/items/:id/reserve (X-TG-INIT-DATA)
           -> Body: { displayName: "chosen name" }
           -> API validates Telegram auth
           -> API computes actorHash from telegramId
           -> Prisma transaction:
              1. Verify item status = AVAILABLE
              2. Update item: status=RESERVED, reserverUserId, reservationEpoch++
              3. Create ReservationEvent (type=RESERVED, displayName as comment)
              4. Create SYSTEM Comment "Подарок забронирован"
           -> Notify owner via Telegram (async, best-effort)
           -> Return { ok: true }
```

### Comment Exchange
```
Reserver sends comment:
  POST /tg/items/:id/comments -> API checks role (reserver)
  -> Anti-spam: 10s cooldown, dedup, 3 consecutive limit, 10/hour, 20/month
  -> Creates Comment with reservationEpoch linkage
  -> Notifies owner via Telegram (30s batch debounce)

Owner replies:
  POST /tg/items/:id/comments -> API checks role (owner)
  -> Same anti-spam rules
  -> Notifies reserver via Telegram
```

### Photo Upload
```
MiniApp.tsx -> User selects file (JPEG/PNG/WebP/GIF, max 30MB)
           -> Shows local blob preview
           -> On save: POST /tg/items/:id/photo (multipart/form-data)
           -> API receives buffer in memory (multer memoryStorage)
           -> Sharp processes: auto-rotate, strip EXIF, resize
              - Full: max 1600px, JPEG q80
              - Thumb: max 480px, JPEG q70
           -> Writes to UPLOAD_DIR (/data/uploads)
           -> Deletes old upload files if replacing
           -> Updates item.imageUrl = /api/uploads/{uuid}-full.jpg
           -> Returns { photoUrl, thumbUrl, width, height, sizeBytes }
           -> Nginx serves /api/uploads/* -> Express static
```

---

## 5. Image Storage Architecture

```
Upload flow:
  Browser -> Nginx (client_max_body_size 30m)
          -> Express (/tg/items/:id/photo)
          -> Multer (memory buffer, 30MB limit)
          -> Sharp (compress, resize, strip EXIF)
          -> Write to /data/uploads/{uuid}-full.jpg
          -> Write to /data/uploads/{uuid}-thumb.jpg

Serving flow:
  Browser requests /api/uploads/{uuid}-full.jpg
  -> Nginx proxy_pass to Express:3001
  -> express.static('/uploads', UPLOAD_DIR, { maxAge: '30d', immutable: true })

Storage:
  Docker volume: wishlist_uploads -> /data/uploads (inside api container)
  Files persist across container rebuilds
```

---

## 6. Authentication Architecture

### Telegram Mini App Auth (Primary)
```
Flow:
1. Telegram opens MiniApp with window.Telegram.WebApp.initData
2. Frontend sends X-TG-INIT-DATA header with every request
3. API middleware validateTelegramInitData():
   - Parses key=value pairs from initData
   - Extracts data_check_string (all params except hash, sorted)
   - Computes HMAC-SHA256(secret_key, data_check_string)
   - secret_key = HMAC-SHA256("WebAppData", BOT_TOKEN)
   - Compares computed hash with provided hash
4. Extracts TelegramUser from "user" JSON field
5. Sets req.tgUser for downstream handlers
```

### Admin Auth (Two-Layer) `VERIFIED_FROM_CODE`
```
Layer 1: Browser → Next.js middleware
  HTTP Basic Auth (ADMIN_BASIC_USER + ADMIN_BASIC_PASS)
  Protects /admin/* pages

Layer 2: Next.js API route → Express backend
  X-ADMIN-KEY header (added server-side by api-proxy.ts)
  ADMIN_KEY never reaches browser
  Express requireAdmin() validates via secureCompare()
```

### Public API `VERIFIED_FROM_CODE`
- No auth required
- Guest identity via `actorHash` (SHA-256 of Telegram ID, formatted as UUID)
- Stored in localStorage on client
- **No public comment endpoints** — comments only via `/tg/items/:id/comments` (Telegram auth)

### Dev Bypass
- `X-TG-DEV: telegramId` header in non-production environment
- Skips Telegram signature validation

---

## 7. State Management

### Frontend (MiniApp.tsx)
- **Pure React useState** - no external state library
- ~30 useState hooks for all state
- State split: auth, owner, guest, UI, forms, comments
- No persistence beyond session (except localStorage for actorHash)

### Backend
- **Stateless** - no server-side sessions
- All state in PostgreSQL via Prisma
- File state on disk (Docker volume)
- In-memory: notification debounce queue (lost on restart, acceptable)
