/**
 * Tests for field-level confidence scoring and strategy result merging.
 */
import { describe, it, expect } from 'vitest';
import {
  titleField,
  priceField,
  imageField,
  descriptionField,
  mergeStrategyResults,
  fieldValue,
  formatPrice,
} from './scoring.js';
import type { StrategyResult } from './types.js';

// ─── titleField ──────────────────────────────────────────────────────────────

describe('titleField', () => {
  it('creates a field from valid title', () => {
    const f = titleField('iPhone 15 Pro Max 256GB', 'card_api');
    expect(f).not.toBeNull();
    expect(f!.value).toBe('iPhone 15 Pro Max 256GB');
    expect(f!.confidence).toBeGreaterThan(80);
    expect(f!.source).toBe('card_api');
  });

  it('returns null for empty string', () => {
    expect(titleField('', 'og_meta')).toBeNull();
  });

  it('returns null for single char', () => {
    expect(titleField('A', 'og_meta')).toBeNull();
  });

  it('returns null for numeric-only string', () => {
    expect(titleField('123456', 'og_meta')).toBeNull();
  });

  it('penalizes slug-like titles', () => {
    const f = titleField('iphone-15-pro-max', 'og_meta');
    expect(f).not.toBeNull();
    expect(f!.confidence).toBeLessThan(30);
  });

  it('penalizes short titles', () => {
    const short = titleField('Чехол', 'card_api');
    const long  = titleField('Чехол для iPhone 15 Pro Max прозрачный силиконовый', 'card_api');
    expect(short!.confidence).toBeLessThan(long!.confidence);
  });

  it('applies boost', () => {
    const base    = titleField('iPhone 15 Pro Max', 'card_api', 0);
    const boosted = titleField('iPhone 15 Pro Max', 'card_api', 10);
    expect(boosted!.confidence).toBe(base!.confidence + 10);
  });
});

// ─── priceField ──────────────────────────────────────────────────────────────

describe('priceField', () => {
  it('creates a price field', () => {
    const f = priceField(1999, 'RUB', 'card_api');
    expect(f).not.toBeNull();
    expect(f!.value.amount).toBe(1999);
    expect(f!.value.currency).toBe('RUB');
    expect(f!.value.formatted).toContain('1');
    expect(f!.value.formatted).toContain('999');
  });

  it('returns null for zero price', () => {
    expect(priceField(0, 'RUB', 'card_api')).toBeNull();
  });

  it('returns null for negative price', () => {
    expect(priceField(-100, 'RUB', 'card_api')).toBeNull();
  });

  it('returns null for unreasonably high price', () => {
    expect(priceField(999_999_999, 'RUB', 'card_api')).toBeNull();
  });
});

// ─── imageField ──────────────────────────────────────────────────────────────

describe('imageField', () => {
  it('accepts https URL', () => {
    const f = imageField('https://example.com/image.jpg', 'og_meta');
    expect(f).not.toBeNull();
    expect(f!.value).toBe('https://example.com/image.jpg');
  });

  it('accepts protocol-relative URL', () => {
    const f = imageField('//example.com/image.jpg', 'og_meta');
    expect(f).not.toBeNull();
  });

  it('rejects empty string', () => {
    expect(imageField('', 'og_meta')).toBeNull();
  });

  it('rejects non-http URL', () => {
    expect(imageField('ftp://example.com/image.jpg', 'og_meta')).toBeNull();
  });
});

// ─── descriptionField ────────────────────────────────────────────────────────

describe('descriptionField', () => {
  it('creates a description field', () => {
    const f = descriptionField('A great product with many features', 'card_api');
    expect(f).not.toBeNull();
    expect(f!.value).toBe('A great product with many features');
  });

  it('truncates to 500 chars', () => {
    const long = 'x'.repeat(600);
    const f = descriptionField(long, 'card_api');
    expect(f!.value.length).toBe(500);
  });

  it('rejects short description', () => {
    expect(descriptionField('Hi', 'card_api')).toBeNull();
  });
});

