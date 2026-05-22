// Unit tests for services/entitlement.ts.
//
// Critical billing-adjacent module: PLANS, pricing constants, the
// PRO/FREE/godMode resolver, and the add-on / credit aggregation logic
// that every limit check downstream depends on. A regression here can
// silently grant or deny features to thousands of users.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  subFindFirst: vi.fn(),
  promoRedemptionFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  addOnFindMany: vi.fn(),
  creditsFindUnique: vi.fn(),
  wishlistFindMany: vi.fn(),
  hintChargeCount: vi.fn(),
  trackEvent: vi.fn(),
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    subscription: { findFirst: shared.subFindFirst },
    promoRedemption: { findFirst: shared.promoRedemptionFindFirst },
    user: { findUnique: shared.userFindUnique },
    userAddOn: { findMany: shared.addOnFindMany },
    userCredits: { findUnique: shared.creditsFindUnique },
    wishlist: { findMany: shared.wishlistFindMany },
    hintQuotaCharge: { count: shared.hintChargeCount },
  },
}));

vi.mock('./analytics', () => ({
  trackEvent: shared.trackEvent,
}));

import {
  PLANS,
  PRO_PRICE_XTR,
  PRO_YEARLY_PRICE_XTR,
  PRO_LIFETIME_PRICE_XTR,
  PRO_SUBSCRIPTION_PERIOD,
  ONE_TIME_SKUS,
  ADDON_CAPS,
  GIFT_NOTES_PRICE_XTR,
  GROUP_GIFT_PRICE_XTR,
  SECRET_RESERVATION_PRICE_XTR,
  isReservationBeta,
  hasReservationPro,
  getSmartResLeadHours,
  hasSmartReservations,
  getUserEntitlement,
  getEffectiveEntitlements,
  isWishlistWritable,
  requireGiftNotes,
} from './entitlement';

beforeEach(() => {
  for (const v of Object.values(shared)) (v as ReturnType<typeof vi.fn>).mockReset?.();
  shared.subFindFirst.mockResolvedValue(null);
  shared.promoRedemptionFindFirst.mockResolvedValue(null);
  shared.userFindUnique.mockResolvedValue({ godMode: false });
  shared.addOnFindMany.mockResolvedValue([]);
  shared.creditsFindUnique.mockResolvedValue(null);
  shared.wishlistFindMany.mockResolvedValue([]);
  shared.hintChargeCount.mockResolvedValue(0);
});

describe('PLANS catalogue', () => {
  it('FREE plan: 2 wishlists, 20 items, 10 participants, 2 subs, no features', () => {
    expect(PLANS.FREE).toMatchObject({
      code: 'FREE',
      wishlists: 2,
      items: 20,
      participants: 10,
      subscriptions: 2,
      features: [],
    });
  });

  it('PRO plan: 10 wishlists, 70 items, 20 participants, 5 subs, 3 features', () => {
    expect(PLANS.PRO).toMatchObject({
      code: 'PRO',
      wishlists: 10,
      items: 70,
      participants: 20,
      subscriptions: 5,
    });
    expect(PLANS.PRO.features).toEqual(['comments', 'url_import', 'hints']);
  });

  it('PRO uplift over FREE — wishlists 5×, items 3.5×, participants 2×, subs 2.5×', () => {
    expect(PLANS.PRO.wishlists / PLANS.FREE.wishlists).toBe(5);
    expect(PLANS.PRO.items / PLANS.FREE.items).toBeCloseTo(3.5, 1);
    expect(PLANS.PRO.participants / PLANS.FREE.participants).toBe(2);
    expect(PLANS.PRO.subscriptions / PLANS.FREE.subscriptions).toBe(2.5);
  });
});

