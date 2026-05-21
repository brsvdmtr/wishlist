-- Reconcile the migration history with schema.prisma.
--
-- Surfaced 2026-05-21: once a from-scratch `migrate deploy` replayed cleanly it
-- could finally be diffed against schema.prisma, exposing drift that both
-- `prisma generate` and CI's `db push` (each schema-driven) silently absorbed.
-- Prod runs the migration-history shape, so this is the first time prod
-- receives these changes. Every target is a small table (UserProfile 297 rows,
-- SantaPoll 2 rows as of 2026-05-21) — sub-second, negligible locks.

-- DropForeignKey
ALTER TABLE "SantaPoll" DROP CONSTRAINT "SantaPoll_roundId_fkey";

-- DropIndex
-- roundId was SantaPoll's original scoping field; campaignId replaced it in
-- 20260318000004_batch4_polls. schema.prisma keeps only @@index([campaignId]).
DROP INDEX "SantaPoll_roundId_idx";

-- AlterTable
ALTER TABLE "SantaExclusionGroup" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "SantaGlobalConfig" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
-- campaignId got DEFAULT '' as a batch4_polls backfill placeholder; '' is not a
-- valid SantaCampaign id, so the default could only ever violate the FK.
ALTER TABLE "SantaPoll" ALTER COLUMN "campaignId" DROP DEFAULT;

-- AlterTable
ALTER TABLE "UserOnboardingState" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
-- firstAcquisitionAt was created TIMESTAMPTZ; schema.prisma maps DateTime to
-- TIMESTAMP(3). The explicit `USING ... AT TIME ZONE 'UTC'` keeps the
-- conversion deterministic — a bare cast resolves against the session TimeZone
-- and would shift values on a non-UTC server. The column holds UTC instants.
ALTER TABLE "UserProfile" ALTER COLUMN "firstAcquisitionAt" SET DATA TYPE TIMESTAMP(3) USING "firstAcquisitionAt" AT TIME ZONE 'UTC';

-- AddForeignKey
-- CASCADE -> SET NULL: roundId has been nullable since batch4_polls and a poll
-- is campaign-scoped, so deleting a round should null the link, not the poll.
-- No santaRound hard-delete path exists in app code — dormant action today.
ALTER TABLE "SantaPoll" ADD CONSTRAINT "SantaPoll_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "SantaRound"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "BirthdayReminderDelivery_unique" RENAME TO "BirthdayReminderDelivery_birthdayUserId_recipientUserId_occ_key";

-- RenameIndex
ALTER INDEX "BirthdayReminderMute_unique" RENAME TO "BirthdayReminderMute_userId_mutedBirthdayUserId_key";

-- RenameIndex
ALTER INDEX "CuratedSelectionSubscription_curatedSelectionId_subscriberId_ke" RENAME TO "CuratedSelectionSubscription_curatedSelectionId_subscriberI_key";
