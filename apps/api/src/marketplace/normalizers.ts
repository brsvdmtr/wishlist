/**
 * marketplace/normalizers.ts — URL normalization and marketplace ID extraction
 *
 * Responsibilities:
 *   1. Detect which marketplace a URL belongs to
 *   2. Extract the product ID from the URL
 *   3. Canonicalize the URL (strip tracking params, normalize host)
 *   4. Provide canonical product URLs for cache key deduplication
 */

import type { MarketplaceId, NormalizedUrl } from './types.js';

// ─── Tracking Parameters to Strip ────────────────────────────────────────────

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'yclid', 'gclid', 'fbclid', 'srsltid', 'ref', '_openstat',
  'from', 'etext', 'ysclid', 'roistat_visit',
  // Marketplace-specific tracking
  'spm', 'pvid', 'scm', 'scenario',       // Ozon
  'src', 'clid', 'distr_type', 'lr', 'rs', // Yandex Market
  'targetUrl', 'source',                     // Wildberries
]);

// ─── Marketplace Host Patterns ───────────────────────────────────────────────

interface MarketplacePattern {
  id: MarketplaceId;
  /** Exact hostnames (after www/m stripping) */
  hosts: string[];
  /** Extract product ID from URL, or null */
  extractProductId: (url: URL) => string | null;
  /** Additional marketplace-specific params to strip */
  stripParams?: string[];
}

const MARKETPLACE_PATTERNS: MarketplacePattern[] = [
  {
    id: 'wildberries',
    hosts: ['wildberries.ru'],
    extractProductId: (url) => {
      // /catalog/123456789/detail.aspx or /catalog/123456789/
      const m = url.pathname.match(/\/catalog\/(\d{6,12})(?:\/|$)/);
      if (m) return m[1]!;
      // Short URL: /123456789
      const m2 = url.pathname.match(/^\/(\d{6,12})(?:\/|$)/);
      if (m2) return m2[1]!;
      return null;
    },
    stripParams: ['targetUrl', 'source', 'size', 'sort', 'page'],
  },
  {
    id: 'ozon',
    hosts: ['ozon.ru'],
    extractProductId: (url) => {
      // /product/slug-123456789/ or /product/123456789/
      const m = url.pathname.match(/\/product\/(?:.*?-)?(\d{6,15})(?:\/|$)/);
      if (m) return m[1]!;
      return null;
    },
    stripParams: ['asb', 'asb2', 'avtc', 'avte', 'avts', 'sh', 'miniapp'],
  },
  {
    id: 'yandex_market',
    hosts: ['market.yandex.ru'],
    extractProductId: (url) => {
      // /product--slug/12345 or /product/12345
      const m = url.pathname.match(/\/product(?:--[^/]+)?\/(\d{5,15})(?:\/|$)/);
      if (m) return m[1]!;
      // /offer/12345
      const m2 = url.pathname.match(/\/offer\/(\d{5,15})(?:\/|$)/);
      if (m2) return m2[1]!;
      // SKU in query param
      const sku = url.searchParams.get('sku');
      if (sku && /^\d{5,15}$/.test(sku)) return sku;
      return null;
    },
    stripParams: ['src', 'clid', 'distr_type', 'lr', 'rs', 'do-hierarchical-waremd5', 'cpc'],
  },
  {
    id: 'goldapple',
    hosts: ['goldapple.ru'],
    extractProductId: (url) => {
      // /product/slug-19000123456 (numeric suffix)
      const m = url.pathname.match(/\/product\/(?:.*?-)(\d{8,15})(?:\/|$)/);
      if (m) return m[1]!;
      // /product/19000123456
      const m2 = url.pathname.match(/\/product\/(\d{8,15})(?:\/|$)/);
      if (m2) return m2[1]!;
      return null;
    },
  },
  {
    id: 'lamoda',
    hosts: ['lamoda.ru'],
    extractProductId: (url) => {
      // /p/ABCD1234567/ (alphanumeric SKU)
      const m = url.pathname.match(/\/p\/([A-Za-z0-9]{5,20})(?:\/|$)/);
      if (m) return m[1]!;
      return null;
    },
  },
  {
    id: 'tehnopark',
    hosts: ['tehnopark.ru'],
    extractProductId: (url) => {
      // Tehnopark uses slug-based URLs, not numeric IDs
      const m = url.pathname.match(/\/product\/(\d+)(?:\/|$)/);
      if (m) return m[1]!;
      return null;
    },
  },
  {
    id: 'bork',
    hosts: ['bork.ru'],
    extractProductId: (url) => {
      const m = url.pathname.match(/\/catalog\/(?:.*?\/)([A-Z0-9]+)(?:\/|$)/);
      if (m) return m[1]!;
      return null;
    },
  },
];

