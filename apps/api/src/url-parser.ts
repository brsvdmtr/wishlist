/**
 * URL Parser — product card metadata extraction
 *
 * Two-tier architecture:
 *   A. Known marketplaces (WB, Ozon, YM, GoldApple) →
 *      marketplace/orchestrator with field-level scoring, multi-strategy pipeline,
 *      structured logging, and guards.
 *   B. Unknown domains → legacy extraction pipeline (unchanged):
 *      validateUrl → cache → HTTP/browser → Cheerio/JSON-LD/OG → merge
 *
 * The orchestrator produces ParsedProduct with per-field confidence,
 * which is converted to ParsedUrlData for backward compatibility.
 *
 * Legacy pipeline (5-level source priority, for unknown domains):
 *   1. network_response  — XHR/fetch JSON intercepted during browser render
 *   2. next_data         — __NEXT_DATA__ (Next.js hydration)
 *   3. hydration_state   — window.__INITIAL_STATE__ / Redux / Vuex / etc.
 *   4. jsonld            — JSON-LD Product structured data
 *   5. og_meta / dom     — Open Graph meta tags + domain DOM selectors
 */

import * as cheerio from 'cheerio';
import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import puppeteer, { type Browser } from 'puppeteer-core';
import {
  browserExtract,
  extractFromHydration,
  extractEmbeddedJson,
  type ExtractedProduct,
  wbCdnImageUrl,
  wbBasket,
} from './browser-network-extractor.js';

// ─── Marketplace Orchestrator Integration ────────────────────────────────────
import {
  isKnownMarketplace,
  parseMarketplaceUrl,
  toOldFormat,
  parseLog,
  registerBrowserProvider,
  registerFetchHtmlProvider,
  stripHostPrefix,
  getMarketplaceId,
  shouldFallbackToLegacy,
  isOrchestratorEnabled,
  isAntiBotPage,
  // Universal structured-data extraction (shared with marketplace strategies)
  extractJsonLd,
  extractMicrodata,
  extractOpenGraph,
  extractTwitterCard,
  parseAmount,
  detectCurrency,
  formatPrice,
  fallbackCurrency,
  lookupSite,
  isScraperApiEnabled,
  fetchViaScraperApi,
  isScraperHopeless,
  scraperMaxAttempts,
  noteScraperCall,
  scraperBudgetLeft,
  type ExtractedFields,
} from './marketplace/index.js';
// Auto-register all marketplace strategies on import
import './marketplace/strategies/index.js';

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface ParsedUrlData {
  title:        string | null;
  description:  string | null;
  priceText:    string | null;
  imageUrl:     string | null;
  sourceDomain: string;
  canonicalUrl: string;
  confidence?:  'high' | 'medium' | 'low' | 'none';
  parseMethod?: 'domain_api' | 'domain_adapter' | 'generic_jsonld' | 'generic_html' | 'browser_fallback';
}

// ─── Internal Types ───────────────────────────────────────────────────────────

interface ParseResult {
  title:       string | null;
  description: string | null;
  priceText:   string | null;
  imageUrl:    string | null;
  confidence:  'high' | 'medium' | 'low' | 'none';
  parseMethod: 'domain_api' | 'domain_adapter' | 'generic_jsonld' | 'generic_html' | 'browser_fallback';
}

// ─── Constants ────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS   = 8_000;
const BROWSER_IDLE_MS    = 90_000;
const MAX_HTML_BYTES     = 3 * 1024 * 1024;
const MAX_URL_LENGTH     = 2_048;
const CACHE_TTL_MS       = 24 * 60 * 60 * 1_000;
const NEGATIVE_CACHE_TTL = 5  * 60 * 1_000;
const MAX_CACHE_ENTRIES  = 1_000;
const CHROMIUM_PATH      = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'yclid', 'gclid', 'fbclid', 'srsltid', 'ref', '_openstat',
  'from', 'etext', 'ysclid', 'roistat_visit',
]);

const BLOCKED_HOSTNAMES = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]',
  'metadata.google.internal', 'metadata.google',
]);

/** Domains where a browser is always used for initial load */
const BROWSER_FIRST = new Set([
  'ozon.ru',
  'market.yandex.ru',
  // WB uses a direct API; only falls back to browser when API fails
]);

// ─── In-Memory Cache ──────────────────────────────────────────────────────────

interface CacheEntry { data: ParsedUrlData; expiresAt: number; }
const resultCache   = new Map<string, CacheEntry>();
const negativeCache = new Map<string, number>();

function cacheGet(key: string): ParsedUrlData | null {
  const e = resultCache.get(key);
  if (!e) return null;
  if (Date.now() > e.expiresAt) { resultCache.delete(key); return null; }
  return e.data;
}
function cacheSet(key: string, data: ParsedUrlData): void {
  if (resultCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = resultCache.keys().next().value;
    if (oldest) resultCache.delete(oldest);
  }
  resultCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}
function isNegative(key: string): boolean {
  const t = negativeCache.get(key);
  if (t === undefined) return false;
  if (Date.now() > t) { negativeCache.delete(key); return false; }
  return true;
}
function setNegative(key: string): void { negativeCache.set(key, Date.now() + NEGATIVE_CACHE_TTL); }

// ─── Browser Singleton ────────────────────────────────────────────────────────

let browserInstance: Browser | null = null;
let browserTimer:    ReturnType<typeof setTimeout> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserInstance?.connected) {
    if (browserTimer) clearTimeout(browserTimer);
    browserTimer = setTimeout(closeBrowser, BROWSER_IDLE_MS);
    return browserInstance;
  }
  browserInstance = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      // --no-sandbox is required in Docker without user-namespace remapping.
      // TODO(security): move Puppeteer to an isolated container with sandbox enabled.
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--disable-gpu', '--disable-extensions', '--disable-background-networking',
      '--disable-default-apps', '--disable-sync', '--no-first-run',
      // --single-process removed: keeps renderer in a separate process to limit
      // blast radius if a page exploits a renderer vulnerability.
      '--disable-crash-reporter',
      '--crash-dumps-dir=/tmp/crashes',
      '--disable-blink-features=AutomationControlled',
      // Restrict renderer capabilities
      '--disable-file-system',
      '--disable-webgl',
      '--disable-software-rasterizer',
    ],
  });
  browserTimer = setTimeout(closeBrowser, BROWSER_IDLE_MS);
  return browserInstance;
}
async function closeBrowser(): Promise<void> {
  if (browserTimer) { clearTimeout(browserTimer); browserTimer = null; }
  if (browserInstance) {
    try { await browserInstance.close(); } catch { /* ignore */ }
    browserInstance = null;
  }
}

