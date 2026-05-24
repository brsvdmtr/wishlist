// Telegram-auth router for /tg/items/* (root-namespace items routes only) —
// 21 handlers covering single-item CRUD, bulk operations, photo upload,
// move/copy, placements, and category move. Item creation under a wishlist
// (POST /tg/wishlists/:id/items) STAYS in index.ts because it is path-rooted
// in the wishlists namespace; same for GET /tg/wishlists/:id/items, the items
// reorder endpoint, and the categories sub-tree.
//
// Mounted via `tgRouter.use(itemsRouter)` in apps/api/src/index.ts after
// the other early P5 sub-routers, AFTER the protectTgRoute(...) chain at
// lines 1516–1533 (PATCH/DELETE /items/:id, /items/:id/{complete,restore,
// photo,placements,placements/:wishlistId}, plus 6 /items/bulk-* entries).
// Those `tgRouter.all(...)` middleware fire BEFORE sub-router dispatch, so
// idem (`category: 'item.*'`) and bulk rate-limits remain in effect.
//
// Same factory pattern as P5a–P5m. Handler bodies are byte-identical to
// their previous in-place definitions in index.ts (scattered between
// 2935–4831, interleaved with wishlists handlers) — only `tgRouter.` ->
// `itemsRouter.` and indent +2.
//
// Helpers passed via deps (universal — used by other routers too):
//   - getOrCreateTgUser, getEffectiveEntitlements, getUserEntitlement,
//     getItemRole, tgActorHash, trackEvent, trackAnalyticsEvent — universal.
//   - mapTgItem — Item → API response shape; also used by wishlists handlers
//     and already passed to onboarding/giftnotes/reservations routers.
//   - isWishlistWritable — capacity check (Pro plan limit + add-on slots);
//     also used by wishlists handlers.
//   - countItemPlacements — how many wishlists hold this item; used by both
//     items and wishlists handlers.
//   - cancelItemHints — clears in-flight hint waves on item delete/complete;
//     also passed to reservationsRouter.
//   - notifySubscribersOfChange — fan-out notification to subscribers;
//     also used by wishlists handlers.
//   - ACTIVE_STATUSES — `as const` tuple of {AVAILABLE, RESERVED, PURCHASED}.
//     Same narrow tuple type already threaded into me/public routers.
//
// Module-level imports (no factory closure needed):
//   - prisma, z, zodError, asyncHandler, getRequestLocale, t, logger,
//     sendTgNotification.
//   - upload (multer), processImage, deleteUploadFile — for POST/DELETE
//     /items/:id/photo (upload.single('photo') is wired as Express
//     middleware on the photo POST route; the byte-identical handler body
//     uses processImage + deleteUploadFile inline).
//
// Wave-2 P3 closure: POST /tg/items/:id/{copy,move,move-category} and
// POST /tg/items/bulk-move-category now have protectTgRoute coverage with
// idempotency middleware (registered in apps/api/src/index.ts alongside
// the rest of the items single/bulk blocks). Single-item endpoints share
// the `item.update` idem category; the bulk endpoint shares the
// `item.bulk` limiter + category with the other bulk-* operations.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '@wishlist/db';
import { t, resolveLocaleWithSource } from '@wishlist/shared';

import { asyncHandler } from '../lib/asyncHandler';
import { zodError } from '../lib/http';
import { getRequestLocale } from '../lib/locale';
import { profileToLanguageSettings } from '../services/locale';
import { sendTgNotification } from '../telegram/botApi';
import { upload } from '../uploads/upload.config';
import { processImage } from '../uploads/imageProcessor';
import { deleteUploadFile } from '../uploads/uploadCleanup';
import { countActivePlacementsInWishlist } from '../placements/countActivePlacementsInWishlist';
import { ensureItemPlacement } from '../placements/ensureItemPlacement';
import { relocateItemPrimary } from '../placements/relocateItemPrimary';
import {
  ONBOARDING_KEY,
  ONBOARDING_VERSION,
  FORCED_ROLLOUT_USERS,
  getDemoTemplate,
  isMeaningfulEdit,
  type CompletionReason,
} from '../services/onboarding';
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
type ItemsUser = {
  id: string;
  godMode: boolean;
  telegramId?: string | null;
  telegramChatId?: string | null;
};

