> Source of truth for the URL-based wish import system (PRO feature).
> Last updated: 2026-04-02 · Branch: main

# Link Import (URL-based Wish Import)

---

## 1. Overview

Link Import lets users create wish items by pasting a product URL. The system fetches the page, extracts the product title, price, description, and image, and creates a draft item pre-populated with that data.

This is a **PRO-only feature**. FREE users receive HTTP 402.

Key characteristics:

- Supports major Russian e-commerce platforms with dedicated adapters (Ozon, Wildberries, Яндекс Маркет, Lamoda, and others).
- Falls back to a generic browser-based extractor for unknown sites.
- All imported items land in the user's "Черновики" (Drafts) system wishlist.
- Results are cached for 24 hours (5 minutes for failures).
- Rate-limited to 10 requests per 60 seconds per user.

---

## 2. How to Use (User Perspective)

1. Find a product page on any online shop.
2. Copy the URL.
3. In WishBoard, tap "Add wish" → "Import from link" (or send the URL directly to the WishBoard Telegram bot).
4. The app fetches product data and creates a draft item with the extracted title, price, description, and image.
5. The new item appears in the "Черновики" (Drafts) wishlist.
6. From Drafts, the user can edit the item and move it to any other wishlist.

If extraction partially fails (e.g., price not found), the item is still created — using whatever was found, with the site hostname as the title if nothing else is available.

---

## 3. Extraction Pipeline

### Two-tier architecture

The import system has two tiers:

| Tier | Module | Handles | Features |
|---|---|---|---|
| **Marketplace orchestrator** | `marketplace/orchestrator.ts` | Known marketplaces (WB, Ozon, YM, GoldApple, etc.) | Field-level confidence scoring (0-100), tiered cache TTLs, early stop, strategy pipeline |
| **Legacy parser** | `url-parser.ts` | Unknown domains + orchestrator fallback | 5-level source priority merge, flat cache TTLs |

The orchestrator is tried first for known marketplaces. If it fails, returns `none` confidence, or produces a low-quality partial (below the fallback threshold of 25), the legacy parser takes over. A kill switch (`MARKETPLACE_PARSER_DISABLED=1`) instantly routes all marketplace URLs through the legacy flow.

### Full pipeline

```
1. Validate URL + canonicalize (strip tracking params)
        ↓
2. DNS SSRF check (assertDnsIsSafe() — resolve A/AAAA, reject private IPs)
        ↓
3. Route by domain
   ├─ Known marketplace + orchestrator enabled → orchestrator pipeline:
   │   a. Cache check (tiered TTL: high=24h, medium=4h, low=30min, negative=5min)
   │   b. Execute strategies in priority order
   │   c. Early stop when field confidence >= 70
   │   d. Merge results at field level (0-100 confidence per field)
   │   e. Anti-bot + garbage guard
   │   f. Cache with quality-based TTL → return
   │   g. If result is garbage (< 25 threshold) → fall through to legacy
   │
   └─ Unknown domain or orchestrator disabled/failed → legacy pipeline:
       a. Cache check (success=24h, negative=5min)
       b. Route:
          ├─ wildberries.ru / wb.ru  →  WB Search API (search.wb.ru)
          │                              └─ fail → browser fallback
          ├─ ozon.ru                 →  browser-first (skip HTTP fetch)
          ├─ market.yandex.ru        →  browser-first (skip HTTP fetch)
          └─ all others              →  HTTP fetch + Cheerio
                                         └─ confidence < medium → browser fallback
       c. Extraction (one or more sources, merged by priority)
       d. Anti-bot / garbage guard
       e. Cache store → return
```

### Source priority (highest to lowest)

When multiple extraction methods run (e.g., browser renders a page and also reads hydration state), results are merged in this order — higher-priority sources overwrite lower-priority ones field by field:

| Priority | Source key | Description |
|---|---|---|
| 1 | `network_response` | XHR/fetch JSON intercepted during browser page render |
| 2 | `next_data` | `__NEXT_DATA__` (Next.js server-side hydration object) |
| 3 | `hydration_state` | `window.__INITIAL_STATE__`, Redux store, Vuex state, etc. |
| 4 | `jsonld` | JSON-LD `<script type="application/ld+json">` Product schema |
| 5 | `og_meta` / `dom` | Open Graph meta tags + domain-specific CSS selectors |

A field extracted from `network_response` takes precedence over the same field from `og_meta`, but a missing field in `network_response` is filled in from the next available source.

---

## 4. Domain Support

### Dedicated adapters

These domains have hand-written extraction logic with the highest reliability:

| Domain | Method | Confidence |
|---|---|---|
| `wildberries.ru`, `wb.ru` | WB Search API (`search.wb.ru/exactmatch/...?query={id}`) | High |
| `ozon.ru` | Browser-first + `ozonAdapter` CSS selectors | High |
| `market.yandex.ru` | Browser-first + `ymAdapter` CSS selectors | High |
| `lamoda.ru` | HTTP fetch + `lamodaAdapter` CSS selectors | Medium–High |
| `goldapple.ru` | HTTP fetch + `goldappleAdapter` CSS selectors | Medium–High |
| `tehnopark.ru` | HTTP fetch + `tehnoparkAdapter` CSS selectors | Medium–High |
| `bork.ru` | HTTP fetch + `borkAdapter` CSS selectors | Medium–High |

