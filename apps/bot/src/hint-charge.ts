// Fire-and-forget charge of a delivered hint against the sender's FREE monthly
// hint quota. Extracted from the users_shared handler so the bounded retry is
// unit-testable in isolation. See apps/api POST /internal/hints/credit.

import logger from './logger';

/**
 * Charge a delivered hint via the internal API, with a bounded 3-attempt
 * retry. The charge is idempotent on hintId server-side (HintQuotaCharge.hintId
 * UNIQUE), so retrying a transient API blip is safe and cheap.
 *
 * If every attempt fails (e.g. a long API restart) the charge is lost and
 * fails OPEN — the user keeps the hint uncharged. v1 has no reconciliation
 * sweep; that is an accepted tradeoff.
 *
 * Never throws. The caller `void`s the returned promise — it is exposed only
 * so tests can await completion. `backoffBaseMs` is injectable so tests run
 * without real delays.
 */
export async function chargeDeliveredHint(
  hintId: string,
  apiBaseUrl: string,
  internalKey: string,
  backoffBaseMs = 1000,
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${apiBaseUrl}/internal/hints/credit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-INTERNAL-KEY': internalKey },
        body: JSON.stringify({ hintId }),
      });
      if (res.ok) {
        const body = (await res.json().catch(() => ({}))) as { outcome?: string; charged?: boolean };
        logger.info(
          { hintId, attempt, outcome: body.outcome, charged: body.charged },
          'hint_quota_charge_done',
        );
        return;
      }
      logger.warn({ hintId, attempt, status: res.status }, 'hint_quota_charge_attempt_failed');
    } catch (err) {
      logger.warn({ err, hintId, attempt }, 'hint_quota_charge_attempt_threw');
    }
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * backoffBaseMs));
  }
  // All retries exhausted — the charge is lost. Fails open (the user keeps the
  // hint); safe because consumeHintCharge is idempotent if ever re-run.
  logger.error({ hintId }, 'hint_quota_charge_failed');
}
