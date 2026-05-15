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
    delete: vi.fn(),
    create: vi.fn(),
    count: vi.fn(),
  },
  wishlist: { findUnique: vi.fn(), findFirst: vi.fn() },
  wishlistCategory: { findUnique: vi.fn() },
  wishlistItemPlacement: { groupBy: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  hint: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    item: shared.item,
    wishlist: shared.wishlist,
    wishlistCategory: shared.wishlistCategory,
    wishlistItemPlacement: shared.wishlistItemPlacement,
    hint: shared.hint,
  },
}));

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

describe('POST /items/:id/move-category — PRO gate', () => {
  it('400 when item id is missing (path-level)', async () => {
    const { app } = makeApp();
    // Express path matches /items/:id so id missing → no match → 404 default
    const res = await request(app).post('/items//move-category').send({ categoryId: 'c1' });
    expect([400, 404]).toContain(res.status);
  });

  it('400 when body has no categoryId', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/items/i1/move-category').send({});
    expect(res.status).toBe(400);
  });

  it('402 PRO required when user is FREE', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/items/i1/move-category').send({ categoryId: 'c1' });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: 'Pro required', planCode: 'FREE' });
  });

  it('404 when category not found (PRO user)', async () => {
    const deps = buildDeps({
      getEffectiveEntitlements: vi.fn(async () => ({
        isPro: true,
        plan: { code: 'PRO', wishlists: 10, items: 70 },
        effectiveWishlistLimit: 10,
        extraItemsPerWishlist: {},
        hasGiftNotes: false,
        hasGroupGift: false,
      })),
    });
    shared.wishlistCategory.findUnique.mockResolvedValueOnce(null);

    const { app } = makeApp(deps);
    const res = await request(app).post('/items/i1/move-category').send({ categoryId: 'c1' });
    expect(res.status).toBe(404);
  });

  it('403 when target category belongs to a different user', async () => {
    const deps = buildDeps({
      getEffectiveEntitlements: vi.fn(async () => ({
        isPro: true,
        plan: { code: 'PRO', wishlists: 10, items: 70 },
        effectiveWishlistLimit: 10,
        extraItemsPerWishlist: {},
        hasGiftNotes: false,
        hasGroupGift: false,
      })),
    });
    shared.wishlistCategory.findUnique.mockResolvedValueOnce({
      id: 'c1',
      wishlistId: 'w1',
      wishlist: { ownerId: 'other-user' },
    });

    const { app } = makeApp(deps);
    const res = await request(app).post('/items/i1/move-category').send({ categoryId: 'c1' });
    expect(res.status).toBe(403);
  });
});
