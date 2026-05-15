// Locale-related helpers (P5s-10 — extracted from apps/api/src/index.ts).
//
// Houses one helper local to API: `resolveUserFirstName` (best-effort
// first_name resolver: cached `firstName` → live Telegram `getChat` →
// localised `api_user_fallback`). `locale` is required (no default) so
// every caller commits to a recipient-resolved locale via the resolver
// chain.
//
// `profileToLanguageSettings` and its companion `LocaleProfileSlice` type
// live in `@wishlist/shared` because both `apps/api` and `apps/bot`
// consume them — re-exported here so existing API imports keep working
// without a path change.

import { prisma } from '@wishlist/db';
import { t, type Locale } from '@wishlist/shared';

export { profileToLanguageSettings, type LocaleProfileSlice } from '@wishlist/shared';

/**
 * Best-effort: resolve user's first_name from Telegram Bot API, cache in DB.
 *
 * `locale` is required — used only for the `api_user_fallback` string when
 * neither the cached firstName nor a live Telegram getChat lookup yields a
 * name. Earlier this defaulted to `'ru'`, which returned a Russian fallback
 * name to non-Russian viewers. Now mandatory so the call site must commit to
 * a recipient-resolved locale via `resolveLocaleWithSource` (or a request
 * locale via `getRequestLocale`) — same chain as every other notification.
 */
export async function resolveUserFirstName(user: { id: string; firstName: string | null; telegramChatId: string | null }, locale: Locale): Promise<string> {
  if (user.firstName) return user.firstName;
  const fallback = t('api_user_fallback', locale);
  const token = process.env.BOT_TOKEN;
  if (!token || !user.telegramChatId) return fallback;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: user.telegramChatId }),
    });
    if (!resp.ok) return fallback;
    const json = await resp.json() as { ok: boolean; result?: { first_name?: string } };
    const name = json.result?.first_name;
    if (name) {
      // Cache in DB for future calls
      await prisma.user.update({ where: { id: user.id }, data: { firstName: name } }).catch(() => {});
      return name;
    }
  } catch { /* best-effort */ }
  return fallback;
}
