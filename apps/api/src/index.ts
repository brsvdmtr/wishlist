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
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { z } from 'zod';
import {
  prisma,
  Prisma,
  markFirstWishlist,
  markFirstItem,
  tryQualifyAttribution,
  processReward,
  ensureReferralCode,
  loadReferralConfig,
  invalidateReferralConfigCache,
  checkRewardCap,
  isInRollout,
  sweepExpiredPendingAttributions,
  REWARD_CAP_MONTHLY_WINDOW_DAYS,
  REWARD_CAP_YEARLY_WINDOW_DAYS,
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
import { parseUrl, validateUrl } from './url-parser.js';
import { getOrCreateProfile } from './profile.js';
import { t, detectLocale, normalizeLocale, resolveEffectiveLocale, pluralize, type Locale, type LanguageMode, type LanguageSettings, getOnboardingMeta, type OnboardingMeta, type OnboardingVariant, type AcquisitionPath, type CatalogTemplate, getCatalogForSegment, deriveMarketBucket, isSupportedImportRegion, type MarketBucket, MARKET_BUCKET_LABELS, ANALYTICS_EVENTS } from '@wishlist/shared';

// Sentry namespace stays imported here so the error handler and the
// uncaughtException / unhandledRejection handlers further down can call
// Sentry.captureException. Init itself happens in ./bootstrap/sentry.
import * as Sentry from '@sentry/node';

import { corsMiddleware } from './middleware/cors';
import { requestLogger } from './middleware/requestLogger';
import { registerHealthRoutes } from './health/health.routes';
import { upload } from './uploads/upload.config';
import { processImage } from './uploads/imageProcessor';
import { deleteUploadFile } from './uploads/uploadCleanup';
import { registerUploads } from './uploads/registerUploads';

import { asyncHandler } from './lib/asyncHandler';
import { zodError } from './lib/http';
import { secureCompare } from './lib/crypto';
import { getRequestLocale } from './lib/locale';
import { escapeTgHtml } from './telegram/html';
import { sendTgNotification, sendTgBotMessage } from './telegram/botApi';
import { createTgInvoiceLink } from './telegram/invoiceLink';
import { buildCommentReplyDeepLink } from './telegram/deepLinks';
import { sendAdminAlert } from './notifications/adminAlerts';
import { queueCommentNotification, queueReplyAuthorNotification } from './notifications/commentNotificationQueue';
import { generateUniqueSlug } from './wishlists/slug';
import { generateUniqueShareToken } from './wishlists/shareToken';

import { PLACEMENT_ORDER_BY } from './placements/orderBy';
import { ensureItemPlacement } from './placements/ensureItemPlacement';
import { countActivePlacementsInWishlist } from './placements/countActivePlacementsInWishlist';
import { relocateItemPrimary } from './placements/relocateItemPrimary';

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
const ARCHIVE_VIEW_STATUSES = ['DELETED', 'COMPLETED', 'ARCHIVED'] as const;
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

type TelegramUser = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request { tgUser?: TelegramUser; }
  }
}

/** Max age for Telegram initData auth_date (seconds). Default 24 hours; configurable via INIT_DATA_MAX_AGE_SECONDS. */
const INIT_DATA_MAX_AGE_SECONDS = Math.max(60, parseInt(process.env.INIT_DATA_MAX_AGE_SECONDS ?? '86400', 10));
/** Allow minor clock skew (seconds). */
const INIT_DATA_CLOCK_SKEW_SECONDS = 30;

function validateTelegramInitData(initData: string, botToken: string): { user: TelegramUser } | { reason: string } {
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return { reason: 'no_hash' };
    params.delete('hash');
    const checkString = [...params.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const expectedHash = crypto.createHmac('sha256', secretKey).update(checkString).digest('hex');
    if (!secureCompare(expectedHash, hash)) return { reason: 'hash_mismatch' };

    // ── auth_date expiry: reject stale or missing auth_date ───────────────
    const authDateStr = params.get('auth_date');
    if (!authDateStr) return { reason: 'no_auth_date' };
    const authDate = Number(authDateStr);
    if (!Number.isFinite(authDate) || authDate <= 0) return { reason: 'invalid_auth_date' };
    const nowSec = Math.floor(Date.now() / 1000);
    if (authDate > nowSec + INIT_DATA_CLOCK_SKEW_SECONDS) return { reason: 'future_auth_date' };
    if (nowSec - authDate > INIT_DATA_MAX_AGE_SECONDS) return { reason: 'expired' };

    const userStr = params.get('user');
    if (!userStr) return { reason: 'no_user' };
    return { user: JSON.parse(userStr) as TelegramUser };
  } catch {
    return { reason: 'parse_error' };
  }
}

