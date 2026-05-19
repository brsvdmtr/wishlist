// Tests for schedulers/billing.ts — 4 hourly jobs: subscription expiry,
// promo expiry, degradation grace→archive, degradation archive→purge.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Logger } from 'pino';
import type { PrismaClient } from '@wishlist/db';

const analytics = vi.hoisted(() => ({ trackProductEvent: vi.fn() }));
vi.mock('../services/analytics', () => analytics);

import { startBillingSchedulers } from './billing';

const HOURLY_MS = 60 * 60 * 1000;
const fakeLogger = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() } as unknown as Logger);

let prisma: {
  subscription: { updateMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  promoRedemption: { updateMany: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  degradationState: { findMany: ReturnType<typeof vi.fn>; upsert: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  wishlist: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
  item: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>; deleteMany: ReturnType<typeof vi.fn> };
};
let getUserEntitlement: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  analytics.trackProductEvent.mockReset();
  prisma = {
    subscription: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
    },
    promoRedemption: {
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    degradationState: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn().mockResolvedValue({}),
      update: vi.fn().mockResolvedValue({}),
    },
    wishlist: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
    item: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({}),
      deleteMany: vi.fn().mockResolvedValue({}),
    },
  };
  getUserEntitlement = vi.fn().mockResolvedValue({ isPro: false });
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function start() {
  startBillingSchedulers({
    prisma: prisma as unknown as PrismaClient,
    logger: fakeLogger(),
    getUserEntitlement,
    PLANS: { FREE: { wishlists: 2, items: 20 } },
  });
}

describe('billing: subscription expiry', () => {
  it('flips ACTIVE/CANCELLED subs past currentPeriodEnd to EXPIRED', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([
      { id: 's1', userId: 'u1', planCode: 'PRO', billingPeriod: 'monthly', currentPeriodEnd: new Date('2026-05-18T00:00:00Z') },
    ]);
    prisma.subscription.updateMany.mockResolvedValueOnce({ count: 1 });

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(prisma.subscription.findMany).toHaveBeenCalled();
    const findArg = prisma.subscription.findMany.mock.calls[0]![0];
    expect(findArg.where.status).toEqual({ in: ['ACTIVE', 'CANCELLED'] });

    expect(prisma.subscription.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: 'EXPIRED' } }),
    );
  });

  it('excludes lifetime subs from the findMany filter', async () => {
    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    const arg = prisma.subscription.findMany.mock.calls[0]![0];
    expect(arg.where.NOT).toEqual({ billingPeriod: 'lifetime' });
  });

  it('emits subscription.expired ONCE per expiring row with non-PII props', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([
      { id: 's1', userId: 'u1', planCode: 'PRO', billingPeriod: 'monthly', currentPeriodEnd: new Date('2026-05-18T00:00:00Z') },
      { id: 's2', userId: 'u2', planCode: 'PRO', billingPeriod: 'yearly',  currentPeriodEnd: new Date('2026-05-17T00:00:00Z') },
    ]);
    prisma.subscription.updateMany.mockResolvedValueOnce({ count: 2 });

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(analytics.trackProductEvent).toHaveBeenCalledTimes(2);
    const events = analytics.trackProductEvent.mock.calls.map((c) => c[0]);
    for (const ev of events) {
      expect(ev.event).toBe('subscription.expired');
      expect(ev.props).toMatchObject({
        planCode: 'PRO',
        billingPeriod: expect.any(String),
        subscriptionId: expect.any(String),
        expiredAt: expect.any(String),
      });
      // Privacy: no title/description/Telegram identifiers — same rule as
      // payment.completed and other server-only events.
      expect(ev.props).not.toHaveProperty('title');
      expect(ev.props).not.toHaveProperty('description');
      expect(ev.props).not.toHaveProperty('telegramId');
    }
    expect(events.map((e) => e.userId).sort()).toEqual(['u1', 'u2']);
  });

  it('does not emit subscription.expired when nothing is expiring', async () => {
    prisma.subscription.findMany.mockResolvedValueOnce([]);

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(prisma.subscription.updateMany).not.toHaveBeenCalled();
    expect(analytics.trackProductEvent).not.toHaveBeenCalled();
  });
});

describe('billing: promo expiry + degradation start', () => {
  it('expires ACTIVE promos past expiresAt', async () => {
    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    expect(prisma.promoRedemption.updateMany).toHaveBeenCalled();
    const arg = prisma.promoRedemption.updateMany.mock.calls[0]![0];
    expect(arg.data).toEqual({ status: 'EXPIRED' });
  });

  it('after expiring promos: starts GRACE_PERIOD for users with no paid sub', async () => {
    prisma.promoRedemption.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.promoRedemption.findMany.mockResolvedValueOnce([{ userId: 'u1' }]);
    prisma.subscription.findFirst.mockResolvedValueOnce(null); // no paid sub

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(prisma.degradationState.upsert).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      update: {},
      create: expect.objectContaining({ userId: 'u1', phase: 'GRACE_PERIOD' }),
    });
  });

  it('skips degradation start when user has an active paid sub', async () => {
    prisma.promoRedemption.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.promoRedemption.findMany.mockResolvedValueOnce([{ userId: 'u1' }]);
    prisma.subscription.findFirst.mockResolvedValueOnce({ id: 'sub1', userId: 'u1' });

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(prisma.degradationState.upsert).not.toHaveBeenCalled();
  });

  it('graceEndsAt is set 14 days in the future', async () => {
    prisma.promoRedemption.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.promoRedemption.findMany.mockResolvedValueOnce([{ userId: 'u1' }]);
    prisma.subscription.findFirst.mockResolvedValueOnce(null);

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    const created = prisma.degradationState.upsert.mock.calls[0]![0].create;
    const graceEnds = created.graceEndsAt as Date;
    const days = (graceEnds.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(days).toBeGreaterThan(13);
    expect(days).toBeLessThan(15);
  });
});

