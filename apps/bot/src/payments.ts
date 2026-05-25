// Telegram Stars `successful_payment` processors — extracted from the
// in-line bot.on('message') handler in index.ts so the money paths are
// testable in isolation. Each function:
//
//   • does idempotency dedup against PaymentEvent.telegramPaymentChargeId
//     (or Purchase.telegramChargeId for add-ons) — duplicate webhook ⇒
//     `{ kind: 'duplicate' }` and no DB writes;
//   • enforces the LIFETIME guard — a monthly/yearly charge arriving after
//     a lifetime purchase records an audit PaymentEvent
//     (`payment_success_post_lifetime`) but never overwrites the lifetime
//     Subscription row;
//   • performs the Subscription upsert + PaymentEvent insert (or Purchase +
//     PaymentEvent + UserAddOn/UserCredits for add-ons) inside a single
//     prisma.$transaction;
//   • returns a structured `PaymentOutcome` so the calling bot handler
//     decides what to reply, what to log, and which analytics event to
//     emit. No Telegram replies, no analytics calls, no locale lookup here
//     — those concerns stay in the index.ts wrapper.
//
// This split mirrors the apps/api/services/ extraction pattern: pure
// processor functions on the inside, thin wrappers on the outside.

import type { PrismaClient } from '@wishlist/db';
import { LIFETIME_BILLING_PERIOD, PRO_LIFETIME_PERIOD_END_ISO } from '@wishlist/shared';

export const MONTHLY_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
export const YEARLY_PERIOD_MS = 365 * 24 * 60 * 60 * 1000;
export const PRO_PLAN_CODE = 'PRO';

// Shape of Telegram's `successful_payment` object (the subset we use).
// Mirrors Telegraf's Message.SuccessfulPayment without importing it so the
// processors are decoupled from Telegraf and easier to fake in tests.
export type TelegramSuccessfulPayment = {
  telegram_payment_charge_id: string;
  provider_payment_charge_id?: string | null;
  invoice_payload: string;
  total_amount: number;
  currency: string;
  subscription_expiration_date?: number;
};

export type PaymentOutcome =
  | { kind: 'pro_monthly_activated'; subId: string; periodEnd: Date; hadActivePriorSub: boolean }
  | { kind: 'pro_yearly_activated'; subId: string; periodEnd: Date; stackedFromExisting: Date | null; hadActivePriorSub: boolean }
  | { kind: 'pro_lifetime_activated'; subId: string; replacedPrior: string | null; hadActivePriorSub: boolean }
  | { kind: 'addon_permanent_activated'; skuCode: string; targetId: string | null; addonType: string; quantity: number }
  | { kind: 'addon_consumable_activated'; skuCode: string; creditKey: 'hintCredits' | 'importCredits'; amount: number }
  | { kind: 'addon_unknown_sku'; skuCode: string }
  | { kind: 'duplicate' }
  | { kind: 'lifetime_guard'; auditEventId: string; billingPeriodAttempted: 'monthly' | 'yearly' };

