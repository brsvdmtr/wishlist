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
  applySafeFixes,
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

// Fake Prisma: findMany returns fixtures and count returns their length;
// $transaction runs its callback against the same read-only client. ANY
// model-level mutation (update/create/delete) OR any other top-level client
// call ($queryRaw/$executeRaw/…) throws — which is how we PROVE detection is
// read-only (self-check: "dry-run doesn't change data"). Read-only against a
// REAL client is additionally proven by the row-content snapshot in the
// integration suite.
function makeFakePrisma(rows: { events?: unknown[]; subs?: unknown[]; purchases?: unknown[] }) {
  const readOnlyModel = (data: unknown[]) =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'findMany') return async () => data;
          if (prop === 'count') return async () => data.length;
          throw new Error(`reconcileBilling must be read-only — called .${String(prop)}()`);
        },
      },
    );
  const client = {
    paymentEvent: readOnlyModel(rows.events ?? []),
    subscription: readOnlyModel(rows.subs ?? []),
    purchase: readOnlyModel(rows.purchases ?? []),
  };
  return new Proxy(client, {
    get(target, prop) {
      if (prop in target) return (target as Record<string, unknown>)[prop as string];
      // Read-only interactive transaction: run the callback with the same
      // read-only client (mutations inside still hit the per-model traps).
      if (prop === '$transaction') {
        return async (fn: (tx: unknown) => unknown) => fn(client);
      }
      if (typeof prop === 'string' && prop.startsWith('$')) {
        throw new Error(`reconcileBilling must be read-only — called prisma.${prop}()`);
      }
      return undefined;
    },
  }) as unknown as PrismaClient;
}

