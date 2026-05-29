// Admin router (legacy /wishlists, /items, /admin/referral/*) — gated
// by the `X-ADMIN-KEY` header. Mounted as `app.use(adminRouter)` (no prefix —
// the prefixes live on each handler) in apps/api/src/index.ts.
//
// Same factory pattern as ./internal.routes: handler bodies are byte-identical
// to their previous in-place definitions; module-level locals from index.ts
// (zod schemas, trackAnalyticsEvent, reassignPrimaryBeforeWishlistDelete,
// notifyReferralInviterRewarded) are passed via `deps` and destructured at
// the top so handler bodies do not need any `deps.X` rewriting.
//
// requireAdmin and getSystemUser live here permanently — both used only by
// this router.

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { prisma, Prisma, processReward, tryQualifyAttribution, sweepExpiredPendingAttributions, loadReferralConfig, invalidateReferralConfigCache } from '@wishlist/db';

import { asyncHandler } from '../lib/asyncHandler';
import { zodError } from '../lib/http';
import { secureCompare } from '../lib/crypto';
import { reconcileBilling } from '../services/billing-reconciliation';
import { generateUniqueSlug } from '../wishlists/slug';
import { ensureItemPlacement } from '../placements/ensureItemPlacement';

export type AdminRouterDeps = {
  ItemStatusSchema: z.ZodTypeAny;
  PrioritySchema: z.ZodTypeAny;
  zUrl: () => z.ZodTypeAny;
  reassignPrimaryBeforeWishlistDelete: (wishlistId: string) => Promise<void>;
  trackAnalyticsEvent: (params: { event: string; userId?: string; props?: Record<string, unknown> }) => void;
  notifyReferralInviterRewarded: (inviterUserId: string, daysGranted: number) => Promise<void>;
};

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const adminKey = process.env.ADMIN_KEY;
  if (!adminKey) {
    return res.status(500).json({ error: 'ADMIN_KEY is not configured' });
  }

  const provided = req.get('X-ADMIN-KEY');
  if (!provided || !secureCompare(provided, adminKey)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

async function getSystemUser() {
  const email = (process.env.SYSTEM_USER_EMAIL ?? 'owner@local').trim() || 'owner@local';
  return prisma.user.upsert({ where: { email }, update: {}, create: { email } });
}

export function registerAdminRouter(deps: AdminRouterDeps): Router {
  const {
    ItemStatusSchema,
    PrioritySchema,
    zUrl,
    reassignPrimaryBeforeWishlistDelete,
    trackAnalyticsEvent,
    notifyReferralInviterRewarded,
  } = deps;

  const privateRouter = Router();

  // --- Private endpoints (admin auth)
  privateRouter.use(requireAdmin);

  privateRouter.post(
    '/wishlists',
    asyncHandler(async (req, res) => {
      const parsed = z
        .object({
          title: z.string().min(1).max(200),
          description: z.string().max(2000).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      const owner = await getSystemUser();
      const slug = await generateUniqueSlug(parsed.data.title);

      const wishlist = await prisma.wishlist.create({
        data: {
          slug,
          ownerId: owner.id,
          title: parsed.data.title,
          description: parsed.data.description ?? null,
        },
        select: { id: true, slug: true, title: true, description: true, deadline: true },
      });

      return res.status(201).json({ wishlist });
    }),
  );

  privateRouter.patch(
    '/wishlists/:id',
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      if (!id) return res.status(400).json({ error: 'Missing wishlist id' });
      const parsed = z
        .object({
          title: z.string().min(1).max(200).optional(),
          description: z.string().max(2000).nullable().optional(),
        })
        .refine((v) => v.title !== undefined || v.description !== undefined, {
          message: 'At least one field is required',
        })
        .safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      try {
        const wishlist = await prisma.wishlist.update({
          where: { id },
          data: {
            ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
            ...(parsed.data.description !== undefined
              ? { description: parsed.data.description }
              : {}),
          },
          select: { id: true, slug: true, title: true, description: true, deadline: true },
        });
        return res.json({ wishlist });
      } catch {
        return res.status(404).json({ error: 'Wishlist not found' });
      }
    }),
  );

  privateRouter.delete(
    '/wishlists/:id',
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      if (!id) return res.status(400).json({ error: 'Missing wishlist id' });
      try {
        // Preserve shared wishes placed elsewhere before cascade-deleting this wishlist.
        await reassignPrimaryBeforeWishlistDelete(id);
        await prisma.wishlist.delete({ where: { id } });
        return res.json({ ok: true });
      } catch {
        return res.status(404).json({ error: 'Wishlist not found' });
      }
    }),
  );

  privateRouter.post(
    '/wishlists/:id/items',
    asyncHandler(async (req, res) => {
      const wishlistId = req.params.id ?? '';
      if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });
      const parsed = z
        .object({
          title: z.string().min(1).max(200),
          url: z.string().url(),
          priceText: z.string().max(200).optional(),
          commentOwner: z.string().max(2000).optional(),
          priority: PrioritySchema.optional(),
          deadline: z.string().datetime().optional(),
          imageUrl: z.string().url().optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      const wishlist = await prisma.wishlist.findUnique({
        where: { id: wishlistId },
        select: { id: true },
      });
      if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });

      const item = await prisma.item.create({
        data: {
          wishlistId,
          title: parsed.data.title,
          url: parsed.data.url,
          priceText: parsed.data.priceText ?? null,
          commentOwner: parsed.data.commentOwner ?? null,
          priority: parsed.data.priority ?? 'MEDIUM',
          deadline: parsed.data.deadline ? new Date(parsed.data.deadline) : null,
          imageUrl: parsed.data.imageUrl ?? null,
        },
        select: {
          id: true, wishlistId: true, title: true, url: true, priceText: true,
          commentOwner: true, priority: true, deadline: true, imageUrl: true,
          status: true, createdAt: true, updatedAt: true,
        },
      });
      // Dual-write: mirror into WishlistItemPlacement for shared-wish migration.
      await ensureItemPlacement(prisma, { wishlistId, itemId: item.id });

      return res.status(201).json({ item });
    }),
  );

  privateRouter.patch(
    '/items/:id',
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      if (!id) return res.status(400).json({ error: 'Missing item id' });
      const parsed = z
        .object({
          title: z.string().min(1).max(200).optional(),
          url: zUrl().optional(),
          priceText: z.string().max(200).nullable().optional(),
          commentOwner: z.string().max(2000).nullable().optional(),
          priority: PrioritySchema.optional(),
          deadline: z.string().datetime().nullable().optional(),
          imageUrl: z.string().url().nullable().optional(),
          status: ItemStatusSchema.optional(),
        })
        .refine(
          (v) =>
            v.title !== undefined || v.url !== undefined || v.priceText !== undefined ||
            v.commentOwner !== undefined || v.priority !== undefined || v.deadline !== undefined ||
            v.imageUrl !== undefined || v.status !== undefined,
          { message: 'At least one field is required' },
        )
        .safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      try {
        const item = await prisma.item.update({
          where: { id },
          data: {
            ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
            ...(parsed.data.url !== undefined ? { url: parsed.data.url } : {}),
            ...(parsed.data.priceText !== undefined ? { priceText: parsed.data.priceText } : {}),
            ...(parsed.data.commentOwner !== undefined ? { commentOwner: parsed.data.commentOwner } : {}),
            ...(parsed.data.priority !== undefined ? { priority: parsed.data.priority } : {}),
            ...(parsed.data.deadline !== undefined
              ? { deadline: parsed.data.deadline ? new Date(parsed.data.deadline) : null }
              : {}),
            ...(parsed.data.imageUrl !== undefined ? { imageUrl: parsed.data.imageUrl } : {}),
            ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
          },
          select: {
            id: true, wishlistId: true, title: true, url: true, priceText: true,
            commentOwner: true, priority: true, deadline: true, imageUrl: true,
            status: true, createdAt: true, updatedAt: true,
          },
        });
        return res.json({ item });
      } catch {
        return res.status(404).json({ error: 'Item not found' });
      }
    }),
  );

  privateRouter.delete(
    '/items/:id',
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      if (!id) return res.status(400).json({ error: 'Missing item id' });
      try {
        await prisma.item.delete({ where: { id } });
        return res.json({ ok: true });
      } catch {
        return res.status(404).json({ error: 'Item not found' });
      }
    }),
  );

  // ═══════════════════════════════════════════════════════
  // REFERRAL ADMIN ENDPOINTS (auth: X-ADMIN-KEY)
  // ═══════════════════════════════════════════════════════
  //
  // Observability + runbook surface for the referral program. All endpoints
  // are mounted on privateRouter, so requireAdmin middleware gates them via
  // the shared ADMIN_KEY env var. Pairs with the SQL runbook in
  // docs/referral-runbook.md for queries that don't need an HTTP endpoint.

  // GET /admin/referral/trace/:attributionId
  // Full debug trace for a single attribution — status timeline, fraud signals,
  // config snapshot frozen at attribution time, and any rewards it produced.
  // Used by support to explain "why wasn't my reward granted?" cases without
  // opening a psql session.
  privateRouter.get(
    '/admin/referral/trace/:attributionId',
    asyncHandler(async (req, res) => {
      const id = req.params.attributionId ?? '';
      if (!id) return res.status(400).json({ error: 'Missing attribution id' });
      const att = await prisma.referralAttribution.findUnique({
        where: { id },
        include: {
          inviter: { select: { id: true, telegramId: true, createdAt: true, profile: { select: { referralCode: true, displayName: true } } } },
          invited: { select: { id: true, telegramId: true, createdAt: true, profile: { select: { firstBotStartAt: true, firstWishlistAt: true, firstItemAt: true, referredAt: true, displayName: true } } } },
          rewards: {
            select: { id: true, status: true, rewardValueDays: true, grantStrategy: true, previousExpiryAt: true, newExpiryAt: true, idempotencyKey: true, grantedAt: true, revokedAt: true, revokedReason: true, grantedByAdminId: true, revokedByAdminId: true },
            orderBy: { grantedAt: 'desc' },
          },
        },
      });
      if (!att) return res.status(404).json({ error: 'Attribution not found' });

      // Build a status-transition timeline from the stored per-transition
      // timestamps. Ordered chronologically — caller gets a replay of the
      // attribution's lifecycle in one array.
      const transitions: Array<{ status: string; at: string }> = [];
      transitions.push({ status: 'ATTRIBUTED', at: att.attributedAt.toISOString() });
      if (att.qualifiedAt) transitions.push({ status: 'QUALIFIED', at: att.qualifiedAt.toISOString() });
      if (att.rewardedAt) transitions.push({ status: 'REWARDED', at: att.rewardedAt.toISOString() });
      if (att.rejectedAt) transitions.push({ status: `REJECTED:${att.rejectReason ?? '?'}`, at: att.rejectedAt.toISOString() });

      return res.json({
        attribution: {
          id: att.id,
          status: att.status,
          rejectReason: att.rejectReason,
          referralCode: att.referralCode,
          source: att.source,
          attributedAt: att.attributedAt.toISOString(),
          qualifiedAt: att.qualifiedAt?.toISOString() ?? null,
          rewardedAt: att.rewardedAt?.toISOString() ?? null,
          rejectedAt: att.rejectedAt?.toISOString() ?? null,
          windowDeadlineAt: att.windowDeadlineAt.toISOString(),
          fraudScore: att.fraudScore,
          triggeredSignals: att.triggeredSignals,
          configVersion: att.configVersion,
          configSnapshot: att.configSnapshot,
          // Hashes are safe to surface in admin context (already PII-scrubbed).
          ipHash: att.ipHash,
          deviceFingerprintHash: att.deviceFingerprintHash,
          timezone: att.timezone,
          locale: att.locale,
          telegramClient: att.telegramClient,
          platform: att.platform,
        },
        inviter: att.inviter,
        invitee: att.invited,
        rewards: att.rewards.map((r) => ({
          ...r,
          previousExpiryAt: r.previousExpiryAt?.toISOString() ?? null,
          newExpiryAt: r.newExpiryAt?.toISOString() ?? null,
          grantedAt: r.grantedAt.toISOString(),
          revokedAt: r.revokedAt?.toISOString() ?? null,
        })),
        transitions,
      });
    }),
  );

  // GET /admin/referral/trace/by-user/:userId
  // Convenience: returns both sides of the referral graph for one user —
  // the attribution where they were the invitee (if any) plus the attributions
  // they created as inviter (paginated, newest-first). Answers "show me
  // everything about user X's referral activity" in one call.
  privateRouter.get(
    '/admin/referral/trace/by-user/:userId',
    asyncHandler(async (req, res) => {
      const userId = req.params.userId ?? '';
      if (!userId) return res.status(400).json({ error: 'Missing user id' });
      const [asInvitee, asInviter, rewards, profile] = await Promise.all([
        prisma.referralAttribution.findUnique({
          where: { invitedUserId: userId },
          select: { id: true, inviterUserId: true, referralCode: true, status: true, rejectReason: true, attributedAt: true, qualifiedAt: true, rewardedAt: true, rejectedAt: true, fraudScore: true },
        }),
        prisma.referralAttribution.findMany({
          where: { inviterUserId: userId },
          select: { id: true, invitedUserId: true, referralCode: true, status: true, rejectReason: true, attributedAt: true, qualifiedAt: true, rewardedAt: true, fraudScore: true },
          orderBy: { attributedAt: 'desc' },
          take: 50,
        }),
        prisma.referralReward.findMany({
          where: { userId },
          select: { id: true, attributionId: true, status: true, rewardValueDays: true, grantedAt: true, revokedAt: true, revokedReason: true },
          orderBy: { grantedAt: 'desc' },
          take: 50,
        }),
        prisma.userProfile.findUnique({
          where: { userId },
          select: { referralCode: true, referralCodeCreatedAt: true, referredByUserId: true, referredAt: true, firstBotStartAt: true, firstWishlistAt: true, firstItemAt: true },
        }),
      ]);
      return res.json({ userId, profile, asInvitee, asInviter, rewards });
    }),
  );

  // GET /admin/referral/funnel
  // Aggregate funnel counts for a time window. Default = last 30 days.
  // Query: ?since=<iso>&until=<iso>
  // Returns each stage + step-to-step conversion ratios. Backed by single GROUP BY
  // passes on indexed columns so it runs fast even on large tables.
  privateRouter.get(
    '/admin/referral/funnel',
    asyncHandler(async (req, res) => {
      const DAY_MS = 86_400_000;
      const now = new Date();
      const parseDate = (raw: unknown, fallback: Date): Date => {
        if (typeof raw !== 'string' || !raw) return fallback;
        const d = new Date(raw);
        return Number.isNaN(d.getTime()) ? fallback : d;
      };
      const since = parseDate(req.query.since, new Date(now.getTime() - 30 * DAY_MS));
      const until = parseDate(req.query.until, now);

      const rangeFilter = { attributedAt: { gte: since, lt: until } };

      const [statusCounts, rejectReasonCounts, rewardAgg] = await Promise.all([
        prisma.referralAttribution.groupBy({
          by: ['status'],
          where: rangeFilter,
          _count: { _all: true },
        }),
        prisma.referralAttribution.groupBy({
          by: ['rejectReason'],
          where: { ...rangeFilter, rejectReason: { not: null } },
          _count: { _all: true },
        }),
        prisma.referralReward.aggregate({
          where: { grantedAt: { gte: since, lt: until }, status: 'GRANTED' },
          _count: { _all: true },
          _sum: { rewardValueDays: true },
        }),
      ]);

      const byStatus: Record<string, number> = {
        ATTRIBUTED: 0, PENDING_ACTIVATION: 0, QUALIFIED: 0, REWARDED: 0, REJECTED: 0, FRAUD_REVIEW: 0,
      };
      for (const r of statusCounts) byStatus[r.status] = r._count._all;

      const totalAttributed = Object.values(byStatus).reduce((a, b) => a + b, 0);
      const reachedQualified = byStatus.QUALIFIED! + byStatus.REWARDED!;
      const reachedRewarded = byStatus.REWARDED!;

      // Conversion ratios — guarded against division by zero. All fractions
      // rounded to 4 decimals so dashboards render readable numbers.
      const pct = (n: number, d: number) => d === 0 ? 0 : Math.round((n / d) * 10000) / 10000;

      return res.json({
        window: { since: since.toISOString(), until: until.toISOString() },
        attributions: {
          total: totalAttributed,
          byStatus,
        },
        rejectReasons: Object.fromEntries(
          rejectReasonCounts.map((r) => [r.rejectReason ?? 'UNKNOWN', r._count._all]),
        ),
        rewards: {
          count: rewardAgg._count._all,
          totalDaysGranted: rewardAgg._sum.rewardValueDays ?? 0,
        },
        conversions: {
          attributed_to_qualified: pct(reachedQualified, totalAttributed),
          attributed_to_rewarded: pct(reachedRewarded, totalAttributed),
          qualified_to_rewarded: pct(reachedRewarded, reachedQualified),
        },
      });
    }),
  );

  // GET /admin/referral/fraud-review
  // List attributions parked in FRAUD_REVIEW state, newest-first. Payload
  // includes the stored signals and weights so an admin can decide without
  // a separate lookup. Paged with keyset on (fraudScore DESC, id DESC) —
  // highest-risk surfaces first.
  privateRouter.get(
    '/admin/referral/fraud-review',
    asyncHandler(async (req, res) => {
      const querySchema = z.object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
      });
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) return zodError(res, parsed.error);
      const limit = parsed.data.limit ?? 50;

      const rows = await prisma.referralAttribution.findMany({
        where: { status: 'FRAUD_REVIEW' },
        orderBy: [{ fraudScore: 'desc' }, { id: 'desc' }],
        take: limit,
        select: {
          id: true, fraudScore: true, triggeredSignals: true,
          attributedAt: true, qualifiedAt: true, windowDeadlineAt: true,
          referralCode: true, ipHash: true, deviceFingerprintHash: true,
          inviter: { select: { id: true, telegramId: true } },
          invited: { select: { id: true, telegramId: true } },
        },
      });
      return res.json({
        items: rows.map((r) => ({
          ...r,
          attributedAt: r.attributedAt.toISOString(),
          qualifiedAt: r.qualifiedAt?.toISOString() ?? null,
          windowDeadlineAt: r.windowDeadlineAt.toISOString(),
        })),
        count: rows.length,
      });
    }),
  );

  // POST /admin/referral/fraud-review/:id/resolve
  // Admin decision on a FRAUD_REVIEW attribution. `decision: "approve"` grants
  // the reward (via processReward); `decision: "reject"` marks it REJECTED
  // with FRAUD_REJECTED. Either way, analytics event fires for audit trail.
  privateRouter.post(
    '/admin/referral/fraud-review/:id/resolve',
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      if (!id) return res.status(400).json({ error: 'Missing attribution id' });
      const parsed = z.object({
        decision: z.enum(['approve', 'reject']),
        adminNote: z.string().max(500).optional(),
      }).safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      const att = await prisma.referralAttribution.findUnique({
        where: { id },
        select: { id: true, status: true, inviterUserId: true, fraudScore: true },
      });
      if (!att) return res.status(404).json({ error: 'Attribution not found' });
      if (att.status !== 'FRAUD_REVIEW') {
        return res.status(409).json({ error: `Attribution not in FRAUD_REVIEW (current: ${att.status})` });
      }

      if (parsed.data.decision === 'reject') {
        await prisma.referralAttribution.update({
          where: { id },
          data: { status: 'REJECTED', rejectReason: 'FRAUD_REJECTED', rejectedAt: new Date() },
        });
        // Two events: fraud_resolved is the audit trail for the admin action;
        // referral.rejected keeps the terminal-state funnel dashboard consistent
        // (parallel to auto_rejected / cap_rejected emissions in runReferralProgressHook).
        trackAnalyticsEvent({
          event: 'referral.fraud_resolved',
          userId: att.inviterUserId,
          props: { attributionId: id, decision: 'reject', adminNote: parsed.data.adminNote ?? null, fraudScore: att.fraudScore },
        });
        trackAnalyticsEvent({
          event: 'referral.rejected',
          userId: att.inviterUserId,
          props: { attributionId: id, reason: 'FRAUD_REJECTED', source: 'admin_review', fraudScore: att.fraudScore },
        });
        return res.json({ ok: true, decision: 'reject' });
      }

      // Approve path: force the attribution back to QUALIFIED, then call
      // processReward with skipFraudCheck=true. Without the flag, fresh fraud
      // scoring would just bounce the attribution right back into FRAUD_REVIEW
      // (infinite loop). Cap check still runs — admin overrides fraud, not
      // spending limits.
      await prisma.referralAttribution.update({
        where: { id },
        data: { status: 'QUALIFIED' },
      });
      const decision = await processReward(prisma, id, { skipFraudCheck: true });
      trackAnalyticsEvent({
        event: 'referral.fraud_resolved',
        userId: att.inviterUserId,
        props: { attributionId: id, decision: 'approve', adminNote: parsed.data.adminNote ?? null, fraudScore: att.fraudScore, rewardResult: decision.kind },
      });
      return res.json({ ok: true, decision: 'approve', reward: decision });
    }),
  );

  // POST /admin/referral/reward/:id/revoke
  // Revoke a granted reward. Marks the ReferralReward row REVOKED with a
  // reason + admin id, but does NOT touch the Subscription (a day-grant that
  // was already consumed is consumed). For clawback, adjust subscription
  // manually via /wishlists admin endpoints or psql.
  privateRouter.post(
    '/admin/referral/reward/:id/revoke',
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      if (!id) return res.status(400).json({ error: 'Missing reward id' });
      const parsed = z.object({
        reason: z.string().min(1).max(500),
        adminId: z.string().max(200).optional(),
      }).safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      const existing = await prisma.referralReward.findUnique({
        where: { id },
        select: { id: true, status: true, userId: true, attributionId: true, rewardValueDays: true },
      });
      if (!existing) return res.status(404).json({ error: 'Reward not found' });
      if (existing.status === 'REVOKED') {
        return res.status(409).json({ error: 'Reward already revoked' });
      }

      await prisma.referralReward.update({
        where: { id },
        data: {
          status: 'REVOKED',
          revokedAt: new Date(),
          revokedReason: parsed.data.reason,
          revokedByAdminId: parsed.data.adminId ?? null,
        },
      });
      trackAnalyticsEvent({
        event: 'referral.reward_revoked',
        userId: existing.userId,
        props: { rewardId: id, attributionId: existing.attributionId, days: existing.rewardValueDays, reason: parsed.data.reason, adminId: parsed.data.adminId ?? null },
      });
      return res.json({ ok: true });
    }),
  );

  // GET /admin/referral/config — full config row
  // PATCH /admin/referral/config — partial update + cache invalidation
  //
  // Admin operates on the singleton `default` row. PATCH accepts a subset of
  // fields; anything missing is left untouched. After any write we call
  // invalidateReferralConfigCache() so the next request sees the new value
  // without waiting for the 60s TTL.
  privateRouter.get(
    '/admin/referral/config',
    asyncHandler(async (_req, res) => {
      const config = await loadReferralConfig(prisma);
      return res.json({ config });
    }),
  );

  privateRouter.patch(
    '/admin/referral/config',
    asyncHandler(async (req, res) => {
      const parsed = z.object({
        enabled: z.boolean().optional(),
        rewardDaysInviter: z.number().int().min(1).max(365).optional(),
        grantStrategy: z.enum(['stack', 'replace']).optional(),
        requireWishlist: z.boolean().optional(),
        requireItem: z.boolean().optional(),
        qualificationWindowDays: z.number().int().min(1).max(90).optional(),
        monthlyRewardCap: z.number().int().min(0).max(1000).optional(),
        yearlyRewardCap: z.number().int().min(0).max(10000).optional(),
        fraudAutoRejectThreshold: z.number().int().min(0).max(100).optional(),
        fraudReviewThreshold: z.number().int().min(0).max(100).optional(),
        fraudReviewEnabled: z.boolean().optional(),
        fraudSignalWeights: z.record(z.string(), z.number().int().min(0).max(100)).optional(),
        showInviteeNamesInUi: z.boolean().optional(),
        entryPointProfile: z.boolean().optional(),
        entryPointPaywall: z.boolean().optional(),
        entryPointHomeBanner: z.boolean().optional(),
        entryPointPostShare: z.boolean().optional(),
        notifyInviterArrival: z.boolean().optional(),
        notifyInviterStepProgress: z.boolean().optional(),
        notifyInviterReward: z.boolean().optional(),
        notifyInviteeWelcome: z.boolean().optional(),
        rolloutPercent: z.number().int().min(0).max(100).optional(),
        configVersion: z.string().max(64).optional(),
        updatedByAdminId: z.string().max(200).optional(),
      }).safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      // Sanity: reviewThreshold should not exceed autoRejectThreshold. If the
      // admin sends both and they cross, reject — otherwise we'd silently
      // create a dead zone where no fraud review fires.
      const existing = await loadReferralConfig(prisma);
      const reviewT = parsed.data.fraudReviewThreshold ?? existing.fraudReviewThreshold;
      const autoT = parsed.data.fraudAutoRejectThreshold ?? existing.fraudAutoRejectThreshold;
      if (reviewT > autoT) {
        return res.status(400).json({ error: 'fraudReviewThreshold must be <= fraudAutoRejectThreshold' });
      }

      const data: Prisma.ReferralProgramConfigUpdateInput = {
        ...parsed.data,
        fraudSignalWeights: parsed.data.fraudSignalWeights as Prisma.InputJsonValue | undefined,
        updatedAt: new Date(),
      };
      const updated = await prisma.referralProgramConfig.update({
        where: { id: 'default' },
        data,
      });
      invalidateReferralConfigCache();
      trackAnalyticsEvent({
        event: 'referral.config_changed',
        props: { fields: Object.keys(parsed.data), adminId: parsed.data.updatedByAdminId ?? null, configVersion: updated.configVersion },
      });
      return res.json({ config: updated });
    }),
  );

  // POST /admin/referral/attribution/:id/retry-qualify
  // Manual healer for attributions stuck in PENDING_ACTIVATION despite the
  // invitee meeting the criteria. Scenarios:
  //  • Historical bug where a milestone endpoint didn't fire runReferralProgressHook
  //    (e.g. onboarding create-wishlist before we added the hook).
  //  • Operator manually set firstWishlistAt/firstItemAt to correct a stuck state.
  // Runs the same pipeline as the normal qualify path: tryQualifyAttribution
  // (requires milestones now) + processReward (fraud + cap + grant).
  privateRouter.post(
    '/admin/referral/attribution/:id/retry-qualify',
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      if (!id) return res.status(400).json({ error: 'Missing attribution id' });
      const att = await prisma.referralAttribution.findUnique({
        where: { id },
        select: { id: true, invitedUserId: true, inviterUserId: true, status: true },
      });
      if (!att) return res.status(404).json({ error: 'Attribution not found' });
      if (att.status !== 'PENDING_ACTIVATION') {
        return res.status(409).json({ error: `Attribution not in PENDING_ACTIVATION (current: ${att.status})` });
      }
      const qualified = await tryQualifyAttribution(prisma, att.invitedUserId);
      if (qualified.kind !== 'qualified') {
        return res.json({ ok: false, qualifyResult: qualified });
      }
      trackAnalyticsEvent({
        event: 'referral.qualified',
        userId: att.invitedUserId,
        props: { attributionId: att.id, inviterUserId: att.inviterUserId, source: 'admin_retry' },
      });
      const decision = await processReward(prisma, qualified.attributionId);
      if (decision.kind === 'rewarded') {
        trackAnalyticsEvent({
          event: 'referral.rewarded',
          userId: att.inviterUserId,
          props: {
            attributionId: qualified.attributionId,
            rewardId: decision.rewardId,
            daysGranted: decision.daysGranted,
            newExpiryAt: decision.newExpiryAt.toISOString(),
            source: 'admin_retry',
          },
        });
        trackAnalyticsEvent({
          event: 'referral.pro_subscription_extended',
          userId: att.inviterUserId,
          props: { attributionId: qualified.attributionId, daysGranted: decision.daysGranted, source: 'admin_retry' },
        });
        void notifyReferralInviterRewarded(att.inviterUserId, decision.daysGranted);
      }
      return res.json({ ok: true, qualifyResult: qualified, rewardResult: decision });
    }),
  );

  // POST /admin/referral/sweep
  // Manual trigger for the expired-attribution sweeper. Cron will typically
  // run this every 15 min via a scheduled job; this endpoint lets an admin
  // force it from a runbook during incident response.
  privateRouter.post(
    '/admin/referral/sweep',
    asyncHandler(async (_req, res) => {
      const result = await sweepExpiredPendingAttributions(prisma);
      trackAnalyticsEvent({
        event: 'referral.qualification_timeout',
        props: { expired: result.expired, source: 'admin_sweep' },
      });
      return res.json({ ok: true, result });
    }),
  );

  // GET /admin/billing/reconcile
  // Read-only cross-table billing reconciliation (PaymentEvent / Subscription
  // / Purchase). Lets an operator inspect discrepancies without SSH. The
  // report contains only opaque internal ids + hashed charge ids — never raw
  // payment identifiers or user PII. Mutations (the safe relink backfill) are
  // intentionally CLI-only (`pnpm billing:reconcile -- --apply`); a GET must
  // stay side-effect-free. Full runbook: docs/ops/billing-reconciliation.md.
  //   • idempotency: n/a (read-only GET)
  //   • rate limit: admin-gated (X-ADMIN-KEY) + bounded by DEFAULT_MAX_SCAN_ROWS
  //     (the service refuses oversized in-memory scans) — no dedicated category
  //   • analytics: admin.billing_reconcile_viewed (counts only, no PII)
  privateRouter.get(
    '/admin/billing/reconcile',
    asyncHandler(async (_req, res) => {
      const report = await reconcileBilling(prisma);
      trackAnalyticsEvent({
        event: 'admin.billing_reconcile_viewed',
        props: {
          findings: report.findings.length,
          high: report.bySeverity.high,
          medium: report.bySeverity.medium,
          low: report.bySeverity.low,
          scanned:
            report.scanned.paymentEvents + report.scanned.subscriptions + report.scanned.purchases,
        },
      });
      return res.json(report);
    }),
  );

  return privateRouter;
}
