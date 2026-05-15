// Unit tests for services/locale-detection.ts.
//
// This service composes signals (Telegram language_code, browser headers,
// IP geo, first_name script) and asks @wishlist/shared's resolveMarketBucket
// to pick a bucket. We mock the shared resolver to verify the signal
// extraction without coupling to its specific output for every input.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request } from 'express';

const shared = vi.hoisted(() => ({
  resolveMarketBucket: vi.fn(),
  getClientIp: vi.fn(),
}));

vi.mock('@wishlist/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wishlist/shared')>();
  return {
    ...actual,
    resolveMarketBucket: shared.resolveMarketBucket,
  };
});

vi.mock('../security/ipHash', () => ({
  getClientIp: shared.getClientIp,
}));

import { lookupCountryByIp, resolveBucketFromRequest, prewarmGeoip } from './locale-detection';

beforeEach(() => {
  shared.resolveMarketBucket.mockReset();
  shared.getClientIp.mockReset();
});

describe('lookupCountryByIp', () => {
  it('returns null for null', () => {
    expect(lookupCountryByIp(null)).toBeNull();
  });

  it('returns null for undefined', () => {
    expect(lookupCountryByIp(undefined)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(lookupCountryByIp('')).toBeNull();
  });

  it('returns null for the "unknown" sentinel (avoids hashing a non-IP)', () => {
    expect(lookupCountryByIp('unknown')).toBeNull();
  });

  it('attempts geoip lookup for a syntactically valid IP', () => {
    // We can't easily mock the geoip-lite singleton — it's loaded via
    // `require` inside the module. Instead, just exercise the path and
    // assert the return type. The result will be either a 2-char country
    // code or null depending on whether the DB recognises the IP.
    const result = lookupCountryByIp('8.8.8.8');
    expect(result === null || /^[A-Z]{2}$/.test(result)).toBe(true);
  });
});

describe('prewarmGeoip', () => {
  it('returns a boolean indicating whether geoip-lite loaded', () => {
    // The module is loaded once and cached; calling prewarmGeoip multiple
    // times must always yield the same boolean.
    const a = prewarmGeoip();
    const b = prewarmGeoip();
    expect(typeof a).toBe('boolean');
    expect(a).toBe(b);
  });
});

describe('resolveBucketFromRequest — signal aggregation', () => {
  function mockReq(opts: {
    languageCode?: string | null;
    browserLanguage?: string | null;
    timezone?: string | null;
    ip?: string;
  } = {}): Request {
    const headers: Record<string, string> = {};
    if (opts.browserLanguage) headers['X-Browser-Language'] = opts.browserLanguage;
    if (opts.timezone) headers['X-Browser-Timezone'] = opts.timezone;
    return {
      get: (name: string) => headers[name],
      tgUser: opts.languageCode ? { language_code: opts.languageCode } : undefined,
    } as unknown as Request;
  }

  it('passes Telegram language_code through to the resolver', () => {
    shared.resolveMarketBucket.mockReturnValueOnce({ bucket: 'ru', source: 'language_code' });
    shared.getClientIp.mockReturnValueOnce('unknown');

    resolveBucketFromRequest(mockReq({ languageCode: 'ru' }));

    expect(shared.resolveMarketBucket).toHaveBeenCalledWith(
      expect.objectContaining({ languageCode: 'ru' }),
    );
  });

  it('reads X-Browser-Language and X-Browser-Timezone headers', () => {
    shared.resolveMarketBucket.mockReturnValueOnce({ bucket: 'en', source: 'browser' });
    shared.getClientIp.mockReturnValueOnce('unknown');

    resolveBucketFromRequest(mockReq({ browserLanguage: 'en-US', timezone: 'America/New_York' }));

    expect(shared.resolveMarketBucket).toHaveBeenCalledWith(
      expect.objectContaining({ browserLanguage: 'en-US', timezone: 'America/New_York' }),
    );
  });

  it('rejects malformed X-Browser-Language values (defensive against log poisoning)', () => {
    shared.resolveMarketBucket.mockReturnValueOnce({ bucket: 'unknown', source: 'unknown' });
    shared.getClientIp.mockReturnValueOnce('unknown');

    resolveBucketFromRequest(mockReq({ browserLanguage: '<script>alert(1)</script>' }));

    expect(shared.resolveMarketBucket).toHaveBeenCalledWith(
      expect.objectContaining({ browserLanguage: null }),
    );
  });

  it('rejects malformed X-Browser-Timezone values', () => {
    shared.resolveMarketBucket.mockReturnValueOnce({ bucket: 'unknown', source: 'unknown' });
    shared.getClientIp.mockReturnValueOnce('unknown');

    resolveBucketFromRequest(mockReq({ timezone: 'Europe/Moscow; rm -rf /' }));

    expect(shared.resolveMarketBucket).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: null }),
    );
  });

  it('accepts firstName via context (script-analysis fallback signal)', () => {
    shared.resolveMarketBucket.mockReturnValueOnce({ bucket: 'unknown', source: 'unknown' });
    shared.getClientIp.mockReturnValueOnce('unknown');

    resolveBucketFromRequest(mockReq(), { firstName: 'الأمين' });

    expect(shared.resolveMarketBucket).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'الأمين' }),
    );
  });

  it('passes the resolver result through unchanged', () => {
    const fakeResult = { bucket: 'unknown' as const, source: 'unknown' as const };
    shared.resolveMarketBucket.mockReturnValueOnce(fakeResult);
    shared.getClientIp.mockReturnValueOnce('unknown');

    expect(resolveBucketFromRequest(mockReq())).toBe(fakeResult);
  });
});
