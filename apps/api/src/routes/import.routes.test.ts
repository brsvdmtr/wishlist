// Handler tests for routes/import.routes.ts — credit-gated URL import.
//
// getImportAllowance / consumeImportCredit (services/import-credits) are mocked
// so the route's gate + decrement wiring is tested in isolation; the credit
// math itself is covered by services/import-credits.test.ts (unit) and
// test/integration/import-credits.test.ts (real Postgres).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('@wishlist/db', () => ({
  prisma: new Proxy({}, {
    get() { return new Proxy({}, { get() { return vi.fn().mockResolvedValue(null); } }); },
  }),
}));

vi.mock('../services/import-credits', () => ({
  getImportAllowance: vi.fn(),
  consumeImportCredit: vi.fn(),
}));

import { getImportAllowance, consumeImportCredit } from '../services/import-credits';
import { registerImportRouter } from './import.routes';

const mockAllowance = vi.mocked(getImportAllowance);
const mockConsume = vi.mocked(consumeImportCredit);

type Deps = Parameters<typeof registerImportRouter>[0];

function buildDeps(over: Partial<Deps> = {}): Deps {
  return {
    getOrCreateTgUser: vi.fn(async () => ({ id: 'u-test' })),
    getUserEntitlement: vi.fn(async () => ({ plan: { code: 'FREE', features: [] as string[] }, isPro: false })),
    trackEvent: vi.fn(),
    trackAnalyticsEvent: vi.fn(),
    importUrlForUser: vi.fn(async () => ({ item: { title: 'Thing', price: 100 }, wishlistId: 'w1', parseStatus: 'ok' as const })),
    DRAFTS_ITEM_LIMIT: 20,
    ...over,
  } as Deps;
}

let userSeq = 1000;
function makeApp(deps: Deps) {
  const uid = ++userSeq; // unique tgUser id ⇒ isolated express-rate-limit bucket
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: uid, first_name: 'T' };
    next();
  });
  app.use(registerImportRouter(deps));
  return app;
}

const POST_BODY = { url: 'https://example.com/product/42' };

beforeEach(() => { vi.clearAllMocks(); });

describe('import — factory + boot', () => {
  it('factory returns Router with handlers', () => {
    const router = registerImportRouter(buildDeps()) as { stack?: unknown[] };
    expect(typeof router).toBe('function');
    expect((router.stack ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('unknown path 404s', async () => {
    const res = await request(makeApp(buildDeps())).get('/import/not-real');
    expect(res.status).toBe(404);
  });
});

describe('import — credit gate', () => {
  it('FREE user with quota left imports and one credit is consumed (tests 1 + 3)', async () => {
    mockAllowance.mockResolvedValue({ allowed: true, isPro: false, freeLimit: 5, freeUsed: 2, freeRemaining: 3, paidCredits: 0, source: 'free' });
    mockConsume.mockResolvedValue({ consumed: 'free', freeLimit: 5, freeUsed: 3, freeRemaining: 2, paidCredits: 0 });
    const deps = buildDeps();
    const res = await request(makeApp(deps)).post('/import-url').send(POST_BODY);
    expect(res.status).toBe(201);
    expect(deps.importUrlForUser).toHaveBeenCalledOnce();
    expect(mockConsume).toHaveBeenCalledWith('u-test', { source: 'miniapp' });
    expect(res.body.importQuota).toEqual({ importCredits: 0, freeImportsUsed: 3, freeImportsLimit: 5 });
  });

  it('exhausted FREE quota → 402 unified addon_required envelope (test 4 — post-2026-05 paywall unification)', async () => {
    mockAllowance.mockResolvedValue({ allowed: false, isPro: false, freeLimit: 5, freeUsed: 5, freeRemaining: 0, paidCredits: 0, source: 'none' });
    const deps = buildDeps();
    const res = await request(makeApp(deps)).post('/import-url').send(POST_BODY);
    expect(res.status).toBe(402);
    // Migrated to unified paywall envelope: error code is now machine-readable
    // (addon_required), feature stays the same for FE routing, quota state
    // preserved for the upsell sheet.
    expect(res.body).toMatchObject({
      error: 'addon_required',
      feature: 'url_import',
      skuCode: 'import_pack_10',
      freeLimit: 5,
      freeUsed: 5,
      paidCredits: 0,
    });
    expect(deps.importUrlForUser).not.toHaveBeenCalled();
    expect(mockConsume).not.toHaveBeenCalled();
    expect(deps.trackAnalyticsEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'import.credit_pack_suggested' }),
    );
  });

  it('PRO user imports without consuming a credit (test 5)', async () => {
    mockAllowance.mockResolvedValue({ allowed: true, isPro: true, freeLimit: 5, freeUsed: 0, freeRemaining: 5, paidCredits: 0, source: 'pro' });
    const deps = buildDeps({
      getUserEntitlement: vi.fn(async () => ({ plan: { code: 'PRO', features: ['url_import'] }, isPro: true })),
    });
    const res = await request(makeApp(deps)).post('/import-url').send(POST_BODY);
    expect(res.status).toBe(201);
    expect(mockConsume).not.toHaveBeenCalled();
    expect(res.body.importQuota).toBeUndefined();
  });

  it('failed parse creates a stub item but does NOT consume a credit (test 2)', async () => {
    mockAllowance.mockResolvedValue({ allowed: true, isPro: false, freeLimit: 5, freeUsed: 0, freeRemaining: 5, paidCredits: 0, source: 'free' });
    const deps = buildDeps({
      importUrlForUser: vi.fn(async () => ({ item: { title: 'example.com' }, wishlistId: 'w1', parseStatus: 'failed' as const })),
    });
    const res = await request(makeApp(deps)).post('/import-url').send(POST_BODY);
    expect(res.status).toBe(201);
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('partial parse still consumes a credit (test 3 — partial counts as a real import)', async () => {
    mockAllowance.mockResolvedValue({ allowed: true, isPro: false, freeLimit: 5, freeUsed: 0, freeRemaining: 5, paidCredits: 0, source: 'free' });
    mockConsume.mockResolvedValue({ consumed: 'free', freeLimit: 5, freeUsed: 1, freeRemaining: 4, paidCredits: 0 });
    const deps = buildDeps({
      importUrlForUser: vi.fn(async () => ({ item: { title: 'Thing' }, wishlistId: 'w1', parseStatus: 'partial' as const })),
    });
    const res = await request(makeApp(deps)).post('/import-url').send(POST_BODY);
    expect(res.status).toBe(201);
    expect(mockConsume).toHaveBeenCalledOnce();
  });

  it('paid credits cover the import after the free quota is exhausted (test 6)', async () => {
    mockAllowance.mockResolvedValue({ allowed: true, isPro: false, freeLimit: 5, freeUsed: 5, freeRemaining: 0, paidCredits: 10, source: 'paid' });
    mockConsume.mockResolvedValue({ consumed: 'paid', freeLimit: 5, freeUsed: 5, freeRemaining: 0, paidCredits: 9 });
    const deps = buildDeps();
    const res = await request(makeApp(deps)).post('/import-url').send(POST_BODY);
    expect(res.status).toBe(201);
    expect(mockConsume).toHaveBeenCalledOnce();
    expect(res.body.importQuota).toEqual({ importCredits: 9, freeImportsUsed: 5, freeImportsLimit: 5 });
  });
});
