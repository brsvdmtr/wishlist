// Integration test — credit-based URL import quota with real Postgres.
//
// Pins the BEHAVIOUR of the activation-critical monetization fix:
//   • a FREE user gets FREE_IMPORT_QUOTA_PER_MONTH imports per month;
//   • consume spends free monthly quota before paid importCredits;
//   • the monthly bucket resets lazily across a month boundary;
//   • parallel imports never push the counter past the quota or drive
//     importCredits below zero (the CLAUDE.md race-class lesson — the
//     reason this is an integration test and not a mock-Prisma unit test).
//
// The analytics layer is mocked so the credit events are assertable and no
// fire-and-forget AnalyticsEvent rows leak into the shared test DB.
//
// Auto-skips without DATABASE_URL (local `pnpm test` fast path); CI's
// Postgres service always runs it.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';

vi.mock('../../src/services/analytics', () => ({
  trackEvent: vi.fn(),
  trackAnalyticsEvent: vi.fn(),
  trackProductEvent: vi.fn(),
}));

import { getTestPrisma, disconnectTestPrisma } from '../setup-pg';
import { trackAnalyticsEvent } from '../../src/services/analytics';
import {
  FREE_IMPORT_QUOTA_PER_MONTH,
  currentImportPeriod,
  getImportAllowance,
  consumeImportCredit,
} from '../../src/services/import-credits';

const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;
const PREFIX = 'int-import-credits';
const mockedTrack = vi.mocked(trackAnalyticsEvent);

if (SKIP) {
  // eslint-disable-next-line no-console
  console.warn('[integration] DATABASE_URL not set — skipping import-credits integration tests');
}

