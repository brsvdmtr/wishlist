// P0.3 «Событийные пуши» — event-driven bot notifications service.
//
// Owns the whole pipeline "domain event → rule → send" for the Circles graph:
//   • enqueue* helpers  — called from route hooks / the upcoming-events scan;
//     write one `EventNotification` outbox row per (event, recipient), idempotent
//     via the unique `dedupeKey`.
//   • flushDueEventNotifications — called by schedulers/event-notifications.ts;
//     groups PENDING rows per (recipient × circle), applies per-type opt-out +
//     circle mute + quiet hours + daily cap, renders ONE Telegram message, and
//     marks the rows SENT/SUPPRESSED.
//
// Anti-spam is the whole point (sloppy pushes = bot bans + opt-outs), so the
// timing/grouping/quiet-hours/cap logic is factored into PURE helpers that are
// unit-tested in isolation; the DB-touching flush is integration-tested against
// real Postgres (dedup races, grouping, deferral are constraint-dependent).
//
// Kill switch: EVENT_NOTIFICATIONS_ENABLED=false disables enqueue + flush
// without a redeploy (env read at call time). Default ON.

import { Prisma, prisma } from '@wishlist/db';
import type { Logger } from 'pino';
import {
  t,
  pluralize,
  resolveLocaleWithSource,
  profileToLanguageSettings,
  type Locale,
} from '@wishlist/shared';

import { escapeTgHtml } from '../telegram/html';
import { daysUntilNextBirthday } from './birthday-reminders';
import {
  buildCircleDetailDeepLink,
  buildCircleMemberDeepLink,
} from '../telegram/deepLinks';

// ── Types ─────────────────────────────────────────────────────────────────────

export type EventNotificationType =
  | 'EVENT_UPCOMING_7D'
  | 'EVENT_UPCOMING_3D'
  | 'NEW_WISH'
  | 'RESERVATION_CHANGED'
  | 'CIRCLE_JOINED';

export type ReservationChangeKind = 'edited' | 'removed';

/** Render inputs captured at enqueue time (JSON column). All optional so the
 *  renderer stays pure and tolerant of partial payloads. */
export interface EventNotifPayload {
  actorName?: string;
  memberId?: string;
  itemTitle?: string;
  daysUntil?: number;
  changeKind?: ReservationChangeKind;
  circleName?: string;
}

interface RenderRow {
  type: EventNotificationType;
  payload: EventNotifPayload;
}

type RenderTarget =
  | { kind: 'circle'; circleId: string }
  | { kind: 'member'; circleId: string; memberId: string };

// ── Constants ─────────────────────────────────────────────────────────────────

/** Grouping window per type (minutes): how long an event waits to collect
 *  siblings before the bucket flushes. New wishes get a long window (batch a
 *  burst of additions); joins / reservation changes are near-immediate. */
export const GROUP_WINDOW_MINUTES: Record<EventNotificationType, number> = {
  EVENT_UPCOMING_7D: 5,
  EVENT_UPCOMING_3D: 5,
  NEW_WISH: 60,
  RESERVATION_CHANGED: 5,
  CIRCLE_JOINED: 5,
};

/** Max messages delivered to one recipient in a rolling 24h window. */
export const DAILY_MESSAGE_CAP = 5;
/** When the cap is hit, push the bucket forward by this much and re-check. */
const CAP_DEFER_MINUTES = 90;
/** Max grouping buckets processed per flush tick (back-pressure). */
const MAX_GROUPS_PER_TICK = 50;
/** Send attempts before a transient-failing bucket is given up (burned). */
const MAX_SEND_ATTEMPTS = 3;
/** Re-defer delay after a transient send failure. */
const TRANSIENT_RETRY_MINUTES = 10;
/** Terminal rows older than this are purged to bound table growth. */
const RETENTION_DAYS = 30;
/** Hard floor: ANY row this old is stale and dropped, so a perpetually-deferred
 *  PENDING bucket (e.g. a recipient permanently over the daily cap) can't live
 *  forever or fire a week-late push. */
