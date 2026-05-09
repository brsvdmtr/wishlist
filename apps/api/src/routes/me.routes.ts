// Telegram-auth router for /tg/me/* endpoints. Mounted via
// `tgRouter.use(meRouter)` in apps/api/src/index.ts (the `/me` prefix lives
// on each handler — Variant B in the P5a audit, chosen to keep handler
// bodies byte-identical to their previous in-place definitions).
//
// Auth chain comes from the parent tgRouter middleware (ipThrottleGate,
// requireTelegramAuth, locale, global rate-limiter, maintenance gate);
// this file MUST NOT add or skip any of that.
//
// Same factory pattern as ./internal.routes / ./admin.routes / ./public.routes:
// every helper / schema / constant the handler bodies still reference
// from index.ts is passed via `deps` and destructured at the top so the
// bodies do not need any `deps.X` rewriting.

import { Router } from 'express';
import { z } from 'zod';
import { prisma, Prisma, loadReferralConfig } from '@wishlist/db';
import {
  t,
  resolveEffectiveLocale,
  MARKET_BUCKET_LABELS,
  type Locale,
  type MarketBucket,
} from '@wishlist/shared';

import { asyncHandler } from '../lib/asyncHandler';
import { zodError } from '../lib/http';
import { getRequestLocale } from '../lib/locale';
import { getOrCreateProfile } from '../profile.js';
import { upload } from '../uploads/upload.config';
import { processImage } from '../uploads/imageProcessor';
import { deleteUploadFile } from '../uploads/uploadCleanup';

// Shape of the Telegram initData user object — duplicated from index.ts to
// avoid coupling routes/* to a non-exported local type. Structurally
// equivalent.
type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

// Minimal structural shape of the User row that handlers in this file
// actually read. Wider runtime payload is fine — narrowing here keeps the
// dep contract small and avoids dragging the full Prisma User type.
type MeUser = {
  id: string;
  godMode: boolean;
  telegramId: string | null;
  themePreference: string | null;
  accentPreference: string | null;
};

// Structural shape of getEffectiveEntitlements return that handlers read.
// Mutable Array on addOns so it can be passed straight to hasReservationPro
// (which keeps its index.ts-side `Array<...>` signature). seasonalWishlists
// is a real Set (the runtime builds it via `new Set<string>(...)`); typed as
// ReadonlySet so the handler's spread `[...ent.seasonalWishlists]` keeps
// compiling. Fields the handlers only pass through to JSON (subscription,
// proSource, promoPro) are typed wide.
type MeEntitlements = {
  isPro: boolean;
  plan: { code: string; items: number; participants: number; features: readonly string[] };
  effectiveWishlistLimit: number;
  effectiveSubscriptionLimit: number;
  subscription: Record<string, unknown> | null;
  proSource: string | null;
  promoPro: { id: string; expiresAt: string | null; campaignCode: string } | null;
  addOns: Array<{ addonType: string; quantity: number }>;
  seasonalWishlists: ReadonlySet<string>;
  hintCredits: number;
  importCredits: number;
};

export type MeRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<MeUser>;
  getEffectiveEntitlements: (userId: string, godMode?: boolean) => Promise<MeEntitlements>;
  // Only `.isPro` is read in /me/* handlers — everything else stays in the
  // billing/Pro routers when those split out.
  getUserEntitlement: (userId: string, godMode?: boolean) => Promise<{ isPro: boolean }>;
  hasReservationPro: (
    user: { telegramId?: string | null; godMode: boolean },
    isPro: boolean,
    addOns?: Array<{ addonType: string }>,
  ) => boolean;
  isReservationBeta: (user: { telegramId?: string | null; godMode: boolean }) => boolean;
  trackEvent: (event: string, userId?: string, props?: Record<string, unknown>) => void;
  // Same narrow tuple type as in publicRouterDeps so Prisma's ItemStatus[]
  // overload resolves correctly when this is spread into a `where` clause.
  ACTIVE_STATUSES: readonly ('AVAILABLE' | 'RESERVED' | 'PURCHASED')[];
  PRO_PRICE_XTR: number;
  PRO_YEARLY_PRICE_XTR: number;
  PRO_LIFETIME_PRICE_XTR: number;
  ONE_TIME_SKUS: Readonly<Record<string, {
    code: string;
    price: number;
    type: string;
    targetRequired: boolean;
  }>>;
};

