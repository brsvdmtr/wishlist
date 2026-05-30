// Unit tests for the pure experiment machinery — bucketing, holdout, rollout,
// key validation and env-flag parsing. No DB. The sticky-persistence path
// (getExperimentAssignment) is exercised against real Postgres in
// test/integration/experiments.test.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// The pure functions never touch prisma/analytics. peekExperimentVariant reads
// experimentAssignment.findUnique (only when the experiment is enabled) and must
// NEVER write or emit an exposure event — both are asserted below via the
// hoisted spies.
const shared = vi.hoisted(() => ({
  assignmentFindUnique: vi.fn(),
  trackProductEvent: vi.fn(),
}));
vi.mock('@wishlist/db', () => ({
  prisma: { experimentAssignment: { findUnique: shared.assignmentFindUnique } },
  Prisma: {},
}));
vi.mock('./analytics', () => ({ trackProductEvent: shared.trackProductEvent }));

import {
  HOLDOUT_PERCENT,
  isInHoldout,
  assignVariant,
  resolveExperiment,
  isValidExperimentKey,
  experimentEnvName,
  readExperimentConfig,
  peekExperimentVariant,
  assignWeightedVariant,
  getWeightedAssignment,
  getExperimentAssignment,
  isWeightedExperimentKey,
} from './experiments.service';

function userIds(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `user-${i}`);
}

describe('assignVariant — deterministic sticky bucket', () => {
  it('same userId + key + rollout always yields the same variant (self-check #1)', () => {
    for (const id of userIds(50)) {
      expect(assignVariant(id, 'exp-a', 50)).toBe(assignVariant(id, 'exp-a', 50));
    }
  });

  it('rollout 0% → every user is control (self-check #2)', () => {
    for (const id of userIds(500)) {
      expect(assignVariant(id, 'exp-a', 0)).toBe('control');
    }
  });

  it('rollout 100% → every user is treatment (self-check #2)', () => {
    for (const id of userIds(500)) {
      expect(assignVariant(id, 'exp-a', 100)).toBe('treatment');
    }
  });

  it('rollout 50% → roughly half treatment (self-check #2)', () => {
    const ids = userIds(4000);
    const share = ids.filter((id) => assignVariant(id, 'exp-a', 50) === 'treatment').length / ids.length;
    expect(share).toBeGreaterThan(0.42);
    expect(share).toBeLessThan(0.58);
  });

  it('is monotonic — raising rollout never moves a user treatment → control', () => {
    for (const id of userIds(400)) {
      if (assignVariant(id, 'exp-a', 25) === 'treatment') {
        expect(assignVariant(id, 'exp-a', 75)).toBe('treatment');
      }
    }
  });

  it('clamps out-of-range rollout values', () => {
    for (const id of userIds(100)) {
      expect(assignVariant(id, 'exp-a', 150)).toBe('treatment'); // >100 → all in
      expect(assignVariant(id, 'exp-a', -10)).toBe('control'); // <0 → all out
    }
  });

  it('different keys bucket independently', () => {
    const ids = userIds(2000);
    const agree = ids.filter(
      (id) => assignVariant(id, 'key-one', 50) === assignVariant(id, 'key-two', 50),
    ).length;
    // Independent 50/50 splits agree ~50% of the time, never near 100%.
    expect(agree).toBeLessThan(ids.length * 0.7);
  });
});

describe('isInHoldout — global 5% holdout', () => {
  it('is deterministic per user', () => {
    for (const id of userIds(50)) {
      expect(isInHoldout(id)).toBe(isInHoldout(id));
    }
  });

  it('holds out roughly HOLDOUT_PERCENT of users', () => {
    const ids = userIds(8000);
    const share = (ids.filter(isInHoldout).length / ids.length) * 100;
    expect(share).toBeGreaterThan(HOLDOUT_PERCENT - 2);
    expect(share).toBeLessThan(HOLDOUT_PERCENT + 2);
  });
});

describe('resolveExperiment', () => {
  it('disabled experiment → control, regardless of rollout', () => {
    expect(resolveExperiment('user-1', 'exp-a', { enabled: false, rolloutPercent: 100 })).toEqual({
      variant: 'control',
      holdout: false,
    });
  });

  it('holdout user → control even at 100% rollout (self-check #3)', () => {
    const holdoutUser = userIds(2000).find(isInHoldout);
    expect(holdoutUser).toBeDefined();
    expect(resolveExperiment(holdoutUser!, 'exp-a', { enabled: true, rolloutPercent: 100 })).toEqual(
      { variant: 'control', holdout: true },
    );
  });

  it('non-holdout user at 100% rollout → treatment', () => {
    const normalUser = userIds(2000).find((id) => !isInHoldout(id));
    expect(normalUser).toBeDefined();
    expect(resolveExperiment(normalUser!, 'exp-a', { enabled: true, rolloutPercent: 100 })).toEqual({
      variant: 'treatment',
      holdout: false,
    });
  });

  it('no holdout user ever receives a treatment variant (self-check #3)', () => {
    for (const id of userIds(3000)) {
      if (isInHoldout(id)) {
        const r = resolveExperiment(id, 'exp-a', { enabled: true, rolloutPercent: 100 });
        expect(r.variant).toBe('control');
        expect(r.holdout).toBe(true);
      }
    }
  });
});

