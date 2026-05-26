// usePublicProfileState — F7 cluster-hook for the public-profile screen.
//
// Extracted from MiniApp.tsx as part of the F7 hook graph cleanup. Like
// useSettingsState (F7), this lands AFTER the matching Root file already
// exists — PublicProfileRoot.tsx (F4 Wave A++) consumes these fields via
// the `publicProfileRootCtx` bag.
//
// Public-profile owns 6 state cells (3 data + 1 username pointer + 2
// subscribe-CTA flags). All are read by sibling helpers in MiniApp.tsx
// (subscribeToProfile / unsubscribeFromProfile / loadGuestWishlist, plus
// the public-profile screen JSX inside PublicProfileRoot), so the hook
// returns the SAME names — MiniApp.tsx destructures, the ctx bag spreads
// `...publicProfileState`, the Root intersects `PublicProfileState`.
//
// The `PublicProfileData` shape was an inline anonymous type at the
// `useState<{...}>` call site — promoted to a named module export so
// callers can annotate without re-declaring.

'use client';

import { useState } from 'react';
// `PublicProfileData` is canonical in MiniApp.tsx (module-scope DTO block,
// lifted from inline useState shape in F4 typing). Single source of truth
// for the GET /tg/public-profile/:username response shape.
import type { PublicProfileData } from '../MiniApp';

/**
 * One hook for the public-profile cluster state (~6 useState calls
 * collapsed into one). Returns the inline names so MiniApp.tsx +
 * PublicProfileRoot can destructure without renaming any consumer.
 *
 * State cells:
 *   - `publicProfileUsername` — the username currently being viewed.
 *   - `publicProfileData` — server payload (profile, wishlists, showcase).
 *   - `publicProfileLoading` — single-flight guard during fetch.
 *   - `publicProfileError` — 'not_found' | 'error' | null.
 *   - `publicProfileSubscribed` — am-I-subscribed-to-this-user cache.
 *   - `publicProfileSubInFlight` — disables the subscribe CTA during
 *     the subscribe/unsubscribe round-trip.
 */
export function usePublicProfileState() {
  const [publicProfileUsername, setPublicProfileUsername] = useState<string | null>(null);
  const [publicProfileData, setPublicProfileData] = useState<PublicProfileData | null>(null);
  const [publicProfileLoading, setPublicProfileLoading] = useState(false);
  const [publicProfileError, setPublicProfileError] = useState<string | null>(null);
  const [publicProfileSubscribed, setPublicProfileSubscribed] = useState(false);
  const [publicProfileSubInFlight, setPublicProfileSubInFlight] = useState(false);

  return {
    publicProfileUsername, setPublicProfileUsername,
    publicProfileData, setPublicProfileData,
    publicProfileLoading, setPublicProfileLoading,
    publicProfileError, setPublicProfileError,
    publicProfileSubscribed, setPublicProfileSubscribed,
    publicProfileSubInFlight, setPublicProfileSubInFlight,
  };
}

export type PublicProfileState = ReturnType<typeof usePublicProfileState>;
