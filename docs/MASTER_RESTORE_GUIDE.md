# MASTER_RESTORE_GUIDE.md - WishBoard Project Complete Reference

## Quick Reference

| Property | Value |
|----------|-------|
| Product | WishBoard - Telegram Wishlist Mini App |
| Domain | wishlistik.ru |
| Repository | https://github.com/brsvdmtr/wishlist.git |
| Branch | claude/wizardly-satoshi `NEEDS_VERIFICATION: confirm if merged to main` |
| Server | Timeweb VPS, SSH: `root@wishlistik.ru` |
| SSH Key | `~/.ssh/timeweb_wishlist` |
| Stack | Node 20, TypeScript, Express, Next.js 14, React 18, Telegraf, PostgreSQL 16, Prisma 5.18, Docker |
| Package Manager | pnpm 10.15.0 |

---

## Document Index

| Document | Purpose |
|----------|---------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | System overview, module roles, data flow diagrams |
| [DATA_MODEL.md](./DATA_MODEL.md) | Database schema, entities, fields, relations, migrations |
| [API_REFERENCE.md](./API_REFERENCE.md) | All HTTP endpoints with request/response schemas |
| [BACKEND_MAP.md](./BACKEND_MAP.md) | Backend code structure, business logic, background jobs |
| [FRONTEND_MAP.md](./FRONTEND_MAP.md) | Screens, components, state, design system |
| [TELEGRAM_FLOW.md](./TELEGRAM_FLOW.md) | Bot commands, deep links, WebApp SDK, notifications |
| [INFRA_AND_ENV.md](./INFRA_AND_ENV.md) | Server, Docker, nginx, env vars, build/deploy commands |
| [RECOVERY_RUNBOOK.md](./RECOVERY_RUNBOOK.md) | Step-by-step disaster recovery procedure |
| [KNOWN_GAPS_AND_RISKS.md](./KNOWN_GAPS_AND_RISKS.md) | Risks, weak points, missing backups |
| [BACKUP_CHECKLIST.md](./BACKUP_CHECKLIST.md) | Full backup checklist (8 blocks) |
| [ACCESS_MATRIX.md](./ACCESS_MATRIX.md) | Role-based access matrix for all actions |
| [FRONTEND_API_MAP.md](./FRONTEND_API_MAP.md) | Frontend-to-API interaction map (35 calls) |
| [CRITICAL_BACKUP_ACTIONS.md](./CRITICAL_BACKUP_ACTIONS.md) | Top 10 immediate backup actions |

---

## Project Summary

### What It Does
WishBoard lets Telegram users create wishlists and share them with friends. Friends can anonymously reserve gifts without the list owner knowing who reserved what. Owner and reserver can exchange private comments.

### Key Differentiators
- **Anonymous reservations**: Owner never sees who reserved
- **Telegram-native**: Opens as Mini App, deep linking via bot
- **Private comments**: Only visible to owner + reserver pair
- **Photo support**: Compressed JPEG with EXIF stripping

### Audit Metadata

| Property | Value |
|----------|-------|
| Audit date | March 10, 2026 |
| Audited branch | `claude/wizardly-satoshi` |
| Confidence | Most data VERIFIED_FROM_CODE; server-side items marked NEEDS_VERIFICATION |

**Confidence markers used in all documents:**
- `VERIFIED_FROM_CODE` — Confirmed by reading source code
- `VERIFIED_FROM_CONFIG` — Confirmed from config files
- `INFERRED_FROM_USAGE` — Deduced from usage patterns
- `NEEDS_VERIFICATION` — Requires manual check on server

### Implementation Status (March 2026)

| Feature | Status |
|---------|--------|
| Wishlist CRUD | Complete |
| Item CRUD with photo | Complete |
| Anonymous reservations | Complete |
| Private comments | Complete |
| Telegram deep linking | Complete |
| Push notifications | Complete |
| Image compression (Sharp) | Complete |
| Persistent uploads (Docker volume) | Complete |
| Wishlist rename | Complete |
| Tags/categories | Backend only (no Mini App UI) |
| Public web view (`/w/:slug`) | Exists but secondary |
| Admin panel | Functional |
| CI/CD | Not implemented |
| Monitoring | Not implemented |
| Automated backups | Not implemented |

---

## Repository Structure

