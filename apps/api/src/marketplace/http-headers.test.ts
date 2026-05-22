/**
 * Tests for the realistic-browser-header builder.
 */
import { describe, it, expect } from 'vitest';
import { browserHeaders, acceptLanguageFor, pickUaProfile } from './http-headers.js';

describe('acceptLanguageFor', () => {
  it('maps known marketplace countries', () => {
    expect(acceptLanguageFor('RU')).toMatch(/^ru-RU/);
    expect(acceptLanguageFor('us')).toMatch(/^en-US/);   // case-insensitive
    expect(acceptLanguageFor('ES')).toMatch(/^es-ES/);
    expect(acceptLanguageFor('IN')).toMatch(/^en-IN/);
    expect(acceptLanguageFor('CN')).toMatch(/^zh-CN/);
  });
  it('falls back for an unknown or missing country', () => {
    const def = acceptLanguageFor();
    expect(acceptLanguageFor('ZZ')).toBe(def);
    expect(acceptLanguageFor(null)).toBe(def);
  });
});

describe('browserHeaders', () => {
  it('produces a full modern-Chrome header set', () => {
    const h = browserHeaders();
    expect(h['User-Agent']).toContain('Chrome/');
    expect(h['Accept']).toContain('text/html');
    expect(h['sec-ch-ua']).toContain('Chrome');
    expect(h['sec-ch-ua-mobile']).toBe('?0');
    expect(h['sec-ch-ua-platform']).toMatch(/^".+"$/);   // quoted token
    expect(h['Sec-Fetch-Mode']).toBe('navigate');
    expect(h['Upgrade-Insecure-Requests']).toBe('1');
  });
  it('routes Accept-Language through the marketplace country', () => {
    expect(browserHeaders({ country: 'ES' })['Accept-Language']).toMatch(/^es-ES/);
  });
  it('adds a Referer only when one is supplied', () => {
    expect(browserHeaders()['Referer']).toBeUndefined();
    expect(browserHeaders({ referer: 'https://x.com' })['Referer']).toBe('https://x.com');
  });
});

describe('pickUaProfile', () => {
  it('round-robins through every profile across a full cycle', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 4; i++) seen.add(pickUaProfile().ua);
    expect(seen.size).toBe(4);   // 4 distinct UAs over 4 consecutive calls
  });
  it('keeps the UA and sec-ch-ua Chrome versions consistent', () => {
    for (let i = 0; i < 4; i++) {
      const p = pickUaProfile();
      const uaVer = p.ua.match(/Chrome\/(\d+)/)?.[1];
      expect(uaVer).toBeTruthy();
      expect(p.secChUa).toContain(`v="${uaVer}"`);
    }
  });
});
