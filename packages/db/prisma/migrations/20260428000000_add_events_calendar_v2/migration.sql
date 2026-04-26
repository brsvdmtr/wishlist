-- ═══════════════════════════════════════════════════════════════════════════
-- Events Calendar v2.1 — schema extension
--   * extend GiftOccasion with: emoji, eventTime, location, budget*,
--     source, holidayKey, country, linked* FKs, year-recap fields
--   * new model GiftOccasionReminder  (per-event schedule)
--   * new model Holiday               (country holiday catalog)
--   * new model CalendarInboxEntry    (in-app notifications)
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── 1. Extend GiftOccasion ───
ALTER TABLE "GiftOccasion"
  ADD COLUMN "emoji"              TEXT,
  ADD COLUMN "eventTime"          TEXT,
  ADD COLUMN "location"           TEXT,
  ADD COLUMN "budgetMin"          INTEGER,
  ADD COLUMN "budgetMax"          INTEGER,
  ADD COLUMN "budgetCurrency"     TEXT,
  ADD COLUMN "source"             TEXT NOT NULL DEFAULT 'USER',
  ADD COLUMN "holidayKey"         TEXT,
  ADD COLUMN "country"            TEXT,
  ADD COLUMN "linkedUserId"       TEXT,
  ADD COLUMN "linkedWishlistId"   TEXT,
  ADD COLUMN "linkedSantaId"      TEXT,
  ADD COLUMN "actualGiftText"     TEXT,
  ADD COLUMN "actualGiftAmount"   INTEGER,
  ADD COLUMN "actualGiftCurrency" TEXT,
  ADD COLUMN "thankYouNote"       TEXT,
  ADD COLUMN "thankYouAt"         TIMESTAMP(3);

CREATE INDEX "GiftOccasion_ownerUserId_eventDate_idx"
  ON "GiftOccasion"("ownerUserId", "eventDate");
CREATE INDEX "GiftOccasion_linkedUserId_idx"
  ON "GiftOccasion"("linkedUserId");
CREATE INDEX "GiftOccasion_linkedWishlistId_idx"
  ON "GiftOccasion"("linkedWishlistId");
CREATE INDEX "GiftOccasion_linkedSantaId_idx"
  ON "GiftOccasion"("linkedSantaId");

-- One imported holiday per owner (NULL holidayKey rows ignored by Postgres).
CREATE UNIQUE INDEX "GiftOccasion_ownerUserId_holidayKey_key"
  ON "GiftOccasion"("ownerUserId", "holidayKey");

ALTER TABLE "GiftOccasion"
  ADD CONSTRAINT "GiftOccasion_linkedUserId_fkey"
    FOREIGN KEY ("linkedUserId") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "GiftOccasion_linkedWishlistId_fkey"
    FOREIGN KEY ("linkedWishlistId") REFERENCES "Wishlist"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "GiftOccasion_linkedSantaId_fkey"
    FOREIGN KEY ("linkedSantaId") REFERENCES "SantaCampaign"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── 2. GiftOccasionReminder ───
CREATE TABLE "GiftOccasionReminder" (
  "id"           TEXT NOT NULL,
  "occasionId"   TEXT NOT NULL,
  "ownerUserId"  TEXT NOT NULL,
  "offsetDays"   INTEGER NOT NULL,
  "timeOfDay"    TEXT NOT NULL DEFAULT '10:00',
  "enabled"      BOOLEAN NOT NULL DEFAULT true,
  "scheduledFor" TIMESTAMP(3),
  "sentAt"       TIMESTAMP(3),
  "delivered"    BOOLEAN NOT NULL DEFAULT false,
  "episodeKey"   TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GiftOccasionReminder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GiftOccasionReminder_episodeKey_key"
  ON "GiftOccasionReminder"("episodeKey");
CREATE INDEX "GiftOccasionReminder_occasionId_idx"
  ON "GiftOccasionReminder"("occasionId");
CREATE INDEX "GiftOccasionReminder_ownerUserId_idx"
  ON "GiftOccasionReminder"("ownerUserId");
CREATE INDEX "GiftOccasionReminder_scheduledFor_sentAt_enabled_idx"
  ON "GiftOccasionReminder"("scheduledFor", "sentAt", "enabled");

ALTER TABLE "GiftOccasionReminder"
  ADD CONSTRAINT "GiftOccasionReminder_occasionId_fkey"
    FOREIGN KEY ("occasionId") REFERENCES "GiftOccasion"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "GiftOccasionReminder_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 3. Holiday catalog ───
CREATE TABLE "Holiday" (
  "id"        TEXT NOT NULL,
  "country"   TEXT NOT NULL,
  "month"     INTEGER NOT NULL,
  "day"       INTEGER NOT NULL,
  "key"       TEXT NOT NULL,
  "emoji"     TEXT NOT NULL,
  "category"  TEXT NOT NULL DEFAULT 'NATIONAL',
  "nameRu"    TEXT,
  "nameEn"    TEXT,
  "nameZhCn"  TEXT,
  "nameHi"    TEXT,
  "nameEs"    TEXT,
  "nameAr"    TEXT,
  "ordinal"   INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Holiday_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Holiday_key_key" ON "Holiday"("key");
CREATE INDEX "Holiday_country_idx" ON "Holiday"("country");
CREATE INDEX "Holiday_country_month_day_idx" ON "Holiday"("country", "month", "day");

-- ─── 4. CalendarInboxEntry ───
CREATE TABLE "CalendarInboxEntry" (
  "id"          TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "occasionId"  TEXT,
  "type"        TEXT NOT NULL,
  "emoji"       TEXT NOT NULL,
  "title"       TEXT NOT NULL,
  "body"        TEXT,
  "readAt"      TIMESTAMP(3),
  "archivedAt"  TIMESTAMP(3),
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CalendarInboxEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CalendarInboxEntry_ownerUserId_readAt_idx"
  ON "CalendarInboxEntry"("ownerUserId", "readAt");
CREATE INDEX "CalendarInboxEntry_ownerUserId_createdAt_idx"
  ON "CalendarInboxEntry"("ownerUserId", "createdAt");
CREATE INDEX "CalendarInboxEntry_occasionId_idx"
  ON "CalendarInboxEntry"("occasionId");

ALTER TABLE "CalendarInboxEntry"
  ADD CONSTRAINT "CalendarInboxEntry_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CalendarInboxEntry_occasionId_fkey"
    FOREIGN KEY ("occasionId") REFERENCES "GiftOccasion"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
