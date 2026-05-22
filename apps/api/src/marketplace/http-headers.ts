/**
 * marketplace/http-headers.ts — realistic browser request headers
 *
 * A plain `fetch` from Node sends a thin, non-browser-like header set that
 * soft anti-bot layers flag. This module builds a full modern-Chrome header
 * set: a rotating User-Agent paired with matching Client Hints (sec-ch-ua*),
 * and an Accept-Language tuned to the marketplace's country so the storefront
 * serves its local locale (and price).
 *
 * Pure + dependency-free — unit-testable, no network.
 */

/** A consistent (UA string, sec-ch-ua, platform) triple — never mismatched. */
export interface UaProfile {
  /** User-Agent header value */
  ua: string;
  /** sec-ch-ua Client Hint — Chrome version must match `ua` */
  secChUa: string;
  /** sec-ch-ua-platform value (un-quoted; quoted when emitted) */
  platform: string;
}

/**
 * A small pool of current desktop-Chrome profiles. Rotating between them means
 * repeated fetches from the same server don't all carry an identical
 * fingerprint. Each profile keeps its UA and Client-Hint versions consistent —
 * a mismatch is itself an anti-bot signal.
 */
const UA_PROFILES: UaProfile[] = [
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    platform: 'Windows',
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    platform: 'macOS',
  },
  {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    secChUa: '"Chromium";v="130", "Google Chrome";v="130", "Not?A_Brand";v="99"',
    platform: 'Windows',
  },
  {
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
    platform: 'Linux',
  },
];

/** Country (ISO-3166 alpha-2) → Accept-Language. */
const COUNTRY_LANG: Record<string, string> = {
  RU: 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
  US: 'en-US,en;q=0.9',
  GB: 'en-GB,en;q=0.9',
  IN: 'en-IN,en-GB;q=0.9,en;q=0.8,hi;q=0.7',
  CN: 'zh-CN,zh;q=0.9,en;q=0.8',
  ES: 'es-ES,es;q=0.9,en;q=0.8',
  DE: 'de-DE,de;q=0.9,en;q=0.8',
  FR: 'fr-FR,fr;q=0.9,en;q=0.8',
  IT: 'it-IT,it;q=0.9,en;q=0.8',
  NL: 'nl-NL,nl;q=0.9,en;q=0.8',
  CA: 'en-CA,en;q=0.9,fr-CA;q=0.8',
  MX: 'es-MX,es;q=0.9,en;q=0.8',
  BR: 'pt-BR,pt;q=0.9,en;q=0.8',
  AU: 'en-AU,en;q=0.9',
  JP: 'ja-JP,ja;q=0.9,en;q=0.8',
  SE: 'sv-SE,sv;q=0.9,en;q=0.8',
  PL: 'pl-PL,pl;q=0.9,en;q=0.8',
  SA: 'ar-SA,ar;q=0.9,en;q=0.8',
  AE: 'ar-AE,ar;q=0.9,en;q=0.8',
  EG: 'ar-EG,ar;q=0.9,en;q=0.8',
  SG: 'en-SG,en;q=0.9,zh;q=0.8',
};
const DEFAULT_LANG = 'en-US,en;q=0.9';

/** Accept-Language for a marketplace country (falls back to a neutral value). */
export function acceptLanguageFor(country?: string | null): string {
  if (!country) return DEFAULT_LANG;
  return COUNTRY_LANG[country.toUpperCase()] ?? DEFAULT_LANG;
}

let uaCursor = Math.floor(Math.random() * UA_PROFILES.length);

/** Round-robin a UA profile so repeated fetches don't look identical. */
export function pickUaProfile(): UaProfile {
  const p = UA_PROFILES[uaCursor % UA_PROFILES.length]!;
  uaCursor = (uaCursor + 1) % UA_PROFILES.length;
  return p;
}

/**
 * A full modern-Chrome request header set for an HTML document fetch.
 * `country` tunes Accept-Language; `referer` is added only when supplied.
 */
export function browserHeaders(
  opts?: { country?: string | null; referer?: string },
): Record<string, string> {
  const p = pickUaProfile();
  const h: Record<string, string> = {
    'User-Agent': p.ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,'
      + 'image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': acceptLanguageFor(opts?.country),
    'Accept-Encoding': 'gzip, deflate, br',
    'sec-ch-ua': p.secChUa,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${p.platform}"`,
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
  if (opts?.referer) h['Referer'] = opts.referer;
  return h;
}
