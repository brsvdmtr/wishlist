// Tests for the «Главная → лента близких» (Home feed) Mini App screen (P0.2).
//
// Locks the two AC-critical branches:
//   • no circles → bridge to P0.1 (empty state + «Создать круг» CTA), AC-3.
//   • populated feed → ranked event card with countdown + working CTAs, AC-1/2/4,
//     plus the «Мои брони» summary block.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { t } from '@wishlist/shared';
import { FeedRoot } from './FeedRoot';

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

function baseProps(tgFetch: ReturnType<typeof vi.fn>) {
  return {
    tgFetch,
    locale: 'ru' as const,
    onOpenMember: vi.fn(),
    onOpenReservations: vi.fn(),
    onCreateCircle: vi.fn(),
    pushToast: vi.fn(),
  };
}

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
});