```
wishlist/
├── apps/
│   ├── api/                    # Express REST API (port 3001)
│   │   ├── src/
│   │   │   ├── index.ts        # ALL backend code (1842 lines)
│   │   │   ├── sort.ts         # Item sorting logic
│   │   │   ├── sort.test.ts    # Sort unit tests
│   │   │   └── seed.ts         # Demo data seeder
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsconfig.build.json
│   │
│   ├── bot/                    # Telegram Bot (Telegraf)
│   │   ├── src/
│   │   │   └── index.ts        # Bot logic (100 lines)
│   │   ├── package.json
│   │   ├── tsconfig.json
│   │   └── tsconfig.build.json
│   │
│   └── web/                    # Next.js 14 Frontend (port 3000)
│       ├── app/
│       │   ├── miniapp/
│       │   │   └── MiniApp.tsx  # ENTIRE Mini App (2170 lines)
│       │   ├── admin/           # Admin panel pages
│       │   ├── w/[slug]/        # Public wishlist pages
│       │   ├── layout.tsx       # Root layout
│       │   └── page.tsx         # Home page
│       ├── lib/                 # Auth, API client helpers
│       ├── middleware.ts        # Basic auth, redirects
│       ├── next.config.mjs
│       └── package.json
│
├── packages/
│   ├── db/                     # Database package
│   │   ├── prisma/
│   │   │   ├── schema.prisma   # Database schema
│   │   │   └── migrations/     # 5 migration files
│   │   ├── src/index.ts        # Prisma client singleton
│   │   ├── scripts/prisma.cjs  # CLI wrapper
│   │   └── package.json
│   │
│   └── shared/                 # Shared utilities
│       ├── src/index.ts        # Deep link builders, Zod schemas
│       └── package.json
│
├── docs/                       # THIS documentation
├── Dockerfile.api
├── Dockerfile.bot
├── Dockerfile.web
├── docker-compose.prod.yml     # Production compose
├── docker-compose.dev.yml      # Development compose
├── package.json                # Root workspace config
├── pnpm-workspace.yaml
├── pnpm-lock.yaml
├── tsconfig.base.json
├── .eslintrc.cjs
├── .prettierrc.json
└── .env.example
```

---

## Critical Files for Recovery (Priority Order)

1. **`.env`** (production, on server only) - All secrets
2. **`packages/db/prisma/schema.prisma`** - Database schema definition
3. **`apps/api/src/index.ts`** - Entire backend
4. **`apps/web/app/miniapp/MiniApp.tsx`** - Entire Mini App
5. **`docker-compose.prod.yml`** - Production deployment
6. **`Dockerfile.*`** (3 files) - Container builds
7. **`apps/bot/src/index.ts`** - Bot logic
8. **`packages/db/prisma/migrations/`** - Migration history
9. **Nginx config** (on server) - Reverse proxy

---

## Emergency Recovery (TL;DR)

> **Note**: Migrations run automatically on API start (non-fatal). `VERIFIED_FROM_CODE`
> Container names below assume default compose project. Use `docker compose exec` where possible.

```bash
# 1. Get code
git clone https://github.com/brsvdmtr/wishlist.git /opt/wishlist
cd /opt/wishlist && git checkout claude/wizardly-satoshi  # NEEDS_VERIFICATION: confirm branch

# 2. Create .env (fill in secrets — full template in .env.example)
cp .env.example .env && vi .env

# 3. Setup nginx (see INFRA_AND_ENV.md)

# 4. Build & start (migrations run auto on api start)
docker compose -f docker-compose.prod.yml up -d --build

# 5. Verify
curl https://wishlistik.ru/api/health
# -> {"ok":true}

# 6. Restore DB from backup (if available)
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U wishlist -d wishlist < backup.sql

# 7. Restore uploads (if available)
docker cp /path/to/uploads/. $(docker compose -f docker-compose.prod.yml ps -q api):/data/uploads/
```

---

## What To Back Up RIGHT NOW

```bash
# Run on server:
mkdir -p /opt/backup

# 1. Database
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U wishlist wishlist > /opt/backup/db_$(date +%Y%m%d).sql

# 2. Uploads
docker cp $(docker compose -f docker-compose.prod.yml ps -q api):/data/uploads \
  /opt/backup/uploads_$(date +%Y%m%d)

# 3. Environment
cp /opt/wishlist/.env /opt/backup/env_$(date +%Y%m%d)

# 4. Nginx config
cp /etc/nginx/sites-enabled/wishlistik.ru /opt/backup/nginx_$(date +%Y%m%d)

# 5. Copy backups off server
scp -i ~/.ssh/timeweb_wishlist -r root@wishlistik.ru:/opt/backup ./backup_$(date +%Y%m%d)
```
