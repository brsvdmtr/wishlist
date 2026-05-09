# Data Model — Wishlist Telegram Mini App

_Last updated: 2026-05-02_

> **73 models, 36 enums** (PostgreSQL 16, managed by Prisma ORM)

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
| `ARCHIVED`  | Archived by degradation engine when PRO expires and item exceeds FREE limits |

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

### `ItemOriginType`
How an item was created.

| Value      | Meaning                                |
|------------|----------------------------------------|
| `MANUAL`   | Created manually by the user (default) |
| `IMPORTED` | Imported via URL parser                |
| `DEMO`     | Created as a demo item during onboarding |

### `OnboardingStatus`
State of a user's onboarding flow.

| Value          | Meaning                           |
|----------------|-----------------------------------|
| `NOT_STARTED`  | Onboarding not yet begun          |
| `IN_PROGRESS`  | User is mid-onboarding            |
| `COMPLETED`    | User finished the onboarding flow |
| `DISMISSED`    | User dismissed the onboarding     |

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

### `PromoRedemptionStatus`
State of a promo code redemption.

| Value              | Meaning                                                |
|--------------------|--------------------------------------------------------|
| `PENDING`          | Redemption initiated, not yet activated                |
| `ACTIVE`           | Promo PRO access is currently active                   |
| `EXPIRED`          | Promo period ended                                     |
| `ACCEPTED_FOR_PAID`| User already had a paid PRO subscription               |
| `FAILED`           | Redemption failed (e.g., max redemptions reached)      |

### `DegradationPhase`
Lifecycle phase after PRO expiration.

| Value          | Meaning                                                    |
|----------------|------------------------------------------------------------|
| `NONE`         | Active PRO or never subscribed                             |
| `GRACE_PERIOD` | 14-day window after downgrade; PRO features still available|
| `ARCHIVED`     | Grace ended; excess wishlists/items archived               |
| `PURGED`       | 90 days after archive; archived items hard-deleted          |

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
| `EUR` | Euro             |
| `GBP` | British Pound    |

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

### `SantaCampaignStatus`
State machine for a Secret Santa campaign.

| Value              | Meaning                                 |
|--------------------|-----------------------------------------|
| `DRAFT`            | Campaign created, not yet open          |
| `OPEN`             | Accepting participants                  |
| `LOCKED`           | Registrations closed, awaiting draw     |
| `DRAW_IN_PROGRESS` | Draw algorithm running                  |
| `ACTIVE`           | Assignments made, gift exchange live    |
| `COMPLETED`        | All gifts exchanged                     |
| `CANCELLED`        | Campaign cancelled by organizer         |

### `SantaCampaignType`
Type of Secret Santa campaign.

| Value        | Meaning                               |
|--------------|---------------------------------------|
| `CLASSIC`    | Single-round Secret Santa (default)   |
| `MULTI_WAVE` | Multiple rounds of gift exchange      |

### `SantaParticipantStatus`
State of a participant in a campaign.

| Value     | Meaning                              |
|-----------|--------------------------------------|
| `INVITED` | Invited but hasn't joined yet        |
| `JOINED`  | Active participant                   |
| `LEFT`    | Voluntarily left the campaign        |
| `REMOVED` | Removed by organizer                 |

### `SantaGiftStatus`
Lifecycle state of a gift assignment.

| Value                    | Meaning                                              |
|--------------------------|------------------------------------------------------|
| `PENDING`                | Giver hasn't decided yet (initial)                   |
| `BUYING`                 | Legacy; treated as SELECTED_OUTSIDE in new flows     |
| `SELECTED_FROM_WISHLIST` | Giver chose an item from receiver's wishlist         |
| `SELECTED_OUTSIDE`       | Giver chose something not from the wishlist          |
| `DECLINED_TO_SAY`        | Giver confirms participation but won't disclose      |
| `SENT`                   | Gift physically sent/handed over                     |
| `RECEIVED`               | Receiver confirmed; terminal; unlocks reveal         |
| `MISSED_DEADLINE`        | Auto-set by cron when deadline passed; recoverable   |
| `ORPHANED`               | Terminal: giver's exit request approved while active  |

### `SantaParticipantRole`
Role of a participant within a campaign.

| Value         | Meaning                                          |
|---------------|--------------------------------------------------|
| `PARTICIPANT` | Default role                                     |
| `ADMIN`       | Elevated role; can perform organizer actions      |

### `SantaExitRequestStatus`
State of a participant's exit request.

| Value      | Meaning                                          |
|------------|--------------------------------------------------|
| `PENDING`  | Submitted, awaiting organizer decision           |
| `APPROVED` | Organizer approved; participant removed           |
| `DENIED`   | Organizer denied; participant stays              |

### `SantaDrawStatus`
State of a draw operation within a round.

| Value         | Meaning                    |
|---------------|----------------------------|
| `PENDING`     | Not yet started            |
| `IN_PROGRESS` | Draw algorithm running     |
| `DONE`        | Draw completed             |
| `FAILED`      | Draw failed (constraints)  |

### `SantaHintStatus`
State of a Secret Santa hint request.

| Value       | Meaning                                         |
|-------------|-------------------------------------------------|
| `PENDING`   | Giver requested, receiver hasn't responded      |
| `FULFILLED` | Receiver selected wishlist items                |
| `EXPIRED`   | 48h TTL exceeded without response               |
| `CANCELLED` | Campaign cancelled or draw invalidated          |

### `SantaNotificationType`
Types of Santa campaign notifications.

| Value                    | Meaning                                      |
|--------------------------|----------------------------------------------|
| `JOINED`                 | Participant joined                           |
| `LEFT`                   | Participant left                             |
| `DRAW_DONE`              | Draw completed                               |
| `GIFT_STATUS_CHANGED`    | Gift status updated                          |
| `HINT_REQUEST`           | Hint requested from receiver                 |
| `HINT_RESPONDED`         | Receiver responded to hint                   |
| `CAMPAIGN_CANCELLED`     | Campaign was cancelled                       |
| `GIFT_RECEIVED`          | Receiver marked gift as received             |
| `REVEAL_UNLOCKED`        | Receiver's reveal is ready                   |
| `DEADLINE_WARNING`       | ~3 days before deadline, giver still pending |
| `DEADLINE_MISSED`        | Giver auto-updated to MISSED_DEADLINE        |
| `CHAT_MESSAGE`           | New campaign chat message                    |
| `POLL_CREATED`           | New poll opened                              |
| `EXIT_REQUEST_SUBMITTED` | Exit request submitted (to organizers)       |
| `EXIT_REQUEST_APPROVED`  | Exit request approved (to participant)       |
| `EXIT_REQUEST_DENIED`    | Exit request denied (to participant)         |

### `SantaChatMessageType`
Type of message in a campaign chat.

| Value    | Meaning                            |
|----------|------------------------------------|
| `USER`   | Regular participant message        |
| `SYSTEM` | System-generated event message     |

### `GroupGiftStatus`
Lifecycle state of a group gift collection.

| Value       | Meaning                                          |
|-------------|--------------------------------------------------|
| `OPEN`      | Collection is active, accepting participants     |
| `COMPLETED` | Target reached or organizer closed the collection|
| `CANCELLED` | Organizer cancelled the collection               |

### `SecretReservationStatus`
Lifecycle state of a secret reservation (owner cannot see who reserved).

| Value                  | Meaning                                      |
|------------------------|----------------------------------------------|
| `ACTIVE`               | Secret reservation is active                 |
| `CANCELLED`            | Reserver cancelled                           |
| `FULFILLED`            | Item was purchased by the reserver           |
| `CONVERTED_TO_PUBLIC`  | Promoted to a public reservation             |

### `ReferralAttributionStatus`
State of a referral attribution record linking an inviter to an invitee.

| Value                | Meaning                                                              |
|----------------------|----------------------------------------------------------------------|
| `ATTRIBUTED`         | Invitee clicked link and entered bot                                 |
| `PENDING_ACTIVATION` | Waiting for qualifying action (wishlist + item)                      |
| `QUALIFIED`          | Qualifying action done within window — ready to reward               |
| `REWARDED`           | Inviter received PRO days — terminal success                         |
| `REJECTED`           | Auto-rejected (various reasons)                                      |
| `FRAUD_REVIEW`       | Fraud score crossed threshold, manual review needed                  |

### `ReferralRejectReason`
Reason for auto-rejecting a referral attribution.

| Value                        | Meaning                                              |
|------------------------------|------------------------------------------------------|
| `INVITEE_NOT_NEW_USER`       | Invitee already had an account                       |
| `INVITEE_HAD_PRIOR_DIALOG`   | Invitee had prior bot interaction                    |
| `INVITEE_HAD_PRIOR_WISHLIST` | Invitee already had a wishlist                       |
| `INVITEE_HAD_PRIOR_ITEM`     | Invitee already had an item                          |
| `INVITEE_ALREADY_ATTRIBUTED` | Invitee was already attributed to another inviter    |
| `SELF_REFERRAL_DETECTED`     | Inviter and invitee are the same user                |
| `REWARD_CAP_REACHED`         | Inviter hit monthly or yearly reward cap             |
| `QUALIFICATION_TIMEOUT`      | Invitee did not qualify within the 14-day window     |
| `PROGRAM_DISABLED`           | Referral program was disabled                        |
| `SYSTEM_CONFLICT`            | Internal conflict preventing attribution             |
| `FRAUD_REJECTED`             | Manual rejection after fraud review                  |
| `INVITER_BANNED`             | Inviter account is banned                            |
| `INVITER_DELETED`            | Inviter account was deleted                          |

