// Bootstrap order matters and is enforced by file naming:
//   1. dns      — sets ipv6first BEFORE any module opens a socket
//   2. env      — populates process.env from .env BEFORE any module reads it
//   3. sentry   — opt-in error tracking init, depends on env
// Side-effect-only imports; do not reorder.
import './bootstrap/dns';
import './bootstrap/env';
import './bootstrap/sentry';

import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  prisma,
  Prisma,
  markFirstWishlist,
  markFirstItem,
  tryQualifyAttribution,
  processReward,
  loadReferralConfig,
  sweepExpiredPendingAttributions,
} from '@wishlist/db';
import logger from './logger';
import {
  createRateLimiter,
  combineLimiters,
  createIdempotencyMiddleware,
  ipThrottleGate,
  recordIpEvent,
  startIdempotencyCleanupJob,
  IDEMPOTENCY_BILLING_TTL_MINUTES,
} from './security';
import { parseUrl } from './url-parser.js';
import { getOrCreateProfile } from './profile.js';
import { t, normalizeLocale, resolveEffectiveLocale, pluralize, type Locale, type LanguageMode, type LanguageSettings, getOnboardingMeta, type OnboardingVariant, deriveMarketBucket, isSupportedImportRegion, ANALYTICS_EVENTS } from '@wishlist/shared';

// Sentry namespace stays imported here so the error handler and the
// uncaughtException / unhandledRejection handlers further down can call
// Sentry.captureException. Init itself happens in ./bootstrap/sentry.
import * as Sentry from '@sentry/node';

import { corsMiddleware } from './middleware/cors';
import { requestLogger } from './middleware/requestLogger';
import { registerHealthRoutes } from './health/health.routes';
import { upload } from './uploads/upload.config';
import { deleteUploadFile } from './uploads/uploadCleanup';
import { registerUploads } from './uploads/registerUploads';

import { secureCompare } from './lib/crypto';
import { getRequestLocale } from './lib/locale';
import { sendTgNotification, sendTgBotMessage } from './telegram/botApi';
import { sendAdminAlert } from './notifications/adminAlerts';

import { ensureItemPlacement } from './placements/ensureItemPlacement';

import { registerInternalRouter } from './routes/internal.routes';
import { registerAdminRouter } from './routes/admin.routes';
import { registerPublicRouter } from './routes/public.routes';
import { registerMeRouter } from './routes/me.routes';
import { registerRefRouter } from './routes/referral.routes';
import { registerSupportRouter } from './routes/support.routes';
import { registerGiftNotesRouter } from './routes/gift-notes.routes';
import { registerProfilesRouter } from './routes/profiles.routes';
import { registerTelemetryRouter } from './routes/telemetry.routes';
import { registerAnalyticsRouter } from './routes/analytics.routes';
import { registerMaintenanceRouter } from './routes/maintenance.routes';
import { registerImportRouter } from './routes/import.routes';
import { registerBirthdayRemindersRouter } from './routes/birthday-reminders.routes';
import { registerPromoRouter } from './routes/promo.routes';
import { registerOnboardingRouter } from './routes/onboarding.routes';
import { registerSelectionsArchiveRouter } from './routes/selections-archive.routes';
import { registerReservationsRouter } from './routes/reservations.routes';
import { registerCommentsRouter } from './routes/comments.routes';
import { registerHintsRouter } from './routes/hints.routes';
import { registerGroupGiftsRouter } from './routes/group-gifts.routes';
import { registerBillingRouter } from './routes/billing.routes';
import { registerItemsRouter } from './routes/items.routes';
import { registerWishlistsRouter } from './routes/wishlists.routes';
import { registerSantaRouter } from './routes/santa.routes';
import { startCleanupSchedulers } from './schedulers/cleanup';
import { startBillingSchedulers } from './schedulers/billing';
import { startReferralSchedulers } from './schedulers/referral';
import { startSantaSchedulers, runSantaStartupJobs } from './schedulers/santa';
import {
  startReservationReminderScheduler,
  startSmartReservationSchedulers,
} from './schedulers/reservations';
import { startEventSchedulers } from './schedulers/events';
import { startLifecycleScheduler } from './schedulers/lifecycle';
import { startProRenewalReminderScheduler } from './schedulers/pro-renewal';
import { startBirthdayRemindersScheduler } from './schedulers/birthday-reminders';
import { createSendLifecycleDM } from './services/lifecycle';
import { daysUntilNextBirthday, pickBirthdayDisplayName } from './services/birthday-reminders';
import {
  TelegramUser,
  INIT_DATA_MAX_AGE_SECONDS,
  INIT_DATA_CLOCK_SKEW_SECONDS,
  validateTelegramInitData,
  tgActorHash,
  SYSTEM_ACTOR_HASH,
  requireTelegramAuth,
  getOrCreateTgUser,
} from './services/telegram-auth';
import {
  PLANS,
  PRO_PRICE_XTR,
  PRO_YEARLY_PRICE_XTR,
  PRO_SUBSCRIPTION_PERIOD,
  PRO_YEARLY_EXTEND_SECONDS,
  PRO_PLAN_CODE,
  GIFT_NOTES_PRICE_XTR,
  GIFT_NOTES_SKU,
  GROUP_GIFT_PRICE_XTR,
  GROUP_GIFT_SKU,
  SECRET_RESERVATION_PRICE_XTR,
  SECRET_RESERVATION_SKU,
  ONE_TIME_SKUS,
  ADDON_CAPS,
  isReservationBeta,
  hasReservationPro,
  getSmartResLeadHours,
  hasSmartReservations,
  getUserEntitlement,
  getEffectiveEntitlements,
  isWishlistWritable,
} from './services/entitlement';

const PORT = Number(process.env.PORT ?? 3001);

const app = express();

// Trust the first proxy (nginx) so X-Forwarded-For is used for req.ip.
// Without this, express-rate-limit sees 127.0.0.1 for all requests behind nginx
// and rate-limits incorrectly. Also silences ERR_ERL_UNEXPECTED_X_FORWARDED_FOR.
app.set('trust proxy', 1);

// Middleware order MUST stay: cors → express.json → requestLogger → /uploads
// → /health → maintenance gate → routers → error handler. See docs/BACKEND_MAP.md
// § "Middleware Chain". The infrastructure pieces have moved into modules
// under ./middleware, ./uploads, ./health — the order here is unchanged.
app.use(corsMiddleware);
app.use(express.json());
app.use(requestLogger);

// /uploads static handler (30-day immutable cache).
registerUploads(app);

// /health (liveness) and /health/deep (DB + bot heartbeat readiness).
// Both intentionally bypass auth and the /tg+/public maintenance gate.
registerHealthRoutes(app);

const tgRouter = express.Router();
// --- Shared helpers
const ItemStatusSchema = z.enum(['AVAILABLE', 'RESERVED', 'PURCHASED', 'COMPLETED', 'DELETED', 'ARCHIVED']);
const ACTIVE_STATUSES = ['AVAILABLE', 'RESERVED', 'PURCHASED'] as const;
const PrioritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);

// Normalize bare domain URLs like "audi.com" → "https://audi.com"
const normalizeUrl = (val: string) => {
  const v = val.trim();
  if (!v) return v;
  if (/^https?:\/\//i.test(v)) return v;
  return `https://${v}`;
};
const zUrl = () => z.string().transform(normalizeUrl).pipe(z.string().url());

// Sort logic lives in sort.ts (no external deps → easy to unit-test)
import { ITEM_ORDER_BY, sortItemsJs, type SortableItem } from './sort.js';
export { ITEM_ORDER_BY, sortItemsJs, type SortableItem };

const actorBodySchema = z.object({
  actorHash: z.string().uuid(),
});

/** Best-effort: resolve user's first_name from Telegram Bot API, cache in DB. */
async function resolveUserFirstName(user: { id: string; firstName: string | null; telegramChatId: string | null }, locale: Locale = 'ru'): Promise<string> {
  if (user.firstName) return user.firstName;
  const fallback = t('api_user_fallback', locale);
  const token = process.env.BOT_TOKEN;
  if (!token || !user.telegramChatId) return fallback;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getChat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: user.telegramChatId }),
    });
    if (!resp.ok) return fallback;
    const json = await resp.json() as { ok: boolean; result?: { first_name?: string } };
    const name = json.result?.first_name;
    if (name) {
      // Cache in DB for future calls
      await prisma.user.update({ where: { id: user.id }, data: { firstName: name } }).catch(() => {});
      return name;
    }
  } catch { /* best-effort */ }
  return fallback;
}

/** Cancel all active hints for an item (called when item leaves AVAILABLE state). */
async function cancelItemHints(itemId: string): Promise<void> {
  try {
    await prisma.hint.updateMany({
      where: { itemId, status: { in: ['SENT', 'DELIVERED'] } },
      data: { status: 'CANCELLED' },
    });
  } catch { /* best-effort */ }
}

/**
 * Record unread changes for subscribers of a wishlist and send Telegram notifications.
 * Fire-and-forget — never throws.
 *
 * For item_added / item_updated events we attach an inline-keyboard button that
 * deep-links into the Mini App at the specific item via the existing
 * `<slug>__item_<itemId>` startapp format (parsed in MiniApp.tsx bootstrap).
 * Wishlist-only updates currently ship without a button — no slug-only handler
 * in the bootstrap parser yet.
 */
async function notifySubscribersOfChange(
  wishlistId: string,
  entityId: string,
  changedFields: string[],
  eventType: 'item_added' | 'item_updated' | 'wishlist_updated',
  meta: { itemTitle?: string; wishlistTitle?: string; ownerName?: string },
): Promise<void> {
  try {
    const subs = await prisma.wishlistSubscription.findMany({
      where: { wishlistId },
      select: { id: true, subscriber: { select: { id: true, telegramChatId: true } } },
    });
    if (subs.length === 0) return;

    // Resolve the wishlist slug once for deep-link construction (item events only).
    const isItemEvent = eventType === 'item_added' || eventType === 'item_updated';
    let deepLinkUrl: string | null = null;
    if (isItemEvent) {
      const wl = await prisma.wishlist.findUnique({ where: { id: wishlistId }, select: { slug: true } });
      if (wl?.slug) {
        const miniAppUrl = process.env.MINI_APP_URL ?? (process.env.WEB_ORIGIN ? `${process.env.WEB_ORIGIN}/miniapp` : 'https://wishlistik.ru/miniapp');
        deepLinkUrl = `${miniAppUrl}?startapp=${encodeURIComponent(wl.slug)}__item_${encodeURIComponent(entityId)}`;
      }
    }

    const notifLocale: Locale = 'ru';
    await Promise.all(
      subs.map(async (sub) => {
        // Upsert unread markers
        await Promise.all(
          changedFields.map((field) =>
            prisma.subscriptionUnread.upsert({
              where: { subId_entityId_fieldName: { subId: sub.id, entityId, fieldName: field } },
              update: {},
              create: { subId: sub.id, entityId, fieldName: field },
            }),
          ),
        );

        // Send Telegram notification
        const chatId = sub.subscriber.telegramChatId;
        if (!chatId) return;

        let text = '';
        if (eventType === 'item_added') {
          text = t('sub_notification_new_item', notifLocale, {
            owner: meta.ownerName ?? '…',
            title: meta.itemTitle ?? '…',
            wishlist: meta.wishlistTitle ?? '…',
          });
        } else if (eventType === 'item_updated') {
          text = t('sub_notification_updated', notifLocale, {
            title: meta.itemTitle ?? '…',
            wishlist: meta.wishlistTitle ?? '…',
          });
        } else {
          text = t('sub_notification_wishlist_updated', notifLocale, {
            title: meta.wishlistTitle ?? '…',
          });
        }

        if (deepLinkUrl) {
          // Use sendTgBotMessage (supports reply_markup) instead of sendTgNotification.
          // Button text "🎁 Перейти к желанию" — same RU-only stance as the message text.
          void sendTgBotMessage(chatId, text, {
            inline_keyboard: [[{ text: '🎁 Перейти к желанию', web_app: { url: deepLinkUrl } }]],
          });
        } else {
          void sendTgNotification(chatId, text);
        }
      }),
    );
  } catch (err) {
    logger.error({ err }, 'notifySubscribersOfChange error');
  }
}

// generateUniqueSupportId + getOrCreateProfile live in ./profile so they can
// be unit-tested in isolation (race-condition repro for P2002 on userId).

// ─── Shared-wish placements ──────────────────────────────────────────────────
// Every Item has a row in WishlistItemPlacement for each wishlist it lives in.
// During the dual-read migration window, Item.wishlistId / Item.position /
// Item.categoryId continue to exist on the canonical Item row for legacy
// reads — placement writes mirror those values for the item's origin wishlist.
// When an item is placed in additional wishlists, only a placement row is added.

/**
 * Ensure a placement row exists for (wishlistId, itemId). Upsert-style — safe
 * to call when unsure whether the placement already exists (e.g. during
 * legacy create paths that also write Item.wishlistId). Returns the placement.
 *
 * @param tx  Prisma transaction/client
 * @param opts.wishlistId  Target wishlist
 * @param opts.itemId      Item being placed
 * @param opts.position    Position within the wishlist (defaults to appended at end)
 * @param opts.categoryId  Category in target wishlist (null → default category resolved here)
 */
/**
 * Count how many wishlists an item is currently placed in.
 * Used to render "🔗 В N" badges and to guard the "remove last placement" flow.
 */
async function countItemPlacements(itemId: string): Promise<number> {
  return prisma.wishlistItemPlacement.count({ where: { itemId } });
}

/**
 * Before deleting a wishlist, make sure shared wishes (items placed in THIS wishlist
 * as their legacy primary + also placed in other wishlists) don't get cascaded away.
 *
 * Strategy: for each item whose Item.wishlistId = wishlistIdBeingDeleted AND has another
 * placement, reassign Item.wishlistId to the oldest remaining placement (matching the
 * DELETE /items/:id/placements/:wishlistId behaviour). After this, wishlist.delete can
 * safely cascade — it will only remove placements in this wishlist + items that were
 * fully homed here.
 */
async function reassignPrimaryBeforeWishlistDelete(wishlistId: string): Promise<void> {
  // Candidate items: primary points to this wishlist
  const primariesHere = await prisma.item.findMany({
    where: { wishlistId },
    select: { id: true },
  });
  if (primariesHere.length === 0) return;

  for (const { id } of primariesHere) {
    const otherPlacement = await prisma.wishlistItemPlacement.findFirst({
      where: { itemId: id, wishlistId: { not: wishlistId } },
      orderBy: { addedAt: 'asc' },
      select: { wishlistId: true, position: true, categoryId: true },
    });
    if (!otherPlacement) continue; // item fully homed here — will cascade-delete as expected
    // Move primary so the item survives the wishlist cascade
    await prisma.item.update({
      where: { id },
      data: {
        wishlistId: otherPlacement.wishlistId,
        position: otherPlacement.position,
        categoryId: otherPlacement.categoryId,
      },
    });
  }
}



// ═══════════════════════════════════════════════════════
// TELEGRAM MINI APP ENDPOINTS
// ═══════════════════════════════════════════════════════

// TelegramUser type, INIT_DATA_* constants, validateTelegramInitData,
// tgActorHash, SYSTEM_ACTOR_HASH, and requireTelegramAuth extracted to
// ./services/telegram-auth.ts in P5s-2 (Strategy A). They are imported
// at the top of this file. The Express.Request.tgUser? global type
// augmentation below stays here so it is loaded with the app entry
// point and visible to every module that reads `req.tgUser` at compile
// time (routes/* declare their own structural narrows for the
// `getOrCreateTgUser` dep contract; the augmentation is what makes
// `req.tgUser!` usable in those structural types).
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { tgUser?: TelegramUser; }
  }
}

// ─── Plan & Entitlement System ──────────────────────────────────────────────
// All identifiers (PLANS, PRO_*, GIFT_NOTES_*, GROUP_GIFT_*, SECRET_RESERVATION_*,
// ONE_TIME_SKUS, ADDON_CAPS, types, isReservationBeta, hasReservationPro,
// getSmartResLeadHours, hasSmartReservations, getUserEntitlement,
// getEffectiveEntitlements, isWishlistWritable) extracted to
// ./services/entitlement.ts in P5s-1 (Strategy A). They are imported at
// the top of this file and continue to flow through router/scheduler
// factory deps unchanged. `requireGiftNotes` stays here below because
// it depends on `trackEvent`, which is also still in this file.

/** Gate helper: Gift Notes feature required */
function requireGiftNotes(ent: Awaited<ReturnType<typeof getEffectiveEntitlements>>, res: any): boolean {
  if (!ent.hasGiftNotes) {
    trackEvent('feature_gate_hit_gift_notes');
    res.status(403).json({ error: 'gift_notes_required' });
    return false;
  }
  return true;
}

