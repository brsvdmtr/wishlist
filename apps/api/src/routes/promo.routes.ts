// Telegram-auth router for /tg/promo/* endpoints (2 handlers).
// Mounted via `tgRouter.use(promoRouter)` in apps/api/src/index.ts AFTER
// the LIFECYCLE_PROMO_CODE const declaration (TDZ-relocation, see the
// comment at the wiring site). The const is shared with the lifecycle
// scheduler (offerCode field on LifecycleTouch), so it stays in
// index.ts and flows through this router via deps.
//
// Same factory pattern as P4/P5a-e. Handler bodies byte-identical to
// their previous in-place definitions (only `tgRouter.` ->
// `promoRouter.` + indent +2). Two promo-only helpers
// (normalizePromoCode, promoLimiter) migrate WITH this file at module
// scope — verified by grep that each had exactly 1 def + 1 use.
//
// Cross-domain coupling preserved by byte-identical move:
//   - LifecycleTouch attribution writes (promoRedeemedAt /
//     targetCompletedAt) are best-effort `.catch(() => {})` updates;
//     scheduler-side logic is untouched
//   - Item.count read for S2/S3 segment completion gate (winback-check);
//     no item-state mutation
//   - DegradationState deleteMany on activation (best-effort cleanup)
//   - PromoCampaign / PromoRedemption are this domain's own tables
//
// Note: the `// POST /tg/promo/apply ...` line in module-scope below
// is a stale leading comment for the moved POST handler. Kept verbatim
// to preserve the byte-identical move; safe to relocate in a follow-up
// if anyone tidies up the file.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '@wishlist/db';

import logger from '../logger';
import { asyncHandler } from '../lib/asyncHandler';

type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

// Minimal structural shape of the User row that /promo handlers read.
type PromoUser = {
  id: string;
  godMode: boolean;
};

// Minimal structural shape of getUserEntitlement return that /promo reads.
// /promo/apply reads .proSource and .subscription; /promo/winback-check
// reads .isPro. Other fields aren't accessed here.
type PromoEntitlements = {
  isPro: boolean;
  proSource: string | null;
  subscription: Record<string, unknown> | null;
};

export type PromoRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<PromoUser>;
  getUserEntitlement: (userId: string, godMode?: boolean) => Promise<PromoEntitlements>;
  trackEvent: (event: string, userId?: string, props?: Record<string, unknown>) => void;
  // Shared with the lifecycle scheduler in index.ts (offerCode on
  // LifecycleTouch). Stays a closure dep so we don't fork the constant.
  LIFECYCLE_PROMO_CODE: string;
};

// ─── Promo code helpers ──────────────────────────────────────────────────────

/** Normalize promo code input: trim, uppercase, remove spaces and dashes */
function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s\-]/g, '');
}

// POST /tg/promo/apply — apply a promotional code
const promoLimiter = rateLimit({ windowMs: 60_000, limit: 5, keyGenerator: (req: any) => req.tgUser?.id ?? 'anon', standardHeaders: 'draft-7', legacyHeaders: false });

