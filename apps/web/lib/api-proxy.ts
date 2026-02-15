/**
 * Server-side API proxy helper
 * 
 * SECURITY: This module runs ONLY on the server (Next.js route handlers).
 * ADMIN_KEY is never exposed to the browser.
 */

const INTERNAL_API_BASE_URL =
  (process.env.INTERNAL_API_BASE_URL ?? 'http://localhost:3001').replace(/\/+$/, '');
const ADMIN_KEY = process.env.ADMIN_KEY;

if (!ADMIN_KEY) {
  console.error('[api-proxy] ADMIN_KEY is not configured. Admin endpoints will fail.');
}

export type ProxyOptions = {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
};

/**
 * Proxy request to Express API with ADMIN_KEY header
 */
export async function proxyToAPI(options: ProxyOptions): Promise<Response> {
  const { method, path, body, headers = {} } = options;

  if (!ADMIN_KEY) {
    return new Response(JSON.stringify({ error: 'ADMIN_KEY is not configured on server' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const url = `${INTERNAL_API_BASE_URL}${path}`;

  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-ADMIN-KEY': ADMIN_KEY,
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store',
    });

    // Pass through response as-is (status, headers, body)
    const data = await res.text();

    return new Response(data, {
      status: res.status,
      statusText: res.statusText,
      headers: {
        'Content-Type': res.headers.get('Content-Type') ?? 'application/json',
      },
    });
  } catch (err) {
    console.error('[api-proxy] Failed to proxy request:', { method, path, error: err });

    return new Response(
      JSON.stringify({
        error: 'Failed to connect to API server',
        details: err instanceof Error ? err.message : 'Unknown error',
      }),
      {
        status: 502,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  }
}
