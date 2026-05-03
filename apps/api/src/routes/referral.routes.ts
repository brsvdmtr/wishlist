// Telegram-auth router for /tg/referral/* endpoints (4 read-only GETs).
// Mounted via `tgRouter.use(refRouter)` in apps/api/src/index.ts immediately
// after `tgRouter.use(meRouter)` (and after the protectTgRoute() chain) —
// referral has no path-scoped idempotency middleware (all GETs), so the
// ordering vs protectTgRoute() is informational only.
//
// Same factory pattern as P4/P5a: handler bodies byte-identical to their
// previous in-place definitions. The 4 helpers (referralStatusCounts,
// referralCapsSnapshot, buildReferralLink, buildReferralShareText) and 2
// types (ReferralConfigRow, ReferralStatusCounts) plus the
// REFERRAL_BOT_USERNAME constant migrate WITH this router because grep
// confirmed they were used only by these handlers in index.ts.
//
// Closure-only deps (kept in `deps` because each is shared across many
// other domains): getOrCreateTgUser, trackAnalyticsEvent, PRO_PLAN_CODE.

import { Router } from 'express';
import { z } from 'zod';
import {
  prisma,
  loadReferralConfig,
  ensureReferralCode,
  isInRollout,
  checkRewardCap,
  REWARD_CAP_MONTHLY_WINDOW_DAYS,
  REWARD_CAP_YEARLY_WINDOW_DAYS,
} from '@wishlist/db';

import logger from '../logger';
import { asyncHandler } from '../lib/asyncHandler';
import { zodError } from '../lib/http';

// Shape of the Telegram initData user — duplicated structurally to avoid
// coupling routes/* to a non-exported type in index.ts.
type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

// Minimal structural shape of the User row that referral handlers read.
// Only `.id` is consumed in this router; widened types from the runtime
// upsert are accepted via subtyping.
type RefUser = {
  id: string;
};

export type RefRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<RefUser>;
  trackAnalyticsEvent: (params: { event: string; userId?: string; props?: Record<string, unknown> }) => void;
  PRO_PLAN_CODE: string;
};

// ─── Referral program — user-facing API ──────────────────────────────────────
// Endpoints (all auth-gated via tgRouter):
//   GET /tg/referral/me             — inviter code + quick stats + reward caps
//   GET /tg/referral/history        — cursor-paged list of this user's invitees
//   GET /tg/referral/stats          — richer aggregated counters + lifetime reward days
//   GET /tg/referral/rules-config   — program config snapshot (safe public subset)
//
// Design choices:
// • `/me` ensures a referralCode only when the program is active for the user
//   (config.enabled AND isInRollout). Otherwise it reads whatever's persisted.
// • PII guard: invitee display names are gated by config.showInviteeNamesInUi.
// • Pagination: keyset on (attributedAt DESC, id DESC) so inserts at head are
//   stable for an open session.

// Must match the actual Telegram bot username (without @) for deep links.
// Prefer TELEGRAM_BOT_USERNAME (container-specific) over NEXT_PUBLIC_BOT_USERNAME
// (shared with web). Fallback keeps dev working; prod MUST set the env var.
const REFERRAL_BOT_USERNAME =
  process.env.TELEGRAM_BOT_USERNAME
  ?? process.env.NEXT_PUBLIC_BOT_USERNAME
  ?? 'WishHub_bot';

type ReferralConfigRow = Awaited<ReturnType<typeof loadReferralConfig>>;

type ReferralStatusCounts = {
  /** Legacy pre-Slice-2 default; treat as PENDING_ACTIVATION. Should have 0 rows after migration. */
  ATTRIBUTED: number;
  PENDING_ACTIVATION: number;
  QUALIFIED: number;
  REWARDED: number;
  REJECTED: number;
  FRAUD_REVIEW: number;
};

/** Aggregate ReferralAttribution.status counts for a given inviter. Zero-filled. */
async function referralStatusCounts(inviterUserId: string): Promise<ReferralStatusCounts> {
  const rows = await prisma.referralAttribution.groupBy({
    by: ['status'],
    where: { inviterUserId },
    _count: { _all: true },
  });
  const counts: ReferralStatusCounts = {
    ATTRIBUTED: 0,
    PENDING_ACTIVATION: 0,
    QUALIFIED: 0,
    REWARDED: 0,
    REJECTED: 0,
    FRAUD_REVIEW: 0,
  };
  for (const r of rows) counts[r.status] = r._count._all;
  return counts;
}

