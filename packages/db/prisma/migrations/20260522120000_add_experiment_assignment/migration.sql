-- ═══════════════════════════════════════════════════════════════════════════
-- ExperimentAssignment — sticky A/B experiment bucket, one row per (user,
-- experiment). Phase 0 of the experiment backlog
-- (docs/research/06-experiment-backlog.md): the minimal infrastructure every
-- later experiment depends on.
--
--   • (userId, experimentKey) UNIQUE — the stickiness + dedup guard. The
--     server computes the variant deterministically by hashing userId, but
--     the row pins it permanently: once assigned, the variant survives any
--     later change to EXP_<NAME>_ROLLOUT (only EXP_<NAME>_ENABLED=false, the
--     kill switch, overrides it). The unique index also makes the
--     `experiment.assigned` analytics event fire exactly once — a second
--     concurrent assign hits P2002 and is treated as a no-op.
--   • variant: 'control' | 'treatment'.
--   • holdout: true when the user is in the global 5% holdout (always
--     'control', never exposed to a treatment).
--   • userId FK cascades on user deletion (privacy).
--
-- Additive, non-blocking: a brand-new table, no backfill, no change to any
-- existing table.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE "ExperimentAssignment" (
    "id"            TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "experimentKey" TEXT NOT NULL,
    "variant"       TEXT NOT NULL,
    "holdout"       BOOLEAN NOT NULL DEFAULT false,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExperimentAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExperimentAssignment_userId_experimentKey_key" ON "ExperimentAssignment"("userId", "experimentKey");
CREATE INDEX "ExperimentAssignment_experimentKey_variant_idx" ON "ExperimentAssignment"("experimentKey", "variant");

ALTER TABLE "ExperimentAssignment"
  ADD CONSTRAINT "ExperimentAssignment_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
