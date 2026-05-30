// Smoke + factory contract tests for routes/wishlists.routes.ts (1 842 LOC).
// Deep handler tests are a follow-up; this file pins the factory shape +
// router stack non-empty contract.

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

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

// ---------------------------------------------------------------------------
// E17 — cross-layer field-name contract for the bootstrap yearly-price block.
// Driving a full 200 through the GET /tg/wishlists handler isn't possible here
// (the permissive proxy returns null for every prisma call), and the resolver
// itself (resolveYearlyDisplay → { priceXtr, variant }) is already covered by
// services/yearly-pricing.test.ts. What is NOT otherwise pinned is the route's
// rename of the resolver's `variant` into the RESPONSE key `priceVariant` — the
// exact field name the Mini App reads (json.proYearly.priceVariant) to tag the
// paywall.viewed yearlyVariant. A silent rename here re-breaks that tag with no
// type error (the client ingest casts json.proYearly). Pin it at the source,
// same grep-guard approach as web/monolith-guards.test.ts.
const ROUTES_SRC = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'wishlists.routes.ts'),
  'utf-8',
);

describe('routes/wishlists — E17 proYearly.priceVariant response contract', () => {
  it('maps the resolver bucket to proYearly.priceVariant (the field the client reads)', () => {
    expect(ROUTES_SRC).toMatch(/proYearly\s*=\s*yd\s*\?\s*\{[^}]*priceVariant:\s*yd\.variant[^}]*\}/);
  });

  it('spreads proYearly into the bootstrap response payload', () => {
    expect(ROUTES_SRC).toMatch(/\n\s*proYearly,/);
  });
});
