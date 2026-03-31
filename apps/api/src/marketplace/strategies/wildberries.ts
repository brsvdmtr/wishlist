/**
 * marketplace/strategies/wildberries.ts — Wildberries multi-strategy parser
 *
 * Strategy pipeline (ordered by priority):
 *   0. Basket CDN (card.json + price-history.json) — static CDN, no anti-bot
 *   1. Search API (search.wb.ru) — fallback for price if CDN missing
 *   2. Browser + network intercept — captures API responses live
 *   3. DOM fallback — Cheerio on rendered HTML
 *
 * WB-specific knowledge:
 *   - card.wb.ru was SHUT DOWN (April 2025, all *.wb.ru domains deprecated)
 *   - search.wb.ru/exactmatch/ru/common/v18/search is the replacement
 *   - Prices in API are in kopecks (÷100 = rubles)
 *   - Product ID = "nm" (article number), 6-12 digits
 *   - CDN image URL formula: basket-XX.wbbasket.ru/volN/partN/nm/images/big/1.webp
 *   - Brand name is in "brand" field, product name in "name"
 */

import type { ParseStrategy, ParseContext, StrategyResult, FieldValue, PriceData } from '../types.js';
import {
  titleField,
  priceField,
  imageField,
  descriptionField,
} from '../scoring.js';
import { isGarbageTitle, isAntiBotPage } from '../guards.js';
import { wbCdnImageUrl, wbCdnBaseUrl } from '../../browser-network-extractor.js';
import { getBrowser } from '../browser-provider.js';
import { browserExtract } from '../../browser-network-extractor.js';
import { networkProductToResult } from './shared-browser.js';
import { parseLog } from '../logger.js';

// ─── Strategy 0: Basket CDN (card.json + price-history.json) ────────────────
// Static CDN files — no anti-bot, no rate limiting, fastest and most reliable.

interface WbCardJson {
  imt_name?: string;
  nm_id?: number;
  description?: string;
  selling?: { brand_name?: string };
  media?: { photo_count?: number };
}

interface WbPriceHistoryEntry {
  dt: number;
  price: { RUB: number };
}

export const wbBasketCdnStrategy: ParseStrategy = {
  name: 'wb_basket_cdn',

  async execute(ctx: ParseContext): Promise<StrategyResult | null> {
    if (!ctx.productId) return null;

    const startTime = Date.now();
    const nm = parseInt(ctx.productId, 10);
    if (nm <= 0 || isNaN(nm)) return null;

    const baseUrl = wbCdnBaseUrl(nm);

    try {
      // Fetch card.json and price-history.json in parallel
      const [cardRes, priceRes] = await Promise.all([
        fetchJson<WbCardJson>(`${baseUrl}/info/ru/card.json`),
        fetchJson<WbPriceHistoryEntry[]>(`${baseUrl}/info/price-history.json`),
      ]);

      if (!cardRes) {
        return makeError('wb_basket_cdn', startTime, 'card.json not found on basket CDN');
      }

      // Title: brand / product name
      let titleStr: string | null = null;
      if (cardRes.imt_name) {
        titleStr = cardRes.selling?.brand_name
          ? `${cardRes.selling.brand_name} / ${cardRes.imt_name.trim()}`
          : cardRes.imt_name.trim();
      }
      const title = titleStr ? titleField(titleStr, 'basket_cdn', 5) : null;

      // Price: last entry in price history (kopecks ÷ 100)
      let price: FieldValue<PriceData> | null = null;
      if (Array.isArray(priceRes) && priceRes.length > 0) {
        const latest = priceRes[priceRes.length - 1]!;
        const amount = Math.round(latest.price.RUB / 100);
        if (amount > 0 && amount < 10_000_000) {
          price = priceField(amount, 'RUB', 'basket_cdn', 5);
        }
      }

      // Image: CDN URL
      const image = imageField(wbCdnImageUrl(nm), 'basket_cdn', 5);

      // Description
      const description = cardRes.description
        ? descriptionField(cardRes.description.trim(), 'basket_cdn', 5)
        : null;

      return {
        title, description, price, image,
        strategyName: 'wb_basket_cdn',
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return makeError('wb_basket_cdn', startTime, (err as Error).message);
    }
  },
};

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  }
}