### `ReferralRewardStatus`
State of a PRO days reward granted to an inviter.

| Value     | Meaning                   |
|-----------|---------------------------|
| `GRANTED` | Reward granted            |
| `REVOKED` | Reward revoked by admin   |

### `IdempotencyStatus`
Lifecycle state of an `IdempotencyKey` row. Used by the API security layer (Wave 1 P0, shipped 2026-04-29).

| Value        | Meaning                                                                                                    |
|--------------|------------------------------------------------------------------------------------------------------------|
| `processing` | Handler is running (or crashed before completion); guarded by `lockedUntil`                                |
| `completed`  | Handler finished; replay returns the stored response                                                       |
| `failed`     | Handler returned 5xx; same key may retry once `lockedUntil` expires                                        |

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

| `santaTestMode`      | Boolean   | Yes      | `false`    | When `true`, bypasses Santa season restrictions for testing          |
| `welcomeSent`        | Boolean   | Yes      | `true`     | Tracks whether the welcome /start message was delivered              |
| `themePreference`    | String    | Yes      | `"dark"`   | v2.1 appearance: `"dark"` \| `"black"`. PRO unlocks `"black"`; FREE is always `"dark"` |
| `accentPreference`   | String    | Yes      | `"violet"` | v2.1 appearance: `"violet"` \| `"blue"` \| `"pink"` \| `"green"`. PRO unlocks non-violet accents |
| `calendarOnboardingSeenAt` | DateTime | No  | —          | Set once when the user dismisses or finishes the Events Calendar v2.1 4-step onboarding. Persisted server-side so the same account doesn't re-run onboarding on a fresh device (was localStorage-only before) |

**Relations:**
- `wishlists[]` → `Wishlist` (owned wishlists)
- `subscriptions[]` → `Subscription` (billing records)
- `paymentEvents[]` → `PaymentEvent`
- `commentReadCursors[]` → `CommentReadCursor`
- `hints[]` → `Hint` (hints sent by this user)
- `profile` → `UserProfile` (nullable, created lazily)
- `wishlistSubscriptions[]` → `WishlistSubscription` (wishlists this user follows)
- `supportTickets[]` → `SupportTicket`
- `addOns[]` → `UserAddOn` (purchased add-ons)
- `credits` → `UserCredits` (nullable, consumable balances)
- `purchases[]` → `Purchase` (SKU purchase audit log)
- `ownedSantaCampaigns[]` → `SantaCampaign`
- `santaParticipations[]` → `SantaParticipant`
- `santaNotifications[]` → `SantaNotification`
- `santaExclusionGroupMemberships[]` → `SantaExclusionGroupMember`
- `onboardingStates[]` → `UserOnboardingState`
- `promoRedemptions[]` → `PromoRedemption`
- `degradationState` → `DegradationState` (nullable)
- `lifecycleTouches[]` → `LifecycleTouch`
- `giftOccasions[]` → `GiftOccasion`
- `giftOccasionIdeas[]` → `GiftOccasionIdea`
- `giftOccasionReminders[]` → `GiftOccasionReminder` (Events Calendar v2.1 reminders this user owns)
- `linkedGiftOccasions[]` → `GiftOccasion` (occasions where this user is `linkedUser` — e.g. imported friend birthdays)
- `calendarInbox[]` → `CalendarInboxEntry` (Events Calendar v2.1 inbox)
- `groupGiftsOrganized[]` → `GroupGift` (group gifts organized by this user)
- `groupGiftParticipations[]` → `GroupGiftParticipant` (group gift participations)
- `groupGiftMessages[]` → `GroupGiftMessage` (messages sent in group gifts)

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
| `avatarThumbUrl`       | String             | No       | —            | URL to thumbnail profile picture                                      |
| `avatarUpdatedAt`      | DateTime           | No       | —            | Timestamp of last avatar change                                       |
| `avatarPublic`         | Boolean            | Yes      | `true`       | Whether avatar is publicly visible                                    |
| `birthday`             | DateTime           | No       | —            | Date of birth                                                         |
| `hideYear`             | Boolean            | Yes      | `false`      | When `true`, birth year is hidden from public profile                 |
| `defaultCurrency`      | `Currency`         | Yes      | `RUB`        | Used as default currency when creating new items                      |
| `notifyComments`       | Boolean            | Yes      | `true`       | Receive Telegram notifications for new comments                       |
| `notifyReservations`   | Boolean            | Yes      | `true`       | Receive Telegram notifications when items are reserved/purchased      |
| `notifySubscriptions`  | Boolean            | Yes      | `true`       | Receive Telegram notifications when someone subscribes to a wishlist  |
| `notifyMarketing`      | Boolean            | Yes      | `true`       | Receive promotional messages from the bot                             |
| `profileVisibility`    | `ProfileVisibility`| Yes      | `ALL`        | Who can view the user's public profile page                           |
| `subscribePolicy`      | `SubscribePolicy`  | Yes      | `ALL`        | Who can subscribe to the user's wishlists (partially enforced)        |
| `commentsEnabled`      | Boolean            | Yes      | `true`       | User preference; PRO feature gate applies regardless                  |
| `hintsEnabled`         | Boolean            | Yes      | `true`       | User preference; PRO feature gate applies regardless                  |
| `language`             | String             | No       | —            | Legacy language field; no longer used as effective locale source       |
| `languageMode`         | String             | Yes      | `"auto"`     | `auto` = follow Telegram language_code; `manual` = use manualLanguage |
| `manualLanguage`       | String             | No       | —            | Locale chosen by user when languageMode='manual'                      |
| `newWishlistPosition`  | String             | Yes      | `"bottom"`   | Whether new wishlists are inserted at the top or bottom of the list   |
| `cardDisplayMode`      | String             | Yes      | `"auto"`     | Card display mode: auto, showcase, compact                            |
| `supportId`            | String             | No       | —            | Unique support identifier                                             |
| `normalizedLocale`     | String             | No       | —            | Canonical locale: `ru`, `en`, `zh-CN`, `hi`, `es`, `ar`              |
| `marketBucket`         | String             | No       | —            | Market bucket: `ru`, `ar`, `en`, `hi`, `zh-CN`, `es`, `other_known`, `unknown` |
| `supportedImportRegion`| Boolean            | No       | —            | `true` if user is in a market where URL import works reliably         |
| `dontGiftPresets`      | String[]           | Yes      | `[]`         | Preset "don't gift me" categories                                     |
| `dontGiftCustomItems`  | String[]           | Yes      | `[]`         | Custom free-text "don't gift me" items                                |
| `dontGiftComment`      | String             | No       | —            | Free-text comment about gift preferences                              |
| `dontGiftVisible`          | Boolean            | Yes      | `true`       | Whether the "don't gift" section is visible to others                 |
| `showcaseEnabled`          | Boolean            | Yes      | `false`      | Whether showcase is published                                         |
| `showcaseCoverUrl`         | String             | No       | —            | Cover photo URL                                                       |
| `showcaseBio`              | VarChar(180)       | No       | —            | Showcase bio                                                          |
| `showcasePinnedIds`        | String[]           | Yes      | `[]`         | Pinned wishlist IDs (max 3)                                           |
| `showcasePreferences`      | VarChar(300)       | No       | —            | Free text preferences                                                 |
| `showcaseSizeClothing`     | String             | No       | —            | Clothing size                                                         |
| `showcaseSizeShoes`        | String             | No       | —            | Shoe size                                                             |
| `showcaseSizeRing`         | String             | No       | —            | Ring size                                                             |
| `showcaseSizeOther`        | String             | No       | —            | Other size                                                            |
| `showcaseBrands`           | String[]           | Yes      | `[]`         | Preferred brands                                                      |
| `showcaseUpdatedAt`        | DateTime           | No       | —            | Last showcase update                                                  |
| `showcaseChest`            | String             | No       | —            | Chest measurement                                                     |
| `showcaseWaist`            | String             | No       | —            | Waist measurement                                                     |
| `showcaseHips`             | String             | No       | —            | Hips measurement                                                      |
| `referralCode`             | String             | No       | —            | Unique personal referral code                                         |
| `referralCodeCreatedAt`    | DateTime           | No       | —            | When referral code was created                                        |
| `referredByUserId`         | String             | No       | —            | User ID of who invited this user                                      |
| `referredAt`               | DateTime           | No       | —            | When user was attributed to an inviter                                |
| `firstBotStartAt`          | DateTime           | No       | —            | First /start event timestamp                                          |
| `firstWishlistAt`          | DateTime           | No       | —            | Timestamp of first wishlist creation                                  |
| `firstItemAt`              | DateTime           | No       | —            | Timestamp of first item creation                                      |
| `notifyBirthdays`          | Boolean            | Yes      | `true`       | Recipient opt-out for incoming birthday notifications                 |
| `birthdayFriendReminders`  | Boolean            | Yes      | `false`      | Opt-in to send birthday reminders about you to your audience. Existing users with a birthday set must explicitly enable via the post-save sheet |
| `birthdayOwnerReminders`   | Boolean            | Yes      | `true`       | Self-reminders to update wishlist before birthday                     |
| `birthdayAudience`         | String             | Yes      | `"SUBSCRIBERS"` | `"SUBSCRIBERS"` (FREE) \| `"EXTENDED"` (PRO; adds reservers + secret reservers) |
| `birthdayAdvancedWindowsEnabled` | Boolean      | Yes      | `false`      | PRO flag: enables 7d/1d friend windows + 14d/7d owner windows         |
| `birthdayPrimaryWishlistId`| String             | No       | —            | PRO override: which wishlist friend CTAs deep-link into (else auto-pick) |
| `birthdayCustomMessage`    | VarChar(200)       | No       | —            | PRO: italicised line in the friend bot DM                              |
| `birthdayOptInPromptSeenAt`| DateTime           | No       | —            | When the post-save opt-in sheet was last shown                         |
| `createdAt`                | DateTime           | Yes      | now          |                                                                       |
| `updatedAt`                | DateTime           | Yes      | auto         |                                                                       |

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
| `emoji`              | String                | No       | —            | Optional user-chosen emoji shown next to the title in the hero card. When null, the UI falls back to a hash-derived auto-pick from title (single-grapheme + emoji-only validation enforced server-side) |
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

