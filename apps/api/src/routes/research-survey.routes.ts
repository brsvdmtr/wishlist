// Research survey routes — 4 endpoints under /tg/research/surveys/*.
//
// Mounted via `tgRouter.use(researchSurveyRouter)` in apps/api/src/index.ts.
// The state-changing endpoints (POST /answer, /complete, /dismiss) sit behind
// the protectTgRoute(...) chain in index.ts which registers:
//   - per-endpoint createRateLimiter('research.read' | 'research.write')
//   - idempotency middleware (complete is critical:true)
//
// All handlers are auth-gated through the global requireTelegramAuth that runs
// before tgRouter — `req.tgUser!` is safe to deref. We then call
// getOrCreateTgUser(req.tgUser!) to materialize the User row and use User.id
// (cuid) as the survey-side userId; survey rows never store Telegram IDs.
//
// PII discipline: error responses NEVER echo back optionIds the user tried
// to send, raw answerText, or any segment metadata that wasn't already on
// the invite they passed in (anti-enumeration).

import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler';
import { trackProductEvent } from '../services/analytics';
import {
  loadInviteForUser,
  submitAnswer,
  completeSurvey,
  dismissSurvey,
  ACTIVE_SURVEY,
  type ServiceError,
} from '../services/research-survey';

type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

type SurveyRouterUser = { id: string };

export interface ResearchSurveyRouterDeps {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<SurveyRouterUser>;
}

