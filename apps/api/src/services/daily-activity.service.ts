// Daily product-loop rollup — aggregates AnalyticsEvent into one
// UserDailyActivity row per (userId, UTC calendar day).
//
// AnalyticsEvent has a 90-day TTL, so any retention or funnel query past
// that horizon (D60/D90 cohorts, weekly share-rate trend, paywall conversion
// over a month) has to be answered off this durable rollup. The aggregator
// is idempotent — the scheduler re-runs it hourly over yesterday + today,
// and the backfill script reuses it over an arbitrary range. Re-running
// recomputes the counters from scratch and `upsert` overwrites prior rows,
// so duplicates are impossible by construction.
//
// Timezone choice: all date bucketing is UTC. Dashboards built on top of
// this table treat dates as UTC calendar days — see
// docs/research/core-loop-dashboard.md for the trade-off vs. Europe/Berlin
// reporting.

import type { Prisma, PrismaClient } from '@wishlist/db';
import type { Logger } from 'pino';

/**
 * Counter column names on `UserDailyActivity`. Keep in sync with the
 * Prisma model and the EVENT_TO_FIELD mapping below.
 */
export const COUNTER_FIELDS = [
  'sessionStarted',
  'createdRealWish',
  'createdWishlist',
  'sharedWishlist',
  'guestOpened',
  'reservedItem',
  'convertedGuestToOwner',
  'paywallViewed',
  'checkoutStarted',
  'paymentCompleted',
  'proActivated',
  'usedUrlImport',
  'usedHint',
] as const;

export type CounterField = (typeof COUNTER_FIELDS)[number];

export type DailyCounters = Record<CounterField, number>;

/**
 * Event-name → counter-field mapping. Anything not in this table is
 * silently dropped at aggregation time (we only roll up product-loop
 * signals, not the entire AnalyticsEvent firehose).
 *
 * Notes on judgement calls — see the dashboard doc for full reasoning:
 *  - `sharedWishlist` ← `share.token_generated` (server-emitted; the
 *    client-side `wishlist.shared` overlaps the same flow and would
 *    double-count if both were summed). SEMANTICS: this counts
 *    "created the share affordance" (token minted), NOT "actually
 *    delivered the link to a friend". For end-to-end share success
 *    cross-reference `guestOpened` + `reservedItem` downstream.
 *  - `checkoutStarted` ← both legacy `checkout_started` (Telegram
 *    billing handler) and new `paywall.cta_clicked` (typed funnel).
 *    They fire on disjoint code paths, so summation is correct.
 *    SEMANTICS: read as monetization INTENT, not invoice creation —
 *    `paywall.cta_clicked` is an upgrade-button click and may not
 *    have produced an actual Telegram invoice. The downstream
 *    `paymentCompleted` is the only ground-truth revenue signal.
 *  - `usedUrlImport` ← `import.started` (engagement signal; success is
 *    captured separately by `import.succeeded` but the question "did
 *    the user try the importer" matters for retention).
 *  - `usedHint` ← `hint_created` (the only durable hint-side event we
 *    persist server-side today; `feature_gate_hit_hints` is a paywall
 *    miss, not a use).
 */
export const EVENT_TO_FIELD: Readonly<Record<string, CounterField>> = Object.freeze({
  'user.session_started': 'sessionStarted',
  'wish.created': 'createdRealWish',
  'wishlist.created': 'createdWishlist',
  'share.token_generated': 'sharedWishlist',
  'guest.view_opened': 'guestOpened',
  'reservation.succeeded': 'reservedItem',
  'guest.converted_to_user': 'convertedGuestToOwner',
  'paywall.viewed': 'paywallViewed',
  'checkout_started': 'checkoutStarted',
  'paywall.cta_clicked': 'checkoutStarted',
  'payment.completed': 'paymentCompleted',
  'pro.activated': 'proActivated',
  'import.started': 'usedUrlImport',
  'hint_created': 'usedHint',
});

/** Distinct event names the aggregator pulls from AnalyticsEvent. */
export const TRACKED_EVENT_NAMES: ReadonlyArray<string> = Object.freeze(
  Array.from(new Set(Object.keys(EVENT_TO_FIELD))),
);

export function emptyCounters(): DailyCounters {
  const out = {} as DailyCounters;
  for (const f of COUNTER_FIELDS) out[f] = 0;
  return out;
}

/**
 * Pure mapper. Takes a list of raw analytics events and returns the
 * per-user counter buckets. No I/O, no clock, no DB — pure data
 * transformation, fully unit-testable.
 *
 * Events with no `userId` or with an unmapped `event` name are dropped.
 */
export function mapEventsToCounters(
  events: ReadonlyArray<{ event: string; userId: string | null }>,
): Map<string, DailyCounters> {
  const byUser = new Map<string, DailyCounters>();
  for (const ev of events) {
    if (!ev.userId) continue;
    const field = EVENT_TO_FIELD[ev.event];
    if (!field) continue;
    let bucket = byUser.get(ev.userId);
    if (!bucket) {
      bucket = emptyCounters();
      byUser.set(ev.userId, bucket);
    }
    bucket[field] += 1;
  }
  return byUser;
}

