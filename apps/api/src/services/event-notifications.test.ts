// Unit tests for the PURE helpers of the event-pushes pipeline (P0.3).
// No DB — quiet-hours math, dedupe keys, and message rendering. The DB-touching
// enqueue/flush behaviour is covered in test/integration/event-notifications.ts.

import { describe, it, expect } from 'vitest';
import {
  parseHHmm,
  localMinutesInTz,
  isWithinQuietHours,
  minutesUntilQuietEnd,
  utcDayKey,
  dedupeKeys,
  renderEventMessage,
} from './event-notifications';

describe('parseHHmm', () => {
  it('parses valid HH:mm to minutes', () => {
    expect(parseHHmm('22:00')).toBe(1320);
    expect(parseHHmm('09:05')).toBe(545);
    expect(parseHHmm('00:00')).toBe(0);
    expect(parseHHmm('23:59')).toBe(1439);
  });
  it('rejects malformed values', () => {
    expect(parseHHmm('24:00')).toBeNull();
    expect(parseHHmm('12:60')).toBeNull();
    expect(parseHHmm('')).toBeNull();
    expect(parseHHmm('abc')).toBeNull();
    expect(parseHHmm(null)).toBeNull();
    expect(parseHHmm(undefined)).toBeNull();
  });
});

describe('localMinutesInTz', () => {
  const instant = new Date('2026-06-02T06:30:00Z');
  it('returns local minutes for UTC', () => {
    expect(localMinutesInTz(instant, 'UTC')).toBe(6 * 60 + 30);
  });
  it('applies the Moscow (UTC+3, no DST) offset', () => {
    expect(localMinutesInTz(instant, 'Europe/Moscow')).toBe(9 * 60 + 30);
  });
  it('falls back to MSK on an invalid tz instead of throwing', () => {
    expect(localMinutesInTz(instant, 'Not/AZone')).toBe(9 * 60 + 30);
  });
});

describe('isWithinQuietHours', () => {
  it('non-wrapping window [09:00, 22:00)', () => {
    const s = 540, e = 1320;
    expect(isWithinQuietHours(600, s, e)).toBe(true);   // 10:00
    expect(isWithinQuietHours(540, s, e)).toBe(true);   // start inclusive
    expect(isWithinQuietHours(1320, s, e)).toBe(false); // end exclusive
    expect(isWithinQuietHours(480, s, e)).toBe(false);  // 08:00
  });
  it('wrapping window [22:00, 09:00)', () => {
    const s = 1320, e = 540;
    expect(isWithinQuietHours(1380, s, e)).toBe(true);  // 23:00
    expect(isWithinQuietHours(300, s, e)).toBe(true);   // 05:00
    expect(isWithinQuietHours(1320, s, e)).toBe(true);  // start inclusive
    expect(isWithinQuietHours(540, s, e)).toBe(false);  // end exclusive
    expect(isWithinQuietHours(600, s, e)).toBe(false);  // 10:00
  });
  it('start === end means no quiet window', () => {
    expect(isWithinQuietHours(600, 540, 540)).toBe(false);
  });
});

describe('minutesUntilQuietEnd', () => {
  it('computes wall-clock minutes to the next end', () => {
    expect(minutesUntilQuietEnd(1380, 540)).toBe(600); // 23:00 → 09:00 = 10h
    expect(minutesUntilQuietEnd(500, 540)).toBe(40);   // same day
  });
  it('never returns 0 (forward progress)', () => {
    expect(minutesUntilQuietEnd(540, 540)).toBe(1440);
  });
});

describe('utcDayKey', () => {
  it('is the UTC date prefix', () => {
    expect(utcDayKey(new Date('2026-06-02T23:30:00Z'))).toBe('2026-06-02');
  });
});

describe('dedupeKeys', () => {
  it('builds stable keys', () => {
    expect(dedupeKeys.newWish('i1', 'u1')).toBe('nw:i1:u1');
    expect(dedupeKeys.reservationChanged('i1', 'u1', 'edited', '2026-06-02')).toBe('rc:i1:u1:edited:2026-06-02');
    expect(dedupeKeys.circleJoined('c1', 'u1', '2026-06-02')).toBe('cj:c1:u1:2026-06-02');
    expect(dedupeKeys.eventUpcoming('7', 'b1', 'r1', 2026)).toBe('eu:7:b1:r1:2026');
  });
});

describe('renderEventMessage', () => {
  const ctx = { locale: 'ru' as const, circleId: 'c1', circleName: 'Семья' };

  it('returns null for no rows', () => {
    expect(renderEventMessage([], ctx)).toBeNull();
  });

  it('single new wish → member target, includes name + escaped title', () => {
    const out = renderEventMessage(
      [{ type: 'NEW_WISH', payload: { actorName: 'Аня', memberId: 'm1', itemTitle: '<Sony>' } }],
      ctx,
    )!;
    expect(out.text).toContain('Аня');
    expect(out.text).toContain('&lt;Sony&gt;'); // HTML-escaped
    expect(out.target).toEqual({ kind: 'member', circleId: 'c1', memberId: 'm1' });
  });

  it('single upcoming 7d → member target', () => {
    const out = renderEventMessage(
      [{ type: 'EVENT_UPCOMING_7D', payload: { actorName: 'Аня', memberId: 'm1', daysUntil: 7 } }],
      ctx,
    )!;
    expect(out.text).toContain('Аня');
    expect(out.target.kind).toBe('member');
  });

  it('single reservation removed → circle target', () => {
    const out = renderEventMessage(
      [{ type: 'RESERVATION_CHANGED', payload: { actorName: 'Петя', changeKind: 'removed' } }],
      ctx,
    )!;
    expect(out.text).toContain('Петя');
    expect(out.target).toEqual({ kind: 'circle', circleId: 'c1' });
  });

  it('single circle joined → uses circle name, circle target', () => {
    const out = renderEventMessage(
      [{ type: 'CIRCLE_JOINED', payload: { actorName: 'Петя', circleName: 'Семья' } }],
      ctx,
    )!;
    expect(out.text).toContain('Петя');
    expect(out.text).toContain('Семья');
    expect(out.target.kind).toBe('circle');
  });

  it('many new wishes from one member → "N wishes", member target', () => {
    const rows = Array.from({ length: 3 }, () => ({
      type: 'NEW_WISH' as const,
      payload: { actorName: 'Аня', memberId: 'm1', itemTitle: 'x' },
    }));
    const out = renderEventMessage(rows, ctx)!;
    expect(out.text).toContain('3');
    expect(out.target).toEqual({ kind: 'member', circleId: 'c1', memberId: 'm1' });
  });

  it('mixed bucket → grouped header + bullets, circle target', () => {
    const out = renderEventMessage(
      [
        { type: 'NEW_WISH', payload: { actorName: 'Аня', memberId: 'm1', itemTitle: 'x' } },
        { type: 'EVENT_UPCOMING_7D', payload: { actorName: 'Петя', memberId: 'm2', daysUntil: 7 } },
      ],
      ctx,
    )!;
    expect(out.text).toContain('Семья'); // header carries the circle name
    expect(out.text).toContain('•');     // bullet lines
    expect(out.text).toContain('Аня');
    expect(out.text).toContain('Петя');
    expect(out.target).toEqual({ kind: 'circle', circleId: 'c1' });
  });

  it('falls back to a localized name when actorName is empty', () => {
    const out = renderEventMessage(
      [{ type: 'NEW_WISH', payload: { actorName: '', memberId: 'm1', itemTitle: 'x' } }],
      ctx,
    )!;
    expect(out.text).toContain('Пользователь'); // ru api_user_fallback
  });
});
