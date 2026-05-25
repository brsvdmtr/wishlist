// Unit tests for the Telegram-Stars `successful_payment` processors —
// the money paths that decide whether a user becomes / stays PRO and
// what add-ons they have. Mocks Prisma so we can drive every branch
// (happy path, duplicate webhook, lifetime guard, add-on permanent vs
// consumable) without a Postgres dependency.
//
// Pairs with apps/bot/test/fixtures/telegram-payment.ts (Telegram payload
// builders) and apps/api/src/services/entitlement.test.ts (resolver-side
// coverage of the priority order + effective caps).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  subscriptionFindUnique: vi.fn(),
  subscriptionUpsert:     vi.fn(),
  paymentEventFindUnique: vi.fn(),
  paymentEventCreate:     vi.fn(),
  purchaseFindUnique:     vi.fn(),
  purchaseCreate:         vi.fn(),
  userAddOnCreate:        vi.fn(),
  userCreditsUpsert:      vi.fn(),
}));

const txClient = {
  subscription: { upsert: dbMocks.subscriptionUpsert },
  paymentEvent: { create: dbMocks.paymentEventCreate },
  purchase:     { create: dbMocks.purchaseCreate },
  userAddOn:    { create: dbMocks.userAddOnCreate },
  userCredits:  { upsert: dbMocks.userCreditsUpsert },
};

vi.mock('@wishlist/db', () => ({
  prisma: {
    subscription: { findUnique: dbMocks.subscriptionFindUnique },
    paymentEvent: { findUnique: dbMocks.paymentEventFindUnique, create: dbMocks.paymentEventCreate },
    purchase:     { findUnique: dbMocks.purchaseFindUnique },
    $transaction: (cb: (tx: typeof txClient) => unknown) => cb(txClient),
  },
}));

import { prisma as prismaMock } from '@wishlist/db';
import type { PrismaClient } from '@wishlist/db';
import { LIFETIME_BILLING_PERIOD, PRO_LIFETIME_PERIOD_END_ISO } from '@wishlist/shared';

import {
  applyProMonthlyPayment,
  applyProYearlyPayment,
  applyProLifetimePayment,
  applyAddonPayment,
  KNOWN_ADDON_SKUS,
  MONTHLY_PERIOD_MS,
  YEARLY_PERIOD_MS,
} from './payments';
import {
  makeMonthlyPayment,
  makeYearlyPayment,
  makeLifetimePayment,
  makeAddonPayment,
  withChargeId,
} from '../test/fixtures/telegram-payment';

// `prismaMock` is the mocked `@wishlist/db` export (see vi.mock above) —
// at runtime every Prisma call lands on a vi.fn() spy. The cast is only
// to satisfy the processor signatures (typed as PrismaClient).
const prisma = prismaMock as unknown as PrismaClient;

const USER_ID = 'u_test';

function resetAllMocks() {
  for (const m of Object.values(dbMocks)) (m as ReturnType<typeof vi.fn>).mockReset?.();
  // Defaults: nothing in the DB, all writes return a usable row.
  dbMocks.subscriptionFindUnique.mockResolvedValue(null);
  dbMocks.paymentEventFindUnique.mockResolvedValue(null);
  dbMocks.purchaseFindUnique.mockResolvedValue(null);
  dbMocks.subscriptionUpsert.mockImplementation(async (args: { create: Record<string, unknown> }) => ({
    id: 'sub_test', ...args.create,
  }));
  dbMocks.paymentEventCreate.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: 'evt_test', ...args.data,
  }));
  dbMocks.purchaseCreate.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: 'pur_test', ...args.data,
  }));
  dbMocks.userAddOnCreate.mockImplementation(async (args: { data: Record<string, unknown> }) => ({
    id: 'addon_test', ...args.data,
  }));
  dbMocks.userCreditsUpsert.mockImplementation(async () => ({ id: 'credits_test', userId: USER_ID }));
}

beforeEach(resetAllMocks);

