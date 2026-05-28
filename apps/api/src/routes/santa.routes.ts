// Telegram-auth router for /tg/santa/* — 58 handlers covering the entire
// Secret Santa domain: admin/season config, campaign CRUD/lifecycle,
// participants/invites/exclusions, draw + assignment + reveal, rounds +
// gift-status/confirm-received, inbound (receiver inbox), hints (Santa-
// internal — distinct from /tg/items/:id/hint), chat + mute, polls + votes,
// participant-role + organizer-summary, and exit-requests.
//
// Mounted via `tgRouter.use(santaRouter)` in apps/api/src/index.ts after the
// other early P5 sub-routers. With this split, all inline tg handlers are
// extracted — index.ts becomes the composition root per
// docs/REFACTOR_API_INDEX_HANDOFF.md.
//
// Same factory pattern as P5a–P5o. Handler bodies are byte-identical to
// their previous in-place definitions in index.ts (1987–8894, scattered
// with helpers and schedulers in between) — only `tgRouter.` ->
// `santaRouter.` and indent +2.
//
// ─── Helpers migrated WITH this router ──────────────────────────────────
// Section 2.B from P5p audit (sole consumer = handlers + each other):
//   - Alias map: loadSantaAliasMap, resolveSantaAlias, predrawLabel,
//                types SantaAliasRecord/SantaAliasMap.
//   - Organizer + draw: isOrganizer, checkIsOrganizer,
//                TERMINAL_GIFT_STATUSES, buildExclusionSet, exclusionKey,
//                loadExclusionSet, findGroupForPair, hopcroftKarp,
//                checkDrawFeasibility, drawRandomAssignments.
//   - Assignment serialization: types SantaAssignmentForGiver/Receiver/
//                Owner, giftStatusToInboundSignal, GIVER_ALLOWED_TRANSITIONS,
//                serializeAssignment (3 overloads + impl).
//   - Hints: SANTA_HINT_TTL_HOURS, SANTA_HINT_MAX_ITEMS, types
//                SantaHintForGiver/SantaHintInboundForReceiver, fns
//                serializeSantaHintForGiver/serializeSantaHintInboundForReceiver.
//   - Chat: createSystemMessage, serializeChatMessage.
//   - Polls: serializePoll, POLL_SELECT.
//
// ─── Helpers that STAY in index.ts (passed via deps) ───────────────────
// Section 2.A from P5p audit — coupled to scheduler + startup hook:
//   - Season helpers: getSeasonStartYear, getSeasonCalendar,
//                getSantaSeasonInfo (used by schedulers & handlers).
//   - Seasonal broadcast: sendSeasonalBroadcast (used by schedulers + 2
//                handlers); maybeRunSeasonalEvents drives the cron.
//   - Alias generation: generateSantaAliases (used by startup alias-
//                backfill hook in app.listen + 1 handler), and its
//                primitives santaSeededRng/santaHashStr/santaShuffle +
//                SANTA_ADJECTIVES/ANIMALS/ADJ_KEYS/ANIMAL_KEYS.
// Universal helpers also via deps: getOrCreateTgUser, getUserEntitlement,
// trackEvent, mapTgItem, sendAdminAlert, tgActorHash.
//
// ─── Pre-existing security gap (NOT addressed in this PR) ──────────────
// Per CLAUDE.md § Security layer:
//   "Wave 1 (P0) is live; Santa / Categories / Hints / Subscriptions are
//    deferred to Wave 2."
// All ~50 state-changing Santa endpoints currently lack `protectTgRoute`
// idempotency middleware. This is intentional Wave-1 deferral. Wave-2
// follow-up will add idempotency categories + rate limits per spec.

import { Router } from 'express';
import { z } from 'zod';
import { prisma, Prisma } from '@wishlist/db';
import { t, type Locale } from '@wishlist/shared';

import { asyncHandler } from '../lib/asyncHandler';
import { zodError } from '../lib/http';
import { getRequestLocale } from '../lib/locale';
import { ITEM_ORDER_BY } from '../sort';
import logger from '../logger';
import { trackProductEvent } from '../services/analytics';
import { makeProRequired, sendPaywall } from '../services/paywall';

// Shape of the Telegram initData user object — duplicated from index.ts to
// avoid coupling routes/* to a non-exported local type.
type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

// Minimal structural shape of the User row that handlers in this file read.
type SantaUser = {
  id: string;
  godMode: boolean;
  santaTestMode: boolean;
  telegramId?: string | null;
  telegramChatId?: string | null;
};

// getUserEntitlement return shape (subset accessed when needed).
type SantaUserEntitlement = {
  isPro: boolean;
  plan: { code: string };
};

// Item shape that mapTgItem accepts. Mirrors index.ts:1273.
type MapTgItemInput = {
  id: string;
  wishlistId: string;
  title: string;
  url: string;
  priceText: string | null;
  currency?: string;
  imageUrl?: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  position?: number;
  status: string;
  description?: string | null;
  sourceUrl?: string | null;
  sourceDomain?: string | null;
  importMethod?: string | null;
};

// Season-info shape returned by getSantaSeasonInfo (index.ts:2344). Handlers
// only access inSeason/canCreate/seasonStart/seasonEnd; config is opaque.
type SantaSeasonInfo = {
  inSeason: boolean;
  canCreate: boolean;
  seasonStart: string | null;
  seasonEnd: string | null;
  config: unknown;
};

type SantaSeasonCalendar = {
  inSeason: boolean;
  seasonStart: Date;
  seasonEnd: Date;
};

// Alias data shape returned by generateSantaAliases (index.ts).
type SantaAliasData = {
  participantId: string;
  alias: string;
  emoji: string;
  adjectiveKey: string;
  animalKey: string;
};

export type SantaRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<SantaUser>;
  getUserEntitlement: (userId: string, godMode?: boolean) => Promise<SantaUserEntitlement>;
  trackEvent: (event: string, userId?: string, props?: Record<string, unknown>) => void;
  mapTgItem: (item: MapTgItemInput) => Record<string, unknown>;
  sendAdminAlert: (message: string) => Promise<void>;
  tgActorHash: (telegramId: number) => string;
  // Season + seasonal-broadcast helpers (stay in index.ts due to scheduler coupling):
  getSeasonStartYear: (now: Date) => number;
  getSeasonCalendar: (now: Date) => SantaSeasonCalendar;
  getSantaSeasonInfo: (userId: string, santaTestMode: boolean) => Promise<SantaSeasonInfo>;
  sendSeasonalBroadcast: (type: 'PROMO' | 'CLOSING_SOON', seasonYear: number) => Promise<void>;
  // Alias-generation helper (stays in index.ts due to startup-hook coupling):
  generateSantaAliases: (roundId: string, participantIds: string[]) => SantaAliasData[];
};

type SantaAliasRecord = { alias: string; emoji: string; adjectiveKey: string; animalKey: string };
type SantaAliasMap = Map<string, SantaAliasRecord>; // participantId → alias
/** Load alias map for a round from DB. Returns empty map if no aliases yet. */
async function loadSantaAliasMap(roundId: string): Promise<SantaAliasMap> {
  const rows = await prisma.santaParticipantAlias.findMany({
    where: { roundId },
    select: { participantId: true, alias: true, emoji: true, adjectiveKey: true, animalKey: true },
  });
  return new Map(rows.map(r => [r.participantId, { alias: r.alias, emoji: r.emoji, adjectiveKey: r.adjectiveKey, animalKey: r.animalKey }]));
}
/** Resolve alias for a participant from map. Falls back to generic if not found. */
function resolveSantaAlias(map: SantaAliasMap, participantId: string): SantaAliasRecord {
  return map.get(participantId) ?? { alias: 'Участник', emoji: '🎅', adjectiveKey: '', animalKey: '' };
}
/** Pre-draw stable label for a participant: "Участник N" based on join order.
 *  Used in organizer views (exclusions, participant list) before first draw. */
function predrawLabel(joinOrder: number): string {
  return `Участник ${joinOrder}`;
}
/**
 * isOrganizer: returns true if the user is the campaign owner OR has a JOINED participant
 * record with role=ADMIN in this campaign. Used to gate organizer-only actions.
 *
 * Pass the campaign object (must include ownerId) and the participant record if already
 * loaded (can be null if the user has no participant record).
 */
function isOrganizer(
  campaign: { ownerId: string },
  userId: string,
  participant: { status: string; role: string } | null | undefined,
): boolean {
  if (campaign.ownerId === userId) return true;
  if (participant?.status === 'JOINED' && participant.role === 'ADMIN') return true;
  return false;
}
/**
 * checkIsOrganizer: async version of isOrganizer that loads the participant
 * record from DB when needed. Fast-paths if campaign.ownerId === userId.
 */
async function checkIsOrganizer(campaignId: string, campaign: { ownerId: string }, userId: string): Promise<boolean> {
  if (campaign.ownerId === userId) return true;
  const participant = await prisma.santaParticipant.findUnique({
    where: { campaignId_userId: { campaignId, userId } },
    select: { status: true, role: true },
  });
  return participant?.status === 'JOINED' && participant.role === 'ADMIN';
}
/**
 * Terminal gift statuses — used to check whether a round is complete enough
 * to allow starting the next round or to evaluate orphaned assignments.
 */
const TERMINAL_GIFT_STATUSES = ['RECEIVED', 'MISSED_DEADLINE', 'ORPHANED'] as const;
function buildExclusionSet(exclusions: { userId1: string; userId2: string }[]): Set<string> {
  const set = new Set<string>();
  for (const e of exclusions) {
    const key = [e.userId1, e.userId2].sort().join(':');
    set.add(key);
  }
  return set;
}
function exclusionKey(userIdA: string, userIdB: string): string {
  return [userIdA, userIdB].sort().join(':');
}
/**
 * Load all exclusions for a campaign (individual + group-expanded) and return:
 *  - exclusionSet: flat Set<string> ready for draw/feasibility (interface unchanged)
 *  - groups: raw group data used to annotate infeasible-draw errors with group labels
 *
 * Groups expand to C(n,2) pairs in-memory — no SantaExclusion rows are created.
 *
 * activeUserIds: Set of userIds who are currently JOINED in the campaign.
 * Group members who are no longer JOINED (left / removed) are silently skipped
 * during pair expansion so stale membership never blocks a valid draw.
 * The raw groups list returned still contains ALL members for UI/annotation use.
 */
async function loadExclusionSet(campaignId: string, activeUserIds: Set<string>): Promise<{
  exclusionSet: Set<string>;
  groups: { id: string; label: string; members: { userId: string }[] }[];
}> {
  const [individual, groups] = await Promise.all([
    prisma.santaExclusion.findMany({
      where: { campaignId },
      select: { userId1: true, userId2: true },
    }),
    prisma.santaExclusionGroup.findMany({
      where: { campaignId },
      select: { id: true, label: true, members: { select: { userId: true } } },
    }),
  ]);

  // Start with individual pair exclusions
  const allPairs: { userId1: string; userId2: string }[] = [...individual];

  // Expand each group: only expand members who are still JOINED participants.
  // Stale members (left / removed / deleted) are excluded from pair generation
  // but kept in the raw `groups` return value for UI display.
  for (const group of groups) {
    const members = group.members.map(m => m.userId).filter(uid => activeUserIds.has(uid));
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        allPairs.push({ userId1: members[i]!, userId2: members[j]! });
      }
    }
  }

  return { exclusionSet: buildExclusionSet(allPairs), groups };
}
/**
 * Given the loaded groups, find which group (if any) contributed a specific pair.
 * Used to annotate infeasible-draw error with a human-readable group label.
 */
function findGroupForPair(
  groups: { label: string; members: { userId: string }[] }[],
  uid1: string,
  uid2: string,
): string | null {
  for (const group of groups) {
    const memberIds = new Set(group.members.map(m => m.userId));
    if (memberIds.has(uid1) && memberIds.has(uid2)) return group.label;
  }
  return null;
}
/**
 * Hopcroft-Karp bipartite matching.
 * givers[i] can be assigned to receivers[j] if allowed[i][j] is true.
 * Returns maximum matching size. If size == N, a valid assignment exists.
 */
function hopcroftKarp(
  n: number,
  adj: number[][],   // adj[giver_index] = list of valid receiver_indexes
): { matchingSize: number; matchG: number[]; matchR: number[] } {
  const INF = Number.MAX_SAFE_INTEGER;
  const matchG = new Array<number>(n).fill(-1); // matchG[giver] = receiver index (-1 = unmatched)
  const matchR = new Array<number>(n).fill(-1); // matchR[receiver] = giver index
  const dist = new Array<number>(n);

  function bfs(): boolean {
    const queue: number[] = [];
    for (let u = 0; u < n; u++) {
      if (matchG[u] === -1) { dist[u] = 0; queue.push(u); }
      else dist[u] = INF;
    }
    let found = false;
    let qi = 0;
    while (qi < queue.length) {
      const u = queue[qi++]!;
      for (const v of adj[u]!) {
        const w = matchR[v]!;
        if (w === -1) { found = true; }
        else if (dist[w] === INF) { dist[w] = (dist[u] ?? 0) + 1; queue.push(w); }
      }
    }
    return found;
  }

  function dfs(u: number): boolean {
    for (const v of adj[u]!) {
      const w = matchR[v]!;
      if (w === -1 || (dist[w] === (dist[u] ?? 0) + 1 && dfs(w))) {
        matchG[u] = v; matchR[v] = u; return true;
      }
    }
    dist[u] = INF;
    return false;
  }

  let matchingSize = 0;
  while (bfs()) {
    for (let u = 0; u < n; u++) {
      if (matchG[u] === -1 && dfs(u)) matchingSize++;
    }
  }
  return { matchingSize, matchG, matchR };
}
/**
 * Check draw feasibility. Returns { feasible, problematic } without any side effects.
 * "problematic" lists participant userId pairs whose exclusion is most constraining.
 */
function checkDrawFeasibility(
  participants: { id: string; userId: string }[],
  exclusionSet: Set<string>,
): { feasible: boolean; problematic: { userId1: string; userId2: string }[] } {
  const n = participants.length;
  const idx = new Map<string, number>(); // participantId → index
  participants.forEach((p, i) => idx.set(p.id, i));

  const adj: number[][] = participants.map((giver, i) =>
    participants
      .map((receiver, j) => ({ receiver, j }))
      .filter(({ receiver, j }) =>
        j !== i && !exclusionSet.has(exclusionKey(giver.userId, receiver.userId))
      )
      .map(({ j }) => j)
  );

  const { matchingSize } = hopcroftKarp(n, adj);
  if (matchingSize === n) return { feasible: true, problematic: [] };

  // Identify most constrained participants (fewest valid receivers)
  const constrained = participants
    .map((p, i) => ({ userId: p.userId, options: adj[i]!.length }))
    .sort((a, b) => a.options - b.options)
    .slice(0, 3);

  // Find exclusions among the most constrained to give actionable feedback
  const problematic: { userId1: string; userId2: string }[] = [];
  for (let i = 0; i < constrained.length; i++) {
    for (let j = i + 1; j < constrained.length; j++) {
      const a = constrained[i]!.userId;
      const b = constrained[j]!.userId;
      if (exclusionSet.has(exclusionKey(a, b))) problematic.push({ userId1: a, userId2: b });
    }
  }
  // Also add exclusions where a participant has 0 valid receivers
  for (const c of constrained) {
    if (c.options === 0) {
      // Find all exclusions involving this participant
      for (const p2 of participants) {
        if (p2.userId !== c.userId && exclusionSet.has(exclusionKey(c.userId, p2.userId))) {
          problematic.push({ userId1: c.userId, userId2: p2.userId });
        }
      }
    }
  }

  return { feasible: false, problematic };
}
/**
 * Generate a random valid derangement (Secret Santa assignment) using Fisher-Yates + backtracking.
 * Returns array of { giverParticipantId, receiverParticipantId } or null if exhausted retries.
 */
function drawRandomAssignments(
  participants: { id: string; userId: string }[],
  exclusionSet: Set<string>,
  maxRetries = 1000,
): { giverParticipantId: string; receiverParticipantId: string }[] | null {
  const n = participants.length;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Fisher-Yates shuffle of receiver indexes
    const receivers = [...participants];
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [receivers[i], receivers[j]] = [receivers[j]!, receivers[i]!];
    }

    // Check all constraints
    let valid = true;
    for (let i = 0; i < n; i++) {
      const giver = participants[i]!;
      const receiver = receivers[i]!;
      if (giver.id === receiver.id) { valid = false; break; } // self-pair
      if (exclusionSet.has(exclusionKey(giver.userId, receiver.userId))) { valid = false; break; }
    }

    if (valid) {
      return participants.map((giver, i) => ({
        giverParticipantId: giver.id,
        receiverParticipantId: receivers[i]!.id,
      }));
    }
  }

  // Random approach exhausted → use deterministic backtracking
  const assignment = new Array<number>(n).fill(-1);
  const used = new Array<boolean>(n).fill(false);

  // Build adjacency list for each giver
  const adj: number[][] = participants.map((giver, i) => {
    const options: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      if (!exclusionSet.has(exclusionKey(giver.userId, participants[j]!.userId))) options.push(j);
    }
    // Shuffle options for randomness
    for (let k = options.length - 1; k > 0; k--) {
      const r = Math.floor(Math.random() * (k + 1));
      [options[k], options[r]] = [options[r]!, options[k]!];
    }
    return options;
  });

  function backtrack(pos: number): boolean {
    if (pos === n) return true;
    for (const j of adj[pos]!) {
      if (!used[j]) {
        assignment[pos] = j;
        used[j] = true;
        if (backtrack(pos + 1)) return true;
        assignment[pos] = -1;
        used[j] = false;
      }
    }
    return false;
  }

  if (!backtrack(0)) return null;
  return participants.map((giver, i) => ({
    giverParticipantId: giver.id,
    receiverParticipantId: participants[assignment[i]!]!.id,
  }));
}
type SantaAssignmentForGiver = {
  role: 'giver';
  giftStatus: string;
  giftNote: string | null;
  receiver: { displayName: string; avatarUrl: null; emoji: string; adjectiveKey: string; animalKey: string; hasLinkedWishlist: boolean };
  reservedItems: { id: string; title: string }[];
};
type SantaAssignmentForReceiver = {
  role: 'receiver';
  giftStatus: string;
  hasGiver: true;
};
type SantaAssignmentForOwner = {
  role: 'owner';
  progress: {
    pending: number;
    buying: number;              // legacy BUYING count
    selectedFromWishlist: number;
    selectedOutside: number;
    declinedToSay: number;
    missedDeadline: number;
    sent: number;
    received: number;
    orphaned: number;            // exits approved mid-round
    withoutWishlist: number;     // receivers without a linked wishlist
  };
};
/**
 * Maps a raw SantaGiftStatus value to a clean receiver-facing inbound signal.
 * Deliberately coarse to prevent side-channel deduction of giver behaviour timing.
 *   waiting     = giver hasn't committed to anything yet
 *   in_progress = giver has made a selection (type intentionally hidden)
 *   ready       = giver says they sent it; receiver should confirm receipt
 *   received    = receiver confirmed; reveal is now unlocked personally
 */
