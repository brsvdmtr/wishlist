// Unit tests for services/birthday-reminders.ts pure helpers.
//
// All six functions are time-zone-aware (MSK fixed offset +3) and operate on
// Date objects. No Prisma, no fetch, no logger. The dual representation —
// raw Date for the DB column + MSK calendar day for the user — is the source
// of every off-by-one in this module historically, so the tests pin the
// boundary behaviour explicitly.

import { describe, it, expect } from 'vitest';
import {
  BIRTHDAY_TZ_OFFSET_HOURS,
  getMskBirthdayDay,
  getMskToday,
  daysUntilNextBirthday,
  buildOccurrenceKey,
  nextMskMorning,
  pickBirthdayDisplayName,
} from './birthday-reminders';

describe('BIRTHDAY_TZ_OFFSET_HOURS', () => {
  it('is 3 hours (MSK fixed offset, no DST)', () => {
    expect(BIRTHDAY_TZ_OFFSET_HOURS).toBe(3);
  });
});

describe('getMskBirthdayDay', () => {
  it('returns null for null birthday', () => {
    expect(getMskBirthdayDay(null)).toBeNull();
  });

  it('reads a date stored at UTC midnight in MSK calendar (offset shifts +3h)', () => {
    // Jan 1 2000 00:00 UTC = Jan 1 2000 03:00 MSK → day 1, month 1
    expect(getMskBirthdayDay(new Date('2000-01-01T00:00:00Z'))).toEqual({ month: 1, day: 1 });
  });

  it('handles UTC late-night that wraps into next MSK day', () => {
    // Jan 1 2000 22:00 UTC = Jan 2 2000 01:00 MSK → day 2
    expect(getMskBirthdayDay(new Date('2000-01-01T22:00:00Z'))).toEqual({ month: 1, day: 2 });
  });

  it('reads Feb 29 from a leap-year carrier date', () => {
    expect(getMskBirthdayDay(new Date('2000-02-29T00:00:00Z'))).toEqual({ month: 2, day: 29 });
  });
});

describe('getMskToday', () => {
  it('shifts UTC noon to MSK 15:00 same day', () => {
    expect(getMskToday(new Date('2026-05-15T12:00:00Z'))).toEqual({
      year: 2026, month: 5, day: 15, hour: 15,
    });
  });

  it('rolls into next MSK day for late UTC times', () => {
    // 22:30 UTC = 01:30 MSK next day
    expect(getMskToday(new Date('2026-05-15T22:30:00Z'))).toEqual({
      year: 2026, month: 5, day: 16, hour: 1,
    });
  });
});

describe('daysUntilNextBirthday', () => {
  it('returns null when birthday is null', () => {
    expect(daysUntilNextBirthday(null, new Date('2026-01-01T00:00:00Z'))).toBeNull();
  });

  it('returns 0 when birthday is today (MSK)', () => {
    const bday = new Date('2000-05-15T00:00:00Z'); // May 15 in MSK
    const now = new Date('2026-05-15T08:00:00Z'); // 11:00 MSK on May 15
    expect(daysUntilNextBirthday(bday, now)).toBe(0);
  });

  it('returns 1 when birthday is tomorrow (MSK)', () => {
    const bday = new Date('2000-05-16T00:00:00Z');
    const now = new Date('2026-05-15T12:00:00Z');
    expect(daysUntilNextBirthday(bday, now)).toBe(1);
  });

  it('wraps to next year when birthday has passed this year', () => {
    const bday = new Date('2000-05-15T00:00:00Z'); // birthday is May 15
    const now = new Date('2026-05-20T12:00:00Z'); // today is May 20 → next bday May 15 next year
    expect(daysUntilNextBirthday(bday, now)).toBeGreaterThan(300);
    expect(daysUntilNextBirthday(bday, now)).toBeLessThan(366);
  });

  it('Feb 29 birthday clamps to Feb 28 in non-leap year', () => {
    const bday = new Date('2000-02-29T00:00:00Z');
    // 2027 is not a leap year; from Jan 1 2027 → Feb 28 = 58 days
    const now = new Date('2027-01-01T00:00:00Z');
    const days = daysUntilNextBirthday(bday, now);
    expect(days).toBe(58);
  });

  it('Feb 29 birthday stays Feb 29 in leap year', () => {
    const bday = new Date('2000-02-29T00:00:00Z');
    // 2028 is a leap year; from Jan 1 2028 → Feb 29 = 59 days
    const now = new Date('2028-01-01T00:00:00Z');
    expect(daysUntilNextBirthday(bday, now)).toBe(59);
  });

  it('crosses year boundary when today is Dec and birthday is Jan', () => {
    const bday = new Date('2000-01-05T00:00:00Z'); // Jan 5
    const now = new Date('2026-12-30T12:00:00Z'); // Dec 30 → 5 days to Jan 5 2027… plus offset wrap
    const days = daysUntilNextBirthday(bday, now);
    expect(days).toBeGreaterThan(0);
    expect(days).toBeLessThan(15);
  });
});

