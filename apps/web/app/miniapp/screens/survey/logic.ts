// Pure selection logic for SurveyScreen.
//
// Extracted from the React component so the rules around
// single/multi/nps/open + cap behaviour are testable in isolation.
// React state itself stays in the component — this module only
// computes the next selection given the prior one.

import type { SurveyQuestionType } from './types';

export interface ToggleInput {
  selected: readonly string[];
  optionId: string;
  type: SurveyQuestionType;
  maxSelections: number;
}

export interface ToggleResult {
  next: string[];
  /** True iff the click was a no-op because the cap was already reached.
   *  UI uses this to flash a transient "max N options" hint. */
  capHit: boolean;
}

export function toggleSelection({ selected, optionId, type, maxSelections }: ToggleInput): ToggleResult {
  // Open-text: clicks don't change selection (UI shouldn't even render options).
  if (type === 'open') return { next: [...selected], capHit: false };

  // Single / NPS: replace any previous pick.
  if (type === 'single' || type === 'nps') {
    return { next: [optionId], capHit: false };
  }

  // Multi: re-click deselects, otherwise add up to maxSelections.
  if (selected.includes(optionId)) {
    return { next: selected.filter((o) => o !== optionId), capHit: false };
  }
  if (selected.length >= maxSelections) {
    // Cap reached — block the click, do NOT swap-out an earlier pick.
    return { next: [...selected], capHit: true };
  }
  return { next: [...selected, optionId], capHit: false };
}

/** True if "Next" / "Submit" should be enabled for the current question. */
export function canAdvance(args: {
  type: SurveyQuestionType;
  selected: readonly string[];
}): boolean {
  if (args.type === 'open') return true; // Q10 optional skip
  return args.selected.length >= 1;
}