| `shareOpenCount`          | Int                   | Yes      | `0`          | Incremented on each `GET /public/share/:token` call                    |
| `dontGiftMode`            | String                | Yes      | `"global"`   | `"global"` / `"custom"` / `"disabled"` — per-wishlist Don't Gift mode  |
| `dontGiftPresets`         | String[]              | Yes      | `[]`         | Preset categories when mode=custom                                      |
| `dontGiftCustomItems`     | String[]              | Yes      | `[]`         | Custom items when mode=custom                                           |
| `dontGiftComment`         | String                | No       | —            | Free-text comment when mode=custom                                      |
| `smartReservationsEnabled`| Boolean               | Yes      | `false`      | Whether smart reservations (timed auto-release) are active              |
| `smartResTtlHours`        | Int                   | Yes      | `72`         | Hours until auto-release                                                |
| `smartResAllowExtend`     | Boolean               | Yes      | `true`       | Whether reservers can extend their reservation                          |
| `smartResMaxExtensions`   | Int                   | Yes      | `2`          | Max number of extensions per reservation                                |

**Relations:**
- `owner` → `User`
- `items[]` → `Item`
- `tags[]` → `Tag`
- `categories[]` → `WishlistCategory` (item categories within this wishlist)
- `wishlistSubscriptions[]` → `WishlistSubscription`
- `santaParticipants[]` → `SantaParticipant` (linked wishlists in Santa campaigns)

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
| `isDemo`          | Boolean        | Yes      | `false`     | Whether this is a demo item from onboarding                                               |
| `originType`      | `ItemOriginType` | Yes    | `MANUAL`    | How the item was created                                                                  |
| `originVariantKey`| String         | No       | —           | Onboarding variant key for demo items                                                      |
| `becameRealAt`    | DateTime       | No       | —           | When a demo item was converted to a real item                                              |
| `status`          | `ItemStatus`   | Yes      | `AVAILABLE` |                                                                                           |
| `reservationEpoch`| Int            | Yes      | `0`         | Increments on each new reservation cycle; used to scope comments to the current reservation |
| `position`        | Int            | Yes      | `0`         | Manual sort order within a priority group                                                  |
| `categoryId`     | String         | No       | —           | FK → `WishlistCategory`. Optional category within the wishlist                            |
| `reserverUserId`  | String         | No       | —           | Telegram user ID (not FK) of the person who reserved this item                            |
| `archivedAt`      | DateTime       | No       | —           | Set when the item is archived                                                              |
| `purgeAfter`      | DateTime       | No       | —           | Set to `now + 90 days` when `status = DELETED`; background job hard-deletes after this date |
| `createdAt`       | DateTime       | Yes      | now         |                                                                                           |
| `updatedAt`       | DateTime       | Yes      | auto        |                                                                                           |

**Relations:**
- `wishlist` → `Wishlist`
- `category` → `WishlistCategory?` (optional, onDelete: SetNull)
- `itemTags[]` → `ItemTag`
- `reservationEvents[]` → `ReservationEvent`
- `comments[]` → `Comment`
- `commentReadCursors[]` → `CommentReadCursor`
- `hints[]` → `Hint`
- `santaItemReservations[]` → `SantaItemReservation`
- `groupGift` → `GroupGift?` (optional one-to-one; one group gift per item)

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

### `ReservationMeta`
Per-reservation metadata for PRO features: private notes, purchased flag, reminders, and history tracking. One record per (item, reserver) pair. Created on reserve, deactivated on unreserve/complete/archive.

| Field            | Type     | Required | Default | Notes                                                               |
|------------------|----------|----------|---------|---------------------------------------------------------------------|
| `id`             | String   | Yes      | cuid    |                                                                     |
| `itemId`         | String   | Yes      | —       | FK → `Item` (CASCADE delete)                                       |
| `reserverUserId` | String   | Yes      | —       | Telegram user ID of the reserver (not a FK)                         |
| `note`           | String   | No       | —       | Private note (max 500 chars). Visible only to the reserver          |
| `purchased`      | Boolean  | Yes      | false   | Private "I already bought" flag                                     |
| `purchasedAt`    | DateTime | No       | —       | When purchased flag was set                                         |
| `reminderAt`     | DateTime | No       | —       | When to send a Telegram reminder                                    |
| `reminderSent`   | Boolean  | Yes      | false   | Whether the reminder has been sent                                  |
| `active`         | Boolean  | Yes      | true    | false = reservation ended (history)                                 |
| `endedAt`        | DateTime | No       | —       | When the reservation ended                                          |
| `endReason`           | String   | No       | —       | `'unreserved'` / `'completed'` / `'archived'`                       |
| `isSmartRes`          | Boolean  | Yes      | `false` | Whether this reservation has a smart-res timer                      |
| `expiresAt`           | DateTime | No       | —       | When this reservation auto-releases (smart res)                     |
| `extensionCount`      | Int      | Yes      | `0`     | How many times the reservation has been extended                    |
| `smartResTtlHours`    | Int      | No       | —       | TTL snapshot from wishlist settings at reserve time                 |
| `smartResAllowExtend` | Boolean  | No       | —       | Allow-extend snapshot from wishlist settings at reserve time        |
| `smartResMaxExtensions`| Int     | No       | —       | Max-extensions snapshot from wishlist settings at reserve time      |
| `createdAt`           | DateTime | Yes      | now     |                                                                     |
| `updatedAt`           | DateTime | Yes      | auto    |                                                                     |

**Unique constraint:** `(itemId, reserverUserId)`
**Indexes:** `(reserverUserId, active)`, `(reminderAt, reminderSent)`, `(isSmartRes, active, expiresAt)`

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
| `parentCommentId`   | String         | No       | —       | FK → `Comment` (ON DELETE SET NULL). Enables one-level threaded replies                             |
| `createdAt`         | DateTime       | Yes      | now     |                                                                                                     |

**Index:** `parentCommentId`

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
| `billingPeriod`      | String               | No       | `"monthly"`       | `"monthly"` \| `"yearly"` \| `"lifetime"`. Lifetime has `currentPeriodEnd = 2099-12-31` (sentinel) and `cancelAtPeriodEnd = false` permanently |
| `cancelAtPeriodEnd`  | Boolean              | Yes      | `false`           | Soft-cancel: PRO access continues until `currentPeriodEnd`, then expires. Always `false` for `billingPeriod='lifetime'` (no auto-renewal) |
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

### `UserAddOn`
Permanent add-on purchased via Telegram Stars. Each row represents one unit of a specific add-on type.

| Field       | Type     | Required | Default | Notes                                                              |
|-------------|----------|----------|---------|--------------------------------------------------------------------|
| `id`        | String   | Yes      | cuid    |                                                                    |
| `userId`    | String   | Yes      | --      | FK -> `User`                                                      |
| `addonType` | String   | Yes      | --      | `wishlist_slot`, `subscription_slot`, `item_slot_5`, `item_slot_15`, `seasonal_decoration` |
| `quantity`  | Int      | Yes      | `1`     |                                                                    |
| `targetId`  | String   | No       | --      | Wishlist ID for wishlist-scoped add-ons; null for account-level    |
| `createdAt` | DateTime | Yes      | now     |                                                                    |

---

### `UserCredits`
Consumable credit balances. PRO users bypass credit checks entirely.

| Field          | Type     | Required | Default | Notes                   |
|----------------|----------|----------|---------|-------------------------|
| `id`           | String   | Yes      | cuid    |                         |
| `userId`       | String   | Yes      | --      | Unique FK -> `User`     |
| `hintCredits`  | Int      | Yes      | `0`     | Available hint credits  |
| `importCredits`| Int      | Yes      | `0`     | Available import credits|
| `updatedAt`    | DateTime | Yes      | auto    |                         |

---

### `Purchase`
Immutable purchase log for one-time SKU payments (not subscriptions). Idempotent on `telegramChargeId`.

| Field              | Type     | Required | Default       | Notes                          |
|--------------------|----------|----------|---------------|--------------------------------|
| `id`               | String   | Yes      | cuid          |                                |
| `userId`           | String   | Yes      | --            | FK -> `User`                   |
| `skuCode`          | String   | Yes      | --            | SKU identifier                 |
| `quantity`         | Int      | Yes      | `1`           |                                |
| `targetId`         | String   | No       | --            | Target entity (e.g., wishlist) |
| `starsPrice`       | Int      | Yes      | --            | Price paid in Telegram Stars   |
| `telegramChargeId` | String   | Yes      | --            | Unique. From Telegram payment  |
| `invoicePayload`   | String   | Yes      | --            | Original invoice payload       |
| `status`           | String   | Yes      | `"completed"` |                                |
| `createdAt`        | DateTime | Yes      | now           |                                |

---