// ─── PRO monthly: pro_monthly:<telegramId>:<uuid> ─────────────────────────
export async function applyProMonthlyPayment(
  prisma: PrismaClient,
  userId: string,
  payment: TelegramSuccessfulPayment,
): Promise<PaymentOutcome> {
  const chargeId = payment.telegram_payment_charge_id;
  const providerChargeId = payment.provider_payment_charge_id ?? null;

  const existing = await prisma.paymentEvent.findUnique({
    where: { telegramPaymentChargeId: chargeId },
  });
  if (existing) return { kind: 'duplicate' };

  const existingSub = await prisma.subscription.findUnique({
    where: { userId_planCode: { userId, planCode: PRO_PLAN_CODE } },
  });
  if (existingSub && existingSub.billingPeriod === LIFETIME_BILLING_PERIOD) {
    const audit = await prisma.paymentEvent.create({
      data: {
        subscriptionId: existingSub.id,
        userId,
        telegramPaymentChargeId: chargeId,
        providerPaymentChargeId: providerChargeId,
        invoicePayload: payment.invoice_payload,
        totalAmount: payment.total_amount,
        currency: payment.currency,
        eventType: 'payment_success_post_lifetime',
        rawPayload: JSON.stringify(payment),
      },
    });
    return { kind: 'lifetime_guard', auditEventId: audit.id, billingPeriodAttempted: 'monthly' };
  }

  const now = new Date();
  const periodEnd = payment.subscription_expiration_date
    ? new Date(payment.subscription_expiration_date * 1000)
    : new Date(now.getTime() + MONTHLY_PERIOD_MS);

  // Snapshot prior state BEFORE the upsert so the analytics branch is
  // unambiguous: hadActivePriorSub distinguishes a fresh activation
  // (pro.activated) from a renewal of an already-active Pro user
  // (subscription.renewed). Without this snapshot the upsert collapses
  // both paths into one row, and we can't tell them apart from the
  // post-write state alone.
  //
  // Intentionally narrower than the entitlement resolver's filter
  // (status: { in: ['ACTIVE', 'CANCELLED'] }). hadActivePriorSub asks
  // "did Telegram already have an active recurring sub set up?", not
  // "was the user PRO?". A user who hit cancel (status=CANCELLED) and
  // pays a fresh monthly mid-period IS starting a new Telegram-managed
  // recurring relationship, so we emit pro.activated. The resolver's
  // broader filter is separate: it gates feature access, where keeping
  // a cancelled-but-in-period user PRO until expiry is the right UX.
  const priorMonthly = await prisma.subscription.findUnique({
    where: { userId_planCode: { userId, planCode: PRO_PLAN_CODE } },
    select: { id: true, status: true, currentPeriodEnd: true },
  });
  const hadActivePriorSub =
    !!priorMonthly && priorMonthly.status === 'ACTIVE' && priorMonthly.currentPeriodEnd > now;

  const sub = await prisma.$transaction(async (tx) => {
    const s = await tx.subscription.upsert({
      where: { userId_planCode: { userId, planCode: PRO_PLAN_CODE } },
      create: {
        userId,
        planCode: PRO_PLAN_CODE,
        status: 'ACTIVE',
        starsPrice: payment.total_amount,
        telegramChargeId: chargeId,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        source: 'telegram_stars',
        billingPeriod: 'monthly',
        cancelAtPeriodEnd: false,
      },
      update: {
        status: 'ACTIVE',
        starsPrice: payment.total_amount,
        telegramChargeId: chargeId,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        cancelledAt: null,
        cancelAtPeriodEnd: false,
        source: 'telegram_stars',
        billingPeriod: 'monthly',
      },
    });
    await tx.paymentEvent.create({
      data: {
        subscriptionId: s.id,
        userId,
        telegramPaymentChargeId: chargeId,
        providerPaymentChargeId: providerChargeId,
        invoicePayload: payment.invoice_payload,
        totalAmount: payment.total_amount,
        currency: payment.currency,
        eventType: 'payment_success',
        rawPayload: JSON.stringify(payment),
      },
    });
    return s;
  });

  return { kind: 'pro_monthly_activated', subId: sub.id, periodEnd, hadActivePriorSub };
}

