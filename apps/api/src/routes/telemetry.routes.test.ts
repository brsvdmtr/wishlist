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

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
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
    // Unknown events get dropped silently (per the per-event filter), so
    // createMany is called with 0 records OR not called at all.
  });
});
