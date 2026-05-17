#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# Override DNS resolver order on the Vultr prod host.
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
# Usage:
#   sudo ops/vultr/setup-dns.sh             # interactive (shows drift, asks)
#   sudo ops/vultr/setup-dns.sh --apply     # non-interactive: apply if drifted
#   sudo ops/vultr/setup-dns.sh --check     # report drift only, exit non-zero
#                                             if anything is wrong (cron/admin
#                                             alert friendly).
#
# IMPORTANT: --check MUST also be run as root (or with sudo). The expected
# HEAD file at /etc/resolvconf/resolv.conf.d/head is typically root-readable
# only, so a non-root --check will report "HEAD_FILE is missing" or "content
# does not match" as DRIFT — but it's a permission failure, not real drift.
# When in doubt, re-run under sudo.
#
# Idempotent: safe to re-run. Backups the prior /etc/resolv.conf once on
# first apply.
# ──────────────────────────────────────────────────────────────────────────────

HEAD_FILE="/etc/resolvconf/resolv.conf.d/head"
TARGET_LINK="/etc/resolv.conf"
RUNTIME_FILE="/run/resolvconf/resolv.conf"

# Resolvers we want at the front, IN ORDER. Vultr resolver is intentionally
# absent here — it stays in /etc/network/interfaces.d/50-cloud-init as a
# distant fallback, but never as #1.
WANT_HEAD_RESOLVERS=(9.9.9.9 1.1.1.1)
# Resolver to ban from the front of the list. Drift-check fails if this IP
# appears before WANT_HEAD_RESOLVERS in /etc/resolv.conf.
VULTR_RESOLVER="108.61.10.10"

MODE="interactive"
for arg in "$@"; do
  case "$arg" in
    --apply) MODE="apply" ;;
    --check) MODE="check" ;;
    -h|--help)
      sed -n '4,30p' "$0"
      exit 0
      ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# ─── Build expected HEAD_FILE content ────────────────────────────────────────

build_want_head() {
  cat <<EOF
# Override added 2026-05-17 after Vultr DNS 108.61.10.10 flap incident (~02:25 UTC)
# Quad9 + Cloudflare go first, Vultr stays as fallback via dns-nameservers in
# /etc/network/interfaces.d/50-cloud-init. To revert, blank this file and run
# sudo resolvconf -u.
EOF
  for r in "${WANT_HEAD_RESOLVERS[@]}"; do
    echo "nameserver $r"
  done
}

WANT_HEAD="$(build_want_head)"

# ─── Drift check (used by both --check and --apply) ──────────────────────────

# Returns 0 if no drift, non-zero (and prints reasons) otherwise. Pure read.
check_drift() {
  local drift=0

  if ! command -v resolvconf >/dev/null 2>&1; then
    echo "FAIL: resolvconf is not installed (this script assumes resolvconf-managed DNS)"
    return 1
  fi

  if [ ! -f "$HEAD_FILE" ]; then
    echo "FAIL: $HEAD_FILE is missing"
    drift=1
  else
    local current_head
    current_head="$(cat "$HEAD_FILE")"
    if [ "$current_head" != "$WANT_HEAD" ]; then
      echo "FAIL: $HEAD_FILE content does not match expected"
      drift=1
    else
      echo "ok: $HEAD_FILE matches expected ($(printf '%s ' "${WANT_HEAD_RESOLVERS[@]}")first)"
    fi
  fi

  if [ ! -L "$TARGET_LINK" ]; then
    echo "FAIL: $TARGET_LINK is not a symlink (so resolvconf changes won't take effect)"
    drift=1
  else
    local target
    target="$(readlink "$TARGET_LINK")"
    if [ "$target" != "$RUNTIME_FILE" ]; then
      echo "FAIL: $TARGET_LINK -> $target (expected $RUNTIME_FILE)"
      drift=1
    else
      echo "ok: $TARGET_LINK -> $RUNTIME_FILE"
    fi
  fi

  # Verify resolver order in the live file. Find the line numbers of each
  # nameserver we care about; bail if our resolvers don't precede Vultr's.
  if [ -e "$TARGET_LINK" ]; then
    local first_want_line vultr_line
    first_want_line=""
    for r in "${WANT_HEAD_RESOLVERS[@]}"; do
      local line
      line=$(grep -nE "^[[:space:]]*nameserver[[:space:]]+${r//./\\.}([[:space:]]|$)" "$TARGET_LINK" | head -1 | cut -d: -f1 || true)
      if [ -z "$line" ]; then
        echo "FAIL: $r is not in $TARGET_LINK"
        drift=1
      elif [ -z "$first_want_line" ] || [ "$line" -lt "$first_want_line" ]; then
        first_want_line="$line"
      fi
    done
    vultr_line=$(grep -nE "^[[:space:]]*nameserver[[:space:]]+${VULTR_RESOLVER//./\\.}([[:space:]]|$)" "$TARGET_LINK" | head -1 | cut -d: -f1 || true)
    if [ -n "$first_want_line" ] && [ -n "$vultr_line" ]; then
      if [ "$first_want_line" -ge "$vultr_line" ]; then
        echo "FAIL: $VULTR_RESOLVER appears at line $vultr_line, before our preferred resolvers (first at $first_want_line)"
        drift=1
      else
        echo "ok: our resolvers (line $first_want_line) precede $VULTR_RESOLVER (line $vultr_line) in $TARGET_LINK"
      fi
    fi
  fi

  return $drift
}

