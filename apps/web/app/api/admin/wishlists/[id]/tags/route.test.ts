// Regression test — Next 15 async-params migration of the admin wishlist
// tags route handler. Guards that `params` is awaited.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { proxyToAPI } from '@/lib/api-proxy';
import { POST } from './route';

vi.mock('@/lib/api-proxy', () => ({ proxyToAPI: vi.fn() }));

const proxy = vi.mocked(proxyToAPI);

function makeReq(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}

beforeEach(() => {
  proxy.mockReset();
  proxy.mockResolvedValue(new Response('{}', { status: 200 }));
});

describe('admin /api/admin/wishlists/[id]/tags', () => {
  it('POST awaits params and forwards the parsed body to the tags endpoint', async () => {
    await POST(
      makeReq('http://localhost/x', {
        method: 'POST',
        body: JSON.stringify({ name: 'books' }),
      }),
      { params: Promise.resolve({ id: 'wl-7' }) },
    );
    expect(proxy).toHaveBeenCalledWith({
      method: 'POST',
      path: '/wishlists/wl-7/tags',
      body: { name: 'books' },
    });
  });
});
