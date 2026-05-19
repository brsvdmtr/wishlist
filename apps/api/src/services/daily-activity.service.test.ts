// Unit tests for the pure pieces of services/daily-activity.service.ts.
//
// `mapEventsToCounters` is fully pure (no DB, no clock, no logger) and
// represents the entire event-name → counter-field decision tree. Every
// alias / merger / drop happens here, so these tests fail loudly whenever
// the mapping table drifts from the dashboard SQL doc.
//
// `startOfUtcDay` / `startOfNextUtcDay` pin the UTC-day boundary
// behaviour the scheduler and integration tests both rely on.

import { describe, it, expect } from 'vitest';
import {
  COUNTER_FIELDS,
  EVENT_TO_FIELD,
  TRACKED_EVENT_NAMES,
  emptyCounters,
  mapEventsToCounters,
  startOfUtcDay,
  startOfNextUtcDay,
} from './daily-activity.service';

describe('COUNTER_FIELDS', () => {
  it('matches the 13 fields documented in CLAUDE.md / dashboard', () => {
    expect([...COUNTER_FIELDS]).toEqual([
      'sessionStarted',
      'createdRealWish',
      'createdWishlist',
      'sharedWishlist',
      'guestOpened',
      'reservedItem',
      'convertedGuestToOwner',
      'paywallViewed',
      'checkoutStarted',
      'paymentCompleted',
      'proActivated',
      'usedUrlImport',
      'usedHint',
    ]);
  });
});

describe('EVENT_TO_FIELD', () => {
  it('maps every event name to a valid counter field', () => {
    for (const [event, field] of Object.entries(EVENT_TO_FIELD)) {
      expect(COUNTER_FIELDS).toContain(field as unknown);
      expect(typeof event).toBe('string');
      expect(event.length).toBeGreaterThan(0);
    }
  });

  it('exposes both legacy and typed checkout-started events', () => {
    expect(EVENT_TO_FIELD['checkout_started']).toBe('checkoutStarted');
    expect(EVENT_TO_FIELD['paywall.cta_clicked']).toBe('checkoutStarted');
  });

  it('uses server-side share.token_generated for sharedWishlist (not client wishlist.shared)', () => {
    // The client-side `wishlist.shared` would double-count if both
    // were summed — the dashboard relies on the server event only.
    expect(EVENT_TO_FIELD['share.token_generated']).toBe('sharedWishlist');
    expect(EVENT_TO_FIELD['wishlist.shared']).toBeUndefined();
  });
});

describe('TRACKED_EVENT_NAMES', () => {
  it('contains exactly the keys of EVENT_TO_FIELD (deduped)', () => {
    expect(new Set(TRACKED_EVENT_NAMES)).toEqual(new Set(Object.keys(EVENT_TO_FIELD)));
  });
});

describe('emptyCounters', () => {
  it('returns a fresh object with all 13 counters at 0', () => {
    const c = emptyCounters();
    for (const f of COUNTER_FIELDS) {
      expect(c[f]).toBe(0);
    }
  });

  it('returns a new instance each call (no shared mutable state)', () => {
    const a = emptyCounters();
    const b = emptyCounters();
    a.sessionStarted = 42;
    expect(b.sessionStarted).toBe(0);
  });
});

