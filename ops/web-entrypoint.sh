#!/bin/sh
# Web container entrypoint.
#
# Why this exists: Next.js standalone builds removes old static chunks
# every rebuild. Telegram WebView caches HTML across sessions despite
# Cache-Control: no-store. After a deploy, users with stale HTML request
# chunk URLs the new image no longer has → 404 → ChunkLoadError → Mini
# App hangs on splash.
#
# Fix: mount a persistent host directory at
# /app/apps/web/.next/static/chunks (see docker-compose.prod.yml). This
# entrypoint copies the image-baked chunks ("chunks-baked/") into that
# mounted directory ADDITIVELY — old chunks from prior deploys stay on
# disk; new chunks land alongside them. Cached HTML's old chunk URLs
# keep resolving for as long as the host dir retains them
# (operator-driven prune — see ops/prune-web-chunks.sh).
#
# Safe to run when no volume is mounted: chunks-baked is still copied
# into the (empty, image-resident) chunks/ dir. The pre-mount image
# state is identical to the original "static/chunks already populated"
# layout.
#
# Why a find loop instead of `cp -rn`: BusyBox cp -rn (Alpine default)
# silently SKIPS recursion into a subdir that already exists at the
# destination. On a deploy where the volume already has chunks/<sub>/,
# cp -rn baked/. chunks/ leaves chunks/<sub>/ untouched and the new
# chunks living under baked/<sub>/ never make it onto disk. The bug is
# in BusyBox not in our script, but the fix is to not depend on it —
# walk every file individually and copy when missing.

set -e

CHUNKS_DIR=/app/apps/web/.next/static/chunks
BAKED_DIR=/app/apps/web/.next/static/chunks-baked
LOG_PREFIX="[web-entrypoint $(date -u +%FT%TZ)]"

if [ ! -d "$BAKED_DIR" ]; then
  echo "$LOG_PREFIX BAKED_DIR=$BAKED_DIR missing — skipping chunk merge" >&2
  exec "$@"
fi

mkdir -p "$CHUNKS_DIR"
COPIED=0
SKIPPED=0
FAILED=0

# Subshell so the `cd` doesn't leak. The find walks paths relative to
# BAKED_DIR so we can mirror them under CHUNKS_DIR directly.
cd "$BAKED_DIR"
find . -type f | while IFS= read -r REL; do
  DST="$CHUNKS_DIR/${REL#./}"
  if [ -e "$DST" ]; then
    SKIPPED=$((SKIPPED + 1))
  else
    DST_DIR=$(dirname "$DST")
    mkdir -p "$DST_DIR" 2>/dev/null || true
    if cp "$REL" "$DST" 2>/dev/null; then
      COPIED=$((COPIED + 1))
    else
      FAILED=$((FAILED + 1))
      echo "$LOG_PREFIX cp failed: $REL -> $DST" >&2
    fi
  fi
done

# Counter values inside `while | ` subshell don't leak in POSIX sh;
# we re-derive a summary after the loop by counting files.
TOTAL=$(find "$BAKED_DIR" -type f | wc -l | tr -d ' ')
PRESENT=$(find "$CHUNKS_DIR" -type f | wc -l | tr -d ' ')
echo "$LOG_PREFIX baked=$TOTAL chunks_dir_now=$PRESENT" >&2

cd /

exec "$@"
