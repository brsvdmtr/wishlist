-- ═══════════════════════════════════════════════════════════════════════════
-- HintQuotaCharge — audit ledger for the FREE hint-quota model
--
-- "Hint friends" moves from a hard PRO gate to a FREE monthly quota: FREE
-- users get FREE_HINT_QUOTA_PER_MONTH delivered hints per UTC calendar month
-- (default 3, env FREE_HINT_QUOTA_PER_MONTH), PRO stays unlimited, and paid
-- hints_pack_* credits (UserCredits.hintCredits) top up beyond the free
-- allowance.
--
-- One immutable row per delivered hint. Written by consumeHintCharge() when
-- the bot reports a hint DELIVERED (POST /internal/hints/credit).
--
--   • hintId UNIQUE — the idempotency guard. Telegram can double-fire the
--     users_shared event; the unique index makes a second charge a no-op.
--   • hintId is a plain TEXT column, NOT a foreign key. A charge row must
--     OUTLIVE its Hint: hints cascade-delete with their Item, and a cascading
--     ledger would let a user refund their monthly quota by deleting the wish.
--   • The ledger is the source of truth for "free hints used this month" —
--     COUNT(*) WHERE userId + period + source='free_monthly' + charged.
--   • source: free_monthly | paid_pack | grace | pro. charged is true only
--     for free_monthly / paid_pack.
--
-- Additive, non-blocking: a brand-new table, no backfill, no change to any
-- existing table. userId FK cascades on user deletion (privacy).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "HintQuotaCharge" (
    "id"        TEXT NOT NULL,
    "userId"    TEXT NOT NULL,
    "hintId"    TEXT NOT NULL,
    "period"    TEXT NOT NULL,
    "source"    TEXT NOT NULL,
    "charged"   BOOLEAN NOT NULL,
    "amount"    INTEGER NOT NULL DEFAULT 1,
    "reason"    TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HintQuotaCharge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HintQuotaCharge_hintId_key" ON "HintQuotaCharge"("hintId");
CREATE INDEX "HintQuotaCharge_userId_period_idx" ON "HintQuotaCharge"("userId", "period");

ALTER TABLE "HintQuotaCharge"
  ADD CONSTRAINT "HintQuotaCharge_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
