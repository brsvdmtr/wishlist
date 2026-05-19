// Deep handler tests for routes/telemetry.routes.ts — analytics event sink.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const shared = vi.hoisted(() => ({
  analyticsEvent: { createMany: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: { analyticsEvent: shared.analyticsEvent },
}));

import { registerTelemetryRouter } from './telemetry.routes';

// telemetryLimiter is module-scope in telemetry.routes.ts (5 req/min per user),
// so its in-memory store survives between makeApp() calls. Bumping the tgUser.id
// per test isolates the rate-limit bucket — without this, the 6th+ request in
// a `describe` block hits 429 even though the test only cares about the body.
let nextTestUserId = 100;
function makeApp() {
  const id = nextTestUserId++;
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id, first_name: 'T' };
    next();
  });
  app.use(registerTelemetryRouter());
  return app;
}

beforeEach(() => {
  shared.analyticsEvent.createMany.mockReset();
  shared.analyticsEvent.createMany.mockResolvedValue({ count: 0 });
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
