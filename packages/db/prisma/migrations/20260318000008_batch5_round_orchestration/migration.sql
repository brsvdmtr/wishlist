-- Batch 5.2: Multi-round orchestration
--
-- Strategy:
--   - Add currentRoundId (nullable FK) to SantaCampaign as the single
--     authoritative pointer to the live/most-recent round.
--   - Partial unique index enforces at most one PENDING round per campaign
--     (DB-level backstop for the "only one PENDING round" invariant).
--   - Backfill currentRoundId for all existing ACTIVE/COMPLETED campaigns.
--   - All other models are unchanged; the change is purely additive.

-- 1. Add currentRoundId column (nullable)
ALTER TABLE "SantaCampaign" ADD COLUMN IF NOT EXISTS "currentRoundId" TEXT;

-- 2. Unique index: each round can be "current" for at most one campaign
CREATE UNIQUE INDEX IF NOT EXISTS "SantaCampaign_currentRoundId_key"
  ON "SantaCampaign"("currentRoundId");

-- 3. FK constraint: nullable, SetNull on round delete (rounds are never deleted
--    in practice, but this is the correct safe default)
ALTER TABLE "SantaCampaign"
  ADD CONSTRAINT "SantaCampaign_currentRoundId_fkey"
  FOREIGN KEY ("currentRoundId") REFERENCES "SantaRound"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Partial unique index: at most one PENDING round per campaign.
--    This is the DB-level enforcement of Round Invariant #1.
CREATE UNIQUE INDEX IF NOT EXISTS "SantaRound_campaignId_pending_key"
  ON "SantaRound"("campaignId")
  WHERE "drawStatus" = 'PENDING';

-- 5. Backfill: set currentRoundId for all campaigns that have a completed draw.
--    Uses the most recent DONE round (highest roundNumber) per campaign.
UPDATE "SantaCampaign" c
SET "currentRoundId" = (
  SELECT r.id
  FROM "SantaRound" r
  WHERE r."campaignId" = c.id
    AND r."drawStatus" = 'DONE'
  ORDER BY r."roundNumber" DESC
  LIMIT 1
);
