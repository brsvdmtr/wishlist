// Billing reconciliation — cross-checks the three money tables against each
// other and surfaces every discrepancy that means "we charged (or granted)
// something but the ledger disagrees with itself".
//
// WHY THIS EXISTS
// ───────────────
// Telegram Stars payments land in TWO independent idempotency ledgers:
//   • Subscription payments → PaymentEvent (unique telegramPaymentChargeId)
//     + Subscription row (telegramChargeId, NOT unique).
//   • One-time add-ons       → Purchase (unique telegramChargeId)
//     + an audit PaymentEvent (eventType 'addon_payment_success').
// Each write path is a single prisma.$transaction (see apps/bot/src/payments.ts),
// so under normal operation the tables stay consistent. This reconciler is the
// safety net for the cases a transaction can't cover: a partial historical
// write, a manual DB edit, a deleted Subscription orphaning its PaymentEvents
// (subscriptionId is onDelete:SetNull), a duplicated provider charge id, or a
// charge that took money but delivered nothing (lifetime guard / unknown SKU).
//
// PaymentEvent is OVERLOADED by eventType. Only some rows are real payments:
//   • Real subscription payments → must link to a Subscription:
//       payment_success | payment_success_yearly | payment_success_lifetime
//   • Real add-on payment        → must have a matching Purchase by charge id:
//       addon_payment_success
//   • Audit, money-taken-no-value → refund candidate, never a "missing link":
//       payment_success_post_lifetime   (the LIFETIME guard)
//   • Non-payment markers         → EXCLUDED from every orphan check:
//       invoice_created | addon_invoice_created | gift_notes_invoice_created
//       (checkout-session stubs with synthetic charge ids written by
//        apps/api billing.routes.ts) and reminder_sent_* (the pro-renewal
//        scheduler reuses PaymentEvent as a reminder-dedup ledger).
//
// SAFETY / PII
// ────────────
// Detection is read-only. The only mutation lives in applySafeFixes() and is
// the single provably-correct repair: relink a subscription-payment
// PaymentEvent to its owner's PRO Subscription when subscriptionId is null and
// the match is unambiguous. Refunds, re-grants, and EXPIRED transitions stay
// manual (see docs/ops/billing-reconciliation.md).
//
// The report carries OPAQUE internal cuids (paymentEventId / subscriptionId /
// purchaseId / userId) so an operator can drill in via the DB, plus a one-way
// hash of the Telegram charge id for cross-finding correlation. It NEVER
// contains a raw telegramPaymentChargeId / providerPaymentChargeId, an
// invoicePayload (which embeds the raw Telegram user id), a rawPayload, an
// email, or a telegramId. The raw payment identifiers live only in the DB.

import crypto from 'node:crypto';
import type { PrismaClient } from '@wishlist/db';
import { ONE_TIME_SKUS } from './entitlement';

// ─── eventType taxonomy (mirrors apps/bot/src/payments.ts write paths) ───────
export const SUBSCRIPTION_PAYMENT_EVENT_TYPES = [
  'payment_success',
  'payment_success_yearly',
  'payment_success_lifetime',
] as const;
export const ADDON_PAYMENT_EVENT_TYPE = 'addon_payment_success';
export const LIFETIME_GUARD_EVENT_TYPE = 'payment_success_post_lifetime';
// Charge ids on these are synthetic checkout/reminder stubs, not real money.
export const NON_PAYMENT_EVENT_TYPES = [
  'invoice_created',
  'addon_invoice_created',
  'gift_notes_invoice_created',
] as const;
const REMINDER_EVENT_PREFIX = 'reminder_sent_';

// Subscriptions from these sources are paid via Stars and MUST have a
// PaymentEvent. Every other source (referral_reward, survey_reward:*, winback,
// manual, …) is a free grant with starsPrice 0 and legitimately has none.
export const PAID_SUBSCRIPTION_SOURCE = 'telegram_stars';
const LIFETIME_BILLING_PERIOD = 'lifetime';
// Purchase statuses that are legitimately terminal (not "stuck"). Today the bot
// only ever writes 'completed'; refunded/cancelled are reserved so a future
// refund flow doesn't turn every refund into a non_completed_purchase finding.
const PURCHASE_TERMINAL_STATUSES = new Set(['completed', 'refunded', 'cancelled']);

export type PaymentEventClass =
  | 'subscription_payment'
  | 'addon_payment'
  | 'lifetime_guard'
  | 'non_payment';