// ─── PRO yearly (one-time): pro_yearly:<telegramId>:<uuid> ─────────────
// Telegram Stars doesn't support subscription_period > 30 days, so yearly
// is a non-recurring invoice. We extend currentPeriodEnd by 365 days from
// max(now, existing end), set cancelAtPeriodEnd=true (nothing to
// auto-renew), and log the event. Renewal reminder is handled by the
// yearly-expiry cron in apps/api.
export async function applyProYearlyPayment(
  prisma: PrismaClient,
  userId: string,
  payment: TelegramSuccessfulPayment,
): Promise<PaymentOutcome> {
  const chargeId = payment.telegram_payment_charge_id;
  const providerChargeId = payment.provider_payment_charge_id ?? null;

  const existing = await prisma.paymentEvent.findUnique({
    where: { telegramPaymentChargeId: chargeId },
  });
  if (existing) return { kind: 'duplicate' };

  const now = new Date();

  const existingSub = await prisma.subscription.findUnique({
    where: { userId_planCode: { userId, planCode: PRO_PLAN_CODE } },
  });
  if (existingSub && existingSub.billingPeriod === LIFETIME_BILLING_PERIOD) {
    const audit = await prisma.paymentEvent.create({
      data: {
        subscriptionId: existingSub.id,
        userId,
        telegramPaymentChargeId: chargeId,
        providerPaymentChargeId: providerChargeId,
        invoicePayload: payment.invoice_payload,
        totalAmount: payment.total_amount,
        currency: payment.currency,
        eventType: 'payment_success_post_lifetime',
        rawPayload: JSON.stringify(payment),
      },
    });
    return { kind: 'lifetime_guard', auditEventId: audit.id, billingPeriodAttempted: 'yearly' };
  }

  // Stack: yearly starts from max(now, currentPeriodEnd). Protects the
  // user's remaining monthly entitlement when upgrading mid-cycle.
  const startFrom = existingSub && existingSub.currentPeriodEnd > now
    ? existingSub.currentPeriodEnd
    : now;
  const periodEnd = new Date(startFrom.getTime() + YEARLY_PERIOD_MS);
  const stackedFromExisting = existingSub && existingSub.currentPeriodEnd > now
    ? existingSub.currentPeriodEnd
    : null;
  const hadActivePriorSub =
    !!existingSub && existingSub.status === 'ACTIVE' && existingSub.currentPeriodEnd > now;

  const sub = await prisma.$transaction(async (tx) => {
    const s = await tx.subscription.upsert({
      where: { userId_planCode: { userId, planCode: PRO_PLAN_CODE } },
      create: {
        userId,
        planCode: PRO_PLAN_CODE,
        status: 'ACTIVE',
        starsPrice: payment.total_amount,
        telegramChargeId: chargeId,
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        source: 'telegram_stars',
        billingPeriod: 'yearly',
        cancelAtPeriodEnd: true,
      },
      update: {
        status: 'ACTIVE',
        starsPrice: payment.total_amount,
        telegramChargeId: chargeId,
        currentPeriodEnd: periodEnd,
        cancelledAt: null,
        cancelAtPeriodEnd: true,
        source: 'telegram_stars',
        billingPeriod: 'yearly',
      },
    });
    await tx.paymentEvent.create({
      data: {
        subscriptionId: s.id,
        userId,
        telegramPaymentChargeId: chargeId,
        providerPaymentChargeId: providerChargeId,
        invoicePayload: payment.invoice_payload,
        totalAmount: payment.total_amount,
        currency: payment.currency,
        eventType: 'payment_success_yearly',
        rawPayload: JSON.stringify(payment),
      },
    });
    return s;
  });

  return { kind: 'pro_yearly_activated', subId: sub.id, periodEnd, stackedFromExisting, hadActivePriorSub };
}