// ─── Constants ───────────────────────────────────────────────────────────────

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const API_TIMEOUT_MS = 6_000;

/**
 * WB dest profiles for the search API.  Different dest values correspond to
 * different warehouse/delivery regions.  Some products are only visible
 * under certain profiles, so we try several before giving up.
 */
const WB_DEST_PROFILES = [
  '-1257786',       // Moscow (default — covers most items)
  '-1029256,-102269,-2162196,-1257786',  // Multi-region fallback
  '-577683',        // Saint-Petersburg
];

// ─── Strategy 1: Search API (replaces dead card.wb.ru) ──────────────────────

export const wbCardApiStrategy: ParseStrategy = {
  name: 'wb_card_api',

  async execute(ctx: ParseContext): Promise<StrategyResult | null> {
    if (!ctx.productId) return null;

    const startTime = Date.now();
    const nmId = parseInt(ctx.productId, 10);

    // search.wb.ru returns search results; we search by article number
    // and then filter for the exact nmId in the response.
    for (const dest of WB_DEST_PROFILES) {
      const apiUrl = `https://search.wb.ru/exactmatch/ru/common/v18/search`
        + `?appType=1&curr=rub&dest=${dest}&query=${ctx.productId}&resultset=catalog`;

      try {
        const ctrl  = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);

        const res = await fetch(apiUrl, {
          signal: ctrl.signal,
          headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'application/json',
            'Origin': 'https://www.wildberries.ru',
            'Referer': `https://www.wildberries.ru/catalog/${ctx.productId}/detail.aspx`,
          },
        });
        clearTimeout(timer);

        if (!res.ok) continue;  // try next profile

        const ct = res.headers.get('content-type') ?? '';
        if (!ct.includes('json')) continue;  // got HTML anti-bot page

        const json = await res.json() as WbCardApiResponse;
        const products = json?.data?.products;
        if (!Array.isArray(products) || products.length === 0) continue;

        // Find the exact product by nmId (search may return related items)
        const product = products.find(p => p.id === nmId) ?? products[0]!;

        return parseWbProduct(product, startTime);
      } catch {
        continue; // timeout / network error → try next profile
      }
    }

    // All profiles exhausted
    return makeError('wb_card_api', startTime, `No products found via search.wb.ru across ${WB_DEST_PROFILES.length} dest profiles`);
  },
};

// ─── Strategy 2: Browser Network Intercept ───────────────────────────────────

export const wbBrowserStrategy: ParseStrategy = {
  name: 'wb_browser',

  async execute(ctx: ParseContext): Promise<StrategyResult | null> {
    const startTime = Date.now();

    try {
      const browser = await getBrowser();
      const { html, product } = await browserExtract(browser, ctx.url.href, ctx.hostname);

      // Store HTML in context for DOM fallback strategy
      ctx.html = html;

      // ── Diagnostic trail: log what the browser actually saw ──────────
      const hasOgTitle = html.includes('og:title');
      const hasJsonLd  = html.includes('application/ld+json');
      const isCheck    = isAntiBotPage(html, null);
      parseLog.browserDiag(ctx.hostname, 'wildberries', {
        htmlLength: html.length,
        hasOgTitle,
        hasJsonLd,
        isCheckPage: isCheck,
      });

      return networkProductToResult(
        product ? {
          title: product.title,
          description: product.description,
          price: product.rawPrice ? parseFloat(product.rawPrice) : null,
          currency: product.currency,
          imageUrl: product.imageUrl,
          source: product.source,
          score: product.score,
        } : null,
        html,
        'wb_browser',
        startTime,
      );
    } catch (err) {
      return makeError('wb_browser', startTime, (err as Error).message);
    }
  },
};

// ─── Strategy 3: DOM Fallback ────────────────────────────────────────────────

