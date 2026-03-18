-- Batch 4.2: Polls
-- Extends SantaPoll with campaign-level scoping, anonymous votes,
-- creator tracking, and deadline. Makes roundId optional.

-- 1. Add new columns
ALTER TABLE "SantaPoll"
  ADD COLUMN IF NOT EXISTS "campaignId"              TEXT NOT NULL DEFAULT '';
ALTER TABLE "SantaPoll"
  ADD COLUMN IF NOT EXISTS "isAnonymous"             BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SantaPoll"
  ADD COLUMN IF NOT EXISTS "createdByParticipantId"  TEXT;
ALTER TABLE "SantaPoll"
  ADD COLUMN IF NOT EXISTS "deadlineAt"              TIMESTAMP(3);

-- 2. Backfill campaignId from roundId for any existing rows
UPDATE "SantaPoll" p SET "campaignId" = r."campaignId"
FROM "SantaRound" r WHERE p."roundId" = r.id AND p."campaignId" = '';

-- 3. Make roundId nullable (polls are now campaign-scoped; roundId is optional)
ALTER TABLE "SantaPoll" ALTER COLUMN "roundId" DROP NOT NULL;

-- 4. Index + FK for campaignId
CREATE INDEX IF NOT EXISTS "SantaPoll_campaignId_idx" ON "SantaPoll"("campaignId");

ALTER TABLE "SantaPoll"
  ADD CONSTRAINT "SantaPoll_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "SantaCampaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SantaPoll"
  ADD CONSTRAINT "SantaPoll_createdByParticipantId_fkey"
    FOREIGN KEY ("createdByParticipantId") REFERENCES "SantaParticipant"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
