/**
 * URL Parser — product card metadata extraction
 *
 * Extraction pipeline with 5-level source priority:
 *   1. network_response  — XHR/fetch JSON intercepted during browser render
 *   2. next_data         — __NEXT_DATA__ (Next.js hydration)
 *   3. hydration_state   — window.__INITIAL_STATE__ / Redux / Vuex / etc.
 *   4. jsonld            — JSON-LD Product structured data
 *   5. og_meta / dom     — Open Graph meta tags + domain DOM selectors
 *
 * Overall flow per request:
 *   validateUrl + canonicalize
 *   → cache check (24 h success / 5 min negative)
 *   → WB shortcut: card.wb.ru JSON API (if nm extractable)
 *   → SPA/browser-first domains → browserExtract (network + hydration + HTML)
 *   → HTTP-first domains → fetchHtml + Cheerio
 *       → confidence < medium → browserExtract fallback
 *   → anti-bot / garbage guard
 *   → merge by priority
 *   → cache store
 */

import * as cheerio from 'cheerio';
import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import puppeteer, { type Browser } from 'puppeteer-core';
import {
  browserExtract,
  type ExtractedProduct,
  wbCdnImageUrl,
  wbBasket,
} from './browser-network-extractor.js';

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

// ─── Main Entry ───────────────────────────────────────────────────────────────

export async function parseUrl(rawUrl: string): Promise<ParsedUrlData> {
  const url          = validateUrl(rawUrl);
  await assertDnsIsSafe(url);
  const hostname     = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
  const canonicalUrl = canonicalize(url);

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
        // API failed — fall through to browser
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
          // medium or high — good enough
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
      console.warn(`[parser] no useful data for ${hostname}`);
      setNegative(canonicalUrl);
      return emptyResult(hostname, canonicalUrl);
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
    setNegative(canonicalUrl);
    return emptyResult(hostname, canonicalUrl);
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
  const apiUrl = `https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=-1257786&nm=${nmStr}`;
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

    const json = await res.json() as {
      data?: { products?: Array<{
        id: number; name?: string;
        salePriceU?: number;
        sizes?: Array<{ price?: { total?: number } }>;
        mediaFiles?: string[];
      }> };
    };
    const p = json?.data?.products?.[0];
    if (!p) return null;

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

  return mergeNetworkWithHtml(networkProduct, htmlResult);
}

/**
 * Merge: network/hydration product (level 1-3) > HTML-based result (level 4-5)
 * Each field independently takes the best available source.
 */