describe('Pricing constants (PRO_*_XTR, one-time SKUs)', () => {
  it('PRO_PRICE_XTR resolves from env or defaults to 100', () => {
    expect(PRO_PRICE_XTR).toBeGreaterThan(0);
    expect(Number.isInteger(PRO_PRICE_XTR)).toBe(true);
  });

  it('yearly is cheaper per-month than monthly', () => {
    const monthlyYearCost = PRO_PRICE_XTR * 12;
    expect(PRO_YEARLY_PRICE_XTR).toBeLessThan(monthlyYearCost);
  });

  it('lifetime is more expensive than yearly (one-time premium)', () => {
    expect(PRO_LIFETIME_PRICE_XTR).toBeGreaterThan(PRO_YEARLY_PRICE_XTR);
  });

  it('PRO_SUBSCRIPTION_PERIOD is exactly 30 days in seconds (Telegram Stars cap)', () => {
    expect(PRO_SUBSCRIPTION_PERIOD).toBe(30 * 24 * 60 * 60);
  });

  it('GIFT_NOTES_PRICE_XTR / GROUP_GIFT_PRICE_XTR / SECRET_RESERVATION_PRICE_XTR are positive ints', () => {
    for (const v of [GIFT_NOTES_PRICE_XTR, GROUP_GIFT_PRICE_XTR, SECRET_RESERVATION_PRICE_XTR]) {
      expect(v).toBeGreaterThan(0);
      expect(Number.isInteger(v)).toBe(true);
    }
  });
});

describe('ONE_TIME_SKUS catalogue', () => {
  it('contains all 14 SKUs', () => {
    expect(Object.keys(ONE_TIME_SKUS)).toHaveLength(14);
  });

  it('every SKU has a positive integer price', () => {
    for (const sku of Object.values(ONE_TIME_SKUS)) {
      expect(sku.price).toBeGreaterThan(0);
      expect(Number.isInteger(sku.price)).toBe(true);
    }
  });

  it('every SKU has a recognised type', () => {
    const validTypes = new Set(['permanent', 'consumable', 'cosmetic']);
    for (const sku of Object.values(ONE_TIME_SKUS)) {
      expect(validTypes.has(sku.type)).toBe(true);
    }
  });

  it('consumables have a creditKey + positive creditAmount', () => {
    for (const sku of Object.values(ONE_TIME_SKUS)) {
      if (sku.type === 'consumable') {
        expect(sku.creditKey).toMatch(/^(hint|import)$/);
        expect(sku.creditAmount).toBeGreaterThan(0);
      }
    }
  });

  it('permanents have an addonType', () => {
    for (const sku of Object.values(ONE_TIME_SKUS)) {
      if (sku.type === 'permanent') {
        expect(sku.addonType).toBeTruthy();
      }
    }
  });
});

describe('ADDON_CAPS structure', () => {
  it('extraWishlistSlots caps differ for FREE and PRO', () => {
    expect(ADDON_CAPS.extraWishlistSlots.FREE).toBeLessThan(ADDON_CAPS.extraWishlistSlots.PRO);
  });

  it('extraSubscriptionSlots is +3 max for any plan', () => {
    expect(ADDON_CAPS.extraSubscriptionSlots).toBe(3);
  });

  it('item-slot add-ons cap at +15 items per wishlist total', () => {
    // extraItems5×3 = 15 OR extraItems15×1 = 15
    expect(ADDON_CAPS.extraItems5PerWishlist * 5).toBe(15);
    expect(ADDON_CAPS.extraItems15PerWishlist * 15).toBe(15);
  });
});

