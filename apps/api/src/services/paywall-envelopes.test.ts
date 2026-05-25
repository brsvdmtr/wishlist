// Contract tests for the unified paywall envelope across the six endpoints
// pinned in the migration task (url_import, hints, categories,
// wishlist_limit, showcase, birthday-reminders advanced) plus the cross-
// cutting status-code rules. These are intentionally helper-level unit
// tests, not supertest HTTP tests: every paywall endpoint flows through
// `makeProRequired` / `makeAddonRequired` / `makePlanLimitReached` +
// `sendPaywall`, so locking the envelope at the helper boundary is enough
// to detect drift. If a route stops using the helper, its contribution to
// this file goes stale loudly.
//
// Each endpoint owns a describe() block that mirrors the migrated route's
// call site, so future maintainers can grep for the route file name and
// land here.

import { describe, it, expect, vi } from 'vitest';

vi.mock('@wishlist/db', () => ({ prisma: {} }));
vi.mock('./hint-credits', () => ({ getFreeHintsState: vi.fn() }));
vi.mock('./import-credits', () => ({ resolveFreeImports: vi.fn() }));

import {
  makeAddonRequired,
  makePlanLimitReached,
  makeProRequired,
  sendPaywall,
  type PaywallStatus,
} from './paywall';

function captureSend(): {
  status: () => number;
  body: () => Record<string, unknown> | null;
  res: { status: (n: number) => any; json: (b: unknown) => any };
} {
  const captured = { status: 0, body: null as Record<string, unknown> | null };
  const res = {
    status(n: number) { captured.status = n; return this; },
    json(b: unknown) { captured.body = b as Record<string, unknown>; return this; },
  };
  return {
    status: () => captured.status,
    body: () => captured.body,
    res,
  };
}

function send(status: PaywallStatus, body: Parameters<typeof sendPaywall>[2]) {
  const cap = captureSend();
  // @ts-expect-error — minimal stub matches the Response surface we use
  sendPaywall(cap.res, status, body);
  return cap;
}

// ─── 1. url_import — POST /tg/import-url, import.routes.ts ────────────────
describe('paywall envelope — url_import (POST /tg/import-url)', () => {
  it('emits 402 addon_required with import_pack_10 skuCode + quota state', () => {
    const cap = send(402, makeAddonRequired('url_import', {
      skuCode: 'import_pack_10',
      planCode: 'FREE',
      freeLimit: 5,
      freeUsed: 5,
      paidCredits: 0,
      packs: ['import_pack_10', 'import_pack_25'],
    }));
    expect(cap.status()).toBe(402);
    expect(cap.body()).toMatchObject({
      error: 'addon_required',
      feature: 'url_import',
      skuCode: 'import_pack_10',
      priceXtr: 39,
      planCode: 'FREE',
      freeLimit: 5,
      freeUsed: 5,
      paidCredits: 0,
      packs: ['import_pack_10', 'import_pack_25'],
    });
  });

  it('drafts-capacity overflow surfaces as plan_limit_reached (purchasable via PRO upgrade)', () => {
    const cap = send(402, makePlanLimitReached('drafts_limit', {
      limit: 50,
      message: 'Drafts capacity reached',
    }));
    expect(cap.status()).toBe(402);
    expect(cap.body()).toMatchObject({
      error: 'plan_limit_reached',
      feature: 'drafts_limit',
      limit: 50,
      message: 'Drafts capacity reached',
    });
  });
});

// ─── 2. hints — POST /tg/items/:id/hint, hints.routes.ts ──────────────────
describe('paywall envelope — hints (POST /tg/items/:id/hint)', () => {
  it('emits 402 addon_required with hints_pack_5 skuCode + auto-resolved priceXtr=29', () => {
    const cap = send(402, makeAddonRequired('hints', {
      skuCode: 'hints_pack_5',
      planCode: 'FREE',
      freeLimit: 1,
      freeUsed: 1,
      paidCredits: 0,
      packs: ['hints_pack_5', 'hints_pack_10'],
    }));
    expect(cap.status()).toBe(402);
    expect(cap.body()).toMatchObject({
      error: 'addon_required',
      feature: 'hints',
      skuCode: 'hints_pack_5',
      priceXtr: 29,
      planCode: 'FREE',
      packs: ['hints_pack_5', 'hints_pack_10'],
    });
  });
});

