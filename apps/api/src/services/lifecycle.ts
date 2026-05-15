// Lifecycle DM service (P5r-5) — extracted from apps/api/src/index.ts.
// This is the only cross-scheduler helper in the lifecycle stack:
// `sendLifecycleDM` is consumed by both schedulers/lifecycle.ts (the
// hourly win-back cron) and schedulers/pro-renewal.ts (hourly renewal
// reminders), so it lives in services/ rather than alongside one of
// them. Factory pattern (`createSendLifecycleDM`) keeps the bot token
// and logger as a closure rather than threading them through every
// callsite.
//
// Behavior preserved byte-identical from the inline `sendLifecycleDM`
// previously declared in index.ts:
//   - Telegram sendMessage endpoint, headers, body shape
//   - parse_mode='HTML', inline_keyboard with single web_app button
//     ('Открыть WishBoard ✨')
//   - outcome classification (delivered / bot_blocked / chat_not_found /
//     permanent_failure / transient_failure)
//   - logger.warn label "lifecycle DM rejected by Telegram"
//   - logger.warn label "lifecycle DM fetch error (transient)"
//
// `permanent_failure` is also returned when botToken or chatId is empty
// — that matches the prior in-line guard.

import type { Logger } from 'pino';
import { t, type Locale } from '@wishlist/shared';

/**
 * Outcome classification for a lifecycle DM send attempt.
 *   'delivered'         — Telegram accepted, message on its way
 *   'bot_blocked'       — user blocked the bot (403). Permanent. Auto-unsubscribe.
 *   'chat_not_found'    — chat deleted / user deactivated (400 with specific descr).
 *                          Permanent for this episode, but keep marketing opt-in
 *                          since the user may return via /start.
 *   'permanent_failure' — other non-retryable TG rejection.
 *   'transient_failure' — 429 / 5xx / network. Caller MUST leave the touch in
 *                          a pending state (no sentAt) so the next cycle retries.
 */
export type SendDmOutcome = 'delivered' | 'bot_blocked' | 'chat_not_found' | 'permanent_failure' | 'transient_failure';

/**
 * Send a lifecycle DM. `locale` localises the inline-keyboard CTA so the
 * button matches the message language. Required (no default) — historically
 * the button was hardcoded RU, which broke for every non-Russian recipient,
 * and a silent default would re-introduce that class of bug. Every caller
 * MUST resolve the recipient's locale via `resolveLocaleWithSource` and
 * pass it through. `webAppUrl` is still optional (no button = no localised
 * CTA needed); `locale` is consumed only when `webAppUrl` is provided but
 * stays required so the contract is unambiguous at the type level.
 */
export type SendLifecycleDM = (
  chatId: string,
  text: string,
  locale: Locale,
  webAppUrl?: string,
) => Promise<SendDmOutcome>;

export type CreateSendLifecycleDMDeps = {
  botToken: string;
  logger: Logger;
};

/** Send a Telegram DM via bot API. Returns a classified outcome. */
export function createSendLifecycleDM(deps: CreateSendLifecycleDMDeps): SendLifecycleDM {
  const { botToken, logger } = deps;
  return async function sendLifecycleDM(chatId: string, text: string, locale: Locale, webAppUrl?: string): Promise<SendDmOutcome> {
    if (!botToken || !chatId) return 'permanent_failure';
    const chatIdTail = String(chatId).slice(-4); // log suffix only, keep PII minimal
    try {
      const body: any = { chat_id: chatId, text, parse_mode: 'HTML' };
      if (webAppUrl) {
        const buttonText = t('lifecycle_dm_open_app_btn', locale);
        body.reply_markup = { inline_keyboard: [[{ text: buttonText, web_app: { url: webAppUrl } }]] };
      }
      const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const data = await r.json() as { ok: boolean; error_code?: number; description?: string };
      if (data.ok) return 'delivered';

      // Classify Telegram-side rejection. See
      // https://core.telegram.org/bots/api#making-requests for error codes.
      const code = data.error_code ?? r.status;
      const desc = (data.description ?? '').toLowerCase();
      let outcome: SendDmOutcome;
      if (code === 403) {
        // "Forbidden: bot was blocked by the user"
        outcome = 'bot_blocked';
      } else if (code === 400 && (desc.includes('chat not found') || desc.includes('user is deactivated'))) {
        outcome = 'chat_not_found';
      } else if (code === 429 || code >= 500) {
        // Flood-control / Telegram-side transient. Retry next cycle.
        outcome = 'transient_failure';
      } else {
        outcome = 'permanent_failure';
      }

      logger.warn(
        { chatIdTail, httpStatus: r.status, errorCode: code, description: data.description, outcome },
        'lifecycle DM rejected by Telegram',
      );
      return outcome;
    } catch (err) {
      // Network-level failure (timeout, DNS, IPv4 block, TLS) — always transient.
      logger.warn(
        { chatIdTail, err: err instanceof Error ? err.message : String(err) },
        'lifecycle DM fetch error (transient)',
      );
      return 'transient_failure';
    }
  };
}
