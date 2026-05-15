// Deep handler tests for routes/maintenance.routes.ts — exposure tracking.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const shared = vi.hoisted(() => ({
  maintenanceExposure: { findFirst: vi.fn(), update: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: { maintenanceExposure: shared.maintenanceExposure },
}));

import { registerMaintenanceRouter } from './maintenance.routes';

function buildDeps(over: Partial<Parameters<typeof registerMaintenanceRouter>[0]> = {}) {
  return {
    getOrCreateTgUser: vi.fn(async () => ({ id: 'u-test', telegramChatId: '123' })),
    trackEvent: vi.fn(),
    recordMaintenanceExposure: vi.fn(async () => 'incident-1'),
    ...over,
  } as Parameters<typeof registerMaintenanceRouter>[0];
}

function makeApp(deps = buildDeps()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerMaintenanceRouter(deps));
  return { app, deps };
}

beforeEach(() => {
  for (const m of Object.values(shared)) {
    for (const fn of Object.values(m)) (fn as ReturnType<typeof vi.fn>).mockReset?.();
  }
});

describe('POST /maintenance-exposure', () => {
  it('200 with incidentId from recordMaintenanceExposure', async () => {
    const { app, deps } = makeApp();
    const res = await request(app).post('/maintenance-exposure').send({ locale: 'en', surface: 'miniapp' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, incidentId: 'incident-1' });
    expect(deps.recordMaintenanceExposure).toHaveBeenCalledWith('u-test', 'miniapp', 'en', '123');
  });

  it('defaults locale to "ru" and surface to "miniapp"', async () => {
    const { app, deps } = makeApp();
    await request(app).post('/maintenance-exposure').send({});
    expect(deps.recordMaintenanceExposure).toHaveBeenCalledWith('u-test', 'miniapp', 'ru', '123');
  });

  it('passes null telegramChatId when user has none', async () => {
    const deps = buildDeps({
      getOrCreateTgUser: vi.fn(async () => ({ id: 'u-test', telegramChatId: null })),
    });
    const { app } = makeApp(deps);
    await request(app).post('/maintenance-exposure').send({});
    expect(deps.recordMaintenanceExposure).toHaveBeenCalledWith('u-test', 'miniapp', 'ru', null);
  });
});
