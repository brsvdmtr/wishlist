// Unit tests for services/limits-experiment.ts — the growth-first-limits A/B
// config (Variant B). PREPARED, OFF BY DEFAULT.
//
// Covers three of the four self-checks for experiment-aware limits:
//   #1 variants A/B return different limits
//   #2 users outside the experiment (disabled / control / holdout / unenrolled)
//      are unaffected — the resolver fails closed to production
//   #3 resolution is deterministic and side-effect-free
// (#4, readout SQL, lives in docs/research/growth-first-ab-plan.md. The
//  resolver's *use* by the entitlement layer is covered in entitlement.test.ts.)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  assignmentFindUnique: vi.fn(),
}));

// Only experimentAssignment.findUnique is reached (via peekExperimentVariant);
// everything else in the graph is load-only.
vi.mock('@wishlist/db', () => ({
  prisma: { experimentAssignment: { findUnique: shared.assignmentFindUnique } },
  Prisma: {},
}));
vi.mock('./analytics', () => ({
  trackProductEvent: vi.fn(),
  trackEvent: vi.fn(),
  trackAnalyticsEvent: vi.fn(),
}));

import { PLANS } from './entitlement';
import {
  GROWTH_FIRST_LIMITS_KEY,
  GROWTH_FIRST_FREE_PLAN,
  GROWTH_FIRST_DECLARED_QUOTAS,
  growthFirstFreePlanForVariant,
  resolveGrowthFirstVariant,
} from './limits-experiment';