export function registerMeRouter(deps: MeRouterDeps): Router {
  const {
    getOrCreateTgUser,
    getEffectiveEntitlements,
    getUserEntitlement,
    hasReservationPro,
    isReservationBeta,
    trackEvent,
    ACTIVE_STATUSES,
    PRO_PRICE_XTR,
    PRO_YEARLY_PRICE_XTR,
    PRO_LIFETIME_PRICE_XTR,
    ONE_TIME_SKUS,
  } = deps;

  const meRouter = Router();

  // ─── Subscriptions ─────────────────────────────────────────────────
  // GET /tg/me/subscriptions — wishlists the user is subscribed to, with unread counts
  meRouter.get(
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
  meRouter.get(
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
  meRouter.post(
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
  meRouter.get(
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

  // ─── Plan ──────────────────────────────────────────────────────────
  // GET /tg/me/plan — current user's plan, subscription, effective limits, and add-ons
  meRouter.get(
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
        proLifetimePriceStars: PRO_LIFETIME_PRICE_XTR,
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

  // ─── Profile + avatar ──────────────────────────────────────────────
  // GET /tg/me/profile — user profile with stats
  meRouter.get(
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
  meRouter.patch(
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
  meRouter.post(
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
  meRouter.delete(
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

  // ─── Birthday settings ─────────────────────────────────────────────
  // GET /tg/me/birthday-settings
  meRouter.get('/me/birthday-settings', asyncHandler(async (req, res) => {
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
  meRouter.patch('/me/birthday-settings', asyncHandler(async (req, res) => {
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

  // ─── Showcase ──────────────────────────────────────────────────────
  // GET /tg/me/showcase — current showcase data + eligible wishlists for pinning
  meRouter.get(
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
  meRouter.patch(
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
  meRouter.post(
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
  meRouter.delete(
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

  // ─── Settings + active links ───────────────────────────────────────
  // GET /tg/me/settings — user settings
  meRouter.get(
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
  meRouter.get(
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
  meRouter.patch(
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

  // ─── Don't gift ────────────────────────────────────────────────────
  // GET /tg/me/dont-gift — return current "Don't Gift" preferences
  meRouter.get(
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
  meRouter.put(
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

  // ─── Account + god-mode ────────────────────────────────────────────
  // DELETE /tg/me/account — delete user and all related data
  meRouter.delete(
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
  meRouter.post(
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

  // ─── God-stats ─────────────────────────────────────────────────────
  // GET /tg/me/god-stats — internal analytics dashboard (god mode users only)
  // Double-gated: user must be in GOD_MODE_TELEGRAM_IDS whitelist AND have godMode=true.
  // Active user definition (7d / 30d):
  //   A user is "active" if within the period they created or updated a REGULAR wishlist
  //   OR created or updated any non-deleted item — proxies real product usage from existing
  //   entity timestamps without requiring a dedicated event log.
  // Share proxy: users with ≥1 wishlist where shareToken was explicitly generated.
  // Reservation funnel step: users who *received* ≥1 reservation on their wishlist items
  //   (semantic: "your wishlist had real engagement from another person").
  meRouter.get(
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

  // ─── Retention analytics ───────────────────────────────────────────
  // ─── Retention Analytics (god mode only) ─────────────────────────────────────
  
  // GET /tg/me/retention-stats — lifecycle/winback analytics dashboard
  // Filters out godMode/test users from production metrics.
  meRouter.get(
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
  meRouter.get(
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

  return meRouter;
}
