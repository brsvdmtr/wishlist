-- AlterTable: add shareToken column (idempotent)
ALTER TABLE "Wishlist" ADD COLUMN IF NOT EXISTS "shareToken" TEXT;

-- CreateIndex: unique index on shareToken (idempotent)
CREATE UNIQUE INDEX IF NOT EXISTS "Wishlist_shareToken_key" ON "Wishlist"("shareToken");
