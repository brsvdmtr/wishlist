// Integration tests for the one-shot backfill migration that normalizes
// AnalyticsEvent.userId from Telegram-numeric-string to internal User.id
// (cuid). This file does NOT run the migration file directly (that's CI's
// job at deploy time); it replays the two UPDATE statements against the
// real test DB to verify the SQL handles every row class correctly.
//
// Why duplicate the SQL into the test? Prisma's migrate-deploy in CI
// runs against an empty schema — there are no AnalyticsEvent rows to
// backfill. We need to seed each row class explicitly and assert the
// UPDATE behaviour, which can only happen inside a vitest body.
//
// Auto-skip when DATABASE_URL is not set so `pnpm test` stays fast.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getTestPrisma, disconnectTestPrisma } from '../setup-pg';

const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;

const PREFIX = 'int-backfill';

if (SKIP) {
  // eslint-disable-next-line no-console
  console.warn('[integration] DATABASE_URL not set — skipping analytics-event-userid-backfill tests');
}

// Mirrors packages/db/prisma/migrations/20260519180000_normalize_analyticsevent_userid/migration.sql.
// We replay the SQL directly rather than running the migration file — the
// migration runs once per DB at deploy time; this test seeds row classes and
// asserts the UPDATE behaviour against them.
const STEP_1 = `
  UPDATE "AnalyticsEvent" ae
  SET "userId" = u.id
  FROM "User" u
  WHERE ae."userId" = u."telegramId"
    AND ae."userId" ~ '^[0-9]+$'
`;

const STEP_2 = `
  UPDATE "AnalyticsEvent"
  SET "userId" = NULL
  WHERE "userId" ~ '^[0-9]+$'
`;

suite('AnalyticsEvent.userId backfill — real Postgres', () => {
  const userIds: string[] = [];
  const tgIds: string[] = [];

  beforeAll(async () => {
    const db = getTestPrisma();
    await db.analyticsEvent.deleteMany({ where: { event: { startsWith: `${PREFIX}.` } } });
    await db.user.deleteMany({ where: { telegramId: { startsWith: PREFIX } } });
  });

  beforeEach(async () => {
    const db = getTestPrisma();
    await db.analyticsEvent.deleteMany({ where: { event: { startsWith: `${PREFIX}.` } } });
  });

  afterAll(async () => {
    const db = getTestPrisma();
    await db.analyticsEvent.deleteMany({ where: { event: { startsWith: `${PREFIX}.` } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await db.user.deleteMany({ where: { telegramId: { in: tgIds } } });
    await disconnectTestPrisma();
  });

  it('Step 1 rewrites numeric-string userId to User.id for rows with a matching User', async () => {
    const db = getTestPrisma();
    const tgIdStr = '8123456701';
    const user = await db.user.create({
      data: { telegramId: tgIdStr, telegramChatId: tgIdStr, firstName: `${PREFIX}-rewrite` },
    });
    userIds.push(user.id);
    tgIds.push(tgIdStr);

    const ae = await db.analyticsEvent.create({
      data: { event: `${PREFIX}.rewrite`, userId: tgIdStr, props: { case: 'numeric-with-user' } },
    });

    await db.$executeRawUnsafe(STEP_1);

    const after = await db.analyticsEvent.findUnique({ where: { id: ae.id } });
    expect(after!.userId).toBe(user.id);
    expect(after!.userId).not.toBe(tgIdStr);
    expect(after!.userId).toMatch(/^c[a-z0-9]{24}$/);
  });

  it('Step 2 NULLs out numeric-string userId rows whose User no longer exists (orphans)', async () => {
    const db = getTestPrisma();
    // No User row with this telegramId — simulates account deletion between
    // event emit and migration time.
    const tgIdStr = '8999999998';
    const ae = await db.analyticsEvent.create({
      data: { event: `${PREFIX}.orphan`, userId: tgIdStr, props: { case: 'orphan-numeric' } },
    });

    await db.$executeRawUnsafe(STEP_1);
    await db.$executeRawUnsafe(STEP_2);

    const after = await db.analyticsEvent.findUnique({ where: { id: ae.id } });
    expect(after!.userId).toBeNull();
  });

  it('cuid userIds are NEVER touched — neither step matches them', async () => {
    const db = getTestPrisma();
    const tgIdStr = '8123456702';
    const user = await db.user.create({
      data: { telegramId: tgIdStr, telegramChatId: tgIdStr, firstName: `${PREFIX}-cuid` },
    });
    userIds.push(user.id);
    tgIds.push(tgIdStr);

    const ae = await db.analyticsEvent.create({
      data: { event: `${PREFIX}.cuid`, userId: user.id, props: { case: 'cuid-already' } },
    });

    await db.$executeRawUnsafe(STEP_1);
    await db.$executeRawUnsafe(STEP_2);

    const after = await db.analyticsEvent.findUnique({ where: { id: ae.id } });
    expect(after!.userId).toBe(user.id);
  });

  it('NULL userIds are NEVER touched — neither step matches them', async () => {
    const db = getTestPrisma();
    const ae = await db.analyticsEvent.create({
      data: { event: `${PREFIX}.null`, userId: null, props: { case: 'null-already' } },
    });

    await db.$executeRawUnsafe(STEP_1);
    await db.$executeRawUnsafe(STEP_2);

    const after = await db.analyticsEvent.findUnique({ where: { id: ae.id } });
    expect(after!.userId).toBeNull();
  });

  it('mixed batch: rewrites where matched, NULLs orphans, leaves cuid and null untouched', async () => {
    const db = getTestPrisma();
    const tgIdStr = '8123456703';
    const user = await db.user.create({
      data: { telegramId: tgIdStr, telegramChatId: tgIdStr, firstName: `${PREFIX}-mix` },
    });
    userIds.push(user.id);
    tgIds.push(tgIdStr);

    const matched = await db.analyticsEvent.create({
      data: { event: `${PREFIX}.mix`, userId: tgIdStr, props: { tag: 'matched' } },
    });
    const orphan = await db.analyticsEvent.create({
      data: { event: `${PREFIX}.mix`, userId: '8999999997', props: { tag: 'orphan' } },
    });
    const cuid = await db.analyticsEvent.create({
      data: { event: `${PREFIX}.mix`, userId: user.id, props: { tag: 'cuid' } },
    });
    const nullRow = await db.analyticsEvent.create({
      data: { event: `${PREFIX}.mix`, userId: null, props: { tag: 'null' } },
    });

    await db.$executeRawUnsafe(STEP_1);
    await db.$executeRawUnsafe(STEP_2);

    const after = await Promise.all([
      db.analyticsEvent.findUnique({ where: { id: matched.id } }),
      db.analyticsEvent.findUnique({ where: { id: orphan.id } }),
      db.analyticsEvent.findUnique({ where: { id: cuid.id } }),
      db.analyticsEvent.findUnique({ where: { id: nullRow.id } }),
    ]);
    expect(after[0]!.userId).toBe(user.id);
    expect(after[1]!.userId).toBeNull();
    expect(after[2]!.userId).toBe(user.id);
    expect(after[3]!.userId).toBeNull();
  });
});