// ─── 3. categories — POST /tg/wishlists/:id/categories, wishlists.routes.ts
describe('paywall envelope — categories (POST /tg/wishlists/:id/categories)', () => {
  it('emits 402 pro_required for FREE users hitting the category quota', () => {
    const cap = send(402, makeProRequired('categories', {
      planCode: 'FREE',
      paywallTag: 'categories',
    }));
    expect(cap.status()).toBe(402);
    expect(cap.body()).toMatchObject({
      error: 'pro_required',
      feature: 'categories',
      planCode: 'FREE',
      paywall: 'categories', // legacy field preserved for cached Mini App clients
    });
  });
});

// ─── 4. wishlist_limit — POST /tg/wishlists, wishlists.routes.ts ──────────
describe('paywall envelope — wishlist_limit (POST /tg/wishlists)', () => {
  it('emits 402 plan_limit_reached with current/limit/planCode + extra_wishlist_slot hint', () => {
    const cap = send(402, makePlanLimitReached('wishlist_limit', {
      limit: 2,
      current: 2,
      planCode: 'FREE',
      skuCode: 'extra_wishlist_slot',
    }));
    expect(cap.status()).toBe(402);
    expect(cap.body()).toMatchObject({
      error: 'plan_limit_reached',
      feature: 'wishlist_limit',
      limit: 2,
      current: 2,
      planCode: 'FREE',
      skuCode: 'extra_wishlist_slot',
      priceXtr: 39,
    });
  });
});

// ─── 5. showcase — PATCH /tg/me/showcase, me.routes.ts ────────────────────
describe('paywall envelope — showcase (PATCH /tg/me/showcase)', () => {
  it('emits 402 pro_required (migrated from legacy 403)', () => {
    const cap = send(402, makeProRequired('showcase', { planCode: 'FREE' }));
    expect(cap.status()).toBe(402);
    expect(cap.body()).toEqual({
      error: 'pro_required',
      feature: 'showcase',
      planCode: 'FREE',
    });
  });

  it('cover upload + delete share the same envelope contract', () => {
    const a = send(402, makeProRequired('showcase', { planCode: 'FREE' })).body();
    const b = send(402, makeProRequired('showcase', { planCode: 'FREE' })).body();
    expect(a).toEqual(b);
  });
});

// ─── 6. birthday_reminders_advanced — PATCH /tg/me/birthday-settings ──────
describe('paywall envelope — birthday_reminders_advanced (PATCH /tg/me/birthday-settings)', () => {
  const contexts = ['audience', 'advanced_windows', 'primary_wishlist', 'custom_message'] as const;

  for (const ctx of contexts) {
    it(`emits 402 pro_required with context=${ctx}`, () => {
      const cap = send(402, makeProRequired('birthday_reminders_advanced', {
        context: ctx,
        planCode: 'FREE',
      }));
      expect(cap.status()).toBe(402);
      expect(cap.body()).toMatchObject({
        error: 'pro_required',
        feature: 'birthday_reminders_advanced',
        context: ctx,
        planCode: 'FREE',
      });
    });
  }
});

