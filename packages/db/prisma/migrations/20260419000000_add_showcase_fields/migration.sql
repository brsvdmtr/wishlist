-- AlterTable
ALTER TABLE "UserProfile" ADD COLUMN "showcaseEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "UserProfile" ADD COLUMN "showcaseCoverUrl" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN "showcaseBio" VARCHAR(180);
ALTER TABLE "UserProfile" ADD COLUMN "showcasePinnedIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "UserProfile" ADD COLUMN "showcasePreferences" VARCHAR(300);
ALTER TABLE "UserProfile" ADD COLUMN "showcaseSizeClothing" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN "showcaseSizeShoes" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN "showcaseSizeRing" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN "showcaseSizeOther" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN "showcaseBrands" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "UserProfile" ADD COLUMN "showcaseUpdatedAt" TIMESTAMP(3);
