import dotenv from 'dotenv';
import { Telegraf, Markup } from 'telegraf';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '@wishlist/db';

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

  const menuButton = {
    type: 'web_app' as const,
    text: 'Вишлист',
    web_app: { url: MINI_APP_URL },
  };

  bot.start(async (ctx) => {
    // Override any stale per-chat menu button left by previous bot versions
    await ctx.setChatMenuButton(menuButton).catch(() => {});

    // Store chat ID for notifications
    const telegramId = String(ctx.from.id);
    const chatId = String(ctx.chat.id);
    await prisma.user.upsert({
      where: { telegramId },
      update: { telegramChatId: chatId },
      create: { telegramId, telegramChatId: chatId },
    }).catch(() => { /* user may not exist yet — will be created by API later */ });

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
      'WishBoard — создавай вишлисты и делись ими с друзьями.\n\n/start — начать\n\nОтправь ссылку на товар — я создам карточку желания!',
    ),
  );

  // ─── URL import: text message handler ────────────────────────────────────
  const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:3001';
  const URL_REGEX = /https?:\/\/[^\s<>"')\]]+/gi;

  function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  bot.on('text', async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith('/')) return; // skip commands

    const urls = text.match(URL_REGEX);
    if (!urls || urls.length === 0) return; // no URL — stay silent

    const firstUrl = urls[0];

    // Multiple URLs — warn
    if (urls.length > 1) {
      await ctx.reply('Нашёл несколько ссылок. Создаю карточку по первой 👌');
    }

    // Text without URL = user note
    const note = text.replace(URL_REGEX, '').trim() || undefined;

    // Show typing indicator while parsing
    await ctx.sendChatAction('typing');

    // Upsert user
    const telegramId = String(ctx.from.id);
    const chatId = String(ctx.chat.id);
    const user = await prisma.user.upsert({
      where: { telegramId },
      update: { telegramChatId: chatId },
      create: { telegramId, telegramChatId: chatId },
    });

    try {
      const res = await fetch(`${API_BASE_URL}/internal/import-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-INTERNAL-KEY': token!,
        },
        body: JSON.stringify({ userId: user.id, url: firstUrl, note, source: 'bot' }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        if (res.status === 402) {
          await ctx.reply('Слишком много неразобранных желаний. Разбери часть в приложении, потом добавляй новые 📦');
          return;
        }
        if (res.status === 400) {
          await ctx.reply(body.error || 'Не удалось обработать ссылку 🤷');
          return;
        }
        await ctx.reply('Не удалось обработать ссылку. Попробуй ещё раз 🤷');
        return;
      }

      const { item, parseStatus } = await res.json() as {
        item: { id: string; title: string; sourceDomain: string | null; price: number | null };
        parseStatus: string;
      };

      let msg = `✅ <b>Добавлено в Неразобранное</b>\n\n`;
      msg += `<b>${escapeHtml(item.title)}</b>`;
      if (item.sourceDomain) msg += `\n🔗 ${escapeHtml(item.sourceDomain)}`;
      if (item.price) msg += `\n💰 ${Number(item.price).toLocaleString('ru-RU')} ₽`;

      if (parseStatus === 'failed') {
        msg += `\n\n⚠️ Не удалось распознать товар — отредактируй в приложении`;
      } else if (parseStatus === 'partial') {
        msg += `\n\n💡 Распознал не всё — проверь и дополни в приложении`;
      }

      await ctx.reply(msg, {
        parse_mode: 'HTML',
        ...Markup.inlineKeyboard([
          Markup.button.webApp('Открыть в WishBoard ✨', `${MINI_APP_URL}?startapp=draft_${item.id}`),
        ]),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[bot] import-url error:', err);
      await ctx.reply('Произошла ошибка. Попробуй позже 🙈');
    }
  });

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
