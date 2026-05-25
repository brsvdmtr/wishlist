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

describe('Reservation PRO gate — paywall promise ↔ access alignment', () => {
  // The paywall (plan_pro_f10..f14 + addon_desc_reservation_pro_unlock)
  // advertises history / notes / reminders / purchased / filters as PRO or
  // one-time-add-on features. The gate (`requireReservationPro` in
  // reservations.routes.ts) must mirror that exactly: PRO sub OR
  // reservation_pro_unlock OR godMode → access; otherwise 402 with
  // analytics. Status code MUST be 402 (not 403) because the feature CAN
  // be purchased — 402 is the semantic for "pay to access".

  beforeEach(() => {
    shared.item.findUnique.mockResolvedValue({ reserverUserId: 'u-test', status: 'RESERVED' });
    shared.reservationMeta.upsert.mockResolvedValue({
      note: 'hi', purchased: false, purchasedAt: null, reminderAt: null, reminderSent: false,
    });
  });

  describe('FREE user (no PRO, no addon, no godMode) → 402 on every gated endpoint', () => {
    it('GET /reservations/history → 402 { error: pro_required, feature: reservation_history }', async () => {
      const trackEvent = vi.fn();
      const { app } = makeApp(buildDeps({
        hasReservationPro: vi.fn(() => false),
        trackEvent,
      }));
      const res = await request(app).get('/reservations/history');
      expect(res.status).toBe(402);
      // Unified paywall envelope (2026-05) — planCode field added by the
      // helper from the test's entitlement stub.
      expect(res.body).toMatchObject({ error: 'pro_required', feature: 'reservation_history' });
      expect(trackEvent).toHaveBeenCalledWith(
        'feature_gate_hit_reservation_pro',
        'u-test',
        { feature: 'reservation_history' },
      );
    });

    it('PATCH /reservations/:id/meta → 402 reservation_meta + analytics', async () => {
      const trackEvent = vi.fn();
      const { app } = makeApp(buildDeps({
        hasReservationPro: vi.fn(() => false),
        trackEvent,
      }));
      const res = await request(app).patch('/reservations/it1/meta').send({ note: 'hi' });
      expect(res.status).toBe(402);
      expect(res.body).toMatchObject({ error: 'pro_required', feature: 'reservation_meta' });
      expect(trackEvent).toHaveBeenCalledWith(
        'feature_gate_hit_reservation_pro',
        'u-test',
        { feature: 'reservation_meta' },
      );
    });

    it('POST /reservations/:id/reminder → 402 reservation_reminder + analytics', async () => {
      const trackEvent = vi.fn();
      const { app } = makeApp(buildDeps({
        hasReservationPro: vi.fn(() => false),
        trackEvent,
      }));
      const future = new Date(Date.now() + 86_400_000).toISOString();
      const res = await request(app).post('/reservations/it1/reminder').send({ reminderAt: future });
      expect(res.status).toBe(402);
      expect(res.body).toMatchObject({ error: 'pro_required', feature: 'reservation_reminder' });
      expect(trackEvent).toHaveBeenCalledWith(
        'feature_gate_hit_reservation_pro',
        'u-test',
        { feature: 'reservation_reminder' },
      );
    });

    it('uses 402 (not 403) because the feature is buyable — semantic correctness', async () => {
      const { app } = makeApp(buildDeps({ hasReservationPro: vi.fn(() => false) }));
      const res = await request(app).get('/reservations/history');
      expect(res.status).not.toBe(403);
      expect(res.status).toBe(402);
    });
  });

  describe('Granted access (PRO / addon / godMode) → 200 + no gate event', () => {
    it('hasReservationPro=true → GET /reservations/history returns 200 history payload', async () => {
      const trackEvent = vi.fn();
      const { app } = makeApp(buildDeps({
        hasReservationPro: vi.fn(() => true),
        trackEvent,
      }));
      const res = await request(app).get('/reservations/history');
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('history');
      expect(Array.isArray(res.body.history)).toBe(true);
      expect(trackEvent).not.toHaveBeenCalledWith(
        'feature_gate_hit_reservation_pro',
        expect.anything(),
        expect.anything(),
      );
    });

    it('hasReservationPro=true → PATCH meta passes through to upsert', async () => {
      const { app } = makeApp(buildDeps({ hasReservationPro: vi.fn(() => true) }));
      const res = await request(app).patch('/reservations/it1/meta').send({ note: 'hi' });
      expect(res.status).toBe(200);
      expect(shared.reservationMeta.upsert).toHaveBeenCalled();
    });

    it('hasReservationPro=true → POST reminder accepts the date', async () => {
      const future = new Date(Date.now() + 86_400_000).toISOString();
      shared.reservationMeta.upsert.mockResolvedValueOnce({
        reminderAt: new Date(future), reminderDates: [future],
      });
      const { app } = makeApp(buildDeps({ hasReservationPro: vi.fn(() => true) }));
      const res = await request(app).post('/reservations/it1/reminder').send({ reminderAt: future });
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('reminderAt');
    });
  });

  describe('Gate wiring — predicate gets (user, ent.isPro, ent.addOns)', () => {
    it('passes through PRO subscription flag', async () => {
      const hasReservationPro = vi.fn(
        (_user: { godMode: boolean }, _isPro: boolean, _addOns?: Array<{ addonType: string }>) => true,
      );
      const getEffectiveEntitlements = vi.fn(async () => ({
        isPro: true,
        addOns: [],
        hasSecretReservations: false,
        plan: { participants: 1, code: 'PRO' },
        secretReservations: { unlocked: true, unlockType: 'PRO' as const, priceXtr: 24 },
      }));
      const { app } = makeApp(buildDeps({ hasReservationPro, getEffectiveEntitlements }));
      await request(app).get('/reservations/history');
      expect(hasReservationPro).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'u-test', godMode: false }),
        true,
        [],
      );
    });

    it('passes through reservation_pro_unlock addon for FREE user', async () => {
      const hasReservationPro = vi.fn(
        (_user: { godMode: boolean }, _isPro: boolean, _addOns?: Array<{ addonType: string }>) => true,
      );
      const getEffectiveEntitlements = vi.fn(async () => ({
        isPro: false,
        addOns: [{ addonType: 'reservation_pro_unlock', targetId: null, quantity: 1 }],
        hasSecretReservations: false,
        plan: { participants: 1, code: 'FREE' },
        secretReservations: { unlocked: false, unlockType: null, priceXtr: 24 },
      }));
      const { app } = makeApp(buildDeps({ hasReservationPro, getEffectiveEntitlements }));
      await request(app).patch('/reservations/it1/meta').send({ note: 'addon path' });
      expect(hasReservationPro).toHaveBeenCalledWith(
        expect.objectContaining({ godMode: false }),
        false,
        [{ addonType: 'reservation_pro_unlock', targetId: null, quantity: 1 }],
      );
    });

    it('passes through godMode user object', async () => {
      const hasReservationPro = vi.fn(
        (_user: { godMode: boolean }, _isPro: boolean, _addOns?: Array<{ addonType: string }>) => true,
      );
      const getOrCreateTgUser = vi.fn(async () => ({ id: 'u-god', telegramId: '999', godMode: true }));
      const { app } = makeApp(buildDeps({ hasReservationPro, getOrCreateTgUser }));
      const future = new Date(Date.now() + 86_400_000).toISOString();
      shared.item.findUnique.mockResolvedValueOnce({ reserverUserId: 'u-god', status: 'RESERVED' });
      shared.reservationMeta.upsert.mockResolvedValueOnce({
        reminderAt: new Date(future), reminderDates: [future],
      });
      await request(app).post('/reservations/it1/reminder').send({ reminderAt: future });
      expect(hasReservationPro).toHaveBeenCalledWith(
        expect.objectContaining({ godMode: true }),
        expect.any(Boolean),
        expect.any(Array),
      );
    });
  });

  describe('DELETE /reservations/:id/reminder is intentionally ungated', () => {
    it('FREE user can delete their reminder without 402 (cleanup path)', async () => {
      shared.reservationMeta.update = vi.fn();
      const updateMany = vi.fn(async () => ({ count: 1 }));
      // The handler calls prisma.reservationMeta.updateMany — wire that.
      (shared.reservationMeta as unknown as { updateMany: typeof updateMany }).updateMany = updateMany;
      const { app } = makeApp(buildDeps({ hasReservationPro: vi.fn(() => false) }));
      const res = await request(app).delete('/reservations/it1/reminder');
      expect(res.status).toBe(200);
      expect(updateMany).toHaveBeenCalled();
    });
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

  it('blocks the 11th distinct reserver on a FREE wishlist (limit 10) with 409 conflict', async () => {
    // 2026-05 paywall unification: guest hitting owner's plan ceiling is a
    // STATE conflict (the guest cannot buy PRO for the owner) — status 409,
    // not 402. The envelope still carries feature + limit so the FE can
    // show a "ask owner to upgrade" toast.
    const tenReservers = Array.from({ length: 10 }, (_, i) => `r${i + 1}`);
    const { app, trackEvent } = setupReserve({ existingReservers: tenReservers, limit: 10 });
    const res = await request(app).post('/items/it1/reserve').send({ displayName: 'Guest' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'plan_limit_reached',
      feature: 'participant_limit',
      limit: 10,
      current: 10,
    });
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

  it('PRO owner limit (20) is unchanged — 20 reservers still blocks the 21st with 409', async () => {
    const twentyReservers = Array.from({ length: 20 }, (_, i) => `r${i + 1}`);
    const { app } = setupReserve({ existingReservers: twentyReservers, limit: 20, ownerPlan: 'PRO' });
    const res = await request(app).post('/items/it1/reserve').send({ displayName: 'Guest' });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: 'plan_limit_reached',
      feature: 'participant_limit',
      limit: 20,
      current: 20,
    });
  });
});
