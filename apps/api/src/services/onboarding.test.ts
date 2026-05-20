// Unit tests for services/onboarding.ts.
//
// Coverage focus: pure helpers (full), demo-template catalogue invariants,
// eligibility resolver branch matrix, completeOnboarding idempotency +
// analytics event shape.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  itemCount: vi.fn(),
  itemUpdateMany: vi.fn(),
  stateFindUnique: vi.fn(),
  stateUpdate: vi.fn(),
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    item: { count: shared.itemCount, updateMany: shared.itemUpdateMany },
    userOnboardingState: { findUnique: shared.stateFindUnique, update: shared.stateUpdate },
  },
}));

import {
  ONBOARDING_KEY,
  ONBOARDING_VERSION,
  RU_VARIANTS,
  GLOBAL_VARIANTS,
  DEMO_ITEMS,
  GLOBAL_DEMO_ITEMS,
  resolveMarketSegment,
  variantKeyToSegment,
  assignOnboardingVariant,
  getDemoTemplate,
  isDemoItemUntouched,
  isMeaningfulEdit,
  countRealItemsForActivation,
  hasDraftsUserContent,
  checkOnboardingEligibility,
  createCompleteOnboarding,
} from './onboarding';

beforeEach(() => {
  for (const v of Object.values(shared)) (v as ReturnType<typeof vi.fn>).mockReset?.();
});

describe('Constants', () => {
  it('ONBOARDING_KEY = "hello_activation"', () => {
    expect(ONBOARDING_KEY).toBe('hello_activation');
  });

  it('ONBOARDING_VERSION = 1', () => {
    expect(ONBOARDING_VERSION).toBe(1);
  });

  it('RU_VARIANTS has 4 entries', () => {
    expect(RU_VARIANTS).toEqual(['wildberries', 'goldapple', 'ozon', 'yandex_market']);
  });

  it('GLOBAL_VARIANTS has 4 entries', () => {
    expect(GLOBAL_VARIANTS).toEqual(['amazon', 'zalando', 'sephora', 'apple']);
  });

  it('RU and GLOBAL variants do not overlap', () => {
    const overlap = RU_VARIANTS.filter((v) => GLOBAL_VARIANTS.includes(v));
    expect(overlap).toHaveLength(0);
  });
});

