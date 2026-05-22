// Regression tests — Next 15 async-params migration of the curated
// selection page. `params` is a Promise; these guard that generateMetadata
// and the page component await it before using the token.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactElement } from 'react';
import { notFound } from 'next/navigation';
import CuratedSelectionPage, { generateMetadata } from './page';

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('./CuratedSelectionClient', () => ({ default: () => null }));

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

describe('CuratedSelectionPage (p/[token])', () => {
  it('awaits params and fetches the selection by the resolved token', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200, { selection: { title: 'Gifts', itemCount: 4 } }));

    const el = (await CuratedSelectionPage({
      params: Promise.resolve({ token: 'tok-abc' }),
    })) as unknown as ReactElement<{ token: string }>;

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/public/selections/tok-abc'),
      { cache: 'no-store' },
    );
    expect(el.props.token).toBe('tok-abc');
  });

  it('calls notFound() when the selection 404s', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));

    await expect(
      CuratedSelectionPage({ params: Promise.resolve({ token: 'missing' }) }),
    ).rejects.toThrow('NEXT_NOT_FOUND');
    expect(notFoundMock).toHaveBeenCalled();
  });
});

describe('generateMetadata (p/[token])', () => {
  it('awaits params and titles from the fetched selection', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { selection: { title: 'Birthday', itemCount: 7 } }),
    );

    const meta = await generateMetadata({ params: Promise.resolve({ token: 'tok-x' }) });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/public/selections/tok-x'),
      { cache: 'no-store' },
    );
    expect(meta.title).toBe('Birthday — WishBoard');
  });
});
