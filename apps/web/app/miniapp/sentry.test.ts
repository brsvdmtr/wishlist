// Tests for sentry.ts — initialization idempotency + captureException
// no-op when not initialised. Sentry is loaded via dynamic import so the
// bundle stays lean; the test ensures `captureException` doesn't crash
// before init and `initSentry` is a no-op when DSN is missing.

import { describe, it, expect, beforeEach } from 'vitest';
import { initSentry, captureException } from './sentry';

describe('initSentry', () => {
  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_GLITCHTIP_DSN;
  });

  it('is a no-op when DSN env var is not set', () => {
    // Synchronous return — no throw — when DSN missing.
    expect(() => initSentry()).not.toThrow();
  });

  it('is safe to call multiple times (initialization guard)', () => {
    expect(() => {
      initSentry();
      initSentry();
      initSentry();
    }).not.toThrow();
  });
});

describe('captureException', () => {
  it('is a no-op when Sentry not initialised (must not throw)', () => {
    expect(() => captureException(new Error('test'))).not.toThrow();
  });

  it('accepts optional context without throwing', () => {
    expect(() => captureException(new Error('x'), { userId: '123' })).not.toThrow();
  });

  it('handles non-Error values without throwing', () => {
    expect(() => captureException('string error')).not.toThrow();
    expect(() => captureException({ weird: 'object' })).not.toThrow();
    expect(() => captureException(null)).not.toThrow();
    expect(() => captureException(undefined)).not.toThrow();
  });
});
