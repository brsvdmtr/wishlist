# API_REFERENCE.md - Complete Endpoint Documentation

## Base URL
- Production: `https://wishlistik.ru/api`
- Development: `http://localhost:3001`
- Nginx: `/api/*` proxied to Express port 3001 (trailing slash strips `/api` prefix)

## Authentication Methods

| Method | Header | Used By |
|--------|--------|---------|
| None | - | Public endpoints |
| Admin Key | `X-ADMIN-KEY: <key>` | Admin panel |
| Telegram | `X-TG-INIT-DATA: <initData>` | Mini App |
| Dev bypass | `X-TG-DEV: <telegramId>` | Dev only (non-production) |

## Rate Limits
- Public read: 120 req/min
- Public actions: 30 req/15 min
- Telegram endpoints: No additional rate limit (Telegram auth is the throttle)

---

## HEALTH CHECK

### GET /health
- **Auth**: None
- **Response**: `{ "ok": true }`

---

## PUBLIC ENDPOINTS (prefix: `/public`)

### GET /public/wishlists/:slug
- **Purpose**: Get full wishlist with items and tags (guest view)
- **Auth**: None
- **Params**: `slug` (URL path)
- **Response 200**:
```json
{
  "wishlist": {
    "id": "cuid",
    "slug": "string",
    "title": "string",
    "description": "string|null",
    "deadline": "ISO8601|null"
  },
  "items": [{ /* mapItemForPublic */ }],
  "tags": [{ "id": "string", "name": "string" }]
}
```
- **Response 404**: `{ "error": "Wishlist not found" }`

### GET /public/wishlists/:slug/items
- **Purpose**: List items with optional filtering
- **Auth**: None
- **Params**: `slug` (path)
- **Query**: `status?` (AVAILABLE|RESERVED|PURCHASED), `tag?` (tag ID)
- **Response 200**: `{ "items": [mapItemForPublic] }`
- **Response 404**: Wishlist not found

### GET /public/share/:token
- **Purpose**: Resolve share token to wishlist (same response as GET /public/wishlists/:slug)
- **Auth**: None
- **Params**: `token` (path)
- **Response 200**: Same as GET /public/wishlists/:slug
- **Response 404**: Token not found or column doesn't exist (migration fallback)

### POST /public/items/:id/reserve
- **Purpose**: Guest reserves an available item
- **Auth**: None
- **Body**:
```json
{
  "actorHash": "UUID (required)",
  "comment": "string (optional, max 2000 - guest display name)"
}
```
- **Response 200**: `{ "item": mapItemForPublic }`
- **Errors**: 404, 409 (not AVAILABLE)

### POST /public/items/:id/unreserve
- **Purpose**: Guest unreserves their own reservation
- **Auth**: None
- **Body**: `{ "actorHash": "UUID (required)" }`
- **Response 200**: `{ "item": mapItemForPublic }`
- **Errors**: 404, 409 (not RESERVED), 403 (wrong actor)

### POST /public/items/:id/purchase
- **Purpose**: Guest marks item as purchased
- **Auth**: None
- **Body**:
```json
{
  "actorHash": "UUID (required)",
  "comment": "string (optional, max 2000)"
}
```
- **Response 200**: `{ "item": mapItemForPublic }`
- **Errors**: 404, 409 (already purchased)

> **VERIFIED_FROM_CODE**: Public comment endpoints (`/public/items/:id/comments`) do **NOT exist**.
> Comments are available **only** via `/tg/items/:id/comments` (Telegram auth required).
> The `comment` field in `/public/items/:id/reserve` and `/public/items/:id/purchase` is stored in
> `ReservationEvent.comment` (a one-time display name), NOT in the Comments table.

---

## ADMIN ENDPOINTS

### Admin Auth: Two-Layer Security `VERIFIED_FROM_CODE`

