/**
 * URL Parser Module — product card metadata extraction
 *
 * Pipeline:
 *   parseUrl(rawUrl)
 *     ├─ validateUrl + canonicalize
 *     ├─ Cache check (24h success / 5min negative)
 *     ├─ WB shortcut: card.wb.ru JSON API (no browser needed)
 *     ├─ Fast path: fetchHtml → Cheerio → domain adapter
 *     │    └─ if confidence < medium → browser fallback
 *     └─ Browser path: stealth puppeteer → Cheerio → domain adapter
 *
 * Domain adapters: Ozon, Wildberries, Yandex Market, Lamoda,
 *                  Goldapple, Техпарк, Bork  (+generic)
 *
 * Anti-bot detection prevents saving captcha/challenge pages as results.
 * In-memory LRU cache (1 000 entries, 24 h TTL) avoids re-fetching.
 */

import * as cheerio from 'cheerio';
import puppeteer, { type Browser } from 'puppeteer-core';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ParsedUrlData {
  title: string | null;
  description: string | null;
  priceText: string | null;
  imageUrl: string | null;
  sourceDomain: string;
  canonicalUrl: string;
  /** How reliable the result is */
  confidence?: 'high' | 'medium' | 'low' | 'none';
  /** Which extraction path produced the result */
  parseMethod?: 'domain_api' | 'domain_adapter' | 'generic_jsonld' | 'generic_html' | 'browser_fallback';
}

interface ParseResult {
  title: string | null;
  description: string | null;
  priceText: string | null;
  imageUrl: string | null;
  confidence: 'high' | 'medium' | 'low' | 'none';
  parseMethod: 'domain_api' | 'domain_adapter' | 'generic_jsonld' | 'generic_html' | 'browser_fallback';
}

// ─── Constants ───────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS   = 8_000;
const BROWSER_TIMEOUT_MS = 25_000;
const MAX_HTML_BYTES     = 3 * 1024 * 1024; // 3 MB
const MAX_URL_LENGTH     = 2_048;
const BROWSER_IDLE_MS    = 90_000; // close after 90 s idle

const CACHE_TTL_MS          = 24 * 60 * 60 * 1_000; // 24 h
const NEGATIVE_CACHE_TTL_MS =  5 * 60 * 1_000;      //  5 min
const MAX_CACHE_ENTRIES      = 1_000;

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

/** User-agent that most CDNs/marketplaces accept */
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
]);

/** Domains that always require browser rendering */
const BROWSER_FIRST_DOMAINS = new Set([
  'ozon.ru',
  'market.yandex.ru',
]);

// ─── In-Memory Cache ─────────────────────────────────────────────────────────

interface CacheEntry {
  data: ParsedUrlData;
  expiresAt: number;
}

const resultCache   = new Map<string, CacheEntry>();
const negativeCache = new Map<string, number>(); // url → expiresAt

function cacheGet(key: string): ParsedUrlData | null {
  const entry = resultCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { resultCache.delete(key); return null; }
  return entry.data;
}

function cacheSet(key: string, data: ParsedUrlData): void {
  // Evict oldest entry if at capacity
  if (resultCache.size >= MAX_CACHE_ENTRIES) {
    const oldest = resultCache.keys().next().value;
    if (oldest) resultCache.delete(oldest);
  }
  resultCache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
}

function isNegativelyCached(key: string): boolean {
  const exp = negativeCache.get(key);
  if (exp === undefined) return false;
  if (Date.now() > exp) { negativeCache.delete(key); return false; }
  return true;
}

function setNegativeCache(key: string): void {
  negativeCache.set(key, Date.now() + NEGATIVE_CACHE_TTL_MS);
}

// ─── Browser Singleton ───────────────────────────────────────────────────────

let browserInstance: Browser | null = null;
let browserCloseTimer: ReturnType<typeof setTimeout> | null = null;

