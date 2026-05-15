// Unit tests for the locale resolver chain. Every proactive cron / bot push
// in the codebase routes through `resolveLocaleWithSource`, so the priority
// order is the single most safety-critical contract in i18n. The chain is:
//   1. manual override     (settings.languageMode='manual' && settings.manualLanguage)
//   2. live telegram       (telegramLanguageCode arg)
//   3. persisted normalized (settings.normalizedLocale, validated against Locale union)
//   4. legacy raw language (settings.legacyLanguage, normalised via normalizeLocale)
//   5. default 'en'
//
// History: a 2026-05-10 production bug had Russian users receiving English
// lifecycle DMs because the cron path called `resolveEffectiveLocale(profile)`
// without `telegramLanguageCode`, falling through to `normalizeLocale(undefined)`
// which returns 'en'. The fix was to extend the resolver with the persisted
// fallback (steps 3–4) and have every proactive caller pass those fields.

import { describe, it, expect } from 'vitest';
import { resolveEffectiveLocale, resolveLocaleWithSource, t, type Locale } from './i18n';

describe('resolveLocaleWithSource', () => {
  describe('manual override', () => {
    it('honours manual ru even when live telegram is en and persisted is en', () => {
      const r = resolveLocaleWithSource(
        { languageMode: 'manual', manualLanguage: 'ru', normalizedLocale: 'en', legacyLanguage: 'en-US' },
        'en-US',
      );
      expect(r).toEqual({ locale: 'ru', source: 'manual' });
    });

    it('honours manual en even when live telegram is ru and persisted is ru', () => {
      const r = resolveLocaleWithSource(
        { languageMode: 'manual', manualLanguage: 'en', normalizedLocale: 'ru', legacyLanguage: 'ru-RU' },
        'ru-RU',
      );
      expect(r).toEqual({ locale: 'en', source: 'manual' });
    });

    it('falls through to live telegram when manualLanguage is null even in manual mode', () => {
      // Defensive: a malformed profile (manual mode but no pick) should NOT
      // pin behaviour — we fall through to the next signal. This matches the
      // historical resolver behaviour pre-fix.
      const r = resolveLocaleWithSource(
        { languageMode: 'manual', manualLanguage: null, normalizedLocale: 'ru' },
        'en-US',
      );
      expect(r).toEqual({ locale: 'en', source: 'live_telegram' });
    });

    it('falls through when manualLanguage is dirty (unsupported value)', () => {
      // Defensive: if a dirty migration / admin tool writes 'pt-BR' to
      // manualLanguage, blindly returning it would crash `t()` because
      // dicts['pt-BR'] is undefined. The resolver must reject unsupported
      // values and fall through to the next signal — same shape as the
      // persisted_normalized guard.
      const r = resolveLocaleWithSource(
        // @ts-expect-error — exercising runtime defensive path with bogus type
        { languageMode: 'manual', manualLanguage: 'pt-BR', normalizedLocale: 'ru', legacyLanguage: 'ru-RU' },
      );
      expect(r).toEqual({ locale: 'ru', source: 'persisted_normalized' });
    });

    it('falls through when manualLanguage is empty string', () => {
      // Defensive: a malformed profile (manual mode but empty string pick) has
      // the same semantics as null — must fall through to next signal, not pin
      // on '' which would fail isSupportedLocale and crash `t('', locale)`.
      const r = resolveLocaleWithSource(
        // @ts-expect-error — exercising runtime defensive path with empty string
        { languageMode: 'manual', manualLanguage: '', normalizedLocale: 'ru', legacyLanguage: 'ru-RU' },
      );
      expect(r).toEqual({ locale: 'ru', source: 'persisted_normalized' });
    });
  });

  describe('live telegram', () => {
    it('uses live ru-RU in auto mode, ignoring persisted en', () => {
      const r = resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'en', legacyLanguage: 'en-US' },
        'ru-RU',
      );
      expect(r).toEqual({ locale: 'ru', source: 'live_telegram' });
    });

    it('uses live en when no settings', () => {
      const r = resolveLocaleWithSource(null, 'en-US');
      expect(r).toEqual({ locale: 'en', source: 'live_telegram' });
    });
  });

  describe('persisted normalizedLocale', () => {
    it('uses persisted ru when no live telegram (cron / proactive context)', () => {
      const r = resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'ru' },
        undefined,
      );
      expect(r).toEqual({ locale: 'ru', source: 'persisted_normalized' });
    });

    it('uses persisted ar when no live telegram', () => {
      const r = resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'ar' },
      );
      expect(r).toEqual({ locale: 'ar', source: 'persisted_normalized' });
    });

    it('rejects an unsupported persisted value and falls through to legacy', () => {
      // Defensive: if `normalizedLocale` was written by older / buggy code as
      // something outside the Locale union (e.g. raw 'pt-BR'), the resolver
      // must not return it unchecked — falls through to legacy normalisation.
      const r = resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'pt-BR', legacyLanguage: 'ru-RU' },
      );
      expect(r).toEqual({ locale: 'ru', source: 'legacy_language' });
    });
  });

  describe('legacy raw language', () => {
    it('normalises legacy ru-RU to ru', () => {
      const r = resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null, legacyLanguage: 'ru-RU' },
      );
      expect(r).toEqual({ locale: 'ru', source: 'legacy_language' });
    });

    it('normalises legacy zh-Hans to zh-CN', () => {
      const r = resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null, legacyLanguage: 'zh-Hans' },
      );
      expect(r).toEqual({ locale: 'zh-CN', source: 'legacy_language' });
    });

    it('falls back to en for unknown legacy code', () => {
      // normalizeLocale lenient-defaults to 'en' for unknown languages —
      // mirror that in the resolver chain so downstream sees a Locale value
      // even on garbage input.
      const r = resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null, legacyLanguage: 'zz-XX' },
      );
      expect(r).toEqual({ locale: 'en', source: 'legacy_language' });
    });
  });

  describe('default fallback', () => {
    it('returns en + default_en when nothing is known', () => {
      const r = resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null },
      );
      expect(r).toEqual({ locale: 'en', source: 'default_en' });
    });

    it('returns en + default_en when settings is null and no telegram code', () => {
      const r = resolveLocaleWithSource(null);
      expect(r).toEqual({ locale: 'en', source: 'default_en' });
    });
  });

  describe('priority chain ordering', () => {
    it('manual > live > normalized > legacy > default', () => {
      // All four signals supplied — manual wins.
      expect(resolveLocaleWithSource(
        { languageMode: 'manual', manualLanguage: 'ar', normalizedLocale: 'ru', legacyLanguage: 'en' },
        'es',
      ).source).toBe('manual');

      // Manual disabled → live wins.
      expect(resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'ru', legacyLanguage: 'en' },
        'es',
      ).source).toBe('live_telegram');

      // No live → normalized wins.
      expect(resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'ru', legacyLanguage: 'en' },
      ).source).toBe('persisted_normalized');

      // No normalized → legacy wins.
      expect(resolveLocaleWithSource(
        { languageMode: 'auto', manualLanguage: null, legacyLanguage: 'en-US' },
      ).source).toBe('legacy_language');
    });
  });
});

