# Public Web `/w/:slug` — Usage Audit

**Date:** 2026-05-25
**Author:** Audit triggered by feature-map "usage uncertain" flag on the public SSR wishlist surface.
**Window:** Last 30 days (analytics) + last ~13 days (nginx access logs, retention horizon).

---

## 1. What is the surface?

`apps/web/app/w/[slug]/page.tsx` is a Next.js server-rendered public wishlist
page reachable at `https://wishlistik.ru/w/<slug>`. It is rendered **outside**
the Telegram Mini App context — a browser viewer can open it without Telegram,
reserve items as a guest (no auth, only a client-generated `actorHash`),
and mark them purchased.

The page calls one API endpoint:

- `GET /api/public/wishlists/:slug` → fires
  [`guest.view_opened`](../../apps/api/src/routes/public.routes.ts:266)

Reserve / unreserve / purchase actions call:

- `POST /api/public/items/:id/reserve` → fires
  [`reservation.succeeded`](../../apps/api/src/routes/public.routes.ts:696)
  with the distinguishing prop `hasReserverUser` (this prop is absent on
  Mini App reservations from `reservations.routes.ts:1310`).

Mini App **also** has a fallback path that calls `/public/wishlists/:slug`
([`MiniApp.tsx:7667`](../../apps/web/app/miniapp/MiniApp.tsx)), but only
when the param fails to resolve via `/public/share/:token` first. The
share-token path does **not** fire `guest.view_opened` — it just
increments `Wishlist.shareOpenCount`. So `guest.view_opened` is a near-pure
signal for the SSR web surface, with Mini App slug-fallback as a small
contaminant.

> **Не путать:** Mini App "guest opens" go through `/public/share/:token`
> (no analytics event, only `shareOpenCount++`). Web SSR opens fire
> `guest.view_opened`. The two paths share the `/public/wishlists/:slug`
> endpoint only in the Mini App fallback case (rare).

---

## 2. Traffic numbers — 30 days

### 2.1 `guest.view_opened` totals (web SSR proxy)

```sql
SELECT
  COUNT(*) AS guest_view_opened_total,
  COUNT(DISTINCT (props->>'slug')) AS distinct_slugs,
  COUNT(DISTINCT DATE_TRUNC('day', "createdAt")) AS active_days,
  MIN("createdAt") AS first_event,
  MAX("createdAt") AS last_event,
  ROUND(AVG((props->>'itemCount')::int)::numeric, 1) AS avg_item_count
FROM "AnalyticsEvent"
WHERE event = 'guest.view_opened' AND "createdAt" >= NOW() - INTERVAL '30 days';
```

| Metric | Value |
|--------|-------|
| Total events | **49** |
| Distinct slugs | **4** |
| Active days | 23 / 30 |
| Date range | 2026-04-25 → 2026-05-22 |
| Avg item count | 6.7 |

**Caveat — SSR double-fire factor:** [`page.tsx`](../../apps/web/app/w/[slug]/page.tsx)
calls `fetchWishlist` from both `generateMetadata` and the page component,
each with `cache: 'no-store'`. Next 15's Request Memoization may or may not
dedupe under `no-store`; pessimistic assumption is one SSR page load ≈ 2
events. So **49 events ≈ 25–49 actual pageviews.**

### 2.2 Slug breakdown — almost all of the traffic is the demo

```sql
SELECT props->>'slug' AS slug, COUNT(*) AS hits, COUNT(DISTINCT DATE_TRUNC('day', "createdAt")) AS active_days
FROM "AnalyticsEvent"
WHERE event = 'guest.view_opened' AND "createdAt" >= NOW() - INTERVAL '30 days'
GROUP BY props->>'slug' ORDER BY hits DESC;
```

| Slug | Hits | Active days | Wishlist | Note |
|------|-----:|-----------:|----------|------|
| `demo` | **41** (84%) | 21 | "Demo wishlist", LINK_ONLY | Linked from homepage `/` |
| `tg-917409999` | 5 | 4 | "Кошкин вишлист", LINK_ONLY, has shareToken | Real user |
| `list-EAemmO` | 2 | 2 | "Медвежий вишлист", PUBLIC_PROFILE, 5 token-opens | Real user |
| `tg-327159577` | 1 | 1 | "My wishlist", LINK_ONLY, no token | Real user (likely test) |

