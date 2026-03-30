/**
 * marketplace/strategies/ozon.ts — Ozon multi-strategy parser
 *
 * Strategy pipeline (browser-first marketplace):
 *   1. Browser + network intercept — captures /api/composer JSON, widgetStates
 *   2. DOM fallback — Cheerio on rendered HTML + hydration regex
 *
 * Ozon-specific knowledge:
 *   - Heavily JS-rendered SPA, HTTP-only fetch almost always fails
 *   - Prices embed in "finalPrice" / "price" fields in hydration state
 *   - /api/composer returns widgetStates with nested JSON strings
 *   - Product IDs: /product/slug-123456789/
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

export const ozonBrowserStrategy: ParseStrategy = {
  name: 'ozon_browser',

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
        'ozon_browser',
        startTime,
      );
    } catch (err) {
      return makeError('ozon_browser', startTime, (err as Error).message);
    }
  },
};

// ─── Strategy 2: DOM Fallback ────────────────────────────────────────────────

export const ozonDomStrategy: ParseStrategy = {
  name: 'ozon_dom',

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
          .replace(/\s*[-–—]\s*(?:купить|заказать)\s+(?:на|в)\s+OZON.*/i, '')
          .replace(/\s*\|\s*OZON\s*$/i, '')
          .trim();
        if (cleaned && !isGarbageTitle(cleaned)) {
          title = titleField(cleaned, 'og_meta');
        }
      }

      // Price from hydration JSON — multiple patterns
      const pricePatterns = [
        /"finalPrice"\s*:\s*"?(\d+)"?/,
        /"price"\s*:\s*"?(\d+)"?/,
        /"cardPrice"\s*:\s*"?(\d+)"?/,
        /"totalPrice"\s*:\s*"?(\d+)"?/,
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

      // Price from DOM selectors
      if (!price) {
        const domPriceSelectors = [
          '[data-widget="webSalePrice"] span',
          '[data-widget="webPrice"] span',
          '[class*="price-number"]',
        ];
        for (const sel of domPriceSelectors) {
          const text = $(sel).first().text();
          if (text) {
            const m = text.match(/([\d\s]+)\s*₽/);
            if (m?.[1]) {
              const amount = parseInt(m[1]!.replace(/\s/g, ''), 10);
              if (amount > 0) {
                price = priceField(amount, 'RUB', 'dom_selector');
                break;
              }
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
        const cleaned = ogDesc
          .replace(/\s*[-–—]\s*(?:купить|заказать).*/i, '')
          .trim();
        description = descriptionField(cleaned, 'og_meta');
      }

      return {
        title, description, price, image,
        strategyName: 'ozon_dom',
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return makeError('ozon_dom', startTime, (err as Error).message);
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

// ─── All Ozon Strategies (ordered) ───────────────────────────────────────────

export const ozonStrategies: ParseStrategy[] = [
  ozonBrowserStrategy,
  ozonDomStrategy,
];
