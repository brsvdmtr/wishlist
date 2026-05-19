# Documentation Index — WishBoard

> Start here. All documentation for the WishBoard Telegram Mini App project.
> Last updated: 2026-05-20 · Branch: main

---

## What is WishBoard?

WishBoard is a **Telegram Mini App** for managing wishlists. Users create and share wishlists; friends reserve gifts without spoiling the surprise. Monetized via Telegram Stars (PRO plan, 100 Stars/month).

- **Production URL:** https://wishlistik.ru/miniapp
- **Bot:** [@WishHub_bot](https://t.me/WishHub_bot) (configured via `NEXT_PUBLIC_BOT_USERNAME`)
- **Stack:** Express API + Telegraf bot + Next.js 14 + PostgreSQL + Docker Compose

---

## 📖 What to Read First

| Goal | Start here |
|------|-----------|
| Understand the product | [ARCHITECTURE.md](./ARCHITECTURE.md) → [USER_FLOWS.md](./USER_FLOWS.md) |
| Monetization / PRO / billing | [MONETIZATION.md](./MONETIZATION.md) → [SETTINGS_AND_PRIVACY.md](./SETTINGS_AND_PRIVACY.md) |
| Backend / API work | [API_ARCHITECTURE_RULES.md](./API_ARCHITECTURE_RULES.md) → [BACKEND_MAP.md](./BACKEND_MAP.md) → [API_REFERENCE.md](./API_REFERENCE.md) → [API_SECURITY.md](./API_SECURITY.md) |
| Frontend / screens | [FRONTEND_MAP.md](./FRONTEND_MAP.md) |
| Data model | [DATA_MODEL.md](./DATA_MODEL.md) → [ACCESS_MATRIX.md](./ACCESS_MATRIX.md) |
| Server recovery | [MASTER_RESTORE_GUIDE.md](./MASTER_RESTORE_GUIDE.md) → [RECOVERY_RUNBOOK.md](./RECOVERY_RUNBOOK.md) |

---

## 🗺️ Documentation Map

**Status legend:** `primary` = authoritative source of truth · `secondary` = supplemental detail · `ops` = operations/recovery only

### Architecture & System Design

| Doc | Status | What it covers |
|-----|--------|---------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | primary | Product overview, system diagram, module responsibilities, auth layers, design decisions |
| [DATA_MODEL.md](./DATA_MODEL.md) | primary | All 78 Prisma models, 38 enums, relationships, key behaviors |
| [ACCESS_MATRIX.md](./ACCESS_MATRIX.md) | primary | Auth tiers, role definitions, PRO vs FREE limits, data visibility rules |

### Backend

| Doc | Status | What it covers |
|-----|--------|---------------|
| [API_ARCHITECTURE_RULES.md](./API_ARCHITECTURE_RULES.md) | primary | Iron rules: composition root, domain routers, services, state transitions, pre-implementation + review checklists |
| [BACKEND_MAP.md](./BACKEND_MAP.md) | primary | All API routes, middleware chain, helper functions, PLANS constant, cron jobs |
| [API_REFERENCE.md](./API_REFERENCE.md) | primary | All endpoints by domain: auth, wishlists, items, billing, subscriptions, public |
| [API_SECURITY.md](./API_SECURITY.md) | primary | Idempotency-Key, rate limits, IP throttle. Wave-1 protected endpoints, error codes, env flags, runbook |
| [LINK_IMPORT.md](./LINK_IMPORT.md) | primary | URL import pipeline: domain adapters, browser extraction, caching, PRO gate |

### Frontend

| Doc | Status | What it covers |
|-----|--------|---------------|
| [FRONTEND_MAP.md](./FRONTEND_MAP.md) | primary | All 61 screens, state management, design system, PRO upsell system, patterns |
| [FRONTEND_API_MAP.md](./FRONTEND_API_MAP.md) | secondary | Per-screen API call map (~100+ calls). Detailed companion to FRONTEND_MAP + API_REFERENCE |

### Telegram Integration

| Doc | Status | What it covers |
|-----|--------|---------------|
| [TELEGRAM_FLOW.md](./TELEGRAM_FLOW.md) | primary | Bot commands, deep linking, WebApp SDK, auth validation, Telegram Stars billing, notifications, support bridge |

### Monetization

| Doc | Status | What it covers |
|-----|--------|---------------|
| [MONETIZATION.md](./MONETIZATION.md) | primary | Plans, PRO benefits, billing flow, entitlement resolution, UI screens, upsell contexts |
| [SETTINGS_AND_PRIVACY.md](./SETTINGS_AND_PRIVACY.md) | primary | Notification settings, privacy controls, PRO-gated settings, God Mode |

### User Journeys

| Doc | Status | What it covers |
|-----|--------|---------------|
| [USER_FLOWS.md](./USER_FLOWS.md) | primary | 24 step-by-step user flows: onboarding v2, wishlist lifecycle, sharing, reservation, billing, Gift Notes, add-ons, promo, lifecycle |

### Product & Analytics

| Doc | Status | What it covers |
|-----|--------|---------------|
| [CURRENT_PRODUCT_STATE.md](./CURRENT_PRODUCT_STATE.md) | primary | Production feature inventory, rollout states, constraints |
| [ONBOARDING_AND_ACTIVATION.md](./ONBOARDING_AND_ACTIVATION.md) | primary | Onboarding v2 flow, activation logic, experiment flags |
| [ANALYTICS_AND_GODMODE.md](./ANALYTICS_AND_GODMODE.md) | secondary | God Mode dashboard, locale segments, funnel metrics |

### Feature Architecture

| Doc | Status | What it covers |
|-----|--------|---------------|
| [SANTA_ARCHITECTURE.md](./SANTA_ARCHITECTURE.md) | secondary | Secret Santa subsystem architecture and flows |
| [WEB_EXPANSION_AND_AUTH_MODEL.md](./WEB_EXPANSION_AND_AUTH_MODEL.md) | primary | Web auth model, public pages, Telegram/web auth coexistence |

### Infrastructure & Operations

| Doc | Status | What it covers |
|-----|--------|---------------|
| [INFRA_AND_ENV.md](./INFRA_AND_ENV.md) | primary | Server (Vultr), Docker, nginx, env vars, deployment commands, monitoring |
| [DEPLOYMENT_RUNBOOK.md](./DEPLOYMENT_RUNBOOK.md) | ops | Standard deploy via GitHub Actions, rollback, maintenance mode, post-deploy smoke |
| [VULTR_MIGRATION_RUNBOOK.md](./VULTR_MIGRATION_RUNBOOK.md) | ops | Completed Vultr migration record, verification, and Timeweb decommission notes |
| [KNOWN_GAPS_AND_RISKS.md](./KNOWN_GAPS_AND_RISKS.md) | secondary | Critical risks, architecture gaps, security concerns, missing features |
| [OPERATIONS_RUNBOOK_LIGHT.md](./OPERATIONS_RUNBOOK_LIGHT.md) | ops | Quick prod checks, post-deploy verification, incident triage |
| [WEEKLY_OPS_CHECKLIST.md](./WEEKLY_OPS_CHECKLIST.md) | ops | 5-minute weekly checks: health, containers, backups, watchdog, disk |
| [BACKUP_CHECKLIST.md](./BACKUP_CHECKLIST.md) | ops | What must be backed up and how, with cron examples |
| [DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md) | ops | Restore scenarios (DB only, uploads only, full server) using current `.tar.gz` archive format |
| [RECOVERY_RUNBOOK.md](./RECOVERY_RUNBOOK.md) | ops | Step-by-step server recovery procedures and smoke tests |
| [MASTER_RESTORE_GUIDE.md](./MASTER_RESTORE_GUIDE.md) | ops | Full restore guide from scratch + doc index |
| [CRITICAL_BACKUP_ACTIONS.md](./CRITICAL_BACKUP_ACTIONS.md) | ops | Emergency manual backup checklist (fallback only) |
| [CHANGELOG_DOCS.md](./CHANGELOG_DOCS.md) | secondary | Documentation revision history |

---

## Quick Reference

### Plans

| | FREE | PRO |
|--|------|-----|
| Wishlists | 2 | 10 |
| Items per list | 20 | 70 |
| Participants | 5 | 20 |
| Subscriptions | 2 | 5 |
| Price | — | 100 Stars/month |
| Features | — | comments, url_import, hints |

### Key Files

| File | Purpose |
|------|---------|
| `apps/api/src/index.ts` | Entire Express API (large monolith) |
| `apps/web/app/miniapp/MiniApp.tsx` | Entire Mini App frontend (large monolith) |
| `apps/bot/src/index.ts` | Telegram bot (Telegraf) |
| `apps/api/src/url-parser.ts` | URL import pipeline |
| `packages/db/prisma/schema.prisma` | Database schema |
| `packages/shared/src/i18n.ts` | All UI strings (6 locales: ru, en, zh-CN, hi, es, ar) |

> Exact line counts intentionally omitted — they rotted in earlier docs. Run `wc -l` to get the current size.

### Deployment

```bash
# Standard production deploy
git push origin main

# Manual ops/health-check
gh workflow run admin-ops.yml -R brsvdmtr/wishlist -f action=health-check
```

### Auth for Local Dev

```bash
# API calls from browser:
X-TG-INIT-DATA: <Telegram WebApp initData>

# API calls in dev (bypass HMAC validation):
X-TG-DEV: <telegramId>
```

---

## 📚 Canonical Terminology

The table below defines the canonical terms used across all documentation. Where multiple words exist, the **bold** form is the canonical one.

| Concept | Canonical term | Aliases (do not use as primary) |
|---------|---------------|--------------------------------|
| The app | **WishBoard** | Wishlist, wishlistik |
| DB record for a gift | **item** | wish (UI label only), желание (RU UI) |
| Person who created the wishlist | **owner** | creator, author |
| Anonymous visitor via share link | **guest** | friend, visitor |
| Holding an item for gifting | **reservation** | booking, бронь |
| Person who reserved an item | **reserver** | booker, participant |
| Number of distinct reservers allowed | **participants limit** | reservers limit |
| Following a friend's wishlist | **subscription** | following, tracking |
| Person who follows a wishlist | **subscriber** | follower |
| Guest identity token | **actorHash** | actor, guestId |
| Owner never sees reserver identity | **surprise mode** | anonymous mode |
| Visibility / access control | **privacy** (profile-level), **visibility** (wishlist-level) | access settings |
| Plan + subscription state | **entitlement** | plan state |
| Feature lock for FREE users | **PRO gate** | paywall, feature flag |
| URL-based item creation | **URL import** / **add by link** | link import, scraping |

> If you find documentation using non-canonical terms for these concepts, prefer the canonical form in future edits.

---

## What the documentation does NOT cover

- Currency conversion / exchange rates (items support RUB/USD/EUR/GBP, but no conversion between them)
- Custom archive/inbox display
- Full "reserved by me" visibility for other users

These are known planned features, shown as disabled "Coming soon" placeholders in the UI.

### Features added since March 17

- **Onboarding v2** — multi-step onboarding flow with A/B testing (v1 deprecated)
- **Promo system** — promo code redemption (e.g. WISHPRO) with entitlement grants
- **Lifecycle messaging** — winback and engagement messages via bot DM
- **Public profiles** — deep link `profile_` payload for sharing user profiles
- **Card display modes** — configurable card appearance in wishlists
- **Add-on SKU store** — 10 one-time purchase SKUs (extra slots, packs, decorations)
- **Credits system** — hint and import credits for FREE users
- **Gift Notes / Occasions** — occasion-based gift planning (19 XTR or included in PRO)
- **Locale segments analytics** — God Mode language segment dashboard with scope selector
- **Manual language selection** — users can override auto-detected Telegram locale
- **Secret Santa** — full Secret Santa campaign subsystem
- **Support bridge** — in-bot ticket system with admin reply flow

---

## Documentation Rules

### Source of Truth Hierarchy

1. **Code** — always wins over documentation
2. **Prisma schema** (`packages/db/prisma/schema.prisma`) — canonical for data model
3. **PLANS / SKU constants** in `apps/api/src/index.ts` — canonical for limits and pricing
4. **docker-compose.prod.yml** — canonical for infrastructure
5. **Documentation** — describes and explains, but never overrides code

### How to Update Docs Safely

1. Read the relevant code section before changing any doc
2. Verify claims against actual constants, not other docs
3. Update `Last updated` date on every touched file
4. Add an entry to `CHANGELOG_DOCS.md`
5. Cross-check related docs for consistency (e.g., if you change a limit in MONETIZATION.md, check ACCESS_MATRIX.md too)

### Canonical Constants Location

| Constant | Source file |
|----------|-----------|
| Plan limits (FREE/PRO) | `apps/api/src/index.ts` → `PLANS` |
| Add-on SKUs | `apps/api/src/index.ts` → `ONE_TIME_SKUS` |
| Locales | `packages/shared/src/i18n.ts` → `CANONICAL_LOCALES` |
| Prisma models | `packages/db/prisma/schema.prisma` |
| Docker services | `docker-compose.prod.yml` |

---

## Documentation Status

All docs last synchronized with code on **2026-05-03**.
Branch: `main`
Production: `wishlistik.ru` on Vultr Amsterdam VPS `199.247.24.125` (migrated from Timeweb on 2026-05-03 — see [VULTR_MIGRATION_RUNBOOK.md](./VULTR_MIGRATION_RUNBOOK.md)).
