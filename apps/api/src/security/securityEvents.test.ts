// Privacy regression: every security event helper that takes a `path:` field
// must pipe it through sanitizeUrlForLog before the value reaches the logger.
//
// Without this, /tg/search?q=<user query> would leak via:
//   - logRateLimited      (Free user hits the 30/min cap while typing)
//   - logIpThrottled      (IP throttle gate on suspicious traffic)
//   - logSuspiciousActivity / logIdemMissingOnCriticalEndpoint / …
// to the rotated daily log file (LOG_FILE_PATH, 14-day retention).
//
// This test pins the redaction at the boundary inside securityEvents.ts —
// future helpers that pass `path` will also get sanitised because the
// `redactPath` helper is applied uniformly.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../logger', () => ({
  default: {
    info: loggerMocks.info,
    warn: loggerMocks.warn,
    error: loggerMocks.error,
  },
}));

import {
  logRateLimited,
  logIpThrottled,
  logSuspiciousActivity,
  logIdempotencyConflict,
  logIdempotencyReplay,
  logIdemMissingOnCriticalEndpoint,
} from './securityEvents';

beforeEach(() => {
  loggerMocks.info.mockReset();
  loggerMocks.warn.mockReset();
  loggerMocks.error.mockReset();
});

const SECRET = 'мой-приватный-запрос';
const url = `/tg/search?q=${encodeURIComponent(SECRET)}&types=item`;

function loggedJson(): string {
  const calls = [...loggerMocks.info.mock.calls, ...loggerMocks.warn.mock.calls, ...loggerMocks.error.mock.calls];
  return JSON.stringify(calls);
}

describe('securityEvents redaction', () => {
  it('logRateLimited redacts ?q= before logging', () => {
    logRateLimited({
      path: url, method: 'GET', actorHash: 'a', ipHash: 'i',
      limitKey: 'search', retryAfterSec: 30, uaHash: 'u',
    });
    const json = loggedJson();
    expect(json).not.toMatch(SECRET);
    expect(json).not.toMatch(encodeURIComponent(SECRET));
    expect(json).toMatch(/REDACTED/);
  });

  it('logIpThrottled redacts ?q= before logging', () => {
    logIpThrottled({
      path: url, method: 'GET', ipHash: 'i',
      reason: 'auth_rejected', retryAfterSec: 300,
    });
    expect(loggedJson()).not.toMatch(SECRET);
  });

  it('logSuspiciousActivity redacts ?q= before logging', () => {
    logSuspiciousActivity({
      path: url, method: 'GET', actorHash: 'a', ipHash: 'i',
      reason: 'unauth_post',
    });
    expect(loggedJson()).not.toMatch(SECRET);
  });

  it('logIdempotencyReplay redacts ?q= before logging', () => {
    logIdempotencyReplay({
      path: url, method: 'GET', actorHash: 'a', ipHash: 'i',
      keyHash: 'k', originalCreatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    expect(loggedJson()).not.toMatch(SECRET);
  });

  it('logIdempotencyConflict redacts ?q= before logging', () => {
    logIdempotencyConflict({
      path: url, method: 'GET', actorHash: 'a', ipHash: 'i',
      keyHash: 'k', reason: 'different_request',
    });
    expect(loggedJson()).not.toMatch(SECRET);
  });

  it('logIdemMissingOnCriticalEndpoint redacts ?q= before logging', () => {
    logIdemMissingOnCriticalEndpoint({
      path: url, method: 'GET', actorHash: 'a', ipHash: 'i',
      reason: 'no_header',
    });
    expect(loggedJson()).not.toMatch(SECRET);
  });

  it('preserves non-sensitive query params', () => {
    logRateLimited({
      path: '/tg/search?types=item&limit=5',
      method: 'GET', actorHash: 'a', ipHash: 'i',
      limitKey: 'search', retryAfterSec: 30, uaHash: 'u',
    });
    const json = loggedJson();
    expect(json).toMatch(/types=item/);
    expect(json).toMatch(/limit=5/);
  });

  it('passes through paths with no query string unchanged', () => {
    logRateLimited({
      path: '/tg/wishlists',
      method: 'POST', actorHash: 'a', ipHash: 'i',
      limitKey: 'wishlist.create', retryAfterSec: 60, uaHash: 'u',
    });
    expect(loggedJson()).toMatch(/\/tg\/wishlists/);
  });
});