/** Pure classifier — the single source of truth for "is this row real money". */
export function classifyPaymentEvent(eventType: string): PaymentEventClass {
  if ((SUBSCRIPTION_PAYMENT_EVENT_TYPES as readonly string[]).includes(eventType)) {
    return 'subscription_payment';
  }
  if (eventType === ADDON_PAYMENT_EVENT_TYPE) return 'addon_payment';
  if (eventType === LIFETIME_GUARD_EVENT_TYPE) return 'lifetime_guard';
  // Explicitly-recognised non-payment markers: checkout-session stubs and
  // renewal-reminder dedup rows (reminder_sent_<milestone>). Listing them
  // (rather than relying only on the catch-all) makes the contract intentional
  // and keeps the prefix constant live. Anything else unrecognised also falls
  // through to non_payment — the safe default: never counted as money.
  if ((NON_PAYMENT_EVENT_TYPES as readonly string[]).includes(eventType)) return 'non_payment';
  if (eventType.startsWith(REMINDER_EVENT_PREFIX)) return 'non_payment';
  return 'non_payment';
}

/**
 * One-way, non-reversible token for a Telegram charge id. Lets the report
 * correlate findings that share a charge id without ever printing the raw id.
 * 'charge' is a domain-separation prefix, not a secret (charge ids are already
 * high-entropy random strings from Telegram). The 64-bit width is for HUMAN
 * CORRELATION only, not a security boundary — a (vanishingly unlikely)
 * collision would at worst visually group two unrelated findings; it never
 * affects detection, which always works off the raw ids in the DB.
 */
export function hashChargeId(rawChargeId: string): string {
  return crypto.createHash('sha256').update(`charge|${rawChargeId}`).digest('hex').slice(0, 16);
}

export type ReconciliationSeverity = 'high' | 'medium' | 'low';

export type ReconciliationFindingKind =
  // bucket 1 — PaymentEvent without Subscription/Purchase
  | 'payment_event_without_subscription'
  | 'payment_event_without_purchase'
  // bucket 2 — Subscription without PaymentEvent
  | 'subscription_without_payment_event'
  // bucket 3 — duplicate charge id
  | 'duplicate_provider_charge_id'
  | 'duplicate_subscription_charge_id'
  | 'charge_id_user_mismatch'
  // bucket 4 — failed / partial
  | 'lifetime_guard_charge'
  | 'unknown_sku_purchase'
  | 'non_completed_purchase'
  | 'stale_active_subscription';

export const FINDING_SEVERITY: Record<ReconciliationFindingKind, ReconciliationSeverity> = {
  payment_event_without_subscription: 'high',
  payment_event_without_purchase: 'high',
  subscription_without_payment_event: 'high',
  duplicate_provider_charge_id: 'high',
  charge_id_user_mismatch: 'high',
  unknown_sku_purchase: 'high',
  duplicate_subscription_charge_id: 'medium',
  lifetime_guard_charge: 'medium',
  non_completed_purchase: 'medium',
  stale_active_subscription: 'low',
};

export interface ReconciliationFinding {
  kind: ReconciliationFindingKind;
  severity: ReconciliationSeverity;
  /** Opaque internal ids — safe to share, queryable for full details. */
  paymentEventId?: string;
  subscriptionId?: string;
  purchaseId?: string;
  userId?: string;
  /** One-way hash of the Telegram charge id (never the raw id). */
  chargeIdHash?: string;
  eventType?: string;
  skuCode?: string;
  status?: string;
  amount?: number;
  currency?: string;
  occurredAt?: string;
  /** Human note — never contains PII or raw payment identifiers. */
  detail: string;
}

export interface ReconciliationReport {
  generatedAt: string;
  scanned: { paymentEvents: number; subscriptions: number; purchases: number };
  counts: Record<ReconciliationFindingKind, number>;
  bySeverity: Record<ReconciliationSeverity, number>;
  findings: ReconciliationFinding[];
  /** No discrepancies at all. */
  ok: boolean;
}

// Upper bound on rows pulled into memory in one pass. reconcileBilling can run
// in-process (GET /admin/billing/reconcile), so it refuses rather than risk
// OOMing the API. Above this, the streamed path noted in the ops doc is needed.
export const DEFAULT_MAX_SCAN_ROWS = 200_000;

export interface ReconcileOptions {
  /** Injectable clock for deterministic stale-subscription tests. */
  now?: Date;
  /** Override the known-SKU set (defaults to the live ONE_TIME_SKUS catalogue). */
  knownSkuCodes?: Set<string>;
  /** Abort if the three tables together exceed this many rows (default DEFAULT_MAX_SCAN_ROWS). */
  maxScanRows?: number;
}