```
Browser ──[HTTP Basic Auth]──→ Next.js middleware (/admin/*)
   │                              validates ADMIN_BASIC_USER + ADMIN_BASIC_PASS
   │
   └──[fetch /api/admin/*]──→ Next.js API Routes (apps/web/app/api/admin/)
                                 │
                                 └──[X-ADMIN-KEY header]──→ Express backend (privateRouter)
                                                              validates via requireAdmin()
                                                              secureCompare(header, env.ADMIN_KEY)
```

- **Layer 1**: HTTP Basic Auth protects Next.js `/admin/*` pages (middleware.ts)
- **Layer 2**: `X-ADMIN-KEY` header protects Express backend routes (api-proxy.ts adds it server-side)
- **ADMIN_KEY never reaches browser** — injected by Next.js server in api-proxy.ts
- **admin-api-client.ts** calls `/api/admin/*` (Next.js API routes), NOT backend directly

### Path Transformation (Next.js proxy → Express) `VERIFIED_FROM_CODE`

| Browser calls | Next.js proxies to Express |
|---------------|--------------------------|
| `GET /api/admin/wishlists` | `GET /wishlists` |
| `POST /api/admin/wishlists` | `POST /wishlists` |
| `GET /api/admin/wishlists/{id}` | `GET /public/wishlists/{id}` ← uses public endpoint |
| `PATCH /api/admin/wishlists/{id}` | `PATCH /wishlists/{id}` |
| `DELETE /api/admin/wishlists/{id}` | `DELETE /wishlists/{id}` |
| `GET /api/admin/wishlists/{id}/items` | `GET /public/wishlists/{id}/items` ← uses public endpoint |
| `POST /api/admin/wishlists/{id}/items` | `POST /wishlists/{id}/items` |
| `PATCH /api/admin/items/{id}` | `PATCH /items/{id}` |
| `DELETE /api/admin/items/{id}` | `DELETE /items/{id}` |
| `POST /api/admin/wishlists/{id}/tags` | `POST /wishlists/{id}/tags` |
| `DELETE /api/admin/tags/{id}` | `DELETE /tags/{id}` |

### Express Backend Routes (privateRouter, requires X-ADMIN-KEY)

### POST /wishlists
- **Purpose**: Create wishlist (admin)
- **Body**: `{ "title": "1-200 chars", "description?": "max 2000" }`
- **Response 201**: `{ "wishlist": {...} }`

### PATCH /wishlists/:id
- **Purpose**: Update wishlist (admin)
- **Body**: `{ "title?": "1-200", "description?": "max 2000 | null" }`
- **Response 200**: `{ "wishlist": {...} }`

### DELETE /wishlists/:id
- **Purpose**: Delete wishlist with all items, tags, comments (CASCADE)
- **Response 200**: `{ "ok": true }`

### POST /wishlists/:id/items
- **Purpose**: Create item (admin)
- **Body**:
```json
{
  "title": "1-200 (required)",
  "url": "URL string (required)",
  "priceText?": "max 200",
  "commentOwner?": "max 2000",
  "priority?": "LOW|MEDIUM|HIGH",
  "deadline?": "ISO8601",
  "imageUrl?": "URL string"
}
```
- **Response 201**: `{ "item": {...} }`

### PATCH /items/:id
- **Purpose**: Update item (admin)
- **Body**: All fields optional: title, url, priceText, commentOwner, priority, deadline, imageUrl, status
- **Response 200**: `{ "item": {...} }`

### DELETE /items/:id
- **Purpose**: Hard-delete item
- **Response 200**: `{ "ok": true }`

### POST /items/:itemId/tags/:tagId
- **Purpose**: Assign tag to item
- **Response 201**: `{ "ok": true }`
- **Errors**: 404, 422 (different wishlists), 409 (already assigned)

### DELETE /items/:itemId/tags/:tagId
- **Purpose**: Remove tag from item
- **Response 200**: `{ "ok": true }`

### POST /wishlists/:id/tags
- **Purpose**: Create tag
- **Body**: `{ "name": "1-64 chars" }`
- **Response 201**: `{ "tag": {...} }`

