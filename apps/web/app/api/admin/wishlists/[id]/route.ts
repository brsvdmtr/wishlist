import { NextRequest } from 'next/server';
import { proxyToAPI } from '@/lib/api-proxy';

export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };

/**
 * GET /api/admin/wishlists/[id]
 * Proxy to: GET /public/wishlists/:slug (using slug from id)
 * 
 * NOTE: API doesn't have GET /wishlists/:id for admin.
 * We use public endpoint to fetch, but could add admin endpoint if needed.
 */
export async function GET(_req: NextRequest, { params }: Params) {
  const { id } = params;

  // For now, we'll need to add a new endpoint in API or use public endpoint
  // Let's use public endpoint for now (it's safe, just returns data)
  return proxyToAPI({
    method: 'GET',
    path: `/public/wishlists/${id}`,
  });
}

/**
 * PATCH /api/admin/wishlists/[id]
 * Proxy to: PATCH /wishlists/:id
 */
export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = params;
  const body = await req.json();

  return proxyToAPI({
    method: 'PATCH',
    path: `/wishlists/${id}`,
    body,
  });
}

/**
 * DELETE /api/admin/wishlists/[id]
 * Proxy to: DELETE /wishlists/:id
 */
export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = params;

  return proxyToAPI({
    method: 'DELETE',
    path: `/wishlists/${id}`,
  });
}