describe('Pure feature predicates', () => {
  describe('isReservationBeta', () => {
    it('returns true for everyone (v2: open to all)', () => {
      expect(isReservationBeta({ telegramId: null, godMode: false })).toBe(true);
      expect(isReservationBeta({ telegramId: '123', godMode: true })).toBe(true);
    });
  });

  describe('hasReservationPro', () => {
    it('godMode → true', () => {
      expect(hasReservationPro({ godMode: true }, false)).toBe(true);
    });

    it('PRO subscription → true', () => {
      expect(hasReservationPro({ godMode: false }, true)).toBe(true);
    });

    it('reservation_pro_unlock add-on → true', () => {
      expect(hasReservationPro({ godMode: false }, false, [{ addonType: 'reservation_pro_unlock' }])).toBe(true);
    });

    it('unrelated add-on → false', () => {
      expect(hasReservationPro({ godMode: false }, false, [{ addonType: 'extra_wishlist_slot' }])).toBe(false);
    });

    it('no signals → false', () => {
      expect(hasReservationPro({ godMode: false }, false)).toBe(false);
    });
  });

  describe('getSmartResLeadHours', () => {
    it('48 hours for week-long+ reservations', () => {
      expect(getSmartResLeadHours(168)).toBe(48);
      expect(getSmartResLeadHours(200)).toBe(48);
    });

    it('24 hours for 3-7 day reservations', () => {
      expect(getSmartResLeadHours(72)).toBe(24);
      expect(getSmartResLeadHours(120)).toBe(24);
    });

    it('12 hours for 2-3 day reservations', () => {
      expect(getSmartResLeadHours(48)).toBe(12);
      expect(getSmartResLeadHours(60)).toBe(12);
    });

    it('6 hours (minimum) for short reservations', () => {
      expect(getSmartResLeadHours(24)).toBe(6);
      expect(getSmartResLeadHours(2)).toBe(6);
      expect(getSmartResLeadHours(0)).toBe(6);
    });

    it('boundary: 168h returns 48 (inclusive low end)', () => {
      expect(getSmartResLeadHours(167.99)).toBe(24);
      expect(getSmartResLeadHours(168)).toBe(48);
    });
  });

  describe('hasSmartReservations', () => {
    it('godMode → true', () => {
      expect(hasSmartReservations({ godMode: true }, false, [], 'w1')).toBe(true);
    });

    it('PRO → true', () => {
      expect(hasSmartReservations({ godMode: false }, true, [], 'w1')).toBe(true);
    });

    it('per-wishlist unlock matches targetId → true', () => {
      const ok = hasSmartReservations(
        { godMode: false },
        false,
        [{ addonType: 'smart_reservations_unlock', targetId: 'w1' }],
        'w1',
      );
      expect(ok).toBe(true);
    });

    it('per-wishlist unlock for different wishlistId → false', () => {
      expect(
        hasSmartReservations(
          { godMode: false },
          false,
          [{ addonType: 'smart_reservations_unlock', targetId: 'w2' }],
          'w1',
        ),
      ).toBe(false);
    });

    it('add-on without targetId is ignored', () => {
      expect(
        hasSmartReservations(
          { godMode: false },
          false,
          [{ addonType: 'smart_reservations_unlock', targetId: null }],
          'w1',
        ),
      ).toBe(false);
    });
  });
});

describe('getUserEntitlement', () => {
  it('returns FREE plan when nothing matches', async () => {
    const result = await getUserEntitlement('u1');
    expect(result.plan).toBe(PLANS.FREE);
    expect(result.isPro).toBe(false);
    expect(result.proSource).toBeNull();
    expect(result.subscription).toBeNull();
    expect(result.promoPro).toBeNull();
  });

  it('returns PRO via subscription when active sub exists', async () => {
    shared.subFindFirst.mockResolvedValueOnce({
      id: 'sub1',
      status: 'ACTIVE',
      currentPeriodEnd: new Date('2099-01-01'),
      cancelledAt: null,
      cancelAtPeriodEnd: false,
      billingPeriod: 'monthly',
    });
    const result = await getUserEntitlement('u2');
    expect(result.isPro).toBe(true);
    expect(result.proSource).toBe('subscription');
    expect(result.subscription?.id).toBe('sub1');
  });

  it('returns PRO via promo when no subscription but active redemption exists', async () => {
    shared.promoRedemptionFindFirst.mockResolvedValueOnce({
      id: 'r1',
      expiresAt: new Date('2099-01-01'),
      campaign: { code: 'WISHPRO' },
    });
    const result = await getUserEntitlement('u3');
    expect(result.isPro).toBe(true);
    expect(result.proSource).toBe('promo');
    expect(result.promoPro?.campaignCode).toBe('WISHPRO');
  });

  it('subscription beats promo (priority order)', async () => {
    shared.subFindFirst.mockResolvedValueOnce({
      id: 's',
      status: 'ACTIVE',
      currentPeriodEnd: new Date('2099-01-01'),
      cancelledAt: null,
      cancelAtPeriodEnd: false,
      billingPeriod: 'monthly',
    });
    shared.promoRedemptionFindFirst.mockResolvedValueOnce({
      id: 'r',
      expiresAt: null,
      campaign: { code: 'X' },
    });
    const result = await getUserEntitlement('u4');
    expect(result.proSource).toBe('subscription');
    expect(result.promoPro).not.toBeNull(); // promo still surfaced for UI
  });

  it('godMode promotes to PRO when no real subscription', async () => {
    const result = await getUserEntitlement('u5', true);
    expect(result.isPro).toBe(true);
    expect(result.proSource).toBe('god_mode');
    expect(result.subscription).toBeNull();
  });

  it('lifetime promo (expiresAt:null) surfaces as expiresAt:null', async () => {
    shared.promoRedemptionFindFirst.mockResolvedValueOnce({
      id: 'r1',
      expiresAt: null,
      campaign: { code: 'LIFETIME' },
    });
    const result = await getUserEntitlement('u6');
    expect(result.promoPro?.expiresAt).toBeNull();
  });
});

