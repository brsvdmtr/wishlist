import {
  type LocaleProfileSlice,
  profileToLanguageSettings,
  resolveLocaleWithSource,
} from '@wishlist/shared';

// Wave 1 survey eligibility locale. Only 'ru' / 'en' content is hand-translated;
// other locales (zh-CN, hi, es, ar) have i18n keys reserved but are excluded
// from Wave 1 sends — see design v1.2 §5.
export type SurveyLocale = 'ru' | 'en';

// BCP-47 prefixes that should route to the Russian survey copy, even though
// they normalize to 'en' in the global locale resolver. Covers post-Soviet
// languages where Russian is the most likely fully-fluent second language.
const RU_LIKE_PREFIXES = new Set(['uk', 'be', 'kk', 'ky', 'uz', 'tg', 'ka', 'hy']);

function isRuLikeBcp47(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  const prefix = raw.toLowerCase().split('-')[0] ?? '';
  return RU_LIKE_PREFIXES.has(prefix);
}

export interface SurveyLocaleInput {
  profile: LocaleProfileSlice;
  telegramLanguageCode?: string | null;
  marketBucket?: string | null;
}

// Returns the survey locale, or null when the user should be skipped in Wave 1.
//
// Logic:
//   1. If the user manually picked a locale (languageMode='manual'), respect it:
//      - manual ∈ {ru,en} → that locale
//      - manual ∈ {zh-CN,hi,es,ar} → null (skip; we don't have copy yet)
//   2. Otherwise, run the standard resolver. If it returns 'ru', use 'ru'.
//   3. Apply ru-like BCP-47 override: uk/be/kk/ky/uz/tg/ka/hy from the live
//      Telegram code, the legacy `language`, or marketBucket='ru' → 'ru'.
//   4. Resolver-returned 'en' → 'en'.
//   5. Resolver-returned {zh-CN,hi,es,ar} → null.
export function resolveSurveyLocale(input: SurveyLocaleInput): SurveyLocale | null {
  const { profile, telegramLanguageCode, marketBucket } = input;
  const settings = profileToLanguageSettings(profile);
  const { locale: resolved, source } = resolveLocaleWithSource(
    settings,
    telegramLanguageCode ?? undefined,
  );

  if (source === 'manual') {
    return resolved === 'ru' || resolved === 'en' ? resolved : null;
  }

  if (resolved === 'ru') return 'ru';

  const ruLikeSignal =
    isRuLikeBcp47(telegramLanguageCode) ||
    isRuLikeBcp47(profile?.language) ||
    marketBucket === 'ru';

  if (ruLikeSignal) return 'ru';

  return resolved === 'en' ? 'en' : null;
}
