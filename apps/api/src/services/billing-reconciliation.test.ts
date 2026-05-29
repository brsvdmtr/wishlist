// Unit tests for the billing reconciler's detection logic. reconcileBilling()
// only READS three tables (findMany) and computes in memory, so a fake Prisma
// returning fixture rows exercises the exact production code path — the bug
// class (wrong classification, missed orphan, false positive) is caught
// identically to a real DB. The mutating applySafeFixes() and schema-shape
// coverage live in test/integration/billing-reconciliation.test.ts.

import { describe, it, expect } from 'vitest';
import type { PrismaClient } from '@wishlist/db';
import {
  reconcileBilling,
  classifyPaymentEvent,
  hashChargeId,
  FINDING_SEVERITY,
  type ReconciliationFindingKind,
} from './billing-reconciliation';

// ─── fixtures ────────────────────────────────────────────────────────────────
const T0 = new Date('2026-05-29T12:00:00.000Z');
let n = 0;
const id = (p: string) => `${p}_${++n}`;

function event(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: id('pe'),
    subscriptionId: null,
    userId: id('u'),
    telegramPaymentChargeId: id('tcid'),
    providerPaymentChargeId: null,
    totalAmount: 100,
    currency: 'XTR',
    eventType: 'payment_success',
    createdAt: T0,
    ...over,
  };
}
function sub(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: id('sub'),
    userId: id('u'),
    planCode: 'PRO',
    status: 'ACTIVE',
    starsPrice: 100,
    telegramChargeId: null,
    currentPeriodEnd: new Date('2026-12-31T00:00:00.000Z'),
    source: 'telegram_stars',
    billingPeriod: 'monthly',
    createdAt: T0,
    ...over,
  };
}
function purchase(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: id('pur'),
    userId: id('u'),
    skuCode: 'extra_wishlist_slot',
    starsPrice: 39,
    telegramChargeId: id('tcid'),
    status: 'completed',
    createdAt: T0,
    ...over,
  };
}

// Fake Prisma: findMany returns fixtures; ANY other access throws, which is how
// we PROVE detection is read-only (self-check: "dry-run doesn't change data").
function fakereconcileBilling(rows: {
  events?: unknown[];
  subs?: unknown[];
  purchases?: unknown[];
}) {
  const mutationTrap = (model: string) =>
    new Proxy(
      { findMany: async () => [] as unknown[] },
      {
        get(target, prop) {
          if (prop === 'findMany') {
            if (model === 'paymentEvent') return async () => rows.events ?? [];
            if (model === 'subscription') return async () => rows.subs ?? [];
            if (model === 'purchase') return async () => rows.purchases ?? [];
            return async () => [];
          }
          throw new Error(`reconcileBilling must be read-only — called ${model}.${String(prop)}()`);
        },
      },
    );
  return {
    paymentEvent: mutationTrap('paymentEvent'),
    subscription: mutationTrap('subscription'),
    purchase: mutationTrap('purchase'),
  } as unknown as PrismaClient;
}

const KNOWN_SKUS = new Set(['extra_wishlist_slot', 'hints_pack_5']);
const run = (rows: Parameters<typeof fakereconcileBilling>[0]) =>
  reconcileBilling(fakereconcileBilling(rows), { now: T0, knownSkuCodes: KNOWN_SKUS });

const kindsOf = (findings: { kind: ReconciliationFindingKind }[]) => findings.map((f) => f.kind);

// ─── classifier ──────────────────────────────────────────────────────────────
describe('classifyPaymentEvent', () => {
  it('classifies the three subscription-payment eventTypes', () => {
    expect(classifyPaymentEvent('payment_success')).toBe('subscription_payment');
    expect(classifyPaymentEvent('payment_success_yearly')).toBe('subscription_payment');
    expect(classifyPaymentEvent('payment_success_lifetime')).toBe('subscription_payment');
  });
  it('classifies add-on, lifetime-guard, and non-payment markers', () => {
    expect(classifyPaymentEvent('addon_payment_success')).toBe('addon_payment');
    expect(classifyPaymentEvent('payment_success_post_lifetime')).toBe('lifetime_guard');
    expect(classifyPaymentEvent('invoice_created')).toBe('non_payment');
    expect(classifyPaymentEvent('addon_invoice_created')).toBe('non_payment');
    expect(classifyPaymentEvent('gift_notes_invoice_created')).toBe('non_payment');
    expect(classifyPaymentEvent('reminder_sent_T7')).toBe('non_payment');
    expect(classifyPaymentEvent('totally_unknown')).toBe('non_payment');
  });
});

