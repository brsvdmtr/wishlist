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
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    user: shared.user,
    wishlist: shared.wishlist,
    item: shared.item,
    referralAttribution: shared.referralAttribution,
    promoCampaign: shared.promoCampaign,
    promoRedemption: shared.promoRedemption,
  },
}));

import { registerAdminRouter } from './admin.routes';

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