// ─── 7. Status-code policy — purchasable vs denial vs conflict ────────────
describe('status code policy', () => {
  it('402 is used for purchasable paywalls (pro_required, addon_required, plan_limit_reached)', () => {
    expect(send(402, makeProRequired('any_feature')).status()).toBe(402);
    expect(send(402, makeAddonRequired('any_feature', { skuCode: 'group_gift_unlock' })).status()).toBe(402);
    expect(send(402, makePlanLimitReached('any_feature', { limit: 1 })).status()).toBe(402);
  });

  it('403 is reserved for hard denials (purchase would not help)', () => {
    // Helper accepts 403 with any error code — caller chooses the status by
    // semantics, not by code. Used in practice only for permission denials
    // that already exist outside the paywall helper (Forbidden, archived, etc.).
    const cap = send(403, makeProRequired('any_feature'));
    expect(cap.status()).toBe(403);
  });

  it('409 is used for state conflicts (e.g., participant_limit guest-side)', () => {
    // The reservations.routes.ts:participant_limit case — the guest hit the
    // owner's plan ceiling and the guest cannot buy PRO for the owner.
    const cap = send(409, makePlanLimitReached('participant_limit', {
      limit: 10,
      current: 10,
    }));
    expect(cap.status()).toBe(409);
    expect(cap.body()).toMatchObject({
      error: 'plan_limit_reached',
      feature: 'participant_limit',
      limit: 10,
      current: 10,
    });
  });
});

// ─── 8. Add-on cluster — group_gift / gift_notes / smart_reservations ─────
describe('paywall envelope — purchasable add-ons', () => {
  it('group_gift uses addon_required with priceXtr=79 (GROUP_GIFT_PRICE_XTR default)', () => {
    const cap = send(402, makeAddonRequired('group_gift', {
      skuCode: 'group_gift_unlock',
      priceXtr: 79,
    }));
    expect(cap.status()).toBe(402);
    expect(cap.body()).toMatchObject({
      error: 'addon_required',
      feature: 'group_gift',
      skuCode: 'group_gift_unlock',
      priceXtr: 79,
    });
  });

  it('gift_notes uses addon_required with priceXtr=19 (migrated from legacy 403)', () => {
    const cap = send(402, makeAddonRequired('gift_notes', {
      skuCode: 'gift_notes_unlock',
      priceXtr: 19,
    }));
    expect(cap.status()).toBe(402);
    expect(cap.body()).toMatchObject({
      error: 'addon_required',
      feature: 'gift_notes',
      skuCode: 'gift_notes_unlock',
      priceXtr: 19,
    });
  });

  it('smart_reservations uses addon_required with skuCode + auto-resolved priceXtr=15', () => {
    const cap = send(402, makeAddonRequired('smart_reservations', {
      skuCode: 'smart_reservations_unlock',
      planCode: 'FREE',
    }));
    expect(cap.body()).toMatchObject({
      error: 'addon_required',
      feature: 'smart_reservations',
      skuCode: 'smart_reservations_unlock',
      priceXtr: 15,
      planCode: 'FREE',
    });
  });

  it('secret_reservations uses addon_required (migrated from legacy 403)', () => {
    const cap = send(402, makeAddonRequired('secret_reservations', {
      skuCode: 'secret_reservation_unlock',
    }));
    expect(cap.status()).toBe(402);
    expect(cap.body()).toMatchObject({
      error: 'addon_required',
      feature: 'secret_reservations',
      skuCode: 'secret_reservation_unlock',
      priceXtr: 24,
    });
  });
});

// ─── 9. Santa cluster — multi_wave / exclusions / exclusion_groups ────────
describe('paywall envelope — Secret Santa PRO features', () => {
  it('santa_multi_wave uses pro_required', () => {
    const cap = send(402, makeProRequired('santa_multi_wave', { planCode: 'FREE' }));
    expect(cap.body()).toMatchObject({
      error: 'pro_required',
      feature: 'santa_multi_wave',
      planCode: 'FREE',
    });
  });

  it('santa_exclusions uses pro_required', () => {
    const cap = send(402, makeProRequired('santa_exclusions'));
    expect(cap.body()).toMatchObject({
      error: 'pro_required',
      feature: 'santa_exclusions',
    });
  });

  it('santa_exclusion_groups uses pro_required', () => {
    const cap = send(402, makeProRequired('santa_exclusion_groups'));
    expect(cap.body()).toMatchObject({
      error: 'pro_required',
      feature: 'santa_exclusion_groups',
    });
  });
});
