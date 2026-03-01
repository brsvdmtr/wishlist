-- AlterEnum
ALTER TYPE "ItemStatus" ADD VALUE 'COMPLETED';
ALTER TYPE "ItemStatus" ADD VALUE 'DELETED';

-- AlterTable
ALTER TABLE "Wishlist" ADD COLUMN "deadline" TIMESTAMP(3);
