# FRONTEND_API_MAP.md — Frontend-to-API Call Map

> **Status: SECONDARY REFERENCE.** Primary sources: [FRONTEND_MAP.md](./FRONTEND_MAP.md) (screens/state) and [API_REFERENCE.md](./API_REFERENCE.md) (endpoints).
> This document maps which UI action calls which API endpoint per screen. Useful for call-level debugging.
> All data `VERIFIED_FROM_CODE` (source: MiniApp.tsx, WishlistClient.tsx, admin-api-client.ts, api-proxy.ts).
> Last verified: 2026-04-02 / Branch: `main`.

---

## Overview

| Source | File | API call count |
|--------|------|---------------|
| Mini App (Telegram) | `apps/web/app/miniapp/MiniApp.tsx` | 100+ |
| Public Wishlist | `apps/web/app/w/[slug]/` | 3 |
| Admin Panel | `apps/web/app/admin/` + `lib/admin-api-client.ts` | 11 |
| Middleware | `apps/web/middleware.ts` | 0 (auth only) |

**Total: ~115+ unique API interactions** across core wishlists, onboarding, Secret Santa, Gift Notes, billing, promo, profile, and God Mode subsystems.

---

## 1. Mini App -- My Wishlists (`my-wishlists`)

### On load

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| 1 | `/tg/wishlists` | GET | Component mount | -- | `wishlists`, `planLimits`, `reservationsCount` |
| 1b | `/tg/reservations` | GET | Lazy-load after wishlists | -- | `reservations`, `reservationsLoading` |
| 1c | `/tg/santa/my-reservations` | GET | Lazy-load (parallel with reservations) | -- | Santa reservation data |
| 1d | `/tg/items` | GET | Wishes tab selected | -- | All items flat list |
| 1e | `/tg/onboarding/status` | GET | Mount (new users) | -- | `onboardingStatus` |
| 1f | `/tg/santa/season` | GET | Mount | -- | Santa season status |
| 1g | `/tg/me/subscriptions/meta` | GET | Mount / tab switch | -- | Subscription metadata |

### User actions

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| 2 | `/tg/wishlists` | POST | "Create wishlist" button | `{ title, deadline? }` | `wishlists`, `currentWl`, `items`, `screen` |
| 2b | `/tg/wishlists/reorder` | POST | Drag-to-reorder wishlists | `{ orderedIds }` | `wishlists` |

**Errors:**
- `402` -- Wishlist limit exceeded (FREE: 2). Toast: limit reached

---

## 2. Mini App -- Wishlist Detail (`wishlist-detail`)

### On load

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| 3 | `/tg/wishlists/{id}/items` | GET | Screen transition | -- | `items` |

### User actions

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| 4 | `/tg/wishlists/{id}` | PATCH | Save new title / deadline / visibility | `{ title?, deadline?, visibility? }` | `currentWl`, `wishlists` |
| 5 | `/tg/wishlists/{id}/items` | POST | Create item | `{ title, description?, url?, price?, priority?, imageUrl? }` | `items`, `wishlists` |
| 6 | `/tg/items/{id}` | PATCH | Edit item | `{ title?, description?, url?, price?, priority? }` | `items` (+ reload) |
| 7 | `/tg/items/{id}` | DELETE | Delete item | -- | `items`, `wishlists` |
| 8 | `/tg/items/{id}/photo` | POST | Upload photo | FormData: `photo` (file) | `itemImageUrl` |
| 9 | `/tg/items/{id}/photo` | DELETE | Remove photo | -- | `items` |
| 10 | `/tg/wishlists/{id}/share-token` | POST | "Share" button | -- | `shareToken` |
| 11 | `/tg/wishlists/{id}/archive` | GET | "Archive" button | -- | `archiveItems`, `screen` |
| 11b | `/tg/wishlists/{id}/items/reorder` | POST | Drag-to-reorder items | `{ orderedIds }` | `items` |
| 11c | `/tg/wishlists/{id}/archive` | POST | Archive entire wishlist | -- | `wishlists` |
| 11d | `/tg/wishlists/{id}` | DELETE | Delete wishlist | -- | `wishlists` |
| 11e | `/tg/wishlists/{id}/transfer-items` | POST | Transfer items to another wishlist | `{ targetWishlistId }` | `wishlists`, `items` |

