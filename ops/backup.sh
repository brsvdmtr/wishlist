#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# WishBoard daily backup
#
# What it does:
#   1. pg_dump (via postgres container)
#   2. tar uploads volume
#   3. copy .env
#   4. bundle everything into a single timestamped .tar.gz
#   5. generate sha256 checksum
#   6. (optional) upload via rclone to S3
#   7. cleanup local backups older than RETENTION_DAYS
#
# Cron: 0 3 * * * /opt/wishlist/ops/backup.sh >> /var/log/wishlist-backup.log 2>&1
# ──────────────────────────────────────────────────────────────────────────────

PROJECT_DIR="/opt/wishlist"
BACKUP_DIR="/opt/backups/wishlist"
RETENTION_DAYS=14
COMPOSE_FILE="$PROJECT_DIR/docker-compose.prod.yml"
UPLOADS_VOLUME="/var/lib/docker/volumes/wishlist-prod_wishlist_uploads/_data"
TIMESTAMP=$(date -u +%Y%m%d_%H%M%S)
WORK_DIR="$BACKUP_DIR/tmp_$TIMESTAMP"

# rclone remote name (configure with: rclone config)
# Uncomment when S3 is set up:
# RCLONE_REMOTE="wishlist-s3:wishlist-backups"

log() { echo "[backup] $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

log "Starting backup $TIMESTAMP"

mkdir -p "$WORK_DIR" "$BACKUP_DIR"

# ── 1. pg_dump ────────────────────────────────────────────────────────────────
log "Dumping PostgreSQL..."
docker compose -f "$COMPOSE_FILE" exec -T postgres \
  pg_dump -U wishlist -d wishlist --format=custom --clean \
  > "$WORK_DIR/db.dump"
DB_SIZE=$(du -sh "$WORK_DIR/db.dump" | cut -f1)
log "  db.dump: $DB_SIZE"

# ── 2. Uploads ────────────────────────────────────────────────────────────────
log "Archiving uploads..."
if [ -d "$UPLOADS_VOLUME" ]; then
  tar -cf "$WORK_DIR/uploads.tar" -C "$UPLOADS_VOLUME" . 2>/dev/null || true
  UP_SIZE=$(du -sh "$WORK_DIR/uploads.tar" 2>/dev/null | cut -f1)
  log "  uploads.tar: $UP_SIZE"
else
  log "  uploads volume not found, skipping"
fi

# ── 3. .env ───────────────────────────────────────────────────────────────────
log "Copying .env..."
cp "$PROJECT_DIR/.env" "$WORK_DIR/dot-env"

# ── 4. Bundle ─────────────────────────────────────────────────────────────────
ARCHIVE="$BACKUP_DIR/wishlist_${TIMESTAMP}.tar.gz"
log "Creating archive..."
tar -czf "$ARCHIVE" -C "$WORK_DIR" .
ARCHIVE_SIZE=$(du -sh "$ARCHIVE" | cut -f1)
log "  archive: $ARCHIVE ($ARCHIVE_SIZE)"

# ── 5. Checksum ───────────────────────────────────────────────────────────────
sha256sum "$ARCHIVE" > "$ARCHIVE.sha256"
log "  checksum: $(cat "$ARCHIVE.sha256")"

# ── 6. Upload to S3 (when configured) ────────────────────────────────────────
if [ -n "${RCLONE_REMOTE:-}" ] && command -v rclone &>/dev/null; then
  log "Uploading to $RCLONE_REMOTE ..."
  rclone copy "$ARCHIVE" "$RCLONE_REMOTE/" --progress
  rclone copy "$ARCHIVE.sha256" "$RCLONE_REMOTE/"
  log "  upload complete"
else
  log "  rclone not configured, keeping local only"
fi

# ── 7. Cleanup ────────────────────────────────────────────────────────────────
log "Cleaning up..."
rm -rf "$WORK_DIR"
find "$BACKUP_DIR" -name "wishlist_*.tar.gz" -mtime +"$RETENTION_DAYS" -delete 2>/dev/null
find "$BACKUP_DIR" -name "wishlist_*.tar.gz.sha256" -mtime +"$RETENTION_DAYS" -delete 2>/dev/null
REMAINING=$(ls -1 "$BACKUP_DIR"/wishlist_*.tar.gz 2>/dev/null | wc -l)
log "  local backups: $REMAINING"

log "Backup $TIMESTAMP complete"
