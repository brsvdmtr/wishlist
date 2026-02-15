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
const API_BASE_URL = (process.env.API_BASE_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
const SITE_URL = (
  process.env.SITE_URL ??
  process.env.NEXT_PUBLIC_SITE_URL ??
  'http://localhost:3000'
).replace(/\/+$/, '');

if (!token) {
  // eslint-disable-next-line no-console
  console.warn('[bot] BOT_TOKEN is missing. Bot is disabled (see apps/bot/.env.example).');
  // Keep process alive so `pnpm dev` can still run web+api without a bot token.
  setInterval(() => {}, 60_000);
} else {
  const bot = new Telegraf(token);

  bot.start((ctx) =>
    ctx.reply(
      `Welcome to Wishlist Bot! 🎁\n\n` +
        `Available commands:\n` +
        `/demo - View demo wishlist\n` +
        `/w <slug> - View wishlist by slug\n` +
        `/health - Check API status`,
    ),
  );

  bot.command('demo', (ctx) => {
    const demoUrl = `${SITE_URL}/w/demo`;
    return ctx.reply(`📋 Demo Wishlist\n\n${demoUrl}`, { disable_web_page_preview: false });
  });

  bot.command('w', (ctx) => {
    const slug = ctx.message.text.split(/\s+/)[1];

    if (!slug) {
      return ctx.reply('Usage: /w <slug>\nExample: /w demo');
    }

    const wishlistUrl = `${SITE_URL}/w/${slug}`;
    return ctx.reply(`🎁 Wishlist: ${slug}\n\n${wishlistUrl}`, {
      disable_web_page_preview: false,
    });
  });

  bot.command('health', async (ctx) => {
    const healthUrl = `${API_BASE_URL}/health`;

    let status;
    let statusEmoji;

    try {
      const response = await fetch(healthUrl);
      const data = (await response.json()) as { ok?: boolean };

      if (data.ok === true) {
        status = '✅ API is healthy';
        statusEmoji = '✅';
      } else {
        status = `⚠️ API returned: ${JSON.stringify(data)}`;
        statusEmoji = '⚠️';
      }
    } catch (fetchError) {
      status = `❌ API is unreachable: ${fetchError instanceof Error ? fetchError.message : 'Unknown error'}`;
      statusEmoji = '❌';
    }

    return ctx.reply(`${statusEmoji} Health Check\n\n${status}\n\nAPI: ${API_BASE_URL}`);
  });

  bot.command('help', (ctx) =>
    ctx.reply(
      'Available commands:\n\n' +
        '/demo - Demo wishlist\n' +
        '/w <slug> - View wishlist\n' +
        '/health - API status',
    ),
  );

  bot.on('text', (ctx) => {
    const text = ctx.message.text;

    // Check if it looks like a wishlist URL or slug
    if (text.includes('/w/')) {
      const match = text.match(/\/w\/([a-z0-9-]+)/i);
      if (match) {
        const slug = match[1];
        const wishlistUrl = `${SITE_URL}/w/${slug}`;
        return ctx.reply(`🎁 Wishlist: ${slug}\n\n${wishlistUrl}`);
      }
    }

    return ctx.reply(
      'Use /help to see available commands:\n\n' +
        '/demo - Demo wishlist\n' +
        '/w <slug> - View wishlist\n' +
        '/health - API status',
    );
  });

  bot.launch().then(() => {
    // eslint-disable-next-line no-console
    console.log('[bot] started');
  });

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
