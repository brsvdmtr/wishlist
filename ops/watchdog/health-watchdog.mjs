#!/usr/bin/env node
/**
 * health-watchdog.mjs
 *
 * Cron-runnable health watchdog for Wishlistik.
 * Checks /health/deep and the web homepage, deduplicates alerts via a state file,
 * sends one Telegram alert on first failure and one recovery alert on first success.
 * After recovery, triggers maintenance recovery notification flow:
 *   - Checks if 15-min stability window has passed
 *   - Sends recovery notifications to affected users
 *
 * Usage:
 *   node ops/watchdog/health-watchdog.mjs
 *
 * Env vars (can be set in a .env or passed directly):
 *   WATCHDOG_BASE_URL     — e.g. https://wishlistik.ru   (no trailing slash)
 *   BOT_TOKEN             — Telegram bot token
 *   ADMIN_ALERT_CHAT_IDS  — comma-separated chat IDs
 *   WATCHDOG_STATE_FILE   — path to state JSON (default: /tmp/watchdog-state.json)
 *   WATCHDOG_TIMEOUT_MS   — HTTP timeout in ms (default: 15000)
 *   MAINTENANCE_MODE      — if "true", skip alerting (planned downtime)
 *
 * Cron example (every 5 minutes):
 *   star/5 * * * * /usr/bin/node /opt/wishlist/ops/watchdog/health-watchdog.mjs
 *   (replace "star" with asterisk)
 */

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

// ─── Config ──────────────────────────────────────────────────────────────────

// Load .env from project root if present
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
const STATE_FILE = process.env.WATCHDOG_STATE_FILE ?? '/tmp/watchdog-state.json';
// 15s — empirically safe for an SSR-rendered home page through nginx, with
// headroom for a one-off DNS resolver miss. Bumped from 8s after the
// 2026-05-17 02:25 UTC false alert: Vultr's primary recursive resolver
// (108.61.10.10) was timing out ~5s for ~50% of queries, eating most of
// the 8s window and triggering AbortError on the homepage probe even
// though the app itself was healthy. The DNS-side fix is the resolvconf
// override on the host (Quad9 first), but the watchdog should never have
// alerted on a 5-second DNS hiccup either.
const TIMEOUT_MS = Number(process.env.WATCHDOG_TIMEOUT_MS ?? 15000);
const MAINTENANCE = (process.env.MAINTENANCE_MODE ?? '').toLowerCase() === 'true';

if (!BASE_URL) {
  console.error('[watchdog] WATCHDOG_BASE_URL is not set');
  process.exit(1);
}

// ─── State ───────────────────────────────────────────────────────────────────

/** @returns {{ wasDown: boolean, downSince: string | null, consecutiveDownChecks: number, consecutiveHealthyChecks: number, firstDownSince: string | null, botWasStale: boolean, botStaleSince: string | null }} */
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return {
      wasDown: false, downSince: null,
      consecutiveDownChecks: 0, consecutiveHealthyChecks: 0,
      firstDownSince: null,
      botWasStale: false, botStaleSince: null,
      ...raw,
    };
  } catch {
    return {
      wasDown: false, downSince: null,
      consecutiveDownChecks: 0, consecutiveHealthyChecks: 0,
      firstDownSince: null,
      botWasStale: false, botStaleSince: null,
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

async function sendAlert(text) {
  if (!BOT_TOKEN || CHAT_IDS.length === 0) {
    console.log('[watchdog] (no ADMIN_ALERT_CHAT_IDS configured, skipping alert)');
    return;
  }
  await Promise.allSettled(
    CHAT_IDS.map((chatId) =>
      fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      }),
    ),
  );
}

/** Run a SQL query directly against PostgreSQL via docker exec. Works even when API is down. */
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

/**
 * On first DOWN detection, create a MaintenanceIncident and exposure records
 * for all users active in the last 24h. This runs via direct DB access so it
 * works even when the API is completely unreachable.
 */
