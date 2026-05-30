// Integration test against a real Postgres — proves the E17 "shown == charged"
// invariant end to end for the 3-way yearly-price experiment. The bucket price
// returned by resolveYearlyProPrice is what the bootstrap display, /me/plan, and
// the /pro/checkout invoice all quote; this pins that it is STICKY (survives a
// rollout change), that the raw 'a'/'b' label round-trips through the
// ExperimentAssignment ledger WITHOUT being flattened to control (the multi-
// variant correctness the binary path can't give), and that the kill switch
// reverts everyone to the control 800. The unit test
// (src/services/yearly-pricing.test.ts) mocks getWeightedAssignment, so it
// cannot prove the real persisted read — this hits the actual engine and the
// ExperimentAssignment unique index.
//
// Auto-skips when DATABASE_URL is not set so local `pnpm test` stays fast. CI
// provides DATABASE_URL via the postgres service container in test.yml.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';

// experiment.assigned is emitted fire-and-forget on first exposure; mock the
// analytics module so no AnalyticsEvent rows leak into other integration files.
const analytics = vi.hoisted(() => ({ trackProductEvent: vi.fn() }));
vi.mock('../../src/services/analytics', () => ({
  trackProductEvent: analytics.trackProductEvent,
}));

import { getTestPrisma, disconnectTestPrisma } from '../setup-pg';
import {
  resolveYearlyProPrice,
  YEARLY_PRICE_EXPERIMENT_KEY,
} from '../../src/services/yearly-pricing';
import { isInHoldout } from '../../src/services/experiments.service';

const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;
const PREFIX = 'int-yrprice';

if (SKIP) {
  // eslint-disable-next-line no-console
  console.warn('[integration] DATABASE_URL not set — skipping yearly-pricing integration tests');
}

// ENABLED / ROLLOUT are read per-call via readExperimentConfig(process.env), so
// we can flip them between calls. (control 800 = PRO_YEARLY_PRICE_XTR default;
// a 600 / b 1000 are module-load consts in the test runner.) Save & restore.
const ENV_KEYS = ['EXP_YEARLY_PRICE_ENABLED', 'EXP_YEARLY_PRICE_ROLLOUT'] as const;
const savedEnv: Record<string, string | undefined> = {};

function setExperiment(enabled: boolean, rolloutPercent = 0): void {
  if (enabled) {
    process.env.EXP_YEARLY_PRICE_ENABLED = 'true';
    process.env.EXP_YEARLY_PRICE_ROLLOUT = String(rolloutPercent);
  } else {
    delete process.env.EXP_YEARLY_PRICE_ENABLED;
    delete process.env.EXP_YEARLY_PRICE_ROLLOUT;
  }
}

