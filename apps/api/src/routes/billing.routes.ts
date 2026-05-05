// Telegram-auth router for /tg/billing/* — 9 handlers covering the entire
// Telegram Stars billing flow: PRO subscription (monthly + yearly), one-time
// add-on SKUs, gift-notes unlock, and payment history.
//
// Mounted via `tgRouter.use(billingRouter)` in apps/api/src/index.ts after
// the other early P5 sub-routers, AFTER the protectTgRoute(...) chain at
// lines 1568–1575 (the eight billing-category state-changing endpoints).
// Those `tgRouter.all(...)` middleware fire BEFORE sub-router dispatch, so
// idem (`category: 'payment'`, 7-day TTL, critical=true) and the `payment`
// rate-limit (on the 3 checkout endpoints) remain in effect.
//
// Same factory pattern as P5a–P5l. Handler bodies are byte-identical to
// their previous in-place definitions in index.ts (lines 4914–5278) —
// only `tgRouter.` -> `billingRouter.` and indent +2.
//
// State mutation contract (preserved exactly):
//   - API only seeds Stars invoices via `createTgInvoiceLink` and writes
//     PaymentEvent audit rows on checkout. Subscription activation and
//     UserAddOn creation happen in apps/bot's `successful_payment` handler
//     (apps/bot/src/index.ts:1173) — NOT touched here.
//   - subscription/cancel and /reactivate flip `cancelAtPeriodEnd` only;
//     they do not change `currentPeriodEnd` or `status` (active until end).
//   - sync endpoints are read-only POSTs (idempotency-friendly client hint
//     to refresh entitlements after a payment).
//
// Invoice payload formats — preserved byte-identical, parsed by the bot:
//   - pro_monthly:<tgId>:<sessionId>
//   - pro_yearly:<tgId>:<sessionId>
//   - addon:<skuCode>:<tgId>:<targetId|_>:<sessionId>
//   - gift-notes uses the addon scheme: addon:gift_notes_unlock:<tgId>:_:<sessionId>
//
// Helpers and constants that STAY in index.ts (passed via deps):
//   - getOrCreateTgUser, getEffectiveEntitlements, getUserEntitlement,
//     trackEvent, trackAnalyticsEvent — universal.
//   - hasReservationPro — also threaded into reservationsRouter.
//   - PRO_PRICE_XTR, PRO_YEARLY_PRICE_XTR, PRO_SUBSCRIPTION_PERIOD,
//     PRO_PLAN_CODE, GIFT_NOTES_PRICE_XTR, GIFT_NOTES_SKU, ONE_TIME_SKUS,
//     ADDON_CAPS — billing-domain constants. ONE_TIME_SKUS is also passed
//     to meRouter and consumed by GET /tg/wishlists in index.ts; PRO_PLAN_CODE
//     is also consumed by the entitlement function and the renewal-reminder
//     scheduler.
//
// Pre-existing security gaps (NOT addressed in this PR):
//   - subscription/cancel + /reactivate have idem but no `payment` rate
//     limit (state change is soft — only flips cancelAtPeriodEnd).
//   - All three sync endpoints are read-wrapped-in-POST with idem only.
//   - GET /billing/history has no rate limit (read-only, standard).

import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '@wishlist/db';

import { asyncHandler } from '../lib/asyncHandler';
import { zodError } from '../lib/http';
import { getRequestLocale } from '../lib/locale';
import { createTgInvoiceLink } from '../telegram/invoiceLink';
import { t } from '@wishlist/shared';
import logger from '../logger';

// Shape of the Telegram initData user object — duplicated from index.ts to
// avoid coupling routes/* to a non-exported local type.
type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

// Minimal structural shape of the User row that handlers in this file read.
type BillingUser = {
  id: string;
  godMode: boolean;
  telegramId?: string | null;
};

