'use client';

// E13 — Passive guest-view "create your own wishlist" banner decision logic.
//
// A soft, non-blocking Banner rendered at the END of a guest's view of
// someone else's wishlist. Unlike E11 (a post-reservation Sheet at the
// hottest moment), E13 is the "always-on" ambient channel: huge reach
// (every guest), modest per-guest lift. It must never interfere with the
// reservation flow and must not nag — hence the frequency cap below.
//
// All gating lives here so it is testable without React, DOM, or storage.
// `shouldShowGuestBanner` is a pure function; the `read*` / `record*`
// helpers are the only code that touches `window.localStorage` and are
// isolated for that reason (mirrors lib/postReservationCta.ts — E11).
//
// Spec:   docs/research/06-experiment-backlog.md § E13.
// Mockup: docs/design-system/mockups/proposed/e13-guest-view-banner.html.

export const E13_SHOWN_LS_KEY = 'wb_e13_banner_shown_ts_v1';
export const E13_DISMISS_LS_KEY = 'wb_e13_banner_dismissed_at_v1';

/**
 * Rolling window for the impression cap — "не показывать чаще N раз за 7 дней".
 * At most `E13_MAX_PER_WINDOW` passive impressions are counted per this window.
 */
export const E13_IMPRESSION_WINDOW_DAYS = 7;
/**
 * Independent mute applied after an explicit × dismiss — a stronger "not now"
 * signal than a passive view. Aliases the impression window today, but kept as
 * its own constant so the two policies can diverge later (e.g. "dismiss mutes
 * 30d, but show up to 3×/7d") without a stealth coupling through one shared value.
 */
export const E13_DISMISS_MUTE_DAYS = 7;
/** At most N passive impressions counted per impression window. */
export const E13_MAX_PER_WINDOW = 3;

const IMPRESSION_WINDOW_MS = E13_IMPRESSION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
const DISMISS_MUTE_MS = E13_DISMISS_MUTE_DAYS * 24 * 60 * 60 * 1000;
/**
 * Hard cap on the stored timestamp array so a pathological client (storage
 * never pruned because `recordGuestBannerShown` is never reached) can't grow
 * it without bound. Far above N — pruning by window is the real limiter.
 */
export const SHOWN_TS_CAP = 50;

/**
 * Experiment key for the E13 rollout. Doubles as the kill switch: the banner
 * shows only for users resolved to `treatment`. To launch at 100% (minus the
 * platform-wide 5% holdout) set in `/opt/wishlist/.env` then recreate the
 * container so compose re-interpolates the env (a plain `restart` won't):
 *
 *   EXP_E13_GUEST_BANNER_ENABLED=true
 *   EXP_E13_GUEST_BANNER_ROLLOUT=100
 *   # docker compose up -d --force-recreate api
 *
 * To kill without a redeploy: EXP_E13_GUEST_BANNER_ENABLED=false (then the
 * same --force-recreate) → everyone resolves to control → banner never renders.
 */
export const E13_EXPERIMENT_KEY = 'e13-guest-banner';

/** Onboarding entry point fired when the CTA is tapped (see onboarding.routes.ts). */
export const E13_ONBOARDING_ENTRY_POINT = 'guest_view_banner';

export type E13SkipReason =
  | 'dismissed_session'
  | 'wishlists_not_loaded'
  | 'owner_as_guest'
  | 'banner_priority'
  | 'not_in_treatment'
  | 'dismissed_cooldown'
  | 'freq_cap';

export type E13Decision =
  | { show: true }
  | { show: false; reason: E13SkipReason };

export interface E13GateInput {
  /**
   * True once the user has closed the banner (×) in this Mini App session.
   * Hides it immediately and beats every other gate, including god-mode —
   * an explicit close is the loudest "not now" we can get.
   */
  dismissedThisSession: boolean;
  /**
   * True only when `loadWishlists` resolved successfully at least once this
   * session. Without this gate a transient `/tg/wishlists` 5xx / network blip
   * leaves `wishlists` at `[]` and we'd show the banner to an actual owner
   * (the segment we explicitly skip). Conservative until proven loaded.
   */
  wishlistsLoaded: boolean;
  /** Number of own wishlists the user currently has. `0` = pure guest = target. */
  wishlistCount: number;
  /**
   * True while a higher-priority guest-view banner (the birthday-context
   * banner) is showing. § E13.10 mitigation: at most one promotional banner
   * at a time, so we yield to the contextual one this session.
   */
  birthdayBannerActive: boolean;
  /** Server-resolved variant via `useExperiment(E13_EXPERIMENT_KEY)`. */
  variant: 'control' | 'treatment';
  /** Epoch ms of last explicit dismiss (localStorage); `null` if never. */
  dismissedAt: number | null;
  /** Epoch ms of prior passive impressions (localStorage); unpruned is fine. */
  shownTs: number[];
  /** Current time, injected for testability. */
  now: number;
  /**
   * God-mode test bypass — when true, all gates except `dismissedThisSession`
   * are skipped so an operator (who usually owns wishlists, failing
   * `owner_as_guest`) can verify the banner. Downstream analytics filter on
   * `godModeForce: true` to keep the funnel clean.
   */
  godModeForce?: boolean;
}

