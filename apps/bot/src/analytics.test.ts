// Unit tests for emitPaymentAnalytics — the bot's Telegram-Stars analytics
// fan-out. Covers the payment.completed, pro.activated, subscription.renewed,
// and referral.invitee_converted_to_paid branches (per the spec in the
// 2026-05-19 P0 analytics implementation).
//
// We swap the two emit seams via __setEmitters so we never touch prisma
// during these tests — both emitters are vi.fn() spies and we assert on the
// exact (event, userId, props) shape that downstream funnels rely on.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const dbMocks = vi.hoisted(() => ({
  userProfileFindUnique: vi.fn(),
  paymentEventCount: vi.fn(),
  analyticsEventCreate: vi.fn(),
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    analyticsEvent: { create: dbMocks.analyticsEventCreate },
    userProfile: { findUnique: dbMocks.userProfileFindUnique },
    paymentEvent: { count: dbMocks.paymentEventCount },
  },
}));

import { emitPaymentAnalytics, trackProductEvent, productionRawEmit, __setEmitters, __resetEmitters } from './analytics';

let productEmit: ReturnType<typeof vi.fn>;
let rawEmit: ReturnType<typeof vi.fn>;

beforeEach(() => {
  productEmit = vi.fn();
  rawEmit = vi.fn();
  __setEmitters({ product: productEmit, raw: rawEmit });
  dbMocks.userProfileFindUnique.mockReset();
  dbMocks.paymentEventCount.mockReset();
  dbMocks.analyticsEventCreate.mockReset();
  dbMocks.analyticsEventCreate.mockResolvedValue({});
  // Default: user has no referrer + no prior paid events. Individual tests
  // override.
  dbMocks.userProfileFindUnique.mockResolvedValue({ referredByUserId: null });
  dbMocks.paymentEventCount.mockResolvedValue(0);
});

afterEach(() => {
  __resetEmitters();
});

const basePayload = {
  telegram_payment_charge_id: 'charge_abc',
  invoice_payload: 'pro_monthly:123:session',
  total_amount: 299,
  currency: 'XTR',
};

describe('emitPaymentAnalytics — monthly PRO', () => {
  it('first-ever activation: emits payment.completed + pro.activated', async () => {
    await emitPaymentAnalytics({
      userId: 'u1',
      payload: basePayload,
      planCode: 'PRO',
      billingPeriod: 'monthly',
      hadActivePriorSub: false,
    });

    const events = productEmit.mock.calls.map((c) => c[0]);
    expect(events.map((e) => e.event).sort()).toEqual(['payment.completed', 'pro.activated']);

    const payment = events.find((e) => e.event === 'payment.completed')!;
    expect(payment.userId).toBe('u1');
    expect(payment.props).toMatchObject({
      planCode: 'PRO',
      billingPeriod: 'monthly',
      amountStars: 299,
      currency: 'XTR',
      chargeId: 'charge_abc',
      source: 'telegram_stars',
    });
    // Privacy: never write item title / description / Telegram raw identifiers.
    expect(payment.props).not.toHaveProperty('title');
    expect(payment.props).not.toHaveProperty('description');
    expect(payment.props).not.toHaveProperty('firstName');
    expect(payment.props).not.toHaveProperty('username');
    expect(payment.props).not.toHaveProperty('telegramId');

    const pro = events.find((e) => e.event === 'pro.activated')!;
    expect(pro.userId).toBe('u1');
    expect(pro.props).toMatchObject({ planCode: 'PRO', billingPeriod: 'monthly' });
  });

  it('renewal (had active prior sub): emits payment.completed + subscription.renewed (no pro.activated)', async () => {
    await emitPaymentAnalytics({
      userId: 'u1',
      payload: basePayload,
      planCode: 'PRO',
      billingPeriod: 'monthly',
      hadActivePriorSub: true,
    });

    const events = productEmit.mock.calls.map((c) => c[0]);
    expect(events.map((e) => e.event).sort()).toEqual(['payment.completed', 'subscription.renewed']);
    expect(events.find((e) => e.event === 'pro.activated')).toBeUndefined();

    const renewed = events.find((e) => e.event === 'subscription.renewed')!;
    expect(renewed.userId).toBe('u1');
    expect(renewed.props).toMatchObject({ planCode: 'PRO', billingPeriod: 'monthly' });
  });
});