### PATCH /tags/:id
- **Purpose**: Update tag
- **Body**: `{ "name": "1-64 chars" }`
- **Response 200**: `{ "tag": {...} }`

### DELETE /tags/:id
- **Response 200**: `{ "ok": true }`

---

## TELEGRAM MINI APP ENDPOINTS (prefix: `/tg`, requires X-TG-INIT-DATA)

### GET /tg/wishlists
- **Purpose**: List owner's wishlists
- **Response 200**:
```json
{
  "wishlists": [{
    "id": "cuid",
    "slug": "string",
    "title": "string",
    "description": "string|null",
    "deadline": "ISO8601|null",
    "itemCount": 5,
    "reservedCount": 2
  }],
  "plan": { "wishlists": 2, "items": 10 },
  "reservationsCount": 3
}
```
- **Note**: `reservationsCount` = count of items where `reserverUserId` = current user and `status` = RESERVED (across all wishlists)

### POST /tg/wishlists
- **Purpose**: Create wishlist
- **Body**: `{ "title": "1-200", "deadline?": "ISO8601|null" }`
- **Response 201**: `{ "wishlist": {..., itemCount: 0, reservedCount: 0} }`
- **Error 402**: Plan limit reached (2 wishlists)

### PATCH /tg/wishlists/:id
- **Purpose**: Update wishlist (owner only)
- **Body**: `{ "title?": "1-200", "deadline?": "ISO8601|null" }`
- **Response 200**: `{ "wishlist": {...} }`
- **Error 403**: Not owner

### DELETE /tg/wishlists/:id
- **Purpose**: Delete wishlist (owner only, CASCADE)
- **Response 200**: `{ "ok": true }`

### POST /tg/wishlists/:id/share-token
- **Purpose**: Get or create share token
- **Response 200**: `{ "shareToken": "12-char-token" }`

### GET /tg/wishlists/:id/items
- **Purpose**: List active items (owner only)
- **Response 200**: `{ "items": [mapTgItem] }`
- **mapTgItem shape**: `{ id, wishlistId, title, url, price, imageUrl, priority (1|2|3), status (lowercase), description }`

### POST /tg/wishlists/:id/items
- **Purpose**: Create item (owner only)
- **Body**: `{ "title": "1-200", "url?": "URL", "price?": "int>=0|null", "priority?": "1|2|3", "imageUrl?": "URL" }`
- **Response 201**: `{ "item": mapTgItem }`
- **Error 402**: Plan limit (10 items)

### PATCH /tg/items/:id
- **Purpose**: Update item (owner only)
- **Body**: `{ "title?", "url?", "price?", "priority?", "imageUrl?", "description?": "max 500 | null" }`
- **Response 200**: `{ "item": mapTgItem }`
- **Side effect**: If description changed & item reserved -> creates SYSTEM comment + notifies reserver

### DELETE /tg/items/:id
- **Purpose**: Soft-delete item (status -> DELETED)
- **Side effect**: If item was RESERVED with a `reserverUserId`, sends notification to reserver
- **Response 200**: `{ "ok": true }`

### POST /tg/items/:id/complete
- **Purpose**: Mark as received (status -> COMPLETED)
- **Side effects**: Sets 30-day TTL on all comments; if item was RESERVED with a `reserverUserId`, sends notification to reserver
- **Response 200**: `{ "item": mapTgItem }`

### POST /tg/items/:id/restore
- **Purpose**: Restore from archive (DELETED/COMPLETED -> AVAILABLE)
- **Response 200**: `{ "item": mapTgItem }`

### GET /tg/wishlists/:id/archive
- **Purpose**: List archived items (DELETED + COMPLETED)
- **Response 200**: `{ "items": [mapTgItem] }`

