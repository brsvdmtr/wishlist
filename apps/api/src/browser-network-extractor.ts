/**
 * browser-network-extractor.ts
 *
 * Runs a stealth browser page, intercepts ALL network responses, and
 * scans both those responses AND the page's embedded hydration state for
 * product data.
 *
 * Extraction priority (highest → lowest):
 *   1. Network JSON responses  (XHR/fetch intercepted live)
 *   2. __NEXT_DATA__           (Next.js hydration JSON)
 *   3. window.* hydration vars (Redux, Vuex, custom state)
 *   4. Inline <script> JSON blocks
 *
 * The caller (url-parser.ts) merges this result with Cheerio DOM extraction,
 * where network/hydration data always wins over DOM/meta.
 */

import * as cheerio from 'cheerio';
import type { Browser } from 'puppeteer-core';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Normalized product data extracted before DOM/meta fallback */
export interface ExtractedProduct {
  title: string | null;
  description: string | null;
  /** Raw numeric string — no currency symbol, no thousand separators, e.g. "1999" */
  rawPrice: string | null;
  currency: string | null;
  imageUrl: string | null;
  source: 'network_response' | 'next_data' | 'hydration_state' | 'script_json';
  /** 0–100 quality score; higher = more complete */
  score: number;
}

interface ProductCandidate {
  name:        string | null;
  description: string | null;
  price:       number | null;
  currency:    string | null;
  image:       string | null;
  score:       number;
}

interface CollectedResponse {
  url:  string;
  body: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const BROWSER_TIMEOUT_MS  = 30_000;
const MAX_RESPONSE_BYTES  = 1_000_000;  // 1 MB per response
const MAX_PENDING_READS   = 120;        // cap simultaneous response reads
const MAX_SCAN_DEPTH      = 9;          // JSON recursive search depth
const MAX_SCRIPT_BYTES    = 8_000_000;  // skip enormous script blocks

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Page titles that indicate an anti-bot challenge (not the real product page) */
const CHALLENGE_TITLES = ['Почти готово', 'Just a moment', 'Attention Required'];

// ─── Main Entry ───────────────────────────────────────────────────────────────

/**
 * Open `url` in a stealth headless browser, intercept network responses,
 * parse hydration state, and return the page HTML + best extracted product.
 */
export async function browserExtract(
  browser: Browser,
  url: string,
  hostname: string,
): Promise<{ html: string; product: ExtractedProduct | null }> {
  const page = await browser.newPage();
  const collected: CollectedResponse[] = [];
  const pending: Array<Promise<void>> = [];

  try {
    // ── Stealth ───────────────────────────────────────────────────────────
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru', 'en-US', 'en'] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
    });

    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    });

    // ── Network intercept: block heavy resources, collect JSON ────────────
    await page.setRequestInterception(true);

    page.on('request', req => {
      if (['font', 'stylesheet', 'media'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    page.on('response', response => {
      if (pending.length >= MAX_PENDING_READS) return;

      const p = (async () => {
        try {
          const ct = response.headers()['content-type'] ?? '';
          // Only JSON (and text/plain — some APIs use it)
          if (!ct.includes('application/json') && !ct.includes('text/plain')) return;
          if (response.status() < 200 || response.status() >= 300)           return;
          if (isIgnoredNetworkUrl(response.url()))                            return;

          const body = await response.text();
          if (body.length < 50 || body.length > MAX_RESPONSE_BYTES)          return;

          collected.push({ url: response.url(), body });
        } catch { /* response stream closed or other error */ }
      })();
      pending.push(p);
    });

    // ── Navigate ─────────────────────────────────────────────────────────
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });

    // ── Anti-bot challenge detection (WB "Почти готово..." etc.) ────────
    // Some marketplaces show a JS challenge page that auto-resolves and
    // redirects to the real product page within a few seconds.  If we
    // detect a challenge page, wait for the navigation to the real page.
    const challengeTitle = await page.title().catch(() => '');
    const isChallenge = CHALLENGE_TITLES.some(t => challengeTitle.includes(t));

    if (isChallenge) {
      // Wait for the challenge JS to redirect us to the real page.
      // The challenge typically resolves in 2-8 seconds.
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
      // Re-collect pending network responses after redirect
      await Promise.allSettled(pending);
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 5_000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 1_000));
    } else {
      // Wait for pending XHR reads and for network to idle
      await Promise.allSettled(pending);
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 4_000 }).catch(() => {});
      // Brief pause for React/Vue hydration to finish
      await new Promise(r => setTimeout(r, 700));
    }

    // Wait until <title> or og:title is populated (skip challenge titles)
    await page.waitForFunction(
      (challengeTitles: string[]) => {
        const og = document.querySelector('meta[property="og:title"]');
        const t  = document.querySelector('title');
        const titleText = t?.textContent ?? '';
        // Don't consider challenge titles as "populated"
        if (challengeTitles.some(ct => titleText.includes(ct))) return false;
        return (og?.getAttribute('content')?.length ?? 0) > 3
            || titleText.length > 3;
      },
      { timeout: 7_000 },
      CHALLENGE_TITLES,
    ).catch(() => {});

    const html = await page.content();

    // ── Extract from network responses ────────────────────────────────────
    const networkProduct = analyzeNetworkResponses(collected, hostname);

    // ── Extract from page hydration / __NEXT_DATA__ ───────────────────────
    const hydrationProduct = extractFromHydration(html, hostname);

    // ── Pick best ─────────────────────────────────────────────────────────
    const product = pickBest([networkProduct, hydrationProduct]);
    return { html, product };

  } finally {
    await page.close().catch(() => {});
  }
}

