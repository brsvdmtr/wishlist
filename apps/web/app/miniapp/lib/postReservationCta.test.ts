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
  wishlistsLoaded: true,
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

  // Critical: a transient /tg/wishlists 5xx must NOT make a real owner look
  // like a fresh guest. Stay conservative until at least one successful load.
  it('skips when wishlists have not loaded yet — protects against transient API failure', () => {
    expect(shouldShowE11Cta({ ...ALLOW, wishlistsLoaded: false })).toEqual({
      show: false,
      reason: 'wishlists_not_loaded',
    });
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

  // The gate order matters: session_shown is the very first check so that
  // even god-mode and active treatment can never re-fire within one app-open.
  it('session_shown wins over everything — even godModeForce + treatment', () => {
    expect(
      shouldShowE11Cta({
        ...ALLOW,
        sessionFlag: true,
        wishlistCount: 0,
        experimentVariant: 'treatment',
        godModeForce: true,
      }),
    ).toEqual({ show: false, reason: 'session_shown' });
  });

  it('returns owner_as_guest before any later gate', () => {
    expect(
      shouldShowE11Cta({
        ...ALLOW,
        wishlistCount: 3,
        experimentVariant: 'control',
        lastSeenAt: NOW,
      }),
    ).toEqual({ show: false, reason: 'owner_as_guest' });
  });

  // God-mode force-show — operator testing bypass
  it('godModeForce bypasses owner_as_guest + not_in_treatment + cooldown + secret-reservation', () => {
    expect(
      shouldShowE11Cta({
        ...ALLOW,
        wishlistCount: 5,
        experimentVariant: 'control',
        lastSeenAt: NOW,
        isSecretReservation: true,
        godModeForce: true,
      }),
    ).toEqual({ show: true });
  });

  it('godModeForce also bypasses wishlists_not_loaded gate — operators can test pre-load', () => {
    expect(
      shouldShowE11Cta({
        ...ALLOW,
        wishlistsLoaded: false,
        godModeForce: true,
      }),
    ).toEqual({ show: true });
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