async function getBrowser(): Promise<Browser> {
  if (browserInstance && browserInstance.connected) {
    if (browserCloseTimer) clearTimeout(browserCloseTimer);
    browserCloseTimer = setTimeout(closeBrowser, BROWSER_IDLE_MS);
    return browserInstance;
  }

  browserInstance = await puppeteer.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-sync',
      '--no-first-run',
      '--single-process',
      '--disable-crash-reporter',
      '--crash-dumps-dir=/tmp/crashes',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  browserCloseTimer = setTimeout(closeBrowser, BROWSER_IDLE_MS);
  return browserInstance;
}

async function closeBrowser(): Promise<void> {
  if (browserCloseTimer) { clearTimeout(browserCloseTimer); browserCloseTimer = null; }
  if (browserInstance) {
    try { await browserInstance.close(); } catch { /* ignore */ }
    browserInstance = null;
  }
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

export async function parseUrl(rawUrl: string): Promise<ParsedUrlData> {
  const url         = validateUrl(rawUrl);
  const hostname    = url.hostname.replace(/^www\./, '').replace(/^m\./, '');
  const canonicalUrl = canonicalize(url);

  // ── Cache check ──────────────────────────────────────────────────────────
  const cached = cacheGet(canonicalUrl);
  if (cached) {
    console.log(`[parser] cache hit: ${hostname}`);
    return cached;
  }
  if (isNegativelyCached(canonicalUrl)) {
    console.log(`[parser] negative cache hit: ${hostname}`);
    return emptyResult(hostname, canonicalUrl);
  }

  let result: ParseResult;

  try {
    // ── Wildberries: dedicated JSON API (fastest, most accurate) ─────────
    if (isWildberries(hostname)) {
      const nm = extractWbArticleId(url);
      if (nm) {
        const wbResult = await fetchWbCardApi(nm);
        if (wbResult && wbResult.confidence !== 'none') {
          result = wbResult;
          console.log(`[parser] WB API success for nm=${nm}: ${result.title?.slice(0, 50)}`);
          const final = buildFinal(result, hostname, canonicalUrl);
          cacheSet(canonicalUrl, final);
          return final;
        }
      }
      // Fall through to browser for WB if API fails
    }

    // ── Browser-first domains (Ozon, Yandex Market) ───────────────────────
    if (isBrowserFirstDomain(hostname)) {
      console.log(`[parser] browser-first: ${hostname}`);
      const html = await fetchWithBrowser(url.href);
      result = extractFromHtml(html, url.href, hostname, 'browser_fallback');
    } else {
      // ── Fast HTTP path ───────────────────────────────────────────────────
      let html: string | null = null;
      try {
        html = await fetchHtml(url.href);
      } catch (err) {
        console.warn(`[parser] HTTP fetch failed for ${hostname}: ${(err as Error).message}`);
      }

      if (html) {
        const fastResult = extractFromHtml(html, url.href, hostname, 'generic_html');
        if (confidenceScore(fastResult.confidence) >= 2) {
          // medium or high — good enough
          result = fastResult;
          console.log(`[parser] fast path OK (${fastResult.confidence}): ${hostname}`);
        } else {
          // Low confidence — try browser
          console.log(`[parser] low confidence on fast path, using browser: ${hostname}`);
          try {
            const browserHtml = await fetchWithBrowser(url.href);
            const browserResult = extractFromHtml(browserHtml, url.href, hostname, 'browser_fallback');
            result = pickBetter(fastResult, browserResult);
          } catch {
            result = fastResult; // use what we have
          }
        }
      } else {
        // HTTP failed entirely — use browser
        console.log(`[parser] HTTP failed, using browser: ${hostname}`);
        const browserHtml = await fetchWithBrowser(url.href);
        result = extractFromHtml(browserHtml, url.href, hostname, 'browser_fallback');
      }
    }

    if (result.confidence === 'none') {
      console.warn(`[parser] no useful data for ${hostname}`);
      setNegativeCache(canonicalUrl);
      return emptyResult(hostname, canonicalUrl);
    }

    const final = buildFinal(result, hostname, canonicalUrl);
    console.log(
      `[parser] ${hostname}: ${result.confidence} / ${result.parseMethod} — ` +
      `title="${result.title?.slice(0, 40)}", price=${result.priceText ?? '-'}, img=${result.imageUrl ? '✓' : '✗'}`
    );
    cacheSet(canonicalUrl, final);
    return final;

  } catch (err) {
    console.error(`[parser] unhandled error for ${hostname}:`, (err as Error).message);
    setNegativeCache(canonicalUrl);
    return emptyResult(hostname, canonicalUrl);
  }
}

// ─── URL Validation ──────────────────────────────────────────────────────────

export function validateUrl(raw: string): URL {
  if (!raw || raw.length > MAX_URL_LENGTH) {
    throw new Error('URL слишком длинный или пустой');
  }

  let url: URL;
  try { url = new URL(raw); } catch {
    throw new Error('Некорректный URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Поддерживаются только http и https ссылки');
  }

  const h = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(h)) throw new Error('Ссылка на локальный адрес недоступна');
  if (isPrivateIP(h))           throw new Error('Ссылка на внутренний адрес недоступна');

  return url;
}

