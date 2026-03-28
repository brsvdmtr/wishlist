-- Fix: add missing note column to GiftOccasion
ALTER TABLE "GiftOccasion" ADD COLUMN IF NOT EXISTS "note" TEXT;
