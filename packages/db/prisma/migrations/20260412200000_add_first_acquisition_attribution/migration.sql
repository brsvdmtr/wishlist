-- Add first-touch acquisition attribution fields to UserProfile
-- These are nullable and only set once (first-touch, never overwritten)
ALTER TABLE "UserProfile"
  ADD COLUMN "firstAcquisitionSource"   TEXT,
  ADD COLUMN "firstAcquisitionMedium"   TEXT,
  ADD COLUMN "firstAcquisitionCampaign" TEXT,
  ADD COLUMN "firstAcquisitionRef"      TEXT,
  ADD COLUMN "firstAcquisitionAt"       TIMESTAMPTZ;
