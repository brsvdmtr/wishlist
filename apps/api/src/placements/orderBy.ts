// Prisma orderBy for placement-based item reads — mirrors ITEM_ORDER_BY (in
// ../sort.ts) but resolves priority/createdAt from the related Item and
// position from the placement, so reordering within one wishlist doesn't
// affect the same wish's siblings in other (shared) wishlists.
//
// This constant ships byte-identical to the previous in-place definition in
// index.ts. Do not reorder fields or change directions — Mini App rendering
// and several integration tests depend on the exact tiebreak chain.

export const PLACEMENT_ORDER_BY = [
  { item: { priority: 'desc' as const } },
  { position: 'asc' as const },
  { item: { createdAt: 'desc' as const } },
  { item: { id: 'desc' as const } },
];
