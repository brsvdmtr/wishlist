// Wishlist-domain helpers (P5s-7 — extracted from apps/api/src/index.ts).
//
// Three identifiers, all wishlist-scoped:
//
//   - DRAFTS_ITEM_LIMIT — hard cap on items inside the SYSTEM_DRAFTS
//     wishlist; consumed by `routes/import.routes.ts`,
//     `routes/internal.routes.ts`, and (via `importUrlForUser` closure)
//     `routes/items.routes.ts` URL-prefill flow.
//
//   - reassignPrimaryBeforeWishlistDelete — cascade-safety helper that
//     moves the legacy `Item.wishlistId` primary to another placement
//     before a wishlist is deleted, so shared wishes survive.
//     Consumed by `routes/wishlists.routes.ts` (DELETE) and
//     `routes/admin.routes.ts` (admin DELETE).
//
//   - createGetOrCreateDraftsWishlist({ trackEvent }) — factory for the
//     auto-create-on-demand SYSTEM_DRAFTS wishlist helper. Closes over
//     `trackEvent` (still in index.ts; analytics out of P5s-7 scope).
//     Consumed by `routes/onboarding.routes.ts` and the
//     `importUrlForUser` closure inside index.ts.
//
// Strategy A: source moves here; index.ts imports + threads through
// the existing factory deps to routers (signatures unchanged).
//
// `isWishlistWritable` already lives in `services/entitlement.ts:269`
// (extracted in P5s-1) — not duplicated here.

import * as crypto from 'crypto';
import { prisma, Prisma } from '@wishlist/db';
import { t, type Locale } from '@wishlist/shared';
import { trackProductEvent } from './analytics';

export const DRAFTS_ITEM_LIMIT = 50;

// First-touch acquisition sources that indicate the user arrived via SHARED
// content (someone else's wishlist link, a curated selection, a public
// profile, a referral). When such a user later creates their first OWN
// wishlist, that's the moment they convert from passive guest to active
// owner — the canonical guest.converted_to_user signal.
//
// Bounded list so organic /miniapp openers (firstAcquisitionSource null or
// 'direct') don't get mis-attributed as converted guests. Update with care:
// adding a source here changes the conversion-funnel definition.
const SHARED_CONTENT_ACQUISITION_SOURCES: ReadonlySet<string> = new Set([
  'share_link',
  'referral',
  'curated_selection',
  'public_profile',
  'shared',
]);

export type GuestConversionInput = {
  /** Number of regular wishlists the user owns AFTER this create (so 1 = the just-created one). */
  existingRegularWishlistCount: number;
  /** Set if the user was attributed to an inviter (referral program). */
  referredByUserId: string | null | undefined;
  /** First-touch firstAcquisitionSource from UserProfile. */
  firstAcquisitionSource: string | null | undefined;
};

export type GuestConversionDecision =
  | { emit: true; source: 'referral' | 'share_link' | 'curated_selection' | 'public_profile' | 'shared' }
  | { emit: false };

/**
 * Pure decision rule: should we emit `guest.converted_to_user` for this
 * create-wishlist call?
 *
 * Emit when this is the user's FIRST regular wishlist AND they arrived via
 * shared content (explicit referral or one of the bounded acquisition
 * sources). Always returns false for the 2nd+ wishlist create and for
 * organic / direct-acquisition users.
 *
 * Referral attribution wins over the acquisition source when both are
 * present — the referral pointer is the more authoritative signal because
 * it survives even if the first-touch beacon misfired.
 */
export function evaluateGuestConversion(input: GuestConversionInput): GuestConversionDecision {
  if (input.existingRegularWishlistCount !== 1) return { emit: false };

  if (input.referredByUserId) {
    return { emit: true, source: 'referral' };
  }

  const src = input.firstAcquisitionSource ?? null;
  if (src && SHARED_CONTENT_ACQUISITION_SOURCES.has(src)) {
    return { emit: true, source: src as GuestConversionDecision extends { source: infer S } ? S : never };
  }

  return { emit: false };
}

