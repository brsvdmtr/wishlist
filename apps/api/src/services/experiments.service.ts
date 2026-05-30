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
 * Keys that MUST resolve through the weighted (multi-variant) path. This is the
 * ENFORCEMENT of the "a key uses EITHER the binary OR the weighted path, never
 * both" invariant — not just a comment. The binary `getExperimentAssignment`
 * and the public `GET /tg/experiments/:key` route both refuse these keys, and
 * `getWeightedAssignment` refuses anything NOT listed here. Without this guard a
 * stray binary read of a weighted key (e.g. a careless `useExperiment('yearly-price')`
 * or a direct hit on the debug route) would persist a binary `treatment` row
 * that the weighted resolver then reads back flattened to 'control' — poisoning
 * the ledger with a phantom arm and pinning that user to a dead label.
 *
 * Every new weighted experiment registers its key here.
 */
export const WEIGHTED_EXPERIMENT_KEYS = new Set<string>(['yearly-price']);

/** True when `key` must be resolved through getWeightedAssignment, not the binary path. */
export function isWeightedExperimentKey(key: string): boolean {
  return WEIGHTED_EXPERIMENT_KEYS.has(key);
}

/**
 * First-exposure write shared by the binary (getExperimentAssignment) and the
 * multi-variant (getWeightedAssignment) sticky resolvers. Creates the
 * ExperimentAssignment row and emits `experiment.assigned` exactly once; if a
 * concurrent request won the race (unique-violation), it adopts that row's
 * value instead so both callers agree. Returns the committed (variant, holdout)
 * — the raw stored label, so the multi-variant caller can keep 'a'/'b' verbatim
 * while the binary caller coerces via `toVariant`.
 *
 * Extracted so the subtle create-vs-race-vs-emit logic lives in ONE place: two
 * inline copies were the kind of duplication that drifts (see the testing rules
 * in CLAUDE.md). Callers own the disabled/holdout/bucketing decisions; this owns
 * only the persistence + dedup.
 */
async function persistFirstExposure(
  userId: string,
  key: string,
  variant: string,
  holdout: boolean,
): Promise<{ variant: string; holdout: boolean }> {
  try {
    await prisma.experimentAssignment.create({
      data: { userId, experimentKey: key, variant, holdout },
    });
    // Reached exactly once per (user, experiment) — guarded by the unique
    // index — so the exposure event is emitted exactly once.
    trackProductEvent({
      event: 'experiment.assigned',
      userId,
      props: { key, variant, holdout },
    });
    return { variant, holdout };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // A concurrent request created the row first — adopt its value so both
    // callers agree. The winner already emitted `experiment.assigned`.
    const row = await prisma.experimentAssignment.findUnique({
      where: { userId_experimentKey: { userId, experimentKey: key } },
    });
    return row ? { variant: row.variant, holdout: row.holdout } : { variant, holdout };
  }
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
  // Refuse weighted keys at the owner layer — resolving a multi-variant key
  // through the binary path would persist + read it back flattened to control.
  if (WEIGHTED_EXPERIMENT_KEYS.has(key)) {
    throw new Error(
      `experiment "${key}" is weighted (multi-variant); call getWeightedAssignment, not getExperimentAssignment`,
    );
  }
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
  const persisted = await persistFirstExposure(userId, key, resolved.variant, resolved.holdout);
  return { key, variant: toVariant(persisted.variant), holdout: persisted.holdout, active: true };
}

/**
 * Read-only variant lookup — the counterpart to getExperimentAssignment that
 * NEVER writes and NEVER emits `experiment.assigned`.
 *
 * Use this anywhere a user's variant must be read without enrolling them or
 * firing an exposure event — most importantly inside server-side resolvers
 * (entitlement / limits) that also run from schedulers and bot callbacks. A
 * cron job resolving a user's limits must not assign that user to an
 * experiment or count them as exposed; enrolment stays the sole job of
 * getExperimentAssignment via the user-initiated GET /tg/experiments/:key
 * (the Mini App's `useExperiment` hook).
 *
 * Semantics — agreeing with getExperimentAssignment for any *committed*
 * enrolment state (the no-row case below is a deliberate, documented divergence,
 * not a disagreement: peek must never enroll or expose an unseen user):
 *   - disabled experiment  → 'control' (kill switch; ZERO DB calls when off —
 *     the common case, so the read path stays free until launch),
 *   - persisted assignment → its stored variant (sticky; holdout rows store
 *     'control', so a holdout user reads 'control'),
 *   - no row yet           → 'control' (NOT pure-bucketed: getExperimentAssignment
 *     would bucket + persist such a user, but peek must not — an unenrolled user
 *     has not been exposed, so they keep current behaviour).
 *
 * Deterministic: for a fixed env + DB state it always returns the same value.
 */
