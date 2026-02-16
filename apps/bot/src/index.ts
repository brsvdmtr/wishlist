import dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import fs from 'node:fs';
import path from 'node:path';

import { getSession, clearWizard } from './session';
import { mainMenuKeyboard, openWebAppKeyboard } from './menu';
import { getMenuButtonBaseUrl } from './config';
import { handleStart } from './handlers/start';
import { handleMyList, handleShare, handleSettings, handleBackToMenu, handleCreateListText } from './handlers/list';
import { handleAddWish, handleAddItemText } from './handlers/addItem';

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
  setInterval(() => {}, 60_000);
} else {
  const bot = new Telegraf(token);

  bot.start(handleStart);

  bot.hears('➕ Добавить желание', handleAddWish);
  bot.hears('📋 Мой список', handleMyList);
  bot.hears('🔗 Поделиться', handleShare);
  bot.hears('⚙️ Настройки', handleSettings);
  bot.hears('◀️ В меню', handleBackToMenu);
  bot.hears('❌ Отмена', (ctx) => {
    const chatId = ctx.chat?.id;
    if (chatId) clearWizard(chatId);
    return ctx.reply('Отменено.', mainMenuKeyboard());
  });

  bot.on('text', async (ctx) => {
    const chatId = ctx.chat?.id;
    if (!chatId) return;
    const session = getSession(chatId);

    if (session.wizard === 'create_list') {
      await handleCreateListText(ctx);
      return;
    }
    if (session.wizard === 'add_item') {
      await handleAddItemText(ctx);
      return;
    }

    const text = ctx.message?.text ?? '';
    if (text.includes('/w/')) {
      const match = text.match(/\/w\/([a-z0-9-]+)/i);
      if (match?.[1]) {
        const slug = match[1];
        const { openWishListWebAppKeyboard } = await import('./menu');
        const { getMenuButtonUrlForSlug } = await import('./config');
        return ctx.reply(
          `🎁 Вишлист: ${slug}`,
          openWishListWebAppKeyboard(getMenuButtonUrlForSlug(slug)),
        );
      }
    }

    return ctx.reply('Используй кнопки меню: ➕ Добавить желание, 📋 Мой список, 🔗 Поделиться.', mainMenuKeyboard());
  });

  bot.command('demo', async (ctx) => {
    const { openWishListWebAppKeyboard } = await import('./menu');
    const { getMenuButtonUrlForSlug } = await import('./config');
    return ctx.reply('📋 Демо-вишлист', openWishListWebAppKeyboard(getMenuButtonUrlForSlug('demo')));
  });
  bot.command('w', async (ctx) => {
    const slug = ctx.message.text.split(/\s+/)[1];
    if (!slug) return ctx.reply('Использование: /w <slug>\nПример: /w demo');
    const { openWishListWebAppKeyboard } = await import('./menu');
    const { getMenuButtonUrlForSlug } = await import('./config');
    return ctx.reply(`🎁 Вишлист: ${slug}`, openWishListWebAppKeyboard(getMenuButtonUrlForSlug(slug)));
  });
  bot.command('health', async (ctx) => {
    const API_BASE_URL = (process.env.API_BASE_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
    try {
      const res = await fetch(`${API_BASE_URL}/health`);
      const data = (await res.json()) as { ok?: boolean };
      const status = data.ok === true ? '✅ API работает' : `⚠️ ${JSON.stringify(data)}`;
      return ctx.reply(`Health: ${status}`);
    } catch (e) {
      return ctx.reply(`❌ API недоступен: ${e instanceof Error ? e.message : 'Unknown'}`);
    }
  });
  bot.command('help', (ctx) =>
    ctx.reply(
      'Кнопки:\n➕ Добавить желание — добавить пункт в список\n📋 Мой список — посмотреть и поделиться\n🔗 Поделиться — ссылка на вишлист',
      mainMenuKeyboard(),
    ),
  );

  bot.launch().then(async () => {
    // eslint-disable-next-line no-console
    console.log('[bot] started');
    const baseUrl = getMenuButtonBaseUrl();
    const menuButton = {
      type: 'web_app' as const,
      text: 'WishList',
      web_app: { url: baseUrl },
    };
    try {
      await bot.telegram.setChatMenuButton({ menuButton });
      // eslint-disable-next-line no-console
      console.log('[bot] menu button set (global)', { menu_button_url: baseUrl });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[bot] setChatMenuButton failed:', err);
    }
  });

  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}