// Field selections — deliberately omit invoicePayload / rawPayload so PII is
// never even loaded into memory.
const PAYMENT_EVENT_SELECT = {
  id: true,
  subscriptionId: true,
  userId: true,
  telegramPaymentChargeId: true,
  providerPaymentChargeId: true,
  totalAmount: true,
  currency: true,
  eventType: true,
  createdAt: true,
} as const;

const SUBSCRIPTION_SELECT = {
  id: true,
  userId: true,
  planCode: true,
  status: true,
  starsPrice: true,
  telegramChargeId: true,
  currentPeriodEnd: true,
  source: true,
  billingPeriod: true,
  createdAt: true,
} as const;

const PURCHASE_SELECT = {
  id: true,
  userId: true,
  skuCode: true,
  starsPrice: true,
  telegramChargeId: true,
  status: true,
  createdAt: true,
} as const;

type PaymentEventRow = {
  id: string;
  subscriptionId: string | null;
  userId: string;
  telegramPaymentChargeId: string;
  providerPaymentChargeId: string | null;
  totalAmount: number;
  currency: string;
  eventType: string;
  createdAt: Date;
};
type SubscriptionRow = {
  id: string;
  userId: string;
  planCode: string;
  status: string;
  starsPrice: number;
  telegramChargeId: string | null;
  currentPeriodEnd: Date;
  source: string | null;
  billingPeriod: string | null;
  createdAt: Date;
};
type PurchaseRow = {
  id: string;
  userId: string;
  skuCode: string;
  starsPrice: number;
  telegramChargeId: string;
  status: string;
  createdAt: Date;
};

/**
 * Read-only cross-table reconciliation. Loads the three money tables (minus
 * their PII columns) and computes every discrepancy in memory. At the app's
 * scale these tables are small; if PaymentEvent ever exceeds ~100k rows this
 * should move to streamed/SQL aggregation (noted in the ops doc).
 */
