> Source of truth for user settings, privacy controls, and notification preferences.
> Last updated: 2026-04-02 · Branch: main

# Settings and Privacy

---

## 1. Overview

Settings are split across three scopes:

| Scope | What it controls | Where it lives |
|---|---|---|
| **Profile-level** | Notifications, privacy, language, currency, UI preferences | `UserProfile` row, `PATCH /tg/me/settings` |
| **Wishlist-level** | Who can view a specific list, subscribe to it, or comment on it | `Wishlist` row, `PATCH /tg/wishlists/:id` |
| **Language** | Auto/manual locale selection, RTL rendering | `UserProfile.languageMode` + `manualLanguage`, resolved via `resolveEffectiveLocale()` |

Profile-level settings apply globally to the user. Wishlist-level settings override or extend profile-level behavior for individual lists.

Some settings are gated behind the PRO plan. For FREE users, sending a PRO-only value is **silently ignored** at the profile level, or returns **HTTP 403** at the wishlist level — behavior depends on the setting.

---

## 2. Language Settings

The app supports six locales: `ru`, `en`, `zh-CN`, `hi`, `es`, `ar`.

### Language mode

| Mode | Behavior |
|---|---|
| `auto` (default) | Locale is derived from Telegram's `language_code` via `normalizeLocale()`. Falls back to `en` for unrecognised codes. |
| `manual` | Uses the value stored in `manualLanguage`. When switching back to `auto`, `manualLanguage` is cleared to `null`. |

### Effective locale resolution (`resolveEffectiveLocale()`)

Single source of truth used by API, bot, and Mini App:

1. If `languageMode = 'manual'` and `manualLanguage` is set, use `manualLanguage`.
2. Otherwise, `normalizeLocale(telegramLanguageCode)` -- falls back to `en`.

This function lives in `packages/shared/src/i18n.ts` and must be used everywhere locale is determined.

### RTL support

Arabic (`ar`) is the only RTL locale. `isRTL(locale)` returns `true` for `ar`, used to set `dir="rtl"` on the Mini App root container.

### Support ID

Each user has a `supportId` on their `UserProfile` -- a 16-character lowercase hex string generated via `crypto.randomBytes(8)`. It is:

- Created on first profile creation for new users.
- Lazy-backfilled for pre-migration users (existing rows without a `supportId` get one on next profile access).
- Guaranteed unique (up to 10 collision retries, then falls back to 32-char hex).
- Returned in `GET /tg/me/settings` and `GET /tg/me` (owner-only, never exposed in public/share responses).

---

## 3. Notification Settings

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

## 4. Privacy Settings — Profile Level

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

## 5. Privacy Settings — Wishlist Level

Each wishlist has three privacy fields, set via `PATCH /tg/wishlists/:id`. All three have PRO gates — see Section 6.

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

### Comment access — either-party gate (OR logic)

Comments use OR logic for PRO gating: the code checks if **both** parties lack the `comments` feature. If **either** party (owner or commenter) has PRO, access is granted.

- `POST /tg/items/:id/comments` (authenticated): checks whether **either** the wishlist owner or the commenter has `comments` in their plan features.
- `POST /public/items/:id/comments` (public): same OR logic applies, plus the wishlist `commentPolicy` is checked.

A comment succeeds when at least one side has PRO. A PRO user can comment on a FREE owner's wishlist, and a FREE user can comment on a PRO owner's wishlist.

### `commentsEnabled` (profile-level privacy)

| Value | Effect | PRO required? |
|---|---|---|
| `true` (default) | Comments feature is enabled for the user | Yes -- PRO-gated (silently ignored for FREE) |
| `false` | User opts out of comments on their wishlists | Yes -- PRO-gated (silently ignored for FREE) |

### `hintsEnabled` (profile-level privacy)

| Value | Effect | PRO required? |
|---|---|---|
| `true` (default) | Hint feature is enabled | No |
| `false` | User disables hints; `POST /tg/items/:id/hint` returns 403 | No |

### `cardDisplayMode` (app behavior)

| Value | Effect | PRO required? |
|---|---|---|
| `auto` (default) | System chooses card layout | No (FREE always sees `auto`) |
| `showcase` | Large image-first card layout | Yes -- FREE users always resolve to `auto` |
| `compact` | Dense list layout | Yes -- FREE users always resolve to `auto` |

---

## 6. PRO-Gated Settings Summary

| Setting | Scope | FREE user behavior |
|---|---|---|
| `notifyComments` | Profile | Silently ignored — value not applied |
| `notifyReservations` | Profile | Silently ignored — value not applied |
| `notifySubscriptions` | Profile | Silently ignored — value not applied |
| `notifyMarketing` | Profile | Silently ignored — value not applied |
| `newWishlistPosition=bottom` | Profile | Silently ignored — value not applied |
| `cardDisplayMode` | Profile | Silently ignored — FREE always resolves to `auto` |
| `commentsEnabled` | Profile | Silently ignored — value not applied |
| `visibility=PUBLIC_PROFILE` | Wishlist | HTTP 403 |
| `visibility=PRIVATE` | Wishlist | HTTP 403 |
| `allowSubscriptions=NOBODY` | Wishlist | HTTP 403 |
| `commentPolicy=SUBSCRIBERS` | Wishlist | HTTP 403 |
| Posting a comment | Item | HTTP 403 (checked via `plan.features`) |

