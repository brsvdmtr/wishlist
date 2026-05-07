// Referral progress / reward hooks (P5s-5 — extracted from
// apps/api/src/index.ts).
//
// Three async helpers driving the post-milestone referral pipeline:
//
//   - `resolveProactiveUserLocale(profile, telegramChatId)` — resolves a
//     user's effective locale for proactive notifications (when there's
//     no `ctx.from.language_code` available). Resolution order:
//       1. profile.manualLanguage (MANUAL mode)
//       2. Telegram getChat language_code (AUTO mode, one fetch)
//       3. 'ru' fallback
//     Module-private — only consumer is `notifyReferralInviterRewarded`.
//
//   - `notifyReferralInviterRewarded(inviterUserId, daysGranted)` —
//     best-effort Telegram DM to the inviter that their referral reward
//     was granted. Loads referral config gate, resolves inviter locale,
//     sends via `sendTgBotMessage`, emits a delivery analytics event
//     (`referral.bot_notification_{sent,delivery_failed}`). Wrapped in
//     try/catch — never throws.
//     Public — also called from `routes/admin.routes.ts` (manual fraud-
//     review approval path).
//
//   - `runReferralProgressHook(userId, milestone)` — the main reward
//     pipeline. Marks milestone, runs `tryQualifyAttribution`, and on
//     `qualified` runs `processReward` with branching emission of
//     analytics events for every terminal outcome (rewarded /
//     auto_rejected / review_queued / cap_rejected / already_granted /
//     not_qualified). Fire-and-forget DM via `notifyReferralInviterRewarded`
//     on the rewarded branch. Wrapped in try/catch — never breaks the
//     primary request.
//
// Bodies are byte-identical to their previous in-place definitions in
// index.ts (lines 367–388, 396–424, 438–555).
//
// Strategy A: source moves here; `routes/wishlists.routes.ts`,
// `routes/onboarding.routes.ts` continue receiving
// `runReferralProgressHook` via factory deps; `routes/admin.routes.ts`
// continues receiving `notifyReferralInviterRewarded` via factory deps.
// Signatures unchanged.
//
// Cross-service dependency: imports `trackAnalyticsEvent` directly from
// `./analytics`. One-way coupling (analytics does not import from this
// module).

import {
  prisma,
  loadReferralConfig,
  markFirstWishlist,
  markFirstItem,
  tryQualifyAttribution,
  processReward,
} from '@wishlist/db';
import { t, normalizeLocale, type Locale } from '@wishlist/shared';

import { sendTgBotMessage } from '../telegram/botApi';
import logger from '../logger';
import { trackAnalyticsEvent } from './analytics';

/**
 * Resolve a user's effective locale for proactive notifications (i.e. when
 * there's no `ctx.from.language_code` available because the user isn't the
 * active actor). Resolution order:
 *   1. profile.manualLanguage (MANUAL mode) — user's explicit pick
 *   2. Telegram getChat language_code (AUTO mode) — authoritative live value
 *   3. 'ru' fallback — matches our user base (overwhelmingly Russian)
 *
 * Without (2), AUTO-mode users got English messages because normalizeLocale(undefined)
 * returns 'en' — wrong for our base. One getChat call per notification is a
 * tolerable cost for a rare event (referral rewards).
 */
async function resolveProactiveUserLocale(
  profile: { languageMode: string; manualLanguage: string | null } | null,
  telegramChatId: string | null,
): Promise<Locale> {
  if (profile?.languageMode === 'manual' && profile.manualLanguage) {
    return profile.manualLanguage as Locale;
  }
  if (telegramChatId && process.env.BOT_TOKEN) {
    try {
      const resp = await fetch(
        `https://api.telegram.org/bot${process.env.BOT_TOKEN}/getChat?chat_id=${telegramChatId}`,
      );
      const data = await resp.json() as { ok: boolean; result?: { language_code?: string } };
      if (data.ok && data.result?.language_code) {
        return normalizeLocale(data.result.language_code);
      }
    } catch {
      // fall through to fallback
    }
  }
  return 'ru';
}

/**
 * Best-effort Telegram notification to an inviter that their referral reward
 * was granted. Resolves the inviter's locale from their UserProfile so the
 * message is in their preferred language. Uses the shared sendTgBotMessage
 * helper (raw Telegram API via BOT_TOKEN).
 */
export async function notifyReferralInviterRewarded(inviterUserId: string, daysGranted: number): Promise<void> {
  try {
    const config = await loadReferralConfig(prisma);
    if (!config.notifyInviterReward) return;
    const user = await prisma.user.findUnique({
      where: { id: inviterUserId },
      select: {
        telegramChatId: true,
        profile: { select: { languageMode: true, manualLanguage: true } },
      },
    });
    if (!user?.telegramChatId) return;
    const locale = await resolveProactiveUserLocale(user.profile, user.telegramChatId);
    const text = t('bot_referral_inviter_rewarded', locale, { days: String(daysGranted) });
    // sendTgBotMessage returns false on any Telegram-side failure (API error,
    // network, bot blocked). Emit the matching event so delivery dashboards
    // reflect reality, not intent.
    const delivered = await sendTgBotMessage(user.telegramChatId, text);
    trackAnalyticsEvent({
      event: delivered
        ? 'referral.bot_notification_sent'
        : 'referral.bot_notification_delivery_failed',
      userId: inviterUserId,
      props: { type: 'reward', daysGranted },
    });
  } catch (err) {
    logger.warn({ err, inviterUserId }, '[referral] reward notification failed');
  }
}

