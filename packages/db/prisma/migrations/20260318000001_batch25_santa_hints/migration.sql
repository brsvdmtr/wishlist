-- Batch 2.5: Santa Hints
--
-- The original SantaHintRequest (Batch 1 stub) used a Q&A model (question/answer text)
-- with APPROVED/REJECTED statuses and requester/responder relations.
-- Batch 2.5 replaces this entirely with a wishlist-item-selection model.
--
-- No production data in SantaHintRequest (endpoints were never implemented in Batch 1),
-- so DROP + recreate is safe.
--
-- STATE MACHINE: PENDING → FULFILLED | EXPIRED | CANCELLED (all terminal)
-- ANONYMITY: receiverParticipantId / giverParticipantId stored in DB but NEVER exposed
--            to the opposite party via API.
--
-- NOTE: All Santa tables use PascalCase naming (Prisma default, no @@map).

-- ─── 1. Drop old hint table (Batch 1 stub) ────────────────────────────────────

DROP TABLE IF EXISTS "SantaHintRequest" CASCADE;

-- ─── 2. Replace SantaHintStatus enum ─────────────────────────────────────────

DROP TYPE IF EXISTS "SantaHintStatus";

CREATE TYPE "SantaHintStatus" AS ENUM (
  'PENDING',    -- giver requested, receiver hasn't responded yet
  'FULFILLED',  -- receiver selected wishlist items; giver can see them (terminal)
  'EXPIRED',    -- TTL exceeded (48h) without receiver response (terminal)
  'CANCELLED'   -- campaign cancelled or draw context invalidated (terminal)
);

-- ─── 3. Create new SantaHintRequest table ─────────────────────────────────────

CREATE TABLE "SantaHintRequest" (
  "id"                    TEXT         NOT NULL,
  "campaignId"            TEXT         NOT NULL,
  "roundId"               TEXT         NOT NULL,
  "assignmentId"          TEXT         NOT NULL,
  "giverParticipantId"    TEXT         NOT NULL,
  "receiverParticipantId" TEXT         NOT NULL,
  "status"                "SantaHintStatus" NOT NULL DEFAULT 'PENDING',
  -- JSON array of item IDs selected by receiver; null until FULFILLED
  "selectedItemIds"       JSONB,
  "requestedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "fulfilledAt"           TIMESTAMP(3),
  -- expiresAt = requestedAt + 48h; set explicitly at creation time
  "expiresAt"             TIMESTAMP(3) NOT NULL,
  "cancelledAt"           TIMESTAMP(3),
  -- Prevents duplicate HINT_REQUEST notifications to receiver on idempotent retry
  "notificationSentAt"    TIMESTAMP(3),

  CONSTRAINT "SantaHintRequest_pkey" PRIMARY KEY ("id")
);

-- ─── 4. Indexes ───────────────────────────────────────────────────────────────

-- Giver-side lookup: find my hint(s) for a given assignment
CREATE INDEX "SantaHintRequest_assignmentId_status_idx"
  ON "SantaHintRequest"("assignmentId", "status");

-- Receiver-side lookup: find pending hints for a given receiver participant
CREATE INDEX "SantaHintRequest_receiverParticipantId_status_idx"
  ON "SantaHintRequest"("receiverParticipantId", "status");

-- Campaign-centric receiver lookup (primary receiver endpoint path)
CREATE INDEX "SantaHintRequest_campaignId_receiverParticipantId_status_idx"
  ON "SantaHintRequest"("campaignId", "receiverParticipantId", "status");

-- TTL expiry job: find PENDING hints past their TTL
CREATE INDEX "SantaHintRequest_expiresAt_status_idx"
  ON "SantaHintRequest"("expiresAt", "status");

-- ─── 5. Foreign key constraints ──────────────────────────────────────────────

-- Campaign: cascade-delete all hints when campaign is deleted
ALTER TABLE "SantaHintRequest"
  ADD CONSTRAINT "SantaHintRequest_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "SantaCampaign"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Round: cascade-delete hints when round is deleted (draw reset scenario)
ALTER TABLE "SantaHintRequest"
  ADD CONSTRAINT "SantaHintRequest_roundId_fkey"
  FOREIGN KEY ("roundId") REFERENCES "SantaRound"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Assignment: cascade-delete hints when assignment is deleted (draw reset)
-- This is the primary draw-reset guard: deleted assignments → deleted hints
ALTER TABLE "SantaHintRequest"
  ADD CONSTRAINT "SantaHintRequest_assignmentId_fkey"
  FOREIGN KEY ("assignmentId") REFERENCES "SantaAssignment"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Giver participant: cascade-delete if participant removed
ALTER TABLE "SantaHintRequest"
  ADD CONSTRAINT "SantaHintRequest_giverParticipantId_fkey"
  FOREIGN KEY ("giverParticipantId") REFERENCES "SantaParticipant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Receiver participant: cascade-delete if participant removed
ALTER TABLE "SantaHintRequest"
  ADD CONSTRAINT "SantaHintRequest_receiverParticipantId_fkey"
  FOREIGN KEY ("receiverParticipantId") REFERENCES "SantaParticipant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
