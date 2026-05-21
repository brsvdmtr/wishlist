/**
 * Tests for the scraping-API fetch fallback config + URL builder.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  isScraperApiEnabled, buildScraperApiUrl, isScraperHopeless,
  scraperMaxAttempts, noteScraperCall, scraperBudgetLeft,
} from './scraper-api.js';

const ENV_KEYS = [
  'SCRAPER_API_KEY', 'SCRAPER_API_DISABLED', 'SCRAPER_API_URL',
  'SCRAPER_API_MAX_ATTEMPTS', 'SCRAPER_API_MONTHLY_LIMIT',
];
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
  it('targets ScrapingAnt with a residential proxy + browser rendering', () => {
    const u = buildScraperApiUrl('https://shop.com/p?a=1&b=2');
    expect(u.startsWith('https://api.scrapingant.com/v2/general?')).toBe(true);
    expect(u).toContain('url=https%3A%2F%2Fshop.com%2Fp%3Fa%3D1%26b%3D2');
    expect(u).toContain('proxy_type=residential');
    expect(u).toContain('browser=true');
  });
  it('routes through the marketplace country, uppercased', () => {
    expect(buildScraperApiUrl('https://x.com', { country: 'ru' })).toContain('proxy_country=RU');
    expect(buildScraperApiUrl('https://x.com')).not.toContain('proxy_country');
  });
  it('honours the SCRAPER_API_URL provider override', () => {
    process.env.SCRAPER_API_URL = 'https://app.scrapingbee.com/api/v1/';
    expect(buildScraperApiUrl('https://x.com'))
      .toMatch(/^https:\/\/app\.scrapingbee\.com\/api\/v1\/\?/);
  });
});

describe('isScraperHopeless', () => {
  it('flags Ozon / Yandex / Taobao-class fortresses', () => {
    expect(isScraperHopeless('ozon.ru')).toBe(true);
    expect(isScraperHopeless('www.ozon.ru')).toBe(true);
    expect(isScraperHopeless('market.yandex.ru')).toBe(true);
    expect(isScraperHopeless('taobao.com')).toBe(true);
  });
  it('does not flag scrapable marketplaces', () => {
    expect(isScraperHopeless('ebay.com')).toBe(false);
    expect(isScraperHopeless('www.amazon.com')).toBe(false);
    expect(isScraperHopeless('flipkart.com')).toBe(false);
  });
});

describe('scraperMaxAttempts', () => {
  it('defaults to 3', () => {
    expect(scraperMaxAttempts()).toBe(3);
  });
  it('honours the env override and clamps to 1..5', () => {
    process.env.SCRAPER_API_MAX_ATTEMPTS = '2';
    expect(scraperMaxAttempts()).toBe(2);
    process.env.SCRAPER_API_MAX_ATTEMPTS = '99';
    expect(scraperMaxAttempts()).toBe(5);
    process.env.SCRAPER_API_MAX_ATTEMPTS = 'junk';
    expect(scraperMaxAttempts()).toBe(3);
  });
});

describe('scraper monthly budget', () => {
  it('runs out after SCRAPER_API_MONTHLY_LIMIT calls', () => {
    process.env.SCRAPER_API_MONTHLY_LIMIT = '3';
    expect(scraperBudgetLeft()).toBe(true);
    noteScraperCall();
    noteScraperCall();
    expect(scraperBudgetLeft()).toBe(true);
    noteScraperCall();
    expect(scraperBudgetLeft()).toBe(false);
  });
});
