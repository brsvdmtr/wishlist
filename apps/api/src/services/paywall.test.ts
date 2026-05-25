// Unit tests for services/paywall.ts — the unified paywall envelope helper.
// Verifies envelope shape, status-code wiring, backward-compat field
// preservation, and SKU-driven priceXtr auto-resolution against the
// ONE_TIME_SKUS catalogue.

import { describe, it, expect, vi } from 'vitest';

vi.mock('@wishlist/db', () => ({ prisma: {} }));
vi.mock('./hint-credits', () => ({ getFreeHintsState: vi.fn() }));
vi.mock('./import-credits', () => ({ resolveFreeImports: vi.fn() }));

import {
  makeProRequired,
  makeAddonRequired,
  makePlanLimitReached,
  sendPaywall,
} from './paywall';

describe('makeProRequired', () => {
  it('builds minimal envelope with error code + feature', () => {
    expect(makeProRequired('categories')).toEqual({
      error: 'pro_required',
      feature: 'categories',
    });
  });

  it('preserves context (birthday advanced uses this for per-field gating)', () => {
    expect(
      makeProRequired('birthday_reminders_advanced', { context: 'audience' }),
    ).toEqual({
      error: 'pro_required',
      feature: 'birthday_reminders_advanced',
      context: 'audience',
    });
  });

  it('carries planCode for the upsell sheet', () => {
    expect(makeProRequired('showcase', { planCode: 'FREE' })).toEqual({
      error: 'pro_required',
      feature: 'showcase',
      planCode: 'FREE',
    });
  });

  it('preserves legacy `paywall` tag for backward compat (categories)', () => {
    const body = makeProRequired('categories', { planCode: 'FREE', paywallTag: 'categories' });
    expect(body.paywall).toBe('categories');
  });

  it('preserves legacy `message` for backward compat (privacy 403→402)', () => {
    const body = makeProRequired('wishlist_privacy', {
      planCode: 'FREE',
      message: 'Upgrade to Pro to use this setting',
    });
    expect(body.message).toBe('Upgrade to Pro to use this setting');
  });

  it('omits undefined optional fields', () => {
    const body = makeProRequired('showcase');
    expect(body).not.toHaveProperty('context');
    expect(body).not.toHaveProperty('planCode');
    expect(body).not.toHaveProperty('paywall');
    expect(body).not.toHaveProperty('message');
  });
});

describe('makeAddonRequired', () => {
  it('builds envelope with skuCode and auto-resolves priceXtr from SKU catalogue', () => {
    const body = makeAddonRequired('group_gift', { skuCode: 'group_gift_unlock' });
    expect(body.error).toBe('addon_required');
    expect(body.feature).toBe('group_gift');
    expect(body.skuCode).toBe('group_gift_unlock');
    expect(body.priceXtr).toBe(79);
  });

  it('caller-provided priceXtr wins over SKU catalogue', () => {
    const body = makeAddonRequired('hints', { skuCode: 'hints_pack_5', priceXtr: 42 });
    expect(body.priceXtr).toBe(42);
  });

  it('priceXtr stays undefined when skuCode is unknown and no override given', () => {
    const body = makeAddonRequired('mystery', { skuCode: 'something_unknown' });
    expect(body.priceXtr).toBeUndefined();
  });

  it('carries quota state for hints/url_import (freeLimit/freeUsed/paidCredits/packs)', () => {
    const body = makeAddonRequired('hints', {
      skuCode: 'hints_pack_5',
      planCode: 'FREE',
      freeLimit: 0,
      freeUsed: 0,
      paidCredits: 0,
      packs: ['hints_pack_5', 'hints_pack_10'],
    });
    expect(body).toMatchObject({
      error: 'addon_required',
      feature: 'hints',
      skuCode: 'hints_pack_5',
      priceXtr: 29,
      planCode: 'FREE',
      freeLimit: 0,
      freeUsed: 0,
      paidCredits: 0,
      packs: ['hints_pack_5', 'hints_pack_10'],
    });
  });

  it('group_gift_unlock SKU resolves to 79 XTR (matches GROUP_GIFT_PRICE_XTR default)', () => {
    expect(makeAddonRequired('group_gift', { skuCode: 'group_gift_unlock' }).priceXtr).toBe(79);
  });

  it('smart_reservations_unlock SKU resolves to 15 XTR', () => {
    expect(
      makeAddonRequired('smart_reservations', { skuCode: 'smart_reservations_unlock' }).priceXtr,
    ).toBe(15);
  });

  it('gift_notes_unlock SKU resolves to 19 XTR (default)', () => {
    expect(makeAddonRequired('gift_notes', { skuCode: 'gift_notes_unlock' }).priceXtr).toBe(19);
  });

  it('secret_reservation_unlock SKU resolves to 24 XTR (default)', () => {
    expect(
      makeAddonRequired('secret_reservations', { skuCode: 'secret_reservation_unlock' }).priceXtr,
    ).toBe(24);
  });

  it('reservation_pro_unlock SKU resolves to 50 XTR', () => {
    expect(
      makeAddonRequired('reservation_pro', { skuCode: 'reservation_pro_unlock' }).priceXtr,
    ).toBe(50);
  });

  it('omits undefined optional fields', () => {
    const body = makeAddonRequired('hints', { skuCode: 'hints_pack_5' });
    expect(body).not.toHaveProperty('freeLimit');
    expect(body).not.toHaveProperty('paidCredits');
    expect(body).not.toHaveProperty('packs');
    expect(body).not.toHaveProperty('limit');
  });
});

