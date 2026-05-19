// Validation unit tests — covers the MC-* scenarios from design v1.2 §5.1.
//
// Pure: no Prisma, no network. Drives `validateAnswer` directly with
// crafted payloads.

import { describe, it, expect } from 'vitest';
import { validateAnswer, MAX_ANSWER_TEXT_LENGTH } from './validation';

describe('validateAnswer — single-choice (Q1)', () => {
  it('accepts exactly 1 valid optionId', () => {
    const res = validateAnswer({ questionId: 'q1', selectedOptionIds: ['curiosity'] });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.selectedOptionIds).toEqual(['curiosity']);
      expect(res.data.answerText).toBeNull();
    }
  });

  it('MC-1: rejects 2 selections for a single-choice question (cardinality)', () => {
    const res = validateAnswer({ questionId: 'q1', selectedOptionIds: ['curiosity', 'gift_planning'] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('CARDINALITY');
  });

  it('rejects an unknown questionId', () => {
    const res = validateAnswer({ questionId: 'q42', selectedOptionIds: ['curiosity'] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('UNKNOWN_QUESTION');
  });

  it('rejects an unknown optionId', () => {
    const res = validateAnswer({ questionId: 'q1', selectedOptionIds: ['mystery_option'] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('UNKNOWN_OPTION');
  });
});

describe('validateAnswer — multi-choice (Q3)', () => {
  it('MC-2: accepts 1 option for a multi (≥1 lower bound)', () => {
    const res = validateAnswer({ questionId: 'q3', selectedOptionIds: ['url_import'] });
    expect(res.ok).toBe(true);
  });

  it('MC-3: accepts 2 options for a multi (max)', () => {
    const res = validateAnswer({ questionId: 'q3', selectedOptionIds: ['url_import', 'share_link'] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.selectedOptionIds.length).toBe(2);
  });

  it('MC-4: rejects 3 options for a max-2 multi', () => {
    const res = validateAnswer({ questionId: 'q3', selectedOptionIds: ['url_import', 'share_link', 'categories'] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('CARDINALITY');
  });

  it('MC-5: rejects duplicate optionIds in payload before persisting', () => {
    const res = validateAnswer({ questionId: 'q3', selectedOptionIds: ['url_import', 'url_import'] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('DUPLICATE_OPTIONS');
  });

  it('MC-6: rejects unknown optionId in a multi list', () => {
    const res = validateAnswer({ questionId: 'q3', selectedOptionIds: ['url_import', 'mystery'] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('UNKNOWN_OPTION');
  });
});

describe('validateAnswer — NPS (Q9)', () => {
  it('MC-7: accepts a single score in range', () => {
    for (const score of [0, 5, 10]) {
      const res = validateAnswer({ questionId: 'q9', selectedOptionIds: [`score_${score}`] });
      expect(res.ok).toBe(true);
    }
  });

  it('MC-8: rejects score_11 / 11 / nonsense', () => {
    for (const bad of ['score_11', '11', 'score_-1', 'ten']) {
      const res = validateAnswer({ questionId: 'q9', selectedOptionIds: [bad] });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe('UNKNOWN_OPTION');
    }
  });
});

describe('validateAnswer — open (Q10)', () => {
  it('MC-9: accepts __text__ with 500-char text', () => {
    const text = 'a'.repeat(500);
    const res = validateAnswer({ questionId: 'q10', selectedOptionIds: ['__text__'], answerText: text });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.answerText).toBe(text);
  });

  it('MC-10: rejects 501-char text', () => {
    const text = 'a'.repeat(501);
    const res = validateAnswer({ questionId: 'q10', selectedOptionIds: ['__text__'], answerText: text });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('TEXT_TOO_LONG');
  });

  it('accepts __text__ without answerText (skip variant)', () => {
    const res = validateAnswer({ questionId: 'q10', selectedOptionIds: ['__text__'] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.answerText).toBeNull();
  });

  it('rejects only-whitespace answerText (trimmed empty)', () => {
    const res = validateAnswer({ questionId: 'q10', selectedOptionIds: ['__text__'], answerText: '    ' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('TEXT_EMPTY');
  });

  it('rejects answerText containing control characters', () => {
    const res = validateAnswer({ questionId: 'q10', selectedOptionIds: ['__text__'], answerText: 'helloworld' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('TEXT_CONTROL_CHARS');
  });

  it('trims surrounding whitespace before length check', () => {
    // 5 ('hello') + 3 spaces + (MAX-8) 'x' = MAX chars after trim removes 3 leading + 3 trailing spaces.
    const text = `   hello   ${'x'.repeat(MAX_ANSWER_TEXT_LENGTH - 8)}   `;
    const res = validateAnswer({
      questionId: 'q10',
      selectedOptionIds: ['__text__'],
      answerText: text,
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.answerText?.startsWith('hello')).toBe(true);
      expect(res.data.answerText?.endsWith('x')).toBe(true);
      expect(res.data.answerText?.length).toBe(MAX_ANSWER_TEXT_LENGTH);
    }
  });
});

describe('validateAnswer — answerText permission gating', () => {
  it('MC-11: accepts \'other\' selection without answerText', () => {
    const res = validateAnswer({ questionId: 'q4', selectedOptionIds: ['other'] });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.answerText).toBeNull();
  });

  it('MC-12: accepts \'other\' selection with answerText', () => {
    const res = validateAnswer({
      questionId: 'q4',
      selectedOptionIds: ['other'],
      answerText: 'lost in menus',
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.answerText).toBe('lost in menus');
  });

  it('MC-13: rejects answerText when no text-allowed option is in selection', () => {
    const res = validateAnswer({
      questionId: 'q4',
      selectedOptionIds: ['ui_confusing'],
      answerText: 'oh',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('TEXT_NOT_ALLOWED');
  });

  it('accepts answerText when \'other\' is one of two multi selections', () => {
    const res = validateAnswer({
      questionId: 'q3',
      selectedOptionIds: ['url_import', 'other'],
      answerText: 'I really liked the keyboard shortcuts',
    });
    expect(res.ok).toBe(true);
  });
});

describe('validateAnswer — payload-shape defense', () => {
  // The AnswerRequestPayload type uses `unknown` for incoming fields, so these
  // tests don't need @ts-expect-error — they exercise the runtime guards on
  // dirty payloads that have already passed JSON.parse but not the schema.

  it('rejects missing questionId', () => {
    const res = validateAnswer({ selectedOptionIds: ['curiosity'] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('UNKNOWN_QUESTION');
  });

  it('rejects missing selectedOptionIds', () => {
    const res = validateAnswer({ questionId: 'q1' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('NO_OPTIONS');
  });

  it('rejects empty selectedOptionIds array', () => {
    const res = validateAnswer({ questionId: 'q1', selectedOptionIds: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('NO_OPTIONS');
  });

  it('rejects non-string entries in selectedOptionIds', () => {
    const res = validateAnswer({ questionId: 'q1', selectedOptionIds: [42] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('NO_OPTIONS');
  });
});
