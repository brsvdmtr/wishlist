import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the DB + the birthday helper so getFeed is deterministic without Postgres.
vi.mock('@wishlist/db', () => ({
  prisma: {
    circleMembership: { findMany: vi.fn() },
    circleWishlistShare: { findMany: vi.fn() },
    circleReservation: { findMany: vi.fn() },
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
const mDays = daysUntilNextBirthday as ReturnType<typeof vi.fn>;

const VIEWER = 'viewer-1';
const BDAY_ANYA = new Date('2000-06-05T00:00:00.000Z');
const NOW_ISH = new Date();
const OLD = new Date('2020-01-01T00:00:00.000Z');

beforeEach(() => {
  vi.clearAllMocks();
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
          ownerId: 'anya',
          items: [
            { id: 'i1', title: 'Наушники', imageUrl: null, createdAt: NOW_ISH, updatedAt: NOW_ISH }, // fresh → activity
            { id: 'i2', title: 'Книга', imageUrl: null, createdAt: OLD, updatedAt: OLD }, // old
          ],
        },
      },
    ]);
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
});
