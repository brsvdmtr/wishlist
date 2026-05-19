// Anti-regression for SurveyCopy ru text.
//
// Two failure modes this guards against:
//   1. A copywriter (or me) reverts to a machine-translated label like
//      "Ссылка-делиться" without realising it shipped to prod once.
//   2. A refactor accidentally drops the `multiCapHit` key so the multi-
//      choice cap warning silently stops appearing.
//
// optionIds themselves are still tested in apps/api (SURVEY_PMF_V1 schema);
// this file only pins the *Russian labels*.

import { describe, it, expect } from 'vitest';
import { getCopy } from './copy';

const ru = getCopy('ru');
const en = getCopy('en');

// Phrases that shipped once and must never return. Each entry has a
// short justification so the next reviewer understands why.
const BANNED_RU_SUBSTRINGS: { phrase: string; reason: string }[] = [
  { phrase: 'Ссылка-делиться', reason: 'machine translation of share_link; replaced 2026-05-19' },
  { phrase: 'ДР друзей',       reason: 'avoid abbreviations in user-facing copy' },
  { phrase: 'Алерты',          reason: 'anglicism; use "Уведомления"' },
  { phrase: 'Платные фичи',    reason: 'use "PRO-возможности" (matches brand)' },
];

function stringValuesDeep(obj: unknown, out: string[] = []): string[] {
  if (typeof obj === 'string') {
    out.push(obj);
    return out;
  }
  if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj as Record<string, unknown>)) stringValuesDeep(v, out);
  }
  return out;
}

describe('SurveyCopy ru — anti-regression on banned phrases', () => {
  const allRuStrings = stringValuesDeep(ru);

  for (const { phrase, reason } of BANNED_RU_SUBSTRINGS) {
    it(`never reintroduces "${phrase}" (${reason})`, () => {
      const hits = allRuStrings.filter((s) => s.includes(phrase));
      expect(hits, `forbidden phrase resurfaced: "${phrase}"`).toEqual([]);
    });
  }
});

describe('SurveyCopy ru — Q3 option labels (frozen)', () => {
  // Pin the Q3 ru labels exactly. If a copy edit changes one, the test
  // forces a deliberate update here — keeps drift between docs and code
  // visible in PR diffs.
  it('matches the approved labels', () => {
    expect(ru.q.q3?.options).toEqual({
      adding_items: 'Быстро добавить желание',
      url_import: 'Добавить товар по ссылке',
      share_link: 'Поделиться вишлистом с близкими',
      reservations_anonymous: 'Скрытые брони без спойлеров',
      multiple_wishlists: 'Создать несколько вишлистов',
      birthday_calendar: 'Напоминания о днях рождения',
      categories: 'Разложить желания по категориям',
      hints: 'Получать подсказки и идеи',
      pro_features: 'PRO-возможности',
      mini_app_in_telegram: 'Удобно пользоваться внутри Telegram',
      nothing_special: 'Пока ничего не зацепило',
      other: 'Другое',
    });
  });

  it('Q3 title and subtitle communicate "value", not "vibe"', () => {
    expect(ru.q.q3?.title).toBe('Что показалось самым полезным?');
    expect(ru.multiHint).toBe('Выбери до {{max}} вариантов');
  });
});

describe('SurveyCopy — multiCapHit key present in both locales', () => {
  it('ru has multiCapHit with {{max}} placeholder', () => {
    expect(ru.multiCapHit).toMatch(/\{\{max\}\}/);
  });
  it('en has multiCapHit with {{max}} placeholder', () => {
    expect(en.multiCapHit).toMatch(/\{\{max\}\}/);
  });
});