// ─── Main Normalizer ─────────────────────────────────────────────────────────

/**
 * Normalize a URL: detect marketplace, extract product ID, canonicalize.
 */
export function normalizeUrl(url: URL): NormalizedUrl {
  const hostname = stripHostPrefix(url.hostname);
  const pattern  = detectMarketplace(hostname);

  const marketplace = pattern?.id ?? 'unknown';
  const productId   = pattern?.extractProductId(url) ?? null;
  const canonicalUrl = canonicalize(url, pattern);

  return { marketplace, productId, canonicalUrl, url };
}

/**
 * Detect marketplace from hostname.
 */
export function detectMarketplace(hostname: string): MarketplacePattern | null {
  const h = stripHostPrefix(hostname);
  for (const pattern of MARKETPLACE_PATTERNS) {
    for (const host of pattern.hosts) {
      if (h === host || h.endsWith(`.${host}`)) return pattern;
    }
  }
  return null;
}

/**
 * Check if a hostname belongs to a known marketplace.
 */
export function isKnownMarketplace(hostname: string): boolean {
  return detectMarketplace(hostname) !== null;
}

/**
 * Get the marketplace ID for a hostname.
 */
export function getMarketplaceId(hostname: string): MarketplaceId {
  return detectMarketplace(hostname)?.id ?? 'unknown';
}

// ─── Wildberries Helpers ─────────────────────────────────────────────────────

/**
 * Build a WB card API URL from a product nm ID.
 */
export function buildWbCardApiUrl(nm: string): string {
  return `https://card.wb.ru/cards/v2/detail?appType=1&curr=rub&dest=-1257786&nm=${nm}`;
}

/**
 * Build a canonical WB product URL from nm.
 */
export function buildWbCanonicalUrl(nm: string): string {
  return `https://www.wildberries.ru/catalog/${nm}/detail.aspx`;
}

// ─── Ozon Helpers ────────────────────────────────────────────────────────────

/**
 * Build a canonical Ozon product URL from product ID.
 */
export function buildOzonCanonicalUrl(productId: string): string {
  return `https://www.ozon.ru/product/${productId}/`;
}

// ─── Yandex Market Helpers ───────────────────────────────────────────────────

/**
 * Build a canonical Yandex Market URL from product ID.
 */
export function buildYmCanonicalUrl(productId: string): string {
  return `https://market.yandex.ru/product/${productId}`;
}

// ─── Canonicalization ────────────────────────────────────────────────────────

function canonicalize(url: URL, pattern: MarketplacePattern | null): string {
  // WB shortcut: if we have a product ID, always return a deterministic canonical
  // URL.  This prevents tracking params like targetUrl=MI from splitting the cache.
  if (pattern?.id === 'wildberries') {
    const productId = pattern.extractProductId(url);
    if (productId) return buildWbCanonicalUrl(productId);
  }

  const c = new URL(url.href);

  // Strip common tracking params (case-insensitive match)
  for (const p of [...c.searchParams.keys()]) {
    if (TRACKING_PARAMS.has(p.toLowerCase())) c.searchParams.delete(p);
  }

  // Strip marketplace-specific params (case-insensitive match)
  if (pattern?.stripParams) {
    const stripLower = new Set(pattern.stripParams.map(s => s.toLowerCase()));
    for (const p of [...c.searchParams.keys()]) {
      if (stripLower.has(p.toLowerCase())) c.searchParams.delete(p);
    }
  }

  let s = c.toString();
  if (s.endsWith('#')) s = s.slice(0, -1);
  return s;
}

// ─── Host Helpers ────────────────────────────────────────────────────────────

/**
 * Strip www. and m. prefixes from hostname.
 */
export function stripHostPrefix(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
}
