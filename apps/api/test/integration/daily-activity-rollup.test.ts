// Integration tests for the daily-activity rollup against a real Postgres.
//
// Covers the four behaviours the unit tests can't:
//   1. AnalyticsEvent.findMany returns the events the aggregator expects
//      (column types, index usage, half-open [start, next) window).
//   2. Upsert on the composite (userId, date) PK is truly idempotent —
//      re-running on the same day produces zero duplicates and the same
//      counter values (not incremented).
//   3. UTC midnight is the day boundary: events at 23:59:59.999Z belong
//      to day D, events at 00:00:00.000Z belong to day D+1.
//   4. dryRun mode performs the read but never writes — important for
//      the backfill script's safety contract.
//
// Skipped locally unless DATABASE_URL is set (see test/README.md). CI
// provides Postgres via the workflow's service container.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pino from 'pino';

import { getTestPrisma, disconnectTestPrisma } from '../setup-pg';
import {
  aggregateDay,
  aggregateDateRange,
  startOfUtcDay,
} from '../../src/services/daily-activity.service';

const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;

// Unique per-file prefix — vitest parallelises test files against one
// shared DB.
const PREFIX = 'int-dailyact';

// Cuid-shaped "ghost" id used by the FK-safety test below. Defined at
// file scope so cleanup hooks can reset it across runs — the CI test job
// runs vitest twice (once for `pnpm test`, once for `pnpm test:coverage`)
// against the SAME Postgres, and the first run's ghost-id events outlive
// the userId-scoped beforeEach because no User row ever owned this id.
const GHOST_ID = 'c' + 'z'.repeat(24);

if (SKIP) {
  // eslint-disable-next-line no-console
  console.warn('[integration] DATABASE_URL not set — skipping daily-activity-rollup tests');
}

// Silent logger — keeps test output readable.
const silentLogger = pino({ level: 'silent' });

