// Telegram-auth router for /tg/reservations/* and /tg/secret-reservations/*
// (16 handlers total) plus the 3 reservation-lifecycle endpoints on
// /tg/items/:id/* (`reserve`, `unreserve`, `extend-reservation`).
//
// Mounted via `tgRouter.use(reservationsRouter)` in apps/api/src/index.ts
// alongside the other early P5 sub-routers, AFTER the protectTgRoute(...)
// chain at lines 1636–1645 — the chain registers idem + rate-limit
// `tgRouter.all(...)` middleware that fires BEFORE sub-router dispatch, so
// security gates remain in effect.
//
// Same factory pattern as P5a/P5b/P5c/P5d/P5e/P5f/P5g/P5h/P5i. Handler
// bodies are byte-identical to their previous in-place definitions in
// index.ts (lines 2054–2943, 5134–5356) — only `tgRouter.` ->
// `reservationsRouter.` and indent +2.
//
// Helpers migrated WITH this router (sole consumer = handlers below):
//   - requireSecretReservations    (formerly index.ts:682)
//   - buildSecretReservationSnapshot + SecretReservationSnapshot type
//                                  (formerly index.ts:1323/1334)
//   - deriveSecretReservationState + SecretReservationDerivedState type
//                                  (formerly index.ts:1356/1363)
//   - smartResDerive               (formerly index.ts:477)
//
// Helpers that STAY in index.ts (passed via deps because they have other
// consumers in the monolith):
//   - resolveUserFirstName  (line 142) — generic name resolver, will be
//     needed by future items/wishlists extracts; do not migrate per spec §5.
//   - cancelItemHints       (line 166) — hints rule §11, do not migrate.
//   - tgActorHash           (line 386) — also in getItemRole, items routes,
//     group-gifts, admin scheduler.
//   - hasReservationPro — also in me.routes.ts.
//   - hasSmartReservations  — also in PATCH /wishlists/:id (line 3346).
//   - getSmartResLeadHours  — also at index.ts:11475 in admin/scheduler.
//   - mapTgItem / getOrCreateTgUser / getEffectiveEntitlements / trackEvent
//     / trackAnalyticsEvent — universal cross-domain helpers.
//
// Pre-existing security gap (NOT addressed in this PR — Wave-2 follow-up):
//   - POST /secret-reservations/onboarding/seen has no protectTgRoute(...)
//     registration (state-changing UserOnboardingState upsert). All other
//     state-changing endpoints in this router are covered by the chain at
//     index.ts:1534–1543, including /items/:id/extend-reservation.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '@wishlist/db';
import { t, resolveLocaleWithSource } from '@wishlist/shared';

import { asyncHandler } from '../lib/asyncHandler';
import { zodError } from '../lib/http';
import { getRequestLocale } from '../lib/locale';
import { secureCompare } from '../lib/crypto';
import { sendTgBotMessage } from '../telegram/botApi';
import { buildOpenWishKeyboard } from '../notifications/openWishKeyboard';
import { isCrossUserReservation } from '../notifications/crossUserReservation';
import { escapeTgHtml } from '../telegram/html';
import { isGodModeActive } from '../services/telegram-auth';
import { profileToLanguageSettings, resolveUserFirstName } from '../services/locale';
import { recordForeignWishlistAccess } from '../services/foreign-wishlist-access';
import { makeAddonRequired, makePlanLimitReached, makeProRequired, sendPaywall } from '../services/paywall';
import { SECRET_RESERVATION_PRICE_XTR } from '../services/entitlement';
import logger from '../logger';

// Shape of the Telegram initData user object — duplicated from index.ts to
// avoid coupling routes/* to a non-exported local type. Structurally
// equivalent to `TelegramUser` at index.ts:333.
type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

// Minimal structural shape of the User row that handlers in this file read.
// Mirrors the me.routes / onboarding.routes pattern — wider runtime payload
// is fine, this dep contract just narrows what the type-checker enforces.
type ReservationsUser = {
  id: string;
  godMode: boolean;
  telegramId: string | null;
};

