-- Gift Notes v2: simplify GiftOccasion + add GiftOccasionIdea
-- Drop legacy tables that are no longer needed

DROP TABLE IF EXISTS "GiftOccasionMute" CASCADE;
DROP TABLE IF EXISTS "GiftPlanState" CASCADE;
DROP TABLE IF EXISTS "GiftReminderDelivery" CASCADE;

-- Rebuild GiftOccasion: drop legacy columns, add new ones
ALTER TABLE "GiftOccasion" DROP COLUMN IF EXISTS "personId";
ALTER TABLE "GiftOccasion" DROP COLUMN IF EXISTS "allDay";
ALTER TABLE "GiftOccasion" DROP COLUMN IF EXISTS "timezone";
ALTER TABLE "GiftOccasion" DROP COLUMN IF EXISTS "reminderOffsetsJson";
ALTER TABLE "GiftOccasion" DROP COLUMN IF EXISTS "isActive";
ALTER TABLE "GiftOccasion" DROP COLUMN IF EXISTS "isMuted";
ALTER TABLE "GiftOccasion" DROP COLUMN IF EXISTS "suggestWishlist";
ALTER TABLE "GiftOccasion" DROP COLUMN IF EXISTS "suggestHint";
ALTER TABLE "GiftOccasion" DROP COLUMN IF EXISTS "suggestGiftIdeas";
ALTER TABLE "GiftOccasion" DROP COLUMN IF EXISTS "suggestSubscription";

-- Add new columns
ALTER TABLE "GiftOccasion" ADD COLUMN IF NOT EXISTS "personName" TEXT;
ALTER TABLE "GiftOccasion" ADD COLUMN IF NOT EXISTS "note" TEXT;
ALTER TABLE "GiftOccasion" ADD COLUMN IF NOT EXISTS "status" TEXT NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE "GiftOccasion" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);

-- Make eventDate nullable (was NOT NULL before)
ALTER TABLE "GiftOccasion" ALTER COLUMN "eventDate" DROP NOT NULL;

-- Update type default from CUSTOM to OTHER
ALTER TABLE "GiftOccasion" ALTER COLUMN "type" SET DEFAULT 'OTHER';

-- Drop legacy indexes
DROP INDEX IF EXISTS "GiftOccasion_ownerUserId_isActive_idx";
DROP INDEX IF EXISTS "GiftOccasion_personId_idx";

-- Add new indexes
CREATE INDEX IF NOT EXISTS "GiftOccasion_ownerUserId_status_idx" ON "GiftOccasion"("ownerUserId", "status");

-- Create GiftOccasionIdea
CREATE TABLE "GiftOccasionIdea" (
    "id" TEXT NOT NULL,
    "occasionId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "link" TEXT,
    "price" INTEGER,
    "currency" TEXT,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "archivedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "GiftOccasionIdea_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GiftOccasionIdea_occasionId_idx" ON "GiftOccasionIdea"("occasionId");
CREATE INDEX "GiftOccasionIdea_ownerUserId_idx" ON "GiftOccasionIdea"("ownerUserId");
CREATE INDEX "GiftOccasionIdea_occasionId_status_idx" ON "GiftOccasionIdea"("occasionId", "status");

ALTER TABLE "GiftOccasionIdea" ADD CONSTRAINT "GiftOccasionIdea_occasionId_fkey"
  FOREIGN KEY ("occasionId") REFERENCES "GiftOccasion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GiftOccasionIdea" ADD CONSTRAINT "GiftOccasionIdea_ownerUserId_fkey"
  FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Drop GiftPerson (no longer needed - replaced by personName text field)
DROP TABLE IF EXISTS "GiftPerson" CASCADE;