**Non-demo real-user traffic: 8 events / 30 days across 3 wishlists, 6 active days.**

### 2.3 Reservations from web — zero

```sql
SELECT
  CASE WHEN props ? 'hasReserverUser' THEN 'public_web_anon' ELSE 'miniapp_authed' END AS path,
  COUNT(*) AS cnt
FROM "AnalyticsEvent"
WHERE event = 'reservation.succeeded' AND "createdAt" >= NOW() - INTERVAL '30 days'
GROUP BY 1;
```

| Path | Reservations |
|------|-----:|
| `public_web_anon` (props.hasReserverUser present) | **0** |
| `miniapp_authed` | 20 |

**Zero conversions through the public web reservation flow.** Every
reservation in the last 30 days happened inside the Mini App.

### 2.4 90-day weekly trend — declining

```sql
SELECT DATE_TRUNC('week', "createdAt") AS week, COUNT(*) AS guest_view_opened,
       COUNT(DISTINCT props->>'slug') AS distinct_slugs
FROM "AnalyticsEvent"
WHERE event = 'guest.view_opened' AND "createdAt" >= NOW() - INTERVAL '90 days'
GROUP BY 1 ORDER BY 1;
```

| Week start | Views | Distinct slugs |
|------------|-----:|---:|
| 2026-03-30 | 18 | 6 |
| 2026-04-06 | 15 | 4 |
| 2026-04-13 | 66 | 4 |
| 2026-04-20 | 20 | 3 |
| 2026-04-27 | 13 | 4 |
| 2026-05-04 | 10 | **1** |
| 2026-05-11 | 9 | **1** |
| 2026-05-18 | 11 | 2 |

Both views and distinct-slug count have collapsed since mid-April. Recent
weeks see one (1) wishlist being viewed at all — the demo.

### 2.5 nginx access logs — 13-day cross-check (bot-filtered)

Logs retained 2026-05-12 → 2026-05-25 in `/var/log/nginx/access.log*`.
Bots filtered: UptimeRobot, Google/Yandex/Bing/Telegram/Facebook/MJ12/Ahrefs/Semrush,
curl, wget, python, undici, node-fetch, generic crawl/spider.

| Path | Requests (13d) |
|------|---:|
| `/w/<slug>` (Next SSR page, all hits) | **28** |
| `/w/<slug>` HTML loads | 17 |
| `/w/<slug>` RSC payloads (`_rsc=`) | 11 |
| `/api/public/wishlists/<slug>` (API used by both SSR & Mini App fallback) | 20 |
| `/api/public/share/<token>` (Mini App share-token path) | **56** |
| `/api/public/items/.../reserve|purchase|unreserve` | **0** |
| `/api/public/profiles/<u>` | 1 |

All 27 directly-resolvable `/w/<slug>` requests in nginx (excluding RSC
prefetches with truncated URLs) hit `/w/demo`. Real-user slugs are not
shareable enough to surface in 13-day nginx retention.

---

## 3. Mini App comparable — what should we benchmark against?

Two reasonable benchmarks for "guest opens of a shared wishlist":

| Benchmark | 30d value | Source |
|-----------|----------:|--------|
| `/api/public/share/<token>` API hits (nginx 13d ≈ 56 → extrapolated) | ~129 | Mini App share-token path |
| `miniapp_start_payload_resolved` (Mini App deep-link starts) | 87 | Analytics events |

Both proxy "outside person opens someone's shared wishlist via Mini App."

**Public web's share of total guest opens (real users only — excluding demo):**

| Denominator | Public-web share |
|-------------|----:|
| Web non-demo (8) / (8 + 129 share-token hits) | **5.8%** |
| Web non-demo (8) / (8 + 87 deep-link starts) | **8.4%** |

