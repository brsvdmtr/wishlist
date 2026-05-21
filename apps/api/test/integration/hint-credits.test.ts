// Integration test — the FREE hint-quota model with real Postgres.
//
// Pins the BEHAVIOUR of the soft-virality monetization fix:
//   • a FREE user gets FREE_HINT_QUOTA_PER_MONTH delivered hints per month;
//   • only a DELIVERED hint is charged — SENT / CANCELLED / EXPIRED cost
//     nothing (the "charge on delivery, never on creation" contract);
//   • the charge is idempotent on hintId — a duplicate users_shared event
//     can never charge twice, even under concurrency;
//   • consume spends the free monthly quota before paid hintCredits;
//   • once both are gone the hint is still delivered, recorded as 'grace';
//   • PRO users never spend the free quota;
//   • parallel deliveries never push the counter past the quota or drive
//     hintCredits below zero (the CLAUDE.md race-class lesson — the reason
//     this is an integration test and not a mock-Prisma unit test).
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
import { trackProductEvent } from '../../src/services/analytics';
import {
  FREE_HINT_QUOTA_PER_MONTH,
  currentHintPeriod,
  getHintAllowance,
  consumeHintCharge,
} from '../../src/services/hint-credits';

const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;
const PREFIX = 'int-hint-credits';
const mockedTrack = vi.mocked(trackProductEvent);

if (SKIP) {
  // eslint-disable-next-line no-console
  console.warn('[integration] DATABASE_URL not set — skipping hint-credits integration tests');
}

