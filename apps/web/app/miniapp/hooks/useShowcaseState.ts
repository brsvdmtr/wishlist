// useShowcaseState — F3 cluster-hook for the public Showcase editor.
//
// Extracted from MiniApp.tsx (was lines 4035..4057). The hook returns the
// SAME names that lived inline — MiniApp.tsx just destructures everything
// in one statement, so consumer sites stay byte-identical (no rename storm
// across the showcase-editor + showcase-preview JSX blocks).
//
// This unlocks the F4 Wave D-2 extraction: the lazy ShowcaseRoot screen
// can import the same hook directly instead of receiving 17 props each.
//
// State surface is tightly typed — `showcaseData: ShowcaseData | null`,
// `showcaseAvailableWishlists: ShowcaseAvailableWishlist[]`, etc. The F4
// follow-up tightening pass cleaned up the remaining `any` slots.

'use client';

import { useState, useRef } from 'react';

export type ShowcaseData = {
  enabled: boolean;
  coverUrl: string | null;
  bio: string | null;
  pinnedIds: string[];
  preferences: string | null;
  sizes: {
    clothing: string | null; shoes: string | null; ring: string | null; other: string | null;
    chest: string | null; waist: string | null; hips: string | null;
  };
  brands: string[];
  updatedAt: string | null;
};

export type ShowcaseAvailableWishlist = {
  id: string;
  slug: string;
  title: string;
  itemCount: number;
};

/**
 * One hook for the whole Showcase editor cluster state. Returns the inline
 * names so MiniApp.tsx can destructure without renaming any consumer call
 * site.
 *
 * Owned vs read:
 * - OWNED: showcaseData, showcaseAvailableWishlists, showcaseLoading,
 *   showcaseSaving, showcaseCoverUploading, showcasePublished,
 *   showcaseBrandInput, showcaseCoverRemoveConfirm, showcaseCoverInputRef.
 * - READ FROM ELSEWHERE: dontGiftData (settings cluster), profileData
 *   (profile cluster), planInfo (top-level). Those stay in MiniApp.tsx
 *   and flow into the ShowcaseRoot via the ctx bag.
 */
export function useShowcaseState() {
  const [showcaseData, setShowcaseData] = useState<ShowcaseData | null>(null);
  const [showcaseAvailableWishlists, setShowcaseAvailableWishlists] = useState<ShowcaseAvailableWishlist[]>([]);
  const [showcaseLoading, setShowcaseLoading] = useState(false);
  const [showcaseSaving, setShowcaseSaving] = useState(false);
  const [showcaseCoverUploading, setShowcaseCoverUploading] = useState(false);
  const [showcasePublished, setShowcasePublished] = useState(false);
  const [showcaseBrandInput, setShowcaseBrandInput] = useState('');
  const [showcaseCoverRemoveConfirm, setShowcaseCoverRemoveConfirm] = useState(false);
  const showcaseCoverInputRef = useRef<HTMLInputElement>(null);

  return {
    showcaseData, setShowcaseData,
    showcaseAvailableWishlists, setShowcaseAvailableWishlists,
    showcaseLoading, setShowcaseLoading,
    showcaseSaving, setShowcaseSaving,
    showcaseCoverUploading, setShowcaseCoverUploading,
    showcasePublished, setShowcasePublished,
    showcaseBrandInput, setShowcaseBrandInput,
    showcaseCoverRemoveConfirm, setShowcaseCoverRemoveConfirm,
    showcaseCoverInputRef,
  };
}

export type ShowcaseState = ReturnType<typeof useShowcaseState>;
