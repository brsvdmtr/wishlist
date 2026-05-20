// Integration test for selectSurveyRecipients — runs the raw SQL paths
// for S5 (guest reservers via ReservationMeta) and the S8 guest-engagement
// branch (ReservationMeta joined through Item → Wishlist) against the real
// schema. The 2026-05-19 dry-run regression came from these two queries
// referencing wrong columns; both passed the unit tests because those
// stayed in pure-stratification territory. This file pins the SQL itself.
//
// Auto-skips when DATABASE_URL is not set.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getTestPrisma, disconnectTestPrisma } from '../setup-pg';

const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;

const PREFIX = 'int-recip';
const SURVEY_SLUG = `pmf-discovery-${PREFIX}`;

if (SKIP) {
  // eslint-disable-next-line no-console
  console.warn('[integration] DATABASE_URL not set — skipping research-survey-recipients integration tests');
}

suite('selectSurveyRecipients — segment SQL on real schema', () => {
  async function cleanOwnData() {
    const db = getTestPrisma();
    // Order matters — cascade hits Answer/Response/Invite when the
    // ResearchSurvey row is dropped, then we sweep ReservationMeta /
    // Item / Wishlist / Profile / User using the PREFIX-scoped
    // telegramId so we never touch real fixtures.
    await db.researchSurvey.deleteMany({ where: { slug: SURVEY_SLUG } });
    await db.reservationMeta.deleteMany({
      where: { OR: [
        { reserverUserId: { in: await ownIds(db) } },
        { item: { wishlist: { ownerId: { in: await ownIds(db) } } } },
      ] },
    });
    await db.item.deleteMany({ where: { wishlist: { ownerId: { in: await ownIds(db) } } } });
    await db.wishlist.deleteMany({ where: { ownerId: { in: await ownIds(db) } } });
    await db.userProfile.deleteMany({ where: { user: { telegramId: { startsWith: PREFIX } } } });
    await db.user.deleteMany({ where: { telegramId: { startsWith: PREFIX } } });
  }

  async function ownIds(db: ReturnType<typeof getTestPrisma>): Promise<string[]> {
    const rows = await db.user.findMany({
      where: { telegramId: { startsWith: PREFIX } },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  beforeAll(async () => { await cleanOwnData(); });
  afterAll(async () => { await cleanOwnData(); await disconnectTestPrisma(); });
  beforeEach(async () => { await cleanOwnData(); });

  function nextTg(): string {
    return `${PREFIX}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function makeProfile(userId: string, locale = 'ru') {
    const db = getTestPrisma();
    await db.userProfile.create({
      data: {
        userId,
        languageMode: 'manual',
        manualLanguage: locale,
        normalizedLocale: locale,
        notifyMarketing: true,
      },
    });
  }

  async function makeUser(
    opts: { telegramId?: string; createdAt?: Date; locale?: string; reachable?: boolean } = {},
  ) {
    const db = getTestPrisma();
    const u = await db.user.create({
      data: {
        telegramId: opts.telegramId ?? nextTg(),
        telegramChatId: '111',
        createdAt: opts.createdAt ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      },
    });
    await makeProfile(u.id, opts.locale ?? 'ru');
    // loadEligiblePool requires ≥1 delivered LifecycleTouch (bot-reachability),
    // so the default fixture user gets one. Pass reachable:false to model a
    // Mini-App-only user the bot has no DM chat with.
    if (opts.reachable !== false) await makeLifecycleTouch(u.id);
    return u;
  }

  // Inserts a LifecycleTouch. sentAt is 10 days ago — old enough to clear the
  // base filter's "no touch in the last 24h" window. delivered defaults to
  // true (the bot-reachability signal); pass false to model an undelivered
  // touch. segment/messageKind are arbitrary — loadEligiblePool reads only
  // sentAt and delivered.
  async function makeLifecycleTouch(userId: string, delivered = true) {
    const db = getTestPrisma();
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await db.lifecycleTouch.create({
      data: {
        userId,
        segment: 'S1',
        episodeKey: `ep_${Math.random().toString(36).slice(2, 8)}`,
        touchNumber: 1,
        scheduledFor: tenDaysAgo,
        sentAt: tenDaysAgo,
        delivered,
        messageKind: 'activation',
      },
    });
  }

  async function makeWishlistWithItem(ownerId: string, opts: { shareToken?: string | null; shareOpenCount?: number } = {}) {
    const db = getTestPrisma();
    const w = await db.wishlist.create({
      data: {
        ownerId,
        slug: `wl_${Math.random().toString(36).slice(2, 8)}`,
        title: 'Test wishlist',
        type: 'REGULAR',
        shareToken: opts.shareToken ?? null,
        shareOpenCount: opts.shareOpenCount ?? 0,
      },
    });
    const item = await db.item.create({
      data: {
        wishlistId: w.id,
        title: 'Real item',
        url: 'https://example.com/item',
        isDemo: false,
        status: 'AVAILABLE',
      },
    });
    return { wishlist: w, item };
  }

  async function makeSurvey() {
    const db = getTestPrisma();
    return db.researchSurvey.create({
      data: { slug: SURVEY_SLUG, version: 1, status: 'ACTIVE', openedAt: new Date() },
    });
  }

  // ─── S5 — guest reservers via ReservationMeta ────────────────────────
  it('S5: classifies a user who reserved a foreign item via ReservationMeta', async () => {
    const db = getTestPrisma();
    const survey = await makeSurvey();
    const owner = await makeUser({ telegramId: `${PREFIX}-own1` });
    const reserver = await makeUser({ telegramId: `${PREFIX}-res1` });
    const { item } = await makeWishlistWithItem(owner.id);
    await db.reservationMeta.create({
      data: { itemId: item.id, reserverUserId: reserver.id, active: true },
    });

    const { selectSurveyRecipients } = await import('../../src/services/research-survey/recipients');
    const report = await selectSurveyRecipients({
      surveyId: survey.id,
      surveySlug: SURVEY_SLUG,
      s8Cap: 150,
      shuffleSeed: 1,
      now: new Date(),
    });
    // Both users meet the base filter; owner lands in S1 (has real item),
    // reserver lands in S5 (foreign reservation). Priority order in
    // selectSurveyRecipients is S7 → S5 → S3 → S1 → S2 → S8, so S5 wins
    // for the reserver.
    const reserverPick = report.recipients.find((r) => r.userId === reserver.id);
    expect(reserverPick?.segmentId).toBe('S5');
    const ownerPick = report.recipients.find((r) => r.userId === owner.id);
    expect(ownerPick?.segmentId).toBe('S1');
  });

  it('S5: excludes self-reservation (owner reserving own item)', async () => {
    const db = getTestPrisma();
    const survey = await makeSurvey();
    const owner = await makeUser({ telegramId: `${PREFIX}-self1` });
    const { item } = await makeWishlistWithItem(owner.id);
    await db.reservationMeta.create({
      data: { itemId: item.id, reserverUserId: owner.id, active: true },
    });
    const { selectSurveyRecipients } = await import('../../src/services/research-survey/recipients');
    const report = await selectSurveyRecipients({
      surveyId: survey.id, surveySlug: SURVEY_SLUG, s8Cap: 150, shuffleSeed: 1, now: new Date(),
    });
    const pick = report.recipients.find((r) => r.userId === owner.id);
    // Owner has a real item → S1, not S5 (since the self-reservation is filtered).
    expect(pick?.segmentId).toBe('S1');
  });

  it('S5: ignores inactive ReservationMeta rows', async () => {
    const db = getTestPrisma();
    const survey = await makeSurvey();
    const owner = await makeUser({ telegramId: `${PREFIX}-own2` });
    const reserver = await makeUser({ telegramId: `${PREFIX}-res2` });
    const { item } = await makeWishlistWithItem(owner.id);
    await db.reservationMeta.create({
      data: { itemId: item.id, reserverUserId: reserver.id, active: false, endedAt: new Date() },
    });
    const { selectSurveyRecipients } = await import('../../src/services/research-survey/recipients');
    const report = await selectSurveyRecipients({
      surveyId: survey.id, surveySlug: SURVEY_SLUG, s8Cap: 150, shuffleSeed: 1, now: new Date(),
    });
    // Reserver has no other footprint → falls to S8 (opened_only inactive),
    // not S5.
    const pick = report.recipients.find((r) => r.userId === reserver.id);
    expect(pick?.segmentId === 'S5').toBe(false);
  });

  // ─── S8 substrata: activated_then_churned vs shared_no_guest_action ──
  it('S8: activated_then_churned when inactive user has a foreign reservation on their wishlist', async () => {
    const db = getTestPrisma();
    const survey = await makeSurvey();
    const inactiveUser = await makeUser({
      telegramId: `${PREFIX}-inact1`,
      // Ensure updatedAt is also old enough to count as inactive (>30d).
      // Prisma's @updatedAt triggers on writes, so we override after create.
    });
    await db.user.update({
      where: { id: inactiveUser.id },
      data: { updatedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
    });
    const reserver = await makeUser({ telegramId: `${PREFIX}-foreign1` });
    const { item } = await makeWishlistWithItem(inactiveUser.id, { shareToken: 'tok1', shareOpenCount: 0 });
    await db.reservationMeta.create({
      data: { itemId: item.id, reserverUserId: reserver.id, active: true },
    });
    const { selectSurveyRecipients } = await import('../../src/services/research-survey/recipients');
    const report = await selectSurveyRecipients({
      surveyId: survey.id, surveySlug: SURVEY_SLUG, s8Cap: 150, shuffleSeed: 1, now: new Date(),
    });
    // Inactive owner with shareToken AND a guest reservation = activated_then_churned.
    const pick = report.recipients.find((r) => r.userId === inactiveUser.id);
    // The owner is also a reserver in S5? No — they didn't reserve a foreign
    // item, so they fall through to S8 stratification.
    expect(pick?.segmentId).toBe('S8');
    expect(pick?.segmentSubtype).toBe('activated_then_churned');
  });

  it('S8: shared_no_guest_action when inactive user has shareToken but no foreign reservation and zero opens', async () => {
    const db = getTestPrisma();
    const survey = await makeSurvey();
    const inactiveUser = await makeUser({ telegramId: `${PREFIX}-inact2` });
    await db.user.update({
      where: { id: inactiveUser.id },
      data: { updatedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) },
    });
    await makeWishlistWithItem(inactiveUser.id, { shareToken: 'tok2', shareOpenCount: 0 });
    const { selectSurveyRecipients } = await import('../../src/services/research-survey/recipients');
    const report = await selectSurveyRecipients({
      surveyId: survey.id, surveySlug: SURVEY_SLUG, s8Cap: 150, shuffleSeed: 1, now: new Date(),
    });
    const pick = report.recipients.find((r) => r.userId === inactiveUser.id);
    expect(pick?.segmentId).toBe('S8');
    expect(pick?.segmentSubtype).toBe('shared_no_guest_action');
  });

  // ─── Base-filter exclusions ──────────────────────────────────────────
  it('excludes godMode users entirely', async () => {
    const db = getTestPrisma();
    const survey = await makeSurvey();
    const u = await makeUser({ telegramId: `${PREFIX}-god1` });
    await db.user.update({ where: { id: u.id }, data: { godMode: true } });
    await makeWishlistWithItem(u.id);
    const { selectSurveyRecipients } = await import('../../src/services/research-survey/recipients');
    const report = await selectSurveyRecipients({
      surveyId: survey.id, surveySlug: SURVEY_SLUG, s8Cap: 150, shuffleSeed: 1, now: new Date(),
    });
    expect(report.recipients.find((r) => r.userId === u.id)).toBeUndefined();
  });

  it('excludes notifyMarketing=false users', async () => {
    const db = getTestPrisma();
    const survey = await makeSurvey();
    const u = await makeUser({ telegramId: `${PREFIX}-opt1` });
    await db.userProfile.update({
      where: { userId: u.id },
      data: { notifyMarketing: false },
    });
    await makeWishlistWithItem(u.id);
    const { selectSurveyRecipients } = await import('../../src/services/research-survey/recipients');
    const report = await selectSurveyRecipients({
      surveyId: survey.id, surveySlug: SURVEY_SLUG, s8Cap: 150, shuffleSeed: 1, now: new Date(),
    });
    expect(report.recipients.find((r) => r.userId === u.id)).toBeUndefined();
  });

  it('excludes users younger than 7 days', async () => {
    const survey = await makeSurvey();
    const u = await makeUser({
      telegramId: `${PREFIX}-new1`,
      createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
    });
    await makeWishlistWithItem(u.id);
    const { selectSurveyRecipients } = await import('../../src/services/research-survey/recipients');
    const report = await selectSurveyRecipients({
      surveyId: survey.id, surveySlug: SURVEY_SLUG, s8Cap: 150, shuffleSeed: 1, now: new Date(),
    });
    expect(report.recipients.find((r) => r.userId === u.id)).toBeUndefined();
  });

  // ─── Bot-reachability filter ─────────────────────────────────────────
  it('keeps a bot-reachable user and drops one with no delivered LifecycleTouch', async () => {
    const survey = await makeSurvey();
    // Reachable — has a delivered LifecycleTouch (makeUser default).
    const reachable = await makeUser({ telegramId: `${PREFIX}-reach1` });
    await makeWishlistWithItem(reachable.id);
    // Unreachable — Mini-App-only user, the bot never delivered a DM.
    const unreachable = await makeUser({ telegramId: `${PREFIX}-unreach1`, reachable: false });
    await makeWishlistWithItem(unreachable.id);

    const { selectSurveyRecipients } = await import('../../src/services/research-survey/recipients');
    const report = await selectSurveyRecipients({
      surveyId: survey.id, surveySlug: SURVEY_SLUG, s8Cap: 150, shuffleSeed: 1, now: new Date(),
    });

    // Reachable user is selected — has a real item → S1.
    expect(report.recipients.find((r) => r.userId === reachable.id)?.segmentId).toBe('S1');
    // Unreachable user is dropped by the base filter, before segment matching.
    expect(report.recipients.find((r) => r.userId === unreachable.id)).toBeUndefined();
    // ...and the report attributes the drop. >= 1 (not exactly 1):
    // loadEligiblePool's candidate count spans the whole base pool and the
    // integration DB is shared with parallel workers — only our own drop
    // is guaranteed to be counted.
    expect(report.skipped.notReachable).toBeGreaterThanOrEqual(1);
  });

  it('excludes a user whose only LifecycleTouch has delivered=false', async () => {
    const survey = await makeSurvey();
    // reachable:false → no default touch; add one that was never delivered.
    const u = await makeUser({ telegramId: `${PREFIX}-undeliv1`, reachable: false });
    await makeLifecycleTouch(u.id, false);
    await makeWishlistWithItem(u.id);

    const { selectSurveyRecipients } = await import('../../src/services/research-survey/recipients');
    const report = await selectSurveyRecipients({
      surveyId: survey.id, surveySlug: SURVEY_SLUG, s8Cap: 150, shuffleSeed: 1, now: new Date(),
    });
    // A touch row exists but was never delivered → still unreachable.
    expect(report.recipients.find((r) => r.userId === u.id)).toBeUndefined();
  });

  it('produces NO write side-effects (read-only)', async () => {
    const db = getTestPrisma();
    const survey = await makeSurvey();
    await makeUser({ telegramId: `${PREFIX}-readonly1` });
    // Counts MUST be scoped to this test's survey. An unscoped global count()
    // flakes: vitest runs integration files in parallel workers against the
    // same DB, and a sibling (research-survey.test.ts) writes invites/
    // responses/answers that can land between the pre and post snapshots.
    const countOwn = async () => ({
      invites: await db.researchSurveyInvite.count({ where: { surveyId: survey.id } }),
      responses: await db.researchSurveyResponse.count({ where: { surveyId: survey.id } }),
      answers: await db.researchSurveyAnswer.count({
        where: { response: { surveyId: survey.id } },
      }),
    });
    const pre = await countOwn();
    const { selectSurveyRecipients } = await import('../../src/services/research-survey/recipients');
    await selectSurveyRecipients({
      surveyId: survey.id, surveySlug: SURVEY_SLUG, s8Cap: 150, shuffleSeed: 1, now: new Date(),
    });
    const post = await countOwn();
    expect(post).toEqual(pre);
  });
});
