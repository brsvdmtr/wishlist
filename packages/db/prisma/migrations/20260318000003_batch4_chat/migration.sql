-- Batch 4.1: Chat Foundation
-- Extends SantaChatMessage with messageType/systemEvent/payload,
-- adds SantaChatMute model, and adds CHAT_MESSAGE + POLL_CREATED notification types.

-- 1. SantaChatMessageType enum
CREATE TYPE "SantaChatMessageType" AS ENUM ('USER', 'SYSTEM');

-- 2. Extend SantaChatMessage
ALTER TABLE "SantaChatMessage"
  ADD COLUMN IF NOT EXISTS "messageType" "SantaChatMessageType" NOT NULL DEFAULT 'USER';
ALTER TABLE "SantaChatMessage"
  ADD COLUMN IF NOT EXISTS "systemEvent" TEXT;
ALTER TABLE "SantaChatMessage"
  ADD COLUMN IF NOT EXISTS "payload" JSONB;

-- 3. SantaChatMute model
CREATE TABLE "SantaChatMute" (
  "id"            TEXT NOT NULL,
  "campaignId"    TEXT NOT NULL,
  "participantId" TEXT NOT NULL,
  "mutedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SantaChatMute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SantaChatMute_campaignId_participantId_key"
  ON "SantaChatMute"("campaignId", "participantId");

ALTER TABLE "SantaChatMute"
  ADD CONSTRAINT "SantaChatMute_campaignId_fkey"
    FOREIGN KEY ("campaignId") REFERENCES "SantaCampaign"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SantaChatMute"
  ADD CONSTRAINT "SantaChatMute_participantId_fkey"
    FOREIGN KEY ("participantId") REFERENCES "SantaParticipant"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Extend SantaNotificationType with new chat/poll types
ALTER TYPE "SantaNotificationType" ADD VALUE IF NOT EXISTS 'CHAT_MESSAGE';
ALTER TYPE "SantaNotificationType" ADD VALUE IF NOT EXISTS 'POLL_CREATED';
