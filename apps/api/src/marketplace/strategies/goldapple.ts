/**
 * marketplace/strategies/goldapple.ts — Gold Apple hybrid strategy
 *
 * Strategy pipeline:
 *   1. HTTP fetch + JSON-LD — Gold Apple has good structured data
 *   2. Browser fallback — for when HTTP fetch gets blocked
 *   3. DOM fallback — CSS selectors for price and title
 *
 * GA-specific knowledge:
 *   - Next.js-based, __NEXT_DATA__ often has product data
 *   - Good JSON-LD Product markup
 *   - Price selectors vary: ProductPage__price, product-price, itemprop="price"
 *   - Product IDs: /product/slug-19000123456
 */

import type { ParseStrategy, ParseContext, StrategyResult, FieldValue, PriceData } from '../types.js';
import {
  titleField,
  priceField,
  imageField,
  descriptionField,
} from '../scoring.js';
import { isGarbageTitle } from '../guards.js';
import { fetchHtml } from '../browser-provider.js';

// ─── Strategy 1: HTTP Fetch + JSON-LD ────────────────────────────────────────

export const goldappleHttpStrategy: ParseStrategy = {
  name: 'ga_http',

  async execute(ctx: ParseContext): Promise<StrategyResult | null> {
    const startTime = Date.now();

    try {
      const html = await fetchHtml(ctx.url.href);
      ctx.html = html;

      // Extract JSON-LD first (highest value from HTTP)
      const cheerio = await import('cheerio');
      const $ = cheerio.load(html);

      return extractGoldAppleFromDom($, html, 'ga_http', startTime);
    } catch (err) {
      return makeError('ga_http', startTime, (err as Error).message);
    }
  },
};

// ─── Strategy 2: DOM Fallback (if HTML already available from browser) ───────

export const goldappleDomStrategy: ParseStrategy = {
  name: 'ga_dom',

  async execute(ctx: ParseContext): Promise<StrategyResult | null> {
    if (!ctx.html) return null;

    const startTime = Date.now();

    try {
      const cheerio = await import('cheerio');
      const $ = cheerio.load(ctx.html);
      return extractGoldAppleFromDom($, ctx.html, 'ga_dom', startTime);
    } catch (err) {
      return makeError('ga_dom', startTime, (err as Error).message);
    }
  },
};

// ─── Shared DOM Extraction ───────────────────────────────────────────────────

function extractGoldAppleFromDom(
  $: ReturnType<typeof import('cheerio').load>,
  html: string,
  strategyName: string,
  startTime: number,
): StrategyResult {
  let title: FieldValue<string> | null = null;
  let price: FieldValue<PriceData> | null = null;
  let image: FieldValue<string> | null = null;
  let description: FieldValue<string> | null = null;

  // ── JSON-LD extraction (best source for GA) ──────────────────────────
  const jsonLd = extractJsonLdProduct($);
  if (jsonLd) {
    if (jsonLd.name && !isGarbageTitle(jsonLd.name)) {
      title = titleField(jsonLd.name, 'jsonld', 5);
    }
    if (jsonLd.price && jsonLd.price > 0) {
      price = priceField(jsonLd.price, jsonLd.currency ?? 'RUB', 'jsonld', 5);
    }
    if (jsonLd.image) {
      image = imageField(jsonLd.image, 'jsonld', 5);
    }
    if (jsonLd.description) {
      description = descriptionField(jsonLd.description, 'jsonld', 5);
    }
  }

  // ── DOM selectors (fallback) ─────────────────────────────────────────
  if (!title) {
    const nameEl = $('[class*="ProductPage__name"]').first().text().trim()
                || $('h1').first().text().trim();
    if (nameEl && !isGarbageTitle(nameEl)) {
      title = titleField(nameEl, 'dom_selector', 5);
    }
  }

  if (!title) {
    const ogTitle = $('meta[property="og:title"]').attr('content')?.trim();
    if (ogTitle) {
      const cleaned = ogTitle
        .replace(/\s*[-–—]\s*(?:купить|заказать).*/i, '')
        .replace(/\s*\|\s*Золотое яблоко\s*$/i, '')
        .trim();
      if (cleaned && !isGarbageTitle(cleaned)) {
        title = titleField(cleaned, 'og_meta');
      }
    }
  }

  if (!price) {
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
        if (m?.[1]) {
          const amount = parseInt(m[1]!.replace(/\s/g, ''), 10);
          if (amount > 0 && amount < 10_000_000) {
            price = priceField(amount, 'RUB', 'dom_selector');
            break;
          }
        }
      }
    }
  }

  if (!price) {
    const metaPrice = $('meta[property="product:price:amount"]').attr('content');
    if (metaPrice) {
      const amount = parseFloat(metaPrice);
      if (amount > 0) {
        const cur = $('meta[property="product:price:currency"]').attr('content') ?? 'RUB';
        price = priceField(amount, cur, 'og_meta');
      }
    }
  }

  if (!image) {
    const ogImage = $('meta[property="og:image"]').attr('content')?.trim();
    if (ogImage) {
      image = imageField(ogImage, 'og_meta');
    }
  }

  if (!description) {
    const ogDesc = $('meta[property="og:description"]').attr('content')?.trim();
    if (ogDesc) {
      description = descriptionField(ogDesc, 'og_meta');
    }
  }

  return {
    title, description, price, image,
    strategyName,
    durationMs: Date.now() - startTime,
  };
}

