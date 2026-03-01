import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';
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
const MINI_APP_URL = process.env.MINI_APP_URL ?? 'https://example.com/miniapp';

if (!token) {
  // eslint-disable-next-line no-console
  console.warn('[bot] BOT_TOKEN is missing. Bot is disabled (see apps/bot/.env.example).');
  // Keep process alive so `pnpm dev` can still run web+api without a bot token.
  setInterval(() => {}, 60_000);
} else {
  const bot = new Telegraf(token);

  // Set the persistent menu button (bottom-left "Вишлист" button)
  bot.telegram
    .setChatMenuButton({
      menuButton: {
        type: 'web_app',
        text: 'Вишлист',
        web_app: { url: MINI_APP_URL },
      },
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[bot] failed to set menu button', err);
    });

  bot.start((ctx) => {
    const payload = ctx.startPayload; // slug passed via ?start=SLUG deep link
    if (payload) {
      // Guest deep link — open specific wishlist in mini app
      return ctx.reply(
        `Смотри вишлист 🎁`,
        Markup.inlineKeyboard([
          Markup.button.webApp('Смотреть вишлист 🎁', `${MINI_APP_URL}?startapp=${payload}`),
        ]),
      );
    }
    // Regular start — no inline button, user uses the menu button
    return ctx.reply(
      'Привет! WishBoard — твой персональный список желаний 🎁\nНажми кнопку «Вишлист» внизу, чтобы открыть приложение.',
    );
  });

  bot.command('help', (ctx) =>
    ctx.reply(
      'WishBoard — создавай вишлисты и делись ими с друзьями.\n\n/start — начать',
    ),
  );

  bot.telegram
    .setMyCommands([{ command: 'start', description: 'Открыть WishBoard' }])
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[bot] failed to set commands', err);
    });

  bot
    .launch()
    .then(() => {
      // eslint-disable-next-line no-console
      console.log('[bot] started');
    })
    .catch((err: unknown) => {
      // eslint-disable-next-line no-console
      console.error('[bot] failed to start', err);
      process.exitCode = 1;
    });

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