function isPrivateIP(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length === 4 && parts.every(p => /^\d+$/.test(p))) {
    const [a, b] = parts.map(Number) as [number, number];
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }
  return false;
}

// ─── URL Canonicalization ─────────────────────────────────────────────────────

function canonicalize(url: URL): string {
  const c = new URL(url.href);
  for (const p of [...c.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(p.toLowerCase())) c.searchParams.delete(p);
  }
  let s = c.toString();
  if (s.endsWith('#')) s = s.slice(0, -1);
  return s;
}

// ─── Domain Helpers ───────────────────────────────────────────────────────────

function normalizeHost(h: string): string {
  return h.replace(/^www\./, '').replace(/^m\./, '');
}

function isWildberries(h: string): boolean {
  const n = normalizeHost(h);
  return n === 'wildberries.ru' || n.endsWith('.wildberries.ru');
}

function isBrowserFirstDomain(h: string): boolean {
  const n = normalizeHost(h);
  return BROWSER_FIRST_DOMAINS.has(n) || [...BROWSER_FIRST_DOMAINS].some(d => n.endsWith(`.${d}`));
}

function confidenceScore(c: ParseResult['confidence']): number {
  return { none: 0, low: 1, medium: 2, high: 3 }[c];
}

function pickBetter(a: ParseResult, b: ParseResult): ParseResult {
  return confidenceScore(b.confidence) > confidenceScore(a.confidence) ? b : a;
}

function emptyResult(sourceDomain: string, canonicalUrl: string): ParsedUrlData {
  return { title: null, description: null, priceText: null, imageUrl: null,
           sourceDomain, canonicalUrl, confidence: 'none', parseMethod: 'generic_html' };
}

function buildFinal(r: ParseResult, sourceDomain: string, canonicalUrl: string): ParsedUrlData {
  return { ...r, sourceDomain, canonicalUrl };
}

function calcConfidence(r: { title: string | null; imageUrl: string | null; priceText: string | null }): ParseResult['confidence'] {
  const hasTitle = !!r.title;
  const hasImage = !!r.imageUrl;
  const hasPrice = !!r.priceText;
  if (!hasTitle) return 'none';
  if (hasTitle && hasImage && hasPrice) return 'high';
  if (hasTitle && (hasImage || hasPrice)) return 'medium';
  return 'low';
}

// ─── Anti-Bot Detection ───────────────────────────────────────────────────────

