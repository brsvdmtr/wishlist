// Unit tests for sanitizeAnalyticsProps — the PII guard on AnalyticsEvent.props.
//
// Contract pinned here:
//   1. User-content keys (title / description / comment / hint / search /
//      freeform notes / person names) are DROPPED.
//   2. Privacy-safe props (ids, enums, counts, booleans, hashes, lengths) are
//      KEPT unchanged.
//   3. Oversized string values are truncated; an oversized total collapses to
//      { _truncated: true }.
//   4. Non-serializable input (circular refs, BigInt) never throws — it
//      collapses to { _truncated: true }.
//
// If this test changes, docs/research/analytics-pii-audit.md must change too.

import { describe, it, expect } from 'vitest';
import {
  sanitizeAnalyticsProps,
  ANALYTICS_PII_PROP_KEYS,
  ANALYTICS_PROP_MAX_STRING_LEN,
  ANALYTICS_PROPS_MAX_SERIALIZED_LEN,
} from './sanitizeAnalyticsProps';

describe('sanitizeAnalyticsProps — PII key stripping', () => {
  it('drops item title and description', () => {
    const out = sanitizeAnalyticsProps({
      itemId: 'i1',
      title: 'My secret birthday wish',
      description: 'Long personal note about why I want this',
    });
    expect(out).toEqual({ itemId: 'i1' });
  });

  it('drops comment / hint / search / freeform-note content keys', () => {
    const out = sanitizeAnalyticsProps({
      itemId: 'i1',
      commentText: 'a private comment',
      hintText: 'a private hint',
      query: 'what the user searched for',
      note: 'a freeform note',
      message: 'a custom message',
      answerText: 'a survey free-text answer',
      adminNote: 'an admin moderation note',
    });
    expect(out).toEqual({ itemId: 'i1' });
  });

  it('matches PII keys case-insensitively', () => {
    const out = sanitizeAnalyticsProps({
      itemId: 'i1',
      Title: 'x',
      DESCRIPTION: 'y',
      CommentText: 'z',
    });
    expect(out).toEqual({ itemId: 'i1' });
  });

  it('drops a PII key regardless of its value type', () => {
    // Keyed on the NAME, not the value — a numeric/null `title` still goes.
    const out = sanitizeAnalyticsProps({ itemId: 'i1', title: 123, description: null });
    expect(out).toEqual({ itemId: 'i1' });
  });

  it('drops person-name keys (freeform PII)', () => {
    const out = sanitizeAnalyticsProps({
      userId: 'u1',
      name: 'Ivan',
      firstName: 'Ivan',
      lastName: 'Petrov',
    });
    expect(out).toEqual({ userId: 'u1' });
  });

  it('drops generic free-text and contact/location keys', () => {
    const out = sanitizeAnalyticsProps({
      itemId: 'i1',
      content: 'a freeform body',
      input: 'raw user input',
      subject: 'a subject line',
      summary: 'a summary',
      address: '123 Main St',
      city: 'Springfield',
    });
    expect(out).toEqual({ itemId: 'i1' });
  });

  it('strips PII even when every key is PII (returns an empty object)', () => {
    expect(sanitizeAnalyticsProps({ title: 'a', description: 'b' })).toEqual({});
  });
});

describe('sanitizeAnalyticsProps — allowed props are preserved', () => {
  it('keeps ids, enums, counts, booleans, and derived shape signals', () => {
    const props = {
      itemId: 'i1',
      wishlistId: 'w1',
      wishlistType: 'REGULAR',
      source: 'manual',
      platform: 'miniapp',
      isFirstItem: true,
      count: 7,
      limit: 10,
      // privacy-safe signals derived FROM user content — must survive
      titleLength: 42,
      hasText: true,
      hasComment: false,
      normalizedQueryHash: 'a1b2c3d4',
      queryLength: 12,
    };
    expect(sanitizeAnalyticsProps(props)).toEqual(props);
  });

  it('does not mutate the input object', () => {
    const input = { itemId: 'i1', title: 'drop me' };
    sanitizeAnalyticsProps(input);
    expect(input).toEqual({ itemId: 'i1', title: 'drop me' });
  });

  it('passes nested objects through untouched (documented top-level-only limit)', () => {
    const out = sanitizeAnalyticsProps({ itemId: 'i1', meta: { nested: 'value' } });
    expect(out).toEqual({ itemId: 'i1', meta: { nested: 'value' } });
  });
});