export async function reconcileBilling(
  prisma: PrismaClient,
  opts: ReconcileOptions = {},
): Promise<ReconciliationReport> {
  const now = opts.now ?? new Date();
  const knownSkuCodes = opts.knownSkuCodes ?? new Set<string>(Object.keys(ONE_TIME_SKUS));
  const maxScanRows = opts.maxScanRows ?? DEFAULT_MAX_SCAN_ROWS;

  // Cheap precheck before the in-memory load — refuse oversized scans so the
  // in-process admin endpoint can't OOM the API process.
  const [peCount, subCount, purCount] = await Promise.all([
    prisma.paymentEvent.count(),
    prisma.subscription.count(),
    prisma.purchase.count(),
  ]);
  if (peCount + subCount + purCount > maxScanRows) {
    throw new Error(
      `billing reconciliation aborted: ${peCount + subCount + purCount} rows (pre-load count, advisory) exceed the in-memory ceiling (${maxScanRows}). Use a streamed reconciliation — see docs/ops/billing-reconciliation.md.`,
    );
  }

  const [events, subs, purchases] = await Promise.all([
    prisma.paymentEvent.findMany({ select: PAYMENT_EVENT_SELECT }) as Promise<PaymentEventRow[]>,
    prisma.subscription.findMany({ select: SUBSCRIPTION_SELECT }) as Promise<SubscriptionRow[]>,
    prisma.purchase.findMany({ select: PURCHASE_SELECT }) as Promise<PurchaseRow[]>,
  ]);

  const findings: ReconciliationFinding[] = [];
  const push = (f: Omit<ReconciliationFinding, 'severity'>) =>
    findings.push({ ...f, severity: FINDING_SEVERITY[f.kind] });

  // Indexes
  const subById = new Map<string, SubscriptionRow>(subs.map((s) => [s.id, s]));
  const purchaseByCharge = new Map<string, PurchaseRow>(
    purchases.map((p) => [p.telegramChargeId, p]),
  );
  // Linked REAL payments per sub — indexed ONLY from subscription_payment
  // events. reminder_sent_* markers are written with subscriptionId set too
  // (schedulers/pro-renewal.ts), so indexing every linked event would let a
  // reminder masquerade as a payment trail and hide a genuinely unpaid sub.
  // subscriptionPaymentChargeIds tracks those same payments' charge ids so the
  // "paid sub with no payment" check still recognises a payment whose link was
  // nulled (onDelete:SetNull) — that orphaned link is already reported as
  // payment_event_without_subscription, so we must not ALSO cry "no payment
  // trail" for the same sub.
  const subPaymentEventsBySubId = new Map<string, PaymentEventRow[]>();
  const subscriptionPaymentChargeIds = new Set<string>();
  for (const e of events) {
    if (classifyPaymentEvent(e.eventType) !== 'subscription_payment') continue;
    subscriptionPaymentChargeIds.add(e.telegramPaymentChargeId);
    if (e.subscriptionId) {
      const list = subPaymentEventsBySubId.get(e.subscriptionId) ?? [];
      list.push(e);
      subPaymentEventsBySubId.set(e.subscriptionId, list);
    }
  }

  // ─── Bucket 1 + 3(user mismatch) + 4(lifetime guard): per-PaymentEvent ────
  for (const e of events) {
    const klass = classifyPaymentEvent(e.eventType);

    if (klass === 'subscription_payment') {
      if (!e.subscriptionId) {
        push({
          kind: 'payment_event_without_subscription',
          paymentEventId: e.id,
          userId: e.userId,
          chargeIdHash: hashChargeId(e.telegramPaymentChargeId),
          eventType: e.eventType,
          amount: e.totalAmount,
          currency: e.currency,
          occurredAt: e.createdAt.toISOString(),
          detail: 'Subscription payment with no subscriptionId link (null_link).',
        });
      } else {
        const sub = subById.get(e.subscriptionId);
        if (!sub) {
          push({
            kind: 'payment_event_without_subscription',
            paymentEventId: e.id,
            subscriptionId: e.subscriptionId,
            userId: e.userId,
            chargeIdHash: hashChargeId(e.telegramPaymentChargeId),
            eventType: e.eventType,
            amount: e.totalAmount,
            currency: e.currency,
            occurredAt: e.createdAt.toISOString(),
            detail: 'Subscription payment links to a Subscription that no longer exists (dangling_link).',
          });
        } else if (sub.userId !== e.userId) {
          push({
            kind: 'charge_id_user_mismatch',
            paymentEventId: e.id,
            subscriptionId: sub.id,
            userId: e.userId,
            chargeIdHash: hashChargeId(e.telegramPaymentChargeId),
            eventType: e.eventType,
            occurredAt: e.createdAt.toISOString(),
            detail: 'PaymentEvent.userId differs from its linked Subscription.userId.',
          });
        }
      }
    } else if (klass === 'addon_payment') {
      const purchase = purchaseByCharge.get(e.telegramPaymentChargeId);
      if (!purchase) {
        push({
          kind: 'payment_event_without_purchase',
          paymentEventId: e.id,
          userId: e.userId,
          chargeIdHash: hashChargeId(e.telegramPaymentChargeId),
          eventType: e.eventType,
          amount: e.totalAmount,
          currency: e.currency,
          occurredAt: e.createdAt.toISOString(),
          detail: 'Add-on payment with no matching Purchase row (by charge id).',
        });
      } else if (purchase.userId !== e.userId) {
        push({
          kind: 'charge_id_user_mismatch',
          paymentEventId: e.id,
          purchaseId: purchase.id,
          userId: e.userId,
          chargeIdHash: hashChargeId(e.telegramPaymentChargeId),
          eventType: e.eventType,
          occurredAt: e.createdAt.toISOString(),
          detail: 'Add-on PaymentEvent.userId differs from its matching Purchase.userId.',
        });
      }
    } else if (klass === 'lifetime_guard') {
      push({
        kind: 'lifetime_guard_charge',
        paymentEventId: e.id,
        subscriptionId: e.subscriptionId ?? undefined,
        userId: e.userId,
        chargeIdHash: hashChargeId(e.telegramPaymentChargeId),
        eventType: e.eventType,
        amount: e.totalAmount,
        currency: e.currency,
        occurredAt: e.createdAt.toISOString(),
        detail: 'Monthly/yearly charge taken after a LIFETIME purchase — no new entitlement granted (refund candidate).',
      });
    }
    // non_payment → ignored (checkout stubs, renewal reminders)
  }

  // ─── Bucket 2: paid Subscription with no PaymentEvent ─────────────────────
  for (const s of subs) {
    if (s.source !== PAID_SUBSCRIPTION_SOURCE) continue; // free grants are fine
    const linkedPayments = subPaymentEventsBySubId.get(s.id);
    // A payment "belongs to" this sub if a subscription-payment event links by
    // id OR shares the sub's own charge id (covers a real payment whose link
    // was nulled). Scoped to THIS sub's charge id — NOT "any payment by this
    // user" — so an unrelated orphaned payment for the same user cannot mask a
    // genuinely unpaid sub.
    const hasMatchingPayment =
      !!s.telegramChargeId && subscriptionPaymentChargeIds.has(s.telegramChargeId);
    if ((!linkedPayments || linkedPayments.length === 0) && !hasMatchingPayment) {
      push({
        kind: 'subscription_without_payment_event',
        subscriptionId: s.id,
        userId: s.userId,
        chargeIdHash: s.telegramChargeId ? hashChargeId(s.telegramChargeId) : undefined,
        status: s.status,
        amount: s.starsPrice,
        currency: 'XTR',
        occurredAt: s.createdAt.toISOString(),
        detail: `Paid (${PAID_SUBSCRIPTION_SOURCE}) subscription with zero PaymentEvents — PRO granted with no payment trail.`,
      });
    }
  }

  // ─── Bucket 3: duplicate charge ids ───────────────────────────────────────
  // Each Telegram Stars payment carries a DISTINCT provider_payment_charge_id
  // (renewals, yearly stacking, and post-lifetime audit charges each get their
  // own — verified on prod: zero dup-provider findings across live payments),
  // so the same providerPaymentChargeId on >1 PaymentEvent is never legitimate:
  // two telegram charge ids mapping to one real payment = double-record /
  // double-grant risk. Non-payment markers carry a null provider id and are
  // skipped by groupNonNull. Same- OR cross-user duplication is anomalous.
  groupNonNull(events, (e) => e.providerPaymentChargeId).forEach((group) => {
    if (group.length < 2) return;
    for (const e of group) {
      push({
        kind: 'duplicate_provider_charge_id',
        paymentEventId: e.id,
        userId: e.userId,
        chargeIdHash: hashChargeId(e.telegramPaymentChargeId),
        eventType: e.eventType,
        amount: e.totalAmount,
        currency: e.currency,
        occurredAt: e.createdAt.toISOString(),
        detail: `providerPaymentChargeId shared by ${group.length} PaymentEvents.`,
      });
    }
  });
  // Subscription.telegramChargeId is NOT unique. @@unique([userId, planCode])
  // means one PRO sub per user (its charge id is overwritten on each renewal),
  // so the same charge id on ≥2 subs can only be a CROSS-user collision (one
  // Telegram payment attributed to two subscriptions) — rare, but always a real
  // anomaly, never a renewal artifact.
  groupNonNull(subs, (s) => s.telegramChargeId).forEach((group) => {
    if (group.length < 2) return;
    for (const s of group) {
      push({
        kind: 'duplicate_subscription_charge_id',
        subscriptionId: s.id,
        userId: s.userId,
        chargeIdHash: s.telegramChargeId ? hashChargeId(s.telegramChargeId) : undefined,
        status: s.status,
        occurredAt: s.createdAt.toISOString(),
        detail: `Subscription.telegramChargeId shared by ${group.length} subscriptions.`,
      });
    }
  });

  // ─── Bucket 4: failed / partial ───────────────────────────────────────────
  for (const p of purchases) {
    if (!knownSkuCodes.has(p.skuCode)) {
      push({
        kind: 'unknown_sku_purchase',
        purchaseId: p.id,
        userId: p.userId,
        chargeIdHash: hashChargeId(p.telegramChargeId),
        skuCode: p.skuCode,
        status: p.status,
        amount: p.starsPrice,
        currency: 'XTR',
        occurredAt: p.createdAt.toISOString(),
        detail: 'Purchase for an unrecognised SKU — money taken, no entitlement granted.',
      });
    }
    if (!PURCHASE_TERMINAL_STATUSES.has(p.status)) {
      push({
        kind: 'non_completed_purchase',
        purchaseId: p.id,
        userId: p.userId,
        chargeIdHash: hashChargeId(p.telegramChargeId),
        skuCode: p.skuCode,
        status: p.status,
        amount: p.starsPrice,
        currency: 'XTR',
        occurredAt: p.createdAt.toISOString(),
        detail: `Purchase stuck in non-terminal status '${p.status}'.`,
      });
    }
  }
  for (const s of subs) {
    if (s.status === 'ACTIVE' && s.billingPeriod !== LIFETIME_BILLING_PERIOD && s.currentPeriodEnd < now) {
      push({
        kind: 'stale_active_subscription',
        subscriptionId: s.id,
        userId: s.userId,
        status: s.status,
        occurredAt: s.currentPeriodEnd.toISOString(),
        detail: 'Subscription is ACTIVE but currentPeriodEnd is in the past — expiry sweep gap.',
      });
    }
  }

  return buildReport(now, { events, subs, purchases }, findings);
}

