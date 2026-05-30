// Smoke + factory contract tests for routes/me.routes.ts (2 362 LOC, many
// handlers covering /me/* endpoints). Deep per-endpoint coverage is a
// follow-up; this file pins the factory shape and basic gating.

import { describe, it, expect, vi, afterEach } from 'vitest';
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

// E17 — stub the yearly-price display resolver so the route tests are
// deterministic. Default null = dormant/Pro (the field is omitted), which keeps
// every pre-existing /me/plan test byte-identical; E17 tests override per-case.
vi.mock('../services/yearly-pricing', () => ({
  resolveYearlyDisplay: vi.fn(async () => null),
}));

import { registerMeRouter } from './me.routes';
import { resolveYearlyDisplay } from './../services/yearly-pricing';

type TestUser = { id: string; godMode: boolean; godModeActive: boolean; telegramId: string | null; themePreference: string | null; accentPreference: string | null };

function buildDeps(userOverride: Partial<TestUser> = {}) {
  const user: TestUser = { id: 'u-test', godMode: false, godModeActive: false, telegramId: '123', themePreference: null, accentPreference: null, ...userOverride };
  return {
    getOrCreateTgUser: vi.fn(async () => user),
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
    trackEvent: vi.fn(),
    getOrCreateDefaultWishlist: vi.fn(async () => ({
      id: 'wl-default-test', slug: 'wl-test12345678', title: 'My wishlist',
      isDefault: true, alreadyExisted: false,
    })),
    ACTIVE_STATUSES: ['AVAILABLE', 'RESERVED', 'PURCHASED'] as const,
    PRO_PRICE_XTR: 100,
    PRO_YEARLY_PRICE_XTR: 800,
    PRO_LIFETIME_PRICE_XTR: 2490,
    ONE_TIME_SKUS: {} as never,
  } as Parameters<typeof registerMeRouter>[0];
}

function makeApp(userOverride: Partial<TestUser> = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerMeRouter(buildDeps(userOverride)));
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

// POST /me/god-mode — operator's own god-mode toggle (restored 2026-05-29).
// Flips godModeActive; gated to GOD_MODE_TELEGRAM_IDS so only the owner's
// account can use it. The gate calls the REAL isGodModeTelegramId, so these
// tests drive it via process.env.GOD_MODE_TELEGRAM_IDS.
describe('POST /me/god-mode — operator toggle', () => {
  const prevEnv = process.env.GOD_MODE_TELEGRAM_IDS;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.GOD_MODE_TELEGRAM_IDS;
    else process.env.GOD_MODE_TELEGRAM_IDS = prevEnv;
  });

  it('eligible operator with toggle ON → turns god OFF (200, godMode:false)', async () => {
    process.env.GOD_MODE_TELEGRAM_IDS = '123';
    const res = await request(makeApp({ telegramId: '123', godModeActive: true })).post('/me/god-mode');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ godMode: false });
  });

  it('eligible operator with toggle OFF → turns god ON (200, godMode:true)', async () => {
    process.env.GOD_MODE_TELEGRAM_IDS = '123';
    const res = await request(makeApp({ telegramId: '123', godModeActive: false })).post('/me/god-mode');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ godMode: true });
  });

  it('security: non-allowlisted user gets 403 (toggle can never grant god)', async () => {
    process.env.GOD_MODE_TELEGRAM_IDS = '42'; // 123 is NOT in the allowlist
    const res = await request(makeApp({ telegramId: '123', godModeActive: false })).post('/me/god-mode');
    expect(res.status).toBe(403);
  });

  it('security: empty allowlist → even a would-be operator gets 403', async () => {
    process.env.GOD_MODE_TELEGRAM_IDS = '';
    const res = await request(makeApp({ telegramId: '123', godModeActive: true })).post('/me/god-mode');
    expect(res.status).toBe(403);
  });
});

