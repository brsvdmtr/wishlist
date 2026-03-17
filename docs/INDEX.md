# Documentation Index — WishBoard

> Start here. All documentation for the WishBoard Telegram Mini App project.
> Last updated: 2026-03-17 · Branch: claude/wizardly-satoshi

---

## What is WishBoard?

WishBoard is a **Telegram Mini App** for managing wishlists. Users create and share wishlists; friends reserve gifts without spoiling the surprise. Monetized via Telegram Stars (PRO plan, 100 Stars/month).

- **Production URL:** https://wishlistik.ru/miniapp
- **Bot:** [@WishHub_bot](https://t.me/WishHub_bot) (configured via `NEXT_PUBLIC_BOT_USERNAME`)
- **Stack:** Express API + Telegraf bot + Next.js 14 + PostgreSQL + Docker Compose

---

## 🗺️ Documentation Map

### Architecture & System Design

| Doc | What it covers |
|-----|---------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Product overview, system diagram, module responsibilities, auth layers, design decisions |
| [DATA_MODEL.md](./DATA_MODEL.md) | All 20 Prisma models, 14 enums, relationships, key behaviors |
| [ACCESS_MATRIX.md](./ACCESS_MATRIX.md) | Auth tiers, role definitions, PRO vs FREE limits, data visibility rules |

### Backend

| Doc | What it covers |
|-----|---------------|
| [BACKEND_MAP.md](./BACKEND_MAP.md) | All API routes, middleware chain, helper functions, PLANS constant, cron jobs |
| [API_REFERENCE.md](./API_REFERENCE.md) | All endpoints by domain: auth, wishlists, items, billing, subscriptions, public |
| [LINK_IMPORT.md](./LINK_IMPORT.md) | URL import pipeline: domain adapters, browser extraction, caching, PRO gate |

### Frontend

| Doc | What it covers |
|-----|---------------|
| [FRONTEND_MAP.md](./FRONTEND_MAP.md) | All 14+ screens, state management, design system, PRO upsell system, patterns |
| [FRONTEND_API_MAP.md](./FRONTEND_API_MAP.md) | Frontend ↔ API call map (legacy, see FRONTEND_MAP.md for current) |

### Telegram Integration

| Doc | What it covers |
|-----|---------------|
| [TELEGRAM_FLOW.md](./TELEGRAM_FLOW.md) | Bot commands, deep linking, WebApp SDK, auth validation, billing webhooks, notifications |

### Monetization

| Doc | What it covers |
|-----|---------------|
| [MONETIZATION.md](./MONETIZATION.md) | Plans, PRO benefits, billing flow, entitlement resolution, UI screens, upsell contexts |
| [SETTINGS_AND_PRIVACY.md](./SETTINGS_AND_PRIVACY.md) | Notification settings, privacy controls, PRO-gated settings, God Mode |

### User Journeys

| Doc | What it covers |
|-----|---------------|
| [USER_FLOWS.md](./USER_FLOWS.md) | 19 step-by-step user flows: onboarding, wishlist lifecycle, sharing, reservation, billing |

### Infrastructure & Operations

| Doc | What it covers |
|-----|---------------|
| [INFRA_AND_ENV.md](./INFRA_AND_ENV.md) | Server, Docker, nginx, environment variables, deployment commands, monitoring |
| [KNOWN_GAPS_AND_RISKS.md](./KNOWN_GAPS_AND_RISKS.md) | Critical risks, architecture gaps, security concerns, missing features |
| [BACKUP_CHECKLIST.md](./BACKUP_CHECKLIST.md) | What must be backed up and how |
| [RECOVERY_RUNBOOK.md](./RECOVERY_RUNBOOK.md) | Step-by-step server recovery procedures |
| [MASTER_RESTORE_GUIDE.md](./MASTER_RESTORE_GUIDE.md) | Full restore guide from scratch |
| [CRITICAL_BACKUP_ACTIONS.md](./CRITICAL_BACKUP_ACTIONS.md) | Urgent backup actions checklist |

---

## Quick Reference

### Plans

| | FREE | PRO |
|--|------|-----|
| Wishlists | 2 | 10 |
| Items per list | 30 | 100 |
| Participants | 5 | 20 |
| Subscriptions | 2 | 7 |
| Price | — | 100 Stars/month |
| Features | — | comments, url_import, hints |

### Key Files

| File | Purpose |
|------|---------|
| `apps/api/src/index.ts` | Entire Express API (~3900 lines) |
| `apps/web/app/miniapp/MiniApp.tsx` | Entire Mini App frontend (~4500 lines) |
| `apps/bot/src/index.ts` | Telegram bot (~100 lines) |
| `apps/api/src/url-parser.ts` | URL import pipeline (~800 lines) |
| `packages/db/prisma/schema.prisma` | Database schema |
| `packages/shared/src/i18n.ts` | All UI strings (RU + EN) |

### Deployment

```bash
# SSH to server
ssh -i ~/.ssh/timeweb_wishlist root@wishlistik.ru

# Deploy
cd /opt/wishlist
git pull
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

## What the documentation does NOT cover

- Manual language selection (auto-detected from Telegram locale only)
- Currency conversion / exchange rates (schema has Currency field, not yet in UI)
- Custom archive/inbox display
- Onboarding / tips system
- Full "reserved by me" visibility for other users

These are known planned features, shown as disabled "Coming soon" placeholders in the UI.

---

## Documentation Status

All docs last synchronized with code on **2026-03-17**.
Branch: `claude/wizardly-satoshi`
Production: `wishlistik.ru`
