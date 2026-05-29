// Unit tests for the E24 bucket-aware Group Gift unlock price resolver.
//
// The resolver is the single source of truth fed to the invoice, the paywall
// screen price, and the 402 backstop — so proving control→79 / treatment→39
// here proves self-checks #1 and #2 for every surface at once. The sticky
// assignment + Postgres path lives in experiments.service.ts and is covered by
// its own suite; here we mock it so the suite stays hermetic and DB-free.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// entitlement.ts pulls hint/import-credits + telegram-auth transitively; a hollow
// mock gives us just the control price without loading that graph.
vi.mock('./entitlement', () => ({ GROUP_GIFT_PRICE_XTR: 79 }));

const getExperimentAssignment = vi.fn();
vi.mock('./experiments.service', () => ({
  getExperimentAssignment: (...args: unknown[]) => getExperimentAssignment(...args),
  readExperimentConfig: vi.fn(() => ({ enabled: true, rolloutPercent: 50 })),
}));

import {
  GROUP_GIFT_PRICE_EXPERIMENT_KEY,
  GROUP_GIFT_CONTROL_PRICE_XTR,
  GROUP_GIFT_TEST_PRICE_XTR,
  groupGiftPriceForVariant,
  resolveGroupGiftUnlockPrice,
} from './group-gift-pricing';

describe('group-gift-pricing — price constants (E24)', () => {
  it('control price is the live GROUP_GIFT_PRICE_XTR (79)', () => {
    expect(GROUP_GIFT_CONTROL_PRICE_XTR).toBe(79);
  });

  it('treatment price defaults to 39', () => {
    // No EXP/price env vars set in the test runner → the documented default.
    expect(GROUP_GIFT_TEST_PRICE_XTR).toBe(39);
  });

  it('experiment key derives the expected env namespace', () => {
    expect(GROUP_GIFT_PRICE_EXPERIMENT_KEY).toBe('group-gift-price');
  });
});

describe('groupGiftPriceForVariant — pure variant → price', () => {
  it('control → control price', () => {
    expect(groupGiftPriceForVariant('control')).toBe(GROUP_GIFT_CONTROL_PRICE_XTR);
  });

  it('treatment → test price', () => {
    expect(groupGiftPriceForVariant('treatment')).toBe(GROUP_GIFT_TEST_PRICE_XTR);
  });

  it('test price is strictly below control (the elasticity direction)', () => {
    expect(GROUP_GIFT_TEST_PRICE_XTR).toBeLessThan(GROUP_GIFT_CONTROL_PRICE_XTR);
  });
});

describe('resolveGroupGiftUnlockPrice — sticky bucket → price', () => {
  beforeEach(() => getExperimentAssignment.mockReset());

  it('control bucket → invoice/paywall price 79 (self-check #1)', async () => {
    getExperimentAssignment.mockResolvedValue({
      key: GROUP_GIFT_PRICE_EXPERIMENT_KEY, variant: 'control', holdout: false, active: true,
    });
    const r = await resolveGroupGiftUnlockPrice('user-control');
    expect(r.priceXtr).toBe(79);
    expect(r.variant).toBe('control');
  });

  it('treatment bucket → invoice/paywall price 39 (self-check #2)', async () => {
    getExperimentAssignment.mockResolvedValue({
      key: GROUP_GIFT_PRICE_EXPERIMENT_KEY, variant: 'treatment', holdout: false, active: true,
    });
    const r = await resolveGroupGiftUnlockPrice('user-treatment');
    expect(r.priceXtr).toBe(39);
    expect(r.variant).toBe('treatment');
  });

  it('holdout user resolves to control → never discounted', async () => {
    // The holdout cohort is always control (experiments.service guarantees this);
    // the resolver must therefore charge the full control price.
    getExperimentAssignment.mockResolvedValue({
      key: GROUP_GIFT_PRICE_EXPERIMENT_KEY, variant: 'control', holdout: true, active: true,
    });
    const r = await resolveGroupGiftUnlockPrice('user-holdout');
    expect(r.priceXtr).toBe(79);
  });

  it('queries the assignment under the E24 experiment key', async () => {
    getExperimentAssignment.mockResolvedValue({
      key: GROUP_GIFT_PRICE_EXPERIMENT_KEY, variant: 'control', holdout: false, active: true,
    });
    await resolveGroupGiftUnlockPrice('user-x');
    expect(getExperimentAssignment).toHaveBeenCalledWith(
      'user-x',
      'group-gift-price',
      expect.objectContaining({ enabled: true }),
    );
  });

  it('echoes both price arms for readout/debug', async () => {
    getExperimentAssignment.mockResolvedValue({
      key: GROUP_GIFT_PRICE_EXPERIMENT_KEY, variant: 'treatment', holdout: false, active: true,
    });
    const r = await resolveGroupGiftUnlockPrice('user-y');
    expect(r.controlPriceXtr).toBe(79);
    expect(r.testPriceXtr).toBe(39);
  });
});
