# Feature inventory — WishBoard Mini App

Source-of-truth map of every user-facing surface, state, and feature. This
is the reference every design artifact (mockups, North Star, canonical
promotion) must check itself against before being accepted as covering "the
product."

Generated 2026-04-17 from audit of `apps/web/app/miniapp/MiniApp.tsx` (29 764
lines) + release notes + i18n keys. Date-stamped because feature count
grows.

> **Why this exists:** the first North Star DRAFT scoped to ~5 % of the
> product. Without this inventory, mockups keep being made against an
> imagined product, not the real one.

---

## Top-level count

| Dimension | Count |
|-----------|-------|
| Distinct screens (`Screen` enum) | ~48 |
| Home tabs | 3 (`wishlists`, `wishes`, `reservations`) |
| Item statuses | 5 core × 8 derived modifiers |
| Upsell contexts | 15 |
| PRO features sold | 19 |
| Monetization SKUs | 10+ (subscription + Stars unlocks) |
| Locales supported | 6 (ru, en, zh-CN, hi, es, ar) |
| Onboarding variants | 2 families (v1_default, v2_try) × ~6 sub-screens each |

---

## Navigation model

### Home tabs (`HomeTab` at MiniApp.tsx:387)

```ts
type HomeTab = 'wishlists' | 'wishes' | 'reservations';
```

- **Wishlists** — owner's own wishlists + subscribed-to wishlists.
- **Wishes** — flat cross-wishlist list of all wishes; filters, sort,
  bulk-select.
- **Reservations** — items reserved by this user as a gift-giver. Primary
  surface for reservation-PRO features (TTL, note, purchase status,
  history).

### Top-level screens (selected, see MiniApp.tsx:623 for `Screen` enum)

**Owner-side:** `my-wishlists`, `wishlist-detail`, `item-detail`, `drafts`,
`archive`, `my-reservations`, `secret-reservation-detail`, `profile`,
`showcase-editor`, `showcase-preview`, `settings`, `faq`, `changelog`,
`legal`, `legal-doc`, `referral`, `referral-history`, `link-management`,
`first-share-prompt`.

**Guest-side (share-link traffic):** `guest-view`, `guest-item-detail`,
`guest-link-expired`, `item-unavailable`, `curated-view`.

**Public profile:** `public-profile`.

**Onboarding family:** `onboarding-entry`, `onboarding-demo`,
`onboarding-try`, `onboarding-success`, `onboarding-recovery`,
`onboarding-manual`, `onboarding-catalog`, `onboarding-create-wishlist`,
`onboarding-share`, `onboarding-complete`.

**Gift notes / calendar:** `gift-notes`, `gift-notes-occasion`,
`gift-notes-paywall`, `gift-notes-onboarding`.

**Group gifts:** `group-gift-create`, `group-gift-detail`,
`group-gift-join`, `group-gift-chat`, `group-gift-paywall`.

**Secret Santa:** `santa-hub`, `santa-create`, `santa-campaign`,
`santa-join`, `santa-chat`, `santa-polls`, `santa-exclusions`,
`santa-organizer`, `santa-receiver-wishlist`.

**Paywall / upgrade:** `secret-reservation-paywall` (+ UpsellSheet, not a
full screen).

**System:** `loading`, `error`, `maintenance`, `share`.

Paywall surfaces are MOSTLY bottom-sheet–based (UpsellSheet), not separate
screens.

---

## Item / wish states

### Status enum (MiniApp.tsx:271)

```
available | reserved | purchased | completed | deleted
```

### State modifiers stacked on top of status

| Modifier | Meaning | Visual today |
|----------|---------|--------------|
| **Priority 1 / 2 / 3** | Low / Medium / High (🙂/😊/😍) | Emoji + accent color (blue / amber / coral) |
| **Smart reservation (TTL)** | Reservation auto-expires after 24h/48h/72h/7d | Countdown chip; progress bar; auto-release |
| **Group gift** | Reserved by a pool of givers | Organizer/participant role badge |
| **Secret reservation (PRO)** | Guest reserved, owner doesn't know | Only visible to reserver; derived state machine |
| **Shared wish (multi-placement)** | Same wish in ≥2 wishlists | "🔗 in N wishlists" chip |
| **Santa** | Reservation inside Santa campaign | Anonymous alias (animal emoji + adjective) |

### Secret reservation derived states (MiniApp.tsx:368)

```
ACTIVE                     — safe, no conflicts
ITEM_UPDATED              — owner edited the item (diff available)
PUBLIC_RESERVED_BY_OTHER  — someone publicly reserved; promote option
ITEM_FULFILLED            — owner marked purchased
ITEM_UNAVAILABLE          — owner deleted / marked unavailable
```

### Owner vs guest rendering of the same wish

Owner and guest see DIFFERENT card contents for the same item:
- Owner sees reservation status (if public) + comments + edit actions.
- Guest sees Reserve / Secret-Reserve / note CTA, hides reserver-identity
  unless public, and sees Don't-Gift preferences.

---

## PRO features sold (from `plan_pro_f1–f19` + release notes)

### Released / general bundle (plan_pro_f1–f9)

1. **Extra wishlists** beyond the free 2-slot cap
2. **Extra items per wishlist** beyond the free 20-item cap
3. **Group gifts** — pool money with other gifters
4. **Comments** + threaded replies
5. **URL import** — bulk / smart-parsed item import from URLs
6. **Gift hints** — guests can leave hints for others
7. **Wishlist subscriptions** — follow others' wishlists
8. **Archive management** — bulk restore / purge
9. **Gift calendar & notes** — occasions + reminders + notes

### Recent / new (plan_pro_f18, f19, f15, f16, marked `isNew`)

