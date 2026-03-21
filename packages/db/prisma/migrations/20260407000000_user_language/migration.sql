-- Migration: 20260407000000_user_language
-- Adds persisted language preference to UserProfile (nullable; null = use Telegram language_code)

ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "language" TEXT;
