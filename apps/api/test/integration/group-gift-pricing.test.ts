// Integration test against a real Postgres — proves the E24 "shown == charged"
// invariant end to end. The bucket price returned by resolveGroupGiftUnlockPrice
// is what the bootstrap, the paywall 402, and the invoice all quote; this test
// pins that it is STICKY (survives a rollout change), consistent, and that the
// kill switch + holdout never discount. The unit test
// (src/services/group-gift-pricing.test.ts) mocks getExperimentAssignment, so
// it cannot prove the real persisted read — this hits the actual engine and the
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
  resolveGroupGiftUnlockPrice,
  GROUP_GIFT_PRICE_EXPERIMENT_KEY,
} from '../../src/services/group-gift-pricing';
import { isInHoldout } from '../../src/services/experiments.service';

const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;
const PREFIX = 'int-ggprice';

if (SKIP) {
  // eslint-disable-next-line no-console
  console.warn('[integration] DATABASE_URL not set — skipping group-gift-pricing integration tests');
}

// ENABLED / ROLLOUT are read per-call via readExperimentConfig(process.env), so
// we can flip them between calls. (TEST/CONTROL prices are module-load consts —
// 39 / 79 by default in the test runner.) Save & restore around the suite.
const ENV_KEYS = ['EXP_GROUP_GIFT_PRICE_ENABLED', 'EXP_GROUP_GIFT_PRICE_ROLLOUT'] as const;
const savedEnv: Record<string, string | undefined> = {};

function setExperiment(enabled: boolean, rolloutPercent = 0): void {
  if (enabled) {
    process.env.EXP_GROUP_GIFT_PRICE_ENABLED = 'true';
    process.env.EXP_GROUP_GIFT_PRICE_ROLLOUT = String(rolloutPercent);
  } else {
    delete process.env.EXP_GROUP_GIFT_PRICE_ENABLED;
    delete process.env.EXP_GROUP_GIFT_PRICE_ROLLOUT;
  }
}

suite('resolveGroupGiftUnlockPrice — real Postgres (E24 shown==charged)', () => {
  const userIds: string[] = [];
  let nonHoldoutUserId = '';

  beforeAll(async () => {
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    const db = getTestPrisma();
    await db.experimentAssignment.deleteMany({ where: { user: { telegramId: { startsWith: PREFIX } } } });
    await db.user.deleteMany({ where: { telegramId: { startsWith: PREFIX } } });
    // A handful of fresh users. The disabled/control/sticky cases use the
    // fixed indices 0/1/2.
    for (let i = 1; i <= 12; i++) {
      const u = await db.user.create({ data: { telegramId: `${PREFIX}-${i}` } });
      userIds.push(u.id);
    }
    // Pick the treatment + kill-switch user from index >= 3 so it is DISJOINT
    // from indices {0,1,2}. If it shared a user with the control case (writes a
    // sticky CONTROL row) or the sticky case, that persisted row would flip the
    // treatment assertion and flake CI ~5% of runs. Holdout users force control
    // even at 100% rollout, so it must also be non-holdout; P(all of [3..11]
    // holdout) = 0.05^9 ≈ 0, so one is always found.
    for (let i = 3; i < userIds.length; i++) {
      if (!isInHoldout(userIds[i]!)) { nonHoldoutUserId = userIds[i]!; break; }
    }
    expect(nonHoldoutUserId).not.toBe('');
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

  it('disabled experiment → control price 79 and writes NO assignment row', async () => {
    setExperiment(false);
    const u = userIds[0]!;
    const r = await resolveGroupGiftUnlockPrice(u);
    expect(r.priceXtr).toBe(79);
    expect(r.variant).toBe('control');
    const row = await getTestPrisma().experimentAssignment.findUnique({
      where: { userId_experimentKey: { userId: u, experimentKey: GROUP_GIFT_PRICE_EXPERIMENT_KEY } },
    });
    expect(row).toBeNull();
  });

  it('control bucket (rollout 0) → invoice price 79 (self-check #1)', async () => {
    setExperiment(true, 0);
    const r = await resolveGroupGiftUnlockPrice(userIds[1]!);
    expect(r.priceXtr).toBe(79);
    expect(r.variant).toBe('control');
  });

  it('treatment bucket (rollout 100, non-holdout) → invoice price 39 (self-check #2)', async () => {
    setExperiment(true, 100);
    const r = await resolveGroupGiftUnlockPrice(nonHoldoutUserId);
    expect(r.priceXtr).toBe(39);
    expect(r.variant).toBe('treatment');
  });

  it('price is STICKY across a rollout change → shown == charged', async () => {
    // Assigned at 0% (control / 79); flip to 100% — the persisted row wins, so
    // the price first shown is the price the user keeps being charged.
    const u = userIds[2]!;
    setExperiment(true, 0);
    expect((await resolveGroupGiftUnlockPrice(u)).priceXtr).toBe(79);
    setExperiment(true, 100);
    const second = await resolveGroupGiftUnlockPrice(u);
    expect(second.priceXtr).toBe(79); // NOT 39 — sticky
    expect(second.variant).toBe('control');
  });

  it('kill switch (disable after a treatment assignment) → back to control 79', async () => {
    // Self-sufficient: at rollout 100 a non-holdout user buckets treatment on
    // first exposure regardless of order (sticky if a prior case already
    // enrolled it). Either way it is treatment/39 before we flip the switch.
    const u = nonHoldoutUserId;
    setExperiment(true, 100);
    expect((await resolveGroupGiftUnlockPrice(u)).priceXtr).toBe(39);
    setExperiment(false);
    const r = await resolveGroupGiftUnlockPrice(u);
    expect(r.priceXtr).toBe(79); // disabled overrides the persisted treatment row
    expect(r.variant).toBe('control');
  });
});
