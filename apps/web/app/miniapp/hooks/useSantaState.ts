// useSantaState — F3 cluster-hook for Santa (Secret Santa campaigns).
//
// Extracted from MiniApp.tsx as the precondition for the F4 Wave B
// SantaRoot extraction (9 screens, ~3.3k LOC). Like useGiftNotesState,
// this hook returns the SAME names that lived inline — MiniApp.tsx
// destructures everything in one statement, so consumer call sites
// (~100+ references across the file) stay byte-identical.
//
// Types co-located inside this file because they're only consumed by
// the Santa cluster (ChatMessage, Poll, OrganizerSummary, ExclusionPair,
// ExclusionGroup). The DTO types defined earlier in MiniApp.tsx
// (SantaCampaignSummary, SantaCampaignDetail, SantaJoinPreview,
// SantaReservationItem, Item) stay where they are — they're shared
// across the wider app surface.

'use client';

import { useState, useRef } from 'react';

// Type-only import from MiniApp.tsx. This is a type-level circular
// reference (MiniApp.tsx → hooks/useSantaState.ts → MiniApp.tsx) which
// TypeScript handles fine because type imports erase at runtime.
import type {
  SantaCampaignSummary,
  SantaCampaignDetail,
  SantaJoinPreview,
  SantaReservationItem,
} from '../MiniApp';

// ── Santa cluster-only types ──────────────────────────────────────────────

export type ChatMessage = {
  id: string;
  messageType: 'USER' | 'SYSTEM';
  body: string;
  systemEvent: string | null;
  payload: Record<string, string> | null;
  sender: {
    displayName: string;
    avatarUrl: null;
    emoji: string | null;
    adjectiveKey: string | null;
    animalKey: string | null;
    isMe: boolean;
  } | null;
  createdAt: string;
};

export type PollResult = {
  optionIndex: number;
  count: number;
  percentage: number;
  voters: { displayName: string; emoji: string | null }[] | null;
};

export type Poll = {
  id: string;
  question: string;
  options: string[];
  isAnonymous: boolean;
  createdAt: string;
  deadlineAt: string | null;
  closedAt: string | null;
  isOpen: boolean;
  myVote: number | null;
  results: PollResult[];
};

export type OrganizerSummary = {
  campaign: { status: string; currentRoundId: string | null; drawAt: string | null };
  participants: Array<{
    id: string; userId: string; status: string; role: string;
    joinedAt: string; leftAt: string | null; displayName: string;
    emoji: string | null; adjectiveKey: string | null; animalKey: string | null;
    avatarUrl: null; hasLinkedWishlist: boolean;
  }>;
  giftProgress: {
    pending: number; buying: number; selectedFromWishlist: number; selectedOutside: number;
    declinedToSay: number; sent: number; received: number; missedDeadline: number; orphaned: number;
  } | null;
  pendingExitRequests: Array<{
    id: string; participantId: string; userId: string; displayName: string;
    emoji: string | null; adjectiveKey: string | null; animalKey: string | null;
    avatarUrl: null; reason: string | null; createdAt: string;
  }>;
};

export type ExclusionPair = {
  id: string; userId1: string; name1: string; userId2: string; name2: string;
};
export type ExclusionGroup = {
  id: string; label: string; activeCount: number;
  members: {
    userId: string; displayName: string;
    emoji: string | null; adjectiveKey: string | null; animalKey: string | null;
    avatarUrl: null; isStale: boolean;
  }[];
};

export type SantaReceiverWishlist = {
  role: 'giver';
  giftStatus: string;
  giftNote: string | null;
  receiver: { displayName: string; avatarUrl: string | null };
  wishlist: { title: string } | null;
  items: {
    id: string; title: string; url: string | null; priceText: string | null;
    currency: string; priority: number; imageUrl: string | null;
    status: string; reservedByMe: boolean;
  }[];
  myReservations: { id: string; title: string }[];
};

export type SantaInboundStatus = {
  hasGiver: boolean;
  signal: 'waiting' | 'in_progress' | 'ready' | 'received';
  canConfirmReceived: boolean;
  canReveal: boolean;
  revealedAt: string | null;
};

export type SantaDrawValidation = {
  feasible: boolean;
  participantCount?: number;
  reason?: string;
  problematicExclusions?: {
    userId1: string; name1: string;
    userId2: string; name2: string;
    groupLabel?: string | null;
  }[];
};

export type SantaReveal = {
  revealed: boolean;
  isFirstReveal?: boolean;
  giver?: {
    displayName: string; avatarUrl: null;
    emoji: string; adjectiveKey: string; animalKey: string;
  };
  giftNote?: string | null;
  revealedAt?: string;
};