describe('resolver → t() integration coverage', () => {
  // Meta-test: every i18n key added in the locale-fix wave (lifecycle button,
  // subscriber notification button, reservation reminder block, group-gift
  // fanouts, comment-batch plurals) MUST resolve to a non-empty string in
  // every supported locale. Catches the next time someone adds a new locale
  // to the union but forgets to add a key block — or drops a key during a
  // refactor — *before* prod sends a literal i18n-key string to a user.
  const SUPPORTED_LOCALES: Locale[] = ['ru', 'en', 'zh-CN', 'hi', 'es', 'ar'];

  // Keys added in the 2026-05-10 systemic fix + 2026-05-11 follow-ups.
  // Update when adding new keys to the dict in this category.
  const LOCALE_FIX_KEYS = [
    'lifecycle_dm_open_app_btn',
    'sub_notification_open_item_btn',
    'notif_res_reminder_header',
    'notif_res_reminder_body',
    'notif_res_reminder_body_with_price',
    'notif_res_reminder_from',
    'notif_res_reminder_note',
    'notif_res_reminder_btn_open',
    'notif_res_reminder_btn_purchased',
    'notif_group_gift_joined',
    'notif_group_gift_completed',
    'notif_group_gift_cancelled',
    'notif_batch_comments_word_one',
    'notif_batch_comments_word_few',
    'notif_batch_comments_word_many',
  ];

  for (const locale of SUPPORTED_LOCALES) {
    for (const key of LOCALE_FIX_KEYS) {
      it(`${locale} → t('${key}') resolves to a non-empty string`, () => {
        const result = t(key, locale);
        expect(result).toBeTruthy();
        expect(result).not.toBe(key);
        // Body keys take params; calling without them yields raw `{{title}}`
        // tokens — still a non-empty string, so this only catches missing
        // entries, not malformed templates. Assertion shape kept tight on
        // purpose so the test fails loudly on the one regression class
        // (key missing from dict) without false-positives on template style.
      });
    }
  }

  it('every resolver-output locale resolves the lifecycle button key (end-to-end)', () => {
    // Belt-and-braces: feed each LocaleSource branch's output into t() and
    // confirm the path that ships the most user-visible string never throws
    // and never echoes the raw key. Defends the seam most likely to break.
    const cases = [
      resolveLocaleWithSource({ languageMode: 'manual', manualLanguage: 'ar' }).locale,
      resolveLocaleWithSource(null, 'ru-RU').locale,
      resolveLocaleWithSource({ languageMode: 'auto', manualLanguage: null, normalizedLocale: 'es' }).locale,
      resolveLocaleWithSource({ languageMode: 'auto', manualLanguage: null, legacyLanguage: 'hi-IN' }).locale,
      resolveLocaleWithSource(null).locale,
    ];
    for (const loc of cases) {
      const button = t('lifecycle_dm_open_app_btn', loc);
      expect(button).toBeTruthy();
      expect(button).not.toBe('lifecycle_dm_open_app_btn');
    }
  });
});

describe('resolveEffectiveLocale (locale-only convenience)', () => {
  it('returns just the locale, dropping the source', () => {
    expect(resolveEffectiveLocale(
      { languageMode: 'manual', manualLanguage: 'ru' },
    )).toBe('ru');
    expect(resolveEffectiveLocale(null, 'en-US')).toBe('en');
    expect(resolveEffectiveLocale(null)).toBe('en');
  });

  it('preserves byte-identical behaviour for the pre-fix call shape', () => {
    // Pre-fix code paths called the resolver with only languageMode +
    // manualLanguage and a live telegramLanguageCode (or undefined). Those
    // call sites must keep returning the same thing — extension is purely
    // additive. Regression guard against accidental priority reordering.
    expect(resolveEffectiveLocale(
      { languageMode: 'manual', manualLanguage: 'ru' },
      'en-US',
    )).toBe('ru');
    expect(resolveEffectiveLocale(
      { languageMode: 'auto', manualLanguage: null },
      'ru-RU',
    )).toBe('ru');
    expect(resolveEffectiveLocale(
      { languageMode: 'auto', manualLanguage: null },
      undefined,
    )).toBe('en');
  });
});
