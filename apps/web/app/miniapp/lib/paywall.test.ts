// Tests for the Mini App paywall parser. Verifies that:
//   - the canonical new envelope round-trips faithfully,
//   - the six legacy variants normalize to the new contract,
//   - 402/403/409 are accepted; everything else is rejected,
//   - paywallContextFromError gates upsell on status=402 only.

import { describe, it, expect } from 'vitest';

import { parsePaywallError, paywallContextFromError } from './paywall';

describe('parsePaywallError — gating', () => {
  it('returns null for non-paywall HTTP status codes', () => {
    expect(parsePaywallError(200, {})).toBeNull();
    expect(parsePaywallError(400, { error: 'pro_required' })).toBeNull();
    expect(parsePaywallError(404, {})).toBeNull();
    expect(parsePaywallError(500, {})).toBeNull();
  });

  it('returns null for null / non-object bodies', () => {
    expect(parsePaywallError(402, null)).toBeNull();
    expect(parsePaywallError(402, 'string')).toBeNull();
    expect(parsePaywallError(402, undefined)).toBeNull();
    expect(parsePaywallError(402, 42)).toBeNull();
  });

  it('accepts 402, 403, and 409', () => {
    expect(parsePaywallError(402, { error: 'pro_required', feature: 'showcase' })).not.toBeNull();
    expect(parsePaywallError(403, { error: 'pro_required', feature: 'showcase' })).not.toBeNull();
    expect(parsePaywallError(409, { error: 'plan_limit_reached', feature: 'participant_limit', limit: 10 })).not.toBeNull();
  });
});

describe('parsePaywallError — canonical new envelope', () => {
  it('parses pro_required + feature + context (birthday advanced)', () => {
    const parsed = parsePaywallError(402, {
      error: 'pro_required',
      feature: 'birthday_reminders_advanced',
      context: 'audience',
    });
    expect(parsed).toMatchObject({
      status: 402,
      error: 'pro_required',
      feature: 'birthday_reminders_advanced',
      context: 'audience',
    });
  });

  it('parses addon_required + feature + skuCode + priceXtr', () => {
    const parsed = parsePaywallError(402, {
      error: 'addon_required',
      feature: 'group_gift',
      skuCode: 'group_gift_unlock',
      priceXtr: 79,
    });
    expect(parsed).toMatchObject({
      status: 402,
      error: 'addon_required',
      feature: 'group_gift',
      skuCode: 'group_gift_unlock',
      priceXtr: 79,
    });
  });

  it('parses plan_limit_reached + limit + current + planCode', () => {
    const parsed = parsePaywallError(402, {
      error: 'plan_limit_reached',
      feature: 'wishlist_limit',
      limit: 2,
      current: 2,
      planCode: 'FREE',
    });
    expect(parsed).toMatchObject({
      status: 402,
      error: 'plan_limit_reached',
      feature: 'wishlist_limit',
      limit: 2,
      current: 2,
      planCode: 'FREE',
    });
  });
});

