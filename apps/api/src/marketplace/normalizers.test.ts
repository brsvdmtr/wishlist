/**
 * Tests for URL normalization, marketplace detection, and product ID extraction.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeUrl,
  detectMarketplace,
  isKnownMarketplace,
  getMarketplaceId,
  stripHostPrefix,
} from './normalizers.js';

// ─── stripHostPrefix ─────────────────────────────────────────────────────────

describe('stripHostPrefix', () => {
  it('strips www.', () => {
    expect(stripHostPrefix('www.wildberries.ru')).toBe('wildberries.ru');
  });
  it('strips m.', () => {
    expect(stripHostPrefix('m.ozon.ru')).toBe('ozon.ru');
  });
  it('strips both www. and m.', () => {
    expect(stripHostPrefix('www.m.example.com')).toBe('example.com');
  });
  it('lowercases', () => {
    expect(stripHostPrefix('WWW.Wildberries.RU')).toBe('wildberries.ru');
  });
  it('returns unchanged for bare host', () => {
    expect(stripHostPrefix('ozon.ru')).toBe('ozon.ru');
  });
});

// ─── detectMarketplace ───────────────────────────────────────────────────────

describe('detectMarketplace', () => {
  it('detects Wildberries', () => {
    expect(detectMarketplace('wildberries.ru')?.id).toBe('wildberries');
    expect(detectMarketplace('www.wildberries.ru')?.id).toBe('wildberries');
  });
  it('detects Ozon', () => {
    expect(detectMarketplace('ozon.ru')?.id).toBe('ozon');
    expect(detectMarketplace('www.ozon.ru')?.id).toBe('ozon');
  });
  it('detects Yandex Market', () => {
    expect(detectMarketplace('market.yandex.ru')?.id).toBe('yandex_market');
  });
  it('detects Gold Apple', () => {
    expect(detectMarketplace('goldapple.ru')?.id).toBe('goldapple');
  });
  it('detects Lamoda', () => {
    expect(detectMarketplace('lamoda.ru')?.id).toBe('lamoda');
  });
  it('returns null for unknown host', () => {
    expect(detectMarketplace('amazon.com')).toBeNull();
  });
});

// ─── isKnownMarketplace / getMarketplaceId ───────────────────────────────────

describe('isKnownMarketplace', () => {
  it('returns true for WB', () => expect(isKnownMarketplace('wildberries.ru')).toBe(true));
  it('returns false for unknown', () => expect(isKnownMarketplace('example.com')).toBe(false));
});

describe('getMarketplaceId', () => {
  it('returns wildberries for WB', () => expect(getMarketplaceId('wildberries.ru')).toBe('wildberries'));
  it('returns unknown for unknown host', () => expect(getMarketplaceId('example.com')).toBe('unknown'));
});

// ─── normalizeUrl — Product ID Extraction ────────────────────────────────────

describe('normalizeUrl — Wildberries', () => {
  it('extracts nm from /catalog/123456789/detail.aspx', () => {
    const url = new URL('https://www.wildberries.ru/catalog/123456789/detail.aspx');
    const result = normalizeUrl(url);
    expect(result.marketplace).toBe('wildberries');
    expect(result.productId).toBe('123456789');
  });

  it('extracts nm from /catalog/123456789/', () => {
    const url = new URL('https://wildberries.ru/catalog/123456789/');
    const result = normalizeUrl(url);
    expect(result.productId).toBe('123456789');
  });

  it('returns null productId for non-product WB URL', () => {
    const url = new URL('https://www.wildberries.ru/brands/nike');
    const result = normalizeUrl(url);
    expect(result.marketplace).toBe('wildberries');
    expect(result.productId).toBeNull();
  });
});

describe('normalizeUrl — Ozon', () => {
  it('extracts ID from /product/slug-123456789/', () => {
    const url = new URL('https://www.ozon.ru/product/naushniki-besprovodnye-123456789/');
    const result = normalizeUrl(url);
    expect(result.marketplace).toBe('ozon');
    expect(result.productId).toBe('123456789');
  });

  it('extracts ID from /product/123456789/', () => {
    const url = new URL('https://ozon.ru/product/123456789/');
    const result = normalizeUrl(url);
    expect(result.productId).toBe('123456789');
  });
});

describe('normalizeUrl — Yandex Market', () => {
  it('extracts ID from /product--slug/12345', () => {
    const url = new URL('https://market.yandex.ru/product--iphone-15/12345678');
    const result = normalizeUrl(url);
    expect(result.marketplace).toBe('yandex_market');
    expect(result.productId).toBe('12345678');
  });

  it('extracts ID from /product/12345', () => {
    const url = new URL('https://market.yandex.ru/product/12345678');
    const result = normalizeUrl(url);
    expect(result.productId).toBe('12345678');
  });

  it('extracts ID from /offer/12345', () => {
    const url = new URL('https://market.yandex.ru/offer/12345678');
    const result = normalizeUrl(url);
    expect(result.productId).toBe('12345678');
  });
});

describe('normalizeUrl — Gold Apple', () => {
  it('extracts ID from /product/slug-19000123456', () => {
    const url = new URL('https://goldapple.ru/product/krem-dlya-litsa-19000123456');
    const result = normalizeUrl(url);
    expect(result.marketplace).toBe('goldapple');
    expect(result.productId).toBe('19000123456');
  });
});

// ─── normalizeUrl — Canonicalization ─────────────────────────────────────────

describe('normalizeUrl — canonicalization', () => {
  it('strips utm params', () => {
    const url = new URL('https://ozon.ru/product/123456789/?utm_source=google&utm_medium=cpc');
    const result = normalizeUrl(url);
    expect(result.canonicalUrl).not.toContain('utm_source');
    expect(result.canonicalUrl).not.toContain('utm_medium');
  });

  it('strips marketplace-specific params (Ozon)', () => {
    const url = new URL('https://ozon.ru/product/123456789/?asb=abc&avtc=1&sh=xyz');
    const result = normalizeUrl(url);
    expect(result.canonicalUrl).not.toContain('asb=');
    expect(result.canonicalUrl).not.toContain('avtc=');
    expect(result.canonicalUrl).not.toContain('sh=');
  });

  it('preserves essential path', () => {
    const url = new URL('https://www.wildberries.ru/catalog/123456789/detail.aspx?targetUrl=abc&utm_source=x');
    const result = normalizeUrl(url);
    expect(result.canonicalUrl).toContain('/catalog/123456789/detail.aspx');
  });
});
