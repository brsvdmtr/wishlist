import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB + the birthday helper so getFeed is deterministic without Postgres.
vi.mock('@wishlist/db', () => ({
  prisma: {
    circleMembership: { findMany: vi.fn() },
    circleWishlistShare: { findMany: vi.fn() },
    circleReservation: { findMany: vi.fn() },
    item: { groupBy: vi.fn() },
  },
}));
vi.mock('./birthday-reminders', () => ({
  daysUntilNextBirthday: vi.fn(),
}));

import { prisma } from '@wishlist/db';
import { daysUntilNextBirthday } from './birthday-reminders';
import {
  deriveUrgency,
  rankFeedItems,
  getFeed,
  FEED_PREVIEW_FETCH,
  type FeedItem,
  type FeedEventItem,
  type FeedActivityItem,
  type FeedReservationItem,
} from './feed.service';

// ── Pure helpers ──────────────────────────────────────────────────────────────

describe('deriveUrgency', () => {
  it('classifies today / overdue as "today"', () => {
    expect(deriveUrgency(0)).toBe('today');
    expect(deriveUrgency(-2)).toBe('today');
  });
  it('classifies 1–3 days as "soon" and beyond as "upcoming"', () => {
    expect(deriveUrgency(1)).toBe('soon');
    expect(deriveUrgency(3)).toBe('soon');
    expect(deriveUrgency(4)).toBe('upcoming');
    expect(deriveUrgency(60)).toBe('upcoming');
  });
});

describe('rankFeedItems', () => {
  const ev = (id: string, daysUntil: number): FeedEventItem => ({
    kind: 'event', id, circleId: 'c', circleName: 'C', memberUserId: id, person: { name: id, avatarUrl: null },
    eventKind: 'birthday', eventDate: '2026-06-05T00:00:00.000Z', daysUntil, urgency: deriveUrgency(daysUntil),
    itemCount: 0, previewItems: [],
  });
  const act = (id: string, at: string): FeedActivityItem => ({
    kind: 'activity', id, circleId: 'c', circleName: 'C', memberUserId: id, person: { name: id, avatarUrl: null },
    addedCount: 1, updatedCount: 0, at, itemCount: 1, previewItems: [],
  });
  const rsv = (id: string, daysUntilEvent: number | null): FeedReservationItem => ({
    kind: 'reservation', id, circleId: 'c', circleName: 'C', itemId: id, itemTitle: 't', itemImageUrl: null,
    forUserId: 'u', forName: 'u', daysUntilEvent,
  });

  it('orders tiers: events → activity → reservations', () => {
    const out = rankFeedItems([rsv('r', 2), act('a', '2026-06-01T00:00:00Z'), ev('e', 10)]);
    expect(out.map((i) => i.kind)).toEqual(['event', 'activity', 'reservation']);
  });

  it('sorts events by proximity (today floats to the very top)', () => {
    const out = rankFeedItems([ev('far', 30), ev('today', 0), ev('soon', 3)]);
    expect(out.map((i) => i.id)).toEqual(['today', 'soon', 'far']);
  });

  it('sorts activity by freshness (newest first)', () => {
    const out = rankFeedItems([act('old', '2026-05-01T00:00:00Z'), act('new', '2026-06-01T00:00:00Z')]);
    expect(out.map((i) => i.id)).toEqual(['new', 'old']);
  });

  it('sorts reservations by recipient-event proximity, unknown (null) last', () => {
    const out = rankFeedItems([rsv('unknown', null), rsv('soon', 1), rsv('later', 20)]);
    expect(out.map((i) => i.id)).toEqual(['soon', 'later', 'unknown']);
  });

  it('is stable within ties and does not mutate the input', () => {
    const input: FeedItem[] = [act('a1', '2026-06-01T00:00:00Z'), act('a2', '2026-06-01T00:00:00Z')];
    const out = rankFeedItems(input);
    expect(out.map((i) => i.id)).toEqual(['a1', 'a2']);
    expect(input.map((i) => i.id)).toEqual(['a1', 'a2']); // input untouched
  });
});

