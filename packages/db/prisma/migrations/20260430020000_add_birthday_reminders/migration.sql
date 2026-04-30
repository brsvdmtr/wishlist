-- ═══════════════════════════════════════════════════════════════════════════
-- Birthday Reminders — social notifications for own birthday
--
-- 1. Extend UserProfile with birthday-reminder settings + receiver preference.
-- 2. New model BirthdayReminderDelivery — one row per (birthdayUser, recipient,
--    occurrenceKey, reminderKind). Unique constraint dedups across scheduler runs.
-- 3. New model BirthdayReminderMute — per-recipient mute of a specific birthday user.
--
-- Defaults (rollout-safe):
--   notifyBirthdays                = true   (receivers get reminders by default;
--                                            opt-out via Settings → Notifications)
--   birthdayFriendReminders        = false  (existing users with birthday set
--                                            do NOT auto-broadcast — must opt in
--                                            via post-save sheet first)
--   birthdayOwnerReminders         = true   (gentle nudge to update own wishlist)
--   birthdayAudience               = 'SUBSCRIBERS'
--   birthdayAdvancedWindowsEnabled = false  (Pro-only flag)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Extend UserProfile ───
ALTER TABLE "UserProfile"
  ADD COLUMN "notifyBirthdays"                BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "birthdayFriendReminders"        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "birthdayOwnerReminders"         BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "birthdayAudience"               TEXT    NOT NULL DEFAULT 'SUBSCRIBERS',
  ADD COLUMN "birthdayAdvancedWindowsEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "birthdayPrimaryWishlistId"      TEXT,
  ADD COLUMN "birthdayCustomMessage"          VARCHAR(200),
  ADD COLUMN "birthdayOptInPromptSeenAt"      TIMESTAMP(3);

-- ─── 2. BirthdayReminderDelivery ───
CREATE TABLE "BirthdayReminderDelivery" (
  "id"                 TEXT NOT NULL,
  "birthdayUserId"     TEXT NOT NULL,
  "recipientUserId"    TEXT NOT NULL,
  "occurrenceKey"      TEXT NOT NULL,
  "reminderKind"       TEXT NOT NULL,
  "status"             TEXT NOT NULL DEFAULT 'pending',
  "skipReason"         TEXT,
  "failureReason"      TEXT,
  "deferredUntil"      TIMESTAMP(3),
  "telegramMessageId"  INTEGER,
  "targetType"         TEXT,
  "targetId"           TEXT,
  "deepLinkPayload"    TEXT,
  "relationType"       TEXT,
  "sentAt"             TIMESTAMP(3),
  "clickedAt"          TIMESTAMP(3),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,

  CONSTRAINT "BirthdayReminderDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BirthdayReminderDelivery_unique"
  ON "BirthdayReminderDelivery"("birthdayUserId", "recipientUserId", "occurrenceKey", "reminderKind");

CREATE INDEX "BirthdayReminderDelivery_status_deferredUntil_idx"
  ON "BirthdayReminderDelivery"("status", "deferredUntil");

CREATE INDEX "BirthdayReminderDelivery_recipientUserId_sentAt_idx"
  ON "BirthdayReminderDelivery"("recipientUserId", "sentAt");

CREATE INDEX "BirthdayReminderDelivery_birthdayUserId_occurrenceKey_idx"
  ON "BirthdayReminderDelivery"("birthdayUserId", "occurrenceKey");

CREATE INDEX "BirthdayReminderDelivery_sentAt_idx"
  ON "BirthdayReminderDelivery"("sentAt");

CREATE INDEX "BirthdayReminderDelivery_createdAt_idx"
  ON "BirthdayReminderDelivery"("createdAt");

ALTER TABLE "BirthdayReminderDelivery"
  ADD CONSTRAINT "BirthdayReminderDelivery_birthdayUserId_fkey"
    FOREIGN KEY ("birthdayUserId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "BirthdayReminderDelivery_recipientUserId_fkey"
    FOREIGN KEY ("recipientUserId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 3. BirthdayReminderMute ───
CREATE TABLE "BirthdayReminderMute" (
  "id"                  TEXT NOT NULL,
  "userId"              TEXT NOT NULL,
  "mutedBirthdayUserId" TEXT NOT NULL,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "BirthdayReminderMute_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BirthdayReminderMute_unique"
  ON "BirthdayReminderMute"("userId", "mutedBirthdayUserId");

CREATE INDEX "BirthdayReminderMute_userId_idx"
  ON "BirthdayReminderMute"("userId");

ALTER TABLE "BirthdayReminderMute"
  ADD CONSTRAINT "BirthdayReminderMute_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "BirthdayReminderMute_mutedBirthdayUserId_fkey"
    FOREIGN KEY ("mutedBirthdayUserId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
