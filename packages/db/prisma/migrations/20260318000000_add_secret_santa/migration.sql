-- CreateEnum
CREATE TYPE "SantaCampaignStatus" AS ENUM ('DRAFT', 'OPEN', 'LOCKED', 'DRAW_IN_PROGRESS', 'ACTIVE', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SantaCampaignType" AS ENUM ('CLASSIC', 'MULTI_WAVE');

-- CreateEnum
CREATE TYPE "SantaParticipantStatus" AS ENUM ('INVITED', 'JOINED', 'LEFT', 'REMOVED');

-- CreateEnum
CREATE TYPE "SantaGiftStatus" AS ENUM ('PENDING', 'BUYING', 'SENT', 'RECEIVED');

-- CreateEnum
CREATE TYPE "SantaDrawStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "SantaHintStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "SantaNotificationType" AS ENUM ('JOINED', 'LEFT', 'DRAW_DONE', 'GIFT_STATUS_CHANGED', 'HINT_REQUEST', 'HINT_RESPONDED', 'CAMPAIGN_CANCELLED');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "santaTestMode" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "SantaSeasonConfig" (
    "id" TEXT NOT NULL,
    "seasonYear" INTEGER NOT NULL,
    "seasonStartAt" TIMESTAMP(3) NOT NULL,
    "seasonEndAt" TIMESTAMP(3) NOT NULL,
    "campaignCreateEnabled" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SantaSeasonConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SantaCampaign" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" "SantaCampaignType" NOT NULL DEFAULT 'CLASSIC',
    "status" "SantaCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "ownerId" TEXT NOT NULL,
    "inviteToken" TEXT NOT NULL,
    "minBudget" INTEGER,
    "maxBudget" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'RUB',
    "drawAt" TIMESTAMP(3),
    "seasonYear" INTEGER NOT NULL,
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SantaCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SantaParticipant" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "SantaParticipantStatus" NOT NULL DEFAULT 'JOINED',
    "linkedWishlistId" TEXT,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "SantaParticipant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SantaRound" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "roundNumber" INTEGER NOT NULL DEFAULT 1,
    "drawStatus" "SantaDrawStatus" NOT NULL DEFAULT 'PENDING',
    "drawJobId" TEXT,
    "drawnAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SantaRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SantaAssignment" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "giverParticipantId" TEXT NOT NULL,
    "receiverParticipantId" TEXT NOT NULL,
    "giftStatus" "SantaGiftStatus" NOT NULL DEFAULT 'PENDING',
    "giftNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SantaAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SantaGiftProgress" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "status" "SantaGiftStatus" NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SantaGiftProgress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SantaExclusion" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId1" TEXT NOT NULL,
    "userId2" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SantaExclusion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SantaHintRequest" (
    "id" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "requesterParticipantId" TEXT NOT NULL,
    "responderParticipantId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "status" "SantaHintStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "SantaHintRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SantaChatMessage" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SantaChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SantaChatReadCursor" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "lastReadMessageId" TEXT,
    "lastReadAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SantaChatReadCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SantaPoll" (
    "id" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" JSONB NOT NULL,
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SantaPoll_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SantaPollVote" (
    "id" TEXT NOT NULL,
    "pollId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "optionIndex" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SantaPollVote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SantaNotification" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "SantaNotificationType" NOT NULL,
    "payload" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SantaNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SantaAdminAuditLog" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SantaAdminAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateUniqueIndex
CREATE UNIQUE INDEX "SantaSeasonConfig_seasonYear_key" ON "SantaSeasonConfig"("seasonYear");
CREATE UNIQUE INDEX "SantaCampaign_inviteToken_key" ON "SantaCampaign"("inviteToken");
CREATE UNIQUE INDEX "SantaParticipant_campaignId_userId_key" ON "SantaParticipant"("campaignId", "userId");
CREATE UNIQUE INDEX "SantaRound_campaignId_roundNumber_key" ON "SantaRound"("campaignId", "roundNumber");
CREATE UNIQUE INDEX "SantaAssignment_roundId_giverParticipantId_key" ON "SantaAssignment"("roundId", "giverParticipantId");
CREATE UNIQUE INDEX "SantaAssignment_roundId_receiverParticipantId_key" ON "SantaAssignment"("roundId", "receiverParticipantId");
CREATE UNIQUE INDEX "SantaExclusion_campaignId_userId1_userId2_key" ON "SantaExclusion"("campaignId", "userId1", "userId2");
CREATE UNIQUE INDEX "SantaChatReadCursor_campaignId_participantId_key" ON "SantaChatReadCursor"("campaignId", "participantId");
CREATE UNIQUE INDEX "SantaPollVote_pollId_participantId_key" ON "SantaPollVote"("pollId", "participantId");

-- CreateIndex
CREATE INDEX "SantaCampaign_ownerId_idx" ON "SantaCampaign"("ownerId");
CREATE INDEX "SantaCampaign_inviteToken_idx" ON "SantaCampaign"("inviteToken");
CREATE INDEX "SantaCampaign_seasonYear_idx" ON "SantaCampaign"("seasonYear");
CREATE INDEX "SantaParticipant_campaignId_idx" ON "SantaParticipant"("campaignId");
CREATE INDEX "SantaParticipant_userId_idx" ON "SantaParticipant"("userId");
CREATE INDEX "SantaParticipant_linkedWishlistId_idx" ON "SantaParticipant"("linkedWishlistId");
CREATE INDEX "SantaRound_campaignId_idx" ON "SantaRound"("campaignId");
CREATE INDEX "SantaAssignment_roundId_idx" ON "SantaAssignment"("roundId");
CREATE INDEX "SantaGiftProgress_assignmentId_idx" ON "SantaGiftProgress"("assignmentId");
CREATE INDEX "SantaExclusion_campaignId_idx" ON "SantaExclusion"("campaignId");
CREATE INDEX "SantaHintRequest_assignmentId_idx" ON "SantaHintRequest"("assignmentId");
CREATE INDEX "SantaHintRequest_responderParticipantId_idx" ON "SantaHintRequest"("responderParticipantId");
CREATE INDEX "SantaChatMessage_campaignId_createdAt_id_idx" ON "SantaChatMessage"("campaignId", "createdAt", "id");
CREATE INDEX "SantaNotification_userId_readAt_idx" ON "SantaNotification"("userId", "readAt");
CREATE INDEX "SantaNotification_campaignId_idx" ON "SantaNotification"("campaignId");
CREATE INDEX "SantaAdminAuditLog_campaignId_idx" ON "SantaAdminAuditLog"("campaignId");
CREATE INDEX "SantaPoll_roundId_idx" ON "SantaPoll"("roundId");

-- AddForeignKey
ALTER TABLE "SantaCampaign" ADD CONSTRAINT "SantaCampaign_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "SantaParticipant" ADD CONSTRAINT "SantaParticipant_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SantaCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SantaParticipant" ADD CONSTRAINT "SantaParticipant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SantaParticipant" ADD CONSTRAINT "SantaParticipant_linkedWishlistId_fkey" FOREIGN KEY ("linkedWishlistId") REFERENCES "Wishlist"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SantaRound" ADD CONSTRAINT "SantaRound_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SantaCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SantaAssignment" ADD CONSTRAINT "SantaAssignment_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "SantaRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SantaAssignment" ADD CONSTRAINT "SantaAssignment_giverParticipantId_fkey" FOREIGN KEY ("giverParticipantId") REFERENCES "SantaParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SantaAssignment" ADD CONSTRAINT "SantaAssignment_receiverParticipantId_fkey" FOREIGN KEY ("receiverParticipantId") REFERENCES "SantaParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SantaGiftProgress" ADD CONSTRAINT "SantaGiftProgress_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "SantaAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SantaHintRequest" ADD CONSTRAINT "SantaHintRequest_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "SantaAssignment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SantaHintRequest" ADD CONSTRAINT "SantaHintRequest_requesterParticipantId_fkey" FOREIGN KEY ("requesterParticipantId") REFERENCES "SantaParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SantaHintRequest" ADD CONSTRAINT "SantaHintRequest_responderParticipantId_fkey" FOREIGN KEY ("responderParticipantId") REFERENCES "SantaParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SantaChatMessage" ADD CONSTRAINT "SantaChatMessage_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SantaCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SantaChatMessage" ADD CONSTRAINT "SantaChatMessage_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "SantaParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SantaChatReadCursor" ADD CONSTRAINT "SantaChatReadCursor_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SantaCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SantaChatReadCursor" ADD CONSTRAINT "SantaChatReadCursor_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "SantaParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SantaPoll" ADD CONSTRAINT "SantaPoll_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "SantaRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SantaPollVote" ADD CONSTRAINT "SantaPollVote_pollId_fkey" FOREIGN KEY ("pollId") REFERENCES "SantaPoll"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SantaPollVote" ADD CONSTRAINT "SantaPollVote_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "SantaParticipant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SantaNotification" ADD CONSTRAINT "SantaNotification_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SantaCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SantaNotification" ADD CONSTRAINT "SantaNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SantaAdminAuditLog" ADD CONSTRAINT "SantaAdminAuditLog_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "SantaCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
