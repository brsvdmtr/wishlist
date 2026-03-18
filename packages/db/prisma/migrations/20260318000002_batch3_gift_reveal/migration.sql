-- Batch 3: Gift Flow Finalization & Reveal
--
-- Changes:
-- 1. SantaGiftStatus enum: add SELECTED_FROM_WISHLIST, SELECTED_OUTSIDE,
--    DECLINED_TO_SAY, MISSED_DEADLINE (keep BUYING as legacy)
-- 2. SantaNotificationType enum: add GIFT_RECEIVED, REVEAL_UNLOCKED,
--    DEADLINE_WARNING, DEADLINE_MISSED
-- 3. SantaAssignment: add revealedAt column
--
-- PostgreSQL 12+ supports ALTER TYPE ... ADD VALUE inside transactions.
-- These statements MUST run before any DML that uses the new values.

-- ─── 1. Expand SantaGiftStatus ────────────────────────────────────────────────

ALTER TYPE "SantaGiftStatus" ADD VALUE IF NOT EXISTS 'SELECTED_FROM_WISHLIST';
ALTER TYPE "SantaGiftStatus" ADD VALUE IF NOT EXISTS 'SELECTED_OUTSIDE';
ALTER TYPE "SantaGiftStatus" ADD VALUE IF NOT EXISTS 'DECLINED_TO_SAY';
ALTER TYPE "SantaGiftStatus" ADD VALUE IF NOT EXISTS 'MISSED_DEADLINE';

-- ─── 2. Expand SantaNotificationType ─────────────────────────────────────────

ALTER TYPE "SantaNotificationType" ADD VALUE IF NOT EXISTS 'GIFT_RECEIVED';
ALTER TYPE "SantaNotificationType" ADD VALUE IF NOT EXISTS 'REVEAL_UNLOCKED';
ALTER TYPE "SantaNotificationType" ADD VALUE IF NOT EXISTS 'DEADLINE_WARNING';
ALTER TYPE "SantaNotificationType" ADD VALUE IF NOT EXISTS 'DEADLINE_MISSED';

-- ─── 3. Add revealedAt to SantaAssignment ────────────────────────────────────
-- Nullable: set on first reveal view by receiver. Never exposed cross-party.

ALTER TABLE "SantaAssignment"
  ADD COLUMN IF NOT EXISTS "revealedAt" TIMESTAMP(3);