const STALE_DAYS = 7;
/** Fallback timezone when the recipient has no notifyTimezone (RU-centric app). */
export const DEFAULT_TIMEZONE = 'Europe/Moscow';
/** Max bullet lines in a grouped message before "…and N more". */
const MAX_GROUP_LINES = 6;

function eventNotificationsEnabled(): boolean {
  return process.env.EVENT_NOTIFICATIONS_ENABLED !== 'false';
}

// ── Pure time helpers (unit-tested) ───────────────────────────────────────────

/** "HH:mm" → minutes since midnight, or null if malformed. */
export function parseHHmm(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return hh * 60 + mm;
}

/** Minutes since local midnight for `now` in the given IANA tz. Falls back to
 *  MSK (UTC+3) when the tz is invalid/unknown so a bad value never throws. */
export function localMinutesInTz(now: Date, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    return (hh % 24) * 60 + mm;
  } catch {
    const mskMs = now.getTime() + 3 * 3600_000;
    const d = new Date(mskMs);
    return d.getUTCHours() * 60 + d.getUTCMinutes();
  }
}

/** Is `localMin` inside the quiet window [start, end)? Handles a window that
 *  wraps midnight (e.g. 22:00 → 09:00). start === end means "no window". */
export function isWithinQuietHours(localMin: number, startMin: number, endMin: number): boolean {
  if (startMin === endMin) return false;
  if (startMin < endMin) return localMin >= startMin && localMin < endMin;
  return localMin >= startMin || localMin < endMin; // wraps midnight
}

/** Whole minutes from `localMin` until the next occurrence of `endMin`
 *  (wall-clock; DST shifts inside the window are ignored — negligible for a
 *  retention push). Always ≥ 1 so a deferral makes forward progress. */
export function minutesUntilQuietEnd(localMin: number, endMin: number): number {
  const diff = (endMin - localMin + 1440) % 1440;
  return diff === 0 ? 1440 : diff;
}

/** UTC YYYY-MM-DD — coarse day bucket for dedupe keys. */
export function utcDayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

// ── Dedupe keys (pure) ────────────────────────────────────────────────────────

export const dedupeKeys = {
  newWish: (itemId: string, recipientId: string) => `nw:${itemId}:${recipientId}`,
  reservationChanged: (itemId: string, recipientId: string, kind: ReservationChangeKind, dayKey: string) =>
    `rc:${itemId}:${recipientId}:${kind}:${dayKey}`,
  circleJoined: (circleId: string, actorId: string, dayKey: string) => `cj:${circleId}:${actorId}:${dayKey}`,
  eventUpcoming: (threshold: '7' | '3', birthdayUserId: string, recipientId: string, year: number) =>
    `eu:${threshold}:${birthdayUserId}:${recipientId}:${year}`,
};

// ── Message rendering (pure, unit-tested) ─────────────────────────────────────

const TYPE_TO_PREF: Record<EventNotificationType, 'events' | 'newWishes' | 'reservations' | 'joins'> = {
  EVENT_UPCOMING_7D: 'events',
  EVENT_UPCOMING_3D: 'events',
  NEW_WISH: 'newWishes',
  RESERVATION_CHANGED: 'reservations',
  CIRCLE_JOINED: 'joins',
};

function actorOrFallback(name: string | undefined, locale: Locale): string {
  const esc = escapeTgHtml(name?.trim() ?? '');
  return esc || t('api_user_fallback', locale);
}

function wishNoun(count: number, locale: Locale): string {
  return pluralize(
    count,
    t('cnotif_wish_one', locale),
    t('cnotif_wish_few', locale),
    t('cnotif_wish_many', locale),
    locale,
  );
}

/**
 * Render the message for a grouping bucket. Pure: given the kept rows + circle
 * context + locale, returns the HTML text and the deep-link target. Three cases:
 *   1 row              → the per-type single template.
 *   N rows, all NEW_WISH from one member → "N new wishes from {name}".
 *   mixed              → a grouped header + bullet lines (→ circle).
 */
