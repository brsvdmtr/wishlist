import type { Context } from 'telegraf';
import { getMyWishlists, createWishlist, getPublicWishlist } from '../api';
import { getSession, setSession, clearWizard } from '../session';
import { mainMenuKeyboard, shareLinkKeyboard, backToMenuKeyboard, cancelKeyboard } from '../menu';

export async function handleMyList(ctx: Context) {
  const chatId = ctx.chat?.id;
  if (!chatId || !ctx.from) return;
  const telegramId = String(ctx.from.id);
  clearWizard(chatId);

  const result = await getMyWishlists(telegramId);
  if ('error' in result) {
    return ctx.reply(`Ошибка: ${result.error}`, mainMenuKeyboard());
  }
  const wishlists = result.wishlists;

  if (wishlists.length === 0) {
    setSession(chatId, { wizard: 'create_list' });
    return ctx.reply(
      'У тебя ещё нет списка. Напиши название (например: ДР 2026).',
      cancelKeyboard(),
    );
  }

  const first = wishlists[0];
  if (!first) return ctx.reply('Нет списков.', mainMenuKeyboard());
  setSession(chatId, { listId: first.id, listSlug: first.slug, listTitle: first.title });

  const publicData = await getPublicWishlist(first.slug);
  if ('error' in publicData) {
    return ctx.reply(`Список «${first.title}» есть, но не удалось загрузить пункты: ${publicData.error}`, mainMenuKeyboard());
  }

  const lines = publicData.items.slice(0, 15).map((it, i) => {
    const status = it.status === 'PURCHASED' ? '✅' : it.status === 'RESERVED' ? '🧷' : '○';
    return `${i + 1}. ${status} ${it.title}`;
  });
  const more = publicData.items.length > 15 ? `\n... и ещё ${publicData.items.length - 15}` : '';
  const text = `📋 ${first.title}\n\n${lines.length ? lines.join('\n') + more : 'Пока пусто. Добавь желание — кнопка «➕ Добавить желание».'}`;

  return ctx.reply(text, shareLinkKeyboard(first.slug));
}

export async function handleShare(ctx: Context) {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const session = getSession(chatId);
  if (!session.listSlug) {
    return ctx.reply('Сначала открой «📋 Мой список» или создай список.', mainMenuKeyboard());
  }
  const siteUrl = (process.env.SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  const url = `${siteUrl}/w/${session.listSlug}`;
  return ctx.reply(`🔗 Поделись ссылкой на вишлист:\n\n${url}`, shareLinkKeyboard(session.listSlug));
}

export async function handleSettings(ctx: Context) {
  return ctx.reply('Настройки пока в разработке. Используй «📋 Мой список» и «🔗 Поделиться».', mainMenuKeyboard());
}

export async function handleCreateListText(ctx: Context) {
  const chatId = ctx.chat?.id;
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text?.trim() : '';
  if (!chatId || !ctx.from || !text) return false;

  const session = getSession(chatId);
  if (session.wizard !== 'create_list') return false;

  if (text === '❌ Отмена') {
    clearWizard(chatId);
    void ctx.reply('Отменено.', mainMenuKeyboard());
    return true;
  }

  const telegramId = String(ctx.from.id);
  const slug = `tg-${ctx.from.id}`;
  const result = await createWishlist(telegramId, text.slice(0, 200), slug);
  clearWizard(chatId);

  if ('error' in result) {
    void ctx.reply(`Не удалось создать список: ${result.error}`, mainMenuKeyboard());
    return true;
  }
  const w = result.wishlist;
  setSession(chatId, { listId: w.id, listSlug: w.slug, listTitle: w.title });
  void ctx.reply(`Список «${w.title}» создан. Добавляй желания кнопкой «➕ Добавить желание» или смотри список — «📋 Мой список».`, mainMenuKeyboard());
  return true;
}

export async function handleBackToMenu(ctx: Context) {
  const chatId = ctx.chat?.id;
  if (chatId) clearWizard(chatId);
  return ctx.reply('Главное меню:', mainMenuKeyboard());
}
