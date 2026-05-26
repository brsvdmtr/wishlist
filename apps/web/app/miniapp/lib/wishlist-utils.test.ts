import { describe, expect, it } from 'vitest';
import {
  getWritableTargets,
  categoryLimitFor,
  FREE_CATEGORY_LIMIT,
  PRO_CATEGORY_LIMIT,
  guestRecommendedScore,
  getSantaItemReservationState,
  resolveCardMode,
  normalizeTitle,
  resolveOwnerName,
  computeActorHash,
} from './wishlist-utils';

describe('getWritableTargets', () => {
  const wls = [
    { id: 'wl_a', readOnly: false },
    { id: 'wl_b', readOnly: false },
    { id: 'wl_drafts', readOnly: false },
    { id: 'wl_readonly', readOnly: true },
    { id: 'wl_current', readOnly: false },
  ];

  it('excludes current, drafts, and readOnly wishlists', () => {
    const out = getWritableTargets(wls, { currentWlId: 'wl_current', draftsWlId: 'wl_drafts' });
    expect(out.map((w) => w.id)).toEqual(['wl_a', 'wl_b']);
  });

  it('treats null current/drafts as no-op exclusion', () => {
    const out = getWritableTargets(wls, { currentWlId: null, draftsWlId: null });
    expect(out.map((w) => w.id)).toEqual(['wl_a', 'wl_b', 'wl_drafts', 'wl_current']);
  });

  it('preserves caller type', () => {
    const out = getWritableTargets([{ id: 'a', readOnly: false, title: 'A' }], {});
    expect(out[0]!.title).toBe('A');
  });
});

describe('categoryLimitFor', () => {
  it('returns the FREE quota for FREE', () => {
    expect(categoryLimitFor('FREE')).toBe(FREE_CATEGORY_LIMIT);
    expect(categoryLimitFor('FREE')).toBe(1);
  });

  it('returns the PRO quota for PRO', () => {
    expect(categoryLimitFor('PRO')).toBe(PRO_CATEGORY_LIMIT);
    expect(categoryLimitFor('PRO')).toBe(20);
  });
});

describe('guestRecommendedScore', () => {
  it('weights priority strongly', () => {
    const base = { status: 'available', imageUrl: null, url: null, description: null, price: null };
    const low = guestRecommendedScore({ ...base, priority: 1 }, null);
    const mid = guestRecommendedScore({ ...base, priority: 2 }, null);
    const high = guestRecommendedScore({ ...base, priority: 3 }, null);
    expect(mid - low).toBe(100);
    expect(high - mid).toBe(100);
  });

  it('rewards available items + media presence', () => {
    const baseLow = { priority: 1, status: 'available', imageUrl: null, url: null, description: null, price: null };
    expect(guestRecommendedScore(baseLow, null)).toBe(50);
    expect(guestRecommendedScore({ ...baseLow, imageUrl: 'x' }, null)).toBe(60);
    expect(guestRecommendedScore({ ...baseLow, url: 'x' }, null)).toBe(55);
    expect(guestRecommendedScore({ ...baseLow, description: 'x' }, null)).toBe(55);
  });

  it('skips the availability bonus for non-available items', () => {
    const reserved = { priority: 1, status: 'reserved', imageUrl: null, url: null, description: null, price: null };
    expect(guestRecommendedScore(reserved, null)).toBe(0);
  });

  it('gives a budget-proximity bonus when price <= budget', () => {
    const item = { priority: 1, status: 'available', imageUrl: null, url: null, description: null, price: 500 };
    // 500/1000 = 0.5 → bonus = round(0.5*15) = 8
    expect(guestRecommendedScore(item, 1000)).toBe(50 + 8);
  });

  it('does not apply the bonus when price > budget', () => {
    const item = { priority: 1, status: 'available', imageUrl: null, url: null, description: null, price: 1500 };
    expect(guestRecommendedScore(item, 1000)).toBe(50);
  });
});

describe('getSantaItemReservationState', () => {
  it('returns available for non-reserved items', () => {
    expect(getSantaItemReservationState('available', null, 'me')).toBe('available');
    expect(getSantaItemReservationState('purchased', null, 'me')).toBe('available');
  });

  it('returns reserved-by-me when actor hashes match', () => {
    expect(getSantaItemReservationState('reserved', 'h1', 'h1')).toBe('reserved-by-me');
  });

  it('returns reserved-by-other otherwise', () => {
    expect(getSantaItemReservationState('reserved', 'h1', 'h2')).toBe('reserved-by-other');
    expect(getSantaItemReservationState('reserved', null, 'h2')).toBe('reserved-by-other');
    expect(getSantaItemReservationState('reserved', 'h1', null)).toBe('reserved-by-other');
  });
});

describe('resolveCardMode', () => {
  it('respects PRO override', () => {
    expect(resolveCardMode(100, 'showcase', true)).toBe('showcase');
    expect(resolveCardMode(2, 'compact', true)).toBe('compact');
  });

  it('auto-picks based on itemCount for non-PRO users', () => {
    expect(resolveCardMode(5, undefined, false)).toBe('showcase');
    expect(resolveCardMode(6, undefined, false)).toBe('compact');
    expect(resolveCardMode(0, undefined, false)).toBe('showcase');
  });

  it('ignores override for non-PRO users', () => {
    expect(resolveCardMode(100, 'showcase', false)).toBe('compact');
  });
});

describe('normalizeTitle', () => {
  it('returns empty for null/undefined/empty', () => {
    expect(normalizeTitle(null)).toBe('');
    expect(normalizeTitle(undefined)).toBe('');
    expect(normalizeTitle('')).toBe('');
  });

  it('decodes HTML entities in browser env', () => {
    // jsdom provides document
    expect(normalizeTitle('Hello &amp; world')).toBe('Hello & world');
  });

  it('collapses runs of spaces/tabs but preserves single spaces', () => {
    expect(normalizeTitle('Hello   world')).toBe('Hello world');
    expect(normalizeTitle('Hello\tworld')).toBe('Hello world');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeTitle('  Hello  ')).toBe('Hello');
  });
});

describe('resolveOwnerName', () => {
  it('prefers profile displayName when present', () => {
    expect(resolveOwnerName({ displayName: 'Anna', username: 'anna' }, { first_name: 'TG' })).toBe('Anna');
  });

  it('falls back to profile username when displayName is blank', () => {
    expect(resolveOwnerName({ displayName: '   ', username: 'anna' }, { first_name: 'TG' })).toBe('anna');
  });

  it('falls back to Telegram first_name when profile is empty', () => {
    expect(resolveOwnerName(null, { first_name: 'TG' })).toBe('TG');
  });

  it('falls back to default when nothing is set', () => {
    expect(resolveOwnerName(null, null)).toBe('Пользователь');
  });

  it('respects custom fallback', () => {
    expect(resolveOwnerName(null, null, 'Guest')).toBe('Guest');
  });
});

describe('computeActorHash', () => {
  it('returns a UUID-shaped string', async () => {
    const out = await computeActorHash(123456);
    expect(out).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('is deterministic for the same input', async () => {
    const a = await computeActorHash(123456);
    const b = await computeActorHash(123456);
    expect(a).toBe(b);
  });

  it('produces different hashes for different ids', async () => {
    const a = await computeActorHash(1);
    const b = await computeActorHash(2);
    expect(a).not.toBe(b);
  });
});
