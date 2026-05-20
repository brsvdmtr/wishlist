-- ═══════════════════════════════════════════════════════════════════════════
-- UserCredits — monthly free-tier URL-import quota
--
-- URL import moves from a hard PRO gate to a credit-based model: FREE users
-- get N imports per UTC calendar month (default 5, env
-- FREE_IMPORT_QUOTA_PER_MONTH), PRO stays unlimited, and paid import_pack_*
-- credits (importCredits) top up beyond the free allowance.
--
--   • freeImportsUsed   — imports consumed in the current month bucket.
--   • freeImportsPeriod — the "YYYY-MM" UTC bucket the counter belongs to;
--     NULL until the user's first free import. consumeImportCredit() lazily
--     resets freeImportsUsed to 0 when the stored bucket != current month,
--     so no scheduler is needed.
--
-- Both columns are additive and non-blocking: NOT NULL + constant DEFAULT for
-- the counter, plain nullable TEXT for the bucket. No backfill, no index —
-- all access is by the existing UserCredits.userId unique key.
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE "UserCredits" ADD COLUMN "freeImportsUsed" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "UserCredits" ADD COLUMN "freeImportsPeriod" TEXT;