### POST /tg/items/:id/reserve
- **Purpose**: Guest reserves item via Telegram auth
- **Body**: `{ "displayName?": "1-64 chars" }`
- **Side effects**: Creates ReservationEvent, SYSTEM comment, notifies owner
- **Response 200**: `{ "ok": true }`

### POST /tg/items/:id/unreserve
- **Purpose**: Guest unreserves their own reservation
- **Side effects**: Creates ReservationEvent, SYSTEM comment, sets 30-day TTL on comments
- **Response 200**: `{ "ok": true }`

### GET /tg/items/:id/comments
- **Purpose**: Get comments (owner/reserver only)
- **Response 200**: `{ "comments": [...], "role": "owner|reserver" }`
- **Note**: Previous epoch comments anonymized for reserver

### POST /tg/items/:id/comments
- **Purpose**: Create comment (owner/reserver only)
- **Body**: `{ "text": "1-300 chars" }`
- **Anti-spam**: 10s cooldown, dedup, 3 consecutive limit, 10/hr, 20/30days
- **Response 201**: `{ "comment": {...} }`
- **Errors**: 400 (empty/spam), 429 (rate limited), 403 (not owner/reserver)

### DELETE /tg/items/:id/comments/:commentId
- **Purpose**: Delete comment
- **Rules**: Owner can delete any USER; reserver only own; SYSTEM undeletable
- **Response 200**: `{ "ok": true }`

### POST /tg/items/:id/photo
- **Purpose**: Upload/replace item photo (multipart/form-data)
- **Field name**: `photo`
- **Limits**: 30MB, JPEG/PNG/WebP/GIF only
- **Processing**: Sharp resize (1600px full + 480px thumb), JPEG q80/q70, EXIF stripped
- **Response 200**:
```json
{
  "photoUrl": "/api/uploads/uuid-full.jpg",
  "thumbUrl": "/api/uploads/uuid-thumb.jpg",
  "width": 1200,
  "height": 800,
  "sizeBytes": 245000
}
```

### DELETE /tg/items/:id/photo
- **Purpose**: Remove item photo
- **Side effect**: Deletes file from disk + thumbnail
- **Response 200**: `{ "ok": true }`

### GET /tg/reservations
- **Purpose**: List items reserved by the authenticated Telegram user
- **Auth**: X-TG-INIT-DATA
- **Filter**: `status` = RESERVED, `reserverUserId` = current user
- **Response 200**:
```json
{
  "reservations": [{
    "id": "cuid",
    "title": "string",
    "url": "string",
    "price": "int|null",
    "imageUrl": "string|null",
    "priority": "1|2|3",
    "status": "reserved",
    "description": "string|null",
    "ownerName": "string|null",
    "ownerId": "cuid",
    "unreadComments": 0
  }]
}
```
- **Note**: `ownerName` comes from the owner User's `firstName`. `unreadComments` is the count of comments created after the user's `CommentReadCursor.lastReadAt` for that item (0 if no cursor exists yet).
- **Not a Pro feature** — available to all users

### POST /tg/items/:id/comments/mark-read
- **Purpose**: Mark comments as read for the current user on a specific item
- **Auth**: X-TG-INIT-DATA
- **Side effect**: Upserts `CommentReadCursor` for (userId, itemId) with `lastReadAt` = now
- **Response 200**: `{ "ok": true }`

---

---

## ITEM STATUS STATE MACHINE `VERIFIED_FROM_CODE`

### Statuses (Prisma enum)
`AVAILABLE` | `RESERVED` | `PURCHASED` | `COMPLETED` | `DELETED`

### All Transitions