describe('GET /me/plan — reservationPro contract', () => {
  // The Mini App reads `reservationPro` from this response to decide
  // upsell-vs-feature for filters/sort and the History tab. The dead
  // `reservationBeta` flag must not appear in the response.

  function appWith(overrides: Partial<Parameters<typeof registerMeRouter>[0]>) {
    const deps = { ...buildDeps(), ...overrides } as Parameters<typeof registerMeRouter>[0];
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
      next();
    });
    app.use(registerMeRouter(deps));
    return { app, deps };
  }

  it('FREE user with no addon → reservationPro=false in /me/plan', async () => {
    const hasReservationPro = vi.fn(() => false);
    const { app } = appWith({ hasReservationPro });
    const res = await request(app).get('/me/plan');
    expect(res.status).toBe(200);
    expect(res.body.reservationPro).toBe(false);
  });

  it('PRO sub user → reservationPro=true in /me/plan', async () => {
    const hasReservationPro = vi.fn(() => true);
    const { app } = appWith({ hasReservationPro });
    const res = await request(app).get('/me/plan');
    expect(res.status).toBe(200);
    expect(res.body.reservationPro).toBe(true);
  });

  it('response does NOT include the retired reservationBeta field', async () => {
    const { app } = appWith({});
    const res = await request(app).get('/me/plan');
    expect(res.body).not.toHaveProperty('reservationBeta');
  });

  it('hasReservationPro is invoked with (user, ent.isPro, ent.addOns)', async () => {
    const hasReservationPro = vi.fn(
      (_user: { godMode: boolean }, _isPro: boolean, _addOns?: Array<{ addonType: string }>) => false,
    );
    const { app } = appWith({ hasReservationPro });
    await request(app).get('/me/plan');
    expect(hasReservationPro).toHaveBeenCalled();
    expect(hasReservationPro).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'u-test', godMode: false }),
      false,
      [],
    );
  });

  // Conservative pricing patch (2026-05-28) hides seasonal_decoration from
  // the inventory while keeping the SKU in ONE_TIME_SKUS so historical
  // purchases and the bot's invoice handler still resolve. A wiring
  // regression (someone refactoring the `Object.values(...).filter(...).map`
  // and dropping the filter step) would silently re-expose the buy card.
  // This test pins the filter at the route boundary.
  it('GET /me/plan skus array hides HIDDEN_FROM_INVENTORY_SKUS (seasonal_decoration)', async () => {
    const fakeSkus = {
      extra_wishlist_slot: {
        code: 'extra_wishlist_slot', price: 39, type: 'permanent', targetRequired: false,
      },
      seasonal_decoration: {
        code: 'seasonal_decoration', price: 29, type: 'cosmetic', targetRequired: true,
      },
      hints_pack_5: {
        code: 'hints_pack_5', price: 29, type: 'consumable', targetRequired: false,
      },
    } as Parameters<typeof registerMeRouter>[0]['ONE_TIME_SKUS'];
    const { app } = appWith({ ONE_TIME_SKUS: fakeSkus });
    const res = await request(app).get('/me/plan');
    expect(res.status).toBe(200);
    const codes = (res.body.skus as Array<{ code: string }>).map(s => s.code);
    expect(codes).toContain('extra_wishlist_slot');
    expect(codes).toContain('hints_pack_5');
    expect(codes).not.toContain('seasonal_decoration');
  });

  // E17 — the canonical pricing endpoint must surface the SAME bucket price the
  // /pro/checkout invoice charges (shown == charged). The !isPro + active gating
  // lives in resolveYearlyDisplay (unit-tested in yearly-pricing.test.ts); these
  // pin the route WIRING: active → bucket fields present; null → flat-800
  // fallback with no variant; and that the resolver is asked with ent.isPro.
  describe('E17 yearly bucket price', () => {
    afterEach(() => vi.mocked(resolveYearlyDisplay).mockReset());

    it('active arm a → proYearlyPriceStars 600 + proYearlyPriceVariant "a"', async () => {
      vi.mocked(resolveYearlyDisplay).mockResolvedValue({ priceXtr: 600, variant: 'a' });
      const { app } = appWith({});
      const res = await request(app).get('/me/plan');
      expect(res.status).toBe(200);
      expect(res.body.proYearlyPriceStars).toBe(600);
      expect(res.body.proYearlyPriceVariant).toBe('a');
    });

    it('dormant / null → flat 800 and NO proYearlyPriceVariant field (byte-identical to today)', async () => {
      vi.mocked(resolveYearlyDisplay).mockResolvedValue(null);
      const { app } = appWith({});
      const res = await request(app).get('/me/plan');
      expect(res.status).toBe(200);
      expect(res.body.proYearlyPriceStars).toBe(800);
      expect(res.body).not.toHaveProperty('proYearlyPriceVariant');
    });

    it('asks the resolver with the user id + ent.isPro so Pro users are gated out at the source', async () => {
      vi.mocked(resolveYearlyDisplay).mockResolvedValue(null);
      const { app } = appWith({});
      await request(app).get('/me/plan');
      expect(resolveYearlyDisplay).toHaveBeenCalledWith('u-test', false);
    });
  });
});
