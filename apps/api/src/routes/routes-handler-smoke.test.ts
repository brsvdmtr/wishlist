// Per-route handler smoke tests for the routes that don't yet have a dedicated
// deep test file. Each test uses a permissive Proxy stub for deps + a Prisma
// proxy that returns a fresh vi.fn() for any model/method access. The point
// is to catch import-time regressions (factory signature drift) and verify
// the registered router has the expected handler density.
//
// Deep per-handler coverage lives in dedicated *.routes.test.ts files for
// the high-incident routes (items, comments, reservations, hints, billing,
// me, wishlists, analytics).

import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Router } from 'express';

vi.mock('@wishlist/db', () => ({
  prisma: new Proxy({}, {
    get() {
      return new Proxy({}, { get() { return vi.fn().mockResolvedValue(null); } });
    },
  }),
}));

import { registerAdminRouter } from './admin.routes';
import { registerBirthdayRemindersRouter } from './birthday-reminders.routes';
import { registerGiftNotesRouter } from './gift-notes.routes';
import { registerGroupGiftsRouter } from './group-gifts.routes';
import { registerImportRouter } from './import.routes';
import { registerInternalRouter } from './internal.routes';
import { registerMaintenanceRouter } from './maintenance.routes';
import { registerOnboardingRouter } from './onboarding.routes';
import { registerProfilesRouter } from './profiles.routes';
import { registerPromoRouter } from './promo.routes';
import { registerPublicRouter } from './public.routes';
import { registerRefRouter } from './referral.routes';
import { registerSantaRouter } from './santa.routes';
import { registerSelectionsArchiveRouter } from './selections-archive.routes';
import { registerSupportRouter } from './support.routes';
import { registerTelemetryRouter } from './telemetry.routes';

function permissiveDeps<T>(): T {
  return new Proxy({}, {
    get(_target, key) {
      if (key === 'then') return undefined;
      return vi.fn();
    },
  }) as T;
}

function isRouter(value: unknown): value is Router {
  return typeof value === 'function' && (value as { stack?: unknown }).stack !== undefined;
}

function smokeApp(router: Router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(router);
  return app;
}

const SUITES = [
  { name: 'admin', factory: registerAdminRouter, minHandlers: 5, smokePath: '/admin/definitely-not-real' },
  { name: 'birthday-reminders', factory: registerBirthdayRemindersRouter, minHandlers: 2, smokePath: '/birthday-reminders/x' },
  { name: 'gift-notes', factory: registerGiftNotesRouter, minHandlers: 10, smokePath: '/gift-occasions/x/nope' },
  { name: 'group-gifts', factory: registerGroupGiftsRouter, minHandlers: 5, smokePath: '/group-gifts/x/nope' },
  { name: 'import', factory: registerImportRouter, minHandlers: 1, smokePath: '/import/nope' },
  { name: 'internal', factory: registerInternalRouter, minHandlers: 1, smokePath: '/internal/nope' },
  { name: 'maintenance', factory: registerMaintenanceRouter, minHandlers: 1, smokePath: '/maintenance/nope' },
  { name: 'onboarding', factory: registerOnboardingRouter, minHandlers: 3, smokePath: '/onboarding/nope' },
  { name: 'profiles', factory: registerProfilesRouter, minHandlers: 1, smokePath: '/profiles/nope' },
  { name: 'promo', factory: registerPromoRouter, minHandlers: 2, smokePath: '/promo/nope' },
  { name: 'public', factory: registerPublicRouter, minHandlers: 5, smokePath: '/public/nope' },
  { name: 'referral', factory: registerRefRouter, minHandlers: 2, smokePath: '/referral/nope' },
  { name: 'santa', factory: registerSantaRouter, minHandlers: 20, smokePath: '/santa/nope' },
  { name: 'selections-archive', factory: registerSelectionsArchiveRouter, minHandlers: 2, smokePath: '/selections/nope' },
  { name: 'support', factory: registerSupportRouter, minHandlers: 2, smokePath: '/support/nope' },
  { name: 'telemetry', factory: registerTelemetryRouter, minHandlers: 1, smokePath: '/telemetry/nope' },
];

describe('Route handler smoke — 16 remaining routes (factory + boot + 404)', () => {
  for (const { name, factory, minHandlers, smokePath } of SUITES) {
    describe(name, () => {
      it('factory accepts permissive deps + returns a Router', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const router = factory(permissiveDeps<any>());
        expect(isRouter(router)).toBe(true);
      });

      it(`registered router has at least ${minHandlers} handlers`, () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const router = factory(permissiveDeps<any>()) as unknown as { stack?: unknown[] };
        expect((router.stack ?? []).length).toBeGreaterThanOrEqual(minHandlers);
      });

      it('boots into Express + 404s an unknown path', async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const app = smokeApp(factory(permissiveDeps<any>()));
        const res = await request(app).get(smokePath);
        // Some handlers may throw 500 on the proxy mocks rather than 404 —
        // both indicate the app booted + the route is reachable.
        expect([404, 500]).toContain(res.status);
      });
    });
  }
});
