import { describe, it, expect } from 'vitest';
import { isCrossUserReservation } from './crossUserReservation';

describe('isCrossUserReservation', () => {
  it('returns true when reserver and owner are distinct', () => {
    expect(isCrossUserReservation('u-reserver', 'u-owner')).toBe(true);
  });

  it('returns false when reserver IS the owner (self-reservation / bookmark flow)', () => {
    expect(isCrossUserReservation('u-self', 'u-self')).toBe(false);
  });

  it('is strict id-string equality — no coercion across whitespace or case', () => {
    // Real cuids are case-sensitive and have no leading/trailing whitespace.
    // The predicate must NOT trim or normalise — `'u-a' !== 'u-a '` is a real
    // distinction that should stay distinct (the trailing-space variant is a
    // corrupted id, not a self-reservation).
    expect(isCrossUserReservation('u-a', 'u-a ')).toBe(true);
    expect(isCrossUserReservation('U-Self', 'u-self')).toBe(true);
  });
});