// ─────────────────────────────────────────────────────────────────────────
// 1. Payment idempotency — duplicate webhook must NOT create duplicate rows
// ─────────────────────────────────────────────────────────────────────────
describe('payment idempotency — PaymentEvent.telegramPaymentChargeId is the dedup key', () => {
  it('pro_monthly: duplicate chargeId returns { kind: duplicate } and writes nothing', async () => {
    dbMocks.paymentEventFindUnique.mockResolvedValueOnce({ id: 'evt_existing' });

    const outcome = await applyProMonthlyPayment(prisma, USER_ID, makeMonthlyPayment());

    expect(outcome).toEqual({ kind: 'duplicate' });
    expect(dbMocks.subscriptionUpsert).not.toHaveBeenCalled();
    expect(dbMocks.paymentEventCreate).not.toHaveBeenCalled();
  });

  it('pro_yearly: duplicate chargeId returns { kind: duplicate } and writes nothing', async () => {
    dbMocks.paymentEventFindUnique.mockResolvedValueOnce({ id: 'evt_existing' });

    const outcome = await applyProYearlyPayment(prisma, USER_ID, makeYearlyPayment());

    expect(outcome).toEqual({ kind: 'duplicate' });
    expect(dbMocks.subscriptionUpsert).not.toHaveBeenCalled();
  });

  it('pro_lifetime: duplicate chargeId returns { kind: duplicate } and writes nothing', async () => {
    dbMocks.paymentEventFindUnique.mockResolvedValueOnce({ id: 'evt_existing' });

    const outcome = await applyProLifetimePayment(prisma, USER_ID, makeLifetimePayment());

    expect(outcome).toEqual({ kind: 'duplicate' });
    expect(dbMocks.subscriptionUpsert).not.toHaveBeenCalled();
  });

  it('addon: duplicate Purchase.telegramChargeId returns { kind: duplicate } and writes nothing', async () => {
    dbMocks.purchaseFindUnique.mockResolvedValueOnce({ id: 'pur_existing' });

    const outcome = await applyAddonPayment(
      prisma, USER_ID, 'extra_wishlist_slot', null, makeAddonPayment('extra_wishlist_slot'),
    );

    expect(outcome).toEqual({ kind: 'duplicate' });
    expect(dbMocks.purchaseCreate).not.toHaveBeenCalled();
    expect(dbMocks.userAddOnCreate).not.toHaveBeenCalled();
    expect(dbMocks.userCreditsUpsert).not.toHaveBeenCalled();
  });

  it('idempotency check uses the exact telegramPaymentChargeId and propagates it to row writes', async () => {
    const payment = withChargeId(makeMonthlyPayment(), 'tg_charge_specific_123');
    await applyProMonthlyPayment(prisma, USER_ID, payment);
    // 1. Dedup probe — query is keyed on the literal chargeId.
    expect(dbMocks.paymentEventFindUnique).toHaveBeenCalledWith({
      where: { telegramPaymentChargeId: 'tg_charge_specific_123' },
    });
    // 2. Subscription row stores the same chargeId (so the next /sync from
    //    apps/api can match against it).
    const subUpsertArg = dbMocks.subscriptionUpsert.mock.calls[0]![0];
    expect(subUpsertArg.create.telegramChargeId).toBe('tg_charge_specific_123');
    expect(subUpsertArg.update.telegramChargeId).toBe('tg_charge_specific_123');
    // 3. PaymentEvent row stores the same chargeId (the @unique column
    //    that prevents the duplicate insert on replay).
    const evtArg = dbMocks.paymentEventCreate.mock.calls[0]![0];
    expect(evtArg.data.telegramPaymentChargeId).toBe('tg_charge_specific_123');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Lifetime downgrade protection
//    If a monthly/yearly Telegram-Stars charge fires AFTER a lifetime
//    purchase (e.g. an auto-renew Telegram never cancelled server-side),
//    the lifetime row must stay intact. The webhook only writes an audit
//    PaymentEvent and returns lifetime_guard.
// ─────────────────────────────────────────────────────────────────────────
describe('lifetime downgrade protection', () => {
  const lifetimeRow = {
    id: 'sub_lifetime',
    userId: USER_ID,
    planCode: 'PRO',
    billingPeriod: LIFETIME_BILLING_PERIOD,
    status: 'ACTIVE',
    currentPeriodEnd: new Date(PRO_LIFETIME_PERIOD_END_ISO),
  };

  it('monthly charge after lifetime → no upsert, audit PaymentEvent only', async () => {
    dbMocks.subscriptionFindUnique.mockResolvedValueOnce(lifetimeRow);

    const outcome = await applyProMonthlyPayment(prisma, USER_ID, makeMonthlyPayment());

    if (outcome.kind !== 'lifetime_guard') throw new Error(`expected lifetime_guard, got ${outcome.kind}`);
    expect(outcome.billingPeriodAttempted).toBe('monthly');

    // Lifetime stays — no upsert ever happens.
    expect(dbMocks.subscriptionUpsert).not.toHaveBeenCalled();

    // Audit event is recorded with the canonical eventType so the
    // payment.completed funnel can spot accidental Telegram auto-renew
    // patterns post-lifetime.
    expect(dbMocks.paymentEventCreate).toHaveBeenCalledTimes(1);
    const auditArg = dbMocks.paymentEventCreate.mock.calls[0]![0];
    expect(auditArg.data).toMatchObject({
      subscriptionId: 'sub_lifetime',
      userId: USER_ID,
      eventType: 'payment_success_post_lifetime',
    });
  });

  it('yearly charge after lifetime → no upsert, audit PaymentEvent only', async () => {
    dbMocks.subscriptionFindUnique.mockResolvedValueOnce(lifetimeRow);

    const outcome = await applyProYearlyPayment(prisma, USER_ID, makeYearlyPayment());

    if (outcome.kind !== 'lifetime_guard') throw new Error(`expected lifetime_guard, got ${outcome.kind}`);
    expect(outcome.billingPeriodAttempted).toBe('yearly');
    expect(dbMocks.subscriptionUpsert).not.toHaveBeenCalled();
    expect(dbMocks.paymentEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'payment_success_post_lifetime' }),
      }),
    );
  });

  it('lifetime guard fires regardless of currentPeriodEnd — billingPeriod is SSOT', async () => {
    // Even if the lifetime row's currentPeriodEnd was somehow in the past
    // (clock skew, bad migration), the billingPeriod='lifetime' marker is
    // the authoritative discriminator. The 2099-12-31 sentinel is defensive
    // padding, never the source of truth.
    dbMocks.subscriptionFindUnique.mockResolvedValueOnce({
      ...lifetimeRow, currentPeriodEnd: new Date('2020-01-01'),
    });
    const outcome = await applyProMonthlyPayment(prisma, USER_ID, makeMonthlyPayment());
    expect(outcome.kind).toBe('lifetime_guard');
    expect(dbMocks.subscriptionUpsert).not.toHaveBeenCalled();
  });

  it('monthly subscriber (not lifetime) → renewal goes through, no guard fires', async () => {
    dbMocks.subscriptionFindUnique.mockResolvedValue({
      id: 'sub_monthly',
      userId: USER_ID,
      planCode: 'PRO',
      billingPeriod: 'monthly',
      status: 'ACTIVE',
      currentPeriodEnd: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // 5d remaining
    });
    const outcome = await applyProMonthlyPayment(prisma, USER_ID, makeMonthlyPayment());
    expect(outcome.kind).toBe('pro_monthly_activated');
    expect(dbMocks.subscriptionUpsert).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Add-on purchase — consumable credits vs. permanent unlock
// ─────────────────────────────────────────────────────────────────────────
describe('add-on purchase — consumable credits', () => {
  it('hints_pack_5 → UserCredits upsert with hintCredits +5; no UserAddOn write', async () => {
    const outcome = await applyAddonPayment(
      prisma, USER_ID, 'hints_pack_5', null, makeAddonPayment('hints_pack_5', { total_amount: 29 }),
    );

    expect(outcome).toEqual({
      kind: 'addon_consumable_activated',
      skuCode: 'hints_pack_5',
      creditKey: 'hintCredits',
      amount: 5,
    });
    expect(dbMocks.userCreditsUpsert).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      create: { userId: USER_ID, hintCredits: 5, importCredits: 0 },
      update: { hintCredits: { increment: 5 } },
    });
    expect(dbMocks.userAddOnCreate).not.toHaveBeenCalled();
  });

  it('hints_pack_10 → +10 hint credits', async () => {
    const outcome = await applyAddonPayment(
      prisma, USER_ID, 'hints_pack_10', null, makeAddonPayment('hints_pack_10'),
    );
    expect(outcome).toMatchObject({ kind: 'addon_consumable_activated', amount: 10 });
    expect(dbMocks.userCreditsUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ update: { hintCredits: { increment: 10 } } }),
    );
  });

  it('import_pack_25 → +25 import credits (importCredits key, not hintCredits)', async () => {
    const outcome = await applyAddonPayment(
      prisma, USER_ID, 'import_pack_25', null, makeAddonPayment('import_pack_25'),
    );
    expect(outcome).toEqual({
      kind: 'addon_consumable_activated',
      skuCode: 'import_pack_25',
      creditKey: 'importCredits',
      amount: 25,
    });
    expect(dbMocks.userCreditsUpsert).toHaveBeenCalledWith({
      where: { userId: USER_ID },
      create: { userId: USER_ID, hintCredits: 0, importCredits: 25 },
      update: { importCredits: { increment: 25 } },
    });
  });

  it('purchase + payment event are both recorded for consumables (audit trail)', async () => {
    await applyAddonPayment(
      prisma, USER_ID, 'import_pack_10', null, makeAddonPayment('import_pack_10'),
    );
    expect(dbMocks.purchaseCreate).toHaveBeenCalledTimes(1);
    expect(dbMocks.paymentEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'addon_payment_success' }),
      }),
    );
  });
});