// ─── Register providers for marketplace strategies ───────────────────────────
// This allows marketplace strategies to use the browser singleton and fetchHtml
// without circular imports.
registerBrowserProvider(getBrowser);
// fetchHtml provider is registered after the function definition below.

// ─── Main Entry ───────────────────────────────────────────────────────────────

export interface ParseUrlOptions {
  /** Skip orchestrator cache for this request (debug diagnostics) */
  noCache?: boolean;
}

export async function parseUrl(rawUrl: string, opts?: ParseUrlOptions): Promise<ParsedUrlData> {
  const url          = validateUrl(rawUrl);
  await assertDnsIsSafe(url);
  const hostname     = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
  const canonicalUrl = canonicalize(url);

  // ── Route: known marketplace → new orchestrator (if enabled) ────────────
  if (isKnownMarketplace(hostname) && isOrchestratorEnabled()) {
    return parseViaOrchestrator(url, hostname, canonicalUrl, opts);
  }

  // ── Route: unknown domain OR kill switch active → legacy flow ───────────
  return parseLegacy(url, hostname, canonicalUrl);
}

/**
 * New orchestrator path for known marketplaces (WB, Ozon, YM, GoldApple, etc.).
 *
 * Runs the multi-strategy pipeline with field-level confidence scoring.
 * Falls back to legacy in these cases:
 *   - orchestrator returned 'none' confidence (total failure)
 *   - orchestrator returned low-quality partial (shouldFallbackToLegacy)
 *   - orchestrator threw an exception
 *   - kill switch MARKETPLACE_PARSER_DISABLED=1 (checked before calling)
 */
async function parseViaOrchestrator(
  url: URL,
  hostname: string,
  canonicalUrl: string,
  opts?: ParseUrlOptions,
): Promise<ParsedUrlData> {
  const marketplace = getMarketplaceId(hostname);

  try {
    const product = await parseMarketplaceUrl(url, opts);

    // Check if result is usable or should fall back to legacy
    const fallbackReason = shouldFallbackToLegacy(product);

    if (!fallbackReason) {
      // Good result — convert and return
      const result = toOldFormat(product, hostname, canonicalUrl);

      // Cache in legacy cache too, so subsequent requests hit fast path
      cacheSet(canonicalUrl, result);

      return result;
    }

    // Orchestrator result is too weak — controlled fallback to legacy.
    // Log why so we can track what class of failures trigger this.
    parseLog.parseError(hostname, marketplace, `fallback_to_legacy:${fallbackReason}`);
    return parseLegacy(url, hostname, canonicalUrl);

  } catch (err) {
    // Orchestrator threw — fall back to legacy for safety
    parseLog.parseError(hostname, marketplace, `exception_fallback:${(err as Error).message}`);
    return parseLegacy(url, hostname, canonicalUrl);
  }
}

/**
 * Last-resort fallback when a direct fetch + headless browser both failed:
 * retry the URL through the scraping API (rotating residential IP — beats
 * datacenter-IP blocks). Inert when SCRAPER_API_KEY is unset. Always resolves:
 * on failure it sets the negative cache and returns an empty result.
 */
async function scraperApiFallback(
  url: URL,
  hostname: string,
  canonicalUrl: string,
): Promise<ParsedUrlData> {
  // Skip sites whose anti-bot the scraping API reliably fails (Ozon, Yandex,
  // Taobao-class) — retrying only burns credits and stalls the import.
  if (isScraperApiEnabled() && !isScraperHopeless(hostname)) {
    // Geo-fenced sites need an IP in their own country (from the registry).
    const country = lookupSite(hostname)?.country;
    const maxAttempts = scraperMaxAttempts();
    // Anti-bot bypass is probabilistic — retry a few times before giving up.
    for (let attempt = 1; attempt <= maxAttempts && scraperBudgetLeft(); attempt++) {
      noteScraperCall();
      try {
        const html = await fetchViaScraperApi(url.href, { country });
        const r = extractFromHtml(html, url.href, hostname, 'generic_html');
        if (r.confidence !== 'none') {
          console.log(`[parser] scraper-api success: ${hostname} (attempt ${attempt}/${maxAttempts}, ${r.confidence})`);
          const final = toFinal(r, hostname, canonicalUrl);
          cacheSet(canonicalUrl, final);
          return final;
        }
        console.warn(`[parser] scraper-api attempt ${attempt}/${maxAttempts}: no useful data for ${hostname}`);
      } catch (e) {
        console.warn(`[parser] scraper-api attempt ${attempt}/${maxAttempts} failed for ${hostname}: ${(e as Error).message}`);
      }
    }
  }
  setNegative(canonicalUrl);
  return emptyResult(hostname, canonicalUrl);
}

/**
 * Legacy parser flow — used for:
 *   1. Unknown domains (not a recognized marketplace)
 *   2. Fallback when orchestrator returns 'none' for a known marketplace
 *
 * This is the original parseUrl logic, kept intact to prevent regressions.
 */
