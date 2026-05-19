// Deep handler tests for routes/telemetry.routes.ts — analytics event sink.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const shared = vi.hoisted(() => ({
  analyticsEvent: { createMany: vi.fn() },
  user: { findUnique: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    analyticsEvent: shared.analyticsEvent,
    user: shared.user,
  },
}));

import { registerTelemetryRouter } from './telemetry.routes';

// telemetryLimiter is module-scope in telemetry.routes.ts (5 req/min per user),
// so its in-memory store survives between makeApp() calls. Bumping the tgUser.id
// per test isolates the rate-limit bucket — without this, the 6th+ request in
// a `describe` block hits 429 even though the test only cares about the body.
let nextTestUserId = 100;
function makeApp(opts: { tgUser?: { id: number; first_name?: string } | null } = {}) {
  const id = nextTestUserId++;
  const tgUser = opts.tgUser === undefined ? { id, first_name: 'T' } : opts.tgUser;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (tgUser) (req as unknown as { tgUser: unknown }).tgUser = tgUser;
    next();
  });
  app.use(registerTelemetryRouter());
  return app;
}

beforeEach(() => {
  shared.analyticsEvent.createMany.mockReset();
  shared.analyticsEvent.createMany.mockResolvedValue({ count: 0 });
  shared.user.findUnique.mockReset();
  // Default: tgUser maps to an internal User row.
  shared.user.findUnique.mockResolvedValue({ id: 'cuid_default_user' });
});

