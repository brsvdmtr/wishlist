import { NextRequest } from 'next/server';
import { proxyToAPI } from '@/lib/api-proxy';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> };

/**
 * POST /api/admin/wishlists/[id]/tags
 * Proxy to: POST /wishlists/:id/tags
 */
export async function POST(req: NextRequest, props: Params) {
  const params = await props.params;
  const { id } = params;
  const body = await req.json();

  return proxyToAPI({
    method: 'POST',
    path: `/wishlists/${id}/tags`,
    body,
  });
}
