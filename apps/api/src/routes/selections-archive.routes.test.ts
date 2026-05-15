// Deep handler tests for routes/selections-archive.routes.ts — curated
// selection subscription management.

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('@wishlist/db', () => ({
  prisma: new Proxy({}, {
    get() { return new Proxy({}, { get() { return vi.fn().mockResolvedValue(null); } }); },
  }),
}));

import { registerSelectionsArchiveRouter } from './selections-archive.routes';

function buildDeps() {
  return new Proxy({}, {
    get(_target, key) {
      if (key === 'then') return undefined;
      return vi.fn();
    },
  }) as Parameters<typeof registerSelectionsArchiveRouter>[0];
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerSelectionsArchiveRouter(buildDeps()));
  return app;
}

describe('selections-archive — factory + boot', () => {
  it('factory returns Router with 2+ handlers', () => {
    const router = registerSelectionsArchiveRouter(buildDeps()) as { stack?: unknown[] };
    expect(typeof router).toBe('function');
    expect((router.stack ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('unknown path 404s', async () => {
    const res = await request(makeApp()).get('/selections/x/totally-fake');
    expect(res.status).toBe(404);
  });
});
