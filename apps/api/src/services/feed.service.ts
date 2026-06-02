// Home feed (P0.2 — «Главная → лента близких») service layer.
//
// Aggregates a single ranked feed for the Mini App home from three sources,
// all scoped to the viewer's Circles (Близкие):
//   1. EVENTS    — upcoming birthdays of circle co-members (profile.birthday),
//                  the same source the Circles screen already surfaces. Within
//                  EVENT_HORIZON_DAYS.
//   2. ACTIVITY  — wishes added / changed by co-members in their circle-shared
//                  lists within ACTIVITY_WINDOW_DAYS (Item.createdAt/updatedAt).
//   3. RESERVATIONS — the viewer's OWN CircleReservations (gifts they're
//                  planning), with the recipient's event countdown.
//
// ── Surprise invariant ───────────────────────────────────────────────────────
// This endpoint can NEVER leak who reserved the caller's wishes. It only ever
// reads CircleReservation rows WHERE reserverUserId = viewer (the caller's own
// reservations) and never attaches reservation state to event/activity preview
// items. A wish owner calling /tg/feed sees only the gifts THEY are planning for
// others — never reservations made against their own list. Mirrors the rule in
// circles.service.ts (`mapCircleItemForViewer`).
//
// Ranking (per the P0.2 spec): event proximity > change freshness > reservation
// state. Today's events float to the very top (smallest daysUntil). Pure,
// unit-tested helpers (`deriveUrgency`, `rankFeedItems`) hold the ordering so a
// regression is caught without a DB.

import { prisma } from '@wishlist/db';

import { daysUntilNextBirthday } from './birthday-reminders';

// ── Tunable horizons ─────────────────────────────────────────────────────────

/** Birthdays within this many days produce an event card. ~2 months of runway. */
export const EVENT_HORIZON_DAYS = 60;
/** Items created/updated within this window produce an activity card. */
export const ACTIVITY_WINDOW_DAYS = 14;
/** A reservation produces a "don't forget" card only when the recipient's event
 *  is within this many days. All reservations still count in the summary block. */
export const RESERVATION_REMINDER_HORIZON_DAYS = 45;
/** Hard cap on returned feed items (the dataset is naturally small — a handful
 *  of circles × members — so this is a safety ceiling, not real pagination). */
export const FEED_ITEM_CAP = 60;
/** Newest items fetched per shared list — bounds the per-list scan. Covers the
 *  3 preview thumbs + the ACTIVITY_WINDOW_DAYS change detection comfortably.
 *  Exact totals come from a separate bounded count (`groupBy`), not this slice. */
export const FEED_PREVIEW_FETCH = 24;

/** Item statuses visible inside a circle (active wishes only). Mirrors
 *  circles.service.ts VISIBLE_ITEM_STATUSES. */
const VISIBLE_ITEM_STATUSES = ['AVAILABLE', 'RESERVED', 'PURCHASED'] as const;

// ── Wire types (mirrored in apps/web/.../screens/feed/FeedRoot.tsx) ───────────

export type CircleTypeValue = 'FAMILY' | 'FRIENDS' | 'COLLEAGUES' | 'COUPLE';
export type FeedUrgency = 'today' | 'soon' | 'upcoming';

export interface FeedPerson {
  name: string;
  avatarUrl: string | null;
}
export interface FeedPreviewItem {
  id: string;
  title: string;
  imageUrl: string | null;
}
export interface FeedCircleChip {
  id: string;
  name: string;
  emoji: string | null;
  type: CircleTypeValue;
}

export interface FeedEventItem {
  kind: 'event';
  id: string;
  circleId: string;
  circleName: string;
  memberUserId: string;
  person: FeedPerson;
  eventKind: 'birthday';
  eventDate: string; // ISO (UTC midnight of next occurrence)
  daysUntil: number; // >= 0
  urgency: FeedUrgency;
  itemCount: number;
  previewItems: FeedPreviewItem[];
}
export interface FeedActivityItem {
  kind: 'activity';
  id: string;
  circleId: string;
  circleName: string;
  memberUserId: string;
  person: FeedPerson;
  addedCount: number;
  updatedCount: number;
  at: string; // ISO of most recent change
  itemCount: number;
  previewItems: FeedPreviewItem[];
}
export interface FeedReservationItem {
  kind: 'reservation';
  id: string;
  circleId: string;
  circleName: string;
  itemId: string;
  itemTitle: string;
  itemImageUrl: string | null;
  forUserId: string;
  forName: string;
  daysUntilEvent: number | null;
}
export type FeedItem = FeedEventItem | FeedActivityItem | FeedReservationItem;

