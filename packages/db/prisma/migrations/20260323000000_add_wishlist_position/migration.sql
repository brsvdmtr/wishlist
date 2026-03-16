-- Add position column to Wishlist for manual reorder support
ALTER TABLE "Wishlist" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

-- Backfill: assign positions 0..N-1 per owner based on createdAt ASC
-- This preserves the natural order users already see (oldest first)
WITH numbered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (PARTITION BY "ownerId" ORDER BY "createdAt" ASC, id ASC) - 1 AS new_pos
  FROM "Wishlist"
)
UPDATE "Wishlist"
SET position = numbered.new_pos
FROM numbered
WHERE "Wishlist".id = numbered.id;

-- Create compound index for efficient ordered queries per owner
CREATE INDEX "Wishlist_ownerId_position_idx" ON "Wishlist"("ownerId", "position");