function buildReport(
  now: Date,
  scanned: { events: unknown[]; subs: unknown[]; purchases: unknown[] },
  findings: ReconciliationFinding[],
): ReconciliationReport {
  const counts = {} as Record<ReconciliationFindingKind, number>;
  (Object.keys(FINDING_SEVERITY) as ReconciliationFindingKind[]).forEach((k) => (counts[k] = 0));
  const bySeverity: Record<ReconciliationSeverity, number> = { high: 0, medium: 0, low: 0 };
  for (const f of findings) {
    counts[f.kind] += 1;
    bySeverity[f.severity] += 1;
  }
  return {
    generatedAt: now.toISOString(),
    scanned: {
      paymentEvents: scanned.events.length,
      subscriptions: scanned.subs.length,
      purchases: scanned.purchases.length,
    },
    counts,
    bySeverity,
    findings,
    ok: findings.length === 0,
  };
}

function groupNonNull<T>(rows: T[], key: (row: T) => string | null): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (!k) continue;
    const list = groups.get(k) ?? [];
    list.push(row);
    groups.set(k, list);
  }
  return groups;
}

// ─── Safe apply ──────────────────────────────────────────────────────────────

export interface ApplyResult {
  /** Subscription-payment PaymentEvents relinked to their owner's PRO sub. */
  relinkedPaymentEvents: { paymentEventId: string; subscriptionId: string }[];
  /** Candidates intentionally left untouched (ambiguous / unfixable). */
  skipped: { paymentEventId: string; reason: string }[];
}

