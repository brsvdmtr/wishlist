import { getQuestion, type SurveyQuestion } from './survey-pmf-v1';

export type AnswerValidationError =
  | { code: 'UNKNOWN_QUESTION'; questionId: string }
  | { code: 'NO_OPTIONS' }
  | { code: 'DUPLICATE_OPTIONS' }
  | { code: 'UNKNOWN_OPTION'; optionId: string }
  | { code: 'CARDINALITY'; expected: { min: number; max: number }; actual: number }
  | { code: 'TEXT_NOT_ALLOWED' }
  | { code: 'TEXT_EMPTY' }
  | { code: 'TEXT_TOO_LONG'; maxLength: number; actual: number }
  | { code: 'TEXT_CONTROL_CHARS' };

export interface ValidAnswerPayload {
  questionId: string;
  selectedOptionIds: string[];
  answerText: string | null;
  question: SurveyQuestion;
}

export const MAX_ANSWER_TEXT_LENGTH = 500;
const CONTROL_CHARS = /\p{C}/u;
const TEXT_OPTION_IDS = new Set(['__text__', 'other']);

export interface AnswerRequestPayload {
  questionId?: unknown;
  selectedOptionIds?: unknown;
  answerText?: unknown;
}

export function validateAnswer(
  payload: AnswerRequestPayload,
): { ok: true; data: ValidAnswerPayload } | { ok: false; error: AnswerValidationError } {
  const questionId = typeof payload.questionId === 'string' ? payload.questionId : '';
  const question = getQuestion(questionId);
  if (!question) return { ok: false, error: { code: 'UNKNOWN_QUESTION', questionId } };

  if (!Array.isArray(payload.selectedOptionIds)) {
    return { ok: false, error: { code: 'NO_OPTIONS' } };
  }
  const rawOptions = payload.selectedOptionIds;
  if (rawOptions.length === 0) return { ok: false, error: { code: 'NO_OPTIONS' } };
  if (!rawOptions.every((o): o is string => typeof o === 'string')) {
    return { ok: false, error: { code: 'NO_OPTIONS' } };
  }
  const selected = rawOptions as string[];

  const dedup = new Set(selected);
  if (dedup.size !== selected.length) {
    return { ok: false, error: { code: 'DUPLICATE_OPTIONS' } };
  }

  const allowed = new Set(question.options);
  for (const optionId of selected) {
    if (!allowed.has(optionId)) {
      return { ok: false, error: { code: 'UNKNOWN_OPTION', optionId } };
    }
  }

  const { min, max } = cardinalityFor(question);
  if (selected.length < min || selected.length > max) {
    return { ok: false, error: { code: 'CARDINALITY', expected: { min, max }, actual: selected.length } };
  }

  const textAllowed = selected.some((o) => TEXT_OPTION_IDS.has(o));
  let answerText: string | null = null;

  if (payload.answerText !== undefined && payload.answerText !== null && payload.answerText !== '') {
    if (typeof payload.answerText !== 'string') {
      return { ok: false, error: { code: 'TEXT_EMPTY' } };
    }
    if (!textAllowed) {
      return { ok: false, error: { code: 'TEXT_NOT_ALLOWED' } };
    }
    const trimmed = payload.answerText.trim();
    if (trimmed.length === 0) {
      return { ok: false, error: { code: 'TEXT_EMPTY' } };
    }
    if (trimmed.length > MAX_ANSWER_TEXT_LENGTH) {
      return {
        ok: false,
        error: { code: 'TEXT_TOO_LONG', maxLength: MAX_ANSWER_TEXT_LENGTH, actual: trimmed.length },
      };
    }
    if (CONTROL_CHARS.test(trimmed)) {
      return { ok: false, error: { code: 'TEXT_CONTROL_CHARS' } };
    }
    answerText = trimmed;
  }

  return {
    ok: true,
    data: { questionId, selectedOptionIds: selected, answerText, question },
  };
}

function cardinalityFor(question: SurveyQuestion): { min: number; max: number } {
  switch (question.type) {
    case 'single':
    case 'nps':
    case 'open':
      return { min: 1, max: 1 };
    case 'multi':
      return { min: 1, max: question.maxSelections };
  }
}

export function httpStatusForError(error: AnswerValidationError): number {
  if (error.code === 'CARDINALITY') return 422;
  return 400;
}