**Errors:**
- `402` on POST items -- Item limit exceeded (FREE: 20, PRO: 70)
- Photo > 30MB -- nginx rejects (413)

---

## 3. Mini App -- Item Detail (`item-detail`, owner)

### On load

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| 12 | `/tg/items/{id}/comments` | GET | Screen transition | -- | `comments`, `commentRole` |

### User actions

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| 13 | `/tg/items/{id}` | PATCH | Save description | `{ description }` | `viewingItem`, `items` |
| 14 | `/tg/items/{id}/comments` | POST | Send comment | `{ text }` | `comments`, `commentText` |
| 15 | `/tg/items/{id}/comments/{cid}` | DELETE | Delete comment | -- | `comments` |
| 16 | `/tg/items/{id}/complete` | POST | "Received" button | -- | `items`, `wishlists`, `archiveItems` |
| 16b | `/tg/items/{id}/hint` | POST | Hint button (PRO) | -- | Toast confirmation |
| 16c | `/tg/items/{id}/move` | POST | Move to another wishlist | `{ targetWishlistId }` | `items`, `wishlists` |
| 16d | `/tg/items/{id}/copy` | POST | Copy item to another wishlist | `{ targetWishlistId }` | Toast confirmation |

**Comment logic:**
- `403` on GET comments -- No reserver (comments unavailable)
- `commentRole` determines UI: owner sees reserver name, reserver sees "Author"

---

## 4. Mini App -- Archive (`archive`)

### User actions

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| 17 | `/tg/items/{id}/restore` | POST | "Restore" button | -- | `archiveItems`, `items`, `wishlists` |
| 17b | `/tg/archive` | GET | Global archive view | -- | `archiveItems` |
| 17c | `/tg/items/bulk-restore` | POST | Bulk restore | `{ itemIds }` | `archiveItems`, `items` |
| 17d | `/tg/items/bulk-hard-delete` | POST | Bulk permanent delete | `{ itemIds }` | `archiveItems` |
| 17e | `/tg/archive/purge` | POST | Purge all archived items | -- | `archiveItems` |

---

## 5. Mini App -- My Reservations (`my-reservations`)

### On load

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| 22 | `/tg/reservations` | GET | Screen transition (if not loaded) | -- | `reservations`, `reservationsLoading` |

### User actions

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| 23 | `/tg/items/{id}/unreserve` | POST | "Cancel reservation" on ReservationCard | `{}` | `reservations`, `reservationsCount` |
| 24 | `/tg/items/{id}/comments/mark-read` | POST | Navigate to item detail from reservations | -- | CommentReadCursor (server-side) |

**Logic:**
- Items grouped by `ownerId` / `ownerName`
- `unreadComments` shown as badge on ReservationCard
- Sets `fromReservations` flag and calls mark-read on view
- NOT a Pro-only feature -- available to all users

---

## 6. Mini App -- Guest View (`guest-view`)

### On load

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| 18 | `/public/share/{token}` | GET | Deep link `share_XXX` | -- | `guestWl`, `guestItems` |
| 18b | `/public/wishlists/{slug}` | GET | Fallback if share not found | -- | `guestWl`, `guestItems` |

**Logic:**
1. Parses `startapp` parameter from Telegram WebApp
2. If starts with `share_` -- calls `/public/share/{token}`
3. On error -- fallback to `/public/wishlists/{param}`
4. If `guestWl.ownerId === currentUser.id` -- switches to owner view

---

## 7. Mini App -- Guest Item Detail (`guest-item-detail`)

### On load

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| 19 | `/tg/items/{id}/comments` | GET | Screen transition | -- | `comments`, `commentRole` |

### User actions

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| 20 | `/tg/items/{id}/reserve` | POST | "Reserve" button | `{ displayName }` | `guestItems`, `viewingItem` |
| 21 | `/tg/items/{id}/unreserve` | POST | "Cancel reservation" | `{}` | `guestItems`, `viewingItem` |
| 14 | `/tg/items/{id}/comments` | POST | Send comment | `{ text }` | `comments` |
| 15 | `/tg/items/{id}/comments/{cid}` | DELETE | Delete comment | -- | `comments` |

**Reservation statuses (determine UI):**
- `AVAILABLE` -- "Reserve" button
- `RESERVED` + my `actorHash` -- badge + "Cancel reservation"
- `RESERVED` + someone else -- "Reserved by someone" badge
- `PURCHASED` -- "Purchased" badge