export function registerPromoRouter(deps: PromoRouterDeps): Router {
  const { getOrCreateTgUser, getUserEntitlement, trackEvent, LIFECYCLE_PROMO_CODE } = deps;

  const promoRouter = Router();

  promoRouter.post(
    '/promo/apply',
    promoLimiter,
    asyncHandler(async (req, res) => {
      const parsed = z.object({ code: z.string().min(1).max(50) }).safeParse(req.body);
      if (!parsed.success) return res.status(400).json({ error: 'invalid_code' });
  
      const code = normalizePromoCode(parsed.data.code);
      const user = await getOrCreateTgUser(req.tgUser!);
  
      // 1. Find campaign
      const campaign = await prisma.promoCampaign.findUnique({ where: { code } });
      if (!campaign || !campaign.isActive) {
        return res.status(400).json({ error: 'invalid_code' });
      }
  
      // 2. Check if user already redeemed this campaign
      const existing = await prisma.promoRedemption.findUnique({
        where: { userId_campaignId: { userId: user.id, campaignId: campaign.id } },
      });
  
      if (existing) {
        if (existing.status === 'ACTIVE' && existing.expiresAt && existing.expiresAt > new Date()) {
          // Idempotent: already active
          return res.json({
            status: 'already_active',
            expiresAt: existing.expiresAt.toISOString(),
          });
        }
        if (existing.status === 'ACTIVE' || existing.status === 'EXPIRED' || existing.status === 'ACCEPTED_FOR_PAID') {
          // Already used lifetime
          return res.status(409).json({ error: 'already_used' });
        }
        // PENDING or FAILED — allow retry (PENDING = offered by lifecycle, now redeeming)
      } else {
        // No existing redemption — check eligibility gate
        // WISHPRO is not a public code; only users offered by lifecycle or god mode can redeem
        const isGodMode = user.godMode || false;
        if (!isGodMode) {
          // Allow: onboarding promo, winback reward (after target-step completion)
          const source = (req.body as any)?.source;
          const isSystemPromo = source === 'onboarding' || source === 'winback';
          if (!isSystemPromo) {
            return res.status(403).json({ error: 'not_eligible', message: 'This code can only be used when offered by the system.' });
          }
        }
      }
  
      // 3. Check max redemptions for campaign
      if (campaign.maxRedemptions != null) {
        const count = await prisma.promoRedemption.count({
          where: { campaignId: campaign.id, status: { in: ['ACTIVE', 'EXPIRED', 'ACCEPTED_FOR_PAID'] } },
        });
        if (count >= campaign.maxRedemptions) {
          return res.status(409).json({ error: 'campaign_exhausted' });
        }
      }
  
      // 4. Branch: paid PRO vs FREE user
      const ent = await getUserEntitlement(user.id, user.godMode);
  
      if (ent.proSource === 'subscription' && ent.subscription) {
        // Scenario B: paid PRO user — accept but don't activate promo period
        const redemption = await prisma.promoRedemption.upsert({
          where: { userId_campaignId: { userId: user.id, campaignId: campaign.id } },
          update: { status: 'ACCEPTED_FOR_PAID', attemptedAt: new Date() },
          create: {
            userId: user.id,
            campaignId: campaign.id,
            status: 'ACCEPTED_FOR_PAID',
            attemptedAt: new Date(),
            source: 'miniapp',
          },
        });
  
        trackEvent('promo_accepted_paid_user', user.id, { campaignCode: code });
        return res.json({
          status: 'accepted_for_paid',
          message: 'promo_accepted_paid',
          redemptionId: redemption.id,
        });
      }
  
      // FREE or promo user — activate 30-day promo PRO
      const now = new Date();
      const expiresAt = new Date(now.getTime() + campaign.durationDays * 24 * 60 * 60 * 1000);
  
      try {
        const redemption = await prisma.promoRedemption.upsert({
          where: { userId_campaignId: { userId: user.id, campaignId: campaign.id } },
          update: {
            status: 'ACTIVE',
            activatedAt: now,
            expiresAt,
            failureReason: null,
          },
          create: {
            userId: user.id,
            campaignId: campaign.id,
            status: 'ACTIVE',
            attemptedAt: now,
            activatedAt: now,
            expiresAt,
            source: 'miniapp',
          },
        });
  
        // Clear degradation state if any
        await prisma.degradationState.deleteMany({ where: { userId: user.id } }).catch(() => {});
  
        // Attribution: mark promoRedeemedAt on the lifecycle touch that offered this promo
        if (code === LIFECYCLE_PROMO_CODE) {
          prisma.lifecycleTouch.updateMany({
            where: { userId: user.id, offerCode: LIFECYCLE_PROMO_CODE, promoRedeemedAt: null },
            data: { promoRedeemedAt: now },
          }).catch(() => {});
        }
  
        trackEvent('promo_activated', user.id, { campaignCode: code, expiresAt: expiresAt.toISOString() });
  
        return res.status(201).json({
          status: 'activated',
          expiresAt: expiresAt.toISOString(),
          redemptionId: redemption.id,
        });
      } catch (err) {
        // Technical failure — don't burn the user's right
        logger.error({ err }, 'promo activation error');
        return res.status(500).json({ error: 'activation_failed' });
      }
    }),
  );
  
  // GET /tg/promo/winback-check — check if user qualifies for promo reward after completing target step
  // Called by frontend after item creation/update when user entered via promo deeplink.
  // Returns { eligible: true, segment, promoCode } if conditions met, { eligible: false } otherwise.
  promoRouter.get(
    '/promo/winback-check',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  
      // Find the latest promo-bearing lifecycle touch delivered in last 7 days
      const touch = await prisma.lifecycleTouch.findFirst({
        where: {
          userId: user.id,
          offerCode: LIFECYCLE_PROMO_CODE,
          delivered: true,
          sentAt: { gte: sevenDaysAgo },
          stoppedAt: null,
        },
        orderBy: { sentAt: 'desc' },
      });
      if (!touch || !touch.sentAt) return res.json({ eligible: false });
  
      // Check target step completion
      let completed = false;
      if (touch.segment === 'S2') {
        const items = await prisma.item.count({
          where: { wishlist: { ownerId: user.id, type: 'REGULAR' }, status: { in: ['AVAILABLE', 'RESERVED'] } },
        });
        completed = items > 0;
      } else if (touch.segment === 'S3') {
        // S3: added 2+ new items since touch was sent
        const newItems = await prisma.item.count({
          where: { wishlist: { ownerId: user.id, type: 'REGULAR' }, createdAt: { gte: touch.sentAt }, status: { not: 'DELETED' } },
        });
        completed = newItems >= 2;
      }
  
      if (!completed) return res.json({ eligible: false });
  
      // Check if user already has active promo or is already PRO
      const ent = await getUserEntitlement(user.id);
      if (ent.isPro) return res.json({ eligible: false, reason: 'already_pro' });
  
      const existingPromo = await prisma.promoRedemption.findFirst({
        where: { userId: user.id, status: { in: ['ACTIVE', 'EXPIRED', 'ACCEPTED_FOR_PAID'] } },
      });
      if (existingPromo) return res.json({ eligible: false, reason: 'already_used' });
  
      // Mark target completed if not already
      if (!touch.targetCompletedAt) {
        await prisma.lifecycleTouch.update({
          where: { id: touch.id },
          data: {
            targetCompletedAt: new Date(),
            targetCompletedType: touch.segment === 'S2' ? 'added_item' : 'added_more_wishes',
          },
        }).catch(() => {});
      }
  
      trackEvent('promo_winback_eligible', user.id, { segment: touch.segment, touchNumber: touch.touchNumber });
  
      return res.json({
        eligible: true,
        segment: touch.segment,
        promoCode: LIFECYCLE_PROMO_CODE,
      });
    }),
  );

  return promoRouter;
}