### `PromoCampaign`
Defines a reusable promo code (e.g., `WISHPRO`).

| Field           | Type     | Required | Default       | Notes                                 |
|-----------------|----------|----------|---------------|---------------------------------------|
| `id`            | String   | Yes      | cuid          |                                       |
| `code`          | String   | Yes      | --            | Unique canonical code                 |
| `rewardType`    | String   | Yes      | `"promo_pro"` | `promo_pro` or future types           |
| `durationDays`  | Int      | Yes      | `30`          | Duration of the promo grant           |
| `isActive`      | Boolean  | Yes      | `true`        |                                       |
| `maxRedemptions`| Int      | No       | --            | null = unlimited                      |
| `createdAt`     | DateTime | Yes      | now           |                                       |
| `updatedAt`     | DateTime | Yes      | auto          |                                       |

**Relations:**
- `redemptions[]` -> `PromoRedemption`

---

### `PromoRedemption`
Per-user promo code redemption record.

| Field            | Type                    | Required | Default     | Notes                                    |
|------------------|-------------------------|----------|-------------|------------------------------------------|
| `id`             | String                  | Yes      | cuid        |                                          |
| `userId`         | String                  | Yes      | --          | FK -> `User`                             |
| `campaignId`     | String                  | Yes      | --          | FK -> `PromoCampaign`                    |
| `status`         | `PromoRedemptionStatus` | Yes      | `PENDING`   |                                          |
| `attemptedAt`    | DateTime                | Yes      | now         |                                          |
| `activatedAt`    | DateTime                | No       | --          |                                          |
| `expiresAt`      | DateTime                | No       | --          |                                          |
| `failureReason`  | String                  | No       | --          |                                          |
| `source`         | String                  | No       | `"miniapp"` | `miniapp`, `bot`, `winback`              |
| `offeredAt`      | DateTime                | No       | --          | When lifecycle system offered promo      |
| `offeredVia`     | String                  | No       | --          | Lifecycle touch ID or manual             |
| `reminder3dSent` | Boolean                 | Yes      | `false`     | 3-day reminder sent flag                 |
| `reminderExpSent`| Boolean                 | Yes      | `false`     | Expiry reminder sent flag                |
| `createdAt`      | DateTime                | Yes      | now         |                                          |
| `updatedAt`      | DateTime                | Yes      | auto        |                                          |

**Unique constraint:** `(userId, campaignId)`

---

### `DegradationState`
Tracks PRO-to-FREE degradation lifecycle per user.

| Field                 | Type               | Required | Default | Notes                                    |
|-----------------------|--------------------|----------|---------|------------------------------------------|
| `id`                  | String             | Yes      | cuid    |                                          |
| `userId`              | String             | Yes      | --      | Unique FK -> `User`                      |
| `phase`               | `DegradationPhase` | Yes      | `NONE`  |                                          |
| `graceEndsAt`         | DateTime           | No       | --      | 14 days after downgrade                  |
| `archivedAt`          | DateTime           | No       | --      | When items were archived                 |
| `purgeScheduledAt`    | DateTime           | No       | --      | 90 days after archive                    |
| `archivedWishlistIds` | String             | No       | --      | JSON array of archived wishlist IDs      |
| `archivedItemIds`     | String             | No       | --      | JSON array of archived item IDs          |
| `createdAt`           | DateTime           | Yes      | now     |                                          |
| `updatedAt`           | DateTime           | Yes      | auto    |                                          |

---

### `LifecycleTouch`
Multi-touch winback / engagement messaging log with attribution tracking.

| Field                | Type     | Required | Default | Notes                                                |
|----------------------|----------|----------|---------|------------------------------------------------------|
| `id`                 | String   | Yes      | cuid    |                                                      |
| `userId`             | String   | Yes      | --      | FK -> `User`                                         |
| `segment`            | String   | Yes      | --      | S1, S2, S3, S4                                       |
| `episodeKey`         | String   | Yes      | --      | Unique per churn episode (e.g. `"S3_userId_2026-03"`)|
| `touchNumber`        | Int      | Yes      | --      | 1, 2, 3                                             |
| `scheduledFor`       | DateTime | Yes      | --      |                                                      |
| `sentAt`             | DateTime | No       | --      |                                                      |
| `delivered`          | Boolean  | Yes      | `false` |                                                      |
| `targetAction`       | String   | No       | --      | `create_wishlist`, `add_item`, `return_visit`, `share`|
| `offerCode`          | String   | No       | --      | `WISHPRO` or null                                    |
| `messageKind`        | String   | Yes      | --      | `activation`, `winback`, `promo_offer`               |
| `deepLinkPayload`    | String   | No       | --      | startapp payload for CTA button                      |
| `stoppedAt`          | DateTime | No       | --      |                                                      |
| `stopReason`         | String   | No       | --      | `returned`, `target_completed`, `unsubscribed`, etc. |
| `returnedAt`         | DateTime | No       | --      | When user came back after this touch                 |
| `targetCompletedAt`  | DateTime | No       | --      | When user completed segment target action            |
| `targetCompletedType`| String   | No       | --      | e.g. `created_wishlist`, `added_item`                |
| `promoRedeemedAt`    | DateTime | No       | --      | When WISHPRO was activated after this touch           |
| `createdAt`          | DateTime | Yes      | now     |                                                      |
| `updatedAt`          | DateTime | Yes      | auto    |                                                      |

**Unique constraint:** `(userId, episodeKey, touchNumber)`

---

### `UserOnboardingState`
Tracks per-user, per-key, per-version onboarding state. Supports multiple onboarding flows.

| Field              | Type               | Required | Default       | Notes                                              |
|--------------------|--------------------|----------|---------------|----------------------------------------------------|
| `id`               | String             | Yes      | cuid          |                                                    |
| `userId`           | String             | Yes      | --            | FK -> `User`                                       |
| `onboardingKey`    | String             | Yes      | --            | e.g. `"hello_activation"`                          |
| `version`          | Int                | Yes      | --            | Increment to re-show to all users                  |
| `status`           | `OnboardingStatus` | Yes      | `NOT_STARTED` |                                                    |
| `variantKey`       | String             | No       | --            | A/B test variant; assigned once on start           |
| `entryPoint`       | String             | No       | --            | How the user entered onboarding                    |
| `demoItemId`       | String             | No       | --            | FK to the demo item for this onboarding session    |
| `completionReason` | String             | No       | --            | `demo_converted`, `real_item_created`, etc.        |
| `metaJson`         | Json               | No       | --            |                                                    |
| `startedAt`        | DateTime           | No       | --            |                                                    |
| `completedAt`      | DateTime           | No       | --            |                                                    |
| `dismissedAt`      | DateTime           | No       | --            |                                                    |
| `createdAt`        | DateTime           | Yes      | now           |                                                    |
| `updatedAt`        | DateTime           | Yes      | auto          |                                                    |

**Unique constraint:** `(userId, onboardingKey, version)`

---

### `GiftOccasion`
A gift-giving occasion in a user's personal gift notebook (and, since 2026-04-28, the unit of the Events Calendar v2.1 feature).

| Field                | Type     | Required | Default    | Notes                                                                    |
|----------------------|----------|----------|------------|--------------------------------------------------------------------------|
| `id`                 | String   | Yes      | cuid       |                                                                          |
| `ownerUserId`        | String   | Yes      | --         | FK -> `User`                                                             |
| `title`              | String   | Yes      | --         |                                                                          |
| `type`               | String   | Yes      | `"OTHER"`  | `BIRTHDAY`, `ANNIVERSARY`, `HOLIDAY`, `OTHER`                            |
| `personName`         | String   | No       | --         | Free text, no linked user requirement                                    |
| `eventDate`          | Date     | No       | --         |                                                                          |
| `recurrence`         | String   | Yes      | `"NONE"`   | `NONE`, `YEARLY`, `MONTHLY`                                              |
| `note`               | String   | No       | --         |                                                                          |
| `status`             | String   | Yes      | `"ACTIVE"` | `ACTIVE`, `DONE`, `ARCHIVED`                                             |
| `emoji`              | String   | No       | --         | v2.1 — Optional emoji for the event card (custom or quick-pick)          |
| `eventTime`          | String   | No       | --         | v2.1 — `"HH:mm"` 24h                                                     |
| `location`           | String   | No       | --         | v2.1                                                                     |
| `budgetMin`          | Int      | No       | --         | v2.1                                                                     |
| `budgetMax`          | Int      | No       | --         | v2.1                                                                     |
| `budgetCurrency`     | String   | No       | --         | v2.1                                                                     |
| `source`             | String   | Yes      | `"USER"`   | v2.1 — `USER` \| `IMPORTED_FRIEND` \| `IMPORTED_HOLIDAY`. Drives import dedup + UI labels |
| `holidayKey`         | String   | No       | --         | v2.1 — when `source = IMPORTED_HOLIDAY`, FK-by-key into `Holiday.key`    |
| `country`            | String   | No       | --         | v2.1 — ISO 3166-1 alpha-2 for imported holidays                          |
| `linkedUserId`       | String   | No       | --         | v2.1 — Soft FK -> `User`. SetNull on delete                              |
| `linkedWishlistId`   | String   | No       | --         | v2.1 — Soft FK -> `Wishlist`. SetNull on delete                          |
| `linkedSantaId`      | String   | No       | --         | v2.1 — Soft FK -> `SantaCampaign`. SetNull on delete                     |
| `actualGiftText`     | String   | No       | --         | v2.1 Year-Recap — filled when user marks event DONE                      |
| `actualGiftAmount`   | Int      | No       | --         | v2.1 Year-Recap                                                          |
| `actualGiftCurrency` | String   | No       | --         | v2.1 Year-Recap                                                          |
| `thankYouNote`       | String   | No       | --         | v2.1 Year-Recap                                                          |
| `thankYouAt`         | DateTime | No       | --         | v2.1 Year-Recap                                                          |
| `archivedAt`         | DateTime | No       | --         |                                                                          |
| `completedAt`        | DateTime | No       | --         |                                                                          |
| `createdAt`          | DateTime | Yes      | now        |                                                                          |
| `updatedAt`          | DateTime | Yes      | auto       |                                                                          |

