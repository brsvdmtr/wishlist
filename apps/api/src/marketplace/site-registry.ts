/**
 * marketplace/site-registry.ts — Recognised marketplace directory
 *
 * A lightweight lookup table of top marketplaces across RU / IN / CN / US / ES.
 * Unlike normalizers.ts (which drives the RU strategy orchestrator), this
 * registry is *recognition only*: it supplies a fallback currency for prices
 * extracted without an explicit currency, plus a display name for logging.
 *
 * It deliberately carries NO per-site parsing code — the universal extractor
 * (structured-data.ts) and the legacy pipeline handle every site listed here.
 */

import { stripHostPrefix } from './normalizers.js';

export interface SiteInfo {
  /** Human-readable marketplace name (logging / diagnostics) */
  name: string;
  /** ISO 3166-1 alpha-2 country of the storefront */
  country: string;
  /** ISO 4217 currency — fallback when a parsed price carries no currency */
  currency: string;
}

/**
 * host (www/m prefix stripped) → SiteInfo.
 * Subdomains (e.g. `es.aliexpress.com`) match the bare host via `endsWith`.
 */
const REGISTRY: Record<string, SiteInfo> = {
  // ─── Russia (RUB) ──────────────────────────────────────────────────────
  'wildberries.ru':    { name: 'Wildberries',      country: 'RU', currency: 'RUB' },
  'ozon.ru':           { name: 'Ozon',             country: 'RU', currency: 'RUB' },
  'market.yandex.ru':  { name: 'Yandex Market',    country: 'RU', currency: 'RUB' },
  'megamarket.ru':     { name: 'Megamarket',       country: 'RU', currency: 'RUB' },
  'aliexpress.ru':     { name: 'AliExpress RU',    country: 'RU', currency: 'RUB' },
  'lamoda.ru':         { name: 'Lamoda',           country: 'RU', currency: 'RUB' },
  'dns-shop.ru':       { name: 'DNS',              country: 'RU', currency: 'RUB' },
  'citilink.ru':       { name: 'Citilink',         country: 'RU', currency: 'RUB' },
  'mvideo.ru':         { name: 'M.Video',          country: 'RU', currency: 'RUB' },
  'eldorado.ru':       { name: 'Eldorado',         country: 'RU', currency: 'RUB' },
  'detmir.ru':         { name: 'Detsky Mir',       country: 'RU', currency: 'RUB' },
  'goldapple.ru':      { name: 'Gold Apple',       country: 'RU', currency: 'RUB' },
  'sportmaster.ru':    { name: 'Sportmaster',      country: 'RU', currency: 'RUB' },
  'vseinstrumenti.ru': { name: 'VseInstrumenti',   country: 'RU', currency: 'RUB' },
  'tehnopark.ru':      { name: 'Tehnopark',        country: 'RU', currency: 'RUB' },
  'bork.ru':           { name: 'Bork',             country: 'RU', currency: 'RUB' },

  // ─── India (INR) ───────────────────────────────────────────────────────
  'amazon.in':         { name: 'Amazon India',     country: 'IN', currency: 'INR' },
  'flipkart.com':      { name: 'Flipkart',         country: 'IN', currency: 'INR' },
  'myntra.com':        { name: 'Myntra',           country: 'IN', currency: 'INR' },
  'meesho.com':        { name: 'Meesho',           country: 'IN', currency: 'INR' },
  'ajio.com':          { name: 'AJIO',             country: 'IN', currency: 'INR' },
  'nykaa.com':         { name: 'Nykaa',            country: 'IN', currency: 'INR' },
  'snapdeal.com':      { name: 'Snapdeal',         country: 'IN', currency: 'INR' },
  'tatacliq.com':      { name: 'Tata CLiQ',        country: 'IN', currency: 'INR' },
  'jiomart.com':       { name: 'JioMart',          country: 'IN', currency: 'INR' },
  'croma.com':         { name: 'Croma',            country: 'IN', currency: 'INR' },
  'reliancedigital.in':{ name: 'Reliance Digital', country: 'IN', currency: 'INR' },

  // ─── China (CNY) ───────────────────────────────────────────────────────
  'taobao.com':        { name: 'Taobao',           country: 'CN', currency: 'CNY' },
  'tmall.com':         { name: 'Tmall',            country: 'CN', currency: 'CNY' },
  'jd.com':            { name: 'JD.com',           country: 'CN', currency: 'CNY' },
  'pinduoduo.com':     { name: 'Pinduoduo',        country: 'CN', currency: 'CNY' },
  'yangkeduo.com':     { name: 'Pinduoduo',        country: 'CN', currency: 'CNY' },
  '1688.com':          { name: '1688',             country: 'CN', currency: 'CNY' },
  'vip.com':           { name: 'VIP.com',          country: 'CN', currency: 'CNY' },
  'aliexpress.com':    { name: 'AliExpress',       country: 'CN', currency: 'USD' },
  'aliexpress.us':     { name: 'AliExpress US',    country: 'US', currency: 'USD' },

  // ─── USA (USD) ─────────────────────────────────────────────────────────
  'amazon.com':        { name: 'Amazon',           country: 'US', currency: 'USD' },
  'walmart.com':       { name: 'Walmart',          country: 'US', currency: 'USD' },
  'target.com':        { name: 'Target',           country: 'US', currency: 'USD' },
  'bestbuy.com':       { name: 'Best Buy',         country: 'US', currency: 'USD' },
  'ebay.com':          { name: 'eBay',             country: 'US', currency: 'USD' },
  'etsy.com':          { name: 'Etsy',             country: 'US', currency: 'USD' },
  'homedepot.com':     { name: 'Home Depot',       country: 'US', currency: 'USD' },
  'lowes.com':         { name: "Lowe's",           country: 'US', currency: 'USD' },
  'costco.com':        { name: 'Costco',           country: 'US', currency: 'USD' },
  'wayfair.com':       { name: 'Wayfair',          country: 'US', currency: 'USD' },
  'newegg.com':        { name: 'Newegg',           country: 'US', currency: 'USD' },
  'macys.com':         { name: "Macy's",           country: 'US', currency: 'USD' },
  'nordstrom.com':     { name: 'Nordstrom',        country: 'US', currency: 'USD' },

  // ─── Spain (EUR) ───────────────────────────────────────────────────────
  'amazon.es':         { name: 'Amazon España',    country: 'ES', currency: 'EUR' },
  'elcorteingles.es':  { name: 'El Corte Inglés',  country: 'ES', currency: 'EUR' },
  'pccomponentes.com': { name: 'PcComponentes',    country: 'ES', currency: 'EUR' },
  'mediamarkt.es':     { name: 'MediaMarkt',       country: 'ES', currency: 'EUR' },
  'zalando.es':        { name: 'Zalando',          country: 'ES', currency: 'EUR' },
  'zara.com':          { name: 'Zara',             country: 'ES', currency: 'EUR' },
  'mango.com':         { name: 'Mango',            country: 'ES', currency: 'EUR' },
  'carrefour.es':      { name: 'Carrefour',        country: 'ES', currency: 'EUR' },
  'fnac.es':           { name: 'Fnac',             country: 'ES', currency: 'EUR' },
  'miravia.es':        { name: 'Miravia',          country: 'ES', currency: 'EUR' },

  // ─── Amazon — other TLDs users commonly paste ──────────────────────────
  'amazon.co.uk':      { name: 'Amazon UK',        country: 'GB', currency: 'GBP' },
  'amazon.de':         { name: 'Amazon DE',        country: 'DE', currency: 'EUR' },
  'amazon.fr':         { name: 'Amazon FR',        country: 'FR', currency: 'EUR' },
  'amazon.it':         { name: 'Amazon IT',        country: 'IT', currency: 'EUR' },
  'amazon.nl':         { name: 'Amazon NL',        country: 'NL', currency: 'EUR' },
};

/**
 * Look up a hostname in the marketplace registry.
 * Matches the bare host exactly, or any subdomain of it.
 * Returns null for unrecognised domains.
 */
export function lookupSite(hostname: string): SiteInfo | null {
  const h = stripHostPrefix(hostname);
  const direct = REGISTRY[h];
  if (direct) return direct;
  for (const host in REGISTRY) {
    if (h.endsWith(`.${host}`)) return REGISTRY[host]!;
  }
  return null;
}

/**
 * Fallback currency for a hostname — the registry currency if recognised,
 * else RUB (the historical default, WishBoard's home market).
 */
export function fallbackCurrency(hostname: string): string {
  return lookupSite(hostname)?.currency ?? 'RUB';
}
