> Source of truth for user settings, privacy controls, and notification preferences.
> Last updated: 2026-03-17 · Branch: claude/wizardly-satoshi

# Settings and Privacy

---

## 1. Overview

Settings are split across two scopes:

| Scope | What it controls | Where it lives |
|---|---|---|
| **Profile-level** | Notifications, profile visibility, subscribe policy, UI preferences | `UserProfile` row, `PATCH /tg/me/settings` |
| **Wishlist-level** | Who can view a specific list, subscribe to it, or comment on it | `Wishlist` row, `PATCH /tg/wishlists/:id` |

Profile-level settings apply globally to the user. Wishlist-level settings override or extend profile-level behavior for individual lists.

Some settings are gated behind the PRO plan. For FREE users, sending a PRO-only value is **silently ignored** at the profile level, or returns **HTTP 403** at the wishlist level — behavior depends on the setting.

---

## 2. Notification Settings

All four notification toggles live on `UserProfile`. They control whether the Telegram bot sends a message to the user when the corresponding event occurs.

| Field | Default | Trigger event |
|---|---|---|
| `notifyComments` | `true` | Someone posts a comment on one of your items |
| `notifyReservations` | `true` | Someone reserves or unreserves one of your items |
| `notifySubscriptions` | `true` | Someone subscribes to one of your wishlists |
| `notifyMarketing` | `false` | Promotional / marketing messages from the service |

### PRO gating

All four notification settings are **PRO-only**. For FREE users:

- `PATCH /tg/me/settings` accepts the payload without error.
- The new values are **not applied** — they are silently ignored.
- The user's effective notification preferences remain at their defaults regardless of what they send.

This means FREE users cannot disable notifications, and cannot enable marketing notifications.

---

## 3. Privacy Settings — Profile Level

These fields on `UserProfile` are set via `PATCH /tg/me/settings` and are available to all users (no PRO gate).

### `profileVisibility`

Controls whether the user's public profile page is accessible.

| Value | Effect |
|---|---|
| `ALL` (default) | Profile is publicly accessible at `/public/profile/:username` |
| `LINK_ONLY` | Profile accessible only to users with a direct link (implementation: same as ALL at the HTTP level; no strict enforcement beyond intent) |
| `SUBSCRIBERS` | Profile visible only to users who subscribe to at least one of the owner's wishlists |
| `NOBODY` | `GET /public/profile/:username` returns **404** — profile is fully hidden |

Note: `profileVisibility` does not gate access to individual wishlists reached via a direct share link. A user can share a wishlist link even when their profile is hidden.

### `subscribePolicy`

Controls who may subscribe to any of the user's wishlists at the profile level (a second, per-wishlist gate also exists — see Section 4).

| Value | Effect |
|---|---|
| `ALL` (default) | Anyone can subscribe |
| `LINK_ONLY` | Only users who have the direct wishlist link can subscribe |
| `APPROVED` | Subscription requests require manual approval (reserved for future use) |
| `NOBODY` | All subscription attempts are blocked at the owner-profile level |

### Subscribe enforcement order

When a user attempts to subscribe to a wishlist, two checks run in sequence:

1. **Wishlist-level gate:** `wishlist.allowSubscriptions === 'NOBODY'` → block.
2. **Owner-profile gate:** `ownerProfile.subscribePolicy === 'NOBODY'` → block.

Both must pass for a subscription to succeed.

---

## 4. Privacy Settings — Wishlist Level

Each wishlist has three privacy fields, set via `PATCH /tg/wishlists/:id`. All three have PRO gates — see Section 5.

### `visibility`

| Value | Who can see the wishlist | PRO required? |
|---|---|---|
| `LINK_ONLY` (default) | Only users with the share link | No |
| `PUBLIC_PROFILE` | Anyone who visits the owner's public profile | Yes — **403** for FREE |
| `PRIVATE` | No one (archived/hidden from all) | Yes — **403** for FREE |

### `allowSubscriptions`

| Value | Effect | PRO required? |
|---|---|---|
| `ALL` (default) | Anyone (subject to profile-level policy) can subscribe | No |
| `NOBODY` | Subscriptions to this specific wishlist are blocked | Yes — **403** for FREE |

### `commentPolicy`

| Value | Effect | PRO required? |
|---|---|---|
| `ALL` (default) | Any user with comment access can comment | No |
| `SUBSCRIBERS` | Only users who have reserved at least one item can comment | Yes — **403** for FREE |

