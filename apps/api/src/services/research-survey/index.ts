// Research-survey orchestration service.
//
// Each public function returns a discriminated `{ ok: true, ... } | { ok: false, error }`
// so route handlers stay thin (validate → call service → map error to HTTP status).
//
// State transitions (see schema enum ResearchSurveyInviteStatus):
//   PENDING → SENT      (scheduler)
//   SENT    → OPENED    (loadInviteForUser, first time)
//   OPENED  → STARTED   (submitAnswer, first time)
//   *       → COMPLETED (completeSurvey, when all required questions answered)
//   *       → DISMISSED (dismissSurvey, explicit user action)
//   *       → FAILED    (scheduler, bot_blocked or 4xx from Telegram)
//
// Reward grant logic in completeSurvey:
//   - lifetime subscription (billingPeriod='lifetime') → rewardKind='pro_30d_lifetime_noop',
//     no Subscription mutation, just bookkeeping on response.
//   - active monthly/yearly       → currentPeriodEnd += 30 days.
//   - no active subscription      → create new (source='survey_reward:<slug>', billingPeriod='one_time').
//   - already rewarded            → no-op (idempotent via rewardGrantedAt check under FOR UPDATE).

import { prisma, Prisma } from '@wishlist/db';
import { isLifetimeSubscription } from '@wishlist/shared';

// Mirror of Prisma's generated enum. Defined locally to avoid importing from
// `@prisma/client` (pnpm-hoisted package not directly in apps/api node_modules).
type ResearchSurveyInviteStatus =
  | 'PENDING'
  | 'SENT'
  | 'OPENED'
  | 'STARTED'
  | 'COMPLETED'
  | 'DISMISSED'
  | 'FAILED';

import { ACTIVE_SURVEY, type SurveyDefinition } from './survey-pmf-v1';
import { validateAnswer, type AnswerRequestPayload, type AnswerValidationError } from './validation';

const PRO_REWARD_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export type ServiceError =
  | { code: 'INVITE_NOT_FOUND' }
  | { code: 'INVITE_FORBIDDEN' }
  | { code: 'INVITE_WRONG_SURVEY' }
  | { code: 'INVITE_TERMINAL' }       // already COMPLETED / DISMISSED / FAILED
  | { code: 'SURVEY_CLOSED' }
  | { code: 'VALIDATION'; error: AnswerValidationError }
  | { code: 'INCOMPLETE'; missing: string[] };

export interface InviteLoadResult {
  invite: {
    id: string;
    surveyId: string;
    userId: string;
    segmentId: string;
    segmentSubtype: string | null;
    locale: string;
    status: ResearchSurveyInviteStatus;
  };
  survey: SurveyDefinition;
  progress: { answered: string[]; totalRequired: number; canComplete: boolean };
  response: { id: string; completedAt: Date | null; rewardKind: string | null } | null;
}

export type ProgressInfo = InviteLoadResult['progress'];

