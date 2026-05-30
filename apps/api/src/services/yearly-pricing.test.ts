// Unit tests for the E17 bucket-aware yearly Pro price resolver.
//
// The resolver is the single source of truth fed to the invoice, the paywall
// tile/CTA price, and /me/plan — so proving control→800 / a→600 / b→1000 here
// proves self-checks #1 and #2 for every surface at once. The sticky assignment
// + Postgres path lives in experiments.service.ts and is covered by its own
// integration suite; here we mock it so the suite stays hermetic and DB-free.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// entitlement.ts pulls credits + telegram-auth transitively; a hollow mock gives
// us just the control price without loading that graph.
vi.mock('./entitlement', () => ({ PRO_YEARLY_PRICE_XTR: 800 }));

const getWeightedAssignment = vi.fn();
vi.mock('./experiments.service', () => ({
  getWeightedAssignment: (...args: unknown[]) => getWeightedAssignment(...args),
  readExperimentConfig: vi.fn(() => ({ enabled: true, rolloutPercent: 67 })),
}));

import {
  YEARLY_PRICE_EXPERIMENT_KEY,
  YEARLY_CONTROL_PRICE_XTR,
  YEARLY_A_PRICE_XTR,
  YEARLY_B_PRICE_XTR,
  yearlyPriceForVariant,
  yearlyPriceWeights,
  resolveYearlyProPrice,
  resolveYearlyDisplay,
} from './yearly-pricing';

describe('yearly-pricing — price constants (E17)', () => {
  it('control price is the live PRO_YEARLY_PRICE_XTR (800)', () => {
    expect(YEARLY_CONTROL_PRICE_XTR).toBe(800);
  });

  it('test arm A defaults to 600 (cheaper)', () => {
    expect(YEARLY_A_PRICE_XTR).toBe(600);
  });

  it('test arm B defaults to 1000 (pricier)', () => {
    expect(YEARLY_B_PRICE_XTR).toBe(1000);
  });

  it('experiment key derives the expected env namespace', () => {
    expect(YEARLY_PRICE_EXPERIMENT_KEY).toBe('yearly-price');
  });

  it('the arms straddle control (cheaper below, pricier above)', () => {
    expect(YEARLY_A_PRICE_XTR).toBeLessThan(YEARLY_CONTROL_PRICE_XTR);
    expect(YEARLY_B_PRICE_XTR).toBeGreaterThan(YEARLY_CONTROL_PRICE_XTR);
  });
});

describe('yearlyPriceForVariant — pure variant → price', () => {
  it('control → control price', () => {
    expect(yearlyPriceForVariant('control')).toBe(YEARLY_CONTROL_PRICE_XTR);
  });

  it('a → cheaper price', () => {
    expect(yearlyPriceForVariant('a')).toBe(YEARLY_A_PRICE_XTR);
  });

  it('b → pricier price', () => {
    expect(yearlyPriceForVariant('b')).toBe(YEARLY_B_PRICE_XTR);
  });

  it('unknown / empty label defensively falls back to control (never an accidental discount)', () => {
    expect(yearlyPriceForVariant('banana')).toBe(YEARLY_CONTROL_PRICE_XTR);
    expect(yearlyPriceForVariant('')).toBe(YEARLY_CONTROL_PRICE_XTR);
  });
});

