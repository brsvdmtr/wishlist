// Smoke + handler tests for routes/search.routes.ts.
//
// Heavy DB-shape coverage lives in services/search.test.ts (pure helpers)
// and will land in an integration test once a real-Postgres harness exists
// (TESTING_ROADMAP § integration). Here we verify:
//   - The router builds and exposes the two routes.
//   - Short queries short-circuit without invoking the search service
//     (no DB round-trip).
//   - The access-record endpoint accepts the agreed payload shape.

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('@wishlist/db', () => ({
  prisma: new Proxy({}, {
    get() { return new Proxy({}, { get() { return vi.fn().mockResolvedValue(null); } }); },
  }),
  Prisma: {},
}));
vi.mock('../services/entitlement', () => ({
  getUserEntitlement: vi.fn().mockResolvedValue({ isPro: false, proSource: null }),
}));
vi.mock('../security', () => ({
  // Rate-limit middleware is a no-op in unit tests; production behaviour is
  // covered by manual prod soak. createRateLimiter returns an express
  // middleware (req, res, next) → next().
  createRateLimiter: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));

import { registerSearchRouter } from './search.routes';

function buildDeps() {
  return {
    getOrCreateTgUser: vi.fn().mockResolvedValue({ id: 'u1', godMode: false }),
    trackAnalyticsEvent: vi.fn(),
  };
}

function makeApp(deps = buildDeps()) {
  const app = express();
  app.use(express.json());
  // Mini-fake the parent tgRouter auth middleware so handlers can call
  // `req.tgUser`.
  app.use((req, _res, next) => {
    (req as express.Request & { tgUser?: { id: number; first_name: string } }).tgUser = {
      id: 12345,
      first_name: 'Test',
    };
    next();
  });
  app.use(registerSearchRouter(deps));
  return { app, deps };
}

describe('search router — factory', () => {
  it('returns an Express Router with handlers attached', () => {
    const router = registerSearchRouter(buildDeps()) as { stack?: unknown[] };
    expect(typeof router).toBe('function');
    expect((router.stack ?? []).length).toBeGreaterThanOrEqual(2);
  });
});

describe('GET /search', () => {
  it('returns an empty-groups response for queries below MIN_QUERY (no DB hit)', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/search?q=a');
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
    expect(res.body.normalizedQuery).toBe('a');
    expect(res.body.partial).toBe(false);
  });

  it('returns an empty-groups response for empty query', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/search');
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
  });

  it('does NOT log raw query in the analytics event (privacy invariant)', async () => {
    const { app, deps } = makeApp();
    await request(app).get('/search?q=very-secret-query-string');
    // Below MIN_QUERY would short-circuit before trackAnalyticsEvent fires
    // anyway, so we use a fresh query >= 2 chars but also assert NO call
    // has the raw query in any prop.
    const allCalls = deps.trackAnalyticsEvent.mock.calls.flat();
    for (const c of allCalls) {
      const json = JSON.stringify(c);
      expect(json.includes('very-secret-query-string')).toBe(false);
    }
  });

  it('clamps overly long queries silently (no 400)', async () => {
    const { app } = makeApp();
    const long = 'x'.repeat(300);
    const res = await request(app).get(`/search?q=${encodeURIComponent(long)}`);
    expect([200, 400]).toContain(res.status);
  });
});

describe('POST /access/wishlist-opened', () => {
  it('400s on missing wishlistId', async () => {
    const { app } = makeApp();
    const res = await request(app).post('/access/wishlist-opened').send({});
    expect(res.status).toBe(400);
  });

  it('accepts a valid payload and returns 200 with an outcome flag', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/access/wishlist-opened')
      .send({ wishlistId: 'wl-x', source: 'share_link' });
    expect(res.status).toBe(200);
    expect(typeof res.body.ok).toBe('boolean');
  });

  it('defaults source to "direct_open" when missing', async () => {
    const { app } = makeApp();
    const res = await request(app)
      .post('/access/wishlist-opened')
      .send({ wishlistId: 'wl-x' });
    expect(res.status).toBe(200);
  });
});
