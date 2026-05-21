// Credit model for "hint friends" — the soft-virality monetization fix.
//
// "Hint friends" is no longer a hard PRO gate. FREE users get
// FREE_HINT_QUOTA_PER_MONTH delivered hints per UTC calendar month; PRO is
// unlimited; paid hints_pack_* credits (UserCredits.hintCredits) top up
// beyond the free allowance.
//
// THE KEY DIFFERENCE FROM import-credits: the quota is charged on DELIVERY,
// not on creation. POST /tg/items/:id/hint only does a read-only allowance
// check (getHintAllowance); the actual charge (consumeHintCharge) runs later,
// when the bot reports the hint DELIVERED via POST /internal/hints/credit.
// A hint that is never delivered (keyboard lost, picker abandoned, item
// reserved, hint expired) costs the user nothing.
//
// AUDIT LEDGER: every charge writes a HintQuotaCharge row (who, which hint,
// when, source, charged). hintId is UNIQUE → idempotent: a duplicate
// users_shared event can never charge twice. "Free hints used this month" is
// a COUNT over the ledger — there is no counter column to drift.
//
// GRACE: if the FREE quota was available at wave creation but exhausted by
// delivery time (a concurrent hint drained it), we still deliver — the row is
// written source='grace', charged=false. We never break a scenario the user
// has already started.
//
// Consumers:
//   - routes/hints.routes.ts    — getHintAllowance (the wave-creation gate)
//   - routes/internal.routes.ts — consumeHintCharge (the bot delivery hook)
//   - services/entitlement.ts   — resolveFreeHints (the counter payload)

import { prisma } from '@wishlist/db';

import logger from '../logger';
import { trackProductEvent } from './analytics';
import { currentImportPeriod } from './import-credits';

/** FREE-tier delivered hints per UTC calendar month. Env-tunable so the quota
 *  can be A/B'd without a redeploy; a value of 0 disables the free tier (FREE
 *  then needs paid credits or PRO). */
export const FREE_HINT_QUOTA_PER_MONTH = Math.max(
  0,
  parseInt(process.env.FREE_HINT_QUOTA_PER_MONTH ?? '3', 10) || 0,
);

/** UTC calendar-month bucket "YYYY-MM". Reuses the import-quota helper so the
 *  month-rollover math has exactly one definition across both quotas. */
export const currentHintPeriod = currentImportPeriod;

export type FreeHintState = {
  freeLimit: number;
  freeUsed: number;
  freeRemaining: number;
};

/** Pure: clamp a raw ledger count into the period's free-hint state so the
 *  displayed counter never goes negative or past the limit. */
export function resolveFreeHints(usedCount: number): FreeHintState {
  const freeLimit = FREE_HINT_QUOTA_PER_MONTH;
  const freeUsed = Math.min(Math.max(usedCount, 0), freeLimit);
  return { freeLimit, freeUsed, freeRemaining: Math.max(0, freeLimit - freeUsed) };
}

export type HintAllowance = FreeHintState & {
  allowed: boolean;
  isPro: boolean;
  paidCredits: number;
  /** Which bucket the next delivered hint would draw from. */
  source: 'pro' | 'free' | 'paid' | 'none';
};

/** Count of FREE monthly hints already charged this period. The ledger is the
 *  source of truth — deleting a wish/Hint never refunds quota because the
 *  charge row is not FK-linked to the Hint. */
async function countFreeHintsCharged(userId: string, period: string): Promise<number> {
  return prisma.hintQuotaCharge.count({
    where: { userId, period, source: 'free_monthly', charged: true },
  });
}

/** Read-only: can this user START a hint wave right now? PRO is always allowed
 *  (unlimited); FREE is allowed while monthly quota OR paid credits remain.
 *  The actual decrement happens later, in consumeHintCharge() on delivery —
 *  getHintAllowance never writes.
 *
 *  This gate is ADVISORY, not authoritative: it is NOT serialized against
 *  consumeHintCharge, so several near-simultaneous wave creations can all pass
 *  it with only one credit left. That is acceptable — the real cap lives in
 *  the charge transaction's advisory lock, and an over-admitted wave that is
 *  still delivered is recorded as 'grace' (charged:false), never overcharged. */
