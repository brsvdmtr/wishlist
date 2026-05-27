#!/bin/sh
# Operator-driven prune for the web-chunks persistent volume.
#
# Why this exists: `docker-compose.prod.yml` mounts /opt/wishlist/web-chunks
# at /app/apps/web/.next/static/chunks so legacy chunk URLs from cached HTML
# keep resolving after deploys (see ops/web-entrypoint.sh and
# docs/BUGFIX_LESSONS.md 2026-05-27). The directory grows by one chunk-set
# per code deploy that touches apps/web/ — ~3 MB per deploy. After ~30 days
# of typical activity it's still under 200 MB, but mobile WebViews don't
# hold cached HTML forever; chunks older than ~90 days are almost certainly
# unreferenced.
#
# Usage (run on prod host):
#   /opt/wishlist/ops/prune-web-chunks.sh [retention_days]
#
# Default retention is 90 days. Pass a smaller number to be more aggressive
# (e.g. `15` after a multi-week incident-investigation period).
#
# Recommended cron (root crontab):
#   0 4 * * 0 /opt/wishlist/ops/prune-web-chunks.sh >> /var/log/wishlist-prune.log 2>&1

set -e

CHUNKS_DIR=/opt/wishlist/web-chunks
RETENTION_DAYS="${1:-90}"

if [ ! -d "$CHUNKS_DIR" ]; then
  echo "[prune-web-chunks] $CHUNKS_DIR does not exist — nothing to prune"
  exit 0
fi

BEFORE=$(find "$CHUNKS_DIR" -type f | wc -l | tr -d ' ')
SIZE_BEFORE=$(du -sh "$CHUNKS_DIR" | awk '{print $1}')

echo "[prune-web-chunks] $(date -Iseconds) — before: $BEFORE files, $SIZE_BEFORE; retention: ${RETENTION_DAYS} days"

# Delete files older than retention_days. Directory mtimes are left
# alone so empty intermediate dirs survive — chunk URLs include subdirs
# like app/miniapp/, and an empty parent dir is harmless. -mtime is
# based on file mtime; cp -n in the entrypoint preserves the source
# mtime, which is the original build time of the chunk.
find "$CHUNKS_DIR" -type f -mtime +"$RETENTION_DAYS" -delete

AFTER=$(find "$CHUNKS_DIR" -type f | wc -l | tr -d ' ')
SIZE_AFTER=$(du -sh "$CHUNKS_DIR" | awk '{print $1}')
DELETED=$((BEFORE - AFTER))

echo "[prune-web-chunks] $(date -Iseconds) — after: $AFTER files, $SIZE_AFTER; deleted: $DELETED"
