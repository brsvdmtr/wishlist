#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# Override DNS resolver order on Vultr Amsterdam prod host.
#
# Background: cloud-init on Vultr writes
# /etc/network/interfaces.d/50-cloud-init with `dns-nameservers
# 108.61.10.10 ...` which makes Vultr's recursive resolver the first
# nameserver in /etc/resolv.conf. On 2026-05-17 ~02:25 UTC that resolver
# was timing out ~5s for ~50% of queries, eating the watchdog's 8s HTTP
# probe budget and triggering a false Wishlistik-DOWN alert even though
# the app was healthy. The DNS-side fix is to put Quad9 + Cloudflare in
# front via /etc/resolvconf/resolv.conf.d/head and switch /etc/resolv.conf
# to a symlink onto the resolvconf-generated file so the override persists
# across reboots (cloud-init keeps appending Vultr DNS, but it lands AFTER
# our overrides).
#
# Idempotent: safe to re-run. Leaves a one-off backup of the prior file.
# ──────────────────────────────────────────────────────────────────────────────

HEAD_FILE="/etc/resolvconf/resolv.conf.d/head"
TARGET_LINK="/etc/resolv.conf"
RUNTIME_FILE="/run/resolvconf/resolv.conf"

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root (use sudo)" >&2
  exit 1
fi

if ! command -v resolvconf >/dev/null 2>&1; then
  echo "resolvconf not installed; aborting (this script assumes resolvconf-based DNS management)" >&2
  exit 1
fi

WANT_HEAD=$(cat <<'EOF'
# Override added 2026-05-17 after Vultr DNS 108.61.10.10 flap incident (~02:25 UTC)
# Quad9 + Cloudflare go first, Vultr stays as fallback via dns-nameservers in
# /etc/network/interfaces.d/50-cloud-init. To revert, blank this file and run
# sudo resolvconf -u.
nameserver 9.9.9.9
nameserver 1.1.1.1
EOF
)

CURRENT_HEAD=""
[ -f "$HEAD_FILE" ] && CURRENT_HEAD=$(cat "$HEAD_FILE")

if [ "$CURRENT_HEAD" != "$WANT_HEAD" ]; then
  echo "writing $HEAD_FILE"
  printf '%s\n' "$WANT_HEAD" > "$HEAD_FILE"
  resolvconf -u
else
  echo "$HEAD_FILE already up to date"
fi

if [ ! -L "$TARGET_LINK" ] || [ "$(readlink "$TARGET_LINK")" != "$RUNTIME_FILE" ]; then
  # Guard against a broken resolvconf install — without the runtime file
  # the symlink would dangle and the sanity probe below would fail.
  if [ ! -f "$RUNTIME_FILE" ]; then
    echo "runtime file $RUNTIME_FILE does not exist after resolvconf -u; aborting before we break /etc/resolv.conf" >&2
    exit 1
  fi
  echo "switching $TARGET_LINK to symlink -> $RUNTIME_FILE"
  # Don't silence cp failures — we want to know about readonly /etc, EROFS,
  # etc., even though we still continue to the symlink swap.
  cp -a "$TARGET_LINK" "${TARGET_LINK}.bak-$(date -u +%Y%m%d-%H%M%S)" \
    || echo "warn: failed to back up $TARGET_LINK (continuing anyway)" >&2
  ln -sf "$RUNTIME_FILE" "$TARGET_LINK"
else
  echo "$TARGET_LINK already symlinked to $RUNTIME_FILE"
fi

echo
echo "=== current /etc/resolv.conf ==="
cat "$TARGET_LINK"

echo
echo "=== sanity probe (host wishlistik.ru, 3x) ==="
for _ in 1 2 3; do
  /usr/bin/time -f 'wall=%es' host wishlistik.ru 2>&1 | tail -2
done
