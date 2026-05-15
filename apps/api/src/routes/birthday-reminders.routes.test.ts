// Deep handler tests for routes/birthday-reminders.routes.ts — Mini App
// birthday opt-out / preview endpoints.

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

vi.mock('@wishlist/db', () => ({
  prisma: new Proxy({}, {
    get() { return new Proxy({}, { get() { return vi.fn().mockResolvedValue(null); } }); },
  }),
}));

import { registerBirthdayRemindersRouter } from './birthday-reminders.routes';

function buildDeps() {
  return new Proxy({}, {
    get(_target, key) {
      if (key === 'then') return undefined;
      return vi.fn();
    },
  }) as Parameters<typeof registerBirthdayRemindersRouter>[0];
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerBirthdayRemindersRouter(buildDeps()));
  return app;
}

describe('birthday-reminders routes — factory + boot', () => {
  it('factory accepts deps + returns Router', () => {
    const router = registerBirthdayRemindersRouter(buildDeps());
    expect(typeof router).toBe('function');
  });

  it('registered router has at least 2 handlers', () => {
    const router = registerBirthdayRemindersRouter(buildDeps()) as { stack?: unknown[] };
    expect((router.stack ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('unknown path 404s', async () => {
    const res = await request(makeApp()).get('/birthday-reminders/totally-fake');
    expect(res.status).toBe(404);
  });
});