Profile-level PRO settings fail silently (no error, value discarded). Wishlist-level PRO settings return 403.

---

## 7. God Mode

God Mode grants a virtual PRO subscription for development and testing without any billing.

- **Activation:** Set the `GOD_MODE_TELEGRAM_IDS` environment variable to a comma-separated list of Telegram user IDs.
- **Toggle endpoint:** `POST /tg/me/god-mode` -- flips `user.godMode` boolean. Returns `{ godMode: true/false }`. Only whitelisted Telegram IDs may call this; others get 403.
- **Effect:** The user is treated as PRO in all plan feature checks (`proSource: 'god_mode'`).
- **UI label:** Shown in the settings screen as "⚡ Режим бога".
- **Billing:** No subscription is created; no payment is involved.
- **Analytics:** God Mode stats endpoint includes `localeSegments` -- users grouped by effective locale (scopes: `active30d`, `new7d`, `all`) with per-locale counts, computed via SQL CASE normalisation of raw `language_code`.

God Mode is intended for internal use only and should not be enabled in production for real users.

---

## 8. API Reference

### GET /tg/me/settings

Returns all user settings in a structured response.

**Auth:** Telegram Mini App init data required.

**Response shape:**

```json
{
  "languageMode": "auto",
  "manualLanguage": null,
  "effectiveLanguage": "en",
  "defaultCurrency": "USD",
  "notifications": {
    "comments": true,
    "reservations": true,
    "subscriptions": true,
    "marketing": false
  },
  "privacy": {
    "profileVisibility": "ALL",
    "subscribePolicy": "ALL",
    "commentsEnabled": true,
    "hintsEnabled": true
  },
  "appBehavior": {
    "newWishlistPosition": "bottom",
    "cardDisplayMode": "auto"
  },
  "isPro": false,
  "supportId": "a1b2c3d4e5f6a7b8"
}
```

**Notes:**
- FREE users: `notifications` are normalised to all `true` (they cannot opt out).
- FREE users: `appBehavior.newWishlistPosition` is normalised to `"bottom"`, `cardDisplayMode` to `"auto"`.
- `supportId` is owner-only, never exposed in public/share responses.

### PATCH /tg/me/settings

Update one or more profile-level settings.

**Auth:** Telegram Mini App init data required.

**Request body** (all fields optional, nested):

```json
{
  "languageMode": "manual",
  "manualLanguage": "es",
  "defaultCurrency": "EUR",
  "notifications": {
    "comments": true,
    "reservations": false,
    "subscriptions": true,
    "marketing": false
  },
  "privacy": {
    "profileVisibility": "ALL",
    "subscribePolicy": "NOBODY",
    "commentsEnabled": true,
    "hintsEnabled": false
  },
  "appBehavior": {
    "newWishlistPosition": "top",
    "cardDisplayMode": "showcase"
  }
}
```

**Accepted enum values:**

| Field | Values |
|---|---|
| `languageMode` | `"auto"` \| `"manual"` |
| `manualLanguage` | `"ru"` \| `"en"` \| `"zh-CN"` \| `"hi"` \| `"es"` \| `"ar"` \| `null` |
| `defaultCurrency` | `"RUB"` \| `"USD"` \| `"EUR"` \| `"GBP"` |
| `notifications.comments` | `boolean` |
| `notifications.reservations` | `boolean` |
| `notifications.subscriptions` | `boolean` |
| `notifications.marketing` | `boolean` |
| `privacy.profileVisibility` | `"ALL"` \| `"LINK_ONLY"` \| `"SUBSCRIBERS"` \| `"NOBODY"` |
| `privacy.subscribePolicy` | `"ALL"` \| `"LINK_ONLY"` \| `"APPROVED"` \| `"NOBODY"` |
| `privacy.commentsEnabled` | `boolean` |
| `privacy.hintsEnabled` | `boolean` |
| `appBehavior.newWishlistPosition` | `"top"` \| `"bottom"` |
| `appBehavior.cardDisplayMode` | `"auto"` \| `"showcase"` \| `"compact"` |

**Response:** Updated settings object (HTTP 200).

**PRO gating:**
- PRO-only fields sent by FREE users are silently ignored (no error): `notifications.comments`, `notifications.subscriptions`, `privacy.commentsEnabled`, `appBehavior.newWishlistPosition=bottom`, `appBehavior.cardDisplayMode`.
- Available to all users: `defaultCurrency`, `hintsEnabled`, `notifications.reservations`, `notifications.marketing`, `languageMode`, `manualLanguage`.

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