// Structural shape of getEffectiveEntitlements return that handlers read.
// Mirrors me.routes.ts:MeEntitlements, with the secret-reservation–specific
// fields (`hasSecretReservations`, `secretReservations`) added because the
// handlers in THIS file consult them via ent.X.
type ReservationsEntitlements = {
  isPro: boolean;
  plan: { participants: number; code: string };
  addOns: Array<{ addonType: string; targetId?: string | null }>;
  hasSecretReservations: boolean;
  secretReservations: { unlocked: boolean; unlockType: 'PRO' | 'ONE_TIME' | 'GOD' | null; priceXtr: number };
};

// Shape of the `owner` payload that resolveUserFirstName consumes — same
// structural type as the helper's parameter at index.ts:142.
type OwnerLike = { id: string; firstName: string | null; telegramChatId: string | null };

// Item shape that mapTgItem at index.ts:1287 consumes. Keep wide on purpose
// so partial selects from the handlers compile against this dep type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MapTgItemFn = (item: any) => any;

// ── Migrated helpers (formerly in index.ts; sole consumer = this router) ──

// Snapshot persisted on the SecretReservation row — frozen view of the Item
// at the time of secret-reserve, used to detect divergence later.
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

export type ReservationsRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<ReservationsUser>;
  getEffectiveEntitlements: (userId: string, godMode?: boolean) => Promise<ReservationsEntitlements>;
  mapTgItem: MapTgItemFn;
  trackEvent: (event: string, userId?: string, props?: Record<string, unknown>) => void;
  trackAnalyticsEvent: (args: { event: string; userId?: string; props?: Record<string, unknown> }) => void;
  tgActorHash: (telegramId: number) => string;
  hasReservationPro: (
    user: { godMode: boolean },
    isPro: boolean,
    addOns?: Array<{ addonType: string }>,
  ) => boolean;
  hasSmartReservations: (
    ownerUser: { godMode: boolean },
    ownerIsPro: boolean,
    ownerAddOns: Array<{ addonType: string; targetId?: string | null }>,
    wishlistId: string,
  ) => boolean;
  cancelItemHints: (itemId: string) => Promise<void>;
  // Smart Reservations: lead-time hours for reminder/expiringSoon by TTL.
  // Consumed by smartResDerive (defined inside this factory below) — index.ts
  // keeps the canonical impl because the admin/scheduler at index.ts:11475
  // uses it too.
  getSmartResLeadHours: (ttlH: number) => number;
};

