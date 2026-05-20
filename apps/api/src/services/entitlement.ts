// Entitlement, plans, and add-on SKU service (P5s-1) — extracted from
// apps/api/src/index.ts. Single source of truth for plan limits,
// pricing, SKU catalogue, add-on caps, and the entitlement resolvers
// (getUserEntitlement / getEffectiveEntitlements) plus the small
// reservation/smart-res predicate helpers.
//
// All identifier bodies are byte-identical to their pre-extraction
// definitions in index.ts; only their location changed. Index.ts
// imports them from here and continues passing them through router /
// scheduler factory deps (Strategy A — no router/scheduler contract
// change in this PR).
//
// `requireGiftNotes` STAYS in index.ts because it calls `trackEvent`
// (which is also still in index.ts). Once trackEvent moves into a
// services/analytics.ts module (P5s-5), requireGiftNotes can move
// with it.
//
// Consumers (read-only here; no consumer files change in this PR):
//   - 15 routes/* files (billing, me, reservations, wishlists, items,
//     gift-notes, group-gifts, comments, hints, import, internal,
//     promo, public, referral, santa) — all receive entitlement
//     identifiers via factory deps.
//   - 5 schedulers/* files (billing, birthday-reminders, lifecycle,
//     pro-renewal, reservations) — same pattern.
//
// Pricing values, plan limits, env-default fallbacks, ONE_TIME_SKUS
// entries, ADDON_CAPS, getSmartResLeadHours thresholds, response
// shapes — all preserved byte-identical.

import { prisma } from '@wishlist/db';
import {
  LIFETIME_BILLING_PERIOD,
  PRO_LIFETIME_PERIOD_END_ISO,
  isLifetimeSubscription,
} from '@wishlist/shared';

import { resolveFreeImports } from './import-credits';

// ─── Plan & Entitlement System ──────────────────────────────────────────────
export const PLANS = {
  FREE: {
    code: 'FREE' as const,
    wishlists: 2,
    items: 20,       // reduced from 30; add-ons fill the gap; MAX tier will have 200+
    participants: 5,
    subscriptions: 2,
    features: [] as string[],
  },
  PRO: {
    code: 'PRO' as const,
    wishlists: 10,
    items: 70,       // reduced from 100; MAX tier will be 200+
    participants: 20,
    subscriptions: 5, // reduced from 7; 5 covers active users well; MAX will offer 15+
    features: ['comments', 'url_import', 'hints'],
  },
} as const;

export type PlanCode = keyof typeof PLANS;
export type PlanInfo = (typeof PLANS)[PlanCode];

export const PRO_PRICE_XTR = parseInt(process.env.PRO_PRICE_XTR ?? '100', 10);
export const PRO_YEARLY_PRICE_XTR = parseInt(process.env.PRO_YEARLY_PRICE_XTR ?? '800', 10);
export const PRO_LIFETIME_PRICE_XTR = parseInt(process.env.PRO_LIFETIME_PRICE_XTR ?? '2490', 10);
export const PRO_SUBSCRIPTION_PERIOD = parseInt(process.env.PRO_SUBSCRIPTION_PERIOD ?? '2592000', 10);
// Yearly one-time purchase extends entitlement by this many seconds.
// Telegram Stars doesn't support subscription_period > 30 days, so yearly is a
// non-recurring invoice; the bot extends currentPeriodEnd manually on success.
export const PRO_YEARLY_EXTEND_SECONDS = parseInt(process.env.PRO_YEARLY_EXTEND_SECONDS ?? '31536000', 10);
// Lifetime one-time purchase: a permanent entitlement. We still write a
// Subscription row (currentPeriodEnd is required), so we anchor it to a
// far-future sentinel. The semantic discriminator is `billingPeriod='lifetime'`
// — never rely on the date alone. Resolvers, schedulers, and UI must check
// `billingPeriod` first, the date is just a defensive padding so the
// expiry-sweep cron can't race a clock skew into rolling lifetime to EXPIRED.
//
// LIFETIME_BILLING_PERIOD, PRO_LIFETIME_PERIOD_END_ISO, and isLifetimeSubscription
// live in @wishlist/shared so apps/bot can import the same source of truth
// (avoids the previous duplicated string literal in apps/bot/src/index.ts).
// PRO_LIFETIME_PERIOD_END is the API-side Date instance built from the shared ISO.
export const PRO_LIFETIME_PERIOD_END = new Date(PRO_LIFETIME_PERIOD_END_ISO);
export const PRO_PLAN_CODE = process.env.PRO_PLAN_CODE ?? 'PRO';

// Re-export for back-compat: API consumers that already imported these from
// './services/entitlement' continue to work without churn.
export { LIFETIME_BILLING_PERIOD, PRO_LIFETIME_PERIOD_END_ISO, isLifetimeSubscription };

