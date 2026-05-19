-- ═══════════════════════════════════════════════════════════════════════════
-- Research surveys — localized PMF-style questionnaires
--
-- New tables:
--   ResearchSurvey         — one row per (slug, version). DRAFT → ACTIVE → CLOSED.
--   ResearchSurveyInvite   — one row per (surveyId, userId). Anti-dupe via
--                            UNIQUE(surveyId, userId). Holds resolved locale +
--                            segmentId (S1/S2/S3/S5/S7/S8) + segmentSubtype
--                            (S8 behavioral dropout stage: opened_only,
--                            wishlist_no_item, item_no_share,
--                            shared_no_guest_action, activated_then_churned).
--   ResearchSurveyResponse — one row per completed (or in-progress) flow.
--                            Stores reward bookkeeping (rewardKind +
--                            rewardGrantedAt). Lifetime users get
--                            rewardKind='pro_30d_lifetime_noop' without any
--                            Subscription mutation.
--   ResearchSurveyAnswer   — one row per selected optionId. Multi-choice
--                            (Q3/Q6/Q7) creates up to 2 rows per
--                            (responseId, questionId). UNIQUE on the triple.
--
-- PII discipline (no telegramId / username / firstName / lastName / item titles).
-- answerText is populated ONLY when optionId IN ('__text__', 'other'); cap 500.
--
-- Rollout: scheduler ships disabled. Recipient seeding + send is gated behind
-- RESEARCH_SURVEY_SEND_ENABLED env flag (default false) — see
-- apps/api/src/schedulers/research-survey-send.ts.
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Enums ───
CREATE TYPE "ResearchSurveyStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED');
CREATE TYPE "ResearchSurveyInviteStatus" AS ENUM (
  'PENDING', 'SENT', 'OPENED', 'STARTED', 'COMPLETED', 'DISMISSED', 'FAILED'
);

-- ─── ResearchSurvey ───
CREATE TABLE "ResearchSurvey" (
    "id"        TEXT NOT NULL,
    "slug"      TEXT NOT NULL,
    "version"   INTEGER NOT NULL DEFAULT 1,
    "status"    "ResearchSurveyStatus" NOT NULL DEFAULT 'DRAFT',
    "openedAt"  TIMESTAMP(3),
    "closedAt"  TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchSurvey_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResearchSurvey_slug_version_key" ON "ResearchSurvey"("slug", "version");
CREATE INDEX "ResearchSurvey_status_idx" ON "ResearchSurvey"("status");

-- ─── ResearchSurveyInvite ───
CREATE TABLE "ResearchSurveyInvite" (
    "id"             TEXT NOT NULL,
    "surveyId"       TEXT NOT NULL,
    "userId"         TEXT NOT NULL,
    "segmentId"      TEXT NOT NULL,
    "segmentSubtype" TEXT,
    "locale"         TEXT NOT NULL,
    "status"         "ResearchSurveyInviteStatus" NOT NULL DEFAULT 'PENDING',
    "sentAt"         TIMESTAMP(3),
    "openedAt"       TIMESTAMP(3),
    "startedAt"      TIMESTAMP(3),
    "completedAt"    TIMESTAMP(3),
    "dismissedAt"    TIMESTAMP(3),
    "failedAt"       TIMESTAMP(3),
    "failureReason"  TEXT,
    "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchSurveyInvite_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResearchSurveyInvite_surveyId_userId_key"
  ON "ResearchSurveyInvite"("surveyId", "userId");
CREATE INDEX "ResearchSurveyInvite_surveyId_status_idx"
  ON "ResearchSurveyInvite"("surveyId", "status");
CREATE INDEX "ResearchSurveyInvite_status_sentAt_idx"
  ON "ResearchSurveyInvite"("status", "sentAt");
CREATE INDEX "ResearchSurveyInvite_surveyId_segmentId_segmentSubtype_idx"
  ON "ResearchSurveyInvite"("surveyId", "segmentId", "segmentSubtype");

-- ─── ResearchSurveyResponse ───
CREATE TABLE "ResearchSurveyResponse" (
    "id"              TEXT NOT NULL,
    "surveyId"        TEXT NOT NULL,
    "inviteId"        TEXT NOT NULL,
    "userId"          TEXT NOT NULL,
    "segmentId"       TEXT NOT NULL,
    "segmentSubtype"  TEXT,
    "locale"          TEXT NOT NULL,
    "startedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt"     TIMESTAMP(3),
    "rewardKind"      TEXT,
    "rewardGrantedAt" TIMESTAMP(3),
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchSurveyResponse_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResearchSurveyResponse_inviteId_key"
  ON "ResearchSurveyResponse"("inviteId");
CREATE UNIQUE INDEX "ResearchSurveyResponse_surveyId_userId_key"
  ON "ResearchSurveyResponse"("surveyId", "userId");
CREATE INDEX "ResearchSurveyResponse_surveyId_completedAt_idx"
  ON "ResearchSurveyResponse"("surveyId", "completedAt");
CREATE INDEX "ResearchSurveyResponse_segmentId_segmentSubtype_completedAt_idx"
  ON "ResearchSurveyResponse"("segmentId", "segmentSubtype", "completedAt");

-- ─── ResearchSurveyAnswer ───
CREATE TABLE "ResearchSurveyAnswer" (
    "id"         TEXT NOT NULL,
    "responseId" TEXT NOT NULL,
    "questionId" TEXT NOT NULL,
    "optionId"   TEXT NOT NULL,
    "answerText" TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"  TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResearchSurveyAnswer_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ResearchSurveyAnswer_responseId_questionId_optionId_key"
  ON "ResearchSurveyAnswer"("responseId", "questionId", "optionId");
CREATE INDEX "ResearchSurveyAnswer_questionId_optionId_idx"
  ON "ResearchSurveyAnswer"("questionId", "optionId");
CREATE INDEX "ResearchSurveyAnswer_responseId_questionId_idx"
  ON "ResearchSurveyAnswer"("responseId", "questionId");

-- ─── Foreign keys ───
ALTER TABLE "ResearchSurveyInvite"
  ADD CONSTRAINT "ResearchSurveyInvite_surveyId_fkey"
    FOREIGN KEY ("surveyId") REFERENCES "ResearchSurvey"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ResearchSurveyInvite_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ResearchSurveyResponse"
  ADD CONSTRAINT "ResearchSurveyResponse_surveyId_fkey"
    FOREIGN KEY ("surveyId") REFERENCES "ResearchSurvey"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ResearchSurveyResponse_inviteId_fkey"
    FOREIGN KEY ("inviteId") REFERENCES "ResearchSurveyInvite"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "ResearchSurveyResponse_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ResearchSurveyAnswer"
  ADD CONSTRAINT "ResearchSurveyAnswer_responseId_fkey"
    FOREIGN KEY ("responseId") REFERENCES "ResearchSurveyResponse"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
