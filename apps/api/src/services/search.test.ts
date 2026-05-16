// Pure-helper unit tests for services/search.ts. Heavy Prisma paths
// (per-group searchers) are intentionally NOT covered here — they need
// integration tests against a real Postgres (TESTING_ROADMAP § integration).
// What's covered:
//   - normalizeSearchQuery: trim, lowercase, whitespace collapse, NFKC
//   - escapeLikePattern:    %, _, \ all escaped
//   - expandQueryAliases:   bidirectional RU/EN expansion, capped at 4
//   - SEARCH_MIN_QUERY / SEARCH_MAX_QUERY constants exported

import { describe, it, expect, vi } from 'vitest';

// Block Prisma import — these tests only exercise pure helpers.
vi.mock('@wishlist/db', () => ({
  prisma: new Proxy({}, {
    get() { return new Proxy({}, { get() { return vi.fn(); } }); },
  }),
  Prisma: {},
}));
vi.mock('./entitlement', () => ({
  getUserEntitlement: vi.fn().mockResolvedValue({ isPro: false, proSource: null }),
}));

import {
  normalizeSearchQuery,
  escapeLikePattern,
  expandQueryAliases,
  SEARCH_MIN_QUERY,
  SEARCH_MAX_QUERY,
  SEARCH_DEFAULT_GROUP_LIMIT,
} from './search';

describe('normalizeSearchQuery', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeSearchQuery('   наушники   ')).toBe('наушники');
  });

  it('lower-cases letters (including non-ASCII)', () => {
    expect(normalizeSearchQuery('НАУШНИКИ')).toBe('наушники');
    expect(normalizeSearchQuery('Sony WH-1000XM5')).toBe('sony wh-1000xm5');
  });

  it('collapses internal whitespace runs', () => {
    expect(normalizeSearchQuery('  день   рождения  ')).toBe('день рождения');
    expect(normalizeSearchQuery('a\t\nb')).toBe('a b');
  });

  it('returns empty string for missing input', () => {
    expect(normalizeSearchQuery('')).toBe('');
    expect(normalizeSearchQuery('   ')).toBe('');
    // @ts-expect-error — runtime guard for non-string inputs.
    expect(normalizeSearchQuery(null)).toBe('');
    // @ts-expect-error
    expect(normalizeSearchQuery(undefined)).toBe('');
  });

  it('normalises NFKC-style fullwidth forms', () => {
    // Fullwidth letters → ASCII (NFKC).
    expect(normalizeSearchQuery('Ｓｏｎｙ')).toBe('sony');
  });
});

describe('escapeLikePattern', () => {
  it('escapes the three LIKE metacharacters: % _ \\', () => {
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
    expect(escapeLikePattern('back\\slash')).toBe('back\\\\slash');
  });

  it('leaves plain text untouched', () => {
    expect(escapeLikePattern('наушники sony')).toBe('наушники sony');
    expect(escapeLikePattern('')).toBe('');
  });

  it('handles all three at once in order (\\ before % and _)', () => {
    // Backslash must escape FIRST otherwise an inserted "\" would itself
    // need escaping again. The output should round-trip safely as an LIKE
    // pattern literal.
    expect(escapeLikePattern('a\\b%c_d')).toBe('a\\\\b\\%c\\_d');
  });
});

describe('expandQueryAliases', () => {
  it('returns just the original token when no alias matches', () => {
    expect(expandQueryAliases('telefon')).toEqual(['telefon']);
  });

  it('returns [] for empty input', () => {
    expect(expandQueryAliases('')).toEqual([]);
  });

  it('expands RU short-form aliases to canonical form', () => {
    const out = expandQueryAliases('др');
    expect(out).toContain('др');
    expect(out).toContain('день рождения');
  });

  it('expands canonical → short-form (bidirectional)', () => {
    const out = expandQueryAliases('день рождения');
    expect(out).toContain('день рождения');
    // Several short-forms ("др", "днюха", "днюшка") all map both ways.
    expect(out.some((x) => x === 'др' || x === 'днюха' || x === 'днюшка')).toBe(true);
  });

  it('expands EN short-forms', () => {
    expect(expandQueryAliases('bday')).toEqual(expect.arrayContaining(['bday', 'birthday']));
    expect(expandQueryAliases('gift')).toEqual(expect.arrayContaining(['gift', 'wish']));
  });

  it('caps the expansion list at 4 terms', () => {
    // "подарок" / "подарки" / "gift" / "gifts" all funnel toward "wish"/"желание".
    // The cap ensures we don't blow the bound SQL parameter list.
    const out = expandQueryAliases('подарок');
    expect(out.length).toBeLessThanOrEqual(4);
  });
});

describe('public constants', () => {
  it('exposes the agreed query length bounds', () => {
    expect(SEARCH_MIN_QUERY).toBe(2);
    expect(SEARCH_MAX_QUERY).toBe(80);
  });

  it('exposes a per-group default limit', () => {
    expect(SEARCH_DEFAULT_GROUP_LIMIT).toBeGreaterThanOrEqual(3);
    expect(SEARCH_DEFAULT_GROUP_LIMIT).toBeLessThanOrEqual(10);
  });
});
