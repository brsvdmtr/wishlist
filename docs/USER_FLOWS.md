# WishBoard — User Flows

> Source of truth for all user journeys. Last updated: 2026-04-02 · Branch: main
>
> This document reflects the product as implemented, not aspirational features.

---

## Table of Contents

1. [Onboarding / First Launch (v2)](#flow-1-onboarding--first-launch-v2)
2. [Creating a Wishlist](#flow-2-creating-a-wishlist)
3. [Adding a Wish (Manual)](#flow-3-adding-a-wish-manual)
4. [Adding a Wish via URL Import (PRO)](#flow-4-adding-a-wish-via-url-import-pro)
5. [Sharing a Wishlist](#flow-5-sharing-a-wishlist)
6. [Guest Viewing a Wishlist](#flow-6-guest-viewing-a-wishlist)
7. [Reservation (Surprise Mode)](#flow-7-reservation-surprise-mode)
8. [Comments (PRO)](#flow-8-comments-pro)
9. [Hints (PRO)](#flow-9-hints-pro)
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

---

## Plans Reference

| Feature | FREE | PRO |
|---|---|---|
| Wishlists | 2 | 10 |
| Items per wishlist | 20 | 70 |
| Participants (reservers) | 5 | 20 |
| Subscriptions | 2 | 5 |
| Comments | — | Yes |
| URL Import | — | Yes |
| Hints | — | Yes |
| Visibility: PUBLIC_PROFILE / PRIVATE | — | Yes |
| allowSubscriptions: NOBODY | — | Yes |
| commentPolicy: SUBSCRIBERS | — | Yes |
| Notification settings | — | Yes |
| Gift Notes | 19 XTR one-time | Included |

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

## Flow 4: Adding a Wish via URL Import (PRO)

**Actor:** Authenticated PRO owner, inside an open wishlist.

1. User opens a wishlist.
2. User taps the **link/import icon** (distinct from the "+" button).
3. **If FREE user:** The app shows an **upsell sheet** with reason `url_import` before any import is attempted. Flow ends here unless the user upgrades.
4. **If PRO user:** An input field appears for pasting a product URL.
5. User pastes a URL. Supported domains include: Ozon, Wildberries, Yandex Market, Lamoda, Goldapple, Tekhnopark, Bork, Amazon, IKEA, Sephora, Nike, and arbitrary public URLs.
6. App sends `POST /tg/import-url` with `{ url }`.
7. Server validates the URL, scrapes the product page, and extracts available data: title, price, and product image.
8. **On success:** A new item is created and placed in the **Drafts** wishlist, not the current wishlist.
9. User navigates to Drafts to review the imported item, edit fields if needed, and optionally move it to another wishlist.
10. **On 402:** Upsell sheet with reason `url_import` is shown.
11. **On rate limit (429):** The user has exceeded 10 import requests within 60 seconds. A rate-limit error is shown and the user must wait.

**Edge cases:**
- Items always land in Drafts regardless of which wishlist the user is viewing when they trigger the import.
- If the server cannot scrape the target page (e.g. anti-bot protection, unsupported domain), partial data or an error is returned; the user can manually complete missing fields.
- Rate limit: **10 requests per 60 seconds** per user.

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
9. **On 402 (participants limit):** The wishlist has reached its participant limit (5 for FREE owner, 20 for PRO owner). A message is shown that the list is full and no new reservations can be made.

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

## Flow 9: Hints (PRO)

**Actor:** Authenticated PRO owner.

**Precondition:** User must have an active PRO subscription.

1. Owner opens a wishlist and taps on one of their own items.
2. Item detail view shows a **"Hint"** button (visible to PRO owners only).
3. Owner taps **"Hint"**.
4. A contact selector appears; owner picks a specific friend (contact) to send the hint to.
5. App sends `POST /tg/items/:id/hint` with `{ recipientId }` (or equivalent contact identifier).
6. Server creates a **time-limited hint record** (valid for **72 hours**) visible only to the selected recipient.
7. The recipient, when they open the wishlist item via a share link, sees the hint nudge during the 72-hour window.
8. After 72 hours the hint expires automatically.

**Edge cases:**
- If the owner is on FREE, the **"Hint"** button is not shown, or tapping it shows the PRO upsell.
- The hint is visible **only** to the specified recipient, not to all guests.
- Sending multiple hints to the same recipient for the same item creates a new 72-hour window.

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

1. User taps **"Get Pro"** from any upsell sheet or the Settings screen.
2. App sends `POST /tg/billing/pro/checkout`.
3. Server generates a Telegram Stars invoice and returns an `invoiceLink`.
4. App calls `Telegram.WebApp.openInvoice(invoiceLink)`.
5. Telegram's native payment sheet opens, showing the cost: **100 Stars / month**.
6. User confirms payment within Telegram.
7. Telegram processes the payment and sends a `successful_payment` update to the bot.
8. Server receives `successful_payment`, creates a `Subscription` record, and marks the user's plan as PRO.
9. App sends `POST /tg/billing/pro/sync` to confirm the subscription is active and refresh the local plan state.
10. The UI updates immediately: PRO badge appears, PRO features become accessible, limits are raised.
11. If a degradation state exists for the user (see [Flow 23](#flow-23-lifecycle--degradation)), it is cleared and any archived data is restored.

**Edge cases:**
- If the user closes the payment sheet without paying, the flow is cancelled and the user remains on FREE.
- If `successful_payment` is received but `/sync` fails (e.g. network error), the plan will be corrected on the next app open when the auth state is refreshed.
- The subscription is billed monthly via Telegram Stars. Renewal is handled by Telegram's subscription infrastructure.

---

## Flow 17: PRO Subscription Cancellation

**Actor:** Authenticated PRO user.

1. User opens **Settings**.
2. User finds the **PRO card** showing their current subscription status and renewal date.
3. User taps **"Cancel renewal"**.
4. An **anti-churn sheet** appears listing **8 features** the user will lose upon cancellation.
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