// Subscription summary as returned by getUserEntitlement / getEffectiveEntitlements.
type BillingSubscription = {
  id: string;
  status: string;
  periodEnd?: string;
  cancelAtPeriodEnd: boolean;
  cancelledAt: string | null;
  billingPeriod?: string | null;
} | null;

// AddOn shape as exposed on the entitlement payload.
type BillingAddOn = {
  addonType: string;
  quantity: number;
  targetId?: string | null;
};

// Plan info shape on entitlements.
type BillingPlan = {
  code: string;
  items: number;
  participants: number;
  features: readonly string[];
};

// getEffectiveEntitlements return shape (broad — includes every field the
// handlers actually access). Kept structural so we don't drag the full
// computed-entitlement type from index.ts.
type BillingEffectiveEntitlements = {
  plan: BillingPlan;
  isPro: boolean;
  subscription: BillingSubscription;
  effectiveWishlistLimit: number;
  effectiveSubscriptionLimit: number;
  addOns: BillingAddOn[];
  seasonalWishlists: Set<string>;
  extraItemsPerWishlist: Record<string, number>;
  hintCredits: number;
  importCredits: number;
  hasGiftNotes: boolean;
  hasSecretReservations: boolean;
  giftNotes: unknown;
};

// getUserEntitlement return shape (subset accessed by /pro/checkout).
type BillingUserEntitlement = {
  isPro: boolean;
  subscription: BillingSubscription;
};

// SKU shape — narrow subset of ONE_TIME_SKUS values that handlers read.
type BillingSkuDef = {
  code: string;
  price: number;
  type: string;
  addonType: string | null;
  creditKey: 'hint' | 'import' | null;
  creditAmount: number;
  targetRequired: boolean;
};
// Local alias so the existing `as SkuCode` cast inside the byte-identical
// handler body still compiles. Resolves to `string` here because the
// authoritative `keyof typeof ONE_TIME_SKUS` lives in index.ts.
type SkuCode = string;

type BillingAddonCaps = {
  extraWishlistSlots: { FREE: number; PRO: number };
  extraSubscriptionSlots: number;
  extraItems5PerWishlist: number;
  extraItems15PerWishlist: number;
};

export type BillingRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<BillingUser>;
  getEffectiveEntitlements: (userId: string, godMode?: boolean) => Promise<BillingEffectiveEntitlements>;
  getUserEntitlement: (userId: string, godMode?: boolean) => Promise<BillingUserEntitlement>;
  trackEvent: (event: string, userId?: string, props?: Record<string, unknown>) => void;
  trackAnalyticsEvent: (input: { event: string; userId?: string; props?: Record<string, unknown> }) => void;
  hasReservationPro: (user: { telegramId?: string | null; godMode: boolean }, isPro: boolean, addOns?: { addonType: string }[]) => boolean;
  PRO_PRICE_XTR: number;
  PRO_YEARLY_PRICE_XTR: number;
  PRO_SUBSCRIPTION_PERIOD: number;
  PRO_PLAN_CODE: string;
  GIFT_NOTES_PRICE_XTR: number;
  GIFT_NOTES_SKU: string;
  ONE_TIME_SKUS: Readonly<Record<string, BillingSkuDef>>;
  ADDON_CAPS: BillingAddonCaps;
};