suite('import credits — real Postgres', () => {
  let db: ReturnType<typeof getTestPrisma>;

  async function freshUser(tag: string): Promise<string> {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const u = await db.user.create({ data: { telegramId: `${PREFIX}-${tag}-${suffix}` } });
    return u.id;
  }

  beforeAll(async () => {
    db = getTestPrisma();
    await db.userCredits.deleteMany({ where: { user: { telegramId: { startsWith: PREFIX } } } });
    await db.user.deleteMany({ where: { telegramId: { startsWith: PREFIX } } });
  });

  afterAll(async () => {
    // trackAnalyticsEvent is mocked in this suite, so no AnalyticsEvent rows
    // are written — nothing to clean up there.
    await db.userCredits.deleteMany({ where: { user: { telegramId: { startsWith: PREFIX } } } });
    await db.item.deleteMany({ where: { wishlist: { owner: { telegramId: { startsWith: PREFIX } } } } });
    await db.wishlist.deleteMany({ where: { owner: { telegramId: { startsWith: PREFIX } } } });
    await db.user.deleteMany({ where: { telegramId: { startsWith: PREFIX } } });
    await disconnectTestPrisma();
  });

  beforeEach(() => {
    mockedTrack.mockClear();
  });

  it('a fresh FREE user has the full monthly allowance (test 1)', async () => {
    const userId = await freshUser('fresh');
    const a = await getImportAllowance(userId, false);
    expect(a.allowed).toBe(true);
    expect(a.isPro).toBe(false);
    expect(a.freeUsed).toBe(0);
    expect(a.freeRemaining).toBe(FREE_IMPORT_QUOTA_PER_MONTH);
    expect(a.source).toBe('free');
  });

  it('a successful import consumes one free credit (test 3)', async () => {
    const userId = await freshUser('consume');
    const r = await consumeImportCredit(userId, { source: 'test' });
    expect(r.consumed).toBe('free');
    expect(r.freeUsed).toBe(1);
    expect(r.freeRemaining).toBe(FREE_IMPORT_QUOTA_PER_MONTH - 1);

    const row = await db.userCredits.findUnique({ where: { userId } });
    expect(row?.freeImportsUsed).toBe(1);
    expect(row?.freeImportsPeriod).toBe(currentImportPeriod());
    expect(mockedTrack).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'import.free_quota_used' }),
    );
  });

  it('allows exactly FREE_IMPORT_QUOTA_PER_MONTH imports, then denies (test 4)', async () => {
    const userId = await freshUser('exhaust');
    for (let i = 0; i < FREE_IMPORT_QUOTA_PER_MONTH; i++) {
      const r = await consumeImportCredit(userId, { source: 'test' });
      expect(r.consumed).toBe('free');
    }
    // The final consume drains the month → exhausted event fires exactly once.
    const exhausted = mockedTrack.mock.calls.filter(
      (c) => (c[0] as { event: string }).event === 'import.free_quota_exhausted',
    );
    expect(exhausted).toHaveLength(1);

    const a = await getImportAllowance(userId, false);
    expect(a.allowed).toBe(false);
    expect(a.freeRemaining).toBe(0);
    expect(a.source).toBe('none');
  });

  it('paid importCredits cover imports once the free quota is gone (test 6)', async () => {
    const userId = await freshUser('paid');
    for (let i = 0; i < FREE_IMPORT_QUOTA_PER_MONTH; i++) {
      await consumeImportCredit(userId, { source: 'test' });
    }
    await db.userCredits.update({ where: { userId }, data: { importCredits: 3 } });

    const a = await getImportAllowance(userId, false);
    expect(a.allowed).toBe(true);
    expect(a.source).toBe('paid');
    expect(a.paidCredits).toBe(3);

    const r = await consumeImportCredit(userId, { source: 'test' });
    expect(r.consumed).toBe('paid');
    expect(r.paidCredits).toBe(2);

    const row = await db.userCredits.findUnique({ where: { userId } });
    expect(row?.importCredits).toBe(2);
    expect(row?.freeImportsUsed).toBe(FREE_IMPORT_QUOTA_PER_MONTH); // free untouched
  });

  it('the monthly bucket resets lazily across a month boundary', async () => {
    const userId = await freshUser('reset');
    await db.userCredits.create({
      data: { userId, freeImportsUsed: FREE_IMPORT_QUOTA_PER_MONTH, freeImportsPeriod: '2000-01' },
    });

    // Stale period → the read path reports a full allowance.
    const a = await getImportAllowance(userId, false);
    expect(a.freeRemaining).toBe(FREE_IMPORT_QUOTA_PER_MONTH);

    const r = await consumeImportCredit(userId, { source: 'test' });
    expect(r.consumed).toBe('free');
    expect(r.freeUsed).toBe(1); // counter restarted at 1, not 6

    const row = await db.userCredits.findUnique({ where: { userId } });
    expect(row?.freeImportsPeriod).toBe(currentImportPeriod());
    expect(row?.freeImportsUsed).toBe(1);
  });

  it('PRO users are unlimited and never create a credits row (test 5)', async () => {
    const userId = await freshUser('pro');
    const a = await getImportAllowance(userId, true);
    expect(a.allowed).toBe(true);
    expect(a.source).toBe('pro');
    // The PRO allowance read must not write anything.
    const row = await db.userCredits.findUnique({ where: { userId } });
    expect(row).toBeNull();
  });

  it('parallel imports never exceed the quota or drive credits negative (race-safety)', async () => {
    const userId = await freshUser('race');
    await db.userCredits.create({ data: { userId, importCredits: 3 } });

    // 12 simultaneous consumes against a quota of 5 + 3 paid credits.
    const results = await Promise.all(
      Array.from({ length: 12 }, () => consumeImportCredit(userId, { source: 'test' })),
    );
    const free = results.filter((r) => r.consumed === 'free').length;
    const paid = results.filter((r) => r.consumed === 'paid').length;
    const none = results.filter((r) => r.consumed === 'none').length;
    expect(free).toBe(FREE_IMPORT_QUOTA_PER_MONTH);
    expect(paid).toBe(3);
    expect(none).toBe(12 - FREE_IMPORT_QUOTA_PER_MONTH - 3);

    const row = await db.userCredits.findUnique({ where: { userId } });
    expect(row?.freeImportsUsed).toBe(FREE_IMPORT_QUOTA_PER_MONTH); // never 6+
    expect(row?.importCredits).toBe(0); // never negative
  });

  it('manual item creation never touches import credits (test 8 — regression)', async () => {
    const userId = await freshUser('manual');
    await db.userCredits.create({
      data: { userId, freeImportsUsed: 0, freeImportsPeriod: currentImportPeriod() },
    });
    const wl = await db.wishlist.create({
      data: { ownerId: userId, title: 'Manual', slug: `${PREFIX}-manual-${Date.now()}` },
    });
    await db.item.create({
      data: { wishlistId: wl.id, title: 'Hand-typed wish', url: 'https://example.com/manual', status: 'AVAILABLE' },
    });

    const row = await db.userCredits.findUnique({ where: { userId } });
    expect(row?.freeImportsUsed).toBe(0); // creating an Item consumed nothing
  });
});
