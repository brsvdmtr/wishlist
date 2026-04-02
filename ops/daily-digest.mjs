#!/usr/bin/env node
/**
 * Daily digest — sends 24h summary to admin Telegram chats.
 * Run via cron: 0 9 * * * node /opt/wishlist/ops/daily-digest.mjs
 * Env: DATABASE_URL, BOT_TOKEN, ADMIN_ALERT_CHAT_IDS
 */
import pg from 'pg';

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_IDS = (process.env.ADMIN_ALERT_CHAT_IDS || '').split(',').filter(Boolean);
const DATABASE_URL = process.env.DATABASE_URL;

if (!BOT_TOKEN || !DATABASE_URL || ADMIN_CHAT_IDS.length === 0) {
  console.error('[digest] Missing required env: BOT_TOKEN, DATABASE_URL, ADMIN_ALERT_CHAT_IDS');
  process.exit(1);
}

const client = new pg.Client({ connectionString: DATABASE_URL });

async function sendTelegram(chatId, text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  if (!res.ok) console.error(`[digest] Telegram send failed for ${chatId}: ${res.status}`);
}

async function countEvents(eventPattern, windowStart, windowEnd) {
  const result = await client.query(
    `SELECT COUNT(*)::int as count FROM "AnalyticsEvent" WHERE event = $1 AND "createdAt" >= $2 AND "createdAt" < $3`,
    [eventPattern, windowStart, windowEnd]
  );
  return result.rows[0]?.count || 0;
}

async function countEventsLike(eventPrefix, windowStart, windowEnd) {
  const result = await client.query(
    `SELECT COUNT(*)::int as count FROM "AnalyticsEvent" WHERE event LIKE $1 AND "createdAt" >= $2 AND "createdAt" < $3`,
    [eventPrefix + '%', windowStart, windowEnd]
  );
  return result.rows[0]?.count || 0;
}

async function topFailReasons(event, windowStart, windowEnd, limit = 5) {
  const result = await client.query(
    `SELECT props->>'reason' as reason, props->>'errorCode' as error_code, COUNT(*)::int as count
     FROM "AnalyticsEvent"
     WHERE event = $1 AND "createdAt" >= $2 AND "createdAt" < $3
     GROUP BY props->>'reason', props->>'errorCode'
     ORDER BY count DESC LIMIT $4`,
    [event, windowStart, windowEnd, limit]
  );
  return result.rows;
}

async function openWithoutStart(windowStart, windowEnd) {
  // Count bootSessionIds that have open_attempt but no first_rendered
  const result = await client.query(
    `SELECT COUNT(DISTINCT opens.boot_session_id)::int as count
     FROM (
       SELECT props->>'bootSessionId' as boot_session_id
       FROM "AnalyticsEvent"
       WHERE event = 'miniapp.open_attempt' AND "createdAt" >= $1 AND "createdAt" < $2
       AND props->>'bootSessionId' IS NOT NULL
     ) opens
     LEFT JOIN (
       SELECT DISTINCT props->>'bootSessionId' as boot_session_id
       FROM "AnalyticsEvent"
       WHERE event = 'miniapp.first_rendered' AND "createdAt" >= $1 AND "createdAt" < $2
       AND props->>'bootSessionId' IS NOT NULL
     ) renders ON opens.boot_session_id = renders.boot_session_id
     WHERE renders.boot_session_id IS NULL`,
    [windowStart, windowEnd]
  );
  return result.rows[0]?.count || 0;
}

async function topErrorRoutes(windowStart, windowEnd, limit = 5) {
  const result = await client.query(
    `SELECT event, COUNT(*)::int as count
     FROM "AnalyticsEvent"
     WHERE event LIKE 'error:%' AND "createdAt" >= $1 AND "createdAt" < $2
     GROUP BY event ORDER BY count DESC LIMIT $3`,
    [windowStart, windowEnd, limit]
  );
  return result.rows;
}

