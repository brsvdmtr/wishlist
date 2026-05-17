#!/usr/bin/env node
/**
 * health-watchdog.mjs
 *
 * Cron-runnable health watchdog for Wishlistik.
 *
 * What it does on every tick (default cadence: every 5 min via cron):
 *   1. Probe https://wishlistik.ru/api/health/deep, /, and /api/tg/bootstrap
 *      in parallel. One automatic retry after 5s if any fail.
 *   2. Apply the pure state machine in ./state.mjs to decide whether to
 *      promote the suspicion into an incident (needs 2 consecutive DOWN
 *      ticks; see PROMOTE_THRESHOLD) or to mark the incident as RECOVERED
 *      (needs 3 consecutive healthy ticks; see RECOVERY_THRESHOLD).
 *   3. If a new incident is promoted: send Telegram alert + write a
 *      MaintenanceIncident row + populate MaintenanceExposure rows for the
 *      last-24h-active user set (via direct docker-exec psql, since the API
 *      is presumed down at this point).
 *   4. Check live bot heartbeat (ServiceHeartbeat table). Separate dedup.
 *   5. Detect zero-exposure incidents (status active|recovering, age > 15min,
 *      live COUNT(*) of MaintenanceExposure = 0) — that pattern is the
 *      "createDowntimeExposures silently failed" smell. Alert once per id.
 *
 * Env vars (loaded from /opt/wishlist/.env if present, else current env):
 *   WATCHDOG_BASE_URL     — e.g. https://wishlistik.ru (no trailing slash)
 *   BOT_TOKEN             — Telegram bot token (used both for alerts and
 *                            as X-INTERNAL-KEY on /api/internal/* calls)
 *   ADMIN_ALERT_CHAT_IDS  — comma-separated chat IDs for alerts
 *   WATCHDOG_STATE_FILE   — state JSON (default: /var/lib/wishlist/watchdog/state.json)
 *   WATCHDOG_TIMEOUT_MS   — HTTP probe timeout, ms (default: 15000)
 *   MAINTENANCE_MODE      — if "true", skip ALL alerting (planned downtime)
 *
 * Run via the flock wrapper to avoid overlapping cron runs:
 *   star/5 * * * * /opt/wishlist/ops/watchdog/run-health-watchdog.sh
 */

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import {
  loadState,
  saveStateAtomic,
  transitionOnDown,
  transitionOnHealthy,
  evaluateZeroExposureAlerts,
  markZeroExposureAlerted,
  ZERO_EXPOSURE_MIN_AGE_MS,
} from './state.mjs';

// ─── Config ──────────────────────────────────────────────────────────────────

// Load .env from project root if present (best effort — explicit env wins).
const envPath = new URL('../../.env', import.meta.url).pathname;
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)\s*=\s*"?([^"#\r\n]*)"?/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

