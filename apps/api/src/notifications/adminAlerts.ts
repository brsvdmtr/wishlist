// Send a startup / failure alert to every chat ID in ADMIN_ALERT_CHAT_IDS.
//
// Uses raw fetch (not sendTgBotMessage) deliberately:
//   - the alert path runs from process-wide handlers (uncaughtException,
//     unhandledRejection, startup confirmation) where we don't want any extra
//     dependencies to potentially throw;
//   - Promise.allSettled fires every chat in parallel so a single broken
//     chat ID can't stall the others.
// HTML parse_mode is the contract — all alert messages elsewhere use
// <b>/<i>/<code> tags.

export async function sendAdminAlert(text: string): Promise<void> {
  const token = process.env.BOT_TOKEN;
  const chatIds = (process.env.ADMIN_ALERT_CHAT_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!token || chatIds.length === 0) return;
  await Promise.allSettled(
    chatIds.map((chatId) =>
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      }),
    ),
  );
}