describe('add-on purchase — permanent unlocks', () => {
  it('extra_wishlist_slot → UserAddOn create with addonType=wishlist_slot, qty 1, no target', async () => {
    const outcome = await applyAddonPayment(
      prisma, USER_ID, 'extra_wishlist_slot', null, makeAddonPayment('extra_wishlist_slot'),
    );

    expect(outcome).toEqual({
      kind: 'addon_permanent_activated',
      skuCode: 'extra_wishlist_slot',
      targetId: null,
      addonType: 'wishlist_slot',
      quantity: 1,
    });
    expect(dbMocks.userAddOnCreate).toHaveBeenCalledWith({
      data: { userId: USER_ID, addonType: 'wishlist_slot', quantity: 1, targetId: null },
    });
    expect(dbMocks.userCreditsUpsert).not.toHaveBeenCalled();
  });

  it('extra_items_5 → quantity:5 + per-wishlist targetId (item slots are scoped)', async () => {
    const outcome = await applyAddonPayment(
      prisma, USER_ID, 'extra_items_5', 'w_target_42', makeAddonPayment('extra_items_5', { targetId: 'w_target_42' }),
    );

    expect(outcome).toMatchObject({ kind: 'addon_permanent_activated', quantity: 5, targetId: 'w_target_42' });
    expect(dbMocks.userAddOnCreate).toHaveBeenCalledWith({
      data: { userId: USER_ID, addonType: 'item_slot_5', quantity: 5, targetId: 'w_target_42' },
    });
  });

  it('extra_items_15 → quantity:15 + per-wishlist targetId', async () => {
    const outcome = await applyAddonPayment(
      prisma, USER_ID, 'extra_items_15', 'w_target_99', makeAddonPayment('extra_items_15', { targetId: 'w_target_99' }),
    );
    expect(outcome).toMatchObject({ kind: 'addon_permanent_activated', quantity: 15 });
    expect(dbMocks.userAddOnCreate).toHaveBeenCalledWith({
      data: { userId: USER_ID, addonType: 'item_slot_15', quantity: 15, targetId: 'w_target_99' },
    });
  });

  it('gift_notes_unlock → UserAddOn create, no per-wishlist target', async () => {
    const outcome = await applyAddonPayment(
      prisma, USER_ID, 'gift_notes_unlock', null, makeAddonPayment('gift_notes_unlock'),
    );
    expect(outcome).toMatchObject({ kind: 'addon_permanent_activated', addonType: 'gift_notes_unlock' });
  });

  it('reservation_pro_unlock → UserAddOn create with addonType=reservation_pro_unlock', async () => {
    const outcome = await applyAddonPayment(
      prisma, USER_ID, 'reservation_pro_unlock', null, makeAddonPayment('reservation_pro_unlock'),
    );
    expect(outcome).toMatchObject({ kind: 'addon_permanent_activated', addonType: 'reservation_pro_unlock' });
  });

  it('smart_reservations_unlock → per-wishlist UserAddOn create with target preserved', async () => {
    await applyAddonPayment(
      prisma, USER_ID, 'smart_reservations_unlock', 'w_smart', makeAddonPayment('smart_reservations_unlock', { targetId: 'w_smart' }),
    );
    expect(dbMocks.userAddOnCreate).toHaveBeenCalledWith({
      data: { userId: USER_ID, addonType: 'smart_reservations_unlock', quantity: 1, targetId: 'w_smart' },
    });
  });

  // Unknown SKU is a drift-detection branch: pre_checkout already
  // validates SKUs, so this only fires if pre_checkout's KNOWN_SKUS list
  // drifts from the processor's SKU_ADDON_TYPES + SKU_CREDITS maps. The
  // contract (byte-identical to the pre-extraction handler): Purchase +
  // PaymentEvent still written for audit + dedup, but no UserAddOn /
  // UserCredits write so the user gets no fake entitlement. The wrapper
  // suppresses the "activated" reply on this branch.
  it('unknown SKU → { kind: addon_unknown_sku }; Purchase + PaymentEvent written, no entitlement', async () => {
    const outcome = await applyAddonPayment(
      prisma, USER_ID, 'mystery_sku_99', null, makeAddonPayment('mystery_sku_99'),
    );
    expect(outcome).toEqual({ kind: 'addon_unknown_sku', skuCode: 'mystery_sku_99' });
    expect(dbMocks.purchaseCreate).toHaveBeenCalledTimes(1);
    expect(dbMocks.paymentEventCreate).toHaveBeenCalledTimes(1);
    // No entitlement granted — the whole point of the drift guard.
    expect(dbMocks.userAddOnCreate).not.toHaveBeenCalled();
    expect(dbMocks.userCreditsUpsert).not.toHaveBeenCalled();
  });

  // ─── SKU coverage — one assertion per sellable SKU ──────────────────────
  // Catches typos in SKU_ADDON_TYPES (apps/bot/src/payments.ts) which
  // otherwise ship silently — the user pays, the row writes, but downstream
  // effective-entitlement aggregation finds no matching addonType.
  it('extra_subscription_slot → addonType=subscription_slot, qty 1', async () => {
    await applyAddonPayment(
      prisma, USER_ID, 'extra_subscription_slot', null, makeAddonPayment('extra_subscription_slot'),
    );
    expect(dbMocks.userAddOnCreate).toHaveBeenCalledWith({
      data: { userId: USER_ID, addonType: 'subscription_slot', quantity: 1, targetId: null },
    });
  });

  it('seasonal_decoration → addonType=seasonal_decoration with per-wishlist target', async () => {
    await applyAddonPayment(
      prisma, USER_ID, 'seasonal_decoration', 'w_xmas',
      makeAddonPayment('seasonal_decoration', { targetId: 'w_xmas' }),
    );
    expect(dbMocks.userAddOnCreate).toHaveBeenCalledWith({
      data: { userId: USER_ID, addonType: 'seasonal_decoration', quantity: 1, targetId: 'w_xmas' },
    });
  });

  it('group_gift_unlock → addonType=group_gift_unlock, account-level', async () => {
    await applyAddonPayment(
      prisma, USER_ID, 'group_gift_unlock', null, makeAddonPayment('group_gift_unlock'),
    );
    expect(dbMocks.userAddOnCreate).toHaveBeenCalledWith({
      data: { userId: USER_ID, addonType: 'group_gift_unlock', quantity: 1, targetId: null },
    });
  });

  it('secret_reservation_unlock → addonType=secret_reservation_unlock, account-level', async () => {
    await applyAddonPayment(
      prisma, USER_ID, 'secret_reservation_unlock', null, makeAddonPayment('secret_reservation_unlock'),
    );
    expect(dbMocks.userAddOnCreate).toHaveBeenCalledWith({
      data: { userId: USER_ID, addonType: 'secret_reservation_unlock', quantity: 1, targetId: null },
    });
  });
});