/**
 * Count of impressions still inside the rolling window — the running tally the
 * cap is compared against (`>= E13_MAX_PER_WINDOW` → skip). The single source
 * of "how many times has this guest seen it", shared by the gate and
 * `reportedShownCount` so the cap and the analytics prop never drift.
 */
export function countShownInWindow(shownTs: number[], now: number): number {
  return shownTs.reduce((n, t) => (now - t < IMPRESSION_WINDOW_MS ? n + 1 : n), 0);
}

/**
 * The 1-based impression number this guest is about to see — the prior
 * in-window count plus the one we're about to record. Sent verbatim as
 * `shownCountInWindow` on `guest_banner.shown` so the funnel reads "1st / 2nd /
 * 3rd exposure". Derived from `countShownInWindow` so it can never exceed
 * `E13_MAX_PER_WINDOW` (the value at which `shouldShowGuestBanner` returns
 * `freq_cap` and the banner is not shown at all).
 */
export function reportedShownCount(shownTs: number[], now: number): number {
  return countShownInWindow(shownTs, now) + 1;
}

/**
 * Decide whether to render the E13 banner.
 *
 * Gate order is intentional. `dismissed_session` is first so a close always
 * wins (even over god-mode); god-mode then bypasses the segmentation /
 * experiment / frequency gates. The first `show: false` wins; the `reason`
 * is returned verbatim so callers can log why it stayed hidden.
 */
export function shouldShowGuestBanner(input: E13GateInput): E13Decision {
  // An explicit close beats everything — including god-mode (operators reload
  // to re-test). Otherwise the banner would reappear on the next render.
  if (input.dismissedThisSession) return { show: false, reason: 'dismissed_session' };
  if (input.godModeForce) return { show: true };
  // Conservative until wishlists are known — a transient 5xx must not make a
  // real owner look like a fresh guest.
  if (!input.wishlistsLoaded) return { show: false, reason: 'wishlists_not_loaded' };
  if (input.wishlistCount > 0) return { show: false, reason: 'owner_as_guest' };
  // Yield to the contextual birthday banner — one promo banner at a time.
  if (input.birthdayBannerActive) return { show: false, reason: 'banner_priority' };
  if (input.variant !== 'treatment') return { show: false, reason: 'not_in_treatment' };
  // Explicit dismiss mutes for its own window (stronger than the impression cap).
  if (input.dismissedAt !== null && input.now - input.dismissedAt < DISMISS_MUTE_MS) {
    return { show: false, reason: 'dismissed_cooldown' };
  }
  // Passive impression cap — at most N within the rolling window.
  if (countShownInWindow(input.shownTs, input.now) >= E13_MAX_PER_WINDOW) {
    return { show: false, reason: 'freq_cap' };
  }
  return { show: true };
}

/**
 * Read prior impression timestamps from localStorage. Returns `[]` for SSR,
 * disabled storage, or any parse failure — the gate then treats the user as
 * never-shown (which lets the banner appear).
 */
export function readGuestBannerShownTimestamps(): number[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(E13_SHOWN_LS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
  } catch {
    return [];
  }
}

/**
 * Record one passive impression: append `now`, drop anything outside the
 * window, and bound the array length. Best-effort — quota / private-mode
 * rejection is swallowed (the banner simply shows again next session).
 */
export function recordGuestBannerShown(now: number): void {
  if (typeof window === 'undefined') return;
  try {
    const next = [...readGuestBannerShownTimestamps(), now]
      .filter((t) => now - t < IMPRESSION_WINDOW_MS)
      .slice(-SHOWN_TS_CAP);
    window.localStorage.setItem(E13_SHOWN_LS_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode — best effort */
  }
}

/**
 * Read the last explicit-dismiss timestamp. `null` for SSR / disabled storage
 * / parse failure — treated as "never dismissed".
 */
export function readGuestBannerDismissedAt(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(E13_DISMISS_LS_KEY);
    if (!v) return null;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** Persist an explicit-dismiss timestamp. Best-effort. */
export function recordGuestBannerDismissed(now: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(E13_DISMISS_LS_KEY, String(now));
  } catch {
    /* quota / private mode — best effort */
  }
}