// ─── PRO lifetime (one-time, permanent): pro_lifetime:<telegramId>:<uuid> ──
// Lifetime is a non-recurring Stars purchase that grants permanent Pro.
// We write a Subscription with billingPeriod='lifetime', cancelAtPeriodEnd=false,
// and currentPeriodEnd anchored at 2099-12-31 (semantic "no expiry"
// sentinel — resolvers always treat billingPeriod='lifetime' as truth,
// the date is just defensive padding so the expiry-sweep cron never flips
// it to EXPIRED). Lifetime overrides any prior monthly/yearly row.
export async function applyProLifetimePayment(
  prisma: PrismaClient,
  userId: string,
  payment: TelegramSuccessfulPayment,
): Promise<PaymentOutcome> {
  const chargeId = payment.telegram_payment_charge_id;
  const providerChargeId = payment.provider_payment_charge_id ?? null;

  const existing = await prisma.paymentEvent.findUnique({
    where: { telegramPaymentChargeId: chargeId },
  });
  if (existing) return { kind: 'duplicate' };

  const now = new Date();
  const lifetimePeriodEnd = new Date(PRO_LIFETIME_PERIOD_END_ISO);

  const existingSub = await prisma.subscription.findUnique({
    where: { userId_planCode: { userId, planCode: PRO_PLAN_CODE } },
  });
  // Lifetime is a state transition, not a renewal: treat any prior active
  // monthly/yearly as "already Pro" → caller emits subscription.renewed;
  // else pro.activated. Lifetime → lifetime (different chargeId) is a no-op
  // upsert at the row level (billingPeriod stays 'lifetime',
  // currentPeriodEnd stays at the sentinel) — the apps/api billing checkout
  // endpoint blocks the user from buying lifetime twice, so this path is
  // unreachable in normal flow. If it does fire defensively, no data is
  // corrupted: status stays ACTIVE, only starsPrice / telegramChargeId are
  // refreshed and a second `payment_success_lifetime` PaymentEvent is added
  // for audit. PaymentEvent uniqueness is per-chargeId, not per-purchase
  // intent, so a second lifetime invoice with a fresh chargeId is NOT a
  // duplicate at the dedup layer.
  const hadActivePriorSub =
    !!existingSub && existingSub.status === 'ACTIVE' && existingSub.currentPeriodEnd > now;
  const replacedPrior = existingSub?.billingPeriod ?? null;

  const sub = await prisma.$transaction(async (tx) => {
    const s = await tx.subscription.upsert({
      where: { userId_planCode: { userId, planCode: PRO_PLAN_CODE } },
      create: {
        userId,
        planCode: PRO_PLAN_CODE,
        status: 'ACTIVE',
        starsPrice: payment.total_amount,
        telegramChargeId: chargeId,
        currentPeriodStart: now,
        currentPeriodEnd: lifetimePeriodEnd,
        source: 'telegram_stars',
        billingPeriod: LIFETIME_BILLING_PERIOD,
        cancelAtPeriodEnd: false,
      },
      update: {
        status: 'ACTIVE',
        starsPrice: payment.total_amount,
        telegramChargeId: chargeId,
        currentPeriodEnd: lifetimePeriodEnd,
        cancelledAt: null,
        cancelAtPeriodEnd: false,
        source: 'telegram_stars',
        billingPeriod: LIFETIME_BILLING_PERIOD,
      },
    });
    await tx.paymentEvent.create({
      data: {
        subscriptionId: s.id,
        userId,
        telegramPaymentChargeId: chargeId,
        providerPaymentChargeId: providerChargeId,
        invoicePayload: payment.invoice_payload,
        totalAmount: payment.total_amount,
        currency: payment.currency,
        eventType: 'payment_success_lifetime',
        rawPayload: JSON.stringify(payment),
      },
    });
    return s;
  });

  return { kind: 'pro_lifetime_activated', subId: sub.id, replacedPrior, hadActivePriorSub };
}

// ─── One-time add-on: addon:<skuCode>:<telegramId>:<targetId|_>:<sessionId> ──
// SKU catalogue is replicated here (no cross-app imports from apps/api).
// In-file drift between SKU_ADDON_TYPES and SKU_CREDITS and the
// pre_checkout allow-list is now impossible by construction —
// pre_checkout imports KNOWN_ADDON_SKUS below, which is union-derived
// from these maps. Cross-app drift between apps/api `ONE_TIME_SKUS` and
// this catalogue is NOT auto-checked (no cross-package import); the
// `KNOWN_ADDON_SKUS coverage` describe in payments.test.ts maintains a
// hand-listed expectation that mirrors apps/api as a manual tripwire.
// Permanent unlocks write to UserAddOn (quantity 5/15 for item-slot
// SKUs, 1 otherwise); consumable credit packs increment UserCredits in
// an upsert. Idempotency is via Purchase.telegramChargeId (@unique),
// separate from the PaymentEvent unique so a single payment generates
// exactly one Purchase + one PaymentEvent.
const SKU_ADDON_TYPES: Record<string, string> = {
  extra_wishlist_slot: 'wishlist_slot',
  extra_subscription_slot: 'subscription_slot',
  extra_items_5: 'item_slot_5',
  extra_items_15: 'item_slot_15',
  seasonal_decoration: 'seasonal_decoration',
  gift_notes_unlock: 'gift_notes_unlock',
  reservation_pro_unlock: 'reservation_pro_unlock',
  group_gift_unlock: 'group_gift_unlock',
  smart_reservations_unlock: 'smart_reservations_unlock',
  secret_reservation_unlock: 'secret_reservation_unlock',
};
const SKU_CREDITS: Record<string, { key: 'hintCredits' | 'importCredits'; amount: number }> = {
  hints_pack_5:   { key: 'hintCredits',   amount: 5  },
  hints_pack_10:  { key: 'hintCredits',   amount: 10 },
  import_pack_10: { key: 'importCredits', amount: 10 },
  import_pack_25: { key: 'importCredits', amount: 25 },
};

