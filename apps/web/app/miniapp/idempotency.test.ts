import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  newIdempotencyKey,
  getOrCreateActionKey,
  clearActionKey,
  clearAllActionKeys,
  hashKeyForLog,
  KEY_CLEAR_CODES,
  KEY_KEEP_CODES,
  SECURITY_TOAST_CODES,
  CLIENT_BUG_CODES,
} from './idempotency';

// Run with the root `pnpm test` (vitest scans all packages). The helper has
// no React / DOM dependencies — pure functions over module-scoped state.

beforeEach(() => clearAllActionKeys());
afterEach(() => clearAllActionKeys());

// ─── newIdempotencyKey ───────────────────────────────────────────────────────

describe('newIdempotencyKey', () => {
  it('returns a unique string each call', () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(typeof a).toBe('string');
    expect(typeof b).toBe('string');
    expect(a).not.toBe(b);
  });

  it('returns either a UUID or our idem_* fallback', () => {
    const k = newIdempotencyKey();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const fallback = /^idem_[a-z0-9]+_[a-z0-9]+$/;
    expect(uuid.test(k) || fallback.test(k)).toBe(true);
  });

  it('always satisfies the server-side regex', () => {
    const serverRegex = /^[A-Za-z0-9_-]{16,128}$/;
    for (let i = 0; i < 50; i++) {
      const k = newIdempotencyKey();
      expect(serverRegex.test(k)).toBe(true);
    }
  });
});

// ─── getOrCreateActionKey / clearActionKey ───────────────────────────────────

describe('action-key cache lifecycle', () => {
  it('returns the same key on subsequent calls for the same action', () => {
    const a = getOrCreateActionKey('wishlist.create');
    const b = getOrCreateActionKey('wishlist.create');
    expect(a).toBe(b);
  });

  it('returns different keys for different actions', () => {
    const a = getOrCreateActionKey('wishlist.create');
    const b = getOrCreateActionKey('item.delete:abc');
    expect(a).not.toBe(b);
  });

  it('mints a fresh key after clearActionKey', () => {
    const a = getOrCreateActionKey('wishlist.create');
    clearActionKey('wishlist.create');
    const b = getOrCreateActionKey('wishlist.create');
    expect(b).not.toBe(a);
  });

  it('clearActionKey on a non-existent action is a no-op', () => {
    expect(() => clearActionKey('never.created')).not.toThrow();
  });

  it('clearAllActionKeys empties the cache', () => {
    const a = getOrCreateActionKey('one');
    getOrCreateActionKey('two');
    clearAllActionKeys();
    const aFresh = getOrCreateActionKey('one');
    expect(aFresh).not.toBe(a);
  });

  it('entity-scoped actions stay isolated by ID', () => {
    const k1 = getOrCreateActionKey('item.delete:item-1');
    const k2 = getOrCreateActionKey('item.delete:item-2');
    expect(k1).not.toBe(k2);
    // Clearing one must not affect the other
    clearActionKey('item.delete:item-1');
    const k2Again = getOrCreateActionKey('item.delete:item-2');
    expect(k2Again).toBe(k2);
  });
});

// ─── hashKeyForLog ───────────────────────────────────────────────────────────

