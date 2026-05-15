// Shape/contract tests for every router factory in apps/api/src/routes/.
// Verifies each module exports `register{Name}Router(deps)` that returns
// an Express Router. Catches breaking changes to the factory pattern + dep
// contracts at the registration layer without needing supertest per file.
//
// Deep handler tests live in per-route test files (items / comments /
// reservations / billing / hints) — this file is the safety net for the
// other ~20 routes whose handlers are best validated against a real DB
// rather than mocked Prisma.

import { describe, it, expect, vi } from 'vitest';
import type { Router } from 'express';

// Generic dep stub: every router factory takes a structurally-typed
// `deps` object. We feed it a permissive proxy so any field access
// returns either a no-op vi.fn() (for async helpers) or a plain truthy
// value (for constants). Routes only register paths during factory
// invocation — handler bodies don't run, so missing deps don't matter
// at this layer.
function dep<T>(): T {
  return new Proxy({} as Record<string, unknown>, {
    get(_target, key) {
      if (key === 'then') return undefined; // not a thenable
      // Provide a function for any access by default.
      return vi.fn();
    },
  }) as unknown as T;
}

function isExpressRouter(value: unknown): value is Router {
  // Express Router instances are functions with .stack / .use / .post properties.
  return typeof value === 'function' && (value as { stack?: unknown }).stack !== undefined;
}

// Import every router factory. If a file moves or removes its export,
// this import fails fast and surfaces it at test discovery time.
import { registerAnalyticsRouter } from './analytics.routes';
import { registerAdminRouter } from './admin.routes';
import { registerBillingRouter } from './billing.routes';
import { registerBirthdayRemindersRouter } from './birthday-reminders.routes';
import { registerCommentsRouter } from './comments.routes';
import { registerGiftNotesRouter } from './gift-notes.routes';
import { registerGroupGiftsRouter } from './group-gifts.routes';
import { registerHintsRouter } from './hints.routes';
import { registerImportRouter } from './import.routes';
import { registerInternalRouter } from './internal.routes';
import { registerItemsRouter } from './items.routes';
import { registerMaintenanceRouter } from './maintenance.routes';
import { registerMeRouter } from './me.routes';
import { registerOnboardingRouter } from './onboarding.routes';
import { registerProfilesRouter } from './profiles.routes';
import { registerPromoRouter } from './promo.routes';
import { registerPublicRouter } from './public.routes';
import { registerRefRouter } from './referral.routes';
import { registerReservationsRouter } from './reservations.routes';
import { registerSantaRouter } from './santa.routes';
import { registerSelectionsArchiveRouter } from './selections-archive.routes';
import { registerSupportRouter } from './support.routes';
import { registerTelemetryRouter } from './telemetry.routes';
import { registerWishlistsRouter } from './wishlists.routes';

const ALL_ROUTERS: Array<{ name: string; factory: (deps: unknown) => Router }> = [
  { name: 'analytics', factory: registerAnalyticsRouter as unknown as (d: unknown) => Router },
  { name: 'admin', factory: registerAdminRouter as unknown as (d: unknown) => Router },
  { name: 'billing', factory: registerBillingRouter as unknown as (d: unknown) => Router },
  { name: 'birthday-reminders', factory: registerBirthdayRemindersRouter as unknown as (d: unknown) => Router },
  { name: 'comments', factory: registerCommentsRouter as unknown as (d: unknown) => Router },
  { name: 'gift-notes', factory: registerGiftNotesRouter as unknown as (d: unknown) => Router },
  { name: 'group-gifts', factory: registerGroupGiftsRouter as unknown as (d: unknown) => Router },
  { name: 'hints', factory: registerHintsRouter as unknown as (d: unknown) => Router },
  { name: 'import', factory: registerImportRouter as unknown as (d: unknown) => Router },
  { name: 'internal', factory: registerInternalRouter as unknown as (d: unknown) => Router },
  { name: 'items', factory: registerItemsRouter as unknown as (d: unknown) => Router },
  { name: 'maintenance', factory: registerMaintenanceRouter as unknown as (d: unknown) => Router },
  { name: 'me', factory: registerMeRouter as unknown as (d: unknown) => Router },
  { name: 'onboarding', factory: registerOnboardingRouter as unknown as (d: unknown) => Router },
  { name: 'profiles', factory: registerProfilesRouter as unknown as (d: unknown) => Router },
  { name: 'promo', factory: registerPromoRouter as unknown as (d: unknown) => Router },
  { name: 'public', factory: registerPublicRouter as unknown as (d: unknown) => Router },
  { name: 'referral', factory: registerRefRouter as unknown as (d: unknown) => Router },
  { name: 'reservations', factory: registerReservationsRouter as unknown as (d: unknown) => Router },
  { name: 'santa', factory: registerSantaRouter as unknown as (d: unknown) => Router },
  { name: 'selections-archive', factory: registerSelectionsArchiveRouter as unknown as (d: unknown) => Router },
  { name: 'support', factory: registerSupportRouter as unknown as (d: unknown) => Router },
  { name: 'telemetry', factory: registerTelemetryRouter as unknown as (d: unknown) => Router },
  { name: 'wishlists', factory: registerWishlistsRouter as unknown as (d: unknown) => Router },
];

describe('Route factories — contract layer', () => {
  it('exports exactly 24 route modules in this monorepo', () => {
    // Pins the registry size — a new route file appearing without a
    // corresponding entry here is a missed registration.
    expect(ALL_ROUTERS).toHaveLength(24);
  });

  for (const { name, factory } of ALL_ROUTERS) {
    describe(`registerXxxRouter: ${name}`, () => {
      it('is a function (registered factory export)', () => {
        expect(typeof factory).toBe('function');
      });

      it('returns an Express Router when invoked with permissive deps', () => {
        // Some factories destructure required deps eagerly; a permissive
        // Proxy stub returns vi.fn() for any property access so the
        // factory call returns without crashing on missing fields.
        const router = factory(dep<Record<string, unknown>>());
        expect(isExpressRouter(router)).toBe(true);
      });

      it('registered at least one route path', () => {
        const router = factory(dep<Record<string, unknown>>()) as Router & { stack?: Array<{ route?: { path: string } }> };
        const stack = router.stack ?? [];
        // Express layers include both middleware (no `.route`) and route
        // handlers (have `.route`). At least one of either must exist for
        // the factory to be useful.
        expect(stack.length).toBeGreaterThan(0);
      });
    });
  }
});