describe('sanitizeAnalyticsProps — truncation', () => {
  it('truncates an over-long string prop to the cap + "..."', () => {
    const long = 'x'.repeat(ANALYTICS_PROP_MAX_STRING_LEN + 200);
    const out = sanitizeAnalyticsProps({ reason: long })!;
    expect((out.reason as string).length).toBe(ANALYTICS_PROP_MAX_STRING_LEN + 3);
    expect((out.reason as string).endsWith('...')).toBe(true);
  });

  it('leaves a string at exactly the cap untouched', () => {
    const exact = 'x'.repeat(ANALYTICS_PROP_MAX_STRING_LEN);
    const out = sanitizeAnalyticsProps({ reason: exact })!;
    expect(out.reason).toBe(exact);
  });

  it('truncates a multibyte (emoji) string without throwing — slices by code unit', () => {
    // .slice()/.length operate on UTF-16 code units; each emoji is 2 units,
    // so this 600-code-unit string is still capped to 303 (a surrogate pair
    // may be split — acceptable for a length cap, and no exception is thrown).
    const emoji = '\u{1F600}'.repeat(ANALYTICS_PROP_MAX_STRING_LEN);
    const out = sanitizeAnalyticsProps({ reason: emoji })!;
    expect(typeof out.reason).toBe('string');
    expect((out.reason as string).length).toBe(ANALYTICS_PROP_MAX_STRING_LEN + 3);
  });

  it('collapses to { _truncated: true } when the total serialized size exceeds the cap', () => {
    // 10 props of 200 chars each — none individually over the per-string cap,
    // but the serialized whole is well over ANALYTICS_PROPS_MAX_SERIALIZED_LEN.
    const props: Record<string, string> = {};
    for (let i = 0; i < 10; i++) props[`k${i}`] = 'a'.repeat(200);
    expect(sanitizeAnalyticsProps(props)).toEqual({ _truncated: true });
  });

  it('drops PII before the size check — PII bulk never triggers _truncated', () => {
    // A huge `description` is dropped, so the surviving props stay small.
    const out = sanitizeAnalyticsProps({
      itemId: 'i1',
      description: 'a'.repeat(5000),
    });
    expect(out).toEqual({ itemId: 'i1' });
  });
});

describe('sanitizeAnalyticsProps — never throws on non-serializable input', () => {
  it('returns { _truncated: true } for a circular reference (does not throw)', () => {
    const circular: Record<string, unknown> = { itemId: 'i1' };
    circular.self = circular;
    expect(() => sanitizeAnalyticsProps(circular)).not.toThrow();
    expect(sanitizeAnalyticsProps(circular)).toEqual({ _truncated: true });
  });

  it('returns { _truncated: true } for a BigInt value (does not throw)', () => {
    expect(() => sanitizeAnalyticsProps({ count: BigInt(5) })).not.toThrow();
    expect(sanitizeAnalyticsProps({ count: BigInt(5) })).toEqual({ _truncated: true });
  });
});

describe('sanitizeAnalyticsProps — empty / nullish input', () => {
  it('returns undefined for undefined', () => {
    expect(sanitizeAnalyticsProps(undefined)).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(sanitizeAnalyticsProps(null)).toBeUndefined();
  });

  it('returns an empty object for empty props', () => {
    expect(sanitizeAnalyticsProps({})).toEqual({});
  });
});

describe('ANALYTICS_PII_PROP_KEYS contract', () => {
  it('contains the content categories named in the audit', () => {
    for (const k of ['title', 'description', 'commenttext', 'hinttext', 'query', 'answertext', 'bio', 'adminnote', 'content', 'input', 'subject', 'summary', 'address', 'city']) {
      expect(ANALYTICS_PII_PROP_KEYS.has(k)).toBe(true);
    }
  });

  it('is all-lowercase (lookup lowercases the incoming key)', () => {
    for (const k of ANALYTICS_PII_PROP_KEYS) {
      expect(k).toBe(k.toLowerCase());
    }
  });

  it('exposes ordered size caps', () => {
    expect(ANALYTICS_PROP_MAX_STRING_LEN).toBeGreaterThan(0);
    expect(ANALYTICS_PROPS_MAX_SERIALIZED_LEN).toBeGreaterThan(ANALYTICS_PROP_MAX_STRING_LEN);
  });
});
