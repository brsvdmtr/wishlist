-- Normalize AnalyticsEvent.userId to internal User.id (cuid).
--
-- Background
-- ----------
-- Historically two emitter paths wrote to AnalyticsEvent.userId with
-- incompatible identifier formats:
--
--   • Server-side emitters (services/analytics.ts: trackEvent /
--     trackAnalyticsEvent / trackProductEvent) passed `user.id` — the
--     internal cuid.
--   • Frontend telemetry (POST /tg/telemetry) and a handful of misrouted
--     server callsites passed `String(req.tgUser.id)` — the Telegram
--     numeric ID.
--
-- On 2026-05-19 snapshot:
--   total events       : 10 517
--   userId IS NULL     :    157  (mostly guest.view_opened)
--   userId = cuid      :  1 111  (server-side emitters)
--   userId = numeric   :  9 249  (~88%, frontend telemetry + 2 bot callsites)
--
-- The runtime contract is now uniform (see docs/analytics-events.md):
-- every emitter writes the internal User.id (cuid) or NULL. This migration
-- normalizes the historical rows so dashboards / cohort queries can join
-- `AnalyticsEvent.userId = User.id` without an OR-fallback on telegramId.
--
-- Strategy
-- --------
-- Single UPDATE … FROM "User" matches rows where the value in
-- AnalyticsEvent.userId equals an existing User.telegramId (the row was
-- written in the legacy Telegram-id format). For each match we substitute
-- the corresponding User.id (cuid).
--
-- Rows where the legacy Telegram id doesn't resolve to a current User row
-- (the user was deleted, or it's a stale FK-less hash) are NULL'd out.
-- We prefer NULL over leaving an orphan numeric string because every
-- downstream query expects userId to be either a valid cuid (joins to
-- User) or NULL (guest). A numeric-string orphan would silently fall
-- through cohort filters and corrupt counts a second time.
--
-- Safety
-- ------
-- • Read-only on the User table.
-- • Idempotent: re-running the migration is a no-op once the column has
--   no numeric-format rows left.
-- • Wrapped in Prisma's default BEGIN/COMMIT transaction. ~9 200 rows on
--   prod = sub-second update; no concurrent index work, no lock escalation.
-- • The cuid-format rows (`userId ~ '^c[a-z0-9]+$'`) are left untouched.
-- • A "verification snapshot" SELECT at the end logs the post-migration
--   counts to Prisma's migration runner output so the operator can verify
--   the change before continuing.

-- 1) Replace numeric-format userId with the corresponding internal User.id.
UPDATE "AnalyticsEvent" ae
SET "userId" = u.id
FROM "User" u
WHERE ae."userId" = u."telegramId"
  AND ae."userId" ~ '^[0-9]+$';

-- 2) NULL out any remaining numeric-format rows — the original Telegram
--    id no longer maps to a current User (deleted user, hashed row, etc.).
--    Leaving the orphan numeric string in place would re-pollute the
--    column we just normalized.
UPDATE "AnalyticsEvent"
SET "userId" = NULL
WHERE "userId" ~ '^[0-9]+$';

-- 3) Verification — these counts are written to the migration log so the
--    operator can confirm the normalization before moving on. Expectation
--    after a clean run: `numeric_remaining = 0`.
DO $$
DECLARE
  v_total INT;
  v_null INT;
  v_cuid INT;
  v_numeric INT;
BEGIN
  SELECT COUNT(*) INTO v_total FROM "AnalyticsEvent";
  SELECT COUNT(*) INTO v_null FROM "AnalyticsEvent" WHERE "userId" IS NULL;
  SELECT COUNT(*) INTO v_cuid FROM "AnalyticsEvent" WHERE "userId" ~ '^c[a-z0-9]+$';
  SELECT COUNT(*) INTO v_numeric FROM "AnalyticsEvent" WHERE "userId" ~ '^[0-9]+$';
  RAISE NOTICE 'AnalyticsEvent.userId normalization snapshot: total=% null=% cuid=% numeric_remaining=%', v_total, v_null, v_cuid, v_numeric;
  IF v_numeric > 0 THEN
    RAISE EXCEPTION 'AnalyticsEvent.userId normalization left % rows in numeric format; investigate before proceeding', v_numeric;
  END IF;
END$$;
