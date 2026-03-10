/**
 * URL Parser Module — extracts product metadata from URLs
 *
 * Architecture:
 *   parseUrl(rawUrl)
 *     ├─ validateUrl(rawUrl)       — security checks
 *     ├─ fetchHtml(url)            — safe fetch with limits
 *     ├─ extractUniversalMeta(html) — OG tags + <title> + meta description
 *     ├─ extractJsonLd(html)       — JSON-LD Product structured data
 *     ├─ tryDomainAdapter(html, hostname) — domain-specific overrides
 *     └─ merge(universal, jsonLd, domain) — domain > jsonLd > universal
 *
 * Graceful fallback at every level — always returns ParsedUrlData.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ParsedUrlData {
  title: string | null;
  description: string | null;
  priceText: string | null;
  imageUrl: string | null;
  sourceDomain: string;
  canonicalUrl: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 8_000;
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_REDIRECTS = 5;
const MAX_URL_LENGTH = 2048;

const USER_AGENT =
  'Mozilla/5.0 (compatible; WishBoardBot/1.0; +https://wishlistik.ru)';

/** Tracking query parameters to strip */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'yclid', 'gclid', 'fbclid', 'srsltid', 'ref', '_openstat',
  'from', 'etext', 'ysclid',
]);

/** Private/reserved IP ranges */
const BLOCKED_HOSTNAMES = new Set([
  'localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]',
]);

// ─── Main Entry Point ────────────────────────────────────────────────────────

export async function parseUrl(rawUrl: string): Promise<ParsedUrlData> {
  const url = validateUrl(rawUrl);
  const hostname = url.hostname.replace(/^www\./, '');
  const canonicalUrl = canonicalize(url);

  let html: string;
  try {
    html = await fetchHtml(url.href);
  } catch (err) {
    // Fetch failed — return domain-only fallback
    return {
      title: null,
      description: null,
      priceText: null,
      imageUrl: null,
      sourceDomain: hostname,
      canonicalUrl,
    };
  }

  // Layer 1: Universal OG/meta tags
  const universal = extractUniversalMeta(html, url.href);

  // Layer 2: JSON-LD structured data
  const jsonLd = extractJsonLd(html);

  // Layer 3: Domain-specific adapter
  const domain = tryDomainAdapter(html, hostname);

  // Merge: domain > jsonLd > universal
  const merged = mergeParsed(universal, jsonLd, domain);

  return {
    ...merged,
    sourceDomain: hostname,
    canonicalUrl,
  };
}

// ─── URL Validation ──────────────────────────────────────────────────────────

export function validateUrl(raw: string): URL {
  if (!raw || raw.length > MAX_URL_LENGTH) {
    throw new Error('URL слишком длинный или пустой');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Некорректный URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Поддерживаются только http и https ссылки');
  }

  const hostname = url.hostname.toLowerCase();

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error('Ссылка на локальный адрес недоступна');
  }

  // Block private IP ranges
  if (isPrivateIP(hostname)) {
    throw new Error('Ссылка на внутренний адрес недоступна');
  }

  return url;
}

function isPrivateIP(hostname: string): boolean {
  // IPv4 private ranges
  const parts = hostname.split('.');
  if (parts.length === 4 && parts.every(p => /^\d+$/.test(p))) {
    const first = parseInt(parts[0]!, 10);
    const second = parseInt(parts[1]!, 10);
    if (first === 10) return true;
    if (first === 172 && second >= 16 && second <= 31) return true;
    if (first === 192 && second === 168) return true;
    if (first === 169 && second === 254) return true; // link-local
    if (first === 0) return true;
  }
  return false;
}

// ─── URL Canonicalization ────────────────────────────────────────────────────

function canonicalize(url: URL): string {
  const cleaned = new URL(url.href);
  for (const param of [...cleaned.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(param.toLowerCase())) {
      cleaned.searchParams.delete(param);
    }
  }
  // Remove trailing hash if empty
  let result = cleaned.toString();
  if (result.endsWith('#')) result = result.slice(0, -1);
  return result;
}

// ─── Safe HTML Fetch ─────────────────────────────────────────────────────────

async function fetchHtml(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      throw new Error(`Not HTML: ${contentType}`);
    }

    // Read with size limit
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');

    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      chunks.push(value);
      if (totalBytes >= MAX_HTML_BYTES) {
        reader.cancel();
        break;
      }
    }

    const decoder = new TextDecoder('utf-8', { fatal: false });
    return decoder.decode(concatUint8Arrays(chunks));
  } finally {
    clearTimeout(timeout);
  }
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, a) => sum + a.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.byteLength;
  }
  return result;
}