describe('hashChargeId', () => {
  it('is deterministic, fixed-length hex, and never echoes the raw id', () => {
    const raw = 'stars_charge_abc123';
    const h = hashChargeId(raw);
    expect(h).toBe(hashChargeId(raw));
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).not.toContain(raw);
    expect(hashChargeId('other')).not.toBe(h);
  });
});

// ─── clean baseline (no false positives) ─────────────────────────────────────
describe('reconcileBilling — consistent ledger', () => {
  it('reports zero findings when every row is well-formed', async () => {
    const s = sub({ id: 'sub_clean', userId: 'u_clean', telegramChargeId: 'c1' });
    const cid = 'c_addon_clean';
    const report = await run({
      events: [
        event({ subscriptionId: 'sub_clean', userId: 'u_clean', telegramPaymentChargeId: 'c1', providerPaymentChargeId: 'p1' }),
        // a non-payment checkout stub — must NOT be flagged as an orphan
        event({ userId: 'u_clean', eventType: 'invoice_created', telegramPaymentChargeId: 'checkout_x', subscriptionId: null }),
        // a real add-on payment with its matching Purchase
        event({ userId: 'u_addon', eventType: 'addon_payment_success', telegramPaymentChargeId: cid, providerPaymentChargeId: 'p2' }),
      ],
      subs: [s],
      purchases: [purchase({ userId: 'u_addon', telegramChargeId: cid })],
    });
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.scanned).toEqual({ paymentEvents: 3, subscriptions: 1, purchases: 1 });
  });

  it('does NOT flag free-grant subscriptions (referral/survey/winback) for missing payment', async () => {
    const report = await run({
      subs: [
        sub({ source: 'referral_reward', starsPrice: 0, telegramChargeId: null }),
        sub({ source: 'survey_reward:pmf', starsPrice: 0, telegramChargeId: null }),
        sub({ source: 'winback', starsPrice: 0, telegramChargeId: null }),
      ],
    });
    expect(report.ok).toBe(true);
  });
});

// ─── bucket 1: PaymentEvent without Subscription / Purchase ──────────────────
describe('reconcileBilling — bucket 1 (orphan payments)', () => {
  it('finds a subscription-payment PaymentEvent with no subscription link (self-check #2)', async () => {
    const report = await run({
      events: [event({ eventType: 'payment_success', subscriptionId: null, telegramPaymentChargeId: 'raw_orphan' })],
    });
    const f = report.findings.find((x) => x.kind === 'payment_event_without_subscription');
    expect(f).toBeTruthy();
    expect(f!.severity).toBe('high');
    // PII guard at the finding level: the raw charge id must not leak.
    expect(JSON.stringify(f)).not.toContain('raw_orphan');
    expect(f!.chargeIdHash).toBe(hashChargeId('raw_orphan'));
  });

  it('finds a dangling subscriptionId (sub row gone)', async () => {
    const report = await run({
      events: [event({ eventType: 'payment_success_yearly', subscriptionId: 'sub_missing' })],
      subs: [],
    });
    expect(kindsOf(report.findings)).toContain('payment_event_without_subscription');
  });

  it('finds an add-on PaymentEvent with no matching Purchase', async () => {
    const report = await run({
      events: [event({ eventType: 'addon_payment_success', telegramPaymentChargeId: 'addon_no_purchase' })],
      purchases: [],
    });
    expect(kindsOf(report.findings)).toContain('payment_event_without_purchase');
  });

  it('flags a charge whose PaymentEvent.userId differs from the linked Subscription owner', async () => {
    const report = await run({
      events: [event({ eventType: 'payment_success', subscriptionId: 'sub_a', userId: 'u_attacker' })],
      subs: [sub({ id: 'sub_a', userId: 'u_owner' })],
    });
    expect(kindsOf(report.findings)).toContain('charge_id_user_mismatch');
  });
});

// ─── bucket 2: Subscription without PaymentEvent ─────────────────────────────
describe('reconcileBilling — bucket 2 (paid sub, no payment trail)', () => {
  it('finds a telegram_stars subscription with zero PaymentEvents', async () => {
    const report = await run({ subs: [sub({ id: 'sub_paid', userId: 'u_paid', source: 'telegram_stars' })] });
    const f = report.findings.find((x) => x.kind === 'subscription_without_payment_event');
    expect(f).toBeTruthy();
    expect(f!.severity).toBe('high');
  });
});

