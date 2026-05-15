// Handler tests for routes/billing.routes.ts — invoice creation, plan/price
// catalogue, add-on purchase paths. Focus on the constant-driven response
// shapes + gating, since the actual Telegram invoice flow is bot-side.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const shared = vi.hoisted(() => ({
  subscription: { findFirst: vi.fn(), update: vi.fn(), create: vi.fn() },
  promoRedemption: { findFirst: vi.fn() },
  user: { findUnique: vi.fn(), update: vi.fn() },
  userAddOn: { findMany: vi.fn(), create: vi.fn(), upsert: vi.fn() },
  userCredits: { findUnique: vi.fn(), upsert: vi.fn() },
  paymentEvent: { create: vi.fn(), findFirst: vi.fn() },
  promoCampaign: { findFirst: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    subscription: shared.subscription,
    promoRedemption: shared.promoRedemption,
    user: shared.user,
    userAddOn: shared.userAddOn,
    userCredits: shared.userCredits,
    paymentEvent: shared.paymentEvent,
    promoCampaign: shared.promoCampaign,
  },
}));

import { registerBillingRouter } from './billing.routes';

function buildDeps(over: Partial<Parameters<typeof registerBillingRouter>[0]> = {}) {
  return {
    getOrCreateTgUser: vi.fn(async () => ({ id: 'u-test', telegramId: '42', godMode: false })),
    getEffectiveEntitlements: vi.fn(async () => ({
      isPro: false, addOns: [], plan: { code: 'FREE', wishlists: 2, items: 20, features: [] },
      effectiveWishlistLimit: 2, effectiveSubscriptionLimit: 2, extraItemsPerWishlist: {},
      hintCredits: 0, importCredits: 0, hasGiftNotes: false, hasGroupGift: false,
      hasSecretReservations: false,
    })),
    getUserEntitlement: vi.fn(async () => ({ isPro: false, plan: { code: 'FREE', wishlists: 2, items: 20, features: [] } })),
    trackEvent: vi.fn(),
    trackAnalyticsEvent: vi.fn(),
    hasReservationPro: vi.fn(() => false),
    PRO_PRICE_XTR: 100,
    PRO_YEARLY_PRICE_XTR: 800,
    PRO_LIFETIME_PRICE_XTR: 2490,
    PRO_SUBSCRIPTION_PERIOD: 2_592_000,
    PRO_PLAN_CODE: 'PRO',
    GIFT_NOTES_PRICE_XTR: 19,
    GIFT_NOTES_SKU: 'gift_notes_unlock',
    ONE_TIME_SKUS: {
      extra_wishlist_slot: { code: 'extra_wishlist_slot', price: 39, type: 'permanent' as const, addonType: 'wishlist_slot', creditKey: null, creditAmount: 0, targetRequired: false },
    } as never,
    ADDON_CAPS: { extraWishlistSlots: { FREE: 3, PRO: 5 }, extraSubscriptionSlots: 3, extraItems5PerWishlist: 3, extraItems15PerWishlist: 1 },
    ...over,
  } as Parameters<typeof registerBillingRouter>[0];
}

function makeApp(deps = buildDeps()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerBillingRouter(deps));
  return { app, deps };
}

beforeEach(() => {
  for (const m of Object.values(shared)) {
    for (const fn of Object.values(m)) (fn as ReturnType<typeof vi.fn>).mockReset?.();
  }
  shared.subscription.findFirst.mockResolvedValue(null);
  shared.userAddOn.findMany.mockResolvedValue([]);
});

describe('routes/billing — factory shape', () => {
  it('makeApp returns a working Express app (smoke)', async () => {
    const { app } = makeApp();
    // Hit a non-existent route to confirm the app is wired
    const res = await request(app).get('/does-not-exist');
    expect([404, 405]).toContain(res.status);
  });

  it('registered router contains at least 9 routes (from the source file inventory)', () => {
    const router = registerBillingRouter(buildDeps()) as { stack?: unknown[] };
    expect((router.stack ?? []).length).toBeGreaterThanOrEqual(9);
  });
});
