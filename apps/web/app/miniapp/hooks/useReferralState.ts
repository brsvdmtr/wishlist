// useReferralState — F7 cluster-hook for the referral program.
//
// Extracted from MiniApp.tsx as part of the F7 hook graph cleanup. Lands
// AFTER the matching Root file (ReferralRoot.tsx, F4 Wave A++) — the Root
// already consumes these fields via the `referralRootCtx` bag.
//
// The cluster owns 10 state cells:
//   - referralRulesConfig — minimal entry-point config (loaded once at
//     app init; read by home banner, paywall alt CTA, profile tile,
//     ReferralRoot itself).
//   - referralMe + loading + error — full referral-me payload (loaded
//     when the user opens the referral screen).
//   - referralHistory + cursor + loading + hasMore — paged invitee
//     history (loaded when user opens referral-history sub-screen).
//   - referralShareSheet — share-sheet open/close toggle.
//   - referralRulesOpen — rules-sheet open/close toggle.
//
// Related but NOT in this hook (still inline in MiniApp.tsx) because
// they're owned by non-referral navigation / banner flows:
//   - referralOriginScreen     (entry-point Back navigation)
//   - referralCelebrationOpen  (post-attribution celebration sheet)
//   - referralHomeBannerDismissed (localStorage cooldown for banner)
//
// The 4 inline DTO types (ReferralMe, ReferralHistoryItem,
// ReferralHistoryPage, ReferralRulesConfig) were declared inline in
// MiniAppInner. Three of them (ReferralMe, ReferralHistoryItem,
// ReferralRulesConfig) live at module scope in MiniApp.tsx — imported
// here for the hook's internal annotations. The fourth
// (ReferralHistoryPage) is private to this hook — the history-list
// loader is the only consumer, never crosses the cluster-Root boundary.

'use client';

import { useState } from 'react';
// `ReferralMe` / `ReferralHistoryItem` / `ReferralRulesConfig` are
// canonical in MiniApp.tsx (module-scope DTO block, lifted from inline
// useState shapes in F4 typing). `ReferralHistoryPage` is private to this
// hook — the history-list reducer is the only consumer, never crosses the
// cluster-Root boundary.
import type { ReferralMe, ReferralHistoryItem, ReferralRulesConfig } from '../MiniApp';

/** GET /tg/referral/history response wrapper (cursor-paged). */
export type ReferralHistoryPage = {
  items: ReferralHistoryItem[];
  nextBefore: string | null;
  limit: number;
};

/**
 * One hook for the referral cluster state (10 useState calls collapsed
 * into one). Returns the inline names so MiniApp.tsx + ReferralRoot can
 * destructure without renaming any consumer call site.
 *
 * State cells:
 *   - `referralRulesConfig` — minimal config payload for entry-points.
 *   - `referralMe` + `referralMeLoading` + `referralMeError` — full /me.
 *   - `referralHistory` + `referralHistoryCursor` + loading + hasMore.
 *   - `referralShareSheet` + `referralRulesOpen` — sheet toggles.
 */
export function useReferralState() {
  const [referralRulesConfig, setReferralRulesConfig] = useState<ReferralRulesConfig | null>(null);
  const [referralMe, setReferralMe] = useState<ReferralMe | null>(null);
  const [referralMeLoading, setReferralMeLoading] = useState(false);
  const [referralMeError, setReferralMeError] = useState<string | null>(null);
  const [referralHistory, setReferralHistory] = useState<ReferralHistoryItem[]>([]);
  const [referralHistoryCursor, setReferralHistoryCursor] = useState<string | null>(null);
  const [referralHistoryLoading, setReferralHistoryLoading] = useState(false);
  const [referralHistoryHasMore, setReferralHistoryHasMore] = useState(false);
  const [referralShareSheet, setReferralShareSheet] = useState(false);
  const [referralRulesOpen, setReferralRulesOpen] = useState(false);

  return {
    referralRulesConfig, setReferralRulesConfig,
    referralMe, setReferralMe,
    referralMeLoading, setReferralMeLoading,
    referralMeError, setReferralMeError,
    referralHistory, setReferralHistory,
    referralHistoryCursor, setReferralHistoryCursor,
    referralHistoryLoading, setReferralHistoryLoading,
    referralHistoryHasMore, setReferralHistoryHasMore,
    referralShareSheet, setReferralShareSheet,
    referralRulesOpen, setReferralRulesOpen,
  };
}

export type ReferralState = ReturnType<typeof useReferralState>;
