import { describe, expect, it } from 'vitest';
import {
  GUEST_BUDGET_PRESETS,
  HINT_QUOTA_FALLBACK,
  PRO_PRICE_MONTHLY_STARS,
  PRO_PRICE_YEARLY_STARS,
  PRO_PRICE_LIFETIME_STARS,
  CARD_REDESIGN_ENABLED,
  ITEM_DETAIL_REDESIGN_ALL,
  PROFILE_REDESIGN_IDS,
  DONT_GIFT_PRESETS,
  DONT_GIFT_PRESET_EMOJIS,
  SERVICE_START_PARAMS,
} from './miniapp-constants';

describe('miniapp-constants', () => {
  it('GUEST_BUDGET_PRESETS is the canonical 4-bucket ladder', () => {
    expect(GUEST_BUDGET_PRESETS).toEqual([3000, 5000, 10000, 25000]);
  });

  it('HINT_QUOTA_FALLBACK matches the server default', () => {
    expect(HINT_QUOTA_FALLBACK).toBe(3);
  });

  it('PRO pricing constants match the API env defaults', () => {
    expect(PRO_PRICE_MONTHLY_STARS).toBe(100);
    expect(PRO_PRICE_YEARLY_STARS).toBe(800);
    expect(PRO_PRICE_LIFETIME_STARS).toBe(2490);
  });

  it('redesign flags are rolled out (true)', () => {
    expect(CARD_REDESIGN_ENABLED).toBe(true);
    expect(ITEM_DETAIL_REDESIGN_ALL).toBe(true);
  });

  it('PROFILE_REDESIGN_IDS contains the canary entry', () => {
    expect(PROFILE_REDESIGN_IDS.has('8747175307')).toBe(true);
    expect(PROFILE_REDESIGN_IDS.has('not-in-canary')).toBe(false);
  });

  it('DONT_GIFT_PRESETS covers 14 categories', () => {
    expect(DONT_GIFT_PRESETS).toHaveLength(14);
  });

  it('every DONT_GIFT_PRESETS key has a matching emoji', () => {
    for (const key of DONT_GIFT_PRESETS) {
      expect(DONT_GIFT_PRESET_EMOJIS[key]).toBeTypeOf('string');
      expect(DONT_GIFT_PRESET_EMOJIS[key]!.length).toBeGreaterThan(0);
    }
  });

  it('SERVICE_START_PARAMS contains all internal command payloads', () => {
    expect(SERVICE_START_PARAMS.has('create_wishlist')).toBe(true);
    expect(SERVICE_START_PARAMS.has('open_profile')).toBe(true);
    expect(SERVICE_START_PARAMS.has('upgrade_pro')).toBe(true);
    // a slug/share-token MUST NOT be classified as a service param
    expect(SERVICE_START_PARAMS.has('my_birthday_party')).toBe(false);
  });
});