export async function getHintAllowance(userId: string, isPro: boolean): Promise<HintAllowance> {
  const freeLimit = FREE_HINT_QUOTA_PER_MONTH;
  if (isPro) {
    return {
      allowed: true,
      isPro: true,
      freeLimit,
      freeUsed: 0,
      freeRemaining: freeLimit,
      paidCredits: 0,
      source: 'pro',
    };
  }
  const [usedCount, credits] = await Promise.all([
    countFreeHintsCharged(userId, currentHintPeriod()),
    prisma.userCredits.findUnique({ where: { userId } }),
  ]);
  const free = resolveFreeHints(usedCount);
  const paidCredits = credits?.hintCredits ?? 0;
  const source: HintAllowance['source'] =
    free.freeRemaining > 0 ? 'free' : paidCredits > 0 ? 'paid' : 'none';
  return { ...free, allowed: source !== 'none', isPro: false, paidCredits, source };
}

/** FREE-hint counter for the entitlement payload — period-aware, read-only. */
export async function getFreeHintsState(userId: string): Promise<FreeHintState> {
  const used = await countFreeHintsCharged(userId, currentHintPeriod());
  return resolveFreeHints(used);
}

export type HintStatus = 'SENT' | 'DELIVERED' | 'CANCELLED' | 'EXPIRED';

export type HintChargeOutcome =
  | 'free_monthly'
  | 'paid_pack'
  | 'grace'
  | 'pro'
  | 'replay'
  | 'not_delivered';

export type ConsumeHintResult = FreeHintState & {
  outcome: HintChargeOutcome;
  charged: boolean;
};

/** Charge ONE delivered hint. Called by POST /internal/hints/credit after the
 *  bot flips a hint SENT → DELIVERED.
 *
 *  Idempotent on hintId — the HintQuotaCharge.hintId UNIQUE index means a
 *  duplicate users_shared event (Telegram double-fire) or an internal-call
 *  retry returns outcome 'replay' without a second charge.
 *
 *  Order: FREE monthly quota → paid hintCredits → grace. PRO never spends
 *  quota. 'grace' = the FREE quota was free at wave-creation but exhausted by
 *  delivery; we deliver anyway, recorded uncharged, rather than break a
 *  scenario the user already started.
 *
 *  Race-safety: the whole decision runs inside one transaction holding a
 *  per-user advisory lock, so two hints delivered at the same instant can
 *  never both slip past the monthly cap. */
