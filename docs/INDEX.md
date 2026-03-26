# Documentation Index — WishBoard

> Start here. All documentation for the WishBoard Telegram Mini App project.
> Last updated: 2026-03-26 · Branch: main

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
| Backend / API work | [BACKEND_MAP.md](./BACKEND_MAP.md) → [API_REFERENCE.md](./API_REFERENCE.md) |
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
| [DATA_MODEL.md](./DATA_MODEL.md) | primary | All 49 Prisma models, 14 enums, relationships, key behaviors |
| [ACCESS_MATRIX.md](./ACCESS_MATRIX.md) | primary | Auth tiers, role definitions, PRO vs FREE limits, data visibility rules |

### Backend

| Doc | Status | What it covers |
|-----|--------|---------------|
| [BACKEND_MAP.md](./BACKEND_MAP.md) | primary | All API routes, middleware chain, helper functions, PLANS constant, cron jobs |
| [API_REFERENCE.md](./API_REFERENCE.md) | primary | All endpoints by domain: auth, wishlists, items, billing, subscriptions, public |
| [LINK_IMPORT.md](./LINK_IMPORT.md) | primary | URL import pipeline: domain adapters, browser extraction, caching, PRO gate |

### Frontend

| Doc | Status | What it covers |
|-----|--------|---------------|
| [FRONTEND_MAP.md](./FRONTEND_MAP.md) | primary | All 33 screens, state management, design system, PRO upsell system, patterns |
| [FRONTEND_API_MAP.md](./FRONTEND_API_MAP.md) | secondary | Per-screen API call map (38 calls). Detailed companion to FRONTEND_MAP + API_REFERENCE |

### Telegram Integration

| Doc | Status | What it covers |
|-----|--------|---------------|
| [TELEGRAM_FLOW.md](./TELEGRAM_FLOW.md) | primary | Bot commands, deep linking, WebApp SDK, auth validation, billing webhooks, notifications |

### Monetization

| Doc | Status | What it covers |
|-----|--------|---------------|
| [MONETIZATION.md](./MONETIZATION.md) | primary | Plans, PRO benefits, billing flow, entitlement resolution, UI screens, upsell contexts |
| [SETTINGS_AND_PRIVACY.md](./SETTINGS_AND_PRIVACY.md) | primary | Notification settings, privacy controls, PRO-gated settings, God Mode |

### User Journeys

| Doc | Status | What it covers |
|-----|--------|---------------|
| [USER_FLOWS.md](./USER_FLOWS.md) | primary | 19 step-by-step user flows: onboarding, wishlist lifecycle, sharing, reservation, billing |

### Infrastructure & Operations

| Doc | Status | What it covers |
|-----|--------|---------------|
| [INFRA_AND_ENV.md](./INFRA_AND_ENV.md) | primary | Server, Docker, nginx, environment variables, deployment commands, monitoring |
| [KNOWN_GAPS_AND_RISKS.md](./KNOWN_GAPS_AND_RISKS.md) | secondary | Critical risks, architecture gaps, security concerns, missing features |
| [BACKUP_CHECKLIST.md](./BACKUP_CHECKLIST.md) | ops | What must be backed up and how, with cron examples |
| [RECOVERY_RUNBOOK.md](./RECOVERY_RUNBOOK.md) | ops | Step-by-step server recovery procedures |
| [MASTER_RESTORE_GUIDE.md](./MASTER_RESTORE_GUIDE.md) | ops | Full restore guide from scratch + doc index |
| [CRITICAL_BACKUP_ACTIONS.md](./CRITICAL_BACKUP_ACTIONS.md) | ops | Urgent top-10 backup actions checklist |

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
| `apps/api/src/index.ts` | Entire Express API (~9000+ lines) |
| `apps/web/app/miniapp/MiniApp.tsx` | Entire Mini App frontend (~10000+ lines) |
| `apps/bot/src/index.ts` | Telegram bot (~1000 lines) |
| `apps/api/src/url-parser.ts` | URL import pipeline (~800 lines) |
| `packages/db/prisma/schema.prisma` | Database schema |
| `packages/shared/src/i18n.ts` | All UI strings (6 locales: RU, EN, UK, KK, DE, FR) |

### Deployment

```bash
# SSH to server
ssh -i ~/.ssh/timeweb_wishlist root@wishlistik.ru

# Deploy (production branch: main)
cd /opt/wishlist
git pull origin main
docker compose -f docker-compose.prod.yml up -d --build api web bot
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

- Manual language selection (auto-detected from Telegram locale only)
- Currency conversion / exchange rates (items support RUB/USD, but no conversion between them)
- Custom archive/inbox display
- Full "reserved by me" visibility for other users

These are known planned features, shown as disabled "Coming soon" placeholders in the UI.

### Features added since March 17

- **Onboarding v2** — multi-step onboarding flow with A/B testing
- **Promo system** — promo code redemption (e.g. WISHPRO) with entitlement grants
- **Lifecycle messaging** — winback and engagement messages via bot DM
- **Public profiles** — deep link `profile_` payload for sharing user profiles
- **Card display modes** — configurable card appearance in wishlists

---

## Documentation Status

All docs last synchronized with code on **2026-03-26**.
Branch: `main`
Production: `wishlistik.ru`
