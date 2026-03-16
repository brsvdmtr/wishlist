# KNOWN_GAPS_AND_RISKS.md - Risks, Weak Points & Missing Items

---

## CRITICAL RISKS

### 1. Single Point of Failure: One Server
- **Risk**: All services (DB, API, Web, Bot) on one VPS
- **Impact**: Server down = total outage
- **Mitigation**: Regular backups, documented recovery procedure

### 2. No Automated Backups
- **Risk**: Database and uploads have no scheduled backup
- **Impact**: Hardware failure = total data loss
- **Mitigation needed**: Cron job for pg_dump + upload directory backup to external storage
- **Priority**: CRITICAL

### 3. Production .env Not in Version Control
- **Risk**: .env file only exists on server
- **Impact**: If server lost, need to reconstruct all secrets
- **Mitigation needed**: Encrypted backup of .env to secure location
- **Priority**: CRITICAL

### 4. Bot Token & Secrets
- **Risk**: Telegram bot token, admin keys only in .env on server
- **Impact**: Lost access to bot management
- **Location**: Must be stored in @BotFather on Telegram + .env
- **Priority**: HIGH

---

## ARCHITECTURE RISKS

### 5. Monolithic API (Single File)
- **Risk**: `apps/api/src/index.ts` is 1842 lines
- **Impact**: Hard to maintain, test, and reason about
- **Note**: Works for current scale but becomes fragile as features grow

### 6. Monolithic Frontend (Single File)
- **Risk**: `MiniApp.tsx` is 2170 lines with 30+ useState hooks
- **Impact**: State management complexity, no code splitting
- **Note**: Acceptable for Telegram Mini App constraints

### 7. In-Memory Notification Queue
- **Risk**: `pendingNotifications` Map is in-memory
- **Impact**: Server restart loses queued notifications (max 30s window)
- **Severity**: LOW (acceptable loss)

### 8. No Request Logging
- **Risk**: No structured logging for API requests
- **Impact**: Hard to debug production issues
- **Note**: Only `console.error` on unhandled errors

---

## SECURITY CONCERNS

### 9. Static File Serving Without Access Control
- **Risk**: `/api/uploads/*` served publicly without authentication
- **Impact**: Anyone with URL can access any uploaded image
- **Note**: URLs are UUID-based so not guessable, but not truly private
- **Severity**: MEDIUM (acceptable for wishlist photos)

### 10. No HTTPS Internal Communication
- **Risk**: Docker internal traffic is unencrypted
- **Impact**: LOW (bridge network is local to host)

### 11. Public Reservation Endpoints
- **Risk**: `/public/items/:id/reserve` requires only actorHash (UUID)
- **Impact**: If actorHash guessed/leaked, anyone can unreserve
- **Note**: actorHash is SHA-256 of Telegram ID, hard to guess
- **Severity**: LOW

### 12. AUTH_SECRET Environment Variable
- **Risk**: Defined in docker-compose but NOT used in current code
- **Impact**: None currently, but indicates possible incomplete feature
- **Status**: NEEDS VERIFICATION

---

## DATA INTEGRITY GAPS

### 13. No Item Photo Cleanup on Item Deletion
- **Risk**: When item is soft-deleted (status=DELETED), photo files remain on disk
- **Impact**: Orphaned files accumulate over time
- **Code location**: `DELETE /tg/items/:id` only changes status, doesn't call `deleteUploadFile`
- **Priority**: LOW (accumulation is slow)

### 14. No Photo Cleanup on Wishlist Deletion
- **Risk**: CASCADE delete removes DB records but photo files remain on disk
- **Impact**: Orphaned files on hard wishlist delete
- **Priority**: LOW

### 15. reserverUserId Not Cleared on Item Delete/Complete
- **Risk**: If item is COMPLETED while reserved, reserverUserId remains
- **Impact**: No functional issue (status check gates logic), but unclean data
- **Priority**: LOW

---

## SCALABILITY CONCERNS

### 16. No Connection Pooling
- **Risk**: Prisma creates connections per request
- **Impact**: Under high load, connection exhaustion
- **Note**: Acceptable for current low traffic

### 17. Image Processing Blocks Event Loop
- **Risk**: Sharp runs on main thread (Express)
- **Impact**: During image processing, other requests may be slow
- **Mitigation**: Sharp uses native code (libvips), so mostly off-main-thread
- **Priority**: LOW unless traffic grows significantly

### 18. No CDN for Static Assets
- **Risk**: Images served from Express process
- **Impact**: Bandwidth bottleneck on single server
- **Priority**: LOW (current scale is fine)

### 19. Plan Limits Hardcoded
- **Risk**: `PLAN = { WISHLISTS: 2, ITEMS: 10 }` hardcoded in API
- **Impact**: Cannot change per-user limits without code deploy
- **Priority**: LOW (by design for MVP)

---

## MISSING FEATURES / INCOMPLETE

### 20. Tags Only via Admin
- **Status**: Tag model exists, admin CRUD works
- **Gap**: No tag creation/management in Mini App UI
- **Impact**: Feature exists in DB but unusable for Telegram users

### 21. Public Web Wishlist Page
- **Status**: `/w/:slug` pages exist with SSR
- **Gap**: NEEDS VERIFICATION if actively used or if all traffic goes through Mini App
- **Impact**: May be stale or untested