/**
 * Before deleting a wishlist, make sure shared wishes (items placed in THIS wishlist
 * as their legacy primary + also placed in other wishlists) don't get cascaded away.
 *
 * Strategy: for each item whose Item.wishlistId = wishlistIdBeingDeleted AND has another
 * placement, reassign Item.wishlistId to the oldest remaining placement (matching the
 * DELETE /items/:id/placements/:wishlistId behaviour). After this, wishlist.delete can
 * safely cascade — it will only remove placements in this wishlist + items that were
 * fully homed here.
 */
export async function reassignPrimaryBeforeWishlistDelete(wishlistId: string): Promise<void> {
  // Candidate items: primary points to this wishlist
  const primariesHere = await prisma.item.findMany({
    where: { wishlistId },
    select: { id: true },
  });
  if (primariesHere.length === 0) return;

  for (const { id } of primariesHere) {
    const otherPlacement = await prisma.wishlistItemPlacement.findFirst({
      where: { itemId: id, wishlistId: { not: wishlistId } },
      orderBy: { addedAt: 'asc' },
      select: { wishlistId: true, position: true, categoryId: true },
    });
    if (!otherPlacement) continue; // item fully homed here — will cascade-delete as expected
    // Move primary so the item survives the wishlist cascade
    await prisma.item.update({
      where: { id },
      data: {
        wishlistId: otherPlacement.wishlistId,
        position: otherPlacement.position,
        categoryId: otherPlacement.categoryId,
      },
    });
  }
}

export type TrackEventFn = (event: string, userId?: string, props?: Record<string, unknown>) => void;

export function createGetOrCreateDraftsWishlist(deps: { trackEvent: TrackEventFn }) {
  const { trackEvent } = deps;
  return async function getOrCreateDraftsWishlist(userId: string) {
    const existing = await prisma.wishlist.findFirst({
      where: { ownerId: userId, type: 'SYSTEM_DRAFTS' },
      select: { id: true },
    });
    if (existing) return existing;
    const drafts = await prisma.wishlist.create({
      data: {
        slug: `drafts-${crypto.randomUUID().slice(0, 12)}`,
        ownerId: userId,
        title: 'Неразобранное',
        type: 'SYSTEM_DRAFTS',
      },
      select: { id: true },
    });
    // Canonical analytics: auto-created SYSTEM_DRAFTS
    const existingAny = await prisma.wishlist.count({ where: { ownerId: userId } });
    trackEvent('wishlist_created', userId, {
      wishlistId: drafts.id, wishlistType: 'SYSTEM_DRAFTS', source: 'auto_drafts',
      platform: 'system',
      isFirstRegularWishlist: false,
      isFirstAnyWishlist: existingAny === 1,
    });
    return drafts;
  };
}

// ─── Default REGULAR wishlist (E04 activation) ─────────────────────────────
//
// Auto-materialises the user's first REGULAR wishlist at bootstrap so a
// brand-new user can add an item immediately without going through "create
// your first wishlist" friction. The companion contract:
//
//   - Idempotent: if the user already owns a REGULAR wishlist (manual,
//     onboarding-named, or a previous default), this returns that row and
//     does NOT create a second one. Repeat bootstraps on the same user
//     never emit `wishlist.default_created` twice.
//   - Onboarding-aware via `isDefault` flag: when the user later runs
//     POST /tg/onboarding/create-wishlist, that handler delegates to this
//     service to LOCATE the default row, then RENAMES it (clearing the
//     flag) instead of inserting a duplicate. The service is the single
//     source of truth for default-wishlist lookups.
//   - Race-safe at DB level: the migration
//     `20260525130000_unique_default_wishlist_per_owner` adds a partial
//     unique index `(ownerId) WHERE isDefault = true`. Two concurrent
//     creates land one row + one P2002; the loser falls back to a
//     re-fetch. ALSO catches a slug-collision P2002 the same way.
//   - Dual analytics: emits both the canonical legacy `wishlist_created`
//     (so funnel / cohort dashboards keep counting all wishlist creations)
//     AND the new `wishlist.default_created` (so the E04 activation
//     cohort is separately addressable). Without the legacy emit, the
//     `wishlist_created` cohort would undercount by the entire E04
//     population, breaking month-over-month comparisons.
//
// Returns { id, slug, title, isDefault, alreadyExisted } so callers can
// distinguish a fresh create (alreadyExisted=false) from a no-op return.
export type DefaultWishlistResult = {
  id: string;
  slug: string;
  title: string;
  isDefault: boolean;
  alreadyExisted: boolean;
};