**Relations:**
- `owner` -> `User` (Cascade)
- `linkedUser` -> `User?` (SetNull) — for `IMPORTED_FRIEND` rows
- `linkedWishlist` -> `Wishlist?` (SetNull)
- `linkedSanta` -> `SantaCampaign?` (SetNull)
- `ideas[]` -> `GiftOccasionIdea`
- `reminders[]` -> `GiftOccasionReminder`
- `inboxEntries[]` -> `CalendarInboxEntry`

**Indexes:** `(ownerUserId)`, `(ownerUserId, status)`, `(ownerUserId, eventDate)`, `(linkedUserId)`, `(linkedWishlistId)`, `(linkedSantaId)`.

**Unique constraint:** `(ownerUserId, holidayKey)` — prevents the same user importing the same holiday twice.

---

### `GiftOccasionIdea`
A gift idea within an occasion.

| Field         | Type     | Required | Default    | Notes                                                                |
|---------------|----------|----------|------------|----------------------------------------------------------------------|
| `id`          | String   | Yes      | cuid       |                                                                      |
| `occasionId`  | String   | Yes      | --         | FK -> `GiftOccasion`                                                 |
| `ownerUserId` | String   | Yes      | --         | FK -> `User`                                                         |
| `text`        | String   | Yes      | --         |                                                                      |
| `link`        | String   | No       | --         |                                                                      |
| `price`       | Int      | No       | --         |                                                                      |
| `currency`    | String   | No       | --         |                                                                      |
| `note`        | String   | No       | --         |                                                                      |
| `imageUrl`    | String   | No       | --         | v2.1 — set via `POST /tg/gift-occasion-ideas/:ideaId/photo`          |
| `status`      | String   | Yes      | `"ACTIVE"` | `ACTIVE`, `DONE`, `ARCHIVED`                                         |
| `archivedAt`  | DateTime | No       | --         |                                                                      |
| `completedAt` | DateTime | No       | --         |                                                                      |
| `createdAt`   | DateTime | Yes      | now        |                                                                      |
| `updatedAt`   | DateTime | Yes      | auto       |                                                                      |

---

### `GiftOccasionReminder`
A per-occasion reminder fire (Events Calendar v2.1). The scheduler computes `scheduledFor` from `(occasion.eventDate, offsetDays, timeOfDay)` in MSK and a unique `episodeKey` is derived from `(occasionId, occurrenceDate, offsetDays)` to dedup against re-runs.

| Field          | Type     | Required | Default   | Notes                                                          |
|----------------|----------|----------|-----------|----------------------------------------------------------------|
| `id`           | String   | Yes      | cuid      |                                                                |
| `occasionId`   | String   | Yes      | --        | FK -> `GiftOccasion` (Cascade on delete)                       |
| `ownerUserId`  | String   | Yes      | --        | FK -> `User` (Cascade)                                         |
| `offsetDays`   | Int      | Yes      | --        | Days before event (negative offsets = before; 0 = day-of)      |
| `timeOfDay`    | String   | Yes      | `"10:00"` | `HH:mm` in MSK                                                 |
| `enabled`      | Boolean  | Yes      | `true`    |                                                                |
| `scheduledFor` | DateTime | No       | --        | Next fire time computed by scheduler                           |
| `sentAt`       | DateTime | No       | --        |                                                                |
| `delivered`    | Boolean  | Yes      | `false`   |                                                                |
| `episodeKey`   | String   | Yes      | --        | Unique dedup key per occurrence                                |
| `createdAt`    | DateTime | Yes      | now       |                                                                |
| `updatedAt`    | DateTime | Yes      | auto      |                                                                |

**Relations:** `occasion` -> `GiftOccasion`, `owner` -> `User`.

**Indexes:** `(occasionId)`, `(ownerUserId)`, `(scheduledFor, sentAt, enabled)`.

**Unique constraint:** `episodeKey`.

---

### `Holiday`
Master list of holidays available for import into the Events Calendar. Seeded from `20260428000001_seed_holidays_v1`.

| Field      | Type     | Required | Default      | Notes                                                  |
|------------|----------|----------|--------------|--------------------------------------------------------|
| `id`       | String   | Yes      | cuid         |                                                        |
| `country`  | String   | Yes      | --           | ISO 3166-1 alpha-2                                     |
| `month`    | Int      | Yes      | --           | 1–12                                                   |
| `day`      | Int      | Yes      | --           | 1–31                                                   |
| `key`      | String   | Yes      | --           | Unique stable identifier (e.g. `"RU:01-01:new_year"`)  |
| `emoji`    | String   | Yes      | --           |                                                        |
| `category` | String   | Yes      | `"NATIONAL"` |                                                        |
| `nameRu`   | String   | No       | --           | Localized name                                         |
| `nameEn`   | String   | No       | --           |                                                        |
| `nameZhCn` | String   | No       | --           |                                                        |
| `nameHi`   | String   | No       | --           |                                                        |
| `nameEs`   | String   | No       | --           |                                                        |
| `nameAr`   | String   | No       | --           |                                                        |
| `ordinal`  | Int      | Yes      | `0`          | Sort order within a date                               |
| `createdAt`| DateTime | Yes      | now          |                                                        |
| `updatedAt`| DateTime | Yes      | auto         |                                                        |

**Indexes:** `(country)`, `(country, month, day)`. **Unique:** `key`.

---

### `CalendarInboxEntry`
In-app inbox aggregating Events Calendar notifications (reminders fired, holidays added, year-recap availability, etc.).

| Field          | Type     | Required | Default | Notes                                            |
|----------------|----------|----------|---------|--------------------------------------------------|
| `id`           | String   | Yes      | cuid    |                                                  |
| `ownerUserId`  | String   | Yes      | --      | FK -> `User` (Cascade)                           |
| `occasionId`   | String   | No       | --      | FK -> `GiftOccasion` (SetNull on delete)         |
| `type`         | String   | Yes      | --      | Inbox entry kind                                 |
| `emoji`        | String   | Yes      | --      |                                                  |
| `title`        | String   | Yes      | --      |                                                  |
| `body`         | String   | No       | --      |                                                  |
| `readAt`       | DateTime | No       | --      |                                                  |
| `archivedAt`   | DateTime | No       | --      |                                                  |
| `createdAt`    | DateTime | Yes      | now     |                                                  |

**Indexes:** `(ownerUserId, readAt)`, `(ownerUserId, createdAt)`, `(occasionId)`.

---

### `AnalyticsEvent`
Lightweight analytics event log for god-mode dashboard metrics. Not a full event sourcing system.

| Field      | Type     | Required | Default | Notes                                        |
|------------|----------|----------|---------|----------------------------------------------|
| `id`       | String   | Yes      | cuid    |                                              |
| `event`    | String   | Yes      | --      | Event name                                   |
| `userId`   | String   | No       | --      | Associated user (nullable)                   |
| `props`    | Json     | No       | --      | Structured event properties                  |
| `createdAt`| DateTime | Yes      | now     |                                              |

---

### `BirthdayReminderDelivery`
One row per `(birthdayUserId, recipientUserId, occurrenceKey, reminderKind)` tuple — the dedup boundary for the birthday-reminder scheduler. The scheduler upserts a row before sending; the unique constraint guarantees that two scheduler ticks racing on the same offset will only send once.

| Field               | Type     | Required | Default | Notes                                                                                         |
|---------------------|----------|----------|---------|-----------------------------------------------------------------------------------------------|
| `id`                | String   | Yes      | cuid    |                                                                                               |
| `birthdayUserId`    | String   | Yes      | —       | The user whose birthday triggered the delivery                                                |
| `recipientUserId`   | String   | Yes      | —       | The user receiving the bot DM                                                                 |
| `occurrenceKey`     | String   | Yes      | —       | The target birthday occurrence in `YYYY-MM-DD` form (e.g. `"2026-05-15"`). Feb-29 → Feb-28 in non-leap years |
| `reminderKind`      | String   | Yes      | —       | `friend_14d` \| `friend_7d` \| `friend_1d` \| `friend_today` \| `owner_30d` \| `owner_14d` \| `owner_7d` \| `owner_today` |
| `status`            | String   | Yes      | `"pending"` | `pending` \| `sent` \| `skipped` \| `failed` \| `deferred`                                |
| `skipReason`        | String   | No       | —       | One of: `no_public_wishlist`, `no_active_public_items`, `primary_wishlist_unavailable`, `profile_private`, `birthday_hidden`, `friend_reminders_disabled`, `recipient_opted_out`, `muted`, `no_chat_id`, `bot_blocked`, `daily_cap`, `pro_required`, `self_excluded`, `no_problem_to_solve` |
| `failureReason`     | String   | No       | —       | Free-text error from Telegram API on `status = 'failed'`                                      |
| `deferredUntil`     | DateTime | No       | —       | When `status = 'deferred'`, the next attempt time (e.g. next MSK 10:00 after a daily-cap defer) |
| `telegramMessageId` | String   | No       | —       | Bot DM message id, populated on `status = 'sent'`                                             |
| `targetType`        | String   | Yes      | —       | `wishlist` \| `profile` \| `own_wishlist` \| `create_wishlist` \| `wishlists_index`            |
| `targetId`          | String   | No       | —       | Wishlist id (or other entity id) for deep-link routing                                        |
| `deepLinkPayload`   | String   | Yes      | —       | The `br_<deliveryId>` payload that the bot keyboard's WebApp button uses                      |
| `relationType`      | String   | No       | —       | `subscription` \| `wishlist_subscription` \| `reservation` \| `mixed` — how the recipient relates to the birthday user |
| `sentAt`            | DateTime | No       | —       |                                                                                               |
| `clickedAt`         | DateTime | No       | —       | Set by `GET /tg/birthday-reminders/resolve/:deliveryId` on Mini App boot                      |
| `createdAt`         | DateTime | Yes      | now     |                                                                                               |
| `updatedAt`         | DateTime | Yes      | auto    |                                                                                               |