### 22. AUTH_SECRET / LOG_LEVEL Env Vars
- **Status**: Defined in docker-compose.prod.yml
- **Gap**: Not used in current API code
- **Impact**: Dead configuration, confusing

### 23. NEXT_PUBLIC_MINIAPP_SHORT_NAME
- **Status**: Env var exists
- **Gap**: NEEDS VERIFICATION of usage in web app
- **Impact**: Unknown

---

## OPERATIONAL GAPS

### 24. No CI/CD
- **Impact**: Manual deployment, human error risk
- **Current process**: SSH -> git pull -> docker compose build/up

### 25. No Monitoring / Alerting
- **Impact**: No way to know if services are down unless user reports
- **Need**: Health check monitoring (even simple uptime ping)

### 26. No Error Tracking
- **Impact**: Errors only visible in docker logs (if you look)
- **Need**: Sentry or similar

### 27. No Database Migration Rollback Plan
- **Risk**: Prisma migrations are forward-only
- **Impact**: Bad migration requires manual SQL to fix
- **Mitigation**: Always backup before migration

### 28. SSL Certificate Renewal
- **Risk**: Let's Encrypt certs expire every 90 days
- **Gap**: NEEDS VERIFICATION if certbot auto-renewal is configured
- **Impact**: Site goes down if cert expires

### 29. Git Branch Strategy `NEEDS_VERIFICATION`
- **Risk**: Development on `claude/wizardly-satoshi` worktree branch
- **Gap**: Unknown if merged to `main`. Unknown which branch is deployed on production server.
- **Impact**: `git pull origin main` may miss latest changes
- **Action**: Verify on server: `cd /opt/wishlist && git branch && git log --oneline -3`

---

## MISSING FOR SAFE RECOVERY

### Must Be Backed Up Externally NOW

| Artifact | Location | Backup Method |
|----------|----------|---------------|
| .env file | `/opt/wishlist/.env` | `scp` to local machine |
| Database dump | PostgreSQL container | `pg_dump` to file |
| Upload files | Docker volume `wishlist_uploads` | `docker cp` to host |
| Nginx config | `/etc/nginx/sites-enabled/wishlistik.ru` | Already in docs |
| SSH key | `~/.ssh/timeweb_wishlist` | Should already be local |
| Bot Token | In .env and @BotFather | Save to password manager |
| Admin Key | In .env | Save to password manager |

### Must Be Created

| Artifact | Priority | Notes |
|----------|----------|-------|
| Automated daily DB backup | CRITICAL | cron + pg_dump + offsite |
| Automated upload backup | HIGH | cron + tar + offsite |
| .env template with comments | DONE | Full `.env.example` in repo root |
| Health check monitoring | HIGH | UptimeRobot or similar |
| SSL renewal verification | HIGH | `certbot renew --dry-run` |

---

## FILES WHOSE LOSS IS CRITICAL

| File | Lines | Why Critical |
|------|-------|-------------|
| `apps/api/src/index.ts` | 1842 | ENTIRE backend logic |
| `apps/web/app/miniapp/MiniApp.tsx` | 2170 | ENTIRE Mini App frontend |
| `packages/db/prisma/schema.prisma` | ~120 | Database schema |
| `packages/db/prisma/migrations/*` | varies | Migration history |
| `docker-compose.prod.yml` | 91 | Production deployment config |
| `Dockerfile.api` | 43 | API container build |
| `Dockerfile.web` | ~50 | Web container build |
| `Dockerfile.bot` | ~40 | Bot container build |
| `apps/bot/src/index.ts` | ~100 | Telegram bot logic |
| `.env` (on server) | ~20 | ALL secrets and config |

---

## WHAT IS LOST WITHOUT BACKUP

| Артефакт | Без бэкапа | С бэкапом | Восстановимость |
|----------|-----------|-----------|-----------------|
| Исходный код | Восстановимо из GitHub | — | **Полная** |
| База данных (пользователи, вишлисты, бронирования) | **ПОТЕРЯ НАВСЕГДА** | pg_dump → restore за 5 мин | Зависит от бэкапа |
| Фото предметов | **ПОТЕРЯ НАВСЕГДА** | docker cp → restore за 5 мин | Зависит от бэкапа |
| .env (BOT_TOKEN, ADMIN_KEY, пароли) | Частично: BOT_TOKEN из @BotFather, остальное генерировать заново | cp → restore за 1 мин | Частичная |
| Nginx конфиг | Восстановимо из docs/RECOVERY_RUNBOOK.md | — | **Полная** |
| SSL-сертификат | certbot сгенерирует новый (~2 мин) | — | **Полная** |
| Docker volumes | Теряются при уничтожении сервера | Требуется отдельный бэкап | Зависит от бэкапа |

---

## CONFIDENCE MARKERS LEGEND

This documentation uses the following markers to indicate data source reliability:

| Marker | Meaning |
|--------|---------|
| `VERIFIED_FROM_CODE` | Confirmed by reading source code directly |
| `VERIFIED_FROM_CONFIG` | Confirmed from config files (docker-compose, Dockerfiles, package.json) |
| `INFERRED_FROM_USAGE` | Deduced from how the system is used, not directly confirmed |
| `NEEDS_VERIFICATION` | Requires manual check on production server or external service |
