// Handler tests for routes/hints.routes.ts (L4 lesson territory).
// POST /items/:id/hint creates a hint wave; GET /items/:id/hints lists them.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const shared = vi.hoisted(() => ({
  item: { findUnique: vi.fn() },
  hint: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn(), count: vi.fn(), findMany: vi.fn() },
  user: { findUnique: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    item: shared.item,
    hint: shared.hint,
    user: shared.user,
  },
}));

vi.mock('../telegram/botApi', () => ({
  sendTgBotMessage: vi.fn(async () => true),
}));

import { registerHintsRouter } from './hints.routes';

function buildDeps(over: Partial<Parameters<typeof registerHintsRouter>[0]> = {}) {
  return {
    getOrCreateTgUser: vi.fn(async () => ({ id: 'u-test', godMode: false, telegramChatId: '123' })),
    getUserEntitlement: vi.fn(async () => ({ isPro: true, plan: { code: 'PRO', features: ['hints'] } })),
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
  shared.item.findUnique.mockResolvedValue(null);
  shared.hint.findMany.mockResolvedValue([]);
});

describe('POST /items/:id/hint — feature gate', () => {
  it('402 when user is FREE (not PRO)', async () => {
    const deps = buildDeps({
      getUserEntitlement: vi.fn(async () => ({ isPro: false, plan: { code: 'FREE', features: [] } })),
    });
    const res = await request(makeApp(deps).app).post('/items/i1/hint').send({});
    expect(res.status).toBe(402);
  });

  it('404 when item not found', async () => {
    shared.item.findUnique.mockResolvedValueOnce(null);
    const res = await request(makeApp().app).post('/items/i1/hint').send({});
    expect(res.status).toBe(404);
  });

  it('403 when item belongs to another user (owner-only operation)', async () => {
    shared.item.findUnique.mockResolvedValueOnce({
      id: 'i1', title: 'X', wishlist: { ownerId: 'someone-else' },
      status: 'AVAILABLE',
    });
    const res = await request(makeApp().app).post('/items/i1/hint').send({});
    expect(res.status).toBe(403);
  });
});

describe('routes/hints — factory shape', () => {
  it('registered router contains the expected route count', () => {
    const router = registerHintsRouter(buildDeps()) as { stack?: unknown[] };
    expect((router.stack ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
