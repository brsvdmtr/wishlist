// Unit tests for resolveReservePrefill — E15 display-name prefill.

import { describe, it, expect } from 'vitest';
import { resolveReservePrefill } from './reservePrefill';

describe('resolveReservePrefill', () => {
  it('returns profile.displayName when set — highest priority', () => {
    expect(
      resolveReservePrefill(
        { first_name: 'Dmitry', last_name: 'Petrov' },
        { displayName: 'dimaWB' },
      ),
    ).toEqual({ value: 'dimaWB', source: 'profile' });
  });

  it('returns "first last" when profile is missing and both TG names are set', () => {
    expect(
      resolveReservePrefill(
        { first_name: 'Dmitry', last_name: 'Petrov' },
        null,
      ),
    ).toEqual({ value: 'Dmitry Petrov', source: 'tg_full' });
  });

  it('returns first only when TG last_name is missing', () => {
    expect(
      resolveReservePrefill({ first_name: 'Dmitry' }, null),
    ).toEqual({ value: 'Dmitry', source: 'tg_first' });
  });

  it('returns first only when TG last_name is empty string', () => {
    expect(
      resolveReservePrefill({ first_name: 'Dmitry', last_name: '' }, null),
    ).toEqual({ value: 'Dmitry', source: 'tg_first' });
  });

  it('returns empty + none when nothing is available', () => {
    expect(resolveReservePrefill(null, null)).toEqual({ value: '', source: 'none' });
    expect(resolveReservePrefill(undefined, undefined)).toEqual({ value: '', source: 'none' });
  });

  it('returns none when tgUser has no first_name and profile has no displayName', () => {
    expect(
      resolveReservePrefill(
        { first_name: '', last_name: 'Petrov' },
        { displayName: null },
      ),
    ).toEqual({ value: '', source: 'none' });
  });

  it('treats whitespace-only displayName as missing', () => {
    expect(
      resolveReservePrefill({ first_name: 'Dmitry' }, { displayName: '   ' }),
    ).toEqual({ value: 'Dmitry', source: 'tg_first' });
  });

  it('treats whitespace-only first_name as missing', () => {
    expect(
      resolveReservePrefill({ first_name: '   ' }, null),
    ).toEqual({ value: '', source: 'none' });
  });

  it('trims surrounding whitespace from profile.displayName', () => {
    expect(
      resolveReservePrefill(null, { displayName: '  Alex  ' }),
    ).toEqual({ value: 'Alex', source: 'profile' });
  });

  it('caps profile.displayName at 64 chars (API contract)', () => {
    const long = 'A'.repeat(100);
    const result = resolveReservePrefill(null, { displayName: long });
    expect(result.source).toBe('profile');
    expect(result.value).toHaveLength(64);
  });

  it('caps "first last" combination at 64 chars', () => {
    const result = resolveReservePrefill(
      { first_name: 'A'.repeat(40), last_name: 'B'.repeat(40) },
      null,
    );
    expect(result.source).toBe('tg_full');
    expect(result.value).toHaveLength(64);
  });

  it('does not concatenate when first is whitespace and last is real', () => {
    // Edge case: if first is empty but last exists, we still report none —
    // we don't want to ship a name starting with " Petrov".
    expect(
      resolveReservePrefill({ first_name: '', last_name: 'Petrov' }, null),
    ).toEqual({ value: '', source: 'none' });
  });

  it('handles emoji and non-ASCII names correctly', () => {
    expect(
      resolveReservePrefill({ first_name: 'Дмитрий', last_name: '🎮' }, null),
    ).toEqual({ value: 'Дмитрий 🎮', source: 'tg_full' });
  });
});