// ─── Network Response Analysis ────────────────────────────────────────────────

function isIgnoredNetworkUrl(url: string): boolean {
  const skip = [
    'google-analytics', 'googletagmanager', 'facebook', 'mc.yandex',
    'metrika', 'hotjar', 'amplitude', 'segment.io', 'clarity.ms',
    '.png', '.jpg', '.webp', '.woff2', '.woff', '.ttf', '.svg',
    'beacon', '/ping', '/pixel', '/counter',
  ];
  const lUrl = url.toLowerCase();
  return skip.some(s => lUrl.includes(s));
}

function analyzeNetworkResponses(
  responses: CollectedResponse[],
  hostname: string,
): ExtractedProduct | null {
  const h = hostname.replace(/^www\./, '').replace(/^m\./, '');
  let best: ExtractedProduct | null = null;

  for (const resp of responses) {
    let json: unknown;
    try { json = JSON.parse(resp.body); } catch { continue; }

    let candidate: ProductCandidate | null = null;

    // Domain-specific fast paths (known API response shapes)
    if (isWildberriesHost(h) && (resp.url.includes('card.wb.ru') || resp.url.includes('search.wb.ru'))) {
      candidate = parseWbCardResponse(json);
    } else if (isWildberriesHost(h) && resp.url.includes('catalog.wb.ru')) {
      candidate = findProductInJson(json, 0); // generic scan
    } else if (isOzonHost(h) && resp.url.includes('/api/composer')) {
      candidate = scanOzonComposerResponse(json);
    } else if (isYandexMarketHost(h) && resp.url.includes('/resolveProduct')) {
      candidate = findProductInJson(json, 0);
    } else {
      // Generic: scan any JSON response for product-like objects
      candidate = findProductInJson(json, 0);
    }

    if (!candidate || candidate.score < 20) continue;
    const product = toExtractedProduct(candidate, 'network_response');
    if (!best || product.score > best.score) best = product;
  }

  return best;
}

// ─── Domain-Specific Network Response Parsers ─────────────────────────────────

function parseWbCardResponse(json: unknown): ProductCandidate | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const products = (json as any)?.data?.products;
  if (!Array.isArray(products) || products.length === 0) return null;

  const p = products[0] as Record<string, unknown>;
  const name = typeof p['name'] === 'string' ? (p['name'] as string).trim() : null;

  // WB stores prices in kopecks (÷100 = rubles)
  const salePriceKop =
    typeof p['salePriceU'] === 'number' ? (p['salePriceU'] as number) :
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    typeof (p['sizes'] as any)?.[0]?.price?.total === 'number'
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? (p['sizes'] as any)[0].price.total
      : null;
  const price = salePriceKop !== null ? Math.round((salePriceKop as number) / 100) : null;

  // Image: prefer mediaFiles URL, fallback to CDN formula
  let image: string | null = null;
  const mf = p['mediaFiles'];
  if (Array.isArray(mf) && mf.length > 0 && typeof mf[0] === 'string') {
    image = mf[0] as string;
  }
  if (!image && typeof p['id'] === 'number') {
    const nm = p['id'] as number;
    image = wbCdnImageUrl(nm);
  }

  if (!name) return null;

  return {
    name,
    description: null,
    price,
    currency: 'RUB',
    image,
    score: 30 + (price !== null ? 35 : 0) + (image ? 30 : 0),
  };
}