describe('getEffectiveEntitlements — add-on aggregation', () => {
  it('aggregates extra wishlist slots from multiple add-ons', async () => {
    shared.userFindUnique.mockResolvedValueOnce({ godMode: false });
    shared.addOnFindMany.mockResolvedValueOnce([
      { addonType: 'wishlist_slot', quantity: 1, targetId: null },
      { addonType: 'wishlist_slot', quantity: 2, targetId: null },
    ]);
    const r = await getEffectiveEntitlements('u1');
    expect(r.effectiveWishlistLimit).toBe(PLANS.FREE.wishlists + 3);
  });

  it('aggregates per-wishlist item slot add-ons', async () => {
    shared.userFindUnique.mockResolvedValueOnce({ godMode: false });
    shared.addOnFindMany.mockResolvedValueOnce([
      { addonType: 'item_slot_5', quantity: 1, targetId: 'w1' },
      { addonType: 'item_slot_5', quantity: 2, targetId: 'w1' },
      { addonType: 'item_slot_15', quantity: 1, targetId: 'w2' },
    ]);
    const r = await getEffectiveEntitlements('u1');
    expect(r.extraItemsPerWishlist['w1']).toBe(3);
    expect(r.extraItemsPerWishlist['w2']).toBe(1);
  });

  it('exposes seasonal decoration wishlist IDs as a Set', async () => {
    shared.userFindUnique.mockResolvedValueOnce({ godMode: false });
    shared.addOnFindMany.mockResolvedValueOnce([
      { addonType: 'seasonal_decoration', quantity: 1, targetId: 'w1' },
      { addonType: 'seasonal_decoration', quantity: 1, targetId: 'w2' },
    ]);
    const r = await getEffectiveEntitlements('u1');
    expect(r.seasonalWishlists).toBeInstanceOf(Set);
    expect(r.seasonalWishlists.has('w1')).toBe(true);
    expect(r.seasonalWishlists.has('w2')).toBe(true);
    expect(r.seasonalWishlists.has('w3')).toBe(false);
  });

  it('reads hintCredits + importCredits from UserCredits row', async () => {
    shared.userFindUnique.mockResolvedValueOnce({ godMode: false });
    shared.creditsFindUnique.mockResolvedValueOnce({ hintCredits: 7, importCredits: 12 });
    const r = await getEffectiveEntitlements('u1');
    expect(r.hintCredits).toBe(7);
    expect(r.importCredits).toBe(12);
  });

  it('defaults credits to 0 when no UserCredits row', async () => {
    shared.userFindUnique.mockResolvedValueOnce({ godMode: false });
    const r = await getEffectiveEntitlements('u1');
    expect(r.hintCredits).toBe(0);
    expect(r.importCredits).toBe(0);
  });

  it('surfaces the FREE hint quota counted from the HintQuotaCharge ledger', async () => {
    shared.userFindUnique.mockResolvedValueOnce({ godMode: false });
    shared.hintChargeCount.mockResolvedValueOnce(2);
    const r = await getEffectiveEntitlements('u1');
    expect(r.freeHintsUsed).toBe(2);
    expect(r.freeHintsLimit).toBe(3);
  });

  it('giftNotes.unlocked=true for PRO users (subscription)', async () => {
    shared.subFindFirst.mockResolvedValueOnce({
      id: 's',
      status: 'ACTIVE',
      currentPeriodEnd: new Date('2099-01-01'),
      cancelledAt: null,
      cancelAtPeriodEnd: false,
      billingPeriod: 'monthly',
    });
    const r = await getEffectiveEntitlements('u1', false);
    expect(r.hasGiftNotes).toBe(true);
    expect(r.giftNotes.unlocked).toBe(true);
    expect(r.giftNotes.unlockType).toBe('PRO');
  });

  it('giftNotes.unlockType=ONE_TIME when add-on present and not PRO', async () => {
    shared.addOnFindMany.mockResolvedValueOnce([{ addonType: 'gift_notes_unlock', quantity: 1, targetId: null }]);
    const r = await getEffectiveEntitlements('u1', false);
    expect(r.giftNotes.unlocked).toBe(true);
    expect(r.giftNotes.unlockType).toBe('ONE_TIME');
  });

  it('groupGift is NOT included in PRO — requires separate add-on', async () => {
    shared.subFindFirst.mockResolvedValueOnce({
      id: 's', status: 'ACTIVE', currentPeriodEnd: new Date('2099-01-01'),
      cancelledAt: null, cancelAtPeriodEnd: false, billingPeriod: 'monthly',
    });
    const r = await getEffectiveEntitlements('u1', false);
    expect(r.hasGroupGift).toBe(false);
  });

  it('groupGift.unlocked=true with group_gift_unlock add-on', async () => {
    shared.addOnFindMany.mockResolvedValueOnce([{ addonType: 'group_gift_unlock', quantity: 1, targetId: null }]);
    const r = await getEffectiveEntitlements('u1', false);
    expect(r.hasGroupGift).toBe(true);
  });

  it('falls back to DB godMode when not passed explicitly', async () => {
    shared.userFindUnique.mockResolvedValueOnce({ godMode: true });
    const r = await getEffectiveEntitlements('u1');
    expect(r.isPro).toBe(true);
    expect(r.proSource).toBe('god_mode');
  });
});