async function createDowntimeExposures() {
  // UUID generated in Node, not via Postgres RETURNING — `psql -t -A -c`
  // appends the command-status row ("INSERT 0 1") to the RETURNING output,
  // and the previous version's regex stripped only the trailing newline so
  // the next query's FK saw "<uuid>\nINSERT 0 1" and exposures were never
  // inserted (silent 0 ever since this code shipped — see ghost rows in
  // MaintenanceIncident with exposureCount=0). 2026-05-17 fix.
  const incidentId = randomUUID();
  try {
    const incidentInsert = await runSql(
      `INSERT INTO "MaintenanceIncident" (id, "startedAt", status, "lastMaintenanceSignalAt", "exposureCount", "notificationsSent", "createdAt", "updatedAt") VALUES ('${incidentId}', NOW(), 'active', NOW(), 0, 0, NOW(), NOW())`,
    );
    if (incidentInsert === null) {
      console.error('[watchdog] failed to create incident');
      return null;
    }
    console.log(`[watchdog] created incident: ${incidentId}`);

    // Find users active in last 24h (from AnalyticsEvent) who have a telegramChatId.
    // Use SELECT COUNT after INSERT instead of RETURNING for the same parsing reason.
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
    const exposureCount = Number(count) || 0;

    await runSql(`UPDATE "MaintenanceIncident" SET "exposureCount" = ${exposureCount} WHERE id = '${incidentId}'`);

    console.log(`[watchdog] created ${exposureCount} exposure records for incident ${incidentId}`);
    return incidentId;
  } catch (err) {
    console.error(`[watchdog] createDowntimeExposures error: ${err}`);
    return null;
  }
}

/** Call an internal API endpoint (authenticated with BOT_TOKEN). */
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

/**
 * Check bot ServiceHeartbeat freshness via direct DB read. Bot writes its
 * heartbeat every 60s; if it's been quiet > 5 minutes the bot process is
 * almost certainly dead/wedged. Detects silent bot death that the
 * /api/health/deep probe can't see (API can be healthy with a dead bot).
 *
 * @returns {Promise<{ updatedAt: Date | null, ageSec: number | null, stale: boolean, error: string | null }>}
 */