export function renderEventMessage(
  rows: RenderRow[],
  ctx: { locale: Locale; circleId: string; circleName: string },
): { text: string; target: RenderTarget } | null {
  if (rows.length === 0) return null;
  const { locale, circleId } = ctx;
  const circleName = escapeTgHtml(ctx.circleName ?? '');

  if (rows.length === 1) {
    const r = rows[0]!;
    const p = r.payload;
    const name = actorOrFallback(p.actorName, locale);
    const member: RenderTarget = { kind: 'member', circleId, memberId: p.memberId ?? '' };
    const circle: RenderTarget = { kind: 'circle', circleId };
    switch (r.type) {
      case 'EVENT_UPCOMING_7D':
        return { text: t('cnotif_event_7d', locale, { name }), target: member };
      case 'EVENT_UPCOMING_3D':
        return { text: t('cnotif_event_3d', locale, { name }), target: member };
      case 'NEW_WISH':
        return { text: t('cnotif_new_wish', locale, { name, title: escapeTgHtml(p.itemTitle ?? '') }), target: member };
      case 'RESERVATION_CHANGED':
        return {
          text: t(p.changeKind === 'removed' ? 'cnotif_reservation_removed' : 'cnotif_reservation_edited', locale, { name }),
          target: circle,
        };
      case 'CIRCLE_JOINED':
        return { text: t('circle_join_notif', locale, { name, circle: circleName }), target: circle };
    }
  }

  // Many rows — all new wishes from a single member → a focused "N wishes" push.
  const allNewWish = rows.every((r) => r.type === 'NEW_WISH');
  const memberIds = new Set(rows.map((r) => r.payload.memberId ?? ''));
  if (allNewWish && memberIds.size === 1) {
    const p = rows[0]!.payload;
    const name = actorOrFallback(p.actorName, locale);
    const count = rows.length;
    return {
      text: t('cnotif_new_wishes_many', locale, { name, count, noun: wishNoun(count, locale) }),
      target: { kind: 'member', circleId, memberId: p.memberId ?? '' },
    };
  }

  // Mixed bucket → grouped header + bullet lines, opens the circle.
  const lines: string[] = [];
  const newWishByMember = new Map<string, { name: string; count: number }>();
  for (const r of rows) {
    if (r.type !== 'NEW_WISH') continue;
    const key = r.payload.memberId ?? r.payload.actorName ?? '';
    const e = newWishByMember.get(key) ?? { name: r.payload.actorName ?? '', count: 0 };
    e.count += 1;
    newWishByMember.set(key, e);
  }
  for (const e of newWishByMember.values()) {
    const name = actorOrFallback(e.name, locale);
    lines.push(
      e.count === 1
        ? t('cnotif_line_new_wish_one', locale, { name })
        : t('cnotif_line_new_wish_many', locale, { name, count: e.count, noun: wishNoun(e.count, locale) }),
    );
  }
  for (const r of rows) {
    const name = actorOrFallback(r.payload.actorName, locale);
    if (r.type === 'EVENT_UPCOMING_7D' || r.type === 'EVENT_UPCOMING_3D') {
      const days = r.payload.daysUntil ?? (r.type === 'EVENT_UPCOMING_7D' ? 7 : 3);
      lines.push(t('cnotif_line_event', locale, { name, days }));
    } else if (r.type === 'RESERVATION_CHANGED') {
      lines.push(t('cnotif_line_reservation', locale, { name }));
    } else if (r.type === 'CIRCLE_JOINED') {
      lines.push(t('cnotif_line_joined', locale, { name }));
    }
  }

  const shown = lines.slice(0, MAX_GROUP_LINES);
  let body = shown.map((l) => `• ${l}`).join('\n');
  if (lines.length > MAX_GROUP_LINES) {
    body += `\n${t('cnotif_group_more', locale, { count: lines.length - MAX_GROUP_LINES })}`;
  }
  return {
    text: `${t('cnotif_group_header', locale, { circle: circleName })}\n${body}`,
    target: { kind: 'circle', circleId },
  };
}

// ── Enqueue primitive ─────────────────────────────────────────────────────────

interface EnqueueParams {
  recipientUserId: string;
  circleId: string | null;
  type: EventNotificationType;
  dedupeKey: string;
  payload: EventNotifPayload;
  now: Date;
}

/** Write one outbox row. Returns false (no-op) when the dedupeKey already
 *  exists — the unique-index P2002 is the idempotency mechanism. */
