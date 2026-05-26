// useProfileState — F7 cluster-hook for the Profile screen.
//
// Extracted from MiniApp.tsx as part of the F7 hook graph cleanup. Lands
// AFTER the matching Root file (ProfileRoot.tsx, F4 Wave D-4) — the Root
// already consumes these fields via the `profileRootCtx` bag.
//
// The cluster owns ~13 state cells split across 3 sub-clusters:
//
//   1. Server-fetched profile (read by Profile screen + Settings +
//      Public-profile + Group-gift + Showcase + etc.):
//        - profileData
//        - profileStats
//        - profileLoading
//
//   2. Profile edit-form (read by the EditProfile BottomSheet that lives
//      INSIDE MiniApp.tsx, not in ProfileRoot — but the form fields are
//      seeded by the Profile screen on "Edit" tap, so they're profile-
//      cluster-owned in spirit):
//        - editingProfile (sheet open/close)
//        - editProfileName / editProfileUsername / editProfileBio /
//          editProfileBirthday (form fields)
//        - editProfileSaving (in-flight guard)
//        - bioTextareaRef (auto-grow textarea ref)
//
//   3. Avatar upload (read by the Avatar BottomSheet inside MiniApp.tsx):
//        - avatarInputRef (hidden file input)
//        - showAvatarSheet (sheet open/close)
//        - avatarUploading (in-flight guard)
//
// What is NOT in this hook (intentionally — owned by sibling clusters):
//   - planInfo, subscription, proSource, promoPro — billing/plan domain;
//     cross-cluster (paywall gating, conditional rendering, ~50+ refs).
//   - birthdaySettings, birthdayMutedList, birthdayContext,
//     birthdayOptInOpen — birthday-reminders cluster (sibling).
//   - profileSubs, profileSubsLoading — outgoing subscriptions list,
//     owned by my-subscriptions surface.
//   - publicProfile* — separate cluster (extracted to
//     usePublicProfileState, F7).
//
// The 2 inline anonymous useState shapes (ProfileData, ProfileStats) are
// promoted to module exports so MiniApp.tsx + ProfileRoot can annotate
// without re-declaring.

'use client';

import { useRef, useState } from 'react';

/**
 * Server-fetched profile object. Mirrors GET /tg/me/profile response
 * shape (apps/api/src/index.ts). Used by Profile screen + Settings +
 * EditProfile sheet + sibling cluster references.
 */
export type ProfileData = {
  displayName: string | null;
  username: string | null;
  bio: string | null;
  avatarUrl: string | null;
  avatarThumbUrl: string | null;
  avatarUpdatedAt: string | null;
  avatarPublic: boolean;
  birthday: string | null;
  hideYear: boolean;
  defaultCurrency: 'RUB' | 'USD';
};

/**
 * Profile usage stats shown on the Profile screen "by the numbers" block.
 * Loaded alongside profileData via GET /tg/me/profile.
 */
export type ProfileStats = {
  wishlists: number; wishlistsLimit: number;
  totalWishes: number; wishesLimit: number;
  reservedByMe: number; archived: number;
};

/**
 * One hook for the Profile cluster state (~13 useState calls + 2 refs
 * collapsed into one). Returns the inline names so MiniApp.tsx +
 * ProfileRoot can destructure without renaming any consumer call site.
 *
 * State cells (3 sub-clusters):
 *   - Server-fetched: profileData / profileStats / profileLoading.
 *   - Edit-form: editingProfile + 4 form fields + saving + bioTextareaRef.
 *   - Avatar: avatarInputRef + showAvatarSheet + avatarUploading.
 */
export function useProfileState() {
  // ── Server-fetched profile ───────────────────────────────────────────
  const [profileData, setProfileData] = useState<ProfileData | null>(null);
  const [profileStats, setProfileStats] = useState<ProfileStats | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);

  // ── Profile edit-form (seeded by Profile screen, sheet lives in MiniApp.tsx) ──
  const [editingProfile, setEditingProfile] = useState(false);
  const [editProfileName, setEditProfileName] = useState('');
  const [editProfileUsername, setEditProfileUsername] = useState('');
  const [editProfileBio, setEditProfileBio] = useState('');
  const [editProfileBirthday, setEditProfileBirthday] = useState('');
  const [editProfileSaving, setEditProfileSaving] = useState(false);
  const bioTextareaRef = useRef<HTMLTextAreaElement>(null);

  // ── Avatar upload (sheet lives in MiniApp.tsx) ───────────────────────
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [showAvatarSheet, setShowAvatarSheet] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);

  return {
    // server-fetched
    profileData, setProfileData,
    profileStats, setProfileStats,
    profileLoading, setProfileLoading,
    // edit-form
    editingProfile, setEditingProfile,
    editProfileName, setEditProfileName,
    editProfileUsername, setEditProfileUsername,
    editProfileBio, setEditProfileBio,
    editProfileBirthday, setEditProfileBirthday,
    editProfileSaving, setEditProfileSaving,
    bioTextareaRef,
    // avatar
    avatarInputRef,
    showAvatarSheet, setShowAvatarSheet,
    avatarUploading, setAvatarUploading,
  };
}

export type ProfileState = ReturnType<typeof useProfileState>;