// ─── Reservation Pro — feature gate ─────────────────────────────────────────

/** User sees the new reservation UI — v2: open to all users */
export function isReservationBeta(user: { telegramId?: string | null; godMode: boolean }): boolean {
  return true; // v2: feature is open to all users
}

/** User has actual Pro reservation features (Pro subscription OR one-time addon) */
export function hasReservationPro(user: { telegramId?: string | null; godMode: boolean }, isPro: boolean, addOns?: Array<{ addonType: string }>): boolean {
  if (user.godMode) return true;
  if (isPro) return true;
  if (addOns?.some(a => a.addonType === 'reservation_pro_unlock')) return true;
  return false;
}

/** Smart Reservations: lead-time hours for reminder/expiringSoon by TTL */
export function getSmartResLeadHours(ttlH: number): number {
  if (ttlH >= 168) return 48;
  if (ttlH >= 72) return 24;
  if (ttlH >= 48) return 12;
  return 6;
}

/** Smart Reservations: owner-side entitlement check (PRO or per-wishlist add-on) */
export function hasSmartReservations(
  ownerUser: { godMode: boolean },
  ownerIsPro: boolean,
  ownerAddOns: Array<{ addonType: string; targetId?: string | null }>,
  wishlistId: string,
): boolean {
  if (ownerUser.godMode || ownerIsPro) return true;
  return ownerAddOns.some(a => a.addonType === 'smart_reservations_unlock' && a.targetId === wishlistId);
}

// ─── Gift Notes (Поводы и идеи) — one-time unlock ────────────────────────────
export const GIFT_NOTES_PRICE_XTR = parseInt(process.env.GIFT_NOTES_PRICE_XTR ?? '19', 10);
export const GIFT_NOTES_SKU = 'gift_notes_unlock';
export const GROUP_GIFT_PRICE_XTR = parseInt(process.env.GROUP_GIFT_PRICE_XTR ?? '79', 10);
export const GROUP_GIFT_SKU = 'group_gift_unlock';
export const SECRET_RESERVATION_PRICE_XTR = parseInt(process.env.SECRET_RESERVATION_PRICE_XTR ?? '24', 10);
export const SECRET_RESERVATION_SKU = 'secret_reservation_unlock';

// ─── One-time SKU catalogue ──────────────────────────────────────────────────
export const ONE_TIME_SKUS = {
  extra_wishlist_slot:     { code: 'extra_wishlist_slot',     price: 39, type: 'permanent' as const,  addonType: 'wishlist_slot'       as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0,  targetRequired: false },
  extra_subscription_slot: { code: 'extra_subscription_slot', price: 25, type: 'permanent' as const,  addonType: 'subscription_slot'   as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0,  targetRequired: false },
  extra_items_5:           { code: 'extra_items_5',           price: 19, type: 'permanent' as const,  addonType: 'item_slot_5'         as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0,  targetRequired: true  },
  extra_items_15:          { code: 'extra_items_15',          price: 39, type: 'permanent' as const,  addonType: 'item_slot_15'        as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0,  targetRequired: true  },
  hints_pack_5:            { code: 'hints_pack_5',            price: 29, type: 'consumable' as const, addonType: null as string | null,                  creditKey: 'hint'   as 'hint' | 'import' | null, creditAmount: 5,  targetRequired: false },
  hints_pack_10:           { code: 'hints_pack_10',           price: 49, type: 'consumable' as const, addonType: null as string | null,                  creditKey: 'hint'   as 'hint' | 'import' | null, creditAmount: 10, targetRequired: false },
  import_pack_10:          { code: 'import_pack_10',          price: 39, type: 'consumable' as const, addonType: null as string | null,                  creditKey: 'import' as 'hint' | 'import' | null, creditAmount: 10, targetRequired: false },
  import_pack_25:          { code: 'import_pack_25',          price: 79, type: 'consumable' as const, addonType: null as string | null,                  creditKey: 'import' as 'hint' | 'import' | null, creditAmount: 25, targetRequired: false },
  seasonal_decoration:     { code: 'seasonal_decoration',     price: 29, type: 'cosmetic' as const,   addonType: 'seasonal_decoration' as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0,  targetRequired: true  },
  gift_notes_unlock:       { code: 'gift_notes_unlock',       price: GIFT_NOTES_PRICE_XTR, type: 'permanent' as const, addonType: 'gift_notes_unlock' as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0, targetRequired: false },
  reservation_pro_unlock:  { code: 'reservation_pro_unlock',  price: 50, type: 'permanent' as const, addonType: 'reservation_pro_unlock' as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0, targetRequired: false },
  group_gift_unlock:       { code: 'group_gift_unlock',       price: GROUP_GIFT_PRICE_XTR, type: 'permanent' as const, addonType: 'group_gift_unlock' as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0, targetRequired: false },
  smart_reservations_unlock: { code: 'smart_reservations_unlock', price: 15, type: 'permanent' as const, addonType: 'smart_reservations_unlock' as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0, targetRequired: true },
  secret_reservation_unlock: { code: 'secret_reservation_unlock', price: SECRET_RESERVATION_PRICE_XTR, type: 'permanent' as const, addonType: 'secret_reservation_unlock' as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0, targetRequired: false },
} as const;

