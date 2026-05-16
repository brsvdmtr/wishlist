// Privacy regression: pino-http must not persist raw search queries.
//
// Background: /tg/search?q=<user query> hits the request logger BEFORE the
// route handler. By default pino-http logs `req.url` verbatim, which would
// land the raw query in the rotated daily log file (LOG_FILE_PATH, 14-day
// retention). See docs/GLOBAL_SEARCH.md "Raw query is never logged".

import { describe, it, expect } from 'vitest';
import { sanitizeUrlForLog } from '../lib/logSafety';

describe('sanitizeUrlForLog', () => {
  it('passes through URLs without a query string', () => {
    expect(sanitizeUrlForLog('/tg/wishlists')).toBe('/tg/wishlists');
  });

  it('passes through URLs that do not carry a redacted key', () => {
    expect(sanitizeUrlForLog('/tg/search?types=item&limit=5')).toBe(
      '/tg/search?types=item&limit=5',
    );
  });

  it('replaces the `q` value with [REDACTED] while keeping other params', () => {
    const out = sanitizeUrlForLog('/tg/search?q=very-secret&types=item');
    expect(out).toBe('/tg/search?q=%5BREDACTED%5D&types=item');
    expect(out).not.toMatch(/very-secret/);
  });

  it('redacts even when `q` is the only parameter', () => {
    const out = sanitizeUrlForLog('/tg/search?q=наушники');
    expect(out).not.toMatch(/наушники/);
    expect(out).toMatch(/q=/);
  });

  it('redacts even when the URL-encoded query contains spaces', () => {
    const out = sanitizeUrlForLog('/tg/search?q=hello%20world&types=item');
    expect(out).not.toMatch(/hello/);
    expect(out).not.toMatch(/world/);
  });

  it('handles malformed URLs by dropping the entire query string', () => {
    // The URL parser is lenient — most malformed inputs parse. The safety
    // net here is the catch branch: confirm that if it ever fires, no raw
    // user input leaks through.
    const out = sanitizeUrlForLog('http://[malformed:?q=secret');
    expect(out).not.toMatch(/secret/);
  });

  it('returns the input untouched for undefined / empty', () => {
    expect(sanitizeUrlForLog(undefined)).toBeUndefined();
    expect(sanitizeUrlForLog('')).toBe('');
  });

  it('does not surface the raw query inside any returned substring', () => {
    // Belt-and-braces: regardless of encoding, the literal "наушники"
    // string must never appear anywhere in the sanitized output.
    const secret = 'мой-приватный-запрос';
    const out = sanitizeUrlForLog(`/tg/search?q=${encodeURIComponent(secret)}&types=item`);
    expect(out?.includes(secret)).toBe(false);
    expect(out?.includes(encodeURIComponent(secret))).toBe(false);
  });
});
