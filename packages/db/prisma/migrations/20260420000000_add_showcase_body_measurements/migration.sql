-- AlterTable: body measurements for showcase (chest, waist, hips)
ALTER TABLE "UserProfile" ADD COLUMN "showcaseChest" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN "showcaseWaist" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN "showcaseHips"  TEXT;