describe('makePlanLimitReached', () => {
  it('always carries limit (mandatory field)', () => {
    const body = makePlanLimitReached('wishlist_limit', { limit: 2 });
    expect(body.error).toBe('plan_limit_reached');
    expect(body.feature).toBe('wishlist_limit');
    expect(body.limit).toBe(2);
  });

  it('carries current usage for usage-based upsell copy', () => {
    const body = makePlanLimitReached('wishlist_limit', {
      limit: 2,
      current: 2,
      planCode: 'FREE',
    });
    expect(body).toMatchObject({
      error: 'plan_limit_reached',
      feature: 'wishlist_limit',
      limit: 2,
      current: 2,
      planCode: 'FREE',
    });
  });

  it('SKU hint auto-resolves priceXtr (extra_wishlist_slot upsell)', () => {
    const body = makePlanLimitReached('wishlist_limit', {
      limit: 2,
      current: 2,
      planCode: 'FREE',
      skuCode: 'extra_wishlist_slot',
    });
    expect(body.skuCode).toBe('extra_wishlist_slot');
    expect(body.priceXtr).toBe(39);
  });

  it('extra_items_5 SKU resolves to 19 XTR', () => {
    const body = makePlanLimitReached('item_limit', {
      limit: 20,
      current: 20,
      skuCode: 'extra_items_5',
    });
    expect(body.priceXtr).toBe(19);
  });

  it('caller-provided priceXtr wins over SKU catalogue', () => {
    const body = makePlanLimitReached('wishlist_limit', {
      limit: 2,
      skuCode: 'extra_wishlist_slot',
      priceXtr: 100,
    });
    expect(body.priceXtr).toBe(100);
  });
});

describe('sendPaywall', () => {
  function makeRes() {
    const captured = { status: 0, body: null as unknown };
    return {
      captured,
      status(n: number) { captured.status = n; return this; },
      json(b: unknown) { captured.body = b; return this; },
    };
  }

  it('sends 402 with body (pro_required path)', () => {
    const res = makeRes();
    // @ts-expect-error — minimal stub for Express Response
    sendPaywall(res, 402, makeProRequired('showcase'));
    expect(res.captured.status).toBe(402);
    expect(res.captured.body).toEqual({ error: 'pro_required', feature: 'showcase' });
  });

  it('sends 403 for hard-denial paths', () => {
    const res = makeRes();
    // @ts-expect-error — minimal stub for Express Response
    sendPaywall(res, 403, makeProRequired('secret_reservations'));
    expect(res.captured.status).toBe(403);
  });

  it('sends 409 for state-conflict paths (guest hits owner plan limit)', () => {
    const res = makeRes();
    sendPaywall(
      // @ts-expect-error — minimal stub for Express Response
      res,
      409,
      makePlanLimitReached('participant_limit', { limit: 10, current: 10 }),
    );
    expect(res.captured.status).toBe(409);
    expect(res.captured.body).toMatchObject({
      error: 'plan_limit_reached',
      feature: 'participant_limit',
      limit: 10,
      current: 10,
    });
  });
});
