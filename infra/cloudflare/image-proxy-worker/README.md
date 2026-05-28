# Image Proxy Worker

Cloudflare Worker that proxies external image fetches for the WishBoard
Mini App so the viewer's IP / User-Agent never reach a third-party host
listed in a wishlist (closes finding M2 from the 2026-05-28 security
audit).

## Why

Pre-fix the Mini App rendered `<img src={item.imageUrl}>` directly. An
owner who controlled `item.imageUrl` could point it at a logging server
(`https://attacker.example/track.gif`) and harvest the IP / UA of every
guest viewer. The `<meta name="referrer" content="no-referrer">`
already in the Mini App layout closed the Referer-leak side of the same
finding; this Worker closes the IP-leak side by interposing
Cloudflare's network between the viewer and the third-party host.

## Routes

- `wishlistik.ru/cdn-img/*`
- `www.wishlistik.ru/cdn-img/*`

Other paths fall through unchanged via `return fetch(req)`.

## Request shape

```
GET https://wishlistik.ru/cdn-img/?url=<encoded-external-url>
```

The Worker:
1. Validates the URL shape, allows only `http:` / `https:`.
2. Rejects obvious private-IP hostnames as a fast-path on top of CF's
   built-in private-IP fetch guard.
3. Checks the edge cache (24 h TTL).
4. On miss: fetches upstream with a 10 s timeout, a 15 MB max-bytes
   limit, and a strict Content-Type allowlist
   (`image/{jpeg,png,webp,gif,svg+xml,avif,heic,heif}`).
5. Strips upstream `Server` / `X-Powered-By` headers and rewrites
   `Cache-Control` to `public, max-age=86400, immutable`.
6. Caches the response at the CF edge.

## Deploy

```bash
cd infra/cloudflare/image-proxy-worker
pnpm install
pnpm deploy
```

`pnpm deploy` runs `tsc --noEmit` then `wrangler deploy`. The
wrangler.toml is already wired with the prod `account_id` and
`zone_id`; no other config is required.

After the first deploy, verify the route lands traffic:

```bash
curl -s 'https://wishlistik.ru/cdn-img/?url=https://cdn.wildberries.ru/some-image.jpg' \
  --output /dev/null -w '%{http_code} %{content_type} %{size_download}\n'
```

A `200 image/jpeg N` response means the Worker is live and the cache
seeded the first byte. Repeat the same request — `cf-cache-status:
HIT` should appear in the response headers.

## Kill switch

```bash
# Edit wrangler.toml: IMAGE_PROXY_DISABLED = "1"
wrangler deploy
```

With the kill switch on, the Worker is a pure `fetch(req)` pass-through.
The Mini App's `proxyImageUrl()` helper has its own kill switch (env
`NEXT_PUBLIC_IMAGE_PROXY=disabled` at build time) — either side can
shut the proxy off without touching the other.

## Cache behaviour

Edge cache TTL is 24 h. Same external URL = same cache key, so two
wishlists referencing the same product image share a single cached
entry. Real product images rarely change, so the 24 h TTL is a safe
default; bump or shorten via the `CACHE_TTL_SECONDS` constant if
upstream behaviour changes.

## Operational notes

- The Worker does NOT pin DNS (the API-side
  `downloadAndProcessImage` does — see H1). The CF Workers runtime
  doesn't expose a resolver hook, and the runtime already blocks
  fetches to private IPs at the network layer.
- The Worker streams the upstream body — it doesn't buffer the whole
  image into memory. Memory profile per request stays bounded.
- Observability is on (`head_sampling_rate = 1.0`). Tail logs via
  `pnpm tail` during incidents.
