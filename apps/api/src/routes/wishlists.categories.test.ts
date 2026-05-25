// Handler-level tests for the category CRUD endpoints in
// routes/wishlists.routes.ts. Pins the quota model that landed 2026-05-24:
// FREE = 1 user category per wishlist, PRO = 20. CREATE returns 402 with
// paywall='categories' when a FREE user hits the cap; the rest of the
// category lifecycle (rename / delete / reorder / move-item) is open to
// owners regardless of plan so the free category is actually usable.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';

const shared = vi.hoisted(() => ({
  wishlist: { findUnique: vi.fn() },
  wishlistCategory: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    updateMany: vi.fn(),
  },
  wishlistItemPlacement: {
    aggregate: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  item: { updateMany: vi.fn() },
}));

vi.mock('@wishlist/db', () => {
  // $transaction shim runs the callback against this same prisma stub so
  // `tx.*` calls inside the handler resolve to the shared mocks. Accepts
  // the optional `{ isolationLevel }` second arg used by Serializable txns.
  const prisma: Record<string, unknown> = {
    wishlist: shared.wishlist,
    wishlistCategory: shared.wishlistCategory,
    wishlistItemPlacement: shared.wishlistItemPlacement,
    item: shared.item,
    $transaction: vi.fn(async (arg: unknown, _opts?: unknown) => {
      if (typeof arg === 'function') {
        return (arg as (tx: unknown) => Promise<unknown>)(prisma);
      }
      if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
      return null;
    }),
  };
  // Minimum Prisma namespace surface used by the route under test:
  // TransactionIsolationLevel.Serializable + PrismaClientKnownRequestError
  // for the P2034 retry catch. Body irrelevant — the stubs only need to
  // exist so the import resolves at module-load time.
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  const Prisma = {
    TransactionIsolationLevel: { Serializable: 'Serializable' as const },
    PrismaClientKnownRequestError,
  };
  return { prisma, Prisma };
});

import { registerWishlistsRouter, type WishlistsRouterDeps } from './wishlists.routes';

const freePlan = {
  code: 'FREE' as const,
  wishlists: 2,
  items: 20,
  participants: 10,
  categoriesPerWishlist: 1,
  features: [] as readonly string[],
};

const proPlan = {
  code: 'PRO' as const,
  wishlists: 10,
  items: 70,
  participants: 20,
  categoriesPerWishlist: 20,
  features: ['comments', 'url_import', 'hints'] as readonly string[],
};

function makeEnt(plan: typeof freePlan | typeof proPlan, isPro: boolean) {
  return {
    plan,
    isPro,
    proSource: (isPro ? 'subscription' : null) as 'subscription' | 'promo' | 'god_mode' | null,
    subscription: null,
    promoPro: null,
    effectiveWishlistLimit: plan.wishlists,
    effectiveSubscriptionLimit: 5,
    extraItemsPerWishlist: {},
    smartReservationsWishlists: new Set<string>(),
    seasonalWishlists: new Set<string>(),
    addOns: [],
    hintCredits: 0,
    importCredits: 0,
    freeImportsUsed: 0,
    freeImportsLimit: 0,
    freeHintsUsed: 0,
    freeHintsLimit: 0,
    hasGiftNotes: isPro,
    giftNotes: null,
    hasGroupGift: false,
    groupGift: null,
    hasSecretReservations: isPro,
    secretReservations: null,
  };
}

function buildDeps(overrides: Partial<WishlistsRouterDeps> = {}): WishlistsRouterDeps {
  const defaults = {
    getOrCreateTgUser: vi.fn(async () => ({ id: 'u-test', godMode: false, telegramChatId: '123' })),
    getEffectiveEntitlements: vi.fn(async () => makeEnt(freePlan, false)),
    getUserEntitlement: vi.fn(async () => ({ isPro: false, plan: freePlan })),
    trackEvent: vi.fn(),
    trackAnalyticsEvent: vi.fn(),
    mapTgItem: vi.fn((it: unknown) => it as Record<string, unknown>),
    isWishlistWritable: vi.fn(async () => true),
    reassignPrimaryBeforeWishlistDelete: vi.fn(async () => {}),
    runReferralProgressHook: vi.fn(async () => {}),
    notifySubscribersOfChange: vi.fn(async () => {}),
    hasSmartReservations: vi.fn(() => false),
    ACTIVE_STATUSES: ['AVAILABLE', 'RESERVED', 'PURCHASED'] as const,
    ONE_TIME_SKUS: {} as Readonly<Record<string, { code: string; price: number; type: string; targetRequired: boolean }>>,
    numToPriority: vi.fn((n: number) => (n === 1 ? 'LOW' : n === 3 ? 'HIGH' : 'MEDIUM') as 'LOW' | 'MEDIUM' | 'HIGH'),
    completeOnboarding: vi.fn(async () => {}),
    ONBOARDING_KEY: 'onboarding',
    ONBOARDING_VERSION: 1,
    FORCED_ROLLOUT_USERS: new Set<string>(),
    variantKeyToSegment: vi.fn(() => 'ru' as const),
    zUrl: () => z.string().url(),
  };
  return { ...defaults, ...overrides } as WishlistsRouterDeps;
}

