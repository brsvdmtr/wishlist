// Tests for the «Главная → лента близких» (Home feed) Mini App screen (P0.2).
//
// Locks the two AC-critical branches:
//   • no circles → bridge to P0.1 (empty state + «Создать круг» CTA), AC-3.
//   • populated feed → ranked event card with countdown + working CTAs, AC-1/2/4,
//     plus the «Мои брони» summary block.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { t } from '@wishlist/shared';
import { FeedRoot } from './FeedRoot';
import { hashKeyForLog } from '../../idempotency';

function makeRes(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  const ok = init?.ok ?? true;
  const status = init?.status ?? (ok ? 200 : 400);
  return { ok, status, json: async () => body } as unknown as Response;
}

function feed(over?: Record<string, unknown>) {
  return {
    hasCircles: true,
    circles: [{ id: 'c1', name: 'Семья', emoji: '🏡', type: 'FAMILY' }],
    items: [],
    reservations: { count: 0, names: [] },
    generatedAt: '2026-06-02T00:00:00.000Z',
    nextCursor: null,
    ...over,
  };
}

const eventItem = {
  kind: 'event', id: 'event:c1:anya', circleId: 'c1', circleName: 'Семья', memberUserId: 'anya',
  person: { name: 'Аня', avatarUrl: null }, eventKind: 'birthday', eventDate: '2026-06-05T00:00:00.000Z',
  daysUntil: 3, urgency: 'soon', itemCount: 2, previewItems: [{ id: 'i1', title: 'Наушники', imageUrl: null }],
};

const activityItem = {
  kind: 'activity', id: 'activity:c1:boris', circleId: 'c1', circleName: 'Семья', memberUserId: 'boris',
  person: { name: 'Борис', avatarUrl: null }, addedCount: 2, updatedCount: 0, at: '2026-06-01T00:00:00.000Z',
  itemCount: 2, previewItems: [{ id: 'i2', title: 'Книга', imageUrl: null }],
};

const reservationCard = {
  kind: 'reservation', id: 'reservation:r1', circleId: 'c1', circleName: 'Семья', itemId: 'i3',
  itemTitle: 'Часы', itemImageUrl: null, forUserId: 'vera', forName: 'Вера', daysUntilEvent: 10,
};

function baseProps(tgFetch: ReturnType<typeof vi.fn>) {
  return {
    tgFetch,
    locale: 'ru' as const,
    onOpenMember: vi.fn(),
    onOpenReservations: vi.fn(),
    onCreateCircle: vi.fn(),
    pushToast: vi.fn(),
    onTrack: vi.fn(),
  };
}

/** All onTrack calls for one event name → their props objects. */
function tracked(onTrack: ReturnType<typeof vi.fn>, event: string): Array<Record<string, unknown>> {
  return onTrack.mock.calls.filter((c) => c[0] === event).map((c) => (c[1] ?? {}) as Record<string, unknown>);
}

const personEvent = (id: string, name: string) => ({ ...eventItem, id: `event:c1:${id}`, memberUserId: id, person: { name, avatarUrl: null } });

beforeEach(() => vi.clearAllMocks());

describe('FeedRoot — empty state (no circles)', () => {
  it('bridges to P0.1 with the create-circle CTA (AC-3)', async () => {
    const tgFetch = vi.fn(async () => makeRes(feed({ hasCircles: false, circles: [] })));
    const props = baseProps(tgFetch);
    render(<FeedRoot {...props} />);

    await waitFor(() => expect(screen.getByText(t('feed_empty_title', 'ru'))).toBeTruthy());
    const cta = screen.getByText(t('feed_empty_cta', 'ru'));
    fireEvent.click(cta);
    expect(props.onCreateCircle).toHaveBeenCalledTimes(1);
  });
});

describe('FeedRoot — populated feed', () => {
  it('renders an event card with countdown and routes its CTA to the member (AC-1/4)', async () => {
    const tgFetch = vi.fn(async () => makeRes(feed({ items: [eventItem], reservations: { count: 1, names: ['Аня'] } })));
    const props = baseProps(tgFetch);
    render(<FeedRoot {...props} />);

    // Person name (appears on the event card + reservations block) + the
    // countdown chip (reused circle countdown copy, unique).
    await waitFor(() => expect(screen.getAllByText('Аня').length).toBeGreaterThan(0));
    expect(screen.getByText(t('circle_event_in_days', 'ru', { n: 3 }))).toBeTruthy();

    // "Выбрать подарок" (rendered with a 🎁 prefix) jumps straight into the
    // member's circle wishlists.
    fireEvent.click(screen.getByText(/Выбрать подарок/));
    expect(props.onOpenMember).toHaveBeenCalledWith('c1', 'anya');
  });

  it('renders the «Мои брони» block and opens the reservations manager', async () => {
    const tgFetch = vi.fn(async () => makeRes(feed({ items: [eventItem], reservations: { count: 1, names: ['Аня'] } })));
    const props = baseProps(tgFetch);
    render(<FeedRoot {...props} />);

    await waitFor(() => expect(screen.getByText(t('feed_reservations_count', 'ru', { n: 1 }))).toBeTruthy());
    fireEvent.click(screen.getByText(t('feed_reservations_count', 'ru', { n: 1 })));
    expect(props.onOpenReservations).toHaveBeenCalledTimes(1);
  });

  it('shows the quiet state when there is nothing to surface', async () => {
    const tgFetch = vi.fn(async () => makeRes(feed({ items: [], reservations: { count: 0, names: [] } })));
    render(<FeedRoot {...baseProps(tgFetch)} />);

    await waitFor(() => expect(screen.getByText(t('feed_quiet_title', 'ru'))).toBeTruthy());
  });

  it('ignores a stale out-of-order response when the filter changes (reqSeq guard)', async () => {
    const resolvers: Array<(r: Response) => void> = [];
    const tgFetch = vi.fn(() => new Promise<Response>((resolve) => { resolvers.push(resolve); }));
    render(<FeedRoot {...baseProps(tgFetch)} />);

    // call 1 (initial, filter=null) — resolve so the filter chips render.
    await waitFor(() => expect(resolvers).toHaveLength(1));
    await act(async () => { resolvers[0]!(makeRes(feed({ items: [personEvent('anya', 'Аня')] }))); });
    expect(screen.getByText('Аня')).toBeTruthy();

    // Tap «Семья» → call 2, then «Все» → call 3 (the latest).
    fireEvent.click(screen.getByText(/Семья/));
    await waitFor(() => expect(resolvers).toHaveLength(2));
    fireEvent.click(screen.getByText(t('feed_filter_all', 'ru')));
    await waitFor(() => expect(resolvers).toHaveLength(3));

    // Resolve the LATEST (call 3 = «Все», Аня) first…
    await act(async () => { resolvers[2]!(makeRes(feed({ items: [personEvent('anya', 'Аня')] }))); });
    expect(screen.getByText('Аня')).toBeTruthy();
    // …then the STALE earlier (call 2 = «Семья», Боря) — must be ignored.
    await act(async () => { resolvers[1]!(makeRes(feed({ items: [personEvent('boris', 'Боря')] }))); });
    expect(screen.queryByText('Боря')).toBeNull();
    expect(screen.getByText('Аня')).toBeTruthy();
  });
});

