// Regression tests — Next 15 async-params migration of the admin item
// route handler. Guards that `params` is awaited (itemId).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { proxyToAPI } from '@/lib/api-proxy';
import { PATCH, DELETE } from './route';

vi.mock('@/lib/api-proxy', () => ({ proxyToAPI: vi.fn() }));

const proxy = vi.mocked(proxyToAPI);

function makeReq(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}

beforeEach(() => {
  proxy.mockReset();
  proxy.mockResolvedValue(new Response('{}', { status: 200 }));
});

describe('admin /api/admin/items/[itemId]', () => {
  it('PATCH awaits params and forwards the parsed body', async () => {
    await PATCH(
      makeReq('http://localhost/x', {
        method: 'PATCH',
        body: JSON.stringify({ status: 'RESERVED' }),
      }),
      { params: Promise.resolve({ itemId: 'it-1' }) },
    );
    expect(proxy).toHaveBeenCalledWith({
      method: 'PATCH',
      path: '/items/it-1',
      body: { status: 'RESERVED' },
    });
  });

  it('DELETE awaits params and proxies the item delete', async () => {
    await DELETE(makeReq('http://localhost/x', { method: 'DELETE' }), {
      params: Promise.resolve({ itemId: 'it-2' }),
    });
    expect(proxy).toHaveBeenCalledWith({ method: 'DELETE', path: '/items/it-2' });
  });
});
