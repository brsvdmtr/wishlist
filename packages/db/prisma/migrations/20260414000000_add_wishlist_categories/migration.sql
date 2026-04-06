-- CreateTable
CREATE TABLE "WishlistCategory" (
    "id" TEXT NOT NULL,
    "wishlistId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WishlistCategory_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WishlistCategory_wishlistId_sortOrder_idx" ON "WishlistCategory"("wishlistId", "sortOrder");

-- CreateIndex
CREATE INDEX "WishlistCategory_wishlistId_isDefault_idx" ON "WishlistCategory"("wishlistId", "isDefault");

-- AlterTable: add categoryId to Item (nullable)
ALTER TABLE "Item" ADD COLUMN "categoryId" TEXT;

-- CreateIndex
CREATE INDEX "Item_categoryId_idx" ON "Item"("categoryId");

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "WishlistCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WishlistCategory" ADD CONSTRAINT "WishlistCategory_wishlistId_fkey" FOREIGN KEY ("wishlistId") REFERENCES "Wishlist"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: create default category for every existing wishlist
INSERT INTO "WishlistCategory" ("id", "wishlistId", "name", "sortOrder", "isDefault", "createdAt", "updatedAt")
SELECT
  'wc_def_' || "id",
  "id",
  'Без категории',
  999999,
  true,
  NOW(),
  NOW()
FROM "Wishlist";

-- Backfill: assign all existing items to their wishlist's default category
UPDATE "Item" SET "categoryId" = (
  SELECT "WishlistCategory"."id"
  FROM "WishlistCategory"
  WHERE "WishlistCategory"."wishlistId" = "Item"."wishlistId"
    AND "WishlistCategory"."isDefault" = true
  LIMIT 1
)
WHERE "categoryId" IS NULL;