// ─── Add-on caps — prevent add-ons from substituting PRO ────────────────────
export const ADDON_CAPS = {
  extraWishlistSlots:        { FREE: 3, PRO: 5 }, // FREE total≤5; PRO total≤15
  extraSubscriptionSlots:    3,                   // any plan: +3 max (FREE→5, PRO→8)
  extraItems5PerWishlist:    3,                   // +5×3 = +15 items per wishlist
  extraItems15PerWishlist:   1,                   // +15×1 = +15 items per wishlist
} as const;

export type PromoProInfo = { id: string; expiresAt: string | null; campaignCode: string } | null;

export async function getUserEntitlement(userId: string, godMode = false): Promise<{
  plan: PlanInfo;
  isPro: boolean;
  proSource: 'subscription' | 'promo' | 'god_mode' | null;
  subscription: { id: string; status: string; periodEnd: string; cancelledAt: string | null; cancelAtPeriodEnd: boolean; billingPeriod: string | null } | null;
  promoPro: PromoProInfo;
}> {
  // 1. Check paid subscription first (highest priority)
  const sub = await prisma.subscription.findFirst({
    where: {
      userId,
      planCode: PRO_PLAN_CODE,
      status: { in: ['ACTIVE', 'CANCELLED'] },
      currentPeriodEnd: { gt: new Date() },
    },
    orderBy: { currentPeriodEnd: 'desc' },
  });

  // Also check active promo-PRO (expiresAt === null means lifetime PRO)
  const promoRedemption = await prisma.promoRedemption.findFirst({
    where: {
      userId,
      status: 'ACTIVE',
      OR: [{ expiresAt: { gt: new Date() } }, { expiresAt: null }],
    },
    include: { campaign: { select: { code: true } } },
  });
  const promoPro: PromoProInfo = promoRedemption
    ? { id: promoRedemption.id, expiresAt: promoRedemption.expiresAt?.toISOString() ?? null, campaignCode: promoRedemption.campaign.code }
    : null;

  if (sub) {
    return {
      plan: PLANS.PRO,
      isPro: true,
      proSource: 'subscription',
      subscription: {
        id: sub.id,
        status: sub.status,
        periodEnd: sub.currentPeriodEnd.toISOString(),
        cancelledAt: sub.cancelledAt?.toISOString() ?? null,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        billingPeriod: sub.billingPeriod ?? null,
      },
      promoPro,
    };
  }

  // 2. Check active promo-PRO
  if (promoPro) {
    return {
      plan: PLANS.PRO,
      isPro: true,
      proSource: 'promo',
      subscription: null,
      promoPro,
    };
  }

  // 3. God Mode: virtual PRO without real subscription
  if (godMode) {
    return { plan: PLANS.PRO, isPro: true, proSource: 'god_mode', subscription: null, promoPro: null };
  }

  return { plan: PLANS.FREE, isPro: false, proSource: null, subscription: null, promoPro: null };
}

/** Unified effective entitlement resolver — single source of truth for all limit checks.
 *  When godMode is omitted, auto-resolves from DB so callers can't forget it. */