const BASE_URL = (process.env.WATCHDOG_BASE_URL ?? '').replace(/\/$/, '');
const BOT_TOKEN = process.env.BOT_TOKEN ?? '';
const CHAT_IDS = (process.env.ADMIN_ALERT_CHAT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
// /var/lib is the canonical place for variable, persistent app state on
// Debian/Ubuntu. /tmp is wiped on boot and some distros also wipe it
// periodically while up — bad for a dedup/state file that must survive a
// kernel panic or VPS reboot.
//
// State file lives in a DEDICATED subdir (/var/lib/wishlist/watchdog/) so
// that ensureStateDir's 0700 enforcement only affects this watchdog's own
// directory — not the parent /var/lib/wishlist/, which other services may
// share (uploads, future runtime files, etc.).
//
// The env var lets tests/dev override the full path. If env is set,
// legacy-fallback below is disabled — the operator chose a path
// explicitly.
const STATE_FILE = process.env.WATCHDOG_STATE_FILE ?? '/var/lib/wishlist/watchdog/state.json';
// Ordered list of one-time legacy fallback locations. Newest-first: if
// data exists in BOTH locations, the more recently used one wins. The
// first successful saveStateAtomic writes to STATE_FILE, after which the
// legacy file is no longer consulted — but we DON'T delete the legacy
// file (operator can review and unlink manually).
const LEGACY_STATE_FILES = [
  '/var/lib/wishlist/watchdog-state.json', // pre-2026-05-17 dedicated-subdir default
  '/tmp/watchdog-state.json',              // original default (pre-/var/lib/)
];
const TIMEOUT_MS = Number(process.env.WATCHDOG_TIMEOUT_MS ?? 15000);
const MAINTENANCE = (process.env.MAINTENANCE_MODE ?? '').toLowerCase() === 'true';

if (!BASE_URL) {
  console.error('[watchdog] WATCHDOG_BASE_URL is not set');
  process.exit(1);
}

function loadStateWithLegacyFallback() {
  if (fs.existsSync(STATE_FILE)) return loadState(STATE_FILE);
  // If the operator pinned WATCHDOG_STATE_FILE explicitly, respect that and
  // don't silently merge legacy data into the chosen location.
  if (process.env.WATCHDOG_STATE_FILE) return loadState(STATE_FILE);

  for (const legacyPath of LEGACY_STATE_FILES) {
    if (legacyPath === STATE_FILE) continue;
    if (!fs.existsSync(legacyPath)) continue;
    const legacy = loadState(legacyPath);
    console.warn(
      `[watchdog] read state from legacy path ${legacyPath} → next save will land at ${STATE_FILE} (legacy file NOT deleted)`,
    );
    return legacy;
  }
  return loadState(STATE_FILE);
}

// ─── Telegram delivery ───────────────────────────────────────────────────────

/**
 * Send a Telegram alert to every chat in ADMIN_ALERT_CHAT_IDS.
 *
 * Behavior (hardened 2026-05-17):
 *   • Per-chat: check HTTP status AND Telegram's `ok` field.
 *   • Log error_code / description on Telegram-side rejection.
 *   • Respect retry_after on 429 — one retry, then give up (we are in cron
 *     and have a hard deadline; never block the next tick).
 *   • Never throw. A degraded delivery channel must not crash the watchdog.
 *
 * Returns whether at least one chat received the message. Callers that
 * gate dedup state on successful delivery (zero-exposure alerts) read this.
 *
 * If alerting is not configured at all (no token / no chat ids), we return
 * `true` — the operator chose to run without admin alerts, so we don't want
 * to make every dedup retry forever in that mode.
 *
 * @param {string} text
 * @returns {Promise<boolean>}
 */
async function sendAlert(text) {
  if (!BOT_TOKEN || CHAT_IDS.length === 0) {
    console.log('[watchdog] (no ADMIN_ALERT_CHAT_IDS configured, skipping alert)');
    return true;
  }
  const results = await Promise.allSettled(CHAT_IDS.map((chatId) => sendOneAlert(chatId, text, /* attempt= */ 0)));
  return results.some((r) => r.status === 'fulfilled' && r.value === true);
}

/** @returns {Promise<boolean>} true on confirmed delivery for this chat */
async function sendOneAlert(chatId, text, attempt) {
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    console.error(`[watchdog] telegram send failed (chatId=${chatId}, attempt=${attempt}): ${err}`);
    return false;
  }

  let body;
  try {
    body = await res.json();
  } catch {
    body = null;
  }

  if (res.ok && body && body.ok === true) return true; // happy path

  const description = body?.description ?? '(no description)';
  const errorCode = body?.error_code ?? res.status;
  const retryAfter = body?.parameters?.retry_after;

  console.error(
    `[watchdog] telegram rejected sendMessage (chatId=${chatId}, http=${res.status}, error_code=${errorCode}, attempt=${attempt}): ${description}`,
  );

  // One retry on 429 only — anything else (400 wrong chat id, 403 bot blocked,
  // etc.) is permanent for this run.
  if (res.status === 429 && typeof retryAfter === 'number' && retryAfter > 0 && attempt === 0) {
    const sleepMs = Math.min(retryAfter * 1000, TIMEOUT_MS);
    console.warn(`[watchdog] telegram 429 — retrying chatId=${chatId} after ${sleepMs}ms`);
    await new Promise((r) => setTimeout(r, sleepMs));
    return sendOneAlert(chatId, text, attempt + 1);
  }
  return false;
}

// ─── HTTP probes ─────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, ...opts });
    clearTimeout(timer);
    return { ok: res.ok, status: res.status };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, status: 0, error: String(err) };
  }
}

