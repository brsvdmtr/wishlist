# DATA_MODEL.md - Database Schema & Entity Reference

## Database: PostgreSQL 16 via Prisma ORM 5.18.0

Schema file: `packages/db/prisma/schema.prisma`

---

## Enums

### Priority
| Value | Business Meaning |
|-------|-----------------|
| LOW | "Неплохо" (Nice to have) - priority rank 1 |
| MEDIUM | "Хочу" (Want) - priority rank 2, DEFAULT |
| HIGH | "Мечтаю" (Dream) - priority rank 3 |

### ItemStatus
| Value | Business Meaning |
|-------|-----------------|
| AVAILABLE | Item can be reserved by guests. DEFAULT |
| RESERVED | Item reserved by a guest (anonymous to owner) |
| PURCHASED | Item marked as purchased by guest |
| COMPLETED | Item marked as received by owner (archived) |
| DELETED | Soft-deleted by owner (archived) |

### ReservationType
| Value | Business Meaning |
|-------|-----------------|
| RESERVED | Guest reserved the item |
| UNRESERVED | Guest cancelled their reservation |
| PURCHASED | Guest marked item as purchased |

### CommentType
| Value | Business Meaning |
|-------|-----------------|
| USER | Comment written by a person (owner or reserver) |
| SYSTEM | Auto-generated event message (e.g., "Подарок забронирован") |

---

## Entities

### User
**Business**: Represents any user of the system (wishlist owner, Telegram user, or admin system user)

| Field | Type | Required | Default | Business Meaning |
|-------|------|----------|---------|-----------------|
| id | String (CUID) | Yes | auto | Primary key |
| email | String? | No | null | Email (used for admin/system user, unique) |
| telegramId | String? | No | null | Telegram user ID (unique) |
| firstName | String? | No | null | Telegram first name (from `tg.first_name`, updated on each auth) |
| telegramChatId | String? | No | null | Telegram chat ID for sending notifications |
| createdAt | DateTime | Yes | now() | Registration timestamp |
| updatedAt | DateTime | Yes | auto | Last update timestamp |

**Relations**:
- User -> Wishlist[] (one-to-many via ownerId)
- User -> CommentReadCursor[] (one-to-many via userId)

**Indexes**: `email` (unique), `telegramId` (unique)

**Used in code**:
- `getOrCreateTgUser()` - upserts by telegramId, stores `firstName` from `tg.first_name`
- `getSystemUser()` - upserts by email (SYSTEM_USER_EMAIL)
- Bot `/start` handler - stores telegramChatId for notifications

---

### Wishlist
**Business**: A collection of desired items belonging to one user

| Field | Type | Required | Default | Business Meaning |
|-------|------|----------|---------|-----------------|
| id | String (CUID) | Yes | auto | Primary key |
| slug | String | Yes | generated | URL-safe identifier (unique). Used in public URLs `/w/:slug` |
| shareToken | String? | No | null | Short token for sharing via deep links (unique) |
| ownerId | String | Yes | - | Foreign key to User.id |
| title | String | Yes | - | Display name (max 200 chars in API, 80 in rename UI) |
| description | String? | No | null | Optional description (max 2000 in admin, unused in Mini App) |
| deadline | DateTime? | No | null | Optional deadline date |
| createdAt | DateTime | Yes | now() | Creation timestamp |
| updatedAt | DateTime | Yes | auto | Last update timestamp |

**Relations**:
- Wishlist -> User (owner, many-to-one, CASCADE delete)
- Wishlist -> Item[] (one-to-many)
- Wishlist -> Tag[] (one-to-many)

**Indexes**: `slug` (unique), `shareToken` (unique), `ownerId` (index)

**Key behaviors**:
- Slug generated once at creation, never changes (safe for deep links)
- shareToken generated on first share request, then reused
- Plan limit: 2 wishlists per user (FREE plan)

---

### Item
**Business**: A single wish/desired item within a wishlist

