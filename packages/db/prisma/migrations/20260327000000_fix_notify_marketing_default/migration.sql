-- Fix notifyMarketing default: should be true (all notifications ON for new users)
-- The previous default of false was incorrect — FREE users should receive marketing
-- notifications by default, and only PRO users can opt out.

-- 1. Change column default to true for all new rows
ALTER TABLE "UserProfile" ALTER COLUMN "notifyMarketing" SET DEFAULT true;

-- 2. Reset existing rows that have false (they inherited the wrong default, never
--    explicitly opted out — no UI existed to make this choice)
UPDATE "UserProfile" SET "notifyMarketing" = true WHERE "notifyMarketing" = false;