// Plan info shape on entitlements.
type ItemsPlan = {
  code: string;
  wishlists: number;
  items: number;
};

// getEffectiveEntitlements return shape — broad subset accessed by these
// handlers. Kept structural so we don't drag the full computed-entitlement
// type from index.ts.
type ItemsEntitlements = {
  plan: ItemsPlan;
  isPro: boolean;
  effectiveWishlistLimit: number;
  extraItemsPerWishlist: Record<string, number>;
  hasGiftNotes: boolean;
  hasGroupGift: boolean;
};

// getUserEntitlement return shape (subset accessed when needed).
type ItemsUserEntitlement = {
  isPro: boolean;
  plan: ItemsPlan;
};

// Mirror of index.ts:1317 getItemRole return shape — kept structural so the
// dep contract here doesn't drag the full prisma Item type.
type ItemRole = 'owner' | 'reserver' | 'third_party';
type GetItemRoleResult = {
  role: ItemRole;
  item: {
    id: string;
    status: string;
    reservationEpoch: number;
    reserverUserId: string | null;
    title: string;
    wishlist: { ownerId: string };
    reservationEvents: { actorHash: string; comment: string | null }[];
  };
  actorHash: string;
  user: { id: string; telegramChatId: string | null };
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

export type ItemsRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<ItemsUser>;
  getEffectiveEntitlements: (userId: string, godMode?: boolean) => Promise<ItemsEntitlements>;
  getUserEntitlement: (userId: string, godMode?: boolean) => Promise<ItemsUserEntitlement>;
  getItemRole: (itemId: string, tgUser: TelegramUserShape) => Promise<GetItemRoleResult | null>;
  tgActorHash: (telegramId: number) => string;
  trackEvent: (event: string, userId?: string, props?: Record<string, unknown>) => void;
  trackAnalyticsEvent: (input: { event: string; userId?: string; props?: Record<string, unknown> }) => void;
  mapTgItem: (item: MapTgItemInput) => Record<string, unknown>;
  isWishlistWritable: (userId: string, wishlistId: string, planLimit: number) => Promise<boolean>;
  countItemPlacements: (itemId: string) => Promise<number>;
  cancelItemHints: (itemId: string) => Promise<void>;
  notifySubscribersOfChange: (
    wishlistId: string,
    entityId: string,
    changedFields: string[],
    eventType: 'item_added' | 'item_updated' | 'wishlist_updated',
    meta: { itemTitle?: string; wishlistTitle?: string; ownerName?: string },
  ) => Promise<void>;
  ACTIVE_STATUSES: readonly ('AVAILABLE' | 'RESERVED' | 'PURCHASED')[];
  // Local helpers in index.ts that handlers call — passed via deps to keep
  // them at the source-of-truth definition.
  zUrl: () => z.ZodType<string>;
  numToPriority: (n: number) => 'LOW' | 'MEDIUM' | 'HIGH';
  // Onboarding completion factory — closes over trackEvent in index.ts.
  // Other onboarding helpers/consts (getDemoTemplate, isMeaningfulEdit,
  // ONBOARDING_KEY, ONBOARDING_VERSION, FORCED_ROLLOUT_USERS) are imported
  // directly from ../services/onboarding in P5s-3 (Strategy B).
  completeOnboarding: (userId: string, reason: CompletionReason) => Promise<void>;
};

