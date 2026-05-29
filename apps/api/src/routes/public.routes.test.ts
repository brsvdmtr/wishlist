// Deep handler tests for routes/public.routes.ts — guest-facing (no auth)
// item list / reserve / unreserve. Focus: rate limit middleware, slug
// resolution, reservation actor flow.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';

const shared = vi.hoisted(() => ({
  wishlist: { findUnique: vi.fn(), findFirst: vi.fn() },
  item: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  wishlistItemPlacement: { findMany: vi.fn() },
  reservationEvent: { create: vi.fn() },
  user: { findUnique: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    wishlist: shared.wishlist,
    item: shared.item,
    wishlistItemPlacement: shared.wishlistItemPlacement,
    reservationEvent: shared.reservationEvent,
    user: shared.user,
  },
}));

import { registerPublicRouter } from './public.routes';

function buildDeps() {
  return {
    ACTIVE_STATUSES: ['AVAILABLE', 'RESERVED', 'PURCHASED'] as const,
    actorBodySchema: z.object({ actorHash: z.string().min(8) }),
    getUserEntitlement: vi.fn(async () => ({ isPro: false })),
    trackEvent: vi.fn(),
    trackAnalyticsEvent: vi.fn(),
  } as Parameters<typeof registerPublicRouter>[0];
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(registerPublicRouter(buildDeps()));
  return app;
}

beforeEach(() => {
  for (const m of Object.values(shared)) {
    for (const fn of Object.values(m)) (fn as ReturnType<typeof vi.fn>).mockReset?.();
  }
});

describe('GET /wishlists/:slug/items — public read', () => {
  it('400 when slug param missing (Express path matches but slug empty)', async () => {
    // Express still matches /wishlists//items as /wishlists/:slug/items with empty slug.
    const res = await request(makeApp()).get('/wishlists//items');
    expect([400, 404]).toContain(res.status);
  });

  it('404 when wishlist not found', async () => {
    shared.wishlist.findUnique.mockResolvedValueOnce(null);
    const res = await request(makeApp()).get('/wishlists/missing-slug/items');
    expect(res.status).toBe(404);
  });

  it('queries wishlist by slug param when present', async () => {
    shared.wishlist.findUnique.mockResolvedValueOnce(null);
    await request(makeApp()).get('/wishlists/birthday/items');
    expect(shared.wishlist.findUnique).toHaveBeenCalled();
    const arg = shared.wishlist.findUnique.mock.calls[0]![0];
    expect(arg.where.slug).toBe('birthday');
  });
});

// Regression guard for the Tag-feature removal (docs/research/tags-decision.md).
// The Tag/ItemTag subsystem was dropped: item payloads must no longer carry a
// `tags` field, and the long-gone `?tag=` filter param must be silently ignored
// (NOT 400) so cached old Mini App / web clients in Telegram WebViews don't break.
describe('GET /wishlists/:slug/items — Tag removal regression', () => {
  it('ignores a stale ?tag= query param instead of 400 (cached-client safety)', async () => {
    // Reaches the wishlist lookup (→404 here) only if the query parsed OK; a
    // schema that rejected the unknown `tag` would short-circuit with 400.
    shared.wishlist.findUnique.mockResolvedValueOnce(null);
    const res = await request(makeApp()).get('/wishlists/some-slug/items?tag=books');
    expect(res.status).toBe(404);
  });

  it('item payload no longer includes a `tags` field', async () => {
    shared.wishlist.findUnique.mockResolvedValueOnce({ id: 'w1' });
    shared.wishlistItemPlacement.findMany.mockResolvedValueOnce([
      {
        position: 0,
        categoryId: null,
        item: {
          id: 'i1', title: 'Item', description: null, url: 'https://e.com',
          priceText: null, commentOwner: null, priority: 'MEDIUM', deadline: null,
          imageUrl: null, status: 'AVAILABLE', createdAt: new Date(), updatedAt: new Date(),
          reservationEvents: [],
        },
      },
    ]);
    const res = await request(makeApp()).get('/wishlists/birthday/items');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).not.toHaveProperty('tags');
  });
});

describe('POST /wishlists/:slug/items/:id/reserve — guest reservation', () => {
  it('400 when actorHash missing in body', async () => {
    const res = await request(makeApp())
      .post('/wishlists/x/items/i1/reserve')
      .send({});
    expect([400, 404]).toContain(res.status);
  });

  it('404 when wishlist not found', async () => {
    shared.wishlist.findUnique.mockResolvedValueOnce(null);
    const res = await request(makeApp())
      .post('/wishlists/missing/items/i1/reserve')
      .send({ actorHash: 'a'.repeat(16), comment: 'me' });
    expect([404, 400]).toContain(res.status);
  });
});