function mergeNetworkWithHtml(
  net: ExtractedProduct | null,
  html: ParseResult,
): ParseResult {
  if (!net || net.score < 20) return html;

  const title      = net.title      ?? html.title;
  const description = net.description ?? html.description;
  const imageUrl   = net.imageUrl   ?? html.imageUrl;
  const priceText  = net.rawPrice
    ? formatPrice(net.rawPrice, net.currency)
    : html.priceText;

  // Clean up title (remove "- купить на..." suffixes from network data too)
  const hostname = ''; // titles from network don't need domain-specific cleaning usually
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

// ─── HTML Extraction (Cheerio + JSON-LD + domain adapters) ───────────────────

function extractFromHtml(
  html: string,
  baseUrl: string,
  hostname: string,
  defaultMethod: ParseResult['parseMethod'],
): ParseResult {
  const $ = cheerio.load(html);
  const h = normalizeHost(hostname);

  // ── Open Graph / meta (level 5a) ──────────────────────────────────────
  const ogTitle  = $('meta[property="og:title"]').attr('content')?.trim() ?? null;
  const ogImage  = $('meta[property="og:image"]').attr('content')?.trim() ?? null;
  const ogDesc   = $('meta[property="og:description"]').attr('content')?.trim() ?? null;
  const ogPrice  = ($('meta[property="product:price:amount"]').attr('content')
                 ?? $('meta[property="og:price:amount"]').attr('content'))?.trim() ?? null;
  const ogCur    = ($('meta[property="product:price:currency"]').attr('content')
                 ?? $('meta[property="og:price:currency"]').attr('content'))?.trim() ?? null;
  const titleTag = $('title').first().text().trim() || null;
  const metaDesc = $('meta[name="description"]').attr('content')?.trim() ?? null;

  let resolvedOgImage = ogImage;
  if (resolvedOgImage && !resolvedOgImage.startsWith('http')) {
    try { resolvedOgImage = new URL(resolvedOgImage, baseUrl).href; } catch { /* keep */ }
  }

  const universal = {
    title: ogTitle ?? titleTag ?? null,
    desc:  ogDesc  ?? metaDesc ?? null,
    image: resolvedOgImage,
    price: ogPrice,
    cur:   ogCur,
  };

  // ── Anti-bot guard ─────────────────────────────────────────────────────
  if (isAntiBotPage(html, universal.title)) {
    console.warn(`[parser] anti-bot detected for ${hostname}`);
    return emptyParseResult(defaultMethod);
  }

  // ── JSON-LD (level 4) ──────────────────────────────────────────────────
  const jsonLd = extractJsonLd($);

  // ── Domain adapters (level 5b — DOM selectors) ─────────────────────────
  const domainData = applyDomainAdapter($, h, html);

  // ── Merge: domain DOM > JSON-LD > OG ──────────────────────────────────
  const title       = cleanTitle(domainData?.title ?? jsonLd?.name    ?? universal.title ?? null, h);
  const description = (domainData?.description ?? jsonLd?.description ?? universal.desc  ?? null)?.slice(0, 500) ?? null;
  const imageUrl    = resolveUrl(domainData?.image ?? jsonLd?.image    ?? universal.image ?? null, baseUrl);
  const rawPrice    = domainData?.price ?? jsonLd?.price    ?? universal.price ?? null;
  const priceCur    = jsonLd?.currency ?? universal.cur ?? null;
  const priceText   = rawPrice ? formatPrice(rawPrice, priceCur) : null;

  let parseMethod: ParseResult['parseMethod'] = defaultMethod;
  if (domainData) {
    parseMethod = defaultMethod === 'browser_fallback' ? 'browser_fallback' : 'domain_adapter';
  } else if (jsonLd?.name || jsonLd?.price) {
    parseMethod = defaultMethod === 'browser_fallback' ? 'browser_fallback' : 'generic_jsonld';
  }

  const confidence = calcConfidence({ title, imageUrl: imageUrl ?? null, priceText });
  return { title, description, priceText, imageUrl: imageUrl ?? null, confidence, parseMethod };
}

// ─── Anti-Bot Detection ───────────────────────────────────────────────────────

function isAntiBotPage(html: string, title: string | null): boolean {
  if (html.length < 800) return true;

  const lTitle = (title ?? '').toLowerCase();
  if (['captcha', 'robot', 'challenge', 'antibot', 'access denied',
       'attention required', 'just a moment', 'проверка', 'verify you are human']
    .some(t => lTitle.includes(t))) return true;

  const lHtml = html.toLowerCase();
  if (['g-recaptcha', 'h-captcha', 'cf_challenge', 'cf-challenge-running',
       'cf_chl_opt', 'cf-please-wait', 'ddos-guard', 'smartcaptcha',
       'class="antibot"', '__cf_chl', 'yandex-smartcaptcha']
    .some(s => lHtml.includes(s))) return true;

  return false;
}

// ─── JSON-LD Extractor ────────────────────────────────────────────────────────

interface JsonLdProduct {
  name: string | null; description: string | null;
  image: string | null; price: string | null; currency: string | null;
}

function extractJsonLd($: cheerio.CheerioAPI): JsonLdProduct | null {
  const scripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    try {
      const raw = $(scripts[i]).html()?.trim();
      if (!raw) continue;
      const data = JSON.parse(raw);
      const product = findJsonLdProduct(data);
      if (product) return product;
    } catch { /* skip */ }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findJsonLdProduct(data: any): JsonLdProduct | null {
  if (!data) return null;
  if (data['@graph'] && Array.isArray(data['@graph'])) {
    for (const item of data['@graph']) { const r = findJsonLdProduct(item); if (r) return r; }
    return null;
  }
  if (Array.isArray(data)) {
    for (const item of data) { const r = findJsonLdProduct(item); if (r) return r; }
    return null;
  }
  const type = data['@type'];
  if (!(type === 'Product' || (Array.isArray(type) && type.includes('Product')))) return null;

  let price: string | null = null;
  let currency: string | null = null;
  const offers = data.offers;
  if (offers) {
    const offer = Array.isArray(offers) ? offers[0] : offers;
    price    = offer?.price != null ? String(offer.price) : (offer?.lowPrice != null ? String(offer.lowPrice) : null);
    currency = offer?.priceCurrency ?? null;
  }

  let image: string | null = null;
  if (typeof data.image === 'string')          image = data.image;
  else if (Array.isArray(data.image))          image = typeof data.image[0] === 'string' ? data.image[0] : (data.image[0]?.url ?? null);
  else if (data.image?.url)                    image = data.image.url;

  return {
    name:        data.name        ? String(data.name).trim()        : null,
    description: data.description ? String(data.description).trim() : null,
    image, price, currency,
  };
}

// ─── Domain Adapters (DOM-level, level 5b) ────────────────────────────────────

interface DomainData {
  title?: string | null;
  description?: string | null;
  image?: string | null;
  price?: string | null;
}

function applyDomainAdapter($: cheerio.CheerioAPI, hostname: string, html: string): DomainData | null {
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

// ─── Title Cleanup ────────────────────────────────────────────────────────────

const TITLE_SUFFIXES: Array<[RegExp, RegExp[]]> = [
  [/ozon\.ru/i,             [/\s*[-–—]\s*(?:купить|заказать)\s+(?:на|в)\s+OZON.*/i, /\s*\|\s*OZON\s*$/i]],
  [/wildberries\.ru/i,      [/\s*[-–—]\s*(?:купить|заказать).*/i, /\s*\|\s*Wildberries\s*$/i]],
  [/market\.yandex\.ru/i,   [/\s*[-–—]\s*(?:купить|заказать).*/i, /\s*[-–—]\s*Яндекс.*/i]],
  [/lamoda\.ru/i,           [/\s*[-–—]\s*(?:купить|заказать).*/i, /\s*\|\s*Lamoda\s*$/i]],
  [/goldapple\.ru/i,        [/\s*[-–—]\s*(?:купить|заказать).*/i, /\s*\|\s*Золотое яблоко\s*$/i]],
  [/tehnopark\.ru/i,        [/\s*[-–—]\s*(?:купить|заказать).*/i, /\s*[-–—]\s*Технопарк\s*$/i]],
  [/bork\.ru/i,             [/\s*[-–—]\s*(?:купить|заказать).*/i, /\s*\|\s*BORK\s*$/i]],
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
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  try { return new URL(url, base).href; } catch { return null; }
}

function formatNumber(n: number): string {
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatPrice(raw: string, currency?: string | null): string {
  const cleaned = raw.replace(/\s/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  if (isNaN(num) || num <= 0) return raw;
  const formatted = num.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  const cur = (currency ?? '').toUpperCase();
  if (!cur || cur === 'RUB' || cur === 'RUR') return `${formatted} ₽`;
  if (cur === 'USD') return `$${formatted}`;
  if (cur === 'EUR') return `€${formatted}`;
  return `${formatted} ${cur}`;
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