function giftStatusToInboundSignal(giftStatus: string): 'waiting' | 'in_progress' | 'ready' | 'received' {
  switch (giftStatus) {
    case 'SELECTED_FROM_WISHLIST':
    case 'SELECTED_OUTSIDE':
    case 'DECLINED_TO_SAY':
    case 'BUYING':           // legacy
      return 'in_progress';
    case 'SENT':
      return 'ready';
    case 'RECEIVED':
      return 'received';
    case 'PENDING':
    case 'MISSED_DEADLINE':  // don't expose giver's failure to receiver
    default:
      return 'waiting';
  }
}
/** Allowed giver-initiated gift status transitions (Batch 3 state machine). */
const GIVER_ALLOWED_TRANSITIONS: Record<string, string[]> = {
  PENDING:                ['SELECTED_FROM_WISHLIST', 'SELECTED_OUTSIDE', 'DECLINED_TO_SAY', 'SENT', 'BUYING'],
  BUYING:                 ['SELECTED_FROM_WISHLIST', 'SELECTED_OUTSIDE', 'DECLINED_TO_SAY', 'SENT'],
  SELECTED_FROM_WISHLIST: ['SELECTED_OUTSIDE', 'DECLINED_TO_SAY', 'SENT'],
  SELECTED_OUTSIDE:       ['SELECTED_FROM_WISHLIST', 'DECLINED_TO_SAY', 'SENT'],
  DECLINED_TO_SAY:        ['SELECTED_FROM_WISHLIST', 'SELECTED_OUTSIDE', 'SENT'],
  // M3: BUYING removed from MISSED_DEADLINE — giver must commit to a real choice after missing deadline
  // BUYING is too vague to escape the cron loop (cron re-marks BUYING as MISSED_DEADLINE every hour)
  MISSED_DEADLINE:        ['SELECTED_FROM_WISHLIST', 'SELECTED_OUTSIDE', 'DECLINED_TO_SAY', 'SENT'],
  // SENT and RECEIVED are terminal from the giver side
};
/**
 * Single serialization codepath for assignment data.
 * NEVER expose receiverUserId/receiverParticipantId to giver.
 * NEVER expose giver identity to receiver.
 * NEVER expose individual pairs to owner.
 */
function serializeAssignment(
  role: 'giver',
  data: { giftStatus: string; giftNote: string | null; receiver: { displayName: string; avatarUrl: null; emoji: string; adjectiveKey: string; animalKey: string; hasLinkedWishlist: boolean }; reservedItems?: { id: string; title: string }[] }
): SantaAssignmentForGiver;
function serializeAssignment(
  role: 'receiver',
  data: { giftStatus: string }
): SantaAssignmentForReceiver;
function serializeAssignment(
  role: 'owner',
  data: { assignments: { giftStatus: string }[]; receiverWithoutWishlistCount?: number }
): SantaAssignmentForOwner;
function serializeAssignment(
  role: 'giver' | 'receiver' | 'owner',
  data: unknown,
): SantaAssignmentForGiver | SantaAssignmentForReceiver | SantaAssignmentForOwner {
  if (role === 'giver') {
    const d = data as { giftStatus: string; giftNote: string | null; receiver: { displayName: string; avatarUrl: null; emoji: string; adjectiveKey: string; animalKey: string; hasLinkedWishlist: boolean }; reservedItems?: { id: string; title: string }[] };
    return { role: 'giver', giftStatus: d.giftStatus, giftNote: d.giftNote, receiver: { displayName: d.receiver.displayName, avatarUrl: null, emoji: d.receiver.emoji, adjectiveKey: d.receiver.adjectiveKey, animalKey: d.receiver.animalKey, hasLinkedWishlist: d.receiver.hasLinkedWishlist }, reservedItems: d.reservedItems ?? [] };
  }
  if (role === 'receiver') {
    const d = data as { giftStatus: string };
    return { role: 'receiver', giftStatus: d.giftStatus, hasGiver: true };
  }
  // owner — aggregate only, never per-assignment detail
  const d = data as { assignments: { giftStatus: string }[]; receiverWithoutWishlistCount?: number };
  const progress = {
    pending: 0, buying: 0, selectedFromWishlist: 0, selectedOutside: 0,
    declinedToSay: 0, missedDeadline: 0, sent: 0, received: 0,
    orphaned: 0,
    withoutWishlist: d.receiverWithoutWishlistCount ?? 0,
  };
  for (const a of d.assignments) {
    switch (a.giftStatus) {
      case 'PENDING':                 progress.pending++; break;
      case 'BUYING':                  progress.buying++; break;
      case 'SELECTED_FROM_WISHLIST':  progress.selectedFromWishlist++; break;
      case 'SELECTED_OUTSIDE':        progress.selectedOutside++; break;
      case 'DECLINED_TO_SAY':         progress.declinedToSay++; break;
      case 'MISSED_DEADLINE':         progress.missedDeadline++; break;
      case 'SENT':                    progress.sent++; break;
      case 'RECEIVED':                progress.received++; break;
      case 'ORPHANED':                progress.orphaned++; break;
    }
  }
  return { role: 'owner', progress };
}
const SANTA_HINT_TTL_HOURS = 48;
const SANTA_HINT_MAX_ITEMS = 3;
// Serializer: giver side — exposes selection results, NEVER receiver identity
type SantaHintForGiver = {
  id: string;
  status: string;
  requestedAt: string;
  expiresAt: string;
  fulfilledAt: string | null;
  // null until FULFILLED; array of item shapes after receiver selects
  selectedItems: { id: string; title: string; priceText: string | null; url: string | null }[] | null;
};
function serializeSantaHintForGiver(
  hint: { id: string; status: string; requestedAt: Date; expiresAt: Date; fulfilledAt: Date | null; selectedItemIds: unknown },
  itemsMap?: Map<string, { id: string; title: string; priceText: string | null; url: string | null }>,
): SantaHintForGiver {
  let selectedItems: { id: string; title: string; priceText: string | null; url: string | null }[] | null = null;
  if (hint.status === 'FULFILLED' && Array.isArray(hint.selectedItemIds)) {
    selectedItems = (hint.selectedItemIds as string[])
      .map(id => itemsMap?.get(id))
      .filter((item): item is { id: string; title: string; priceText: string | null; url: string | null } => item !== undefined);
  }
  return {
    id: hint.id,
    status: hint.status,
    requestedAt: hint.requestedAt.toISOString(),
    expiresAt: hint.expiresAt.toISOString(),
    fulfilledAt: hint.fulfilledAt?.toISOString() ?? null,
    selectedItems,
    // ⚠ receiverParticipantId / receiverUserId deliberately omitted — anonymity contract
  };
}
// Serializer: receiver side — exposes request metadata, NEVER giver identity
type SantaHintInboundForReceiver = {
  hasPendingHint: boolean;
  hint: { id: string; status: string; requestedAt: string; expiresAt: string } | null;
};
function serializeSantaHintInboundForReceiver(
  hint: { id: string; status: string; requestedAt: Date; expiresAt: Date } | null,
): SantaHintInboundForReceiver {
  if (!hint) return { hasPendingHint: false, hint: null };
  return {
    hasPendingHint: hint.status === 'PENDING',
    hint: {
      id: hint.id,
      status: hint.status,
      requestedAt: hint.requestedAt.toISOString(),
      expiresAt: hint.expiresAt.toISOString(),
      // ⚠ giverParticipantId / giverUserId deliberately omitted — anonymity contract
    },
  };
}
// Helper: createSystemMessage — creates a SYSTEM message in the campaign chat.
// Called at lifecycle events (join, leave, remove, draw, cancel, complete).
// NEVER includes userId, participantId, or Santa pair data in payload.
async function createSystemMessage(
  campaignId: string,
  systemEvent: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  // Find campaign owner's participant record to use as the pseudo-sender for system messages.
  // If not found (owner left, edge case), skip silently.
  const campaign = await prisma.santaCampaign.findUnique({
    where: { id: campaignId },
    select: { ownerId: true },
  });
  if (!campaign) return;
  const ownerParticipant = await prisma.santaParticipant.findFirst({
    where: { campaignId, userId: campaign.ownerId },
    select: { id: true },
  });
  if (!ownerParticipant) return;

  await prisma.santaChatMessage.create({
    data: {
      campaignId,
      participantId: ownerParticipant.id,
      body: '',         // empty for SYSTEM; body is reserved for USER plaintext
      messageType: 'SYSTEM',
      systemEvent,
      payload: payload as Parameters<typeof prisma.santaChatMessage.create>[0]['data']['payload'],
    },
  }).catch(() => {}); // non-blocking; system message failures never surface to caller
}
// Serializer for a single chat message (role-aware, never leaks participantId)
function serializeChatMessage(
  msg: {
    id: string;
    messageType: string;
    body: string;
    systemEvent: string | null;
    payload: unknown;
    createdAt: Date;
    participantId: string;
    participant: {
      userId: string;
      user: { firstName: string | null; profile: { displayName: string | null; avatarUrl: string | null } | null };
    };
  },
  myUserId: string,
  aliasMap: SantaAliasMap,
) {
  const isSystem = msg.messageType === 'SYSTEM';
  // Strip any real-name fields from system message payload (legacy messages may contain displayName)
  let safePayload: unknown = null;
  if (isSystem && msg.payload && typeof msg.payload === 'object') {
    const { displayName: _stripped, avatarUrl: _strippedUrl, ...rest } = msg.payload as Record<string, unknown>;
    safePayload = rest;
  } else if (isSystem) {
    safePayload = msg.payload ?? null;
  }
  const senderAlias = resolveSantaAlias(aliasMap, msg.participantId);
  return {
    id: msg.id,
    messageType: msg.messageType as 'USER' | 'SYSTEM',
    body: isSystem ? '' : msg.body,
    systemEvent: isSystem ? (msg.systemEvent ?? null) : null,
    payload: safePayload,
    sender: isSystem
      ? null
      : {
          displayName: senderAlias.alias,
          avatarUrl: null,
          emoji: senderAlias.emoji,
          adjectiveKey: senderAlias.adjectiveKey,
          animalKey: senderAlias.animalKey,
          isMe: msg.participant.userId === myUserId,
        },
    createdAt: msg.createdAt.toISOString(),
  };
}
// Serializer for a poll (role-aware, anonymous policy enforced)
function serializePoll(
  poll: {
    id: string;
    question: string;
    options: unknown;
    isAnonymous: boolean;
    createdAt: Date;
    deadlineAt: Date | null;
    closedAt: Date | null;
    votes: { optionIndex: number; participantId: string; participant: { userId: string; user: { firstName: string | null; profile: { displayName: string | null } | null } } }[];
  },
  myParticipantId: string,
  isOwner: boolean,
  aliasMap: SantaAliasMap,
) {
  const options = (poll.options as string[]);
  const now = new Date();
  const isOpen = !poll.closedAt && (!poll.deadlineAt || poll.deadlineAt > now);
  const myVoteEntry = poll.votes.find(v => v.participantId === myParticipantId);
  const myVote = myVoteEntry ? myVoteEntry.optionIndex : null;

  // Tally results
  const counts = new Array<number>(options.length).fill(0);
  for (const v of poll.votes) counts[v.optionIndex] = (counts[v.optionIndex] ?? 0) + 1;
  const total = poll.votes.length;

  const results = options.map((_, idx) => {
    const count = counts[idx] ?? 0;
    const percentage = total > 0 ? Math.round((count / total) * 100) : 0;
    // voters: always null for anonymous polls; show aliases (not real names) for public polls
    const voters = poll.isAnonymous
      ? null
      : poll.votes
          .filter(v => v.optionIndex === idx)
          .map(v => {
            const va = resolveSantaAlias(aliasMap, v.participantId);
            return { displayName: va.alias, emoji: va.emoji };
          });
    return { optionIndex: idx, count, percentage, voters };
  });

  return {
    id: poll.id,
    question: poll.question,
    options,
    isAnonymous: poll.isAnonymous,
    createdAt: poll.createdAt.toISOString(),
    deadlineAt: poll.deadlineAt ? poll.deadlineAt.toISOString() : null,
    closedAt: poll.closedAt ? poll.closedAt.toISOString() : null,
    isOpen,
    myVote,
    results,
  };
}
const POLL_SELECT = {
  id: true, question: true, options: true, isAnonymous: true, createdAt: true,
  deadlineAt: true, closedAt: true,
  votes: {
    select: {
      optionIndex: true, participantId: true,
      participant: { select: { userId: true, user: { select: { firstName: true, profile: { select: { displayName: true } } } } } },
    },
  },
} as const;