async function enqueueEventNotification(params: EnqueueParams): Promise<boolean> {
  const windowMin = GROUP_WINDOW_MINUTES[params.type];
  const groupUntil = new Date(params.now.getTime() + windowMin * 60_000);
  const groupKey = `${params.recipientUserId}:${params.circleId ?? ''}`;
  try {
    await prisma.eventNotification.create({
      data: {
        recipientUserId: params.recipientUserId,
        circleId: params.circleId,
        type: params.type,
        dedupeKey: params.dedupeKey,
        payload: params.payload as unknown as Prisma.InputJsonValue,
        groupKey,
        groupUntil,
      },
    });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return false;
    throw err;
  }
}

async function resolveDisplayName(userId: string): Promise<string> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { firstName: true, profile: { select: { displayName: true } } },
  });
  return u?.profile?.displayName?.trim() || u?.firstName?.trim() || '';
}

// ── High-level enqueue helpers (called from domain hooks) ─────────────────────

/** A circle member added a wish to a list shared into a circle → notify the
 *  other active members (deduped one-per-item-per-recipient across circles). */
export async function enqueueNewWishFromItem(params: {
  itemId: string;
  wishlistId: string;
  actorUserId: string;
  now?: Date;
}): Promise<void> {
  if (!eventNotificationsEnabled()) return;
  const now = params.now ?? new Date();

  const shares = await prisma.circleWishlistShare.findMany({
    where: { wishlistId: params.wishlistId },
    select: { circleId: true, circle: { select: { name: true } } },
  });
  if (shares.length === 0) return;

  const item = await prisma.item.findUnique({
    where: { id: params.itemId },
    select: { title: true, status: true },
  });
  if (!item || (item.status !== 'AVAILABLE' && item.status !== 'RESERVED' && item.status !== 'PURCHASED')) return;

  const actorName = await resolveDisplayName(params.actorUserId);

  for (const share of shares) {
    const members = await prisma.circleMembership.findMany({
      where: { circleId: share.circleId, status: 'ACTIVE', userId: { not: params.actorUserId } },
      select: { userId: true },
    });
    for (const m of members) {
      await enqueueEventNotification({
        recipientUserId: m.userId,
        circleId: share.circleId,
        type: 'NEW_WISH',
        dedupeKey: dedupeKeys.newWish(params.itemId, m.userId),
        payload: { actorName, memberId: params.actorUserId, itemTitle: item.title, circleName: share.circle.name },
        now,
      });
    }
  }
}

/** An item with circle reservations was edited / removed by its owner → warn
 *  the gifters who reserved it (surprise-preserving: owner is never told). */
export async function enqueueReservationChangedForItem(params: {
  itemId: string;
  changeKind: ReservationChangeKind;
  now?: Date;
}): Promise<void> {
  if (!eventNotificationsEnabled()) return;
  const now = params.now ?? new Date();

  const reservations = await prisma.circleReservation.findMany({
    where: { itemId: params.itemId },
    select: { reserverUserId: true, circleId: true, circle: { select: { name: true } } },
  });
  if (reservations.length === 0) return;

  const item = await prisma.item.findUnique({
    where: { id: params.itemId },
    select: { title: true, wishlist: { select: { ownerId: true } } },
  });
  if (!item) return;
  const ownerName = await resolveDisplayName(item.wishlist.ownerId);
  const dayKey = utcDayKey(now);

  for (const r of reservations) {
    await enqueueEventNotification({
      recipientUserId: r.reserverUserId,
      circleId: r.circleId,
      type: 'RESERVATION_CHANGED',
      dedupeKey: dedupeKeys.reservationChanged(params.itemId, r.reserverUserId, params.changeKind, dayKey),
      payload: {
        actorName: ownerName,
        memberId: item.wishlist.ownerId,
        itemTitle: item.title,
        changeKind: params.changeKind,
        circleName: r.circle.name,
      },
      now,
    });
  }
}

/** Someone joined a circle → notify the owner (already an explicit relationship;
 *  replaces the inline send that used to live in circles.routes.ts). */
