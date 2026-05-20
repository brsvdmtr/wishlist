// Analytics helpers for the Telegram bot.
//
// Mirror of apps/api/src/services/analytics.ts:trackProductEvent — the bot
// cannot import from apps/api (cross-app coupling forbidden), so this file
// holds a typed copy plus the payment-event helper consumed by the
// successful_payment handler in index.ts.
//
// Fire-and-forget semantics + runtime allowlist gate mirror the API helper.
// Prop sanitization (PII-key stripping + truncation) is the shared
// `sanitizeAnalyticsProps` from `@wishlist/shared` — the same code the API
// runs, so server- and bot-emitted events sort identically downstream. See
// docs/research/analytics-pii-audit.md.

import { prisma } from '@wishlist/db';
import {
  isProductEvent,
  sanitizeAnalyticsProps,
  type ProductEventInput,
  type ProductEventName,
} from '@wishlist/shared';
import logger from './logger';

export function trackProductEvent<E extends ProductEventName>(
  input: ProductEventInput<E>,
): void {
  if (!isProductEvent(input.event)) return;
  const props = sanitizeAnalyticsProps(input.props);
  prisma.analyticsEvent
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .create({ data: { event: input.event, userId: input.userId ?? null, props: props ? (props as any) : undefined } })
    .catch((e) => logger.debug({ err: e, event: input.event }, 'analytics write failed'));
}

// Strategy A test seam: the public `emitPaymentAnalytics` writes via
// `prisma.analyticsEvent.create` directly for the legacy
// `referral.invitee_converted_to_paid` event (it lives in the legacy
// allowlist, not in PRODUCT_EVENTS, so the typed helper doesn't accept it
// at compile time). Pull both write paths through these two seams so the
// unit test can mock them deterministically without touching prisma.
//
// Exported so unit tests can swap them. Production wires the real prisma
// path; tests inject a vi.fn() pair via setTrackers/resetTrackers.
type ProductEmit = <E extends ProductEventName>(input: ProductEventInput<E>) => void;
type RawEmit = (input: { event: string; userId: string; props: Record<string, unknown> }) => void;

let _productEmit: ProductEmit = trackProductEvent;
let _rawEmit: RawEmit = (input) => {
  prisma.analyticsEvent
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .create({ data: { event: input.event, userId: input.userId, props: sanitizeAnalyticsProps(input.props) as any } })
    .catch((e) => logger.debug({ err: e, event: input.event }, 'analytics write failed'));
};

/** Test-only override hook. Production never calls this. */
export function __setEmitters(opts: { product?: ProductEmit; raw?: RawEmit } = {}): void {
  if (opts.product) _productEmit = opts.product;
  if (opts.raw) _rawEmit = opts.raw;
}

/** Test-only reset hook. Restores both emitters to their production defaults. */
export function __resetEmitters(): void {
  _productEmit = trackProductEvent;
  _rawEmit = (input) => {
    prisma.analyticsEvent
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .create({ data: { event: input.event, userId: input.userId, props: sanitizeAnalyticsProps(input.props) as any } })
      .catch((e) => logger.debug({ err: e, event: input.event }, 'analytics write failed'));
  };
}

export type PaymentAnalyticsInput = {
  userId: string;
  payload: {
    telegram_payment_charge_id: string;
    invoice_payload: string;
    total_amount: number;
    currency: string;
  };
  planCode: 'PRO' | null;
  billingPeriod: 'monthly' | 'yearly' | 'lifetime' | 'addon';
  hadActivePriorSub: boolean;
  skuCode?: string | null;
};

/**
 * Centralised emit for the (payment.completed, pro.activated|subscription.renewed,
 * referral.invitee_converted_to_paid) trio. Called once per successful
 * Telegram-Stars charge after the PaymentEvent row is durably written.
 *
 * Privacy: props carry only userId-keyed money/period fields — no item
 * titles, no descriptions, no Telegram identifiers beyond the chargeId
 * (which is opaque to humans and already on the PaymentEvent row).
 *
 * - For PRO sub purchases (monthly / yearly / lifetime):
 *   - emits `payment.completed` always
 *   - emits `pro.activated` when there was no active Pro sub before the write
 *   - emits `subscription.renewed` when there was an active Pro sub already
 *   - emits `referral.invitee_converted_to_paid` (legacy server-only event)
 *     when this is the inviter-attributed user's first paid sub
 *
 * - For addons: only `payment.completed` — addons are one-off purchases,
 *   not entitlement state transitions.
 */
export async function emitPaymentAnalytics(opts: PaymentAnalyticsInput): Promise<void> {
  const { userId, payload, planCode, billingPeriod, hadActivePriorSub, skuCode } = opts;

  const baseProps: Record<string, unknown> = {
    amountStars: payload.total_amount,
    currency: payload.currency,
    billingPeriod,
    chargeId: payload.telegram_payment_charge_id,
    source: 'telegram_stars',
  };
  if (planCode) baseProps.planCode = planCode;
  if (skuCode) baseProps.skuCode = skuCode;

  _productEmit({ event: 'payment.completed', userId, props: baseProps });

  if (billingPeriod === 'addon' || planCode !== 'PRO') return;

  if (hadActivePriorSub) {
    _productEmit({
      event: 'subscription.renewed',
      userId,
      props: { planCode, billingPeriod, amountStars: payload.total_amount, currency: payload.currency },
    });
  } else {
    _productEmit({
      event: 'pro.activated',
      userId,
      props: { planCode, billingPeriod, source: 'telegram_stars', amountStars: payload.total_amount, currency: payload.currency },
    });

    try {
      const profile = await prisma.userProfile.findUnique({
        where: { userId },
        select: { referredByUserId: true },
      });
      if (profile?.referredByUserId) {
        const priorPaidCount = await prisma.paymentEvent.count({
          where: {
            userId,
            telegramPaymentChargeId: { not: payload.telegram_payment_charge_id },
            eventType: { in: ['payment_success', 'payment_success_yearly', 'payment_success_lifetime'] },
          },
        });
        if (priorPaidCount === 0) {
          _rawEmit({
            event: 'referral.invitee_converted_to_paid',
            userId,
            props: {
              inviterUserId: profile.referredByUserId,
              planCode,
              billingPeriod,
              amountStars: payload.total_amount,
              currency: payload.currency,
            },
          });
        }
      }
    } catch (err) {
      logger.warn({ err, userId }, 'referral invitee-paid attribution check failed');
    }
  }
}
