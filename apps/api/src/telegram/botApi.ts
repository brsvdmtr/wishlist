// Direct Telegram Bot API senders. Both functions read BOT_TOKEN at call time
// (so a key rotation via env reload picks up immediately) and never throw.
//
//   sendTgNotification — fire-and-forget plain text. Used for owner alerts,
//                        reserver notifications, lifecycle DMs, etc.
//   sendTgBotMessage   — sends with optional reply_markup (inline keyboards).
//                        Returns true on Telegram-confirmed delivery, logs
//                        the description on API rejection.
//
// Both wrap the fetch in an AbortController-driven timeout. sendTgBotMessage
// also retries once on a network/timeout failure (NOT on a structured TG
// rejection — those are not transient). Same shape as createTgInvoiceLink:
// the goal is to fail fast with `false` instead of hanging the caller for
// tens of seconds when Telegram is briefly unreachable. Observed root cause:
// 2026-05-01 hint flow stuck for ~7 s on first attempt, client aborted with
// no error toast; user clicked "hint friends" three times in 34 s before
// the third attempt found Telegram healthy.

import logger from '../logger';

const TG_FETCH_TIMEOUT_MS = 6000;

export async function sendTgNotification(chatId: string, text: string): Promise<void> {
  const token = process.env.BOT_TOKEN;
  if (!token || !chatId) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TG_FETCH_TIMEOUT_MS);
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: controller.signal,
    });
  } catch {
    // best-effort, don't fail the main operation
  } finally {
    clearTimeout(timer);
  }
}

export async function sendTgBotMessage(
  chatId: string,
  text: string,
  replyMarkup?: Record<string, unknown>,
): Promise<boolean> {
  const token = process.env.BOT_TOKEN;
  if (!token || !chatId) return false;

  const payload: Record<string, unknown> = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const body = JSON.stringify(payload);
  const url = `https://api.telegram.org/bot${token}/sendMessage`;

  let lastError: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TG_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const data = await resp.json() as { ok: boolean; description?: string };
      if (!data.ok) {
        // Telegram returned a structured rejection (bot blocked, invalid
        // chat_id, etc). Not retryable — return false so the caller can
        // surface it.
        logger.error({ description: data.description, chatId }, 'sendTgBotMessage Telegram API error');
        return false;
      }
      return true;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      if (attempt < 2) {
        // Small backoff before retry. Mirrors createTgInvoiceLink semantics.
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
    }
  }

  logger.error({ err: lastError, chatId }, 'sendTgBotMessage network failure after retry');
  return false;
}