describe('parsePaywallError — legacy shapes', () => {
  it('maps import_quota_exhausted → addon_required, feature=url_import (envelope #5)', () => {
    const parsed = parsePaywallError(402, {
      error: 'import_quota_exhausted',
      feature: 'url_import',
      planCode: 'FREE',
      freeLimit: 5,
      freeUsed: 5,
      paidCredits: 0,
    });
    expect(parsed?.error).toBe('addon_required');
    expect(parsed?.feature).toBe('url_import');
    expect(parsed?.freeLimit).toBe(5);
    expect(parsed?.freeUsed).toBe(5);
    expect(parsed?.paidCredits).toBe(0);
  });

  it('maps hint_quota_exhausted → addon_required, feature=hints (envelope #5)', () => {
    const parsed = parsePaywallError(402, {
      error: 'hint_quota_exhausted',
      planCode: 'FREE',
      packs: ['hints_pack_5', 'hints_pack_10'],
    });
    expect(parsed?.error).toBe('addon_required');
    expect(parsed?.feature).toBe('hints');
    expect(parsed?.packs).toEqual(['hints_pack_5', 'hints_pack_10']);
  });

  it('maps group_gift_required → addon_required, feature=group_gift', () => {
    const parsed = parsePaywallError(403, { error: 'group_gift_required', priceXtr: 79 });
    expect(parsed?.error).toBe('addon_required');
    expect(parsed?.feature).toBe('group_gift');
    expect(parsed?.priceXtr).toBe(79);
  });

  it('maps Plan limit reached → plan_limit_reached (envelope #4)', () => {
    const parsed = parsePaywallError(402, { error: 'Plan limit reached', limit: 2, planCode: 'FREE' });
    expect(parsed?.error).toBe('plan_limit_reached');
    expect(parsed?.limit).toBe(2);
  });

  it('maps Subscription limit reached → plan_limit_reached', () => {
    const parsed = parsePaywallError(402, { error: 'Subscription limit reached', limit: 2, planCode: 'FREE' });
    expect(parsed?.error).toBe('plan_limit_reached');
  });

  it('maps Pro required → pro_required (envelope #6 categories shape)', () => {
    const parsed = parsePaywallError(402, {
      error: 'Pro required',
      planCode: 'FREE',
      paywall: 'categories',
    });
    expect(parsed?.error).toBe('pro_required');
    expect(parsed?.feature).toBe('categories');
    expect(parsed?.paywall).toBe('categories');
  });

  it('maps Pro feature → pro_required (envelope #2 comments shape)', () => {
    const parsed = parsePaywallError(402, { error: 'Pro feature', feature: 'comments', planCode: 'FREE' });
    expect(parsed?.error).toBe('pro_required');
    expect(parsed?.feature).toBe('comments');
  });

  it('infers feature from legacy paywall tag when feature absent', () => {
    const parsed = parsePaywallError(402, {
      error: 'Pro required',
      planCode: 'FREE',
      paywall: 'categories',
    });
    expect(parsed?.feature).toBe('categories');
  });

  it('keeps error=null when legacy string is unknown', () => {
    const parsed = parsePaywallError(402, { error: 'totally_unknown_code' });
    expect(parsed?.error).toBeNull();
  });

  it('rejects malformed packs (non-string entries) silently', () => {
    const parsed = parsePaywallError(402, {
      error: 'addon_required',
      feature: 'hints',
      packs: ['valid', 42, null],
    });
    expect(parsed?.packs).toBeUndefined();
  });

  it('preserves the legacy `message` field (privacy 403 envelope)', () => {
    const parsed = parsePaywallError(403, {
      error: 'pro_required',
      message: 'Upgrade to Pro to use this setting',
    });
    expect(parsed?.message).toBe('Upgrade to Pro to use this setting');
  });
});

