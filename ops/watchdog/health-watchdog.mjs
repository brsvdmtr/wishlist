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
 *   WATCHDOG_TIMEOUT_MS   — HTTP timeout in ms (default: 8000)
 *   MAINTENANCE_MODE      — if "true", skip alerting (planned downtime)
 *
 * Cron example (every 5 minutes):
 *   star/5 * * * * /usr/bin/node /opt/wishlist/ops/watchdog/health-watchdog.mjs
 *   (replace "star" with asterisk)
 */

import fs from 'node:fs';

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
const TIMEOUT_MS = Number(process.env.WATCHDOG_TIMEOUT_MS ?? 8000);
const MAINTENANCE = (process.env.MAINTENANCE_MODE ?? '').toLowerCase() === 'true';

if (!BASE_URL) {
  console.error('[watchdog] WATCHDOG_BASE_URL is not set');
  process.exit(1);
}

// ─── State ───────────────────────────────────────────────────────────────────

/** @returns {{ wasDown: boolean, downSince: string | null, consecutiveHealthyChecks: number }} */
function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { wasDown: false, downSince: null, consecutiveHealthyChecks: 0, ...raw };
  } catch {
    return { wasDown: false, downSince: null, consecutiveHealthyChecks: 0 };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
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

// ─── Checks ──────────────────────────────────────────────────────────────────

async function runChecks() {
  const [healthResult, webResult, tgResult] = await Promise.all([
    fetchWithTimeout(`${BASE_URL}/api/health/deep`),
    fetchWithTimeout(`${BASE_URL}/`),
    // Check a /tg/ endpoint to detect stuck MAINTENANCE_MODE.
    // Expected: 401 (no auth) = healthy. 503 = maintenance stuck. 0 = down.
    fetchWithTimeout(`${BASE_URL}/api/tg/bootstrap`),
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

  if (!state.wasDown) {
    // First failure — send alert
    state.wasDown = true;
    state.downSince = now;
    saveState(state);

    if (MAINTENANCE) {
      console.log('[watchdog] MAINTENANCE_MODE=true — skipping alert');
    } else {
      const details = [
        !healthResult.ok ? `• /api/health/deep → ${healthResult.status || healthResult.error}` : '',
        !webResult.ok ? `• web homepage → ${webResult.status || webResult.error}` : '',
        tgRouteDown ? `• /api/tg/bootstrap → ${tgResult.status || tgResult.error} (MAINTENANCE_MODE stuck?)` : '',
      ].filter(Boolean).join('\n');
      await sendAlert(`🔴 <b>Wishlistik DOWN</b> at ${now}\n\n${details}`);
      console.log('[watchdog] alert sent: DOWN');
    }
  } else {
    console.log('[watchdog] still down (alert already sent)');
  }
} else {
  if (state.wasDown) {
    // Service is up but was down — track stability window
    state.consecutiveHealthyChecks = (state.consecutiveHealthyChecks || 0) + 1;
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
      // Check if there is an active incident and trigger recovery notifications
      try {
        const activeRes = await callInternalApi('/maintenance/active-incident', 'GET');
        if (activeRes.ok && activeRes.body.active) {
          console.log(`[watchdog] active incident found: ${activeRes.body.incidentId}, triggering recovery check`);

          const recoveryRes = await callInternalApi('/maintenance/check-recovery');
          if (recoveryRes.ok && recoveryRes.body.recovered) {
            console.log(`[watchdog] incident recovered, sending notifications...`);
            const notifyRes = await callInternalApi('/maintenance/send-recovery-notifications');
            if (notifyRes.ok) {
              console.log(`[watchdog] recovery notifications: ${notifyRes.body.sent} sent, ${notifyRes.body.failed} failed`);
            } else {
              console.error(`[watchdog] failed to send recovery notifications: ${JSON.stringify(notifyRes.body)}`);
            }
          } else {
            console.log(`[watchdog] recovery check: ${JSON.stringify(recoveryRes.body)}`);
          }
        } else {
          console.log('[watchdog] no active maintenance incident');
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

    console.log('[watchdog] all healthy');
  }
}
