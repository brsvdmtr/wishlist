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
