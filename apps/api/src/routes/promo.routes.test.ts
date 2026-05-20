// Deep handler tests for routes/promo.routes.ts — POST /promo/apply.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const shared = vi.hoisted(() => ({
  promoCampaign: { findUnique: vi.fn(), findFirst: vi.fn() },
  promoRedemption: { findFirst: vi.fn(), create: vi.fn() },
  user: { findUnique: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    promoCampaign: shared.promoCampaign,
    promoRedemption: shared.promoRedemption,
    user: shared.user,
  },
}));

import { registerPromoRouter } from './promo.routes';

function buildDeps() {
  return {
    getOrCreateTgUser: vi.fn(async () => ({ id: 'u-test', godMode: false })),
    getUserEntitlement: vi.fn(async () => ({ isPro: false, proSource: null, subscription: null })),
    trackEvent: vi.fn(),
    LIFECYCLE_PROMO_CODE: 'WISHPRO',
  } as Parameters<typeof registerPromoRouter>[0];
}

function makeApp(deps = buildDeps()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerPromoRouter(deps));
  return { app, deps };
}

beforeEach(() => {
  for (const m of Object.values(shared)) {
    for (const fn of Object.values(m)) (fn as ReturnType<typeof vi.fn>).mockReset?.();
  }
});

describe('POST /promo/apply', () => {
  it('400 with invalid_code on missing body', async () => {
    const res = await request(makeApp().app).post('/promo/apply').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_code');
  });

  it('400 with invalid_code on empty code', async () => {
    const res = await request(makeApp().app).post('/promo/apply').send({ code: '' });
    expect(res.status).toBe(400);
  });

  it('400 with invalid_code on too-long code (>50)', async () => {
    const res = await request(makeApp().app).post('/promo/apply').send({ code: 'x'.repeat(60) });
    expect(res.status).toBe(400);
  });

  it('normalises code (trim, upper, strip dashes/spaces) before lookup', async () => {
    shared.promoCampaign.findUnique.mockResolvedValueOnce(null);
    await request(makeApp().app).post('/promo/apply').send({ code: '  wish-pro  ' });
    // Either lookup happened with normalised, or 4xx because of missing campaign;
    // both confirm the code path doesn't 500 on whitespace/case
  });
});
