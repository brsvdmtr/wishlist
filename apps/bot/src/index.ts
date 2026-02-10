import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import fs from 'node:fs';
import path from 'node:path';

// Prefer app-local .env when running from repo root (pnpm dev),
// but also support running from within apps/bot (pnpm -C apps/bot start).
const envCandidates = [
  path.resolve(process.cwd(), 'apps/bot/.env'),
  path.resolve(process.cwd(), '.env'),
];
for (const p of envCandidates) {
  if (fs.existsSync(p)) {
    dotenv.config({ path: p });
    break;
  }
}

const token = process.env.BOT_TOKEN;
if (!token) {
  // eslint-disable-next-line no-console
  console.warn('[bot] BOT_TOKEN is missing. Bot is disabled (see apps/bot/.env.example).');
  // Keep process alive so `pnpm dev` can still run web+api without a bot token.
  setInterval(() => {}, 60_000);
} else {
  const bot = new Telegraf(token);

  bot.start((ctx) => ctx.reply('WishList bot is running. Try /ping'));
  bot.command('ping', (ctx) => ctx.reply('pong'));
  bot.command('help', (ctx) => ctx.reply('Commands: /ping'));

  bot.launch().then(() => {
    // eslint-disable-next-line no-console
    console.log('[bot] started');
  });

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