export function registerSantaRouter(deps: SantaRouterDeps): Router {
  const {
    getOrCreateTgUser,
    getUserEntitlement,
    trackEvent,
    mapTgItem,
    sendAdminAlert,
    tgActorHash,
    getSeasonStartYear,
    getSeasonCalendar,
    getSantaSeasonInfo,
    sendSeasonalBroadcast,
    generateSantaAliases,
  } = deps;

  const santaRouter = Router();

  // GET /tg/santa/my-reservations — Santa items reserved by the current user (giver view)
  // Excludes: campaign CANCELLED, assignment giftStatus RECEIVED or ORPHANED (both terminal).
  // SELECTED_OUTSIDE already deletes SantaItemReservation rows in the status-change handler,
  // so those never appear here naturally.
  santaRouter.get('/santa/my-reservations', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);

    const rows = await prisma.santaItemReservation.findMany({
      where: {
        assignment: {
          giver: { userId: user.id },
          giftStatus: { notIn: ['RECEIVED', 'ORPHANED'] },
          round: { campaign: { status: { not: 'CANCELLED' } } },
        },
      },
      select: {
        assignmentId: true,
        item: {
          select: {
            id: true, wishlistId: true, title: true, url: true, priceText: true,
            imageUrl: true, priority: true, status: true, description: true,
            sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
          },
        },
        assignment: {
          select: {
            id: true,
            giftStatus: true,
            round: {
              select: {
                campaign: { select: { id: true, title: true, status: true } },
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const reservations = rows.map(r => ({
      ...mapTgItem(r.item),
      campaignId: r.assignment.round.campaign.id,
      campaignTitle: r.assignment.round.campaign.title,
      campaignStatus: r.assignment.round.campaign.status,
      giftStatus: r.assignment.giftStatus,
      assignmentId: r.assignmentId,
    }));

    return res.json({ reservations });
  }));

  // GET /tg/santa/season — season status and canCreate flag
  santaRouter.get('/santa/season', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const info = await getSantaSeasonInfo(user.id, user.santaTestMode);
    return res.json({
      inSeason: info.inSeason,
      canCreate: info.canCreate,
      seasonStart: info.seasonStart,
      seasonEnd: info.seasonEnd,
      testMode: user.santaTestMode,
    });
  }));

  // POST /tg/santa/season/test-mode — toggle santa test mode (godMode users only)
  santaRouter.post('/santa/season/test-mode', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    if (!user.godMode) return res.status(403).json({ error: 'Forbidden' });
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { santaTestMode: !user.santaTestMode },
      select: { santaTestMode: true },
    });
    return res.json({ santaTestMode: updated.santaTestMode });
  }));

  // GET /tg/santa/admin/global-config — read global master switch (godMode only)
  santaRouter.get('/santa/admin/global-config', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    if (!user.godMode) return res.status(403).json({ error: 'Forbidden' });
    const config = await prisma.santaGlobalConfig.findUnique({ where: { id: 'global' } });
    return res.json({ santaEnabled: config?.santaEnabled ?? true });
  }));

  // PATCH /tg/santa/admin/global-config — toggle global master switch (godMode only)
  // Set santaEnabled=false to retire Secret Santa entirely (affects all users except godMode/santaTestMode).
  // Set santaEnabled=true to re-enable; yearly calendar rules take over automatically.
  santaRouter.patch('/santa/admin/global-config', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    if (!user.godMode) return res.status(403).json({ error: 'Forbidden' });
    const parsed = z.object({ santaEnabled: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    const updated = await prisma.santaGlobalConfig.upsert({
      where:  { id: 'global' },
      create: { id: 'global', santaEnabled: parsed.data.santaEnabled },
      update: { santaEnabled: parsed.data.santaEnabled },
    });
    void sendAdminAlert(
      `🎛 Santa global switch <b>${updated.santaEnabled ? 'ENABLED ✅' : 'DISABLED 🔴'}</b> by godMode user ${user.id}`,
    );
    return res.json({ santaEnabled: updated.santaEnabled });
  }));

  // GET /tg/santa/admin/season-broadcasts — view sent seasonal broadcast history (godMode only)
  santaRouter.get('/santa/admin/season-broadcasts', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    if (!user.godMode) return res.status(403).json({ error: 'Forbidden' });
    const logs = await prisma.santaSeasonalBroadcastLog.findMany({
      orderBy: [{ year: 'desc' }, { type: 'asc' }],
      take: 20,
    });
    return res.json(logs);
  }));

  // POST /tg/santa/admin/season-broadcasts — manually trigger a seasonal broadcast (godMode only)
  // Used for testing or if the automated job missed the Nov 1 / Feb 1 window for any reason.
  // Body: { type: 'PROMO' | 'CLOSING_SOON', seasonYear: number, force?: boolean }
  // force=true skips the already-sent guard and re-sends even if log row exists.
  santaRouter.post('/santa/admin/season-broadcasts', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    if (!user.godMode) return res.status(403).json({ error: 'Forbidden' });
    const parsed = z.object({
      type:       z.enum(['PROMO', 'CLOSING_SOON']),
      seasonYear: z.number().int().min(2020).max(2100),
      force:      z.boolean().optional().default(false),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const { type, seasonYear, force } = parsed.data;

    if (force) {
      // Delete existing log row so sendSeasonalBroadcast can re-create it
      await prisma.santaSeasonalBroadcastLog.deleteMany({
        where: { year: seasonYear, type },
      });
    }

    // Fire in background; response confirms the job was queued
    void sendSeasonalBroadcast(type, seasonYear);
    return res.json({ ok: true, queued: { type, seasonYear, force } });
  }));

  // POST /tg/santa/campaigns — create a new campaign
  santaRouter.post('/santa/campaigns', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const parsed = z.object({
      title: z.string().min(1).max(80),
      description: z.string().max(500).optional(),
      type: z.enum(['CLASSIC', 'MULTI_WAVE']).default('CLASSIC'),
      minBudget: z.number().int().positive().optional(),
      maxBudget: z.number().int().positive().optional(),
      currency: z.string().max(3).default('RUB'),
      drawAt: z.string().datetime().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const info = await getSantaSeasonInfo(user.id, user.santaTestMode);
    if (!info.canCreate) return res.status(403).json({ error: 'santa_not_in_season' });

    // PRO gate for MULTI_WAVE
    if (parsed.data.type === 'MULTI_WAVE') {
      const ent = await getUserEntitlement(user.id);
      if (!ent.isPro) {
        trackProductEvent({ event: 'santa.gate_hit', userId: user.id, props: { feature: 'santa_multi_wave' } });
        return sendPaywall(res, 402, makeProRequired('santa_multi_wave', { planCode: ent.plan.code }));
      }
    }

    const now = new Date();
    const campaign = await prisma.santaCampaign.create({
      data: {
        title: parsed.data.title,
        description: parsed.data.description,
        type: parsed.data.type,
        status: 'DRAFT',
        ownerId: user.id,
        minBudget: parsed.data.minBudget,
        maxBudget: parsed.data.maxBudget,
        currency: parsed.data.currency,
        drawAt: parsed.data.drawAt ? new Date(parsed.data.drawAt) : undefined,
        seasonYear: now.getFullYear(),
      },
      select: { id: true, title: true, status: true, inviteToken: true, type: true, seasonYear: true, createdAt: true },
    });

    await prisma.santaAdminAuditLog.create({
      data: { campaignId: campaign.id, actorId: user.id, action: 'campaign_created' },
    });

    return res.status(201).json({ campaign });
  }));

  // GET /tg/santa/campaigns — list my campaigns (owned + joined)
  santaRouter.get('/santa/campaigns', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);

    const [owned, joined] = await Promise.all([
      prisma.santaCampaign.findMany({
        where: { ownerId: user.id },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true, title: true, status: true, type: true, seasonYear: true, createdAt: true,
          _count: { select: { participants: { where: { status: 'JOINED' } } } },
        },
      }),
      prisma.santaParticipant.findMany({
        where: { userId: user.id, status: 'JOINED', campaign: { ownerId: { not: user.id } } },
        orderBy: { joinedAt: 'desc' },
        select: {
          campaign: {
            select: {
              id: true, title: true, status: true, type: true, seasonYear: true, createdAt: true,
              _count: { select: { participants: { where: { status: 'JOINED' } } } },
              owner: { select: { firstName: true, profile: { select: { displayName: true } } } },
            },
          },
        },
      }),
    ]);

    return res.json({
      owned: owned.map(c => ({ ...c, participantCount: c._count.participants })),
      joined: joined.map(j => ({
        ...j.campaign,
        participantCount: j.campaign._count.participants,
        ownerName: j.campaign.owner.profile?.displayName || j.campaign.owner.firstName || null,
      })),
    });
  }));

  // GET /tg/santa/campaigns/:id — campaign detail (participants only)
  santaRouter.get('/santa/campaigns/:id', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

    const campaign = await prisma.santaCampaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true, title: true, description: true, type: true, status: true, ownerId: true,
        inviteToken: true, minBudget: true, maxBudget: true, currency: true, drawAt: true,
        seasonYear: true, cancelledAt: true, cancelReason: true, createdAt: true,
        currentRoundId: true,
        participants: {
          where: { status: { in: ['JOINED', 'INVITED'] } },
          select: {
            id: true, status: true, role: true, joinedAt: true,
            user: { select: { id: true, firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
            linkedWishlist: { select: { id: true, title: true, slug: true } },
          },
          orderBy: { joinedAt: 'asc' },
        },
        rounds: { select: { id: true, roundNumber: true }, orderBy: { roundNumber: 'asc' } },
      },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const isOwner = campaign.ownerId === user.id;
    const isParticipant = campaign.participants.some(p => p.user.id === user.id);
    if (!isOwner && !isParticipant) return res.status(403).json({ error: 'Forbidden' });

    // Load alias map for current round (empty map if no round yet)
    const aliasMap = campaign.currentRoundId
      ? await loadSantaAliasMap(campaign.currentRoundId)
      : new Map<string, SantaAliasRecord>();

    // Pre-draw: build stable join-order map (participantId → 1-based position, sorted by joinedAt ASC, id ASC)
    const joinOrderMap = new Map<string, number>();
    [...campaign.participants]
      .sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime() || a.id.localeCompare(b.id))
      .forEach((p, i) => joinOrderMap.set(p.id, i + 1));

    // Find caller's own assignment (post-draw) — role-aware, never leaks pairs
    let myAssignment: SantaAssignmentForGiver | null = null;
    let ownerProgress: SantaAssignmentForOwner | null = null;
    const myParticipant = campaign.participants.find(p => p.user.id === user.id);
    if (campaign.currentRoundId && ['ACTIVE', 'COMPLETED'].includes(campaign.status)) {
      const roundId = campaign.currentRoundId;
      // Organizer (owner or admin) sees aggregate progress — no individual pairs
      const callerParticipant = campaign.participants.find(p => p.user.id === user.id);
      const callerIsOrganizer = campaign.ownerId === user.id ||
        (callerParticipant?.status === 'JOINED' && callerParticipant.role === 'ADMIN');
      if (callerIsOrganizer) {
        const allAssignments = await prisma.santaAssignment.findMany({
          where: { roundId },
          select: { giftStatus: true },
        });
        // Count receivers without a linked wishlist (so organizer can nudge them)
        const receiverWithoutWishlistCount = campaign.participants.filter(
          p => p.status === 'JOINED' && !p.linkedWishlist,
        ).length;
        ownerProgress = serializeAssignment('owner', { assignments: allAssignments, receiverWithoutWishlistCount });
      }
      if (myParticipant) {
        // Giver view for all participants (including owner if they're also a participant)
        const giverAssignment = await prisma.santaAssignment.findUnique({
          where: { roundId_giverParticipantId: { roundId, giverParticipantId: myParticipant.id } },
          select: {
            giftStatus: true, giftNote: true,
            receiver: {
              select: {
                id: true,      // needed for alias lookup
                linkedWishlistId: true,
              },
            },
            santaItemReservations: {
              select: { itemId: true, item: { select: { title: true } } },
              orderBy: { createdAt: 'asc' },
            },
          },
        });
        if (giverAssignment) {
          const receiverAlias = resolveSantaAlias(aliasMap, giverAssignment.receiver.id);
          myAssignment = serializeAssignment('giver', {
            giftStatus: giverAssignment.giftStatus,
            giftNote: giverAssignment.giftNote,
            receiver: {
              displayName: receiverAlias.alias,      // alias instead of real name
              avatarUrl: null,                        // never expose real photo
              emoji: receiverAlias.emoji,
              adjectiveKey: receiverAlias.adjectiveKey,
              animalKey: receiverAlias.animalKey,
              hasLinkedWishlist: !!giverAssignment.receiver.linkedWishlistId,
            },
            reservedItems: giverAssignment.santaItemReservations.map(r => ({ id: r.itemId, title: r.item.title })),
          });
        }
      }
    }

    // Pending exit request for caller (if they have one)
    let pendingExitRequestId: string | null = null;
    if (myParticipant && !isOwner) {
      const pendingReq = await prisma.santaExitRequest.findFirst({
        where: { participantId: myParticipant.id, status: 'PENDING' },
        select: { id: true },
      });
      pendingExitRequestId = pendingReq?.id ?? null;
    }

    // Number of pending exit requests visible to organizers
    const pendingExitRequestCount = (isOwner || myParticipant?.role === 'ADMIN')
      ? await prisma.santaExitRequest.count({ where: { campaignId, status: 'PENDING' } })
      : 0;

    // Is caller an organizer (owner or ADMIN participant)?
    const amOrganizer = isOrganizer(campaign, user.id, myParticipant);

    // Chat unread count + mute state for participant
    let chatUnreadCount = 0;
    let isMuted = false;
    if (myParticipant) {
      const [chatCursor, mutedEntry] = await Promise.all([
        prisma.santaChatReadCursor.findUnique({
          where: { campaignId_participantId: { campaignId, participantId: myParticipant.id } },
          select: { lastReadMessageId: true },
        }),
        prisma.santaChatMute.findUnique({
          where: { campaignId_participantId: { campaignId, participantId: myParticipant.id } },
          select: { id: true },
        }),
      ]);
      isMuted = !!mutedEntry;
      if (!chatCursor?.lastReadMessageId) {
        chatUnreadCount = await prisma.santaChatMessage.count({ where: { campaignId } });
      } else {
        const lastRead = await prisma.santaChatMessage.findUnique({
          where: { id: chatCursor.lastReadMessageId },
          select: { createdAt: true, id: true },
        });
        if (lastRead) {
          chatUnreadCount = await prisma.santaChatMessage.count({
            where: {
              campaignId,
              OR: [
                { createdAt: { gt: lastRead.createdAt } },
                { createdAt: lastRead.createdAt, id: { gt: lastRead.id } },
              ],
            },
          });
        } else {
          chatUnreadCount = await prisma.santaChatMessage.count({ where: { campaignId } });
        }
      }
    }

    return res.json({
      campaign: {
        id: campaign.id,
        title: campaign.title,
        description: campaign.description,
        type: campaign.type,
        status: campaign.status,
        isOwner,
        isOrganizer: amOrganizer,
        inviteToken: isOwner ? campaign.inviteToken : undefined,
        minBudget: campaign.minBudget,
        maxBudget: campaign.maxBudget,
        currency: campaign.currency,
        drawAt: campaign.drawAt,
        seasonYear: campaign.seasonYear,
        cancelledAt: campaign.cancelledAt,
        cancelReason: campaign.cancelReason,
        createdAt: campaign.createdAt,
      },
      participants: campaign.participants.map(p => {
        // Post-draw: use round-scoped alias. Pre-draw: use stable join-order label.
        const hasRoundAlias = aliasMap.size > 0;
        const pAlias = hasRoundAlias
          ? resolveSantaAlias(aliasMap, p.id)
          : { alias: predrawLabel(joinOrderMap.get(p.id) ?? 0), emoji: '🎅', adjectiveKey: '', animalKey: '' };
        return {
          id: p.id,
          status: p.status,
          role: p.role,
          joinedAt: p.joinedAt,
          userId: p.user.id,
          isMe: p.user.id === user.id,
          // Alias instead of real name (displayName kept for API compat, populated with alias)
          displayName: pAlias.alias,
          avatarUrl: null,             // never expose real photo in Santa context
          emoji: pAlias.emoji,
          adjectiveKey: pAlias.adjectiveKey,
          animalKey: pAlias.animalKey,
          hasLinkedWishlist: !!p.linkedWishlist,
          // Never expose wishlist title — only the linked flag (or own wishlist id for self)
          linkedWishlist: p.user.id === user.id
            ? (p.linkedWishlist ? { id: p.linkedWishlist.id, slug: p.linkedWishlist.slug } : null)
            : null,
        };
      }),
      rounds: campaign.rounds,
      currentRoundNumber: campaign.rounds.find(r => r.id === campaign.currentRoundId)?.roundNumber ?? null,
      totalRounds: campaign.rounds.length,
      myRole: myParticipant?.role ?? null,
      myAlias: myParticipant && aliasMap.size > 0
        ? resolveSantaAlias(aliasMap, myParticipant.id)
        : null,
      pendingExitRequestId,
      pendingExitRequestCount: amOrganizer ? pendingExitRequestCount : undefined,
      myAssignment,
      ownerProgress: amOrganizer ? ownerProgress : undefined,
      chatUnreadCount,
      isMuted,
    });
  }));

  // PATCH /tg/santa/campaigns/:id — update campaign (owner only, non-COMPLETED/CANCELLED)
  santaRouter.patch('/santa/campaigns/:id', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

    const parsed = z.object({
      title: z.string().min(1).max(80).optional(),
      description: z.string().max(500).nullable().optional(),
      minBudget: z.number().int().positive().nullable().optional(),
      maxBudget: z.number().int().positive().nullable().optional(),
      currency: z.string().max(3).optional(),
      drawAt: z.string().datetime().nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, status: true } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });
    if (['COMPLETED', 'CANCELLED'].includes(campaign.status)) return res.status(409).json({ error: 'Campaign is finished' });

    const data: Record<string, unknown> = {};
    if (parsed.data.title !== undefined) data.title = parsed.data.title;
    if (parsed.data.description !== undefined) data.description = parsed.data.description;
    if (parsed.data.minBudget !== undefined) data.minBudget = parsed.data.minBudget;
    if (parsed.data.maxBudget !== undefined) data.maxBudget = parsed.data.maxBudget;
    if (parsed.data.currency !== undefined) data.currency = parsed.data.currency;
    if (parsed.data.drawAt !== undefined) data.drawAt = parsed.data.drawAt ? new Date(parsed.data.drawAt) : null;

    const updated = await prisma.santaCampaign.update({ where: { id: campaignId }, data });
    return res.json({ campaign: updated });
  }));

  // POST /tg/santa/campaigns/:id/open — DRAFT → OPEN
  santaRouter.post('/santa/campaigns/:id/open', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, status: true } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });
    if (campaign.status !== 'DRAFT') return res.status(409).json({ error: 'Campaign is not in DRAFT status' });

    await prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'OPEN' } });
    await prisma.santaAdminAuditLog.create({ data: { campaignId, actorId: user.id, action: 'status_changed', payload: { from: 'DRAFT', to: 'OPEN' } } });
    return res.json({ ok: true });
  }));

  // POST /tg/santa/campaigns/:id/lock — OPEN → LOCKED
  santaRouter.post('/santa/campaigns/:id/lock', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    const campaign = await prisma.santaCampaign.findUnique({
      where: { id: campaignId },
      select: { ownerId: true, status: true, _count: { select: { participants: { where: { status: 'JOINED' } } } } },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });
    if (campaign.status !== 'OPEN') return res.status(409).json({ error: 'Campaign is not OPEN' });
    if (campaign._count.participants < 2) return res.status(422).json({ error: 'Need at least 2 participants to lock' });

    await prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'LOCKED' } });
    await prisma.santaAdminAuditLog.create({ data: { campaignId, actorId: user.id, action: 'status_changed', payload: { from: 'OPEN', to: 'LOCKED' } } });
    return res.json({ ok: true });
  }));

  // POST /tg/santa/campaigns/:id/cancel — cancel campaign (owner only)
  santaRouter.post('/santa/campaigns/:id/cancel', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    const parsed = z.object({ reason: z.string().max(200).optional() }).safeParse(req.body);

    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, status: true } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    // Cancel is owner-only — admins cannot cancel campaigns
    if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can cancel the campaign' });
    if (['COMPLETED', 'CANCELLED'].includes(campaign.status)) return res.status(409).json({ error: 'Campaign is already finished' });

    const now = new Date();
    await prisma.$transaction([
      prisma.santaCampaign.update({
        where: { id: campaignId },
        data: { status: 'CANCELLED', cancelledAt: now, cancelReason: parsed.success ? (parsed.data.reason ?? null) : null },
      }),
      // Bulk-cancel all PENDING hint requests for this campaign (lifecycle rule: campaign cancel → hints CANCELLED)
      prisma.santaHintRequest.updateMany({
        where: { campaignId, status: 'PENDING' },
        data: { status: 'CANCELLED', cancelledAt: now },
      }),
      prisma.santaAdminAuditLog.create({
        data: { campaignId, actorId: user.id, action: 'campaign_cancelled', payload: { reason: parsed.success ? parsed.data.reason : undefined } },
      }),
    ]);
    // System message: campaign cancelled
    void createSystemMessage(campaignId, 'campaign_cancelled', {}).catch(() => {});

    // CAMPAIGN_CANCELLED notifications — batch insert for all JOINED participants
    void (async () => {
      try {
        const joinedParticipants = await prisma.santaParticipant.findMany({
          where: { campaignId, status: 'JOINED' },
          select: { userId: true },
        });
        if (joinedParticipants.length > 0) {
          await prisma.santaNotification.createMany({
            data: joinedParticipants.map(p => ({
              campaignId,
              userId: p.userId,
              type: 'CAMPAIGN_CANCELLED' as const,
              payload: {},
              dedupeKey: `cancel:${campaignId}`,  // unique per (user, CAMPAIGN_CANCELLED, campaign)
            })),
            skipDuplicates: true,
          });
        }
      } catch {
        // Non-fatal
      }
    })();

    return res.json({ ok: true });
  }));

  // GET /tg/santa/campaigns/:id/draw/validate — feasibility check, ZERO side effects
  santaRouter.get('/santa/campaigns/:id/draw/validate', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';

    const campaign = await prisma.santaCampaign.findUnique({
      where: { id: campaignId },
      select: {
        ownerId: true,
        status: true,
        participants: {
          where: { status: 'JOINED' },
          select: { id: true, userId: true, user: { select: { firstName: true } } },
        },
        // SantaExclusion is not directly on campaign; query separately
      },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });
    if (!['LOCKED', 'OPEN', 'DRAFT'].includes(campaign.status)) {
      return res.status(409).json({ error: 'Draw can only be validated when campaign is LOCKED, OPEN or DRAFT' });
    }

    const participants = campaign.participants;
    if (participants.length < 2) {
      return res.json({ feasible: false, reason: 'not_enough_participants', minRequired: 2, actual: participants.length });
    }

    const activeUserIds = new Set(participants.map(p => p.userId));
    const { exclusionSet, groups } = await loadExclusionSet(campaignId, activeUserIds);
    const { feasible, problematic } = checkDrawFeasibility(participants, exclusionSet);

    if (feasible) {
      return res.json({ feasible: true, participantCount: participants.length });
    }

    // Build human-readable names + optional group label for each problematic pair
    const userIdToName = new Map(participants.map(p => [p.userId, p.user.firstName || p.userId]));
    const problematicWithNames = problematic.map(p => ({
      userId1: p.userId1, name1: userIdToName.get(p.userId1) ?? p.userId1,
      userId2: p.userId2, name2: userIdToName.get(p.userId2) ?? p.userId2,
      groupLabel: findGroupForPair(groups, p.userId1, p.userId2),
    }));

    return res.json({
      feasible: false,
      reason: 'exclusions_prevent_valid_assignment',
      participantCount: participants.length,
      problematicExclusions: problematicWithNames,
    });
  }));

  // POST /tg/santa/campaigns/:id/draw — execute draw with atomic lock
  santaRouter.post('/santa/campaigns/:id/draw', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';

    // 1. Verify caller is organizer and campaign is LOCKED
    const campaign = await prisma.santaCampaign.findUnique({
      where: { id: campaignId },
      select: { ownerId: true, status: true, id: true },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    // Draw is owner-only — admins cannot trigger draw
    if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can run the draw' });

    if (campaign.status === 'DRAW_IN_PROGRESS') {
      return res.status(409).json({ error: 'draw_already_running', message: 'A draw is already in progress for this campaign.' });
    }
    if (campaign.status !== 'LOCKED') {
      return res.status(409).json({ error: 'campaign_not_locked', message: 'Campaign must be in LOCKED status to start draw.' });
    }

    // 2. Load participants and exclusions
    const participants = await prisma.santaParticipant.findMany({
      where: { campaignId, status: 'JOINED' },
      select: { id: true, userId: true, user: { select: { firstName: true } } },
    });
    if (participants.length < 2) {
      return res.status(422).json({ error: 'not_enough_participants', minRequired: 2, actual: participants.length });
    }

    const activeUserIds = new Set(participants.map(p => p.userId));
    const { exclusionSet, groups: excGroups } = await loadExclusionSet(campaignId, activeUserIds);

    // 3. Pre-check feasibility before acquiring lock
    const { feasible, problematic } = checkDrawFeasibility(participants, exclusionSet);
    if (!feasible) {
      const userIdToName = new Map(participants.map(p => [p.userId, p.user.firstName || p.userId]));
      const problematicWithNames = problematic.map(p => ({
        userId1: p.userId1, name1: userIdToName.get(p.userId1) ?? p.userId1,
        userId2: p.userId2, name2: userIdToName.get(p.userId2) ?? p.userId2,
        groupLabel: findGroupForPair(excGroups, p.userId1, p.userId2),
      }));
      return res.status(422).json({
        error: 'draw_infeasible',
        reason: 'exclusions_prevent_valid_assignment',
        message: 'С текущими ограничениями жеребьёвка невозможна. Уберите одно из ограничений, чтобы продолжить.',
        problematicExclusions: problematicWithNames,
      });
    }

    // 4. Atomic lock: UPDATE only if still LOCKED (prevents double-draw)
    const drawJobId = crypto.randomUUID();
    const locked = await prisma.santaCampaign.updateMany({
      where: { id: campaignId, status: 'LOCKED' },
      data: { status: 'DRAW_IN_PROGRESS' },
    });
    if (locked.count === 0) {
      return res.status(409).json({ error: 'draw_already_running', message: 'Another draw job already acquired the lock.' });
    }

    // 5. Find the existing PENDING round (created by POST /rounds for multi-round),
    //    or create the first round if none exists.
    //    Invariant: at most one PENDING round per campaign (enforced by partial unique index).
    let round = await prisma.santaRound.findFirst({ where: { campaignId, drawStatus: 'PENDING' } });
    if (!round) {
      // First draw (or there's no pending round — create one)
      const maxRound = await prisma.santaRound.findFirst({
        where: { campaignId },
        orderBy: { roundNumber: 'desc' },
      });
      round = await prisma.santaRound.create({
        data: { campaignId, roundNumber: (maxRound?.roundNumber ?? 0) + 1, drawStatus: 'IN_PROGRESS', drawJobId },
      });
    } else {
      await prisma.santaRound.update({ where: { id: round.id }, data: { drawStatus: 'IN_PROGRESS', drawJobId } });
    }
    const roundId = round.id;

    try {
      // 6. Generate assignment (Fisher-Yates + backtracking)
      const assignments = drawRandomAssignments(participants, exclusionSet);
      if (!assignments) {
        // Should not happen since we pre-checked feasibility, but handle gracefully
        await prisma.$transaction([
          prisma.santaRound.update({ where: { id: roundId }, data: { drawStatus: 'FAILED' } }),
          prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'LOCKED' } }),
        ]);
        return res.status(500).json({ error: 'draw_failed', message: 'Draw algorithm failed despite feasibility check. Please retry.' });
      }

      // 7. Generate anonymous aliases for all participants (deterministic, round-scoped)
      const aliasData = generateSantaAliases(roundId, participants.map(p => p.id));

      // 8. Atomically persist assignments + aliases + mark ACTIVE
      await prisma.$transaction([
        prisma.santaAssignment.createMany({
          data: assignments.map(a => ({ roundId, ...a, giftStatus: 'PENDING' })),
        }),
        prisma.santaParticipantAlias.createMany({
          data: aliasData.map(a => ({ roundId, ...a })),
          skipDuplicates: true,
        }),
        prisma.santaRound.update({ where: { id: roundId }, data: { drawStatus: 'DONE', drawnAt: new Date() } }),
        prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'ACTIVE', currentRoundId: round.id } }),
      ]);

      // 8. Audit log
      await prisma.santaAdminAuditLog.create({
        data: { campaignId, actorId: user.id, action: 'draw_completed', payload: { drawJobId, assignmentCount: assignments.length } },
      });

      // System message: draw done (no pair info — just a generic event marker)
      void createSystemMessage(campaignId, 'draw_done', {}).catch(() => {});

      // DRAW_DONE notifications — one per participant per round, deduped by dedupeKey
      void (async () => {
        try {
          await prisma.santaNotification.createMany({
            data: participants.map(p => ({
              campaignId,
              userId: p.userId,
              type: 'DRAW_DONE' as const,
              payload: {},
              dedupeKey: `draw:${roundId}`,   // unique per (user, DRAW_DONE, round)
            })),
            skipDuplicates: true,
          });
        } catch {
          // Non-fatal
        }
      })();

      return res.json({ ok: true, assignmentCount: assignments.length });

    } catch (err) {
      // Rollback: mark round FAILED, campaign back to LOCKED for retry
      try {
        await prisma.$transaction([
          prisma.santaRound.update({ where: { id: roundId }, data: { drawStatus: 'FAILED' } }),
          prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'LOCKED' } }),
        ]);
      } catch (_rollbackErr) {
        // Best-effort rollback
      }
      throw err; // Re-throw for asyncHandler to catch
    }
  }));

  // GET /tg/santa/invite/:token — resolve invite token → campaign preview
  santaRouter.get('/santa/invite/:token', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const token = req.params.token ?? '';
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const campaign = await prisma.santaCampaign.findUnique({
      where: { inviteToken: token },
      select: {
        id: true, title: true, description: true, status: true, type: true, seasonYear: true,
        minBudget: true, maxBudget: true, currency: true,
        owner: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
        _count: { select: { participants: { where: { status: 'JOINED' } } } },
      },
    });

    if (!campaign) return res.status(404).json({ error: 'Invite not found' });
    if (campaign.status === 'CANCELLED') return res.status(410).json({ error: 'Campaign cancelled' });

    // P0-B: if user is already a JOINED participant, let them through regardless of campaign status
    // (they clicked the invite link from a running campaign — redirect them to campaign detail)
    const alreadyJoined = await prisma.santaParticipant.findFirst({
      where: { campaignId: campaign.id, userId: user.id, status: 'JOINED' },
      select: { id: true },
    });

    if (!alreadyJoined && !['OPEN', 'DRAFT'].includes(campaign.status)) {
      return res.status(409).json({ error: 'Campaign is not accepting new members', campaignId: campaign.id });
    }

    const campaignPreview = {
      id: campaign.id,
      title: campaign.title,
      description: campaign.description,
      status: campaign.status,
      type: campaign.type,
      seasonYear: campaign.seasonYear,
      minBudget: campaign.minBudget,
      maxBudget: campaign.maxBudget,
      currency: campaign.currency,
      participantCount: campaign._count.participants,
      ownerName: campaign.owner.profile?.displayName || campaign.owner.firstName || null,
      ownerAvatarUrl: campaign.owner.profile?.avatarUrl || null,
    };

    return res.json({ campaign: campaignPreview, alreadyJoined: !!alreadyJoined });
  }));

  // POST /tg/santa/campaigns/:id/join — join via invite token
  santaRouter.post('/santa/campaigns/:id/join', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

    const campaign = await prisma.santaCampaign.findUnique({
      where: { id: campaignId },
      select: { status: true, ownerId: true },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status === 'CANCELLED') return res.status(410).json({ error: 'Campaign cancelled' });
    if (!['OPEN', 'DRAFT'].includes(campaign.status)) return res.status(409).json({ error: 'Campaign is not accepting new members' });

    // Already a participant?
    const existing = await prisma.santaParticipant.findUnique({
      where: { campaignId_userId: { campaignId, userId: user.id } },
    });
    if (existing) {
      if (existing.status === 'JOINED') return res.json({ ok: true, alreadyJoined: true });
      // Rejoin if left/removed
      await prisma.santaParticipant.update({
        where: { id: existing.id },
        data: { status: 'JOINED', leftAt: null, joinedAt: new Date() },
      });
      // System message: rejoined — no real name in payload
      void createSystemMessage(campaignId, 'participant_joined', {}).catch(() => {});
      return res.json({ ok: true });
    }

    const newParticipant = await prisma.santaParticipant.create({
      data: { campaignId, userId: user.id, status: 'JOINED' },
      select: { id: true },
    });
    // System message: participant joined — no real name in payload
    void createSystemMessage(campaignId, 'participant_joined', {}).catch(() => {});
    // Notify owner
    void prisma.santaNotification.create({
      data: { campaignId, userId: campaign.ownerId, type: 'JOINED', payload: { participantId: newParticipant.id } },
    }).catch(() => {});

    return res.status(201).json({ ok: true });
  }));

  // POST /tg/santa/campaigns/:id/leave — leave campaign (before draw)
  santaRouter.post('/santa/campaigns/:id/leave', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

    const participant = await prisma.santaParticipant.findUnique({
      where: { campaignId_userId: { campaignId, userId: user.id } },
      include: { campaign: { select: { status: true } } },
    });
    if (!participant || participant.status !== 'JOINED') return res.status(404).json({ error: 'Not a participant' });
    // COMPLETED/CANCELLED: cannot leave at all (terminal states)
    if (['COMPLETED', 'CANCELLED'].includes(participant.campaign.status)) {
      return res.status(409).json({ error: 'Campaign is already finished' });
    }
    // LOCKED, DRAW_IN_PROGRESS, or ACTIVE: must use exit-request flow
    if (['LOCKED', 'DRAW_IN_PROGRESS', 'ACTIVE'].includes(participant.campaign.status)) {
      return res.status(409).json({
        error: 'use_exit_request',
        message: 'Campaign is locked or active. Submit an exit request for the organizer to approve.',
        campaignStatus: participant.campaign.status,
      });
    }

    await prisma.santaParticipant.update({
      where: { id: participant.id },
      data: { status: 'LEFT', leftAt: new Date() },
    });
    // System message: participant left — no real name in payload
    void createSystemMessage(campaignId, 'participant_left', {}).catch(() => {});

    return res.json({ ok: true });
  }));

  // DELETE /tg/santa/campaigns/:id/participants/:userId — remove participant (organizer only, before draw)
  santaRouter.delete('/santa/campaigns/:id/participants/:userId', asyncHandler(async (req, res) => {
    const owner = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    const targetUserId = req.params.userId ?? '';

    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, status: true } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    // M5: removal is owner-only (admins can manage participants but not remove them)
    if (campaign.ownerId !== owner.id) return res.status(403).json({ error: 'Forbidden' });
    // Owner cannot remove themselves via this endpoint
    if (targetUserId === owner.id) return res.status(400).json({ error: 'Cannot remove yourself via this endpoint' });
    if (['ACTIVE', 'COMPLETED', 'DRAW_IN_PROGRESS'].includes(campaign.status)) {
      return res.status(409).json({ error: 'Cannot remove after draw' });
    }

    const participant = await prisma.santaParticipant.findFirst({
      where: { campaignId, userId: targetUserId, status: 'JOINED' },
    });
    if (!participant) return res.status(404).json({ error: 'Participant not found' });

    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { firstName: true, profile: { select: { displayName: true } } },
    });
    await prisma.santaParticipant.update({
      where: { id: participant.id },
      data: { status: 'REMOVED', leftAt: new Date() },
    });
    // System message: participant was removed — no real name in payload
    void createSystemMessage(campaignId, 'participant_removed', {}).catch(() => {});

    return res.json({ ok: true });
  }));

  // PATCH /tg/santa/campaigns/:id/wishlist — link or unlink wishlist (participant only)
  santaRouter.patch('/santa/campaigns/:id/wishlist', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

    const parsed = z.object({ wishlistId: z.string().nullable() }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const participant = await prisma.santaParticipant.findUnique({
      where: { campaignId_userId: { campaignId, userId: user.id } },
      include: { campaign: { select: { status: true } } },
    });
    if (!participant || participant.status !== 'JOINED') return res.status(404).json({ error: 'Not a participant' });
    // Allow linking/changing during ACTIVE so participants who forgot to link pre-draw can still set a preference.
    // Block only terminal states and mid-draw state.
    if (['COMPLETED', 'CANCELLED', 'DRAW_IN_PROGRESS'].includes(participant.campaign.status)) {
      return res.status(409).json({ error: 'Cannot change wishlist after campaign is complete' });
    }

    if (parsed.data.wishlistId) {
      // Verify user owns this wishlist
      const wishlist = await prisma.wishlist.findUnique({ where: { id: parsed.data.wishlistId }, select: { ownerId: true } });
      if (!wishlist || wishlist.ownerId !== user.id) return res.status(404).json({ error: 'Wishlist not found' });
    }

    await prisma.santaParticipant.update({
      where: { id: participant.id },
      data: { linkedWishlistId: parsed.data.wishlistId },
    });
    return res.json({ ok: true });
  }));

  // GET /tg/santa/campaigns/:id/exclusions — list exclusions (owner only)
  santaRouter.get('/santa/campaigns/:id/exclusions', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, currentRoundId: true } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

    // Load alias map for current round; build participant join-order for pre-draw fallback
    const exclAliasMap = campaign.currentRoundId
      ? await loadSantaAliasMap(campaign.currentRoundId)
      : new Map<string, SantaAliasRecord>();

    // Load individual exclusions + groups + all participants in parallel
    const [rawExclusions, groups, allCampParticipants] = await Promise.all([
      prisma.santaExclusion.findMany({ where: { campaignId }, orderBy: { createdAt: 'asc' } }),
      prisma.santaExclusionGroup.findMany({
        where: { campaignId },
        orderBy: { createdAt: 'asc' },
        include: {
          members: {
            select: { userId: true },
          },
        },
      }),
      prisma.santaParticipant.findMany({
        where: { campaignId },
        select: { id: true, userId: true, status: true, joinedAt: true },
        orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
      }),
    ]);

    const joinedUserIds = new Set(allCampParticipants.filter(p => p.status === 'JOINED').map(p => p.userId));
    // Map userId → participantId for alias lookup
    const userIdToParticipantId = new Map(allCampParticipants.map(p => [p.userId, p.id]));
    // Join order map: participantId → 1-based position
    const exclJoinOrderMap = new Map(allCampParticipants.map((p, i) => [p.id, i + 1]));

    const hasRoundAlias = exclAliasMap.size > 0;
    const resolveForUser = (userId: string) => {
      const pid = userIdToParticipantId.get(userId);
      if (!pid) return { alias: 'Участник', emoji: '🎅' };
      return hasRoundAlias
        ? resolveSantaAlias(exclAliasMap, pid)
        : { alias: predrawLabel(exclJoinOrderMap.get(pid) ?? 0), emoji: '🎅' };
    };
    const resolveForParticipant = (pid: string) => hasRoundAlias
      ? resolveSantaAlias(exclAliasMap, pid)
      : { alias: predrawLabel(exclJoinOrderMap.get(pid) ?? 0), emoji: '🎅' };

    return res.json({
      exclusions: rawExclusions.map(e => {
        const a1 = resolveForUser(e.userId1);
        const a2 = resolveForUser(e.userId2);
        return {
          id: e.id,
          userId1: e.userId1, name1: a1.alias, emoji1: a1.emoji,
          userId2: e.userId2, name2: a2.alias, emoji2: a2.emoji,
        };
      }),
      groups: groups.map(g => ({
        id: g.id,
        label: g.label,
        members: g.members.map(m => {
          const pid = userIdToParticipantId.get(m.userId) ?? '';
          const a = resolveForParticipant(pid);
          return {
            userId: m.userId,
            displayName: a.alias,
            avatarUrl: null,
            emoji: a.emoji,
            adjectiveKey: (a as SantaAliasRecord).adjectiveKey ?? null,
            animalKey: (a as SantaAliasRecord).animalKey ?? null,
            isStale: !joinedUserIds.has(m.userId),
          };
        }),
        activeCount: g.members.filter(m => joinedUserIds.has(m.userId)).length,
      })),
    });
  }));

  // POST /tg/santa/campaigns/:id/exclusions — add exclusion (owner + PRO only)
  santaRouter.post('/santa/campaigns/:id/exclusions', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';

    const parsed = z.object({ userId1: z.string().min(1), userId2: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

    const ent = await getUserEntitlement(user.id);
    if (!ent.isPro) {
      trackProductEvent({ event: 'santa.gate_hit', userId: user.id, props: { feature: 'santa_exclusions' } });
      return sendPaywall(res, 402, makeProRequired('santa_exclusions'));
    }

    const { userId1, userId2 } = parsed.data;
    // Normalize order to prevent (A,B) and (B,A) both existing
    const [uid1, uid2] = userId1 < userId2 ? [userId1, userId2] : [userId2, userId1];

    try {
      const exclusion = await prisma.santaExclusion.create({ data: { campaignId, userId1: uid1, userId2: uid2 } });
      return res.status(201).json({ exclusion });
    } catch {
      return res.status(409).json({ error: 'Exclusion already exists' });
    }
  }));

  // DELETE /tg/santa/campaigns/:id/exclusions/:exclusionId — remove exclusion (owner only)
  santaRouter.delete('/santa/campaigns/:id/exclusions/:exclusionId', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    const exclusionId = req.params.exclusionId ?? '';

    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

    const exclusion = await prisma.santaExclusion.findUnique({ where: { id: exclusionId } });
    if (!exclusion || exclusion.campaignId !== campaignId) return res.status(404).json({ error: 'Exclusion not found' });

    await prisma.santaExclusion.delete({ where: { id: exclusionId } });
    return res.json({ ok: true });
  }));

  // POST /tg/santa/campaigns/:id/exclusions/groups — create named group (owner + PRO)
  santaRouter.post('/santa/campaigns/:id/exclusions/groups', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';

    const parsed = z.object({
      label: z.string().min(1).max(60).trim(),
      // No `.min()`: an omitted field defaults to [], which zod re-validates
      // through this inner type — a lower bound here would reject the
      // create-empty-group-then-add-members flow the Mini App actually uses.
      memberUserIds: z.array(z.string().min(1)).max(50).optional().default([]),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

    const ent = await getUserEntitlement(user.id);
    if (!ent.isPro) {
      trackProductEvent({ event: 'santa.gate_hit', userId: user.id, props: { feature: 'santa_exclusion_groups' } });
      return sendPaywall(res, 402, makeProRequired('santa_exclusion_groups'));
    }

    const group = await prisma.santaExclusionGroup.create({
      data: {
        campaignId,
        label: parsed.data.label,
        members: parsed.data.memberUserIds.length > 0
          ? { create: [...new Set(parsed.data.memberUserIds)].map(uid => ({ userId: uid })) }
          : undefined,
      },
      include: {
        members: {
          include: {
            user: { select: { id: true, firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
          },
        },
      },
    });

    return res.status(201).json({
      group: {
        id: group.id,
        label: group.label,
        members: group.members.map(m => ({
          userId: m.userId,
          displayName: m.user.profile?.displayName || m.user.firstName || m.userId,
          avatarUrl: m.user.profile?.avatarUrl ?? null,
        })),
      },
    });
  }));

  // PATCH /tg/santa/campaigns/:id/exclusions/groups/:gid — rename group (owner only)
  santaRouter.patch('/santa/campaigns/:id/exclusions/groups/:gid', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    const gid = req.params.gid ?? '';

    const parsed = z.object({ label: z.string().min(1).max(60).trim() }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

    const group = await prisma.santaExclusionGroup.findUnique({ where: { id: gid } });
    if (!group || group.campaignId !== campaignId) return res.status(404).json({ error: 'Group not found' });

    const updated = await prisma.santaExclusionGroup.update({
      where: { id: gid },
      data: { label: parsed.data.label },
    });
    return res.json({ group: { id: updated.id, label: updated.label } });
  }));

  // DELETE /tg/santa/campaigns/:id/exclusions/groups/:gid — delete group + all members (owner only)
  santaRouter.delete('/santa/campaigns/:id/exclusions/groups/:gid', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    const gid = req.params.gid ?? '';

    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

    const group = await prisma.santaExclusionGroup.findUnique({ where: { id: gid } });
    if (!group || group.campaignId !== campaignId) return res.status(404).json({ error: 'Group not found' });

    // Cascade deletes members via FK constraint
    await prisma.santaExclusionGroup.delete({ where: { id: gid } });
    return res.json({ ok: true });
  }));

  // POST /tg/santa/campaigns/:id/exclusions/groups/:gid/members — add participant to group (owner + PRO only)
  santaRouter.post('/santa/campaigns/:id/exclusions/groups/:gid/members', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    const gid = req.params.gid ?? '';

    const parsed = z.object({ userId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

    const ent = await getUserEntitlement(user.id);
    if (!ent.isPro) {
      trackProductEvent({ event: 'santa.gate_hit', userId: user.id, props: { feature: 'santa_exclusion_groups' } });
      return sendPaywall(res, 402, makeProRequired('santa_exclusion_groups'));
    }

    const group = await prisma.santaExclusionGroup.findUnique({ where: { id: gid } });
    if (!group || group.campaignId !== campaignId) return res.status(404).json({ error: 'Group not found' });

    // Verify userId belongs to a JOINED participant in this campaign
    const participant = await prisma.santaParticipant.findFirst({
      where: { campaignId, userId: parsed.data.userId, status: 'JOINED' },
    });
    if (!participant) return res.status(404).json({ error: 'Participant not found or not joined' });

    try {
      const member = await prisma.santaExclusionGroupMember.create({
        data: { groupId: gid, userId: parsed.data.userId },
        include: {
          user: { select: { id: true, firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
        },
      });
      return res.status(201).json({
        member: {
          userId: member.userId,
          displayName: member.user.profile?.displayName || member.user.firstName || member.userId,
          avatarUrl: member.user.profile?.avatarUrl ?? null,
        },
      });
    } catch {
      return res.status(409).json({ error: 'already_in_group' });
    }
  }));

  // DELETE /tg/santa/campaigns/:id/exclusions/groups/:gid/members/:uid — remove member (owner only)
  santaRouter.delete('/santa/campaigns/:id/exclusions/groups/:gid/members/:uid', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    const gid = req.params.gid ?? '';
    const targetUserId = req.params.uid ?? '';

    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

    const group = await prisma.santaExclusionGroup.findUnique({ where: { id: gid } });
    if (!group || group.campaignId !== campaignId) return res.status(404).json({ error: 'Group not found' });

    const member = await prisma.santaExclusionGroupMember.findUnique({
      where: { groupId_userId: { groupId: gid, userId: targetUserId } },
    });
    if (!member) return res.status(404).json({ error: 'Member not found in group' });

    await prisma.santaExclusionGroupMember.delete({
      where: { groupId_userId: { groupId: gid, userId: targetUserId } },
    });
    return res.json({ ok: true });
  }));

  // POST /tg/santa/campaigns/:id/rounds — start next round (owner + all current round terminal)
  santaRouter.post('/santa/campaigns/:id/rounds', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';

    const campaign = await prisma.santaCampaign.findUnique({
      where: { id: campaignId },
      select: {
        ownerId: true,
        status: true,
        currentRoundId: true,
        rounds: { select: { id: true, roundNumber: true }, orderBy: { roundNumber: 'desc' } },
      },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    // Starting a new round is owner-only — admins cannot start rounds
    if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can start a new round' });
    if (campaign.status !== 'ACTIVE') {
      return res.status(409).json({ error: 'campaign_not_active', message: 'Campaign must be ACTIVE to start next round' });
    }

    // Invariant: at most one PENDING round per campaign
    const existingPending = await prisma.santaRound.findFirst({
      where: { campaignId, drawStatus: 'PENDING' },
    });
    if (existingPending) {
      return res.status(409).json({ error: 'pending_round_exists', message: 'A round is already pending draw. Run the draw first.' });
    }

    // All assignments in current round must be in terminal states
    if (!campaign.currentRoundId) {
      return res.status(409).json({ error: 'no_active_round' });
    }
    const TERMINAL: string[] = ['RECEIVED', 'MISSED_DEADLINE', 'ORPHANED'];
    const blockingAssignments = await prisma.santaAssignment.findMany({
      where: { roundId: campaign.currentRoundId, giftStatus: { notIn: TERMINAL as never[] } },
      select: { id: true, giftStatus: true },
    });
    if (blockingAssignments.length > 0) {
      return res.status(409).json({
        error: 'round_not_complete',
        message: 'All gifts must reach RECEIVED, MISSED_DEADLINE, or ORPHANED before starting next round',
        blocking: blockingAssignments.map(a => ({ id: a.id, giftStatus: a.giftStatus })),
      });
    }

    // Create next round (PENDING)
    const nextRoundNumber = (campaign.rounds[0]?.roundNumber ?? 0) + 1;
    const nextRound = await prisma.santaRound.create({
      data: { campaignId, roundNumber: nextRoundNumber, drawStatus: 'PENDING' },
    });

    // Campaign back to LOCKED (ready to draw); currentRoundId stays pointing to completed round
    await prisma.santaCampaign.update({
      where: { id: campaignId },
      data: { status: 'LOCKED' },
    });

    return res.status(201).json({
      nextRound: { id: nextRound.id, roundNumber: nextRound.roundNumber },
      campaign: { status: 'LOCKED', currentRoundId: campaign.currentRoundId },
    });
  }));

  // POST /tg/santa/campaigns/:id/complete — force-complete campaign (organizer only, no assignment check)
  santaRouter.post('/santa/campaigns/:id/complete', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';

    const campaign = await prisma.santaCampaign.findUnique({
      where: { id: campaignId },
      select: { ownerId: true, status: true },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    // Force-complete is owner-only — admins cannot complete campaigns
    if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can complete the campaign' });
    if (campaign.status !== 'ACTIVE') {
      return res.status(409).json({ error: 'campaign_not_active', message: 'Only ACTIVE campaigns can be force-completed' });
    }

    await prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'COMPLETED' } });

    // campaign_completed system message in chat (guaranteed visible to all participants)
    void createSystemMessage(campaignId, 'campaign_completed', {}).catch(() => {});

    return res.json({ ok: true, status: 'COMPLETED' });
  }));

  // POST /tg/santa/campaigns/:id/gift-status — update gift status (giver only, post-draw)
  santaRouter.patch('/santa/campaigns/:id/gift-status', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';

    const parsed = z.object({
      // Accept all Batch-3 selection statuses + legacy BUYING + SENT
      status: z.enum(['BUYING', 'SELECTED_FROM_WISHLIST', 'SELECTED_OUTSIDE', 'DECLINED_TO_SAY', 'SENT']),
      note: z.string().max(300).optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const participant = await prisma.santaParticipant.findUnique({
      where: { campaignId_userId: { campaignId, userId: user.id } },
    });
    if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' }); // L1

    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { status: true, currentRoundId: true } });
    if (!campaign || campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Campaign is not ACTIVE' });
    if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });

    const roundId = campaign.currentRoundId;
    const assignment = await prisma.santaAssignment.findUnique({
      where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
    });
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

    // Transition validation — SENT and RECEIVED are one-way doors
    const allowedNext = GIVER_ALLOWED_TRANSITIONS[assignment.giftStatus];
    if (!allowedNext) {
      return res.status(409).json({
        error: 'invalid_transition',
        message: `Cannot change gift status from ${assignment.giftStatus}`,
        currentStatus: assignment.giftStatus,
      });
    }
    if (!allowedNext.includes(parsed.data.status)) {
      return res.status(409).json({
        error: 'invalid_transition',
        message: `Transition from ${assignment.giftStatus} to ${parsed.data.status} is not allowed`,
        currentStatus: assignment.giftStatus,
      });
    }

    // When switching away from wishlist-based selection, clear all Santa-flow reservations
    const clearReservationStatuses = ['SELECTED_OUTSIDE', 'DECLINED_TO_SAY', 'SENT'];
    if (clearReservationStatuses.includes(parsed.data.status)) {
      await prisma.santaItemReservation.deleteMany({ where: { assignmentId: assignment.id } });
    }

    const updated = await prisma.santaAssignment.update({
      where: { id: assignment.id },
      data: { giftStatus: parsed.data.status, giftNote: parsed.data.note ?? assignment.giftNote },
      include: {
        receiver: {
          select: {
            id: true,
            linkedWishlistId: true,
          },
        },
        santaItemReservations: {
          select: { itemId: true, item: { select: { title: true } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    await prisma.santaGiftProgress.create({ data: { assignmentId: assignment.id, status: parsed.data.status, note: parsed.data.note } });

    // Return role-aware serialized response — never expose receiverUserId/receiverParticipantId; use alias
    const giftStatusAliasMap = await loadSantaAliasMap(roundId);
    const receiverAlias = resolveSantaAlias(giftStatusAliasMap, updated.receiver.id);
    return res.json(serializeAssignment('giver', {
      giftStatus: updated.giftStatus,
      giftNote: updated.giftNote,
      receiver: { displayName: receiverAlias.alias, avatarUrl: null, emoji: receiverAlias.emoji, adjectiveKey: receiverAlias.adjectiveKey, animalKey: receiverAlias.animalKey, hasLinkedWishlist: !!updated.receiver.linkedWishlistId },
      reservedItems: updated.santaItemReservations.map(r => ({ id: r.itemId, title: r.item.title })),
    }));
  }));

  // POST /tg/santa/campaigns/:id/confirm-received — receiver confirms gift received
  santaRouter.post('/santa/campaigns/:id/confirm-received', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';

    const participant = await prisma.santaParticipant.findUnique({
      where: { campaignId_userId: { campaignId, userId: user.id } },
    });
    if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' }); // L1

    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { status: true, currentRoundId: true } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!['ACTIVE', 'COMPLETED'].includes(campaign.status)) return res.status(409).json({ error: 'Campaign is not ACTIVE' });
    if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });

    const roundId = campaign.currentRoundId;
    // Receiver addresses via campaign-centric path — NOT assignmentId
    // M1: resolve assignment FIRST — check RECEIVED idempotency before campaign-active gate
    // This ensures a retry after the campaign auto-completes still returns the idempotent success.
    const assignment = await prisma.santaAssignment.findUnique({
      where: { roundId_receiverParticipantId: { roundId, receiverParticipantId: participant.id } },
      select: { id: true, giftStatus: true }, // Only what we need — never select giverParticipantId here
    });
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });
    // Idempotency: already RECEIVED → return success regardless of campaign.status
    if (assignment.giftStatus === 'RECEIVED') return res.json({ ok: true, campaignCompleted: campaign.status === 'COMPLETED', alreadyReceived: true, canReveal: true });
    // Now enforce ACTIVE-only for actual state transition
    if (campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Campaign is not ACTIVE' });

    // Gate: only allowed from SENT (giver must acknowledge they sent before receiver can confirm)
    if (assignment.giftStatus !== 'SENT') {
      return res.status(409).json({
        error: 'gift_not_sent',
        message: 'Receiver can only confirm receipt after the giver marks the gift as sent',
        currentGiftStatus: assignment.giftStatus,
      });
    }

    // Fetch the giver's participantId (needed for notification — never exposed to receiver)
    const fullAssignment = await prisma.santaAssignment.findUnique({
      where: { id: assignment.id },
      select: { giverParticipantId: true, giver: { select: { userId: true } } },
    });

    await prisma.santaAssignment.update({ where: { id: assignment.id }, data: { giftStatus: 'RECEIVED' } });
    await prisma.santaGiftProgress.create({ data: { assignmentId: assignment.id, status: 'RECEIVED' } });

    // Check if all gifts received → complete campaign
    const allAssignments = await prisma.santaAssignment.findMany({ where: { roundId }, select: { id: true, giftStatus: true } });
    // After our update above, re-check: our assignment is now RECEIVED
    // Auto-complete: only for single-round campaigns where all assignments are RECEIVED.
    // Multi-round campaigns (totalRounds > 1) require organizer to explicitly call POST /complete.
    // MISSED_DEADLINE assignments do NOT trigger auto-complete; organizer uses POST /complete.
    const totalRounds = await prisma.santaRound.count({ where: { campaignId } });
    const allReceived = allAssignments.every(a => a.id === assignment.id ? true : a.giftStatus === 'RECEIVED');
    if (allReceived && totalRounds === 1) {
      await prisma.santaCampaign.update({ where: { id: campaignId }, data: { status: 'COMPLETED' } });
      // campaign_completed system message in chat
      void createSystemMessage(campaignId, 'campaign_completed', {}).catch(() => {});
    }

    // Notifications (best-effort, non-blocking) — deduped by DB partial unique index
    if (fullAssignment) {
      const giverUserId = fullAssignment.giver.userId;
      // GIFT_RECEIVED → giver: "your recipient received your gift!" (once per assignment)
      void prisma.santaNotification.create({
        data: { campaignId, userId: giverUserId, type: 'GIFT_RECEIVED', payload: { assignmentId: assignment.id }, dedupeKey: `gift:${assignment.id}` },
      }).catch(() => { /* duplicate suppressed by dedupeKey unique index */ });

      // REVEAL_UNLOCKED → receiver: "you can now see who your Secret Santa was!" (once per assignment)
      void prisma.santaNotification.create({
        data: { campaignId, userId: user.id, type: 'REVEAL_UNLOCKED', payload: { assignmentId: assignment.id }, dedupeKey: `reveal:${assignment.id}` },
      }).catch(() => { /* duplicate suppressed by dedupeKey unique index */ });
    }

    return res.json({ ok: true, campaignCompleted: allReceived, canReveal: true });
  }));

  // GET /tg/santa/campaigns/:id/inbound/wishlist — giver gets receiver's wishlist items
  // Returns items with reservedByMe flag + myReservations summary for the dedicated wishlist screen.
  santaRouter.get('/santa/campaigns/:id/inbound/wishlist', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';

    const participant = await prisma.santaParticipant.findUnique({ where: { campaignId_userId: { campaignId, userId: user.id } } });
    if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { status: true, currentRoundId: true } });
    if (!campaign || campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Campaign not ACTIVE' });
    if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });

    const roundId = campaign.currentRoundId;
    const assignment = await prisma.santaAssignment.findUnique({
      where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
      include: {
        receiver: { select: { id: true, linkedWishlistId: true } },
        santaItemReservations: { select: { itemId: true, item: { select: { title: true } } }, orderBy: { createdAt: 'asc' } },
      },
    });
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

    const receiverWishlistId = assignment.receiver.linkedWishlistId;
    // Use alias — never expose real receiver identity to giver
    const inboundAliasMap = await loadSantaAliasMap(roundId);
    const receiverAlias = resolveSantaAlias(inboundAliasMap, assignment.receiver.id);

    const myReservedItemIds = new Set(assignment.santaItemReservations.map(r => r.itemId));
    const myReservations = assignment.santaItemReservations.map(r => ({ id: r.itemId, title: r.item.title }));

    const giverView = serializeAssignment('giver', {
      giftStatus: assignment.giftStatus,
      giftNote: assignment.giftNote,
      receiver: { displayName: receiverAlias.alias, avatarUrl: null, emoji: receiverAlias.emoji, adjectiveKey: receiverAlias.adjectiveKey, animalKey: receiverAlias.animalKey, hasLinkedWishlist: !!receiverWishlistId },
      reservedItems: myReservations,
    });

    if (!receiverWishlistId) return res.json({ ...giverView, wishlist: null, items: [], myReservations });

    const items = await prisma.item.findMany({
      where: { wishlistId: receiverWishlistId, status: { in: ['AVAILABLE', 'RESERVED', 'PURCHASED'] } },
      orderBy: ITEM_ORDER_BY,
      select: { id: true, title: true, url: true, priceText: true, currency: true, priority: true, imageUrl: true, status: true, description: true },
    });
    const wishlist = await prisma.wishlist.findUnique({ where: { id: receiverWishlistId }, select: { title: true } });

    // Annotate items with reservedByMe flag — never expose reserver identity for items NOT reserved by this giver
    const annotatedItems = items.map(item => ({
      ...item,
      reservedByMe: myReservedItemIds.has(item.id),
      // For items reserved by others (status=RESERVED) but NOT by this giver, only expose the status flag
      // No reserver identity is ever returned
    }));

    return res.json({ ...giverView, wishlist: wishlist ? { title: wishlist.title } : null, items: annotatedItems, myReservations });
  }));

  // POST /tg/santa/campaigns/:id/inbound/reserve — giver reserves a wishlist item (Santa-flow)
  // Creates SantaItemReservation and auto-syncs gift status to SELECTED_FROM_WISHLIST.
  santaRouter.post('/santa/campaigns/:id/inbound/reserve', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';

    const parsed = z.object({ itemId: z.string().min(1) }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);
    const { itemId } = parsed.data;

    const participant = await prisma.santaParticipant.findUnique({ where: { campaignId_userId: { campaignId, userId: user.id } } });
    if (!participant || participant.status !== 'JOINED') {
      logger.error({ campaignId, userId: user.id, status: participant?.status }, 'reserve: 403 not participant');
      return res.status(403).json({ error: 'Not a participant' });
    }

    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { status: true, currentRoundId: true } });
    if (!campaign || campaign.status !== 'ACTIVE') {
      logger.error({ campaignId, status: campaign?.status }, 'reserve: 409 campaign not ACTIVE');
      return res.status(409).json({ error: 'Campaign not ACTIVE', message: `Campaign status is ${campaign?.status ?? 'not found'}` });
    }
    if (!campaign.currentRoundId) {
      logger.error({ campaignId }, 'reserve: 404 no active round');
      return res.status(404).json({ error: 'No active round' });
    }

    const roundId = campaign.currentRoundId;
    const assignment = await prisma.santaAssignment.findUnique({
      where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
      select: { id: true, giftStatus: true, receiver: { select: { linkedWishlistId: true } } },
    });
    if (!assignment) {
      logger.error({ roundId, participantId: participant.id }, 'reserve: 404 assignment not found');
      return res.status(404).json({ error: 'Assignment not found' });
    }

    // Terminal states: cannot reserve after SENT/RECEIVED
    if (['SENT', 'RECEIVED'].includes(assignment.giftStatus)) {
      return res.status(409).json({ error: 'invalid_state', message: `Cannot reserve items when gift status is ${assignment.giftStatus}` });
    }

    // Validate item belongs to receiver's wishlist
    const receiverWishlistId = assignment.receiver.linkedWishlistId;
    if (!receiverWishlistId) {
      logger.error({ assignmentId: assignment.id }, 'reserve: 409 receiver has no wishlist');
      return res.status(409).json({ error: 'receiver_no_wishlist', message: 'Receiver has no linked wishlist' });
    }

    const item = await prisma.item.findFirst({
      where: { id: itemId, wishlistId: receiverWishlistId, status: { in: ['AVAILABLE', 'RESERVED', 'PURCHASED'] } },
      select: { id: true, title: true },
    });
    if (!item) {
      logger.error({ itemId, receiverWishlistId }, 'reserve: 404 item not found');
      return res.status(404).json({ error: 'Item not found or not reservable' });
    }

    // Create reservation — explicit create+catch for idempotency (avoids upsert with empty update which can be unreliable)
    try {
      await prisma.santaItemReservation.create({ data: { assignmentId: assignment.id, itemId } });
    } catch (e: unknown) {
      // P2002 = unique constraint violation — item already reserved by this assignment (idempotent)
      const prismaErr = e as { code?: string };
      if (prismaErr.code !== 'P2002') throw e;
    }

    // Auto-sync gift status to SELECTED_FROM_WISHLIST if not already in a committed state
    const syncableStatuses = ['PENDING', 'BUYING', 'MISSED_DEADLINE', 'SELECTED_OUTSIDE', 'DECLINED_TO_SAY'];
    if (syncableStatuses.includes(assignment.giftStatus)) {
      await prisma.santaAssignment.update({
        where: { id: assignment.id },
        data: { giftStatus: 'SELECTED_FROM_WISHLIST' },
      });
      await prisma.santaGiftProgress.create({ data: { assignmentId: assignment.id, status: 'SELECTED_FROM_WISHLIST' } });
    }

    // Return updated reservation list
    const reservations = await prisma.santaItemReservation.findMany({
      where: { assignmentId: assignment.id },
      select: { itemId: true, item: { select: { title: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return res.json({
      ok: true,
      reservedItemIds: reservations.map(r => r.itemId),
      myReservations: reservations.map(r => ({ id: r.itemId, title: r.item.title })),
    });
  }));

  // DELETE /tg/santa/campaigns/:id/inbound/reserve/:itemId — giver removes a wishlist reservation
  // Auto-syncs gift status back to PENDING if no reservations remain.
  santaRouter.delete('/santa/campaigns/:id/inbound/reserve/:itemId', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    const itemId = req.params.itemId ?? '';
    if (!itemId) return res.status(400).json({ error: 'Missing itemId' });

    const participant = await prisma.santaParticipant.findUnique({ where: { campaignId_userId: { campaignId, userId: user.id } } });
    if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { status: true, currentRoundId: true } });
    if (!campaign || campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Campaign not ACTIVE' });
    if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });

    const roundId = campaign.currentRoundId;
    const assignment = await prisma.santaAssignment.findUnique({
      where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
      select: { id: true, giftStatus: true },
    });
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

    // Delete reservation (idempotent — no error if not found)
    await prisma.santaItemReservation.deleteMany({
      where: { assignmentId: assignment.id, itemId },
    });

    // Count remaining reservations
    const remainingCount = await prisma.santaItemReservation.count({ where: { assignmentId: assignment.id } });

    // Auto-sync: if no reservations remain AND status is SELECTED_FROM_WISHLIST → revert to PENDING
    if (remainingCount === 0 && assignment.giftStatus === 'SELECTED_FROM_WISHLIST') {
      await prisma.santaAssignment.update({
        where: { id: assignment.id },
        data: { giftStatus: 'PENDING' },
      });
      await prisma.santaGiftProgress.create({ data: { assignmentId: assignment.id, status: 'PENDING' } });
    }

    // Return updated reservation list
    const reservations = await prisma.santaItemReservation.findMany({
      where: { assignmentId: assignment.id },
      select: { itemId: true, item: { select: { title: true } } },
      orderBy: { createdAt: 'asc' },
    });

    return res.json({
      ok: true,
      reservedItemIds: reservations.map(r => r.itemId),
      myReservations: reservations.map(r => ({ id: r.itemId, title: r.item.title })),
    });
  }));

  // GET /tg/santa/campaigns/:id/inbound/status — receiver gets their inbound gift signal
  // Role: receiver only. Returns COARSE signal WITHOUT giver identity. Campaign-centric addressing.
  // Batch 3: returns semantic signal + canConfirmReceived + canReveal flags. Raw giftStatus never exposed.
  santaRouter.get('/santa/campaigns/:id/inbound/status', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';

    const participant = await prisma.santaParticipant.findUnique({
      where: { campaignId_userId: { campaignId, userId: user.id } },
    });
    if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

    const campaign = await prisma.santaCampaign.findUnique({
      where: { id: campaignId },
      select: { status: true, currentRoundId: true },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!['ACTIVE', 'COMPLETED'].includes(campaign.status)) {
      return res.json({ hasGiver: false, signal: 'waiting', canConfirmReceived: false, canReveal: false, campaignStatus: campaign.status });
    }
    if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });

    const roundId = campaign.currentRoundId;
    // Resolve via receiver side — campaign-centric, NOT assignment-id-centric
    const assignment = await prisma.santaAssignment.findUnique({
      where: { roundId_receiverParticipantId: { roundId, receiverParticipantId: participant.id } },
      // ONLY giftStatus + revealedAt — no giverParticipantId EVER exposed to receiver
      select: { giftStatus: true, revealedAt: true },
    });
    if (!assignment) return res.json({ hasGiver: false, signal: 'waiting', canConfirmReceived: false, canReveal: false });

    const signal = giftStatusToInboundSignal(assignment.giftStatus);
    return res.json({
      hasGiver: true,
      signal,
      canConfirmReceived: assignment.giftStatus === 'SENT',
      canReveal: assignment.giftStatus === 'RECEIVED',
      // revealedAt tells the frontend whether reveal was already viewed (no re-animation)
      revealedAt: assignment.revealedAt?.toISOString() ?? null,
    });
  }));

  // GET /tg/santa/campaigns/:id/assignment — giver's own assignment summary (role-aware)
  santaRouter.get('/santa/campaigns/:id/assignment', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';

    const participant = await prisma.santaParticipant.findUnique({
      where: { campaignId_userId: { campaignId, userId: user.id } },
    });
    if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

    const campaign = await prisma.santaCampaign.findUnique({
      where: { id: campaignId },
      select: { ownerId: true, status: true, currentRoundId: true },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

    const isOwner = campaign.ownerId === user.id;

    if (!['ACTIVE', 'COMPLETED'].includes(campaign.status)) {
      return res.json({ status: campaign.status, ready: false });
    }
    if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });
    const roundId = campaign.currentRoundId;

    // Owner: return aggregate progress only
    if (isOwner) {
      const allAssignments = await prisma.santaAssignment.findMany({
        where: { roundId },
        select: { giftStatus: true },
      });
      // Count receivers (participants) without a linked wishlist for owner context
      const participantsWithoutWishlist = await prisma.santaParticipant.count({
        where: { campaignId, status: 'JOINED', linkedWishlistId: null },
      });
      return res.json({ ready: true, ...serializeAssignment('owner', { assignments: allAssignments, receiverWithoutWishlistCount: participantsWithoutWishlist }) });
    }

    // Giver view
    const giverAssignment = await prisma.santaAssignment.findUnique({
      where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
      select: {
        giftStatus: true,
        giftNote: true,
        receiver: {
          select: {
            id: true,               // needed for alias lookup
            linkedWishlistId: true,
          },
        },
      },
    });
    if (!giverAssignment) return res.json({ ready: false, role: 'giver' });

    const assignmentAliasMap = await loadSantaAliasMap(roundId);
    const receiverAlias = resolveSantaAlias(assignmentAliasMap, giverAssignment.receiver.id);

    return res.json({
      ready: true,
      ...serializeAssignment('giver', {
        giftStatus: giverAssignment.giftStatus,
        giftNote: giverAssignment.giftNote,
        receiver: {
          displayName: receiverAlias.alias,
          avatarUrl: null,
          emoji: receiverAlias.emoji,
          adjectiveKey: receiverAlias.adjectiveKey,
          animalKey: receiverAlias.animalKey,
          hasLinkedWishlist: !!giverAssignment.receiver.linkedWishlistId,
        },
      }),
    });
  }));

  // GET /tg/santa/campaigns/:id/reveal — receiver reveals their Secret Santa identity
  // Batch 3: gate is per-receiver RECEIVED (NOT campaign COMPLETED). Tracks revealedAt on first view.
  // ANONYMITY: giver identity ONLY exposed after receiver's own giftStatus === RECEIVED.
  santaRouter.get('/santa/campaigns/:id/reveal', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';

    const participant = await prisma.santaParticipant.findUnique({
      where: { campaignId_userId: { campaignId, userId: user.id } },
    });
    if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

    const campaign = await prisma.santaCampaign.findUnique({
      where: { id: campaignId },
      select: { status: true, currentRoundId: true },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!['ACTIVE', 'COMPLETED'].includes(campaign.status)) {
      return res.status(409).json({ error: 'reveal_not_available', campaignStatus: campaign.status });
    }
    if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });
    const roundId = campaign.currentRoundId;

    // Receiver-side lookup — assignment is resolved from the receiver's participant record
    const receiverAssignment = await prisma.santaAssignment.findUnique({
      where: { roundId_receiverParticipantId: { roundId, receiverParticipantId: participant.id } },
      select: {
        id: true,
        giftStatus: true,
        revealedAt: true,
        giftNote: true,
        giver: {
          select: {
            id: true,   // needed for alias lookup
          },
        },
      },
    });

    if (!receiverAssignment) {
      return res.status(409).json({ error: 'reveal_not_available', reason: 'no_assignment' });
    }

    // Gate: receiver must have confirmed RECEIVED — personal reveal, not campaign-level
    if (receiverAssignment.giftStatus !== 'RECEIVED') {
      return res.status(409).json({
        error: 'reveal_not_available',
        reason: 'gift_not_received',
        signal: giftStatusToInboundSignal(receiverAssignment.giftStatus),
      });
    }

    // Track first reveal view — best-effort, non-blocking
    const isFirstReveal = !receiverAssignment.revealedAt;
    if (isFirstReveal) {
      await prisma.santaAssignment.update({
        where: { id: receiverAssignment.id },
        data: { revealedAt: new Date() },
      }).catch(() => { /* non-fatal — revealedAt is cosmetic tracking */ });
    }

    // Reveal stays alias-only forever — no real identity disclosed, not even post-reveal
    const aliasMap = await loadSantaAliasMap(roundId);
    const giverAlias = resolveSantaAlias(aliasMap, receiverAssignment.giver.id);

    return res.json({
      revealed: true,
      isFirstReveal,
      giver: {
        displayName: giverAlias.alias,   // alias — real name never exposed
        avatarUrl: null,                  // never expose real photo
        emoji: giverAlias.emoji,
        adjectiveKey: giverAlias.adjectiveKey,
        animalKey: giverAlias.animalKey,
      },
      giftNote: receiverAssignment.giftNote ?? null,
      revealedAt: receiverAssignment.revealedAt?.toISOString() ?? new Date().toISOString(),
    });
  }));

  // POST /tg/santa/campaigns/:id/hints — giver requests a hint
  //
  // Quota model (Conservative pricing patch, 2026-05-28):
  //   FREE — 1 hint request per campaign (any status counts — request once,
  //          live with the outcome). Beyond that returns 402 pro_required.
  //   PRO  — unlimited.
  //
  // Idempotency: re-posting while a PENDING request exists returns the same
  // row at 200 (no new charge against the FREE allowance). EXPIRED / CANCELLED
  // requests DO count against the FREE allowance — that is the explicit
  // trade-off for opening this feature to FREE without unbounded retries.
  //
  // Race protection: the PENDING-idempotency lookup + quota count + insert
  // run in a Serializable transaction so two concurrent POSTs from the same
  // FREE user can't both pass `previousCount < 1` and double-create. Postgres
  // surfaces a serialization conflict as Prisma P2034 — we map it to 409 with
  // a dedicated `code` so the FE retries cleanly with a fresh Idempotency-Key
  // (same pattern as POST /tg/wishlists/:id/categories).
  santaRouter.post('/santa/campaigns/:id/hints', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';

    // 1. Participant lookup
    const participant = await prisma.santaParticipant.findUnique({
      where: { campaignId_userId: { campaignId, userId: user.id } },
    });
    if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

    // 2. Campaign must be ACTIVE
    const campaign = await prisma.santaCampaign.findUnique({
      where: { id: campaignId },
      select: { status: true, currentRoundId: true },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'campaign_not_active', message: 'Hint requests can only be sent in ACTIVE campaigns' });
    if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });
    const roundId = campaign.currentRoundId;

    // 3. Resolve giver's assignment (giver-centric: roundId + giverParticipantId)
    const assignment = await prisma.santaAssignment.findUnique({
      where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
      select: { id: true, receiverParticipantId: true, receiver: { select: { linkedWishlistId: true } } },
    });
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

    // 4. Receiver must have a linked wishlist — no point in requesting a hint otherwise
    if (!assignment.receiver.linkedWishlistId) {
      return res.status(409).json({ error: 'receiver_no_wishlist', message: 'Your gift recipient has no linked wishlist' });
    }

    // 5. Resolve entitlement before the txn so the read happens once.
    const ent = await getUserEntitlement(user.id, user.godMode);

    // 6. Idempotency + FREE quota + insert under Serializable isolation.
    //    Outcome shape mirrors the categories handler so the caller branches
    //    once on `kind` instead of unpacking partial results.
    type HintOutcome =
      | { kind: 'idempotent'; existing: NonNullable<Awaited<ReturnType<typeof prisma.santaHintRequest.findFirst>>> }
      | { kind: 'over_quota'; previousCount: number }
      | { kind: 'created'; hint: Awaited<ReturnType<typeof prisma.santaHintRequest.create>> };

    let outcome: HintOutcome | { kind: 'conflict' };
    try {
      outcome = await prisma.$transaction(
        async (tx): Promise<HintOutcome> => {
          // 6a. PENDING idempotency — return existing row without consuming quota.
          const existing = await tx.santaHintRequest.findFirst({
            where: { assignmentId: assignment.id, status: 'PENDING' },
          });
          if (existing) return { kind: 'idempotent', existing };

          // 6b. FREE 1/campaign quota check. PRO/godMode short-circuit.
          if (!ent.isPro) {
            const previousCount = await tx.santaHintRequest.count({
              where: { campaignId, giverParticipantId: participant.id },
            });
            if (previousCount >= 1) return { kind: 'over_quota', previousCount };
          }

          // 6c. Create hint request with 48h TTL.
          const expiresAt = new Date(Date.now() + SANTA_HINT_TTL_HOURS * 60 * 60 * 1000);
          const hint = await tx.santaHintRequest.create({
            data: {
              campaignId,
              roundId,
              assignmentId: assignment.id,
              giverParticipantId: participant.id,
              receiverParticipantId: assignment.receiverParticipantId,
              status: 'PENDING',
              expiresAt,
            },
          });
          return { kind: 'created', hint };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') {
        outcome = { kind: 'conflict' };
      } else {
        throw err;
      }
    }

    if (outcome.kind === 'idempotent') {
      return res.status(200).json(serializeSantaHintForGiver(outcome.existing));
    }
    if (outcome.kind === 'over_quota') {
      trackProductEvent({
        event: 'santa.gate_hit',
        userId: user.id,
        props: {
          feature: 'santa_hint',
          plan: ent.plan.code,
          limit: 1,
          previousCount: outcome.previousCount,
          campaignId,
        },
      });
      return sendPaywall(res, 402, makeProRequired('santa_hint', {
        planCode: ent.plan.code,
        paywallTag: 'santa_hint',
        message: 'Free hint already used in this campaign',
      }));
    }
    if (outcome.kind === 'conflict') {
      return res.status(409).json({ error: 'Concurrent write conflict, please retry', code: 'SANTA_HINT_CONCURRENT_WRITE' });
    }

    const hint = outcome.hint;

    // Notification to receiver is sent by the TTL/polling loop or bot layer.
    // notificationSentAt is set by the notification sender — not here — to allow dedup on retry.

    return res.status(201).json(serializeSantaHintForGiver(hint));
  }));

  // GET /tg/santa/campaigns/:id/hints — giver polls hint status (includes fulfilled item preview)
  santaRouter.get('/santa/campaigns/:id/hints', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';

    const participant = await prisma.santaParticipant.findUnique({
      where: { campaignId_userId: { campaignId, userId: user.id } },
    });
    if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

    const campaign = await prisma.santaCampaign.findUnique({
      where: { id: campaignId },
      select: { status: true, currentRoundId: true },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!['ACTIVE', 'COMPLETED'].includes(campaign.status)) return res.status(409).json({ error: 'Campaign not ACTIVE or COMPLETED' });
    if (!campaign.currentRoundId) return res.status(404).json({ error: 'No active round' });
    const roundId = campaign.currentRoundId;

    // Giver-centric assignment lookup
    const assignment = await prisma.santaAssignment.findUnique({
      where: { roundId_giverParticipantId: { roundId, giverParticipantId: participant.id } },
      select: { id: true },
    });
    if (!assignment) return res.status(404).json({ error: 'Assignment not found' });

    // Most recent hint for this assignment. No endpoint currently deletes
    // SantaHintRequest rows, so the "most recent" here is functionally
    // identical to "latest by requestedAt". If a draw-reset endpoint ever
    // lands and chooses to cascade-delete hints, this query keeps working
    // because it's a per-assignment lookup (cascade-deleted rows would just
    // disappear; the FREE giver allowance — separately enforced in the POST
    // handler — would then refresh as a side effect).
    const hint = await prisma.santaHintRequest.findFirst({
      where: { assignmentId: assignment.id },
      orderBy: { requestedAt: 'desc' },
    });
    if (!hint) return res.json({ hint: null });

    // Resolve item details for FULFILLED hints
    let itemsMap: Map<string, { id: string; title: string; priceText: string | null; url: string | null }> | undefined;
    if (hint.status === 'FULFILLED' && Array.isArray(hint.selectedItemIds) && hint.selectedItemIds.length > 0) {
      const ids = hint.selectedItemIds as string[];
      const items = await prisma.item.findMany({
        where: { id: { in: ids } },
        select: { id: true, title: true, priceText: true, url: true },
      });
      itemsMap = new Map(items.map(i => [i.id, i]));
    }

    return res.json({ hint: serializeSantaHintForGiver(hint, itemsMap) });
  }));

  // GET /tg/santa/campaigns/:id/inbound/hint — receiver checks for pending hint request
  // Role: receiver only. Anonymity: NEVER exposes giverParticipantId or giverUserId.
  santaRouter.get('/santa/campaigns/:id/inbound/hint', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';

    const participant = await prisma.santaParticipant.findUnique({
      where: { campaignId_userId: { campaignId, userId: user.id } },
    });
    if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

    const campaign = await prisma.santaCampaign.findUnique({
      where: { id: campaignId },
      select: { status: true },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Campaign not ACTIVE' });

    // Campaign-centric receiver lookup — receiverParticipantId, never assignmentId
    // Returns the most recently created PENDING hint (there should be at most one per assignment,
    // but we guard against duplicates by taking the latest)
    const hint = await prisma.santaHintRequest.findFirst({
      where: { campaignId, receiverParticipantId: participant.id, status: 'PENDING' },
      orderBy: { requestedAt: 'desc' },
    });

    return res.json(serializeSantaHintInboundForReceiver(hint));
  }));

  // POST /tg/santa/campaigns/:id/inbound/hint/fulfill — receiver selects 1–3 items, marks hint FULFILLED
  santaRouter.post('/santa/campaigns/:id/inbound/hint/fulfill', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';

    const parsed = z.object({
      hintId: z.string().min(1),
      selectedItemIds: z.array(z.string().min(1)).min(1).max(SANTA_HINT_MAX_ITEMS),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_body', details: parsed.error.flatten() });

    const { hintId, selectedItemIds } = parsed.data;

    const participant = await prisma.santaParticipant.findUnique({
      where: { campaignId_userId: { campaignId, userId: user.id } },
      select: { id: true, status: true, linkedWishlistId: true },
    });
    if (!participant || participant.status !== 'JOINED') return res.status(403).json({ error: 'Not a participant' });

    const campaign = await prisma.santaCampaign.findUnique({
      where: { id: campaignId },
      select: { status: true },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Campaign not ACTIVE' });

    // Fetch hint — must belong to this receiver and be PENDING
    const hint = await prisma.santaHintRequest.findUnique({
      where: { id: hintId },
      select: { id: true, campaignId: true, receiverParticipantId: true, status: true, expiresAt: true },
    });
    if (!hint) return res.status(404).json({ error: 'Hint not found' });
    // Verify ownership (campaignId + receiverParticipantId) — never trust hintId alone
    if (hint.campaignId !== campaignId) return res.status(404).json({ error: 'Hint not found' });
    if (hint.receiverParticipantId !== participant.id) return res.status(403).json({ error: 'Forbidden' });
    if (hint.status !== 'PENDING') return res.status(409).json({ error: 'hint_not_pending', message: `Hint status is ${hint.status}` });
    if (hint.expiresAt <= new Date()) return res.status(409).json({ error: 'hint_expired', message: 'Hint TTL exceeded; request a new one' });

    // Receiver must have a linked wishlist to select from
    if (!participant.linkedWishlistId) {
      return res.status(409).json({ error: 'no_linked_wishlist', message: 'Link a wishlist to your Secret Santa profile first' });
    }

    // Validate: all selectedItemIds must belong to receiver's current linked wishlist and be AVAILABLE
    // This guards against stale selections (wishlist changed between request and fulfill)
    const validItems = await prisma.item.findMany({
      where: { id: { in: selectedItemIds }, wishlistId: participant.linkedWishlistId, status: 'AVAILABLE' },
      select: { id: true },
    });
    if (validItems.length !== selectedItemIds.length) {
      return res.status(400).json({
        error: 'invalid_items',
        message: 'Some selected items are not available in your linked wishlist',
      });
    }

    // Mark FULFILLED
    await prisma.santaHintRequest.update({
      where: { id: hintId },
      data: { status: 'FULFILLED', selectedItemIds, fulfilledAt: new Date() },
    });

    // Notify giver — deduped via notificationSentAt on the hint record (handled by bot polling layer)

    return res.json({ ok: true });
  }));

  // GET /tg/santa/campaigns/:id/chat — list messages (keyset pagination)
  // Read access: JOINED or LEFT participants only (REMOVED cannot read; owner via participant record)
  santaRouter.get('/santa/campaigns/:id/chat', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

    const participant = await prisma.santaParticipant.findFirst({
      where: { campaignId, userId: user.id },
      select: { id: true, status: true },
    });
    // REMOVED participants cannot read chat history
    if (!participant || participant.status === 'REMOVED') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const rawLimit = Math.min(parseInt(String(req.query.limit ?? '50'), 10) || 50, 100);
    const before = typeof req.query.before === 'string' ? req.query.before : null;

    // Keyset pagination: resolve cursor message's (createdAt, id) for stable compound comparison
    let cursorCreatedAt: Date | null = null;
    let cursorId: string | null = null;
    if (before) {
      const cursorMsg = await prisma.santaChatMessage.findUnique({
        where: { id: before },
        select: { createdAt: true, id: true },
      });
      if (cursorMsg) {
        cursorCreatedAt = cursorMsg.createdAt;
        cursorId = cursorMsg.id;
      }
    }

    // Load alias map for current round (chat always uses aliases)
    const chatCampaign = await prisma.santaCampaign.findUnique({
      where: { id: campaignId },
      select: { currentRoundId: true },
    });
    const chatAliasMap = chatCampaign?.currentRoundId
      ? await loadSantaAliasMap(chatCampaign.currentRoundId)
      : new Map<string, SantaAliasRecord>();

    const messages = await prisma.santaChatMessage.findMany({
      where: {
        campaignId,
        ...(cursorCreatedAt && cursorId
          ? {
              OR: [
                { createdAt: { lt: cursorCreatedAt } },
                { createdAt: cursorCreatedAt, id: { lt: cursorId } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: rawLimit + 1,
      select: {
        id: true, messageType: true, body: true, systemEvent: true, payload: true, createdAt: true,
        participantId: true,
        participant: {
          select: {
            userId: true,
            user: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
          },
        },
      },
    });

    const hasMore = messages.length > rawLimit;
    if (hasMore) messages.pop();

    // Unread count (keyset-consistent with read cursor)
    const chatCursor = await prisma.santaChatReadCursor.findUnique({
      where: { campaignId_participantId: { campaignId, participantId: participant.id } },
      select: { lastReadMessageId: true },
    });
    let totalUnread = 0;
    if (!chatCursor?.lastReadMessageId) {
      totalUnread = await prisma.santaChatMessage.count({ where: { campaignId } });
    } else {
      const lastRead = await prisma.santaChatMessage.findUnique({
        where: { id: chatCursor.lastReadMessageId },
        select: { createdAt: true, id: true },
      });
      if (lastRead) {
        totalUnread = await prisma.santaChatMessage.count({
          where: {
            campaignId,
            OR: [
              { createdAt: { gt: lastRead.createdAt } },
              { createdAt: lastRead.createdAt, id: { gt: lastRead.id } },
            ],
          },
        });
      } else {
        totalUnread = await prisma.santaChatMessage.count({ where: { campaignId } });
      }
    }

    const isMuted = !!(await prisma.santaChatMute.findUnique({
      where: { campaignId_participantId: { campaignId, participantId: participant.id } },
      select: { id: true },
    }));

    return res.json({
      messages: messages.map(m => serializeChatMessage(m, user.id, chatAliasMap)),
      hasMore,
      totalUnread,
      isMuted,
    });
  }));

  // POST /tg/santa/campaigns/:id/chat — send a user message
  // Write access: JOINED participants only + campaign in (OPEN, LOCKED, ACTIVE)
  santaRouter.post('/santa/campaigns/:id/chat', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

    const parsed = z.object({
      body: z.string().min(1).max(1000),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const campaign = await prisma.santaCampaign.findUnique({
      where: { id: campaignId },
      select: { status: true, currentRoundId: true },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!['OPEN', 'LOCKED', 'ACTIVE'].includes(campaign.status)) {
      return res.status(409).json({ error: 'Chat is read-only for this campaign status' });
    }

    const participant = await prisma.santaParticipant.findFirst({
      where: { campaignId, userId: user.id },
      select: { id: true, status: true },
    });
    if (!participant || participant.status !== 'JOINED') {
      return res.status(403).json({ error: 'Only joined participants can send messages' });
    }

    const msg = await prisma.santaChatMessage.create({
      data: {
        campaignId,
        participantId: participant.id,
        body: parsed.data.body,
        messageType: 'USER',
      },
      select: {
        id: true, messageType: true, body: true, systemEvent: true, payload: true, createdAt: true,
        participantId: true,
        participant: {
          select: {
            userId: true,
            user: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
          },
        },
      },
    });

    // Load alias map for response serialization
    const sendAliasMap = campaign.currentRoundId
      ? await loadSantaAliasMap(campaign.currentRoundId)
      : new Map<string, SantaAliasRecord>();
    const senderAlias = resolveSantaAlias(sendAliasMap, participant.id);

    // CHAT_MESSAGE notification — batch, non-blocking, mute-aware
    void (async () => {
      try {
        const [joinedParticipants, mutedEntries] = await Promise.all([
          prisma.santaParticipant.findMany({
            where: { campaignId, status: 'JOINED' },
            select: { id: true, userId: true },
          }),
          prisma.santaChatMute.findMany({ where: { campaignId }, select: { participantId: true } }),
        ]);
        const mutedIds = new Set(mutedEntries.map(m => m.participantId));

        const notifData = joinedParticipants
          .filter(p => p.userId !== user.id && !mutedIds.has(p.id))
          .map(p => ({
            campaignId,
            userId: p.userId,
            type: 'CHAT_MESSAGE' as const,
            payload: { messageId: msg.id, senderName: senderAlias.alias },
          }));
        if (notifData.length > 0) {
          await prisma.santaNotification.createMany({ data: notifData, skipDuplicates: false });
        }
      } catch {}
    })();

    return res.json({ message: serializeChatMessage(msg, user.id, sendAliasMap) });
  }));

  // POST /tg/santa/campaigns/:id/chat/read — mark messages as read (upsert cursor)
  santaRouter.post('/santa/campaigns/:id/chat/read', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

    const parsed = z.object({
      lastReadMessageId: z.string().min(1),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const participant = await prisma.santaParticipant.findFirst({
      where: { campaignId, userId: user.id },
      select: { id: true, status: true },
    });
    if (!participant || participant.status === 'REMOVED') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Verify the referenced message exists in this campaign
    const msgExists = await prisma.santaChatMessage.findFirst({
      where: { id: parsed.data.lastReadMessageId, campaignId },
      select: { id: true },
    });
    if (!msgExists) return res.status(404).json({ error: 'Message not found' });

    await prisma.santaChatReadCursor.upsert({
      where: { campaignId_participantId: { campaignId, participantId: participant.id } },
      update: { lastReadMessageId: parsed.data.lastReadMessageId, lastReadAt: new Date() },
      create: {
        campaignId,
        participantId: participant.id,
        lastReadMessageId: parsed.data.lastReadMessageId,
        lastReadAt: new Date(),
      },
    });

    return res.json({ ok: true });
  }));

  // POST /tg/santa/campaigns/:id/mute — mute chat notifications for this campaign
  santaRouter.post('/santa/campaigns/:id/mute', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

    const participant = await prisma.santaParticipant.findFirst({
      where: { campaignId, userId: user.id },
      select: { id: true, status: true },
    });
    if (!participant || participant.status !== 'JOINED') {
      return res.status(403).json({ error: 'Only joined participants can mute' });
    }

    await prisma.santaChatMute.upsert({
      where: { campaignId_participantId: { campaignId, participantId: participant.id } },
      update: { mutedAt: new Date() },
      create: { campaignId, participantId: participant.id },
    });

    return res.json({ ok: true, isMuted: true });
  }));

  // DELETE /tg/santa/campaigns/:id/mute — unmute chat notifications
  santaRouter.delete('/santa/campaigns/:id/mute', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

    const participant = await prisma.santaParticipant.findFirst({
      where: { campaignId, userId: user.id },
      select: { id: true, status: true },
    });
    if (!participant || participant.status !== 'JOINED') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await prisma.santaChatMute.deleteMany({
      where: { campaignId, participantId: participant.id },
    });

    return res.json({ ok: true, isMuted: false });
  }));

  // GET /tg/santa/campaigns/:id/polls — list all polls for this campaign
  santaRouter.get('/santa/campaigns/:id/polls', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

    const participant = await prisma.santaParticipant.findFirst({
      where: { campaignId, userId: user.id },
      select: { id: true, status: true, userId: true },
    });
    if (!participant || participant.status === 'REMOVED') {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, currentRoundId: true } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    const isOwner = campaign.ownerId === user.id;

    const pollAliasMap = campaign.currentRoundId
      ? await loadSantaAliasMap(campaign.currentRoundId)
      : new Map<string, SantaAliasRecord>();

    const polls = await prisma.santaPoll.findMany({
      where: { campaignId },
      orderBy: { createdAt: 'desc' },
      select: POLL_SELECT,
    });

    return res.json({ polls: polls.map(p => serializePoll(p, participant.id, isOwner, pollAliasMap)) });
  }));

  // POST /tg/santa/campaigns/:id/polls — create poll (owner only, campaign ACTIVE)
  santaRouter.post('/santa/campaigns/:id/polls', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    if (!campaignId) return res.status(400).json({ error: 'Missing campaign id' });

    const parsed = z.object({
      question: z.string().min(1).max(300),
      options: z.array(z.string().min(1).max(100)).min(2).max(10),
      isAnonymous: z.boolean(),
      deadlineAt: z.string().datetime().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const campaign = await prisma.santaCampaign.findUnique({
      where: { id: campaignId },
      select: { ownerId: true, status: true, currentRoundId: true },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.status !== 'ACTIVE') return res.status(409).json({ error: 'Polls can only be created in ACTIVE campaigns' });

    const myParticipant = await prisma.santaParticipant.findFirst({
      where: { campaignId, userId: user.id, status: 'JOINED' },
      select: { id: true, status: true, role: true },
    });
    if (!isOrganizer(campaign, user.id, myParticipant)) return res.status(403).json({ error: 'Only organizers can create polls' });
    if (!myParticipant) return res.status(403).json({ error: 'Organizer must be a participant to create polls' });

    const poll = await prisma.santaPoll.create({
      data: {
        campaignId,
        question: parsed.data.question,
        options: parsed.data.options,
        isAnonymous: parsed.data.isAnonymous,
        createdByParticipantId: myParticipant.id,
        deadlineAt: parsed.data.deadlineAt ? new Date(parsed.data.deadlineAt) : null,
      },
      select: POLL_SELECT,
    });

    // System message: poll created (in chat)
    void createSystemMessage(campaignId, 'poll_created', { question: parsed.data.question.slice(0, 80) }).catch(() => {});

    // POLL_CREATED notifications — batch, mute-aware
    void (async () => {
      try {
        const [joinedParticipants, mutedEntries] = await Promise.all([
          prisma.santaParticipant.findMany({ where: { campaignId, status: 'JOINED' }, select: { id: true, userId: true } }),
          prisma.santaChatMute.findMany({ where: { campaignId }, select: { participantId: true } }),
        ]);
        const mutedIds = new Set(mutedEntries.map(m => m.participantId));
        const notifData = joinedParticipants
          .filter(p => p.userId !== user.id && !mutedIds.has(p.id))
          .map(p => ({ campaignId, userId: p.userId, type: 'POLL_CREATED' as const, payload: { pollId: poll.id } }));
        if (notifData.length > 0) {
          await prisma.santaNotification.createMany({ data: notifData, skipDuplicates: false });
        }
      } catch {}
    })();

    const createPollAliasMap = campaign.currentRoundId
      ? await loadSantaAliasMap(campaign.currentRoundId)
      : new Map<string, SantaAliasRecord>();
    return res.status(201).json({ poll: serializePoll(poll, myParticipant.id, true, createPollAliasMap) });
  }));

  // POST /tg/santa/campaigns/:id/polls/:pollId/vote — vote on a poll
  santaRouter.post('/santa/campaigns/:id/polls/:pollId/vote', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    const pollId = req.params.pollId ?? '';
    if (!campaignId || !pollId) return res.status(400).json({ error: 'Missing params' });

    const parsed = z.object({ optionIndex: z.number().int().min(0) }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const participant = await prisma.santaParticipant.findFirst({
      where: { campaignId, userId: user.id, status: 'JOINED' },
      select: { id: true },
    });
    if (!participant) return res.status(403).json({ error: 'Only joined participants can vote' });

    const poll = await prisma.santaPoll.findUnique({ where: { id: pollId, campaignId }, select: POLL_SELECT });
    if (!poll) return res.status(404).json({ error: 'Poll not found' });

    const options = poll.options as string[];
    if (parsed.data.optionIndex < 0 || parsed.data.optionIndex >= options.length) {
      return res.status(400).json({ error: 'invalid_option_index', message: `optionIndex must be 0–${options.length - 1}` });
    }

    const now = new Date();
    if (poll.closedAt || (poll.deadlineAt && poll.deadlineAt <= now)) {
      return res.status(409).json({ error: 'Poll is closed' });
    }

    // Already voted?
    const existing = poll.votes.find(v => v.participantId === participant.id);
    if (existing) return res.status(409).json({ error: 'already_voted', message: 'You have already voted on this poll' });

    await prisma.santaPollVote.create({
      data: { pollId, participantId: participant.id, optionIndex: parsed.data.optionIndex },
    });

    // Re-fetch poll with updated votes
    const updatedPoll = await prisma.santaPoll.findUnique({ where: { id: pollId }, select: POLL_SELECT });
    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, currentRoundId: true } });
    const isOwner = campaign?.ownerId === user.id;
    const votePollAliasMap = campaign?.currentRoundId
      ? await loadSantaAliasMap(campaign.currentRoundId)
      : new Map<string, SantaAliasRecord>();

    return res.json({ poll: serializePoll(updatedPoll!, participant.id, isOwner, votePollAliasMap) });
  }));

  // POST /tg/santa/campaigns/:id/polls/:pollId/close — close a poll (owner only)
  santaRouter.post('/santa/campaigns/:id/polls/:pollId/close', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    const pollId = req.params.pollId ?? '';
    if (!campaignId || !pollId) return res.status(400).json({ error: 'Missing params' });

    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, currentRoundId: true } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Only organizers can close polls' });

    const poll = await prisma.santaPoll.findUnique({ where: { id: pollId, campaignId }, select: { id: true, closedAt: true } });
    if (!poll) return res.status(404).json({ error: 'Poll not found' });

    // Idempotent: already closed → just return current state
    if (!poll.closedAt) {
      await prisma.santaPoll.update({ where: { id: pollId }, data: { closedAt: new Date() } });
    }

    const myParticipant = await prisma.santaParticipant.findFirst({
      where: { campaignId, userId: user.id },
      select: { id: true },
    });

    const closePollAliasMap = campaign.currentRoundId
      ? await loadSantaAliasMap(campaign.currentRoundId)
      : new Map<string, SantaAliasRecord>();
    const updatedPoll = await prisma.santaPoll.findUnique({ where: { id: pollId }, select: POLL_SELECT });
    return res.json({ poll: serializePoll(updatedPoll!, myParticipant?.id ?? '', true, closePollAliasMap) });
  }));

  // PATCH /tg/santa/campaigns/:id/participants/:userId/role — change participant role (owner only)
  // Admin role cannot be delegated by another admin — owner only.
  santaRouter.patch('/santa/campaigns/:id/participants/:userId/role', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    const targetUserId = req.params.userId ?? '';

    const parsed = z.object({
      role: z.enum(['PARTICIPANT', 'ADMIN']),
    }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, status: true } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    // Owner only — admins cannot promote/demote other participants
    if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can change roles' });
    if (['COMPLETED', 'CANCELLED'].includes(campaign.status)) return res.status(409).json({ error: 'Campaign is finished' });
    // Owner cannot change their own role (they own the campaign, role is irrelevant)
    if (targetUserId === user.id) return res.status(400).json({ error: 'Cannot change your own role' });

    const participant = await prisma.santaParticipant.findUnique({
      where: { campaignId_userId: { campaignId, userId: targetUserId } },
      select: { id: true, status: true, role: true },
    });
    if (!participant) return res.status(404).json({ error: 'Participant not found' });
    if (participant.status === 'REMOVED' || participant.status === 'LEFT') return res.status(409).json({ error: 'Cannot change role of a participant who has left or been removed' });

    const updated = await prisma.santaParticipant.update({
      where: { id: participant.id },
      data: { role: parsed.data.role },
      select: { id: true, userId: true, role: true, status: true },
    });
    await prisma.santaAdminAuditLog.create({
      data: { campaignId, actorId: user.id, action: 'role_changed', payload: { targetUserId, newRole: parsed.data.role } },
    });

    return res.json({ ok: true, participant: { id: updated.id, userId: updated.userId, role: updated.role, status: updated.status } });
  }));

  // GET /tg/santa/campaigns/:id/organizer/summary — rich stats for organizer (organizer only)
  santaRouter.get('/santa/campaigns/:id/organizer/summary', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';

    const campaign = await prisma.santaCampaign.findUnique({
      where: { id: campaignId },
      select: { ownerId: true, status: true, currentRoundId: true, drawAt: true },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

    // Participants
    const participants = await prisma.santaParticipant.findMany({
      where: { campaignId },
      select: {
        id: true,
        userId: true,
        status: true,
        role: true,
        joinedAt: true,
        leftAt: true,
        linkedWishlistId: true,
      },
      orderBy: { joinedAt: 'asc' },
    });

    // Load alias map; build join-order for pre-draw fallback
    const summaryAliasMap = campaign.currentRoundId
      ? await loadSantaAliasMap(campaign.currentRoundId)
      : new Map<string, SantaAliasRecord>();
    const summaryJoinOrderMap = new Map(participants.map((p, i) => [p.id, i + 1]));
    const hasSummaryAlias = summaryAliasMap.size > 0;

    // Assignment progress for current round
    let giftProgress: {
      pending: number; buying: number; selectedFromWishlist: number; selectedOutside: number;
      declinedToSay: number; sent: number; received: number; missedDeadline: number; orphaned: number;
    } | null = null;

    if (campaign.currentRoundId) {
      const assignments = await prisma.santaAssignment.findMany({
        where: { roundId: campaign.currentRoundId },
        select: { giftStatus: true },
      });
      giftProgress = {
        pending: 0, buying: 0, selectedFromWishlist: 0, selectedOutside: 0,
        declinedToSay: 0, sent: 0, received: 0, missedDeadline: 0, orphaned: 0,
      };
      for (const a of assignments) {
        if (a.giftStatus === 'PENDING') giftProgress.pending++;
        else if (a.giftStatus === 'BUYING') giftProgress.buying++;
        else if (a.giftStatus === 'SELECTED_FROM_WISHLIST') giftProgress.selectedFromWishlist++;
        else if (a.giftStatus === 'SELECTED_OUTSIDE') giftProgress.selectedOutside++;
        else if (a.giftStatus === 'DECLINED_TO_SAY') giftProgress.declinedToSay++;
        else if (a.giftStatus === 'SENT') giftProgress.sent++;
        else if (a.giftStatus === 'RECEIVED') giftProgress.received++;
        else if (a.giftStatus === 'MISSED_DEADLINE') giftProgress.missedDeadline++;
        else if (a.giftStatus === 'ORPHANED') giftProgress.orphaned++;
      }
    }

    // Pending exit requests
    const pendingExitRequests = await prisma.santaExitRequest.findMany({
      where: { campaignId, status: 'PENDING' },
      select: {
        id: true,
        participantId: true,
        reason: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    const resolveParticipantAlias = (pid: string) => hasSummaryAlias
      ? resolveSantaAlias(summaryAliasMap, pid)
      : { alias: predrawLabel(summaryJoinOrderMap.get(pid) ?? 0), emoji: '🎅', adjectiveKey: '', animalKey: '' };

    const formatParticipant = (p: typeof participants[number]) => {
      const a = resolveParticipantAlias(p.id);
      return {
        id: p.id,
        userId: p.userId,
        status: p.status,
        role: p.role,
        joinedAt: p.joinedAt.toISOString(),
        leftAt: p.leftAt?.toISOString() ?? null,
        displayName: a.alias,
        avatarUrl: null,
        emoji: a.emoji,
        adjectiveKey: a.adjectiveKey,
        animalKey: a.animalKey,
        hasLinkedWishlist: !!p.linkedWishlistId,
      };
    };

    return res.json({
      campaign: {
        status: campaign.status,
        currentRoundId: campaign.currentRoundId,
        drawAt: campaign.drawAt?.toISOString() ?? null,
      },
      participants: participants.map(formatParticipant),
      giftProgress,
      pendingExitRequests: pendingExitRequests.map(r => {
        const a = resolveParticipantAlias(r.participantId);
        return {
          id: r.id,
          participantId: r.participantId,
          displayName: a.alias,
          avatarUrl: null,
          emoji: a.emoji,
          reason: r.reason ?? null,
          createdAt: r.createdAt.toISOString(),
        };
      }),
    });
  }));

  // POST /tg/santa/campaigns/:id/exit-request — submit exit request (JOINED participants, not owner)
  santaRouter.post('/santa/campaigns/:id/exit-request', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';

    const parsed = z.object({ reason: z.string().max(300).optional() }).safeParse(req.body);
    if (!parsed.success) return zodError(res, parsed.error);

    const campaign = await prisma.santaCampaign.findUnique({
      where: { id: campaignId },
      select: { ownerId: true, status: true, currentRoundId: true },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    // Owner cannot submit an exit request (they own the campaign; use cancel instead)
    if (campaign.ownerId === user.id) return res.status(403).json({ error: 'Owner cannot submit an exit request' });
    // Only allowed when campaign is LOCKED or ACTIVE
    if (!['LOCKED', 'ACTIVE'].includes(campaign.status)) {
      return res.status(409).json({ error: 'exit_request_not_applicable', message: 'Exit requests only apply to LOCKED or ACTIVE campaigns' });
    }

    const participant = await prisma.santaParticipant.findUnique({
      where: { campaignId_userId: { campaignId, userId: user.id } },
      select: { id: true, status: true },
    });
    if (!participant || participant.status !== 'JOINED') {
      return res.status(403).json({ error: 'Only JOINED participants can submit exit requests' });
    }

    // Check for existing PENDING exit request (partial unique index enforces this at DB level too)
    const existing = await prisma.santaExitRequest.findFirst({
      where: { participantId: participant.id, status: 'PENDING' },
    });
    if (existing) return res.status(409).json({ error: 'exit_request_already_pending', requestId: existing.id });

    const exitRequest = await prisma.santaExitRequest.create({
      data: {
        campaignId,
        participantId: participant.id,
        roundId: campaign.currentRoundId ?? null,
        reason: parsed.data?.reason ?? null,
        status: 'PENDING',
      },
    });

    // Notify all organizers (owner + ADMIN participants)
    void (async () => {
      try {
        const adminParticipants = await prisma.santaParticipant.findMany({
          where: { campaignId, status: 'JOINED', role: 'ADMIN' },
          select: { userId: true },
        });
        const organizerUserIds = [
          campaign.ownerId,
          ...adminParticipants.map(p => p.userId).filter(uid => uid !== campaign.ownerId),
        ];
        if (organizerUserIds.length > 0) {
          await prisma.santaNotification.createMany({
            data: organizerUserIds.map(uid => ({
              campaignId,
              userId: uid,
              type: 'EXIT_REQUEST_SUBMITTED' as const,
              payload: { requestId: exitRequest.id, participantId: participant.id },
            })),
            skipDuplicates: true,
          });
        }
      } catch { /* best-effort */ }
    })();

    return res.status(201).json({
      exitRequest: {
        id: exitRequest.id,
        status: exitRequest.status,
        reason: exitRequest.reason,
        createdAt: exitRequest.createdAt.toISOString(),
      },
    });
  }));

  // GET /tg/santa/campaigns/:id/exit-requests — list exit requests (organizer only)
  santaRouter.get('/santa/campaigns/:id/exit-requests', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';

    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true, currentRoundId: true } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (!await checkIsOrganizer(campaignId, campaign, user.id)) return res.status(403).json({ error: 'Forbidden' });

    // Load alias map and join-order for alias resolution
    const exitAliasMap = campaign.currentRoundId
      ? await loadSantaAliasMap(campaign.currentRoundId)
      : new Map<string, SantaAliasRecord>();

    const requests = await prisma.santaExitRequest.findMany({
      where: { campaignId },
      select: {
        id: true,
        participantId: true,
        roundId: true,
        reason: true,
        status: true,
        resolvedAt: true,
        createdAt: true,
        participant: {
          select: { userId: true, status: true, joinedAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Build join-order for pre-draw fallback
    const allParticipants = await prisma.santaParticipant.findMany({
      where: { campaignId },
      select: { id: true, joinedAt: true },
      orderBy: [{ joinedAt: 'asc' }, { id: 'asc' }],
    });
    const exitJoinOrderMap = new Map(allParticipants.map((p, i) => [p.id, i + 1]));

    return res.json({
      exitRequests: requests.map(r => {
        const hasRoundAlias = exitAliasMap.size > 0;
        const pAlias = hasRoundAlias
          ? resolveSantaAlias(exitAliasMap, r.participantId)
          : { alias: predrawLabel(exitJoinOrderMap.get(r.participantId) ?? 0), emoji: '🎅', adjectiveKey: '', animalKey: '' };
        return {
          id: r.id,
          participantId: r.participantId,
          displayName: pAlias.alias,      // alias instead of real name
          avatarUrl: null,                  // never expose real photo
          emoji: pAlias.emoji,
          participantStatus: r.participant.status,
          roundId: r.roundId,
          reason: r.reason ?? null,
          status: r.status,
          resolvedAt: r.resolvedAt?.toISOString() ?? null,
          createdAt: r.createdAt.toISOString(),
        };
      }),
    });
  }));

  // POST /tg/santa/campaigns/:id/exit-requests/:requestId/approve — approve exit (owner only)
  // Owner only — admin cannot approve their own request (self-approve guard) and role management
  // is owner-scoped, so approval authority stays with owner.
  santaRouter.post('/santa/campaigns/:id/exit-requests/:requestId/approve', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    const requestId = req.params.requestId ?? '';

    const campaign = await prisma.santaCampaign.findUnique({
      where: { id: campaignId },
      select: { ownerId: true, status: true, currentRoundId: true },
    });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can approve exit requests' });

    const exitRequest = await prisma.santaExitRequest.findUnique({
      where: { id: requestId },
      select: { id: true, campaignId: true, participantId: true, status: true },
    });
    if (!exitRequest || exitRequest.campaignId !== campaignId) return res.status(404).json({ error: 'Exit request not found' });
    if (exitRequest.status !== 'PENDING') return res.status(409).json({ error: 'Exit request is not pending' });

    const participant = await prisma.santaParticipant.findUnique({
      where: { id: exitRequest.participantId },
      select: { id: true, userId: true, status: true },
    });
    if (!participant) return res.status(404).json({ error: 'Participant not found' });

    // M1: one-to-one warning — if approving this exit would leave only 1 JOINED participant
    const remainingJoinedCount = await prisma.santaParticipant.count({
      where: { campaignId, status: 'JOINED', id: { not: participant.id } },
    });
    const warning = remainingJoinedCount === 1 ? 'only_one_participant_remaining' : undefined;

    const now = new Date();

    // Approval transaction:
    // 1. Mark exit request as APPROVED
    // 2. Set participant status → LEFT (voluntary exit with organizer approval, not forced removal)
    // 3. If ACTIVE campaign + participant has non-terminal assignments in current round → ORPHANED
    await prisma.$transaction(async (tx) => {
      await tx.santaExitRequest.update({
        where: { id: requestId },
        data: { status: 'APPROVED', resolvedAt: now },
      });
      await tx.santaParticipant.update({
        where: { id: participant.id },
        data: { status: 'LEFT', leftAt: now },
      });
      // If there's an active round, orphan any non-terminal assignments from this participant
      if (campaign.status === 'ACTIVE' && campaign.currentRoundId) {
        await tx.santaAssignment.updateMany({
          where: {
            roundId: campaign.currentRoundId,
            giverParticipantId: participant.id,
            giftStatus: { notIn: ['RECEIVED', 'MISSED_DEADLINE', 'ORPHANED'] as never[] },
          },
          data: { giftStatus: 'ORPHANED' },
        });
      }
      // Deny any other PENDING exit requests from the same participant (shouldn't exist due to unique index, but be safe)
      await tx.santaExitRequest.updateMany({
        where: { participantId: participant.id, status: 'PENDING', id: { not: requestId } },
        data: { status: 'DENIED', resolvedAt: now },
      });
    });

    // Notify the participant that their request was approved
    void prisma.santaNotification.create({
      data: {
        campaignId,
        userId: participant.userId,
        type: 'EXIT_REQUEST_APPROVED',
        payload: { requestId },
      },
    }).catch(() => {});

    // System message in chat (participant_left — they chose to leave, organizer approved)
    const participantUser = await prisma.user.findUnique({
      where: { id: participant.userId },
      select: { firstName: true, profile: { select: { displayName: true } } },
    });
    const displayName = participantUser?.profile?.displayName || participantUser?.firstName || 'Someone';
    void createSystemMessage(campaignId, 'participant_left', { displayName }).catch(() => {});

    return res.json({ ok: true, exitRequest: { id: requestId, status: 'APPROVED' }, ...(warning ? { warning } : {}) });
  }));

  // POST /tg/santa/campaigns/:id/exit-requests/:requestId/deny — deny exit (owner only)
  santaRouter.post('/santa/campaigns/:id/exit-requests/:requestId/deny', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
    const campaignId = req.params.id ?? '';
    const requestId = req.params.requestId ?? '';

    const campaign = await prisma.santaCampaign.findUnique({ where: { id: campaignId }, select: { ownerId: true } });
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.ownerId !== user.id) return res.status(403).json({ error: 'Only the campaign owner can deny exit requests' });

    const exitRequest = await prisma.santaExitRequest.findUnique({
      where: { id: requestId },
      select: { id: true, campaignId: true, participantId: true, status: true },
    });
    if (!exitRequest || exitRequest.campaignId !== campaignId) return res.status(404).json({ error: 'Exit request not found' });
    if (exitRequest.status !== 'PENDING') return res.status(409).json({ error: 'Exit request is not pending' });

    const participant = await prisma.santaParticipant.findUnique({
      where: { id: exitRequest.participantId },
      select: { userId: true },
    });

    await prisma.santaExitRequest.update({
      where: { id: requestId },
      data: { status: 'DENIED', resolvedAt: new Date() },
    });

    // Notify the participant that their request was denied
    if (participant) {
      void prisma.santaNotification.create({
        data: {
          campaignId,
          userId: participant.userId,
          type: 'EXIT_REQUEST_DENIED',
          payload: { requestId },
        },
      }).catch(() => {});
    }

    return res.json({ ok: true, exitRequest: { id: requestId, status: 'DENIED' } });
  }));


  return santaRouter;
}