**Indexes:** `(status, deferredUntil)`, `(recipientUserId, sentAt)`, `(birthdayUserId, occurrenceKey)`, `(sentAt)`, `(createdAt)`.

**Unique constraint:** `(birthdayUserId, recipientUserId, occurrenceKey, reminderKind)` — the dedup contract; a race on insert raises `P2002` and the scheduler skips that send.

---

### `BirthdayReminderMute`
Per-recipient mute of a specific birthday user. Set via the bot inline keyboard ("🔕 Не напоминать об этом человеке") or via `POST /tg/birthday-reminders/mute`.

| Field                  | Type     | Required | Default | Notes                                            |
|------------------------|----------|----------|---------|--------------------------------------------------|
| `id`                   | String   | Yes      | cuid    |                                                  |
| `userId`               | String   | Yes      | —       | The recipient who muted                          |
| `mutedBirthdayUserId`  | String   | Yes      | —       | The birthday user being muted                    |
| `createdAt`            | DateTime | Yes      | now     |                                                  |

**Unique constraint:** `(userId, mutedBirthdayUserId)` — idempotent upsert.

---

### Secret Santa Models

The Secret Santa subsystem adds 20 models. Key models are summarized below; see `packages/db/prisma/schema.prisma` for full field definitions.

| Model | Purpose |
|---|---|
| `SantaGlobalConfig` | Singleton global master switch (santaEnabled flag) |
| `SantaSeasonalBroadcastLog` | Prevents duplicate seasonal broadcast notifications per year |
| `SantaSeasonConfig` | Optional per-year admin override for season dates |
| `SantaCampaign` | A Secret Santa event with participants, budget, and invite token |
| `SantaParticipant` | A user participating in a campaign with optional linked wishlist |
| `SantaRound` | A draw round within a campaign (supports multi-round) |
| `SantaAssignment` | Giver-receiver pairing within a round |
| `SantaGiftProgress` | Immutable log of gift status transitions |
| `SantaExclusion` | Pair-wise exclusion for draw constraints |
| `SantaExclusionGroup` | Named exclusion group (e.g., "Family") |
| `SantaExclusionGroupMember` | Member of an exclusion group |
| `SantaHintRequest` | Anonymous hint request from giver to receiver (48h TTL) |
| `SantaChatMessage` | Campaign group chat message (USER or SYSTEM) |
| `SantaChatReadCursor` | Per-participant read cursor for unread tracking |
| `SantaChatMute` | Per-participant mute for chat notifications |
| `SantaPoll` | Campaign-scoped poll with optional anonymity |
| `SantaPollVote` | Individual vote on a poll |
| `SantaNotification` | Push notification with dedup keys (16 types) |
| `SantaAdminAuditLog` | Immutable organizer action log |
| `SantaExitRequest` | Participant request to leave an active campaign |
| `SantaItemReservation` | Santa-specific item claim (distinct from general reservations) |
| `SantaParticipantAlias` | Round-scoped anonymous identity (adjective + animal + emoji) |

---

### `WishlistCategory`
A named category within a wishlist for organizing items into groups (e.g. "Книги", "Электроника"). Items can optionally belong to one category.

| Field       | Type     | Required | Default | Notes                                               |
|-------------|----------|----------|---------|-----------------------------------------------------|
| `id`        | String   | Yes      | cuid    |                                                     |
| `wishlistId`| String   | Yes      | --      | FK → `Wishlist` (CASCADE delete)                    |
| `name`      | String   | Yes      | --      | Category display name                               |
| `sortOrder` | Int      | Yes      | `0`     | Manual sort order within the wishlist               |
| `isDefault` | Boolean  | Yes      | `false` | Whether this is the default category                |
| `createdAt` | DateTime | Yes      | now     |                                                     |
| `updatedAt` | DateTime | Yes      | auto    |                                                     |

**Relations:**
- `wishlist` → `Wishlist`
- `items[]` → `Item`

**Indexes:** `(wishlistId, sortOrder)`, `(wishlistId, isDefault)`

---

### Group Gift Models

The Group Gift subsystem enables splitting a gift purchase among multiple participants. One group gift can exist per item; the organizer creates it, and participants join via an invite token.

### `GroupGift`
A group gift collection campaign linked to a single wish item.

| Field             | Type              | Required | Default | Notes                                                      |
|-------------------|-------------------|----------|---------|------------------------------------------------------------|
| `id`              | String            | Yes      | cuid    |                                                            |
| `itemId`          | String            | Yes      | --      | Unique FK → `Item` (CASCADE delete). One group gift per item |
| `organizerUserId` | String            | Yes      | --      | FK → `User` (CASCADE delete)                              |
| `targetAmount`    | Int               | Yes      | --      | Target amount in whole units (e.g. `32990` = 32 990 ₽)    |
| `currency`        | `Currency`        | Yes      | `RUB`   | Currency for the target amount                             |
| `deadline`        | Date              | No       | --      | Optional deadline for the collection                       |
| `note`            | VarChar(500)      | No       | --      | Organizer's note for participants                          |
| `pinnedInfo`      | VarChar(1000)     | No       | --      | Pinned info message visible to all participants            |
| `status`          | `GroupGiftStatus` | Yes      | `OPEN`  |                                                            |
| `inviteToken`     | String            | Yes      | cuid    | Unique invite token for joining the group gift             |
| `completedAt`     | DateTime          | No       | --      | When the collection was completed                          |
| `cancelledAt`     | DateTime          | No       | --      | When the collection was cancelled                          |
| `createdAt`       | DateTime          | Yes      | now     |                                                            |
| `updatedAt`       | DateTime          | Yes      | auto    |                                                            |

**Relations:**
- `item` → `Item`
- `organizer` → `User`
- `participants[]` → `GroupGiftParticipant`
- `messages[]` → `GroupGiftMessage`

**Indexes:** `(organizerUserId)`, `(inviteToken)`, `(status)`

---

### `GroupGiftParticipant`
A user's participation (pledge) in a group gift.

| Field        | Type     | Required | Default | Notes                                       |
|--------------|----------|----------|---------|---------------------------------------------|
| `id`         | String   | Yes      | cuid    |                                             |
| `groupGiftId`| String   | Yes      | --      | FK → `GroupGift` (CASCADE delete)           |
| `userId`     | String   | Yes      | --      | FK → `User` (CASCADE delete)               |
| `amount`     | Int      | Yes      | --      | Pledged amount in whole units               |
| `displayName`| String   | Yes      | --      | Display name snapshot at join time          |
| `joinedAt`   | DateTime | Yes      | now     |                                             |
| `updatedAt`  | DateTime | Yes      | auto    |                                             |

**Unique constraint:** `(groupGiftId, userId)` — one participation per user per group gift.

**Indexes:** `(userId)`, `(groupGiftId)`

---

### `GroupGiftMessage`
A chat message within a group gift conversation.

| Field          | Type     | Required | Default  | Notes                                     |
|----------------|----------|----------|----------|--------------------------------------------|
| `id`           | String   | Yes      | cuid     |                                            |
| `groupGiftId`  | String   | Yes      | --       | FK → `GroupGift` (CASCADE delete)          |
| `senderUserId` | String   | Yes      | --       | FK → `User` (CASCADE delete)              |
| `text`         | VarChar(2000) | Yes | --       | Message text                               |
| `type`         | String   | Yes      | `"USER"` | `USER` (human message) or `SYSTEM` (auto-generated) |
| `createdAt`    | DateTime | Yes      | now      |                                            |

**Indexes:** `(groupGiftId, createdAt)`, `(senderUserId)`

---

### `WishlistItemPlacement`
Junction table that allows a single item to appear in multiple wishlists. Enables cross-list item references without duplicating item records.

| Field        | Type     | Required | Default | Notes                                            |
|--------------|----------|----------|---------|--------------------------------------------------|
| `id`         | String   | Yes      | cuid    |                                                  |
| `wishlistId` | String   | Yes      | —       | FK → `Wishlist` (CASCADE delete)                 |
| `itemId`     | String   | Yes      | —       | FK → `Item` (CASCADE delete)                     |
| `position`   | Int      | Yes      | `0`     | Sort order within the target wishlist            |
| `categoryId` | String   | No       | —       | FK → `WishlistCategory` (SET NULL)               |
| `addedAt`    | DateTime | Yes      | now     |                                                  |
| `updatedAt`  | DateTime | Yes      | auto    |                                                  |

**Unique constraint:** `(wishlistId, itemId)`
**Indexes:** `itemId`, `(wishlistId, position)`, `categoryId`