// ─── Referral qualify + reward pipeline (fire-and-forget) ────────────────────
//
// Called after wishlist.created and item.created. Does three things in order:
//   1. Marks the appropriate firstWishlistAt / firstItemAt milestone (idempotent).
//   2. Runs tryQualifyAttribution — if both milestones present and within the
//      window, transitions PENDING_ACTIVATION → QUALIFIED.
//   3. If qualified, runs processReward — fraud + cap checks, then grant or
//      reject. Writes ReferralAttribution.status and ReferralReward rows.
//
// Wrapped in try/catch so any referral-side failure never breaks the primary
// request. Emits analytics for every terminal outcome so Slice 6 observability
// can reconstruct the funnel.
export async function runReferralProgressHook(
  userId: string,
  milestone: 'first_wishlist' | 'first_item',
): Promise<void> {
  try {
    if (milestone === 'first_wishlist') {
      await markFirstWishlist(prisma, userId);
      trackAnalyticsEvent({ event: 'referral.first_wishlist_created', userId });
    } else {
      await markFirstItem(prisma, userId);
      trackAnalyticsEvent({ event: 'referral.first_item_created', userId });
    }

    const qualified = await tryQualifyAttribution(prisma, userId);
    if (qualified.kind !== 'qualified') return;

    trackAnalyticsEvent({
      event: 'referral.qualification_criteria_met',
      userId,
      props: { attributionId: qualified.attributionId, milestone },
    });
    trackAnalyticsEvent({
      event: 'referral.qualified',
      userId,
      props: { attributionId: qualified.attributionId, inviterUserId: qualified.inviterUserId },
    });

    const decision = await processReward(prisma, qualified.attributionId);
    switch (decision.kind) {
      case 'rewarded':
        trackAnalyticsEvent({
          event: 'referral.rewarded',
          userId: qualified.inviterUserId,
          props: {
            attributionId: qualified.attributionId,
            rewardId: decision.rewardId,
            daysGranted: decision.daysGranted,
            newExpiryAt: decision.newExpiryAt.toISOString(),
          },
        });
        trackAnalyticsEvent({
          event: 'referral.pro_subscription_extended',
          userId: qualified.inviterUserId,
          props: { attributionId: qualified.attributionId, daysGranted: decision.daysGranted },
        });
        // Fire-and-forget: notify inviter via Telegram
        void notifyReferralInviterRewarded(qualified.inviterUserId, decision.daysGranted);
        break;
      case 'auto_rejected':
        trackAnalyticsEvent({
          event: 'referral.rejected',
          userId: qualified.inviterUserId,
          props: {
            attributionId: qualified.attributionId,
            reason: 'FRAUD_REJECTED',
            fraudScore: decision.fraudScore,
            signalCount: decision.signals.length,
          },
        });
        break;
      case 'review_queued':
        trackAnalyticsEvent({
          event: 'referral.fraud_review_queued',
          userId: qualified.inviterUserId,
          props: {
            attributionId: qualified.attributionId,
            fraudScore: decision.fraudScore,
            signalCount: decision.signals.length,
          },
        });
        break;
      case 'cap_rejected':
        trackAnalyticsEvent({
          event: 'referral.rejected',
          userId: qualified.inviterUserId,
          props: {
            attributionId: qualified.attributionId,
            reason: 'REWARD_CAP_REACHED',
            capReason: decision.reason,
            monthlyUsed: decision.monthlyUsed,
            yearlyUsed: decision.yearlyUsed,
          },
        });
        trackAnalyticsEvent({
          event: 'referral.cap_check_performed',
          userId: qualified.inviterUserId,
          props: { reason: decision.reason, monthlyUsed: decision.monthlyUsed, yearlyUsed: decision.yearlyUsed },
        });
        break;
      case 'already_granted':
        trackAnalyticsEvent({
          event: 'referral.idempotency_hit',
          userId: qualified.inviterUserId,
          props: { attributionId: qualified.attributionId, context: 'processReward' },
        });
        break;
      case 'not_qualified':
        // Shouldn't happen — tryQualifyAttribution returned qualified. Log defensively.
        logger.warn(
          { userId, attributionId: qualified.attributionId },
          '[referral] processReward returned not_qualified immediately after qualify',
        );
        trackAnalyticsEvent({
          event: 'referral.attribution_invariant_violation',
          userId: qualified.inviterUserId,
          props: { attributionId: qualified.attributionId, context: 'qualified_then_not_qualified' },
        });
        break;
    }
  } catch (e) {
    logger.error({ err: e, userId, milestone }, '[referral] progress hook failed');
    trackAnalyticsEvent({
      event: 'referral.reward_grant_failed',
      userId,
      props: { milestone, error: e instanceof Error ? e.message : String(e) },
    });
  }
}
