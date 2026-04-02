# Current Product State

Production feature inventory for the Wishlist Telegram Mini App.

**Last updated:** 2026-04-02

---

## Core Features

- **Wishlists** with public sharing via slug, item management, reservations
- **URL import/parsing** for adding items from external links
- **Comments** on wishlist items
- **Hints** for item gifting guidance
- **Gift Notes** (19 XTR one-time purchase)
- **Secret Santa** campaigns
- **Support tickets** from within the app

## Monetization

- **PRO subscription**: 100 XTR/month
- **10 add-on SKUs** (including Gift Notes at 19 XTR)

### Plan Limits

| Resource        | FREE | PRO |
|-----------------|------|-----|
| Wishlists       | 2    | 10  |
| Items           | 20   | 70  |
| Participants    | 5    | 20  |
| Subscriptions   | 2    | 5   |

PRO-only features: `comments`, `url_import`, `hints`.

See also: `docs/MONETIZATION.md`

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

## Upcoming

- FAQ section in settings
- Legal/terms section in settings

## Key Source Paths

- Frontend: `apps/web/app/miniapp/`
- API: `apps/api/src/`
- DB schema: `packages/db/prisma/schema.prisma`
