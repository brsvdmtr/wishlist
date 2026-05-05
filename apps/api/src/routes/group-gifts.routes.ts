// Telegram-auth router for /tg/group-gifts/* and /tg/items/:id/group-gift —
// 13 handlers covering the entire "Совместный подарок" (group gift) domain:
// create / fetch (by id / by invite token / by item) / join / leave / amount
// update / complete / cancel / pinned info / chat (list + send) / "my".
//
// Mounted via `tgRouter.use(groupGiftsRouter)` in apps/api/src/index.ts
// alongside the other early P5 sub-routers, AFTER the protectTgRoute(...)
// chain at lines 1592–1599 (the seven groupgift-category state-changing
// endpoints). Those `tgRouter.all(...)` middleware fire BEFORE sub-router
// dispatch, so security gates remain in effect.
//
// Same factory pattern as P5a–P5k. Handler bodies are byte-identical to
// their previous in-place definitions in index.ts (lines 11984–12554) —
// only `tgRouter.` -> `groupGiftsRouter.` and indent +2.
//
// Helpers migrated WITH the router (sole consumers — all 13 handlers, 0
// callers outside this block):
//   - mapGroupGift         (formerly index.ts:11907)
//   - groupGiftInclude     (formerly index.ts:11974)
// Both kept at module scope (outside the factory) — they do not depend on
// any factory dep and recreating them per-call would be wasteful.
//
// Helpers that STAY in index.ts (passed via deps):
//   - getOrCreateTgUser           — universal (100+ callers).
//   - getEffectiveEntitlements    — universal (32 callers).
//   - tgActorHash                 — universal.
//   - trackEvent                  — universal.
//   - GROUP_GIFT_PRICE_XTR        — also used by ONE_TIME_SKUS (511) and the
//                                    entitlement function (647–650).
//
// Cross-domain coupling (intentionally byte-identical, NOT refactored here):
//   - POST /items/:id/group-gift mutates Item (status='RESERVED',
//     reservationEpoch++, reserverUserId) and creates a ReservationEvent
//     row inline. Mirror logic of /items/:id/reserve but does NOT call
//     reservation helpers — pre-existing duplication, preserved as-is.
//   - POST /group-gifts/:id/cancel mutates Item (status='AVAILABLE',
//     reserverUserId=null) and creates an UNRESERVED ReservationEvent.
//     Same story.
//   - sendTgNotification used for join/complete/cancel side-effects
//     (organizer / participants). Plain text, no inline keyboards.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '@wishlist/db';

import { asyncHandler } from '../lib/asyncHandler';
import { zodError } from '../lib/http';
import { sendTgNotification } from '../telegram/botApi';

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
type GroupGiftsUser = {
  id: string;
  godMode: boolean;
};

// Structural shape of getEffectiveEntitlements return that POST
// /items/:id/group-gift reads (`.hasGroupGift`).
type GroupGiftsEntitlements = {
  hasGroupGift: boolean;
};

export type GroupGiftsRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<GroupGiftsUser>;
  getEffectiveEntitlements: (userId: string, godMode?: boolean) => Promise<GroupGiftsEntitlements>;
  tgActorHash: (telegramId: number) => string;
  trackEvent: (event: string, userId?: string, props?: Record<string, unknown>) => void;
  GROUP_GIFT_PRICE_XTR: number;
};

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

export function registerGroupGiftsRouter(deps: GroupGiftsRouterDeps): Router {
  const {
    getOrCreateTgUser,
    getEffectiveEntitlements,
    tgActorHash,
    trackEvent,
    GROUP_GIFT_PRICE_XTR,
  } = deps;

  const groupGiftsRouter = Router();

  // POST /tg/items/:id/group-gift — create a group gift for an item
  groupGiftsRouter.post(
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
  groupGiftsRouter.get(
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
  groupGiftsRouter.get(
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
  groupGiftsRouter.post(
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
  groupGiftsRouter.patch(
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
  groupGiftsRouter.post(
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
  groupGiftsRouter.post(
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
  groupGiftsRouter.post(
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
  groupGiftsRouter.patch(
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
  groupGiftsRouter.get(
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
  groupGiftsRouter.post(
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
  groupGiftsRouter.get(
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
  groupGiftsRouter.get(
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

  return groupGiftsRouter;
}
