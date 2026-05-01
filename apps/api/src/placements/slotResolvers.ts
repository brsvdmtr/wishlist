// Pure SQL helpers shared by ensureItemPlacement and relocateItemPrimary —
// both used to inline the same two queries. Extracted here without behaviour
// change: each helper runs exactly the query the original sites ran, with
// the same args, returning the same value.
//
// The `tx` parameter is structurally typed via `Pick<typeof prisma, ...>` so
// callers can pass either:
//   - the global prisma client (used by relocateItemPrimary's pre-tx reads),
//   - a Prisma transaction client `tx` (used by ensureItemPlacement, which
//     itself receives one from its caller).
// This is the same pattern the existing helpers used.

import { prisma } from '@wishlist/db';

export async function resolveDefaultCategoryId(
  tx: Pick<typeof prisma, 'wishlistCategory'>,
  wishlistId: string,
): Promise<string | null> {
  const def = await tx.wishlistCategory.findFirst({
    where: { wishlistId, isDefault: true },
    select: { id: true },
  });
  return def?.id ?? null;
}

export async function resolveNextPosition(
  tx: Pick<typeof prisma, 'wishlistItemPlacement'>,
  wishlistId: string,
): Promise<number> {
  const maxPos = await tx.wishlistItemPlacement.aggregate({
    where: { wishlistId },
    _max: { position: true },
  });
  return (maxPos._max.position ?? -1) + 1;
}