export interface FeedResponse {
  hasCircles: boolean;
  circles: FeedCircleChip[];
  items: FeedItem[];
  reservations: { count: number; names: string[] };
  generatedAt: string;
  nextCursor: string | null;
}

// ── Pure helpers (exported for unit tests) ───────────────────────────────────

/** Bucket a day-count into the styling/ranking urgency band. */
export function deriveUrgency(daysUntil: number): FeedUrgency {
  if (daysUntil <= 0) return 'today';
  if (daysUntil <= 3) return 'soon';
  return 'upcoming';
}

/**
 * Rank feed items per the spec: events (by proximity asc) → activity (by
 * freshness desc) → reservations (by recipient-event proximity asc, unknown
 * last). Stable within ties. Returns a NEW sorted array.
 */
export function rankFeedItems(items: FeedItem[]): FeedItem[] {
  const tier = (it: FeedItem): number => (it.kind === 'event' ? 0 : it.kind === 'activity' ? 1 : 2);
  const secondary = (it: FeedItem): number => {
    if (it.kind === 'event') return it.daysUntil; // smaller = sooner = higher
    if (it.kind === 'activity') return -new Date(it.at).getTime(); // newer = higher
    return it.daysUntilEvent ?? Number.POSITIVE_INFINITY; // sooner event = higher, unknown last
  };
  return items
    .map((it, idx) => ({ it, idx }))
    .sort((a, b) => {
      const t = tier(a.it) - tier(b.it);
      if (t !== 0) return t;
      const s = secondary(a.it) - secondary(b.it);
      if (s !== 0) return s;
      return a.idx - b.idx; // stable
    })
    .map((x) => x.it);
}

function displayName(user: { firstName: string | null; profile: { displayName: string | null } | null }): string {
  return user.profile?.displayName?.trim() || user.firstName?.trim() || 'Кто-то';
}

function toPreview(items: Array<{ id: string; title: string; imageUrl: string | null }>): FeedPreviewItem[] {
  return items.slice(0, 3).map((it) => ({ id: it.id, title: it.title, imageUrl: it.imageUrl }));
}

// ── Main ─────────────────────────────────────────────────────────────────────

/**
 * Build the home feed for a viewer. `circleId`, when provided, scopes the feed
 * content to that one circle (the chip filter); the `circles` chip list always
 * reflects ALL the viewer's circles so the filter UI stays complete.
 */
