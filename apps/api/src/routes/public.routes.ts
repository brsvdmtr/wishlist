// Public router (no auth, rate-limited). Mounted as `app.use('/public',
// publicRouter)` in apps/api/src/index.ts. Each handler picks one of the
// two rate-limiters explicitly:
//   - publicReadLimiter   (120 req/min)  for GET endpoints
//   - publicActionLimiter (30 req/15min) for reserve/unreserve/purchase
//
// Same factory pattern as ./internal.routes / ./admin.routes: handler bodies
// are byte-identical to their previous in-place definitions; module-level
// locals from index.ts (ACTIVE_STATUSES, actorBodySchema, getUserEntitlement,
// trackEvent, trackAnalyticsEvent) are passed via `deps` and destructured at
// the top so the bodies do not need any `deps.X` rewriting.
//
// publicReadLimiter, publicActionLimiter, and mapItemForPublic live here
// permanently — the limiters are public-only and mapItemForPublic is used
// only by these handlers.

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '@wishlist/db';

import { asyncHandler } from '../lib/asyncHandler';
import { zodError } from '../lib/http';
import { secureCompare } from '../lib/crypto';
import { PLACEMENT_ORDER_BY } from '../placements/orderBy';
import { isGodModeTelegramId } from '../services/telegram-auth';

export type PublicRouterDeps = {
  // Narrow tuple-like type so `[...ACTIVE_STATUSES]` resolves to a literal
  // union assignable to Prisma's ItemStatus[]. A wider `readonly string[]`
  // would lose the narrowing and break overload resolution on prisma.where.
  ACTIVE_STATUSES: readonly ('AVAILABLE' | 'RESERVED' | 'PURCHASED')[];
  actorBodySchema: z.ZodObject<{ actorHash: z.ZodString }>;
  getUserEntitlement: (userId: string, godMode?: boolean) => Promise<{ isPro: boolean }>;
  trackEvent: (event: string, userId?: string, props?: Record<string, unknown>) => void;
  trackAnalyticsEvent: (params: { event: string; userId?: string; props?: Record<string, unknown> }) => void;
};

function mapItemForPublic(item: {
  id: string;
  title: string;
  description: string | null;
  url: string;
  priceText: string | null;
  commentOwner: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  deadline: Date | null;
  imageUrl: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  itemTags: { tag: { id: string; name: string } }[];
  reservationEvents?: { comment: string | null; actorHash: string }[];
}) {
  return {
    id: item.id,
    title: item.title,
    description: item.description,
    url: item.url,
    priceText: item.priceText,
    commentOwner: item.commentOwner,
    priority: item.priority,
    deadline: item.deadline,
    imageUrl: item.imageUrl,
    status: item.status,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    categoryId: (item as any).categoryId ?? null,
    tags: item.itemTags.map((it) => it.tag),
    // Name of the guest who reserved (visible to other guests, hidden from owner by design).
    reservedByDisplayName:
      item.status === 'RESERVED' && item.reservationEvents?.length
        ? (item.reservationEvents[0]?.comment ?? null)
        : null,
    // Hash of the reserver's identity — used by frontend to detect "reserved by me".
    reservedByActorHash:
      item.status === 'RESERVED' && item.reservationEvents?.length
        ? (item.reservationEvents[0]?.actorHash ?? null)
        : null,
  };
}