export async function enqueueCircleJoined(params: {
  circleId: string;
  recipientUserId: string;
  actorUserId: string;
  actorName: string;
  circleName: string;
  now?: Date;
}): Promise<void> {
  if (!eventNotificationsEnabled()) return;
  const now = params.now ?? new Date();
  await enqueueEventNotification({
    recipientUserId: params.recipientUserId,
    circleId: params.circleId,
    type: 'CIRCLE_JOINED',
    dedupeKey: dedupeKeys.circleJoined(params.circleId, params.actorUserId, utcDayKey(now)),
    payload: { actorName: params.actorName, circleName: params.circleName },
    now,
  });
}

/** Hourly scan: enqueue EVENT_UPCOMING for circle co-members whose birthday is
 *  exactly 7 or 3 days away. Year-keyed dedupe → fires once per threshold/year. */
export async function scanUpcomingEvents(now: Date = new Date()): Promise<{ enqueued: number }> {
  if (!eventNotificationsEnabled()) return { enqueued: 0 };
  const year = now.getUTCFullYear();

  const memberships = await prisma.circleMembership.findMany({
    where: { status: 'ACTIVE' },
    select: {
      circleId: true,
      userId: true,
      circle: { select: { name: true } },
      user: { select: { firstName: true, profile: { select: { displayName: true, birthday: true } } } },
    },
  });

  const byCircle = new Map<string, typeof memberships>();
  for (const m of memberships) {
    const arr = byCircle.get(m.circleId) ?? [];
    arr.push(m);
    byCircle.set(m.circleId, arr);
  }

  let enqueued = 0;
  for (const [circleId, members] of byCircle) {
    const circleName = members[0]?.circle.name ?? '';
    for (const bday of members) {
      const d = daysUntilNextBirthday(bday.user.profile?.birthday ?? null, now);
      if (d !== 7 && d !== 3) continue;
      const threshold: '7' | '3' = d === 7 ? '7' : '3';
      const type: EventNotificationType = d === 7 ? 'EVENT_UPCOMING_7D' : 'EVENT_UPCOMING_3D';
      const actorName = bday.user.profile?.displayName?.trim() || bday.user.firstName?.trim() || '';
      for (const recip of members) {
        if (recip.userId === bday.userId) continue;
        const created = await enqueueEventNotification({
          recipientUserId: recip.userId,
          circleId,
          type,
          dedupeKey: dedupeKeys.eventUpcoming(threshold, bday.userId, recip.userId, year),
          payload: { actorName, memberId: bday.userId, daysUntil: d, circleName },
          now,
        });
        if (created) enqueued += 1;
      }
    }
  }
  return { enqueued };
}

// ── Flush (DB-touching, integration-tested) ──────────────────────────────────

const PROFILE_SELECT = {
  notifyCircleEvents: true,
  notifyCircleNewWishes: true,
  notifyCircleReservationChanges: true,
  notifyCircleJoins: true,
  quietHoursEnabled: true,
  quietHoursStart: true,
  quietHoursEnd: true,
  notifyTimezone: true,
  languageMode: true,
  manualLanguage: true,
  normalizedLocale: true,
  language: true,
} as const;

type ProfileSlice = {
  notifyCircleEvents: boolean;
  notifyCircleNewWishes: boolean;
  notifyCircleReservationChanges: boolean;
  notifyCircleJoins: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  notifyTimezone: string | null;
  languageMode: string;
  manualLanguage: string | null;
  normalizedLocale: string | null;
  language: string | null;
} | null;

function prefAllows(type: EventNotificationType, profile: ProfileSlice): boolean {
  if (!profile) return true; // no profile row → defaults are all-on
  switch (TYPE_TO_PREF[type]) {
    case 'events': return profile.notifyCircleEvents;
    case 'newWishes': return profile.notifyCircleNewWishes;
    case 'reservations': return profile.notifyCircleReservationChanges;
    case 'joins': return profile.notifyCircleJoins;
  }
}

export type FlushDeps = {
  logger: Logger;
  sendTgBotMessage: (chatId: string, text: string, replyMarkup?: Record<string, unknown>) => Promise<boolean>;
  now?: Date;
};

