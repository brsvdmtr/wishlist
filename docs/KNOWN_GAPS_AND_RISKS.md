# KNOWN_GAPS_AND_RISKS — Risks, Weak Points & Missing Items
> Last updated: 2026-05-03 · Branch: main

---

## CRITICAL RISKS

### 1. Single Point of Failure: One Server
- **Risk**: All services (DB, API, Web, Bot) on one VPS
- **Impact**: Server down = total outage
- **Mitigation**: Regular backups, documented recovery procedure

### 2. Backup Pipeline Regression
- **Risk**: Scheduled backup or Selectel/S3 upload silently stops working
- **Impact**: Hardware failure could lose data since the last valid archive
- **Current mitigation**: Vultr cron runs `/opt/wishlist/ops/backup.sh` daily at 03:00 UTC; local archive and Selectel/S3 upload were manually verified on 2026-05-03
- **Priority**: HIGH

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
- **Risk**: `apps/api/src/index.ts` is a large single-file backend (tens of thousands of lines as of 2026-05-03 — `wc -l` for the current count). Grew due to monetization, URL import, promo, lifecycle, i18n, credits, security layer, and Santa
- **Impact**: Hard to maintain, test, and reason about
- **Note**: Works for current scale but becomes fragile as features grow

### 6. Monolithic Frontend (Single File)
- **Risk**: `apps/web/app/miniapp/MiniApp.tsx` is a large single-file frontend (tens of thousands of lines as of 2026-05-03 — `wc -l` for the current count) with many `useState` hooks
- **Impact**: State management complexity, no code splitting
- **Note**: Acceptable for Telegram Mini App constraints, but increasingly painful for review/refactor

### 7. In-Memory Notification Queue
- **Risk**: `pendingNotifications` Map is in-memory
- **Impact**: Server restart loses queued notifications (max 30s window)
- **Severity**: LOW (acceptable loss)

### 8. No Request Logging
- **Risk**: No structured logging for API requests
- **Impact**: Hard to debug production issues
- **Note**: Only `console.error` on unhandled errors
- **Status**: RESOLVED — pino-http structured logging added (2026-04-02)

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
- **Status**: Defined in compose for forward compatibility; not a functional gap

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
- **Risk**: `PLANS = { FREE: {...}, PRO: {...} }` hardcoded in index.ts
- **Impact**: Cannot change per-user limits without code deploy
- **Current values**: FREE: wishlists=2, items=20, participants=10, subscriptions=2; PRO: wishlists=10, items=70, participants=20, subscriptions=5
- **Priority**: LOW (by design for current implementation)

---

## MISSING FEATURES / INCOMPLETE

### 20. Tags — REMOVED (2026-05-30)
- **Resolution**: The Tag/ItemTag subsystem was dropped entirely — 0 organic prod data (only demo seed rows), no end-user UI, redundant with the live `WishlistCategory` primitive. All code consumers + Prisma models + tables removed. See `docs/research/tags-decision.md`.

### 21. Public Web Wishlist Page
- **Status**: `/w/:slug` pages exist with SSR
- **Gap**: NEEDS VERIFICATION if actively used or if all traffic goes through Mini App
- **Impact**: May be stale or untested

---

## OPERATIONAL GAPS

### 24. No CI/CD
- **Status**: RESOLVED (2026-05-03) — GitHub Actions `deploy.yml` (selective rebuild on push to `main`) + `admin-ops.yml` (health-check, logs, restart, SQL, env edit) target the Vultr production server. SSH stays as fallback only.

### 25. No Monitoring / Alerting
- **Impact**: No way to know if services are down unless user reports
- **Status**: MITIGATED — multiple layers in place:
  - Watchdog cron (`*/5 * * * *`) on Vultr running `ops/watchdog/health-watchdog.mjs` against `/api/health/deep`
  - GitHub Actions `admin-ops.yml -f action=health-check` (6-point regression gate)
  - Telegram admin alerts via `ADMIN_ALERT_CHAT_IDS` (uncaughtException, unhandledRejection, watchdog DOWN/RECOVERED)
  - Grafana+Loki log aggregation + daily digest (added 2026-04-02)
  - Optional GlitchTip/Sentry (`GLITCHTIP_DSN` + `ENABLE_ERROR_TRACKING`)

### 26. No Error Tracking
- **Impact**: Errors only visible in docker logs (if you look)
- **Need**: Sentry or similar
- **Status**: MITIGATED — GlitchTip/Sentry integration (opt-in) + structured error logging added (2026-04-02)