describe('isValidExperimentKey', () => {
  it('accepts lowercase kebab-case keys', () => {
    expect(isValidExperimentKey('new-onboarding')).toBe(true);
    expect(isValidExperimentKey('paywall-v2')).toBe(true);
    expect(isValidExperimentKey('ab')).toBe(true);
  });

  it('rejects malformed keys', () => {
    expect(isValidExperimentKey('')).toBe(false);
    expect(isValidExperimentKey('a')).toBe(false); // too short (min 2)
    expect(isValidExperimentKey('New-Onboarding')).toBe(false); // uppercase
    expect(isValidExperimentKey('1-experiment')).toBe(false); // leading digit
    expect(isValidExperimentKey('-experiment')).toBe(false); // leading hyphen
    expect(isValidExperimentKey('exp_underscore')).toBe(false); // underscore
    expect(isValidExperimentKey('exp.dot')).toBe(false);
    expect(isValidExperimentKey('exp key')).toBe(false); // whitespace
    expect(isValidExperimentKey('a'.repeat(60))).toBe(false); // too long
  });
});

describe('experimentEnvName', () => {
  it('uppercases and converts hyphens to underscores', () => {
    expect(experimentEnvName('new-onboarding')).toBe('NEW_ONBOARDING');
    expect(experimentEnvName('paywall-v2')).toBe('PAYWALL_V2');
    expect(experimentEnvName('ab')).toBe('AB');
  });
});

describe('readExperimentConfig — env flags', () => {
  it('reads EXP_<NAME>_ENABLED / EXP_<NAME>_ROLLOUT', () => {
    expect(
      readExperimentConfig('new-onboarding', {
        EXP_NEW_ONBOARDING_ENABLED: 'true',
        EXP_NEW_ONBOARDING_ROLLOUT: '50',
      }),
    ).toEqual({ enabled: true, rolloutPercent: 50 });
  });

  it('fails closed — an unconfigured experiment is disabled at 0%', () => {
    expect(readExperimentConfig('unknown-exp', {})).toEqual({ enabled: false, rolloutPercent: 0 });
  });

  it('treats only explicit truthy strings as enabled', () => {
    for (const v of ['true', '1', 'yes', 'on', 'TRUE', ' On ']) {
      expect(readExperimentConfig('demo', { EXP_DEMO_ENABLED: v }).enabled).toBe(true);
    }
    for (const v of ['false', '0', 'no', '', 'maybe']) {
      expect(readExperimentConfig('demo', { EXP_DEMO_ENABLED: v }).enabled).toBe(false);
    }
  });

  it('clamps rollout into 0..100 and treats garbage as 0', () => {
    expect(readExperimentConfig('demo', { EXP_DEMO_ROLLOUT: '150' }).rolloutPercent).toBe(100);
    expect(readExperimentConfig('demo', { EXP_DEMO_ROLLOUT: '-20' }).rolloutPercent).toBe(0);
    expect(readExperimentConfig('demo', { EXP_DEMO_ROLLOUT: 'abc' }).rolloutPercent).toBe(0);
    expect(readExperimentConfig('demo', { EXP_DEMO_ROLLOUT: '33' }).rolloutPercent).toBe(33);
  });
});

