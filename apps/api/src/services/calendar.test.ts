// Pure date arithmetic tests for the Events Calendar / Gift Notes feature.
//
// Phase 1 / L5 regression coverage: a 2026-04-30 prod bug rendered "СЕГОДНЯ"
// for an event tomorrow at 00:00 UTC, queried in the evening. The buggy
// formula `(target - Date.now()) / 86400_000` produced ~0.36 → round → 0.
// `daysUntilFromUtcMidnight` is the extracted helper that closes that class.
// The first sub-suite is the literal scenario from the lesson — it must stay
// green forever.
//
// While extracting we found the original fix only patched one of three
// callsites in gift-notes.routes.ts (line 241, GET /gift-occasions/:id, kept
// the old `Date.now()` form). All three now route through the helper.

import { describe, it, expect } from 'vitest';
import {
  daysUntilFromUtcMidnight,
  getNextOccurrenceDate,
  computeReminderSchedule,
  buildReminderEpisodeKey,
} from './calendar';

const utcMidnight = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('daysUntilFromUtcMidnight — L5 regression (TODAY/TOMORROW off-by-one)', () => {
  it('event tomorrow at 00:00 UTC, queried 30 Apr 15:14 UTC → 1 day, not 0', () => {
    // The exact scenario from BUGFIX_LESSONS 2026-04-30. Buggy formula:
    //   (May 1 00:00 - Apr 30 15:14) / 86400000 = ~0.367 → round → 0
    // Fixed formula compares two UTC midnights → exactly 1.
    const target = utcMidnight('2026-05-01');
    const now = new Date('2026-04-30T15:14:00Z');
    expect(daysUntilFromUtcMidnight(target, now)).toBe(1);
  });

  it('event tomorrow at 00:00 UTC, queried 23:59 UTC of today → still 1 day', () => {
    const target = utcMidnight('2026-05-01');
    const now = new Date('2026-04-30T23:59:00Z');
    expect(daysUntilFromUtcMidnight(target, now)).toBe(1);
  });

  it('event today at 00:00 UTC, queried 00:01 UTC of today → 0 days', () => {
    const target = utcMidnight('2026-05-01');
    const now = new Date('2026-05-01T00:01:00Z');
    expect(daysUntilFromUtcMidnight(target, now)).toBe(0);
  });

  it('time-of-day independence: morning/noon/evening of same date all return same value', () => {
    const target = utcMidnight('2026-05-10');
    const morning = new Date('2026-05-05T07:00:00Z');
    const noon = new Date('2026-05-05T12:00:00Z');
    const evening = new Date('2026-05-05T22:30:00Z');
    expect(daysUntilFromUtcMidnight(target, morning)).toBe(5);
    expect(daysUntilFromUtcMidnight(target, noon)).toBe(5);
    expect(daysUntilFromUtcMidnight(target, evening)).toBe(5);
  });
});

describe('daysUntilFromUtcMidnight — general cases', () => {
  it('event 7 days out → 7', () => {
    expect(daysUntilFromUtcMidnight(utcMidnight('2026-05-08'), new Date('2026-05-01T12:00:00Z'))).toBe(7);
  });

  it('event in the past → negative', () => {
    expect(daysUntilFromUtcMidnight(utcMidnight('2026-04-25'), new Date('2026-05-01T12:00:00Z'))).toBe(-6);
  });

  it('crosses year boundary correctly', () => {
    expect(daysUntilFromUtcMidnight(utcMidnight('2027-01-01'), new Date('2026-12-25T12:00:00Z'))).toBe(7);
  });

  it('crosses month boundary correctly', () => {
    expect(daysUntilFromUtcMidnight(utcMidnight('2026-06-02'), new Date('2026-05-30T12:00:00Z'))).toBe(3);
  });

  it('leap day target (Feb 29) → correct count from Feb 25', () => {
    expect(daysUntilFromUtcMidnight(utcMidnight('2028-02-29'), new Date('2028-02-25T18:00:00Z'))).toBe(4);
  });

  it('target with non-midnight time-of-day → normalised internally (same result as midnight)', () => {
    // Defence against a future caller that reads `target` from a column storing
    // noon-aligned dates. The original prod bug was the inverse (`now` not
    // normalised); this test pins the contract that BOTH sides get normalised
    // so the off-by-one cannot resurface from either end.
    const noonTarget = new Date('2026-05-10T12:00:00Z');
    const midnightTarget = new Date('2026-05-10T00:00:00Z');
    const now = new Date('2026-05-05T08:00:00Z');
    expect(daysUntilFromUtcMidnight(noonTarget, now)).toBe(daysUntilFromUtcMidnight(midnightTarget, now));
    expect(daysUntilFromUtcMidnight(noonTarget, now)).toBe(5);
  });

  it('target at 23:59 UTC same calendar day → 0 (not -1)', () => {
    const target = new Date('2026-05-05T23:59:00Z');
    const now = new Date('2026-05-05T08:00:00Z');
    expect(daysUntilFromUtcMidnight(target, now)).toBe(0);
  });
});