/**
 * Normalize an arbitrary Date to the start of its UTC calendar day —
 * 00:00:00.000Z. Used both for the lower bound of the AnalyticsEvent
 * scan and as the `date` value upserted into UserDailyActivity (Prisma
 * `@db.Date` columns are stored as DATE in Postgres; passing a Date
 * with non-zero UTC time is safe but normalizing keeps the value
 * round-trip-stable in tests).
 */
export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

/**
 * Exclusive upper bound for the AnalyticsEvent scan — start of the
 * next UTC day. Using a half-open `[start, end)` window avoids any
 * millisecond-boundary ambiguity at 23:59:59.999.
 */
export function startOfNextUtcDay(d: Date): Date {
  const s = startOfUtcDay(d);
  return new Date(s.getTime() + 86_400_000);
}

export type AggregateDayOptions = {
  /** Skip writes; return what would be written. Used by backfill --dry-run. */
  dryRun?: boolean;
  /** Logger for per-day summary. */
  logger?: Logger;
};

export type AggregateDayResult = {
  /** UTC start-of-day Date that was aggregated. */
  date: Date;
  /** Distinct users that had ≥1 tracked event on this day AND still exist in `User`. */
  users: number;
  /** Raw AnalyticsEvent rows scanned for this day. */
  events: number;
  /**
   * Distinct user-buckets dropped pre-upsert because their userId no longer
   * resolves to a `User` row (hard-deleted account). `AnalyticsEvent.userId`
   * is a soft pointer (no FK); `UserDailyActivity.userId` enforces FK, so
   * we filter the gap explicitly. Surfaced for ops visibility — a sudden
   * spike here means somebody bulk-deleted users, not a data corruption.
   */
  droppedUsers: number;
  /** Whether DB writes were skipped (dryRun=true). */
  dryRun: boolean;
};

/**
 * Aggregate one UTC calendar day. Pulls every tracked AnalyticsEvent for
 * the day, maps to counters, upserts one row per user. Idempotent:
 * re-running on the same day produces the same row contents (we SET, not
 * INCREMENT).
 *
 * Returns the counts so the caller (scheduler / backfill) can log progress
 * without re-querying.
 */
export async function aggregateDay(
  prisma: PrismaClient,
  day: Date,
  opts: AggregateDayOptions = {},
): Promise<AggregateDayResult> {
  const start = startOfUtcDay(day);
  const end = startOfNextUtcDay(day);

  const rows = await prisma.analyticsEvent.findMany({
    where: {
      createdAt: { gte: start, lt: end },
      userId: { not: null },
      event: { in: [...TRACKED_EVENT_NAMES] },
    },
    select: { event: true, userId: true },
  });

  const byUser = mapEventsToCounters(rows);

  // FK safety: AnalyticsEvent.userId is a soft pointer (nullable, no FK,
  // matches schema.prisma:1369-1382). UserDailyActivity.userId DOES enforce
  // a CASCADE FK on User. If a user got hard-deleted after their events
  // landed in the log, the bucket survives in `byUser` here but the
  // subsequent upsert would 23503 P2003. The 2026-05-19 prod backfill
  // surfaced this with 34 dangling cuids over 175 events; see the
  // matching entry in docs/BUGFIX_LESSONS.md.
  let droppedUsers = 0;
  if (byUser.size > 0) {
    const candidateIds = Array.from(byUser.keys());
    const existing = await prisma.user.findMany({
      where: { id: { in: candidateIds } },
      select: { id: true },
    });
    const validIds = new Set(existing.map((u) => u.id));
    for (const id of candidateIds) {
      if (!validIds.has(id)) {
        byUser.delete(id);
        droppedUsers += 1;
      }
    }
  }

  if (!opts.dryRun) {
    for (const [userId, counters] of byUser) {
      const data: Prisma.UserDailyActivityUncheckedCreateInput = {
        userId,
        date: start,
        ...counters,
      };
      await prisma.userDailyActivity.upsert({
        where: { userId_date: { userId, date: start } },
        create: data,
        update: counters,
      });
    }
  }

  opts.logger?.info(
    {
      date: start.toISOString().slice(0, 10),
      users: byUser.size,
      events: rows.length,
      droppedUsers,
      dryRun: !!opts.dryRun,
    },
    '[daily-activity] day aggregated',
  );

  return {
    date: start,
    users: byUser.size,
    events: rows.length,
    droppedUsers,
    dryRun: !!opts.dryRun,
  };
}

/**
 * Aggregate a range `[fromDay, toDay]` (inclusive on both ends, day-stepped
 * in UTC). Both endpoints are normalized to start-of-day. Sequential to
 * keep the load predictable — a 90-day backfill is < 90 small queries.
 */
export async function aggregateDateRange(
  prisma: PrismaClient,
  fromDay: Date,
  toDay: Date,
  opts: AggregateDayOptions = {},
): Promise<AggregateDayResult[]> {
  const start = startOfUtcDay(fromDay);
  const end = startOfUtcDay(toDay);
  if (end.getTime() < start.getTime()) {
    throw new Error(`aggregateDateRange: fromDay > toDay (${start.toISOString()} > ${end.toISOString()})`);
  }
  const results: AggregateDayResult[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
    results.push(await aggregateDay(prisma, new Date(t), opts));
  }
  return results;
}