describe('peekExperimentVariant — read-only resolver (no write, no exposure)', () => {
  const ENABLED = { enabled: true, rolloutPercent: 100 };
  const DISABLED = { enabled: false, rolloutPercent: 100 };

  beforeEach(() => {
    shared.assignmentFindUnique.mockReset();
    shared.assignmentFindUnique.mockResolvedValue(null);
    shared.trackProductEvent.mockReset();
  });

  it('disabled experiment → control, ledger never queried (kill switch, zero DB)', async () => {
    expect(await peekExperimentVariant('u1', 'k', DISABLED)).toBe('control');
    expect(shared.assignmentFindUnique).not.toHaveBeenCalled();
  });

  it('enabled + persisted treatment row → treatment', async () => {
    shared.assignmentFindUnique.mockResolvedValue({ variant: 'treatment', holdout: false });
    expect(await peekExperimentVariant('u2', 'k', ENABLED)).toBe('treatment');
  });

  it('enabled + persisted control row → control', async () => {
    shared.assignmentFindUnique.mockResolvedValue({ variant: 'control', holdout: false });
    expect(await peekExperimentVariant('u3', 'k', ENABLED)).toBe('control');
  });

  it('enabled + holdout row (variant control) → control', async () => {
    shared.assignmentFindUnique.mockResolvedValue({ variant: 'control', holdout: true });
    expect(await peekExperimentVariant('u4', 'k', ENABLED)).toBe('control');
  });

  it('enabled + no row (unenrolled) → control — never pure-buckets an unexposed user', async () => {
    shared.assignmentFindUnique.mockResolvedValue(null);
    expect(await peekExperimentVariant('u5', 'k', ENABLED)).toBe('control');
  });

  it('only reads, by the (user, experiment) unique key — and never emits an exposure event', async () => {
    shared.assignmentFindUnique.mockResolvedValue({ variant: 'treatment', holdout: false });
    await peekExperimentVariant('u6', 'my-exp', ENABLED);
    expect(shared.assignmentFindUnique).toHaveBeenCalledTimes(1);
    expect(shared.assignmentFindUnique).toHaveBeenCalledWith({
      where: { userId_experimentKey: { userId: 'u6', experimentKey: 'my-exp' } },
    });
    // The whole point of peek vs getExperimentAssignment: no `experiment.assigned`.
    expect(shared.trackProductEvent).not.toHaveBeenCalled();
  });

  it('garbage stored variant defensively resolves to control', async () => {
    shared.assignmentFindUnique.mockResolvedValue({ variant: 'banana', holdout: false });
    expect(await peekExperimentVariant('u7', 'k', ENABLED)).toBe('control');
  });

  it('deterministic — same (user, key, config, ledger) yields the same variant', async () => {
    shared.assignmentFindUnique.mockResolvedValue({ variant: 'treatment', holdout: false });
    expect(await peekExperimentVariant('u8', 'k', ENABLED)).toBe(
      await peekExperimentVariant('u8', 'k', ENABLED),
    );
  });
});

describe('assignWeightedVariant — deterministic N-way bucket (E17 multi-variant)', () => {
  // Balanced 3-way over the 10 000-bucket hash space: control first (the
  // monotonicity convention), then two equal test arms. Sums to BUCKET_COUNT.
  const BALANCED = [
    { variant: 'control', weightBps: 3400 },
    { variant: 'a', weightBps: 3300 },
    { variant: 'b', weightBps: 3300 },
  ];

  it('same userId + key + weights always yields the same variant (sticky/deterministic)', () => {
    for (const id of userIds(100)) {
      expect(assignWeightedVariant(id, 'yearly-price', BALANCED)).toBe(
        assignWeightedVariant(id, 'yearly-price', BALANCED),
      );
    }
  });

  it('partitions the population into all three arms at roughly the configured weights', () => {
    const ids = userIds(9000);
    // Typed literal keys (not Record<string,number>) so noUncheckedIndexedAccess
    // doesn't widen reads to `number | undefined`.
    const counts: Record<'control' | 'a' | 'b', number> = { control: 0, a: 0, b: 0 };
    for (const id of ids) {
      const v = assignWeightedVariant(id, 'yearly-price', BALANCED) as 'control' | 'a' | 'b';
      counts[v]++;
    }
    // Every arm is populated and within a few points of its 34/33/33 target.
    expect(counts.control / ids.length).toBeGreaterThan(0.30);
    expect(counts.control / ids.length).toBeLessThan(0.38);
    expect(counts.a / ids.length).toBeGreaterThan(0.29);
    expect(counts.a / ids.length).toBeLessThan(0.37);
    expect(counts.b / ids.length).toBeGreaterThan(0.29);
    expect(counts.b / ids.length).toBeLessThan(0.37);
  });

  it('a single full-weight arm captures everyone (dormant/100%-control shape)', () => {
    for (const id of userIds(500)) {
      expect(assignWeightedVariant(id, 'yearly-price', [{ variant: 'control', weightBps: 10_000 }])).toBe('control');
    }
  });

  it('control-first weight is a prefix range — raising it never moves a user OUT of control', () => {
    // The ramp-down-of-test / ramp-up-of-control direction must be monotonic:
    // [0, wControl) only ever grows, so a control user stays control.
    const small = [
      { variant: 'control', weightBps: 2000 },
      { variant: 'a', weightBps: 4000 },
      { variant: 'b', weightBps: 4000 },
    ];
    const large = [
      { variant: 'control', weightBps: 8000 },
      { variant: 'a', weightBps: 1000 },
      { variant: 'b', weightBps: 1000 },
    ];
    for (const id of userIds(600)) {
      if (assignWeightedVariant(id, 'yearly-price', small) === 'control') {
        expect(assignWeightedVariant(id, 'yearly-price', large)).toBe('control');
      }
    }
  });

  it('different keys bucket independently', () => {
    const ids = userIds(2000);
    const agree = ids.filter(
      (id) => assignWeightedVariant(id, 'key-one', BALANCED) === assignWeightedVariant(id, 'key-two', BALANCED),
    ).length;
    // Two independent 3-way splits agree ~1/3 of the time, never near 100%.
    expect(agree).toBeLessThan(ids.length * 0.6);
  });

  it('under-sum weights: the unallocated tail falls through to the LAST arm (defensive fallback)', () => {
    // yearly-pricing guarantees the weights sum to 10000; this pins the
    // defensive `return variants[last]` branch for any caller that doesn't.
    // control owns [0,5000); a and b have 0 weight, so [5000,10000) is
    // unallocated → the loop falls through and hands it to the last arm (b).
    const w = [
      { variant: 'control', weightBps: 5000 },
      { variant: 'a', weightBps: 0 },
      { variant: 'b', weightBps: 0 },
    ];
    const ids = userIds(3000);
    const got = new Set(ids.map((id) => assignWeightedVariant(id, 'k', w)));
    expect(got.has('b')).toBe(true); // tail-catch fired for the [5000,10000) range
    expect(got.has('a')).toBe(false); // a 0-weight middle arm is never assigned
    for (const id of ids) expect(typeof assignWeightedVariant(id, 'k', w)).toBe('string'); // never undefined/throws
  });
});

