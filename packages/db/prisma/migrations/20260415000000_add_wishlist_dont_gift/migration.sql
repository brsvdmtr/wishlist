-- AlterTable
ALTER TABLE "Wishlist" ADD COLUMN "dontGiftMode" TEXT NOT NULL DEFAULT 'global';
ALTER TABLE "Wishlist" ADD COLUMN "dontGiftPresets" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Wishlist" ADD COLUMN "dontGiftCustomItems" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Wishlist" ADD COLUMN "dontGiftComment" TEXT;
