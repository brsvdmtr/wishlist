// Growth-first limits experiment ("growth-first-limits") — PREPARED, OFF BY
// DEFAULT. This module is the single source of truth for Variant B (the
// growth-first limit set). It exists so the entitlement resolver can serve
// experiment-aware plan limits WITHOUT mutating the production defaults in
// services/entitlement.ts (PLANS, FREE_*_QUOTA stay byte-identical).
//
// Design (see docs/research/growth-first-ab-plan.md):
//   - Variant A (control)   = current production limits (entitlement.PLANS).
//   - Variant B (treatment) = GROWTH_FIRST_FREE_PLAN below — a materially more
//     generous FREE tier. PRO numeric limits are intentionally UNCHANGED;
//     varying PRO simultaneously would confound the PRO-revenue guardrails.
//   - Resolution is READ-ONLY (peekExperimentVariant): reading a user's limits
//     never enrolls them or emits an exposure event, so schedulers and bot
//     callbacks are safe. Enrolment + exposure stay with the standard
//     GET /tg/experiments/:key flow (the Mini App `useExperiment` hook), to be
//     wired at launch.
//   - Fails closed: experiment disabled (the default) OR user is
//     control/holdout/unenrolled → production limits. Existing users are
//     therefore byte-for-byte unaffected until the flag is flipped AND the
//     user is enrolled into `treatment`.
//
// Import direction note (no runtime cycle): this module imports ONLY TYPES
// from ./entitlement (erased at compile time) plus VALUES from
// ./experiments.service. ./entitlement imports VALUES back from here. The sole
// runtime edge is entitlement → limits-experiment, so there is no init-order
// hazard. Growth-first numbers are literals here (they do not reference PLANS),
// so this module loads independently of ./entitlement.
//
// Registry note: experiment-family modules are documented under docs/research/
// (this one: docs/research/growth-first-ab-plan.md), NOT in docs/SERVICES.md's
// numbered service table — consistent with services/experiments.service.ts (the
// A/B infra this builds on, also absent from that table). It has a single
// consumer (entitlement.ts), below the 3+-consumer cross-cutting bar SERVICES.md
// tracks.

import type { PlanCode, PlanLimits } from './entitlement';
import {
  peekExperimentVariant,
  readExperimentConfig,
  type ExperimentVariant,
} from './experiments.service';

/** Experiment key (kebab-case). Env flags: EXP_GROWTH_FIRST_LIMITS_ENABLED /
 *  EXP_GROWTH_FIRST_LIMITS_ROLLOUT. Unset → disabled (everyone control). */
export const GROWTH_FIRST_LIMITS_KEY = 'growth-first-limits';

// ─── Variant B: growth-first FREE plan (LIVE — drives getUserEntitlement) ────
//
// Deltas vs production PLANS.FREE (2 / 20 / 10 / 2 / 1):
//   wishlists           2 → 3
//   items              20 → 30
//   participants       10 → 10   (unchanged — already raised to 10 in prod)
//   subscriptions       2 → 5
//   categoriesPerWishlist 1 → 3
//
// `features: []` matches production FREE — feature unlocks (comments, url_import,
// hints, advanced privacy, showcase, reservation pro, birthday/santa advanced)
// stay PRO-side. The growth lever is the more generous FREE *quantity* limits,
// not handing FREE the PRO feature set.
export const GROWTH_FIRST_FREE_PLAN: PlanLimits = {
  code: 'FREE',
  wishlists: 3,
  items: 30,
  participants: 10,
  subscriptions: 5,
  categoriesPerWishlist: 3,
  features: [],
};

// ─── Declared-but-deferred levers (NOT consumed by the resolver in Phase-1) ──
//
// These three Variant B levers are the single source of truth for the plan doc
// and the launch wiring, but are deliberately NOT yet read by the entitlement
// resolver — each lives in a separate enforcement path (or needs new product
// surface), and wiring display without enforcement would create a
// "shows 10, allows 5" landmine. See growth-first-ab-plan.md § "Launch wiring".
//
//   freeImportQuotaPerMonth: prod 5  → 10  (services/import-credits.ts)
//   freeHintQuotaPerMonth:   prod 3  → 5   (services/hint-credits.ts)
//   freeCuratedSelectionsPerMonth: prod 0 → 1  (currently a hard PRO gate;
//     needs a new FREE monthly counter — see wishlists.routes.ts selections)
export const GROWTH_FIRST_DECLARED_QUOTAS = {
  freeImportQuotaPerMonth: 10,
  freeHintQuotaPerMonth: 5,
  freeCuratedSelectionsPerMonth: 1,
} as const;

/**
 * Pure: growth-first FREE plan for `treatment`, otherwise `null` (control —
 * meaning "use the production plan"). Returning null rather than a production
 * copy keeps production ownership in ./entitlement (single source of truth for
 * PLANS) and makes the A/B difference trivially testable (self-check #1).
 *
 * Deterministic and side-effect-free — no I/O, same input → same output.
 */
export function growthFirstFreePlanForVariant(
  variant: ExperimentVariant,
): PlanLimits | null {
  return variant === 'treatment' ? GROWTH_FIRST_FREE_PLAN : null;
}

/**
 * Resolve this user's growth-first-limits variant, READ-ONLY. Reads env config
 * + any persisted assignment; never writes, never emits exposure (see
 * peekExperimentVariant). Returns 'control' when the experiment is disabled
 * (default), so the entitlement resolver does zero extra DB work until launch.
 */
export async function resolveGrowthFirstVariant(
  userId: string,
): Promise<ExperimentVariant> {
  // readExperimentConfig also parses EXP_..._ROLLOUT, but peek IGNORES rollout —
  // it reads the persisted row. Rollout governs ENROLMENT only
  // (getExperimentAssignment / assignVariant), never the read path. Do not wire
  // rollout in here.
  const config = readExperimentConfig(GROWTH_FIRST_LIMITS_KEY);
  return peekExperimentVariant(userId, GROWTH_FIRST_LIMITS_KEY, config);
}

// Re-export the plan-code type so callers can stay in this module's vocabulary.
export type { PlanCode };