async function parseLegacy(url: URL, hostname: string, canonicalUrl: string): Promise<ParsedUrlData> {
  // ── Cache ────────────────────────────────────────────────────────────────
  const cached = cacheGet(canonicalUrl);
  if (cached) {
    console.log(`[parser] cache hit: ${hostname}`);
    return cached;
  }
  if (isNegative(canonicalUrl)) {
    console.log(`[parser] negative cache: ${hostname}`);
    return emptyResult(hostname, canonicalUrl);
  }

  let result: ParseResult;

  try {
    // ── Wildberries: direct card API (fastest, no browser) ───────────────
    if (isWildberriesHost(hostname)) {
      const nm = extractWbArticleId(url);
      if (nm) {
        const wbResult = await fetchWbCardApi(nm, url.href);
        if (wbResult && wbResult.confidence !== 'none') {
          console.log(`[parser] WB API success nm=${nm}: ${wbResult.title?.slice(0, 50)}`);
          const final = toFinal(wbResult, hostname, canonicalUrl);
          cacheSet(canonicalUrl, final);
          return final;
        }
      }
    }

    // ── Browser-first: always render with network capture ────────────────
    if (isBrowserFirst(hostname) || isWildberriesHost(hostname)) {
      console.log(`[parser] browser-first: ${hostname}`);
      result = await runBrowserExtract(url.href, hostname);
    } else {
      // ── HTTP-first ───────────────────────────────────────────────────
      let html: string | null = null;
      try { html = await fetchHtml(url.href); } catch (e) {
        console.warn(`[parser] HTTP failed for ${hostname}: ${(e as Error).message}`);
      }

      if (html) {
        const fast = extractFromHtml(html, url.href, hostname, 'generic_html');
        if (confidenceScore(fast.confidence) >= 2) {
          result = fast;
        } else {
          console.log(`[parser] HTTP confidence=${fast.confidence}, trying browser: ${hostname}`);
          try {
            const browser = await runBrowserExtract(url.href, hostname);
            result = pickBetter(fast, browser);
          } catch {
            result = fast;
          }
        }
      } else {
        result = await runBrowserExtract(url.href, hostname);
      }
    }

    if (result.confidence === 'none') {
      console.warn(`[parser] no useful data for ${hostname} — trying scraper-api`);
      return scraperApiFallback(url, hostname, canonicalUrl);
    }

    console.log(
      `[parser] ${hostname}: ${result.confidence}/${result.parseMethod} — ` +
      `"${result.title?.slice(0, 40)}" price=${result.priceText ?? '-'} img=${result.imageUrl ? '✓' : '✗'}`
    );

    const final = toFinal(result, hostname, canonicalUrl);
    cacheSet(canonicalUrl, final);
    return final;

  } catch (err) {
    console.error(`[parser] unhandled error for ${hostname}:`, (err as Error).message);
    return scraperApiFallback(url, hostname, canonicalUrl);
  }
}

// ─── URL Validation ───────────────────────────────────────────────────────────

/**
 * Synchronous URL structure validation (protocol, credentials, hostname blocklist).
 * Does NOT resolve DNS — call `assertDnsIsSafe(url)` before making network requests.
 */
export function validateUrl(raw: string): URL {
  if (!raw || raw.length > MAX_URL_LENGTH) throw new Error('URL слишком длинный или пустой');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Некорректный URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('Поддерживаются только http и https ссылки');
  if (url.username || url.password)
    throw new Error('URL с учётными данными не поддерживается');
  const h = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(h)) throw new Error('Ссылка на локальный адрес недоступна');
  if (isForbiddenIP(h))         throw new Error('Ссылка на внутренний адрес недоступна');
  return url;
}

/**
 * Resolve the hostname and reject if ANY A/AAAA record points to a forbidden IP.
 * Must be called before fetch/Puppeteer navigation.
 */
export async function assertDnsIsSafe(url: URL): Promise<void> {
  const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '');

  // If the hostname is already an IP literal, check it directly
  if (net.isIP(hostname)) {
    if (isForbiddenIP(hostname)) throw new Error('Ссылка на внутренний адрес недоступна');
    return;
  }

  let addresses: string[];
  try {
    const results = await dns.resolve(hostname);            // A records
    const results6 = await dns.resolve6(hostname).catch(() => [] as string[]); // AAAA records
    addresses = [...results, ...results6];
  } catch {
    // DNS resolution failure — let the fetch itself fail with a descriptive error
    return;
  }

  for (const ip of addresses) {
    if (isForbiddenIP(ip)) {
      throw new Error('Ссылка на внутренний адрес недоступна (DNS)');
    }
  }
}

/**
 * Check whether an IP address (IPv4 or IPv6, including IPv4-mapped IPv6) is forbidden.
 * Covers loopback, private, link-local, metadata, and reserved ranges.
 */
