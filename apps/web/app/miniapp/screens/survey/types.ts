// Shared shapes between SurveyScreen.tsx and api.ts.
//
// Mirrors apps/api/src/services/research-survey/survey-pmf-v1.ts on the
// wire side — keep field names in sync.

export type SurveyQuestionType = 'single' | 'multi' | 'nps' | 'open';

export interface SurveyQuestionWire {
  id: string;
  type: SurveyQuestionType;
  maxSelections: number;
  options: readonly string[];
  optional: boolean;
}

export interface SurveyByInviteResponse {
  invite: {
    id: string;
    surveyId: string;
    locale: 'ru' | 'en';
    status:
      | 'PENDING'
      | 'SENT'
      | 'OPENED'
      | 'STARTED'
      | 'COMPLETED'
      | 'DISMISSED'
      | 'FAILED';
  };
  survey: {
    slug: string;
    version: number;
    questions: SurveyQuestionWire[];
    required: readonly string[];
  };
  progress: { answered: string[]; totalRequired: number; canComplete: boolean };
  response: { completedAt: string | null; rewardKind: string | null } | null;
}

export interface AnswerWire {
  inviteId: string;
  questionId: string;
  selectedOptionIds: string[];
  answerText?: string;
}

export interface AnswerResponseWire {
  ok: true;
  responseId: string;
  progress: { answered: string[]; totalRequired: number; canComplete: boolean };
}

export interface CompleteResponseWire {
  ok: true;
  rewardKind: 'pro_30d' | 'pro_30d_lifetime_noop';
  rewardGrantedAt: string;
  alreadyCompleted: boolean;
}
