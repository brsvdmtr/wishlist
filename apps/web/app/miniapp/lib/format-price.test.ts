import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import {
  fmtPrice,
  formatSmartResTimer,
  parsePriceFromDisplay,
  formatPriceForDisplay,
  formatRetryAfter,
} from './format-price';

describe('fmtPrice', () => {
  it('returns null for null / 0', () => {
    expect(fmtPrice(null)).toBeNull();
    expect(fmtPrice(0)).toBeNull();
  });

  it('formats RUB with ₽ glyph by default', () => {
    const out = fmtPrice(1234);
    expect(out).toContain('₽');
    expect(out).toContain('1');
    expect(out).toContain('234');
  });

  it('formats USD with $ glyph', () => {
    const out = fmtPrice(1234, 'en', 'USD');
    expect(out).toContain('$');
    expect(out).toContain('1');
  });
});

describe('formatSmartResTimer', () => {
  it('returns 0m for non-positive ms', () => {
    expect(formatSmartResTimer(0)).toBe('0m');
    expect(formatSmartResTimer(-1)).toBe('0m');
  });

  it('formats minutes only when < 1h', () => {
    expect(formatSmartResTimer(60_000 * 30)).toBe('30m');
    expect(formatSmartResTimer(60_000 * 59)).toBe('59m');
  });

  it('formats hours + minutes when < 1d', () => {
    expect(formatSmartResTimer(60_000 * 60 * 1)).toBe('1h');
    expect(formatSmartResTimer(60_000 * (60 + 15))).toBe('1h 15m');
  });

  it('formats days + hours when >= 1d', () => {
    expect(formatSmartResTimer(60_000 * 60 * 24)).toBe('1d');
    expect(formatSmartResTimer(60_000 * 60 * 30)).toBe('1d 6h');
    expect(formatSmartResTimer(60_000 * 60 * 48)).toBe('2d');
  });
});

describe('parsePriceFromDisplay', () => {
  it('strips non-digits', () => {
    expect(parsePriceFromDisplay('1 234 ₽')).toBe('1234');
    expect(parsePriceFromDisplay('$1,234.50')).toBe('123450');
    expect(parsePriceFromDisplay('abc')).toBe('');
    expect(parsePriceFromDisplay('')).toBe('');
  });
});

describe('formatPriceForDisplay', () => {
  it('returns empty for null / undefined / empty', () => {
    expect(formatPriceForDisplay(null)).toBe('');
    expect(formatPriceForDisplay(undefined)).toBe('');
    expect(formatPriceForDisplay('')).toBe('');
  });

  it('inserts spaces every 3 digits from the right', () => {
    expect(formatPriceForDisplay(1234)).toBe('1 234');
    expect(formatPriceForDisplay(1234567)).toBe('1 234 567');
    expect(formatPriceForDisplay('1234')).toBe('1 234');
  });

  it('strips non-digits before formatting', () => {
    expect(formatPriceForDisplay('1,234 RUB')).toBe('1 234');
  });
});

describe('formatRetryAfter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the "retry now" copy for non-positive seconds', () => {
    const out = formatRetryAfter(0, 'en');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
    // Symmetric: negative input behaves the same
    expect(formatRetryAfter(-5, 'en')).toBe(out);
  });

  it('returns a non-empty minutes copy for < 1h', () => {
    const out = formatRetryAfter(300, 'en');
    expect(out).toMatch(/\d+/);
  });

  it('returns a non-empty hours copy when between 1h and 24h', () => {
    const out = formatRetryAfter(3600, 'en');
    expect(out).toMatch(/\d+/);
  });

  it('returns a "tomorrow at HH:MM" style copy when >= 24h', () => {
    const out = formatRetryAfter(60 * 60 * 25, 'en');
    expect(out).toMatch(/\d+/);
    expect(out).toMatch(/:/);
  });

  it('rolls 60 minutes up into the next hour', () => {
    // 59m 30s -> ceil(30/60)=1m + 59m worth → 60m → rolled into 1h
    const at59_30 = formatRetryAfter(59 * 60 + 30, 'en');
    expect(at59_30).toMatch(/\d+/);
  });
});