export function registerBillingRouter(deps: BillingRouterDeps): Router {
  const {
    getOrCreateTgUser,
    getEffectiveEntitlements,
    getUserEntitlement,
    trackEvent,
    trackAnalyticsEvent,
    hasReservationPro,
    PRO_PRICE_XTR,
    PRO_YEARLY_PRICE_XTR,
    PRO_SUBSCRIPTION_PERIOD,
    PRO_PLAN_CODE,
    GIFT_NOTES_PRICE_XTR,
    GIFT_NOTES_SKU,
    ONE_TIME_SKUS,
    ADDON_CAPS,
  } = deps;

  const billingRouter = Router();

  // POST /tg/billing/pro/checkout — create Stars invoice link
  // Body: { plan?: 'monthly' | 'yearly' } — defaults to monthly for back-compat
  // Monthly = Stars subscription (auto-renews every 30 days).
  // Yearly  = one-time Stars purchase; bot extends currentPeriodEnd by 365 days.
  //           Yearly stacks on top of an existing active subscription (start = max(now, currentEnd)).
  billingRouter.post(
    '/billing/pro/checkout',
    asyncHandler(async (req, res) => {
      const parsed = z.object({
        plan: z.enum(['monthly', 'yearly']).optional(),
      }).safeParse(req.body ?? {});
      const plan = parsed.success && parsed.data.plan ? parsed.data.plan : 'monthly';
      const isYearly = plan === 'yearly';

      const user = await getOrCreateTgUser(req.tgUser!);
      const ent = await getUserEntitlement(user.id);

      // Block duplicate monthly signup; allow yearly on top (stacking is expected UX).
      if (!isYearly && ent.isPro && ent.subscription?.status === 'ACTIVE' && !ent.subscription.cancelAtPeriodEnd && ent.subscription.billingPeriod !== 'yearly') {
        trackEvent('checkout_already_subscribed', user.id);
        return res.json({ subscription: ent.subscription, alreadySubscribed: true });
      }

      const botToken = process.env.BOT_TOKEN;
      if (!botToken) return res.status(500).json({ error: 'Bot not configured' });

      const checkoutSessionId = crypto.randomUUID();
      const payloadType = isYearly ? 'pro_yearly' : 'pro_monthly';
      const payload = `${payloadType}:${req.tgUser!.id}:${checkoutSessionId}`;
      const price = isYearly ? PRO_YEARLY_PRICE_XTR : PRO_PRICE_XTR;
      const locale = getRequestLocale(req);

      trackEvent('checkout_started', user.id, { plan });

      const invoiceBody: Record<string, unknown> = {
        title: isYearly ? t('api_invoice_title_yearly', locale) : 'Wishlist Pro',
        description: isYearly ? t('api_invoice_desc_yearly', locale) : t('api_invoice_desc', locale),
        payload,
        currency: 'XTR',
        prices: [{
          label: isYearly ? t('api_invoice_label_yearly', locale) : t('api_invoice_label', locale),
          amount: price,
        }],
      };
      // Only monthly gets subscription_period — yearly is one-time (TG Stars caps period at 30d).
      if (!isYearly) {
        invoiceBody.subscription_period = PRO_SUBSCRIPTION_PERIOD;
      }

      const tg = await createTgInvoiceLink(botToken, invoiceBody);
      if (!tg.ok) {
        if (tg.retryable) {
          logger.warn({ reason: tg.description, plan }, 'billing createInvoiceLink network failure');
          trackEvent('checkout_failed', user.id, { reason: 'tg_network_timeout', plan });
          return res.status(503).json({ error: 'telegram_unavailable' });
        }
        logger.error({ description: tg.description, plan }, 'billing createInvoiceLink failed');
        trackEvent('checkout_failed', user.id, { reason: tg.description, plan });
        return res.status(502).json({ error: 'Failed to create invoice' });
      }

      // Save invoice_created event
      await prisma.paymentEvent.create({
        data: {
          userId: user.id,
          telegramPaymentChargeId: `checkout_${checkoutSessionId}`,
          invoicePayload: payload,
          totalAmount: price,
          currency: 'XTR',
          eventType: 'invoice_created',
        },
      });

      return res.json({ invoiceUrl: tg.url, checkoutSessionId, plan });
    }),
  );

  // POST /tg/billing/pro/sync — verify subscription state after payment (does NOT activate — bot does)
  billingRouter.post(
    '/billing/pro/sync',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);
      trackEvent('sync_requested', user.id);
      const ent = await getEffectiveEntitlements(user.id);

      return res.json({
        plan: {
          code: ent.plan.code,
          wishlists: ent.effectiveWishlistLimit,
          items: ent.plan.items,
          subscriptions: ent.effectiveSubscriptionLimit,
          participants: ent.plan.participants,
          features: [...ent.plan.features],
        },
        subscription: ent.subscription,
      });
    }),
  );

  // GET /tg/billing/history — payment history
  billingRouter.get(
    '/billing/history',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);
      const events = await prisma.paymentEvent.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, totalAmount: true, currency: true, eventType: true, createdAt: true },
      });
      return res.json({ events });
    }),
  );

  // POST /tg/billing/subscription/cancel — cancel auto-renewal (keeps PRO until period end)
  billingRouter.post(
    '/billing/subscription/cancel',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);
      trackEvent('subscription_cancel_requested', user.id);

      const sub = await prisma.subscription.findFirst({
        where: {
          userId: user.id,
          planCode: PRO_PLAN_CODE,
          status: 'ACTIVE',
          currentPeriodEnd: { gt: new Date() },
        },
      });
      if (!sub) {
        return res.status(404).json({ error: 'No active subscription' });
      }

      const updated = await prisma.subscription.update({
        where: { id: sub.id },
        data: { cancelAtPeriodEnd: true, cancelledAt: new Date() },
      });
      trackAnalyticsEvent({ event: 'subscription.cancelled', userId: String(req.tgUser!.id) });

      return res.json({
        subscription: {
          id: updated.id,
          status: updated.status,
          periodEnd: updated.currentPeriodEnd.toISOString(),
          cancelAtPeriodEnd: updated.cancelAtPeriodEnd,
          cancelledAt: updated.cancelledAt?.toISOString() ?? null,
        },
      });
    }),
  );

  // POST /tg/billing/subscription/reactivate — re-enable auto-renewal if period not expired
  billingRouter.post(
    '/billing/subscription/reactivate',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);
      trackEvent('subscription_reactivated', user.id);

      const sub = await prisma.subscription.findFirst({
        where: {
          userId: user.id,
          planCode: PRO_PLAN_CODE,
          status: 'ACTIVE',
          cancelAtPeriodEnd: true,
          currentPeriodEnd: { gt: new Date() },
        },
      });
      if (!sub) {
        return res.status(404).json({ error: 'No cancelled subscription to reactivate' });
      }

      const updated = await prisma.subscription.update({
        where: { id: sub.id },
        data: { cancelAtPeriodEnd: false, cancelledAt: null },
      });

      return res.json({
        subscription: {
          id: updated.id,
          status: updated.status,
          periodEnd: updated.currentPeriodEnd.toISOString(),
          cancelAtPeriodEnd: updated.cancelAtPeriodEnd,
          cancelledAt: null,
        },
      });
    }),
  );

  // POST /tg/billing/addon/checkout — create Stars invoice for a one-time SKU
  billingRouter.post(
    '/billing/addon/checkout',
    asyncHandler(async (req, res) => {
      const parsed = z.object({
        skuCode: z.string().min(1),
        targetId: z.string().optional(), // wishlistId for wishlist-scoped SKUs
      }).safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      const { skuCode, targetId } = parsed.data;
      const sku = ONE_TIME_SKUS[skuCode as SkuCode];
      if (!sku) return res.status(400).json({ error: 'Unknown SKU', code: skuCode });

      const user = await getOrCreateTgUser(req.tgUser!);
      const ent = await getEffectiveEntitlements(user.id, user.godMode);

      // Validate target for wishlist-scoped SKUs
      if (sku.targetRequired) {
        if (!targetId) return res.status(400).json({ error: 'targetId required for this SKU' });
        const wl = await prisma.wishlist.findUnique({ where: { id: targetId }, select: { ownerId: true } });
        if (!wl) return res.status(404).json({ error: 'Wishlist not found' });
        if (wl.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });
      }

      // Cap checks per SKU
      if (skuCode === 'extra_wishlist_slot') {
        const existing = ent.addOns.filter(a => a.addonType === 'wishlist_slot').reduce((s, a) => s + a.quantity, 0);
        const cap = ent.isPro ? ADDON_CAPS.extraWishlistSlots.PRO : ADDON_CAPS.extraWishlistSlots.FREE;
        if (existing >= cap) return res.status(409).json({ error: 'cap_reached', cap, current: existing });
      }
      if (skuCode === 'extra_subscription_slot') {
        const existing = ent.addOns.filter(a => a.addonType === 'subscription_slot').reduce((s, a) => s + a.quantity, 0);
        if (existing >= ADDON_CAPS.extraSubscriptionSlots) return res.status(409).json({ error: 'cap_reached', cap: ADDON_CAPS.extraSubscriptionSlots, current: existing });
      }
      if (skuCode === 'extra_items_5' && targetId) {
        const existing = ent.addOns.filter(a => a.addonType === 'item_slot_5' && a.targetId === targetId).length;
        // wishlist_cap_reached ≠ cap_reached: this is a per-wishlist limit, not a global SKU cap
        if (existing >= ADDON_CAPS.extraItems5PerWishlist) return res.status(409).json({ error: 'wishlist_cap_reached', cap: ADDON_CAPS.extraItems5PerWishlist, current: existing });
      }
      if (skuCode === 'extra_items_15' && targetId) {
        const existing = ent.addOns.filter(a => a.addonType === 'item_slot_15' && a.targetId === targetId).length;
        if (existing >= ADDON_CAPS.extraItems15PerWishlist) return res.status(409).json({ error: 'wishlist_cap_reached', cap: ADDON_CAPS.extraItems15PerWishlist, current: existing });
      }
      if (skuCode === 'gift_notes_unlock') {
        if (ent.hasGiftNotes) return res.json({ alreadyUnlocked: true });
      }
      if (skuCode === 'reservation_pro_unlock') {
        const hasIt = ent.addOns.some(a => a.addonType === 'reservation_pro_unlock');
        if (hasIt || ent.isPro) return res.json({ alreadyUnlocked: true });
      }
      if (skuCode === 'group_gift_unlock') {
        const hasIt = ent.addOns.some(a => a.addonType === 'group_gift_unlock');
        if (hasIt) return res.json({ alreadyUnlocked: true });
      }
      if (skuCode === 'smart_reservations_unlock') {
        const hasIt = ent.addOns.some(a => a.addonType === 'smart_reservations_unlock' && a.targetId === targetId);
        if (hasIt || ent.isPro) return res.json({ alreadyUnlocked: true });
      }
      if (skuCode === 'secret_reservation_unlock') {
        if (ent.hasSecretReservations) return res.json({ alreadyUnlocked: true });
      }

      const botToken = process.env.BOT_TOKEN;
      if (!botToken) return res.status(500).json({ error: 'Bot not configured' });

      const sessionId = crypto.randomUUID();
      // Payload format: addon:<skuCode>:<telegramId>:<targetId|_>:<sessionId>
      const payload = `addon:${skuCode}:${req.tgUser!.id}:${targetId ?? '_'}:${sessionId}`;
      const locale = getRequestLocale(req);

      const tg = await createTgInvoiceLink(botToken, {
        title: t(`addon_title_${skuCode}` as any, locale, {}),
        description: t(`addon_desc_${skuCode}` as any, locale, {}),
        payload,
        currency: 'XTR',
        prices: [{ label: t('api_invoice_label', locale), amount: sku.price }],
      });
      if (!tg.ok) {
        if (tg.retryable) {
          logger.warn({ reason: tg.description, skuCode }, 'billing addon createInvoiceLink network failure');
          trackEvent('addon_checkout_failed', user.id, { skuCode, reason: 'tg_network_timeout' });
          return res.status(503).json({ error: 'telegram_unavailable' });
        }
        logger.error({ description: tg.description, skuCode }, 'billing addon createInvoiceLink failed');
        trackEvent('addon_checkout_failed', user.id, { skuCode, reason: tg.description });
        return res.status(502).json({ error: 'Failed to create invoice' });
      }

      // Log invoice_created event
      await prisma.paymentEvent.create({
        data: {
          userId: user.id,
          telegramPaymentChargeId: `addon_checkout_${sessionId}`,
          invoicePayload: payload,
          totalAmount: sku.price,
          currency: 'XTR',
          eventType: 'addon_invoice_created',
        },
      });

      trackEvent('addon_checkout_started', user.id, { skuCode, targetId });
      return res.json({ invoiceUrl: tg.url, sessionId });
    }),
  );

  // POST /tg/billing/addon/sync — return current add-ons and credits after purchase
  billingRouter.post(
    '/billing/addon/sync',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);
      const ent = await getEffectiveEntitlements(user.id, user.godMode);

      const extraWishlistSlots = ent.addOns.filter(a => a.addonType === 'wishlist_slot').reduce((s, a) => s + a.quantity, 0);
      const extraSubscriptionSlots = ent.addOns.filter(a => a.addonType === 'subscription_slot').reduce((s, a) => s + a.quantity, 0);

      return res.json({
        plan: {
          code: ent.plan.code,
          wishlists: ent.effectiveWishlistLimit,
          items: ent.plan.items,
          subscriptions: ent.effectiveSubscriptionLimit,
          participants: ent.plan.participants,
          features: [...ent.plan.features],
        },
        addOns: {
          extraWishlistSlots,
          extraSubscriptionSlots,
          seasonalWishlists: [...ent.seasonalWishlists],
          extraItemsPerWishlist: ent.extraItemsPerWishlist,
        },
        credits: {
          hintCredits: ent.hintCredits,
          importCredits: ent.importCredits,
        },
        reservationPro: hasReservationPro(user, ent.isPro, ent.addOns),
      });
    }),
  );

  // ═══════════════════════════════════════════════════════════════════════════════
  // Gift Notes (Поводы и идеи) — v2: personal gift idea notebook
  // ═══════════════════════════════════════════════════════════════════════════════

  // POST /tg/billing/gift-notes/checkout — one-time unlock
  billingRouter.post(
    '/billing/gift-notes/checkout',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);
      const ent = await getEffectiveEntitlements(user.id, user.godMode);
      if (ent.hasGiftNotes) return res.json({ alreadyUnlocked: true });
      const botToken = process.env.BOT_TOKEN;
      if (!botToken) return res.status(500).json({ error: 'Bot not configured' });
      const sessionId = crypto.randomUUID();
      const payload = `addon:${GIFT_NOTES_SKU}:${req.tgUser!.id}:_:${sessionId}`;
      trackEvent('gift_notes_checkout_started', user.id);
      const tg = await createTgInvoiceLink(botToken, {
        title: 'Gift Notes \uD83C\uDF81',
        description: 'Gift Notes — forever',
        payload, currency: 'XTR',
        prices: [{ label: 'Gift Notes', amount: GIFT_NOTES_PRICE_XTR }],
      });
      if (!tg.ok) {
        trackEvent('gift_notes_checkout_failed', user.id, { reason: tg.retryable ? 'tg_network_timeout' : tg.description });
        return res.status(tg.retryable ? 503 : 502).json({ error: tg.retryable ? 'telegram_unavailable' : 'Failed to create invoice' });
      }
      await prisma.paymentEvent.create({
        data: { userId: user.id, telegramPaymentChargeId: `gn_checkout_${sessionId}`, invoicePayload: payload, totalAmount: GIFT_NOTES_PRICE_XTR, currency: 'XTR', eventType: 'gift_notes_invoice_created' },
      });
      return res.json({ invoiceUrl: tg.url, sessionId });
    }),
  );

  // POST /tg/billing/gift-notes/sync
  billingRouter.post(
    '/billing/gift-notes/sync',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);
      const ent = await getEffectiveEntitlements(user.id, user.godMode);
      return res.json({ giftNotes: ent.giftNotes });
    }),
  );

  return billingRouter;
}