// ─── JSON-LD Helper ──────────────────────────────────────────────────────────

interface JsonLdResult {
  name: string | null;
  description: string | null;
  price: number | null;
  currency: string | null;
  image: string | null;
}

function extractJsonLdProduct($: ReturnType<typeof import('cheerio').load>): JsonLdResult | null {
  const scripts = $('script[type="application/ld+json"]');
  for (let i = 0; i < scripts.length; i++) {
    try {
      const raw = $(scripts[i]).html()?.trim();
      if (!raw) continue;
      const data = JSON.parse(raw) as Record<string, unknown>;
      const product = findProduct(data);
      if (product) return product;
    } catch { /* skip */ }
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findProduct(data: any): JsonLdResult | null {
  if (!data) return null;
  if (data['@graph'] && Array.isArray(data['@graph'])) {
    for (const item of data['@graph']) {
      const r = findProduct(item);
      if (r) return r;
    }
    return null;
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      const r = findProduct(item);
      if (r) return r;
    }
    return null;
  }

  const type = data['@type'];
  if (!(type === 'Product' || (Array.isArray(type) && type.includes('Product')))) return null;

  let price: number | null = null;
  let currency: string | null = null;
  const offers = data.offers;
  if (offers) {
    const offer = Array.isArray(offers) ? offers[0] : offers;
    const rawPrice = offer?.price ?? offer?.lowPrice;
    if (rawPrice != null) {
      price = typeof rawPrice === 'number' ? rawPrice : parseFloat(String(rawPrice));
      if (isNaN(price) || price <= 0) price = null;
    }
    currency = offer?.priceCurrency ?? null;
  }

  let image: string | null = null;
  if (typeof data.image === 'string') image = data.image;
  else if (Array.isArray(data.image) && data.image.length > 0) {
    image = typeof data.image[0] === 'string' ? data.image[0] : data.image[0]?.url ?? null;
  } else if (data.image?.url) image = data.image.url;

  return {
    name: data.name ? String(data.name).trim() : null,
    description: data.description ? String(data.description).trim().slice(0, 500) : null,
    price,
    currency,
    image,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeError(strategyName: string, startTime: number, error: string): StrategyResult {
  return {
    title: null, description: null, price: null, image: null,
    strategyName, durationMs: Date.now() - startTime, error,
  };
}

// ─── All GA Strategies (ordered) ─────────────────────────────────────────────

export const goldappleStrategies: ParseStrategy[] = [
  goldappleHttpStrategy,
  goldappleDomStrategy,
];
