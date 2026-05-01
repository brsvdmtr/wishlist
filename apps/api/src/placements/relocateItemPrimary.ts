// Move an item's "primary" placement from one wishlist to another.
//
// Used by /tg/items/:id/move, the bulk-move flow, and POST /tg/wishlists/:id/transfer-items
// when a wishlist is being deleted with reserved items.
//
// Semantics (preserved byte-for-byte from the previous in-place version):
//   - Source placement (on Item.wishlistId) is removed.
//   - Target placement is created — or kept if it already exists (item was
//     already shared into target). In the kept case the call effectively
//     just removes the source placement.
//   - Item.wishlistId / Item.position / Item.categoryId are updated to the
//     target so legacy reads stay consistent with the new primary placement.
//   - Other placements (shared into unrelated wishlists) are untouched.
//
// Transaction boundaries (preserved):
//   - Read path (target default category + max position) runs OUTSIDE the
//     transaction with the global prisma client, in parallel via Promise.all.
//   - Write path (delete source / upsert target / sync legacy Item columns)
//     runs INSIDE a single prisma.$transaction.
// Callers must guard capacity and ownership before invoking.
//
// No-op when source === target. Returns void on success.

import { prisma } from '@wishlist/db';
import { resolveDefaultCategoryId, resolveNextPosition } from './slotResolvers';

export async function relocateItemPrimary(
  itemId: string,
  sourceWishlistId: string,
  targetWishlistId: string,
): Promise<void> {
  if (sourceWishlistId === targetWishlistId) return;

  // Resolve target default category + append position once outside the tx
  // (read path doesn't need to observe them atomically).
  const [targetCategoryId, targetPosition] = await Promise.all([
    resolveDefaultCategoryId(prisma, targetWishlistId),
    resolveNextPosition(prisma, targetWishlistId),
  ]);

  await prisma.$transaction(async (tx) => {
    // 1) Remove source placement if present (may already be absent for legacy rows)
    await tx.wishlistItemPlacement.deleteMany({
      where: { wishlistId: sourceWishlistId, itemId },
    });

    // 2) Ensure target placement exists. If already there (item was shared into target),
    // keep existing position/category — don't disturb the user's ordering in target.
    await tx.wishlistItemPlacement.upsert({
      where: { wishlistId_itemId: { wishlistId: targetWishlistId, itemId } },
      create: {
        wishlistId: targetWishlistId,
        itemId,
        position: targetPosition,
        categoryId: targetCategoryId,
      },
      update: {},
    });

    // 3) Sync legacy Item columns to the new primary so non-migrated reads stay consistent.
    const primary = await tx.wishlistItemPlacement.findUnique({
      where: { wishlistId_itemId: { wishlistId: targetWishlistId, itemId } },
      select: { position: true, categoryId: true },
    });
    await tx.item.update({
      where: { id: itemId },
      data: {
        wishlistId: targetWishlistId,
        position: primary?.position ?? targetPosition,
        categoryId: primary?.categoryId ?? targetCategoryId,
      },
    });
  });
}