function makeApp(deps?: WishlistsRouterDeps) {
  const d = deps ?? buildDeps();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerWishlistsRouter(d));
  return { app, deps: d };
}

beforeEach(() => {
  for (const m of Object.values(shared)) {
    for (const fn of Object.values(m)) (fn as ReturnType<typeof vi.fn>).mockReset?.();
  }
  // Safe defaults: wishlist exists and belongs to caller, no categories yet,
  // default category exists so the handlers can attach items to it.
  shared.wishlist.findUnique.mockResolvedValue({ ownerId: 'u-test' });
  shared.wishlistCategory.findMany.mockResolvedValue([]);
  shared.wishlistCategory.findFirst.mockResolvedValue({ id: 'default-cat', wishlistId: 'w1', isDefault: true });
  shared.wishlistCategory.aggregate.mockResolvedValue({ _max: { sortOrder: -1 } });
  shared.wishlistCategory.create.mockResolvedValue({ id: 'c1', name: 'Travel', sortOrder: 0, isDefault: false });
  shared.wishlistCategory.update.mockResolvedValue({ id: 'c1', name: 'Renamed', sortOrder: 0, isDefault: false });
  shared.wishlistCategory.delete.mockResolvedValue({});
  shared.wishlistCategory.updateMany.mockResolvedValue({ count: 0 });
  shared.wishlistCategory.count.mockResolvedValue(0);
  shared.wishlistItemPlacement.aggregate.mockResolvedValue({ _max: { position: -1 } });
  shared.wishlistItemPlacement.findMany.mockResolvedValue([]);
  shared.wishlistItemPlacement.update.mockResolvedValue({});
  shared.wishlistItemPlacement.updateMany.mockResolvedValue({ count: 0 });
  shared.item.updateMany.mockResolvedValue({ count: 0 });
});