async function markStatus(ids: string[], status: 'SENT' | 'SUPPRESSED', delivered: boolean, sentAt: Date | null): Promise<void> {
  if (ids.length === 0) return;
  await prisma.eventNotification.updateMany({ where: { id: { in: ids } }, data: { status, delivered, sentAt } });
}

/** Return claimed (SENDING) rows to PENDING with a new flush time (used for
 *  quiet-hours / cap / transient-failure deferral). */
async function deferRows(ids: string[], groupUntil: Date, incrementAttempts: boolean): Promise<void> {
  if (ids.length === 0) return;
  await prisma.eventNotification.updateMany({
    where: { id: { in: ids } },
    data: incrementAttempts
      ? { status: 'PENDING', groupUntil, attempts: { increment: 1 } }
      : { status: 'PENDING', groupUntil },
  });
}

async function countMessagesSentSince(recipientUserId: string, since: Date): Promise<number> {
  // One delivered message marks every row in its bucket with the SAME sentAt,
  // so distinct (groupKey, sentAt) pairs = distinct messages.
  const groups = await prisma.eventNotification.groupBy({
    by: ['groupKey', 'sentAt'],
    where: { recipientUserId, status: 'SENT', delivered: true, sentAt: { gte: since } },
  });
  return groups.length;
}

type GroupOutcome = { sent: number; suppressed: number; deferred: number };