/**
 * The ONLY mutation this tool performs. Re-queries the DB (never trusts a stale
 * report) for subscription-payment PaymentEvents whose subscriptionId is null,
 * and relinks each to the PRO Subscription whose telegramChargeId EXACTLY
 * equals the event's charge id — the only provably-correct match. (A "user's
 * single PRO sub" fallback would mislink an old/foreign payment to a
 * since-replaced sub after a delete→recreate, so it is deliberately NOT used.)
 * The relink is a conditional updateMany guarded on subscriptionId:null, so it
 * is atomic against a concurrent webhook and idempotent under contention.
 * Everything else (dangling links, duplicates, refunds, re-grants, and orphans
 * with no charge-id match) is left to a human.
 */
export async function applySafeFixes(prisma: PrismaClient): Promise<ApplyResult> {
  const relinkedPaymentEvents: ApplyResult['relinkedPaymentEvents'] = [];
  const skipped: ApplyResult['skipped'] = [];

  // This loads only ORPHANED subscription-payment events (subscriptionId null)
  // — the anomaly set, not a full table — so it is inherently bounded and needs
  // no scan ceiling: a healthy ledger returns ~zero rows here.
  const orphans = await prisma.paymentEvent.findMany({
    where: {
      subscriptionId: null,
      eventType: { in: [...SUBSCRIPTION_PAYMENT_EVENT_TYPES] },
    },
    select: { id: true, userId: true, telegramPaymentChargeId: true },
  });

  for (const e of orphans) {
    // Only a PRO sub whose charge id EXACTLY matches is a provably-correct
    // target. No "single PRO sub" fallback — see the doc comment above.
    const match = await prisma.subscription.findFirst({
      where: { userId: e.userId, planCode: 'PRO', telegramChargeId: e.telegramPaymentChargeId },
      select: { id: true },
    });

    if (!match) {
      skipped.push({ paymentEventId: e.id, reason: 'no PRO subscription with a matching charge id' });
      continue;
    }

    // Conditional + atomic: the `subscriptionId: null` guard means a webhook
    // that linked this event between our read and write turns the update into a
    // no-op (count 0) instead of clobbering the bot's correct link — and keeps
    // a concurrent second --apply idempotent.
    const { count } = await prisma.paymentEvent.updateMany({
      where: { id: e.id, subscriptionId: null },
      data: { subscriptionId: match.id },
    });
    if (count === 0) {
      skipped.push({ paymentEventId: e.id, reason: 'raced: linked by another writer before update' });
      continue;
    }
    relinkedPaymentEvents.push({ paymentEventId: e.id, subscriptionId: match.id });
  }

  return { relinkedPaymentEvents, skipped };
}
