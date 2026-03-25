-- CreateEnum
CREATE TYPE "PromoRedemptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'ACCEPTED_FOR_PAID', 'FAILED');

-- CreateEnum
CREATE TYPE "DegradationPhase" AS ENUM ('NONE', 'GRACE_PERIOD', 'ARCHIVED', 'PURGED');

-- CreateTable
CREATE TABLE "PromoCampaign" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "rewardType" TEXT NOT NULL DEFAULT 'promo_pro',
    "durationDays" INTEGER NOT NULL DEFAULT 30,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "maxRedemptions" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromoRedemption" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "status" "PromoRedemptionStatus" NOT NULL DEFAULT 'PENDING',
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "source" TEXT DEFAULT 'miniapp',
    "reminder3dSent" BOOLEAN NOT NULL DEFAULT false,
    "reminderExpSent" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromoRedemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DegradationState" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phase" "DegradationPhase" NOT NULL DEFAULT 'NONE',
    "graceEndsAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "purgeScheduledAt" TIMESTAMP(3),
    "archivedWishlistIds" TEXT,
    "archivedItemIds" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DegradationState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromoCampaign_code_key" ON "PromoCampaign"("code");

-- CreateIndex
CREATE INDEX "PromoRedemption_userId_idx" ON "PromoRedemption"("userId");

-- CreateIndex
CREATE INDEX "PromoRedemption_status_idx" ON "PromoRedemption"("status");

-- CreateIndex
CREATE INDEX "PromoRedemption_expiresAt_idx" ON "PromoRedemption"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PromoRedemption_userId_campaignId_key" ON "PromoRedemption"("userId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "DegradationState_userId_key" ON "DegradationState"("userId");

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromoRedemption" ADD CONSTRAINT "PromoRedemption_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "PromoCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DegradationState" ADD CONSTRAINT "DegradationState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed WISHPRO campaign
INSERT INTO "PromoCampaign" ("id", "code", "rewardType", "durationDays", "isActive", "createdAt", "updatedAt")
VALUES ('promo_wishpro', 'WISHPRO', 'promo_pro', 30, true, NOW(), NOW());
