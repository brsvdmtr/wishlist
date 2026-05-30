-- ═══════════════════════════════════════════════════════════════════════════
-- E23 — Santa pre-season teaser DM. Two additive, greenfield tables.
--
--   • SantaPreseasonTouch — one row per (user, season). The dedup guarantee
--     (UNIQUE(userId, seasonYear) = "one user never gets a duplicate DM"), the
--     A/B variant, the send-state, and the per-touch mute. CONTROL users get a
--     row with variant='control', stopReason='control', and no send. The
--     >15%-mute kill-switch counts this table directly (sentAt / mutedAt), so
--     it is race-free across the API + bot processes — no denormalized counters.
--     userId FK cascades on user deletion (privacy).
--
--   • SantaPreseasonBroadcast — one row per season, status-only latch for the
--     phased broadcast. seasonYear is the PK so it doubles as the write-once
--     lock. running → completed (pool drained / past Nov-14) or stopped (mute
--     rate crossed the threshold).
--
-- Both tables are brand-new and empty: plain (non-CONCURRENT) inline indexes
-- run inside the migration transaction with zero lock-contention risk. No
-- backfill, no change to any existing table.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "SantaPreseasonTouch" (
    "id"           TEXT NOT NULL,
    "userId"       TEXT NOT NULL,
    "seasonYear"   INTEGER NOT NULL,
    "variant"      TEXT NOT NULL,
    "segment"      TEXT NOT NULL,
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "sentAt"       TIMESTAMP(3),
    "delivered"    BOOLEAN NOT NULL DEFAULT false,
    "stopReason"   TEXT,
    "mutedAt"      TIMESTAMP(3),
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"    TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SantaPreseasonTouch_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SantaPreseasonTouch_userId_seasonYear_key" ON "SantaPreseasonTouch"("userId", "seasonYear");
CREATE INDEX "SantaPreseasonTouch_seasonYear_variant_idx" ON "SantaPreseasonTouch"("seasonYear", "variant");
CREATE INDEX "SantaPreseasonTouch_seasonYear_sentAt_idx" ON "SantaPreseasonTouch"("seasonYear", "sentAt");
CREATE INDEX "SantaPreseasonTouch_seasonYear_mutedAt_idx" ON "SantaPreseasonTouch"("seasonYear", "mutedAt");

ALTER TABLE "SantaPreseasonTouch"
  ADD CONSTRAINT "SantaPreseasonTouch_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SantaPreseasonBroadcast" (
    "seasonYear"  INTEGER NOT NULL,
    "status"      TEXT NOT NULL DEFAULT 'running',
    "startedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "stopReason"  TEXT,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SantaPreseasonBroadcast_pkey" PRIMARY KEY ("seasonYear")
);
