/**
 * Tests for the marketplace site registry — recognition + fallback currency.
 */
import { describe, it, expect } from 'vitest';
import { lookupSite, fallbackCurrency } from './site-registry.js';

describe('lookupSite — exact host match', () => {
  it('recognises a Russian marketplace', () => {
    expect(lookupSite('wildberries.ru')?.currency).toBe('RUB');
  });
  it('recognises a US marketplace', () => {
    expect(lookupSite('walmart.com')?.country).toBe('US');
  });
  it('recognises an India marketplace', () => {
    expect(lookupSite('flipkart.com')?.currency).toBe('INR');
  });
  it('recognises a China marketplace', () => {
    expect(lookupSite('jd.com')?.currency).toBe('CNY');
  });
  it('recognises a Spain marketplace', () => {
    expect(lookupSite('elcorteingles.es')?.currency).toBe('EUR');
  });
});

describe('lookupSite — prefix and subdomain handling', () => {
  it('strips www.', () => {
    expect(lookupSite('www.amazon.com')?.currency).toBe('USD');
  });
  it('strips m.', () => {
    expect(lookupSite('m.amazon.in')?.currency).toBe('INR');
  });
  it('matches a subdomain via endsWith', () => {
    expect(lookupSite('es.aliexpress.com')?.name).toBe('AliExpress');
    expect(lookupSite('smartphones.amazon.in')?.country).toBe('IN');
  });
  it('is case-insensitive', () => {
    expect(lookupSite('WWW.Amazon.ES')?.currency).toBe('EUR');
  });
});

describe('lookupSite — Amazon per-TLD currency', () => {
  it('amazon.com → USD, amazon.es → EUR, amazon.in → INR, amazon.co.uk → GBP', () => {
    expect(lookupSite('amazon.com')?.currency).toBe('USD');
    expect(lookupSite('amazon.es')?.currency).toBe('EUR');
    expect(lookupSite('amazon.in')?.currency).toBe('INR');
    expect(lookupSite('amazon.co.uk')?.currency).toBe('GBP');
  });
});

describe('lookupSite — unknown domains', () => {
  it('returns null for an unrecognised host', () => {
    expect(lookupSite('some-random-blog.xyz')).toBeNull();
  });
  it('does not false-match a lookalike host', () => {
    expect(lookupSite('notamazon.com')).toBeNull();
  });
});

describe('fallbackCurrency', () => {
  it('returns the registry currency for a known host', () => {
    expect(fallbackCurrency('flipkart.com')).toBe('INR');
  });
  it('falls back to RUB for an unknown host', () => {
    expect(fallbackCurrency('unknown-store.example')).toBe('RUB');
  });
});