/** Compute next occurrence date. Handles Feb29 + day>daysInMonth */
function getNextOccurrenceDate(eventDate: Date, recurrence: string): Date | null {
  if (recurrence === 'NONE') return eventDate;
  const now = new Date();
  const nowStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const [nowY, nowM, nowD] = nowStr.split('-').map(Number) as [number, number, number];
  const todayNum = nowY * 10000 + nowM * 100 + nowD;
  const evM = eventDate.getUTCMonth() + 1;
  const evD = eventDate.getUTCDate();
  if (recurrence === 'YEARLY') {
    for (let y = nowY; y <= nowY + 1; y++) {
      const dim = new Date(y, evM, 0).getDate();
      const day = Math.min(evD, dim);
      if (y * 10000 + evM * 100 + day >= todayNum) return new Date(Date.UTC(y, evM - 1, day));
    }
  }
  if (recurrence === 'MONTHLY') {
    for (let offset = 0; offset <= 1; offset++) {
      const m = nowM + offset;
      const y = nowY + Math.floor((m - 1) / 12);
      const mN = ((m - 1) % 12) + 1;
      const dim = new Date(y, mN, 0).getDate();
      const day = Math.min(evD, dim);
      if (y * 10000 + mN * 100 + day >= todayNum) return new Date(Date.UTC(y, mN - 1, day));
    }
  }
  return eventDate;
}