export async function consumeHintCharge(
  userId: string,
  hintId: string,
  status: HintStatus,
  isPro: boolean,
): Promise<ConsumeHintResult> {
  // Only a DELIVERED hint is chargeable. An undelivered hint — still SENT, or
  // CANCELLED / EXPIRED because the picker was abandoned or the keyboard never
  // landed — costs the user nothing. This is the "charge on delivery, never on
  // creation" contract; the guard lives in the service so it holds for every
  // caller, not just the route.
  if (status !== 'DELIVERED') {
    return {
      freeLimit: FREE_HINT_QUOTA_PER_MONTH,
      freeUsed: 0,
      freeRemaining: FREE_HINT_QUOTA_PER_MONTH,
      outcome: 'not_delivered',
      charged: false,
    };
  }
  const period = currentHintPeriod();

  const decision = await prisma.$transaction(
    async (
      tx,
    ): Promise<{
      outcome: Exclude<HintChargeOutcome, 'not_delivered'>;
      charged: boolean;
      freeUsedAfter: number;
    }> => {
      // Serialize every hint charge for THIS user — the cap COUNT below must
      // not be read stale by a sibling charge. pg_advisory_xact_lock releases
      // automatically at COMMIT/ROLLBACK and needs no row to exist. Run via
      // $executeRaw, not $queryRaw: the function returns `void`, which
      // $queryRaw cannot deserialize as a result column.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`hint_quota:${userId}`})::bigint)`;

      // Free-monthly charges already spent this period — counted under the
      // lock, so the cap check AND the post-charge count (freeUsedAfter) both
      // derive from one race-free read. freeUsedAfter is returned rather than
      // re-counted post-commit, where a sibling charge could skew it and make
      // hint.free_quota_exhausted fire zero or twice.
      const freeUsedBefore = await tx.hintQuotaCharge.count({
        where: { userId, period, source: 'free_monthly', charged: true },
      });

      // Idempotency — a ledger row for this hintId means it is already done.
      // 'replay' reports charged:false: THIS call spent nothing (the original
      // charge already happened and is the only one the ledger records).
      const existing = await tx.hintQuotaCharge.findUnique({
        where: { hintId },
        select: { id: true },
      });
      if (existing) return { outcome: 'replay', charged: false, freeUsedAfter: freeUsedBefore };

      // PRO — record the delivery, never spend quota.
      if (isPro) {
        await tx.hintQuotaCharge.create({
          data: { userId, hintId, period, source: 'pro', charged: false },
        });
        return { outcome: 'pro', charged: false, freeUsedAfter: freeUsedBefore };
      }

      // FREE — monthly quota first.
      if (FREE_HINT_QUOTA_PER_MONTH > 0 && freeUsedBefore < FREE_HINT_QUOTA_PER_MONTH) {
        await tx.hintQuotaCharge.create({
          data: { userId, hintId, period, source: 'free_monthly', charged: true },
        });
        return { outcome: 'free_monthly', charged: true, freeUsedAfter: freeUsedBefore + 1 };
      }

      // Free quota full → spend a paid pack credit. The per-user advisory
      // lock above serializes a user's charges; the hintCredits > 0 filter is
      // the backstop so a zero balance can never go negative.
      const paid = await tx.userCredits.updateMany({
        where: { userId, hintCredits: { gt: 0 } },
        data: { hintCredits: { decrement: 1 } },
      });
      if (paid.count > 0) {
        await tx.hintQuotaCharge.create({
          data: { userId, hintId, period, source: 'paid_pack', charged: true },
        });
        return { outcome: 'paid_pack', charged: true, freeUsedAfter: freeUsedBefore };
      }

      // Quota AND paid credits both gone, but the wave was allowed at
      // creation. Grace: deliver, record, do not charge.
      await tx.hintQuotaCharge.create({
        data: {
          userId,
          hintId,
          period,
          source: 'grace',
          charged: false,
          reason: 'quota_changed_after_wave_started',
        },
      });
      return { outcome: 'grace', charged: false, freeUsedAfter: freeUsedBefore };
    },
    { timeout: 15000 },
  );

  // freeUsedAfter was counted inside the lock, so resolveFreeHints on it is
  // race-free — hint.free_quota_exhausted fires exactly once, on the charge
  // that brings the month to the cap.
  const free = resolveFreeHints(decision.freeUsedAfter);

  if (decision.outcome === 'grace') {
    logger.info({ userId, hintId, period }, 'hint_quota.grace_delivery');
  }
  if (decision.outcome !== 'replay') {
    emitHintChargeAnalytics(userId, hintId, decision.outcome, free);
  }

  return { ...free, outcome: decision.outcome, charged: decision.charged };
}

/** Emit the product event for a completed (non-replay) hint charge. */
function emitHintChargeAnalytics(
  userId: string,
  hintId: string,
  outcome: Exclude<HintChargeOutcome, 'replay' | 'not_delivered'>,
  free: FreeHintState,
): void {
  if (outcome === 'free_monthly') {
    trackProductEvent({
      event: 'hint.free_quota_charged',
      userId,
      props: {
        hintId,
        freeUsed: free.freeUsed,
        freeLimit: free.freeLimit,
        freeRemaining: free.freeRemaining,
      },
    });
    // Fires once, when this hint drains the last free credit of the month.
    if (free.freeRemaining === 0) {
      trackProductEvent({
        event: 'hint.free_quota_exhausted',
        userId,
        props: { hintId, freeLimit: free.freeLimit },
      });
    }
    return;
  }
  // pro | paid_pack | grace — the FREE quota was not charged.
  trackProductEvent({
    event: 'hint.free_quota_charge_skipped',
    userId,
    props: { hintId, reason: outcome },
  });
}
