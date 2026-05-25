// Deep handler tests for routes/internal.routes.ts — internal API endpoints.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

// hint.findUnique + user.findUnique are explicit + controllable; every other
// prisma.* access falls through to a permissive null stub.
const db = vi.hoisted(() => ({
  hintFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock('@wishlist/db', () => ({
  prisma: new Proxy({
    hint: { findUnique: db.hintFindUnique },
    user: { findUnique: db.userFindUnique },
  } as Record<string, unknown>, {
    get(target, key) {
      if (key in target) return target[key as string];
      return new Proxy({}, { get() { return vi.fn().mockResolvedValue(null); } });
    },
  }),
}));

vi.mock('../services/import-credits', () => ({
  getImportAllowance: vi.fn(),
  consumeImportCredit: vi.fn(),
}));

vi.mock('../services/hint-credits', () => ({
  consumeHintCharge: vi.fn(),
}));

import { getImportAllowance, consumeImportCredit } from '../services/import-credits';
import { consumeHintCharge } from '../services/hint-credits';
import { registerInternalRouter } from './internal.routes';

const mockAllowance = vi.mocked(getImportAllowance);
const mockConsume = vi.mocked(consumeImportCredit);
const mockHintCharge = vi.mocked(consumeHintCharge);

function smokeDeps() {
  return new Proxy({}, {
    get(_target, key) {
      if (key === 'then') return undefined;
      return vi.fn();
    },
  }) as Parameters<typeof registerInternalRouter>[0];
}

describe('internal — factory + boot', () => {
  it('factory returns Router with handlers', () => {
    const router = registerInternalRouter(smokeDeps()) as { stack?: unknown[] };
    expect(typeof router).toBe('function');
    expect((router.stack ?? []).length).toBeGreaterThanOrEqual(1);
  });

  it('unknown path returns 404 or 500 (permissive mocks may trigger crashes before route matching)', async () => {
    const app = express();
    app.use(express.json());
    app.use(registerInternalRouter(smokeDeps()));
    const res = await request(app).get('/internal/not-real');
    expect([404, 500]).toContain(res.status);
  });
});

describe('internal — credit endpoints', () => {
  const KEY = 'test-internal-key';
  type Deps = Parameters<typeof registerInternalRouter>[0];

  function buildDeps(over: Partial<Deps> = {}): Deps {
    return {
      getUserEntitlement: vi.fn(async () => ({ plan: { features: [] as string[] }, isPro: false })),
      importUrlForUser: vi.fn(async () => ({ parseStatus: 'ok' as const, item: { title: 'X' }, wishlistId: 'w1' })),
      DRAFTS_ITEM_LIMIT: 20,
      recordMaintenanceExposure: vi.fn(async () => 'exposure'),
      trackEvent: vi.fn(),
      ...over,
    } as Deps;
  }

  function makeApp(deps: Deps) {
    const app = express();
    app.use(express.json());
    app.use(registerInternalRouter(deps));
    return app;
  }

  const body = { userId: 'u-bot', url: 'https://example.com/p/1' };

  beforeAll(() => { process.env.BOT_TOKEN = KEY; });
  afterAll(() => { delete process.env.BOT_TOKEN; });
  beforeEach(() => {
    vi.clearAllMocks();
    db.hintFindUnique.mockResolvedValue(null);
  });

  it('FREE bot user with quota imports and a credit is consumed', async () => {
    mockAllowance.mockResolvedValue({ allowed: true, isPro: false, freeLimit: 5, freeUsed: 1, freeRemaining: 4, paidCredits: 0, source: 'free' });
    mockConsume.mockResolvedValue({ consumed: 'free', freeLimit: 5, freeUsed: 2, freeRemaining: 3, paidCredits: 0 });
    const deps = buildDeps();
    const res = await request(makeApp(deps)).post('/import-url').set('X-INTERNAL-KEY', KEY).send(body);
    expect(res.status).toBe(201);
    expect(deps.importUrlForUser).toHaveBeenCalledOnce();
    expect(mockConsume).toHaveBeenCalledWith('u-bot', { source: 'bot' });
  });

  it('exhausted quota → 402 unified addon_required envelope (same model as the Mini App)', async () => {
    mockAllowance.mockResolvedValue({ allowed: false, isPro: false, freeLimit: 5, freeUsed: 5, freeRemaining: 0, paidCredits: 0, source: 'none' });
    const deps = buildDeps();
    const res = await request(makeApp(deps)).post('/import-url').set('X-INTERNAL-KEY', KEY).send(body);
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      error: 'addon_required',
      feature: 'url_import',
      skuCode: 'import_pack_10',
    });
    expect(deps.importUrlForUser).not.toHaveBeenCalled();
    expect(mockConsume).not.toHaveBeenCalled();
  });

  it('POST /hints/credit → 404 when the hint does not exist', async () => {
    // hint.findUnique resolves null (beforeEach default) → the endpoint 404s
    // before it ever reaches consumeHintCharge.
    const res = await request(makeApp(buildDeps()))
      .post('/hints/credit')
      .set('X-INTERNAL-KEY', KEY)
      .send({ hintId: 'no-such-hint' });
    expect(res.status).toBe(404);
    expect(mockHintCharge).not.toHaveBeenCalled();
  });

  it('POST /hints/credit → charges a delivered hint and returns the result', async () => {
    db.hintFindUnique.mockResolvedValue({
      senderUserId: 'u-bot', status: 'DELIVERED', user: { godMode: false },
    });
    mockHintCharge.mockResolvedValue({
      freeLimit: 3, freeUsed: 1, freeRemaining: 2,
      outcome: 'free_monthly', charged: true,
    });
    const res = await request(makeApp(buildDeps()))
      .post('/hints/credit')
      .set('X-INTERNAL-KEY', KEY)
      .send({ hintId: 'h1' });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('free_monthly');
    expect(res.body.charged).toBe(true);
    // The route loads the hint, resolves the sender's entitlement, and threads
    // (senderUserId, hintId, status, isPro) into the service.
    expect(mockHintCharge).toHaveBeenCalledWith('u-bot', 'h1', 'DELIVERED', false);
  });

  it('POST /hints/credit → forwards a non-DELIVERED status to the service untouched', async () => {
    db.hintFindUnique.mockResolvedValue({
      senderUserId: 'u-bot', status: 'SENT', user: { godMode: false },
    });
    mockHintCharge.mockResolvedValue({
      freeLimit: 3, freeUsed: 0, freeRemaining: 3, outcome: 'not_delivered', charged: false,
    });
    const res = await request(makeApp(buildDeps()))
      .post('/hints/credit')
      .set('X-INTERNAL-KEY', KEY)
      .send({ hintId: 'h-sent' });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe('not_delivered');
    // The route threads the REAL hint status — it never assumes DELIVERED.
    expect(mockHintCharge).toHaveBeenCalledWith('u-bot', 'h-sent', 'SENT', false);
  });
});

describe('internal — maintenance/ingest-buffered', () => {
  const KEY = 'test-internal-key';
  type Deps = Parameters<typeof registerInternalRouter>[0];

  function buildDeps(over: Partial<Deps> = {}): Deps {
    return {
      getUserEntitlement: vi.fn(async () => ({ plan: { features: [] as string[] }, isPro: false })),
      importUrlForUser: vi.fn(async () => ({ parseStatus: 'ok' as const })),
      DRAFTS_ITEM_LIMIT: 20,
      recordMaintenanceExposure: vi.fn(async () => 'incident-abc'),
      trackEvent: vi.fn(),
      ...over,
    } as Deps;
  }

  function makeApp(deps: Deps) {
    const app = express();
    app.use(express.json());
    app.use(registerInternalRouter(deps));
    return app;
  }

  beforeAll(() => { process.env.BOT_TOKEN = KEY; });
  afterAll(() => { delete process.env.BOT_TOKEN; });
  beforeEach(() => {
    vi.clearAllMocks();
    db.userFindUnique.mockResolvedValue(null);
  });

  it('requires X-INTERNAL-KEY auth', async () => {
    const res = await request(makeApp(buildDeps()))
      .post('/maintenance/ingest-buffered')
      .send({ records: [] });
    expect(res.status).toBe(401);
  });

  it('rejects malformed body (records missing)', async () => {
    const res = await request(makeApp(buildDeps()))
      .post('/maintenance/ingest-buffered')
      .set('X-INTERNAL-KEY', KEY)
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects records with invalid tg_user_id', async () => {
    const res = await request(makeApp(buildDeps()))
      .post('/maintenance/ingest-buffered')
      .set('X-INTERNAL-KEY', KEY)
      .send({ records: [{ tg_user_id: 'not-a-number', _key: 'k1' }] });
    expect(res.status).toBe(400);
  });

  it('accepts empty records list', async () => {
    const deps = buildDeps();
    const res = await request(makeApp(deps))
      .post('/maintenance/ingest-buffered')
      .set('X-INTERNAL-KEY', KEY)
      .send({ records: [] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true, ingested: 0, skipped: 0, failed: 0, total: 0, ingestedKeys: [],
    });
    expect(deps.recordMaintenanceExposure).not.toHaveBeenCalled();
  });

  it('ingests records for existing users', async () => {
    db.userFindUnique.mockImplementation(({ where }) => {
      if (where?.telegramId === '42') return Promise.resolve({ id: 'u-42', telegramChatId: '42' });
      if (where?.telegramId === '43') return Promise.resolve({ id: 'u-43', telegramChatId: '43' });
      return Promise.resolve(null);
    });
    const deps = buildDeps();
    const res = await request(makeApp(deps))
      .post('/maintenance/ingest-buffered')
      .set('X-INTERNAL-KEY', KEY)
      .send({
        records: [
          { tg_user_id: 42, chat_id: 42, locale: 'ru', surface: 'static', _key: 'exposure:2026-05-25:42' },
          { tg_user_id: 43, chat_id: 43, locale: 'en', surface: 'static', _key: 'exposure:2026-05-25:43' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.ingested).toBe(2);
    expect(res.body.skipped).toBe(0);
    expect(res.body.failed).toBe(0);
    expect(res.body.ingestedKeys.sort()).toEqual([
      'exposure:2026-05-25:42', 'exposure:2026-05-25:43',
    ]);
    expect(deps.recordMaintenanceExposure).toHaveBeenCalledTimes(2);
    expect(deps.recordMaintenanceExposure).toHaveBeenCalledWith('u-42', 'static', 'ru', '42');
    expect(deps.recordMaintenanceExposure).toHaveBeenCalledWith('u-43', 'static', 'en', '43');
  });

  it('skips records for missing users but still ACKs their keys (avoid infinite buffer retry)', async () => {
    db.userFindUnique.mockResolvedValue(null);
    const deps = buildDeps();
    const res = await request(makeApp(deps))
      .post('/maintenance/ingest-buffered')
      .set('X-INTERNAL-KEY', KEY)
      .send({
        records: [
          { tg_user_id: 999, _key: 'exposure:x:999' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.ingested).toBe(0);
    expect(res.body.skipped).toBe(1);
    expect(res.body.ingestedKeys).toEqual(['exposure:x:999']);
    expect(deps.recordMaintenanceExposure).not.toHaveBeenCalled();
  });

  it('does NOT ACK a record that failed mid-ingest (recordMaintenanceExposure threw)', async () => {
    db.userFindUnique.mockResolvedValue({ id: 'u-10', telegramChatId: '10' });
    const deps = buildDeps({
      recordMaintenanceExposure: vi.fn().mockRejectedValue(new Error('DB transient')),
    });
    const res = await request(makeApp(deps))
      .post('/maintenance/ingest-buffered')
      .set('X-INTERNAL-KEY', KEY)
      .send({ records: [{ tg_user_id: 10, _key: 'exposure:x:10' }] });
    expect(res.status).toBe(200);
    expect(res.body.ingested).toBe(0);
    expect(res.body.failed).toBe(1);
    expect(res.body.ingestedKeys).toEqual([]); // unacked → watchdog will retry next round
  });

  it('falls back to user.telegramChatId when record has no chat_id', async () => {
    db.userFindUnique.mockResolvedValue({ id: 'u-7', telegramChatId: '777' });
    const deps = buildDeps();
    await request(makeApp(deps))
      .post('/maintenance/ingest-buffered')
      .set('X-INTERNAL-KEY', KEY)
      .send({ records: [{ tg_user_id: 7, locale: 'ru', surface: 'static', _key: 'k' }] });
    expect(deps.recordMaintenanceExposure).toHaveBeenCalledWith('u-7', 'static', 'ru', '777');
  });

  it('handles a mixed batch (some ingested, some skipped, some failed)', async () => {
    db.userFindUnique.mockImplementation(({ where }) => {
      if (where?.telegramId === '1') return Promise.resolve({ id: 'u-1', telegramChatId: '1' });
      if (where?.telegramId === '2') return Promise.resolve({ id: 'u-2', telegramChatId: '2' });
      return Promise.resolve(null); // tg=3 → not found
    });
    const expose = vi.fn().mockImplementation(async (userId: string) => {
      if (userId === 'u-2') throw new Error('DB blip');
      return 'inc-1';
    });
    const deps = buildDeps({ recordMaintenanceExposure: expose });
    const res = await request(makeApp(deps))
      .post('/maintenance/ingest-buffered')
      .set('X-INTERNAL-KEY', KEY)
      .send({
        records: [
          { tg_user_id: 1, _key: 'k1' },
          { tg_user_id: 2, _key: 'k2' },
          { tg_user_id: 3, _key: 'k3' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.ingested).toBe(1);
    expect(res.body.skipped).toBe(1);
    expect(res.body.failed).toBe(1);
    expect(res.body.ingestedKeys.sort()).toEqual(['k1', 'k3']);
  });
});
