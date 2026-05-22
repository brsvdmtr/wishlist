// A/B experiment infrastructure — Phase 0 of the experiment backlog
// (docs/research/06-experiment-backlog.md). The shared machinery every later
// experiment builds on, so experiments stop being ad-hoc.
//
// Three concerns live here:
//   1. Pure deterministic bucketing (hashBucket / isInHoldout / assignVariant)
//      — the same userId always lands in the same bucket, no per-call
//      randomness, no DB needed.
//   2. Env-flag config (readExperimentConfig) — EXP_<NAME>_ENABLED /
//      EXP_<NAME>_ROLLOUT. Fails closed: an unconfigured experiment is off.
//   3. Sticky persistence (getExperimentAssignment) — one ExperimentAssignment
//      row per (user, experiment), written on first exposure, with the
//      `experiment.assigned` event emitted exactly once.
//
// Operator guide: docs/research/experiments/README.md.

import { createHash } from 'node:crypto';
import { prisma, Prisma } from '@wishlist/db';
import { trackProductEvent } from './analytics';

export type ExperimentVariant = 'control' | 'treatment';

export interface ExperimentConfig {
  /** Master switch — EXP_<NAME>_ENABLED. */
  enabled: boolean;
  /** Treatment share for users assigned while this value is live, 0..100. */
  rolloutPercent: number;
}

export interface ExperimentAssignmentResult {
  key: string;
  variant: ExperimentVariant;
  /** True when the user is in the global holdout (always control). */
  holdout: boolean;
  /** True when the experiment is enabled. */
  active: boolean;
}

/**
 * Global holdout: a fixed slice of users is held out of EVERY experiment, so
 * there is always a clean cohort that no treatment has ever touched.
 */
export const HOLDOUT_PERCENT = 5;

// Hash space granularity — 10 000 buckets gives 0.01% resolution on rollout %.
const BUCKET_COUNT = 10_000;

// ─────────────────────────────────────────────────────────────────────────────
// Pure deterministic bucketing
// ─────────────────────────────────────────────────────────────────────────────

// Stable bucket in [0, 9999] for an arbitrary seed: SHA-256 of the seed, first
// 4 bytes as a big-endian uint32, mod BUCKET_COUNT. Deterministic across
// processes and restarts.
function hashBucket(seed: string): number {
  return createHash('sha256').update(seed).digest().readUInt32BE(0) % BUCKET_COUNT;
}

function clampPercent(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.trunc(n)));
}

/**
 * Whether the user is in the global holdout. The salt is a constant unrelated
 * to any experiment key, so holdout membership is independent of — and never
 * collides with — any single experiment's own bucketing.
 */
export function isInHoldout(userId: string): boolean {
  return hashBucket(`holdout::${userId}`) < HOLDOUT_PERCENT * 100;
}

/**
 * Deterministic variant for one (user, experiment) at a given rollout. Same
 * inputs always yield the same variant. Monotonic in rolloutPercent: raising
 * the rollout only ever moves a user control → treatment, never back.
 */
export function assignVariant(
  userId: string,
  key: string,
  rolloutPercent: number,
): ExperimentVariant {
  return hashBucket(`exp::${key}::${userId}`) < clampPercent(rolloutPercent) * 100
    ? 'treatment'
    : 'control';
}

/**
 * Full pure resolution of a user's variant: a disabled experiment and a
 * holdout user both resolve to control; everyone else is bucketed by rollout.
 */
export function resolveExperiment(
  userId: string,
  key: string,
  config: ExperimentConfig,
): { variant: ExperimentVariant; holdout: boolean } {
  if (!config.enabled) return { variant: 'control', holdout: false };
  if (isInHoldout(userId)) return { variant: 'control', holdout: true };
  return { variant: assignVariant(userId, key, config.rolloutPercent), holdout: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Env-flag config
// ─────────────────────────────────────────────────────────────────────────────

// Lowercase kebab-case, 2-49 chars. The strict shape also bounds the env-var
// name derived from the key, so a request cannot probe arbitrary process.env
// entries through the :key route param.
const EXPERIMENT_KEY_PATTERN = /^[a-z][a-z0-9-]{1,48}$/;

export function isValidExperimentKey(key: string): boolean {
  return EXPERIMENT_KEY_PATTERN.test(key);
}

/** 'new-onboarding' -> 'NEW_ONBOARDING' (env: EXP_NEW_ONBOARDING_ENABLED). */
export function experimentEnvName(key: string): string {
  return key.toUpperCase().replace(/-/g, '_');
}

function parseEnabled(raw: string | undefined): boolean {
  const v = (raw ?? '').toLowerCase().trim();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

/**
 * Read EXP_<NAME>_ENABLED / EXP_<NAME>_ROLLOUT for an experiment key. Fails
 * closed — an unconfigured experiment is disabled and a missing or garbage
 * rollout is 0%.
 */
export function readExperimentConfig(
  key: string,
  env: NodeJS.ProcessEnv = process.env,
): ExperimentConfig {
  const name = experimentEnvName(key);
  return {
    enabled: parseEnabled(env[`EXP_${name}_ENABLED`]),
    rolloutPercent: clampPercent(Number.parseInt((env[`EXP_${name}_ROLLOUT`] ?? '').trim(), 10)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sticky persistence + exposure event
// ─────────────────────────────────────────────────────────────────────────────

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
}

function toVariant(value: string): ExperimentVariant {
  return value === 'treatment' ? 'treatment' : 'control';
}

/**
 * Resolve a user's variant for `key`, persisting it on first exposure.
 *
 * Read-through: an existing ExperimentAssignment row always wins, so the
 * variant is sticky for the user's lifetime — it does not move when ROLLOUT
 * changes later. The row is created exactly once per (user, experiment); that
 * first write is the only place `experiment.assigned` is emitted, so the
 * exposure event is never doubled — even under concurrent requests, where a
 * losing racer hits the unique constraint and adopts the winner's row.
 *
 * A disabled experiment short-circuits to control and writes nothing — this
 * is the kill switch, and it overrides already-persisted assignments.
 */
export async function getExperimentAssignment(
  userId: string,
  key: string,
  config: ExperimentConfig,
): Promise<ExperimentAssignmentResult> {
  if (!config.enabled) {
    return { key, variant: 'control', holdout: false, active: false };
  }

  const existing = await prisma.experimentAssignment.findUnique({
    where: { userId_experimentKey: { userId, experimentKey: key } },
  });
  if (existing) {
    return { key, variant: toVariant(existing.variant), holdout: existing.holdout, active: true };
  }

  const resolved = resolveExperiment(userId, key, config);
  try {
    await prisma.experimentAssignment.create({
      data: {
        userId,
        experimentKey: key,
        variant: resolved.variant,
        holdout: resolved.holdout,
      },
    });
    // Reached exactly once per (user, experiment) — guarded by the unique
    // index — so the exposure event is emitted exactly once.
    trackProductEvent({
      event: 'experiment.assigned',
      userId,
      props: { key, variant: resolved.variant, holdout: resolved.holdout },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // A concurrent request created the row first — adopt its value so both
    // callers agree. The winner already emitted `experiment.assigned`.
    const row = await prisma.experimentAssignment.findUnique({
      where: { userId_experimentKey: { userId, experimentKey: key } },
    });
    if (row) {
      return { key, variant: toVariant(row.variant), holdout: row.holdout, active: true };
    }
  }

  return { key, variant: resolved.variant, holdout: resolved.holdout, active: true };
}