beforeEach(() => {
  shared.assignmentFindUnique.mockReset();
  shared.assignmentFindUnique.mockResolvedValue(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GROWTH_FIRST_FREE_PLAN — Variant B (self-check #1: A/B differ)', () => {
  it('is strictly more generous than production PLANS.FREE on the changed levers', () => {
    // Baseline guard: if production FREE changes, this snapshot fails loudly so
    // the experiment delta is re-reviewed rather than silently drifting.
    expect(PLANS.FREE).toMatchObject({
      wishlists: 2, items: 20, subscriptions: 2, categoriesPerWishlist: 1,
    });

    expect(GROWTH_FIRST_FREE_PLAN.wishlists).toBe(3);
    expect(GROWTH_FIRST_FREE_PLAN.items).toBe(30);
    expect(GROWTH_FIRST_FREE_PLAN.subscriptions).toBe(5);
    expect(GROWTH_FIRST_FREE_PLAN.categoriesPerWishlist).toBe(3);

    // Growth-first only ever loosens FREE, never tightens it.
    expect(GROWTH_FIRST_FREE_PLAN.wishlists).toBeGreaterThan(PLANS.FREE.wishlists);
    expect(GROWTH_FIRST_FREE_PLAN.items).toBeGreaterThan(PLANS.FREE.items);
    expect(GROWTH_FIRST_FREE_PLAN.subscriptions).toBeGreaterThan(PLANS.FREE.subscriptions);
    expect(GROWTH_FIRST_FREE_PLAN.categoriesPerWishlist).toBeGreaterThan(PLANS.FREE.categoriesPerWishlist);
  });

  it('leaves participants and features unchanged (participants already 10; features stay PRO-side)', () => {
    expect(GROWTH_FIRST_FREE_PLAN.participants).toBe(PLANS.FREE.participants);
    expect(GROWTH_FIRST_FREE_PLAN.participants).toBe(10);
    expect(GROWTH_FIRST_FREE_PLAN.features).toEqual([]);
    expect(GROWTH_FIRST_FREE_PLAN.code).toBe('FREE');
  });

  it('differs from the production FREE plan as a whole', () => {
    expect(GROWTH_FIRST_FREE_PLAN).not.toEqual({ ...PLANS.FREE, features: [...PLANS.FREE.features] });
  });
});

describe('GROWTH_FIRST_DECLARED_QUOTAS — declared-but-deferred levers', () => {
  it('declares the Variant B import/hint/curated numbers (enforcement wired at launch)', () => {
    // These are the single source of truth for the plan doc + launch checklist.
    // They are deliberately NOT yet consumed by the resolver (Phase-1), so a
    // change here is documentation, not a production behaviour change.
    expect(GROWTH_FIRST_DECLARED_QUOTAS).toEqual({
      freeImportQuotaPerMonth: 10,
      freeHintQuotaPerMonth: 5,
      freeCuratedSelectionsPerMonth: 1,
    });
  });
});

describe('growthFirstFreePlanForVariant — pure mapping (self-checks #1, #3)', () => {
  it('treatment → growth-first FREE plan', () => {
    // Intentional `toBe` (identity): the resolver returns the shared module-level
    // singleton, and nothing downstream mutates `ent.plan`. Keep it identity, not
    // `toEqual` — it documents the no-copy/no-mutation contract.
    expect(growthFirstFreePlanForVariant('treatment')).toBe(GROWTH_FIRST_FREE_PLAN);
  });

  it('control → null (signals "use the production plan")', () => {
    expect(growthFirstFreePlanForVariant('control')).toBeNull();
  });

  it('is deterministic and side-effect-free', () => {
    expect(growthFirstFreePlanForVariant('treatment')).toBe(growthFirstFreePlanForVariant('treatment'));
    expect(growthFirstFreePlanForVariant('control')).toBe(growthFirstFreePlanForVariant('control'));
  });
});

describe('resolveGrowthFirstVariant — read-only, fail-closed resolution', () => {
  // The resolver reads process.env at call time. peek ignores rollout (it reads
  // the persisted row), so ROLLOUT is cosmetic here — ENABLED is the kill switch.
  const enable = (rollout = 100) => {
    vi.stubEnv('EXP_GROWTH_FIRST_LIMITS_ENABLED', 'true');
    vi.stubEnv('EXP_GROWTH_FIRST_LIMITS_ROLLOUT', String(rollout));
  };

  it('disabled (no env) → control, and never touches the ledger (self-check #2)', async () => {
    expect(await resolveGrowthFirstVariant('u1')).toBe('control');
    expect(shared.assignmentFindUnique).not.toHaveBeenCalled();
  });

  it('enabled + persisted treatment row → treatment (self-check #1)', async () => {
    enable();
    shared.assignmentFindUnique.mockResolvedValue({ variant: 'treatment', holdout: false });
    expect(await resolveGrowthFirstVariant('u2')).toBe('treatment');
  });

  it('enabled + no row (unenrolled) → control (self-check #2)', async () => {
    enable();
    shared.assignmentFindUnique.mockResolvedValue(null);
    expect(await resolveGrowthFirstVariant('u3')).toBe('control');
  });

  it('enabled + holdout row (variant control) → control (self-check #2)', async () => {
    enable();
    shared.assignmentFindUnique.mockResolvedValue({ variant: 'control', holdout: true });
    expect(await resolveGrowthFirstVariant('u4')).toBe('control');
  });

  it('queries the ledger by the (user, experiment) unique key', async () => {
    enable();
    shared.assignmentFindUnique.mockResolvedValue({ variant: 'treatment', holdout: false });
    await resolveGrowthFirstVariant('u5');
    expect(shared.assignmentFindUnique).toHaveBeenCalledWith({
      where: { userId_experimentKey: { userId: 'u5', experimentKey: GROWTH_FIRST_LIMITS_KEY } },
    });
  });

  it('deterministic — same env + ledger state yields the same variant (self-check #3)', async () => {
    enable();
    shared.assignmentFindUnique.mockResolvedValue({ variant: 'treatment', holdout: false });
    const a = await resolveGrowthFirstVariant('u6');
    const b = await resolveGrowthFirstVariant('u6');
    expect(a).toBe(b);
    expect(a).toBe('treatment');
  });
});