### Generic fallback (all other domains)

For sites without a dedicated adapter:

| Method | What it reads | Confidence |
|---|---|---|
| `extractJsonLd` | `<script type="application/ld+json">` with `@type: Product` | Medium |
| Open Graph meta | `og:title`, `og:description`, `og:image`, `og:price:amount` | Low–Medium |
| Browser fallback | Full page render, network intercept, hydration state | Varies |

---

## 5. Browser Fallback

When is it used:

- `ozon.ru` and `market.yandex.ru` always use the browser (no HTTP-first attempt).
- `wildberries.ru` uses the browser if the WB Card API fails to return usable data.
- All other domains use the browser if the HTTP + Cheerio extraction returns confidence below `medium`.

### Implementation details

- Headless Chromium via `puppeteer-core`.
- Binary path: `/usr/bin/chromium` (override via `CHROMIUM_PATH` environment variable).
- **Singleton instance** with a 90-second idle timeout — the browser process is kept alive between requests and automatically closed after 90 seconds of inactivity.
- Launch flags: `--no-sandbox`, `--disable-setuid-sandbox`, `--disable-dev-shm-usage`, `--disable-gpu`, `--disable-extensions`, `--disable-background-networking`, `--disable-default-apps`, `--disable-sync`, `--no-first-run`, `--disable-crash-reporter` (note: `--single-process` was removed to keep the renderer in a separate process and limit blast radius from renderer exploits).

### What the browser does

1. Navigates to the product URL.
2. **Intercepts network responses** — any XHR or fetch response with a JSON content-type is captured and scanned for product data (`network_response` source).
3. After page load, reads `window.__NEXT_DATA__` (`next_data` source).
4. Reads common hydration state keys: `window.__INITIAL_STATE__`, Redux `window.__REDUX_STATE__`, Vuex state, etc. (`hydration_state` source).
5. Falls back to reading the rendered HTML and applying domain adapters or generic extractors.

---

## 6. Caching Behavior

Results are cached in-process using a `Map`. The two tiers have different TTL strategies:

### Legacy cache (unknown domains)

| Property | Value |
|---|---|
| Storage | In-memory `Map` (not persisted across restarts) |
| Max entries | 1,000 |
| Eviction policy | FIFO (oldest entry removed when limit is reached) |
| Success TTL | 24 hours |
| Negative TTL | 5 minutes (for failed or empty extractions) |
| Cache key | Canonical URL (after tracking param stripping) |

### Orchestrator cache (known marketplaces) -- tiered TTLs

| Result quality | TTL | Rationale |
|---|---|---|
| High confidence | 24 hours | Reliable result, no point re-fetching |
| Medium confidence | 4 hours | Decent but might improve on retry |
| Low confidence | 30 minutes | Likely garbage, retry sooner |
| Negative (anti-bot, total failure) | 5 minutes | Transient failures clear quickly |

Max entries: 1,000. Eviction: FIFO. Cache key: canonical URL or product key.

Because both caches are in-memory, they are cleared on every API process restart. Two users importing the same URL within the TTL window share the cached result.

---

## 7. URL Validation and Canonicalization

Before any fetch attempt, the URL is validated and cleaned:

**Validation rules:**

- Must use `http` or `https` scheme.
- Maximum length: 2,048 characters.
- Blocked hosts: `localhost`, `127.0.0.1`, and private IP ranges:
  - `10.0.0.0/8`
  - `172.16.0.0/12`
  - `192.168.0.0/16`

**DNS SSRF protection (`assertDnsIsSafe()`):**

After URL structure validation, `assertDnsIsSafe(url)` resolves the hostname's A and AAAA records and rejects the request if any resolved IP falls within a forbidden range. This prevents SSRF attacks where a public hostname resolves to a private IP. The check runs before any HTTP fetch or Puppeteer navigation.

**Redirect validation:**

HTTP redirects are followed manually (`redirect: 'manual'`). Each redirect target is re-validated through both `validateUrl()` (structure check) and `assertDnsIsSafe()` (DNS resolution check) before following. This prevents redirect-based SSRF where the initial URL is safe but redirects to an internal address.

**Canonicalization (tracking param stripping):**

The following query parameters are removed before processing and caching:

`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `yclid`, `gclid`, `fbclid`, `srsltid`, `ref`, and related tracking suffixes.

Stripping happens before the cache lookup, so `https://example.com/product?utm_source=email` and `https://example.com/product` resolve to the same cache entry.

---

## 8. Error Handling and Graceful Degradation

### Field-level confidence (orchestrator)

The marketplace orchestrator produces per-field confidence scores (0-100) for each extracted field (title, description, price, image). Each field carries a `confidence` number and a `source` string identifying which strategy produced it. The overall confidence level is derived from these field scores:

- `>= 70`: `high` (triggers early stop -- no further strategies are executed)
- `>= 40`: `medium`
- `> 0`: `low`
- `0`: `none`

The fallback threshold is 25 -- if the orchestrator's overall score falls below this, the result is considered garbage and the legacy parser takes over.

### Parse status

The extraction result carries a `confidence` field and a derived `parseStatus` returned to the frontend:

| `parseStatus` | Condition |
|---|---|
| `ok` | Both `title` and `priceText` were extracted |
| `partial` | Either `title` or `priceText` is missing (but not both) |
| `failed` | Neither `title` nor `priceText` was extracted |

In all three cases, **the item is always created**. Graceful degradation behavior:

- `failed`: the item title is set to the site's hostname (e.g., `example.com`).
- `partial`: available fields are used; missing fields are left blank for the user to fill in.
- `ok`: item is fully pre-populated.

### Full result shape

```typescript
{
  title: string | null;
  description: string | null;
  priceText: string | null;
  imageUrl: string | null;
  sourceDomain: string;
  canonicalUrl: string;
  confidence: 'high' | 'medium' | 'low' | 'none';
  parseMethod: 'domain_api' | 'domain_adapter' | 'generic_jsonld' | 'generic_html' | 'browser_fallback';
}
```

### Anti-bot and garbage guard

After extraction, a guard checks for anti-bot pages (e.g., CAPTCHA walls, Cloudflare challenges). If detected, the result is treated as a failure and cached with the negative TTL.

---

## 9. PRO Gate and Rate Limiting

### PRO gate

Link Import is a PRO-only feature. For FREE users:

```
HTTP 402 Payment Required
{ "error": "Pro feature", "feature": "url_import" }
```

### Rate limiting

| Limit | Window |
|---|---|
| 10 requests | 60 seconds per user |

Exceeding the limit returns HTTP 429.

---

## 10. Drafts Wishlist

All items created via Link Import land in the "Черновики" (Drafts) wishlist.

- The Drafts wishlist is a **system wishlist** — one per user, auto-created on first import.
- It has its own item capacity limit (`DRAFTS_ITEM_LIMIT`), separate from the plan-based item limits that apply to regular wishlists.
- Users can move items from Drafts to any other wishlist via the standard item-move flow.
- The Drafts wishlist is not publicly shareable in the same way as regular wishlists.

---

## 11. API Reference

### POST /tg/import-url

Import a product URL and create a draft wish item.

**Auth:** Telegram Mini App init data required.

**Plan requirement:** PRO — returns 402 for FREE users.

**Rate limit:** 10 requests / 60 seconds per user.

**Request body:**

```json
{
  "url": "https://www.ozon.ru/product/some-product-123456/"
}
```

**Success response (HTTP 200):**

```json
{
  "item": { ...WishItem },
  "parseStatus": "ok" | "partial" | "failed",
  "parseMethod": "domain_api" | "domain_adapter" | "generic_jsonld" | "generic_html" | "browser_fallback",
  "confidence": "high" | "medium" | "low" | "none"
}
```

**Error responses:**

| Status | Condition |
|---|---|
| 400 | URL failed validation (bad scheme, private IP, too long) |
| 402 | User is on FREE plan |
| 422 | URL parameter missing or malformed |
| 429 | Rate limit exceeded |

### POST /internal/import-url

Internal endpoint for the Telegram bot message handler. Accepts a `userId` directly, bypassing Telegram Mini App authentication. Used when a user sends a product URL as a plain message to the bot.

**Auth:** Internal service auth (not TG init data).

**Request body:**

```json
{
  "userId": 12345,
  "url": "https://www.wildberries.ru/catalog/123456789/detail.aspx"
}
```

Same extraction logic and result shape as the public endpoint.

---

## 12. Known Limitations and Gaps

- **In-memory cache only.** Cache is lost on every API restart. High-traffic deployments or rolling restarts mean the same URLs are re-fetched frequently.
- **Single Chromium process.** The browser singleton may be unstable under concurrent load. Concurrent browser-first requests queue behind one another.
- **No retry logic.** If a browser-based extraction fails transiently (timeout, crash), the result is cached as a failure for 5 minutes.
- **Anti-bot limitations.** Sites with aggressive Cloudflare or Yandex SmartCaptcha protection return failures. No headless browser fingerprint spoofing is implemented.
- **`defaultCurrency` is surfaced but not applied during import.** The `UserProfile` schema includes a `defaultCurrency` field (`RUB` | `USD` | `EUR` | `GBP`) surfaced via `GET/PATCH /tg/me/settings`, but it is not applied to normalise extracted prices during import.
- **`priceText` is a raw string.** The extracted price is not normalized to a number or currency code — it is stored as a string (e.g., `"4 990 ₽"`). Structured price parsing is not implemented.
- **No image re-hosting.** The `imageUrl` is the original URL from the product page. If the source site rotates or deletes the image, the wish item loses its image.
- **Drafts item limit is fixed.** `DRAFTS_ITEM_LIMIT` is a constant, not a plan-based setting, so PRO users cannot exceed it regardless of their subscription.