describe('getNextOccurrenceDate', () => {
  it('NONE recurrence returns the eventDate unchanged', () => {
    const event = utcMidnight('2025-06-15');
    expect(getNextOccurrenceDate(event, 'NONE')).toEqual(event);
  });

  it('YEARLY: returns this year when event is in the future', () => {
    // Note: getNextOccurrenceDate uses `new Date()` internally, so result
    // depends on system clock. We just assert the result is a Date with
    // the correct month/day and a year >= current year.
    const event = new Date(Date.UTC(2020, 11, 31)); // Dec 31, 2020 — past
    const result = getNextOccurrenceDate(event, 'YEARLY');
    expect(result).not.toBeNull();
    expect(result!.getUTCMonth()).toBe(11);
    expect(result!.getUTCDate()).toBe(31);
    expect(result!.getUTCFullYear()).toBeGreaterThanOrEqual(new Date().getUTCFullYear());
  });

  it('MONTHLY: returns a Date in this or next month', () => {
    const event = new Date(Date.UTC(2020, 0, 15));
    const result = getNextOccurrenceDate(event, 'MONTHLY');
    expect(result).not.toBeNull();
    expect(result!.getUTCDate()).toBe(15);
  });

  it('YEARLY Feb 29: in non-leap year, clamps to Feb 28', () => {
    // We can't time-travel via Date.now() override, so verify the algorithm
    // returns Feb 28 OR Feb 29 (depending on current year being leap or not).
    // Either way, the day must be ≤ 29 and month must be Feb.
    const feb29 = new Date(Date.UTC(2024, 1, 29));
    const result = getNextOccurrenceDate(feb29, 'YEARLY');
    expect(result).not.toBeNull();
    expect(result!.getUTCMonth()).toBe(1);
    expect([28, 29]).toContain(result!.getUTCDate());
  });

  it('unknown recurrence falls through to eventDate', () => {
    const event = utcMidnight('2026-07-01');
    expect(getNextOccurrenceDate(event, 'FORTNIGHTLY')).toEqual(event);
  });
});

describe('computeReminderSchedule', () => {
  it('schedules at the configured time of day on the event day (offset 0)', () => {
    const event = utcMidnight('2026-06-15');
    const result = computeReminderSchedule(event, 'NONE', 0, '10:00');
    // 10:00 MSK = 07:00 UTC
    expect(result.toISOString()).toBe('2026-06-15T07:00:00.000Z');
  });

  it('schedules N days before via positive offsetDays sign convention', () => {
    const event = utcMidnight('2026-06-15');
    const result = computeReminderSchedule(event, 'NONE', -3, '09:30');
    // -3 → June 12; 09:30 MSK = 06:30 UTC
    expect(result.toISOString()).toBe('2026-06-12T06:30:00.000Z');
  });

  it('handles MSK→UTC for an evening reminder', () => {
    const event = utcMidnight('2026-06-15');
    const result = computeReminderSchedule(event, 'NONE', 0, '23:00');
    // 23:00 MSK = 20:00 UTC
    expect(result.toISOString()).toBe('2026-06-15T20:00:00.000Z');
  });
});

describe('buildReminderEpisodeKey', () => {
  it('produces a stable key with zero-padded month', () => {
    const key = buildReminderEpisodeKey('occ_123', -7, new Date(Date.UTC(2026, 0, 8)));
    expect(key).toBe('occ_occ_123_off-7_2026_01');
  });

  it('different occasions/offsets/months produce distinct keys', () => {
    const a = buildReminderEpisodeKey('o1', 0, new Date(Date.UTC(2026, 4, 1)));
    const b = buildReminderEpisodeKey('o2', 0, new Date(Date.UTC(2026, 4, 1)));
    const c = buildReminderEpisodeKey('o1', -1, new Date(Date.UTC(2026, 4, 1)));
    const d = buildReminderEpisodeKey('o1', 0, new Date(Date.UTC(2026, 5, 1)));
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
});