// ─── Universal OG/Meta Parser ────────────────────────────────────────────────

interface UniversalMeta {
  title: string | null;
  description: string | null;
  image: string | null;
  price: string | null;
  currency: string | null;
}

function extractUniversalMeta(html: string, baseUrl: string): UniversalMeta {
  const ogTitle = extractMeta(html, 'og:title');
  const ogDesc = extractMeta(html, 'og:description');
  const ogImage = extractMeta(html, 'og:image');
  const ogPriceAmount = extractMeta(html, 'product:price:amount')
    ?? extractMeta(html, 'og:price:amount');
  const ogPriceCurrency = extractMeta(html, 'product:price:currency')
    ?? extractMeta(html, 'og:price:currency');

  // Fallbacks
  const titleTag = extractTitleTag(html);
  const metaDesc = extractMetaName(html, 'description');

  const title = ogTitle || titleTag || null;
  const description = ogDesc || metaDesc || null;
  let image = ogImage || null;

  // Resolve relative image URLs
  if (image && !image.startsWith('http')) {
    try {
      image = new URL(image, baseUrl).href;
    } catch { /* keep as-is */ }
  }

  return {
    title: title ? decodeHtmlEntities(title).trim() : null,
    description: description ? decodeHtmlEntities(description).trim().slice(0, 500) : null,
    image,
    price: ogPriceAmount || null,
    currency: ogPriceCurrency || null,
  };
}

/** Extract <meta property="X" content="..."> */
function extractMeta(html: string, property: string): string | null {
  // Match both property= and name= attributes, content before or after
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${escapeRegex(property)}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${escapeRegex(property)}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** Extract <meta name="X" content="..."> */
function extractMetaName(html: string, name: string): string | null {
  const patterns = [
    new RegExp(`<meta[^>]+name=["']${escapeRegex(name)}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${escapeRegex(name)}["']`, 'i'),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** Extract <title>...</title> */
function extractTitleTag(html: string): string | null {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m?.[1]?.trim() || null;
}

// ─── JSON-LD Extractor ───────────────────────────────────────────────────────

interface JsonLdProduct {
  name: string | null;
  description: string | null;
  image: string | null;
  price: string | null;
  currency: string | null;
}

function extractJsonLd(html: string): JsonLdProduct | null {
  // Find all <script type="application/ld+json"> blocks
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(html)) !== null) {
    try {
      const raw = match[1]?.trim();
      if (!raw) continue;

      const data = JSON.parse(raw);
      const product = findProductInJsonLd(data);
      if (product) return product;
    } catch {
      // Invalid JSON — skip
    }
  }
  return null;
}

function findProductInJsonLd(data: any): JsonLdProduct | null {
  if (!data) return null;

  // Handle @graph array
  if (data['@graph'] && Array.isArray(data['@graph'])) {
    for (const item of data['@graph']) {
      const found = findProductInJsonLd(item);
      if (found) return found;
    }
    return null;
  }

  // Handle array of items
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findProductInJsonLd(item);
      if (found) return found;
    }
    return null;
  }

  // Check if this is a Product
  const type = data['@type'];
  const isProduct =
    type === 'Product' ||
    (Array.isArray(type) && type.includes('Product'));

  if (!isProduct) return null;

  // Extract product data
  let price: string | null = null;
  let currency: string | null = null;

  const offers = data.offers;
  if (offers) {
    const offer = Array.isArray(offers) ? offers[0] : offers;
    price = String(offer?.price ?? offer?.lowPrice ?? '');
    currency = offer?.priceCurrency ?? null;
    if (!price) price = null;
  }

  let image: string | null = null;
  if (data.image) {
    if (typeof data.image === 'string') {
      image = data.image;
    } else if (Array.isArray(data.image)) {
      image = typeof data.image[0] === 'string' ? data.image[0] : data.image[0]?.url ?? null;
    } else if (data.image.url) {
      image = data.image.url;
    }
  }

  return {
    name: data.name ? String(data.name).trim() : null,
    description: data.description ? String(data.description).trim().slice(0, 500) : null,
    image,
    price,
    currency,
  };
}

// ─── Domain Adapters ─────────────────────────────────────────────────────────

interface DomainResult {
  title?: string | null;
  description?: string | null;
  image?: string | null;
  price?: string | null;
}