export function isForbiddenIP(h: string): boolean {
  // Strip brackets for IPv6 literals from URL hostname
  const raw = h.replace(/^\[/, '').replace(/\]$/, '');

  // ── IPv4 ────────────────────────────────────────────────────────────────
  if (net.isIPv4(raw)) {
    const parts = raw.split('.').map(Number) as [number, number, number, number];
    const [a, b] = parts;
    if (a === 0)                             return true;  // 0.0.0.0/8
    if (a === 10)                            return true;  // 10.0.0.0/8
    if (a === 100 && b >= 64 && b <= 127)    return true;  // 100.64.0.0/10 (CGN)
    if (a === 127)                           return true;  // 127.0.0.0/8
    if (a === 169 && b === 254)              return true;  // 169.254.0.0/16 (link-local + cloud metadata)
    if (a === 172 && b >= 16 && b <= 31)     return true;  // 172.16.0.0/12
    if (a === 192 && b === 168)              return true;  // 192.168.0.0/16
    if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24
    if (a >= 224)                            return true;  // multicast + reserved
    return false;
  }

  // ── IPv6 ────────────────────────────────────────────────────────────────
  if (net.isIPv6(raw)) {
    // Mixed-notation IPv4-mapped IPv6 first (e.g. "::ffff:127.0.0.1")
    const v4mixed = extractMappedIPv4Mixed(raw);
    if (v4mixed) return isForbiddenIP(v4mixed);

    const full = expandIPv6(raw);

    // Pure-hex IPv4-mapped IPv6: ::ffff:7f00:0001
    const v4mapped = extractMappedIPv4(full);
    if (v4mapped) return isForbiddenIP(v4mapped);

    // Loopback ::1
    if (full === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
    // Unspecified ::
    if (full === '0000:0000:0000:0000:0000:0000:0000:0000') return true;

    const firstWord = parseInt(full.slice(0, 4), 16);
    // Link-local fe80::/10
    if ((firstWord & 0xffc0) === 0xfe80) return true;
    // Unique local fc00::/7
    if ((firstWord & 0xfe00) === 0xfc00) return true;
    // Multicast ff00::/8
    if ((firstWord & 0xff00) === 0xff00) return true;
    // Teredo 2001:0000::/32
    if (full.startsWith('2001:0000')) return true;

    return false;
  }

  return false;
}

/** Expand an IPv6 address to full 8-group form (lowercase hex). */
function expandIPv6(ip: string): string {
  let halves = ip.split('::');
  let groups: string[];
  if (halves.length === 2) {
    const left  = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const fill  = 8 - left.length - right.length;
    groups = [...left, ...Array(fill).fill('0'), ...right];
  } else {
    groups = ip.split(':');
  }
  return groups.map(g => g.padStart(4, '0').toLowerCase()).join(':');
}

/** Extract the IPv4 portion from an IPv4-mapped IPv6 address, or null. */
function extractMappedIPv4(fullIPv6: string): string | null {
  // ::ffff:xxxx:yyyy → last 32 bits are the IPv4
  if (fullIPv6.startsWith('0000:0000:0000:0000:ffff:') ||
      fullIPv6.startsWith('0000:0000:0000:0000:0000:ffff:')) {
    const lastTwo = fullIPv6.split(':').slice(-2);
    if (lastTwo.length === 2) {
      const hi = parseInt(lastTwo[0]!, 16);
      const lo = parseInt(lastTwo[1]!, 16);
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return null;
}

/**
 * Handle mixed-notation IPv4-mapped IPv6 (e.g. "::ffff:127.0.0.1")
 * which net.isIPv6 recognizes but expandIPv6 won't handle correctly.
 */
function extractMappedIPv4Mixed(raw: string): string | null {
  const match = raw.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  return match ? match[1]! : null;
}

// ─── Canonicalization ─────────────────────────────────────────────────────────

function canonicalize(url: URL): string {
  const c = new URL(url.href);
  for (const p of [...c.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(p.toLowerCase())) c.searchParams.delete(p);
  }
  let s = c.toString();
  if (s.endsWith('#')) s = s.slice(0, -1);
  return s;
}

// ─── Host Helpers ─────────────────────────────────────────────────────────────

function normalizeHost(h: string): string {
  return h.replace(/^www\./, '').replace(/^m\./, '');
}
function isWildberriesHost(h: string): boolean {
  const n = normalizeHost(h);
  return n === 'wildberries.ru' || n.endsWith('.wildberries.ru');
}
function isBrowserFirst(h: string): boolean {
  const n = normalizeHost(h);
  return BROWSER_FIRST.has(n) || [...BROWSER_FIRST].some(d => n.endsWith(`.${d}`));
}

// ─── Wildberries Direct API ───────────────────────────────────────────────────

function extractWbArticleId(url: URL): string | null {
  const m = url.pathname.match(/\/catalog\/(\d{6,12})\//);
  if (m) return m[1]!;
  const m2 = url.pathname.match(/\/(\d{6,12})(?:\/|$)/);
  if (m2) return m2[1]!;
  return null;
}

async function fetchWbCardApi(nmStr: string, referer: string): Promise<ParseResult | null> {
  // card.wb.ru shut down April 2025; use search.wb.ru as replacement
  const apiUrl = `https://search.wb.ru/exactmatch/ru/common/v18/search?appType=1&curr=rub&dest=-1257786&query=${nmStr}&resultset=catalog`;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6_000);
    const res   = await fetch(apiUrl, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Origin': 'https://www.wildberries.ru',
        'Referer': referer,
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;

    // Reject HTML responses (anti-bot pages return text/html)
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('json')) return null;

    const json = await res.json() as {
      data?: { products?: Array<{
        id: number; name?: string;
        salePriceU?: number;
        sizes?: Array<{ price?: { total?: number } }>;
        mediaFiles?: string[];
      }> };
    };
    const products = json?.data?.products;
    if (!Array.isArray(products) || products.length === 0) return null;
    // Search returns multiple results; prefer exact nmId match
    const nmInt = parseInt(nmStr, 10);
    const p = products.find(x => x.id === nmInt) ?? products[0]!;

    const title      = p.name?.trim() ?? null;
    const kopecks    = p.salePriceU ?? p.sizes?.[0]?.price?.total ?? null;
    const priceRub   = kopecks !== null ? Math.round(kopecks / 100) : null;
    const priceText  = priceRub ? `${formatNumber(priceRub)} ₽` : null;
    const nm         = p.id;

    let imageUrl: string | null = null;
    if (Array.isArray(p.mediaFiles) && p.mediaFiles.length > 0) {
      imageUrl = p.mediaFiles[0]!;
    }
    if (!imageUrl) imageUrl = wbCdnImageUrl(nm);

    const confidence = calcConfidence({ title, imageUrl, priceText });
    return { title, description: null, priceText, imageUrl, confidence, parseMethod: 'domain_api' };
  } catch (e) {
    console.warn(`[parser] WB API error nm=${nmStr}: ${(e as Error).message}`);
    return null;
  }
}

// ─── Browser Path ─────────────────────────────────────────────────────────────

async function runBrowserExtract(url: string, hostname: string): Promise<ParseResult> {
  const browser = await getBrowser();
  const { html, product: networkProduct } = await browserExtract(browser, url, hostname);

  // Cheerio extraction from rendered HTML (levels 3–5 in priority)
  const htmlResult = extractFromHtml(html, url, hostname, 'browser_fallback');

  return mergeNetworkWithHtml(networkProduct, htmlResult, hostname);
}

/**
 * Merge: network/hydration product (level 1-3) > HTML-based result (level 4-5)
 * Each field independently takes the best available source.
 */
function mergeNetworkWithHtml(
  net: ExtractedProduct | null,
  html: ParseResult,
  hostname: string,
): ParseResult {
  if (!net || net.score < 20) return html;

  const title      = net.title      ?? html.title;
  const description = net.description ?? html.description;
  // Sanitise the hydration/network image through resolveUrl: resolves
  // protocol-relative URLs and rejects non-http(s) schemes.
  const imageUrl   = resolveUrl(net.imageUrl, `https://${hostname}`) ?? html.imageUrl;
  const netAmount  = parseAmount(net.rawPrice);
  const priceText  = netAmount !== null
    ? formatPrice(netAmount, net.currency ?? fallbackCurrency(hostname))
    : html.priceText;

  const cleanedTitle = cleanTitle(title, hostname);

  const confidence = calcConfidence({ title: cleanedTitle, imageUrl, priceText });

  // parseMethod reflects where the most valuable data came from
  const parseMethod: ParseResult['parseMethod'] =
    net.source === 'network_response' ? 'domain_api' :
    net.source === 'next_data'        ? 'generic_jsonld' :
    net.source === 'hydration_state'  ? 'generic_jsonld' :
    'browser_fallback';

  return { title: cleanedTitle, description, priceText, imageUrl, confidence, parseMethod };
}

// ─── HTML Fetch (plain HTTP) ──────────────────────────────────────────────────

const MAX_REDIRECTS = 5;

async function fetchHtml(url: string): Promise<string> {
  let currentUrl = url;

  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount++) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(currentUrl, {
        signal: ctrl.signal,
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
          'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Upgrade-Insecure-Requests': '1',
        },
        redirect: 'manual',
      });

      // Handle redirects manually: validate each redirect target
      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get('location');
        if (!location) throw new Error('Redirect without Location header');
        const redirectUrl = new URL(location, currentUrl);
        validateUrl(redirectUrl.href);                        // re-validate structure
        await assertDnsIsSafe(redirectUrl);                    // re-validate resolved IPs
        currentUrl = redirectUrl.href;
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('text/html') && !ct.includes('application/xhtml'))
        throw new Error(`Not HTML: ${ct}`);

      const reader = res.body?.getReader();
      if (!reader) throw new Error('No body');
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        chunks.push(value);
        if (total >= MAX_HTML_BYTES) { reader.cancel(); break; }
      }
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
      return new TextDecoder('utf-8', { fatal: false }).decode(buf);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error('Слишком много редиректов');
}