describe('POST /wishlists/:id/categories — quota gating', () => {
  it('FREE user creates the first category successfully (200)', async () => {
    shared.wishlistCategory.count.mockResolvedValueOnce(0);
    const { app } = makeApp();
    // Snapshot the $transaction mock to assert the isolation level. The
    // module-scope mock factory creates this fresh per vitest worker.
    const dbMod = (await import('@wishlist/db')) as unknown as { prisma: { $transaction: ReturnType<typeof vi.fn> } };
    const txMock = dbMod.prisma.$transaction;
    txMock.mockClear();

    const res = await request(app)
      .post('/wishlists/w1/categories')
      .send({ name: 'Travel' });
    expect(res.status).toBe(200);
    expect(res.body.category).toMatchObject({ name: 'Travel', isDefault: false });
    expect(res.body.isFirst).toBe(true);
    // Race-protection contract: the txn MUST run at Serializable level.
    // A future refactor that silently drops this option would re-introduce
    // the TOCTOU window the txn is here to close.
    expect(txMock).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ isolationLevel: 'Serializable' }),
    );
  });

  it('P2034 (Postgres serialization conflict) maps to 409 with code=CATEGORY_CONCURRENT_WRITE', async () => {
    // Simulate Postgres aborting one of two concurrent Serializable txns.
    // The handler must NOT return 503 — tgFetch on the FE treats 503 as a
    // maintenance signal and throws the response away, which would leave
    // the user with a frozen spinner and no recovery toast.
    const dbMod = (await import('@wishlist/db')) as unknown as {
      prisma: { $transaction: ReturnType<typeof vi.fn> };
      Prisma: { PrismaClientKnownRequestError: new (msg: string, code: string) => Error };
    };
    const err = new dbMod.Prisma.PrismaClientKnownRequestError('serialization failure', 'P2034');
    dbMod.prisma.$transaction.mockRejectedValueOnce(err);

    const { app } = makeApp();
    const res = await request(app)
      .post('/wishlists/w1/categories')
      .send({ name: 'Travel' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'Concurrent write conflict, please retry',
      code: 'CATEGORY_CONCURRENT_WRITE',
    });
  });

  it('FREE user is blocked at the second category with 402 paywall=categories', async () => {
    shared.wishlistCategory.count.mockResolvedValueOnce(1); // already at quota
    const { app, deps } = makeApp();
    const res = await request(app)
      .post('/wishlists/w1/categories')
      .send({ name: 'Books' });
    expect(res.status).toBe(402);
    // 2026-05 unified envelope: error code is now machine-readable
    // (pro_required), feature='categories' for FE routing, paywall='categories'
    // preserved for cached Mini App clients.
    expect(res.body).toMatchObject({
      error: 'pro_required',
      feature: 'categories',
      planCode: 'FREE',
      paywall: 'categories',
    });
    // Conversion signal: the paywall hit must fire with the new used/limit fields.
    expect(deps.trackEvent).toHaveBeenCalledWith(
      'feature_gate_hit_categories',
      'u-test',
      { plan: 'FREE', used: 1, limit: 1 },
    );
  });

  it('FREE user POSTing a whitespace-only name returns 400 (not a wasted slot)', async () => {
    shared.wishlistCategory.count.mockResolvedValueOnce(0);
    const { app } = makeApp();
    const res = await request(app)
      .post('/wishlists/w1/categories')
      .send({ name: '   ' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Empty name' });
  });

  it('PRO user creates multiple categories under the cap (200)', async () => {
    shared.wishlistCategory.count.mockResolvedValueOnce(5); // 5 used, 15 left
    const deps = buildDeps({ getEffectiveEntitlements: vi.fn(async () => makeEnt(proPlan, true)) });
    const { app } = makeApp(deps);
    const res = await request(app)
      .post('/wishlists/w1/categories')
      .send({ name: 'Tech' });
    expect(res.status).toBe(200);
  });

  it('PRO user hits 400 (not 402) at the 20-category cap', async () => {
    shared.wishlistCategory.count.mockResolvedValueOnce(20);
    const deps = buildDeps({ getEffectiveEntitlements: vi.fn(async () => makeEnt(proPlan, true)) });
    const { app } = makeApp(deps);
    const res = await request(app)
      .post('/wishlists/w1/categories')
      .send({ name: 'OverCap' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: 'Category limit reached', limit: 20 });
  });

  it('FREE delete-then-create works: deleting frees the quota slot', async () => {
    // 1. Delete the existing free category (count = 1 → 0 after delete)
    shared.wishlistCategory.findUnique.mockResolvedValueOnce({
      id: 'c1',
      wishlistId: 'w1',
      isDefault: false,
    });
    {
      const { app } = makeApp();
      const res = await request(app).delete('/wishlists/w1/categories/c1');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true });
    }

    // 2. Create again — count is now 0, so quota is back
    shared.wishlistCategory.count.mockResolvedValueOnce(0);
    {
      const { app } = makeApp();
      const res = await request(app)
        .post('/wishlists/w1/categories')
        .send({ name: 'Replacement' });
      expect(res.status).toBe(200);
    }
  });
});

describe('PATCH /wishlists/:wlId/categories/:catId — open to FREE', () => {
  it('FREE owner can rename their own category (200, no 402)', async () => {
    shared.wishlistCategory.findUnique.mockResolvedValueOnce({
      id: 'c1',
      wishlistId: 'w1',
      isDefault: false,
    });
    const { app } = makeApp();
    const res = await request(app)
      .patch('/wishlists/w1/categories/c1')
      .send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.category.name).toBe('Renamed');
  });

  it('403 when caller is not the wishlist owner', async () => {
    shared.wishlist.findUnique.mockResolvedValueOnce({ ownerId: 'other-user' });
    const { app } = makeApp();
    const res = await request(app)
      .patch('/wishlists/w1/categories/c1')
      .send({ name: 'Anything' });
    expect(res.status).toBe(403);
  });
});

describe('DELETE /wishlists/:wlId/categories/:catId — open to FREE', () => {
  it('FREE owner can delete their own category (200, no 402)', async () => {
    shared.wishlistCategory.findUnique.mockResolvedValueOnce({
      id: 'c1',
      wishlistId: 'w1',
      isDefault: false,
    });
    const { app } = makeApp();
    const res = await request(app).delete('/wishlists/w1/categories/c1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it('400 when trying to delete the default category', async () => {
    shared.wishlistCategory.findUnique.mockResolvedValueOnce({
      id: 'default-cat',
      wishlistId: 'w1',
      isDefault: true,
    });
    const { app } = makeApp();
    const res = await request(app).delete('/wishlists/w1/categories/default-cat');
    expect(res.status).toBe(400);
  });
});

describe('POST /wishlists/:id/categories/reorder — open to FREE', () => {
  it('FREE owner can reorder (200, no 402)', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/wishlists/w1/categories/reorder')
      .send({ orderedIds: ['c1'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });
});
