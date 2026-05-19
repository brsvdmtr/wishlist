// Bot-DM helper for research survey invites.
//
// Send classification mirrors apps/api/src/services/lifecycle.ts so the
// scheduler can drive the same auto-unsubscribe behavior on bot_blocked
// without re-deriving it. Returns one of:
//   'delivered'           — Telegram accepted the message (ok: true).
//   'bot_blocked'         — 403 from Telegram; permanent. Caller flips
//                           UserProfile.notifyMarketing = false and marks
//                           the invite FAILED.
//   'chat_not_found'      — 400 with "chat not found" / "user is deactivated".
//                           Also permanent — mark invite FAILED.
//   'permanent_failure'   — other 4xx. Mark invite FAILED, no opt-out.
//   'transient_failure'   — 429 / 5xx / network. Leave PENDING for retry.
//
// HTML parse mode + escapeTgHtml on dynamic substitutions. The current
// Wave 1 copy has no dynamic fields, but the helper takes a substitutions
// map so future per-segment variants (S2/S5 personalisation) drop in.

import logger from '../logger';
import { t, type Locale } from '@wishlist/shared';
import { escapeTgHtml } from '../telegram/html';
import { buildSurveyDeepLink } from '../telegram/deepLinks';
import type { SurveyLocale } from '../services/research-survey/locale';

export type SurveyDmOutcome =
  | 'delivered'
  | 'bot_blocked'
  | 'chat_not_found'
  | 'permanent_failure'
  | 'transient_failure';

const TG_FETCH_TIMEOUT_MS = 6000;

export interface SendSurveyInviteParams {
  chatId: string;
  inviteId: string;
  locale: SurveyLocale;
  /** Optional override for tests. */
  messageKey?: string;
  /** Optional override for tests. */
  buttonKey?: string;
}

export async function sendSurveyInviteDM(params: SendSurveyInviteParams): Promise<SurveyDmOutcome> {
  const token = process.env.BOT_TOKEN;
  if (!token || !params.chatId) return 'permanent_failure';

  const text = t(
    (params.messageKey ?? 'research_survey_invite_message') as Parameters<typeof t>[0],
    params.locale as Locale,
  );
  const buttonText = t(
    (params.buttonKey ?? 'research_survey_invite_btn') as Parameters<typeof t>[0],
    params.locale as Locale,
  );
  const webAppUrl = buildSurveyDeepLink(params.inviteId);
  const body = {
    chat_id: params.chatId,
    text: escapeTgHtml(text),
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: [[{ text: buttonText, web_app: { url: webAppUrl } }]],
    },
  };

  const chatIdTail = String(params.chatId).slice(-4);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TG_FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = (await r.json()) as { ok: boolean; error_code?: number; description?: string };
    if (data.ok) return 'delivered';

    const code = data.error_code ?? r.status;
    const desc = (data.description ?? '').toLowerCase();
    let outcome: SurveyDmOutcome;
    if (code === 403) {
      outcome = 'bot_blocked';
    } else if (code === 400 && (desc.includes('chat not found') || desc.includes('user is deactivated'))) {
      outcome = 'chat_not_found';
    } else if (code === 429 || code >= 500) {
      outcome = 'transient_failure';
    } else {
      outcome = 'permanent_failure';
    }
    logger.warn(
      { chatIdTail, httpStatus: r.status, errorCode: code, description: data.description, outcome },
      'survey invite DM rejected by Telegram',
    );
    return outcome;
  } catch (err) {
    clearTimeout(timer);
    logger.warn(
      { chatIdTail, err: err instanceof Error ? err.message : String(err) },
      'survey invite DM fetch error (transient)',
    );
    return 'transient_failure';
  }
}
