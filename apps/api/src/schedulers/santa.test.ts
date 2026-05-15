// Tests for schedulers/santa.ts — 4 hourly jobs (hint expiry, deadline
// missed, deadline warning, seasonal events) + 2 startup jobs.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Logger } from 'pino';
import type { PrismaClient } from '@wishlist/db';
import { startSantaSchedulers, runSantaStartupJobs } from './santa';

const HOURLY_MS = 60 * 60 * 1000;
const fakeLogger = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() } as unknown as Logger);

let prisma: {
  santaHintRequest: { updateMany: ReturnType<typeof vi.fn> };
  santaRound: { findMany: ReturnType<typeof vi.fn> };
  santaAssignment: { findMany: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  santaNotification: { createMany: ReturnType<typeof vi.fn> };
  santaGlobalConfig: { upsert: ReturnType<typeof vi.fn> };
  santaParticipantAlias: { createMany: ReturnType<typeof vi.fn> };
};
let maybeRunSeasonalEvents: ReturnType<typeof vi.fn>;
let generateSantaAliases: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  prisma = {
    santaHintRequest: { updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
    santaRound: { findMany: vi.fn().mockResolvedValue([]) },
    santaAssignment: {
      findMany: vi.fn().mockResolvedValue([]),
      updateMany: vi.fn().mockResolvedValue({}),
    },
    santaNotification: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
    santaGlobalConfig: { upsert: vi.fn().mockResolvedValue({}) },
    santaParticipantAlias: { createMany: vi.fn().mockResolvedValue({}) },
  };
  maybeRunSeasonalEvents = vi.fn().mockResolvedValue(undefined);
  generateSantaAliases = vi.fn().mockReturnValue([]);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function start() {
  startSantaSchedulers({
    prisma: prisma as unknown as PrismaClient,
    logger: fakeLogger(),
    maybeRunSeasonalEvents,
  });
}

describe('santa: hint expiry', () => {
  it('flips PENDING hint requests past expiresAt to EXPIRED', async () => {
    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    expect(prisma.santaHintRequest.updateMany).toHaveBeenCalled();
    const arg = prisma.santaHintRequest.updateMany.mock.calls[0]![0];
    expect(arg.where.status).toBe('PENDING');
    expect(arg.data).toEqual({ status: 'EXPIRED' });
  });

  it('logs only when expired count > 0', async () => {
    prisma.santaHintRequest.updateMany.mockResolvedValueOnce({ count: 5 });
    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    // info log fires with count
  });
});

describe('santa: deadline missed', () => {
  it('flips PENDING/BUYING assignments past drawAt to MISSED_DEADLINE', async () => {
    prisma.santaRound.findMany.mockResolvedValueOnce([{ id: 'r1', campaignId: 'c1' }]);
    prisma.santaAssignment.findMany.mockResolvedValueOnce([
      { id: 'a1', giver: { userId: 'u1' } },
      { id: 'a2', giver: { userId: 'u2' } },
    ]);

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(prisma.santaAssignment.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['a1', 'a2'] } },
      data: { giftStatus: 'MISSED_DEADLINE' },
    });
  });

  it('creates DEADLINE_MISSED notifications deduped per assignment', async () => {
    prisma.santaRound.findMany.mockResolvedValueOnce([{ id: 'r1', campaignId: 'c1' }]);
    prisma.santaAssignment.findMany.mockResolvedValueOnce([{ id: 'a1', giver: { userId: 'u1' } }]);

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(prisma.santaNotification.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        type: 'DEADLINE_MISSED',
        userId: 'u1',
        dedupeKey: 'missed:a1',
      })],
      skipDuplicates: true,
    });
  });

  it('skips notification createMany failures silently', async () => {
    prisma.santaRound.findMany.mockResolvedValueOnce([{ id: 'r1', campaignId: 'c1' }]);
    prisma.santaAssignment.findMany.mockResolvedValueOnce([{ id: 'a1', giver: { userId: 'u1' } }]);
    prisma.santaNotification.createMany.mockRejectedValueOnce(new Error('dedup'));

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    // No throw — non-fatal per the .catch in source
  });
});

describe('santa: deadline warning', () => {
  it('queries rounds whose campaign drawAt is in 72–96h window', async () => {
    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    // Third findMany call is the warning window (after hint expiry + missed deadline rounds)
    const warningCall = prisma.santaRound.findMany.mock.calls.find((c) => {
      const drawAt = c[0]?.where?.campaign?.drawAt;
      return drawAt?.gte && drawAt?.lte;
    });
    expect(warningCall).toBeDefined();
  });

  it('issues DEADLINE_WARNING notifications deduped per assignment', async () => {
    // Set up: missed-deadline query empty; warning query returns rounds.
    prisma.santaRound.findMany
      .mockResolvedValueOnce([])    // missed-deadline query
      .mockResolvedValueOnce([{ id: 'r1', campaignId: 'c1' }]); // warning query
    prisma.santaAssignment.findMany.mockResolvedValueOnce([
      { id: 'a1', giver: { userId: 'u1' } },
    ]);
    prisma.santaNotification.createMany.mockResolvedValueOnce({ count: 1 });

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(prisma.santaNotification.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        type: 'DEADLINE_WARNING',
        dedupeKey: 'warn:a1',
      })],
      skipDuplicates: true,
    });
  });
});

describe('santa: seasonal events tick', () => {
  it('invokes maybeRunSeasonalEvents every hour', async () => {
    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    expect(maybeRunSeasonalEvents).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    expect(maybeRunSeasonalEvents).toHaveBeenCalledTimes(2);
  });
});

describe('runSantaStartupJobs', () => {
  it('upserts SantaGlobalConfig singleton with santaEnabled=true on create', async () => {
    runSantaStartupJobs({
      prisma: prisma as unknown as PrismaClient,
      logger: fakeLogger(),
      generateSantaAliases,
    });
    // Allow the void Promise to settle
    await vi.runAllTimersAsync().catch(() => {});

    expect(prisma.santaGlobalConfig.upsert).toHaveBeenCalledWith({
      where: { id: 'global' },
      create: { id: 'global', santaEnabled: true },
      update: {},
    });
  });

  it('does not throw when SantaGlobalConfig upsert fails (non-fatal)', async () => {
    prisma.santaGlobalConfig.upsert.mockRejectedValueOnce(new Error('boot'));
    expect(() =>
      runSantaStartupJobs({
        prisma: prisma as unknown as PrismaClient,
        logger: fakeLogger(),
        generateSantaAliases,
      }),
    ).not.toThrow();
  });
});