// Analytics / logging stub
function trackEvent(event: string, userId?: string, props?: Record<string, unknown>) {
  logger.info({ event, userId, props }, 'analytics event');
  // Persist to DB for god-mode analytics: feature gate hits, onboarding, demo item, and error events.
  // Fire-and-forget — never blocks the request path.
  const shouldPersist =
    event.startsWith('feature_gate_hit_') ||
    event.startsWith('onboarding_') ||
    event.startsWith('demo_item_') ||
    event.startsWith('gift_') ||
    event.startsWith('first_share_prompt_') ||
    event.startsWith('ready_share_prompt_') ||
    event.startsWith('group_gift_') ||
    event.startsWith('secret_res.') ||
    event.startsWith('showcase.') ||
    event.startsWith('public_profile.') ||
    event.startsWith('error:');
  if (shouldPersist && userId) {
    prisma.analyticsEvent
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .create({ data: { event, userId, props: props ? (props as any) : undefined } })
      .catch((e) => logger.debug({ err: e, event }, 'analytics write failed'));
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// ── Product analytics event helper ──────────────────────────────────────────
// Allowlist is sourced from @wishlist/shared so API + frontend + any other
// consumer stay in sync. Adding a new event: add it to packages/shared/src/
// analyticsEvents.ts and rebuild shared. Events not in this set are silently
// dropped — gate intentionally keeps the AnalyticsEvent table schemaful.
const ANALYTICS_EVENTS_SET = new Set<string>(ANALYTICS_EVENTS);

function trackAnalyticsEvent(params: {
  event: string;
  userId?: string;
  props?: Record<string, unknown>;
}): void {
  if (!ANALYTICS_EVENTS_SET.has(params.event)) return;
  let props = params.props;
  if (props) {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      cleaned[k] = typeof v === 'string' && v.length > 300 ? v.slice(0, 300) + '...' : v;
    }
    const ser = JSON.stringify(cleaned);
    props = ser.length > 1024 ? { _truncated: true } : cleaned;
  }
  prisma.analyticsEvent.create({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    data: { event: params.event, userId: params.userId ?? null, props: props ? (props as any) : undefined },
  }).catch((e) => logger.debug({ err: e, event: params.event }, 'analytics write failed'));
}
// ─────────────────────────────────────────────────────────────────────────────

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
async function notifyReferralInviterRewarded(inviterUserId: string, daysGranted: number): Promise<void> {
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
async function runReferralProgressHook(
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
// ─────────────────────────────────────────────────────────────────────────────

// ─── Onboarding Engine ────────────────────────────────────────────────────────

type VariantKey = 'wildberries' | 'goldapple' | 'ozon' | 'yandex_market' | 'amazon' | 'zalando' | 'sephora' | 'apple';
type MarketSegment = 'ru' | 'global';
type CompletionReason =
  | 'demo_converted'
  | 'real_item_created'
  | 'demo_deleted_then_real_created'
  | 'demo_moved_to_user_wishlist'
  | 'try_import_completed'
  | 'catalog_selected'
  | 'manual_created';

const ONBOARDING_KEY = 'hello_activation';
const ONBOARDING_VERSION = 1;
const RU_VARIANTS: VariantKey[]     = ['wildberries', 'goldapple', 'ozon', 'yandex_market'];
const GLOBAL_VARIANTS: VariantKey[] = ['amazon', 'zalando', 'sephora', 'apple'];

/** Derive market segment from resolved locale. */
function resolveMarketSegment(locale: Locale): MarketSegment {
  return locale === 'ru' ? 'ru' : 'global';
}

/** Derive segment from a stored variantKey (for call-sites that only have the key). */
function variantKeyToSegment(variantKey: string): MarketSegment {
  return (GLOBAL_VARIANTS as string[]).includes(variantKey) ? 'global' : 'ru';
}

// Centralised forced-rollout gate. actorHashes in this set bypass real-item eligibility check.
// entryPoint is always overridden to 'forced_rollout_test' for these users.
const FORCED_ROLLOUT_USERS = new Set<string>(
  (process.env.ONBOARDING_FORCED_USERS ?? '').split(',').filter(Boolean)
);

// Onboarding v2 is now the default for ALL new users.
// A/B experiment concluded — v2_try won and became the main flow.
// Historical variants (v1_demo) are still supported for users already assigned to them.
function assignOnboardingVariant(_telegramId?: string): { variant: OnboardingVariant; source: 'rollout_config' } {
  return { variant: 'v2_try', source: 'rollout_config' };
}

interface DemoItemTemplate {
  title: string;
  url: string;
  price: number;
  currency: 'RUB' | 'USD';
  priority: 'MEDIUM';
  imageUrl: string;
  description: string;
}

// Demo item templates — verbatim agreed content. Do not abbreviate URLs or descriptions.
type RuVariantKey = 'wildberries' | 'goldapple' | 'ozon' | 'yandex_market';
const DEMO_ITEMS: Record<RuVariantKey, DemoItemTemplate> = {
  wildberries: {
    title: 'Подарочный сертификат Wildberries',
    url: 'https://www.wildberries.ru/gift/certificates',
    price: 5000,
    currency: 'RUB',
    priority: 'MEDIUM',
    imageUrl: '/onboarding/wb-cert.jpg',
    description:
      'Это хороший подарок на любой повод: день рождения, да и просто так. Сертификат можно потратить на любые покупки на Wildberries, кроме нового сертификата. И каждый найдёт то, что ему по душе.',
  },
  goldapple: {
    title: 'Подарочный сертификат Золотое Яблоко',
    url: 'https://goldapple.ru/cards?srsltid=AfmBOoptUMZa5NGi5PprPHvbcFkRKveW0MDLqc62SrbWenwhpxr1y2H3',
    price: 5000,
    currency: 'RUB',
    priority: 'MEDIUM',
    imageUrl: '/onboarding/goldapple-cert.jpg',
    description:
      'Это хороший подарок на любой повод: день рождения, да и просто так. Сертификат можно потратить на любые покупки в Золотом Яблоке, кроме нового сертификата. И каждый найдёт то, что ему по душе.',
  },
  ozon: {
    title: 'Подарочный сертификат Ozon',
    url: 'https://www.ozon.ru/landing/giftcertificates/?__rr=1',
    price: 5000,
    currency: 'RUB',
    priority: 'MEDIUM',
    imageUrl: '/onboarding/ozon-cert.jpg',
    description:
      'Это хороший подарок на любой повод: день рождения, да и просто так. Сертификат можно потратить на любые покупки на Ozon, кроме нового сертификата. И каждый найдёт то, что ему по душе.',
  },
  yandex_market: {
    title: 'Подарочный сертификат Яндекс Маркет',
    url: 'https://market.yandex.ru/card/podarochnyy-sertifikat-yandeks-market-elektronnyy/103670724746?do-waremd5=n5Az0T5R47tdLDQ0qAMd5Q&ogV=-12',
    price: 5000,
    currency: 'RUB',
    priority: 'MEDIUM',
    imageUrl: '/onboarding/ym-cert.jpg',
    description:
      'Это хороший подарок на любой повод: день рождения, да и просто так. Сертификат можно потратить на любые покупки на Яндекс Маркете, кроме нового сертификата. И каждый найдёт то, что ему по душе.',
  },
};

const GLOBAL_DEMO_ITEMS: Record<string, DemoItemTemplate> = {
  amazon: {
    title: 'Amazon Gift Card',
    url: 'https://www.amazon.com/dp/B004LLIKVU',
    price: 50,
    currency: 'USD',
    priority: 'MEDIUM',
    imageUrl: '/onboarding/global/amazon-gift-card.jpg',
    description:
      'A great gift for any occasion. The recipient can choose exactly what they want from millions of products on Amazon.',
  },
  zalando: {
    title: 'Zalando Gift Voucher',
    url: 'https://www.zalando.co.uk/giftvouchers/',
    price: 50,
    currency: 'USD',
    priority: 'MEDIUM',
    imageUrl: '/onboarding/global/zalando-gift-card.jpg',
    description:
      'A stylish and flexible gift. Perfect for fashion, shoes, accessories and more on Zalando.',
  },
  sephora: {
    title: 'Sephora Gift Card',
    url: 'https://www.sephora.com/gift-cards',
    price: 50,
    currency: 'USD',
    priority: 'MEDIUM',
    imageUrl: '/onboarding/global/sephora-gift-card.jpg',
    description:
      'A beauty gift that works for almost any occasion. Great for skincare, makeup, fragrance and self-care essentials.',
  },
  apple: {
    title: 'Apple Gift Card',
    url: 'https://www.apple.com/shop/buy-giftcard/giftcard',
    price: 50,
    currency: 'USD',
    priority: 'MEDIUM',
    imageUrl: '/onboarding/global/apple-gift-card.jpg',
    description:
      'A premium digital gift for apps, devices, accessories, entertainment and more across the Apple ecosystem.',
  },
};

/** Look up demo template from either pool by variantKey. */
function getDemoTemplate(variantKey: string): DemoItemTemplate | undefined {
  return (DEMO_ITEMS as Record<string, DemoItemTemplate>)[variantKey] ?? GLOBAL_DEMO_ITEMS[variantKey];
}

/** Count real items for the given user across all wishlists. */
async function countRealItemsForActivation(userId: string): Promise<number> {
  return prisma.item.count({
    where: {
      wishlist: { ownerId: userId },
      isDemo: false,
      originType: { not: 'DEMO' },
      status: { notIn: ['DELETED', 'PURCHASED', 'COMPLETED'] },
    },
  });
}

/** True if SYSTEM_DRAFTS contains any real (non-demo) items for this user. */
async function hasDraftsUserContent(userId: string): Promise<boolean> {
  const count = await prisma.item.count({
    where: {
      wishlist: { ownerId: userId, type: 'SYSTEM_DRAFTS' },
      isDemo: false,
      originType: { not: 'DEMO' },
      status: { notIn: ['DELETED', 'PURCHASED', 'COMPLETED'] },
    },
  });
  return count > 0;
}

type EligibilityResult = {
  eligible: boolean;
  reason: string;
  forcedRollout: boolean;
  draftsHaveUserContent: boolean;
};

async function checkOnboardingEligibility(
  userId: string,
  actorHash: string,
): Promise<EligibilityResult> {
  const draftsHaveUserContent = await hasDraftsUserContent(userId);

  // Centralised forced-rollout check — always wins, bypasses real-item count.
  if (FORCED_ROLLOUT_USERS.has(actorHash)) {
    return { eligible: true, reason: 'forced_rollout_test', forcedRollout: true, draftsHaveUserContent };
  }

  const state = await prisma.userOnboardingState.findUnique({
    where: { userId_onboardingKey_version: { userId, onboardingKey: ONBOARDING_KEY, version: ONBOARDING_VERSION } },
  });
  if (state?.status === 'COMPLETED') return { eligible: false, reason: 'already_completed', forcedRollout: false, draftsHaveUserContent };
  if (state?.status === 'DISMISSED') return { eligible: false, reason: 'already_dismissed', forcedRollout: false, draftsHaveUserContent };

  const realItemCount = await countRealItemsForActivation(userId);
  if (realItemCount > 0) return { eligible: false, reason: 'has_real_items', forcedRollout: false, draftsHaveUserContent };

  return { eligible: true, reason: 'no_onboarding_state', forcedRollout: false, draftsHaveUserContent };
}

/** True if a demo item has not been meaningfully edited (safe to delete on dismiss). */
function isDemoItemUntouched(
  item: { title: string | null; url: string | null; priceText: string | null; becameRealAt: Date | null },
  template: DemoItemTemplate,
): boolean {
  if (item.becameRealAt !== null) return false;
  if (item.title !== template.title) return false;
  if (item.url !== template.url) return false;
  const itemPrice = item.priceText ? Number(item.priceText) : null;
  if (itemPrice !== template.price) return false;
  return true;
}

/** True if any meaningful field differs from the original demo template. */
function isMeaningfulEdit(
  update: { title?: string; url?: string | null; price?: number | null; description?: string | null },
  template: DemoItemTemplate,
): boolean {
  if (update.title !== undefined && update.title !== template.title) return true;
  if (update.url !== undefined && update.url !== template.url) return true;
  if (update.price !== undefined && update.price !== template.price) return true;
  if (update.description !== undefined && update.description !== template.description) return true;
  return false;
}

/** Complete the onboarding for a user. Idempotent — no-op if already COMPLETED/DISMISSED.
 *  Always fires 'onboarding_completed' analytics event on the first (real) completion. */
async function completeOnboarding(userId: string, reason: CompletionReason): Promise<void> {
  const state = await prisma.userOnboardingState.findUnique({
    where: { userId_onboardingKey_version: { userId, onboardingKey: ONBOARDING_KEY, version: ONBOARDING_VERSION } },
  });
  if (!state || state.status === 'COMPLETED' || state.status === 'DISMISSED') return;

  const meta = getOnboardingMeta(state.metaJson);
  const now = new Date();
  await prisma.userOnboardingState.update({
    where: { id: state.id },
    data: { status: 'COMPLETED', completedAt: now, completionReason: reason },
  });

  // Set becameRealAt only when the demo item itself was meaningfully converted.
  if (reason === 'demo_converted' && state.demoItemId) {
    await prisma.item.updateMany({
      where: { id: state.demoItemId, isDemo: true },
      data: { becameRealAt: now },
    });
  }

  // Analytics — fires exactly once per completion (guard above prevents re-entry).
  const isLegacyV1 = (meta.onboardingVariant ?? 'v1_demo') === 'v1_demo';
  trackEvent('onboarding_completed', userId, {
    onboarding_key: ONBOARDING_KEY,
    version: ONBOARDING_VERSION,
    variant_key: state.variantKey ?? null,
    entry_point: state.entryPoint ?? null,
    completion_reason: reason,
    forced_rollout: FORCED_ROLLOUT_USERS.has(userId),
    market_segment: state.variantKey ? variantKeyToSegment(state.variantKey) : 'ru',
    onboarding_variant: meta.onboardingVariant ?? 'v1_demo',
    acquisition_path: meta.acquisitionPath ?? null,
    experiment_phase: isLegacyV1 ? 'legacy_recovery' : 'post_rollout',
    onboarding_flow: isLegacyV1 ? 'v1_demo_recovery' : 'main_v2',
  });
}

// ─── end Onboarding Engine helpers ───────────────────────────────────────────

/** Extract numeric price from formatted string like "51 975 ₽" → "51975" */
function extractNumericPrice(priceText: string | null): string | null {
  if (!priceText) return null;
  // Remove currency symbols, spaces, non-breaking spaces
  const digits = priceText.replace(/[^\d.,]/g, '').replace(',', '.');
  if (!digits) return null;
  const num = parseFloat(digits);
  return isNaN(num) ? null : String(num);
}

function priorityToNum(p: 'LOW' | 'MEDIUM' | 'HIGH'): 1 | 2 | 3 {
  return p === 'LOW' ? 1 : p === 'HIGH' ? 3 : 2;
}
function numToPriority(n: number): 'LOW' | 'MEDIUM' | 'HIGH' {
  return n === 1 ? 'LOW' : n === 3 ? 'HIGH' : 'MEDIUM';
}

function mapTgItem(item: {
  id: string;
  wishlistId: string;
  title: string;
  url: string;
  priceText: string | null;
  currency?: string;
  imageUrl?: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  position?: number;
  status: string;
  description?: string | null;
  sourceUrl?: string | null;
  sourceDomain?: string | null;
  importMethod?: string | null;
}) {
  return {
    id: item.id,
    wishlistId: item.wishlistId,
    title: item.title,
    url: item.url || null,
    price: item.priceText ? (Number(item.priceText) || null) : null,
    currency: item.currency ?? null,
    imageUrl: item.imageUrl ?? null,
    priority: priorityToNum(item.priority),
    position: item.position ?? 0,
    status: item.status.toLowerCase(),
    description: item.description ?? null,
    sourceUrl: item.sourceUrl ?? null,
    sourceDomain: item.sourceDomain ?? null,
    importMethod: item.importMethod ?? null,
  };
}

// getOrCreateTgUser extracted to ./services/telegram-auth.ts in P5s-2.
// Imported at the top of this file and continues passing through router
// factory deps unchanged.

// getOrCreateProfile lives in ./profile (see comment above generateUniqueSupportId).

type ItemRole = 'owner' | 'reserver' | 'third_party';

async function getItemRole(
  itemId: string,
  tgUser: TelegramUser,
): Promise<{
  role: ItemRole;
  item: { id: string; status: string; reservationEpoch: number; reserverUserId: string | null; title: string; wishlist: { ownerId: string }; reservationEvents: { actorHash: string; comment: string | null }[] };
  actorHash: string;
  user: { id: string; telegramChatId: string | null };
} | null> {
  const actorHash = tgActorHash(tgUser.id);
  const user = await getOrCreateTgUser(tgUser);

  const item = await prisma.item.findUnique({
    where: { id: itemId },
    select: {
      id: true, status: true, reservationEpoch: true, reserverUserId: true, title: true,
      wishlist: { select: { ownerId: true } },
      reservationEvents: {
        where: { type: 'RESERVED' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { actorHash: true, comment: true },
      },
    },
  });
  if (!item) return null;

  if (item.wishlist.ownerId === user.id) {
    return { role: 'owner', item, actorHash, user };
  }

  if (
    item.status === 'RESERVED' &&
    item.reservationEvents.length > 0 &&
    secureCompare(item.reservationEvents[0]!.actorHash, actorHash)
  ) {
    return { role: 'reserver', item, actorHash, user };
  }

  return { role: 'third_party', item, actorHash, user };
}

// IP-throttle gate: short-circuits with 429 if this IP has tripped the
// `auth_rejected` threshold (10 failures / 60 s → 5 min cool-off). Runs
// BEFORE requireTelegramAuth so we don't burn HMAC validation on a known-bad
// IP. The trigger itself is fed from inside requireTelegramAuth's 401 branch.
tgRouter.use(ipThrottleGate(['auth_rejected']));

tgRouter.use(requireTelegramAuth);

// Persist raw Telegram language_code + derived segmentation fields on every authenticated request.
// Fields updated: language (raw), normalizedLocale, marketBucket, supportedImportRegion.
// Fire-and-forget: does not block the request path. Uses IS DISTINCT FROM to skip redundant writes.
tgRouter.use((req, _res, next) => {
  if (req.tgUser?.language_code != null) {
    const telegramId = String(req.tgUser.id);
    const rawLang = req.tgUser.language_code;
    const normLocale = normalizeLocale(rawLang);
    const bucket = deriveMarketBucket(rawLang);
    const importRegion = isSupportedImportRegion(bucket);
    prisma.$executeRawUnsafe(
      `UPDATE "UserProfile"
       SET language = $1,
           "normalizedLocale" = $3,
           "marketBucket" = $4,
           "supportedImportRegion" = $5
       WHERE "userId" = (SELECT id FROM "User" WHERE "telegramId" = $2)
         AND (language IS DISTINCT FROM $1
              OR "normalizedLocale" IS DISTINCT FROM $3
              OR "marketBucket" IS DISTINCT FROM $4
              OR "supportedImportRegion" IS DISTINCT FROM $5)`,
      rawLang,
      telegramId,
      normLocale,
      bucket,
      importRegion,
    ).catch(() => {});
  }
  next();
});

// Error-tracking middleware — records 4xx/5xx responses to AnalyticsEvent.
// Fires on res.on('finish') so it never blocks the request path.
// Includes 401 for auth failure visibility. Event format:
//   error:{METHOD}:{STATUS}:{route}   e.g. error:POST:402:/tg/items
// Route uses req.route.path (Express pattern) so IDs are grouped (:id, :campaignId, …).
tgRouter.use((req, res, next) => {
  res.on('finish', () => {
    const status = res.statusCode;
    if (status >= 400) {
      // Skip internal watchdog health probes — they intentionally trigger a 401
      // (no init data) to verify the route is reachable, and would otherwise
      // dominate error:* metrics (~200/day on /tg/bootstrap).
      if (req.headers['x-watchdog'] === '1') return;

      const route = req.route?.path ? (req.baseUrl + req.route.path) : req.path;

      // Skip known-noise legitimate rejections so error:* events stay
      // signal-only and any future "error rate spike" alarm doesn't false-fire:
      //   • 429 on /telemetry — rate limiter doing its job (5 batches/min
      //     × 20 events = 100 events/min, exceeded only on rapid back-button
      //     mashing or spam clicks). Not a code bug.
      //   • 403 on item comments for guest viewers — third_party role doesn't
      //     have access by design (comments are private to owner+reserver).
      //     Frontend swallows the 403 and renders an empty comment list.
      if (status === 429 && route === '/tg/telemetry') return;
      if (status === 403 && route === '/tg/items/:id/comments') return;

      const method = req.method;
      const userId = req.tgUser?.id != null ? String(req.tgUser.id) : null;
      prisma.analyticsEvent.create({
        data: { event: `error:${method}:${status}:${route}`, userId },
      }).catch(() => {});
    }
  });
  next();
});

// ─── Wave 1 P0 security protections ──────────────────────────────────────────
// Order on /tg/* state-changing routes:
//   ipThrottleGate(['auth_rejected'])  ← runs BEFORE auth (registered earlier)
//   requireTelegramAuth                ← already wired
//   localeTracking + errorTracking     ← already wired (unchanged)
//   global.auth limiter                ← THIS BLOCK
//   state.changing limiter             ← THIS BLOCK
//   per-endpoint category limiter      ← protectTgRoute(...) entries
//   idempotency middleware             ← protectTgRoute(...) entries
//   route handler                      ← unchanged
//
// Why it's all here, far above the route declarations: tgRouter middleware
// runs in registration order. We need every protective layer registered
// BEFORE the first `tgRouter.post(...)` (which lives ~line 5500+). The
// monolith file is already 20 k lines — slotting these in here keeps the
// per-route handlers below untouched.

// Global auth limiter: 300 req / 5 min per actorHash. Catches accidental
// loops in the Mini App without throttling normal usage (300 req / 5 min ≈
// 1 req/sec sustained — way above what a human can drive).
tgRouter.use(createRateLimiter('global.auth'));

// State-changing limiter: 60 POST/PATCH/DELETE / 5 min per actorHash.
// Read-only paths bypass for free.
const stateChangingLimiter = createRateLimiter('state.changing');
tgRouter.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  return stateChangingLimiter(req, res, next);
});

// protectTgRoute — register a method-and-path-scoped middleware stack on
// tgRouter using `.all()` (Express runs all matching handlers in registration
// order). The wrapper short-circuits non-matching methods so a single path
// pattern can carry protection for one method while leaving others alone.
type TgMethod = 'POST' | 'PATCH' | 'DELETE';
function protectTgRoute(method: TgMethod, path: string, ...mws: import('express').RequestHandler[]) {
  tgRouter.all(path, (req, res, next) => {
    if (req.method !== method) return next();
    let i = 0;
    const runNext = (err?: unknown) => {
      if (err) return next(err as Error);
      if (i >= mws.length) return next();
      const mw = mws[i++]!;
      try { mw(req, res, runNext); } catch (e) { runNext(e); }
    };
    runNext();
  });
}

// Convenience builders. `idem(endpointKey, opts?)` defaults the category to
// the endpointKey (which is unique anyway) so call sites stay short.
const idem = (endpointKey: string, opts?: { category?: string; noResponseReplay?: boolean; ttlMinutes?: number; critical?: boolean }) =>
  createIdempotencyMiddleware({
    endpointKey,
    category: opts?.category ?? endpointKey,
    noResponseReplay: opts?.noResponseReplay,
    ttlMinutes: opts?.ttlMinutes,
    critical: opts?.critical,
  });

// Billing/Stars: 7-day TTL + critical=true (logs missing header for monitoring
// without blocking — soft-require during rollout).
const billingIdem = (endpointKey: string) =>
  createIdempotencyMiddleware({
    endpointKey,
    category: 'payment',
    ttlMinutes: IDEMPOTENCY_BILLING_TTL_MINUTES,
    critical: true,
  });

// ── Wishlists ────────────────────────────────────────────────────────────────
protectTgRoute('POST',   '/wishlists',                       createRateLimiter('wishlist.create'), idem('POST /tg/wishlists', { category: 'wishlist.create' }));
protectTgRoute('PATCH',  '/wishlists/:id',                   idem('PATCH /tg/wishlists/:id', { category: 'wishlist.update' }));
protectTgRoute('DELETE', '/wishlists/:id',                   idem('DELETE /tg/wishlists/:id', { category: 'wishlist.delete' }));
protectTgRoute('POST',   '/wishlists/:id/archive',           idem('POST /tg/wishlists/:id/archive', { category: 'wishlist.state' }));
protectTgRoute('POST',   '/wishlists/:id/unarchive',         idem('POST /tg/wishlists/:id/unarchive', { category: 'wishlist.state' }));
protectTgRoute('POST',   '/wishlists/:id/transfer-items',    idem('POST /tg/wishlists/:id/transfer-items', { category: 'wishlist.update' }));
protectTgRoute('POST',   '/wishlists/reorder',               idem('POST /tg/wishlists/reorder', { category: 'wishlist.update' }));

// ── Wishlist categories (Pro feature) — Wave-2 P2 ────────────────────────────
// Categories CRUD live under /wishlists/:id/categories[/:catId]. Wishlist-
// rooted, but the handlers ship from wishlistsRouter (routes/wishlists.routes
// .ts) — the protectTgRoute(...) tgRouter.all() registration here fires
// before sub-router dispatch, same shape as the rest of the wishlists block.
// Plain `state.changing` rate-limiter (already on tgRouter) is enough — no
// burst/consensus risk; idem prevents double-tap replay during reorder.
protectTgRoute('POST',   '/wishlists/:id/categories',                  idem('POST /tg/wishlists/:id/categories', { category: 'wishlist.category' }));
protectTgRoute('POST',   '/wishlists/:id/categories/reorder',          idem('POST /tg/wishlists/:id/categories/reorder', { category: 'wishlist.category' }));
protectTgRoute('PATCH',  '/wishlists/:wlId/categories/:catId',         idem('PATCH /tg/wishlists/:wlId/categories/:catId', { category: 'wishlist.category' }));
protectTgRoute('DELETE', '/wishlists/:wlId/categories/:catId',         idem('DELETE /tg/wishlists/:wlId/categories/:catId', { category: 'wishlist.category' }));

// ── Items (single) ───────────────────────────────────────────────────────────
protectTgRoute('POST',   '/wishlists/:id/items',             createRateLimiter('item.create'), idem('POST /tg/wishlists/:id/items', { category: 'item.create' }));
protectTgRoute('PATCH',  '/items/:id',                       idem('PATCH /tg/items/:id', { category: 'item.update' }));
protectTgRoute('DELETE', '/items/:id',                       idem('DELETE /tg/items/:id', { category: 'item.delete' }));
protectTgRoute('POST',   '/items/:id/complete',              idem('POST /tg/items/:id/complete', { category: 'item.state' }));
protectTgRoute('POST',   '/items/:id/restore',               idem('POST /tg/items/:id/restore', { category: 'item.state' }));
protectTgRoute('POST',   '/items/:id/photo',                 idem('POST /tg/items/:id/photo', { category: 'item.photo', noResponseReplay: true }));
protectTgRoute('DELETE', '/items/:id/photo',                 idem('DELETE /tg/items/:id/photo', { category: 'item.photo' }));
protectTgRoute('POST',   '/items/:id/placements',            idem('POST /tg/items/:id/placements', { category: 'item.update' }));
protectTgRoute('DELETE', '/items/:id/placements/:wishlistId', idem('DELETE /tg/items/:id/placements/:wishlistId', { category: 'item.update' }));

// ── Items (bulk) ─────────────────────────────────────────────────────────────
// All bulk endpoints share the item.bulk limiter (10 / 10 min) so a single
// burst can't run several batches in succession.
protectTgRoute('POST',   '/items/bulk-move',                 createRateLimiter('item.bulk'), idem('POST /tg/items/bulk-move', { category: 'item.bulk' }));
protectTgRoute('POST',   '/items/bulk-delete',               createRateLimiter('item.bulk'), idem('POST /tg/items/bulk-delete', { category: 'item.bulk' }));
protectTgRoute('POST',   '/items/bulk-archive',              createRateLimiter('item.bulk'), idem('POST /tg/items/bulk-archive', { category: 'item.bulk' }));
protectTgRoute('POST',   '/items/bulk-restore',              createRateLimiter('item.bulk'), idem('POST /tg/items/bulk-restore', { category: 'item.bulk' }));
protectTgRoute('POST',   '/items/bulk-copy',                 createRateLimiter('item.bulk'), idem('POST /tg/items/bulk-copy', { category: 'item.bulk' }));
protectTgRoute('POST',   '/items/bulk-hard-delete',          createRateLimiter('item.bulk'), idem('POST /tg/items/bulk-hard-delete', { category: 'item.bulk' }));

// ── Reservations ─────────────────────────────────────────────────────────────
// Reserve gets BOTH limiters (short burst + daily cap). Other reservation
// actions just get the short-window limiter.
protectTgRoute('POST',   '/items/:id/reserve',               ...combineLimiters('reservation.short', 'reservation.day'), idem('POST /tg/items/:id/reserve', { category: 'reservation' }));
protectTgRoute('POST',   '/items/:id/unreserve',             createRateLimiter('reservation.short'), idem('POST /tg/items/:id/unreserve', { category: 'reservation' }));
protectTgRoute('POST',   '/items/:id/secret-reserve',        createRateLimiter('reservation.short'), idem('POST /tg/items/:id/secret-reserve', { category: 'reservation' }));
protectTgRoute('POST',   '/items/:id/extend-reservation',    createRateLimiter('reservation.short'), idem('POST /tg/items/:id/extend-reservation', { category: 'reservation' }));
protectTgRoute('POST',   '/secret-reservations/:id/cancel',      idem('POST /tg/secret-reservations/:id/cancel', { category: 'reservation' }));
protectTgRoute('POST',   '/secret-reservations/:id/acknowledge', idem('POST /tg/secret-reservations/:id/acknowledge', { category: 'reservation' }));
protectTgRoute('POST',   '/secret-reservations/:id/promote',     idem('POST /tg/secret-reservations/:id/promote', { category: 'reservation' }));
protectTgRoute('PATCH',  '/reservations/:itemId/meta',           idem('PATCH /tg/reservations/:itemId/meta', { category: 'reservation' }));
protectTgRoute('POST',   '/reservations/:itemId/reminder',       idem('POST /tg/reservations/:itemId/reminder', { category: 'reservation' }));
protectTgRoute('DELETE', '/reservations/:itemId/reminder',       idem('DELETE /tg/reservations/:itemId/reminder', { category: 'reservation' }));

// ── Comments ─────────────────────────────────────────────────────────────────
// `comment.minute` + `comment.hour` together cap both bursts and totals.
protectTgRoute('POST',   '/items/:id/comments',                  ...combineLimiters('comment.minute', 'comment.hour'), idem('POST /tg/items/:id/comments', { category: 'comment' }));
protectTgRoute('DELETE', '/items/:id/comments/:commentId',       idem('DELETE /tg/items/:id/comments/:commentId', { category: 'comment' }));

// ── Share / Selections / Subscriptions ───────────────────────────────────────
protectTgRoute('POST',   '/wishlists/:id/share-token',           createRateLimiter('share.hour'), idem('POST /tg/wishlists/:id/share-token', { category: 'share' }));
protectTgRoute('DELETE', '/wishlists/:id/share-token',           idem('DELETE /tg/wishlists/:id/share-token', { category: 'share' }));
protectTgRoute('POST',   '/wishlists/:id/selections',            createRateLimiter('share.hour'), idem('POST /tg/wishlists/:id/selections', { category: 'share' }));
protectTgRoute('DELETE', '/selections/:id',                      idem('DELETE /tg/selections/:id', { category: 'share' }));
protectTgRoute('POST',   '/selections/:id/subscribe',            idem('POST /tg/selections/:id/subscribe', { category: 'subscribe' }));
protectTgRoute('DELETE', '/selections/:id/subscribe',            idem('DELETE /tg/selections/:id/subscribe', { category: 'subscribe' }));
protectTgRoute('POST',   '/wishlists/:id/subscribe',             idem('POST /tg/wishlists/:id/subscribe', { category: 'subscribe' }));
protectTgRoute('DELETE', '/wishlists/:id/subscribe',             idem('DELETE /tg/wishlists/:id/subscribe', { category: 'subscribe' }));
// Profile subscribe (Wave-2 P2). Frontend already passes
// `idempotency: { action: 'profile.(un)subscribe:<username>' }` for both
// directions — adding the middleware closes the loop on the server side.
protectTgRoute('POST',   '/profiles/:username/subscribe',        idem('POST /tg/profiles/:username/subscribe', { category: 'subscribe' }));
protectTgRoute('DELETE', '/profiles/:username/subscribe',        idem('DELETE /tg/profiles/:username/subscribe', { category: 'subscribe' }));

// ── Billing / Stars (7-day TTL, critical=true logs missing key) ──────────────
// Recovery rule: the rate limiter sits ONLY on /checkout endpoints. /sync
// stays unlimited so a user who paid but didn't see PRO activate can keep
// refreshing without hitting 429. Idempotency on /sync replays the same
// answer for the same key, so retries are cheap and safe.
protectTgRoute('POST',   '/billing/pro/checkout',                createRateLimiter('payment'), billingIdem('POST /tg/billing/pro/checkout'));
protectTgRoute('POST',   '/billing/pro/sync',                    billingIdem('POST /tg/billing/pro/sync'));
protectTgRoute('POST',   '/billing/subscription/cancel',         billingIdem('POST /tg/billing/subscription/cancel'));
protectTgRoute('POST',   '/billing/subscription/reactivate',     billingIdem('POST /tg/billing/subscription/reactivate'));
protectTgRoute('POST',   '/billing/addon/checkout',              createRateLimiter('payment'), billingIdem('POST /tg/billing/addon/checkout'));
protectTgRoute('POST',   '/billing/addon/sync',                  billingIdem('POST /tg/billing/addon/sync'));
protectTgRoute('POST',   '/billing/gift-notes/checkout',         createRateLimiter('payment'), billingIdem('POST /tg/billing/gift-notes/checkout'));
protectTgRoute('POST',   '/billing/gift-notes/sync',             billingIdem('POST /tg/billing/gift-notes/sync'));

// ── Onboarding (intentionally NO narrow rate limit) ──────────────────────────
// Telegram Mini App may re-fire /onboarding/start on bootstrap or reopen.
// global.auth + state.changing already cover the upper bound — adding a
// tighter category here would cause spurious 429s on legitimate first-opens.
// Idempotency alone prevents duplicate demo-item creation, which is the
// real risk on these endpoints.
protectTgRoute('POST',   '/onboarding/start',                    idem('POST /tg/onboarding/start', { category: 'onboarding' }));
protectTgRoute('POST',   '/onboarding/dismiss',                  idem('POST /tg/onboarding/dismiss', { category: 'onboarding' }));
protectTgRoute('POST',   '/onboarding/complete',                 idem('POST /tg/onboarding/complete', { category: 'onboarding' }));
protectTgRoute('POST',   '/onboarding/manual-add',               idem('POST /tg/onboarding/manual-add', { category: 'onboarding' }));
protectTgRoute('POST',   '/onboarding/catalog-select',           idem('POST /tg/onboarding/catalog-select', { category: 'onboarding' }));
protectTgRoute('POST',   '/onboarding/update-step',              idem('POST /tg/onboarding/update-step', { category: 'onboarding' }));
protectTgRoute('POST',   '/onboarding/create-wishlist',          idem('POST /tg/onboarding/create-wishlist', { category: 'onboarding' }));
protectTgRoute('POST',   '/onboarding/try-import',               idem('POST /tg/onboarding/try-import', { category: 'onboarding' }));

// ── Group gifts ──────────────────────────────────────────────────────────────
protectTgRoute('POST',   '/items/:id/group-gift',                idem('POST /tg/items/:id/group-gift', { category: 'groupgift' }));
protectTgRoute('POST',   '/group-gifts/:id/join',                idem('POST /tg/group-gifts/:id/join', { category: 'groupgift' }));
protectTgRoute('PATCH',  '/group-gifts/:id/amount',              idem('PATCH /tg/group-gifts/:id/amount', { category: 'groupgift' }));
protectTgRoute('POST',   '/group-gifts/:id/leave',               idem('POST /tg/group-gifts/:id/leave', { category: 'groupgift' }));
protectTgRoute('POST',   '/group-gifts/:id/complete',            idem('POST /tg/group-gifts/:id/complete', { category: 'groupgift' }));
protectTgRoute('POST',   '/group-gifts/:id/cancel',              idem('POST /tg/group-gifts/:id/cancel', { category: 'groupgift' }));
protectTgRoute('PATCH',  '/group-gifts/:id/pinned',              idem('PATCH /tg/group-gifts/:id/pinned', { category: 'groupgift' }));
protectTgRoute('POST',   '/group-gifts/:id/messages',            idem('POST /tg/group-gifts/:id/messages', { category: 'groupgift' }));

// ── Profile / Settings / Showcase / Avatar / Cover ──────────────────────────
// Avatar/cover use multipart — noResponseReplay=true: we lock the key but
// don't try to cache the response body. A retry with the same key returns
// 409 IDEMPOTENCY_RESPONSE_NOT_REPLAYABLE; the client should verify state.
protectTgRoute('PATCH',  '/me/profile',                          idem('PATCH /tg/me/profile', { category: 'profile.update' }));
protectTgRoute('POST',   '/me/profile/avatar',                   idem('POST /tg/me/profile/avatar', { category: 'profile.upload', noResponseReplay: true }));
protectTgRoute('DELETE', '/me/profile/avatar',                   idem('DELETE /tg/me/profile/avatar', { category: 'profile.update' }));
protectTgRoute('PATCH',  '/me/showcase',                         idem('PATCH /tg/me/showcase', { category: 'profile.update' }));
protectTgRoute('POST',   '/me/showcase/cover',                   idem('POST /tg/me/showcase/cover', { category: 'profile.upload', noResponseReplay: true }));
protectTgRoute('DELETE', '/me/showcase/cover',                   idem('DELETE /tg/me/showcase/cover', { category: 'profile.update' }));
protectTgRoute('PATCH',  '/me/settings',                         idem('PATCH /tg/me/settings', { category: 'profile.update' }));

// ── Birthday Reminders (state-changing routes) ───────────────────────────────
protectTgRoute('PATCH',  '/me/birthday-settings',                 idem('PATCH /tg/me/birthday-settings', { category: 'profile.update' }));
protectTgRoute('POST',   '/birthday-reminders/mute',              idem('POST /tg/birthday-reminders/mute', { category: 'profile.update' }));
protectTgRoute('DELETE', '/birthday-reminders/mute/:userId',      idem('DELETE /tg/birthday-reminders/mute', { category: 'profile.update' }));

// ── Account delete (critical=true; logs missing key for monitoring) ──────────
protectTgRoute('DELETE', '/me/account',                          createIdempotencyMiddleware({ endpointKey: 'DELETE /tg/me/account', category: 'account.delete', critical: true }));
// ─── /Wave 1 P0 protections ──────────────────────────────────────────────────

// ─── /tg/me/* sub-router (P5a split) ────────────────────────────────────────
// Mounted AFTER the protectTgRoute() chain above so that path-scoped
// idempotency / rate-limit middleware (registered as tgRouter.all(...)) fire
// BEFORE any /me handler. Mount form follows admin.routes pattern: paths
// stay byte-identical with /me prefix on every handler, so this is a plain
// `tgRouter.use(meRouter)` without lifting the prefix.
const meRouter = registerMeRouter({
  getOrCreateTgUser,
  getEffectiveEntitlements,
  getUserEntitlement,
  hasReservationPro,
  isReservationBeta,
  trackEvent,
  ACTIVE_STATUSES,
  PRO_PRICE_XTR,
  PRO_YEARLY_PRICE_XTR,
  ONE_TIME_SKUS,
});
tgRouter.use(meRouter);

// ─── /tg/referral/* sub-router (P5b split) ──────────────────────────────────
// All 4 endpoints are GET-only (read), no path-scoped idempotency middleware
// is registered for /referral, so placement here vs after protectTgRoute() is
// behaviourally equivalent. Kept right after meRouter for visual proximity
// to the other extracted /tg sub-routers.
const refRouter = registerRefRouter({
  getOrCreateTgUser,
  trackAnalyticsEvent,
  PRO_PLAN_CODE,
});
tgRouter.use(refRouter);

// ─── /tg/support/* sub-router (P5d split) ───────────────────────────────────
// 2 handlers: GET /support/lookup/:ticketCode (god-mode gated, in-handler) +
// POST /support/tickets (creates ticket, fires 2 best-effort fetch() calls
// to Telegram for support-chat header + user DM). Direct fetch()es are
// preserved byte-identical inside support.routes.ts — refactoring through
// telegram/botApi.ts would change the message_id capture flow that bot
// reply-routing depends on; deferred to a separate PR.
const supportRouter = registerSupportRouter({
  getOrCreateTgUser,
});
tgRouter.use(supportRouter);

// ─── /tg/{calendar,gift-occasions,gift-occasion-ideas}/* sub-router (P5g
//     split — Gift Notes / Events Calendar v2.1 feature) ─────────────────
// 26 handlers across 3 path groups, all sharing the same Pro-gate
// (requireGiftNotes) and the same Prisma table family (GiftOccasion etc).
// All 8 closure deps are hoisted function declarations or early-defined
// consts (lines 128, 593, 669, 689, 727, 1397, 7990, 7999), so wiring
// alongside meRouter / refRouter / supportRouter here is TDZ-safe — no
// relocation downward needed (unlike P5c, P5e, P5f which reference late
// `const` declarations and had to wire post-mount).
//
// Helpers requireGiftNotes / getNextOccurrenceDate / computeReminderSchedule
// / buildReminderEpisodeKey stay in index.ts; they are shared with the
// gift-occasion reminder scheduler/cron at line ~12060+ (uses all three
// reminder helpers when re-scheduling fired reminders for the next
// occurrence). zUrl likewise stays — also used by item/wishlist handlers
// and adminRouter deps.
// ─── Gift-notes (Wave 2 P1) — 17 state-changing endpoints ────────────────────
// 26 handlers total in routes/gift-notes.routes.ts; 7 GET (read-only,
// no protection needed), 19 state-changing. Two read-marker endpoints
// are intentionally NOT protected:
//   - POST /calendar/inbox/:id/read
//   - POST /calendar/inbox/read-all
// Both are fire-and-forget UPSERTs on CalendarInboxEntry.readAt,
// duplicate-safe by design. Same precedent as
// /me/subscriptions/:id/read (docs/API_SECURITY.md § 4 "Out of Wave-2
// scope (by design)"). Mini App `markInboxRead` / `markInboxAllRead`
// helpers in screens/calendar/api.ts intentionally do not pass
// idempotency option.
//
// Registration order: these protectTgRoute entries land BEFORE the
// `tgRouter.use(giftNotesRouter)` mount below so the gate registration
// on tgRouter fires before the sub-router's handler dispatch.
//
// 0 critical-flag endpoints — no billing flows (those are already
// covered by Wave-1 /billing/gift-notes/checkout|sync), no mass-DM
// fan-outs, no distributed-consensus state. All operations are
// user-CRUD with graceful retry semantics.
//
// 0 new rate-limit categories — `state.changing` (60/5min) suffices
// given the typical user flow (~5-30 ops/session, never bursting).
//
// 1 noResponseReplay flag for the multipart photo upload (matches the
// /items/:id/photo precedent — multipart bodies cannot be cleanly
// replayed; second call with same key returns
// IDEMPOTENCY_RESPONSE_NOT_REPLAYABLE).

// Occasions CRUD + state (5)
protectTgRoute('POST',   '/gift-occasions',                            idem('POST /tg/gift-occasions', { category: 'gift-notes.occasion' }));
protectTgRoute('PATCH',  '/gift-occasions/:id',                        idem('PATCH /tg/gift-occasions/:id', { category: 'gift-notes.occasion' }));
protectTgRoute('DELETE', '/gift-occasions/:id',                        idem('DELETE /tg/gift-occasions/:id', { category: 'gift-notes.occasion' }));
protectTgRoute('POST',   '/gift-occasions/:id/archive',                idem('POST /tg/gift-occasions/:id/archive', { category: 'gift-notes.occasion' }));
protectTgRoute('POST',   '/gift-occasions/:id/complete',               idem('POST /tg/gift-occasions/:id/complete', { category: 'gift-notes.occasion' }));

// Ideas CRUD (6)
protectTgRoute('POST',   '/gift-occasions/:id/ideas',                  idem('POST /tg/gift-occasions/:id/ideas', { category: 'gift-notes.idea' }));
protectTgRoute('PATCH',  '/gift-occasion-ideas/:ideaId',               idem('PATCH /tg/gift-occasion-ideas/:ideaId', { category: 'gift-notes.idea' }));
protectTgRoute('POST',   '/gift-occasion-ideas/:ideaId/photo',         idem('POST /tg/gift-occasion-ideas/:ideaId/photo', { category: 'gift-notes.idea-photo', noResponseReplay: true }));
protectTgRoute('DELETE', '/gift-occasion-ideas/:ideaId/photo',         idem('DELETE /tg/gift-occasion-ideas/:ideaId/photo', { category: 'gift-notes.idea-photo' }));
protectTgRoute('DELETE', '/gift-occasion-ideas/:ideaId',               idem('DELETE /tg/gift-occasion-ideas/:ideaId', { category: 'gift-notes.idea' }));
protectTgRoute('POST',   '/gift-occasion-ideas/:ideaId/complete',      idem('POST /tg/gift-occasion-ideas/:ideaId/complete', { category: 'gift-notes.idea' }));

// Reminders CRUD (3)
protectTgRoute('POST',   '/gift-occasions/:id/reminders',              idem('POST /tg/gift-occasions/:id/reminders', { category: 'gift-notes.reminder' }));
protectTgRoute('PATCH',  '/gift-occasions/:id/reminders/:rid',         idem('PATCH /tg/gift-occasions/:id/reminders/:rid', { category: 'gift-notes.reminder' }));
protectTgRoute('DELETE', '/gift-occasions/:id/reminders/:rid',         idem('DELETE /tg/gift-occasions/:id/reminders/:rid', { category: 'gift-notes.reminder' }));

// Calendar bulk imports (2)
protectTgRoute('POST',   '/calendar/import-holidays',                  idem('POST /tg/calendar/import-holidays', { category: 'gift-notes.import' }));
protectTgRoute('POST',   '/calendar/import-friends-bdays',             idem('POST /tg/calendar/import-friends-bdays', { category: 'gift-notes.import' }));

// Calendar onboarding flag (1) — single-shot UPSERT, server returns
// existing seenAt if already set; idempotency adds replay safety on
// retry. Note: /calendar/inbox/:id/read and /calendar/inbox/read-all
// are NOT protected (read markers, see header comment above).
protectTgRoute('POST',   '/calendar/onboarding-seen',                  idem('POST /tg/calendar/onboarding-seen', { category: 'calendar.onboarding' }));

const giftNotesRouter = registerGiftNotesRouter({
  getOrCreateTgUser,
  getEffectiveEntitlements,
  trackEvent,
  requireGiftNotes,
  getNextOccurrenceDate,
  computeReminderSchedule,
  buildReminderEpisodeKey,
  zUrl,
});
tgRouter.use(giftNotesRouter);

// ─── /tg/onboarding/* sub-router (P5h split — 9 handlers) ───────────────────
// Cross-domain coupling reminder: demo-item lifecycle helpers
// (getDemoTemplate, completeOnboarding, ONBOARDING_KEY, ONBOARDING_VERSION,
// FORCED_ROLLOUT_USERS, variantKeyToSegment, getOnboardingMeta) are also
// invoked by POST /tg/items (~4520), PATCH /tg/items/:id (~5004),
// DELETE /tg/items/:id (~5104), POST /tg/items/:id/copy (~6541) to fire
// `onboarding_completed` analytics + the `demo_*` completion reasons when
// the demo item is touched. They MUST stay in this file and arrive through
// deps — migrating any of them with the router would break those four
// items handlers.
//
// TDZ-safe at this position: all 13 function deps are hoisted, and the
// 5 const deps (ONBOARDING_KEY/VERSION lines 1006–1007, RU_VARIANTS/
// GLOBAL_VARIANTS lines 1008–1009, FORCED_ROLLOUT_USERS line 1023) are
// declared well before this mount point. No relocation needed (unlike
// P5c/P5e/P5f which had to mount post-`app.use('/tg', tgRouter)` because
// of late-defined `const` deps).
//
// onboardingImportLimiter (formerly at apps/api/src/index.ts:7282) is
// migrated WITH the router — only POST /onboarding/try-import uses it.
const onboardingRouter = registerOnboardingRouter({
  getOrCreateTgUser,
  trackEvent,
  checkOnboardingEligibility,
  assignOnboardingVariant,
  isDemoItemUntouched,
  getDemoTemplate,
  completeOnboarding,
  variantKeyToSegment,
  resolveMarketSegment,
  runReferralProgressHook,
  importUrlForUser,
  getOrCreateDraftsWishlist,
  mapTgItem,
  ONBOARDING_KEY,
  ONBOARDING_VERSION,
  FORCED_ROLLOUT_USERS,
  RU_VARIANTS,
  GLOBAL_VARIANTS,
});
tgRouter.use(onboardingRouter);

// ─── /tg/selections/* + /tg/archive/* sub-router (P5i split — 8 handlers) ───
// 6 selections + 2 archive endpoints, all sharing CuratedSelection /
// CuratedSelectionSubscription / Item tables. The 3 path-scoped idem
// registrations for selections (DELETE /selections/:id, POST/DELETE
// /selections/:id/subscribe) stay in index.ts at lines 1655–1657 — they
// are `tgRouter.all(...)` middleware that fires BEFORE sub-router dispatch.
//
// All 3 deps (getOrCreateTgUser, trackEvent, mapTgItem) are hoisted
// function declarations defined long before this mount point (lines 731,
// 1287, 1402), so wiring here is TDZ-safe.
//
// Out of scope (stay in index.ts under "core wishlist/items routes"):
//   - POST/GET /tg/wishlists/:id/selections — uses generateUniqueCuratedToken
//     (also in index.ts) and gates on getEffectiveEntitlements.
//   - POST /tg/wishlists/:id/{archive,unarchive}, GET /tg/wishlists/:id/archive
//   - POST /tg/items/bulk-archive
const selectionsArchiveRouter = registerSelectionsArchiveRouter({
  getOrCreateTgUser,
  trackEvent,
  mapTgItem,
});
tgRouter.use(selectionsArchiveRouter);

// ─── /tg/reservations/* + /tg/secret-reservations/* + /tg/items/:id/{reserve,
//     unreserve,extend-reservation,secret-reserve} sub-router (P5j split —
//     16 handlers) ────────────────────────────────────────────────────────
// Mounted AFTER the protectTgRoute(...) chain at lines 1636–1645 so that
// path-scoped idem + rate-limit middleware fires BEFORE these handlers.
//
// 4 reservation-domain helpers migrated WITH the router (sole consumers):
// requireSecretReservations, buildSecretReservationSnapshot,
// deriveSecretReservationState, smartResDerive. The rest (mapTgItem,
// resolveUserFirstName, cancelItemHints, tgActorHash, hasReservationPro,
// isReservationBeta, hasSmartReservations, getSmartResLeadHours, etc.) stay
// in index.ts because they are also consumed by items/wishlists/admin/
// scheduler code outside this scope.
//
// All 12 deps are hoisted function declarations defined long before this
// mount point, so wiring here is TDZ-safe.
const reservationsRouter = registerReservationsRouter({
  getOrCreateTgUser,
  getEffectiveEntitlements,
  mapTgItem,
  trackEvent,
  trackAnalyticsEvent,
  tgActorHash,
  hasReservationPro,
  isReservationBeta,
  hasSmartReservations,
  resolveUserFirstName,
  cancelItemHints,
  getSmartResLeadHours,
});
tgRouter.use(reservationsRouter);

// ─── /tg/items/:id/comments* sub-router (P5k split — 4 handlers) ──────────
// Mounted AFTER the protectTgRoute(...) chain at lines 1547–1548 (POST
// /items/:id/comments + DELETE /items/:id/comments/:commentId). Those
// `tgRouter.all(...)` middleware fire BEFORE sub-router dispatch, so the
// rate-limit + idem gates remain in effect.
//
// `getItemRole` (index.ts:1313) stays in index.ts because GET /tg/items/:id
// (out-of-scope core items route) also calls it; it's threaded here via
// deps, same pattern P5j used for `cancelItemHints`.
const commentsRouter = registerCommentsRouter({
  getOrCreateTgUser,
  getEffectiveEntitlements,
  getItemRole,
  trackEvent,
  tgActorHash,
});
tgRouter.use(commentsRouter);

// ─── /tg/items/:id/hint + /tg/hints/:hintId sub-router (P5k split — 2
//     handlers) ──────────────────────────────────────────────────────────
// `sendHintPickerKeyboard` was migrated WITH this router (sole consumer is
// POST /items/:id/hint). `cancelItemHints` is NOT consumed by these
// handlers — it stays in index.ts for the items/reservations consumers.
//
// Wave-2 P2: POST /items/:id/hint now has protectTgRoute coverage with
// idempotency middleware (category: 'hints'). The handler still has its
// own domain-level anti-spam (3/item/30d + 5/sender/day) plus a 30-min
// idempotent fast-path; this layer adds Idempotency-Key replay safety
// for rapid double-tap. Frontend at MiniApp.tsx L7306 already passes
// `idempotency: { action: 'hint:${item.id}' }`.
protectTgRoute('POST',   '/items/:id/hint',                     idem('POST /tg/items/:id/hint', { category: 'hints' }));
const hintsRouter = registerHintsRouter({
  getOrCreateTgUser,
  getUserEntitlement,
  trackEvent,
});
tgRouter.use(hintsRouter);

// ─── /tg/group-gifts/* + /tg/items/:id/group-gift sub-router (P5l — 13
//     handlers) ──────────────────────────────────────────────────────────
// Mounted AFTER the protectTgRoute(...) chain at lines 1592–1599 (the
// seven groupgift-category state-changing endpoints). Those
// `tgRouter.all(...)` middleware fire BEFORE sub-router dispatch, so the
// rate-limit + idem gates remain in effect.
//
// `mapGroupGift` and `groupGiftInclude` were migrated WITH this router —
// they have zero callers outside the group-gift handler block.
// `GROUP_GIFT_PRICE_XTR` STAYS in index.ts (also consumed by ONE_TIME_SKUS
// at line ~511 and the entitlement function at lines ~647–650); it is
// passed through as a dep so the router uses the same authoritative value.
const groupGiftsRouter = registerGroupGiftsRouter({
  getOrCreateTgUser,
  getEffectiveEntitlements,
  tgActorHash,
  trackEvent,
  GROUP_GIFT_PRICE_XTR,
});
tgRouter.use(groupGiftsRouter);

// ─── /tg/billing/* sub-router (P5m — 9 handlers) ──────────────────────────
// Mounted AFTER the protectTgRoute(...) chain at lines 1568–1575 (the eight
// billing-category state-changing endpoints). Those `tgRouter.all(...)`
// middleware fire BEFORE sub-router dispatch, so idem (`category: 'payment'`,
// 7d TTL, critical=true) and the `payment` rate-limit on the 3 checkout
// endpoints remain in effect.
//
// All billing constants (PRO_PRICE_XTR, PRO_YEARLY_PRICE_XTR,
// PRO_SUBSCRIPTION_PERIOD, PRO_PLAN_CODE, GIFT_NOTES_PRICE_XTR,
// GIFT_NOTES_SKU, ONE_TIME_SKUS, ADDON_CAPS) STAY in index.ts — they are
// shared with the entitlement function, the SKU table itself, the renewal-
// reminder scheduler, and meRouter. The router uses them via deps so all
// consumers reference the same authoritative values.
//
// Bot side (apps/bot/src/index.ts:1103+) — `pre_checkout_query` and
// `successful_payment` handlers — owns Subscription activation and
// UserAddOn creation. Invoice payload formats are byte-identical
// (pro_monthly|pro_yearly|addon:<sku>|addon:gift_notes_unlock).
const billingRouter = registerBillingRouter({
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
});
tgRouter.use(billingRouter);

// ─── /tg/items/* sub-router (P5n — 21 handlers, root-namespace items
//     routes only; wishlist-rooted item routes stay in index.ts) ─────────
// Mounted AFTER the protectTgRoute(...) chain at lines 1516–1533 (PATCH/
// DELETE /items/:id, /items/:id/{complete,restore,photo,placements,
// placements/:wishlistId}, 6× /items/bulk-*). Those `tgRouter.all(...)`
// middleware fire BEFORE sub-router dispatch, so idem (`category: 'item.*'`)
// and bulk rate-limits remain in effect.
//
// All shared helpers — mapTgItem, countItemPlacements, cancelItemHints,
// isWishlistWritable, getItemRole, ACTIVE_STATUSES — STAY in index.ts and
// are passed via deps. They are also consumed by wishlist handlers and
// other already-extracted routers (reservations, comments).
//
// Pre-existing security gaps (NOT addressed here — flag-only):
//   - POST /tg/items/:id/move-category, /tg/items/bulk-move-category,
//     /tg/items/:id/move, /tg/items/:id/copy — no idempotency middleware.
const itemsRouter = registerItemsRouter({
  getOrCreateTgUser,
  getEffectiveEntitlements,
  getUserEntitlement,
  getItemRole,
  tgActorHash,
  trackEvent,
  trackAnalyticsEvent,
  mapTgItem,
  isWishlistWritable,
  countItemPlacements,
  cancelItemHints,
  notifySubscribersOfChange,
  ACTIVE_STATUSES,
  zUrl,
  numToPriority,
  getDemoTemplate,
  isMeaningfulEdit,
  completeOnboarding,
  ONBOARDING_KEY,
  ONBOARDING_VERSION,
  FORCED_ROLLOUT_USERS,
});
tgRouter.use(itemsRouter);

// ─── /tg/wishlists/* sub-router (P5o — 26 handlers, all wishlists routes
//     including categories sub-tree, wishlist-rooted item routes, and
//     dont-gift settings) ──────────────────────────────────────────────
// Mounted AFTER the protectTgRoute(...) chain at lines 1506–1515 (POST
// /wishlists, PATCH/DELETE /wishlists/:id, archive/unarchive, transfer-
// items, reorder, POST /wishlists/:id/items) and 1556–1563 (share-token,
// selections, subscribe). Those `tgRouter.all(...)` middleware fire
// BEFORE sub-router dispatch, so idem (wishlist.create, wishlist.update,
// wishlist.delete, wishlist.state, item.create, share, subscribe) and
// rate-limits (wishlist.create + share.hour + item.create) remain in
// effect.
//
// `attributeLifecycleReturn` migrated WITH this router (sole consumer).
// `reassignPrimaryBeforeWishlistDelete` STAYS in index.ts — also passed
// to adminRouter (line 6733). All other helpers passed via deps.
//
// Pre-existing security gaps (NOT addressed here — flag-only):
//   - POST /wishlists/:id/items/reorder, POST /wishlists/:id/categories,
//     PATCH/DELETE /wishlists/:wlId/categories/:catId, POST /wishlists/
//     :id/categories/reorder, PUT /wishlists/:id/dont-gift — no idem.
const wishlistsRouter = registerWishlistsRouter({
  getOrCreateTgUser,
  getEffectiveEntitlements,
  getUserEntitlement,
  trackEvent,
  trackAnalyticsEvent,
  mapTgItem,
  isWishlistWritable,
  reassignPrimaryBeforeWishlistDelete,
  runReferralProgressHook,
  notifySubscribersOfChange,
  hasSmartReservations,
  ACTIVE_STATUSES,
  ONE_TIME_SKUS,
  numToPriority,
  completeOnboarding,
  ONBOARDING_KEY,
  ONBOARDING_VERSION,
  FORCED_ROLLOUT_USERS,
  variantKeyToSegment,
  zUrl,
});
tgRouter.use(wishlistsRouter);

// ─── Santa (Wave 2) — 38 state-changing endpoints ────────────────────────
// 58 santa handlers total in routes/santa.routes.ts; 19 are GET (read-only,
// no protection needed) and 39 are state-changing. One state-changing
// endpoint — POST /santa/campaigns/:id/chat/read — is intentionally NOT
// protected because it is a fire-and-forget read-cursor upsert,
// duplicate-safe by design. Same precedent as /me/subscriptions/:id/read
// (see docs/API_SECURITY.md § 4 "Out of Wave-2 scope (by design)").
//
// Registration order: these protectTgRoute entries land BEFORE
// `tgRouter.use(santaRouter)` below so the gate registration on tgRouter
// fires before the sub-router's handler dispatch. protectTgRoute uses
// tgRouter.all() with method-narrowing inside.
//
// Critical-flag endpoints (11): irreversible state transitions, mass-DM
// fan-outs, role/admin actions, terminal decisions. Soft-require —
// missing Idempotency-Key logs `api.idem_missing_on_critical_endpoint`
// but never blocks (Mini App will start sending santa-action keys in a
// follow-up PR; this Wave-2 rollout is back-end-only).
//
// 7-day TTL endpoints (2): /santa/admin/season-broadcasts (huge blast
// radius — DM fan-out to every user with telegramChatId) and
// /santa/campaigns/:id/draw (irreversible, expensive, retry-resilient).
// Same shape as billing — long replay window for safety.
//
// New rate-limit categories (2): santa.draw (3/10min — multi-tap guard
// on the most expensive op), santa.admin (10/1min — admin gating).
// Other santa endpoints accept idempotency-only or reuse comment.minute
// + comment.hour for the chat-write endpoint.

// Admin / Season / Global Config (3)
protectTgRoute('POST',  '/santa/season/test-mode',         createRateLimiter('santa.admin'), idem('POST /tg/santa/season/test-mode', { category: 'santa.admin' }));
protectTgRoute('PATCH', '/santa/admin/global-config',      createRateLimiter('santa.admin'), idem('PATCH /tg/santa/admin/global-config', { category: 'santa.admin' }));
protectTgRoute('POST',  '/santa/admin/season-broadcasts',  createRateLimiter('santa.admin'), idem('POST /tg/santa/admin/season-broadcasts', { category: 'santa.admin', critical: true, ttlMinutes: 60 * 24 * 7 }));

// Campaign CRUD + state (5)
protectTgRoute('POST',  '/santa/campaigns',                idem('POST /tg/santa/campaigns', { category: 'santa.campaign' }));
protectTgRoute('PATCH', '/santa/campaigns/:id',            idem('PATCH /tg/santa/campaigns/:id', { category: 'santa.campaign' }));
protectTgRoute('POST',  '/santa/campaigns/:id/open',       idem('POST /tg/santa/campaigns/:id/open', { category: 'santa.campaign' }));
protectTgRoute('POST',  '/santa/campaigns/:id/lock',       idem('POST /tg/santa/campaigns/:id/lock', { category: 'santa.campaign' }));
protectTgRoute('POST',  '/santa/campaigns/:id/cancel',     idem('POST /tg/santa/campaigns/:id/cancel', { category: 'santa.campaign', critical: true }));

// Draw (1) — irreversible, 7d TTL, dedicated rate limit
protectTgRoute('POST',  '/santa/campaigns/:id/draw',
  createRateLimiter('santa.draw'),
  idem('POST /tg/santa/campaigns/:id/draw', { category: 'santa.draw', critical: true, ttlMinutes: 60 * 24 * 7 }));

// Participants (5)
protectTgRoute('POST',   '/santa/campaigns/:id/join',                       idem('POST /tg/santa/campaigns/:id/join', { category: 'santa.participant' }));
protectTgRoute('POST',   '/santa/campaigns/:id/leave',                      idem('POST /tg/santa/campaigns/:id/leave', { category: 'santa.participant' }));
protectTgRoute('DELETE', '/santa/campaigns/:id/participants/:userId',       idem('DELETE /tg/santa/campaigns/:id/participants/:userId', { category: 'santa.participant', critical: true }));
protectTgRoute('PATCH',  '/santa/campaigns/:id/wishlist',                   idem('PATCH /tg/santa/campaigns/:id/wishlist', { category: 'santa.participant' }));
protectTgRoute('PATCH',  '/santa/campaigns/:id/participants/:userId/role',  idem('PATCH /tg/santa/campaigns/:id/participants/:userId/role', { category: 'santa.participant', critical: true }));

// Exclusions (7)
protectTgRoute('POST',   '/santa/campaigns/:id/exclusions',                                idem('POST /tg/santa/campaigns/:id/exclusions', { category: 'santa.exclusion' }));
protectTgRoute('DELETE', '/santa/campaigns/:id/exclusions/:exclusionId',                   idem('DELETE /tg/santa/campaigns/:id/exclusions/:exclusionId', { category: 'santa.exclusion' }));
protectTgRoute('POST',   '/santa/campaigns/:id/exclusions/groups',                         idem('POST /tg/santa/campaigns/:id/exclusions/groups', { category: 'santa.exclusion' }));
protectTgRoute('PATCH',  '/santa/campaigns/:id/exclusions/groups/:gid',                    idem('PATCH /tg/santa/campaigns/:id/exclusions/groups/:gid', { category: 'santa.exclusion' }));
protectTgRoute('DELETE', '/santa/campaigns/:id/exclusions/groups/:gid',                    idem('DELETE /tg/santa/campaigns/:id/exclusions/groups/:gid', { category: 'santa.exclusion' }));
protectTgRoute('POST',   '/santa/campaigns/:id/exclusions/groups/:gid/members',            idem('POST /tg/santa/campaigns/:id/exclusions/groups/:gid/members', { category: 'santa.exclusion' }));
protectTgRoute('DELETE', '/santa/campaigns/:id/exclusions/groups/:gid/members/:uid',       idem('DELETE /tg/santa/campaigns/:id/exclusions/groups/:gid/members/:uid', { category: 'santa.exclusion' }));

// Rounds / Complete / Status / Confirm (4)
protectTgRoute('POST',  '/santa/campaigns/:id/rounds',            idem('POST /tg/santa/campaigns/:id/rounds', { category: 'santa.round', critical: true }));
protectTgRoute('POST',  '/santa/campaigns/:id/complete',          idem('POST /tg/santa/campaigns/:id/complete', { category: 'santa.round', critical: true }));
protectTgRoute('PATCH', '/santa/campaigns/:id/gift-status',       idem('PATCH /tg/santa/campaigns/:id/gift-status', { category: 'santa.round' }));
protectTgRoute('POST',  '/santa/campaigns/:id/confirm-received',  idem('POST /tg/santa/campaigns/:id/confirm-received', { category: 'santa.round', critical: true }));

// Inbound Reserve (2) — Santa-specific item claim, distinct from /reservations
protectTgRoute('POST',   '/santa/campaigns/:id/inbound/reserve',                idem('POST /tg/santa/campaigns/:id/inbound/reserve', { category: 'santa.inbound' }));
protectTgRoute('DELETE', '/santa/campaigns/:id/inbound/reserve/:itemId',        idem('DELETE /tg/santa/campaigns/:id/inbound/reserve/:itemId', { category: 'santa.inbound' }));

// Hints (2) — anonymous giver→receiver request flow with 48h TTL
protectTgRoute('POST',  '/santa/campaigns/:id/hints',                idem('POST /tg/santa/campaigns/:id/hints', { category: 'santa.hint' }));
protectTgRoute('POST',  '/santa/campaigns/:id/inbound/hint/fulfill', idem('POST /tg/santa/campaigns/:id/inbound/hint/fulfill', { category: 'santa.hint' }));

// Chat / Mute (3) — chat-write reuses comment.minute+hour for write rate.
// NOTE: POST /santa/campaigns/:id/chat/read is intentionally excluded —
// fire-and-forget read marker, duplicate-safe by design (UPSERT). Same
// precedent as /me/subscriptions/:id/read.
protectTgRoute('POST',   '/santa/campaigns/:id/chat',
  ...combineLimiters('comment.minute', 'comment.hour'),
  idem('POST /tg/santa/campaigns/:id/chat', { category: 'santa.chat' }));
protectTgRoute('POST',   '/santa/campaigns/:id/mute',                idem('POST /tg/santa/campaigns/:id/mute', { category: 'santa.chat' }));
protectTgRoute('DELETE', '/santa/campaigns/:id/mute',                idem('DELETE /tg/santa/campaigns/:id/mute', { category: 'santa.chat' }));

// Polls (3)
protectTgRoute('POST',  '/santa/campaigns/:id/polls',                  idem('POST /tg/santa/campaigns/:id/polls', { category: 'santa.poll' }));
protectTgRoute('POST',  '/santa/campaigns/:id/polls/:pollId/vote',     idem('POST /tg/santa/campaigns/:id/polls/:pollId/vote', { category: 'santa.poll' }));
protectTgRoute('POST',  '/santa/campaigns/:id/polls/:pollId/close',    idem('POST /tg/santa/campaigns/:id/polls/:pollId/close', { category: 'santa.poll', critical: true }));

// Exit Requests (3)
protectTgRoute('POST',  '/santa/campaigns/:id/exit-request',                                idem('POST /tg/santa/campaigns/:id/exit-request', { category: 'santa.exit-request' }));
protectTgRoute('POST',  '/santa/campaigns/:id/exit-requests/:requestId/approve',            idem('POST /tg/santa/campaigns/:id/exit-requests/:requestId/approve', { category: 'santa.exit-request', critical: true }));
protectTgRoute('POST',  '/santa/campaigns/:id/exit-requests/:requestId/deny',               idem('POST /tg/santa/campaigns/:id/exit-requests/:requestId/deny', { category: 'santa.exit-request', critical: true }));

// ─── /tg/santa/* sub-router (P5p — final domain extraction; 58 handlers,
//     all remaining inline tg routes) ─────────────────────────────────────
// With this mount, `apps/api/src/index.ts` becomes a true composition root
// per docs/REFACTOR_API_INDEX_HANDOFF.md — bootstrap, middleware, router
// registration, schedulers, app.listen, process handlers.
//
// Wave-2 security wiring above (38 protectTgRoute entries + 2 new
// rate-limit categories) closes the pre-existing gap. See
// docs/API_SECURITY.md § 4.
//
// Section 2.A helpers STAY in index.ts (scheduler + startup-hook coupling):
//   - getSeasonStartYear / getSeasonCalendar / getSantaSeasonInfo /
//     sendSeasonalBroadcast (used by maybeRunSeasonalEvents scheduler at
//     line ~6485 + 2 handlers)
//   - generateSantaAliases (used by app.listen alias-backfill hook + 1
//     handler)
// Section 2.B helpers (~26 entries) migrated WITH router as module-scope
// helpers in santa.routes.ts.
const santaRouter = registerSantaRouter({
  getOrCreateTgUser,
  getUserEntitlement,
  trackEvent,
  mapTgItem,
  sendAdminAlert,
  tgActorHash,
  getSeasonStartYear,
  getSeasonCalendar,
  getSantaSeasonInfo,
  sendSeasonalBroadcast,
  generateSantaAliases,
});
tgRouter.use(santaRouter);

// P5c lightweight batch (profiles / telemetry / analytics / maintenance /
// import) is wired further below alongside the P4 internal/admin/public
// routers — placed there because two of its deps (recordMaintenanceExposure,
// importUrlForUser, DRAFTS_ITEM_LIMIT) are `const`/`async function` declared
// later in this file and TDZ would error if we mounted the routers up here.
// Mount order is preserved: meRouter -> refRouter -> P5c batch -> P4 routers,
// matching the user's "after refRouter" intent.


// ─────────────────────────────────────────────────────────────────────────────





// ── Curated Selections ────────────────────────────────────────────────────



















// ═══════════════════════════════════════════════════════
// WISHLIST CATEGORIES
// ═══════════════════════════════════════════════════════























// ─── Import URL: helpers ─────────────────────────────────────────────────────

const DRAFTS_ITEM_LIMIT = 50;

async function getOrCreateDraftsWishlist(userId: string) {
  const existing = await prisma.wishlist.findFirst({
    where: { ownerId: userId, type: 'SYSTEM_DRAFTS' },
    select: { id: true },
  });
  if (existing) return existing;
  const drafts = await prisma.wishlist.create({
    data: {
      slug: `drafts-${crypto.randomUUID().slice(0, 12)}`,
      ownerId: userId,
      title: 'Неразобранное',
      type: 'SYSTEM_DRAFTS',
    },
    select: { id: true },
  });
  // Canonical analytics: auto-created SYSTEM_DRAFTS
  const existingAny = await prisma.wishlist.count({ where: { ownerId: userId } });
  trackEvent('wishlist_created', userId, {
    wishlistId: drafts.id, wishlistType: 'SYSTEM_DRAFTS', source: 'auto_drafts',
    platform: 'system',
    isFirstRegularWishlist: false,
    isFirstAnyWishlist: existingAny === 1,
  });
  return drafts;
}

async function importUrlForUser(
  userId: string,
  rawUrl: string,
  note?: string,
  source?: string,
  parseOpts?: { noCache?: boolean },
): Promise<{ item: ReturnType<typeof mapTgItem>; wishlistId: string; parseStatus: 'ok' | 'partial' | 'failed' }> {
  const draftsWl = await getOrCreateDraftsWishlist(userId);

  // Check drafts limit
  const draftsCount = await prisma.item.count({
    where: { wishlistId: draftsWl.id, status: { in: [...ACTIVE_STATUSES] } },
  });
  if (draftsCount >= DRAFTS_ITEM_LIMIT) {
    throw Object.assign(new Error('Drafts limit reached'), { statusCode: 402 });
  }

  let parsed: Awaited<ReturnType<typeof parseUrl>>;
  let parseStatus: 'ok' | 'partial' | 'failed' = 'ok';

  try {
    parsed = await parseUrl(rawUrl, parseOpts);
    if (!parsed.title && !parsed.priceText && !parsed.imageUrl) {
      parseStatus = 'failed';
    } else if (!parsed.title || !parsed.priceText) {
      parseStatus = 'partial';
    }
  } catch {
    parseStatus = 'failed';
    let hostname = 'link';
    try { hostname = new URL(rawUrl).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
    parsed = {
      title: null,
      description: null,
      priceText: null,
      imageUrl: null,
      sourceDomain: hostname,
      canonicalUrl: rawUrl,
    };
  }

  const title = parsed.title || parsed.sourceDomain || 'Link';

  // Description: user note (if any) + parsed description
  let description: string | null = null;
  if (note && parsed.description) {
    description = `💬 ${note}\n\n${parsed.description}`.slice(0, 500);
  } else if (note) {
    description = note.slice(0, 500);
  } else if (parsed.description) {
    description = parsed.description.slice(0, 500);
  }

  const item = await prisma.item.create({
    data: {
      wishlistId: draftsWl.id,
      title: title.slice(0, 200),
      url: parsed.canonicalUrl || rawUrl,
      description,
      priceText: extractNumericPrice(parsed.priceText),
      imageUrl: parsed.imageUrl ?? null,
      sourceUrl: rawUrl,
      sourceDomain: parsed.sourceDomain,
      importMethod: source || 'bot',
    },
    select: {
      id: true, wishlistId: true, title: true, url: true, priceText: true,
      imageUrl: true, priority: true, status: true, description: true,
      sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
    },
  });
  // Dual-write: mirror into placement table.
  await ensureItemPlacement(prisma, { wishlistId: draftsWl.id, itemId: item.id });

  // Canonical analytics: item created via import in SYSTEM_DRAFTS
  const totalUserItems = await prisma.item.count({ where: { wishlist: { ownerId: userId }, status: { not: 'DELETED' } } });
  trackEvent('item_created', userId, {
    itemId: item.id, wishlistId: draftsWl.id, wishlistType: 'SYSTEM_DRAFTS',
    source: source === 'bot' ? 'bot' : 'import_url',
    platform: source === 'bot' ? 'bot' : 'miniapp',
    isFirstItem: totalUserItems === 1,
    triggeredFromDrafts: true,
  });
  if (totalUserItems === 1) trackEvent('first_item_created', userId, { itemId: item.id, wishlistType: 'SYSTEM_DRAFTS', source: source === 'bot' ? 'bot' : 'import_url', platform: source === 'bot' ? 'bot' : 'miniapp' });

  return { item: mapTgItem(item), wishlistId: draftsWl.id, parseStatus };
}


// ─── Move item between wishlists ─────────────────────────────────────────────


// ─── Copy single item to another wishlist ────────────────────────────────────


// ─── Item placements (shared wishes) ─────────────────────────────────────────
// A Wish (Item row) can be placed in multiple wishlists via WishlistItemPlacement.
// Title/description/url/price/image/status/reservation/comments are shared across
// all placements; categoryId and position are per-placement. Capacity is counted
// in placements (so a shared wish counts against every wishlist it lives in).




// ─── Billing & Plan endpoints ────────────────────────────────────────────────




// ═══════════════════════════════════════════════════════════════════════════
// Birthday Reminders — settings, mute, deep-link resolve, God Mode
//
// Pro gating policy:
//   Pro-only fields are REJECTED with 402 PRO_REQUIRED if a Free user attempts
//   to set them. They're never silently saved as inactive — that creates ghost
//   settings (user thinks it works, paywall never surfaces).
//
//   Pro-only fields:
//     - audience: 'EXTENDED'
//     - primaryWishlistId (any non-null value)
//     - customMessage (any non-empty value)
//     - advancedWindowsEnabled: true
//
//   Existing Pro values are preserved on downgrade: scheduler treats them as
//   inactive (skipReason: pro_required), but DB rows stay so re-upgrade is
//   seamless. The frontend shows a "Pro required to use" hint.
// ═══════════════════════════════════════════════════════════════════════════



// ─── PRO Showcase endpoints ─────────────────────────────────────────────────









// ─── Gift Notes: Occasions CRUD ──────────────────────────────────────────────


// ════════════════════════════════════════════════════════════════════════════
// Events Calendar v2.1 — reminders, holidays, friends-bdays, inbox, recap
// ════════════════════════════════════════════════════════════════════════════

function computeReminderSchedule(eventDate: Date, recurrence: string, offsetDays: number, timeOfDay: string): Date {
  const next = getNextOccurrenceDate(eventDate, recurrence) ?? eventDate;
  const [hh, mm] = timeOfDay.split(':').map(Number) as [number, number];
  const base = new Date(next.getTime());
  base.setUTCDate(base.getUTCDate() + offsetDays);
  base.setUTCHours(hh - 3, mm, 0, 0); // MSK→UTC
  return base;
}

function buildReminderEpisodeKey(occasionId: string, offsetDays: number, scheduledFor: Date): string {
  const y = scheduledFor.getUTCFullYear();
  const m = String(scheduledFor.getUTCMonth() + 1).padStart(2, '0');
  return `occ_${occasionId}_off${offsetDays}_${y}_${m}`;
}



// Secret Santa endpoints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the canonical "season start year" — the November year that anchors the current
 * or upcoming Santa season. This is the single source of truth for:
 *   - SantaSeasonConfig.seasonYear  (DB override lookup key)
 *   - SantaSeasonalBroadcastLog.year (broadcast dedup key)
 *   - getSeasonCalendar()            (season window computation)
 *
 * The Santa season crosses the calendar year boundary: Nov 15 (year Y) → Feb 15 (year Y+1).
 * Any date in Jan 1 – Feb 15 belongs to the season that STARTED last November (year Y-1).
 * All other dates belong to the season starting this November (year Y, current or upcoming).
 *
 * Examples:
 *   2026-10-31 → 2026  (off-season; next season opens Nov 15, 2026)
 *   2026-11-01 → 2026  (promo day; season key = 2026)
 *   2026-11-15 → 2026  (season opens)
 *   2026-12-25 → 2026  (mid-season)
 *   2027-01-10 → 2026  ← Jan is still the 2026 season, NOT 2027
 *   2027-02-10 → 2026  ← Feb 10 is still the 2026 season, closing Feb 15
 *   2027-02-15 → 2026  ← last day of the 2026 season
 *   2027-02-16 → 2027  (off-season; next season key = 2027)
 *   2027-11-14 → 2027  (off-season, one day before next season)
 *   2027-11-15 → 2027  (new 2027 season opens)
 *   2027-11-20 → 2027  (2027 season, NOT 2026)
 */
/**
 * Returns the canonical "season start year" — the November year that anchors the current
 * or upcoming Santa season. This is the single source of truth for:
 *   - SantaSeasonConfig.seasonYear  (DB override lookup key)
 *   - SantaSeasonalBroadcastLog.year (broadcast dedup key)
 *   - getSeasonCalendar()            (season window computation)
 *
 * The Santa season crosses the calendar year boundary: Nov 15 (year Y) → Feb 15 (year Y+1).
 * Any date in Jan 1 – Feb 15 belongs to the season that STARTED last November (year Y-1).
 * All other dates belong to the season starting this November (year Y, current or upcoming).
 *
 * All comparisons use UTC to be timezone-independent (server TZ never affects the result).
 *
 * Examples:
 *   2026-10-31 UTC → 2026  (off-season; next season opens Nov 15, 2026)
 *   2026-11-01 UTC → 2026  (promo day; season key = 2026)
 *   2026-11-15 UTC → 2026  (season opens)
 *   2026-12-25 UTC → 2026  (mid-season)
 *   2027-01-10 UTC → 2026  ← Jan is still the 2026 season, NOT 2027
 *   2027-02-10 UTC → 2026  ← Feb 10 is still the 2026 season, closing Feb 15
 *   2027-02-15 UTC → 2026  ← last day of the 2026 season
 *   2027-02-16 UTC → 2027  (off-season; next season key = 2027)
 *   2027-11-15 UTC → 2027  (new 2027 season opens)
 *   2027-11-20 UTC → 2027  (2027 season, NOT 2026)
 */
function getSeasonStartYear(now: Date): number {
  const m = now.getUTCMonth() + 1; // 1–12, UTC
  const d = now.getUTCDate();       // UTC day
  const y = now.getUTCFullYear();   // UTC year
  // Jan 1 – Feb 15 UTC: tail of the season that started Nov of year Y-1
  return (m === 1 || (m === 2 && d <= 15)) ? y - 1 : y;
}

/**
 * Pure calendar helper — season window is Nov 15 00:00 UTC (seasonStartYear) →
 * Feb 15 23:59:59.999 UTC (seasonStartYear+1).
 * Uses UTC timestamps throughout to be timezone-independent.
 * Requires zero DB access. Works correctly for any calendar year, forever.
 */
function getSeasonCalendar(now: Date): { inSeason: boolean; seasonStart: Date; seasonEnd: Date } {
  const startYear   = getSeasonStartYear(now);
  const seasonStart = new Date(Date.UTC(startYear,     10, 15));               // Nov 15 00:00:00.000 UTC
  const seasonEnd   = new Date(Date.UTC(startYear + 1,  1, 15, 23, 59, 59, 999)); // Feb 15 23:59:59.999 UTC
  return { inSeason: now >= seasonStart && now <= seasonEnd, seasonStart, seasonEnd };
}

/**
 * Compute season status and create-permission for the requesting user.
 *
 * Resolution priority (first match wins):
 *   1. SantaGlobalConfig.santaEnabled = false  → always off (unless santaTestMode)
 *   2. santaTestMode = true                    → always on (godMode bypass)
 *   3. SantaSeasonConfig row for current year  → explicit admin override (per-year dates)
 *   4. getSeasonCalendar()                     → automatic, recurring, zero annual setup
 *
 * Never mutates DB.
 */
async function getSantaSeasonInfo(userId: string, santaTestMode: boolean) {
  const now        = new Date();
  // seasonYear is the November-start year of the current season (e.g. 2026 for Jan/Feb 2027).
  // This is the canonical DB key — must match SantaSeasonConfig.seasonYear.
  // Using getSeasonStartYear() (not now.getFullYear()) is what makes Jan/Feb 2027 correctly
  // resolve to the 2026 season row instead of a non-existent 2027 row.
  const seasonYear = getSeasonStartYear(now);

  // 1. Global kill switch — allows retiring Santa entirely without touching per-year rows.
  //    Bypassed by santaTestMode so godMode users can always test even after retirement.
  if (!santaTestMode) {
    const globalConfig = await prisma.santaGlobalConfig.findUnique({ where: { id: 'global' } });
    if (globalConfig && !globalConfig.santaEnabled) {
      return { inSeason: false, canCreate: false, seasonStart: null, seasonEnd: null, config: null };
    }
  }

  // 2. santaTestMode: bypass season window and missing-config guard entirely.
  //    Must be checked before DB row query so god-mode users always land in-season.
  if (santaTestMode) {
    const config = await prisma.santaSeasonConfig.findUnique({ where: { seasonYear } });
    const cal    = getSeasonCalendar(now);
    return {
      inSeason:    true,
      canCreate:   true,
      seasonStart: (config?.seasonStartAt ?? cal.seasonStart).toISOString(),
      seasonEnd:   (config?.seasonEndAt   ?? cal.seasonEnd).toISOString(),
      config:      config ?? null,
    };
  }

  // 3. Explicit per-year admin override row takes priority over calendar.
  //    seasonYear = getSeasonStartYear(now) ensures Jan/Feb 2027 finds the 2026 row, not 2027.
  const config = await prisma.santaSeasonConfig.findUnique({ where: { seasonYear } });
  if (config) {
    const inSeason  = now >= config.seasonStartAt && now <= config.seasonEndAt;
    const canCreate = inSeason && config.campaignCreateEnabled;
    return {
      inSeason,
      canCreate,
      seasonStart: config.seasonStartAt.toISOString(),
      seasonEnd:   config.seasonEndAt.toISOString(),
      config,
    };
  }

  // 4. No DB override — apply recurring calendar rules (Nov 15 → Feb 15).
  //    Works automatically for every year: 2026, 2027, 2028, … with zero annual setup.
  const { inSeason, seasonStart, seasonEnd } = getSeasonCalendar(now);
  return {
    inSeason,
    canCreate:   inSeason, // calendar default: all in-season users may create
    seasonStart: seasonStart.toISOString(),
    seasonEnd:   seasonEnd.toISOString(),
    config:      null,
  };
}







// ─── Santa Anonymous Alias System ────────────────────────────────────────────
// Corpus: 30 adjectives × 30 animals = 900 unique combinations per round.
// adjectiveKey / animalKey are locale-independent; alias string is pre-rendered in RU.
// Frontend re-renders in user's locale using the keys.

const SANTA_ADJECTIVES: Record<string, { m: string; f: string; en: string }> = {
  sleepy:     { m: 'Сонный',      f: 'Сонная',      en: 'Sleepy' },
  nimble:     { m: 'Ловкий',      f: 'Ловкая',       en: 'Nimble' },
  quiet:      { m: 'Тихий',       f: 'Тихая',        en: 'Quiet' },
  northern:   { m: 'Северный',    f: 'Северная',     en: 'Northern' },
  cheerful:   { m: 'Весёлый',     f: 'Весёлая',      en: 'Cheerful' },
  cunning:    { m: 'Хитрый',      f: 'Хитрая',       en: 'Cunning' },
  kind:       { m: 'Добрый',      f: 'Добрая',       en: 'Kind' },
  swift:      { m: 'Быстрый',     f: 'Быстрая',      en: 'Swift' },
  brave:      { m: 'Смелый',      f: 'Смелая',       en: 'Brave' },
  smart:      { m: 'Умный',       f: 'Умная',        en: 'Smart' },
  gentle:     { m: 'Нежный',      f: 'Нежная',       en: 'Gentle' },
  fluffy:     { m: 'Пушистый',    f: 'Пушистая',     en: 'Fluffy' },
  bright:     { m: 'Яркий',       f: 'Яркая',        en: 'Bright' },
  curious:    { m: 'Любопытный',  f: 'Любопытная',   en: 'Curious' },
  patient:    { m: 'Терпеливый',  f: 'Терпеливая',   en: 'Patient' },
  playful:    { m: 'Игривый',     f: 'Игривая',      en: 'Playful' },
  cozy:       { m: 'Уютный',      f: 'Уютная',       en: 'Cozy' },
  peaceful:   { m: 'Спокойный',   f: 'Спокойная',    en: 'Peaceful' },
  golden:     { m: 'Золотой',     f: 'Золотая',      en: 'Golden' },
  mysterious: { m: 'Загадочный',  f: 'Загадочная',   en: 'Mysterious' },
  lucky:      { m: 'Удачливый',   f: 'Удачливая',    en: 'Lucky' },
  energetic:  { m: 'Бодрый',      f: 'Бодрая',       en: 'Energetic' },
  wise:       { m: 'Мудрый',      f: 'Мудрая',       en: 'Wise' },
  rare:       { m: 'Редкий',      f: 'Редкая',       en: 'Rare' },
  honest:     { m: 'Честный',     f: 'Честная',      en: 'Honest' },
  courageous: { m: 'Отважный',    f: 'Отважная',     en: 'Courageous' },
  modest:     { m: 'Скромный',    f: 'Скромная',     en: 'Modest' },
  wonderful:  { m: 'Чудесный',    f: 'Чудесная',     en: 'Wonderful' },
  generous:   { m: 'Щедрый',      f: 'Щедрая',       en: 'Generous' },
  light:      { m: 'Лёгкий',      f: 'Лёгкая',       en: 'Light' },
};

const SANTA_ANIMALS: Record<string, { ru: string; gender: 'm' | 'f'; emoji: string; en: string }> = {
  giraffe:    { ru: 'жираф',      gender: 'm', emoji: '🦒', en: 'Giraffe' },
  quokka:     { ru: 'квокка',     gender: 'f', emoji: '🦘', en: 'Quokka' },
  manul:      { ru: 'манул',      gender: 'm', emoji: '🐱', en: 'Pallas Cat' },
  penguin:    { ru: 'пингвин',    gender: 'm', emoji: '🐧', en: 'Penguin' },
  fox:        { ru: 'лиса',       gender: 'f', emoji: '🦊', en: 'Fox' },
  raccoon:    { ru: 'енот',       gender: 'm', emoji: '🦝', en: 'Raccoon' },
  bear:       { ru: 'медведь',    gender: 'm', emoji: '🐻', en: 'Bear' },
  squirrel:   { ru: 'белка',      gender: 'f', emoji: '🐿️', en: 'Squirrel' },
  hedgehog:   { ru: 'ёж',         gender: 'm', emoji: '🦔', en: 'Hedgehog' },
  otter:      { ru: 'выдра',      gender: 'f', emoji: '🦦', en: 'Otter' },
  panda:      { ru: 'панда',      gender: 'f', emoji: '🐼', en: 'Panda' },
  koala:      { ru: 'коала',      gender: 'm', emoji: '🐨', en: 'Koala' },
  capybara:   { ru: 'капибара',   gender: 'f', emoji: '🦫', en: 'Capybara' },
  sloth:      { ru: 'ленивец',    gender: 'm', emoji: '🦥', en: 'Sloth' },
  flamingo:   { ru: 'фламинго',   gender: 'm', emoji: '🦩', en: 'Flamingo' },
  lemur:      { ru: 'лемур',      gender: 'm', emoji: '🐒', en: 'Lemur' },
  alpaca:     { ru: 'альпака',    gender: 'f', emoji: '🦙', en: 'Alpaca' },
  axolotl:    { ru: 'аксолотль',  gender: 'm', emoji: '🫧', en: 'Axolotl' },
  narwhal:    { ru: 'нарвал',     gender: 'm', emoji: '🌊', en: 'Narwhal' },
  platypus:   { ru: 'утконос',    gender: 'm', emoji: '🦆', en: 'Platypus' },
  meerkat:    { ru: 'сурикат',    gender: 'm', emoji: '🐾', en: 'Meerkat' },
  chinchilla: { ru: 'шиншилла',   gender: 'f', emoji: '🐭', en: 'Chinchilla' },
  tapir:      { ru: 'тапир',      gender: 'm', emoji: '🦏', en: 'Tapir' },
  wombat:     { ru: 'вомбат',     gender: 'm', emoji: '🐨', en: 'Wombat' },
  marmot:     { ru: 'сурок',      gender: 'm', emoji: '🐿️', en: 'Marmot' },
  toucan:     { ru: 'тукан',      gender: 'm', emoji: '🦜', en: 'Toucan' },
  armadillo:  { ru: 'броненосец', gender: 'm', emoji: '🛡️', en: 'Armadillo' },
  cassowary:  { ru: 'казуар',     gender: 'm', emoji: '🐦', en: 'Cassowary' },
  lynx:       { ru: 'рысь',       gender: 'f', emoji: '🐱', en: 'Lynx' },
  okapi:      { ru: 'окапи',      gender: 'm', emoji: '🦌', en: 'Okapi' },
};

const SANTA_ADJ_KEYS = Object.keys(SANTA_ADJECTIVES);
const SANTA_ANIMAL_KEYS = Object.keys(SANTA_ANIMALS);

/** mulberry32 — fast seeded PRNG returning [0, 1) */
function santaSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash of a string */
function santaHashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Fisher-Yates shuffle with seeded RNG (returns new array) */
function santaShuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Generate round-scoped aliases for a set of participantIds.
 *  Deterministic: same roundId + same participantIds → same aliases.
 *  Unique within round by construction (shuffled combos, assigned sequentially). */
function generateSantaAliases(
  roundId: string,
  participantIds: string[],
): Array<{ participantId: string; alias: string; emoji: string; adjectiveKey: string; animalKey: string }> {
  const seed = santaHashStr(roundId);
  const rng  = santaSeededRng(seed);

  // Build full combo list
  const combos: Array<{ adjKey: string; animalKey: string }> = [];
  for (const adjKey of SANTA_ADJ_KEYS) {
    for (const animalKey of SANTA_ANIMAL_KEYS) {
      combos.push({ adjKey, animalKey });
    }
  }
  // Shuffle with round seed → unique ordering per round
  const shuffled = santaShuffle(combos, rng);

  // Assign to participants in deterministic order (sort by participantId)
  const sorted = [...participantIds].sort();

  return sorted.map((pid, i) => {
    const combo = shuffled[i % shuffled.length]!;
    const adj   = SANTA_ADJECTIVES[combo.adjKey]!;
    const animal = SANTA_ANIMALS[combo.animalKey]!;
    const aliasStr = `${adj[animal.gender]} ${animal.ru}`;
    return {
      participantId: pid,
      alias: aliasStr,
      emoji: animal.emoji,
      adjectiveKey: combo.adjKey,
      animalKey: combo.animalKey,
    };
  });
}












// ─── Santa draw algorithm helpers ─────────────────────────────────────────────

/**
 * Build exclusion set as "smallerUserId:largerUserId" strings for O(1) lookup.
 */










// ─── Santa — role-aware assignment serializer ─────────────────────────────────




// ─── Inbound signal helpers (Batch 3) ─────────────────────────────────────────




// ─── Santa draw endpoints ──────────────────────────────────────────────────────











// ─── Batch 5.1: Group exclusion endpoints ─────────────────────────────────────










// ─── Santa — inbound (receiver-centric, post-draw) ────────────────────────────







// ─── Santa Hints (Batch 2.5) ──────────────────────────────────────────────────












// ─── Maintenance: record exposure (must be before maintenance middleware!) ────
// Find-or-create the current active incident, then upsert an exposure row.
async function recordMaintenanceExposure(userId: string, surface: string, locale: string, telegramChatId: string | null) {
  // Find or create the active incident
  let incident = await prisma.maintenanceIncident.findFirst({
    where: { status: { in: ['active', 'recovering'] } },
    orderBy: { startedAt: 'desc' },
  });
  if (!incident) {
    incident = await prisma.maintenanceIncident.create({
      data: { status: 'active', lastMaintenanceSignalAt: new Date() },
    });
  } else {
    // Bump lastMaintenanceSignalAt
    await prisma.maintenanceIncident.update({
      where: { id: incident.id },
      data: { lastMaintenanceSignalAt: new Date(), status: 'active' },
    }).catch(() => {});
  }

  // Upsert exposure: don't duplicate, just update lastSeenAt
  await prisma.maintenanceExposure.upsert({
    where: {
      incidentId_userId_surface: { incidentId: incident.id, userId, surface },
    },
    update: { lastSeenAt: new Date(), locale, ...(telegramChatId ? { telegramChatId } : {}) },
    create: {
      incidentId: incident.id,
      userId,
      surface,
      locale,
      telegramChatId,
    },
  });

  // Increment exposure count (approximate — counts each new surface/user combo)
  await prisma.maintenanceIncident.update({
    where: { id: incident.id },
    data: { exposureCount: { increment: 1 } },
  }).catch(() => {});

  trackEvent('maintenance_seen', userId, { incidentId: incident.id, surface });
  return incident.id;
}


// ─── Maintenance mode middleware ──────────────────────────────────────────────
// When MAINTENANCE_MODE=true, block /tg/* and /public/* with 503 + code=MAINTENANCE.
// /health, /health/deep, /uploads, /internal remain accessible.
// Exception: POST /tg/maintenance-exposure must pass through so we can record who saw the outage.
app.use(['/tg', '/public'], (req: Request, res: Response, next: NextFunction) => {
  if ((process.env.MAINTENANCE_MODE ?? '').toLowerCase() === 'true') {
    if (req.method === 'POST' && req.path === '/maintenance-exposure') return next();
    return res.status(503).json({ error: 'Service temporarily unavailable', code: 'MAINTENANCE' });
  }
  return next();
});

// ─── Mount routers ───────────────────────────────────────────────────────────

// Routers extracted to ./routes/* live as factories so they can close over
// helpers / schemas still defined in this file. Mount prefixes and
// middleware order are unchanged.
//
// ─── P5c lightweight batch — 5 small isolated /tg/* sub-routers ─────────────
// Wired here (rather than next to meRouter/refRouter near the top) because
// two of these routers depend on `const`/`async function` declarations
// (DRAFTS_ITEM_LIMIT, importUrlForUser, recordMaintenanceExposure) defined
// later in this file. Mount order is preserved at runtime: tgRouter receives
// .use() calls in this exact source order so meRouter (line ~1716) and
// refRouter (~1741) handle requests first, then this P5c batch.
const profilesRouter = registerProfilesRouter({
  getOrCreateTgUser,
});
tgRouter.use(profilesRouter);

const telemetryRouter = registerTelemetryRouter();
tgRouter.use(telemetryRouter);

const analyticsRouter = registerAnalyticsRouter({
  getOrCreateTgUser,
});
tgRouter.use(analyticsRouter);

const maintenanceRouter = registerMaintenanceRouter({
  getOrCreateTgUser,
  trackEvent,
  recordMaintenanceExposure,
});
tgRouter.use(maintenanceRouter);

const importRouter = registerImportRouter({
  getOrCreateTgUser,
  getUserEntitlement,
  trackEvent,
  trackAnalyticsEvent,
  importUrlForUser,
  DRAFTS_ITEM_LIMIT,
});
tgRouter.use(importRouter);

const internalRouter = registerInternalRouter({
  getUserEntitlement,
  importUrlForUser,
  DRAFTS_ITEM_LIMIT,
  recordMaintenanceExposure,
  trackEvent,
});

const privateRouter = registerAdminRouter({
  ItemStatusSchema,
  PrioritySchema,
  zUrl,
  reassignPrimaryBeforeWishlistDelete,
  trackAnalyticsEvent,
  notifyReferralInviterRewarded,
});

const publicRouter = registerPublicRouter({
  ACTIVE_STATUSES,
  actorBodySchema,
  getUserEntitlement,
  trackEvent,
  trackAnalyticsEvent,
});

app.use('/public', publicRouter);
app.use('/tg', tgRouter);
app.use('/internal', internalRouter);
app.use(privateRouter);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  // Multer errors (file too large, wrong type, etc.)
  if (err && typeof err === 'object' && 'code' in err) {
    const multerErr = err as { code: string; message: string };
    if (multerErr.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: t('item_photo_too_large', getRequestLocale(_req)) });
    }
    if (multerErr.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ error: 'Unexpected field name. Use "photo".' });
    }
  }
  if (err instanceof Error && err.message.startsWith('Unsupported file type')) {
    return res.status(415).json({ error: err.message });
  }

  logger.error({ err }, 'unhandled express error');
  if (process.env.GLITCHTIP_DSN) Sentry.captureException(err);
  return res.status(500).json({ error: 'Internal server error' });
});

