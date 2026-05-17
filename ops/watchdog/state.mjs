// ops/watchdog/state.mjs — pure state machine + hardened I/O for the watchdog.
//
// Pure transition functions live here so they can be tested without spinning
// up Postgres, fetching anything, or hitting Telegram. health-watchdog.mjs
// imports these and supplies the I/O side (HTTP probes, SQL, alerts).
//
// Persistence helpers (loadState / saveStateAtomic) are also exported here so
// the on-disk format is described in exactly one place.
//
// Invariants the rest of the code relies on:
//   • loadState NEVER throws. Missing/corrupted file → safe defaults + a
//     warning on stderr (+ best-effort .corrupt-<ts> backup of the bad file).
//   • saveStateAtomic writes a temp file in the same directory, fsyncs it,
//     and renames over the target. A crash mid-write leaves either the old
//     file or no file at all, but never a truncated JSON.
//   • Pre-promotion counter (consecutiveDownChecks) only moves while
//     wasDown=false. Once promoted, it resets to 0 and stays there until the
//     incident recovers; growth past recovery is governed by
//     consecutiveHealthyChecks alone.

import fs from 'node:fs';
import path from 'node:path';

// ─── Constants ───────────────────────────────────────────────────────────────

export const PROMOTE_THRESHOLD = 2;       // consecutive DOWN ticks before alert
export const RECOVERY_THRESHOLD = 3;      // consecutive healthy ticks before RECOVERED
export const ZERO_EXPOSURE_MIN_AGE_MS = 15 * 60 * 1000; // 15 minutes

// ─── Schema ──────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} WatchdogState
 * @property {boolean}  wasDown                       — incident currently promoted
 * @property {string|null} downSince                  — ISO timestamp of incident start
 * @property {number}   consecutiveDownChecks         — DOWN ticks seen pre-promotion
 * @property {number}   consecutiveHealthyChecks      — healthy ticks since DOWN
 * @property {string|null} firstDownSince             — ISO of first DOWN in current suspicion window
 * @property {boolean}  botWasStale                   — bot heartbeat alert sent
 * @property {string|null} botStaleSince              — ISO of first bot-stale observation
 * @property {string|null} incidentId                 — last MaintenanceIncident id created by us
 * @property {string[]} zeroExposureAlertedIncidentIds — incidents we've already alerted on for zero exposures
 */

/** @returns {WatchdogState} */
export function defaultState() {
  return {
    wasDown: false,
    downSince: null,
    consecutiveDownChecks: 0,
    consecutiveHealthyChecks: 0,
    firstDownSince: null,
    botWasStale: false,
    botStaleSince: null,
    incidentId: null,
    zeroExposureAlertedIncidentIds: [],
  };
}

/**
 * Merge a loaded state with defaults, preserving any legacy fields the new
 * code doesn't read (so a downgrade-then-upgrade cycle doesn't lose data).
 * Tolerates missing fields, but does NOT coerce wrong types — that would
 * hide real corruption.
 *
 * @param {unknown} raw
 * @returns {WatchdogState}
 */
export function mergeWithDefaults(raw) {
  const base = defaultState();
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const merged = { ...base, ...raw };
  // Defensive: a hand-edited or partially-truncated file can have explicit
  // null where we expect a number/array. Coerce only the structurally-load-
  // bearing fields back to safe types.
  if (typeof merged.consecutiveDownChecks !== 'number' || !Number.isFinite(merged.consecutiveDownChecks)) {
    merged.consecutiveDownChecks = 0;
  }
  if (typeof merged.consecutiveHealthyChecks !== 'number' || !Number.isFinite(merged.consecutiveHealthyChecks)) {
    merged.consecutiveHealthyChecks = 0;
  }
  if (!Array.isArray(merged.zeroExposureAlertedIncidentIds)) {
    merged.zeroExposureAlertedIncidentIds = [];
  }
  if (typeof merged.wasDown !== 'boolean') merged.wasDown = false;
  if (typeof merged.botWasStale !== 'boolean') merged.botWasStale = false;
  return /** @type {WatchdogState} */ (merged);
}

