-- CreateTable
CREATE TABLE "WishlistItemPlacement" (
    "id" TEXT NOT NULL,
    "wishlistId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "categoryId" TEXT,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WishlistItemPlacement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WishlistItemPlacement_wishlistId_itemId_key" ON "WishlistItemPlacement"("wishlistId", "itemId");

-- CreateIndex
CREATE INDEX "WishlistItemPlacement_itemId_idx" ON "WishlistItemPlacement"("itemId");

-- CreateIndex
CREATE INDEX "WishlistItemPlacement_wishlistId_position_idx" ON "WishlistItemPlacement"("wishlistId", "position");

-- CreateIndex
CREATE INDEX "WishlistItemPlacement_categoryId_idx" ON "WishlistItemPlacement"("categoryId");

-- AddForeignKey
ALTER TABLE "WishlistItemPlacement" ADD CONSTRAINT "WishlistItemPlacement_wishlistId_fkey" FOREIGN KEY ("wishlistId") REFERENCES "Wishlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistItemPlacement" ADD CONSTRAINT "WishlistItemPlacement_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistItemPlacement" ADD CONSTRAINT "WishlistItemPlacement_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "WishlistCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: 1 placement per existing Item, mirroring its current wishlist/position/category.
-- Uses gen_random_uuid() (available in Postgres ≥13) for unique IDs; format doesn't need to be cuid —
-- @id is String, and new placements created via Prisma Client will use cuid() going forward.
INSERT INTO "WishlistItemPlacement" ("id", "wishlistId", "itemId", "position", "categoryId", "addedAt", "updatedAt")
SELECT
  'plc_' || replace(gen_random_uuid()::text, '-', ''),
  "wishlistId",
  "id",
  "position",
  "categoryId",
  "createdAt",
  NOW()
FROM "Item"
ON CONFLICT ("wishlistId", "itemId") DO NOTHING;
