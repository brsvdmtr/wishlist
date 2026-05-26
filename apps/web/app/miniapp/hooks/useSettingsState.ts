// useSettingsState — F7 cluster-hook for Settings.
//
// Extracted from MiniApp.tsx as part of the F7 hook graph cleanup. Unlike
// the F4 wave hooks (useSantaState / useGiftNotesState / useShowcaseState /
// useGroupGiftState) that were extracted BEFORE their Root files landed,
// this one extracts AFTER — SettingsRoot already exists and consumes these
// fields via the `settingsRootCtx` bag.
//
// Settings is small (~3 state cells owned by the cluster):
//   - cardDisplayMode (also read by my-wishlists card rendering, hence shared)
//   - settingsData (also read by sibling sheets in MiniApp.tsx: language /
//     visibility / subscribe-policy / etc.)
//   - settingsLoading
//
// Because the state is read by sibling code that stays in MiniApp.tsx, the
// hook returns the SAME names — MiniApp.tsx destructures, SettingsRoot also
// destructures via `ctx`, both reference the same React state cells under
// the hood. No state-leakage; ctx bag just gets lighter when MiniApp can
// drop the `settingsData / settingsLoading` fields (still keeps
// `cardDisplayMode` + `setCardDisplayMode` because Settings owns those
// in the cluster sense).
//
// `SettingsData` was an inline `type` inside MiniAppInner — now exported
// from this module so MiniApp.tsx and SettingsRoot.tsx can import it
// alongside the hook.

'use client';

import { useState } from 'react';
import type { Locale } from '@wishlist/shared';

/**
 * Settings payload returned by `GET /tg/settings` and PATCHed back via
 * `/tg/settings/patch`. Was inline in MiniAppInner — promoted to a module
 * export so consumers can annotate without re-declaring.
 */
export type SettingsData = {
  // Language — resolveEffectiveLocale model
  languageMode: 'auto' | 'manual';
  manualLanguage: Locale | null;
  effectiveLanguage: Locale;
  defaultCurrency: 'RUB' | 'USD';
  notifications: { comments: boolean; reservations: boolean; subscriptions: boolean; marketing: boolean };
  privacy: { profileVisibility: string; subscribePolicy: string; commentsEnabled: boolean; hintsEnabled: boolean };
  appBehavior: { newWishlistPosition: string; cardDisplayMode?: string };
  appearance?: { theme: 'dark' | 'black'; accent: 'violet' | 'blue' | 'pink' | 'green' };
  isPro: boolean;
  supportId?: string | null;
};

/**
 * One hook for the Settings cluster state (~3 useState calls collapsed
 * into one). Returns the inline names so MiniApp.tsx + SettingsRoot can
 * destructure without renaming any consumer call site.
 *
 * State cells:
 *   - `cardDisplayMode` — display mode for wishlist cards on my-wishlists
 *     (also read by my-wishlists render path).
 *   - `settingsData` — server-fetched settings payload (read by Settings
 *     screen AND by sibling sheets: language picker, visibility chooser,
 *     subscribe-policy chooser, comments-default chooser).
 *   - `settingsLoading` — single-flight guard for the initial fetch.
 */
export function useSettingsState() {
  const [cardDisplayMode, setCardDisplayMode] = useState<string>('auto');
  const [settingsData, setSettingsData] = useState<SettingsData | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);

  return {
    cardDisplayMode, setCardDisplayMode,
    settingsData, setSettingsData,
    settingsLoading, setSettingsLoading,
  };
}

export type SettingsState = ReturnType<typeof useSettingsState>;