/** Build the PRO deep-link referral URL for a given code. */
function buildReferralLink(code: string): string {
  return `https://t.me/${REFERRAL_BOT_USERNAME}?start=ref_${code}`;
}

/**
 * Build the share text in Russian. The frontend may override for i18n, but
 * we return a ready-to-paste string so share-sheet flows work without a round-trip.
 */
function buildReferralShareText(code: string, daysPerRef: number): string {
  const link = buildReferralLink(code);
  return `Присоединяйся к WishBoard по моей ссылке — получим по ${daysPerRef} дней PRO каждому 🎁\n${link}`;
}

/** Lightweight cap snapshot for UI "3/3 used this month" display. */
async function referralCapsSnapshot(userId: string, config: ReferralConfigRow) {
  const cap = await checkRewardCap(prisma, userId);
  return {
    monthlyUsed: cap.monthlyUsed,
    monthlyCap: config.monthlyRewardCap,
    yearlyUsed: cap.yearlyUsed,
    yearlyCap: config.yearlyRewardCap,
    atMonthlyCap: cap.monthlyUsed >= config.monthlyRewardCap,
    atYearlyCap: cap.yearlyUsed >= config.yearlyRewardCap,
  };
}

export function registerRefRouter(deps: RefRouterDeps): Router {
  const { getOrCreateTgUser, trackAnalyticsEvent, PRO_PLAN_CODE } = deps;

  const refRouter = Router();
  
  // GET /tg/referral/me — inviter code + stats summary + reward caps snapshot
  refRouter.get(
    '/referral/me',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);
      const config = await loadReferralConfig(prisma);
      const inRollout = isInRollout(user.id, config.rolloutPercent);
      const programActive = config.enabled && inRollout;
  
      // Ensure a code only when the program is live for this user.
      // For out-of-rollout or disabled-program users we return the persisted
      // code (if any from an earlier active window) but do NOT allocate a new one.
      let code: string | null;
      if (programActive) {
        try {
          code = await ensureReferralCode(prisma, user.id);
        } catch (e) {
          logger.error({ err: e, userId: user.id }, '[referral] ensureReferralCode failed on /me');
          trackAnalyticsEvent({
            event: 'referral.code_generation_failed',
            userId: user.id,
            props: { context: '/tg/referral/me' },
          });
          code = null;
        }
      } else {
        const profile = await prisma.userProfile.findUnique({
          where: { userId: user.id },
          select: { referralCode: true },
        });
        code = profile?.referralCode ?? null;
      }
  
      // Was this user attributed to someone else? (Invitee perspective for "invited by" UI)
      const selfAttribution = await prisma.referralAttribution.findUnique({
        where: { invitedUserId: user.id },
        select: { status: true, attributedAt: true, qualifiedAt: true, rewardedAt: true },
      });
  
      // Fan out counts + caps + PRO expiry in parallel.
      const [counts, caps, sub] = await Promise.all([
        referralStatusCounts(user.id),
        referralCapsSnapshot(user.id, config),
        prisma.subscription.findFirst({
          where: {
            userId: user.id,
            planCode: PRO_PLAN_CODE,
            status: { in: ['ACTIVE', 'CANCELLED'] },
            currentPeriodEnd: { gt: new Date() },
          },
          orderBy: { currentPeriodEnd: 'desc' },
          select: { currentPeriodEnd: true },
        }),
      ]);
  
      const link = code ? buildReferralLink(code) : null;
      const shareText = code ? buildReferralShareText(code, config.rewardDaysInviter) : null;
  
      // totalAttributions: every attribution ever created (including fraud/rejected).
      // successful: qualified + rewarded — the count that matters for the user.
      const totalAttributions =
        counts.ATTRIBUTED +
        counts.PENDING_ACTIVATION +
        counts.QUALIFIED +
        counts.REWARDED +
        counts.REJECTED +
        counts.FRAUD_REVIEW;
  
      const successful = counts.QUALIFIED + counts.REWARDED;
  
      return res.json({
        enabled: programActive,
        programEnabled: config.enabled,
        inRollout,
        rolloutPercent: config.rolloutPercent,
        code,
        link,
        shareText,
        stats: {
          totalAttributions,
          successful,
          // ATTRIBUTED is legacy (see ReferralStatusCounts); collapse into pending.
          pendingActivation: counts.ATTRIBUTED + counts.PENDING_ACTIVATION,
          qualified: counts.QUALIFIED,
          rewarded: counts.REWARDED,
          pendingReview: counts.FRAUD_REVIEW,
          rejected: counts.REJECTED,
        },
        caps,
        reward: {
          daysPerRef: config.rewardDaysInviter,
          strategy: config.grantStrategy,
        },
        // Invitee-safe status mapping: we don't expose FRAUD_REVIEW raw — an
        // adversarial user could detect they are under review. Collapse to opaque buckets.
        attributedByInviter: selfAttribution
          ? {
              status:
                selfAttribution.status === 'REWARDED' || selfAttribution.status === 'QUALIFIED'
                  ? ('success' as const)
                  : selfAttribution.status === 'REJECTED' || selfAttribution.status === 'FRAUD_REVIEW'
                    ? ('not_credited' as const)
                    : ('pending' as const),
              attributedAt: selfAttribution.attributedAt.toISOString(),
              qualifiedAt: selfAttribution.qualifiedAt?.toISOString() ?? null,
              rewardedAt: selfAttribution.rewardedAt?.toISOString() ?? null,
            }
          : null,
        proExpiryAt: sub?.currentPeriodEnd.toISOString() ?? null,
        configVersion: config.configVersion,
      });
    }),
  );
  
  // GET /tg/referral/history — keyset-paged list of invitees (inviter perspective)
  //   Query: ?limit=20 (1..50) &before=<attributionId>
  //   Returns newest attributions first; use last item's id as `before` for next page.
  //   Consistent with /tg/santa/campaigns/:id/chat which uses `?before=`.
  refRouter.get(
    '/referral/history',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);
  
      const querySchema = z.object({
        limit: z.coerce.number().int().min(1).max(50).optional(),
        before: z.string().max(64).optional(),
      });
      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) return zodError(res, parsed.error);
      const limit = parsed.data.limit ?? 20;
      const cursor = parsed.data.before || null; // empty string → no cursor
  
      const config = await loadReferralConfig(prisma);
  
      // Resolve cursor to a keyset pair (attributedAt, id)
      let cursorAttributedAt: Date | null = null;
      let cursorId: string | null = null;
      if (cursor) {
        const row = await prisma.referralAttribution.findFirst({
          where: { id: cursor, inviterUserId: user.id },
          select: { id: true, attributedAt: true },
        });
        if (row) {
          cursorAttributedAt = row.attributedAt;
          cursorId = row.id;
        }
        // Unknown cursor → treat as "no cursor" (don't 400; frontend may send stale id).
      }
  
      const rows = await prisma.referralAttribution.findMany({
        where: {
          inviterUserId: user.id,
          ...(cursorAttributedAt && cursorId
            ? {
                OR: [
                  { attributedAt: { lt: cursorAttributedAt } },
                  { attributedAt: cursorAttributedAt, id: { lt: cursorId } },
                ],
              }
            : {}),
        },
        orderBy: [{ attributedAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        select: {
          id: true,
          status: true,
          rejectReason: true,
          attributedAt: true,
          qualifiedAt: true,
          rewardedAt: true,
          rejectedAt: true,
          invitedUserId: true,
          invited: {
            select: {
              firstName: true,
              profile: {
                select: {
                  displayName: true,
                  firstBotStartAt: true,
                  firstWishlistAt: true,
                  firstItemAt: true,
                },
              },
            },
          },
          rewards: {
            where: { status: 'GRANTED' },
            select: { id: true, rewardValueDays: true, grantedAt: true },
            orderBy: { grantedAt: 'desc' },
            take: 1,
          },
        },
      });
  
      const hasMore = rows.length > limit;
      if (hasMore) rows.pop();
  
      const showNames = config.showInviteeNamesInUi;
  
      const items = rows.map((r) => {
        const profile = r.invited.profile;
        const displayName = showNames
          ? (profile?.displayName ?? r.invited.firstName ?? null)
          : null;
        const reward = r.rewards[0];
        return {
          id: r.id,
          status: r.status,
          rejectReason: r.rejectReason,
          attributedAt: r.attributedAt.toISOString(),
          qualifiedAt: r.qualifiedAt?.toISOString() ?? null,
          rewardedAt: r.rewardedAt?.toISOString() ?? null,
          rejectedAt: r.rejectedAt?.toISOString() ?? null,
          invitedDisplayName: displayName,
          progress: {
            firstBotStart: !!profile?.firstBotStartAt,
            firstWishlist: !!profile?.firstWishlistAt,
            firstItem: !!profile?.firstItemAt,
          },
          reward: reward
            ? {
                id: reward.id,
                days: reward.rewardValueDays,
                grantedAt: reward.grantedAt.toISOString(),
              }
            : null,
        };
      });
  
      return res.json({
        items,
        // hasMore ⇒ rows.length was limit+1, popped to limit ≥ 1 — safe to index.
        nextBefore: hasMore ? items[items.length - 1]!.id : null,
        limit,
      });
    }),
  );
  
  // GET /tg/referral/stats — aggregated counters + rolling windows + total reward days
  refRouter.get(
    '/referral/stats',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);
      const config = await loadReferralConfig(prisma);
  
      const now = new Date();
      const DAY_MS = 86_400_000;
      const monthAgo = new Date(now.getTime() - REWARD_CAP_MONTHLY_WINDOW_DAYS * DAY_MS);
      const yearAgo = new Date(now.getTime() - REWARD_CAP_YEARLY_WINDOW_DAYS * DAY_MS);
  
      const [counts, totalDaysRow, monthlyUsed, yearlyUsed] = await Promise.all([
        referralStatusCounts(user.id),
        prisma.referralReward.aggregate({
          where: { userId: user.id, status: 'GRANTED' },
          _sum: { rewardValueDays: true },
        }),
        prisma.referralReward.count({
          where: { userId: user.id, status: 'GRANTED', grantedAt: { gte: monthAgo } },
        }),
        prisma.referralReward.count({
          where: { userId: user.id, status: 'GRANTED', grantedAt: { gte: yearAgo } },
        }),
      ]);
  
      const totalAttributions =
        counts.ATTRIBUTED +
        counts.PENDING_ACTIVATION +
        counts.QUALIFIED +
        counts.REWARDED +
        counts.REJECTED +
        counts.FRAUD_REVIEW;
  
      const successful = counts.QUALIFIED + counts.REWARDED;
  
      return res.json({
        lifetime: {
          totalAttributions,
          successful,
          // ATTRIBUTED is legacy (see ReferralStatusCounts); collapse into pending.
          pendingActivation: counts.ATTRIBUTED + counts.PENDING_ACTIVATION,
          qualified: counts.QUALIFIED,
          rewarded: counts.REWARDED,
          pendingReview: counts.FRAUD_REVIEW,
          rejected: counts.REJECTED,
          totalRewardDays: totalDaysRow._sum.rewardValueDays ?? 0,
        },
        rolling30d: {
          used: monthlyUsed,
          cap: config.monthlyRewardCap,
          atCap: monthlyUsed >= config.monthlyRewardCap,
        },
        rolling365d: {
          used: yearlyUsed,
          cap: config.yearlyRewardCap,
          atCap: yearlyUsed >= config.yearlyRewardCap,
        },
        reward: {
          daysPerRef: config.rewardDaysInviter,
          strategy: config.grantStrategy,
        },
        configVersion: config.configVersion,
      });
    }),
  );
  
  // GET /tg/referral/rules-config — program config snapshot (safe public subset)
  // Exposed to the client so rules screens + entry-point gating stay in sync with admin.
  // Deliberately OMITS fraud thresholds, signal weights, and bot-notification toggles.
  refRouter.get(
    '/referral/rules-config',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);
      const config = await loadReferralConfig(prisma);
      const inRollout = isInRollout(user.id, config.rolloutPercent);
  
      // Config is per-user (isInRollout), but changes rarely (admin edits).
      // Short private cache reduces redundant fetches during a single user session.
      res.set('Cache-Control', 'private, max-age=60');
      return res.json({
        enabled: config.enabled,
        inRollout,
        rolloutPercent: config.rolloutPercent,
        reward: {
          daysPerRef: config.rewardDaysInviter,
          strategy: config.grantStrategy,
        },
        qualification: {
          requireWishlist: config.requireWishlist,
          requireItem: config.requireItem,
          windowDays: config.qualificationWindowDays,
        },
        caps: {
          monthly: config.monthlyRewardCap,
          yearly: config.yearlyRewardCap,
        },
        ui: {
          showInviteeNamesInUi: config.showInviteeNamesInUi,
          entryPointProfile: config.entryPointProfile,
          entryPointPaywall: config.entryPointPaywall,
          entryPointHomeBanner: config.entryPointHomeBanner,
          entryPointPostShare: config.entryPointPostShare,
        },
        configVersion: config.configVersion,
      });
    }),
  );

  return refRouter;
}
