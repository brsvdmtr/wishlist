// Unit tests for the multi-signal market bucket resolver and its helpers.
// Resolver priority chain: language_code → browser_language → timezone →
// country_code → first_name. The resolver is the single drift-prone surface
// in this corner of the codebase — every sub-helper is pure and the chain
// has explicit ordering — so tests focus on the priority/fallback semantics
// and on the silent-error cases (empty inputs, unknown values, regional
// edge cases like Latin-script Russian names).

import { describe, it, expect } from 'vitest';
import {
  deriveMarketBucket,
  deriveMarketBucketFromTimezone,
  deriveMarketBucketFromCountry,
  deriveMarketBucketFromName,
  resolveMarketBucket,
} from './i18n';

describe('deriveMarketBucket (single-signal language code)', () => {
  it('handles all six target locales', () => {
    expect(deriveMarketBucket('ru')).toBe('ru');
    expect(deriveMarketBucket('ar')).toBe('ar');
    expect(deriveMarketBucket('en')).toBe('en');
    expect(deriveMarketBucket('hi')).toBe('hi');
    expect(deriveMarketBucket('zh')).toBe('zh-CN');
    expect(deriveMarketBucket('es')).toBe('es');
  });

  it('strips locale region suffix', () => {
    expect(deriveMarketBucket('en-US')).toBe('en');
    expect(deriveMarketBucket('zh-Hans-CN')).toBe('zh-CN');
    expect(deriveMarketBucket('ar-SA')).toBe('ar');
    expect(deriveMarketBucket('ru-RU')).toBe('ru');
  });

  it('maps known non-target prefixes to other_known', () => {
    expect(deriveMarketBucket('de')).toBe('other_known');
    expect(deriveMarketBucket('fr-FR')).toBe('other_known');
    expect(deriveMarketBucket('ja')).toBe('other_known');
    expect(deriveMarketBucket('uk')).toBe('other_known');
  });

  it('returns unknown for null/empty input', () => {
    expect(deriveMarketBucket(null)).toBe('unknown');
    expect(deriveMarketBucket(undefined)).toBe('unknown');
    expect(deriveMarketBucket('')).toBe('unknown');
  });

  it('returns other_known (lenient) for unrecognised but well-formed prefix', () => {
    // The lenient single-signal helper should NOT halt the dashboard: it
    // rounds noise to other_known so the user is at least counted. The
    // strict variant inside the resolver does the opposite (returns
    // unknown so the fallback chain keeps going).
    expect(deriveMarketBucket('xx-YY')).toBe('other_known');
    expect(deriveMarketBucket('zz')).toBe('other_known');
  });
});

