// useGuestViewState — F3 cluster-hook for the Guest View (public wishlist
// preview) and Guest Item Detail screens.
//
// Extracted from MiniApp.tsx (was a dozen separate `useState` lines spread
// across 3847..4458). The hook returns the SAME names that lived inline —
// MiniAppInner just destructures everything in one statement, so consumer
// call sites (loaders, reservation handlers, ctx bags for sibling Roots)
// stay byte-identical (no rename storm).
//
// This unlocks the F4 Wave E extraction: the lazy GuestViewRoot cluster
// imports the same hook indirectly (via the ctx bag) so the JSX inside
// the chunk can keep referring to `guestWl`, `guestItems`, etc. by name.
//
// State surface is tightly typed — `guestWl: GuestWishlist | null`,
// `guestItems: GuestItem[]`, `guestCategories: WishlistCategory[]`, etc.
// All DTOs imported from MiniApp.tsx or declared locally (GuestWishlist,
// GuestDontGift) when hook-scoped. Zero `any` slots remain.
//
// Owned vs read:
// - OWNED here: guestWl, guestItems, guestCategories, guestCollapsedCats,
//   guestDontGift, guestDontGiftExpanded, guestSubId,
//   guestUnreadEntityIds, guestUnreadItemCounts,
//   guestViewReturnToProfileUsername, guestBudgetMax, guestCustomBudget,
//   guestPriorityFilter, guestSort, guestFilterOpen, draftBudget,
//   draftCustomBudget, draftPriorities.
// - READ FROM ELSEWHERE: birthdayContext / setBirthdayContext (banner
//   reused by public-profile + guest-view) stays in MiniApp.tsx top-level
//   and flows into the GuestViewRoot via the ctx bag; ditto isSubscribed
//   / subscribing / subscriberCount (mutated by handleSubscribe /
//   handleUnsubscribe which live in MiniAppInner).

'use client';

import { useState } from 'react';
import type { GuestItem, GuestSort, WishlistCategory } from '../MiniApp';

/**
 * Shape of the public wishlist returned by `GET /tg/g/:slug` (no auth) —
 * mirrors the inline useState type at MiniApp.tsx:4313. Stays narrow
 * (literal field names + nullability flags) instead of importing the
 * full `Wishlist` DTO because guest payloads are deliberately scrubbed
 * of owner-only fields (visibility, subscriberCount, etc.).
 */
export type GuestWishlist = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  deadline: string | null;
  ownerName: string | null;
  ownerAvatarUrl: string | null;
  ownerUsername: string | null;
  smartReservationsEnabled?: boolean;
  smartResTtlHours?: number;
};

/**
 * Don't-Gift block surfaced to guests — subset of the owner-side
 * `DontGiftData` DTO (no `visible` flag, since guests only ever see the
 * visible-true payload). Matches the inline useState shape at
 * MiniApp.tsx:3860.
 */
export type GuestDontGift = {
  presets: string[];
  customItems: string[];
  comment: string | null;
};

/**
 * One hook for the whole Guest View cluster state. Returns the inline
 * names so MiniApp.tsx can destructure without renaming any consumer
 * call site.
 */
export function useGuestViewState() {
  // ── Wishlist + items (server caches, set by loadGuestWishlist) ───────
  const [guestWl, setGuestWl] = useState<GuestWishlist | null>(null);
  const [guestItems, setGuestItems] = useState<GuestItem[]>([]);

  // ── Categories ────────────────────────────────────────────────────────
  // Guest categories returned alongside items (when the wishlist has
  // user-created categories enabled). `guestCollapsedCats` is a Set of
  // category ids the visitor has collapsed in the UI.
  const [guestCategories, setGuestCategories] = useState<WishlistCategory[]>([]);
  const [guestCollapsedCats, setGuestCollapsedCats] = useState<Set<string>>(new Set());

  // ── Don't-Gift block ──────────────────────────────────────────────────
  const [guestDontGift, setGuestDontGift] = useState<GuestDontGift | null>(null);
  const [guestDontGiftExpanded, setGuestDontGiftExpanded] = useState(false);

  // ── Subscription state (visitor follows the wishlist for updates) ────
  // `guestSubId` is the subscription row id (set on subscribe, cleared on
  // unsubscribe). `isSubscribed` + `subscribing` + `subscriberCount`
  // remain in MiniAppInner since handleSubscribe/handleUnsubscribe
  // mutate them and other top-level effects read them.
  const [guestSubId, setGuestSubId] = useState<string | null>(null);

  // ── Unread highlights ────────────────────────────────────────────────
  // Entity-level (the wishlist itself) and item-level (per-item counters)
  // unread badges sourced from /tg/subscriptions/unread.
  const [guestUnreadEntityIds, setGuestUnreadEntityIds] = useState<string[]>([]);
  const [guestUnreadItemCounts, setGuestUnreadItemCounts] = useState<Record<string, number>>({});

  // ── Return-to-profile tracking ────────────────────────────────────────
  // Remember the profile username we came from so BackButton from
  // guest-view returns there instead of `my-wishlists` (default).
  const [guestViewReturnToProfileUsername, setGuestViewReturnToProfileUsername] = useState<string | null>(null);

  // ── Filter & sort state (applied to guestItems via useMemo) ──────────
  const [guestBudgetMax, setGuestBudgetMax] = useState<number | null>(null);
  const [guestCustomBudget, setGuestCustomBudget] = useState('');
  const [guestPriorityFilter, setGuestPriorityFilter] = useState<number[]>([1, 2, 3]);
  const [guestSort, setGuestSort] = useState<GuestSort>('default');
  const [guestFilterOpen, setGuestFilterOpen] = useState(false);

  // ── Filter sheet draft state ──────────────────────────────────────────
  // Mirror of the applied filter, edited inside the BottomSheet and
  // committed back on "Apply". Reset to current applied values on sheet
  // open (see guest-view JSX onClick handler).
  const [draftBudget, setDraftBudget] = useState<number | null>(null);
  const [draftCustomBudget, setDraftCustomBudget] = useState('');
  const [draftPriorities, setDraftPriorities] = useState<number[]>([1, 2, 3]);

  return {
    guestWl, setGuestWl,
    guestItems, setGuestItems,
    guestCategories, setGuestCategories,
    guestCollapsedCats, setGuestCollapsedCats,
    guestDontGift, setGuestDontGift,
    guestDontGiftExpanded, setGuestDontGiftExpanded,
    guestSubId, setGuestSubId,
    guestUnreadEntityIds, setGuestUnreadEntityIds,
    guestUnreadItemCounts, setGuestUnreadItemCounts,
    guestViewReturnToProfileUsername, setGuestViewReturnToProfileUsername,
    guestBudgetMax, setGuestBudgetMax,
    guestCustomBudget, setGuestCustomBudget,
    guestPriorityFilter, setGuestPriorityFilter,
    guestSort, setGuestSort,
    guestFilterOpen, setGuestFilterOpen,
    draftBudget, setDraftBudget,
    draftCustomBudget, setDraftCustomBudget,
    draftPriorities, setDraftPriorities,
  };
}

export type GuestViewState = ReturnType<typeof useGuestViewState>;