async function checkBotHeartbeat() {
  const STALE_THRESHOLD_SEC = 5 * 60; // 5 minutes
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

// ─── Checks ──────────────────────────────────────────────────────────────────

async function runChecks() {
  const [healthResult, webResult, tgResult] = await Promise.all([
    fetchWithTimeout(`${BASE_URL}/api/health/deep`),
    fetchWithTimeout(`${BASE_URL}/`),
    // Check a /tg/ endpoint to detect stuck MAINTENANCE_MODE.
    // Expected: 401 (no auth) = healthy. 503 = maintenance stuck. 0 = down.
    // x-watchdog header lets the API skip error:* telemetry for these probes.
    fetchWithTimeout(`${BASE_URL}/api/tg/bootstrap`, { headers: { 'x-watchdog': '1' } }),
  ]);

  // /tg/bootstrap should return 401 (unauthorized) — that means the route is live.
  // 503 = MAINTENANCE_MODE is stuck on. 502/504 = nginx can't reach the container.
  // 0 = network error / timeout. Anything else (401, 400, etc.) = route is reachable = OK.
  const tgRouteDown = tgResult.status === 503 || tgResult.status === 502 || tgResult.status === 504 || tgResult.status === 0;
  const isDown = !healthResult.ok || !webResult.ok || tgRouteDown;

  return { healthResult, webResult, tgResult, tgRouteDown, isDown };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const state = loadState();
const now = new Date().toISOString();

console.log(`[watchdog] ${now} checking ${BASE_URL} …`);

let result = await runChecks();

// Retry once after 5s to avoid false positives from transient network blips
if (result.isDown) {
  console.log('[watchdog] first check failed, retrying in 5s…');
  await new Promise((r) => setTimeout(r, 5000));
  result = await runChecks();
}

const { healthResult, webResult, tgResult, tgRouteDown, isDown } = result;

console.log(`[watchdog] health/deep: ${JSON.stringify(healthResult)} | web: ${JSON.stringify(webResult)} | tg: ${JSON.stringify(tgResult)} (down=${tgRouteDown}) | isDown: ${isDown}`);

if (isDown) {
  // Reset consecutive healthy counter whenever we see a failure
  state.consecutiveHealthyChecks = 0;

  // Require 2 consecutive DOWN observations before promoting to an
  // incident + Telegram alert. With a 5-min cron interval the floor for
  // alert latency is ~5 minutes (when the first DOWN lands right before
  // a tick) and the worst case is ~10 minutes. This is a direct response
  // to the 2026-05-17 02:25 UTC false alert caused by a flapping Vultr
  // DNS resolver — each runChecks() retries once after 5s, but both that
  // retry and the actual fetch share the same DNS-failure window, so a
  // single bad tick isn't enough signal.
  if (state.wasDown) {
    // Already promoted on a prior tick — don't keep growing the counter,
    // it's only meaningful pre-promotion. Recovery flow uses
    // consecutiveHealthyChecks instead.
    saveState(state);
    console.log('[watchdog] still down (alert already sent)');
  } else {
    state.consecutiveDownChecks = state.consecutiveDownChecks + 1;
    if (!state.firstDownSince) state.firstDownSince = now;

    if (state.consecutiveDownChecks >= 2) {
      state.wasDown = true;
      state.downSince = state.firstDownSince;
      // Reset the pre-promotion counter so a future incident starts clean.
      state.consecutiveDownChecks = 0;
      saveState(state);

      if (MAINTENANCE) {
        console.log('[watchdog] MAINTENANCE_MODE=true — skipping alert');
      } else {
        const details = [
          !healthResult.ok ? `• /api/health/deep → ${healthResult.status || healthResult.error}` : '',
          !webResult.ok ? `• web homepage → ${webResult.status || webResult.error}` : '',
          tgRouteDown ? `• /api/tg/bootstrap → ${tgResult.status || tgResult.error} (MAINTENANCE_MODE stuck?)` : '',
        ].filter(Boolean).join('\n');
        await sendAlert(`🔴 <b>Wishlistik DOWN</b> at ${now}\n(persistent since ${state.firstDownSince})\n\n${details}`);
        console.log('[watchdog] alert sent: DOWN');

        // Create incident + exposure records for active users directly in DB.
        // API is unreachable so we bypass it entirely.
        const incidentId = await createDowntimeExposures();
        if (incidentId) state.incidentId = incidentId;
        saveState(state);
      }
    } else {
      saveState(state);
      console.log(`[watchdog] first DOWN observation, waiting for confirmation (consecutiveDownChecks=${state.consecutiveDownChecks}/2)`);
    }
  }
} else {
  // Healthy check: clear any "first down" suspicion that didn't escalate.
  if (state.consecutiveDownChecks > 0 && !state.wasDown) {
    console.log(`[watchdog] transient blip cleared (was ${state.consecutiveDownChecks} consecutive DOWN, not promoted)`);
  }
  state.consecutiveDownChecks = 0;
  state.firstDownSince = null;

  if (state.wasDown) {
    // Service is up but was down — track stability window
    state.consecutiveHealthyChecks = state.consecutiveHealthyChecks + 1;
    console.log(`[watchdog] recovery check ${state.consecutiveHealthyChecks}/3 (need 3 consecutive = ~15 min)`);

    if (state.consecutiveHealthyChecks >= 3) {
      // 3 consecutive healthy checks × 5-min cron = 15 minutes stable
      const downSince = state.downSince ?? 'unknown';
      state.wasDown = false;
      state.downSince = null;
      state.consecutiveHealthyChecks = 0;
      saveState(state);

      if (MAINTENANCE) {
        console.log('[watchdog] MAINTENANCE_MODE=true — skipping recovery alert');
      } else {
        await sendAlert(`🟢 <b>Wishlistik RECOVERED</b> at ${now}\n(was down since ${downSince})`);
        console.log('[watchdog] alert sent: RECOVERED');
      }

      // ─── Maintenance recovery notification flow ──────────────────────
      // Mark incident as recovered directly in DB (reliable), then use API to send notifications
      try {
        // Mark any active/recovering incident as recovered via direct SQL
        await runSql(
          `UPDATE "MaintenanceIncident" SET status = 'recovered', "endedAt" = NOW(), "recoveryConfirmedAt" = NOW(), "updatedAt" = NOW() WHERE status IN ('active', 'recovering')`,
        );

        // Now use API to send recovery notifications (API is back up at this point)
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
    } else {
      saveState(state);
    }
  } else {
    // Check if there's an active incident that needs recovery (e.g., from a previous run)
    // This handles the case where the watchdog wasn't running during the stability window
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

    // Persist the consecutiveDownChecks/firstDownSince reset above so a
    // healthy run between two DOWN observations actually clears the
    // counter (otherwise the file keeps the stale "1" and we'd promote
    // on the next DOWN, defeating the whole 2-consecutive guard).
    saveState(state);
    console.log('[watchdog] all healthy');
  }
}

// ─── Bot heartbeat check ─────────────────────────────────────────────────────
// Runs independently of the API/web isDown check above. Bot can die silently
// while the API stays healthy (separate container, separate process).
// Reuses the same dedup pattern: one alert on first stale, one on recovery.

const heartbeat = await checkBotHeartbeat();
console.log(`[watchdog] bot heartbeat: ageSec=${heartbeat.ageSec} stale=${heartbeat.stale} error=${heartbeat.error ?? 'none'}`);

if (heartbeat.error && heartbeat.error !== 'no_row') {
  // SQL probe failure — don't alert, but log. Could be transient docker exec hiccup.
  console.error('[watchdog] bot heartbeat probe error, skipping alert dedup');
} else if (heartbeat.stale) {
  if (!state.botWasStale) {
    state.botWasStale = true;
    state.botStaleSince = now;
    saveState(state);
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
    saveState(state);
    if (!MAINTENANCE) {
      await sendAlert(`🟢 <b>Bot heartbeat RECOVERED</b> at ${now}\n(was stale since ${staleSince})`);
      console.log('[watchdog] alert sent: BOT RECOVERED');
    }
  }
}