suite('resolveYearlyProPrice — real Postgres (E17 shown==charged, 3-way)', () => {
  const userIds: string[] = [];
  let nonHoldoutUserId = '';
  const distUserIds: string[] = []; // dedicated pool for the both-arms-appear check

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const db = getTestPrisma();
    await db.experimentAssignment.deleteMany({ where: { user: { telegramId: { startsWith: PREFIX } } } });
    await db.user.deleteMany({ where: { telegramId: { startsWith: PREFIX } } });
    // Fixed indices 0/1/2 = disabled / control / sticky cases. Indices 3..11 are
    // the test-arm + kill-switch user. Indices 12..43 are a disjoint pool only
    // the distribution test enrolls, so no sticky row from another test skews it.
    for (let i = 1; i <= 44; i++) {
      const u = await db.user.create({ data: { telegramId: `${PREFIX}-${i}` } });
      userIds.push(u.id);
    }
    // Test-arm user: disjoint from {0,1,2} and non-holdout (holdout forces
    // control even at 100% rollout). P(all of [3..11] holdout) = 0.05^9 ≈ 0.
    for (let i = 3; i < 12; i++) {
      if (!isInHoldout(userIds[i]!)) { nonHoldoutUserId = userIds[i]!; break; }
    }
    expect(nonHoldoutUserId).not.toBe('');
    for (let i = 12; i < userIds.length; i++) distUserIds.push(userIds[i]!);
  });

  afterAll(async () => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    const db = getTestPrisma();
    await db.experimentAssignment.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await disconnectTestPrisma();
  });

  afterEach(() => setExperiment(false));

  it('disabled experiment → control price 800 and writes NO assignment row', async () => {
    setExperiment(false);
    const u = userIds[0]!;
    const r = await resolveYearlyProPrice(u);
    expect(r.priceXtr).toBe(800);
    expect(r.variant).toBe('control');
    expect(r.active).toBe(false);
    const row = await getTestPrisma().experimentAssignment.findUnique({
      where: { userId_experimentKey: { userId: u, experimentKey: YEARLY_PRICE_EXPERIMENT_KEY } },
    });
    expect(row).toBeNull();
  });

  it('control bucket (rollout 0) → invoice/paywall price 800 (self-check #1)', async () => {
    setExperiment(true, 0);
    const r = await resolveYearlyProPrice(userIds[1]!);
    expect(r.priceXtr).toBe(800);
    expect(r.variant).toBe('control');
    expect(r.active).toBe(true);
  });

  it('test arm (rollout 100, non-holdout) → a/600 or b/1000, with the RAW label persisted (self-check #2)', async () => {
    setExperiment(true, 100);
    const r = await resolveYearlyProPrice(nonHoldoutUserId);
    // Deterministic per user, but a-vs-b depends on the hash — assert the
    // arm/price are a consistent test pair (never control).
    expect(['a', 'b']).toContain(r.variant);
    expect(r.priceXtr).toBe(r.variant === 'a' ? 600 : 1000);

    // The multi-variant correctness the binary path can't give: the ledger row
    // stores the raw 'a'/'b' label and reading it back does NOT flatten it to
    // control (which getExperimentAssignment's toVariant would have done).
    const row = await getTestPrisma().experimentAssignment.findUnique({
      where: { userId_experimentKey: { userId: nonHoldoutUserId, experimentKey: YEARLY_PRICE_EXPERIMENT_KEY } },
    });
    expect(row?.variant).toBe(r.variant);
    expect(['a', 'b']).toContain(row?.variant);
  });

  it('price is STICKY across a rollout change → shown == charged', async () => {
    // Assigned at 0% (control / 800); flip to 100% — the persisted row wins, so
    // the price first shown is the price the user keeps being charged.
    const u = userIds[2]!;
    setExperiment(true, 0);
    expect((await resolveYearlyProPrice(u)).priceXtr).toBe(800);
    setExperiment(true, 100);
    const second = await resolveYearlyProPrice(u);
    expect(second.priceXtr).toBe(800); // NOT a test price — sticky
    expect(second.variant).toBe('control');
  });

  it('kill switch (disable after a test-arm assignment) → back to control 800', async () => {
    const u = nonHoldoutUserId;
    setExperiment(true, 100);
    expect(['a', 'b']).toContain((await resolveYearlyProPrice(u)).variant);
    setExperiment(false);
    const r = await resolveYearlyProPrice(u);
    expect(r.priceXtr).toBe(800); // disabled overrides the persisted test-arm row
    expect(r.variant).toBe('control');
    expect(r.active).toBe(false);
  });

  it('rollout 100 actually splits into BOTH test arms (3-way, not collapsed)', async () => {
    setExperiment(true, 100);
    const variants = new Set<string>();
    const prices = new Set<number>();
    for (const u of distUserIds) {
      const r = await resolveYearlyProPrice(u);
      variants.add(r.variant);
      prices.add(r.priceXtr);
      // Every charged price agrees with its arm (the shown==charged map holds
      // for every user in the pool, not just the spot-checked ones).
      expect(r.priceXtr).toBe(r.variant === 'a' ? 600 : r.variant === 'b' ? 1000 : 800);
    }
    // ~32 users, ~30 non-holdout split 50/50 → both arms essentially certain.
    expect(variants.has('a')).toBe(true);
    expect(variants.has('b')).toBe(true);
    // No arm ever resolves to a price outside the configured set.
    for (const p of prices) expect([600, 800, 1000]).toContain(p);
  });
});
