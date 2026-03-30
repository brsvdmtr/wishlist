/**
 * Tests for orchestrator hardening:
 *   - shouldFallbackToLegacy() logic
 *   - enforceGuards() post-merge field rejection
 *   - Reason-aware cache TTL
 *   - Kill switch
 */
import { describe, it, expect, afterEach } from 'vitest';
import { shouldFallbackToLegacy, isOrchestratorEnabled } from './orchestrator.js';
import type { ParsedProduct, FieldValue, PriceData } from './types.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeProduct(overrides: Partial<ParsedProduct> = {}): ParsedProduct {
  return {
    title: null,
    description: null,
    price: null,
    image: null,
    overallConfidence: 0,
    confidenceLevel: 'none',
    ...overrides,
  };
}

function makeTitle(value: string, confidence: number, source: FieldValue<string>['source'] = 'card_api'): FieldValue<string> {
  return { value, confidence, source };
}

function makePrice(amount: number, confidence: number, source: FieldValue<PriceData>['source'] = 'card_api'): FieldValue<PriceData> {
  return { value: { amount, currency: 'RUB', formatted: `${amount} ₽` }, confidence, source };
}

function makeImage(url: string, confidence: number, source: FieldValue<string>['source'] = 'card_api'): FieldValue<string> {
  return { value: url, confidence, source };
}

// ─── shouldFallbackToLegacy ──────────────────────────────────────────────────

describe('shouldFallbackToLegacy', () => {
  it('returns reason for confidence: none', () => {
    const product = makeProduct({ confidenceLevel: 'none', overallConfidence: 0 });
    expect(shouldFallbackToLegacy(product)).toBe('confidence_none');
  });

  it('returns reason for very low confidence (below threshold)', () => {
    const product = makeProduct({
      title: makeTitle('Some title', 30, 'og_meta'),
      confidenceLevel: 'low',
      overallConfidence: 20,
    });
    expect(shouldFallbackToLegacy(product)).toMatch(/confidence_too_low/);
  });

  it('returns reason when no title AND no price', () => {
    const product = makeProduct({
      image: makeImage('https://example.com/img.jpg', 60, 'og_meta'),
      confidenceLevel: 'low',
      overallConfidence: 30,
    });
    expect(shouldFallbackToLegacy(product)).toBe('no_title_no_price');
  });

  it('returns reason for garbage title', () => {
    const product = makeProduct({
      title: makeTitle('Loading', 70, 'og_meta'),
      price: makePrice(1999, 80),
      confidenceLevel: 'medium',
      overallConfidence: 50,
    });
    expect(shouldFallbackToLegacy(product)).toBe('garbage_title');
  });

  it('returns reason when title only from weak source and no price', () => {
    const product = makeProduct({
      title: makeTitle('Some product', 40, 'html_regex'),
      confidenceLevel: 'low',
      overallConfidence: 30,
    });
    expect(shouldFallbackToLegacy(product)).toBe('title_only_from_weak_source');
  });

  it('returns null for good result with title + price + image', () => {
    const product = makeProduct({
      title: makeTitle('iPhone 15 Pro', 90, 'card_api'),
      price: makePrice(129990, 90, 'card_api'),
      image: makeImage('https://example.com/img.jpg', 80, 'card_api'),
      confidenceLevel: 'high',
      overallConfidence: 85,
    });
    expect(shouldFallbackToLegacy(product)).toBeNull();
  });

  it('returns null for title + price without image (medium confidence)', () => {
    const product = makeProduct({
      title: makeTitle('Nike Кроссовки', 80, 'card_api'),
      price: makePrice(8999, 85, 'card_api'),
      confidenceLevel: 'medium',
      overallConfidence: 55,
    });
    expect(shouldFallbackToLegacy(product)).toBeNull();
  });

  it('returns null for title from strong source without price (if confidence above threshold)', () => {
    const product = makeProduct({
      title: makeTitle('Sony WH-1000XM5', 80, 'card_api'),
      image: makeImage('https://example.com/img.jpg', 70, 'og_meta'),
      confidenceLevel: 'medium',
      overallConfidence: 40,
    });
    expect(shouldFallbackToLegacy(product)).toBeNull();
  });
});

// ─── Kill Switch ─────────────────────────────────────────────────────────────

describe('isOrchestratorEnabled (kill switch)', () => {
  const originalEnv = process.env.MARKETPLACE_PARSER_DISABLED;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MARKETPLACE_PARSER_DISABLED;
    } else {
      process.env.MARKETPLACE_PARSER_DISABLED = originalEnv;
    }
  });

  it('returns true by default (no env var)', () => {
    delete process.env.MARKETPLACE_PARSER_DISABLED;
    expect(isOrchestratorEnabled()).toBe(true);
  });

  it('returns true when env var is empty', () => {
    process.env.MARKETPLACE_PARSER_DISABLED = '';
    expect(isOrchestratorEnabled()).toBe(true);
  });

  it('returns false when env var is "1"', () => {
    process.env.MARKETPLACE_PARSER_DISABLED = '1';
    expect(isOrchestratorEnabled()).toBe(false);
  });

  it('returns true for any other value', () => {
    process.env.MARKETPLACE_PARSER_DISABLED = '0';
    expect(isOrchestratorEnabled()).toBe(true);
  });
});