// Cleanup schedulers (P5r-1): comments TTL, curated selection subscription
// cleanup, archive purge — extracted to ./schedulers/cleanup.ts. Cadence
// (60 * 60 * 1000) and log messages preserved byte-identical.
startCleanupSchedulers({ prisma, logger, deleteUploadFile });

// Billing schedulers (P5r-2): subscription expiry, promo expiry,
// degradation grace + degradation purge — extracted to ./schedulers/
// billing.ts. Cadence (60 * 60 * 1000) and log messages preserved
// byte-identical.
startBillingSchedulers({ prisma, logger, getUserEntitlement, PLANS });

// Referral schedulers (P5r-3): 15-min expired-attribution sweep —
// extracted to ./schedulers/referral.ts. Cadence and log labels
// preserved byte-identical.
startReferralSchedulers({ prisma, logger, trackAnalyticsEvent, sweepExpiredPendingAttributions });

// ─── Lifecycle / Win-back scheduler (hourly) ─────────────────────────────────
// Scans users, classifies into segments S1–S4, creates LifecycleTouch records,
// and sends Telegram DM messages via bot API. WISHPRO offered only on eligible touches.

const BOT_TOKEN_FOR_DM = process.env.BOT_TOKEN ?? '';
const MINI_APP_URL_FOR_DM = process.env.MINI_APP_URL ?? 'https://wishlistik.ru/miniapp';
const LIFECYCLE_PROMO_CODE = 'WISHPRO';

