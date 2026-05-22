/**
 * marketplace/reader-api.ts — Jina Reader free fallback tier
 *
 * r.jina.ai fetches and renders a URL on Jina's own infrastructure and returns
 * the result. Because the fetch originates from Jina's IPs — not our
 * datacenter IP — it can reach sites that block us directly. It runs BEFORE
 * the paid ScrapingAnt tier in the remote fallback: Jina is free.
 *
 * Free + keyless by default; an optional JINA_API_KEY lifts the rate limit.
 * Kill switch: PARSER_JINA_DISABLED=1.
 *
 * Honest limit: Jina's fetchers are datacenter-class too, so it does NOT beat
 * geo-fenced fortresses (Ozon / Yandex) — those stay on the hopeless skip-list.
 *
 * Env:
 *   JINA_API_KEY          — optional bearer token (higher rate limit)
 *   JINA_READER_URL       — endpoint override, default https://r.jina.ai/
 *   PARSER_JINA_DISABLED  — kill switch (=1 ⇒ off)
 */

import { readCappedText } from './fetch-util.js';

// Client-side abort at 30 s — generous headroom over the 20 s we ask Jina for
// via the x-timeout header, since Jina's own render can queue under load.
const JINA_TIMEOUT_MS = 30_000;
const MAX_HTML_BYTES  = 3 * 1024 * 1024;

/** Whether the Jina Reader fallback is active (on by default — it is free). */
export function isJinaReaderEnabled(): boolean {
  return process.env.PARSER_JINA_DISABLED !== '1';
}

/**
 * Prefix a target URL with the Jina Reader endpoint. The target is appended
 * raw — `r.jina.ai/<full-url>` is Jina's documented form; query params pass
 * through, and a `#fragment` (dropped by Jina's router) does not affect a
 * server-side page fetch.
 */
export function buildJinaReaderUrl(targetUrl: string): string {
  const base = (process.env.JINA_READER_URL || 'https://r.jina.ai/').replace(/\/*$/, '/');
  return base + targetUrl;
}

/**
 * Fetch a URL's rendered HTML through Jina Reader. Throws on failure — the
 * caller treats a throw as "this tier missed, try the next one".
 */
export async function fetchViaJinaReader(targetUrl: string): Promise<string> {
  const ctrl  = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), JINA_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      // Return the rendered document's outerHTML (head + body) so the
      // universal extractor (JSON-LD / Open Graph / microdata) runs unchanged.
      'x-respond-with': 'html',
      'x-timeout': '20',
    };
    const key = process.env.JINA_API_KEY;
    if (key) headers['Authorization'] = `Bearer ${key}`;

    // redirect: 'manual' — never auto-follow a redirect to an unvalidated host
    // (consistent with fetchHtml / fetchTextSafe); a 3xx is treated as a miss.
    const res = await fetch(buildJinaReaderUrl(targetUrl), {
      signal: ctrl.signal, headers, redirect: 'manual',
    });
    if (!res.ok) throw new Error(`jina_http_${res.status}`);
    // Stream-read with a hard byte cap — never buffer an unbounded body.
    return await readCappedText(res.body, MAX_HTML_BYTES);
  } finally {
    clearTimeout(timer);
  }
}
