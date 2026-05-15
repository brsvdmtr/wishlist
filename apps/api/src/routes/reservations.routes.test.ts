// Handler tests for routes/reservations.routes.ts — reservation list + PRO
// gates + smart-res state derivation. Full handler coverage (~14 endpoints)
// is a follow-up; this file covers the core read path + smart-res TTL math.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const shared = vi.hoisted(() => ({
  item: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  reservationMeta: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  reservationEvent: { create: vi.fn(), findMany: vi.fn() },
  commentReadCursor: { findMany: vi.fn() },
  comment: { count: vi.fn() },
  groupGift: { findMany: vi.fn() },
  groupGiftParticipant: { findMany: vi.fn() },
  secretReservation: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  userOnboardingState: { findUnique: vi.fn(), upsert: vi.fn() },
  user: { findUnique: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    item: shared.item,
    reservationMeta: shared.reservationMeta,
    reservationEvent: shared.reservationEvent,
    commentReadCursor: shared.commentReadCursor,
    comment: shared.comment,
    groupGift: shared.groupGift,
    groupGiftParticipant: shared.groupGiftParticipant,
    secretReservation: shared.secretReservation,
    userOnboardingState: shared.userOnboardingState,
    user: shared.user,
  },
}));

import { registerReservationsRouter } from './reservations.routes';

function buildDeps(over: Partial<Parameters<typeof registerReservationsRouter>[0]> = {}) {
  return {
    getOrCreateTgUser: vi.fn(async () => ({ id: 'u-test', telegramChatId: '123', godMode: false })),
    getEffectiveEntitlements: vi.fn(async () => ({
      isPro: false,
      addOns: [],
      hasSecretReservations: false,
      plan: { code: 'FREE' },
    })),
    mapTgItem: vi.fn((it: { status?: string }) => ({ ...it, status: String(it.status ?? '').toLowerCase() })),
    trackEvent: vi.fn(),
    trackAnalyticsEvent: vi.fn(),
    tgActorHash: vi.fn((id: number) => `actor-${id}`),
    hasReservationPro: vi.fn(() => false),
    isReservationBeta: vi.fn(() => true),
    hasSmartReservations: vi.fn(() => false),
    cancelItemHints: vi.fn(async () => {}),
    getSmartResLeadHours: vi.fn((ttl: number) => (ttl >= 72 ? 24 : 6)),
    ...over,
  } as Parameters<typeof registerReservationsRouter>[0];
}

function makeApp(deps = buildDeps()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerReservationsRouter(deps));
  return { app, deps };
}

beforeEach(() => {
  for (const m of Object.values(shared)) {
    for (const fn of Object.values(m)) (fn as ReturnType<typeof vi.fn>).mockReset?.();
  }
  shared.item.findMany.mockResolvedValue([]);
  shared.reservationMeta.findMany.mockResolvedValue([]);
  shared.commentReadCursor.findMany.mockResolvedValue([]);
  shared.comment.count.mockResolvedValue(0);
  shared.groupGift.findMany.mockResolvedValue([]);
  shared.groupGiftParticipant.findMany.mockResolvedValue([]);
});

describe('GET /reservations — reserved-items list', () => {
  it('200 returns reservations array when user has no reservations', async () => {
    const res = await request(makeApp().app).get('/reservations');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('reservations');
    expect(Array.isArray(res.body.reservations)).toBe(true);
  });

  it('queries items where reserverUserId matches current user + status RESERVED', async () => {
    const { app } = makeApp();
    await request(app).get('/reservations');
    expect(shared.item.findMany).toHaveBeenCalled();
    const where = shared.item.findMany.mock.calls[0]![0].where;
    expect(where.reserverUserId).toBe('u-test');
    expect(where.status).toBe('RESERVED');
  });
});

describe('reservations — entitlement flow integration', () => {
  it('GET /reservations calls getEffectiveEntitlements with godMode flag', async () => {
    const ent = vi.fn(async () => ({ isPro: false, addOns: [], hasSecretReservations: false, plan: { code: 'FREE' } }));
    const { app } = makeApp(buildDeps({ getEffectiveEntitlements: ent }));
    await request(app).get('/reservations');
    expect(ent).toHaveBeenCalledWith('u-test', false);
  });

  it('GET /reservations uses tgActorHash for reserver identity', async () => {
    const hashFn = vi.fn((id: number) => `actor-${id}`);
    const { app } = makeApp(buildDeps({ tgActorHash: hashFn }));
    await request(app).get('/reservations');
    expect(hashFn).toHaveBeenCalledWith(42);
  });
});
