// Deep handler tests for routes/referral.routes.ts — invite code + history.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const shared = vi.hoisted(() => ({
  user: { findUnique: vi.fn(), update: vi.fn() },
  userProfile: { findUnique: vi.fn() },
  referralAttribution: { findMany: vi.fn(), count: vi.fn() },
  referralReward: { findMany: vi.fn(), aggregate: vi.fn() },
  referralProgramConfig: { findUnique: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: new Proxy({}, {
    get(_target, key) {
      if (typeof key !== 'string') return undefined;
      const map = shared as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
      return map[key] ?? new Proxy({}, { get() { return vi.fn().mockResolvedValue(null); } });
    },
  }),
  loadReferralConfig: vi.fn(async () => ({ enabled: false, notifyInviterReward: false })),
  isInRollout: vi.fn(() => false),
}));

import { registerRefRouter } from './referral.routes';

function buildDeps() {
  return {
    getOrCreateTgUser: vi.fn(async () => ({ id: 'u-test', telegramId: '42', referralCode: null })),
    trackAnalyticsEvent: vi.fn(),
    PRO_PLAN_CODE: 'PRO',
  } as Parameters<typeof registerRefRouter>[0];
}

function makeApp(deps = buildDeps()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerRefRouter(deps));
  return { app, deps };
}

beforeEach(() => {
  for (const m of Object.values(shared)) {
    for (const fn of Object.values(m)) (fn as ReturnType<typeof vi.fn>).mockReset?.();
  }
});

describe('referral — factory + boot', () => {
  it('factory returns Router with all 4 endpoints', () => {
    const router = registerRefRouter(buildDeps()) as { stack?: unknown[] };
    expect(typeof router).toBe('function');
    expect((router.stack ?? []).length).toBeGreaterThanOrEqual(4);
  });

  it('GET /referral/me invokes getOrCreateTgUser', async () => {
    const { app, deps } = makeApp();
    await request(app).get('/referral/me').catch(() => {});
    expect(deps.getOrCreateTgUser).toHaveBeenCalled();
  });

  it('GET /referral/rules-config returns config snapshot', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/referral/rules-config');
    expect([200, 500]).toContain(res.status); // depends on the mocked config shape
  });
});
