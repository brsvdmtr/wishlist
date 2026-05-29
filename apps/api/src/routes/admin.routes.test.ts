// Deep handler tests for routes/admin.routes.ts — admin-key gate + key
// CRUD paths. Critical: every endpoint requires X-ADMIN-KEY header.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';

const shared = vi.hoisted(() => ({
  user: { upsert: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
  wishlist: { create: vi.fn(), update: vi.fn(), delete: vi.fn(), findUnique: vi.fn() },
  item: { create: vi.fn(), update: vi.fn(), delete: vi.fn(), findUnique: vi.fn() },
  referralAttribution: { findUnique: vi.fn(), update: vi.fn() },
  promoCampaign: { create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
  promoRedemption: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  paymentEvent: { count: vi.fn(), findMany: vi.fn() },
  subscription: { count: vi.fn(), findMany: vi.fn() },
  purchase: { count: vi.fn(), findMany: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    user: shared.user,
    wishlist: shared.wishlist,
    item: shared.item,
    referralAttribution: shared.referralAttribution,
    promoCampaign: shared.promoCampaign,
    promoRedemption: shared.promoRedemption,
    paymentEvent: shared.paymentEvent,
    subscription: shared.subscription,
    purchase: shared.purchase,
  },
}));

import { registerAdminRouter } from './admin.routes';
import { ANALYTICS_EVENTS } from '@wishlist/shared';

function buildDeps() {
  return {
    ItemStatusSchema: z.enum(['AVAILABLE', 'RESERVED', 'PURCHASED', 'COMPLETED', 'DELETED', 'ARCHIVED']),
    PrioritySchema: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    zUrl: () => z.string().url(),
    reassignPrimaryBeforeWishlistDelete: vi.fn(async () => {}),
    trackAnalyticsEvent: vi.fn(),
    notifyReferralInviterRewarded: vi.fn(async () => {}),
  } as Parameters<typeof registerAdminRouter>[0];
}

function makeApp(adminKey?: string) {
  if (adminKey !== undefined) process.env.ADMIN_KEY = adminKey;
  else delete process.env.ADMIN_KEY;
  const app = express();
  app.use(express.json());
  app.use(registerAdminRouter(buildDeps()));
  return app;
}

beforeEach(() => {
  for (const m of Object.values(shared)) {
    for (const fn of Object.values(m)) (fn as ReturnType<typeof vi.fn>).mockReset?.();
  }
});

describe('admin — X-ADMIN-KEY auth gate', () => {
  it('500 when ADMIN_KEY env is not configured', async () => {
    const res = await request(makeApp()).post('/wishlists').send({ title: 'X' });
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/ADMIN_KEY/);
  });

  it('401 when X-ADMIN-KEY header is missing', async () => {
    const res = await request(makeApp('secret')).post('/wishlists').send({ title: 'X' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Unauthorized');
  });

  it('401 when X-ADMIN-KEY header is wrong', async () => {
    const res = await request(makeApp('correct'))
      .post('/wishlists')
      .set('X-ADMIN-KEY', 'wrong')
      .send({ title: 'X' });
    expect(res.status).toBe(401);
  });

  it('passes auth when X-ADMIN-KEY matches (uses secureCompare)', async () => {
    shared.user.upsert.mockResolvedValueOnce({ id: 'system-user', email: 'owner@local' });
    shared.wishlist.create.mockResolvedValueOnce({ id: 'w1', slug: 'x', title: 'X', description: null, deadline: null });

    const res = await request(makeApp('correct'))
      .post('/wishlists')
      .set('X-ADMIN-KEY', 'correct')
      .send({ title: 'X' });
    expect(res.status).toBe(201);
  });
});

describe('admin POST /wishlists', () => {
  it('400 when body is missing title', async () => {
    const res = await request(makeApp('k'))
      .post('/wishlists')
      .set('X-ADMIN-KEY', 'k')
      .send({});
    expect(res.status).toBe(400);
  });

  it('400 when title is empty string', async () => {
    const res = await request(makeApp('k'))
      .post('/wishlists')
      .set('X-ADMIN-KEY', 'k')
      .send({ title: '' });
    expect(res.status).toBe(400);
  });

  it('201 with created wishlist on valid body', async () => {
    shared.user.upsert.mockResolvedValueOnce({ id: 'sys', email: 'owner@local' });
    shared.wishlist.create.mockResolvedValueOnce({
      id: 'w1', slug: 'birthday', title: 'Birthday', description: null, deadline: null,
    });

    const res = await request(makeApp('k'))
      .post('/wishlists')
      .set('X-ADMIN-KEY', 'k')
      .send({ title: 'Birthday' });

    expect(res.status).toBe(201);
    expect(res.body.wishlist).toMatchObject({ id: 'w1', title: 'Birthday' });
  });
});

describe('GET /admin/billing/reconcile', () => {
  it('401 without X-ADMIN-KEY (admin-gated)', async () => {
    const res = await request(makeApp('secret')).get('/admin/billing/reconcile');
    expect(res.status).toBe(401);
  });

  it('returns the reconciliation report (200) and audits the run via analytics', async () => {
    process.env.ADMIN_KEY = 'secret';
    shared.paymentEvent.count.mockResolvedValue(0);
    shared.subscription.count.mockResolvedValue(0);
    shared.purchase.count.mockResolvedValue(0);
    shared.paymentEvent.findMany.mockResolvedValue([]);
    shared.subscription.findMany.mockResolvedValue([]);
    shared.purchase.findMany.mockResolvedValue([]);
    const trackSpy = vi.fn();
    const deps = { ...buildDeps(), trackAnalyticsEvent: trackSpy };
    const app = express();
    app.use(express.json());
    app.use(registerAdminRouter(deps));

    const res = await request(app).get('/admin/billing/reconcile').set('X-ADMIN-KEY', 'secret');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.scanned).toEqual({ paymentEvents: 0, subscriptions: 0, purchases: 0 });
    expect(trackSpy).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'admin.billing_reconcile_viewed' }),
    );
  });

  it('emits a REGISTERED analytics event (so trackAnalyticsEvent does not silently drop it)', () => {
    // Guards the round-2 bug where the audit event was emitted but absent from
    // the allowlist, making trackAnalyticsEvent a no-op.
    expect(ANALYTICS_EVENTS).toContain('admin.billing_reconcile_viewed');
  });
});
