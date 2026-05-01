// Direct Telegram Bot API senders. Both functions read BOT_TOKEN at call time
// (so a key rotation via env reload picks up immediately) and never throw.
//
//   sendTgNotification — fire-and-forget plain text. Used for owner alerts,
//                        reserver notifications, lifecycle DMs, etc.
//   sendTgBotMessage   — sends with optional reply_markup (inline keyboards).
//                        Returns true on Telegram-confirmed delivery, logs
//                        the description on API rejection.

import logger from '../logger';

export async function sendTgNotification(chatId: string, text: string): Promise<void> {
  const token = process.env.BOT_TOKEN;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
    });
  } catch {
    // best-effort, don't fail the main operation
  }
}

export async function sendTgBotMessage(
  chatId: string,
  text: string,
  replyMarkup?: Record<string, unknown>,
): Promise<boolean> {
  const token = process.env.BOT_TOKEN;
  if (!token || !chatId) return false;
  try {
    const payload: Record<string, unknown> = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json() as { ok: boolean; description?: string };
    if (!data.ok) logger.error({ description: data.description, chatId }, 'sendTgBotMessage Telegram API error');
    return data.ok;
  } catch (err) {
    logger.error({ err }, 'sendTgBotMessage exception');
    return false;
  }
}