---

### `SecretReservation`
A reservation where the wishlist owner cannot see who reserved the item. The reserver's identity is hidden from the owner for the duration of the reservation.

| Field                    | Type                      | Required | Default  | Notes                                                    |
|--------------------------|---------------------------|----------|----------|----------------------------------------------------------|
| `id`                     | String                    | Yes      | cuid     |                                                          |
| `itemId`                 | String                    | Yes      | —        | FK → `Item` (CASCADE delete)                             |
| `reserverUserId`         | String                    | Yes      | —        | FK → `User` (CASCADE delete)                             |
| `status`                 | `SecretReservationStatus` | Yes      | `ACTIVE` |                                                          |
| `snapshot`               | JSONB                     | Yes      | —        | Item data snapshot at reservation time                   |
| `updatesAcknowledgedAt`  | DateTime                  | No       | —        | When reserver last acknowledged item changes             |
| `note`                   | VarChar(500)              | No       | —        | Private note to self                                     |
| `createdAt`              | DateTime                  | Yes      | now      |                                                          |
| `updatedAt`              | DateTime                  | Yes      | auto     |                                                          |
| `cancelledAt`            | DateTime                  | No       | —        |                                                          |
| `fulfilledAt`            | DateTime                  | No       | —        |                                                          |
| `convertedAt`            | DateTime                  | No       | —        | When promoted to a public reservation                    |

**Unique constraint:** `(itemId, reserverUserId)`
**Indexes:** `(reserverUserId, status)`, `itemId`

---

### `ProfileSubscription`
A follow relationship where one user subscribes to another user's public profile/showcase.

| Field          | Type     | Required | Default | Notes                                     |
|----------------|----------|----------|---------|-------------------------------------------|
| `id`           | String   | Yes      | cuid    |                                           |
| `subscriberId` | String   | Yes      | —       | FK → `User` (CASCADE delete)              |
| `targetUserId` | String   | Yes      | —       | FK → `User` (CASCADE delete)              |
| `createdAt`    | DateTime | Yes      | now     |                                           |

**Unique constraint:** `(subscriberId, targetUserId)`
**Indexes:** `subscriberId`, `targetUserId`

---

### `CuratedSelection`
A temporary share link containing a curated subset of items from a wishlist. PRO feature; owner controls expiry and can revoke early.

| Field           | Type         | Required | Default | Notes                                     |
|-----------------|--------------|----------|---------|-------------------------------------------|
| `id`            | String       | Yes      | cuid    |                                           |
| `wishlistId`    | String       | Yes      | —       | FK → `Wishlist` (CASCADE delete)          |
| `ownerId`       | String       | Yes      | —       | FK → `User` (CASCADE delete)              |
| `title`         | VarChar(100) | Yes      | —       | Display name                              |
| `shareToken`    | String       | Yes      | —       | Unique token for public link              |
| `viewCount`     | Int          | Yes      | `0`     | Total views                               |
| `deactivatedAt` | DateTime     | No       | —       | When owner revoked the link               |
| `expiresAt`     | DateTime     | Yes      | —       | Auto-expiry timestamp                     |
| `createdAt`     | DateTime     | Yes      | now     |                                           |

**Indexes:** `ownerId`, `wishlistId`, `shareToken` (unique), `expiresAt`

---

### `CuratedSelectionItem`
An item snapshot within a curated selection. Snapshots are taken at creation time; `originalItemId` is nullable to support deleted source items.

| Field               | Type         | Required | Default | Notes                                              |
|---------------------|--------------|----------|---------|----------------------------------------------------|
| `id`                | String       | Yes      | cuid    |                                                    |
| `curatedSelectionId`| String       | Yes      | —       | FK → `CuratedSelection` (CASCADE delete)           |
| `originalItemId`    | String       | No       | —       | Source item ID (no FK; nullable for deleted items) |
| `position`          | Int          | Yes      | `0`     |                                                    |
| `title`             | String       | Yes      | —       | Snapshot                                           |
| `priceText`         | String       | No       | —       | Snapshot                                           |
| `currency`          | `Currency`   | Yes      | `RUB`   | Snapshot                                           |
| `imageUrl`          | String       | No       | —       | Snapshot                                           |
| `url`               | String       | No       | —       | Snapshot                                           |
| `description`       | VarChar(500) | No       | —       | Snapshot                                           |

**Index:** `curatedSelectionId`

---

### `CuratedSelectionSubscription`
A user subscribing to a curated selection to receive updates when the selection changes.

| Field               | Type     | Required | Default | Notes                                         |
|---------------------|----------|----------|---------|-----------------------------------------------|
| `id`                | String   | Yes      | cuid    |                                               |
| `curatedSelectionId`| String   | Yes      | —       | FK → `CuratedSelection` (CASCADE delete)      |
| `subscriberId`      | String   | Yes      | —       | FK → `User` (CASCADE delete)                  |
| `createdAt`         | DateTime | Yes      | now     |                                               |

**Unique constraint:** `(curatedSelectionId, subscriberId)`
**Indexes:** `subscriberId`, `curatedSelectionId`

---

### Referral Models

The referral subsystem enables invite-a-friend PRO rewards. It is gated behind `ReferralProgramConfig.enabled` (default `false`).

### `ReferralAttribution`
Records the referral relationship between an inviter and invitee. One record per invitee (unique on `invitedUserId`). Tracks qualification state, fraud signals, and program config snapshot.

Key fields: `inviterUserId` (FK → `User`), `invitedUserId` (FK → `User`, unique), `referralCode`, `source`, `status` (`ReferralAttributionStatus`), `windowDeadlineAt` (14-day qualification deadline), `fraudScore`, `ipHash`, `deviceFingerprintHash`, fraud signal JSONB, config snapshot fields.

**Unique constraint:** `invitedUserId`
**Indexes:** `inviterUserId`, `status`, `windowDeadlineAt`

---

### `ReferralReward`
Records a PRO days reward granted to an inviter. Idempotent on `idempotencyKey`.

Key fields: `userId` (FK → `User`), `attributionId` (nullable FK → `ReferralAttribution`), `rewardType` (default `"pro_days"`), `rewardValueDays`, `status` (`ReferralRewardStatus`), `grantStrategy`, `previousExpiryAt`, `newExpiryAt`, `grantedAt`, `revokedAt`, `idempotencyKey` (unique).

**Indexes:** `userId`, `attributionId`, `status`

---

### `ReferralProgramConfig`
Singleton configuration row (`id = "default"`) controlling all referral program parameters. All referral logic reads from this record.

Key fields: `enabled` (default `false`), `rewardDaysInviter` (default `30`), `qualificationWindowDays` (default `14`), `monthlyRewardCap` (default `3`), `yearlyRewardCap` (default `12`), `fraudAutoRejectThreshold` (default `80`), fraud signal weights (JSONB), entry point toggles, notification toggles, `rolloutPercent` (default `10`).

---

### `IdempotencyKey`
Idempotency-Key store for state-changing API routes (Wave 1 P0, shipped 2026-04-29). One row per `(key + actorKey + method + path)` tuple. On replay, the stored response is returned when `requestHash` matches; on hash mismatch the API returns **409**. Rows are TTL'd (default 24 h, billing endpoints 7 d) and purged by an in-process cleanup job once `expiresAt` passes.

`path` holds the route pattern (e.g. `/tg/wishlists/:id/items`), not the literal URL. Literal IDs and query params are folded into `requestHash` so two reservations of different items can't collide on the same key. `responseBody` is capped at ~64 KB; oversized responses are stored with `body = null` and `responseTruncated = true`. Multipart endpoints opt out of replay and are stored the same way (lock-only).

Cross-link: see [docs/API_SECURITY.md](API_SECURITY.md) for the full security contract.

| Field               | Type               | Required | Default | Notes                                                                                          |
|---------------------|--------------------|----------|---------|------------------------------------------------------------------------------------------------|
| `id`                | String             | Yes      | cuid    |                                                                                                |
| `key`               | String             | Yes      | --      | The header value (hashed before storage / log)                                                 |
| `userId`            | String             | No       | --      |                                                                                                |
| `actorHash`         | String             | No       | --      | Logical actor identity (tgActorHash UUID); null for unauth callers                             |
| `actorKey`          | String             | Yes      | --      | Dedup key — never null. Equals `actorHash` for auth, `ip:<hash>` for unauth                     |
| `method`            | String             | Yes      | --      | HTTP verb                                                                                       |
| `path`              | String             | Yes      | --      | Route pattern (e.g. `/tg/wishlists/:id/items`)                                                 |
| `requestHash`       | String             | Yes      | --      | Hash of body + literal IDs + query                                                             |
| `responseStatus`    | Int                | No       | --      |                                                                                                |
| `responseBody`      | Json               | No       | --      | Capped ~64 KB; null when truncated or for multipart                                            |
| `responseTruncated` | Boolean            | Yes      | `false` |                                                                                                |
| `status`            | IdempotencyStatus  | Yes      | --      | `processing` / `completed` / `failed`                                                          |
| `lockedUntil`       | DateTime           | No       | --      | When the in-flight lock expires (used for `processing` rows)                                   |
| `createdAt`         | DateTime           | Yes      | now     |                                                                                                |
| `updatedAt`         | DateTime           | Yes      | auto    |                                                                                                |
| `expiresAt`         | DateTime           | Yes      | --      | TTL — purged by in-process cleanup job                                                          |

**Unique constraint:** `(key, actorKey, method, path)`.