describe('buildOccurrenceKey', () => {
  it('returns null when birthday is null', () => {
    expect(buildOccurrenceKey(null as unknown as Date, { year: 2026, month: 5, day: 15 }, 0)).toBeNull();
  });

  it('formats YYYY-MM-DD for current-year occurrence', () => {
    const bday = new Date('2000-05-15T00:00:00Z');
    expect(buildOccurrenceKey(bday, { year: 2026, month: 5, day: 15 }, 0)).toBe('2026-05-15');
  });

  it('offsetDays positive shifts target into the future', () => {
    const bday = new Date('2000-05-20T00:00:00Z');
    // Today is May 15 + 5 days = May 20 target year 2026
    expect(buildOccurrenceKey(bday, { year: 2026, month: 5, day: 15 }, 5)).toBe('2026-05-20');
  });

  it('Feb 29 collapses to Feb 28 in non-leap year', () => {
    const bday = new Date('2000-02-29T00:00:00Z');
    // Target year 2027 (non-leap) → key uses Feb 28
    expect(buildOccurrenceKey(bday, { year: 2027, month: 1, day: 15 }, 31 + 14)).toBe('2027-02-28');
  });

  it('zero-pads single-digit month and day', () => {
    const bday = new Date('2000-01-05T00:00:00Z');
    expect(buildOccurrenceKey(bday, { year: 2026, month: 1, day: 5 }, 0)).toBe('2026-01-05');
  });
});

describe('nextMskMorning', () => {
  it('returns next-day MSK 10:00 = 07:00 UTC', () => {
    // Now = May 15 2026 14:00 UTC = 17:00 MSK → next morning = May 16 10:00 MSK = May 16 07:00 UTC
    const result = nextMskMorning(new Date('2026-05-15T14:00:00Z'));
    expect(result.toISOString()).toBe('2026-05-16T07:00:00.000Z');
  });

  it('rolls correctly when "now" is already after midnight MSK', () => {
    // 22:00 UTC = 01:00 MSK next day → "today MSK" is May 16 → next morning May 17 10:00 MSK
    const result = nextMskMorning(new Date('2026-05-15T22:00:00Z'));
    expect(result.toISOString()).toBe('2026-05-17T07:00:00.000Z');
  });
});

describe('pickBirthdayDisplayName', () => {
  it('prefers displayName when present', () => {
    expect(pickBirthdayDisplayName({ displayName: 'Алексей', username: 'al', firstName: 'A' })).toBe('Алексей');
  });

  it('falls through to username when displayName empty', () => {
    expect(pickBirthdayDisplayName({ displayName: null, username: 'al', firstName: 'A' })).toBe('al');
  });

  it('falls through to firstName when displayName + username empty', () => {
    expect(pickBirthdayDisplayName({ displayName: null, username: null, firstName: 'A' })).toBe('A');
  });

  it('trims whitespace-only displayName before falling through', () => {
    expect(pickBirthdayDisplayName({ displayName: '   ', username: 'al', firstName: 'A' })).toBe('al');
  });

  it('returns the WishBoard final fallback when nothing is set', () => {
    expect(pickBirthdayDisplayName({ displayName: null, username: null, firstName: null })).toBe('WishBoard');
  });

  it('handles missing firstName field gracefully', () => {
    expect(pickBirthdayDisplayName({ displayName: null, username: null })).toBe('WishBoard');
  });
});
