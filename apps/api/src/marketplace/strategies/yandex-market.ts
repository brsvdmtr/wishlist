/**
 * marketplace/strategies/yandex-market.ts — Yandex Market multi-strategy parser
 *
 * Strategy pipeline (browser-first):
 *   1. Browser + network intercept — captures /resolveProduct and similar APIs
 *   2. DOM fallback — Cheerio on rendered HTML + hydration extraction
 *
 * YM-specific knowledge:
 *   - SPA with React SSR, but dynamic pricing requires JS execution
 *   - Product IDs in /product--slug/12345 format
 *   - Has yandex_market:price meta tag (reliable when present)
 *   - __NEXT_DATA__ sometimes has product data
 *   - Prices in network responses: "price" / "value" / "current"
 */

import type { ParseStrategy, ParseContext, StrategyResult, FieldValue, PriceData } from '../types.js';
import {
  titleField,
  priceField,
  imageField,
  descriptionField,
} from '../scoring.js';
import { isGarbageTitle } from '../guards.js';
import { getBrowser } from '../browser-provider.js';
import { browserExtract } from '../../browser-network-extractor.js';
import { networkProductToResult } from './shared-browser.js';

// ─── Strategy 1: Browser + Network Intercept ─────────────────────────────────

export const ymBrowserStrategy: ParseStrategy = {
  name: 'ym_browser',

  async execute(ctx: ParseContext): Promise<StrategyResult | null> {
    const startTime = Date.now();

    try {
      const browser = await getBrowser();
      const { html, product } = await browserExtract(browser, ctx.url.href, ctx.hostname);

      // Store HTML in context for DOM fallback
      ctx.html = html;

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
        'ym_browser',
        startTime,
      );
    } catch (err) {
      return makeError('ym_browser', startTime, (err as Error).message);
    }
  },
};

// ─── Strategy 2: DOM Fallback ────────────────────────────────────────────────

export const ymDomStrategy: ParseStrategy = {
  name: 'ym_dom',

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
          .replace(/\s*[-–—]\s*Яндекс.*/i, '')
          .trim();
        if (cleaned && !isGarbageTitle(cleaned)) {
          title = titleField(cleaned, 'og_meta');
        }
      }

      // Price from yandex_market:price meta (most reliable)
      const ymPrice = $('meta[property="yandex_market:price"]').attr('content')
                   ?? $('meta[name="price"]').attr('content');
      if (ymPrice) {
        const amount = parseInt(ymPrice.replace(/\s/g, ''), 10);
        if (amount > 0 && amount < 10_000_000) {
          price = priceField(amount, 'RUB', 'og_meta', 5);
        }
      }

      // Price from product:price:amount meta
      if (!price) {
        const metaPrice = $('meta[property="product:price:amount"]').attr('content');
        if (metaPrice) {
          const amount = parseFloat(metaPrice);
          if (amount > 0 && amount < 10_000_000) {
            const cur = $('meta[property="product:price:currency"]').attr('content') ?? 'RUB';
            price = priceField(amount, cur, 'og_meta');
          }
        }
      }

      // Price from hydration JSON patterns
      if (!price) {
        const pricePatterns = [
          /"price"\s*:\s*"?(\d+)"?/,
          /"value"\s*:\s*"?(\d+)"?.*?"currency"/,
        ];
        for (const pattern of pricePatterns) {
          const match = ctx.html.match(pattern);
          if (match?.[1]) {
            const amount = parseInt(match[1]!, 10);
            if (amount > 0 && amount < 10_000_000) {
              price = priceField(amount, 'RUB', 'html_regex');
              break;
            }
          }
        }
      }

      // Image from OG
      const ogImage = $('meta[property="og:image"]').attr('content')?.trim();
      if (ogImage) {
        image = imageField(ogImage, 'og_meta');
      }

      // Description from OG
      const ogDesc = $('meta[property="og:description"]').attr('content')?.trim();
      if (ogDesc) {
        description = descriptionField(ogDesc, 'og_meta');
      }

      return {
        title, description, price, image,
        strategyName: 'ym_dom',
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return makeError('ym_dom', startTime, (err as Error).message);
    }
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeError(strategyName: string, startTime: number, error: string): StrategyResult {
  return {
    title: null, description: null, price: null, image: null,
    strategyName, durationMs: Date.now() - startTime, error,
  };
}

// ─── All YM Strategies (ordered) ─────────────────────────────────────────────

export const yandexMarketStrategies: ParseStrategy[] = [
  ymBrowserStrategy,
  ymDomStrategy,
];
