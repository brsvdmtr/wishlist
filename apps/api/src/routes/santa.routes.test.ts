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
  santaHintRequest: { findUnique: vi.fn(), findMany: vi.fn() },
  santaExclusionGroup: { findMany: vi.fn(), create: vi.fn() },
  santaExclusionGroupMember: { findMany: vi.fn() },
  santaChatMessage: { findMany: vi.fn() },
  santaItemPool: { findMany: vi.fn() },
  santaSeasonalBroadcastLog: { findMany: vi.fn() },
  santaSeasonConfig: { findUnique: vi.fn() },
  santaGlobalConfig: { findUnique: vi.fn() },
  user: { findUnique: vi.fn(), update: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: new Proxy({}, {
    get(_target, model) {
      if (typeof model !== 'string') return undefined;
      const cluster = shared as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
      if (cluster[model]) return cluster[model];
      return new Proxy({}, { get() { return vi.fn().mockResolvedValue(null); } });
    },
  }),
}));

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