function scanOzonComposerResponse(json: unknown): ProductCandidate | null {
  // Ozon's composer API returns complex layout state; scan generically
  // but look specifically in known paths first
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = (json as any)?.widgetStates;
  if (result && typeof result === 'object') {
    // widgetStates is a dict of component-name → JSON-string
    let best: ProductCandidate | null = null;
    for (const val of Object.values(result)) {
      if (typeof val !== 'string') continue;
      try {
        const inner = JSON.parse(val as string);
        const c = findProductInJson(inner, 0);
        if (c && (!best || c.score > best.score)) best = c;
      } catch { /* skip */ }
    }
    if (best && best.score >= 20) return best;
  }
  return findProductInJson(json, 0);
}

// ─── HTML Hydration Extraction ────────────────────────────────────────────────

/**
 * Scan a page's embedded hydration state for product data.
 *
 * Exported so the cheap HTTP path (url-parser.ts) can reuse it without a
 * browser: most modern marketplaces (Next.js, Nuxt, Redux SPAs) ship the
 * product JSON inside the server-rendered HTML. The caller may pass an
 * already-loaded Cheerio document (`pre$`) to avoid re-parsing the HTML.
 */
export function extractFromHydration(
  html: string,
  hostname: string,
  pre$?: cheerio.CheerioAPI,
): ExtractedProduct | null {
  const $ = pre$ ?? cheerio.load(html);

  // 1. __NEXT_DATA__ (highest: Next.js stores like Lamoda, Goldapple)
  const nextDataEl = $('#__NEXT_DATA__');
  if (nextDataEl.length) {
    try {
      const json = JSON.parse(nextDataEl.html() ?? '');
      // Product is usually under props.pageProps; scan there first
      const searchRoot = (json as Record<string, unknown>)?.props
        ? ((json as Record<string, unknown>).props as Record<string, unknown>)?.pageProps ?? json
        : json;
      const c = findProductInJson(searchRoot, 0);
      if (c && c.score >= 25) {
        return toExtractedProduct(c, 'next_data');
      }
    } catch { /* not valid JSON */ }
  }

  // 2. window.* state variables (Ozon __INITIAL_STATE__, Redux, etc.)
  const hydrationVars = [
    'window.__INITIAL_STATE__',
    'window.__STATE__',
    'window.__APP_STATE__',
    'window.REDUX_STATE',
    'window.__PRELOADED_STATE__',
    'window.__NUXT__',
    'window.__APOLLO_STATE__',
    'window.runParams',       // AliExpress
    'window._init_data_',     // AliExpress (newer)
    '__INITIAL_STATE__',     // sometimes without window.
  ];

  let bestHydration: ExtractedProduct | null = null;

  const scripts = $('script:not([src])').toArray();
  for (const el of scripts) {
    const content = $(el).html() ?? '';
    if (content.length < 100 || content.length > MAX_SCRIPT_BYTES) continue;

    for (const varName of hydrationVars) {
      const idx = content.indexOf(varName);
      if (idx === -1) continue;

      const eqIdx = content.indexOf('=', idx + varName.length);
      if (eqIdx === -1 || eqIdx - idx > 50) continue;  // too far

      const jsonStr = extractEmbeddedJson(content, eqIdx + 1);
      if (!jsonStr || jsonStr.length < 20) continue;

      try {
        const json = JSON.parse(jsonStr);
        const c = findProductInJson(json, 0);
        if (c && c.score >= 25) {
          const p = toExtractedProduct(c, 'hydration_state');
          if (!bestHydration || p.score > bestHydration.score) bestHydration = p;
        }
      } catch { /* truncated or invalid JSON */ }
    }
  }

  if (bestHydration) return bestHydration;

  // 3. Inline <script type="application/json"> (not ld+json, not next_data)
  //    Some shops embed product data as raw JSON blobs
  let bestScriptJson: ExtractedProduct | null = null;
  $('script[type="application/json"]:not(#__NEXT_DATA__)').each((_, el) => {
    try {
      const json = JSON.parse($(el).html() ?? '');
      const c = findProductInJson(json, 0);
      if (c && c.score >= 30) {
        const p = toExtractedProduct(c, 'script_json');
        if (!bestScriptJson || p.score > bestScriptJson.score) bestScriptJson = p;
      }
    } catch { /* skip */ }
  });

  return bestScriptJson;
}

