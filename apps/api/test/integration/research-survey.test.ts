// Integration tests for the research-survey service — exercises the edit
// flow (delete + recreate per question), the lifetime-noop reward branch,
// dismiss-vs-abandoned distinction, and idempotency of /complete.
//
// Auto-skips when DATABASE_URL is not set (local without `docker compose
// up postgres`). On CI the Postgres service is wired in; integration tests
// run automatically.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getTestPrisma, disconnectTestPrisma } from '../setup-pg';

const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;

const PREFIX = 'int-survey';
const SURVEY_SLUG = `pmf-discovery-${PREFIX}`;
const LIFETIME_END = new Date('2099-12-31T00:00:00.000Z');

if (SKIP) {
  // eslint-disable-next-line no-console
  console.warn('[integration] DATABASE_URL not set — skipping research-survey integration tests');
}

suite('research-survey service — real Postgres', () => {
  async function cleanOwnData() {
    const db = getTestPrisma();
    await db.researchSurveyAnswer.deleteMany({ where: { response: { user: { telegramId: { startsWith: PREFIX } } } } });
    await db.researchSurveyResponse.deleteMany({ where: { user: { telegramId: { startsWith: PREFIX } } } });
    await db.researchSurveyInvite.deleteMany({ where: { user: { telegramId: { startsWith: PREFIX } } } });
    await db.researchSurvey.deleteMany({ where: { slug: SURVEY_SLUG } });
    await db.subscription.deleteMany({ where: { user: { telegramId: { startsWith: PREFIX } } } });
    await db.userProfile.deleteMany({ where: { user: { telegramId: { startsWith: PREFIX } } } });
    await db.user.deleteMany({ where: { telegramId: { startsWith: PREFIX } } });
  }

  beforeAll(async () => { await cleanOwnData(); });
  afterAll(async () => { await cleanOwnData(); await disconnectTestPrisma(); });
  beforeEach(async () => { await cleanOwnData(); });

  async function setupSurvey() {
    const db = getTestPrisma();
    const survey = await db.researchSurvey.create({
      data: { slug: SURVEY_SLUG, version: 1, status: 'ACTIVE', openedAt: new Date() },
    });
    return survey;
  }

  async function setupUserWithInvite(opts: { segmentId?: string; locale?: string } = {}) {
    const db = getTestPrisma();
    const survey = await setupSurvey();
    const user = await db.user.create({
      data: {
        telegramId: `${PREFIX}-${Math.random().toString(36).slice(2, 8)}`,
        telegramChatId: '111',
      },
    });
    const invite = await db.researchSurveyInvite.create({
      data: {
        surveyId: survey.id,
        userId: user.id,
        segmentId: opts.segmentId ?? 'S1',
        locale: opts.locale ?? 'ru',
        status: 'SENT',
        sentAt: new Date(),
      },
    });
    return { db, survey, user, invite };
  }

  // ─── ED-1..ED-3: edit flow ─────────────────────────────────────────────
  it('ED-1: re-submitting Q3 with one option overwrites the previous two', async () => {
    const { db, survey, user, invite } = await setupUserWithInvite();
    const { submitAnswer } = await import('../../src/services/research-survey');

    const first = await submitAnswer({
      inviteId: invite.id,
      userId: user.id,
      surveyId: survey.id,
      payload: { questionId: 'q3', selectedOptionIds: ['url_import', 'share_link'] },
    });
    expect(first.ok).toBe(true);

    const second = await submitAnswer({
      inviteId: invite.id,
      userId: user.id,
      surveyId: survey.id,
      payload: { questionId: 'q3', selectedOptionIds: ['url_import'] },
    });
    expect(second.ok).toBe(true);

    const rows = await db.researchSurveyAnswer.findMany({
      where: { response: { surveyId: survey.id, userId: user.id }, questionId: 'q3' },
      orderBy: { optionId: 'asc' },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.optionId).toBe('url_import');
  });

  it('ED-2: re-submitting Q3 with a completely different pair replaces both rows', async () => {
    const { db, survey, user, invite } = await setupUserWithInvite();
    const { submitAnswer } = await import('../../src/services/research-survey');

    await submitAnswer({
      inviteId: invite.id, userId: user.id, surveyId: survey.id,
      payload: { questionId: 'q3', selectedOptionIds: ['url_import', 'share_link'] },
    });
    await submitAnswer({
      inviteId: invite.id, userId: user.id, surveyId: survey.id,
      payload: { questionId: 'q3', selectedOptionIds: ['categories', 'hints'] },
    });
    const rows = await db.researchSurveyAnswer.findMany({
      where: { response: { surveyId: survey.id, userId: user.id }, questionId: 'q3' },
      orderBy: { optionId: 'asc' },
    });
    expect(rows.map((r) => r.optionId)).toEqual(['categories', 'hints']);
  });

  it('ED-3: Q10 re-submission replaces answerText', async () => {
    const { db, survey, user, invite } = await setupUserWithInvite();
    const { submitAnswer } = await import('../../src/services/research-survey');

    // Complete required first so the response exists; just answer q10 directly.
    await submitAnswer({
      inviteId: invite.id, userId: user.id, surveyId: survey.id,
      payload: { questionId: 'q10', selectedOptionIds: ['__text__'], answerText: 'first version' },
    });
    await submitAnswer({
      inviteId: invite.id, userId: user.id, surveyId: survey.id,
      payload: { questionId: 'q10', selectedOptionIds: ['__text__'], answerText: 'second version' },
    });
    const rows = await db.researchSurveyAnswer.findMany({
      where: { response: { surveyId: survey.id, userId: user.id }, questionId: 'q10' },
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.answerText).toBe('second version');
  });

  // ─── First-answer state transitions ────────────────────────────────────
  it('first answer transitions invite SENT → STARTED + creates Response', async () => {
    const { db, survey, user, invite } = await setupUserWithInvite();
    const { submitAnswer } = await import('../../src/services/research-survey');

    const out = await submitAnswer({
      inviteId: invite.id, userId: user.id, surveyId: survey.id,
      payload: { questionId: 'q1', selectedOptionIds: ['curiosity'] },
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.isFirstAnswer).toBe(true);

    const reloaded = await db.researchSurveyInvite.findUnique({ where: { id: invite.id } });
    expect(reloaded?.status).toBe('STARTED');
    expect(reloaded?.startedAt).not.toBeNull();

    const response = await db.researchSurveyResponse.findUnique({
      where: { surveyId_userId: { surveyId: survey.id, userId: user.id } },
    });
    expect(response).not.toBeNull();
    expect(response?.completedAt).toBeNull();
  });

  // ─── RW-1: no Subscription → grant new 30d window ──────────────────────
  it('RW-1: no Subscription → /complete creates a 30-day Subscription', async () => {
    const { db, survey, user, invite } = await setupUserWithInvite();
    const { submitAnswer, completeSurvey } = await import('../../src/services/research-survey');

    await answerAllRequired(survey.id, user.id, invite.id, submitAnswer);
    const out = await completeSurvey({ inviteId: invite.id, userId: user.id, surveyId: survey.id });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.rewardKind).toBe('pro_30d');
      expect(out.data.alreadyCompleted).toBe(false);
      const sub = await db.subscription.findFirst({ where: { userId: user.id, planCode: 'PRO' } });
      expect(sub).not.toBeNull();
      const daysFromNow = (sub!.currentPeriodEnd.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
      expect(daysFromNow).toBeGreaterThan(29);
      expect(daysFromNow).toBeLessThanOrEqual(31);
    }
  });

  // ─── RW-2: active monthly → extend by 30 days ──────────────────────────
  it('RW-2: active monthly subscription gets +30 days', async () => {
    const { db, survey, user, invite } = await setupUserWithInvite();
    const { submitAnswer, completeSurvey } = await import('../../src/services/research-survey');
    const existingEnd = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000); // 10d from now
    await db.subscription.create({
      data: {
        userId: user.id, planCode: 'PRO', status: 'ACTIVE', starsPrice: 100,
        currentPeriodStart: new Date(), currentPeriodEnd: existingEnd, billingPeriod: 'monthly',
      },
    });
    await answerAllRequired(survey.id, user.id, invite.id, submitAnswer);
    const out = await completeSurvey({ inviteId: invite.id, userId: user.id, surveyId: survey.id });
    expect(out.ok).toBe(true);
    const reloaded = await db.subscription.findFirst({ where: { userId: user.id, planCode: 'PRO' } });
    const deltaMs = reloaded!.currentPeriodEnd.getTime() - existingEnd.getTime();
    const deltaDays = deltaMs / (24 * 60 * 60 * 1000);
    expect(deltaDays).toBeGreaterThan(29.9);
    expect(deltaDays).toBeLessThan(30.1);
  });

  // ─── RW-3: lifetime → no-op ───────────────────────────────────────────
  it('RW-3: lifetime subscription is left untouched; rewardKind=pro_30d_lifetime_noop', async () => {
    const { db, survey, user, invite } = await setupUserWithInvite();
    const { submitAnswer, completeSurvey } = await import('../../src/services/research-survey');
    const sub = await db.subscription.create({
      data: {
        userId: user.id, planCode: 'PRO', status: 'ACTIVE', starsPrice: 2490,
        currentPeriodStart: new Date(), currentPeriodEnd: LIFETIME_END, billingPeriod: 'lifetime',
      },
    });
    await answerAllRequired(survey.id, user.id, invite.id, submitAnswer);
    const out = await completeSurvey({ inviteId: invite.id, userId: user.id, surveyId: survey.id });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.data.rewardKind).toBe('pro_30d_lifetime_noop');
      expect(out.data.newPeriodEnd).toBeNull();
    }
    const reloaded = await db.subscription.findUnique({ where: { id: sub.id } });
    expect(reloaded!.currentPeriodEnd.toISOString()).toBe(LIFETIME_END.toISOString());
    expect(reloaded!.billingPeriod).toBe('lifetime');

    const response = await db.researchSurveyResponse.findUnique({
      where: { surveyId_userId: { surveyId: survey.id, userId: user.id } },
    });
    expect(response?.rewardKind).toBe('pro_30d_lifetime_noop');
    expect(response?.rewardGrantedAt).not.toBeNull();
  });

  // ─── RW-4: repeat /complete is idempotent ──────────────────────────────
  it('RW-4: repeat /complete is a no-op (rewardGrantedAt does not move)', async () => {
    const { db, survey, user, invite } = await setupUserWithInvite();
    const { submitAnswer, completeSurvey } = await import('../../src/services/research-survey');
    await answerAllRequired(survey.id, user.id, invite.id, submitAnswer);
    const first = await completeSurvey({ inviteId: invite.id, userId: user.id, surveyId: survey.id });
    expect(first.ok).toBe(true);
    const r1 = await db.researchSurveyResponse.findUnique({
      where: { surveyId_userId: { surveyId: survey.id, userId: user.id } },
    });
    const second = await completeSurvey({ inviteId: invite.id, userId: user.id, surveyId: survey.id });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.data.alreadyCompleted).toBe(true);
    const r2 = await db.researchSurveyResponse.findUnique({
      where: { surveyId_userId: { surveyId: survey.id, userId: user.id } },
    });
    expect(r2?.rewardGrantedAt?.toISOString()).toBe(r1?.rewardGrantedAt?.toISOString());

    const subs = await db.subscription.findMany({ where: { userId: user.id, planCode: 'PRO' } });
    expect(subs.length).toBe(1);
  });

  // ─── DM-1/DM-2: dismiss vs abandoned ──────────────────────────────────
  it('DM-2: explicit dismiss transitions to DISMISSED with dismissedAt set', async () => {
    const { db, survey, user, invite } = await setupUserWithInvite();
    const { dismissSurvey } = await import('../../src/services/research-survey');
    const out = await dismissSurvey({ inviteId: invite.id, userId: user.id, surveyId: survey.id });
    expect(out.ok).toBe(true);
    const reloaded = await db.researchSurveyInvite.findUnique({ where: { id: invite.id } });
    expect(reloaded?.status).toBe('DISMISSED');
    expect(reloaded?.dismissedAt).not.toBeNull();
  });

  it('DM-1: STARTED without /dismiss stays STARTED (not auto-DISMISSED)', async () => {
    const { db, survey, user, invite } = await setupUserWithInvite();
    const { submitAnswer } = await import('../../src/services/research-survey');
    await submitAnswer({
      inviteId: invite.id, userId: user.id, surveyId: survey.id,
      payload: { questionId: 'q1', selectedOptionIds: ['curiosity'] },
    });
    const reloaded = await db.researchSurveyInvite.findUnique({ where: { id: invite.id } });
    expect(reloaded?.status).toBe('STARTED');
    expect(reloaded?.dismissedAt).toBeNull();
  });

  // ─── INCOMPLETE guard ──────────────────────────────────────────────────
  it('rejects /complete when not all required questions answered', async () => {
    const { survey, user, invite } = await setupUserWithInvite();
    const { submitAnswer, completeSurvey } = await import('../../src/services/research-survey');
    await submitAnswer({
      inviteId: invite.id, userId: user.id, surveyId: survey.id,
      payload: { questionId: 'q1', selectedOptionIds: ['curiosity'] },
    });
    const out = await completeSurvey({ inviteId: invite.id, userId: user.id, surveyId: survey.id });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe('INCOMPLETE');
      expect(out.error.code === 'INCOMPLETE' && out.error.missing.length > 0).toBe(true);
    }
  });

  // ─── Auth guard ────────────────────────────────────────────────────────
  it('rejects mismatched userId with INVITE_FORBIDDEN', async () => {
    const { survey, invite } = await setupUserWithInvite();
    const { submitAnswer } = await import('../../src/services/research-survey');
    const out = await submitAnswer({
      inviteId: invite.id,
      userId: 'someone-else',
      surveyId: survey.id,
      payload: { questionId: 'q1', selectedOptionIds: ['curiosity'] },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error.code).toBe('INVITE_FORBIDDEN');
  });
});

