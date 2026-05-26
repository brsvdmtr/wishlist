// useGiftNotesState — F3 cluster-hook for Gift Notes (occasions + ideas).
//
// Extracted from MiniApp.tsx (was lines 4555..4580). The hook returns the
// SAME names that lived inline — MiniApp.tsx just destructures everything
// in one statement, so consumer sites stay byte-identical (no rename storm
// across 50+ usage points).
//
// This unlocks the F4 Wave C extraction: the lazy GiftNotes screens can
// import the same hook directly instead of receiving 19 props each.
//
// State surface kept loose-typed (`any`) where the original was loose;
// tightening to proper DTO types is a separate concern.

'use client';

import { useState } from 'react';

export type GnAccess = {
  unlocked: boolean;
  unlockType: string | null;
  priceXtr: number;
};

export type GnFormType = 'BIRTHDAY' | 'ANNIVERSARY' | 'HOLIDAY' | 'OTHER';
export type GnFormRecurrence = 'NONE' | 'YEARLY' | 'MONTHLY';

/**
 * One hook for the whole Gift Notes cluster state. Returns the inline names
 * so MiniApp.tsx can destructure without renaming any consumer call site.
 *
 * Note: `gnOccasions` and `gnViewingOccasion` are typed `any[]`/`any` to
 * preserve the exact behaviour of the original inline `useState<any[]>(...)`
 * declarations — consumers access `.status`, `.id`, `.daysUntil`, etc.
 * without DTO types. Tightening to a proper `GnOccasion` interface is a
 * follow-up that requires updating every read site in lock-step.
 */
export function useGiftNotesState() {
  const [gnAccess, setGnAccess] = useState<GnAccess>({
    unlocked: false,
    unlockType: null,
    priceXtr: 19,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [gnOccasions, setGnOccasions] = useState<any[]>([]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [gnViewingOccasion, setGnViewingOccasion] = useState<any>(null);
  const [gnLoading, setGnLoading] = useState(false);

  const [gnSeenBadge, setGnSeenBadge] = useState<boolean>(() => {
    try {
      return typeof window !== 'undefined'
        && window.localStorage.getItem('seen_event_calendar_v1') === '1';
    } catch {
      return false;
    }
  });

  const [showGnCreateOccasion, setShowGnCreateOccasion] = useState(false);
  const [showGnAddIdea, setShowGnAddIdea] = useState(false);

  // Create-occasion form state
  const [gnFormTitle, setGnFormTitle] = useState('');
  const [gnFormDate, setGnFormDate] = useState('');
  const [gnFormType, setGnFormType] = useState<GnFormType>('BIRTHDAY');
  const [gnFormRecurrence, setGnFormRecurrence] = useState<GnFormRecurrence>('YEARLY');
  const [gnFormPerson, setGnFormPerson] = useState('');

  // Add-idea form state
  const [gnIdeaText, setGnIdeaText] = useState('');
  const [gnIdeaLink, setGnIdeaLink] = useState('');

  // Occasion-detail action / edit state (must live at top scope, not inside
  // the screen IIFE, or the open-state would reset on every render).
  const [gnShowActions, setGnShowActions] = useState(false);
  const [gnShowEdit, setGnShowEdit] = useState(false);
  const [gnEditTitle, setGnEditTitle] = useState('');
  const [gnEditPerson, setGnEditPerson] = useState('');
  const [gnEditNote, setGnEditNote] = useState('');

  return {
    // Access (paywall) + collection
    gnAccess, setGnAccess,
    gnOccasions, setGnOccasions,
    gnViewingOccasion, setGnViewingOccasion,
    gnLoading, setGnLoading,
    gnSeenBadge, setGnSeenBadge,
    // Sheet toggles
    showGnCreateOccasion, setShowGnCreateOccasion,
    showGnAddIdea, setShowGnAddIdea,
    // Create-occasion form
    gnFormTitle, setGnFormTitle,
    gnFormDate, setGnFormDate,
    gnFormType, setGnFormType,
    gnFormRecurrence, setGnFormRecurrence,
    gnFormPerson, setGnFormPerson,
    // Add-idea form
    gnIdeaText, setGnIdeaText,
    gnIdeaLink, setGnIdeaLink,
    // Occasion-detail action / edit
    gnShowActions, setGnShowActions,
    gnShowEdit, setGnShowEdit,
    gnEditTitle, setGnEditTitle,
    gnEditPerson, setGnEditPerson,
    gnEditNote, setGnEditNote,
  };
}

export type GiftNotesState = ReturnType<typeof useGiftNotesState>;