**Errors:**
- `409` on reserve -- Already reserved (race condition)

---

## 8. Mini App -- Drafts (`drafts`)

### On load

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| D1 | `/tg/wishlists/{draftsWishlistId}/items` | GET | Screen transition | -- | `draftsItems` |

### User actions

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| D2 | `/tg/items/{id}/move` | POST | Move item to real wishlist | `{ targetWishlistId }` | `draftsItems`, `items` |
| D3 | `/tg/items/bulk-move` | POST | Bulk move items | `{ itemIds, targetWishlistId }` | `draftsItems` |
| D4 | `/tg/items/bulk-delete` | POST | Bulk delete items | `{ itemIds }` | `draftsItems` |
| D5 | `/tg/items/bulk-archive` | POST | Bulk archive items | `{ itemIds }` | `draftsItems` |
| D6 | `/tg/import-url` | POST | URL import | `{ url }` | `draftsItems` |

---

## 9. Mini App -- Onboarding v2 (9 screens)

Server-side onboarding state tracked via `/tg/onboarding/*` endpoints.

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| OB1 | `/tg/onboarding/status` | GET | Mount / status check | -- | `onboardingStatus` |
| OB2 | `/tg/onboarding/start` | POST | Begin onboarding | -- | `onboardingStatus` |
| OB3 | `/tg/onboarding/dismiss` | POST | Dismiss onboarding | -- | Exits onboarding flow |
| OB4 | `/tg/onboarding/complete` | POST | Complete onboarding | -- | `onboardingStatus` |
| OB5 | `/tg/onboarding/try-import` | POST | Try URL import during onboarding | `{ url }` | Import result |
| OB6 | `/tg/onboarding/catalog-select` | POST | Select catalog items | `{ items }` | Catalog selection |
| OB7 | `/tg/onboarding/update-step` | POST | Track current step | `{ step }` | Server-side step tracking |
| OB8 | `/tg/onboarding/create-wishlist` | POST | Create first wishlist in onboarding | `{ title, itemIds }` | `wishlists`, screen transition |

---

## 10. Mini App -- Profile & Settings

### Profile (`profile`)

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| P1 | `/tg/me/profile` | GET | Screen transition | -- | `profileData` |
| P2 | `/tg/me/profile` | PATCH | Save profile changes | `{ displayName?, username?, bio?, birthday?, avatarUrl? }` | `profileData` |
| P3 | `/tg/me/account` | DELETE | Delete account | -- | Clears all state, error screen |

### Settings (`settings`)

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| S1 | `/tg/me/settings` | GET | Screen transition | -- | `settingsData` |
| S2 | `/tg/me/settings` | PATCH | Save settings | `{ key: value }` | `settingsData` |
| S3 | `/tg/me/subscriptions` | GET | Load subscriptions list | -- | `subscriptions` |
| S4 | `/tg/me/subscriptions/{id}/read` | POST | Mark subscription as read | -- | `subscriptions` |
| S5 | `/tg/me/god-mode` | POST | Enable God Mode | -- | `godMode` |
| S6 | `/tg/me/god-stats` | GET | Load God Mode stats | Query: `?period=` | `godStats` |
| S7 | `/tg/me/retention-stats` | GET | Load retention stats | Query: `?period=` | `retentionStats` |

### Subscriptions

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| SB1 | `/tg/wishlists/{id}/subscribe` | GET | Check subscription status | -- | Subscription state |
| SB2 | `/tg/wishlists/{id}/subscribe` | POST | Subscribe to wishlist | -- | `subscriptions` |
| SB3 | `/tg/wishlists/{id}/subscribe` | DELETE | Unsubscribe | -- | `subscriptions` |

---

## 11. Mini App -- Billing

### PRO Subscription

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| B1 | `/tg/billing/pro/checkout` | POST | "Upgrade to PRO" CTA | -- | Opens Telegram Stars invoice |
| B2 | `/tg/billing/pro/sync` | POST | Post-payment sync (polled) | -- | `planLimits`, plan status |
| B3 | `/tg/billing/subscription/cancel` | POST | Cancel subscription | -- | Subscription status |
| B4 | `/tg/billing/subscription/reactivate` | POST | Reactivate subscription | -- | Subscription status |

