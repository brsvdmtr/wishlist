import { NextRequest } from 'next/server';
import { proxyToAPI } from '@/lib/api-proxy';

export const dynamic = 'force-dynamic';

type Params = { params: { itemId: string } };

/**
 * PATCH /api/admin/items/[itemId]
 * Proxy to: PATCH /items/:id
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { itemId } = params;
  const body = await req.json();

  return proxyToAPI({
    method: 'PATCH',
    path: `/items/${itemId}`,
    body,
  });
}

/**
 * DELETE /api/admin/items/[itemId]
 * Proxy to: DELETE /items/:id
 */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { itemId } = params;

  return proxyToAPI({
    method: 'DELETE',
    path: `/items/${itemId}`,
  });
}