async function flushOneGroup(deps: FlushDeps, groupKey: string, now: Date): Promise<GroupOutcome> {
  // Atomic claim: flip this bucket's PENDING rows to SENDING in one statement so
  // a concurrent flush tick (or a second API instance) can't also grab them and
  // double-send. The loser's updateMany matches 0 rows and bails.
  const claim = await prisma.eventNotification.updateMany({
    where: { groupKey, status: 'PENDING' },
    data: { status: 'SENDING' },
  });
  if (claim.count === 0) return { sent: 0, suppressed: 0, deferred: 0 };

  const rows = await prisma.eventNotification.findMany({
    where: { groupKey, status: 'SENDING' },
    orderBy: { createdAt: 'asc' },
  });
  if (rows.length === 0) return { sent: 0, suppressed: 0, deferred: 0 };

  const recipientUserId = rows[0]!.recipientUserId;
  const circleId = rows[0]!.circleId;
  const allIds = rows.map((r) => r.id);

  const recipient = await prisma.user.findUnique({
    where: { id: recipientUserId },
    select: { telegramChatId: true, profile: { select: PROFILE_SELECT } },
  });
  // No chat to deliver to → drop (suppress) rather than retry forever.
  if (!recipient?.telegramChatId) {
    await markStatus(allIds, 'SUPPRESSED', false, now);
    return { sent: 0, suppressed: rows.length, deferred: 0 };
  }
  const profile = recipient.profile as ProfileSlice;

  // Circle mute / membership gate.
  if (circleId) {
    const membership = await prisma.circleMembership.findUnique({
      where: { circleId_userId: { circleId, userId: recipientUserId } },
      select: { status: true, mutedAt: true },
    });
    if (!membership || membership.status !== 'ACTIVE' || membership.mutedAt) {
      await markStatus(allIds, 'SUPPRESSED', false, now);
      return { sent: 0, suppressed: rows.length, deferred: 0 };
    }
  }

  // Per-type opt-out.
  const keep = rows.filter((r) => prefAllows(r.type as EventNotificationType, profile));
  const drop = rows.filter((r) => !prefAllows(r.type as EventNotificationType, profile));
  if (drop.length) await markStatus(drop.map((r) => r.id), 'SUPPRESSED', false, now);
  if (keep.length === 0) return { sent: 0, suppressed: drop.length, deferred: 0 };
  const keepIds = keep.map((r) => r.id);

  // Quiet hours → defer the kept rows to the window's end (back to PENDING).
  if (profile?.quietHoursEnabled ?? true) {
    const tz = profile?.notifyTimezone || DEFAULT_TIMEZONE;
    const localMin = localMinutesInTz(now, tz);
    const startMin = parseHHmm(profile?.quietHoursStart) ?? 22 * 60;
    const endMin = parseHHmm(profile?.quietHoursEnd) ?? 9 * 60;
    if (isWithinQuietHours(localMin, startMin, endMin)) {
      await deferRows(keepIds, new Date(now.getTime() + minutesUntilQuietEnd(localMin, endMin) * 60_000), false);
      return { sent: 0, suppressed: drop.length, deferred: keep.length };
    }
  }

  // Daily cap (rolling 24h) → defer (back to PENDING).
  const since = new Date(now.getTime() - 24 * 3600_000);
  if ((await countMessagesSentSince(recipientUserId, since)) >= DAILY_MESSAGE_CAP) {
    await deferRows(keepIds, new Date(now.getTime() + CAP_DEFER_MINUTES * 60_000), false);
    return { sent: 0, suppressed: drop.length, deferred: keep.length };
  }

  // Render + send.
  const { locale } = resolveLocaleWithSource(profileToLanguageSettings(profile));
  const circle = circleId ? await prisma.circle.findUnique({ where: { id: circleId }, select: { name: true } }) : null;
  const render = renderEventMessage(
    keep.map((r) => ({ type: r.type as EventNotificationType, payload: r.payload as unknown as EventNotifPayload })),
    { locale, circleId: circleId ?? '', circleName: circle?.name ?? '' },
  );
  if (!render) {
    await markStatus(keepIds, 'SUPPRESSED', false, now);
    return { sent: 0, suppressed: drop.length + keep.length, deferred: 0 };
  }

  const url =
    render.target.kind === 'member'
      ? buildCircleMemberDeepLink(render.target.circleId, render.target.memberId)
      : buildCircleDetailDeepLink(render.target.circleId);
  const buttonText = render.target.kind === 'member' ? t('cnotif_btn_open_list', locale) : t('notif_open_circle_btn', locale);

  const delivered = await deps.sendTgBotMessage(recipient.telegramChatId, render.text, {
    inline_keyboard: [[{ text: buttonText, web_app: { url } }]],
  });
  if (delivered) {
    await markStatus(keepIds, 'SENT', true, now);
    return { sent: 1, suppressed: drop.length, deferred: 0 };
  }
  // Not delivered: `sendTgBotMessage` returns false for BOTH a transient outage
  // and a terminal rejection (bot blocked). We can't distinguish, so retry a
  // bounded number of times (re-defer), then give up — never an infinite loop,
  // never a silent single-blip loss of a 60-min digest.
  // Attempts are tracked per-bucket (the whole group shares one send), not
  // per-row: a row enqueued into an already-failing bucket inherits its attempt
  // count. Intentional — a bucket fails because the chat is unreachable, so
  // there's no value retrying a fresh row in it more times.
  const reachedMax = Math.max(...keep.map((r) => r.attempts)) + 1 >= MAX_SEND_ATTEMPTS;
  if (reachedMax) {
    await markStatus(keepIds, 'SENT', false, now);
    return { sent: 0, suppressed: drop.length, deferred: 0 };
  }
  await deferRows(keepIds, new Date(now.getTime() + TRANSIENT_RETRY_MINUTES * 60_000), true);
  return { sent: 0, suppressed: drop.length, deferred: keep.length };
}

/** Process all due grouping buckets. Best-effort: a failing group is logged and
 *  skipped, never bubbles. Returns aggregate counts for the scheduler log. */
export async function flushDueEventNotifications(
  deps: FlushDeps,
): Promise<{ groups: number; messagesSent: number; suppressed: number; deferred: number }> {
  if (!eventNotificationsEnabled()) return { groups: 0, messagesSent: 0, suppressed: 0, deferred: 0 };
  const now = deps.now ?? new Date();

  // Reclaim rows orphaned in SENDING by a crashed prior tick. Safe because the
  // scheduler runs flush single-threaded (re-entrancy guard) and we're single-
  // instance today; a future multi-instance deploy would key this by a lease.
  await prisma.eventNotification.updateMany({ where: { status: 'SENDING' }, data: { status: 'PENDING' } });

  const due = await prisma.eventNotification.findMany({
    where: { status: 'PENDING', groupUntil: { lte: now } },
    orderBy: { createdAt: 'asc' },
    take: 500,
    select: { groupKey: true },
  });
  const groupKeys = [...new Set(due.map((d) => d.groupKey))].slice(0, MAX_GROUPS_PER_TICK);

  let groups = 0;
  let messagesSent = 0;
  let suppressed = 0;
  let deferred = 0;
  for (const groupKey of groupKeys) {
    try {
      const res = await flushOneGroup(deps, groupKey, now);
      groups += 1;
      messagesSent += res.sent;
      suppressed += res.suppressed;
      deferred += res.deferred;
    } catch (err) {
      deps.logger.error({ err, groupKey }, 'event-notifications: group flush failed');
    }
  }
  return { groups, messagesSent, suppressed, deferred };
}