describe('POST /telemetry', () => {
  it('400 on invalid body shape', async () => {
    const res = await request(makeApp()).post('/telemetry').send({ wrong: 'shape' });
    expect(res.status).toBe(400);
  });

  it('400 when events array is missing', async () => {
    const res = await request(makeApp()).post('/telemetry').send({});
    expect(res.status).toBe(400);
  });

  it('200 with empty events array (no DB write)', async () => {
    const res = await request(makeApp()).post('/telemetry').send({ events: [] });
    expect(res.status).toBe(200);
    expect(shared.analyticsEvent.createMany).not.toHaveBeenCalled();
  });

  it('200 returns accepted/dropped counts on partial allowlist mismatch', async () => {
    const res = await request(makeApp()).post('/telemetry').send({
      events: [
        { event: 'definitely_not_in_allowlist_xyz', ts: Date.now() },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accepted: 0, dropped: 1 });
    expect(shared.analyticsEvent.createMany).not.toHaveBeenCalled();
  });
});

describe('POST /telemetry — PRODUCT_EVENTS source-permission gate', () => {
  it('accepts clientAllowed event paywall.viewed', async () => {
    const res = await request(makeApp()).post('/telemetry').send({
      events: [{ event: 'paywall.viewed', ts: Date.now(), props: { plan: 'pro' } }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accepted: 1, dropped: 0 });
    expect(shared.analyticsEvent.createMany).toHaveBeenCalledOnce();
    const rows = shared.analyticsEvent.createMany.mock.calls[0]![0].data;
    expect(rows[0].event).toBe('paywall.viewed');
  });

  it('accepts clientAllowed event wishlist.shared', async () => {
    const res = await request(makeApp()).post('/telemetry').send({
      events: [{ event: 'wishlist.shared', ts: Date.now() }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accepted: 1, dropped: 0 });
  });

  it('accepts clientAllowed event user.session_started', async () => {
    const res = await request(makeApp()).post('/telemetry').send({
      events: [{ event: 'user.session_started', ts: Date.now() }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accepted: 1, dropped: 0 });
  });

  it('HARD-DENIES payment.completed (serverOnly), even though `payment.` is a legacy prefix', async () => {
    const res = await request(makeApp()).post('/telemetry').send({
      events: [{ event: 'payment.completed', ts: Date.now(), props: { amount: 999 } }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accepted: 0, dropped: 1 });
    expect(shared.analyticsEvent.createMany).not.toHaveBeenCalled();
  });

  it('HARD-DENIES pro.activated (serverOnly)', async () => {
    const res = await request(makeApp()).post('/telemetry').send({
      events: [{ event: 'pro.activated', ts: Date.now() }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accepted: 0, dropped: 1 });
    expect(shared.analyticsEvent.createMany).not.toHaveBeenCalled();
  });

  it('HARD-DENIES subscription.renewed (serverOnly)', async () => {
    const res = await request(makeApp()).post('/telemetry').send({
      events: [{ event: 'subscription.renewed', ts: Date.now() }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accepted: 0, dropped: 1 });
    expect(shared.analyticsEvent.createMany).not.toHaveBeenCalled();
  });

  it('HARD-DENIES subscription.expired (serverOnly)', async () => {
    const res = await request(makeApp()).post('/telemetry').send({
      events: [{ event: 'subscription.expired', ts: Date.now() }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accepted: 0, dropped: 1 });
    expect(shared.analyticsEvent.createMany).not.toHaveBeenCalled();
  });

  it('HARD-DENIES referral.invitee_converted_to_paid (legacy server-authoritative)', async () => {
    // This event lives in ANALYTICS_EVENTS, not PRODUCT_EVENTS — but the
    // ingest path still hard-denies it via LEGACY_SERVER_ONLY_EVENTS so a
    // future prefix expansion can't accidentally let clients mint it.
    const res = await request(makeApp()).post('/telemetry').send({
      events: [{ event: 'referral.invitee_converted_to_paid', ts: Date.now() }],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accepted: 0, dropped: 1 });
    expect(shared.analyticsEvent.createMany).not.toHaveBeenCalled();
  });

  it('HARD-DENIES user.signup and guest.converted_to_user (serverOnly)', async () => {
    const res = await request(makeApp()).post('/telemetry').send({
      events: [
        { event: 'user.signup', ts: Date.now() },
        { event: 'guest.converted_to_user', ts: Date.now() },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accepted: 0, dropped: 2 });
    expect(shared.analyticsEvent.createMany).not.toHaveBeenCalled();
  });

  it('mixed batch: keeps clientAllowed + legacy, drops serverOnly + unknown', async () => {
    const res = await request(makeApp()).post('/telemetry').send({
      events: [
        { event: 'paywall.viewed', ts: Date.now() }, // new clientAllowed → keep
        { event: 'payment.completed', ts: Date.now() }, // serverOnly → DENY
        { event: 'item_opened', ts: Date.now() }, // legacy prefix `item_` → keep
        { event: 'random_garbage_xyz', ts: Date.now() }, // unknown → drop
        { event: 'pro.activated', ts: Date.now() }, // serverOnly → DENY
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accepted: 2, dropped: 3 });
    expect(shared.analyticsEvent.createMany).toHaveBeenCalledOnce();
    const rows = shared.analyticsEvent.createMany.mock.calls[0]![0].data;
    expect(rows).toHaveLength(2);
    const acceptedNames = rows.map((r: { event: string }) => r.event).sort();
    expect(acceptedNames).toEqual(['item_opened', 'paywall.viewed']);
  });

  it('batch with one unknown event still accepts the rest (regression guard)', async () => {
    const res = await request(makeApp()).post('/telemetry').send({
      events: [
        { event: 'paywall.viewed', ts: Date.now() },
        { event: 'definitely_unknown_event_xyz', ts: Date.now() },
        { event: 'wishlist.shared', ts: Date.now() },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accepted: 2, dropped: 1 });
    expect(shared.analyticsEvent.createMany).toHaveBeenCalledOnce();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AnalyticsEvent.userId contract (see docs/analytics-events.md):
// Persisted userId is ALWAYS the internal User.id (cuid), never the raw
// Telegram numeric ID. Server resolves it server-side from req.tgUser.id;
// any client-supplied userId in the body is ignored.
// ─────────────────────────────────────────────────────────────────────────────
describe('POST /telemetry — AnalyticsEvent.userId contract', () => {
  it('saves internal User.id (cuid), not the Telegram numeric ID', async () => {
    shared.user.findUnique.mockResolvedValue({ id: 'cuid_user_abc123' });
    const res = await request(makeApp({ tgUser: { id: 8246090589, first_name: 'T' } }))
      .post('/telemetry')
      .send({ events: [{ event: 'paywall.viewed', ts: Date.now() }] });
    expect(res.status).toBe(200);
    expect(shared.user.findUnique).toHaveBeenCalledWith({
      where: { telegramId: '8246090589' },
      select: { id: true },
    });
    expect(shared.analyticsEvent.createMany).toHaveBeenCalledOnce();
    const rows = shared.analyticsEvent.createMany.mock.calls[0]![0].data;
    expect(rows[0].userId).toBe('cuid_user_abc123');
    expect(rows[0].userId).not.toBe('8246090589');
  });

  it('persists userId = NULL when no User row exists for the Telegram id', async () => {
    // resolveTgUserId returns null on miss → userId column gets NULL,
    // not the raw Telegram id (would re-introduce the heterogeneous-id bug).
    shared.user.findUnique.mockResolvedValue(null);
    const res = await request(makeApp({ tgUser: { id: 999999999, first_name: 'T' } }))
      .post('/telemetry')
      .send({ events: [{ event: 'paywall.viewed', ts: Date.now() }] });
    expect(res.status).toBe(200);
    expect(shared.analyticsEvent.createMany).toHaveBeenCalledOnce();
    const rows = shared.analyticsEvent.createMany.mock.calls[0]![0].data;
    expect(rows[0].userId).toBeNull();
  });

  it('ignores client-supplied userId field in request body', async () => {
    // telemetryBodySchema has no `userId` key — Zod strips it on parse.
    // Even if we send one, the server-derived value MUST win.
    shared.user.findUnique.mockResolvedValue({ id: 'cuid_real_user' });
    const res = await request(makeApp({ tgUser: { id: 123456, first_name: 'T' } }))
      .post('/telemetry')
      .send({
        userId: 'cuid_attacker_spoofed',
        events: [{ event: 'paywall.viewed', ts: Date.now() }],
      });
    expect(res.status).toBe(200);
    expect(shared.analyticsEvent.createMany).toHaveBeenCalledOnce();
    const rows = shared.analyticsEvent.createMany.mock.calls[0]![0].data;
    expect(rows[0].userId).toBe('cuid_real_user');
    expect(rows[0].userId).not.toBe('cuid_attacker_spoofed');
  });

  it('persists userId = NULL when there is no authenticated tgUser', async () => {
    // Unauthenticated request never makes it past requireTelegramAuth in
    // production, but defensively: if it did, userId must be NULL — never
    // a fake Telegram id.
    const res = await request(makeApp({ tgUser: null }))
      .post('/telemetry')
      .send({ events: [{ event: 'paywall.viewed', ts: Date.now() }] });
    expect(res.status).toBe(200);
    expect(shared.user.findUnique).not.toHaveBeenCalled();
    expect(shared.analyticsEvent.createMany).toHaveBeenCalledOnce();
    const rows = shared.analyticsEvent.createMany.mock.calls[0]![0].data;
    expect(rows[0].userId).toBeNull();
  });
});
