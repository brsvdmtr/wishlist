import type { Context } from 'telegraf';
import { getMyWishlists, createWishlist, addItem, getDefaultItemUrl } from '../api';
import { getSession, setSession, clearWizard } from '../session';
import { mainMenuKeyboard, cancelKeyboard } from '../menu';

export async function handleAddWish(ctx: Context) {
  const chatId = ctx.chat?.id;
  if (!chatId || !ctx.from) return;
  const telegramId = String(ctx.from.id);
  const session = getSession(chatId);

  if (session.listId && session.listSlug) {
    setSession(chatId, { wizard: 'add_item' });
    return ctx.reply('Напиши название желания (одной строкой). Можно добавить ссылку на следующей строке.', cancelKeyboard());
  }

  const result = await getMyWishlists(telegramId);
  if ('error' in result) {
    return ctx.reply(`Ошибка: ${result.error}`, mainMenuKeyboard());
  }
  const wishlists = result.wishlists;

  if (wishlists.length === 0) {
    const slug = `tg-${ctx.from.id}`;
    const createResult = await createWishlist(telegramId, 'Мой вишлист', slug);
    if ('error' in createResult) {
      return ctx.reply(`Не удалось создать список: ${createResult.error}`, mainMenuKeyboard());
    }
    const w = createResult.wishlist;
    setSession(chatId, { listId: w.id, listSlug: w.slug, listTitle: w.title, wizard: 'add_item' });
    return ctx.reply('Список создан. Напиши название желания (одной строкой). Можно добавить ссылку на следующей строке.', cancelKeyboard());
  }

  const first = wishlists[0];
  if (!first) return ctx.reply('Ошибка: нет списка.', mainMenuKeyboard());
  setSession(chatId, { listId: first.id, listSlug: first.slug, listTitle: first.title, wizard: 'add_item' });
  return ctx.reply('Напиши название желания (одной строкой). Можно добавить ссылку на следующей строке.', cancelKeyboard());
}

export async function handleAddItemText(ctx: Context) {
  const chatId = ctx.chat?.id;
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text?.trim() : '';
  if (!chatId || !ctx.from || !text) return;

  const session = getSession(chatId);
  if (session.wizard !== 'add_item' || !session.listId) {
    clearWizard(chatId);
    return ctx.reply('Главное меню:', mainMenuKeyboard());
  }

  if (text === '❌ Отмена') {
    clearWizard(chatId);
    return ctx.reply('Отменено.', mainMenuKeyboard());
  }

  const lines = text.split(/\n/).map((s) => s.trim()).filter(Boolean);
  const title = lines[0] ?? 'Желание';
  const urlLine = lines[1];
  const url = urlLine && /^https?:\/\//i.test(urlLine) ? urlLine : getDefaultItemUrl();

  const telegramId = String(ctx.from.id);
  const result = await addItem(telegramId, session.listId, title, url);
  clearWizard(chatId);

  if ('error' in result) {
    return ctx.reply(`Не удалось добавить: ${result.error}`, mainMenuKeyboard());
  }
  return ctx.reply(`Добавлено: ${title} ✅`, mainMenuKeyboard());
}