// ─────────────────────────────────────────────────────────────────────
// Load + auto-transition SENT → OPENED on first read.
// ─────────────────────────────────────────────────────────────────────
export async function loadInviteForUser(params: {
  inviteId: string;
  userId: string;
  surveyId?: string;
}): Promise<{ ok: true; data: InviteLoadResult } | { ok: false; error: ServiceError }> {
  const invite = await prisma.researchSurveyInvite.findUnique({
    where: { id: params.inviteId },
    include: {
      survey: true,
      response: { select: { id: true, completedAt: true, rewardKind: true } },
    },
  });

  if (!invite) return { ok: false, error: { code: 'INVITE_NOT_FOUND' } };
  if (invite.userId !== params.userId) return { ok: false, error: { code: 'INVITE_FORBIDDEN' } };
  if (params.surveyId && invite.surveyId !== params.surveyId) {
    return { ok: false, error: { code: 'INVITE_WRONG_SURVEY' } };
  }
  if (invite.survey.status === 'CLOSED') return { ok: false, error: { code: 'SURVEY_CLOSED' } };

  // SENT → OPENED on first read. Idempotent if already OPENED+.
  let status = invite.status;
  if (status === 'SENT' || status === 'PENDING') {
    await prisma.researchSurveyInvite.updateMany({
      where: { id: invite.id, status: { in: ['PENDING', 'SENT'] } },
      data: { status: 'OPENED', openedAt: new Date() },
    });
    status = 'OPENED';
  }

  const answeredIds = invite.response
    ? (await prisma.researchSurveyAnswer.findMany({
        where: { responseId: invite.response.id },
        distinct: ['questionId'],
        select: { questionId: true },
      })).map((a) => a.questionId)
    : [];

  const progress = buildProgress(answeredIds);

  return {
    ok: true,
    data: {
      invite: {
        id: invite.id,
        surveyId: invite.surveyId,
        userId: invite.userId,
        segmentId: invite.segmentId,
        segmentSubtype: invite.segmentSubtype,
        locale: invite.locale,
        status,
      },
      survey: ACTIVE_SURVEY,
      progress,
      response: invite.response ?? null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
// Submit a single question answer (single + multi + nps + open).
// Replaces ALL previous selections on this (response, question) tuple.
// ─────────────────────────────────────────────────────────────────────
export interface SubmitAnswerResult {
  responseId: string;
  progress: ProgressInfo;
  isFirstAnswer: boolean;
  storedOptionIds: string[];
  hasText: boolean;
}

export async function submitAnswer(params: {
  inviteId: string;
  userId: string;
  surveyId: string;
  payload: AnswerRequestPayload;
}): Promise<{ ok: true; data: SubmitAnswerResult } | { ok: false; error: ServiceError }> {
  const validation = validateAnswer(params.payload);
  if (!validation.ok) return { ok: false, error: { code: 'VALIDATION', error: validation.error } };
  const answer = validation.data;

  const invite = await prisma.researchSurveyInvite.findUnique({
    where: { id: params.inviteId },
    include: { survey: { select: { status: true } } },
  });
  if (!invite) return { ok: false, error: { code: 'INVITE_NOT_FOUND' } };
  if (invite.userId !== params.userId) return { ok: false, error: { code: 'INVITE_FORBIDDEN' } };
  if (invite.surveyId !== params.surveyId) return { ok: false, error: { code: 'INVITE_WRONG_SURVEY' } };
  if (invite.survey.status === 'CLOSED') return { ok: false, error: { code: 'SURVEY_CLOSED' } };
  if (invite.status === 'COMPLETED' || invite.status === 'DISMISSED' || invite.status === 'FAILED') {
    return { ok: false, error: { code: 'INVITE_TERMINAL' } };
  }

  // Transactional: ensure Response exists; replace per-question answers.
  const result = await prisma.$transaction(async (tx) => {
    let response = await tx.researchSurveyResponse.findUnique({
      where: { surveyId_userId: { surveyId: invite.surveyId, userId: invite.userId } },
    });
    let isFirstAnswer = false;
    if (!response) {
      response = await tx.researchSurveyResponse.create({
        data: {
          surveyId: invite.surveyId,
          inviteId: invite.id,
          userId: invite.userId,
          segmentId: invite.segmentId,
          segmentSubtype: invite.segmentSubtype,
          locale: invite.locale,
        },
      });
      isFirstAnswer = true;
    }

    // First answer → flip invite to STARTED. Subsequent answers don't change status.
    if (isFirstAnswer && (invite.status === 'OPENED' || invite.status === 'SENT' || invite.status === 'PENDING')) {
      await tx.researchSurveyInvite.update({
        where: { id: invite.id },
        data: { status: 'STARTED', startedAt: new Date() },
      });
    }

    // Replace all selections on this question (delete + createMany).
    await tx.researchSurveyAnswer.deleteMany({
      where: { responseId: response.id, questionId: answer.questionId },
    });
    await tx.researchSurveyAnswer.createMany({
      data: answer.selectedOptionIds.map((optionId, idx) => ({
        responseId: response!.id,
        questionId: answer.questionId,
        optionId,
        // answerText attaches to the first text-bearing row only — the column
        // is informational (analysts read it alongside the row's questionId).
        answerText:
          answer.answerText != null && (optionId === '__text__' || optionId === 'other')
            ? answer.answerText
            : null,
      })),
    });

    const answered = await tx.researchSurveyAnswer.findMany({
      where: { responseId: response.id },
      distinct: ['questionId'],
      select: { questionId: true },
    });

    return {
      responseId: response.id,
      progress: buildProgress(answered.map((r) => r.questionId)),
      isFirstAnswer,
      storedOptionIds: answer.selectedOptionIds,
      hasText: answer.answerText != null,
    };
  });

  return { ok: true, data: result };
}

// ─────────────────────────────────────────────────────────────────────
// Finalize the survey: verify all required answered, grant reward, COMPLETED.
// Idempotent — repeat calls re-emit no events and do not double-grant.
// ─────────────────────────────────────────────────────────────────────
export interface CompleteResult {
  alreadyCompleted: boolean;
  rewardKind: 'pro_30d' | 'pro_30d_lifetime_noop';
  rewardGrantedAt: Date;
  newPeriodEnd: Date | null;
}

export async function completeSurvey(params: {
  inviteId: string;
  userId: string;
  surveyId: string;
}): Promise<{ ok: true; data: CompleteResult } | { ok: false; error: ServiceError }> {
  const invite = await prisma.researchSurveyInvite.findUnique({
    where: { id: params.inviteId },
    include: { survey: { select: { status: true, slug: true } } },
  });
  if (!invite) return { ok: false, error: { code: 'INVITE_NOT_FOUND' } };
  if (invite.userId !== params.userId) return { ok: false, error: { code: 'INVITE_FORBIDDEN' } };
  if (invite.surveyId !== params.surveyId) return { ok: false, error: { code: 'INVITE_WRONG_SURVEY' } };
  if (invite.survey.status === 'CLOSED') return { ok: false, error: { code: 'SURVEY_CLOSED' } };
  if (invite.status === 'DISMISSED' || invite.status === 'FAILED') {
    return { ok: false, error: { code: 'INVITE_TERMINAL' } };
  }

  return await prisma.$transaction(async (tx) => {
    const response = await tx.researchSurveyResponse.findUnique({
      where: { surveyId_userId: { surveyId: invite.surveyId, userId: invite.userId } },
    });
    if (!response) {
      // Nothing answered — caller sent /complete before any /answer.
      return { ok: false as const, error: { code: 'INCOMPLETE' as const, missing: [...ACTIVE_SURVEY.required] } };
    }

    // Re-entrancy guard: already rewarded → return prior outcome, no re-grant.
    if (response.rewardGrantedAt && response.rewardKind) {
      return {
        ok: true as const,
        data: {
          alreadyCompleted: true,
          rewardKind: response.rewardKind as 'pro_30d' | 'pro_30d_lifetime_noop',
          rewardGrantedAt: response.rewardGrantedAt,
          newPeriodEnd: null,
        },
      };
    }

    const answered = await tx.researchSurveyAnswer.findMany({
      where: { responseId: response.id },
      distinct: ['questionId'],
      select: { questionId: true },
    });
    const answeredSet = new Set(answered.map((a) => a.questionId));
    const missing = ACTIVE_SURVEY.required.filter((q) => !answeredSet.has(q));
    if (missing.length > 0) {
      return { ok: false as const, error: { code: 'INCOMPLETE' as const, missing } };
    }

    const grant = await grantSurveyRewardTx(tx, {
      userId: invite.userId,
      slug: invite.survey.slug,
    });

    await tx.researchSurveyResponse.update({
      where: { id: response.id },
      data: { completedAt: new Date(), rewardKind: grant.rewardKind, rewardGrantedAt: grant.rewardGrantedAt },
    });
    await tx.researchSurveyInvite.update({
      where: { id: invite.id },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });

    return {
      ok: true as const,
      data: {
        alreadyCompleted: false,
        rewardKind: grant.rewardKind,
        rewardGrantedAt: grant.rewardGrantedAt,
        newPeriodEnd: grant.newPeriodEnd,
      },
    };
  });
}

// ─────────────────────────────────────────────────────────────────────
// Dismiss — explicit user "not now" tap. Distinct from passive abandonment.
// ─────────────────────────────────────────────────────────────────────
export async function dismissSurvey(params: {
  inviteId: string;
  userId: string;
  surveyId: string;
}): Promise<{ ok: true } | { ok: false; error: ServiceError }> {
  const invite = await prisma.researchSurveyInvite.findUnique({
    where: { id: params.inviteId },
    select: { userId: true, surveyId: true, status: true },
  });
  if (!invite) return { ok: false, error: { code: 'INVITE_NOT_FOUND' } };
  if (invite.userId !== params.userId) return { ok: false, error: { code: 'INVITE_FORBIDDEN' } };
  if (invite.surveyId !== params.surveyId) return { ok: false, error: { code: 'INVITE_WRONG_SURVEY' } };
  if (invite.status === 'COMPLETED' || invite.status === 'FAILED') {
    return { ok: false, error: { code: 'INVITE_TERMINAL' } };
  }

  // Idempotent — already DISMISSED stays DISMISSED.
  await prisma.researchSurveyInvite.updateMany({
    where: { id: params.inviteId, status: { not: 'DISMISSED' } },
    data: { status: 'DISMISSED', dismissedAt: new Date() },
  });
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────
// Reward grant (called inside completeSurvey's transaction).
// Lifetime users get a no-op + bookkeeping; everyone else gets +30 days.
// ─────────────────────────────────────────────────────────────────────
async function grantSurveyRewardTx(
  tx: Prisma.TransactionClient,
  params: { userId: string; slug: string },
): Promise<{ rewardKind: 'pro_30d' | 'pro_30d_lifetime_noop'; rewardGrantedAt: Date; newPeriodEnd: Date | null }> {
  const now = new Date();
  const existing = await tx.subscription.findFirst({
    where: { userId: params.userId, planCode: 'PRO' },
    orderBy: { currentPeriodEnd: 'desc' },
  });

  if (existing && isLifetimeSubscription(existing)) {
    return { rewardKind: 'pro_30d_lifetime_noop', rewardGrantedAt: now, newPeriodEnd: null };
  }

  const grantDelta = PRO_REWARD_DAYS * DAY_MS;
  const hasActivePro =
    existing && existing.currentPeriodEnd > now && existing.status === 'ACTIVE';

  if (hasActivePro && existing) {
    const newPeriodEnd = new Date(existing.currentPeriodEnd.getTime() + grantDelta);
    await tx.subscription.update({
      where: { id: existing.id },
      data: { currentPeriodEnd: newPeriodEnd, status: 'ACTIVE' },
    });
    return { rewardKind: 'pro_30d', rewardGrantedAt: now, newPeriodEnd };
  }

  // No active PRO (expired sub or never had one) — start a new 30-day window.
  const newPeriodEnd = new Date(now.getTime() + grantDelta);
  if (existing) {
    await tx.subscription.update({
      where: { id: existing.id },
      data: {
        currentPeriodStart: now,
        currentPeriodEnd: newPeriodEnd,
        status: 'ACTIVE',
        cancelledAt: null,
        source: `survey_reward:${params.slug}`,
        billingPeriod: 'one_time',
        cancelAtPeriodEnd: true,
      },
    });
  } else {
    await tx.subscription.create({
      data: {
        userId: params.userId,
        planCode: 'PRO',
        status: 'ACTIVE',
        starsPrice: 0,
        currentPeriodStart: now,
        currentPeriodEnd: newPeriodEnd,
        source: `survey_reward:${params.slug}`,
        billingPeriod: 'one_time',
        cancelAtPeriodEnd: true,
      },
    });
  }
  return { rewardKind: 'pro_30d', rewardGrantedAt: now, newPeriodEnd };
}

function buildProgress(answeredQuestionIds: string[]): ProgressInfo {
  const answered = [...new Set(answeredQuestionIds)].sort();
  const requiredSet = new Set(ACTIVE_SURVEY.required);
  const canComplete = ACTIVE_SURVEY.required.every((q) => answered.includes(q));
  return { answered, totalRequired: requiredSet.size, canComplete };
}

// ─────────────────────────────────────────────────────────────────────
// Ops helper — seed PENDING invites for an ACTIVE survey.
// Idempotent: pre-existing invites for the same (surveyId, userId) are
// skipped silently. Returns the number of rows actually inserted.
// ─────────────────────────────────────────────────────────────────────
export interface SeedInviteRow {
  userId: string;
  segmentId: string;
  segmentSubtype: string | null;
  locale: string;
}

export async function seedInvites(params: {
  surveyId: string;
  rows: SeedInviteRow[];
}): Promise<{ inserted: number; skipped: number }> {
  if (params.rows.length === 0) return { inserted: 0, skipped: 0 };
  const result = await prisma.researchSurveyInvite.createMany({
    data: params.rows.map((r) => ({
      surveyId: params.surveyId,
      userId: r.userId,
      segmentId: r.segmentId,
      segmentSubtype: r.segmentSubtype,
      locale: r.locale,
      status: 'PENDING' as const,
    })),
    skipDuplicates: true,
  });
  return {
    inserted: result.count,
    skipped: params.rows.length - result.count,
  };
}

export { ACTIVE_SURVEY };
export type { SurveyDefinition } from './survey-pmf-v1';
export { getQuestion, listQuestionIds } from './survey-pmf-v1';
export { validateAnswer, MAX_ANSWER_TEXT_LENGTH } from './validation';
export { resolveSurveyLocale, type SurveyLocale } from './locale';
export { selectSurveyRecipients } from './recipients';
export type { RecipientSelection, SelectionInput, SelectionReport, SegmentId, S8Subtype } from './recipients';
