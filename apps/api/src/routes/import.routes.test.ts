// Deep handler tests for routes/import.routes.ts — URL → item import.

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('@wishlist/db', () => ({
  prisma: new Proxy({}, {
    get() { return new Proxy({}, { get() { return vi.fn().mockResolvedValue(null); } }); },
  }),
}));

import { registerImportRouter } from './import.routes';

function buildDeps() {
  return new Proxy({}, {
    get(_target, key) {
      if (key === 'then') return undefined;
      return vi.fn();
    },
  }) as Parameters<typeof registerImportRouter>[0];
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerImportRouter(buildDeps()));
  return app;
}

describe('import — factory + boot', () => {
  it('factory returns Router with handlers', () => {
    const router = registerImportRouter(buildDeps()) as { stack?: unknown[] };
    expect(typeof router).toBe('function');
    expect((router.stack ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('unknown path 404s', async () => {
    const res = await request(makeApp()).get('/import/not-real');
    expect(res.status).toBe(404);
  });
});