// ─── mergeStrategyResults ────────────────────────────────────────────────────

describe('mergeStrategyResults', () => {
  it('picks highest-confidence field from multiple strategies', () => {
    const result1: StrategyResult = {
      title: fieldValue('Title from API', 90, 'card_api'),
      description: null,
      price: fieldValue({ amount: 999, currency: 'RUB', formatted: '999 ₽' }, 85, 'card_api'),
      image: null,
      strategyName: 'api',
      durationMs: 100,
    };

    const result2: StrategyResult = {
      title: fieldValue('Title from DOM', 55, 'dom_selector'),
      description: fieldValue('Great product', 60, 'og_meta'),
      price: null,
      image: fieldValue('https://img.com/pic.jpg', 70, 'og_meta'),
      strategyName: 'dom',
      durationMs: 200,
    };

    const merged = mergeStrategyResults([result1, result2]);

    // Title from API (90 > 55)
    expect(merged.title!.value).toBe('Title from API');
    expect(merged.title!.source).toBe('card_api');

    // Description from DOM (only source)
    expect(merged.description!.value).toBe('Great product');

    // Price from API (only source)
    expect(merged.price!.value.amount).toBe(999);

    // Image from DOM (only source)
    expect(merged.image!.value).toBe('https://img.com/pic.jpg');

    // Overall confidence should be high
    expect(merged.confidenceLevel).toBe('high');
  });

  it('returns none confidence when no fields found', () => {
    const result: StrategyResult = {
      title: null, description: null, price: null, image: null,
      strategyName: 'empty', durationMs: 0,
    };
    const merged = mergeStrategyResults([result]);
    expect(merged.confidenceLevel).toBe('none');
    expect(merged.overallConfidence).toBe(0);
  });

  it('skips errored strategies', () => {
    const good: StrategyResult = {
      title: fieldValue('Good title', 80, 'card_api'),
      description: null, price: null, image: null,
      strategyName: 'good', durationMs: 100,
    };
    const bad: StrategyResult = {
      title: fieldValue('Bad title', 95, 'card_api'),
      description: null, price: null, image: null,
      strategyName: 'bad', durationMs: 50,
      error: 'something broke',
    };
    const merged = mergeStrategyResults([good, bad]);
    expect(merged.title!.value).toBe('Good title');
  });
});

// ─── formatPrice ─────────────────────────────────────────────────────────────

describe('formatPrice', () => {
  it('formats RUB price', () => {
    expect(formatPrice(1999, 'RUB')).toMatch(/1.*999.*₽/);
  });

  it('formats USD price', () => {
    expect(formatPrice(99, 'USD')).toBe('$99');
  });

  it('formats EUR price', () => {
    expect(formatPrice(49, 'EUR')).toBe('€49');
  });

  it('formats INR price with the rupee symbol', () => {
    expect(formatPrice(1299, 'INR')).toMatch(/^₹/);
    expect(formatPrice(1299, 'INR')).toContain('1,299');
  });

  it('formats CNY price with the yuan symbol', () => {
    expect(formatPrice(199, 'CNY')).toBe('¥199');
  });

  it('formats GBP price with the pound symbol', () => {
    expect(formatPrice(49, 'GBP')).toBe('£49');
  });

  it('applies locale-aware digit grouping (USD comma, EUR dot)', () => {
    expect(formatPrice(1999, 'USD')).toBe('$1,999');
    expect(formatPrice(1999, 'EUR')).toBe('€1.999');
  });

  it('normalises currency aliases (RUR → RUB, RMB → CNY)', () => {
    expect(formatPrice(100, 'RUR')).toContain('₽');
    expect(formatPrice(100, 'RMB')).toBe('¥100');
  });

  it('falls back to the plain code for an unknown currency', () => {
    expect(formatPrice(100, 'JPY')).toBe('100 JPY');
  });
});
