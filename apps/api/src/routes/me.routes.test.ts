// Smoke + factory contract tests for routes/me.routes.ts (2 362 LOC, many
// handlers covering /me/* endpoints). Deep per-endpoint coverage is a
// follow-up; this file pins the factory shape and basic gating.

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('@wishlist/db', () => ({
  prisma: new Proxy({}, {
    get() {
      return new Proxy({}, {
        get() { return vi.fn().mockResolvedValue(null); },
      });
    },
  }),
}));

import { registerMeRouter } from './me.routes';

function buildDeps() {
  return {
    getOrCreateTgUser: vi.fn(async () => ({ id: 'u-test', godMode: false, telegramId: '123', themePreference: null, accentPreference: null })),
    getEffectiveEntitlements: vi.fn(async () => ({
      isPro: false, addOns: [], plan: { code: 'FREE', items: 20, participants: 10, features: [] },
      effectiveWishlistLimit: 2, effectiveSubscriptionLimit: 2,
      extraItemsPerWishlist: {}, hintCredits: 0, importCredits: 0,
      freeImportsUsed: 0, freeImportsLimit: 5,
      freeHintsUsed: 0, freeHintsLimit: 3,
      hasGiftNotes: false, hasGroupGift: false, hasSecretReservations: false,
      seasonalWishlists: new Set<string>(), smartReservationsWishlists: new Set<string>(),
      proSource: null as null | string, subscription: null, promoPro: null,
      giftNotes: { unlocked: false, unlockType: null, priceXtr: 19 },
      groupGift: { unlocked: false, priceXtr: 79 },
      secretReservations: { unlocked: false, unlockType: null, priceXtr: 24 },
    })),
    getUserEntitlement: vi.fn(async () => ({ isPro: false })),
    hasReservationPro: vi.fn(() => false),
    isReservationBeta: vi.fn(() => true),
    trackEvent: vi.fn(),
    ACTIVE_STATUSES: ['AVAILABLE', 'RESERVED', 'PURCHASED'] as const,
    PRO_PRICE_XTR: 100,
    PRO_YEARLY_PRICE_XTR: 800,
    PRO_LIFETIME_PRICE_XTR: 2490,
    ONE_TIME_SKUS: {} as never,
  } as Parameters<typeof registerMeRouter>[0];
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerMeRouter(buildDeps()));
  return app;
}

describe('routes/me — factory shape', () => {
  it('factory returns a Router', () => {
    const router = registerMeRouter(buildDeps());
    expect(typeof router).toBe('function');
  });

  it('app boots and responds to unknown route with 404', async () => {
    const res = await request(makeApp()).get('/me/definitely-not-a-real-route');
    expect(res.status).toBe(404);
  });

  it('me deps factory accepts the deps contract shape (compile + runtime)', () => {
    expect(() => registerMeRouter(buildDeps())).not.toThrow();
  });
});
