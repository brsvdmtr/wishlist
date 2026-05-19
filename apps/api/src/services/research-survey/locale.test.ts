// Locale gate unit tests — covers LC-1..LC-5 from design v1.2 §5.7.
//
// Pure: no Prisma, no network. Drives `resolveSurveyLocale` directly.

import { describe, it, expect } from 'vitest';
import { resolveSurveyLocale } from './locale';

const baseProfile = {
  languageMode: 'auto',
  manualLanguage: null as string | null,
  normalizedLocale: null as string | null,
  language: null as string | null,
  marketBucket: null as string | null,
};

describe('resolveSurveyLocale', () => {
  it('LC-1: manualLanguage=ru wins over telegramLanguageCode=en', () => {
    const out = resolveSurveyLocale({
      profile: { ...baseProfile, languageMode: 'manual', manualLanguage: 'ru' },
      telegramLanguageCode: 'en',
    });
    expect(out).toBe('ru');
  });

  it('LC-2: language_code=uk + marketBucket=other_known → ru (ru-like override)', () => {
    const out = resolveSurveyLocale({
      profile: { ...baseProfile, language: 'uk' },
      telegramLanguageCode: 'uk',
      marketBucket: 'other_known',
    });
    expect(out).toBe('ru');
  });

  it('LC-3: language_code=de + marketBucket=other_known → en (fallback)', () => {
    const out = resolveSurveyLocale({
      profile: { ...baseProfile, language: 'de' },
      telegramLanguageCode: 'de',
      marketBucket: 'other_known',
    });
    expect(out).toBe('en');
  });

  it('LC-4: manualLanguage=ar → null (skip Wave 1)', () => {
    const out = resolveSurveyLocale({
      profile: { ...baseProfile, languageMode: 'manual', manualLanguage: 'ar' },
    });
    expect(out).toBeNull();
  });

  it('zh-CN normalized resolves to null (Wave 1 skip)', () => {
    const out = resolveSurveyLocale({
      profile: { ...baseProfile, normalizedLocale: 'zh-CN' },
      telegramLanguageCode: 'zh-CN',
    });
    expect(out).toBeNull();
  });

  it('all ru-like BCP-47 prefixes resolve to ru via telegramLanguageCode', () => {
    for (const code of ['ru', 'uk', 'be', 'kk', 'ky', 'uz', 'tg', 'ka', 'hy']) {
      const out = resolveSurveyLocale({
        profile: baseProfile,
        telegramLanguageCode: code,
      });
      expect(out, `expected ${code} → ru`).toBe('ru');
    }
  });

  it('marketBucket=ru alone (no language signals) maps to ru', () => {
    const out = resolveSurveyLocale({
      profile: baseProfile,
      marketBucket: 'ru',
    });
    expect(out).toBe('ru');
  });

  it('manualLanguage=en overrides ru-like language code (respects explicit choice)', () => {
    const out = resolveSurveyLocale({
      profile: { ...baseProfile, languageMode: 'manual', manualLanguage: 'en', language: 'uk' },
      telegramLanguageCode: 'uk',
    });
    expect(out).toBe('en');
  });

  it('no signals at all → en (default-en)', () => {
    const out = resolveSurveyLocale({ profile: baseProfile });
    expect(out).toBe('en');
  });

  it('returns null when profile is null', () => {
    // Cold-start user with no UserProfile row. Default-en fires through the
    // resolver, but we still need to make sure it doesn't crash.
    const out = resolveSurveyLocale({ profile: null });
    expect(out).toBe('en');
  });
});
