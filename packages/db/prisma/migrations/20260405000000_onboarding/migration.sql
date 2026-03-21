-- Migration: 20260405000000_onboarding
-- Adds onboarding engine: item origin fields, UserOnboardingState, AnalyticsEvent.props

-- 1. New enums
CREATE TYPE "ItemOriginType" AS ENUM ('MANUAL', 'IMPORTED', 'DEMO');
CREATE TYPE "OnboardingStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'DISMISSED');

-- 2. Item: new origin + demo fields
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "isDemo"           BOOLEAN          NOT NULL DEFAULT FALSE;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "originType"       "ItemOriginType"  NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "originVariantKey" TEXT;
ALTER TABLE "Item" ADD COLUMN IF NOT EXISTS "becameRealAt"     TIMESTAMP(3);

-- 3. AnalyticsEvent: add props column for god-mode queries
ALTER TABLE "AnalyticsEvent" ADD COLUMN IF NOT EXISTS "props" JSONB;

-- 4. UserOnboardingState table
CREATE TABLE "UserOnboardingState" (
  "id"               TEXT             NOT NULL,
  "userId"           TEXT             NOT NULL,
  "onboardingKey"    TEXT             NOT NULL,
  "version"          INTEGER          NOT NULL,
  "status"           "OnboardingStatus" NOT NULL DEFAULT 'NOT_STARTED',
  "variantKey"       TEXT,
  "entryPoint"       TEXT,
  "demoItemId"       TEXT,
  "completionReason" TEXT,
  "metaJson"         JSONB,
  "startedAt"        TIMESTAMP(3),
  "completedAt"      TIMESTAMP(3),
  "dismissedAt"      TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3)     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserOnboardingState_pkey" PRIMARY KEY ("id")
);

-- 5. Unique + index on UserOnboardingState
CREATE UNIQUE INDEX "UserOnboardingState_userId_onboardingKey_version_key"
  ON "UserOnboardingState"("userId", "onboardingKey", "version");

CREATE INDEX "UserOnboardingState_userId_idx"
  ON "UserOnboardingState"("userId");

-- 6. FK: UserOnboardingState.userId → User.id (cascade delete)
ALTER TABLE "UserOnboardingState"
  ADD CONSTRAINT "UserOnboardingState_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
