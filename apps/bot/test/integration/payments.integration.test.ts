// Real-Postgres integration tests for the payment processors. The
// mocked-Prisma unit tests in src/payments.test.ts cover every branch of
// the application-level guards (duplicate `findUnique` short-circuit,
// lifetime-billingPeriod check); these tests exercise the parts that
// only show up against a real DB:
//
//   • The @unique constraint on PaymentEvent.telegramPaymentChargeId is
//     the actual idempotency enforcer — the findUnique check is a
//     race-condition optimisation, not the safety net.
//   • Subscription upserts must round-trip every column the apps/api
//     entitlement resolver reads (billingPeriod, cancelAtPeriodEnd,
//     currentPeriodEnd) so writer/reader stays in sync.
//   • The lifetime guard must keep the lifetime row byte-identical
//     after a monthly post-lifetime charge.
//
// Skipped automatically when DATABASE_URL is not set so local `pnpm test`
// runs without Postgres. CI's Postgres service exports the env var.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';

import { LIFETIME_BILLING_PERIOD, PRO_LIFETIME_PERIOD_END_ISO } from '@wishlist/shared';

import {
  applyProMonthlyPayment,
  applyProYearlyPayment,
  applyProLifetimePayment,
  applyAddonPayment,
} from '../../src/payments';
import {
  makeMonthlyPayment,
  makeYearlyPayment,
  makeLifetimePayment,
  makeAddonPayment,
  withChargeId,
} from '../fixtures/telegram-payment';
import { getTestPrisma, resetDb, disconnectTestPrisma, hasDb } from '../setup-pg';

const d = hasDb ? describe : describe.skip;

if (!hasDb) {
  // eslint-disable-next-line no-console
  console.warn('[integration] DATABASE_URL not set — skipping bot payment integration tests');
}