### Comment access — dual gate

Comments have a PRO gate on **both sides** of the interaction:

- `POST /tg/items/:id/comments` (authenticated): checks whether the **wishlist owner's** plan includes the `comments` feature.
- `POST /public/items/:id/comments` (public): checks whether the **commenter's** plan includes `comments` AND that the wishlist `commentPolicy` allows it.

A comment succeeds only when the applicable gate passes. A FREE user cannot comment on a PRO owner's wishlist, and a PRO user cannot comment on a FREE owner's wishlist (through the public endpoint).

---

## 5. PRO-Gated Settings Summary

| Setting | Scope | FREE user behavior |
|---|---|---|
| `notifyComments` | Profile | Silently ignored — value not applied |
| `notifyReservations` | Profile | Silently ignored — value not applied |
| `notifySubscriptions` | Profile | Silently ignored — value not applied |
| `notifyMarketing` | Profile | Silently ignored — value not applied |
| `newWishlistPosition=bottom` | Profile | Silently ignored — value not applied |
| `visibility=PUBLIC_PROFILE` | Wishlist | HTTP 403 |
| `visibility=PRIVATE` | Wishlist | HTTP 403 |
| `allowSubscriptions=NOBODY` | Wishlist | HTTP 403 |
| `commentPolicy=SUBSCRIBERS` | Wishlist | HTTP 403 |
| Posting a comment | Item | HTTP 403 (checked via `plan.features`) |

Profile-level PRO settings fail silently (no error, value discarded). Wishlist-level PRO settings return 403.

---

## 6. God Mode

God Mode grants a virtual PRO subscription for development and testing without any billing.

- **Activation:** Set the `GOD_MODE_TELEGRAM_IDS` environment variable to a comma-separated list of Telegram user IDs.
- **Effect:** The user is treated as PRO in all plan feature checks.
- **UI label:** Shown in the settings screen as "⚡ Режим бога".
- **Billing:** No subscription is created; no payment is involved.

God Mode is intended for internal use only and should not be enabled in production for real users.

---

## 7. API Reference

### GET settings (inlined in plan response)

Settings are returned as part of the plan/profile response rather than a dedicated endpoint. The shape of the settings block:

```json
{
  "notifyComments": true,
  "notifyReservations": true,
  "notifySubscriptions": true,
  "notifyMarketing": false,
  "newWishlistPosition": "top",
  "profileVisibility": "ALL",
  "subscribePolicy": "ALL"
}
```

### PATCH /tg/me/settings

Update one or more profile-level settings.

**Auth:** Telegram Mini App init data required.

**Request body** (all fields optional):

```json
{
  "notifyComments": true,
  "notifyReservations": false,
  "notifySubscriptions": true,
  "notifyMarketing": false,
  "newWishlistPosition": "top",
  "profileVisibility": "ALL",
  "subscribePolicy": "NOBODY"
}
```

**Accepted enum values:**

| Field | Values |
|---|---|
| `newWishlistPosition` | `"top"` \| `"bottom"` |
| `profileVisibility` | `"ALL"` \| `"LINK_ONLY"` \| `"SUBSCRIBERS"` \| `"NOBODY"` |
| `subscribePolicy` | `"ALL"` \| `"LINK_ONLY"` \| `"APPROVED"` \| `"NOBODY"` |

**Response:** Updated `UserProfile` object (HTTP 200).

**Notes:**
- PRO-only fields sent by FREE users are silently ignored in the response (no error).
- `defaultCurrency` (enum: `RUB` | `USD`) exists in the schema but is not yet surfaced in the API.

### PATCH /tg/wishlists/:id (privacy fields)

Update wishlist-level privacy fields alongside other wishlist properties.

**Auth:** Telegram Mini App init data required. Must be the wishlist owner.

**Relevant fields:**

```json
{
  "visibility": "LINK_ONLY",
  "allowSubscriptions": "ALL",
  "commentPolicy": "ALL"
}
```

**Accepted enum values:**

| Field | Values |
|---|---|
| `visibility` | `"LINK_ONLY"` \| `"PUBLIC_PROFILE"` \| `"PRIVATE"` |
| `allowSubscriptions` | `"ALL"` \| `"NOBODY"` |
| `commentPolicy` | `"ALL"` \| `"SUBSCRIBERS"` |

**Response:** Updated `Wishlist` object (HTTP 200), or HTTP 403 if the value requires PRO and the user is FREE.
