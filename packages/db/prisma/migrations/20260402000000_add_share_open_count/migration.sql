-- Add share link open tracking counter to Wishlist.
-- Incremented fire-and-forget each time GET /public/share/:token is called.
-- Enables honest "Opened shared link" funnel metric vs. intent-only "opened share screen".
ALTER TABLE "Wishlist" ADD COLUMN IF NOT EXISTS "shareOpenCount" INTEGER NOT NULL DEFAULT 0;