### Add-ons

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| B5 | `/tg/billing/addon/checkout` | POST | Purchase add-on from upsell sheet | `{ sku }` | Opens Telegram Stars invoice |
| B6 | `/tg/billing/addon/sync` | POST | Post-payment add-on sync | -- | Add-on status |

### Gift Notes

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| B7 | `/tg/billing/gift-notes/checkout` | POST | Purchase Gift Notes add-on | -- | Opens Telegram Stars invoice |
| B8 | `/tg/billing/gift-notes/sync` | POST | Post-payment sync | -- | Gift Notes unlock status |

---

## 12. Mini App -- Promo

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| PR1 | `/tg/promo/apply` | POST | Enter promo code | `{ code }` | Plan upgrade / add-on unlock |

---

## 13. Mini App -- Gift Notes (3 screens)

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| GN1 | `/tg/gift-occasions` | GET | `gift-notes` screen load | -- | `gnOccasions` |
| GN2 | `/tg/gift-occasions` | POST | Create occasion | `{ title, eventDate?, type, recurrence, personName? }` | `gnOccasions` |
| GN3 | `/tg/gift-occasions/{id}` | GET | `gift-notes-occasion` screen load | -- | `gnViewingOccasion` |
| GN4 | `/tg/gift-occasions/{id}` | PATCH | Edit occasion | `{ title?, personName?, note? }` | `gnViewingOccasion` |
| GN5 | `/tg/gift-occasions/{id}` | DELETE | Delete occasion | -- | `gnOccasions` |
| GN6 | `/tg/gift-occasions/{id}/complete` | POST | Complete occasion | -- | `gnOccasions` |
| GN7 | `/tg/gift-occasions/{id}/archive` | POST | Archive occasion | -- | `gnOccasions` |
| GN8 | `/tg/gift-occasions/{id}/ideas` | POST | Add gift idea | `{ text, link? }` | `gnViewingOccasion` |
| GN9 | `/tg/gift-occasion-ideas/{id}/complete` | POST | Mark idea as done | -- | `gnViewingOccasion` |
| GN10 | `/tg/gift-occasion-ideas/{id}` | DELETE | Delete idea | -- | `gnViewingOccasion` |

---

## 14. Mini App -- Secret Santa (9 screens)

### Campaign Management

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| SC1 | `/tg/santa/campaigns` | GET | `santa-hub` screen load | -- | `santaCampaigns` |
| SC2 | `/tg/santa/campaigns` | POST | Create campaign | `{ title, budget?, deadline? }` | `santaCampaigns`, `currentSantaCampaign` |
| SC3 | `/tg/santa/campaigns/{id}` | GET | `santa-campaign` screen load | -- | `currentSantaCampaign` |
| SC4 | `/tg/santa/campaigns/{id}/open` | POST | Open campaign for joining | -- | `currentSantaCampaign` |
| SC5 | `/tg/santa/campaigns/{id}/lock` | POST | Lock campaign (no more joins) | -- | `currentSantaCampaign` |
| SC6 | `/tg/santa/campaigns/{id}/cancel` | POST | Cancel campaign | -- | `currentSantaCampaign` |
| SC7 | `/tg/santa/campaigns/{id}/complete` | POST | Complete campaign | -- | `currentSantaCampaign` |
| SC8 | `/tg/santa/campaigns/{id}/rounds` | POST | Start new round | -- | `currentSantaCampaign` |

### Draw & Matching

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| SD1 | `/tg/santa/campaigns/{id}/draw/validate` | GET | Pre-draw validation | -- | Validation result |
| SD2 | `/tg/santa/campaigns/{id}/draw` | POST | Execute draw | -- | `currentSantaCampaign` |
| SD3 | `/tg/santa/campaigns/{id}/reveal` | GET | Reveal matched person | -- | Reveal data |

### Participants

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| SP1 | `/tg/santa/invite/{token}` | GET | Deep link `santa_` | -- | Join preview |
| SP2 | `/tg/santa/campaigns/{id}/join` | POST | Join campaign | -- | `currentSantaCampaign` |
| SP3 | `/tg/santa/campaigns/{id}/leave` | POST | Leave campaign | -- | Navigation to hub |
| SP4 | `/tg/santa/campaigns/{id}/participants/{userId}/role` | PATCH | Change participant role | `{ role }` | `currentSantaCampaign` |
| SP5 | `/tg/santa/campaigns/{id}/exit-request` | POST | Request to exit after draw | `{ reason? }` | `currentSantaCampaign` |
| SP6 | `/tg/santa/campaigns/{id}/exit-requests/{id}/approve` | POST | Approve exit request (organizer) | -- | Organizer summary |
| SP7 | `/tg/santa/campaigns/{id}/exit-requests/{id}/deny` | POST | Deny exit request (organizer) | -- | Organizer summary |