describe('Demo templates', () => {
  it('DEMO_ITEMS covers all RU variants exactly', () => {
    expect(Object.keys(DEMO_ITEMS).sort()).toEqual([...RU_VARIANTS].sort());
  });

  it('GLOBAL_DEMO_ITEMS covers all GLOBAL variants', () => {
    expect(Object.keys(GLOBAL_DEMO_ITEMS).sort()).toEqual([...GLOBAL_VARIANTS].sort());
  });

  it('every RU demo has currency=RUB, USD-free', () => {
    for (const v of RU_VARIANTS) {
      expect(DEMO_ITEMS[v as keyof typeof DEMO_ITEMS].currency).toBe('RUB');
    }
  });

  it('every GLOBAL demo has currency=USD', () => {
    for (const v of GLOBAL_VARIANTS) {
      expect(GLOBAL_DEMO_ITEMS[v]!.currency).toBe('USD');
    }
  });

  it('every demo has all required fields and a non-empty description', () => {
    const allDemos = [...Object.values(DEMO_ITEMS), ...Object.values(GLOBAL_DEMO_ITEMS)];
    for (const d of allDemos) {
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.url).toMatch(/^https?:\/\//);
      expect(d.price).toBeGreaterThan(0);
      expect(d.priority).toBe('MEDIUM');
      expect(d.imageUrl).toMatch(/^\/onboarding\//);
      expect(d.description.length).toBeGreaterThan(20);
    }
  });
});

describe('resolveMarketSegment / variantKeyToSegment', () => {
  it('resolveMarketSegment: ru → ru, anything else → global', () => {
    expect(resolveMarketSegment('ru')).toBe('ru');
    expect(resolveMarketSegment('en')).toBe('global');
    expect(resolveMarketSegment('hi')).toBe('global');
    expect(resolveMarketSegment('ar')).toBe('global');
    expect(resolveMarketSegment('zh-CN')).toBe('global');
  });

  it('variantKeyToSegment correctly maps RU variants', () => {
    for (const v of RU_VARIANTS) expect(variantKeyToSegment(v)).toBe('ru');
  });

  it('variantKeyToSegment correctly maps GLOBAL variants', () => {
    for (const v of GLOBAL_VARIANTS) expect(variantKeyToSegment(v)).toBe('global');
  });

  it('variantKeyToSegment defaults unknown variants to ru', () => {
    // Defensive: unknown key falls into the GLOBAL_VARIANTS.includes check,
    // which returns false → returns 'ru'.
    expect(variantKeyToSegment('mystery_variant')).toBe('ru');
  });
});

describe('assignOnboardingVariant', () => {
  it('always returns v2_try (the A/B winner)', () => {
    expect(assignOnboardingVariant('any_id')).toEqual({ variant: 'v2_try', source: 'rollout_config' });
    expect(assignOnboardingVariant()).toEqual({ variant: 'v2_try', source: 'rollout_config' });
  });
});

describe('getDemoTemplate', () => {
  it('returns RU template by variant key', () => {
    expect(getDemoTemplate('wildberries')).toBe(DEMO_ITEMS.wildberries);
  });

  it('returns GLOBAL template by variant key', () => {
    expect(getDemoTemplate('amazon')).toBe(GLOBAL_DEMO_ITEMS.amazon);
  });

  it('returns undefined for unknown variant', () => {
    expect(getDemoTemplate('not_real')).toBeUndefined();
  });
});

describe('isDemoItemUntouched', () => {
  const template = DEMO_ITEMS.wildberries;
  const unsavedDemo = {
    title: template.title,
    url: template.url,
    priceText: String(template.price),
    becameRealAt: null,
  };

  it('returns true for an unmodified demo', () => {
    expect(isDemoItemUntouched(unsavedDemo, template)).toBe(true);
  });

  it('returns false when becameRealAt is set (user already "converted" the demo)', () => {
    expect(isDemoItemUntouched({ ...unsavedDemo, becameRealAt: new Date() }, template)).toBe(false);
  });

  it('returns false when title was edited', () => {
    expect(isDemoItemUntouched({ ...unsavedDemo, title: 'My new title' }, template)).toBe(false);
  });

  it('returns false when url was edited', () => {
    expect(isDemoItemUntouched({ ...unsavedDemo, url: 'https://other.com' }, template)).toBe(false);
  });

  it('returns false when price was edited', () => {
    expect(isDemoItemUntouched({ ...unsavedDemo, priceText: '999' }, template)).toBe(false);
  });

  it('handles null priceText vs numeric template price', () => {
    expect(isDemoItemUntouched({ ...unsavedDemo, priceText: null }, template)).toBe(false);
  });
});

describe('isMeaningfulEdit', () => {
  const template = DEMO_ITEMS.wildberries;

  it('returns false when no fields supplied in the update', () => {
    expect(isMeaningfulEdit({}, template)).toBe(false);
  });

  it('returns false when title matches template exactly', () => {
    expect(isMeaningfulEdit({ title: template.title }, template)).toBe(false);
  });

  it('returns true when title differs', () => {
    expect(isMeaningfulEdit({ title: 'Custom' }, template)).toBe(true);
  });

  it('returns true when url differs', () => {
    expect(isMeaningfulEdit({ url: 'https://other.com' }, template)).toBe(true);
  });

  it('returns true when price differs', () => {
    expect(isMeaningfulEdit({ price: 9999 }, template)).toBe(true);
  });

  it('returns true when description differs', () => {
    expect(isMeaningfulEdit({ description: 'My note' }, template)).toBe(true);
  });
});

describe('countRealItemsForActivation', () => {
  it('counts isDemo=false items with non-terminal status', async () => {
    shared.itemCount.mockResolvedValueOnce(5);
    const result = await countRealItemsForActivation('u1');
    expect(result).toBe(5);
    const where = shared.itemCount.mock.calls[0]![0].where;
    expect(where.isDemo).toBe(false);
    expect(where.originType).toEqual({ not: 'DEMO' });
    expect(where.status).toEqual({ notIn: ['DELETED', 'PURCHASED', 'COMPLETED'] });
  });
});

describe('hasDraftsUserContent', () => {
  it('returns true when SYSTEM_DRAFTS contains real items', async () => {
    shared.itemCount.mockResolvedValueOnce(1);
    expect(await hasDraftsUserContent('u1')).toBe(true);
  });

  it('returns false when SYSTEM_DRAFTS has no real items', async () => {
    shared.itemCount.mockResolvedValueOnce(0);
    expect(await hasDraftsUserContent('u1')).toBe(false);
  });
});

describe('checkOnboardingEligibility', () => {
  beforeEach(() => {
    shared.itemCount.mockResolvedValue(0); // both drafts + real items default to 0
    shared.stateFindUnique.mockResolvedValue(null);
  });

  it('eligible=true when no prior state and no real items', async () => {
    const r = await checkOnboardingEligibility('u1', 'actor-x');
    expect(r).toMatchObject({ eligible: true, reason: 'no_onboarding_state', forcedRollout: false });
  });

  it('eligible=false reason=already_completed', async () => {
    shared.stateFindUnique.mockResolvedValueOnce({ status: 'COMPLETED' });
    const r = await checkOnboardingEligibility('u1', 'actor-x');
    expect(r).toMatchObject({ eligible: false, reason: 'already_completed' });
  });

  it('eligible=false reason=already_dismissed', async () => {
    shared.stateFindUnique.mockResolvedValueOnce({ status: 'DISMISSED' });
    const r = await checkOnboardingEligibility('u1', 'actor-x');
    expect(r).toMatchObject({ eligible: false, reason: 'already_dismissed' });
  });

  it('eligible=false reason=has_real_items', async () => {
    shared.itemCount.mockReset();
    let n = 0;
    shared.itemCount.mockImplementation(() => {
      n += 1;
      if (n === 1) return Promise.resolve(0); // drafts user content check
      return Promise.resolve(3); // real items count > 0
    });

    const r = await checkOnboardingEligibility('u1', 'actor-x');
    expect(r.eligible).toBe(false);
    expect(r.reason).toBe('has_real_items');
  });

  it('eligible=false when state COMPLETED — does NOT query real-items (short-circuit)', async () => {
    shared.stateFindUnique.mockResolvedValueOnce({ status: 'COMPLETED' });

    const beforeCalls = shared.itemCount.mock.calls.length;
    await checkOnboardingEligibility('u1', 'actor-x');
    const afterCalls = shared.itemCount.mock.calls.length;

    // Only the hasDraftsUserContent count fires before the state check returns.
    expect(afterCalls - beforeCalls).toBe(1);
  });
});

describe('createCompleteOnboarding', () => {
  let trackEvent: ReturnType<typeof vi.fn>;
  let completeOnboarding: ReturnType<typeof createCompleteOnboarding>;

  beforeEach(() => {
    trackEvent = vi.fn();
    completeOnboarding = createCompleteOnboarding({ trackEvent });
  });

  it('is a no-op when state does not exist', async () => {
    shared.stateFindUnique.mockResolvedValueOnce(null);
    await completeOnboarding('u1', 'real_item_created');
    expect(shared.stateUpdate).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('is a no-op when state is already COMPLETED (idempotent)', async () => {
    shared.stateFindUnique.mockResolvedValueOnce({ status: 'COMPLETED' });
    await completeOnboarding('u1', 'real_item_created');
    expect(shared.stateUpdate).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('is a no-op when state is DISMISSED', async () => {
    shared.stateFindUnique.mockResolvedValueOnce({ status: 'DISMISSED' });
    await completeOnboarding('u1', 'manual_created');
    expect(shared.stateUpdate).not.toHaveBeenCalled();
  });

  it('updates state to COMPLETED + fires analytics with the correct reason', async () => {
    shared.stateFindUnique.mockResolvedValueOnce({
      id: 's1', status: 'IN_PROGRESS', metaJson: {}, variantKey: 'wildberries', entryPoint: 'bot',
      demoItemId: null,
    });

    await completeOnboarding('u1', 'real_item_created');

    expect(shared.stateUpdate).toHaveBeenCalledOnce();
    expect(shared.stateUpdate.mock.calls[0]![0].data).toMatchObject({
      status: 'COMPLETED',
      completionReason: 'real_item_created',
    });
    expect(trackEvent).toHaveBeenCalledWith(
      'onboarding_completed',
      'u1',
      expect.objectContaining({
        completion_reason: 'real_item_created',
        variant_key: 'wildberries',
      }),
    );
  });

  it('sets becameRealAt on the demo item when reason=demo_converted', async () => {
    shared.stateFindUnique.mockResolvedValueOnce({
      id: 's1', status: 'IN_PROGRESS', metaJson: {}, variantKey: 'wildberries', entryPoint: 'bot',
      demoItemId: 'demo-i1',
    });

    await completeOnboarding('u1', 'demo_converted');

    expect(shared.itemUpdateMany).toHaveBeenCalledOnce();
    expect(shared.itemUpdateMany.mock.calls[0]![0].where).toMatchObject({
      id: 'demo-i1',
      isDemo: true,
    });
    expect(shared.itemUpdateMany.mock.calls[0]![0].data.becameRealAt).toBeInstanceOf(Date);
  });

  it('does NOT touch the demo item when reason ≠ demo_converted (e.g. real_item_created)', async () => {
    shared.stateFindUnique.mockResolvedValueOnce({
      id: 's1', status: 'IN_PROGRESS', metaJson: {}, variantKey: 'amazon', entryPoint: 'miniapp',
      demoItemId: 'demo-i1',
    });

    await completeOnboarding('u1', 'real_item_created');

    expect(shared.itemUpdateMany).not.toHaveBeenCalled();
  });

  it('tags market_segment based on the stored variantKey, not the user locale', async () => {
    shared.stateFindUnique.mockResolvedValueOnce({
      id: 's1', status: 'IN_PROGRESS', metaJson: {}, variantKey: 'amazon', entryPoint: 'bot',
      demoItemId: null,
    });

    await completeOnboarding('u1', 'manual_created');

    expect(trackEvent.mock.calls[0]![2].market_segment).toBe('global');
  });

  it('tags experiment_phase + onboarding_flow for legacy v1_demo users', async () => {
    shared.stateFindUnique.mockResolvedValueOnce({
      id: 's1', status: 'IN_PROGRESS',
      metaJson: { onboardingVariant: 'v1_demo' },
      variantKey: 'wildberries', entryPoint: 'bot', demoItemId: null,
    });

    await completeOnboarding('u1', 'demo_converted');

    expect(trackEvent.mock.calls[0]![2]).toMatchObject({
      experiment_phase: 'legacy_recovery',
      onboarding_flow: 'v1_demo_recovery',
    });
  });

  it('tags post_rollout + main_v2 for default (v2_try) users', async () => {
    shared.stateFindUnique.mockResolvedValueOnce({
      id: 's1', status: 'IN_PROGRESS',
      metaJson: { onboardingVariant: 'v2_try' },
      variantKey: 'wildberries', entryPoint: 'bot', demoItemId: null,
    });

    await completeOnboarding('u1', 'real_item_created');

    expect(trackEvent.mock.calls[0]![2]).toMatchObject({
      experiment_phase: 'post_rollout',
      onboarding_flow: 'main_v2',
    });
  });
});
