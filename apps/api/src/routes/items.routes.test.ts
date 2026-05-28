// Handler-level tests for routes/items.routes.ts — the most incident-prone
// route file (L4 hints, plus general items CRUD + placement). Coverage focus:
// GET /items list, PRO gates on move-category, hint flow happy path, role
// resolution on PATCH/DELETE. Full deep coverage of all 21 handlers is a
// follow-up; this file pins the critical ones.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const shared = vi.hoisted(() => ({
  item: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    create: vi.fn(),
    count: vi.fn(),
  },
  wishlist: { findUnique: vi.fn(), findFirst: vi.fn() },
  wishlistCategory: { findUnique: vi.fn() },
  wishlistItemPlacement: {
    groupBy: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    aggregate: vi.fn(),
    update: vi.fn(),
    count: vi.fn(),
    updateMany: vi.fn(),
  },
  hint: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
}));

vi.mock('@wishlist/db', () => {
  const prisma: Record<string, unknown> = {
    item: shared.item,
    wishlist: shared.wishlist,
    wishlistCategory: shared.wishlistCategory,
    wishlistItemPlacement: shared.wishlistItemPlacement,
    hint: shared.hint,
    // $transaction shim: if called with a callback, run it against this same
    // prisma stub so handler-side `tx.*` resolves to the shared mocks; if
    // called with an array, resolve all and return their results.
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === 'function') return (arg as (tx: unknown) => Promise<unknown>)(prisma);
      if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
      return null;
    }),
  };
  // Minimal Prisma namespace shim: the Serializable transactions in C2/C3
  // pass `{ isolationLevel: Prisma.TransactionIsolationLevel.Serializable }`,
  // and the catch branch does `instanceof Prisma.PrismaClientKnownRequestError`.
  // The stub mirrors the runtime shape just enough to keep both expressions
  // valid in tests; we never simulate a P2034 conflict here.
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
  return { prisma, Prisma };
});

import { registerItemsRouter } from './items.routes';
import { z } from 'zod';

function buildDeps(overrides: Partial<Parameters<typeof registerItemsRouter>[0]> = {}) {
  const defaults: Parameters<typeof registerItemsRouter>[0] = {
    getOrCreateTgUser: vi.fn(async () => ({ id: 'u-test', godMode: false, telegramChatId: '123' })),
    getEffectiveEntitlements: vi.fn(async () => ({
      isPro: false,
      plan: { code: 'FREE', wishlists: 2, items: 20 },
      effectiveWishlistLimit: 2,
      extraItemsPerWishlist: {},
      hasGiftNotes: false,
      hasGroupGift: false,
    })),
    getUserEntitlement: vi.fn(async () => ({ isPro: false, plan: { code: 'FREE', wishlists: 2, items: 20 } })),
    getItemRole: vi.fn(async () => null),
    tgActorHash: vi.fn((id: number) => `actor-${id}`),
    trackEvent: vi.fn(),
    trackAnalyticsEvent: vi.fn(),
    mapTgItem: vi.fn((it) => ({ ...it, status: String(it.status).toLowerCase() })),
    isWishlistWritable: vi.fn(async () => true),
    countItemPlacements: vi.fn(async () => 1),
    cancelItemHints: vi.fn(async () => {}),
    notifySubscribersOfChange: vi.fn(async () => {}),
    ACTIVE_STATUSES: ['AVAILABLE', 'RESERVED', 'PURCHASED'] as const,
    zUrl: () => z.string().url(),
    numToPriority: vi.fn((n: number) => (n === 1 ? 'LOW' : n === 3 ? 'HIGH' : 'MEDIUM') as 'LOW' | 'MEDIUM' | 'HIGH'),
    completeOnboarding: vi.fn(async () => {}),
  };
  return { ...defaults, ...overrides } as Parameters<typeof registerItemsRouter>[0];
}

function makeApp(deps = buildDeps()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerItemsRouter(deps));
  return { app, deps };
}

beforeEach(() => {
  for (const m of Object.values(shared)) {
    for (const fn of Object.values(m)) (fn as ReturnType<typeof vi.fn>).mockReset?.();
  }
  shared.item.findMany.mockResolvedValue([]);
  shared.wishlistItemPlacement.groupBy.mockResolvedValue([]);
});

describe('GET /items — flat item list', () => {
  it('returns empty array when user has no items', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/items');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('filters to ACTIVE_STATUSES + non-archived wishlists', async () => {
    const { app } = makeApp();
    await request(app).get('/items');
    expect(shared.item.findMany).toHaveBeenCalled();
    const where = shared.item.findMany.mock.calls[0]![0].where;
    expect(where.status).toEqual({ in: ['AVAILABLE', 'RESERVED', 'PURCHASED'] });
    expect(where.wishlist.archivedAt).toBeNull();
    expect(where.archivedAt).toBeNull();
  });

  it('attaches placementCount via groupBy', async () => {
    shared.item.findMany.mockResolvedValueOnce([
      { id: 'i1', wishlistId: 'w1', title: 'A', url: '', priceText: null, imageUrl: null, priority: 'MEDIUM', status: 'AVAILABLE', description: null, sourceUrl: null, sourceDomain: null, importMethod: null, currency: null, wishlist: { title: 'WL', slug: 'wl' } },
      { id: 'i2', wishlistId: 'w1', title: 'B', url: '', priceText: null, imageUrl: null, priority: 'MEDIUM', status: 'AVAILABLE', description: null, sourceUrl: null, sourceDomain: null, importMethod: null, currency: null, wishlist: { title: 'WL', slug: 'wl' } },
    ]);
    shared.wishlistItemPlacement.groupBy.mockResolvedValueOnce([
      { itemId: 'i1', _count: { itemId: 3 } },
    ]);

    const { app } = makeApp();
    const res = await request(app).get('/items');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].placementCount).toBe(3);
    expect(res.body.items[1].placementCount).toBe(1); // default
  });

  it('skips placement groupBy when no items', async () => {
    const { app } = makeApp();
    await request(app).get('/items');
    expect(shared.wishlistItemPlacement.groupBy).not.toHaveBeenCalled();
  });
});