async function runChecks() {
  const [healthResult, webResult, tgResult] = await Promise.all([
    fetchWithTimeout(`${BASE_URL}/api/health/deep`),
    fetchWithTimeout(`${BASE_URL}/`),
    // Check a /tg/ endpoint to detect stuck MAINTENANCE_MODE.
    // Expected: 401 (no auth) = healthy. 503 = maintenance stuck. 0 = down.
    // x-watchdog header lets the API skip error:* telemetry for these probes.
    fetchWithTimeout(`${BASE_URL}/api/tg/bootstrap`, { headers: { 'x-watchdog': '1' } }),
  ]);
  const tgRouteDown = tgResult.status === 503 || tgResult.status === 502 || tgResult.status === 504 || tgResult.status === 0;
  const isDown = !healthResult.ok || !webResult.ok || tgRouteDown;
  return { healthResult, webResult, tgResult, tgRouteDown, isDown };
}

// ─── SQL helper (used for DB-side probes only — incidents/exposures/heartbeat) ──

async function runSql(query) {
  const { execSync } = await import('node:child_process');
  try {
    const result = execSync(
      `docker compose -f /opt/wishlist/docker-compose.prod.yml exec -T postgres psql -U wishlist -d wishlist -t -A -c "${query.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', timeout: 15_000 },
    );
    return result.trim();
  } catch (err) {
    console.error(`[watchdog] SQL error: ${err.message}`);
    return null;
  }
}

// ─── Incident + exposure recording ───────────────────────────────────────────

async function createDowntimeExposures() {
  // UUID generated in Node, not via Postgres RETURNING — `psql -t -A -c`
  // appends the command-status row ("INSERT 0 1") to the RETURNING output,
  // which the prior code mis-parsed and silently dropped exposures for. See
  // 2026-05-17 entry in docs/BUGFIX_LESSONS.md.
  const incidentId = randomUUID();
  const incidentInsert = await runSql(
    `INSERT INTO "MaintenanceIncident" (id, "startedAt", status, "lastMaintenanceSignalAt", "exposureCount", "notificationsSent", "createdAt", "updatedAt") VALUES ('${incidentId}', NOW(), 'active', NOW(), 0, 0, NOW(), NOW())`,
  );
  if (incidentInsert === null) {
    console.error('[watchdog] failed to create incident');
    return null;
  }
  console.log(`[watchdog] created incident: ${incidentId}`);

  const insertResult = await runSql(
    `WITH active_users AS ( SELECT DISTINCT ae."userId" AS telegram_id FROM "AnalyticsEvent" ae WHERE ae."createdAt" > NOW() - INTERVAL '24 hours' AND ae."userId" IS NOT NULL ), eligible AS ( SELECT u.id, u."telegramChatId", au.telegram_id FROM active_users au JOIN "User" u ON u."telegramId" = au.telegram_id WHERE u."telegramChatId" IS NOT NULL ) INSERT INTO "MaintenanceExposure" (id, "incidentId", "userId", surface, locale, "telegramChatId", "firstSeenAt", "lastSeenAt", "createdAt", "updatedAt") SELECT gen_random_uuid()::text, '${incidentId}', e.id, 'miniapp', 'ru', e."telegramChatId", NOW(), NOW(), NOW(), NOW() FROM eligible e ON CONFLICT ("incidentId", "userId", surface) DO NOTHING`,
  );
  if (insertResult === null) {
    console.error('[watchdog] failed to insert exposures');
    return incidentId;
  }

  const count = await runSql(
    `SELECT COUNT(*)::int FROM "MaintenanceExposure" WHERE "incidentId" = '${incidentId}'`,
  );
  if (count === null) {
    console.error('[watchdog] failed to count exposures — leaving exposureCount at default 0; zero-exposure alert will fire if this is the bug');
    return incidentId;
  }
  const exposureCount = Number(count);
  if (!Number.isFinite(exposureCount)) {
    console.error(`[watchdog] unparseable exposure count: ${JSON.stringify(count)}`);
    return incidentId;
  }
  await runSql(`UPDATE "MaintenanceIncident" SET "exposureCount" = ${exposureCount} WHERE id = '${incidentId}'`);
  console.log(`[watchdog] created ${exposureCount} exposure records for incident ${incidentId}`);
  return incidentId;
}

// ─── Bot heartbeat probe ─────────────────────────────────────────────────────

async function checkBotHeartbeat() {
  const STALE_THRESHOLD_SEC = 5 * 60;
  try {
    const result = await runSql(
      `SELECT EXTRACT(EPOCH FROM (NOW() - "updatedAt"))::int as age_sec, "updatedAt"::text as updated_at FROM "ServiceHeartbeat" WHERE "serviceName" = 'bot' LIMIT 1`,
    );
    if (!result) return { updatedAt: null, ageSec: null, stale: false, error: 'sql_failed' };
    if (result === '') return { updatedAt: null, ageSec: null, stale: true, error: 'no_row' };
    const [ageStr, updatedAtStr] = result.split('|');
    const ageSec = Number(ageStr);
    if (!Number.isFinite(ageSec)) return { updatedAt: null, ageSec: null, stale: false, error: 'parse_failed' };
    return {
      updatedAt: updatedAtStr ? new Date(updatedAtStr) : null,
      ageSec,
      stale: ageSec > STALE_THRESHOLD_SEC,
      error: null,
    };
  } catch (err) {
    return { updatedAt: null, ageSec: null, stale: false, error: String(err) };
  }
}

// ─── Zero-exposure detector ──────────────────────────────────────────────────

/**
 * Pull the candidate set for evaluateZeroExposureAlerts from Postgres.
 *   • Pivot on every open incident (active|recovering) that's >= 15min old.
 *   • The exposureCount we feed in is the LIVE COUNT(*) of MaintenanceExposure,
 *     NOT the cached MaintenanceIncident.exposureCount column — that column
 *     IS the field we don't trust.
 * Returns null on SQL failure (caller skips alerting and logs).
 *
 * @returns {Promise<null | Array<{ id: string, ageMs: number, exposureCount: number, status: string }>>}
 */
async function fetchZeroExposureCandidates() {
  const minAgeSec = Math.floor(ZERO_EXPOSURE_MIN_AGE_MS / 1000);
  const sql =
    `SELECT i.id, ` +
    `EXTRACT(EPOCH FROM (NOW() - i.\\"startedAt\\"))::bigint AS age_sec, ` +
    `(SELECT COUNT(*) FROM \\"MaintenanceExposure\\" e WHERE e.\\"incidentId\\" = i.id) AS live_count, ` +
    `i.status ` +
    `FROM \\"MaintenanceIncident\\" i ` +
    `WHERE i.status IN ('active','recovering') ` +
    `AND i.\\"startedAt\\" <= NOW() - INTERVAL '${minAgeSec} seconds'`;
  // runSql does its own quote-escaping; we pre-escape doubles so the inner
  // shell-quoted command sees them literally.
  const raw = await runSql(sql.replace(/\\"/g, '"'));
  if (raw === null) return null;
  if (raw === '') return [];

  const rows = raw.split('\n').filter(Boolean);
  const out = [];
  for (const line of rows) {
    const [id, ageSecStr, countStr, status] = line.split('|');
    const ageSec = Number(ageSecStr);
    const count = Number(countStr);
    // Drop rows we can't parse cleanly. A parse failure here would have
    // shown up as "ageMs=0 / exposureCount=0" before — which would NOT
    // alert (age<15min filter), but if the age parsed and only count
    // didn't, we'd have alerted on a fake-zero exposure. Be strict.
    if (!id || !status || !Number.isFinite(ageSec) || !Number.isFinite(count)) {
      console.warn(`[watchdog] zero-exposure probe: skipping unparseable row ${JSON.stringify(line)}`);
      continue;
    }
    out.push({ id, ageMs: ageSec * 1000, exposureCount: count, status });
  }
  return out;
}

// ─── Internal API caller (maintenance recovery flow) ─────────────────────────

async function callInternalApi(path, method = 'POST') {
  const url = `${BASE_URL}/api/internal${path}`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-INTERNAL-KEY': BOT_TOKEN },
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: {}, error: String(err) };
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

let state = loadStateWithLegacyFallback();
const now = new Date().toISOString();

console.log(`[watchdog] ${now} checking ${BASE_URL} …`);

let result = await runChecks();
if (result.isDown) {
  console.log('[watchdog] first check failed, retrying in 5s…');
  await new Promise((r) => setTimeout(r, 5000));
  result = await runChecks();
}
const { healthResult, webResult, tgResult, tgRouteDown, isDown } = result;
console.log(
  `[watchdog] health/deep: ${JSON.stringify(healthResult)} | web: ${JSON.stringify(webResult)} | tg: ${JSON.stringify(tgResult)} (down=${tgRouteDown}) | isDown: ${isDown}`,
);

if (isDown) {
  const t = transitionOnDown(state, now);
  state = t.state;
  console.log(`[watchdog] ${t.log}`);

  if (t.promote) {
    saveStateAtomic(STATE_FILE, state);
    if (MAINTENANCE) {
      console.log('[watchdog] MAINTENANCE_MODE=true — skipping alert');
    } else {
      const details = [
        !healthResult.ok ? `• /api/health/deep → ${healthResult.status || healthResult.error}` : '',
        !webResult.ok ? `• web homepage → ${webResult.status || webResult.error}` : '',
        tgRouteDown ? `• /api/tg/bootstrap → ${tgResult.status || tgResult.error} (MAINTENANCE_MODE stuck?)` : '',
      ].filter(Boolean).join('\n');
      await sendAlert(`🔴 <b>Wishlistik DOWN</b> at ${now}\n(persistent since ${state.downSince})\n\n${details}`);
      console.log('[watchdog] alert sent: DOWN');

      const incidentId = await createDowntimeExposures();
      if (incidentId) state.incidentId = incidentId;
      saveStateAtomic(STATE_FILE, state);
    }
  } else {
    saveStateAtomic(STATE_FILE, state);
  }
} else {
  const t = transitionOnHealthy(state);
  state = t.state;
  if (t.clearedTransientBlip) {
    console.log(`[watchdog] transient blip cleared (not promoted)`);
  }
  if (t.recovered) {
    saveStateAtomic(STATE_FILE, state);
    if (MAINTENANCE) {
      console.log('[watchdog] MAINTENANCE_MODE=true — skipping recovery alert');
    } else {
      await sendAlert(`🟢 <b>Wishlistik RECOVERED</b> at ${now}\n(was down since ${t.downSinceForAlert})`);
      console.log('[watchdog] alert sent: RECOVERED');
    }
    try {
      await runSql(
        `UPDATE "MaintenanceIncident" SET status = 'recovered', "endedAt" = NOW(), "recoveryConfirmedAt" = NOW(), "updatedAt" = NOW() WHERE status IN ('active', 'recovering')`,
      );
      const notifyRes = await callInternalApi('/maintenance/send-recovery-notifications');
      if (notifyRes.ok) {
        const { sent = 0, failed = 0 } = notifyRes.body;
        console.log(`[watchdog] recovery notifications: ${sent} sent, ${failed} failed`);
      } else {
        console.error(`[watchdog] failed to send recovery notifications: ${JSON.stringify(notifyRes.body)}`);
      }
    } catch (err) {
      console.error(`[watchdog] maintenance recovery flow error: ${err}`);
    }
  } else if (state.wasDown) {
    saveStateAtomic(STATE_FILE, state);
    console.log(`[watchdog] ${t.log}`);
  } else {
    // Standard all-healthy path. Opportunistically advance the maintenance
    // recovery flow if a prior incident is stuck in 'recovering' from a
    // different watchdog session.
    try {
      const activeRes = await callInternalApi('/maintenance/active-incident', 'GET');
      if (activeRes.ok && activeRes.body.active && activeRes.body.status === 'recovering') {
        const recoveryRes = await callInternalApi('/maintenance/check-recovery');
        if (recoveryRes.ok && recoveryRes.body.recovered) {
          console.log(`[watchdog] recovering incident found, sending notifications...`);
          const notifyRes = await callInternalApi('/maintenance/send-recovery-notifications');
          if (notifyRes.ok) {
            console.log(`[watchdog] recovery notifications: ${notifyRes.body.sent} sent, ${notifyRes.body.failed} failed`);
          }
        } else if (recoveryRes.ok) {
          console.log(`[watchdog] recovering incident: ${JSON.stringify(recoveryRes.body)}`);
        }
      }
    } catch {
      // silent — normal path when there's no active incident
    }
    saveStateAtomic(STATE_FILE, state);
    console.log('[watchdog] all healthy');
  }
}

// ─── Bot heartbeat ───────────────────────────────────────────────────────────

const heartbeat = await checkBotHeartbeat();
console.log(`[watchdog] bot heartbeat: ageSec=${heartbeat.ageSec} stale=${heartbeat.stale} error=${heartbeat.error ?? 'none'}`);

if (heartbeat.error && heartbeat.error !== 'no_row') {
  console.error('[watchdog] bot heartbeat probe error, skipping alert dedup');
} else if (heartbeat.stale) {
  if (!state.botWasStale) {
    state.botWasStale = true;
    state.botStaleSince = now;
    saveStateAtomic(STATE_FILE, state);
    if (!MAINTENANCE) {
      const ageMin = heartbeat.ageSec ? Math.round(heartbeat.ageSec / 60) : 'unknown';
      const detail = heartbeat.error === 'no_row'
        ? 'no row in ServiceHeartbeat — bot has never started'
        : `last heartbeat ${ageMin} min ago (${heartbeat.updatedAt?.toISOString() ?? 'n/a'})`;
      await sendAlert(`🟠 <b>Bot heartbeat STALE</b> at ${now}\n\n${detail}\n\nBot likely dead/wedged — API healthy but no DM delivery.`);
      console.log('[watchdog] alert sent: BOT STALE');
    }
  } else {
    console.log('[watchdog] bot still stale (alert already sent)');
  }
} else {
  if (state.botWasStale) {
    const staleSince = state.botStaleSince ?? 'unknown';
    state.botWasStale = false;
    state.botStaleSince = null;
    saveStateAtomic(STATE_FILE, state);
    if (!MAINTENANCE) {
      await sendAlert(`🟢 <b>Bot heartbeat RECOVERED</b> at ${now}\n(was stale since ${staleSince})`);
      console.log('[watchdog] alert sent: BOT RECOVERED');
    }
  }
}

// ─── Zero-exposure incident detector ─────────────────────────────────────────
// Runs last so a DB-side hiccup here doesn't block the primary health alert
// above. Detects: MaintenanceIncident in active|recovering, started ≥15min
// ago, with a LIVE COUNT(*) of MaintenanceExposure equal to 0. That's the
// signature of the 2026-05-17 createDowntimeExposures bug — we want to know
// if it ever happens again BEFORE the next 24h cycle of exposures expires.

const candidates = await fetchZeroExposureCandidates();
if (candidates === null) {
  // SQL failure → cannot reason about exposure state at all. Don't touch
  // dedup (so a back-filled-then-failed cycle doesn't strand alerts).
  console.error('[watchdog] zero-exposure probe SQL failed, skipping');
} else {
  // Pruning of dedup (recovered / back-filled ids fall out) is safe to
  // persist immediately — it can only ever release dedup slots, never
  // suppress a new alert.
  const { state: prunedState, toAlert } = evaluateZeroExposureAlerts(state, candidates);
  state = prunedState;

  if (toAlert.length === 0) {
    saveStateAtomic(STATE_FILE, state);
  } else if (MAINTENANCE) {
    console.log(`[watchdog] MAINTENANCE_MODE=true — skipping zero-exposure alert for ${toAlert.length} incident(s)`);
    saveStateAtomic(STATE_FILE, state);
  } else {
    const lines = toAlert.map((c) => {
      const ageMin = Math.round(c.ageMs / 60_000);
      return `• <code>${c.id}</code> (status=${c.status}, age=${ageMin}m)`;
    }).join('\n');
    const delivered = await sendAlert(
      `⚠️ <b>MaintenanceIncident has zero exposures after 15m</b>\n\n` +
      `This may indicate an exposure-recording bug, not necessarily zero affected users.\n\n` +
      lines,
    );
    if (delivered) {
      // Dedup ONLY after confirmed delivery. A failed Telegram send leaves
      // the dedup untouched so the next 5-min tick retries.
      state = markZeroExposureAlerted(state, toAlert.map((c) => c.id));
      console.log(`[watchdog] zero-exposure alert sent for: ${toAlert.map((c) => c.id).join(', ')}`);
    } else {
      console.warn(`[watchdog] zero-exposure alert NOT delivered; will retry next tick for: ${toAlert.map((c) => c.id).join(', ')}`);
    }
    saveStateAtomic(STATE_FILE, state);
  }
}