// ─── bucket 3: duplicate charge ids ──────────────────────────────────────────
describe('reconcileBilling — bucket 3 (duplicate charge ids, self-check #3)', () => {
  it('finds a providerPaymentChargeId shared across two PaymentEvents', async () => {
    const report = await run({
      events: [
        event({ subscriptionId: 'sX', providerPaymentChargeId: 'dup_provider' }),
        event({ subscriptionId: 'sX', providerPaymentChargeId: 'dup_provider' }),
      ],
      subs: [sub({ id: 'sX' })],
    });
    const dups = report.findings.filter((x) => x.kind === 'duplicate_provider_charge_id');
    expect(dups).toHaveLength(2);
  });

  it('finds a Subscription.telegramChargeId shared across two subscriptions', async () => {
    const report = await run({
      subs: [
        sub({ id: 's1', userId: 'uA', source: 'referral_reward', starsPrice: 0, telegramChargeId: 'dup_sub_cid' }),
        sub({ id: 's2', userId: 'uB', source: 'referral_reward', starsPrice: 0, telegramChargeId: 'dup_sub_cid' }),
      ],
    });
    expect(report.findings.filter((x) => x.kind === 'duplicate_subscription_charge_id')).toHaveLength(2);
  });
});

// ─── bucket 4: failed / partial ──────────────────────────────────────────────
describe('reconcileBilling — bucket 4 (failed / partial)', () => {
  it('flags a lifetime-guard charge (money taken post-lifetime, no new value)', async () => {
    const report = await run({
      events: [event({ eventType: 'payment_success_post_lifetime', subscriptionId: 'sL', userId: 'uL' })],
      subs: [sub({ id: 'sL', userId: 'uL', billingPeriod: 'lifetime', currentPeriodEnd: new Date('2099-12-31T00:00:00.000Z') })],
    });
    expect(kindsOf(report.findings)).toContain('lifetime_guard_charge');
  });

  it('flags a purchase for an unknown SKU', async () => {
    const report = await run({ purchases: [purchase({ skuCode: 'mystery_sku' })] });
    expect(kindsOf(report.findings)).toContain('unknown_sku_purchase');
  });

  it('flags a non-completed purchase', async () => {
    const report = await run({ purchases: [purchase({ status: 'pending' })] });
    expect(kindsOf(report.findings)).toContain('non_completed_purchase');
  });

  it('flags an ACTIVE subscription whose period already ended (expiry-sweep gap)', async () => {
    const report = await run({
      subs: [sub({ source: 'referral_reward', starsPrice: 0, status: 'ACTIVE', billingPeriod: 'monthly', currentPeriodEnd: new Date('2026-05-01T00:00:00.000Z') })],
    });
    expect(kindsOf(report.findings)).toContain('stale_active_subscription');
  });

  it('does NOT flag a lifetime subscription as stale even if currentPeriodEnd is in the past', async () => {
    const report = await run({
      subs: [sub({ source: 'referral_reward', starsPrice: 0, billingPeriod: 'lifetime', currentPeriodEnd: new Date('2026-05-01T00:00:00.000Z') })],
    });
    expect(kindsOf(report.findings)).not.toContain('stale_active_subscription');
  });
});

// ─── report shape, severity tally, and the PII contract (self-check #4) ──────
describe('reconcileBilling — report shape & PII contract', () => {
  it('tallies counts and severities consistently', async () => {
    const report = await run({
      events: [event({ eventType: 'payment_success', subscriptionId: null })],
      purchases: [purchase({ status: 'refunded' })],
    });
    const total = Object.values(report.counts).reduce((a, b) => a + b, 0);
    expect(total).toBe(report.findings.length);
    const sev = report.bySeverity.high + report.bySeverity.medium + report.bySeverity.low;
    expect(sev).toBe(report.findings.length);
    report.findings.forEach((f) => expect(f.severity).toBe(FINDING_SEVERITY[f.kind]));
  });

  it('serialised report leaks no raw charge ids, invoice payloads, emails, or telegram ids', async () => {
    const report = await run({
      events: [
        event({ eventType: 'payment_success', subscriptionId: null, telegramPaymentChargeId: 'RAW_TG_CHARGE', providerPaymentChargeId: 'RAW_PROVIDER' }),
        event({ eventType: 'addon_payment_success', telegramPaymentChargeId: 'RAW_ADDON_CHARGE' }),
      ],
      purchases: [purchase({ skuCode: 'mystery', telegramChargeId: 'RAW_PURCHASE_CHARGE' })],
    });
    const json = JSON.stringify(report);
    expect(json).not.toContain('RAW_TG_CHARGE');
    expect(json).not.toContain('RAW_PROVIDER');
    expect(json).not.toContain('RAW_ADDON_CHARGE');
    expect(json).not.toContain('RAW_PURCHASE_CHARGE');
    expect(json).not.toContain('invoicePayload');
    expect(json).not.toContain('rawPayload');
    expect(json).not.toMatch(/"email"|"telegramId"/);
  });
});
