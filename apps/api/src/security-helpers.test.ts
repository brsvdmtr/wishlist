import { describe, it, expect, afterEach } from 'vitest';
import { stableStringify, computeRequestHash } from './security/requestHash';
import { hashIp, hashIdempotencyKey, hashUserAgent } from './security/ipHash';
import {
  IDEMPOTENCY_KEY_REGEX,
  isSecurityFeatureEnabled,
  VOLATILE_BODY_FIELDS,
} from './security/types';

// ─── stableStringify ─────────────────────────────────────────────────────────

describe('stableStringify', () => {
  it('produces same output regardless of key order', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
    expect(stableStringify({ x: { a: 1, b: 2 } })).toBe(stableStringify({ x: { b: 2, a: 1 } }));
  });

  it('drops volatile fields at root', () => {
    const withVolatile = stableStringify({ title: 'foo', clientEventId: 'evt-1' });
    const without = stableStringify({ title: 'foo' });
    expect(withVolatile).toBe(without);
  });

  it('drops volatile fields at nested levels', () => {
    const a = stableStringify({ inner: { title: 'foo', traceId: 'tr-1' } });
    const b = stableStringify({ inner: { title: 'foo' } });
    expect(a).toBe(b);
  });

  it('handles arrays without sorting their elements', () => {
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]');
    expect(stableStringify([{ b: 1, a: 2 }])).toBe('[{"a":2,"b":1}]');
  });

  it('represents null and undefined as JSON null', () => {
    expect(stableStringify(null)).toBe('null');
    expect(stableStringify(undefined)).toBe('null');
  });
});

// ─── computeRequestHash ──────────────────────────────────────────────────────