If we include the demo, web's share looks larger (~28%), but the demo is a
homepage-driven curiosity asset, not real product use.

**Net read:** real-user public-web traffic is borderline above the 5%
retire threshold by traffic alone, but **0% by conversion** (no reservations).

---

## 4. Decision

**Recommendation: Retire the public-web reservation flow.
Keep `/w/<slug>` as a thin landing/OG card with a "Open in Telegram" CTA.**

### Why not full retire

- Open Graph link previews (og:title, og:image) still need a server-rendered
  endpoint when the URL is pasted into non-Telegram surfaces (WhatsApp,
  iMessage, browsers).
- `/w/demo` is the homepage's "Открыть демо" CTA — removing it breaks a
  marketing path. It's also the largest single contributor (84%) to public
  web traffic and is functioning as intended.
- The slug URL is canonical and may be embedded in user-shared posts,
  message threads, etc. — 410ing breaks links.

### Why not keep as-is

- **0 conversions in 30 days** on the full reservation/purchase flow —
  it's all UI surface with no value delivered.
- Maintenance cost: full `WishlistClient.tsx` with reserve / purchase /
  unreserve UI, toast system, actorHash localStorage logic, etc. None of
  it is exercised in prod.
- Security surface: anonymous (actorHash-only) reservation endpoint with
  permissive `publicActionLimiter` (30 req/15min). Low absolute risk at
  current volume but pure liability for zero benefit.
- Confuses the product story — a single conversion path (Mini App) is
  cleaner than two with one of them dead.

### Proposed scope of the retire

| File / endpoint | Action |
|-----------------|--------|
| [`apps/web/app/w/[slug]/page.tsx`](../../apps/web/app/w/[slug]/page.tsx) | **Keep**, simplify — keep metadata/OG, drop full client |
| [`apps/web/app/w/[slug]/WishlistClient.tsx`](../../apps/web/app/w/[slug]/WishlistClient.tsx) | **Replace** with a minimal landing component: title, item summary, "Open in Telegram" CTA via `t.me/<bot>?start=<token-or-slug>` |
| [`apps/api/src/routes/public.routes.ts`](../../apps/api/src/routes/public.routes.ts) `POST /public/items/:id/reserve` | **Remove** (0 calls in 13d) |
| `POST /public/items/:id/purchase` | **Remove** (0 calls in 13d) |
| `POST /public/items/:id/unreserve` | **Remove** (0 calls in 13d) |
| `GET /public/wishlists/:slug` | **Keep** — still used by Mini App fallback and SSR landing page |
| `GET /public/share/:token` | **Keep** — primary Mini App entry (56 hits / 13d) |
| `GET /public/profiles/:username` | **Keep** — separate concern (PUBLIC_PROFILE feature) |
| `guest.view_opened` event | **Keep** — still useful as a signal for landing-page hits |

### Rollout

1. Land the simplified landing page behind a deploy (no feature flag — diff is
   pure deletion of unused code).
2. Watch for any spike in 410/404 from the removed POST endpoints (expected: 0).
3. After 14 days of clean logs, delete the dead reservation routes for real.

### What would change the decision

If a marketing push or growth experiment intentionally drives non-Telegram
users to `/w/<slug>` AND we want them to convert without a Telegram account,
keep the reservation flow. There is no such initiative on the roadmap today
(checked feature-map and experiment backlog).

---

## 5. Reproducing the queries

All queries above run against the prod Postgres (`wishlist-prod-postgres-1`)
via the standard ops path:

```bash
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "<query>"'
```

nginx counts come from:

```bash
ssh vultr 'sudo zcat -f /var/log/nginx/access.log* | <awk-filter>'
```

with the bot-exclusion regex listed in § 2.5.

Logs retention is ~14 days on nginx (`/var/log/nginx/access.log{,.1,.2.gz,…,.14.gz}`)
and 90 days on AnalyticsEvent (per the TTL in [`schema.prisma`](../../packages/db/prisma/schema.prisma)
near `model AnalyticsEvent`). Re-run quarterly to confirm the decision still holds.