function isAntiBotPage(html: string, title: string | null): boolean {
  if (html.length < 800) return true;

  const lTitle = (title ?? '').toLowerCase();
  const badTitles = ['captcha', 'robot', 'challenge', 'antibot', 'access denied',
                     'attention required', 'just a moment', 'проверка'];
  if (badTitles.some(t => lTitle.includes(t))) return true;

  const lHtml = html.toLowerCase();
  const botSignals = [
    'g-recaptcha', 'h-captcha', 'cf_challenge', 'cf-challenge-running',
    'cf_chl_opt', 'cf-please-wait', 'ddos-guard', 'yandex-smartcaptcha',
    'smartcaptcha', 'class="antibot"', '__cf_chl',
  ];
  if (botSignals.some(s => lHtml.includes(s))) return true;

  return false;
}

// ─── HTML Fetch (plain HTTP) ──────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
      throw new Error(`Not HTML: ${ct}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      chunks.push(value);
      if (total >= MAX_HTML_BYTES) { reader.cancel(); break; }
    }

    const buf = new Uint8Array(chunks.reduce((s, c) => s + c.byteLength, 0));
    let off = 0;
    for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
    return new TextDecoder('utf-8', { fatal: false }).decode(buf);
  } finally {
    clearTimeout(timer);
  }
}

// ─── Browser Fetch (stealth Puppeteer) ───────────────────────────────────────

async function fetchWithBrowser(url: string): Promise<string> {
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    // Stealth: mask headless signals
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'plugins',   { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru', 'en-US', 'en'] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).chrome = { runtime: {}, loadTimes: () => {}, csi: () => {} };
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
    });

    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7' });

    // Block heavy resources, keep XHR/fetch for hydration
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['font', 'stylesheet', 'media'].includes(type)) { req.abort(); }
      else { req.continue(); }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: BROWSER_TIMEOUT_MS });

    // Wait for meta title or OG title to be populated
    await page.waitForFunction(
      () => {
        const og = document.querySelector('meta[property="og:title"]');
        const t  = document.querySelector('title');
        return (og && og.getAttribute('content') && og.getAttribute('content')!.length > 3)
            || (t  && t.textContent && t.textContent.length > 3);
      },
      { timeout: 10_000 }
    ).catch(() => { /* timeout OK — use what we have */ });

    // Extra pause for React hydration on SPAs
    await new Promise(r => setTimeout(r, 800));

    return await page.content();
  } finally {
    await page.close().catch(() => {});
  }
}

// ─── Wildberries Card API ─────────────────────────────────────────────────────

function extractWbArticleId(url: URL): string | null {
  // /catalog/12345678/detail.aspx  or  /catalog/12345678/
  const m = url.pathname.match(/\/catalog\/(\d{6,12})\//);
  if (m) return m[1]!;
  // Also handle /product/name-12345678
  const m2 = url.pathname.match(/\/(\d{6,12})(?:\/|$)/);
  if (m2) return m2[1]!;
  return null;
}

/** Moscow basket index for Wildberries image CDN */
function wbBasket(vol: number): string {
  let b: number;
  if (vol <= 143) b = 1;
  else if (vol <= 287) b = 2;
  else if (vol <= 431) b = 3;
  else if (vol <= 719) b = 4;
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
  else b = 17;
  return b.toString().padStart(2, '0');
}

function wbImageUrl(nm: number): string {
  const vol  = Math.floor(nm / 100_000);
  const part = Math.floor(nm / 1_000);
  return `https://basket-${wbBasket(vol)}.wbbasket.ru/vol${vol}/part${part}/${nm}/images/big/1.webp`;
}

