// Centralised redaction for log fields that may carry sensitive user input.
//
// Background — privacy invariant from docs/GLOBAL_SEARCH.md:
//   "Raw user query never persisted to logs or analytics."
//
// The /tg/search route's `q` query parameter carries arbitrary user-typed
// text. Several log paths could otherwise persist it to the rotated daily
// log file at LOG_FILE_PATH (14-day retention):
//
//   1. pino-http auto-logged `req` serializer            — middleware/requestLogger.ts
//   2. Sentry `event.request.url` / `event.request.query_string`
//                                                        — bootstrap/sentry.ts
//   3. security/* helpers that pass `req.originalUrl` as a structured
//      `path:` field on rate-limit / IP-throttle / suspicious-activity
//      events                                            — security/securityEvents.ts
//
// EVERY call site that takes a raw URL and emits it to the logger or to a
// remote error tracker MUST route the value through `sanitizeUrlForLog`
// FIRST. Centralising the helper here means a future log emitter can opt-in
// with a single import and inherit the redaction policy.
//
// The redaction list is intentionally small and route-targeted; we do NOT
// scrub arbitrary query params because over-redaction hurts ops debugging.
//
// To extend: add the query-string key to `REDACTED_QUERY_KEYS` below and
// add a regression test to `logSafety.test.ts`.

const REDACTED_QUERY_KEYS = new Set([
  'q', // /tg/search raw user query (privacy: see GLOBAL_SEARCH.md)
]);

/**
 * Return the input URL with REDACTED_QUERY_KEYS values replaced by
 * '[REDACTED]'. Pure / idempotent / never throws.
 *
 *   sanitizeUrlForLog('/tg/search?q=secret&types=item')
 *     → '/tg/search?q=%5BREDACTED%5D&types=item'
 *
 * Behaviour:
 *   - No query string → returned unchanged.
 *   - Parse failure   → drops the entire query string (safe-fallback).
 *   - undefined/empty → returned unchanged.
 */
export function sanitizeUrlForLog(rawUrl: string | undefined | null): string | undefined {
  if (rawUrl == null) return rawUrl ?? undefined;
  if (rawUrl === '') return '';
  const qIdx = rawUrl.indexOf('?');
  if (qIdx === -1) return rawUrl;
  try {
    const u = new URL(rawUrl, 'http://placeholder.invalid');
    let touched = false;
    for (const key of REDACTED_QUERY_KEYS) {
      if (u.searchParams.has(key)) {
        u.searchParams.set(key, '[REDACTED]');
        touched = true;
      }
    }
    if (!touched) return rawUrl;
    return u.pathname + (u.search || '');
  } catch {
    return rawUrl.slice(0, qIdx) + '?[UNPARSEABLE_QUERY_REDACTED]';
  }
}
