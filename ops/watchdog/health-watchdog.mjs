#!/usr/bin/env node
/**
 * health-watchdog.mjs
 *
 * Cron-runnable health watchdog for Wishlistik.
 * Checks /health/deep and the web homepage, deduplicates alerts via a state file,
 * sends one Telegram alert on first failure and one recovery alert on first success.
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
 *   * /5 * * * * /usr/bin/node /opt/wishlist/ops/watchdog/health-watchdog.mjs >> /var/log/watchdog.log 2>&1
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

/** @returns {{ wasDown: boolean, downSince: string | null }} */
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { wasDown: false, downSince: null };
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

// ─── Main ─────────────────────────────────────────────────────────────────────

const state = loadState();
const now = new Date().toISOString();

console.log(`[watchdog] ${now} checking ${BASE_URL} …`);

// Run checks in parallel
const [healthResult, webResult, tgResult] = await Promise.all([
  fetchWithTimeout(`${BASE_URL}/api/health/deep`),
  fetchWithTimeout(`${BASE_URL}/`),
  // Check a /tg/ endpoint to detect stuck MAINTENANCE_MODE.
  // Expected: 401 (no auth) = healthy. 503 = maintenance stuck. 0 = down.
  fetchWithTimeout(`${BASE_URL}/api/tg/bootstrap`),
]);

// /tg/bootstrap should return 401 (unauthorized) — that means the route is live.
// 503 = MAINTENANCE_MODE is stuck on. Anything else non-200 is also fine (route is reachable).
const tgRouteDown = tgResult.status === 503 || tgResult.status === 0;

const isDown = !healthResult.ok || !webResult.ok || tgRouteDown;

console.log(`[watchdog] health/deep: ${JSON.stringify(healthResult)} | web: ${JSON.stringify(webResult)} | tg: ${JSON.stringify(tgResult)} (down=${tgRouteDown}) | isDown: ${isDown}`);

if (isDown) {
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
    // Recovery — send alert
    const downSince = state.downSince ?? 'unknown';
    state.wasDown = false;
    state.downSince = null;
    saveState(state);

    if (MAINTENANCE) {
      console.log('[watchdog] MAINTENANCE_MODE=true — skipping recovery alert');
    } else {
      await sendAlert(`🟢 <b>Wishlistik RECOVERED</b> at ${now}\n(was down since ${downSince})`);
      console.log('[watchdog] alert sent: RECOVERED');
    }
  } else {
    console.log('[watchdog] all healthy');
  }
}
