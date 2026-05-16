// Smoke tests for SearchScreen.tsx. Asserts the major state-machine
// branches without exercising the actual fetch shape (that's covered by
// searchApi via the API integration path).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { SearchScreen } from './SearchScreen';
import type { SearchResponse } from '../lib/searchApi';

// Stub fetchSearch + recordWishlistOpen at the module boundary so the
// component doesn't try to hit the network. We control the response per
// test via `fetchMock`.
const fetchMock = vi.fn();
vi.mock('../lib/searchApi', () => ({
  fetchSearch: (...args: unknown[]) => fetchMock(...args),
  recordWishlistOpen: vi.fn(),
  fetchAccessView: vi.fn().mockResolvedValue(null),
}));

// Fresh localStorage shim per test.
class MemStore implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  clear() { this.map.clear(); }
  getItem(k: string) { return this.map.has(k) ? (this.map.get(k) as string) : null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  key(i: number) { return Array.from(this.map.keys())[i] ?? null; }
}

beforeEach(() => {
  fetchMock.mockReset();
  Object.defineProperty(window, 'localStorage', { value: new MemStore(), writable: true });
});

function buildProps(over?: Partial<Parameters<typeof SearchScreen>[0]>) {
  return {
    locale: 'ru' as const,
    isPro: false,
    tgFetch: vi.fn(),
    onBack: vi.fn(),
    onResultClick: vi.fn(),
    onOpenPaywall: vi.fn(),
    pushToast: vi.fn(),
    haptic: vi.fn(),
    trackEvent: vi.fn(),
    ...over,
  };
}

