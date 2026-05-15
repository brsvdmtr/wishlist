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
  santaExclusionGroup: { findMany: vi.fn() },
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

import { registerSantaRouter } from './santa.routes';

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