// ─── Generic JSON Product Finder ──────────────────────────────────────────────

/**
 * Recursively search a JSON tree for the highest-scoring product-like object.
 * Returns the best candidate found, or null if nothing product-like was found.
 */
export function findProductInJson(data: unknown, depth: number): ProductCandidate | null {
  if (depth > MAX_SCAN_DEPTH || data === null || data === undefined) return null;

  if (Array.isArray(data)) {
    let best: ProductCandidate | null = null;
    // Only check first 30 items to avoid blowing up on huge arrays
    for (const item of (data as unknown[]).slice(0, 30)) {
      const r = findProductInJson(item, depth + 1);
      if (r && (!best || r.score > best.score)) best = r;
    }
    return best;
  }

  if (typeof data !== 'object') return null;

  const obj = data as Record<string, unknown>;
  const keys = Object.keys(obj);

  // Very large objects (e.g. Redux state root) — only check known-promising keys
  if (keys.length > 200) {
    const promisingKeys = [
      'product', 'item', 'goods', 'card', 'offer', 'sku',
      'data', 'result', 'payload', 'pageProps', 'props', 'entity',
    ];
    let best: ProductCandidate | null = null;
    for (const k of promisingKeys) {
      if (obj[k] !== undefined) {
        const r = findProductInJson(obj[k], depth + 1);
        if (r && (!best || r.score > best.score)) best = r;
      }
    }
    return best;
  }

  // Try to extract product fields directly from this object
  const candidate = extractProductFields(obj, keys);
  if (candidate.score >= 40) return candidate;

  // Recurse into children
  let best: ProductCandidate | null = candidate.score > 0 ? candidate : null;
  for (const key of keys) {
    const val = obj[key];
    if (typeof val !== 'object' || val === null) continue;
    const r = findProductInJson(val, depth + 1);
    if (r && (!best || r.score > best.score)) best = r;
  }
  return best;
}

// ─── Product Field Extraction ─────────────────────────────────────────────────

function extractProductFields(obj: Record<string, unknown>, keys: string[]): ProductCandidate {
  // Build a lowercase key → original key map for case-insensitive lookup
  const keyMap = new Map<string, string>(keys.map(k => [k.toLowerCase(), k]));

  const name = getStringField(obj, keyMap, [
    'name', 'title', 'productname', 'displayname', 'product_name', 'goodsname',
    'itemname', 'shortname', 'fullname', 'heading', 'headline',
  ]);

  const description = getStringField(obj, keyMap, [
    'description', 'shortdescription', 'annotation', 'desc', 'brief',
    'short_description', 'product_description', 'subtitle',
  ]);

  const priceResult = extractPriceResult(obj, keyMap);
  const image       = extractImageField(obj, keyMap);

  // Validate name: reject slugs, IDs, code strings
  const isValidName = !!name
    && name.length >= 2
    && name.length <= 600
    && !/^[a-z0-9_-]+$/.test(name)   // not a slug
    && !/^\d+$/.test(name)            // not a number ID
    && !name.startsWith('{')
    && !name.includes('\\n');

  let score = 0;
  if (isValidName)               score += 30;
  if (priceResult !== null)       score += 35;
  if (image)                      score += 25;
  if ((description?.length ?? 0) > 10) score += 10;

  return {
    name:        isValidName ? name : null,
    description: description?.slice(0, 500) ?? null,
    price:       priceResult?.price ?? null,
    currency:    priceResult?.currency ?? null,
    image,
    score,
  };
}