describe('yearlyPriceWeights — rollout % → 3-way split', () => {
  function sum(ws: { weightBps: number }[]): number {
    return ws.reduce((s, w) => s + w.weightBps, 0);
  }

  it('always sums to the full 10 000-bucket hash space', () => {
    for (const r of [0, 1, 10, 33, 50, 67, 99, 100]) {
      expect(sum(yearlyPriceWeights(r))).toBe(10_000);
    }
  });

  it('control is always the first arm (monotonicity convention)', () => {
    expect(yearlyPriceWeights(67)[0]!.variant).toBe('control');
  });

  it('rollout 0 → everyone control (dormant / ramp start)', () => {
    expect(yearlyPriceWeights(0)).toEqual([
      { variant: 'control', weightBps: 10_000 },
      { variant: 'a', weightBps: 0 },
      { variant: 'b', weightBps: 0 },
    ]);
  });

  it('rollout 67 → balanced 3-way (~33/33.5/33.5)', () => {
    expect(yearlyPriceWeights(67)).toEqual([
      { variant: 'control', weightBps: 3300 },
      { variant: 'a', weightBps: 3350 },
      { variant: 'b', weightBps: 3350 },
    ]);
  });

  it('rollout 100 → no in-experiment control; a/b split 50/50', () => {
    expect(yearlyPriceWeights(100)).toEqual([
      { variant: 'control', weightBps: 0 },
      { variant: 'a', weightBps: 5000 },
      { variant: 'b', weightBps: 5000 },
    ]);
  });

  it('odd rollout splits a:b without rounding drift (b takes the remainder)', () => {
    // rollout 33 → testBps 3300 → a 1650, b 1650; rollout 11 → 1100 → 550/550.
    // Use an odd testBps: rollout 1 → 100 → a 50, b 50. rollout 3 → 300 → 150/150.
    // Force an odd half: testBps must be odd → rollout giving odd*100 is always even,
    // so test the floor/remainder seam directly via a value where testBps/2 floors.
    const w = yearlyPriceWeights(33); // testBps = 3300
    expect(w[1]!.weightBps + w[2]!.weightBps).toBe(3300);
    expect(Math.abs(w[1]!.weightBps - w[2]!.weightBps)).toBeLessThanOrEqual(1);
  });

  it('clamps out-of-range rollout', () => {
    expect(sum(yearlyPriceWeights(150))).toBe(10_000);
    expect(yearlyPriceWeights(150)[0]!.weightBps).toBe(0); // >100 clamps to 100 → control 0
    expect(yearlyPriceWeights(-20)[0]!.weightBps).toBe(10_000); // <0 clamps to 0 → all control
  });
});