function tryDomainAdapter(html: string, hostname: string): DomainResult | null {
  // Normalize hostname
  const h = hostname.replace(/^www\./, '').replace(/^m\./, '');

  if (h === 'ozon.ru' || h.endsWith('.ozon.ru')) {
    return ozonAdapter(html);
  }
  if (h === 'wildberries.ru' || h.endsWith('.wildberries.ru')) {
    return wildberriesAdapter(html);
  }
  if (h === 'market.yandex.ru' || h.endsWith('.market.yandex.ru')) {
    return yandexMarketAdapter(html);
  }

  return null;
}

/**
 * Ozon adapter
 * Ozon heavily uses JSON-LD Product, so this mostly enhances/fixes JSON-LD data.
 * Also tries to find price in specific patterns when JSON-LD fails.
 */
function ozonAdapter(html: string): DomainResult | null {
  const result: DomainResult = {};

  // Ozon sometimes puts price in a specific data attribute or webState
  // Try to extract from the page's OG tags which are usually reliable on Ozon
  const ogTitle = extractMeta(html, 'og:title');
  if (ogTitle) {
    // Ozon OG title often includes price like "Name - купить за 1 234 ₽"
    const priceMatch = ogTitle.match(/(?:за|от)\s*([\d\s]+)\s*₽/);
    if (priceMatch?.[1]) {
      result.price = priceMatch[1].replace(/\s/g, '');
    }
    // Clean title — remove " - купить ..." suffix
    const cleanTitle = ogTitle
      .replace(/\s*[-–—]\s*(?:купить|заказать).*$/i, '')
      .replace(/\s*\|\s*OZON$/i, '')
      .trim();
    if (cleanTitle) result.title = cleanTitle;
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Wildberries adapter
 * WB uses OG tags + JSON-LD. OG description often has price info.
 */
function wildberriesAdapter(html: string): DomainResult | null {
  const result: DomainResult = {};

  const ogTitle = extractMeta(html, 'og:title');
  if (ogTitle) {
    // WB OG title: "Product Name - купить по цене 1234 ₽ в Wildberries"
    const cleanTitle = ogTitle
      .replace(/\s*[-–—]\s*(?:купить|заказать).*$/i, '')
      .replace(/\s*\|\s*Wildberries$/i, '')
      .trim();
    if (cleanTitle) result.title = cleanTitle;

    const priceMatch = ogTitle.match(/(?:цен[еуы]|за)\s*([\d\s]+)\s*₽/);
    if (priceMatch?.[1]) {
      result.price = priceMatch[1].replace(/\s/g, '');
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Yandex Market adapter
 * Uses JSON-LD Product primarily. OG title may need cleaning.
 */
function yandexMarketAdapter(html: string): DomainResult | null {
  const result: DomainResult = {};

  const ogTitle = extractMeta(html, 'og:title');
  if (ogTitle) {
    // Yandex Market: "Product Name — купить по выгодной цене на Яндекс Маркете"
    const cleanTitle = ogTitle
      .replace(/\s*[-–—]\s*(?:купить|заказать).*$/i, '')
      .replace(/\s*[-–—]\s*Яндекс.*$/i, '')
      .trim();
    if (cleanTitle) result.title = cleanTitle;
  }

  return Object.keys(result).length > 0 ? result : null;
}

// ─── Merge Logic ─────────────────────────────────────────────────────────────

function mergeParsed(
  universal: UniversalMeta,
  jsonLd: JsonLdProduct | null,
  domain: DomainResult | null,
): Omit<ParsedUrlData, 'sourceDomain' | 'canonicalUrl'> {
  // Priority: domain > jsonLd > universal
  const title =
    domain?.title ??
    jsonLd?.name ??
    universal.title ??
    null;

  const description =
    domain?.description ??
    jsonLd?.description ??
    universal.description ??
    null;

  const imageUrl =
    domain?.image ??
    jsonLd?.image ??
    universal.image ??
    null;

  // Price: try domain, then jsonLd, then universal
  const rawPrice =
    domain?.price ??
    jsonLd?.price ??
    universal.price ??
    null;

  let priceText: string | null = null;
  if (rawPrice) {
    priceText = formatPrice(rawPrice, jsonLd?.currency ?? universal.currency);
  }

  return { title, description, priceText, imageUrl };
}

/**
 * Format price: "1234" → "1 234 ₽" or "1234.50 USD" → "1 234.50 USD"
 */
function formatPrice(raw: string, currency?: string | null): string {
  // Remove spaces and normalize
  const cleaned = raw.replace(/\s/g, '').replace(',', '.');
  const num = parseFloat(cleaned);
  if (isNaN(num)) return raw;

  // Format with spaces
  const formatted = num.toLocaleString('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });

  if (!currency || currency === 'RUB' || currency === 'RUR') {
    return `${formatted} ₽`;
  }
  return `${formatted} ${currency}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)));
}
