-- Batch 4 hotfix: Replace over-broad notification dedup index with dedupeKey approach.
--
-- The original partial unique index on (campaignId, userId, type) was too coarse:
--   - DRAW_DONE: can fire once per *round*, not once per campaign
--   - GIFT_RECEIVED / REVEAL_UNLOCKED: once per *assignment*, not once per campaign
--
-- New strategy: add an explicit `dedupeKey` column.
-- When set (non-null), uniqueness is enforced per (userId, type, dedupeKey).
-- When null, no dedup — multiple notifications of the same type are allowed
-- (e.g., CHAT_MESSAGE, POLL_CREATED, JOINED).
--
-- dedupeKey conventions (enforced in application code):
--   DRAW_DONE          → 'draw:{roundId}'
--   GIFT_RECEIVED      → 'gift:{assignmentId}'
--   REVEAL_UNLOCKED    → 'reveal:{assignmentId}'
--   CAMPAIGN_CANCELLED → 'cancel:{campaignId}'
--   DEADLINE_MISSED    → 'missed:{assignmentId}'
--   DEADLINE_WARNING   → 'warn:{assignmentId}'
--   all others         → NULL (no dedup)

-- 1. Drop the over-broad index from migration 000005
DROP INDEX IF EXISTS "SantaNotification_campaign_user_type_key";

-- 2. Add dedupeKey column (nullable; null = no dedup)
ALTER TABLE "SantaNotification" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;

-- 3. Partial unique index: enforced only when dedupeKey IS NOT NULL.
--    PostgreSQL treats NULLs as distinct, so rows with dedupeKey=NULL never conflict.
CREATE UNIQUE INDEX IF NOT EXISTS "SantaNotification_user_type_dedupekey_key"
  ON "SantaNotification"("userId", "type", "dedupeKey")
  WHERE "dedupeKey" IS NOT NULL;
