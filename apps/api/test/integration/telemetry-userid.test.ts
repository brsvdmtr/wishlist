// Integration tests against a real Postgres — pin the contract that
// AnalyticsEvent.userId is always the INTERNAL User.id (cuid) or NULL,
// never the Telegram numeric ID.
//
// The 2026-05-19 bug had two halves: the mock-prisma unit test for
// telemetry.routes.ts passed (it tested the path mechanically), but
// production rows ended up with String(req.tgUser.id) in userId because
// no test exercised the Prisma lookup end-to-end. This file closes that
// gap by going through registerTelemetryRouter() against a real DB.
//
// Auto-skip when DATABASE_URL is not set so `pnpm test` stays fast on a
// fresh laptop without Docker. CI provides DATABASE_URL via the
// postgres service container in .github/workflows/test.yml.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { getTestPrisma, disconnectTestPrisma } from '../setup-pg';
import { registerTelemetryRouter } from '../../src/routes/telemetry.routes';

const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;

const PREFIX = 'int-telemetry';

if (SKIP) {
  // eslint-disable-next-line no-console
  console.warn('[integration] DATABASE_URL not set — skipping telemetry-userid integration tests');
}

function makeApp(tgUser?: { id: number; first_name: string } | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (tgUser) (req as unknown as { tgUser: unknown }).tgUser = tgUser;
    next();
  });
  app.use(registerTelemetryRouter());
  return app;
}

suite('POST /telemetry — AnalyticsEvent.userId (real Postgres)', () => {
  const createdUserIds: string[] = [];
  const createdTelegramIds: string[] = [];

  beforeAll(async () => {
    const db = getTestPrisma();
    await db.analyticsEvent.deleteMany({
      where: { event: { in: ['paywall.viewed', 'wishlist.shared'] } },
    });
    await db.user.deleteMany({ where: { telegramId: { startsWith: PREFIX } } });
  });

  beforeEach(async () => {
    const db = getTestPrisma();
    await db.analyticsEvent.deleteMany({
      where: { event: { in: ['paywall.viewed', 'wishlist.shared'] } },
    });
  });

  afterAll(async () => {
    const db = getTestPrisma();
    await db.analyticsEvent.deleteMany({
      where: { event: { in: ['paywall.viewed', 'wishlist.shared'] } },
    });
    await db.user.deleteMany({ where: { id: { in: createdUserIds } } });
    await db.user.deleteMany({ where: { telegramId: { in: createdTelegramIds } } });
    await disconnectTestPrisma();
  });

  it('authenticated telemetry — stored userId equals User.id (cuid), not Telegram ID', async () => {
    const db = getTestPrisma();
    // Numeric Telegram ID, guaranteed-unique within the test DB by prefix.
    const tgIdNumeric = 9_000_000_001;
    const tgIdStr = String(tgIdNumeric);
    const user = await db.user.create({
      data: { telegramId: tgIdStr, telegramChatId: tgIdStr, firstName: `${PREFIX}-a` },
    });
    createdUserIds.push(user.id);
    createdTelegramIds.push(tgIdStr);

    const app = makeApp({ id: tgIdNumeric, first_name: 'A' });
    const res = await request(app).post('/telemetry').send({
      events: [{ event: 'paywall.viewed', ts: Date.now() }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accepted: 1, dropped: 0 });

    const rows = await db.analyticsEvent.findMany({
      where: { event: 'paywall.viewed' },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBe(user.id);
    expect(rows[0]!.userId).not.toBe(tgIdStr);
    // cuid contract: starts with 'c', 25 chars total — never digits-only.
    expect(rows[0]!.userId).toMatch(/^c[a-z0-9]{24}$/);
  });

  it('unauthenticated telemetry — stored userId is NULL', async () => {
    const db = getTestPrisma();
    const app = makeApp(null);
    const res = await request(app).post('/telemetry').send({
      events: [{ event: 'paywall.viewed', ts: Date.now() }],
    });
    expect(res.status).toBe(200);

    const rows = await db.analyticsEvent.findMany({
      where: { event: 'paywall.viewed' },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBeNull();
  });

  it('authenticated but user row does not exist yet — stored userId is NULL', async () => {
    const db = getTestPrisma();
    // Telegram ID that does NOT have a User row yet — simulates the very
    // first request from a brand-new user, where Mini App fires telemetry
    // before any User-row-creating handler has run.
    const tgIdNumeric = 9_000_000_999;
    const app = makeApp({ id: tgIdNumeric, first_name: 'GHOST' });
    const res = await request(app).post('/telemetry').send({
      events: [{ event: 'paywall.viewed', ts: Date.now() }],
    });
    expect(res.status).toBe(200);

    const rows = await db.analyticsEvent.findMany({
      where: { event: 'paywall.viewed' },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId).toBeNull();
  });

  it('JOIN against User.id is correct for the new rows (the bug-class smoke check)', async () => {
    const db = getTestPrisma();
    const tgIdNumeric = 9_000_000_777;
    const tgIdStr = String(tgIdNumeric);
    const user = await db.user.create({
      data: { telegramId: tgIdStr, telegramChatId: tgIdStr, firstName: `${PREFIX}-join` },
    });
    createdUserIds.push(user.id);
    createdTelegramIds.push(tgIdStr);

    await request(makeApp({ id: tgIdNumeric, first_name: 'J' })).post('/telemetry').send({
      events: [{ event: 'wishlist.shared', ts: Date.now() }],
    });

    // Naive JOIN must now succeed without the legacy `OR u."telegramId" = ae."userId"`
    // workaround documented in segment-sizing 2026-05-19.
    const joined = await db.$queryRaw<Array<{ event: string; first_name: string | null }>>`
      SELECT ae.event, u."firstName" AS first_name
      FROM "AnalyticsEvent" ae
      JOIN "User" u ON u.id = ae."userId"
      WHERE ae.event = 'wishlist.shared'
        AND u."telegramId" = ${tgIdStr}
    `;
    expect(joined).toHaveLength(1);
    expect(joined[0]!.event).toBe('wishlist.shared');
    expect(joined[0]!.first_name).toBe(`${PREFIX}-join`);
  });
});