async function fetchWbCardApi(nmStr: string): Promise<ParseResult | null> {
  const nm = parseInt(nmStr, 10);
  const apiUrl = `https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=-1257786&nm=${nmStr}`;

  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6_000);

    const res = await fetch(apiUrl, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
        'Origin': 'https://www.wildberries.ru',
        'Referer': `https://www.wildberries.ru/catalog/${nmStr}/detail.aspx`,
      },
    });
    clearTimeout(timer);

    if (!res.ok) {
      console.warn(`[parser] WB API returned ${res.status} for nm=${nmStr}`);
      return null;
    }

    const json = await res.json() as {
      state?: number;
      data?: {
        products?: Array<{
          id: number;
          name?: string;
          salePriceU?: number;
          priceU?: number;
          sizes?: Array<{ price?: { total?: number } }>;
        }>;
      };
    };

    const product = json?.data?.products?.[0];
    if (!product) return null;

    const title = product.name?.trim() ?? null;

    // Price in kopecks → rubles
    const priceKop = product.salePriceU
      ?? product.sizes?.[0]?.price?.total
      ?? product.priceU
      ?? null;
    const priceRub = priceKop ? Math.round(priceKop / 100) : null;
    const priceText = priceRub ? `${formatNumber(priceRub)} ₽` : null;

    const imageUrl = wbImageUrl(nm);

    const r: ParseResult = {
      title,
      description: null,
      priceText,
      imageUrl,
      confidence: calcConfidence({ title, imageUrl, priceText }),
      parseMethod: 'domain_api',
    };
    return r;
  } catch (err) {
    console.warn(`[parser] WB API error for nm=${nmStr}: ${(err as Error).message}`);
    return null;
  }
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

  // --- Universal OG/meta extraction ---
  const ogTitle  = $('meta[property="og:title"]').attr('content')?.trim() ?? null;
  const ogImage  = $('meta[property="og:image"]').attr('content')?.trim() ?? null;
  const ogDesc   = $('meta[property="og:description"]').attr('content')?.trim() ?? null;
  const ogPrice  = ($('meta[property="product:price:amount"]').attr('content')
                 ?? $('meta[property="og:price:amount"]').attr('content'))?.trim() ?? null;
  const ogCur    = ($('meta[property="product:price:currency"]').attr('content')
                 ?? $('meta[property="og:price:currency"]').attr('content'))?.trim() ?? null;

  const titleTag = $('title').first().text().trim() || null;
  const metaDesc = $('meta[name="description"]').attr('content')?.trim() ?? null;

  // Resolve relative image URL
  let resolvedOgImage = ogImage;
  if (resolvedOgImage && !resolvedOgImage.startsWith('http')) {
    try { resolvedOgImage = new URL(resolvedOgImage, baseUrl).href; } catch { /* keep */ }
  }

  const universal = {
    title:  ogTitle ?? titleTag ?? null,
    desc:   ogDesc  ?? metaDesc ?? null,
    image:  resolvedOgImage,
    price:  ogPrice,
    cur:    ogCur,
  };

  // --- Anti-bot check on raw title ---
  if (isAntiBotPage(html, universal.title)) {
    console.warn(`[parser] anti-bot detected for ${hostname}`);
    return { title: null, description: null, priceText: null, imageUrl: null,
             confidence: 'none', parseMethod: defaultMethod };
  }

  // --- JSON-LD extraction ---
  const jsonLd = extractJsonLd($);

  // --- Domain adapter ---
  const domain = tryDomainAdapter($, h, html, baseUrl);

  // --- Merge: domain > jsonLd > universal ---
  const title = cleanTitle(domain?.title ?? jsonLd?.name ?? universal.title ?? null, h);
  const description = (domain?.description ?? jsonLd?.description ?? universal.desc ?? null)
    ?.slice(0, 500) ?? null;
  const imageUrl = resolveUrl(domain?.image ?? jsonLd?.image ?? universal.image ?? null, baseUrl);

  // Price
  const rawPrice = domain?.price ?? jsonLd?.price ?? universal.price ?? null;
  const priceCur = jsonLd?.currency ?? universal.cur ?? null;
  const priceText = rawPrice ? formatPrice(rawPrice, priceCur) : null;

  // Determine parse method
  let parseMethod: ParseResult['parseMethod'] = defaultMethod;
  if (domain)  parseMethod = defaultMethod === 'browser_fallback' ? 'browser_fallback' : 'domain_adapter';
  else if (jsonLd && (jsonLd.name || jsonLd.price)) parseMethod = defaultMethod === 'browser_fallback' ? 'browser_fallback' : 'generic_jsonld';

  const confidence = calcConfidence({ title, imageUrl: imageUrl ?? null, priceText });
  return { title, description, priceText, imageUrl: imageUrl ?? null, confidence, parseMethod };
}