const KNOWN_SKUS = new Set(['extra_wishlist_slot', 'hints_pack_5']);
const run = (rows: Parameters<typeof makeFakePrisma>[0]) =>
  reconcileBilling(makeFakePrisma(rows), { now: T0, knownSkuCodes: KNOWN_SKUS });

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
    // Real reminder eventTypes written by schedulers/pro-renewal.ts.
    expect(classifyPaymentEvent('reminder_sent_7d')).toBe('non_payment');
    expect(classifyPaymentEvent('reminder_sent_1d')).toBe('non_payment');
    expect(classifyPaymentEvent('totally_unknown')).toBe('non_payment');
  });
  it('classifies the legacy GIFT_CALENDAR flow (gc_payment_received is a real payment)', () => {
    expect(classifyPaymentEvent('gc_payment_received')).toBe('subscription_payment');
    expect(classifyPaymentEvent('gc_invoice_created')).toBe('non_payment');
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

  it('flags an add-on charge whose PaymentEvent.userId differs from its Purchase owner', async () => {
    const cid = 'cid_addon_mismatch';
    const report = await run({
      events: [event({ eventType: 'addon_payment_success', userId: 'u_attacker', telegramPaymentChargeId: cid })],
      purchases: [purchase({ userId: 'u_owner', telegramChargeId: cid })],
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

  it('finds a providerPaymentChargeId shared across DIFFERENT users (cross-user double-record)', async () => {
    const report = await run({
      events: [
        event({ subscriptionId: 'sU1', userId: 'u1', providerPaymentChargeId: 'dup_x' }),
        event({ subscriptionId: 'sU2', userId: 'u2', providerPaymentChargeId: 'dup_x' }),
      ],
      subs: [sub({ id: 'sU1', userId: 'u1' }), sub({ id: 'sU2', userId: 'u2' })],
    });
    expect(report.findings.filter((x) => x.kind === 'duplicate_provider_charge_id')).toHaveLength(2);
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

  it('flags a purchase stuck in a non-terminal status', async () => {
    const report = await run({ purchases: [purchase({ status: 'pending' })] });
    expect(kindsOf(report.findings)).toContain('non_completed_purchase');
  });

  it('does NOT flag a legitimately-terminal refunded/cancelled purchase', async () => {
    const refunded = await run({ purchases: [purchase({ status: 'refunded' })] });
    expect(kindsOf(refunded.findings)).not.toContain('non_completed_purchase');
    const cancelled = await run({ purchases: [purchase({ status: 'cancelled' })] });
    expect(kindsOf(cancelled.findings)).not.toContain('non_completed_purchase');
  });

  it('an unknown-SKU purchase that is ALSO non-terminal yields exactly one finding (unknown_sku)', async () => {
    const report = await run({ purchases: [purchase({ skuCode: 'mystery', status: 'pending' })] });
    expect(kindsOf(report.findings)).toContain('unknown_sku_purchase');
    expect(kindsOf(report.findings)).not.toContain('non_completed_purchase');
    expect(report.findings).toHaveLength(1); // not double-counted
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
      purchases: [purchase({ status: 'pending' })],
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

// ─── false-positive guards & edge cases (regressions from review round 1) ────
describe('reconcileBilling — no false positives on legitimate renewals', () => {
  it('a single sub with many distinct-charge renewal events is completely clean', async () => {
    // Refutes the review concern that renewals (N events on 1 sub) trip
    // duplicate_provider / duplicate_subscription / missing-payment.
    const report = await run({
      events: [
        event({ subscriptionId: 's_ren', userId: 'u_ren', telegramPaymentChargeId: 'c1', providerPaymentChargeId: 'p1', eventType: 'payment_success' }),
        event({ subscriptionId: 's_ren', userId: 'u_ren', telegramPaymentChargeId: 'c2', providerPaymentChargeId: 'p2', eventType: 'payment_success' }),
        event({ subscriptionId: 's_ren', userId: 'u_ren', telegramPaymentChargeId: 'c3', providerPaymentChargeId: 'p3', eventType: 'payment_success_yearly' }),
      ],
      subs: [sub({ id: 's_ren', userId: 'u_ren', telegramChargeId: 'c3' })],
    });
    expect(report.ok).toBe(true);
  });
});

describe('reconcileBilling — bucket 2 precision (orphaned link vs genuinely unpaid)', () => {
  it('does NOT also cry "no payment trail" when the sub has a charge-id-matching but unlinked payment', async () => {
    const report = await run({
      events: [event({ userId: 'u_b', telegramPaymentChargeId: 'cB', subscriptionId: null, eventType: 'payment_success' })],
      subs: [sub({ id: 's_b', userId: 'u_b', telegramChargeId: 'cB' })],
    });
    expect(kindsOf(report.findings)).toContain('payment_event_without_subscription'); // the broken link
    expect(kindsOf(report.findings)).not.toContain('subscription_without_payment_event'); // payment DOES exist for this sub
  });

  it('STILL flags a genuinely unpaid stars sub even when an UNRELATED orphan payment exists for the same user', async () => {
    // The old per-user heuristic masked this; the per-sub charge-id match fixes it.
    const report = await run({
      events: [event({ userId: 'u_c', telegramPaymentChargeId: 'c_other', subscriptionId: null, eventType: 'payment_success' })],
      subs: [sub({ id: 's_c', userId: 'u_c', telegramChargeId: 'c_mine', source: 'telegram_stars' })],
    });
    expect(report.findings.some((f) => f.kind === 'subscription_without_payment_event' && f.subscriptionId === 's_c')).toBe(true);
  });

  it('STILL flags an unpaid stars sub whose only LINKED event is a reminder marker (not a payment)', async () => {
    // reminder_sent_* events carry subscriptionId (schedulers/pro-renewal.ts) —
    // they must NOT be mistaken for a payment trail.
    const report = await run({
      events: [event({ userId: 'u_r', subscriptionId: 's_r', eventType: 'reminder_sent_7d', telegramPaymentChargeId: 'reminder-id' })],
      subs: [sub({ id: 's_r', userId: 'u_r', telegramChargeId: 'c_paid', source: 'telegram_stars' })],
    });
    expect(report.findings.some((f) => f.kind === 'subscription_without_payment_event' && f.subscriptionId === 's_r')).toBe(true);
  });

  it('does NOT flag a paid GIFT_CALENDAR sub whose only payment is the legacy gc_payment_received event', async () => {
    // Regression (2026-05-30): gc_payment_received (legacy GIFT_CALENDAR Stars
    // flow) is a REAL subscription payment. A code-grep-built taxonomy missed
    // it, so a paid GIFT_CALENDAR sub false-positived as "no payment trail" —
    // caught only by running against prod data.
    const report = await run({
      events: [event({ userId: 'u_gc', subscriptionId: 's_gc', eventType: 'gc_payment_received', telegramPaymentChargeId: 'stx_gc' })],
      subs: [sub({ id: 's_gc', userId: 'u_gc', planCode: 'GIFT_CALENDAR', source: 'telegram_stars', telegramChargeId: 'stx_gc' })],
    });
    expect(kindsOf(report.findings)).not.toContain('subscription_without_payment_event');
  });
});

describe('reconcileBilling — duplicate_provider_charge_id falsy-skip contract', () => {
  it('does not flag events that merely share an empty-string or null providerPaymentChargeId', async () => {
    const report = await run({
      events: [
        event({ subscriptionId: 's1', providerPaymentChargeId: '' }),
        event({ subscriptionId: 's1', providerPaymentChargeId: '' }),
        event({ subscriptionId: 's1', providerPaymentChargeId: null }),
      ],
      subs: [sub({ id: 's1' })],
    });
    expect(kindsOf(report.findings)).not.toContain('duplicate_provider_charge_id');
  });
});

describe('reconcileBilling — scan ceiling', () => {
  it('throws when total rows exceed maxScanRows (protects the in-process admin endpoint)', async () => {
    await expect(
      reconcileBilling(makeFakePrisma({ events: [event(), event()] }), { now: T0, knownSkuCodes: KNOWN_SKUS, maxScanRows: 1 }),
    ).rejects.toThrow(/exceed the in-memory ceiling/);
  });
});

// applySafeFixes branch coverage with a tiny purpose-built fake (the integration
// suite covers the real-DB happy path + idempotency; these lock the branches a
// single-threaded DB test can't easily force — notably the count===0 race skip).
describe('applySafeFixes — branch coverage', () => {
  it('relinks when the guarded updateMany reports count 1', async () => {
    const fake = {
      paymentEvent: {
        findMany: async () => [{ id: 'pe_ok', userId: 'u', telegramPaymentChargeId: 'cR' }],
        updateMany: async () => ({ count: 1 }),
      },
      subscription: { findFirst: async () => ({ id: 'sub_match' }) },
    } as unknown as PrismaClient;
    const res = await applySafeFixes(fake);
    expect(res.relinkedPaymentEvents).toEqual([{ paymentEventId: 'pe_ok', subscriptionId: 'sub_match' }]);
    expect(res.skipped).toEqual([]);
  });

  it('skips with a "raced" reason when the guarded updateMany matches 0 rows', async () => {
    // Simulates a concurrent writer linking the orphan between our read and the
    // guarded write: findFirst matches, but updateMany (where subscriptionId
    // null) reports count 0 → must skip, never double-link.
    const fake = {
      paymentEvent: {
        findMany: async () => [{ id: 'pe_race', userId: 'u', telegramPaymentChargeId: 'cR' }],
        updateMany: async () => ({ count: 0 }),
      },
      subscription: { findFirst: async () => ({ id: 'sub_match' }) },
    } as unknown as PrismaClient;
    const res = await applySafeFixes(fake);
    expect(res.relinkedPaymentEvents).toEqual([]);
    expect(res.skipped).toContainEqual({ paymentEventId: 'pe_race', reason: 'raced: linked by another writer before update' });
  });

  it('skips with "no matching charge id" when no PRO sub charge id matches', async () => {
    const fake = {
      paymentEvent: { findMany: async () => [{ id: 'pe_nomatch', userId: 'u', telegramPaymentChargeId: 'cX' }] },
      subscription: { findFirst: async () => null },
    } as unknown as PrismaClient;
    const res = await applySafeFixes(fake);
    expect(res.relinkedPaymentEvents).toEqual([]);
    expect(res.skipped).toContainEqual({ paymentEventId: 'pe_nomatch', reason: 'no PRO subscription with a matching charge id' });
  });
});
