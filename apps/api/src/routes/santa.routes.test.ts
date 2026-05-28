// Deep handler tests for routes/santa.routes.ts (3 763 LOC, 20+ handlers).
// Focus on the factory shape + season-gate wiring + organizer auth boundary.
// Full per-handler coverage waits until the file gets broken up; this layer
// pins the closure deps + the major path classes.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const shared = vi.hoisted(() => ({
  santaCampaign: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  santaParticipant: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  santaParticipantAlias: { findMany: vi.fn() },
  santaRound: { findUnique: vi.fn(), findMany: vi.fn() },
  santaAssignment: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
  santaNotification: { findMany: vi.fn(), updateMany: vi.fn() },
  santaHintRequest: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
  santaExclusionGroup: { findMany: vi.fn(), create: vi.fn() },
  santaExclusionGroupMember: { findMany: vi.fn() },
  santaChatMessage: { findMany: vi.fn() },
  santaItemPool: { findMany: vi.fn() },
  santaSeasonalBroadcastLog: { findMany: vi.fn() },
  santaSeasonConfig: { findUnique: vi.fn() },
  santaGlobalConfig: { findUnique: vi.fn() },
  user: { findUnique: vi.fn(), update: vi.fn() },
}));

vi.mock('@wishlist/db', () => {
  // The proxy lets handlers reach into any prisma model name without us
  // pre-declaring it in `shared`; unknown methods resolve to a permissive
  // `vi.fn().mockResolvedValue(null)`. `$transaction` is special — it runs
  // the callback against the same prisma facade so `tx.*` writes hit the
  // shared mocks. Accepts the `{ isolationLevel }` second arg used by the
  // Serializable txn in the Santa hint quota path.
  const prisma: unknown = new Proxy({}, {
    get(_target, key) {
      if (typeof key !== 'string') return undefined;
      if (key === '$transaction') {
        return async (arg: unknown, _opts?: unknown) => {
          if (typeof arg === 'function') {
            return (arg as (tx: unknown) => Promise<unknown>)(prisma);
          }
          if (Array.isArray(arg)) return Promise.all(arg as Promise<unknown>[]);
          return null;
        };
      }
      const cluster = shared as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
      if (cluster[key]) return cluster[key];
      return new Proxy({}, { get() { return vi.fn().mockResolvedValue(null); } });
    },
  });
  // Minimum Prisma namespace surface used by the route under test:
  // TransactionIsolationLevel.Serializable + PrismaClientKnownRequestError
  // for the P2034 retry catch. Body irrelevant — the stubs only need to
  // exist so the import resolves at module-load time.
  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, code: string) {
      super(message);
      this.code = code;
    }
  }
  const Prisma = {
    TransactionIsolationLevel: { Serializable: 'Serializable' as const },
    PrismaClientKnownRequestError,
  };
  return { prisma, Prisma };
});

// Analytics is a pure side-effect helper — mock it so the PRO-gate tests can
// assert on santa.gate_hit emission without a real AnalyticsEvent write.
vi.mock('../services/analytics', () => ({
  trackEvent: vi.fn(),
  trackAnalyticsEvent: vi.fn(),
  trackProductEvent: vi.fn(),
}));

import { registerSantaRouter } from './santa.routes';
import { trackProductEvent } from '../services/analytics';

function buildDeps() {
  return {
    getOrCreateTgUser: vi.fn(async () => ({ id: 'u-test', godMode: false, telegramChatId: '123', santaTestMode: false })),
    getUserEntitlement: vi.fn(async () => ({ isPro: false, plan: { code: 'FREE' } })),
    trackEvent: vi.fn(),
    mapTgItem: vi.fn((it) => it),
    sendAdminAlert: vi.fn(async () => {}),
    tgActorHash: vi.fn((id: number) => `actor-${id}`),
    getSeasonStartYear: vi.fn(() => 2026),
    getSeasonCalendar: vi.fn(() => ({ inSeason: true, seasonStart: new Date(), seasonEnd: new Date() })),
    getSantaSeasonInfo: vi.fn(async () => ({ inSeason: true, canCreate: true, seasonStart: new Date().toISOString(), seasonEnd: new Date().toISOString(), config: null })),
    sendSeasonalBroadcast: vi.fn(async () => {}),
    generateSantaAliases: vi.fn(() => []),
  } as Parameters<typeof registerSantaRouter>[0];
}

function makeApp(deps = buildDeps()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerSantaRouter(deps));
  return { app, deps };
}

beforeEach(() => {
  for (const m of Object.values(shared)) {
    for (const fn of Object.values(m)) (fn as ReturnType<typeof vi.fn>).mockReset?.();
  }
  vi.mocked(trackProductEvent).mockClear();
});

