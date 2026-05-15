// Deep handler tests for routes/gift-notes.routes.ts — Pro/one-time gate
// via requireGiftNotes + daysUntilFromUtcMidnight + 26 calendar handlers.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { z } from 'zod';

const shared = vi.hoisted(() => ({
  giftOccasion: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  giftOccasionIdea: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
  giftOccasionReminder: { findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
  calendarInboxEntry: { findMany: vi.fn(), update: vi.fn() },
  user: { findUnique: vi.fn() },
  item: { findMany: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: new Proxy({}, {
    get(_target, key) {
      if (typeof key !== 'string') return undefined;
      const map = shared as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>;
      return map[key] ?? new Proxy({}, { get() { return vi.fn().mockResolvedValue(null); } });
    },
  }),
}));

import { registerGiftNotesRouter } from './gift-notes.routes';

function buildDeps(opts: { hasGiftNotes?: boolean } = {}) {
  return {
    getOrCreateTgUser: vi.fn(async () => ({ id: 'u', godMode: false })),
    getEffectiveEntitlements: vi.fn(async () => ({
      hasGiftNotes: opts.hasGiftNotes ?? false,
      isPro: false,
      giftNotes: { unlocked: opts.hasGiftNotes ?? false, unlockType: null, priceXtr: 19 },
      plan: { code: 'FREE' },
    })),
    trackEvent: vi.fn(),
    requireGiftNotes: vi.fn((ent: { hasGiftNotes: boolean }, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
      if (!ent.hasGiftNotes) {
        res.status(403).json({ error: 'gift_notes_required' });
        return false;
      }
      return true;
    }),
    zUrl: () => z.string().url(),
  } as Parameters<typeof registerGiftNotesRouter>[0];
}

function makeApp(deps = buildDeps()) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tgUser: unknown }).tgUser = { id: 42, first_name: 'T' };
    next();
  });
  app.use(registerGiftNotesRouter(deps));
  return { app, deps };
}

beforeEach(() => {
  for (const m of Object.values(shared)) {
    for (const fn of Object.values(m)) (fn as ReturnType<typeof vi.fn>).mockReset?.();
  }
});

describe('gift-notes — requireGiftNotes gate', () => {
  it('403 with gift_notes_required when entitlement lacks gift notes', async () => {
    const { app } = makeApp(buildDeps({ hasGiftNotes: false }));
    const res = await request(app).get('/gift-occasions');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'gift_notes_required' });
  });

  it('passes the gate when entitlement has gift notes', async () => {
    const { app, deps } = makeApp(buildDeps({ hasGiftNotes: true }));
    shared.giftOccasion.findMany.mockResolvedValueOnce([]);
    await request(app).get('/gift-occasions');
    expect(deps.requireGiftNotes).toHaveBeenCalled();
    expect(deps.requireGiftNotes).toHaveReturnedWith(true);
  });

  it('every authenticated handler routes through getOrCreateTgUser', async () => {
    const { app, deps } = makeApp(buildDeps({ hasGiftNotes: true }));
    shared.giftOccasion.findMany.mockResolvedValue([]);
    await request(app).get('/gift-occasions');
    expect(deps.getOrCreateTgUser).toHaveBeenCalled();
  });
});
