// Telegram-auth router for /tg/wishlists/* — 26 handlers covering wishlist
// CRUD (create / update / delete / archive / unarchive / reorder), share-
// tokens, selections, subscriptions, transfer-items, items reorder under
// a wishlist, the 5 categories handlers (nested under wishlists/:id), the
// 234-LOC POST /wishlists/:id/items item-create handler (rooted under
// wishlists path), GET /wishlists/:id/archive and GET/PUT
// /wishlists/:id/dont-gift.
//
// Mounted via `tgRouter.use(wishlistsRouter)` in apps/api/src/index.ts
// after the other early P5 sub-routers, AFTER the protectTgRoute(...)
// chain at lines 1506–1515 / 1556–1563. Those `tgRouter.all(...)`
// middleware fire BEFORE sub-router dispatch, so idem (`category:
// 'wishlist.*'` / `'item.create'` / `'share'` / `'subscribe'`) and
// rate-limits (wishlist.create + share.hour + item.create) remain in
// effect.
//
// Same factory pattern as P5a–P5n. Handler bodies are byte-identical to
// their previous in-place definitions in index.ts (1996–3749, interleaved
// with categories/items handlers — items already extracted in P5n; what
// remains here is wishlists + categories + wishlist-rooted item routes).
// Only `tgRouter.` -> `wishlistsRouter.` and indent +2.
//
// Helpers migrated WITH this router (sole consumer = wishlists handlers):
//   - attributeLifecycleReturn (formerly index.ts:1938) — used only by
//     GET /wishlists; pure prisma read/update with no module-scope
//     dependencies. Body byte-identical.
//
// Helpers passed via deps (universal — used by other routers too):
//   - getOrCreateTgUser, getEffectiveEntitlements, getUserEntitlement,
//     trackEvent, trackAnalyticsEvent — universal.
//   - mapTgItem, isWishlistWritable — also used by items/onboarding/
//     reservations.
//   - notifySubscribersOfChange, runReferralProgressHook — multi-consumer
//     (notifications + referral hooks).
//   - reassignPrimaryBeforeWishlistDelete — also passed to adminRouter
//     (deps line 6733). Stays in index.ts.
//   - hasSmartReservations, ACTIVE_STATUSES, ONE_TIME_SKUS — billing /
//     plan domain shared.
//   - numToPriority, completeOnboarding, ONBOARDING_KEY,
//     ONBOARDING_VERSION, FORCED_ROLLOUT_USERS, variantKeyToSegment,
//     zUrl — universal helpers / constants used by POST /wishlists/:id/
//     items (the 234-LOC item-creation handler) and PATCH /wishlists/:id.
//
// Module-level imports (no factory closure needed):
//   - prisma, z, zodError, asyncHandler, getRequestLocale, t (Locale),
//     logger, sendTgNotification, sendTgBotMessage, getOrCreateProfile,
//     getOnboardingMeta.
//   - countActivePlacementsInWishlist, ensureItemPlacement,
//     relocateItemPrimary — placement helpers (./placements/*).
//
// Pre-existing security gaps (NOT addressed in this PR — flag-only):
//   - POST /wishlists/:id/items/reorder — no idempotency middleware.
//   - POST /wishlists/:id/categories, PATCH /wishlists/:wlId/categories/
//     :catId, DELETE /wishlists/:wlId/categories/:catId, POST
//     /wishlists/:id/categories/reorder — no idempotency. Categories
//     CRUD is entirely without security middleware (legacy).
//   - PUT /wishlists/:id/dont-gift — no idempotency.
// Path inconsistency `:id` vs `:wlId` for category subroutes is
// pre-existing — mirrored byte-identical in this file.

import { Router } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma, Prisma } from '@wishlist/db';
import { t, type Locale, getOnboardingMeta } from '@wishlist/shared';

import { asyncHandler } from '../lib/asyncHandler';
import { zodError } from '../lib/http';
import { getRequestLocale } from '../lib/locale';
import { sendTgNotification, sendTgBotMessage } from '../telegram/botApi';
import { getOrCreateProfile } from '../profile';
import { countActivePlacementsInWishlist } from '../placements/countActivePlacementsInWishlist';
import { ensureItemPlacement } from '../placements/ensureItemPlacement';
import { relocateItemPrimary } from '../placements/relocateItemPrimary';
import { generateUniqueShareToken } from '../wishlists/shareToken';
import { generateUniqueSlug } from '../wishlists/slug';
import { PLACEMENT_ORDER_BY } from '../placements/orderBy';
import { ITEM_ORDER_BY } from '../sort';
import { recordForeignWishlistAccess, checkForeignWishlistLiveAccess } from '../services/foreign-wishlist-access';
import { trackProductEvent } from '../services/analytics';
import { evaluateGuestConversion } from '../services/wishlists';
import { HIDDEN_FROM_INVENTORY_SKUS } from '../services/entitlement';
import { makeAddonRequired, makePlanLimitReached, makeProRequired, sendPaywall } from '../services/paywall';
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
type WishlistsUser = {
  id: string;
  godMode: boolean;
  telegramId?: string | null;
  telegramChatId?: string | null;
};

// Plan info shape on entitlements.
type WishlistsPlan = {
  code: string;
  wishlists: number;
  items: number;
  participants: number;
  categoriesPerWishlist: number;
  features: readonly string[];
};

// Subscription summary spread from getUserEntitlement (base in
// getEffectiveEntitlements).
type WishlistsSubscription = {
  id: string;
  status: string;
  periodEnd: string;
  cancelledAt: string | null;
  cancelAtPeriodEnd: boolean;
  billingPeriod: string | null;
} | null;

type WishlistsPromoPro = {
  id: string;
  expiresAt: string | null;
  campaignCode: string;
} | null;

