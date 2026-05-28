// URL scheme allowlist for USER-CONTROLLED links inside the Mini App.
//
// Threat model: anything that ends up as `<a href={X}>` where X originated
// from another user's content (wishlist item URL, gift-occasion idea link,
// item description, comment text, etc.). An attacker who controls X can
// craft links that:
//
//   - `javascript:` / `data:text/html,…` / `vbscript:` — XSS-shaped, mostly
//     blocked by modern browsers in <a href>, but inconsistent across the
//     Telegram WebViews we ship into (Android System WebView versions
//     trail Chrome). Defense-in-depth.
//
//   - `tg://user?id=ATTACKER_BOT` / `tg://resolve?domain=evil_bot` /
//     `tg://join?invite=…` — phishing via Telegram's deep-link protocol.
//     The Mini App lives inside Telegram, so tg:// links open in-app and
//     can land a victim on an attacker-controlled bot/channel. Real,
//     paid-bounty class of finding on chat apps with link previews.
//
//   - `file:` / `chrome:` / `about:` / `intent:` — internal-only schemes
//     that some embedded browsers honour and shouldn't reach user content.
//
// We allowlist http/https (the primary case for product links) plus
// mailto (occasionally legitimate in item descriptions). Everything else
// is rejected.
//
// This helper is for USER-CONTROLLED URLs only. App-generated deep links
// (e.g. the `tg://t.me/…` CTA on the onboarding screen) are trusted by
// construction and DON'T go through this helper.

const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * Returns true if `raw` parses as a URL whose scheme is in the allowlist.
 * Returns false for empty/null/relative URLs (relative URLs aren't expected
 * in any of our user-content fields), for non-allowlisted schemes, and for
 * inputs containing control characters (some browsers parse `\n` inside a
 * scheme as the URL boundary, which has historically bypassed naïve
 * regex-only allowlists).
 */
export function isSafeUserUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const trimmed = raw.trim();
  if (!trimmed) return false;
  // Reject ASCII control characters anywhere in the URL. Browsers and the
  // URL parser are inconsistent about how they handle embedded \n / \t /
  // \r inside scheme names — `java\nscript:alert(1)` has bypassed simple
  // case-insensitive checks in older surfaces. Reject upfront.
  if (/[\x00-\x1f\x7f]/.test(trimmed)) return false;
  try {
    const u = new URL(trimmed);
    return ALLOWED_SCHEMES.has(u.protocol.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Convenience: returns the trimmed URL if safe, otherwise null. Callers can
 * `?? '#'` for inert hrefs or render a plain `<span>` when null.
 */
export function safeUserUrl(raw: string | null | undefined): string | null {
  return isSafeUserUrl(raw) ? raw!.trim() : null;
}
