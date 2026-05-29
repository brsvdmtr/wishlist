import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  shouldShowGuestBanner,
  countShownInWindow,
  reportedShownCount,
  readGuestBannerShownTimestamps,
  recordGuestBannerShown,
  readGuestBannerDismissedAt,
  recordGuestBannerDismissed,
  E13_IMPRESSION_WINDOW_DAYS,
  E13_DISMISS_MUTE_DAYS,
  E13_MAX_PER_WINDOW,
  E13_SHOWN_LS_KEY,
  E13_DISMISS_LS_KEY,
  SHOWN_TS_CAP,
  type E13GateInput,
} from './guestBannerCta';

const NOW = 1_700_000_000_000;
const WINDOW_MS = E13_IMPRESSION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const DISMISS_MUTE_MS = E13_DISMISS_MUTE_DAYS * 24 * 60 * 60 * 1000;

const ALLOW: E13GateInput = {
  dismissedThisSession: false,
  wishlistsLoaded: true,
  wishlistCount: 0,
  birthdayBannerActive: false,
  variant: 'treatment',
  dismissedAt: null,
  shownTs: [],
  now: NOW,
};

describe('shouldShowGuestBanner', () => {
  it('shows for a treatment guest with zero wishlists, never shown or dismissed', () => {
    expect(shouldShowGuestBanner(ALLOW)).toEqual({ show: true });
  });

  it('skips when dismissed in this session', () => {
    expect(shouldShowGuestBanner({ ...ALLOW, dismissedThisSession: true })).toEqual({
      show: false,
      reason: 'dismissed_session',
    });
  });

  // Transient /tg/wishlists failure must not make a real owner look like a guest.
  it('skips when wishlists have not loaded yet', () => {
    expect(shouldShowGuestBanner({ ...ALLOW, wishlistsLoaded: false })).toEqual({
      show: false,
      reason: 'wishlists_not_loaded',
    });
  });

  it('skips when the user already owns a wishlist (owner-as-guest)', () => {
    expect(shouldShowGuestBanner({ ...ALLOW, wishlistCount: 1 })).toEqual({
      show: false,
      reason: 'owner_as_guest',
    });
  });

  it('yields to the higher-priority birthday banner', () => {
    expect(shouldShowGuestBanner({ ...ALLOW, birthdayBannerActive: true })).toEqual({
      show: false,
      reason: 'banner_priority',
    });
  });

  it('skips the control variant', () => {
    expect(shouldShowGuestBanner({ ...ALLOW, variant: 'control' })).toEqual({
      show: false,
      reason: 'not_in_treatment',
    });
  });

  it('skips while inside the dismiss mute window', () => {
    expect(shouldShowGuestBanner({ ...ALLOW, dismissedAt: NOW - DISMISS_MUTE_MS + 1 })).toEqual({
      show: false,
      reason: 'dismissed_cooldown',
    });
  });

  it('shows again exactly at the dismiss-window boundary', () => {
    expect(shouldShowGuestBanner({ ...ALLOW, dismissedAt: NOW - DISMISS_MUTE_MS })).toEqual({ show: true });
  });

  it('skips once N impressions are inside the window', () => {
    const shownTs = Array.from({ length: E13_MAX_PER_WINDOW }, (_, i) => NOW - i * 1000);
    expect(shouldShowGuestBanner({ ...ALLOW, shownTs })).toEqual({
      show: false,
      reason: 'freq_cap',
    });
  });

  it('shows when fewer than N impressions are inside the window', () => {
    const shownTs = Array.from({ length: E13_MAX_PER_WINDOW - 1 }, (_, i) => NOW - i * 1000);
    expect(shouldShowGuestBanner({ ...ALLOW, shownTs })).toEqual({ show: true });
  });

  // Old impressions outside the window are pruned by the count, so they don't
  // permanently mute a returning guest.
  it('ignores impressions older than the window when counting', () => {
    const stale = Array.from({ length: E13_MAX_PER_WINDOW + 2 }, (_, i) => NOW - WINDOW_MS - i * 1000);
    expect(shouldShowGuestBanner({ ...ALLOW, shownTs: stale })).toEqual({ show: true });
  });

  // ── Gate ordering ──────────────────────────────────────────────────────
  it('dismissed_session beats everything, even godModeForce', () => {
    expect(
      shouldShowGuestBanner({
        ...ALLOW,
        dismissedThisSession: true,
        godModeForce: true,
        variant: 'treatment',
      }),
    ).toEqual({ show: false, reason: 'dismissed_session' });
  });

  it('godModeForce bypasses owner_as_guest, control, dismiss-window and freq-cap', () => {
    expect(
      shouldShowGuestBanner({
        ...ALLOW,
        wishlistCount: 5,
        variant: 'control',
        birthdayBannerActive: true,
        dismissedAt: NOW,
        shownTs: [NOW, NOW, NOW, NOW],
        godModeForce: true,
      }),
    ).toEqual({ show: true });
  });

  it('returns owner_as_guest before later gates', () => {
    expect(
      shouldShowGuestBanner({
        ...ALLOW,
        wishlistCount: 2,
        variant: 'control',
        shownTs: [NOW, NOW, NOW],
      }),
    ).toEqual({ show: false, reason: 'owner_as_guest' });
  });
});

