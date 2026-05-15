// Lifecycle / Win-back scheduler (P5r-5) — extracted from
// apps/api/src/index.ts. Hourly cron that scans users, classifies into
// segments S1–S4, creates LifecycleTouch records, and sends Telegram DM
// messages via bot API. WISHPRO offered only on eligible touches.
//
// Cadence (60 * 60 * 1000 ms), log labels, structured fields, cooldown
// constants, classifier thresholds, message templates, segment cadence,
// and dead-air alarm behavior preserved byte-identical for ops continuity.
//
// `sendLifecycleDM` lives in ../services/lifecycle.ts because it is also
// consumed by the PRO-renewal scheduler (../schedulers/pro-renewal.ts).
// We accept it via deps so the bot-token/logger closure is created once
// at composition-root.
//
// Best-effort: errors logged via 'lifecycle scheduler error' but never
// bubble out of setInterval; next cycle re-attempts work.
//
// Module-scope mutable state: `lifecycleDeadCycles` is a counter that
// survives across cron ticks within one process. Resets on container
// restart (re-initialized to 0 when this module is imported). Behavior
// preserved from the original in-line implementation in index.ts.

import type { PrismaClient } from '@wishlist/db';
import type { Logger } from 'pino';
import { t, resolveLocaleWithSource } from '@wishlist/shared';
import type { SendLifecycleDM } from '../services/lifecycle';
import { profileToLanguageSettings } from '../services/locale';

// Structural narrow over the real `getUserEntitlement` return shape —
// the lifecycle scheduler only reads `isPro` and `proSource`. Matches
// the byte-identical predicate `ent.proSource === 'subscription'` in
// shouldStopLifecycle and `ent.isPro` in the cron body. `proSource` is
// `string | null` to accommodate the real return type
// ("subscription" | "promo" | "god_mode" | null).
type GetUserEntitlement = (userId: string) => Promise<{ isPro: boolean; proSource: string | null }>;

type TrackEvent = (event: string, userId?: string, props?: Record<string, unknown>) => void;

export type LifecycleSchedulerDeps = {
  prisma: PrismaClient;
  logger: Logger;
  sendLifecycleDM: SendLifecycleDM;
  getUserEntitlement: GetUserEntitlement;
  trackEvent: TrackEvent;
  MINI_APP_URL_FOR_DM: string;
  LIFECYCLE_PROMO_CODE: string;
  BOT_TOKEN_FOR_DM: string;
};

const LIFECYCLE_PROMO_COOLDOWN_DAYS = 60; // max 1 promo offer per 60 days
const LIFECYCLE_MSG_COOLDOWN_HOURS = 72; // min 72h between messages
const LIFECYCLE_MAX_MARKETING_45D = 5; // max 5 marketing touches in 45 days
// Dead-air alarm: if N cycles in a row produce 0 sends despite a non-empty
// candidate pool, log a structured warn so the daily cron monitor catches it.
// 24 cycles ≈ 24 h. Plateau is normal; total silence on a non-empty pool is not.
const LIFECYCLE_DEAD_AIR_THRESHOLD = 24;
let lifecycleDeadCycles = 0;

// Lifecycle message templates per segment+touch — i18n keys from shared dictionaries
// Promo policy:
//   S1 — NO promo (user hasn't understood product value yet)
//   S2 — promo on wave 2 only, tied to first-wish completion
//   S3 — promo on waves 1+2 (primary promo segment), tied to add-more-wishes completion
//   S4 — promo on waves 2+3 (power user re-engagement)
const LIFECYCLE_MESSAGES: Record<string, Record<number, { i18nKey: string; hasPromo: boolean }>> = {
  S1: {
    1: { i18nKey: 'wb_s1_t1', hasPromo: false },
    2: { i18nKey: 'wb_s1_t2', hasPromo: false },
    3: { i18nKey: 'wb_s1_t3', hasPromo: false },
  },
  S2: {
    1: { i18nKey: 'wb_s2_t1', hasPromo: false },
    2: { i18nKey: 'wb_s2_t2_promo', hasPromo: true },
    3: { i18nKey: 'wb_s2_t3', hasPromo: false },
  },
  S3: {
    1: { i18nKey: 'wb_s3_t1_promo', hasPromo: true },
    2: { i18nKey: 'wb_s3_t2_promo', hasPromo: true },
    3: { i18nKey: 'wb_s3_t3_promo', hasPromo: true },
  },
  S4: {
    1: { i18nKey: 'wb_s4_t1', hasPromo: false },
    2: { i18nKey: 'wb_s4_t2_promo', hasPromo: true },
    3: { i18nKey: 'wb_s4_t3_promo', hasPromo: true },
  },
};