describe('SearchScreen', () => {
  it('renders the first-open state with the placeholder', () => {
    render(<SearchScreen {...buildProps()} />);
    expect(screen.getByPlaceholderText(/Искать желания/i)).toBeDefined();
    expect(screen.getByText(/Найди что угодно/i)).toBeDefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('emits search.opened on mount', () => {
    const trackEvent = vi.fn();
    render(<SearchScreen {...buildProps({ trackEvent })} />);
    const events = trackEvent.mock.calls.map((c) => c[0]);
    expect(events).toContain('search.opened');
  });

  it('shows the short-query state when typing 1 char and skips fetch', async () => {
    render(<SearchScreen {...buildProps()} />);
    const input = screen.getByPlaceholderText(/Искать желания/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'a' } });
    expect(screen.getByText(/Введи минимум 2 символа/i)).toBeDefined();
    // Even after debounce, fetch never fires for 1-char.
    await new Promise((r) => setTimeout(r, 350));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('debounces input and fires exactly one search per stable query', async () => {
    fetchMock.mockResolvedValue({
      query: 'наушники',
      normalizedQuery: 'наушники',
      groups: [],
      suggestions: [],
      hasMore: false,
      nextCursor: null,
      partial: false,
      failedGroups: [],
      isPro: false,
    } satisfies SearchResponse);

    render(<SearchScreen {...buildProps()} />);
    const input = screen.getByPlaceholderText(/Искать желания/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'нау' } });
    fireEvent.change(input, { target: { value: 'науш' } });
    fireEvent.change(input, { target: { value: 'наушники' } });
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => { await new Promise((r) => setTimeout(r, 320)); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstCall = fetchMock.mock.calls[0] as [unknown, { q: string }];
    expect(firstCall[1].q).toBe('наушники');
  });

  it('clear button resets input and hides results', async () => {
    fetchMock.mockResolvedValue({
      query: 'наушники', normalizedQuery: 'наушники', groups: [], suggestions: [],
      hasMore: false, nextCursor: null, partial: false, failedGroups: [], isPro: false,
    } satisfies SearchResponse);

    render(<SearchScreen {...buildProps()} />);
    const input = screen.getByPlaceholderText(/Искать желания/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'наушники' } });
    await act(async () => { await new Promise((r) => setTimeout(r, 320)); });
    // Clear button visible — find by aria-label.
    const clearBtn = screen.getByLabelText(/Очистить поиск/i);
    fireEvent.click(clearBtn);
    expect(input.value).toBe('');
  });

  it('calls onOpenPaywall when a pro_locked result is clicked', async () => {
    const onOpenPaywall = vi.fn();
    const onResultClick = vi.fn();
    fetchMock.mockResolvedValue({
      query: 'm', normalizedQuery: 'маша', groups: [
        {
          type: 'pro_locked', title: '⭐ PRO', total: 3, hasMore: false,
          items: [{
            id: 'pl', entityId: null, type: 'pro_locked',
            title: 'Найдено в PRO-разделах',
            subtitle: 'Открой PRO',
            badge: '⭐ PRO', badgeTone: 'pro', thumbnailUrl: null, icon: '⭐',
            target: { screen: 'paywall', section: 'search' },
            accessState: 'pro_required',
            matchedFields: [], ownerUserId: null, wishlistId: null, itemId: null, score: 0,
          }],
        },
      ],
      suggestions: [], hasMore: false, nextCursor: null, partial: false, failedGroups: [], isPro: false,
    } satisfies SearchResponse);

    render(<SearchScreen {...buildProps({ onOpenPaywall, onResultClick })} />);
    const input = screen.getByPlaceholderText(/Искать желания/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'маша' } });
    await act(async () => { await new Promise((r) => setTimeout(r, 320)); });
    const cta = await screen.findByText(/Открыть PRO/i);
    fireEvent.click(cta);
    expect(onOpenPaywall).toHaveBeenCalled();
    expect(onResultClick).not.toHaveBeenCalled();
  });

  it('calls onResultClick for a regular item click', async () => {
    const onResultClick = vi.fn();
    fetchMock.mockResolvedValue({
      query: 'sony', normalizedQuery: 'sony', groups: [
        {
          type: 'item', title: '🎁 Желания', total: 1, hasMore: false,
          items: [{
            id: 'item:abc', entityId: 'abc', type: 'item',
            title: 'Sony WH-1000XM5',
            subtitle: 'ДР 2026 · Техника',
            badge: '12 990 ₽', badgeTone: 'price', thumbnailUrl: null, icon: '🎧',
            target: { screen: 'item-detail', itemId: 'abc', wishlistId: 'wl1' },
            accessState: 'available',
            matchedFields: ['title'], ownerUserId: 'u1', wishlistId: 'wl1', itemId: 'abc', score: 100,
          }],
        },
      ],
      suggestions: [], hasMore: false, nextCursor: null, partial: false, failedGroups: [], isPro: false,
    } satisfies SearchResponse);

    render(<SearchScreen {...buildProps({ onResultClick })} />);
    const input = screen.getByPlaceholderText(/Искать желания/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'sony' } });
    await act(async () => { await new Promise((r) => setTimeout(r, 320)); });
    const card = await screen.findByText('Sony WH-1000XM5');
    fireEvent.click(card);
    expect(onResultClick).toHaveBeenCalledOnce();
    const r = onResultClick.mock.calls[0]?.[0] as { itemId: string };
    expect(r.itemId).toBe('abc');
  });

  it('shows the empty state when results are empty after a query', async () => {
    fetchMock.mockResolvedValue({
      query: 'абракадабра', normalizedQuery: 'абракадабра', groups: [],
      suggestions: [], hasMore: false, nextCursor: null, partial: false, failedGroups: [], isPro: false,
    } satisfies SearchResponse);

    render(<SearchScreen {...buildProps()} />);
    const input = screen.getByPlaceholderText(/Искать желания/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'абракадабра' } });
    await act(async () => { await new Promise((r) => setTimeout(r, 320)); });
    await waitFor(() => {
      expect(screen.getByText(/Ничего не нашли/i)).toBeDefined();
    });
  });

  it('shows the error state on fetch failure and offers retry', async () => {
    fetchMock.mockRejectedValueOnce(new Error('search_http_500'));
    render(<SearchScreen {...buildProps()} />);
    const input = screen.getByPlaceholderText(/Искать желания/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'наушники' } });
    await act(async () => { await new Promise((r) => setTimeout(r, 320)); });
    await waitFor(() => {
      expect(screen.getByText(/временно не сработал/i)).toBeDefined();
    });
    // Retry button visible.
    expect(screen.getByText(/Повторить/i)).toBeDefined();
  });

  it('back button invokes onBack', () => {
    const onBack = vi.fn();
    render(<SearchScreen {...buildProps({ onBack })} />);
    const back = screen.getByLabelText(/Назад/i);
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledOnce();
  });
});