// ─── I/O ─────────────────────────────────────────────────────────────────────

/**
 * Read a state file. NEVER throws.
 *
 *   • file missing                → defaults
 *   • file readable + valid JSON  → mergeWithDefaults(parsed)
 *   • file readable + bad JSON    → defaults; the bad file is renamed to
 *                                   "<path>.corrupt-<ts>" so the operator can
 *                                   inspect it; a warning is logged to stderr.
 *
 * The logger argument exists so tests can capture warnings; callers in prod
 * pass `console`.
 *
 * @param {string} statePath
 * @param {{warn?: (msg: string) => void}} [logger]
 * @returns {WatchdogState}
 */
export function loadState(statePath, logger = console) {
  const warn = logger.warn ?? console.warn;
  let raw;
  try {
    raw = fs.readFileSync(statePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return defaultState();
    warn(`[watchdog] could not read state file ${statePath}: ${err.message}; using defaults`);
    return defaultState();
  }
  try {
    const parsed = JSON.parse(raw);
    return mergeWithDefaults(parsed);
  } catch (err) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${statePath}.corrupt-${ts}`;
    try {
      fs.renameSync(statePath, backupPath);
      warn(`[watchdog] state file ${statePath} had invalid JSON (${err.message}); moved to ${backupPath}; using defaults`);
    } catch (renameErr) {
      warn(`[watchdog] state file ${statePath} had invalid JSON (${err.message}); could not back up: ${renameErr.message}; using defaults`);
    }
    return defaultState();
  }
}

/**
 * Ensure the parent directory of `statePath` exists with mode 0700.
 *
 * `mkdirSync({recursive:true, mode:0o700})` applies the mode ONLY when it
 * creates the directory — pre-existing directories keep whatever mode the
 * operator (or a prior less-strict setup script) left behind. We follow up
 * with a stat + targeted chmod so that a directory created externally with
 * 0755 gets tightened to 0700 without an unnecessary chmod when it's
 * already correct.
 *
 * The chmod is best-effort: if it fails (foreign owner, read-only fs,
 * Windows tests, etc.) we warn but don't abort — the state file itself
 * still goes out with mode 0600 from saveStateAtomic, so a wider parent
 * dir only widens *discoverability* of the filename, not its contents.
 *
 * @param {string} statePath
 * @param {{warn?: (msg: string) => void}} [logger]
 */
export function ensureStateDir(statePath, logger = console) {
  const warn = logger.warn ?? console.warn;
  const dir = path.dirname(statePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const st = fs.statSync(dir);
    if ((st.mode & 0o777) !== 0o700) {
      fs.chmodSync(dir, 0o700);
    }
  } catch (err) {
    warn(`[watchdog] could not enforce 0700 on ${dir}: ${err.message}`);
  }
}

/**
 * Atomic write: tmp file in the same directory → fsync → rename over target,
 * then fsync the directory so the rename hits stable storage. POSIX rename
 * is atomic only when source and target are on the same filesystem, hence
 * the same-directory tmp.
 *
 * On any failure the temp file is unlinked best-effort and the original
 * error is rethrown — saveStateAtomic is not "best effort"; callers want to
 * know if persistence broke.
 *
 * @param {string} statePath
 * @param {WatchdogState} state
 */
export function saveStateAtomic(statePath, state) {
  ensureStateDir(statePath);
  const dir = path.dirname(statePath);
  const tmp = `${statePath}.tmp-${process.pid}-${Date.now()}`;
  const payload = JSON.stringify(state);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
  try {
    fs.renameSync(tmp, statePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
  // fsync parent dir so the rename is durable. On some filesystems this is a
  // no-op; on ext4/xfs it matters across a hard power loss. Best-effort —
  // some platforms (Windows, certain CI sandboxes) refuse opening a dir for
  // writing.
  try {
    const dirFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } catch {
    // Not fatal — the file rename already landed; we just couldn't flush the
    // directory entry. Crash-consistency on this single file is preserved by
    // the rename atomicity.
  }
}

// ─── Pure transitions ────────────────────────────────────────────────────────

/**
 * @typedef {Object} DownTransition
 * @property {WatchdogState} state       — next state
 * @property {boolean} promote           — caller should send DOWN alert + createDowntimeExposures
 * @property {boolean} alreadyDown       — incident was already promoted before this tick
 * @property {string} log                — human-readable summary for console.log
 */

/**
 * Compute the next state given a DOWN observation. Pure — only depends on
 * the previous state and the current timestamp.
 *
 * @param {WatchdogState} prev
 * @param {string} nowIso
 * @returns {DownTransition}
 */
export function transitionOnDown(prev, nowIso) {
  const next = { ...prev };
  next.consecutiveHealthyChecks = 0;

  if (prev.wasDown) {
    // Already promoted. Don't grow the counter — it has no semantic value
    // after promotion; recovery is governed by consecutiveHealthyChecks.
    return { state: next, promote: false, alreadyDown: true, log: 'still down (alert already sent)' };
  }

  next.consecutiveDownChecks = prev.consecutiveDownChecks + 1;
  if (!next.firstDownSince) next.firstDownSince = nowIso;

  if (next.consecutiveDownChecks >= PROMOTE_THRESHOLD) {
    next.wasDown = true;
    next.downSince = next.firstDownSince;
    next.consecutiveDownChecks = 0;
    return {
      state: next,
      promote: true,
      alreadyDown: false,
      log: `promoted to incident (persistent since ${next.firstDownSince})`,
    };
  }

  return {
    state: next,
    promote: false,
    alreadyDown: false,
    log: `first DOWN observation, waiting for confirmation (consecutiveDownChecks=${next.consecutiveDownChecks}/${PROMOTE_THRESHOLD})`,
  };
}

/**
 * @typedef {Object} HealthyTransition
 * @property {WatchdogState} state
 * @property {boolean} recovered                  — should send RECOVERED alert + flip MaintenanceIncident
 * @property {string|null} downSinceForAlert      — value to embed in RECOVERED alert text
 * @property {boolean} clearedTransientBlip       — pre-promotion suspicion just got reset
 * @property {number} recoveryProgress            — 0..RECOVERY_THRESHOLD
 * @property {string} log
 */

/**
 * @param {WatchdogState} prev
 * @returns {HealthyTransition}
 */
export function transitionOnHealthy(prev) {
  const next = { ...prev };
  const clearedTransientBlip = prev.consecutiveDownChecks > 0 && !prev.wasDown;
  next.consecutiveDownChecks = 0;
  next.firstDownSince = null;

  if (!prev.wasDown) {
    return {
      state: next,
      recovered: false,
      downSinceForAlert: null,
      clearedTransientBlip,
      recoveryProgress: 0,
      log: 'all healthy',
    };
  }

  next.consecutiveHealthyChecks = prev.consecutiveHealthyChecks + 1;

  if (next.consecutiveHealthyChecks >= RECOVERY_THRESHOLD) {
    const downSince = prev.downSince ?? 'unknown';
    next.wasDown = false;
    next.downSince = null;
    next.consecutiveHealthyChecks = 0;
    // Note: incidentId is intentionally NOT cleared on recovery. It's
    // currently unread by any other code (the recovery alert uses
    // downSinceForAlert; the recovery UPDATE is incident-id-agnostic;
    // the zero-exposure tracker queries MaintenanceIncident directly
    // from the DB). It's kept as a forward-compat slot for future
    // post-mortem tooling — the value is whatever the LAST promoted
    // incident's id was, overwritten on the next promotion.
    return {
      state: next,
      recovered: true,
      downSinceForAlert: downSince,
      clearedTransientBlip,
      recoveryProgress: RECOVERY_THRESHOLD,
      log: `RECOVERED (was down since ${downSince})`,
    };
  }

  return {
    state: next,
    recovered: false,
    downSinceForAlert: null,
    clearedTransientBlip,
    recoveryProgress: next.consecutiveHealthyChecks,
    log: `recovery check ${next.consecutiveHealthyChecks}/${RECOVERY_THRESHOLD} (need ${RECOVERY_THRESHOLD} consecutive)`,
  };
}

// ─── Zero-exposure detection ─────────────────────────────────────────────────

/**
 * @typedef {Object} ZeroExposureCandidate
 * @property {string}  id                — incident id
 * @property {number}  ageMs             — wall-clock age since startedAt
 * @property {number}  exposureCount     — actual COUNT(*) of MaintenanceExposure rows for this incident
 * @property {string}  status            — 'active' | 'recovering' | 'recovered'
 */

/**
 * Given the set of incidents observed this tick and the prior dedup list,
 * decide who needs an alert this tick. Pure — caller does the SQL and the
 * Telegram send.
 *
 *   • An incident is "alertable" iff: status ∈ {active, recovering},
 *     age >= ZERO_EXPOSURE_MIN_AGE_MS, and the live exposure COUNT is 0.
 *     We use the live count rather than the cached `exposureCount` column
 *     because the cached count IS the bug we are trying to detect.
 *   • Dedup pruning is applied immediately (recovered or back-filled ids
 *     drop out of the dedup set, free of risk).
 *   • Dedup ADDITION is the caller's responsibility — caller calls
 *     `markZeroExposureAlerted(state, ids)` only AFTER a successful
 *     Telegram delivery. If the alert send failed, the caller leaves the
 *     dedup untouched so the next tick retries.
 *
 * @param {WatchdogState} prev
 * @param {ZeroExposureCandidate[]} liveCandidates  — every incident DB returned this tick (whatever its status / count)
 * @returns {{ state: WatchdogState, toAlert: ZeroExposureCandidate[] }}
 */
export function evaluateZeroExposureAlerts(prev, liveCandidates) {
  const eligibleIds = new Set();
  const toAlert = [];
  const prevAlerted = new Set(prev.zeroExposureAlertedIncidentIds);

  for (const c of liveCandidates) {
    const isOpen = c.status === 'active' || c.status === 'recovering';
    const oldEnough = c.ageMs >= ZERO_EXPOSURE_MIN_AGE_MS;
    const zeroExposure = c.exposureCount === 0;
    if (!isOpen || !oldEnough || !zeroExposure) continue;

    eligibleIds.add(c.id);
    if (!prevAlerted.has(c.id)) {
      toAlert.push(c);
    }
  }

  // Prune dedup: keep only ids that are still eligible right now. This is
  // safe to do immediately because it never SUPPRESSES alerts — it only
  // releases dedup entries for incidents that recovered or got their
  // exposures back-filled.
  const prunedAlerted = [];
  for (const id of prevAlerted) if (eligibleIds.has(id)) prunedAlerted.push(id);

  const next = { ...prev, zeroExposureAlertedIncidentIds: prunedAlerted };
  return { state: next, toAlert };
}

/**
 * Mark a set of incident ids as alerted. Idempotent: re-marking an id is a
 * no-op. Caller invokes this AFTER a successful Telegram send so that a
 * failed delivery doesn't lose the alert forever.
 *
 * @param {WatchdogState} prev
 * @param {string[]} incidentIds
 * @returns {WatchdogState}
 */
export function markZeroExposureAlerted(prev, incidentIds) {
  const set = new Set(prev.zeroExposureAlertedIncidentIds);
  for (const id of incidentIds) set.add(id);
  return { ...prev, zeroExposureAlertedIncidentIds: Array.from(set) };
}
