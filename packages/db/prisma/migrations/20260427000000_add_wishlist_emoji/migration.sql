-- Optional user-chosen emoji shown next to the wishlist title.
-- When NULL, frontend falls back to a hash-derived auto-pick from `title`.
ALTER TABLE "Wishlist" ADD COLUMN "emoji" TEXT;
