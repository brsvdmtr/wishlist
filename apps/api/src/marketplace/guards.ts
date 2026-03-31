/**
 * marketplace/guards.ts — Anti-bot / garbage guard improvements
 *
 * Detects captcha pages, error pages, and garbage data that should
 * be rejected rather than stored as valid product data.
 */

// ─── Anti-Bot Detection ──────────────────────────────────────────────────────

/**
 * Check if HTML looks like a captcha/anti-bot challenge page.
 * Returns true if the page should be considered blocked.
 */
export function isAntiBotPage(html: string, title: string | null): boolean {
  if (html.length < 800) return true;

  const lTitle = (title ?? '').toLowerCase();
  const botTitleKeywords = [
    'captcha', 'robot', 'challenge', 'antibot', 'access denied',
    'attention required', 'just a moment', 'проверка', 'verify you are human',
    'forbidden', '403', 'blocked', 'security check',
  ];
  if (botTitleKeywords.some(t => lTitle.includes(t))) return true;

  const lHtml = html.toLowerCase();
  const botHtmlMarkers = [
    'g-recaptcha', 'h-captcha', 'cf_challenge', 'cf-challenge-running',
    'cf_chl_opt', 'cf-please-wait', 'ddos-guard', 'smartcaptcha',
    'class="antibot"', '__cf_chl', 'yandex-smartcaptcha',
    'qrator', 'stormwall', 'sucuri-cloudproxy',
  ];
  if (botHtmlMarkers.some(s => lHtml.includes(s))) return true;

  return false;
}

// ─── Garbage Title Detection ─────────────────────────────────────────────────

/**
 * Check if a title string looks like garbage/placeholder rather than
 * a real product title.
 */
export function isGarbageTitle(title: string): boolean {
  if (!title || title.length < 2) return true;
  if (title.length > 600) return true;

  // Slugs and IDs
  if (/^[a-z0-9_-]+$/.test(title)) return true;
  if (/^\d+$/.test(title)) return true;

  // JSON/code fragments
  if (title.startsWith('{') || title.startsWith('[')) return true;
  if (title.includes('\\n') || title.includes('\\t')) return true;

  // Generic error/placeholder titles
  const lTitle = title.toLowerCase();
  const garbagePatterns = [
    'loading', 'загрузка', 'undefined', 'null', 'error',
    'not found', 'не найден', 'page not found', 'страница не найдена',
    'javascript is required', 'enable javascript',
    'внимание', 'attention', 'test', 'example',
  ];
  if (garbagePatterns.some(p => lTitle === p || lTitle.startsWith(p + ' '))) return true;

  return false;
}

// ─── Garbage Price Detection ─────────────────────────────────────────────────

/**
 * Check if a price value looks suspicious.
 * `source` is optional — when the price comes from a trusted API (card_api,
 * network_intercept) we apply a more lenient policy to avoid false positives
 * on legitimately cheap/expensive items.
 */
export function isSuspiciousPrice(
  amount: number,
  source?: string,
): boolean {
  // Price negative or zero — always suspicious
  if (amount <= 0) return true;

  // Trusted API sources: only reject truly impossible values
  const trusted = source === 'card_api' || source === 'network_intercept' || source === 'basket_cdn';
  if (trusted) {
    // Prices below 1 ₽ are probably parsing errors (sub-kopeck)
    if (amount < 1) return true;
    // Above 100M ₽ is certainly wrong
    if (amount > 100_000_000) return true;
    return false;
  }

  // Untrusted sources: tighter bounds
  if (amount < 1) return true;
  if (amount > 10_000_000) return true;
  // Common "placeholder" prices from DOM/regex
  if (amount === 9999 || amount === 99999 || amount === 999999) return true;
  return false;
}

// ─── Image URL Validation ────────────────────────────────────────────────────

/**
 * Check if an image URL looks like a valid product image.
 */
export function isValidImageUrl(url: string): boolean {
  if (!url) return false;

  // Must be http(s) or protocol-relative
  if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('//')) {
    return false;
  }

  // Reject data URIs
  if (url.startsWith('data:')) return false;

  // Reject obviously non-image URLs
  const lUrl = url.toLowerCase();
  const invalidPatterns = [
    'pixel.gif', '1x1.', 'spacer.', 'blank.', 'empty.',
    'placeholder', 'no-image', 'no_image', 'noimage',
    'default-avatar', 'default_avatar',
  ];
  if (invalidPatterns.some(p => lUrl.includes(p))) return false;

  return true;
}
