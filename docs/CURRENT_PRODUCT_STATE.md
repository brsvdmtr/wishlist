# Current Product State

Production feature inventory for the Wishlist Telegram Mini App.

**Last updated:** 2026-04-10

---

## Core Features

- **Wishlists** with public sharing via slug, item management, reservations
- **Wishlist Categories** — organize wishes into sections within a wishlist. Create/rename/delete categories, move items between them, drag to reorder. Collapsible sections for owner and guests
- **URL import/parsing** for adding items from external links
- **Comments** on wishlist items
- **Hints** for item gifting guidance
- **Gift Notes** (19 XTR one-time purchase)
- **Group Gift (Совместный подарок)** — pool money together for one gift. Organizer creates a collection (79 XTR one-time unlock), invites participants via deep link, tracks progress. Features: target amount, deadline, pinned payment info, participant chat, complete/cancel. Shows in "My Reservations" for both organizer and participants
- **Don't Gift (Не дарить)** — PRO feature. Profile-level gift restrictions. Users specify preset categories and custom items they don't want to receive. Visible to friends on guest view
- **Secret Santa** campaigns
- **Support tickets** from within the app

## Monetization

- **PRO subscription**: 100 XTR/month
- **12 add-on SKUs** (including Gift Notes at 19 XTR, reservation_pro_unlock at 50 XTR, group_gift_unlock at 79 XTR)

### Plan Limits

| Resource        | FREE | PRO |
|-----------------|------|-----|
| Wishlists       | 2    | 10  |
| Items           | 20   | 70  |
| Participants    | 5    | 20  |
| Subscriptions   | 2    | 5   |

PRO-only features: `comments`, `url_import`, `hints`, `dont_gift`.

See also: `docs/MONETIZATION.md`

## Scale

- **58 Prisma models**, **31 enums**
- **46 screens** in the Mini App
- **12 add-on SKUs**

## Lifecycle & Retention

- **Lifecycle/winback engine** for user re-engagement
- **Archive** with 90-day automatic purge

## Feature Flags

| Flag                      | Status                    |
|---------------------------|---------------------------|
| Card redesign             | Rolled out (100%)         |
| Item detail redesign      | Rolled out (100%)         |
| Profile redesign          | Canary (single Telegram ID) |
| Onboarding v2             | Default                   |
| Onboarding v1             | Deprecated                |

## Operational Toggles

- `MAINTENANCE_MODE` — blocks `/tg/*` and `/public/*` endpoints
- `MARKETPLACE_PARSER_DISABLED` — disables URL import parsing
- **Maintenance Recovery Notifications** — automated system that notifies users who saw a maintenance screen after service recovers. Uses MaintenanceIncident/MaintenanceExposure models, sends recovery messages with "Open bot" CTA

## Analytics

- **Market Segmentation** — `normalizedLocale`, `marketBucket`, `supportedImportRegion` fields on UserProfile. Segments: ru, en, zh-CN, hi, es, ar, other_known, unknown

## Recently Shipped

- FAQ section in settings
- Legal/terms section in settings

## Key Source Paths

- Frontend: `apps/web/app/miniapp/`
- API: `apps/api/src/`
- DB schema: `packages/db/prisma/schema.prisma`