describe('isWeightedExperimentKey — the path registry', () => {
  it('knows yearly-price is weighted', () => {
    expect(isWeightedExperimentKey('yearly-price')).toBe(true);
  });
  it('treats unregistered keys as binary', () => {
    expect(isWeightedExperimentKey('new-onboarding')).toBe(false);
    expect(isWeightedExperimentKey('group-gift-price')).toBe(false); // E24 is binary
  });
});

describe('EITHER/OR path enforcement (no ledger poisoning)', () => {
  const ENABLED = { enabled: true, rolloutPercent: 100 };
  const WEIGHTS = [
    { variant: 'control', weightBps: 3400 },
    { variant: 'a', weightBps: 3300 },
    { variant: 'b', weightBps: 3300 },
  ];

  it('getExperimentAssignment REFUSES a weighted key (would persist a binary row that flattens a/b → control)', async () => {
    await expect(getExperimentAssignment('u1', 'yearly-price', ENABLED)).rejects.toThrow(/weighted/i);
  });

  it('getWeightedAssignment REFUSES a key not registered weighted', async () => {
    await expect(getWeightedAssignment('u1', 'new-onboarding', ENABLED, WEIGHTS)).rejects.toThrow(/not registered/i);
  });

  it('peekExperimentVariant REFUSES a weighted key (would flatten a/b → control on read)', async () => {
    await expect(peekExperimentVariant('u1', 'yearly-price', ENABLED)).rejects.toThrow(/weighted/i);
  });
});

describe('getWeightedAssignment — sticky multi-variant (mocked Prisma; DB paths in integration)', () => {
  const ENABLED = { enabled: true, rolloutPercent: 100 };
  const DISABLED = { enabled: false, rolloutPercent: 100 };
  const WEIGHTS = [
    { variant: 'control', weightBps: 3400 },
    { variant: 'a', weightBps: 3300 },
    { variant: 'b', weightBps: 3300 },
  ];

  beforeEach(() => {
    shared.assignmentFindUnique.mockReset();
    shared.trackProductEvent.mockReset();
  });

  it('disabled → variants[0] (control), active:false, ZERO DB calls (kill switch / dormant)', async () => {
    const r = await getWeightedAssignment('u1', 'yearly-price', DISABLED, WEIGHTS);
    expect(r).toEqual({ key: 'yearly-price', variant: 'control', holdout: false, active: false });
    expect(shared.assignmentFindUnique).not.toHaveBeenCalled();
    expect(shared.trackProductEvent).not.toHaveBeenCalled();
  });

  it('enabled + persisted row → returns the RAW stored label verbatim (a/b NOT flattened to control)', async () => {
    shared.assignmentFindUnique.mockResolvedValue({ variant: 'a', holdout: false });
    const r = await getWeightedAssignment('u2', 'yearly-price', ENABLED, WEIGHTS);
    expect(r).toEqual({ key: 'yearly-price', variant: 'a', holdout: false, active: true });
    // read-through: existing row wins, no exposure event re-emitted.
    expect(shared.trackProductEvent).not.toHaveBeenCalled();
  });

  it('enabled + persisted holdout row → control (the clean baseline reads back as control)', async () => {
    shared.assignmentFindUnique.mockResolvedValue({ variant: 'control', holdout: true });
    const r = await getWeightedAssignment('u3', 'yearly-price', ENABLED, WEIGHTS);
    expect(r).toEqual({ key: 'yearly-price', variant: 'control', holdout: true, active: true });
  });
});
