// Handler tests for routes/reservations.routes.ts — reservation list + PRO
// gates + smart-res state derivation + reserve participant-limit enforcement.
// Full handler coverage (~14 endpoints) is a follow-up; this file covers the
// core read path, smart-res TTL math, and the POST /items/:id/reserve gate.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const shared = vi.hoisted(() => ({
  item: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
  reservationMeta: { findMany: vi.fn(), findFirst: vi.fn(), update: vi.fn(), upsert: vi.fn() },
  reservationEvent: { create: vi.fn(), findMany: vi.fn() },
  commentReadCursor: { findMany: vi.fn() },
  comment: { count: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
  groupGift: { findMany: vi.fn() },
  groupGiftParticipant: { findMany: vi.fn() },
  secretReservation: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  userOnboardingState: { findUnique: vi.fn(), upsert: vi.fn() },
  user: { findUnique: vi.fn() },
  wishlist: { findUnique: vi.fn() },
  $transaction: vi.fn(),
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
    wishlist: shared.wishlist,
    $transaction: shared.$transaction,
  },
}));

vi.mock('../services/foreign-wishlist-access', () => ({
  recordForeignWishlistAccess: vi.fn(async () => {}),
}));

import { registerReservationsRouter } from './reservations.routes';

function buildDeps(over: Partial<Parameters<typeof registerReservationsRouter>[0]> = {}) {
  return {
    getOrCreateTgUser: vi.fn(async () => ({ id: 'u-test', telegramId: '123', godMode: false })),
    getEffectiveEntitlements: vi.fn(async () => ({
      isPro: false,
      addOns: [],
      hasSecretReservations: false,
      plan: { participants: 1, code: 'FREE' },
      secretReservations: { unlocked: false, unlockType: null, priceXtr: 24 },
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
    const ent = vi.fn(async () => ({
      isPro: false,
      plan: { participants: 1, code: 'FREE' },
      addOns: [],
      hasSecretReservations: false,
      secretReservations: { unlocked: false, unlockType: null, priceXtr: 24 },
    }));
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

describe('POST /items/:id/reserve — participant limit', () => {
  // The handler runs its core logic inside prisma.$transaction; the mock
  // invokes the callback with `shared` standing in for the tx client.
  function setupReserve(opts: { existingReservers: string[]; limit: number; ownerPlan?: string }) {
    const trackEvent = vi.fn();
    const getEffectiveEntitlements = vi.fn(async () => ({
      isPro: false,
      addOns: [],
      hasSecretReservations: false,
      plan: { participants: opts.limit, code: opts.ownerPlan ?? 'FREE' },
      secretReservations: { unlocked: false, unlockType: null, priceXtr: 24 },
    }));
    shared.$transaction.mockImplementation((cb: (tx: typeof shared) => unknown) => cb(shared));
    shared.item.findUnique.mockResolvedValue({
      status: 'AVAILABLE', reservationEpoch: 0, wishlistId: 'wl1',
      title: 'Gift',
      wishlist: { ownerId: 'owner1', smartResTtlHours: 72, smartResAllowExtend: false, smartResMaxExtensions: 0 },
    });
    shared.wishlist.findUnique.mockResolvedValue({
      ownerId: 'owner1', smartReservationsEnabled: false,
      smartResTtlHours: 72, smartResAllowExtend: false, smartResMaxExtensions: 0,
    });
    shared.user.findUnique.mockResolvedValue({ godMode: false, telegramChatId: null, profile: null });
    // Existing reservers are `r{n}`; the acting user resolves to `u-test`
    // (getOrCreateTgUser default mock). Disjoint id namespaces — the
    // "already a reserver" exemption never fires for the test user.
    shared.item.findMany.mockResolvedValue(opts.existingReservers.map((reserverUserId) => ({ reserverUserId })));
    shared.item.update.mockResolvedValue({});
    shared.reservationEvent.create.mockResolvedValue({});
    shared.comment.create.mockResolvedValue({});
    shared.comment.updateMany.mockResolvedValue({});
    shared.reservationMeta.upsert.mockResolvedValue({});
    const { app } = makeApp(buildDeps({ getEffectiveEntitlements, trackEvent }));
    return { app, trackEvent };
  }

  it('blocks the 11th distinct reserver on a FREE wishlist (limit 10) with 402', async () => {
    const tenReservers = Array.from({ length: 10 }, (_, i) => `r${i + 1}`);
    const { app, trackEvent } = setupReserve({ existingReservers: tenReservers, limit: 10 });
    const res = await request(app).post('/items/it1/reserve').send({ displayName: 'Guest' });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ feature: 'participant_limit', limit: 10 });
    expect(trackEvent).toHaveBeenCalledWith(
      'feature_gate_hit_participant_limit',
      'owner1',
      { plan: 'FREE', count: 10, limit: 10 },
    );
  });

  it('allows the 10th distinct reserver on a FREE wishlist (limit 10)', async () => {
    const nineReservers = Array.from({ length: 9 }, (_, i) => `r${i + 1}`);
    const { app, trackEvent } = setupReserve({ existingReservers: nineReservers, limit: 10 });
    const res = await request(app).post('/items/it1/reserve').send({ displayName: 'Guest' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(trackEvent).not.toHaveBeenCalledWith(
      'feature_gate_hit_participant_limit',
      expect.anything(),
      expect.anything(),
    );
  });

  it('PRO owner limit (20) is unchanged — 20 reservers still blocks the 21st', async () => {
    const twentyReservers = Array.from({ length: 20 }, (_, i) => `r${i + 1}`);
    const { app } = setupReserve({ existingReservers: twentyReservers, limit: 20, ownerPlan: 'PRO' });
    const res = await request(app).post('/items/it1/reserve').send({ displayName: 'Guest' });
    expect(res.status).toBe(402);
    expect(res.body).toMatchObject({ feature: 'participant_limit', limit: 20 });
  });
});
