// Group Gift unlock price — E24 price-elasticity experiment (`group-gift-price`).
//
// Hypothesis (docs/research/06-experiment-backlog.md E24): 79 ⭐ may be too
// steep a gate for a one-time unlock; 39 ⭐ may lift unlock-rate and revenue
// per paywall impression. This module is the SINGLE source of truth for the
// bucket-aware price, so every surface that shows OR charges the price agrees:
//
//   1. GET /tg/wishlists bootstrap  → the price the paywall SCREEN displays
//      (ggAccess.priceXtr) + the variant the client tags its impression with.
//   2. POST /tg/billing/addon/checkout → the invoice AMOUNT actually charged.
//   3. POST /tg/items/:id/group-gift   → the 402 backstop paywall price.
//
// The variant is resolved through the existing sticky assignment
// (services/experiments.service.ts → getExperimentAssignment): the variant is
// written once per (user, experiment) and never moves, so a user can never see
// one price and be charged another — even across rollout-% changes. When the
// experiment is DISABLED (the default — EXP_GROUP_GIFT_PRICE_ENABLED unset),
// getExperimentAssignment short-circuits to `control` with NO DB read/write, so
// this module adds zero cost and zero behaviour change until an operator flips
// the env flag. Holdout users always resolve to control (never discounted).
//
// Env knobs:
//   EXP_GROUP_GIFT_PRICE_ENABLED   master switch (fails closed)
//   EXP_GROUP_GIFT_PRICE_ROLLOUT   treatment share 0..100
//   GROUP_GIFT_PRICE_XTR           control price (default 79) — shared with
//                                  ONE_TIME_SKUS.group_gift_unlock.price
//   GROUP_GIFT_PRICE_TEST_XTR      treatment price (default 39)

import { GROUP_GIFT_PRICE_XTR } from './entitlement';
import {
  getExperimentAssignment,
  readExperimentConfig,
  type ExperimentVariant,
} from './experiments.service';

/** Experiment key. experimentEnvName('group-gift-price') === 'GROUP_GIFT_PRICE'. */
export const GROUP_GIFT_PRICE_EXPERIMENT_KEY = 'group-gift-price';

/**
 * Control price = the live GROUP_GIFT_PRICE_XTR (default 79). Imported (not
 * re-parsed) so there is exactly ONE place the control price is defined; it
 * also stays in lock-step with ONE_TIME_SKUS.group_gift_unlock.price.
 */
export const GROUP_GIFT_CONTROL_PRICE_XTR = GROUP_GIFT_PRICE_XTR;

/** Treatment price — the E24 cheaper variant (default 39). */
export const GROUP_GIFT_TEST_PRICE_XTR = parseInt(process.env.GROUP_GIFT_PRICE_TEST_XTR ?? '39', 10);

/** Pure variant → unlock price. control/holdout → control; treatment → test. */
export function groupGiftPriceForVariant(variant: ExperimentVariant): number {
  return variant === 'treatment' ? GROUP_GIFT_TEST_PRICE_XTR : GROUP_GIFT_CONTROL_PRICE_XTR;
}

export interface GroupGiftPriceResolution {
  /** Stars price for this user's bucket — show this AND charge this. */
  priceXtr: number;
  /** Sticky variant (control for disabled experiment / holdout). */
  variant: ExperimentVariant;
  controlPriceXtr: number;
  testPriceXtr: number;
}

/**
 * Resolve a user's sticky Group Gift unlock price. Safe to call on hot paths:
 * when the experiment is off it does no DB work; otherwise it does one indexed
 * read (plus a single first-exposure write that also emits `experiment.assigned`
 * exactly once). Call this only for users who are NOT yet entitled — entitled
 * users never see or pay the price, so assigning them is pure noise.
 */
export async function resolveGroupGiftUnlockPrice(userId: string): Promise<GroupGiftPriceResolution> {
  const config = readExperimentConfig(GROUP_GIFT_PRICE_EXPERIMENT_KEY);
  const assignment = await getExperimentAssignment(userId, GROUP_GIFT_PRICE_EXPERIMENT_KEY, config);
  return {
    priceXtr: groupGiftPriceForVariant(assignment.variant),
    variant: assignment.variant,
    controlPriceXtr: GROUP_GIFT_CONTROL_PRICE_XTR,
    testPriceXtr: GROUP_GIFT_TEST_PRICE_XTR,
  };
}
