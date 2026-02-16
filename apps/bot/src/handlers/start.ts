import type { Context } from 'telegraf';
import { getMyWishlists } from '../api';
import { getSession, setSession, clearWizard } from '../session';
import { mainMenuKeyboard, openWishListWebAppKeyboard } from '../menu';
import { getMenuButtonBaseUrl, getMenuButtonUrlForSlug } from '../config';

const MENU_BUTTON_TEXT = 'WishList';

export async function handleStart(ctx: Context) {
  const chatId = ctx.chat?.id;
  if (!chatId || !ctx.from) return;

  const telegramId = String(ctx.from.id);
  clearWizard(chatId);

  const startText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const payload = (typeof startText === 'string' ? startText.replace(/^\/start\s*/i, '').trim() : '') ||
    (ctx as unknown as { startPayload?: string }).startPayload?.trim();

  let webAppUrl: string;
  let menuButtonUrl: string;

  if (payload?.startsWith('w_')) {
    const slug = payload.slice(2).trim();
    if (slug) {
      webAppUrl = getMenuButtonUrlForSlug(slug);
      menuButtonUrl = webAppUrl;
    } else {
      webAppUrl = getMenuButtonBaseUrl();
      menuButtonUrl = webAppUrl;
    }
  } else {
    webAppUrl = getMenuButtonBaseUrl();
    menuButtonUrl = webAppUrl;
  }

  const menuButton = {
    type: 'web_app' as const,
    text: MENU_BUTTON_TEXT,
    web_app: { url: menuButtonUrl },
  };
  try {
    await ctx.telegram.setChatMenuButton({ chatId, menuButton });
    // eslint-disable-next-line no-console
    console.log('[bot] /start', { chat_id: chatId, menu_button_url: menuButtonUrl });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[bot] setChatMenuButton for chat failed:', err);
  }

  const shortMessage = payload?.startsWith('w_') && payload.slice(2).trim()
    ? 'Откройте вишлист в приложении.'
    : 'Откройте WishList — списки желаний в одном месте.';

  await ctx.reply(shortMessage, openWishListWebAppKeyboard(webAppUrl));
  await ctx.reply('Или используйте кнопки ниже:', mainMenuKeyboard());

  const result = await getMyWishlists(telegramId);
  if ('error' in result) {
    return;
  }
  const wishlists = result.wishlists;
  const first = wishlists[0];
  if (first) {
    setSession(chatId, { listId: first.id, listSlug: first.slug, listTitle: first.title });
  }
}