describe('countShownInWindow', () => {
  it('counts only timestamps inside the window', () => {
    const ts = [NOW, NOW - 1000, NOW - WINDOW_MS, NOW - WINDOW_MS - 1];
    expect(countShownInWindow(ts, NOW)).toBe(2);
  });

  it('is zero for an empty list', () => {
    expect(countShownInWindow([], NOW)).toBe(0);
  });
});

describe('reportedShownCount', () => {
  it('is 1 for a never-shown guest', () => {
    expect(reportedShownCount([], NOW)).toBe(1);
  });

  it('is the prior in-window count + 1', () => {
    expect(reportedShownCount([NOW - 1000, NOW - 2000], NOW)).toBe(3);
  });

  it('ignores impressions outside the window', () => {
    expect(reportedShownCount([NOW - WINDOW_MS - 1, NOW - 1000], NOW)).toBe(2);
  });

  // The reported number and the gate cap must agree: at MAX-1 prior
  // impressions the guest sees the Nth (reported === MAX) and the gate still
  // shows; at MAX the gate flips to freq_cap and the banner is not shown — so
  // the reported count can never exceed E13_MAX_PER_WINDOW.
  it('stays consistent with the gate cap', () => {
    const belowCap = Array.from({ length: E13_MAX_PER_WINDOW - 1 }, (_, i) => NOW - i * 1000);
    expect(reportedShownCount(belowCap, NOW)).toBe(E13_MAX_PER_WINDOW);
    expect(shouldShowGuestBanner({ ...ALLOW, shownTs: belowCap })).toEqual({ show: true });

    const atCap = Array.from({ length: E13_MAX_PER_WINDOW }, (_, i) => NOW - i * 1000);
    expect(shouldShowGuestBanner({ ...ALLOW, shownTs: atCap })).toEqual({
      show: false,
      reason: 'freq_cap',
    });
  });
});

describe('shown-timestamp storage', () => {
  beforeEach(() => window.localStorage.removeItem(E13_SHOWN_LS_KEY));
  afterEach(() => window.localStorage.removeItem(E13_SHOWN_LS_KEY));

  it('returns [] when nothing is stored', () => {
    expect(readGuestBannerShownTimestamps()).toEqual([]);
  });

  it('round-trips a recorded impression', () => {
    recordGuestBannerShown(NOW);
    expect(readGuestBannerShownTimestamps()).toEqual([NOW]);
  });

  it('appends successive impressions', () => {
    recordGuestBannerShown(NOW - 2000);
    recordGuestBannerShown(NOW - 1000);
    recordGuestBannerShown(NOW);
    expect(readGuestBannerShownTimestamps()).toEqual([NOW - 2000, NOW - 1000, NOW]);
  });

  it('prunes impressions outside the window on write', () => {
    window.localStorage.setItem(E13_SHOWN_LS_KEY, JSON.stringify([NOW - WINDOW_MS - 1, NOW - 5000]));
    recordGuestBannerShown(NOW);
    expect(readGuestBannerShownTimestamps()).toEqual([NOW - 5000, NOW]);
  });

  it('returns [] for corrupt JSON', () => {
    window.localStorage.setItem(E13_SHOWN_LS_KEY, '{not-json');
    expect(readGuestBannerShownTimestamps()).toEqual([]);
  });

  it('returns [] when the stored value is not an array', () => {
    window.localStorage.setItem(E13_SHOWN_LS_KEY, JSON.stringify({ a: 1 }));
    expect(readGuestBannerShownTimestamps()).toEqual([]);
  });

  it('drops non-numeric / non-finite entries', () => {
    window.localStorage.setItem(E13_SHOWN_LS_KEY, JSON.stringify([NOW, 'x', null, NOW - 1000]));
    expect(readGuestBannerShownTimestamps()).toEqual([NOW, NOW - 1000]);
  });

  it('caps the stored array at SHOWN_TS_CAP entries', () => {
    // Seed more than the cap, all inside the window, then record one more.
    const seed = Array.from({ length: SHOWN_TS_CAP + 10 }, (_, i) => NOW - (i + 1) * 1000);
    window.localStorage.setItem(E13_SHOWN_LS_KEY, JSON.stringify(seed));
    recordGuestBannerShown(NOW);
    const stored = readGuestBannerShownTimestamps();
    expect(stored.length).toBe(SHOWN_TS_CAP);
    // slice(-CAP) keeps the most recent — the just-written NOW must survive.
    expect(stored[stored.length - 1]).toBe(NOW);
  });

  it('swallows a localStorage quota error on write (no throw)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => recordGuestBannerShown(NOW)).not.toThrow();
    spy.mockRestore();
  });
});

describe('dismiss-timestamp storage', () => {
  beforeEach(() => window.localStorage.removeItem(E13_DISMISS_LS_KEY));
  afterEach(() => window.localStorage.removeItem(E13_DISMISS_LS_KEY));

  it('returns null when nothing is stored', () => {
    expect(readGuestBannerDismissedAt()).toBeNull();
  });

  it('round-trips a dismiss timestamp', () => {
    recordGuestBannerDismissed(NOW);
    expect(readGuestBannerDismissedAt()).toBe(NOW);
  });

  it('returns null for a non-numeric stored value', () => {
    window.localStorage.setItem(E13_DISMISS_LS_KEY, 'nope');
    expect(readGuestBannerDismissedAt()).toBeNull();
  });

  it('swallows a localStorage quota error on write (no throw)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => recordGuestBannerDismissed(NOW)).not.toThrow();
    spy.mockRestore();
  });
});