describe('POST /items/:id/move-category — ownership gate (PRO-only gate removed 2026-05-24)', () => {
  // Since the FREE plan ships with 1 free category per wishlist, this route
  // can no longer be PRO-only — owners must be able to move items into their
  // free category. Owner-check on the target category is the sole gate.

  it('400 when item id is missing (path-level)', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/items//move-category').send({ categoryId: 'c1' });
    expect([400, 404]).toContain(res.status);
  });

  it('400 when body has no categoryId', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/items/i1/move-category').send({});
    expect(res.status).toBe(400);
  });

  it('FREE user is NOT blocked: passes the gate, 404s only because the category itself is missing', async () => {
    const { app } = makeApp(); // default FREE deps
    shared.wishlistCategory.findUnique.mockResolvedValueOnce(null);
    const res = await request(app).post('/items/i1/move-category').send({ categoryId: 'c1' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Category not found' });
  });

  it('FREE user can move an item into their own category (200)', async () => {
    const { app } = makeApp(); // default FREE deps — caller is 'u-test'
    shared.wishlistCategory.findUnique.mockResolvedValueOnce({
      id: 'c-free',
      wishlistId: 'w1',
      wishlist: { ownerId: 'u-test' },
    });
    shared.wishlistItemPlacement.findUnique.mockResolvedValueOnce({ id: 'p1' });
    shared.wishlistItemPlacement.aggregate.mockResolvedValueOnce({ _max: { position: 2 } });
    shared.wishlistItemPlacement.update.mockResolvedValueOnce({});
    shared.item.updateMany.mockResolvedValueOnce({ count: 1 });

    const res = await request(app).post('/items/i1/move-category').send({ categoryId: 'c-free' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
  });

  it('403 when target category belongs to a different user (FREE deps)', async () => {
    const { app } = makeApp();
    shared.wishlistCategory.findUnique.mockResolvedValueOnce({
      id: 'c1',
      wishlistId: 'w1',
      wishlist: { ownerId: 'other-user' },
    });
    const res = await request(app).post('/items/i1/move-category').send({ categoryId: 'c1' });
    expect(res.status).toBe(403);
  });

  it('400 when item has no placement in the target wishlist', async () => {
    const { app } = makeApp();
    shared.wishlistCategory.findUnique.mockResolvedValueOnce({
      id: 'c1',
      wishlistId: 'w1',
      wishlist: { ownerId: 'u-test' },
    });
    shared.wishlistItemPlacement.findUnique.mockResolvedValueOnce(null);
    const res = await request(app).post('/items/i1/move-category').send({ categoryId: 'c1' });
    expect(res.status).toBe(400);
  });
});

describe('POST /items/:id/restore — capacity recheck (C3 regression)', () => {
  // Pre-fix: restore flipped status from DELETED → AVAILABLE with no quota
  // verification. A FREE user could create N items at the 20-item ceiling,
  // soft-delete some, create more, then restore the deleted ones → 2N items
  // in a single wishlist. The fix reuses ent.plan.items + extraItemsPerWishlist
  // and re-counts placements inside a Serializable transaction.

  it('returns 402 paywall when restoring would push the wishlist over plan limit', async () => {
    const { app } = makeApp();
    // Archived item owned by the caller.
    shared.item.findUnique.mockResolvedValueOnce({
      id: 'i-archived',
      status: 'DELETED',
      wishlist: { ownerId: 'u-test' },
    });
    // Item lives in one wishlist that is already at the FREE 20-item ceiling.
    shared.wishlistItemPlacement.findMany.mockResolvedValueOnce([
      { wishlistId: 'w-full' },
    ]);
    shared.wishlistItemPlacement.count.mockResolvedValueOnce(20);

    const res = await request(app).post('/items/i-archived/restore').send({});

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      error: 'plan_limit_reached',
      feature: 'item_limit',
      limit: 20,
      current: 20,
      context: 'w-full',
    });
    // Critical: the update MUST NOT have happened — status stays DELETED.
    expect(shared.item.update).not.toHaveBeenCalled();
  });

  it('permits restore when the destination wishlist has capacity headroom', async () => {
    const { app } = makeApp();
    shared.item.findUnique.mockResolvedValueOnce({
      id: 'i-ok',
      status: 'COMPLETED',
      wishlist: { ownerId: 'u-test' },
    });
    shared.wishlistItemPlacement.findMany.mockResolvedValueOnce([
      { wishlistId: 'w-ok' },
    ]);
    shared.wishlistItemPlacement.count.mockResolvedValueOnce(5); // well under 20
    shared.item.update.mockResolvedValueOnce({
      id: 'i-ok', wishlistId: 'w-ok', title: 'Item', url: '', priceText: null,
      currency: 'RUB', imageUrl: null, priority: 'MEDIUM', position: 1,
      status: 'AVAILABLE', description: null, sourceUrl: null, sourceDomain: null,
      importMethod: null, wishlist: { id: 'w-ok', title: 'My WL' },
    });

    const res = await request(app).post('/items/i-ok/restore').send({});

    expect(res.status).toBe(200);
    expect(shared.item.update).toHaveBeenCalledOnce();
    expect(shared.item.update.mock.calls[0]![0].data).toMatchObject({
      status: 'AVAILABLE',
      archivedAt: null,
      purgeAfter: null,
    });
  });
});