```
                   ┌──────────────────────────────────────────────────┐
                   │                                                  │
                   ▼                                                  │
             ╔═══════════╗                                            │
     ┌──────►║ AVAILABLE ║◄──────────────────────────────────┐       │
     │       ╚═════╤═════╝                                    │       │
     │             │                                          │       │
     │    TG reserve          Public reserve                  │       │
     │    epoch++             epoch unchanged                 │       │
     │             │                                          │       │
     │             ▼                                          │       │
     │       ╔══════════╗     Public purchase          ┌─────┴─────┐ │
     │       ║ RESERVED ║ ──────────────────────────►  │ PURCHASED │ │
     │       ╚════╤═════╝     (from any non-PURCHASED) └───────────┘ │
     │            │                                                   │
     │   TG/Public unreserve                                         │
     │   reserverUserId=null                                         │
     │            │                                                   │
     │            └──────────────► AVAILABLE                          │
     │                                                                │
     │   TG complete (owner)        TG delete (owner)                │
     │   ────────────────►          ────────────────►                │
     │                                                                │
     │       ╔═══════════╗          ╔═════════╗                      │
     │       ║ COMPLETED ║          ║ DELETED ║                      │
     │       ╚═════╤═════╝          ╚════╤════╝                      │
     │             │                      │                           │
     │             └──── TG restore ──────┘                           │
     │                   (owner only)                                 │
     └────────────────────────────────────────────────────────────────┘
```

### Transition Details

| From → To | Endpoint | Who | reserverUserId | reservationEpoch | Comments Effect | Notifications |
|-----------|----------|-----|----------------|-----------------|-----------------|---------------|
| AVAILABLE → RESERVED | `POST /tg/items/:id/reserve` | TG guest | SET to user ID | **+1** (incremented) | System "Подарок забронирован"; TTL cleared on old comments | Owner notified |
| AVAILABLE → RESERVED | `POST /public/items/:id/reserve` | Anonymous | unchanged | unchanged | None | None |
| RESERVED → AVAILABLE | `POST /tg/items/:id/unreserve` | TG reserver | SET to null | unchanged | System "Бронь отменена"; 30d TTL on all user comments | None |
| RESERVED → AVAILABLE | `POST /public/items/:id/unreserve` | Anonymous (same actorHash) | unchanged | unchanged | None | None |
| any → PURCHASED | `POST /public/items/:id/purchase` | Anonymous | unchanged | unchanged | None | None |
| any → COMPLETED | `POST /tg/items/:id/complete` | Owner only | unchanged | unchanged | 30d TTL on all comments | Reserver notified (if exists) |
| any → DELETED | `DELETE /tg/items/:id` | Owner only | unchanged | unchanged | None | Reserver notified (if exists) |
| DELETED/COMPLETED → AVAILABLE | `POST /tg/items/:id/restore` | Owner only | unchanged | unchanged | None | None |
| any → any | `PATCH /items/:id` (admin) | Admin | unchanged | unchanged | None | None |

### Key Rules
- **reservationEpoch incremented ONLY by TG reserve** (not public reserve) `VERIFIED_FROM_CODE`
- **reserverUserId set ONLY by TG reserve**, cleared ONLY by TG unreserve
- Public reserve/unreserve do NOT touch reserverUserId or epoch
- Comment TTL (30 days) set on: TG unreserve, TG complete
- Comment TTL cleared on: TG reserve (new reservation clears old TTLs)
- New reserver sees only current-epoch comments; older epoch comments anonymized

---

## Error Responses

| Status | Meaning |
|--------|---------|
| 400 | Validation error / bad input |
| 401 | Unauthorized (invalid auth) |
| 402 | Plan limit reached |
| 403 | Forbidden (not owner/reserver) |
| 404 | Resource not found |
| 409 | Conflict (item not in expected status) |
| 413 | File too large (>30MB) |
| 415 | Unsupported file type |
| 429 | Rate limited |
| 500 | Internal server error |

Common error shape: `{ "error": "string message" }`
Validation error shape: `{ "error": "Validation error", "issues": [...] }`

---

## Static File Serving

### GET /uploads/:filename
- **Purpose**: Serve uploaded images
- **Auth**: None (public)
- **Cache**: `max-age: 30d, immutable`
- **Served by**: `express.static(UPLOAD_DIR)`
- **Production path**: `https://wishlistik.ru/api/uploads/filename.jpg`