export async function getEffectiveEntitlements(userId: string, godMode?: boolean) {
  const resolvedGodMode = godMode ?? (await prisma.user.findUnique({ where: { id: userId }, select: { godMode: true } }))?.godMode ?? false;
  const [base, addOns, credits] = await Promise.all([
    getUserEntitlement(userId, resolvedGodMode),
    prisma.userAddOn.findMany({ where: { userId } }),
    prisma.userCredits.findUnique({ where: { userId } }),
  ]);

  const extraWishlistSlots = addOns
    .filter(a => a.addonType === 'wishlist_slot')
    .reduce((s, a) => s + a.quantity, 0);

  const extraSubscriptionSlots = addOns
    .filter(a => a.addonType === 'subscription_slot')
    .reduce((s, a) => s + a.quantity, 0);

  // Per-wishlist extra items: wishlistId → additional item count
  const extraItemsPerWishlist: Record<string, number> = {};
  for (const a of addOns.filter(a => a.addonType === 'item_slot_5' || a.addonType === 'item_slot_15')) {
    if (a.targetId) {
      extraItemsPerWishlist[a.targetId] = (extraItemsPerWishlist[a.targetId] ?? 0) + a.quantity;
    }
  }

  // Seasonal decoration wishlist IDs
  const seasonalWishlists = new Set<string>(
    addOns.filter(a => a.addonType === 'seasonal_decoration' && a.targetId).map(a => a.targetId!)
  );

  // FREE-tier monthly URL-import allowance (period-aware; lazy reset).
  const freeImports = resolveFreeImports(credits);

  return {
    ...base,
    effectiveWishlistLimit: base.plan.wishlists + extraWishlistSlots,
    effectiveSubscriptionLimit: base.plan.subscriptions + extraSubscriptionSlots,
    extraItemsPerWishlist,
    seasonalWishlists,
    hintCredits: credits?.hintCredits ?? 0,
    importCredits: credits?.importCredits ?? 0,
    freeImportsUsed: freeImports.freeUsed,
    freeImportsLimit: freeImports.freeLimit,
    addOns,
    // Gift Notes access: PRO users get it, or one-time unlock via UserAddOn
    hasGiftNotes: base.isPro || godMode || addOns.some(a => a.addonType === GIFT_NOTES_SKU),
    giftNotes: {
      unlocked: base.isPro || godMode || addOns.some(a => a.addonType === GIFT_NOTES_SKU),
      unlockType: base.isPro ? 'PRO' as const : addOns.some(a => a.addonType === GIFT_NOTES_SKU) ? 'ONE_TIME' as const : godMode ? 'GOD' as const : null,
      priceXtr: GIFT_NOTES_PRICE_XTR,
    },
    // Smart Reservations: per-wishlist add-on IDs
    smartReservationsWishlists: new Set<string>(
      addOns.filter(a => a.addonType === 'smart_reservations_unlock' && a.targetId).map(a => a.targetId!)
    ),
    // Group Gift access: one-time unlock via UserAddOn (not included in PRO)
    hasGroupGift: godMode || addOns.some(a => a.addonType === GROUP_GIFT_SKU),
    groupGift: {
      unlocked: godMode || addOns.some(a => a.addonType === GROUP_GIFT_SKU),
      priceXtr: GROUP_GIFT_PRICE_XTR,
    },
    // Secret Reservations access: PRO users get it, or one-time unlock via UserAddOn
    hasSecretReservations: base.isPro || resolvedGodMode || addOns.some(a => a.addonType === SECRET_RESERVATION_SKU),
    secretReservations: {
      unlocked: base.isPro || resolvedGodMode || addOns.some(a => a.addonType === SECRET_RESERVATION_SKU),
      unlockType: base.isPro ? 'PRO' as const : addOns.some(a => a.addonType === SECRET_RESERVATION_SKU) ? 'ONE_TIME' as const : resolvedGodMode ? 'GOD' as const : null,
      priceXtr: SECRET_RESERVATION_PRICE_XTR,
    },
  };
}

/** Check if a wishlist is writable (within plan limits) for the given user */
export async function isWishlistWritable(userId: string, wishlistId: string, planLimit: number): Promise<boolean> {
  const allWishlists = await prisma.wishlist.findMany({
    where: { ownerId: userId, type: 'REGULAR', archivedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  const writableIds = new Set(allWishlists.slice(0, planLimit).map(w => w.id));
  return writableIds.has(wishlistId);
}

// ─── Canonical return-shape types ────────────────────────────────────────────
// Re-exported for routers/schedulers that want to inline these instead of
// declaring their own structural narrows. Not consumed in this PR (deps
// contracts preserved); future cleanup PRs can adopt.
export type EntitlementResult = Awaited<ReturnType<typeof getUserEntitlement>>;
export type EffectiveEntitlements = Awaited<ReturnType<typeof getEffectiveEntitlements>>;

// ─── Gift Notes feature gate (P5s-5 — moved from index.ts) ──────────────────
// Deferred from the initial P5s-1 entitlement extraction because it
// closes over `trackEvent`. After P5s-5 placed `trackEvent` in
// ./services/analytics.ts, requireGiftNotes can live alongside the rest
// of the entitlement layer. Body byte-identical to the previous in-place
// definition in apps/api/src/index.ts:275.
//
// Consumers: routes/gift-notes.routes.ts (sole consumer; receives via
// `deps` factory contract — Strategy A, signature unchanged).

import { trackEvent } from './analytics';

/** Gate helper: Gift Notes feature required */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function requireGiftNotes(ent: EffectiveEntitlements, res: any): boolean {
  if (!ent.hasGiftNotes) {
    trackEvent('feature_gate_hit_gift_notes');
    res.status(403).json({ error: 'gift_notes_required' });
    return false;
  }
  return true;
}