export type SantaHintRequest = {
  id: string; status: string;
  requestedAt: string; expiresAt: string; fulfilledAt: string | null;
  selectedItems: {
    id: string; title: string; priceText: string | null; url: string | null;
  }[] | null;
};

export type SantaHintInbound = {
  hasPendingHint: boolean;
  hint: { id: string; status: string; requestedAt: string; expiresAt: string } | null;
};

export type SantaDetailContext = {
  source: 'reservation' | 'receiver-wishlist';
  campaignId: string;
  campaignTitle: string;
  campaignStatus: string;
  giftStatus: string;
};

/**
 * One hook for the whole Santa cluster state (~50 useState calls collapsed
 * into one). Returns the inline names so MiniApp.tsx can destructure without
 * renaming any consumer call site (~100+ references).
 */
export function useSantaState() {
  // ── Test mode (admin) ──────────────────────────────────────────────────
  const [santaTestModeLoading, setSantaTestModeLoading] = useState(false);

  // ── Detail context (deep-link entry) ──────────────────────────────────
  const [santaDetailContext, setSantaDetailContext] = useState<SantaDetailContext | null>(null);

  // ── Reservations under Santa surface ──────────────────────────────────
  const [santaReservationItems, setSantaReservationItems] = useState<SantaReservationItem[]>([]);
  const [santaReservationItemsLoading, setSantaReservationItemsLoading] = useState(false);

  // ── Season + campaigns ─────────────────────────────────────────────────
  const [santaSeason, setSantaSeason] = useState<{
    inSeason: boolean; canCreate: boolean;
    seasonStart: string | null; seasonEnd: string | null; testMode: boolean;
  } | null>(null);
  const [santaCampaigns, setSantaCampaigns] = useState<{
    owned: SantaCampaignSummary[]; joined: SantaCampaignSummary[];
  }>({ owned: [], joined: [] });
  const [santaCampaignsLoading, setSantaCampaignsLoading] = useState(false);
  const [currentSantaCampaign, setCurrentSantaCampaign] = useState<SantaCampaignDetail | null>(null);

  // ── Create form ────────────────────────────────────────────────────────
  const [santaCreateLoading, setSantaCreateLoading] = useState(false);
  const [santaCreateTitle, setSantaCreateTitle] = useState('');
  const [santaCreateDesc, setSantaCreateDesc] = useState('');
  const [santaCreateMinBudget, setSantaCreateMinBudget] = useState('');
  const [santaCreateMaxBudget, setSantaCreateMaxBudget] = useState('');
  const [santaCreateCurrency, setSantaCreateCurrency] = useState<'RUB' | 'USD'>('RUB');
  const [santaCreateType, setSantaCreateType] = useState<'CLASSIC' | 'MULTI_WAVE'>('CLASSIC');

  // ── Join (deep link) ───────────────────────────────────────────────────
  const [santaJoinToken, setSantaJoinToken] = useState<string | null>(null);
  const [santaJoinPreview, setSantaJoinPreview] = useState<SantaJoinPreview | null>(null);
  const [santaJoinLoading, setSantaJoinLoading] = useState(false);
  const [santaJoinDone, setSantaJoinDone] = useState(false);

  // ── Link wishlist picker ───────────────────────────────────────────────
  const [showSantaWishlistPicker, setShowSantaWishlistPicker] = useState(false);
  const [santaWishlistPickerLoading, setSantaWishlistPickerLoading] = useState(false);
  const [santaWishlistPickerReturnId, setSantaWishlistPickerReturnId] = useState<string | null>(null);

  // ── Receiver wishlist (giver view) ────────────────────────────────────
  const [santaReceiverWishlist, setSantaReceiverWishlist] = useState<SantaReceiverWishlist | null>(null);
  const [santaReceiverWishlistLoading, setSantaReceiverWishlistLoading] = useState(false);
  const [santaWishlistReservingId, setSantaWishlistReservingId] = useState<string | null>(null);
  const [santaSwitchModalOpen, setSantaSwitchModalOpen] = useState(false);

  // ── Inbound status (receiver side) ────────────────────────────────────
  const [santaInboundStatus, setSantaInboundStatus] = useState<SantaInboundStatus | null>(null);
  const [santaInboundLoading, setSantaInboundLoading] = useState(false);

  // ── Draw ───────────────────────────────────────────────────────────────
  const [santaDrawLoading, setSantaDrawLoading] = useState(false);
  const [santaDrawValidation, setSantaDrawValidation] = useState<SantaDrawValidation | null>(null);
  const [santaDrawValidationLoading, setSantaDrawValidationLoading] = useState(false);

  // ── Reveal ─────────────────────────────────────────────────────────────
  const [santaReveal, setSantaReveal] = useState<SantaReveal | null>(null);
  const [santaRevealLoading, setSantaRevealLoading] = useState(false);

  // ── Hints (Batch 2.5) ──────────────────────────────────────────────────
  const [santaHintRequest, setSantaHintRequest] = useState<SantaHintRequest | null>(null);
  const [santaHintRequestLoading, setSantaHintRequestLoading] = useState(false);
  const [santaHintInbound, setSantaHintInbound] = useState<SantaHintInbound | null>(null);
  const [santaHintInboundLoading, setSantaHintInboundLoading] = useState(false);
  const [santaHintPickerOpen, setSantaHintPickerOpen] = useState(false);
  const [santaHintPickerItems, setSantaHintPickerItems] = useState<{
    id: string; title: string; priceText: string | null;
  }[]>([]);
  const [santaHintPickerSelectedIds, setSantaHintPickerSelectedIds] = useState<string[]>([]);
  const [santaHintFulfillLoading, setSantaHintFulfillLoading] = useState(false);

  // ── Chat (Batch 4.1) ───────────────────────────────────────────────────
  const [santaChatMessages, setSantaChatMessages] = useState<ChatMessage[]>([]);
  const [santaChatHasMore, setSantaChatHasMore] = useState(false);
  const [santaChatLoading, setSantaChatLoading] = useState(false);
  const [santaChatInput, setSantaChatInput] = useState('');
  const [santaChatSending, setSantaChatSending] = useState(false);
  const [santaChatIsMuted, setSantaChatIsMuted] = useState(false);
  // Per-message Idempotency-Key nonce. Cleared on success; stays on
  // transient failure so retry hits the server's replay branch.
  const santaChatSendNonceRef = useRef<string>('');

  // ── Polls (Batch 4.2) ──────────────────────────────────────────────────
  const [santaPolls, setSantaPolls] = useState<Poll[]>([]);
  const [santaPollsLoading, setSantaPollsLoading] = useState(false);
  const [santaPollCreateOpen, setSantaPollCreateOpen] = useState(false);
  const [santaPollCreateQuestion, setSantaPollCreateQuestion] = useState('');
  const [santaPollCreateOptions, setSantaPollCreateOptions] = useState<string[]>(['', '']);
  const [santaPollCreateAnonymous, setSantaPollCreateAnonymous] = useState(false);
  const [santaPollCreateSubmitting, setSantaPollCreateSubmitting] = useState(false);

  // ── Organizer panel (Batch 5.3) ───────────────────────────────────────
  const [santaOrganizerSummary, setSantaOrganizerSummary] = useState<OrganizerSummary | null>(null);
  const [santaOrganizerLoading, setSantaOrganizerLoading] = useState(false);
  const [santaExitRequestSheetOpen, setSantaExitRequestSheetOpen] = useState(false);
  const [santaExitRequestReason, setSantaExitRequestReason] = useState('');
  const [santaExitRequestSubmitting, setSantaExitRequestSubmitting] = useState(false);

  // ── Exclusions (Batch 5.1) ────────────────────────────────────────────
  const [santaExclPairs, setSantaExclPairs] = useState<ExclusionPair[]>([]);
  const [santaExclGroups, setSantaExclGroups] = useState<ExclusionGroup[]>([]);
  const [santaExclLoading, setSantaExclLoading] = useState(false);
  const [santaExclAddPairOpen, setSantaExclAddPairOpen] = useState(false);
  const [santaExclPairA, setSantaExclPairA] = useState('');
  const [santaExclPairB, setSantaExclPairB] = useState('');
  const [santaExclPairSaving, setSantaExclPairSaving] = useState(false);
  const [santaExclGroupSheetOpen, setSantaExclGroupSheetOpen] = useState(false);
  const [santaExclGroupLabel, setSantaExclGroupLabel] = useState('');
  const [santaExclGroupSaving, setSantaExclGroupSaving] = useState(false);
  const [santaExclAddMemberGroupId, setSantaExclAddMemberGroupId] = useState<string | null>(null);
  const [santaExclAddMemberUserId, setSantaExclAddMemberUserId] = useState('');
  const [santaExclAddMemberSaving, setSantaExclAddMemberSaving] = useState(false);

  return {
    // test mode
    santaTestModeLoading, setSantaTestModeLoading,
    // detail context
    santaDetailContext, setSantaDetailContext,
    // reservations
    santaReservationItems, setSantaReservationItems,
    santaReservationItemsLoading, setSantaReservationItemsLoading,
    // season + campaigns
    santaSeason, setSantaSeason,
    santaCampaigns, setSantaCampaigns,
    santaCampaignsLoading, setSantaCampaignsLoading,
    currentSantaCampaign, setCurrentSantaCampaign,
    // create
    santaCreateLoading, setSantaCreateLoading,
    santaCreateTitle, setSantaCreateTitle,
    santaCreateDesc, setSantaCreateDesc,
    santaCreateMinBudget, setSantaCreateMinBudget,
    santaCreateMaxBudget, setSantaCreateMaxBudget,
    santaCreateCurrency, setSantaCreateCurrency,
    santaCreateType, setSantaCreateType,
    // join
    santaJoinToken, setSantaJoinToken,
    santaJoinPreview, setSantaJoinPreview,
    santaJoinLoading, setSantaJoinLoading,
    santaJoinDone, setSantaJoinDone,
    // wishlist picker
    showSantaWishlistPicker, setShowSantaWishlistPicker,
    santaWishlistPickerLoading, setSantaWishlistPickerLoading,
    santaWishlistPickerReturnId, setSantaWishlistPickerReturnId,
    // receiver wishlist
    santaReceiverWishlist, setSantaReceiverWishlist,
    santaReceiverWishlistLoading, setSantaReceiverWishlistLoading,
    santaWishlistReservingId, setSantaWishlistReservingId,
    santaSwitchModalOpen, setSantaSwitchModalOpen,
    // inbound
    santaInboundStatus, setSantaInboundStatus,
    santaInboundLoading, setSantaInboundLoading,
    // draw
    santaDrawLoading, setSantaDrawLoading,
    santaDrawValidation, setSantaDrawValidation,
    santaDrawValidationLoading, setSantaDrawValidationLoading,
    // reveal
    santaReveal, setSantaReveal,
    santaRevealLoading, setSantaRevealLoading,
    // hints
    santaHintRequest, setSantaHintRequest,
    santaHintRequestLoading, setSantaHintRequestLoading,
    santaHintInbound, setSantaHintInbound,
    santaHintInboundLoading, setSantaHintInboundLoading,
    santaHintPickerOpen, setSantaHintPickerOpen,
    santaHintPickerItems, setSantaHintPickerItems,
    santaHintPickerSelectedIds, setSantaHintPickerSelectedIds,
    santaHintFulfillLoading, setSantaHintFulfillLoading,
    // chat
    santaChatMessages, setSantaChatMessages,
    santaChatHasMore, setSantaChatHasMore,
    santaChatLoading, setSantaChatLoading,
    santaChatInput, setSantaChatInput,
    santaChatSending, setSantaChatSending,
    santaChatIsMuted, setSantaChatIsMuted,
    santaChatSendNonceRef,
    // polls
    santaPolls, setSantaPolls,
    santaPollsLoading, setSantaPollsLoading,
    santaPollCreateOpen, setSantaPollCreateOpen,
    santaPollCreateQuestion, setSantaPollCreateQuestion,
    santaPollCreateOptions, setSantaPollCreateOptions,
    santaPollCreateAnonymous, setSantaPollCreateAnonymous,
    santaPollCreateSubmitting, setSantaPollCreateSubmitting,
    // organizer + exit
    santaOrganizerSummary, setSantaOrganizerSummary,
    santaOrganizerLoading, setSantaOrganizerLoading,
    santaExitRequestSheetOpen, setSantaExitRequestSheetOpen,
    santaExitRequestReason, setSantaExitRequestReason,
    santaExitRequestSubmitting, setSantaExitRequestSubmitting,
    // exclusions
    santaExclPairs, setSantaExclPairs,
    santaExclGroups, setSantaExclGroups,
    santaExclLoading, setSantaExclLoading,
    santaExclAddPairOpen, setSantaExclAddPairOpen,
    santaExclPairA, setSantaExclPairA,
    santaExclPairB, setSantaExclPairB,
    santaExclPairSaving, setSantaExclPairSaving,
    santaExclGroupSheetOpen, setSantaExclGroupSheetOpen,
    santaExclGroupLabel, setSantaExclGroupLabel,
    santaExclGroupSaving, setSantaExclGroupSaving,
    santaExclAddMemberGroupId, setSantaExclAddMemberGroupId,
    santaExclAddMemberUserId, setSantaExclAddMemberUserId,
    santaExclAddMemberSaving, setSantaExclAddMemberSaving,
  };
}

export type SantaState = ReturnType<typeof useSantaState>;
