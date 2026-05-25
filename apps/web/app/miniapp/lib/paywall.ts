// Mini App parser for paywall error envelopes (402/403/409).
//
// Reads the unified envelope from services/paywall.ts on the backend, plus
// the six legacy variants left behind by routes that haven't migrated yet.
// Both new and legacy shapes resolve to the same ParsedPaywall, so callers
// in MiniApp.tsx can show ProUpsellSheet via a single code path.
//
// Status-code semantics (must match backend):
//   402 → user can buy/upgrade  → safe to auto-show ProUpsellSheet
//   403 → access denied         → toast, no upsell
//   409 → state conflict        → toast, owner needs to upgrade (not the requester)

export type PaywallErrorCode =
  | 'pro_required'
  | 'addon_required'
  | 'plan_limit_reached';

export type PlanCode = 'FREE' | 'PRO';

export type PaywallStatus = 402 | 403 | 409;

export interface ParsedPaywall {
  status: PaywallStatus;
  /** Normalized error code; `null` when the legacy `error` string is unrecognised. */
  error: PaywallErrorCode | null;
  /** Gated feature key (`url_import`, `categories`, `showcase`, …). */
  feature: string | null;
  /** Sub-context, e.g., `audience` / `advanced_windows` for birthday-reminders. */
  context?: string;
  planCode?: PlanCode;
  limit?: number;
  current?: number;
  priceXtr?: number;
  skuCode?: string;
  freeLimit?: number;
  freeUsed?: number;
  paidCredits?: number;
  packs?: string[];
  paywall?: string;
  message?: string;
}

const NEW_ERROR_CODES = new Set<PaywallErrorCode>([
  'pro_required',
  'addon_required',
  'plan_limit_reached',
]);

/**
 * Map a legacy `error` string (pre-unification) to one of the three new
 * error codes. Returns `null` when the value doesn't look like a paywall
 * error at all (e.g., a one-off code from a non-paywall response that
 * happened to come back on 402/403/409).
 */
function normalizeLegacyError(raw: string): PaywallErrorCode | null {
  if (NEW_ERROR_CODES.has(raw as PaywallErrorCode)) return raw as PaywallErrorCode;
  switch (raw) {
    case 'import_quota_exhausted':
    case 'hint_quota_exhausted':
    case 'group_gift_required':
    case 'gift_notes_required':
    case 'smart_reservations_required':
    case 'secret_reservations_required':
      return 'addon_required';
    case 'Plan limit reached':
    case 'Subscription limit reached':
    case 'Participant limit reached':
    case 'Drafts limit reached':
      return 'plan_limit_reached';
    case 'Pro required':
    case 'Pro feature':
      return 'pro_required';
    default:
      return null;
  }
}

/** Infer feature from legacy error code when the body didn't carry `feature`. */
function inferLegacyFeature(rawError: string | null, body: Record<string, unknown>): string | null {
  if (rawError === 'import_quota_exhausted') return 'url_import';
  if (rawError === 'hint_quota_exhausted') return 'hints';
  if (rawError === 'group_gift_required') return 'group_gift';
  if (rawError === 'gift_notes_required') return 'gift_notes';
  if (rawError === 'smart_reservations_required') return 'smart_reservations';
  if (rawError === 'secret_reservations_required') return 'secret_reservations';
  if (typeof body.paywall === 'string') return body.paywall;
  return null;
}

/** Try to read a paywall envelope from a 4xx response body. */
export function parsePaywallError(status: number, body: unknown): ParsedPaywall | null {
  if (status !== 402 && status !== 403 && status !== 409) return null;
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;

  const rawError = typeof b.error === 'string' ? b.error : null;
  const normalized = rawError ? normalizeLegacyError(rawError) : null;

  const feature =
    typeof b.feature === 'string' && b.feature.length > 0
      ? b.feature
      : inferLegacyFeature(rawError, b);

  const parsed: ParsedPaywall = {
    status: status as PaywallStatus,
    error: normalized,
    feature,
  };

  if (typeof b.context === 'string') parsed.context = b.context;
  if (b.planCode === 'FREE' || b.planCode === 'PRO') parsed.planCode = b.planCode;
  if (typeof b.limit === 'number') parsed.limit = b.limit;
  if (typeof b.current === 'number') parsed.current = b.current;
  if (typeof b.priceXtr === 'number') parsed.priceXtr = b.priceXtr;
  if (typeof b.skuCode === 'string') parsed.skuCode = b.skuCode;
  if (typeof b.freeLimit === 'number') parsed.freeLimit = b.freeLimit;
  if (typeof b.freeUsed === 'number') parsed.freeUsed = b.freeUsed;
  if (typeof b.paidCredits === 'number') parsed.paidCredits = b.paidCredits;
  if (Array.isArray(b.packs) && b.packs.every((p) => typeof p === 'string')) {
    parsed.packs = b.packs as string[];
  }
  if (typeof b.paywall === 'string') parsed.paywall = b.paywall;
  if (typeof b.message === 'string') parsed.message = b.message;
  return parsed;
}

