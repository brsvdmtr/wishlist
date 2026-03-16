-- Add position column to Item for manual per-priority reordering
ALTER TABLE "Item" ADD COLUMN "position" INTEGER NOT NULL DEFAULT 0;

-- Backfill: assign positions 0..N-1 per (wishlistId, priority) group
-- ordered by current sort: updatedAt DESC, createdAt DESC, id DESC
WITH numbered AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "wishlistId", "priority"
      ORDER BY "updatedAt" DESC, "createdAt" DESC, id DESC
    ) - 1 AS new_pos
  FROM "Item"
)
UPDATE "Item"
SET position = numbered.new_pos
FROM numbered
WHERE "Item".id = numbered.id;

-- Index for efficient ordered queries per wishlist per priority
CREATE INDEX "Item_wishlistId_priority_position_idx"
  ON "Item"("wishlistId", "priority", "position");
