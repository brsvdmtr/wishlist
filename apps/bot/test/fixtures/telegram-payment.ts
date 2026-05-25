// Builders for Telegram `successful_payment` payloads. Mirrors the shape
// Telegram actually sends to bot.on('message') webhooks — kept minimal so
// each test only specifies the bits it cares about, while every other
// field gets a sane default.
//
// The four invoice_payload formats the bot accepts (per the
// `pre_checkout_query` validator in apps/bot/src/index.ts and the
// processors in apps/bot/src/payments.ts):
//
//   pro_monthly:<telegramId>:<uuid>
//   pro_yearly:<telegramId>:<uuid>
//   pro_lifetime:<telegramId>:<uuid>
//   addon:<skuCode>:<telegramId>:<targetId|_>:<sessionId>
//
// `telegram_payment_charge_id` is the idempotency key — both Subscription
// payment paths dedup on PaymentEvent.telegramPaymentChargeId (@unique)
// and add-ons dedup on Purchase.telegramChargeId (@unique). Tests pass a
// stable chargeId when they want to replay; the default builder generates
// a fresh one each call so accidental cross-test collisions don't happen.

import { randomUUID } from 'node:crypto';

import type { TelegramSuccessfulPayment } from '../../src/payments';

let counter = 0;
const nextChargeId = () => `tg_charge_test_${Date.now()}_${++counter}_${randomUUID().slice(0, 8)}`;

type PaymentOverrides = Partial<TelegramSuccessfulPayment> & {
  /** When set, builds invoice_payload as pro_monthly:<telegramId>:<uuid>. */
  telegramId?: string;
  /** When set, fixes the uuid suffix in invoice_payload (defaults to a random one). */
  invoiceUuid?: string;
};

/** Build a `pro_monthly:<telegramId>:<uuid>` successful_payment. */
export function makeMonthlyPayment(over: PaymentOverrides = {}): TelegramSuccessfulPayment {
  const telegramId = over.telegramId ?? '12345';
  const uuid = over.invoiceUuid ?? randomUUID();
  return {
    telegram_payment_charge_id: over.telegram_payment_charge_id ?? nextChargeId(),
    provider_payment_charge_id: over.provider_payment_charge_id ?? `prov_${uuid.slice(0, 8)}`,
    invoice_payload: over.invoice_payload ?? `pro_monthly:${telegramId}:${uuid}`,
    total_amount: over.total_amount ?? 100,
    currency: over.currency ?? 'XTR',
    subscription_expiration_date: over.subscription_expiration_date,
  };
}

/** Build a `pro_yearly:<telegramId>:<uuid>` successful_payment. */
export function makeYearlyPayment(over: PaymentOverrides = {}): TelegramSuccessfulPayment {
  const telegramId = over.telegramId ?? '12345';
  const uuid = over.invoiceUuid ?? randomUUID();
  return {
    telegram_payment_charge_id: over.telegram_payment_charge_id ?? nextChargeId(),
    provider_payment_charge_id: over.provider_payment_charge_id ?? `prov_${uuid.slice(0, 8)}`,
    invoice_payload: over.invoice_payload ?? `pro_yearly:${telegramId}:${uuid}`,
    total_amount: over.total_amount ?? 800,
    currency: over.currency ?? 'XTR',
  };
}

/** Build a `pro_lifetime:<telegramId>:<uuid>` successful_payment. */
export function makeLifetimePayment(over: PaymentOverrides = {}): TelegramSuccessfulPayment {
  const telegramId = over.telegramId ?? '12345';
  const uuid = over.invoiceUuid ?? randomUUID();
  return {
    telegram_payment_charge_id: over.telegram_payment_charge_id ?? nextChargeId(),
    provider_payment_charge_id: over.provider_payment_charge_id ?? `prov_${uuid.slice(0, 8)}`,
    invoice_payload: over.invoice_payload ?? `pro_lifetime:${telegramId}:${uuid}`,
    total_amount: over.total_amount ?? 2490,
    currency: over.currency ?? 'XTR',
  };
}

type AddonOverrides = Partial<TelegramSuccessfulPayment> & {
  telegramId?: string;
  targetId?: string | null;
  sessionId?: string;
};

/** Build an `addon:<skuCode>:<telegramId>:<targetId|_>:<sessionId>` successful_payment. */
export function makeAddonPayment(
  skuCode: string,
  over: AddonOverrides = {},
): TelegramSuccessfulPayment {
  const telegramId = over.telegramId ?? '12345';
  const target = over.targetId == null ? '_' : over.targetId;
  const session = over.sessionId ?? randomUUID();
  return {
    telegram_payment_charge_id: over.telegram_payment_charge_id ?? nextChargeId(),
    provider_payment_charge_id: over.provider_payment_charge_id ?? `prov_${session.slice(0, 8)}`,
    invoice_payload: over.invoice_payload ?? `addon:${skuCode}:${telegramId}:${target}:${session}`,
    total_amount: over.total_amount ?? 39,
    currency: over.currency ?? 'XTR',
  };
}

/** Force a specific charge ID — handy when testing idempotent re-delivery. */
export function withChargeId<T extends TelegramSuccessfulPayment>(payment: T, chargeId: string): T {
  return { ...payment, telegram_payment_charge_id: chargeId };
}
