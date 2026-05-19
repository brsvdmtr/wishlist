// Component-level tests for the multi-choice UX (Q3/Q6/Q7) in SurveyScreen.
//
// Logic correctness is covered in logic.test.ts; this file pins the
// rendered behaviour:
//   - clicking the same option twice toggles selection;
//   - the third unselected option in a max-2 question is blocked;
//   - the transient cap-hit warning appears, then auto-clears;
//   - "Дальше" disabled with 0 picks, enabled with 1–2;
//   - postAnswer is called with selectedOptionIds as an array (not a scalar).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { SurveyScreen } from './SurveyScreen';
import type { SurveyByInviteResponse } from './types';

// Stub the API at the module boundary. Components call these functions;
// we control the responses + can inspect arguments.
const loadMock = vi.fn();
const postAnswerMock = vi.fn();
const postCompleteMock = vi.fn();
const postDismissMock = vi.fn();
vi.mock('./api', () => ({
  loadSurveyByInvite: (...args: unknown[]) => loadMock(...args),
  postAnswer: (...args: unknown[]) => postAnswerMock(...args),
  postComplete: (...args: unknown[]) => postCompleteMock(...args),
  postDismiss: (...args: unknown[]) => postDismissMock(...args),
}));

function makeSurvey(): SurveyByInviteResponse {
  return {
    invite: { id: 'inv1', surveyId: 'sv1', locale: 'ru', status: 'OPENED' },
    survey: {
      slug: 'pmf-discovery',
      version: 1,
      questions: [
        {
          id: 'q3',
          type: 'multi',
          maxSelections: 2,
          optional: false,
          options: [
            'adding_items',
            'url_import',
            'share_link',
            'reservations_anonymous',
            'multiple_wishlists',
          ],
        },
      ],
      required: ['q3'],
    },
    progress: { answered: [], totalRequired: 1, canComplete: false },
    response: null,
  };
}

beforeEach(() => {
  loadMock.mockReset();
  postAnswerMock.mockReset();
  postCompleteMock.mockReset();
  postDismissMock.mockReset();
  loadMock.mockResolvedValue(makeSurvey());
  postAnswerMock.mockResolvedValue({
    ok: true,
    responseId: 'r1',
    progress: { answered: ['q3'], totalRequired: 1, canComplete: true },
  });
  postCompleteMock.mockResolvedValue({
    ok: true,
    rewardKind: 'pro_30d',
    rewardGrantedAt: new Date().toISOString(),
    alreadyCompleted: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

function buildProps() {
  return {
    inviteId: 'inv1',
    tgFetch: vi.fn(),
    onExit: vi.fn(),
    onCompleted: vi.fn(),
  };
}

async function renderAndWaitForQuestion() {
  const result = render(<SurveyScreen {...buildProps()} />);
  await waitFor(() => {
    expect(screen.getByText('Что показалось самым полезным?')).toBeTruthy();
  });
  return result;
}

describe('SurveyScreen — Q3 multi-choice UX', () => {
  it('renders question title and the "choose up to 2" hint', async () => {
    await renderAndWaitForQuestion();
    expect(screen.getByText('Выбери до 2 вариантов')).toBeTruthy();
    // Verifies the new ru label landed (replaces the old "Ссылка-делиться").
    expect(screen.getByText('Поделиться вишлистом с близкими')).toBeTruthy();
  });

  it('renders each option as a checkbox (multi), not a radio', async () => {
    await renderAndWaitForQuestion();
    const checkboxes = screen.getAllByRole('checkbox');
    // 5 options in the fixture.
    expect(checkboxes.length).toBe(5);
  });

  it('primary CTA is disabled with 0 picks; enabled with 1 pick', async () => {
    await renderAndWaitForQuestion();
    // Single-question fixture → the primary CTA is "Завершить" (submit).
    // The flow + ru label combos are covered separately.
    const cta = screen.getByText('Завершить').closest('button')!;
    expect((cta as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByText('Быстро добавить желание').closest('button')!);
    expect((screen.getByText('Завершить').closest('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('allows selecting two options (multi-choice)', async () => {
    await renderAndWaitForQuestion();
    const a = screen.getByText('Быстро добавить желание').closest('button')!;
    const b = screen.getByText('Добавить товар по ссылке').closest('button')!;
    fireEvent.click(a);
    fireEvent.click(b);
    expect(a.getAttribute('aria-checked')).toBe('true');
    expect(b.getAttribute('aria-checked')).toBe('true');
  });

  it('blocks the third unselected option and surfaces the cap warning', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderAndWaitForQuestion();
    fireEvent.click(screen.getByText('Быстро добавить желание').closest('button')!);
    fireEvent.click(screen.getByText('Добавить товар по ссылке').closest('button')!);
    const third = screen.getByText('Поделиться вишлистом с близкими').closest('button')!;
    fireEvent.click(third);
    expect(third.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('alert').textContent).toContain('не больше 2');

    // Warning auto-clears after ~2.4s.
    act(() => { vi.advanceTimersByTime(3000); });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('re-clicking a selected option deselects it', async () => {
    await renderAndWaitForQuestion();
    const a = screen.getByText('Быстро добавить желание').closest('button')!;
    fireEvent.click(a);
    expect(a.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(a);
    expect(a.getAttribute('aria-checked')).toBe('false');
  });

  it('after deselect, the cap re-opens and warning does NOT fire', async () => {
    await renderAndWaitForQuestion();
    fireEvent.click(screen.getByText('Быстро добавить желание').closest('button')!);
    fireEvent.click(screen.getByText('Добавить товар по ссылке').closest('button')!);
    // Now deselect one.
    fireEvent.click(screen.getByText('Быстро добавить желание').closest('button')!);
    // Third becomes selectable.
    const third = screen.getByText('Поделиться вишлистом с близкими').closest('button')!;
    fireEvent.click(third);
    expect(third.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('postAnswer receives selectedOptionIds as an ARRAY with 2 entries', async () => {
    await renderAndWaitForQuestion();
    fireEvent.click(screen.getByText('Быстро добавить желание').closest('button')!);
    fireEvent.click(screen.getByText('Добавить товар по ссылке').closest('button')!);
    fireEvent.click(screen.getByText('Завершить').closest('button')!);
    await waitFor(() => expect(postAnswerMock).toHaveBeenCalled());
    const firstCall = postAnswerMock.mock.calls[0]!;
    const body = firstCall[2] as { questionId: string; selectedOptionIds: string[] };
    expect(body.questionId).toBe('q3');
    expect(Array.isArray(body.selectedOptionIds)).toBe(true);
    expect(body.selectedOptionIds).toEqual(['adding_items', 'url_import']);
  });
});