describe('emitPaymentAnalytics — yearly + lifetime PRO', () => {
  it('yearly activation: emits payment.completed + pro.activated with billingPeriod=yearly', async () => {
    await emitPaymentAnalytics({
      userId: 'u1',
      payload: basePayload,
      planCode: 'PRO',
      billingPeriod: 'yearly',
      hadActivePriorSub: false,
    });

    const pro = productEmit.mock.calls.map((c) => c[0]).find((e) => e.event === 'pro.activated');
    expect(pro?.props).toMatchObject({ billingPeriod: 'yearly' });
  });

  it('lifetime activation: emits payment.completed + pro.activated with billingPeriod=lifetime', async () => {
    await emitPaymentAnalytics({
      userId: 'u1',
      payload: basePayload,
      planCode: 'PRO',
      billingPeriod: 'lifetime',
      hadActivePriorSub: false,
    });

    const events = productEmit.mock.calls.map((c) => c[0]);
    const pro = events.find((e) => e.event === 'pro.activated');
    expect(pro?.props).toMatchObject({ billingPeriod: 'lifetime' });
  });
});

describe('emitPaymentAnalytics — addon', () => {
  it('emits only payment.completed (no pro.activated, no subscription.renewed)', async () => {
    await emitPaymentAnalytics({
      userId: 'u1',
      payload: basePayload,
      planCode: null,
      billingPeriod: 'addon',
      hadActivePriorSub: false,
      skuCode: 'extra_wishlist_slot',
    });

    const events = productEmit.mock.calls.map((c) => c[0]);
    expect(events.map((e) => e.event)).toEqual(['payment.completed']);
    expect(events[0].props).toMatchObject({
      skuCode: 'extra_wishlist_slot',
      billingPeriod: 'addon',
    });
    expect(events[0].props).not.toHaveProperty('planCode');
  });

  it('does not query referral attribution for addon purchases', async () => {
    await emitPaymentAnalytics({
      userId: 'u1',
      payload: basePayload,
      planCode: null,
      billingPeriod: 'addon',
      hadActivePriorSub: false,
      skuCode: 'hints_pack_5',
    });

    expect(dbMocks.userProfileFindUnique).not.toHaveBeenCalled();
    expect(dbMocks.paymentEventCount).not.toHaveBeenCalled();
    expect(rawEmit).not.toHaveBeenCalled();
  });
});

describe('emitPaymentAnalytics — referral attribution', () => {
  it('emits referral.invitee_converted_to_paid for attributed user on FIRST paid sub', async () => {
    dbMocks.userProfileFindUnique.mockResolvedValue({ referredByUserId: 'inviter_42' });
    dbMocks.paymentEventCount.mockResolvedValue(0);

    await emitPaymentAnalytics({
      userId: 'u1',
      payload: basePayload,
      planCode: 'PRO',
      billingPeriod: 'monthly',
      hadActivePriorSub: false,
    });

    expect(rawEmit).toHaveBeenCalledOnce();
    const call = rawEmit.mock.calls[0]![0];
    expect(call.event).toBe('referral.invitee_converted_to_paid');
    expect(call.userId).toBe('u1');
    expect(call.props).toMatchObject({
      inviterUserId: 'inviter_42',
      planCode: 'PRO',
      billingPeriod: 'monthly',
      amountStars: 299,
      currency: 'XTR',
    });
  });

  it('does NOT emit referral.invitee_converted_to_paid if user has prior paid events', async () => {
    dbMocks.userProfileFindUnique.mockResolvedValue({ referredByUserId: 'inviter_42' });
    dbMocks.paymentEventCount.mockResolvedValue(3);

    await emitPaymentAnalytics({
      userId: 'u1',
      payload: basePayload,
      planCode: 'PRO',
      billingPeriod: 'monthly',
      hadActivePriorSub: false,
    });

    expect(rawEmit).not.toHaveBeenCalled();
  });

  it('does NOT emit referral.invitee_converted_to_paid if user was not referred', async () => {
    dbMocks.userProfileFindUnique.mockResolvedValue({ referredByUserId: null });

    await emitPaymentAnalytics({
      userId: 'u1',
      payload: basePayload,
      planCode: 'PRO',
      billingPeriod: 'monthly',
      hadActivePriorSub: false,
    });

    expect(rawEmit).not.toHaveBeenCalled();
    // Should not even query the payment-event count if the user has no referrer.
    expect(dbMocks.paymentEventCount).not.toHaveBeenCalled();
  });

  it('does NOT emit referral.invitee_converted_to_paid on RENEWAL (hadActivePriorSub=true)', async () => {
    dbMocks.userProfileFindUnique.mockResolvedValue({ referredByUserId: 'inviter_42' });
    dbMocks.paymentEventCount.mockResolvedValue(0);

    await emitPaymentAnalytics({
      userId: 'u1',
      payload: basePayload,
      planCode: 'PRO',
      billingPeriod: 'monthly',
      hadActivePriorSub: true,
    });

    // Renewal path skips the activation/referral branch entirely.
    expect(rawEmit).not.toHaveBeenCalled();
    expect(dbMocks.userProfileFindUnique).not.toHaveBeenCalled();
  });

  it('swallows referral attribution errors without breaking the main payment emit', async () => {
    dbMocks.userProfileFindUnique.mockRejectedValue(new Error('db hiccup'));

    await expect(
      emitPaymentAnalytics({
        userId: 'u1',
        payload: basePayload,
        planCode: 'PRO',
        billingPeriod: 'monthly',
        hadActivePriorSub: false,
      }),
    ).resolves.toBeUndefined();

    // payment.completed + pro.activated still emit despite the error.
    const events = productEmit.mock.calls.map((c) => c[0]);
    expect(events.map((e) => e.event).sort()).toEqual(['payment.completed', 'pro.activated']);
  });
});

