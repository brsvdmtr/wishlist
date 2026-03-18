-- Batch 4.3: Notification Hardening
-- Adds a partial unique index on SantaNotification for single-instance
-- notification types to prevent duplicates at the DB level.
-- These types are semantically one-per-campaign-per-user events.

CREATE UNIQUE INDEX IF NOT EXISTS "SantaNotification_campaign_user_type_key"
  ON "SantaNotification"("campaignId", "userId", "type")
  WHERE "type" IN ('DRAW_DONE', 'CAMPAIGN_CANCELLED', 'REVEAL_UNLOCKED', 'GIFT_RECEIVED');
