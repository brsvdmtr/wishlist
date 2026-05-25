// Referral retention scheduler — daily cron that emits
// `referral.invitee_retained_d7` / `referral.invitee_retained_d30` events
// for invitees who showed activity in the days following their attribution.
//
// These two events are declared in the analytics allowlist as P0 metrics for
// referral LTV/ROI evaluation (see docs/research/02-analytics-audit.md § 6.1
// row 13). Before this scheduler they were never emitted — the program was
// invisible from the retention angle.
//
// Definition of "retained":
//   d7  — invitee has any UserDailyActivity row with sessionStarted > 0
//         between (attributedAt + 6 days) and (attributedAt + 8 days), UTC.
//   d30 — invitee has any such row between (attributedAt + 29 days) and
//         (attributedAt + 31 days), UTC.
// The 2-day windows absorb timezone slippage + occasional scheduler misses.
//
// Idempotency: before emitting we query AnalyticsEvent for an existing event
// of the same name with the same `attributionId` in props. A duplicate row
// would muddy the funnel — better to short-circuit. The query is cheap
// because AnalyticsEvent is indexed on event + createdAt.
//
// Cadence: once per day at 03:00 UTC (uses `setInterval(24h)` from boot;
// alignment relies on the boot-time being roughly stable — drift up to a few
// hours is acceptable, this is a coarse signal). Best-effort: any failure is
// logged and the next 24h run re-attempts the same cohort.

import type { PrismaClient } from '@wishlist/db';
import type { Logger } from 'pino';

export type ReferralRetentionSchedulerDeps = {
  prisma: PrismaClient;
  logger: Logger;
  trackAnalyticsEvent: (input: {
    event: string;
    userId?: string;
    props?: Record<string, unknown>;
  }) => void;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_TICK_MS = 24 * 60 * 60 * 1000; // 24h

type RetentionWindow = { event: string; deltaDays: number };
const WINDOWS: RetentionWindow[] = [
  { event: 'referral.invitee_retained_d7', deltaDays: 7 },
  { event: 'referral.invitee_retained_d30', deltaDays: 30 },
];

export async function runReferralRetentionTick(deps: ReferralRetentionSchedulerDeps): Promise<{
  emitted: { d7: number; d30: number };
}> {
  const { prisma, logger, trackAnalyticsEvent } = deps;
  const now = Date.now();
  let emittedD7 = 0;
  let emittedD30 = 0;

  for (const win of WINDOWS) {
    const lowerEnd = new Date(now - (win.deltaDays + 1) * DAY_MS);
    const upperEnd = new Date(now - (win.deltaDays - 1) * DAY_MS);

    const cohort = await prisma.referralAttribution.findMany({
      where: {
        attributedAt: { gte: lowerEnd, lt: upperEnd },
        status: { in: ['QUALIFIED', 'REWARDED', 'PENDING_ACTIVATION'] },
      },
      select: { id: true, invitedUserId: true, inviterUserId: true, attributedAt: true },
    });

    for (const att of cohort) {
      const activityWindowStart = new Date(att.attributedAt.getTime() + (win.deltaDays - 1) * DAY_MS);
      const activityWindowEnd = new Date(att.attributedAt.getTime() + (win.deltaDays + 1) * DAY_MS);

      const activity = await prisma.userDailyActivity.findFirst({
        where: {
          userId: att.invitedUserId,
          date: { gte: activityWindowStart, lt: activityWindowEnd },
          sessionStarted: { gt: 0 },
        },
        select: { userId: true },
      });
      if (!activity) continue;

      const alreadyEmitted = await prisma.analyticsEvent.findFirst({
        where: {
          event: win.event,
          props: { path: ['attributionId'], equals: att.id },
        },
        select: { id: true },
      });
      if (alreadyEmitted) continue;

      trackAnalyticsEvent({
        event: win.event,
        userId: att.invitedUserId,
        props: {
          attributionId: att.id,
          inviterUserId: att.inviterUserId,
          deltaDays: win.deltaDays,
        },
      });
      if (win.deltaDays === 7) emittedD7++;
      else emittedD30++;
    }
  }

  logger.info(
    { emittedD7, emittedD30 },
    '[referral-retention] tick complete',
  );
  return { emitted: { d7: emittedD7, d30: emittedD30 } };
}

export function startReferralRetentionSchedulers(deps: ReferralRetentionSchedulerDeps): void {
  const { logger } = deps;
  // First tick at +5 min from boot so we don't pile work onto cold-start;
  // subsequent ticks every 24h. setInterval drift is tolerable here.
  setTimeout(() => {
    runReferralRetentionTick(deps).catch((err) =>
      logger.error({ err }, '[referral-retention] first tick failed'),
    );
    setInterval(() => {
      runReferralRetentionTick(deps).catch((err) =>
        logger.error({ err }, '[referral-retention] tick failed'),
      );
    }, RETENTION_TICK_MS);
  }, 5 * 60 * 1000);
}