/** Bound table growth: delete terminal (SENT / SUPPRESSED) rows past the
 *  retention window, plus ANY row past the stale floor (a fresh PENDING/SENDING
 *  bucket that never delivered for a week — e.g. perpetual cap deferral — is
 *  noise, not a push worth firing late). */
export async function purgeOldEventNotifications(now: Date = new Date()): Promise<number> {
  const terminalCutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 3600_000);
  const staleCutoff = new Date(now.getTime() - STALE_DAYS * 24 * 3600_000);
  const res = await prisma.eventNotification.deleteMany({
    where: {
      OR: [
        { status: { in: ['SENT', 'SUPPRESSED'] }, createdAt: { lt: terminalCutoff } },
        { createdAt: { lt: staleCutoff } },
      ],
    },
  });
  return res.count;
}

// ── Preferences read/update (consumed by the routes layer) ───────────────────

export interface NotificationPreferences {
  notifyCircleEvents: boolean;
  notifyCircleNewWishes: boolean;
  notifyCircleReservationChanges: boolean;
  notifyCircleJoins: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
  notifyTimezone: string | null;
}

const PREF_DEFAULTS: NotificationPreferences = {
  notifyCircleEvents: true,
  notifyCircleNewWishes: true,
  notifyCircleReservationChanges: true,
  notifyCircleJoins: true,
  quietHoursEnabled: true,
  quietHoursStart: '22:00',
  quietHoursEnd: '09:00',
  notifyTimezone: null,
};

export async function getNotificationPreferences(userId: string): Promise<NotificationPreferences> {
  const profile = await prisma.userProfile.findUnique({
    where: { userId },
    select: {
      notifyCircleEvents: true,
      notifyCircleNewWishes: true,
      notifyCircleReservationChanges: true,
      notifyCircleJoins: true,
      quietHoursEnabled: true,
      quietHoursStart: true,
      quietHoursEnd: true,
      notifyTimezone: true,
    },
  });
  return profile ?? PREF_DEFAULTS;
}

/** Validate + persist a partial preference patch. Returns the full new state.
 *  Throws `Error('invalid_time')` on a malformed HH:mm so the route can 400. */
export async function updateNotificationPreferences(
  userId: string,
  patch: Partial<NotificationPreferences>,
): Promise<NotificationPreferences> {
  const data: Record<string, unknown> = {};
  for (const key of ['notifyCircleEvents', 'notifyCircleNewWishes', 'notifyCircleReservationChanges', 'notifyCircleJoins', 'quietHoursEnabled'] as const) {
    if (typeof patch[key] === 'boolean') data[key] = patch[key];
  }
  for (const key of ['quietHoursStart', 'quietHoursEnd'] as const) {
    const v = patch[key];
    if (v !== undefined) {
      if (typeof v !== 'string' || parseHHmm(v) === null) throw new Error('invalid_time');
      data[key] = v;
    }
  }
  if (patch.notifyTimezone !== undefined) {
    const tz = patch.notifyTimezone;
    if (tz !== null) {
      if (typeof tz !== 'string' || tz.length > 64) throw new Error('invalid_timezone');
      // Reject anything Intl can't resolve so junk never lands in the column
      // (a bad tz would silently fall back to MSK in localMinutesInTz).
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
      } catch {
        throw new Error('invalid_timezone');
      }
    }
    data.notifyTimezone = tz;
  }

  // Upsert so a user without a profile row still gets preferences persisted
  // (avoids the getOrCreateProfile race — single atomic upsert).
  await prisma.userProfile.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });
  return getNotificationPreferences(userId);
}
