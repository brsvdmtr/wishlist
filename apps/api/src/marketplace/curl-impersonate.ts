/**
 * marketplace/curl-impersonate.ts — real-Chrome TLS-fingerprint fetch
 *
 * A plain Node fetch presents undici's TLS ClientHello, which Cloudflare /
 * Akamai / DataDome fingerprint and 403 even when the HTTP headers look like a
 * browser. curl-impersonate performs a byte-identical Chrome TLS handshake, so
 * those layers serve real content. It runs as a fast tier between the plain
 * fetch and the (slow) headless browser.
 *
 * The curl-impersonate binary is installed into the Docker image (see
 * Dockerfile.api). When it is absent — e.g. local dev — every function here
 * degrades to a graceful no-op and the parser behaves exactly as before.
 *
 * Honest limits:
 *   - TLS impersonation does not defeat IP geo-blocks (Ozon/Yandex) or
 *     JavaScript challenges — those need the real headless browser.
 *   - Request headers (incl. Accept-Language) are whatever the curl_chromeNNN
 *     wrapper sends — Chrome's default en-US. The curl tier targets
 *     Cloudflare / Akamai-class anti-bot, which is predominantly US/global, so
 *     a per-marketplace locale is not threaded here; the plain-fetch and
 *     browser tiers already localise via the site registry.
 *   - Output is decoded as UTF-8. A page in a legacy charset (windows-1251,
 *     GBK) may garble — acceptable, as the curl tier's target sites are
 *     overwhelmingly UTF-8.
 *   - The bundled binary (curl-impersonate v0.6.1, lwthiker) replays a Chrome
 *     ~116 fingerprint — internally consistent (TLS + headers + Client Hints
 *     all 116), but older than the plain-fetch tier's Chrome 131 headers. The
 *     lwthiker repo is archived at v0.6.1; to refresh, point Dockerfile.api at
 *     the maintained `lexiforest/curl-impersonate` fork (newer Chrome builds).
 *
 * Env:
 *   CURL_IMPERSONATE_BIN              — binary path (default below)
 *   PARSER_CURL_IMPERSONATE_DISABLED  — kill switch (=1 ⇒ off)
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isIPv6 } from 'node:net';

const DEFAULT_BIN     = '/opt/curl-impersonate/curl-impersonate-wrapper';
const CURL_TIMEOUT_MS = 15_000;
// Soft secondary cap, in JS string length (chars). The hard byte cap is
// execFile's `maxBuffer` below — this just trims the already-decoded string.
const MAX_HTML_CHARS  = 3 * 1024 * 1024;

/** The curl-impersonate wrapper-script path (env-overridable). */
export function curlImpersonateBin(): string {
  return process.env.CURL_IMPERSONATE_BIN || DEFAULT_BIN;
}

/** Whether curl-impersonate can be used: not disabled, and the binary exists. */
export function isCurlImpersonateAvailable(): boolean {
  if (process.env.PARSER_CURL_IMPERSONATE_DISABLED === '1') return false;
  return existsSync(curlImpersonateBin());
}

/** A DNS pin — force curl to connect `host:port` to exactly this IP. */
export interface CurlPin {
  host: string;
  port: string;
  ip: string;
}

/**
 * Build the curl argv. No `-L` / redirect-following: a redirect to an internal
 * address would bypass the parser's SSRF guard, so redirects are refused
 * (`--max-redirs 0`). `--compressed` makes curl decode gzip / deflate / br.
 *
 * When `pin` is supplied, `--resolve` forces curl to connect to that exact
 * pre-validated IP — curl resolves DNS in its own process, so without the pin
 * a DNS-rebinding flip between validation and connect could reach an internal
 * host. The TLS-impersonation flags (ciphers, Client-Hint headers, --http2)
 * come from the `curl_chromeNNN` wrapper script itself; these args are appended.
 */
export function buildCurlImpersonateArgs(
  targetUrl: string,
  opts?: { pin?: CurlPin },
): string[] {
  const args = [
    '-s',                                          // no progress meter
    '--fail',                                      // non-2xx ⇒ non-zero exit
    '--compressed',                                // decode gzip/deflate/br
    '--max-redirs', '0',                           // SSRF guard: refuse redirects
    '--max-time', String(Math.ceil(CURL_TIMEOUT_MS / 1000)),
  ];
  if (opts?.pin) {
    const { host, port, ip } = opts.pin;
    const addr = isIPv6(ip) ? `[${ip}]` : ip;
    args.push('--resolve', `${host}:${port}:${addr}`);
  }
  args.push(targetUrl);
  return args;
}

/**
 * Fetch a URL's HTML through curl-impersonate. Throws when unavailable or on
 * any failure — the caller treats a throw as "try the next tier". Pass `pin`
 * to force the connection to a pre-validated IP (SSRF / DNS-rebinding guard).
 */
export async function fetchViaCurlImpersonate(
  targetUrl: string,
  opts?: { pin?: CurlPin },
): Promise<string> {
  if (!isCurlImpersonateAvailable()) throw new Error('curl_impersonate_unavailable');
  return await new Promise<string>((resolve, reject) => {
    execFile(
      curlImpersonateBin(),
      buildCurlImpersonateArgs(targetUrl, opts),
      { timeout: CURL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => {
        if (err) { reject(new Error(`curl_impersonate_failed:${err.message}`)); return; }
        const html = typeof stdout === 'string' ? stdout : '';
        if (html.length < 200) { reject(new Error('curl_impersonate_empty')); return; }
        resolve(html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html);
      },
    );
  });
}