describe('santa — factory + season info', () => {
  it('factory accepts the SantaRouterDeps shape and returns a Router', () => {
    const router = registerSantaRouter(buildDeps());
    expect(typeof router).toBe('function');
  });

  it('registered handler stack has 20+ routes (large surface)', () => {
    const router = registerSantaRouter(buildDeps()) as { stack?: unknown[] };
    expect((router.stack ?? []).length).toBeGreaterThanOrEqual(20);
  });

  it('GET /santa/season → 200 with season info via deps', async () => {
    const { app, deps } = makeApp();
    const res = await request(app).get('/santa/season');
    expect(res.status).toBe(200);
    expect(deps.getSantaSeasonInfo).toHaveBeenCalled();
  });

  it('GET /santa/season forwards santaTestMode from getOrCreateTgUser', async () => {
    const deps = buildDeps();
    deps.getOrCreateTgUser = vi.fn(async () => ({ id: 'godmode-user', godMode: true, telegramChatId: '999', santaTestMode: true }));
    const { app } = makeApp(deps);

    await request(app).get('/santa/season');
    expect(deps.getSantaSeasonInfo).toHaveBeenCalledWith('godmode-user', true);
  });
});

// PRO gates: MULTI_WAVE campaign type, exclusion pairs, exclusion groups.
// Each enforces with a 402 { error: 'pro_required', feature } and emits a
// server-authoritative santa.gate_hit. See docs/MONETIZATION.md § 16b.
describe('santa — PRO gates (multi-wave / exclusions / exclusion groups)', () => {
  it('FREE user creating a MULTI_WAVE campaign → 402 pro_required + santa.gate_hit', async () => {
    const { app, deps } = makeApp();
    const res = await request(app)
      .post('/santa/campaigns')
      .send({ title: 'Office NY', type: 'MULTI_WAVE' });

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: 'pro_required', feature: 'santa_multi_wave' });
    expect(deps.getUserEntitlement).toHaveBeenCalled();
    expect(trackProductEvent).toHaveBeenCalledWith({
      event: 'santa.gate_hit',
      userId: 'u-test',
      props: { feature: 'santa_multi_wave' },
    });
  });

  it('FREE user creating a CLASSIC campaign → no gate, no santa.gate_hit', async () => {
    const { app } = makeApp();
    shared.santaCampaign.create.mockResolvedValue({
      id: 'c1', title: 'Office NY', status: 'DRAFT', inviteToken: 'tok',
      type: 'CLASSIC', seasonYear: 2026, createdAt: new Date(),
    });
    const res = await request(app).post('/santa/campaigns').send({ title: 'Office NY' });

    expect(res.status).toBe(201);
    expect(trackProductEvent).not.toHaveBeenCalled();
  });

  it('PRO user creating a MULTI_WAVE campaign → passes the gate (201)', async () => {
    const deps = buildDeps();
    deps.getUserEntitlement = vi.fn(async () => ({ isPro: true, plan: { code: 'PRO' } }));
    const { app } = makeApp(deps);
    shared.santaCampaign.create.mockResolvedValue({
      id: 'c1', title: 'Office NY', status: 'DRAFT', inviteToken: 'tok',
      type: 'MULTI_WAVE', seasonYear: 2026, createdAt: new Date(),
    });
    const res = await request(app)
      .post('/santa/campaigns')
      .send({ title: 'Office NY', type: 'MULTI_WAVE' });

    expect(res.status).toBe(201);
    expect(trackProductEvent).not.toHaveBeenCalled();
  });

  it('FREE owner adding an exclusion pair → 402 pro_required + santa.gate_hit', async () => {
    const { app } = makeApp();
    shared.santaCampaign.findUnique.mockResolvedValue({ ownerId: 'u-test' });
    const res = await request(app)
      .post('/santa/campaigns/c1/exclusions')
      .send({ userId1: 'a', userId2: 'b' });

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: 'pro_required', feature: 'santa_exclusions' });
    expect(trackProductEvent).toHaveBeenCalledWith({
      event: 'santa.gate_hit',
      userId: 'u-test',
      props: { feature: 'santa_exclusions' },
    });
  });

  it('FREE owner creating an exclusion group → 402 pro_required + santa.gate_hit', async () => {
    const { app } = makeApp();
    shared.santaCampaign.findUnique.mockResolvedValue({ ownerId: 'u-test' });
    const res = await request(app)
      .post('/santa/campaigns/c1/exclusions/groups')
      .send({ label: 'Family' });

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ error: 'pro_required', feature: 'santa_exclusion_groups' });
    expect(trackProductEvent).toHaveBeenCalledWith({
      event: 'santa.gate_hit',
      userId: 'u-test',
      props: { feature: 'santa_exclusion_groups' },
    });
  });

  // Regression: POST /exclusions/groups with only { label } (no memberUserIds)
  // must not 400. zod's `.default([])` re-validates the substituted [] through
  // the inner array type, so a stray `.min(2)` there rejected the
  // omitted-field case — a PRO user tapping "create exclusion group" got a
  // 400 and no group. The Mini App `createGroup` sends exactly { label }.
  it('PRO owner creating an exclusion group with only { label } → 201, empty group', async () => {
    const deps = buildDeps();
    deps.getUserEntitlement = vi.fn(async () => ({ isPro: true, plan: { code: 'PRO' } }));
    const { app } = makeApp(deps);
    shared.santaCampaign.findUnique.mockResolvedValue({ ownerId: 'u-test' });
    shared.santaExclusionGroup.create.mockResolvedValue({ id: 'g1', label: 'Family', members: [] });

    const res = await request(app)
      .post('/santa/campaigns/c1/exclusions/groups')
      .send({ label: 'Family' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ group: { id: 'g1', label: 'Family', members: [] } });
  });
});

