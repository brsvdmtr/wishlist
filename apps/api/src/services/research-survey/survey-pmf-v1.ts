// Survey definition: PMF discovery v1.
//
// Source of truth for question IDs, option IDs, and per-question type/cardinality.
// IDs here are frozen at release — translation/copy may change freely in i18n,
// but optionId never changes for an already-shipped version. Adding/removing an
// option requires bumping the version (SURVEY_PMF_V2) and a new ResearchSurvey
// row in the DB.
//
// Question types and cardinality:
//   single — exactly 1 optionId
//   multi  — 1..maxSelections optionIds (currently 2 for Q3/Q6/Q7)
//   nps    — exactly 1 optionId in 'score_0'..'score_10'
//   open   — exactly 1 optionId ('__text__'); answerText optional (Q10 is optional overall)
//
// answerText is permitted only when the selected set intersects
// {'__text__', 'other'}. The service layer trims, length-caps at 500, and
// rejects pure-whitespace / control-character payloads.

export type SurveyQuestionType = 'single' | 'multi' | 'nps' | 'open';

export interface SurveyQuestion {
  readonly id: string;
  readonly type: SurveyQuestionType;
  readonly maxSelections: number;
  readonly options: readonly string[];
  readonly optional?: boolean;
}

export interface SurveyDefinition {
  readonly slug: string;
  readonly version: number;
  readonly questions: readonly SurveyQuestion[];
  readonly required: readonly string[];
}

export const SURVEY_PMF_V1: SurveyDefinition = {
  slug: 'pmf-discovery',
  version: 1,
  questions: [
    {
      id: 'q1',
      type: 'single',
      maxSelections: 1,
      options: [
        'curiosity',
        'gift_planning',
        'birthday_self',
        'holiday',
        'wedding',
        'baby_registry',
        'friend_invite',
        'replace_other_tool',
        'other',
      ],
    },
    {
      id: 'q2',
      type: 'single',
      maxSelections: 1,
      options: [
        'own_birthday',
        'partner_birthday',
        'kid_birthday',
        'friend_birthday',
        'new_year_christmas',
        'wedding',
        'baby_shower',
        'housewarming',
        'self_treat',
        'no_specific_occasion',
        'other',
      ],
    },
    {
      id: 'q3',
      type: 'multi',
      maxSelections: 2,
      options: [
        'adding_items',
        'url_import',
        'share_link',
        'reservations_anonymous',
        'multiple_wishlists',
        'birthday_calendar',
        'categories',
        'hints',
        'pro_features',
        'mini_app_in_telegram',
        'nothing_special',
        'other',
      ],
    },
    {
      id: 'q4',
      type: 'single',
      maxSelections: 1,
      options: [
        'ui_confusing',
        'url_import_broken',
        'friends_not_in_telegram',
        'nobody_to_share_with',
        'forgot_to_use',
        'not_enough_features',
        'bugs_or_crashes',
        'not_relevant_now',
        'nothing_blocked',
        'other',
      ],
    },
    {
      id: 'q5',
      type: 'single',
      maxSelections: 1,
      options: [
        'yes_friends_family',
        'yes_partner_only',
        'yes_link_no_response',
        'no_didnt_want',
        'no_didnt_know_how',
        'no_nothing_to_share',
        'no_too_early',
      ],
    },
    {
      id: 'q6',
      type: 'multi',
      maxSelections: 2,
      options: [
        'reminders_birthdays',
        'reminders_my_own',
        'url_import_better',
        'shopping_assistant',
        'group_gifting',
        'price_drop_alerts',
        'friends_already_inside',
        'web_version',
        'nothing_would_help',
        'other',
      ],
    },
    {
      id: 'q7',
      type: 'multi',
      maxSelections: 2,
      options: [
        'unlimited_wishlists',
        'unlimited_items',
        'ai_suggestions',
        'group_gifting',
        'private_wishlists',
        'secret_santa',
        'price_tracking',
        'premium_calendar',
        'gift_history',
        'nothing_worth_paying',
        'other',
      ],
    },
    {
      id: 'q8',
      type: 'single',
      maxSelections: 1,
      options: ['very_disappointed', 'somewhat_disappointed', 'not_disappointed', 'not_using_anyway'],
    },
    {
      id: 'q9',
      type: 'nps',
      maxSelections: 1,
      options: [
        'score_0',
        'score_1',
        'score_2',
        'score_3',
        'score_4',
        'score_5',
        'score_6',
        'score_7',
        'score_8',
        'score_9',
        'score_10',
      ],
    },
    {
      id: 'q10',
      type: 'open',
      maxSelections: 1,
      options: ['__text__'],
      optional: true,
    },
  ],
  required: ['q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7', 'q8', 'q9'],
};

export const ACTIVE_SURVEY = SURVEY_PMF_V1;

// Build a fast lookup map: questionId → SurveyQuestion. Used by validation.
const QUESTIONS_BY_ID = new Map<string, SurveyQuestion>(
  ACTIVE_SURVEY.questions.map((q) => [q.id, q]),
);

export function getQuestion(questionId: string): SurveyQuestion | undefined {
  return QUESTIONS_BY_ID.get(questionId);
}

export function listQuestionIds(): readonly string[] {
  return ACTIVE_SURVEY.questions.map((q) => q.id);
}