// ─── /tg/promo/* sub-router (P5f split) ──────────────────────────────────────
// Wired here (rather than alongside meRouter/refRouter/supportRouter near the
// top, or alongside the P5c batch / P4 routers around line ~11600) because
// the factory call closes over LIFECYCLE_PROMO_CODE — declared on the line
// just above. Earlier wiring would TDZ-error on this `const`. Same TDZ-
// relocation precedent as P5c (DRAFTS_ITEM_LIMIT etc.) and P5e
// (BIRTHDAY_REMINDERS_ENABLED). Mount order at runtime is preserved:
//   protectTgRoute() chain (no /promo entries)
//     -> meRouter -> refRouter -> supportRouter -> P5c batch -> P4 routers
//     -> app.use('/tg', tgRouter)            ← already mounted at line ~11678
//     -> tgRouter.use(promoRouter)            ← this block (post-mount,
//                                                valid: Router stack remains
//                                                mutable until app.listen())
//     -> tgRouter.use(birthdayRemindersRouter) (~13238, P5e)
//     -> app.listen(PORT)
// LIFECYCLE_PROMO_CODE stays in index.ts; the lifecycle scheduler below
// continues to use it directly.
const promoRouter = registerPromoRouter({
  getOrCreateTgUser,
  getUserEntitlement,
  trackEvent,
  LIFECYCLE_PROMO_CODE,
});
tgRouter.use(promoRouter);

