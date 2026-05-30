// Deep handler tests for routes/santa.routes.ts (3 763 LOC, 20+ handlers).
// Focus on the factory shape + season-gate wiring + organizer auth boundary.
// Full per-handler coverage waits until the file gets broken up; this layer
// pins the closure deps + the major path classes.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const shared = vi.hoisted(() => ({
  santaCampaign: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  santaParticipant: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  santaParticipantAlias: { findMany: vi.fn(), createMany: vi.fn() },
  santaRound: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
  santaAssignment: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn(), createMany: vi.fn() },
  santaExclusion: { findMany: vi.fn() },
  santaNotification: { findMany: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
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

  it('FREE user creating a CLASSIC campaign → no gate, emits santa.campaign_created', async () => {
    const { app } = makeApp();
    shared.santaCampaign.create.mockResolvedValue({
      id: 'c1', title: 'Office NY', status: 'DRAFT', inviteToken: 'tok',
      type: 'CLASSIC', seasonYear: 2026, createdAt: new Date(),
    });
    const res = await request(app).post('/santa/campaigns').send({ title: 'Office NY' });

    expect(res.status).toBe(201);
    // CLASSIC has no PRO gate — gate_hit must NOT fire…
    expect(trackProductEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'santa.gate_hit' }),
    );
    // …but the funnel event does (top of the organizer funnel).
    expect(trackProductEvent).toHaveBeenCalledWith({
      event: 'santa.campaign_created',
      userId: 'u-test',
      props: { campaignId: 'c1', type: 'CLASSIC', seasonYear: 2026 },
    });
  });

  it('PRO user creating a MULTI_WAVE campaign → passes the gate (201), emits santa.campaign_created', async () => {
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
    // Gate passes for PRO — no gate_hit…
    expect(trackProductEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'santa.gate_hit' }),
    );
    // …and the funnel event carries the MULTI_WAVE type dimension.
    expect(trackProductEvent).toHaveBeenCalledWith({
      event: 'santa.campaign_created',
      userId: 'u-test',
      props: { campaignId: 'c1', type: 'MULTI_WAVE', seasonYear: 2026 },
    });
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