# ─── --check mode ────────────────────────────────────────────────────────────

if [ "$MODE" = "check" ]; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "WARNING: --check is running as non-root (uid=$(id -u))." >&2
    echo "WARNING: /etc/resolvconf/resolv.conf.d/head is typically root-only;" >&2
    echo "WARNING: a 'FAIL: $HEAD_FILE is missing' or 'content does not match'" >&2
    echo "WARNING: result MAY be a permission failure, not actual drift." >&2
    echo "WARNING: re-run with sudo to confirm." >&2
    echo >&2
  fi
  echo "=== drift check ==="
  if check_drift; then
    echo "no drift — DNS configuration matches expected"
    exit 0
  else
    echo "drift detected — re-run as 'sudo $0 --apply' to fix" >&2
    exit 1
  fi
fi

# ─── --apply / interactive ───────────────────────────────────────────────────

if [ "$(id -u)" -ne 0 ]; then
  echo "must run as root (use sudo)" >&2
  exit 1
fi

if ! command -v resolvconf >/dev/null 2>&1; then
  echo "resolvconf not installed; aborting (this script assumes resolvconf-based DNS management)" >&2
  exit 1
fi

echo "=== drift check before apply ==="
if check_drift; then
  echo "nothing to do — DNS is already in the desired state"
  exit 0
fi

if [ "$MODE" = "interactive" ]; then
  read -r -p "Apply DNS resolver override (Quad9 + Cloudflare first)? [y/N] " ans
  case "$ans" in
    y|Y|yes) ;;
    *) echo "aborted"; exit 0 ;;
  esac
fi

# ─── Mutate HEAD_FILE ────────────────────────────────────────────────────────

CURRENT_HEAD=""
[ -f "$HEAD_FILE" ] && CURRENT_HEAD=$(cat "$HEAD_FILE")
if [ "$CURRENT_HEAD" != "$WANT_HEAD" ]; then
  echo "writing $HEAD_FILE"
  printf '%s\n' "$WANT_HEAD" > "$HEAD_FILE"
  resolvconf -u
else
  echo "$HEAD_FILE already up to date"
fi

# ─── Swap /etc/resolv.conf to symlink → runtime file ────────────────────────

if [ ! -L "$TARGET_LINK" ] || [ "$(readlink "$TARGET_LINK")" != "$RUNTIME_FILE" ]; then
  if [ ! -f "$RUNTIME_FILE" ]; then
    echo "runtime file $RUNTIME_FILE does not exist after resolvconf -u; aborting before we break /etc/resolv.conf" >&2
    exit 1
  fi
  echo "switching $TARGET_LINK to symlink -> $RUNTIME_FILE"
  cp -a "$TARGET_LINK" "${TARGET_LINK}.bak-$(date -u +%Y%m%d-%H%M%S)" \
    || echo "warn: failed to back up $TARGET_LINK (continuing anyway)" >&2
  ln -sf "$RUNTIME_FILE" "$TARGET_LINK"
else
  echo "$TARGET_LINK already symlinked to $RUNTIME_FILE"
fi

# ─── Verify + sanity probe ───────────────────────────────────────────────────

echo
echo "=== current /etc/resolv.conf ==="
cat "$TARGET_LINK"

echo
echo "=== post-apply drift check ==="
if ! check_drift; then
  echo "post-apply drift check still failing — please investigate" >&2
  exit 1
fi

echo
echo "=== sanity probe (host wishlistik.ru, 3x; failures non-fatal) ==="
# `|| true` so the script always exits 0 on successful config change even if
# the resolver is briefly flapping mid-test — the operator should look at the
# numbers themselves.
for _ in 1 2 3; do
  /usr/bin/time -f 'wall=%es' host wishlistik.ru 2>&1 | tail -2 || true
done
