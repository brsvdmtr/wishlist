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
# mounted directory ADDITIVELY (cp -n = no-clobber). Old chunks from
# prior deploys stay on disk; new chunks land alongside them. Cached
# HTML's old chunk URLs keep resolving for as long as the host dir
# retains them (operator-driven prune — see ops/prune-web-chunks.sh).
#
# Safe to run when no volume is mounted: chunks-baked is still copied
# into the (empty, image-resident) chunks/ dir. The pre-mount image
# state is identical to the original "static/chunks already populated"
# layout.

set -e

CHUNKS_DIR=/app/apps/web/.next/static/chunks
BAKED_DIR=/app/apps/web/.next/static/chunks-baked

if [ -d "$BAKED_DIR" ]; then
  mkdir -p "$CHUNKS_DIR"
  # cp -rn: recurse, no-clobber. Preserves any chunks already in the
  # mounted volume from prior deploys. Stderr swallowed because cp -n
  # prints "not overwriting" warnings that are expected/benign here.
  cp -rn "$BAKED_DIR"/. "$CHUNKS_DIR"/ 2>/dev/null || true
fi

exec "$@"
