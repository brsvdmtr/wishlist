// Regression tests — Next 15 async-params migration of the admin wishlist
// route handler. `params` is now a Promise; these guard that each handler
// awaits it so the resolved id reaches the proxied API path.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { proxyToAPI } from '@/lib/api-proxy';
import { GET, PATCH, DELETE } from './route';

vi.mock('@/lib/api-proxy', () => ({ proxyToAPI: vi.fn() }));

const proxy = vi.mocked(proxyToAPI);

function makeReq(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}

beforeEach(() => {
  proxy.mockReset();
  proxy.mockResolvedValue(new Response('{}', { status: 200 }));
});

describe('admin /api/admin/wishlists/[id]', () => {
  it('GET awaits params and proxies to the public wishlist endpoint', async () => {
    await GET(makeReq('http://localhost/api/admin/wishlists/wl-1'), {
      params: Promise.resolve({ id: 'wl-1' }),
    });
    expect(proxy).toHaveBeenCalledWith({ method: 'GET', path: '/public/wishlists/wl-1' });
  });

  it('PATCH awaits params and forwards the parsed body', async () => {
    await PATCH(
      makeReq('http://localhost/api/admin/wishlists/wl-2', {
        method: 'PATCH',
        body: JSON.stringify({ title: 'Renamed' }),
      }),
      { params: Promise.resolve({ id: 'wl-2' }) },
    );
    expect(proxy).toHaveBeenCalledWith({
      method: 'PATCH',
      path: '/wishlists/wl-2',
      body: { title: 'Renamed' },
    });
  });

  it('DELETE awaits params and proxies the delete', async () => {
    await DELETE(makeReq('http://localhost/x', { method: 'DELETE' }), {
      params: Promise.resolve({ id: 'wl-3' }),
    });
    expect(proxy).toHaveBeenCalledWith({ method: 'DELETE', path: '/wishlists/wl-3' });
  });

  it('returns the Response from proxyToAPI unchanged', async () => {
    const sentinel = new Response('payload', { status: 201 });
    proxy.mockResolvedValueOnce(sentinel);
    const res = await GET(makeReq('http://localhost/x'), {
      params: Promise.resolve({ id: 'wl-9' }),
    });
    expect(res).toBe(sentinel);
  });
});