describe('hashKeyForLog', () => {
  it('returns a fixed-length 8-hex fingerprint', () => {
    const k = '12345678-aaaa-bbbb-cccc-1234567890ab';
    expect(hashKeyForLog(k)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('is deterministic for the same input', () => {
    const k = '12345678-aaaa-bbbb-cccc-1234567890ab';
    expect(hashKeyForLog(k)).toBe(hashKeyForLog(k));
  });

  it('produces different output for different inputs', () => {
    const a = hashKeyForLog('12345678-aaaa-bbbb-cccc-1234567890ab');
    const b = hashKeyForLog('zzzzzzzz-aaaa-bbbb-cccc-1234567890ab');
    expect(a).not.toBe(b);
  });

  it('never echoes the original key', () => {
    const k = '12345678-aaaa-bbbb-cccc-1234567890ab';
    const h = hashKeyForLog(k);
    expect(h).not.toContain(k);
    expect(h).not.toContain('12345678');
    expect(h).not.toContain('1234567890ab');
  });
});

// ─── Code-set membership (must match server source of truth) ─────────────────

describe('KEY_CLEAR_CODES — codes that drop the cached key', () => {
  it.each([
    'IDEMPOTENCY_KEY_STALE',
    'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
    'IDEMPOTENCY_RESPONSE_NOT_REPLAYABLE',
    'IDEMPOTENCY_RESPONSE_TOO_LARGE',
    'IDEMPOTENCY_ACTOR_MISMATCH',
    'INVALID_IDEMPOTENCY_KEY',
  ])('includes %s', (code) => {
    expect(KEY_CLEAR_CODES.has(code)).toBe(true);
  });

  it('does NOT include keep-class codes', () => {
    for (const code of ['IDEMPOTENCY_REQUEST_IN_PROGRESS', 'RATE_LIMITED', 'IP_THROTTLED']) {
      expect(KEY_CLEAR_CODES.has(code)).toBe(false);
    }
  });
});

describe('KEY_KEEP_CODES — codes that retain the cached key', () => {
  it.each([
    'IDEMPOTENCY_REQUEST_IN_PROGRESS',
    'IDEMPOTENCY_FAILED_RECENTLY',
    'RATE_LIMITED',
    'IP_THROTTLED',
  ])('includes %s', (code) => {
    expect(KEY_KEEP_CODES.has(code)).toBe(true);
  });
});

describe('CLIENT_BUG_CODES — codes that signal a frontend bug', () => {
  it.each([
    'INVALID_IDEMPOTENCY_KEY',
    'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
    'IDEMPOTENCY_ACTOR_MISMATCH',
  ])('includes %s', (code) => {
    expect(CLIENT_BUG_CODES.has(code)).toBe(true);
  });

  it('CLIENT_BUG_CODES is a subset of KEY_CLEAR_CODES', () => {
    for (const code of CLIENT_BUG_CODES) {
      expect(KEY_CLEAR_CODES.has(code)).toBe(true);
    }
  });
});

describe('SECURITY_TOAST_CODES — codes that get a centralised user-facing toast', () => {
  it('contains at least the rate-limit + idempotency families', () => {
    const required = [
      'RATE_LIMITED',
      'IP_THROTTLED',
      'IDEMPOTENCY_REQUEST_IN_PROGRESS',
      'IDEMPOTENCY_KEY_STALE',
    ];
    for (const code of required) {
      expect(SECURITY_TOAST_CODES.has(code)).toBe(true);
    }
  });
});

// ─── Realistic flows ─────────────────────────────────────────────────────────

describe('realistic action flows', () => {
  it('first-attempt + manual-retry uses the same key', () => {
    const k1 = getOrCreateActionKey('wishlist.create');
    // Simulate transient failure: caller did NOT call clearActionKey
    const k2 = getOrCreateActionKey('wishlist.create');
    expect(k2).toBe(k1);
  });

  it('success → key cleared → next attempt mints fresh', () => {
    const k1 = getOrCreateActionKey('wishlist.create');
    clearActionKey('wishlist.create'); // success path
    const k2 = getOrCreateActionKey('wishlist.create');
    expect(k2).not.toBe(k1);
  });

  it('billing checkout: distinct keys per plan', () => {
    const monthly = getOrCreateActionKey('billing.pro.checkout:monthly');
    const yearly = getOrCreateActionKey('billing.pro.checkout:yearly');
    expect(monthly).not.toBe(yearly);
  });

  it('bulk action: same sorted itemIds → same key (manual retry safe)', () => {
    const ids = ['c', 'a', 'b'];
    const sortedJoin = (xs: string[]) => [...xs].sort().join(',');
    const k1 = getOrCreateActionKey(`item.bulk-delete:${sortedJoin(ids)}`);
    // Same set, different input order — sort makes the action key stable
    const k2 = getOrCreateActionKey(`item.bulk-delete:${sortedJoin(['b', 'a', 'c'])}`);
    expect(k2).toBe(k1);
  });
});
