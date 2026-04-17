-- CreateEnum
CREATE TYPE "ReferralAttributionStatus" AS ENUM (
    'ATTRIBUTED',
    'PENDING_ACTIVATION',
    'QUALIFIED',
    'REWARDED',
    'REJECTED',
    'FRAUD_REVIEW'
);

-- CreateEnum
CREATE TYPE "ReferralRejectReason" AS ENUM (
    'INVITEE_NOT_NEW_USER',
    'INVITEE_HAD_PRIOR_DIALOG',
    'INVITEE_HAD_PRIOR_WISHLIST',
    'INVITEE_HAD_PRIOR_ITEM',
    'INVITEE_ALREADY_ATTRIBUTED',
    'SELF_REFERRAL_DETECTED',
    'REWARD_CAP_REACHED',
    'QUALIFICATION_TIMEOUT',
    'PROGRAM_DISABLED',
    'SYSTEM_CONFLICT',
    'FRAUD_REJECTED',
    'INVITER_BANNED',
    'INVITER_DELETED'
);

-- CreateEnum
CREATE TYPE "ReferralRewardStatus" AS ENUM (
    'GRANTED',
    'REVOKED'
);

-- AlterTable: UserProfile — referral fields
ALTER TABLE "UserProfile"
    ADD COLUMN "referralCode"          TEXT,
    ADD COLUMN "referralCodeCreatedAt" TIMESTAMP(3),
    ADD COLUMN "referredByUserId"      TEXT,
    ADD COLUMN "referredAt"             TIMESTAMP(3),
    ADD COLUMN "firstBotStartAt"        TIMESTAMP(3),
    ADD COLUMN "firstWishlistAt"        TIMESTAMP(3),
    ADD COLUMN "firstItemAt"            TIMESTAMP(3);

-- CreateIndex (unique) for referralCode
CREATE UNIQUE INDEX "UserProfile_referralCode_key" ON "UserProfile"("referralCode");

