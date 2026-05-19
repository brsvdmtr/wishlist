// Daily product-loop rollup scheduler.
//
// Re-aggregates the last two UTC calendar days (yesterday + today) once
// an hour. Two days is the minimum window that covers:
//   - late-arriving events on yesterday (writers buffer / retry briefly);
//   - today's in-progress totals so dashboards stay near-real-time.
//
// The aggregator is idempotent (see services/daily-activity.service.ts),
// so re-running on the same day overwrites the prior row with the same
// computed counters. No duplicate-row risk.
//
// Errors are logged but never thrown out of setInterval — the next tick
// re-attempts. The optional startup tick aggregates yesterday once at
// boot so a long restart window doesn't leave the rollup stale.

import type { PrismaClient } from '@wishlist/db';
import type { Logger } from 'pino';

import { aggregateDay, startOfUtcDay } from '../services/daily-activity.service';

export type DailyActivityRollupSchedulerDeps = {
  prisma: PrismaClient;
  logger: Logger;
  /** Override the clock in tests. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Override interval in tests. Defaults to 1 hour. */
  intervalMs?: number;
  /** Run one tick immediately on boot. Defaults to true. */
  runOnStart?: boolean;
};

const DEFAULT_INTERVAL_MS = 60 * 60 * 1000;

export function startDailyActivityRollupScheduler(deps: DailyActivityRollupSchedulerDeps): void {
  const {
    prisma,
    logger,
    now = () => new Date(),
    intervalMs = DEFAULT_INTERVAL_MS,
    runOnStart = true,
  } = deps;

  async function tick(): Promise<void> {
    try {
      const today = startOfUtcDay(now());
      const yesterday = new Date(today.getTime() - 86_400_000);
      const y = await aggregateDay(prisma, yesterday, { logger });
      const t = await aggregateDay(prisma, today, { logger });
      logger.info(
        {
          yesterday: { date: y.date.toISOString().slice(0, 10), users: y.users, events: y.events },
          today: { date: t.date.toISOString().slice(0, 10), users: t.users, events: t.events },
        },
        '[daily-activity] rollup tick complete',
      );
    } catch (err) {
      logger.error({ err }, '[daily-activity] rollup tick failed');
    }
  }

  if (runOnStart) {
    void tick();
  }

  setInterval(() => {
    void tick();
  }, intervalMs);
}