suite('hint credits — real Postgres', () => {
  let db: ReturnType<typeof getTestPrisma>;

  async function freshUser(tag: string): Promise<string> {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const u = await db.user.create({ data: { telegramId: `${PREFIX}-${tag}-${suffix}` } });
    return u.id;
  }

  // HintQuotaCharge.hintId is a plain unique string (not a foreign key), so a
  // real Hint row is not needed to exercise the charge engine — just a value
  // unique enough that parallel tests never collide.
  function hintId(tag: string): string {
    return `${PREFIX}-hint-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function cleanup(): Promise<void> {
    await db.hintQuotaCharge.deleteMany({ where: { user: { telegramId: { startsWith: PREFIX } } } });
    await db.userCredits.deleteMany({ where: { user: { telegramId: { startsWith: PREFIX } } } });
    await db.user.deleteMany({ where: { telegramId: { startsWith: PREFIX } } });
  }

  beforeAll(async () => {
    db = getTestPrisma();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await disconnectTestPrisma();
  });

  beforeEach(() => {
    mockedTrack.mockClear();
  });

  it('a fresh FREE user has the full monthly hint allowance (test 1)', async () => {
    const userId = await freshUser('fresh');
    const a = await getHintAllowance(userId, false);
    expect(a.allowed).toBe(true);
    expect(a.isPro).toBe(false);
    expect(a.freeUsed).toBe(0);
    expect(a.freeRemaining).toBe(FREE_HINT_QUOTA_PER_MONTH);
    expect(a.source).toBe('free');
  });

  it('a delivered hint charges one free credit (test 2)', async () => {
    const userId = await freshUser('charge');
    const r = await consumeHintCharge(userId, hintId('c1'), 'DELIVERED', false);
    expect(r.outcome).toBe('free_monthly');
    expect(r.charged).toBe(true);
    expect(r.freeUsed).toBe(1);
    expect(r.freeRemaining).toBe(FREE_HINT_QUOTA_PER_MONTH - 1);

    expect(await db.hintQuotaCharge.count({ where: { userId } })).toBe(1);
    expect(mockedTrack).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'hint.free_quota_charged' }),
    );
  });

  it.each(['SENT', 'CANCELLED', 'EXPIRED'] as const)(
    'a %s (undelivered) hint never charges the quota (tests 4-6)',
    async (status) => {
      const userId = await freshUser(`undelivered-${status}`);
      const r = await consumeHintCharge(userId, hintId(status), status, false);
      expect(r.outcome).toBe('not_delivered');
      expect(r.charged).toBe(false);

      expect(await db.hintQuotaCharge.count({ where: { userId } })).toBe(0);
      const a = await getHintAllowance(userId, false);
      expect(a.freeUsed).toBe(0);
    },
  );

  it('a repeated DELIVERED for the same hint never double-charges (test 3)', async () => {
    const userId = await freshUser('idem');
    const id = hintId('idem');
    const first = await consumeHintCharge(userId, id, 'DELIVERED', false);
    expect(first.outcome).toBe('free_monthly');
    const second = await consumeHintCharge(userId, id, 'DELIVERED', false);
    expect(second.outcome).toBe('replay');
    expect(second.charged).toBe(false); // a replay spends nothing this call

    expect(await db.hintQuotaCharge.count({ where: { userId } })).toBe(1);
    expect((await getHintAllowance(userId, false)).freeUsed).toBe(1);
  });

  it('allows exactly FREE_HINT_QUOTA_PER_MONTH free hints, then denies', async () => {
    const userId = await freshUser('exhaust');
    for (let i = 0; i < FREE_HINT_QUOTA_PER_MONTH; i++) {
      const r = await consumeHintCharge(userId, hintId(`ex${i}`), 'DELIVERED', false);
      expect(r.outcome).toBe('free_monthly');
    }
    // The final charge drains the month → exhausted event fires exactly once.
    const exhausted = mockedTrack.mock.calls.filter(
      (c) => (c[0] as { event: string }).event === 'hint.free_quota_exhausted',
    );
    expect(exhausted).toHaveLength(1);

    const a = await getHintAllowance(userId, false);
    expect(a.allowed).toBe(false);
    expect(a.freeRemaining).toBe(0);
    expect(a.source).toBe('none');
  });

  it('spends the free quota before paid hintCredits (free-first contract)', async () => {
    const userId = await freshUser('order');
    await db.userCredits.create({ data: { userId, hintCredits: 5 } });

    const r = await consumeHintCharge(userId, hintId('o1'), 'DELIVERED', false);
    expect(r.outcome).toBe('free_monthly');

    const row = await db.userCredits.findUnique({ where: { userId } });
    expect(row?.hintCredits).toBe(5); // paid pool untouched while free remains
  });

  it('paid hintCredits cover hints once the free quota is gone (test 5 — paid)', async () => {
    const userId = await freshUser('paid');
    for (let i = 0; i < FREE_HINT_QUOTA_PER_MONTH; i++) {
      await consumeHintCharge(userId, hintId(`p${i}`), 'DELIVERED', false);
    }
    await db.userCredits.upsert({
      where: { userId },
      create: { userId, hintCredits: 3 },
      update: { hintCredits: 3 },
    });

    expect((await getHintAllowance(userId, false)).source).toBe('paid');

    const r = await consumeHintCharge(userId, hintId('p-pack'), 'DELIVERED', false);
    expect(r.outcome).toBe('paid_pack');
    expect(r.charged).toBe(true);

    const row = await db.userCredits.findUnique({ where: { userId } });
    expect(row?.hintCredits).toBe(2);
  });

  it('grace-delivers (uncharged) when free quota AND paid credits are both gone', async () => {
    const userId = await freshUser('grace');
    for (let i = 0; i < FREE_HINT_QUOTA_PER_MONTH; i++) {
      await consumeHintCharge(userId, hintId(`g${i}`), 'DELIVERED', false);
    }
    // No paid credits → the wave was allowed at creation, deliver as grace.
    const r = await consumeHintCharge(userId, hintId('g-grace'), 'DELIVERED', false);
    expect(r.outcome).toBe('grace');
    expect(r.charged).toBe(false);

    const graceRow = await db.hintQuotaCharge.findFirst({ where: { userId, source: 'grace' } });
    expect(graceRow?.charged).toBe(false);
    expect(graceRow?.reason).toBe('quota_changed_after_wave_started');
    expect(mockedTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'hint.free_quota_charge_skipped',
        props: expect.objectContaining({ reason: 'grace' }),
      }),
    );
  });

  it('PRO users are unlimited and never spend the free quota (test: PRO)', async () => {
    const userId = await freshUser('pro');
    const a = await getHintAllowance(userId, true);
    expect(a.allowed).toBe(true);
    expect(a.source).toBe('pro');

    const r = await consumeHintCharge(userId, hintId('pro1'), 'DELIVERED', true);
    expect(r.outcome).toBe('pro');
    expect(r.charged).toBe(false);

    // No free_monthly row written — the free quota is untouched.
    expect(await db.hintQuotaCharge.count({ where: { userId, source: 'free_monthly' } })).toBe(0);
  });

  it('a charge from a prior month does not count toward this month (period isolation)', async () => {
    const userId = await freshUser('period');
    // A free_monthly charge stamped with a stale (prior-month) period bucket.
    await db.hintQuotaCharge.create({
      data: {
        userId,
        hintId: hintId('stale'),
        period: '2000-01',
        source: 'free_monthly',
        charged: true,
      },
    });
    // This month is untouched — the stale row is outside the current bucket.
    const a = await getHintAllowance(userId, false);
    expect(a.freeUsed).toBe(0);
    expect(a.freeRemaining).toBe(FREE_HINT_QUOTA_PER_MONTH);

    // A new delivery is charged against the CURRENT period bucket.
    const r = await consumeHintCharge(userId, hintId('fresh'), 'DELIVERED', false);
    expect(r.outcome).toBe('free_monthly');
    const fresh = await db.hintQuotaCharge.findFirst({
      where: { userId, source: 'free_monthly', period: { not: '2000-01' } },
    });
    expect(fresh?.period).toBe(currentHintPeriod());
  });

  it('parallel deliveries never exceed the quota or drive credits negative (race-safety)', async () => {
    const userId = await freshUser('race');
    await db.userCredits.create({ data: { userId, hintCredits: 3 } });

    // 12 simultaneous deliveries (distinct hints) vs quota 3 + 3 paid credits.
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        consumeHintCharge(userId, hintId(`race${i}`), 'DELIVERED', false),
      ),
    );
    const free = results.filter((r) => r.outcome === 'free_monthly').length;
    const paid = results.filter((r) => r.outcome === 'paid_pack').length;
    const grace = results.filter((r) => r.outcome === 'grace').length;
    expect(free).toBe(FREE_HINT_QUOTA_PER_MONTH);
    expect(paid).toBe(3);
    expect(grace).toBe(12 - FREE_HINT_QUOTA_PER_MONTH - 3);

    const row = await db.userCredits.findUnique({ where: { userId } });
    expect(row?.hintCredits).toBe(0); // never negative

    // The cap held — never a 4th free_monthly row.
    expect(await db.hintQuotaCharge.count({ where: { userId, source: 'free_monthly' } }))
      .toBe(FREE_HINT_QUOTA_PER_MONTH);

    // hint.free_quota_exhausted fires exactly once even under concurrency —
    // the count behind it is taken inside the advisory-locked transaction.
    const exhausted = mockedTrack.mock.calls.filter(
      (c) => (c[0] as { event: string }).event === 'hint.free_quota_exhausted',
    );
    expect(exhausted).toHaveLength(1);
  });

  it('the same hint delivered in parallel charges exactly once (idempotency under race)', async () => {
    const userId = await freshUser('idem-race');
    const id = hintId('idem-race');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => consumeHintCharge(userId, id, 'DELIVERED', false)),
    );
    expect(results.filter((r) => r.outcome === 'free_monthly')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'replay')).toHaveLength(7);
    expect(await db.hintQuotaCharge.count({ where: { userId } })).toBe(1);
  });
});