d('bot/payments integration (real Postgres)', () => {
  const prisma = hasDb ? getTestPrisma() : (null as never);
  let userId: string;

  beforeAll(async () => {
    if (!hasDb) return;
  });

  beforeEach(async () => {
    await resetDb();
    const user = await prisma.user.create({
      data: { telegramId: '99999', firstName: 'PayTest' },
    });
    userId = user.id;
  });

  afterAll(async () => {
    if (hasDb) await disconnectTestPrisma();
  });

  // ─── Idempotency: @unique on PaymentEvent.telegramPaymentChargeId ─────
  it('pro_monthly: replaying the same chargeId twice creates exactly one Subscription row', async () => {
    const payment = makeMonthlyPayment({ telegramId: '99999' });
    const first = await applyProMonthlyPayment(prisma, userId, payment);
    const second = await applyProMonthlyPayment(prisma, userId, payment);

    expect(first.kind).toBe('pro_monthly_activated');
    expect(second.kind).toBe('duplicate');

    const subs = await prisma.subscription.findMany({ where: { userId } });
    expect(subs).toHaveLength(1);

    const events = await prisma.paymentEvent.findMany({ where: { userId } });
    expect(events).toHaveLength(1);
    expect(events[0]!.eventType).toBe('payment_success');
  });

  it('add-on: replaying the same chargeId twice creates exactly one Purchase + one UserAddOn row', async () => {
    const payment = makeAddonPayment('extra_wishlist_slot', { telegramId: '99999' });
    const first = await applyAddonPayment(prisma, userId, 'extra_wishlist_slot', null, payment);
    const second = await applyAddonPayment(prisma, userId, 'extra_wishlist_slot', null, payment);

    expect(first.kind).toBe('addon_permanent_activated');
    expect(second.kind).toBe('duplicate');

    const purchases = await prisma.purchase.findMany({ where: { userId } });
    expect(purchases).toHaveLength(1);

    const addons = await prisma.userAddOn.findMany({ where: { userId } });
    expect(addons).toHaveLength(1);
    expect(addons[0]!.addonType).toBe('wishlist_slot');
  });

  it('add-on consumable: replay does NOT double-credit hintCredits', async () => {
    const payment = makeAddonPayment('hints_pack_5', { telegramId: '99999' });
    await applyAddonPayment(prisma, userId, 'hints_pack_5', null, payment);
    await applyAddonPayment(prisma, userId, 'hints_pack_5', null, payment); // duplicate

    const credits = await prisma.userCredits.findUnique({ where: { userId } });
    expect(credits?.hintCredits).toBe(5); // not 10
  });

  // ─── Lifetime downgrade protection — full round-trip ──────────────────
  it('monthly charge after lifetime → lifetime row stays byte-identical, audit event added', async () => {
    const lifetimePayment = makeLifetimePayment({ telegramId: '99999' });
    await applyProLifetimePayment(prisma, userId, lifetimePayment);

    const before = await prisma.subscription.findUnique({
      where: { userId_planCode: { userId, planCode: 'PRO' } },
    });
    expect(before?.billingPeriod).toBe(LIFETIME_BILLING_PERIOD);
    expect(before?.currentPeriodEnd.toISOString()).toBe(PRO_LIFETIME_PERIOD_END_ISO);

    const monthlyAfter = makeMonthlyPayment({ telegramId: '99999' });
    const outcome = await applyProMonthlyPayment(prisma, userId, monthlyAfter);
    expect(outcome.kind).toBe('lifetime_guard');

    const after = await prisma.subscription.findUnique({
      where: { userId_planCode: { userId, planCode: 'PRO' } },
    });
    // Full-row equality: every column (id, planCode, status, starsPrice,
    // telegramChargeId, currentPeriodStart/End, billingPeriod,
    // cancelAtPeriodEnd, cancelledAt, source, createdAt, updatedAt) must
    // match. Tightest possible assertion — a regression that overwrites
    // any single field (e.g. a future "refresh chargeId on every webhook"
    // patch that forgot the lifetime guard) lights up immediately.
    expect(after).toEqual(before);

    // Audit trail: 2 PaymentEvents — the lifetime activation and the post-lifetime monthly.
    const events = await prisma.paymentEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });
    expect(events).toHaveLength(2);
    expect(events[0]!.eventType).toBe('payment_success_lifetime');
    expect(events[1]!.eventType).toBe('payment_success_post_lifetime');
  });

  // ─── Yearly stacking — real DB respects the max(now, end) semantics ─────
  it('yearly on top of active monthly: periodEnd extends from existing currentPeriodEnd', async () => {
    const monthlyPayment = makeMonthlyPayment({ telegramId: '99999' });
    await applyProMonthlyPayment(prisma, userId, monthlyPayment);

    const monthlyEnd = (await prisma.subscription.findUnique({
      where: { userId_planCode: { userId, planCode: 'PRO' } },
    }))!.currentPeriodEnd;

    const yearlyPayment = makeYearlyPayment({ telegramId: '99999' });
    const outcome = await applyProYearlyPayment(prisma, userId, yearlyPayment);

    if (outcome.kind !== 'pro_yearly_activated') throw new Error(`expected pro_yearly_activated, got ${outcome.kind}`);

    const expectedEnd = new Date(monthlyEnd.getTime() + 365 * 24 * 60 * 60 * 1000);
    expect(outcome.periodEnd.getTime()).toBe(expectedEnd.getTime());

    const finalSub = await prisma.subscription.findUnique({
      where: { userId_planCode: { userId, planCode: 'PRO' } },
    });
    expect(finalSub?.billingPeriod).toBe('yearly');
    expect(finalSub?.cancelAtPeriodEnd).toBe(true);
    expect(finalSub?.currentPeriodEnd.toISOString()).toBe(expectedEnd.toISOString());
    // starsPrice is overwritten on upsert — yearly's 800 stars supersedes
    // the monthly's 100. A regression that "preserves original starsPrice"
    // (e.g. a future "track first-purchase price" patch) would break this.
    expect(finalSub?.starsPrice).toBe(800);
  });

  // ─── Add-on: real schema accepts the row shapes the processors emit ──
  it('add-on permanent: UserAddOn row stored with the expected addonType + quantity', async () => {
    const payment = makeAddonPayment('extra_items_15', { telegramId: '99999', targetId: 'w_42' });
    const outcome = await applyAddonPayment(prisma, userId, 'extra_items_15', 'w_42', payment);

    expect(outcome.kind).toBe('addon_permanent_activated');

    const addon = await prisma.userAddOn.findFirst({ where: { userId } });
    expect(addon?.addonType).toBe('item_slot_15');
    expect(addon?.quantity).toBe(15);
    expect(addon?.targetId).toBe('w_42');
  });

  it('add-on consumable: import credits stack across multiple distinct purchases', async () => {
    await applyAddonPayment(
      prisma, userId, 'import_pack_10', null,
      withChargeId(makeAddonPayment('import_pack_10', { telegramId: '99999' }), 'chg_first'),
    );
    await applyAddonPayment(
      prisma, userId, 'import_pack_25', null,
      withChargeId(makeAddonPayment('import_pack_25', { telegramId: '99999' }), 'chg_second'),
    );

    const credits = await prisma.userCredits.findUnique({ where: { userId } });
    expect(credits?.importCredits).toBe(35); // 10 + 25
  });
});
