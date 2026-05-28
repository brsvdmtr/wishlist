// WishBoard image proxy Worker.
//
// Threat closed: privacy leak via direct external `<img src>` loads.
// Pre-2026-05-28 a wishlist owner who set `item.imageUrl` to a host they
// control (`https://attacker.example/track.gif`) could log the IP /
// User-Agent of every guest viewer. We already closed the Referer-leak
// via `<meta name="referrer" content="no-referrer">` in the Mini App
// layout; closing the IP-leak requires the request to come from
// somewhere OTHER than the viewer's browser.
//
// This Worker routes `https://wishlistik.ru/cdn-img/?url=<encoded>` →
// fetches `<encoded>` from Cloudflare's network and re-streams the bytes
// to the viewer. The attacker server sees CF's outgoing IP, not the
// viewer's. Cache the result at the edge for 24 h so repeat views of
// the same item don't hit upstream at all.
//
// SSRF: Cloudflare Workers `fetch()` blocks private IP ranges by
// default; we layer URL-shape validation + an explicit scheme allowlist
// (http/https only) so an attacker can't pivot via custom protocols.
// We do NOT pin DNS (the H1 API fix does) — that would require resolver
// access the Worker runtime doesn't expose. The CF private-IP guard
// covers the SSRF class for this surface.
//
// Pass-through fallback: an unrecognized path / method returns the
// origin's response unchanged. The maintenance-worker covers `/`,
// `/miniapp*`, `/w/*`, `/api/*`, `/__cf-maintenance-*` — this Worker
// owns `/cdn-img/*` only.

export interface Env {
  IMAGE_PROXY_DISABLED: string;
  // Optional max-bytes override. Set via `wrangler secret put` if origin
  // images grow past the default.
  IMAGE_PROXY_MAX_BYTES?: string;
}

const DEFAULT_MAX_BYTES = 15 * 1024 * 1024; // 15 MB
const FETCH_TIMEOUT_MS = 10_000; // 10 s
const PROXY_UA =
  'Mozilla/5.0 (compatible; WishBot-ImageProxy/1.0; +https://wishlistik.ru)';

const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/svg+xml', // proxied harmlessly; the Mini App never executes SVG
  'image/avif',
  'image/heic',
  'image/heif',
]);

const CACHE_TTL_SECONDS = 86_400; // 24 h

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (env.IMAGE_PROXY_DISABLED === '1') return fetch(req);

    const url = new URL(req.url);
    if (!url.pathname.startsWith('/cdn-img/')) return fetch(req);

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return new Response('method_not_allowed', { status: 405, headers: noStore() });
    }

    const rawUrl = url.searchParams.get('url');
    if (!rawUrl) {
      return new Response('missing_url', { status: 400, headers: noStore() });
    }

    let target: URL;
    try {
      target = new URL(rawUrl);
    } catch {
      return new Response('invalid_url', { status: 400, headers: noStore() });
    }

    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return new Response('forbidden_scheme', { status: 400, headers: noStore() });
    }

    if (isLikelyPrivateHost(target.hostname)) {
      // Belt-and-suspenders on top of CF's runtime private-IP guard.
      return new Response('forbidden_host', { status: 400, headers: noStore() });
    }

    // Edge cache lookup. Cache key = the proxy URL exactly as the client
    // requested it, so two different rawUrl encodings are two different
    // cache entries (intentional — we don't normalise on the way in).
    const cacheKey = new Request(req.url, { method: 'GET' });
    const cache = caches.default;
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let upstream: Response;
    try {
      upstream = await fetch(target.toString(), {
        method: 'GET',
        headers: {
          'User-Agent': PROXY_UA,
          Accept: 'image/*',
        },
        redirect: 'follow', // safe — we're not in a cookie context
        signal: ctrl.signal,
        cf: {
          // Ask CF to cache the upstream fetch separately from the
          // viewer-facing response. Costs nothing extra; halves origin
          // load on the cold-cache path when the same upstream URL
          // arrives via two slightly different cache keys.
          cacheTtl: CACHE_TTL_SECONDS,
          cacheEverything: true,
        },
      });
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.name : 'fetch_failed';
      return new Response(`upstream_${msg}`, { status: 502, headers: noStore() });
    }
    clearTimeout(timer);

    if (!upstream.ok) {
      return new Response(`upstream_${upstream.status}`, {
        status: upstream.status === 404 ? 404 : 502,
        headers: noStore(),
      });
    }

    const ctRaw = (upstream.headers.get('content-type') ?? '').toLowerCase();
    const ct = ctRaw.split(';')[0]!.trim();
    if (!ALLOWED_CONTENT_TYPES.has(ct)) {
      return new Response(`forbidden_type:${ct || 'unknown'}`, {
        status: 415,
        headers: noStore(),
      });
    }

    const maxBytes = parsePositiveInt(env.IMAGE_PROXY_MAX_BYTES) ?? DEFAULT_MAX_BYTES;
    const cl = Number(upstream.headers.get('content-length') ?? 0);
    if (cl > maxBytes) {
      return new Response('too_large', { status: 413, headers: noStore() });
    }

    // Build the viewer-facing response. We deliberately strip the
    // upstream's caching / cookie / CORS / privacy headers and substitute
    // our own: long cache, generous CORS-resource-policy (because the
    // Mini App needs to render it in an <img>), no Referer / SetCookie.
    const responseHeaders = new Headers();
    responseHeaders.set('Content-Type', ct);
    responseHeaders.set('Cache-Control', `public, max-age=${CACHE_TTL_SECONDS}, immutable`);
    responseHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');
    responseHeaders.set('X-Content-Type-Options', 'nosniff');
    // Don't help the next layer of analytics tracking — strip any
    // Server / X-Powered-By inherited from upstream.
    responseHeaders.delete('Server');
    responseHeaders.delete('X-Powered-By');

    const response = new Response(upstream.body, {
      status: 200,
      headers: responseHeaders,
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};

function noStore(): HeadersInit {
  return {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  };
}

function parsePositiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Conservative private-host check. The CF Worker runtime already blocks
 * fetches to RFC1918 IPv4 / IPv6-ULA / loopback, so this is a
 * fast-rejection layer that returns a clean 400 instead of letting the
 * Worker make a fetch that CF then rejects with a generic 5xx.
 *
 * Strings like `127.0.0.1`, `[::1]`, `localhost`, `*.localhost`, and a
 * sampling of dot-decimal private blocks are matched. Hostnames that
 * resolve to a private IP via DNS still pass this check (the Worker
 * runtime catches them at fetch time) — pure-name DNS-rebinding via
 * Worker would need resolver access we don't have.
 */
export function isLikelyPrivateHost(hostname: string): boolean {
  if (!hostname) return true;
  const h = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0' || h === '::' || h === '::1') return true;
  // IPv4 RFC1918 + loopback + link-local + cloud metadata
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (/^0\./.test(h)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true; // CGN
  // IPv6 ULA / link-local / loopback
  if (/^fc[0-9a-f]{2}:/i.test(h)) return true;
  if (/^fd[0-9a-f]{2}:/i.test(h)) return true;
  if (/^fe80:/i.test(h)) return true;
  // Decimal / octal / hex encodings of 127.0.0.1
  if (h === '2130706433') return true; // decimal 127.0.0.1
  if (/^0x7f/i.test(h)) return true; // hex prefix of 127.x
  return false;
}
