// useReferralState — F7 cluster-hook for the referral program.
//
// Extracted from MiniApp.tsx as part of the F7 hook graph cleanup. Lands
// AFTER the matching Root file (ReferralRoot.tsx, F4 Wave A++) — the Root
// already consumes these fields via the `referralRootCtx` bag.
//
// The cluster owns 9 state cells:
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
// MiniAppInner — promoted to module exports here so callers (loaders,
// ProUpsellSheet, ReferralRoot ctx) can annotate without re-declaring.

'use client';

import { useState } from 'react';

/** Matches GET /tg/referral/me response shape (apps/api/src/index.ts). */
export type ReferralMe = {
  enabled: boolean;
  programEnabled: boolean;
  inRollout: boolean;
  rolloutPercent: number;
  code: string | null;
  link: string | null;
  shareText: string | null;
  stats: {
    totalAttributions: number;
    successful: number;
    pendingActivation: number;
    qualified: number;
    rewarded: number;
    pendingReview: number;
    rejected: number;
  };
  caps: {
    monthlyUsed: number;
    monthlyCap: number;
    yearlyUsed: number;
    yearlyCap: number;
    atMonthlyCap: boolean;
    atYearlyCap: boolean;
  };
  reward: { daysPerRef: number; strategy: string };
  attributedByInviter: {
    status: 'success' | 'not_credited' | 'pending';
    attributedAt: string;
    qualifiedAt: string | null;
    rewardedAt: string | null;
  } | null;
  proExpiryAt: string | null;
  configVersion: string;
};

/** Matches GET /tg/referral/history response item shape. */
export type ReferralHistoryItem = {
  id: string;
  status: 'ATTRIBUTED' | 'PENDING_ACTIVATION' | 'QUALIFIED' | 'REWARDED' | 'REJECTED' | 'FRAUD_REVIEW';
  rejectReason: string | null;
  attributedAt: string;
  qualifiedAt: string | null;
  rewardedAt: string | null;
  rejectedAt: string | null;
  invitedDisplayName: string | null;
  progress: { firstBotStart: boolean; firstWishlist: boolean; firstItem: boolean };
  reward: { id: string; days: number; grantedAt: string } | null;
};

/** GET /tg/referral/history response wrapper (cursor-paged). */
export type ReferralHistoryPage = {
  items: ReferralHistoryItem[];
  nextBefore: string | null;
  limit: number;
};

/**
 * Minimal config subset from GET /tg/referral/rules-config. Loaded once at
 * app init and used by entry-points (paywall alt CTA, home banner,
 * post-share) to decide whether to render without hitting /me — that
 * endpoint has wider response and side-effects (may allocate a code).
 * rules-config is HTTP-cached for 60s so browsers reuse it across
 * entry-point renders in the same session.
 */
export type ReferralRulesConfig = {
  enabled: boolean;
  inRollout: boolean;
  rolloutPercent: number;
  reward: { daysPerRef: number; strategy: string };
  qualification: { requireWishlist: boolean; requireItem: boolean; windowDays: number };
  caps: { monthly: number; yearly: number };
  ui: {
    showInviteeNamesInUi: boolean;
    entryPointProfile: boolean;
    entryPointPaywall: boolean;
    entryPointHomeBanner: boolean;
  };
  configVersion: string;
};

/**
 * One hook for the referral cluster state (~9 useState calls collapsed
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