describe('FeedRoot — analytics (P0.2 instrumentation)', () => {
  it('fires feed.viewed exactly once per load, with the per-kind ranked-card counts', async () => {
    const tgFetch = vi.fn(async () => makeRes(feed({
      items: [eventItem, activityItem, reservationCard],
      reservations: { count: 1, names: ['Вера'] },
    })));
    const props = baseProps(tgFetch);
    render(<FeedRoot {...props} />);

    await waitFor(() => expect(tracked(props.onTrack, 'feed.viewed')).toHaveLength(1));
    expect(tracked(props.onTrack, 'feed.viewed')[0]).toEqual({
      hasCircles: true,
      itemCount: 3,
      eventCount: 1,
      activityCount: 1,
      reservationCount: 1,
      circleCount: 1,
      filtered: false,
    });
  });

  it('fires feed.card_clicked with kind + position (and event-only daysUntil/urgency), then navigates', async () => {
    const tgFetch = vi.fn(async () => makeRes(feed({ items: [eventItem, activityItem, reservationCard] })));
    const props = baseProps(tgFetch);
    render(<FeedRoot {...props} />);

    await waitFor(() => expect(screen.getByText(/Выбрать подарок/)).toBeTruthy());
    fireEvent.click(screen.getByText(/Выбрать подарок/));        // event card → position 0
    fireEvent.click(screen.getByText(t('feed_cta_view', 'ru')));  // activity card → position 1
    fireEvent.click(screen.getByText(t('feed_cta_details', 'ru'))); // reservation card → position 2

    expect(tracked(props.onTrack, 'feed.card_clicked')).toEqual([
      { kind: 'event', position: 0, daysUntil: 3, urgency: 'soon' },
      { kind: 'activity', position: 1 },
      { kind: 'reservation', position: 2 },
    ]);
    // The CTA still performs its navigation alongside the analytics call.
    expect(props.onOpenMember).toHaveBeenCalledWith('c1', 'anya');
    expect(props.onOpenMember).toHaveBeenCalledWith('c1', 'vera');
  });

  it('fires feed.filter_changed with a hashed scope (never the raw circleId) and skips re-taps of the active chip', async () => {
    const tgFetch = vi.fn(async () => makeRes(feed({ items: [], reservations: { count: 0, names: [] } })));
    const props = baseProps(tgFetch);
    render(<FeedRoot {...props} />);

    fireEvent.click(await screen.findByText('🏡 Семья'));          // null → c1 : fires (hashed)
    fireEvent.click(screen.getByText('🏡 Семья'));                 // c1 → c1  : guarded, no fire
    fireEvent.click(screen.getByText(t('feed_filter_all', 'ru'))); // c1 → null : fires ('all')

    // The re-tap is guarded, so only the two real changes emit. waitFor also
    // lets the filter-triggered reloads settle (avoids an act() warning).
    await waitFor(() => expect(tracked(props.onTrack, 'feed.filter_changed'))
      .toEqual([{ scope: hashKeyForLog('c1') }, { scope: 'all' }]));
    // One reload (→ feed.viewed) per real change + the initial load; the
    // guarded re-tap adds none.
    await waitFor(() => expect(tracked(props.onTrack, 'feed.viewed')).toHaveLength(3));
    expect(tracked(props.onTrack, 'feed.filter_changed')[0]!.scope).not.toBe('c1'); // raw id never logged
  });

  it('fires feed.empty_cta_clicked from the no-circles bridge CTA', async () => {
    const tgFetch = vi.fn(async () => makeRes(feed({ hasCircles: false, circles: [] })));
    const props = baseProps(tgFetch);
    render(<FeedRoot {...props} />);

    fireEvent.click(await screen.findByText(t('feed_empty_cta', 'ru')));
    expect(tracked(props.onTrack, 'feed.empty_cta_clicked')).toHaveLength(1);
    expect(props.onCreateCircle).toHaveBeenCalledTimes(1);
  });
});
