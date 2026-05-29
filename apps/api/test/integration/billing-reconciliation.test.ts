// Integration tests for billing reconciliation against real Postgres.
//
// The detection BRANCHING is covered exhaustively by the fast unit test
// (src/services/billing-reconciliation.test.ts) with a fake Prisma. This file
// covers what a mock cannot:
//   • schema-shape: reconcileBilling()'s `select` field names match the real
//     Prisma client (catches drift if a billing column is renamed);
//   • the mutating applySafeFixes() — a real UPDATE + its idempotency;
//   • the read-only guarantee for reconcileBilling() against a live DB
//     (self-check: "dry-run doesn't change data").
//
// Auto-skips when DATABASE_URL is not set (local without `docker compose up
// postgres`); always runs on CI.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getTestPrisma, disconnectTestPrisma } from '../setup-pg';
import { reconcileBilling, applySafeFixes } from '../../src/services/billing-reconciliation';

const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;
const PREFIX = 'int-billrecon';

if (SKIP) {
  // eslint-disable-next-line no-console
  console.warn('[integration] DATABASE_URL not set — skipping billing-reconciliation integration tests');
}

suite('billing reconciliation — real Postgres', () => {
  const db = getTestPrisma();

  async function clean() {
    await db.paymentEvent.deleteMany({ where: { user: { telegramId: { startsWith: PREFIX } } } });
    await db.purchase.deleteMany({ where: { user: { telegramId: { startsWith: PREFIX } } } });
    await db.subscription.deleteMany({ where: { user: { telegramId: { startsWith: PREFIX } } } });
    await db.user.deleteMany({ where: { telegramId: { startsWith: PREFIX } } });
  }

  beforeAll(clean);
  afterAll(async () => { await clean(); await disconnectTestPrisma(); });
  beforeEach(clean);

  let userSeq = 0;
  async function makeUser() {
    return db.user.create({ data: { telegramId: `${PREFIX}-${++userSeq}-${Math.random().toString(36).slice(2, 8)}` } });
  }
  async function makeProSub(userId: string, over: Record<string, unknown> = {}) {
    return db.subscription.create({
      data: {
        userId,
        planCode: 'PRO',
        status: 'ACTIVE',
        starsPrice: 199,
        currentPeriodStart: new Date('2026-05-01T00:00:00Z'),
        currentPeriodEnd: new Date('2026-06-01T00:00:00Z'),
        source: 'telegram_stars',
        billingPeriod: 'monthly',
        ...over,
      },
    });
  }
  async function makeEvent(userId: string, over: Record<string, unknown> = {}) {
    return db.paymentEvent.create({
      data: {
        userId,
        telegramPaymentChargeId: `${PREFIX}-tc-${Math.random().toString(36).slice(2, 10)}`,
        invoicePayload: 'pro_monthly:123:abc',
        totalAmount: 199,
        currency: 'XTR',
        eventType: 'payment_success',
        ...over,
      },
    });
  }

  it('reconcileBilling runs against the real schema and returns a well-formed report', async () => {
    const u = await makeUser();
    const sub = await makeProSub(u.id, { telegramChargeId: 'tc-shape' });
    await makeEvent(u.id, { subscriptionId: sub.id, telegramPaymentChargeId: 'tc-shape', providerPaymentChargeId: 'pp-shape' });

    const report = await reconcileBilling(db, { now: new Date('2026-05-15T00:00:00Z') });
    expect(report.generatedAt).toBeTruthy();
    expect(report.scanned.paymentEvents).toBeGreaterThanOrEqual(1);
    // Our own well-formed rows must contribute no findings.
    const mine = report.findings.filter((f) => f.subscriptionId === sub.id || f.userId === u.id);
    expect(mine).toEqual([]);
  });

  it('distinguishes a paid (telegram_stars) sub from a free grant for the missing-payment check', async () => {
    const paidUser = await makeUser();
    await makeProSub(paidUser.id, { source: 'telegram_stars', starsPrice: 199 }); // no PaymentEvent → anomaly
    const freeUser = await makeUser();
    await makeProSub(freeUser.id, { source: 'referral_reward', starsPrice: 0 }); // free grant → fine

    const report = await reconcileBilling(db, { now: new Date('2026-05-15T00:00:00Z') });
    const missing = report.findings.filter((f) => f.kind === 'subscription_without_payment_event');
    expect(missing.some((f) => f.userId === paidUser.id)).toBe(true);
    expect(missing.some((f) => f.userId === freeUser.id)).toBe(false);
  });

  it('reconcileBilling is read-only — row counts are unchanged after a run', async () => {
    const u = await makeUser();
    await makeProSub(u.id, { source: 'telegram_stars' }); // intentionally an anomaly
    await makeEvent(u.id, { subscriptionId: null, eventType: 'payment_success' }); // intentionally an orphan

    const before = await Promise.all([db.paymentEvent.count(), db.subscription.count(), db.purchase.count()]);
    const report = await reconcileBilling(db, { now: new Date('2026-05-15T00:00:00Z') });
    expect(report.ok).toBe(false); // it DID find the anomalies
    const after = await Promise.all([db.paymentEvent.count(), db.subscription.count(), db.purchase.count()]);
    expect(after).toEqual(before); // …but changed nothing
  });

  it('applySafeFixes relinks an unambiguous orphan and is idempotent', async () => {
    const u = await makeUser();
    const sub = await makeProSub(u.id, { telegramChargeId: 'tc-apply' });
    const orphan = await makeEvent(u.id, {
      subscriptionId: null,
      eventType: 'payment_success',
      telegramPaymentChargeId: 'tc-apply', // matches the sub exactly → unambiguous
    });

    const first = await applySafeFixes(db);
    expect(first.relinkedPaymentEvents).toContainEqual({ paymentEventId: orphan.id, subscriptionId: sub.id });

    const reloaded = await db.paymentEvent.findUnique({ where: { id: orphan.id } });
    expect(reloaded?.subscriptionId).toBe(sub.id);

    // Idempotent: a second apply finds nothing to relink for this event.
    const second = await applySafeFixes(db);
    expect(second.relinkedPaymentEvents.some((r) => r.paymentEventId === orphan.id)).toBe(false);
  });

  it('applySafeFixes skips (does NOT guess) when the user has no PRO subscription', async () => {
    const u = await makeUser();
    const orphan = await makeEvent(u.id, { subscriptionId: null, eventType: 'payment_success' });

    const res = await applySafeFixes(db);
    expect(res.relinkedPaymentEvents.some((r) => r.paymentEventId === orphan.id)).toBe(false);
    expect(res.skipped).toContainEqual({ paymentEventId: orphan.id, reason: 'no PRO subscription for user' });

    const reloaded = await db.paymentEvent.findUnique({ where: { id: orphan.id } });
    expect(reloaded?.subscriptionId).toBeNull(); // untouched
  });
});
