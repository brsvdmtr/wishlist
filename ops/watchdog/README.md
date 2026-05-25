# Watchdog

Cron-driven health monitor for Wishlistik prod. Runs every 5 minutes on the
Vultr Amsterdam host, probes `https://wishlistik.ru/{,/api/health/deep,/api/tg/bootstrap}`,
and pushes Telegram alerts to `ADMIN_ALERT_CHAT_IDS` on state changes.

On recovery, also drains the Cloudflare maintenance worker's KV exposure
buffer (L1 users who hit the static stub while origin was unreachable) and
hands them to the API for recovery-notification fan-out. End-to-end picture
across L1/L2/L3 lives in [`docs/MAINTENANCE_FLOW.md`](../../docs/MAINTENANCE_FLOW.md).

## Files

| Path | Role |
|---|---|
| `run-health-watchdog.sh` | flock wrapper — what cron actually runs |
| `health-watchdog.mjs` | tick logic: probe, mutate state, send alerts, write incident rows |
| `state.mjs` | pure state machine + atomic-write persistence layer |
| `state.test.mjs` | node:test for everything in `state.mjs` |

## Cron

```cron
*/5 * * * * /opt/wishlist/ops/watchdog/run-health-watchdog.sh >> /var/log/watchdog.log 2>&1
```

(See `ops/cron/root.crontab` for the canonical copy.)

## Behavior

### Promotion to an incident — 2 consecutive DOWN ticks required

A single failed probe never raises an alert. The state machine needs
`PROMOTE_THRESHOLD` (= 2) consecutive DOWN ticks before it writes a
`MaintenanceIncident` row and sends `🔴 Wishlistik DOWN`. With a 5-minute
cron interval the alert latency floor is ~5 minutes and the worst case is
~10 minutes — designed to absorb a single DNS hiccup or one-off TCP retry.

### Recovery — 3 consecutive healthy ticks

After promotion, the watchdog keeps reading the state file as "I am in an
incident" until it sees `RECOVERY_THRESHOLD` (= 3) consecutive healthy
ticks. Then it:

1. Sends `🟢 Wishlistik RECOVERED`.
2. Marks every `active|recovering` `MaintenanceIncident` row as `recovered`.
3. **Drains the CF maintenance worker's KV exposure buffer** —
   `GET /__cf-maintenance-drain` (with `x-drain-secret`) → batched POST to
   `/api/internal/maintenance/ingest-buffered` → `DELETE /__cf-maintenance-drain`
   for the ack'd keys. Loops while `has_more=true` (capped at 10 batches ≈
   10k records per recovery cycle). Soft-fails if `CF_DRAIN_SECRET` is unset
   or the worker is unreachable — L2/L3 notifications still go out.
4. Calls `/api/internal/maintenance/send-recovery-notifications` to fan out
   push notifications to every affected user (now including L1 users that
   were just ingested from KV).

### Zero-exposure incident detector

Runs at the tail of every tick. Queries Postgres directly for any
`MaintenanceIncident` in `active`/`recovering` status, older than 15
minutes, with `COUNT(*) = 0` on `MaintenanceExposure` — that's the
signature of the 2026-05-17 RETURNING-parsing bug we just fixed. If a
match appears, the watchdog sends one Telegram alert per id and dedupes
in `state.zeroExposureAlertedIncidentIds` so it doesn't spam every 5
minutes. The dedup set is pruned automatically once an incident
recovers or gets its exposures back-filled.

### Bot heartbeat probe

Separate from the HTTP probe and from the incident state. Reads
`ServiceHeartbeat.updatedAt` for the `bot` service; if it's older than
5 minutes, alerts once and dedupes via `state.botWasStale` until it
recovers.

## State file

Default path: `/var/lib/wishlist/watchdog/state.json` (file 0600).

The state file lives in a **dedicated** subdir `/var/lib/wishlist/watchdog/`
which `ensureStateDir` keeps at mode 0700. We chose a dedicated subdir
specifically so that the 0700 enforcement does NOT bleed onto
`/var/lib/wishlist/` itself — that parent directory may eventually be
shared with other Wishlistik runtime files (uploads, future per-service
state) and shouldn't be made private by a single service's lifecycle.

`/tmp` was the original default and is wiped on boot, which lost dedup
across reboots. `/var/lib/wishlist/watchdog-state.json` (with the file
directly inside `/var/lib/wishlist/`) was the intermediate default —
abandoned because chmod 0700 would have applied to the shared parent.
The current path persists across reboot, deploy, and `docker compose up -d`.

A one-time legacy fallback reads either of these locations if the new
path is **missing entirely** (not just empty — `loadState` treats an
empty / corrupted file as "exists but unreadable" and falls through to
defaults + a `.corrupt-<ts>` backup, not to the legacy lookup):

  1. `/var/lib/wishlist/watchdog-state.json`
  2. `/tmp/watchdog-state.json`

The list is read in the order shown above (newest-first by deploy era).
The next `saveStateAtomic` writes to the new location and the fallback
never fires again. The legacy file is **not** deleted — operator can
inspect and `unlink` it manually after confirming the migration.

Note: if `WATCHDOG_STATE_FILE` is set explicitly in env, legacy fallback
is disabled — explicit path wins, period.