async function main() {
  await client.connect();

  const now = new Date();
  const h24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const h48 = new Date(now.getTime() - 48 * 60 * 60 * 1000);

  // Current window
  const cur = {
    api5xx: await countEventsLike('error:', h24, now),
    bootFailed: await countEvents('miniapp.bootstrap_failed', h24, now),
    openAttempt: await countEvents('miniapp.open_attempt', h24, now),
    firstRendered: await countEvents('miniapp.first_rendered', h24, now),
    openWithoutStart: await openWithoutStart(h24, now),
    botStarts: await countEvents('bot.start_received', h24, now),
    wishlistCreated: await countEvents('wishlist.created', h24, now),
    wishCreated: await countEvents('wish.created', h24, now),
    importStarted: await countEvents('import.started', h24, now),
    importSucceeded: await countEvents('import.succeeded', h24, now),
    importFailed: await countEvents('import.failed', h24, now),
  };

  // Previous window (for comparison)
  const prev = {
    api5xx: await countEventsLike('error:', h48, h24),
    bootFailed: await countEvents('miniapp.bootstrap_failed', h48, h24),
    openAttempt: await countEvents('miniapp.open_attempt', h48, h24),
    firstRendered: await countEvents('miniapp.first_rendered', h48, h24),
  };

  const topBootErrors = await topFailReasons('miniapp.bootstrap_failed', h24, now);
  const topImportErrors = await topFailReasons('import.failed', h24, now);
  const topRouteErrors = await topErrorRoutes(h24, now);

  await client.end();

  // Build message
  const flag = (cur_val, prev_val) => prev_val > 0 && cur_val >= prev_val * 2 ? ' ⚠️ 2x+' : '';
  const pct = (a, b) => b > 0 ? Math.round((a / b) * 100) : 0;
  const importRate = cur.importStarted > 0 ? pct(cur.importSucceeded, cur.importStarted) : '-';
  const bootConv = pct(cur.firstRendered, cur.openAttempt);
  const hasCritical = cur.api5xx > 10 || cur.bootFailed > 5 || cur.openWithoutStart > 10;

  let msg = hasCritical ? '🔴' : '✅';
  msg += ` <b>WishBoard Daily Digest</b>\n`;
  msg += `${h24.toISOString().slice(0, 10)} → ${now.toISOString().slice(0, 10)}\n\n`;

  msg += `<b>📊 Stability</b>\n`;
  msg += `• API errors: ${cur.api5xx}${flag(cur.api5xx, prev.api5xx)}\n`;
  msg += `• Boot failures: ${cur.bootFailed}${flag(cur.bootFailed, prev.bootFailed)}\n`;
  msg += `• Open w/o start: ${cur.openWithoutStart}\n`;

  if (topRouteErrors.length > 0) {
    msg += `• Top error routes:\n`;
    topRouteErrors.forEach(r => { msg += `  ${r.event}: ${r.count}\n`; });
  }

  if (topBootErrors.length > 0) {
    msg += `• Top boot errors:\n`;
    topBootErrors.forEach(r => {
      const code = r.error_code || r.reason || 'unknown';
      msg += `  ${code}: ${r.count}\n`;
    });
  }

  msg += `\n<b>📈 Growth Funnel</b>\n`;
  msg += `• Bot starts: ${cur.botStarts}\n`;
  msg += `• MiniApp opens: ${cur.openAttempt}${flag(cur.openAttempt, prev.openAttempt) ? '' : ` (prev: ${prev.openAttempt})`}\n`;
  msg += `• First renders: ${cur.firstRendered}\n`;
  msg += `• Open→Render: ${bootConv}%\n`;
  msg += `• Wishlists: ${cur.wishlistCreated}\n`;
  msg += `• Wishes: ${cur.wishCreated}\n`;
  msg += `• Imports: ${cur.importStarted} (✅${cur.importSucceeded} ❌${cur.importFailed}, rate: ${importRate}%)\n`;

  if (topImportErrors.length > 0) {
    msg += `• Import fail reasons:\n`;
    topImportErrors.forEach(r => {
      const reason = r.reason || r.error_code || 'unknown';
      msg += `  ${reason}: ${r.count}\n`;
    });
  }

  // Send to all admin chats
  for (const chatId of ADMIN_CHAT_IDS) {
    await sendTelegram(chatId.trim(), msg);
  }

  console.log('[digest] Sent to', ADMIN_CHAT_IDS.length, 'chat(s)');
}

main().catch(err => {
  console.error('[digest] Failed:', err.message);
  process.exit(1);
});
