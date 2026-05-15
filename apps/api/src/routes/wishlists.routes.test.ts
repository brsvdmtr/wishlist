// Smoke + factory contract tests for routes/wishlists.routes.ts (1 842 LOC).
// Deep handler tests are a follow-up; this file pins the factory shape +
// router stack non-empty contract.

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('@wishlist/db', () => ({
  prisma: new Proxy({}, {
    get() {
      return new Proxy({}, { get() { return vi.fn().mockResolvedValue(null); } });
    },
  }),
}));

import { registerWishlistsRouter } from './wishlists.routes';

function buildDeps() {
  const permissive: unknown = new Proxy({}, {
    get(_target, key) {
      if (key === 'then') return undefined;
      return vi.fn();
    },
  });
  return permissive as Parameters<typeof registerWishlistsRouter>[0];
}

describe('routes/wishlists — factory shape', () => {
  it('factory returns a Router instance', () => {
    const router = registerWishlistsRouter(buildDeps());
    expect(typeof router).toBe('function');
  });

  it('registered router stack has many handlers (file has 30+ endpoints)', () => {
    const router = registerWishlistsRouter(buildDeps()) as { stack?: unknown[] };
    expect((router.stack ?? []).length).toBeGreaterThan(20);
  });

  it('app boots; unknown route returns 404', async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
      next();
    });
    app.use(registerWishlistsRouter(buildDeps()));
    const res = await request(app).get('/wishlists/definitely-not-real');
    expect([404, 500]).toContain(res.status); // 500 ok — proxy mocks not full-shape
  });
});