// Lifecycle DM service (P5r-5) — `sendLifecycleDM` extracted to
// services/lifecycle.ts because the PRO-renewal scheduler also uses it.
// The factory closes over BOT_TOKEN_FOR_DM + logger so neither needs to
// be threaded through every call site downstream.
const sendLifecycleDM = createSendLifecycleDM({ botToken: BOT_TOKEN_FOR_DM, logger });

// Lifecycle / Win-back scheduler (P5r-5) — hourly cron extracted to
// schedulers/lifecycle.ts. All LIFECYCLE_* internal cooldown constants,
// LIFECYCLE_MESSAGES / SEGMENT_CADENCE / MAX_WAVES tables, classifier
// helpers (classifyLifecycleSegment, checkLifecycleCaps,
// shouldStopLifecycle), and the dead-air counter live in the scheduler
// module. Cadence (60 * 60 * 1000) and log labels preserved
// byte-identical.
startLifecycleScheduler({
  prisma, logger, sendLifecycleDM,
  getUserEntitlement, trackEvent,
  MINI_APP_URL_FOR_DM, LIFECYCLE_PROMO_CODE, BOT_TOKEN_FOR_DM,
});

// PRO renewal reminder scheduler (P5r-5) — hourly cron extracted to
// schedulers/pro-renewal.ts. Registered AFTER startLifecycleScheduler so
// the original setInterval ordering (lifecycle first, pro-renewal
// second) is preserved. Uses sendLifecycleDM from services/lifecycle.ts.
startProRenewalReminderScheduler({
  prisma, logger, sendLifecycleDM, trackEvent,
  PRO_PLAN_CODE, MINI_APP_URL_FOR_DM,
});

