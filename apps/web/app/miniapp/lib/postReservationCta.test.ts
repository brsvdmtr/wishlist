import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  shouldShowE11Cta,
  readLastSeenAt,
  writeLastSeenAt,
  E11_COOLDOWN_DAYS,
  E11_LS_KEY,
  type E11GateInput,
} from './postReservationCta';

const NOW = 1_700_000_000_000;
const COOLDOWN_MS = E11_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

const ALLOW: E11GateInput = {
  wishlistCount: 0,
  experimentVariant: 'treatment',
  sessionFlag: false,
  lastSeenAt: null,
  isSecretReservation: false,
  now: NOW,
};

describe('shouldShowE11Cta', () => {
  it('shows for a guest with zero wishlists in treatment, never seen before', () => {
    expect(shouldShowE11Cta(ALLOW)).toEqual({ show: true });
  });

  it('skips when user already owns at least one wishlist (owner-as-guest)', () => {
    expect(shouldShowE11Cta({ ...ALLOW, wishlistCount: 1 })).toEqual({
      show: false,
      reason: 'owner_as_guest',
    });
  });

  it('skips control variant — control sees only toast', () => {
    expect(shouldShowE11Cta({ ...ALLOW, experimentVariant: 'control' })).toEqual({
      show: false,
      reason: 'not_in_treatment',
    });
  });

  it('skips when sheet already shown in this session', () => {
    expect(shouldShowE11Cta({ ...ALLOW, sessionFlag: true })).toEqual({
      show: false,
      reason: 'session_shown',
    });
  });

  it('skips when last show is inside the 30-day cooldown', () => {
    const lastSeen = NOW - COOLDOWN_MS + 1;
    expect(shouldShowE11Cta({ ...ALLOW, lastSeenAt: lastSeen })).toEqual({
      show: false,
      reason: 'cooldown',
    });
  });

  it('shows again exactly at the cooldown boundary', () => {
    const lastSeen = NOW - COOLDOWN_MS;
    expect(shouldShowE11Cta({ ...ALLOW, lastSeenAt: lastSeen })).toEqual({ show: true });
  });

  it('shows again after cooldown expires', () => {
    const lastSeen = NOW - COOLDOWN_MS - 1;
    expect(shouldShowE11Cta({ ...ALLOW, lastSeenAt: lastSeen })).toEqual({ show: true });
  });

  it('skips secret-reservation flow — different paywall context', () => {
    expect(shouldShowE11Cta({ ...ALLOW, isSecretReservation: true })).toEqual({
      show: false,
      reason: 'secret_reservation',
    });
  });

  // The gate order matters: secret-reservation is the very first check so
  // a secret-reserve never produces a g_owner_cta event even for users who
  // would otherwise be in treatment. This keeps the funnel numbers clean.
  it('returns the first matching reason — secret_reservation wins over everything', () => {
    expect(
      shouldShowE11Cta({
        ...ALLOW,
        isSecretReservation: true,
        wishlistCount: 5,
        experimentVariant: 'control',
        sessionFlag: true,
        lastSeenAt: NOW,
      }),
    ).toEqual({ show: false, reason: 'secret_reservation' });
  });

  it('returns owner_as_guest before any later gate', () => {
    expect(
      shouldShowE11Cta({
        ...ALLOW,
        wishlistCount: 3,
        experimentVariant: 'control',
        sessionFlag: true,
        lastSeenAt: NOW,
      }),
    ).toEqual({ show: false, reason: 'owner_as_guest' });
  });
});

describe('readLastSeenAt / writeLastSeenAt', () => {
  beforeEach(() => {
    window.localStorage.removeItem(E11_LS_KEY);
  });
  afterEach(() => {
    window.localStorage.removeItem(E11_LS_KEY);
  });

  it('returns null when no value stored', () => {
    expect(readLastSeenAt()).toBeNull();
  });

  it('round-trips an integer timestamp', () => {
    writeLastSeenAt(NOW);
    expect(readLastSeenAt()).toBe(NOW);
  });

  it('returns null when stored value is non-numeric', () => {
    window.localStorage.setItem(E11_LS_KEY, 'not-a-number');
    expect(readLastSeenAt()).toBeNull();
  });

  it('returns null when stored value is empty string', () => {
    window.localStorage.setItem(E11_LS_KEY, '');
    expect(readLastSeenAt()).toBeNull();
  });
});