// Santa hint quota (Conservative pricing 2026-05-28): FREE gets 1/campaign,
// PRO unlimited. The endpoint used to be a hard PRO gate; opening it to FREE
// without a cap would let a single user spam the receiver across rounds, so
// the cap counts every prior SantaHintRequest in the campaign regardless of
// status. PENDING idempotency still returns the existing row at 200 without
// consuming the allowance.
describe('santa — hint quota (POST /santa/campaigns/:id/hints)', () => {
  function mockJoinedAssignment() {
    shared.santaParticipant.findUnique.mockResolvedValue({
      id: 'p-giver', userId: 'u-test', status: 'JOINED',
    });
    shared.santaCampaign.findUnique.mockResolvedValue({
      status: 'ACTIVE', currentRoundId: 'r-1',
    });
    shared.santaAssignment.findUnique.mockResolvedValue({
      id: 'a-1',
      receiverParticipantId: 'p-receiver',
      receiver: { linkedWishlistId: 'wl-1' },
    });
    shared.santaHintRequest.findFirst.mockResolvedValue(null); // no PENDING idempotency
  }

  it('FREE giver, 0 prior hints → 201, creates hint', async () => {
    const { app } = makeApp();
    mockJoinedAssignment();
    shared.santaHintRequest.count.mockResolvedValue(0);
    shared.santaHintRequest.create.mockResolvedValue({
      id: 'h-1', status: 'PENDING', requestedAt: new Date(), expiresAt: new Date(Date.now() + 48 * 3600_000),
      selectedItemIds: [], notificationSentAt: null,
    });

    const res = await request(app).post('/santa/campaigns/c1/hints').send({});

    expect(res.status).toBe(201);
    expect(shared.santaHintRequest.create).toHaveBeenCalled();
    expect(trackProductEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'santa.gate_hit' }),
    );
  });

  it('FREE giver, 1 prior hint → 402 pro_required + paywall envelope + santa.gate_hit', async () => {
    const { app } = makeApp();
    mockJoinedAssignment();
    shared.santaHintRequest.count.mockResolvedValue(1); // already used the freebie

    const res = await request(app).post('/santa/campaigns/c1/hints').send({});

    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({
      error: 'pro_required',
      feature: 'santa_hint',
      paywall: 'santa_hint',
      planCode: 'FREE',
    });
    expect(shared.santaHintRequest.create).not.toHaveBeenCalled();
    // Analytics naming matches the other 3 Santa PRO-gates (`santa.gate_hit`,
    // `props.feature` names the surface). `limit: 1` is the explicit cap; the
    // funnel dashboard groups across feature gates by `props.limit`.
    expect(trackProductEvent).toHaveBeenCalledWith({
      event: 'santa.gate_hit',
      userId: 'u-test',
      props: expect.objectContaining({
        feature: 'santa_hint',
        plan: 'FREE',
        limit: 1,
        previousCount: 1,
      }),
    });
  });

  it('PRO giver, any prior count → 201, no quota check', async () => {
    const deps = buildDeps();
    deps.getUserEntitlement = vi.fn(async () => ({ isPro: true, plan: { code: 'PRO' } }));
    const { app } = makeApp(deps);
    mockJoinedAssignment();
    shared.santaHintRequest.create.mockResolvedValue({
      id: 'h-2', status: 'PENDING', requestedAt: new Date(), expiresAt: new Date(Date.now() + 48 * 3600_000),
      selectedItemIds: [], notificationSentAt: null,
    });

    const res = await request(app).post('/santa/campaigns/c1/hints').send({});

    expect(res.status).toBe(201);
    expect(shared.santaHintRequest.count).not.toHaveBeenCalled();
    expect(shared.santaHintRequest.create).toHaveBeenCalled();
  });

  it('FREE giver with PENDING idempotency → 200, no cap check, no new create', async () => {
    const { app } = makeApp();
    mockJoinedAssignment();
    shared.santaHintRequest.findFirst.mockResolvedValue({
      id: 'h-existing', status: 'PENDING', requestedAt: new Date(),
      expiresAt: new Date(Date.now() + 48 * 3600_000),
      selectedItemIds: [], notificationSentAt: null,
    });

    const res = await request(app).post('/santa/campaigns/c1/hints').send({});

    expect(res.status).toBe(200);
    expect(shared.santaHintRequest.count).not.toHaveBeenCalled();
    expect(shared.santaHintRequest.create).not.toHaveBeenCalled();
  });
});