describe('KNOWN_ADDON_SKUS coverage', () => {
  it('lists all 14 sellable SKUs (10 permanent unlocks + 4 consumable packs)', () => {
    expect(KNOWN_ADDON_SKUS.size).toBe(14);
  });

  it('contains every SKU the apps/api billing routes can mint an invoice for', () => {
    for (const sku of [
      'extra_wishlist_slot', 'extra_subscription_slot',
      'extra_items_5', 'extra_items_15',
      'hints_pack_5', 'hints_pack_10',
      'import_pack_10', 'import_pack_25',
      'seasonal_decoration',
      'gift_notes_unlock', 'reservation_pro_unlock',
      'smart_reservations_unlock', 'secret_reservation_unlock',
      'group_gift_unlock',
    ]) {
      expect(KNOWN_ADDON_SKUS.has(sku)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Happy paths — what the Subscription rows look like after each tier
// ─────────────────────────────────────────────────────────────────────────
describe('pro_monthly happy path', () => {
  it('first-time activation: subscription upsert with billingPeriod=monthly, hadActivePriorSub=false', async () => {
    dbMocks.subscriptionFindUnique.mockResolvedValue(null);
    const outcome = await applyProMonthlyPayment(prisma, USER_ID, makeMonthlyPayment());

    if (outcome.kind !== 'pro_monthly_activated') throw new Error(`expected pro_monthly_activated, got ${outcome.kind}`);
    expect(outcome.hadActivePriorSub).toBe(false);

    expect(dbMocks.subscriptionUpsert).toHaveBeenCalledTimes(1);
    const arg = dbMocks.subscriptionUpsert.mock.calls[0]![0];
    expect(arg.where).toEqual({ userId_planCode: { userId: USER_ID, planCode: 'PRO' } });
    expect(arg.create).toMatchObject({
      planCode: 'PRO',
      status: 'ACTIVE',
      billingPeriod: 'monthly',
      cancelAtPeriodEnd: false,
      source: 'telegram_stars',
    });
    expect(arg.update).toMatchObject({
      status: 'ACTIVE',
      billingPeriod: 'monthly',
      cancelAtPeriodEnd: false,
      cancelledAt: null,
    });
  });

  it('renewal of active sub: hadActivePriorSub=true (renewed funnel branch)', async () => {
    dbMocks.subscriptionFindUnique.mockResolvedValue({
      id: 'sub_existing',
      billingPeriod: 'monthly',
      status: 'ACTIVE',
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });
    const outcome = await applyProMonthlyPayment(prisma, USER_ID, makeMonthlyPayment());
    if (outcome.kind !== 'pro_monthly_activated') throw new Error(`expected pro_monthly_activated, got ${outcome.kind}`);
    expect(outcome.hadActivePriorSub).toBe(true);
  });

  it('uses subscription_expiration_date when Telegram provides it', async () => {
    const futureSec = Math.floor((Date.now() + 60 * 86_400_000) / 1000);
    const outcome = await applyProMonthlyPayment(
      prisma, USER_ID,
      makeMonthlyPayment({ subscription_expiration_date: futureSec }),
    );
    if (outcome.kind !== 'pro_monthly_activated') throw new Error(`expected pro_monthly_activated, got ${outcome.kind}`);
    expect(outcome.periodEnd.getTime()).toBe(futureSec * 1000);
  });

  it('falls back to now + 30 days when subscription_expiration_date is absent', async () => {
    const before = Date.now();
    const outcome = await applyProMonthlyPayment(prisma, USER_ID, makeMonthlyPayment());
    const after = Date.now();
    if (outcome.kind !== 'pro_monthly_activated') throw new Error('expected monthly_activated');
    expect(outcome.periodEnd.getTime()).toBeGreaterThanOrEqual(before + MONTHLY_PERIOD_MS);
    expect(outcome.periodEnd.getTime()).toBeLessThanOrEqual(after + MONTHLY_PERIOD_MS + 50);
  });
});

describe('pro_yearly happy path', () => {
  it('first-time activation: stacking from null (now-anchored), cancelAtPeriodEnd=true', async () => {
    const before = Date.now();
    const outcome = await applyProYearlyPayment(prisma, USER_ID, makeYearlyPayment());
    const after = Date.now();

    if (outcome.kind !== 'pro_yearly_activated') throw new Error(`expected pro_yearly_activated, got ${outcome.kind}`);
    expect(outcome.stackedFromExisting).toBeNull();
    expect(outcome.periodEnd.getTime()).toBeGreaterThanOrEqual(before + YEARLY_PERIOD_MS);
    expect(outcome.periodEnd.getTime()).toBeLessThanOrEqual(after + YEARLY_PERIOD_MS + 50);

    const arg = dbMocks.subscriptionUpsert.mock.calls[0]![0];
    expect(arg.create).toMatchObject({ billingPeriod: 'yearly', cancelAtPeriodEnd: true });
  });

  it('stacks on existing monthly: periodEnd starts from existing currentPeriodEnd + 365d', async () => {
    const existingEnd = new Date(Date.now() + 10 * 86_400_000); // 10d remaining
    dbMocks.subscriptionFindUnique.mockResolvedValue({
      id: 'sub_monthly',
      billingPeriod: 'monthly',
      status: 'ACTIVE',
      currentPeriodEnd: existingEnd,
    });
    const outcome = await applyProYearlyPayment(prisma, USER_ID, makeYearlyPayment());
    if (outcome.kind !== 'pro_yearly_activated') throw new Error(`expected pro_yearly_activated, got ${outcome.kind}`);
    expect(outcome.stackedFromExisting).toEqual(existingEnd);
    expect(outcome.periodEnd.getTime()).toBe(existingEnd.getTime() + YEARLY_PERIOD_MS);
  });

  it('expired existing sub does NOT inflate stacking — starts from now', async () => {
    const expiredEnd = new Date(Date.now() - 86_400_000); // expired yesterday
    dbMocks.subscriptionFindUnique.mockResolvedValue({
      id: 'sub_expired',
      billingPeriod: 'monthly',
      status: 'EXPIRED',
      currentPeriodEnd: expiredEnd,
    });
    const outcome = await applyProYearlyPayment(prisma, USER_ID, makeYearlyPayment());
    if (outcome.kind !== 'pro_yearly_activated') throw new Error(`expected pro_yearly_activated, got ${outcome.kind}`);
    expect(outcome.stackedFromExisting).toBeNull();
  });
});

describe('pro_lifetime happy path', () => {
  it('first-time activation: billingPeriod=lifetime, periodEnd=2099-12-31 sentinel, cancelAtPeriodEnd=false', async () => {
    const outcome = await applyProLifetimePayment(prisma, USER_ID, makeLifetimePayment());

    if (outcome.kind !== 'pro_lifetime_activated') throw new Error(`expected pro_lifetime_activated, got ${outcome.kind}`);
    expect(outcome.replacedPrior).toBeNull();
    expect(outcome.hadActivePriorSub).toBe(false);

    const arg = dbMocks.subscriptionUpsert.mock.calls[0]![0];
    expect(arg.create).toMatchObject({
      billingPeriod: LIFETIME_BILLING_PERIOD,
      cancelAtPeriodEnd: false,
      status: 'ACTIVE',
    });
    expect((arg.create.currentPeriodEnd as Date).toISOString()).toBe(PRO_LIFETIME_PERIOD_END_ISO);
  });

  it('upgrade from active monthly: replacedPrior=monthly, hadActivePriorSub=true', async () => {
    dbMocks.subscriptionFindUnique.mockResolvedValue({
      id: 'sub_monthly',
      billingPeriod: 'monthly',
      status: 'ACTIVE',
      currentPeriodEnd: new Date(Date.now() + 86_400_000),
    });
    const outcome = await applyProLifetimePayment(prisma, USER_ID, makeLifetimePayment());
    if (outcome.kind !== 'pro_lifetime_activated') throw new Error(`expected pro_lifetime_activated, got ${outcome.kind}`);
    expect(outcome.replacedPrior).toBe('monthly');
    expect(outcome.hadActivePriorSub).toBe(true);
  });

  it('PaymentEvent eventType is payment_success_lifetime', async () => {
    await applyProLifetimePayment(prisma, USER_ID, makeLifetimePayment());
    expect(dbMocks.paymentEventCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'payment_success_lifetime' }),
      }),
    );
  });

  // Defensive case: the apps/api billing checkout endpoint blocks
  // "lifetime on lifetime", so this branch is unreachable in normal flow.
  // We still want the processor to behave gracefully if it ever fires
  // (e.g. via a stale Mini App invoice link). Behavior: status stays
  // ACTIVE, billingPeriod stays 'lifetime', currentPeriodEnd stays at the
  // 2099 sentinel; only starsPrice + telegramChargeId refresh, and a
  // second payment_success_lifetime PaymentEvent is added for audit.
  it('lifetime-on-lifetime (fresh chargeId): upsert is a no-op on the lifetime fields, audit added', async () => {
    dbMocks.subscriptionFindUnique.mockResolvedValue({
      id: 'sub_lifetime',
      billingPeriod: LIFETIME_BILLING_PERIOD,
      status: 'ACTIVE',
      currentPeriodEnd: new Date(PRO_LIFETIME_PERIOD_END_ISO),
    });
    const outcome = await applyProLifetimePayment(prisma, USER_ID, makeLifetimePayment());
    if (outcome.kind !== 'pro_lifetime_activated') throw new Error(`expected pro_lifetime_activated, got ${outcome.kind}`);
    expect(outcome.replacedPrior).toBe(LIFETIME_BILLING_PERIOD);
    expect(outcome.hadActivePriorSub).toBe(true);

    const arg = dbMocks.subscriptionUpsert.mock.calls[0]![0];
    expect(arg.update).toMatchObject({
      status: 'ACTIVE',
      billingPeriod: LIFETIME_BILLING_PERIOD,
      cancelAtPeriodEnd: false,
    });
    // The sentinel date stays the same — no defensive clock-skew window opens up.
    expect((arg.update.currentPeriodEnd as Date).toISOString()).toBe(PRO_LIFETIME_PERIOD_END_ISO);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Subscription row contract — what's written matches what the resolver
//    (apps/api/src/services/entitlement.ts:getUserEntitlement) reads.
//    Catches drift between writer (bot) and reader (api).
// ─────────────────────────────────────────────────────────────────────────
describe('Subscription row contract — writer/reader parity', () => {
  it('monthly write sets the fields entitlement resolver filters on (planCode, status, currentPeriodEnd)', async () => {
    await applyProMonthlyPayment(prisma, USER_ID, makeMonthlyPayment());
    const created = dbMocks.subscriptionUpsert.mock.calls[0]![0].create;
    expect(created.planCode).toBe('PRO');
    expect(created.status).toBe('ACTIVE');
    expect(created.currentPeriodEnd).toBeInstanceOf(Date);
  });

  it('lifetime write sets billingPeriod=lifetime — the resolver SSOT for lifetime', async () => {
    await applyProLifetimePayment(prisma, USER_ID, makeLifetimePayment());
    const created = dbMocks.subscriptionUpsert.mock.calls[0]![0].create;
    expect(created.billingPeriod).toBe(LIFETIME_BILLING_PERIOD);
  });
});