export async function peekExperimentVariant(
  userId: string,
  key: string,
  config: ExperimentConfig,
): Promise<ExperimentVariant> {
  // Symmetric with getExperimentAssignment: peeking a weighted key through the
  // binary reader would flatten its a/b row to 'control' (toVariant) and hand a
  // wrong variant to the caller. Read-only, so it can't poison the ledger, but
  // a weighted peek is still a programming error — fail loud.
  if (WEIGHTED_EXPERIMENT_KEYS.has(key)) {
    throw new Error(
      `experiment "${key}" is weighted (multi-variant); peekExperimentVariant only reads binary experiments`,
    );
  }
  if (!config.enabled) return 'control';
  const existing = await prisma.experimentAssignment.findUnique({
    where: { userId_experimentKey: { userId, experimentKey: key } },
  });
  return existing ? toVariant(existing.variant) : 'control';
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-variant (N-way) assignment
//
// The binary control/treatment path above covers two-arm experiments. A few
// experiments need more than two arms — the first is E17, a 3-way yearly-price
// test (control / a / b). The README flagged multi-variant as a deliberate
// future extension of Phase 0; this is it. It reuses the same hash seed, the
// same 5% holdout, the same env config, and the same sticky-persistence +
// once-only exposure machinery (persistFirstExposure) as the binary path — only
// the bucketing is generalised and the stored label is kept verbatim instead of
// being coerced to the binary union.
//
// INVARIANT: a given experiment key uses EITHER the binary path
// (getExperimentAssignment) OR the weighted path (getWeightedAssignment), never
// both. The binary path's `toVariant` read-back flattens any label that isn't
// 'treatment' to 'control', which would silently destroy an 'a'/'b' assignment.
// ─────────────────────────────────────────────────────────────────────────────

export interface WeightedVariant {
  /** Variant label persisted verbatim to ExperimentAssignment.variant (e.g. 'control' | 'a' | 'b'). */
  variant: string;
  /**
   * Share of the hash space, in buckets out of BUCKET_COUNT (10 000). The list
   * MUST sum to BUCKET_COUNT — assignWeightedVariant partitions [0, BUCKET_COUNT)
   * in list order, so any shortfall/overflow skews the last arm. The resolver
   * that builds the list owns that arithmetic and asserts it in its unit test.
   */
  weightBps: number;
}

export interface WeightedAssignmentResult {
  key: string;
  /** Raw stored label — NOT coerced to the binary union. */
  variant: string;
  /** True when the user is in the global holdout (always the control arm). */
  holdout: boolean;
  /** True when the experiment is enabled. */
  active: boolean;
}

/**
 * Deterministic N-way variant for one (user, experiment). The variants partition
 * the hash space [0, BUCKET_COUNT) in list order: variants[0] owns [0, w0),
 * variants[1] owns [w0, w0+w1), and so on. Same `exp::${key}::${userId}` seed as
 * assignVariant, so a key buckets identically whether it is read binary or
 * weighted (a key only ever uses one path — see the invariant above).
 *
 * Put the control variant FIRST: shrinking its leading weight (i.e. raising test
 * enrolment) then only ever moves a not-yet-assigned user OUT of control, never
 * back in — the same one-way monotonicity assignVariant gives control→treatment.
 */
export function assignWeightedVariant(
  userId: string,
  key: string,
  variants: WeightedVariant[],
): string {
  const h = hashBucket(`exp::${key}::${userId}`);
  let acc = 0;
  for (const v of variants) {
    acc += v.weightBps;
    if (h < acc) return v.variant;
  }
  // Defensive: weights should sum to BUCKET_COUNT (asserted by the resolver's
  // tests). If they fall short, the top of the range lands in the last arm.
  return variants[variants.length - 1]!.variant;
}

/**
 * Multi-variant counterpart of getExperimentAssignment. Same sticky semantics —
 * first-exposure write, `experiment.assigned` exactly once, read-through for an
 * existing row — but the stored variant is an arbitrary label, returned verbatim
 * (no toVariant coercion). A disabled experiment and a holdout user both resolve
 * to variants[0] (control by convention); a disabled experiment writes nothing
 * (kill switch, zero DB), so a dormant weighted experiment is byte-identical to
 * not having it at all.
 */
export async function getWeightedAssignment(
  userId: string,
  key: string,
  config: ExperimentConfig,
  variants: WeightedVariant[],
): Promise<WeightedAssignmentResult> {
  // Symmetric guard: a weighted resolver must only ever be used for a key that
  // is registered weighted, so the binary path is guaranteed to never touch it.
  if (!WEIGHTED_EXPERIMENT_KEYS.has(key)) {
    throw new Error(
      `experiment "${key}" is not registered in WEIGHTED_EXPERIMENT_KEYS; register it or use getExperimentAssignment`,
    );
  }
  const controlVariant = variants[0]!.variant;
  if (!config.enabled) {
    return { key, variant: controlVariant, holdout: false, active: false };
  }

  const existing = await prisma.experimentAssignment.findUnique({
    where: { userId_experimentKey: { userId, experimentKey: key } },
  });
  if (existing) {
    return { key, variant: existing.variant, holdout: existing.holdout, active: true };
  }

  // Holdout users never enter a non-control arm — they are the clean baseline.
  const holdout = isInHoldout(userId);
  const variant = holdout ? controlVariant : assignWeightedVariant(userId, key, variants);
  const persisted = await persistFirstExposure(userId, key, variant, holdout);
  return { key, variant: persisted.variant, holdout: persisted.holdout, active: true };
}
