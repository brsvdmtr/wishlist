// Image proxy helper for the Mini App.
//
// Routes user-content image URLs through the Cloudflare Worker at
// `wishlistik.ru/cdn-img/?url=<encoded>` (see
// `infra/cloudflare/image-proxy-worker/`). The Worker fetches the
// external host from Cloudflare's network and re-streams the bytes to
// the viewer, so the third-party host never sees the viewer's IP / UA.
// Closes the IP-leak half of finding M2 from the 2026-05-28 audit; the
// Referer-leak half is already closed by the `<meta name="referrer">`
// policy in `app/miniapp/layout.tsx`.
//
// What goes through the proxy:
//   - `https://cdn.wildberries.ru/<...>` and every other external image
//     URL referenced by `item.imageUrl` / `idea.imageUrl`.
//
// What stays direct:
//   - `/api/uploads/<...>` and `/uploads/<...>` — our own server-side
//     uploads (avatars, item photos). Already same-origin.
//   - `data:` URLs — already inline, no third-party load happens.
//   - Anything on `wishlistik.ru` itself (would just round-trip).
//   - URLs that fail to parse OR use a scheme other than http/https —
//     the caller falls back to a placeholder.
//
// Kill switch: `NEXT_PUBLIC_IMAGE_PROXY=enabled` at build time turns
// the proxy on; ANY other value (or unset) keeps direct image loads,
// i.e. the pre-2026-05-28 behaviour. The default is "off" so a Mini
// App build can land in prod BEFORE the Worker is deployed without
// breaking image loads — the activation is a separate, explicit step
// (set the env var and rebuild). The Worker has its own independent
// `IMAGE_PROXY_DISABLED=1` revert path for the inverse case.

const PROXY_PATH = '/cdn-img/';

// Read per-call so tests can flip the env var without re-importing the
// module. In a real Next.js build `process.env.NEXT_PUBLIC_*` is
// inlined as a string literal at build time, so the read is a constant
// expression and the closure cost is zero.
function proxyEnabled(): boolean {
  return (process.env.NEXT_PUBLIC_IMAGE_PROXY ?? '').toLowerCase() === 'enabled';
}

const SAME_ORIGIN_HOSTS = new Set(['wishlistik.ru', 'www.wishlistik.ru']);

/**
 * Returns a URL suitable for use as `<img src>` or CSS
 * `background-image: url(...)`. External http(s) URLs are routed via
 * the Cloudflare Worker proxy; everything else is returned as-is or
 * `undefined` if it isn't safe to render at all.
 */
export function proxyImageUrl(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // Reject ASCII control characters (browsers and the URL parser are
  // inconsistent about how they handle embedded \n / \t / \r inside
  // scheme names — same reason `isSafeUserUrl` rejects them upfront).
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return undefined;

  // Kill switch — pre-2026-05-28 behaviour. Default is off so a Mini
  // App build can land before the Worker is deployed; flip via the
  // NEXT_PUBLIC_IMAGE_PROXY env var at build time.
  if (!proxyEnabled()) return trimmed;

  // Pass through our own uploads & data URIs unchanged.
  if (trimmed.startsWith('/api/uploads/') || trimmed.startsWith('/uploads/')) return trimmed;
  if (trimmed.startsWith('data:')) return trimmed;

  let parsed: URL;
  try {
    // Second arg gives the parser a base so root-relative paths resolve
    // without throwing. The actual hostname is what we care about.
    parsed = new URL(trimmed, 'https://wishlistik.ru');
  } catch {
    return undefined;
  }

  // Same-origin already — no third-party host involved.
  if (SAME_ORIGIN_HOSTS.has(parsed.hostname.toLowerCase())) return trimmed;

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;

  return `${PROXY_PATH}?url=${encodeURIComponent(trimmed)}`;
}
