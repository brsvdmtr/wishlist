// Integration tests against a real Postgres — pin the once-per-(user,
// experiment) guarantee that getExperimentAssignment relies on the unique
// ExperimentAssignment index to provide. A mock-Prisma test cannot prove the
// P2002 race behaviour; this hits the real engine.
//
// Auto-skips when DATABASE_URL is not set so local `pnpm test` stays fast and
// doesn't require a Postgres container. CI provides DATABASE_URL via the
// postgres service container in .github/workflows/test.yml.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

// experiment.assigned is emitted fire-and-forget; mock it so call count is
// deterministic and no AnalyticsEvent rows leak into other integration files.
const analytics = vi.hoisted(() => ({ trackProductEvent: vi.fn() }));
vi.mock('../../src/services/analytics', () => ({
  trackProductEvent: analytics.trackProductEvent,
}));

import { getTestPrisma, disconnectTestPrisma } from '../setup-pg';
import {
  getExperimentAssignment,
  peekExperimentVariant,
  type ExperimentConfig,
} from '../../src/services/experiments.service';

const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;

// Unique prefix so this file's fixtures don't collide with other integration
// test files sharing the one Postgres instance.
const PREFIX = 'int-exp';
const ON: ExperimentConfig = { enabled: true, rolloutPercent: 50 };

if (SKIP) {
  // eslint-disable-next-line no-console
  console.warn('[integration] DATABASE_URL not set — skipping experiments integration tests');
}

