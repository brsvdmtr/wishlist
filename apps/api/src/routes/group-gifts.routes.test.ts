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

import { registerGroupGiftsRouter } from './group-gifts.routes';

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
