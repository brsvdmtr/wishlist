// Deep handler tests for routes/onboarding.routes.ts — onboarding state
// machine endpoints. Focus on the closure deps wiring + JSON shape.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const shared = vi.hoisted(() => ({
  userOnboardingState: { findUnique: vi.fn(), upsert: vi.fn(), update: vi.fn() },
  wishlist: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn() },
  item: { findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
  user: { findUnique: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    userOnboardingState: shared.userOnboardingState,
    wishlist: shared.wishlist,
    item: shared.item,
    user: shared.user,
  },
}));

import { registerOnboardingRouter } from './onboarding.routes';

function buildDeps() {
  return {
    getOrCreateTgUser: vi.fn(async () => ({ id: 'u-test', godMode: false, telegramChatId: '123' })),
    trackEvent: vi.fn(),
    completeOnboarding: vi.fn(async () => {}),
    runReferralProgressHook: vi.fn(async () => {}),
    importUrlForUser: vi.fn(async () => ({ item: { id: 'new', sourceDomain: null }, wishlistId: 'drafts', parseStatus: 'ok' as const })),
    getOrCreateDraftsWishlist: vi.fn(async () => ({ id: 'drafts' })),
    mapTgItem: vi.fn((it) => it),
  } as Parameters<typeof registerOnboardingRouter>[0];
}

function makeApp(deps = buildDeps()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerOnboardingRouter(deps));
  return { app, deps };
}

beforeEach(() => {
  for (const m of Object.values(shared)) {
    for (const fn of Object.values(m)) (fn as ReturnType<typeof vi.fn>).mockReset?.();
  }
});

describe('onboarding — factory + boot', () => {
  it('factory accepts deps and returns Router', () => {
    const router = registerOnboardingRouter(buildDeps());
    expect(typeof router).toBe('function');
    expect((router as { stack?: unknown[] }).stack?.length ?? 0).toBeGreaterThan(0);
  });

  it('unknown path returns 404', async () => {
    const { app } = makeApp();
    const res = await request(app).get('/onboarding/nope-not-real');
    expect(res.status).toBe(404);
  });
});
