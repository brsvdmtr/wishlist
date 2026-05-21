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
 * Built for ScrapingAnt's v2 API. Always residential proxy + browser
 * rendering: anything less returns HTTP 423 (anti-bot detected). Even so the
 * bypass is probabilistic (~60%/try for eBay-class sites), so the caller
 * retries; some marketplaces (Ozon, Yandex) reliably fail and are skipped.
 * Cost on ScrapingAnt: 125 credits/request — free tier 10k/month.
 *
 * Env:
 *   SCRAPER_API_KEY            — provider API key (absent ⇒ feature off)
 *   SCRAPER_API_URL            — base endpoint, default ScrapingAnt /v2/general
 *   SCRAPER_API_DISABLED       — kill switch (=1 ⇒ off even with a key)
 *   SCRAPER_API_MAX_ATTEMPTS   — retries per URL (default 3, clamped 1..5)
 *   SCRAPER_API_MONTHLY_LIMIT  — soft cap on calls/calendar-month (default 70)
 */

const SCRAPER_TIMEOUT_MS = 90_000;   // residential + JS render is slow
const MAX_HTML_BYTES     = 3 * 1024 * 1024;

/**
 * Marketplaces whose anti-bot the free ScrapingAnt residential+browser tier
 * does not beat (verified: Ozon 0/4 attempts, always HTTP 423). The fallback
 * skips them — no wasted credits, no pointless 90s wait. Taobao-class
 * fortresses are listed for the same reason.
 */
const SCRAPER_HOPELESS = [
  'ozon.ru', 'market.yandex.ru',
  'taobao.com', 'tmall.com', 'pinduoduo.com', 'yangkeduo.com', '1688.com',
];

/** Whether the scraping-API fallback is configured and active. */
export function isScraperApiEnabled(): boolean {
  return Boolean(process.env.SCRAPER_API_KEY) && process.env.SCRAPER_API_DISABLED !== '1';
}

/** True for marketplaces where the scraping API reliably fails — skip them. */
export function isScraperHopeless(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
  return SCRAPER_HOPELESS.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Max ScrapingAnt attempts per URL. Anti-bot bypass is probabilistic
 * (~60%/try for eBay-class sites), so 3 tries ≈ 94%. Env-overridable.
 */
export function scraperMaxAttempts(): number {
  const n = parseInt(process.env.SCRAPER_API_MAX_ATTEMPTS || '3', 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 5) : 3;
}

// ─── Soft monthly budget guard ───────────────────────────────────────────────
// In-memory counter — a runaway guard, NOT a hard cap (resets on redeploy).
// The real billing protection is the free tier with no payment method:
// ScrapingAnt errors when credits run out and the fallback degrades
// gracefully. SCRAPER_API_MONTHLY_LIMIT caps calls per calendar month (each
// call ≈ 125 credits; default 70 ≈ 8750 of the 10k free, leaving a reserve).

let usage = { month: '', calls: 0 };
function currentMonth(): string { return new Date().toISOString().slice(0, 7); }

/** Record one ScrapingAnt call (counted before the request — a credit is
 *  spent regardless of the outcome). */
export function noteScraperCall(): void {
  const m = currentMonth();
  if (usage.month !== m) usage = { month: m, calls: 0 };
  usage.calls += 1;
}

/** Whether this calendar month's ScrapingAnt budget still has room. */
export function scraperBudgetLeft(): boolean {
  if (usage.month !== currentMonth()) return true;
  const limit = parseInt(process.env.SCRAPER_API_MONTHLY_LIMIT || '70', 10);
  return usage.calls < (Number.isFinite(limit) ? limit : 70);
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
 * the caller treats any throw as one failed attempt and retries or gives up.
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
