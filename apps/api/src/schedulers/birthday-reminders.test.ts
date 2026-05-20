// Smoke tests for schedulers/birthday-reminders.ts — single hourly cron
// that processes ≤30 birthday users per tick. The internal logic is 1157
// LOC of segmentation, opt-out, dedup, daily-cap, deferral, retry, and
// per-recipient locale resolution; the unit-test layer here pins the cron
// contract (cadence, kill switch, error containment, top-level deps), not
// the full classifier. Per-classifier behaviour belongs in an integration
// test against a real DB.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Logger } from 'pino';
import type { PrismaClient } from '@wishlist/db';
import { startBirthdayRemindersScheduler } from './birthday-reminders';

const HOURLY_MS = 60 * 60 * 1000;
const fakeLogger = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() } as unknown as Logger);

// Minimal-noise Prisma mock — every model returns the empty result that
// forces the cron into "no candidates" early-exit. Real branches are covered
// by integration tests. Extracted to a factory so `prisma` gets a precise
// inferred type (named model props, not an index signature) — that keeps
// `prisma.userProfile.findMany` non-undefined under noUncheckedIndexedAccess.
function makePrismaMock() {
  const empty = () => vi.fn().mockResolvedValue([]);
  const emptyOne = () => vi.fn().mockResolvedValue(null);
  const zeroCount = () => vi.fn().mockResolvedValue({ count: 0 });
  return {
    userProfile: { findMany: empty() },
    user: { findUnique: emptyOne(), findMany: empty(), count: vi.fn().mockResolvedValue(0) },
    wishlistSubscription: { findMany: empty() },
    wishlistOwnerSubscription: { findMany: empty() },
    wishlist: { findMany: empty(), findFirst: emptyOne(), findUnique: emptyOne() },
    item: { findMany: empty(), count: vi.fn().mockResolvedValue(0) },
    reservation: { findMany: empty() },
    reservationMeta: { findMany: empty() },
    birthdayReminderDelivery: {
      findMany: empty(),
      findFirst: emptyOne(),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
      updateMany: zeroCount(),
    },
    userMute: { findMany: empty() },
    comment: { findMany: empty() },
    hint: { findMany: empty() },
    serviceHeartbeat: { upsert: vi.fn().mockResolvedValue({}) },
  };
}

let prisma: ReturnType<typeof makePrismaMock>;
let getEffectiveEntitlements: ReturnType<typeof vi.fn>;
let tgActorHash: ReturnType<typeof vi.fn>;
let trackEvent: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  // Pin fake clock to a deterministic time inside the scheduler's MSK
  // send-hour window (9–22). `useFakeTimers()` defaults to wall-clock time
  // at setup, which makes these tests flake based on when CI / local runs
  // happen: any run started between 23:00 and 08:59 MSK exits early at
  // `birthday-reminders.ts:527` and never reaches findMany / heartbeat.
  // 2026-05-16T09:00:00Z = 12:00 MSK — safely mid-window.
  vi.setSystemTime(new Date('2026-05-16T09:00:00Z'));
  prisma = makePrismaMock();
  getEffectiveEntitlements = vi.fn().mockResolvedValue({ isPro: false });
  tgActorHash = vi.fn((id: number) => `actor-${id}`);
  trackEvent = vi.fn();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function start(enabled = true) {
  startBirthdayRemindersScheduler({
    prisma: prisma as unknown as PrismaClient,
    logger: fakeLogger(),
    getEffectiveEntitlements,
    tgActorHash,
    trackEvent,
    BIRTHDAY_REMINDERS_ENABLED: enabled,
  });
}

describe('startBirthdayRemindersScheduler', () => {
  it('does nothing on tick when BIRTHDAY_REMINDERS_ENABLED is false (kill switch)', async () => {
    start(false);
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    expect(prisma.userProfile.findMany).not.toHaveBeenCalled();
  });

  it('runs on hourly cadence when enabled', async () => {
    start(true);
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    // At least one Prisma query happens on a tick when enabled.
    const calls = [
      ...prisma.userProfile.findMany.mock.calls,
      ...prisma.birthdayReminderDelivery.findMany.mock.calls,
    ];
    expect(calls.length).toBeGreaterThan(0);
  });

  it('does not throw when Prisma queries fail (best-effort)', async () => {
    prisma.userProfile.findMany.mockRejectedValueOnce(new Error('DB down'));
    expect(() => start(true)).not.toThrow();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
  });

  it('writes a ServiceHeartbeat row each tick', async () => {
    start(true);
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    expect(prisma.serviceHeartbeat.upsert).toHaveBeenCalled();
    const arg = prisma.serviceHeartbeat.upsert.mock.calls[0]![0];
    expect(arg.where.serviceName).toBe('birthday_reminders');
  });

  it('continues ticking after a failed cycle (heartbeat fires on each tick)', async () => {
    prisma.userProfile.findMany
      .mockRejectedValueOnce(new Error('transient'))
      .mockResolvedValue([]);
    start(true);
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    const heartbeatsAfter1 = prisma.serviceHeartbeat.upsert.mock.calls.length;
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    const heartbeatsAfter2 = prisma.serviceHeartbeat.upsert.mock.calls.length;
    // The cron makes many internal queries per tick (offsets × kinds);
    // pin the contract to a stable signal: heartbeat fires once per tick.
    expect(heartbeatsAfter2).toBeGreaterThan(heartbeatsAfter1);
  });
});
