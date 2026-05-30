// Yearly Pro price — E17 price-elasticity experiment (`yearly-price`).
//
// Hypothesis (docs/research/06-experiment-backlog.md E17): the 800 ⭐/yr ticket
// is untested. A cheaper 600 ⭐ may lift yearly conversion enough that revenue
// per yearly-paywall impression rises despite the lower ticket; a pricier
// 1000 ⭐ may raise revenue per buyer without materially hurting conversion.
// Three balanced arms:
//
//   control → 800  (PRO_YEARLY_PRICE_XTR — the live price)
//   a       → 600  (PRO_YEARLY_PRICE_A_XTR — cheaper)
//   b       → 1000 (PRO_YEARLY_PRICE_B_XTR — pricier)
//
// Like E24 (services/group-gift-pricing.ts), this module is the SINGLE source of
// truth for the bucket-aware yearly price, fed to every surface that SHOWS or
// CHARGES it so they can never disagree (shown == charged):
//
//   1. GET /tg/wishlists bootstrap        → proYearly.priceXtr (the paywall tile
//      + CTA price) and proYearly.priceVariant (so the client tags its paywall
//      impression).
//   2. POST /tg/billing/pro/checkout      → the invoice AMOUNT charged for a
//      yearly plan; the bucket is also appended to the invoice payload so the
//      bot stamps payment.completed / pro.activated with it (self-check #4).
//   3. GET /tg/me/plan                    → proYearlyPriceStars /
//      proYearlyPriceVariant (the canonical pricing endpoint, kept consistent
//      with the charged price so no future consumer can read a stale 800).
//
// The variant is resolved through the sticky multi-variant assignment
// (experiments.service.ts → getWeightedAssignment): pinned once per (user,
// experiment), so a user can never see one price and be charged another — even
// across rollout-% changes. When the experiment is DISABLED (the default —
// EXP_YEARLY_PRICE_ENABLED unset), getWeightedAssignment short-circuits to
// control with NO DB read/write, so this module is byte-identical to today's
// flat 800 ⭐ until an operator flips the env flag. Holdout users always resolve
// to control (never discounted, never upcharged).
//
// Resolve ONLY non-Pro users — Pro users never see the paywall, so assigning
// them is pure noise. Existing yearly subscribers are untouched regardless: a
// subscription's entitlement is its billingPeriod + currentPeriodEnd, never
// re-priced from this module (self-check #3); the price is read only when a
// NEW invoice is created.
//
// Env knobs:
//   EXP_YEARLY_PRICE_ENABLED   master switch (fails closed)
//   EXP_YEARLY_PRICE_ROLLOUT   test-arm enrolment share 0..100 (split 50/50 a:b;
//                              the rest stay control). 67 ≈ a balanced 3-way.
//   PRO_YEARLY_PRICE_XTR       control price (default 800) — shared with billing.
//   PRO_YEARLY_PRICE_A_XTR     cheaper arm (default 600)
//   PRO_YEARLY_PRICE_B_XTR     pricier arm (default 1000)

import { PRO_YEARLY_PRICE_XTR } from './entitlement';
import {
  getWeightedAssignment,
  readExperimentConfig,
  type WeightedVariant,
} from './experiments.service';

/** Experiment key. experimentEnvName('yearly-price') === 'YEARLY_PRICE'. */
export const YEARLY_PRICE_EXPERIMENT_KEY = 'yearly-price';

/**
 * Control price = the live PRO_YEARLY_PRICE_XTR (default 800). Imported (not
 * re-parsed) so there is exactly ONE place the control price is defined; it
 * stays in lock-step with the billing checkout's yearly price.
 */
export const YEARLY_CONTROL_PRICE_XTR = PRO_YEARLY_PRICE_XTR;

/** Cheaper test arm (default 600). */
export const YEARLY_A_PRICE_XTR = parseInt(process.env.PRO_YEARLY_PRICE_A_XTR ?? '600', 10);

/** Pricier test arm (default 1000). */
export const YEARLY_B_PRICE_XTR = parseInt(process.env.PRO_YEARLY_PRICE_B_XTR ?? '1000', 10);

/**
 * Pure variant → yearly price. control / holdout / disabled / any unknown label
 * all fall back to the control price — the resolver can never accidentally
 * discount or upcharge a user it didn't deliberately bucket.
 */
export function yearlyPriceForVariant(variant: string): number {
  if (variant === 'a') return YEARLY_A_PRICE_XTR;
  if (variant === 'b') return YEARLY_B_PRICE_XTR;
  return YEARLY_CONTROL_PRICE_XTR;
}

