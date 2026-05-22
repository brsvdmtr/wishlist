// Unit tests for the pure experiment machinery — bucketing, holdout, rollout,
// key validation and env-flag parsing. No DB. The sticky-persistence path
// (getExperimentAssignment) is exercised against real Postgres in
// test/integration/experiments.test.ts.

import { describe, it, expect, vi } from 'vitest';

// The module imports prisma + analytics at load; the pure functions never
// touch them, so a hollow mock keeps this suite hermetic and DB-free.
vi.mock('@wishlist/db', () => ({ prisma: {}, Prisma: {} }));
vi.mock('./analytics', () => ({ trackProductEvent: vi.fn() }));

import {
  HOLDOUT_PERCENT,
  isInHoldout,
  assignVariant,
  resolveExperiment,
  isValidExperimentKey,
  experimentEnvName,
  readExperimentConfig,
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