// ─── JSON-LD Extractor ────────────────────────────────────────────────────────

interface JsonLdProduct {
  name: string | null;
  description: string | null;
  image: string | null;
  price: string | null;
  currency: string | null;
}

function extractJsonLd($: cheerio.CheerioAPI): JsonLdProduct | null {
  const scripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    try {
      const raw = $(scripts[i]).html()?.trim();
      if (!raw) continue;
      const data = JSON.parse(raw);
      const product = findProduct(data);
      if (product) return product;
    } catch { /* invalid JSON */ }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findProduct(data: any): JsonLdProduct | null {
  if (!data) return null;

  if (data['@graph'] && Array.isArray(data['@graph'])) {
    for (const item of data['@graph']) {
      const r = findProduct(item); if (r) return r;
    }
    return null;
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      const r = findProduct(item); if (r) return r;
    }
    return null;
  }

  const type = data['@type'];
  const isProduct = type === 'Product' || (Array.isArray(type) && type.includes('Product'));
  if (!isProduct) return null;

  let price: string | null = null;
  let currency: string | null = null;
  const offers = data.offers;
  if (offers) {
    const offer = Array.isArray(offers) ? offers[0] : offers;
    price    = offer?.price != null ? String(offer.price) : (offer?.lowPrice != null ? String(offer.lowPrice) : null);
    currency = offer?.priceCurrency ?? null;
  }

  let image: string | null = null;
  if (typeof data.image === 'string') image = data.image;
  else if (Array.isArray(data.image)) image = typeof data.image[0] === 'string' ? data.image[0] : (data.image[0]?.url ?? null);
  else if (data.image?.url) image = data.image.url;

  return {
    name:        data.name        ? String(data.name).trim()        : null,
    description: data.description ? String(data.description).trim() : null,
    image,
    price,
    currency,
  };
}

// ─── Domain Adapters ──────────────────────────────────────────────────────────

interface DomainData {
  title?: string | null;
  description?: string | null;
  image?: string | null;
  price?: string | null;
}

function tryDomainAdapter(
  $: cheerio.CheerioAPI,
  hostname: string,
  html: string,
  baseUrl: string,
): DomainData | null {
  if (hostname === 'ozon.ru'         || hostname.endsWith('.ozon.ru'))           return ozonAdapter($, html);
  if (hostname === 'wildberries.ru'  || hostname.endsWith('.wildberries.ru'))    return wbHtmlAdapter($, html);
  if (hostname === 'market.yandex.ru'|| hostname.endsWith('.market.yandex.ru')) return yandexMarketAdapter($, html);
  if (hostname === 'lamoda.ru'       || hostname.endsWith('.lamoda.ru'))         return lamodaAdapter($);
  if (hostname === 'goldapple.ru'    || hostname.endsWith('.goldapple.ru'))      return goldappleAdapter($);
  if (hostname === 'tehnopark.ru'    || hostname.endsWith('.tehnopark.ru'))      return tehnoparkAdapter($);
  if (hostname === 'bork.ru'         || hostname.endsWith('.bork.ru'))           return borkAdapter($, baseUrl);
  return null;
}

/**
 * Ozon: deeply SPA-rendered. Best sources are OG tags (populated by SSR) and
 * JSON-LD. Also try to scrape the app hydration state for price.
 */