describe('paywallContextFromError — upsell routing', () => {
  it('returns null for null input', () => {
    expect(paywallContextFromError(null)).toBeNull();
  });

  it('maps feature=url_import → url_import (canonical)', () => {
    const parsed = parsePaywallError(402, { error: 'addon_required', feature: 'url_import' });
    expect(paywallContextFromError(parsed)).toBe('url_import');
  });

  it('maps feature=categories → categories', () => {
    const parsed = parsePaywallError(402, { error: 'pro_required', feature: 'categories' });
    expect(paywallContextFromError(parsed)).toBe('categories');
  });

  it('maps feature=showcase → showcase (post 403→402 migration)', () => {
    const parsed = parsePaywallError(402, { error: 'pro_required', feature: 'showcase' });
    expect(paywallContextFromError(parsed)).toBe('showcase');
  });

  it('maps feature=hints → hints', () => {
    const parsed = parsePaywallError(402, { error: 'addon_required', feature: 'hints' });
    expect(paywallContextFromError(parsed)).toBe('hints');
  });

  it('maps feature=birthday_reminders_advanced → birthday_reminders_advanced', () => {
    const parsed = parsePaywallError(402, {
      error: 'pro_required',
      feature: 'birthday_reminders_advanced',
      context: 'audience',
    });
    expect(paywallContextFromError(parsed)).toBe('birthday_reminders_advanced');
  });

  it('maps feature=wishlist_limit → wishlist_limit', () => {
    const parsed = parsePaywallError(402, {
      error: 'plan_limit_reached',
      feature: 'wishlist_limit',
      limit: 2,
      current: 2,
    });
    expect(paywallContextFromError(parsed)).toBe('wishlist_limit');
  });

  it('aliases reservation_history → reservation_pro (Reservation PRO cluster)', () => {
    const parsed = parsePaywallError(402, { error: 'pro_required', feature: 'reservation_history' });
    expect(paywallContextFromError(parsed)).toBe('reservation_pro');
  });

  it('aliases reservation_reminders → reservation_pro', () => {
    const parsed = parsePaywallError(402, { error: 'pro_required', feature: 'reservation_reminders' });
    expect(paywallContextFromError(parsed)).toBe('reservation_pro');
  });

  it('returns null for 403 (denied — no upsell, even if feature is mapped)', () => {
    const parsed = parsePaywallError(403, { error: 'pro_required', feature: 'showcase' });
    expect(paywallContextFromError(parsed)).toBeNull();
  });

  it('returns null for 409 conflict (state conflict — owner needs to upgrade)', () => {
    const parsed = parsePaywallError(409, {
      error: 'plan_limit_reached',
      feature: 'participant_limit',
      limit: 10,
      current: 10,
    });
    expect(paywallContextFromError(parsed)).toBeNull();
  });

  it('returns null for unknown feature on 402', () => {
    const parsed = parsePaywallError(402, { error: 'pro_required', feature: 'never_seen_this' });
    expect(paywallContextFromError(parsed)).toBeNull();
  });

  it('returns null when feature absent and no inference rule fires', () => {
    const parsed = parsePaywallError(402, { error: 'pro_required' });
    expect(paywallContextFromError(parsed)).toBeNull();
  });

  it('maps reservation_reminder (singular, backend emission) → reservation_pro', () => {
    const parsed = parsePaywallError(402, { error: 'pro_required', feature: 'reservation_reminder' });
    expect(paywallContextFromError(parsed)).toBe('reservation_pro');
  });

  it('maps wishlist_visibility / subs / comments → pro_main (post-403→402 migration)', () => {
    expect(paywallContextFromError(parsePaywallError(402, { error: 'pro_required', feature: 'wishlist_visibility' }))).toBe('pro_main');
    expect(paywallContextFromError(parsePaywallError(402, { error: 'pro_required', feature: 'wishlist_subscription_policy' }))).toBe('pro_main');
    expect(paywallContextFromError(parsePaywallError(402, { error: 'pro_required', feature: 'wishlist_comment_policy' }))).toBe('pro_main');
  });

  it('maps wishlist_readonly → wishlist_limit (over-limit wishlist gates)', () => {
    const parsed = parsePaywallError(402, { error: 'pro_required', feature: 'wishlist_readonly' });
    expect(paywallContextFromError(parsed)).toBe('wishlist_limit');
  });

  it('maps add-on features with dedicated screens to a fallback context', () => {
    // These features have dedicated paywall SCREENS, not upsell-sheet
    // contexts. The mapping is a safety net for any future caller that
    // misses the screen-flow path — paywallContextFromError must not
    // return null and silently drop the upsell.
    expect(paywallContextFromError(parsePaywallError(402, { error: 'addon_required', feature: 'gift_notes' }))).toBe('pro_main');
    expect(paywallContextFromError(parsePaywallError(402, { error: 'addon_required', feature: 'group_gift' }))).toBe('pro_main');
    expect(paywallContextFromError(parsePaywallError(402, { error: 'addon_required', feature: 'secret_reservations' }))).toBe('reservation_pro');
    expect(paywallContextFromError(parsePaywallError(402, { error: 'plan_limit_reached', feature: 'drafts_limit', limit: 50 }))).toBe('pro_main');
  });
});