describe('mapEventsToCounters', () => {
  it('returns an empty map for no input', () => {
    expect(mapEventsToCounters([]).size).toBe(0);
  });

  it('drops events with null userId', () => {
    const m = mapEventsToCounters([
      { event: 'user.session_started', userId: null },
      { event: 'wish.created', userId: null },
    ]);
    expect(m.size).toBe(0);
  });

  it('drops events whose name is not in the mapping', () => {
    const m = mapEventsToCounters([
      { event: 'random.unmapped_event', userId: 'u1' },
      { event: 'bot.start_received', userId: 'u1' }, // exists in registry but not mapped here
    ]);
    expect(m.size).toBe(0);
  });

  it('counts one event of each tracked kind for a single user', () => {
    const events = Object.keys(EVENT_TO_FIELD).map((event) => ({ event, userId: 'u1' }));
    const m = mapEventsToCounters(events);
    expect(m.size).toBe(1);
    const counters = m.get('u1')!;
    expect(counters.sessionStarted).toBe(1);
    expect(counters.createdRealWish).toBe(1);
    expect(counters.createdWishlist).toBe(1);
    expect(counters.sharedWishlist).toBe(1);
    expect(counters.guestOpened).toBe(1);
    expect(counters.reservedItem).toBe(1);
    expect(counters.convertedGuestToOwner).toBe(1);
    expect(counters.paywallViewed).toBe(1);
    // checkoutStarted has TWO source events (legacy + typed) — see
    // the dual-mapping comment in the service.
    expect(counters.checkoutStarted).toBe(2);
    expect(counters.paymentCompleted).toBe(1);
    expect(counters.proActivated).toBe(1);
    expect(counters.usedUrlImport).toBe(1);
    expect(counters.usedHint).toBe(1);
  });

  it('increments per-event-occurrence (not deduped per day)', () => {
    const m = mapEventsToCounters([
      { event: 'wish.created', userId: 'u1' },
      { event: 'wish.created', userId: 'u1' },
      { event: 'wish.created', userId: 'u1' },
    ]);
    expect(m.get('u1')!.createdRealWish).toBe(3);
  });

  it('partitions counters by userId', () => {
    const m = mapEventsToCounters([
      { event: 'wish.created', userId: 'u1' },
      { event: 'wish.created', userId: 'u2' },
      { event: 'paywall.viewed', userId: 'u2' },
    ]);
    expect(m.size).toBe(2);
    expect(m.get('u1')!.createdRealWish).toBe(1);
    expect(m.get('u1')!.paywallViewed).toBe(0);
    expect(m.get('u2')!.createdRealWish).toBe(1);
    expect(m.get('u2')!.paywallViewed).toBe(1);
  });

  it('sums both checkout aliases into one counter', () => {
    const m = mapEventsToCounters([
      { event: 'checkout_started', userId: 'u1' },
      { event: 'paywall.cta_clicked', userId: 'u1' },
    ]);
    expect(m.get('u1')!.checkoutStarted).toBe(2);
  });
});

describe('startOfUtcDay', () => {
  it('normalizes noon to midnight UTC same calendar day', () => {
    expect(startOfUtcDay(new Date('2026-05-19T12:00:00.000Z')).toISOString())
      .toBe('2026-05-19T00:00:00.000Z');
  });

  it('keeps midnight UTC unchanged', () => {
    expect(startOfUtcDay(new Date('2026-05-19T00:00:00.000Z')).toISOString())
      .toBe('2026-05-19T00:00:00.000Z');
  });

  it('rounds 23:59:59.999 down to start of same UTC day', () => {
    expect(startOfUtcDay(new Date('2026-05-19T23:59:59.999Z')).toISOString())
      .toBe('2026-05-19T00:00:00.000Z');
  });

  it('rounds 00:00:00.001 down to start of same UTC day', () => {
    expect(startOfUtcDay(new Date('2026-05-19T00:00:00.001Z')).toISOString())
      .toBe('2026-05-19T00:00:00.000Z');
  });

  it('uses UTC fields, not local — Berlin 00:30 (UTC 22:30 prev day in summer) maps to prev UTC day', () => {
    // A user clicking "share" at 00:30 Berlin summer time (UTC+2) emits an
    // event with createdAt = 22:30Z the previous calendar day. UTC bucketing
    // attributes it to the PREVIOUS UTC day. This is the documented
    // trade-off in docs/research/core-loop-dashboard.md § 1.
    const berlinHalfPastMidnight = new Date('2026-05-19T22:30:00.000Z'); // = 2026-05-20 00:30 Berlin
    expect(startOfUtcDay(berlinHalfPastMidnight).toISOString())
      .toBe('2026-05-19T00:00:00.000Z');
  });
});

describe('startOfNextUtcDay', () => {
  it('returns midnight of the next UTC day', () => {
    expect(startOfNextUtcDay(new Date('2026-05-19T12:00:00.000Z')).toISOString())
      .toBe('2026-05-20T00:00:00.000Z');
  });

  it('crosses month boundary correctly', () => {
    expect(startOfNextUtcDay(new Date('2026-05-31T23:59:59.999Z')).toISOString())
      .toBe('2026-06-01T00:00:00.000Z');
  });

  it('crosses year boundary correctly', () => {
    expect(startOfNextUtcDay(new Date('2026-12-31T15:00:00.000Z')).toISOString())
      .toBe('2027-01-01T00:00:00.000Z');
  });
});