/** Deterministic actor hash for a Telegram user ID. Formatted as UUID (8-4-4-4-12) to pass z.string().uuid(). */
function tgActorHash(telegramId: number): string {
  const h = crypto.createHash('sha256').update(`tg_actor:${telegramId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const SYSTEM_ACTOR_HASH = '00000000-0000-0000-0000-000000000000';

function requireTelegramAuth(req: Request, res: Response, next: NextFunction) {
  const botToken = process.env.BOT_TOKEN ?? '';
  if (!botToken) return res.status(500).json({ error: 'Bot not configured' });

  // Development bypass: X-TG-DEV: <telegram_id>
  if (process.env.NODE_ENV !== 'production') {
    const devId = req.get('X-TG-DEV');
    if (devId) {
      req.tgUser = { id: Number(devId) || 1, first_name: 'Dev User' };
      return next();
    }
  }

  const initData = req.get('X-TG-INIT-DATA') ?? '';
  const result = validateTelegramInitData(initData, botToken);
  if ('reason' in result) {
    logger.debug({ reason: result.reason, path: req.path, ip: req.ip, initDataLen: initData.length }, 'auth_rejected');
    // Feed the IP throttle so repeated failures from the same IP get capped
    // before they reach the validator. Skipped internally if the kill switch
    // is off; never throws, so this can't break the auth path.
    recordIpEvent(req, 'auth_rejected');
    return res.status(401).json({ error: 'Invalid Telegram auth' });
  }

  req.tgUser = result.user;
  return next();
}

// ─── Plan & Entitlement System ──────────────────────────────────────────────
const PLANS = {
  FREE: {
    code: 'FREE' as const,
    wishlists: 2,
    items: 20,       // reduced from 30; add-ons fill the gap; MAX tier will have 200+
    participants: 5,
    subscriptions: 2,
    features: [] as string[],
  },
  PRO: {
    code: 'PRO' as const,
    wishlists: 10,
    items: 70,       // reduced from 100; MAX tier will be 200+
    participants: 20,
    subscriptions: 5, // reduced from 7; 5 covers active users well; MAX will offer 15+
    features: ['comments', 'url_import', 'hints'],
  },
} as const;

type PlanCode = keyof typeof PLANS;
type PlanInfo = (typeof PLANS)[PlanCode];

const PRO_PRICE_XTR = parseInt(process.env.PRO_PRICE_XTR ?? '100', 10);
const PRO_YEARLY_PRICE_XTR = parseInt(process.env.PRO_YEARLY_PRICE_XTR ?? '800', 10);
const PRO_SUBSCRIPTION_PERIOD = parseInt(process.env.PRO_SUBSCRIPTION_PERIOD ?? '2592000', 10);
// Yearly one-time purchase extends entitlement by this many seconds.
// Telegram Stars doesn't support subscription_period > 30 days, so yearly is a
// non-recurring invoice; the bot extends currentPeriodEnd manually on success.
const PRO_YEARLY_EXTEND_SECONDS = parseInt(process.env.PRO_YEARLY_EXTEND_SECONDS ?? '31536000', 10);
const PRO_PLAN_CODE = process.env.PRO_PLAN_CODE ?? 'PRO';

// ─── Reservation Pro — feature gate ─────────────────────────────────────────

/** User sees the new reservation UI — v2: open to all users */
function isReservationBeta(user: { telegramId?: string | null; godMode: boolean }): boolean {
  return true; // v2: feature is open to all users
}

/** User has actual Pro reservation features (Pro subscription OR one-time addon) */
function hasReservationPro(user: { telegramId?: string | null; godMode: boolean }, isPro: boolean, addOns?: Array<{ addonType: string }>): boolean {
  if (user.godMode) return true;
  if (isPro) return true;
  if (addOns?.some(a => a.addonType === 'reservation_pro_unlock')) return true;
  return false;
}

/** Smart Reservations: lead-time hours for reminder/expiringSoon by TTL */
function getSmartResLeadHours(ttlH: number): number {
  if (ttlH >= 168) return 48;
  if (ttlH >= 72) return 24;
  if (ttlH >= 48) return 12;
  return 6;
}

/** Smart Reservations: owner-side entitlement check (PRO or per-wishlist add-on) */
function hasSmartReservations(
  ownerUser: { godMode: boolean },
  ownerIsPro: boolean,
  ownerAddOns: Array<{ addonType: string; targetId?: string | null }>,
  wishlistId: string,
): boolean {
  if (ownerUser.godMode || ownerIsPro) return true;
  return ownerAddOns.some(a => a.addonType === 'smart_reservations_unlock' && a.targetId === wishlistId);
}

// ─── Gift Notes (Поводы и идеи) — one-time unlock ────────────────────────────
const GIFT_NOTES_PRICE_XTR = parseInt(process.env.GIFT_NOTES_PRICE_XTR ?? '19', 10);
const GIFT_NOTES_SKU = 'gift_notes_unlock';
const GROUP_GIFT_PRICE_XTR = parseInt(process.env.GROUP_GIFT_PRICE_XTR ?? '79', 10);
const GROUP_GIFT_SKU = 'group_gift_unlock';
const SECRET_RESERVATION_PRICE_XTR = parseInt(process.env.SECRET_RESERVATION_PRICE_XTR ?? '24', 10);
const SECRET_RESERVATION_SKU = 'secret_reservation_unlock';

// ─── One-time SKU catalogue ──────────────────────────────────────────────────
const ONE_TIME_SKUS = {
  extra_wishlist_slot:     { code: 'extra_wishlist_slot',     price: 39, type: 'permanent' as const,  addonType: 'wishlist_slot'       as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0,  targetRequired: false },
  extra_subscription_slot: { code: 'extra_subscription_slot', price: 25, type: 'permanent' as const,  addonType: 'subscription_slot'   as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0,  targetRequired: false },
  extra_items_5:           { code: 'extra_items_5',           price: 19, type: 'permanent' as const,  addonType: 'item_slot_5'         as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0,  targetRequired: true  },
  extra_items_15:          { code: 'extra_items_15',          price: 39, type: 'permanent' as const,  addonType: 'item_slot_15'        as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0,  targetRequired: true  },
  hints_pack_5:            { code: 'hints_pack_5',            price: 29, type: 'consumable' as const, addonType: null as string | null,                  creditKey: 'hint'   as 'hint' | 'import' | null, creditAmount: 5,  targetRequired: false },
  hints_pack_10:           { code: 'hints_pack_10',           price: 49, type: 'consumable' as const, addonType: null as string | null,                  creditKey: 'hint'   as 'hint' | 'import' | null, creditAmount: 10, targetRequired: false },
  import_pack_10:          { code: 'import_pack_10',          price: 39, type: 'consumable' as const, addonType: null as string | null,                  creditKey: 'import' as 'hint' | 'import' | null, creditAmount: 10, targetRequired: false },
  import_pack_25:          { code: 'import_pack_25',          price: 79, type: 'consumable' as const, addonType: null as string | null,                  creditKey: 'import' as 'hint' | 'import' | null, creditAmount: 25, targetRequired: false },
  seasonal_decoration:     { code: 'seasonal_decoration',     price: 29, type: 'cosmetic' as const,   addonType: 'seasonal_decoration' as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0,  targetRequired: true  },
  gift_notes_unlock:       { code: 'gift_notes_unlock',       price: GIFT_NOTES_PRICE_XTR, type: 'permanent' as const, addonType: 'gift_notes_unlock' as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0, targetRequired: false },
  reservation_pro_unlock:  { code: 'reservation_pro_unlock',  price: 50, type: 'permanent' as const, addonType: 'reservation_pro_unlock' as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0, targetRequired: false },
  group_gift_unlock:       { code: 'group_gift_unlock',       price: GROUP_GIFT_PRICE_XTR, type: 'permanent' as const, addonType: 'group_gift_unlock' as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0, targetRequired: false },
  smart_reservations_unlock: { code: 'smart_reservations_unlock', price: 15, type: 'permanent' as const, addonType: 'smart_reservations_unlock' as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0, targetRequired: true },
  secret_reservation_unlock: { code: 'secret_reservation_unlock', price: SECRET_RESERVATION_PRICE_XTR, type: 'permanent' as const, addonType: 'secret_reservation_unlock' as string | null, creditKey: null as 'hint' | 'import' | null, creditAmount: 0, targetRequired: false },
} as const;

type SkuCode = keyof typeof ONE_TIME_SKUS;

// ─── Add-on caps — prevent add-ons from substituting PRO ────────────────────
const ADDON_CAPS = {
  extraWishlistSlots:        { FREE: 3, PRO: 5 }, // FREE total≤5; PRO total≤15
  extraSubscriptionSlots:    3,                   // any plan: +3 max (FREE→5, PRO→8)
  extraItems5PerWishlist:    3,                   // +5×3 = +15 items per wishlist
  extraItems15PerWishlist:   1,                   // +15×1 = +15 items per wishlist
} as const;

type PromoProInfo = { id: string; expiresAt: string | null; campaignCode: string } | null;

async function getUserEntitlement(userId: string, godMode = false): Promise<{
  plan: PlanInfo;
  isPro: boolean;
  proSource: 'subscription' | 'promo' | 'god_mode' | null;
  subscription: { id: string; status: string; periodEnd: string; cancelledAt: string | null; cancelAtPeriodEnd: boolean; billingPeriod: string | null } | null;
  promoPro: PromoProInfo;
}> {
  // 1. Check paid subscription first (highest priority)
  const sub = await prisma.subscription.findFirst({
    where: {
      userId,
      planCode: PRO_PLAN_CODE,
      status: { in: ['ACTIVE', 'CANCELLED'] },
      currentPeriodEnd: { gt: new Date() },
    },
    orderBy: { currentPeriodEnd: 'desc' },
  });

  // Also check active promo-PRO (expiresAt === null means lifetime PRO)
  const promoRedemption = await prisma.promoRedemption.findFirst({
    where: {
      userId,
      status: 'ACTIVE',
      OR: [{ expiresAt: { gt: new Date() } }, { expiresAt: null }],
    },
    include: { campaign: { select: { code: true } } },
  });
  const promoPro: PromoProInfo = promoRedemption
    ? { id: promoRedemption.id, expiresAt: promoRedemption.expiresAt?.toISOString() ?? null, campaignCode: promoRedemption.campaign.code }
    : null;

  if (sub) {
    return {
      plan: PLANS.PRO,
      isPro: true,
      proSource: 'subscription',
      subscription: {
        id: sub.id,
        status: sub.status,
        periodEnd: sub.currentPeriodEnd.toISOString(),
        cancelledAt: sub.cancelledAt?.toISOString() ?? null,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        billingPeriod: sub.billingPeriod ?? null,
      },
      promoPro,
    };
  }

  // 2. Check active promo-PRO
  if (promoPro) {
    return {
      plan: PLANS.PRO,
      isPro: true,
      proSource: 'promo',
      subscription: null,
      promoPro,
    };
  }

  // 3. God Mode: virtual PRO without real subscription
  if (godMode) {
    return { plan: PLANS.PRO, isPro: true, proSource: 'god_mode', subscription: null, promoPro: null };
  }

  return { plan: PLANS.FREE, isPro: false, proSource: null, subscription: null, promoPro: null };
}

/** Unified effective entitlement resolver — single source of truth for all limit checks.
 *  When godMode is omitted, auto-resolves from DB so callers can't forget it. */
async function getEffectiveEntitlements(userId: string, godMode?: boolean) {
  const resolvedGodMode = godMode ?? (await prisma.user.findUnique({ where: { id: userId }, select: { godMode: true } }))?.godMode ?? false;
  const [base, addOns, credits] = await Promise.all([
    getUserEntitlement(userId, resolvedGodMode),
    prisma.userAddOn.findMany({ where: { userId } }),
    prisma.userCredits.findUnique({ where: { userId } }),
  ]);

  const extraWishlistSlots = addOns
    .filter(a => a.addonType === 'wishlist_slot')
    .reduce((s, a) => s + a.quantity, 0);

  const extraSubscriptionSlots = addOns
    .filter(a => a.addonType === 'subscription_slot')
    .reduce((s, a) => s + a.quantity, 0);

  // Per-wishlist extra items: wishlistId → additional item count
  const extraItemsPerWishlist: Record<string, number> = {};
  for (const a of addOns.filter(a => a.addonType === 'item_slot_5' || a.addonType === 'item_slot_15')) {
    if (a.targetId) {
      extraItemsPerWishlist[a.targetId] = (extraItemsPerWishlist[a.targetId] ?? 0) + a.quantity;
    }
  }

  // Seasonal decoration wishlist IDs
  const seasonalWishlists = new Set<string>(
    addOns.filter(a => a.addonType === 'seasonal_decoration' && a.targetId).map(a => a.targetId!)
  );

  return {
    ...base,
    effectiveWishlistLimit: base.plan.wishlists + extraWishlistSlots,
    effectiveSubscriptionLimit: base.plan.subscriptions + extraSubscriptionSlots,
    extraItemsPerWishlist,
    seasonalWishlists,
    hintCredits: credits?.hintCredits ?? 0,
    importCredits: credits?.importCredits ?? 0,
    addOns,
    // Gift Notes access: PRO users get it, or one-time unlock via UserAddOn
    hasGiftNotes: base.isPro || godMode || addOns.some(a => a.addonType === GIFT_NOTES_SKU),
    giftNotes: {
      unlocked: base.isPro || godMode || addOns.some(a => a.addonType === GIFT_NOTES_SKU),
      unlockType: base.isPro ? 'PRO' as const : addOns.some(a => a.addonType === GIFT_NOTES_SKU) ? 'ONE_TIME' as const : godMode ? 'GOD' as const : null,
      priceXtr: GIFT_NOTES_PRICE_XTR,
    },
    // Smart Reservations: per-wishlist add-on IDs
    smartReservationsWishlists: new Set<string>(
      addOns.filter(a => a.addonType === 'smart_reservations_unlock' && a.targetId).map(a => a.targetId!)
    ),
    // Group Gift access: one-time unlock via UserAddOn (not included in PRO)
    hasGroupGift: godMode || addOns.some(a => a.addonType === GROUP_GIFT_SKU),
    groupGift: {
      unlocked: godMode || addOns.some(a => a.addonType === GROUP_GIFT_SKU),
      priceXtr: GROUP_GIFT_PRICE_XTR,
    },
    // Secret Reservations access: PRO users get it, or one-time unlock via UserAddOn
    hasSecretReservations: base.isPro || resolvedGodMode || addOns.some(a => a.addonType === SECRET_RESERVATION_SKU),
    secretReservations: {
      unlocked: base.isPro || resolvedGodMode || addOns.some(a => a.addonType === SECRET_RESERVATION_SKU),
      unlockType: base.isPro ? 'PRO' as const : addOns.some(a => a.addonType === SECRET_RESERVATION_SKU) ? 'ONE_TIME' as const : resolvedGodMode ? 'GOD' as const : null,
      priceXtr: SECRET_RESERVATION_PRICE_XTR,
    },
  };
}

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

/** Check if a wishlist is writable (within plan limits) for the given user */
async function isWishlistWritable(userId: string, wishlistId: string, planLimit: number): Promise<boolean> {
  const allWishlists = await prisma.wishlist.findMany({
    where: { ownerId: userId, type: 'REGULAR', archivedAt: null },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  const writableIds = new Set(allWishlists.slice(0, planLimit).map(w => w.id));
  return writableIds.has(wishlistId);
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
type EntryPoint =
  | 'first_open'
  | 'auto_after_first_wishlist'
  | 'organic_returning_underactivated'
  | 'forced_rollout_test'
  | 'manual_cta';
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

/** Returns true if the item counts as a real (non-demo) item for activation eligibility. */
function isRealItemForActivation(item: { isDemo: boolean; originType: string; status: string }): boolean {
  return (
    !item.isDemo &&
    item.originType !== 'DEMO' &&
    item.status !== 'DELETED' &&
    item.status !== 'ARCHIVED'
  );
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

async function getOrCreateTgUser(tgUser: TelegramUser) {
  return prisma.user.upsert({
    where: { telegramId: String(tgUser.id) },
    update: { telegramChatId: String(tgUser.id), firstName: tgUser.first_name || null },
    create: { telegramId: String(tgUser.id), telegramChatId: String(tgUser.id), firstName: tgUser.first_name || null },
  });
}

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
// Pre-existing security gap (NOT fixed here): POST /items/:id/hint has no
// protectTgRoute(...) registration; it relies on its own internal anti-
// spam (3/item/30d + 5/sender/day) plus a 30-min idempotent fast-path.
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

// ─── /tg/santa/* sub-router (P5p — final domain extraction; 58 handlers,
//     all remaining inline tg routes) ─────────────────────────────────────
// With this mount, `apps/api/src/index.ts` becomes a true composition root
// per docs/REFACTOR_API_INDEX_HANDOFF.md — bootstrap, middleware, router
// registration, schedulers, app.listen, process handlers.
//
// Pre-existing security gap: NO `protectTgRoute` entries for Santa routes.
// Per CLAUDE.md § Security layer, Santa is a Wave-2 deferral. Not addressed
// in this PR; follow-up will add idempotency middleware + rate limits.
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

// TTL cleanup for expired comments (runs every hour)
setInterval(async () => {
  try {
    const result = await prisma.comment.deleteMany({
      where: { scheduledDeleteAt: { lte: new Date() } },
    });
    if (result.count > 0) {
      logger.info({ count: result.count }, 'ttl: cleaned expired comments');
    }
  } catch (err) {
    logger.error({ err }, 'ttl cleanup failed');
  }
}, 60 * 60 * 1000);

// TTL cleanup for expired curated selections — delete subscriptions to expired/deactivated selections (hourly)
setInterval(async () => {
  try {
    const result = await prisma.curatedSelectionSubscription.deleteMany({
      where: {
        curatedSelection: {
          OR: [
            { expiresAt: { lte: new Date() } },
            { deactivatedAt: { not: null } },
          ],
        },
      },
    });
    if (result.count > 0) {
      logger.info({ count: result.count }, 'ttl: cleaned subscriptions for expired/deactivated curated selections');
    }
  } catch (err) {
    logger.error({ err }, 'curated selection subscription ttl cleanup failed');
  }
}, 60 * 60 * 1000);

// Archive purge: hard-delete items past 90-day TTL + cleanup media files (hourly)
setInterval(async () => {
  try {
    const expired = await prisma.item.findMany({
      where: { purgeAfter: { lte: new Date() } },
      select: { id: true, imageUrl: true },
      take: 100, // batch limit — rest picked up next hour
    });
    if (expired.length === 0) return;

    logger.info({ count: expired.length }, 'purge: found expired archive items');
    let deleted = 0, files = 0, errors = 0;

    for (const item of expired) {
      try {
        // DB first, files second — orphaned files are harmless, orphaned DB records with broken images are not
        await prisma.item.delete({ where: { id: item.id } });
        deleted++;
        if (item.imageUrl) {
          deleteUploadFile(item.imageUrl);
          files++;
        }
      } catch (err) {
        errors++;
        logger.error({ err, itemId: item.id }, 'purge: item deletion failed');
      }
    }

    logger.info({ deleted, files, errors }, 'purge: done');
  } catch (err) {
    logger.error({ err }, 'purge job failed');
  }
}, 60 * 60 * 1000);

// Subscription expiry: mark overdue subscriptions as EXPIRED (hourly)
setInterval(async () => {
  try {
    const expired = await prisma.subscription.updateMany({
      where: {
        status: { in: ['ACTIVE', 'CANCELLED'] },
        currentPeriodEnd: { lte: new Date() },
      },
      data: { status: 'EXPIRED' },
    });
    if (expired.count > 0) {
      logger.info({ count: expired.count }, 'billing: expired subscriptions');
    }
  } catch (err) {
    logger.error({ err }, 'billing expiry check failed');
  }
}, 60 * 60 * 1000);

// Promo expiry: mark ACTIVE promo redemptions past their expiresAt as EXPIRED (hourly)
setInterval(async () => {
  try {
    const expired = await prisma.promoRedemption.updateMany({
      where: { status: 'ACTIVE', expiresAt: { lte: new Date() } },
      data: { status: 'EXPIRED' },
    });
    if (expired.count > 0) {
      logger.info({ count: expired.count }, 'promo: expired promo redemptions');
      // Start grace period for users who lost PRO (no paid sub either)
      const expiredRedemptions = await prisma.promoRedemption.findMany({
        where: { status: 'EXPIRED', expiresAt: { lte: new Date(), gte: new Date(Date.now() - 2 * 60 * 60 * 1000) } },
        select: { userId: true },
      });
      for (const r of expiredRedemptions) {
        // Only start degradation if user has no active paid sub
        const sub = await prisma.subscription.findFirst({
          where: { userId: r.userId, status: { in: ['ACTIVE', 'CANCELLED'] }, currentPeriodEnd: { gt: new Date() } },
        });
        if (!sub) {
          await prisma.degradationState.upsert({
            where: { userId: r.userId },
            update: {},  // don't overwrite existing degradation
            create: {
              userId: r.userId,
              phase: 'GRACE_PERIOD',
              graceEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
            },
          });
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'promo expiry check failed');
  }
}, 60 * 60 * 1000);

// Degradation: archive over-limit data after grace period ends (hourly)
setInterval(async () => {
  try {
    const graceExpired = await prisma.degradationState.findMany({
      where: { phase: 'GRACE_PERIOD', graceEndsAt: { lte: new Date() } },
      include: { user: { select: { id: true } } },
    });
    for (const ds of graceExpired) {
      const userId = ds.userId;
      // Check if user regained PRO
      const ent = await getUserEntitlement(userId);
      if (ent.isPro) {
        await prisma.degradationState.update({ where: { id: ds.id }, data: { phase: 'NONE' } });
        continue;
      }
      // Archive newest wishlists beyond FREE limit
      const wishlists = await prisma.wishlist.findMany({
        where: { ownerId: userId, type: 'REGULAR', archivedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      const overLimitWls = wishlists.slice(PLANS.FREE.wishlists);
      const archivedWlIds: string[] = [];
      const archivedItemIds: string[] = [];
      if (overLimitWls.length > 0) {
        for (const wl of overLimitWls) {
          await prisma.wishlist.update({ where: { id: wl.id }, data: { archivedAt: new Date() } });
          archivedWlIds.push(wl.id);
        }
      }
      // Archive newest items beyond FREE limit in remaining wishlists
      const remainingWls = wishlists.slice(0, PLANS.FREE.wishlists);
      for (const wl of remainingWls) {
        const items = await prisma.item.findMany({
          where: { wishlistId: wl.id, status: { in: ['AVAILABLE', 'RESERVED'] }, archivedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        const overLimitItems = items.slice(PLANS.FREE.items);
        for (const it of overLimitItems) {
          await prisma.item.update({ where: { id: it.id }, data: { archivedAt: new Date() } });
          archivedItemIds.push(it.id);
        }
      }
      await prisma.degradationState.update({
        where: { id: ds.id },
        data: {
          phase: (archivedWlIds.length > 0 || archivedItemIds.length > 0) ? 'ARCHIVED' : 'NONE',
          archivedAt: new Date(),
          purgeScheduledAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
          archivedWishlistIds: JSON.stringify(archivedWlIds),
          archivedItemIds: JSON.stringify(archivedItemIds),
        },
      });
      if (archivedWlIds.length > 0 || archivedItemIds.length > 0) {
        logger.info({ wishlists: archivedWlIds.length, items: archivedItemIds.length, userId }, 'degradation: archived data');
      }
    }
  } catch (err) {
    logger.error({ err }, 'degradation archive job failed');
  }
}, 60 * 60 * 1000);

// Degradation: purge archived data after 90 days (hourly)
setInterval(async () => {
  try {
    const toPurge = await prisma.degradationState.findMany({
      where: { phase: 'ARCHIVED', purgeScheduledAt: { lte: new Date() } },
    });
    for (const ds of toPurge) {
      // Check if user regained PRO
      const ent = await getUserEntitlement(ds.userId);
      if (ent.isPro) {
        // Restore archived data
        const wlIds: string[] = JSON.parse(ds.archivedWishlistIds || '[]');
        const itemIds: string[] = JSON.parse(ds.archivedItemIds || '[]');
        if (wlIds.length) await prisma.wishlist.updateMany({ where: { id: { in: wlIds } }, data: { archivedAt: null } });
        if (itemIds.length) await prisma.item.updateMany({ where: { id: { in: itemIds } }, data: { archivedAt: null } });
        await prisma.degradationState.update({ where: { id: ds.id }, data: { phase: 'NONE' } });
        continue;
      }
      // Purge: delete archived wishlists and items permanently
      const wlIds: string[] = JSON.parse(ds.archivedWishlistIds || '[]');
      const itemIds: string[] = JSON.parse(ds.archivedItemIds || '[]');
      if (itemIds.length) await prisma.item.deleteMany({ where: { id: { in: itemIds } } });
      if (wlIds.length) await prisma.wishlist.deleteMany({ where: { id: { in: wlIds } } });
      await prisma.degradationState.update({ where: { id: ds.id }, data: { phase: 'PURGED' } });
      logger.info({ wishlists: wlIds.length, items: itemIds.length, userId: ds.userId }, 'degradation: purged data');
    }
  } catch (err) {
    logger.error({ err }, 'degradation purge job failed');
  }
}, 60 * 60 * 1000);

// ─── Referral program: expired-attribution sweeper (every 15 min) ────────────
// Flips PENDING_ACTIVATION rows past windowDeadlineAt → REJECTED with
// QUALIFICATION_TIMEOUT. Drains up to SWEEP_BATCH_SIZE × SWEEP_MAX_ITERATIONS
// per run so a backlog spike is absorbed without ad-hoc scripts. Emits a single
// aggregated analytics event per run; per-user funnel events are already
// covered by the attribution/qualified/rewarded events.
const REFERRAL_SWEEP_INTERVAL_MS = 15 * 60 * 1000;
setInterval(async () => {
  try {
    const result = await sweepExpiredPendingAttributions(prisma);
    if (result.expired > 0) {
      logger.info({ expired: result.expired }, '[referral] sweep: expired pending attributions');
      trackAnalyticsEvent({
        event: 'referral.qualification_timeout',
        props: { expired: result.expired, source: 'cron' },
      });
    }
  } catch (err) {
    logger.error({ err }, '[referral] sweep failed');
  }
}, REFERRAL_SWEEP_INTERVAL_MS);

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

const LIFECYCLE_PROMO_COOLDOWN_DAYS = 60; // max 1 promo offer per 60 days
const LIFECYCLE_MSG_COOLDOWN_HOURS = 72; // min 72h between messages
const LIFECYCLE_MAX_MARKETING_45D = 5; // max 5 marketing touches in 45 days
// Dead-air alarm: if N cycles in a row produce 0 sends despite a non-empty
// candidate pool, log a structured warn so the daily cron monitor catches it.
// 24 cycles ≈ 24 h. Plateau is normal; total silence on a non-empty pool is not.
const LIFECYCLE_DEAD_AIR_THRESHOLD = 24;
let lifecycleDeadCycles = 0;

/**
 * Outcome classification for a lifecycle DM send attempt.
 *   'delivered'         — Telegram accepted, message on its way
 *   'bot_blocked'       — user blocked the bot (403). Permanent. Auto-unsubscribe.
 *   'chat_not_found'    — chat deleted / user deactivated (400 with specific descr).
 *                          Permanent for this episode, but keep marketing opt-in
 *                          since the user may return via /start.
 *   'permanent_failure' — other non-retryable TG rejection.
 *   'transient_failure' — 429 / 5xx / network. Caller MUST leave the touch in
 *                          a pending state (no sentAt) so the next cycle retries.
 */
type SendDmOutcome = 'delivered' | 'bot_blocked' | 'chat_not_found' | 'permanent_failure' | 'transient_failure';

/** Send a Telegram DM via bot API. Returns a classified outcome. */
async function sendLifecycleDM(chatId: string, text: string, webAppUrl?: string): Promise<SendDmOutcome> {
  if (!BOT_TOKEN_FOR_DM || !chatId) return 'permanent_failure';
  const chatIdTail = String(chatId).slice(-4); // log suffix only, keep PII minimal
  try {
    const body: any = { chat_id: chatId, text, parse_mode: 'HTML' };
    if (webAppUrl) {
      body.reply_markup = { inline_keyboard: [[{ text: 'Открыть WishBoard ✨', web_app: { url: webAppUrl } }]] };
    }
    const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN_FOR_DM}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const data = await r.json() as { ok: boolean; error_code?: number; description?: string };
    if (data.ok) return 'delivered';

    // Classify Telegram-side rejection. See
    // https://core.telegram.org/bots/api#making-requests for error codes.
    const code = data.error_code ?? r.status;
    const desc = (data.description ?? '').toLowerCase();
    let outcome: SendDmOutcome;
    if (code === 403) {
      // "Forbidden: bot was blocked by the user"
      outcome = 'bot_blocked';
    } else if (code === 400 && (desc.includes('chat not found') || desc.includes('user is deactivated'))) {
      outcome = 'chat_not_found';
    } else if (code === 429 || code >= 500) {
      // Flood-control / Telegram-side transient. Retry next cycle.
      outcome = 'transient_failure';
    } else {
      outcome = 'permanent_failure';
    }

    logger.warn(
      { chatIdTail, httpStatus: r.status, errorCode: code, description: data.description, outcome },
      'lifecycle DM rejected by Telegram',
    );
    return outcome;
  } catch (err) {
    // Network-level failure (timeout, DNS, IPv4 block, TLS) — always transient.
    logger.warn(
      { chatIdTail, err: err instanceof Error ? err.message : String(err) },
      'lifecycle DM fetch error (transient)',
    );
    return 'transient_failure';
  }
}

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
      select: { id: true, telegramChatId: true, telegramId: true, updatedAt: true, createdAt: true, profile: { select: { notifyMarketing: true, languageMode: true, manualLanguage: true } } },
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

      // Determine locale
      const locale = resolveEffectiveLocale(
        candidate.profile ? { languageMode: candidate.profile.languageMode as any, manualLanguage: candidate.profile.manualLanguage as any } : null,
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
      const outcome = await sendLifecycleDM(candidate.telegramChatId, msgText, webAppUrl);
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
      logger.info({ delivered, outcome, segment, touchNumber: nextTouchNumber, userId: candidate.id.slice(0, 8), promo: actuallyOfferPromo }, 'lifecycle touch sent');
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

// Santa hint expiry: mark PENDING santa hint requests past their TTL as EXPIRED (hourly)
setInterval(async () => {
  try {
    const expired = await prisma.santaHintRequest.updateMany({
      where: { status: 'PENDING', expiresAt: { lte: new Date() } },
      data: { status: 'EXPIRED' },
    });
    if (expired.count > 0) {
      logger.info({ count: expired.count }, 'santa-hints: expired hint requests');
    }
  } catch (err) {
    logger.error({ err }, 'santa-hints expiry check failed');
  }
}, 60 * 60 * 1000);

// PRO renewal reminders (hourly). Fires at two milestones:
//   - 7 days before currentPeriodEnd (window 6d–8d)
//   - 1 day  before currentPeriodEnd (window 12h–36h)
// Sent only to subs that won't auto-renew: yearly one-time purchases, or
// monthly subs the user cancelled (cancelAtPeriodEnd=true). Active monthly
// auto-renewals are silent (Telegram charges automatically, no action needed).
// Idempotency: synthetic PaymentEvent id `reminder:<ms>:<subId>:<periodEndISO>`
// — the @unique on telegramPaymentChargeId prevents duplicate sends.
setInterval(async () => {
  try {
    const now = new Date();
    const windows = [
      { milestone: '7d' as const, lo: now.getTime() + 6 * 24 * 60 * 60 * 1000, hi: now.getTime() + 8 * 24 * 60 * 60 * 1000, key: 'bot_pro_renewal_7d' as const },
      { milestone: '1d' as const, lo: now.getTime() + 12 * 60 * 60 * 1000, hi: now.getTime() + 36 * 60 * 60 * 1000, key: 'bot_pro_renewal_1d' as const },
    ];

    for (const w of windows) {
      const subs = await prisma.subscription.findMany({
        where: {
          planCode: PRO_PLAN_CODE,
          status: 'ACTIVE',
          currentPeriodEnd: { gte: new Date(w.lo), lte: new Date(w.hi) },
          OR: [
            { billingPeriod: 'yearly' },
            { cancelAtPeriodEnd: true },
          ],
        },
        include: {
          user: {
            select: { id: true, telegramChatId: true, profile: { select: { languageMode: true, manualLanguage: true, notifyMarketing: true } } },
          },
        },
      });

      for (const sub of subs) {
        if (!sub.user.telegramChatId) continue;
        if (sub.user.profile && sub.user.profile.notifyMarketing === false) continue;

        const reminderId = `reminder:${w.milestone}:${sub.id}:${sub.currentPeriodEnd.toISOString()}`;
        const existing = await prisma.paymentEvent.findUnique({ where: { telegramPaymentChargeId: reminderId } });
        if (existing) continue;

        const locale = resolveEffectiveLocale(
          sub.user.profile ? { languageMode: sub.user.profile.languageMode as any, manualLanguage: sub.user.profile.manualLanguage as any } : null,
        );
        const dateFmtLocale = locale === 'ru' ? 'ru-RU' : 'en-US';
        const fmtDate = sub.currentPeriodEnd.toLocaleDateString(dateFmtLocale, { day: 'numeric', month: 'long', year: 'numeric' });
        const text = t(w.key, locale, { date: fmtDate });

        const outcome = await sendLifecycleDM(sub.user.telegramChatId, text, MINI_APP_URL_FOR_DM);
        if (outcome === 'transient_failure') continue; // retry next hour

        // Persist idempotency marker (even on permanent failure — we've tried and
        // won't spam on retry; user can re-engage from the app).
        await prisma.paymentEvent.create({
          data: {
            subscriptionId: sub.id,
            userId: sub.userId,
            telegramPaymentChargeId: reminderId,
            invoicePayload: reminderId,
            totalAmount: 0,
            currency: 'XTR',
            eventType: `reminder_sent_${w.milestone}`,
          },
        }).catch((err) => logger.warn({ err, reminderId }, 'reminder marker insert failed'));

        if (outcome === 'delivered') {
          trackEvent(`pro_renewal_reminder_${w.milestone}`, sub.userId, { billingPeriod: sub.billingPeriod });
        }
      }
    }
  } catch (err) {
    logger.error({ err }, 'pro-renewal-reminder cycle failed');
  }
}, 60 * 60 * 1000);

// Santa deadline enforcement: mark overdue PENDING/BUYING assignments as MISSED_DEADLINE (hourly)
// Recoverable: giver can still update their status after missing the deadline.
setInterval(async () => {
  try {
    const now = new Date();
    // Find rounds belonging to ACTIVE campaigns whose drawAt has passed
    const overdueRounds = await prisma.santaRound.findMany({
      where: {
        campaign: { status: 'ACTIVE', drawAt: { lte: now, not: null } },
        drawStatus: 'DONE',
      },
      select: { id: true, campaignId: true },
    });
    if (overdueRounds.length === 0) return;

    let totalMissed = 0;
    for (const round of overdueRounds) {
      // Find assignments still in actionable but uncommitted states
      const overdueAssignments = await prisma.santaAssignment.findMany({
        where: { roundId: round.id, giftStatus: { in: ['PENDING', 'BUYING'] } },
        select: { id: true, giver: { select: { userId: true } } },
      });
      if (overdueAssignments.length === 0) continue;

      // Bulk update — MISSED_DEADLINE is recoverable (giver can still pick a status)
      await prisma.santaAssignment.updateMany({
        where: { id: { in: overdueAssignments.map(a => a.id) } },
        data: { giftStatus: 'MISSED_DEADLINE' },
      });
      totalMissed += overdueAssignments.length;

      // Create DEADLINE_MISSED notifications — batch insert, deduped per assignment
      await prisma.santaNotification.createMany({
        data: overdueAssignments.map(a => ({
          campaignId: round.campaignId,
          userId: a.giver.userId,
          type: 'DEADLINE_MISSED' as const,
          payload: { assignmentId: a.id },
          dedupeKey: `missed:${a.id}`,   // unique per (user, DEADLINE_MISSED, assignment)
        })),
        skipDuplicates: true,
      }).catch(() => { /* non-fatal */ });
    }

    if (totalMissed > 0) {
      logger.info({ count: totalMissed }, 'santa-deadlines: marked assignments as MISSED_DEADLINE');
    }
  } catch (err) {
    logger.error({ err }, 'santa-deadlines missed-deadline job failed');
  }
}, 60 * 60 * 1000);

// Santa deadline warning: notify PENDING/BUYING givers ~3 days before drawAt (hourly check)
// Warning window: between 72h and 96h before drawAt (fires once per ~day, not every hour).
setInterval(async () => {
  try {
    const now = new Date();
    const warningWindowStart = new Date(now.getTime() + 72 * 60 * 60 * 1000);  // 3 days from now
    const warningWindowEnd   = new Date(now.getTime() + 96 * 60 * 60 * 1000);  // 4 days from now

    const warningRounds = await prisma.santaRound.findMany({
      where: {
        campaign: {
          status: 'ACTIVE',
          drawAt: { gte: warningWindowStart, lte: warningWindowEnd },
        },
        drawStatus: 'DONE',
      },
      select: { id: true, campaignId: true },
    });
    if (warningRounds.length === 0) return;

    let totalWarned = 0;
    for (const round of warningRounds) {
      const pendingAssignments = await prisma.santaAssignment.findMany({
        where: { roundId: round.id, giftStatus: { in: ['PENDING', 'BUYING'] } },
        select: { id: true, giver: { select: { userId: true } } },
      });
      if (pendingAssignments.length === 0) continue;

      // Batch insert DEADLINE_WARNING — deduped per assignment via dedupeKey; no findFirst needed
      const warnResult = await prisma.santaNotification.createMany({
        data: pendingAssignments.map(a => ({
          campaignId: round.campaignId,
          userId: a.giver.userId,
          type: 'DEADLINE_WARNING' as const,
          payload: { assignmentId: a.id },
          dedupeKey: `warn:${a.id}`,    // unique per (user, DEADLINE_WARNING, assignment)
        })),
        skipDuplicates: true,
      }).catch(() => ({ count: 0 }));
      totalWarned += warnResult.count;
    }

    if (totalWarned > 0) {
      logger.info({ count: totalWarned }, 'santa-deadlines: sent DEADLINE_WARNING to givers');
    }
  } catch (err) {
    logger.error({ err }, 'santa-deadlines deadline-warning job failed');
  }
}, 60 * 60 * 1000);

// ─── Reservation reminder cron (every 15 min) ──────────────────────────────
setInterval(async () => {
  try {
    const now = new Date();
    const due = await prisma.reservationMeta.findMany({
      where: { reminderAt: { lte: now }, reminderSent: false, active: true },
      take: 50,
      include: {
        item: {
          select: {
            id: true, title: true, priceText: true, currency: true,
            wishlist: {
              select: {
                owner: {
                  select: {
                    firstName: true,
                    profile: { select: { displayName: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (due.length === 0) return;

    let sent = 0;
    for (const meta of due) {
      const reserver = await prisma.user.findUnique({
        where: { id: meta.reserverUserId },
        select: { telegramChatId: true },
      });
      if (reserver?.telegramChatId) {
        const ownerName = meta.item.wishlist.owner.profile?.displayName ?? meta.item.wishlist.owner.firstName ?? '';
        let text = `🔔 <b>Напоминание о бронировании</b>\n\n<b>${meta.item.title}</b>`;
        if (meta.item.priceText) text += ` — ${meta.item.priceText}`;
        text += `\nИз вишлиста <b>${ownerName}</b>`;
        if (meta.note) text += `\n\n📝 ${meta.note}`;
        await sendTgBotMessage(reserver.telegramChatId, text, {
          inline_keyboard: [[
            { text: '📱 Открыть', url: 'https://t.me/WishBoardBot/app' },
            { text: '✓ Куплено', callback_data: `res_purchased:${meta.item.id}` },
          ]],
        });
        sent++;
      }

      // Cycle to the next reminder date if there are more scheduled
      const allDates = (meta.reminderDates as string[] | null) ?? [];
      const firedTs = meta.reminderAt?.getTime() ?? 0;
      const remaining = allDates.filter(d => {
        const ts = new Date(d).getTime();
        return ts !== firedTs && ts > now.getTime();
      });
      remaining.sort();

      if (remaining.length > 0) {
        // Set reminderAt to the next nearest date, keep cycling
        await prisma.reservationMeta.update({
          where: { id: meta.id },
          data: { reminderAt: new Date(remaining[0]!), reminderSent: false, reminderDates: remaining },
        });
      } else {
        // All reminders fired — mark as sent, clear dates
        await prisma.reservationMeta.update({
          where: { id: meta.id },
          data: { reminderSent: true, reminderDates: [] },
        });
      }
    }
    if (sent > 0) logger.info({ count: sent }, 'reservation-reminders: sent reminders');
  } catch (err) {
    logger.error({ err }, 'reservation-reminders job failed');
  }
}, 15 * 60 * 1000); // every 15 minutes

// ─── Events Calendar reminders cron (every 5 min) ───────────────────────────
setInterval(async () => {
  if (!BOT_TOKEN_FOR_DM) return;
  try {
    const now = new Date();
    const due = await prisma.giftOccasionReminder.findMany({
      where: { scheduledFor: { lte: now, not: null }, sentAt: null, enabled: true },
      take: 50,
      include: {
        occasion: {
          select: {
            id: true, title: true, type: true, emoji: true, eventDate: true, recurrence: true,
            personName: true, eventTime: true, location: true, status: true,
            linkedUser: { select: { profile: { select: { displayName: true, username: true } }, firstName: true } },
          },
        },
        owner: { select: { id: true, telegramChatId: true, profile: { select: { languageMode: true, manualLanguage: true } } } },
      },
    });
    if (due.length === 0) return;

    let sent = 0;
    for (const r of due) {
      if (r.occasion.status === 'ARCHIVED') {
        await prisma.giftOccasionReminder.update({ where: { id: r.id }, data: { sentAt: new Date(), delivered: false } });
        continue;
      }
      const chatId = r.owner.telegramChatId;
      const langSettings: LanguageSettings | null = r.owner.profile
        ? { languageMode: (r.owner.profile.languageMode as LanguageMode) ?? 'auto', manualLanguage: (r.owner.profile.manualLanguage as Locale | null) ?? null }
        : null;
      const locale: Locale = resolveEffectiveLocale(langSettings, undefined);
      const emoji = r.occasion.emoji ?? (r.occasion.type === 'BIRTHDAY' ? '🎂' : r.occasion.type === 'ANNIVERSARY' ? '💍' : r.occasion.type === 'HOLIDAY' ? '🎉' : '📅');
      const titleText = r.occasion.title;
      let title: string;
      let body: string;
      if (r.offsetDays === 0) {
        switch (locale) {
          case 'en': title = `${emoji} Today: ${titleText}`; body = 'Don’t forget to celebrate!'; break;
          case 'zh-CN': title = `${emoji} 今天：${titleText}`; body = '别忘了庆祝！'; break;
          case 'hi': title = `${emoji} आज: ${titleText}`; body = 'मनाना न भूलें!'; break;
          case 'es': title = `${emoji} Hoy: ${titleText}`; body = '¡No olvides celebrar!'; break;
          case 'ar': title = `${emoji} اليوم: ${titleText}`; body = 'لا تنسَ الاحتفال!'; break;
          default: title = `${emoji} Сегодня: ${titleText}`; body = 'Не забудьте поздравить!';
        }
      } else if (r.offsetDays > 0) {
        switch (locale) {
          case 'en': title = `${emoji} ${titleText} — ${r.offsetDays} day(s) ago`; body = 'Was the gift well-received?'; break;
          case 'zh-CN': title = `${emoji} ${titleText} —— ${r.offsetDays} 天前`; body = '礼物喜欢吗？'; break;
          case 'hi': title = `${emoji} ${titleText} — ${r.offsetDays} दिन पहले`; body = 'क्या उपहार पसंद आया?'; break;
          case 'es': title = `${emoji} ${titleText} — hace ${r.offsetDays} día(s)`; body = '¿Le gustó el regalo?'; break;
          case 'ar': title = `${emoji} ${titleText} — قبل ${r.offsetDays} يوم(أيام)`; body = 'هل أعجب الهدية؟'; break;
          default: title = `${emoji} ${titleText} — ${r.offsetDays} дн назад`; body = 'Подарок понравился?';
        }
      } else {
        const days = Math.abs(r.offsetDays);
        switch (locale) {
          case 'en': title = `${emoji} ${titleText} in ${days} day(s)`; body = days <= 1 ? 'Tomorrow!' : 'Time to pick a gift.'; break;
          case 'zh-CN': title = `${emoji} ${titleText} 还有 ${days} 天`; body = days <= 1 ? '明天！' : '该挑选礼物了。'; break;
          case 'hi': title = `${emoji} ${titleText} ${days} दिन में`; body = days <= 1 ? 'कल!' : 'उपहार चुनने का समय।'; break;
          case 'es': title = `${emoji} ${titleText} en ${days} día(s)`; body = days <= 1 ? '¡Mañana!' : 'Es hora de elegir un regalo.'; break;
          case 'ar': title = `${emoji} ${titleText} بعد ${days} يوم(أيام)`; body = days <= 1 ? 'غداً!' : 'حان وقت اختيار هدية.'; break;
          default: title = `${emoji} ${titleText} через ${days} дн.`; body = days <= 1 ? 'Уже завтра!' : 'Время подобрать подарок.';
        }
      }

      let delivered = false;
      if (chatId) {
        const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const text = `<b>${esc(title)}</b>\n\n${esc(body)}`;
        delivered = await sendTgBotMessage(chatId, text, {
          inline_keyboard: [[
            { text: locale === 'ru' ? '📱 Открыть' : 'Open', url: 'https://t.me/WishBoardBot/app' },
          ]],
        });
        if (delivered) sent++;
      }

      await prisma.calendarInboxEntry.create({
        data: {
          ownerUserId: r.ownerUserId,
          occasionId: r.occasionId,
          type: r.offsetDays === 0 ? 'EVENT_TODAY' : 'REMINDER',
          emoji,
          title,
          body,
        },
      });

      await prisma.giftOccasionReminder.update({
        where: { id: r.id },
        data: { sentAt: now, delivered },
      });

      if (r.occasion.recurrence !== 'NONE' && r.occasion.eventDate) {
        const nextOcc = getNextOccurrenceDate(r.occasion.eventDate, r.occasion.recurrence);
        if (nextOcc && nextOcc.getTime() > now.getTime()) {
          const nextSched = computeReminderSchedule(nextOcc, 'NONE', r.offsetDays, r.timeOfDay);
          if (nextSched.getTime() > now.getTime()) {
            const nextEpisodeKey = buildReminderEpisodeKey(r.occasionId, r.offsetDays, nextSched);
            try {
              await prisma.giftOccasionReminder.create({
                data: {
                  occasionId: r.occasionId,
                  ownerUserId: r.ownerUserId,
                  offsetDays: r.offsetDays,
                  timeOfDay: r.timeOfDay,
                  enabled: r.enabled,
                  scheduledFor: nextSched,
                  episodeKey: nextEpisodeKey,
                },
              });
            } catch (err: unknown) {
              const e = err as { code?: string };
              if (e.code !== 'P2002') throw err;
            }
          }
        }
      }
    }
    if (sent > 0) logger.info({ count: sent }, 'gift-occasion-reminders: sent reminders');
  } catch (err) {
    logger.error({ err }, 'gift-occasion-reminders job failed');
  }
}, 5 * 60 * 1000);

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

// Santa seasonal events: check every hour for calendar milestones (Nov 1, Feb 1).
// Idempotent — safe to run hourly; each broadcast fires at most once per year via DB dedup.
setInterval(() => { void maybeRunSeasonalEvents(); }, 60 * 60 * 1000);

// ─── Smart Reservations: auto-release cron (every 5 min) ─────────────────────
setInterval(async () => {
  try {
    const now = new Date();
    const expiredMetas = await prisma.reservationMeta.findMany({
      where: { isSmartRes: true, active: true, expiresAt: { lte: now } },
      take: 50,
      include: {
        item: {
          select: {
            id: true, title: true, status: true, reserverUserId: true, reservationEpoch: true,
            wishlist: { select: { ownerId: true, owner: { select: { telegramChatId: true } } } },
          },
        },
      },
    });
    for (const meta of expiredMetas) {
      try {
        if (!meta.active) continue;
        // Repair: inconsistent state — item not RESERVED but meta still active
        if (meta.item.status !== 'RESERVED') {
          console.warn('Smart res auto-release: inconsistent state', { metaId: meta.id, itemId: meta.item.id, itemStatus: meta.item.status });
          await prisma.reservationMeta.update({
            where: { id: meta.id },
            data: { active: false, endedAt: now, endReason: 'inconsistent_state' },
          });
          continue;
        }
        // Guard: reservation belongs to someone else now
        if (meta.item.reserverUserId !== meta.reserverUserId) continue;

        await prisma.$transaction(async (tx) => {
          await tx.item.update({ where: { id: meta.item.id }, data: { status: 'AVAILABLE', reserverUserId: null } });
          await tx.reservationEvent.create({
            data: { itemId: meta.item.id, type: 'UNRESERVED', actorHash: SYSTEM_ACTOR_HASH, comment: 'auto_released' },
          });
          await tx.comment.create({
            data: { itemId: meta.item.id, type: 'SYSTEM', text: t('api_system_auto_released', 'ru'), reservationEpoch: meta.item.reservationEpoch },
          });
          const ttl = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
          await tx.comment.updateMany({
            where: { itemId: meta.item.id, scheduledDeleteAt: null },
            data: { scheduledDeleteAt: ttl },
          });
          await tx.reservationMeta.update({
            where: { id: meta.id },
            data: { active: false, endedAt: now, endReason: 'auto_released' },
          });
        });

        // Notify gifter
        const reserver = await prisma.user.findUnique({ where: { id: meta.reserverUserId }, select: { telegramChatId: true } });
        if (reserver?.telegramChatId) {
          void sendTgNotification(reserver.telegramChatId, t('notif_smart_res_auto_released_gifter', 'ru', { title: meta.item.title }));
        }
        // Notify owner
        const ownerChatId = meta.item.wishlist.owner.telegramChatId;
        if (ownerChatId) {
          void sendTgNotification(ownerChatId, t('notif_smart_res_auto_released_owner', 'ru', { title: meta.item.title }));
        }
        logger.info({ metaId: meta.id, itemId: meta.item.id }, 'smart-res: auto-released');
      } catch (err) {
        logger.error({ err, metaId: meta.id }, 'smart-res: auto-release item failed');
      }
    }
  } catch (err) {
    logger.error({ err }, 'smart-res: auto-release cron failed');
  }
}, 5 * 60 * 1000);

// ─── Smart Reservations: reminder cron (every 15 min) ────────────────────────
setInterval(async () => {
  try {
    const now = new Date();
    const candidates = await prisma.reservationMeta.findMany({
      where: { isSmartRes: true, active: true, reminderSent: false, expiresAt: { not: null, gt: now } },
      take: 50,
      include: {
        item: { select: { id: true, title: true } },
      },
    });
    for (const meta of candidates) {
      try {
        if (!meta.expiresAt) continue;
        const leadH = getSmartResLeadHours(meta.smartResTtlHours ?? 72);
        const windowStart = meta.expiresAt.getTime() - leadH * 3600000;
        if (now.getTime() < windowStart) continue; // not in reminder window yet

        const reserver = await prisma.user.findUnique({ where: { id: meta.reserverUserId }, select: { telegramChatId: true } });
        if (!reserver?.telegramChatId) {
          // No chat ID — mark as sent to avoid retrying
          await prisma.reservationMeta.update({ where: { id: meta.id }, data: { reminderSent: true } });
          continue;
        }
        const hoursLeft = Math.max(1, Math.round((meta.expiresAt.getTime() - now.getTime()) / 3600000));
        const delivered = await sendTgNotification(reserver.telegramChatId, t('notif_smart_res_expiring', 'ru', { title: meta.item.title, hours: String(hoursLeft) }))
          .then(() => true).catch(() => false);
        if (delivered) {
          await prisma.reservationMeta.update({ where: { id: meta.id }, data: { reminderSent: true } });
          logger.info({ metaId: meta.id, itemId: meta.item.id }, 'smart-res: reminder sent');
        }
        // On failure: leave reminderSent=false, cron retries next tick
      } catch (err) {
        logger.error({ err, metaId: meta.id }, 'smart-res: reminder item failed');
      }
    }
  } catch (err) {
    logger.error({ err }, 'smart-res: reminder cron failed');
  }
}, 15 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════════════
// BIRTHDAY REMINDERS — social notifications for own birthday
//
// Two delivery flows, both fed by the same hourly scheduler:
//
//   1. FRIEND  — followers/connected users get a DM 14d/7d/1d/today before the
//                birthday user's birthday, with a CTA opening the Mini App on
//                the birthday user's primary public wishlist (or profile if
//                no public wishlist).
//
//   2. OWNER   — the birthday user themself gets nudged 30d before to update
//                their wishlist, plus 14d/7d if there's a "problem" (no public
//                wishlist OR public wishlist has no active items), plus a soft
//                congratulations on the day-of with no urgency CTA.
//
// Pro vs Free split:
//   - 14d + today friend windows + 30d + today owner windows: FREE
//   - 7d + 1d friend windows + 14d + 7d owner windows: PRO (gated via
//     birthdayAdvancedWindowsEnabled)
//   - audience EXTENDED, primary wishlist, custom message: PRO (settings API
//     rejects with 402 PRO_REQUIRED — never silent-saved as inactive)
//
// Eligibility (friend reminders):
//   ONLY explicit relationships count as recipients:
//     - ProfileSubscription.subscriberId
//     - WishlistSubscription.subscriberId on a non-NOBODY wishlist
//     - reservers of the birthday user's public-facing wishlist items
//     - commenters on the birthday user's public-facing wishlist items
//   NEVER: passive views, share-link opens, etc.
//
// Daily cap (per recipient): MAX_FRIEND_REMINDERS_PER_DAY. Excess goes to
// `deferred` status with `deferredUntil = next MSK 10:00`.
//
// Scheduler runs hourly. The unique index
// (birthdayUserId, recipientUserId, occurrenceKey, reminderKind) prevents
// double-sends across runs and makes restart-safe recovery trivial.
// ═══════════════════════════════════════════════════════════════════════════

const BIRTHDAY_TZ_OFFSET_HOURS = 3; // MSK; matches GiftOccasionReminder cron
const BIRTHDAY_SEND_HOUR_MSK_MIN = 9;  // earliest delivery hour in MSK
const BIRTHDAY_SEND_HOUR_MSK_MAX = 22; // latest delivery hour in MSK
const BIRTHDAY_RECIPIENT_DAILY_CAP = 3;     // max friend reminders received per recipient per MSK day
// (weekly cap intentionally dropped — at current scale daily cap + dedup is
// sufficient. Re-add a 7-day rolling cap here if recipients legitimately have
// 10+ birthdays a week from their explicit-relationship audience.)
const BIRTHDAY_BATCH_BIRTHDAY_USERS = 30;   // max birthday users processed per scheduler tick
const BIRTHDAY_BATCH_RECIPIENTS = 100;      // max recipients per birthday user per tick
const BIRTHDAY_RETRY_LOOKBACK_HOURS = 24;   // retry pending/deferred records up to this old
const BIRTHDAY_GRACE_DAYS_AFTER = 3;        // banner stops showing N days after birthday

const BIRTHDAY_REMINDERS_ENABLED = process.env.BIRTHDAY_REMINDERS_ENABLED !== 'false'; // kill-switch

type BirthdayReminderKind =
  | 'friend_14d' | 'friend_7d' | 'friend_1d' | 'friend_today'
  | 'owner_30d' | 'owner_14d' | 'owner_7d' | 'owner_today';

const BIRTHDAY_FRIEND_KINDS_BY_OFFSET: Record<number, BirthdayReminderKind> = {
  14: 'friend_14d',
  7:  'friend_7d',
  1:  'friend_1d',
  0:  'friend_today',
};
const BIRTHDAY_OWNER_KINDS_BY_OFFSET: Record<number, BirthdayReminderKind> = {
  30: 'owner_30d',
  14: 'owner_14d',
  7:  'owner_7d',
  0:  'owner_today',
};
const BIRTHDAY_FRIEND_FREE_OFFSETS = [14, 0] as const;
const BIRTHDAY_FRIEND_PRO_OFFSETS  = [14, 7, 1, 0] as const;
const BIRTHDAY_OWNER_FREE_OFFSETS  = [30, 0] as const;
const BIRTHDAY_OWNER_PRO_OFFSETS   = [30, 14, 7, 0] as const;

/**
 * Skip-reason enum for BirthdayReminderDelivery.skipReason.
 * Mirrored in Mini App / God Mode for analytics.
 *
 *   no_public_wishlist           — birthday user has no PUBLIC_PROFILE/LINK_ONLY wishlist
 *   no_active_public_items       — public wishlist exists but has 0 AVAILABLE items
 *   primary_wishlist_unavailable — birthdayPrimaryWishlistId pointing to deleted/private wishlist
 *   profile_private              — birthday user's profile visibility is NOBODY
 *   birthday_hidden              — UserProfile.birthday is null at send-time (race)
 *   friend_reminders_disabled    — owner toggled off after delivery created
 *   recipient_opted_out          — recipient toggled notifyBirthdays=false
 *   muted                        — recipient muted this birthday user
 *   no_chat_id                   — recipient has no telegramChatId
 *   bot_blocked                  — Telegram returned 403
 *   daily_cap                    — recipient already at 3 friend reminders today (also see deferred)
 *   pro_required                 — owner downgraded; advanced window inactive
 *   self_excluded                — recipient = birthdayUser (defensive)
 *   no_problem_to_solve          — owner_14d/7d but wishlist already public + has items
 */
type BirthdaySkipReason =
  | 'no_public_wishlist' | 'no_active_public_items' | 'primary_wishlist_unavailable'
  | 'profile_private' | 'birthday_hidden' | 'friend_reminders_disabled'
  | 'recipient_opted_out' | 'muted' | 'no_chat_id' | 'bot_blocked'
  | 'daily_cap' | 'pro_required' | 'self_excluded' | 'no_problem_to_solve';

/** Day of month (1..31) of birthday in MSK, or null if no birthday set. */
function getMskBirthdayDay(birthday: Date | null): { month: number; day: number } | null {
  if (!birthday) return null;
  // Birthday is stored as DateTime; only month+day matter (year may be 2000 carrier or real).
  // Read in UTC then shift by MSK offset for the day boundary.
  const mskMs = birthday.getTime() + BIRTHDAY_TZ_OFFSET_HOURS * 3600_000;
  const d = new Date(mskMs);
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Today's date in MSK as { y, m, d }. */
function getMskToday(now: Date): { year: number; month: number; day: number; hour: number } {
  const mskMs = now.getTime() + BIRTHDAY_TZ_OFFSET_HOURS * 3600_000;
  const d = new Date(mskMs);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
  };
}

/**
 * Compute the date of birthdayUser's birthday "this year" as it falls in MSK,
 * with leap-year handling: Feb 29 birthdays in non-leap years map to Feb 28.
 *
 * Returns null if `birthday` is null. Returns the date AS A LOCAL-MSK DAY.
 */
function getThisYearBirthdayMskDate(birthday: Date | null, todayMsk: { year: number }): Date | null {
  const md = getMskBirthdayDay(birthday);
  if (!md) return null;
  let { month, day } = md;
  // Feb-29 → Feb-28 in non-leap years
  if (month === 2 && day === 29) {
    const isLeap = (todayMsk.year % 4 === 0 && todayMsk.year % 100 !== 0) || (todayMsk.year % 400 === 0);
    if (!isLeap) day = 28;
  }
  // Build MSK midnight as UTC date by subtracting offset
  const utcHourForMskMidnight = -BIRTHDAY_TZ_OFFSET_HOURS; // i.e. UTC 21:00 of prev day
  return new Date(Date.UTC(todayMsk.year, month - 1, day, utcHourForMskMidnight, 0, 0));
}

/** Days from MSK today to the next occurrence of this birthday (0..365). */
function daysUntilNextBirthday(birthday: Date | null, now: Date): number | null {
  const todayMsk = getMskToday(now);
  const md = getMskBirthdayDay(birthday);
  if (!md) return null;
  const todayMs = Date.UTC(todayMsk.year, todayMsk.month - 1, todayMsk.day) / 86400_000;
  let candidateY = todayMsk.year;
  let day = md.day;
  if (md.month === 2 && md.day === 29) {
    const isLeap = (candidateY % 4 === 0 && candidateY % 100 !== 0) || (candidateY % 400 === 0);
    if (!isLeap) day = 28;
  }
  let bdayMs = Date.UTC(candidateY, md.month - 1, day) / 86400_000;
  if (bdayMs < todayMs) {
    candidateY += 1;
    let day2 = md.day;
    if (md.month === 2 && md.day === 29) {
      const isLeap = (candidateY % 4 === 0 && candidateY % 100 !== 0) || (candidateY % 400 === 0);
      if (!isLeap) day2 = 28;
    }
    bdayMs = Date.UTC(candidateY, md.month - 1, day2) / 86400_000;
  }
  return Math.round(bdayMs - todayMs);
}

/**
 * Format the occurrenceKey ("YYYY-MM-DD") for a birthday user's upcoming
 * birthday at the given offset from MSK today. Used for the unique constraint
 * on BirthdayReminderDelivery so reruns are idempotent.
 */
function buildOccurrenceKey(birthday: Date, todayMsk: { year: number; month: number; day: number }, offsetDays: number): string | null {
  const md = getMskBirthdayDay(birthday);
  if (!md) return null;
  // Target date = today + offsetDays. Birthday must fall on that day.
  const todayMs = Date.UTC(todayMsk.year, todayMsk.month - 1, todayMsk.day);
  const targetMs = todayMs + offsetDays * 86400_000;
  const target = new Date(targetMs);
  const y = target.getUTCFullYear();
  // Birthday occurrence date in target's calendar year. Feb 29 collapse handled separately —
  // for occurrenceKey we use the year that the birthday falls in (i.e. target year).
  let day = md.day;
  if (md.month === 2 && md.day === 29) {
    const isLeap = (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
    if (!isLeap) day = 28;
  }
  return `${y}-${String(md.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Return the next MSK 10:00 as a Date for `deferredUntil` use. */
function nextMskMorning(now: Date): Date {
  const today = getMskToday(now);
  // Next-day 10:00 MSK = next-day UTC 07:00.
  const nextDayUtcStartMs = Date.UTC(today.year, today.month - 1, today.day) + 86400_000;
  return new Date(nextDayUtcStartMs + (10 - BIRTHDAY_TZ_OFFSET_HOURS) * 3600_000);
}

/** Locale for a user (effective resolution, not the legacy `language` field). */
async function resolveBirthdayLocale(userId: string): Promise<Locale> {
  const profile = await prisma.userProfile.findUnique({
    where: { userId },
    select: { languageMode: true, manualLanguage: true, normalizedLocale: true, language: true },
  });
  if (!profile) return 'ru';
  return resolveEffectiveLocale({
    languageMode: profile.languageMode as LanguageMode,
    manualLanguage: profile.manualLanguage,
    normalizedLocale: profile.normalizedLocale,
    legacyLanguage: profile.language,
  } as LanguageSettings);
}

/** Pick the displayable name for a birthday user. */
function pickBirthdayDisplayName(p: { displayName: string | null; username: string | null; firstName?: string | null }): string {
  return (p.displayName?.trim() || p.username?.trim() || p.firstName?.trim() || 'WishBoard') as string;
}

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

/** Russian/Hindi etc plural for "day". */
function birthdayDayWord(days: number, locale: Locale): string {
  return pluralize(
    days,
    t('br_days_word_one', locale),
    t('br_days_word_few', locale),
    t('br_days_word_many', locale),
    locale,
  );
}

/**
 * Find the primary public wishlist for a birthday user.
 *
 *   1. If birthdayPrimaryWishlistId is set + still PUBLIC_PROFILE/LINK_ONLY +
 *      not archived + has at least one AVAILABLE item → use it.
 *   2. Else fallback: first PUBLIC_PROFILE wishlist with most AVAILABLE items.
 *   3. Else fallback: first LINK_ONLY (non-archived) wishlist with AVAILABLE items.
 *   4. Else: null (caller should send the no_public_wishlist variant).
 *
 * Returns { wishlist, slug, activeItemCount, fromPrimary } or null.
 */
async function pickBirthdayPrimaryWishlist(birthdayUserId: string, primaryId: string | null): Promise<{
  id: string; slug: string; activeItems: number; fromPrimary: boolean;
} | null> {
  if (primaryId) {
    const w = await prisma.wishlist.findUnique({
      where: { id: primaryId },
      select: {
        id: true, slug: true, ownerId: true, archivedAt: true, visibility: true,
        items: { where: { status: 'AVAILABLE' }, select: { id: true } },
      },
    });
    if (w && w.ownerId === birthdayUserId && w.archivedAt === null
        && (w.visibility === 'PUBLIC_PROFILE' || w.visibility === 'LINK_ONLY')
        && w.items.length > 0) {
      return { id: w.id, slug: w.slug, activeItems: w.items.length, fromPrimary: true };
    }
  }
  const candidates = await prisma.wishlist.findMany({
    where: {
      ownerId: birthdayUserId,
      archivedAt: null,
      visibility: { in: ['PUBLIC_PROFILE', 'LINK_ONLY'] },
    },
    select: {
      id: true, slug: true, visibility: true,
      items: { where: { status: 'AVAILABLE' }, select: { id: true } },
    },
  });
  if (candidates.length === 0) return null;
  const ranked = candidates
    .map(w => ({ id: w.id, slug: w.slug, activeItems: w.items.length, isPublicProfile: w.visibility === 'PUBLIC_PROFILE' }))
    .filter(w => w.activeItems > 0)
    .sort((a, b) => {
      if (a.isPublicProfile !== b.isPublicProfile) return a.isPublicProfile ? -1 : 1;
      return b.activeItems - a.activeItems;
    });
  if (ranked.length === 0) return null;
  return { id: ranked[0]!.id, slug: ranked[0]!.slug, activeItems: ranked[0]!.activeItems, fromPrimary: false };
}

/**
 * Compute eligible recipient userIds for a friend birthday reminder.
 *
 * Audience tiers:
 *   - SUBSCRIBERS (free): ProfileSubscription + WishlistSubscription
 *   - EXTENDED  (Pro): + reservers + commenters (only for items in non-private wishlists)
 *
 * Excludes the birthday user themselves and any account with no telegramChatId
 * (those are filtered later when fetching the User row, but pre-filter saves work).
 */
/**
 * Resolve commenter userIds for the EXTENDED audience.
 *
 * Comments persist only `authorActorHash` (one-way SHA-256 of `tg_actor:${telegramId}`
 * via `tgActorHash`), not a direct userId. To map back we enumerate Users with a
 * `telegramId` and a `telegramChatId` (must be DM-able), compute their hash, and
 * intersect with distinct hashes seen on comments for the owner's public wishlists.
 *
 * Bounded by O(activeUsers) hash computes per scheduler tick. Acceptable up to
 * ~50k active users; cache or denormalize `Comment.authorUserId` past that.
 *
 * NEVER includes:
 * - SYSTEM comments (status changes, etc.)
 * - Comments on private wishlists
 * - Users without `telegramChatId` (cannot receive a DM anyway)
 */
async function findCommenterRecipients(wishlistIds: string[]): Promise<string[]> {
  if (wishlistIds.length === 0) return [];
  const comments = await prisma.comment.findMany({
    where: {
      item: { wishlistId: { in: wishlistIds } },
      type: 'USER',
      authorActorHash: { not: null },
    },
    select: { authorActorHash: true },
    distinct: ['authorActorHash'],
    take: 5000,
  });
  const actorSet = new Set<string>();
  for (const c of comments) {
    if (c.authorActorHash) actorSet.add(c.authorActorHash);
  }
  if (actorSet.size === 0) return [];

  // Scope user scan to DM-able users — no point computing hashes for unreachable accounts.
  const users = await prisma.user.findMany({
    where: { telegramId: { not: null }, telegramChatId: { not: null } },
    select: { id: true, telegramId: true },
    take: 50000,
  });
  const matched: string[] = [];
  for (const u of users) {
    if (!u.telegramId) continue;
    const tid = Number(u.telegramId);
    if (!Number.isFinite(tid)) continue;
    const hash = tgActorHash(tid);
    if (actorSet.has(hash)) matched.push(u.id);
  }
  return matched;
}

async function findBirthdayFriendRecipients(birthdayUserId: string, audience: 'SUBSCRIBERS' | 'EXTENDED'): Promise<{ userId: string; relationType: string }[]> {
  const relationByUserId = new Map<string, Set<string>>();
  const add = (userId: string, rel: string): void => {
    if (userId === birthdayUserId) return;
    const set = relationByUserId.get(userId) ?? new Set<string>();
    set.add(rel);
    relationByUserId.set(userId, set);
  };

  // 1. Profile subscribers (always)
  const profileSubs = await prisma.profileSubscription.findMany({
    where: { targetUserId: birthdayUserId },
    select: { subscriberId: true },
    take: 1000,
  });
  for (const s of profileSubs) add(s.subscriberId, 'subscription');

  // 2. Wishlist subscribers on non-NOBODY wishlists
  const wishlists = await prisma.wishlist.findMany({
    where: {
      ownerId: birthdayUserId,
      archivedAt: null,
      visibility: { in: ['PUBLIC_PROFILE', 'LINK_ONLY'] },
    },
    select: { id: true },
  });
  const wishlistIds = wishlists.map(w => w.id);
  if (wishlistIds.length > 0) {
    const wlSubs = await prisma.wishlistSubscription.findMany({
      where: { wishlistId: { in: wishlistIds } },
      select: { subscriberId: true },
      take: 1000,
    });
    for (const s of wlSubs) add(s.subscriberId, 'wishlist_subscription');

    if (audience === 'EXTENDED') {
      // 3. Reservers — distinct userIds from active ReservationMeta on items in public wishlists.
      //    These are explicit, owner-visible relationships.
      const reservations = await prisma.reservationMeta.findMany({
        where: {
          active: true,
          item: { wishlistId: { in: wishlistIds } },
        },
        select: { reserverUserId: true },
        take: 1000,
      });
      for (const r of reservations) add(r.reserverUserId, 'reservation');

      // 4. Secret reservers — same explicit-relationship semantics as public reservers,
      //    but kept under wraps from the wishlist owner. Birthday reminder still goes
      //    to the user who reserved (they're the gifter).
      const secretRes = await prisma.secretReservation.findMany({
        where: {
          status: 'ACTIVE',
          item: { wishlistId: { in: wishlistIds } },
        },
        select: { reserverUserId: true },
        take: 1000,
      });
      for (const r of secretRes) add(r.reserverUserId, 'reservation');

      // 5. Commenters — users who left a non-system comment on items in birthday user's
      //    public-facing wishlists. Comments store `authorActorHash` (one-way SHA-256
      //    of `tg_actor:${telegramId}` from `tgActorHash()`), no direct userId column.
      //    To map back: collect distinct comment actor hashes, then enumerate Users with
      //    telegramId set and check whose computed `tgActorHash` matches the set.
      //    Acceptable for current user-base size (one-time hash compute per User per
      //    scheduler tick, scoped to users who can actually receive a DM). Re-evaluate
      //    if the User table grows past ~50k active rows — switch to a precomputed
      //    cache or denormalize `authorUserId` on Comment.
      const commenterIds = await findCommenterRecipients(wishlistIds);
      for (const userId of commenterIds) add(userId, 'comment');
    }
  }

  return [...relationByUserId.entries()].map(([userId, rels]) => {
    const rel = rels.size > 1 ? 'mixed' : [...rels][0]!;
    return { userId, relationType: rel };
  });
}

/** Has the recipient hit the daily cap (in MSK day)? */
async function recipientHitDailyCap(recipientUserId: string, todayMsk: { year: number; month: number; day: number }): Promise<boolean> {
  const startUtc = new Date(Date.UTC(todayMsk.year, todayMsk.month - 1, todayMsk.day) - BIRTHDAY_TZ_OFFSET_HOURS * 3600_000);
  const endUtc = new Date(startUtc.getTime() + 86400_000);
  const count = await prisma.birthdayReminderDelivery.count({
    where: {
      recipientUserId,
      reminderKind: { startsWith: 'friend_' },
      sentAt: { gte: startUtc, lt: endUtc },
      status: 'sent',
    },
  });
  return count >= BIRTHDAY_RECIPIENT_DAILY_CAP;
}

/** Compose the bot message text + inline keyboard for a delivery. */
function buildBirthdayBotMessage(args: {
  delivery: { reminderKind: string; targetType: string | null; targetId: string | null; deepLinkPayload: string | null; id: string };
  birthdayDisplayName: string;
  daysUntil: number;
  customMessage: string | null;
  ownerWishlistEmpty?: boolean;
  ownerHasNoPublic?: boolean;
  locale: Locale;
  miniAppUrl: string;
}): { text: string; replyMarkup: Record<string, unknown> } {
  const { delivery, birthdayDisplayName, daysUntil, customMessage, ownerWishlistEmpty, ownerHasNoPublic, locale, miniAppUrl } = args;
  const dayWord = birthdayDayWord(daysUntil, locale);
  const isToday = delivery.reminderKind === 'friend_today' || delivery.reminderKind === 'owner_today';
  const isOwner = delivery.reminderKind.startsWith('owner_');
  const webAppUrl = `${miniAppUrl}?startapp=br_${delivery.id}`;

  let intro: string;
  let body: string;
  const lines: string[] = [];

  if (!isOwner) {
    intro = isToday
      ? t('bot_br_friend_intro_today', locale, { name: birthdayDisplayName })
      : t('bot_br_friend_intro_days', locale, { days: daysUntil, dayWord, name: birthdayDisplayName });
    if (delivery.targetType === 'wishlist') {
      body = isToday ? t('bot_br_friend_body_today', locale) : t('bot_br_friend_body_wishlist', locale);
    } else {
      body = t('bot_br_friend_body_no_wishlist', locale);
    }
    lines.push(intro);
    if (customMessage && customMessage.trim().length > 0) {
      lines.push(t('bot_br_friend_custom_message_wrap', locale, { message: customMessage.trim() }));
    }
    lines.push(body);
  } else {
    intro = isToday
      ? t('bot_br_owner_intro_today', locale)
      : t('bot_br_owner_intro_days', locale, { days: daysUntil, dayWord });
    if (isToday) {
      body = t('bot_br_owner_body_today', locale);
    } else if (ownerHasNoPublic) {
      body = t('bot_br_owner_body_no_public', locale);
    } else if (ownerWishlistEmpty) {
      body = t('bot_br_owner_body_empty', locale);
    } else {
      body = t('bot_br_owner_body_30d', locale);
    }
    lines.push(intro, body);
  }

  const text = lines.join('\n\n');

  // Inline keyboard
  const buttons: Array<Array<Record<string, unknown>>> = [];
  if (!isOwner) {
    if (delivery.targetType === 'wishlist') {
      buttons.push([{
        text: isToday ? t('bot_br_friend_btn_today', locale) : t('bot_br_friend_btn_wishlist', locale),
        web_app: { url: webAppUrl },
      }]);
    } else {
      buttons.push([{
        text: t('bot_br_friend_btn_profile', locale),
        web_app: { url: webAppUrl },
      }]);
    }
    if (!isToday) {
      buttons.push([{
        text: t('bot_br_friend_btn_mute', locale),
        callback_data: `bdm:${delivery.id}`,
      }]);
    }
  } else {
    if (isToday) {
      buttons.push([{ text: t('bot_br_owner_btn_today', locale), web_app: { url: webAppUrl } }]);
    } else if (ownerHasNoPublic) {
      buttons.push([{ text: t('bot_br_owner_btn_public', locale), web_app: { url: webAppUrl } }]);
    } else if (ownerWishlistEmpty) {
      buttons.push([{ text: t('bot_br_owner_btn_add', locale), web_app: { url: webAppUrl } }]);
    } else {
      buttons.push([{ text: t('bot_br_owner_btn_update', locale), web_app: { url: webAppUrl } }]);
    }
  }
  return { text, replyMarkup: { inline_keyboard: buttons } };
}

/** Main scheduler — runs hourly. */
async function processBirthdayReminders(): Promise<void> {
  if (!BIRTHDAY_REMINDERS_ENABLED) return;
  const startedAt = Date.now();
  const now = new Date();
  const todayMsk = getMskToday(now);

  // Only send during the daytime window in MSK to avoid surprising users.
  if (todayMsk.hour < BIRTHDAY_SEND_HOUR_MSK_MIN || todayMsk.hour > BIRTHDAY_SEND_HOUR_MSK_MAX) {
    return;
  }

  trackEvent('birthday.scheduler_run_started', undefined, { mskHour: todayMsk.hour });

  const stats = {
    candidatesFound: 0,
    deliveriesCreated: 0,
    sent: 0,
    skipped: 0,
    deferred: 0,
    failed: 0,
    retried: 0,
    bySkipReason: {} as Record<string, number>,
    byKind: {} as Record<string, number>,
  };

  const miniAppUrl = process.env.MINI_APP_URL ?? (process.env.WEB_ORIGIN ? `${process.env.WEB_ORIGIN}/miniapp` : 'https://wishlistik.ru/miniapp');

  try {
    // ─── Phase 1: retry stuck pending + ready-deferred deliveries ──────────
    const retryable = await prisma.birthdayReminderDelivery.findMany({
      where: {
        OR: [
          { status: 'pending', createdAt: { lt: new Date(now.getTime() - 30 * 60_000) } },
          { status: 'deferred', deferredUntil: { lte: now } },
        ],
        createdAt: { gte: new Date(now.getTime() - BIRTHDAY_RETRY_LOOKBACK_HOURS * 3600_000) },
      },
      take: 50,
      orderBy: { createdAt: 'asc' },
    });
    for (const d of retryable) {
      try {
        const sentOk = await sendBirthdayDelivery(d.id, miniAppUrl);
        if (sentOk === 'sent') stats.sent++;
        else if (sentOk === 'deferred') stats.deferred++;
        else if (sentOk === 'skipped') stats.skipped++;
        else stats.failed++;
        stats.retried++;
      } catch (err) {
        logger.error({ err, deliveryId: d.id }, 'birthday: retry failed');
      }
    }

    // ─── Phase 2: scan birthday matches per window ─────────────────────────
    const allOffsets = [...new Set([
      ...BIRTHDAY_FRIEND_PRO_OFFSETS,
      ...BIRTHDAY_OWNER_PRO_OFFSETS,
    ])].sort((a, b) => b - a);

    for (const offset of allOffsets) {
      const targetMs = Date.UTC(todayMsk.year, todayMsk.month - 1, todayMsk.day) + offset * 86400_000;
      const target = new Date(targetMs);
      const targetMonth = target.getUTCMonth() + 1;
      const targetDay = target.getUTCDate();

      // Find UserProfile rows matching month+day. Feb-29 birthdays handled twice:
      // - leap year: query Feb-29 directly
      // - non-leap year + targetDay==Feb-28: also include Feb-29 birthdays
      const isFeb28InNonLeap = targetMonth === 2 && targetDay === 28
        && !(target.getUTCFullYear() % 4 === 0 && target.getUTCFullYear() % 100 !== 0)
        && !(target.getUTCFullYear() % 400 === 0);
      const monthDayOR: Array<{ AND: [{ birthday: { gte: Date } }, { birthday: { lt: Date } }] }> = [];
      // Use a coarse range query: Postgres can't index on (month, day) directly, so we
      // rely on a fan-out: load all profiles with birthday set and filter in app.
      // For a 30-offset year-wide candidate scan this may be wasteful; in practice
      // we only call this for users with birthdays (small fraction of total). Acceptable.
      void monthDayOR; // silence unused-var

      const candidates = await prisma.userProfile.findMany({
        where: { birthday: { not: null } },
        select: {
          userId: true,
          birthday: true,
          hideYear: true,
          displayName: true,
          username: true,
          birthdayFriendReminders: true,
          birthdayOwnerReminders: true,
          birthdayAdvancedWindowsEnabled: true,
          birthdayAudience: true,
          birthdayPrimaryWishlistId: true,
          birthdayCustomMessage: true,
          profileVisibility: true,
          languageMode: true,
          manualLanguage: true,
          normalizedLocale: true,
          language: true,
          user: { select: { id: true, telegramChatId: true, firstName: true, godMode: true } },
        },
        take: 5000,
      });

      const matched = candidates.filter(c => {
        const md = getMskBirthdayDay(c.birthday);
        if (!md) return false;
        if (md.month === targetMonth && md.day === targetDay) return true;
        if (isFeb28InNonLeap && md.month === 2 && md.day === 29) return true;
        return false;
      });
      stats.candidatesFound += matched.length;

      // Process up to N birthday users per offset to keep tick bounded
      for (const cand of matched.slice(0, BIRTHDAY_BATCH_BIRTHDAY_USERS)) {
        try {
          const isOwnerWindow = (BIRTHDAY_OWNER_KINDS_BY_OFFSET as Record<number, string>)[offset] !== undefined;
          const isFriendWindow = (BIRTHDAY_FRIEND_KINDS_BY_OFFSET as Record<number, string>)[offset] !== undefined;

          // Owner reminders
          if (isOwnerWindow) {
            await maybeCreateOwnerDelivery(cand, offset, todayMsk, miniAppUrl, stats);
          }
          // Friend reminders
          if (isFriendWindow) {
            await maybeCreateFriendDeliveries(cand, offset, todayMsk, miniAppUrl, stats);
          }
        } catch (err) {
          logger.error({ err, userId: cand.userId }, 'birthday: candidate processing failed');
        }
      }
    }

    await prisma.serviceHeartbeat.upsert({
      where: { serviceName: 'birthday_reminders' },
      update: { updatedAt: new Date(), metadata: JSON.stringify(stats) },
      create: { serviceName: 'birthday_reminders', metadata: JSON.stringify(stats) },
    });

    const durationMs = Date.now() - startedAt;
    logger.info({ ...stats, durationMs }, 'birthday_scheduler_completed');
    trackEvent('birthday.scheduler_run_completed', undefined, { ...stats, durationMs });
  } catch (err) {
    logger.error({ err }, 'birthday: scheduler run failed');
    trackEvent('birthday.scheduler_run_failed', undefined, { err: String(err) });
  }
}

type BirthdayCandidate = {
  userId: string;
  birthday: Date | null;
  hideYear: boolean;
  displayName: string | null;
  username: string | null;
  birthdayFriendReminders: boolean;
  birthdayOwnerReminders: boolean;
  birthdayAdvancedWindowsEnabled: boolean;
  birthdayAudience: string;
  birthdayPrimaryWishlistId: string | null;
  birthdayCustomMessage: string | null;
  profileVisibility: string;
  user: { id: string; telegramChatId: string | null; firstName: string | null; godMode: boolean };
};

async function maybeCreateOwnerDelivery(
  cand: BirthdayCandidate,
  offsetDays: number,
  todayMsk: { year: number; month: number; day: number },
  miniAppUrl: string,
  stats: { deliveriesCreated: number; sent: number; skipped: number; deferred: number; failed: number; bySkipReason: Record<string, number>; byKind: Record<string, number> },
): Promise<void> {
  const kind = BIRTHDAY_OWNER_KINDS_BY_OFFSET[offsetDays];
  if (!kind) return;
  if (!cand.birthday) return;

  const ent = await getEffectiveEntitlements(cand.userId, cand.user.godMode);
  const isPro = ent.isPro;
  const proWindowActive = isPro && cand.birthdayAdvancedWindowsEnabled;
  const ownerOffsets = proWindowActive ? BIRTHDAY_OWNER_PRO_OFFSETS : BIRTHDAY_OWNER_FREE_OFFSETS;
  if (!(ownerOffsets as readonly number[]).includes(offsetDays)) {
    // Window not active for this user. Two reasons:
    //   - Free user, never enabled — silent (offset just isn't in their plan)
    //   - Ex-Pro user, downgraded after enabling advanced windows: persist a
    //     `pro_required` skip so God Mode shows downgrade impact.
    if (cand.birthdayAdvancedWindowsEnabled && !isPro) {
      await persistOwnerSkip(cand.userId, offsetDays, kind, todayMsk, 'pro_required', stats, cand.birthday);
    }
    return;
  }

  if (!cand.birthdayOwnerReminders) {
    await persistOwnerSkip(cand.userId, offsetDays, kind, todayMsk, 'friend_reminders_disabled', stats, cand.birthday);
    return;
  }
  if (!cand.user.telegramChatId) {
    await persistOwnerSkip(cand.userId, offsetDays, kind, todayMsk, 'no_chat_id', stats, cand.birthday);
    return;
  }

  const occurrenceKey = buildOccurrenceKey(cand.birthday, todayMsk, offsetDays);
  if (!occurrenceKey) return;

  // Owner_14d / owner_7d: only send when there's a "problem" to solve.
  let ownerHasNoPublic = false;
  let ownerWishlistEmpty = false;
  if (offsetDays === 14 || offsetDays === 7) {
    const wlCount = await prisma.wishlist.count({
      where: { ownerId: cand.userId, archivedAt: null, visibility: { in: ['PUBLIC_PROFILE', 'LINK_ONLY'] } },
    });
    ownerHasNoPublic = wlCount === 0;
    if (!ownerHasNoPublic) {
      const itemCount = await prisma.item.count({
        where: { wishlist: { ownerId: cand.userId, archivedAt: null, visibility: { in: ['PUBLIC_PROFILE', 'LINK_ONLY'] } }, status: 'AVAILABLE' },
      });
      ownerWishlistEmpty = itemCount === 0;
    }
    if (!ownerHasNoPublic && !ownerWishlistEmpty) {
      // No problem to solve — silently skip (no delivery row).
      return;
    }
  }

  // Pick target
  const picked = await pickBirthdayPrimaryWishlist(cand.userId, cand.birthdayPrimaryWishlistId);
  let targetType: string;
  let targetId: string | null = null;
  if (picked) {
    targetType = 'own_wishlist';
    targetId = picked.id;
  } else if (ownerHasNoPublic) {
    targetType = 'wishlists_index';
    targetId = null;
  } else {
    targetType = 'create_wishlist';
    targetId = null;
  }

  // Try to create delivery (idempotent via unique index)
  let delivery: { id: string } | null = null;
  try {
    const created = await prisma.birthdayReminderDelivery.create({
      data: {
        birthdayUserId: cand.userId,
        recipientUserId: cand.userId,
        occurrenceKey,
        reminderKind: kind,
        status: 'pending',
        targetType,
        targetId,
        deepLinkPayload: '', // filled below
        relationType: null,
      },
      select: { id: true },
    });
    delivery = created;
    stats.deliveriesCreated++;
    trackEvent('birthday.delivery_created', cand.userId, { kind, targetType, owner: true });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') return; // already exists
    throw err;
  }

  await prisma.birthdayReminderDelivery.update({
    where: { id: delivery.id },
    data: { deepLinkPayload: `br_${delivery.id}` },
  });

  const sendResult = await sendBirthdayDelivery(delivery.id, miniAppUrl);
  if (sendResult === 'sent') {
    stats.sent++;
    stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
  } else if (sendResult === 'deferred') {
    stats.deferred++;
  } else if (sendResult === 'skipped') {
    stats.skipped++;
  } else {
    stats.failed++;
  }
}

async function maybeCreateFriendDeliveries(
  cand: BirthdayCandidate,
  offsetDays: number,
  todayMsk: { year: number; month: number; day: number },
  miniAppUrl: string,
  stats: { deliveriesCreated: number; sent: number; skipped: number; deferred: number; failed: number; bySkipReason: Record<string, number>; byKind: Record<string, number> },
): Promise<void> {
  const kind = BIRTHDAY_FRIEND_KINDS_BY_OFFSET[offsetDays];
  if (!kind) return;
  if (!cand.birthday) return;

  // Owner-level scheduling-blocked checks. Each persists a single skip row
  // (recipientUserId = birthdayUserId as a marker) so God Mode can see why
  // friends never got reminders for this owner. Idempotent via unique index.
  if (!cand.birthdayFriendReminders) {
    await persistOwnerSkip(cand.userId, offsetDays, kind, todayMsk, 'friend_reminders_disabled', stats, cand.birthday);
    return;
  }
  if (cand.profileVisibility === 'NOBODY') {
    await persistOwnerSkip(cand.userId, offsetDays, kind, todayMsk, 'profile_private', stats, cand.birthday);
    return;
  }

  const ent = await getEffectiveEntitlements(cand.userId, cand.user.godMode);
  const isPro = ent.isPro;
  const friendOffsets = (isPro || cand.birthdayAdvancedWindowsEnabled) ? BIRTHDAY_FRIEND_PRO_OFFSETS : BIRTHDAY_FRIEND_FREE_OFFSETS;
  if (!(friendOffsets as readonly number[]).includes(offsetDays)) {
    // Pro window inactive. If user previously had it enabled (downgrade case),
    // persist a `pro_required` skip so paywall-conversion analysis can compare
    // pre/post downgrade volume. Free users who never enabled don't generate noise.
    if (cand.birthdayAdvancedWindowsEnabled && !isPro) {
      await persistOwnerSkip(cand.userId, offsetDays, kind, todayMsk, 'pro_required', stats, cand.birthday);
    }
    return;
  }

  // Audience: only Pro can use EXTENDED. If user has it set but is now Free, downgrade to SUBSCRIBERS.
  const effectiveAudience: 'SUBSCRIBERS' | 'EXTENDED' =
    (cand.birthdayAudience === 'EXTENDED' && isPro) ? 'EXTENDED' : 'SUBSCRIBERS';

  const occurrenceKey = buildOccurrenceKey(cand.birthday, todayMsk, offsetDays);
  if (!occurrenceKey) return;

  // Pick target — wishlist (preferred) or profile fallback.
  // If owner has a primaryWishlistId set but the target wishlist is unavailable
  // (deleted / private / no active items), fire the analytics signal so God Mode
  // can show ghost-Pro-config impact. Auto-pick still proceeds gracefully.
  let picked = null as Awaited<ReturnType<typeof pickBirthdayPrimaryWishlist>>;
  if (cand.birthdayPrimaryWishlistId) {
    picked = await pickBirthdayPrimaryWishlist(cand.userId, cand.birthdayPrimaryWishlistId);
    if (!picked || !picked.fromPrimary) {
      // primaryWishlistId points to something we can't use. Fire signal but continue.
      trackEvent('birthday.primary_wishlist_unavailable' as never, cand.userId, {
        kind, primaryWishlistId: cand.birthdayPrimaryWishlistId,
      });
    }
  } else {
    picked = await pickBirthdayPrimaryWishlist(cand.userId, null);
  }
  const targetType: 'wishlist' | 'profile' = picked ? 'wishlist' : 'profile';
  const targetId: string | null = picked?.slug ?? cand.username ?? null;

  // Recipients
  const recipients = await findBirthdayFriendRecipients(cand.userId, effectiveAudience);
  if (recipients.length === 0) return;

  for (const r of recipients.slice(0, BIRTHDAY_BATCH_RECIPIENTS)) {
    try {
      // Skip self defensively
      if (r.userId === cand.userId) continue;

      // Recipient settings + chat ID + mute
      const recipient = await prisma.user.findUnique({
        where: { id: r.userId },
        select: {
          id: true, telegramChatId: true,
          profile: { select: { notifyBirthdays: true } },
        },
      });
      if (!recipient) continue;

      // Pre-create skip checks
      let skipReason: BirthdaySkipReason | null = null;
      if (!recipient.telegramChatId) skipReason = 'no_chat_id';
      else if (recipient.profile?.notifyBirthdays === false) skipReason = 'recipient_opted_out';
      else {
        const muted = await prisma.birthdayReminderMute.findUnique({
          where: { userId_mutedBirthdayUserId: { userId: r.userId, mutedBirthdayUserId: cand.userId } },
        });
        if (muted) skipReason = 'muted';
      }
      if (!skipReason && (kind === 'friend_14d' || kind === 'friend_7d' || kind === 'friend_1d')) {
        // Daily cap: today reminder is allowed even at cap (people want bday-day notice)
        const capped = await recipientHitDailyCap(r.userId, todayMsk);
        if (capped) skipReason = 'daily_cap';
      }

      // Try to create delivery row (idempotent)
      let delivery: { id: string } | null = null;
      try {
        const created = await prisma.birthdayReminderDelivery.create({
          data: {
            birthdayUserId: cand.userId,
            recipientUserId: r.userId,
            occurrenceKey,
            reminderKind: kind,
            status: skipReason === 'daily_cap' ? 'deferred' : (skipReason ? 'skipped' : 'pending'),
            skipReason: skipReason ?? null,
            deferredUntil: skipReason === 'daily_cap' ? nextMskMorning(new Date()) : null,
            targetType,
            targetId,
            deepLinkPayload: '',
            relationType: r.relationType,
          },
          select: { id: true },
        });
        delivery = created;
        stats.deliveriesCreated++;
        trackEvent('birthday.delivery_created', cand.userId, { kind, targetType, recipientId: r.userId });
      } catch (err: unknown) {
        if ((err as { code?: string }).code === 'P2002') continue; // already exists
        throw err;
      }

      // Branch order matters: 'daily_cap' is persisted as `deferred` status (with
      // deferredUntil set), so it must be checked BEFORE the generic skip-reason
      // catch-all. Previously this block was unreachable and `daily_cap` rows
      // were mis-attributed to `birthday.delivery_skipped`, breaking the
      // `noSendsDespiteCandidates` God Mode alert.
      if (skipReason === 'daily_cap') {
        stats.deferred++;
        // Still record the skip-reason in bySkipReason so God Mode shows the
        // load-shedding signal alongside the deferred count.
        stats.bySkipReason[skipReason] = (stats.bySkipReason[skipReason] ?? 0) + 1;
        trackEvent('birthday.delivery_deferred', cand.userId, { kind, until: 'next_morning_msk', reason: 'daily_cap' });
        continue;
      }
      if (skipReason) {
        stats.skipped++;
        stats.bySkipReason[skipReason] = (stats.bySkipReason[skipReason] ?? 0) + 1;
        trackEvent('birthday.delivery_skipped', cand.userId, { kind, skipReason });
        continue;
      }

      await prisma.birthdayReminderDelivery.update({
        where: { id: delivery.id },
        data: { deepLinkPayload: `br_${delivery.id}` },
      });
      const sendResult = await sendBirthdayDelivery(delivery.id, miniAppUrl);
      if (sendResult === 'sent') {
        stats.sent++;
        stats.byKind[kind] = (stats.byKind[kind] ?? 0) + 1;
      } else if (sendResult === 'failed') {
        stats.failed++;
      }
    } catch (err) {
      logger.error({ err, recipientId: r.userId, birthdayUserId: cand.userId }, 'birthday: friend delivery loop error');
    }
  }
}

/**
 * Send a single delivery row (assumed status `pending` or `deferred`).
 * Updates status to `sent` / `failed` / `skipped` / `deferred` based on outcome.
 *
 * Performs FRESH-CHECK of privacy + recipient settings to handle race
 * conditions where settings change between scheduling and sending.
 */
async function sendBirthdayDelivery(deliveryId: string, miniAppUrl: string): Promise<'sent' | 'failed' | 'skipped' | 'deferred'> {
  const d = await prisma.birthdayReminderDelivery.findUnique({
    where: { id: deliveryId },
    select: {
      id: true, birthdayUserId: true, recipientUserId: true, reminderKind: true,
      targetType: true, targetId: true, deepLinkPayload: true, status: true,
    },
  });
  if (!d) return 'skipped';
  if (d.status === 'sent') return 'sent';
  if (d.status === 'failed') return 'failed';

  const isOwner = d.reminderKind.startsWith('owner_');

  // Re-read birthday user's profile + ent
  const birthdayUserRow = await prisma.user.findUnique({
    where: { id: d.birthdayUserId },
    select: {
      id: true, firstName: true, godMode: true,
      profile: {
        select: {
          birthday: true, displayName: true, username: true, profileVisibility: true,
          birthdayFriendReminders: true, birthdayOwnerReminders: true,
          birthdayAdvancedWindowsEnabled: true, birthdayCustomMessage: true,
          birthdayPrimaryWishlistId: true,
          languageMode: true, manualLanguage: true, normalizedLocale: true, language: true,
        },
      },
    },
  });
  if (!birthdayUserRow?.profile) {
    await markDeliverySkipped(d.id, 'birthday_hidden');
    return 'skipped';
  }
  const bp = birthdayUserRow.profile;
  if (!bp.birthday) {
    await markDeliverySkipped(d.id, 'birthday_hidden');
    return 'skipped';
  }

  // Recipient (may equal birthday user for owner reminders)
  let recipient: { id: string; telegramChatId: string | null; profile: { notifyBirthdays: boolean; languageMode: string; manualLanguage: string | null; normalizedLocale: string | null; language: string | null } | null } | null = null;
  if (isOwner) {
    const userRow = await prisma.user.findUnique({
      where: { id: d.recipientUserId },
      select: { id: true, telegramChatId: true, profile: { select: { notifyBirthdays: true, languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } } },
    });
    recipient = userRow;
  } else {
    const userRow = await prisma.user.findUnique({
      where: { id: d.recipientUserId },
      select: { id: true, telegramChatId: true, profile: { select: { notifyBirthdays: true, languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } } },
    });
    recipient = userRow;
  }
  if (!recipient?.telegramChatId) {
    await markDeliverySkipped(d.id, 'no_chat_id');
    return 'skipped';
  }

  // Fresh privacy / settings check
  if (!isOwner) {
    if (!bp.birthdayFriendReminders) { await markDeliverySkipped(d.id, 'friend_reminders_disabled'); return 'skipped'; }
    if (bp.profileVisibility === 'NOBODY') { await markDeliverySkipped(d.id, 'profile_private'); return 'skipped'; }
    if (recipient.profile && recipient.profile.notifyBirthdays === false) { await markDeliverySkipped(d.id, 'recipient_opted_out'); return 'skipped'; }
    const muted = await prisma.birthdayReminderMute.findUnique({
      where: { userId_mutedBirthdayUserId: { userId: d.recipientUserId, mutedBirthdayUserId: d.birthdayUserId } },
    });
    if (muted) { await markDeliverySkipped(d.id, 'muted'); return 'skipped'; }
  } else {
    if (!bp.birthdayOwnerReminders) { await markDeliverySkipped(d.id, 'friend_reminders_disabled'); return 'skipped'; }
  }

  // Build message
  const recipientLocale: Locale = recipient.profile
    ? resolveEffectiveLocale({
        languageMode: recipient.profile.languageMode as LanguageMode,
        manualLanguage: recipient.profile.manualLanguage,
        normalizedLocale: recipient.profile.normalizedLocale,
        legacyLanguage: recipient.profile.language,
      } as LanguageSettings)
    : 'ru';

  const ent = await getEffectiveEntitlements(d.birthdayUserId, birthdayUserRow.godMode);
  const isPro = ent.isPro;

  // Pro-gated: custom message only used when birthday user is Pro
  const customMessage = (isPro && !isOwner) ? (bp.birthdayCustomMessage?.trim() || null) : null;

  // Days until next birthday (re-computed at send time)
  const days = daysUntilNextBirthday(bp.birthday, new Date()) ?? 0;

  // For owner reminders: check current wishlist state (race-safe)
  let ownerHasNoPublic = false;
  let ownerWishlistEmpty = false;
  if (isOwner && (d.reminderKind === 'owner_14d' || d.reminderKind === 'owner_7d')) {
    const wlCount = await prisma.wishlist.count({
      where: { ownerId: d.birthdayUserId, archivedAt: null, visibility: { in: ['PUBLIC_PROFILE', 'LINK_ONLY'] } },
    });
    ownerHasNoPublic = wlCount === 0;
    if (!ownerHasNoPublic) {
      const itemCount = await prisma.item.count({
        where: { wishlist: { ownerId: d.birthdayUserId, archivedAt: null, visibility: { in: ['PUBLIC_PROFILE', 'LINK_ONLY'] } }, status: 'AVAILABLE' },
      });
      ownerWishlistEmpty = itemCount === 0;
    }
    // Race: problem solved between scheduling and now → skip
    if (!ownerHasNoPublic && !ownerWishlistEmpty) {
      await markDeliverySkipped(d.id, 'no_problem_to_solve');
      return 'skipped';
    }
  }

  const displayName = pickBirthdayDisplayName({
    displayName: bp.displayName, username: bp.username, firstName: birthdayUserRow.firstName,
  });

  const { text, replyMarkup } = buildBirthdayBotMessage({
    delivery: { reminderKind: d.reminderKind, targetType: d.targetType, targetId: d.targetId, deepLinkPayload: d.deepLinkPayload, id: d.id },
    birthdayDisplayName: displayName,
    daysUntil: days,
    customMessage,
    ownerWishlistEmpty,
    ownerHasNoPublic,
    locale: recipientLocale,
    miniAppUrl,
  });

  // Send
  // Send with outcome detection. We re-implement the Telegram POST inline (rather
  // than reusing the boolean-returning sendTgBotMessage) so we can distinguish
  // bot_blocked (Telegram 403 / 'bot was blocked by the user') from generic
  // transient/permanent failures. bot_blocked deliveries are recorded as
  // `skipped` with skipReason='bot_blocked' so God Mode load-balance metrics
  // don't conflate them with retryable failures.
  const sendOutcome = await sendBirthdayBotPost(recipient.telegramChatId, text, replyMarkup);

  if (sendOutcome.kind === 'sent') {
    await prisma.birthdayReminderDelivery.update({
      where: { id: d.id },
      data: { status: 'sent', sentAt: new Date(), telegramMessageId: sendOutcome.messageId ?? null },
    });
    trackEvent('birthday.delivery_sent', d.birthdayUserId, {
      kind: d.reminderKind, targetType: d.targetType, recipientId: d.recipientUserId,
      isPro,
    });
    return 'sent';
  }
  if (sendOutcome.kind === 'bot_blocked') {
    await prisma.birthdayReminderDelivery.update({
      where: { id: d.id },
      data: { status: 'skipped', skipReason: 'bot_blocked' },
    });
    trackEvent('birthday.delivery_skipped', d.birthdayUserId, { kind: d.reminderKind, skipReason: 'bot_blocked' });
    return 'skipped';
  }
  // transient or permanent send failure
  await prisma.birthdayReminderDelivery.update({
    where: { id: d.id },
    data: { status: 'failed', failureReason: sendOutcome.reason ?? 'send_failed' },
  });
  trackEvent('birthday.delivery_failed', d.birthdayUserId, { kind: d.reminderKind, reason: sendOutcome.reason ?? 'send_failed' });
  return 'failed';
}

/**
 * Send a bot DM and classify the outcome. Mirrors the classification logic of
 * sendLifecycleDM but accepts an arbitrary inline_keyboard (lifecycle helper
 * only supports a single web_app button).
 *
 * Outcomes:
 *   sent          — delivered (Telegram returned ok:true)
 *   bot_blocked   — recipient blocked the bot (403 / "bot was blocked")
 *   transient     — 429 / 5xx / network error; caller should leave row pending
 *                   for retry on next scheduler tick
 *   permanent     — other 4xx, not retryable
 */
async function sendBirthdayBotPost(
  chatId: string,
  text: string,
  replyMarkup: Record<string, unknown>,
): Promise<{ kind: 'sent'; messageId?: number } | { kind: 'bot_blocked' } | { kind: 'transient'; reason: string } | { kind: 'permanent'; reason: string }> {
  const token = process.env.BOT_TOKEN;
  if (!token || !chatId) return { kind: 'permanent', reason: 'no_token_or_chat_id' };
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', reply_markup: replyMarkup }),
    });
    if (resp.status === 429 || resp.status >= 500) {
      return { kind: 'transient', reason: `http_${resp.status}` };
    }
    const data = await resp.json() as { ok: boolean; description?: string; result?: { message_id?: number } };
    if (data.ok) {
      return { kind: 'sent', messageId: data.result?.message_id };
    }
    const desc = (data.description ?? '').toLowerCase();
    if (resp.status === 403 || desc.includes('bot was blocked') || desc.includes('user is deactivated')) {
      return { kind: 'bot_blocked' };
    }
    if (desc.includes('chat not found')) {
      return { kind: 'permanent', reason: 'chat_not_found' };
    }
    return { kind: 'permanent', reason: data.description ?? 'unknown' };
  } catch (err) {
    return { kind: 'transient', reason: err instanceof Error ? err.message : 'network_error' };
  }
}

/**
 * Persist a `skipped` row at scheduling-time (before any delivery row exists).
 * Used by maybeCreateOwnerDelivery / maybeCreateFriendDeliveries to record
 * pre-create skip causes so God Mode can see them. Idempotent via the unique
 * (birthdayUserId, recipientUserId, occurrenceKey, reminderKind) constraint.
 */
async function persistOwnerSkip(
  ownerUserId: string,
  offsetDays: number,
  kind: BirthdayReminderKind,
  todayMsk: { year: number; month: number; day: number },
  reason: BirthdaySkipReason,
  stats: { skipped: number; bySkipReason: Record<string, number> },
  birthday: Date,
): Promise<void> {
  const occurrenceKey = buildOccurrenceKey(birthday, todayMsk, offsetDays);
  if (!occurrenceKey) return;
  try {
    await prisma.birthdayReminderDelivery.create({
      data: {
        birthdayUserId: ownerUserId,
        recipientUserId: ownerUserId,
        occurrenceKey,
        reminderKind: kind,
        status: 'skipped',
        skipReason: reason,
        targetType: null,
        targetId: null,
        deepLinkPayload: '',
        relationType: null,
      },
    });
    stats.skipped++;
    stats.bySkipReason[reason] = (stats.bySkipReason[reason] ?? 0) + 1;
    trackEvent('birthday.delivery_skipped', ownerUserId, { kind, skipReason: reason, owner: true });
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') return; // already recorded
    throw err;
  }
}

async function markDeliverySkipped(deliveryId: string, reason: BirthdaySkipReason): Promise<void> {
  await prisma.birthdayReminderDelivery.update({
    where: { id: deliveryId },
    data: { status: 'skipped', skipReason: reason },
  });
  trackEvent('birthday.delivery_skipped', undefined, { deliveryId, reason });
}

// Birthday reminders: run hourly. Idempotent; safe across restarts.
setInterval(() => { void processBirthdayReminders(); }, 60 * 60 * 1000);
// Run once at startup, ~30s after boot, so a freshly deployed pod doesn't wait
// up to an hour to send the day's reminders.
setTimeout(() => { void processBirthdayReminders(); }, 30_000);

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

  // Ensure SantaGlobalConfig singleton exists.
  // This is idempotent — upsert preserves the existing santaEnabled value if already set.
  // If the row doesn't exist yet (fresh DB), it is created with santaEnabled=true (default on).
  void prisma.santaGlobalConfig.upsert({
    where:  { id: 'global' },
    create: { id: 'global', santaEnabled: true },
    update: {}, // never overwrite an existing setting on startup
  }).catch(err => {
    logger.error({ err }, 'startup: SantaGlobalConfig upsert failed');
  });

  // Backfill: generate aliases for all existing rounds that have none yet.
  // Idempotent — skipDuplicates; non-blocking; never fails startup.
  void (async () => {
    try {
      const rounds = await prisma.santaRound.findMany({
        where: {
          drawStatus: 'DONE',
          aliases: { none: {} },
        },
        select: {
          id: true,
          assignments: {
            select: { giverParticipantId: true, receiverParticipantId: true },
          },
        },
      });
      for (const round of rounds) {
        const participantIds = [
          ...new Set([
            ...round.assignments.map(a => a.giverParticipantId),
            ...round.assignments.map(a => a.receiverParticipantId),
          ]),
        ];
        if (participantIds.length === 0) continue;
        const aliasData = generateSantaAliases(round.id, participantIds);
        await prisma.santaParticipantAlias.createMany({
          data: aliasData.map(a => ({ roundId: round.id, ...a })),
          skipDuplicates: true,
        });
        logger.info({ count: aliasData.length, roundId: round.id }, 'startup: backfilled aliases for round');
      }
      if (rounds.length > 0) {
        logger.info({ rounds: rounds.length }, 'startup: Santa alias backfill complete');
      }
    } catch (err) {
      logger.error({ err }, 'startup: Santa alias backfill failed (non-fatal)');
    }
  })();
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