export const DEFAULT_WISHLIST_EMOJI = '🎁';

export function createGetOrCreateDefaultWishlist(deps: { trackEvent: TrackEventFn }) {
  const { trackEvent } = deps;
  return async function getOrCreateDefaultWishlist(
    userId: string,
    locale: Locale,
  ): Promise<DefaultWishlistResult> {
    // Idempotency gate — any REGULAR wishlist (manual, onboarding-named,
    // or prior default) satisfies "has the user EVER been here?" and we
    // skip auto-creation. Ordered by createdAt asc so the canonical
    // "first" wishlist wins if multiple exist (future-historical user
    // with several).
    //
    // Intentionally NO `archivedAt: null` filter — a user who archived
    // their only REGULAR wishlist has demonstrated past wishlist
    // activity, and the right UX path is "unarchive when you want it
    // back", NOT "pile a fresh empty default onto the archive shelf".
    // This DIFFERS from the quota counter in wishlists.routes.ts which
    // DOES filter `archivedAt: null` because the quota answers a
    // different question ("how many active slots are you using?"). The
    // two callers are asking semantically different things, not in
    // disagreement.
    const existing = await prisma.wishlist.findFirst({
      where: { ownerId: userId, type: 'REGULAR' },
      orderBy: { createdAt: 'asc' },
      select: { id: true, slug: true, title: true, isDefault: true },
    });
    if (existing) {
      return { ...existing, alreadyExisted: true };
    }

    const title = t('default_wishlist_title', locale);
    try {
      const created = await prisma.wishlist.create({
        data: {
          slug: `wl-${crypto.randomUUID().slice(0, 12)}`,
          ownerId: userId,
          title,
          emoji: DEFAULT_WISHLIST_EMOJI,
          type: 'REGULAR',
          isDefault: true,
        },
        select: { id: true, slug: true, title: true, isDefault: true },
      });
      // Dual analytics emit — see contract comment above. The legacy
      // `wishlist_created` keeps the existing cohort/funnel dashboards
      // honest; the new `wishlist.default_created` is the E04-specific
      // signal. Both fire exactly once per successful create thanks to
      // the findFirst-early-return + partial-unique-index race guard.
      trackEvent('wishlist_created', userId, {
        wishlistId: created.id,
        wishlistType: 'REGULAR',
        source: 'auto_default',
        platform: 'system',
        isFirstRegularWishlist: true,
        isFirstAnyWishlist: false, // SYSTEM_DRAFTS may or may not exist; not load-bearing for this signal
      });
      trackProductEvent({
        event: 'wishlist.default_created',
        userId,
        props: { wishlistId: created.id, locale },
      });
      return { ...created, alreadyExisted: false };
    } catch (err) {
      // P2002 covers BOTH failure modes:
      //   1. The partial unique index `(ownerId) WHERE isDefault=true`
      //      caught a racing concurrent create (target = ownerId).
      //   2. The slug unique index caught a UUID-12-char collision
      //      (vanishingly rare; same target=slug). We can't distinguish
      //      these from the error meta without parsing target arrays —
      //      and we don't need to, because the recovery is identical:
      //      re-fetch the now-guaranteed-existing REGULAR row.
      const isUniqueConflict =
        err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
      if (!isUniqueConflict) throw err;
      const racing = await prisma.wishlist.findFirst({
        where: { ownerId: userId, type: 'REGULAR' },
        orderBy: { createdAt: 'asc' },
        select: { id: true, slug: true, title: true, isDefault: true },
      });
      if (!racing) throw err;
      return { ...racing, alreadyExisted: true };
    }
  };
}
