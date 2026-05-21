/**
 * marketplace/scraper-api.ts — optional scraping-API fetch fallback
 *
 * Many marketplaces block our datacenter IP outright (Akamai / Cloudflare /
 * PerimeterX 403, geo-blocks). When a direct fetch + headless browser both
 * fail that way, the parser retries through a scraping API that fetches from a
 * residential IP with a real rendering browser — and, for geo-fenced sites,
 * from the marketplace's own country.
 *
 * Entirely gated on SCRAPER_API_KEY: with no key set this module is inert and
 * the parser behaves exactly as before. It is a *fallback* — invoked only
 * after a direct fetch fails — so marketplaces reachable directly (WB CDN,
 * Amazon, AliExpress, Target, JD) never consume scraping-API credits.
 *
 * Built for ScrapingAnt's v2 API. Always uses a residential proxy + browser
 * rendering: empirically, anything less (datacenter proxy or browser=false)
 * is detected by eBay/Ozon-class anti-bot and returns HTTP 423. Cost on
 * ScrapingAnt: 125 credits/request — the free tier's 10k/month covers ~80
 * fallback fetches, fine while the feature is low-volume.
 *
 * Env:
 *   SCRAPER_API_KEY       — provider API key (absent ⇒ feature off)
 *   SCRAPER_API_URL       — base endpoint, default ScrapingAnt /v2/general
 *   SCRAPER_API_DISABLED  — kill switch (=1 ⇒ off even with a key)
 */

const SCRAPER_TIMEOUT_MS = 90_000;   // residential + JS render is slow
const MAX_HTML_BYTES     = 3 * 1024 * 1024;

/** Whether the scraping-API fallback is configured and active. */
export function isScraperApiEnabled(): boolean {
  return Boolean(process.env.SCRAPER_API_KEY) && process.env.SCRAPER_API_DISABLED !== '1';
}

/**
 * Build the ScrapingAnt request URL. The API key travels in the `x-api-key`
 * header (see fetchViaScraperApi), NOT here — so this result is safe to log.
 *
 * Always residential proxy + browser rendering: the only combination that
 * gets past eBay/Ozon-class anti-bot. `country` (ISO-3166 alpha-2) routes
 * through that country's IPs — critical for geo-fenced sites (RU).
 */
export function buildScraperApiUrl(targetUrl: string, opts?: { country?: string }): string {
  const base = process.env.SCRAPER_API_URL || 'https://api.scrapingant.com/v2/general';
  const params = new URLSearchParams({ url: targetUrl });
  params.set('proxy_type', 'residential');
  params.set('browser', 'true');
  if (opts?.country) params.set('proxy_country', opts.country.toUpperCase());
  return `${base}?${params.toString()}`;
}

/**
 * Fetch a URL's HTML via the scraping API. Throws when disabled or on failure;
 * the caller treats any throw as "fallback unavailable" and gives up cleanly.
 */
export async function fetchViaScraperApi(
  targetUrl: string,
  opts?: { country?: string },
): Promise<string> {
  const apiKey = process.env.SCRAPER_API_KEY;
  if (!apiKey) throw new Error('scraper_api_no_key');

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SCRAPER_TIMEOUT_MS);
  try {
    const res = await fetch(buildScraperApiUrl(targetUrl, opts), {
      signal: ctrl.signal,
      headers: { 'x-api-key': apiKey },
    });
    if (!res.ok) throw new Error(`scraper_api_http_${res.status}`);
    const html = await res.text();
    return html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html;
  } finally {
    clearTimeout(timer);
  }
}