function getStringField(
  obj: Record<string, unknown>,
  keyMap: Map<string, string>,
  fields: string[],
): string | null {
  for (const f of fields) {
    const actual = keyMap.get(f);
    if (actual === undefined) continue;
    const v = obj[actual];
    if (typeof v === 'string' && v.length >= 2 && v.length <= 1000) return v;
  }
  return null;
}

interface PriceResult { price: number; currency: string | null; }

function extractPriceResult(
  obj: Record<string, unknown>,
  keyMap: Map<string, string>,
): PriceResult | null {
  // WB-specific kopeck fields (salePriceU, priceU)
  for (const f of ['salepriceu', 'priceu', 'basicpriceu', 'originalpriceu']) {
    const actual = keyMap.get(f);
    if (actual !== undefined) {
      const v = obj[actual];
      if (typeof v === 'number' && v > 0 && v < 100_000_000) {
        return { price: Math.round(v / 100), currency: 'RUB' };
      }
    }
  }

  // Standard price fields (ordered by reliability)
  const priceFields = [
    'finalprice', 'saleprice', 'currentprice', 'discountprice',
    'price', 'originalprice', 'regularprice', 'baseprice', 'cost', 'amount',
    'current_price', 'sale_price', 'final_price',
  ];

  for (const f of priceFields) {
    const actual = keyMap.get(f);
    if (actual === undefined) continue;
    const v       = obj[actual];
    const price   = resolveNumericPrice(v);
    if (price === null) continue;

    // Look for accompanying currency
    let currency: string | null = null;
    const curKey = keyMap.get('currency') ?? keyMap.get('pricecurrency');
    if (curKey) {
      const cv = obj[curKey];
      if (typeof cv === 'string') currency = cv.toUpperCase();
    }
    return { price, currency };
  }
  return null;
}

/** Resolve any price-like value to a positive float in rubles/dollars */
function resolveNumericPrice(v: unknown): number | null {
  if (typeof v === 'number') {
    return v > 0 && v < 10_000_000 ? v : null;
  }
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[\s₽$€]/g, '').replace(',', '.'));
    return !isNaN(n) && n > 0 && n < 10_000_000 ? n : null;
  }
  if (typeof v === 'object' && v !== null) {
    // Nested price objects: { amount: 1999 }, { value: 1999 }, { current: 1999 }
    const po = v as Record<string, unknown>;
    for (const k of ['amount', 'value', 'current', 'discount', 'sale', 'actual', 'final', 'price']) {
      const r = resolveNumericPrice(po[k]);
      if (r !== null) return r;
    }
  }
  return null;
}

function extractImageField(
  obj: Record<string, unknown>,
  keyMap: Map<string, string>,
): string | null {
  // Single-image fields (exact first, then partial)
  for (const f of ['mainimage', 'mainphoto', 'coverimage', 'thumbnail', 'image', 'photo', 'picture']) {
    const actual = keyMap.get(f);
    if (actual !== undefined) {
      const url = resolveImageUrl(obj[actual]);
      if (url) return url;
    }
  }
  // Array-image fields — take first
  for (const f of ['images', 'photos', 'mediafiles', 'pictures', 'gallery', 'media']) {
    const actual = keyMap.get(f);
    if (actual !== undefined) {
      const arr = obj[actual];
      if (Array.isArray(arr) && arr.length > 0) {
        const url = resolveImageUrl(arr[0]);
        if (url) return url;
      }
    }
  }
  return null;
}

function resolveImageUrl(v: unknown): string | null {
  if (typeof v === 'string') {
    return v.startsWith('http://') || v.startsWith('https://') || v.startsWith('//')
      ? v : null;
  }
  if (typeof v === 'object' && v !== null) {
    const po = v as Record<string, unknown>;
    for (const k of ['url', 'src', 'big', 'large', 'original', 'full', 'href', 'link', 'path']) {
      const r = resolveImageUrl(po[k]);
      if (r) return r;
    }
  }
  return null;
}

// ─── JSON Extraction Helper ───────────────────────────────────────────────────

/**
 * Find the JSON value (object or array) starting at or after `startIndex`.
 * Uses brace/bracket depth counting to handle nested structures correctly.
 * Returns the extracted JSON string, or null if not found.
 */
