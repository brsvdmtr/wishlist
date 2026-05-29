# WishBoard — User Flows

> Source of truth for all user journeys. Last updated: 2026-05-29 · Branch: main
>
> This document reflects the product as implemented, not aspirational features.

---

## Table of Contents

1. [Onboarding / First Launch (v2)](#flow-1-onboarding--first-launch-v2)
2. [Creating a Wishlist](#flow-2-creating-a-wishlist)
3. [Adding a Wish (Manual)](#flow-3-adding-a-wish-manual)
4. [Adding a Wish via URL Import (free quota + paid credits)](#flow-4-adding-a-wish-via-url-import-free-quota--paid-credits)
5. [Sharing a Wishlist](#flow-5-sharing-a-wishlist)
6. [Guest Viewing a Wishlist](#flow-6-guest-viewing-a-wishlist)
7. [Reservation (Surprise Mode)](#flow-7-reservation-surprise-mode)
8. [Comments (PRO)](#flow-8-comments-pro)
9. [Hints (free quota + paid packs)](#flow-9-hints-free-quota--paid-packs)
10. [Subscribing to a Friend's Wishlist (PRO)](#flow-10-subscribing-to-a-friends-wishlist-pro)
11. [Editing a Wish](#flow-11-editing-a-wish)
12. [Completing / Archiving a Wish](#flow-12-completing--archiving-a-wish)
13. [Archiving a Wishlist](#flow-13-archiving-a-wishlist)
14. [Notification Settings (PRO)](#flow-14-notification-settings-pro)
15. [Wishlist Privacy Settings (PRO)](#flow-15-wishlist-privacy-settings-pro)
16. [PRO Subscription Purchase](#flow-16-pro-subscription-purchase)
17. [PRO Subscription Cancellation](#flow-17-pro-subscription-cancellation)
18. [Support / Contact](#flow-18-support--contact)
19. [Guest Detecting They Are the Owner](#flow-19-guest-detecting-they-are-the-owner)
20. [Gift Notes](#flow-20-gift-notes)
21. [Add-on Purchase](#flow-21-add-on-purchase)
22. [Promo Code Redemption](#flow-22-promo-code-redemption)
23. [Lifecycle / Degradation](#flow-23-lifecycle--degradation)
24. [Change Badges / Unread](#flow-24-change-badges--unread)
25. [Group Gift (Совместный подарок)](#flow-25-group-gift-совместный-подарок)
26. [Wishlist Categories](#flow-26-wishlist-categories)
27. [Don't Gift (Не дарить)](#flow-27-dont-gift-не-дарить)
28. [Secret Reservations](#flow-28-secret-reservations)
29. [Smart Reservations](#flow-29-smart-reservations)
30. [Showcase (PRO profile)](#flow-30-showcase-pro-profile)
31. [Curated Selections](#flow-31-curated-selections)
32. [Profile Subscriptions](#flow-32-profile-subscriptions)
33. [Referral Program](#flow-33-referral-program)
34. [Item Placements (cross-wishlist)](#flow-34-item-placements-cross-wishlist)
35. [Birthday Reminders](#flow-35-birthday-reminders)
36. [Events Calendar v2.1](#flow-36-events-calendar-v21)
37. [Guest → Account Claim (E11 post-reservation CTA)](#flow-37-guest--account-claim-e11-post-reservation-cta)

---

## Plans Reference

| Feature | FREE | PRO |
|---|---|---|
| Wishlists | 2 | 10 |
| Items per wishlist | 20 | 70 |
| Participants (reservers) | 10 | 20 |
| Subscriptions | 2 | 5 |
| Categories per wishlist | 1 | Unlimited (sentinel) |
| Comments | — | Yes |
| URL Import | Free monthly quota (`FREE_IMPORT_QUOTA_PER_MONTH`, default 5/UTC-month) + paid `import_pack_*` credits | Unlimited |
| Hints | Free monthly quota (`FREE_HINT_QUOTA_PER_MONTH`, default 3/UTC-month, charged on delivery) + paid `hints_pack_*` credits | Unlimited |
| Visibility: PUBLIC_PROFILE / PRIVATE | — | Yes |
| allowSubscriptions: NOBODY | — | Yes |
| commentPolicy: SUBSCRIBERS | — | Yes |
| Notification settings | — | Yes |
| Gift Notes | 19 XTR one-time | Included |

> **URL Import & Hints are no longer hard PRO gates** (2026-05). FREE users get a monthly free quota plus optional paid credit packs; PRO is unlimited. **Categories** are no longer PRO-only — FREE gets 1 user category per wishlist (the default "Без категории" section doesn't count), PRO is effectively unlimited. **Participant limit** for FREE was raised 5 → 10. See Flow 4 (URL Import), Flow 9 (Hints), Flow 26 (Categories). PRO gates that still hard-block return a unified paywall envelope (402 / 403 / 409) via `services/paywall.ts`.

---

## Flow 1: Onboarding / First Launch (v2)

**Actor:** New user, no prior session.

> v1 (single-screen welcome + demo item) is deprecated. All new users enter the v2 multi-step onboarding.

**Screens (in order):** `onboarding-entry` -> `onboarding-try` -> `onboarding-success` OR `onboarding-recovery` -> `onboarding-catalog` -> `onboarding-create-wishlist` -> `onboarding-share`

### Market Segments

The onboarding catalog is locale-aware. Two market segments determine which template items are shown:

| Segment | Locale trigger | Example catalog items |
|---|---|---|
| `ru` | `ru` locale | Ozon, Wildberries, Lamoda, Goldapple, Bork, etc. |
| `global` | All other locales | Amazon, IKEA, Sephora, Nike, Apple, etc. |

### Step-by-step

1. User finds or is linked to the WishBoard bot in Telegram.
2. User sends `/start` to the bot.
3. Bot registers the menu button in the Telegram chat.
4. User taps the menu button; Telegram opens the Mini App WebView.
5. Mini App initialises: reads `window.Telegram.WebApp.initData` (contains `tg_user` payload).
6. Server validates the HMAC signature of `initData`.
7. Server calls `getOrCreateTgUser()` — creates a new user record if one does not exist.
8. App calls `GET /tg/onboarding/status`. If the user is eligible (no wishlists, onboarding not completed/dismissed), the server returns `{ eligible: true }` with variant `v2_try`.
9. **onboarding-entry** — Welcome screen with three feature highlights (any item, share without signup, no spoilers). User taps "Try it" CTA. App calls `POST /tg/onboarding/start` with `{ onboardingKey: 'hello_activation' }`.
10. **onboarding-try** — User can paste a product URL to try the import feature (trial badge shown). App calls `POST /tg/onboarding/try-import` with the URL.
    - On success -> `onboarding-success`
    - On failure -> `onboarding-recovery`
    - User can skip -> `onboarding-catalog`
    - User can choose "Add manually" -> `onboarding-catalog`
11. **onboarding-success** — Shows the imported item preview with a checkmark. User can add more items (returns to `onboarding-try`) or continue to `onboarding-create-wishlist`.
12. **onboarding-recovery** — Shown when URL import fails. Three options: retry (back to `onboarding-try`), add manually (-> `onboarding-catalog`), or browse catalog (-> `onboarding-catalog`).
13. **onboarding-catalog** — Grid of template gift items from the locale-appropriate catalog (ru/global). User selects items they like. App calls `POST /tg/onboarding/catalog-select` with selected keys. User can also skip this step.
14. **onboarding-create-wishlist** — User enters a wishlist title. Shows count of items ready to be added (imported + catalog selections). App calls `POST /tg/onboarding/create-wishlist` which creates the wishlist and moves items into it.
15. **onboarding-share** — Two sharing options: share the wishlist link and reserve a friend's gift. User taps "Done" to complete onboarding.
16. App calls `POST /tg/onboarding/complete` with a reason (`try_import_completed` / `catalog_selected`). The home screen loads with the newly created wishlist.

**Back-navigation logic:**
- `onboarding-try` -> `onboarding-entry`
- `onboarding-success` / `onboarding-recovery` -> `onboarding-try`
- `onboarding-catalog` -> `onboarding-try`
- `onboarding-create-wishlist` -> `onboarding-success` (if import result exists) OR `onboarding-catalog` (if catalog selected) OR `onboarding-try`
- `onboarding-share` -> `onboarding-create-wishlist` (if wishlist created) OR earlier screens

**Edge cases:**
- If `initData` HMAC validation fails, the server returns `401`. The Mini App shows an error.
- If the user already has wishlists or previously completed/dismissed onboarding, the status endpoint returns `{ eligible: false }` and the user goes directly to the home screen.
- Dismissing onboarding at any point calls `POST /tg/onboarding/dismiss`.
- The onboarding check runs once per session (guarded by `onboardingCheckedRef`).

---

## Flow 2: Creating a Wishlist

**Actor:** Authenticated owner.

1. From the home screen (`my-wishlists`), user taps the **"+"** button.
2. A creation form opens with two fields:
   - **Name** (text, required)
   - **Emoji** (emoji picker, optional)
3. User fills in the name and optionally selects an emoji.
4. User submits the form.
5. App sends `POST /tg/wishlists` with `{ name, emoji }`.
6. **On success (201):** The new wishlist is appended to the list on the home screen. The user is navigated to the new wishlist's item view.
7. **On 402 (limit reached):** The app shows an **upsell sheet** with reason `wishlist_limit`.
   - FREE users: limit is **2 wishlists** (extendable via add-ons, see [Flow 21](#flow-21-add-on-purchase)).
   - PRO users: limit is **10 wishlists** (extendable via add-ons).

**Edge cases:**
- Name field is required; the form prevents submission if it is empty.
- Emoji is optional; a default is used if none is selected.

---

## Flow 3: Adding a Wish (Manual)

**Actor:** Authenticated owner, inside an open wishlist.

1. User opens a wishlist from the home screen.
2. User taps the **"+"** button within the wishlist view.
3. An item creation form opens with the following fields:
   - **Title** (text, required)
   - **URL** (text, optional)
   - **Price** (text, optional)
   - **Photo** (image upload, optional)
   - **Description** (text, optional)
   - **Priority** (selector: `low` / `medium` / `high`, optional)
4. User fills in the desired fields (at minimum, the title).
5. User submits the form.
6. App sends `POST /tg/wishlists/:id/items` with the item payload.
7. **On success (201):** The new item appears at the top of the wishlist.
8. **On 402 (limit reached):** The app shows an **upsell sheet** with reason `item_limit`.
   - FREE users: limit is **20 items** per wishlist (extendable via add-ons).
   - PRO users: limit is **70 items** per wishlist (extendable via add-ons).

**Edge cases:**
- Title is required; the form blocks submission without it.
- URL, price, photo, and description are all optional.
- Priority defaults to a neutral value if not set.

---

## Flow 4: Adding a Wish via URL Import (free quota + paid credits)

**Actor:** Authenticated owner (FREE or PRO), inside an open wishlist.

> **No longer a hard PRO gate** (opened to FREE 2026-05, commits `8a898c7`, `45d8d68`, `e17452c`). FREE users get a **monthly free-import quota** (`FREE_IMPORT_QUOTA_PER_MONTH`, default **5 per UTC calendar month**, env-tunable). Beyond the free quota they spend paid `import_pack_*` credits. **PRO is unlimited.** Credit logic lives in `apps/api/src/services/import-credits.ts`; the route is `apps/api/src/routes/import.routes.ts`.

1. User opens a wishlist.
2. User taps the **link/import icon** (distinct from the "+" button).
3. An input field appears for pasting a product URL (no PRO gate up front).
4. User pastes a URL. Supported domains include: Ozon, Wildberries, Yandex Market, Lamoda, Goldapple, Tekhnopark, Bork, Amazon, IKEA, Sephora, Nike, and arbitrary public URLs.
5. App sends `POST /tg/import-url` with `{ url }`.
6. **Allowance gate** (`getImportAllowance`): PRO is always allowed; FREE is allowed while monthly quota OR paid credits remain.
   - **If the FREE user has no free quota left and no paid credits:** the server returns a **402 paywall envelope** (`makeAddonRequired('url_import', …)`) suggesting the `import_pack_10` / `import_pack_25` packs, carrying `freeLimit`, `freeUsed`, `paidCredits`. The Mini App shows the credit-pack paywall. Flow ends unless the user buys a pack or upgrades.
7. Server validates the URL, scrapes the product page, and extracts available data: title, price, and product image.
8. **On success:** A new item is created and placed in the **Drafts** wishlist, not the current wishlist.
9. **Charge model — charge on delivered value, not on attempt:** a credit is consumed (`consumeImportCredit`) **only when the parse succeeds or is partial** (`parseStatus` `ok` / `partial`). Free monthly quota is spent first, then paid credits. A **failed** parse still creates a domain-stub item but **costs nothing**. PRO never decrements. The success response carries an `importQuota` object (`importCredits`, `freeImportsUsed`, `freeImportsLimit`) so the UI can update the remaining-quota counter.
10. User navigates to Drafts to review the imported item, edit fields if needed, and optionally move it to another wishlist.
11. **On rate limit (429):** The user has exceeded 10 import requests within 60 seconds. A rate-limit error is shown and the user must wait.

**Edge cases:**
- **Monthly reset is lazy** — there is no scheduler. `freeImportsPeriod` stores the `"YYYY-MM"` bucket on `UserCredits`; a stale bucket is treated as a zeroed counter on both the read (`resolveFreeImports`) and write (`consumeImportCredit`) paths.
- Items always land in Drafts regardless of which wishlist the user is viewing when they trigger the import.
- If the server cannot scrape the target page (e.g. anti-bot protection, unsupported domain), partial data or an error is returned; the user can manually complete missing fields. A genuinely failed parse does not cost a credit.
- Setting `FREE_IMPORT_QUOTA_PER_MONTH=0` disables the FREE tier entirely (FREE then needs paid credits or PRO).
- Rate limit: **10 requests per 60 seconds** per user (`importUrlLimiter`).

---

## Flow 5: Sharing a Wishlist

**Actor:** Authenticated owner.

1. User opens a wishlist.
2. User taps the **share icon** in the wishlist header.
3. App sends `POST /tg/wishlists/:id/share-token`.
4. Server returns a `shareToken` (a unique, stable token for this wishlist).
5. App constructs the shareable link:
   ```
   https://t.me/{BOT_USERNAME}?startapp=share_{shareToken}
   ```
6. A share sheet is presented to the user with two options:
   - **Copy link** — copies the URL to clipboard.
   - **Share via Telegram** — calls `Telegram.WebApp.openTelegramLink()` to open the Telegram share dialog.
7. User shares the link with friends via any available method.

**Edge cases:**
- The same `shareToken` is returned on subsequent calls for the same wishlist (idempotent).
- The link is valid as long as the wishlist exists and has not been made `PRIVATE` (see [Flow 15](#flow-15-wishlist-privacy-settings-pro)).

---

## Flow 6: Guest Viewing a Wishlist

**Actor:** Guest (friend) who received a share link.

1. Guest receives the link `https://t.me/{BOT_USERNAME}?startapp=share_{shareToken}`.
2. Guest taps the link in Telegram; Telegram opens the bot.
3. Bot `/start` handler processes the `share_{shareToken}` payload and shows the Mini App button.
4. Guest taps the button; Mini App opens with the query parameter `?startapp=share_{shareToken}`.
5. Mini App detects the `share_` prefix in the start parameter and enters **guest mode**.
6. App sends `GET /public/share/{shareToken}`.
7. Server validates the token, loads the wishlist, and returns items with availability status.
8. Guest sees the wishlist with each item's reservation status displayed as a count (e.g. "Reserved by 2 people").
9. **Surprise mode:** The guest does NOT see the names of other people who have reserved items, only whether an item is reserved. This preserves gift surprise.
10. Guest can tap any available item to view its details and reserve it -> [Flow 7](#flow-7-reservation-surprise-mode).

**Edge cases:**
- If the token is invalid or expired, the app shows an error screen.
- If the wishlist owner has set visibility to `PRIVATE`, the guest receives a `403` and the app shows an access-denied message.
- If the guest is actually the owner of the wishlist, the app detects this and silently switches to owner view -> [Flow 19](#flow-19-guest-detecting-they-are-the-owner).

---

## Flow 7: Reservation (Surprise Mode)

**Actor:** Guest viewing a friend's wishlist.

1. Guest taps on an unreserved item in the wishlist (from [Flow 6](#flow-6-guest-viewing-a-wishlist)).
2. Item detail view opens, showing the item's title, photo (if any), price (if any), description (if any), and a **"Reserve"** button.
3. Guest taps **"Reserve"**.
4. A prompt appears asking the guest to enter a **display name** (the name that will be shown to the wishlist owner).
5. Guest enters their display name and confirms.
6. App computes `actorHash = SHA-256("tg_actor:{guest_telegramId}")`.
7. App sends `POST /public/items/:id/reserve` with `{ actorHash, displayName }`.
8. **On success:**
   - The item is marked as reserved.
   - The **owner** receives a Telegram notification from the bot: "{displayName} reserved wish '{title}'".
   - The guest sees confirmation and can see their own reservation on the item.
   - The guest can unreserve by tapping the item again and selecting "Cancel reservation" — this sends a `DELETE` or equivalent unreserve request.
9. **On 402 (participants limit):** The wishlist has reached its participant limit (10 for FREE owner, 20 for PRO owner). A message is shown that the list is full and no new reservations can be made.

**Surprise mode guarantees:**
- The owner sees the count of reservers ("Reserved by N people") but **not their identities**.
- Other guests also cannot see who reserved what — only whether an item is taken.
- The guest who reserved an item can see their own reservation status.

**Edge cases:**
- If the item was reserved by someone else between the guest opening the detail view and submitting, the server returns a conflict error and the UI refreshes to show the updated state.
- The `actorHash` is used to identify the guest across sessions without storing their Telegram ID in plain text on public routes.

---

## Flow 8: Comments (PRO)

**Actor:** Wishlist owner (PRO) OR guest who has reserved an item (their owner must be PRO, or the guest themselves must have PRO).

**Precondition:** The item must be reserved. Comments are only available on reserved items. PRO must be active on **at least one side** — either the wishlist owner or the commenter.

**Owner commenting:**

1. Owner opens the wishlist and taps a reserved item.
2. A comment input is visible on the item detail view (PRO owners only).
3. Owner types a comment and submits.
4. App sends `POST /tg/items/:id/comments` with `{ text }`.
5. On success, the comment is saved. A Telegram notification is dispatched to the **reserver** after a **30-second debounce** (to batch rapid comments).

**Guest (reserver) commenting:**

1. Guest opens the shared wishlist and navigates to an item they have reserved.
2. A comment input is visible (if PRO applies to either side).
3. Guest types a comment and submits.
4. App sends `POST /public/items/:id/comments` with `{ text, actorHash }`.
5. On success, a Telegram notification is dispatched to the **wishlist owner** after a **30-second debounce**.

**Edge cases:**
- If neither the owner nor the guest has PRO, the comment input is not shown / the endpoint returns `402`.
- The 30-second debounce means that if multiple comments are posted in quick succession, only one notification is sent covering all of them.
- Comments are visible to both the owner and the reserver on the item detail view.

---

## Flow 9: Hints (free quota + paid packs)

**Actor:** Authenticated owner (FREE or PRO).

> **No longer a hard PRO gate** (opened to FREE 2026-05, commit `e17452c`). FREE users get a **monthly free-hint quota** (`FREE_HINT_QUOTA_PER_MONTH`, default **3 per UTC calendar month**, env-tunable). Beyond the free quota they spend paid `hints_pack_*` credits. **PRO is unlimited.** The **key difference from URL import: the quota is charged on DELIVERY, not on creation.** Credit logic lives in `apps/api/src/services/hint-credits.ts`; the wave-creation route is `apps/api/src/routes/hints.routes.ts`.

1. Owner opens a wishlist and taps on one of their own (AVAILABLE) items.
2. Item detail view shows a **"Hint friends"** button.
3. Owner taps it. App sends `POST /tg/items/:id/hint`.
4. The server runs gates in order: item exists → owner-owned → owner's `hintsEnabled` not disabled (else `403 hints_disabled`) → item is `AVAILABLE` (else `400 item_not_available`) → **allowance gate last**.
5. **Allowance gate** (`getHintAllowance`, read-only): PRO is always allowed; FREE is allowed while monthly quota OR paid credits remain.
   - **If FREE has no free quota and no paid credits:** the server returns a **402 paywall envelope** (`makeAddonRequired('hints', …)`) suggesting the `hints_pack_5` / `hints_pack_10` packs, carrying `freeLimit`, `freeUsed`, `paidCredits`. The Mini App shows the credit-pack paywall.
6. On pass, the server creates a `Hint` record (status `SENT`, `expiresAt = now + 30 days`) and **fires a Telegram contact-picker keyboard** into the owner's bot chat (best-effort, bounded 3 s race so the request returns fast). The response is `{ hintId, status: 'pending_selection' }`.
7. Owner switches to the bot chat and picks one or more friends from the native `request_users` keyboard. The bot processes the `users_shared` event, delivers the hint to each picked friend's DM, and flips the hint `SENT → DELIVERED`.
8. **Charge on delivery** (`consumeHintCharge`, called by the bot via `POST /internal/hints/credit`): only a `DELIVERED` hint is chargeable. Free monthly quota is spent first, then a paid pack credit. Every charge writes a `HintQuotaCharge` ledger row (`userId`, unique `hintId`, `period`, `source` ∈ `free_monthly` / `paid_pack` / `grace` / `pro`, `charged`). "Free hints used this month" is a `COUNT` over that ledger — there is no counter column to drift.

**Edge cases:**
- **A hint that is never delivered costs nothing** — keyboard lost, picker abandoned, item reserved, or hint expired all leave the user uncharged ("charge on delivered value, not on attempt").
- **Grace delivery:** if the FREE quota was available at wave-creation but exhausted by delivery time (a concurrent hint drained it), the hint is still delivered and recorded `source='grace', charged=false` — we never break a scenario the user already started.
- **Idempotent on `hintId`** — a duplicate `users_shared` event (Telegram double-fire) or an internal retry returns outcome `replay` without a second charge. The whole decision runs under a per-user advisory lock so two simultaneous deliveries can't both slip past the monthly cap.
- **Anti-spam, independent of monetization:** max **3 hint waves per item per 30 days** (`429 item_hint_limit`) and **5 hints per sender per day** (`429 daily_hint_limit`); god-mode bypasses both. A re-tap within the 30-min bot lookup window returns the existing `SENT` hint (idempotent, no new slot burned); stale `SENT` hints older than that window are auto-cancelled.
- **No bot chat:** if the owner has never `/start`-ed the bot (`telegramChatId` null), the response carries `noBotChat: true` and the Mini App prompts them to open the bot first.
- Setting `FREE_HINT_QUOTA_PER_MONTH=0` disables the FREE tier entirely (FREE then needs paid credits or PRO).

---

## Flow 10: Subscribing to a Friend's Wishlist (PRO)

**Actor:** Guest (PRO user) viewing a friend's wishlist.

**Precondition:** The subscribing user must have PRO. The wishlist's `allowSubscriptions` must not be `NOBODY`. The owner's `subscribePolicy` must not be `NOBODY`.

1. Guest is viewing a friend's wishlist in guest mode ([Flow 6](#flow-6-guest-viewing-a-wishlist)).
2. Guest taps the **"Subscribe"** button in the wishlist header or footer.
3. **If FREE guest:** App shows upsell sheet with reason `subscription_limit`. Flow ends unless user upgrades.
4. **If allowSubscriptions = NOBODY on the wishlist:** Subscription is blocked; an explanatory message is shown.
5. **If owner's subscribePolicy = NOBODY:** Subscription is blocked; an explanatory message is shown.
6. **If PRO guest and subscriptions are allowed:** App sends `POST /tg/wishlists/:id/subscribe`.
7. **On success:** Guest is now subscribed. A confirmation is shown.
8. **On 402 (subscription limit):** Guest has reached their subscription cap (2 for FREE, 5 for PRO; extendable via add-ons). Upsell sheet with reason `subscription_limit` is shown.

**What happens after subscribing:**

- Whenever the subscribed wishlist changes (item added, removed, or reserved), the subscriber receives a **Telegram notification** from the bot.
- Unread change counts are tracked per subscription (see [Flow 24](#flow-24-change-badges--unread)).

**Edge cases:**
- Subscribing to your own wishlist is not a supported flow.
- If the guest later loses PRO (e.g. subscription lapses), existing subscriptions may stop delivering notifications until PRO is restored.

---

## Flow 11: Editing a Wish

**Actor:** Authenticated owner.

1. Owner opens a wishlist and taps on an item.
2. Item detail view opens.
3. Owner taps the **edit button** (pencil icon or "Edit").
4. An edit form opens pre-populated with the current item data. Editable fields:
   - Title
   - URL
   - Price (text)
   - Description
   - Priority (`low` / `medium` / `high`)
   - Photo
5. Owner makes changes.
6. **To update text fields:** App sends `PATCH /tg/items/:id` with the changed fields.
7. **To upload a new photo:** App sends `POST /tg/items/:id/photo` as a `multipart/form-data` request containing the image file.
8. **To remove the existing photo:** App sends `DELETE /tg/items/:id/photo`.
9. On success, the item detail view refreshes with the updated data.

**Edge cases:**
- Partial updates are supported; only the fields included in the `PATCH` body are changed.
- Photo upload and deletion are separate endpoints from the main item update.
- If another guest has reserved the item, the edit does not affect the reservation.

---

## Flow 12: Completing / Archiving a Wish

**Actor:** Authenticated owner.

**Marking as received (completed):**

1. Owner opens an item detail view.
2. Owner taps a "Received gift" or equivalent **complete** action.
3. App sends `PATCH /tg/items/:id` with `{ status: 'COMPLETED' }`.
4. On success, the item is visually marked as completed and moves to the **archive view** of the wishlist.
5. The item remains accessible but is separated from active items.

**Deleting an item (soft delete):**

1. Owner opens an item detail view.
2. Owner taps **"Delete"**.
3. A confirmation prompt is shown.
4. Owner confirms.
5. App sends `DELETE /tg/items/:id` (or `PATCH` with `{ status: 'DELETED' }`). Deletion is **soft**: the record is retained in the database with status `DELETED`.
6. The item disappears from the active wishlist view.

**Edge cases:**
- Completed and deleted items are not visible in the default wishlist view; they are accessible via archive/history views.
- Reservations on a completed or deleted item remain in the database but are no longer actionable.

---

## Flow 13: Archiving a Wishlist

**Actor:** Authenticated owner.

1. Owner navigates to the wishlist settings or long-presses the wishlist from the home screen.
2. Owner selects **"Archive"**.
3. A confirmation prompt is shown.
4. Owner confirms.
5. App sends `PATCH /tg/wishlists/:id` with `{ archivedAt: <current ISO timestamp> }`.
6. On success, the wishlist is removed from the active home screen list.
7. The archived wishlist is accessible via the **archive screen** (a separate section in the app).
8. All items within the archived wishlist remain accessible in read-only form.

**Unarchiving:**

- From the archive screen, the owner can unarchive a wishlist by sending `PATCH /tg/wishlists/:id` with `{ archivedAt: null }`.
- The wishlist returns to the active home screen list.

**Edge cases:**
- Archiving a wishlist does not invalidate its share token. Guests with the link can still view the wishlist unless its visibility is also changed to `PRIVATE`.
- Subscriptions to an archived wishlist remain active.

---

## Flow 14: Notification Settings (PRO)

**Actor:** Authenticated PRO owner.

**Precondition:** Active PRO subscription required. Changes made by FREE users are silently ignored by the server.

1. Owner opens **Settings** from the main navigation.
2. Owner navigates to the **Notifications** section.
3. A list of toggles is presented:
   - **notifyComments** — receive notifications when someone comments on a reserved item
   - **notifyReservations** — receive notifications when someone reserves an item
   - **notifySubscriptions** — receive notifications when a subscribed wishlist changes
   - **notifyMarketing** — receive promotional/marketing messages from the app
4. Owner toggles any setting.
5. App sends `PATCH /tg/me/settings` with the updated notification flags (e.g. `{ notifyReservations: false }`).
6. On success, the setting is saved and the toggle reflects the new state.

**Edge cases:**
- FREE users: the UI may show the toggles but changes sent to the server are silently ignored (no `402` is returned, but the setting is not persisted). This is a server-side behaviour.
- Changes take effect for the next qualifying event; there is no retroactive effect.

---

## Flow 15: Wishlist Privacy Settings (PRO)

**Actor:** Authenticated owner.

1. Owner opens a wishlist.
2. Owner navigates to the wishlist's **Settings** panel.
3. Three privacy-related settings are available:

### Visibility

| Value | Description | PRO Required |
|---|---|---|
| `LINK_ONLY` | Default. Accessible only via share link. | No |
| `PUBLIC_PROFILE` | Discoverable on owner's public profile. | Yes |
| `PRIVATE` | Not accessible to guests at all. | Yes |

4. Owner selects a visibility option.
5. App sends `PATCH /tg/wishlists/:id` with `{ visibility: '<value>' }`.
6. **On 403:** FREE user attempted to set `PUBLIC_PROFILE` or `PRIVATE`. An upsell message is shown.

### Allow Subscriptions

| Value | Description | PRO Required |
|---|---|---|
| `ALL` | Default. Anyone can subscribe. | No |
| `NOBODY` | Subscriptions disabled for this wishlist. | Yes |

7. Owner toggles the setting.
8. App sends `PATCH /tg/wishlists/:id` with `{ allowSubscriptions: '<value>' }`.
9. **On 403:** FREE user attempted to set `NOBODY`. An upsell message is shown.

### Comment Policy

| Value | Description | PRO Required |
|---|---|---|
| `ALL` | Default. Any reserver can comment (if PRO applies). | No |
| `SUBSCRIBERS` | Only subscribers can comment. | Yes |

10. Owner selects the comment policy.
11. App sends `PATCH /tg/wishlists/:id` with `{ commentPolicy: '<value>' }`.
12. **On 403:** FREE user attempted to set `SUBSCRIBERS`. An upsell message is shown.

**Edge cases:**
- Setting `visibility: PRIVATE` does not invalidate existing share tokens, but guests who follow the link will receive a `403` response from the public API.
- Changing `allowSubscriptions` to `NOBODY` does not remove existing subscribers; it only prevents new subscriptions.

---

## Flow 16: PRO Subscription Purchase

**Actor:** Authenticated FREE user who wants to upgrade.

1. User taps **"Get Pro"** from any upsell sheet or the Settings screen. Paywall sheet shows three plan options in a "2 + 1" layout — Monthly (100 ⭐) + Yearly (800 ⭐) in the existing 2-col grid, **Lifetime (2 490 ⭐)** as a full-width gold-accent premium tile below. Default selection is `yearly`.
2. User picks a plan tile. CTA copy updates per plan; selecting Lifetime flips the CTA to a gold gradient with copy "Купить навсегда · 2 490 ⭐".
3. App sends `POST /tg/billing/pro/checkout` with `{ plan: 'monthly' | 'yearly' | 'lifetime' }`.
4. Server generates a Telegram Stars invoice and returns `{ invoiceUrl, checkoutSessionId, plan }`. If the user is already on lifetime and picks any plan, the server short-circuits to `{ alreadySubscribed: true, lifetime: true }` with no invoice; the Mini App shows a "уже активна" toast.
5. App calls `Telegram.WebApp.openInvoice(invoiceUrl)`.
6. Telegram's native payment sheet opens, showing the cost: **100 Stars / month**, **800 Stars one-time**, or **2 490 Stars one-time (permanent)**.
7. User confirms payment within Telegram.
8. Telegram processes the payment and sends a `successful_payment` update to the bot.
9. Server receives `successful_payment`, upserts a `Subscription` record (within a transaction for lifetime), writes a `PaymentEvent` (`payment_success_monthly` / `payment_success_yearly` / `payment_success_lifetime`), and marks the user's plan as PRO. Bot sends a celebratory DM (`bot_pro_activated*`).
10. App sends `POST /tg/billing/pro/sync` to confirm the subscription is active and refresh the local plan state.
11. The UI updates immediately: PRO badge appears, PRO features become accessible, limits are raised. For lifetime, a celebratory bottom-sheet (`pro_lifetime_success_title` / `_desc`) opens.
12. If a degradation state exists for the user (see [Flow 23](#flow-23-lifecycle--degradation)), it is cleared and any archived data is restored.

**Edge cases:**
- If the user closes the payment sheet without paying, the flow is cancelled and the user remains on FREE.
- If `successful_payment` is received but `/sync` fails (e.g. network error), the plan will be corrected on the next app open when the auth state is refreshed.
- The monthly subscription is billed via Telegram Stars subscription infrastructure. Yearly and Lifetime are one-time non-recurring invoices.
- **Lifetime downgrade-protection:** if a stale `pro_monthly` or `pro_yearly` `successful_payment` arrives **after** lifetime is active (e.g. a still-active Telegram-side monthly auto-renewal that the user hasn't cancelled), the bot audits via `payment_success_post_lifetime` and **does not** overwrite the lifetime row. The user keeps lifetime. The Settings PRO card surfaces a static info note (`pro_lifetime_existing_monthly_warning`) reminding them to cancel any prior monthly auto-renewal separately, since Telegram will keep charging until they do.

---

## Flow 17: PRO Subscription Cancellation

**Actor:** Authenticated PRO user.

1. User opens **Settings**.
2. User finds the **PRO card** showing their current subscription status and renewal date.
3. User taps **"Cancel renewal"**.
4. An **anti-churn sheet** appears listing **9 features** the user will lose or have reduced upon cancellation (wishlists, items, participants, comments, URL import, hints, subscriptions, advanced privacy, calendar). Note: **URL import and hints are no longer lost entirely** — reverting to FREE drops PRO's *unlimited* usage back to the FREE monthly quota (see [Flow 4](#flow-4-adding-a-wish-via-url-import-free-quota--paid-credits) / [Flow 9](#flow-9-hints-free-quota--paid-packs)), and limits (wishlists, items, participants, subscriptions) fall to the FREE caps after the degradation lifecycle.
5. User must explicitly tap **"Cancel subscription"** (a secondary confirmation button within the sheet) to proceed.
6. App sends `POST /tg/billing/subscription/cancel`.
7. Server sets `cancelAtPeriodEnd = true` on the subscription record.
8. **On success:** A confirmation message is shown. The user retains full PRO access until the end of the current billing period.
9. The Settings screen updates to show "Access until {date}" instead of the renewal date.

**Reactivating (reversing cancellation):**

1. User opens Settings and sees the cancellation notice with remaining access date.
2. User taps **"Resume subscription"** (or equivalent resume button).
3. App sends `POST /tg/billing/subscription/reactivate`.
4. Server sets `cancelAtPeriodEnd = false`.
5. On success, the subscription is restored to auto-renewing and the Settings screen returns to showing the renewal date.

**Edge cases:**
- The two-step confirmation (anti-churn sheet + explicit "Cancel subscription" tap) is intentional to reduce accidental cancellations.
- Cancellation does not immediately revoke access; PRO features remain available through the paid period end.
- After the period ends, the plan reverts to FREE. The degradation lifecycle begins (see [Flow 23](#flow-23-lifecycle--degradation)).
- **Lifetime users cannot cancel.** The cancel and reactivate CTAs are hidden in Settings. If a stale Mini App version still calls the endpoint, the backend returns **409 `lifetime_cannot_cancel`**. There is no auto-renewal to disable; the entitlement is permanent.

---

## Flow 18: Support / Contact

**Actor:** Any authenticated user.

1. User opens **Settings**.
2. User taps **"Contact support"**.
3. App calls `Telegram.WebApp.openTelegramLink()` pointing to the bot's direct message (DM) URL.
4. Telegram switches to the bot's chat.
5. User types their support message and sends it.
6. The bot receives the message and routes it to an **internal support group** using a ForceReply bridge pattern: the message is forwarded to the support group, and the bot replies with a ForceReply prompt to track the conversation thread.
7. The support team reads the message in the internal group and replies.
8. The bot delivers the support team's reply back to the user in the bot DM.

**Edge cases:**
- The support flow is entirely within Telegram; no external ticketing system or web form is involved.
- The ForceReply bridge ensures that replies from the support team are threaded correctly back to the originating user.

---

## Flow 19: Guest Detecting They Are the Owner

**Actor:** A user who opens their own wishlist via a share link (e.g. to test how it looks to others, or from a link they previously shared).

1. User receives or taps a share link: `https://t.me/{BOT_USERNAME}?startapp=share_{shareToken}`.
2. Mini App opens in guest mode and loads the wishlist via `GET /public/share/{shareToken}`.
3. The server response includes `wishlist.ownerTelegramId`.
4. The Mini App compares `wishlist.ownerTelegramId` with the currently authenticated `tgUser.id` (available from `initData`).
5. **If they match:** The Mini App **silently switches to owner view** — the user sees the full owner interface (edit buttons, reservation details including reserver names, settings, etc.) without any prompt or notification.
6. The URL/state is updated to reflect the owner context.

**Edge cases:**
- This switch is seamless; the user does not see a "you are the owner" message.
- If the IDs do not match, the guest view is preserved as normal.
- This flow prevents an owner from accidentally reserving their own items or being confused by the limited guest interface when viewing their own wishlist.

---

## Flow 20: Gift Notes

**Actor:** Authenticated user with Gift Notes access (PRO users get it included; FREE users can unlock for a one-time purchase of 19 XTR).

### Purchase gate

1. User navigates to the Gift Notes section of the app.
2. **If PRO:** Access is granted automatically (included in PRO plan).
3. **If FREE and not unlocked:** The app shows a purchase prompt. App sends `POST /tg/billing/gift-notes/checkout`.
4. Server generates a Telegram Stars invoice for **19 XTR** (SKU: `gift_notes_unlock`, type: permanent).
5. User pays via Telegram Stars invoice flow.
6. After successful payment, user calls `POST /tg/billing/gift-notes/sync` to refresh access. `giftNotes.unlocked` becomes `true` with `unlockType: 'ONE_TIME'`.

### Occasions CRUD

7. User sees a list of gift occasions. App sends `GET /tg/gift-occasions`.
8. User creates a new occasion: `POST /tg/gift-occasions` with:
   - **recipientName** (text, required) — who the gift is for
   - **type** (enum: `BIRTHDAY` / `ANNIVERSARY` / `HOLIDAY` / `OTHER`, required)
   - **eventDate** (ISO date, optional)
   - **recurrence** (enum: `NONE` / `YEARLY` / `MONTHLY`, optional) — for recurring events
   - **note** (text, optional)
9. Server calculates `nextDate` and `daysUntil` for upcoming occasions.
10. User can update an occasion: `PATCH /tg/gift-occasions/:id`.
11. User can archive an occasion: `POST /tg/gift-occasions/:id/archive` (sets status to `ARCHIVED`).
12. User can mark an occasion as done: `POST /tg/gift-occasions/:id/complete` (sets status to `DONE`).
13. User can delete an occasion: `DELETE /tg/gift-occasions/:id`.

### Ideas CRUD

14. Within an occasion, user can add gift ideas: `POST /tg/gift-occasions/:id/ideas` with:
    - **text** (required) — description of the gift idea
    - **link** (optional) — URL to product
    - **price** (optional) — estimated cost
    - **currency** (optional)
    - **note** (optional) — personal note
15. User can edit an idea: `PATCH /tg/gift-occasion-ideas/:ideaId`.
16. User can archive an idea: `DELETE /tg/gift-occasion-ideas/:ideaId` (soft-delete, sets status to `ARCHIVED`).
17. User can mark an idea as done: `POST /tg/gift-occasion-ideas/:ideaId/complete`.

### Deep link

18. Deep link format: `occasion_{id}` — opens the app directly to a specific occasion's detail view.

**Sorting:** Occasions are sorted by upcoming first (ascending `daysUntil`), no-date occasions after, archived last.

**Edge cases:**
- Archived ideas are excluded from the default occasion view.
- God Mode users get Gift Notes access automatically.

---

## Flow 21: Add-on Purchase

**Actor:** Authenticated user (FREE or PRO) who hits a limit gate.

### Available SKUs

| SKU Code | Price (XTR) | Type | Description |
|---|---|---|---|
| `extra_wishlist_slot` | 39 | permanent | +1 wishlist slot |
| `extra_subscription_slot` | 25 | permanent | +1 subscription slot |
| `extra_items_5` | 19 | permanent | +5 item slots (per wishlist) |
| `extra_items_15` | 39 | permanent | +15 item slots (per wishlist) |
| `hints_pack_5` | 29 | consumable | 5 hint credits |
| `hints_pack_10` | 49 | consumable | 10 hint credits |
| `import_pack_10` | 39 | consumable | 10 URL import credits |
| `import_pack_25` | 79 | consumable | 25 URL import credits |
| `seasonal_decoration` | 29 | cosmetic | Seasonal decoration (per wishlist) |
| `gift_notes_unlock` | 19 | permanent | Gift Notes one-time unlock |

### Per-SKU caps

| Add-on | Cap |
|---|---|
| Extra wishlist slots | FREE: 3, PRO: 5 |
| Extra subscription slots | 3 (any plan) |
| Extra +5 items per wishlist | 3 per wishlist |
| Extra +15 items per wishlist | 1 per wishlist |

### Purchase flow

1. User hits a limit gate (e.g. creating a 3rd wishlist on FREE plan).
2. The **upsell sheet** appears showing PRO upgrade option AND available add-on purchases.
3. User selects an add-on.
4. App sends `POST /tg/billing/addon/checkout` with `{ skuCode, targetId? }`.
   - `targetId` is required for per-wishlist add-ons (`extra_items_5`, `extra_items_15`, `seasonal_decoration`).
5. Server checks per-SKU caps. If cap is reached, returns `409` with `{ error: 'cap_reached' }` or `{ error: 'wishlist_cap_reached' }`.
6. Server generates a Telegram Stars invoice via bot API and returns `{ invoiceLink }`.
7. App calls `Telegram.WebApp.openInvoice(invoiceLink)`.
8. User completes payment in Telegram's native payment sheet.
9. On `successful_payment`, the server creates a `UserAddOn` record (or increments credits for consumable SKUs).
10. App calls `POST /tg/billing/addon/sync` to refresh local add-on state and updated limits.

**Edge cases:**
- If the user already has Gift Notes unlocked and tries to buy `gift_notes_unlock`, the server returns `{ alreadyUnlocked: true }` without creating an invoice.
- Consumable credits (hints, imports) are decremented on use and do not expire.
- Permanent add-ons persist across plan changes.

---

## Flow 22: Promo Code Redemption

**Actor:** Authenticated user (typically FREE).

1. User opens **Settings**.
2. User finds the promo code input field.
3. User enters a promo code (e.g. `WISHPRO`).
4. App sends `POST /tg/promo/apply` with `{ code }`.
5. Server normalizes the code (trim, uppercase, remove spaces/dashes) and looks up the `PromoCampaign`.

### Rate limit

- **5 requests per 60 seconds** per user. On excess, returns `429`.

### Branching logic

**If code is invalid or not found:** Returns `404`.

**If already redeemed by this user:** Returns `409` with `{ error: 'already_redeemed' }`.

**If campaign redemption limit reached:** Returns `410` with `{ error: 'campaign_exhausted' }`.

**If user is a paid PRO subscriber (active Stars subscription):**
- The promo is accepted but NOT activated as a promo period.
- Returns `{ status: 'promo_accepted_paid', message: 'promo_accepted_paid' }`.
- The promo is banked — if the user later loses their paid subscription, the promo can activate.

**If user is FREE or promo-PRO:**
- A 30-day promo PRO period is activated.
- A `PromoRedemption` record is created with status `ACTIVE` and `expiresAt` set to 30 days from now.
- Returns `{ status: 'activated', plan: 'PRO', expiresAt }`.
- The user immediately gains PRO access.

### Special codes

- `WISHPRO` — not a public code. Only users who were offered it via lifecycle DM (see [Flow 23](#flow-23-lifecycle--degradation)) or via onboarding can redeem it. Direct redemption by other users is rejected.

**Edge cases:**
- If a `PromoRedemption` with status `PENDING` or `FAILED` exists, retry is allowed.
- Onboarding flow can pass `source: 'onboarding'` to bypass the WISHPRO restriction.

---

## Flow 23: Lifecycle / Degradation

**Actor:** System (automated hourly cron jobs).

This flow manages what happens when a user loses PRO access (subscription expires or promo period ends). It progresses through three phases.

### Phase 1: GRACE_PERIOD (14 days)

1. Hourly cron detects expired subscriptions (`currentPeriodEnd <= now`) and marks them as `EXPIRED`.
2. Hourly cron detects expired promo redemptions (`expiresAt <= now`) and marks them as `EXPIRED`.
3. For each expired promo, the system checks if the user has an active paid subscription. If not, a `DegradationState` record is created:
   - `phase: 'GRACE_PERIOD'`
   - `graceEndsAt: now + 14 days`
4. During the grace period the user retains their data but is on the FREE plan. Limits are enforced for new actions (creating wishlists, items, etc.) but existing data is not touched.

### Phase 2: ARCHIVED

5. Hourly cron checks for grace periods that have ended (`graceEndsAt <= now`).
6. If the user has regained PRO in the meantime, the degradation state is set to `NONE` and no archiving occurs.
7. If still on FREE, the system archives over-limit data:
   - Wishlists beyond the FREE limit (2) are archived (newest first, keeping oldest).
   - Items beyond the FREE limit (20 per wishlist) in remaining wishlists are archived.
8. The degradation state is updated:
   - `phase: 'ARCHIVED'`
   - `purgeScheduledAt: now + 90 days`
   - `archivedWishlistIds` and `archivedItemIds` are stored for potential recovery.

### Phase 3: PURGED (after 90 days)

9. Hourly cron checks for archived states past the purge deadline (`purgeScheduledAt <= now`).
10. If the user has regained PRO, archived data is **restored** (wishlists and items are unarchived) and degradation state is set to `NONE`.
11. If still on FREE, archived wishlists and items are **permanently deleted** from the database.
12. Degradation state is set to `phase: 'PURGED'`.

### Lifecycle DMs (Win-back)

13. A separate hourly cron scans users and classifies them into lifecycle segments (S1-S4).
14. Eligible users receive Telegram DM messages via the bot with re-engagement nudges.
15. For qualifying segments, the `WISHPRO` promo code is offered (see [Flow 22](#flow-22-promo-code-redemption)).
16. Cooldowns: max 1 promo offer per 60 days, min 72h between messages, max 5 marketing touches in 45 days.

### Recovery

17. When a user regains PRO (via subscription purchase, promo code, or god mode), `degradationState` is deleted and any archived data is restored automatically.
18. On each app visit, the system checks and attributes lifecycle return if applicable (`attributeLifecycleReturn`).

**Edge cases:**
- The archive purge job (separate from degradation) hard-deletes items with `purgeAfter <= now` and cleans up associated media files, running in batches of 100 per hour.
- Users in god mode are never subject to degradation.

---

## Flow 24: Change Badges / Unread

**Actor:** Subscriber viewing their subscriptions list, or owner viewing item comments.

### Subscription-level unread counts

1. When a subscribed wishlist changes (item added, modified, or reserved), the server creates `SubscriptionUnread` records for each subscriber, tracking `entityId` (the changed item) and `fieldName`.
2. On app boot, the Mini App calls `GET /tg/me/subscriptions/meta` to get a lightweight unread summary:
   - `unreadCount` — total unique entity changes across all subscriptions
   - `hasUnread` — boolean flag
   - `subscriptionsWithUnread` — number of subscriptions that have unread changes
3. The subscriptions tab badge shows the aggregate unread count.
4. When the user opens the full subscriptions list (`GET /tg/me/subscriptions`), each subscription includes:
   - `unreadCount` — number of unique changed entities in that subscription
   - `unreadEntityIds` — list of item IDs with changes
   - `unreadItemCounts` — per-item change counts
5. When the user opens a specific subscription, the app calls `POST /tg/me/subscriptions/:id/read` to mark all unreads as read (deletes `SubscriptionUnread` records for that subscription).

### Item-level comment unreads

6. When loading a wishlist's items (`GET /tg/wishlists/:id/items` or equivalent), the server counts unread comments per item:
   - Comments created after the owner's last read timestamp for that item.
7. Each item in the response includes `unreadComments: number`.
8. The item card displays a badge with the unread comment count.

### Refresh on app foreground

9. When the Mini App returns to the foreground (Telegram WebView lifecycle event), the unread meta is re-fetched to update badge counts.
10. Navigating into a subscription or item detail view marks the relevant unreads as read.

**Edge cases:**
- If a subscriber has no unreads, `unreadCount` is 0 and no badge is shown.
- Unread records are deduplicated by `entityId` — multiple changes to the same item count as one unread entity.

---

## Flow 25: Group Gift (Совместный подарок)

**Actor:** Guest viewing a friend's wishlist (organizer), invited users (participants).

### Paywall

1. Guest taps an item in a friend's wishlist and opens the item detail view.
2. Guest taps the **"Скинуться компанией"** button.
3. **If not unlocked:** The app shows the `group_gift_unlock` paywall. App sends `POST /tg/billing/addon/checkout` with `{ skuCode: 'group_gift_unlock' }`.
4. Server generates a Telegram Stars invoice for **79 XTR** (SKU: `group_gift_unlock`, type: permanent).
5. User pays via Telegram Stars invoice flow and calls `POST /tg/billing/addon/sync` to refresh access.

### Create collection

6. Guest sets the **target amount** for the group gift.
7. Optionally sets a **deadline** (date by which contributions should be collected).
8. Optionally adds a **note** (visible to all participants).
9. Enters their **own contribution** amount.
10. App sends `POST /tg/items/:id/group-gift` with `{ targetAmount, deadline?, note?, ownContribution }`.
11. Server creates a `GroupGift` record, a `GroupGiftParticipation` record for the organizer, and **auto-reserves** the item for the organizer.

### Share / Invite

12. The organizer is presented with a share button to invite friends via Telegram.
13. The invite link uses a deep link format: `https://t.me/{BOT_USERNAME}?startapp=gg_{inviteToken}`.
14. The organizer shares the link via Telegram's native share dialog.

### Join flow (invited user)

15. Invited user taps the deep link in Telegram; the Mini App opens with `?startapp=gg_{inviteToken}`.
16. The app detects the `gg_` prefix and loads the group gift detail via the invite token.
17. The invited user sees the item details, current progress toward the target amount, and participant list.
18. The invited user enters their **contribution amount** and confirms.
19. App sends the join request; the server creates a `GroupGiftParticipation` record for the new participant.
20. The **organizer receives a Telegram notification** that a new participant has joined.

### Detail screen

21. The group gift detail screen shows:
    - Progress bar (collected amount vs. target amount)
    - Participant list with individual contribution amounts
    - Chat section for participant communication
    - Pinned payment info (set by the organizer)
22. All participants can access the detail screen from the item view or from **"My Reservations"**.

### Organizer actions

23. **Edit payment details:** Organizer can update pinned payment information (e.g. card number, payment method).
24. **Complete collection:** Organizer marks the collection as complete. All participants are notified via Telegram.
25. **Cancel collection:** Organizer cancels the group gift. All participants are notified via Telegram. The item reservation is released.

### Participant actions

26. **Edit own amount:** Participant can update their contribution amount.
27. **Leave collection:** Participant can leave the group gift (their contribution is removed).
28. **Chat:** Participant can send messages in the group gift chat.

### Entry from My Reservations

29. Both the organizer and participants see group gift items in the **My Reservations** tab.
30. Group gift items are displayed with a distinct badge indicating they are part of a group collection.
31. Tapping a group gift reservation opens the group gift detail screen.

### Notifications

32. Organizer is notified when someone joins the collection.
33. All participants are notified when the collection is completed.
34. All participants are notified when the collection is cancelled.

**Edge cases:**
- If the organizer cancels, the item's reservation is released and becomes available again.
- The invite token is unique per group gift and remains valid until the collection is completed or cancelled.
- A user cannot join a group gift for an item on their own wishlist.

---

## Flow 26: Wishlist Categories

**Actor:** Authenticated wishlist owner, or guest viewing a wishlist.

> **Quota** (no longer PRO-only): FREE gets **1 user category per wishlist** (`PLANS.FREE.categoriesPerWishlist = 1`; the default "Без категории" section does not count); **PRO is effectively unlimited** (`Number.MAX_SAFE_INTEGER` sentinel). Only **CREATE** beyond the limit is gated — rename, delete, reorder, and item move-category stay open so the FREE category is fully usable.

### Creating a category

1. Owner opens a wishlist detail view.
2. Owner taps the **"+"** button or opens the menu and selects "Add category".
3. Owner enters a **category name**.
4. App sends the create request; server creates a category record associated with the wishlist.
5. **On 402 (category limit):** a FREE owner who already has 1 user category gets a `categories` paywall envelope. Upgrading to PRO (or the existing category being deleted) unblocks creation.
6. The new category appears as a collapsible section in the wishlist.

### Renaming a category

6. Owner long-presses on a category header (or uses the menu on the category header).
7. A rename input appears with the current name pre-filled.
8. Owner edits the name and confirms.
9. App sends the update request with the new name.

### Deleting a category

10. Owner selects "Delete" from the category menu.
11. A confirmation prompt warns that items will be moved to the default (uncategorized) section.
12. On confirm, the app sends the delete request.
13. All items previously in that category are moved to uncategorized.

### Moving items to a category

14. Owner selects one or more items (single or bulk selection).
15. Owner chooses "Move to category" from the action menu.
16. A category picker appears listing all categories for this wishlist.
17. Owner selects the target category.
18. App sends the move request; items are reassigned to the selected category.

### Reordering categories

19. Owner enters reorder mode (drag handle on category headers).
20. Owner drags categories to change their display order.
21. App sends the updated sort order to the server.

### Guest view

22. When a guest views a shared wishlist, categories are displayed as **collapsible sections**.
23. Each category section can be expanded or collapsed independently.
24. Items without a category appear in a default section.

**Edge cases:**
- A wishlist can have zero categories; in that case, all items appear in a flat list (backward-compatible).
- Category names must be unique within a wishlist.
- Deleting the last category returns the wishlist to a flat item list.

---

## Flow 27: Don't Gift (Не дарить)

**Actor:** Authenticated PRO user managing their profile, or guest viewing a friend's wishlist.

**Precondition:** Active PRO subscription required to configure Don't Gift preferences.

### Configuration (profile settings)

1. User opens **Profile settings**.
2. User navigates to the **"Don't Gift"** section (visible to PRO users only).
3. The screen presents **preset categories** as toggleable chips:
   - Food, Alcohol, Sweets, Flowers, Perfume, and other common gift categories.
4. User toggles on/off any preset categories they do not want to receive as gifts.
5. Below the presets, a **custom items** section allows free-text entries of specific unwanted items.
6. User adds, edits, or removes custom entries as needed.
7. An optional **comment** field allows the user to add a free-text explanation (e.g. "I have allergies" or "Already have too many").
8. A **visibility toggle** controls whether friends can see the Don't Gift restrictions on the user's guest wishlist view.
9. All changes are saved via the profile settings API.

### Guest view

10. When a guest views a wishlist whose owner has Don't Gift configured and visibility enabled, an expanded **"Don't Gift"** block is displayed on the guest wishlist view.
11. The block shows:
    - Selected preset categories (as tags/chips)
    - Custom unwanted items (as a list)
    - The owner's comment (if provided)
12. This helps guests avoid purchasing unwanted gifts.

**Edge cases:**
- FREE users do not see the Don't Gift configuration section in settings. The feature is PRO-only.
- If visibility is toggled off, the Don't Gift block is hidden from guests even if preferences are configured.
- Don't Gift preferences persist across plan changes but are only visible to guests while the user has an active PRO subscription.

---

## Flow 28: Secret Reservations

**Actor:** Guest viewing a friend's wishlist who wants to reserve an item without revealing their identity to the owner.

**Precondition:** The guest must have the `secret_reservation_unlock` add-on active (24 XTR one-time purchase) or have unlocked it via onboarding.

### Purchase gate

1. Guest opens a friend's wishlist and taps on an item.
2. On `guest-item-detail`, guest taps the **"Забронировать тайно"** button.
3. **If not unlocked:** The app navigates to `secret-reservation-paywall`.
4. App sends `POST /tg/billing/addon/checkout` with `{ skuCode: 'secret_reservation_unlock' }`.
5. Server generates a Telegram Stars invoice for **24 XTR** (type: permanent).
6. User completes payment via Telegram Stars. App calls `POST /tg/billing/addon/sync` to activate the add-on.

### Reservation

7. After the add-on is active, the guest confirms the secret reservation.
8. App sends the reservation request with a secret flag.
9. **On success:** The item is marked as reserved. The **owner sees the item is reserved but does NOT see who reserved it** — only that a secret reservation is in place.
10. The guest's reservation appears in **My secret reservations**, accessible from the profile screen or settings.

### Managing a secret reservation (`secret-reservation-detail`)

11. Guest opens their secret reservation detail view.
12. Available actions:
    - **Cancel** — releases the item back to available. Owner receives a notification that the reservation was cancelled (no identity revealed).
    - **Acknowledge item updates** — if the owner edits the item (price, title, etc.), the guest can acknowledge the change.
    - **Promote to public reservation** — converts the secret reservation into a normal (named) reservation; the guest's display name becomes visible to the owner.

**Edge cases:**
- The owner never learns the identity of the secret reserver unless the guest explicitly promotes to a public reservation.
- If the item is deleted or archived while secretly reserved, the guest sees `item-unavailable` on next open.
- Only one secret reservation per item per guest is allowed; attempting a second shows an informational message.

---

## Flow 29: Smart Reservations

**Actor:** Wishlist owner who wants reservations to auto-expire if not followed through; guests who make time-limited reservations.

**Precondition:** The `smart_reservations_unlock` add-on must be active for the specific wishlist (39 XTR per wishlist).

### Setup (owner)

1. Owner opens a wishlist and navigates to its **Settings** menu.
2. Owner finds the **Smart Reservations** toggle.
3. **If not unlocked:** A paywall is shown. App sends `POST /tg/billing/addon/checkout` with `{ skuCode: 'smart_reservations_unlock', targetId: wishlistId }`.
4. Server generates a Telegram Stars invoice for **39 XTR** per wishlist.
5. After payment, owner calls `POST /tg/billing/addon/sync` and the toggle activates for that wishlist.
6. Owner configures:
   - **TTL** (hours) — how long a reservation stays active before auto-release.
   - **Allow extend** — whether guests may extend their reservation timer.
   - **Max extensions** — maximum number of times a guest can extend.

### Guest reservation with timer

7. Guest opens a wishlist with Smart Reservations enabled and reserves an item.
8. The `item-detail` (guest view: `guest-item-detail`) shows **timer info**: time remaining until auto-release.
9. If the reservation expires: the item is **auto-released** back to available, and the **owner receives a notification**.
10. If `allowExtend = true` and the guest has not reached `maxExtensions`: the guest can tap **Extend** to reset the timer.

**Edge cases:**
- TTL is evaluated by a server-side cron; the client displays a countdown based on the server-returned `expiresAt` timestamp.
- Extensions are tracked per-reservation; exceeding `maxExtensions` disables the extend button.
- Disabling Smart Reservations on a wishlist does not immediately release existing active timers; they run to completion.

---

## Flow 30: Showcase (PRO profile)

**Actor:** Authenticated PRO user who wants to customize their public profile appearance.

**Precondition:** Active PRO subscription required.

### Entry

1. User opens the **Profile** screen.
2. User taps **"Настроить витрину"** (Customize showcase).
3. **If FREE:** A PRO upsell sheet is shown. Flow ends unless user upgrades.

### Editing (`showcase-editor`)

4. User lands on `showcase-editor`, which shows the current showcase state.
5. Editable fields:
   - **Cover photo** — upload a banner image displayed at the top of the public profile.
   - **Bio** — freeform text describing the user.
   - **Pinned wishlists** — select up to 3 wishlists to feature prominently on the public profile.
   - **Sizing preferences** — clothing/shoe sizes visible to gift-givers.
   - **Brand preferences** — preferred brands or stores (free text or chips).
6. User saves changes. App sends `PATCH /tg/me/showcase` with the updated fields.

### Preview (`showcase-preview`)

7. From `showcase-editor`, user taps **"Preview"** to open `showcase-preview`.
8. The preview renders exactly how the public profile will look to a visitor — cover photo, bio, pinned wishlists, sizing, brands.
9. User can return to `showcase-editor` to adjust before publishing.

### Guest view

10. When any user views a public profile via `public-profile`, the showcase data is displayed: cover photo, bio, pinned wishlists, sizing info, brand preferences.

**Edge cases:**
- If the PRO subscription lapses, the showcase data is retained but no longer displayed to guests until PRO is restored.
- Cover photo upload uses the same multipart endpoint pattern as item photos.

---

## Flow 31: Curated Selections

**Actor:** Authenticated PRO owner who wants to share a hand-picked subset of items from a wishlist.

**Precondition:** Active PRO subscription required.

### Creating a curated selection

1. Owner opens a **wishlist detail** view.
2. Owner enters item-selection mode (e.g. long-press or a selection action).
3. Owner selects the desired items.
4. Owner taps **"Поделиться подборкой"** (Share selection).
5. **If FREE:** A PRO upsell sheet is shown.
6. Owner optionally enters a name for the selection.
7. App sends `POST /tg/wishlists/:id/curated-selections` with `{ itemIds, name? }`.
8. Server creates a curated selection record with a unique `token` and returns the share link:
   ```
   https://{APP_HOST}/p/{token}
   ```
9. Owner copies or shares the link via Telegram.

### Guest access

10. Guest opens `/p/{token}` in a browser or within the app (deep link: `curated_{token}`).
11. The page/screen shows **only the selected items** from the wishlist — no other items are visible.
12. Guest can **subscribe** to the curated selection to receive update notifications when items change.

### Link management

13. Owner can view and revoke all active share tokens (wishlists + curated selections) from **Settings → Link Management**.
14. Revoking a curated selection token immediately makes the `/p/{token}` URL return 404.

**Edge cases:**
- A curated selection is a snapshot of item IDs; if the owner later deletes an item, it disappears from the selection view.
- Multiple curated selections can exist for the same wishlist simultaneously.
- Guests who subscribed to a deactivated selection stop receiving notifications.

---

## Flow 32: Profile Subscriptions

**Actor:** Any authenticated user who wants to follow another user's profile.

### Subscribing

1. User navigates to another user's `public-profile` screen.
2. User taps the **"Подписаться"** (Subscribe) button.
3. App sends `POST /tg/profiles/:userId/subscribe`.
4. **On success:** The profile appears in the **"Профили"** sub-tab within **Settings → Subscriptions**.

### Subscriptions view (Settings)

5. The Subscriptions section in Settings is split into two sub-tabs:
   - **Wishlists** — wishlists the user follows (existing behavior).
   - **Profiles** — user profiles the user follows (new).
6. Each profile entry shows the followed user's avatar, display name, and a link to their public profile.

### Unsubscribing

7. User taps on a followed profile entry (or visits their `public-profile`).
8. User taps **"Отписаться"** (Unsubscribe).
9. App sends `DELETE /tg/profiles/:userId/subscribe` (or equivalent).
10. The profile is removed from the Profiles sub-tab.

**Edge cases:**
- Subscribing to your own profile is not supported.
- If the followed user makes their profile private, the entry remains in the list but the profile content is inaccessible.

---

## Flow 33: Referral Program

**Actor:** Authenticated user who wants to invite friends and earn PRO rewards.

> **Current status:** Feature-flagged off globally via `ReferralProgramConfig.enabled = false`. Entry points are rendered but the program is inactive for all users.

### Entry points

- Profile screen banner
- Post-share banner (shown after sharing a wishlist)
- Paywall screen (referral CTA)
- Home screen banner (feature-flagged separately, currently hidden)

### Referral screen (`referral`)

1. User taps any referral entry point and lands on the `referral` screen.
2. The screen displays:
   - The user's **unique referral link** (e.g. `https://t.me/{BOT_USERNAME}?start=ref_{code}`).
   - A **Share** button to send the link via Telegram.
   - **Stats** showing how many friends have been invited and their qualification status.

### Qualification logic

3. Invitee clicks the referral link and starts the bot (the `ref_{code}` start parameter is captured server-side).
4. Invitee must meet both conditions within **14 days** of joining:
   - Create at least one wishlist.
   - Add at least one item to any wishlist.
5. When both conditions are met, the invitee's entry is marked as **qualified**.
6. The inviter receives **30 days of PRO** as a reward (credited automatically by the server).

### Referral history (`referral-history`)

7. User taps "View history" or a history link on the `referral` screen.
8. `referral-history` shows a list of attribution entries, each with:
   - Invitee's anonymized identifier (e.g. first name or masked username).
   - Status: `pending` (joined, not yet qualified) / `qualified` (criteria met) / `rewarded` (PRO credited).
   - Date of joining and date of qualification (if applicable).

**Edge cases:**
- The 14-day qualification window starts from the invitee's first bot interaction, not from when the referral link was shared.
- Self-referral (user uses their own referral link) is rejected server-side.
- Multiple referrals from the same user stack: each qualified invitee generates a separate 30-day PRO extension.
- While `enabled = false`, the referral link is visible but qualification and reward processing are paused.

---

## Flow 34: Item Placements (cross-wishlist)

**Actor:** Authenticated owner who wants an item to appear in multiple wishlists simultaneously.

### Adding an item to additional wishlists

1. Owner opens an item (via `item-detail`).
2. Owner selects the **"Добавить в вишлист"** (Add to wishlist) action from the item menu.
3. A wishlist picker appears showing all of the owner's wishlists, with the item's current wishlist(s) marked.
4. Owner selects one or more additional wishlists.
5. App sends the placement request; server creates `WishlistItemPlacement` junction records linking the item to each selected wishlist.
6. The item now appears in all placed wishlists.

### Behavior of placed items

- **Changes are reflected everywhere:** editing the item's title, description, price, photo, or priority in any wishlist updates it across all placements.
- **Reservation state is shared:** if a guest reserves the item from one wishlist, it appears as reserved in all wishlists that contain it.
- **Removal is per-placement:** removing the item from one wishlist removes only that placement; other wishlists retain the item.

### Removing a placement

7. Owner opens the item in a wishlist where it is placed (but not the "home" wishlist).
8. Owner selects **"Убрать из вишлиста"** (Remove from this wishlist).
9. App sends the remove-placement request; only the junction record for that wishlist is deleted. The item itself is not deleted.

**Edge cases:**
- An item always has at least one home wishlist; removing the last placement deletes the item from the system (or moves it to Drafts, depending on configuration).
- Item limits are counted per wishlist; placing an item in an additional wishlist counts toward that wishlist's item cap.
- The `item-detail` screen shows a list of all wishlists the item is currently placed in.

---

## Flow 35: Birthday Reminders

**Actors:** Birthday user (the one whose birthday is upcoming) and recipient (a subscriber, wishlist subscriber, reserver, or secret reserver). FREE and PRO users have different windows; PRO unlocks the advanced controls (audience EXTENDED, primary wishlist, custom message, advanced windows).

### Stage 1 — User adds a birthday and opts in

1. User opens **profile edit** and sets a birthday (and optionally `hideYear`).
2. After the first save with a birthday set, the Mini App shows a one-time **opt-in BottomSheet** (gated by `birthdayFriendReminders === false && birthdayOptInPromptSeenAt === null`). It explains: *"We can remind your friends 14 days before and on the day, so they have time to pick a gift."* Buttons: **Enable reminders** / **Not now**.
3. **Enable reminders** → `PATCH /tg/me/birthday-settings` with `{ friendRemindersEnabled: true, optInPromptSeen: true }`. Fires `birthday.optin_accepted`.
4. **Not now** → `PATCH /tg/me/birthday-settings` with `{ optInPromptSeen: true }`. Fires `birthday.optin_dismissed`. The sheet does not re-appear; the user can still enable manually in Settings → 🎂 День рождения.
5. Owner self-reminders (`birthdayOwnerReminders`) default to `true` — no opt-in required.

### Stage 2 — Scheduler fires reminders

Hourly tick within the 9–22 MSK window (`processBirthdayReminders` in `apps/api/src/index.ts`). For each user with a birthday matching offsets [30, 14, 7, 1, 0] from today (MSK):

**FREE friend reminders:** `friend_14d` and `friend_today` are sent to the SUBSCRIBERS audience (profile + non-`NOBODY` wishlist subscribers). Day-of bypasses the daily cap.

**PRO friend reminders (advanced windows):** add `friend_7d` and `friend_1d`. EXTENDED audience adds reservers + secret reservers.

**Owner self-reminders:** `owner_30d` (FREE+PRO). PRO with advanced windows adds `owner_14d` and `owner_7d`, but only when there's a problem to solve (no public wishlist OR no active public items). `owner_today` always fires as a soft congratulations — never urgency-CTA.

Each delivery is a `BirthdayReminderDelivery` row with unique `(birthdayUserId, recipientUserId, occurrenceKey, reminderKind)` — duplicate-send-proof.

**Daily cap:** 3 friend reminders per recipient per MSK day; excess parked as `status: 'deferred'`, `deferredUntil = next MSK 10:00`.

### Stage 3 — Recipient acts on the bot DM

6. Recipient gets a Telegram DM with the birthday user's name, optional custom message, optional avatar, and an inline keyboard: **WebApp button** (deep-link `br_<deliveryId>`) + **🔕 Не напоминать об этом человеке**.
7. Tap the WebApp button → Mini App opens, calls `GET /tg/birthday-reminders/resolve/:deliveryId`. Server sets `clickedAt`, re-resolves the target (handles wishlist that became private after send → falls back to public profile), returns birthday context.
8. Mini App routes to public wishlist / public profile / own wishlist based on `targetType`. The **birthday context banner** shows on the destination screen — tone `info` (upcoming) or `warning` (today). Banner is dismissible per session; fires `birthday.banner_seen` once via dataset guard.
9. Recipient reserves a gift / sends a hint / subscribes. Each action is tracked with `birthdaySource: true` props for attribution.
10. Tap **🔕 Не напоминать** → `bdm:<deliveryId>` callback. Bot upserts `BirthdayReminderMute`, edits the keyboard to drop the mute button, answers with a localised toast.

### Stage 4 — Owner acts on the self-reminder

11. Owner gets `owner_30d` DM: *"Через 30 дней день рождения — обнови вишлист."* WebApp button opens own wishlist (or **Create wishlist** screen if none exists).
12. Conditional `owner_14d` / `owner_7d` (PRO) only fire if there's still no public wishlist or no active public items.
13. `owner_today`: soft congratulations, no urgency CTA, never promises a wishlist will appear.

### Edge cases

- **No public wishlist:** friend CTAs deep-link into the public profile instead. Never produces a "wishlist will appear" promise.
- **`hideYear: true`:** the bot DM omits age and any year-derived phrasing.
- **`profileVisibility: NOBODY`:** outgoing friend reminders are skipped with `skipReason: 'profile_private'`.
- **Recipient `notifyBirthdays: false`:** all incoming birthday DMs skipped with `recipient_opted_out`.
- **Recipient muted this birthday user:** skipped with `muted`.
- **Recipient daily cap (3) exceeded:** `deferred` until next MSK 10:00.
- **Bot blocked by recipient:** `failed` with `failureReason` set; never retried for that occurrence.
- **PRO downgrade:** advanced fields preserved in DB but treated as inactive; corresponding deliveries skipped with `pro_required` and surface in the God Mode dashboard.
- **Feb-29 birthday in non-leap year:** mapped to Feb-28.

See `docs/SETTINGS_AND_PRIVACY.md` § Birthday reminders, `docs/MONETIZATION.md` § 16a, `docs/BACKEND_MAP.md` § 13 (cron), `docs/DATA_MODEL.md` (`BirthdayReminderDelivery`, `BirthdayReminderMute`).

---

## Flow 36: Events Calendar v2.1

**Shipped 2026-04-28** (commit `e9980b2`). Personal calendar of gift-giving occasions, layered on top of the Gift Notes notebook. Free feature; no paywall on core surfaces (paywall polish from `df01d53` covers narrow Pro extensions only).

### First launch

1. User opens the **Calendar** screen for the first time. The Mini App calls `GET /tg/calendar/today-context` and `GET /tg/gift-occasions`.
2. If `User.calendarOnboardingSeenAt` is `null`, the Mini App shows a **4-step onboarding** (intro / occasions / reminders / import). User dismisses or finishes.
3. Mini App calls `POST /tg/calendar/onboarding-seen` → server sets `User.calendarOnboardingSeenAt = now()`. Different devices share the dismissal (was localStorage-only before, which made every fresh client re-run the flow — see `commit a7723e4` and the earlier `feedback_explicit_optin_after_data` memory).

### Today-context banner

4. Calendar home shows a "today-context" banner from `GET /tg/calendar/today-context`: today's date, count of upcoming events, today's events array, holiday today (if any), pending reminders. `daysUntil` is computed from UTC midnight to avoid an off-by-one bug at MSK boundary (`commit 05df77f`).

### Creating an occasion

5. User taps **+** → create wizard opens with type chooser (Birthday / Anniversary / Holiday / Other).
6. Custom emoji picker (quick-pick + "Свой" custom-input with autofocus). Single-grapheme + emoji-only validation.
7. Date picker: separate **day / month / year sheets** (`commit 1ef1afb`).
8. Optional fields: time (`HH:mm`), location, budget (min / max + currency), note.
9. Save → `POST /tg/gift-occasions` with `source: 'USER'`.

### Importing holidays

10. User opens "Import holidays" sheet → Mini App calls `GET /tg/calendar/holidays?country=XX` (default: derived from user locale). Server resolves localized holiday name from the `Holiday` row.
11. User selects holidays → `POST /tg/calendar/import-holidays` with `{ holidayKeys: [...] }`. Server creates `GiftOccasion` rows with `source: 'IMPORTED_HOLIDAY'` + `holidayKey` + `country`. The unique `(ownerUserId, holidayKey)` constraint silently dedups re-imports.

### Importing friend birthdays

12. User opens "Import friend birthdays" → Mini App calls `GET /tg/calendar/friends-bdays`. Server returns connected/subscribed users with `birthday` set, honouring `profileVisibility` and `hideYear`.
13. User selects friends → `POST /tg/calendar/import-friends-bdays`. Server creates `GiftOccasion` rows with `source: 'IMPORTED_FRIEND'` and `linkedUserId` populated. If the linked user later deletes their account, `linkedUserId` becomes `null` (SetNull) but the occasion is preserved.

### Adding ideas

14. Open occasion detail → expandable idea cards (`commit 2ad5cb7`).
15. Add idea → `POST /tg/gift-occasions/:id/ideas`. Body may include `imageUrl` (set later via `POST /tg/gift-occasion-ideas/:ideaId/photo` multipart upload — lock-only for idempotency, no replay).
16. Each idea has: text, link, price, currency, note, and optional image.

### Reminders

17. User toggles reminders on an occasion → `POST /tg/gift-occasions/:id/reminders` with `{ offsetDays, timeOfDay?, enabled? }`. Default `timeOfDay: "10:00"` MSK.
18. Server derives a unique `episodeKey` from `(occasionId, occurrenceDate, offsetDays)` so re-runs of the scheduler dedup automatically.
19. When a reminder fires (cron), the bot DMs the user *and* writes a `CalendarInboxEntry`.

### Inbox

20. Inbox icon shows unread count from `GET /tg/calendar/inbox`. User taps an entry → `POST /tg/calendar/inbox/:id/read`. "Mark all read" → `POST /tg/calendar/inbox/read-all`.

### Marking DONE / Year-Recap

21. User marks an event as DONE → `POST /tg/gift-occasions/:id/complete`. Body may include Year-Recap fields: `actualGiftText`, `actualGiftAmount`, `actualGiftCurrency`, `thankYouNote`, `thankYouAt`.
22. Year-Recap UI (`GET /tg/calendar/year-recap`) aggregates the past year's completed occasions and surfaces gift-history + thank-you notes.

### Edge cases

- **`daysUntil`** normalized to UTC midnight, fixing the today/tomorrow off-by-one (`commit 05df77f`, `commit 645d462` changelog entry).
- **Soft links** (`linkedUserId` / `linkedWishlistId` / `linkedSantaId`) are SetNull on delete — occasions outlive the entities they referenced.
- **Holiday dedup**: `(ownerUserId, holidayKey)` unique — re-importing the same set is idempotent.
- **Multipart upload (idea photo)** opts out of idempotency replay — the row is stored lock-only.
- **TabBar clearance** ensured for FloatingNav (`commit aab3e3b`).
- **Onboarding glyph quality / settings width / copy polish** across rounds 1–3 of bug-fix sweeps (`commit ea6b568`, `6212217`, `f610963`).

See `docs/DATA_MODEL.md` (`GiftOccasion`, `GiftOccasionIdea`, `GiftOccasionReminder`, `Holiday`, `CalendarInboxEntry`), `docs/API_REFERENCE.md` § Events Calendar v2.1.

---

## Flow 37: Guest → Account Claim (E11 post-reservation CTA)

**Actor:** Guest who has just successfully reserved an item on a friend's wishlist and has **no wishlists of their own**.

> **Shipped 2026-05** (commits `0268fe2`, `90e8f01`, `b9fadd2`). This is the most viral moment in the product — the user just reserved a gift and is one tap from owning the other side of the loop. It is an **A/B experiment, off by default.** Decision logic: `apps/web/app/miniapp/lib/postReservationCta.ts` (pure, fully unit-tested); rendering + handlers in `MiniApp.tsx`.

### Experiment gating

- Experiment key: **`e11-post-reserve-cta`**, resolved server-side via `useExperiment`. The Mini App reads the bucket (`control` / `treatment`).
- Enable per host in `/opt/wishlist/.env` (then `docker compose up -d api`):
  ```
  EXP_E11_POST_RESERVE_CTA_ENABLED=true
  EXP_E11_POST_RESERVE_CTA_ROLLOUT=50
  ```
  Without these the hook returns `control` and the sheet never shows.

### Flow

1. Guest reserves an item in surprise mode ([Flow 7](#flow-7-reservation-surprise-mode)) — a **regular** (non-secret) reservation succeeds.
2. The client evaluates `shouldShowE11Cta(...)`. Gate order (first `show: false` wins): per-session de-dup (`session_shown`) → god-mode force bypass → wishlists actually loaded (`wishlists_not_loaded`, conservative so a transient `/tg/wishlists` 5xx can't mistake an owner for a guest) → not a secret reservation (`secret_reservation`) → user has **zero own wishlists** (`owner_as_guest`) → experiment is `treatment` (`not_in_treatment`) → 30-day localStorage cooldown (`cooldown`, key `wb_e11_cta_seen_at_v1`).
3. **If all gates pass:** instead of the usual reservation-success toast, a **BottomSheet** opens (it *is* the success confirmation). Copy (`e11_cta_*` i18n keys):
   - Title: *"Готово, подарок скрыт от владельца 🎁"* ("Done — the gift stays hidden from the owner")
   - Subtitle: *"Хочешь сделать свой вишлист, чтобы тебе тоже дарили без угадайки?"*
   - Info banner: *"Добавь пару желаний и поделись ссылкой — это ~1 минута."*
   - Primary button: **"Создать мой вишлист"** · Ghost button: **"Позже"**
4. The session flag is set, a 30-day cooldown timestamp is written to localStorage, and `guest_owner_cta.shown` fires (`experimentKey`, `variant`, `godModeForce`).
5. **Primary tap ("Создать мой вишлист"):** fires `guest_owner_cta.clicked` (`destination: 'onboarding-entry'`) and launches onboarding with entry point **`post_reservation_claim`** (→ [Flow 1](#flow-1-onboarding--first-launch-v2)). First-touch attribution tags the resulting `guest.converted_to_user` conversion to this entry point.
6. **Dismiss:** the ghost "Позже" button fires `guest_owner_cta.dismissed` (`method: 'tap_later'`); swipe / backdrop fires it with `method: 'swipe_or_backdrop'`. Either way the sheet closes and the guest stays a guest until next eligibility.

### Edge cases

- **One shot per app-open** — `session_shown` wins even over the god-mode force-show, so operators testing the sheet still see it at most once per session.
- **Secret reservations are excluded** (different paywall context, [Flow 28](#flow-28-secret-reservations)).
- **Owners never see it** — the `owner_as_guest` gate (wishlist count > 0) skips anyone who already owns a list, including [Flow 19](#flow-19-guest-detecting-they-are-the-owner) owner-as-guest.
- **God-mode force** (`godModeForce: true`) bypasses segmentation / experiment / cooldown for operator verification; all E11 analytics carry `godModeForce` so the funnel can filter operator impressions (`WHERE NOT (props->>'godModeForce' = 'true')`).
- **localStorage write is best-effort** — quota / private-mode failures are swallowed; worst case the sheet re-shows next session.

See `apps/web/app/miniapp/lib/postReservationCta.ts`, `docs/research/06-experiment-backlog.md` § E11, `docs/design-system/mockups/approved/e11-post-reservation-cta.html`.