describe('billing: degradation grace → archive', () => {
  it('regained PRO during grace → phase=NONE, no archiving', async () => {
    prisma.degradationState.findMany.mockResolvedValueOnce([{ id: 'ds1', userId: 'u1' }]);
    getUserEntitlement.mockResolvedValueOnce({ isPro: true });

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(prisma.degradationState.update).toHaveBeenCalledWith({
      where: { id: 'ds1' },
      data: { phase: 'NONE' },
    });
    expect(prisma.wishlist.update).not.toHaveBeenCalled();
  });

  it('still FREE after grace → archives over-limit wishlists', async () => {
    prisma.degradationState.findMany.mockResolvedValueOnce([{ id: 'ds1', userId: 'u1' }]);
    getUserEntitlement.mockResolvedValueOnce({ isPro: false });
    prisma.wishlist.findMany.mockResolvedValueOnce([
      { id: 'w1' }, { id: 'w2' }, { id: 'w3' }, { id: 'w4' }, // FREE limit = 2
    ]);
    prisma.item.findMany.mockResolvedValue([]);

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    // w3, w4 archived (2 over limit of 2)
    expect(prisma.wishlist.update).toHaveBeenCalledTimes(2);
    const calls = prisma.wishlist.update.mock.calls.map((c) => c[0].where.id);
    expect(calls).toEqual(['w3', 'w4']);
  });

  it('archives over-limit items within retained wishlists', async () => {
    prisma.degradationState.findMany.mockResolvedValueOnce([{ id: 'ds1', userId: 'u1' }]);
    getUserEntitlement.mockResolvedValueOnce({ isPro: false });
    prisma.wishlist.findMany.mockResolvedValueOnce([{ id: 'w1' }, { id: 'w2' }]); // both within limit
    // 25 items in w1 (FREE.items = 20 → 5 overflow); empty w2
    prisma.item.findMany
      .mockResolvedValueOnce(Array.from({ length: 25 }, (_, i) => ({ id: `i${i}` })))
      .mockResolvedValueOnce([]);

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(prisma.item.update).toHaveBeenCalledTimes(5);
  });

  it('archiving advances phase to ARCHIVED with 90-day purge schedule', async () => {
    prisma.degradationState.findMany.mockResolvedValueOnce([{ id: 'ds1', userId: 'u1' }]);
    getUserEntitlement.mockResolvedValueOnce({ isPro: false });
    prisma.wishlist.findMany.mockResolvedValueOnce([{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }]);
    prisma.item.findMany.mockResolvedValue([]);

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    const update = prisma.degradationState.update.mock.calls[0]![0];
    expect(update.data.phase).toBe('ARCHIVED');
    const days = (update.data.purgeScheduledAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThan(91);
  });
});

describe('billing: degradation archive → purge', () => {
  it('regained PRO during archive → restores archived data + phase=NONE', async () => {
    prisma.degradationState.findMany.mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 'ds1', userId: 'u1',
        archivedWishlistIds: JSON.stringify(['w1', 'w2']),
        archivedItemIds: JSON.stringify(['i1']),
      }]);
    getUserEntitlement.mockResolvedValueOnce({ isPro: true });

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(prisma.wishlist.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['w1', 'w2'] } },
      data: { archivedAt: null },
    });
    expect(prisma.item.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['i1'] } },
      data: { archivedAt: null },
    });
  });

  it('still FREE after archive window → permanent deletion + phase=PURGED', async () => {
    prisma.degradationState.findMany.mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 'ds1', userId: 'u1',
        archivedWishlistIds: JSON.stringify(['w1']),
        archivedItemIds: JSON.stringify(['i1', 'i2']),
      }]);
    getUserEntitlement.mockResolvedValueOnce({ isPro: false });

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(prisma.item.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['i1', 'i2'] } } });
    expect(prisma.wishlist.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['w1'] } } });
    expect(prisma.degradationState.update).toHaveBeenCalledWith({
      where: { id: 'ds1' },
      data: { phase: 'PURGED' },
    });
  });

  it('handles empty archived arrays without throwing', async () => {
    prisma.degradationState.findMany.mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        id: 'ds1', userId: 'u1',
        archivedWishlistIds: null,
        archivedItemIds: null,
      }]);
    getUserEntitlement.mockResolvedValueOnce({ isPro: false });

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(prisma.item.deleteMany).not.toHaveBeenCalled();
    expect(prisma.wishlist.deleteMany).not.toHaveBeenCalled();
  });
});

describe('billing: error containment', () => {
  it('each of the four jobs swallows its own errors', async () => {
    prisma.subscription.findMany.mockRejectedValue(new Error('sub'));
    prisma.promoRedemption.updateMany.mockRejectedValue(new Error('promo'));
    prisma.degradationState.findMany.mockRejectedValue(new Error('grace'));

    expect(() => start()).not.toThrow();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
  });
});