describe('deriveMarketBucketFromTimezone', () => {
  it('maps Russian timezones', () => {
    expect(deriveMarketBucketFromTimezone('Europe/Moscow')).toBe('ru');
    expect(deriveMarketBucketFromTimezone('Asia/Vladivostok')).toBe('ru');
    expect(deriveMarketBucketFromTimezone('Asia/Kamchatka')).toBe('ru');
  });

  it('maps Russian-speaking ex-USSR (BY, KZ, KG) to ru', () => {
    expect(deriveMarketBucketFromTimezone('Europe/Minsk')).toBe('ru');
    expect(deriveMarketBucketFromTimezone('Asia/Almaty')).toBe('ru');
    expect(deriveMarketBucketFromTimezone('Asia/Bishkek')).toBe('ru');
  });

  it('maps Arabic MENA timezones', () => {
    expect(deriveMarketBucketFromTimezone('Asia/Riyadh')).toBe('ar');
    expect(deriveMarketBucketFromTimezone('Asia/Dubai')).toBe('ar');
    expect(deriveMarketBucketFromTimezone('Africa/Cairo')).toBe('ar');
  });

  it('maps Indian timezone aliases', () => {
    expect(deriveMarketBucketFromTimezone('Asia/Kolkata')).toBe('hi');
    expect(deriveMarketBucketFromTimezone('Asia/Calcutta')).toBe('hi');
  });

  it('maps Greater China + Spanish + English', () => {
    expect(deriveMarketBucketFromTimezone('Asia/Shanghai')).toBe('zh-CN');
    expect(deriveMarketBucketFromTimezone('Asia/Taipei')).toBe('zh-CN');
    expect(deriveMarketBucketFromTimezone('Europe/Madrid')).toBe('es');
    expect(deriveMarketBucketFromTimezone('America/Mexico_City')).toBe('es');
    expect(deriveMarketBucketFromTimezone('America/New_York')).toBe('en');
    expect(deriveMarketBucketFromTimezone('Europe/London')).toBe('en');
    expect(deriveMarketBucketFromTimezone('Australia/Sydney')).toBe('en');
  });

  it('maps recognised non-target zones to other_known', () => {
    expect(deriveMarketBucketFromTimezone('Europe/Berlin')).toBe('other_known');
    expect(deriveMarketBucketFromTimezone('Asia/Tokyo')).toBe('other_known');
    expect(deriveMarketBucketFromTimezone('Europe/Kyiv')).toBe('other_known');
  });

  it('returns unknown for null / unrecognised TZ', () => {
    expect(deriveMarketBucketFromTimezone(null)).toBe('unknown');
    expect(deriveMarketBucketFromTimezone('')).toBe('unknown');
    expect(deriveMarketBucketFromTimezone('Mars/Olympus')).toBe('unknown');
  });

  it('rejects whitespace contamination (no trailing-space matches)', () => {
    // Regression guard: an earlier version of the TZ map had 'Europe/Athens '
    // (with a trailing space) as a duplicate dead key.
    expect(deriveMarketBucketFromTimezone('Europe/Athens ')).toBe('unknown');
    expect(deriveMarketBucketFromTimezone(' Europe/Moscow')).toBe('unknown');
  });
});

describe('deriveMarketBucketFromCountry', () => {
  it('case-insensitive ISO 3166-1 alpha-2 lookup', () => {
    expect(deriveMarketBucketFromCountry('RU')).toBe('ru');
    expect(deriveMarketBucketFromCountry('ru')).toBe('ru');
    expect(deriveMarketBucketFromCountry('Sa')).toBe('ar');
  });

  it('maps target markets', () => {
    expect(deriveMarketBucketFromCountry('US')).toBe('en');
    expect(deriveMarketBucketFromCountry('IN')).toBe('hi');
    expect(deriveMarketBucketFromCountry('CN')).toBe('zh-CN');
    expect(deriveMarketBucketFromCountry('ES')).toBe('es');
    expect(deriveMarketBucketFromCountry('AE')).toBe('ar');
  });

  it('maps recognised non-target to other_known', () => {
    expect(deriveMarketBucketFromCountry('DE')).toBe('other_known');
    expect(deriveMarketBucketFromCountry('JP')).toBe('other_known');
    expect(deriveMarketBucketFromCountry('UA')).toBe('other_known');
  });

  it('returns unknown for null / unrecognised country code', () => {
    expect(deriveMarketBucketFromCountry(null)).toBe('unknown');
    expect(deriveMarketBucketFromCountry('')).toBe('unknown');
    expect(deriveMarketBucketFromCountry('XX')).toBe('unknown');
  });
});

