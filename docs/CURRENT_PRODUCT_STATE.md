# Current Product State

Production feature inventory for the Wishlist Telegram Mini App.

**Last updated:** 2026-04-17

---

## Core Features

- **Wishlists** with public sharing via slug, item management, reservations
- **Wishlist Categories** — organize wishes into sections within a wishlist. Create/rename/delete categories, move items between them, drag to reorder. Collapsible sections for owner and guests
- **URL import/parsing** for adding items from external links
- **Comments** on wishlist items
- **Hints** for item gifting guidance
- **Gift Notes** (19 XTR one-time purchase)
- **Group Gift (Совместный подарок)** — pool money together for one gift. Organizer creates a collection (79 XTR one-time unlock), invites participants via deep link, tracks progress. Features: target amount, deadline, pinned payment info, participant chat, complete/cancel. Shows in "My Reservations" for both organizer and participants
- **Don't Gift (Не дарить)** — PRO feature. Profile-level gift restrictions. Users specify preset categories and custom items they don't want to receive. Visible to friends on guest view. Also available per-wishlist with three modes: global/custom/disabled
- **Secret Santa** campaigns
- **Support tickets** from within the app
- **Item Placements** — share a single wish across multiple wishlists via WishlistItemPlacement junction table

## Monetization

- **PRO subscription**: 100 XTR/month
- **14 add-on SKUs** (including Gift Notes at 19 XTR, reservation_pro_unlock at 50 XTR, group_gift_unlock at 79 XTR, secret_reservation_unlock at 24 XTR, smart_reservations_unlock at 39 XTR)

### Plan Limits

| Resource        | FREE | PRO |
|-----------------|------|-----|
| Wishlists       | 2    | 10  |
| Items           | 20   | 70  |
| Participants    | 5    | 20  |
| Subscriptions   | 2    | 5   |

PRO-only features: `comments`, `url_import`, `hints`, `dont_gift`, `showcase`, `curated_selections`, `profile_subscriptions`.

See also: `docs/MONETIZATION.md`

## Scale

- **67 Prisma models**, **35 enums**
- **54 screens** in the Mini App
- **14 add-on SKUs**

## Lifecycle & Retention

- **Lifecycle/winback engine** for user re-engagement
- **Archive** with 90-day automatic purge
- **Guaranteed welcome delivery** — track and retry /start messages (User.welcomeSent field)
- **Watchdog** — resilient health monitoring with improved recovery

## Feature Flags

| Flag                      | Status                    |
|---------------------------|---------------------------|
| Card redesign             | Rolled out (100%)         |
| Item detail redesign      | Rolled out (100%)         |
| Profile redesign          | Canary (single Telegram ID) |
| Onboarding v2             | Default                   |
| Onboarding v1             | Deprecated                |
| Referral Program          | Disabled (enabled=false, flag-controlled) |

## Operational Toggles

- `MAINTENANCE_MODE` — blocks `/tg/*` and `/public/*` endpoints
- `MARKETPLACE_PARSER_DISABLED` — disables URL import parsing
- **Maintenance Recovery Notifications** — automated system that notifies users who saw a maintenance screen after service recovers. Uses MaintenanceIncident/MaintenanceExposure models, sends recovery messages with "Open bot" CTA

## Analytics

- **Market Segmentation** — `normalizedLocale`, `marketBucket`, `supportedImportRegion` fields on UserProfile. Segments: ru, en, zh-CN, hi, es, ar, other_known, unknown

## Recently Shipped

- **Showcase** — PRO premium public profile page with cover photo, bio, pinned wishlists, preferences (clothing/shoe/ring sizes, body measurements, brand preferences). New screens: showcase-editor, showcase-preview
- **Profile Subscriptions** — Follow other users' public profiles/showcases (PRO)
- **Curated Selections ("часть вишлиста")** — Share a selected subset of wish items via a temporary link (PRO). Guests can subscribe to curated selections
- **Smart Reservations** — Per-wishlist time-limited reservations with auto-release, reminders, and extensions (39 XTR add-on per wishlist). Wishlist settings control TTL hours, max extensions, allow-extend flag
- **Per-wishlist Don't Gift** — Extend "What not to gift" to per-wishlist level with 3 modes: global/custom/disabled
- **Link Management** — View active share links (wishlists/curated selections), revoke them. Endpoint: /tg/me/active-links
- **Secret Reservations** — Reserve a wish secretly so the owner doesn't see who reserved (24 XTR one-time add-on). New screens: secret-reservation-detail, secret-reservation-paywall
- **Comment Quick Reply** — Reply to comments from notifications; threaded one-level replies (parentCommentId on Comment model)
- **Gift Notes onboarding** — Demo-first paywall, 4-step onboarding. New screen: gift-notes-onboarding
- **Referral Program** — Invite-a-friend PRO rewards (30 days PRO per qualified referral). Gated behind enabled=false. New screens: referral, referral-history
- FAQ section in settings
- Legal/terms section in settings

## Key Source Paths

- Frontend: `apps/web/app/miniapp/`
- API: `apps/api/src/`
- DB schema: `packages/db/prisma/schema.prisma`