### Gift Tracking

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| SG1 | `/tg/santa/campaigns/{id}/gift-status` | PATCH | Update gift status | `{ status }` | `currentSantaCampaign` |
| SG2 | `/tg/santa/campaigns/{id}/confirm-received` | POST | Confirm gift received | -- | `currentSantaCampaign` |
| SG3 | `/tg/santa/campaigns/{id}/hints` | GET | Load hints | -- | Hints data |
| SG4 | `/tg/santa/campaigns/{id}/hints` | POST | Send hint to receiver | -- | Hint confirmation |
| SG5 | `/tg/santa/campaigns/{id}/inbound/hint` | GET | Load received hints | -- | Inbound hint data |
| SG6 | `/tg/santa/campaigns/{id}/inbound/hint/fulfill` | POST | Fulfill hint request | `{ response }` | Hint status |
| SG7 | `/tg/santa/campaigns/{id}/inbound/status` | GET | Load inbound gift status | -- | Inbound status |

### Receiver Wishlist

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| SR1 | `/tg/santa/campaigns/{id}/inbound/wishlist` | GET | Load receiver's wishlist | -- | Receiver wishlist items |
| SR2 | `/tg/santa/campaigns/{id}/inbound/reserve` | POST | Reserve receiver's item | `{ itemId }` | Reservation status |
| SR3 | `/tg/santa/campaigns/{id}/inbound/reserve/{itemId}` | DELETE | Unreserve receiver's item | -- | Reservation status |
| SR4 | `/tg/santa/campaigns/{id}/wishlist` | PATCH | Link own wishlist to campaign | `{ wishlistId }` | `currentSantaCampaign` |

### Chat

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| CH1 | `/tg/santa/campaigns/{id}/chat` | GET | `santa-chat` screen load | Query: `?limit=50&before=` | `santaChat` messages |
| CH2 | `/tg/santa/campaigns/{id}/chat` | POST | Send message | `{ body }` | `santaChat` messages |
| CH3 | `/tg/santa/campaigns/{id}/chat/read` | POST | Mark messages read | `{ lastReadMessageId }` | Read cursor |
| CH4 | `/tg/santa/campaigns/{id}/mute` | POST/DELETE | Toggle mute | -- | Mute status |

### Polls

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| PL1 | `/tg/santa/campaigns/{id}/polls` | GET | `santa-polls` screen load | -- | `santaPolls` |
| PL2 | `/tg/santa/campaigns/{id}/polls` | POST | Create poll | `{ question, options }` | `santaPolls` |
| PL3 | `/tg/santa/campaigns/{id}/polls/{pollId}/vote` | POST | Vote on poll | `{ optionIndex }` | Poll results |
| PL4 | `/tg/santa/campaigns/{id}/polls/{pollId}/close` | POST | Close poll | -- | Poll status |

### Exclusions

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| EX1 | `/tg/santa/campaigns/{id}/exclusions` | GET | `santa-exclusions` screen load | -- | `santaExcl` data |
| EX2 | `/tg/santa/campaigns/{id}/exclusions` | POST | Add exclusion pair | `{ excludedUserId }` | `santaExcl` data |
| EX3 | `/tg/santa/campaigns/{id}/exclusions/{id}` | DELETE | Remove exclusion | -- | `santaExcl` data |
| EX4 | `/tg/santa/campaigns/{id}/exclusions/groups` | POST | Create exclusion group | `{ name }` | `santaExcl` data |
| EX5 | `/tg/santa/campaigns/{id}/exclusions/groups/{gid}` | DELETE | Delete exclusion group | -- | `santaExcl` data |
| EX6 | `/tg/santa/campaigns/{id}/exclusions/groups/{gid}/members` | POST | Add member to group | `{ userId }` | `santaExcl` data |
| EX7 | `/tg/santa/campaigns/{id}/exclusions/groups/{gid}/members/{uid}` | DELETE | Remove member from group | -- | `santaExcl` data |

