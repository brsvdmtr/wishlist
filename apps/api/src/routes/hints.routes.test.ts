// Handler tests for routes/hints.routes.ts.
// POST /items/:id/hint creates a hint wave behind the FREE-quota gate.
//
// The allowance decision (getHintAllowance) and the analytics emit are mocked —
// this file pins the ROUTE glue: the gate ORDERING (item / ownership /
// hintsEnabled / status checks run BEFORE the quota gate, so the monetization
// upsell only fires for a user who would otherwise succeed), the 402 envelope,
// and the happy path. The allowance logic itself is covered by
// services/hint-credits.test.ts and test/integration/hint-credits.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const shared = vi.hoisted(() => ({
  item: { findUnique: vi.fn() },
  hint: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn(), count: vi.fn(), findMany: vi.fn() },
  user: { findUnique: vi.fn() },
  userProfile: { findUnique: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    item: shared.item,
    hint: shared.hint,
    user: shared.user,
    userProfile: shared.userProfile,
  },
}));

vi.mock('../telegram/botApi', () => ({
  sendTgBotMessage: vi.fn(async () => true),
}));

vi.mock('../services/hint-credits', () => ({
  getHintAllowance: vi.fn(),
}));

vi.mock('../services/analytics', () => ({
  trackProductEvent: vi.fn(),
}));

import { registerHintsRouter } from './hints.routes';
import { getHintAllowance } from '../services/hint-credits';

const mockAllowance = vi.mocked(getHintAllowance);

const ALLOWED = {
  allowed: true, isPro: false, freeLimit: 3, freeUsed: 0, freeRemaining: 3,
  paidCredits: 0, source: 'free' as const,
};

// A valid, owned, AVAILABLE item — the happy precondition the gate needs.
function ownedItem() {
  return { id: 'i1', title: 'X', status: 'AVAILABLE', wishlist: { ownerId: 'u-test', slug: 's' } };
}

function buildDeps(over: Partial<Parameters<typeof registerHintsRouter>[0]> = {}) {
  return {
    getOrCreateTgUser: vi.fn(async () => ({ id: 'u-test', godMode: false, telegramChatId: '123' })),
    getUserEntitlement: vi.fn(async () => ({ isPro: true, plan: { code: 'PRO' } })),
    trackEvent: vi.fn(),
    ...over,
  } as Parameters<typeof registerHintsRouter>[0];
}

function makeApp(deps = buildDeps()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerHintsRouter(deps));
  return { app, deps };
}

beforeEach(() => {
  for (const m of Object.values(shared)) {
    for (const fn of Object.values(m)) (fn as ReturnType<typeof vi.fn>).mockReset?.();
  }
  // Defaults: no item; hints enabled; clean downstream so a gate-pass reaches 200.
  shared.item.findUnique.mockResolvedValue(null);
  shared.userProfile.findUnique.mockResolvedValue({ hintsEnabled: true });
  shared.hint.findMany.mockResolvedValue([]);
  shared.hint.updateMany.mockResolvedValue({ count: 0 });
  shared.hint.findFirst.mockResolvedValue(null);
  shared.hint.count.mockResolvedValue(0);
  shared.hint.create.mockResolvedValue({ id: 'h-new' });
  mockAllowance.mockReset();
  mockAllowance.mockResolvedValue(ALLOWED);
});

describe('POST /items/:id/hint — gate ordering', () => {
  it('404 when the item does not exist (checked before the quota gate)', async () => {
    const res = await request(makeApp().app).post('/items/i1/hint').send({});
    expect(res.status).toBe(404);
    expect(mockAllowance).not.toHaveBeenCalled();
  });

  it('403 when the item belongs to another user', async () => {
    shared.item.findUnique.mockResolvedValue({
      ...ownedItem(), wishlist: { ownerId: 'someone-else', slug: 's' },
    });
    const res = await request(makeApp().app).post('/items/i1/hint').send({});
    expect(res.status).toBe(403);
    expect(mockAllowance).not.toHaveBeenCalled();
  });

  it('403 hints_disabled — the quota upsell never fires for a disabled user', async () => {
    shared.item.findUnique.mockResolvedValue(ownedItem());
    shared.userProfile.findUnique.mockResolvedValue({ hintsEnabled: false });
    const res = await request(makeApp().app).post('/items/i1/hint').send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('hints_disabled');
    // The quota gate runs AFTER the hintsEnabled check — a user who has hints
    // turned off is never counted as a monetization-funnel upsell.
    expect(mockAllowance).not.toHaveBeenCalled();
  });

  it('402 hint_quota_exhausted when a FREE user is out of quota and paid credits', async () => {
    shared.item.findUnique.mockResolvedValue(ownedItem());
    mockAllowance.mockResolvedValue({
      allowed: false, isPro: false, freeLimit: 3, freeUsed: 3, freeRemaining: 0,
      paidCredits: 0, source: 'none',
    });
    const deps = buildDeps({
      getUserEntitlement: vi.fn(async () => ({ isPro: false, plan: { code: 'FREE' } })),
    });
    const res = await request(makeApp(deps).app).post('/items/i1/hint').send({});
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('hint_quota_exhausted');
    expect(res.body.feature).toBe('hints');
    expect(res.body.packs).toEqual(['hints_pack_5', 'hints_pack_10']);
  });

  it('a user with quota passes the gate and the hint wave is created (200)', async () => {
    shared.item.findUnique.mockResolvedValue(ownedItem());
    const res = await request(makeApp().app).post('/items/i1/hint').send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('pending_selection');
    expect(res.body.hintId).toBe('h-new');
    expect(mockAllowance).toHaveBeenCalled();
  });
});

describe('routes/hints — factory shape', () => {
  it('registered router contains the expected route count', () => {
    const router = registerHintsRouter(buildDeps()) as { stack?: unknown[] };
    expect((router.stack ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