-- CreateTable: ReferralAttribution
CREATE TABLE "ReferralAttribution" (
    "id"                     TEXT NOT NULL,
    "inviterUserId"          TEXT NOT NULL,
    "invitedUserId"          TEXT NOT NULL,
    "referralCode"           TEXT NOT NULL,
    "source"                 TEXT NOT NULL DEFAULT 'telegram',
    "status"                 "ReferralAttributionStatus" NOT NULL DEFAULT 'PENDING_ACTIVATION',
    "rejectReason"           "ReferralRejectReason",
    "attributedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "qualifiedAt"            TIMESTAMP(3),
    "rewardedAt"             TIMESTAMP(3),
    "rejectedAt"             TIMESTAMP(3),
    "windowDeadlineAt"       TIMESTAMP(3) NOT NULL,
    "fraudScore"             INTEGER NOT NULL DEFAULT 0,
    "triggeredSignals"       JSONB,
    "configVersion"          TEXT,
    "configSnapshot"         JSONB,
    "ipHash"                 TEXT,
    "deviceFingerprintHash"  TEXT,
    "timezone"               TEXT,
    "locale"                 TEXT,
    "telegramClient"         TEXT,
    "platform"               TEXT,
    "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"              TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralAttribution_invitedUserId_key" ON "ReferralAttribution"("invitedUserId");
CREATE INDEX "ReferralAttribution_inviterUserId_status_idx" ON "ReferralAttribution"("inviterUserId", "status");
CREATE INDEX "ReferralAttribution_referralCode_idx" ON "ReferralAttribution"("referralCode");
CREATE INDEX "ReferralAttribution_status_windowDeadlineAt_idx" ON "ReferralAttribution"("status", "windowDeadlineAt");
CREATE INDEX "ReferralAttribution_status_fraudScore_idx" ON "ReferralAttribution"("status", "fraudScore");
CREATE INDEX "ReferralAttribution_ipHash_idx" ON "ReferralAttribution"("ipHash");
CREATE INDEX "ReferralAttribution_deviceFingerprintHash_idx" ON "ReferralAttribution"("deviceFingerprintHash");
CREATE INDEX "ReferralAttribution_createdAt_idx" ON "ReferralAttribution"("createdAt");

-- AddForeignKey
ALTER TABLE "ReferralAttribution" ADD CONSTRAINT "ReferralAttribution_inviterUserId_fkey"
    FOREIGN KEY ("inviterUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralAttribution" ADD CONSTRAINT "ReferralAttribution_invitedUserId_fkey"
    FOREIGN KEY ("invitedUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable: ReferralReward
CREATE TABLE "ReferralReward" (
    "id"                TEXT NOT NULL,
    "userId"            TEXT NOT NULL,
    "attributionId"     TEXT,
    "rewardType"        TEXT NOT NULL DEFAULT 'pro_days',
    "rewardValueDays"   INTEGER NOT NULL,
    "status"            "ReferralRewardStatus" NOT NULL DEFAULT 'GRANTED',
    "grantStrategy"     TEXT NOT NULL DEFAULT 'stack',
    "previousExpiryAt"  TIMESTAMP(3),
    "newExpiryAt"       TIMESTAMP(3),
    "idempotencyKey"    TEXT NOT NULL,
    "grantedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt"         TIMESTAMP(3),
    "revokedReason"     TEXT,
    "grantedByAdminId"  TEXT,
    "revokedByAdminId"  TEXT,

    CONSTRAINT "ReferralReward_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralReward_idempotencyKey_key" ON "ReferralReward"("idempotencyKey");
CREATE INDEX "ReferralReward_userId_status_idx" ON "ReferralReward"("userId", "status");
CREATE INDEX "ReferralReward_attributionId_idx" ON "ReferralReward"("attributionId");
CREATE INDEX "ReferralReward_grantedAt_idx" ON "ReferralReward"("grantedAt");

-- AddForeignKey
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralReward" ADD CONSTRAINT "ReferralReward_attributionId_fkey"
    FOREIGN KEY ("attributionId") REFERENCES "ReferralAttribution"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable: ReferralProgramConfig (singleton)
CREATE TABLE "ReferralProgramConfig" (
    "id"                        TEXT NOT NULL DEFAULT 'default',
    "enabled"                   BOOLEAN NOT NULL DEFAULT false,
    "rewardDaysInviter"         INTEGER NOT NULL DEFAULT 30,
    "grantStrategy"             TEXT NOT NULL DEFAULT 'stack',
    "requireWishlist"           BOOLEAN NOT NULL DEFAULT true,
    "requireItem"               BOOLEAN NOT NULL DEFAULT true,
    "qualificationWindowDays"   INTEGER NOT NULL DEFAULT 14,
    "monthlyRewardCap"          INTEGER NOT NULL DEFAULT 3,
    "yearlyRewardCap"           INTEGER NOT NULL DEFAULT 12,
    "fraudAutoRejectThreshold"  INTEGER NOT NULL DEFAULT 80,
    "fraudReviewThreshold"      INTEGER NOT NULL DEFAULT 40,
    "fraudReviewEnabled"        BOOLEAN NOT NULL DEFAULT true,
    "fraudSignalWeights"        JSONB NOT NULL DEFAULT '{"ip_cluster":30,"device_fingerprint":25,"velocity":20,"inactive_invitee":15,"same_tz_cluster":10,"self_referral":100,"suspicious_onboarding":25,"account_age_delta":20}',
    "showInviteeNamesInUi"      BOOLEAN NOT NULL DEFAULT false,
    "entryPointProfile"         BOOLEAN NOT NULL DEFAULT true,
    "entryPointPaywall"         BOOLEAN NOT NULL DEFAULT true,
    "entryPointHomeBanner"      BOOLEAN NOT NULL DEFAULT true,
    "entryPointPostShare"       BOOLEAN NOT NULL DEFAULT true,
    "notifyInviterArrival"      BOOLEAN NOT NULL DEFAULT true,
    "notifyInviterStepProgress" BOOLEAN NOT NULL DEFAULT false,
    "notifyInviterReward"       BOOLEAN NOT NULL DEFAULT true,
    "notifyInviteeWelcome"      BOOLEAN NOT NULL DEFAULT false,
    "rolloutPercent"            INTEGER NOT NULL DEFAULT 10,
    "configVersion"             TEXT NOT NULL DEFAULT 'v1',
    "updatedAt"                 TIMESTAMP(3) NOT NULL,
    "updatedByAdminId"          TEXT,

    CONSTRAINT "ReferralProgramConfig_pkey" PRIMARY KEY ("id")
);

-- Seed default config row so app never has to handle "config row missing"
INSERT INTO "ReferralProgramConfig" ("id", "updatedAt") VALUES ('default', CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO NOTHING;
