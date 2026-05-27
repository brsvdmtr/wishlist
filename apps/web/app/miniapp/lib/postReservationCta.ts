'use client';

// E11 — Post-reservation account-claim CTA decision logic.
//
// After a successful guest reservation we show a Sheet inviting the user to
// create their own wishlist. This is the most viral moment in the product —
// the user just reserved a gift, felt the value, and is one tap away from
// owning the other side of the loop.
//
// All gating lives here so it is testable without React, DOM, or storage.
// `shouldShowE11Cta` is a pure function; `readLastSeenAt` / `writeLastSeenAt`
// touch `window.localStorage` and are isolated for that reason.
//
// Spec: docs/research/06-experiment-backlog.md § E11.
// Mockup: docs/design-system/mockups/approved/e11-post-reservation-cta.html.

export const E11_LS_KEY = 'wb_e11_cta_seen_at_v1';
export const E11_COOLDOWN_DAYS = 30;
/**
 * Experiment key for the E11 A/B (sticky bucket, 5% global holdout). To enable
 * on a host, set in `/opt/wishlist/.env` and `docker compose up -d api`:
 *
 *   EXP_E11_POST_RESERVE_CTA_ENABLED=true
 *   EXP_E11_POST_RESERVE_CTA_ROLLOUT=50
 *
 * Without these, the hook returns `control` and the sheet never shows.
 */
export const E11_EXPERIMENT_KEY = 'e11-post-reserve-cta';
export const E11_ONBOARDING_ENTRY_POINT = 'post_reservation_claim';

const COOLDOWN_MS = E11_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;

export type E11SkipReason =
  | 'secret_reservation'
  | 'owner_as_guest'
  | 'not_in_treatment'
  | 'session_shown'
  | 'cooldown';

export type E11Decision =
  | { show: true }
  | { show: false; reason: E11SkipReason };

export interface E11GateInput {
  /** Number of own wishlists the user currently has. `0` = pure guest. */
  wishlistCount: number;
  /** Server-resolved variant via `useExperiment(E11_EXPERIMENT_KEY)`. */
  experimentVariant: 'control' | 'treatment';
  /** True if the CTA already fired in this Mini App session. */
  sessionFlag: boolean;
  /** Epoch ms of last show (localStorage); `null` if never seen. */
  lastSeenAt: number | null;
  /** True for secret-reserve flow — gated out (different paywall context). */
  isSecretReservation: boolean;
  /** Current time, injected for testability. */
  now: number;
  /**
   * God-mode test bypass — when true, ALL gates are skipped and `show: true`
   * is returned. Lets operators verify the sheet on their own account
   * (which usually has own wishlists, failing `owner_as_guest`). Downstream
   * analytics must filter on `godModeForce: true` prop to keep the
   * experiment funnel clean. Default false in production code paths.
   */
  godModeForce?: boolean;
}

/**
 * Decide whether to surface the E11 sheet after a successful reservation.
 *
 * Gate order is intentional: cheapest / least likely → most likely. The first
 * `show: false` wins; later gates are not evaluated. The `reason` is returned
 * verbatim so callers can log why the sheet did not appear (useful when
 * funnel numbers look off).
 */
export function shouldShowE11Cta(input: E11GateInput): E11Decision {
  // God-mode force-show bypasses every gate. Still respects session flag
  // so a single tap of "Позже" closes the loop within one app-open even
  // for operators (otherwise it would re-open after every reservation).
  if (input.godModeForce && !input.sessionFlag) return { show: true };
  if (input.isSecretReservation) return { show: false, reason: 'secret_reservation' };
  if (input.wishlistCount > 0) return { show: false, reason: 'owner_as_guest' };
  if (input.experimentVariant !== 'treatment') return { show: false, reason: 'not_in_treatment' };
  if (input.sessionFlag) return { show: false, reason: 'session_shown' };
  if (input.lastSeenAt !== null && input.now - input.lastSeenAt < COOLDOWN_MS) {
    return { show: false, reason: 'cooldown' };
  }
  return { show: true };
}

/**
 * Read the last-seen timestamp from localStorage. Returns `null` for SSR,
 * disabled storage, or any parse failure — the gate treats null as "never
 * seen" (which lets the sheet appear).
 */
export function readLastSeenAt(): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = window.localStorage.getItem(E11_LS_KEY);
    if (!v) return null;
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * Persist the last-seen timestamp to localStorage. Best-effort — quota
 * exhaustion / private-mode rejection is swallowed, the sheet will simply
 * show again next session (acceptable degradation).
 */
export function writeLastSeenAt(now: number): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(E11_LS_KEY, String(now));
  } catch {
    /* quota / private mode — best effort */
  }
}