// Register fetchHtml provider for marketplace strategies
registerFetchHtmlProvider(fetchHtml);

// ─── HTML Extraction (universal structured-data + domain adapters) ───────────

/**
 * Universal extraction kill switch. Set PARSER_UNIVERSAL_EXTRACT_DISABLED=1 to
 * roll back to the pre-existing JSON-LD + Open Graph + domain-adapter behaviour
 * without a redeploy (microdata, Twitter cards and embedded hydration JSON are
 * skipped). JSON-LD and Open Graph always stay on — they are not new.
 */
function isUniversalExtractEnabled(): boolean {
  return process.env.PARSER_UNIVERSAL_EXTRACT_DISABLED !== '1';
}

/** Run the shared hydration-JSON scanner and normalise to ExtractedFields. */
function hydrationFields($: cheerio.CheerioAPI, html: string, hostname: string): ExtractedFields | null {
  const ep = extractFromHydration(html, hostname, $);
  if (!ep) return null;
  return {
    title:       ep.title,
    description: ep.description,
    price:       parseAmount(ep.rawPrice),
    currency:    ep.currency,
    image:       ep.imageUrl,
  };
}

/** First price candidate (in precedence order) that carries a numeric amount. */
function pickPrice(
  candidates: Array<{ amount: number | null; currency: string | null } | null>,
): { amount: number; currency: string | null } | null {
  for (const c of candidates) {
    if (c && c.amount !== null) return { amount: c.amount, currency: c.currency };
  }
  return null;
}

/**
 * Extract product fields from a rendered/fetched HTML document.
 *
 * Universal layer — domain-agnostic, works for marketplaces worldwide.
 * Per-field precedence (highest first):
 *   domain adapter > embedded hydration JSON > JSON-LD > microdata >
 *   Open Graph > Twitter Card > <title>/<meta>.
 */