// getEffectiveEntitlements return shape — broad subset accessed by these
// handlers. Kept structural so we don't drag the full computed-entitlement
// type from index.ts.
type WishlistsEntitlements = {
  plan: WishlistsPlan;
  isPro: boolean;
  proSource: 'subscription' | 'promo' | 'god_mode' | null;
  subscription: WishlistsSubscription;
  promoPro: WishlistsPromoPro;
  effectiveWishlistLimit: number;
  effectiveSubscriptionLimit: number;
  extraItemsPerWishlist: Record<string, number>;
  smartReservationsWishlists: Set<string>;
  seasonalWishlists: Set<string>;
  addOns: { addonType: string; quantity: number; targetId?: string | null }[];
  hintCredits: number;
  importCredits: number;
  freeImportsUsed: number;
  freeImportsLimit: number;
  freeHintsUsed: number;
  freeHintsLimit: number;
  hasGiftNotes: boolean;
  giftNotes: unknown;
  hasGroupGift: boolean;
  groupGift: unknown;
  hasSecretReservations: boolean;
  secretReservations: unknown;
};

// getUserEntitlement return shape (subset accessed when needed).
type WishlistsUserEntitlement = {
  isPro: boolean;
  plan: WishlistsPlan;
};

// Item shape that mapTgItem accepts. Mirrors index.ts:1271.
type MapTgItemInput = {
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
};

// Onboarding completion reasons — mirrors local CompletionReason union in
// index.ts:983.
type CompletionReason =
  | 'demo_converted'
  | 'real_item_created'
  | 'demo_deleted_then_real_created'
  | 'demo_moved_to_user_wishlist'
  | 'try_import_completed'
  | 'catalog_selected'
  | 'manual_created';

// Market segment used by variantKeyToSegment (index.ts:976/1003).
type MarketSegment = 'ru' | 'global';

export type WishlistsRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<WishlistsUser>;
  getEffectiveEntitlements: (userId: string, godMode?: boolean) => Promise<WishlistsEntitlements>;
  getUserEntitlement: (userId: string, godMode?: boolean) => Promise<WishlistsUserEntitlement>;
  trackEvent: (event: string, userId?: string, props?: Record<string, unknown>) => void;
  trackAnalyticsEvent: (input: { event: string; userId?: string; props?: Record<string, unknown> }) => void;
  mapTgItem: (item: MapTgItemInput) => Record<string, unknown>;
  isWishlistWritable: (userId: string, wishlistId: string, planLimit: number) => Promise<boolean>;
  reassignPrimaryBeforeWishlistDelete: (wishlistId: string) => Promise<void>;
  /** E04 — same service used by bootstrap (/me/profile) and onboarding (create-wishlist). POST /tg/wishlists delegates here so the rename-vs-create decision and the race vs bootstrap stay in one place. */
  getOrCreateDefaultWishlist: (
    userId: string,
    locale: Locale,
  ) => Promise<{ id: string; slug: string; title: string; isDefault: boolean; alreadyExisted: boolean }>;
  runReferralProgressHook: (userId: string, milestone: 'first_wishlist' | 'first_item') => Promise<void>;
  notifySubscribersOfChange: (
    wishlistId: string,
    entityId: string,
    changedFields: string[],
    eventType: 'item_added' | 'item_updated' | 'wishlist_updated',
    meta: { itemTitle?: string; wishlistTitle?: string; ownerName?: string },
  ) => Promise<void>;
  hasSmartReservations: (
    ownerUser: { godMode: boolean },
    ownerIsPro: boolean,
    ownerAddOns: Array<{ addonType: string; targetId?: string | null }>,
    wishlistId: string,
  ) => boolean;
  ACTIVE_STATUSES: readonly ('AVAILABLE' | 'RESERVED' | 'PURCHASED')[];
  ONE_TIME_SKUS: Readonly<Record<string, {
    code: string;
    price: number;
    type: string;
    targetRequired: boolean;
  }>>;
  numToPriority: (n: number) => 'LOW' | 'MEDIUM' | 'HIGH';
  completeOnboarding: (userId: string, reason: CompletionReason) => Promise<void>;
  ONBOARDING_KEY: string;
  ONBOARDING_VERSION: number;
  FORCED_ROLLOUT_USERS: ReadonlySet<string>;
  variantKeyToSegment: (variantKey: string) => MarketSegment;
  zUrl: () => z.ZodType<string>;
};

/**
 * Generate a unique 12-char base64url token for a curated selection. Migrated
 * from index.ts:2276 — sole consumer is POST /wishlists/:id/selections. Body
 * byte-identical.
 */
async function generateUniqueCuratedToken(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const token = crypto.randomBytes(9).toString('base64url');
    const existing = await prisma.curatedSelection.findUnique({ where: { shareToken: token } });
    if (!existing) return token;
  }
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

