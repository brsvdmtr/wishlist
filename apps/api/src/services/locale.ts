// Locale-related helpers (P5s-10 — extracted from apps/api/src/index.ts).
//
// Currently houses one helper: `resolveUserFirstName`, a best-effort
// resolver that returns a user's first_name, falling back to the
// Telegram Bot API `getChat` if the firstName field is empty, then
// caching the result on the User row for future calls.
//
// Strategy B: direct import. The previous deps signature in
// `routes/reservations.routes.ts` (sole consumer) drops this entry in
// the same PR.
//
// `resolveProactiveUserLocale` (referral-coupled) STAYS in index.ts —
// it is wired into the referral notification flow and out of P5s-10
// scope (analytics/referral hooks excluded).

import { prisma } from '@wishlist/db';
import { t, type Locale } from '@wishlist/shared';

/** Best-effort: resolve user's first_name from Telegram Bot API, cache in DB. */
export async function resolveUserFirstName(user: { id: string; firstName: string | null; telegramChatId: string | null }, locale: Locale = 'ru'): Promise<string> {
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
