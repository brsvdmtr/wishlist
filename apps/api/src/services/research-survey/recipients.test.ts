// stratifiedSample unit test — covers RC-9 from design v1.2 §5.5.
//
// The DB-dependent paths in recipients.ts (loadEligiblePool, per-segment
// queries, classifyS8) need a real Postgres and live in the integration
// suite. The pure stratifier is tested here in isolation against
// fabricated S8 substrata candidates.

import { describe, it, expect } from 'vitest';
import { stratifiedSample, type S8Subtype } from './recipients';
import type { SurveyLocale } from './locale';

type Pool = { userId: string; subtype: S8Subtype }[];

function makePool(counts: Partial<Record<S8Subtype, number>>): Pool {
  const out: Pool = [];
  for (const [sub, n] of Object.entries(counts) as [S8Subtype, number][]) {
    for (let i = 0; i < n; i += 1) out.push({ userId: `${sub}_${i}`, subtype: sub });
  }
  return out;
}

function localeMap(pool: Pool, locale: SurveyLocale = 'ru'): Map<string, SurveyLocale> {
  return new Map(pool.map((p) => [p.userId, locale]));
}

describe('stratifiedSample', () => {
  it('returns empty when pool is empty or cap is 0', () => {
    expect(stratifiedSample([], new Map(), 150, 1)).toEqual([]);
    const pool = makePool({ opened_only: 5 });
    expect(stratifiedSample(pool, localeMap(pool), 0, 1)).toEqual([]);
  });

  it('caps at <= cap when pool exceeds it', () => {
    const pool = makePool({
      opened_only: 100,
      wishlist_no_item: 100,
      item_no_share: 100,
      shared_no_guest_action: 100,
      activated_then_churned: 100,
    });
    const out = stratifiedSample(pool, localeMap(pool), 150, 7);
    expect(out.length).toBeLessThanOrEqual(150);
    expect(out.length).toBe(150);
  });

  it('takes exactly cap/5 from each subtype when all have enough', () => {
    const pool = makePool({
      opened_only: 50,
      wishlist_no_item: 50,
      item_no_share: 50,
      shared_no_guest_action: 50,
      activated_then_churned: 50,
    });
    const out = stratifiedSample(pool, localeMap(pool), 150, 11);
    const counts = countBySubtype(out);
    expect(counts.opened_only).toBe(30);
    expect(counts.wishlist_no_item).toBe(30);
    expect(counts.item_no_share).toBe(30);
    expect(counts.shared_no_guest_action).toBe(30);
    expect(counts.activated_then_churned).toBe(30);
  });

  it('backfills underused strata to keep total ≤ cap', () => {
    // S8a only has 5 users — should take all 5, redistribute 25 slots.
    const pool = makePool({
      opened_only: 5,
      wishlist_no_item: 50,
      item_no_share: 50,
      shared_no_guest_action: 50,
      activated_then_churned: 50,
    });
    const out = stratifiedSample(pool, localeMap(pool), 150, 13);
    expect(out.length).toBe(150);
    const counts = countBySubtype(out);
    expect(counts.opened_only).toBe(5);
    expect(counts.wishlist_no_item + counts.item_no_share + counts.shared_no_guest_action + counts.activated_then_churned).toBe(145);
  });

  it('preserves real segmentSubtype on backfill (no relabelling)', () => {
    const pool = makePool({
      opened_only: 3,
      wishlist_no_item: 200,
      item_no_share: 0,
      shared_no_guest_action: 0,
      activated_then_churned: 0,
    });
    const out = stratifiedSample(pool, localeMap(pool), 150, 17);
    // Every output row must carry its source substratum (3 opened_only, 147 wishlist_no_item).
    const counts = countBySubtype(out);
    expect(counts.opened_only).toBe(3);
    expect(counts.wishlist_no_item).toBe(147);
    expect(counts.item_no_share).toBe(0);
    expect(counts.shared_no_guest_action).toBe(0);
    expect(counts.activated_then_churned).toBe(0);

    // No user gets relabeled to a different subtype.
    for (const row of out) {
      const idPrefix = row.userId.split('_').slice(0, -1).join('_');
      expect(idPrefix).toBe(row.subtype);
    }
  });

  it('is deterministic given a fixed seed', () => {
    const pool = makePool({
      opened_only: 40,
      wishlist_no_item: 40,
      item_no_share: 40,
      shared_no_guest_action: 40,
      activated_then_churned: 40,
    });
    const a = stratifiedSample(pool, localeMap(pool), 150, 1234);
    const b = stratifiedSample(pool, localeMap(pool), 150, 1234);
    expect(a.map((r) => r.userId)).toEqual(b.map((r) => r.userId));
  });

  it('produces different selections for different seeds (sanity)', () => {
    const pool = makePool({
      opened_only: 50,
      wishlist_no_item: 50,
      item_no_share: 50,
      shared_no_guest_action: 50,
      activated_then_churned: 50,
    });
    const a = stratifiedSample(pool, localeMap(pool), 150, 1);
    const b = stratifiedSample(pool, localeMap(pool), 150, 9999);
    const aIds = a.map((r) => r.userId).sort().join(',');
    const bIds = b.map((r) => r.userId).sort().join(',');
    expect(aIds).not.toBe(bIds);
  });

  it('drops candidates that have no locale entry (defensive)', () => {
    const pool = makePool({ opened_only: 50 });
    // Build a partial locale map — only first 10 users.
    const partial = new Map<string, SurveyLocale>();
    for (let i = 0; i < 10; i += 1) partial.set(`opened_only_${i}`, 'ru');
    const out = stratifiedSample(pool, partial, 30, 5);
    // Cap was 30 per stratum, but only 10 had locales → cap by available.
    expect(out.length).toBeLessThanOrEqual(10);
    for (const r of out) expect(partial.has(r.userId)).toBe(true);
  });

  it('handles a pool smaller than the cap by returning the whole pool', () => {
    const pool = makePool({ opened_only: 2, wishlist_no_item: 3 });
    const out = stratifiedSample(pool, localeMap(pool), 150, 1);
    expect(out.length).toBe(5);
  });
});

function countBySubtype(rows: { subtype: S8Subtype }[]): Record<S8Subtype, number> {
  const out: Record<S8Subtype, number> = {
    opened_only: 0,
    wishlist_no_item: 0,
    item_no_share: 0,
    shared_no_guest_action: 0,
    activated_then_churned: 0,
  };
  for (const r of rows) out[r.subtype] += 1;
  return out;
}