10. ✨ **Gift showcase profile** — PRO-only public profile / `@username`
11. 🔒 **Secret reservation** — reserve without the owner knowing
12. 📋 **Curated selection share** — share a subset of a wishlist as a
    mini-shareable card
13. 🚫 **Don't-gift preferences** — preset categories + custom list of
    things user does NOT want

### Reservation section (plan_pro_f10–f14, f17, `resSection`)

14. ⏱ **Smart reservations / TTL** — 24h / 48h / 72h / 7d auto-expiry
15. 📋 **Reservation history** — completed / unreserved / archived
16. 📝 **Reservation notes** — private note per reservation
17. 🔔 **Reservation reminders** — bot notifications before TTL expiry
18. ✓ **Reservation purchase tracking** — mark purchased / completed
19. 🔍 **Reservation filters & sort** — not-purchased / with-comments /
    purchased; sort by expiry / name / date

---

## Upsell contexts (`UpsellContext`, MiniApp.tsx:238)

15 distinct upsell-trigger surfaces:

```
comments               — unlock comment threading
url_import             — bulk URL import
hints                  — gift hints
wishlist_limit         — hit free cap on # of wishlists
item_limit             — hit free cap on items per wishlist
participant_limit      — hit cap on group-gift participants
subscription_limit     — hit cap on # of wishlist/profile subscriptions
sort_recommended       — recommended-sort feature
reservation_pro        — TTL + history + filters + notes
categories             — per-wishlist category organization
dont_gift              — don't-gift preferences
dont_gift_banner       — don't-gift banner variant
curated_selection      — share curated subset
smart_reservations     — TTL add-on (unlockable separately via Stars)
bot_import             — bot-based item import
showcase               — gift showcase profile
```

Each has its own trigger point — "first item added" bumps a banner,
"subscription limit hit" opens the sheet, etc.

---

## Monetization SKUs

Two tracks:

**Subscription (Stars monthly / annual):**
- Full PRO bundle, auto-renews.

**One-time Stars unlocks (permanent per-user or per-wishlist):**
- `extra_wishlist_slot` — +1 wishlist (account-capped)
- `extra_items_5` / `extra_items_15` — per-wishlist extras
- `extra_subscription_slot` — +1 follow
- `gift_notes_unlock` — calendar feature (~50 ⭐)
- `reservation_pro_unlock` — reservation-PRO features (~50 ⭐)
- `secret_reservation_unlock` — secret res. feature
- `smart_reservations_unlock` — TTL (~15 ⭐)

Plus caps: `globalCappedSkus` (account-scope) vs `wishlistCappedSkus[wlId]`
(per-wishlist-scope).

**Credits:**
- `hintCredits` — how many hints the user can leave
- `importCredits` — how many URL-imports left

---

## Social / sharing surfaces

- **Wishlist subscriptions** (follow someone's public wishlist)
- **Profile subscriptions** (follow someone's PRO showcase — separate from
  wishlist subs)
- **Share tokens** — wishlist-level, selection-level, profile-level
- **Curated selection** — share a subset of items with its own TTL'd link
- **Group gifts** — organizer + participants + in-group chat
- **Secret Santa campaigns** — separate sub-product: participants, rounds,
  aliases (animal emoji), polls, chat, exclusions, receiver wishlists
- **Comments** — policy per wishlist (all / subscribers-only), threaded,
  unread tracking per item / per wishlist
- **Don't-gift preferences** — per-wishlist or per-profile, with preset
  categories (🍬 sweets, 💐 flowers, 🧴 perfume, 💄 cosmetics, 💍 jewelry,
  👔 clothes, 👟 shoes, 🏺 souvenirs, 🧸 soft_toys, 🍷 alcohol, 🎫 gift_cards,
  📱 tech, 🕯 candles, 🍕 food) + custom items + comment
- **Referral program** — invite → both get PRO days

---

## Reservation-side (gift-giver) features

- **Reserve** (public) — visible to owner
- **Secret reserve** (PRO) — invisible to owner
- **Reserve for group gift** — pool with others
- **Reserve with note** (PRO) — private giver-side note
- **Extend reservation** (if TTL, up to `maxExtensions` times)
- **Mark as purchased** — checkbox; moves to history tab when completed
- **Promote secret → public** — convert from secret to public reservation
- **Unreserve** — release
- **Reservation history** (PRO) — past reservations + end reason
- **Reservation filters / sort** (PRO)
- **Reminder** — bot notifies X hours before TTL expiry

---

## Notable sheets / modals (sampling, not exhaustive)

- **UpsellSheet** — per-context paywall surface
- **BottomSheet** wrapper (MiniApp.tsx:2023) — the iOS-native gesture-aware
  sheet used for: item detail preview, comment composer, category picker,
  wishlist picker, smart-reservation TTL picker, don't-gift editor, group-
  gift chat + participants, curated-selection picker, link-management
  detail, etc.
- **Image lightbox** — full-screen image viewer
- **Delete / archive confirmations** — 2-step for destructive purge
- **Onboarding splashes** — multiple full-viewport modals
- **Secret-reservation detail** — full-page with snapshot + diff
- **Showcase editor** — full-page cover / bio / preferences

---

## Locales

`ru | en | zh-CN | hi | es | ar` — all features parity. Arabic triggers
RTL layout path. Onboarding catalog varies by market segment
(`getCatalogForSegment`).

---

## How to use this file

- **Before designing a mockup** — open this file, make sure the target
  screen actually matches a real surface in the product.
- **Before promoting a primitive to canonical** — make sure it covers the
  real states, not just the happy path (e.g. wish-item card must handle
  ALL status × priority × modifier combinations, not just `available`).
- **Before writing a spec** — cross-reference against this inventory so
  you don't invent features that don't exist or miss features that do.

Feature growth is fast. If this file is >2 months old, rerun the audit.