// Segment cadence: touch number → days since churn
const SEGMENT_CADENCE: Record<string, number[]> = {
  S1: [0.25, 2, 7],   // 6h, 2d, 7d
  S2: [1, 4, 10],
  S3: [5, 14, 30],
  S4: [7, 21, 45],
};

// Max waves (touches) per episode per segment
const MAX_WAVES: Record<string, number> = { S1: 2, S2: 3, S3: 2, S4: 3 };

export function startLifecycleScheduler(deps: LifecycleSchedulerDeps): void {
  const {
    prisma, logger, sendLifecycleDM, getUserEntitlement, trackEvent,
    MINI_APP_URL_FOR_DM, LIFECYCLE_PROMO_CODE, BOT_TOKEN_FOR_DM,
  } = deps;

  /** Classify user into lifecycle segment. Returns null if user is not in any churn segment. */
  async function classifyLifecycleSegment(userId: string): Promise<{
    segment: 'S1' | 'S2' | 'S3' | 'S4'; targetAction: string;
  } | null> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true, updatedAt: true, createdAt: true,
        wishlists: { where: { type: 'REGULAR', archivedAt: null }, select: { id: true, items: { where: { status: { in: ['AVAILABLE', 'RESERVED'] } }, select: { id: true } }, shareOpenCount: true } },
      },
    });
    if (!user) return null;

    const wlCount = user.wishlists.length;
    const totalItems = user.wishlists.reduce((s, w) => s + w.items.length, 0);
    const hasShare = user.wishlists.some(w => (w.shareOpenCount ?? 0) > 0);
    const daysSinceUpdate = (Date.now() - user.updatedAt.getTime()) / (1000 * 60 * 60 * 24);

    // S1: started but no wishlist, gone
    if (wlCount === 0 && daysSinceUpdate >= 0.25) { // 6h = 0.25 days
      return { segment: 'S1', targetAction: 'create_wishlist' };
    }
    // S2: has wishlist, no items, gone 1+ day
    if (wlCount > 0 && totalItems === 0 && daysSinceUpdate >= 1) {
      return { segment: 'S2', targetAction: 'add_item' };
    }
    // S4: fully active user who churned (7+ days, 3+ items OR 2+ wishlists OR had share)
    if (daysSinceUpdate >= 7 && (totalItems >= 3 || wlCount >= 2 || hasShare)) {
      return { segment: 'S4', targetAction: 'return_visit' };
    }
    // S3: has items, gone 5+ days
    if (totalItems > 0 && daysSinceUpdate >= 5) {
      return { segment: 'S3', targetAction: 'add_more_wishes' };
    }

    return null; // not in churn
  }

  /** Check lifecycle frequency caps for a user. */
  async function checkLifecycleCaps(userId: string, segment: string): Promise<{
    canSend: boolean; canOfferPromo: boolean; currentEpisodeTouches: number;
  }> {
    const now = new Date();
    const h72ago = new Date(now.getTime() - LIFECYCLE_MSG_COOLDOWN_HOURS * 60 * 60 * 1000);
    const d45ago = new Date(now.getTime() - 45 * 24 * 60 * 60 * 1000);
    const d60ago = new Date(now.getTime() - LIFECYCLE_PROMO_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);

    const [recentMsg, marketing45d, promoRecent, episodeTouches] = await Promise.all([
      // Any message sent in last 72h?
      prisma.lifecycleTouch.findFirst({ where: { userId, sentAt: { gte: h72ago } } }),
      // Total marketing touches in 45 days
      prisma.lifecycleTouch.count({ where: { userId, sentAt: { gte: d45ago } } }),
      // Any promo offer in 60 days?
      prisma.lifecycleTouch.findFirst({ where: { userId, offerCode: { not: null }, sentAt: { gte: d60ago } } }),
      // Current episode touches (same segment, sent)
      prisma.lifecycleTouch.count({ where: { userId, segment, sentAt: { not: null }, stoppedAt: null } }),
    ]);

    return {
      canSend: !recentMsg && marketing45d < LIFECYCLE_MAX_MARKETING_45D && episodeTouches < 3,
      canOfferPromo: !promoRecent,
      currentEpisodeTouches: episodeTouches,
    };
  }

  /** Check stop conditions for lifecycle messaging. */
  async function shouldStopLifecycle(userId: string, segment: string): Promise<string | null> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, updatedAt: true, profile: { select: { notifyMarketing: true } } },
    });
    if (!user) return 'user_not_found';

    // User opted out of marketing
    if (user.profile?.notifyMarketing === false) return 'unsubscribed';

    // User has active PRO (bought it)
    const ent = await getUserEntitlement(userId);
    if (ent.proSource === 'subscription') return 'bought_pro';

    // User returned (updated within 24h)
    const daysSinceUpdate = (Date.now() - user.updatedAt.getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceUpdate < 1) return 'returned';

    return null; // no stop reason
  }

  setInterval(async () => {
    if (!BOT_TOKEN_FOR_DM) return;
    const cycleStart = Date.now();
    let touchesSent = 0;
    let touchesFailed = 0;
    try {
      // Find users who haven't been updated recently (potential churn candidates)
      const candidateThreshold = new Date(Date.now() - 6 * 60 * 60 * 1000); // at least 6h inactive
      const candidates = await prisma.user.findMany({
        where: {
          telegramChatId: { not: null },
          updatedAt: { lte: candidateThreshold },
          // Exclude users created less than 6h ago
          createdAt: { lte: candidateThreshold },
        },
        select: { id: true, telegramChatId: true, telegramId: true, updatedAt: true, createdAt: true, profile: { select: { notifyMarketing: true, languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } } },
        orderBy: { createdAt: 'desc' }, // newest first — ensure fresh signups get onboarding touches
      });

      for (const candidate of candidates) {
        if (!candidate.telegramChatId) continue;
        if (candidate.profile?.notifyMarketing === false) continue;

        // Classify
        const classification = await classifyLifecycleSegment(candidate.id);
        if (!classification) continue;

        const { segment, targetAction } = classification;

        // Check stop conditions
        const stopReason = await shouldStopLifecycle(candidate.id, segment);
        if (stopReason) {
          // Mark any pending touches as stopped
          await prisma.lifecycleTouch.updateMany({
            where: { userId: candidate.id, stoppedAt: null, sentAt: null },
            data: { stoppedAt: new Date(), stopReason },
          });
          continue;
        }

        // Check caps
        const caps = await checkLifecycleCaps(candidate.id, segment);
        if (!caps.canSend) continue;

        const nextTouchNumber = caps.currentEpisodeTouches + 1;
        if (nextTouchNumber > (MAX_WAVES[segment] ?? 3)) continue;

        // Check cadence timing
        const daysSinceUpdate = (Date.now() - candidate.updatedAt.getTime()) / (1000 * 60 * 60 * 24);
        const cadence = SEGMENT_CADENCE[segment];
        if (!cadence || !cadence[nextTouchNumber - 1]) continue;
        if (daysSinceUpdate < cadence[nextTouchNumber - 1]!) continue;

        // Get message template
        const template = LIFECYCLE_MESSAGES[segment]?.[nextTouchNumber];
        if (!template) continue;

        // Check if this touch should offer promo
        const shouldOfferPromo = template.hasPromo && caps.canOfferPromo;

        // Skip promo if user already has active promo or has used it
        let actuallyOfferPromo = shouldOfferPromo;
        if (shouldOfferPromo) {
          const ent = await getUserEntitlement(candidate.id);
          if (ent.isPro) actuallyOfferPromo = false; // already PRO, no need

          const existingPromo = await prisma.promoRedemption.findFirst({
            where: { userId: candidate.id, status: { in: ['ACTIVE', 'EXPIRED', 'ACCEPTED_FOR_PAID'] } },
          });
          if (existingPromo) actuallyOfferPromo = false; // already used promo
        }

        // Determine locale — proactive cron context, no live ctx.from.
        // Resolver chain falls back through persisted normalizedLocale / language
        // captured by middleware on every authenticated touch.
        const { locale, source: localeSource } = resolveLocaleWithSource(
          profileToLanguageSettings(candidate.profile),
        );

        // Build episode key
        const monthKey = new Date().toISOString().slice(0, 7); // 2026-03
        const episodeKey = `${segment}_${candidate.id}_${monthKey}`;

        // Create eligibility: PENDING PromoRedemption if offering promo
        if (actuallyOfferPromo) {
          const campaign = await prisma.promoCampaign.findUnique({ where: { code: LIFECYCLE_PROMO_CODE } });
          if (campaign) {
            await prisma.promoRedemption.upsert({
              where: { userId_campaignId: { userId: candidate.id, campaignId: campaign.id } },
              create: {
                userId: candidate.id,
                campaignId: campaign.id,
                status: 'PENDING',
                offeredAt: new Date(),
                offeredVia: episodeKey,
                source: 'winback',
              },
              update: {
                // Don't overwrite if already active/expired
              },
            }).catch(() => {}); // ignore if already exists with terminal status
          }
        }

        // Build deeplink payload — promo entries get _promo suffix so frontend can track promo context
        let deepLink: string | undefined;
        if (segment === 'S1') deepLink = 'create_wishlist';
        else if (segment === 'S2') deepLink = actuallyOfferPromo ? 'add_first_wish_promo' : 'add_first_wish';
        else if (segment === 'S3') deepLink = actuallyOfferPromo ? 'add_more_wishes_promo' : 'add_more_wishes';
        // S4: no deeplink (power user, goes to home)

        // Create touch record (upsert to avoid noisy duplicate-key errors in PG logs)
        const touchData = {
          userId: candidate.id,
          segment,
          episodeKey,
          touchNumber: nextTouchNumber,
          scheduledFor: new Date(),
          targetAction,
          offerCode: actuallyOfferPromo ? LIFECYCLE_PROMO_CODE : null,
          messageKind: actuallyOfferPromo ? 'promo_offer' : (segment === 'S1' || segment === 'S2' ? 'activation' : 'winback'),
          deepLinkPayload: deepLink,
        };
        const touch = await prisma.lifecycleTouch.upsert({
          where: {
            userId_episodeKey_touchNumber: {
              userId: candidate.id,
              episodeKey,
              touchNumber: nextTouchNumber,
            },
          },
          create: touchData,
          update: {},  // already exists — skip, don't overwrite
        });

        // If already sent, skip sending again
        if (touch.sentAt) continue;

        // Send DM
        const msgText = t(template.i18nKey, locale);
        const webAppUrl = touch.deepLinkPayload
          ? `${MINI_APP_URL_FOR_DM}?startapp=${touch.deepLinkPayload}`
          : MINI_APP_URL_FOR_DM;
        const outcome = await sendLifecycleDM(candidate.telegramChatId, msgText, locale, webAppUrl);
        const delivered = outcome === 'delivered';

        // Transient failures: leave the touch record untouched (sentAt=null) so the
        // next cycle re-attempts with the same episodeKey/touchNumber. The earlier
        // version stamped sentAt+stoppedAt on every failure, which permanently
        // sank the touch for the rest of the monthly episode (root cause of
        // lifecycle scheduler sending 0/333 candidates for days).
        if (outcome === 'transient_failure') {
          touchesFailed++;
          logger.info(
            { outcome, segment, touchNumber: nextTouchNumber, userId: candidate.id.slice(0, 8) },
            'lifecycle touch transient failure; will retry next cycle',
          );
          continue;
        }

        // Permanent outcome: stamp sentAt and, if not delivered, the appropriate
        // stopReason so this episode's touch isn't revisited.
        const deliveryStopReason = delivered
          ? null
          : outcome === 'bot_blocked' ? 'bot_blocked'
          : outcome === 'chat_not_found' ? 'chat_not_found'
          : 'delivery_failed';

        await prisma.lifecycleTouch.update({
          where: { id: touch.id },
          data: {
            sentAt: new Date(),
            delivered,
            ...(deliveryStopReason ? { stoppedAt: new Date(), stopReason: deliveryStopReason } : {}),
          },
        });

        // Auto-unsubscribe users who've blocked the bot. Without this they stay in
        // the candidate pool every cycle, producing 403s that have no chance of
        // converting and polluting delivery metrics. Marketing can be re-enabled
        // by the user from settings if they return.
        if (outcome === 'bot_blocked') {
          await prisma.userProfile.upsert({
            where: { userId: candidate.id },
            update: { notifyMarketing: false },
            create: { userId: candidate.id, notifyMarketing: false },
          }).catch((err) => logger.warn(
            { err, userId: candidate.id.slice(0, 8) },
            'failed to auto-unsubscribe bot-blocked user',
          ));
        }

        if (delivered) {
          trackEvent(`lifecycle_${segment.toLowerCase()}_touch${nextTouchNumber}`, candidate.id, {
            segment, touchNumber: nextTouchNumber, offerCode: actuallyOfferPromo ? LIFECYCLE_PROMO_CODE : null,
          });
        }

        if (delivered) touchesSent++; else touchesFailed++;
        logger.info({ delivered, outcome, segment, touchNumber: nextTouchNumber, userId: candidate.id.slice(0, 8), promo: actuallyOfferPromo, locale, localeSource }, 'lifecycle touch sent');
      }

      logger.info({ candidatesFound: candidates.length, touchesSent, touchesFailed, durationMs: Date.now() - cycleStart }, 'lifecycle_cycle_completed');

      // Dead-air alarm: if N cycles in a row find candidates but send nothing,
      // something is silently broken (cooldown logic stuck, all candidates
      // hitting MAX_WAVES, segment classifier returning null for everyone, etc).
      // Plateau is normal — alarm only on prolonged silence with non-empty pool.
      // Counter lives in module scope so it survives across cycles in one process.
      const sentThisCycle = touchesSent > 0 || touchesFailed > 0;
      if (candidates.length > 0 && !sentThisCycle) {
        lifecycleDeadCycles++;
        if (lifecycleDeadCycles === LIFECYCLE_DEAD_AIR_THRESHOLD || lifecycleDeadCycles % LIFECYCLE_DEAD_AIR_THRESHOLD === 0) {
          // Fire on threshold and every Nth multiple after, so daily monitor
          // catches it but we don't spam logs once per cycle.
          logger.warn(
            { deadCycles: lifecycleDeadCycles, candidatesFound: candidates.length, threshold: LIFECYCLE_DEAD_AIR_THRESHOLD },
            'lifecycle_dead_air',
          );
        }
      } else {
        lifecycleDeadCycles = 0;
      }
    } catch (err) {
      logger.error({ err, touchesSent, touchesFailed, durationMs: Date.now() - cycleStart }, 'lifecycle scheduler error');
    }
  }, 60 * 60 * 1000); // every hour
}
