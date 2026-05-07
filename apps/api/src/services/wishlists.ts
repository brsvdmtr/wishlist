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
import { prisma } from '@wishlist/db';

export const DRAFTS_ITEM_LIMIT = 50;

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
