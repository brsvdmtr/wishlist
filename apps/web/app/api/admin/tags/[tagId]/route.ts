import { NextRequest } from 'next/server';
import { proxyToAPI } from '@/lib/api-proxy';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ tagId: string }> };

/**
 * DELETE /api/admin/tags/[tagId]
 * Proxy to: DELETE /tags/:id
 */
export async function DELETE(_req: NextRequest, props: Params) {
  const params = await props.params;
  const { tagId } = params;

  return proxyToAPI({
    method: 'DELETE',
    path: `/tags/${tagId}`,
  });
}