export function registerPublicRouter(deps: PublicRouterDeps): Router {
  const {
    ACTIVE_STATUSES,
    actorBodySchema,
    getUserEntitlement,
    trackEvent,
    trackAnalyticsEvent,
  } = deps;

  const publicRouter = Router();

  const publicReadLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });

  const publicActionLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });

  // --- Public endpoints (no auth)
  publicRouter.get(
    '/wishlists/:slug/items',
    publicReadLimiter,
    asyncHandler(async (req, res) => {
      const slug = req.params.slug ?? '';
      if (!slug) return res.status(400).json({ error: 'Missing slug' });

      const queryParsed = z
        .object({
          status: z.enum(['AVAILABLE', 'RESERVED', 'PURCHASED']).optional(),
          tag: z.string().min(1).optional(),
        })
        .safeParse(req.query);
      if (!queryParsed.success) return zodError(res, queryParsed.error);

      const wishlist = await prisma.wishlist.findUnique({
        where: { slug },
        select: { id: true },
      });
      if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });

      // Placement-based read: shared wishes visible in this wishlist's public view.
      // IMPORTANT (privacy): we never expose placements in OTHER wishlists — the list is
      // scoped to this single wishlistId. Other placements are never joined or revealed here.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const itemWhere: Record<string, any> = { status: { in: [...ACTIVE_STATUSES] } };
      if (queryParsed.data.status) itemWhere.status = queryParsed.data.status;
      if (queryParsed.data.tag) itemWhere.itemTags = { some: { tagId: queryParsed.data.tag } };

      const placements = await prisma.wishlistItemPlacement.findMany({
        where: { wishlistId: wishlist.id, item: itemWhere },
        orderBy: PLACEMENT_ORDER_BY,
        select: {
          position: true,
          categoryId: true,
          item: {
            include: {
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

      const items = placements.map(p => ({
        ...mapItemForPublic(p.item),
        categoryId: p.categoryId,
      }));
      return res.json({ items });
    }),
  );

  publicRouter.get(
    '/wishlists/:slug',
    publicReadLimiter,
    asyncHandler(async (req, res) => {
      const slug = req.params.slug ?? '';
      if (!slug) return res.status(400).json({ error: 'Missing slug' });

      const wishlist = await prisma.wishlist.findUnique({
        where: { slug },
        select: {
          id: true,
          slug: true,
          title: true,
          description: true,
          deadline: true,
          visibility: true,
          ownerId: true,
          dontGiftMode: true,
          dontGiftPresets: true,
          dontGiftCustomItems: true,
          dontGiftComment: true,
          smartReservationsEnabled: true, smartResTtlHours: true,
          owner: {
            select: {
              firstName: true,
              profile: { select: { displayName: true, username: true, avatarUrl: true, avatarPublic: true, profileVisibility: true, dontGiftPresets: true, dontGiftCustomItems: true, dontGiftComment: true, dontGiftVisible: true } },
            },
          },
          tags: { select: { id: true, name: true } },
          categories: {
            orderBy: [{ isDefault: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
            select: { id: true, name: true, sortOrder: true, isDefault: true },
          },
        },
      });

      if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });

      // Placement-based items read — shared wishes visible here because this wishlist
      // has placements for them. Other placements (in other wishlists) are NEVER joined,
      // so private placements cannot leak via this public endpoint.
      const itemPlacements = await prisma.wishlistItemPlacement.findMany({
        where: { wishlistId: wishlist.id, item: { status: { in: [...ACTIVE_STATUSES] } } },
        orderBy: PLACEMENT_ORDER_BY,
        select: {
          position: true,
          categoryId: true,
          item: {
            include: {
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

      // PRIVATE wishlists: only subscribers can access
      if (wishlist.visibility === 'PRIVATE') {
        // Check if authenticated TG user is a subscriber
        let isSubscriber = false;
        const tgUser = req.tgUser;
        if (tgUser) {
          const user = await prisma.user.findUnique({
            where: { telegramId: String(tgUser.id) },
            select: { id: true },
          }).catch(() => null);
          if (user) {
            const sub = await prisma.wishlistSubscription.findFirst({
              where: { wishlistId: wishlist.id, subscriberId: user.id },
              select: { id: true },
            });
            isSubscriber = !!sub;
            // Also allow owner
            if (user.id === wishlist.ownerId) isSubscriber = true;
          }
        }
        if (!isSubscriber) {
          // Neutral mask: show a generic "archived" facade so origin is not revealed
          return res.status(403).json({ error: 'wishlist_private', message: 'This wishlist is not publicly accessible' });
        }
      }

      const ownerName =
        wishlist.owner?.profile?.displayName?.trim() ||
        wishlist.owner?.profile?.username?.trim() ||
        wishlist.owner?.firstName?.trim() ||
        null;

      // Respect avatarPublic — only expose photo if owner allows it
      const ownerProfile = wishlist.owner?.profile;
      const ownerAvatarUrl = (ownerProfile?.avatarPublic !== false && ownerProfile?.avatarUrl)
        ? ownerProfile.avatarUrl
        : null;

      trackAnalyticsEvent({ event: 'guest.view_opened', props: { slug, itemCount: itemPlacements.length } });

      // Build dontGift payload respecting per-wishlist mode
      const slugProfile = wishlist.owner?.profile;
      let slugDontGift: { presets: string[]; customItems: string[]; comment: string | null } | null = null;
      if (wishlist.dontGiftMode === 'local') {
        const hasLocal =
          wishlist.dontGiftPresets.length > 0 ||
          wishlist.dontGiftCustomItems.length > 0 ||
          !!wishlist.dontGiftComment;
        if (hasLocal) {
          slugDontGift = { presets: wishlist.dontGiftPresets, customItems: wishlist.dontGiftCustomItems, comment: wishlist.dontGiftComment ?? null };
        }
      } else if (wishlist.dontGiftMode !== 'hidden') {
        // "global" mode (default): use profile-level settings
        const slugDontGiftHasContent =
          (slugProfile?.dontGiftPresets?.length ?? 0) > 0 ||
          (slugProfile?.dontGiftCustomItems?.length ?? 0) > 0 ||
          !!slugProfile?.dontGiftComment;
        if (slugProfile?.dontGiftVisible && slugDontGiftHasContent) {
          slugDontGift = { presets: slugProfile.dontGiftPresets, customItems: slugProfile.dontGiftCustomItems, comment: slugProfile.dontGiftComment ?? null };
        }
      }

      // Owner username is exposed only if the owner's profile is visible (not NOBODY)
      const ownerUsername = (wishlist.owner?.profile?.profileVisibility !== 'NOBODY' && wishlist.owner?.profile?.username)
        ? wishlist.owner.profile.username
        : null;

      return res.json({
        wishlist: {
          id: wishlist.id,
          slug: wishlist.slug,
          title: wishlist.title,
          description: wishlist.description,
          deadline: wishlist.deadline,
          visibility: (wishlist.visibility as string).toLowerCase(),
          ownerName,
          ownerAvatarUrl,
          ownerUsername,
        },
        items: itemPlacements.map(p => ({
          ...mapItemForPublic(p.item),
          categoryId: p.categoryId,
        })),
        tags: wishlist.tags,
        categories: wishlist.categories,
        dontGift: slugDontGift,
      });
    }),
  );

  // GET /public/share/:token — resolve share token → wishlist (same shape as /public/wishlists/:slug)
  // Wrapped in try-catch: if shareToken column doesn't exist (migration not applied), returns 404
  // instead of crashing with 500, so the client can fall back to the slug endpoint gracefully.
  publicRouter.get(
    '/share/:token',
    publicReadLimiter,
    asyncHandler(async (req, res) => {
      const token = req.params.token ?? '';
      if (!token) return res.status(400).json({ error: 'Missing token' });

      let wishlist;
      try {
        wishlist = await prisma.wishlist.findUnique({
          where: { shareToken: token },
          select: {
            id: true,
            slug: true,
            title: true,
            description: true,
            deadline: true,
            dontGiftMode: true,
            dontGiftPresets: true,
            dontGiftCustomItems: true,
            dontGiftComment: true,
            smartReservationsEnabled: true, smartResTtlHours: true,
            owner: {
              select: {
                firstName: true,
                profile: { select: { displayName: true, username: true, profileVisibility: true, dontGiftPresets: true, dontGiftCustomItems: true, dontGiftComment: true, dontGiftVisible: true } },
              },
            },
            tags: { select: { id: true, name: true } },
            categories: {
              orderBy: [{ isDefault: 'asc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
              select: { id: true, name: true, sortOrder: true, isDefault: true },
            },
          },
        });
      } catch {
        // shareToken column may not exist if migration hasn't been applied yet
        return res.status(404).json({ error: 'Wishlist not found' });
      }

      if (!wishlist) return res.status(404).json({ error: 'Wishlist not found' });

      // Placement-based read — privacy note: only placements in THIS wishlist are exposed.
      const sharePlacements = await prisma.wishlistItemPlacement.findMany({
        where: { wishlistId: wishlist.id, item: { status: { in: [...ACTIVE_STATUSES] } } },
        orderBy: PLACEMENT_ORDER_BY,
        select: {
          position: true,
          categoryId: true,
          item: {
            include: {
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

      // Track link open — fire-and-forget, never blocks response
      prisma.wishlist.update({
        where: { shareToken: token },
        data: { shareOpenCount: { increment: 1 } },
      }).catch(() => { /* non-critical — ignore DB errors */ });

      const ownerNameToken =
        wishlist.owner?.profile?.displayName?.trim() ||
        wishlist.owner?.profile?.username?.trim() ||
        wishlist.owner?.firstName?.trim() ||
        null;

      // Build dontGift payload respecting per-wishlist mode
      const tokenProfile = wishlist.owner?.profile;
      let tokenDontGift: { presets: string[]; customItems: string[]; comment: string | null } | null = null;
      if (wishlist.dontGiftMode === 'local') {
        const hasLocal =
          wishlist.dontGiftPresets.length > 0 ||
          wishlist.dontGiftCustomItems.length > 0 ||
          !!wishlist.dontGiftComment;
        if (hasLocal) {
          tokenDontGift = { presets: wishlist.dontGiftPresets, customItems: wishlist.dontGiftCustomItems, comment: wishlist.dontGiftComment ?? null };
        }
      } else if (wishlist.dontGiftMode !== 'hidden') {
        const tokenDontGiftHasContent =
          (tokenProfile?.dontGiftPresets?.length ?? 0) > 0 ||
          (tokenProfile?.dontGiftCustomItems?.length ?? 0) > 0 ||
          !!tokenProfile?.dontGiftComment;
        if (tokenProfile?.dontGiftVisible && tokenDontGiftHasContent) {
          tokenDontGift = { presets: tokenProfile.dontGiftPresets, customItems: tokenProfile.dontGiftCustomItems, comment: tokenProfile.dontGiftComment ?? null };
        }
      }

      const ownerUsernameToken = (wishlist.owner?.profile?.profileVisibility !== 'NOBODY' && wishlist.owner?.profile?.username)
        ? wishlist.owner.profile.username
        : null;

      return res.json({
        wishlist: {
          id: wishlist.id,
          slug: wishlist.slug,
          title: wishlist.title,
          description: wishlist.description,
          deadline: wishlist.deadline,
          ownerName: ownerNameToken,
          ownerUsername: ownerUsernameToken,
        },
        items: sharePlacements.map(p => ({
          ...mapItemForPublic(p.item),
          categoryId: p.categoryId,
        })),
        tags: wishlist.tags,
        categories: (wishlist as any).categories ?? [],
        dontGift: tokenDontGift,
      });
    }),
  );

  // GET /public/profiles/:username — public user profile + public wishlists
  publicRouter.get(
    '/profiles/:username',
    publicReadLimiter,
    asyncHandler(async (req, res) => {
      const username = req.params.username ?? '';
      if (!username) return res.status(400).json({ error: 'Missing username' });

      const profile = await prisma.userProfile.findFirst({
        where: { username: { equals: username, mode: 'insensitive' } },
        select: {
          userId: true,
          displayName: true,
          username: true,
          bio: true,
          avatarUrl: true,
          avatarThumbUrl: true,
          avatarUpdatedAt: true,
          avatarPublic: true,
          profileVisibility: true,
          // Showcase fields
          showcaseEnabled: true,
          showcaseCoverUrl: true,
          showcaseBio: true,
          showcasePinnedIds: true,
          showcasePreferences: true,
          showcaseSizeClothing: true,
          showcaseSizeShoes: true,
          showcaseSizeRing: true,
          showcaseSizeOther: true,
          showcaseChest: true,
          showcaseWaist: true,
          showcaseHips: true,
          showcaseBrands: true,
          showcaseUpdatedAt: true,
          // Anti-gifts (already public via dontGiftVisible)
          dontGiftPresets: true,
          dontGiftCustomItems: true,
          dontGiftComment: true,
          dontGiftVisible: true,
          // Owner telegramId — used to derive god-mode from the env allowlist
          // (the DB godMode column is deprecated; see services/telegram-auth.ts).
          user: { select: { telegramId: true } },
        },
      });
      if (!profile) return res.status(404).json({ error: 'Profile not found' });

      // Respect profileVisibility
      if (profile.profileVisibility === 'NOBODY') {
        return res.status(404).json({ error: 'Profile not found' });
      }

      // For non-ALL visibility, return profile info only (no wishlist list)
      const isPublic = profile.profileVisibility === 'ALL';

      let publicWishlists: Array<{ id: string; slug: string; title: string; deadline: string | null; itemCount: number; reservedCount: number }> = [];
      if (isPublic) {
        const wls = await prisma.wishlist.findMany({
          where: {
            ownerId: profile.userId,
            type: 'REGULAR',
            archivedAt: null,
            visibility: 'PUBLIC_PROFILE',
          },
          orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
          select: {
            id: true, slug: true, title: true, deadline: true,
            items: { where: { status: { in: [...ACTIVE_STATUSES] } }, select: { id: true, status: true } },
          },
        });
        publicWishlists = wls.map((wl) => ({
          id: wl.id,
          slug: wl.slug,
          title: wl.title,
          deadline: wl.deadline?.toISOString() ?? null,
          itemCount: wl.items.length,
          reservedCount: wl.items.filter((i) => i.status !== 'AVAILABLE').length,
        }));
      }

      // Respect avatarPublic — hide avatar URL in public contexts if user set photo to private
      const publicAvatarUrl = profile.avatarPublic ? profile.avatarUrl : null;
      const publicAvatarThumbUrl = profile.avatarPublic ? profile.avatarThumbUrl : null;

      // Showcase: only include when owner is PRO and has opted in.
      // If PRO expired, showcase data is preserved but hidden from public view.
      let showcase: null | {
        coverUrl: string | null;
        bio: string | null;
        pinned: Array<{ id: string; slug: string; title: string; itemCount: number; reservedCount: number }>;
        preferences: string | null;
        sizes: {
          clothing: string | null; shoes: string | null; ring: string | null; other: string | null;
          chest: string | null; waist: string | null; hips: string | null;
        };
        brands: string[];
        antiGift: { presets: string[]; customItems: string[]; comment: string | null } | null;
        updatedAt: string | null;
      } = null;

      if (isPublic && profile.showcaseEnabled) {
        const ownerEnt = await getUserEntitlement(profile.userId, isGodModeTelegramId(profile.user?.telegramId));
        if (ownerEnt.isPro) {
          // Filter pinned IDs to only include wishlists that are still public
          const pinnedSet = new Set(profile.showcasePinnedIds);
          const pinnedOrdered = profile.showcasePinnedIds
            .map((id) => publicWishlists.find((w) => w.id === id))
            .filter((w): w is NonNullable<typeof w> => !!w)
            .slice(0, 3);
          const hasAnySize =
            !!profile.showcaseSizeClothing ||
            !!profile.showcaseSizeShoes ||
            !!profile.showcaseSizeRing ||
            !!profile.showcaseSizeOther ||
            !!profile.showcaseChest ||
            !!profile.showcaseWaist ||
            !!profile.showcaseHips;
          showcase = {
            coverUrl: profile.showcaseCoverUrl,
            bio: profile.showcaseBio,
            pinned: pinnedOrdered.map((w) => ({
              id: w.id,
              slug: w.slug,
              title: w.title,
              itemCount: w.itemCount,
              reservedCount: w.reservedCount,
            })),
            preferences: profile.showcasePreferences,
            sizes: hasAnySize ? {
              clothing: profile.showcaseSizeClothing,
              shoes: profile.showcaseSizeShoes,
              ring: profile.showcaseSizeRing,
              other: profile.showcaseSizeOther,
              chest: profile.showcaseChest,
              waist: profile.showcaseWaist,
              hips: profile.showcaseHips,
            } : { clothing: null, shoes: null, ring: null, other: null, chest: null, waist: null, hips: null },
            brands: profile.showcaseBrands ?? [],
            antiGift: profile.dontGiftVisible && (
              (profile.dontGiftPresets?.length ?? 0) > 0 ||
              (profile.dontGiftCustomItems?.length ?? 0) > 0 ||
              !!profile.dontGiftComment
            ) ? {
              presets: profile.dontGiftPresets ?? [],
              customItems: profile.dontGiftCustomItems ?? [],
              comment: profile.dontGiftComment,
            } : null,
            updatedAt: profile.showcaseUpdatedAt?.toISOString() ?? null,
          };
          // Mark pinned wishlists in the main list so UI can style them
          void pinnedSet;
        }
      }

      return res.json({
        profile: {
          displayName: profile.displayName,
          username: profile.username,
          bio: profile.bio,
          avatarUrl: publicAvatarUrl,
          avatarThumbUrl: publicAvatarThumbUrl,
          avatarUpdatedAt: profile.avatarUpdatedAt?.toISOString() ?? null,
          isPublic,
        },
        wishlists: publicWishlists,
        showcase,
      });
    }),
  );

  // GET /public/selections/:token — public curated selection view
  publicRouter.get(
    '/selections/:token',
    publicReadLimiter,
    asyncHandler(async (req, res) => {
      const token = req.params.token ?? '';
      if (!token) return res.status(400).json({ error: 'Missing token' });

      const selection = await prisma.curatedSelection.findUnique({
        where: { shareToken: token },
        select: {
          id: true, title: true, expiresAt: true, deactivatedAt: true, createdAt: true,
          items: { orderBy: { position: 'asc' }, select: { id: true, title: true, priceText: true, currency: true, imageUrl: true, url: true, description: true, position: true } },
        },
      });
      if (!selection) return res.status(404).json({ error: 'Selection not found' });

      if (selection.deactivatedAt || selection.expiresAt < new Date()) {
        trackEvent('selection_expired_viewed', undefined, { selectionId: selection.id });
        return res.status(410).json({ error: 'expired', expiresAt: selection.expiresAt });
      }

      // Track view — fire-and-forget
      prisma.curatedSelection.update({ where: { shareToken: token }, data: { viewCount: { increment: 1 } } }).catch(() => {});

      trackEvent('selection_viewed', undefined, { selectionId: selection.id });

      return res.json({
        selection: {
          id: selection.id,
          title: selection.title,
          itemCount: selection.items.length,
          expiresAt: selection.expiresAt,
          items: selection.items,
        },
      });
    }),
  );

  publicRouter.post(
    '/items/:id/reserve',
    publicActionLimiter,
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      if (!id) return res.status(400).json({ error: 'Missing item id' });
      const parsed = actorBodySchema
        .extend({ comment: z.string().max(2000).optional() })
        .safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      const result = await prisma.$transaction(async (tx) => {
        const item = await tx.item.findUnique({ where: { id }, select: { status: true } });
        if (!item) return { kind: 'not_found' as const };
        if (item.status !== 'AVAILABLE') return { kind: 'conflict' as const };

        const updated = await tx.item.update({
          where: { id },
          data: { status: 'RESERVED' },
          include: {
            itemTags: { include: { tag: { select: { id: true, name: true } } } },
            reservationEvents: {
              where: { type: 'RESERVED' },
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { comment: true, actorHash: true },
            },
          },
        });

        await tx.reservationEvent.create({
          data: {
            itemId: id,
            type: 'RESERVED',
            actorHash: parsed.data.actorHash,
            comment: parsed.data.comment ?? null,
          },
        });

        return { kind: 'ok' as const, item: updated };
      });

      if (result.kind === 'not_found') return res.status(404).json({ error: 'Item not found' });
      if (result.kind === 'conflict')
        return res.status(409).json({ error: 'Item is not available' });

      trackAnalyticsEvent({ event: 'reservation.succeeded', props: { itemId: id, hasReserverUser: !!parsed.data.actorHash } });

      return res.json({ item: mapItemForPublic(result.item) });
    }),
  );

  publicRouter.post(
    '/items/:id/unreserve',
    publicActionLimiter,
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      if (!id) return res.status(400).json({ error: 'Missing item id' });
      const parsed = actorBodySchema.safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      const result = await prisma.$transaction(async (tx) => {
        const item = await tx.item.findUnique({ where: { id }, select: { status: true } });
        if (!item) return { kind: 'not_found' as const };
        if (item.status !== 'RESERVED') return { kind: 'conflict' as const };

        const lastEvent = await tx.reservationEvent.findFirst({
          where: { itemId: id },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { type: true, actorHash: true },
        });
        if (!lastEvent) return { kind: 'conflict' as const };
        if (lastEvent.type !== 'RESERVED') return { kind: 'conflict' as const };
        if (!secureCompare(lastEvent.actorHash, parsed.data.actorHash))
          return { kind: 'forbidden' as const };

        const updated = await tx.item.update({
          where: { id },
          data: { status: 'AVAILABLE' },
          include: {
            itemTags: { include: { tag: { select: { id: true, name: true } } } },
            reservationEvents: {
              where: { type: 'RESERVED' },
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { comment: true, actorHash: true },
            },
          },
        });

        await tx.reservationEvent.create({
          data: { itemId: id, type: 'UNRESERVED', actorHash: parsed.data.actorHash, comment: null },
        });

        return { kind: 'ok' as const, item: updated };
      });

      if (result.kind === 'not_found') return res.status(404).json({ error: 'Item not found' });
      if (result.kind === 'conflict') return res.status(409).json({ error: 'Cannot unreserve' });
      if (result.kind === 'forbidden') return res.status(403).json({ error: 'Forbidden' });

      return res.json({ item: mapItemForPublic(result.item) });
    }),
  );

  publicRouter.post(
    '/items/:id/purchase',
    publicActionLimiter,
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      if (!id) return res.status(400).json({ error: 'Missing item id' });
      const parsed = actorBodySchema
        .extend({ comment: z.string().max(2000).optional() })
        .safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      const result = await prisma.$transaction(async (tx) => {
        const item = await tx.item.findUnique({ where: { id }, select: { status: true } });
        if (!item) return { kind: 'not_found' as const };
        if (item.status === 'PURCHASED') return { kind: 'conflict' as const };

        const updated = await tx.item.update({
          where: { id },
          data: { status: 'PURCHASED' },
          include: {
            itemTags: { include: { tag: { select: { id: true, name: true } } } },
            reservationEvents: {
              where: { type: 'RESERVED' },
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { comment: true, actorHash: true },
            },
          },
        });

        await tx.reservationEvent.create({
          data: {
            itemId: id,
            type: 'PURCHASED',
            actorHash: parsed.data.actorHash,
            comment: parsed.data.comment ?? null,
          },
        });

        return { kind: 'ok' as const, item: updated };
      });

      if (result.kind === 'not_found') return res.status(404).json({ error: 'Item not found' });
      if (result.kind === 'conflict') return res.status(409).json({ error: 'Item is purchased' });

      return res.json({ item: mapItemForPublic(result.item) });
    }),
  );

  return publicRouter;
}