suite('getExperimentAssignment — real Postgres', () => {
  const userIds: string[] = [];

  beforeAll(async () => {
    const db = getTestPrisma();
    await db.experimentAssignment.deleteMany({
      where: { user: { telegramId: { startsWith: PREFIX } } },
    });
    await db.user.deleteMany({ where: { telegramId: { startsWith: PREFIX } } });
    for (let i = 1; i <= 6; i++) {
      const u = await db.user.create({ data: { telegramId: `${PREFIX}-${i}` } });
      userIds.push(u.id);
    }
  });

  afterAll(async () => {
    const db = getTestPrisma();
    await db.experimentAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await disconnectTestPrisma();
  });

  beforeEach(async () => {
    await getTestPrisma().experimentAssignment.deleteMany({ where: { userId: { in: userIds } } });
    analytics.trackProductEvent.mockClear();
  });

  it('first exposure creates one row and emits experiment.assigned once (self-check #4)', async () => {
    const key = 'int-first';
    const result = await getExperimentAssignment(userIds[0]!, key, ON);

    expect(['control', 'treatment']).toContain(result.variant);
    expect(result.active).toBe(true);

    const rows = await getTestPrisma().experimentAssignment.findMany({
      where: { userId: userIds[0]!, experimentKey: key },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.variant).toBe(result.variant);

    expect(analytics.trackProductEvent).toHaveBeenCalledTimes(1);
    expect(analytics.trackProductEvent.mock.calls[0]![0]).toMatchObject({
      event: 'experiment.assigned',
      userId: userIds[0]!,
      props: { key, variant: result.variant },
    });
  });

  it('repeat calls are sticky and emit no further events (self-check #1 + #4)', async () => {
    const key = 'int-sticky';
    const first = await getExperimentAssignment(userIds[1]!, key, ON);
    const second = await getExperimentAssignment(userIds[1]!, key, ON);
    // Read-through: the persisted variant wins even when rollout later jumps.
    const third = await getExperimentAssignment(userIds[1]!, key, {
      enabled: true,
      rolloutPercent: 100,
    });

    expect(second.variant).toBe(first.variant);
    expect(third.variant).toBe(first.variant);

    const rows = await getTestPrisma().experimentAssignment.findMany({
      where: { userId: userIds[1]!, experimentKey: key },
    });
    expect(rows).toHaveLength(1);
    expect(analytics.trackProductEvent).toHaveBeenCalledTimes(1);
  });

  it('concurrent first-exposure calls settle on one row + one event (P2002 race, self-check #4)', async () => {
    const key = 'int-race';
    const results = await Promise.all(
      Array.from({ length: 6 }, () => getExperimentAssignment(userIds[2]!, key, ON)),
    );

    // All concurrent callers must agree on the variant.
    expect(new Set(results.map((r) => r.variant)).size).toBe(1);

    const rows = await getTestPrisma().experimentAssignment.findMany({
      where: { userId: userIds[2]!, experimentKey: key },
    });
    expect(rows).toHaveLength(1);
    expect(analytics.trackProductEvent).toHaveBeenCalledTimes(1);
  });

  it('a disabled experiment writes nothing and returns control', async () => {
    const key = 'int-disabled';
    const result = await getExperimentAssignment(userIds[3]!, key, {
      enabled: false,
      rolloutPercent: 100,
    });

    expect(result).toEqual({ key, variant: 'control', holdout: false, active: false });

    const rows = await getTestPrisma().experimentAssignment.findMany({
      where: { userId: userIds[3]!, experimentKey: key },
    });
    expect(rows).toHaveLength(0);
    expect(analytics.trackProductEvent).not.toHaveBeenCalled();
  });

  it('two users in the same experiment get independent rows + events', async () => {
    const key = 'int-two-users';
    await getExperimentAssignment(userIds[4]!, key, ON);
    await getExperimentAssignment(userIds[5]!, key, ON);

    const rows = await getTestPrisma().experimentAssignment.findMany({
      where: { experimentKey: key, userId: { in: [userIds[4]!, userIds[5]!] } },
    });
    expect(rows).toHaveLength(2);
    expect(analytics.trackProductEvent).toHaveBeenCalledTimes(2);
  });

  // ── peekExperimentVariant — the read-only resolver behind the
  //    growth-first-limits entitlement path. Shares the parent suite's users +
  //    lifecycle; the parent beforeEach wipes assignment rows before each test,
  //    so each test seeds exactly the row it needs. This covers what the
  //    mock-Prisma unit test cannot: a genuinely absent row read from the real
  //    engine, and the read-only invariant (no row written, no exposure event)
  //    verified against a live DB.
  describe('peekExperimentVariant — read-only read path (real Postgres)', () => {
    const KEY = 'int-peek';
    const ENABLED: ExperimentConfig = { enabled: true, rolloutPercent: 100 };
    const DISABLED: ExperimentConfig = { enabled: false, rolloutPercent: 100 };

    it('no persisted row → control (real absent-row read, not a mock null)', async () => {
      expect(await peekExperimentVariant(userIds[0]!, KEY, ENABLED)).toBe('control');
    });

    it('persisted treatment → treatment; persisted control → control', async () => {
      const db = getTestPrisma();
      await db.experimentAssignment.create({
        data: { userId: userIds[0]!, experimentKey: KEY, variant: 'treatment', holdout: false },
      });
      await db.experimentAssignment.create({
        data: { userId: userIds[1]!, experimentKey: KEY, variant: 'control', holdout: false },
      });
      expect(await peekExperimentVariant(userIds[0]!, KEY, ENABLED)).toBe('treatment');
      expect(await peekExperimentVariant(userIds[1]!, KEY, ENABLED)).toBe('control');
    });

    it('holdout row (variant control) → control', async () => {
      await getTestPrisma().experimentAssignment.create({
        data: { userId: userIds[2]!, experimentKey: KEY, variant: 'control', holdout: true },
      });
      expect(await peekExperimentVariant(userIds[2]!, KEY, ENABLED)).toBe('control');
    });

    it('kill switch: disabled overrides a persisted treatment row → control', async () => {
      await getTestPrisma().experimentAssignment.create({
        data: { userId: userIds[3]!, experimentKey: KEY, variant: 'treatment', holdout: false },
      });
      expect(await peekExperimentVariant(userIds[3]!, KEY, DISABLED)).toBe('control');
    });

    it('is read-only: writes no row for an unenrolled user and emits no exposure event', async () => {
      const db = getTestPrisma();
      const before = await db.experimentAssignment.count({ where: { experimentKey: KEY } });
      await peekExperimentVariant(userIds[4]!, KEY, ENABLED); // unenrolled — must not enroll
      const after = await db.experimentAssignment.count({ where: { experimentKey: KEY } });
      expect(after).toBe(before);
      expect(analytics.trackProductEvent).not.toHaveBeenCalled();
    });
  });
});