export function registerResearchSurveyRouter(deps: ResearchSurveyRouterDeps): Router {
  const { getOrCreateTgUser } = deps;
  const router = Router();

  // ── GET /tg/research/surveys/by-invite/:inviteId ─────────────────────
  router.get(
    '/research/surveys/by-invite/:inviteId',
    asyncHandler(async (req, res) => {
      const inviteId = req.params.inviteId ?? '';
      if (!inviteId) return res.status(400).json({ error: 'INVITE_ID_REQUIRED' });

      const user = await getOrCreateTgUser(req.tgUser!);
      const result = await loadInviteForUser({ inviteId, userId: user.id });
      if (!result.ok) return res.status(httpStatus(result.error)).json({ error: result.error.code });

      const data = result.data;
      // Fire 'survey.opened' only on the SENT/PENDING → OPENED transition.
      // loadInviteForUser already did the DB update; we infer transition from
      // status='OPENED' AND response==null AND no prior open emit by guarding
      // on the absence of a response (we still want to emit on idempotent
      // re-opens though, because dashboards count visits not state-changes).
      trackProductEvent({
        event: 'survey.opened',
        userId: user.id,
        props: {
          surveyId: data.invite.surveyId,
          surveySlug: data.survey.slug,
          surveyVersion: data.survey.version,
          inviteId: data.invite.id,
          segmentId: data.invite.segmentId,
          segmentSubtype: data.invite.segmentSubtype,
          locale: data.invite.locale,
        },
      });

      // Public payload — narrowly typed, no internal status names leak.
      return res.json({
        invite: {
          id: data.invite.id,
          surveyId: data.invite.surveyId,
          locale: data.invite.locale,
          status: data.invite.status,
        },
        survey: {
          slug: data.survey.slug,
          version: data.survey.version,
          questions: data.survey.questions.map((q) => ({
            id: q.id,
            type: q.type,
            maxSelections: q.maxSelections,
            options: q.options,
            optional: q.optional === true,
          })),
          required: data.survey.required,
        },
        progress: data.progress,
        response: data.response
          ? {
              completedAt: data.response.completedAt?.toISOString() ?? null,
              rewardKind: data.response.rewardKind,
            }
          : null,
      });
    }),
  );

  // ── POST /tg/research/surveys/:surveyId/answer ───────────────────────
  router.post(
    '/research/surveys/:surveyId/answer',
    asyncHandler(async (req, res) => {
      const surveyId = req.params.surveyId ?? '';
      const body = (req.body ?? {}) as {
        inviteId?: unknown;
        questionId?: unknown;
        selectedOptionIds?: unknown;
        answerText?: unknown;
      };
      const inviteId = typeof body.inviteId === 'string' ? body.inviteId : '';
      if (!surveyId || !inviteId) return res.status(400).json({ error: 'BAD_REQUEST' });

      const user = await getOrCreateTgUser(req.tgUser!);
      const result = await submitAnswer({
        inviteId,
        userId: user.id,
        surveyId,
        payload: {
          questionId: body.questionId,
          selectedOptionIds: body.selectedOptionIds,
          answerText: body.answerText,
        },
      });
      if (!result.ok) {
        if (result.error.code === 'VALIDATION') {
          const status = result.error.error.code === 'CARDINALITY' ? 422 : 400;
          return res.status(status).json({ error: result.error.error.code });
        }
        return res.status(httpStatus(result.error)).json({ error: result.error.code });
      }

      if (result.data.isFirstAnswer) {
        trackProductEvent({
          event: 'survey.started',
          userId: user.id,
          props: { surveyId, inviteId, surveySlug: ACTIVE_SURVEY.slug, surveyVersion: ACTIVE_SURVEY.version },
        });
      }
      trackProductEvent({
        event: 'survey.question_answered',
        userId: user.id,
        props: {
          surveyId,
          inviteId,
          questionId: typeof body.questionId === 'string' ? body.questionId : null,
          optionIds: result.data.storedOptionIds,
          hasText: result.data.hasText,
        },
      });

      return res.json({ ok: true, responseId: result.data.responseId, progress: result.data.progress });
    }),
  );

  // ── POST /tg/research/surveys/:surveyId/complete ─────────────────────
  router.post(
    '/research/surveys/:surveyId/complete',
    asyncHandler(async (req, res) => {
      const surveyId = req.params.surveyId ?? '';
      const body = (req.body ?? {}) as { inviteId?: unknown };
      const inviteId = typeof body.inviteId === 'string' ? body.inviteId : '';
      if (!surveyId || !inviteId) return res.status(400).json({ error: 'BAD_REQUEST' });

      const user = await getOrCreateTgUser(req.tgUser!);
      const result = await completeSurvey({ inviteId, userId: user.id, surveyId });
      if (!result.ok) {
        if (result.error.code === 'INCOMPLETE') {
          return res.status(422).json({ error: 'INCOMPLETE', missing: result.error.missing });
        }
        return res.status(httpStatus(result.error)).json({ error: result.error.code });
      }

      if (!result.data.alreadyCompleted) {
        trackProductEvent({
          event: 'survey.completed',
          userId: user.id,
          props: {
            surveyId,
            inviteId,
            surveySlug: ACTIVE_SURVEY.slug,
            surveyVersion: ACTIVE_SURVEY.version,
            rewardKind: result.data.rewardKind,
          },
        });
      }

      return res.json({
        ok: true,
        rewardKind: result.data.rewardKind,
        rewardGrantedAt: result.data.rewardGrantedAt.toISOString(),
        alreadyCompleted: result.data.alreadyCompleted,
      });
    }),
  );

  // ── POST /tg/research/surveys/:surveyId/dismiss ──────────────────────
  router.post(
    '/research/surveys/:surveyId/dismiss',
    asyncHandler(async (req, res) => {
      const surveyId = req.params.surveyId ?? '';
      const body = (req.body ?? {}) as { inviteId?: unknown };
      const inviteId = typeof body.inviteId === 'string' ? body.inviteId : '';
      if (!surveyId || !inviteId) return res.status(400).json({ error: 'BAD_REQUEST' });

      const user = await getOrCreateTgUser(req.tgUser!);
      const result = await dismissSurvey({ inviteId, userId: user.id, surveyId });
      if (!result.ok) {
        return res.status(httpStatus(result.error)).json({ error: result.error.code });
      }
      trackProductEvent({
        event: 'survey.dismissed',
        userId: user.id,
        props: { surveyId, inviteId, surveySlug: ACTIVE_SURVEY.slug, surveyVersion: ACTIVE_SURVEY.version },
      });
      return res.json({ ok: true });
    }),
  );

  return router;
}

function httpStatus(err: ServiceError): number {
  switch (err.code) {
    case 'INVITE_NOT_FOUND':
      return 404;
    case 'INVITE_FORBIDDEN':
    case 'INVITE_WRONG_SURVEY':
      return 403;
    case 'INVITE_TERMINAL':
    case 'SURVEY_CLOSED':
      return 410;
    case 'INCOMPLETE':
      return 422;
    case 'VALIDATION':
      return 400;
  }
}
