// Count active-status placements in a wishlist — the authoritative capacity
// source. Shared wishes count against every host wishlist, so capacity
// must be enforced via placements rather than via `prisma.item.count`.
//
// Uses the global `prisma` client (no tx parameter) — same as the previous
// in-place definition. Capacity checks in route handlers run outside a
// transaction; if a transactional callsite ever needs this count it should
// call the same query inline against its own `tx`.
//
// ACTIVE_PLACEMENT_STATUSES is intentionally a local copy of ACTIVE_STATUSES
// (in apps/api/src/index.ts) — duplicating 3 string literals avoids a
// circular import between index.ts and this module. The two lists must stay
// in sync; if you change one, change both.

import { prisma } from '@wishlist/db';

const ACTIVE_PLACEMENT_STATUSES = ['AVAILABLE', 'RESERVED', 'PURCHASED'] as const;

export async function countActivePlacementsInWishlist(wishlistId: string): Promise<number> {
  return prisma.wishlistItemPlacement.count({
    where: { wishlistId, item: { status: { in: [...ACTIVE_PLACEMENT_STATUSES] } } },
  });
}
