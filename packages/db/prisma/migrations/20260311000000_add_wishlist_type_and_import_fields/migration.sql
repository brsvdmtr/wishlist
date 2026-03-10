-- CreateEnum
CREATE TYPE "WishlistType" AS ENUM ('REGULAR', 'SYSTEM_DRAFTS');

-- AlterTable: Add type column to Wishlist
ALTER TABLE "Wishlist" ADD COLUMN "type" "WishlistType" NOT NULL DEFAULT 'REGULAR';

-- AlterTable: Add import tracking columns to Item
ALTER TABLE "Item" ADD COLUMN "sourceUrl" TEXT;
ALTER TABLE "Item" ADD COLUMN "sourceDomain" TEXT;
ALTER TABLE "Item" ADD COLUMN "importMethod" TEXT;
