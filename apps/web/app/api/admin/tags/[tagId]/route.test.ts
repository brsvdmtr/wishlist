// Regression test — Next 15 async-params migration of the admin tag
// route handler. Guards that `params` is awaited (tagId).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { proxyToAPI } from '@/lib/api-proxy';
import { DELETE } from './route';

vi.mock('@/lib/api-proxy', () => ({ proxyToAPI: vi.fn() }));

const proxy = vi.mocked(proxyToAPI);

function makeReq(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}

beforeEach(() => {
  proxy.mockReset();
  proxy.mockResolvedValue(new Response('{}', { status: 200 }));
});

describe('admin /api/admin/tags/[tagId]', () => {
  it('DELETE awaits params and proxies the tag delete', async () => {
    await DELETE(makeReq('http://localhost/x', { method: 'DELETE' }), {
      params: Promise.resolve({ tagId: 'tag-1' }),
    });
    expect(proxy).toHaveBeenCalledWith({ method: 'DELETE', path: '/tags/tag-1' });
  });
});
