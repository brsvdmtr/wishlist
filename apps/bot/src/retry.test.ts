// Unit tests for the extracted retry helpers (Phase 5a — bot tests).
//
// The bot's in-process retry loop was added after incident 2026-04-26
// 14:30–14:37 UTC (4 process restarts during a deploy because every
// ETIMEDOUT was tagged transient:false). Pinning the classifier + retry
// behaviour here prevents a similar cascade from re-emerging silently.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from 'pino';
import {
  isTransientError,
  TRANSIENT_CODE_RE,
  redactToken,
  telegramErrorSummary,
  createRetryTgApi,
} from './retry';

function fakeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

describe('TRANSIENT_CODE_RE', () => {
  it('matches every known transient Node networking code', () => {
    const codes = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'];
    for (const c of codes) expect(TRANSIENT_CODE_RE.test(c)).toBe(true);
  });

  it('does not match unrelated codes', () => {
    for (const c of ['EACCES', 'ENOENT', 'EINVAL', 'EBADF']) {
      expect(TRANSIENT_CODE_RE.test(c)).toBe(false);
    }
  });

  it('is case-sensitive (NOT a typo guard against lowercased input)', () => {
    expect(TRANSIENT_CODE_RE.test('etimedout')).toBe(false);
  });
});

describe('isTransientError', () => {
  it('returns false for non-Error values', () => {
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError('ETIMEDOUT')).toBe(false);
    expect(isTransientError({ code: 'ETIMEDOUT' })).toBe(false);
  });

  it('returns true for AbortError', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    expect(isTransientError(e)).toBe(true);
  });

  it('returns true when err.code matches transient regex', () => {
    const e = Object.assign(new Error('x'), { code: 'ETIMEDOUT' });
    expect(isTransientError(e)).toBe(true);
  });

  it('returns true when err.errno matches transient regex', () => {
    const e = Object.assign(new Error('x'), { errno: 'ECONNRESET' });
    expect(isTransientError(e)).toBe(true);
  });

  it('returns true when err.message contains a known transient phrase (case-insensitive)', () => {
    expect(isTransientError(new Error('socket hang up'))).toBe(true);
    expect(isTransientError(new Error('Connection ETIMEDOUT'))).toBe(true);
    expect(isTransientError(new Error('NetWORK error'))).toBe(true);
  });

  it('returns true for HTTP 5xx (Telegram-side transient)', () => {
    const e = Object.assign(new Error('TG fail'), { code: 502 });
    expect(isTransientError(e)).toBe(true);
    const e2 = Object.assign(new Error('TG fail'), { code: 503 });
    expect(isTransientError(e2)).toBe(true);
  });

  it('returns false for HTTP 4xx', () => {
    const e = Object.assign(new Error('bad request'), { code: 400 });
    expect(isTransientError(e)).toBe(false);
    const e2 = Object.assign(new Error('forbidden'), { code: 403 });
    expect(isTransientError(e2)).toBe(false);
  });

  it('returns false for a plain Error with no recognisable signal', () => {
    expect(isTransientError(new Error('something went wrong'))).toBe(false);
  });
});

describe('redactToken', () => {
  it('replaces every occurrence of the token with [REDACTED]', () => {
    expect(redactToken('error using 1234:secret on https://api.telegram.org/bot1234:secret/x', '1234:secret'))
      .toBe('error using [REDACTED] on https://api.telegram.org/bot[REDACTED]/x');
  });

  it('passes string through unchanged when token is undefined', () => {
    expect(redactToken('safe value', undefined)).toBe('safe value');
  });

  it('passes string through unchanged when token is empty string', () => {
    expect(redactToken('safe value with TOKEN', '')).toBe('safe value with TOKEN');
  });
});

describe('telegramErrorSummary', () => {
  it('returns null code + redacted message for non-Error', () => {
    expect(telegramErrorSummary('something with TOKEN', 'TOKEN')).toEqual({
      errCode: null,
      errMessage: 'something with [REDACTED]',
    });
  });

  it('prefers string code over errno', () => {
    const e = Object.assign(new Error('x'), { code: 'ETIMEDOUT', errno: 'EOTHER' });
    expect(telegramErrorSummary(e, 't').errCode).toBe('ETIMEDOUT');
  });

  it('falls back to errno when code is absent', () => {
    const e = Object.assign(new Error('x'), { errno: 'ECONNRESET' });
    expect(telegramErrorSummary(e, 't').errCode).toBe('ECONNRESET');
  });

  it('falls back to numeric code stringified', () => {
    const e = Object.assign(new Error('x'), { code: 502 });
    expect(telegramErrorSummary(e, 't').errCode).toBe('502');
  });

  it('falls back to err.name when nothing else available', () => {
    const e = new Error('x');
    e.name = 'TelegramError';
    expect(telegramErrorSummary(e, 't').errCode).toBe('TelegramError');
  });

  it('returns null when even the name is generic "Error"', () => {
    expect(telegramErrorSummary(new Error('x'), 't').errCode).toBeNull();
  });

  it('redacts token from message', () => {
    const e = new Error('failed with TOKEN-123 in URL');
    expect(telegramErrorSummary(e, 'TOKEN-123').errMessage).toBe('failed with [REDACTED] in URL');
  });
});

describe('createRetryTgApi', () => {
  let logger: Logger;
  let retry: ReturnType<typeof createRetryTgApi>;

  beforeEach(() => {
    vi.useFakeTimers();
    logger = fakeLogger();
    retry = createRetryTgApi({ logger, token: 'TOKEN' });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('returns the function result on first-attempt success', async () => {
    const fn = vi.fn().mockResolvedValueOnce('ok');
    const result = await retry('test', fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('retries with exponential backoff on transient errors (1s, 2s, 4s)', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))
      .mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'ECONNRESET' }))
      .mockResolvedValueOnce('finally ok');

    const promise = retry('test', fn);
    await vi.advanceTimersByTimeAsync(1000); // after attempt 1
    await vi.advanceTimersByTimeAsync(2000); // after attempt 2
    const result = await promise;

    expect(result).toBe('finally ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('returns undefined and logs error after maxAttempts of transient failures', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }));
    const promise = retry('test', fn, { maxAttempts: 3 });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalled();
  });

  it('returns undefined immediately on a non-transient (permanent) error', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('bad request'));
    const result = await retry('test', fn);
    expect(result).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(1); // no retry
    expect(logger.error).toHaveBeenCalled();
  });

  it('bestEffort:true downgrades final transient failure to info-level log', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }));
    const promise = retry('startup-setMyCommands', fn, { bestEffort: true, maxAttempts: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    // best-effort + transient final failure → info, not error
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it('bestEffort:true does NOT downgrade non-transient errors', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('400 Bad Request'));
    await retry('test', fn, { bestEffort: true });
    expect(logger.error).toHaveBeenCalled(); // non-transient still logs at error
  });

  it('legacy numeric opts arg is treated as maxAttempts', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }));
    const promise = retry('test', fn, 2 as never);
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('redacts bot token in error logs', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('failure mentioning TOKEN in URL'));
    await retry('test', fn);
    const errorCall = (logger.error as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const meta = errorCall[0] as { errMessage: string };
    expect(meta.errMessage).toContain('[REDACTED]');
    expect(meta.errMessage).not.toContain('TOKEN');
  });
});