export function registerItemsRouter(deps: ItemsRouterDeps): Router {
  const {
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
    completeOnboarding,
  } = deps;

  const itemsRouter = Router();

  // GET /tg/items — flat list of all items across all user's active wishlists
  itemsRouter.get(
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

  // POST /tg/items/:id/move-category — move single item to a category.
  // Open to all owners since 2026-05-24: the FREE plan ships with 1 free
  // category per wishlist, and that category has to be usable. Owner-check
  // on the target category (its wishlist must belong to the caller) is the
  // sole gate — a FREE user can only target categories they own.
  itemsRouter.post(
    '/items/:id/move-category',
    asyncHandler(async (req, res) => {
      const itemId = req.params.id ?? '';
      if (!itemId) return res.status(400).json({ error: 'Missing item id' });

      const parsed = z.object({
        categoryId: z.string().min(1),
      }).safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      const user = await getOrCreateTgUser(req.tgUser!);

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

  // POST /tg/items/bulk-move-category — bulk move items to a category.
  // Same model as the single move-category route above: any owner can target
  // a category they own; the PRO gate is gone since FREE now ships with 1
  // free category and that category must be writable.
  itemsRouter.post(
    '/items/bulk-move-category',
    asyncHandler(async (req, res) => {
      const parsed = z.object({
        itemIds: z.array(z.string()).min(1).max(100),
        categoryId: z.string().min(1),
      }).safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      const user = await getOrCreateTgUser(req.tgUser!);

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

  // POST /tg/items/bulk-move — move multiple items to a target wishlist
  itemsRouter.post(
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
  itemsRouter.post(
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
  itemsRouter.post(
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
  itemsRouter.post(
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
  itemsRouter.post(
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
  itemsRouter.post(
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

  // PATCH /tg/items/:id — edit item
  itemsRouter.patch(
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

      trackAnalyticsEvent({ event: 'wish.edited', userId: user.id, props: { itemId: req.params.id } });

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
            select: {
              telegramChatId: true,
              profile: { select: { languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } },
            },
          });
          if (reserver?.telegramChatId) {
            // Recipient's locale, not the request initiator's.
            const { locale: notifLocale } = resolveLocaleWithSource(
              profileToLanguageSettings(reserver.profile),
            );
            void sendTgNotification(reserver.telegramChatId, t('notif_description_updated', notifLocale, { title: item.title }));
          }
        }
      }

      return res.json({ item: mapTgItem(updated) });
    }),
  );

  // DELETE /tg/items/:id — soft-delete item (status → DELETED)
  itemsRouter.delete(
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

      trackAnalyticsEvent({ event: 'wish.deleted', userId: user.id, props: { itemId: req.params.id } });

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
          select: {
            telegramChatId: true,
            profile: { select: { languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } },
          },
        });
        if (reserver?.telegramChatId) {
          // Recipient = reserver. Resolve their locale from persisted profile.
          const { locale: notifLocale } = resolveLocaleWithSource(
            profileToLanguageSettings(reserver.profile),
          );
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
  itemsRouter.post(
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

      trackAnalyticsEvent({ event: 'wish.completed', userId: user.id, props: { itemId: req.params.id } });

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
          select: {
            telegramChatId: true,
            id: true,
            profile: { select: { languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } },
          },
        });
        if (reserver?.telegramChatId) {
          const { locale: notifLocale } = resolveLocaleWithSource(
            profileToLanguageSettings(reserver.profile),
          );
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
  itemsRouter.post(
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

  // GET /tg/items/:id — fetch a single item for deep-link resolution (owner/reserver only).
  // Used by comment-reply deep links when the item is not in any already-loaded wishlist.
  itemsRouter.get(
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

  // POST /tg/items/:id/photo — upload or replace item photo (with sharp processing)
  itemsRouter.post(
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
  itemsRouter.delete(
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

  itemsRouter.post(
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

  itemsRouter.post(
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

  // GET /tg/items/:id/placements — list wishlists where this wish is currently placed
  itemsRouter.get(
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
  itemsRouter.post(
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
  itemsRouter.delete(
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


  return itemsRouter;
}
