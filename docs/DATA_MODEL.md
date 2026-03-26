# Data Model — Wishlist Telegram Mini App

_Last updated: 2026-03-26_

---

## Table of Contents

1. [Enums](#enums)
2. [Models](#models)
3. [Entity Relationship Overview](#entity-relationship-overview)
4. [Indexes](#indexes)
5. [Key Behaviors and Constraints](#key-behaviors-and-constraints)

---

## Enums

### `Priority`
Item importance level, used for display ordering within a wishlist.

| Value    | Meaning                        |
|----------|--------------------------------|
| `LOW`    | Nice to have                   |
| `MEDIUM` | Default priority               |
| `HIGH`   | Most wanted, shown first       |

### `ItemStatus`
Lifecycle state of a wish item.

| Value       | Meaning                                                                 |
|-------------|-------------------------------------------------------------------------|
| `AVAILABLE` | Default. Visible and can be reserved                                    |
| `RESERVED`  | Someone has reserved this item                                          |
| `PURCHASED` | Reserver has marked it as purchased                                     |
| `COMPLETED` | Owner has confirmed receipt (retired state, rarely used)                |
| `DELETED`   | Soft-deleted. `purgeAfter` set to 90 days from deletion. Excluded from all normal queries |

### `ReservationType`
Action recorded in the immutable reservation audit log.

| Value        | Meaning                                      |
|--------------|----------------------------------------------|
| `RESERVED`   | Someone claimed this item                    |
| `UNRESERVED` | Claim was released                           |
| `PURCHASED`  | Reserver confirmed the purchase              |

### `CommentType`
Origin of a comment message.

| Value    | Meaning                                                  |
|----------|----------------------------------------------------------|
| `USER`   | Written by a human (owner or reserver)                   |
| `SYSTEM` | Auto-generated (e.g., reservation event notification)    |

### `WishlistType`
Category of wishlist, controls special behavior.

| Value           | Meaning                                                                         |
|-----------------|---------------------------------------------------------------------------------|
| `REGULAR`       | Normal user-created wishlist                                                    |
| `SYSTEM_DRAFTS` | Special "Неразобранное" bucket. One per user. Holds URL-imported items pending review. FREE plan limited to 50 items here. |

### `SubscriptionStatus`
Billing state of a PRO subscription.

| Value       | Meaning                                                          |
|-------------|------------------------------------------------------------------|
| `ACTIVE`    | PRO features are currently accessible                            |
| `CANCELLED` | User cancelled; access continues until `currentPeriodEnd`        |
| `EXPIRED`   | Period ended; PRO features revoked                               |

### `HintStatus`
Delivery state of a hint sent to a friend.

| Value       | Meaning                                                 |
|-------------|---------------------------------------------------------|
| `SENT`      | Hint dispatched, delivery unconfirmed                   |
| `DELIVERED` | Telegram confirmed delivery to recipient                |
| `CANCELLED` | Owner cancelled the hint before delivery                |
| `EXPIRED`   | 30-day TTL elapsed without delivery                     |

### `Currency`
Supported currencies for item prices.

| Value | Meaning          |
|-------|------------------|
| `RUB` | Russian Ruble (default) |
| `USD` | US Dollar        |

### `ProfileVisibility`
Controls who can see a user's public profile page.

| Value         | Meaning                                                              |
|---------------|----------------------------------------------------------------------|
| `ALL`         | Anyone can view (default)                                            |
| `LINK_ONLY`   | Only people with a direct link can view                              |
| `SUBSCRIBERS` | Only users subscribed to at least one of the owner's wishlists (schema-only; UI not fully implemented) |
| `NOBODY`      | Profile is fully hidden                                              |

### `SubscribePolicy`
Controls who can subscribe to the user's wishlists.

| Value      | Meaning                                                                       |
|------------|-------------------------------------------------------------------------------|
| `ALL`      | Anyone can subscribe (default)                                                |
| `LINK_ONLY`| Only people who have the wishlist link (schema-only; not yet enforced in API) |
| `APPROVED` | Requires owner approval (schema-only; not yet enforced in API)                |
| `NOBODY`   | No new subscribers allowed                                                    |

### `WishlistVisibility`
Controls who can access a specific wishlist.

| Value            | Meaning                                                                                  |
|------------------|------------------------------------------------------------------------------------------|
| `LINK_ONLY`      | Default. Accessible only via direct share link or `shareToken`                           |
| `PUBLIC_PROFILE` | PRO feature. Listed on the owner's public profile page                                   |
| `PRIVATE`        | PRO feature. Hidden from new visitors; existing subscribers retain read access           |

### `AllowSubscriptions`
Controls whether a wishlist accepts new subscribers.

| Value    | Meaning                               |
|----------|---------------------------------------|
| `ALL`    | Anyone can subscribe (default)        |
| `NOBODY` | New subscriptions blocked             |

### `CommentPolicy`
Controls who can post comments on items in a wishlist.

| Value         | Meaning                                                       |
|---------------|---------------------------------------------------------------|
| `ALL`         | Anyone with item access can comment (default)                 |
| `SUBSCRIBERS` | Only wishlist subscribers can comment                         |

### `SupportTicketStatus`
State machine for customer support tickets.

| Value             | Meaning                                          |
|-------------------|--------------------------------------------------|
| `OPEN`            | New ticket, awaiting support staff response      |
| `WAITING_SUPPORT` | User replied; support needs to respond           |
| `WAITING_USER`    | Support replied; waiting for user                |
| `CLOSED`          | Ticket resolved                                  |

### `SupportMessageAuthorRole`
Who authored a support message.

| Value     | Meaning                                          |
|-----------|--------------------------------------------------|
| `USER`    | Message from the end user                        |
| `SUPPORT` | Message from a support staff member              |
| `SYSTEM`  | Auto-generated system message (e.g., ticket opened) |

### `SupportMessageKind`
Media type of a support message.

| Value      | Meaning                          |
|------------|----------------------------------|
| `TEXT`     | Plain text message (default)     |
| `PHOTO`    | Image attachment                 |
| `VIDEO`    | Video attachment                 |
| `DOCUMENT` | File attachment                  |
| `OTHER`    | Unsupported or unknown media type|

---

## Models

### `User`
A registered user, identified primarily by their Telegram account.

| Field            | Type      | Required | Default | Notes                                                              |
|------------------|-----------|----------|---------|--------------------------------------------------------------------|
| `id`             | String    | Yes      | cuid    | Internal primary key                                               |
| `email`          | String    | No       | —       | Optional; not used by Mini App                                     |
| `telegramId`     | String    | No       | —       | Telegram user ID (unique). Primary identity in the Mini App        |
| `telegramChatId` | String    | No       | —       | Telegram private chat ID for bot DMs                               |
| `firstName`      | String    | No       | —       | Telegram first name snapshot at last login                         |
| `godMode`        | Boolean   | Yes      | `false` | When `true`, grants PRO features without an active subscription    |
| `createdAt`      | DateTime  | Yes      | now     |                                                                    |
| `updatedAt`      | DateTime  | Yes      | auto    |                                                                    |

**Relations:**
- `wishlists[]` → `Wishlist` (owned wishlists)
- `subscriptions[]` → `Subscription` (billing records)
- `paymentEvents[]` → `PaymentEvent`
- `commentReadCursors[]` → `CommentReadCursor`
- `hints[]` → `Hint` (hints sent by this user)
- `profile` → `UserProfile` (nullable, created lazily)
- `wishlistSubscriptions[]` → `WishlistSubscription` (wishlists this user follows)
- `supportTickets[]` → `SupportTicket`

---

### `UserProfile`
Extended preferences and privacy settings for a user. Created lazily on the first call to `PATCH /tg/me/profile`.

| Field                  | Type               | Required | Default      | Notes                                                                 |
|------------------------|--------------------|----------|--------------|-----------------------------------------------------------------------|
| `id`                   | String             | Yes      | cuid         |                                                                       |
| `userId`               | String             | Yes      | —            | Unique FK → `User`. One profile per user                              |
| `displayName`          | String             | No       | —            | User-chosen display name                                              |
| `username`             | String             | No       | —            | Unique handle for public profile URL (e.g. `@alice`)                  |
| `bio`                  | VarChar(300)       | No       | —            | Short biography                                                       |
| `avatarUrl`            | String             | No       | —            | URL to profile picture                                                |
| `birthday`             | DateTime           | No       | —            | Date of birth                                                         |
| `hideYear`             | Boolean            | Yes      | `false`      | When `true`, birth year is hidden from public profile                 |
| `defaultCurrency`      | `Currency`         | Yes      | `RUB`        | Used as default currency when creating new items                      |
| `notifyComments`       | Boolean            | Yes      | `true`       | Receive Telegram notifications for new comments                       |
| `notifyReservations`   | Boolean            | Yes      | `true`       | Receive Telegram notifications when items are reserved/purchased      |
| `notifySubscriptions`  | Boolean            | Yes      | `true`       | Receive Telegram notifications when someone subscribes to a wishlist  |
| `notifyMarketing`      | Boolean            | Yes      | `false`      | Receive promotional messages from the bot                             |
| `profileVisibility`    | `ProfileVisibility`| Yes      | `ALL`        | Who can view the user's public profile page                           |
| `subscribePolicy`      | `SubscribePolicy`  | Yes      | `ALL`        | Who can subscribe to the user's wishlists (partially enforced)        |
| `commentsEnabled`      | Boolean            | Yes      | `true`       | User preference; PRO feature gate applies regardless                  |
| `hintsEnabled`         | Boolean            | Yes      | `true`       | User preference; PRO feature gate applies regardless                  |
| `newWishlistPosition`  | String             | Yes      | `"top"`      | Whether new wishlists are inserted at the top or bottom of the list   |
| `createdAt`            | DateTime           | Yes      | now          |                                                                       |
| `updatedAt`            | DateTime           | Yes      | auto         |                                                                       |

---

### `Wishlist`
An ordered collection of wish items owned by a user.

| Field                | Type                  | Required | Default      | Notes                                                                          |
|----------------------|-----------------------|----------|--------------|--------------------------------------------------------------------------------|
| `id`                 | String                | Yes      | cuid         |                                                                                |
| `slug`               | String                | Yes      | —            | Unique, URL-safe identifier. Generated once at creation from title + random suffix; never updated |
| `shareToken`         | String                | No       | —            | Unique random token for share links (distinct from slug)                       |
| `ownerId`            | String                | Yes      | —            | FK → `User`                                                                    |
| `title`              | String                | Yes      | —            |                                                                                |
| `description`        | String                | No       | —            |                                                                                |
| `deadline`           | DateTime              | No       | —            | Optional date the wishlist is relevant until (e.g. birthday)                  |
| `archivedAt`         | DateTime              | No       | —            | Set when the wishlist is archived; `null` means active                         |
| `position`           | Int                   | Yes      | `0`          | Manual sort order within the owner's wishlist list; updated on drag-and-drop   |
| `visibility`         | `WishlistVisibility`  | Yes      | `LINK_ONLY`  | Access control for external viewers                                            |
| `allowSubscriptions` | `AllowSubscriptions`  | Yes      | `ALL`        | Whether new subscribers can follow this wishlist                               |
| `commentPolicy`      | `CommentPolicy`       | Yes      | `ALL`        | Who can post comments on items in this wishlist                                |
| `type`               | `WishlistType`        | Yes      | `REGULAR`    | `SYSTEM_DRAFTS` is auto-created, one per user, for URL imports                 |
| `createdAt`          | DateTime              | Yes      | now          |                                                                                |
| `updatedAt`          | DateTime              | Yes      | auto         |                                                                                |

**Relations:**
- `owner` → `User`
- `items[]` → `Item`
- `tags[]` → `Tag`
- `wishlistSubscriptions[]` → `WishlistSubscription`

---

### `Item`
A single wish within a wishlist.

| Field             | Type           | Required | Default     | Notes                                                                                     |
|-------------------|----------------|----------|-------------|-------------------------------------------------------------------------------------------|
| `id`              | String         | Yes      | cuid        |                                                                                           |
| `wishlistId`      | String         | Yes      | —           | FK → `Wishlist`                                                                           |
| `title`           | String         | Yes      | —           |                                                                                           |
| `url`             | String         | Yes      | —           | Required in DB; not validated in API (any string accepted, including empty)               |
| `description`     | VarChar(500)   | No       | —           |                                                                                           |
| `priceText`       | String         | No       | —           | Raw text as entered (e.g. `"2 999 ₽"`); not parsed as a number                           |
| `currency`        | `Currency`     | Yes      | `RUB`       |                                                                                           |
| `commentOwner`    | String         | No       | —           | Owner's private note, visible only to the wishlist owner                                  |
| `priority`        | `Priority`     | Yes      | `MEDIUM`    | Used for display order within the wishlist                                                 |
| `deadline`        | DateTime       | No       | —           | When this item is needed by                                                                |
| `imageUrl`        | String         | No       | —           | Product image                                                                             |
| `sourceUrl`       | String         | No       | —           | Original URL the item was imported from                                                   |
| `sourceDomain`    | String         | No       | —           | Domain extracted from `sourceUrl` (e.g. `"wildberries.ru"`)                               |
| `importMethod`    | String         | No       | —           | How the item was imported (e.g. `"url_parser"`, `"manual"`)                               |
| `status`          | `ItemStatus`   | Yes      | `AVAILABLE` |                                                                                           |
| `reservationEpoch`| Int            | Yes      | `0`         | Increments on each new reservation cycle; used to scope comments to the current reservation |
| `position`        | Int            | Yes      | `0`         | Manual sort order within a priority group                                                  |
| `reserverUserId`  | String         | No       | —           | Telegram user ID (not FK) of the person who reserved this item                            |
| `archivedAt`      | DateTime       | No       | —           | Set when the item is archived                                                              |
| `purgeAfter`      | DateTime       | No       | —           | Set to `now + 90 days` when `status = DELETED`; background job hard-deletes after this date |
| `createdAt`       | DateTime       | Yes      | now         |                                                                                           |
| `updatedAt`       | DateTime       | Yes      | auto        |                                                                                           |

**Relations:**
- `wishlist` → `Wishlist`
- `itemTags[]` → `ItemTag`
- `reservationEvents[]` → `ReservationEvent`
- `comments[]` → `Comment`
- `commentReadCursors[]` → `CommentReadCursor`
- `hints[]` → `Hint`

---

### `Tag`
A label that can be attached to items in a wishlist. Currently used via admin panel only; not exposed in the Mini App UI.

| Field       | Type     | Required | Default | Notes               |
|-------------|----------|----------|---------|---------------------|
| `id`        | String   | Yes      | cuid    |                     |
| `wishlistId`| String   | Yes      | —       | FK → `Wishlist`     |
| `name`      | String   | Yes      | —       |                     |
| `createdAt` | DateTime | Yes      | now     |                     |

---

### `ItemTag`
Join table linking items to tags. Composite primary key.

| Field    | Type   | Required | Notes           |
|----------|--------|----------|-----------------|
| `itemId` | String | Yes      | FK → `Item`     |
| `tagId`  | String | Yes      | FK → `Tag`      |

**Primary key:** `(itemId, tagId)`

---

### `ReservationEvent`
Immutable append-only audit log of all reservation actions on an item. Records are never updated or deleted.

| Field       | Type              | Required | Default | Notes                                                                               |
|-------------|-------------------|----------|---------|-------------------------------------------------------------------------------------|
| `id`        | String            | Yes      | cuid    |                                                                                     |
| `itemId`    | String            | Yes      | —       | FK → `Item`                                                                         |
| `type`      | `ReservationType` | Yes      | —       | The action taken                                                                    |
| `actorHash` | String            | Yes      | —       | SHA-256 of `"tg_actor:{telegramId}"`. Enables consistent anonymous identification across sessions without storing raw Telegram IDs |
| `comment`   | String            | No       | —       | Optional note left by the actor at the time of the action                          |
| `createdAt` | DateTime          | Yes      | now     |                                                                                     |

---

### `Comment`
A private message in the thread between an item's owner and the current reserver. Both parties must have PRO to access (feature gate: `comments`).

| Field               | Type           | Required | Default | Notes                                                                                               |
|---------------------|----------------|----------|---------|-----------------------------------------------------------------------------------------------------|
| `id`                | String         | Yes      | cuid    |                                                                                                     |
| `itemId`            | String         | Yes      | —       | FK → `Item`                                                                                         |
| `type`              | `CommentType`  | Yes      | `USER`  |                                                                                                     |
| `authorActorHash`   | String         | No       | —       | Same SHA-256 scheme as `ReservationEvent.actorHash`; null for `SYSTEM` comments                     |
| `authorDisplayName` | String         | No       | —       | Display name snapshot at time of posting                                                            |
| `text`              | VarChar(300)   | Yes      | —       |                                                                                                     |
| `reservationEpoch`  | Int            | Yes      | `0`     | Must match `Item.reservationEpoch` to be visible; isolates comments per reservation cycle            |
| `scheduledDeleteAt` | DateTime       | No       | —       | Set to `now + 30 days` at creation; background job purges after this date                           |
| `createdAt`         | DateTime       | Yes      | now     |                                                                                                     |

---

### `Subscription`
PRO plan billing record. One per user (unique on `userId + planCode`).

| Field                | Type                 | Required | Default           | Notes                                                                    |
|----------------------|----------------------|----------|-------------------|--------------------------------------------------------------------------|
| `id`                 | String               | Yes      | cuid              |                                                                          |
| `userId`             | String               | Yes      | —                 | FK → `User`                                                              |
| `planCode`           | String               | Yes      | `"PRO"`           | Currently only `"PRO"` exists                                            |
| `status`             | `SubscriptionStatus` | Yes      | `ACTIVE`          |                                                                          |
| `starsPrice`         | Int                  | Yes      | —                 | Price paid in Telegram Stars                                             |
| `telegramChargeId`   | String               | No       | —                 | Telegram's charge identifier                                             |
| `currentPeriodStart` | DateTime             | Yes      | —                 |                                                                          |
| `currentPeriodEnd`   | DateTime             | Yes      | —                 |                                                                          |
| `cancelledAt`        | DateTime             | No       | —                 | Timestamp of cancellation request                                        |
| `source`             | String               | No       | `"telegram_stars"`|                                                                          |
| `billingPeriod`      | String               | No       | `"monthly"`       |                                                                          |
| `cancelAtPeriodEnd`  | Boolean              | Yes      | `false`           | Soft-cancel: PRO access continues until `currentPeriodEnd`, then expires |
| `createdAt`          | DateTime             | Yes      | now               |                                                                          |
| `updatedAt`          | DateTime             | Yes      | auto              |                                                                          |

**Unique constraint:** `(userId, planCode)`

---

### `PaymentEvent`
Immutable payment audit log. One record per Telegram payment event; `telegramPaymentChargeId` is unique to prevent duplicate processing.

| Field                      | Type     | Required | Default | Notes                                              |
|----------------------------|----------|----------|---------|----------------------------------------------------|
| `id`                       | String   | Yes      | cuid    |                                                    |
| `subscriptionId`           | String   | No       | —       | FK → `Subscription` (may be null for failed payments) |
| `userId`                   | String   | Yes      | —       | FK → `User`                                        |
| `telegramPaymentChargeId`  | String   | Yes      | —       | Unique. From Telegram payment API                  |
| `providerPaymentChargeId`  | String   | No       | —       | From payment provider (if applicable)              |
| `invoicePayload`           | String   | Yes      | —       | Original invoice payload sent to Telegram          |
| `totalAmount`              | Int      | Yes      | —       | Amount charged                                     |
| `currency`                 | String   | Yes      | `"XTR"` | Telegram Stars currency code                       |
| `eventType`                | String   | Yes      | —       | e.g. `"successful_payment"`, `"refund"`            |
| `rawPayload`               | Text     | No       | —       | Full raw JSON from Telegram for debugging          |
| `createdAt`                | DateTime | Yes      | now     |                                                    |

---

### `CommentReadCursor`
Tracks the last time a user read comments on a specific item, used to compute unread comment counts. Composite primary key.

| Field        | Type     | Required | Notes               |
|--------------|----------|----------|---------------------|
| `userId`     | String   | Yes      | FK → `User`         |
| `itemId`     | String   | Yes      | FK → `Item`         |
| `lastReadAt` | DateTime | Yes      | Updated on each read|

**Primary key:** `(userId, itemId)`

---

### `Hint`
An owner-sent nudge to a friend suggesting they reserve a specific item. Delivered via Telegram's `users_shared` contact picker. Expires after 30 days.

| Field           | Type         | Required | Default  | Notes                                                        |
|-----------------|--------------|----------|----------|--------------------------------------------------------------|
| `id`            | String       | Yes      | cuid     |                                                              |
| `itemId`        | String       | Yes      | —        | FK → `Item`                                                  |
| `senderUserId`  | String       | Yes      | —        | FK → `User` (the wishlist owner who sent the hint)           |
| `status`        | `HintStatus` | Yes      | `SENT`   |                                                              |
| `createdAt`     | DateTime     | Yes      | now      |                                                              |
| `expiresAt`     | DateTime     | Yes      | —        | Set to `createdAt + 30 days`                                 |
| `sentCount`     | Int          | No       | —        | Number of delivery attempts made                             |
| `pendingCount`  | Int          | No       | —        | Number of deliveries still in flight                         |
| `deliveredAt`   | DateTime     | No       | —        | Timestamp of confirmed delivery                              |

---

### `WishlistSubscription`
A follow relationship: a user subscribing to a wishlist to receive change notifications.

| Field            | Type     | Required | Default | Notes                                       |
|------------------|----------|----------|---------|---------------------------------------------|
| `id`             | String   | Yes      | cuid    |                                             |
| `wishlistId`     | String   | Yes      | —       | FK → `Wishlist`                             |
| `subscriberId`   | String   | Yes      | —       | FK → `User`                                 |
| `createdAt`      | DateTime | Yes      | now     |                                             |
| `lastNotifiedAt` | DateTime | No       | —       | Last time a notification was sent to this subscriber |

**Unique constraint:** `(wishlistId, subscriberId)`

**Relations:**
- `wishlist` → `Wishlist`
- `subscriber` → `User`
- `unreads[]` → `SubscriptionUnread`

---

### `SubscriptionUnread`
An individual unseen change for a wishlist subscriber. Each record represents one change to one entity.

| Field       | Type   | Required | Notes                                                               |
|-------------|--------|----------|---------------------------------------------------------------------|
| `id`        | String | Yes      | cuid                                                                |
| `subId`     | String | Yes      | FK → `WishlistSubscription`                                         |
| `entityId`  | String | Yes      | ID of the changed entity (item ID or wishlist ID)                   |
| `fieldName` | String | Yes      | What changed (e.g. `"title"`, `"status"`, `"new_item"`)             |

**Unique constraint:** `(subId, entityId, fieldName)` — prevents duplicate unread entries for the same change.

---

### `ServiceHeartbeat`
Liveness tracking for background services. Keyed by service name.

| Field         | Type     | Required | Notes                                               |
|---------------|----------|----------|-----------------------------------------------------|
| `serviceName` | String   | Yes      | Primary key. Identifies the service (e.g. `"bot"`)  |
| `updatedAt`   | DateTime | Yes      | Updated on each heartbeat ping                      |
| `metadata`    | JSON     | No       | Optional structured data (e.g. version, queue depth)|

Used by the Telegram bot to report liveness. Checked by the API health endpoint to detect bot outages.

---

### `SupportTicket`
A customer support conversation thread, bridging user Telegram DMs and a staff Telegram group.

| Field           | Type                  | Required | Default | Notes                                                         |
|-----------------|-----------------------|----------|---------|---------------------------------------------------------------|
| `id`            | String                | Yes      | cuid    |                                                               |
| `ticketCode`    | String                | Yes      | —       | Unique human-readable code (e.g. `"SUP-00042"`)               |
| `userId`        | String                | Yes      | —       | FK → `User`                                                   |
| `status`        | `SupportTicketStatus` | Yes      | `OPEN`  |                                                               |
| `openedVia`     | String                | No       | —       | Channel used to open the ticket (e.g. `"bot"`, `"miniapp"`)   |
| `supportChatId` | String                | No       | —       | Telegram group chat ID where staff messages are posted        |
| `closedAt`      | DateTime              | No       | —       |                                                               |
| `createdAt`     | DateTime              | Yes      | now     |                                                               |
| `updatedAt`     | DateTime              | Yes      | auto    |                                                               |

---

### `SupportMessage`
A single message within a support ticket. Mirrors both the user-side DM and the staff-side group message.

| Field                  | Type                       | Required | Default  | Notes                                                     |
|------------------------|----------------------------|----------|----------|-----------------------------------------------------------|
| `id`                   | String                     | Yes      | cuid     |                                                           |
| `ticketId`             | String                     | Yes      | —        | FK → `SupportTicket`                                      |
| `authorRole`           | `SupportMessageAuthorRole` | Yes      | —        |                                                           |
| `kind`                 | `SupportMessageKind`       | Yes      | `TEXT`   |                                                           |
| `text`                 | String                     | No       | —        | Message body (for TEXT kind)                              |
| `caption`              | String                     | No       | —        | Caption for media messages                                |
| `telegramUserChatId`   | String                     | No       | —        | Chat ID of the user's private DM with the bot             |
| `telegramUserMsgId`    | String                     | No       | —        | Message ID in the user's DM (for reply threading)         |
| `telegramSupportChatId`| String                     | No       | —        | Chat ID of the staff support group                        |
| `telegramSupportMsgId` | String                     | No       | —        | Message ID in the support group (for ForceReply routing)  |
| `telegramFileId`       | String                     | No       | —        | Telegram file ID for media attachments                    |
| `createdAt`            | DateTime                   | Yes      | now      |                                                           |

---

### `SupportSession`
Tracks an active bot interaction session for the ForceReply routing pattern. Links a Telegram chat to the prompt message that requires a reply.

| Field             | Type     | Required | Notes                                                             |
|-------------------|----------|----------|-------------------------------------------------------------------|
| `id`              | String   | Yes      | cuid                                                              |
| `telegramChatId`  | String   | Yes      | Telegram chat ID (user DM or support group)                       |
| `promptMessageId` | String   | Yes      | ID of the message the user is expected to reply to                |
| `createdAt`       | DateTime | Yes      |                                                                   |
| `expiresAt`       | DateTime | Yes      | Session TTL; after expiry the routing is no longer active         |

---

## Entity Relationship Overview

```
User ──────────────────────────────────────────────────────────┐
  │                                                             │
  ├── owns ──► Wishlist ──────────────────────────────────────┐│
  │              │                                            ││
  │              ├── contains ──► Item                        ││
  │              │                  │                         ││
  │              │                  ├──► ReservationEvent     ││
  │              │                  ├──► Comment              ││
  │              │                  ├──► CommentReadCursor ◄──┤│
  │              │                  ├──► ItemTag              ││
  │              │                  └──► Hint ◄───────────────┤│
  │              │                                            ││
  │              ├── has ──► Tag ◄── ItemTag                  ││
  │              │                                            ││
  │              └── followed by ──► WishlistSubscription ◄───┘│
  │                                     └──► SubscriptionUnread │
  │                                                             │
  ├── has ──► UserProfile                                       │
  ├── has ──► Subscription ──► PaymentEvent                     │
  └── opens ──► SupportTicket ──► SupportMessage               │
                                                                │
SupportSession (standalone, TTL-based routing)                  │
ServiceHeartbeat (standalone, liveness ping)                    │
                                                                │
PromoCampaign ──► PromoRedemption ◄── User                     │
DegradationState (tracks PRO→FREE transitions)                 │
LifecycleTouch (winback / engagement messaging log)            │
EntitlementGrant (promo-granted entitlements)                   │
```

**Key relationships at a glance:**

| Relationship                        | Cardinality      | Notes                                          |
|-------------------------------------|------------------|------------------------------------------------|
| User → Wishlist                     | 1 : many         | Includes exactly one `SYSTEM_DRAFTS` wishlist  |
| User → UserProfile                  | 1 : 0..1         | Created lazily                                 |
| User → Subscription                 | 1 : 0..1         | Unique on `(userId, planCode)`                 |
| Wishlist → Item                     | 1 : many         |                                                |
| Item → ReservationEvent             | 1 : many         | Append-only log                                |
| Item → Comment                      | 1 : many         | Scoped by `reservationEpoch`                   |
| Item → Hint                         | 1 : many         |                                                |
| User × Item → CommentReadCursor     | many : many (PK) | One cursor per user per item                   |
| User × Wishlist → WishlistSubscription | many : many   | Unique per pair                                |
| WishlistSubscription → SubscriptionUnread | 1 : many  |                                                |
| SupportTicket → SupportMessage      | 1 : many         |                                                |
| PromoCampaign → PromoRedemption     | 1 : many         | Promo codes and their redemptions              |
| User → PromoRedemption              | 1 : many         | User promo code usage history                  |
| User → DegradationState             | 1 : 0..1         | Tracks PRO→FREE transitions                    |
| User → LifecycleTouch               | 1 : many         | Winback / engagement messaging log             |
| User → EntitlementGrant             | 1 : many         | Promo-granted entitlements                     |

---

## Indexes

| Model            | Index                                     | Purpose                                                   |
|------------------|-------------------------------------------|-----------------------------------------------------------|
| `Item`           | `wishlistId`                              | Fetch all items for a wishlist                            |
| `Item`           | `purgeAfter`                              | Background job to hard-delete soft-deleted items          |
| `Item`           | `(wishlistId, priority, position)`        | Ordered item listing within a wishlist                    |
| `SupportSession` | `(telegramChatId, promptMessageId)`       | ForceReply routing lookup                                 |
| `SupportSession` | `expiresAt`                               | TTL cleanup of expired sessions                           |

---

## Key Behaviors and Constraints

### Wishlist Slug
- Generated once at wishlist creation from the title with a random suffix appended.
- Never updated, even if the title changes. Slugs are permanent to avoid breaking share links.

### Item Soft Delete
- Deletion sets `status = DELETED` and `purgeAfter = now + 90 days`.
- Items with `status = DELETED` are excluded from all normal API queries.
- A background job hard-deletes rows once `purgeAfter` has passed.

### Item URL
- `url` is required at the database level but the API accepts any string including empty strings. No URL validation is performed.

### Item Price
- `priceText` is stored as raw text exactly as entered (e.g. `"2 999 ₽"`, `"$49.99"`). It is never parsed into a numeric value.

### Reservation Epoch
- `Item.reservationEpoch` starts at `0` and increments by 1 each time a new reservation cycle begins (i.e. when an item transitions from unreserved to reserved).
- `Comment.reservationEpoch` is set to the item's current epoch at comment creation time.
- Querying comments for the current reservation uses `WHERE reservationEpoch = item.reservationEpoch`, effectively hiding comments from previous reservation cycles.

### Actor Hash
- `ReservationEvent.actorHash` and `Comment.authorActorHash` use the formula: `SHA-256("tg_actor:{telegramId}")`.
- This allows consistent identification of actors across sessions without storing raw Telegram user IDs in these tables.

### Comment Access Gate
- Comments are a PRO feature. Either the item owner or the reserver must have an active PRO subscription for the comment thread to be accessible. Comments exist in the DB regardless; the gate is enforced at the API layer.

### Comment Auto-Deletion
- Comments have `scheduledDeleteAt` set to `now + 30 days` at creation.
- A background job deletes comments after this date.

### Hint TTL
- Hints expire 30 days after creation (`expiresAt = createdAt + 30 days`).
- Delivery is via Telegram's `users_shared` contact picker flow.

### PRO Subscription (godMode bypass)
- `User.godMode = true` grants all PRO features unconditionally, without any `Subscription` record.
- Normal PRO access requires `Subscription.status = ACTIVE` and `currentPeriodEnd > now`.
- Soft-cancel: `cancelAtPeriodEnd = true` means the subscription stays `ACTIVE` until `currentPeriodEnd`, then transitions to `EXPIRED`.

### FREE Plan Limits
- Users on the free plan are limited to 50 items in their `SYSTEM_DRAFTS` wishlist.
- No item count limit applies to `REGULAR` wishlists on the free plan (other PRO features may still be gated separately).

### SYSTEM_DRAFTS Wishlist
- Exactly one `SYSTEM_DRAFTS` wishlist exists per user; it is auto-created on first use.
- It serves as the import staging area: items added via URL import land here pending review by the owner.

### UserProfile Lazy Creation
- `UserProfile` is not created at registration. It is created on the first write to `PATCH /tg/me/profile`.
- API endpoints reading the profile must handle the case where it does not yet exist (`null`).

### Tags
- Tags exist in the schema but are managed only via the admin panel.
- Tags are not exposed in the Mini App UI or its public API.

### Privacy Fields Not Yet Enforced
- `SubscribePolicy.LINK_ONLY` and `SubscribePolicy.APPROVED` are defined in the schema but are not yet enforced in API logic. The API currently treats both values the same as `ALL`.
- `ProfileVisibility.SUBSCRIBERS` is defined in the schema but the corresponding UI is not yet implemented.

### WishlistSubscription Unread Tracking
- `SubscriptionUnread` records are created when a subscribed wishlist or one of its items changes.
- The unique constraint `(subId, entityId, fieldName)` ensures only one unread entry per change type per subscriber, preventing notification spam on rapid edits.

### Support Bridge (ForceReply Pattern)
- `SupportSession` stores a short-lived mapping from `telegramChatId + promptMessageId` to the active ticket context.
- When a user or staff member replies to the bot's prompt message, the bot looks up the session to route the reply to the correct ticket and mirror it to the other side.
- Sessions are indexed on `expiresAt` for periodic cleanup.

### ServiceHeartbeat
- The Telegram bot pings `PUT /internal/heartbeat` periodically to update `ServiceHeartbeat` for `serviceName = "bot"`.
- The API health endpoint reads this record to determine whether the bot is alive, using a staleness threshold.
