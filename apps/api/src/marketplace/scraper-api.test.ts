/**
 * Tests for the scraping-API fetch fallback config + URL builder.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isScraperApiEnabled, buildScraperApiUrl } from './scraper-api.js';

const ENV_KEYS = ['SCRAPER_API_KEY', 'SCRAPER_API_DISABLED', 'SCRAPER_API_URL', 'SCRAPER_API_BROWSER'];
afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('isScraperApiEnabled', () => {
  it('is off with no API key', () => {
    expect(isScraperApiEnabled()).toBe(false);
  });
  it('is on once an API key is set', () => {
    process.env.SCRAPER_API_KEY = 'test-key';
    expect(isScraperApiEnabled()).toBe(true);
  });
  it('stays off when the kill switch is set', () => {
    process.env.SCRAPER_API_KEY = 'test-key';
    process.env.SCRAPER_API_DISABLED = '1';
    expect(isScraperApiEnabled()).toBe(false);
  });
});

describe('buildScraperApiUrl', () => {
  it('targets ScrapingAnt with a residential proxy and url-encodes the target', () => {
    const u = buildScraperApiUrl('https://shop.com/p?a=1&b=2');
    expect(u.startsWith('https://api.scrapingant.com/v2/general?')).toBe(true);
    expect(u).toContain('url=https%3A%2F%2Fshop.com%2Fp%3Fa%3D1%26b%3D2');
    expect(u).toContain('proxy_type=residential');
    expect(u).toContain('browser=false');
  });
  it('requests JS rendering only when asked', () => {
    expect(buildScraperApiUrl('https://x.com')).toContain('browser=false');
    expect(buildScraperApiUrl('https://x.com', { browser: true })).toContain('browser=true');
  });
  it('routes through the marketplace country, uppercased', () => {
    expect(buildScraperApiUrl('https://x.com', { country: 'ru' })).toContain('proxy_country=RU');
    expect(buildScraperApiUrl('https://x.com')).not.toContain('proxy_country');
  });
  it('forces JS rendering when SCRAPER_API_BROWSER=1', () => {
    process.env.SCRAPER_API_BROWSER = '1';
    expect(buildScraperApiUrl('https://x.com')).toContain('browser=true');
  });
  it('honours the SCRAPER_API_URL provider override', () => {
    process.env.SCRAPER_API_URL = 'https://app.scrapingbee.com/api/v1/';
    expect(buildScraperApiUrl('https://x.com'))
      .toMatch(/^https:\/\/app\.scrapingbee\.com\/api\/v1\/\?/);
  });
});
