// Sanity checks on the frozen SURVEY_PMF_V1 schema.
//
// optionIds frozen at release → these tests catch accidental edits before
// they break in-flight responses and analytics dashboards.

import { describe, it, expect } from 'vitest';
import { SURVEY_PMF_V1, getQuestion, listQuestionIds } from './survey-pmf-v1';

describe('SURVEY_PMF_V1 schema invariants', () => {
  it('has exactly 10 questions', () => {
    expect(SURVEY_PMF_V1.questions.length).toBe(10);
  });

  it('ids are q1..q10 in order', () => {
    expect(SURVEY_PMF_V1.questions.map((q) => q.id)).toEqual([
      'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9', 'q10',
    ]);
  });

  it('required list contains q1..q9 (Q10 optional)', () => {
    expect([...SURVEY_PMF_V1.required]).toEqual(['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9']);
  });

  it('Q3 / Q6 / Q7 are multi with maxSelections=2', () => {
    for (const id of ['q3', 'q6', 'q7']) {
      const q = getQuestion(id);
      expect(q?.type).toBe('multi');
      expect(q?.maxSelections).toBe(2);
    }
  });

  it('Q9 is nps with score_0..score_10', () => {
    const q = getQuestion('q9');
    expect(q?.type).toBe('nps');
    expect(q?.options.length).toBe(11);
    for (let i = 0; i <= 10; i += 1) {
      expect(q?.options).toContain(`score_${i}`);
    }
  });

  it('Q10 is open with __text__ and optional=true', () => {
    const q = getQuestion('q10');
    expect(q?.type).toBe('open');
    expect(q?.options).toEqual(['__text__']);
    expect(q?.optional).toBe(true);
  });

  it('no duplicate optionIds within any single question', () => {
    for (const q of SURVEY_PMF_V1.questions) {
      const seen = new Set<string>();
      for (const opt of q.options) {
        expect(seen.has(opt), `duplicate option in ${q.id}: ${opt}`).toBe(false);
        seen.add(opt);
      }
    }
  });

  it('optionIds are stable kebab-cased snake_case (lowercase, no spaces, no special chars)', () => {
    const allowedPattern = /^[a-z0-9_]+$/;
    for (const q of SURVEY_PMF_V1.questions) {
      for (const opt of q.options) {
        // Allow the two reserved sentinels.
        if (opt === '__text__' || opt.startsWith('score_')) continue;
        expect(allowedPattern.test(opt), `${q.id}: ${opt}`).toBe(true);
      }
    }
  });

  it('slug + version: pmf-discovery v1', () => {
    expect(SURVEY_PMF_V1.slug).toBe('pmf-discovery');
    expect(SURVEY_PMF_V1.version).toBe(1);
  });

  it('getQuestion returns undefined for unknown id', () => {
    expect(getQuestion('q42')).toBeUndefined();
  });

  it('listQuestionIds matches questions array', () => {
    expect(listQuestionIds()).toEqual(SURVEY_PMF_V1.questions.map((q) => q.id));
  });
});
