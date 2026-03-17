-- Add avatar thumbnail, update timestamp, and visibility flag to UserProfile.
-- All columns are nullable/have defaults — safe for zero-downtime deploy.

ALTER TABLE "UserProfile" ADD COLUMN "avatarThumbUrl"  TEXT;
ALTER TABLE "UserProfile" ADD COLUMN "avatarUpdatedAt" TIMESTAMP(3);
ALTER TABLE "UserProfile" ADD COLUMN "avatarPublic"    BOOLEAN NOT NULL DEFAULT true;
