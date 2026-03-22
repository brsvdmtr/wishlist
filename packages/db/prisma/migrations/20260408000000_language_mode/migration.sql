-- Migration: 20260408000000_language_mode
-- Adds languageMode ('auto'|'manual') and manualLanguage fields to UserProfile.
-- All existing users default to languageMode='auto', manualLanguage=NULL —
-- meaning their effective locale is always derived from Telegram language_code,
-- never from the legacy `language` field.

ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "languageMode" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "UserProfile" ADD COLUMN IF NOT EXISTS "manualLanguage" TEXT;