export function extractFromHtml(
  html: string,
  baseUrl: string,
  hostname: string,
  defaultMethod: ParseResult['parseMethod'],
): ParseResult {
  const $ = cheerio.load(html);
  const h = normalizeHost(hostname);

  // Plain <title> / <meta description> — weakest universal fallback
  const titleTag = $('title').first().text().trim() || null;
  const metaDesc = $('meta[name="description"]').attr('content')?.trim() ?? null;

  const universalOn = isUniversalExtractEnabled();
  const og = extractOpenGraph($);

  // ── Anti-bot guard ─────────────────────────────────────────────────────
  if (isAntiBotPage(html, og?.title ?? titleTag)) {
    console.warn(`[parser] anti-bot detected for ${hostname}`);
    return emptyParseResult(defaultMethod);
  }

  // ── Structured-data extractors ─────────────────────────────────────────
  const jsonLd  = extractJsonLd($);
  const micro   = universalOn ? extractMicrodata($)   : null;
  const twitter = universalOn ? extractTwitterCard($) : null;
  // Embedded hydration JSON — skipped in the browser path, where
  // browserExtract() already scanned hydration state alongside network data.
  const embedded = (universalOn && defaultMethod !== 'browser_fallback')
    ? hydrationFields($, html, h)
    : null;

  // ── Domain adapter (bespoke per-site DOM selectors) ────────────────────
  const domainData = applyDomainAdapter($, h, html);

  // ── Field-level merge by source precedence ─────────────────────────────
  const title = cleanTitle(
    domainData?.title ?? embedded?.title ?? jsonLd?.title ?? micro?.title
    ?? og?.title ?? twitter?.title ?? titleTag,
    h,
  );

  const description = (
    domainData?.description ?? embedded?.description ?? jsonLd?.description
    ?? micro?.description ?? og?.description ?? twitter?.description ?? metaDesc
  )?.slice(0, 500) ?? null;

  const imageUrl = resolveUrl(
    domainData?.image ?? embedded?.image ?? jsonLd?.image ?? micro?.image
    ?? og?.image ?? twitter?.image ?? null,
    baseUrl,
  );

  const price = pickPrice([
    { amount: parseAmount(domainData?.price), currency: domainData?.currency ?? null },
    embedded ? { amount: embedded.price, currency: embedded.currency } : null,
    jsonLd   ? { amount: jsonLd.price,   currency: jsonLd.currency }   : null,
    micro    ? { amount: micro.price,    currency: micro.currency }    : null,
    og       ? { amount: og.price,       currency: og.currency }       : null,
    twitter  ? { amount: twitter.price,  currency: twitter.currency }  : null,
  ]);
  const priceText = price
    ? formatPrice(price.amount, price.currency ?? fallbackCurrency(h))
    : null;

  // ── parseMethod: where the strongest signal came from ──────────────────
  let parseMethod: ParseResult['parseMethod'] = defaultMethod;
  if (defaultMethod !== 'browser_fallback') {
    if (domainData)                       parseMethod = 'domain_adapter';
    else if (embedded || jsonLd || micro) parseMethod = 'generic_jsonld';
  }

  const confidence = calcConfidence({ title, imageUrl: imageUrl ?? null, priceText });
  return { title, description, priceText, imageUrl: imageUrl ?? null, confidence, parseMethod };
}

// Anti-bot detection → marketplace/guards.ts (isAntiBotPage)

// JSON-LD / microdata / Open Graph / Twitter extraction → marketplace/structured-data.ts

// ─── Domain Adapters (DOM-level, level 5b) ────────────────────────────────────

interface DomainData {
  title?: string | null;
  description?: string | null;
  image?: string | null;
  price?: string | null;
  /** ISO 4217 currency when the adapter can determine it from the page */
  currency?: string | null;
}

function applyDomainAdapter($: cheerio.CheerioAPI, hostname: string, html: string): DomainData | null {
  if (isAmazonHost(hostname))                                                     return amazonAdapter($);
  if (isAliexpressHost(hostname))                                                 return aliexpressAdapter(html);
  if (isJdHost(hostname))                                                         return jdAdapter($, html);
  if (hostname === 'ozon.ru'          || hostname.endsWith('.ozon.ru'))           return ozonAdapter($, html);
  if (hostname === 'wildberries.ru'   || hostname.endsWith('.wildberries.ru'))    return wbHtmlAdapter($, html);
  if (hostname === 'market.yandex.ru' || hostname.endsWith('.market.yandex.ru')) return ymAdapter($);
  if (hostname === 'lamoda.ru'        || hostname.endsWith('.lamoda.ru'))         return lamodaAdapter($);
  if (hostname === 'goldapple.ru'     || hostname.endsWith('.goldapple.ru'))      return goldappleAdapter($);
  if (hostname === 'tehnopark.ru'     || hostname.endsWith('.tehnopark.ru'))      return tehnoparkAdapter($);
  if (hostname === 'bork.ru'          || hostname.endsWith('.bork.ru'))           return borkAdapter($);
  return null;
}

function ozonAdapter($: cheerio.CheerioAPI, html: string): DomainData | null {
  const result: DomainData = {};
  const ogTitle = $('meta[property="og:title"]').attr('content')?.trim();
  if (ogTitle) {
    result.title = ogTitle
      .replace(/\s*[-–—]\s*(?:купить|заказать)\s+(?:на|в)\s+OZON.*/i, '')
      .replace(/\s*\|\s*OZON\s*$/i, '').trim();
  }
  // Price from hydration JSON (Ozon embeds price in script tags)
  const priceM = html.match(/"finalPrice"\s*:\s*(\d+)/)
              ?? html.match(/"price"\s*:\s*(\d+)/);
  if (priceM?.[1]) {
    const p = parseInt(priceM[1]!, 10);
    if (p > 0 && p < 10_000_000) result.price = String(p);
  }
  // DOM selector fallback
  if (!result.price) {
    const domPrice = $('[data-widget="webSalePrice"] span').first().text()
                  || $('[data-widget="webPrice"] span').first().text();
    if (domPrice) {
      const m = domPrice.match(/([\d\s]+)\s*₽/);
      if (m?.[1]) result.price = m[1]!.replace(/\s/g, '');
    }
  }
  return Object.keys(result).length ? result : null;
}

function wbHtmlAdapter($: cheerio.CheerioAPI, html: string): DomainData | null {
  const result: DomainData = {};
  const ogTitle = $('meta[property="og:title"]').attr('content')?.trim();
  if (ogTitle) {
    result.title = ogTitle
      .replace(/\s*[-–—]\s*(?:купить|заказать).*/i, '')
      .replace(/\s*\|\s*Wildberries\s*$/i, '').trim();
  }
  // Price might be in page script data
  if (!result.price) {
    const m = html.match(/"price"\s*:\s*(\d+)/);
    if (m?.[1]) {
      const p = parseInt(m[1]!, 10);
      if (p > 50_000 && p % 100 === 0) result.price = String(Math.round(p / 100));
      else if (p > 0 && p < 1_000_000) result.price = String(p);
    }
  }
  return Object.keys(result).length ? result : null;
}

function ymAdapter($: cheerio.CheerioAPI): DomainData | null {
  const result: DomainData = {};
  const ogTitle = $('meta[property="og:title"]').attr('content')?.trim();
  if (ogTitle) {
    result.title = ogTitle
      .replace(/\s*[-–—]\s*(?:купить|заказать).*/i, '')
      .replace(/\s*[-–—]\s*Яндекс.*/i, '').trim();
  }
  const priceM = $('meta[property="yandex_market:price"]').attr('content')
              ?? $('meta[name="price"]').attr('content');
  if (priceM) result.price = priceM;
  return Object.keys(result).length ? result : null;
}

