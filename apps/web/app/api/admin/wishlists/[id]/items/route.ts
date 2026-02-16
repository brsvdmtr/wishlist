import { NextRequest } from 'next/server';
import { proxyToAPI } from '@/lib/api-proxy';

export const dynamic = 'force-dynamic';

type Params = { params: { id: string } };

/**
 * GET /api/admin/wishlists/[id]/items
 * Proxy to: GET /public/wishlists/:slug/items
 */
export async function GET(req: NextRequest, { params }: Params) {
  const { id } = params;
  const { searchParams } = new URL(req.url);

  // Pass through query params (status, tag)
  const queryString = searchParams.toString();
  const path = `/public/wishlists/${id}/items${queryString ? `?${queryString}` : ''}`;

  return proxyToAPI({
    method: 'GET',
    path,
  });
}

/**
 * POST /api/admin/wishlists/[id]/items
 * Proxy to: POST /wishlists/:id/items
 */
export async function POST(req: NextRequest, { params }: Params) {
  const { id } = params;
  const body = await req.json();

  return proxyToAPI({
    method: 'POST',
    path: `/wishlists/${id}/items`,
    body,
  });
}
