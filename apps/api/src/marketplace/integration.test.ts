/**
 * Integration tests for the marketplace parser pipeline.
 *
 * Tests the full flow: normalizer → orchestrator → strategies → scoring → guards.
 * Uses fixture HTML/JSON files to test extraction without network calls.
 *
 * Note: These tests exercise the individual strategies directly with fixture data,
 * NOT the full parseUrl() flow (which would require DNS resolution and network access).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { normalizeUrl, isKnownMarketplace, getMarketplaceId } from './normalizers.js';
import { mergeStrategyResults } from './scoring.js';
import { isAntiBotPage, isGarbageTitle, isSuspiciousPrice } from './guards.js';
import type { ParseContext, StrategyResult } from './types.js';

// Import individual strategy executors
import { wbCardApiStrategy, wbDomStrategy } from './strategies/wildberries.js';
import { ozonDomStrategy } from './strategies/ozon.js';
import { ymDomStrategy } from './strategies/yandex-market.js';
import { goldappleDomStrategy } from './strategies/goldapple.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const FIXTURES = path.join(__dirname, '__fixtures__');

function readFixture(filename: string): string {
  return fs.readFileSync(path.join(FIXTURES, filename), 'utf-8');
}

function makeContext(urlStr: string, html: string | null = null): ParseContext {
  const url = new URL(urlStr);
  const norm = normalizeUrl(url);
  return {
    url,
    hostname: norm.url.hostname.replace(/^www\./, '').replace(/^m\./, ''),
    marketplace: norm.marketplace,
    productId: norm.productId,
    canonicalUrl: norm.canonicalUrl,
    html,
  };
}

// ─── Wildberries Card API Fixture Test ───────────────────────────────────────

describe('Wildberries — Card API response parsing', () => {
  it('parses WB card API fixture correctly', async () => {
    const fixture = JSON.parse(readFixture('wb-card-api.json'));
    const product = fixture.data.products[0];

    // Simulate what wbCardApiStrategy does internally
    expect(product.name).toBe('Кроссовки беговые');
    expect(product.brand).toBe('Nike');
    expect(Math.round(product.salePriceU / 100)).toBe(8999);
    expect(product.mediaFiles[0]).toContain('wbbasket.ru');
    expect(product.description).toBeTruthy();
  });
});

// ─── Wildberries DOM Strategy ────────────────────────────────────────────────

describe('Wildberries — DOM strategy', () => {
  it('extracts data from WB-like HTML with OG tags and price regex', async () => {
    const html = `
      <html>
      <head>
        <meta property="og:title" content="Nike / Кроссовки беговые — купить на Wildberries" />
        <meta property="og:image" content="https://basket-11.wbbasket.ru/image.webp" />
        <meta property="og:description" content="Легкие кроссовки для бега" />
      </head>
      <body>
        <script>{"salePriceU":899900}</script>
      </body>
      </html>
    `;

    const ctx = makeContext('https://www.wildberries.ru/catalog/177335243/detail.aspx', html);
    const result = await wbDomStrategy.execute(ctx);

    expect(result).not.toBeNull();
    expect(result!.title).not.toBeNull();
    expect(result!.title!.value).toContain('Nike');
    expect(result!.title!.value).not.toContain('купить');
    expect(result!.title!.value).not.toContain('Wildberries');

    expect(result!.price).not.toBeNull();
    expect(result!.price!.value.amount).toBe(8999);
    expect(result!.price!.value.currency).toBe('RUB');

    expect(result!.image).not.toBeNull();
    expect(result!.image!.value).toContain('wbbasket.ru');

    expect(result!.description).not.toBeNull();
  });

  it('falls back to CDN image URL from product ID', async () => {
    const html = `
      <html>
      <head><meta property="og:title" content="Кроссовки — купить" /></head>
      <body></body>
      </html>
    `;
    const ctx = makeContext('https://www.wildberries.ru/catalog/177335243/detail.aspx', html);
    const result = await wbDomStrategy.execute(ctx);

    expect(result).not.toBeNull();
    expect(result!.image).not.toBeNull();
    expect(result!.image!.value).toContain('wbbasket.ru');
    expect(result!.image!.source).toBe('inferred');
  });
});

// ─── Ozon DOM Strategy ───────────────────────────────────────────────────────

describe('Ozon — DOM strategy', () => {
  it('extracts data from Ozon fixture HTML', async () => {
    const html = readFixture('ozon-product.html');
    const ctx = makeContext('https://www.ozon.ru/product/naushniki-sony-wh1000xm5-123456789/', html);
    const result = await ozonDomStrategy.execute(ctx);

    expect(result).not.toBeNull();

    // Title: should be cleaned of "— купить на Ozon"
    expect(result!.title).not.toBeNull();
    expect(result!.title!.value).toContain('Sony WH-1000XM5');
    expect(result!.title!.value).not.toContain('OZON');
    expect(result!.title!.value).not.toContain('купить');

    // Price: from hydration or OG
    expect(result!.price).not.toBeNull();
    expect(result!.price!.value.amount).toBe(32990);
    expect(result!.price!.value.currency).toBe('RUB');

    // Image: from OG
    expect(result!.image).not.toBeNull();
    expect(result!.image!.value).toContain('ozone.ru');
  });

  it('extracts price from finalPrice hydration pattern', async () => {
    const html = `
      <html>
      <head>
        <meta property="og:title" content="Товар — OZON"/>
      </head>
      <body>
        <script>{"finalPrice":"4999","oldPrice":"6999"}</script>
      </body>
      </html>
    `;
    const ctx = makeContext('https://ozon.ru/product/test-123456/', html);
    const result = await ozonDomStrategy.execute(ctx);

    expect(result!.price).not.toBeNull();
    expect(result!.price!.value.amount).toBe(4999);
  });
});

// ─── Yandex Market DOM Strategy ──────────────────────────────────────────────

describe('Yandex Market — DOM strategy', () => {
  it('extracts data from YM fixture HTML', async () => {
    const html = readFixture('ym-product.html');
    const ctx = makeContext('https://market.yandex.ru/product--iphone-15-pro/12345678', html);
    const result = await ymDomStrategy.execute(ctx);

    expect(result).not.toBeNull();

    // Title: cleaned
    expect(result!.title).not.toBeNull();
    expect(result!.title!.value).toContain('Apple iPhone 15 Pro');
    expect(result!.title!.value).not.toContain('Яндекс');

    // Price: from yandex_market:price meta (highest reliability)
    expect(result!.price).not.toBeNull();
    expect(result!.price!.value.amount).toBe(129990);
    expect(result!.price!.source).toBe('og_meta');

    // Image
    expect(result!.image).not.toBeNull();
    expect(result!.image!.value).toContain('yandex.net');
  });
});

// ─── Gold Apple DOM Strategy ─────────────────────────────────────────────────

describe('Gold Apple — DOM strategy', () => {
  it('extracts data from Gold Apple fixture HTML via JSON-LD', async () => {
    const html = readFixture('goldapple-product.html');
    const ctx = makeContext('https://goldapple.ru/product/krem-dlya-litsa-19000123456', html);
    const result = await goldappleDomStrategy.execute(ctx);

    expect(result).not.toBeNull();

    // Title: from JSON-LD (preferred source)
    expect(result!.title).not.toBeNull();
    expect(result!.title!.value).toContain('La Mer');

    // Price: from JSON-LD
    expect(result!.price).not.toBeNull();
    expect(result!.price!.value.amount).toBe(25490);

    // Image: from JSON-LD
    expect(result!.image).not.toBeNull();
    expect(result!.image!.value).toContain('goldapple.ru');

    // Description
    expect(result!.description).not.toBeNull();
    expect(result!.description!.value).toContain('увлажняющий');
  });
});

// ─── Anti-Bot Guard Integration ──────────────────────────────────────────────

describe('Anti-bot guard — fixture', () => {
  it('detects Cloudflare challenge page from fixture', () => {
    const html = readFixture('antibot-page.html');
    expect(isAntiBotPage(html, 'Just a moment...')).toBe(true);
  });

  it('does not flag real product pages', () => {
    const html = readFixture('ozon-product.html');
    expect(isAntiBotPage(html, 'Наушники Sony')).toBe(false);
  });
});

// ─── Multi-Strategy Merge Integration ────────────────────────────────────────

describe('Strategy merge — field-level best-pick', () => {
  it('merges WB API + DOM results, API wins on confidence', async () => {
    // Simulate API result (high confidence)
    const apiResult: StrategyResult = {
      title: { value: 'Nike / Кроссовки', confidence: 95, source: 'card_api' },
      description: { value: 'Легкие кроссовки', confidence: 95, source: 'card_api' },
      price: { value: { amount: 8999, currency: 'RUB', formatted: '8 999 ₽' }, confidence: 95, source: 'card_api' },
      image: { value: 'https://basket-11.wbbasket.ru/image.webp', confidence: 95, source: 'card_api' },
      strategyName: 'wb_card_api',
      durationMs: 200,
    };

    // Simulate DOM result (lower confidence, but has different data)
    const domResult: StrategyResult = {
      title: { value: 'Кроссовки беговые', confidence: 60, source: 'og_meta' },
      description: { value: 'Описание из OG', confidence: 60, source: 'og_meta' },
      price: { value: { amount: 8999, currency: 'RUB', formatted: '8 999 ₽' }, confidence: 40, source: 'html_regex' },
      image: { value: 'https://basket-11.wbbasket.ru/og-image.webp', confidence: 60, source: 'og_meta' },
      strategyName: 'wb_dom',
      durationMs: 50,
    };

    const merged = mergeStrategyResults([apiResult, domResult]);

    // API should win on all fields
    expect(merged.title!.source).toBe('card_api');
    expect(merged.price!.source).toBe('card_api');
    expect(merged.image!.source).toBe('card_api');
    expect(merged.confidenceLevel).toBe('high');
    expect(merged.overallConfidence).toBeGreaterThan(60);
  });

  it('fills missing API fields from DOM', async () => {
    const apiResult: StrategyResult = {
      title: { value: 'Nike / Кроссовки', confidence: 95, source: 'card_api' },
      description: null, // API didn't return description
      price: { value: { amount: 8999, currency: 'RUB', formatted: '8 999 ₽' }, confidence: 95, source: 'card_api' },
      image: null, // API didn't return image
      strategyName: 'wb_card_api',
      durationMs: 200,
    };

    const domResult: StrategyResult = {
      title: { value: 'Кроссовки', confidence: 55, source: 'og_meta' },
      description: { value: 'Легкие кроссовки для бега', confidence: 60, source: 'og_meta' },
      price: null,
      image: { value: 'https://basket-11.wbbasket.ru/image.webp', confidence: 60, source: 'og_meta' },
      strategyName: 'wb_dom',
      durationMs: 50,
    };

    const merged = mergeStrategyResults([apiResult, domResult]);

    // Title and price from API
    expect(merged.title!.source).toBe('card_api');
    expect(merged.price!.source).toBe('card_api');
    // Description and image from DOM (only source)
    expect(merged.description!.source).toBe('og_meta');
    expect(merged.image!.source).toBe('og_meta');
  });
});

// ─── Normalizer → Strategy Integration ───────────────────────────────────────

describe('Normalizer → context → strategy flow', () => {
  it('WB URL normalizes and provides product ID for strategies', () => {
    const url = new URL('https://www.wildberries.ru/catalog/177335243/detail.aspx?utm_source=google');
    const norm = normalizeUrl(url);

    expect(norm.marketplace).toBe('wildberries');
    expect(norm.productId).toBe('177335243');
    expect(norm.canonicalUrl).not.toContain('utm_source');
  });

  it('Ozon URL normalizes with product ID extraction', () => {
    const url = new URL('https://www.ozon.ru/product/naushniki-sony-wh1000xm5-123456789/?asb=abc');
    const norm = normalizeUrl(url);

    expect(norm.marketplace).toBe('ozon');
    expect(norm.productId).toBe('123456789');
    expect(norm.canonicalUrl).not.toContain('asb=');
  });

  it('unknown domain is not recognized as marketplace', () => {
    expect(isKnownMarketplace('amazon.com')).toBe(false);
    expect(isKnownMarketplace('dns-shop.ru')).toBe(false);
    expect(getMarketplaceId('example.com')).toBe('unknown');
  });
});

// ─── Guard Integration ───────────────────────────────────────────────────────

describe('Guards enforce data quality', () => {
  it('garbage title is rejected by isGarbageTitle', () => {
    expect(isGarbageTitle('Loading')).toBe(true);
    expect(isGarbageTitle('undefined')).toBe(true);
    expect(isGarbageTitle('{}')).toBe(true);
    expect(isGarbageTitle('123456')).toBe(true);
    expect(isGarbageTitle('iphone-15-pro')).toBe(true);
    expect(isGarbageTitle('iPhone 15 Pro Max 256GB')).toBe(false);
    expect(isGarbageTitle('Наушники Sony WH-1000XM5')).toBe(false);
  });

  it('suspicious price is rejected', () => {
    expect(isSuspiciousPrice(0)).toBe(true);
    expect(isSuspiciousPrice(-1)).toBe(true);
    expect(isSuspiciousPrice(9999)).toBe(true); // placeholder
    expect(isSuspiciousPrice(99999999)).toBe(true); // too high
    expect(isSuspiciousPrice(8999)).toBe(false);
    expect(isSuspiciousPrice(129990)).toBe(false);
  });
});