// ── getFeed (mocked Prisma) ───────────────────────────────────────────────────

const mFindMany = prisma.circleMembership.findMany as ReturnType<typeof vi.fn>;
const sFindMany = prisma.circleWishlistShare.findMany as ReturnType<typeof vi.fn>;
const rFindMany = prisma.circleReservation.findMany as ReturnType<typeof vi.fn>;
const gGroupBy = prisma.item.groupBy as ReturnType<typeof vi.fn>;
const mDays = daysUntilNextBirthday as ReturnType<typeof vi.fn>;

const VIEWER = 'viewer-1';
const BDAY_ANYA = new Date('2000-06-05T00:00:00.000Z');
const BDAY_FAR = new Date('1990-12-25T00:00:00.000Z');
const NOW_ISH = new Date();
const OLD = new Date('2020-01-01T00:00:00.000Z');
/** A groupBy count row: { wishlistId, _count: { _all } }. */
const count = (wishlistId: string, n: number) => ({ wishlistId, _count: { _all: n } });

beforeEach(() => {
  vi.clearAllMocks();
  gGroupBy.mockResolvedValue([]); // default: no counts (tests with shares override)
});

describe('getFeed', () => {
  it('returns the no-circles empty shape when the viewer has no memberships', async () => {
    mFindMany.mockResolvedValueOnce([]); // memberships
    const feed = await getFeed({ viewerId: VIEWER });
    expect(feed.hasCircles).toBe(false);
    expect(feed.circles).toEqual([]);
    expect(feed.items).toEqual([]);
    expect(feed.reservations).toEqual({ count: 0, names: [] });
    expect(feed.nextCursor).toBeNull();
    // No content queries fired when there are no circles.
    expect(sFindMany).not.toHaveBeenCalled();
    expect(rFindMany).not.toHaveBeenCalled();
  });

  it('aggregates events + activity + reservations and ranks them', async () => {
    // memberships (chips/scope), then members (co-members)
    mFindMany
      .mockResolvedValueOnce([{ circle: { id: 'c1', name: 'Семья', emoji: '🏡', type: 'FAMILY' } }])
      .mockResolvedValueOnce([
        { circleId: 'c1', userId: 'anya', user: { firstName: 'Аня', profile: { displayName: null, avatarUrl: null, birthday: BDAY_ANYA } } },
      ]);
    sFindMany.mockResolvedValueOnce([
      {
        circleId: 'c1',
        wishlist: {
          id: 'wl-anya',
          ownerId: 'anya',
          items: [
            { id: 'i1', title: 'Наушники', imageUrl: null, createdAt: NOW_ISH, updatedAt: NOW_ISH }, // fresh → activity
            { id: 'i2', title: 'Книга', imageUrl: null, createdAt: OLD, updatedAt: OLD }, // old
          ],
        },
      },
    ]);
    gGroupBy.mockResolvedValueOnce([count('wl-anya', 2)]);
    rFindMany.mockResolvedValueOnce([
      {
        id: 'rsv1',
        circleId: 'c1',
        item: { id: 'i2', title: 'Книга', imageUrl: null, wishlist: { ownerId: 'anya', owner: { firstName: 'Аня', profile: { displayName: null, birthday: BDAY_ANYA } } } },
      },
    ]);
    mDays.mockImplementation((b: Date | null) => (b === BDAY_ANYA ? 3 : null));

    const feed = await getFeed({ viewerId: VIEWER });

    expect(feed.hasCircles).toBe(true);
    expect(feed.circles).toEqual([{ id: 'c1', name: 'Семья', emoji: '🏡', type: 'FAMILY' }]);
    // Ranked: event → activity → reservation.
    expect(feed.items.map((i) => i.kind)).toEqual(['event', 'activity', 'reservation']);

    const event = feed.items[0] as FeedEventItem;
    expect(event.daysUntil).toBe(3);
    expect(event.urgency).toBe('soon');
    expect(event.person.name).toBe('Аня');
    expect(event.itemCount).toBe(2);

    const activity = feed.items[1] as FeedActivityItem;
    expect(activity.addedCount).toBe(1); // only the fresh item
    expect(activity.previewItems.map((p) => p.id)).toContain('i1');

    const reservation = feed.items[2] as FeedReservationItem;
    expect(reservation.forName).toBe('Аня');
    expect(reservation.daysUntilEvent).toBe(3);

    expect(feed.reservations).toEqual({ count: 1, names: ['Аня'] });
  });

  it('scopes reservations to the viewer (surprise invariant — never others’)', async () => {
    mFindMany
      .mockResolvedValueOnce([{ circle: { id: 'c1', name: 'Семья', emoji: null, type: 'FAMILY' } }])
      .mockResolvedValueOnce([]);
    sFindMany.mockResolvedValueOnce([]);
    rFindMany.mockResolvedValueOnce([]);
    mDays.mockReturnValue(null);

    await getFeed({ viewerId: VIEWER });

    expect(rFindMany).toHaveBeenCalledTimes(1);
    const arg = rFindMany.mock.calls[0]![0] as { where: { reserverUserId: string } };
    expect(arg.where.reserverUserId).toBe(VIEWER);
  });

  it('classifies an updated-but-not-new item as updated activity (not added)', async () => {
    mFindMany
      .mockResolvedValueOnce([{ circle: { id: 'c1', name: 'Семья', emoji: null, type: 'FAMILY' } }])
      .mockResolvedValueOnce([{ circleId: 'c1', userId: 'anya', user: { firstName: 'Аня', profile: { displayName: null, avatarUrl: null, birthday: null } } }]);
    sFindMany.mockResolvedValueOnce([
      { circleId: 'c1', wishlist: { id: 'wl1', ownerId: 'anya', items: [
        { id: 'i1', title: 'Старое, но обновлённое', imageUrl: null, createdAt: OLD, updatedAt: NOW_ISH },
      ] } },
    ]);
    gGroupBy.mockResolvedValueOnce([count('wl1', 1)]);
    rFindMany.mockResolvedValueOnce([]);
    mDays.mockReturnValue(null);

    const feed = await getFeed({ viewerId: VIEWER });
    const act = feed.items.find((i) => i.kind === 'activity') as FeedActivityItem;
    expect(act).toBeTruthy();
    expect(act.addedCount).toBe(0);
    expect(act.updatedCount).toBe(1);
  });

  it('counts a far-event reservation in the summary but shows no reminder card', async () => {
    mFindMany
      .mockResolvedValueOnce([{ circle: { id: 'c1', name: 'Семья', emoji: null, type: 'FAMILY' } }])
      .mockResolvedValueOnce([{ circleId: 'c1', userId: 'boris', user: { firstName: 'Борис', profile: { displayName: null, avatarUrl: null, birthday: BDAY_FAR } } }]);
    sFindMany.mockResolvedValueOnce([{ circleId: 'c1', wishlist: { id: 'wl-b', ownerId: 'boris', items: [] } }]);
    gGroupBy.mockResolvedValueOnce([]);
    rFindMany.mockResolvedValueOnce([
      { id: 'rsvF', circleId: 'c1', item: { id: 'iF', title: 'Подарок', imageUrl: null, wishlist: { ownerId: 'boris', owner: { firstName: 'Борис', profile: { displayName: null, birthday: BDAY_FAR } } } } },
    ]);
    mDays.mockImplementation((b: Date | null) => (b === BDAY_FAR ? 200 : null)); // far → no card

    const feed = await getFeed({ viewerId: VIEWER });
    expect(feed.items.some((i) => i.kind === 'reservation')).toBe(false);
    expect(feed.reservations).toEqual({ count: 1, names: ['Борис'] });
  });

  it('dedups a member across circles into one event on the circle where they shared more', async () => {
    mFindMany
      .mockResolvedValueOnce([
        { circle: { id: 'c1', name: 'Семья', emoji: null, type: 'FAMILY' } },
        { circle: { id: 'c2', name: 'Друзья', emoji: null, type: 'FRIENDS' } },
      ])
      .mockResolvedValueOnce([
        { circleId: 'c1', userId: 'anya', user: { firstName: 'Аня', profile: { displayName: null, avatarUrl: null, birthday: BDAY_ANYA } } },
        { circleId: 'c2', userId: 'anya', user: { firstName: 'Аня', profile: { displayName: null, avatarUrl: null, birthday: BDAY_ANYA } } },
      ]);
    sFindMany.mockResolvedValueOnce([
      { circleId: 'c1', wishlist: { id: 'wl1', ownerId: 'anya', items: [
        { id: 'a', title: 'A', imageUrl: null, createdAt: OLD, updatedAt: OLD },
        { id: 'b', title: 'B', imageUrl: null, createdAt: OLD, updatedAt: OLD },
      ] } },
      { circleId: 'c2', wishlist: { id: 'wl2', ownerId: 'anya', items: [
        { id: 'cc', title: 'C', imageUrl: null, createdAt: OLD, updatedAt: OLD },
      ] } },
    ]);
    gGroupBy.mockResolvedValueOnce([count('wl1', 2), count('wl2', 1)]);
    rFindMany.mockResolvedValueOnce([]);
    mDays.mockImplementation((b: Date | null) => (b === BDAY_ANYA ? 3 : null));

    const feed = await getFeed({ viewerId: VIEWER });
    const events = feed.items.filter((i) => i.kind === 'event') as FeedEventItem[];
    expect(events).toHaveLength(1); // deduped across c1+c2
    expect(events[0]!.circleId).toBe('c1'); // attributed to the richer circle (2 > 1)
    expect(events[0]!.itemCount).toBe(2);
  });

  it('takes itemCount from the groupBy total, not the bounded item slice', async () => {
    // The bounded query returns only 2 items, but the list really holds 40 —
    // itemCount must reflect the true total (regression guard for the unbounded
    // → bounded+count change; pre-fix used shared.length and would report 2).
    mFindMany
      .mockResolvedValueOnce([{ circle: { id: 'c1', name: 'Семья', emoji: null, type: 'FAMILY' } }])
      .mockResolvedValueOnce([{ circleId: 'c1', userId: 'anya', user: { firstName: 'Аня', profile: { displayName: null, avatarUrl: null, birthday: BDAY_ANYA } } }]);
    sFindMany.mockResolvedValueOnce([
      { circleId: 'c1', wishlist: { id: 'wl1', ownerId: 'anya', items: [
        { id: 'p1', title: 'A', imageUrl: null, createdAt: OLD, updatedAt: OLD },
        { id: 'p2', title: 'B', imageUrl: null, createdAt: OLD, updatedAt: OLD },
      ] } },
    ]);
    gGroupBy.mockResolvedValueOnce([count('wl1', 40)]);
    rFindMany.mockResolvedValueOnce([]);
    mDays.mockImplementation((b: Date | null) => (b === BDAY_ANYA ? 3 : null));

    const feed = await getFeed({ viewerId: VIEWER });
    const event = feed.items.find((i) => i.kind === 'event') as FeedEventItem;
    expect(event.itemCount).toBe(40); // from groupBy, not the 2-item slice
    expect(event.previewItems).toHaveLength(2); // previews still come from the slice
  });

  it('drops a reservation whose recipient is no longer an active circle member', async () => {
    mFindMany
      .mockResolvedValueOnce([{ circle: { id: 'c1', name: 'Семья', emoji: null, type: 'FAMILY' } }])
      .mockResolvedValueOnce([]); // recipient left → no active co-members
    sFindMany.mockResolvedValueOnce([]); // and nothing shared anymore
    rFindMany.mockResolvedValueOnce([
      { id: 'rsvL', circleId: 'c1', item: { id: 'iL', title: 'Подарок', imageUrl: null, wishlist: { ownerId: 'ghost', owner: { firstName: 'Призрак', profile: { displayName: null, birthday: BDAY_ANYA } } } } },
    ]);
    mDays.mockImplementation((b: Date | null) => (b === BDAY_ANYA ? 3 : null));

    const feed = await getFeed({ viewerId: VIEWER });
    expect(feed.items.some((i) => i.kind === 'reservation')).toBe(false);
    expect(feed.reservations).toEqual({ count: 0, names: [] });
  });

  it('still counts a reservation for an active member who un-shared their list (no card though)', async () => {
    // Аня stays in the circle but shares nothing now → no actionable card, yet
    // the viewer still HOLDS the reservation, so the summary count must not drop.
    mFindMany
      .mockResolvedValueOnce([{ circle: { id: 'c1', name: 'Семья', emoji: null, type: 'FAMILY' } }])
      .mockResolvedValueOnce([{ circleId: 'c1', userId: 'anya', user: { firstName: 'Аня', profile: { displayName: null, avatarUrl: null, birthday: BDAY_ANYA } } }]);
    sFindMany.mockResolvedValueOnce([]); // active member, but nothing shared
    rFindMany.mockResolvedValueOnce([
      { id: 'rsvU', circleId: 'c1', item: { id: 'iU', title: 'Подарок', imageUrl: null, wishlist: { ownerId: 'anya', owner: { firstName: 'Аня', profile: { displayName: null, birthday: BDAY_ANYA } } } } },
    ]);
    mDays.mockImplementation((b: Date | null) => (b === BDAY_ANYA ? 3 : null)); // near event

    const feed = await getFeed({ viewerId: VIEWER });
    expect(feed.items.some((i) => i.kind === 'reservation')).toBe(false); // no card (un-shared)
    expect(feed.reservations.count).toBe(1); // but still counted — the viewer holds it
    expect(feed.reservations.names).toEqual(['Аня']);
  });

  it('fetches shared items bounded + ordered by updatedAt (pins the bounding fix)', async () => {
    // Guards the constants behind the unbounded→bounded change: ordering by
    // updatedAt (so recently-edited old items surface as activity) and the
    // FEED_PREVIEW_FETCH cap. The mock ignores these, so assert the query shape.
    mFindMany
      .mockResolvedValueOnce([{ circle: { id: 'c1', name: 'Семья', emoji: null, type: 'FAMILY' } }])
      .mockResolvedValueOnce([]);
    sFindMany.mockResolvedValueOnce([]);
    rFindMany.mockResolvedValueOnce([]);
    mDays.mockReturnValue(null);

    await getFeed({ viewerId: VIEWER });

    const arg = sFindMany.mock.calls[0]![0] as { select: { wishlist: { select: { items: { orderBy: unknown; take: number } } } } };
    const itemsQuery = arg.select.wishlist.select.items;
    expect(itemsQuery.orderBy).toEqual({ updatedAt: 'desc' });
    expect(itemsQuery.take).toBe(FEED_PREVIEW_FETCH);
  });

  it('anchors eventDate to the MSK calendar day (no UTC off-by-one)', async () => {
    // 22:00 UTC is already the NEXT day in MSK (UTC+3 → 01:00). With days=2 the
    // birthday is MSK-today (06-03) + 2 = 06-05. The pre-fix UTC math anchored
    // on 06-02 and returned 06-04 — off by one.
    const now = new Date('2026-06-02T22:00:00.000Z');
    mFindMany
      .mockResolvedValueOnce([{ circle: { id: 'c1', name: 'Семья', emoji: null, type: 'FAMILY' } }])
      .mockResolvedValueOnce([{ circleId: 'c1', userId: 'anya', user: { firstName: 'Аня', profile: { displayName: null, avatarUrl: null, birthday: BDAY_ANYA } } }]);
    sFindMany.mockResolvedValueOnce([]);
    rFindMany.mockResolvedValueOnce([]);
    mDays.mockImplementation((b: Date | null) => (b === BDAY_ANYA ? 2 : null));

    const feed = await getFeed({ viewerId: VIEWER, now });
    const event = feed.items.find((i) => i.kind === 'event') as FeedEventItem;
    expect(event.eventDate).toBe('2026-06-05T00:00:00.000Z');
  });
});