export async function applyAddonPayment(
  prisma: PrismaClient,
  userId: string,
  skuCode: string,
  targetId: string | null,
  payment: TelegramSuccessfulPayment,
): Promise<PaymentOutcome> {
  const chargeId = payment.telegram_payment_charge_id;

  const existingPurchase = await prisma.purchase.findUnique({
    where: { telegramChargeId: chargeId },
  });
  if (existingPurchase) return { kind: 'duplicate' };

  const addonType = SKU_ADDON_TYPES[skuCode];
  const creditInfo = SKU_CREDITS[skuCode];
  const quantity = skuCode === 'extra_items_5' ? 5 : skuCode === 'extra_items_15' ? 15 : 1;

  // Unknown-SKU branch — processor writes are byte-identical to the
  // pre-extraction handler (Purchase + PaymentEvent for audit + dedup,
  // no UserAddOn or UserCredits). The pre_checkout_query validator in
  // apps/bot/src/index.ts now uses the same KNOWN_ADDON_SKUS export
  // below, so drift between the validator and these maps is no longer
  // possible — this branch then fires only on a totally unrecognised
  // SKU (e.g. a manually crafted invoice payload).
  //
  // WRAPPER BEHAVIOR CHANGE (intentional): the old in-line handler
  // emitted `addon_payment_success` analytics + replied "addon activated"
  // + logged success for any successful_payment, regardless of whether
  // the SKU actually granted an entitlement. The new wrapper skips
  // analytics, the user-facing reply, and the success log on the
  // unknown-SKU branch — users no longer get a false-positive
  // "activated" message for a SKU we couldn't fulfil.

  await prisma.$transaction(async (tx) => {
    await tx.purchase.create({
      data: {
        userId,
        skuCode,
        quantity: 1,
        targetId,
        starsPrice: payment.total_amount,
        telegramChargeId: chargeId,
        invoicePayload: payment.invoice_payload,
        status: 'completed',
      },
    });

    await tx.paymentEvent.create({
      data: {
        userId,
        telegramPaymentChargeId: chargeId,
        providerPaymentChargeId: payment.provider_payment_charge_id ?? null,
        invoicePayload: payment.invoice_payload,
        totalAmount: payment.total_amount,
        currency: payment.currency,
        eventType: 'addon_payment_success',
        rawPayload: JSON.stringify(payment),
      },
    });

    if (addonType) {
      await tx.userAddOn.create({
        data: { userId, addonType, quantity, targetId },
      });
    }

    if (creditInfo) {
      await tx.userCredits.upsert({
        where: { userId },
        create: {
          userId,
          hintCredits: creditInfo.key === 'hintCredits' ? creditInfo.amount : 0,
          importCredits: creditInfo.key === 'importCredits' ? creditInfo.amount : 0,
        },
        update: { [creditInfo.key]: { increment: creditInfo.amount } },
      });
    }
  });

  if (addonType) {
    return { kind: 'addon_permanent_activated', skuCode, targetId, addonType, quantity };
  }
  if (creditInfo) {
    return { kind: 'addon_consumable_activated', skuCode, creditKey: creditInfo.key, amount: creditInfo.amount };
  }
  return { kind: 'addon_unknown_sku', skuCode };
}

// Exposed for the bot's pre_checkout_query validator and for tests that
// want to assert SKU coverage.
export const KNOWN_ADDON_SKUS = new Set<string>([
  ...Object.keys(SKU_ADDON_TYPES),
  ...Object.keys(SKU_CREDITS),
]);
