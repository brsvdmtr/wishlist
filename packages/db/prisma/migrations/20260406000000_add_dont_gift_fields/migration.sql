-- Add "Don't Gift" fields to UserProfile
ALTER TABLE "UserProfile" ADD COLUMN "dontGiftPresets" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "UserProfile" ADD COLUMN "dontGiftCustomItems" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "UserProfile" ADD COLUMN "dontGiftComment" TEXT;
ALTER TABLE "UserProfile" ADD COLUMN "dontGiftVisible" BOOLEAN NOT NULL DEFAULT true;
