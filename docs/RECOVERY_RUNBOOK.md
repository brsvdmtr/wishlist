# RECOVERY_RUNBOOK.md - Step-by-Step Disaster Recovery

> Last updated: 2026-05-03 · Branch: main

## Prerequisites

Before starting recovery, ensure you have:

- [ ] SSH access to server (`ssh -i ~/.ssh/timeweb_wishlist root@199.247.24.125`)
- [ ] Git repository access (https://github.com/brsvdmtr/wishlist.git)
- [ ] Production `.env` file (see template below)
- [ ] Telegram Bot Token
- [ ] Domain DNS pointing to server IP
- [ ] SSL certificates (or ability to generate via Let's Encrypt)

---

## Phase 1: Server Setup (15 min)

### 1.1 Install Docker & Docker Compose
```bash
apt-get update && apt-get install -y docker.io docker-compose-plugin
systemctl enable docker && systemctl start docker
```

### 1.2 Install Nginx
```bash
apt-get install -y nginx
```

### 1.3 Install Git
```bash
apt-get install -y git
```

### 1.4 Setup SSL (if needed)
```bash
apt-get install -y certbot python3-certbot-nginx
certbot --nginx -d wishlistik.ru -d www.wishlistik.ru
```

---

## Phase 2: Clone & Configure (10 min)

### 2.1 Clone Repository
```bash
mkdir -p /opt
cd /opt
git clone https://github.com/brsvdmtr/wishlist.git
cd /opt/wishlist
git checkout main  # Production branch
```

### 2.2 Create .env File
```bash
cat > /opt/wishlist/.env << 'EOF'
# Database
DATABASE_URL=postgresql://wishlist:YOUR_DB_PASSWORD@postgres:5432/wishlist?schema=public
POSTGRES_USER=wishlist
POSTGRES_PASSWORD=YOUR_DB_PASSWORD
POSTGRES_DB=wishlist

# API
PORT=3001
WEB_ORIGIN=https://wishlistik.ru
ADMIN_KEY=YOUR_ADMIN_KEY
BOT_TOKEN=YOUR_TELEGRAM_BOT_TOKEN
SYSTEM_USER_EMAIL=owner@local
AUTH_SECRET=
LOG_LEVEL=info
UPLOAD_DIR=/data/uploads

# Web
NEXT_PUBLIC_API_BASE_URL=https://wishlistik.ru/api
NEXT_PUBLIC_SITE_URL=https://wishlistik.ru
NEXT_PUBLIC_BOT_USERNAME=WishHub_bot
NEXT_PUBLIC_MINIAPP_SHORT_NAME=
INTERNAL_API_BASE_URL=http://api:3001
ADMIN_BASIC_USER=admin
ADMIN_BASIC_PASS=YOUR_ADMIN_PASSWORD

# Bot
MINI_APP_URL=https://wishlistik.ru/miniapp
SITE_URL=https://wishlistik.ru
API_BASE_URL=http://api:3001
EOF
```

**CRITICAL**: Replace all `YOUR_*` placeholders with actual values.

### 2.3 Configure Nginx
```bash
# Copy maintenance page
mkdir -p /opt/wishlist/ops/maintenance
cp /opt/wishlist/ops/maintenance/maintenance.html /opt/wishlist/ops/maintenance/

cat > /etc/nginx/sites-enabled/wishlistik.ru << 'EOF'
server {
  listen 80;
  server_name wishlistik.ru www.wishlistik.ru;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl;
  server_name wishlistik.ru www.wishlistik.ru;

  ssl_certificate     /etc/letsencrypt/live/wishlistik.ru/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/wishlistik.ru/privkey.pem;

  # Maintenance page (auto-fallback on upstream 502/503/504)
  error_page 502 503 504 /maintenance.html;
  location = /maintenance.html {
    root /opt/wishlist/ops/maintenance;
    internal;
  }

  location /api/ {
    client_max_body_size 30m;
    proxy_pass http://127.0.0.1:3001/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_intercept_errors on;
  }

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_intercept_errors on;
  }
}
EOF

nginx -t && systemctl reload nginx
```

---

## Phase 3: Build & Start (20-30 min)

### 3.1 Build All Services
```bash
cd /opt/wishlist
docker compose -f docker-compose.prod.yml build
```

**Note**: First build takes 10-20 min (downloads Node images, installs dependencies).

### 3.2 Start Services
```bash
docker compose -f docker-compose.prod.yml up -d
```

### 3.3 Verify All Services Running
```bash
docker compose -f docker-compose.prod.yml ps
# Should show: postgres (healthy), api (running), web (running), bot (running)
```

### 3.4 Check Logs
> **Note**: Container names depend on compose project name. Use `docker compose logs` to avoid hardcoded names.
> Default names: `wishlist-prod-api-1`, `wishlist-prod-web-1`, etc.

```bash
docker compose -f docker-compose.prod.yml logs --tail 20 api
# Should show: "[api] listening on http://localhost:3001"

docker compose -f docker-compose.prod.yml logs --tail 20 bot
# Should show: "[bot] started"

docker compose -f docker-compose.prod.yml logs --tail 20 web
# Should show: Next.js ready
```

---

## Phase 4: Database Recovery (5-15 min)

> **Primary path is the rolling production backup archive.** `ops/backup.sh`
> writes `wishlist_YYYYMMDD_HHMMSS.tar.gz` to `/opt/backups/wishlist/` and
> uploads to Selectel/S3 (`wishlist-s3:wishlist-backups`). Each archive
> contains `db.dump` (`pg_dump --format=custom`), `uploads.tar`, and `dot-env`,
> with a sibling `.sha256` checksum.
>
> See [DISASTER_RECOVERY.md](./DISASTER_RECOVERY.md) for end-to-end DB-only,
> uploads-only, and full-server scenarios. The steps below are the recovery
> sub-steps for this runbook.

### 4.1 Restore from production archive (primary)
```bash
# 1. Find the archive (local) or pull from S3:
ls -lht /opt/backups/wishlist/ | head
# rclone copy wishlist-s3:wishlist-backups/wishlist_YYYYMMDD_HHMMSS.tar.gz /tmp/
# rclone copy wishlist-s3:wishlist-backups/wishlist_YYYYMMDD_HHMMSS.tar.gz.sha256 /tmp/

# 2. Verify checksum BEFORE restore
cd /opt/backups/wishlist
sha256sum -c wishlist_YYYYMMDD_HHMMSS.tar.gz.sha256

# 3. Extract
mkdir -p /tmp/restore
tar -xzf wishlist_YYYYMMDD_HHMMSS.tar.gz -C /tmp/restore
ls /tmp/restore   # expect: db.dump  uploads.tar  dot-env

# 4. Pipe pg_restore through docker compose exec (no hardcoded container name)
cd /opt/wishlist
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U wishlist -d wishlist --clean --if-exists < /tmp/restore/db.dump

# 5. Restore uploads (overwrites the volume contents)
UPLOADS_VOL=$(docker volume inspect wishlist-prod_wishlist_uploads -f '{{.Mountpoint}}')
tar -xf /tmp/restore/uploads.tar -C "$UPLOADS_VOL"
chown -R 1001:1001 "$UPLOADS_VOL"

# 6. Restore .env if it was lost (verify critical vars before reusing)
test -f /opt/wishlist/.env || cp /tmp/restore/dot-env /opt/wishlist/.env
grep -E '^(DATABASE_URL|BOT_TOKEN|ADMIN_KEY|POSTGRES_PASSWORD)=' /opt/wishlist/.env

# 7. Cleanup
rm -rf /tmp/restore
```

### 4.1-legacy Restore from a plain SQL dump (manual alternative)
Only when an archive is unavailable and you have a hand-rolled `pg_dump --format=plain` file.
```bash
# Copy dump to server
scp backup.sql root@199.247.24.125:/tmp/

# Restore (use docker compose exec to avoid hardcoded container names)
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U wishlist -d wishlist < /tmp/backup.sql
```

### 4.2 If Starting Fresh (No Dump)
Migrations run automatically on API container start (non-fatal — app starts even if migration fails). `VERIFIED_FROM_CODE`
```bash
docker compose -f docker-compose.prod.yml logs api | grep -i migrat
# Should show "prisma migrate deploy" output or "migration skipped"
```

If migrations didn't run:
```bash
docker compose -f docker-compose.prod.yml exec api \
  npx prisma migrate deploy --schema=packages/db/prisma/schema.prisma
```

### 4.3 Seed Demo Data (Optional)
```bash
# Not available in production container. Run manually:
docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "
INSERT INTO \"User\" (id, email, \"createdAt\", \"updatedAt\")
VALUES ('system', 'owner@local', NOW(), NOW())
ON CONFLICT (email) DO NOTHING;
"
```

---

## Phase 5: Restore Uploaded Images

### 5.1 If Backup Volume Available
```bash
# Find api container name:
docker compose -f docker-compose.prod.yml ps --format '{{.Name}}' | grep api
# Example output: wishlist-prod-api-1

# Copy files to Docker volume (replace container name if different):
docker cp /path/to/backup/uploads/. wishlist-prod-api-1:/data/uploads/
```

### 5.2 Fix Permissions
```bash
docker compose -f docker-compose.prod.yml exec api \
  sh -c 'chown -R apiuser:apiuser /data/uploads/ 2>/dev/null || true'
```

### 5.3 Verify Upload Integrity
```bash
# Check file naming convention: {uuid}-full.jpg and {uuid}-thumb.jpg
docker compose -f docker-compose.prod.yml exec api \
  sh -c 'ls /data/uploads/ | head -10'
# Expected: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx-full.jpg

# Count files:
docker compose -f docker-compose.prod.yml exec api \
  sh -c 'ls /data/uploads/*.jpg 2>/dev/null | wc -l'

# Check for broken imageUrl references (files in DB but missing on disk):
docker compose -f docker-compose.prod.yml exec postgres psql -U wishlist -d wishlist -c "
  SELECT id, title, \"imageUrl\"
  FROM \"Item\"
  WHERE \"imageUrl\" IS NOT NULL AND status != 'DELETED'
  LIMIT 10;
"
# For each imageUrl, verify the file exists:
# imageUrl format: /api/uploads/{uuid}-full.jpg
# On disk: /data/uploads/{uuid}-full.jpg
```

### 5.4 Check for Orphaned Files
```bash
# Files on disk but not referenced in DB (accumulated over time):
docker compose -f docker-compose.prod.yml exec api \
  sh -c 'ls /data/uploads/*-full.jpg 2>/dev/null | wc -l'
# Compare with:
docker compose -f docker-compose.prod.yml exec postgres psql -U wishlist -d wishlist -c "
  SELECT COUNT(*) FROM \"Item\" WHERE \"imageUrl\" IS NOT NULL;
"
# If disk count >> DB count, orphaned files exist (low priority cleanup)
```

### 5.5 If No Backup (Images Lost)
Clear broken image references:
```bash
docker compose -f docker-compose.prod.yml exec postgres psql -U wishlist -d wishlist -c "
UPDATE \"Item\" SET \"imageUrl\" = NULL WHERE \"imageUrl\" IS NOT NULL;
"
```
Users will need to re-upload photos.

---

## ⚠️ Single Bot Polling Instance — MANDATORY

Telegram allows only **one** active long-poll consumer per bot token. Before
restoring service or starting a parallel test instance:

- Verify the production bot is the only one running for that token
- If bringing up a recovery server, **stop** the bot service on the old host
  first (or rotate the token in @BotFather)
- Symptom of duplicate pollers: the production bot drops `getUpdates` with
  HTTP 409 `Conflict` (visible in `apps/bot` logs)

```bash
docker compose -f docker-compose.prod.yml logs --tail 30 bot | grep -iE 'conflict|409|terminated|getUpdates'
```

---

## Phase 6: Smoke Tests (5 min)

### 6.1 API Health (shallow + deep)
```bash
curl -s https://wishlistik.ru/api/health
# Expected: {"ok":true}

curl -s https://wishlistik.ru/api/health/deep
# Expected: {"ok":true,"checks":{"db":"ok","bot":{"ok":true,"ageSec":<N>},"version":"..."}}
# Note: bot.ok may be false if bot hasn't sent its first heartbeat yet (wait ~60 s)
```

### 6.2 Web App
```bash
curl -s -o /dev/null -w "%{http_code}" https://wishlistik.ru/
# Expected: 200
```

### 6.3 Mini App Page
```bash
curl -s -o /dev/null -w "%{http_code}" https://wishlistik.ru/miniapp
# Expected: 200
```

### 6.4 Public API
```bash
# If there are wishlists in DB:
curl -s https://wishlistik.ru/api/public/wishlists/demo
```

### 6.5 Telegram Bot
- Open Telegram, find the bot
- Send /start
- Should reply with welcome message
- Check menu button opens Mini App

### 6.6 Full User Flow
1. Open bot -> tap menu button -> MiniApp opens
2. Create wishlist -> should succeed
3. Add item with photo -> should upload and display
4. Share wishlist -> get link
5. Open link from another Telegram account -> see guest view
6. Reserve item -> owner should get notification
7. Comment on item -> other party should get notification

---

## Phase 7: Verify Persistent Storage

### 7.1 Check Docker Volumes
```bash
docker volume ls | grep wishlist
# Should show:
# wishlist-prod_wishlist_pg_data
# wishlist-prod_wishlist_uploads
```

### 7.2 Verify Upload Persistence
```bash
# Upload a test photo, then:
docker exec wishlist-prod-api-1 ls -la /data/uploads/
# Should show .jpg files

# Restart API container:
docker compose -f docker-compose.prod.yml restart api

# Check files still there:
docker exec wishlist-prod-api-1 ls -la /data/uploads/
# Files should persist
```

---

## Backup Commands

The scheduled production backup on Vultr covers database, uploads, and `.env`
in one archive, then uploads the archive to Selectel/S3.

```bash
cd /opt/wishlist
/opt/wishlist/ops/backup.sh
ls -lht /opt/backups/wishlist/ | head
rclone ls wishlist-s3:wishlist-backups/ | tail -5
```


---

## Common Issues & Fixes

### API not starting
```bash
docker compose -f docker-compose.prod.yml logs --tail 30 api
# Check for: missing env vars, DB connection errors, migration failures
```

### Bot not responding
```bash
docker compose -f docker-compose.prod.yml logs --tail 20 bot
# Check BOT_TOKEN is correct
# Check bot isn't started elsewhere (only one polling instance allowed)
```

### Photos not loading
```bash
# Check upload directory exists and has files
docker compose -f docker-compose.prod.yml exec api ls -la /data/uploads/

# Check nginx proxies correctly
curl -I https://wishlistik.ru/api/uploads/test.jpg
# Should return 404 (not 502/503)
```

### Database connection refused
```bash
docker compose -f docker-compose.prod.yml ps
# Check postgres is "healthy"
# If not:
docker compose -f docker-compose.prod.yml restart postgres
# Wait for healthy, then restart api
docker compose -f docker-compose.prod.yml restart api
```

### SSL certificate expired
```bash
certbot renew
systemctl reload nginx
```

---

## Phase 8: Restore Verification

### 8.1 Validate SQL Dump Before Restore
```bash
# Check dump is valid SQL (not truncated/corrupted):
head -5 /tmp/backup.sql
# Should start with: -- PostgreSQL database dump

tail -3 /tmp/backup.sql
# Should end with: -- PostgreSQL database dump complete

# Check file size is reasonable:
ls -lh /tmp/backup.sql
# Should be > 0 bytes, consistent with expected data volume

# Count tables in dump:
grep -c "^CREATE TABLE" /tmp/backup.sql
# Expected: ~51 tables (schema has 51 models as of April 2026 + _prisma_migrations)
```

### 8.2 Verify DB Restore Integrity
```bash
# After restore, check table counts:
docker compose -f docker-compose.prod.yml exec postgres psql -U wishlist -d wishlist -c "
  SELECT 'Users' as tbl, COUNT(*) FROM \"User\"
  UNION ALL SELECT 'Wishlists', COUNT(*) FROM \"Wishlist\"
  UNION ALL SELECT 'Items', COUNT(*) FROM \"Item\"
  UNION ALL SELECT 'Comments', COUNT(*) FROM \"Comment\"
  UNION ALL SELECT 'ReservationEvents', COUNT(*) FROM \"ReservationEvent\";
"

# Check migrations are in sync:
docker compose -f docker-compose.prod.yml exec postgres psql -U wishlist -d wishlist -c "
  SELECT migration_name, finished_at FROM _prisma_migrations ORDER BY finished_at DESC LIMIT 5;
"
```

### 8.3 Verify Upload-to-DB Consistency
```bash
# Items with imageUrl that may have missing files:
docker compose -f docker-compose.prod.yml exec postgres psql -U wishlist -d wishlist -c "
  SELECT id, title, \"imageUrl\" FROM \"Item\"
  WHERE \"imageUrl\" IS NOT NULL AND status != 'DELETED';
" > /tmp/items_with_images.txt

# For each, extract filename and check existence:
docker compose -f docker-compose.prod.yml exec api sh -c '
  for f in /data/uploads/*-full.jpg; do
    basename "$f"
  done
' > /tmp/files_on_disk.txt

# Compare: any imageUrl referencing a missing file = broken link
```

### 8.4 Verify Telegram Bot After Recovery
```bash
# 1. Check bot is running:
docker compose -f docker-compose.prod.yml logs --tail 5 bot
# Should show: "[bot] started"

# 2. Send /start to bot in Telegram — should reply with welcome message

# 3. Check bot can reach API (internal network):
docker compose -f docker-compose.prod.yml exec bot \
  sh -c 'wget -qO- http://api:3001/health 2>/dev/null || echo "FAIL"'
# Expected: {"ok":true}

# 4. Verify menu button works:
# Open bot in Telegram → tap menu button → Mini App should open
```

---

## Phase 9: Business Smoke Tests by Role

### 9.1 Owner Flow
- [ ] Open @WishHub_bot → /start → menu button → Mini App opens
- [ ] Create wishlist → appears in list
- [ ] Add item (title + price + photo) → photo uploads, item appears
- [ ] Edit item description → saves
- [ ] Share wishlist → generates link with `share_` prefix
- [ ] Mark item «Получено» → moves to archive
- [ ] Restore from archive → back to active list
- [ ] Rename wishlist → title updates
- [ ] Delete item → disappears from list

### 9.2 Guest Flow (different Telegram account)
- [ ] Open shared link → bot shows «Смотреть вишлист» button
- [ ] Tap button → Mini App opens in guest mode
- [ ] See all items (photos visible)
- [ ] Reserve item → status changes to «Забронировано»
- [ ] Owner sees item as reserved (but NOT who reserved)
- [ ] Unreserve → status back to available

### 9.3 Reserver-Owner Comments
- [ ] Reserver writes comment on reserved item → appears in chat
- [ ] Owner receives Telegram notification with reserver's chosen display name
- [ ] Owner replies → reserver receives notification
- [ ] Third party (other guest) → cannot see comments (403)

### 9.4 Public Web Page
- [ ] Open `https://wishlistik.ru/w/{slug}` in browser → page renders with items
- [ ] Reserve via public page (no Telegram auth) → status changes

---

## Quick First-Aid Commands

```bash
# === STATUS ===
docker compose -f docker-compose.prod.yml ps             # Service status
curl -s https://wishlistik.ru/api/health                 # Shallow health
curl -s https://wishlistik.ru/api/health/deep | jq .     # Deep health (db + bot heartbeat)
echo | openssl s_client -servername wishlistik.ru -connect wishlistik.ru:443 2>/dev/null | openssl x509 -noout -enddate  # SSL expiry

# === MAINTENANCE MODE ===
# Enable:  edit /opt/wishlist/.env → MAINTENANCE_MODE=true → docker compose ... up -d api bot
# Disable: edit /opt/wishlist/.env → MAINTENANCE_MODE=false → docker compose ... up -d api bot

# === LOGS ===
docker compose -f docker-compose.prod.yml logs --tail 50 api    # API logs
docker compose -f docker-compose.prod.yml logs --tail 50 bot    # Bot logs
docker compose -f docker-compose.prod.yml logs --tail 50 web    # Web logs

# === RESTART ===
docker compose -f docker-compose.prod.yml restart api   # Restart API only
docker compose -f docker-compose.prod.yml restart bot   # Restart bot only
docker compose -f docker-compose.prod.yml up -d         # Start all
docker compose -f docker-compose.prod.yml down          # Stop all

# === DB ===
docker compose -f docker-compose.prod.yml exec postgres psql -U wishlist -d wishlist  # SQL shell

# === EMERGENCY BACKUP ===
/opt/wishlist/ops/backup.sh
```