describe('computeRequestHash', () => {
  const base = { method: 'POST', originalUrl: '/tg/wishlists', actorKey: 'actor-A', body: { x: 1 }, query: {} };

  it('is deterministic for identical input', () => {
    expect(computeRequestHash(base)).toBe(computeRequestHash({ ...base }));
  });

  it('changes when literal :id in URL changes', () => {
    const a = computeRequestHash({ ...base, originalUrl: '/tg/items/abc/reserve' });
    const b = computeRequestHash({ ...base, originalUrl: '/tg/items/xyz/reserve' });
    expect(a).not.toBe(b);
  });

  it('changes when body changes', () => {
    const a = computeRequestHash({ ...base, body: { x: 1 } });
    const b = computeRequestHash({ ...base, body: { x: 2 } });
    expect(a).not.toBe(b);
  });

  it('changes when actor changes', () => {
    const a = computeRequestHash({ ...base, actorKey: 'A' });
    const b = computeRequestHash({ ...base, actorKey: 'B' });
    expect(a).not.toBe(b);
  });

  it('changes when method changes', () => {
    expect(computeRequestHash({ ...base, method: 'POST' }))
      .not.toBe(computeRequestHash({ ...base, method: 'PATCH' }));
  });

  it('does NOT change when only volatile fields change', () => {
    const a = computeRequestHash({ ...base, body: { title: 'foo', clientEventId: 'a' } });
    const b = computeRequestHash({ ...base, body: { title: 'foo', clientEventId: 'b' } });
    expect(a).toBe(b);
  });

  it('produces a 64-char hex digest', () => {
    expect(computeRequestHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── hashIp / hashIdempotencyKey / hashUserAgent ─────────────────────────────

describe('hashIp', () => {
  it('is deterministic', () => {
    expect(hashIp('1.2.3.4')).toBe(hashIp('1.2.3.4'));
  });

  it('produces different output for different IPs', () => {
    expect(hashIp('1.2.3.4')).not.toBe(hashIp('5.6.7.8'));
  });

  it('returns 16 hex chars and never echoes the original IP', () => {
    const h = hashIp('1.2.3.4');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
    expect(h).not.toContain('1.2.3.4');
  });
});

describe('hashIdempotencyKey', () => {
  it('returns 16 hex chars', () => {
    expect(hashIdempotencyKey('some-uuid-key-12345')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('never echoes the original key', () => {
    const k = '12345678-aaaa-bbbb-cccc-1234567890ab';
    const h = hashIdempotencyKey(k);
    expect(h).not.toContain(k);
    expect(h).not.toContain('12345678');
    expect(h).not.toContain('1234567890ab');
  });
});

describe('hashUserAgent', () => {
  it('returns a fixed-length token even for empty/missing UA', () => {
    expect(hashUserAgent(undefined)).toBe('none');
    expect(hashUserAgent('Mozilla/5.0')).toMatch(/^[0-9a-f]{16}$/);
  });
});

// ─── IDEMPOTENCY_KEY_REGEX ───────────────────────────────────────────────────

describe('IDEMPOTENCY_KEY_REGEX', () => {
  it('accepts a UUID v4', () => {
    expect(IDEMPOTENCY_KEY_REGEX.test('12345678-1234-1234-1234-123456789012')).toBe(true);
  });

  it('accepts our fallback "idem_*" format', () => {
    expect(IDEMPOTENCY_KEY_REGEX.test('idem_1234567890_abcdef')).toBe(true);
  });

  it('accepts the 16-char minimum', () => {
    expect(IDEMPOTENCY_KEY_REGEX.test('a'.repeat(16))).toBe(true);
  });

  it('accepts the 128-char maximum', () => {
    expect(IDEMPOTENCY_KEY_REGEX.test('a'.repeat(128))).toBe(true);
  });

  it('rejects 15-char (too short)', () => {
    expect(IDEMPOTENCY_KEY_REGEX.test('a'.repeat(15))).toBe(false);
  });

  it('rejects 129-char (too long)', () => {
    expect(IDEMPOTENCY_KEY_REGEX.test('a'.repeat(129))).toBe(false);
  });

  it('rejects whitespace, slashes, and other unsafe characters', () => {
    expect(IDEMPOTENCY_KEY_REGEX.test('a'.repeat(16) + ' ')).toBe(false);
    expect(IDEMPOTENCY_KEY_REGEX.test('a'.repeat(16) + '/')).toBe(false);
    expect(IDEMPOTENCY_KEY_REGEX.test('a'.repeat(16) + '.')).toBe(false);
    expect(IDEMPOTENCY_KEY_REGEX.test('a'.repeat(16) + '{')).toBe(false);
  });
});

// ─── isSecurityFeatureEnabled ────────────────────────────────────────────────

describe('isSecurityFeatureEnabled', () => {
  const ORIG = { ...process.env };
  afterEach(() => { process.env = { ...ORIG }; });

  it('returns false when explicitly disabled', () => {
    process.env.X_TEST_FLAG = 'false';
    expect(isSecurityFeatureEnabled('X_TEST_FLAG')).toBe(false);
  });

  it('returns true when explicitly enabled', () => {
    process.env.X_TEST_FLAG = 'true';
    expect(isSecurityFeatureEnabled('X_TEST_FLAG')).toBe(true);
  });

  it('defaults to false in NODE_ENV=test when not set', () => {
    delete process.env.X_TEST_FLAG;
    process.env.NODE_ENV = 'test';
    expect(isSecurityFeatureEnabled('X_TEST_FLAG')).toBe(false);
  });

  it('defaults to true in production when not set', () => {
    delete process.env.X_TEST_FLAG;
    process.env.NODE_ENV = 'production';
    expect(isSecurityFeatureEnabled('X_TEST_FLAG')).toBe(true);
  });

  it('treats "0", "no", "off" as disabled', () => {
    for (const v of ['0', 'no', 'off']) {
      process.env.X_TEST_FLAG = v;
      expect(isSecurityFeatureEnabled('X_TEST_FLAG')).toBe(false);
    }
  });

  it('treats "1", "yes", "on" as enabled', () => {
    for (const v of ['1', 'yes', 'on']) {
      process.env.X_TEST_FLAG = v;
      expect(isSecurityFeatureEnabled('X_TEST_FLAG')).toBe(true);
    }
  });
});

// ─── VOLATILE_BODY_FIELDS coverage ───────────────────────────────────────────

describe('VOLATILE_BODY_FIELDS', () => {
  it('includes the agreed list', () => {
    const required = [
      'clientEventId',
      '__retryAttempt',
      '__telemetry',
      'clientTimestamp',
      'localTimestamp',
      'traceId',
      'requestId',
      'analyticsSessionId',
      'bootSessionId',
    ];
    for (const f of required) {
      expect(VOLATILE_BODY_FIELDS.has(f)).toBe(true);
    }
  });

  it('does NOT include common business fields', () => {
    for (const f of ['title', 'price', 'wishlistId', 'itemIds', 'plan']) {
      expect(VOLATILE_BODY_FIELDS.has(f)).toBe(false);
    }
  });
});
