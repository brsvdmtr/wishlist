-- ═══════════════════════════════════════════════════════════════════════════
-- UserDailyActivity — per-user daily product-loop rollup
--
-- AnalyticsEvent has a 90-day TTL, so D60/D90 cohorts and any long-window
-- retention/funnel query can't be answered off the raw event log past that
-- horizon. This table is the durable aggregate: one row per (userId,
-- UTC calendar day), 13 counter columns covering the core loop signals.
--
-- Counters are computed from AnalyticsEvent by aggregator
-- (apps/api/src/services/daily-activity.service.ts). The hourly scheduler
-- re-aggregates yesterday + today every run, upserting by the composite
-- primary key (userId, date) — idempotent by construction. Backfill script
-- reuses the same aggregator over a date range.
--
-- Counter semantics: number of qualifying AnalyticsEvent rows for that
-- user on that UTC calendar day. Field-to-event mapping is documented in
-- daily-activity.service.ts (EVENT_TO_FIELD).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "UserDailyActivity" (
  "userId"                 TEXT NOT NULL,
  "date"                   DATE NOT NULL,
  "sessionStarted"         INTEGER NOT NULL DEFAULT 0,
  "createdRealWish"        INTEGER NOT NULL DEFAULT 0,
  "createdWishlist"        INTEGER NOT NULL DEFAULT 0,
  "sharedWishlist"         INTEGER NOT NULL DEFAULT 0,
  "guestOpened"            INTEGER NOT NULL DEFAULT 0,
  "reservedItem"           INTEGER NOT NULL DEFAULT 0,
  "convertedGuestToOwner"  INTEGER NOT NULL DEFAULT 0,
  "paywallViewed"          INTEGER NOT NULL DEFAULT 0,
  "checkoutStarted"        INTEGER NOT NULL DEFAULT 0,
  "paymentCompleted"       INTEGER NOT NULL DEFAULT 0,
  "proActivated"           INTEGER NOT NULL DEFAULT 0,
  "usedUrlImport"          INTEGER NOT NULL DEFAULT 0,
  "usedHint"               INTEGER NOT NULL DEFAULT 0,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,

  CONSTRAINT "UserDailyActivity_pkey" PRIMARY KEY ("userId", "date")
);

-- Range-scan support for dashboard queries that pull a date window across
-- all users (e.g. weekly D7 share rate, monthly paywall conversion).
CREATE INDEX "UserDailyActivity_date_idx" ON "UserDailyActivity"("date");

ALTER TABLE "UserDailyActivity"
  ADD CONSTRAINT "UserDailyActivity_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
