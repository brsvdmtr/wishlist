-- Batch 5.3: Roles + Organizer Controls + Exit Request Flow
--
-- Changes:
--   1. New enum SantaParticipantRole (PARTICIPANT | ADMIN)
--   2. New enum SantaExitRequestStatus (PENDING | APPROVED | DENIED)
--   3. Add ORPHANED to SantaGiftStatus (terminal status for approved exits in ACTIVE rounds)
--   4. Add role column to SantaParticipant (default PARTICIPANT)
--   5. Add EXIT_REQUEST_SUBMITTED, EXIT_REQUEST_APPROVED, EXIT_REQUEST_DENIED to SantaNotificationType
--   6. Create SantaExitRequest table

-- 1. New enum: participant role
CREATE TYPE "SantaParticipantRole" AS ENUM ('PARTICIPANT', 'ADMIN');

-- 2. New enum: exit request status
CREATE TYPE "SantaExitRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

-- 3. Add ORPHANED to SantaGiftStatus
--    Terminal status: set when an ACTIVE-round assignment is orphaned by approved exit.
ALTER TYPE "SantaGiftStatus" ADD VALUE IF NOT EXISTS 'ORPHANED';

-- 4. Add role column to SantaParticipant
ALTER TABLE "SantaParticipant" ADD COLUMN IF NOT EXISTS "role" "SantaParticipantRole" NOT NULL DEFAULT 'PARTICIPANT';

-- 5. Add exit request notification types
ALTER TYPE "SantaNotificationType" ADD VALUE IF NOT EXISTS 'EXIT_REQUEST_SUBMITTED';
ALTER TYPE "SantaNotificationType" ADD VALUE IF NOT EXISTS 'EXIT_REQUEST_APPROVED';
ALTER TYPE "SantaNotificationType" ADD VALUE IF NOT EXISTS 'EXIT_REQUEST_DENIED';

-- 6. Create SantaExitRequest table
CREATE TABLE "SantaExitRequest" (
  "id"            TEXT NOT NULL,
  "campaignId"    TEXT NOT NULL,
  "participantId" TEXT NOT NULL,
  "roundId"       TEXT,                     -- round active at request time (context only, nullable)
  "reason"        TEXT,
  "status"        "SantaExitRequestStatus" NOT NULL DEFAULT 'PENDING',
  "resolvedAt"    TIMESTAMP(3),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SantaExitRequest_pkey" PRIMARY KEY ("id")
);

-- Only one PENDING exit request per participant per campaign at a time
CREATE UNIQUE INDEX "SantaExitRequest_participant_pending_key"
  ON "SantaExitRequest"("participantId")
  WHERE "status" = 'PENDING';

CREATE INDEX "SantaExitRequest_campaignId_idx" ON "SantaExitRequest"("campaignId");
CREATE INDEX "SantaExitRequest_participantId_idx" ON "SantaExitRequest"("participantId");

ALTER TABLE "SantaExitRequest"
  ADD CONSTRAINT "SantaExitRequest_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "SantaCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SantaExitRequest"
  ADD CONSTRAINT "SantaExitRequest_participantId_fkey"
    FOREIGN KEY ("participantId") REFERENCES "SantaParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SantaExitRequest"
  ADD CONSTRAINT "SantaExitRequest_roundId_fkey"
    FOREIGN KEY ("roundId") REFERENCES "SantaRound"("id") ON DELETE SET NULL ON UPDATE CASCADE;
