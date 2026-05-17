#!/usr/bin/env bash
set -euo pipefail

# ──────────────────────────────────────────────────────────────────────────────
# run-health-watchdog.sh — flock wrapper around health-watchdog.mjs.
#
# Why: a watchdog tick that takes longer than the cron interval (e.g. SQL
# probe hung, DNS slow) would race with the next tick. Both would read+
# mutate the same state file without coordination. flock(1) makes the
# second tick exit cleanly instead.
#
# Behavior:
#   • Non-blocking: if the lock is held, exit 0 immediately with a log
#     line. We do NOT want the second cron run to queue up — it would
#     just stack pressure and still race on next-but-one tick.
#   • Lockfile lives in /var/lock (tmpfs on most systems, fine for a per-
#     boot mutex). Override via WATCHDOG_LOCK_FILE.
#   • Logs go to the same place the underlying script logs to — caller
#     redirects, this wrapper just chains stdout/stderr through.
#
# Crontab line (see ops/cron/root.crontab):
#   star/5 * * * * /opt/wishlist/ops/watchdog/run-health-watchdog.sh \
#       >> /var/log/watchdog.log 2>&1
# ──────────────────────────────────────────────────────────────────────────────

LOCK_FILE="${WATCHDOG_LOCK_FILE:-/var/lock/wishlist-watchdog.lock}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_BIN="${WATCHDOG_NODE_BIN:-node}"
# Default is FAIL-CLOSED: if flock(1) is missing on this host, the wrapper
# refuses to run rather than silently degrading to an unguarded execution.
# This is the right default for prod — overlapping cron ticks would race on
# the state file. To explicitly opt out (dev box without util-linux, macOS
# without `brew install util-linux`, ad-hoc test runs), export
# WATCHDOG_REQUIRE_FLOCK=false BEFORE invoking the wrapper.
REQUIRE_FLOCK="${WATCHDOG_REQUIRE_FLOCK:-true}"

if ! command -v flock >/dev/null 2>&1; then
  if [ "$REQUIRE_FLOCK" != "false" ]; then
    echo "[wrapper] flock(1) not found and WATCHDOG_REQUIRE_FLOCK is not 'false'; refusing to run unguarded." >&2
    echo "[wrapper] On dev hosts without flock, run with WATCHDOG_REQUIRE_FLOCK=false." >&2
    exit 2
  fi
  echo "[wrapper] flock(1) not found; WATCHDOG_REQUIRE_FLOCK=false → running unguarded (dev/CI mode)" >&2
  exec "$NODE_BIN" "$SCRIPT_DIR/health-watchdog.mjs"
fi

# Ensure the lock-file parent dir exists. /var/lock is standard but in
# rootless containers / oddball distros it can be absent.
LOCK_DIR="$(dirname "$LOCK_FILE")"
mkdir -p "$LOCK_DIR"

# Acquire fd 9 on the lock file. -n = non-blocking; if held, flock exits
# with status 1. We catch that and turn it into a clean exit 0 with a log
# line — the running tick still owns the work.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[wrapper] $(date -u '+%Y-%m-%dT%H:%M:%SZ') previous watchdog tick still running; skipping (lock=$LOCK_FILE)"
  exit 0
fi

# At this point we own the lock. `exec` replaces the shell so the lock fd
# stays open through the Node process and is released when Node exits
# (kernel closes the fd on process exit). The trap is belt-and-braces in
# case `exec` itself fails.
trap 'rc=$?; flock -u 9 || true; exit $rc' EXIT
exec "$NODE_BIN" "$SCRIPT_DIR/health-watchdog.mjs"
