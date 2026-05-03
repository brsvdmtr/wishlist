// Telegram-auth router for /tg/birthday-reminders/* (4 user-facing) and
// /tg/admin/birthday-reminders/metrics (god-mode dashboard) — 5 handlers
// total. Combined into one file because all 5 share the BirthdayReminder*
// Prisma tables and the same closure deps; the admin metrics handler
// uses the same TG auth chain (tgRouter, in-handler god-mode check),
// not the X-ADMIN-KEY chain in admin.routes.
//
// Mounted via `tgRouter.use(birthdayRemindersRouter)` in
// apps/api/src/index.ts AFTER the BIRTHDAY_REMINDERS_ENABLED const and
// the two helper function declarations (TDZ-relocation, see
// the comment block at the wiring site). The protectTgRoute() chain
// for POST /birthday-reminders/mute and DELETE
// /birthday-reminders/mute/:userId stays in index.ts (registered on
// tgRouter early, before this sub-router) so the path-scoped
// idempotency middleware fires before the handlers here.
//
// Helpers BIRTHDAY_REMINDERS_ENABLED, daysUntilNextBirthday, and
// pickBirthdayDisplayName are intentionally NOT migrated — they are
// shared with the scheduler/job code (processBirthdayReminders, etc.)
// in index.ts. Pulling them out of index.ts would break the scheduler
// which is explicitly out of scope for this refactor. They flow
// through this router via `deps`.

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '@wishlist/db';

import { asyncHandler } from '../lib/asyncHandler';
import { zodError } from '../lib/http';

type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

// Minimal structural shape of the User row that the 5 handlers read.
type BirthdayUser = {
  id: string;
  godMode: boolean;
};

// Args that pickBirthdayDisplayName accepts in the resolve handler.
type BirthdayDisplayNameArgs = {
  displayName: string | null;
  username: string | null;
  firstName?: string | null;
};

export type BirthdayRemindersRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<BirthdayUser>;
  trackEvent: (event: string, userId?: string, props?: Record<string, unknown>) => void;
  // Kill-switch read by the admin metrics handler. Stays a closure dep so
  // the scheduler can keep using the same const directly from index.ts.
  BIRTHDAY_REMINDERS_ENABLED: boolean;
  // Pure utility, used by the resolve handler to compute "days until next
  // birthday" for the response payload. Same fn the scheduler uses for
  // candidate selection.
  daysUntilNextBirthday: (birthday: Date | null, now: Date) => number | null;
  // Pure utility, used by the resolve handler to build the recipient-side
  // display name. Same fn the scheduler uses when composing DM bodies.
  pickBirthdayDisplayName: (p: BirthdayDisplayNameArgs) => string;
};

export function registerBirthdayRemindersRouter(deps: BirthdayRemindersRouterDeps): Router {
  const {
    getOrCreateTgUser,
    trackEvent,
    BIRTHDAY_REMINDERS_ENABLED,
    daysUntilNextBirthday,
    pickBirthdayDisplayName,
  } = deps;

  const birthdayRemindersRouter = Router();

  // GET /tg/birthday-reminders/muted — list of muted users
  birthdayRemindersRouter.get('/birthday-reminders/muted', asyncHandler(async (req, res) => {
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
  birthdayRemindersRouter.post('/birthday-reminders/mute', asyncHandler(async (req, res) => {
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
  birthdayRemindersRouter.delete('/birthday-reminders/mute/:userId', asyncHandler(async (req, res) => {
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
  birthdayRemindersRouter.get('/birthday-reminders/resolve/:deliveryId', asyncHandler(async (req, res) => {
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
  birthdayRemindersRouter.get('/admin/birthday-reminders/metrics', asyncHandler(async (req, res) => {
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

  return birthdayRemindersRouter;
}
