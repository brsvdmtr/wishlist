import type { Context } from 'telegraf';
import { getMyWishlists } from '../api';
import { getSession, setSession, clearWizard } from '../session';
import { mainMenuKeyboard, openWebAppKeyboard } from '../menu';

export async function handleStart(ctx: Context) {
  const chatId = ctx.chat?.id;
  if (!chatId || !ctx.from) return;

  const telegramId = String(ctx.from.id);
  clearWizard(chatId);

  const startText = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  const payload = (typeof startText === 'string' ? startText.replace(/^\/start\s*/i, '').trim() : '') || (ctx as unknown as { startPayload?: string }).startPayload?.trim();
  if (payload?.startsWith('w_')) {
    const slug = payload.slice(2).trim();
    if (slug) {
      const siteUrl = (process.env.SITE_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
      return ctx.reply(
        `📋 Вишлист по ссылке:\n\n${siteUrl}/w/${slug}`,
        openWebAppKeyboard(),
      );
    }
  }

  const result = await getMyWishlists(telegramId);
  if ('error' in result) {
    return ctx.reply(
      `Не удалось загрузить списки: ${result.error}. Проверьте, что API и ADMIN_KEY настроены.`,
      mainMenuKeyboard(),
    );
  }

  const wishlists = result.wishlists;
  const first = wishlists[0];
  if (first) {
    setSession(chatId, { listId: first.id, listSlug: first.slug, listTitle: first.title });
  }

  const text = first
    ? `Привет! 🎁 У тебя есть вишлист «${first.title}». Добавляй желания, делись ссылкой с гостями.`
    : `Привет! 🎁 Создай свой первый вишлист — нажми «📋 Мой список» и затем создай список, или сразу «➕ Добавить желание» (создам список автоматически).`;

  return ctx.reply(text, mainMenuKeyboard());
}