// ─────────────────────────────────────────────────────────────────────────
// Funnel analytics: santa.campaign_created / invite_clicked / joined /
// draw_completed / reveal_opened. Five server-emitted events feeding the
// seasonal Secret Santa funnel (docs/research/santa-funnel-sql.md). The two
// santa.paywall_* events are client-emitted from the Mini App and already
// live in PRODUCT_EVENTS; they are not exercised here.
//
// PRIVACY CONTRACT (task self-check #5): no giver↔receiver assignment
// identity may reach AnalyticsEvent.props. sanitizeAnalyticsProps is a NAME
// denylist that would NOT strip a key like `giverParticipantId`, so the
// guarantee is enforced at the call-site and pinned by the last test below.
// ─────────────────────────────────────────────────────────────────────────
describe('santa — funnel analytics events', () => {
  // Prop keys that would betray a giver↔receiver pairing — or leak the
  // free-text gift note carried on the reveal assignment row — if they ever
  // surfaced in props.
  const FORBIDDEN_KEYS = [
    'giver', 'receiver', 'giverid', 'receiverid', 'giverparticipantid',
    'receiverparticipantid', 'assignments', 'assignmentid', 'alias', 'giveralias',
    'giftnote', 'giftnotetext',
  ];

  // Loose shape over the typed trackProductEvent call args, filtered to santa.*.
  function santaProductEventCalls() {
    return vi.mocked(trackProductEvent).mock.calls
      .map((c) => c[0] as { event?: string; userId?: string; props?: Record<string, unknown> })
      .filter((a) => typeof a.event === 'string' && a.event.startsWith('santa.'));
  }

  // Scan every santa.* event the just-exercised handler emitted for a leak:
  // neither a forbidden KEY (a pairing-shaped prop name) nor a forbidden VALUE
  // (a giver/receiver/participant id that is in scope in the handler under test
  // and must not reach props). Centralises the scan so each privacy test only
  // declares its own scenario secrets.
  function assertNoIdentityLeak(forbiddenValues: string[]) {
    const calls = santaProductEventCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const props = (call.props ?? {}) as Record<string, unknown>;
      const keys = Object.keys(props).map((k) => k.toLowerCase());
      for (const forbidden of FORBIDDEN_KEYS) {
        expect(keys).not.toContain(forbidden);
      }
      const serialized = JSON.stringify(props);
      for (const v of forbiddenValues) {
        expect(serialized).not.toContain(v);
      }
    }
  }

  it('campaign creation writes santa.campaign_created', async () => {
    const { app } = makeApp();
    shared.santaCampaign.create.mockResolvedValue({
      id: 'c-fun', title: 'NY', status: 'DRAFT', inviteToken: 'tok',
      type: 'CLASSIC', seasonYear: 2026, createdAt: new Date(),
    });

    const res = await request(app).post('/santa/campaigns').send({ title: 'NY' });

    expect(res.status).toBe(201);
    expect(trackProductEvent).toHaveBeenCalledWith({
      event: 'santa.campaign_created',
      userId: 'u-test',
      props: { campaignId: 'c-fun', type: 'CLASSIC', seasonYear: 2026 },
    });
  });

  it('valid invite resolution writes santa.invite_clicked', async () => {
    const { app } = makeApp();
    shared.santaCampaign.findUnique.mockResolvedValue({
      id: 'c-inv', title: 'NY', description: null, status: 'OPEN', type: 'CLASSIC',
      seasonYear: 2026, minBudget: null, maxBudget: null, currency: 'RUB',
      owner: { firstName: 'Org', profile: null }, _count: { participants: 3 },
    });
    shared.santaParticipant.findFirst.mockResolvedValue(null); // not already joined

    const res = await request(app).get('/santa/invite/tok-123');

    expect(res.status).toBe(200);
    expect(trackProductEvent).toHaveBeenCalledWith({
      event: 'santa.invite_clicked',
      userId: 'u-test',
      props: { campaignId: 'c-inv', alreadyJoined: false },
    });
  });

  it('dead invite (404) does NOT emit santa.invite_clicked', async () => {
    const { app } = makeApp();
    shared.santaCampaign.findUnique.mockResolvedValue(null); // unknown token

    const res = await request(app).get('/santa/invite/nope');

    expect(res.status).toBe(404);
    expect(trackProductEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'santa.invite_clicked' }),
    );
  });

  it('fresh join writes santa.joined (rejoin:false)', async () => {
    const { app } = makeApp();
    shared.santaCampaign.findUnique.mockResolvedValue({ status: 'OPEN', ownerId: 'owner-x' });
    shared.santaParticipant.findUnique.mockResolvedValue(null); // not yet a participant
    shared.santaParticipant.create.mockResolvedValue({ id: 'p-new' });
    shared.santaNotification.create.mockResolvedValue({}); // owner-notify (fire-and-forget)

    const res = await request(app).post('/santa/campaigns/c-join/join').send({});

    expect(res.status).toBe(201);
    expect(trackProductEvent).toHaveBeenCalledWith({
      event: 'santa.joined',
      userId: 'u-test',
      props: { campaignId: 'c-join', rejoin: false },
    });
  });

  it('idempotent already-JOINED re-POST does NOT re-emit santa.joined', async () => {
    const { app } = makeApp();
    shared.santaCampaign.findUnique.mockResolvedValue({ status: 'OPEN', ownerId: 'owner-x' });
    shared.santaParticipant.findUnique.mockResolvedValue({ id: 'p-old', status: 'JOINED' });

    const res = await request(app).post('/santa/campaigns/c-join/join').send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, alreadyJoined: true });
    expect(trackProductEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: 'santa.joined' }),
    );
  });

  it('draw writes santa.draw_completed with aggregate counts only (no pairing leak)', async () => {
    const { app } = makeApp();
    // Sentinel ids: drawRandomAssignments builds an in-scope `assignments` array
    // of giver→receiver pairs from these, three lines above the emit. The exact
    // props assertion pins the shape; assertNoIdentityLeak proves none of the
    // pair ids leaked — the structurally riskiest site, per review finding #1.
    shared.santaCampaign.findUnique.mockResolvedValue({ ownerId: 'u-test', status: 'LOCKED', id: 'c-draw' });
    shared.santaParticipant.findMany.mockResolvedValue([
      { id: 'pid-giver-SECRET-1', userId: 'uid-SECRET-1', user: { firstName: 'A' } },
      { id: 'pid-giver-SECRET-2', userId: 'uid-SECRET-2', user: { firstName: 'B' } },
    ]);
    shared.santaExclusion.findMany.mockResolvedValue([]);
    shared.santaExclusionGroup.findMany.mockResolvedValue([]);
    shared.santaCampaign.updateMany.mockResolvedValue({ count: 1 });
    shared.santaRound.findFirst.mockResolvedValue(null); // no pending round, no prior round
    shared.santaRound.create.mockResolvedValue({ id: 'r-1', roundNumber: 1, campaignId: 'c-draw', drawStatus: 'IN_PROGRESS' });
    shared.santaAssignment.createMany.mockResolvedValue({ count: 2 });
    shared.santaParticipantAlias.createMany.mockResolvedValue({ count: 0 });
    shared.santaRound.update.mockResolvedValue({});
    shared.santaCampaign.update.mockResolvedValue({});

    const res = await request(app).post('/santa/campaigns/c-draw/draw').send({});

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, assignmentCount: 2 });
    expect(trackProductEvent).toHaveBeenCalledWith({
      event: 'santa.draw_completed',
      userId: 'u-test',
      props: { campaignId: 'c-draw', roundId: 'r-1', roundNumber: 1, participantCount: 2, assignmentCount: 2 },
    });
    assertNoIdentityLeak(['pid-giver-SECRET-1', 'pid-giver-SECRET-2', 'uid-SECRET-1', 'uid-SECRET-2']);
  });

  it('draw on an existing PENDING round emits that round number (multi-wave path)', async () => {
    const { app } = makeApp();
    // Subsequent-round path: a PENDING round already exists, so the handler
    // UPDATEs it (no create) and round.roundNumber comes from the findFirst row.
    // Pins that the emit reads the number off the existing round, not create.
    shared.santaCampaign.findUnique.mockResolvedValue({ ownerId: 'u-test', status: 'LOCKED', id: 'c-draw' });
    shared.santaParticipant.findMany.mockResolvedValue([
      { id: 'p1', userId: 'u1', user: { firstName: 'A' } },
      { id: 'p2', userId: 'u2', user: { firstName: 'B' } },
    ]);
    shared.santaExclusion.findMany.mockResolvedValue([]);
    shared.santaExclusionGroup.findMany.mockResolvedValue([]);
    shared.santaCampaign.updateMany.mockResolvedValue({ count: 1 });
    shared.santaRound.findFirst.mockResolvedValue({ id: 'r-2', roundNumber: 2, campaignId: 'c-draw', drawStatus: 'PENDING' });
    shared.santaAssignment.createMany.mockResolvedValue({ count: 2 });
    shared.santaParticipantAlias.createMany.mockResolvedValue({ count: 0 });
    shared.santaRound.update.mockResolvedValue({});
    shared.santaCampaign.update.mockResolvedValue({});

    const res = await request(app).post('/santa/campaigns/c-draw/draw').send({});

    expect(res.status).toBe(200);
    expect(shared.santaRound.create).not.toHaveBeenCalled(); // existing round → UPDATE path
    expect(trackProductEvent).toHaveBeenCalledWith({
      event: 'santa.draw_completed',
      userId: 'u-test',
      props: { campaignId: 'c-draw', roundId: 'r-2', roundNumber: 2, participantCount: 2, assignmentCount: 2 },
    });
  });

  it('reveal writes santa.reveal_opened (isFirstReveal:true)', async () => {
    const { app } = makeApp();
    shared.santaParticipant.findUnique.mockResolvedValue({ id: 'p-recv', userId: 'u-test', status: 'JOINED' });
    shared.santaCampaign.findUnique.mockResolvedValue({ status: 'ACTIVE', currentRoundId: 'r-1' });
    shared.santaAssignment.findUnique.mockResolvedValue({
      id: 'a-1', giftStatus: 'RECEIVED', revealedAt: null, giftNote: null,
      giver: { id: 'p-giver-SECRET' },
    });
    shared.santaAssignment.update.mockResolvedValue({});
    shared.santaParticipantAlias.findMany.mockResolvedValue([]);

    const res = await request(app).get('/santa/campaigns/c-rev/reveal');

    expect(res.status).toBe(200);
    expect(trackProductEvent).toHaveBeenCalledWith({
      event: 'santa.reveal_opened',
      userId: 'u-test',
      props: { campaignId: 'c-rev', isFirstReveal: true },
    });
  });

  it('reveal handler leaks no giver identity in any santa.* event props', async () => {
    const { app } = makeApp();
    // Reveal is identity-dense — the assignment row carries the giver id and the
    // giver alias is resolved (after the emit). Neither may reach props.
    shared.santaParticipant.findUnique.mockResolvedValue({ id: 'p-recv', userId: 'u-test', status: 'JOINED' });
    shared.santaCampaign.findUnique.mockResolvedValue({ status: 'ACTIVE', currentRoundId: 'r-1' });
    // Real in-scope secrets: the giver participant id AND a free-text gift note.
    // Both are read by the handler (giftNote into the HTTP response) — the scan
    // proves neither reaches analytics props, so the assertion is non-tautological.
    shared.santaAssignment.findUnique.mockResolvedValue({
      id: 'a-1', giftStatus: 'RECEIVED', revealedAt: null, giftNote: 'SECRET-NOTE-TEXT',
      giver: { id: 'p-giver-SECRET' },
    });
    shared.santaAssignment.update.mockResolvedValue({});
    shared.santaParticipantAlias.findMany.mockResolvedValue([]);

    const res = await request(app).get('/santa/campaigns/c-rev/reveal');
    expect(res.status).toBe(200);

    assertNoIdentityLeak(['p-giver-SECRET', 'SECRET-NOTE-TEXT']);
  });
});
