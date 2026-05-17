#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# Sync the on-prod nginx site config from the git-tracked template,
# validate, and reload nginx. Mirrors the pattern from setup-dns.sh.
#
# Background: ops/vultr/nginx-wishlistik.conf.template is the canonical
# server-block layout, but the deploy pipeline (.github/workflows/deploy.yml)
# only ever does `git pull + docker compose up` — it never touches nginx.
# So template edits in the repo go nowhere unless an operator copies the
# file to /etc/nginx/sites-available/ and reloads. This script makes that
# step explicit, idempotent, and safe (validates first, backs up on diff,
# falls back if reload fails).
#
# Usage:
#   sudo ops/vultr/setup-nginx.sh           # interactive (shows diff, asks)
#   sudo ops/vultr/setup-nginx.sh --apply   # non-interactive, applies if differs
#   sudo ops/vultr/setup-nginx.sh --check   # just diff, no changes
# ──────────────────────────────────────────────────────────────────────────────

PROJECT_DIR="${PROJECT_DIR:-/opt/wishlist}"
TEMPLATE="$PROJECT_DIR/ops/vultr/nginx-wishlistik.conf.template"
TARGET="/etc/nginx/sites-available/wishlistik.ru"

MODE="interactive"
for arg in "$@"; do
  case "$arg" in
    --apply) MODE="apply" ;;
    --check) MODE="check" ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root (use sudo)" >&2
  exit 1
fi

if [ ! -f "$TEMPLATE" ]; then
  echo "template not found: $TEMPLATE" >&2
  exit 1
fi

if [ ! -f "$TARGET" ]; then
  echo "target not found: $TARGET (this script only updates an existing install)" >&2
  exit 1
fi

if cmp -s "$TEMPLATE" "$TARGET"; then
  echo "$TARGET already matches template — nothing to do"
  exit 0
fi

echo "=== diff (template -> target) ==="
diff -u "$TARGET" "$TEMPLATE" || true
echo

if [ "$MODE" = "check" ]; then
  exit 0
fi

if [ "$MODE" = "interactive" ]; then
  read -r -p "Apply this diff to $TARGET and reload nginx? [y/N] " ans
  case "$ans" in
    y|Y|yes) ;;
    *) echo "aborted"; exit 0 ;;
  esac
fi

BACKUP="${TARGET}.bak-$(date -u +%Y%m%d-%H%M%S)"
echo "backing up $TARGET -> $BACKUP"
cp -p "$TARGET" "$BACKUP"

echo "writing template -> $TARGET"
cp -p "$TEMPLATE" "$TARGET"

if ! nginx -t; then
  echo "nginx -t FAILED — restoring backup" >&2
  cp -p "$BACKUP" "$TARGET"
  nginx -t || true
  exit 1
fi

echo "nginx -t passed; reloading"
nginx -s reload

echo
echo "=== sanity probe ==="
curl -fsS -o /dev/null -w "homepage %{http_code} %{time_total}s\n" https://wishlistik.ru/ \
  || echo "warn: homepage probe failed (this may be a TLS/cert issue, NOT a config syntax problem)" >&2
curl -fsS -o /dev/null -w "api/health %{http_code} %{time_total}s\n" https://wishlistik.ru/api/health \
  || echo "warn: api probe failed" >&2

echo
echo "done — backup at $BACKUP (delete after a few days of stable prod)"