/**
 * Lifecycle-touch attribution for a returning user. Migrated from index.ts:
 * 1938 — sole consumer is GET /wishlists. Body byte-identical.
 *
 * Marks the user's most-recent unreturned LifecycleTouch as `returnedAt = now`
 * and, if the touch hasn't been credited yet, evaluates the per-segment
 * completion target (S1=create wishlist, S2=add item, S3=add 2+ wishes since
 * touch, S4=any activity since touch). On first completion, sets
 * `targetCompletedAt` and returns `justCompleted: true` so the handler can
 * fire the analytics event.
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

export function registerWishlistsRouter(deps: WishlistsRouterDeps): Router {
  const {
    getOrCreateTgUser,
    getEffectiveEntitlements,
    getUserEntitlement,
    trackEvent,
    trackAnalyticsEvent,
    mapTgItem,
    isWishlistWritable,
    reassignPrimaryBeforeWishlistDelete,
    getOrCreateDefaultWishlist,
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
  } = deps;

  const wishlistsRouter = Router();

  // GET /tg/wishlists — my wishlists
  wishlistsRouter.get(
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
          freeImportsUsed: ent.freeImportsUsed,
          freeImportsLimit: ent.freeImportsLimit,
          freeHintsUsed: ent.freeHintsUsed,
          freeHintsLimit: ent.freeHintsLimit,
        },
        skus: Object.values(ONE_TIME_SKUS)
          .filter(s => !HIDDEN_FROM_INVENTORY_SKUS.has(s.code))
          .map(s => ({
            code: s.code,
            price: s.price,
            type: s.type,
            targetRequired: s.targetRequired,
          })),
      });
    }),
  );

  // POST /tg/wishlists/:id/share-token — get or create share token for a wishlist (owner only)
  wishlistsRouter.post(
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
      trackAnalyticsEvent({ event: 'share.token_generated', userId: user.id, props: { wishlistId: req.params.id } });

      return res.json({ shareToken: updated.shareToken });
    }),
  );

  // DELETE /tg/wishlists/:id/share-token — revoke share token (owner only)
  wishlistsRouter.delete(
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

  // POST /tg/wishlists/:id/selections — create a curated selection (Pro-gated)
  wishlistsRouter.post(
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
        return sendPaywall(res, 402, makeProRequired('curated_selection', { planCode: ent.plan.code }));
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
  wishlistsRouter.get(
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

  // POST /tg/wishlists/reorder — update wishlist positions (owner only)
  wishlistsRouter.post(
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
  wishlistsRouter.post(
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
      // E04 — exclude `isDefault=true` rows from the quota count so the
      // FREE plan (effectiveWishlistLimit=1) doesn't 402 the user's first
      // manual create. Without this, a brand-new user hits "Plan limit
      // reached" on their first home-screen "+" tap because bootstrap
      // already populated their single allowed slot with an empty default.
      // The default row gets RENAMED-in-place below, so post-rename the
      // count goes from N to N+1 (the rename consumes exactly one slot)
      // — same net behaviour as a pure insert.
      const count = await prisma.wishlist.count({
        where: { ownerId: user.id, type: 'REGULAR', archivedAt: null, isDefault: false },
      });
      if (count >= ent.effectiveWishlistLimit) {
        trackEvent('feature_gate_hit_wishlist_limit', user.id, { plan: ent.plan.code, count, limit: ent.effectiveWishlistLimit });
        return sendPaywall(res, 402, makePlanLimitReached('wishlist_limit', {
          limit: ent.effectiveWishlistLimit,
          current: count,
          planCode: ent.plan.code,
          skuCode: 'extra_wishlist_slot',
        }));
      }

      // Determine insert position + inherit privacy defaults from profile
      const profile = await prisma.userProfile.findUnique({ where: { userId: user.id }, select: { newWishlistPosition: true, commentsEnabled: true } });
      // "top" is a PRO feature — FREE users always append to bottom regardless of stored value
      const addToTop = ent.isPro && profile?.newWishlistPosition === 'top';

      // E04 — delegate to the shared service so the rename-vs-create
      // decision lives in one place AND races against bootstrap's own
      // fire-and-forget create are handled by the service's P2002 catch
      // (review iter-2 must-fix #2). The TOCTOU bug the previous inline
      // findFirst→create version had: T1 here finds nothing → falls to
      // CREATE branch; meanwhile T2 (parallel /me/profile bootstrap)
      // inserts an isDefault row; T1's create succeeds with
      // isDefault=false, no partial-index conflict → user ends up with
      // two REGULARs. Calling the service first guarantees that the
      // isDefault row exists (or proves an existing manual REGULAR
      // already covers the user), and the service's findFirst + P2002
      // recovery handles the race atomically.
      const locale = getRequestLocale(req);
      const ensured = await getOrCreateDefaultWishlist(user.id, locale);

      // Position selection mirrors the four legacy branches but routes
      // through `ensured.isDefault` instead of a separate findFirst:
      //
      //   ensured.isDefault=true  + addToTop=true  → shift OTHER wishlists, set this=0
      //   ensured.isDefault=true  + addToTop=false → preserve the default's existing position
      //   ensured.isDefault=false + addToTop=true  → shift ALL existing, set new=0
      //   ensured.isDefault=false + addToTop=false → append to max+1
      let newPosition: number;
      if (ensured.isDefault) {
        if (addToTop) {
          await prisma.wishlist.updateMany({
            where: { ownerId: user.id, type: 'REGULAR', archivedAt: null, id: { not: ensured.id } },
            data: { position: { increment: 1 } },
          });
          newPosition = 0;
        } else {
          const current = await prisma.wishlist.findUnique({ where: { id: ensured.id }, select: { position: true } });
          newPosition = current?.position ?? 0;
        }
      } else if (addToTop) {
        await prisma.wishlist.updateMany({
          where: { ownerId: user.id, type: 'REGULAR', archivedAt: null },
          data: { position: { increment: 1 } },
        });
        newPosition = 0;
      } else {
        const maxResult = await prisma.wishlist.aggregate({
          where: { ownerId: user.id, type: 'REGULAR', archivedAt: null },
          _max: { position: true },
        });
        newPosition = (maxResult._max.position ?? -1) + 1;
      }

      // Inherit commentPolicy from profile default: commentsEnabled=false → SUBSCRIBERS, else ALL
      const inheritedCommentPolicy = profile?.commentsEnabled === false ? 'SUBSCRIBERS' : 'ALL';
      const wishlist = ensured.isDefault
        ? await prisma.wishlist.update({
            where: { id: ensured.id },
            data: {
              title: parsed.data.title,
              deadline: parsed.data.deadline ? new Date(parsed.data.deadline) : null,
              position: newPosition,
              commentPolicy: inheritedCommentPolicy,
              isDefault: false,
            },
            select: { id: true, slug: true, title: true, description: true, deadline: true },
          })
        : await (async () => {
            const slug = await generateUniqueSlug(parsed.data.title);
            return prisma.wishlist.create({
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
          })();

      // E04 — `isRenamingDefault` is true on the rename branch; we use it
      // below to SUPPRESS the legacy `wishlist_created` emit so dashboards
      // don't double-count the E04 cohort. The service already fired
      // `wishlist_created` (source=auto_default) when bootstrap materialised
      // this row; firing again here (source=manual) for the same wishlistId
      // would inflate `COUNT(*) wishlist_created` by 2× for every E04
      // user who reaches this endpoint. `wishlist.created` (PRODUCT_EVENTS
      // taxonomy) keeps firing because it represents the user's "named a
      // wishlist" intent and is distinct per business semantics.
      const isRenamingDefault = ensured.isDefault;

      // Canonical analytics: wishlist_created
      const existingRegular = await prisma.wishlist.count({ where: { ownerId: user.id, type: 'REGULAR' } });
      const existingAny = await prisma.wishlist.count({ where: { ownerId: user.id } });
      // E04 dual-emit guard — when this handler RENAMED the bootstrap
      // default in place, the service already fired
      // `wishlist_created` (source=auto_default) at bootstrap creation
      // time. Re-firing with source=manual for the same wishlistId
      // would double-count the E04 cohort in COUNT(*) dashboards.
      // `wishlist.created` (PRODUCT_EVENTS taxonomy) and
      // `first_regular_wishlist_created` keep firing because they
      // represent user-initiated naming, which IS new business
      // information independent of the bootstrap auto-create signal.
      if (!isRenamingDefault) {
        trackEvent('wishlist_created', user.id, {
          wishlistId: wishlist.id, wishlistType: 'REGULAR', source: 'manual',
          platform: 'miniapp',
          isFirstRegularWishlist: existingRegular === 1,
          isFirstAnyWishlist: existingAny === 1,
        });
      }
      if (existingRegular === 1) trackEvent('first_regular_wishlist_created', user.id, { wishlistId: wishlist.id, source: 'manual', platform: 'miniapp' });

      trackAnalyticsEvent({ event: 'wishlist.created', userId: user.id, props: { source: 'miniapp' } });

      // Guest → user conversion. A visitor who arrived via a share link or
      // referral and then creates their FIRST own wishlist has materially
      // converted from a passive guest into an active owner. Decision rule
      // is extracted to `evaluateGuestConversion` in services/wishlists.ts
      // so it's unit-testable without spinning up the full router. Both
      // signals (referredByUserId, firstAcquisitionSource) live on
      // UserProfile, not User — one read covers both.
      if (existingRegular === 1) {
        try {
          const profile = await prisma.userProfile.findUnique({
            where: { userId: user.id },
            select: {
              referredByUserId: true,
              firstAcquisitionSource: true,
              firstAcquisitionMedium: true,
            },
          });
          const decision = evaluateGuestConversion({
            existingRegularWishlistCount: existingRegular,
            referredByUserId: profile?.referredByUserId ?? null,
            firstAcquisitionSource: profile?.firstAcquisitionSource ?? null,
          });
          if (decision.emit) {
            trackProductEvent({
              event: 'guest.converted_to_user',
              userId: user.id,
              props: {
                source: decision.source,
                medium: profile?.firstAcquisitionMedium ?? null,
                platform: 'miniapp',
              },
            });
          }
        } catch (err) {
          logger.warn({ err, userId: user.id }, 'guest.converted_to_user attribution check failed');
        }
      }

      // Referral: mark firstWishlist milestone + drive qualify/reward pipeline
      // if this user was referred. Fire-and-forget; never blocks the response.
      void runReferralProgressHook(user.id, 'first_wishlist');

      return res.status(201).json({
        wishlist: { ...wishlist, deadline: wishlist.deadline?.toISOString() ?? null, itemCount: 0, reservedCount: 0 },
      });
    }),
  );

  // PATCH /tg/wishlists/:id — update wishlist (title, deadline, privacy settings)
  wishlistsRouter.patch(
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

      // PRO-gate advanced visibility modes (purchasable → 402, not 403)
      if (!isPro && (parsed.data.visibility === 'PUBLIC_PROFILE' || parsed.data.visibility === 'PRIVATE')) {
        return sendPaywall(res, 402, makeProRequired('wishlist_visibility', {
          planCode: ent.plan.code,
          message: 'Upgrade to Pro to use this visibility setting',
        }));
      }
      if (!isPro && parsed.data.allowSubscriptions === 'NOBODY') {
        return sendPaywall(res, 402, makeProRequired('wishlist_subscription_policy', {
          planCode: ent.plan.code,
          message: 'Upgrade to Pro to restrict subscriptions',
        }));
      }
      if (!isPro && parsed.data.commentPolicy === 'SUBSCRIBERS') {
        return sendPaywall(res, 402, makeProRequired('wishlist_comment_policy', {
          planCode: ent.plan.code,
          message: 'Upgrade to Pro to restrict comments',
        }));
      }
      // PRO-gate dontGiftMode changes (except "global" which is the default)
      if (!isPro && parsed.data.dontGiftMode && parsed.data.dontGiftMode !== 'global') {
        return sendPaywall(res, 402, makeProRequired('dont_gift', { planCode: ent.plan.code }));
      }
      // Smart Reservations gate: owner must have entitlement (PRO or per-wishlist add-on)
      const hasSmartResFields = parsed.data.smartReservationsEnabled !== undefined ||
        parsed.data.smartResTtlHours !== undefined || parsed.data.smartResAllowExtend !== undefined ||
        parsed.data.smartResMaxExtensions !== undefined;
      if (hasSmartResFields && !hasSmartReservations({ godMode: user.godMode }, isPro, ent.addOns, id)) {
        return sendPaywall(res, 402, makeAddonRequired('smart_reservations', {
          skuCode: 'smart_reservations_unlock',
          planCode: ent.plan.code,
        }));
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
  wishlistsRouter.delete(
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
      trackAnalyticsEvent({ event: 'wishlist.deleted', userId: user.id, props: { wishlistId: req.params.id } });

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
  wishlistsRouter.post(
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
  wishlistsRouter.post(
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
  wishlistsRouter.post(
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
  wishlistsRouter.post(
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
        return sendPaywall(res, 402, makePlanLimitReached('subscription_limit', {
          limit: ent.effectiveSubscriptionLimit,
          current: currentCount,
          planCode: ent.plan.code,
          skuCode: 'extra_subscription_slot',
        }));
      }

      const sub = await prisma.wishlistSubscription.upsert({
        where: { wishlistId_subscriberId: { wishlistId, subscriberId: user.id } },
        update: {},
        create: { wishlistId, subscriberId: user.id },
        select: { id: true, wishlistId: true, createdAt: true },
      });

      // Foreign-wishlist access history (feeds global search). Fire-and-forget;
      // a write failure here must never block subscription success.
      void recordForeignWishlistAccess({ userId: user.id, wishlistId, source: 'subscription' })
        .catch(() => { /* non-critical */ });

      return res.json({ subscription: { id: sub.id, wishlistId: sub.wishlistId } });
    }),
  );

  // DELETE /tg/wishlists/:id/subscribe — unsubscribe from a wishlist
  wishlistsRouter.delete(
    '/wishlists/:id/subscribe',
    asyncHandler(async (req, res) => {
      const wishlistId = req.params.id ?? '';
      if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });

      const user = await getOrCreateTgUser(req.tgUser!);
      await prisma.wishlistSubscription.deleteMany({ where: { wishlistId, subscriberId: user.id } });
      return res.json({ ok: true });
    }),
  );

  // GET /tg/wishlists/:id/access-view — authenticated read of a FOREIGN wishlist
  // by id. Used by the global-search "result click" flow when the user found
  // a wishlist they once opened (via share link / curated / subscription /
  // reservation / santa) and now wants to navigate back to it.
  //
  // Authz: parent tgRouter requires Telegram initData → req.tgUser. Caller's
  // userId is taken from the resolved tg user, NEVER from the URL or body.
  // Owner reads must use GET /wishlists/:id/items instead; this route 403s
  // if the requester owns the wishlist (loud-failure makes the contract
  // explicit — the frontend should not call this for own wishlists).
  //
  // Access gate: services/foreign-wishlist-access.ts#checkForeignWishlistLiveAccess
  // enforces the strict revocation model — relation-grounded sources (sub /
  // reservation / santa / profile / curated) pass on a current relation
  // row; share_link / curated_selection FWA pins are compared to the
  // current credential and dropped on mismatch.
  wishlistsRouter.get(
    '/wishlists/:id/access-view',
    asyncHandler(async (req, res) => {
      const wishlistId = req.params.id ?? '';
      if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });

      const user = await getOrCreateTgUser(req.tgUser!);
      const check = await checkForeignWishlistLiveAccess(user.id, wishlistId);
      if (!check.allowed) {
        // Map the granular reasons to safe HTTP status. We DO NOT leak
        // wishlist title, owner, items or any content here — the frontend
        // shows a generic "no longer available" toast on any non-2xx.
        if (check.reason === 'not_found') return res.status(404).json({ error: 'not_found' });
        if (check.reason === 'own_wishlist') return res.status(409).json({ error: 'own_wishlist' });
        // archived / drafts / private / no_relation / revoked → 403 with a
        // single error tag. Telemetry can still distinguish via the tag.
        return res.status(403).json({ error: 'access_denied', reason: check.reason });
      }

      const wishlist = await prisma.wishlist.findUnique({
        where: { id: wishlistId },
        select: {
          id: true, slug: true, title: true, description: true, deadline: true,
          dontGiftMode: true, dontGiftPresets: true, dontGiftCustomItems: true,
          dontGiftComment: true,
          smartReservationsEnabled: true, smartResTtlHours: true,
          owner: {
            select: {
              firstName: true,
              profile: { select: { displayName: true, username: true, profileVisibility: true, avatarThumbUrl: true, avatarPublic: true, dontGiftPresets: true, dontGiftCustomItems: true, dontGiftComment: true, dontGiftVisible: true } },
            },
          },
          tags: { select: { id: true, name: true } },
          categories: {
            orderBy: [{ isDefault: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
            select: { id: true, name: true, sortOrder: true, isDefault: true },
          },
        },
      });
      // checkForeignWishlistLiveAccess already verified existence; this is
      // a TOCTOU safety net — return 404 rather than crashing if the row
      // vanished between calls.
      if (!wishlist) return res.status(404).json({ error: 'not_found' });

      // Placement-based read — same shape as /public/share/:token so the
      // frontend can drop this response into the existing guest-view
      // parser (lib/searchApi.ts → MiniApp navigation calls
      // loadGuestWishlist on the slug, OR consumes this directly).
      const placements = await prisma.wishlistItemPlacement.findMany({
        where: { wishlistId, item: { status: { in: [...ACTIVE_STATUSES] } } },
        orderBy: PLACEMENT_ORDER_BY,
        select: {
          position: true,
          categoryId: true,
          item: {
            select: {
              id: true, title: true, description: true, url: true,
              priceText: true, currency: true, commentOwner: true,
              priority: true, deadline: true, imageUrl: true, status: true,
              createdAt: true, updatedAt: true,
              itemTags: { include: { tag: { select: { id: true, name: true } } } },
              reservationEvents: {
                where: { type: 'RESERVED' },
                orderBy: { createdAt: 'desc' },
                take: 1,
                select: { comment: true, actorHash: true },
              },
            },
          },
        },
      });

      const ownerName =
        wishlist.owner?.profile?.displayName?.trim() ||
        wishlist.owner?.profile?.username?.trim() ||
        wishlist.owner?.firstName?.trim() ||
        null;
      const ownerUsername =
        wishlist.owner?.profile?.profileVisibility !== 'NOBODY'
          ? wishlist.owner?.profile?.username ?? null
          : null;
      const ownerAvatarUrl = wishlist.owner?.profile?.avatarPublic
        ? wishlist.owner?.profile?.avatarThumbUrl ?? null
        : null;

      // dontGift payload — same logic as /public/share/:token (per-wishlist
      // override > profile default > hidden).
      const tokenProfile = wishlist.owner?.profile;
      let dontGift: { presets: string[]; customItems: string[]; comment: string | null } | null = null;
      if (wishlist.dontGiftMode === 'local') {
        const hasLocal =
          wishlist.dontGiftPresets.length > 0 ||
          wishlist.dontGiftCustomItems.length > 0 ||
          !!wishlist.dontGiftComment;
        if (hasLocal) {
          dontGift = { presets: wishlist.dontGiftPresets, customItems: wishlist.dontGiftCustomItems, comment: wishlist.dontGiftComment ?? null };
        }
      } else if (wishlist.dontGiftMode !== 'hidden') {
        const tokenDontGiftHasContent =
          (tokenProfile?.dontGiftPresets?.length ?? 0) > 0 ||
          (tokenProfile?.dontGiftCustomItems?.length ?? 0) > 0 ||
          !!tokenProfile?.dontGiftComment;
        if (tokenProfile?.dontGiftVisible && tokenDontGiftHasContent) {
          dontGift = {
            presets: tokenProfile.dontGiftPresets,
            customItems: tokenProfile.dontGiftCustomItems,
            comment: tokenProfile.dontGiftComment ?? null,
          };
        }
      }

      return res.json({
        wishlist: {
          id: wishlist.id,
          slug: wishlist.slug,
          title: wishlist.title,
          description: wishlist.description,
          deadline: wishlist.deadline,
          ownerName,
          ownerUsername,
          ownerAvatarUrl,
        },
        items: placements.map((p) => ({
          id: p.item.id,
          title: p.item.title,
          description: p.item.description,
          url: p.item.url,
          priceText: p.item.priceText,
          commentOwner: p.item.commentOwner,
          priority: p.item.priority,
          deadline: p.item.deadline,
          imageUrl: p.item.imageUrl,
          status: p.item.status,
          createdAt: p.item.createdAt,
          updatedAt: p.item.updatedAt,
          categoryId: p.categoryId,
          position: p.position,
          tags: p.item.itemTags.map((it) => it.tag),
          reservedByDisplayName:
            p.item.status === 'RESERVED' && p.item.reservationEvents?.length
              ? (p.item.reservationEvents[0]?.comment ?? null)
              : null,
          reservedByActorHash:
            p.item.status === 'RESERVED' && p.item.reservationEvents?.length
              ? (p.item.reservationEvents[0]?.actorHash ?? null)
              : null,
        })),
        tags: wishlist.tags,
        categories: wishlist.categories,
        dontGift,
      });
    }),
  );

  // GET /tg/wishlists/:id/subscribe — subscription status + subscriber count (for guest view)
  wishlistsRouter.get(
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

  // GET /tg/wishlists/:id/items — owner view (no reservation names)
  wishlistsRouter.get(
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
  wishlistsRouter.post(
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

  // GET /tg/wishlists/:id/categories — list categories for a wishlist (owner)
  wishlistsRouter.get(
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

  // POST /tg/wishlists/:id/categories — create category (quota-based)
  // FREE: 1 user category per wishlist; PRO: 20. Beyond quota → 402 with
  // paywall='categories'. The default ("Без категории") doesn't count toward
  // the quota — it's a system row, not a user-created one.
  //
  // Race protection: the quota count + duplicate check + insert run in a
  // Serializable transaction so two concurrent POSTs from the same user can't
  // both pass `count < limit` and double-create. Postgres surfaces a
  // serialization conflict as Prisma P2034 — we return 409 (not 503) with a
  // dedicated `code` so the FE's `tgFetch` doesn't treat it as a maintenance
  // outage (which would throw the response away) and the user just retries
  // the action with a fresh Idempotency-Key.
  wishlistsRouter.post(
    '/wishlists/:id/categories',
    asyncHandler(async (req, res) => {
      const wishlistId = req.params.id ?? '';
      if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });

      const parsed = z.object({
        name: z.string().min(1).max(24),
      }).safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      const trimmedName = parsed.data.name.trim();
      if (!trimmedName) return res.status(400).json({ error: 'Empty name' });

      const user = await getOrCreateTgUser(req.tgUser!);
      const ent = await getEffectiveEntitlements(user.id);

      const wishlist = await prisma.wishlist.findUnique({ where: { id: wishlistId }, select: { ownerId: true } });
      if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
      if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

      const limit = ent.plan.categoriesPerWishlist ?? Infinity;

      type CreateOutcome =
        | { kind: 'over_quota'; used: number }
        | { kind: 'duplicate_name' }
        | { kind: 'created'; category: { id: string; name: string; sortOrder: number; isDefault: boolean }; isFirst: boolean };

      let outcome: CreateOutcome | { kind: 'conflict' };
      try {
        outcome = await prisma.$transaction(
          async (tx): Promise<CreateOutcome> => {
            const existingCount = await tx.wishlistCategory.count({ where: { wishlistId, isDefault: false } });
            if (existingCount >= limit) {
              return { kind: 'over_quota', used: existingCount };
            }

            const existing = await tx.wishlistCategory.findMany({
              where: { wishlistId },
              select: { name: true },
            });
            if (existing.some(c => c.name.trim().toLowerCase() === trimmedName.toLowerCase())) {
              return { kind: 'duplicate_name' };
            }

            // Ensure default ("Без категории") exists before adding the first user category.
            const defaultCat = await tx.wishlistCategory.findFirst({ where: { wishlistId, isDefault: true } });
            if (!defaultCat) {
              await tx.wishlistCategory.create({
                data: { wishlistId, name: 'Без категории', sortOrder: 999999, isDefault: true },
              });
            }

            // New category gets sortOrder = max existing + 1 (default stays last via its 999999 sentinel).
            const maxOrder = await tx.wishlistCategory.aggregate({
              where: { wishlistId, isDefault: false },
              _max: { sortOrder: true },
            });
            const nextOrder = (maxOrder._max.sortOrder ?? -1) + 1;

            const category = await tx.wishlistCategory.create({
              data: { wishlistId, name: trimmedName, sortOrder: nextOrder, isDefault: false },
              select: { id: true, name: true, sortOrder: true, isDefault: true },
            });

            return { kind: 'created', category, isFirst: existingCount === 0 };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
          outcome = { kind: 'conflict' };
        } else {
          throw err;
        }
      }

      if (outcome.kind === 'over_quota') {
        if (!ent.isPro) {
          // FREE hit the free-tier ceiling — surface as paywall, not generic 400.
          trackEvent('feature_gate_hit_categories', user.id, { plan: ent.plan.code, used: outcome.used, limit });
          return sendPaywall(res, 402, makeProRequired('categories', {
            planCode: ent.plan.code,
            paywallTag: 'categories',
          }));
        }
        return res.status(400).json({ error: 'Category limit reached', limit });
      }
      if (outcome.kind === 'duplicate_name') return res.status(409).json({ error: 'Duplicate category name' });
      if (outcome.kind === 'conflict') return res.status(409).json({ error: 'Concurrent write conflict, please retry', code: 'CATEGORY_CONCURRENT_WRITE' });

      trackEvent('wishlist_category_created', user.id, { wishlistId, categoryId: outcome.category.id, name: outcome.category.name });
      return res.json({ category: outcome.category, isFirst: outcome.isFirst });
    }),
  );

  // PATCH /tg/wishlists/:wlId/categories/:catId — rename category.
  // Open to all owners: a FREE user who created their 1 free category must
  // still be able to rename it. Quota is enforced on CREATE only.
  wishlistsRouter.patch(
    '/wishlists/:wlId/categories/:catId',
    asyncHandler(async (req, res) => {
      const { wlId, catId } = req.params;
      if (!wlId || !catId) return res.status(400).json({ error: 'Missing ids' });

      const parsed = z.object({
        name: z.string().min(1).max(24),
      }).safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      const user = await getOrCreateTgUser(req.tgUser!);

      const wishlist = await prisma.wishlist.findUnique({ where: { id: wlId }, select: { ownerId: true } });
      if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });
      if (wishlist.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

      const category = await prisma.wishlistCategory.findUnique({ where: { id: catId }, select: { id: true, wishlistId: true, isDefault: true } });
      if (!category || category.wishlistId !== wlId) return res.status(404).json({ error: 'Category not found' });
      if (category.isDefault) return res.status(400).json({ error: 'Cannot rename default category' });

      // Trim + reject whitespace-only names (Zod min(1) accepts "   ").
      const trimmedName = parsed.data.name.trim();
      if (!trimmedName) return res.status(400).json({ error: 'Empty name' });

      // Duplicate check
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

  // DELETE /tg/wishlists/:wlId/categories/:catId — delete category, move items to default.
  // Open to all owners — needed so FREE users can free up their one quota slot
  // (delete then create a different category). Owner-check is the only gate.
  wishlistsRouter.delete(
    '/wishlists/:wlId/categories/:catId',
    asyncHandler(async (req, res) => {
      const { wlId, catId } = req.params;
      if (!wlId || !catId) return res.status(400).json({ error: 'Missing ids' });

      const user = await getOrCreateTgUser(req.tgUser!);

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

  // POST /tg/wishlists/:id/categories/reorder — reorder categories.
  // Open to all owners; trivial no-op for FREE with a single user category,
  // but kept consistent so the UI doesn't have to branch on plan.
  wishlistsRouter.post(
    '/wishlists/:id/categories/reorder',
    asyncHandler(async (req, res) => {
      const wishlistId = req.params.id ?? '';
      if (!wishlistId) return res.status(400).json({ error: 'Missing wishlist id' });

      const parsed = z.object({
        orderedIds: z.array(z.string()).min(1).max(20),
      }).safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      const user = await getOrCreateTgUser(req.tgUser!);

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

  // POST /tg/wishlists/:id/items — add item
  wishlistsRouter.post(
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
        return sendPaywall(res, 402, makeProRequired('wishlist_readonly', {
          planCode: ent.plan.code,
          message: 'Wishlist is read-only on current plan',
        }));
      }

      // Per-wishlist item limit = plan base + any permanent item upgrades for this wishlist.
      // Capacity counts by PLACEMENT so shared wishes count against each host wishlist.
      const effectiveItemLimit = ent.plan.items + (ent.extraItemsPerWishlist[wishlistId] ?? 0);
      const itemCount = await countActivePlacementsInWishlist(wishlistId);
      if (itemCount >= effectiveItemLimit) {
        trackEvent('feature_gate_hit_item_limit', user.id, { plan: ent.plan.code, count: itemCount, limit: effectiveItemLimit });
        return sendPaywall(res, 402, makePlanLimitReached('item_limit', {
          limit: effectiveItemLimit,
          current: itemCount,
          planCode: ent.plan.code,
          skuCode: 'extra_items_5',
        }));
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
            return sendPaywall(res, 402, makeProRequired('wishlist_readonly', {
              planCode: ent.plan.code,
              context: id,
              message: 'Wishlist is read-only on current plan',
            }));
          }
          const lim = ent.plan.items + (ent.extraItemsPerWishlist[id] ?? 0);
          const cnt = await countActivePlacementsInWishlist(id);
          if (cnt >= lim) {
            trackEvent('feature_gate_hit_item_limit', user.id, { plan: ent.plan.code, count: cnt, limit: lim, context: 'multi_placement' });
            return sendPaywall(res, 402, makePlanLimitReached('item_limit', {
              limit: lim,
              current: cnt,
              planCode: ent.plan.code,
              context: id,
              skuCode: 'extra_items_5',
            }));
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

      // Race protection: the pre-checks above are an optimistic fast path. Without
      // a Serializable transaction wrapping the recount + create + placements, two
      // concurrent POSTs can both pass `count < limit` at the same instant and
      // both succeed → quota bypass. Mirrors the categories pattern at line ~1685.
      // P2034 = Postgres 40001 surfaced by Prisma; we return 409 so the client
      // retries with a fresh Idempotency-Key instead of treating it as outage.
      const ACTIVE_PLACEMENT_STATUSES = ['AVAILABLE', 'RESERVED', 'PURCHASED'] as const;
      type CreateOutcome =
        | { kind: 'over_limit'; wishlistId: string; count: number; limit: number; isAdditional: boolean }
        | { kind: 'created'; item: { id: string; wishlistId: string; title: string; url: string; priceText: string | null; currency: string; imageUrl: string | null; priority: 'LOW' | 'MEDIUM' | 'HIGH'; position: number; status: 'AVAILABLE' | 'RESERVED' | 'PURCHASED' | 'DELETED' | 'COMPLETED' | 'ARCHIVED'; description: string | null; sourceUrl: string | null; sourceDomain: string | null; importMethod: string | null; categoryId: string | null } };

      let createOutcome: CreateOutcome | { kind: 'conflict' };
      try {
        createOutcome = await prisma.$transaction(
          async (tx): Promise<CreateOutcome> => {
            const reCount = await tx.wishlistItemPlacement.count({
              where: { wishlistId, item: { status: { in: [...ACTIVE_PLACEMENT_STATUSES] } } },
            });
            if (reCount >= effectiveItemLimit) {
              return { kind: 'over_limit', wishlistId, count: reCount, limit: effectiveItemLimit, isAdditional: false };
            }
            for (const { id: addId } of validatedAdditionals) {
              const lim = ent.plan.items + (ent.extraItemsPerWishlist[addId] ?? 0);
              const cnt = await tx.wishlistItemPlacement.count({
                where: { wishlistId: addId, item: { status: { in: [...ACTIVE_PLACEMENT_STATUSES] } } },
              });
              if (cnt >= lim) {
                return { kind: 'over_limit', wishlistId: addId, count: cnt, limit: lim, isAdditional: true };
              }
            }

            const defaultCategoryId = (await tx.wishlistCategory.findFirst({ where: { wishlistId, isDefault: true }, select: { id: true } }))?.id ?? null;
            const created = await tx.item.create({
              data: {
                wishlistId,
                title: parsed.data.title,
                url: parsed.data.url ?? '',
                priceText: parsed.data.price != null ? String(parsed.data.price) : null,
                priority: numToPriority(parsed.data.priority ?? 2),
                imageUrl: parsed.data.imageUrl ?? null,
                currency,
                categoryId: defaultCategoryId,
              },
              select: { id: true, wishlistId: true, title: true, url: true, priceText: true, currency: true, imageUrl: true, priority: true, position: true, status: true, description: true, sourceUrl: true, sourceDomain: true, importMethod: true, categoryId: true },
            });

            await ensureItemPlacement(tx, { wishlistId, itemId: created.id, position: created.position, categoryId: created.categoryId });
            for (const { id: addId } of validatedAdditionals) {
              await ensureItemPlacement(tx, { wishlistId: addId, itemId: created.id });
            }

            return { kind: 'created', item: created };
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
          createOutcome = { kind: 'conflict' };
        } else {
          throw err;
        }
      }

      if (createOutcome.kind === 'over_limit') {
        trackEvent('feature_gate_hit_item_limit', user.id, {
          plan: ent.plan.code,
          count: createOutcome.count,
          limit: createOutcome.limit,
          ...(createOutcome.isAdditional ? { context: 'multi_placement' } : {}),
        });
        return sendPaywall(res, 402, makePlanLimitReached('item_limit', {
          limit: createOutcome.limit,
          current: createOutcome.count,
          planCode: ent.plan.code,
          ...(createOutcome.isAdditional ? { context: createOutcome.wishlistId } : {}),
          skuCode: 'extra_items_5',
        }));
      }
      if (createOutcome.kind === 'conflict') {
        return res.status(409).json({ error: 'concurrent_modification', code: 'SERIALIZATION_CONFLICT', message: 'Please retry the request.' });
      }
      const item = createOutcome.item;
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
        userId: user.id,
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

  // GET /tg/wishlists/:id/archive — archived items of a specific wishlist (DELETED + COMPLETED)
  wishlistsRouter.get(
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

  // GET /tg/wishlists/:id/dont-gift — return per-wishlist "Don't Gift" settings
  wishlistsRouter.get(
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
  wishlistsRouter.put(
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
        return sendPaywall(res, 402, makeProRequired('dont_gift', { planCode: ent.plan.code }));
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


  return wishlistsRouter;
}