export function registerReservationsRouter(deps: ReservationsRouterDeps): Router {
  const {
    getOrCreateTgUser,
    getEffectiveEntitlements,
    mapTgItem,
    trackEvent,
    trackAnalyticsEvent,
    tgActorHash,
    hasReservationPro,
    hasSmartReservations,
    cancelItemHints,
    getSmartResLeadHours,
  } = deps;

  // Migrated helper (closes over trackEvent dep). Byte-identical body to the
  // pre-extraction version at index.ts:682.
  function requireSecretReservations(ent: ReservationsEntitlements, res: import('express').Response): boolean {
    if (!ent.hasSecretReservations) {
      trackEvent('feature_gate_hit_secret_reservations');
      sendPaywall(res, 402, makeAddonRequired('secret_reservations', {
        skuCode: 'secret_reservation_unlock',
        priceXtr: SECRET_RESERVATION_PRICE_XTR,
      }));
      return false;
    }
    return true;
  }

  // Reservation PRO gate — centralises the 402 response shape and analytics
  // event so all three call sites (history / meta / reminder) emit the same
  // `feature_gate_hit_reservation_pro` event with the specific sub-feature in
  // props. Mirrors `requireSecretReservations` (status 403 isn't right here —
  // the feature CAN be purchased, so 402 is the correct semantic).
  function requireReservationPro(
    user: ReservationsUser,
    ent: ReservationsEntitlements,
    feature: 'reservation_history' | 'reservation_meta' | 'reservation_reminder',
    res: import('express').Response,
  ): boolean {
    if (hasReservationPro(user, ent.isPro, ent.addOns)) return true;
    trackEvent('feature_gate_hit_reservation_pro', user.id, { feature });
    sendPaywall(res, 402, makeProRequired(feature, { planCode: ent.isPro ? 'PRO' : 'FREE' }));
    return false;
  }

  // Migrated helper (closes over getSmartResLeadHours dep). Byte-identical
  // body to the pre-extraction version at index.ts:477.
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

  const reservationsRouter = Router();

  // GET /tg/reservations — items reserved by current user across all wishlists
  reservationsRouter.get(
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

      return res.json({ reservations, reservationPro: resPro });
    }),
  );

  // GET /tg/reservations/history — past reservations (completed, unreserved, archived)
  reservationsRouter.get(
    '/reservations/history',
    asyncHandler(async (req, res) => {
      const locale = getRequestLocale(req);
      const user = await getOrCreateTgUser(req.tgUser!);
      const ent = await getEffectiveEntitlements(user.id, user.godMode);
      if (!requireReservationPro(user, ent, 'reservation_history', res)) return;

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
  reservationsRouter.get(
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
  reservationsRouter.get(
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
  reservationsRouter.post(
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

      // Foreign-wishlist access history (feeds global search). Fire-and-forget.
      void recordForeignWishlistAccess({ userId: user.id, wishlistId: item.wishlistId, source: 'reservation' })
        .catch(() => { /* non-critical */ });

      trackEvent('secret_res.created', user.id, { itemId: id, secretReservationId: created.id });
      return res.json({ id: created.id, alreadyReserved: false });
    }),
  );

  // POST /tg/secret-reservations/:id/cancel — cancel (soft-delete)
  reservationsRouter.post(
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
  reservationsRouter.post(
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
  reservationsRouter.post(
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
          select: {
            telegramChatId: true,
            profile: { select: { languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } },
          },
        });
        // Skip self-notification (bookmark flow); see isCrossUserReservation
        // for the policy reasoning.
        if (owner?.telegramChatId && isCrossUserReservation(user.id, itemData.wishlist.ownerId)) {
          // Recipient = owner. Reserver's request locale is irrelevant; resolve
          // the owner's effective locale from their persisted profile (no live
          // ctx for the owner here).
          const { locale: notifLocale } = resolveLocaleWithSource(
            profileToLanguageSettings(owner.profile),
          );
          // Same inline "Open wish" button as the public-reserve path: the
          // user-facing event is identical ("your wish was reserved") and
          // owners benefit from the same one-tap navigation.
          void sendTgBotMessage(
            owner.telegramChatId,
            t('notif_reserved', notifLocale, { name: escapeTgHtml(displayName), title: escapeTgHtml(result.title) }),
            buildOpenWishKeyboard(row.itemId, notifLocale),
          );
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
  reservationsRouter.post(
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
  reservationsRouter.get(
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
  reservationsRouter.patch(
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
      if (!requireReservationPro(user, ent, 'reservation_meta', res)) return;

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
  reservationsRouter.post(
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
      if (!requireReservationPro(user, ent, 'reservation_reminder', res)) return;

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
  reservationsRouter.delete(
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

  // POST /tg/items/:id/reserve — guest reserves (name stored as comment for other guests to see)
  reservationsRouter.post(
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
          // Foreign user god-mode = owner's env eligibility AND the owner's own
          // `godModeActive` toggle, so an operator dogfooding as a normal user
          // also sees their wishlist behave with normal-user limits for guests
          // (see services/telegram-auth.ts isGodModeActive). The DB `godMode`
          // column is deprecated and not read.
          const ownerUser = await tx.user.findUnique({ where: { id: wishlist.ownerId }, select: { telegramId: true, godModeActive: true } });
          const ownerGodMode = isGodModeActive(ownerUser?.telegramId, ownerUser?.godModeActive);
          const ownerEnt = await getEffectiveEntitlements(wishlist.ownerId, ownerGodMode);
          const activeReservations = await tx.item.findMany({
            where: { wishlistId: item.wishlistId, status: 'RESERVED' },
            select: { reserverUserId: true },
            distinct: ['reserverUserId'],
          });
          const existingReserverIds = new Set(
            activeReservations.map((r) => r.reserverUserId).filter(Boolean),
          );
          if (!existingReserverIds.has(user.id) && existingReserverIds.size >= ownerEnt.plan.participants) {
            return {
              kind: 'participant_limit' as const,
              limit: ownerEnt.plan.participants,
              ownerId: wishlist.ownerId,
              ownerPlan: ownerEnt.plan.code,
              count: existingReserverIds.size,
            };
          }
          // Smart Reservations: double-check both toggle AND owner entitlement
          if (wishlist.smartReservationsEnabled) {
            smartRes = hasSmartReservations(
              { godMode: ownerGodMode }, ownerEnt.isPro, ownerEnt.addOns, item.wishlistId
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
      if (result.kind === 'participant_limit') {
        // Owner-attributed: it's the owner's plan ceiling that blocked the
        // reservation, and the owner is the upgrade candidate — not the guest.
        // Status is 409 (state conflict) because the requester (guest) cannot
        // buy PRO for the owner; the unified paywall contract reserves 402
        // for "requester can buy/upgrade".
        trackEvent('feature_gate_hit_participant_limit', result.ownerId, {
          plan: result.ownerPlan,
          count: result.count,
          limit: result.limit,
        });
        return sendPaywall(res, 409, makePlanLimitReached('participant_limit', {
          limit: result.limit,
          current: result.count,
        }));
      }

      if (result.kind === 'ok') {
        // Notify owner
        const itemData = await prisma.item.findUnique({
          where: { id },
          select: { title: true, wishlist: { select: { ownerId: true, smartResTtlHours: true, smartResAllowExtend: true, smartResMaxExtensions: true } } },
        });
        if (itemData) {
          const owner = await prisma.user.findUnique({
            where: { id: itemData.wishlist.ownerId },
            select: {
              telegramChatId: true,
              profile: { select: { languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } },
            },
          });
          // Skip self-notification (bookmark flow); see isCrossUserReservation
          // for the policy reasoning.
          if (owner?.telegramChatId && isCrossUserReservation(user.id, itemData.wishlist.ownerId)) {
            // Recipient = owner. Resolve owner's locale from persisted profile
            // — reserver's request locale is irrelevant for owner's notification.
            const { locale: notifLocale } = resolveLocaleWithSource(
              profileToLanguageSettings(owner.profile),
            );
            // Inline "Open wish" button deep-links straight to the item-detail
            // screen — owner can see context (who reserved, comments) without
            // hunting through wishlists. Stale-state handling lives in the
            // Mini App parser (item_ branch in MiniApp.tsx).
            void sendTgBotMessage(
              owner.telegramChatId,
              t('notif_reserved', notifLocale, { name: escapeTgHtml(displayName), title: escapeTgHtml(itemData.title) }),
              buildOpenWishKeyboard(id, notifLocale),
            );
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

        // Foreign-wishlist access history (feeds global search). Fire-and-forget;
        // helper short-circuits silently on own_wishlist / archived / private.
        void recordForeignWishlistAccess({ userId: user.id, wishlistId: result.wishlistId, source: 'reservation' })
          .catch(() => { /* non-critical */ });
      }

      trackAnalyticsEvent({ event: 'reservation.succeeded', userId: user.id, props: { itemId: req.params.id } });

      // Cancel active hints when item is reserved
      void cancelItemHints(id);

      return res.json({ ok: true, expiresAt: result.kind === 'ok' ? result.smartResExpiresAt?.toISOString() ?? null : null });
    }),
  );

  // POST /tg/items/:id/unreserve — guest unreserves their own reservation
  reservationsRouter.post(
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

      const unreserveUser = await getOrCreateTgUser(req.tgUser!);
      trackAnalyticsEvent({ event: 'reservation.cancelled', userId: unreserveUser.id, props: { itemId: req.params.id } });

      // Mark ReservationMeta as inactive (history)
      void prisma.reservationMeta.updateMany({
        where: { itemId: id, reserverUserId: unreserveUser.id, active: true },
        data: { active: false, endedAt: new Date(), endReason: 'unreserved' },
      }).catch(() => {});

      return res.json({ ok: true });
    }),
  );

  // POST /tg/items/:id/extend-reservation — gifter extends their smart reservation
  reservationsRouter.post(
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

  return reservationsRouter;
}