suite('daily-activity rollup — real Postgres', () => {
  let userA = '';
  let userB = '';

  async function cleanOwnData() {
    const db = getTestPrisma();
    // Order matters: UserDailyActivity FK → User; AnalyticsEvent.userId is
    // a soft pointer (no FK) but we still scope by our test users +
    // the ghost id used by the FK-safety test.
    await db.userDailyActivity.deleteMany({
      where: { user: { telegramId: { startsWith: PREFIX } } },
    });
    await db.analyticsEvent.deleteMany({
      where: { userId: { in: [userA, userB, GHOST_ID].filter(Boolean) } },
    });
    await db.user.deleteMany({ where: { telegramId: { startsWith: PREFIX } } });
  }

  beforeAll(async () => {
    const db = getTestPrisma();
    await cleanOwnData();
    const a = await db.user.create({ data: { telegramId: `${PREFIX}-a` } });
    const b = await db.user.create({ data: { telegramId: `${PREFIX}-b` } });
    userA = a.id;
    userB = b.id;
  });

  afterAll(async () => {
    await cleanOwnData();
    await disconnectTestPrisma();
  });

  beforeEach(async () => {
    const db = getTestPrisma();
    await db.userDailyActivity.deleteMany({ where: { userId: { in: [userA, userB] } } });
    // GHOST_ID has no User row so userDailyActivity.deleteMany above can't
    // touch it (and there should never be a UDA row for it anyway). We
    // still scope events by the three known ids — see comment on
    // GHOST_ID at top of file.
    await db.analyticsEvent.deleteMany({
      where: { userId: { in: [userA, userB, GHOST_ID] } },
    });
  });

  it('rolls up multiple AnalyticsEvent rows into one UserDailyActivity row per user', async () => {
    const db = getTestPrisma();
    const day = new Date('2026-04-15T00:00:00.000Z');

    // userA: 2 wishes + 1 share + 1 paywall view, all in the same UTC day.
    await db.analyticsEvent.createMany({
      data: [
        { event: 'wish.created', userId: userA, createdAt: new Date('2026-04-15T10:00:00.000Z') },
        { event: 'wish.created', userId: userA, createdAt: new Date('2026-04-15T11:30:00.000Z') },
        { event: 'share.token_generated', userId: userA, createdAt: new Date('2026-04-15T14:00:00.000Z') },
        { event: 'paywall.viewed', userId: userA, createdAt: new Date('2026-04-15T16:00:00.000Z') },
        // userB: only one session-start.
        { event: 'user.session_started', userId: userB, createdAt: new Date('2026-04-15T08:00:00.000Z') },
        // Unmapped event — should be ignored.
        { event: 'random.unmapped', userId: userA, createdAt: new Date('2026-04-15T12:00:00.000Z') },
        // Null userId — should be ignored.
        { event: 'wish.created', userId: null, createdAt: new Date('2026-04-15T13:00:00.000Z') },
      ],
    });

    const result = await aggregateDay(db, day, { logger: silentLogger });
    expect(result.users).toBe(2);
    expect(result.events).toBe(5); // 4 userA mapped + 1 userB; unmapped + null excluded by query

    const rowA = await db.userDailyActivity.findUnique({
      where: { userId_date: { userId: userA, date: day } },
    });
    expect(rowA).not.toBeNull();
    expect(rowA!.createdRealWish).toBe(2);
    expect(rowA!.sharedWishlist).toBe(1);
    expect(rowA!.paywallViewed).toBe(1);
    expect(rowA!.sessionStarted).toBe(0);

    const rowB = await db.userDailyActivity.findUnique({
      where: { userId_date: { userId: userB, date: day } },
    });
    expect(rowB).not.toBeNull();
    expect(rowB!.sessionStarted).toBe(1);
    expect(rowB!.createdRealWish).toBe(0);
  });

  it('re-running aggregateDay is idempotent — no duplicate rows, counters unchanged', async () => {
    const db = getTestPrisma();
    const day = new Date('2026-04-16T00:00:00.000Z');

    await db.analyticsEvent.createMany({
      data: [
        { event: 'wish.created', userId: userA, createdAt: new Date('2026-04-16T10:00:00.000Z') },
        { event: 'paywall.viewed', userId: userA, createdAt: new Date('2026-04-16T11:00:00.000Z') },
      ],
    });

    await aggregateDay(db, day, { logger: silentLogger });
    await aggregateDay(db, day, { logger: silentLogger });
    await aggregateDay(db, day, { logger: silentLogger });

    const rows = await db.userDailyActivity.findMany({
      where: { userId: userA, date: day },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.createdRealWish).toBe(1);
    expect(rows[0]!.paywallViewed).toBe(1);
  });

  it('upsert overwrites prior counters when new events arrive between runs', async () => {
    const db = getTestPrisma();
    const day = new Date('2026-04-17T00:00:00.000Z');

    await db.analyticsEvent.create({
      data: { event: 'wish.created', userId: userA, createdAt: new Date('2026-04-17T10:00:00.000Z') },
    });
    await aggregateDay(db, day, { logger: silentLogger });

    // Two more wishes arrive later in the day.
    await db.analyticsEvent.createMany({
      data: [
        { event: 'wish.created', userId: userA, createdAt: new Date('2026-04-17T18:00:00.000Z') },
        { event: 'wish.created', userId: userA, createdAt: new Date('2026-04-17T20:00:00.000Z') },
      ],
    });
    await aggregateDay(db, day, { logger: silentLogger });

    const row = await db.userDailyActivity.findUnique({
      where: { userId_date: { userId: userA, date: day } },
    });
    expect(row!.createdRealWish).toBe(3); // full recompute, not incremented from 1 → 4
  });

  it('UTC day boundary: 23:59:59.999Z falls in day D, 00:00:00.000Z falls in day D+1', async () => {
    const db = getTestPrisma();
    const dayD = new Date('2026-04-18T00:00:00.000Z');
    const dayDplus1 = new Date('2026-04-19T00:00:00.000Z');

    await db.analyticsEvent.createMany({
      data: [
        // Last millisecond of day D.
        { event: 'wish.created', userId: userA, createdAt: new Date('2026-04-18T23:59:59.999Z') },
        // First millisecond of day D+1.
        { event: 'wish.created', userId: userA, createdAt: new Date('2026-04-19T00:00:00.000Z') },
      ],
    });

    await aggregateDay(db, dayD, { logger: silentLogger });
    await aggregateDay(db, dayDplus1, { logger: silentLogger });

    const rowD = await db.userDailyActivity.findUnique({
      where: { userId_date: { userId: userA, date: dayD } },
    });
    const rowDplus1 = await db.userDailyActivity.findUnique({
      where: { userId_date: { userId: userA, date: dayDplus1 } },
    });

    expect(rowD!.createdRealWish).toBe(1);
    expect(rowDplus1!.createdRealWish).toBe(1);
  });

  it('Europe/Berlin local midnight at UTC+2 (00:30 Berlin = 22:30Z prev day) attributes to the PREVIOUS UTC day', async () => {
    // Documents the published trade-off: a Berlin user acting at 00:30
    // local summer time (UTC+2) emits createdAt = 22:30Z the previous
    // calendar day, which the rollup buckets into that PREVIOUS UTC day.
    // The cohort math still works because every user's D0 is also UTC.
    const db = getTestPrisma();
    const utcDay = new Date('2026-05-19T00:00:00.000Z');
    const utcNextDay = new Date('2026-05-20T00:00:00.000Z');

    await db.analyticsEvent.create({
      data: {
        event: 'share.token_generated',
        userId: userA,
        // 2026-05-20 00:30 Berlin summer time = 2026-05-19 22:30Z.
        createdAt: new Date('2026-05-19T22:30:00.000Z'),
      },
    });

    await aggregateDay(db, utcDay, { logger: silentLogger });
    await aggregateDay(db, utcNextDay, { logger: silentLogger });

    const rowPrev = await db.userDailyActivity.findUnique({
      where: { userId_date: { userId: userA, date: utcDay } },
    });
    const rowNext = await db.userDailyActivity.findUnique({
      where: { userId_date: { userId: userA, date: utcNextDay } },
    });
    expect(rowPrev!.sharedWishlist).toBe(1);
    expect(rowNext).toBeNull(); // Berlin's "today" doesn't get the row.
  });

  it('dryRun: true performs the scan but writes nothing', async () => {
    const db = getTestPrisma();
    const day = new Date('2026-04-20T00:00:00.000Z');

    await db.analyticsEvent.createMany({
      data: [
        { event: 'wish.created', userId: userA, createdAt: new Date('2026-04-20T10:00:00.000Z') },
        { event: 'paywall.viewed', userId: userA, createdAt: new Date('2026-04-20T11:00:00.000Z') },
      ],
    });

    const result = await aggregateDay(db, day, { dryRun: true, logger: silentLogger });
    expect(result.dryRun).toBe(true);
    expect(result.users).toBe(1);
    expect(result.events).toBe(2);

    const rows = await db.userDailyActivity.findMany({
      where: { userId: userA, date: day },
    });
    expect(rows).toHaveLength(0); // Nothing written.

    // Now run for real and confirm the same input yields a row.
    await aggregateDay(db, day, { logger: silentLogger });
    const after = await db.userDailyActivity.findUnique({
      where: { userId_date: { userId: userA, date: day } },
    });
    expect(after!.createdRealWish).toBe(1);
    expect(after!.paywallViewed).toBe(1);
  });

  it('drops events whose userId no longer exists in User (deleted users) — no FK violation', async () => {
    // Regression: backfill on 2026-05-19 failed in prod with P2003 because
    // AnalyticsEvent.userId is a soft pointer (no FK) — events outlive a
    // hard-deleted User row. The aggregator must filter such events out
    // before upserting UserDailyActivity (which DOES enforce FK on User).
    // See docs/BUGFIX_LESSONS.md 2026-05-19 "rollup FK violation".
    const db = getTestPrisma();
    const day = new Date('2026-04-25T00:00:00.000Z');

    // userA still exists; GHOST_ID is cuid-shaped but points to no User row.
    expect(await db.user.findUnique({ where: { id: GHOST_ID } })).toBeNull();

    await db.analyticsEvent.createMany({
      data: [
        // Valid: should be rolled up normally.
        { event: 'wish.created', userId: userA, createdAt: new Date('2026-04-25T10:00:00.000Z') },
        // Dangling: must be dropped before upsert, not crash the whole day.
        { event: 'wish.created', userId: GHOST_ID, createdAt: new Date('2026-04-25T11:00:00.000Z') },
        { event: 'paywall.viewed', userId: GHOST_ID, createdAt: new Date('2026-04-25T12:00:00.000Z') },
      ],
    });

    // Must NOT throw — that was the bug.
    const result = await aggregateDay(db, day, { logger: silentLogger });
    expect(result.events).toBe(3); // all three were scanned
    expect(result.users).toBe(1);  // ghost dropped before upsert; only userA remained
    expect(result.droppedUsers).toBe(1); // surfaces the ghost in the result shape

    const rowA = await db.userDailyActivity.findUnique({
      where: { userId_date: { userId: userA, date: day } },
    });
    expect(rowA!.createdRealWish).toBe(1);

    const rowGhost = await db.userDailyActivity.findUnique({
      where: { userId_date: { userId: GHOST_ID, date: day } },
    });
    expect(rowGhost).toBeNull();
  });

  it('aggregateDateRange covers an inclusive [from, to] window day-by-day', async () => {
    const db = getTestPrisma();
    const from = new Date('2026-04-21T00:00:00.000Z');
    const to   = new Date('2026-04-23T00:00:00.000Z');

    await db.analyticsEvent.createMany({
      data: [
        { event: 'wish.created', userId: userA, createdAt: new Date('2026-04-21T10:00:00.000Z') },
        { event: 'wish.created', userId: userA, createdAt: new Date('2026-04-22T10:00:00.000Z') },
        { event: 'wish.created', userId: userA, createdAt: new Date('2026-04-23T10:00:00.000Z') },
        // Outside the window — should not appear in any row.
        { event: 'wish.created', userId: userA, createdAt: new Date('2026-04-24T10:00:00.000Z') },
      ],
    });

    const results = await aggregateDateRange(db, from, to, { logger: silentLogger });
    expect(results).toHaveLength(3);
    expect(results.map((r) => r.date.toISOString().slice(0, 10))).toEqual([
      '2026-04-21',
      '2026-04-22',
      '2026-04-23',
    ]);

    const rows = await db.userDailyActivity.findMany({
      where: { userId: userA, date: { gte: from, lte: to } },
      orderBy: { date: 'asc' },
    });
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.createdRealWish).toBe(1);

    // The day outside the range never got rolled up.
    const outside = await db.userDailyActivity.findUnique({
      where: { userId_date: { userId: userA, date: startOfUtcDay(new Date('2026-04-24T10:00:00.000Z')) } },
    });
    expect(outside).toBeNull();
  });
});
