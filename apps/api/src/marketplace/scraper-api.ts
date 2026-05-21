/**
 * marketplace/scraper-api.ts — optional scraping-API fetch fallback
 *
 * Many marketplaces block our datacenter IP outright (Akamai / Cloudflare /
 * PerimeterX 403, geo-blocks). When a direct fetch + headless browser both
 * fail that way, the parser retries through a third-party scraping API that
 * fetches from a rotating residential IP and returns the page HTML.
 *
 * Entirely gated on SCRAPER_API_KEY: with no key set this module is inert and
 * the parser behaves exactly as before. It is a *fallback* — invoked only
 * after a direct fetch fails — so marketplaces reachable directly (WB CDN,
 * Amazon, AliExpress, Target, JD) never consume scraping-API credits.
 *
 * Built for ScraperAPI's request format; SCRAPER_API_URL overrides the base
 * endpoint for a different provider.
 *
 * Env:
 *   SCRAPER_API_KEY       — provider API key (absent ⇒ feature off)
 *   SCRAPER_API_URL       — base endpoint, default https://api.scraperapi.com/
 *   SCRAPER_API_DISABLED  — kill switch (=1 ⇒ feature off even with a key)
 */

const SCRAPER_TIMEOUT_MS = 45_000;
const MAX_HTML_BYTES     = 3 * 1024 * 1024;

/** Whether the scraping-API fallback is configured and active. */
export function isScraperApiEnabled(): boolean {
  return Boolean(process.env.SCRAPER_API_KEY) && process.env.SCRAPER_API_DISABLED !== '1';
}

/**
 * Build the scraping-API request URL (ScraperAPI format). Pure function.
 * The API key is embedded in the result — never log the return value.
 */
export function buildScraperApiUrl(
  apiKey: string,
  targetUrl: string,
  opts?: { render?: boolean },
): string {
  const base = process.env.SCRAPER_API_URL || 'https://api.scraperapi.com/';
  const params = new URLSearchParams({ api_key: apiKey, url: targetUrl });
  if (opts?.render) params.set('render', 'true');
  return `${base}?${params.toString()}`;
}

/**
 * Fetch a URL's HTML via the scraping API. Throws when disabled or on failure;
 * the caller treats any throw as "fallback unavailable" and gives up cleanly.
 */
export async function fetchViaScraperApi(
  targetUrl: string,
  opts?: { render?: boolean },
): Promise<string> {
  const apiKey = process.env.SCRAPER_API_KEY;
  if (!apiKey) throw new Error('scraper_api_no_key');

  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SCRAPER_TIMEOUT_MS);
  try {
    const res = await fetch(buildScraperApiUrl(apiKey, targetUrl, opts), { signal: ctrl.signal });
    if (!res.ok) throw new Error(`scraper_api_http_${res.status}`);
    const html = await res.text();
    return html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html;
  } finally {
    clearTimeout(timer);
  }
}