function lamodaAdapter($: cheerio.CheerioAPI): DomainData | null {
  const result: DomainData = {};
  for (const sel of [
    '[class*="product-prices__price_type_discount"]', '[class*="product-prices__price"]',
    '[data-testid="price"]', '[class*="price__price"]',
  ]) {
    const t = $(sel).first().text().trim();
    if (t) {
      const m = t.match(/([\d\s]+)\s*(?:₽|руб)/);
      if (m?.[1]) { result.price = m[1]!.replace(/\s/g, ''); break; }
    }
  }
  const brand = $('[data-testid="brand-name"]').first().text().trim();
  const prod  = $('[data-testid="product-name"]').first().text().trim()
             || $('[class*="product-title"]').first().text().trim();
  if (brand && prod) result.title = `${brand} ${prod}`;
  else if (prod)     result.title = prod;
  return Object.keys(result).length ? result : null;
}

function goldappleAdapter($: cheerio.CheerioAPI): DomainData | null {
  const result: DomainData = {};
  for (const sel of [
    '[class*="ProductPage__price"]', '[class*="product-price"]',
    '.price__value', '[itemprop="price"]', '[data-testid="price"]',
  ]) {
    const el   = $(sel).first();
    const text = el.attr('content') ?? el.text().trim();
    if (text) {
      const m = text.match(/([\d\s]+)\s*(?:₽|руб)?/);
      if (m?.[1]) { result.price = m[1]!.replace(/\s/g, ''); break; }
    }
  }
  const nameEl = $('[class*="ProductPage__name"]').first().text().trim()
              || $('h1').first().text().trim();
  if (nameEl) result.title = nameEl;
  return Object.keys(result).length ? result : null;
}

function tehnoparkAdapter($: cheerio.CheerioAPI): DomainData | null {
  const result: DomainData = {};
  for (const sel of [
    '[class*="product-buy__price"]', '[itemprop="price"]', '[class*="price_value"]', '.price',
  ]) {
    const el   = $(sel).first();
    const text = el.attr('content') ?? el.text().trim();
    if (text) {
      const m = text.replace(/\s/g, '').match(/^(\d+)/);
      if (m?.[1]) { result.price = m[1]!; break; }
    }
  }
  return Object.keys(result).length ? result : null;
}

function borkAdapter($: cheerio.CheerioAPI): DomainData | null {
  const result: DomainData = {};
  for (const sel of [
    '[class*="product__price"]', '[class*="price__value"]',
    '[itemprop="price"]', '.product-price',
  ]) {
    const el   = $(sel).first();
    const text = el.attr('content') ?? el.text().trim();
    if (text) {
      const m = text.replace(/\s/g, '').match(/^(\d+)/);
      if (m?.[1]) { result.price = m[1]!; break; }
    }
  }
  const h1 = $('h1').first().text().trim();
  if (h1) result.title = h1;
  return Object.keys(result).length ? result : null;
}

// ─── Amazon / AliExpress (bespoke — see API_ARCHITECTURE notes) ──────────────

function isAmazonHost(h: string): boolean {
  return /(^|\.)amazon\.(com|com\.mx|com\.br|com\.au|co\.uk|co\.jp|de|es|fr|it|nl|ca|se|pl|sa|ae|eg|sg|in)$/.test(h);
}

function isAliexpressHost(h: string): boolean {
  return /(^|\.)aliexpress\.(com|ru|us)$/.test(h);
}

function isJdHost(h: string): boolean {
  return /(^|\.)jd\.com$/.test(h);
}

/**
 * Amazon ships no JSON-LD Product and no og:price — title and image come
 * from the universal layer, but the price needs DOM selectors.
 */
function amazonAdapter($: cheerio.CheerioAPI): DomainData | null {
  const result: DomainData = {};

  const title = $('#productTitle').first().text().trim()
             || $('#title').first().text().trim();
  if (title) result.title = title;

  for (const sel of [
    '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen',
    '#corePrice_feature_div .a-price .a-offscreen',
    '#corePrice_desktop .a-offscreen',
    'span.priceToPay .a-offscreen',
    '#priceblock_ourprice',
    '#priceblock_dealprice',
    '#priceblock_saleprice',
    '.a-price .a-offscreen',
  ]) {
    const text = $(sel).first().text().trim();
    if (!text) continue;
    const amount = parseAmount(text);
    if (amount !== null) {
      // Currency comes from the site registry (amazon.ca = CAD, amazon.co.jp =
      // JPY, …) — the on-page "$"/"¥" symbol is ambiguous across Amazon TLDs.
      result.price = String(amount);
      break;
    }
  }

  const img = $('#landingImage').attr('data-old-hires')
           || $('#landingImage').attr('src')
           || $('#imgTagWrapperId img').attr('src');
  if (img && !img.startsWith('data:')) result.image = img;

  return Object.keys(result).length ? result : null;
}

/**
 * AliExpress server-renders product data into `window.runParams`. Title and
 * image are usually also in Open Graph, but the price lives only here.
 */
function aliexpressAdapter(html: string): DomainData | null {
  const result: DomainData = {};
  const data = extractAliexpressData(html);
  if (!data) return null;

  const titleModule = data.titleModule ?? data.productInfoComponent;
  const subject = titleModule?.subject ?? data.subject;
  if (typeof subject === 'string' && subject.trim()) result.title = subject.trim();

  const pm = data.priceModule ?? data.priceComponent;
  if (pm) {
    const amt = pm.minActivityAmount?.value ?? pm.minAmount?.value
             ?? pm.maxActivityAmount?.value ?? pm.maxAmount?.value
             ?? pm.formatedActivityPrice ?? pm.formatedPrice;
    const num = parseAmount(amt);
    if (num !== null) {
      result.price = String(num);
      const cur = pm.minActivityAmount?.currency ?? pm.minAmount?.currency
               ?? detectCurrency(String(pm.formatedActivityPrice ?? pm.formatedPrice ?? ''));
      if (cur) result.currency = String(cur).toUpperCase();
    }
  }

  const imgList = (data.imageModule ?? data.imageComponent)?.imagePathList;
  if (Array.isArray(imgList) && typeof imgList[0] === 'string') result.image = imgList[0];

  return Object.keys(result).length ? result : null;
}

