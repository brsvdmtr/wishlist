-- Migration: 20260406000000_currency_gbp_eur
-- Adds GBP and EUR to the Currency enum (required for global onboarding demo cards)

ALTER TYPE "Currency" ADD VALUE IF NOT EXISTS 'EUR';
ALTER TYPE "Currency" ADD VALUE IF NOT EXISTS 'GBP';
