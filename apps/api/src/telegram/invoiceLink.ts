// Create a Telegram Stars invoice link. Wraps the raw TG API call with a
// single retry on network failure (timeout / DNS / IPv4 block) so a transient
// blip doesn't surface as an unhandled 500 in a billing handler.
//
// Returns a discriminated union so callers can distinguish:
//   - ok=true              → use .url
//   - ok=false, retryable  → network problem, suggest retry (503)
//   - ok=false, !retryable → Telegram rejected (invalid payload/etc), 502
//
// Observed root cause: 2026-04-20 unhandled 500 on /tg/billing/pro/checkout
// from `fetch failed: Connect Timeout Error` on the TG API. The whole request
// was lost — user saw a plain 500 instead of a retry hint.

import logger from '../logger';

export type InvoiceLinkResult =
  | { ok: true; url: string }
  | { ok: false; retryable: boolean; description?: string };

export async function createTgInvoiceLink(
  botToken: string,
  invoiceBody: Record<string, unknown>,
): Promise<InvoiceLinkResult> {
  const url = `https://api.telegram.org/bot${botToken}/createInvoiceLink`;
  const payload = JSON.stringify(invoiceBody);
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const tgRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
      const data = (await tgRes.json()) as { ok: boolean; result?: string; description?: string };
      if (data.ok && data.result) return { ok: true, url: data.result };
      // Telegram returned a structured rejection — not retryable (invalid payload,
      // blocked bot, etc). Surface description so caller can log + toast.
      return { ok: false, retryable: false, description: data.description };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt < 2) {
        // Small backoff before the retry attempt.
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
    }
  }

  logger.warn({ err: lastError }, 'createTgInvoiceLink network failure after retry');
  return { ok: false, retryable: true, description: lastError };
}