// Santa schedulers (P5r-3): hint expiry + deadline missed + deadline
// warning + seasonal events wrapper — extracted to ./schedulers/
// santa.ts. Section 2.A helpers (getSeasonStartYear / getSeasonCalendar
// / getSantaSeasonInfo / sendSeasonalBroadcast / maybeRunSeasonalEvents
// / generateSantaAliases / SANTA_*) STAY in index.ts. Cadence and log
// labels preserved byte-identical.
startSantaSchedulers({ prisma, logger, maybeRunSeasonalEvents });

// Reservation-reminder scheduler (P5r-4, position 1 of original order)
// — extracted to ./schedulers/reservations.ts. 15-min cadence; log
// labels + behavior preserved byte-identical. Smart-res schedulers
// register AFTER startEventSchedulers below to keep original sequencing.
startReservationReminderScheduler({ prisma, logger, sendTgBotMessage });

// Events Calendar scheduler (P5r-4): gift-occasion reminders (5-min
// cadence) — extracted to ./schedulers/events.ts. Helpers
// `getNextOccurrenceDate` / `computeReminderSchedule` /
// `buildReminderEpisodeKey` STAY in index.ts (also consumed by
// gift-notes.routes.ts via deps) and are passed through here.
startEventSchedulers({
  prisma, logger,
  sendTgBotMessage,
  BOT_TOKEN_FOR_DM,
  getNextOccurrenceDate, computeReminderSchedule, buildReminderEpisodeKey,
});

