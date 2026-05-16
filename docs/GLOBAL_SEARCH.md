# Global Search — feature reference

WishBoard Mini App ships a global search screen behind the 🔍 button on
the home header. This doc is a short product + security reference. Visual
spec lives in
[`docs/design-system/mockups/proposed/global-search.html`](./design-system/mockups/proposed/global-search.html).
Code: [`apps/web/app/miniapp/screens/SearchScreen.tsx`](../apps/web/app/miniapp/screens/SearchScreen.tsx)
(frontend), [`apps/api/src/services/search.ts`](../apps/api/src/services/search.ts) (backend),
[`apps/api/src/routes/search.routes.ts`](../apps/api/src/routes/search.routes.ts) (route).

## What it searches

Within **the requesting user's accessible scope only**:

- **Items / wishes** — title, description, URL, price text (own + foreign).
- **Wishlists** — title, description, owner displayName.
- **Categories** — name (skips the default category).
- **People** — `accessiblePeopleIds` only: owners of foreign wishlists in
  scope + followed `ProfileSubscription` targets + Secret Santa peers.
- **Reservations** *(PRO)* — own `ReservationMeta` (active) + own public
  `Item.reserverUserId` + own `SecretReservation` (ACTIVE).
- **Events** *(PRO)* — `GiftOccasion` rows the requesting user owns.
- **Anti-gift / Don't Gift** *(PRO)* — only **the requesting user's own**
  anti-gift entries from `UserProfile.dontGiftPresets / dontGiftCustomItems /
  dontGiftComment`. Other people's anti-gift lists are NEVER surfaced via
  search even when the user could otherwise see them on a wishlist page.
- **Settings / FAQ / actions** — a static catalogue of ~14 in-app screens
  (Profile, Notifications, PRO, Privacy, Calendar, Don't Gift, FAQ, Legal,
  Changelog, Create wishlist, Import by link, …). Matched against title +
  per-row cross-locale keyword bag.

## What it does NOT search

- All users in the app — there is no global people directory. Search only
  reaches users with whom the requester has an explicit connection
  (`accessiblePeopleIds`).
- All public wishlists — discovery / browse-public is a separate product
  surface and is not part of this feature.
- Private wishlists owned by anyone else — `WishlistVisibility=PRIVATE`
  is hard-rejected at scope build time and at every per-result live check.
- Soft-deleted / archived content by default — `Item.status IN ('DELETED',
  'ARCHIVED')` is excluded. The smart filter "Архив" can opt back into
  archive results for **own** archived wishes.
- Owners' private notes, gift-giver comments, or anything the existing
  per-screen role check would hide.
- Tracked reservations / events / anti-gift for Free users — only an
  aggregate `pro_locked` block, never titles or owners.

## Free vs PRO

Base search (Free):
- Own wishes, wishlists, categories, settings, FAQ, actions, people,
  accessible foreign wishlists, wishes inside accessible foreign wishlists.

PRO unlocks:
- Reservations (own public + own smart-reservation TTL + own secret
  reservations).
- Calendar events (own `GiftOccasion`).
- Anti-gift (own list).
- Smart filters for reservations (Expiring soon, Secret, Regular, Mine).

Free → PRO transition surfaces as a single `pro_locked` group with an
aggregate count. No titles, owners, or IDs of PRO-only matches leak.

## Privacy guarantees

- **Secret reservations** — surface only to `SecretReservation.reserverUserId`.
  Owners and third parties never see secret-reservation rows, counts, or
  hints in any group.
- **Raw query is never logged.** The route's `search.query_completed`
  analytics event carries `queryLength` and a SHA-1 prefix hash (12 hex
  chars) of the normalized query. The hash is one-way — useful for
  god-mode debugging clusters without exposing user input.
- **PRO-locked block carries no leaked content.** The pro_locked row's
  title and subtitle are static localized strings; entityId is null.
- **Restricted results render as generic "no longer available"** without
  title / owner / photo / items. The frontend toasts on click.

## ForeignWishlistAccess — what it is

`ForeignWishlistAccess` is **access history**, not a permission grant. One
row per `(userId, wishlistId)` the user has successfully opened that they
do not own. Fields:

- `source` — origin tag (`share_link / curated_selection / subscription /
  reservation / profile / santa / direct_open / unknown`).
- `sourceRef` — opaque credential pin. SHA-256 of `shareToken` for
  `share_link`; `CuratedSelection.id` for `curated_selection`; null
  otherwise (relation-grounded sources are validated against the live
  relation table, not via this ref).

Live access is **always re-validated at search time and at click time**:

1. Wishlist must exist, not be archived, not be `SYSTEM_DRAFTS`, not be
   `PRIVATE`.
2. For `LINK_ONLY` wishlists, EITHER the user has a current relation
   (subscription, reservation, secret reservation, curated subscription,
   santa, profile follow) OR the FWA pin still matches:
   - `share_link` → SHA-256(`Wishlist.shareToken`) must equal stored
     `sourceRef`. Owner regenerating the share token revokes search
     visibility.
   - `curated_selection` → the `CuratedSelection` must still exist, not
     be deactivated, and not be expired.
   - `direct_open` / `unknown` for LINK_ONLY → rejected (we can't prove
     the user still has the link).
3. For `PUBLIC_PROFILE` wishlists, any FWA row + non-archived wishlist
   suffices.

Recorded centrally via
[`services/foreign-wishlist-access.ts`](../apps/api/src/services/foreign-wishlist-access.ts).
Helper validates the live state of the wishlist BEFORE writing the row —
never records for own / archived / private / drafts / revoked LINK_ONLY.

The frontend calls `POST /tg/access/wishlist-opened` after each successful
foreign-wishlist open. Auth-required (parent tgRouter middleware), server
takes userId from `req.tgUser` (NEVER from body), rate-limited via the
`access.record` category.

## Endpoints

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET  | `/tg/search` | Telegram initData | Read-only. Rate-limit `search` (30/min). |
| POST | `/tg/access/wishlist-opened` | Telegram initData | Fire-and-forget FWA recorder. Rate-limit `access.record` (60/5min). |
| GET  | `/tg/wishlists/:id/access-view` | Telegram initData | Strict access-checked foreign-wishlist read. Used by search-result-click for wishlists the user can prove access to but isn't currently subscribed to. |

## Why we chose localStorage for recent searches

- **Privacy.** Search queries can include names, item titles, anti-gift
  text. Storing them server-side widens the attack surface for limited
  product value.
- **Plan-aware caps.** Free=3, PRO=10. The cap is computed at the FE
  using the live `planInfo` state — no roundtrip on every keystroke.
- **No cross-device sync.** Conscious decision; can be revisited if a
  user request lands.

## Analytics events

All in [`packages/shared/src/analyticsEvents.ts`](../packages/shared/src/analyticsEvents.ts).
None carry the raw query.

`search.opened`, `search.query_started`, `search.query_completed`,
`search.query_failed`, `search.result_clicked`, `search.filter_changed`,
`search.empty_shown`, `search.recent_clicked`, `search.suggestion_clicked`,
`search.paywall_shown`, `search.paywall_cta_clicked`,
`search.clear_clicked`, `search.closed`, `search.access_recorded`.

Allowed props (see `apps/api/src/routes/search.routes.ts`): `queryLength`,
`normalizedQueryHash` (12-char SHA-1 prefix), `resultCount`, `resultTypes`,
`selectedType`, `selectedResultType`, `latencyMs`, `hasProResults`,
`isProUser`, `locale`, `partial`, `failedGroups`, `accessState`.
