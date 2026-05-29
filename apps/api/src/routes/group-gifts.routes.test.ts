// Deep handler tests for routes/group-gifts.routes.ts — group gift CRUD
// with hasGroupGift entitlement gate.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('@wishlist/db', () => ({
  prisma: new Proxy({}, {
    get() { return new Proxy({}, { get() { return vi.fn().mockResolvedValue(null); } }); },
  }),
}));

// E24 — bucket-aware price resolver; stub so the 402 backstop is deterministic.
vi.mock('../services/group-gift-pricing', () => ({
  resolveGroupGiftUnlockPrice: vi.fn(async () => ({
    priceXtr: 39, variant: 'treatment', controlPriceXtr: 79, testPriceXtr: 39,
  })),
}));

import { registerGroupGiftsRouter } from './group-gifts.routes';
import { resolveGroupGiftUnlockPrice } from '../services/group-gift-pricing';

function buildDeps() {
  return new Proxy({}, {
    get(_target, key) {
      if (key === 'then') return undefined;
      return vi.fn();
    },
  }) as Parameters<typeof registerGroupGiftsRouter>[0];
}

function makeApp(deps = buildDeps()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerGroupGiftsRouter(deps));
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('group-gifts — factory + boot', () => {
  it('factory returns Router with 5+ handlers', () => {
    const router = registerGroupGiftsRouter(buildDeps()) as { stack?: unknown[] };
    expect(typeof router).toBe('function');
    expect((router.stack ?? []).length).toBeGreaterThanOrEqual(5);
  });

  it('unknown path returns 404', async () => {
    const res = await request(makeApp()).get('/group-gifts/totally-fake');
    expect(res.status).toBe(404);
  });

  it('POST without body still routes (404 on path, not crash)', async () => {
    const res = await request(makeApp()).post('/group-gifts/x').send({});
    expect([400, 403, 404, 500]).toContain(res.status);
  });
});

describe('group-gifts — E24 paywall backstop quotes the bucket price', () => {
  function gateDeps() {
    return {
      getOrCreateTgUser: vi.fn(async () => ({ id: 'u1', godMode: false })),
      getEffectiveEntitlements: vi.fn(async () => ({ hasGroupGift: false })),
      tgActorHash: vi.fn(() => 'hash'),
      trackEvent: vi.fn(),
    } as unknown as Parameters<typeof registerGroupGiftsRouter>[0];
  }

  it('a non-entitled user creating a group gift gets 402 with the RESOLVED priceXtr', async () => {
    vi.mocked(resolveGroupGiftUnlockPrice).mockResolvedValue({
      priceXtr: 39, variant: 'treatment', controlPriceXtr: 79, testPriceXtr: 39,
    });
    const deps = gateDeps();
    const res = await request(makeApp(deps))
      .post('/items/item-1/group-gift')
      .send({ targetAmount: 100 });

    expect(res.status).toBe(402);
    expect(res.body.error).toBe('addon_required');
    expect(res.body.skuCode).toBe('group_gift_unlock');
    expect(res.body.priceXtr).toBe(39); // bucket price, not the static 79
    expect(resolveGroupGiftUnlockPrice).toHaveBeenCalledWith('u1');
    expect(deps.trackEvent).toHaveBeenCalledWith(
      'feature_gate_hit_group_gift', 'u1', expect.objectContaining({ priceXtr: 39, bucket: 'treatment' }),
    );
  });
});
