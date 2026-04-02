#!/usr/bin/env node
/**
 * Health check script — runs every 5 min via cron.
 * Pings /health endpoint; sends Telegram alert if down.
 *
 * Cron: * /5 * * * * node /opt/wishlist/ops/health-check.mjs >> /var/log/wishlist-health.log 2>&1
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Load .env from project root
try {
  const env = readFileSync(resolve(process.cwd(), '.env'), 'utf8');
  for (const line of env.split('\n')) {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match) process.env[match[1].trim()] ??= match[2].trim().replace(/^["']|["']$/g, '');
  }
} catch { /* .env optional */ }

const HEALTH_URL = process.env.HEALTH_URL || 'https://wishlistik.ru/health';
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_IDS = (process.env.ADMIN_ALERT_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const TIMEOUT_MS = 10_000;

async function sendAlert(text) {
  if (!BOT_TOKEN || CHAT_IDS.length === 0) return;
  await Promise.allSettled(
    CHAT_IDS.map(chatId =>
      fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      })
    )
  );
}

async function check() {
  const ts = new Date().toISOString();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const res = await fetch(HEALTH_URL, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      const msg = `🔴 <b>WishBoard DOWN</b>\n${HEALTH_URL} → HTTP ${res.status}\n${ts}`;
      console.error(msg);
      await sendAlert(msg);
    } else {
      console.log(`[${ts}] OK ${res.status}`);
    }
  } catch (err) {
    const msg = `🔴 <b>WishBoard UNREACHABLE</b>\n${HEALTH_URL}\n${err.message}\n${ts}`;
    console.error(msg);
    await sendAlert(msg);
  }
}

check();