function ozonAdapter($: cheerio.CheerioAPI, html: string): DomainData | null {
  const result: DomainData = {};

  const ogTitle = $('meta[property="og:title"]').attr('content')?.trim();
  if (ogTitle) {
    result.title = ogTitle
      .replace(/\s*[-–—]\s*(?:купить|заказать)\s+(?:на|в)\s+OZON.*/i, '')
      .replace(/\s*\|\s*OZON\s*$/i, '')
      .trim();
  }

  // Price: try hydration state JSON
  const priceFromHydration = extractOzonPrice(html);
  if (priceFromHydration) result.price = priceFromHydration;

  // Price fallback: DOM selector (Ozon uses data-widget)
  if (!result.price) {
    const priceEl = $('[data-widget="webSalePrice"] span').first().text()
                 || $('[data-widget="webPrice"] span').first().text();
    if (priceEl) {
      const m = priceEl.match(/([\d\s]+)\s*₽/);
      if (m) result.price = m[1]!.replace(/\s/g, '');
    }
  }

  return Object.keys(result).length ? result : null;
}

function extractOzonPrice(html: string): string | null {
  // Ozon stores structured data in multiple script blocks
  const patterns = [
    /"finalPrice"\s*:\s*(\d+)/,
    /"price"\s*:\s*(\d+)/,
    /"originalPrice"\s*:\s*(\d+)/,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) {
      const price = parseInt(m[1]!, 10);
      if (price > 0 && price < 10_000_000) return m[1]!;
    }
  }
  return null;
}

/**
 * Wildberries HTML adapter (fallback when card API fails/unavailable).
 * WB renders OG tags server-side for product pages.
 */
function wbHtmlAdapter($: cheerio.CheerioAPI, html: string): DomainData | null {
  const result: DomainData = {};

  const ogTitle = $('meta[property="og:title"]').attr('content')?.trim();
  if (ogTitle) {
    result.title = ogTitle
      .replace(/\s*[-–—]\s*(?:купить|заказать)\s+(?:по цен[еуы]|за)?.*/i, '')
      .replace(/\s*[-–—]\s*Wildberries\s*$/i, '')
      .replace(/\s*\|\s*Wildberries\s*$/i, '')
      .trim();
    // Sometimes price is embedded in OG title
    const pm = ogTitle.match(/(?:цен[еуы]|за)\s*([\d\s]+)\s*₽/);
    if (pm?.[1]) result.price = pm[1]!.replace(/\s/g, '');
  }

  // Try to find price in script data
  const wbPriceM = html.match(/"price"\s*:\s*(\d+)/);
  if (wbPriceM?.[1] && !result.price) {
    const p = parseInt(wbPriceM[1]!, 10);
    // WB stores prices in both rubles and kopecks in different endpoints
    // Heuristic: if > 50000 and remainder is 00, likely kopecks
    if (p > 50_000 && p % 100 === 0) {
      result.price = String(Math.round(p / 100));
    } else if (p > 0 && p < 1_000_000) {
      result.price = String(p);
    }
  }

  return Object.keys(result).length ? result : null;
}

/**
 * Yandex Market: heavily SPA. JSON-LD Product is usually present after render.
 * OG tags are clean and reliable.
 */
function yandexMarketAdapter($: cheerio.CheerioAPI, _html: string): DomainData | null {
  const result: DomainData = {};

  const ogTitle = $('meta[property="og:title"]').attr('content')?.trim();
  if (ogTitle) {
    result.title = ogTitle
      .replace(/\s*[-–—]\s*(?:купить|заказать).*$/i, '')
      .replace(/\s*[-–—]\s*Яндекс\s*Маркет\s*$/i, '')
      .replace(/\s*[-–—]\s*(?:цены,\s*)?(?:описание|характеристики|отзывы).*$/i, '')
      .trim();
  }

  // YM often has price in specific meta
  const priceM = $('meta[property="yandex_market:price"]').attr('content')
              ?? $('meta[name="price"]').attr('content');
  if (priceM) result.price = priceM;

  return Object.keys(result).length ? result : null;
}

/**
 * Lamoda: SSR fashion store, good OG + JSON-LD.
 * Specific selectors for price.
 */
