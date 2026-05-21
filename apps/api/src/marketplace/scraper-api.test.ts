/**
 * Tests for the scraping-API fetch fallback config + URL builder.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isScraperApiEnabled, buildScraperApiUrl } from './scraper-api.js';

const ENV_KEYS = ['SCRAPER_API_KEY', 'SCRAPER_API_DISABLED', 'SCRAPER_API_URL'];
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
  it('embeds the key and url-encodes the target', () => {
    const u = buildScraperApiUrl('SECRET', 'https://shop.com/p?a=1&b=2');
    expect(u.startsWith('https://api.scraperapi.com/?')).toBe(true);
    expect(u).toContain('api_key=SECRET');
    expect(u).toContain('url=https%3A%2F%2Fshop.com%2Fp%3Fa%3D1%26b%3D2');
  });
  it('adds render=true only when requested', () => {
    expect(buildScraperApiUrl('k', 'https://x.com')).not.toContain('render');
    expect(buildScraperApiUrl('k', 'https://x.com', { render: true })).toContain('render=true');
  });
  it('honours the SCRAPER_API_URL provider override', () => {
    process.env.SCRAPER_API_URL = 'https://app.scrapingbee.com/api/v1/';
    expect(buildScraperApiUrl('k', 'https://x.com'))
      .toMatch(/^https:\/\/app\.scrapingbee\.com\/api\/v1\/\?/);
  });
});