### Organizer

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| OR1 | `/tg/santa/campaigns/{id}/organizer/summary` | GET | `santa-organizer` screen load | -- | Organizer summary |

### Season / Test

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| SS1 | `/tg/santa/season` | GET | Mount | -- | Season status |
| SS2 | `/tg/santa/season/test-mode` | POST | God Mode: toggle test mode | -- | Test mode status |

---

## 15. Public Page `/w/:slug`

### On load (SSR)

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| 25 | `/public/wishlists/{slug}` | GET | SSR page load | -- | Server-side props |

### User actions (CSR)

| # | Endpoint | Method | Trigger | Request body | Updates state |
|---|----------|--------|---------|-------------|--------------|
| 26 | `/public/items/{id}/reserve` | POST | "Reserve" button | `{ actorHash, comment? }` | `data` (reload) |
| 27 | `/public/items/{id}/purchase` | POST | "Purchased" button | `{ actorHash, comment? }` | `data` (reload) |

**Auth:**
- `actorHash` generated from localStorage (not Telegram)
- No Telegram initData -- different identity system

---

## 16. Admin Panel

All calls go through Next.js API routes (`/api/admin/*`) -> proxy -> backend (`/admin/*`).
Auth: HTTP Basic Auth (web) + `X-ADMIN-KEY` header (api).

| # | Endpoint (proxy) | Method | Trigger | Request body |
|---|----------|--------|---------|-------------|
| 28 | `/api/admin/wishlists` | GET | Dashboard load | -- |
| 29 | `/api/admin/wishlists` | POST | Create wishlist | `{ title, description? }` |
| 30 | `/api/admin/wishlists/{id}` | GET | Open wishlist | -- |
| 31 | `/api/admin/wishlists/{id}` | PATCH | Edit | `{ title?, description? }` |
| 32 | `/api/admin/wishlists/{id}` | DELETE | Delete | -- |
| 33 | `/api/admin/wishlists/{id}/items` | GET | Load items | Query: `status?` |
| 34 | `/api/admin/wishlists/{id}/items` | POST | Create item | `{ title, url, priceText?, ... }` |
| 35 | `/api/admin/items/{id}` | PATCH | Edit item | `{ title?, url?, status?, ... }` |
| 36 | `/api/admin/items/{id}` | DELETE | Delete item | -- |

---

## Common Request Headers

### Mini App (Telegram)
```
X-TG-INIT-DATA: <Telegram WebApp initData string>
Content-Type: application/json
```

### Public endpoints
```
Content-Type: application/json
```
No auth. `actorHash` passed in request body.

### Admin (two-layer auth) `VERIFIED_FROM_CODE`
```
Layer 1 (browser -> Next.js): HTTP Basic Auth (ADMIN_BASIC_USER + ADMIN_BASIC_PASS)
Layer 2 (Next.js -> Express): X-ADMIN-KEY header (injected server-side by api-proxy.ts)

Browser calls: /api/admin/* (Next.js API routes)
Next.js proxies to: Express backend paths (without /api/admin prefix)
ADMIN_KEY NEVER reaches the browser.
```

### Photo upload
```
X-TG-INIT-DATA: <initData>
Content-Type: multipart/form-data
```

---

## Error Handling (common pattern)

```
All API calls in MiniApp are wrapped in try/catch:

try {
  const res = await tgFetch('/endpoint', { method, body });
  if (!res.ok) {
    if (res.status === 402) -> toast("Limit reached")
    if (res.status === 409) -> toast("Already reserved")
    throw new Error(...)
  }
  const data = await res.json();
  // update state
} catch (err) {
  toast("Error: " + err.message)
}
```

---

## Data Flow Diagram

```
+-----------------+     X-TG-INIT-DATA      +--------------+
|   MiniApp.tsx   | -----------------------> |  Express API |
|  (Telegram)     |     /tg/* endpoints      |  (port 3001) |
+-----------------+                          +------+-------+
                                                    |
+-----------------+     No auth                     |
|  /w/:slug page  | ----------------------->        |
|  (Public SSR)   |     /public/* endpoints         v
+-----------------+                          +--------------+
                                             |  PostgreSQL  |
+-----------------+     X-ADMIN-KEY          |  (port 5432) |
|  Admin Panel    | --> Next.js API -->      +--------------+
|  (Basic Auth)   |     /admin/* endpoints
+-----------------+
```