function lamodaAdapter($: cheerio.CheerioAPI): DomainData | null {
  const result: DomainData = {};

  // Price selectors (Lamoda changes them often, try multiple)
  const priceSelectors = [
    '[class*="product-prices__price_type_discount"]',
    '[class*="product-prices__price"]',
    '[data-testid="price"]',
    '[class*="price__price"]',
    '.x-premium-product-sticky-block__price',
  ];
  for (const sel of priceSelectors) {
    const text = $(sel).first().text().trim();
    if (text) {
      const m = text.match(/([\d\s]+)\s*(?:₽|руб)/);
      if (m?.[1]) { result.price = m[1]!.replace(/\s/g, ''); break; }
    }
  }

  // Brand + product name from specific selectors
  const brand    = $('[data-testid="brand-name"]').first().text().trim();
  const prodName = $('[data-testid="product-name"]').first().text().trim()
                || $('[class*="product-title"]').first().text().trim();
  if (brand && prodName) result.title = `${brand} ${prodName}`;
  else if (prodName) result.title = prodName;

  return Object.keys(result).length ? result : null;
}

/**
 * Goldapple (goldapple.ru): beauty/cosmetics store.
 * Usually has clean OG tags and JSON-LD.
 */
function goldappleAdapter($: cheerio.CheerioAPI): DomainData | null {
  const result: DomainData = {};

  const priceSelectors = [
    '[class*="ProductPage__price"]',
    '[class*="product-price"]',
    '.price__value',
    '[itemprop="price"]',
    '[data-testid="price"]',
  ];
  for (const sel of priceSelectors) {
    const el = $(sel).first();
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

/**
 * Технопарк (tehnopark.ru): electronics store.
 * Good JSON-LD coverage, clean OG tags.
 */
function tehnoparkAdapter($: cheerio.CheerioAPI): DomainData | null {
  const result: DomainData = {};

  const priceSelectors = [
    '[class*="product-buy__price"]',
    '[itemprop="price"]',
    '[class*="price_value"]',
    '.price',
  ];
  for (const sel of priceSelectors) {
    const el   = $(sel).first();
    const text = el.attr('content') ?? el.text().trim();
    if (text) {
      const m = text.replace(/\s/g, '').match(/^(\d+)/);
      if (m?.[1]) { result.price = m[1]!; break; }
    }
  }

  return Object.keys(result).length ? result : null;
}

/**
 * Bork (bork.ru): premium kitchen appliances.
 * Usually has JSON-LD + clean OG tags.
 */
function borkAdapter($: cheerio.CheerioAPI, _baseUrl: string): DomainData | null {
  const result: DomainData = {};

  const priceSelectors = [
    '[class*="product__price"]',
    '[class*="price__value"]',
    '[itemprop="price"]',
    '.product-price',
  ];
  for (const sel of priceSelectors) {
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
  for (const [domainRe, cleanRules] of TITLE_SUFFIXES) {
    if (domainRe.test(hostname)) {
      for (const re of cleanRules) t = t.replace(re, '');
    }
  }
  t = t.trim();
  return t.length > 0 ? t : title.trim() || null;
}

// ─── URL Resolver ─────────────────────────────────────────────────────────────

function resolveUrl(url: string | null | undefined, base: string): string | null {
  if (!url) return null;
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  try { return new URL(url, base).href; } catch { return null; }
}

// ─── Price Formatting ─────────────────────────────────────────────────────────

function formatNumber(n: number): string {
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function formatPrice(raw: string, currency?: string | null): string {
  // Normalize: "12 999", "12,999", "12999.00" → 12999
  const cleaned = raw.replace(/\s/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  if (isNaN(num) || num <= 0) return raw;

  const formatted = num.toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

  const cur = (currency ?? '').toUpperCase();
  if (!cur || cur === 'RUB' || cur === 'RUR') return `${formatted} ₽`;
  if (cur === 'USD') return `$${formatted}`;
  if (cur === 'EUR') return `€${formatted}`;
  return `${formatted} ${cur}`;
}
