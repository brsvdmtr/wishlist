// Regression tests — Next 15 async-params migration of the public wishlist
// page. `params` is a Promise; these guard that generateMetadata and the
// page component await it before using the slug.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { notFound } from 'next/navigation';
import WishlistPage, { generateMetadata } from './page';

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('./WishlistClient', () => ({ default: () => null }));

const notFoundMock = vi.mocked(notFound);
const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  notFoundMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('WishlistPage (w/[slug])', () => {
  it('awaits params and fetches the wishlist by the resolved slug', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { wishlist: { title: 'My list', description: null } }),
    );

    const el = (await WishlistPage({
      params: Promise.resolve({ slug: 'demo' }),
    })) as unknown as ReactElement<{ slug: string }>;

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/public/wishlists/demo'),
      { cache: 'no-store' },
    );
    expect(el.props.slug).toBe('demo');
  });

  it('calls notFound() when the wishlist 404s', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    await expect(
      WishlistPage({ params: Promise.resolve({ slug: 'ghost' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundMock).toHaveBeenCalled();
  });
});

describe('generateMetadata (w/[slug])', () => {
  it('awaits params and titles from the fetched wishlist', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { wishlist: { title: 'Birthday list', description: 'desc' } }),
    );

    const meta = await generateMetadata({ params: Promise.resolve({ slug: 'bday' }) });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/public/wishlists/bday'),
      { cache: 'no-store' },
    );
    expect(meta.title).toBe('Birthday list');
  });
});
