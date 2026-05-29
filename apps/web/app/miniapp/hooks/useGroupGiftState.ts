// useGroupGiftState — F3 cluster-hook for the Group Gift feature.
//
// Extracted from MiniApp.tsx (was lines ~4109..4142 + the ggAccess
// useState near 4515). The hook returns the SAME names that lived
// inline — MiniApp.tsx just destructures everything in one statement,
// so consumer sites stay byte-identical (no rename across the 5
// group-gift-* JSX blocks + the loaders that mutate `groupGiftData` /
// `groupGiftMessages` / `groupGiftJoinToken`).
//
// This unlocks the F4 Wave D-3 extraction: the lazy GroupGiftRoot
// screens import the same hook indirectly (via the ctx bag).
//
// State surface is tightly typed — `groupGiftData: GroupGiftData | null`,
// `groupGiftMessages: GroupGiftMessage[]`, and the rest carry concrete
// shapes lifted from the inline useState forms. The F4 follow-up tightening
// pass cleaned up the remaining `any` slots.

'use client';

import { useState, useRef } from 'react';

export type GroupGiftData = {
  id: string; itemId: string;
  item: { id: string; title: string; imageUrl: string | null; price: number | null; currency: string; wishlistId: string };
  organizerUserId: string; organizerName: string; organizerAvatarUrl: string | null;
  targetAmount: number; currency: string; deadline: string | null;
  note: string | null; pinnedInfo: string | null; status: string;
  inviteToken: string; collectedAmount: number; participantCount: number;
  progressPct: number; remaining: number;
  isOrganizer: boolean; isParticipant: boolean;
  participants: Array<{
    id: string; userId: string; displayName: string; avatarUrl: string | null;
    joinedAt: string; isOrganizer: boolean; isSelf: boolean; amount: number | null;
  }>;
  completedAt: string | null; cancelledAt: string | null; createdAt: string;
};

export type GroupGiftCreateItem = {
  title: string; imageUrl: string | null; price: number | null; currency: string;
};

export type GroupGiftMessage = {
  id: string; text: string; type: string; createdAt: string;
  senderId: string; senderName: string; senderAvatarUrl: string | null; isSelf: boolean;
};

// `priceVariant` carries the E24 `group-gift-price` experiment bucket for the
// user (control 79 / treatment 39). The Mini App tags its paywall-impression
// event with it; absent (older payloads / SSR default) → treated as control.
export type GgAccess = { unlocked: boolean; priceXtr: number; priceVariant?: 'control' | 'treatment' };

/**
 * One hook for the whole Group Gift cluster state. Returns the inline
 * names so MiniApp.tsx can destructure without renaming any consumer
 * call site.
 *
 * Owned:
 * - groupGiftData / groupGiftCreateItem(Id) / groupGiftMessages /
 *   groupGiftJoinToken (server-state caches)
 * - gg* form fields (target amount, deadline, note, my-amount, join-amt,
 *   chat msg, plus saving/sending flags)
 * - ggMessagesEndRef (scroll-into-view ref)
 * - ggAccess (paywall entitlement — fetched by sync endpoint)
 *
 * Read from elsewhere (not owned): viewingItem (modal target),
 * profileData (for self avatar), planInfo (PRO gate elsewhere).
 */
export function useGroupGiftState() {
  const [groupGiftData, setGroupGiftData] = useState<GroupGiftData | null>(null);
  const [groupGiftCreateItemId, setGroupGiftCreateItemId] = useState<string | null>(null);
  const [groupGiftCreateItem, setGroupGiftCreateItem] = useState<GroupGiftCreateItem | null>(null);
  const [groupGiftMessages, setGroupGiftMessages] = useState<GroupGiftMessage[]>([]);
  const [groupGiftJoinToken, setGroupGiftJoinToken] = useState<string | null>(null);

  // Group Gift form state (hoisted to avoid conditional hook calls
  // when the create/join screens mount/unmount).
  const [ggTargetAmt, setGgTargetAmt] = useState('');
  const [ggDeadline, setGgDeadline] = useState('');
  const [ggNote, setGgNote] = useState('');
  const [ggMyAmount, setGgMyAmount] = useState('');
  const [ggCreating, setGgCreating] = useState(false);
  const [ggJoinAmt, setGgJoinAmt] = useState('');
  const [ggJoining, setGgJoining] = useState(false);
  const [ggChatMsg, setGgChatMsg] = useState('');
  const [ggChatSending, setGgChatSending] = useState(false);
  const ggMessagesEndRef = useRef<HTMLDivElement>(null);

  // Paywall entitlement for the Group Gift feature itself (gated by Stars
  // purchase). The `79` here is only the SSR / pre-bootstrap default and must
  // mirror the CONTROL price (`GROUP_GIFT_PRICE_XTR` in apps/api); the real,
  // bucket-aware price (E24) arrives from the `GET /tg/wishlists` bootstrap
  // (`groupGift.priceXtr` + `priceVariant`) and overwrites this before the
  // paywall screen is ever shown. If "ship the winner" ever changes the
  // control price, update this literal too.
  const [ggAccess, setGgAccess] = useState<GgAccess>({ unlocked: false, priceXtr: 79 });

  return {
    groupGiftData, setGroupGiftData,
    groupGiftCreateItemId, setGroupGiftCreateItemId,
    groupGiftCreateItem, setGroupGiftCreateItem,
    groupGiftMessages, setGroupGiftMessages,
    groupGiftJoinToken, setGroupGiftJoinToken,
    ggTargetAmt, setGgTargetAmt,
    ggDeadline, setGgDeadline,
    ggNote, setGgNote,
    ggMyAmount, setGgMyAmount,
    ggCreating, setGgCreating,
    ggJoinAmt, setGgJoinAmt,
    ggJoining, setGgJoining,
    ggChatMsg, setGgChatMsg,
    ggChatSending, setGgChatSending,
    ggMessagesEndRef,
    ggAccess, setGgAccess,
  };
}

export type GroupGiftState = ReturnType<typeof useGroupGiftState>;