export function extractEmbeddedJson(content: string, startIndex: number): string | null {
  // Skip whitespace
  let i = startIndex;
  while (i < content.length && /\s/.test(content[i]!)) i++;
  if (i >= content.length) return null;

  const openChar  = content[i];
  if (openChar !== '{' && openChar !== '[') return null;
  const closeChar = openChar === '{' ? '}' : ']';

  let depth    = 0;
  let inString = false;
  let escaped  = false;

  for (let j = i; j < content.length; j++) {
    const ch = content[j]!;
    if (escaped)          { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"')       { inString = !inString; continue; }
    if (inString)         continue;
    if (ch === openChar)  { depth++; }
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return content.slice(i, j + 1);
    }
  }
  return null; // unclosed
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function toExtractedProduct(c: ProductCandidate, source: ExtractedProduct['source']): ExtractedProduct {
  return {
    title:       c.name,
    description: c.description,
    rawPrice:    c.price !== null ? String(Math.round(c.price)) : null,
    currency:    c.currency,
    imageUrl:    c.image,
    source,
    score:       c.score,
  };
}

function pickBest(candidates: Array<ExtractedProduct | null>): ExtractedProduct | null {
  const valid = candidates.filter((c): c is ExtractedProduct => c !== null && c.score > 0);
  if (valid.length === 0) return null;
  return valid.reduce((best, c) => (c.score > best.score ? c : best));
}

// ─── Host Helpers ─────────────────────────────────────────────────────────────

function isWildberriesHost(h: string): boolean {
  return h === 'wildberries.ru' || h.endsWith('.wildberries.ru');
}

function isOzonHost(h: string): boolean {
  return h === 'ozon.ru' || h.endsWith('.ozon.ru');
}

function isYandexMarketHost(h: string): boolean {
  return h === 'market.yandex.ru' || h.endsWith('.market.yandex.ru');
}

// ─── Wildberries CDN Image URL (shared) ───────────────────────────────────────

export function wbCdnImageUrl(nm: number): string {
  const vol  = Math.floor(nm / 100_000);
  const part = Math.floor(nm / 1_000);
  return `https://basket-${wbBasket(vol)}.wbbasket.ru/vol${vol}/part${part}/${nm}/images/big/1.webp`;
}

export function wbBasket(vol: number): string {
  let b: number;
  if      (vol <= 143)  b = 1;
  else if (vol <= 287)  b = 2;
  else if (vol <= 431)  b = 3;
  else if (vol <= 719)  b = 4;
  else if (vol <= 1007) b = 5;
  else if (vol <= 1061) b = 6;
  else if (vol <= 1115) b = 7;
  else if (vol <= 1169) b = 8;
  else if (vol <= 1313) b = 9;
  else if (vol <= 1601) b = 10;
  else if (vol <= 1655) b = 11;
  else if (vol <= 1919) b = 12;
  else if (vol <= 2045) b = 13;
  else if (vol <= 2189) b = 14;
  else if (vol <= 2405) b = 15;
  else if (vol <= 2621) b = 16;
  else if (vol <= 2837) b = 17;
  else if (vol <= 3053) b = 18;
  else if (vol <= 3269) b = 19;
  else if (vol <= 3485) b = 20;
  else if (vol <= 3701) b = 21;
  else if (vol <= 3917) b = 22;
  else if (vol <= 4133) b = 23;
  else if (vol <= 4349) b = 24;
  else if (vol <= 4565) b = 25;
  else if (vol <= 4781) b = 26;
  else if (vol <= 4997) b = 27;
  else if (vol <= 5213) b = 28;
  else if (vol <= 5429) b = 29;
  else if (vol <= 5645) b = 30;
  else                  b = 31;
  return b.toString().padStart(2, '0');
}

/**
 * Build a basket CDN URL for a WB product's card.json or price-history.json.
 * These endpoints are static CDN files — no anti-bot, no rate limiting.
 */
export function wbCdnBaseUrl(nm: number): string {
  const vol  = Math.floor(nm / 100_000);
  const part = Math.floor(nm / 1_000);
  return `https://basket-${wbBasket(vol)}.wbbasket.ru/vol${vol}/part${part}/${nm}`;
}
