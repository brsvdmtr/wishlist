// Regression tests — Next 15 async-params migration of the admin wishlist
// items route handler. Guards that `params` is awaited and the request
// query string is forwarded to the proxied path.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { proxyToAPI } from '@/lib/api-proxy';
import { GET, POST } from './route';

vi.mock('@/lib/api-proxy', () => ({ proxyToAPI: vi.fn() }));

const proxy = vi.mocked(proxyToAPI);

function makeReq(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}

beforeEach(() => {
  proxy.mockReset();
  proxy.mockResolvedValue(new Response('{}', { status: 200 }));
});

describe('admin /api/admin/wishlists/[id]/items', () => {
  it('GET awaits params and proxies the wishlist items', async () => {
    await GET(makeReq('http://localhost/api/admin/wishlists/wl-1/items'), {
      params: Promise.resolve({ id: 'wl-1' }),
    });
    expect(proxy).toHaveBeenCalledWith({
      method: 'GET',
      path: '/public/wishlists/wl-1/items',
    });
  });

  it('GET forwards the request query string to the proxied path', async () => {
    await GET(
      makeReq('http://localhost/api/admin/wishlists/wl-1/items?status=AVAILABLE&tag=books'),
      { params: Promise.resolve({ id: 'wl-1' }) },
    );
    expect(proxy).toHaveBeenCalledWith({
      method: 'GET',
      path: '/public/wishlists/wl-1/items?status=AVAILABLE&tag=books',
    });
  });

  it('POST awaits params and forwards the parsed body', async () => {
    await POST(
      makeReq('http://localhost/api/admin/wishlists/wl-2/items', {
        method: 'POST',
        body: JSON.stringify({ title: 'Item', url: 'https://example.com' }),
      }),
      { params: Promise.resolve({ id: 'wl-2' }) },
    );
    expect(proxy).toHaveBeenCalledWith({
      method: 'POST',
      path: '/wishlists/wl-2/items',
      body: { title: 'Item', url: 'https://example.com' },
    });
  });
});