describe('emitPaymentAnalytics — privacy', () => {
  it('never includes invoice_payload (which could contain session/user identifiers) in props', async () => {
    await emitPaymentAnalytics({
      userId: 'u1',
      payload: {
        telegram_payment_charge_id: 'c',
        invoice_payload: 'pro_monthly:CONFIDENTIAL_TG_ID:SESSION_UUID',
        total_amount: 299,
        currency: 'XTR',
      },
      planCode: 'PRO',
      billingPeriod: 'monthly',
      hadActivePriorSub: false,
    });

    for (const call of productEmit.mock.calls) {
      const props = call[0].props as Record<string, unknown>;
      const serialised = JSON.stringify(props);
      expect(serialised).not.toContain('CONFIDENTIAL_TG_ID');
      expect(serialised).not.toContain('SESSION_UUID');
    }
  });
});

describe('trackProductEvent — PII sanitization on the real prisma path', () => {
  // The emitPaymentAnalytics tests above run through swapped vi.fn() emit
  // seams, so they never exercise the real sanitizeAnalyticsProps wiring.
  // These call the REAL exported trackProductEvent straight through to the
  // mocked prisma.analyticsEvent.create — pinning the bot-side wiring.
  it('drops user-content keys before persisting', () => {
    trackProductEvent({
      event: 'paywall.viewed',
      userId: 'u1',
      props: { plan: 'monthly', title: 'My private wish', note: 'freeform text' },
    });
    expect(dbMocks.analyticsEventCreate).toHaveBeenCalledOnce();
    expect(dbMocks.analyticsEventCreate.mock.calls[0]![0].data.props).toEqual({ plan: 'monthly' });
  });

  it('truncates an over-long string prop', () => {
    trackProductEvent({ event: 'paywall.viewed', userId: 'u1', props: { reason: 'x'.repeat(500) } });
    const props = dbMocks.analyticsEventCreate.mock.calls[0]![0].data.props as Record<string, unknown>;
    expect((props.reason as string).length).toBe(303);
  });

  it('productionRawEmit (the _rawEmit default) strips PII keys before persisting', () => {
    productionRawEmit({
      event: 'referral.invitee_converted_to_paid',
      userId: 'u1',
      props: { inviterUserId: 'inviter_42', planCode: 'PRO', title: 'leak', note: 'leak' },
    });
    expect(dbMocks.analyticsEventCreate).toHaveBeenCalledOnce();
    expect(dbMocks.analyticsEventCreate.mock.calls[0]![0].data.props).toEqual({
      inviterUserId: 'inviter_42',
      planCode: 'PRO',
    });
  });
});

describe('emitPaymentAnalytics — real emit seams reach prisma sanitized', () => {
  it('writes payment.completed / pro.activated / referral.* via the real trackProductEvent + _rawEmit', async () => {
    __resetEmitters(); // undo beforeEach's spy swap — exercise the real emitters
    dbMocks.userProfileFindUnique.mockResolvedValue({ referredByUserId: 'inviter_42' });
    dbMocks.paymentEventCount.mockResolvedValue(0);

    await emitPaymentAnalytics({
      userId: 'u1',
      payload: basePayload,
      planCode: 'PRO',
      billingPeriod: 'monthly',
      hadActivePriorSub: false,
    });

    const events = dbMocks.analyticsEventCreate.mock.calls.map((c) => c[0].data.event);
    expect(events).toContain('payment.completed');
    expect(events).toContain('pro.activated');
    expect(events).toContain('referral.invitee_converted_to_paid');
    // Every persisted row's props must be a plain serializable object.
    for (const call of dbMocks.analyticsEventCreate.mock.calls) {
      expect(() => JSON.stringify(call[0].data.props)).not.toThrow();
    }
  });
});
