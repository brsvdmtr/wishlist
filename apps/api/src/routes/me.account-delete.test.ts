// Regression tests for DELETE /tg/me/account — pinning the Santa cascade
// behavior introduced 2026-05-28.
//
// Pre-fix: `prisma.user.delete` ran straight after the active-Santa
// check. COMPLETED/CANCELLED campaigns survived the check (they're not
// "active") but `SantaCampaign.owner` has `onDelete: Restrict` at the
// schema level → Postgres FK violation → 500.
//
// Post-fix: completed/cancelled campaigns are deleted in the same
// Serializable transaction, then the user row is deleted. The
// active-campaigns guard still returns 409 with the campaign list.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const shared = vi.hoisted(() => ({
  santaFindMany: vi.fn(),
  santaCount: vi.fn(),
  santaDeleteMany: vi.fn(),
  userDelete: vi.fn(),
  userUpsert: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock('@wishlist/db', () => {
  const prismaStub = {
    santaCampaign: {
      findMany: shared.santaFindMany,
      count: shared.santaCount,
      deleteMany: shared.santaDeleteMany,
    },
    user: {
      delete: shared.userDelete,
      upsert: shared.userUpsert,
      findUnique: shared.userFindUnique,
    },
    // $transaction shim: run callbacks with the same stub so handler-side
    // `tx.santaCampaign.*` / `tx.user.*` resolve to the shared mocks.
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prismaStub);
      if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
      return null;
    }),
  };
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, opts: { code: string }) {
      super(message);
      this.code = opts.code;
    }
  }
  const Prisma = {
    TransactionIsolationLevel: { Serializable: 'Serializable' as const },
    PrismaClientKnownRequestError,
  };
  return {
    prisma: prismaStub,
    Prisma,
    loadReferralConfig: vi.fn(async () => ({ enabled: false })),
    persistResolvedBucket: vi.fn(),
  };
});

import { registerMeRouter } from './me.routes';

function buildDeps() {
  return {
    getOrCreateTgUser: vi.fn(async () => ({ id: 'u-account', godMode: false, telegramId: '42', themePreference: null, accentPreference: null })),
    getEffectiveEntitlements: vi.fn(async () => ({
      isPro: false, addOns: [], plan: { code: 'FREE', items: 20, participants: 10, features: [] },
      effectiveWishlistLimit: 2, effectiveSubscriptionLimit: 2,
      extraItemsPerWishlist: {}, hintCredits: 0, importCredits: 0,
      freeImportsUsed: 0, freeImportsLimit: 5, freeHintsUsed: 0, freeHintsLimit: 3,
      hasGiftNotes: false, hasGroupGift: false, hasSecretReservations: false,
      seasonalWishlists: new Set<string>(), smartReservationsWishlists: new Set<string>(),
      proSource: null as null | string, subscription: null, promoPro: null,
      giftNotes: { unlocked: false, unlockType: null, priceXtr: 19 },
      groupGift: { unlocked: false, priceXtr: 79 },
      secretReservations: { unlocked: false, unlockType: null, priceXtr: 24 },
    })),
    getUserEntitlement: vi.fn(async () => ({ isPro: false })),
    hasReservationPro: vi.fn(() => false),
    trackEvent: vi.fn(),
    getOrCreateDefaultWishlist: vi.fn(async () => ({
      id: 'wl', slug: 'wl-x', title: 't', isDefault: true, alreadyExisted: false,
    })),
    ACTIVE_STATUSES: ['AVAILABLE', 'RESERVED', 'PURCHASED'] as const,
    PRO_PRICE_XTR: 100,
    PRO_YEARLY_PRICE_XTR: 800,
    PRO_LIFETIME_PRICE_XTR: 2490,
    ONE_TIME_SKUS: {} as never,
  } as Parameters<typeof registerMeRouter>[0];
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerMeRouter(buildDeps()));
  return app;
}

beforeEach(() => {
  for (const m of Object.values(shared)) (m as ReturnType<typeof vi.fn>).mockReset?.();
});

describe('DELETE /tg/me/account — Santa cascade (M4 regression)', () => {
  it('returns 409 with the campaign list when active Santa campaigns are owned', async () => {
    shared.santaFindMany.mockResolvedValueOnce([
      { id: 's1', title: 'NY 2026', status: 'OPEN' },
      { id: 's2', title: 'Office', status: 'LOCKED' },
    ]);

    const res = await request(makeApp()).delete('/me/account');

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'active_santa_campaigns',
      campaigns: expect.arrayContaining([
        expect.objectContaining({ id: 's1', status: 'OPEN' }),
        expect.objectContaining({ id: 's2', status: 'LOCKED' }),
      ]),
    });
    // Critical: user.delete MUST NOT have run (data preservation).
    expect(shared.userDelete).not.toHaveBeenCalled();
    expect(shared.santaDeleteMany).not.toHaveBeenCalled();
  });

  it('cascades COMPLETED/CANCELLED campaigns before user.delete (no FK Restrict violation)', async () => {
    // Outer check passes (no active).
    shared.santaFindMany.mockResolvedValueOnce([]);
    // Inner re-check inside the txn also passes (still 0 active).
    shared.santaCount.mockResolvedValueOnce(0);
    shared.santaDeleteMany.mockResolvedValueOnce({ count: 3 });
    shared.userDelete.mockResolvedValueOnce({ id: 'u-account' });

    const res = await request(makeApp()).delete('/me/account');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    // Critical: the delete order is santaCampaign.deleteMany THEN user.delete,
    // so the FK Restrict on SantaCampaign.owner doesn't trip.
    expect(shared.santaDeleteMany).toHaveBeenCalledOnce();
    expect(shared.santaDeleteMany.mock.calls[0]![0]).toMatchObject({
      where: { ownerId: 'u-account', status: { in: ['COMPLETED', 'CANCELLED'] } },
    });
    expect(shared.userDelete).toHaveBeenCalledOnce();
    expect(shared.userDelete.mock.calls[0]![0]).toMatchObject({ where: { id: 'u-account' } });
  });

  it('returns 409 when a new active campaign is created between the outer check and the txn re-check (race)', async () => {
    // Outer check sees 0 active.
    shared.santaFindMany.mockResolvedValueOnce([]);
    // Inside the txn, a concurrent POST has created a new active campaign.
    shared.santaCount.mockResolvedValueOnce(1);

    const res = await request(makeApp()).delete('/me/account');

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'active_santa_campaigns' });
    // user.delete MUST NOT have run in this race window.
    expect(shared.userDelete).not.toHaveBeenCalled();
    expect(shared.santaDeleteMany).not.toHaveBeenCalled();
  });
});
