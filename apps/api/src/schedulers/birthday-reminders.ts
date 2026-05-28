// Birthday reminders scheduler (P5r-6) — extracted from
// apps/api/src/index.ts. Hourly cron + 30s startup kick that drives
// the birthday-reminders feature: scans UserProfile rows, computes
// MSK-day matches per offset, creates BirthdayReminderDelivery rows,
// and sends Telegram DMs via bot API.
//
// Two delivery flows, both fed by the same scheduler:
//   1. FRIEND  — followers/connected users get a DM 14d/7d/1d/today
//                before the birthday user's birthday, with a CTA opening
//                the Mini App on the birthday user's primary public
//                wishlist (or profile if no public wishlist).
//   2. OWNER   — the birthday user themself gets nudged 30d before to
//                update their wishlist, plus 14d/7d if there's a
//                "problem" (no public wishlist OR public wishlist has
//                no active items), plus a soft congratulations on the
//                day-of with no urgency CTA.
//
// Pro vs Free split:
//   - 14d + today friend windows + 30d + today owner windows: FREE
//   - 7d + 1d friend windows + 14d + 7d owner windows: PRO (gated via
//     birthdayAdvancedWindowsEnabled)
//   - audience EXTENDED, primary wishlist, custom message: PRO
//
// Eligibility (friend reminders):
//   ONLY explicit relationships count as recipients:
//     - ProfileSubscription.subscriberId
//     - WishlistSubscription.subscriberId on a non-NOBODY wishlist
//     - reservers of the birthday user's public-facing wishlist items
//     - commenters on the birthday user's public-facing wishlist items
//   NEVER: passive views, share-link opens, etc.
//
// Daily cap (per recipient): MAX_FRIEND_REMINDERS_PER_DAY. Excess goes
// to `deferred` status with `deferredUntil = next MSK 10:00`.
//
// Cadence (60 * 60 * 1000), startup +30s, send-window 9–22 MSK,
// occurrence-key dedupe via unique
// (birthdayUserId, recipientUserId, occurrenceKey, reminderKind),
// audience tiers, daily cap, ServiceHeartbeat metadata, Telegram
// message templates, AnalyticsEvent names, log labels, and structured
// fields preserved byte-identical for ops continuity.
//
// Pure helpers (timezone math, occurrence key, display name) live in
// ../services/birthday-reminders.ts because they are also consumed by
// apps/api/src/routes/birthday-reminders.routes.ts via the deps
// factory (P5e contract preserved).
//
// `BIRTHDAY_REMINDERS_ENABLED` is the kill-switch (env-derived in
// index.ts) and flows in via deps so a real prod incident can be
// rolled back without redeploy.

import type { PrismaClient } from '@wishlist/db';
import type { Logger } from 'pino';
import {
  t,
  pluralize,
  resolveLocaleWithSource,
  type Locale,
} from '@wishlist/shared';
import {
  BIRTHDAY_TZ_OFFSET_HOURS,
  getMskBirthdayDay,
  getMskToday,
  daysUntilNextBirthday,
  buildOccurrenceKey,
  nextMskMorning,
  pickBirthdayDisplayName,
} from '../services/birthday-reminders';
import { profileToLanguageSettings } from '../services/locale';
import { escapeTgHtml } from '../telegram/html';

// Structural narrow over the real `getEffectiveEntitlements` return
// shape — the birthday scheduler only reads `isPro`. Matches the
// byte-identical predicate `ent.isPro` used in maybeCreateOwnerDelivery,
// maybeCreateFriendDeliveries, and sendBirthdayDelivery.
type GetEffectiveEntitlements = (userId: string, godMode?: boolean) => Promise<{ isPro: boolean }>;

type TgActorHash = (telegramId: number) => string;

type TrackEvent = (event: string, userId?: string, props?: Record<string, unknown>) => void;

export type BirthdayRemindersSchedulerDeps = {
  prisma: PrismaClient;
  logger: Logger;
  getEffectiveEntitlements: GetEffectiveEntitlements;
  tgActorHash: TgActorHash;
  trackEvent: TrackEvent;
  BIRTHDAY_REMINDERS_ENABLED: boolean;
};

const BIRTHDAY_SEND_HOUR_MSK_MIN = 9;  // earliest delivery hour in MSK
const BIRTHDAY_SEND_HOUR_MSK_MAX = 22; // latest delivery hour in MSK
const BIRTHDAY_RECIPIENT_DAILY_CAP = 3;     // max friend reminders received per recipient per MSK day
// (weekly cap intentionally dropped — at current scale daily cap + dedup is
// sufficient. Re-add a 7-day rolling cap here if recipients legitimately have
// 10+ birthdays a week from their explicit-relationship audience.)
const BIRTHDAY_BATCH_BIRTHDAY_USERS = 30;   // max birthday users processed per scheduler tick
const BIRTHDAY_BATCH_RECIPIENTS = 100;      // max recipients per birthday user per tick
const BIRTHDAY_RETRY_LOOKBACK_HOURS = 24;   // retry pending/deferred records up to this old

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
      ? t('bot_br_friend_intro_today', locale, { name: escapeTgHtml(birthdayDisplayName) })
      : t('bot_br_friend_intro_days', locale, { days: daysUntil, dayWord, name: escapeTgHtml(birthdayDisplayName) });
    if (delivery.targetType === 'wishlist') {
      body = isToday ? t('bot_br_friend_body_today', locale) : t('bot_br_friend_body_wishlist', locale);
    } else {
      body = t('bot_br_friend_body_no_wishlist', locale);
    }
    lines.push(intro);
    if (customMessage && customMessage.trim().length > 0) {
      lines.push(t('bot_br_friend_custom_message_wrap', locale, { message: escapeTgHtml(customMessage.trim()) }));
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

export function startBirthdayRemindersScheduler(deps: BirthdayRemindersSchedulerDeps): void {
  const {
    prisma, logger,
    getEffectiveEntitlements, tgActorHash, trackEvent,
    BIRTHDAY_REMINDERS_ENABLED,
  } = deps;

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

    // Recipient (may equal birthday user for owner reminders). Same query
    // shape in both cases — privacy / opt-out branching happens below.
    const recipient = await prisma.user.findUnique({
      where: { id: d.recipientUserId },
      select: { id: true, telegramChatId: true, profile: { select: { notifyBirthdays: true, languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } } },
    });
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

    // Build message — proactive cron, no live ctx. Resolver chain falls back
    // through persisted normalizedLocale / language captured by middleware.
    const { locale: recipientLocale, source: recipientLocaleSource } = resolveLocaleWithSource(
      profileToLanguageSettings(recipient.profile),
    );

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
      logger.debug({ deliveryId: d.id, kind: d.reminderKind, locale: recipientLocale, localeSource: recipientLocaleSource }, 'birthday: delivery sent');
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
}
