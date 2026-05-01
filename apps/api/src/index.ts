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

/** Smart Reservations: compute derived fields from meta snapshot */
function smartResDerive(meta: { expiresAt: Date | null; extensionCount: number; isSmartRes: boolean; smartResMaxExtensions: number | null; smartResAllowExtend: boolean | null; smartResTtlHours: number | null }) {
  if (!meta.isSmartRes || !meta.expiresAt) return { canExtend: false, isExpiringSoon: false, isExpired: false };
  const now = Date.now();
  const expires = meta.expiresAt.getTime();
  const isExpired = expires <= now;
  const leadH = getSmartResLeadHours(meta.smartResTtlHours ?? 72);
  const isExpiringSoon = !isExpired && (expires - now) <= leadH * 3600000;
  const canExtend = !isExpired && (meta.smartResAllowExtend ?? false) && meta.extensionCount < (meta.smartResMaxExtensions ?? 0);
  return { canExtend, isExpiringSoon, isExpired };
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

/** Gate helper: Secret Reservations feature required */
function requireSecretReservations(ent: Awaited<ReturnType<typeof getEffectiveEntitlements>>, res: any): boolean {
  if (!ent.hasSecretReservations) {
    trackEvent('feature_gate_hit_secret_reservations');
    res.status(403).json({ error: 'secret_reservations_required' });
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

// ─── Secret Reservation helpers ──────────────────────────────────────────────
type SecretReservationSnapshot = {
  title: string;
  url: string | null;
  priceText: string | null;
  currency: string | null;
  imageUrl: string | null;
  description: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  status: string;
};

function buildSecretReservationSnapshot(item: {
  title: string;
  url: string | null;
  priceText: string | null;
  currency: string | null;
  imageUrl: string | null;
  description: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  status: string;
}): SecretReservationSnapshot {
  return {
    title: item.title,
    url: item.url,
    priceText: item.priceText,
    currency: item.currency,
    imageUrl: item.imageUrl,
    description: item.description,
    priority: item.priority,
    status: item.status,
  };
}

type SecretReservationDerivedState =
  | 'ACTIVE'
  | 'ITEM_UPDATED'
  | 'PUBLIC_RESERVED_BY_OTHER'
  | 'ITEM_FULFILLED'
  | 'ITEM_UNAVAILABLE';

function deriveSecretReservationState(args: {
  snapshot: SecretReservationSnapshot;
  reserverUserId: string;
  currentItem: {
    status: string;
    title: string;
    url: string | null;
    priceText: string | null;
    currency: string | null;
    imageUrl: string | null;
    description: string | null;
    priority: 'LOW' | 'MEDIUM' | 'HIGH';
    reserverUserId: string | null;
    archivedAt: Date | null;
  };
}): { state: SecretReservationDerivedState; diffFields: string[] } {
  const { snapshot, reserverUserId, currentItem } = args;
  if (currentItem.archivedAt) return { state: 'ITEM_UNAVAILABLE', diffFields: [] };
  if (currentItem.status === 'PURCHASED') return { state: 'ITEM_FULFILLED', diffFields: [] };
  if (
    currentItem.status === 'RESERVED'
    && currentItem.reserverUserId
    && currentItem.reserverUserId !== reserverUserId
  ) {
    return { state: 'PUBLIC_RESERVED_BY_OTHER', diffFields: [] };
  }

  const diffFields: string[] = [];
  if (snapshot.title !== currentItem.title) diffFields.push('title');
  if ((snapshot.url ?? null) !== (currentItem.url ?? null)) diffFields.push('url');
  if ((snapshot.priceText ?? null) !== (currentItem.priceText ?? null)) diffFields.push('priceText');
  if ((snapshot.currency ?? null) !== (currentItem.currency ?? null)) diffFields.push('currency');
  if ((snapshot.imageUrl ?? null) !== (currentItem.imageUrl ?? null)) diffFields.push('imageUrl');
  if ((snapshot.description ?? null) !== (currentItem.description ?? null)) diffFields.push('description');
  if (snapshot.priority !== currentItem.priority) diffFields.push('priority');

  if (diffFields.length > 0) return { state: 'ITEM_UPDATED', diffFields };
  return { state: 'ACTIVE', diffFields: [] };
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

/**
 * Attribution: when a user visits, mark their most recent lifecycle touch as "returned".
 * Fire-and-forget, best-effort. Also checks if target action completed.
 */
async function attributeLifecycleReturn(userId: string): Promise<{
  touch: { id: string; segment: string; offerCode: string | null; targetCompletedAt: Date | null } | null;
  justCompleted: boolean;
}> {
  const empty = { touch: null, justCompleted: false };
  try {
    // Find latest sent touch without returnedAt, within 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const touch = await prisma.lifecycleTouch.findFirst({
      where: { userId, sentAt: { gte: sevenDaysAgo }, delivered: true, returnedAt: null, stoppedAt: null },
      orderBy: { sentAt: 'desc' },
    });
    if (!touch || !touch.sentAt) return empty;
    const now = new Date();
    // Mark return
    await prisma.lifecycleTouch.update({
      where: { id: touch.id },
      data: { returnedAt: now },
    });
    // Check target completion
    let justCompleted = false;
    if (!touch.targetCompletedAt) {
      let completed = false;
      let completedType: string | null = null;
      if (touch.segment === 'S1') {
        const wl = await prisma.wishlist.count({ where: { ownerId: userId, type: 'REGULAR' } });
        if (wl > 0) { completed = true; completedType = 'created_wishlist'; }
      } else if (touch.segment === 'S2') {
        const items = await prisma.item.count({ where: { wishlist: { ownerId: userId, type: 'REGULAR' }, status: { in: ['AVAILABLE', 'RESERVED'] } } });
        if (items > 0) { completed = true; completedType = 'added_item'; }
      } else if (touch.segment === 'S3') {
        // S3 target: added 2+ more wishes since touch was sent (indicates real effort toward share-ready state)
        const newItemsSinceTouch = await prisma.item.count({
          where: { wishlist: { ownerId: userId, type: 'REGULAR' }, createdAt: { gte: touch.sentAt }, status: { not: 'DELETED' } },
        });
        if (newItemsSinceTouch >= 2) { completed = true; completedType = 'added_more_wishes'; }
      } else if (touch.segment === 'S4') {
        // Check if user has been active (updated anything since touch was sent)
        const activity = await prisma.item.count({
          where: { wishlist: { ownerId: userId, type: 'REGULAR' }, updatedAt: { gte: touch.sentAt } },
        });
        if (activity > 0) { completed = true; completedType = 'updated_content'; }
      }
      if (completed) {
        await prisma.lifecycleTouch.update({
          where: { id: touch.id },
          data: { targetCompletedAt: now, targetCompletedType: completedType },
        });
        justCompleted = true;
      }
    }
    return { touch: { id: touch.id, segment: touch.segment, offerCode: touch.offerCode, targetCompletedAt: touch.targetCompletedAt ?? (justCompleted ? new Date() : null) }, justCompleted };
  } catch { return empty; }
}

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

// GET /tg/referral/me — inviter code + stats summary + reward caps snapshot
tgRouter.get(
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
tgRouter.get(
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
tgRouter.get(
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
tgRouter.get(
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
// ─────────────────────────────────────────────────────────────────────────────

// GET /tg/wishlists — my wishlists
tgRouter.get(
  '/wishlists',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    // Fire-and-forget: attribute lifecycle return if applicable
    void attributeLifecycleReturn(user.id);
    const [ent, userProfile] = await Promise.all([
      getEffectiveEntitlements(user.id, user.godMode),
      prisma.userProfile.findUnique({ where: { userId: user.id }, select: { cardDisplayMode: true } }),
    ]);

    const wishlists = await prisma.wishlist.findMany({
      where: { ownerId: user.id, type: 'REGULAR', archivedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],  // position first, then createdAt for readOnly calculation
      select: {
        id: true, slug: true, title: true, emoji: true, description: true, deadline: true,
        visibility: true, allowSubscriptions: true, commentPolicy: true,
        shareToken: true, dontGiftMode: true,
        smartReservationsEnabled: true, smartResTtlHours: true, smartResAllowExtend: true, smartResMaxExtensions: true,
        items: { select: { status: true } },
      },
    });

    // Drafts count (system wishlist)
    let drafts: { wishlistId: string; count: number } | null = null;
    const draftsWl = await prisma.wishlist.findFirst({
      where: { ownerId: user.id, type: 'SYSTEM_DRAFTS' },
      select: {
        id: true,
        items: { where: { status: { in: [...ACTIVE_STATUSES] } }, select: { id: true } },
      },
    });
    if (draftsWl && draftsWl.items.length > 0) {
      drafts = { wishlistId: draftsWl.id, count: draftsWl.items.length };
    }

    // Count user's active reservations (for "My Reservations" section)
    // Includes both regular item reservations and Santa-flow SantaItemReservation rows.
    const [regularReservationsCount, santaReservationsCount, ggParticipantCount] = await Promise.all([
      prisma.item.count({ where: { reserverUserId: user.id, status: 'RESERVED' } }),
      prisma.santaItemReservation.count({
        where: {
          assignment: {
            giver: { userId: user.id },
            giftStatus: { notIn: ['RECEIVED', 'ORPHANED'] },
            round: { campaign: { status: { not: 'CANCELLED' } } },
          },
        },
      }),
      // Count group gift participations where user is NOT the item reserver (to avoid double-counting)
      prisma.groupGiftParticipant.count({
        where: {
          userId: user.id,
          groupGift: { status: 'OPEN', item: { reserverUserId: { not: user.id } } },
        },
      }),
    ]);
    const reservationsCount = regularReservationsCount + santaReservationsCount + ggParticipantCount;

    return res.json({
      wishlists: wishlists.map((wl, idx) => {
        const active = wl.items.filter((i) => (ACTIVE_STATUSES as readonly string[]).includes(i.status));
        return {
          id: wl.id,
          slug: wl.slug,
          title: wl.title,
          emoji: wl.emoji ?? null,
          description: wl.description,
          deadline: wl.deadline?.toISOString() ?? null,
          itemCount: active.length,
          reservedCount: active.filter((i) => i.status !== 'AVAILABLE').length,
          readOnly: idx >= ent.effectiveWishlistLimit,
          visibility: (wl.visibility as string).toLowerCase() as 'link_only' | 'public_profile' | 'private',
          allowSubscriptions: (wl.allowSubscriptions as string).toLowerCase() as 'all' | 'nobody',
          commentPolicy: (wl.commentPolicy as string).toLowerCase() as 'all' | 'subscribers',
          shareToken: wl.shareToken ?? null,
          dontGiftMode: wl.dontGiftMode as 'global' | 'local' | 'hidden',
          smartReservationsEnabled: wl.smartReservationsEnabled,
          smartResTtlHours: wl.smartResTtlHours,
          smartResAllowExtend: wl.smartResAllowExtend,
          smartResMaxExtensions: wl.smartResMaxExtensions,
        };
      }),
      plan: {
        code: ent.plan.code,
        wishlists: ent.effectiveWishlistLimit,
        items: ent.plan.items,
        subscriptions: ent.effectiveSubscriptionLimit,
        participants: ent.plan.participants,
        features: [...ent.plan.features],
      },
      subscription: ent.subscription,
      proSource: ent.proSource,
      promoPro: ent.promoPro,
      giftNotes: ent.giftNotes,
      groupGift: ent.groupGift,
      secretReservations: ent.secretReservations,
      cardDisplayMode: ent.isPro ? (userProfile?.cardDisplayMode ?? 'auto') : 'auto',
      godMode: user.godMode,
      canGodMode: user.telegramId
        ? (process.env.GOD_MODE_TELEGRAM_IDS ?? '').split(',').filter(Boolean).includes(user.telegramId)
        : false,
      drafts,
      reservationsCount,
      addOns: {
        extraWishlistSlots: ent.addOns.filter(a => a.addonType === 'wishlist_slot').reduce((s, a) => s + a.quantity, 0),
        extraSubscriptionSlots: ent.addOns.filter(a => a.addonType === 'subscription_slot').reduce((s, a) => s + a.quantity, 0),
        seasonalWishlists: [...ent.seasonalWishlists],
        extraItemsPerWishlist: ent.extraItemsPerWishlist,
        smartReservationsWishlists: [...ent.smartReservationsWishlists],
      },
      credits: {
        hintCredits: ent.hintCredits,
        importCredits: ent.importCredits,
      },
      skus: Object.values(ONE_TIME_SKUS).map(s => ({
        code: s.code,
        price: s.price,
        type: s.type,
        targetRequired: s.targetRequired,
      })),
    });
  }),
);

// GET /tg/reservations — items reserved by current user across all wishlists
tgRouter.get(
  '/reservations',
  asyncHandler(async (req, res) => {
    const locale = getRequestLocale(req);
    const user = await getOrCreateTgUser(req.tgUser!);
    const actorHash = tgActorHash(req.tgUser!.id);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    const resPro = hasReservationPro(user, ent.isPro, ent.addOns);

    // 1. Items reserved by this user (only TG-identified reservations)
    const items = await prisma.item.findMany({
      where: { reserverUserId: user.id, status: 'RESERVED' },
      select: {
        id: true, wishlistId: true, title: true, url: true, priceText: true,
        imageUrl: true, priority: true, status: true, description: true,
        sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
        createdAt: true, updatedAt: true,
        wishlist: {
          select: {
            owner: {
              select: {
                id: true, firstName: true, telegramChatId: true,
                profile: { select: { displayName: true, username: true, avatarUrl: true, avatarPublic: true } },
              },
            },
          },
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    // 2. Batch fetch read cursors
    const itemIds = items.map(i => i.id);
    const cursors = itemIds.length > 0
      ? await prisma.commentReadCursor.findMany({
          where: { userId: user.id, itemId: { in: itemIds } },
        })
      : [];
    const cursorMap = new Map(cursors.map(c => [c.itemId, c.lastReadAt]));

    // 3. Count unread comments per item
    const unreadCounts: Record<string, number> = {};
    if (itemIds.length > 0) {
      await Promise.all(itemIds.map(async (itemId) => {
        const lastRead = cursorMap.get(itemId);
        unreadCounts[itemId] = await prisma.comment.count({
          where: {
            itemId,
            type: 'USER',
            ...(lastRead ? { createdAt: { gt: lastRead } } : {}),
            NOT: { authorActorHash: actorHash },
          },
        });
      }));
    }

    // 4. Resolve owner names + avatars (batch-dedupe by ownerId)
    const uniqueOwners = new Map<string, typeof items[0]['wishlist']['owner']>();
    for (const item of items) {
      if (!uniqueOwners.has(item.wishlist.owner.id)) {
        uniqueOwners.set(item.wishlist.owner.id, item.wishlist.owner);
      }
    }
    const ownerNames = new Map<string, string>();
    const ownerAvatarUrls = new Map<string, string | null>();
    await Promise.all(
      [...uniqueOwners.entries()].map(async ([ownerId, owner]) => {
        ownerNames.set(ownerId, await resolveUserFirstName(owner, locale));
        const profile = owner.profile;
        ownerAvatarUrls.set(
          ownerId,
          (profile?.avatarPublic !== false && profile?.avatarUrl) ? profile.avatarUrl : null,
        );
      }),
    );

    // 5. Batch fetch ReservationMeta (always needed for smart res; Pro users get extra fields)
    type MetaEntry = { note: string | null; purchased: boolean; purchasedAt: string | null; reminderAt: string | null; reminderSent: boolean; reminderDates: string[] | null; expiresAt: string | null; extensionCount: number; isSmartRes: boolean; maxExtensions: number; canExtend: boolean; isExpiringSoon: boolean; isExpired: boolean };
    const metaMap = new Map<string, MetaEntry>();
    if (itemIds.length > 0) {
      const metas = await prisma.reservationMeta.findMany({
        where: { reserverUserId: user.id, itemId: { in: itemIds }, active: true },
      });
      for (const m of metas) {
        const derived = smartResDerive(m);
        metaMap.set(m.itemId, {
          note: resPro ? m.note : null,
          purchased: m.purchased,
          purchasedAt: m.purchasedAt?.toISOString() ?? null,
          reminderAt: resPro ? (m.reminderAt?.toISOString() ?? null) : null,
          reminderSent: resPro ? m.reminderSent : false,
          reminderDates: resPro ? ((m.reminderDates as string[] | null) ?? null) : null,
          expiresAt: m.expiresAt?.toISOString() ?? null,
          extensionCount: m.extensionCount,
          isSmartRes: m.isSmartRes,
          maxExtensions: m.smartResMaxExtensions ?? 0,
          ...derived,
        });
      }
    }

    // 6. Batch fetch groupGiftId for items that have an active group gift
    const ggMap = new Map<string, string>();
    if (itemIds.length > 0) {
      const ggs = await prisma.groupGift.findMany({
        where: { itemId: { in: itemIds }, status: 'OPEN' },
        select: { id: true, itemId: true },
      });
      for (const g of ggs) ggMap.set(g.itemId, g.id);
    }

    // 7. Fetch group gift participations (user is participant but NOT the item reserver)
    const ggParts = await prisma.groupGiftParticipant.findMany({
      where: { userId: user.id, groupGift: { status: 'OPEN' } },
      select: {
        groupGift: {
          select: {
            id: true,
            itemId: true,
            organizer: {
              select: {
                id: true, firstName: true, telegramChatId: true,
                profile: { select: { displayName: true, username: true, avatarUrl: true, avatarPublic: true } },
              },
            },
            item: {
              select: {
                id: true, wishlistId: true, title: true, url: true, priceText: true,
                imageUrl: true, priority: true, status: true, description: true,
                sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
                createdAt: true, updatedAt: true,
                wishlist: {
                  select: {
                    owner: {
                      select: {
                        id: true, firstName: true, telegramChatId: true,
                        profile: { select: { displayName: true, username: true, avatarUrl: true, avatarPublic: true } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    // Filter out items already in main reservations (organizer = reserver)
    const ggPartExtras = ggParts.filter(p => !itemIds.includes(p.groupGift.itemId));

    // Resolve organizer names for participant items
    const ggOrganizerNames = new Map<string, string>();
    await Promise.all(
      ggPartExtras.map(async (p) => {
        const org = p.groupGift.organizer;
        if (!ggOrganizerNames.has(org.id)) {
          ggOrganizerNames.set(org.id, await resolveUserFirstName(org, locale));
        }
      }),
    );

    // Resolve owner names for participant items
    for (const p of ggPartExtras) {
      const owner = p.groupGift.item.wishlist.owner;
      if (!ownerNames.has(owner.id)) {
        ownerNames.set(owner.id, await resolveUserFirstName(owner, locale));
        const profile = owner.profile;
        ownerAvatarUrls.set(
          owner.id,
          (profile?.avatarPublic !== false && profile?.avatarUrl) ? profile.avatarUrl : null,
        );
      }
    }

    // 8. Map response
    const reservations = items.map(item => ({
      ...mapTgItem(item),
      ownerName: ownerNames.get(item.wishlist.owner.id) ?? t('api_user_fallback', locale),
      ownerAvatarUrl: ownerAvatarUrls.get(item.wishlist.owner.id) ?? null,
      ownerId: item.wishlist.owner.id,
      unreadComments: unreadCounts[item.id] ?? 0,
      reservedAt: item.createdAt.toISOString(),
      meta: metaMap.get(item.id) ?? null,
      groupGiftId: ggMap.get(item.id) ?? null,
      groupGiftRole: (ggMap.has(item.id) ? 'organizer' : null) as 'organizer' | 'participant' | null,
      groupGiftOrganizerName: null as string | null,
    }));

    // Add participant group gift items
    for (const p of ggPartExtras) {
      const item = p.groupGift.item;
      const ownerId = item.wishlist.owner.id;
      reservations.push({
        ...mapTgItem(item),
        ownerName: ownerNames.get(ownerId) ?? t('api_user_fallback', locale),
        ownerAvatarUrl: ownerAvatarUrls.get(ownerId) ?? null,
        ownerId,
        unreadComments: 0,
        reservedAt: item.createdAt.toISOString(),
        meta: null,
        groupGiftId: p.groupGift.id,
        groupGiftRole: 'participant' as const,
        groupGiftOrganizerName: ggOrganizerNames.get(p.groupGift.organizer.id) ?? null,
      });
    }

    return res.json({ reservations, reservationPro: resPro, reservationBeta: isReservationBeta(user) });
  }),
);

// GET /tg/reservations/history — past reservations (completed, unreserved, archived)
tgRouter.get(
  '/reservations/history',
  asyncHandler(async (req, res) => {
    const locale = getRequestLocale(req);
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!hasReservationPro(user, ent.isPro, ent.addOns)) {
      return res.status(402).json({ error: 'Pro feature', feature: 'reservation_history' });
    }

    const metas = await prisma.reservationMeta.findMany({
      where: { reserverUserId: user.id, active: false },
      orderBy: { endedAt: 'desc' },
      take: 100,
      include: {
        item: {
          select: {
            id: true, title: true, url: true, priceText: true, imageUrl: true,
            priority: true, status: true, description: true, currency: true,
            sourceUrl: true, sourceDomain: true, importMethod: true,
            wishlist: {
              select: {
                owner: {
                  select: {
                    id: true, firstName: true, telegramChatId: true,
                    profile: { select: { displayName: true, username: true, avatarUrl: true, avatarPublic: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    // Resolve owner names
    const uniqueOwners = new Map<string, typeof metas[0]['item']['wishlist']['owner']>();
    for (const m of metas) {
      const owner = m.item.wishlist.owner;
      if (!uniqueOwners.has(owner.id)) uniqueOwners.set(owner.id, owner);
    }
    const ownerNames = new Map<string, string>();
    const ownerAvatarUrls = new Map<string, string | null>();
    await Promise.all(
      [...uniqueOwners.entries()].map(async ([ownerId, owner]) => {
        ownerNames.set(ownerId, await resolveUserFirstName(owner, locale));
        const profile = owner.profile;
        ownerAvatarUrls.set(ownerId, (profile?.avatarPublic !== false && profile?.avatarUrl) ? profile.avatarUrl : null);
      }),
    );

    const history = metas.map(m => ({
      ...mapTgItem(m.item as any),
      ownerName: ownerNames.get(m.item.wishlist.owner.id) ?? t('api_user_fallback', locale),
      ownerAvatarUrl: ownerAvatarUrls.get(m.item.wishlist.owner.id) ?? null,
      ownerId: m.item.wishlist.owner.id,
      endedAt: m.endedAt?.toISOString() ?? null,
      endReason: m.endReason,
      note: m.note,
      purchased: m.purchased,
    }));

    return res.json({ history });
  }),
);

// ═══════════════════════════════════════════════════════════════════════════
// Secret Reservations — owner is never notified. Privacy-isolated table.
// ═══════════════════════════════════════════════════════════════════════════

// GET /tg/secret-reservations — list all active secret reservations for current user
tgRouter.get(
  '/secret-reservations',
  asyncHandler(async (req, res) => {
    const locale = getRequestLocale(req);
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);

    const [rows, onboardingState] = await Promise.all([
      prisma.secretReservation.findMany({
        where: { reserverUserId: user.id, status: 'ACTIVE' },
        orderBy: { createdAt: 'desc' },
        include: {
          item: {
            select: {
              id: true, wishlistId: true, title: true, url: true, priceText: true,
              currency: true, imageUrl: true, description: true, priority: true,
              status: true, reserverUserId: true, archivedAt: true, updatedAt: true,
              sourceUrl: true, sourceDomain: true, importMethod: true,
              wishlist: {
                select: {
                  owner: {
                    select: {
                      id: true, firstName: true, telegramChatId: true,
                      profile: { select: { displayName: true, username: true, avatarUrl: true, avatarPublic: true } },
                    },
                  },
                },
              },
            },
          },
        },
      }),
      prisma.userOnboardingState.findUnique({
        where: { userId_onboardingKey_version: { userId: user.id, onboardingKey: 'secret_reservation', version: 1 } },
        select: { status: true },
      }),
    ]);
    const onboardingSeen = onboardingState?.status === 'COMPLETED' || onboardingState?.status === 'DISMISSED';

    // Resolve owner names + avatars
    const uniqueOwners = new Map<string, typeof rows[0]['item']['wishlist']['owner']>();
    for (const r of rows) {
      const owner = r.item.wishlist.owner;
      if (!uniqueOwners.has(owner.id)) uniqueOwners.set(owner.id, owner);
    }
    const ownerNames = new Map<string, string>();
    const ownerAvatarUrls = new Map<string, string | null>();
    const ownerUsernames = new Map<string, string | null>();
    await Promise.all(
      [...uniqueOwners.entries()].map(async ([ownerId, owner]) => {
        ownerNames.set(ownerId, await resolveUserFirstName(owner, locale));
        const profile = owner.profile;
        ownerAvatarUrls.set(ownerId, (profile?.avatarPublic !== false && profile?.avatarUrl) ? profile.avatarUrl : null);
        ownerUsernames.set(ownerId, profile?.username ?? null);
      }),
    );

    const secretReservations = rows.map(r => {
      const snap = r.snapshot as SecretReservationSnapshot;
      const derived = deriveSecretReservationState({
        snapshot: snap,
        reserverUserId: user.id,
        currentItem: {
          status: r.item.status,
          title: r.item.title,
          url: r.item.url ?? null,
          priceText: r.item.priceText,
          currency: r.item.currency,
          imageUrl: r.item.imageUrl,
          description: r.item.description,
          priority: r.item.priority,
          reserverUserId: r.item.reserverUserId,
          archivedAt: r.item.archivedAt,
        },
      });
      const ownerId = r.item.wishlist.owner.id;
      const hasUnacknowledgedUpdates = derived.state === 'ITEM_UPDATED'
        && (!r.updatesAcknowledgedAt || r.updatesAcknowledgedAt < r.item.updatedAt);
      return {
        id: r.id,
        itemId: r.itemId,
        wishlistId: r.item.wishlistId,
        snapshot: snap,
        current: mapTgItem(r.item as any),
        derivedState: derived.state,
        diffFields: derived.diffFields,
        hasUnacknowledgedUpdates,
        note: r.note,
        createdAt: r.createdAt.toISOString(),
        updatesAcknowledgedAt: r.updatesAcknowledgedAt?.toISOString() ?? null,
        ownerId,
        ownerName: ownerNames.get(ownerId) ?? t('api_user_fallback', locale),
        ownerAvatarUrl: ownerAvatarUrls.get(ownerId) ?? null,
        ownerUsername: ownerUsernames.get(ownerId) ?? null,
      };
    });

    return res.json({
      secretReservations,
      unlocked: ent.hasSecretReservations,
      priceXtr: ent.secretReservations.priceXtr,
      unlockType: ent.secretReservations.unlockType,
      onboardingSeen,
    });
  }),
);

// GET /tg/secret-reservations/:id — single detail with full diff for detail screen
tgRouter.get(
  '/secret-reservations/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const locale = getRequestLocale(req);
    const user = await getOrCreateTgUser(req.tgUser!);

    const row = await prisma.secretReservation.findUnique({
      where: { id },
      include: {
        item: {
          select: {
            id: true, wishlistId: true, title: true, url: true, priceText: true,
            currency: true, imageUrl: true, description: true, priority: true,
            status: true, reserverUserId: true, archivedAt: true,
            sourceUrl: true, sourceDomain: true, importMethod: true, updatedAt: true,
            wishlist: {
              select: {
                owner: {
                  select: {
                    id: true, firstName: true, telegramChatId: true,
                    profile: { select: { displayName: true, username: true, avatarUrl: true, avatarPublic: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.reserverUserId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const snap = row.snapshot as SecretReservationSnapshot;
    const derived = deriveSecretReservationState({
      snapshot: snap,
      reserverUserId: user.id,
      currentItem: {
        status: row.item.status,
        title: row.item.title,
        url: row.item.url ?? null,
        priceText: row.item.priceText,
        currency: row.item.currency,
        imageUrl: row.item.imageUrl,
        description: row.item.description,
        priority: row.item.priority,
        reserverUserId: row.item.reserverUserId,
        archivedAt: row.item.archivedAt,
      },
    });

    const owner = row.item.wishlist.owner;
    const ownerName = await resolveUserFirstName(owner, locale);
    const profile = owner.profile;
    const ownerAvatarUrl = (profile?.avatarPublic !== false && profile?.avatarUrl) ? profile.avatarUrl : null;
    const ownerUsername = profile?.username ?? null;

    const hasUnacknowledgedUpdates = derived.state === 'ITEM_UPDATED'
      && (!row.updatesAcknowledgedAt || row.updatesAcknowledgedAt < row.item.updatedAt);

    trackEvent('secret_res.item_open', user.id, { secretReservationId: id, derivedState: derived.state });

    return res.json({
      id: row.id,
      itemId: row.itemId,
      wishlistId: row.item.wishlistId,
      status: row.status,
      snapshot: snap,
      current: mapTgItem(row.item as any),
      derivedState: derived.state,
      diffFields: derived.diffFields,
      hasUnacknowledgedUpdates,
      note: row.note,
      createdAt: row.createdAt.toISOString(),
      updatesAcknowledgedAt: row.updatesAcknowledgedAt?.toISOString() ?? null,
      ownerId: owner.id,
      ownerName,
      ownerAvatarUrl,
      ownerUsername,
    });
  }),
);

// POST /tg/items/:id/secret-reserve — create a secret reservation
tgRouter.post(
  '/items/:id/secret-reserve',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const parsed = z.object({
      note: z.string().max(500).nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!requireSecretReservations(ent, res)) return;

    const item = await prisma.item.findUnique({
      where: { id },
      select: {
        id: true, title: true, url: true, priceText: true, currency: true,
        imageUrl: true, description: true, priority: true, status: true,
        archivedAt: true, wishlistId: true, wishlist: { select: { ownerId: true } },
      },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });

    // Can't secret-reserve your own item
    if (item.wishlist.ownerId === user.id) {
      trackEvent('secret_res.own_item_blocked', user.id, { itemId: id });
      return res.status(403).json({ error: 'own_item' });
    }
    if (item.archivedAt) return res.status(409).json({ error: 'item_unavailable' });

    // Idempotent: if user already has an active secret reservation for this item, return it
    const existing = await prisma.secretReservation.findUnique({
      where: { itemId_reserverUserId: { itemId: id, reserverUserId: user.id } },
    });
    if (existing) {
      if (existing.status === 'ACTIVE') {
        trackEvent('secret_res.duplicate_blocked', user.id, { itemId: id, secretReservationId: existing.id });
        return res.status(200).json({ id: existing.id, alreadyReserved: true });
      }
      // Re-activate a previously cancelled one
      const snapshot = buildSecretReservationSnapshot({
        title: item.title,
        url: item.url ?? null,
        priceText: item.priceText,
        currency: item.currency,
        imageUrl: item.imageUrl,
        description: item.description,
        priority: item.priority,
        status: item.status,
      });
      const reactivated = await prisma.secretReservation.update({
        where: { id: existing.id },
        data: {
          status: 'ACTIVE',
          snapshot: snapshot as any,
          note: parsed.data.note ?? null,
          cancelledAt: null,
          fulfilledAt: null,
          convertedAt: null,
          updatesAcknowledgedAt: null,
        },
      });
      trackEvent('secret_res.created', user.id, { itemId: id, secretReservationId: reactivated.id, reactivated: true });
      return res.json({ id: reactivated.id, alreadyReserved: false, reactivated: true });
    }

    const snapshot = buildSecretReservationSnapshot({
      title: item.title,
      url: item.url ?? null,
      priceText: item.priceText,
      currency: item.currency,
      imageUrl: item.imageUrl,
      description: item.description,
      priority: item.priority,
      status: item.status,
    });

    const created = await prisma.secretReservation.create({
      data: {
        itemId: id,
        reserverUserId: user.id,
        status: 'ACTIVE',
        snapshot: snapshot as any,
        note: parsed.data.note ?? null,
      },
    });

    trackEvent('secret_res.created', user.id, { itemId: id, secretReservationId: created.id });
    return res.json({ id: created.id, alreadyReserved: false });
  }),
);

// POST /tg/secret-reservations/:id/cancel — cancel (soft-delete)
tgRouter.post(
  '/secret-reservations/:id/cancel',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const row = await prisma.secretReservation.findUnique({ where: { id } });
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.reserverUserId !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (row.status !== 'ACTIVE') return res.status(409).json({ error: 'Not active' });

    await prisma.secretReservation.update({
      where: { id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });

    trackEvent('secret_res.cancelled', user.id, { secretReservationId: id, itemId: row.itemId });
    return res.json({ ok: true });
  }),
);

// POST /tg/secret-reservations/:id/acknowledge — mark updates as seen
tgRouter.post(
  '/secret-reservations/:id/acknowledge',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const row = await prisma.secretReservation.findUnique({
      where: { id },
      include: { item: { select: { status: true, title: true, url: true, priceText: true, currency: true, imageUrl: true, description: true, priority: true } } },
    });
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.reserverUserId !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (row.status !== 'ACTIVE') return res.status(409).json({ error: 'Not active' });

    // Update snapshot to the current item state + acknowledge timestamp
    const snapshot = buildSecretReservationSnapshot({
      title: row.item.title,
      url: row.item.url ?? null,
      priceText: row.item.priceText,
      currency: row.item.currency,
      imageUrl: row.item.imageUrl,
      description: row.item.description,
      priority: row.item.priority,
      status: row.item.status,
    });
    await prisma.secretReservation.update({
      where: { id },
      data: { snapshot: snapshot as any, updatesAcknowledgedAt: new Date() },
    });

    trackEvent('secret_res.update_ack', user.id, { secretReservationId: id, itemId: row.itemId });
    return res.json({ ok: true });
  }),
);

// POST /tg/secret-reservations/:id/promote — convert to public reservation (owner gets notified)
tgRouter.post(
  '/secret-reservations/:id/promote',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing id' });

    const parsed = z.object({
      displayName: z.string().min(1).max(64).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const tgUser = req.tgUser!;
    const actorHash = tgActorHash(tgUser.id);
    const displayName = parsed.data.displayName ?? tgUser.first_name;

    const user = await getOrCreateTgUser(tgUser);
    const row = await prisma.secretReservation.findUnique({
      where: { id },
      select: { id: true, itemId: true, reserverUserId: true, status: true },
    });
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (row.reserverUserId !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (row.status !== 'ACTIVE') return res.status(409).json({ error: 'Not active' });

    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.item.findUnique({
        where: { id: row.itemId },
        select: { status: true, reservationEpoch: true, wishlistId: true, title: true, archivedAt: true },
      });
      if (!item) return { kind: 'not_found' as const };
      if (item.archivedAt) return { kind: 'item_unavailable' as const };
      if (item.status !== 'AVAILABLE') return { kind: 'conflict' as const };

      // Mark secret reservation as converted
      await tx.secretReservation.update({
        where: { id },
        data: { status: 'CONVERTED_TO_PUBLIC', convertedAt: new Date() },
      });

      // Create public reservation (mirrors /items/:id/reserve logic, minus smart res + participant cap)
      const newEpoch = item.reservationEpoch + 1;
      await tx.item.update({
        where: { id: row.itemId },
        data: { status: 'RESERVED', reservationEpoch: newEpoch, reserverUserId: user.id },
      });
      await tx.reservationEvent.create({
        data: { itemId: row.itemId, type: 'RESERVED', actorHash, comment: displayName },
      });
      await tx.comment.create({
        data: { itemId: row.itemId, type: 'SYSTEM', text: t('api_system_reserved', getRequestLocale(req)), reservationEpoch: newEpoch },
      });
      await tx.comment.updateMany({
        where: { itemId: row.itemId, scheduledDeleteAt: { not: null } },
        data: { scheduledDeleteAt: null },
      });
      return { kind: 'ok' as const, wishlistId: item.wishlistId, title: item.title };
    });

    if (result.kind === 'not_found') return res.status(404).json({ error: 'Item not found' });
    if (result.kind === 'item_unavailable') return res.status(409).json({ error: 'item_unavailable' });
    if (result.kind === 'conflict') return res.status(409).json({ error: 'Item is not available' });

    // Notify owner (public reservation flow — owner now sees a reservation)
    const itemData = await prisma.item.findUnique({
      where: { id: row.itemId },
      select: { wishlist: { select: { ownerId: true } } },
    });
    if (itemData) {
      const owner = await prisma.user.findUnique({
        where: { id: itemData.wishlist.ownerId },
        select: { telegramChatId: true },
      });
      if (owner?.telegramChatId) {
        const notifLocale: Locale = 'ru';
        void sendTgNotification(owner.telegramChatId, t('notif_reserved', notifLocale, { name: displayName, title: result.title }));
      }
    }

    // Ensure ReservationMeta exists for the public flow
    void prisma.reservationMeta.upsert({
      where: { itemId_reserverUserId: { itemId: row.itemId, reserverUserId: user.id } },
      create: { itemId: row.itemId, reserverUserId: user.id },
      update: { active: true, endedAt: null, endReason: null },
    }).catch(() => {});

    trackEvent('secret_res.promoted_to_public', user.id, { secretReservationId: id, itemId: row.itemId });
    return res.json({ ok: true });
  }),
);

// POST /tg/secret-reservations/onboarding/seen — mark onboarding as seen (don't show again)
tgRouter.post(
  '/secret-reservations/onboarding/seen',
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      action: z.enum(['completed', 'dismissed']).default('completed'),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const now = new Date();
    const status = parsed.data.action === 'dismissed' ? 'DISMISSED' : 'COMPLETED';

    await prisma.userOnboardingState.upsert({
      where: { userId_onboardingKey_version: { userId: user.id, onboardingKey: 'secret_reservation', version: 1 } },
      create: {
        userId: user.id,
        onboardingKey: 'secret_reservation',
        version: 1,
        status,
        startedAt: now,
        completedAt: parsed.data.action === 'completed' ? now : null,
        dismissedAt: parsed.data.action === 'dismissed' ? now : null,
      },
      update: {
        status,
        completedAt: parsed.data.action === 'completed' ? now : undefined,
        dismissedAt: parsed.data.action === 'dismissed' ? now : undefined,
      },
    });

    trackEvent(parsed.data.action === 'dismissed' ? 'secret_res.onboarding_dismiss' : 'secret_res.onboarding_completed', user.id);
    return res.json({ ok: true });
  }),
);

// GET /tg/secret-reservations/onboarding/status — has user seen the onboarding?
tgRouter.get(
  '/secret-reservations/onboarding/status',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const state = await prisma.userOnboardingState.findUnique({
      where: { userId_onboardingKey_version: { userId: user.id, onboardingKey: 'secret_reservation', version: 1 } },
      select: { status: true },
    });
    return res.json({ seen: state?.status === 'COMPLETED' || state?.status === 'DISMISSED' });
  }),
);

// PATCH /tg/reservations/:itemId/meta — update private note / purchased flag
tgRouter.patch(
  '/reservations/:itemId/meta',
  asyncHandler(async (req, res) => {
    const itemId = req.params.itemId ?? '';
    if (!itemId) return res.status(400).json({ error: 'Missing itemId' });

    const parsed = z.object({
      note: z.string().max(500).nullable().optional(),
      purchased: z.boolean().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!hasReservationPro(user, ent.isPro, ent.addOns)) {
      return res.status(402).json({ error: 'Pro feature', feature: 'reservation_meta' });
    }

    // Verify user actually has this item reserved
    const item = await prisma.item.findUnique({ where: { id: itemId }, select: { reserverUserId: true, status: true } });
    if (!item || item.reserverUserId !== user.id || item.status !== 'RESERVED') {
      return res.status(404).json({ error: 'Active reservation not found' });
    }

    const data: Record<string, unknown> = {};
    if (parsed.data.note !== undefined) data.note = parsed.data.note;
    if (parsed.data.purchased !== undefined) {
      data.purchased = parsed.data.purchased;
      data.purchasedAt = parsed.data.purchased ? new Date() : null;
    }

    const meta = await prisma.reservationMeta.upsert({
      where: { itemId_reserverUserId: { itemId, reserverUserId: user.id } },
      create: { itemId, reserverUserId: user.id, ...data },
      update: data,
    });

    return res.json({
      meta: {
        note: meta.note,
        purchased: meta.purchased,
        purchasedAt: meta.purchasedAt?.toISOString() ?? null,
        reminderAt: meta.reminderAt?.toISOString() ?? null,
        reminderSent: meta.reminderSent,
      },
    });
  }),
);

// POST /tg/reservations/:itemId/reminder — set reminder dates (supports multiple)
tgRouter.post(
  '/reservations/:itemId/reminder',
  asyncHandler(async (req, res) => {
    const itemId = req.params.itemId ?? '';
    if (!itemId) return res.status(400).json({ error: 'Missing itemId' });

    // Accept both legacy single `reminderAt` and new `reminderDates` array
    const parsed = z.object({
      reminderAt: z.string().datetime().optional(),
      reminderDates: z.array(z.string().datetime()).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!hasReservationPro(user, ent.isPro, ent.addOns)) {
      return res.status(402).json({ error: 'Pro feature', feature: 'reservation_reminder' });
    }

    const item = await prisma.item.findUnique({ where: { id: itemId }, select: { reserverUserId: true, status: true } });
    if (!item || item.reserverUserId !== user.id || item.status !== 'RESERVED') {
      return res.status(404).json({ error: 'Active reservation not found' });
    }

    // Build the list of dates
    const now = Date.now();
    let allDates: string[] = [];
    if (parsed.data.reminderDates && parsed.data.reminderDates.length > 0) {
      allDates = parsed.data.reminderDates.filter(d => new Date(d).getTime() > now);
    } else if (parsed.data.reminderAt) {
      const dt = new Date(parsed.data.reminderAt);
      if (dt.getTime() > now) allDates = [dt.toISOString()];
    }
    if (allDates.length === 0) {
      return res.status(400).json({ error: 'At least one reminder must be in the future' });
    }

    // Sort and pick the nearest as reminderAt
    allDates.sort();
    const nearestDate = new Date(allDates[0]!);

    const meta = await prisma.reservationMeta.upsert({
      where: { itemId_reserverUserId: { itemId, reserverUserId: user.id } },
      create: { itemId, reserverUserId: user.id, reminderAt: nearestDate, reminderSent: false, reminderDates: allDates },
      update: { reminderAt: nearestDate, reminderSent: false, reminderDates: allDates },
    });

    const storedDates = (meta.reminderDates as string[] | null) ?? null;
    return res.json({ reminderAt: meta.reminderAt?.toISOString() ?? null, reminderDates: storedDates });
  }),
);

// DELETE /tg/reservations/:itemId/reminder — remove a reminder
tgRouter.delete(
  '/reservations/:itemId/reminder',
  asyncHandler(async (req, res) => {
    const itemId = req.params.itemId ?? '';
    if (!itemId) return res.status(400).json({ error: 'Missing itemId' });

    const user = await getOrCreateTgUser(req.tgUser!);

    await prisma.reservationMeta.updateMany({
      where: { itemId, reserverUserId: user.id },
      data: { reminderAt: null, reminderSent: false, reminderDates: [] },
    });

    return res.json({ ok: true });
  }),
);

// GET /tg/santa/my-reservations — Santa items reserved by the current user (giver view)
// Excludes: campaign CANCELLED, assignment giftStatus RECEIVED or ORPHANED (both terminal).
// SELECTED_OUTSIDE already deletes SantaItemReservation rows in the status-change handler,
// so those never appear here naturally.
tgRouter.get('/santa/my-reservations', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);

  const rows = await prisma.santaItemReservation.findMany({
    where: {
      assignment: {
        giver: { userId: user.id },
        giftStatus: { notIn: ['RECEIVED', 'ORPHANED'] },
        round: { campaign: { status: { not: 'CANCELLED' } } },
      },
    },
    select: {
      assignmentId: true,
      item: {
        select: {
          id: true, wishlistId: true, title: true, url: true, priceText: true,
          imageUrl: true, priority: true, status: true, description: true,
          sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
        },
      },
      assignment: {
        select: {
          id: true,
          giftStatus: true,
          round: {
            select: {
              campaign: { select: { id: true, title: true, status: true } },
            },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  const reservations = rows.map(r => ({
    ...mapTgItem(r.item),
    campaignId: r.assignment.round.campaign.id,
    campaignTitle: r.assignment.round.campaign.title,
    campaignStatus: r.assignment.round.campaign.status,
    giftStatus: r.assignment.giftStatus,
    assignmentId: r.assignmentId,
  }));

  return res.json({ reservations });
}));

// POST /tg/wishlists/:id/share-token — get or create share token for a wishlist (owner only)
tgRouter.post(
  '/wishlists/:id/share-token',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({
      where: { id },
      select: { id: true, ownerId: true, shareToken: true },
    });
    if (!wishlist || wishlist.ownerId !== user.id) {
      return res.status(404).json({ error: 'Wishlist not found' });
    }

    if (wishlist.shareToken) {
      return res.json({ shareToken: wishlist.shareToken });
    }

    const token = await generateUniqueShareToken();
    const updated = await prisma.wishlist.update({
      where: { id },
      data: { shareToken: token },
      select: { shareToken: true },
    });
    trackAnalyticsEvent({ event: 'share.token_generated', userId: String(req.tgUser!.id), props: { wishlistId: req.params.id } });

    return res.json({ shareToken: updated.shareToken });
  }),
);

// DELETE /tg/wishlists/:id/share-token — revoke share token (owner only)
tgRouter.delete(
  '/wishlists/:id/share-token',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({
      where: { id },
      select: { id: true, ownerId: true, shareToken: true },
    });
    if (!wishlist || wishlist.ownerId !== user.id) {
      return res.status(404).json({ error: 'Wishlist not found' });
    }

    if (wishlist.shareToken) {
      await prisma.wishlist.update({ where: { id }, data: { shareToken: null } });
      trackEvent('share_token_revoked', user.id, { wishlistId: id });
    }

    return res.json({ ok: true });
  }),
);

// ── Curated Selections ────────────────────────────────────────────────────

async function generateUniqueCuratedToken(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const token = crypto.randomBytes(9).toString('base64url');
    const existing = await prisma.curatedSelection.findUnique({ where: { shareToken: token } });
    if (!existing) return token;
  }
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

// POST /tg/wishlists/:id/selections — create a curated selection (Pro-gated)
tgRouter.post(
  '/wishlists/:id/selections',
  asyncHandler(async (req, res) => {
    const wishlistId = req.params.id ?? '';
    if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });

    const parsed = z.object({
      title: z.string().min(1).max(100),
      itemIds: z.array(z.string()).min(1).max(200),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!ent.isPro) {
      trackEvent('feature_gate_hit_curated_selection', user.id, { plan: ent.plan.code });
      return res.status(402).json({ error: 'Pro required', planCode: ent.plan.code });
    }

    const wishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId }, select: { ownerId: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const items = await prisma.item.findMany({
      where: { id: { in: parsed.data.itemIds }, wishlistId, status: { in: ['AVAILABLE', 'RESERVED', 'PURCHASED'] } },
      select: { id: true, title: true, priceText: true, currency: true, imageUrl: true, url: true, description: true },
    });
    if (items.length === 0) return res.status(400).json({ error: 'No valid items' });

    const shareToken = await generateUniqueCuratedToken();
    const expiresAt = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000);

    // Preserve order from request
    const idOrder = new Map(parsed.data.itemIds.map((id, i) => [id, i]));
    const orderedItems = items.sort((a, b) => (idOrder.get(a.id) ?? 999) - (idOrder.get(b.id) ?? 999));

    const selection = await prisma.curatedSelection.create({
      data: {
        wishlistId,
        ownerId: user.id,
        title: parsed.data.title.trim(),
        shareToken,
        expiresAt,
        items: {
          create: orderedItems.map((item, idx) => ({
            originalItemId: item.id,
            position: idx,
            title: item.title,
            priceText: item.priceText,
            currency: item.currency,
            imageUrl: item.imageUrl,
            url: item.url,
            description: item.description,
          })),
        },
      },
      select: { id: true, shareToken: true, title: true, expiresAt: true, _count: { select: { items: true } } },
    });

    trackEvent('selection_created', user.id, { wishlistId, selectionId: selection.id, itemCount: selection._count.items });

    return res.json({
      selection: {
        id: selection.id,
        shareToken: selection.shareToken,
        title: selection.title,
        itemCount: selection._count.items,
        expiresAt: selection.expiresAt,
      },
    });
  }),
);

// GET /tg/wishlists/:id/selections — list curated selections for a wishlist (owner only)
tgRouter.get(
  '/wishlists/:id/selections',
  asyncHandler(async (req, res) => {
    const wishlistId = req.params.id ?? '';
    if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId }, select: { ownerId: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const selections = await prisma.curatedSelection.findMany({
      where: { wishlistId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, shareToken: true, title: true, viewCount: true,
        deactivatedAt: true, expiresAt: true, createdAt: true,
        _count: { select: { items: true, subscriptions: true } },
      },
    });

    return res.json({
      selections: selections.map(s => ({
        id: s.id,
        shareToken: s.shareToken,
        title: s.title,
        itemCount: s._count.items,
        viewCount: s.viewCount,
        subscriberCount: s._count.subscriptions,
        isActive: !s.deactivatedAt && s.expiresAt > new Date(),
        expiresAt: s.expiresAt,
        createdAt: s.createdAt,
      })),
    });
  }),
);

// DELETE /tg/selections/:id — deactivate a curated selection
tgRouter.delete(
  '/selections/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing selection id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const selection = await prisma.curatedSelection.findUnique({ where: { id }, select: { ownerId: true } });
    if (!selection) return res.status(404).json({ error: 'Selection not found' });
    if (selection.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    await prisma.curatedSelection.update({ where: { id }, data: { deactivatedAt: new Date() } });
    trackEvent('selection_deactivated', user.id, { selectionId: id });

    return res.json({ ok: true });
  }),
);

// POST /tg/selections/:id/subscribe — subscribe to a curated selection
tgRouter.post(
  '/selections/:id/subscribe',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing selection id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const selection = await prisma.curatedSelection.findUnique({
      where: { id },
      select: { id: true, ownerId: true, deactivatedAt: true, expiresAt: true },
    });
    if (!selection) return res.status(404).json({ error: 'Selection not found' });
    if (selection.ownerId === user.id) return res.status(400).json({ error: 'Cannot subscribe to own selection' });
    if (selection.deactivatedAt || selection.expiresAt < new Date()) {
      return res.status(410).json({ error: 'Selection expired' });
    }

    await prisma.curatedSelectionSubscription.upsert({
      where: { curatedSelectionId_subscriberId: { curatedSelectionId: id, subscriberId: user.id } },
      update: {},
      create: { curatedSelectionId: id, subscriberId: user.id },
    });

    trackEvent('selection_subscribed', user.id, { selectionId: id });
    return res.json({ ok: true, subscribed: true });
  }),
);

// DELETE /tg/selections/:id/subscribe — unsubscribe from a curated selection
tgRouter.delete(
  '/selections/:id/subscribe',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing selection id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    await prisma.curatedSelectionSubscription.deleteMany({
      where: { curatedSelectionId: id, subscriberId: user.id },
    });

    trackEvent('selection_unsubscribed', user.id, { selectionId: id });
    return res.json({ ok: true, subscribed: false });
  }),
);

// GET /tg/selections/:id/subscribe — check subscription status
tgRouter.get(
  '/selections/:id/subscribe',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing selection id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const sub = await prisma.curatedSelectionSubscription.findUnique({
      where: { curatedSelectionId_subscriberId: { curatedSelectionId: id, subscriberId: user.id } },
      select: { id: true },
    });

    return res.json({ subscribed: !!sub });
  }),
);

// GET /tg/selections/by-token/:token — authenticated curated selection view (includes isSubscribed + isOwner)
tgRouter.get(
  '/selections/by-token/:token',
  asyncHandler(async (req, res) => {
    const token = req.params.token ?? '';
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const selection = await prisma.curatedSelection.findUnique({
      where: { shareToken: token },
      select: {
        id: true, title: true, ownerId: true, expiresAt: true, deactivatedAt: true,
        owner: { select: { firstName: true, profile: { select: { displayName: true } } } },
        items: { orderBy: { position: 'asc' }, select: { id: true, title: true, priceText: true, currency: true, imageUrl: true, url: true, description: true, position: true } },
      },
    });
    if (!selection) return res.status(404).json({ error: 'Selection not found' });

    const expired = !!selection.deactivatedAt || selection.expiresAt < new Date();
    if (expired) {
      return res.status(410).json({ error: 'expired', expiresAt: selection.expiresAt });
    }

    const isOwner = selection.ownerId === user.id;
    let isSubscribed = false;
    if (!isOwner) {
      const sub = await prisma.curatedSelectionSubscription.findUnique({
        where: { curatedSelectionId_subscriberId: { curatedSelectionId: selection.id, subscriberId: user.id } },
        select: { id: true },
      });
      isSubscribed = !!sub;
    }

    // Track view — fire-and-forget
    prisma.curatedSelection.update({ where: { shareToken: token }, data: { viewCount: { increment: 1 } } }).catch(() => {});
    trackEvent('selection_viewed', user.id, { selectionId: selection.id });

    const ownerName = selection.owner.profile?.displayName || selection.owner.firstName || null;

    return res.json({
      selection: {
        id: selection.id,
        title: selection.title,
        itemCount: selection.items.length,
        expiresAt: selection.expiresAt,
        ownerName,
        isOwner,
        isSubscribed,
        items: selection.items,
      },
    });
  }),
);

// GET /tg/selections/subscribed — list subscribed curated selections
tgRouter.get(
  '/selections/subscribed',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const subs = await prisma.curatedSelectionSubscription.findMany({
      where: { subscriberId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        createdAt: true,
        curatedSelection: {
          select: {
            id: true, shareToken: true, title: true, expiresAt: true,
            deactivatedAt: true, createdAt: true,
            owner: { select: { firstName: true, profile: { select: { displayName: true } } } },
            _count: { select: { items: true } },
          },
        },
      },
    });

    const selections = subs
      .filter(s => !s.curatedSelection.deactivatedAt && s.curatedSelection.expiresAt > new Date())
      .map(s => ({
        id: s.curatedSelection.id,
        shareToken: s.curatedSelection.shareToken,
        title: s.curatedSelection.title,
        itemCount: s.curatedSelection._count.items,
        ownerName: s.curatedSelection.owner.profile?.displayName || s.curatedSelection.owner.firstName || null,
        expiresAt: s.curatedSelection.expiresAt,
        subscribedAt: s.createdAt,
      }));

    return res.json({ selections });
  }),
);

// POST /tg/wishlists/reorder — update wishlist positions (owner only)
tgRouter.post(
  '/wishlists/reorder',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({ orderedIds: z.array(z.string()).min(1).max(200) })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const { orderedIds } = parsed.data;

    // Verify all IDs belong to this user and are REGULAR non-archived wishlists
    const wishlists = await prisma.wishlist.findMany({
      where: { ownerId: user.id, type: 'REGULAR', archivedAt: null, id: { in: orderedIds } },
      select: { id: true },
    });
    if (wishlists.length !== orderedIds.length) {
      return res.status(400).json({ error: 'Some wishlist IDs are invalid or not owned by you' });
    }

    // Transactionally assign positions based on orderedIds index
    await prisma.$transaction(
      orderedIds.map((id, idx) =>
        prisma.wishlist.update({ where: { id }, data: { position: idx } }),
      ),
    );

    return res.json({ ok: true });
  }),
);

// POST /tg/wishlists — create wishlist
tgRouter.post(
  '/wishlists',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        title: z.string().min(1).max(200),
        deadline: z.string().datetime().nullable().optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id);
    const count = await prisma.wishlist.count({ where: { ownerId: user.id, type: 'REGULAR', archivedAt: null } });
    if (count >= ent.effectiveWishlistLimit) {
      trackEvent('feature_gate_hit_wishlist_limit', user.id, { plan: ent.plan.code, count, limit: ent.effectiveWishlistLimit });
      return res.status(402).json({ error: 'Plan limit reached', limit: ent.effectiveWishlistLimit, planCode: ent.plan.code });
    }

    // Determine insert position + inherit privacy defaults from profile
    const profile = await prisma.userProfile.findUnique({ where: { userId: user.id }, select: { newWishlistPosition: true, commentsEnabled: true } });
    // "top" is a PRO feature — FREE users always append to bottom regardless of stored value
    const addToTop = ent.isPro && profile?.newWishlistPosition === 'top';

    let newPosition: number;
    if (addToTop) {
      // Shift all existing REGULAR non-archived wishlists up by 1, then insert at 0
      await prisma.wishlist.updateMany({
        where: { ownerId: user.id, type: 'REGULAR', archivedAt: null },
        data: { position: { increment: 1 } },
      });
      newPosition = 0;
    } else {
      // Append at the end
      const maxResult = await prisma.wishlist.aggregate({
        where: { ownerId: user.id, type: 'REGULAR', archivedAt: null },
        _max: { position: true },
      });
      newPosition = (maxResult._max.position ?? -1) + 1;
    }

    const slug = await generateUniqueSlug(parsed.data.title);
    // Inherit commentPolicy from profile default: commentsEnabled=false → SUBSCRIBERS, else ALL
    const inheritedCommentPolicy = profile?.commentsEnabled === false ? 'SUBSCRIBERS' : 'ALL';
    const wishlist = await prisma.wishlist.create({
      data: {
        slug,
        ownerId: user.id,
        title: parsed.data.title,
        deadline: parsed.data.deadline ? new Date(parsed.data.deadline) : null,
        position: newPosition,
        commentPolicy: inheritedCommentPolicy,
      },
      select: { id: true, slug: true, title: true, description: true, deadline: true },
    });

    // Canonical analytics: wishlist_created
    const existingRegular = await prisma.wishlist.count({ where: { ownerId: user.id, type: 'REGULAR' } });
    const existingAny = await prisma.wishlist.count({ where: { ownerId: user.id } });
    trackEvent('wishlist_created', user.id, {
      wishlistId: wishlist.id, wishlistType: 'REGULAR', source: 'manual',
      platform: 'miniapp',
      isFirstRegularWishlist: existingRegular === 1,
      isFirstAnyWishlist: existingAny === 1,
    });
    if (existingRegular === 1) trackEvent('first_regular_wishlist_created', user.id, { wishlistId: wishlist.id, source: 'manual', platform: 'miniapp' });

    trackAnalyticsEvent({ event: 'wishlist.created', userId: user.id, props: { source: 'miniapp' } });

    // Referral: mark firstWishlist milestone + drive qualify/reward pipeline
    // if this user was referred. Fire-and-forget; never blocks the response.
    void runReferralProgressHook(user.id, 'first_wishlist');

    return res.status(201).json({
      wishlist: { ...wishlist, deadline: wishlist.deadline?.toISOString() ?? null, itemCount: 0, reservedCount: 0 },
    });
  }),
);

// PATCH /tg/wishlists/:id — update wishlist (title, deadline, privacy settings)
tgRouter.patch(
  '/wishlists/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing wishlist id' });

    const parsed = z
      .object({
        title: z.string().min(1).max(200).optional(),
        // Single-grapheme emoji override for the wishlist hero. `null` clears
        // back to the auto-pick. Server-side guard: reject anything that
        // doesn't contain at least one Extended_Pictographic codepoint or a
        // regional-indicator pair (flags). The frontend already strips
        // letters/digits but the API stays defensive.
        emoji: z.string().max(16).nullable().optional().refine(
          (v) => v == null || v === '' || /\p{Extended_Pictographic}|\p{Regional_Indicator}{2}/u.test(v),
          { message: 'emoji must contain a pictographic codepoint or flag' },
        ),
        deadline: z.string().datetime().nullable().optional(),
        visibility: z.enum(['LINK_ONLY', 'PUBLIC_PROFILE', 'PRIVATE']).optional(),
        allowSubscriptions: z.enum(['ALL', 'NOBODY']).optional(),
        commentPolicy: z.enum(['ALL', 'SUBSCRIBERS']).optional(),
        dontGiftMode: z.enum(['global', 'local', 'hidden']).optional(),
        smartReservationsEnabled: z.boolean().optional(),
        smartResTtlHours: z.union([z.literal(24), z.literal(48), z.literal(72), z.literal(168)]).optional(),
        smartResAllowExtend: z.boolean().optional(),
        smartResMaxExtensions: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    const isPro = ent.plan.code !== 'FREE';

    const wishlist = await prisma.wishlist.findUnique({ where: { id }, select: { ownerId: true, title: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // PRO-gate advanced visibility modes
    if (!isPro && (parsed.data.visibility === 'PUBLIC_PROFILE' || parsed.data.visibility === 'PRIVATE')) {
      return res.status(403).json({ error: 'pro_required', message: 'Upgrade to Pro to use this visibility setting' });
    }
    if (!isPro && parsed.data.allowSubscriptions === 'NOBODY') {
      return res.status(403).json({ error: 'pro_required', message: 'Upgrade to Pro to restrict subscriptions' });
    }
    if (!isPro && parsed.data.commentPolicy === 'SUBSCRIBERS') {
      return res.status(403).json({ error: 'pro_required', message: 'Upgrade to Pro to restrict comments' });
    }
    // PRO-gate dontGiftMode changes (except "global" which is the default)
    if (!isPro && parsed.data.dontGiftMode && parsed.data.dontGiftMode !== 'global') {
      return res.status(402).json({ error: 'Pro required', planCode: ent.plan.code });
    }
    // Smart Reservations gate: owner must have entitlement (PRO or per-wishlist add-on)
    const hasSmartResFields = parsed.data.smartReservationsEnabled !== undefined ||
      parsed.data.smartResTtlHours !== undefined || parsed.data.smartResAllowExtend !== undefined ||
      parsed.data.smartResMaxExtensions !== undefined;
    if (hasSmartResFields && !hasSmartReservations({ godMode: user.godMode }, isPro, ent.addOns, id)) {
      return res.status(402).json({ error: 'smart_reservations_required' });
    }

    // Detect which subscriber-visible fields are changing
    const wlChangedFields: string[] = [];
    if (parsed.data.title !== undefined) wlChangedFields.push('wishlist_title');
    if (parsed.data.deadline !== undefined) wlChangedFields.push('wishlist_deadline');

    const updated = await prisma.wishlist.update({
      where: { id },
      data: {
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.emoji !== undefined
          ? {
              emoji: (() => {
                const raw = parsed.data.emoji?.trim();
                if (!raw) return null;
                // Use Intl.Segmenter to extract the first grapheme cluster
                // (handles ZWJ sequences, skin-tone modifiers, flag pairs).
                // Persist only that single grapheme even if the client somehow
                // sent multiple emoji concatenated.
                try {
                  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
                  for (const { segment } of seg.segment(raw)) {
                    if (/\p{Extended_Pictographic}|\p{Regional_Indicator}{2}/u.test(segment)) {
                      return segment;
                    }
                  }
                } catch { /* fallback below */ }
                return raw;
              })(),
            }
          : {}),
        ...(parsed.data.deadline !== undefined
          ? { deadline: parsed.data.deadline ? new Date(parsed.data.deadline) : null }
          : {}),
        ...(parsed.data.visibility !== undefined ? { visibility: parsed.data.visibility } : {}),
        ...(parsed.data.allowSubscriptions !== undefined ? { allowSubscriptions: parsed.data.allowSubscriptions } : {}),
        ...(parsed.data.commentPolicy !== undefined ? { commentPolicy: parsed.data.commentPolicy } : {}),
        ...(parsed.data.dontGiftMode !== undefined ? { dontGiftMode: parsed.data.dontGiftMode } : {}),
        ...(parsed.data.smartReservationsEnabled !== undefined ? { smartReservationsEnabled: parsed.data.smartReservationsEnabled } : {}),
        ...(parsed.data.smartResTtlHours !== undefined ? { smartResTtlHours: parsed.data.smartResTtlHours } : {}),
        ...(parsed.data.smartResAllowExtend !== undefined ? { smartResAllowExtend: parsed.data.smartResAllowExtend } : {}),
        ...(parsed.data.smartResMaxExtensions !== undefined ? { smartResMaxExtensions: parsed.data.smartResMaxExtensions } : {}),
      },
      select: {
        id: true, slug: true, title: true, emoji: true, description: true, deadline: true,
        visibility: true, allowSubscriptions: true, commentPolicy: true, dontGiftMode: true,
        smartReservationsEnabled: true, smartResTtlHours: true, smartResAllowExtend: true, smartResMaxExtensions: true,
      },
    });

    if (parsed.data.dontGiftMode !== undefined) {
      trackEvent('wishlist_do_not_gift_mode_changed', user.id, { wishlistId: id, mode: parsed.data.dontGiftMode });
    }

    // Notify subscribers of wishlist-level change
    if (wlChangedFields.length > 0) {
      void notifySubscribersOfChange(
        id,
        id,
        wlChangedFields,
        'wishlist_updated',
        { wishlistTitle: updated.title },
      );
    }

    return res.json({
      wishlist: {
        ...updated,
        emoji: updated.emoji ?? null,
        deadline: updated.deadline?.toISOString() ?? null,
        visibility: (updated.visibility as string).toLowerCase(),
        allowSubscriptions: (updated.allowSubscriptions as string).toLowerCase(),
        commentPolicy: (updated.commentPolicy as string).toLowerCase(),
        dontGiftMode: updated.dontGiftMode,
        smartReservationsEnabled: updated.smartReservationsEnabled,
        smartResTtlHours: updated.smartResTtlHours,
        smartResAllowExtend: updated.smartResAllowExtend,
        smartResMaxExtensions: updated.smartResMaxExtensions,
      },
    });
  }),
);

// DELETE /tg/wishlists/:id — delete wishlist
tgRouter.delete(
  '/wishlists/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({ where: { id }, select: { ownerId: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // Block deletion if wishlist is linked to an active Santa campaign
    const activeSantaLink = await prisma.santaParticipant.findFirst({
      where: { linkedWishlistId: id, campaign: { status: { notIn: ['COMPLETED', 'CANCELLED'] } } },
      include: { campaign: { select: { title: true } } },
    });
    if (activeSantaLink) {
      return res.status(409).json({ error: 'wishlist_in_santa_campaign', campaignTitle: activeSantaLink.campaign.title });
    }

    // Preserve shared wishes placed elsewhere before cascade-deleting this wishlist.
    await reassignPrimaryBeforeWishlistDelete(id);

    await prisma.wishlist.delete({ where: { id } });
    trackAnalyticsEvent({ event: 'wishlist.deleted', userId: String(req.tgUser!.id), props: { wishlistId: req.params.id } });

    // Repack positions for remaining REGULAR non-archived wishlists to keep them contiguous
    const remaining = await prisma.wishlist.findMany({
      where: { ownerId: user.id, type: 'REGULAR', archivedAt: null },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
    });
    if (remaining.length > 0) {
      await prisma.$transaction(
        remaining.map((wl, idx) =>
          prisma.wishlist.update({ where: { id: wl.id }, data: { position: idx } }),
        ),
      );
    }

    return res.json({ ok: true });
  }),
);

// POST /tg/wishlists/:id/transfer-items — move RESERVED items to another wishlist before deletion
tgRouter.post(
  '/wishlists/:id/transfer-items',
  asyncHandler(async (req, res) => {
    const sourceId = req.params.id ?? '';
    if (!sourceId) return res.status(400).json({ error: 'Missing wishlist id' });

    const parsed = z
      .object({ targetWishlistId: z.string().min(1) })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const { targetWishlistId } = parsed.data;
    if (targetWishlistId === sourceId) {
      return res.status(400).json({ error: 'Source and target must be different' });
    }

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getUserEntitlement(user.id, user.godMode);

    // Verify ownership of both wishlists
    const [source, target] = await Promise.all([
      prisma.wishlist.findUnique({ where: { id: sourceId }, select: { ownerId: true, title: true } }),
      prisma.wishlist.findUnique({ where: { id: targetWishlistId }, select: { ownerId: true, title: true, archivedAt: true } }),
    ]);
    if (!source) return res.status(404).json({ error: 'Source wishlist not found' });
    if (source.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (!target) return res.status(404).json({ error: 'Target wishlist not found' });
    if (target.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (target.archivedAt) return res.status(409).json({ error: 'target_archived', message: 'Target wishlist is archived' });

    // Get reserved items whose PRIMARY is the source (items this wishlist owns).
    // Items that are also placed elsewhere will reassign via reassignPrimaryBeforeWishlistDelete,
    // so transfer only needs to rescue items that are genuinely homed here.
    const reservedItems = await prisma.item.findMany({
      where: { wishlistId: sourceId, status: 'RESERVED' },
      select: { id: true },
    });
    if (reservedItems.length === 0) {
      return res.json({ transferred: 0, targetWishlistId, targetTitle: target.title });
    }

    // Target capacity via PLACEMENT count. Items already placed in target (shared)
    // don't consume a new slot — exclude them from the capacity math.
    const existingInTarget = await prisma.wishlistItemPlacement.findMany({
      where: { wishlistId: targetWishlistId, itemId: { in: reservedItems.map((i) => i.id) } },
      select: { itemId: true },
    });
    const alreadyInTarget = new Set(existingInTarget.map((p) => p.itemId));
    const needNewSlot = reservedItems.filter((i) => !alreadyInTarget.has(i.id));

    const targetActiveCount = await countActivePlacementsInWishlist(targetWishlistId);
    const available = ent.plan.items - targetActiveCount;
    if (available < needNewSlot.length) {
      return res.status(409).json({
        error: 'insufficient_capacity',
        message: `Target wishlist can accept ${available} more items but ${needNewSlot.length} items need to be transferred`,
        available,
        needed: needNewSlot.length,
      });
    }

    // Migrate each item: delete source placement, upsert target placement, sync legacy Item.wishlistId.
    for (const item of reservedItems) {
      await relocateItemPrimary(item.id, sourceId, targetWishlistId);
    }

    return res.json({ transferred: reservedItems.length, targetWishlistId, targetTitle: target.title });
  }),
);

// POST /tg/wishlists/:id/archive — soft-archive a wishlist (owner only)
tgRouter.post(
  '/wishlists/:id/archive',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({ where: { id }, select: { ownerId: true, archivedAt: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (wishlist.archivedAt) return res.status(409).json({ error: 'Already archived' });

    // Block archiving if wishlist is linked to an active Santa campaign
    const activeSantaLink = await prisma.santaParticipant.findFirst({
      where: { linkedWishlistId: id, campaign: { status: { notIn: ['COMPLETED', 'CANCELLED'] } } },
      include: { campaign: { select: { title: true } } },
    });
    if (activeSantaLink) {
      return res.status(409).json({ error: 'wishlist_in_santa_campaign', campaignTitle: activeSantaLink.campaign.title });
    }

    await prisma.wishlist.update({ where: { id }, data: { archivedAt: new Date() } });
    return res.json({ ok: true });
  }),
);

// POST /tg/wishlists/:id/unarchive — restore a soft-archived wishlist (owner only)
tgRouter.post(
  '/wishlists/:id/unarchive',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({ where: { id }, select: { ownerId: true, archivedAt: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    await prisma.wishlist.update({ where: { id }, data: { archivedAt: null } });
    return res.json({ ok: true });
  }),
);

// POST /tg/wishlists/:id/subscribe — subscribe to a wishlist (non-owner only)
tgRouter.post(
  '/wishlists/:id/subscribe',
  asyncHandler(async (req, res) => {
    const wishlistId = req.params.id ?? '';
    if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({
      where: { id: wishlistId },
      select: { ownerId: true, title: true, shareToken: true, archivedAt: true, allowSubscriptions: true },
    });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId === user.id) return res.status(400).json({ error: 'Cannot subscribe to your own wishlist' });

    // Check wishlist-level allowSubscriptions override
    if (wishlist.allowSubscriptions === 'NOBODY') {
      return res.status(403).json({ error: 'subscriptions_closed' });
    }

    // Check owner's global subscribePolicy
    const ownerProfile = await prisma.userProfile.findUnique({
      where: { userId: wishlist.ownerId },
      select: { subscribePolicy: true },
    });
    if (ownerProfile?.subscribePolicy === 'NOBODY') {
      return res.status(403).json({ error: 'subscriptions_closed' });
    }

    // Check effective subscription limit (base plan + any purchased extra slots)
    const ent = await getEffectiveEntitlements(user.id);
    const currentCount = await prisma.wishlistSubscription.count({ where: { subscriberId: user.id } });
    if (currentCount >= ent.effectiveSubscriptionLimit) {
      return res.status(402).json({ error: 'Subscription limit reached', limit: ent.effectiveSubscriptionLimit, planCode: ent.plan.code });
    }

    const sub = await prisma.wishlistSubscription.upsert({
      where: { wishlistId_subscriberId: { wishlistId, subscriberId: user.id } },
      update: {},
      create: { wishlistId, subscriberId: user.id },
      select: { id: true, wishlistId: true, createdAt: true },
    });

    return res.json({ subscription: { id: sub.id, wishlistId: sub.wishlistId } });
  }),
);

// DELETE /tg/wishlists/:id/subscribe — unsubscribe from a wishlist
tgRouter.delete(
  '/wishlists/:id/subscribe',
  asyncHandler(async (req, res) => {
    const wishlistId = req.params.id ?? '';
    if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    await prisma.wishlistSubscription.deleteMany({ where: { wishlistId, subscriberId: user.id } });
    return res.json({ ok: true });
  }),
);

// GET /tg/wishlists/:id/subscribe — subscription status + subscriber count (for guest view)
tgRouter.get(
  '/wishlists/:id/subscribe',
  asyncHandler(async (req, res) => {
    const wishlistId = req.params.id ?? '';
    if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);

    const [sub, subscriberCount] = await Promise.all([
      prisma.wishlistSubscription.findUnique({
        where: { wishlistId_subscriberId: { wishlistId, subscriberId: user.id } },
        select: { id: true },
      }),
      prisma.wishlistSubscription.count({ where: { wishlistId } }),
    ]);

    return res.json({ subscribed: !!sub, subscriberCount });
  }),
);

// GET /tg/me/subscriptions — wishlists the user is subscribed to, with unread counts
tgRouter.get(
  '/me/subscriptions',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);

    const subs = await prisma.wishlistSubscription.findMany({
      where: { subscriberId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        wishlistId: true,
        createdAt: true,
        unreads: { select: { id: true, entityId: true, fieldName: true } },
        wishlist: {
          select: {
            id: true,
            slug: true,
            title: true,
            deadline: true,
            archivedAt: true,
            owner: {
              select: {
                firstName: true,
                telegramId: true,
                profile: { select: { displayName: true, username: true, avatarUrl: true, avatarPublic: true } },
              },
            },
            items: {
              where: { status: { in: [...ACTIVE_STATUSES] } },
              select: { id: true },
            },
          },
        },
      },
    });

    const result = subs.map((sub) => ({
      id: sub.id,
      wishlist: {
        id: sub.wishlist.id,
        slug: sub.wishlist.slug,
        title: sub.wishlist.title,
        deadline: sub.wishlist.deadline?.toISOString() ?? null,
        archivedAt: sub.wishlist.archivedAt?.toISOString() ?? null,
        itemCount: sub.wishlist.items.length,
        ownerName: sub.wishlist.owner.profile?.displayName?.trim() ||
          sub.wishlist.owner.profile?.username?.trim() ||
          sub.wishlist.owner.firstName?.trim() ||
          '…',
        ownerAvatarUrl: (sub.wishlist.owner.profile?.avatarPublic !== false && sub.wishlist.owner.profile?.avatarUrl)
          ? sub.wishlist.owner.profile.avatarUrl
          : null,
      },
      unreadCount: new Set(sub.unreads.map((u) => u.entityId)).size,
      unreadEntityIds: [...new Set(sub.unreads.map((u) => u.entityId))],
      // Per-item change counts (excludes wishlist-level changes where entityId === wishlistId)
      unreadItemCounts: (() => {
        const counts: Record<string, number> = {};
        for (const u of sub.unreads) {
          // Skip wishlist-level changes (entityId matches wishlistId)
          if (u.entityId === sub.wishlistId) continue;
          counts[u.entityId] = (counts[u.entityId] ?? 0) + 1;
        }
        return counts;
      })(),
    }));

    return res.json({ subscriptions: result });
  }),
);

// GET /tg/me/subscriptions/meta — lightweight unread summary for boot badge
tgRouter.get(
  '/me/subscriptions/meta',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const subs = await prisma.wishlistSubscription.findMany({
      where: { subscriberId: user.id },
      select: { id: true, unreads: { select: { id: true, entityId: true } } },
    });
    // Count distinct changed entities (not raw field-level rows)
    const unreadCount = subs.reduce((sum, s) => sum + new Set(s.unreads.map(u => u.entityId)).size, 0);
    const subscriptionsWithUnread = subs.filter(s => s.unreads.length > 0).length;
    return res.json({ unreadCount, hasUnread: unreadCount > 0, subscriptionsWithUnread });
  }),
);

// POST /tg/me/subscriptions/:id/read — mark all unreads as read for a subscription
tgRouter.post(
  '/me/subscriptions/:id/read',
  asyncHandler(async (req, res) => {
    const subId = req.params.id ?? '';
    if (!subId) return res.status(400).json({ error: 'Missing subscription id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const sub = await prisma.wishlistSubscription.findUnique({
      where: { id: subId },
      select: { subscriberId: true },
    });
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });
    if (sub.subscriberId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    await prisma.subscriptionUnread.deleteMany({ where: { subId } });
    return res.json({ ok: true });
  }),
);

// ─── Profile subscriptions (follow another user's public profile/showcase) ───

// GET /tg/me/profile-subscriptions — list profiles the user follows
tgRouter.get(
  '/me/profile-subscriptions',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const subs = await prisma.profileSubscription.findMany({
      where: { subscriberId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        targetUserId: true,
        createdAt: true,
        target: {
          select: {
            id: true,
            godMode: true,
            firstName: true,
            profile: {
              select: {
                displayName: true,
                username: true,
                avatarUrl: true,
                avatarThumbUrl: true,
                avatarPublic: true,
                profileVisibility: true,
                showcaseEnabled: true,
              },
            },
          },
        },
      },
    });

    // Filter out profiles that became NOBODY or lost their username
    const visible = subs.filter((s) => {
      const p = s.target.profile;
      return p && p.username && p.profileVisibility !== 'NOBODY';
    });

    // Compute isPro in parallel (showcase only shows for PRO)
    const withPro = await Promise.all(visible.map(async (s) => {
      const ent = await getUserEntitlement(s.target.id, s.target.godMode);
      const p = s.target.profile!;
      return {
        id: s.id,
        username: p.username!,
        displayName: p.displayName?.trim() || p.username!.trim() || s.target.firstName?.trim() || '…',
        avatarUrl: p.avatarPublic ? (p.avatarThumbUrl || p.avatarUrl) : null,
        isPro: ent.isPro,
        hasShowcase: ent.isPro && p.showcaseEnabled,
        createdAt: s.createdAt.toISOString(),
      };
    }));

    return res.json({ subscriptions: withPro });
  }),
);

// POST /tg/profiles/:username/subscribe — follow a profile
tgRouter.post(
  '/profiles/:username/subscribe',
  asyncHandler(async (req, res) => {
    const username = (req.params.username ?? '').trim();
    if (!username) return res.status(400).json({ error: 'Missing username' });

    const user = await getOrCreateTgUser(req.tgUser!);

    const targetProfile = await prisma.userProfile.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
      select: { userId: true, profileVisibility: true, subscribePolicy: true },
    });
    if (!targetProfile) return res.status(404).json({ error: 'Profile not found' });
    if (targetProfile.userId === user.id) return res.status(400).json({ error: 'Cannot subscribe to your own profile' });
    if (targetProfile.profileVisibility === 'NOBODY') return res.status(404).json({ error: 'Profile not found' });
    if (targetProfile.subscribePolicy === 'NOBODY') return res.status(403).json({ error: 'subscriptions_closed' });

    const sub = await prisma.profileSubscription.upsert({
      where: { subscriberId_targetUserId: { subscriberId: user.id, targetUserId: targetProfile.userId } },
      update: {},
      create: { subscriberId: user.id, targetUserId: targetProfile.userId },
      select: { id: true, targetUserId: true, createdAt: true },
    });

    return res.json({ subscription: { id: sub.id, targetUserId: sub.targetUserId, createdAt: sub.createdAt.toISOString() } });
  }),
);

// DELETE /tg/profiles/:username/subscribe — unfollow a profile
tgRouter.delete(
  '/profiles/:username/subscribe',
  asyncHandler(async (req, res) => {
    const username = (req.params.username ?? '').trim();
    if (!username) return res.status(400).json({ error: 'Missing username' });

    const user = await getOrCreateTgUser(req.tgUser!);

    const targetProfile = await prisma.userProfile.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
      select: { userId: true },
    });
    if (!targetProfile) return res.json({ ok: true }); // idempotent

    await prisma.profileSubscription.deleteMany({
      where: { subscriberId: user.id, targetUserId: targetProfile.userId },
    });
    return res.json({ ok: true });
  }),
);

// GET /tg/profiles/:username/subscribe — subscription status (for CTA state on public profile)
tgRouter.get(
  '/profiles/:username/subscribe',
  asyncHandler(async (req, res) => {
    const username = (req.params.username ?? '').trim();
    if (!username) return res.status(400).json({ error: 'Missing username' });

    const user = await getOrCreateTgUser(req.tgUser!);

    const targetProfile = await prisma.userProfile.findFirst({
      where: { username: { equals: username, mode: 'insensitive' } },
      select: { userId: true },
    });
    if (!targetProfile) return res.json({ subscribed: false });
    if (targetProfile.userId === user.id) return res.json({ subscribed: false, isOwn: true });

    const sub = await prisma.profileSubscription.findUnique({
      where: { subscriberId_targetUserId: { subscriberId: user.id, targetUserId: targetProfile.userId } },
      select: { id: true },
    });
    return res.json({ subscribed: !!sub });
  }),
);

// GET /tg/wishlists/:id/items — owner view (no reservation names)
tgRouter.get(
  '/wishlists/:id/items',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({ where: { id }, select: { ownerId: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // Placement-based read: each shared wish appears in every wishlist it's placed in,
    // with per-wishlist position & category (global title/price/status come from Item).
    const placements = await prisma.wishlistItemPlacement.findMany({
      where: { wishlistId: id, item: { status: { in: [...ACTIVE_STATUSES] } } },
      orderBy: PLACEMENT_ORDER_BY,
      select: {
        position: true,
        categoryId: true,
        item: {
          select: {
            id: true, title: true, url: true, priceText: true,
            imageUrl: true, priority: true, status: true, description: true,
            sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
          },
        },
      },
    });

    const categories = await prisma.wishlistCategory.findMany({
      where: { wishlistId: id },
      orderBy: [{ isDefault: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true, sortOrder: true, isDefault: true },
    });

    // Attach placement count so the frontend can render the shared badge ("🔗 В N") without an extra round-trip.
    const itemIds = placements.map(p => p.item.id);
    const counts = itemIds.length > 0
      ? await prisma.wishlistItemPlacement.groupBy({
          by: ['itemId'],
          where: { itemId: { in: itemIds } },
          _count: { itemId: true },
        })
      : [];
    const countByItemId = new Map(counts.map(c => [c.itemId, c._count.itemId]));

    const items = placements.map(p => ({
      ...mapTgItem({ ...p.item, wishlistId: id, position: p.position }),
      categoryId: p.categoryId,
      placementCount: countByItemId.get(p.item.id) ?? 1,
    }));

    return res.json({ items, categories });
  }),
);

// POST /tg/wishlists/:id/items/reorder — reorder items within their priority group (owner only)
tgRouter.post(
  '/wishlists/:id/items/reorder',
  asyncHandler(async (req, res) => {
    const wishlistId = req.params.id ?? '';
    if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });

    const parsed = z
      .object({
        groups: z.array(z.object({
          priority: z.enum(['LOW', 'MEDIUM', 'HIGH']),
          orderedIds: z.array(z.string()).min(1).max(500),
        })).min(1).max(3),
      })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({
      where: { id: wishlistId },
      select: { ownerId: true },
    });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const { groups } = parsed.data;
    const allIds = groups.flatMap(g => g.orderedIds);

    // Verify each item has a placement in THIS wishlist and item's priority matches the declared group.
    // (Priority is global on Item; position is placement-scoped — reordering only touches THIS wishlist.)
    const placementRows = await prisma.wishlistItemPlacement.findMany({
      where: { wishlistId, itemId: { in: allIds } },
      select: { itemId: true, item: { select: { priority: true } } },
    });
    if (placementRows.length !== allIds.length) {
      return res.status(400).json({ error: 'Some item IDs are invalid or not placed in this wishlist' });
    }
    const priorityByItemId = new Map(placementRows.map(p => [p.itemId, p.item.priority]));
    for (const group of groups) {
      for (const id of group.orderedIds) {
        if (priorityByItemId.get(id) !== group.priority) {
          return res.status(400).json({ error: `Item ${id} does not belong to priority group ${group.priority}` });
        }
      }
    }

    // Transactionally assign positions on BOTH placement (authoritative) and Item (legacy).
    // Keeping Item.position in sync avoids breaking any read path not yet migrated to placements.
    await prisma.$transaction([
      ...groups.flatMap(group =>
        group.orderedIds.map((id, idx) =>
          prisma.wishlistItemPlacement.updateMany({
            where: { wishlistId, itemId: id },
            data: { position: idx },
          }),
        ),
      ),
      ...groups.flatMap(group =>
        group.orderedIds.map((id, idx) =>
          prisma.item.update({ where: { id }, data: { position: idx } }),
        ),
      ),
    ]);

    return res.json({ ok: true });
  }),
);

// GET /tg/items — flat list of all items across all user's active wishlists
tgRouter.get(
  '/items',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const items = await prisma.item.findMany({
      where: {
        wishlist: { ownerId: user.id, archivedAt: null },
        status: { in: [...ACTIVE_STATUSES] },
        archivedAt: null,
      },
      orderBy: [{ wishlistId: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true, wishlistId: true, title: true, url: true, priceText: true,
        imageUrl: true, priority: true, status: true, description: true,
        sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
        wishlist: { select: { title: true, slug: true } },
      },
    });

    // Attach placement count per item so shared-wish UI can render without N round-trips.
    // The flat list is per-Item (not per-placement) — shared wishes appear once under their
    // origin wishlist. UI will show "🔗 В N" next to the title when count > 1.
    const itemIds = items.map(i => i.id);
    const counts = itemIds.length > 0
      ? await prisma.wishlistItemPlacement.groupBy({
          by: ['itemId'],
          where: { itemId: { in: itemIds } },
          _count: { itemId: true },
        })
      : [];
    const countByItemId = new Map(counts.map(c => [c.itemId, c._count.itemId]));

    return res.json({
      items: items.map(({ wishlist, ...rest }) => ({
        ...mapTgItem(rest),
        wishlistTitle: wishlist.title,
        wishlistSlug: wishlist.slug,
        placementCount: countByItemId.get(rest.id) ?? 1,
      })),
    });
  }),
);

// ═══════════════════════════════════════════════════════
// WISHLIST CATEGORIES
// ═══════════════════════════════════════════════════════

// GET /tg/wishlists/:id/categories — list categories for a wishlist (owner)
tgRouter.get(
  '/wishlists/:id/categories',
  asyncHandler(async (req, res) => {
    const wishlistId = req.params.id ?? '';
    if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId }, select: { ownerId: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const categories = await prisma.wishlistCategory.findMany({
      where: { wishlistId },
      orderBy: [{ isDefault: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true, name: true, sortOrder: true, isDefault: true },
    });

    return res.json({ categories });
  }),
);

// POST /tg/wishlists/:id/categories — create category (Pro only)
tgRouter.post(
  '/wishlists/:id/categories',
  asyncHandler(async (req, res) => {
    const wishlistId = req.params.id ?? '';
    if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });

    const parsed = z.object({
      name: z.string().min(1).max(24),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id);
    if (!ent.isPro) {
      trackEvent('feature_gate_hit_categories', user.id, { plan: ent.plan.code });
      return res.status(402).json({ error: 'Pro required', planCode: ent.plan.code });
    }

    const wishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId }, select: { ownerId: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // Max 20 user categories per wishlist
    const existingCount = await prisma.wishlistCategory.count({ where: { wishlistId, isDefault: false } });
    if (existingCount >= 20) return res.status(400).json({ error: 'Category limit reached', limit: 20 });

    // Duplicate check (case-insensitive, trimmed)
    const trimmedName = parsed.data.name.trim();
    const existing = await prisma.wishlistCategory.findMany({
      where: { wishlistId },
      select: { name: true },
    });
    const isDuplicate = existing.some(c => c.name.trim().toLowerCase() === trimmedName.toLowerCase());
    if (isDuplicate) return res.status(409).json({ error: 'Duplicate category name' });

    // Ensure default category exists
    const defaultCat = await prisma.wishlistCategory.findFirst({ where: { wishlistId, isDefault: true } });
    if (!defaultCat) {
      await prisma.wishlistCategory.create({
        data: { wishlistId, name: 'Без категории', sortOrder: 999999, isDefault: true },
      });
    }

    // New category gets sortOrder = max existing + 1 (before default)
    const maxOrder = await prisma.wishlistCategory.aggregate({
      where: { wishlistId, isDefault: false },
      _max: { sortOrder: true },
    });
    const nextOrder = (maxOrder._max.sortOrder ?? -1) + 1;

    const category = await prisma.wishlistCategory.create({
      data: { wishlistId, name: trimmedName, sortOrder: nextOrder, isDefault: false },
      select: { id: true, name: true, sortOrder: true, isDefault: true },
    });

    trackEvent('wishlist_category_created', user.id, { wishlistId, categoryId: category.id, name: trimmedName });

    // Return isFirst flag so client can show onboarding hint
    const isFirst = existingCount === 0;

    return res.json({ category, isFirst });
  }),
);

// PATCH /tg/wishlists/:wlId/categories/:catId — rename category (Pro only)
tgRouter.patch(
  '/wishlists/:wlId/categories/:catId',
  asyncHandler(async (req, res) => {
    const { wlId, catId } = req.params;
    if (!wlId || !catId) return res.status(400).json({ error: 'Missing ids' });

    const parsed = z.object({
      name: z.string().min(1).max(24),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id);
    if (!ent.isPro) return res.status(402).json({ error: 'Pro required', planCode: ent.plan.code });

    const wishlist = await prisma.wishlist.findUnique({ where: { id: wlId }, select: { ownerId: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const category = await prisma.wishlistCategory.findUnique({ where: { id: catId }, select: { id: true, wishlistId: true, isDefault: true } });
    if (!category || category.wishlistId !== wlId) return res.status(404).json({ error: 'Category not found' });
    if (category.isDefault) return res.status(400).json({ error: 'Cannot rename default category' });

    // Duplicate check
    const trimmedName = parsed.data.name.trim();
    const siblings = await prisma.wishlistCategory.findMany({
      where: { wishlistId: wlId, id: { not: catId } },
      select: { name: true },
    });
    if (siblings.some(c => c.name.trim().toLowerCase() === trimmedName.toLowerCase())) {
      return res.status(409).json({ error: 'Duplicate category name' });
    }

    const updated = await prisma.wishlistCategory.update({
      where: { id: catId },
      data: { name: trimmedName },
      select: { id: true, name: true, sortOrder: true, isDefault: true },
    });

    trackEvent('wishlist_category_renamed', user.id, { wishlistId: wlId, categoryId: catId, name: trimmedName });

    return res.json({ category: updated });
  }),
);

// DELETE /tg/wishlists/:wlId/categories/:catId — delete category, move items to default (Pro only)
tgRouter.delete(
  '/wishlists/:wlId/categories/:catId',
  asyncHandler(async (req, res) => {
    const { wlId, catId } = req.params;
    if (!wlId || !catId) return res.status(400).json({ error: 'Missing ids' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id);
    if (!ent.isPro) return res.status(402).json({ error: 'Pro required', planCode: ent.plan.code });

    const wishlist = await prisma.wishlist.findUnique({ where: { id: wlId }, select: { ownerId: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const category = await prisma.wishlistCategory.findUnique({ where: { id: catId }, select: { id: true, wishlistId: true, isDefault: true } });
    if (!category || category.wishlistId !== wlId) return res.status(404).json({ error: 'Category not found' });
    if (category.isDefault) return res.status(400).json({ error: 'Cannot delete default category' });

    // Find or create default category
    let defaultCat = await prisma.wishlistCategory.findFirst({ where: { wishlistId: wlId, isDefault: true } });
    if (!defaultCat) {
      defaultCat = await prisma.wishlistCategory.create({
        data: { wishlistId: wlId, name: 'Без категории', sortOrder: 999999, isDefault: true },
      });
    }

    // Move items to default, then delete category — in a transaction.
    // Reads use PLACEMENT.categoryId (authoritative); we reassign placements first,
    // then mirror to Item columns for legacy consistency.
    const movedCount = await prisma.$transaction(async (tx) => {
      // Max position in the default category, scoped to this wishlist — we append here.
      const maxPos = await tx.wishlistItemPlacement.aggregate({
        where: { wishlistId: wlId, categoryId: defaultCat!.id },
        _max: { position: true },
      });
      const startPos = (maxPos._max.position ?? -1) + 1;

      // Active placements to move, preserving their current order.
      const placementsToMove = await tx.wishlistItemPlacement.findMany({
        where: {
          wishlistId: wlId,
          categoryId: catId,
          item: { status: { in: [...ACTIVE_STATUSES] } },
        },
        orderBy: [{ position: 'asc' }],
        select: { itemId: true },
      });

      for (let i = 0; i < placementsToMove.length; i++) {
        const itemId = placementsToMove[i]!.itemId;
        await tx.wishlistItemPlacement.update({
          where: { wishlistId_itemId: { wishlistId: wlId, itemId } },
          data: { categoryId: defaultCat!.id, position: startPos + i },
        });
        // Mirror to legacy Item columns only when this wishlist is the item's primary.
        await tx.item.updateMany({
          where: { id: itemId, wishlistId: wlId },
          data: { categoryId: defaultCat!.id, position: startPos + i },
        });
      }

      // Any other placements (non-active items — archived/deleted) in this category:
      // reassign to default so the row isn't orphaned when the category FK SET NULLs.
      await tx.wishlistItemPlacement.updateMany({
        where: { wishlistId: wlId, categoryId: catId },
        data: { categoryId: defaultCat!.id },
      });
      await tx.item.updateMany({
        where: { wishlistId: wlId, categoryId: catId },
        data: { categoryId: defaultCat!.id },
      });

      // Delete category (FK SET NULL would leave nulls, but we've just reassigned everything).
      await tx.wishlistCategory.delete({ where: { id: catId } });

      return placementsToMove.length;
    });

    trackEvent('wishlist_category_deleted', user.id, { wishlistId: wlId, categoryId: catId, movedItems: movedCount });

    return res.json({ ok: true, movedItems: movedCount });
  }),
);

// POST /tg/wishlists/:id/categories/reorder — reorder categories (Pro only)
tgRouter.post(
  '/wishlists/:id/categories/reorder',
  asyncHandler(async (req, res) => {
    const wishlistId = req.params.id ?? '';
    if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });

    const parsed = z.object({
      orderedIds: z.array(z.string()).min(1).max(20),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id);
    if (!ent.isPro) return res.status(402).json({ error: 'Pro required', planCode: ent.plan.code });

    const wishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId }, select: { ownerId: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // Only reorder non-default categories; default always stays last
    await prisma.$transaction(async (tx) => {
      for (let i = 0; i < parsed.data.orderedIds.length; i++) {
        await tx.wishlistCategory.updateMany({
          where: { id: parsed.data.orderedIds[i], wishlistId, isDefault: false },
          data: { sortOrder: i },
        });
      }
    });

    return res.json({ ok: true });
  }),
);

// POST /tg/items/:id/move-category — move single item to category (Pro only)
tgRouter.post(
  '/items/:id/move-category',
  asyncHandler(async (req, res) => {
    const itemId = req.params.id ?? '';
    if (!itemId) return res.status(400).json({ error: 'Missing item id' });

    const parsed = z.object({
      categoryId: z.string().min(1),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id);
    if (!ent.isPro) return res.status(402).json({ error: 'Pro required', planCode: ent.plan.code });

    // Target category defines which wishlist this move applies to.
    // For shared items, we update the PLACEMENT in that wishlist — placements
    // in other wishlists keep their own category.
    const targetCat = await prisma.wishlistCategory.findUnique({
      where: { id: parsed.data.categoryId },
      select: { id: true, wishlistId: true, wishlist: { select: { ownerId: true } } },
    });
    if (!targetCat) return res.status(404).json({ error: 'Category not found' });
    if (targetCat.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // Item must have a placement in the target wishlist.
    const placement = await prisma.wishlistItemPlacement.findUnique({
      where: { wishlistId_itemId: { wishlistId: targetCat.wishlistId, itemId } },
      select: { id: true },
    });
    if (!placement) {
      return res.status(400).json({ error: 'Item is not placed in the target category\u2019s wishlist' });
    }

    // Append at end of target category (position scoped to this placement wishlist).
    const maxPos = await prisma.wishlistItemPlacement.aggregate({
      where: { categoryId: parsed.data.categoryId },
      _max: { position: true },
    });
    const newPos = (maxPos._max.position ?? -1) + 1;

    // Dual-write: update placement (authoritative) + mirror to Item for legacy reads.
    await prisma.$transaction([
      prisma.wishlistItemPlacement.update({
        where: { wishlistId_itemId: { wishlistId: targetCat.wishlistId, itemId } },
        data: { categoryId: parsed.data.categoryId, position: newPos },
      }),
      prisma.item.updateMany({
        where: { id: itemId, wishlistId: targetCat.wishlistId },
        data: { categoryId: parsed.data.categoryId, position: newPos },
      }),
    ]);

    trackEvent('wishlist_wish_moved_to_category', user.id, {
      itemId, wishlistId: targetCat.wishlistId, categoryId: parsed.data.categoryId,
    });

    return res.json({ ok: true });
  }),
);

// POST /tg/items/bulk-move-category — bulk move items to category (Pro only)
tgRouter.post(
  '/items/bulk-move-category',
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      itemIds: z.array(z.string()).min(1).max(100),
      categoryId: z.string().min(1),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id);
    if (!ent.isPro) return res.status(402).json({ error: 'Pro required', planCode: ent.plan.code });

    // Verify target category
    const targetCat = await prisma.wishlistCategory.findUnique({
      where: { id: parsed.data.categoryId },
      select: { id: true, wishlistId: true },
    });
    if (!targetCat) return res.status(404).json({ error: 'Category not found' });

    // Verify wishlist ownership
    const wishlist = await prisma.wishlist.findUnique({
      where: { id: targetCat.wishlistId },
      select: { ownerId: true },
    });
    if (!wishlist || wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // Only move items that have a placement in the target wishlist (placement-scoped category).
    const placements = await prisma.wishlistItemPlacement.findMany({
      where: { itemId: { in: parsed.data.itemIds }, wishlistId: targetCat.wishlistId },
      select: { itemId: true },
    });

    const maxPos = await prisma.wishlistItemPlacement.aggregate({
      where: { categoryId: parsed.data.categoryId },
      _max: { position: true },
    });
    let nextPos = (maxPos._max.position ?? -1) + 1;

    await prisma.$transaction(async (tx) => {
      for (const pl of placements) {
        const pos = nextPos++;
        await tx.wishlistItemPlacement.update({
          where: { wishlistId_itemId: { wishlistId: targetCat.wishlistId, itemId: pl.itemId } },
          data: { categoryId: parsed.data.categoryId, position: pos },
        });
        // Mirror to legacy Item columns so non-migrated reads stay consistent.
        await tx.item.updateMany({
          where: { id: pl.itemId, wishlistId: targetCat.wishlistId },
          data: { categoryId: parsed.data.categoryId, position: pos },
        });
      }
    });

    trackEvent('wishlist_bulk_moved_to_category', user.id, {
      wishlistId: targetCat.wishlistId, categoryId: parsed.data.categoryId, count: placements.length,
    });

    return res.json({ ok: true, moved: placements.length });
  }),
);

// POST /tg/wishlists/:id/items — add item
tgRouter.post(
  '/wishlists/:id/items',
  asyncHandler(async (req, res) => {
    const wishlistId = req.params.id ?? '';
    if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });

    const parsed = z
      .object({
        title: z.string().min(1).max(200),
        url: zUrl().optional(),
        price: z.number().int().nonnegative().nullable().optional(),
        priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        imageUrl: z.string().url().optional(),
        currency: z.enum(['RUB', 'USD', 'EUR', 'GBP']).optional(),
        // Multi-placement: additional wishlists to place this wish in (variant A — inline checkboxes).
        // Primary wishlist is the URL :id; additionalWishlistIds is placements beyond it.
        additionalWishlistIds: z.array(z.string().min(1)).max(20).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id);
    const wishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId }, select: { ownerId: true, type: true, title: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // Read-only check for over-limit wishlists (only REGULAR)
    if (wishlist.type === 'REGULAR' && !(await isWishlistWritable(user.id, wishlistId, ent.effectiveWishlistLimit))) {
      return res.status(402).json({ error: 'Wishlist is read-only on current plan', planCode: ent.plan.code });
    }

    // Per-wishlist item limit = plan base + any permanent item upgrades for this wishlist.
    // Capacity counts by PLACEMENT so shared wishes count against each host wishlist.
    const effectiveItemLimit = ent.plan.items + (ent.extraItemsPerWishlist[wishlistId] ?? 0);
    const itemCount = await countActivePlacementsInWishlist(wishlistId);
    if (itemCount >= effectiveItemLimit) {
      trackEvent('feature_gate_hit_item_limit', user.id, { plan: ent.plan.code, count: itemCount, limit: effectiveItemLimit });
      return res.status(402).json({ error: 'Plan limit reached', limit: effectiveItemLimit, planCode: ent.plan.code });
    }

    // Validate additional placement wishlists. Each must be owned by the user, REGULAR,
    // writable under the plan, not the primary, and have capacity. If any fails → 400/402.
    // Deduplicate and drop the primary if the client included it (forgiving input).
    const additionalIds = Array.from(new Set((parsed.data.additionalWishlistIds ?? []).filter(x => x !== wishlistId)));
    const validatedAdditionals: Array<{ id: string; categoryId: string | null }> = [];
    if (additionalIds.length > 0) {
      const targets = await prisma.wishlist.findMany({
        where: { id: { in: additionalIds } },
        select: { id: true, ownerId: true, type: true, archivedAt: true },
      });
      for (const id of additionalIds) {
        const t = targets.find(x => x.id === id);
        if (!t) return res.status(404).json({ error: 'additional wishlist not found', wishlistId: id });
        if (t.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden', wishlistId: id });
        if (t.type !== 'REGULAR') return res.status(400).json({ error: 'Cannot place into non-regular wishlist', wishlistId: id });
        if (t.archivedAt) return res.status(400).json({ error: 'Cannot place into archived wishlist', wishlistId: id });
        // Writable under plan + capacity check
        if (!(await isWishlistWritable(user.id, id, ent.effectiveWishlistLimit))) {
          return res.status(402).json({ error: 'Wishlist is read-only on current plan', planCode: ent.plan.code, wishlistId: id });
        }
        const lim = ent.plan.items + (ent.extraItemsPerWishlist[id] ?? 0);
        const cnt = await countActivePlacementsInWishlist(id);
        if (cnt >= lim) {
          trackEvent('feature_gate_hit_item_limit', user.id, { plan: ent.plan.code, count: cnt, limit: lim, context: 'multi_placement' });
          return res.status(402).json({ error: 'Plan limit reached', limit: lim, planCode: ent.plan.code, wishlistId: id });
        }
        validatedAdditionals.push({ id, categoryId: null });
      }
    }

    // Resolve currency: use provided value, or fall back to user's profile default
    let currency = parsed.data.currency;
    if (!currency) {
      const profile = await getOrCreateProfile(user.id, getRequestLocale(req));
      currency = profile.defaultCurrency;
    }

    const wlForSub = await prisma.wishlist.findUnique({ where: { id: wishlistId }, select: { title: true } });

    const item = await prisma.item.create({
      data: {
        wishlistId,
        title: parsed.data.title,
        url: parsed.data.url ?? '',
        priceText: parsed.data.price != null ? String(parsed.data.price) : null,
        priority: numToPriority(parsed.data.priority ?? 2),
        imageUrl: parsed.data.imageUrl ?? null,
        currency,
        categoryId: (await prisma.wishlistCategory.findFirst({ where: { wishlistId, isDefault: true }, select: { id: true } }))?.id ?? null,
      },
      select: { id: true, wishlistId: true, title: true, url: true, priceText: true, currency: true, imageUrl: true, priority: true, position: true, status: true, description: true, sourceUrl: true, sourceDomain: true, importMethod: true, categoryId: true },
    });

    // Dual-write: mirror primary placement + create additional placements.
    await ensureItemPlacement(prisma, { wishlistId, itemId: item.id, position: item.position, categoryId: item.categoryId });
    for (const { id: addId } of validatedAdditionals) {
      await ensureItemPlacement(prisma, { wishlistId: addId, itemId: item.id });
    }
    if (validatedAdditionals.length > 0) {
      trackEvent('wish_multi_placement_created', user.id, {
        itemId: item.id,
        primaryWishlistId: wishlistId,
        additionalCount: validatedAdditionals.length,
      });
    }

    // Canonical analytics: item_created
    const totalUserItems = await prisma.item.count({ where: { wishlist: { ownerId: user.id }, status: { not: 'DELETED' } } });
    trackEvent('item_created', user.id, {
      itemId: item.id, wishlistId, wishlistType: wishlist.type, source: 'manual',
      platform: 'miniapp', isFirstItem: totalUserItems === 1,
    });
    if (totalUserItems === 1) trackEvent('first_item_created', user.id, { itemId: item.id, wishlistType: wishlist.type, source: 'manual', platform: 'miniapp' });

    // Referral: mark firstItem milestone + drive qualify/reward pipeline if
    // this user was referred. Only counts items created in REGULAR wishlists
    // (qualifying criteria is real product engagement, not SYSTEM_DRAFTS / SHOWCASE).
    // Fire-and-forget; never blocks the response.
    if (wishlist.type === 'REGULAR') {
      void runReferralProgressHook(user.id, 'first_item');
    }

    // First Share Prompt: is this the user's first real item in a REGULAR wishlist?
    let showFirstSharePrompt = false;
    if (wishlist.type === 'REGULAR') {
      const prevRealItems = await prisma.item.count({
        where: {
          wishlist: { ownerId: user.id, type: 'REGULAR' },
          isDemo: false,
          status: { not: 'DELETED' },
          id: { not: item.id },
        },
      });
      if (prevRealItems === 0) {
        const updated = await prisma.userProfile.updateMany({
          where: { userId: user.id, firstWishSharePromptShown: false },
          data: { firstWishSharePromptShown: true },
        });
        showFirstSharePrompt = updated.count > 0;
      }
    }

    // Ready Share Prompt: Option B — show when wishlist has ≥2 real items and flag not yet shown.
    // Priority: first-share-prompt wins; never show both in the same request.
    // V1 limitation: no "already shared enough" detection — only gates by readyWishlistSharePromptShown flag.
    // Future: add exclusion if wishlist.shareToken is non-null (user already shared).
    let showReadySharePrompt = false;
    let realItemsInWishlist = 0;
    if (!showFirstSharePrompt && wishlist.type === 'REGULAR') {
      realItemsInWishlist = await prisma.item.count({
        where: {
          wishlistId,
          isDemo: false,
          status: { not: 'DELETED' },
        },
      });
      if (realItemsInWishlist >= 2) {
        const updated = await prisma.userProfile.updateMany({
          where: { userId: user.id, readyWishlistSharePromptShown: false },
          data: { readyWishlistSharePromptShown: true },
        });
        showReadySharePrompt = updated.count > 0;
      }
    }

    trackAnalyticsEvent({
      event: 'wish.created',
      userId: String(req.tgUser!.id),
      props: { wishlistId, hasUrl: !!parsed.data.url, hasPrice: !!parsed.data.price },
    });

    // Notify wishlist subscribers
    void notifySubscribersOfChange(
      wishlistId,
      item.id,
      ['title'],
      'item_added',
      {
        itemTitle: item.title,
        wishlistTitle: wlForSub?.title ?? '…',
        ownerName: req.tgUser?.first_name ?? '…',
      },
    );

    // Onboarding: real item created → may complete onboarding
    void (async () => {
      const onboardingState = await prisma.userOnboardingState.findUnique({
        where: { userId_onboardingKey_version: { userId: user.id, onboardingKey: ONBOARDING_KEY, version: ONBOARDING_VERSION } },
      });
      if (onboardingState?.status !== 'IN_PROGRESS') return;

      // Determine completion reason: was the demo item already deleted?
      let reason: CompletionReason;
      if (onboardingState.demoItemId) {
        const demoItem = await prisma.item.findUnique({
          where: { id: onboardingState.demoItemId },
          select: { status: true },
        });
        reason = demoItem?.status === 'DELETED' ? 'demo_deleted_then_real_created' : 'real_item_created';
      } else {
        reason = 'real_item_created';
      }

      const itemMeta = getOnboardingMeta(onboardingState.metaJson);
      trackEvent('real_item_created_after_onboarding', user.id, {
        onboarding_key: ONBOARDING_KEY,
        version: ONBOARDING_VERSION,
        variant_key: onboardingState.variantKey ?? null,
        entry_point: onboardingState.entryPoint ?? null,
        forced_rollout: FORCED_ROLLOUT_USERS.has(user.id),
        completion_reason: reason,
        market_segment: onboardingState.variantKey ? variantKeyToSegment(onboardingState.variantKey) : 'ru',
        onboarding_variant: itemMeta.onboardingVariant ?? 'v1_demo',
        acquisition_path: itemMeta.acquisitionPath ?? null,
        experiment_phase: (itemMeta.onboardingVariant ?? 'v1_demo') === 'v1_demo' ? 'legacy_recovery' : 'post_rollout',
        onboarding_flow: (itemMeta.onboardingVariant ?? 'v1_demo') === 'v1_demo' ? 'v1_demo_recovery' : 'main_v2',
      });
      await completeOnboarding(user.id, reason);
    })();

    return res.status(201).json({
      item: mapTgItem(item),
      ...(showFirstSharePrompt && {
        showFirstSharePrompt: true,
        promptData: { wishlistId, wishlistTitle: wishlist.title },
      }),
      ...(showReadySharePrompt && {
        showReadySharePrompt: true,
        readySharePromptData: { wishlistId, wishlistTitle: wishlist.title, itemsCount: realItemsInWishlist },
      }),
    });
  }),
);

// POST /tg/items/bulk-move — move multiple items to a target wishlist
tgRouter.post(
  '/items/bulk-move',
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      itemIds: z.array(z.string().min(1)).min(1).max(100),
      targetWishlistId: z.string().min(1),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getUserEntitlement(user.id);
    const { itemIds, targetWishlistId } = parsed.data;

    // Validate target wishlist ownership + not a SYSTEM wishlist
    const targetWl = await prisma.wishlist.findUnique({
      where: { id: targetWishlistId },
      select: { id: true, ownerId: true, type: true },
    });
    if (!targetWl) return res.status(404).json({ error: 'Target wishlist not found' });
    if (targetWl.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (targetWl.type === 'SYSTEM_DRAFTS') return res.status(400).json({ error: 'Cannot move to system wishlist' });

    // Check target wishlist writable on current plan
    if (targetWl.type === 'REGULAR') {
      if (!(await isWishlistWritable(user.id, targetWl.id, ent.plan.wishlists))) {
        return res.status(402).json({ error: t('api_wishlist_items_limit', getRequestLocale(req)), planCode: ent.plan.code });
      }
    }

    // Load all requested items — filter to only those owned by the user and not already in target
    const items = await prisma.item.findMany({
      where: { id: { in: itemIds }, status: { in: [...ACTIVE_STATUSES] } },
      select: { id: true, wishlistId: true, wishlist: { select: { ownerId: true } } },
    });
    const ownedItems = items.filter(
      (i) => i.wishlist.ownerId === user.id && i.wishlistId !== targetWishlistId,
    );
    const notOwnedIds = itemIds.filter((id) => !items.find((i) => i.id === id) || items.find((i) => i.id === id)?.wishlist.ownerId !== user.id);

    // Partition: items already placed in target (shared with it) don't consume a slot —
    // they just need the source placement removed. Only genuinely-new placements bite capacity.
    const existingInTarget = await prisma.wishlistItemPlacement.findMany({
      where: { wishlistId: targetWishlistId, itemId: { in: ownedItems.map((i) => i.id) } },
      select: { itemId: true },
    });
    const alreadyInTarget = new Set(existingInTarget.map((p) => p.itemId));
    const needNewSlot = ownedItems.filter((i) => !alreadyInTarget.has(i.id));
    const noNewSlot = ownedItems.filter((i) => alreadyInTarget.has(i.id));

    // Capacity via PLACEMENT count (shared wishes count against each host wishlist).
    const currentTargetCount = await countActivePlacementsInWishlist(targetWishlistId);
    const available = Math.max(0, ent.plan.items - currentTargetCount);
    const movingNew = needNewSlot.slice(0, available);
    const overLimit = needNewSlot.slice(available);
    const toMove = [...movingNew, ...noNewSlot];

    // Move each item: delete source placement + upsert target placement + sync legacy Item.wishlistId.
    for (const item of toMove) {
      await relocateItemPrimary(item.id, item.wishlistId, targetWishlistId);
    }

    const failed = [
      ...notOwnedIds.map((id) => ({ itemId: id, reason: 'not_found_or_forbidden' })),
      ...overLimit.map((i) => ({ itemId: i.id, reason: 'limit_reached' })),
    ];
    return res.json({ moved: toMove.map((i) => i.id), failed });
  }),
);

// POST /tg/items/bulk-delete — soft-delete multiple items
tgRouter.post(
  '/items/bulk-delete',
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      itemIds: z.array(z.string().min(1)).min(1).max(100),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const { itemIds } = parsed.data;

    // Load and verify ownership
    const items = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, wishlist: { select: { ownerId: true } } },
    });
    const ownedIds = items
      .filter((i) => i.wishlist.ownerId === user.id)
      .map((i) => i.id);

    if (ownedIds.length === 0) return res.json({ deleted: 0 });

    const now = new Date();
    await prisma.$transaction(
      ownedIds.map((id) =>
        prisma.item.update({
          where: { id },
          data: {
            status: 'DELETED',
            archivedAt: now,
            purgeAfter: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
          },
        }),
      ),
    );

    return res.json({ deleted: ownedIds.length });
  }),
);

// POST /tg/items/bulk-restore — restore multiple archived items
// Must be placed before /items/:id to avoid route param collision.
tgRouter.post(
  '/items/bulk-restore',
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      itemIds: z.array(z.string().min(1)).min(1).max(100),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const { itemIds } = parsed.data;

    // Load all requested items with wishlist info for ownership + archived check
    const items = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: {
        id: true,
        status: true,
        wishlist: { select: { ownerId: true, archivedAt: true } },
      },
    });

    const restored: string[] = [];
    const failed: Array<{ itemId: string; reason: string }> = [];

    const toRestore: string[] = [];
    for (const req_id of itemIds) {
      const item = items.find((i) => i.id === req_id);
      if (!item || item.wishlist.ownerId !== user.id) {
        failed.push({ itemId: req_id, reason: 'not_found_or_forbidden' });
        continue;
      }
      if (item.status !== 'DELETED' && item.status !== 'COMPLETED' && item.status !== 'ARCHIVED') {
        failed.push({ itemId: req_id, reason: 'not_archived' });
        continue;
      }
      if (item.wishlist.archivedAt !== null) {
        failed.push({ itemId: req_id, reason: 'wishlist_archived' });
        continue;
      }
      toRestore.push(req_id);
    }

    if (toRestore.length > 0) {
      await prisma.item.updateMany({
        where: { id: { in: toRestore } },
        data: { status: 'AVAILABLE', archivedAt: null, purgeAfter: null },
      });
      restored.push(...toRestore);
    }

    return res.json({ ok: true, restored, failed });
  }),
);

// POST /tg/items/bulk-archive — archive items (separate from delete/complete)
tgRouter.post(
  '/items/bulk-archive',
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      itemIds: z.array(z.string().min(1)).min(1).max(100),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const { itemIds } = parsed.data;

    const items = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: { id: true, status: true, wishlist: { select: { ownerId: true } } },
    });

    const results: Array<{ itemId: string; ok: boolean; code?: string }> = [];
    const toArchive: string[] = [];

    for (const reqId of itemIds) {
      const item = items.find(i => i.id === reqId);
      if (!item || item.wishlist.ownerId !== user.id) {
        results.push({ itemId: reqId, ok: false, code: 'FORBIDDEN' });
        continue;
      }
      if (item.status === 'RESERVED') {
        results.push({ itemId: reqId, ok: false, code: 'ITEM_RESERVED' });
        continue;
      }
      if (item.status !== 'AVAILABLE') {
        results.push({ itemId: reqId, ok: false, code: 'INVALID_STATUS' });
        continue;
      }
      toArchive.push(reqId);
    }

    if (toArchive.length > 0) {
      await prisma.item.updateMany({
        where: { id: { in: toArchive } },
        data: { status: 'ARCHIVED', archivedAt: new Date() },
        // No purgeAfter — archived items are recoverable indefinitely
      });
    }

    for (const id of toArchive) results.push({ itemId: id, ok: true });
    const successCount = toArchive.length;
    const failureCount = results.filter(r => !r.ok).length;

    return res.json({ successCount, failureCount, results });
  }),
);

// POST /tg/items/bulk-copy — copy items to another wishlist (new records, clean state)
tgRouter.post(
  '/items/bulk-copy',
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      itemIds: z.array(z.string().min(1)).min(1).max(100),
      targetWishlistId: z.string().min(1),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id);
    const { itemIds, targetWishlistId } = parsed.data;

    // Validate target
    const targetWl = await prisma.wishlist.findUnique({
      where: { id: targetWishlistId },
      select: { id: true, ownerId: true, type: true, archivedAt: true },
    });
    if (!targetWl || targetWl.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (targetWl.type === 'SYSTEM_DRAFTS') return res.status(400).json({ error: 'Cannot copy to system wishlist' });
    if (targetWl.archivedAt) return res.status(400).json({ error: 'Cannot copy to archived wishlist' });

    // Load source items (owned only)
    const items = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: {
        id: true, title: true, description: true, url: true, priceText: true,
        currency: true, priority: true, imageUrl: true, sourceUrl: true,
        sourceDomain: true, importMethod: true, status: true,
        wishlist: { select: { ownerId: true, id: true } },
      },
    });

    const results: Array<{ itemId: string; ok: boolean; code?: string; newItemId?: string }> = [];

    // Capacity check — counts placements so shared wishes in target count too.
    const effectiveItemLimit = ent.plan.items + (ent.extraItemsPerWishlist[targetWishlistId] ?? 0);
    const currentTargetCount = await countActivePlacementsInWishlist(targetWishlistId);
    let available = Math.max(0, effectiveItemLimit - currentTargetCount);

    for (const reqId of itemIds) {
      const item = items.find(i => i.id === reqId);
      if (!item || item.wishlist.ownerId !== user.id) {
        results.push({ itemId: reqId, ok: false, code: 'FORBIDDEN' });
        continue;
      }
      if (item.status === 'RESERVED') {
        results.push({ itemId: reqId, ok: false, code: 'ITEM_RESERVED' });
        continue;
      }
      if (item.wishlist.id === targetWishlistId) {
        results.push({ itemId: reqId, ok: false, code: 'SAME_WISHLIST' });
        continue;
      }
      if (available <= 0) {
        results.push({ itemId: reqId, ok: false, code: 'TARGET_LIMIT_REACHED' });
        continue;
      }
      // Create clean copy (semantically a duplicate — new Item row, no shared linkage)
      const copy = await prisma.item.create({
        data: {
          wishlistId: targetWishlistId,
          title: item.title,
          description: item.description,
          url: item.url,
          priceText: item.priceText,
          currency: item.currency,
          priority: item.priority,
          imageUrl: item.imageUrl,
          sourceUrl: item.sourceUrl,
          sourceDomain: item.sourceDomain,
          importMethod: item.importMethod,
          status: 'AVAILABLE',
        },
        select: { id: true },
      });
      // Dual-write: mirror placement for the new Item.
      await ensureItemPlacement(prisma, { wishlistId: targetWishlistId, itemId: copy.id });
      available--;
      results.push({ itemId: reqId, ok: true, newItemId: copy.id });
    }

    const successCount = results.filter(r => r.ok).length;
    const failureCount = results.filter(r => !r.ok).length;

    return res.json({ successCount, failureCount, results });
  }),
);

// POST /tg/items/bulk-hard-delete — permanently delete archived items
// Hard delete is only permitted for items in DELETED or COMPLETED status.
// Must be placed before /items/:id to avoid route param collision.
tgRouter.post(
  '/items/bulk-hard-delete',
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      itemIds: z.array(z.string().min(1)).min(1).max(100),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const { itemIds } = parsed.data;

    // Only allow hard-delete for owned items that are already archived
    const items = await prisma.item.findMany({
      where: { id: { in: itemIds } },
      select: {
        id: true,
        status: true,
        imageUrl: true,
        wishlist: { select: { ownerId: true } },
      },
    });

    const eligibleIds = items
      .filter(
        (i) =>
          i.wishlist.ownerId === user.id &&
          (i.status === 'DELETED' || i.status === 'COMPLETED' || i.status === 'ARCHIVED'),
      )
      .map((i) => i.id);

    if (eligibleIds.length === 0) return res.json({ deleted: 0 });

    // Hard-delete — Prisma cascades handle child records (reservationEvents, itemTags, comments)
    await prisma.item.deleteMany({ where: { id: { in: eligibleIds } } });

    return res.json({ deleted: eligibleIds.length });
  }),
);

// POST /tg/archive/purge — permanently delete ALL archived items for the current user
// Two-step confirmation is enforced in the frontend; this endpoint is the final destructive step.
tgRouter.post(
  '/archive/purge',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);

    const items = await prisma.item.findMany({
      where: {
        status: { in: ['DELETED', 'COMPLETED'] },
        wishlist: { ownerId: user.id },
      },
      select: { id: true },
    });

    if (items.length === 0) return res.json({ deleted: 0 });

    await prisma.item.deleteMany({
      where: { id: { in: items.map((i) => i.id) } },
    });

    return res.json({ deleted: items.length });
  }),
);

// PATCH /tg/items/:id — edit item
tgRouter.patch(
  '/items/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const parsed = z
      .object({
        title: z.string().min(1).max(200).optional(),
        url: zUrl().nullable().optional(),
        price: z.number().int().nonnegative().nullable().optional(),
        priority: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
        imageUrl: z.string().url().nullable().optional(),
        description: z.string().max(500).nullable().optional(),
        currency: z.enum(['RUB', 'USD', 'EUR', 'GBP']).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, status: true, reservationEpoch: true, reserverUserId: true, title: true, wishlistId: true, isDemo: true, originType: true, originVariantKey: true, wishlist: { select: { ownerId: true, title: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // Detect which subscriber-visible fields are changing
    const subChangedFields: string[] = [];
    if (parsed.data.title !== undefined) subChangedFields.push('title');
    if (parsed.data.price !== undefined) subChangedFields.push('price');
    if (parsed.data.description !== undefined) subChangedFields.push('description');
    if (parsed.data.priority !== undefined) subChangedFields.push('priority');
    if (parsed.data.url !== undefined) subChangedFields.push('url');
    if (parsed.data.imageUrl !== undefined) subChangedFields.push('image');

    const updated = await prisma.item.update({
      where: { id },
      data: {
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.url !== undefined ? { url: parsed.data.url ?? '' } : {}),
        ...(parsed.data.price !== undefined
          ? { priceText: parsed.data.price != null ? String(parsed.data.price) : null }
          : {}),
        ...(parsed.data.priority !== undefined ? { priority: numToPriority(parsed.data.priority) } : {}),
        ...(parsed.data.imageUrl !== undefined ? { imageUrl: parsed.data.imageUrl } : {}),
        ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
        ...(parsed.data.currency !== undefined ? { currency: parsed.data.currency } : {}),
      },
      select: { id: true, wishlistId: true, title: true, url: true, priceText: true, currency: true, imageUrl: true, priority: true, position: true, status: true, description: true, sourceUrl: true, sourceDomain: true, importMethod: true },
    });

    trackAnalyticsEvent({ event: 'wish.edited', userId: String(req.tgUser!.id), props: { itemId: req.params.id } });

    // Onboarding: detect meaningful edit on a demo item → trigger completion
    if (item.isDemo && item.originVariantKey && item.originType === 'DEMO') {
      const template = getDemoTemplate(item.originVariantKey);
      if (template && isMeaningfulEdit(parsed.data, template)) {
        const onboardingState = await prisma.userOnboardingState.findUnique({
          where: { userId_onboardingKey_version: { userId: user.id, onboardingKey: ONBOARDING_KEY, version: ONBOARDING_VERSION } },
        });
        if (onboardingState?.status === 'IN_PROGRESS' && onboardingState.demoItemId === id) {
          trackEvent('demo_item_edited', user.id, {
            onboarding_key: ONBOARDING_KEY,
            version: ONBOARDING_VERSION,
            variant_key: item.originVariantKey,
            entry_point: onboardingState.entryPoint ?? null,
            forced_rollout: FORCED_ROLLOUT_USERS.has(user.id),
          });
          trackEvent('demo_item_converted_to_real', user.id, {
            onboarding_key: ONBOARDING_KEY,
            version: ONBOARDING_VERSION,
            variant_key: item.originVariantKey,
            entry_point: onboardingState.entryPoint ?? null,
            forced_rollout: FORCED_ROLLOUT_USERS.has(user.id),
          });
          void completeOnboarding(user.id, 'demo_converted');
        } else {
          trackEvent('demo_item_edited', user.id, {
            onboarding_key: ONBOARDING_KEY,
            version: ONBOARDING_VERSION,
            variant_key: item.originVariantKey,
            forced_rollout: FORCED_ROLLOUT_USERS.has(user.id),
          });
        }
      }
    }

    // Notify wishlist subscribers of item change
    if (subChangedFields.length > 0) {
      void notifySubscribersOfChange(
        item.wishlistId,
        id,
        subChangedFields,
        'item_updated',
        { itemTitle: updated.title, wishlistTitle: item.wishlist.title },
      );
    }

    // After update, if description changed and item was reserved — notify reserver
    if (parsed.data.description !== undefined && item.status === 'RESERVED') {
      const locale = getRequestLocale(req);
      await prisma.comment.create({
        data: {
          itemId: id,
          type: 'SYSTEM',
          text: t('api_system_description_updated', locale),
          reservationEpoch: item.reservationEpoch,
        },
      });
      if (item.reserverUserId) {
        const reserver = await prisma.user.findUnique({
          where: { id: item.reserverUserId },
          select: { telegramChatId: true },
        });
        if (reserver?.telegramChatId) {
          const notifLocale: Locale = 'ru'; // notifications to other users default to Russian
          void sendTgNotification(reserver.telegramChatId, t('notif_description_updated', notifLocale, { title: item.title }));
        }
      }
    }

    return res.json({ item: mapTgItem(updated) });
  }),
);

// DELETE /tg/items/:id — soft-delete item (status → DELETED)
tgRouter.delete(
  '/items/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, title: true, reserverUserId: true, isDemo: true, originVariantKey: true, wishlist: { select: { ownerId: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const now = new Date();
    await prisma.item.update({
      where: { id },
      data: {
        status: 'DELETED',
        archivedAt: now,
        purgeAfter: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
      },
    });

    trackAnalyticsEvent({ event: 'wish.deleted', userId: String(req.tgUser!.id), props: { itemId: req.params.id } });

    // Cancel active hints when item is deleted
    void cancelItemHints(id);

    // Onboarding: track demo item deletion for analytics
    if (item.isDemo && item.originVariantKey) {
      const onboardingState = await prisma.userOnboardingState.findUnique({
        where: { userId_onboardingKey_version: { userId: user.id, onboardingKey: ONBOARDING_KEY, version: ONBOARDING_VERSION } },
      });
      if (onboardingState?.status === 'IN_PROGRESS' && onboardingState.demoItemId === id) {
        trackEvent('demo_item_deleted', user.id, {
          onboarding_key: ONBOARDING_KEY,
          version: ONBOARDING_VERSION,
          variant_key: item.originVariantKey,
          entry_point: onboardingState.entryPoint ?? null,
          forced_rollout: FORCED_ROLLOUT_USERS.has(user.id),
        });
      }
    }

    // Notify reserver that item was archived
    if (item.reserverUserId) {
      const reserver = await prisma.user.findUnique({
        where: { id: item.reserverUserId },
        select: { telegramChatId: true },
      });
      if (reserver?.telegramChatId) {
        const notifLocale: Locale = 'ru'; // notifications to other users default to Russian
        void sendTgNotification(
          reserver.telegramChatId,
          t('notif_archived', notifLocale, { title: item.title }),
        );
      }
    }

    return res.json({ ok: true });
  }),
);

// POST /tg/items/:id/complete — mark item as received/completed
tgRouter.post(
  '/items/:id/complete',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, status: true, title: true, reserverUserId: true, wishlist: { select: { ownerId: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const now = new Date();
    const updated = await prisma.item.update({
      where: { id },
      data: {
        status: 'COMPLETED',
        archivedAt: now,
        purgeAfter: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000),
      },
      select: { id: true, wishlistId: true, title: true, url: true, priceText: true, currency: true, imageUrl: true, priority: true, status: true, description: true, sourceUrl: true, sourceDomain: true, importMethod: true },
    });

    trackAnalyticsEvent({ event: 'wish.completed', userId: String(req.tgUser!.id), props: { itemId: req.params.id } });

    // Cancel active hints when item is completed
    void cancelItemHints(id);

    // Set TTL on all comments when item is completed
    const ttl = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await prisma.comment.updateMany({
      where: { itemId: id, scheduledDeleteAt: null },
      data: { scheduledDeleteAt: ttl },
    });

    // Mark ReservationMeta as completed (history)
    if (item.reserverUserId) {
      void prisma.reservationMeta.updateMany({
        where: { itemId: id, reserverUserId: item.reserverUserId, active: true },
        data: { active: false, endedAt: new Date(), endReason: 'completed' },
      }).catch(() => {});
    }

    // Notify reserver that item was completed
    if (item.reserverUserId) {
      const reserver = await prisma.user.findUnique({
        where: { id: item.reserverUserId },
        select: { telegramChatId: true, id: true },
      });
      if (reserver?.telegramChatId) {
        const notifLocale: Locale = 'ru'; // notifications to other users default to Russian
        let msg = t('notif_completed', notifLocale, { title: item.title });
        // Soft CTA if reserver has no wishlists
        const reserverWlCount = await prisma.wishlist.count({
          where: { ownerId: reserver.id, type: 'REGULAR' },
        });
        if (reserverWlCount === 0) {
          msg += t('notif_create_your_wishlist', notifLocale);
        }
        void sendTgNotification(reserver.telegramChatId, msg);
      }
    }

    return res.json({ item: mapTgItem(updated) });
  }),
);

// POST /tg/items/:id/restore — restore item to AVAILABLE
tgRouter.post(
  '/items/:id/restore',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, status: true, wishlist: { select: { ownerId: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (item.status !== 'DELETED' && item.status !== 'COMPLETED') {
      return res.status(409).json({ error: 'Item is not archived' });
    }

    const updated = await prisma.item.update({
      where: { id },
      data: {
        status: 'AVAILABLE',
        archivedAt: null,
        purgeAfter: null,
      },
      select: {
        id: true, wishlistId: true, title: true, url: true, priceText: true,
        currency: true, imageUrl: true, priority: true, position: true,
        status: true, description: true, sourceUrl: true, sourceDomain: true, importMethod: true,
        wishlist: { select: { id: true, title: true } },
      },
    });
    const { wishlist, ...itemFields } = updated;
    return res.json({ item: mapTgItem(itemFields), wishlistId: wishlist.id, wishlistTitle: wishlist.title });
  }),
);

// GET /tg/wishlists/:id/archive — archived items of a specific wishlist (DELETED + COMPLETED)
tgRouter.get(
  '/wishlists/:id/archive',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({ where: { id }, select: { ownerId: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const items = await prisma.item.findMany({
      where: { wishlistId: id, status: { in: ['DELETED', 'COMPLETED'] } },
      orderBy: ITEM_ORDER_BY,
      select: { id: true, wishlistId: true, title: true, url: true, priceText: true, currency: true, imageUrl: true, priority: true, position: true, status: true, description: true, sourceUrl: true, sourceDomain: true, importMethod: true },
    });

    return res.json({ items: items.map(mapTgItem) });
  }),
);

// GET /tg/archive — global user archive (ALL DELETED + COMPLETED items across all wishlists)
tgRouter.get(
  '/archive',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);

    const items = await prisma.item.findMany({
      where: {
        status: { in: ['DELETED', 'COMPLETED'] },
        wishlist: { ownerId: user.id },
      },
      orderBy: [{ updatedAt: 'desc' }],
      select: {
        id: true, wishlistId: true, title: true, url: true, priceText: true,
        currency: true, imageUrl: true, priority: true, position: true,
        status: true, description: true, sourceUrl: true, sourceDomain: true,
        importMethod: true,
        wishlist: { select: { id: true, title: true, archivedAt: true } },
      },
    });

    return res.json({
      items: items.map(({ wishlist, ...item }) => ({
        ...mapTgItem(item),
        wishlistTitle: wishlist.title,
        wishlistId: wishlist.id,
        wishlistIsArchived: wishlist.archivedAt !== null,
      })),
    });
  }),
);

// POST /tg/items/:id/reserve — guest reserves (name stored as comment for other guests to see)
tgRouter.post(
  '/items/:id/reserve',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const parsed = z
      .object({ displayName: z.string().min(1).max(64).optional() })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const tgUser = req.tgUser!;
    const actorHash = tgActorHash(tgUser.id);
    const displayName = parsed.data.displayName ?? tgUser.first_name;

    const user = await getOrCreateTgUser(tgUser);

    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.item.findUnique({ where: { id }, select: { status: true, reservationEpoch: true, wishlistId: true } });
      if (!item) return { kind: 'not_found' as const };
      if (item.status !== 'AVAILABLE') return { kind: 'conflict' as const };

      // Check participant limit (based on wishlist owner's plan) + smart reservations
      const wishlist = await tx.wishlist.findUnique({
        where: { id: item.wishlistId },
        select: {
          ownerId: true,
          smartReservationsEnabled: true, smartResTtlHours: true,
          smartResAllowExtend: true, smartResMaxExtensions: true,
        },
      });
      let smartRes = false;
      let smartResExpiresAt: Date | null = null;
      if (wishlist) {
        const ownerUser = await tx.user.findUnique({ where: { id: wishlist.ownerId }, select: { godMode: true } });
        const ownerEnt = await getEffectiveEntitlements(wishlist.ownerId, ownerUser?.godMode ?? false);
        const activeReservations = await tx.item.findMany({
          where: { wishlistId: item.wishlistId, status: 'RESERVED' },
          select: { reserverUserId: true },
          distinct: ['reserverUserId'],
        });
        const existingReserverIds = new Set(
          activeReservations.map((r) => r.reserverUserId).filter(Boolean),
        );
        if (!existingReserverIds.has(user.id) && existingReserverIds.size >= ownerEnt.plan.participants) {
          return { kind: 'participant_limit' as const, limit: ownerEnt.plan.participants };
        }
        // Smart Reservations: double-check both toggle AND owner entitlement
        if (wishlist.smartReservationsEnabled) {
          smartRes = hasSmartReservations(
            { godMode: ownerUser?.godMode ?? false }, ownerEnt.isPro, ownerEnt.addOns, item.wishlistId
          );
        }
        if (smartRes) {
          smartResExpiresAt = new Date(Date.now() + wishlist.smartResTtlHours * 3600000);
        }
      }

      const newEpoch = item.reservationEpoch + 1;
      await tx.item.update({
        where: { id },
        data: {
          status: 'RESERVED',
          reservationEpoch: newEpoch,
          reserverUserId: user.id,
        },
      });
      await tx.reservationEvent.create({
        data: { itemId: id, type: 'RESERVED', actorHash, comment: displayName },
      });
      await tx.comment.create({
        data: { itemId: id, type: 'SYSTEM', text: t('api_system_reserved', getRequestLocale(req)), reservationEpoch: newEpoch },
      });
      // Clear TTL on existing comments (from previous unreserve)
      await tx.comment.updateMany({
        where: { itemId: id, scheduledDeleteAt: { not: null } },
        data: { scheduledDeleteAt: null },
      });
      return { kind: 'ok' as const, wishlistId: item.wishlistId, smartRes, smartResExpiresAt, smartResTtlHours: wishlist?.smartResTtlHours ?? null };
    });

    if (result.kind === 'not_found') return res.status(404).json({ error: 'Item not found' });
    if (result.kind === 'conflict') return res.status(409).json({ error: 'Item is not available' });
    if (result.kind === 'participant_limit') return res.status(402).json({ error: 'Participant limit reached', feature: 'participant_limit', limit: result.limit });

    if (result.kind === 'ok') {
      // Notify owner
      const itemData = await prisma.item.findUnique({
        where: { id },
        select: { title: true, wishlist: { select: { ownerId: true, smartResTtlHours: true, smartResAllowExtend: true, smartResMaxExtensions: true } } },
      });
      if (itemData) {
        const owner = await prisma.user.findUnique({
          where: { id: itemData.wishlist.ownerId },
          select: { telegramChatId: true },
        });
        if (owner?.telegramChatId) {
          const notifLocale: Locale = 'ru'; // notifications to other users default to Russian
          void sendTgNotification(owner.telegramChatId, t('notif_reserved', notifLocale, { name: displayName, title: itemData.title }));
        }
      }

      // Ensure ReservationMeta exists (reactivate if re-reserving same item) with smart res snapshot
      const smartResSnapshot = result.smartRes && itemData ? {
        expiresAt: result.smartResExpiresAt, isSmartRes: true, extensionCount: 0,
        smartResTtlHours: itemData.wishlist.smartResTtlHours,
        smartResMaxExtensions: itemData.wishlist.smartResMaxExtensions,
        smartResAllowExtend: itemData.wishlist.smartResAllowExtend,
      } : null;
      const smartResCleanup = {
        isSmartRes: false, expiresAt: null, extensionCount: 0,
        smartResTtlHours: null, smartResMaxExtensions: null, smartResAllowExtend: null,
      };
      void prisma.reservationMeta.upsert({
        where: { itemId_reserverUserId: { itemId: id, reserverUserId: user.id } },
        create: { itemId: id, reserverUserId: user.id, ...(smartResSnapshot ?? {}) },
        update: { active: true, endedAt: null, endReason: null, reminderSent: false, ...(smartResSnapshot ?? smartResCleanup) },
      }).catch((e) => logger.warn({ err: e }, 'reservationMeta upsert failed'));
    }

    trackAnalyticsEvent({ event: 'reservation.succeeded', userId: req.tgUser?.id != null ? String(req.tgUser.id) : undefined, props: { itemId: req.params.id } });

    // Cancel active hints when item is reserved
    void cancelItemHints(id);

    return res.json({ ok: true, expiresAt: result.kind === 'ok' ? result.smartResExpiresAt?.toISOString() ?? null : null });
  }),
);

// POST /tg/items/:id/unreserve — guest unreserves their own reservation
tgRouter.post(
  '/items/:id/unreserve',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const tgUser = req.tgUser!;
    const actorHash = tgActorHash(tgUser.id);

    const result = await prisma.$transaction(async (tx) => {
      const item = await tx.item.findUnique({ where: { id }, select: { status: true, reservationEpoch: true } });
      if (!item) return { kind: 'not_found' as const };
      if (item.status !== 'RESERVED') return { kind: 'conflict' as const };

      const lastEvent = await tx.reservationEvent.findFirst({
        where: { itemId: id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { type: true, actorHash: true },
      });
      if (!lastEvent || lastEvent.type !== 'RESERVED') return { kind: 'conflict' as const };
      if (!secureCompare(lastEvent.actorHash, actorHash)) return { kind: 'forbidden' as const };

      await tx.item.update({ where: { id }, data: { status: 'AVAILABLE', reserverUserId: null } });
      await tx.reservationEvent.create({
        data: { itemId: id, type: 'UNRESERVED', actorHash, comment: null },
      });
      await tx.comment.create({
        data: { itemId: id, type: 'SYSTEM', text: t('api_system_unreserved', getRequestLocale(req)), reservationEpoch: item.reservationEpoch },
      });
      // Set TTL on all comments
      const ttl = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await tx.comment.updateMany({
        where: { itemId: id, scheduledDeleteAt: null },
        data: { scheduledDeleteAt: ttl },
      });
      return { kind: 'ok' as const };
    });

    if (result.kind === 'not_found') return res.status(404).json({ error: 'Item not found' });
    if (result.kind === 'conflict') return res.status(409).json({ error: 'Cannot unreserve' });
    if (result.kind === 'forbidden') return res.status(403).json({ error: 'Forbidden' });

    trackAnalyticsEvent({ event: 'reservation.cancelled', userId: req.tgUser?.id != null ? String(req.tgUser.id) : undefined, props: { itemId: req.params.id } });

    // Mark ReservationMeta as inactive (history)
    const unreserveUser = await getOrCreateTgUser(req.tgUser!);
    void prisma.reservationMeta.updateMany({
      where: { itemId: id, reserverUserId: unreserveUser.id, active: true },
      data: { active: false, endedAt: new Date(), endReason: 'unreserved' },
    }).catch(() => {});

    return res.json({ ok: true });
  }),
);

// POST /tg/items/:id/extend-reservation — gifter extends their smart reservation
tgRouter.post(
  '/items/:id/extend-reservation',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const user = await getOrCreateTgUser(req.tgUser!);

    const item = await prisma.item.findUnique({ where: { id }, select: { status: true, reserverUserId: true } });
    if (!item) return res.status(404).json({ error: 'not_found' });
    if (item.status !== 'RESERVED') return res.status(409).json({ error: 'reservation_not_active' });
    if (item.reserverUserId !== user.id) return res.status(403).json({ error: 'not_reserver' });

    const meta = await prisma.reservationMeta.findUnique({
      where: { itemId_reserverUserId: { itemId: id, reserverUserId: user.id } },
    });
    if (!meta || !meta.isSmartRes || !meta.active) return res.status(400).json({ error: 'not_smart_reservation' });
    if (!meta.smartResAllowExtend) return res.status(403).json({ error: 'extend_not_allowed' });
    if (meta.extensionCount >= (meta.smartResMaxExtensions ?? 0)) return res.status(409).json({ error: 'max_extensions_reached' });
    if (!meta.expiresAt || meta.expiresAt.getTime() <= Date.now()) return res.status(409).json({ error: 'reservation_expired' });

    const newExpiresAt = new Date(Date.now() + (meta.smartResTtlHours ?? 72) * 3600000);
    const updated = await prisma.reservationMeta.update({
      where: { id: meta.id },
      data: { expiresAt: newExpiresAt, extensionCount: meta.extensionCount + 1, reminderSent: false },
    });

    const derived = smartResDerive(updated);
    return res.json({
      expiresAt: updated.expiresAt?.toISOString() ?? null,
      extensionCount: updated.extensionCount,
      maxExtensions: updated.smartResMaxExtensions ?? 0,
      ...derived,
    });
  }),
);

// GET /tg/items/:id — fetch a single item for deep-link resolution (owner/reserver only).
// Used by comment-reply deep links when the item is not in any already-loaded wishlist.
tgRouter.get(
  '/items/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const ctx = await getItemRole(id, req.tgUser!);
    if (!ctx) return res.status(404).json({ error: 'Item not found' });
    if (ctx.role === 'third_party') return res.status(403).json({ error: 'Forbidden' });

    const item = await prisma.item.findUnique({
      where: { id },
      select: {
        id: true, wishlistId: true, title: true, url: true, priceText: true,
        imageUrl: true, priority: true, position: true, status: true, description: true,
        sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
        categoryId: true,
      },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });

    return res.json({ item: { ...mapTgItem(item), categoryId: item.categoryId }, role: ctx.role });
  }),
);

// GET /tg/items/:id/comments — list comments (owner/reserver only)
tgRouter.get(
  '/items/:id/comments',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const ctx = await getItemRole(id, req.tgUser!);
    if (!ctx) return res.status(404).json({ error: 'Item not found' });
    if (ctx.role === 'third_party') return res.status(403).json({ error: 'Forbidden' });

    const comments = await prisma.comment.findMany({
      where: { itemId: id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true, type: true, authorActorHash: true, authorDisplayName: true,
        text: true, reservationEpoch: true, createdAt: true,
        parentCommentId: true, scheduledDeleteAt: true,
      },
    });

    // Build parent-preview map. We look up parents among the same item's comments (cheap — already loaded).
    // For reserver viewing a parent from an older reservation epoch, we hide text/name but still mark it present.
    const byId = new Map(comments.map(c => [c.id, c]));
    const PARENT_PREVIEW_TEXT_MAX = 120;

    // For reserver: anonymize previous epoch comments
    const locale = getRequestLocale(req);
    const mapped = comments.map((c) => {
      let parentPreview: null | {
        id: string;
        text: string;
        authorDisplayName: string | null;
        deleted: boolean;
      } = null;

      if (c.parentCommentId) {
        const parent = byId.get(c.parentCommentId);
        if (!parent) {
          // fk was SET NULL elsewhere or parent not in this item — treat as missing
          parentPreview = { id: c.parentCommentId, text: '', authorDisplayName: null, deleted: true };
        } else {
          // internal reason classification — not exposed to client but drives the flag
          let unavailableReason: null | 'missing' | 'ttl_hidden' | 'epoch_hidden' = null;
          if (parent.scheduledDeleteAt) unavailableReason = 'ttl_hidden';
          else if (
            ctx.role === 'reserver' &&
            parent.type === 'USER' &&
            parent.reservationEpoch < ctx.item.reservationEpoch &&
            parent.authorActorHash !== ctx.actorHash
          ) {
            unavailableReason = 'epoch_hidden';
          }

          if (unavailableReason) {
            parentPreview = { id: parent.id, text: '', authorDisplayName: null, deleted: true };
          } else {
            const truncated = parent.text.length > PARENT_PREVIEW_TEXT_MAX
              ? parent.text.slice(0, PARENT_PREVIEW_TEXT_MAX - 1) + '…'
              : parent.text;
            parentPreview = {
              id: parent.id,
              text: truncated,
              authorDisplayName: parent.authorDisplayName ?? null,
              deleted: false,
            };
          }
        }
      }

      const base = {
        id: c.id,
        type: c.type,
        authorActorHash: c.authorActorHash,
        authorDisplayName: c.authorDisplayName,
        text: c.text,
        reservationEpoch: c.reservationEpoch,
        createdAt: c.createdAt.toISOString(),
        parentCommentId: c.parentCommentId,
        parentPreview,
      };

      if (
        ctx.role === 'reserver' &&
        c.type === 'USER' &&
        c.reservationEpoch < ctx.item.reservationEpoch &&
        c.authorActorHash !== ctx.actorHash
      ) {
        return { ...base, authorDisplayName: t('comments_anon', locale) };
      }
      return base;
    });

    return res.json({ comments: mapped, role: ctx.role });
  }),
);

// POST /tg/items/:id/comments — create comment (owner/reserver only)
tgRouter.post(
  '/items/:id/comments',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const ctx = await getItemRole(id, req.tgUser!);
    if (!ctx) return res.status(404).json({ error: 'Item not found' });
    if (ctx.role === 'third_party') return res.status(403).json({ error: 'Forbidden' });

    // Feature gate: comments require PRO — allowed if either owner or commenter has it.
    // Use getEffectiveEntitlements so god-mode is honoured (auto-resolves from DB).
    const ownerEnt = await getEffectiveEntitlements(ctx.item.wishlist.ownerId);
    const commenterEnt = ctx.role === 'owner' ? ownerEnt : await getEffectiveEntitlements(ctx.user.id);
    if (!ownerEnt.plan.features.includes('comments') && !commenterEnt.plan.features.includes('comments')) {
      trackEvent('feature_gate_hit_comments', ctx.user.id);
      return res.status(402).json({ error: 'Pro feature', feature: 'comments', planCode: commenterEnt.plan.code });
    }

    // Check wishlist commentPolicy (subscribers-only restriction)
    if (ctx.role !== 'owner') {
      const itemWishlist = await prisma.item.findUnique({
        where: { id },
        select: { wishlist: { select: { id: true, commentPolicy: true } } },
      });
      if (itemWishlist?.wishlist.commentPolicy === 'SUBSCRIBERS') {
        const isSub = await prisma.wishlistSubscription.findFirst({
          where: { wishlistId: itemWishlist.wishlist.id, subscriberId: ctx.user.id },
          select: { id: true },
        });
        if (!isSub) {
          return res.status(403).json({ error: 'comments_restricted' });
        }
      }
    }

    // Reject archived items
    if (ctx.item.status === 'COMPLETED' || ctx.item.status === 'DELETED') {
      const locale = getRequestLocale(req);
      return res.status(400).json({ error: t('api_comment_archived', locale) });
    }

    // Validate text + optional parentCommentId
    const parsed = z.object({
      text: z.string().min(1).max(300),
      parentCommentId: z.string().cuid().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    const text = parsed.data.text.trim();
    if (!text) {
      const locale = getRequestLocale(req);
      return res.status(400).json({ error: t('api_comment_empty', locale) });
    }

    // Reject emoji/dots only
    const stripped = text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s.…]+/gu, '');
    if (stripped.length === 0) {
      const locale = getRequestLocale(req);
      return res.status(400).json({ error: t('api_comment_meaningful', locale) });
    }

    // Validate parentCommentId (strict — no silent normalization)
    let parent: { id: string; itemId: string; type: 'USER' | 'SYSTEM'; parentCommentId: string | null; authorActorHash: string | null; scheduledDeleteAt: Date | null } | null = null;
    if (parsed.data.parentCommentId) {
      parent = await prisma.comment.findUnique({
        where: { id: parsed.data.parentCommentId },
        select: { id: true, itemId: true, type: true, parentCommentId: true, authorActorHash: true, scheduledDeleteAt: true },
      });
      if (!parent) {
        return res.status(404).json({ error: 'parent_not_found' });
      }
      if (parent.itemId !== id) {
        return res.status(400).json({ error: 'parent_item_mismatch' });
      }
      if (parent.type !== 'USER') {
        return res.status(400).json({ error: 'parent_not_user_comment' });
      }
      if (parent.parentCommentId !== null) {
        // One-level reply only — no silent upgrade. UI should target upstream parent itself.
        return res.status(400).json({ error: 'parent_is_reply' });
      }
      if (parent.scheduledDeleteAt) {
        return res.status(400).json({ error: 'parent_unavailable' });
      }
    }

    // Anti-spam checks
    const now = Date.now();

    // 1. Cooldown 10s
    const lastComment = await prisma.comment.findFirst({
      where: { itemId: id, authorActorHash: ctx.actorHash, type: 'USER' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true, text: true },
    });
    if (lastComment && now - lastComment.createdAt.getTime() < 10_000) {
      return res.status(429).json({ error: t('api_comment_cooldown', getRequestLocale(req)) });
    }

    // 2. Deduplicate
    if (lastComment && lastComment.text === text) {
      return res.status(400).json({ error: t('api_comment_duplicate', getRequestLocale(req)) });
    }

    // 3. Max 3 consecutive without reply
    const recent3 = await prisma.comment.findMany({
      where: { itemId: id, type: 'USER' },
      orderBy: { createdAt: 'desc' },
      take: 3,
      select: { authorActorHash: true },
    });
    if (recent3.length >= 3 && recent3.every((c) => c.authorActorHash === ctx.actorHash)) {
      return res.status(429).json({ error: t('api_comment_wait_reply', getRequestLocale(req)) });
    }

    // 4. Max 10/hour
    const hourAgo = new Date(now - 3600_000);
    const hourCount = await prisma.comment.count({
      where: { itemId: id, authorActorHash: ctx.actorHash, type: 'USER', createdAt: { gte: hourAgo } },
    });
    if (hourCount >= 10) {
      return res.status(429).json({ error: t('api_comment_hour_limit', getRequestLocale(req)) });
    }

    // 5. Max 20/30 days
    const monthAgo = new Date(now - 30 * 86400_000);
    const monthCount = await prisma.comment.count({
      where: { itemId: id, authorActorHash: ctx.actorHash, type: 'USER', createdAt: { gte: monthAgo } },
    });
    if (monthCount >= 20) {
      return res.status(429).json({ error: t('api_comment_month_limit', getRequestLocale(req)) });
    }

    // Determine display name: use reservation display name for reserver, Telegram name for owner
    const displayName = ctx.role === 'reserver'
      ? (ctx.item.reservationEvents[0]?.comment ?? req.tgUser!.first_name)
      : req.tgUser!.first_name;

    const comment = await prisma.comment.create({
      data: {
        itemId: id,
        type: 'USER',
        authorActorHash: ctx.actorHash,
        authorDisplayName: displayName,
        text,
        reservationEpoch: ctx.item.reservationEpoch,
        parentCommentId: parent?.id ?? null,
      },
      select: {
        id: true, type: true, authorActorHash: true, authorDisplayName: true,
        text: true, reservationEpoch: true, createdAt: true,
        parentCommentId: true,
      },
    });

    // Build inline keyboard for the primary comment notification — a "Reply to comment" button
    // that opens the mini app deep-linked to this specific comment with reply mode active.
    const notifLocale: Locale = 'ru'; // notifications to other users default to Russian
    const replyBtnLabel = t('comment_reply_btn', notifLocale);
    const deepLinkUrl = buildCommentReplyDeepLink(id, comment.id);
    const commentReplyMarkup = {
      inline_keyboard: [[{ text: replyBtnLabel, web_app: { url: deepLinkUrl } }]],
    };

    // Notify the other party (recipient of the notification = the one who did NOT write this comment)
    let notifiedRecipientUserId: string | null = null;
    if (ctx.role === 'reserver') {
      // Notify owner
      const owner = await prisma.user.findUnique({
        where: { id: ctx.item.wishlist.ownerId },
        select: { telegramChatId: true, id: true },
      });
      if (owner?.telegramChatId) {
        const key = `${id}:${owner.id}`;
        queueCommentNotification(
          key, owner.telegramChatId, ctx.item.title,
          t('notif_commented_reserver', notifLocale, {
            name: escapeTgHtml(displayName),
            title: escapeTgHtml(ctx.item.title),
            text: escapeTgHtml(text),
          }),
          commentReplyMarkup,
        );
        notifiedRecipientUserId = owner.id;
      }
    } else if (ctx.role === 'owner' && ctx.item.reserverUserId) {
      // Notify reserver
      const reserver = await prisma.user.findUnique({
        where: { id: ctx.item.reserverUserId },
        select: { telegramChatId: true, id: true },
      });
      if (reserver?.telegramChatId) {
        const key = `${id}:${reserver.id}`;
        queueCommentNotification(
          key, reserver.telegramChatId, ctx.item.title,
          t('notif_commented_owner', notifLocale, {
            title: escapeTgHtml(ctx.item.title),
            text: escapeTgHtml(text),
          }),
          commentReplyMarkup,
        );
        notifiedRecipientUserId = reserver.id;
      }
    }
    if (notifiedRecipientUserId) {
      trackEvent('comment_reply_notification_sent', ctx.user.id, {
        itemId: id,
        commentId: comment.id,
        recipientUserId: notifiedRecipientUserId,
        role: ctx.role,
        isReply: parent !== null,
      });
    }

    // ── If this comment is a reply, separately notify the author of the parent comment. ──
    // This is a distinct channel from the "someone commented" notification above — different recipient,
    // different dedupe key, different message. Fire-and-forget.
    if (parent) {
      try {
        // Resolve parent author user: parent.authorActorHash maps to either the owner or the current reserver.
        // We fetch the owner once (needs telegramId to derive their actorHash) and compare.
        let parentAuthorUser: { id: string; telegramChatId: string | null } | null = null;

        const owner = await prisma.user.findUnique({
          where: { id: ctx.item.wishlist.ownerId },
          select: { id: true, telegramChatId: true, telegramId: true },
        });
        const ownerActorHash = owner?.telegramId
          ? tgActorHash(Number(owner.telegramId))
          : null;

        if (ownerActorHash && parent.authorActorHash && secureCompare(ownerActorHash, parent.authorActorHash)) {
          parentAuthorUser = { id: owner!.id, telegramChatId: owner!.telegramChatId };
        } else if (ctx.item.reserverUserId) {
          // Reserver match — only if current reservation is the same actor as the parent comment
          const currentReserverActor = ctx.item.reservationEvents[0]?.actorHash ?? null;
          if (currentReserverActor && parent.authorActorHash && secureCompare(currentReserverActor, parent.authorActorHash)) {
            parentAuthorUser = await prisma.user.findUnique({
              where: { id: ctx.item.reserverUserId },
              select: { id: true, telegramChatId: true },
            });
          }
        }

        if (
          parentAuthorUser &&
          parentAuthorUser.telegramChatId &&
          parentAuthorUser.id !== ctx.user.id // don't self-notify
        ) {
          const replyText = t('notif_comment_reply', notifLocale, {
            title: escapeTgHtml(ctx.item.title),
            ownerName: escapeTgHtml(displayName),
            text: escapeTgHtml(text),
          });
          queueReplyAuthorNotification(
            parent.id,
            parentAuthorUser.id,
            parentAuthorUser.telegramChatId,
            replyText,
            commentReplyMarkup,
          );
          trackEvent('comment_reply_sent_notification_to_author', ctx.user.id, {
            itemId: id,
            parentCommentId: parent.id,
            replyCommentId: comment.id,
            recipientUserId: parentAuthorUser.id,
          });
        } else {
          trackEvent('comment_reply_sent_notification_failed', ctx.user.id, {
            itemId: id,
            parentCommentId: parent.id,
            reason: !parentAuthorUser ? 'author_not_resolved' :
                    !parentAuthorUser.telegramChatId ? 'no_chat_id' :
                    'self_reply',
          });
        }
      } catch (err) {
        // never fail the main POST because of notification side-effects
        logger.warn({ err, parentCommentId: parent.id }, 'reply-author notification failed');
        trackEvent('comment_reply_sent_notification_failed', ctx.user.id, {
          itemId: id,
          parentCommentId: parent.id,
          reason: 'exception',
        });
      }
    }

    return res.status(201).json({ comment: { ...comment, createdAt: comment.createdAt.toISOString(), parentPreview: null } });
  }),
);

// DELETE /tg/items/:id/comments/:commentId — delete comment
tgRouter.delete(
  '/items/:id/comments/:commentId',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const commentId = req.params.commentId ?? '';
    if (!id || !commentId) return res.status(400).json({ error: 'Missing ids' });

    const ctx = await getItemRole(id, req.tgUser!);
    if (!ctx) return res.status(404).json({ error: 'Item not found' });
    if (ctx.role === 'third_party') return res.status(403).json({ error: 'Forbidden' });

    const comment = await prisma.comment.findUnique({
      where: { id: commentId },
      select: { id: true, type: true, authorActorHash: true, itemId: true, parentCommentId: true },
    });
    if (!comment || comment.itemId !== id) return res.status(404).json({ error: 'Comment not found' });

    // System comments cannot be deleted manually
    if (comment.type === 'SYSTEM') return res.status(403).json({ error: t('api_system_cant_delete', getRequestLocale(req)) });

    // Owner can delete any USER comment; reserver can delete only own
    if (ctx.role === 'reserver' && comment.authorActorHash !== ctx.actorHash) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // If this is a top-level comment with replies, they will be SET NULL'd by FK and become
    // orphan normal comments in the UI. Track this to monitor how often it happens.
    let orphanedRepliesCount = 0;
    if (comment.parentCommentId === null) {
      orphanedRepliesCount = await prisma.comment.count({ where: { parentCommentId: commentId } });
    }

    await prisma.comment.delete({ where: { id: commentId } });
    if (orphanedRepliesCount > 0) {
      trackEvent('comment_deleted_with_replies', ctx.user.id, {
        itemId: id,
        commentId,
        orphanedRepliesCount,
        role: ctx.role,
      });
    }
    return res.json({ ok: true });
  }),
);

// POST /tg/items/:id/comments/mark-read — mark comments as read for current user
tgRouter.post(
  '/items/:id/comments/mark-read',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const user = await getOrCreateTgUser(req.tgUser!);

    await prisma.commentReadCursor.upsert({
      where: { userId_itemId: { userId: user.id, itemId: id } },
      update: { lastReadAt: new Date() },
      create: { userId: user.id, itemId: id, lastReadAt: new Date() },
    });

    return res.json({ ok: true });
  }),
);

// POST /tg/items/:id/hint — create a hint wave (Pro feature, owner-only)
//
// Design (rewritten 2026-05-02 after user-reported "first click hangs 10 s,
// second click works"):
//
//   1. The endpoint must respond fast (<3 s) regardless of Telegram health.
//      The previous implementation awaited sendTgBotMessage's full 6 s × 2
//      retry budget on the synchronous request path, then returned 502 +
//      rolled back the hint to CANCELLED on TG unreachable. From the user's
//      seat that meant a 12 s spinner with no visible feedback before they
//      could retry.
//
//   2. The endpoint must be idempotent on rapid re-tap. If the user clicks
//      "hint friends" again before the first attempt has run all the way
//      through (delivered keyboard → user picked friends → bot processed),
//      we must return the existing active SENT hint instead of minting a
//      new one — otherwise we burn a slot in the per-item / per-day anti-
//      spam counter for what is logically the same operation.
//
//   3. Keyboard delivery is best-effort. We fire sendTgBotMessage and race
//      it against a 3 s budget; whichever resolves first decides the API
//      response. The fetch keeps running in the background past 3 s — TG
//      may still deliver after the API has already returned 200, in which
//      case the user sees the keyboard appear in their bot chat shortly
//      after navigating there. Outcome is logged via .then/.catch so the
//      narrative survives in bot.log.
//
//   4. We DO NOT roll back the hint to CANCELLED on send failure. If the
//      first send didn't land, the user can re-tap from the Mini App; the
//      idempotent path returns the same hint and re-triggers a delivery
//      attempt. Eventually one attempt succeeds and the user sees the
//      picker.
tgRouter.post(
  '/items/:id/hint',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const locale = getRequestLocale(req);

    // 1. Feature gate: hints require PRO (godMode overrides to PRO)
    const ent = await getUserEntitlement(user.id, user.godMode);
    if (!ent.plan.features.includes('hints')) {
      trackEvent('feature_gate_hit_hints', user.id);
      return res.status(402).json({ error: 'Pro feature', feature: 'hints', planCode: ent.plan.code });
    }

    // 2. Load item + verify ownership
    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, title: true, status: true, wishlist: { select: { ownerId: true, slug: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // 2b. Check owner's hintsEnabled setting
    const ownerProfile = await prisma.userProfile.findUnique({
      where: { userId: user.id },
      select: { hintsEnabled: true },
    });
    if (ownerProfile?.hintsEnabled === false) {
      return res.status(403).json({ error: 'hints_disabled' });
    }

    // 3. Item must be AVAILABLE (not reserved/completed/deleted)
    if (item.status !== 'AVAILABLE') {
      return res.status(400).json({ error: 'item_not_available', message: t('api_hint_item_not_available', locale) });
    }

    const senderChatId = user.telegramChatId;

    // ─── Idempotent fast-path ─────────────────────────────────────────────
    // If this user already has an active SENT hint for this item that
    // hasn't expired, reuse it. The repeat tap re-triggers a best-effort
    // keyboard delivery (recovery for the case where the first send
    // didn't land), but we do NOT create a second Hint row — that would
    // burn an anti-spam slot for the same logical operation and leave
    // multiple "active" hints for the bot to disambiguate on
    // users_shared.
    const now = new Date();
    const existing = await prisma.hint.findFirst({
      where: {
        senderUserId: user.id,
        itemId: id,
        status: 'SENT',
        expiresAt: { gt: now },
      },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true },
    });
    if (existing) {
      logger.info(
        { userId: user.id, itemId: id, hintId: existing.id, ageMs: now.getTime() - existing.createdAt.getTime() },
        'hint_create_idempotent_hit',
      );
      // Re-attempt keyboard delivery (best-effort). User probably tapped
      // again because the first send didn't reach their bot chat. The
      // bounded-race pattern below means we still return ≤ 3 s.
      if (senderChatId) {
        sendHintPickerKeyboard(senderChatId, item.title, existing.id, locale);
      }
      return res.json({ hintId: existing.id, status: 'pending_selection', existing: true });
    }

    // 4. Anti-spam: max 3 hint waves per item per 30 days
    if (!user.godMode) {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const itemHintCount = await prisma.hint.count({
        where: { itemId: id, senderUserId: user.id, status: { in: ['SENT', 'DELIVERED'] }, createdAt: { gte: thirtyDaysAgo } },
      });
      if (itemHintCount >= 3) {
        const oldestItemHint = await prisma.hint.findFirst({
          where: { itemId: id, senderUserId: user.id, status: { in: ['SENT', 'DELIVERED'] }, createdAt: { gte: thirtyDaysAgo } },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        });
        const retryAfterSeconds = oldestItemHint
          ? Math.max(0, Math.ceil((oldestItemHint.createdAt.getTime() + 30 * 24 * 60 * 60 * 1000 - Date.now()) / 1000))
          : 0;
        return res.status(429).json({
          error: 'item_hint_limit',
          message: t('api_hint_item_limit', locale),
          retryAfterSeconds,
        });
      }

      // 5. Anti-spam: max 5 hints per sender per day
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const dailyHintCount = await prisma.hint.count({
        where: { senderUserId: user.id, status: { in: ['SENT', 'DELIVERED'] }, createdAt: { gte: oneDayAgo } },
      });
      if (dailyHintCount >= 5) {
        const oldestDailyHint = await prisma.hint.findFirst({
          where: { senderUserId: user.id, status: { in: ['SENT', 'DELIVERED'] }, createdAt: { gte: oneDayAgo } },
          orderBy: { createdAt: 'asc' },
          select: { createdAt: true },
        });
        const retryAfterSeconds = oldestDailyHint
          ? Math.max(0, Math.ceil((oldestDailyHint.createdAt.getTime() + 24 * 60 * 60 * 1000 - Date.now()) / 1000))
          : 0;
        return res.status(429).json({
          error: 'daily_hint_limit',
          message: t('api_hint_daily_limit', locale),
          retryAfterSeconds,
        });
      }
    }

    // 6. Create hint record
    const hint = await prisma.hint.create({
      data: {
        itemId: id,
        senderUserId: user.id,
        status: 'SENT',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });
    logger.info({ userId: user.id, itemId: id, hintId: hint.id }, 'hint_create_completed');
    trackEvent('hint_created', user.id, { itemId: id, hintId: hint.id });

    // 7. Send contact picker (best-effort, bounded race). Keyboard arrives
    //    in the user's bot chat from the API process. We don't wait for the
    //    full TG round-trip — return within 3 s regardless. If TG is slow
    //    but eventually responds, the keyboard still arrives by the time
    //    the user has navigated to bot chat.
    if (senderChatId) {
      sendHintPickerKeyboard(senderChatId, item.title, hint.id, locale);
    } else {
      // No telegramChatId on user means they have not /start-ed the bot
      // even once. There is no chat to send a picker into. Tell the
      // client; the Mini App can show a "open the bot first" toast.
      logger.warn({ userId: user.id, hintId: hint.id }, 'hint_prompt_send_skipped_no_chat_id');
      return res.json({ hintId: hint.id, status: 'pending_selection', noBotChat: true });
    }

    return res.json({ hintId: hint.id, status: 'pending_selection' });
  }),
);

/**
 * Best-effort fire-and-forget delivery of the contact-picker keyboard to
 * the sender's bot chat. Used by both the create-hint and idempotent
 * re-attempt paths.
 *
 *   - Single attempt (no internal retry) so the bounded race is honest:
 *     either we hear back from TG in ~3 s or we let the request live on
 *     in the background. Mini App is unblocked at the race timeout.
 *   - Underlying fetch has a long fallback timeout (12 s) so a slow but
 *     responsive TG still delivers — Mini App has already navigated to
 *     bot chat by then, and the user sees the keyboard appear.
 *   - Outcome is logged via .then / .catch attached to the original
 *     promise so the eventual ok/fail lands in bot.log even after the
 *     race resolves.
 */
function sendHintPickerKeyboard(
  senderChatId: string,
  itemTitle: string,
  hintId: string,
  locale: Locale,
): void {
  logger.info({ senderChatId, hintId }, 'hint_prompt_send_started');
  const sendPromise = sendTgBotMessage(
    senderChatId,
    t('api_hint_picker_msg', locale, { title: itemTitle }),
    {
      keyboard: [[{
        text: t('bot_select_recipients', locale),
        request_users: { request_id: Number(hintId.slice(-6).replace(/\D/g, '') || '1'), user_is_bot: false, max_quantity: 10 },
      }]],
      resize_keyboard: true,
      one_time_keyboard: true,
      is_persistent: true,
    },
    { timeoutMs: 12000, maxAttempts: 1 },
  );
  // Attach handlers BEFORE racing so the outcome is captured even after
  // the race timer wins. .catch on the original promise keeps the pending
  // task alive until completion (Node won't GC it).
  sendPromise.then((sent) => {
    if (sent) {
      logger.info({ senderChatId, hintId }, 'hint_prompt_send_succeeded');
    } else {
      logger.warn({ senderChatId, hintId }, 'hint_prompt_send_failed');
    }
  }).catch((err) => {
    logger.error({ err, senderChatId, hintId }, 'hint_prompt_send_threw');
  });
  // (No await — caller returns 200 immediately, race happens in caller
  // if needed. For now, intentionally fire-and-forget: the previous
  // synchronous-await flow is exactly what made first-click hang 12 s.)
}

// GET /tg/hints/:hintId — poll hint delivery status (for mini app)
tgRouter.get(
  '/hints/:hintId',
  asyncHandler(async (req, res) => {
    const hintId = req.params.hintId ?? '';
    if (!hintId) return res.status(400).json({ error: 'Missing hint id' });

    const user = await getOrCreateTgUser(req.tgUser!);

    const hint = await prisma.hint.findFirst({
      where: { id: hintId, senderUserId: user.id },
      select: {
        id: true,
        status: true,
        sentCount: true,
        pendingCount: true,
        deliveredAt: true,
        item: { select: { id: true, title: true, status: true } },
      },
    });

    if (!hint) return res.status(404).json({ error: 'Hint not found' });

    return res.json({
      hintId: hint.id,
      status: hint.status,
      sentCount: hint.sentCount,
      pendingCount: hint.pendingCount,
      deliveredAt: hint.deliveredAt,
      itemTitle: hint.item.title,
    });
  }),
);

// POST /tg/items/:id/photo — upload or replace item photo (with sharp processing)
tgRouter.post(
  '/items/:id/photo',
  upload.single('photo'),
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, imageUrl: true, wishlist: { select: { ownerId: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // Process image with sharp: compress, strip EXIF, resize
    const [full, thumb] = await Promise.all([
      processImage(req.file.buffer, { maxDim: 1600, quality: 80, suffix: 'full' }),
      processImage(req.file.buffer, { maxDim: 480, quality: 70, suffix: 'thumb' }),
    ]);

    // Delete the previous local upload if it exists.
    deleteUploadFile(item.imageUrl);

    const photoUrl = `/api/uploads/${full.filename}`;
    await prisma.item.update({ where: { id }, data: { imageUrl: photoUrl } });

    return res.json({ photoUrl, thumbUrl: `/api/uploads/${thumb.filename}`, width: full.width, height: full.height, sizeBytes: full.sizeBytes });
  }),
);

// DELETE /tg/items/:id/photo — remove item photo
tgRouter.delete(
  '/items/:id/photo',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, imageUrl: true, wishlist: { select: { ownerId: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    deleteUploadFile(item.imageUrl);
    await prisma.item.update({ where: { id }, data: { imageUrl: null } });

    return res.json({ ok: true });
  }),
);

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

// ─── Import URL: TG endpoint ────────────────────────────────────────────────

const importUrlLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.tgUser ? String(req.tgUser.id) : 'anon',
  handler: (_req: Request, res: Response) => {
    const locale = getRequestLocale(_req);
    res.status(429).json({ error: t('api_import_rate_limit', locale) });
  },
  validate: false,
});

tgRouter.post(
  '/import-url',
  importUrlLimiter,
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      url: z.string().min(1).max(2048),
      note: z.string().max(500).optional(),
      source: z.string().max(20).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    // Validate URL first
    try { validateUrl(parsed.data.url); } catch (err: any) {
      return res.status(400).json({ error: err.message || 'Invalid URL' });
    }

    const user = await getOrCreateTgUser(req.tgUser!);

    // Feature gate: import by URL requires PRO
    const ent = await getUserEntitlement(user.id);
    if (!ent.plan.features.includes('url_import')) {
      trackEvent('feature_gate_hit_url_import', user.id);
      return res.status(402).json({ error: 'Pro feature', feature: 'url_import', planCode: ent.plan.code });
    }

    let importDomain = '';
    try { importDomain = new URL(parsed.data.url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }

    trackAnalyticsEvent({
      event: 'import.started',
      userId: user.id,
      props: { domain: importDomain },
    });

    try {
      const noCache = req.headers['x-parse-no-cache'] === '1';
      const result = await importUrlForUser(user.id, parsed.data.url, parsed.data.note, parsed.data.source || 'miniapp', noCache ? { noCache: true } : undefined);

      trackAnalyticsEvent({
        event: 'import.succeeded',
        userId: user.id,
        props: { domain: importDomain, hasPrice: !!result.item.price, hasTitle: !!result.item.title },
      });

      return res.status(201).json(result);
    } catch (err: any) {
      trackAnalyticsEvent({
        event: 'import.failed',
        userId: user.id,
        props: { domain: importDomain, reason: String(err.message ?? 'unknown').slice(0, 200) },
      });

      if (err.statusCode === 402) {
        return res.status(402).json({ error: t('api_import_too_many', getRequestLocale(req)), limit: DRAFTS_ITEM_LIMIT });
      }
      throw err;
    }
  }),
);

// ─── Move item between wishlists ─────────────────────────────────────────────

tgRouter.post(
  '/items/:id/move',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const parsed = z.object({
      targetWishlistId: z.string().min(1),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getUserEntitlement(user.id);

    // Check item ownership
    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, wishlistId: true, isDemo: true, originType: true, wishlist: { select: { ownerId: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // Check target wishlist ownership
    const targetWl = await prisma.wishlist.findUnique({
      where: { id: parsed.data.targetWishlistId },
      select: { id: true, ownerId: true, type: true },
    });
    if (!targetWl) return res.status(404).json({ error: 'Target wishlist not found' });
    if (targetWl.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // Check plan limit on target wishlist (only for REGULAR wishlists).
    // Capacity is counted by PLACEMENT (shared wishes count against every host).
    if (targetWl.type === 'REGULAR') {
      // Check if target wishlist is writable
      if (!(await isWishlistWritable(user.id, targetWl.id, ent.plan.wishlists))) {
        return res.status(402).json({ error: 'Wishlist is read-only on current plan', planCode: ent.plan.code });
      }
      // Skip capacity check if item is already placed in target (no-op move)
      const alreadyPlaced = await prisma.wishlistItemPlacement.findUnique({
        where: { wishlistId_itemId: { wishlistId: targetWl.id, itemId: id } },
        select: { itemId: true },
      });
      if (!alreadyPlaced) {
        const targetItemCount = await countActivePlacementsInWishlist(targetWl.id);
        if (targetItemCount >= ent.plan.items) {
          return res.status(402).json({ error: t('api_wishlist_items_limit', getRequestLocale(req)), limit: ent.plan.items, planCode: ent.plan.code });
        }
      }
    }

    // Migrate placement from source (item.wishlistId) to target, keeping other
    // placements intact for shared wishes. Also syncs legacy Item.wishlistId.
    await relocateItemPrimary(id, item.wishlistId, parsed.data.targetWishlistId);

    const updated = await prisma.item.findUnique({
      where: { id },
      select: {
        id: true, wishlistId: true, title: true, url: true, priceText: true,
        imageUrl: true, priority: true, status: true, description: true,
        sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
      },
    });
    if (!updated) return res.status(404).json({ error: 'Item not found' });

    // Onboarding: demo item moved to a regular wishlist → complete onboarding
    if (item.isDemo && item.originType === 'DEMO' && targetWl.type === 'REGULAR') {
      void (async () => {
        const onboardingState = await prisma.userOnboardingState.findUnique({
          where: { userId_onboardingKey_version: { userId: user.id, onboardingKey: ONBOARDING_KEY, version: ONBOARDING_VERSION } },
        });
        if (onboardingState?.status === 'IN_PROGRESS' && onboardingState.demoItemId === id) {
          await completeOnboarding(user.id, 'demo_moved_to_user_wishlist');
        }
      })();
    }

    return res.json({ item: mapTgItem(updated) });
  }),
);

// ─── Copy single item to another wishlist ────────────────────────────────────

tgRouter.post(
  '/items/:id/copy',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const parsed = z.object({ targetWishlistId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id);

    // Verify source item ownership
    const item = await prisma.item.findUnique({
      where: { id },
      select: {
        id: true, title: true, description: true, url: true, priceText: true,
        currency: true, priority: true, imageUrl: true, sourceUrl: true,
        sourceDomain: true, importMethod: true, status: true,
        wishlist: { select: { ownerId: true } },
      },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (item.status === 'DELETED') return res.status(400).json({ error: 'Cannot copy deleted item' });

    // Verify target wishlist
    const targetWl = await prisma.wishlist.findUnique({
      where: { id: parsed.data.targetWishlistId },
      select: { id: true, ownerId: true, type: true, archivedAt: true, title: true },
    });
    if (!targetWl || targetWl.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (targetWl.archivedAt) return res.status(400).json({ error: 'Cannot copy to archived wishlist' });
    if (targetWl.type === 'SYSTEM_DRAFTS') return res.status(400).json({ error: 'Cannot copy to system wishlist' });

    // Check item limit on target
    if (targetWl.type === 'REGULAR') {
      if (!(await isWishlistWritable(user.id, targetWl.id, ent.effectiveWishlistLimit))) {
        return res.status(402).json({ error: 'Wishlist is read-only on current plan', planCode: ent.plan.code });
      }
      const effectiveItemLimit = ent.plan.items + (ent.extraItemsPerWishlist[targetWl.id] ?? 0);
      const currentCount = await countActivePlacementsInWishlist(targetWl.id);
      if (currentCount >= effectiveItemLimit) {
        return res.status(402).json({ error: t('api_wishlist_items_limit', getRequestLocale(req)), limit: effectiveItemLimit, planCode: ent.plan.code });
      }
    }

    // Create clean copy — no reservation/comment/hint data (semantically "duplicate":
    // a new, independent Item row. This endpoint is the explicit branch for users
    // who want to split state. To share state across wishlists, use POST /items/:id/placements.)
    const copy = await prisma.item.create({
      data: {
        wishlistId: targetWl.id,
        title: item.title,
        description: item.description,
        url: item.url,
        priceText: item.priceText,
        currency: item.currency,
        priority: item.priority,
        imageUrl: item.imageUrl,
        sourceUrl: item.sourceUrl,
        sourceDomain: item.sourceDomain,
        importMethod: item.importMethod,
        status: 'AVAILABLE',
      },
      select: {
        id: true, wishlistId: true, title: true, url: true, priceText: true,
        imageUrl: true, priority: true, status: true, description: true,
        sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
      },
    });
    // Dual-write: mirror placement for the new Item (duplicate starts fresh).
    await ensureItemPlacement(prisma, { wishlistId: targetWl.id, itemId: copy.id });
    trackEvent('wish_duplicated', user.id, { sourceItemId: id, newItemId: copy.id, targetWishlistId: targetWl.id });

    return res.status(201).json({ item: mapTgItem(copy), targetWishlistTitle: targetWl.title });
  }),
);

// ─── Item placements (shared wishes) ─────────────────────────────────────────
// A Wish (Item row) can be placed in multiple wishlists via WishlistItemPlacement.
// Title/description/url/price/image/status/reservation/comments are shared across
// all placements; categoryId and position are per-placement. Capacity is counted
// in placements (so a shared wish counts against every wishlist it lives in).

// GET /tg/items/:id/placements — list wishlists where this wish is currently placed
tgRouter.get(
  '/items/:id/placements',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const user = await getOrCreateTgUser(req.tgUser!);

    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, wishlistId: true, status: true, wishlist: { select: { ownerId: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const placements = await prisma.wishlistItemPlacement.findMany({
      where: { itemId: id },
      orderBy: { addedAt: 'asc' },
      select: {
        wishlistId: true,
        categoryId: true,
        position: true,
        addedAt: true,
        wishlist: { select: { id: true, title: true, type: true, archivedAt: true } },
        category: { select: { id: true, name: true } },
      },
    });

    // Self-heal primary pointer if somehow desynced: if item.wishlistId has no matching
    // placement, but placements exist, mark the first placement as primary in the response.
    const hasPrimaryPlacement = placements.some(p => p.wishlistId === item.wishlistId);
    const primaryWishlistId = hasPrimaryPlacement ? item.wishlistId : placements[0]?.wishlistId ?? null;

    return res.json({
      placements: placements.map(p => ({
        wishlistId: p.wishlistId,
        wishlistTitle: p.wishlist.title,
        wishlistType: p.wishlist.type,
        archivedAt: p.wishlist.archivedAt ? p.wishlist.archivedAt.toISOString() : null,
        categoryId: p.categoryId,
        categoryName: p.category?.name ?? null,
        position: p.position,
        addedAt: p.addedAt.toISOString(),
        isPrimary: p.wishlistId === primaryWishlistId,
      })),
    });
  }),
);

// POST /tg/items/:id/placements — place an existing wish into an additional wishlist.
// Does NOT create a copy: same Item id, shared state, per-placement category & position.
tgRouter.post(
  '/items/:id/placements',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing item id' });

    const parsed = z.object({ wishlistId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id);

    // Verify item ownership + status
    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, status: true, wishlist: { select: { ownerId: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (item.status === 'DELETED') return res.status(400).json({ error: 'Cannot place a deleted wish' });

    // Verify target wishlist
    const target = await prisma.wishlist.findUnique({
      where: { id: parsed.data.wishlistId },
      select: { id: true, ownerId: true, type: true, archivedAt: true, title: true },
    });
    if (!target) return res.status(404).json({ error: 'Wishlist not found' });
    if (target.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });
    if (target.type !== 'REGULAR') return res.status(400).json({ error: 'Cannot place into non-regular wishlist' });
    if (target.archivedAt) return res.status(400).json({ error: 'Cannot place into archived wishlist' });

    // Already placed there? Idempotent-ish: 409 so the client can re-render without error noise
    const existing = await prisma.wishlistItemPlacement.findUnique({
      where: { wishlistId_itemId: { wishlistId: target.id, itemId: id } },
      select: { wishlistId: true, itemId: true, position: true, categoryId: true },
    });
    if (existing) return res.status(409).json({ error: 'Already placed in this wishlist', placement: existing });

    // Plan checks on target
    if (!(await isWishlistWritable(user.id, target.id, ent.effectiveWishlistLimit))) {
      return res.status(402).json({ error: 'Wishlist is read-only on current plan', planCode: ent.plan.code });
    }
    // Capacity via PLACEMENT count (shared placements count too) + active-status join
    const effectiveItemLimit = ent.plan.items + (ent.extraItemsPerWishlist[target.id] ?? 0);
    const currentCount = await prisma.wishlistItemPlacement.count({
      where: { wishlistId: target.id, item: { status: { in: [...ACTIVE_STATUSES] } } },
    });
    if (currentCount >= effectiveItemLimit) {
      trackEvent('feature_gate_hit_item_limit', user.id, {
        plan: ent.plan.code, count: currentCount, limit: effectiveItemLimit, context: 'placement_added',
      });
      return res.status(402).json({ error: 'Plan limit reached', limit: effectiveItemLimit, planCode: ent.plan.code });
    }

    const placement = await ensureItemPlacement(prisma, { wishlistId: target.id, itemId: id });
    const placementCount = await countItemPlacements(id);

    trackEvent('placement_added', user.id, {
      itemId: id, wishlistId: target.id, totalPlacements: placementCount,
    });

    return res.status(201).json({
      placement: {
        wishlistId: placement.wishlistId,
        itemId: placement.itemId,
        position: placement.position,
        categoryId: placement.categoryId,
      },
      placementCount,
      targetWishlistTitle: target.title,
    });
  }),
);

// DELETE /tg/items/:id/placements/:wishlistId — remove the wish from one wishlist.
// If it's the last placement, return 409 (client should delete the wish instead).
// If the removed placement is the legacy primary (Item.wishlistId), reassign to the
// oldest remaining placement so downstream legacy reads stay consistent.
tgRouter.delete(
  '/items/:id/placements/:wishlistId',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const wishlistId = req.params.wishlistId ?? '';
    if (!id || !wishlistId) return res.status(400).json({ error: 'Missing params' });

    const user = await getOrCreateTgUser(req.tgUser!);

    // Verify item + ownership (through any placement or primary wishlist)
    const item = await prisma.item.findUnique({
      where: { id },
      select: { id: true, wishlistId: true, wishlist: { select: { ownerId: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    // Verify placement exists on that wishlist
    const placement = await prisma.wishlistItemPlacement.findUnique({
      where: { wishlistId_itemId: { wishlistId, itemId: id } },
      select: { wishlistId: true, itemId: true },
    });
    if (!placement) return res.status(404).json({ error: 'Placement not found' });

    // Last-placement guard: user must delete the item itself instead of this placement.
    const total = await countItemPlacements(id);
    if (total <= 1) {
      return res.status(409).json({ error: 'last_placement', message: 'Cannot remove last placement — delete the wish instead' });
    }

    await prisma.$transaction(async (tx) => {
      await tx.wishlistItemPlacement.delete({
        where: { wishlistId_itemId: { wishlistId, itemId: id } },
      });

      // If this was the legacy primary, reassign to oldest remaining placement so
      // Item.wishlistId / position / categoryId stay consistent with an existing placement.
      if (item.wishlistId === wishlistId) {
        const nextPrimary = await tx.wishlistItemPlacement.findFirst({
          where: { itemId: id },
          orderBy: { addedAt: 'asc' },
          select: { wishlistId: true, position: true, categoryId: true },
        });
        if (nextPrimary) {
          await tx.item.update({
            where: { id },
            data: {
              wishlistId: nextPrimary.wishlistId,
              position: nextPrimary.position,
              categoryId: nextPrimary.categoryId,
            },
          });
        }
      }
    });

    const placementCount = await countItemPlacements(id);
    trackEvent('placement_removed', user.id, {
      itemId: id, wishlistId, totalPlacements: placementCount,
    });

    return res.json({ ok: true, placementCount });
  }),
);

// ─── Billing & Plan endpoints ────────────────────────────────────────────────

// GET /tg/me/plan — current user's plan, subscription, effective limits, and add-ons
tgRouter.get(
  '/me/plan',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    const wishlistCount = await prisma.wishlist.count({ where: { ownerId: user.id, type: 'REGULAR' } });

    // God mode whitelist: only these Telegram IDs can toggle
    const godModeAllowedIds = (process.env.GOD_MODE_TELEGRAM_IDS ?? '').split(',').filter(Boolean);
    const canGodMode = user.telegramId ? godModeAllowedIds.includes(user.telegramId) : false;

    // Reservation Pro feature gate
    const reservationPro = hasReservationPro(user, ent.isPro, ent.addOns);
    const reservationBeta = isReservationBeta(user);

    // Summarize add-ons for frontend
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
      subscription: ent.subscription,
      proSource: ent.proSource,
      promoPro: ent.promoPro,
      usage: { wishlists: wishlistCount },
      proPriceStars: PRO_PRICE_XTR,
      proYearlyPriceStars: PRO_YEARLY_PRICE_XTR,
      godMode: user.godMode,
      canGodMode,
      // Effective entitlements layer
      addOns: {
        extraWishlistSlots,
        extraSubscriptionSlots,
        seasonalWishlists: [...ent.seasonalWishlists],
      },
      credits: {
        hintCredits: ent.hintCredits,
        importCredits: ent.importCredits,
      },
      skus: Object.values(ONE_TIME_SKUS).map(s => ({
        code: s.code,
        price: s.price,
        type: s.type,
        targetRequired: s.targetRequired,
      })),
      reservationPro,
      reservationBeta,
    });
  }),
);

// ─── Promo code helpers ──────────────────────────────────────────────────────

/** Normalize promo code input: trim, uppercase, remove spaces and dashes */
function normalizePromoCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s\-]/g, '');
}

// POST /tg/promo/apply — apply a promotional code
const promoLimiter = rateLimit({ windowMs: 60_000, limit: 5, keyGenerator: (req: any) => req.tgUser?.id ?? 'anon', standardHeaders: 'draft-7', legacyHeaders: false });
tgRouter.post(
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
tgRouter.get(
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

// GET /tg/me/profile — user profile with stats
tgRouter.get(
  '/me/profile',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const locale = getRequestLocale(req);
    const profile = await getOrCreateProfile(user.id, locale);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);

    // God mode whitelist
    const godModeAllowedIds = (process.env.GOD_MODE_TELEGRAM_IDS ?? '').split(',').filter(Boolean);
    const canGodMode = user.telegramId ? godModeAllowedIds.includes(user.telegramId) : false;

    // Stats
    const [wishlists, totalWishes, regularReservedByMe, santaReservedByMe, archived] = await Promise.all([
      prisma.wishlist.count({ where: { ownerId: user.id, type: 'REGULAR', archivedAt: null } }),
      // Same formula as /tg/wishlists → itemCount:
      // only active (non-archived) REGULAR wishlists, only ACTIVE_STATUSES items.
      // SYSTEM_DRAFTS and archived wishlists are excluded to keep both counters in sync.
      prisma.item.count({
        where: {
          wishlist: { ownerId: user.id, type: 'REGULAR', archivedAt: null },
          status: { in: [...ACTIVE_STATUSES] },
        },
      }),
      prisma.item.count({
        where: { reserverUserId: user.id, status: 'RESERVED' },
      }),
      prisma.santaItemReservation.count({
        where: {
          assignment: {
            giver: { userId: user.id },
            giftStatus: { notIn: ['RECEIVED', 'ORPHANED'] },
            round: { campaign: { status: { not: 'CANCELLED' } } },
          },
        },
      }),
      prisma.item.count({
        where: {
          wishlist: { ownerId: user.id },
          status: { in: ['COMPLETED', 'DELETED'] },
        },
      }),
    ]);

    return res.json({
      profile: {
        displayName: profile.displayName,
        username: profile.username,
        bio: profile.bio,
        avatarUrl: profile.avatarUrl,
        avatarThumbUrl: profile.avatarThumbUrl,
        avatarUpdatedAt: profile.avatarUpdatedAt?.toISOString() ?? null,
        avatarPublic: profile.avatarPublic,
        birthday: profile.birthday?.toISOString() ?? null,
        hideYear: profile.hideYear,
        defaultCurrency: profile.defaultCurrency,
        language: profile.language ?? null,
        // Owner-only — never exposed in public/share API responses
        supportId: profile.supportId,
      },
      stats: {
        wishlists,
        wishlistsLimit: ent.effectiveWishlistLimit,
        totalWishes,
        wishesLimit: ent.plan.items,
        reservedByMe: regularReservedByMe + santaReservedByMe,
        archived,
      },
      plan: {
        code: ent.plan.code,
        wishlists: ent.effectiveWishlistLimit,
        items: ent.plan.items,
        subscriptions: ent.effectiveSubscriptionLimit,
        participants: ent.plan.participants,
        features: [...ent.plan.features],
      },
      subscription: ent.subscription,
      godMode: user.godMode,
      canGodMode,
    });
  }),
);

// PATCH /tg/me/profile — update user profile
tgRouter.patch(
  '/me/profile',
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      displayName: z.string().min(1).max(100).nullable().optional(),
      username: z.string().min(3).max(30).regex(/^[a-zA-Z0-9_]+$/).nullable().optional(),
      bio: z.string().max(300).nullable().optional(),
      birthday: z.string().nullable().optional(),
      hideYear: z.boolean().optional(),
      avatarPublic: z.boolean().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const locale = getRequestLocale(req);

    // Check username uniqueness (skip if clearing username)
    if (parsed.data.username !== undefined && parsed.data.username !== null) {
      const currentProfile = await getOrCreateProfile(user.id, locale);
      if (parsed.data.username !== currentProfile.username) {
        const existing = await prisma.userProfile.findUnique({ where: { username: parsed.data.username } });
        if (existing && existing.userId !== user.id) {
          return res.status(409).json({ error: t('profile_username_taken', locale) });
        }
      }
    }

    const updateData: Record<string, unknown> = {};
    if (parsed.data.displayName !== undefined) updateData.displayName = parsed.data.displayName;
    if (parsed.data.username !== undefined) updateData.username = parsed.data.username;
    if (parsed.data.bio !== undefined) updateData.bio = parsed.data.bio;
    if (parsed.data.birthday !== undefined) updateData.birthday = parsed.data.birthday ? new Date(parsed.data.birthday) : null;
    if (parsed.data.hideYear !== undefined) updateData.hideYear = parsed.data.hideYear;
    if (parsed.data.avatarPublic !== undefined) updateData.avatarPublic = parsed.data.avatarPublic;

    const profile = await prisma.userProfile.upsert({
      where: { userId: user.id },
      update: updateData,
      create: {
        userId: user.id,
        defaultCurrency: locale === 'ru' ? 'RUB' : 'USD',
        ...updateData,
      },
    });

    return res.json({
      profile: {
        displayName: profile.displayName,
        username: profile.username,
        bio: profile.bio,
        avatarUrl: profile.avatarUrl,
        avatarThumbUrl: profile.avatarThumbUrl,
        avatarUpdatedAt: profile.avatarUpdatedAt?.toISOString() ?? null,
        avatarPublic: profile.avatarPublic,
        birthday: profile.birthday?.toISOString() ?? null,
        hideYear: profile.hideYear,
        defaultCurrency: profile.defaultCurrency,
      },
    });
  }),
);

// POST /tg/me/profile/avatar — upload profile avatar (generates full 512px + thumb 256px)
tgRouter.post(
  '/me/profile/avatar',
  upload.single('avatar'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const locale = getRequestLocale(req);
    const profile = await getOrCreateProfile(user.id, locale);

    // Process image — generate full (512px) and thumbnail (256px) simultaneously
    const [full, thumb] = await Promise.all([
      processImage(req.file.buffer, { maxDim: 512, quality: 80, suffix: 'avatar' }),
      processImage(req.file.buffer, { maxDim: 256, quality: 75, suffix: 'avatar-thumb' }),
    ]);

    // Delete old avatar files if they exist
    deleteUploadFile(profile.avatarUrl);
    deleteUploadFile(profile.avatarThumbUrl);

    const avatarUrl = `/api/uploads/${full.filename}`;
    const avatarThumbUrl = `/api/uploads/${thumb.filename}`;
    const avatarUpdatedAt = new Date();

    await prisma.userProfile.update({
      where: { userId: user.id },
      data: { avatarUrl, avatarThumbUrl, avatarUpdatedAt },
    });

    return res.json({ avatarUrl, avatarThumbUrl, avatarUpdatedAt: avatarUpdatedAt.toISOString() });
  }),
);

// DELETE /tg/me/profile/avatar — remove profile avatar
tgRouter.delete(
  '/me/profile/avatar',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const locale = getRequestLocale(req);
    const profile = await getOrCreateProfile(user.id, locale);

    deleteUploadFile(profile.avatarUrl);
    deleteUploadFile(profile.avatarThumbUrl);
    await prisma.userProfile.update({
      where: { userId: user.id },
      data: { avatarUrl: null, avatarThumbUrl: null, avatarUpdatedAt: null },
    });

    return res.json({ success: true });
  }),
);

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

// GET /tg/me/birthday-settings
tgRouter.get('/me/birthday-settings', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const locale = getRequestLocale(req);
  const profile = await getOrCreateProfile(user.id, locale);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);

  let primary: { id: string; slug: string; title: string } | null = null;
  if (profile.birthdayPrimaryWishlistId) {
    const wl = await prisma.wishlist.findUnique({
      where: { id: profile.birthdayPrimaryWishlistId },
      select: { id: true, slug: true, title: true, ownerId: true, archivedAt: true, visibility: true },
    });
    if (wl && wl.ownerId === user.id && wl.archivedAt === null && wl.visibility !== 'PRIVATE') {
      primary = { id: wl.id, slug: wl.slug, title: wl.title };
    }
  }

  const mutedCount = await prisma.birthdayReminderMute.count({ where: { userId: user.id } });

  return res.json({
    isPro: ent.isPro,
    birthday: profile.birthday?.toISOString() ?? null,
    hideYear: profile.hideYear,
    profileVisibility: profile.profileVisibility,
    optInPromptSeenAt: profile.birthdayOptInPromptSeenAt?.toISOString() ?? null,
    friendReminders: {
      enabled: profile.birthdayFriendReminders,
      audience: profile.birthdayAudience,
      advancedWindowsEnabled: profile.birthdayAdvancedWindowsEnabled,
      primaryWishlist: primary,
      primaryWishlistId: profile.birthdayPrimaryWishlistId,
      customMessage: profile.birthdayCustomMessage ?? null,
    },
    ownerReminders: {
      enabled: profile.birthdayOwnerReminders,
    },
    receiving: {
      enabled: profile.notifyBirthdays,
      mutedCount,
    },
  });
}));

// PATCH /tg/me/birthday-settings — Pro fields return 402 with feature context
tgRouter.patch('/me/birthday-settings', asyncHandler(async (req, res) => {
  const parsed = z.object({
    friendRemindersEnabled: z.boolean().optional(),
    ownerRemindersEnabled: z.boolean().optional(),
    audience: z.enum(['SUBSCRIBERS', 'EXTENDED']).optional(),
    advancedWindowsEnabled: z.boolean().optional(),
    primaryWishlistId: z.string().nullable().optional(),
    customMessage: z.string().max(200).nullable().optional(),
    receivingEnabled: z.boolean().optional(),
    optInPromptSeen: z.boolean().optional(),
  }).strict().safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const user = await getOrCreateTgUser(req.tgUser!);
  const locale = getRequestLocale(req);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  const isPro = ent.isPro;
  const data = parsed.data;
  await getOrCreateProfile(user.id, locale);

  // Pro gating — reject (402) instead of silent save
  if (data.audience === 'EXTENDED' && !isPro) {
    trackEvent('birthday.pro_required_hit', user.id, { feature: 'audience_extended' });
    return res.status(402).json({ error: 'pro_required', feature: 'birthday_reminders_advanced', context: 'audience' });
  }
  if (data.advancedWindowsEnabled === true && !isPro) {
    trackEvent('birthday.pro_required_hit', user.id, { feature: 'advanced_windows' });
    return res.status(402).json({ error: 'pro_required', feature: 'birthday_reminders_advanced', context: 'advanced_windows' });
  }
  if (data.primaryWishlistId !== undefined && data.primaryWishlistId !== null && !isPro) {
    trackEvent('birthday.pro_required_hit', user.id, { feature: 'primary_wishlist' });
    return res.status(402).json({ error: 'pro_required', feature: 'birthday_reminders_advanced', context: 'primary_wishlist' });
  }
  if (data.customMessage !== undefined && data.customMessage !== null && data.customMessage.trim().length > 0 && !isPro) {
    trackEvent('birthday.pro_required_hit', user.id, { feature: 'custom_message' });
    return res.status(402).json({ error: 'pro_required', feature: 'birthday_reminders_advanced', context: 'custom_message' });
  }

  // Validate primaryWishlistId belongs to user + is non-private
  if (data.primaryWishlistId) {
    const wl = await prisma.wishlist.findUnique({
      where: { id: data.primaryWishlistId },
      select: { ownerId: true, archivedAt: true, visibility: true },
    });
    if (!wl || wl.ownerId !== user.id || wl.archivedAt !== null) {
      return res.status(400).json({ error: 'wishlist_not_found' });
    }
    if (wl.visibility === 'PRIVATE') {
      return res.status(400).json({ error: 'wishlist_private', message: 'Primary birthday wishlist must be public or link-only' });
    }
  }

  const updateData: Record<string, unknown> = {};
  if (data.friendRemindersEnabled !== undefined) {
    updateData.birthdayFriendReminders = data.friendRemindersEnabled;
    trackEvent(data.friendRemindersEnabled ? 'birthday.friend_reminders_enabled' : 'birthday.friend_reminders_disabled', user.id, {});
  }
  if (data.ownerRemindersEnabled !== undefined) {
    updateData.birthdayOwnerReminders = data.ownerRemindersEnabled;
    trackEvent(data.ownerRemindersEnabled ? 'birthday.owner_reminders_enabled' : 'birthday.owner_reminders_disabled', user.id, {});
  }
  if (data.audience !== undefined) {
    updateData.birthdayAudience = data.audience;
    trackEvent('birthday.audience_changed', user.id, { audience: data.audience });
  }
  if (data.advancedWindowsEnabled !== undefined) {
    updateData.birthdayAdvancedWindowsEnabled = data.advancedWindowsEnabled;
    trackEvent(data.advancedWindowsEnabled ? 'birthday.advanced_windows_enabled' : 'birthday.advanced_windows_disabled', user.id, {});
  }
  if (data.primaryWishlistId !== undefined) {
    updateData.birthdayPrimaryWishlistId = data.primaryWishlistId;
    trackEvent(data.primaryWishlistId ? 'birthday.primary_wishlist_set' : 'birthday.primary_wishlist_cleared', user.id, {});
  }
  if (data.customMessage !== undefined) {
    updateData.birthdayCustomMessage = data.customMessage?.trim() || null;
    trackEvent(updateData.birthdayCustomMessage ? 'birthday.custom_message_saved' : 'birthday.custom_message_cleared', user.id, {});
  }
  if (data.receivingEnabled !== undefined) {
    updateData.notifyBirthdays = data.receivingEnabled;
    trackEvent(data.receivingEnabled ? 'birthday.receiving_enabled' : 'birthday.receiving_disabled', user.id, {});
  }
  if (data.optInPromptSeen === true) {
    updateData.birthdayOptInPromptSeenAt = new Date();
  }

  if (Object.keys(updateData).length > 0) {
    await prisma.userProfile.update({ where: { userId: user.id }, data: updateData });
  }
  return res.json({ ok: true });
}));

// GET /tg/birthday-reminders/muted — list of muted users
tgRouter.get('/birthday-reminders/muted', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const mutes = await prisma.birthdayReminderMute.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: {
      mutedUser: {
        select: { id: true, firstName: true, profile: { select: { displayName: true, username: true, avatarThumbUrl: true } } },
      },
    },
  });
  return res.json({
    muted: mutes.map(m => ({
      userId: m.mutedBirthdayUserId,
      displayName: m.mutedUser.profile?.displayName ?? m.mutedUser.firstName ?? m.mutedUser.profile?.username ?? null,
      username: m.mutedUser.profile?.username ?? null,
      avatarThumbUrl: m.mutedUser.profile?.avatarThumbUrl ?? null,
      mutedAt: m.createdAt.toISOString(),
    })),
  });
}));

// POST /tg/birthday-reminders/mute — body: { deliveryId? | mutedUserId? }
//   Mutes either by delivery context (resolves birthdayUserId) or directly.
tgRouter.post('/birthday-reminders/mute', asyncHandler(async (req, res) => {
  const parsed = z.object({
    deliveryId: z.string().min(1).max(64).optional(),
    mutedUserId: z.string().min(1).max(64).optional(),
  }).refine(d => d.deliveryId || d.mutedUserId, { message: 'either deliveryId or mutedUserId is required' }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const user = await getOrCreateTgUser(req.tgUser!);
  let mutedUserId = parsed.data.mutedUserId ?? null;
  if (!mutedUserId && parsed.data.deliveryId) {
    const d = await prisma.birthdayReminderDelivery.findUnique({
      where: { id: parsed.data.deliveryId },
      select: { recipientUserId: true, birthdayUserId: true },
    });
    if (!d) return res.status(404).json({ error: 'delivery_not_found' });
    if (d.recipientUserId !== user.id) return res.status(403).json({ error: 'forbidden' });
    mutedUserId = d.birthdayUserId;
  }
  if (!mutedUserId) return res.status(400).json({ error: 'no_target' });
  if (mutedUserId === user.id) return res.status(400).json({ error: 'cannot_mute_self' });

  await prisma.birthdayReminderMute.upsert({
    where: { userId_mutedBirthdayUserId: { userId: user.id, mutedBirthdayUserId: mutedUserId } },
    update: {},
    create: { userId: user.id, mutedBirthdayUserId: mutedUserId },
  });

  // Lookup display name for response
  const target = await prisma.user.findUnique({
    where: { id: mutedUserId },
    select: { firstName: true, profile: { select: { displayName: true, username: true } } },
  });
  const displayName = target?.profile?.displayName ?? target?.firstName ?? target?.profile?.username ?? null;
  trackEvent('birthday.mute_added', user.id, { mutedUserId });
  return res.json({ ok: true, mutedUserId, displayName });
}));

// DELETE /tg/birthday-reminders/mute/:userId — unmute
tgRouter.delete('/birthday-reminders/mute/:userId', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const userId = req.params.userId;
  if (!userId) return res.status(400).json({ error: 'missing_user_id' });
  await prisma.birthdayReminderMute.deleteMany({
    where: { userId: user.id, mutedBirthdayUserId: userId },
  });
  trackEvent('birthday.mute_removed', user.id, { mutedUserId: userId });
  return res.json({ ok: true });
}));

// GET /tg/birthday-reminders/resolve/:deliveryId — Mini App boot resolves
//   deep-link target + sets clickedAt for attribution.
tgRouter.get('/birthday-reminders/resolve/:deliveryId', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const id = req.params.deliveryId;
  if (!id) return res.status(400).json({ error: 'missing_delivery_id' });
  const d = await prisma.birthdayReminderDelivery.findUnique({
    where: { id },
    select: {
      id: true, birthdayUserId: true, recipientUserId: true, reminderKind: true,
      targetType: true, targetId: true, occurrenceKey: true, sentAt: true, clickedAt: true,
      birthdayUser: {
        select: {
          id: true, firstName: true,
          profile: { select: { displayName: true, username: true, avatarThumbUrl: true, birthday: true, hideYear: true, birthdayCustomMessage: true } },
        },
      },
    },
  });
  if (!d) return res.status(404).json({ error: 'delivery_not_found' });
  if (d.recipientUserId !== user.id) return res.status(403).json({ error: 'forbidden' });

  if (!d.clickedAt) {
    await prisma.birthdayReminderDelivery.update({
      where: { id: d.id },
      data: { clickedAt: new Date() },
    });
    trackEvent('birthday.bot_cta_clicked', user.id, { kind: d.reminderKind, targetType: d.targetType });
  }

  // Re-resolve target at click-time so a deleted/private wishlist falls back gracefully
  let liveTargetType: string | null = d.targetType;
  let liveTargetId: string | null = d.targetId;
  let targetUnavailable = false;
  if (d.targetType === 'wishlist' && d.targetId) {
    const wl = await prisma.wishlist.findUnique({
      where: { slug: d.targetId },
      select: { id: true, slug: true, ownerId: true, archivedAt: true, visibility: true },
    });
    const stillOk = wl && wl.ownerId === d.birthdayUserId && wl.archivedAt === null
      && (wl.visibility === 'PUBLIC_PROFILE' || wl.visibility === 'LINK_ONLY');
    if (!stillOk) {
      targetUnavailable = true;
      liveTargetType = 'profile';
      liveTargetId = d.birthdayUser.profile?.username ?? null;
    }
  }

  const days = daysUntilNextBirthday(d.birthdayUser.profile?.birthday ?? null, new Date());
  const displayName = pickBirthdayDisplayName({
    displayName: d.birthdayUser.profile?.displayName ?? null,
    username: d.birthdayUser.profile?.username ?? null,
    firstName: d.birthdayUser.firstName,
  });

  return res.json({
    deliveryId: d.id,
    reminderKind: d.reminderKind,
    targetType: liveTargetType,
    targetId: liveTargetId,
    originalTargetType: d.targetType,
    targetUnavailable,
    occurrenceKey: d.occurrenceKey,
    isOwner: d.reminderKind.startsWith('owner_'),
    birthdayUser: {
      userId: d.birthdayUserId,
      displayName,
      username: d.birthdayUser.profile?.username ?? null,
      avatarThumbUrl: d.birthdayUser.profile?.avatarThumbUrl ?? null,
      hideYear: d.birthdayUser.profile?.hideYear ?? false,
      customMessage: d.birthdayUser.profile?.birthdayCustomMessage ?? null,
    },
    daysUntil: days,
  });
}));

// GET /tg/admin/birthday-reminders/metrics — God Mode dashboard
tgRouter.get('/admin/birthday-reminders/metrics', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  if (!user.godMode) return res.status(403).json({ error: 'Forbidden' });

  const day = 24 * 3600_000;
  const now = new Date();
  const sinceDay = new Date(now.getTime() - day);

  // Readiness metrics
  const usersWithBirthday = await prisma.userProfile.count({ where: { birthday: { not: null } } });
  const usersWithFriendRemindersEnabled = await prisma.userProfile.count({
    where: { birthday: { not: null }, birthdayFriendReminders: true },
  });
  const usersWithPublicBirthdayProfile = await prisma.userProfile.count({
    where: { birthday: { not: null }, birthdayFriendReminders: true, profileVisibility: { not: 'NOBODY' } },
  });
  const usersWithPrimaryWishlist = await prisma.userProfile.count({
    where: { birthday: { not: null }, birthdayPrimaryWishlistId: { not: null } },
  });
  const usersWithPublicWishlistRaw = await prisma.wishlist.findMany({
    where: { archivedAt: null, visibility: { in: ['PUBLIC_PROFILE', 'LINK_ONLY'] } },
    distinct: ['ownerId'], select: { ownerId: true },
  });
  const usersWithPublicWishlist = usersWithPublicWishlistRaw.length;
  const usersWithActivePublicItemsRaw = await prisma.item.findMany({
    where: { status: 'AVAILABLE', wishlist: { archivedAt: null, visibility: { in: ['PUBLIC_PROFILE', 'LINK_ONLY'] } } },
    distinct: ['wishlistId'],
    select: { wishlist: { select: { ownerId: true } } },
  });
  const ownersWithActiveItems = new Set(usersWithActivePublicItemsRaw.map(i => i.wishlist.ownerId));
  const usersWithActivePublicItems = ownersWithActiveItems.size;

  // Delivery metrics — last 24h
  const deliveriesByStatus = await prisma.birthdayReminderDelivery.groupBy({
    by: ['status'],
    _count: { _all: true },
    where: { createdAt: { gte: sinceDay } },
  });
  const deliveriesByKind = await prisma.birthdayReminderDelivery.groupBy({
    by: ['reminderKind'],
    _count: { _all: true },
    where: { createdAt: { gte: sinceDay } },
  });
  const deliveriesBySkipReason = await prisma.birthdayReminderDelivery.groupBy({
    by: ['skipReason'],
    _count: { _all: true },
    where: { createdAt: { gte: sinceDay }, status: 'skipped' },
  });
  const deliveriesByFailureReason = await prisma.birthdayReminderDelivery.groupBy({
    by: ['failureReason'],
    _count: { _all: true },
    where: { createdAt: { gte: sinceDay }, status: 'failed' },
  });
  const sentCount = deliveriesByStatus.find(d => d.status === 'sent')?._count._all ?? 0;
  const clickedCount = await prisma.birthdayReminderDelivery.count({
    where: { sentAt: { gte: sinceDay }, clickedAt: { not: null } },
  });

  // Mute metrics
  const totalMutes = await prisma.birthdayReminderMute.count();
  const mutes24h = await prisma.birthdayReminderMute.count({ where: { createdAt: { gte: sinceDay } } });

  // Heartbeat
  const hb = await prisma.serviceHeartbeat.findUnique({ where: { serviceName: 'birthday_reminders' } });

  // Stuck pending deliveries
  const stuckPending = await prisma.birthdayReminderDelivery.count({
    where: {
      OR: [
        { status: 'pending', createdAt: { lt: new Date(now.getTime() - 2 * 3600_000) } },
        { status: 'deferred', deferredUntil: { lt: now } },
      ],
    },
  });

  // ─── Conversion metrics ─────────────────────────────────────────────────
  // Counts AnalyticsEvent rows where Mini App fired the canonical birthday.*
  // mirror events. The mirrors are emitted by `trackBirthdayAttributedEvent`
  // ONLY when the user is in a `br_<deliveryId>` deeplink session, so each
  // count reflects birthday-deeplink → action conversion.
  const countAttributedEvent = async (event: string): Promise<number> => {
    return prisma.analyticsEvent.count({
      where: { event, createdAt: { gte: sinceDay } },
    });
  };
  const [
    convFriendReservation,
    convFriendSecretReservation,
    convFriendItemOpened,
    convFriendWishlistOpened,
    convFriendProfileSubscribed,
    convFriendGiftCompleted,
  ] = await Promise.all([
    countAttributedEvent('birthday.item_reserved'),
    countAttributedEvent('birthday.secret_reservation_clicked'),
    countAttributedEvent('birthday.item_opened'),
    countAttributedEvent('birthday.public_wishlist_opened'),
    countAttributedEvent('birthday.subscribe_clicked'),
    countAttributedEvent('birthday.gift_completed'),
  ]);

  // Owner-flow conversion metrics — count birthday.* mirror events filtered to
  // owner_* reminderKind via JSON props. Prisma's JSON path filtering needs
  // raw SQL because the mirror events are emitted by the Mini App where we
  // don't yet differentiate owner vs friend in the canonical event name.
  // Approximate: owner conversion = events where birthdayReminderKind LIKE 'owner_%'.
  const ownerConversionRows = await prisma.$queryRaw<Array<{ event: string; count: bigint }>>`
    SELECT event, COUNT(*)::bigint AS count
    FROM "AnalyticsEvent"
    WHERE event IN ('birthday.gift_completed', 'wishlist_created', 'wish_created')
      AND "createdAt" >= ${sinceDay}
      AND props->>'birthdayReminderKind' LIKE 'owner_%'
    GROUP BY event
  `.catch(() => [] as Array<{ event: string; count: bigint }>);
  const ownerConversionByEvent = Object.fromEntries(
    ownerConversionRows.map(r => [r.event, Number(r.count)]),
  );

  // Pro-conversion from birthday context — paywall_converted events whose
  // `from`/`source` prop indicates birthday_reminders_advanced context.
  const proConversionFromBirthday = await prisma.analyticsEvent.count({
    where: {
      event: 'birthday.paywall_converted',
      createdAt: { gte: sinceDay },
    },
  });

  return res.json({
    enabled: BIRTHDAY_REMINDERS_ENABLED,
    readiness: {
      usersWithBirthday,
      usersWithFriendRemindersEnabled,
      usersWithPublicBirthdayProfile,
      usersWithPublicWishlist,
      usersWithActivePublicItems,
      usersWithPrimaryWishlist,
    },
    deliveries24h: {
      total: deliveriesByStatus.reduce((sum, d) => sum + d._count._all, 0),
      byStatus: Object.fromEntries(deliveriesByStatus.map(d => [d.status, d._count._all])),
      byKind: Object.fromEntries(deliveriesByKind.map(d => [d.reminderKind, d._count._all])),
      bySkipReason: Object.fromEntries(deliveriesBySkipReason.filter(d => d.skipReason).map(d => [d.skipReason!, d._count._all])),
      byFailureReason: Object.fromEntries(deliveriesByFailureReason.filter(d => d.failureReason).map(d => [d.failureReason!, d._count._all])),
    },
    engagement24h: {
      sent: sentCount,
      clicked: clickedCount,
      ctrPercent: sentCount > 0 ? Math.round((clickedCount / sentCount) * 1000) / 10 : 0,
    },
    conversions24h: {
      // Friend-reminder funnel (recipient receives DM → opens Mini App → acts)
      friendReminderToReservation: convFriendReservation,
      friendReminderToSecretReservation: convFriendSecretReservation,
      friendReminderToItemOpened: convFriendItemOpened,
      friendReminderToWishlistOpened: convFriendWishlistOpened,
      friendReminderToProfileSubscribed: convFriendProfileSubscribed,
      // Owner-reminder funnel (owner receives DM → updates wishlist)
      ownerReminderToItemAdded: ownerConversionByEvent['wish_created'] ?? 0,
      ownerReminderToWishlistMadePublic: ownerConversionByEvent['wishlist_created'] ?? 0,
      ownerReminderToGiftCompleted: ownerConversionByEvent['birthday.gift_completed'] ?? 0,
      // Pro funnel (paywall shown → upgraded)
      proConversionFromBirthdayContext: proConversionFromBirthday,
    },
    mutes: { total: totalMutes, last24h: mutes24h },
    scheduler: {
      lastRun: hb?.updatedAt?.toISOString() ?? null,
      lastMetadata: hb?.metadata ? (() => { try { return JSON.parse(hb.metadata!); } catch { return null; } })() : null,
      stuckPending,
    },
    alerts: {
      schedulerStale: hb ? (now.getTime() - hb.updatedAt.getTime()) > 26 * 3600_000 : true,
      stuckPendingHigh: stuckPending > 20,
      noSendsDespiteCandidates: usersWithFriendRemindersEnabled > 0 && sentCount === 0,
    },
  });
}));

// ─── PRO Showcase endpoints ─────────────────────────────────────────────────

// GET /tg/me/showcase — current showcase data + eligible wishlists for pinning
tgRouter.get(
  '/me/showcase',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const locale = getRequestLocale(req);
    const profile = await getOrCreateProfile(user.id, locale);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);

    // Available public wishlists (same criteria as public profile)
    const wls = await prisma.wishlist.findMany({
      where: {
        ownerId: user.id,
        type: 'REGULAR',
        archivedAt: null,
        visibility: 'PUBLIC_PROFILE',
      },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true, slug: true, title: true,
        items: { where: { status: { in: [...ACTIVE_STATUSES] } }, select: { id: true } },
      },
    });
    const availableWishlists = wls.map((wl) => ({
      id: wl.id, slug: wl.slug, title: wl.title, itemCount: wl.items.length,
    }));

    // Filter pinned IDs to only include wishlists that still qualify
    const availableIds = new Set(availableWishlists.map((w) => w.id));
    const pinned = (profile.showcasePinnedIds ?? []).filter((id) => availableIds.has(id));

    return res.json({
      isPro: ent.isPro,
      showcase: {
        enabled: profile.showcaseEnabled,
        coverUrl: profile.showcaseCoverUrl,
        bio: profile.showcaseBio,
        pinnedIds: pinned,
        preferences: profile.showcasePreferences,
        sizes: {
          clothing: profile.showcaseSizeClothing,
          shoes: profile.showcaseSizeShoes,
          ring: profile.showcaseSizeRing,
          other: profile.showcaseSizeOther,
          chest: profile.showcaseChest,
          waist: profile.showcaseWaist,
          hips: profile.showcaseHips,
        },
        brands: profile.showcaseBrands ?? [],
        updatedAt: profile.showcaseUpdatedAt?.toISOString() ?? null,
      },
      availableWishlists,
      username: profile.username,
    });
  }),
);

// PATCH /tg/me/showcase — save showcase (PRO-gated)
tgRouter.patch(
  '/me/showcase',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const locale = getRequestLocale(req);
    const profile = await getOrCreateProfile(user.id, locale);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!ent.isPro) {
      trackEvent('feature_gate_hit_showcase', user.id, { plan: ent.plan.code });
      return res.status(403).json({ error: 'pro_required' });
    }

    const schema = z.object({
      enabled: z.boolean().optional(),
      bio: z.string().max(180).nullable().optional(),
      pinnedIds: z.array(z.string()).max(3).optional(),
      preferences: z.string().max(300).nullable().optional(),
      sizeClothing: z.string().max(50).nullable().optional(),
      sizeShoes: z.string().max(50).nullable().optional(),
      sizeRing: z.string().max(50).nullable().optional(),
      sizeOther: z.string().max(100).nullable().optional(),
      chest: z.string().max(20).nullable().optional(),
      waist: z.string().max(20).nullable().optional(),
      hips: z.string().max(20).nullable().optional(),
      brands: z.array(z.string().min(1).max(40)).max(10).optional(),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'validation_failed', issues: parsed.error.issues });

    // Validate pinnedIds exist and are public wishlists of this user
    let pinnedIds = parsed.data.pinnedIds;
    if (pinnedIds && pinnedIds.length > 0) {
      const wls = await prisma.wishlist.findMany({
        where: {
          id: { in: pinnedIds },
          ownerId: user.id,
          type: 'REGULAR',
          archivedAt: null,
          visibility: 'PUBLIC_PROFILE',
        },
        select: { id: true },
      });
      const validIds = new Set(wls.map((w) => w.id));
      pinnedIds = pinnedIds.filter((id) => validIds.has(id));
    }

    // Deduplicate brands (case-insensitive), keep original casing
    let brands = parsed.data.brands;
    if (brands) {
      const seen = new Set<string>();
      brands = brands.map((b) => b.trim()).filter((b) => {
        const k = b.toLowerCase();
        if (!b || seen.has(k)) return false;
        seen.add(k);
        return true;
      }).slice(0, 10);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = { showcaseUpdatedAt: new Date() };
    if (parsed.data.enabled !== undefined) data.showcaseEnabled = parsed.data.enabled;
    if (parsed.data.bio !== undefined) data.showcaseBio = parsed.data.bio ?? null;
    if (pinnedIds !== undefined) data.showcasePinnedIds = pinnedIds ?? [];
    if (parsed.data.preferences !== undefined) data.showcasePreferences = parsed.data.preferences ?? null;
    if (parsed.data.sizeClothing !== undefined) data.showcaseSizeClothing = parsed.data.sizeClothing ?? null;
    if (parsed.data.sizeShoes !== undefined) data.showcaseSizeShoes = parsed.data.sizeShoes ?? null;
    if (parsed.data.sizeRing !== undefined) data.showcaseSizeRing = parsed.data.sizeRing ?? null;
    if (parsed.data.sizeOther !== undefined) data.showcaseSizeOther = parsed.data.sizeOther ?? null;
    if (parsed.data.chest !== undefined) data.showcaseChest = parsed.data.chest ?? null;
    if (parsed.data.waist !== undefined) data.showcaseWaist = parsed.data.waist ?? null;
    if (parsed.data.hips !== undefined) data.showcaseHips = parsed.data.hips ?? null;
    if (brands !== undefined) data.showcaseBrands = brands ?? [];

    const updated = await prisma.userProfile.update({
      where: { userId: user.id },
      data,
    });

    trackEvent('showcase.saved', user.id);
    if (parsed.data.enabled === true && !profile.showcaseEnabled) {
      trackEvent('showcase.published', user.id);
    }

    return res.json({
      showcase: {
        enabled: updated.showcaseEnabled,
        coverUrl: updated.showcaseCoverUrl,
        bio: updated.showcaseBio,
        pinnedIds: updated.showcasePinnedIds ?? [],
        preferences: updated.showcasePreferences,
        sizes: {
          clothing: updated.showcaseSizeClothing,
          shoes: updated.showcaseSizeShoes,
          ring: updated.showcaseSizeRing,
          other: updated.showcaseSizeOther,
          chest: updated.showcaseChest,
          waist: updated.showcaseWaist,
          hips: updated.showcaseHips,
        },
        brands: updated.showcaseBrands ?? [],
        updatedAt: updated.showcaseUpdatedAt?.toISOString() ?? null,
      },
    });
  }),
);

// POST /tg/me/showcase/cover — upload showcase cover (1200px, quality 80)
tgRouter.post(
  '/me/showcase/cover',
  upload.single('cover'),
  asyncHandler(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const locale = getRequestLocale(req);
    const profile = await getOrCreateProfile(user.id, locale);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!ent.isPro) {
      trackEvent('feature_gate_hit_showcase', user.id, { plan: ent.plan.code });
      return res.status(403).json({ error: 'pro_required' });
    }

    const full = await processImage(req.file.buffer, { maxDim: 1200, quality: 80, suffix: 'cover' });

    // Delete old cover if it exists
    deleteUploadFile(profile.showcaseCoverUrl);

    const coverUrl = `/api/uploads/${full.filename}`;

    await prisma.userProfile.update({
      where: { userId: user.id },
      data: { showcaseCoverUrl: coverUrl, showcaseUpdatedAt: new Date() },
    });

    trackEvent('showcase.cover_uploaded', user.id);
    return res.json({ coverUrl });
  }),
);

// DELETE /tg/me/showcase/cover — remove showcase cover
tgRouter.delete(
  '/me/showcase/cover',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const locale = getRequestLocale(req);
    const profile = await getOrCreateProfile(user.id, locale);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!ent.isPro) {
      return res.status(403).json({ error: 'pro_required' });
    }

    deleteUploadFile(profile.showcaseCoverUrl);
    await prisma.userProfile.update({
      where: { userId: user.id },
      data: { showcaseCoverUrl: null, showcaseUpdatedAt: new Date() },
    });

    trackEvent('showcase.cover_removed', user.id);
    return res.json({ success: true });
  }),
);

// GET /tg/me/settings — user settings
tgRouter.get(
  '/me/settings',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const locale = getRequestLocale(req);
    const profile = await getOrCreateProfile(user.id, locale);
    const { isPro } = await getUserEntitlement(user.id, user.godMode);

    // FREE users: all notifications are always ON (they cannot opt out — only PRO users can
    // manage notification preferences). Normalise here so the UI always shows the correct
    // effective state regardless of what's stored in the DB.
    const notifications = isPro
      ? {
          comments: profile.notifyComments,
          reservations: profile.notifyReservations,
          subscriptions: profile.notifySubscriptions,
          marketing: profile.notifyMarketing,
        }
      : { comments: true, reservations: true, subscriptions: true, marketing: true };

    const langMode = (profile.languageMode ?? 'auto') as 'auto' | 'manual';
    const manualLang = profile.manualLanguage as Locale | null ?? null;
    const effectiveLanguage = resolveEffectiveLocale(
      { languageMode: langMode, manualLanguage: manualLang },
      req.tgUser?.language_code,
    );

    return res.json({
      // New fields — single source of truth for language
      languageMode: langMode,
      manualLanguage: manualLang,
      effectiveLanguage,
      defaultCurrency: profile.defaultCurrency,
      notifications,
      privacy: {
        profileVisibility: profile.profileVisibility,
        subscribePolicy: profile.subscribePolicy,
        commentsEnabled: profile.commentsEnabled,
        hintsEnabled: profile.hintsEnabled,
      },
      appBehavior: {
        // "top" is PRO-only — normalize to "bottom" for FREE users (handles PRO→FREE downgrade)
        newWishlistPosition: isPro ? profile.newWishlistPosition : 'bottom',
        cardDisplayMode: isPro ? (profile.cardDisplayMode ?? 'auto') : 'auto',
      },
      // v2.1 — runtime theme + accent (PRO-gated). FREE users normalised
      // to dark+violet to handle PRO→FREE downgrade gracefully.
      appearance: {
        theme: isPro ? (user.themePreference ?? 'dark') : 'dark',
        accent: isPro ? (user.accentPreference ?? 'violet') : 'violet',
      },
      isPro,
      // Owner-only — never exposed in public/share API responses
      supportId: profile.supportId,
    });
  }),
);

// GET /tg/me/active-links — all active share links for link management screen
tgRouter.get(
  '/me/active-links',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);

    const [selections, wishlists, profile] = await Promise.all([
      prisma.curatedSelection.findMany({
        where: { ownerId: user.id, deactivatedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { expiresAt: 'asc' },
        select: {
          id: true, shareToken: true, title: true, viewCount: true,
          expiresAt: true, createdAt: true,
          _count: { select: { items: true, subscriptions: true } },
        },
      }),
      prisma.wishlist.findMany({
        where: { ownerId: user.id, shareToken: { not: null } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, slug: true, title: true, shareToken: true, shareOpenCount: true },
      }),
      prisma.userProfile.findUnique({
        where: { userId: user.id },
        select: { username: true, profileVisibility: true },
      }),
    ]);

    const profileLink = profile?.username && profile.profileVisibility !== 'NOBODY'
      ? { username: profile.username, profileVisibility: profile.profileVisibility }
      : null;

    return res.json({
      selections: selections.map(s => ({
        id: s.id, shareToken: s.shareToken, title: s.title,
        viewCount: s.viewCount, subscriberCount: s._count.subscriptions,
        itemCount: s._count.items, expiresAt: s.expiresAt, createdAt: s.createdAt,
      })),
      wishlists: wishlists.map(w => ({
        id: w.id, slug: w.slug, title: w.title,
        shareToken: w.shareToken!, viewCount: w.shareOpenCount,
      })),
      profile: profileLink,
    });
  }),
);

// PATCH /tg/me/settings — update user settings
tgRouter.patch(
  '/me/settings',
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      // Language mode — 'auto' follows Telegram language_code, 'manual' uses manualLanguage
      languageMode: z.enum(['auto', 'manual']).optional(),
      manualLanguage: z.enum(['ru', 'en', 'zh-CN', 'hi', 'es', 'ar']).nullable().optional(),
      defaultCurrency: z.enum(['RUB', 'USD', 'EUR', 'GBP']).optional(),
      notifications: z.object({
        comments: z.boolean().optional(),
        reservations: z.boolean().optional(),
        subscriptions: z.boolean().optional(),
        marketing: z.boolean().optional(),
      }).optional(),
      privacy: z.object({
        profileVisibility: z.enum(['ALL', 'LINK_ONLY', 'SUBSCRIBERS', 'NOBODY']).optional(),
        subscribePolicy: z.enum(['ALL', 'LINK_ONLY', 'APPROVED', 'NOBODY']).optional(),
        commentsEnabled: z.boolean().optional(),
        hintsEnabled: z.boolean().optional(),
      }).optional(),
      appBehavior: z.object({
        newWishlistPosition: z.enum(['top', 'bottom']).optional(),
        cardDisplayMode: z.enum(['auto', 'showcase', 'compact']).optional(),
      }).optional(),
      // v2.1 — runtime theme + accent. PRO-gated except dark + violet.
      appearance: z.object({
        theme: z.enum(['dark', 'black']).optional(),
        accent: z.enum(['violet', 'blue', 'pink', 'green']).optional(),
      }).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const locale = getRequestLocale(req);
    const { isPro } = await getUserEntitlement(user.id, user.godMode);
    const data = parsed.data;

    // Build update object
    const updateData: Record<string, unknown> = {};

    if (data.languageMode !== undefined) updateData.languageMode = data.languageMode;
    if (data.manualLanguage !== undefined) updateData.manualLanguage = data.manualLanguage;
    // When switching to auto, clear manualLanguage
    if (data.languageMode === 'auto') updateData.manualLanguage = null;
    if (data.defaultCurrency !== undefined) updateData.defaultCurrency = data.defaultCurrency;

    if (data.notifications) {
      // All notification preferences are PRO-only — FREE users have all notifications ON
      // and cannot opt out. Silently ignore any notification changes from FREE users.
      if (isPro) {
        if (data.notifications.comments !== undefined) updateData.notifyComments = data.notifications.comments;
        if (data.notifications.reservations !== undefined) updateData.notifyReservations = data.notifications.reservations;
        if (data.notifications.subscriptions !== undefined) updateData.notifySubscriptions = data.notifications.subscriptions;
        if (data.notifications.marketing !== undefined) updateData.notifyMarketing = data.notifications.marketing;
      }
    }

    if (data.privacy) {
      if (data.privacy.profileVisibility !== undefined) updateData.profileVisibility = data.privacy.profileVisibility;
      if (data.privacy.subscribePolicy !== undefined) updateData.subscribePolicy = data.privacy.subscribePolicy;
      if (data.privacy.hintsEnabled !== undefined) updateData.hintsEnabled = data.privacy.hintsEnabled;
      // Pro-gated privacy settings
      if (isPro) {
        if (data.privacy.commentsEnabled !== undefined) updateData.commentsEnabled = data.privacy.commentsEnabled;
      }
    }

    if (data.appBehavior) {
      // Pro-gated: newWishlistPosition "top" requires Pro (free users can only use "bottom")
      if (data.appBehavior.newWishlistPosition !== undefined) {
        if (isPro || data.appBehavior.newWishlistPosition === 'bottom') {
          updateData.newWishlistPosition = data.appBehavior.newWishlistPosition;
        }
      }
      // Pro-gated: cardDisplayMode non-auto requires Pro
      if (data.appBehavior.cardDisplayMode !== undefined) {
        if (isPro || data.appBehavior.cardDisplayMode === 'auto') {
          updateData.cardDisplayMode = data.appBehavior.cardDisplayMode;
        }
      }
    }

    // v2.1 appearance — theme/accent live on the User table, not UserProfile.
    // Free combo: dark + violet only. Other combos require PRO; silently
    // ignored from FREE callers (defense in depth — UI also blocks them).
    if (data.appearance) {
      const userUpdate: { themePreference?: string; accentPreference?: string } = {};
      if (data.appearance.theme !== undefined) {
        if (isPro || data.appearance.theme === 'dark') userUpdate.themePreference = data.appearance.theme;
      }
      if (data.appearance.accent !== undefined) {
        if (isPro || data.appearance.accent === 'violet') userUpdate.accentPreference = data.appearance.accent;
      }
      if (Object.keys(userUpdate).length > 0) {
        await prisma.user.update({ where: { id: user.id }, data: userUpdate });
      }
    }

    const profile = await prisma.userProfile.upsert({
      where: { userId: user.id },
      update: updateData,
      create: {
        userId: user.id,
        defaultCurrency: (data.defaultCurrency as 'RUB' | 'USD' | undefined) ?? (locale === 'ru' ? 'RUB' : 'USD'),
        ...updateData,
      },
    });

    // Normalise notifications for FREE users — same logic as GET
    const updatedNotifications = isPro
      ? {
          comments: profile.notifyComments,
          reservations: profile.notifyReservations,
          subscriptions: profile.notifySubscriptions,
          marketing: profile.notifyMarketing,
        }
      : { comments: true, reservations: true, subscriptions: true, marketing: true };

    const updatedLangMode = (profile.languageMode ?? 'auto') as 'auto' | 'manual';
    const updatedManualLang = profile.manualLanguage as Locale | null ?? null;
    const updatedEffectiveLanguage = resolveEffectiveLocale(
      { languageMode: updatedLangMode, manualLanguage: updatedManualLang },
      req.tgUser?.language_code,
    );

    // Re-read user to pick up any appearance changes
    const updatedUser = data.appearance
      ? await prisma.user.findUnique({ where: { id: user.id }, select: { themePreference: true, accentPreference: true } })
      : { themePreference: user.themePreference, accentPreference: user.accentPreference };

    return res.json({
      languageMode: updatedLangMode,
      manualLanguage: updatedManualLang,
      effectiveLanguage: updatedEffectiveLanguage,
      defaultCurrency: profile.defaultCurrency,
      notifications: updatedNotifications,
      privacy: {
        profileVisibility: profile.profileVisibility,
        subscribePolicy: profile.subscribePolicy,
        commentsEnabled: profile.commentsEnabled,
        hintsEnabled: profile.hintsEnabled,
      },
      appBehavior: {
        // "top" is PRO-only — normalize to "bottom" for FREE users
        newWishlistPosition: isPro ? profile.newWishlistPosition : 'bottom',
        cardDisplayMode: isPro ? (profile.cardDisplayMode ?? 'auto') : 'auto',
      },
      appearance: {
        theme: isPro ? (updatedUser?.themePreference ?? 'dark') : 'dark',
        accent: isPro ? (updatedUser?.accentPreference ?? 'violet') : 'violet',
      },
      isPro,
      // Owner-only — never exposed in public/share API responses
      supportId: profile.supportId,
    });
  }),
);

// GET /tg/me/dont-gift — return current "Don't Gift" preferences
tgRouter.get(
  '/me/dont-gift',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const profile = await prisma.userProfile.findUnique({
      where: { userId: user.id },
      select: { dontGiftPresets: true, dontGiftCustomItems: true, dontGiftComment: true, dontGiftVisible: true },
    });

    return res.json({
      presets: profile?.dontGiftPresets ?? [],
      customItems: profile?.dontGiftCustomItems ?? [],
      comment: profile?.dontGiftComment ?? null,
      visible: profile?.dontGiftVisible ?? true,
    });
  }),
);

// PUT /tg/me/dont-gift — save "Don't Gift" preferences (Pro-gated)
tgRouter.put(
  '/me/dont-gift',
  asyncHandler(async (req, res) => {
    const parsed = z.object({
      presets: z.array(z.string()).max(30).default([]),
      customItems: z.array(z.string().max(100)).max(10).default([]),
      comment: z.string().max(400).nullable().default(null),
      visible: z.boolean().default(true),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!ent.isPro) {
      trackEvent('feature_gate_hit_dont_gift', user.id, { plan: ent.plan.code });
      return res.status(402).json({ error: 'Pro required', planCode: ent.plan.code });
    }

    const { presets, customItems, comment, visible } = parsed.data;

    const profile = await prisma.userProfile.upsert({
      where: { userId: user.id },
      update: {
        dontGiftPresets: presets,
        dontGiftCustomItems: customItems,
        dontGiftComment: comment,
        dontGiftVisible: visible,
      },
      create: {
        userId: user.id,
        dontGiftPresets: presets,
        dontGiftCustomItems: customItems,
        dontGiftComment: comment,
        dontGiftVisible: visible,
      },
    });

    trackEvent('dont_gift_saved', user.id, {
      presetCount: presets.length,
      customItemCount: customItems.length,
      hasComment: !!comment,
      visible,
    });

    return res.json({
      presets: profile.dontGiftPresets,
      customItems: profile.dontGiftCustomItems,
      comment: profile.dontGiftComment,
      visible: profile.dontGiftVisible,
    });
  }),
);

// GET /tg/wishlists/:id/dont-gift — return per-wishlist "Don't Gift" settings
tgRouter.get(
  '/wishlists/:id/dont-gift',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing wishlist id' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const wishlist = await prisma.wishlist.findUnique({
      where: { id },
      select: { ownerId: true, dontGiftMode: true, dontGiftPresets: true, dontGiftCustomItems: true, dontGiftComment: true },
    });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    return res.json({
      mode: wishlist.dontGiftMode,
      presets: wishlist.dontGiftPresets,
      customItems: wishlist.dontGiftCustomItems,
      comment: wishlist.dontGiftComment ?? null,
    });
  }),
);

// PUT /tg/wishlists/:id/dont-gift — save per-wishlist "Don't Gift" settings (Pro-gated)
tgRouter.put(
  '/wishlists/:id/dont-gift',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    if (!id) return res.status(400).json({ error: 'Missing wishlist id' });

    const parsed = z.object({
      mode: z.enum(['global', 'local', 'hidden']),
      presets: z.array(z.string()).max(30).default([]),
      customItems: z.array(z.string().max(100)).max(10).default([]),
      comment: z.string().max(400).nullable().default(null),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    if (!ent.isPro) {
      trackEvent('feature_gate_hit_dont_gift', user.id, { plan: ent.plan.code });
      return res.status(402).json({ error: 'Pro required', planCode: ent.plan.code });
    }

    const wishlist = await prisma.wishlist.findUnique({ where: { id }, select: { ownerId: true } });
    if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
    if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

    const { mode, presets, customItems, comment } = parsed.data;

    const updated = await prisma.wishlist.update({
      where: { id },
      data: {
        dontGiftMode: mode,
        dontGiftPresets: mode === 'local' ? presets : [],
        dontGiftCustomItems: mode === 'local' ? customItems.filter(Boolean) : [],
        dontGiftComment: mode === 'local' ? (comment?.trim() || null) : null,
      },
      select: { dontGiftMode: true, dontGiftPresets: true, dontGiftCustomItems: true, dontGiftComment: true },
    });

    trackEvent('wishlist_do_not_gift_created', user.id, {
      wishlistId: id,
      mode,
      presetCount: presets.length,
      customItemCount: customItems.filter(Boolean).length,
      hasComment: !!comment?.trim(),
    });

    return res.json({
      mode: updated.dontGiftMode,
      presets: updated.dontGiftPresets,
      customItems: updated.dontGiftCustomItems,
      comment: updated.dontGiftComment,
    });
  }),
);

// DELETE /tg/me/account — delete user and all related data
tgRouter.delete(
  '/me/account',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);

    // Block if user owns active Santa campaigns (must cancel first)
    const activeSantaCampaigns = await prisma.santaCampaign.findMany({
      where: { ownerId: user.id, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
      select: { id: true, title: true, status: true },
    });
    if (activeSantaCampaigns.length > 0) {
      return res.status(409).json({
        error: 'active_santa_campaigns',
        message: 'Cancel or complete your Secret Santa campaigns before deleting your account.',
        campaigns: activeSantaCampaigns,
      });
    }

    await prisma.user.delete({ where: { id: user.id } });
    return res.json({ success: true });
  }),
);

// POST /tg/me/god-mode — toggle god mode (dev only, whitelisted users)
tgRouter.post(
  '/me/god-mode',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);

    const godModeAllowedIds = (process.env.GOD_MODE_TELEGRAM_IDS ?? '').split(',').filter(Boolean);
    if (!user.telegramId || !godModeAllowedIds.includes(user.telegramId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { godMode: !user.godMode },
      select: { godMode: true },
    });

    return res.json({ godMode: updated.godMode });
  }),
);

// ─── Onboarding Endpoints ─────────────────────────────────────────────────────

// GET /tg/onboarding/status — check eligibility for the current user
tgRouter.get(
  '/onboarding/status',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const actorHash = user.id; // actorHash is the internal user id used for forced rollout matching
    const result = await checkOnboardingEligibility(user.id, actorHash);
    const state = await prisma.userOnboardingState.findUnique({
      where: { userId_onboardingKey_version: { userId: user.id, onboardingKey: ONBOARDING_KEY, version: ONBOARDING_VERSION } },
      select: { id: true, status: true, variantKey: true, entryPoint: true, demoItemId: true, completionReason: true, metaJson: true, startedAt: true, completedAt: true, dismissedAt: true },
    });
    const locale = getRequestLocale(req);
    const marketSegment = resolveMarketSegment(locale);
    const rawLang = req.tgUser?.language_code;
    const bucket = deriveMarketBucket(rawLang);
    return res.json({
      eligible: result.eligible,
      reason: result.reason,
      forcedRollout: result.forcedRollout,
      draftsHaveUserContent: result.draftsHaveUserContent,
      state: state ?? null,
      marketSegment,
      supportedImportRegion: isSupportedImportRegion(bucket),
    });
  }),
);

// POST /tg/onboarding/start — begin onboarding: assign variant, create demo item in SYSTEM_DRAFTS
tgRouter.post(
  '/onboarding/start',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({ onboardingKey: z.string(), entryPoint: z.string() })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    if (parsed.data.onboardingKey !== ONBOARDING_KEY) return res.status(400).json({ error: 'Unknown onboarding key' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const actorHash = user.id;
    const elig = await checkOnboardingEligibility(user.id, actorHash);
    if (!elig.eligible) return res.status(409).json({ error: 'Not eligible', reason: elig.reason });

    // Idempotent: if already IN_PROGRESS, resume
    const existing = await prisma.userOnboardingState.findUnique({
      where: { userId_onboardingKey_version: { userId: user.id, onboardingKey: ONBOARDING_KEY, version: ONBOARDING_VERSION } },
    });
    if (existing?.status === 'IN_PROGRESS') {
      const meta = getOnboardingMeta(existing.metaJson);
      if (meta.onboardingVariant === 'v2_try') {
        // v2 resume: no demo item expected
        return res.json({ state: existing, demoItem: null, onboardingVariant: 'v2_try' as OnboardingVariant });
      }
      if (existing.demoItemId) {
        // v1 resume: return existing demo item
        const demoItem = await prisma.item.findUnique({
          where: { id: existing.demoItemId },
          select: { id: true, wishlistId: true, title: true, url: true, priceText: true, currency: true, imageUrl: true, priority: true, position: true, status: true, description: true, sourceUrl: true, sourceDomain: true, importMethod: true },
        });
        return res.json({ state: existing, demoItem: demoItem ? mapTgItem(demoItem) : null, onboardingVariant: 'v1_demo' as OnboardingVariant });
      }
    }

    // ── A/B variant assignment ──
    // Priority: 1) already-saved variant  2) test override by telegramId  3) rollout config
    const telegramId = String(req.tgUser!.id);
    const existingVariant = existing ? getOnboardingMeta(existing.metaJson).onboardingVariant : undefined;
    const assignment = existingVariant
      ? { variant: existingVariant, source: 'rollout_config' as const }
      : assignOnboardingVariant(telegramId);
    const onboardingVariant = assignment.variant;
    const assignmentSource = assignment.source;

    // Override entryPoint for forced rollout
    const effectiveEntryPoint: EntryPoint = elig.forcedRollout
      ? 'forced_rollout_test'
      : (parsed.data.entryPoint as EntryPoint);

    const locale = getRequestLocale(req);
    const marketSegment = resolveMarketSegment(locale);
    const now = new Date();

    if (onboardingVariant === 'v2_try') {
      // ── v2: initialize state only, NO demo item ──
      const meta: OnboardingMeta = {
        onboardingVariant: 'v2_try',
        lastStep: 'onboarding-entry',
        tryAttemptsUsed: 0,
        trySuccessCount: 0,
      };

      const state = await prisma.userOnboardingState.upsert({
        where: { userId_onboardingKey_version: { userId: user.id, onboardingKey: ONBOARDING_KEY, version: ONBOARDING_VERSION } },
        create: {
          userId: user.id,
          onboardingKey: ONBOARDING_KEY,
          version: ONBOARDING_VERSION,
          status: 'IN_PROGRESS',
          entryPoint: effectiveEntryPoint,
          startedAt: now,
          metaJson: meta as any,
        },
        update: {
          status: 'IN_PROGRESS',
          entryPoint: effectiveEntryPoint,
          startedAt: now,
          metaJson: meta as any,
        },
      });

      trackEvent('onboarding_variant_assigned', user.id, {
        onboarding_key: ONBOARDING_KEY,
        version: ONBOARDING_VERSION,
        onboarding_variant: 'v2_try',
        onboarding_flow: 'main_v2',
        experiment_phase: 'post_rollout',
        assignment_source: assignmentSource,
        entry_point: effectiveEntryPoint,
        forced_rollout: elig.forcedRollout,
        market_segment: marketSegment,
        locale_used: locale,
      });

      trackEvent('onboarding_started', user.id, {
        onboarding_key: ONBOARDING_KEY,
        version: ONBOARDING_VERSION,
        variant_key: null,
        entry_point: effectiveEntryPoint,
        forced_rollout: elig.forcedRollout,
        market_segment: marketSegment,
        locale_used: locale,
        onboarding_variant: 'v2_try',
        onboarding_flow: 'main_v2',
        experiment_phase: 'post_rollout',
      });

      return res.json({ state, demoItem: null, onboardingVariant: 'v2_try' as OnboardingVariant });
    }

    // ── v1: original demo-based flow ──
    const variantPool = marketSegment === 'ru' ? RU_VARIANTS : GLOBAL_VARIANTS;
    const variantKey: VariantKey = variantPool[Math.floor(Math.random() * variantPool.length)]!;
    const template = getDemoTemplate(variantKey)!;

    // Get or create SYSTEM_DRAFTS wishlist for this user
    const draftsWl = await getOrCreateDraftsWishlist(user.id);

    const demoItem = await prisma.item.create({
      data: {
        wishlistId: draftsWl.id,
        title: template.title,
        url: template.url,
        priceText: String(template.price),
        currency: template.currency,
        priority: template.priority,
        imageUrl: template.imageUrl,
        description: template.description,
        isDemo: true,
        originType: 'DEMO',
        originVariantKey: variantKey,
      },
      select: { id: true, wishlistId: true, title: true, url: true, priceText: true, currency: true, imageUrl: true, priority: true, position: true, status: true, description: true, sourceUrl: true, sourceDomain: true, importMethod: true },
    });
    // Dual-write: placement for demo item.
    await ensureItemPlacement(prisma, { wishlistId: draftsWl.id, itemId: demoItem.id });

    // Upsert onboarding state
    const v1Meta: OnboardingMeta = { onboardingVariant: 'v1_demo' };
    const state = await prisma.userOnboardingState.upsert({
      where: { userId_onboardingKey_version: { userId: user.id, onboardingKey: ONBOARDING_KEY, version: ONBOARDING_VERSION } },
      create: {
        userId: user.id,
        onboardingKey: ONBOARDING_KEY,
        version: ONBOARDING_VERSION,
        status: 'IN_PROGRESS',
        variantKey,
        entryPoint: effectiveEntryPoint,
        demoItemId: demoItem.id,
        startedAt: now,
        metaJson: v1Meta as any,
      },
      update: {
        status: 'IN_PROGRESS',
        variantKey,
        entryPoint: effectiveEntryPoint,
        demoItemId: demoItem.id,
        startedAt: now,
        metaJson: v1Meta as any,
      },
    });

    trackEvent('onboarding_variant_assigned', user.id, {
      onboarding_key: ONBOARDING_KEY,
      version: ONBOARDING_VERSION,
      onboarding_variant: 'v1_demo',
      onboarding_flow: 'v1_demo_recovery',
      experiment_phase: 'legacy_recovery',
      assignment_source: assignmentSource,
      variant_key: variantKey,
      entry_point: effectiveEntryPoint,
      forced_rollout: elig.forcedRollout,
      market_segment: marketSegment,
      locale_used: locale,
    });

    trackEvent('onboarding_started', user.id, {
      onboarding_key: ONBOARDING_KEY,
      version: ONBOARDING_VERSION,
      variant_key: variantKey,
      entry_point: effectiveEntryPoint,
      forced_rollout: elig.forcedRollout,
      market_segment: marketSegment,
      locale_used: locale,
      onboarding_variant: 'v1_demo',
      onboarding_flow: 'v1_demo_recovery',
      experiment_phase: 'legacy_recovery',
    });
    trackEvent('demo_item_created', user.id, {
      onboarding_key: ONBOARDING_KEY,
      version: ONBOARDING_VERSION,
      variant_key: variantKey,
      entry_point: effectiveEntryPoint,
      forced_rollout: elig.forcedRollout,
      market_segment: marketSegment,
      locale_used: locale,
      item_id: demoItem.id,
    });

    return res.json({ state, demoItem: mapTgItem(demoItem), onboardingVariant: 'v1_demo' as OnboardingVariant });
  }),
);

// POST /tg/onboarding/dismiss — dismiss onboarding; deletes untouched demo item if present
tgRouter.post(
  '/onboarding/dismiss',
  asyncHandler(async (req, res) => {
    const parsed = z.object({ onboardingKey: z.string() }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    if (parsed.data.onboardingKey !== ONBOARDING_KEY) return res.status(400).json({ error: 'Unknown onboarding key' });

    const user = await getOrCreateTgUser(req.tgUser!);
    const now = new Date();

    // Upsert to DISMISSED — handles case where POST /start was never called (demoItemId = null)
    // This ensures even a soft-CTA "Нет" is recorded and the onboarding won't re-appear.
    const state = await prisma.userOnboardingState.upsert({
      where: { userId_onboardingKey_version: { userId: user.id, onboardingKey: ONBOARDING_KEY, version: ONBOARDING_VERSION } },
      create: {
        userId: user.id,
        onboardingKey: ONBOARDING_KEY,
        version: ONBOARDING_VERSION,
        status: 'DISMISSED',
        dismissedAt: now,
      },
      update: { status: 'DISMISSED', dismissedAt: now },
    });

    // Clean up demo item only if it is untouched (no meaningful edits).
    // If the user edited the item, it belongs to them — do NOT delete.
    let demoItemDeleted = false;
    if (state.demoItemId) {
      const demoItem = await prisma.item.findUnique({
        where: { id: state.demoItemId },
        select: { id: true, title: true, url: true, priceText: true, becameRealAt: true, status: true },
      });
      if (
        demoItem &&
        demoItem.status !== 'DELETED' &&
        state.variantKey &&
        getDemoTemplate(state.variantKey) &&
        isDemoItemUntouched(demoItem, getDemoTemplate(state.variantKey)!)
      ) {
        await prisma.item.update({
          where: { id: state.demoItemId },
          data: { status: 'DELETED', archivedAt: now },
        });
        demoItemDeleted = true;
      }
    }

    // v2 cleanup: only delete fallback demo item, never touch imported/catalog items
    const meta = getOnboardingMeta(state.metaJson);
    if (meta.onboardingVariant === 'v2_try' && meta.fallbackDemoItemId) {
      const fallbackItem = await prisma.item.findUnique({
        where: { id: meta.fallbackDemoItemId },
        select: { id: true, status: true, isDemo: true },
      });
      if (fallbackItem && fallbackItem.isDemo && fallbackItem.status !== 'DELETED') {
        await prisma.item.update({
          where: { id: meta.fallbackDemoItemId },
          data: { status: 'DELETED', archivedAt: now },
        });
        demoItemDeleted = true;
      }
    }

    const dismissLocale = getRequestLocale(req);
    trackEvent('onboarding_dismissed', user.id, {
      onboarding_key: ONBOARDING_KEY,
      version: ONBOARDING_VERSION,
      variant_key: state.variantKey ?? null,
      entry_point: state.entryPoint ?? null,
      forced_rollout: FORCED_ROLLOUT_USERS.has(user.id),
      market_segment: state.variantKey ? variantKeyToSegment(state.variantKey) : resolveMarketSegment(dismissLocale),
      locale_used: dismissLocale,
      demo_item_deleted: demoItemDeleted,
      onboarding_variant: meta.onboardingVariant ?? 'v1_demo',
      experiment_phase: (meta.onboardingVariant ?? 'v1_demo') === 'v1_demo' ? 'legacy_recovery' : 'post_rollout',
      onboarding_flow: (meta.onboardingVariant ?? 'v1_demo') === 'v1_demo' ? 'v1_demo_recovery' : 'main_v2',
    });

    return res.json({ ok: true, demoItemDeleted });
  }),
);

// POST /tg/onboarding/complete — explicitly mark onboarding complete (called by frontend after auto-completion)
tgRouter.post(
  '/onboarding/complete',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({ onboardingKey: z.string(), reason: z.enum(['demo_converted', 'real_item_created', 'demo_deleted_then_real_created', 'demo_moved_to_user_wishlist', 'try_import_completed', 'catalog_selected', 'manual_created']) })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    if (parsed.data.onboardingKey !== ONBOARDING_KEY) return res.status(400).json({ error: 'Unknown onboarding key' });

    const user = await getOrCreateTgUser(req.tgUser!);
    // completeOnboarding() fires 'onboarding_completed' analytics event internally (idempotent).
    await completeOnboarding(user.id, parsed.data.reason);

    return res.json({ ok: true });
  }),
);

// POST /tg/onboarding/try-import — import URL from onboarding v2 (NO PRO gate)
const onboardingImportLimiter = rateLimit({
  windowMs: 60_000,
  limit: 3,
  keyGenerator: (req) => req.tgUser ? String(req.tgUser.id) : 'anon',
  validate: false,
});

tgRouter.post(
  '/onboarding/try-import',
  onboardingImportLimiter,
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({ url: z.string().min(1).max(2048), onboardingStateId: z.string() })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    try { validateUrl(parsed.data.url); } catch (err: any) {
      return res.status(400).json({ error: err.message || 'Invalid URL' });
    }

    const user = await getOrCreateTgUser(req.tgUser!);
    const state = await prisma.userOnboardingState.findUnique({ where: { id: parsed.data.onboardingStateId } });

    if (!state || state.userId !== user.id || state.status !== 'IN_PROGRESS') {
      return res.status(409).json({ error: 'Invalid onboarding state' });
    }

    const meta = getOnboardingMeta(state.metaJson);
    if (meta.onboardingVariant !== 'v2_try') {
      return res.status(400).json({ error: 'Wrong variant for try-import' });
    }
    if ((meta.tryAttemptsUsed ?? 0) >= 30) {
      return res.status(429).json({ error: 'Max attempts reached' });
    }
    if ((meta.trySuccessCount ?? 0) >= 20) {
      return res.status(409).json({ error: 'Onboarding trial limit reached', limit: 20 });
    }

    // NO PRO gate — onboarding free pass
    const result = await importUrlForUser(user.id, parsed.data.url, undefined, 'onboarding_try');

    const newMeta: OnboardingMeta = {
      ...meta,
      tryAttemptsUsed: (meta.tryAttemptsUsed ?? 0) + 1,
    };

    if (result.parseStatus !== 'failed') {
      newMeta.trySuccessCount = (meta.trySuccessCount ?? 0) + 1;
      newMeta.tryImportedItemIds = [...(meta.tryImportedItemIds ?? []), result.item.id];
      newMeta.acquisitionPath = 'try_import';
      newMeta.lastStep = 'onboarding-success';
    } else {
      newMeta.lastStep = 'onboarding-recovery';
    }

    await prisma.userOnboardingState.update({
      where: { id: state.id },
      data: { metaJson: newMeta as any },
    });

    const eventName = result.parseStatus !== 'failed' ? 'onboarding_try_import_success' : 'onboarding_try_import_failed';
    trackEvent(eventName, user.id, {
      onboarding_key: ONBOARDING_KEY,
      version: ONBOARDING_VERSION,
      onboarding_variant: 'v2_try',
      parse_status: result.parseStatus,
      attempt_number: newMeta.tryAttemptsUsed,
      url_domain: result.item.sourceDomain ?? null,
      item_id: result.item.id,
    });

    return res.status(201).json({ item: result.item, parseStatus: result.parseStatus, wishlistId: result.wishlistId });
  }),
);

// POST /tg/onboarding/manual-add — add item manually during onboarding (v2)
tgRouter.post(
  '/onboarding/manual-add',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        title: z.string().min(1).max(200),
        priceText: z.string().max(100).optional(),
        onboardingStateId: z.string(),
      })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const state = await prisma.userOnboardingState.findUnique({ where: { id: parsed.data.onboardingStateId } });

    if (!state || state.userId !== user.id || state.status !== 'IN_PROGRESS') {
      return res.status(409).json({ error: 'Invalid onboarding state' });
    }
    const meta = getOnboardingMeta(state.metaJson);
    if (meta.onboardingVariant !== 'v2_try') {
      return res.status(400).json({ error: 'Wrong variant for manual-add' });
    }

    const draftsWl = await getOrCreateDraftsWishlist(user.id);
    const item = await prisma.item.create({
      data: {
        wishlistId: draftsWl.id,
        title: parsed.data.title.trim(),
        url: '',
        priceText: parsed.data.priceText?.trim() || null,
        importMethod: 'onboarding_manual',
      },
    });
    // Dual-write: placement for onboarding-manual item.
    await ensureItemPlacement(prisma, { wishlistId: draftsWl.id, itemId: item.id });

    const newMeta: OnboardingMeta = {
      ...meta,
      manualItemIds: [...(meta.manualItemIds ?? []), item.id],
      acquisitionPath: meta.acquisitionPath ?? 'manual',
      lastStep: 'onboarding-create-wishlist',
    };
    await prisma.userOnboardingState.update({
      where: { id: state.id },
      data: { metaJson: newMeta as any },
    });

    trackEvent('onboarding_manual_item_added', user.id, {
      onboarding_key: ONBOARDING_KEY,
      version: ONBOARDING_VERSION,
      onboarding_variant: 'v2_try',
      item_id: item.id,
      has_price: !!parsed.data.priceText,
    });

    return res.status(201).json({ item, ok: true });
  }),
);

// POST /tg/onboarding/catalog-select — create items from catalog templates (v2)
tgRouter.post(
  '/onboarding/catalog-select',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({ catalogKeys: z.array(z.string()).min(1).max(6), onboardingStateId: z.string() })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const state = await prisma.userOnboardingState.findUnique({ where: { id: parsed.data.onboardingStateId } });

    if (!state || state.userId !== user.id || state.status !== 'IN_PROGRESS') {
      return res.status(409).json({ error: 'Invalid onboarding state' });
    }
    const meta = getOnboardingMeta(state.metaJson);
    if (meta.onboardingVariant !== 'v2_try') {
      return res.status(400).json({ error: 'Wrong variant' });
    }

    const locale = getRequestLocale(req);
    const segment = resolveMarketSegment(locale);
    const catalog = getCatalogForSegment(segment);
    const selected = parsed.data.catalogKeys
      .map((k: string) => catalog.find((c: CatalogTemplate) => c.key === k))
      .filter((c: CatalogTemplate | undefined): c is CatalogTemplate => !!c);

    if (selected.length === 0) return res.status(400).json({ error: 'No valid catalog items' });

    const draftsWl = await getOrCreateDraftsWishlist(user.id);
    const createdIds: string[] = [];
    for (const tmpl of selected) {
      const item = await prisma.item.create({
        data: {
          wishlistId: draftsWl.id,
          title: t(tmpl.titleKey, locale),
          url: '',
          priceText: String(tmpl.amount),
          currency: tmpl.currency,
          originVariantKey: `catalog_${tmpl.key}`,
          importMethod: 'onboarding_catalog',
          // NOT isDemo — catalog selections are real user intent
        },
      });
      // Dual-write: placement for each catalog-created item.
      await ensureItemPlacement(prisma, { wishlistId: draftsWl.id, itemId: item.id });
      createdIds.push(item.id);
    }

    const newMeta: OnboardingMeta = {
      ...meta,
      catalogItemIds: createdIds,
      acquisitionPath: meta.acquisitionPath ?? 'catalog',
      lastStep: 'onboarding-create-wishlist',
    };
    await prisma.userOnboardingState.update({
      where: { id: state.id },
      data: { metaJson: newMeta as any },
    });

    trackEvent('onboarding_catalog_submitted', user.id, {
      onboarding_key: ONBOARDING_KEY,
      version: ONBOARDING_VERSION,
      onboarding_variant: 'v2_try',
      catalog_keys: parsed.data.catalogKeys,
      count: selected.length,
      market_segment: segment,
    });

    return res.status(201).json({ ok: true, catalogItemIds: createdIds });
  }),
);

// POST /tg/onboarding/update-step — persist lastStep + optional acquisitionPath for resume
tgRouter.post(
  '/onboarding/update-step',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        onboardingStateId: z.string(),
        step: z.string().max(50),
        acquisitionPath: z.enum(['try_import', 'manual', 'catalog', 'fallback_demo']).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const state = await prisma.userOnboardingState.findUnique({ where: { id: parsed.data.onboardingStateId } });
    if (!state || state.userId !== user.id) return res.status(404).json({ error: 'Not found' });

    const meta = getOnboardingMeta(state.metaJson);
    const updated: OnboardingMeta = { ...meta, lastStep: parsed.data.step };
    if (parsed.data.acquisitionPath) updated.acquisitionPath = parsed.data.acquisitionPath;

    await prisma.userOnboardingState.update({
      where: { id: state.id },
      data: { metaJson: updated as any },
    });

    return res.json({ ok: true });
  }),
);

// POST /tg/onboarding/create-wishlist — create first wishlist and auto-attach onboarding items
tgRouter.post(
  '/onboarding/create-wishlist',
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        title: z.string().min(1).max(200),
        onboardingStateId: z.string(),
      })
      .safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const state = await prisma.userOnboardingState.findUnique({ where: { id: parsed.data.onboardingStateId } });
    if (!state || state.userId !== user.id || state.status !== 'IN_PROGRESS') {
      return res.status(409).json({ error: 'Invalid onboarding state' });
    }

    const meta = getOnboardingMeta(state.metaJson);
    if (meta.onboardingVariant !== 'v2_try') {
      return res.status(400).json({ error: 'Wrong variant' });
    }

    // Create the wishlist
    const position = 0; // top position for first wishlist
    const profile = await prisma.userProfile.findUnique({ where: { userId: user.id }, select: { commentsEnabled: true } });
    const inheritedCommentPolicy = profile?.commentsEnabled === false ? 'SUBSCRIBERS' : 'ALL';
    const wishlist = await prisma.wishlist.create({
      data: {
        slug: `wl-${crypto.randomUUID().slice(0, 12)}`,
        ownerId: user.id,
        title: parsed.data.title.trim(),
        type: 'REGULAR',
        position,
        commentPolicy: inheritedCommentPolicy,
      },
      select: { id: true, slug: true, title: true, description: true, deadline: true },
    });

    // Collect all onboarding item IDs to move.
    // Bug history: manualItemIds was missing here, so items the user added
    // through the /onboarding/manual-add path stayed in SYSTEM_DRAFTS forever
    // (invisible in the new REGULAR wishlist) — also blocked referral
    // first_item crediting because move logic drove that hook.
    const itemIdsToMove: string[] = [
      ...(meta.tryImportedItemIds ?? []),
      ...(meta.catalogItemIds ?? []),
      ...(meta.manualItemIds ?? []),
    ];

    // Move items from SYSTEM_DRAFTS to the new wishlist.
    // Onboarding items have a single placement in drafts; we reuse relocateItemPrimary
    // so placements migrate alongside Item.wishlistId (otherwise placement-based reads
    // would still show the items in drafts and hide them from the new wishlist).
    let movedCount = 0;
    if (itemIdsToMove.length > 0) {
      const eligibleItems = await prisma.item.findMany({
        where: {
          id: { in: itemIdsToMove },
          wishlist: { ownerId: user.id, type: 'SYSTEM_DRAFTS' },
          status: { in: ['AVAILABLE', 'RESERVED'] },
        },
        select: { id: true, wishlistId: true },
      });
      for (const item of eligibleItems) {
        await relocateItemPrimary(item.id, item.wishlistId, wishlist.id);
      }
      movedCount = eligibleItems.length;
    }

    // Update onboarding state
    const newMeta: OnboardingMeta = {
      ...meta,
      lastStep: 'onboarding-share',
    };
    await prisma.userOnboardingState.update({
      where: { id: state.id },
      data: { metaJson: newMeta as any },
    });

    const locale = getRequestLocale(req);
    trackEvent('onboarding_create_wishlist_success', user.id, {
      onboarding_key: ONBOARDING_KEY,
      version: ONBOARDING_VERSION,
      onboarding_variant: 'v2_try',
      acquisition_path: meta.acquisitionPath ?? null,
      wishlist_id: wishlist.id,
      items_moved: movedCount,
      market_segment: resolveMarketSegment(locale),
    });

    trackEvent('onboarding_items_attached_to_wishlist', user.id, {
      onboarding_key: ONBOARDING_KEY,
      onboarding_variant: 'v2_try',
      wishlist_id: wishlist.id,
      item_ids: itemIdsToMove,
      moved_count: movedCount,
    });

    // Referral: onboarding's create-wishlist goes through a separate code path
    // from POST /tg/wishlists, so the referral hook wouldn't fire otherwise.
    // Both markers are applicable here: the wishlist is REGULAR, and if any
    // onboarding items got attached (template/try-import/catalog), those count
    // as the user's "first items" — by the time this endpoint returns, both
    // qualification criteria are met.
    void runReferralProgressHook(user.id, 'first_wishlist');
    if (movedCount > 0) {
      void runReferralProgressHook(user.id, 'first_item');
    }

    return res.status(201).json({
      wishlist: { ...wishlist, itemCount: movedCount, reservedCount: 0 },
      movedCount,
    });
  }),
);

// ─── end Onboarding Endpoints ─────────────────────────────────────────────────

// GET /tg/me/god-stats — internal analytics dashboard (god mode users only)
// Double-gated: user must be in GOD_MODE_TELEGRAM_IDS whitelist AND have godMode=true.
// Active user definition (7d / 30d):
//   A user is "active" if within the period they created or updated a REGULAR wishlist
//   OR created or updated any non-deleted item — proxies real product usage from existing
//   entity timestamps without requiring a dedicated event log.
// Share proxy: users with ≥1 wishlist where shareToken was explicitly generated.
// Reservation funnel step: users who *received* ≥1 reservation on their wishlist items
//   (semantic: "your wishlist had real engagement from another person").
tgRouter.get(
  '/me/god-stats',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);

    const godModeAllowedIds = (process.env.GOD_MODE_TELEGRAM_IDS ?? '').split(',').filter(Boolean);
    const canGodMode = user.telegramId ? godModeAllowedIds.includes(user.telegramId) : false;
    if (!canGodMode || !user.godMode) return res.status(403).json({ error: 'Forbidden' });

    const now = new Date();
    const cut24 = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const cut7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const cut30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    type CountRow = { count: bigint };
    const n = (r: CountRow | undefined) => Number(r?.count ?? 0);

    const [
      totalUsers,
      newUsers24h,
      newUsers7d,
      active7dRows,
      active30dRows,
      totalWishlists,
      totalItems,
      totalReservations,
      proUsers,
      withWishlistRows,
      withItemInRegularRows,
      withItemInAnyRows,
      withAnyWishlistRows,
      withShareRows,
      sharedLinkOpensRows,
      wishlistsWithLinkOpenRows,
      usersWithLinkOpenRows,
      withReservationRows,
      totalComments,
      totalHints,
      totalWishlistSubs,
      proLimitTotalRows,
      proLimitUsersRows,
      proLimitByTypeRows,
      errors24hTotal,
      errors24hUsersRows,
      errors24hTopRows,
      onboardingStartedByVariantRows,
      onboardingCompletedRows,
    ] = await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { createdAt: { gte: cut24 } } }),
      prisma.user.count({ where: { createdAt: { gte: cut7 } } }),
      // Active users 7d: created/updated REGULAR wishlist OR created/updated non-deleted item
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(DISTINCT owner_id)::int AS count FROM (
          SELECT "ownerId" AS owner_id FROM "Wishlist"
            WHERE "updatedAt" >= ${cut7} AND type = 'REGULAR'
          UNION
          SELECT w."ownerId" AS owner_id FROM "Item" i
            JOIN "Wishlist" w ON i."wishlistId" = w.id
            WHERE i."updatedAt" >= ${cut7} AND i.status != 'DELETED'
        ) _a`,
      // Active users 30d: same definition
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(DISTINCT owner_id)::int AS count FROM (
          SELECT "ownerId" AS owner_id FROM "Wishlist"
            WHERE "updatedAt" >= ${cut30} AND type = 'REGULAR'
          UNION
          SELECT w."ownerId" AS owner_id FROM "Item" i
            JOIN "Wishlist" w ON i."wishlistId" = w.id
            WHERE i."updatedAt" >= ${cut30} AND i.status != 'DELETED'
        ) _a`,
      prisma.wishlist.count({ where: { type: 'REGULAR' } }),
      prisma.item.count({ where: { status: { not: 'DELETED' } } }),
      prisma.reservationEvent.count({ where: { type: 'RESERVED' } }),
      prisma.subscription.count({ where: { status: 'ACTIVE' } }),
      // Funnel — users with ≥1 REGULAR wishlist (= "activated" proxy)
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(DISTINCT "ownerId")::int AS count FROM "Wishlist"
        WHERE type = 'REGULAR'`,
      // Users with ≥1 non-deleted item IN REGULAR WISHLIST (canonical funnel metric)
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(DISTINCT w."ownerId")::int AS count
        FROM "Item" i JOIN "Wishlist" w ON i."wishlistId" = w.id
        WHERE i.status != 'DELETED' AND w.type = 'REGULAR'`,
      // Users with ≥1 non-deleted item in ANY wishlist (including SYSTEM_DRAFTS)
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(DISTINCT w."ownerId")::int AS count
        FROM "Item" i JOIN "Wishlist" w ON i."wishlistId" = w.id
        WHERE i.status != 'DELETED'`,
      // Users with ≥1 ANY wishlist (including SYSTEM_DRAFTS)
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(DISTINCT "ownerId")::int AS count FROM "Wishlist"`,
      // Funnel share step 1: users who opened share screen (shareToken generated via POST /share-token)
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(DISTINCT "ownerId")::int AS count FROM "Wishlist"
        WHERE "shareToken" IS NOT NULL AND type = 'REGULAR'`,
      // Funnel share step 2: total link opens across all wishlists (SUM of shareOpenCount)
      prisma.$queryRaw<CountRow[]>`
        SELECT COALESCE(SUM("shareOpenCount"), 0)::int AS count FROM "Wishlist"
        WHERE "shareToken" IS NOT NULL AND type = 'REGULAR'`,
      // Funnel share step 3: distinct wishlists that received ≥1 link open
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::int AS count FROM "Wishlist"
        WHERE "shareOpenCount" > 0 AND type = 'REGULAR'`,
      // Funnel share step 4: distinct users whose wishlist was opened ≥1 time via shared link
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(DISTINCT "ownerId")::int AS count FROM "Wishlist"
        WHERE "shareOpenCount" > 0 AND type = 'REGULAR'`,
      // Received ≥1 reservation on their wishlist items
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(DISTINCT w."ownerId")::int AS count
        FROM "ReservationEvent" re
        JOIN "Item" i ON re."itemId" = i.id
        JOIN "Wishlist" w ON i."wishlistId" = w.id
        WHERE re.type = 'RESERVED'`,
      // Engagement: total user-authored comments
      prisma.comment.count({ where: { type: 'USER' } }),
      // Engagement: total hint requests
      prisma.santaHintRequest.count(),
      // Engagement: total wishlist subscriptions (social follows)
      prisma.wishlistSubscription.count(),
      // PRO limits last 24h: total gate hits
      prisma.analyticsEvent.count({
        where: { event: { startsWith: 'feature_gate_hit_' }, createdAt: { gte: cut24 } },
      }),
      // PRO limits last 24h: unique users who hit any gate
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(DISTINCT "userId")::int AS count FROM "AnalyticsEvent"
        WHERE event LIKE 'feature_gate_hit_%' AND "createdAt" >= ${cut24}`,
      // PRO limits last 24h: hits by event type
      prisma.$queryRaw<{ event: string; count: bigint }[]>`
        SELECT event, COUNT(*)::int AS count FROM "AnalyticsEvent"
        WHERE event LIKE 'feature_gate_hit_%' AND "createdAt" >= ${cut24}
        GROUP BY event`,
      // Errors last 24h: total 4xx/5xx (excludes 401)
      prisma.analyticsEvent.count({
        where: { event: { startsWith: 'error:' }, createdAt: { gte: cut24 } },
      }),
      // Errors last 24h: unique affected users
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(DISTINCT "userId")::int AS count FROM "AnalyticsEvent"
        WHERE event LIKE 'error:%' AND "createdAt" >= ${cut24} AND "userId" IS NOT NULL`,
      // Errors last 24h: top 3 by frequency
      prisma.$queryRaw<{ event: string; count: bigint }[]>`
        SELECT event, COUNT(*)::int AS count FROM "AnalyticsEvent"
        WHERE event LIKE 'error:%' AND "createdAt" >= ${cut24}
        GROUP BY event ORDER BY count DESC LIMIT 3`,
      // Onboarding hello_activation: started by variant (30d — same window as overview/funnel)
      prisma.$queryRaw<{ variant_key: string; count: bigint }[]>`
        SELECT props->>'variant_key' AS variant_key, COUNT(*)::int AS count FROM "AnalyticsEvent"
        WHERE event = 'onboarding_started'
          AND props->>'onboarding_key' = 'hello_activation'
          AND "createdAt" >= ${cut30}
        GROUP BY props->>'variant_key'`,
      // Onboarding hello_activation: completed (30d)
      prisma.$queryRaw<CountRow[]>`
        SELECT COUNT(*)::int AS count FROM "AnalyticsEvent"
        WHERE event = 'onboarding_completed'
          AND props->>'onboarding_key' = 'hello_activation'
          AND "createdAt" >= ${cut30}`,
    ]);

    const withWishlist = n(withWishlistRows[0]);

    // Build onboarding variant breakdown map
    const onboardingByVariant: Record<string, number> = {};
    for (const row of onboardingStartedByVariantRows) {
      if (row.variant_key) onboardingByVariant[row.variant_key] = Number(row.count);
    }

    // Build PRO limits by-type map
    const proByType: Record<string, number> = {};
    for (const row of proLimitByTypeRows) {
      proByType[row.event] = Number(row.count);
    }

    // ── Market segments (by bucket) ──────────────────────────────────────────
    const BUCKET_ORDER: MarketBucket[] = ['ru', 'en', 'ar', 'hi', 'zh-CN', 'es', 'other_known', 'unknown'];

    const localeScope = (req.query.localeScope as string) || 'active30d';
    const localeScopeFilter =
      localeScope === 'new7d'
        ? `AND u."createdAt" >= '${cut7.toISOString()}'`
        : localeScope === 'active30d'
          ? `AND u.id IN (
               SELECT "ownerId" FROM "Wishlist" WHERE "updatedAt" >= '${cut30.toISOString()}' AND type = 'REGULAR'
               UNION
               SELECT w."ownerId" FROM "Item" i JOIN "Wishlist" w ON i."wishlistId" = w.id
               WHERE i."updatedAt" >= '${cut30.toISOString()}' AND i.status != 'DELETED'
             )`
          : ''; // 'all' — no filter

    type SegRow = { bucket: string; count: number };
    const localeSegmentRows = await prisma.$queryRawUnsafe<SegRow[]>(`
      SELECT COALESCE(p."marketBucket", 'unknown') AS bucket, COUNT(*)::int AS count
      FROM "User" u
      LEFT JOIN "UserProfile" p ON p."userId" = u.id
      WHERE 1=1 ${localeScopeFilter}
      GROUP BY bucket
      ORDER BY count DESC`,
    );

    let segTotal = 0;
    const bucketCounts: Record<string, number> = {};
    for (const row of localeSegmentRows) {
      const cnt = Number(row.count);
      segTotal += cnt;
      bucketCounts[row.bucket] = (bucketCounts[row.bucket] ?? 0) + cnt;
    }

    const segments: { segmentKey: string; segmentLabel: string; usersCount: number; sharePercent: number }[] = BUCKET_ORDER
      .map(b => ({
        segmentKey: b,
        segmentLabel: MARKET_BUCKET_LABELS[b],
        usersCount: bucketCounts[b] ?? 0,
        sharePercent: segTotal > 0 ? Math.round(((bucketCounts[b] ?? 0) / segTotal) * 1000) / 10 : 0,
      }))
      .filter(s => s.usersCount > 0);

    // ── Market bucket distribution ──────────────────────────────────────────────
    // Uses the persisted marketBucket column for fast aggregation.
    // Falls back to SQL derivation for users who haven't been seen since the migration.
    type BucketRow = { bucket: string; total: number; new_7d: number };
    const marketBucketRows = await prisma.$queryRaw<BucketRow[]>`
      SELECT
        COALESCE(p."marketBucket",
          CASE
            WHEN p.language IS NOT NULL THEN
              CASE
                WHEN LOWER(p.language) LIKE 'ru%' THEN 'ru'
                WHEN LOWER(p.language) LIKE 'ar%' THEN 'ar'
                WHEN LOWER(p.language) LIKE 'en%' THEN 'en'
                WHEN LOWER(p.language) LIKE 'hi%' THEN 'hi'
                WHEN LOWER(p.language) LIKE 'zh%' THEN 'zh-CN'
                WHEN LOWER(p.language) LIKE 'es%' THEN 'es'
                ELSE 'other_known'
              END
            ELSE 'unknown'
          END
        ) AS bucket,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE u."createdAt" >= ${cut7})::int AS new_7d
      FROM "User" u
      LEFT JOIN "UserProfile" p ON p."userId" = u.id
      GROUP BY bucket
      ORDER BY total DESC`;

    const marketBuckets = BUCKET_ORDER.map(b => {
      const row = marketBucketRows.find(r => r.bucket === b);
      return {
        bucket: b,
        label: MARKET_BUCKET_LABELS[b],
        total: row?.total ?? 0,
        new7d: row?.new_7d ?? 0,
      };
    }).filter(b => b.total > 0);

    // Import support split (users with/without import support)
    type ImportSplitRow = { supported: boolean; total: number; new_7d: number };
    const importSplitRows = await prisma.$queryRaw<ImportSplitRow[]>`
      SELECT
        COALESCE(p."supportedImportRegion",
          CASE WHEN COALESCE(p."marketBucket",
            CASE WHEN p.language IS NOT NULL AND LOWER(p.language) LIKE 'ru%' THEN 'ru' ELSE 'other' END
          ) = 'ru' THEN true ELSE false END
        ) AS supported,
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE u."createdAt" >= ${cut7})::int AS new_7d
      FROM "User" u
      LEFT JOIN "UserProfile" p ON p."userId" = u.id
      GROUP BY supported`;

    const importSplit = {
      supported: { total: 0, new7d: 0 },
      unsupported: { total: 0, new7d: 0 },
    };
    for (const row of importSplitRows) {
      const key = row.supported ? 'supported' : 'unsupported';
      importSplit[key] = { total: row.total, new7d: row.new_7d };
    }

    // ── Conversion by market bucket ────────────────────────────────────────────
    // Per-bucket: new users (7d), first wishlist, first item, onboarding paths, import usage
    type BucketFunnelRow = { bucket: string; count: number };
    const [bucketFirstWlRows, bucketFirstItemRows, bucketOnbStartedRows, bucketOnbCompletedRows, bucketImportAttemptRows, bucketImportFailRows] = await Promise.all([
      // First regular wishlist created in last 7d, by bucket
      prisma.$queryRaw<BucketFunnelRow[]>`
        SELECT COALESCE(p."marketBucket", 'unknown') AS bucket, COUNT(DISTINCT w."ownerId")::int AS count
        FROM "Wishlist" w
        JOIN "User" u ON w."ownerId" = u.id
        LEFT JOIN "UserProfile" p ON p."userId" = u.id
        WHERE w.type = 'REGULAR' AND u."createdAt" >= ${cut7}
        GROUP BY bucket`,
      // First item in regular wishlist created in last 7d, by bucket
      prisma.$queryRaw<BucketFunnelRow[]>`
        SELECT COALESCE(p."marketBucket", 'unknown') AS bucket, COUNT(DISTINCT w."ownerId")::int AS count
        FROM "Item" i
        JOIN "Wishlist" w ON i."wishlistId" = w.id
        JOIN "User" u ON w."ownerId" = u.id
        LEFT JOIN "UserProfile" p ON p."userId" = u.id
        WHERE i.status != 'DELETED' AND w.type = 'REGULAR' AND u."createdAt" >= ${cut7}
        GROUP BY bucket`,
      // Onboarding started (7d), by bucket
      prisma.$queryRaw<BucketFunnelRow[]>`
        SELECT COALESCE(p."marketBucket", 'unknown') AS bucket, COUNT(DISTINCT ae."userId")::int AS count
        FROM "AnalyticsEvent" ae
        JOIN "UserProfile" p ON p."userId" = ae."userId"
        WHERE ae.event = 'onboarding_started' AND ae."createdAt" >= ${cut7}
        GROUP BY bucket`,
      // Onboarding completed (7d), by bucket
      prisma.$queryRaw<BucketFunnelRow[]>`
        SELECT COALESCE(p."marketBucket", 'unknown') AS bucket, COUNT(DISTINCT ae."userId")::int AS count
        FROM "AnalyticsEvent" ae
        JOIN "UserProfile" p ON p."userId" = ae."userId"
        WHERE ae.event = 'onboarding_completed' AND ae."createdAt" >= ${cut7}
        GROUP BY bucket`,
      // Import attempts (7d), by bucket
      prisma.$queryRaw<BucketFunnelRow[]>`
        SELECT COALESCE(p."marketBucket", 'unknown') AS bucket, COUNT(*)::int AS count
        FROM "AnalyticsEvent" ae
        JOIN "UserProfile" p ON p."userId" = ae."userId"
        WHERE ae.event = 'onboarding_try_import_submitted' AND ae."createdAt" >= ${cut7}
        GROUP BY bucket`,
      // Import failures (7d), by bucket
      prisma.$queryRaw<BucketFunnelRow[]>`
        SELECT COALESCE(p."marketBucket", 'unknown') AS bucket, COUNT(*)::int AS count
        FROM "AnalyticsEvent" ae
        JOIN "UserProfile" p ON p."userId" = ae."userId"
        WHERE ae.event IN ('onboarding_try_import_error', 'onboarding_try_import_exception') AND ae."createdAt" >= ${cut7}
        GROUP BY bucket`,
    ]);

    const bfMap = (rows: BucketFunnelRow[]) => {
      const m: Record<string, number> = {};
      for (const r of rows) m[r.bucket] = r.count;
      return m;
    };
    const bfFirstWl = bfMap(bucketFirstWlRows);
    const bfFirstItem = bfMap(bucketFirstItemRows);
    const bfOnbStarted = bfMap(bucketOnbStartedRows);
    const bfOnbCompleted = bfMap(bucketOnbCompletedRows);
    const bfImportAttempts = bfMap(bucketImportAttemptRows);
    const bfImportFails = bfMap(bucketImportFailRows);

    const bucketFunnel = BUCKET_ORDER.map(b => {
      const mbRow = marketBucketRows.find(r => r.bucket === b);
      const newUsers = mbRow?.new_7d ?? 0;
      const firstWl = bfFirstWl[b] ?? 0;
      const firstItem = bfFirstItem[b] ?? 0;
      const onbStarted = bfOnbStarted[b] ?? 0;
      const onbCompleted = bfOnbCompleted[b] ?? 0;
      const importAttempts = bfImportAttempts[b] ?? 0;
      const importFails = bfImportFails[b] ?? 0;
      return {
        bucket: b,
        label: MARKET_BUCKET_LABELS[b as MarketBucket] ?? b,
        newUsers,
        firstWishlist: firstWl,
        firstItem,
        onbStarted,
        onbCompleted,
        importAttempts,
        importFails,
      };
    }).filter(b => b.newUsers > 0);

    // ── Acquisition / Growth Diagnostics (v2) ──────────────────────────────────
    // Exclude test/godMode users from acquisition metrics for clean data
    const testUsers = await prisma.user.findMany({
      where: { OR: [{ godMode: true }, { telegramId: { in: godModeAllowedIds } }] },
      select: { id: true, telegramId: true },
    });
    const testIds = testUsers.map(u => u.id);
    const testTgIds = testUsers.map(u => u.telegramId).filter(Boolean) as string[];
    // SQL exclusion fragments (bot events use telegramId as userId; API events use internal id)
    // NULL-safe: "userId" can be NULL for anonymous events (e.g. guest.view_opened).
    // Plain NOT IN excludes NULLs (SQL: NULL NOT IN (...) → UNKNOWN → row excluded).
    const xTg = testTgIds.length > 0 ? Prisma.sql`AND ("userId" IS NULL OR "userId" NOT IN (${Prisma.join(testTgIds)}))` : Prisma.sql``;
    const xId = testIds.length > 0 ? Prisma.sql`AND ("userId" IS NULL OR "userId" NOT IN (${Prisma.join(testIds)}))` : Prisma.sql``;
    const xUser = testIds.length > 0 ? Prisma.sql`AND id NOT IN (${Prisma.join(testIds)})` : Prisma.sql``;
    const xOwner = testIds.length > 0 ? Prisma.sql`AND "ownerId" NOT IN (${Prisma.join(testIds)})` : Prisma.sql``;
    const xWOwner = testIds.length > 0 ? Prisma.sql`AND w."ownerId" NOT IN (${Prisma.join(testIds)})` : Prisma.sql``;

    const acqPeriod = (req.query.period as string) || '7d';
    const periodMs = acqPeriod === '24h' ? 86_400_000 : acqPeriod === '30d' ? 30 * 86_400_000 : 7 * 86_400_000;
    const acqCut = new Date(now.getTime() - periodMs);
    const acqCutPrev = new Date(now.getTime() - 2 * periodMs);

    // Phase 1: parallel metrics (current + previous period, test users excluded)
    const [
      botStartsCur, botStartsPrev,
      miniappOpensCur, miniappOpensPrev,
      newUsersCur, newUsersPrev,
      guestEventsCur, guestEventsPrev,
      guestUsersCur, guestUsersPrev,
      firstWlCur, firstWlPrev,
      firstWishCur, firstWishPrev,
      ownersSharedCur, ownersSharedPrev,
      shareGenCur, shareGenPrev,
      reserversCur, reserversPrev,
      totalResCur, totalResPrev,
      botStartsFirstEvent, miniappFirstEvent, guestFirstEvent,
      newUsersListCur,
    ] = await Promise.all([
      // /start unique (bot events: userId=telegramId)
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(DISTINCT "userId")::int AS count FROM "AnalyticsEvent" WHERE event = 'bot.start_received' AND "createdAt" >= ${acqCut} ${xTg}`,
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(DISTINCT "userId")::int AS count FROM "AnalyticsEvent" WHERE event = 'bot.start_received' AND "createdAt" >= ${acqCutPrev} AND "createdAt" < ${acqCut} ${xTg}`,
      // Miniapp opens (API events: userId=internal id)
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(DISTINCT "userId")::int AS count FROM "AnalyticsEvent" WHERE event = 'miniapp.bootstrap_succeeded' AND "createdAt" >= ${acqCut} ${xId}`,
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(DISTINCT "userId")::int AS count FROM "AnalyticsEvent" WHERE event = 'miniapp.bootstrap_succeeded' AND "createdAt" >= ${acqCutPrev} AND "createdAt" < ${acqCut} ${xId}`,
      // New users
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::int AS count FROM "User" WHERE "createdAt" >= ${acqCut} ${xUser}`,
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::int AS count FROM "User" WHERE "createdAt" >= ${acqCutPrev} AND "createdAt" < ${acqCut} ${xUser}`,
      // Guest opens (total events)
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::int AS count FROM "AnalyticsEvent" WHERE event = 'guest.view_opened' AND "createdAt" >= ${acqCut} ${xId}`,
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::int AS count FROM "AnalyticsEvent" WHERE event = 'guest.view_opened' AND "createdAt" >= ${acqCutPrev} AND "createdAt" < ${acqCut} ${xId}`,
      // Guest opens (unique users)
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(DISTINCT "userId")::int AS count FROM "AnalyticsEvent" WHERE event = 'guest.view_opened' AND "createdAt" >= ${acqCut} AND "userId" IS NOT NULL ${xId}`,
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(DISTINCT "userId")::int AS count FROM "AnalyticsEvent" WHERE event = 'guest.view_opened' AND "createdAt" >= ${acqCutPrev} AND "createdAt" < ${acqCut} AND "userId" IS NOT NULL ${xId}`,
      // First regular wishlist (entity-derived: users whose earliest REGULAR wishlist was created in period)
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::int AS count FROM (SELECT "ownerId" FROM "Wishlist" WHERE type = 'REGULAR' ${xOwner} GROUP BY "ownerId" HAVING MIN("createdAt") >= ${acqCut}) _`,
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::int AS count FROM (SELECT "ownerId" FROM "Wishlist" WHERE type = 'REGULAR' ${xOwner} GROUP BY "ownerId" HAVING MIN("createdAt") >= ${acqCutPrev} AND MIN("createdAt") < ${acqCut}) _`,
      // First item in regular wishlist (entity-derived: users whose earliest item was created in period)
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::int AS count FROM (SELECT w."ownerId" FROM "Item" i JOIN "Wishlist" w ON i."wishlistId" = w.id WHERE i.status != 'DELETED' AND w.type = 'REGULAR' ${xWOwner} GROUP BY w."ownerId" HAVING MIN(i."createdAt") >= ${acqCut}) _`,
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::int AS count FROM (SELECT w."ownerId" FROM "Item" i JOIN "Wishlist" w ON i."wishlistId" = w.id WHERE i.status != 'DELETED' AND w.type = 'REGULAR' ${xWOwner} GROUP BY w."ownerId" HAVING MIN(i."createdAt") >= ${acqCutPrev} AND MIN(i."createdAt") < ${acqCut}) _`,
      // Owners shared
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(DISTINCT "ownerId")::int AS count FROM "Wishlist" WHERE "shareToken" IS NOT NULL AND type = 'REGULAR' AND "updatedAt" >= ${acqCut} ${xOwner}`,
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(DISTINCT "ownerId")::int AS count FROM "Wishlist" WHERE "shareToken" IS NOT NULL AND type = 'REGULAR' AND "updatedAt" >= ${acqCutPrev} AND "updatedAt" < ${acqCut} ${xOwner}`,
      // Share links generated
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::int AS count FROM "Wishlist" WHERE "shareToken" IS NOT NULL AND type = 'REGULAR' AND "updatedAt" >= ${acqCut} ${xOwner}`,
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::int AS count FROM "Wishlist" WHERE "shareToken" IS NOT NULL AND type = 'REGULAR' AND "updatedAt" >= ${acqCutPrev} AND "updatedAt" < ${acqCut} ${xOwner}`,
      // Unique reservers (entity-derived from ReservationEvent table, exclude test-user wishlists)
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(DISTINCT re."actorHash")::int AS count FROM "ReservationEvent" re JOIN "Item" i ON re."itemId" = i.id JOIN "Wishlist" w ON i."wishlistId" = w.id WHERE re.type = 'RESERVED' AND re."createdAt" >= ${acqCut} ${xWOwner}`,
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(DISTINCT re."actorHash")::int AS count FROM "ReservationEvent" re JOIN "Item" i ON re."itemId" = i.id JOIN "Wishlist" w ON i."wishlistId" = w.id WHERE re.type = 'RESERVED' AND re."createdAt" >= ${acqCutPrev} AND re."createdAt" < ${acqCut} ${xWOwner}`,
      // Total reservations (entity-derived from ReservationEvent table)
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::int AS count FROM "ReservationEvent" re JOIN "Item" i ON re."itemId" = i.id JOIN "Wishlist" w ON i."wishlistId" = w.id WHERE re.type = 'RESERVED' AND re."createdAt" >= ${acqCut} ${xWOwner}`,
      prisma.$queryRaw<CountRow[]>`SELECT COUNT(*)::int AS count FROM "ReservationEvent" re JOIN "Item" i ON re."itemId" = i.id JOIN "Wishlist" w ON i."wishlistId" = w.id WHERE re.type = 'RESERVED' AND re."createdAt" >= ${acqCutPrev} AND re."createdAt" < ${acqCut} ${xWOwner}`,
      // Event coverage detection (earliest event per type — for data completeness warnings)
      prisma.$queryRaw<{ first_event: Date | null }[]>`SELECT MIN("createdAt") AS first_event FROM "AnalyticsEvent" WHERE event = 'bot.start_received'`,
      prisma.$queryRaw<{ first_event: Date | null }[]>`SELECT MIN("createdAt") AS first_event FROM "AnalyticsEvent" WHERE event = 'miniapp.bootstrap_succeeded'`,
      prisma.$queryRaw<{ first_event: Date | null }[]>`SELECT MIN("createdAt") AS first_event FROM "AnalyticsEvent" WHERE event = 'guest.view_opened'`,
      // New users list for source bucket classification
      prisma.user.findMany({
        where: { createdAt: { gte: acqCut }, ...(testIds.length > 0 ? { id: { notIn: testIds } } : {}) },
        select: { id: true, telegramId: true },
      }),
    ]);

    // Phase 2: Source bucket classification (deep_link vs direct vs unknown)
    const newUsersList = newUsersListCur as { id: string; telegramId: string | null }[];
    const tgIdsOfNew = newUsersList.map(u => u.telegramId).filter(Boolean) as string[];
    const startEventsForSrc = tgIdsOfNew.length > 0 ? await prisma.analyticsEvent.findMany({
      where: { event: 'bot.start_received', userId: { in: tgIdsOfNew } },
      select: { userId: true, props: true },
    }) : [];
    const startParamLookup = new Map<string, boolean>();
    for (const ev of startEventsForSrc) {
      if (ev.userId && !startParamLookup.has(ev.userId)) {
        startParamLookup.set(ev.userId, (ev.props as any)?.hasStartParam === true);
      }
    }
    const srcBuckets: Record<'deep_link' | 'direct' | 'unknown', string[]> = { deep_link: [], direct: [], unknown: [] };
    for (const u of newUsersList) {
      if (u.telegramId && startParamLookup.has(u.telegramId)) {
        srcBuckets[startParamLookup.get(u.telegramId)! ? 'deep_link' : 'direct'].push(u.id);
      } else {
        srcBuckets.unknown.push(u.id);
      }
    }

    // Phase 3: Per-source first_wishlist/first_wish counts (entity-derived, parallel)
    // Since all users in source buckets were created in the period, any wishlist/item they have is their first.
    const srcCount = async (ids: string[], table: 'wishlist' | 'item'): Promise<number> => {
      if (ids.length === 0) return 0;
      if (table === 'wishlist') {
        const r = await prisma.$queryRaw<CountRow[]>`SELECT COUNT(DISTINCT "ownerId")::int AS count FROM "Wishlist" WHERE type = 'REGULAR' AND "ownerId" IN (${Prisma.join(ids)})`;
        return n(r[0]);
      }
      const r = await prisma.$queryRaw<CountRow[]>`SELECT COUNT(DISTINCT w."ownerId")::int AS count FROM "Item" i JOIN "Wishlist" w ON i."wishlistId" = w.id WHERE i.status != 'DELETED' AND w.type = 'REGULAR' AND w."ownerId" IN (${Prisma.join(ids)})`;
      return n(r[0]);
    };
    const [srcWlDeep, srcWishDeep, srcWlDirect, srcWishDirect, srcWlUnknown, srcWishUnknown] = await Promise.all([
      srcCount(srcBuckets.deep_link, 'wishlist'), srcCount(srcBuckets.deep_link, 'item'),
      srcCount(srcBuckets.direct, 'wishlist'), srcCount(srcBuckets.direct, 'item'),
      srcCount(srcBuckets.unknown, 'wishlist'), srcCount(srcBuckets.unknown, 'item'),
    ]);

    const acqCur = {
      botStarts: n(botStartsCur[0]),
      miniappOpens: n(miniappOpensCur[0]),
      newUsers: n(newUsersCur[0]),
      guestOpens: n(guestEventsCur[0]),
      guestUsersUnique: n(guestUsersCur[0]),
      firstWishlist: n(firstWlCur[0]),
      firstWish: n(firstWishCur[0]),
      ownersShared: n(ownersSharedCur[0]),
      shareLinksGenerated: n(shareGenCur[0]),
      reservers: n(reserversCur[0]),
      totalReservations: n(totalResCur[0]),
    };
    const acqPrev = {
      botStarts: n(botStartsPrev[0]),
      miniappOpens: n(miniappOpensPrev[0]),
      newUsers: n(newUsersPrev[0]),
      guestOpens: n(guestEventsPrev[0]),
      guestUsersUnique: n(guestUsersPrev[0]),
      firstWishlist: n(firstWlPrev[0]),
      firstWish: n(firstWishPrev[0]),
      ownersShared: n(ownersSharedPrev[0]),
      shareLinksGenerated: n(shareGenPrev[0]),
      reservers: n(reserversPrev[0]),
      totalReservations: n(totalResPrev[0]),
    };

    const pct = (num: number, den: number) => den > 0 ? Math.round((num / den) * 1000) / 10 : null;
    // Safe pct: returns null for absurd conversions (>100%) — indicates data source mismatch
    const safePct = (num: number, den: number) => { const v = pct(num, den); return v !== null && v > 100 ? null : v; };

    // ── Event coverage detection ─────────────────────────────────────────────
    type DateRow = { first_event: Date | null };
    const botStartsSince = (botStartsFirstEvent as DateRow[])[0]?.first_event ?? null;
    const miniappSince = (miniappFirstEvent as DateRow[])[0]?.first_event ?? null;
    const guestSince = (guestFirstEvent as DateRow[])[0]?.first_event ?? null;

    // Calculate how many days of event data are available within the period
    const periodDays = acqPeriod === '24h' ? 1 : acqPeriod === '30d' ? 30 : 7;
    const covDays = (since: Date | null) => {
      if (!since || since <= acqCut) return periodDays; // full coverage
      const ms = now.getTime() - since.getTime();
      return Math.max(0, Math.round(ms / 86_400_000 * 10) / 10);
    };

    const eventCoverage = {
      botStartsFrom: botStartsSince?.toISOString() ?? null,
      botStartsDays: covDays(botStartsSince),
      miniappOpensFrom: miniappSince?.toISOString() ?? null,
      miniappOpensDays: covDays(miniappSince),
      guestEventsFrom: guestSince?.toISOString() ?? null,
      guestEventsDays: covDays(guestSince),
      periodDays,
    };

    // Build data completeness warnings
    const dataWarnings: string[] = [];
    if (botStartsSince && botStartsSince > acqCut) {
      dataWarnings.push(`Трекинг событий начался ${botStartsSince.toISOString().slice(0, 10)} — покрывает ${covDays(botStartsSince)}д из ${periodDays}д`);
    }
    // Sanity check: if new_users >> miniapp_opens, something is wrong with event coverage
    if (acqCur.newUsers > 0 && acqCur.miniappOpens > 0 && acqCur.newUsers > acqCur.miniappOpens * 3) {
      dataWarnings.push(`Новых (${acqCur.newUsers}) >> miniapp opens (${acqCur.miniappOpens}) — события покрывают не весь период`);
    }
    const dataNote = dataWarnings.length > 0 ? dataWarnings.join('. ') : null;

    // Auto-diagnosis: detect significant drops/spikes — split by data source
    type DiagAlert = { label: string; cur: number; prev: number; deltaPct: number };
    const buildAlerts = (metrics: { key: keyof typeof acqCur; label: string }[]): DiagAlert[] => {
      const alerts: DiagAlert[] = [];
      for (const m of metrics) {
        const cur = acqCur[m.key];
        const prev = acqPrev[m.key];
        if (prev > 0) {
          const dp = Math.round(((cur - prev) / prev) * 100);
          if (dp <= -30 || dp >= 50) alerts.push({ label: m.label, cur, prev, deltaPct: dp });
        } else if (prev === 0 && cur > 0) {
          alerts.push({ label: m.label, cur, prev, deltaPct: 100 });
        }
      }
      return alerts.sort((a, b) => a.deltaPct - b.deltaPct);
    };
    const dbAlerts = buildAlerts([
      { key: 'newUsers', label: 'Новые пользователи' },
      { key: 'firstWishlist', label: 'Первый вишлист' },
      { key: 'firstWish', label: 'Первое желание' },
      { key: 'ownersShared', label: 'Поделились' },
      { key: 'reservers', label: 'Забронировали' },
    ]);
    const eventAlerts = buildAlerts([
      { key: 'botStarts', label: '/start' },
      { key: 'miniappOpens', label: 'Открытия miniapp' },
      { key: 'guestOpens', label: 'Гостевые просмотры' },
    ]);

    // ── Source breakdown (all-time, not period-filtered) ──────────────────────
    // Groups users by firstAcquisitionSource field for external traffic attribution
    type SrcBreakRow = { source: string; count: bigint };
    const sourceBreakdownRaw = await prisma.$queryRaw<SrcBreakRow[]>`
      SELECT "firstAcquisitionSource" AS source, COUNT(*)::int AS count
      FROM "UserProfile"
      WHERE "firstAcquisitionSource" IS NOT NULL
      GROUP BY "firstAcquisitionSource"
      ORDER BY count DESC
    `;
    const sourceBreakdown = sourceBreakdownRaw.map(r => ({ source: r.source, count: Number(r.count) }));

    // ── Referral program metrics (lifetime + last 7d + last 24h) ──────────
    // Five panels: config snapshot, lifetime counts by status, rolling
    // windows (24h / 7d), conversions (attributed → qualified → rewarded),
    // and top reject reasons. All from indexed columns — no scans.
    const referralConfig = await loadReferralConfig(prisma);
    const [
      refStatusAll,
      refStatus24h,
      refStatus7d,
      refRewardAgg,
      refRewardAgg7d,
      refRejectReasons,
      refTopInviterRows,
    ] = await Promise.all([
      prisma.referralAttribution.groupBy({ by: ['status'], _count: { _all: true } }),
      prisma.referralAttribution.groupBy({
        by: ['status'], where: { attributedAt: { gte: cut24 } }, _count: { _all: true },
      }),
      prisma.referralAttribution.groupBy({
        by: ['status'], where: { attributedAt: { gte: cut7 } }, _count: { _all: true },
      }),
      prisma.referralReward.aggregate({
        where: { status: 'GRANTED' },
        _count: { _all: true }, _sum: { rewardValueDays: true },
      }),
      prisma.referralReward.aggregate({
        where: { status: 'GRANTED', grantedAt: { gte: cut7 } },
        _count: { _all: true }, _sum: { rewardValueDays: true },
      }),
      prisma.referralAttribution.groupBy({
        by: ['rejectReason'],
        where: { rejectReason: { not: null } },
        _count: { _all: true },
      }),
      // Top-5 inviters by rewarded count (lifetime). Helps spot power-users
      // and potential outliers for fraud investigation.
      prisma.$queryRaw<Array<{ inviterUserId: string; count: bigint }>>`
        SELECT "inviterUserId", COUNT(*)::int AS count
        FROM "ReferralAttribution"
        WHERE status = 'REWARDED'
        GROUP BY "inviterUserId"
        ORDER BY count DESC
        LIMIT 5`,
    ]);

    const fillStatusBuckets = (rows: typeof refStatusAll) => {
      const b = { ATTRIBUTED: 0, PENDING_ACTIVATION: 0, QUALIFIED: 0, REWARDED: 0, REJECTED: 0, FRAUD_REVIEW: 0 };
      for (const r of rows) b[r.status] = r._count._all;
      return b;
    };
    const refAll = fillStatusBuckets(refStatusAll);
    const refDay = fillStatusBuckets(refStatus24h);
    const refWk = fillStatusBuckets(refStatus7d);
    const refTotalAttr = Object.values(refAll).reduce((a, b) => a + b, 0);
    const refReached = refAll.QUALIFIED + refAll.REWARDED;

    // Best-effort resolution of top-inviter telegramIds for the dashboard.
    const topInviterIds = refTopInviterRows.map(r => r.inviterUserId);
    const topInviterUsers = topInviterIds.length === 0 ? [] : await prisma.user.findMany({
      where: { id: { in: topInviterIds } },
      select: { id: true, telegramId: true, firstName: true, profile: { select: { displayName: true } } },
    });
    const topInvitersEnriched = refTopInviterRows.map(r => {
      const u = topInviterUsers.find(x => x.id === r.inviterUserId);
      return {
        userId: r.inviterUserId,
        telegramId: u?.telegramId ?? null,
        name: u?.profile?.displayName ?? u?.firstName ?? null,
        rewardedCount: Number(r.count),
      };
    });

    const referralMetrics = {
      enabled: referralConfig.enabled,
      rolloutPercent: referralConfig.rolloutPercent,
      rewardDays: referralConfig.rewardDaysInviter,
      caps: { monthly: referralConfig.monthlyRewardCap, yearly: referralConfig.yearlyRewardCap },
      lifetime: {
        totalAttributions: refTotalAttr,
        byStatus: refAll,
        rewardedCount: refRewardAgg._count._all,
        totalDaysGranted: refRewardAgg._sum.rewardValueDays ?? 0,
      },
      rolling7d: {
        attributions: Object.values(refWk).reduce((a, b) => a + b, 0),
        byStatus: refWk,
        rewardedCount: refRewardAgg7d._count._all,
        daysGranted: refRewardAgg7d._sum.rewardValueDays ?? 0,
      },
      rolling24h: {
        attributions: Object.values(refDay).reduce((a, b) => a + b, 0),
        byStatus: refDay,
      },
      conversions: {
        attributed_to_qualified: pct(refReached, refTotalAttr),
        attributed_to_rewarded: pct(refAll.REWARDED, refTotalAttr),
        qualified_to_rewarded: pct(refAll.REWARDED, refReached),
      },
      rejectReasons: Object.fromEntries(
        refRejectReasons.map(r => [r.rejectReason ?? 'UNKNOWN', r._count._all]),
      ),
      topInviters: topInvitersEnriched,
      fraudReviewQueue: refAll.FRAUD_REVIEW,
    };

    return res.json({
      overview: {
        totalUsers,
        newUsers24h,
        newUsers7d,
        activeUsers7d: n(active7dRows[0]),
        activeUsers30d: n(active30dRows[0]),
        totalWishlists,
        totalItems,
        totalReservations,
        proUsers,
      },
      funnel: {
        totalUsers,
        activatedUsers: withWishlist,
        usersWithWishlist: withWishlist,
        usersWithAnyWishlist: n(withAnyWishlistRows[0]),
        usersWithItem: n(withItemInRegularRows[0]),
        usersWithItemInAny: n(withItemInAnyRows[0]),
        // Share funnel:
        // 1. Intent — user generated share token (opened share screen)
        usersWhoInitiatedShare: n(withShareRows[0]),
        // 2. Total link opens (sum of shareOpenCount across all wishlists)
        sharedLinkOpens: n(sharedLinkOpensRows[0]),
        // 3. Wishlists with ≥1 link open
        wishlistsWithLinkOpen: n(wishlistsWithLinkOpenRows[0]),
        // 4. Users whose wishlist was opened ≥1 time via shared link
        usersWithLinkOpen: n(usersWithLinkOpenRows[0]),
        usersWithReservation: n(withReservationRows[0]),
      },
      engagement: {
        totalComments,
        totalHints,
        totalWishlistSubs,
      },
      proLimits24h: {
        totalHits: proLimitTotalRows,
        uniqueUsers: n(proLimitUsersRows[0]),
        byType: {
          wishlistLimit: proByType['feature_gate_hit_wishlist_limit'] ?? 0,
          itemLimit:     proByType['feature_gate_hit_item_limit'] ?? 0,
          comments:      proByType['feature_gate_hit_comments'] ?? 0,
          hints:         proByType['feature_gate_hit_hints'] ?? 0,
          urlImport:     proByType['feature_gate_hit_url_import'] ?? 0,
        },
      },
      errors24h: {
        total: errors24hTotal,
        affectedUsers: n(errors24hUsersRows[0]),
        // Parse event format: "error:{METHOD}:{STATUS}:{route}" — route is last (may contain colons for :params)
        top: errors24hTopRows.map(row => {
          const parts = row.event.split(':');
          // parts[0]='error', parts[1]=METHOD, parts[2]=STATUS, parts[3..]=route segments
          return {
            method: parts[1] ?? '',
            status: Number(parts[2] ?? 0),
            route: parts.slice(3).join(':'),
            count: Number(row.count),
          };
        }),
      },
      // Onboarding metrics — 5 explicit rows; source: AnalyticsEvent; window: cut30 (same as overview/funnel)
      onboarding: {
        hello_activation: {
          wildberries:   onboardingByVariant['wildberries']   ?? 0,
          goldapple:     onboardingByVariant['goldapple']     ?? 0,
          ozon:          onboardingByVariant['ozon']          ?? 0,
          yandex_market: onboardingByVariant['yandex_market'] ?? 0,
          completed:     n(onboardingCompletedRows[0]),
        },
      },
      // Onboarding v2 A/B metrics (additive, separate from v1 structure)
      onboardingAB: await (async () => {
        try {
          const [abStartedRows, abCompletedRows, abPathRows, abFirstWlRows, abFirstItemRows] = await Promise.all([
            prisma.$queryRaw<{ onboarding_variant: string; count: number }[]>`
              SELECT props->>'onboarding_variant' AS onboarding_variant, COUNT(*)::int AS count FROM "AnalyticsEvent"
              WHERE event = 'onboarding_started' AND props->>'onboarding_key' = 'hello_activation' AND "createdAt" >= ${cut30}
              GROUP BY props->>'onboarding_variant'`,
            prisma.$queryRaw<{ onboarding_variant: string; count: number }[]>`
              SELECT props->>'onboarding_variant' AS onboarding_variant, COUNT(*)::int AS count FROM "AnalyticsEvent"
              WHERE event = 'onboarding_completed' AND props->>'onboarding_key' = 'hello_activation' AND "createdAt" >= ${cut30}
              GROUP BY props->>'onboarding_variant'`,
            prisma.$queryRaw<{ acquisition_path: string; count: number }[]>`
              SELECT props->>'acquisition_path' AS acquisition_path, COUNT(*)::int AS count FROM "AnalyticsEvent"
              WHERE event = 'onboarding_completed' AND props->>'onboarding_key' = 'hello_activation' AND props->>'onboarding_variant' = 'v2_try' AND "createdAt" >= ${cut30}
              GROUP BY props->>'acquisition_path'`,
            prisma.$queryRaw<{ onboarding_variant: string; count: number }[]>`
              SELECT props->>'onboarding_variant' AS onboarding_variant, COUNT(*)::int AS count FROM "AnalyticsEvent"
              WHERE event = 'onboarding_create_wishlist_success' AND props->>'onboarding_key' = 'hello_activation' AND "createdAt" >= ${cut30}
              GROUP BY props->>'onboarding_variant'`,
            prisma.$queryRaw<{ onboarding_variant: string; count: number }[]>`
              SELECT props->>'onboarding_variant' AS onboarding_variant, COUNT(*)::int AS count FROM "AnalyticsEvent"
              WHERE event IN ('onboarding_try_import_success', 'onboarding_catalog_submitted') AND props->>'onboarding_key' = 'hello_activation' AND "createdAt" >= ${cut30}
              GROUP BY props->>'onboarding_variant'`,
          ]);
          const started: Record<string, number> = {};
          for (const r of abStartedRows) started[r.onboarding_variant] = Number(r.count);
          const completed: Record<string, number> = {};
          for (const r of abCompletedRows) completed[r.onboarding_variant] = Number(r.count);
          const paths: Record<string, number> = {};
          for (const r of abPathRows) paths[r.acquisition_path] = Number(r.count);
          const firstWl: Record<string, number> = {};
          for (const r of abFirstWlRows) firstWl[r.onboarding_variant] = Number(r.count);
          const firstItem: Record<string, number> = {};
          for (const r of abFirstItemRows) firstItem[r.onboarding_variant] = Number(r.count);
          return {
            started,
            completed,
            firstWishlist: firstWl,
            firstItem: firstItem,
            v2AcquisitionPaths: paths,
            conversionRates: {
              v1_demo: { startToComplete: started['v1_demo'] ? ((completed['v1_demo'] ?? 0) / started['v1_demo'] * 100).toFixed(1) + '%' : 'N/A' },
              v2_try: { startToComplete: started['v2_try'] ? ((completed['v2_try'] ?? 0) / started['v2_try'] * 100).toFixed(1) + '%' : 'N/A' },
            },
          };
        } catch { return null; }
      })(),
      meta: {
        activeUserDef: 'users who created/updated a regular wishlist or item in the period',
        usersWhoInitiatedShareDef: 'users who opened share screen (shareToken generated via POST /share-token)',
        usersWithLinkOpenDef: 'users whose wishlist was opened ≥1 time via shared link',
        sharedLinkOpensDef: 'total times a guest opened a shared link (fire-and-forget increment)',
        wishlistsWithLinkOpenDef: 'distinct wishlists with shareOpenCount > 0',
        reservationDef: 'users whose wishlist items received ≥1 RESERVED event (entity-derived from ReservationEvent table)',
        proLimits24hDef: 'feature gate hits in the last 24h — persisted on each hit via trackEvent',
        errors24hDef: '4xx/5xx responses on /tg/* routes (excludes 401); grouped by method+status+route pattern',
        onboardingDef: 'hello_activation started by variant + completed count; source: AnalyticsEvent; window: last 30d',
        onboardingABDef: 'v2 A/B: started/completed by onboarding_variant + v2 acquisition_path breakdown; window: last 30d',
        localeSegmentsDef: 'users grouped by effective locale; scope: active30d (default), new7d, all',
      },
      localeSegments: {
        scope: localeScope,
        total: segTotal,
        segments,
      },
      marketBuckets,
      importSplit,
      bucketFunnel,
      acquisition: {
        period: acqPeriod,
        excludedTestUsers: testUsers.length,
        current: acqCur,
        previous: acqPrev,
        sources: [
          { key: 'deep_link', label: 'По ссылке / инвайту', newUsers: srcBuckets.deep_link.length, withWishlist: srcWlDeep, withWish: srcWishDeep },
          { key: 'direct', label: 'Прямой /start', newUsers: srcBuckets.direct.length, withWishlist: srcWlDirect, withWish: srcWishDirect },
          { key: 'unknown', label: botStartsSince && botStartsSince > acqCut ? `Без атрибуции (до ${botStartsSince.toISOString().slice(0, 10)})` : 'Неизвестно', newUsers: srcBuckets.unknown.length, withWishlist: srcWlUnknown, withWish: srcWishUnknown },
        ].filter(s => s.newUsers > 0),
        conversions: {
          startToOpen: pct(acqCur.miniappOpens, acqCur.botStarts),      // both event-based, same coverage
          newToWishlist: pct(acqCur.firstWishlist, acqCur.newUsers),     // both entity-derived
          newToWish: pct(acqCur.firstWish, acqCur.newUsers),            // both entity-derived
          wishlistToShare: pct(acqCur.ownersShared, withWishlist || 1), // both entity-derived
          shareToGuestOpen: pct(acqCur.guestOpens, acqCur.shareLinksGenerated), // share links → guest views; can be >100% (one link opened multiple times)
          guestToReserve: acqCur.guestOpens > 0 ? safePct(acqCur.reservers, acqCur.guestOpens) : null, // guest views → reservation
        },
        eventCoverage,
        dataNote,
        diagnosis: { dbAlerts, eventAlerts },
      },
      ...(sourceBreakdown.length > 0 && { sourceBreakdown }),
      referral: referralMetrics,
      generatedAt: now.toISOString(),
    });
  }),
);

// ─── Retention Analytics (god mode only) ─────────────────────────────────────

// GET /tg/me/retention-stats — lifecycle/winback analytics dashboard
// Filters out godMode/test users from production metrics.
tgRouter.get(
  '/me/retention-stats',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const godModeAllowedIds = (process.env.GOD_MODE_TELEGRAM_IDS ?? '').split(',').filter(Boolean);
    const canGodMode = user.telegramId ? godModeAllowedIds.includes(user.telegramId) : false;
    if (!canGodMode || !user.godMode) return res.status(403).json({ error: 'Forbidden' });

    const periodDays = parseInt(String(req.query.period ?? '30'), 10) || 30;
    const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000);

    // Identify test/internal users to exclude from production metrics
    const testUsers = await prisma.user.findMany({
      where: { OR: [{ godMode: true }, { telegramId: { in: godModeAllowedIds } }] },
      select: { id: true },
    });
    const testUserIds = new Set(testUsers.map(u => u.id));

    // Load all touches in period
    const allTouches = await prisma.lifecycleTouch.findMany({
      where: { sentAt: { gte: since, not: null } },
      select: {
        id: true, userId: true, segment: true, touchNumber: true,
        sentAt: true, delivered: true, offerCode: true,
        returnedAt: true, targetCompletedAt: true, promoRedeemedAt: true,
      },
    });

    // Production-clean touches (exclude test users)
    const touches = allTouches.filter(t => !testUserIds.has(t.userId));
    const excludedCount = allTouches.length - touches.length;

    // Attribution helpers (FIXED: was using targetCompletedAt - targetCompletedAt, now uses sentAt)
    const H = 3600 * 1000;
    const D = 24 * H;
    const within = (a: Date | null, b: Date | null, ms: number) => a && b && (a.getTime() - b.getTime()) <= ms && (a.getTime() - b.getTime()) >= 0;

    // Overview
    const sent = touches.length;
    const delivered = touches.filter(t => t.delivered).length;
    const uniqueUsers = new Set(touches.map(t => t.userId)).size;
    const returned24h = touches.filter(t => within(t.returnedAt, t.sentAt, 24 * H)).length;
    const returned72h = touches.filter(t => within(t.returnedAt, t.sentAt, 72 * H)).length;
    const returned7d = touches.filter(t => within(t.returnedAt, t.sentAt, 7 * D)).length;
    const targetCompleted7d = touches.filter(t => within(t.targetCompletedAt, t.sentAt, 7 * D)).length;

    // Promo: separated stages
    const promoAssigned = touches.filter(t => t.offerCode).length; // touch had promo code assigned
    const promoDelivered = touches.filter(t => t.offerCode && t.delivered).length; // promo message actually delivered
    const promoRedeemed = touches.filter(t => t.promoRedeemedAt).length; // promo was activated

    // Promo entitlement counts (exclude test users)
    const [activeGrants, expiredGrants] = await Promise.all([
      prisma.promoRedemption.count({ where: { status: 'ACTIVE', expiresAt: { gt: new Date() }, userId: { notIn: [...testUserIds] } } }),
      prisma.promoRedemption.count({ where: { status: 'EXPIRED', userId: { notIn: [...testUserIds] } } }),
    ]);

    // Conversion rates
    const pct = (num: number, den: number) => den > 0 ? `${Math.round(num / den * 100)}%` : '—';

    // Segment metadata (target steps, deeplinks, wave policy)
    const SEGMENT_TARGETS: Record<string, { targetAction: string; deepLink: string | null; maxWaves: number; promoPolicy: string }> = {
      S1: { targetAction: 'create_wishlist', deepLink: 'create_wishlist', maxWaves: 2, promoPolicy: 'нет' },
      S2: { targetAction: 'add_item', deepLink: 'add_first_wish', maxWaves: 3, promoPolicy: 'волна 2 (за 1й wish)' },
      S3: { targetAction: 'add_more_wishes', deepLink: 'add_more_wishes', maxWaves: 2, promoPolicy: 'волны 1-2 (основной)' },
      S4: { targetAction: 'return_visit', deepLink: null, maxWaves: 3, promoPolicy: 'волны 2-3' },
    };

    // By segment
    const segments = ['S1', 'S2', 'S3', 'S4'] as const;
    const bySegment = segments.map(seg => {
      const st = touches.filter(t => t.segment === seg);
      const del = st.filter(t => t.delivered);
      const ret72 = st.filter(t => within(t.returnedAt, t.sentAt, 72 * H)).length;
      const tgt7d = st.filter(t => within(t.targetCompletedAt, t.sentAt, 7 * D)).length;
      const meta = SEGMENT_TARGETS[seg] ?? { targetAction: '—', deepLink: null, maxWaves: 3, promoPolicy: '—' };
      // Promo-driven target completion: touches that had promo AND completed target
      const promoTargetCompleted = st.filter(t => t.offerCode && within(t.targetCompletedAt, t.sentAt, 7 * D)).length;
      const nonPromoTouches = st.filter(t => !t.offerCode && t.delivered);
      const nonPromoTarget = nonPromoTouches.filter(t => within(t.targetCompletedAt, t.sentAt, 7 * D)).length;
      return {
        segment: seg,
        targetAction: meta.targetAction,
        deepLink: meta.deepLink,
        maxWaves: meta.maxWaves,
        promoPolicy: meta.promoPolicy,
        sent: st.length,
        delivered: del.length,
        returned72h: ret72,
        targetCompleted7d: tgt7d,
        returnRate72h: pct(ret72, del.length),
        targetRate7d: pct(tgt7d, del.length),
        promoAssigned: st.filter(t => t.offerCode).length,
        promoDelivered: st.filter(t => t.offerCode && t.delivered).length,
        promoRedeemed: st.filter(t => t.promoRedeemedAt).length,
        promoTargetCompleted,
        promoTargetRate: pct(promoTargetCompleted, st.filter(t => t.offerCode && t.delivered).length),
        nonPromoTargetCompleted: nonPromoTarget,
        nonPromoTargetRate: pct(nonPromoTarget, nonPromoTouches.length),
      };
    });

    // By touch (segment × touchNumber)
    const byTouch = segments.flatMap(seg =>
      [1, 2, 3].map(tn => {
        const st = touches.filter(t => t.segment === seg && t.touchNumber === tn);
        const del = st.filter(t => t.delivered);
        const ret72 = st.filter(t => within(t.returnedAt, t.sentAt, 72 * H)).length;
        const tgt7d = st.filter(t => within(t.targetCompletedAt, t.sentAt, 7 * D)).length;
        const meta = SEGMENT_TARGETS[seg] ?? { targetAction: '—', deepLink: null, maxWaves: 3 };
        return {
          segment: seg, touchNumber: tn,
          targetAction: meta.targetAction,
          deepLink: meta.deepLink,
          disabled: tn > meta.maxWaves,
          sent: st.length, delivered: del.length,
          returned72h: ret72,
          targetCompleted7d: tgt7d,
          returnRate72h: pct(ret72, del.length),
          targetRate7d: pct(tgt7d, del.length),
          promoDelivered: st.filter(t => t.offerCode && t.delivered).length,
          promoRedeemed: st.filter(t => t.promoRedeemedAt).length,
        };
      }).filter(r => r.sent > 0),
    );

    return res.json({
      period: { days: periodDays, from: since.toISOString(), to: new Date().toISOString() },
      overview: {
        sent, delivered, uniqueUsers,
        returned24h, returned72h, returned7d, targetCompleted7d,
        returnRate72h: pct(returned72h, delivered),
        targetRate7d: pct(targetCompleted7d, delivered),
        promoAssigned, promoDelivered, promoRedeemed,
        activeGrants, expiredGrants,
      },
      wavePolicy: { S1: 2, S2: 3, S3: 2, S4: 3 },
      bySegment,
      byTouch,
      debug: {
        totalTouchesInPeriod: allTouches.length,
        excludedTestUsers: excludedCount,
        testUserIds: [...testUserIds].map(id => id.slice(0, 8) + '…'),
      },
      generatedAt: new Date().toISOString(),
    });
  }),
);

// GET /tg/me/retention-recent — last 20 touches + returns for debugging
tgRouter.get(
  '/me/retention-recent',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const godModeAllowedIds = (process.env.GOD_MODE_TELEGRAM_IDS ?? '').split(',').filter(Boolean);
    const canGodMode = user.telegramId ? godModeAllowedIds.includes(user.telegramId) : false;
    if (!canGodMode || !user.godMode) return res.status(403).json({ error: 'Forbidden' });

    const [recentTouches, recentRedeems] = await Promise.all([
      prisma.lifecycleTouch.findMany({
        where: { sentAt: { not: null } },
        orderBy: { sentAt: 'desc' },
        take: 30,
        select: {
          id: true, userId: true, segment: true, touchNumber: true,
          sentAt: true, delivered: true, offerCode: true, messageKind: true,
          returnedAt: true, targetCompletedAt: true, targetCompletedType: true,
          promoRedeemedAt: true, stoppedAt: true, stopReason: true,
        },
      }),
      prisma.promoRedemption.findMany({
        where: { source: 'winback', status: { in: ['ACTIVE', 'EXPIRED'] } },
        orderBy: { activatedAt: 'desc' },
        take: 10,
        select: { id: true, userId: true, status: true, activatedAt: true, expiresAt: true, offeredVia: true },
      }),
    ]);

    return res.json({ touches: recentTouches, redeems: recentRedeems });
  }),
);

// POST /tg/billing/pro/checkout — create Stars invoice link
// Body: { plan?: 'monthly' | 'yearly' } — defaults to monthly for back-compat
// Monthly = Stars subscription (auto-renews every 30 days).
// Yearly  = one-time Stars purchase; bot extends currentPeriodEnd by 365 days.
//           Yearly stacks on top of an existing active subscription (start = max(now, currentEnd)).
tgRouter.post(
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
tgRouter.post(
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
tgRouter.get(
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
tgRouter.post(
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
tgRouter.post(
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
tgRouter.post(
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
tgRouter.post(
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
tgRouter.post(
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
tgRouter.post(
  '/billing/gift-notes/sync',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);
    return res.json({ giftNotes: ent.giftNotes });
  }),
);

// ─── Gift Notes: Occasions CRUD ──────────────────────────────────────────────

tgRouter.get('/gift-occasions', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const occasions = await prisma.giftOccasion.findMany({
    where: { ownerUserId: user.id },
    include: {
      _count: { select: { ideas: { where: { status: 'ACTIVE' } }, reminders: { where: { enabled: true } } } },
      linkedUser: { select: { id: true, firstName: true, profile: { select: { displayName: true, username: true, avatarThumbUrl: true, avatarUrl: true } } } },
      linkedWishlist: { select: { id: true, slug: true, title: true, emoji: true } },
    },
    orderBy: { createdAt: 'desc' },
  });
  const mapped = occasions.map(o => {
    const nextDate = o.eventDate ? getNextOccurrenceDate(o.eventDate, o.recurrence) : null;
    const daysUntil = nextDate ? Math.round((nextDate.getTime() - Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())) / (24 * 3600 * 1000)) : null;
    return {
      ...o,
      eventDate: o.eventDate?.toISOString() ?? null,
      nextDate: nextDate?.toISOString() ?? null,
      daysUntil,
      ideasCount: o._count.ideas,
      remindersCount: o._count.reminders,
    };
  });
  // Sort: upcoming first (by daysUntil asc), no-date after, archived last
  mapped.sort((a, b) => {
    if (a.status === 'ARCHIVED' && b.status !== 'ARCHIVED') return 1;
    if (a.status !== 'ARCHIVED' && b.status === 'ARCHIVED') return -1;
    if (a.daysUntil != null && b.daysUntil != null) return a.daysUntil - b.daysUntil;
    if (a.daysUntil != null) return -1;
    if (b.daysUntil != null) return 1;
    return 0;
  });
  trackEvent('gift_notes_entry_opened', user.id);
  return res.json({ occasions: mapped });
}));

tgRouter.post('/gift-occasions', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const parsed = z.object({
    title: z.string().min(1).max(150),
    type: z.enum(['BIRTHDAY', 'ANNIVERSARY', 'HOLIDAY', 'OTHER']).optional(),
    personName: z.string().max(50).optional(),
    eventDate: z.string().optional(),
    recurrence: z.enum(['NONE', 'YEARLY', 'MONTHLY']).optional(),
    note: z.string().max(300).optional(),
    emoji: z.string().max(8).optional(),
    eventTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    location: z.string().max(200).optional(),
    budgetMin: z.number().int().nonnegative().optional(),
    budgetMax: z.number().int().nonnegative().optional(),
    budgetCurrency: z.enum(['RUB', 'USD', 'EUR', 'GBP', 'CNY', 'INR', 'AED', 'SAR']).optional(),
    linkedUserId: z.string().cuid().optional(),
    linkedWishlistId: z.string().cuid().optional(),
    linkedSantaId: z.string().cuid().optional(),
    source: z.enum(['USER', 'IMPORTED_FRIEND', 'IMPORTED_HOLIDAY']).optional(),
    holidayKey: z.string().max(80).optional(),
    country: z.string().length(2).optional(),
    defaultReminders: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);
  let eventDateVal: Date | null = null;
  if (parsed.data.eventDate) {
    let iso = parsed.data.eventDate;
    const dot = iso.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (dot) iso = `${dot[3]}-${dot[2]!.padStart(2, '0')}-${dot[1]!.padStart(2, '0')}`;
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) eventDateVal = new Date(iso + 'T00:00:00Z');
  }
  if (parsed.data.linkedWishlistId) {
    const w = await prisma.wishlist.findUnique({ where: { id: parsed.data.linkedWishlistId }, select: { ownerId: true, visibility: true } });
    if (!w) return res.status(400).json({ error: 'linkedWishlist_not_found' });
    if (w.ownerId !== user.id && w.visibility === 'PRIVATE') return res.status(403).json({ error: 'linkedWishlist_forbidden' });
  }
  if (parsed.data.linkedSantaId) {
    const s = await prisma.santaCampaign.findUnique({ where: { id: parsed.data.linkedSantaId }, select: { ownerId: true, participants: { where: { userId: user.id }, select: { id: true } } } });
    if (!s) return res.status(400).json({ error: 'linkedSanta_not_found' });
    if (s.ownerId !== user.id && s.participants.length === 0) return res.status(403).json({ error: 'linkedSanta_forbidden' });
  }
  const occasion = await prisma.giftOccasion.create({
    data: {
      ownerUserId: user.id,
      title: parsed.data.title,
      type: parsed.data.type ?? 'OTHER',
      personName: parsed.data.personName ?? null,
      eventDate: eventDateVal,
      recurrence: eventDateVal ? (parsed.data.recurrence ?? 'NONE') : 'NONE',
      note: parsed.data.note ?? null,
      emoji: parsed.data.emoji ?? null,
      eventTime: parsed.data.eventTime ?? null,
      location: parsed.data.location ?? null,
      budgetMin: parsed.data.budgetMin ?? null,
      budgetMax: parsed.data.budgetMax ?? null,
      budgetCurrency: parsed.data.budgetCurrency ?? null,
      linkedUserId: parsed.data.linkedUserId ?? null,
      linkedWishlistId: parsed.data.linkedWishlistId ?? null,
      linkedSantaId: parsed.data.linkedSantaId ?? null,
      source: parsed.data.source ?? 'USER',
      holidayKey: parsed.data.holidayKey ?? null,
      country: parsed.data.country ?? null,
    },
  });
  if (parsed.data.defaultReminders !== false && eventDateVal) {
    const seeds = [{ off: -7, t: '10:00' }, { off: -1, t: '18:00' }, { off: 0, t: '09:00' }];
    for (const s of seeds) {
      const sched = computeReminderSchedule(eventDateVal, occasion.recurrence, s.off, s.t);
      const ek = buildReminderEpisodeKey(occasion.id, s.off, sched);
      await prisma.giftOccasionReminder.create({
        data: { occasionId: occasion.id, ownerUserId: user.id, offsetDays: s.off, timeOfDay: s.t, scheduledFor: sched, episodeKey: ek },
      });
    }
  }
  trackEvent('gift_occasion_created', user.id, { type: occasion.type, source: occasion.source });
  return res.status(201).json({ occasion });
}));

tgRouter.get('/gift-occasions/:id', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const occasion = await prisma.giftOccasion.findUnique({
    where: { id: req.params.id },
    include: {
      ideas: { where: { status: { not: 'ARCHIVED' } }, orderBy: { createdAt: 'desc' } },
      reminders: { orderBy: { offsetDays: 'desc' } },
      linkedUser: { select: { id: true, firstName: true, profile: { select: { displayName: true, username: true, avatarThumbUrl: true, avatarUrl: true, birthday: true, hideYear: true } } } },
      linkedWishlist: { select: { id: true, slug: true, title: true, emoji: true, ownerId: true } },
      linkedSanta: { select: { id: true, title: true, status: true, drawAt: true, _count: { select: { participants: true } } } },
    },
  });
  if (!occasion || occasion.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
  const nextDate = occasion.eventDate ? getNextOccurrenceDate(occasion.eventDate, occasion.recurrence) : null;
  const daysUntil = nextDate ? Math.round((nextDate.getTime() - Date.now()) / (24 * 3600 * 1000)) : null;
  let linkedWishlistItems: Array<{ id: string; title: string; priceText: string | null; imageUrl: string | null; sourceDomain: string | null }> = [];
  if (occasion.linkedWishlistId) {
    const items = await prisma.item.findMany({
      where: { wishlistId: occasion.linkedWishlistId, status: 'AVAILABLE', archivedAt: null },
      orderBy: [{ priority: 'desc' }, { position: 'asc' }],
      take: 6,
      select: { id: true, title: true, priceText: true, imageUrl: true, sourceDomain: true },
    });
    linkedWishlistItems = items;
  }
  return res.json({
    occasion: {
      ...occasion,
      eventDate: occasion.eventDate?.toISOString() ?? null,
      nextDate: nextDate?.toISOString() ?? null,
      daysUntil,
      linkedWishlistItems,
    },
  });
}));

tgRouter.patch('/gift-occasions/:id', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const occasion = await prisma.giftOccasion.findUnique({ where: { id: req.params.id } });
  if (!occasion || occasion.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
  const parsed = z.object({
    title: z.string().min(1).max(150).optional(),
    type: z.enum(['BIRTHDAY', 'ANNIVERSARY', 'HOLIDAY', 'OTHER']).optional(),
    personName: z.string().max(50).nullable().optional(),
    eventDate: z.string().nullable().optional(),
    recurrence: z.enum(['NONE', 'YEARLY', 'MONTHLY']).optional(),
    note: z.string().max(300).nullable().optional(),
    emoji: z.string().max(8).nullable().optional(),
    eventTime: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    location: z.string().max(200).nullable().optional(),
    budgetMin: z.number().int().nonnegative().nullable().optional(),
    budgetMax: z.number().int().nonnegative().nullable().optional(),
    budgetCurrency: z.enum(['RUB', 'USD', 'EUR', 'GBP', 'CNY', 'INR', 'AED', 'SAR']).nullable().optional(),
    linkedUserId: z.string().cuid().nullable().optional(),
    linkedWishlistId: z.string().cuid().nullable().optional(),
    linkedSantaId: z.string().cuid().nullable().optional(),
    actualGiftText: z.string().max(300).nullable().optional(),
    actualGiftAmount: z.number().int().nonnegative().nullable().optional(),
    actualGiftCurrency: z.enum(['RUB', 'USD', 'EUR', 'GBP', 'CNY', 'INR', 'AED', 'SAR']).nullable().optional(),
    thankYouNote: z.string().max(500).nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);
  const data: any = { ...parsed.data };
  if (data.eventDate !== undefined) {
    if (!data.eventDate) { data.eventDate = null; } else {
      let iso = data.eventDate;
      const dot = iso.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
      if (dot) iso = `${dot[3]}-${dot[2]!.padStart(2, '0')}-${dot[1]!.padStart(2, '0')}`;
      data.eventDate = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(iso + 'T00:00:00Z') : null;
    }
  }
  if (data.thankYouNote !== undefined && data.thankYouNote) {
    data.thankYouAt = new Date();
  }
  const updated = await prisma.giftOccasion.update({ where: { id: req.params.id }, data });
  if (data.eventDate !== undefined || data.recurrence !== undefined) {
    const newDate = updated.eventDate;
    if (newDate) {
      const reminders = await prisma.giftOccasionReminder.findMany({ where: { occasionId: updated.id } });
      for (const r of reminders) {
        const sched = computeReminderSchedule(newDate, updated.recurrence, r.offsetDays, r.timeOfDay);
        const ek = buildReminderEpisodeKey(updated.id, r.offsetDays, sched);
        await prisma.giftOccasionReminder.update({
          where: { id: r.id },
          data: { scheduledFor: sched, episodeKey: ek, sentAt: null, delivered: false },
        });
      }
    }
  }
  trackEvent('gift_occasion_updated', user.id);
  return res.json({ occasion: updated });
}));

tgRouter.delete('/gift-occasions/:id', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const occasion = await prisma.giftOccasion.findUnique({ where: { id: req.params.id } });
  if (!occasion || occasion.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
  // Hard delete — cascades to ideas via FK onDelete: Cascade
  await prisma.giftOccasion.delete({ where: { id: req.params.id } });
  trackEvent('gift_occasion_deleted', user.id);
  return res.json({ ok: true });
}));

tgRouter.post('/gift-occasions/:id/archive', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const occasion = await prisma.giftOccasion.findUnique({ where: { id: req.params.id } });
  if (!occasion || occasion.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
  await prisma.giftOccasion.update({ where: { id: req.params.id }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
  trackEvent('gift_occasion_archived', user.id);
  return res.json({ ok: true });
}));

tgRouter.post('/gift-occasions/:id/complete', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const occasion = await prisma.giftOccasion.findUnique({ where: { id: req.params.id } });
  if (!occasion || occasion.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
  await prisma.giftOccasion.update({ where: { id: req.params.id }, data: { status: 'DONE', completedAt: new Date() } });
  trackEvent('gift_occasion_completed', user.id);
  return res.json({ ok: true });
}));

// ─── Gift Notes: Ideas CRUD ─────────────────────────────────────────────────

tgRouter.post('/gift-occasions/:id/ideas', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const occasion = await prisma.giftOccasion.findUnique({ where: { id: req.params.id } });
  if (!occasion || occasion.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
  const parsed = z.object({
    text: z.string().min(1).max(500),
    link: zUrl().nullable().optional(),
    price: z.number().int().nonnegative().nullable().optional(),
    currency: z.enum(['RUB', 'USD', 'EUR', 'GBP']).optional(),
    note: z.string().max(500).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);
  const idea = await prisma.giftOccasionIdea.create({
    data: { occasionId: occasion.id, ownerUserId: user.id, text: parsed.data.text, link: parsed.data.link ?? null, price: parsed.data.price ?? null, currency: parsed.data.currency ?? null, note: parsed.data.note ?? null },
  });
  trackEvent('gift_idea_created', user.id, { occasionId: occasion.id });
  return res.status(201).json({ idea });
}));

tgRouter.patch('/gift-occasion-ideas/:ideaId', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const idea = await prisma.giftOccasionIdea.findUnique({ where: { id: req.params.ideaId } });
  if (!idea || idea.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
  const parsed = z.object({
    text: z.string().min(1).max(500).optional(),
    link: z.string().nullable().optional(),
    price: z.number().int().nonnegative().nullable().optional(),
    currency: z.enum(['RUB', 'USD', 'EUR', 'GBP']).nullable().optional(),
    note: z.string().max(500).nullable().optional(),
    imageUrl: z.string().nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);
  const updated = await prisma.giftOccasionIdea.update({ where: { id: req.params.ideaId }, data: parsed.data });
  trackEvent('gift_idea_updated', user.id);
  return res.json({ idea: updated });
}));

// POST /tg/gift-occasion-ideas/:ideaId/photo — upload or replace idea photo.
// Mirrors the /items/:id/photo handler (sharp processing, /api/uploads, EXIF
// stripping). Image lives at imageUrl; thumb is returned but not persisted —
// idea cards use the same URL at smaller render sizes.
tgRouter.post('/gift-occasion-ideas/:ideaId/photo', upload.single('photo'), asyncHandler(async (req, res) => {
  const ideaId = req.params.ideaId ?? '';
  if (!ideaId) return res.status(400).json({ error: 'Missing idea id' });
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const idea = await prisma.giftOccasionIdea.findUnique({ where: { id: ideaId }, select: { id: true, imageUrl: true, ownerUserId: true } });
  if (!idea || idea.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });

  const [full, thumb] = await Promise.all([
    processImage(req.file.buffer, { maxDim: 1600, quality: 80, suffix: 'full' }),
    processImage(req.file.buffer, { maxDim: 480, quality: 70, suffix: 'thumb' }),
  ]);
  deleteUploadFile(idea.imageUrl);
  const photoUrl = `/api/uploads/${full.filename}`;
  await prisma.giftOccasionIdea.update({ where: { id: ideaId }, data: { imageUrl: photoUrl } });
  trackEvent('gift_idea_photo_uploaded', user.id);
  return res.json({ photoUrl, thumbUrl: `/api/uploads/${thumb.filename}`, width: full.width, height: full.height, sizeBytes: full.sizeBytes });
}));

tgRouter.delete('/gift-occasion-ideas/:ideaId/photo', asyncHandler(async (req, res) => {
  const ideaId = req.params.ideaId ?? '';
  if (!ideaId) return res.status(400).json({ error: 'Missing idea id' });

  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const idea = await prisma.giftOccasionIdea.findUnique({ where: { id: ideaId }, select: { id: true, imageUrl: true, ownerUserId: true } });
  if (!idea || idea.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });

  deleteUploadFile(idea.imageUrl);
  await prisma.giftOccasionIdea.update({ where: { id: ideaId }, data: { imageUrl: null } });
  return res.json({ ok: true });
}));

tgRouter.delete('/gift-occasion-ideas/:ideaId', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const idea = await prisma.giftOccasionIdea.findUnique({ where: { id: req.params.ideaId } });
  if (!idea || idea.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
  await prisma.giftOccasionIdea.update({ where: { id: req.params.ideaId }, data: { status: 'ARCHIVED', archivedAt: new Date() } });
  trackEvent('gift_idea_archived', user.id);
  return res.json({ ok: true });
}));

tgRouter.post('/gift-occasion-ideas/:ideaId/complete', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const idea = await prisma.giftOccasionIdea.findUnique({ where: { id: req.params.ideaId } });
  if (!idea || idea.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
  await prisma.giftOccasionIdea.update({ where: { id: req.params.ideaId }, data: { status: 'DONE', completedAt: new Date() } });
  trackEvent('gift_idea_completed', user.id);
  return res.json({ ok: true });
}));

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

tgRouter.post('/gift-occasions/:id/reminders', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const occasion = await prisma.giftOccasion.findUnique({ where: { id: req.params.id } });
  if (!occasion || occasion.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
  const parsed = z.object({
    offsetDays: z.number().int().min(-30).max(30),
    timeOfDay: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    enabled: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);
  const sched = occasion.eventDate ? computeReminderSchedule(occasion.eventDate, occasion.recurrence, parsed.data.offsetDays, parsed.data.timeOfDay ?? '10:00') : null;
  const ek = sched ? buildReminderEpisodeKey(occasion.id, parsed.data.offsetDays, sched) : `occ_${occasion.id}_off${parsed.data.offsetDays}_unscheduled_${Date.now()}`;
  const reminder = await prisma.giftOccasionReminder.create({
    data: {
      occasionId: occasion.id,
      ownerUserId: user.id,
      offsetDays: parsed.data.offsetDays,
      timeOfDay: parsed.data.timeOfDay ?? '10:00',
      enabled: parsed.data.enabled ?? true,
      scheduledFor: sched,
      episodeKey: ek,
    },
  });
  trackEvent('gift_reminder_created', user.id, { occasionId: occasion.id, offsetDays: parsed.data.offsetDays });
  return res.status(201).json({ reminder });
}));

tgRouter.patch('/gift-occasions/:id/reminders/:rid', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const reminder = await prisma.giftOccasionReminder.findUnique({ where: { id: req.params.rid }, include: { occasion: true } });
  if (!reminder || reminder.ownerUserId !== user.id || reminder.occasionId !== req.params.id) return res.status(404).json({ error: 'Not found' });
  const parsed = z.object({
    offsetDays: z.number().int().min(-30).max(30).optional(),
    timeOfDay: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    enabled: z.boolean().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);
  const data: any = { ...parsed.data };
  if ((parsed.data.offsetDays !== undefined || parsed.data.timeOfDay !== undefined) && reminder.occasion.eventDate) {
    const offset = parsed.data.offsetDays ?? reminder.offsetDays;
    const time = parsed.data.timeOfDay ?? reminder.timeOfDay;
    const sched = computeReminderSchedule(reminder.occasion.eventDate, reminder.occasion.recurrence, offset, time);
    data.scheduledFor = sched;
    data.episodeKey = buildReminderEpisodeKey(reminder.occasionId, offset, sched);
    data.sentAt = null;
    data.delivered = false;
  }
  const updated = await prisma.giftOccasionReminder.update({ where: { id: reminder.id }, data });
  return res.json({ reminder: updated });
}));

tgRouter.delete('/gift-occasions/:id/reminders/:rid', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const reminder = await prisma.giftOccasionReminder.findUnique({ where: { id: req.params.rid } });
  if (!reminder || reminder.ownerUserId !== user.id || reminder.occasionId !== req.params.id) return res.status(404).json({ error: 'Not found' });
  await prisma.giftOccasionReminder.delete({ where: { id: reminder.id } });
  return res.json({ ok: true });
}));

tgRouter.get('/calendar/holidays', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const country = z.string().length(2).safeParse(req.query.country).success
    ? String(req.query.country).toUpperCase()
    : null;
  if (!country) return res.status(400).json({ error: 'country_required' });
  const holidays = await prisma.holiday.findMany({
    where: { country },
    orderBy: [{ ordinal: 'asc' }, { month: 'asc' }, { day: 'asc' }],
  });
  const imported = await prisma.giftOccasion.findMany({
    where: { ownerUserId: user.id, source: 'IMPORTED_HOLIDAY', country },
    select: { holidayKey: true },
  });
  const importedSet = new Set(imported.map(i => i.holidayKey).filter((k): k is string => !!k));
  return res.json({
    country,
    holidays: holidays.map(h => ({ ...h, alreadyImported: h.key ? importedSet.has(h.key) : false })),
  });
}));

tgRouter.post('/calendar/import-holidays', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const parsed = z.object({
    keys: z.array(z.string().min(1).max(80)).min(1).max(50),
    locale: z.enum(['ru', 'en', 'zh-CN', 'hi', 'es', 'ar']).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);
  const holidays = await prisma.holiday.findMany({ where: { key: { in: parsed.data.keys } } });
  const locale = parsed.data.locale ?? 'ru';
  const nameByLocale = (h: typeof holidays[number]): string => {
    switch (locale) {
      case 'en': return h.nameEn ?? h.nameRu ?? h.key;
      case 'zh-CN': return h.nameZhCn ?? h.nameEn ?? h.key;
      case 'hi': return h.nameHi ?? h.nameEn ?? h.key;
      case 'es': return h.nameEs ?? h.nameEn ?? h.key;
      case 'ar': return h.nameAr ?? h.nameEn ?? h.key;
      default: return h.nameRu ?? h.nameEn ?? h.key;
    }
  };
  const thisYear = new Date().getUTCFullYear();
  let created = 0;
  for (const h of holidays) {
    const eventDate = new Date(Date.UTC(thisYear, h.month - 1, h.day));
    try {
      await prisma.giftOccasion.create({
        data: {
          ownerUserId: user.id,
          title: nameByLocale(h),
          type: 'HOLIDAY',
          eventDate,
          recurrence: 'YEARLY',
          emoji: h.emoji,
          source: 'IMPORTED_HOLIDAY',
          holidayKey: h.key,
          country: h.country,
        },
      });
      created++;
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code !== 'P2002') throw err;
    }
  }
  trackEvent('calendar_holidays_imported', user.id, { count: created, locale });
  return res.json({ imported: created });
}));

tgRouter.get('/calendar/friends-bdays', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const subs = await prisma.profileSubscription.findMany({
    where: { subscriberId: user.id },
    select: { targetUserId: true },
  });
  const targetIds = subs.map(s => s.targetUserId);
  if (targetIds.length === 0) return res.json({ friends: [] });
  const profiles = await prisma.userProfile.findMany({
    where: { userId: { in: targetIds }, birthday: { not: null } },
    select: { userId: true, displayName: true, username: true, avatarThumbUrl: true, avatarUrl: true, birthday: true, hideYear: true },
  });
  const imported = await prisma.giftOccasion.findMany({
    where: { ownerUserId: user.id, source: 'IMPORTED_FRIEND', linkedUserId: { in: profiles.map(p => p.userId) } },
    select: { linkedUserId: true },
  });
  const importedSet = new Set(imported.map(i => i.linkedUserId).filter((id): id is string => !!id));
  return res.json({
    friends: profiles.map(p => ({
      userId: p.userId,
      displayName: p.displayName,
      username: p.username,
      avatarThumbUrl: p.avatarThumbUrl ?? p.avatarUrl ?? null,
      birthday: p.birthday?.toISOString() ?? null,
      hideYear: p.hideYear,
      alreadyImported: importedSet.has(p.userId),
    })),
  });
}));

tgRouter.post('/calendar/import-friends-bdays', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const parsed = z.object({
    userIds: z.array(z.string().cuid()).min(1).max(50),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);
  const profiles = await prisma.userProfile.findMany({
    where: { userId: { in: parsed.data.userIds }, birthday: { not: null } },
    include: { user: { select: { id: true, firstName: true } } },
  });
  let created = 0;
  for (const p of profiles) {
    if (!p.birthday) continue;
    const existing = await prisma.giftOccasion.findFirst({
      where: { ownerUserId: user.id, linkedUserId: p.userId, source: 'IMPORTED_FRIEND', type: 'BIRTHDAY' },
      select: { id: true },
    });
    if (existing) continue;
    const name = p.displayName ?? p.user?.firstName ?? p.username ?? 'Friend';
    await prisma.giftOccasion.create({
      data: {
        ownerUserId: user.id,
        title: name,
        type: 'BIRTHDAY',
        personName: name,
        eventDate: p.birthday,
        recurrence: 'YEARLY',
        emoji: '🎂',
        source: 'IMPORTED_FRIEND',
        linkedUserId: p.userId,
      },
    });
    created++;
  }
  trackEvent('calendar_friends_imported', user.id, { count: created });
  return res.json({ imported: created });
}));

tgRouter.get('/calendar/inbox', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const entries = await prisma.calendarInboxEntry.findMany({
    where: { ownerUserId: user.id, archivedAt: null },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: { occasion: { select: { id: true, title: true, type: true, emoji: true } } },
  });
  const unread = await prisma.calendarInboxEntry.count({ where: { ownerUserId: user.id, archivedAt: null, readAt: null } });
  return res.json({ entries, unread });
}));

tgRouter.post('/calendar/inbox/read-all', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  await prisma.calendarInboxEntry.updateMany({
    where: { ownerUserId: user.id, readAt: null },
    data: { readAt: new Date() },
  });
  return res.json({ ok: true });
}));

tgRouter.post('/calendar/inbox/:id/read', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const entry = await prisma.calendarInboxEntry.findUnique({ where: { id: req.params.id } });
  if (!entry || entry.ownerUserId !== user.id) return res.status(404).json({ error: 'Not found' });
  await prisma.calendarInboxEntry.update({ where: { id: entry.id }, data: { readAt: entry.readAt ?? new Date() } });
  return res.json({ ok: true });
}));

tgRouter.get('/calendar/today-context', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const [userRow, occasions] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, select: { calendarOnboardingSeenAt: true } }),
    prisma.giftOccasion.findMany({
      where: { ownerUserId: user.id, status: 'ACTIVE', eventDate: { not: null } },
      include: { _count: { select: { ideas: { where: { status: 'ACTIVE' } } } } },
    }),
  ]);
  type Pick = { id: string; title: string; emoji: string | null; type: string; daysUntil: number; nextDate: string; ideasCount: number };
  let soonest: Pick | null = null;
  for (const o of occasions) {
    if (!o.eventDate) continue;
    const next = getNextOccurrenceDate(o.eventDate, o.recurrence);
    if (!next) continue;
    const days = Math.round((next.getTime() - Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())) / (24 * 3600 * 1000));
    if (days < 0 || days > 30) continue;
    if (!soonest || days < soonest.daysUntil) {
      soonest = { id: o.id, title: o.title, emoji: o.emoji, type: o.type, daysUntil: days, nextDate: next.toISOString(), ideasCount: o._count.ideas };
    }
  }
  return res.json({
    soonest,
    // Server-side onboarding flag — replaces the previous localStorage-only
    // approach so a user who already saw onboarding on iPhone doesn't get
    // it again when opening the Mini App on macOS / web.
    onboardingSeenAt: userRow?.calendarOnboardingSeenAt?.toISOString() ?? null,
  });
}));

// POST /tg/calendar/onboarding-seen — idempotently mark the calendar
// onboarding as completed for this user. Called when the 4-step flow is
// dismissed or finished. Safe to call multiple times.
tgRouter.post('/calendar/onboarding-seen', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const existing = await prisma.user.findUnique({ where: { id: user.id }, select: { calendarOnboardingSeenAt: true } });
  if (existing?.calendarOnboardingSeenAt) {
    return res.json({ seenAt: existing.calendarOnboardingSeenAt.toISOString() });
  }
  const now = new Date();
  await prisma.user.update({ where: { id: user.id }, data: { calendarOnboardingSeenAt: now } });
  trackEvent('calendar_onboarding_seen', user.id);
  return res.json({ seenAt: now.toISOString() });
}));

tgRouter.get('/calendar/year-recap', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const ent = await getEffectiveEntitlements(user.id, user.godMode);
  if (!requireGiftNotes(ent, res)) return;
  const yearParam = z.coerce.number().int().min(2020).max(2100).safeParse(req.query.year);
  const year = yearParam.success ? yearParam.data : new Date().getUTCFullYear() - 1;
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year + 1, 0, 1));
  const occasions = await prisma.giftOccasion.findMany({
    where: {
      ownerUserId: user.id,
      eventDate: { gte: start, lt: end },
    },
    include: {
      linkedUser: { select: { id: true, firstName: true, profile: { select: { displayName: true, username: true, avatarThumbUrl: true } } } },
    },
  });
  const total = occasions.length;
  const completed = occasions.filter(o => o.status === 'DONE').length;
  const birthdays = occasions.filter(o => o.type === 'BIRTHDAY').length;
  const onTimePct = total > 0 ? Math.round((completed / total) * 100) : 0;
  type Spend = Record<string, number>;
  const spendByCurrency: Spend = {};
  let totalGifts = 0;
  for (const o of occasions) {
    if (o.actualGiftAmount && o.actualGiftAmount > 0) {
      const cur = o.actualGiftCurrency ?? 'RUB';
      spendByCurrency[cur] = (spendByCurrency[cur] ?? 0) + o.actualGiftAmount;
      totalGifts++;
    }
  }
  const counts = new Map<string, { userId: string; name: string; count: number; avatarUrl: string | null }>();
  for (const o of occasions) {
    if (!o.linkedUser) continue;
    const name = o.linkedUser.profile?.displayName ?? o.linkedUser.firstName ?? o.linkedUser.profile?.username ?? 'Friend';
    const cur = counts.get(o.linkedUser.id);
    if (cur) cur.count++;
    else counts.set(o.linkedUser.id, { userId: o.linkedUser.id, name, count: 1, avatarUrl: o.linkedUser.profile?.avatarThumbUrl ?? null });
  }
  const topRecipient = [...counts.values()].sort((a, b) => b.count - a.count)[0] ?? null;
  const perMonth = Array.from({ length: 12 }, () => 0);
  for (const o of occasions) {
    if (!o.actualGiftAmount || !o.eventDate) continue;
    const m = o.eventDate.getUTCMonth();
    perMonth[m] = (perMonth[m] ?? 0) + 1;
  }
  trackEvent('calendar_recap_viewed', user.id, { year });
  return res.json({
    year,
    totals: { events: total, completed, birthdays, onTimePct, giftsGiven: totalGifts },
    spend: { byCurrency: spendByCurrency },
    topRecipient,
    perMonthGifts: perMonth,
  });
  }),
);

// Also support god-mode lookup via TG auth (for Mini App investigation UI)
tgRouter.get(
  '/support/lookup/:ticketCode',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const godModeAllowedIds = (process.env.GOD_MODE_TELEGRAM_IDS ?? '').split(',').filter(Boolean);
    if (!user.telegramId || !godModeAllowedIds.includes(user.telegramId) || !user.godMode) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const { ticketCode } = req.params;
    const ticket = await prisma.supportTicket.findUnique({
      where: { ticketCode: ticketCode!.toUpperCase() },
      include: {
        messages: { orderBy: { createdAt: 'asc' }, take: 50, select: {
          id: true, authorRole: true, kind: true, text: true, caption: true, createdAt: true,
        }},
        user: { select: {
          id: true, telegramId: true, firstName: true,
          profile: { select: { displayName: true, username: true } },
        }},
      },
    });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

    const userId = ticket.user.id;
    const [wishlistsCount, subscription] = await Promise.all([
      prisma.wishlist.count({ where: { ownerId: userId, type: 'REGULAR' } }),
      prisma.subscription.findFirst({ where: { userId, status: { not: 'CANCELLED' } }, orderBy: { createdAt: 'desc' }, select: { planCode: true } }),
    ]);

    return res.json({
      ticketCode: ticket.ticketCode, status: ticket.status,
      createdAt: ticket.createdAt, closedAt: ticket.closedAt,
      user: { telegramId: ticket.user.telegramId, name: ticket.user.profile?.displayName || ticket.user.firstName || 'Unknown', username: ticket.user.profile?.username },
      plan: subscription?.planCode ?? 'FREE',
      wishlists: wishlistsCount,
      messagesCount: ticket.messages.length,
      lastMessages: ticket.messages.slice(-5),
    });
  }),
);

// ── Support: create ticket from Mini App ──────────────────────────────────────

tgRouter.post(
  '/support/tickets',
  asyncHandler(async (req, res) => {
    const SUPPORT_CHAT_ID = (process.env.SUPPORT_CHAT_ID ?? '').trim();
    const BOT_TOKEN = (process.env.BOT_TOKEN ?? '').trim();

    const user = await getOrCreateTgUser(req.tgUser!);
    const profile = await getOrCreateProfile(user.id);

    // Check for existing open ticket — don't create duplicates
    const existingOpen = await prisma.supportTicket.findFirst({
      where: { userId: user.id, status: { not: 'CLOSED' } },
      select: { ticketCode: true, status: true },
    });
    if (existingOpen) {
      return res.status(409).json({
        error: 'active_ticket_exists',
        ticketCode: existingOpen.ticketCode,
        supportId: profile.supportId ?? null,
      });
    }

    // Parse optional client context
    const parsed = z.object({
      source: z.string().max(50).optional(),
      screen: z.string().max(50).optional(),
      locale: z.string().max(10).optional(),
      platform: z.string().max(50).optional(),
    }).safeParse(req.body);
    const ctx = parsed.success ? parsed.data : {};

    // Generate ticket code (same logic as bot)
    const last = await prisma.supportTicket.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { ticketCode: true },
    });
    let nextNum = 1;
    if (last) {
      const m = last.ticketCode.match(/SUP-(\d+)/);
      if (m) nextNum = parseInt(m[1]!, 10) + 1;
    }
    const ticketCode = `SUP-${String(nextNum).padStart(4, '0')}`;

    // Snapshot plan
    const sub = await prisma.subscription.findFirst({
      where: { userId: user.id, status: { not: 'CANCELLED' } },
      orderBy: { createdAt: 'desc' },
      select: { planCode: true },
    });
    const plan = sub?.planCode ?? 'FREE';

    // Create ticket
    const ticket = await prisma.supportTicket.create({
      data: {
        ticketCode,
        userId: user.id,
        status: 'WAITING_USER',
        openedVia: 'miniapp',
        supportChatId: SUPPORT_CHAT_ID || null,
      },
    });

    // ── Send to support chat ────────────────────────────────────────────────
    if (SUPPORT_CHAT_ID && BOT_TOKEN) {
      const tgU = req.tgUser!;
      const userTag = tgU.username ? `@${tgU.username}` : `tg:${tgU.id}`;
      const header = [
        `🆕 <b>[${ticketCode}] Новое обращение (Mini App)</b>`,
        ``,
        `👤 ${tgU.first_name || 'User'} ${userTag}`,
        `🆔 Support ID: <code>${profile.supportId || '—'}</code>`,
        `📊 Plan: ${plan}`,
        `📍 Source: ${ctx.source || 'settings'}`,
        `🖥 Screen: ${ctx.screen || '—'}`,
        `🌐 Locale: ${ctx.locale || '—'}`,
        `📱 Platform: ${ctx.platform || '—'}`,
        ``,
        `⏳ Ожидаем описание проблемы от пользователя...`,
      ].join('\n');

      try {
        const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: SUPPORT_CHAT_ID, text: header, parse_mode: 'HTML' }),
        });
        const data = await resp.json() as { ok: boolean; result?: { message_id: number } };
        if (data.ok && data.result?.message_id) {
          // Save as SupportMessage so bot can route staff replies via telegramSupportMsgId
          await prisma.supportMessage.create({
            data: {
              ticketId: ticket.id,
              authorRole: 'SYSTEM',
              kind: 'TEXT',
              text: header,
              telegramSupportChatId: SUPPORT_CHAT_ID,
              telegramSupportMsgId: data.result.message_id,
            },
          }).catch(() => {});
        }
      } catch (err) {
        logger.error({ err }, 'support: failed to send to support chat');
      }
    }

    // ── Send DM to user (bot chat) ──────────────────────────────────────────
    if (user.telegramChatId && BOT_TOKEN) {
      const isRu = (ctx.locale || 'ru').startsWith('ru');
      const dmText = isRu
        ? [
            `✅ <b>Обращение создано: ${ticketCode}</b>`,
            ``,
            `Опиши, пожалуйста, что пошло не так.`,
            `Можно прислать текст, скриншоты и видео.`,
            ``,
            `Если можешь, напиши:`,
            `• что именно ты делал`,
            `• что ожидал увидеть`,
            `• что произошло фактически`,
            `• как это воспроизводится`,
          ].join('\n')
        : [
            `✅ <b>Ticket created: ${ticketCode}</b>`,
            ``,
            `Please describe what went wrong.`,
            `You can send text, screenshots, and video.`,
            ``,
            `If possible, include:`,
            `• what you were doing`,
            `• what you expected`,
            `• what actually happened`,
            `• how to reproduce it`,
          ].join('\n');

      try {
        const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: user.telegramChatId,
            text: dmText,
            parse_mode: 'HTML',
            reply_markup: { force_reply: true, selective: true },
          }),
        });
        const data = await resp.json() as { ok: boolean; result?: { message_id: number } };
        if (data.ok && data.result?.message_id) {
          // Save as SupportMessage so bot can route user reply via telegramUserMsgId
          await prisma.supportMessage.create({
            data: {
              ticketId: ticket.id,
              authorRole: 'SYSTEM',
              kind: 'TEXT',
              text: dmText,
              telegramUserChatId: user.telegramChatId,
              telegramUserMsgId: data.result.message_id,
            },
          }).catch(() => {});
        }
      } catch (err) {
        logger.error({ err }, 'support: failed to send DM to user');
      }
    }

    return res.json({
      ok: true,
      ticketCode,
      supportId: profile.supportId ?? null,
    });
  }),
);

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

// GET /tg/santa/season — season status and canCreate flag
tgRouter.get('/santa/season', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const info = await getSantaSeasonInfo(user.id, user.santaTestMode);
  return res.json({
    inSeason: info.inSeason,
    canCreate: info.canCreate,
    seasonStart: info.seasonStart,
    seasonEnd: info.seasonEnd,
    testMode: user.santaTestMode,
  });
}));

// POST /tg/santa/season/test-mode — toggle santa test mode (godMode users only)
tgRouter.post('/santa/season/test-mode', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  if (!user.godMode) return res.status(403).json({ error: 'Forbidden' });
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { santaTestMode: !user.santaTestMode },
    select: { santaTestMode: true },
  });
  return res.json({ santaTestMode: updated.santaTestMode });
}));

// GET /tg/santa/admin/global-config — read global master switch (godMode only)
tgRouter.get('/santa/admin/global-config', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  if (!user.godMode) return res.status(403).json({ error: 'Forbidden' });
  const config = await prisma.santaGlobalConfig.findUnique({ where: { id: 'global' } });
  return res.json({ santaEnabled: config?.santaEnabled ?? true });
}));

// PATCH /tg/santa/admin/global-config — toggle global master switch (godMode only)
// Set santaEnabled=false to retire Secret Santa entirely (affects all users except godMode/santaTestMode).
// Set santaEnabled=true to re-enable; yearly calendar rules take over automatically.
tgRouter.patch('/santa/admin/global-config', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  if (!user.godMode) return res.status(403).json({ error: 'Forbidden' });
  const parsed = z.object({ santaEnabled: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);
  const updated = await prisma.santaGlobalConfig.upsert({
    where:  { id: 'global' },
    create: { id: 'global', santaEnabled: parsed.data.santaEnabled },
    update: { santaEnabled: parsed.data.santaEnabled },
  });
  void sendAdminAlert(
    `🎛 Santa global switch <b>${updated.santaEnabled ? 'ENABLED ✅' : 'DISABLED 🔴'}</b> by godMode user ${user.id}`,
  );
  return res.json({ santaEnabled: updated.santaEnabled });
}));

// GET /tg/santa/admin/season-broadcasts — view sent seasonal broadcast history (godMode only)
tgRouter.get('/santa/admin/season-broadcasts', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  if (!user.godMode) return res.status(403).json({ error: 'Forbidden' });
  const logs = await prisma.santaSeasonalBroadcastLog.findMany({
    orderBy: [{ year: 'desc' }, { type: 'asc' }],
    take: 20,
  });
  return res.json(logs);
}));

// POST /tg/santa/admin/season-broadcasts — manually trigger a seasonal broadcast (godMode only)
// Used for testing or if the automated job missed the Nov 1 / Feb 1 window for any reason.
// Body: { type: 'PROMO' | 'CLOSING_SOON', seasonYear: number, force?: boolean }
// force=true skips the already-sent guard and re-sends even if log row exists.
tgRouter.post('/santa/admin/season-broadcasts', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  if (!user.godMode) return res.status(403).json({ error: 'Forbidden' });
  const parsed = z.object({
    type:       z.enum(['PROMO', 'CLOSING_SOON']),
    seasonYear: z.number().int().min(2020).max(2100),
    force:      z.boolean().optional().default(false),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const { type, seasonYear, force } = parsed.data;

  if (force) {
    // Delete existing log row so sendSeasonalBroadcast can re-create it
    await prisma.santaSeasonalBroadcastLog.deleteMany({
      where: { year: seasonYear, type },
    });
  }

  // Fire in background; response confirms the job was queued
  void sendSeasonalBroadcast(type, seasonYear);
  return res.json({ ok: true, queued: { type, seasonYear, force } });
}));

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

type SantaAliasRecord = { alias: string; emoji: string; adjectiveKey: string; animalKey: string };
type SantaAliasMap = Map<string, SantaAliasRecord>; // participantId → alias

/** Load alias map for a round from DB. Returns empty map if no aliases yet. */
async function loadSantaAliasMap(roundId: string): Promise<SantaAliasMap> {
  const rows = await prisma.santaParticipantAlias.findMany({
    where: { roundId },
    select: { participantId: true, alias: true, emoji: true, adjectiveKey: true, animalKey: true },
  });
  return new Map(rows.map(r => [r.participantId, { alias: r.alias, emoji: r.emoji, adjectiveKey: r.adjectiveKey, animalKey: r.animalKey }]));
}

/** Resolve alias for a participant from map. Falls back to generic if not found. */
function resolveSantaAlias(map: SantaAliasMap, participantId: string): SantaAliasRecord {
  return map.get(participantId) ?? { alias: 'Участник', emoji: '🎅', adjectiveKey: '', animalKey: '' };
}

/** Pre-draw stable label for a participant: "Участник N" based on join order.
 *  Used in organizer views (exclusions, participant list) before first draw. */
function predrawLabel(joinOrder: number): string {
  return `Участник ${joinOrder}`;
}

// POST /tg/santa/campaigns — create a new campaign
tgRouter.post('/santa/campaigns', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const parsed = z.object({
    title: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    type: z.enum(['CLASSIC', 'MULTI_WAVE']).default('CLASSIC'),
    minBudget: z.number().int().positive().optional(),
    maxBudget: z.number().int().positive().optional(),
    currency: z.string().max(3).default('RUB'),
    drawAt: z.string().datetime().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const info = await getSantaSeasonInfo(user.id, user.santaTestMode);
  if (!info.canCreate) return res.status(403).json({ error: 'santa_not_in_season' });

  // PRO gate for MULTI_WAVE
  if (parsed.data.type === 'MULTI_WAVE') {
    const ent = await getUserEntitlement(user.id);
    if (!ent.isPro) return res.status(402).json({ error: 'pro_required', feature: 'santa_multi_wave' });
  }

  const now = new Date();
  const campaign = await prisma.santaCampaign.create({
    data: {
      title: parsed.data.title,
      description: parsed.data.description,
      type: parsed.data.type,
      status: 'DRAFT',
      ownerId: user.id,
      minBudget: parsed.data.minBudget,
      maxBudget: parsed.data.maxBudget,
      currency: parsed.data.currency,
      drawAt: parsed.data.drawAt ? new Date(parsed.data.drawAt) : undefined,
      seasonYear: now.getFullYear(),
    },
    select: { id: true, title: true, status: true, inviteToken: true, type: true, seasonYear: true, createdAt: true },
  });

  await prisma.santaAdminAuditLog.create({
    data: { campaignId: campaign.id, actorId: user.id, action: 'campaign_created' },
  });

  return res.status(201).json({ campaign });
}));

// GET /tg/santa/campaigns — list my campaigns (owned + joined)
tgRouter.get('/santa/campaigns', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);

  const [owned, joined] = await Promise.all([
    prisma.santaCampaign.findMany({
      where: { ownerId: user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true, title: true, status: true, type: true, seasonYear: true, createdAt: true,
        _count: { select: { participants: { where: { status: 'JOINED' } } } },
      },
    }),
    prisma.santaParticipant.findMany({
      where: { userId: user.id, status: 'JOINED', campaign: { ownerId: { not: user.id } } },
      orderBy: { joinedAt: 'desc' },
      select: {
        campaign: {
          select: {
            id: true, title: true, status: true, type: true, seasonYear: true, createdAt: true,
            _count: { select: { participants: { where: { status: 'JOINED' } } } },
            owner: { select: { firstName: true, profile: { select: { displayName: true } } } },
          },
        },
      },
    }),
  ]);

  return res.json({
    owned: owned.map(c => ({ ...c, participantCount: c._count.participants })),
    joined: joined.map(j => ({
      ...j.campaign,
      participantCount: j.campaign._count.participants,
      ownerName: j.campaign.owner.profile?.displayName || j.campaign.owner.firstName || null,
    })),
  });
}));

// GET /tg/santa/campaigns/:id — campaign detail (participants only)
tgRouter.get('/santa/campaigns/:id', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true, title: true, description: true, type: true, status: true, ownerId: true,
      inviteToken: true, minBudget: true, maxBudget: true, currency: true, drawAt: true,
      seasonYear: true, cancelledAt: true, cancelReason: true, createdAt: true,
      currentRoundId: true,
      participants: {
        where: { status: { in: ['JOINED', 'INVITED'] } },
        select: {
          id: true, status: true, role: true, joinedAt: true,
          user: { select: { id: true, firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
          linkedWishlist: { select: { id: true, title: true, slug: true } },
        },
        orderBy: { joinedAt: 'asc' },
      },
      rounds: { select: { id: true, roundNumber: true }, orderBy: { roundNumber: 'asc' } },
    },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const isOwner = campaign.ownerId === user.id;
  const isParticipant = campaign.participants.some(p => p.user.id === user.id);
  if (!isOwner && !isParticipant) return res.status(403).json({ error: 'Forbidden' });

  // Load alias map for current round (empty map if no round yet)
  const aliasMap = campaign.currentRoundId
    ? await loadSantaAliasMap(campaign.currentRoundId)
    : new Map<string, SantaAliasRecord>();

  // Pre-draw: build stable join-order map (participantId → 1-based position, sorted by joinedAt ASC, id ASC)
  const joinOrderMap = new Map<string, number>();
  [...campaign.participants]
    .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime() || a.id.localeCompare(b.id))
    .forEach((p, i) => joinOrderMap.set(p.id, i + 1));

  // Find caller's own assignment (post-draw) — role-aware, never leaks pairs
  let myAssignment: SantaAssignmentForGiver | null = null;
  let ownerProgress: SantaAssignmentForOwner | null = null;
  const myParticipant = campaign.participants.find(p => p.user.id === user.id);
  if (campaign.currentRoundId && ['ACTIVE', 'COMPLETED'].includes(campaign.status)) {
    const roundId = campaign.currentRoundId;
    // Organizer (owner or admin) sees aggregate progress — no individual pairs
    const callerParticipant = campaign.participants.find(p => p.user.id === user.id);
    const callerIsOrganizer = campaign.ownerId === user.id ||
      (callerParticipant?.status === 'JOINED' && callerParticipant.role === 'ADMIN');
    if (callerIsOrganizer) {
      const allAssignments = await prisma.santaAssignment.findMany({
        where: { roundId },
        select: { giftStatus: true },
      });
      // Count receivers without a linked wishlist (so organizer can nudge them)
      const receiverWithoutWishlistCount = campaign.participants.filter(
        p => p.status === 'JOINED' && !p.linkedWishlist,
      ).length;
      ownerProgress = serializeAssignment('owner', { assignments: allAssignments, receiverWithoutWishlistCount });
    }
    if (myParticipant) {
      // Giver view for all participants (including owner if they're also a participant)
      const giverAssignment = await prisma.santaAssignment.findUnique({
        where: { roundId_giverParticipantId: { roundId, giverParticipantId: myParticipant.id } },
        select: {
          giftStatus: true, giftNote: true,
          receiver: {
            select: {
              id: true,      // needed for alias lookup
              linkedWishlistId: true,
            },
          },
          santaItemReservations: {
            select: { itemId: true, item: { select: { title: true } } },
            orderBy: { createdAt: 'asc' },
          },
        },
      });
      if (giverAssignment) {
        const receiverAlias = resolveSantaAlias(aliasMap, giverAssignment.receiver.id);
        myAssignment = serializeAssignment('giver', {
          giftStatus: giverAssignment.giftStatus,
          giftNote: giverAssignment.giftNote,
          receiver: {
            displayName: receiverAlias.alias,      // alias instead of real name
            avatarUrl: null,                        // never expose real photo
            emoji: receiverAlias.emoji,
            adjectiveKey: receiverAlias.adjectiveKey,
            animalKey: receiverAlias.animalKey,
            hasLinkedWishlist: !!giverAssignment.receiver.linkedWishlistId,
          },
          reservedItems: giverAssignment.santaItemReservations.map(r => ({ id: r.itemId, title: r.item.title })),
        });
      }
    }
  }

  // Pending exit request for caller (if they have one)
  let pendingExitRequestId: string | null = null;
  if (myParticipant && !isOwner) {
    const pendingReq = await prisma.santaExitRequest.findFirst({
      where: { participantId: myParticipant.id, status: 'PENDING' },
      select: { id: true },
    });
    pendingExitRequestId = pendingReq?.id ?? null;
  }

  // Number of pending exit requests visible to organizers
  const pendingExitRequestCount = (isOwner || myParticipant?.role === 'ADMIN')
    ? await prisma.santaExitRequest.count({ where: { campaignId, status: 'PENDING' } })
    : 0;

  // Is caller an organizer (owner or ADMIN participant)?
  const amOrganizer = isOrganizer(campaign, user.id, myParticipant);

  // Chat unread count + mute state for participant
  let chatUnreadCount = 0;
  let isMuted = false;
  if (myParticipant) {
    const [chatCursor, mutedEntry] = await Promise.all([
      prisma.santaChatReadCursor.findUnique({
        where: { campaignId_participantId: { campaignId, participantId: myParticipant.id } },
        select: { lastReadMessageId: true },
      }),
      prisma.santaChatMute.findUnique({
        where: { campaignId_participantId: { campaignId, participantId: myParticipant.id } },
        select: { id: true },
      }),
    ]);
    isMuted = !!mutedEntry;
    if (!chatCursor?.lastReadMessageId) {
      chatUnreadCount = await prisma.santaChatMessage.count({ where: { campaignId } });
    } else {
      const lastRead = await prisma.santaChatMessage.findUnique({
        where: { id: chatCursor.lastReadMessageId },
        select: { createdAt: true, id: true },
      });
      if (lastRead) {
        chatUnreadCount = await prisma.santaChatMessage.count({
          where: {
            campaignId,
            OR: [
              { createdAt: { gt: lastRead.createdAt } },
              { createdAt: lastRead.createdAt, id: { gt: lastRead.id } },
            ],
          },
        });
      } else {
        chatUnreadCount = await prisma.santaChatMessage.count({ where: { campaignId } });
      }
    }
  }

  return res.json({
    campaign: {
      id: campaign.id,
      title: campaign.title,
      description: campaign.description,
      type: campaign.type,
      status: campaign.status,
      isOwner,
      isOrganizer: amOrganizer,
      inviteToken: isOwner ? campaign.inviteToken : undefined,
      minBudget: campaign.minBudget,
      maxBudget: campaign.maxBudget,
      currency: campaign.currency,
      drawAt: campaign.drawAt,
      seasonYear: campaign.seasonYear,
      cancelledAt: campaign.cancelledAt,
      cancelReason: campaign.cancelReason,
      createdAt: campaign.createdAt,
    },
    participants: campaign.participants.map(p => {
      // Post-draw: use round-scoped alias. Pre-draw: use stable join-order label.
      const hasRoundAlias = aliasMap.size > 0;
      const pAlias = hasRoundAlias
        ? resolveSantaAlias(aliasMap, p.id)
        : { alias: predrawLabel(joinOrderMap.get(p.id) ?? 0), emoji: '🎅', adjectiveKey: '', animalKey: '' };
      return {
        id: p.id,
        status: p.status,
        role: p.role,
        joinedAt: p.joinedAt,
        userId: p.user.id,
        isMe: p.user.id === user.id,
        // Alias instead of real name (displayName kept for API compat, populated with alias)
        displayName: pAlias.alias,
        avatarUrl: null,             // never expose real photo in Santa context
        emoji: pAlias.emoji,
        adjectiveKey: pAlias.adjectiveKey,
        animalKey: pAlias.animalKey,
        hasLinkedWishlist: !!p.linkedWishlist,
        // Never expose wishlist title — only the linked flag (or own wishlist id for self)
        linkedWishlist: p.user.id === user.id
          ? (p.linkedWishlist ? { id: p.linkedWishlist.id, slug: p.linkedWishlist.slug } : null)
          : null,
      };
    }),
    rounds: campaign.rounds,
    currentRoundNumber: campaign.rounds.find(r => r.id === campaign.currentRoundId)?.roundNumber ?? null,
    totalRounds: campaign.rounds.length,
    myRole: myParticipant?.role ?? null,
    myAlias: myParticipant && aliasMap.size > 0
      ? resolveSantaAlias(aliasMap, myParticipant.id)
      : null,
    pendingExitRequestId,
    pendingExitRequestCount: amOrganizer ? pendingExitRequestCount : undefined,
    myAssignment,
    ownerProgress: amOrganizer ? ownerProgress : undefined,
    chatUnreadCount,
    isMuted,
  });
}));

// PATCH /tg/santa/campaigns/:id — update campaign (owner only, non-COMPLETED/CANCELLED)
tgRouter.patch('/santa/campaigns/:id', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const parsed = z.object({
    title: z.string().min(1).max(80).optional(),
    description: z.string().max(500).nullable().optional(),
    minBudget: z.number().int().positive().nullable().optional(),
    maxBudget: z.number().int().positive().nullable().optional(),
    currency: z.string().max(3).optional(),
    drawAt: z.string().datetime().nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, status: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });
  if (['COMPLETED', 'CANCELLED'].includes(campaign.status)) return res.status(409).json({ error: 'Campaign is finished' });

  const data: Record<string, unknown> = {};
  if (parsed.data.title !== undefined) data.title = parsed.data.title;
  if (parsed.data.description !== undefined) data.description = parsed.data.description;
  if (parsed.data.minBudget !== undefined) data.minBudget = parsed.data.minBudget;
  if (parsed.data.maxBudget !== undefined) data.maxBudget = parsed.data.maxBudget;
  if (parsed.data.currency !== undefined) data.currency = parsed.data.currency;
  if (parsed.data.drawAt !== undefined) data.drawAt = parsed.data.drawAt ? new Date(parsed.data.drawAt) : null;

  const updated = await prisma.santaCampaign.update({ where: { id: campaignId }, data });
  return res.json({ campaign: updated });
}));

// POST /tg/santa/campaigns/:id/open — DRAFT → OPEN
tgRouter.post('/santa/campaigns/:id/open', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, status: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });
  if (campaign.status !== 'DRAFT') return res.status(409).json({ error: 'Campaign is not in DRAFT status' });

  await prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'OPEN' } });
  await prisma.santaAdminAuditLog.create({ data: { campaignId, actorId: user.id, action: 'status_changed', payload: { from: 'DRAFT', to: 'OPEN' } } });
  return res.json({ ok: true });
}));

// POST /tg/santa/campaigns/:id/lock — OPEN → LOCKED
tgRouter.post('/santa/campaigns/:id/lock', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { ownerId: true, status: true, _count: { select: { participants: { where: { status: 'JOINED' } } } } },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });
  if (campaign.status !== 'OPEN') return res.status(409).json({ error: 'Campaign is not OPEN' });
  if (campaign._count.participants < 2) return res.status(422).json({ error: 'Need at least 2 participants to lock' });

  await prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'LOCKED' } });
  await prisma.santaAdminAuditLog.create({ data: { campaignId, actorId: user.id, action: 'status_changed', payload: { from: 'OPEN', to: 'LOCKED' } } });
  return res.json({ ok: true });
}));

// POST /tg/santa/campaigns/:id/cancel — cancel campaign (owner only)
tgRouter.post('/santa/campaigns/:id/cancel', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const parsed = z.object({ reason: z.string().max(200).optional() }).safeParse(req.body);

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, status: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  // Cancel is owner-only — admins cannot cancel campaigns
  if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can cancel the campaign' });
  if (['COMPLETED', 'CANCELLED'].includes(campaign.status)) return res.status(409).json({ error: 'Campaign is already finished' });

  const now = new Date();
  await prisma.$transaction([
    prisma.santaCampaign.update({
      where: { id: campaignId },
      data: { status: 'CANCELLED', cancelledAt: now, cancelReason: parsed.success ? (parsed.data.reason ?? null) : null },
    }),
    // Bulk-cancel all PENDING hint requests for this campaign (lifecycle rule: campaign cancel → hints CANCELLED)
    prisma.santaHintRequest.updateMany({
      where: { campaignId, status: 'PENDING' },
      data: { status: 'CANCELLED', cancelledAt: now },
    }),
    prisma.santaAdminAuditLog.create({
      data: { campaignId, actorId: user.id, action: 'campaign_cancelled', payload: { reason: parsed.success ? parsed.data.reason : undefined } },
    }),
  ]);
  // System message: campaign cancelled
  void createSystemMessage(campaignId, 'campaign_cancelled', {}).catch(() => {});

  // CAMPAIGN_CANCELLED notifications — batch insert for all JOINED participants
  void (async () => {
    try {
      const joinedParticipants = await prisma.santaParticipant.findMany({
        where: { campaignId, status: 'JOINED' },
        select: { userId: true },
      });
      if (joinedParticipants.length > 0) {
        await prisma.santaNotification.createMany({
          data: joinedParticipants.map(p => ({
            campaignId,
            userId: p.userId,
            type: 'CAMPAIGN_CANCELLED' as const,
            payload: {},
            dedupeKey: `cancel:${campaignId}`,  // unique per (user, CAMPAIGN_CANCELLED, campaign)
          })),
          skipDuplicates: true,
        });
      }
    } catch {
      // Non-fatal
    }
  })();

  return res.json({ ok: true });
}));

// ─── Santa draw algorithm helpers ─────────────────────────────────────────────

/**
 * Build exclusion set as "smallerUserId:largerUserId" strings for O(1) lookup.
 */
/**
 * isOrganizer: returns true if the user is the campaign owner OR has a JOINED participant
 * record with role=ADMIN in this campaign. Used to gate organizer-only actions.
 *
 * Pass the campaign object (must include ownerId) and the participant record if already
 * loaded (can be null if the user has no participant record).
 */
function isOrganizer(
  campaign: { ownerId: string },
  userId: string,
  participant: { status: string; role: string } | null | undefined,
): boolean {
  if (campaign.ownerId === userId) return true;
  if (participant?.status === 'JOINED' && participant.role === 'ADMIN') return true;
  return false;
}

/**
 * checkIsOrganizer: async version of isOrganizer that loads the participant
 * record from DB when needed. Fast-paths if campaign.ownerId === userId.
 */
async function checkIsOrganizer(campaignId: string, campaign: { ownerId: string }, userId: string): Promise<boolean> {
  if (campaign.ownerId === userId) return true;
  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId } },
    select: { status: true, role: true },
  });
  return participant?.status === 'JOINED' && participant.role === 'ADMIN';
}

/**
 * Terminal gift statuses — used to check whether a round is complete enough
 * to allow starting the next round or to evaluate orphaned assignments.
 */
const TERMINAL_GIFT_STATUSES = ['RECEIVED', 'MISSED_DEADLINE', 'ORPHANED'] as const;

function buildExclusionSet(exclusions: { userId1: string; userId2: string }[]): Set<string> {
  const set = new Set<string>();
  for (const e of exclusions) {
    const key = [e.userId1, e.userId2].sort().join(':');
    set.add(key);
  }
  return set;
}

function exclusionKey(userIdA: string, userIdB: string): string {
  return [userIdA, userIdB].sort().join(':');
}

/**
 * Load all exclusions for a campaign (individual + group-expanded) and return:
 *  - exclusionSet: flat Set<string> ready for draw/feasibility (interface unchanged)
 *  - groups: raw group data used to annotate infeasible-draw errors with group labels
 *
 * Groups expand to C(n,2) pairs in-memory — no SantaExclusion rows are created.
 *
 * activeUserIds: Set of userIds who are currently JOINED in the campaign.
 * Group members who are no longer JOINED (left / removed) are silently skipped
 * during pair expansion so stale membership never blocks a valid draw.
 * The raw groups list returned still contains ALL members for UI/annotation use.
 */
async function loadExclusionSet(campaignId: string, activeUserIds: Set<string>): Promise<{
  exclusionSet: Set<string>;
  groups: { id: string; label: string; members: { userId: string }[] }[];
}> {
  const [individual, groups] = await Promise.all([
    prisma.santaExclusion.findMany({
      where: { campaignId },
      select: { userId1: true, userId2: true },
    }),
    prisma.santaExclusionGroup.findMany({
      where: { campaignId },
      select: { id: true, label: true, members: { select: { userId: true } } },
    }),
  ]);

  // Start with individual pair exclusions
  const allPairs: { userId1: string; userId2: string }[] = [...individual];

  // Expand each group: only expand members who are still JOINED participants.
  // Stale members (left / removed / deleted) are excluded from pair generation
  // but kept in the raw `groups` return value for UI display.
  for (const group of groups) {
    const members = group.members.map(m => m.userId).filter(uid => activeUserIds.has(uid));
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        allPairs.push({ userId1: members[i]!, userId2: members[j]! });
      }
    }
  }

  return { exclusionSet: buildExclusionSet(allPairs), groups };
}

/**
 * Given the loaded groups, find which group (if any) contributed a specific pair.
 * Used to annotate infeasible-draw error with a human-readable group label.
 */
function findGroupForPair(
  groups: { label: string; members: { userId: string }[] }[],
  uid1: string,
  uid2: string,
): string | null {
  for (const group of groups) {
    const memberIds = new Set(group.members.map(m => m.userId));
    if (memberIds.has(uid1) && memberIds.has(uid2)) return group.label;
  }
  return null;
}

/**
 * Hopcroft-Karp bipartite matching.
 * givers[i] can be assigned to receivers[j] if allowed[i][j] is true.
 * Returns maximum matching size. If size == N, a valid assignment exists.
 */
function hopcroftKarp(
  n: number,
  adj: number[][],   // adj[giver_index] = list of valid receiver_indexes
): { matchingSize: number; matchG: number[]; matchR: number[] } {
  const INF = Number.MAX_SAFE_INTEGER;
  const matchG = new Array<number>(n).fill(-1); // matchG[giver] = receiver index (-1 = unmatched)
  const matchR = new Array<number>(n).fill(-1); // matchR[receiver] = giver index
  const dist = new Array<number>(n);

  function bfs(): boolean {
    const queue: number[] = [];
    for (let u = 0; u < n; u++) {
      if (matchG[u] === -1) { dist[u] = 0; queue.push(u); }
      else dist[u] = INF;
    }
    let found = false;
    let qi = 0;
    while (qi < queue.length) {
      const u = queue[qi++]!;
      for (const v of adj[u]!) {
        const w = matchR[v]!;
        if (w === -1) { found = true; }
        else if (dist[w] === INF) { dist[w] = (dist[u] ?? 0) + 1; queue.push(w); }
      }
    }
    return found;
  }

  function dfs(u: number): boolean {
    for (const v of adj[u]!) {
      const w = matchR[v]!;
      if (w === -1 || (dist[w] === (dist[u] ?? 0) + 1 && dfs(w))) {
        matchG[u] = v; matchR[v] = u; return true;
      }
    }
    dist[u] = INF;
    return false;
  }

  let matchingSize = 0;
  while (bfs()) {
    for (let u = 0; u < n; u++) {
      if (matchG[u] === -1 && dfs(u)) matchingSize++;
    }
  }
  return { matchingSize, matchG, matchR };
}

/**
 * Check draw feasibility. Returns { feasible, problematic } without any side effects.
 * "problematic" lists participant userId pairs whose exclusion is most constraining.
 */
function checkDrawFeasibility(
  participants: { id: string; userId: string }[],
  exclusionSet: Set<string>,
): { feasible: boolean; problematic: { userId1: string; userId2: string }[] } {
  const n = participants.length;
  const idx = new Map<string, number>(); // participantId → index
  participants.forEach((p, i) => idx.set(p.id, i));

  const adj: number[][] = participants.map((giver, i) =>
    participants
      .map((receiver, j) => ({ receiver, j }))
      .filter(({ receiver, j }) =>
        j !== i && !exclusionSet.has(exclusionKey(giver.userId, receiver.userId))
      )
      .map(({ j }) => j)
  );

  const { matchingSize } = hopcroftKarp(n, adj);
  if (matchingSize === n) return { feasible: true, problematic: [] };

  // Identify most constrained participants (fewest valid receivers)
  const constrained = participants
    .map((p, i) => ({ userId: p.userId, options: adj[i]!.length }))
    .sort((a, b) => a.options - b.options)
    .slice(0, 3);

  // Find exclusions among the most constrained to give actionable feedback
  const problematic: { userId1: string; userId2: string }[] = [];
  for (let i = 0; i < constrained.length; i++) {
    for (let j = i + 1; j < constrained.length; j++) {
      const a = constrained[i]!.userId;
      const b = constrained[j]!.userId;
      if (exclusionSet.has(exclusionKey(a, b))) problematic.push({ userId1: a, userId2: b });
    }
  }
  // Also add exclusions where a participant has 0 valid receivers
  for (const c of constrained) {
    if (c.options === 0) {
      // Find all exclusions involving this participant
      for (const p2 of participants) {
        if (p2.userId !== c.userId && exclusionSet.has(exclusionKey(c.userId, p2.userId))) {
          problematic.push({ userId1: c.userId, userId2: p2.userId });
        }
      }
    }
  }

  return { feasible: false, problematic };
}

/**
 * Generate a random valid derangement (Secret Santa assignment) using Fisher-Yates + backtracking.
 * Returns array of { giverParticipantId, receiverParticipantId } or null if exhausted retries.
 */
function drawRandomAssignments(
  participants: { id: string; userId: string }[],
  exclusionSet: Set<string>,
  maxRetries = 1000,
): { giverParticipantId: string; receiverParticipantId: string }[] | null {
  const n = participants.length;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Fisher-Yates shuffle of receiver indexes
    const receivers = [...participants];
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [receivers[i], receivers[j]] = [receivers[j]!, receivers[i]!];
    }

    // Check all constraints
    let valid = true;
    for (let i = 0; i < n; i++) {
      const giver = participants[i]!;
      const receiver = receivers[i]!;
      if (giver.id === receiver.id) { valid = false; break; } // self-pair
      if (exclusionSet.has(exclusionKey(giver.userId, receiver.userId))) { valid = false; break; }
    }

    if (valid) {
      return participants.map((giver, i) => ({
        giverParticipantId: giver.id,
        receiverParticipantId: receivers[i]!.id,
      }));
    }
  }

  // Random approach exhausted → use deterministic backtracking
  const assignment = new Array<number>(n).fill(-1);
  const used = new Array<boolean>(n).fill(false);

  // Build adjacency list for each giver
  const adj: number[][] = participants.map((giver, i) => {
    const options: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      if (!exclusionSet.has(exclusionKey(giver.userId, participants[j]!.userId))) options.push(j);
    }
    // Shuffle options for randomness
    for (let k = options.length - 1; k > 0; k--) {
      const r = Math.floor(Math.random() * (k + 1));
      [options[k], options[r]] = [options[r]!, options[k]!];
    }
    return options;
  });

  function backtrack(pos: number): boolean {
    if (pos === n) return true;
    for (const j of adj[pos]!) {
      if (!used[j]) {
        assignment[pos] = j;
        used[j] = true;
        if (backtrack(pos + 1)) return true;
        assignment[pos] = -1;
        used[j] = false;
      }
    }
    return false;
  }

  if (!backtrack(0)) return null;
  return participants.map((giver, i) => ({
    giverParticipantId: giver.id,
    receiverParticipantId: participants[assignment[i]!]!.id,
  }));
}

// ─── Santa — role-aware assignment serializer ─────────────────────────────────

type SantaAssignmentForGiver = {
  role: 'giver';
  giftStatus: string;
  giftNote: string | null;
  receiver: { displayName: string; avatarUrl: null; emoji: string; adjectiveKey: string; animalKey: string; hasLinkedWishlist: boolean };
  reservedItems: { id: string; title: string }[];
};

type SantaAssignmentForReceiver = {
  role: 'receiver';
  giftStatus: string;
  hasGiver: true;
};

type SantaAssignmentForOwner = {
  role: 'owner';
  progress: {
    pending: number;
    buying: number;              // legacy BUYING count
    selectedFromWishlist: number;
    selectedOutside: number;
    declinedToSay: number;
    missedDeadline: number;
    sent: number;
    received: number;
    orphaned: number;            // exits approved mid-round
    withoutWishlist: number;     // receivers without a linked wishlist
  };
};

// ─── Inbound signal helpers (Batch 3) ─────────────────────────────────────────

/**
 * Maps a raw SantaGiftStatus value to a clean receiver-facing inbound signal.
 * Deliberately coarse to prevent side-channel deduction of giver behaviour timing.
 *   waiting     = giver hasn't committed to anything yet
 *   in_progress = giver has made a selection (type intentionally hidden)
 *   ready       = giver says they sent it; receiver should confirm receipt
 *   received    = receiver confirmed; reveal is now unlocked personally
 */
function giftStatusToInboundSignal(giftStatus: string): 'waiting' | 'in_progress' | 'ready' | 'received' {
  switch (giftStatus) {
    case 'SELECTED_FROM_WISHLIST':
    case 'SELECTED_OUTSIDE':
    case 'DECLINED_TO_SAY':
    case 'BUYING':           // legacy
      return 'in_progress';
    case 'SENT':
      return 'ready';
    case 'RECEIVED':
      return 'received';
    case 'PENDING':
    case 'MISSED_DEADLINE':  // don't expose giver's failure to receiver
    default:
      return 'waiting';
  }
}

/** Allowed giver-initiated gift status transitions (Batch 3 state machine). */
const GIVER_ALLOWED_TRANSITIONS: Record<string, string[]> = {
  PENDING:                ['SELECTED_FROM_WISHLIST', 'SELECTED_OUTSIDE', 'DECLINED_TO_SAY', 'SENT', 'BUYING'],
  BUYING:                 ['SELECTED_FROM_WISHLIST', 'SELECTED_OUTSIDE', 'DECLINED_TO_SAY', 'SENT'],
  SELECTED_FROM_WISHLIST: ['SELECTED_OUTSIDE', 'DECLINED_TO_SAY', 'SENT'],
  SELECTED_OUTSIDE:       ['SELECTED_FROM_WISHLIST', 'DECLINED_TO_SAY', 'SENT'],
  DECLINED_TO_SAY:        ['SELECTED_FROM_WISHLIST', 'SELECTED_OUTSIDE', 'SENT'],
  // M3: BUYING removed from MISSED_DEADLINE — giver must commit to a real choice after missing deadline
  // BUYING is too vague to escape the cron loop (cron re-marks BUYING as MISSED_DEADLINE every hour)
  MISSED_DEADLINE:        ['SELECTED_FROM_WISHLIST', 'SELECTED_OUTSIDE', 'DECLINED_TO_SAY', 'SENT'],
  // SENT and RECEIVED are terminal from the giver side
};

/**
 * Single serialization codepath for assignment data.
 * NEVER expose receiverUserId/receiverParticipantId to giver.
 * NEVER expose giver identity to receiver.
 * NEVER expose individual pairs to owner.
 */
function serializeAssignment(
  role: 'giver',
  data: { giftStatus: string; giftNote: string | null; receiver: { displayName: string; avatarUrl: null; emoji: string; adjectiveKey: string; animalKey: string; hasLinkedWishlist: boolean }; reservedItems?: { id: string; title: string }[] }
): SantaAssignmentForGiver;
function serializeAssignment(
  role: 'receiver',
  data: { giftStatus: string }
): SantaAssignmentForReceiver;
function serializeAssignment(
  role: 'owner',
  data: { assignments: { giftStatus: string }[]; receiverWithoutWishlistCount?: number }
): SantaAssignmentForOwner;
function serializeAssignment(
  role: 'giver' | 'receiver' | 'owner',
  data: unknown,
): SantaAssignmentForGiver | SantaAssignmentForReceiver | SantaAssignmentForOwner {
  if (role === 'giver') {
    const d = data as { giftStatus: string; giftNote: string | null; receiver: { displayName: string; avatarUrl: null; emoji: string; adjectiveKey: string; animalKey: string; hasLinkedWishlist: boolean }; reservedItems?: { id: string; title: string }[] };
    return { role: 'giver', giftStatus: d.giftStatus, giftNote: d.giftNote, receiver: { displayName: d.receiver.displayName, avatarUrl: null, emoji: d.receiver.emoji, adjectiveKey: d.receiver.adjectiveKey, animalKey: d.receiver.animalKey, hasLinkedWishlist: d.receiver.hasLinkedWishlist }, reservedItems: d.reservedItems ?? [] };
  }
  if (role === 'receiver') {
    const d = data as { giftStatus: string };
    return { role: 'receiver', giftStatus: d.giftStatus, hasGiver: true };
  }
  // owner — aggregate only, never per-assignment detail
  const d = data as { assignments: { giftStatus: string }[]; receiverWithoutWishlistCount?: number };
  const progress = {
    pending: 0, buying: 0, selectedFromWishlist: 0, selectedOutside: 0,
    declinedToSay: 0, missedDeadline: 0, sent: 0, received: 0,
    orphaned: 0,
    withoutWishlist: d.receiverWithoutWishlistCount ?? 0,
  };
  for (const a of d.assignments) {
    switch (a.giftStatus) {
      case 'PENDING':                 progress.pending++; break;
      case 'BUYING':                  progress.buying++; break;
      case 'SELECTED_FROM_WISHLIST':  progress.selectedFromWishlist++; break;
      case 'SELECTED_OUTSIDE':        progress.selectedOutside++; break;
      case 'DECLINED_TO_SAY':         progress.declinedToSay++; break;
      case 'MISSED_DEADLINE':         progress.missedDeadline++; break;
      case 'SENT':                    progress.sent++; break;
      case 'RECEIVED':                progress.received++; break;
      case 'ORPHANED':                progress.orphaned++; break;
    }
  }
  return { role: 'owner', progress };
}

// ─── Santa draw endpoints ──────────────────────────────────────────────────────

// GET /tg/santa/campaigns/:id/draw/validate — feasibility check, ZERO side effects
tgRouter.get('/santa/campaigns/:id/draw/validate', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: {
      ownerId: true,
      status: true,
      participants: {
        where: { status: 'JOINED' },
        select: { id: true, userId: true, user: { select: { firstName: true } } },
      },
      // SantaExclusion is not directly on campaign; query separately
    },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });
  if (!['LOCKED', 'OPEN', 'DRAFT'].includes(campaign.status)) {
    return res.status(409).json({ error: 'Draw can only be validated when campaign is LOCKED, OPEN or DRAFT' });
  }

  const participants = campaign.participants;
  if (participants.length < 2) {
    return res.json({ feasible: false, reason: 'not_enough_participants', minRequired: 2, actual: participants.length });
  }

  const activeUserIds = new Set(participants.map(p => p.userId));
  const { exclusionSet, groups } = await loadExclusionSet(campaignId, activeUserIds);
  const { feasible, problematic } = checkDrawFeasibility(participants, exclusionSet);

  if (feasible) {
    return res.json({ feasible: true, participantCount: participants.length });
  }

  // Build human-readable names + optional group label for each problematic pair
  const userIdToName = new Map(participants.map(p => [p.userId, p.user.firstName || p.userId]));
  const problematicWithNames = problematic.map(p => ({
    userId1: p.userId1, name1: userIdToName.get(p.userId1) ?? p.userId1,
    userId2: p.userId2, name2: userIdToName.get(p.userId2) ?? p.userId2,
    groupLabel: findGroupForPair(groups, p.userId1, p.userId2),
  }));

  return res.json({
    feasible: false,
    reason: 'exclusions_prevent_valid_assignment',
    participantCount: participants.length,
    problematicExclusions: problematicWithNames,
  });
}));

// POST /tg/santa/campaigns/:id/draw — execute draw with atomic lock
tgRouter.post('/santa/campaigns/:id/draw', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  // 1. Verify caller is organizer and campaign is LOCKED
  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { ownerId: true, status: true, id: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  // Draw is owner-only — admins cannot trigger draw
  if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can run the draw' });

  if (campaign.status === 'DRAW_IN_PROGRESS') {
    return res.status(409).json({ error: 'draw_already_running', message: 'A draw is already in progress for this campaign.' });
  }
  if (campaign.status !== 'LOCKED') {
    return res.status(409).json({ error: 'campaign_not_locked', message: 'Campaign must be in LOCKED status to start draw.' });
  }

  // 2. Load participants and exclusions
  const participants = await prisma.santaParticipant.findMany({
    where: { campaignId, status: 'JOINED' },
    select: { id: true, userId: true, user: { select: { firstName: true } } },
  });
  if (participants.length < 2) {
    return res.status(422).json({ error: 'not_enough_participants', minRequired: 2, actual: participants.length });
  }

  const activeUserIds = new Set(participants.map(p => p.userId));
  const { exclusionSet, groups: excGroups } = await loadExclusionSet(campaignId, activeUserIds);

  // 3. Pre-check feasibility before acquiring lock
  const { feasible, problematic } = checkDrawFeasibility(participants, exclusionSet);
  if (!feasible) {
    const userIdToName = new Map(participants.map(p => [p.userId, p.user.firstName || p.userId]));
    const problematicWithNames = problematic.map(p => ({
      userId1: p.userId1, name1: userIdToName.get(p.userId1) ?? p.userId1,
      userId2: p.userId2, name2: userIdToName.get(p.userId2) ?? p.userId2,
      groupLabel: findGroupForPair(excGroups, p.userId1, p.userId2),
    }));
    return res.status(422).json({
      error: 'draw_infeasible',
      reason: 'exclusions_prevent_valid_assignment',
      message: 'С текущими ограничениями жеребьёвка невозможна. Уберите одно из ограничений, чтобы продолжить.',
      problematicExclusions: problematicWithNames,
    });
  }

  // 4. Atomic lock: UPDATE only if still LOCKED (prevents double-draw)
  const drawJobId = crypto.randomUUID();
  const locked = await prisma.santaCampaign.updateMany({
    where: { id: campaignId, status: 'LOCKED' },
    data: { status: 'DRAW_IN_PROGRESS' },
  });
  if (locked.count === 0) {
    return res.status(409).json({ error: 'draw_already_running', message: 'Another draw job already acquired the lock.' });
  }

  // 5. Find the existing PENDING round (created by POST /rounds for multi-round),
  //    or create the first round if none exists.
  //    Invariant: at most one PENDING round per campaign (enforced by partial unique index).
  let round = await prisma.santaRound.findFirst({ where: { campaignId, drawStatus: 'PENDING' } });
  if (!round) {
    // First draw (or there's no pending round — create one)
    const maxRound = await prisma.santaRound.findFirst({
      where: { campaignId },
      orderBy: { roundNumber: 'desc' },
    });
    round = await prisma.santaRound.create({
      data: { campaignId, roundNumber: (maxRound?.roundNumber ?? 0) + 1, drawStatus: 'IN_PROGRESS', drawJobId },
    });
  } else {
    await prisma.santaRound.update({ where: { id: round.id }, data: { drawStatus: 'IN_PROGRESS', drawJobId } });
  }
  const roundId = round.id;

  try {
    // 6. Generate assignment (Fisher-Yates + backtracking)
    const assignments = drawRandomAssignments(participants, exclusionSet);
    if (!assignments) {
      // Should not happen since we pre-checked feasibility, but handle gracefully
      await prisma.$transaction([
        prisma.santaRound.update({ where: { id: roundId }, data: { drawStatus: 'FAILED' } }),
        prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'LOCKED' } }),
      ]);
      return res.status(500).json({ error: 'draw_failed', message: 'Draw algorithm failed despite feasibility check. Please retry.' });
    }

    // 7. Generate anonymous aliases for all participants (deterministic, round-scoped)
    const aliasData = generateSantaAliases(roundId, participants.map(p => p.id));

    // 8. Atomically persist assignments + aliases + mark ACTIVE
    await prisma.$transaction([
      prisma.santaAssignment.createMany({
        data: assignments.map(a => ({ roundId, ...a, giftStatus: 'PENDING' })),
      }),
      prisma.santaParticipantAlias.createMany({
        data: aliasData.map(a => ({ roundId, ...a })),
        skipDuplicates: true,
      }),
      prisma.santaRound.update({ where: { id: roundId }, data: { drawStatus: 'DONE', drawnAt: new Date() } }),
      prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'ACTIVE', currentRoundId: round.id } }),
    ]);

    // 8. Audit log
    await prisma.santaAdminAuditLog.create({
      data: { campaignId, actorId: user.id, action: 'draw_completed', payload: { drawJobId, assignmentCount: assignments.length } },
    });

    // System message: draw done (no pair info — just a generic event marker)
    void createSystemMessage(campaignId, 'draw_done', {}).catch(() => {});

    // DRAW_DONE notifications — one per participant per round, deduped by dedupeKey
    void (async () => {
      try {
        await prisma.santaNotification.createMany({
          data: participants.map(p => ({
            campaignId,
            userId: p.userId,
            type: 'DRAW_DONE' as const,
            payload: {},
            dedupeKey: `draw:${roundId}`,   // unique per (user, DRAW_DONE, round)
          })),
          skipDuplicates: true,
        });
      } catch {
        // Non-fatal
      }
    })();

    return res.json({ ok: true, assignmentCount: assignments.length });

  } catch (err) {
    // Rollback: mark round FAILED, campaign back to LOCKED for retry
    try {
      await prisma.$transaction([
        prisma.santaRound.update({ where: { id: roundId }, data: { drawStatus: 'FAILED' } }),
        prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'LOCKED' } }),
      ]);
    } catch (_rollbackErr) {
      // Best-effort rollback
    }
    throw err; // Re-throw for asyncHandler to catch
  }
}));

// GET /tg/santa/invite/:token — resolve invite token → campaign preview
tgRouter.get('/santa/invite/:token', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const token = req.params.token ?? '';
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const campaign = await prisma.santaCampaign.findUnique({
    where: { inviteToken: token },
    select: {
      id: true, title: true, description: true, status: true, type: true, seasonYear: true,
      minBudget: true, maxBudget: true, currency: true,
      owner: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
      _count: { select: { participants: { where: { status: 'JOINED' } } } },
    },
  });

  if (!campaign) return res.status(404).json({ error: 'Invite not found' });
  if (campaign.status === 'CANCELLED') return res.status(410).json({ error: 'Campaign cancelled' });

  // P0-B: if user is already a JOINED participant, let them through regardless of campaign status
  // (they clicked the invite link from a running campaign — redirect them to campaign detail)
  const alreadyJoined = await prisma.santaParticipant.findFirst({
    where: { campaignId: campaign.id, userId: user.id, status: 'JOINED' },
    select: { id: true },
  });

  if (!alreadyJoined && !['OPEN', 'DRAFT'].includes(campaign.status)) {
    return res.status(409).json({ error: 'Campaign is not accepting new members', campaignId: campaign.id });
  }

  const campaignPreview = {
    id: campaign.id,
    title: campaign.title,
    description: campaign.description,
    status: campaign.status,
    type: campaign.type,
    seasonYear: campaign.seasonYear,
    minBudget: campaign.minBudget,
    maxBudget: campaign.maxBudget,
    currency: campaign.currency,
    participantCount: campaign._count.participants,
    ownerName: campaign.owner.profile?.displayName || campaign.owner.firstName || null,
    ownerAvatarUrl: campaign.owner.profile?.avatarUrl || null,
  };

  return res.json({ campaign: campaignPreview, alreadyJoined: !!alreadyJoined });
}));

// POST /tg/santa/campaigns/:id/join — join via invite token
tgRouter.post('/santa/campaigns/:id/join', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { status: true, ownerId: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status === 'CANCELLED') return res.status(410).json({ error: 'Campaign cancelled' });
  if (!['OPEN', 'DRAFT'].includes(campaign.status)) return res.status(409).json({ error: 'Campaign is not accepting new members' });

  // Already a participant?
  const existing = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
  });
  if (existing) {
    if (existing.status === 'JOINED') return res.json({ ok: true, alreadyJoined: true });
    // Rejoin if left/removed
    await prisma.santaParticipant.update({
      where: { id: existing.id },
      data: { status: 'JOINED', leftAt: null, joinedAt: new Date() },
    });
    // System message: rejoined — no real name in payload
    void createSystemMessage(campaignId, 'participant_joined', {}).catch(() => {});
    return res.json({ ok: true });
  }

  const newParticipant = await prisma.santaParticipant.create({
    data: { campaignId, userId: user.id, status: 'JOINED' },
    select: { id: true },
  });
  // System message: participant joined — no real name in payload
  void createSystemMessage(campaignId, 'participant_joined', {}).catch(() => {});
  // Notify owner
  void prisma.santaNotification.create({
    data: { campaignId, userId: campaign.ownerId, type: 'JOINED', payload: { participantId: newParticipant.id } },
  }).catch(() => {});

  return res.status(201).json({ ok: true });
}));

// POST /tg/santa/campaigns/:id/leave — leave campaign (before draw)
tgRouter.post('/santa/campaigns/:id/leave', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
    include: { campaign: { select: { status: true } } },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(404).json({ error: 'Not a participant' });
  // COMPLETED/CANCELLED: cannot leave at all (terminal states)
  if (['COMPLETED', 'CANCELLED'].includes(participant.campaign.status)) {
    return res.status(409).json({ error: 'Campaign is already finished' });
  }
  // LOCKED, DRAW_IN_PROGRESS, or ACTIVE: must use exit-request flow
  if (['LOCKED', 'DRAW_IN_PROGRESS', 'ACTIVE'].includes(participant.campaign.status)) {
    return res.status(409).json({
      error: 'use_exit_request',
      message: 'Campaign is locked or active. Submit an exit request for the organizer to approve.',
      campaignStatus: participant.campaign.status,
    });
  }

  await prisma.santaParticipant.update({
    where: { id: participant.id },
    data: { status: 'LEFT', leftAt: new Date() },
  });
  // System message: participant left — no real name in payload
  void createSystemMessage(campaignId, 'participant_left', {}).catch(() => {});

  return res.json({ ok: true });
}));

// DELETE /tg/santa/campaigns/:id/participants/:userId — remove participant (organizer only, before draw)
tgRouter.delete('/santa/campaigns/:id/participants/:userId', asyncHandler(async (req, res) => {
  const owner = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const targetUserId = req.params.userId ?? '';

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, status: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  // M5: removal is owner-only (admins can manage participants but not remove them)
  if (campaign.ownerId !== owner.id) return res.status(403).json({ error: 'Forbidden' });
  // Owner cannot remove themselves via this endpoint
  if (targetUserId === owner.id) return res.status(400).json({ error: 'Cannot remove yourself via this endpoint' });
  if (['ACTIVE', 'COMPLETED', 'DRAW_IN_PROGRESS'].includes(campaign.status)) {
    return res.status(409).json({ error: 'Cannot remove after draw' });
  }

  const participant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: targetUserId, status: 'JOINED' },
  });
  if (!participant) return res.status(404).json({ error: 'Participant not found' });

  const targetUser = await prisma.user.findUnique({
    where: { id: targetUserId },
    select: { firstName: true, profile: { select: { displayName: true } } },
  });
  await prisma.santaParticipant.update({
    where: { id: participant.id },
    data: { status: 'REMOVED', leftAt: new Date() },
  });
  // System message: participant was removed — no real name in payload
  void createSystemMessage(campaignId, 'participant_removed', {}).catch(() => {});

  return res.json({ ok: true });
}));

// PATCH /tg/santa/campaigns/:id/wishlist — link or unlink wishlist (participant only)
tgRouter.patch('/santa/campaigns/:id/wishlist', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const parsed = z.object({ wishlistId: z.string().nullable() }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
    include: { campaign: { select: { status: true } } },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(404).json({ error: 'Not a participant' });
  // Allow linking/changing during ACTIVE so participants who forgot to link pre-draw can still set a preference.
  // Block only terminal states and mid-draw state.
  if (['COMPLETED', 'CANCELLED', 'DRAW_IN_PROGRESS'].includes(participant.campaign.status)) {
    return res.status(409).json({ error: 'Cannot change wishlist after campaign is complete' });
  }

  if (parsed.data.wishlistId) {
    // Verify user owns this wishlist
    const wishlist = await prisma.wishlist.findUnique({ where: { id: parsed.data.wishlistId }, select: { ownerId: true } });
    if (!wishlist || wishlist.ownerId !== user.id) return res.status(404).json({ error: 'Wishlist not found' });
  }

  await prisma.santaParticipant.update({
    where: { id: participant.id },
    data: { linkedWishlistId: parsed.data.wishlistId },
  });
  return res.json({ ok: true });
}));

// GET /tg/santa/campaigns/:id/exclusions — list exclusions (owner only)
tgRouter.get('/santa/campaigns/:id/exclusions', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, currentRoundId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

  // Load alias map for current round; build participant join-order for pre-draw fallback
  const exclAliasMap = campaign.currentRoundId
    ? await loadSantaAliasMap(campaign.currentRoundId)
    : new Map<string, SantaAliasRecord>();

  // Load individual exclusions + groups + all participants in parallel
  const [rawExclusions, groups, allCampParticipants] = await Promise.all([
    prisma.santaExclusion.findMany({ where: { campaignId }, orderBy: { createdAt: 'asc' } }),
    prisma.santaExclusionGroup.findMany({
      where: { campaignId },
      orderBy: { createdAt: 'asc' },
      include: {
        members: {
          select: { userId: true },
        },
      },
    }),
    prisma.santaParticipant.findMany({
      where: { campaignId },
      select: { id: true, userId: true, status: true, joinedAt: true },
      orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    }),
  ]);

  const joinedUserIds = new Set(allCampParticipants.filter(p => p.status === 'JOINED').map(p => p.userId));
  // Map userId → participantId for alias lookup
  const userIdToParticipantId = new Map(allCampParticipants.map(p => [p.userId, p.id]));
  // Join order map: participantId → 1-based position
  const exclJoinOrderMap = new Map(allCampParticipants.map((p, i) => [p.id, i + 1]));

  const hasRoundAlias = exclAliasMap.size > 0;
  const resolveForUser = (userId: string) => {
    const pid = userIdToParticipantId.get(userId);
    if (!pid) return { alias: 'Участник', emoji: '🎅' };
    return hasRoundAlias
      ? resolveSantaAlias(exclAliasMap, pid)
      : { alias: predrawLabel(exclJoinOrderMap.get(pid) ?? 0), emoji: '🎅' };
  };
  const resolveForParticipant = (pid: string) => hasRoundAlias
    ? resolveSantaAlias(exclAliasMap, pid)
    : { alias: predrawLabel(exclJoinOrderMap.get(pid) ?? 0), emoji: '🎅' };

  return res.json({
    exclusions: rawExclusions.map(e => {
      const a1 = resolveForUser(e.userId1);
      const a2 = resolveForUser(e.userId2);
      return {
        id: e.id,
        userId1: e.userId1, name1: a1.alias, emoji1: a1.emoji,
        userId2: e.userId2, name2: a2.alias, emoji2: a2.emoji,
      };
    }),
    groups: groups.map(g => ({
      id: g.id,
      label: g.label,
      members: g.members.map(m => {
        const pid = userIdToParticipantId.get(m.userId) ?? '';
        const a = resolveForParticipant(pid);
        return {
          userId: m.userId,
          displayName: a.alias,
          avatarUrl: null,
          emoji: a.emoji,
          adjectiveKey: (a as SantaAliasRecord).adjectiveKey ?? null,
          animalKey: (a as SantaAliasRecord).animalKey ?? null,
          isStale: !joinedUserIds.has(m.userId),
        };
      }),
      activeCount: g.members.filter(m => joinedUserIds.has(m.userId)).length,
    })),
  });
}));

// POST /tg/santa/campaigns/:id/exclusions — add exclusion (owner + PRO only)
tgRouter.post('/santa/campaigns/:id/exclusions', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const parsed = z.object({ userId1: z.string().min(1), userId2: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

  const ent = await getUserEntitlement(user.id);
  if (!ent.isPro) return res.status(402).json({ error: 'pro_required', feature: 'santa_exclusions' });

  const { userId1, userId2 } = parsed.data;
  // Normalize order to prevent (A,B) and (B,A) both existing
  const [uid1, uid2] = userId1 < userId2 ? [userId1, userId2] : [userId2, userId1];

  try {
    const exclusion = await prisma.santaExclusion.create({ data: { campaignId, userId1: uid1, userId2: uid2 } });
    return res.status(201).json({ exclusion });
  } catch {
    return res.status(409).json({ error: 'Exclusion already exists' });
  }
}));

// DELETE /tg/santa/campaigns/:id/exclusions/:exclusionId — remove exclusion (owner only)
tgRouter.delete('/santa/campaigns/:id/exclusions/:exclusionId', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const exclusionId = req.params.exclusionId ?? '';

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

  const exclusion = await prisma.santaExclusion.findUnique({ where: { id: exclusionId } });
  if (!exclusion || exclusion.campaignId !== campaignId) return res.status(404).json({ error: 'Exclusion not found' });

  await prisma.santaExclusion.delete({ where: { id: exclusionId } });
  return res.json({ ok: true });
}));

// ─── Batch 5.1: Group exclusion endpoints ─────────────────────────────────────

// POST /tg/santa/campaigns/:id/exclusions/groups — create named group (owner + PRO)
tgRouter.post('/santa/campaigns/:id/exclusions/groups', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const parsed = z.object({
    label: z.string().min(1).max(60).trim(),
    memberUserIds: z.array(z.string().min(1)).min(2).max(50).optional().default([]),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

  const ent = await getUserEntitlement(user.id);
  if (!ent.isPro) return res.status(402).json({ error: 'pro_required', feature: 'santa_exclusion_groups' });

  const group = await prisma.santaExclusionGroup.create({
    data: {
      campaignId,
      label: parsed.data.label,
      members: parsed.data.memberUserIds.length > 0
        ? { create: [...new Set(parsed.data.memberUserIds)].map(uid => ({ userId: uid })) }
        : undefined,
    },
    include: {
      members: {
        include: {
          user: { select: { id: true, firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
        },
      },
    },
  });

  return res.status(201).json({
    group: {
      id: group.id,
      label: group.label,
      members: group.members.map(m => ({
        userId: m.userId,
        displayName: m.user.profile?.displayName || m.user.firstName || m.userId,
        avatarUrl: m.user.profile?.avatarUrl ?? null,
      })),
    },
  });
}));

// PATCH /tg/santa/campaigns/:id/exclusions/groups/:gid — rename group (owner only)
tgRouter.patch('/santa/campaigns/:id/exclusions/groups/:gid', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const gid = req.params.gid ?? '';

  const parsed = z.object({ label: z.string().min(1).max(60).trim() }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

  const group = await prisma.santaExclusionGroup.findUnique({ where: { id: gid } });
  if (!group || group.campaignId !== campaignId) return res.status(404).json({ error: 'Group not found' });

  const updated = await prisma.santaExclusionGroup.update({
    where: { id: gid },
    data: { label: parsed.data.label },
  });
  return res.json({ group: { id: updated.id, label: updated.label } });
}));

// DELETE /tg/santa/campaigns/:id/exclusions/groups/:gid — delete group + all members (owner only)
tgRouter.delete('/santa/campaigns/:id/exclusions/groups/:gid', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const gid = req.params.gid ?? '';

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

  const group = await prisma.santaExclusionGroup.findUnique({ where: { id: gid } });
  if (!group || group.campaignId !== campaignId) return res.status(404).json({ error: 'Group not found' });

  // Cascade deletes members via FK constraint
  await prisma.santaExclusionGroup.delete({ where: { id: gid } });
  return res.json({ ok: true });
}));

// POST /tg/santa/campaigns/:id/exclusions/groups/:gid/members — add participant to group (owner + PRO only)
tgRouter.post('/santa/campaigns/:id/exclusions/groups/:gid/members', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const gid = req.params.gid ?? '';

  const parsed = z.object({ userId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

  const ent = await getUserEntitlement(user.id);
  if (!ent.isPro) return res.status(402).json({ error: 'pro_required', feature: 'santa_exclusion_groups' });

  const group = await prisma.santaExclusionGroup.findUnique({ where: { id: gid } });
  if (!group || group.campaignId !== campaignId) return res.status(404).json({ error: 'Group not found' });

  // Verify userId belongs to a JOINED participant in this campaign
  const participant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: parsed.data.userId, status: 'JOINED' },
  });
  if (!participant) return res.status(404).json({ error: 'Participant not found or not joined' });

  try {
    const member = await prisma.santaExclusionGroupMember.create({
      data: { groupId: gid, userId: parsed.data.userId },
      include: {
        user: { select: { id: true, firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
      },
    });
    return res.status(201).json({
      member: {
        userId: member.userId,
        displayName: member.user.profile?.displayName || member.user.firstName || member.userId,
        avatarUrl: member.user.profile?.avatarUrl ?? null,
      },
    });
  } catch {
    return res.status(409).json({ error: 'already_in_group' });
  }
}));

// DELETE /tg/santa/campaigns/:id/exclusions/groups/:gid/members/:uid — remove member (owner only)
tgRouter.delete('/santa/campaigns/:id/exclusions/groups/:gid/members/:uid', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const gid = req.params.gid ?? '';
  const targetUserId = req.params.uid ?? '';

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

  const group = await prisma.santaExclusionGroup.findUnique({ where: { id: gid } });
  if (!group || group.campaignId !== campaignId) return res.status(404).json({ error: 'Group not found' });

  const member = await prisma.santaExclusionGroupMember.findUnique({
    where: { groupId_userId: { groupId: gid, userId: targetUserId } },
  });
  if (!member) return res.status(404).json({ error: 'Member not found in group' });

  await prisma.santaExclusionGroupMember.delete({
    where: { groupId_userId: { groupId: gid, userId: targetUserId } },
  });
  return res.json({ ok: true });
}));

// POST /tg/santa/campaigns/:id/rounds — start next round (owner + all current round terminal)
tgRouter.post('/santa/campaigns/:id/rounds', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: {
      ownerId: true,
      status: true,
      currentRoundId: true,
      rounds: { select: { id: true, roundNumber: true }, orderBy: { roundNumber: 'desc' } },
    },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  // Starting a new round is owner-only — admins cannot start rounds
  if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can start a new round' });
  if (campaign.status !== 'ACTIVE') {
    return res.status(409).json({ error: 'campaign_not_active', message: 'Campaign must be ACTIVE to start next round' });
  }

  // Invariant: at most one PENDING round per campaign
  const existingPending = await prisma.santaRound.findFirst({
    where: { campaignId, drawStatus: 'PENDING' },
  });
  if (existingPending) {
    return res.status(409).json({ error: 'pending_round_exists', message: 'A round is already pending draw. Run the draw first.' });
  }

  // All assignments in current round must be in terminal states
  if (!campaign.currentRoundId) {
    return res.status(409).json({ error: 'no_active_round' });
  }
  const TERMINAL: string[] = ['RECEIVED', 'MISSED_DEADLINE', 'ORPHANED'];
  const blockingAssignments = await prisma.santaAssignment.findMany({
    where: { roundId: campaign.currentRoundId, giftStatus: { notIn: TERMINAL as never[] } },
    select: { id: true, giftStatus: true },
  });
  if (blockingAssignments.length > 0) {
    return res.status(409).json({
      error: 'round_not_complete',
      message: 'All gifts must reach RECEIVED, MISSED_DEADLINE, or ORPHANED before starting next round',
      blocking: blockingAssignments.map(a => ({ id: a.id, giftStatus: a.giftStatus })),
    });
  }

  // Create next round (PENDING)
  const nextRoundNumber = (campaign.rounds[0]?.roundNumber ?? 0) + 1;
  const nextRound = await prisma.santaRound.create({
    data: { campaignId, roundNumber: nextRoundNumber, drawStatus: 'PENDING' },
  });

  // Campaign back to LOCKED (ready to draw); currentRoundId stays pointing to completed round
  await prisma.santaCampaign.update({
    where: { id: campaignId },
    data: { status: 'LOCKED' },
  });

  return res.status(201).json({
    nextRound: { id: nextRound.id, roundNumber: nextRound.roundNumber },
    campaign: { status: 'LOCKED', currentRoundId: campaign.currentRoundId },
  });
}));

// POST /tg/santa/campaigns/:id/complete — force-complete campaign (organizer only, no assignment check)
tgRouter.post('/santa/campaigns/:id/complete', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { ownerId: true, status: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  // Force-complete is owner-only — admins cannot complete campaigns
  if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can complete the campaign' });
  if (campaign.status !== 'ACTIVE') {
    return res.status(409).json({ error: 'campaign_not_active', message: 'Only ACTIVE campaigns can be force-completed' });
  }

  await prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'COMPLETED' } });

  // campaign_completed system message in chat (guaranteed visible to all participants)
  void createSystemMessage(campaignId, 'campaign_completed', {}).catch(() => {});

  return res.json({ ok: true, status: 'COMPLETED' });
}));

// POST /tg/santa/campaigns/:id/gift-status — update gift status (giver only, post-draw)
tgRouter.patch('/santa/campaigns/:id/gift-status', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const parsed = z.object({
    // Accept all Batch-3 selection statuses + legacy BUYING + SENT
    status: z.enum(['BUYING', 'SELECTED_FROM_WISHLIST', 'SELECTED_OUTSIDE', 'DECLINED_TO_SAY', 'SENT']),
    note: z.string().max(300).optional(),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' }); // L1

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { status: true, currentRoundId: true } });
  if (!campaign || campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Campaign is not ACTIVE' });
  if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });

  const roundId = campaign.currentRoundId;
  const assignment = await prisma.santaAssignment.findUnique({
    where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
  });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  // Transition validation — SENT and RECEIVED are one-way doors
  const allowedNext = GIVER_ALLOWED_TRANSITIONS[assignment.giftStatus];
  if (!allowedNext) {
    return res.status(409).json({
      error: 'invalid_transition',
      message: `Cannot change gift status from ${assignment.giftStatus}`,
      currentStatus: assignment.giftStatus,
    });
  }
  if (!allowedNext.includes(parsed.data.status)) {
    return res.status(409).json({
      error: 'invalid_transition',
      message: `Transition from ${assignment.giftStatus} to ${parsed.data.status} is not allowed`,
      currentStatus: assignment.giftStatus,
    });
  }

  // When switching away from wishlist-based selection, clear all Santa-flow reservations
  const clearReservationStatuses = ['SELECTED_OUTSIDE', 'DECLINED_TO_SAY', 'SENT'];
  if (clearReservationStatuses.includes(parsed.data.status)) {
    await prisma.santaItemReservation.deleteMany({ where: { assignmentId: assignment.id } });
  }

  const updated = await prisma.santaAssignment.update({
    where: { id: assignment.id },
    data: { giftStatus: parsed.data.status, giftNote: parsed.data.note ?? assignment.giftNote },
    include: {
      receiver: {
        select: {
          id: true,
          linkedWishlistId: true,
        },
      },
      santaItemReservations: {
        select: { itemId: true, item: { select: { title: true } } },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  await prisma.santaGiftProgress.create({ data: { assignmentId: assignment.id, status: parsed.data.status, note: parsed.data.note } });

  // Return role-aware serialized response — never expose receiverUserId/receiverParticipantId; use alias
  const giftStatusAliasMap = await loadSantaAliasMap(roundId);
  const receiverAlias = resolveSantaAlias(giftStatusAliasMap, updated.receiver.id);
  return res.json(serializeAssignment('giver', {
    giftStatus: updated.giftStatus,
    giftNote: updated.giftNote,
    receiver: { displayName: receiverAlias.alias, avatarUrl: null, emoji: receiverAlias.emoji, adjectiveKey: receiverAlias.adjectiveKey, animalKey: receiverAlias.animalKey, hasLinkedWishlist: !!updated.receiver.linkedWishlistId },
    reservedItems: updated.santaItemReservations.map(r => ({ id: r.itemId, title: r.item.title })),
  }));
}));

// POST /tg/santa/campaigns/:id/confirm-received — receiver confirms gift received
tgRouter.post('/santa/campaigns/:id/confirm-received', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' }); // L1

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { status: true, currentRoundId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!['ACTIVE', 'COMPLETED'].includes(campaign.status)) return res.status(409).json({ error: 'Campaign is not ACTIVE' });
  if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });

  const roundId = campaign.currentRoundId;
  // Receiver addresses via campaign-centric path — NOT assignmentId
  // M1: resolve assignment FIRST — check RECEIVED idempotency before campaign-active gate
  // This ensures a retry after the campaign auto-completes still returns the idempotent success.
  const assignment = await prisma.santaAssignment.findUnique({
    where: { roundId_receiverParticipantId: { roundId, receiverParticipantId: participant.id } },
    select: { id: true, giftStatus: true }, // Only what we need — never select giverParticipantId here
  });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
  // Idempotency: already RECEIVED → return success regardless of campaign.status
  if (assignment.giftStatus === 'RECEIVED') return res.json({ ok: true, campaignCompleted: campaign.status === 'COMPLETED', alreadyReceived: true, canReveal: true });
  // Now enforce ACTIVE-only for actual state transition
  if (campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Campaign is not ACTIVE' });

  // Gate: only allowed from SENT (giver must acknowledge they sent before receiver can confirm)
  if (assignment.giftStatus !== 'SENT') {
    return res.status(409).json({
      error: 'gift_not_sent',
      message: 'Receiver can only confirm receipt after the giver marks the gift as sent',
      currentGiftStatus: assignment.giftStatus,
    });
  }

  // Fetch the giver's participantId (needed for notification — never exposed to receiver)
  const fullAssignment = await prisma.santaAssignment.findUnique({
    where: { id: assignment.id },
    select: { giverParticipantId: true, giver: { select: { userId: true } } },
  });

  await prisma.santaAssignment.update({ where: { id: assignment.id }, data: { giftStatus: 'RECEIVED' } });
  await prisma.santaGiftProgress.create({ data: { assignmentId: assignment.id, status: 'RECEIVED' } });

  // Check if all gifts received → complete campaign
  const allAssignments = await prisma.santaAssignment.findMany({ where: { roundId }, select: { id: true, giftStatus: true } });
  // After our update above, re-check: our assignment is now RECEIVED
  // Auto-complete: only for single-round campaigns where all assignments are RECEIVED.
  // Multi-round campaigns (totalRounds > 1) require organizer to explicitly call POST /complete.
  // MISSED_DEADLINE assignments do NOT trigger auto-complete; organizer uses POST /complete.
  const totalRounds = await prisma.santaRound.count({ where: { campaignId } });
  const allReceived = allAssignments.every(a => a.id === assignment.id ? true : a.giftStatus === 'RECEIVED');
  if (allReceived && totalRounds === 1) {
    await prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'COMPLETED' } });
    // campaign_completed system message in chat
    void createSystemMessage(campaignId, 'campaign_completed', {}).catch(() => {});
  }

  // Notifications (best-effort, non-blocking) — deduped by DB partial unique index
  if (fullAssignment) {
    const giverUserId = fullAssignment.giver.userId;
    // GIFT_RECEIVED → giver: "your recipient received your gift!" (once per assignment)
    void prisma.santaNotification.create({
      data: { campaignId, userId: giverUserId, type: 'GIFT_RECEIVED', payload: { assignmentId: assignment.id }, dedupeKey: `gift:${assignment.id}` },
    }).catch(() => { /* duplicate suppressed by dedupeKey unique index */ });

    // REVEAL_UNLOCKED → receiver: "you can now see who your Secret Santa was!" (once per assignment)
    void prisma.santaNotification.create({
      data: { campaignId, userId: user.id, type: 'REVEAL_UNLOCKED', payload: { assignmentId: assignment.id }, dedupeKey: `reveal:${assignment.id}` },
    }).catch(() => { /* duplicate suppressed by dedupeKey unique index */ });
  }

  return res.json({ ok: true, campaignCompleted: allReceived, canReveal: true });
}));

// ─── Santa — inbound (receiver-centric, post-draw) ────────────────────────────

// GET /tg/santa/campaigns/:id/inbound/wishlist — giver gets receiver's wishlist items
// Returns items with reservedByMe flag + myReservations summary for the dedicated wishlist screen.
tgRouter.get('/santa/campaigns/:id/inbound/wishlist', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const participant = await prisma.santaParticipant.findUnique({ where: { campaignId_userId: { campaignId, userId: user.id } } });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { status: true, currentRoundId: true } });
  if (!campaign || campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Campaign not ACTIVE' });
  if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });

  const roundId = campaign.currentRoundId;
  const assignment = await prisma.santaAssignment.findUnique({
    where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
    include: {
      receiver: { select: { id: true, linkedWishlistId: true } },
      santaItemReservations: { select: { itemId: true, item: { select: { title: true } } }, orderBy: { createdAt: 'asc' } },
    },
  });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  const receiverWishlistId = assignment.receiver.linkedWishlistId;
  // Use alias — never expose real receiver identity to giver
  const inboundAliasMap = await loadSantaAliasMap(roundId);
  const receiverAlias = resolveSantaAlias(inboundAliasMap, assignment.receiver.id);

  const myReservedItemIds = new Set(assignment.santaItemReservations.map(r => r.itemId));
  const myReservations = assignment.santaItemReservations.map(r => ({ id: r.itemId, title: r.item.title }));

  const giverView = serializeAssignment('giver', {
    giftStatus: assignment.giftStatus,
    giftNote: assignment.giftNote,
    receiver: { displayName: receiverAlias.alias, avatarUrl: null, emoji: receiverAlias.emoji, adjectiveKey: receiverAlias.adjectiveKey, animalKey: receiverAlias.animalKey, hasLinkedWishlist: !!receiverWishlistId },
    reservedItems: myReservations,
  });

  if (!receiverWishlistId) return res.json({ ...giverView, wishlist: null, items: [], myReservations });

  const items = await prisma.item.findMany({
    where: { wishlistId: receiverWishlistId, status: { in: ['AVAILABLE', 'RESERVED', 'PURCHASED'] } },
    orderBy: ITEM_ORDER_BY,
    select: { id: true, title: true, url: true, priceText: true, currency: true, priority: true, imageUrl: true, status: true, description: true },
  });
  const wishlist = await prisma.wishlist.findUnique({ where: { id: receiverWishlistId }, select: { title: true } });

  // Annotate items with reservedByMe flag — never expose reserver identity for items NOT reserved by this giver
  const annotatedItems = items.map(item => ({
    ...item,
    reservedByMe: myReservedItemIds.has(item.id),
    // For items reserved by others (status=RESERVED) but NOT by this giver, only expose the status flag
    // No reserver identity is ever returned
  }));

  return res.json({ ...giverView, wishlist: wishlist ? { title: wishlist.title } : null, items: annotatedItems, myReservations });
}));

// POST /tg/santa/campaigns/:id/inbound/reserve — giver reserves a wishlist item (Santa-flow)
// Creates SantaItemReservation and auto-syncs gift status to SELECTED_FROM_WISHLIST.
tgRouter.post('/santa/campaigns/:id/inbound/reserve', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const parsed = z.object({ itemId: z.string().min(1) }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);
  const { itemId } = parsed.data;

  const participant = await prisma.santaParticipant.findUnique({ where: { campaignId_userId: { campaignId, userId: user.id } } });
  if (!participant || participant.status !== 'JOINED') {
    logger.error({ campaignId, userId: user.id, status: participant?.status }, 'reserve: 403 not participant');
    return res.status(403).json({ error: 'Not a participant' });
  }

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { status: true, currentRoundId: true } });
  if (!campaign || campaign.status !== 'ACTIVE') {
    logger.error({ campaignId, status: campaign?.status }, 'reserve: 409 campaign not ACTIVE');
    return res.status(409).json({ error: 'Campaign not ACTIVE', message: `Campaign status is ${campaign?.status ?? 'not found'}` });
  }
  if (!campaign.currentRoundId) {
    logger.error({ campaignId }, 'reserve: 404 no active round');
    return res.status(404).json({ error: 'No active round' });
  }

  const roundId = campaign.currentRoundId;
  const assignment = await prisma.santaAssignment.findUnique({
    where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
    select: { id: true, giftStatus: true, receiver: { select: { linkedWishlistId: true } } },
  });
  if (!assignment) {
    logger.error({ roundId, participantId: participant.id }, 'reserve: 404 assignment not found');
    return res.status(404).json({ error: 'Assignment not found' });
  }

  // Terminal states: cannot reserve after SENT/RECEIVED
  if (['SENT', 'RECEIVED'].includes(assignment.giftStatus)) {
    return res.status(409).json({ error: 'invalid_state', message: `Cannot reserve items when gift status is ${assignment.giftStatus}` });
  }

  // Validate item belongs to receiver's wishlist
  const receiverWishlistId = assignment.receiver.linkedWishlistId;
  if (!receiverWishlistId) {
    logger.error({ assignmentId: assignment.id }, 'reserve: 409 receiver has no wishlist');
    return res.status(409).json({ error: 'receiver_no_wishlist', message: 'Receiver has no linked wishlist' });
  }

  const item = await prisma.item.findFirst({
    where: { id: itemId, wishlistId: receiverWishlistId, status: { in: ['AVAILABLE', 'RESERVED', 'PURCHASED'] } },
    select: { id: true, title: true },
  });
  if (!item) {
    logger.error({ itemId, receiverWishlistId }, 'reserve: 404 item not found');
    return res.status(404).json({ error: 'Item not found or not reservable' });
  }

  // Create reservation — explicit create+catch for idempotency (avoids upsert with empty update which can be unreliable)
  try {
    await prisma.santaItemReservation.create({ data: { assignmentId: assignment.id, itemId } });
  } catch (e: unknown) {
    // P2002 = unique constraint violation — item already reserved by this assignment (idempotent)
    const prismaErr = e as { code?: string };
    if (prismaErr.code !== 'P2002') throw e;
  }

  // Auto-sync gift status to SELECTED_FROM_WISHLIST if not already in a committed state
  const syncableStatuses = ['PENDING', 'BUYING', 'MISSED_DEADLINE', 'SELECTED_OUTSIDE', 'DECLINED_TO_SAY'];
  if (syncableStatuses.includes(assignment.giftStatus)) {
    await prisma.santaAssignment.update({
      where: { id: assignment.id },
      data: { giftStatus: 'SELECTED_FROM_WISHLIST' },
    });
    await prisma.santaGiftProgress.create({ data: { assignmentId: assignment.id, status: 'SELECTED_FROM_WISHLIST' } });
  }

  // Return updated reservation list
  const reservations = await prisma.santaItemReservation.findMany({
    where: { assignmentId: assignment.id },
    select: { itemId: true, item: { select: { title: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return res.json({
    ok: true,
    reservedItemIds: reservations.map(r => r.itemId),
    myReservations: reservations.map(r => ({ id: r.itemId, title: r.item.title })),
  });
}));

// DELETE /tg/santa/campaigns/:id/inbound/reserve/:itemId — giver removes a wishlist reservation
// Auto-syncs gift status back to PENDING if no reservations remain.
tgRouter.delete('/santa/campaigns/:id/inbound/reserve/:itemId', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const itemId = req.params.itemId ?? '';
  if (!itemId) return res.status(400).json({ error: 'Missing itemId' });

  const participant = await prisma.santaParticipant.findUnique({ where: { campaignId_userId: { campaignId, userId: user.id } } });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { status: true, currentRoundId: true } });
  if (!campaign || campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Campaign not ACTIVE' });
  if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });

  const roundId = campaign.currentRoundId;
  const assignment = await prisma.santaAssignment.findUnique({
    where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
    select: { id: true, giftStatus: true },
  });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  // Delete reservation (idempotent — no error if not found)
  await prisma.santaItemReservation.deleteMany({
    where: { assignmentId: assignment.id, itemId },
  });

  // Count remaining reservations
  const remainingCount = await prisma.santaItemReservation.count({ where: { assignmentId: assignment.id } });

  // Auto-sync: if no reservations remain AND status is SELECTED_FROM_WISHLIST → revert to PENDING
  if (remainingCount === 0 && assignment.giftStatus === 'SELECTED_FROM_WISHLIST') {
    await prisma.santaAssignment.update({
      where: { id: assignment.id },
      data: { giftStatus: 'PENDING' },
    });
    await prisma.santaGiftProgress.create({ data: { assignmentId: assignment.id, status: 'PENDING' } });
  }

  // Return updated reservation list
  const reservations = await prisma.santaItemReservation.findMany({
    where: { assignmentId: assignment.id },
    select: { itemId: true, item: { select: { title: true } } },
    orderBy: { createdAt: 'asc' },
  });

  return res.json({
    ok: true,
    reservedItemIds: reservations.map(r => r.itemId),
    myReservations: reservations.map(r => ({ id: r.itemId, title: r.item.title })),
  });
}));

// GET /tg/santa/campaigns/:id/inbound/status — receiver gets their inbound gift signal
// Role: receiver only. Returns COARSE signal WITHOUT giver identity. Campaign-centric addressing.
// Batch 3: returns semantic signal + canConfirmReceived + canReveal flags. Raw giftStatus never exposed.
tgRouter.get('/santa/campaigns/:id/inbound/status', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { status: true, currentRoundId: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!['ACTIVE', 'COMPLETED'].includes(campaign.status)) {
    return res.json({ hasGiver: false, signal: 'waiting', canConfirmReceived: false, canReveal: false, campaignStatus: campaign.status });
  }
  if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });

  const roundId = campaign.currentRoundId;
  // Resolve via receiver side — campaign-centric, NOT assignment-id-centric
  const assignment = await prisma.santaAssignment.findUnique({
    where: { roundId_receiverParticipantId: { roundId, receiverParticipantId: participant.id } },
    // ONLY giftStatus + revealedAt — no giverParticipantId EVER exposed to receiver
    select: { giftStatus: true, revealedAt: true },
  });
  if (!assignment) return res.json({ hasGiver: false, signal: 'waiting', canConfirmReceived: false, canReveal: false });

  const signal = giftStatusToInboundSignal(assignment.giftStatus);
  return res.json({
    hasGiver: true,
    signal,
    canConfirmReceived: assignment.giftStatus === 'SENT',
    canReveal: assignment.giftStatus === 'RECEIVED',
    // revealedAt tells the frontend whether reveal was already viewed (no re-animation)
    revealedAt: assignment.revealedAt?.toISOString() ?? null,
  });
}));

// GET /tg/santa/campaigns/:id/assignment — giver's own assignment summary (role-aware)
tgRouter.get('/santa/campaigns/:id/assignment', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { ownerId: true, status: true, currentRoundId: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const isOwner = campaign.ownerId === user.id;

  if (!['ACTIVE', 'COMPLETED'].includes(campaign.status)) {
    return res.json({ status: campaign.status, ready: false });
  }
  if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });
  const roundId = campaign.currentRoundId;

  // Owner: return aggregate progress only
  if (isOwner) {
    const allAssignments = await prisma.santaAssignment.findMany({
      where: { roundId },
      select: { giftStatus: true },
    });
    // Count receivers (participants) without a linked wishlist for owner context
    const participantsWithoutWishlist = await prisma.santaParticipant.count({
      where: { campaignId, status: 'JOINED', linkedWishlistId: null },
    });
    return res.json({ ready: true, ...serializeAssignment('owner', { assignments: allAssignments, receiverWithoutWishlistCount: participantsWithoutWishlist }) });
  }

  // Giver view
  const giverAssignment = await prisma.santaAssignment.findUnique({
    where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
    select: {
      giftStatus: true,
      giftNote: true,
      receiver: {
        select: {
          id: true,               // needed for alias lookup
          linkedWishlistId: true,
        },
      },
    },
  });
  if (!giverAssignment) return res.json({ ready: false, role: 'giver' });

  const assignmentAliasMap = await loadSantaAliasMap(roundId);
  const receiverAlias = resolveSantaAlias(assignmentAliasMap, giverAssignment.receiver.id);

  return res.json({
    ready: true,
    ...serializeAssignment('giver', {
      giftStatus: giverAssignment.giftStatus,
      giftNote: giverAssignment.giftNote,
      receiver: {
        displayName: receiverAlias.alias,
        avatarUrl: null,
        emoji: receiverAlias.emoji,
        adjectiveKey: receiverAlias.adjectiveKey,
        animalKey: receiverAlias.animalKey,
        hasLinkedWishlist: !!giverAssignment.receiver.linkedWishlistId,
      },
    }),
  });
}));

// GET /tg/santa/campaigns/:id/reveal — receiver reveals their Secret Santa identity
// Batch 3: gate is per-receiver RECEIVED (NOT campaign COMPLETED). Tracks revealedAt on first view.
// ANONYMITY: giver identity ONLY exposed after receiver's own giftStatus === RECEIVED.
tgRouter.get('/santa/campaigns/:id/reveal', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { status: true, currentRoundId: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!['ACTIVE', 'COMPLETED'].includes(campaign.status)) {
    return res.status(409).json({ error: 'reveal_not_available', campaignStatus: campaign.status });
  }
  if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });
  const roundId = campaign.currentRoundId;

  // Receiver-side lookup — assignment is resolved from the receiver's participant record
  const receiverAssignment = await prisma.santaAssignment.findUnique({
    where: { roundId_receiverParticipantId: { roundId, receiverParticipantId: participant.id } },
    select: {
      id: true,
      giftStatus: true,
      revealedAt: true,
      giftNote: true,
      giver: {
        select: {
          id: true,   // needed for alias lookup
        },
      },
    },
  });

  if (!receiverAssignment) {
    return res.status(409).json({ error: 'reveal_not_available', reason: 'no_assignment' });
  }

  // Gate: receiver must have confirmed RECEIVED — personal reveal, not campaign-level
  if (receiverAssignment.giftStatus !== 'RECEIVED') {
    return res.status(409).json({
      error: 'reveal_not_available',
      reason: 'gift_not_received',
      signal: giftStatusToInboundSignal(receiverAssignment.giftStatus),
    });
  }

  // Track first reveal view — best-effort, non-blocking
  const isFirstReveal = !receiverAssignment.revealedAt;
  if (isFirstReveal) {
    await prisma.santaAssignment.update({
      where: { id: receiverAssignment.id },
      data: { revealedAt: new Date() },
    }).catch(() => { /* non-fatal — revealedAt is cosmetic tracking */ });
  }

  // Reveal stays alias-only forever — no real identity disclosed, not even post-reveal
  const aliasMap = await loadSantaAliasMap(roundId);
  const giverAlias = resolveSantaAlias(aliasMap, receiverAssignment.giver.id);

  return res.json({
    revealed: true,
    isFirstReveal,
    giver: {
      displayName: giverAlias.alias,   // alias — real name never exposed
      avatarUrl: null,                  // never expose real photo
      emoji: giverAlias.emoji,
      adjectiveKey: giverAlias.adjectiveKey,
      animalKey: giverAlias.animalKey,
    },
    giftNote: receiverAssignment.giftNote ?? null,
    revealedAt: receiverAssignment.revealedAt?.toISOString() ?? new Date().toISOString(),
  });
}));

// ─── Santa Hints (Batch 2.5) ──────────────────────────────────────────────────

const SANTA_HINT_TTL_HOURS = 48;
const SANTA_HINT_MAX_ITEMS = 3;

// Serializer: giver side — exposes selection results, NEVER receiver identity
type SantaHintForGiver = {
  id: string;
  status: string;
  requestedAt: string;
  expiresAt: string;
  fulfilledAt: string | null;
  // null until FULFILLED; array of item shapes after receiver selects
  selectedItems: { id: string; title: string; priceText: string | null; url: string | null }[] | null;
};

function serializeSantaHintForGiver(
  hint: { id: string; status: string; requestedAt: Date; expiresAt: Date; fulfilledAt: Date | null; selectedItemIds: unknown },
  itemsMap?: Map<string, { id: string; title: string; priceText: string | null; url: string | null }>,
): SantaHintForGiver {
  let selectedItems: { id: string; title: string; priceText: string | null; url: string | null }[] | null = null;
  if (hint.status === 'FULFILLED' && Array.isArray(hint.selectedItemIds)) {
    selectedItems = (hint.selectedItemIds as string[])
      .map(id => itemsMap?.get(id))
      .filter((item): item is { id: string; title: string; priceText: string | null; url: string | null } => item !== undefined);
  }
  return {
    id: hint.id,
    status: hint.status,
    requestedAt: hint.requestedAt.toISOString(),
    expiresAt: hint.expiresAt.toISOString(),
    fulfilledAt: hint.fulfilledAt?.toISOString() ?? null,
    selectedItems,
    // ⚠ receiverParticipantId / receiverUserId deliberately omitted — anonymity contract
  };
}

// Serializer: receiver side — exposes request metadata, NEVER giver identity
type SantaHintInboundForReceiver = {
  hasPendingHint: boolean;
  hint: { id: string; status: string; requestedAt: string; expiresAt: string } | null;
};

function serializeSantaHintInboundForReceiver(
  hint: { id: string; status: string; requestedAt: Date; expiresAt: Date } | null,
): SantaHintInboundForReceiver {
  if (!hint) return { hasPendingHint: false, hint: null };
  return {
    hasPendingHint: hint.status === 'PENDING',
    hint: {
      id: hint.id,
      status: hint.status,
      requestedAt: hint.requestedAt.toISOString(),
      expiresAt: hint.expiresAt.toISOString(),
      // ⚠ giverParticipantId / giverUserId deliberately omitted — anonymity contract
    },
  };
}

// POST /tg/santa/campaigns/:id/hints — giver requests a hint (idempotent; PRO-gated)
tgRouter.post('/santa/campaigns/:id/hints', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  // 1. Participant lookup
  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

  // 2. Campaign must be ACTIVE
  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { status: true, currentRoundId: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'campaign_not_active', message: 'Hint requests can only be sent in ACTIVE campaigns' });
  if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });
  const roundId = campaign.currentRoundId;

  // 3. PRO-gate: only giver's effective plan is checked — receiver's plan is irrelevant
  const ent = await getUserEntitlement(user.id, user.godMode);
  if (!ent.isPro) return res.status(403).json({ error: 'pro_required', message: 'Hint requests require a Pro subscription' });

  // 4. Resolve giver's assignment (giver-centric: roundId + giverParticipantId)
  const assignment = await prisma.santaAssignment.findUnique({
    where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
    select: { id: true, receiverParticipantId: true, receiver: { select: { linkedWishlistId: true } } },
  });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  // 5. Receiver must have a linked wishlist — no point in requesting a hint otherwise
  if (!assignment.receiver.linkedWishlistId) {
    return res.status(409).json({ error: 'receiver_no_wishlist', message: 'Your gift recipient has no linked wishlist' });
  }

  // 6. Idempotency: if PENDING hint already exists for this assignment, return it (don't duplicate)
  const existing = await prisma.santaHintRequest.findFirst({
    where: { assignmentId: assignment.id, status: 'PENDING' },
  });
  if (existing) {
    return res.status(200).json(serializeSantaHintForGiver(existing));
  }

  // 7. Create hint request with 48h TTL
  const expiresAt = new Date(Date.now() + SANTA_HINT_TTL_HOURS * 60 * 60 * 1000);
  const hint = await prisma.santaHintRequest.create({
    data: {
      campaignId,
      roundId,
      assignmentId: assignment.id,
      giverParticipantId: participant.id,
      receiverParticipantId: assignment.receiverParticipantId,
      status: 'PENDING',
      expiresAt,
    },
  });

  // Notification to receiver is sent by the TTL/polling loop or bot layer.
  // notificationSentAt is set by the notification sender — not here — to allow dedup on retry.

  return res.status(201).json(serializeSantaHintForGiver(hint));
}));

// GET /tg/santa/campaigns/:id/hints — giver polls hint status (includes fulfilled item preview)
tgRouter.get('/santa/campaigns/:id/hints', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { status: true, currentRoundId: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!['ACTIVE', 'COMPLETED'].includes(campaign.status)) return res.status(409).json({ error: 'Campaign not ACTIVE or COMPLETED' });
  if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });
  const roundId = campaign.currentRoundId;

  // Giver-centric assignment lookup
  const assignment = await prisma.santaAssignment.findUnique({
    where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
    select: { id: true },
  });
  if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

  // Most recent hint for this assignment (draw reset via cascade-delete clears old hints)
  const hint = await prisma.santaHintRequest.findFirst({
    where: { assignmentId: assignment.id },
    orderBy: { requestedAt: 'desc' },
  });
  if (!hint) return res.json({ hint: null });

  // Resolve item details for FULFILLED hints
  let itemsMap: Map<string, { id: string; title: string; priceText: string | null; url: string | null }> | undefined;
  if (hint.status === 'FULFILLED' && Array.isArray(hint.selectedItemIds) && hint.selectedItemIds.length > 0) {
    const ids = hint.selectedItemIds as string[];
    const items = await prisma.item.findMany({
      where: { id: { in: ids } },
      select: { id: true, title: true, priceText: true, url: true },
    });
    itemsMap = new Map(items.map(i => [i.id, i]));
  }

  return res.json({ hint: serializeSantaHintForGiver(hint, itemsMap) });
}));

// GET /tg/santa/campaigns/:id/inbound/hint — receiver checks for pending hint request
// Role: receiver only. Anonymity: NEVER exposes giverParticipantId or giverUserId.
tgRouter.get('/santa/campaigns/:id/inbound/hint', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { status: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Campaign not ACTIVE' });

  // Campaign-centric receiver lookup — receiverParticipantId, never assignmentId
  // Returns the most recently created PENDING hint (there should be at most one per assignment,
  // but we guard against duplicates by taking the latest)
  const hint = await prisma.santaHintRequest.findFirst({
    where: { campaignId, receiverParticipantId: participant.id, status: 'PENDING' },
    orderBy: { requestedAt: 'desc' },
  });

  return res.json(serializeSantaHintInboundForReceiver(hint));
}));

// POST /tg/santa/campaigns/:id/inbound/hint/fulfill — receiver selects 1–3 items, marks hint FULFILLED
tgRouter.post('/santa/campaigns/:id/inbound/hint/fulfill', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const parsed = z.object({
    hintId: z.string().min(1),
    selectedItemIds: z.array(z.string().min(1)).min(1).max(SANTA_HINT_MAX_ITEMS),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });

  const { hintId, selectedItemIds } = parsed.data;

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
    select: { id: true, status: true, linkedWishlistId: true },
  });
  if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { status: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Campaign not ACTIVE' });

  // Fetch hint — must belong to this receiver and be PENDING
  const hint = await prisma.santaHintRequest.findUnique({
    where: { id: hintId },
    select: { id: true, campaignId: true, receiverParticipantId: true, status: true, expiresAt: true },
  });
  if (!hint) return res.status(404).json({ error: 'Hint not found' });
  // Verify ownership (campaignId + receiverParticipantId) — never trust hintId alone
  if (hint.campaignId !== campaignId) return res.status(404).json({ error: 'Hint not found' });
  if (hint.receiverParticipantId !== participant.id) return res.status(403).json({ error: 'Forbidden' });
  if (hint.status !== 'PENDING') return res.status(409).json({ error: 'hint_not_pending', message: `Hint status is ${hint.status}` });
  if (hint.expiresAt <= new Date()) return res.status(409).json({ error: 'hint_expired', message: 'Hint TTL exceeded; request a new one' });

  // Receiver must have a linked wishlist to select from
  if (!participant.linkedWishlistId) {
    return res.status(409).json({ error: 'no_linked_wishlist', message: 'Link a wishlist to your Secret Santa profile first' });
  }

  // Validate: all selectedItemIds must belong to receiver's current linked wishlist and be AVAILABLE
  // This guards against stale selections (wishlist changed between request and fulfill)
  const validItems = await prisma.item.findMany({
    where: { id: { in: selectedItemIds }, wishlistId: participant.linkedWishlistId, status: 'AVAILABLE' },
    select: { id: true },
  });
  if (validItems.length !== selectedItemIds.length) {
    return res.status(400).json({
      error: 'invalid_items',
      message: 'Some selected items are not available in your linked wishlist',
    });
  }

  // Mark FULFILLED
  await prisma.santaHintRequest.update({
    where: { id: hintId },
    data: { status: 'FULFILLED', selectedItemIds, fulfilledAt: new Date() },
  });

  // Notify giver — deduped via notificationSentAt on the hint record (handled by bot polling layer)

  return res.json({ ok: true });
}));

// ── Telemetry ingestion ─────────────────────────────────
// Accept events matching known product-area prefixes + a small exact-match list.
// This keeps a defensive boundary (rejects random junk) while staying resilient to
// frontend additions: a new event with a known prefix flows through without a backend
// deploy. Unknown events are dropped per-event — we never reject the whole batch,
// because Zod all-or-nothing rejection masked ~40 telemetry 400s/day after 2026-04-13.
const ANALYTICS_EVENT_PREFIXES = [
  'miniapp.', 'miniapp_',
  'showcase.', 'public_profile.',
  'onboarding.', 'onboarding_',
  'feature_gate_hit_', 'demo_item_',
  'gift_notes_', 'gift_occasion_',
  'first_share_prompt_', 'ready_share_prompt_',
  'group_gift_', 'addon_', 'category_', 'checkout_',
  'comment_reply_', 'dont_gift_', 'item_',
  'profile_', 'promo_winback_', 'selection_',
  'settings_support_', 'subscription_', 'banner_',
  'wishlist_', 'share_token_',
  'wish.', 'wishlist.', 'import.', 'reservation.',
  'guest.', 'bot.', 'payment.', 'share.',
  'lifecycle_',
];
const ANALYTICS_EVENT_EXACT = new Set<string>([
  'api_server_error', 'pro_cta_clicked', 'error_boundary_triggered',
]);
function isAllowedAnalyticsEvent(event: string): boolean {
  if (event.length === 0 || event.length > 80) return false;
  if (ANALYTICS_EVENT_EXACT.has(event)) return true;
  return ANALYTICS_EVENT_PREFIXES.some(p => event.startsWith(p));
}

const telemetryEventSchema = z.object({
  event: z.string().min(1).max(80),
  ts: z.number(),
  props: z.record(z.unknown()).optional(),
});

const telemetryBodySchema = z.object({
  events: z.array(telemetryEventSchema).max(20),
});

const telemetryLimiter = rateLimit({
  windowMs: 60_000,
  max: 5,
  keyGenerator: (req) => (req as Request & { tgUser?: { id?: number } }).tgUser?.id?.toString() || req.ip || 'unknown',
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
});

tgRouter.post('/telemetry', telemetryLimiter, asyncHandler(async (req, res) => {
  const parsed = telemetryBodySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid telemetry payload', issues: parsed.error.issues });
  }

  const userId = req.tgUser?.id ? String(req.tgUser.id) : null;
  const now = Date.now();
  const oneHourAgo = now - 3_600_000;

  // Per-event filter: drop events that don't match the allowlist rather than
  // rejecting the whole batch. One unknown event used to 400 the entire request
  // and caused silent analytics loss on the frontend (catch {} in flushTelemetry).
  const accepted: typeof parsed.data.events = [];
  const droppedNames: string[] = [];
  for (const ev of parsed.data.events) {
    if (isAllowedAnalyticsEvent(ev.event)) accepted.push(ev);
    else droppedNames.push(ev.event);
  }
  if (droppedNames.length > 0) {
    logger.debug({ dropped: droppedNames, userId }, 'telemetry: dropped unknown events');
  }

  const records = accepted.map(ev => {
    // Clamp timestamp to last hour
    const ts = Math.max(oneHourAgo, Math.min(now, ev.ts));
    // Truncate props
    let props: Record<string, unknown> = ev.props || {};
    for (const [key, val] of Object.entries(props)) {
      if (typeof val === 'string' && val.length > 300) {
        props[key] = val.slice(0, 300) + '...';
      }
    }
    const serialized = JSON.stringify(props);
    if (serialized.length > 1024) {
      props = { _truncated: true, event: ev.event };
    }
    return {
      event: ev.event,
      userId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      props: props as any,
      createdAt: new Date(ts),
    };
  });

  // Batch insert
  if (records.length > 0) {
    await prisma.analyticsEvent.createMany({ data: records });
  }

  return res.json({ ok: true, accepted: records.length, dropped: droppedNames.length });
}));

// POST /tg/analytics/attribution — First-touch source attribution.
// Records firstAcquisitionSource/Medium/Campaign/Ref/At on UserProfile.
// First-touch only: atomically sets fields only when firstAcquisitionSource IS NULL — never overwrites.
// Returns { attributed: boolean } — true if this was the first (winning) attribution call.
tgRouter.post('/analytics/attribution', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);

  const raw = req.body as Record<string, unknown>;

  // Sanitize: allow only alphanumeric, underscore, hyphen; truncate to 64 chars
  const sanitize = (val: unknown, maxLen = 64): string | null => {
    if (typeof val !== 'string' || !val.trim()) return null;
    const clean = val.replace(/[^a-z0-9_\-]/gi, '_').slice(0, maxLen);
    return clean || null;
  };

  const source = sanitize(raw.source);
  if (!source) return res.status(400).json({ error: 'source is required and must be a non-empty string' });

  const updated = await prisma.userProfile.updateMany({
    where: { userId: user.id, firstAcquisitionSource: null },
    data: {
      firstAcquisitionSource: source,
      firstAcquisitionMedium: sanitize(raw.medium),
      firstAcquisitionCampaign: sanitize(raw.campaign),
      firstAcquisitionRef: sanitize(raw.ref),
      firstAcquisitionAt: new Date(),
    },
  });

  return res.json({ attributed: updated.count > 0 });
}));

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

// POST /tg/maintenance-exposure — record that the current user saw the maintenance screen.
// This endpoint is exempted from the maintenance middleware so it works during outages.
tgRouter.post(
  '/maintenance-exposure',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const locale = (req.body?.locale as string) || 'ru';
    const surface = (req.body?.surface as string) || 'miniapp';
    const incidentId = await recordMaintenanceExposure(
      user.id,
      surface,
      locale,
      user.telegramChatId ?? null,
    );
    return res.json({ ok: true, incidentId });
  }),
);

// POST /tg/maintenance-return — mark user as returned after recovery (lightweight, best-effort)
tgRouter.post(
  '/maintenance-return',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const surface = (req.body?.surface as string) || 'miniapp';

    // Find the most recently recovered incident with unreturned exposure for this user
    const exposure = await prisma.maintenanceExposure.findFirst({
      where: {
        userId: user.id,
        surface,
        returnedAt: null,
        incident: { status: 'recovered', recoveryConfirmedAt: { not: null } },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!exposure) return res.json({ marked: false });

    await prisma.maintenanceExposure.update({
      where: { id: exposure.id },
      data: { returnedAt: new Date() },
    });

    const wasNotified = !!exposure.notifiedAt;
    trackEvent(wasNotified ? 'maintenance_returned_after_notice' : 'maintenance_returned_without_notice', user.id, {
      incidentId: exposure.incidentId,
      ...(wasNotified && exposure.notifiedAt ? { timeFromNoticeSec: Math.round((Date.now() - exposure.notifiedAt.getTime()) / 1000) } : {}),
    });

    return res.json({ marked: true });
  }),
);

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

// Helper: createSystemMessage — creates a SYSTEM message in the campaign chat.
// Called at lifecycle events (join, leave, remove, draw, cancel, complete).
// NEVER includes userId, participantId, or Santa pair data in payload.
async function createSystemMessage(
  campaignId: string,
  systemEvent: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  // Find campaign owner's participant record to use as the pseudo-sender for system messages.
  // If not found (owner left, edge case), skip silently.
  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { ownerId: true },
  });
  if (!campaign) return;
  const ownerParticipant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: campaign.ownerId },
    select: { id: true },
  });
  if (!ownerParticipant) return;

  await prisma.santaChatMessage.create({
    data: {
      campaignId,
      participantId: ownerParticipant.id,
      body: '',         // empty for SYSTEM; body is reserved for USER plaintext
      messageType: 'SYSTEM',
      systemEvent,
      payload: payload as Parameters<typeof prisma.santaChatMessage.create>[0]['data']['payload'],
    },
  }).catch(() => {}); // non-blocking; system message failures never surface to caller
}

// Serializer for a single chat message (role-aware, never leaks participantId)
function serializeChatMessage(
  msg: {
    id: string;
    messageType: string;
    body: string;
    systemEvent: string | null;
    payload: unknown;
    createdAt: Date;
    participantId: string;
    participant: {
      userId: string;
      user: { firstName: string | null; profile: { displayName: string | null; avatarUrl: string | null } | null };
    };
  },
  myUserId: string,
  aliasMap: SantaAliasMap,
) {
  const isSystem = msg.messageType === 'SYSTEM';
  // Strip any real-name fields from system message payload (legacy messages may contain displayName)
  let safePayload: unknown = null;
  if (isSystem && msg.payload && typeof msg.payload === 'object') {
    const { displayName: _stripped, avatarUrl: _strippedUrl, ...rest } = msg.payload as Record<string, unknown>;
    safePayload = rest;
  } else if (isSystem) {
    safePayload = msg.payload ?? null;
  }
  const senderAlias = resolveSantaAlias(aliasMap, msg.participantId);
  return {
    id: msg.id,
    messageType: msg.messageType as 'USER' | 'SYSTEM',
    body: isSystem ? '' : msg.body,
    systemEvent: isSystem ? (msg.systemEvent ?? null) : null,
    payload: safePayload,
    sender: isSystem
      ? null
      : {
          displayName: senderAlias.alias,
          avatarUrl: null,
          emoji: senderAlias.emoji,
          adjectiveKey: senderAlias.adjectiveKey,
          animalKey: senderAlias.animalKey,
          isMe: msg.participant.userId === myUserId,
        },
    createdAt: msg.createdAt.toISOString(),
  };
}

// GET /tg/santa/campaigns/:id/chat — list messages (keyset pagination)
// Read access: JOINED or LEFT participants only (REMOVED cannot read; owner via participant record)
tgRouter.get('/santa/campaigns/:id/chat', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const participant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: user.id },
    select: { id: true, status: true },
  });
  // REMOVED participants cannot read chat history
  if (!participant || participant.status === 'REMOVED') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const rawLimit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 100);
  const before = typeof req.query.before === 'string' ? req.query.before : null;

  // Keyset pagination: resolve cursor message's (createdAt, id) for stable compound comparison
  let cursorCreatedAt: Date | null = null;
  let cursorId: string | null = null;
  if (before) {
    const cursorMsg = await prisma.santaChatMessage.findUnique({
      where: { id: before },
      select: { createdAt: true, id: true },
    });
    if (cursorMsg) {
      cursorCreatedAt = cursorMsg.createdAt;
      cursorId = cursorMsg.id;
    }
  }

  // Load alias map for current round (chat always uses aliases)
  const chatCampaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { currentRoundId: true },
  });
  const chatAliasMap = chatCampaign?.currentRoundId
    ? await loadSantaAliasMap(chatCampaign.currentRoundId)
    : new Map<string, SantaAliasRecord>();

  const messages = await prisma.santaChatMessage.findMany({
    where: {
      campaignId,
      ...(cursorCreatedAt && cursorId
        ? {
            OR: [
              { createdAt: { lt: cursorCreatedAt } },
              { createdAt: cursorCreatedAt, id: { lt: cursorId } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: rawLimit + 1,
    select: {
      id: true, messageType: true, body: true, systemEvent: true, payload: true, createdAt: true,
      participantId: true,
      participant: {
        select: {
          userId: true,
          user: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
        },
      },
    },
  });

  const hasMore = messages.length > rawLimit;
  if (hasMore) messages.pop();

  // Unread count (keyset-consistent with read cursor)
  const chatCursor = await prisma.santaChatReadCursor.findUnique({
    where: { campaignId_participantId: { campaignId, participantId: participant.id } },
    select: { lastReadMessageId: true },
  });
  let totalUnread = 0;
  if (!chatCursor?.lastReadMessageId) {
    totalUnread = await prisma.santaChatMessage.count({ where: { campaignId } });
  } else {
    const lastRead = await prisma.santaChatMessage.findUnique({
      where: { id: chatCursor.lastReadMessageId },
      select: { createdAt: true, id: true },
    });
    if (lastRead) {
      totalUnread = await prisma.santaChatMessage.count({
        where: {
          campaignId,
          OR: [
            { createdAt: { gt: lastRead.createdAt } },
            { createdAt: lastRead.createdAt, id: { gt: lastRead.id } },
          ],
        },
      });
    } else {
      totalUnread = await prisma.santaChatMessage.count({ where: { campaignId } });
    }
  }

  const isMuted = !!(await prisma.santaChatMute.findUnique({
    where: { campaignId_participantId: { campaignId, participantId: participant.id } },
    select: { id: true },
  }));

  return res.json({
    messages: messages.map(m => serializeChatMessage(m, user.id, chatAliasMap)),
    hasMore,
    totalUnread,
    isMuted,
  });
}));

// POST /tg/santa/campaigns/:id/chat — send a user message
// Write access: JOINED participants only + campaign in (OPEN, LOCKED, ACTIVE)
tgRouter.post('/santa/campaigns/:id/chat', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const parsed = z.object({
    body: z.string().min(1).max(1000),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { status: true, currentRoundId: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!['OPEN', 'LOCKED', 'ACTIVE'].includes(campaign.status)) {
    return res.status(409).json({ error: 'Chat is read-only for this campaign status' });
  }

  const participant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: user.id },
    select: { id: true, status: true },
  });
  if (!participant || participant.status !== 'JOINED') {
    return res.status(403).json({ error: 'Only joined participants can send messages' });
  }

  const msg = await prisma.santaChatMessage.create({
    data: {
      campaignId,
      participantId: participant.id,
      body: parsed.data.body,
      messageType: 'USER',
    },
    select: {
      id: true, messageType: true, body: true, systemEvent: true, payload: true, createdAt: true,
      participantId: true,
      participant: {
        select: {
          userId: true,
          user: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
        },
      },
    },
  });

  // Load alias map for response serialization
  const sendAliasMap = campaign.currentRoundId
    ? await loadSantaAliasMap(campaign.currentRoundId)
    : new Map<string, SantaAliasRecord>();
  const senderAlias = resolveSantaAlias(sendAliasMap, participant.id);

  // CHAT_MESSAGE notification — batch, non-blocking, mute-aware
  void (async () => {
    try {
      const [joinedParticipants, mutedEntries] = await Promise.all([
        prisma.santaParticipant.findMany({
          where: { campaignId, status: 'JOINED' },
          select: { id: true, userId: true },
        }),
        prisma.santaChatMute.findMany({ where: { campaignId }, select: { participantId: true } }),
      ]);
      const mutedIds = new Set(mutedEntries.map(m => m.participantId));

      const notifData = joinedParticipants
        .filter(p => p.userId !== user.id && !mutedIds.has(p.id))
        .map(p => ({
          campaignId,
          userId: p.userId,
          type: 'CHAT_MESSAGE' as const,
          payload: { messageId: msg.id, senderName: senderAlias.alias },
        }));
      if (notifData.length > 0) {
        await prisma.santaNotification.createMany({ data: notifData, skipDuplicates: false });
      }
    } catch {}
  })();

  return res.json({ message: serializeChatMessage(msg, user.id, sendAliasMap) });
}));

// POST /tg/santa/campaigns/:id/chat/read — mark messages as read (upsert cursor)
tgRouter.post('/santa/campaigns/:id/chat/read', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const parsed = z.object({
    lastReadMessageId: z.string().min(1),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const participant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: user.id },
    select: { id: true, status: true },
  });
  if (!participant || participant.status === 'REMOVED') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Verify the referenced message exists in this campaign
  const msgExists = await prisma.santaChatMessage.findFirst({
    where: { id: parsed.data.lastReadMessageId, campaignId },
    select: { id: true },
  });
  if (!msgExists) return res.status(404).json({ error: 'Message not found' });

  await prisma.santaChatReadCursor.upsert({
    where: { campaignId_participantId: { campaignId, participantId: participant.id } },
    update: { lastReadMessageId: parsed.data.lastReadMessageId, lastReadAt: new Date() },
    create: {
      campaignId,
      participantId: participant.id,
      lastReadMessageId: parsed.data.lastReadMessageId,
      lastReadAt: new Date(),
    },
  });

  return res.json({ ok: true });
}));

// POST /tg/santa/campaigns/:id/mute — mute chat notifications for this campaign
tgRouter.post('/santa/campaigns/:id/mute', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const participant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: user.id },
    select: { id: true, status: true },
  });
  if (!participant || participant.status !== 'JOINED') {
    return res.status(403).json({ error: 'Only joined participants can mute' });
  }

  await prisma.santaChatMute.upsert({
    where: { campaignId_participantId: { campaignId, participantId: participant.id } },
    update: { mutedAt: new Date() },
    create: { campaignId, participantId: participant.id },
  });

  return res.json({ ok: true, isMuted: true });
}));

// DELETE /tg/santa/campaigns/:id/mute — unmute chat notifications
tgRouter.delete('/santa/campaigns/:id/mute', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const participant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: user.id },
    select: { id: true, status: true },
  });
  if (!participant || participant.status !== 'JOINED') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  await prisma.santaChatMute.deleteMany({
    where: { campaignId, participantId: participant.id },
  });

  return res.json({ ok: true, isMuted: false });
}));

// ─── Batch 4.2: Santa Campaign Polls ─────────────────────────────────────────

// Serializer for a poll (role-aware, anonymous policy enforced)
function serializePoll(
  poll: {
    id: string;
    question: string;
    options: unknown;
    isAnonymous: boolean;
    createdAt: Date;
    deadlineAt: Date | null;
    closedAt: Date | null;
    votes: { optionIndex: number; participantId: string; participant: { userId: string; user: { firstName: string | null; profile: { displayName: string | null } | null } } }[];
  },
  myParticipantId: string,
  isOwner: boolean,
  aliasMap: SantaAliasMap,
) {
  const options = (poll.options as string[]);
  const now = new Date();
  const isOpen = !poll.closedAt && (!poll.deadlineAt || poll.deadlineAt > now);
  const myVoteEntry = poll.votes.find(v => v.participantId === myParticipantId);
  const myVote = myVoteEntry ? myVoteEntry.optionIndex : null;

  // Tally results
  const counts = new Array<number>(options.length).fill(0);
  for (const v of poll.votes) counts[v.optionIndex] = (counts[v.optionIndex] ?? 0) + 1;
  const total = poll.votes.length;

  const results = options.map((_, idx) => {
    const count = counts[idx] ?? 0;
    const percentage = total > 0 ? Math.round((count / total) * 100) : 0;
    // voters: always null for anonymous polls; show aliases (not real names) for public polls
    const voters = poll.isAnonymous
      ? null
      : poll.votes
          .filter(v => v.optionIndex === idx)
          .map(v => {
            const va = resolveSantaAlias(aliasMap, v.participantId);
            return { displayName: va.alias, emoji: va.emoji };
          });
    return { optionIndex: idx, count, percentage, voters };
  });

  return {
    id: poll.id,
    question: poll.question,
    options,
    isAnonymous: poll.isAnonymous,
    createdAt: poll.createdAt.toISOString(),
    deadlineAt: poll.deadlineAt ? poll.deadlineAt.toISOString() : null,
    closedAt: poll.closedAt ? poll.closedAt.toISOString() : null,
    isOpen,
    myVote,
    results,
  };
}

const POLL_SELECT = {
  id: true, question: true, options: true, isAnonymous: true, createdAt: true,
  deadlineAt: true, closedAt: true,
  votes: {
    select: {
      optionIndex: true, participantId: true,
      participant: { select: { userId: true, user: { select: { firstName: true, profile: { select: { displayName: true } } } } } },
    },
  },
} as const;

// GET /tg/santa/campaigns/:id/polls — list all polls for this campaign
tgRouter.get('/santa/campaigns/:id/polls', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const participant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: user.id },
    select: { id: true, status: true, userId: true },
  });
  if (!participant || participant.status === 'REMOVED') {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, currentRoundId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  const isOwner = campaign.ownerId === user.id;

  const pollAliasMap = campaign.currentRoundId
    ? await loadSantaAliasMap(campaign.currentRoundId)
    : new Map<string, SantaAliasRecord>();

  const polls = await prisma.santaPoll.findMany({
    where: { campaignId },
    orderBy: { createdAt: 'desc' },
    select: POLL_SELECT,
  });

  return res.json({ polls: polls.map(p => serializePoll(p, participant.id, isOwner, pollAliasMap)) });
}));

// POST /tg/santa/campaigns/:id/polls — create poll (owner only, campaign ACTIVE)
tgRouter.post('/santa/campaigns/:id/polls', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

  const parsed = z.object({
    question: z.string().min(1).max(300),
    options: z.array(z.string().min(1).max(100)).min(2).max(10),
    isAnonymous: z.boolean(),
    deadlineAt: z.string().datetime().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { ownerId: true, status: true, currentRoundId: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Polls can only be created in ACTIVE campaigns' });

  const myParticipant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: user.id, status: 'JOINED' },
    select: { id: true, status: true, role: true },
  });
  if (!isOrganizer(campaign, user.id, myParticipant)) return res.status(403).json({ error: 'Only organizers can create polls' });
  if (!myParticipant) return res.status(403).json({ error: 'Organizer must be a participant to create polls' });

  const poll = await prisma.santaPoll.create({
    data: {
      campaignId,
      question: parsed.data.question,
      options: parsed.data.options,
      isAnonymous: parsed.data.isAnonymous,
      createdByParticipantId: myParticipant.id,
      deadlineAt: parsed.data.deadlineAt ? new Date(parsed.data.deadlineAt) : null,
    },
    select: POLL_SELECT,
  });

  // System message: poll created (in chat)
  void createSystemMessage(campaignId, 'poll_created', { question: parsed.data.question.slice(0, 80) }).catch(() => {});

  // POLL_CREATED notifications — batch, mute-aware
  void (async () => {
    try {
      const [joinedParticipants, mutedEntries] = await Promise.all([
        prisma.santaParticipant.findMany({ where: { campaignId, status: 'JOINED' }, select: { id: true, userId: true } }),
        prisma.santaChatMute.findMany({ where: { campaignId }, select: { participantId: true } }),
      ]);
      const mutedIds = new Set(mutedEntries.map(m => m.participantId));
      const notifData = joinedParticipants
        .filter(p => p.userId !== user.id && !mutedIds.has(p.id))
        .map(p => ({ campaignId, userId: p.userId, type: 'POLL_CREATED' as const, payload: { pollId: poll.id } }));
      if (notifData.length > 0) {
        await prisma.santaNotification.createMany({ data: notifData, skipDuplicates: false });
      }
    } catch {}
  })();

  const createPollAliasMap = campaign.currentRoundId
    ? await loadSantaAliasMap(campaign.currentRoundId)
    : new Map<string, SantaAliasRecord>();
  return res.status(201).json({ poll: serializePoll(poll, myParticipant.id, true, createPollAliasMap) });
}));

// POST /tg/santa/campaigns/:id/polls/:pollId/vote — vote on a poll
tgRouter.post('/santa/campaigns/:id/polls/:pollId/vote', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const pollId = req.params.pollId ?? '';
  if (!campaignId || !pollId) return res.status(400).json({ error: 'Missing params' });

  const parsed = z.object({ optionIndex: z.number().int().min(0) }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const participant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: user.id, status: 'JOINED' },
    select: { id: true },
  });
  if (!participant) return res.status(403).json({ error: 'Only joined participants can vote' });

  const poll = await prisma.santaPoll.findUnique({ where: { id: pollId, campaignId }, select: POLL_SELECT });
  if (!poll) return res.status(404).json({ error: 'Poll not found' });

  const options = poll.options as string[];
  if (parsed.data.optionIndex < 0 || parsed.data.optionIndex >= options.length) {
    return res.status(400).json({ error: 'invalid_option_index', message: `optionIndex must be 0–${options.length - 1}` });
  }

  const now = new Date();
  if (poll.closedAt || (poll.deadlineAt && poll.deadlineAt <= now)) {
    return res.status(409).json({ error: 'Poll is closed' });
  }

  // Already voted?
  const existing = poll.votes.find(v => v.participantId === participant.id);
  if (existing) return res.status(409).json({ error: 'already_voted', message: 'You have already voted on this poll' });

  await prisma.santaPollVote.create({
    data: { pollId, participantId: participant.id, optionIndex: parsed.data.optionIndex },
  });

  // Re-fetch poll with updated votes
  const updatedPoll = await prisma.santaPoll.findUnique({ where: { id: pollId }, select: POLL_SELECT });
  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, currentRoundId: true } });
  const isOwner = campaign?.ownerId === user.id;
  const votePollAliasMap = campaign?.currentRoundId
    ? await loadSantaAliasMap(campaign.currentRoundId)
    : new Map<string, SantaAliasRecord>();

  return res.json({ poll: serializePoll(updatedPoll!, participant.id, isOwner, votePollAliasMap) });
}));

// POST /tg/santa/campaigns/:id/polls/:pollId/close — close a poll (owner only)
tgRouter.post('/santa/campaigns/:id/polls/:pollId/close', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const pollId = req.params.pollId ?? '';
  if (!campaignId || !pollId) return res.status(400).json({ error: 'Missing params' });

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, currentRoundId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Only organizers can close polls' });

  const poll = await prisma.santaPoll.findUnique({ where: { id: pollId, campaignId }, select: { id: true, closedAt: true } });
  if (!poll) return res.status(404).json({ error: 'Poll not found' });

  // Idempotent: already closed → just return current state
  if (!poll.closedAt) {
    await prisma.santaPoll.update({ where: { id: pollId }, data: { closedAt: new Date() } });
  }

  const myParticipant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: user.id },
    select: { id: true },
  });

  const closePollAliasMap = campaign.currentRoundId
    ? await loadSantaAliasMap(campaign.currentRoundId)
    : new Map<string, SantaAliasRecord>();
  const updatedPoll = await prisma.santaPoll.findUnique({ where: { id: pollId }, select: POLL_SELECT });
  return res.json({ poll: serializePoll(updatedPoll!, myParticipant?.id ?? '', true, closePollAliasMap) });
}));

// ─── Batch 5.3: Roles + Organizer Controls + Exit Request Flow ────────────────

// PATCH /tg/santa/campaigns/:id/participants/:userId/role — change participant role (owner only)
// Admin role cannot be delegated by another admin — owner only.
tgRouter.patch('/santa/campaigns/:id/participants/:userId/role', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const targetUserId = req.params.userId ?? '';

  const parsed = z.object({
    role: z.enum(['PARTICIPANT', 'ADMIN']),
  }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, status: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  // Owner only — admins cannot promote/demote other participants
  if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can change roles' });
  if (['COMPLETED', 'CANCELLED'].includes(campaign.status)) return res.status(409).json({ error: 'Campaign is finished' });
  // Owner cannot change their own role (they own the campaign, role is irrelevant)
  if (targetUserId === user.id) return res.status(400).json({ error: 'Cannot change your own role' });

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: targetUserId } },
    select: { id: true, status: true, role: true },
  });
  if (!participant) return res.status(404).json({ error: 'Participant not found' });
  if (participant.status === 'REMOVED' || participant.status === 'LEFT') return res.status(409).json({ error: 'Cannot change role of a participant who has left or been removed' });

  const updated = await prisma.santaParticipant.update({
    where: { id: participant.id },
    data: { role: parsed.data.role },
    select: { id: true, userId: true, role: true, status: true },
  });
  await prisma.santaAdminAuditLog.create({
    data: { campaignId, actorId: user.id, action: 'role_changed', payload: { targetUserId, newRole: parsed.data.role } },
  });

  return res.json({ ok: true, participant: { id: updated.id, userId: updated.userId, role: updated.role, status: updated.status } });
}));

// GET /tg/santa/campaigns/:id/organizer/summary — rich stats for organizer (organizer only)
tgRouter.get('/santa/campaigns/:id/organizer/summary', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { ownerId: true, status: true, currentRoundId: true, drawAt: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

  // Participants
  const participants = await prisma.santaParticipant.findMany({
    where: { campaignId },
    select: {
      id: true,
      userId: true,
      status: true,
      role: true,
      joinedAt: true,
      leftAt: true,
      linkedWishlistId: true,
    },
    orderBy: { joinedAt: 'asc' },
  });

  // Load alias map; build join-order for pre-draw fallback
  const summaryAliasMap = campaign.currentRoundId
    ? await loadSantaAliasMap(campaign.currentRoundId)
    : new Map<string, SantaAliasRecord>();
  const summaryJoinOrderMap = new Map(participants.map((p, i) => [p.id, i + 1]));
  const hasSummaryAlias = summaryAliasMap.size > 0;

  // Assignment progress for current round
  let giftProgress: {
    pending: number; buying: number; selectedFromWishlist: number; selectedOutside: number;
    declinedToSay: number; sent: number; received: number; missedDeadline: number; orphaned: number;
  } | null = null;

  if (campaign.currentRoundId) {
    const assignments = await prisma.santaAssignment.findMany({
      where: { roundId: campaign.currentRoundId },
      select: { giftStatus: true },
    });
    giftProgress = {
      pending: 0, buying: 0, selectedFromWishlist: 0, selectedOutside: 0,
      declinedToSay: 0, sent: 0, received: 0, missedDeadline: 0, orphaned: 0,
    };
    for (const a of assignments) {
      if (a.giftStatus === 'PENDING') giftProgress.pending++;
      else if (a.giftStatus === 'BUYING') giftProgress.buying++;
      else if (a.giftStatus === 'SELECTED_FROM_WISHLIST') giftProgress.selectedFromWishlist++;
      else if (a.giftStatus === 'SELECTED_OUTSIDE') giftProgress.selectedOutside++;
      else if (a.giftStatus === 'DECLINED_TO_SAY') giftProgress.declinedToSay++;
      else if (a.giftStatus === 'SENT') giftProgress.sent++;
      else if (a.giftStatus === 'RECEIVED') giftProgress.received++;
      else if (a.giftStatus === 'MISSED_DEADLINE') giftProgress.missedDeadline++;
      else if (a.giftStatus === 'ORPHANED') giftProgress.orphaned++;
    }
  }

  // Pending exit requests
  const pendingExitRequests = await prisma.santaExitRequest.findMany({
    where: { campaignId, status: 'PENDING' },
    select: {
      id: true,
      participantId: true,
      reason: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  const resolveParticipantAlias = (pid: string) => hasSummaryAlias
    ? resolveSantaAlias(summaryAliasMap, pid)
    : { alias: predrawLabel(summaryJoinOrderMap.get(pid) ?? 0), emoji: '🎅', adjectiveKey: '', animalKey: '' };

  const formatParticipant = (p: typeof participants[number]) => {
    const a = resolveParticipantAlias(p.id);
    return {
      id: p.id,
      userId: p.userId,
      status: p.status,
      role: p.role,
      joinedAt: p.joinedAt.toISOString(),
      leftAt: p.leftAt?.toISOString() ?? null,
      displayName: a.alias,
      avatarUrl: null,
      emoji: a.emoji,
      adjectiveKey: a.adjectiveKey,
      animalKey: a.animalKey,
      hasLinkedWishlist: !!p.linkedWishlistId,
    };
  };

  return res.json({
    campaign: {
      status: campaign.status,
      currentRoundId: campaign.currentRoundId,
      drawAt: campaign.drawAt?.toISOString() ?? null,
    },
    participants: participants.map(formatParticipant),
    giftProgress,
    pendingExitRequests: pendingExitRequests.map(r => {
      const a = resolveParticipantAlias(r.participantId);
      return {
        id: r.id,
        participantId: r.participantId,
        displayName: a.alias,
        avatarUrl: null,
        emoji: a.emoji,
        reason: r.reason ?? null,
        createdAt: r.createdAt.toISOString(),
      };
    }),
  });
}));

// POST /tg/santa/campaigns/:id/exit-request — submit exit request (JOINED participants, not owner)
tgRouter.post('/santa/campaigns/:id/exit-request', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const parsed = z.object({ reason: z.string().max(300).optional() }).safeParse(req.body);
  if (!parsed.success) return zodError(res, parsed.error);

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { ownerId: true, status: true, currentRoundId: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  // Owner cannot submit an exit request (they own the campaign; use cancel instead)
  if (campaign.ownerId === user.id) return res.status(403).json({ error: 'Owner cannot submit an exit request' });
  // Only allowed when campaign is LOCKED or ACTIVE
  if (!['LOCKED', 'ACTIVE'].includes(campaign.status)) {
    return res.status(409).json({ error: 'exit_request_not_applicable', message: 'Exit requests only apply to LOCKED or ACTIVE campaigns' });
  }

  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId: user.id } },
    select: { id: true, status: true },
  });
  if (!participant || participant.status !== 'JOINED') {
    return res.status(403).json({ error: 'Only JOINED participants can submit exit requests' });
  }

  // Check for existing PENDING exit request (partial unique index enforces this at DB level too)
  const existing = await prisma.santaExitRequest.findFirst({
    where: { participantId: participant.id, status: 'PENDING' },
  });
  if (existing) return res.status(409).json({ error: 'exit_request_already_pending', requestId: existing.id });

  const exitRequest = await prisma.santaExitRequest.create({
    data: {
      campaignId,
      participantId: participant.id,
      roundId: campaign.currentRoundId ?? null,
      reason: parsed.data?.reason ?? null,
      status: 'PENDING',
    },
  });

  // Notify all organizers (owner + ADMIN participants)
  void (async () => {
    try {
      const adminParticipants = await prisma.santaParticipant.findMany({
        where: { campaignId, status: 'JOINED', role: 'ADMIN' },
        select: { userId: true },
      });
      const organizerUserIds = [
        campaign.ownerId,
        ...adminParticipants.map(p => p.userId).filter(uid => uid !== campaign.ownerId),
      ];
      if (organizerUserIds.length > 0) {
        await prisma.santaNotification.createMany({
          data: organizerUserIds.map(uid => ({
            campaignId,
            userId: uid,
            type: 'EXIT_REQUEST_SUBMITTED' as const,
            payload: { requestId: exitRequest.id, participantId: participant.id },
          })),
          skipDuplicates: true,
        });
      }
    } catch { /* best-effort */ }
  })();

  return res.status(201).json({
    exitRequest: {
      id: exitRequest.id,
      status: exitRequest.status,
      reason: exitRequest.reason,
      createdAt: exitRequest.createdAt.toISOString(),
    },
  });
}));

// GET /tg/santa/campaigns/:id/exit-requests — list exit requests (organizer only)
tgRouter.get('/santa/campaigns/:id/exit-requests', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, currentRoundId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

  // Load alias map and join-order for alias resolution
  const exitAliasMap = campaign.currentRoundId
    ? await loadSantaAliasMap(campaign.currentRoundId)
    : new Map<string, SantaAliasRecord>();

  const requests = await prisma.santaExitRequest.findMany({
    where: { campaignId },
    select: {
      id: true,
      participantId: true,
      roundId: true,
      reason: true,
      status: true,
      resolvedAt: true,
      createdAt: true,
      participant: {
        select: { userId: true, status: true, joinedAt: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  // Build join-order for pre-draw fallback
  const allParticipants = await prisma.santaParticipant.findMany({
    where: { campaignId },
    select: { id: true, joinedAt: true },
    orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
  });
  const exitJoinOrderMap = new Map(allParticipants.map((p, i) => [p.id, i + 1]));

  return res.json({
    exitRequests: requests.map(r => {
      const hasRoundAlias = exitAliasMap.size > 0;
      const pAlias = hasRoundAlias
        ? resolveSantaAlias(exitAliasMap, r.participantId)
        : { alias: predrawLabel(exitJoinOrderMap.get(r.participantId) ?? 0), emoji: '🎅', adjectiveKey: '', animalKey: '' };
      return {
        id: r.id,
        participantId: r.participantId,
        displayName: pAlias.alias,      // alias instead of real name
        avatarUrl: null,                  // never expose real photo
        emoji: pAlias.emoji,
        participantStatus: r.participant.status,
        roundId: r.roundId,
        reason: r.reason ?? null,
        status: r.status,
        resolvedAt: r.resolvedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      };
    }),
  });
}));

// POST /tg/santa/campaigns/:id/exit-requests/:requestId/approve — approve exit (owner only)
// Owner only — admin cannot approve their own request (self-approve guard) and role management
// is owner-scoped, so approval authority stays with owner.
tgRouter.post('/santa/campaigns/:id/exit-requests/:requestId/approve', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const requestId = req.params.requestId ?? '';

  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { ownerId: true, status: true, currentRoundId: true },
  });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can approve exit requests' });

  const exitRequest = await prisma.santaExitRequest.findUnique({
    where: { id: requestId },
    select: { id: true, campaignId: true, participantId: true, status: true },
  });
  if (!exitRequest || exitRequest.campaignId !== campaignId) return res.status(404).json({ error: 'Exit request not found' });
  if (exitRequest.status !== 'PENDING') return res.status(409).json({ error: 'Exit request is not pending' });

  const participant = await prisma.santaParticipant.findUnique({
    where: { id: exitRequest.participantId },
    select: { id: true, userId: true, status: true },
  });
  if (!participant) return res.status(404).json({ error: 'Participant not found' });

  // M1: one-to-one warning — if approving this exit would leave only 1 JOINED participant
  const remainingJoinedCount = await prisma.santaParticipant.count({
    where: { campaignId, status: 'JOINED', id: { not: participant.id } },
  });
  const warning = remainingJoinedCount === 1 ? 'only_one_participant_remaining' : undefined;

  const now = new Date();

  // Approval transaction:
  // 1. Mark exit request as APPROVED
  // 2. Set participant status → LEFT (voluntary exit with organizer approval, not forced removal)
  // 3. If ACTIVE campaign + participant has non-terminal assignments in current round → ORPHANED
  await prisma.$transaction(async (tx) => {
    await tx.santaExitRequest.update({
      where: { id: requestId },
      data: { status: 'APPROVED', resolvedAt: now },
    });
    await tx.santaParticipant.update({
      where: { id: participant.id },
      data: { status: 'LEFT', leftAt: now },
    });
    // If there's an active round, orphan any non-terminal assignments from this participant
    if (campaign.status === 'ACTIVE' && campaign.currentRoundId) {
      await tx.santaAssignment.updateMany({
        where: {
          roundId: campaign.currentRoundId,
          giverParticipantId: participant.id,
          giftStatus: { notIn: ['RECEIVED', 'MISSED_DEADLINE', 'ORPHANED'] as never[] },
        },
        data: { giftStatus: 'ORPHANED' },
      });
    }
    // Deny any other PENDING exit requests from the same participant (shouldn't exist due to unique index, but be safe)
    await tx.santaExitRequest.updateMany({
      where: { participantId: participant.id, status: 'PENDING', id: { not: requestId } },
      data: { status: 'DENIED', resolvedAt: now },
    });
  });

  // Notify the participant that their request was approved
  void prisma.santaNotification.create({
    data: {
      campaignId,
      userId: participant.userId,
      type: 'EXIT_REQUEST_APPROVED',
      payload: { requestId },
    },
  }).catch(() => {});

  // System message in chat (participant_left — they chose to leave, organizer approved)
  const participantUser = await prisma.user.findUnique({
    where: { id: participant.userId },
    select: { firstName: true, profile: { select: { displayName: true } } },
  });
  const displayName = participantUser?.profile?.displayName || participantUser?.firstName || 'Someone';
  void createSystemMessage(campaignId, 'participant_left', { displayName }).catch(() => {});

  return res.json({ ok: true, exitRequest: { id: requestId, status: 'APPROVED' }, ...(warning ? { warning } : {}) });
}));

// POST /tg/santa/campaigns/:id/exit-requests/:requestId/deny — deny exit (owner only)
tgRouter.post('/santa/campaigns/:id/exit-requests/:requestId/deny', asyncHandler(async (req, res) => {
  const user = await getOrCreateTgUser(req.tgUser!);
  const campaignId = req.params.id ?? '';
  const requestId = req.params.requestId ?? '';

  const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can deny exit requests' });

  const exitRequest = await prisma.santaExitRequest.findUnique({
    where: { id: requestId },
    select: { id: true, campaignId: true, participantId: true, status: true },
  });
  if (!exitRequest || exitRequest.campaignId !== campaignId) return res.status(404).json({ error: 'Exit request not found' });
  if (exitRequest.status !== 'PENDING') return res.status(409).json({ error: 'Exit request is not pending' });

  const participant = await prisma.santaParticipant.findUnique({
    where: { id: exitRequest.participantId },
    select: { userId: true },
  });

  await prisma.santaExitRequest.update({
    where: { id: requestId },
    data: { status: 'DENIED', resolvedAt: new Date() },
  });

  // Notify the participant that their request was denied
  if (participant) {
    void prisma.santaNotification.create({
      data: {
        campaignId,
        userId: participant.userId,
        type: 'EXIT_REQUEST_DENIED',
        payload: { requestId },
      },
    }).catch(() => {});
  }

  return res.json({ ok: true, exitRequest: { id: requestId, status: 'DENIED' } });
}));

// ═══════════════════════════════════════════════════════════════════════════════
// Group Gift — Совместный подарок
// ═══════════════════════════════════════════════════════════════════════════════

/** Map a GroupGift to the API response shape (role-dependent). */
function mapGroupGift(
  gg: {
    id: string; itemId: string; organizerUserId: string; targetAmount: number; currency: string;
    deadline: Date | null; note: string | null; pinnedInfo: string | null; status: string;
    inviteToken: string; completedAt: Date | null; cancelledAt: Date | null;
    createdAt: Date; updatedAt: Date;
    item: { id: string; title: string; imageUrl: string | null; priceText: string | null; currency: string; wishlistId: string };
    organizer: { id: string; profile: { displayName: string | null; username: string | null; avatarUrl: string | null } | null; firstName: string | null };
    participants: Array<{ id: string; userId: string; amount: number; displayName: string; joinedAt: Date;
      user: { id: string; profile: { avatarUrl: string | null } | null } }>;
  },
  viewerUserId: string,
) {
  const isOrganizer = gg.organizerUserId === viewerUserId;
  const isParticipant = gg.participants.some(p => p.userId === viewerUserId);
  const collectedAmount = gg.participants.reduce((sum, p) => sum + p.amount, 0);
  const participantCount = gg.participants.length;
  const progressPct = gg.targetAmount > 0 ? Math.min(100, Math.round((collectedAmount / gg.targetAmount) * 100)) : 0;

  const organizerName = gg.organizer.profile?.displayName ?? gg.organizer.firstName ?? '…';

  // Participants: organizer sees amounts; participants see only own amount
  const participants = gg.participants.map(p => ({
    id: p.id,
    userId: p.userId,
    displayName: p.displayName,
    avatarUrl: p.user.profile?.avatarUrl ?? null,
    joinedAt: p.joinedAt.toISOString(),
    isOrganizer: p.userId === gg.organizerUserId,
    isSelf: p.userId === viewerUserId,
    amount: isOrganizer || p.userId === viewerUserId ? p.amount : null,
  }));

  return {
    id: gg.id,
    itemId: gg.itemId,
    item: {
      id: gg.item.id,
      title: gg.item.title,
      imageUrl: gg.item.imageUrl,
      price: gg.item.priceText ? (Number(gg.item.priceText) || null) : null,
      currency: gg.item.currency,
      wishlistId: gg.item.wishlistId,
    },
    organizerUserId: gg.organizerUserId,
    organizerName,
    organizerAvatarUrl: gg.organizer.profile?.avatarUrl ?? null,
    targetAmount: gg.targetAmount,
    currency: gg.currency,
    deadline: gg.deadline?.toISOString() ?? null,
    note: gg.note,
    pinnedInfo: gg.pinnedInfo,
    status: gg.status,
    inviteToken: gg.inviteToken,
    collectedAmount,
    participantCount,
    progressPct,
    remaining: Math.max(0, gg.targetAmount - collectedAmount),
    isOrganizer,
    isParticipant,
    participants,
    completedAt: gg.completedAt?.toISOString() ?? null,
    cancelledAt: gg.cancelledAt?.toISOString() ?? null,
    createdAt: gg.createdAt.toISOString(),
  };
}

const groupGiftInclude = {
  item: { select: { id: true, title: true, imageUrl: true, priceText: true, currency: true, wishlistId: true } },
  organizer: { select: { id: true, firstName: true, profile: { select: { displayName: true, username: true, avatarUrl: true } } } },
  participants: {
    select: { id: true, userId: true, amount: true, displayName: true, joinedAt: true,
      user: { select: { id: true, profile: { select: { avatarUrl: true } } } } },
    orderBy: { joinedAt: 'asc' as const },
  },
};

// POST /tg/items/:id/group-gift — create a group gift for an item
tgRouter.post(
  '/items/:id/group-gift',
  asyncHandler(async (req, res) => {
    const itemId = req.params.id ?? '';
    if (!itemId) return res.status(400).json({ error: 'Missing item id' });

    const parsed = z.object({
      targetAmount: z.number().int().min(1),
      currency: z.enum(['RUB', 'USD', 'EUR', 'GBP']).optional(),
      deadline: z.string().optional(),
      note: z.string().max(500).optional(),
      displayName: z.string().min(1).max(64).optional(),
      myAmount: z.number().int().min(0).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const tgUser = req.tgUser!;
    const user = await getOrCreateTgUser(tgUser);
    const ent = await getEffectiveEntitlements(user.id, user.godMode);

    // Check group gift access
    if (!ent.hasGroupGift) {
      trackEvent('feature_gate_hit_group_gift', user.id);
      return res.status(403).json({ error: 'group_gift_required', priceXtr: GROUP_GIFT_PRICE_XTR });
    }

    // Validate the item exists and is available
    const item = await prisma.item.findUnique({
      where: { id: itemId },
      select: { id: true, status: true, wishlistId: true, wishlist: { select: { ownerId: true } } },
    });
    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.status !== 'AVAILABLE') return res.status(409).json({ error: 'Item is not available' });
    // Cannot create group gift for own item
    if (item.wishlist.ownerId === user.id) return res.status(403).json({ error: 'Cannot group-gift own item' });
    // Check if group gift already exists for this item
    const existing = await prisma.groupGift.findUnique({ where: { itemId } });
    if (existing) return res.status(409).json({ error: 'Group gift already exists for this item' });

    const displayName = parsed.data.displayName ?? tgUser.first_name;
    const actorHash = tgActorHash(tgUser.id);
    const deadline = parsed.data.deadline ? new Date(parsed.data.deadline) : null;

    // Create group gift + reserve item + add organizer as participant in one tx
    const gg = await prisma.$transaction(async (tx) => {
      // Reserve the item
      const updatedItem = await tx.item.update({
        where: { id: itemId },
        data: {
          status: 'RESERVED',
          reservationEpoch: { increment: 1 },
          reserverUserId: user.id,
        },
      });
      await tx.reservationEvent.create({
        data: { itemId, type: 'RESERVED', actorHash, comment: displayName },
      });

      // Create group gift
      const groupGift = await tx.groupGift.create({
        data: {
          itemId,
          organizerUserId: user.id,
          targetAmount: parsed.data.targetAmount,
          currency: parsed.data.currency ?? 'RUB',
          deadline,
          note: parsed.data.note ?? null,
        },
        include: groupGiftInclude,
      });

      // Add organizer as first participant
      const participant = await tx.groupGiftParticipant.create({
        data: {
          groupGiftId: groupGift.id,
          userId: user.id,
          amount: parsed.data.myAmount ?? 0,
          displayName,
        },
      });

      // System message
      await tx.groupGiftMessage.create({
        data: {
          groupGiftId: groupGift.id,
          senderUserId: user.id,
          text: `${displayName} создал совместный подарок`,
          type: 'SYSTEM',
        },
      });

      // Refetch with includes
      return tx.groupGift.findUniqueOrThrow({
        where: { id: groupGift.id },
        include: groupGiftInclude,
      });
    });

    trackEvent('group_gift_created', user.id, { itemId, groupGiftId: gg.id });
    return res.status(201).json(mapGroupGift(gg, user.id));
  }),
);

// GET /tg/group-gifts/:id — get group gift detail (role-dependent view)
tgRouter.get(
  '/group-gifts/:id',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const user = await getOrCreateTgUser(req.tgUser!);

    const gg = await prisma.groupGift.findUnique({
      where: { id },
      include: groupGiftInclude,
    });
    if (!gg) return res.status(404).json({ error: 'Group gift not found' });

    // Only organizer and participants can view
    const isOrganizer = gg.organizerUserId === user.id;
    const isParticipant = gg.participants.some(p => p.userId === user.id);
    if (!isOrganizer && !isParticipant) return res.status(403).json({ error: 'Not a member' });

    return res.json(mapGroupGift(gg, user.id));
  }),
);

// GET /tg/group-gifts/by-invite/:token — get group gift detail by invite token (for join flow)
tgRouter.get(
  '/group-gifts/by-invite/:token',
  asyncHandler(async (req, res) => {
    const token = req.params.token ?? '';
    const user = await getOrCreateTgUser(req.tgUser!);

    const gg = await prisma.groupGift.findUnique({
      where: { inviteToken: token },
      include: groupGiftInclude,
    });
    if (!gg) return res.status(404).json({ error: 'Group gift not found' });
    if (gg.status !== 'OPEN') return res.status(409).json({ error: 'Group gift is not open' });

    // Check if user is the item owner (should not see group gift)
    const item = await prisma.item.findUnique({
      where: { id: gg.itemId },
      select: { wishlist: { select: { ownerId: true } } },
    });
    if (item && item.wishlist.ownerId === user.id) {
      return res.status(403).json({ error: 'Owner cannot join group gift' });
    }

    return res.json(mapGroupGift(gg, user.id));
  }),
);

// POST /tg/group-gifts/:id/join — join a group gift
tgRouter.post(
  '/group-gifts/:id/join',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const parsed = z.object({
      amount: z.number().int().min(0),
      displayName: z.string().min(1).max(64).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const tgUser = req.tgUser!;
    const user = await getOrCreateTgUser(tgUser);
    const displayName = parsed.data.displayName ?? tgUser.first_name;

    const gg = await prisma.groupGift.findUnique({
      where: { id },
      include: { item: { select: { wishlist: { select: { ownerId: true } } } } },
    });
    if (!gg) return res.status(404).json({ error: 'Group gift not found' });
    if (gg.status !== 'OPEN') return res.status(409).json({ error: 'Group gift is not open' });
    // Item owner cannot join
    if (gg.item.wishlist.ownerId === user.id) return res.status(403).json({ error: 'Owner cannot join' });

    // Check if already a participant
    const existingP = await prisma.groupGiftParticipant.findUnique({
      where: { groupGiftId_userId: { groupGiftId: id, userId: user.id } },
    });
    if (existingP) return res.status(409).json({ error: 'Already a participant' });

    await prisma.$transaction(async (tx) => {
      await tx.groupGiftParticipant.create({
        data: { groupGiftId: id, userId: user.id, amount: parsed.data.amount, displayName },
      });
      await tx.groupGiftMessage.create({
        data: {
          groupGiftId: id,
          senderUserId: user.id,
          text: `${displayName} присоединился`,
          type: 'SYSTEM',
        },
      });
    });

    // Notify organizer
    const organizer = await prisma.user.findUnique({
      where: { id: gg.organizerUserId },
      select: { telegramChatId: true },
    });
    if (organizer?.telegramChatId) {
      void sendTgNotification(organizer.telegramChatId,
        `👥 ${displayName} присоединился к совместному подарку`);
    }

    // Return updated group gift
    const updated = await prisma.groupGift.findUniqueOrThrow({
      where: { id },
      include: groupGiftInclude,
    });
    trackEvent('group_gift_joined', user.id, { groupGiftId: id });
    return res.json(mapGroupGift(updated, user.id));
  }),
);

// PATCH /tg/group-gifts/:id/amount — update own contribution amount
tgRouter.patch(
  '/group-gifts/:id/amount',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const parsed = z.object({ amount: z.number().int().min(0) }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);

    const gg = await prisma.groupGift.findUnique({ where: { id } });
    if (!gg) return res.status(404).json({ error: 'Group gift not found' });
    if (gg.status !== 'OPEN') return res.status(409).json({ error: 'Group gift is not open' });

    const participant = await prisma.groupGiftParticipant.findUnique({
      where: { groupGiftId_userId: { groupGiftId: id, userId: user.id } },
    });
    if (!participant) return res.status(403).json({ error: 'Not a participant' });

    await prisma.$transaction(async (tx) => {
      await tx.groupGiftParticipant.update({
        where: { id: participant.id },
        data: { amount: parsed.data.amount },
      });
      await tx.groupGiftMessage.create({
        data: {
          groupGiftId: id,
          senderUserId: user.id,
          text: `${participant.displayName} обновил сумму`,
          type: 'SYSTEM',
        },
      });
    });

    const updated = await prisma.groupGift.findUniqueOrThrow({
      where: { id },
      include: groupGiftInclude,
    });
    return res.json(mapGroupGift(updated, user.id));
  }),
);

// POST /tg/group-gifts/:id/leave — leave a group gift
tgRouter.post(
  '/group-gifts/:id/leave',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const user = await getOrCreateTgUser(req.tgUser!);

    const gg = await prisma.groupGift.findUnique({ where: { id } });
    if (!gg) return res.status(404).json({ error: 'Group gift not found' });
    if (gg.status !== 'OPEN') return res.status(409).json({ error: 'Group gift is not open' });
    // Organizer cannot leave — they must cancel
    if (gg.organizerUserId === user.id) return res.status(403).json({ error: 'Organizer cannot leave' });

    const participant = await prisma.groupGiftParticipant.findUnique({
      where: { groupGiftId_userId: { groupGiftId: id, userId: user.id } },
    });
    if (!participant) return res.status(404).json({ error: 'Not a participant' });

    await prisma.$transaction(async (tx) => {
      await tx.groupGiftParticipant.delete({ where: { id: participant.id } });
      await tx.groupGiftMessage.create({
        data: {
          groupGiftId: id,
          senderUserId: user.id,
          text: `${participant.displayName} вышел`,
          type: 'SYSTEM',
        },
      });
    });

    trackEvent('group_gift_left', user.id, { groupGiftId: id });
    return res.json({ ok: true });
  }),
);

// POST /tg/group-gifts/:id/complete — mark group gift as completed (organizer only)
tgRouter.post(
  '/group-gifts/:id/complete',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const user = await getOrCreateTgUser(req.tgUser!);

    const gg = await prisma.groupGift.findUnique({
      where: { id },
      include: { participants: { select: { userId: true, displayName: true } } },
    });
    if (!gg) return res.status(404).json({ error: 'Group gift not found' });
    if (gg.organizerUserId !== user.id) return res.status(403).json({ error: 'Only organizer can complete' });
    if (gg.status !== 'OPEN') return res.status(409).json({ error: 'Group gift is not open' });

    await prisma.$transaction(async (tx) => {
      await tx.groupGift.update({
        where: { id },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
      await tx.groupGiftMessage.create({
        data: {
          groupGiftId: id,
          senderUserId: user.id,
          text: 'Сбор завершён',
          type: 'SYSTEM',
        },
      });
    });

    // Notify all participants
    for (const p of gg.participants) {
      if (p.userId === user.id) continue;
      const pUser = await prisma.user.findUnique({ where: { id: p.userId }, select: { telegramChatId: true } });
      if (pUser?.telegramChatId) {
        void sendTgNotification(pUser.telegramChatId, '✅ Совместный подарок завершён!');
      }
    }

    trackEvent('group_gift_completed', user.id, { groupGiftId: id });
    return res.json({ ok: true });
  }),
);

// POST /tg/group-gifts/:id/cancel — cancel group gift (organizer only)
tgRouter.post(
  '/group-gifts/:id/cancel',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const user = await getOrCreateTgUser(req.tgUser!);

    const gg = await prisma.groupGift.findUnique({
      where: { id },
      include: {
        participants: { select: { userId: true, displayName: true } },
        item: { select: { id: true, wishlistId: true } },
      },
    });
    if (!gg) return res.status(404).json({ error: 'Group gift not found' });
    if (gg.organizerUserId !== user.id) return res.status(403).json({ error: 'Only organizer can cancel' });
    if (gg.status !== 'OPEN') return res.status(409).json({ error: 'Group gift is not open' });

    await prisma.$transaction(async (tx) => {
      await tx.groupGift.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      // Unreserve the item
      await tx.item.update({
        where: { id: gg.itemId },
        data: { status: 'AVAILABLE', reserverUserId: null },
      });
      await tx.reservationEvent.create({
        data: { itemId: gg.itemId, type: 'UNRESERVED', actorHash: tgActorHash(req.tgUser!.id) },
      });
      await tx.groupGiftMessage.create({
        data: {
          groupGiftId: id,
          senderUserId: user.id,
          text: 'Сбор отменён',
          type: 'SYSTEM',
        },
      });
    });

    // Notify all participants
    for (const p of gg.participants) {
      if (p.userId === user.id) continue;
      const pUser = await prisma.user.findUnique({ where: { id: p.userId }, select: { telegramChatId: true } });
      if (pUser?.telegramChatId) {
        void sendTgNotification(pUser.telegramChatId, '❌ Совместный подарок отменён');
      }
    }

    trackEvent('group_gift_cancelled', user.id, { groupGiftId: id });
    return res.json({ ok: true });
  }),
);

// PATCH /tg/group-gifts/:id/pinned — update pinned info (organizer only)
tgRouter.patch(
  '/group-gifts/:id/pinned',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const parsed = z.object({ pinnedInfo: z.string().max(1000) }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);
    const gg = await prisma.groupGift.findUnique({ where: { id } });
    if (!gg) return res.status(404).json({ error: 'Group gift not found' });
    if (gg.organizerUserId !== user.id) return res.status(403).json({ error: 'Only organizer' });

    await prisma.$transaction(async (tx) => {
      await tx.groupGift.update({
        where: { id },
        data: { pinnedInfo: parsed.data.pinnedInfo },
      });
      const profile = await tx.userProfile.findUnique({ where: { userId: user.id }, select: { displayName: true } });
      const name = profile?.displayName ?? req.tgUser!.first_name;
      await tx.groupGiftMessage.create({
        data: {
          groupGiftId: id,
          senderUserId: user.id,
          text: `${name} обновил реквизиты`,
          type: 'SYSTEM',
        },
      });
    });

    return res.json({ ok: true });
  }),
);

// GET /tg/group-gifts/:id/messages — get chat messages
tgRouter.get(
  '/group-gifts/:id/messages',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const user = await getOrCreateTgUser(req.tgUser!);

    const gg = await prisma.groupGift.findUnique({
      where: { id },
      select: { organizerUserId: true, participants: { select: { userId: true } } },
    });
    if (!gg) return res.status(404).json({ error: 'Group gift not found' });

    const isMember = gg.organizerUserId === user.id || gg.participants.some(p => p.userId === user.id);
    if (!isMember) return res.status(403).json({ error: 'Not a member' });

    const cursor = req.query.cursor as string | undefined;
    const limit = Math.min(Number(req.query.limit ?? 50), 100);

    const messages = await prisma.groupGiftMessage.findMany({
      where: {
        groupGiftId: id,
        ...(cursor ? { createdAt: { lt: new Date(cursor) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true, text: true, type: true, createdAt: true,
        senderUserId: true,
        sender: { select: { id: true, firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
      },
    });

    return res.json({
      messages: messages.reverse().map(m => ({
        id: m.id,
        text: m.text,
        type: m.type,
        createdAt: m.createdAt.toISOString(),
        senderId: m.senderUserId,
        senderName: m.sender.profile?.displayName ?? m.sender.firstName ?? '…',
        senderAvatarUrl: m.sender.profile?.avatarUrl ?? null,
        isSelf: m.senderUserId === user.id,
      })),
      hasMore: messages.length === limit,
    });
  }),
);

// POST /tg/group-gifts/:id/messages — send a chat message
tgRouter.post(
  '/group-gifts/:id/messages',
  asyncHandler(async (req, res) => {
    const id = req.params.id ?? '';
    const parsed = z.object({ text: z.string().min(1).max(2000) }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const user = await getOrCreateTgUser(req.tgUser!);

    const gg = await prisma.groupGift.findUnique({
      where: { id },
      select: { organizerUserId: true, participants: { select: { userId: true } } },
    });
    if (!gg) return res.status(404).json({ error: 'Group gift not found' });

    const isMember = gg.organizerUserId === user.id || gg.participants.some(p => p.userId === user.id);
    if (!isMember) return res.status(403).json({ error: 'Not a member' });

    const msg = await prisma.groupGiftMessage.create({
      data: {
        groupGiftId: id,
        senderUserId: user.id,
        text: parsed.data.text,
        type: 'USER',
      },
      select: {
        id: true, text: true, type: true, createdAt: true, senderUserId: true,
        sender: { select: { id: true, firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
      },
    });

    return res.status(201).json({
      id: msg.id,
      text: msg.text,
      type: msg.type,
      createdAt: msg.createdAt.toISOString(),
      senderId: msg.senderUserId,
      senderName: msg.sender.profile?.displayName ?? msg.sender.firstName ?? '…',
      senderAvatarUrl: msg.sender.profile?.avatarUrl ?? null,
      isSelf: true,
    });
  }),
);

// GET /tg/group-gifts/my — list user's active group gifts (as organizer or participant)
tgRouter.get(
  '/group-gifts/my',
  asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);

    const [organized, participating] = await Promise.all([
      prisma.groupGift.findMany({
        where: { organizerUserId: user.id, status: 'OPEN' },
        include: groupGiftInclude,
        orderBy: { createdAt: 'desc' },
      }),
      prisma.groupGift.findMany({
        where: {
          participants: { some: { userId: user.id } },
          organizerUserId: { not: user.id },
          status: 'OPEN',
        },
        include: groupGiftInclude,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return res.json({
      organized: organized.map(gg => mapGroupGift(gg, user.id)),
      participating: participating.map(gg => mapGroupGift(gg, user.id)),
    });
  }),
);

// GET /tg/items/:id/group-gift — check if item has a group gift
tgRouter.get(
  '/items/:id/group-gift',
  asyncHandler(async (req, res) => {
    const itemId = req.params.id ?? '';
    const user = await getOrCreateTgUser(req.tgUser!);

    const gg = await prisma.groupGift.findUnique({
      where: { itemId },
      include: groupGiftInclude,
    });
    if (!gg) return res.json({ hasGroupGift: false });

    const isMember = gg.organizerUserId === user.id || gg.participants.some(p => p.userId === user.id);
    return res.json({
      hasGroupGift: true,
      groupGift: isMember ? mapGroupGift(gg, user.id) : { id: gg.id, status: gg.status },
    });
  }),
);

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
