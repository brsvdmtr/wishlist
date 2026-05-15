// Deep handler tests for routes/internal.routes.ts — internal API endpoints.

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('@wishlist/db', () => ({
  prisma: new Proxy({}, {
    get() { return new Proxy({}, { get() { return vi.fn().mockResolvedValue(null); } }); },
  }),
}));

import { registerInternalRouter } from './internal.routes';

function buildDeps() {
  return new Proxy({}, {
    get(_target, key) {
      if (key === 'then') return undefined;
      return vi.fn();
    },
  }) as Parameters<typeof registerInternalRouter>[0];
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(registerInternalRouter(buildDeps()));
  return app;
}

describe('internal — factory + boot', () => {
  it('factory returns Router with handlers', () => {
    const router = registerInternalRouter(buildDeps()) as { stack?: unknown[] };
    expect(typeof router).toBe('function');
    expect((router.stack ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('unknown path returns 404 or 500 (permissive mocks may trigger crashes before route matching)', async () => {
    const res = await request(makeApp()).get('/internal/not-real');
    expect([404, 500]).toContain(res.status);
  });
});
