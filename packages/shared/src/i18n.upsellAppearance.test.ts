// Feature guard for the `appearance` Pro-upsell copy.
//
// The paywall context `appearance` (OLED-black theme + accent-color PRO gate,
// MiniApp.tsx getUpsellContent) shipped with hardcoded Russian title /
// subtitle / benefits — every other upsell context resolved copy via `t()`,
// so non-RU users saw Russian on the appearance paywall. Fixed 2026-05-22
// (docs/BUGFIX_LESSONS.md) by routing all five strings through i18n keys.
//
// `i18n.parity.test.ts` is the systemic guard — it already proves every key
// exists in all 6 locales and is not an English stub. This file is the
// feature-specific counterpart: it pins the five `upsell_appearance_*` keys
// by name, checks every locale resolves its OWN copy (no raw-key
// fallthrough, no silent single-language fallback), and pins the RU source
// strings so a future copy edit is deliberate and reviewed.

import { describe, it, expect } from 'vitest';
import { t, type Locale } from './i18n';

const LOCALES: Locale[] = ['ru', 'en', 'zh-CN', 'hi', 'es', 'ar'];

const APPEARANCE_KEYS = [
  'upsell_appearance_title',
  'upsell_appearance_subtitle',
  'upsell_appearance_b1',
  'upsell_appearance_b2',
  'upsell_appearance_b3',
] as const;

describe('appearance Pro-upsell — localized title/body', () => {
  it('resolves real copy in all 6 locales (no raw-key fallthrough)', () => {
    for (const locale of LOCALES) {
      for (const key of APPEARANCE_KEYS) {
        const value = t(key, locale);
        expect(value, `${key} unresolved for ${locale}`).not.toBe(key);
        expect(value.trim().length, `${key} empty for ${locale}`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps the RU source copy the audit flagged as hardcoded', () => {
    expect(t('upsell_appearance_title', 'ru')).toBe('Персонализация внешнего вида');
    expect(t('upsell_appearance_subtitle', 'ru')).toBe(
      'PRO открывает OLED-чёрную тему и акцентные цвета: синий, розовый, зелёный.',
    );
    expect(t('upsell_appearance_b1', 'ru')).toBe('OLED-чёрная тема (экономит батарею)');
    expect(t('upsell_appearance_b2', 'ru')).toBe('Акценты: синий, розовый, зелёный');
    expect(t('upsell_appearance_b3', 'ru')).toBe('Мгновенное переключение без перезагрузки');
  });

  it('en differs from ru and carries no Cyrillic bleed', () => {
    const cyrillic = /[А-Яа-яЁёЀ-ӿ]/;
    for (const key of APPEARANCE_KEYS) {
      expect(t(key, 'en'), `${key}: en equals ru`).not.toBe(t(key, 'ru'));
      expect(cyrillic.test(t(key, 'en')), `${key}: en copy contains Cyrillic`).toBe(false);
    }
  });

  it('every locale resolves its own copy — no silent EN/RU fallback', () => {
    // A locale missing the key would surface as the EN value via t()'s
    // `dict[key] ?? en[key] ?? ru[key]` chain. Distinct copy per locale
    // proves each `upsell_appearance_*` key landed natively in all 6 dicts.
    for (const key of APPEARANCE_KEYS) {
      const values = LOCALES.map((l) => t(key, l));
      expect(new Set(values).size, `${key}: locales share copy (silent fallback)`).toBe(LOCALES.length);
    }
  });

  it('the t() fallback chain degrades a missing key to the key itself, never a throw', () => {
    // Contract: requested locale -> en -> ru -> key. A genuinely unknown
    // appearance key must echo the key (visible-but-safe), not crash.
    const missing = 'upsell_appearance_NONEXISTENT';
    for (const locale of LOCALES) {
      expect(t(missing, locale)).toBe(missing);
    }
  });
});