export const wbDomStrategy: ParseStrategy = {
  name: 'wb_dom',

  async execute(ctx: ParseContext): Promise<StrategyResult | null> {
    if (!ctx.html) return null;

    const startTime = Date.now();

    try {
      const cheerio = await import('cheerio');
      const $ = cheerio.load(ctx.html);

      let title: FieldValue<string> | null = null;
      let price: FieldValue<PriceData> | null = null;
      let image: FieldValue<string> | null = null;
      let description: FieldValue<string> | null = null;

      // Title from OG
      const ogTitle = $('meta[property="og:title"]').attr('content')?.trim();
      if (ogTitle) {
        const cleaned = ogTitle
          .replace(/\s*[-–—]\s*(?:купить|заказать).*/i, '')
          .replace(/\s*\|\s*Wildberries\s*$/i, '')
          .trim();
        if (cleaned && !isGarbageTitle(cleaned)) {
          title = titleField(cleaned, 'og_meta');
        }
      }

      // Price from HTML embedded data
      const priceMatch = ctx.html.match(/"salePriceU"\s*:\s*(\d+)/)
                      ?? ctx.html.match(/"price"\s*:\s*(\d+)/);
      if (priceMatch?.[1]) {
        const raw = parseInt(priceMatch[1]!, 10);
        const amount = raw > 50_000 && raw % 100 === 0 ? Math.round(raw / 100) : raw;
        if (amount > 0 && amount < 10_000_000) {
          price = priceField(amount, 'RUB', 'html_regex');
        }
      }

      // Image from OG
      const ogImage = $('meta[property="og:image"]').attr('content')?.trim();
      if (ogImage) {
        image = imageField(ogImage, 'og_meta');
      }

      // Image from product ID CDN (inferred)
      if (!image && ctx.productId) {
        const nm = parseInt(ctx.productId, 10);
        if (nm > 0) {
          image = imageField(wbCdnImageUrl(nm), 'inferred');
        }
      }

      // Description from OG
      const ogDesc = $('meta[property="og:description"]').attr('content')?.trim();
      if (ogDesc) {
        description = descriptionField(ogDesc, 'og_meta');
      }

      return {
        title, description, price, image,
        strategyName: 'wb_dom',
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return makeError('wb_dom', startTime, (err as Error).message);
    }
  },
};

// ─── WB API Response Parser ──────────────────────────────────────────────────

interface WbCardApiResponse {
  data?: { products?: WbProduct[] };
}

interface WbProduct {
  id: number;
  name?: string;
  brand?: string;
  salePriceU?: number;
  sizes?: Array<{ price?: { total?: number } }>;
  mediaFiles?: string[];
  description?: string;
}

function parseWbProduct(product: WbProduct, startTime: number): StrategyResult {
  let titleStr: string | null = null;
  if (product.name) {
    titleStr = product.brand
      ? `${product.brand} / ${product.name.trim()}`
      : product.name.trim();
  }

  const title = titleStr ? titleField(titleStr, 'card_api', 5) : null;

  const kopecks = product.salePriceU ?? product.sizes?.[0]?.price?.total ?? null;
  const priceAmount = kopecks !== null ? Math.round(kopecks / 100) : null;
  const price = priceAmount ? priceField(priceAmount, 'RUB', 'card_api', 5) : null;

  let imageUrl: string | null = null;
  if (Array.isArray(product.mediaFiles) && product.mediaFiles.length > 0) {
    imageUrl = product.mediaFiles[0]!;
  }
  if (!imageUrl) {
    imageUrl = wbCdnImageUrl(product.id);
  }
  const image = imageUrl ? imageField(imageUrl, 'card_api', 5) : null;

  const description = product.description
    ? descriptionField(product.description.trim(), 'card_api', 5)
    : null;

  return {
    title, description, price, image,
    strategyName: 'wb_card_api',
    durationMs: Date.now() - startTime,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeError(strategyName: string, startTime: number, error: string): StrategyResult {
  return {
    title: null, description: null, price: null, image: null,
    strategyName, durationMs: Date.now() - startTime, error,
  };
}

// ─── All WB Strategies (ordered) ─────────────────────────────────────────────

export const wildberriesStrategies: ParseStrategy[] = [
  wbBasketCdnStrategy,   // Basket CDN: static files, no anti-bot, fastest
  wbCardApiStrategy,     // search.wb.ru: fallback for price if CDN missing
  wbBrowserStrategy,     // Browser: last resort, blocked by WBAAS anti-bot
  wbDomStrategy,
];
