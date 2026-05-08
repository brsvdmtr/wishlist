-- Capture additional Telegram identity fields on User. Backfill is handled
-- opportunistically by the auth middleware (Mini App) and bot /start handler;
-- no data backfill is required here.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "lastName" TEXT,
  ADD COLUMN IF NOT EXISTS "username" TEXT,
  ADD COLUMN IF NOT EXISTS "isPremium" BOOLEAN NOT NULL DEFAULT false;
