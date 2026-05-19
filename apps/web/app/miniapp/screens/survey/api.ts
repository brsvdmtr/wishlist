// Typed API wrappers for the survey flow.
//
// Each function takes the parent MiniApp's tgFetch (a closure with initData
// + apiBase). All POSTs include `idempotency: { action }` so accidental
// double-taps don't double-record.

import type {
  SurveyByInviteResponse,
  AnswerResponseWire,
  CompleteResponseWire,
} from './types';

export type TgFetch = (
  path: string,
  init?: RequestInit & {
    timeoutMs?: number;
    idempotency?: string | { action: string };
  },
) => Promise<Response>;

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<T>;
}

export async function loadSurveyByInvite(
  tg: TgFetch,
  inviteId: string,
): Promise<SurveyByInviteResponse> {
  const res = await tg(`/tg/research/surveys/by-invite/${encodeURIComponent(inviteId)}`);
  return jsonOrThrow(res);
}

export async function postAnswer(
  tg: TgFetch,
  surveyId: string,
  body: {
    inviteId: string;
    questionId: string;
    selectedOptionIds: string[];
    answerText?: string;
  },
): Promise<AnswerResponseWire> {
  const res = await tg(`/tg/research/surveys/${encodeURIComponent(surveyId)}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    idempotency: { action: `survey.answer:${body.inviteId}:${body.questionId}` },
  });
  return jsonOrThrow(res);
}

export async function postComplete(
  tg: TgFetch,
  surveyId: string,
  inviteId: string,
): Promise<CompleteResponseWire> {
  const res = await tg(`/tg/research/surveys/${encodeURIComponent(surveyId)}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inviteId }),
    idempotency: { action: `survey.complete:${inviteId}` },
  });
  return jsonOrThrow(res);
}

export async function postDismiss(
  tg: TgFetch,
  surveyId: string,
  inviteId: string,
): Promise<{ ok: true }> {
  const res = await tg(`/tg/research/surveys/${encodeURIComponent(surveyId)}/dismiss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ inviteId }),
    idempotency: { action: `survey.dismiss:${inviteId}` },
  });
  return jsonOrThrow(res);
}
