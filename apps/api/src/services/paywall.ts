// Unified paywall error envelope for state-changing 402/403/409 responses.
//
// Before this module, ~30 paywall endpoints emitted six distinct JSON shapes
// (audit-2026-05-25). The Mini App parsed each one with bespoke checks,
// which made every new monetization surface a fresh source of drift.
//
// This service is the single constructor + sender for paywall errors.
// Every state-changing route that gates behind PRO, an add-on SKU, or a
// numeric plan limit MUST emit through `sendPaywall(...)` with one of
// the three builders below.
//
// Status codes encode purchase-path semantics:
//   402 — user can buy/upgrade (pro_required, addon_required, plan_limit_reached)
//   403 — access denied, purchase wouldn't help (hard denial)
//   409 — state conflict (e.g., guest hits owner's plan limit — owner must upgrade)
//
// Legacy fields (`freeLimit` / `freeUsed` / `paidCredits` / `packs` /
// `paywall` / `message`) are preserved by opt-in so cached Mini App
// clients keep working through the frontend rollout.

import type { Response } from 'express';

// Inlined SKU default prices — keeps paywall.ts free of any service-layer
// imports (entitlement.ts pulls hint-credits / import-credits transitively,
// which breaks mocked router unit tests that don't expect those modules
// loaded). Env-configurable SKUs (group_gift, gift_notes, secret_reservation)
// still take precedence when callers pass `priceXtr` explicitly — the auto-
// resolution here is a default for the common case. Keep in sync with
// ONE_TIME_SKUS in services/entitlement.ts.
const SKU_DEFAULT_PRICE: Record<string, number> = {
  extra_wishlist_slot: 39,
  extra_subscription_slot: 25,
  extra_items_5: 19,
  extra_items_15: 39,
  hints_pack_5: 29,
  hints_pack_10: 49,
  import_pack_10: 39,
  import_pack_25: 79,
  seasonal_decoration: 29,
  gift_notes_unlock: 19,
  reservation_pro_unlock: 50,
  group_gift_unlock: 79,
  smart_reservations_unlock: 15,
  secret_reservation_unlock: 24,
};

export type PaywallErrorCode =
  | 'pro_required'
  | 'addon_required'
  | 'plan_limit_reached';

export type PaywallStatus = 402 | 403 | 409;

export interface PaywallErrorBody {
  error: PaywallErrorCode;
  feature: string;
  context?: string;
  /**
   * Plan code emitted to the client. Typed wide because the entitlement
   * helpers return `plan.code` as `string` in some factory-dep narrowings
   * (e.g., internal.routes.ts deps), and the Mini App parser already
   * filters to 'FREE' | 'PRO' on the way in.
   */
  planCode?: string;
  limit?: number;
  current?: number;
  priceXtr?: number;
  skuCode?: string;
  freeLimit?: number;
  freeUsed?: number;
  paidCredits?: number;
  packs?: readonly string[];
  paywall?: string;
  message?: string;
}

type SkuCode = keyof typeof SKU_DEFAULT_PRICE;

function priceForSku(skuCode: string): number | undefined {
  return SKU_DEFAULT_PRICE[skuCode];
}

interface MakeProRequiredOpts {
  context?: string;
  planCode?: string;
  message?: string;
  paywallTag?: string;
}

export function makeProRequired(
  feature: string,
  opts: MakeProRequiredOpts = {},
): PaywallErrorBody {
  const body: PaywallErrorBody = { error: 'pro_required', feature };
  if (opts.context !== undefined) body.context = opts.context;
  if (opts.planCode !== undefined) body.planCode = opts.planCode;
  if (opts.message !== undefined) body.message = opts.message;
  if (opts.paywallTag !== undefined) body.paywall = opts.paywallTag;
  return body;
}

interface MakeAddonRequiredOpts {
  skuCode?: SkuCode | (string & {});
  priceXtr?: number;
  context?: string;
  planCode?: string;
  limit?: number;
  current?: number;
  freeLimit?: number;
  freeUsed?: number;
  paidCredits?: number;
  packs?: readonly string[];
  message?: string;
}

export function makeAddonRequired(
  feature: string,
  opts: MakeAddonRequiredOpts = {},
): PaywallErrorBody {
  const body: PaywallErrorBody = { error: 'addon_required', feature };
  if (opts.skuCode !== undefined) body.skuCode = opts.skuCode;
  if (opts.priceXtr !== undefined) {
    body.priceXtr = opts.priceXtr;
  } else if (opts.skuCode) {
    const price = priceForSku(opts.skuCode);
    if (price !== undefined) body.priceXtr = price;
  }
  if (opts.context !== undefined) body.context = opts.context;
  if (opts.planCode !== undefined) body.planCode = opts.planCode;
  if (opts.limit !== undefined) body.limit = opts.limit;
  if (opts.current !== undefined) body.current = opts.current;
  if (opts.freeLimit !== undefined) body.freeLimit = opts.freeLimit;
  if (opts.freeUsed !== undefined) body.freeUsed = opts.freeUsed;
  if (opts.paidCredits !== undefined) body.paidCredits = opts.paidCredits;
  if (opts.packs !== undefined) body.packs = opts.packs;
  if (opts.message !== undefined) body.message = opts.message;
  return body;
}

interface MakePlanLimitOpts {
  limit: number;
  current?: number;
  planCode?: string;
  context?: string;
  skuCode?: SkuCode | (string & {});
  priceXtr?: number;
  message?: string;
}

export function makePlanLimitReached(
  feature: string,
  opts: MakePlanLimitOpts,
): PaywallErrorBody {
  const body: PaywallErrorBody = {
    error: 'plan_limit_reached',
    feature,
    limit: opts.limit,
  };
  if (opts.current !== undefined) body.current = opts.current;
  if (opts.planCode !== undefined) body.planCode = opts.planCode;
  if (opts.context !== undefined) body.context = opts.context;
  if (opts.skuCode !== undefined) body.skuCode = opts.skuCode;
  if (opts.priceXtr !== undefined) {
    body.priceXtr = opts.priceXtr;
  } else if (opts.skuCode) {
    const price = priceForSku(opts.skuCode);
    if (price !== undefined) body.priceXtr = price;
  }
  if (opts.message !== undefined) body.message = opts.message;
  return body;
}

export function sendPaywall(
  res: Response,
  status: PaywallStatus,
  body: PaywallErrorBody,
): Response {
  return res.status(status).json(body);
}
