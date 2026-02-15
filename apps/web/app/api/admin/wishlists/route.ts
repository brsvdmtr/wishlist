import { NextRequest } from 'next/server';
import { proxyToAPI } from '@/lib/api-proxy';

export const dynamic = 'force-dynamic';

/**
 * GET /api/admin/wishlists
 * Proxy to: GET /wishlists
 */
export async function GET() {
  return proxyToAPI({
    method: 'GET',
    path: '/wishlists',
  });
}

/**
 * POST /api/admin/wishlists
 * Proxy to: POST /wishlists
 */
export async function POST(req: NextRequest) {
  const body = await req.json();

  return proxyToAPI({
    method: 'POST',
    path: '/wishlists',
    body,
  });
}
