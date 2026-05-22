// Regression test — Next 15 async-params migration of the admin edit page.
// As a client component it unwraps the Promise `params` via React's `use()`;
// this guards that the resolved id reaches the wishlist data load.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Suspense } from 'react';
import { render, screen, act } from '@testing-library/react';
import { getWishlist } from '@/lib/admin-api-client';
import EditWishlistPage from './page';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('@/lib/admin-api-client', () => ({
  getWishlist: vi.fn(),
  updateWishlist: vi.fn(),
  deleteWishlist: vi.fn(),
  createItem: vi.fn(),
  updateItem: vi.fn(),
  deleteItem: vi.fn(),
  createTag: vi.fn(),
  deleteTag: vi.fn(),
}));

const getWishlistMock = vi.mocked(getWishlist);

beforeEach(() => {
  getWishlistMock.mockReset();
  getWishlistMock.mockResolvedValue({
    wishlist: {
      id: 'wl-test',
      slug: 'demo',
      title: 'Test Wishlist',
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
    items: [],
    tags: [],
  });
});

describe('EditWishlistPage (admin/[id])', () => {
  it('unwraps the Promise params with use() and loads the wishlist by that id', async () => {
    // `use()` suspends until the params promise resolves — render inside an
    // awaited async act() so the suspense + mount effect settle in-scope.
    await act(async () => {
      render(
        <Suspense fallback={<div>loading</div>}>
          <EditWishlistPage params={Promise.resolve({ id: 'wl-test' })} />
        </Suspense>,
      );
    });

    expect(await screen.findByText('Test Wishlist')).toBeInTheDocument();
    expect(getWishlistMock).toHaveBeenCalledWith('wl-test');
  });
});