### 27. No Database Migration Rollback Plan
- **Risk**: Prisma migrations are forward-only
- **Impact**: Bad migration requires manual SQL to fix
- **Mitigation**: Always backup before migration

### 28. SSL Certificate Auto-Renewal on Vultr
- **Status**: RESOLVED (2026-05-25) — see [docs/ops/ssl-renewal.md](ops/ssl-renewal.md)
- **Re-check**: certbot 2.1.0 was already installed; `certbot.timer` is `enabled + active` (twice daily); HTTP-01 challenge succeeds through Cloudflare proxy (`certbot renew --dry-run` green)
- **Hardening added 2026-05-25**:
  - Deploy hook `/etc/letsencrypt/renewal-hooks/deploy/01-nginx-reload.sh` (defense-in-depth `nginx -t` + reload; sends Telegram alert if either step fails so a silent reload failure can't strand nginx on the previous cert for 60 days)
  - Daily expiry monitor [ops/vultr/ssl-expiry-monitor.sh](../ops/vultr/ssl-expiry-monitor.sh) (entry in [ops/cron/root.crontab](../ops/cron/root.crontab) at 09:00 UTC) sends Telegram alert to `ADMIN_ALERT_CHAT_IDS` on bucket transitions (14d → 7d → 3d → 0d); deduped via `/var/lib/wishlist/ssl-monitor.last-bucket` so on-call doesn't get 14 identical messages
- **Residual risk (LOW)**: alert delivery is single-track (Telegram). If `certbot.timer` AND the Telegram bot both fail simultaneously, the origin cert can expire silently. Cloudflare's browser-visible TLS is unaffected (CF rotates its edge cert independently), but origin TLS going stale would break CF→origin handshake under Full/Strict. Recommend pairing with an external uptime check that observes browser-visible TLS via CF edge (covered separately under risk #25 monitoring).
- **Original observation was wrong**: the 2026-05-03 check via `admin-ops exec-shell` reported "certbot not installed", but `which certbot` on the host returns `/usr/bin/certbot`. Likely an exec-shell PATH issue, not a real gap. The Apr 17 cert renewal in `/etc/letsencrypt/archive/` confirms the timer has been firing successfully since long before the gap was filed.

### 30. Client-Only PRO Gate for Recommended Sort
- **Risk**: Guest sort "Recommended" is shown as PRO on client, but no server-side enforcement
- **Impact**: Can be bypassed with custom client
- **Severity**: LOW (low-risk feature, not advertised on paywall)

### 31. Comment Policy Partially Enforced
- **Risk**: `commentPolicy=SUBSCRIBERS` blocks non-reservers server-side, but owner can always comment regardless
- **Impact**: Owner bypass is intentional but undocumented
- **Severity**: LOW (by design)

### 32. In-Memory Parse Cache Lost on Restart
- **Risk**: URL import cache (1000 entries, 24h TTL) is in-memory in url-parser.ts
- **Impact**: After API restart, all cached parses must be re-fetched
- **Severity**: LOW (performance only)

---

## NEWLY IDENTIFIED RISKS (April 2026)

### 33. No Automated Tests
- **Risk**: No unit, integration, or E2E test suite (except one `sort.test.ts`)
- **Impact**: Regressions can only be caught manually; refactoring is high-risk
- **Severity**: CRITICAL

### 34. No Rate Limiting on Most Authenticated Endpoints
- **Risk**: Telegram-authenticated `/tg/*` endpoints have no rate limiting
- **Impact**: A malicious or buggy client can flood the API with requests
- **Severity**: HIGH

### 35. Credits/Billing Without Automated Reconciliation
- **Risk**: Credit purchases and plan upgrades have no automated reconciliation against payment provider records
- **Impact**: Discrepancies between payment provider and internal credit balance may go undetected
- **Severity**: HIGH

### 36. Monolith File Sizes
- **Risk**: Two files contain virtually all application logic (`apps/api/src/index.ts` + `apps/web/app/miniapp/MiniApp.tsx`); each is in the tens of thousands of lines as of 2026-05-03 — run `wc -l` for the current count
- **Impact**: IDE performance, merge conflicts, impossible to assign ownership or review efficiently
- **Severity**: HIGH

### 37. In-Memory setInterval Cron Jobs Without Distributed Locking
- **Risk**: 11+ `setInterval` background jobs run in the API process (promo expiry, lifecycle messages, notification queue flush, etc.)
- **Impact**: If multiple API instances run, jobs execute in parallel with no deduplication; on restart, timers reset and may skip or double-fire
- **Severity**: MEDIUM

### 38. Language Data Migration — Legacy Users Have NULL Language
- **Risk**: Users created before i18n launch have `language = NULL` in the database
- **Impact**: Fallback logic must handle NULL everywhere; analytics on language distribution is incomplete
- **Severity**: MEDIUM

### 39. Support System via supportId Only — Admin-Only Reply
- **Risk**: Support tickets are created with a `supportId` and only admins can reply via the admin panel
- **Impact**: No user-facing ticket history or status; users have no way to check if their issue was addressed
- **Severity**: LOW

### Secret Santa Subsystem

#### 40. Token Rotation / Lifecycle Risk
- **Risk**: Token invalidation rules (when santa tokens expire or are rotated after campaign state transitions) have no explicit operational validation
- **Impact**: Stale campaign access and potential support incidents if users retain old tokens after campaign completion or cancellation
- **Severity**: MEDIUM

#### 41. Multi-Wave Delivery / Orchestration Consistency
- **Risk**: Multi-wave sequencing carries consistency risk if retries, partial sends, or delayed jobs overlap across waves
- **Impact**: Duplicate messages, inconsistent participant state, or silent delivery failures in large campaigns
- **Severity**: MEDIUM

#### 42. Admin Tooling Gap for Santa Campaigns
- **Risk**: No dedicated admin panel or ops-control surface for Santa campaigns; edge cases require manual DB intervention
- **Impact**: Slow incident response for stuck/corrupt campaigns; no safe replay or recovery path without direct DB access
- **Severity**: MEDIUM

### 43. AnalyticsEvent Retention Policy
- **Policy**: Rows older than 90 days deleted by `ops/cleanup-analytics.mjs`
- **Schedule**: Daily at 03:00 UTC via system cron
- **Cron entry**: `0 3 * * * node /opt/wishlist/ops/cleanup-analytics.mjs`
- **Severity**: INFO (documented policy)

---

## MISSING FOR SAFE RECOVERY

### Backed Up Externally

| Artifact | Location | Backup Method |
|----------|----------|---------------|
| .env file | `/opt/wishlist/.env` | Included as `dot-env` in `/opt/wishlist/ops/backup.sh` archive |
| Database dump | PostgreSQL container | `pg_dump --format=custom` via `/opt/wishlist/ops/backup.sh` |
| Upload files | Docker volume `wishlist-prod_wishlist_uploads` | `uploads.tar` via `/opt/wishlist/ops/backup.sh` |
| Nginx config | `/etc/nginx/sites-enabled/wishlistik.ru` (may change to wishlistik.ru) | Already in docs |
| SSH key | `~/.ssh/vultr_wishlist` | Should already be local |
| Bot Token | In .env and @BotFather | Save to password manager |
| Admin Key | In .env | Save to password manager |

### Must Be Created

| Artifact | Priority | Notes |
|----------|----------|-------|
| Automated daily DB backup | DONE | Vultr cron + local archive + Selectel/S3 |
| Automated upload backup | DONE | Same archive, `uploads.tar` |
| .env template with comments | DONE | Full `.env.example` in repo root |
| Health check monitoring | DONE | `ops/watchdog/health-watchdog.mjs` cron + GitHub Actions health-check |
| SSL renewal on Vultr | DONE (2026-05-25) | certbot.timer active, dry-run green, deploy hook + 14d Telegram monitor — see risk #28 and [docs/ops/ssl-renewal.md](ops/ssl-renewal.md) |

---

## FILES WHOSE LOSS IS CRITICAL

| File | Lines | Why Critical |
|------|-------|-------------|
| `apps/api/src/index.ts` | large monolith | ENTIRE backend logic (Express + Prisma) |
| `apps/web/app/miniapp/MiniApp.tsx` | large monolith | ENTIRE Mini App frontend |
| `apps/bot/src/index.ts` | medium monolith | Telegram bot (Telegraf) |
| `packages/db/prisma/schema.prisma` | varies | Database schema |
| `packages/db/prisma/migrations/*` | varies | Migration history |
| `docker-compose.prod.yml` | small | Production deployment config |
| `Dockerfile.api` / `Dockerfile.web` / `Dockerfile.bot` | small | Container builds |
| `.env` (on server) | small | ALL secrets and config |

> Exact line counts removed — they decay quickly. Run `wc -l <path>` to check the current size if needed.

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
| | Requires manual check on production server or external service |