// ─── helpers ─────────────────────────────────────────────────────────────

type SubmitAnswerFn = (params: {
  inviteId: string;
  userId: string;
  surveyId: string;
  payload: { questionId: string; selectedOptionIds: string[]; answerText?: string };
}) => Promise<{ ok: boolean } & Record<string, unknown>>;

async function answerAllRequired(
  surveyId: string,
  userId: string,
  inviteId: string,
  submitAnswer: SubmitAnswerFn,
) {
  const required: Array<{ id: string; opts: string[] }> = [
    { id: 'q1', opts: ['curiosity'] },
    { id: 'q2', opts: ['own_birthday'] },
    { id: 'q3', opts: ['url_import'] },
    { id: 'q4', opts: ['nothing_blocked'] },
    { id: 'q5', opts: ['yes_friends_family'] },
    { id: 'q6', opts: ['reminders_birthdays'] },
    { id: 'q7', opts: ['unlimited_wishlists'] },
    { id: 'q8', opts: ['somewhat_disappointed'] },
    { id: 'q9', opts: ['score_8'] },
  ];
  for (const q of required) {
    const res = await submitAnswer({
      inviteId, userId, surveyId,
      payload: { questionId: q.id, selectedOptionIds: q.opts },
    });
    if (!res.ok) {
      throw new Error(`failed to answer ${q.id}: ${JSON.stringify(res)}`);
    }
  }
}
