// HTTP-level tests for routes/notification-preferences.routes.ts (P0.3).
// Mocks @wishlist/db so we exercise the route → service → validation wiring and
// the error→status mapping without a DB. The DB-shape behaviour (persistence,
// dedupe, flush) is covered in test/integration/event-notifications.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const shared = vi.hoisted(() => ({
  userProfile: { findUnique: vi.fn(), upsert: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: { userProfile: shared.userProfile },
  Prisma: { PrismaClientKnownRequestError: class PrismaClientKnownRequestError {} },
}));

import { registerNotificationPreferencesRouter } from './notification-preferences.routes';

function buildApp() {
  const router = registerNotificationPreferencesRouter({
    getOrCreateTgUser: vi.fn(async () => ({ id: 'u-test' })),
  });
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 1, first_name: 'T' };
    next();
  });
  app.use('/tg', router);
  return app;
}

const FULL_PREFS = {
  notifyCircleEvents: true,
  notifyCircleNewWishes: true,
  notifyCircleReservationChanges: true,
  notifyCircleJoins: true,
  quietHoursEnabled: true,
  quietHoursStart: '22:00',
  quietHoursEnd: '09:00',
  notifyTimezone: null,
};

describe('notification-preferences routes', () => {
  beforeEach(() => {
    shared.userProfile.findUnique.mockReset();
    shared.userProfile.upsert.mockReset();
  });

  it('GET returns the current preferences', async () => {
    shared.userProfile.findUnique.mockResolvedValue(FULL_PREFS);
    const res = await request(buildApp()).get('/tg/notification-preferences');
    expect(res.status).toBe(200);
    expect(res.body.preferences.notifyCircleEvents).toBe(true);
    expect(res.body.preferences.quietHoursStart).toBe('22:00');
  });

  it('PATCH persists a valid partial update', async () => {
    shared.userProfile.upsert.mockResolvedValue({});
    shared.userProfile.findUnique.mockResolvedValue({ ...FULL_PREFS, notifyCircleEvents: false });
    const res = await request(buildApp())
      .patch('/tg/notification-preferences')
      .send({ notifyCircleEvents: false });
    expect(res.status).toBe(200);
    expect(res.body.preferences.notifyCircleEvents).toBe(false);
    expect(shared.userProfile.upsert).toHaveBeenCalledTimes(1);
  });

  it('PATCH rejects a malformed time with 400 and does NOT write', async () => {
    const res = await request(buildApp())
      .patch('/tg/notification-preferences')
      .send({ quietHoursStart: '99:99' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_time');
    expect(shared.userProfile.upsert).not.toHaveBeenCalled();
  });

  it('PATCH rejects an unresolvable timezone with 400', async () => {
    const res = await request(buildApp())
      .patch('/tg/notification-preferences')
      .send({ notifyTimezone: 'Not/AZone' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_timezone');
    expect(shared.userProfile.upsert).not.toHaveBeenCalled();
  });
});