describe('deriveMarketBucketFromName (Unicode-script analysis)', () => {
  it('detects Cyrillic names', () => {
    expect(deriveMarketBucketFromName('Дмитрий')).toBe('ru');
    expect(deriveMarketBucketFromName('Ёжик')).toBe('ru');
  });

  it('detects Arabic names including Presentation Forms', () => {
    expect(deriveMarketBucketFromName('محمد')).toBe('ar');
    expect(deriveMarketBucketFromName('علي')).toBe('ar');
    // Persian/Urdu names often appear in Presentation Forms-A (FB50-FDFF)
    expect(deriveMarketBucketFromName('ﭘﻴﺎم')).toBe('ar');
  });

  it('detects Devanagari names', () => {
    expect(deriveMarketBucketFromName('राज')).toBe('hi');
    expect(deriveMarketBucketFromName('अनिल')).toBe('hi');
  });

  it('detects Han/CJK names', () => {
    expect(deriveMarketBucketFromName('张伟')).toBe('zh-CN');
    expect(deriveMarketBucketFromName('陳')).toBe('zh-CN');
  });

  it('detects Hangul / Kana / Hebrew / Greek / Thai as other_known', () => {
    expect(deriveMarketBucketFromName('김')).toBe('other_known');     // Hangul
    expect(deriveMarketBucketFromName('たろう')).toBe('other_known');  // Hiragana
    expect(deriveMarketBucketFromName('タロウ')).toBe('other_known');  // Katakana
    expect(deriveMarketBucketFromName('דוד')).toBe('other_known');     // Hebrew
    expect(deriveMarketBucketFromName('Δημήτρης')).toBe('other_known'); // Greek
    expect(deriveMarketBucketFromName('สมชาย')).toBe('other_known');    // Thai
  });

  it('returns unknown for Latin-only or empty', () => {
    // Critical: don't lock-in a wrong answer when name is ambiguous.
    expect(deriveMarketBucketFromName('John')).toBe('unknown');
    expect(deriveMarketBucketFromName('Maria')).toBe('unknown');
    expect(deriveMarketBucketFromName('Vladimir')).toBe('unknown'); // Cyrillic name in Latin script
    expect(deriveMarketBucketFromName('')).toBe('unknown');
    expect(deriveMarketBucketFromName(null)).toBe('unknown');
  });
});

describe('resolveMarketBucket (priority chain)', () => {
  it('language_code wins over every other signal', () => {
    const r = resolveMarketBucket({
      languageCode: 'ru',
      browserLanguage: 'en-US',
      timezone: 'Europe/Berlin',
      countryCode: 'DE',
      firstName: '田中',
    });
    expect(r).toEqual({ bucket: 'ru', source: 'language_code' });
  });

  it('falls through unrecognised language_code to browser_language', () => {
    const r = resolveMarketBucket({
      languageCode: 'xx-YY',
      browserLanguage: 'ar-SA',
      timezone: 'Europe/Berlin',
    });
    expect(r).toEqual({ bucket: 'ar', source: 'browser_language' });
  });

  it('falls through to timezone when language signals are unknown', () => {
    const r = resolveMarketBucket({
      languageCode: null,
      browserLanguage: null,
      timezone: 'Europe/Moscow',
      countryCode: 'DE',
    });
    expect(r).toEqual({ bucket: 'ru', source: 'timezone' });
  });

  it('falls through to country_code when timezone is unrecognised', () => {
    const r = resolveMarketBucket({
      timezone: 'Mars/Olympus',
      countryCode: 'IN',
    });
    expect(r).toEqual({ bucket: 'hi', source: 'country_code' });
  });

  it('falls through to first_name script analysis as last resort', () => {
    const r = resolveMarketBucket({
      firstName: 'محمد',
    });
    expect(r).toEqual({ bucket: 'ar', source: 'first_name' });
  });

  it('returns unknown when no signal yields a bucket', () => {
    const r = resolveMarketBucket({
      languageCode: '',
      browserLanguage: null,
      timezone: 'Mars/Olympus',
      countryCode: 'XX',
      firstName: 'John',
    });
    expect(r).toEqual({ bucket: 'unknown', source: 'unknown' });
  });

  it('returns other_known with correct source when language is recognised non-target', () => {
    // Other-known IS a definitive answer; the chain stops here even
    // though stronger signals downstream might say something different.
    // This prevents "Frenchman in Russia → ru" misclassification.
    const r = resolveMarketBucket({
      languageCode: 'fr-FR',
      timezone: 'Europe/Moscow',
    });
    expect(r).toEqual({ bucket: 'other_known', source: 'language_code' });
  });

  it('does not lock-in unknown when language_code is empty string', () => {
    // Common edge case: Telegram sends language_code as empty string
    // rather than omitting the field. Resolver must keep walking.
    const r = resolveMarketBucket({
      languageCode: '',
      timezone: 'Asia/Riyadh',
    });
    expect(r).toEqual({ bucket: 'ar', source: 'timezone' });
  });
});