describe('isWishlistWritable', () => {
  it('returns true for the first N wishlists (by createdAt) within the plan limit', async () => {
    shared.wishlistFindMany.mockResolvedValue([
      { id: 'w1' }, { id: 'w2' }, { id: 'w3' }, { id: 'w4' },
    ]);
    // Limit = 2: w1 and w2 are writable.
    expect(await isWishlistWritable('u1', 'w1', 2)).toBe(true);
    expect(await isWishlistWritable('u1', 'w2', 2)).toBe(true);
  });

  it('returns false for wishlists beyond the plan limit (locked tier)', async () => {
    shared.wishlistFindMany.mockResolvedValue([
      { id: 'w1' }, { id: 'w2' }, { id: 'w3' }, { id: 'w4' },
    ]);
    expect(await isWishlistWritable('u1', 'w3', 2)).toBe(false);
    expect(await isWishlistWritable('u1', 'w4', 2)).toBe(false);
  });

  it('returns false when wishlistId is not in user\'s set at all', async () => {
    shared.wishlistFindMany.mockResolvedValueOnce([{ id: 'w1' }]);
    expect(await isWishlistWritable('u1', 'foreign-id', 10)).toBe(false);
  });
});

describe('requireGiftNotes', () => {
  function fakeRes() {
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };
    return res;
  }

  it('returns true when entitlement has gift notes', () => {
    const res = fakeRes();
    const result = requireGiftNotes(
      { hasGiftNotes: true } as Parameters<typeof requireGiftNotes>[0],
      res,
    );
    expect(result).toBe(true);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns false + writes 403 when entitlement lacks gift notes', () => {
    const res = fakeRes();
    const result = requireGiftNotes(
      { hasGiftNotes: false } as Parameters<typeof requireGiftNotes>[0],
      res,
    );
    expect(result).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'gift_notes_required' });
  });

  it('tracks the analytics event feature_gate_hit_gift_notes when blocked', () => {
    requireGiftNotes(
      { hasGiftNotes: false } as Parameters<typeof requireGiftNotes>[0],
      fakeRes(),
    );
    expect(shared.trackEvent).toHaveBeenCalledWith('feature_gate_hit_gift_notes');
  });
});