// ─── Santa seasonal broadcasts ───────────────────────────────────────────────

/**
 * Send a seasonal broadcast Telegram message to every user who has a telegramChatId.
 * Deduplication is handled by SantaSeasonalBroadcastLog — inserting the log row acts as a
 * distributed lock: if the row already exists (unique constraint), this function exits
 * immediately.  Safe to call concurrently or in a crash-restart scenario.
 *
 * @param type        'PROMO' (sent Nov 1) or 'CLOSING_SOON' (sent Feb 1)
 * @param seasonYear  The November-start year of the season (e.g. 2026 for Nov 2026 → Feb 2027)
 */
async function sendSeasonalBroadcast(type: 'PROMO' | 'CLOSING_SOON', seasonYear: number): Promise<void> {
  // Insert log row FIRST — acts as an atomic write-once lock.
  // Unique constraint on (year, type) means only the first caller proceeds; all others exit.
  try {
    await prisma.santaSeasonalBroadcastLog.create({
      data: { year: seasonYear, type },
    });
  } catch {
    // UniqueConstraintViolation = already sent (or concurrent runner beat us). Skip.
    return;
  }

  const BATCH      = 25;   // users per DB page
  const PAUSE_MS   = 1200; // ~20 req/s; Telegram allows 30 req/s per bot

  // RU + EN in one message — we don't store per-user locale, so serve both languages.
  const textRu = type === 'PROMO'
    ? '🎅 Тайный Санта скоро открывается! Подготовьте вишлист — обмен подарками начнётся 15 ноября.'
    : '⏰ Тайный Санта закроется 15 февраля. Успейте завершить обмен подарками!';
  const textEn = type === 'PROMO'
    ? '🎅 Secret Santa is opening soon! Prepare your wishlist — the gift exchange starts November 15.'
    : '⏰ Secret Santa closes on February 15. Make sure to finish your gift exchange!';
  const text = `${textRu}\n\n${textEn}`;

  let cursor: string | undefined;
  let totalSent = 0;

  // eslint-disable-next-line no-constant-condition
  for (;;) {
    const users = await prisma.user.findMany({
      where:   { telegramChatId: { not: null } },
      select:  { id: true, telegramChatId: true },
      take:    BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
    });

    if (users.length === 0) break;

    for (const u of users) {
      if (!u.telegramChatId) continue;
      await sendTgNotification(u.telegramChatId, text);
      totalSent++;
    }

    cursor = users[users.length - 1]!.id;
    if (users.length < BATCH) break;
    await new Promise<void>(r => setTimeout(r, PAUSE_MS));
  }

  // Record final count for audit trail
  await prisma.santaSeasonalBroadcastLog.update({
    where: { year_type: { year: seasonYear, type } },
    data:  { userCount: totalSent },
  }).catch(() => { /* non-fatal */ });

  logger.info({ type, seasonYear, totalSent }, 'santa-season: broadcast sent');
  void sendAdminAlert(`🎅 Santa broadcast <b>${type}</b> (season ${seasonYear}) sent to <b>${totalSent}</b> users`);
}

/**
 * Idempotent seasonal event handler — runs hourly, triggers broadcasts on calendar milestones.
 *
 * Triggers:
 *   Nov 1  → PROMO broadcast for this year's upcoming season
 *   Feb 1  → CLOSING_SOON broadcast for the season that started last November
 *
 * Deduplication via SantaSeasonalBroadcastLog ensures each broadcast fires exactly once per year,
 * regardless of restarts, multi-instance deployments, or the hourly tick firing multiple times
 * on the same day.
 */
async function maybeRunSeasonalEvents(): Promise<void> {
  try {
    // Abort if the feature is globally disabled
    const globalConfig = await prisma.santaGlobalConfig.findUnique({ where: { id: 'global' } });
    if (!globalConfig?.santaEnabled) return;

    const now        = new Date();
    const seasonYear = getSeasonStartYear(now); // canonical season key (Nov-year); handles cross-year boundary
    const month      = now.getMonth() + 1;
    const day        = now.getDate();

    // ── November 1: promo notification ──────────────────────────────────────
    // Nov 1, 2026 → seasonYear = getSeasonStartYear = 2026 (season opens Nov 15, 2026) ✓
    if (month === 11 && day === 1) {
      const alreadySent = await prisma.santaSeasonalBroadcastLog.findUnique({
        where: { year_type: { year: seasonYear, type: 'PROMO' } },
      });
      if (!alreadySent) {
        logger.info({ seasonYear }, 'santa-season: Nov 1 triggering PROMO broadcast');
        void sendSeasonalBroadcast('PROMO', seasonYear);
      }
    }

    // ── February 1: closing-soon notification ───────────────────────────────
    // Feb 1, 2027 → seasonYear = getSeasonStartYear = 2026 (season started Nov 2026) ✓
    // getSeasonStartYear() handles the cross-year shift automatically — no manual "year - 1" needed.
    if (month === 2 && day === 1) {
      const alreadySent = await prisma.santaSeasonalBroadcastLog.findUnique({
        where: { year_type: { year: seasonYear, type: 'CLOSING_SOON' } },
      });
      if (!alreadySent) {
        logger.info({ seasonYear }, 'santa-season: Feb 1 triggering CLOSING_SOON broadcast');
        void sendSeasonalBroadcast('CLOSING_SOON', seasonYear);
      }
    }
  } catch (err) {
    logger.error({ err }, 'santa-season seasonal event check failed');
  }
}

// (Santa seasonal events scheduler moved to ./schedulers/santa.ts in P5r-3.)

// Smart-res schedulers (P5r-4, positions 3+4 of original order):
// auto-release (5-min) + reminder (15-min) — extracted to ./schedulers/
// reservations.ts. Registered AFTER startEventSchedulers above so the
// pre-extraction ordering (reservation-reminder → events-calendar →
// smart-res-auto-release → smart-res-reminder) is preserved exactly.
startSmartReservationSchedulers({
  prisma, logger,
  sendTgNotification,
  getSmartResLeadHours,
  SYSTEM_ACTOR_HASH,
});

// Birthday reminders kill-switch (P5r-6) — env-derived const STAYS in
// index.ts because both birthdayRemindersRouter (registered just below
// via the P5e factory) and the scheduler factory
// (`startBirthdayRemindersScheduler`, called near the bottom of this
// file) consume it via deps. All BIRTHDAY_* operational constants,
// kind/reason types, and the BIRTHDAY_TZ_OFFSET_HOURS constant moved
// to ./schedulers/birthday-reminders.ts (operational) and
// ./services/birthday-reminders.ts (timezone offset + 6 pure helpers).
const BIRTHDAY_REMINDERS_ENABLED = process.env.BIRTHDAY_REMINDERS_ENABLED !== 'false';

// ─── /tg/birthday-reminders/* + /tg/admin/birthday-reminders/metrics
//     sub-router (P5e split) ───────────────────────────────────────────────
// Wired here (rather than at the top alongside meRouter/refRouter/supportRouter)
// because the factory call closes over BIRTHDAY_REMINDERS_ENABLED — a `const`
// declared a few lines above this block. Earlier wiring would TDZ-error.
// Function helpers (daysUntilNextBirthday, pickBirthdayDisplayName) are
// hoisted, but the const is not, so we keep all five deps resolved here for
// a single, easy-to-read block. Mount order at runtime:
//   protectTgRoute() chain (incl. /birthday-reminders/mute idempotency)
//     -> meRouter -> refRouter -> supportRouter -> P5c batch
//     -> app.use('/tg', tgRouter)            ← already mounted at line ~12200
//     -> tgRouter.use(birthdayRemindersRouter)   ← this block (post-mount,
//                                                  valid: Router stack
//                                                  remains mutable until
//                                                  app.listen())
//     -> app.listen(PORT)
// Helpers stay in index.ts; the scheduler/job code below uses them directly.
const birthdayRemindersRouter = registerBirthdayRemindersRouter({
  getOrCreateTgUser,
  trackEvent,
  BIRTHDAY_REMINDERS_ENABLED,
  daysUntilNextBirthday,
  pickBirthdayDisplayName,
});
tgRouter.use(birthdayRemindersRouter);

// Birthday reminders scheduler (P5r-6) — hourly cron + 30s startup
// kick extracted to ./schedulers/birthday-reminders.ts. All BIRTHDAY_*
// operational constants, kind/reason/candidate types, classifier
// helpers (pickBirthdayPrimaryWishlist, findCommenterRecipients,
// findBirthdayFriendRecipients, recipientHitDailyCap), message
// rendering (birthdayDayWord, buildBirthdayBotMessage), DM helper
// (sendBirthdayBotPost), and delivery orchestration
// (processBirthdayReminders, maybeCreateOwnerDelivery,
// maybeCreateFriendDeliveries, sendBirthdayDelivery, persistOwnerSkip,
// markDeliverySkipped) live in the scheduler module. Pure helpers
// (timezone math, occurrence key, display name) live in
// ./services/birthday-reminders.ts and are also imported by
// birthdayRemindersRouter (P5e contract preserved). Cadence
// (60 * 60 * 1000), startup +30s, MSK send-window (9–22), occurrence
// key dedupe, audience tiers, daily cap, ServiceHeartbeat metadata,
// AnalyticsEvent names, and Telegram message templates preserved
// byte-identical.
startBirthdayRemindersScheduler({
  prisma, logger,
  getEffectiveEntitlements, tgActorHash, trackEvent,
  BIRTHDAY_REMINDERS_ENABLED,
});

// ─── Batch 4.1: Santa Campaign Chat ──────────────────────────────────────────








// ─── Batch 4.2: Santa Campaign Polls ─────────────────────────────────────────







// ─── Batch 5.3: Roles + Organizer Controls + Exit Request Flow ────────────────







app.listen(PORT, () => {
  logger.info({ port: PORT }, 'API server listening');
  // Send startup alert to admins (best-effort)
  void sendAdminAlert(`🟢 <b>API started</b>\nPort: ${PORT}\nEnv: ${process.env.NODE_ENV ?? 'development'}`);

  // Hourly cleanup of expired IdempotencyKey rows. No-op in tests (unless
  // CLEANUP_JOB_IN_TEST=true) and skipped when SECURITY_CLEANUP_JOB_ENABLED=false.
  startIdempotencyCleanupJob();

  // Santa startup jobs (P5r-3): SantaGlobalConfig singleton upsert +
  // alias backfill loop — extracted to ./schedulers/santa.ts. Both are
  // fire-and-forget; behavior preserved byte-identical.
  runSantaStartupJobs({ prisma, logger, generateSantaAliases });
});

// ─── Uncaught exception / rejection alerts ────────────────────────────────────
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaughtException');
  logger.fatal({ err }, 'api uncaughtException');
  if (process.env.GLITCHTIP_DSN) Sentry.captureException(err);
  void sendAdminAlert(`🔴 <b>API uncaughtException</b>\n${String(err)}`).finally(() => process.exit(1));
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection');
  logger.error({ reason }, 'api unhandledRejection');
  if (process.env.GLITCHTIP_DSN && reason instanceof Error) Sentry.captureException(reason);
  void sendAdminAlert(`🔴 <b>API unhandledRejection</b>\n${String(reason)}`);
});