describe('resolveYearlyProPrice — sticky bucket → price', () => {
  beforeEach(() => getWeightedAssignment.mockReset());

  it('control bucket → invoice/paywall price 800 (self-check #1)', async () => {
    getWeightedAssignment.mockResolvedValue({
      key: YEARLY_PRICE_EXPERIMENT_KEY, variant: 'control', holdout: false, active: true,
    });
    const r = await resolveYearlyProPrice('user-control');
    expect(r.priceXtr).toBe(800);
    expect(r.variant).toBe('control');
  });

  it('arm a → invoice/paywall price 600 (self-check #2)', async () => {
    getWeightedAssignment.mockResolvedValue({
      key: YEARLY_PRICE_EXPERIMENT_KEY, variant: 'a', holdout: false, active: true,
    });
    const r = await resolveYearlyProPrice('user-a');
    expect(r.priceXtr).toBe(600);
    expect(r.variant).toBe('a');
  });

  it('arm b → invoice/paywall price 1000 (self-check #2)', async () => {
    getWeightedAssignment.mockResolvedValue({
      key: YEARLY_PRICE_EXPERIMENT_KEY, variant: 'b', holdout: false, active: true,
    });
    const r = await resolveYearlyProPrice('user-b');
    expect(r.priceXtr).toBe(1000);
    expect(r.variant).toBe('b');
  });

  it('holdout user resolves to control → never discounted/upcharged', async () => {
    getWeightedAssignment.mockResolvedValue({
      key: YEARLY_PRICE_EXPERIMENT_KEY, variant: 'control', holdout: true, active: true,
    });
    const r = await resolveYearlyProPrice('user-holdout');
    expect(r.priceXtr).toBe(800);
  });

  it('queries the assignment under the E17 key with the rollout-derived weights', async () => {
    getWeightedAssignment.mockResolvedValue({
      key: YEARLY_PRICE_EXPERIMENT_KEY, variant: 'control', holdout: false, active: true,
    });
    await resolveYearlyProPrice('user-x');
    expect(getWeightedAssignment).toHaveBeenCalledWith(
      'user-x',
      'yearly-price',
      expect.objectContaining({ enabled: true }),
      // readExperimentConfig mock returns rolloutPercent 67 → balanced split
      [
        { variant: 'control', weightBps: 3300 },
        { variant: 'a', weightBps: 3350 },
        { variant: 'b', weightBps: 3350 },
      ],
    );
  });

  it('echoes all three price arms for readout/debug', async () => {
    getWeightedAssignment.mockResolvedValue({
      key: YEARLY_PRICE_EXPERIMENT_KEY, variant: 'a', holdout: false, active: true,
    });
    const r = await resolveYearlyProPrice('user-y');
    expect(r.controlPriceXtr).toBe(800);
    expect(r.aPriceXtr).toBe(600);
    expect(r.bPriceXtr).toBe(1000);
  });

  it('propagates active=true so callers add the bucket plumbing', async () => {
    getWeightedAssignment.mockResolvedValue({
      key: YEARLY_PRICE_EXPERIMENT_KEY, variant: 'a', holdout: false, active: true,
    });
    expect((await resolveYearlyProPrice('user-active')).active).toBe(true);
  });

  it('dormant experiment → control price 800 with active=false (callers stay byte-identical)', async () => {
    // getWeightedAssignment short-circuits to control/active:false when disabled.
    getWeightedAssignment.mockResolvedValue({
      key: YEARLY_PRICE_EXPERIMENT_KEY, variant: 'control', holdout: false, active: false,
    });
    const r = await resolveYearlyProPrice('user-dormant');
    expect(r.priceXtr).toBe(800);
    expect(r.active).toBe(false);
  });
});

describe('resolveYearlyDisplay — shared gating for the bootstrap + /me/plan display surfaces', () => {
  beforeEach(() => getWeightedAssignment.mockReset());

  it('Pro user → null WITHOUT touching the resolver (existing subs never re-priced, self-check #3)', async () => {
    const r = await resolveYearlyDisplay('user-pro', true);
    expect(r).toBeNull();
    expect(getWeightedAssignment).not.toHaveBeenCalled();
  });

  it('dormant experiment → null (caller omits the field → byte-identical to today)', async () => {
    getWeightedAssignment.mockResolvedValue({
      key: YEARLY_PRICE_EXPERIMENT_KEY, variant: 'control', holdout: false, active: false,
    });
    expect(await resolveYearlyDisplay('user-dormant', false)).toBeNull();
  });

  it('active arm a → { priceXtr 600, variant a } (the value both surfaces show == checkout charges)', async () => {
    getWeightedAssignment.mockResolvedValue({
      key: YEARLY_PRICE_EXPERIMENT_KEY, variant: 'a', holdout: false, active: true,
    });
    expect(await resolveYearlyDisplay('user-a', false)).toEqual({ priceXtr: 600, variant: 'a' });
  });

  it('active arm b → { priceXtr 1000, variant b }', async () => {
    getWeightedAssignment.mockResolvedValue({
      key: YEARLY_PRICE_EXPERIMENT_KEY, variant: 'b', holdout: false, active: true,
    });
    expect(await resolveYearlyDisplay('user-b', false)).toEqual({ priceXtr: 1000, variant: 'b' });
  });

  it('active control arm → { priceXtr 800, variant control } (in-experiment control still surfaces its variant)', async () => {
    getWeightedAssignment.mockResolvedValue({
      key: YEARLY_PRICE_EXPERIMENT_KEY, variant: 'control', holdout: false, active: true,
    });
    expect(await resolveYearlyDisplay('user-c', false)).toEqual({ priceXtr: 800, variant: 'control' });
  });
});