/**
 * Build the 3-way weight split from the rollout %. `rolloutPercent` is the share
 * of (non-holdout) users enrolled into a TEST arm, split evenly a:b; the rest
 * stay control — the same "ROLLOUT = non-control share" mental model as the
 * binary path. Control is FIRST so raising the test share only ever moves a
 * not-yet-assigned user one-way out of control. Weights are buckets out of
 * 10 000 and always sum to 10 000 (the a:b remainder split avoids rounding
 * drift for odd rollouts).
 *
 *   rollout 0   → control 10000, a 0,    b 0      (all control — dormant / ramp start)
 *   rollout 67  → control 3300,  a 3350, b 3350   (balanced 3-way)
 *   rollout 100 → control 0,     a 5000, b 5000   (no in-experiment control —
 *                                                  the 5% holdout is the baseline)
 */
export function yearlyPriceWeights(rolloutPercent: number): WeightedVariant[] {
  // Clamp + NaN-guard so the function is robust standalone (callers pass the
  // already-clamped config.rolloutPercent, but a NaN here would poison every
  // weight and silently break the split).
  const r = Number.isFinite(rolloutPercent)
    ? Math.min(100, Math.max(0, Math.trunc(rolloutPercent)))
    : 0;
  const testBps = r * 100; // total test-arm buckets out of 10 000
  const aBps = Math.floor(testBps / 2);
  const bBps = testBps - aBps; // remainder → no drift when testBps is odd
  return [
    { variant: 'control', weightBps: 10_000 - testBps },
    { variant: 'a', weightBps: aBps },
    { variant: 'b', weightBps: bBps },
  ];
}

export interface YearlyPriceResolution {
  /** Stars price for this user's bucket — show this AND charge this. */
  priceXtr: number;
  /** Sticky variant: 'control' | 'a' | 'b' (control for disabled experiment / holdout). */
  variant: string;
  /**
   * True only when the experiment is enabled. Callers gate the bucket plumbing
   * on this so a DORMANT experiment is byte-identical to today: no `proYearly`
   * in the bootstrap, no `proYearlyPriceVariant` on /me/plan, no bucket suffix
   * on the invoice payload — the price is just the flat control 800.
   */
  active: boolean;
  controlPriceXtr: number;
  aPriceXtr: number;
  bPriceXtr: number;
}

/**
 * Resolve a user's sticky yearly Pro price. Call ONLY for non-Pro users (Pro
 * users never see or pay it — assigning them is noise). Safe on hot paths: when
 * the experiment is off it does no DB work; otherwise one indexed read (plus a
 * single first-exposure write that also emits `experiment.assigned` exactly
 * once).
 */
export async function resolveYearlyProPrice(userId: string): Promise<YearlyPriceResolution> {
  const config = readExperimentConfig(YEARLY_PRICE_EXPERIMENT_KEY);
  const assignment = await getWeightedAssignment(
    userId,
    YEARLY_PRICE_EXPERIMENT_KEY,
    config,
    yearlyPriceWeights(config.rolloutPercent),
  );
  return {
    priceXtr: yearlyPriceForVariant(assignment.variant),
    variant: assignment.variant,
    active: assignment.active,
    controlPriceXtr: YEARLY_CONTROL_PRICE_XTR,
    aPriceXtr: YEARLY_A_PRICE_XTR,
    bPriceXtr: YEARLY_B_PRICE_XTR,
  };
}

export interface YearlyDisplayPrice {
  priceXtr: number;
  variant: string;
}

/**
 * Display-surface helper for the two READ endpoints that SHOW the yearly price
 * (bootstrap `GET /tg/wishlists` and `GET /tg/me/plan`). Returns the bucket
 * price + variant to surface, or `null` when nothing experiment-specific should
 * appear:
 *   - Pro users — they never see the paywall, and existing subscribers are
 *     never re-priced (self-check #3);
 *   - dormant experiment (active:false) — byte-identical to today: the caller
 *     omits the field and falls back to the flat control price.
 *
 * Centralises the `!isPro` + `active` gating that both display surfaces share so
 * (a) they resolve identically to the /pro/checkout charge path (shown ==
 * charged), and (b) the gating is unit-tested in ONE place instead of being
 * duplicated inline across two large route handlers.
 */
export async function resolveYearlyDisplay(
  userId: string,
  isPro: boolean,
): Promise<YearlyDisplayPrice | null> {
  if (isPro) return null;
  const yp = await resolveYearlyProPrice(userId);
  if (!yp.active) return null;
  return { priceXtr: yp.priceXtr, variant: yp.variant };
}