| Field | Type | Required | Default | Business Meaning |
|-------|------|----------|---------|-----------------|
| id | String (CUID) | Yes | auto | Primary key |
| wishlistId | String | Yes | - | FK to Wishlist.id |
| title | String | Yes | - | Item name (max 200 chars) |
| url | String | Yes | '' | Link to product (empty string if none) |
| description | String? | No | null | Private description (VarChar 500), visible to owner + reserver |
| priceText | String? | No | null | Price as text (e.g., "5000"). Stored as string, parsed to int on frontend |
| commentOwner | String? | No | null | Owner's private note (admin only, max 2000) |
| priority | Priority | Yes | MEDIUM | Importance level |
| deadline | DateTime? | No | null | Item-specific deadline (unused in Mini App UI) |
| imageUrl | String? | No | null | Path to uploaded image (e.g., `/api/uploads/uuid-full.jpg`) |
| status | ItemStatus | Yes | AVAILABLE | Current lifecycle status |
| reservationEpoch | Int | Yes | 0 | Counter incremented on each reserve cycle. Links comments to reservation |
| reserverUserId | String? | No | null | FK to User.id of current reserver (set on reserve, cleared on unreserve) |
| createdAt | DateTime | Yes | now() | Creation timestamp |
| updatedAt | DateTime | Yes | auto | Last update timestamp |

**Relations**:
- Item -> Wishlist (many-to-one, CASCADE delete)
- Item -> ItemTag[] (one-to-many)
- Item -> ReservationEvent[] (one-to-many)
- Item -> Comment[] (one-to-many)
- Item -> CommentReadCursor[] (one-to-many)

**Indexes**: `wishlistId` (index)

**Key behaviors**:
- Soft-delete: status set to DELETED (not removed from DB)
- reservationEpoch isolates comments per reservation cycle
- imageUrl stores relative path to API uploads directory
- Plan limit: 10 items per wishlist (FREE plan)
- Sort order: priority DESC, updatedAt DESC, createdAt DESC, id DESC

---

### Tag
**Business**: Category/label for organizing items within a wishlist

| Field | Type | Required | Default | Business Meaning |
|-------|------|----------|---------|-----------------|
| id | String (CUID) | Yes | auto | Primary key |
| wishlistId | String | Yes | - | FK to Wishlist.id |
| name | String | Yes | - | Tag display name (max 64 chars) |
| createdAt | DateTime | Yes | now() | Creation timestamp |

**Relations**:
- Tag -> Wishlist (many-to-one, CASCADE delete)
- Tag -> ItemTag[] (one-to-many)

**Indexes**: `wishlistId` (index)

**Note**: Tags are created/managed only via admin panel. Not exposed in Mini App UI currently.

---

### ItemTag
**Business**: Many-to-many join table between Item and Tag

| Field | Type | Required | Business Meaning |
|-------|------|----------|-----------------|
| itemId | String | Yes | FK to Item.id |
| tagId | String | Yes | FK to Tag.id |

**Composite PK**: `(itemId, tagId)`
**CASCADE delete** on both sides

---

### ReservationEvent
**Business**: Audit log of reservation lifecycle events

| Field | Type | Required | Default | Business Meaning |
|-------|------|----------|---------|-----------------|
| id | String (CUID) | Yes | auto | Primary key |
| itemId | String | Yes | - | FK to Item.id |
| type | ReservationType | Yes | - | Event type (RESERVED/UNRESERVED/PURCHASED) |
| actorHash | String | Yes | - | SHA-256 hash of actor's Telegram ID (UUID format) |
| comment | String? | No | null | **Display name** chosen by reserver (stored on RESERVED events) |
| createdAt | DateTime | Yes | now() | Event timestamp |

**Relations**: ReservationEvent -> Item (many-to-one, CASCADE delete)

**Indexes**: `itemId` (index)