**Indexes:** `(expiresAt)`, `(actorHash, createdAt)`.

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
  │              │                  ├──► Comment (threaded)   ││
  │              │                  ├──► CommentReadCursor ◄──┤│
  │              │                  ├──► ItemTag              ││
  │              │                  ├──► Hint ◄───────────────┤│
  │              │                  ├──► SantaItemReservation ││
  │              │                  ├──► SecretReservation ◄──┤│
  │              │                  └──► GroupGift?           ││
  │              │                         │                  ││
  │              │                         ├──► Participant[] ││
  │              │                         └──► Message[]     ││
  │              │                                            ││
  │              ├── has ──► WishlistCategory[] ◄── Item      ││
  │              ├── has ──► Tag ◄── ItemTag                  ││
  │              ├── has ──► CuratedSelection[]               ││
  │              │              ├──► CuratedSelectionItem[]   ││
  │              │              └──► CuratedSelectionSubscription[] ◄──┤│
  │              │                                            ││
  │              └── followed by ──► WishlistSubscription ◄───┘│
  │                                     └──► SubscriptionUnread │
  │                                                             │
  ├── has ──► UserProfile                                       │
  ├── has ──► Subscription ──► PaymentEvent                     │
  ├── has ──► UserAddOn[] (permanent add-ons)                   │
  ├── has ──► UserCredits (consumable balances)                 │
  ├── has ──► Purchase[] (SKU purchase audit log)               │
  ├── has ──► UserOnboardingState[]                             │
  ├── has ──► GiftOccasion[] ──► GiftOccasionIdea[]             │
  ├── opens ──► SupportTicket ──► SupportMessage                │
  │                                                             │
  ├── owns ──► SantaCampaign ──► SantaParticipant[]             │
  │              ├──► SantaRound[] ──► SantaAssignment[]        │
  │              ├──► SantaChatMessage[] / ReadCursor / Mute    │
  │              ├──► SantaPoll[] ──► SantaPollVote[]            │
  │              ├──► SantaHintRequest[]                         │
  │              ├──► SantaExclusionGroup[] ──► Member[]         │
  │              ├──► SantaExitRequest[]                         │
  │              ├──► SantaNotification[]                        │
  │              └──► SantaAdminAuditLog[]                       │
  │                                                             │
  ├── has ──► PromoRedemption ◄── PromoCampaign                 │
  ├── has ──► DegradationState (tracks PRO→FREE transitions)    │
  ├── has ──► LifecycleTouch[] (winback / engagement messaging) │
  ├── follows ──► ProfileSubscription[] (profile follows)       │
  └── has ──► ReferralAttribution (as invitee, unique)          │
               └──► ReferralReward[] (PRO days to inviter)      │
                                                                │
Item ──► WishlistItemPlacement[] ──► Wishlist (cross-list refs) │
                                                                │
SupportSession (standalone, TTL-based routing)                  │
ServiceHeartbeat (standalone, liveness ping)                    │
AnalyticsEvent (standalone, god-mode metrics)                   │
ReferralProgramConfig (singleton config, id="default")          │
SantaGlobalConfig / SantaSeasonConfig / SantaSeasonalBroadcastLog │
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
| User -> PromoRedemption              | 1 : many         | User promo code usage history                  |
| User -> DegradationState             | 1 : 0..1         | Tracks PRO->FREE transitions                   |
| User -> LifecycleTouch               | 1 : many         | Winback / engagement messaging log             |
| User -> UserAddOn                    | 1 : many         | Purchased permanent add-ons                    |
| User -> UserCredits                  | 1 : 0..1         | Consumable credit balances                     |
| User -> Purchase                     | 1 : many         | SKU purchase audit log                         |
| User -> UserOnboardingState          | 1 : many         | Onboarding flow state per key/version          |
| User -> GiftOccasion                 | 1 : many         | Gift notebook occasions                        |
| GiftOccasion -> GiftOccasionIdea     | 1 : many         | Gift ideas within an occasion                  |
| User -> SantaCampaign (owned)        | 1 : many         | Campaigns organized by user                    |
| User -> SantaParticipant             | 1 : many         | Campaign participations                        |
| SantaCampaign -> SantaRound          | 1 : many         | Draw rounds within a campaign                  |
| SantaRound -> SantaAssignment        | 1 : many         | Giver-receiver pairings per round              |
| SantaAssignment -> SantaItemReservation | 1 : many      | Santa-specific item claims                     |
| Wishlist -> WishlistCategory           | 1 : many         | Item categories within a wishlist              |
| WishlistCategory -> Item               | 1 : many         | Items in a category (optional FK)              |
| Item -> GroupGift                      | 1 : 0..1        | One group gift per item                        |
| User -> GroupGift (organized)          | 1 : many         | Group gifts organized by user                  |
| GroupGift -> GroupGiftParticipant      | 1 : many         | Participants in a group gift                   |
| GroupGift -> GroupGiftMessage          | 1 : many         | Chat messages in a group gift                  |
| User -> GroupGiftParticipant           | 1 : many         | User's group gift participations               |
| Wishlist × Item → WishlistItemPlacement | many : many    | Allows one item to appear in multiple wishlists |
| Item → SecretReservation               | 1 : many         | Hidden reservations (unique per item+reserver) |
| User → SecretReservation               | 1 : many         | Secret reservations made by this user          |
| User × User → ProfileSubscription      | many : many      | Profile/showcase follow relationships          |
| Wishlist → CuratedSelection            | 1 : many         | Curated item subsets (PRO feature)             |
| CuratedSelection → CuratedSelectionItem | 1 : many        | Snapshotted items within a selection           |
| CuratedSelection → CuratedSelectionSubscription | 1 : many | Subscribers watching a selection             |
| User → ReferralAttribution (inviter)   | 1 : many         | Referrals sent by this user                    |
| User → ReferralAttribution (invitee)   | 1 : 0..1         | Unique; one attribution per invitee            |
| ReferralAttribution → ReferralReward   | 1 : many         | PRO day rewards from successful referrals      |
| User → ReferralReward                  | 1 : many         | All rewards granted to this user               |

---

## Indexes

| Model            | Index                                     | Purpose                                                   |
|------------------|-------------------------------------------|-----------------------------------------------------------|
| `Item`           | `wishlistId`                              | Fetch all items for a wishlist                            |
| `Item`           | `purgeAfter`                              | Background job to hard-delete soft-deleted items          |
| `Item`           | `(wishlistId, priority, position)`        | Ordered item listing within a wishlist                    |
| `Item`           | `categoryId`                              | Fetch items by category                                   |
| `SupportSession` | `(telegramChatId, promptMessageId)`       | ForceReply routing lookup                                 |
| `SupportSession` | `expiresAt`                               | TTL cleanup of expired sessions                           |
| `WishlistCategory` | `(wishlistId, sortOrder)`               | Ordered category listing within a wishlist                |
| `WishlistCategory` | `(wishlistId, isDefault)`               | Lookup default category for a wishlist                    |
| `GroupGift`      | `organizerUserId`                         | Fetch group gifts by organizer                            |
| `GroupGift`      | `inviteToken`                             | Lookup group gift by invite token                         |
| `GroupGift`      | `status`                                  | Filter group gifts by status                              |
| `GroupGiftParticipant` | `userId`                            | Fetch participations by user                              |
| `GroupGiftParticipant` | `groupGiftId`                       | Fetch participants for a group gift                       |
| `GroupGiftMessage` | `(groupGiftId, createdAt)`              | Chronological message listing within a group gift         |
| `GroupGiftMessage`       | `senderUserId`                            | Fetch messages by sender                                  |
| `ReservationMeta`        | `(isSmartRes, active, expiresAt)`         | Smart-res expiry sweep job                                |
| `SecretReservation`      | `(reserverUserId, status)`                | Fetch active secret reservations by reserver              |
| `SecretReservation`      | `itemId`                                  | Fetch secret reservations for an item                     |
| `WishlistItemPlacement`  | `itemId`                                  | All placements for an item                                |
| `WishlistItemPlacement`  | `(wishlistId, position)`                  | Ordered item listing via placements                       |
| `WishlistItemPlacement`  | `categoryId`                              | Placements by category                                    |
| `ProfileSubscription`    | `subscriberId`                            | Fetch profiles followed by a user                         |
| `ProfileSubscription`    | `targetUserId`                            | Fetch followers of a profile                              |
| `CuratedSelection`       | `ownerId`                                 | Fetch selections by owner                                 |
| `CuratedSelection`       | `wishlistId`                              | Fetch selections for a wishlist                           |
| `CuratedSelection`       | `shareToken`                              | Public link lookup (unique)                               |
| `CuratedSelection`       | `expiresAt`                               | Expiry cleanup job                                        |
| `CuratedSelectionItem`   | `curatedSelectionId`                      | Items within a selection                                  |
| `CuratedSelectionSubscription` | `subscriberId`                      | Selections a user subscribes to                           |
| `CuratedSelectionSubscription` | `curatedSelectionId`                | Subscribers of a selection                                |
| `ReferralAttribution`    | `inviterUserId`                           | Referrals sent by a user                                  |
| `ReferralAttribution`    | `status`                                  | Filter attributions by status                             |
| `ReferralAttribution`    | `windowDeadlineAt`                        | Qualification deadline sweep                              |
| `ReferralReward`         | `userId`                                  | Rewards granted to a user                                 |
| `ReferralReward`         | `attributionId`                           | Rewards for a specific attribution                        |
| `ReferralReward`         | `status`                                  | Filter rewards by status                                  |

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
