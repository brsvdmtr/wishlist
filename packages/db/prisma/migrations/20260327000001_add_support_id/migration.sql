-- Add privacy-safe Support ID to UserProfile.
-- Nullable: existing rows start with NULL; lazy generation fills them in
-- on first profile/settings read (handled in application layer).
-- New users get supportId generated at profile creation time.

ALTER TABLE "UserProfile" ADD COLUMN "supportId" TEXT;

CREATE UNIQUE INDEX "UserProfile_supportId_key" ON "UserProfile"("supportId");
