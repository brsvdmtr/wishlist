> Source of truth for the URL-based wish import system (PRO feature).
> Last updated: 2026-03-26 · Branch: main

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

Each URL goes through the following pipeline in order:

```
1. Validate URL + canonicalize (strip tracking params)
        ↓
2. Cache check
   ├─ Hit (success, < 24h)  → return cached result
   └─ Hit (negative, < 5m)  → return cached failure
        ↓
3. Route by domain
   ├─ wildberries.ru / wb.ru  →  WB Card API (card.wb.ru)
   │                              └─ fail → browser fallback
   ├─ ozon.ru                 →  browser-first (skip HTTP fetch)
   ├─ market.yandex.ru        →  browser-first (skip HTTP fetch)
   └─ all others              →  HTTP fetch + Cheerio
                                   └─ confidence < medium → browser fallback
        ↓
4. Extraction (one or more sources, merged by priority)
        ↓
5. Anti-bot / garbage guard
        ↓
6. Cache store
        ↓
7. Return result
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
| `wildberries.ru`, `wb.ru` | WB Card JSON API (`card.wb.ru/cards/v2/detail?nm={id}`) | High |
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
- Launch flags: `--no-sandbox`, `--disable-setuid-sandbox`, `--single-process`.

### What the browser does

1. Navigates to the product URL.
2. **Intercepts network responses** — any XHR or fetch response with a JSON content-type is captured and scanned for product data (`network_response` source).
3. After page load, reads `window.__NEXT_DATA__` (`next_data` source).
4. Reads common hydration state keys: `window.__INITIAL_STATE__`, Redux `window.__REDUX_STATE__`, Vuex state, etc. (`hydration_state` source).
5. Falls back to reading the rendered HTML and applying domain adapters or generic extractors.

---

## 6. Caching Behavior

Results are cached in-process using a `Map`.

| Property | Value |
|---|---|
| Storage | In-memory `Map` (not persisted across restarts) |
| Max entries | 1,000 |
| Eviction policy | FIFO (oldest entry removed when limit is reached) |
| Success TTL | 24 hours |
| Negative TTL | 5 minutes (for failed or empty extractions) |
| Cache key | Canonical URL (after tracking param stripping) |

Because the cache is in-memory, it is cleared on every API process restart. Two users importing the same URL within 24 hours share the cached result.

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

**Canonicalization (tracking param stripping):**

The following query parameters are removed before processing and caching:

`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `yclid`, `gclid`, `fbclid`, `srsltid`, `ref`, and related tracking suffixes.

Stripping happens before the cache lookup, so `https://example.com/product?utm_source=email` and `https://example.com/product` resolve to the same cache entry.

---

## 8. Error Handling and Graceful Degradation

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
- **Single Chromium process.** The browser singleton with `--single-process` may be unstable under concurrent load. Concurrent browser-first requests queue behind one another.
- **No retry logic.** If a browser-based extraction fails transiently (timeout, crash), the result is cached as a failure for 5 minutes.
- **Anti-bot limitations.** Sites with aggressive Cloudflare or Yandex SmartCaptcha protection return failures. No headless browser fingerprint spoofing is implemented.
- **`defaultCurrency` not yet in API.** The `UserProfile` schema includes a `defaultCurrency` field (`RUB` | `USD`) for displaying prices in the user's preferred currency, but it is not currently surfaced in the settings API or applied during import.
- **`priceText` is a raw string.** The extracted price is not normalized to a number or currency code — it is stored as a string (e.g., `"4 990 ₽"`). Structured price parsing is not implemented.
- **No image re-hosting.** The `imageUrl` is the original URL from the product page. If the source site rotates or deletes the image, the wish item loses its image.
- **Drafts item limit is fixed.** `DRAFTS_ITEM_LIMIT` is a constant, not a plan-based setting, so PRO users cannot exceed it regardless of their subscription.
