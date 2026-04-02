# Disaster Recovery Runbook

> Last updated: 2026-04-02

## Backup Overview

| What | Where | Retention | Schedule |
|------|-------|-----------|----------|
| pg_dump (custom format) | `/opt/backups/wishlist/` | 14 days local | Daily 03:00 UTC |
| uploads archive | same archive | same | same |
| .env snapshot | same archive | same | same |
| S3 copy | `RCLONE_REMOTE` (when configured) | 30 days remote | same |

Archive format: `wishlist_YYYYMMDD_HHMMSS.tar.gz` + `.sha256` checksum.

---

## Scenario 1: Restore Database Only

When the database is corrupted but the server is alive.

```bash
cd /opt/wishlist

# 1. Find the backup
ls -lht /opt/backups/wishlist/

# 2. Verify checksum
cd /opt/backups/wishlist
sha256sum -c wishlist_YYYYMMDD_HHMMSS.tar.gz.sha256

# 3. Extract
mkdir /tmp/restore && tar -xzf wishlist_YYYYMMDD_HHMMSS.tar.gz -C /tmp/restore

# 4. Copy dump into postgres container
docker cp /tmp/restore/db.dump wishlist-prod-postgres-1:/tmp/db.dump

# 5. Enable maintenance mode
cd /opt/wishlist && ./ops/maintenance/on.sh

# 6. Restore (overwrites current data!)
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U wishlist -d wishlist --clean --if-exists /tmp/db.dump

# 7. Restart API to reconnect
docker compose -f docker-compose.prod.yml restart api bot

# 8. Health check
curl https://wishlistik.ru/api/health/deep

# 9. Disable maintenance
./ops/maintenance/off.sh

# 10. Cleanup
docker compose -f docker-compose.prod.yml exec -T postgres rm /tmp/db.dump
rm -rf /tmp/restore
```

---

## Scenario 2: Restore Uploads Only

When images are lost but server is alive.

```bash
# 1. Extract backup
mkdir /tmp/restore && tar -xzf /opt/backups/wishlist/wishlist_YYYYMMDD_HHMMSS.tar.gz -C /tmp/restore

# 2. Find uploads volume path
UPLOADS_VOL=$(docker volume inspect wishlist-prod_wishlist_uploads -f '{{.Mountpoint}}')

# 3. Restore (overwrites!)
tar -xf /tmp/restore/uploads.tar -C "$UPLOADS_VOL"

# 4. Fix permissions
chown -R 1001:1001 "$UPLOADS_VOL"

# 5. Cleanup
rm -rf /tmp/restore
```

---

## Scenario 3: Full Server Recovery (VPS died)

Complete recovery from scratch on a new server.

### Prerequisites
- New VPS with Debian 12 or Ubuntu 22+
- Docker + Docker Compose installed
- Backup archive (from S3 or local copy)
- Domain DNS pointed to new IP

### Steps

```bash
# 1. Install Docker
curl -fsSL https://get.docker.com | sh

# 2. Clone repo
git clone https://github.com/brsvdmtr/wishlist.git /opt/wishlist
cd /opt/wishlist

# 3. Extract backup
mkdir /tmp/restore
tar -xzf wishlist_YYYYMMDD_HHMMSS.tar.gz -C /tmp/restore

# 4. Restore .env
cp /tmp/restore/dot-env /opt/wishlist/.env
# CRITICAL: verify DATABASE_URL, BOT_TOKEN, ADMIN_KEY, POSTGRES_PASSWORD are present
cat .env | grep -E 'DATABASE_URL|BOT_TOKEN|ADMIN_KEY|POSTGRES_'

# 5. Start postgres first
docker compose -f docker-compose.prod.yml up -d postgres
sleep 10  # wait for it to initialize

# 6. Restore database
docker cp /tmp/restore/db.dump wishlist-prod-postgres-1:/tmp/db.dump
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_restore -U wishlist -d wishlist --clean --if-exists /tmp/db.dump
docker compose -f docker-compose.prod.yml exec -T postgres rm /tmp/db.dump

# 7. Start all services
docker compose -f docker-compose.prod.yml up -d

# 8. Restore uploads
UPLOADS_VOL=$(docker volume inspect wishlist-prod_wishlist_uploads -f '{{.Mountpoint}}')
tar -xf /tmp/restore/uploads.tar -C "$UPLOADS_VOL"
chown -R 1001:1001 "$UPLOADS_VOL"

# 9. Configure nginx (copy from docs/INFRA_AND_ENV.md)
# 10. Set up SSL with certbot
# 11. Set up cron jobs (see DEPLOYMENT_RUNBOOK.md)
# 12. Verify
curl https://wishlistik.ru/api/health/deep
```

### If backup is on S3

```bash
# Download latest backup from S3
rclone config  # set up remote first
rclone ls wishlist-s3:wishlist-backups/ | tail -2  # find latest
rclone copy wishlist-s3:wishlist-backups/wishlist_YYYYMMDD_HHMMSS.tar.gz /tmp/
rclone copy wishlist-s3:wishlist-backups/wishlist_YYYYMMDD_HHMMSS.tar.gz.sha256 /tmp/

# Verify
cd /tmp && sha256sum -c wishlist_YYYYMMDD_HHMMSS.tar.gz.sha256

# Then follow Scenario 3 steps from step 3
```

---

## S3 Backup Setup

### Configure rclone

```bash
rclone config
# Choose: n (new remote)
# Name: wishlist-s3
# Type: s3
# Provider: (your provider — Timeweb, Yandex Cloud, etc.)
# Access key: (from provider dashboard)
# Secret key: (from provider dashboard)
# Endpoint: (provider-specific, e.g., s3.timeweb.cloud)
# Region: (provider-specific)
```

### Enable in backup script

Add to `/opt/wishlist/.env`:
```
RCLONE_REMOTE=wishlist-s3:wishlist-backups
```

### Test upload

```bash
# Source env
source /opt/wishlist/.env

# Run backup manually
/opt/wishlist/ops/backup.sh

# Verify remote
rclone ls wishlist-s3:wishlist-backups/
```

### Verify cron

```bash
# Check that cron loads .env (or set RCLONE_REMOTE in crontab)
crontab -l
# Should show:
# 0 3 * * * RCLONE_REMOTE=wishlist-s3:wishlist-backups /opt/wishlist/ops/backup.sh >> /var/log/wishlist-backup.log 2>&1
```

---

## Restore Drill Verification (2026-04-02)

Performed full restore drill. Results:

| Check | Result |
|-------|--------|
| sha256 checksum | ✓ valid |
| pg_restore into test DB | ✓ 52 tables |
| Users count | 327 = 327 ✓ |
| Wishlists count | 132 = 132 ✓ |
| Items count | 164 = 164 ✓ |
| Analytics events | 563 vs 581 (18 new since backup) ✓ |
| Subscriptions | 3 = 3 ✓ |
| uploads.tar readable | ✓ |
| .env readable, critical vars present | ✓ |

**Verdict**: Backup is fully restorable. Recovery procedure verified.