/**
 * Locate and parse the `window.runParams` SSR blob from AliExpress HTML.
 * Returned as `any`: runParams is deep, version-volatile vendor JSON — every
 * read in aliexpressAdapter is coerced through parseAmount / String.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractAliexpressData(html: string): any | null {
  let idx = html.indexOf('runParams');
  // Cap the scan: a real page has runParams once; bound work on hostile input.
  for (let scans = 0; idx !== -1 && scans < 5; scans++) {
    const eq = html.indexOf('=', idx + 'runParams'.length);
    if (eq !== -1 && eq - idx < 40) {
      const json = extractEmbeddedJson(html, eq + 1);
      if (json) {
        try {
          const parsed = JSON.parse(json);
          const data = parsed?.data ?? parsed;
          if (data && typeof data === 'object') return data;
        } catch { /* truncated/invalid — try the next occurrence */ }
      }
    }
    idx = html.indexOf('runParams', idx + 'runParams'.length);
  }
  return null;
}

/**
 * JD.com — no JSON-LD / Open Graph / hydration JSON. Title comes from the
 * `.sku-name` element (fallback: a `name:'…'` pageConfig literal), the image
 * from `#spec-img`. JD loads the price asynchronously by JS and it is not in
 * the served HTML, so JD imports land as "partial" — title + image, no price.
 */
function jdAdapter($: cheerio.CheerioAPI, html: string): DomainData | null {
  const result: DomainData = {};

  const name = $('.sku-name').first().text().trim();
  if (name) {
    result.title = name;
  } else {
    const m = html.match(/name:\s*'([^']{2,200})'/);
    if (m?.[1]) result.title = m[1].trim();
  }

  const img = $('#spec-img').attr('data-origin')
           || $('#spec-img').attr('src')
           || $('#preview img').first().attr('src');
  if (img) result.image = img;

  return Object.keys(result).length ? result : null;
}

// ─── Title Cleanup ────────────────────────────────────────────────────────────

const TITLE_SUFFIXES: Array<[RegExp, RegExp[]]> = [
  [/ozon\.ru/i,             [/\s*[-–—]\s*(?:купить|заказать)\s+(?:на|в)\s+OZON.*/i, /\s*\|\s*OZON\s*$/i]],
  [/wildberries\.ru/i,      [/\s*[-–—]\s*(?:купить|заказать).*/i, /\s*\|\s*Wildberries\s*$/i]],
  [/market\.yandex\.ru/i,   [/\s*[-–—]\s*(?:купить|заказать).*/i, /\s*[-–—]\s*Яндекс.*/i]],
  [/lamoda\.ru/i,           [/\s*[-–—]\s*(?:купить|заказать).*/i, /\s*\|\s*Lamoda\s*$/i]],
  [/goldapple\.ru/i,        [/\s*[-–—]\s*(?:купить|заказать).*/i, /\s*\|\s*Золотое яблоко\s*$/i]],
  [/tehnopark\.ru/i,        [/\s*[-–—]\s*(?:купить|заказать).*/i, /\s*[-–—]\s*Технопарк\s*$/i]],
  [/bork\.ru/i,             [/\s*[-–—]\s*(?:купить|заказать).*/i, /\s*\|\s*BORK\s*$/i]],
  [/amazon\./i,             [/^\s*Amazon\.[a-z.]+\s*:\s*/i]],
  [/aliexpress\./i,         [/\s*[-–—|]\s*AliExpress.*$/i]],
];

function cleanTitle(title: string | null, hostname: string): string | null {
  if (!title) return null;
  let t = title;
  for (const [domainRe, rules] of TITLE_SUFFIXES) {
    if (domainRe.test(hostname)) {
      for (const re of rules) t = t.replace(re, '');
    }
  }
  return t.trim() || title.trim() || null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveUrl(url: string | null | undefined, base: string): string | null {
  if (!url) return null;
  try {
    const resolved = new URL(url, base);
    // Reject non-web schemes (javascript:, data:, file:, …) — image/URL values
    // come from scraped, attacker-controllable HTML.
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;
    return resolved.href;
  } catch {
    return null;
  }
}

function formatNumber(n: number): string {
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function calcConfidence(r: { title: string | null; imageUrl: string | null; priceText: string | null }): ParseResult['confidence'] {
  if (!r.title) return 'none';
  if (r.title && r.imageUrl && r.priceText) return 'high';
  if (r.title && (r.imageUrl || r.priceText)) return 'medium';
  return 'low';
}

function confidenceScore(c: ParseResult['confidence']): number {
  return { none: 0, low: 1, medium: 2, high: 3 }[c];
}

function pickBetter(a: ParseResult, b: ParseResult): ParseResult {
  return confidenceScore(b.confidence) > confidenceScore(a.confidence) ? b : a;
}

function emptyParseResult(method: ParseResult['parseMethod']): ParseResult {
  return { title: null, description: null, priceText: null, imageUrl: null,
           confidence: 'none', parseMethod: method };
}

function emptyResult(sourceDomain: string, canonicalUrl: string): ParsedUrlData {
  return { title: null, description: null, priceText: null, imageUrl: null,
           sourceDomain, canonicalUrl, confidence: 'none', parseMethod: 'generic_html' };
}

function toFinal(r: ParseResult, sourceDomain: string, canonicalUrl: string): ParsedUrlData {
  return { ...r, sourceDomain, canonicalUrl };
}

// Re-export for any callers that still import wbBasket from this module
export { wbBasket, wbCdnImageUrl };