**Key behaviors**:
- `comment` field on RESERVED events stores the guest's chosen display name
- Used in notifications: "Жопа забронировал желание «cat!!!!»"
- actorHash enables anonymous identity matching without exposing Telegram ID

---

### Comment
**Business**: Messages exchanged between wishlist owner and item reserver

| Field | Type | Required | Default | Business Meaning |
|-------|------|----------|---------|-----------------|
| id | String (CUID) | Yes | auto | Primary key |
| itemId | String | Yes | - | FK to Item.id |
| type | CommentType | Yes | USER | USER = human message, SYSTEM = auto-generated |
| authorActorHash | String? | No | null | SHA-256 hash of author's Telegram ID (null for SYSTEM) |
| authorDisplayName | String? | No | null | Display name at time of comment |
| text | String | Yes | - | Comment text (VarChar 300) |
| reservationEpoch | Int | Yes | 0 | Links comment to specific reservation cycle |
| scheduledDeleteAt | DateTime? | No | null | TTL: auto-delete after this timestamp |
| createdAt | DateTime | Yes | now() | Creation timestamp |

**Relations**: Comment -> Item (many-to-one, CASCADE delete)

**Indexes**: `(itemId, createdAt)` compound, `scheduledDeleteAt` (for TTL cleanup)

**Key behaviors**:
- SYSTEM comments created on reserve/unreserve events
- TTL set to 30 days when item is COMPLETED or UNRESERVED
- Previous epoch comments anonymized for new reserver
- Hourly cleanup job deletes expired comments
- Anti-spam: 10s cooldown, dedup, 3 consecutive limit, 10/hour, 20/month

---

### CommentReadCursor
**Business**: Tracks when a user last read comments on a specific item, used to compute unread comment counts for the "My Reservations" feature

| Field | Type | Required | Default | Business Meaning |
|-------|------|----------|---------|-----------------|
| userId | String | Yes | - | FK to User.id |
| itemId | String | Yes | - | FK to Item.id |
| lastReadAt | DateTime | Yes | now() | Timestamp of last read; comments after this are "unread" |

**Composite PK**: `(userId, itemId)`

**Relations**:
- CommentReadCursor -> User (many-to-one, CASCADE delete)
- CommentReadCursor -> Item (many-to-one, CASCADE delete)

**Key behaviors**:
- Upserted via `POST /tg/items/:id/comments/mark-read` on each item view from reservations
- Used by `GET /tg/reservations` to compute `unreadComments` per item
- If no cursor exists for a user+item pair, all comments are considered unread

---

## Migrations History

| # | Migration Name | Changes |
|---|---------------|---------|
| 1 | `20260210151944_init` | Initial schema: User, Wishlist, Item, Tag, ItemTag, ReservationEvent |
| 2 | `20260301000000_add_completed_deleted_statuses` | Added COMPLETED and DELETED to ItemStatus enum |
| 3 | `20260302000000_add_wishlist_deadline_and_item_statuses` | Added deadline column to Wishlist |
| 4 | `20260303000000_add_wishlist_share_token` | Added shareToken unique column to Wishlist |
| 5 | `20260310000000_add_comments_and_description` | Added Comment table, telegramChatId to User, description/reservationEpoch/reserverUserId to Item |

---

## Entity Relationship Diagram (ASCII)

```
User 1---* Wishlist 1---* Item 1---* ReservationEvent
  |                 |           |---* Comment
  |                 |           |---* ItemTag *---1 Tag
  |                 |           |---* CommentReadCursor
  |                 +---* Tag
  |
  +---* CommentReadCursor (composite PK: userId + itemId)
```

---

## Seed Data

Script: `apps/api/src/seed.ts`

Creates:
- System user (email from SYSTEM_USER_EMAIL env)
- Demo wishlist (slug: "demo", title: "Демо-вишлист")
- 3 tags: вкусняхи, техника, дорого
- 5 items with varying priorities and prices