export async function getFeed(params: { viewerId: string; circleId?: string | null; now?: Date }): Promise<FeedResponse> {
  const { viewerId } = params;
  // `now` is injectable so date-dependent behaviour (MSK event-date anchoring,
  // activity window) is deterministically testable; production passes none.
  const now = params.now ?? new Date();

  // All active memberships → chip list + the full circle scope.
  const memberships = await prisma.circleMembership.findMany({
    where: { userId: viewerId, status: 'ACTIVE' },
    select: { circle: { select: { id: true, name: true, emoji: true, type: true } } },
  });
  const hasCircles = memberships.length > 0;
  const circles: FeedCircleChip[] = memberships.map((m) => ({
    id: m.circle.id,
    name: m.circle.name,
    emoji: m.circle.emoji,
    type: m.circle.type as CircleTypeValue,
  }));
  const allCircleIds = circles.map((c) => c.id);

  // Content scope: one circle if a valid filter was passed, else all.
  const filterId = params.circleId && allCircleIds.includes(params.circleId) ? params.circleId : null;
  const scopeCircleIds = filterId ? [filterId] : allCircleIds;

  if (scopeCircleIds.length === 0) {
    return { hasCircles, circles, items: [], reservations: { count: 0, names: [] }, generatedAt: now.toISOString(), nextCursor: null };
  }

  const circleNameById = new Map(circles.map((c) => [c.id, c.name]));

  const [members, shares, reservations] = await Promise.all([
    // Co-members of scope circles (excluding me) with birthday + avatar.
    prisma.circleMembership.findMany({
      where: { circleId: { in: scopeCircleIds }, status: 'ACTIVE', NOT: { userId: viewerId } },
      select: {
        circleId: true,
        userId: true,
        user: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true, birthday: true } } } },
      },
    }),
    // Shared lists in scope circles → their visible items (one pass; derive
    // event previews + activity in JS — the set is small and bounded).
    prisma.circleWishlistShare.findMany({
      where: { circleId: { in: scopeCircleIds } },
      select: {
        circleId: true,
        wishlist: {
          select: {
            id: true,
            ownerId: true,
            // Bounded: the N most-recently-TOUCHED visible items per shared
            // list. Ordered by updatedAt (not createdAt) so an old wish that was
            // edited recently still lands in the slice → its update surfaces as
            // activity. Exact totals come from a separate count, not this slice.
            items: {
              where: { status: { in: [...VISIBLE_ITEM_STATUSES] } },
              orderBy: { updatedAt: 'desc' },
              take: FEED_PREVIEW_FETCH,
              select: { id: true, title: true, imageUrl: true, createdAt: true, updatedAt: true },
            },
          },
        },
      },
    }),
    // The viewer's OWN circle reservations (surprise-safe — never others').
    prisma.circleReservation.findMany({
      where: { reserverUserId: viewerId, circleId: { in: scopeCircleIds } },
      select: {
        id: true,
        circleId: true,
        item: {
          select: {
            id: true,
            title: true,
            imageUrl: true,
            wishlist: {
              select: {
                ownerId: true,
                owner: { select: { firstName: true, profile: { select: { displayName: true, birthday: true } } } },
              },
            },
          },
        },
      },
    }),
  ]);

  // Active co-members + shared owners per circle — used to (a) attribute events
  // and (b) drop reservations whose recipient left the circle / un-shared their
  // lists (else the card would deep-link into a 404 → MemberView dead-loader).
  const activeMemberSet = new Set(members.map((m) => `${m.circleId}:${m.userId}`));
  const sharedMemberSet = new Set(shares.map((s) => `${s.circleId}:${s.wishlist.ownerId}`));

  // Accurate visible-item counts per shared list (one bounded row per list) —
  // the `take`-bounded items above can't be trusted for totals.
  const sharedWishlistIds = [...new Set(shares.map((s) => s.wishlist.id))];
  const countRows = sharedWishlistIds.length
    ? await prisma.item.groupBy({
        by: ['wishlistId'],
        where: { wishlistId: { in: sharedWishlistIds }, status: { in: [...VISIBLE_ITEM_STATUSES] } },
        _count: { _all: true },
      })
    : [];
  const countByWishlist = new Map(countRows.map((r) => [r.wishlistId, r._count._all]));

  // Index shared items + accurate totals by (circleId, ownerId).
  type SharedItem = { id: string; title: string; imageUrl: string | null; createdAt: Date; updatedAt: Date };
  const itemsByCircleMember = new Map<string, SharedItem[]>();
  const countByCircleMember = new Map<string, number>();
  for (const s of shares) {
    const key = `${s.circleId}:${s.wishlist.ownerId}`;
    const arr = itemsByCircleMember.get(key) ?? [];
    arr.push(...s.wishlist.items);
    itemsByCircleMember.set(key, arr);
    countByCircleMember.set(key, (countByCircleMember.get(key) ?? 0) + (countByWishlist.get(s.wishlist.id) ?? 0));
  }

  // MSK-anchored "today" so the displayed event date matches the MSK-based
  // countdown (daysUntilNextBirthday) — avoids a UTC/MSK off-by-one near midnight.
  const mskMidnightUtc = (() => {
    const msk = new Date(now.getTime() + 3 * 3600_000);
    return Date.UTC(msk.getUTCFullYear(), msk.getUTCMonth(), msk.getUTCDate());
  })();
  const activityCutoff = now.getTime() - ACTIVITY_WINDOW_DAYS * 86400_000;

  // ── EVENTS — one card per member (dedup across circles, prefer the circle
  //    where they shared the most items so "Выбрать подарок" lands on wishes).
  const eventByMember = new Map<string, FeedEventItem>();
  for (const m of members) {
    const days = daysUntilNextBirthday(m.user.profile?.birthday ?? null, now);
    if (days == null || days > EVENT_HORIZON_DAYS) continue;
    const key = `${m.circleId}:${m.userId}`;
    const shared = (itemsByCircleMember.get(key) ?? []).slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const itemCount = countByCircleMember.get(key) ?? shared.length;
    const prev = eventByMember.get(m.userId);
    if (prev && prev.itemCount >= itemCount) continue; // keep the circle where they shared more
    const eventDate = new Date(mskMidnightUtc + days * 86400_000);
    eventByMember.set(m.userId, {
      kind: 'event',
      id: `event:${m.circleId}:${m.userId}`,
      circleId: m.circleId,
      circleName: circleNameById.get(m.circleId) ?? '',
      memberUserId: m.userId,
      person: { name: displayName(m.user), avatarUrl: m.user.profile?.avatarUrl ?? null },
      eventKind: 'birthday',
      eventDate: eventDate.toISOString(),
      daysUntil: days,
      urgency: deriveUrgency(days),
      itemCount,
      previewItems: toPreview(shared),
    });
  }

  // ── ACTIVITY — one card per member: wishes added/changed in the window.
  const activityByMember = new Map<string, FeedActivityItem>();
  for (const m of members) {
    const key = `${m.circleId}:${m.userId}`;
    const shared = itemsByCircleMember.get(key) ?? [];
    if (shared.length === 0) continue;
    const changed = shared.filter((it) => it.createdAt.getTime() >= activityCutoff || it.updatedAt.getTime() >= activityCutoff);
    if (changed.length === 0) continue;
    const added = changed.filter((it) => it.createdAt.getTime() >= activityCutoff);
    const updatedOnly = changed.filter((it) => it.createdAt.getTime() < activityCutoff);
    const latestMs = Math.max(...changed.map((it) => it.updatedAt.getTime()));
    const prev = activityByMember.get(m.userId);
    if (prev && new Date(prev.at).getTime() >= latestMs) continue; // keep freshest circle
    const newestFirst = changed.slice().sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    activityByMember.set(m.userId, {
      kind: 'activity',
      id: `activity:${m.circleId}:${m.userId}`,
      circleId: m.circleId,
      circleName: circleNameById.get(m.circleId) ?? '',
      memberUserId: m.userId,
      person: { name: displayName(m.user), avatarUrl: m.user.profile?.avatarUrl ?? null },
      addedCount: added.length,
      updatedCount: updatedOnly.length,
      at: new Date(latestMs).toISOString(),
      itemCount: countByCircleMember.get(key) ?? shared.length,
      previewItems: toPreview(added.length > 0 ? added : newestFirst),
    });
  }

  // ── RESERVATIONS — the viewer's own circle reservations.
  // The viewer still "holds" a reservation as long as the recipient is an ACTIVE
  // co-member → those drive the summary count (a recipient who LEFT the circle is
  // dropped: the reservation is no longer reachable/relevant). A "don't forget"
  // CARD additionally requires the event to be near AND the recipient's list to
  // still be shared, so its "Детали" CTA opens a non-empty member page rather
  // than a dead/empty one — but un-sharing must NOT silently shrink the count.
  const heldReservations = reservations.filter((rsv) =>
    activeMemberSet.has(`${rsv.circleId}:${rsv.item.wishlist.ownerId}`));
  const reservationItems: FeedReservationItem[] = [];
  const reservationNames: Array<{ name: string; days: number }> = [];
  for (const rsv of heldReservations) {
    const owner = rsv.item.wishlist.owner;
    const forName = displayName(owner);
    const days = daysUntilNextBirthday(owner.profile?.birthday ?? null, now);
    reservationNames.push({ name: forName, days: days ?? Number.POSITIVE_INFINITY });
    const stillShared = sharedMemberSet.has(`${rsv.circleId}:${rsv.item.wishlist.ownerId}`);
    if (stillShared && days != null && days <= RESERVATION_REMINDER_HORIZON_DAYS) {
      reservationItems.push({
        kind: 'reservation',
        id: `reservation:${rsv.id}`,
        circleId: rsv.circleId,
        circleName: circleNameById.get(rsv.circleId) ?? '',
        itemId: rsv.item.id,
        itemTitle: rsv.item.title,
        itemImageUrl: rsv.item.imageUrl,
        forUserId: rsv.item.wishlist.ownerId,
        forName,
        daysUntilEvent: days,
      });
    }
  }

  // Summary: total reservations + up to 3 distinct recipient names (soonest first).
  const seenNames = new Set<string>();
  const summaryNames: string[] = [];
  for (const n of reservationNames.slice().sort((a, b) => a.days - b.days)) {
    if (seenNames.has(n.name)) continue;
    seenNames.add(n.name);
    summaryNames.push(n.name);
    if (summaryNames.length >= 3) break;
  }

  const items = rankFeedItems([
    ...eventByMember.values(),
    ...activityByMember.values(),
    ...reservationItems,
  ]).slice(0, FEED_ITEM_CAP);

  return {
    hasCircles,
    circles,
    items,
    reservations: { count: heldReservations.length, names: summaryNames },
    generatedAt: now.toISOString(),
    nextCursor: null,
  };
}
