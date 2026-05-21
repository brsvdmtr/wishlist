-- NOTE: ItemStatus 'COMPLETED' and 'DELETED' are added by the earlier migration
-- 20260301000000_add_completed_deleted_statuses. They were duplicated here
-- originally, which broke from-scratch `prisma migrate deploy` (Postgres 42710
-- "enum label already exists"). The redundant ALTER TYPE lines were removed so
-- the migration history replays cleanly on a new database. See BUGFIX_LESSONS
-- 2026-05-21. Already-applied databases are unaffected (this migration is not
-- re-run); the checksum drift is benign for `migrate deploy`.

-- AlterTable
ALTER TABLE "Wishlist" ADD COLUMN "deadline" TIMESTAMP(3);