/**
 * UpsellContext mirror — must stay in sync with MiniApp.tsx `UpsellContext`.
 * Kept here so the lib can be tested without importing MiniApp.tsx.
 */
export type UpsellContext =
  | 'comments'
  | 'url_import'
  | 'hints'
  | 'wishlist_limit'
  | 'item_limit'
  | 'participant_limit'
  | 'subscription_limit'
  | 'sort_recommended'
  | 'reservation_pro'
  | 'categories'
  | 'dont_gift'
  | 'dont_gift_banner'
  | 'curated_selection'
  | 'smart_reservations'
  | 'showcase'
  | 'appearance'
  | 'birthday_reminders_advanced'
  | 'pro_main'
  | 'search'
  | 'santa_multi_wave'
  | 'santa_exclusions'
  | 'santa_exclusion_groups';

const FEATURE_TO_CONTEXT: Record<string, UpsellContext> = {
  url_import: 'url_import',
  hints: 'hints',
  comments: 'comments',
  categories: 'categories',
  showcase: 'showcase',
  appearance: 'appearance',
  smart_reservations: 'smart_reservations',
  birthday_reminders_advanced: 'birthday_reminders_advanced',
  wishlist_limit: 'wishlist_limit',
  item_limit: 'item_limit',
  participant_limit: 'participant_limit',
  subscription_limit: 'subscription_limit',
  sort_recommended: 'sort_recommended',
  reservation_pro: 'reservation_pro',
  reservation_history: 'reservation_pro',
  reservation_meta: 'reservation_pro',
  // Backend emits both `reservation_reminder` (singular, from
  // reservations.routes.ts:requireReservationPro feature union) and the
  // legacy plural — alias both to the same upsell context.
  reservation_reminder: 'reservation_pro',
  reservation_reminders: 'reservation_pro',
  reservation_notes: 'reservation_pro',
  reservation_purchase_status: 'reservation_pro',
  reservation_filters: 'reservation_pro',
  dont_gift: 'dont_gift',
  dont_gift_banner: 'dont_gift_banner',
  curated_selection: 'curated_selection',
  santa_multi_wave: 'santa_multi_wave',
  santa_exclusions: 'santa_exclusions',
  santa_exclusion_groups: 'santa_exclusion_groups',
  search: 'search',
  // Wishlist PATCH gates (post-2026-05 status-code migration 403→402):
  // wishlist privacy / subs / comments / read-only all upsell to the
  // wishlist-scoped Pro Main sheet. There's no dedicated UpsellContext for
  // each granular setting; they all rationally land on `pro_main` which
  // shows the comparison table and benefits.
  wishlist_visibility: 'pro_main',
  wishlist_subscription_policy: 'pro_main',
  wishlist_comment_policy: 'pro_main',
  wishlist_readonly: 'wishlist_limit',
  // Safety net for add-on / quota features whose primary FE flow uses a
  // dedicated paywall SCREEN, not the upsell sheet (gift_notes,
  // group_gift, secret_reservations have screens; drafts_limit doesn't).
  // The dedicated-screen call sites have explicit `feature === 'foo'`
  // checks that fire BEFORE paywallContextFromError, so these mappings
  // never override the screen flow — they only catch any future caller
  // that hits the same backend feature without the screen handling.
  gift_notes: 'pro_main',
  group_gift: 'pro_main',
  secret_reservations: 'reservation_pro',
  drafts_limit: 'pro_main',
};

/**
 * Map a parsed paywall envelope to a Mini App UpsellContext, suitable
 * for `showUpsell(context, { auto: true })`.
 *
 * Returns `null` when:
 *   - status is 403 (denied — no upsell), or
 *   - status is 409 (state conflict — owner upsells, not requester), or
 *   - the feature isn't mapped to a known UpsellContext.
 *
 * Callers should fall back to a toast for these cases.
 */
export function paywallContextFromError(parsed: ParsedPaywall | null): UpsellContext | null {
  if (!parsed) return null;
  if (parsed.status !== 402) return null;
  if (!parsed.feature) return null;
  return FEATURE_TO_CONTEXT[parsed.feature] ?? null;
}
