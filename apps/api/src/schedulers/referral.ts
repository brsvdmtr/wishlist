// Referral schedulers (P5r-3) — extracted from apps/api/src/index.ts.
// Single 15-min cron that sweeps expired PENDING_ACTIVATION rows in the
// referral attribution table and emits a single aggregated analytics
// event per run. Cadence (15 * 60 * 1000 ms), log labels, and structured
// fields preserved byte-identical.
//
// Best-effort: errors logged but never bubble out of setInterval; next
// 15-minute cycle re-attempts.

import type { PrismaClient } from '@wishlist/db';
import type { Logger } from 'pino';

// Minimal structural types so this scheduler doesn't pull large app-wide
// types just for elegance. Mirrors the actual signatures in @wishlist/db
// and apps/api/src/index.ts (trackAnalyticsEvent helper).
type SweepResult = { expired: number };

export type ReferralSchedulerDeps = {
  prisma: PrismaClient;
  logger: Logger;
  trackAnalyticsEvent: (input: {
    event: string;
    userId?: string;
    props?: Record<string, unknown>;
  }) => void;
  sweepExpiredPendingAttributions: (prisma: PrismaClient) => Promise<SweepResult>;
};

export function startReferralSchedulers(deps: ReferralSchedulerDeps): void {
  const { prisma, logger, trackAnalyticsEvent, sweepExpiredPendingAttributions } = deps;

  // ─── Referral program: expired-attribution sweeper (every 15 min) ────────────
  // Flips PENDING_ACTIVATION rows past windowDeadlineAt → REJECTED with
  // QUALIFICATION_TIMEOUT. Drains up to SWEEP_BATCH_SIZE × SWEEP_MAX_ITERATIONS
  // per run so a backlog spike is absorbed without ad-hoc scripts. Emits a single
  // aggregated analytics event per run; per-user funnel events are already
  // covered by the attribution/qualified/rewarded events.
  const REFERRAL_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
  setInterval(async () => {
    try {
      const result = await sweepExpiredPendingAttributions(prisma);
      if (result.expired > 0) {
        logger.info({ expired: result.expired }, '[referral] sweep: expired pending attributions');
        trackAnalyticsEvent({
          event: 'referral.qualification_timeout',
          props: { expired: result.expired, source: 'cron' },
        });
      }
    } catch (err) {
      logger.error({ err }, '[referral] sweep failed');
    }
  }, REFERRAL_SWEEP_INTERVAL_MS);
}