Writes are atomic: `state.mjs` writes a temp file in the same directory,
`fsync`s it, `rename`s over the target, then best-effort `fsync`s the
parent directory. A crash mid-write leaves either the old state or no
state — never a truncated JSON.

Reads are tolerant: missing file → defaults; invalid JSON → defaults,
the bad file is renamed to `<path>.corrupt-<ts>`, a warning hits stderr.

Override via `WATCHDOG_STATE_FILE`. Tests use a tmpdir.

## Concurrency

`run-health-watchdog.sh` acquires a non-blocking lock on
`/var/lock/wishlist-watchdog.lock` via `flock -n`. If the previous tick
is still running (e.g. SQL probe hung) the new tick logs a one-liner
and exits 0 immediately — no queueing, no false alerts.

Override via `WATCHDOG_LOCK_FILE`. The lock fd stays held by the Node
child via `exec`, so it releases when the Node process exits.

If `flock(1)` isn't on PATH, behavior depends on `WATCHDOG_REQUIRE_FLOCK`:
  - **default (`true`):** the wrapper refuses to run and exits 2 — the
    cron tick is skipped entirely rather than racing on the state file.
    This is the right behavior for prod, where overlapping ticks would
    silently corrupt the dedup state.
  - **opt-out (`WATCHDOG_REQUIRE_FLOCK=false`):** the wrapper logs a
    warning and runs unguarded. Use this on dev hosts and macOS boxes
    without `util-linux` installed. Only the literal string `false`
    opts out — typos like `0`, `no`, `False` are treated as `true`
    (fail-closed), to make the opt-out an explicit choice.

## Telegram delivery

`sendAlert` (`health-watchdog.mjs`):

- per-chat HTTP status check
- per-chat `body.ok === true` check
- logs `error_code` / `description` on rejection
- one retry on HTTP 429, capped by `parameters.retry_after`
- never throws — a broken alert channel must not crash the watchdog

## Running tests

```bash
pnpm test:ops
# or:
node --test ops/watchdog/state.test.mjs
```

30 tests cover state transitions, persistence (round-trip + corruption +
parent-dir creation + no temp-file leaks + loose-mode pre-existing dir),
zero-exposure dedup, and a source-grep contract that pins the default
state path to `/var/lib/wishlist/watchdog/state.json` and explicitly
forbids regressing it to the shared-parent form
`/var/lib/wishlist/watchdog-state.json` (any other regression — e.g.
back to `/tmp` — would fail the positive assertion as well). No
external dependencies — pure `node:test`.

## Env vars

| Variable | Default | Purpose |
|---|---|---|
| `WATCHDOG_BASE_URL` | (required) | e.g. `https://wishlistik.ru` |
| `BOT_TOKEN` | (required for alerts) | Telegram bot token + `X-INTERNAL-KEY` |
| `ADMIN_ALERT_CHAT_IDS` | (empty = skip alerts) | comma-separated chat IDs |
| `WATCHDOG_STATE_FILE` | `/var/lib/wishlist/watchdog/state.json` | override for tests; setting this disables legacy-path fallback |
| `WATCHDOG_TIMEOUT_MS` | `15000` | HTTP probe timeout |
| `WATCHDOG_LOCK_FILE` | `/var/lock/wishlist-watchdog.lock` | flock target |
| `WATCHDOG_REQUIRE_FLOCK` | `true` | fail-closed (exit 2) if `flock(1)` is unavailable; set literal `false` to opt out on dev/macOS without util-linux |
| `WATCHDOG_NODE_BIN` | `node` | wrapper's Node executable (testing) |
| `MAINTENANCE_MODE` | `false` | when `true`, suppresses ALL alerts |
| `CF_DRAIN_SECRET` | (empty = skip drain) | shared secret with the CF maintenance worker; mirror of `wrangler secret put CF_DRAIN_SECRET`. Required for L1 recovery notifications |

## Known follow-ups (NOT covered by this hardening)

- **Recovery UPDATE is incident-id-agnostic.** When the watchdog flips an
  incident to `recovered`, the SQL is `UPDATE "MaintenanceIncident" SET
  status='recovered', ... WHERE status IN ('active','recovering')` — every
  open incident, not just the one this watchdog promoted. If a second
  unrelated incident exists at that moment, it also flips. Pre-existing
  behavior from before this PR; not addressed here.
- **SIGKILL race** between `sendAlert` and `saveStateAtomic` after a
  promote. The alert may go out and the `incidentId` get lost from state if
  the process is killed mid-write. Pre-existing. Recovery still works (the
  WHERE clause above doesn't depend on `incidentId`).
- **State-file `flock`** is at the wrapper level, not at the state-file
  level. A non-cron invocation (e.g. operator running the script by hand
  while cron is also firing) could race. Operationally we don't run it by
  hand.

## Related

- DNS hardening: `sudo ops/vultr/setup-dns.sh --check` (cron-friendly drift
  check). Must run as root — the expected `resolvconf` head file is
  typically root-readable only, so a non-root `--check` will look like
  drift even when none exists. The script prints a WARNING in that case.
- nginx hardening: `sudo ops/vultr/setup-nginx.sh --check` (same — must
  read `/etc/nginx/sites-available/...` which is usually root-only).
- Incident write-up: `docs/BUGFIX_LESSONS.md` 2026-05-17 entry
