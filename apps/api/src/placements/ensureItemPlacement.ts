// Upsert a (wishlistId, itemId) placement row. Safe to call when unsure whether
// the placement already exists (e.g. legacy create paths that also write
// Item.wishlistId). Returns the placement.
//
// Behaviour preserved byte-for-byte from the previous in-place definition:
//   - Conditional category resolution: uses opts.categoryId when provided;
//     otherwise looks up the wishlist's default category.
//   - Conditional position resolution: uses opts.position when provided;
//     otherwise picks max(position) + 1 across all placements in the wishlist.
//   - Sequential awaits (NOT Promise.all) — preserves original ordering and
//     transaction-step semantics for callers that pass a `tx`.
//   - Upsert with `update: {}` so re-calls don't disturb existing rows
//     (idempotency contract relied on by dual-write paths).
//
// `tx` is typed as a wide Pick<> so callers can pass either the global prisma
// client or a Prisma transaction client. The 'item' field in the Pick is
// retained from the original signature for binary-compatible call sites,
// even though the body itself does not currently call `tx.item.*`.

import { prisma } from '@wishlist/db';
import { resolveDefaultCategoryId, resolveNextPosition } from './slotResolvers';

export async function ensureItemPlacement(
  tx: Pick<typeof prisma, 'wishlistItemPlacement' | 'wishlistCategory' | 'item'>,
  opts: { wishlistId: string; itemId: string; position?: number; categoryId?: string | null },
): Promise<{ id: string; wishlistId: string; itemId: string; position: number; categoryId: string | null }> {
  // Resolve default category if not provided
  let categoryId = opts.categoryId ?? null;
  if (categoryId === null) {
    categoryId = await resolveDefaultCategoryId(tx, opts.wishlistId);
  }

  // Resolve position if not provided: max(position) + 1 across active items in wishlist
  let position = opts.position;
  if (position === undefined) {
    position = await resolveNextPosition(tx, opts.wishlistId);
  }

  // Upsert placement — unique (wishlistId, itemId)
  return tx.wishlistItemPlacement.upsert({
    where: { wishlistId_itemId: { wishlistId: opts.wishlistId, itemId: opts.itemId } },
    create: { wishlistId: opts.wishlistId, itemId: opts.itemId, position, categoryId },
    update: {}, // don't overwrite if already exists
    select: { id: true, wishlistId: true, itemId: true, position: true, categoryId: true },
  });
}
