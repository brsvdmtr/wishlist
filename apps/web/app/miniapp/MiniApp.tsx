'use client';

import { useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo } from 'react';
import { t, detectLocale, pluralize, type Locale } from '@wishlist/shared';

// ═══════════════════════════════════════════════════════
// TELEGRAM TYPES
// ═══════════════════════════════════════════════════════

type TgUser = { id: number; first_name: string; last_name?: string; username?: string };

// ═══════════════════════════════════════════════════════
// DESIGN SYSTEM (matches prototype exactly)
// ═══════════════════════════════════════════════════════

const C = {
  bg: '#1B1B1F',
  surface: '#26262C',
  surfaceHover: '#2E2E36',
  card: '#2F2F38',
  accent: '#7C6AFF',
  accentSoft: 'rgba(124,106,255,0.12)',
  accentGlow: 'rgba(124,106,255,0.25)',
  green: '#34D399',
  greenSoft: 'rgba(52,211,153,0.12)',
  orange: '#FBBF24',
  orangeSoft: 'rgba(251,191,36,0.12)',
  red: '#F87171',
  redSoft: 'rgba(248,113,113,0.12)',
  text: '#F4F4F6',
  textSec: '#9CA3AF',
  textMuted: '#6B7280',
  border: 'rgba(255,255,255,0.06)',
  borderLight: 'rgba(255,255,255,0.1)',
};

const font = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif";

const EMOJIS = ['🎧','📖','☕','🎵','🎒','📚','🎮','👟','💄','🎨','⌚','🖥','📷','🎸','🏀','🧩','🕯','🍫','🧸','✈️'];
function getEmoji(s: string) {
  const code = [...s].reduce((h, c) => ((h << 5) - h) + c.charCodeAt(0), 0);
  return EMOJIS[Math.abs(code) % EMOJIS.length];
}

const GUEST_BUDGET_PRESETS = [3000, 5000, 10000, 25000] as const;

const getGuestBudgetPresets = (locale: Locale) => [
  { label: t('filter_all', locale), max: null },
  { label: t('filter_under_3k', locale), max: 3000 },
  { label: t('filter_under_5k', locale), max: 5000 },
  { label: t('filter_under_10k', locale), max: 10000 },
  { label: t('filter_under_25k', locale), max: 25000 },
];

// Keep for any legacy callsites
const getPriceFilters = getGuestBudgetPresets;

type GuestSort = 'default' | 'price_asc' | 'price_desc' | 'priority_desc' | 'recommended';

/** Score an item for recommended sort. Higher = better match. */
function guestRecommendedScore(item: { priority: number; status: string; imageUrl?: string | null; url?: string | null; description?: string | null; price: number | null }, budgetMax: number | null): number {
  let score = 0;
  score += (item.priority - 1) * 100;           // priority: 0/100/200
  if (item.status === 'available') score += 50;  // not reserved
  if (item.imageUrl) score += 10;
  if (item.url) score += 5;
  if (item.description) score += 5;
  if (budgetMax !== null && item.price !== null && item.price > 0 && item.price <= budgetMax) {
    score += Math.round((item.price / budgetMax) * 15); // closer to budget ceiling = small bonus
  }
  return score;
}

const PRIO_EMOJI: Record<number, string> = { 1: '🙂', 2: '😊', 3: '😍' };
// accent color per priority level: LOW=blue-violet, MEDIUM=amber, HIGH=coral-rose
const PRIO_COLOR: Record<number, string> = { 1: '#6B7FD4', 2: '#E8930A', 3: '#F04E6E' };
const PRIO_BG:    Record<number, string> = { 1: 'rgba(107,127,212,0.13)', 2: 'rgba(232,147,10,0.13)', 3: 'rgba(240,78,110,0.13)' };

const getPriorities = (locale: Locale) => [
  { value: 1, emoji: PRIO_EMOJI[1], label: t('priority_low', locale),    sub: t('priority_low_sub', locale) },
  { value: 2, emoji: PRIO_EMOJI[2], label: t('priority_medium', locale), sub: t('priority_medium_sub', locale) },
  { value: 3, emoji: PRIO_EMOJI[3], label: t('priority_high', locale),   sub: t('priority_high_sub', locale) },
];

const prioEmoji = (p: number) => PRIO_EMOJI[p] ?? '🙂';
const fmtPrice = (p: number | null, locale: Locale = 'ru', currency: 'RUB' | 'USD' = 'RUB') => {
  if (!p) return null;
  const formatted = p.toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US');
  return currency === 'USD' ? `${formatted} $` : `${formatted} ₽`;
};

/** Strip everything except digits from a user-facing price string. Returns raw digit string. */
const parsePriceFromDisplay = (value: string): string => value.replace(/\D/g, '');

/** Format a raw number/string as a thousands-separated display value (space as separator). */
const formatPriceForDisplay = (value: number | string | null | undefined): string => {
  if (value === null || value === undefined || value === '') return '';
  const digits = String(value).replace(/\D/g, '');
  if (!digits) return '';
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
};

function formatRetryAfter(seconds: number, locale: Locale): string {
  if (seconds <= 0) return t('retry_now', locale);
  let hours = Math.floor(seconds / 3600);
  let minutes = Math.ceil((seconds % 3600) / 60);
  if (minutes >= 60) { hours += 1; minutes = 0; }
  if (hours === 0) return t('retry_minutes', locale, { minutes });
  if (hours < 24) {
    return minutes > 0
      ? t('retry_hours', locale, { hours, minutes })
      : t('retry_hours_only', locale, { hours });
  }
  const d = new Date(Date.now() + seconds * 1000);
  return t('retry_tomorrow', locale, { time: d.toLocaleTimeString(locale === 'ru' ? 'ru-RU' : 'en-US', { hour: '2-digit', minute: '2-digit' }) });
}

// ═══════════════════════════════════════════════════════
// DATA TYPES
// ═══════════════════════════════════════════════════════

type WishlistVisibility = 'link_only' | 'public_profile' | 'private';
type AllowSubscriptions = 'all' | 'nobody';
type CommentPolicy = 'all' | 'subscribers';

type Wishlist = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  deadline: string | null;
  itemCount: number;
  reservedCount: number;
  readOnly?: boolean;
  visibility: WishlistVisibility;
  allowSubscriptions: AllowSubscriptions;
  commentPolicy: CommentPolicy;
  shareToken?: string | null;
};

type PlanInfo = {
  code: 'FREE' | 'PRO';
  wishlists: number;
  items: number;
  subscriptions: number;
  participants: number;
  features: string[];
};

type SubscriptionInfo = {
  id: string;
  status: 'ACTIVE' | 'CANCELLED' | 'EXPIRED';
  periodEnd: string;
  cancelledAt: string | null;
  cancelAtPeriodEnd: boolean;
} | null;

// Add-ons returned from /tg/me/plan
type AddOnsInfo = {
  extraWishlistSlots: number;
  extraSubscriptionSlots: number;
  seasonalWishlists: string[];
  extraItemsPerWishlist?: Record<string, number>;
};
type CreditsInfo = { hintCredits: number; importCredits: number };

// SKU descriptor from server
type SkuInfo = { code: string; price: number; type: string; targetRequired: boolean };

type UpsellContext =
  | 'comments' | 'url_import' | 'hints'
  | 'wishlist_limit' | 'item_limit' | 'participant_limit' | 'subscription_limit'
  | 'sort_recommended';

// UpsellSheetState carries optional wishlistId for wishlist-scoped add-on offers
type UpsellSheetState = { context: UpsellContext; wishlistId?: string } | null;

type Item = {
  id: string;
  wishlistId?: string;
  title: string;
  description: string | null;
  url: string | null;
  price: number | null;
  imageUrl: string | null;
  priority: 1 | 2 | 3;
  position: number;
  status: 'available' | 'reserved' | 'purchased' | 'completed' | 'deleted';
  sourceUrl?: string | null;
  sourceDomain?: string | null;
  importMethod?: string | null;
  currency?: 'RUB' | 'USD';
};

type GuestItem = Item & { reservedByDisplayName: string | null; reservedByActorHash: string | null };
type GlobalArchiveItem = Item & { wishlistTitle: string; wishlistId: string; wishlistIsArchived: boolean };
type ArchiveMode = 'wishlist' | 'global';

type SubscribedWishlist = {
  id: string; // subscription id
  wishlist: {
    id: string;
    slug: string;
    title: string;
    deadline: string | null;
    archivedAt: string | null;
    itemCount: number;
    ownerName: string;
    ownerAvatarUrl: string | null;
  };
  unreadCount: number;
  unreadEntityIds: string[];
};

type ReservationItem = Item & {
  ownerName: string;
  ownerAvatarUrl: string | null;
  ownerId: string;
  unreadComments: number;
};

type SantaReservationItem = Item & {
  campaignId: string;
  campaignTitle: string;
  campaignStatus: string;
  giftStatus: string;
  assignmentId: string;
};

type HomeTab = 'wishlists' | 'wishes' | 'reservations';

type AllItem = Item & {
  wishlistTitle: string;
  wishlistSlug: string;
};

type CommentDTO = {
  id: string;
  type: 'USER' | 'SYSTEM';
  authorActorHash: string | null;
  authorDisplayName: string | null;
  text: string;
  reservationEpoch: number;
  createdAt: string;
};

type SantaCampaignStatus = 'DRAFT' | 'OPEN' | 'LOCKED' | 'DRAW_IN_PROGRESS' | 'ACTIVE' | 'COMPLETED' | 'CANCELLED';

type SantaCampaignSummary = {
  id: string;
  title: string;
  status: SantaCampaignStatus;
  type: 'CLASSIC' | 'MULTI_WAVE';
  seasonYear: number;
  createdAt: string;
  participantCount: number;
  ownerName?: string | null;
};

type SantaParticipant = {
  id: string;
  status: string;
  role: 'PARTICIPANT' | 'ADMIN';
  joinedAt: string;
  userId: string;
  isMe: boolean;  // P0-A: set by API (p.user.id === req.user.id); do NOT compare userId vs tgUser.id (different ID systems)
  displayName: string | null;  // populated with alias (not real name)
  avatarUrl: null;             // always null in Santa context — use emoji avatar
  emoji: string;               // animal emoji for anonymous avatar
  adjectiveKey: string;        // locale-independent key for frontend re-rendering
  animalKey: string;           // locale-independent key for frontend re-rendering
  hasLinkedWishlist: boolean;
  linkedWishlist: { id: string; slug: string } | null;  // title omitted — deanon vector
};

// Alias record returned by API for self-identification and receiver/giver fields
type SantaAliasInfo = {
  alias: string;
  emoji: string;
  adjectiveKey: string;
  animalKey: string;
};

type SantaCampaignDetail = {
  campaign: {
    id: string; title: string; description: string | null; type: string; status: SantaCampaignStatus;
    isOwner: boolean; isOrganizer: boolean; inviteToken?: string;
    minBudget: number | null; maxBudget: number | null;
    currency: string; drawAt: string | null; seasonYear: number; cancelledAt: string | null;
    cancelReason: string | null; createdAt: string;
  };
  participants: SantaParticipant[];
  rounds: { id: string; roundNumber: number; drawStatus: string; drawnAt: string | null }[];
  currentRoundNumber: number | null;
  totalRounds: number;
  myRole: 'PARTICIPANT' | 'ADMIN' | null;
  myAlias: SantaAliasInfo | null;             // caller's own alias for this round
  pendingExitRequestId: string | null;
  pendingExitRequestCount?: number;           // organizer only
  // role-aware assignment: giver sees receiver alias info; organizer sees aggregate progress
  myAssignment: {
    role: 'giver';
    giftStatus: string;
    giftNote: string | null;
    receiver: { displayName: string; avatarUrl: null; emoji: string; adjectiveKey: string; animalKey: string; hasLinkedWishlist: boolean };
    reservedItems: { id: string; title: string }[];
  } | null;
  ownerProgress: {
    role: 'owner';
    progress: {
      pending: number; buying: number;
      selectedFromWishlist: number; selectedOutside: number; declinedToSay: number;
      missedDeadline: number; sent: number; received: number; orphaned: number; withoutWishlist: number;
    };
  } | null;
  chatUnreadCount: number;
  isMuted: boolean;
};

type SantaJoinPreview = {
  id: string; title: string; description: string | null; status: string; type: string;
  minBudget: number | null; maxBudget: number | null; currency: string;
  participantCount: number; ownerName: string | null; ownerAvatarUrl: string | null;
};

type GodStats = {
  overview: {
    totalUsers: number; newUsers24h: number; newUsers7d: number;
    activeUsers7d: number; activeUsers30d: number;
    totalWishlists: number; totalItems: number;
    totalReservations: number; proUsers: number;
  };
  funnel: {
    totalUsers: number; activatedUsers: number;
    usersWithWishlist: number; usersWithItem: number;
    usersWhoInitiatedShare: number; sharedLinkOpens: number;
    wishlistsWithLinkOpen: number; usersWithLinkOpen: number;
    usersWithReservation: number;
  };
  engagement: {
    totalComments: number; totalHints: number; totalWishlistSubs: number;
  };
  proLimits24h?: {
    totalHits: number; uniqueUsers: number;
    byType: {
      wishlistLimit: number; itemLimit: number;
      comments: number; hints: number; urlImport: number;
    };
  };
  errors24h?: {
    total: number; affectedUsers: number;
    top: { method: string; route: string; status: number; count: number }[];
  };
  onboarding?: {
    hello_activation: {
      wildberries: number; goldapple: number; ozon: number; yandex_market: number; completed: number;
    };
  };
  engagement: {
    totalComments: number; totalHints: number; totalWishlistSubs: number;
  };
  generatedAt: string;
};

type Screen = 'loading' | 'error' | 'maintenance' | 'my-wishlists' | 'wishlist-detail' | 'item-detail' | 'share' | 'guest-view' | 'guest-item-detail' | 'archive' | 'drafts' | 'settings' | 'my-reservations' | 'profile' | 'santa-hub' | 'santa-create' | 'santa-campaign' | 'santa-join' | 'santa-chat' | 'santa-polls' | 'santa-exclusions' | 'santa-organizer' | 'santa-receiver-wishlist' | 'onboarding-entry' | 'onboarding-demo' | 'onboarding-complete';
type Toast = { id: string; message: string; kind: 'success' | 'error' | 'info' };

async function computeActorHash(telegramId: number): Promise<string> {
  const data = new TextEncoder().encode(`tg_actor:${telegramId}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  const h = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// ═══════════════════════════════════════════════════════
// BUTTON / INPUT STYLES
// ═══════════════════════════════════════════════════════

const btnBase: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  gap: 8, padding: '14px 24px', borderRadius: 14, border: 'none',
  fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: font,
  transition: 'all 0.15s', width: '100%',
};
const btnPrimary: React.CSSProperties = { ...btnBase, background: C.accent, color: '#fff' };
const btnSecondary: React.CSSProperties = { ...btnBase, background: C.accentSoft, color: C.accent };
const btnGhost: React.CSSProperties = { ...btnBase, background: 'transparent', color: C.textSec, padding: '10px 16px', width: 'auto' };
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '14px 16px', borderRadius: 12,
  border: `1px solid ${C.borderLight}`, background: C.surface,
  color: C.text, fontSize: 16, fontFamily: font, outline: 'none', boxSizing: 'border-box',
};

/** onFocus: adds a temp spacer so scrollTop has room, then scrolls textarea above keyboard.
 *  Telegram WebView doesn't shrink viewport when keyboard opens, AND the container
 *  has limited bottom padding — scrollTop hits its max before the textarea can reach
 *  the visible area. The spacer creates the extra scroll room needed. */
function handleTextareaFocus(textarea: HTMLElement) {
  let scrollParent: HTMLElement | null = textarea.parentElement;
  while (scrollParent) {
    const ov = window.getComputedStyle(scrollParent).overflowY;
    if (ov === 'auto' || ov === 'scroll') break;
    scrollParent = scrollParent.parentElement;
  }
  if (!scrollParent) return;
  const sp = scrollParent;

  // Remove any leftover spacer from previous focus
  sp.querySelector('[data-kb-spacer]')?.remove();

  // Add temporary spacer — creates enough scrollable space
  const spacer = document.createElement('div');
  spacer.setAttribute('data-kb-spacer', '1');
  spacer.style.height = '50vh';
  spacer.style.pointerEvents = 'none';
  sp.appendChild(spacer);

  // Wait one frame for layout recalc with spacer, then scroll
  requestAnimationFrame(() => {
    const rect = textarea.getBoundingClientRect();
    const target = window.innerHeight * 0.35;
    const delta = rect.top - target;
    if (delta > 10) sp.scrollTop += delta;
  });

  // Remove spacer when keyboard closes (blur)
  const cleanup = () => {
    spacer.remove();
    textarea.removeEventListener('blur', cleanup);
  };
  textarea.addEventListener('blur', cleanup);
}

/** Blur whichever input/textarea currently has focus, dismissing the keyboard. */
function blurActiveField(): void {
  const el = document.activeElement;
  if (el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
    el.blur();
  }
}

/** True when a tap target is (or is inside) an editable field — used to decide
 *  whether a tap on the sheet should suppress a blur. */
function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('input, textarea');
}

/** Decode HTML entities (e.g. &quot; → ") and strip stray whitespace.
 *  Runs client-side only (uses DOM textarea trick); returns original string on server. */
function normalizeTitle(raw: string | null | undefined): string {
  if (!raw) return '';
  if (typeof window === 'undefined') return raw.replace(/\s+/g, ' ').trim();
  const el = document.createElement('textarea');
  el.innerHTML = raw;
  // collapse runs of whitespace / stray newlines but preserve intentional spacing
  return el.value.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

type SantaItemReservationState = 'available' | 'reserved-by-me' | 'reserved-by-other';
function getSantaItemReservationState(
  status: string,
  reservedByActorHash: string | null,
  myActorHash: string | null,
): SantaItemReservationState {
  if (status !== 'reserved') return 'available';
  return (myActorHash && reservedByActorHash === myActorHash) ? 'reserved-by-me' : 'reserved-by-other';
}

/** Auto-size a textarea to its content height.
 *  IMPORTANT: must use height:'0px' (not 'auto') before reading scrollHeight.
 *  With height:'auto' the browser renders rows=2 intrinsic height (~68px) which
 *  inflates scrollHeight via max(content, clientHeight) — so we'd always write
 *  back the same large value. Setting to 0 collapses clientHeight to min-height,
 *  so scrollHeight correctly reflects only the actual text content. */
function growTextarea(el: HTMLTextAreaElement) {
  el.style.height = '0px';
  el.style.height = el.scrollHeight + 'px';
}

/**
 * resolveOwnerName — canonical fallback chain for the wishlist owner's display name.
 * Priority: profile displayName → profile username → Telegram first_name → "Пользователь".
 * Single source of truth used on the Share screen, Guest view, and any context
 * that shows the owner's name — never reads tgUser.first_name directly.
 */
function resolveOwnerName(
  profile: { displayName?: string | null; username?: string | null } | null | undefined,
  tgUser: { first_name?: string | null; username?: string | null } | null | undefined,
  fallback = 'Пользователь',
): string {
  return profile?.displayName?.trim() ||
    profile?.username?.trim() ||
    tgUser?.first_name?.trim() ||
    fallback;
}

/**
 * UserAvatar — reusable avatar circle.
 * Shows profile photo if avatarUrl is provided; falls back to first letter of name.
 * Size, accent colour, and optional border can all be customised per call-site.
 * Pass hat={true} during Secret Santa season to overlay the festive hat.
 */
function UserAvatar({
  avatarUrl, name, size, accent, border, style: extraStyle, hat,
}: {
  avatarUrl?: string | null;
  name?: string | null;
  size: number;
  accent: string;
  border?: string;
  style?: React.CSSProperties;
  hat?: boolean;
}) {
  const initial = ((name ?? '?').trim() || '?')[0]!.toUpperCase();
  const avatarDiv = (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: `linear-gradient(135deg, ${accent}, ${accent}80)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: Math.round(size * 0.42), fontWeight: 700, color: '#fff',
      ...(border ? { border } : {}),
      ...(avatarUrl
        ? { backgroundImage: `url(${avatarUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
        : {}),
      ...extraStyle,
    }}>{!avatarUrl && initial}</div>
  );
  if (!hat) return avatarDiv;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      {avatarDiv}
      <SantaHatOverlay size={size} />
    </div>
  );
}

/**
 * SantaHatOverlay — inline SVG festive hat for seasonal avatar decoration.
 * Renders a red Santa hat (cone + white pom-pom + white fur brim) at a size
 * proportional to the avatar it sits on.  Positioned top-right, slightly tilted.
 * pointer-events:none — purely decorative, never blocks clicks.
 */
function SantaHatOverlay({ size }: { size: number }) {
  const w = Math.round(size * 0.68);
  const h = Math.round(size * 0.58);
  return (
    <svg
      viewBox="0 0 44 40"
      width={w}
      height={h}
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: -Math.round(h * 0.52),
        right: -Math.round(w * 0.16),
        pointerEvents: 'none',
        userSelect: 'none',
        zIndex: 2,
        overflow: 'visible',
        filter: 'drop-shadow(0 1px 2.5px rgba(0,0,0,.28))',
      }}
    >
      {/* Red cone — tip offset left of center gives a natural lean */}
      <polygon points="18,1 2,34 42,34" fill="#C41E1E" />
      {/* Slightly lighter inner sheen for depth */}
      <polygon points="18,1 10,34 26,34" fill="#D42828" opacity="0.35" />
      {/* White fur brim band */}
      <rect x="0" y="30" width="44" height="10" rx="5" fill="#F5F5F5" />
      {/* Subtle fur texture dots */}
      <circle cx="8"  cy="35" r="2.8" fill="#E0E0E0" opacity="0.65" />
      <circle cx="17" cy="35" r="2.8" fill="#E0E0E0" opacity="0.65" />
      <circle cx="26" cy="35" r="2.8" fill="#E0E0E0" opacity="0.65" />
      <circle cx="35" cy="35" r="2.8" fill="#E0E0E0" opacity="0.65" />
      {/* White pom-pom at tip */}
      <circle cx="18" cy="5"  r="6.5" fill="#F5F5F5" />
      <circle cx="18" cy="5"  r="4.5" fill="white" />
    </svg>
  );
}

/**
 * SantaAvatar — anonymous emoji avatar for Secret Santa.
 * Color is derived deterministically from the alias string (stable per round).
 * Never shows real profile photos. Uses animal emoji + color circle.
 * Pass hat={true} during season for the festive hat overlay.
 */
function santaAliasHue(alias: string): number {
  let h = 2166136261;
  for (let i = 0; i < alias.length; i++) {
    h ^= alias.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 36) * 10; // 36 hues × 10° step
}

function SantaAvatar({ alias, emoji, size, border, hat }: {
  alias: string;
  emoji: string;
  size: number;
  border?: string;
  hat?: boolean;
}) {
  const hue = santaAliasHue(alias);
  const circle = (
    <div style={{
      width: size, height: size, borderRadius: '50%',
      background: `hsl(${hue}, 55%, 82%)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: Math.round(size * 0.55),
      ...(border ? { border } : {}),
    }}>
      {emoji || '🎅'}
    </div>
  );
  if (!hat) return circle;
  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      {circle}
      <SantaHatOverlay size={size} />
    </div>
  );
}

// ── Seasonal snowflake overlay ──────────────────────────────────────────────
// Hardcoded positions/timings (no Math.random) so re-renders don't reshuffle
// the animation.  `pointer-events:none` everywhere — purely decorative.
const SNOW_FLAKES = [
  { left: '6%',  delay: '0s',    dur: '4.4s', op: 0.55, size: 11 },
  { left: '19%', delay: '1.5s',  dur: '3.7s', op: 0.40, size: 9  },
  { left: '34%', delay: '0.8s',  dur: '5.1s', op: 0.50, size: 12 },
  { left: '50%', delay: '2.2s',  dur: '4.0s', op: 0.35, size: 10 },
  { left: '65%', delay: '0.4s',  dur: '4.8s', op: 0.60, size: 11 },
  { left: '79%', delay: '1.9s',  dur: '3.9s', op: 0.45, size: 9  },
  { left: '92%', delay: '1.2s',  dur: '5.3s', op: 0.38, size: 10 },
] as const;

function SnowflakeOverlay({ height = 72 }: { height?: number }) {
  return (
    <div style={{
      position: 'absolute', left: 0, right: 0, top: 0, height,
      overflow: 'hidden', pointerEvents: 'none', userSelect: 'none', zIndex: 0,
    }}>
      {SNOW_FLAKES.map((f, i) => (
        <span key={i} className="snowflake" style={{
          position: 'absolute',
          left: f.left, top: -12,
          fontSize: f.size,
          opacity: f.op,
          color: 'rgba(180,220,245,.9)',
          lineHeight: 1,
          animation: `snowfall ${f.dur} ease-in ${f.delay} infinite`,
        }}>❄</span>
      ))}
    </div>
  );
}

// Frontend corpus for locale-aware alias rendering
// Keys must match the API corpus exactly
const SANTA_ADJ: Record<string, { ru_m: string; ru_f: string; en: string }> = {
  sleepy:     { ru_m: 'Сонный',      ru_f: 'Сонная',      en: 'Sleepy' },
  nimble:     { ru_m: 'Ловкий',      ru_f: 'Ловкая',       en: 'Nimble' },
  quiet:      { ru_m: 'Тихий',       ru_f: 'Тихая',        en: 'Quiet' },
  northern:   { ru_m: 'Северный',    ru_f: 'Северная',     en: 'Northern' },
  cheerful:   { ru_m: 'Весёлый',     ru_f: 'Весёлая',      en: 'Cheerful' },
  cunning:    { ru_m: 'Хитрый',      ru_f: 'Хитрая',       en: 'Cunning' },
  kind:       { ru_m: 'Добрый',      ru_f: 'Добрая',       en: 'Kind' },
  swift:      { ru_m: 'Быстрый',     ru_f: 'Быстрая',      en: 'Swift' },
  brave:      { ru_m: 'Смелый',      ru_f: 'Смелая',       en: 'Brave' },
  smart:      { ru_m: 'Умный',       ru_f: 'Умная',        en: 'Smart' },
  gentle:     { ru_m: 'Нежный',      ru_f: 'Нежная',       en: 'Gentle' },
  fluffy:     { ru_m: 'Пушистый',    ru_f: 'Пушистая',     en: 'Fluffy' },
  bright:     { ru_m: 'Яркий',       ru_f: 'Яркая',        en: 'Bright' },
  curious:    { ru_m: 'Любопытный',  ru_f: 'Любопытная',   en: 'Curious' },
  patient:    { ru_m: 'Терпеливый',  ru_f: 'Терпеливая',   en: 'Patient' },
  playful:    { ru_m: 'Игривый',     ru_f: 'Игривая',      en: 'Playful' },
  cozy:       { ru_m: 'Уютный',      ru_f: 'Уютная',       en: 'Cozy' },
  peaceful:   { ru_m: 'Спокойный',   ru_f: 'Спокойная',    en: 'Peaceful' },
  golden:     { ru_m: 'Золотой',     ru_f: 'Золотая',      en: 'Golden' },
  mysterious: { ru_m: 'Загадочный',  ru_f: 'Загадочная',   en: 'Mysterious' },
  lucky:      { ru_m: 'Удачливый',   ru_f: 'Удачливая',    en: 'Lucky' },
  energetic:  { ru_m: 'Бодрый',      ru_f: 'Бодрая',       en: 'Energetic' },
  wise:       { ru_m: 'Мудрый',      ru_f: 'Мудрая',       en: 'Wise' },
  rare:       { ru_m: 'Редкий',      ru_f: 'Редкая',       en: 'Rare' },
  honest:     { ru_m: 'Честный',     ru_f: 'Честная',      en: 'Honest' },
  courageous: { ru_m: 'Отважный',    ru_f: 'Отважная',     en: 'Courageous' },
  modest:     { ru_m: 'Скромный',    ru_f: 'Скромная',     en: 'Modest' },
  wonderful:  { ru_m: 'Чудесный',    ru_f: 'Чудесная',     en: 'Wonderful' },
  generous:   { ru_m: 'Щедрый',      ru_f: 'Щедрая',       en: 'Generous' },
  light:      { ru_m: 'Лёгкий',      ru_f: 'Лёгкая',       en: 'Light' },
};
const SANTA_ANIMAL: Record<string, { ru: string; gender: 'm' | 'f'; en: string }> = {
  giraffe:    { ru: 'жираф',      gender: 'm', en: 'Giraffe' },
  quokka:     { ru: 'квокка',     gender: 'f', en: 'Quokka' },
  manul:      { ru: 'манул',      gender: 'm', en: 'Pallas Cat' },
  penguin:    { ru: 'пингвин',    gender: 'm', en: 'Penguin' },
  fox:        { ru: 'лиса',       gender: 'f', en: 'Fox' },
  raccoon:    { ru: 'енот',       gender: 'm', en: 'Raccoon' },
  bear:       { ru: 'медведь',    gender: 'm', en: 'Bear' },
  squirrel:   { ru: 'белка',      gender: 'f', en: 'Squirrel' },
  hedgehog:   { ru: 'ёж',         gender: 'm', en: 'Hedgehog' },
  otter:      { ru: 'выдра',      gender: 'f', en: 'Otter' },
  panda:      { ru: 'панда',      gender: 'f', en: 'Panda' },
  koala:      { ru: 'коала',      gender: 'm', en: 'Koala' },
  capybara:   { ru: 'капибара',   gender: 'f', en: 'Capybara' },
  sloth:      { ru: 'ленивец',    gender: 'm', en: 'Sloth' },
  flamingo:   { ru: 'фламинго',   gender: 'm', en: 'Flamingo' },
  lemur:      { ru: 'лемур',      gender: 'm', en: 'Lemur' },
  alpaca:     { ru: 'альпака',    gender: 'f', en: 'Alpaca' },
  axolotl:    { ru: 'аксолотль',  gender: 'm', en: 'Axolotl' },
  narwhal:    { ru: 'нарвал',     gender: 'm', en: 'Narwhal' },
  platypus:   { ru: 'утконос',    gender: 'm', en: 'Platypus' },
  meerkat:    { ru: 'сурикат',    gender: 'm', en: 'Meerkat' },
  chinchilla: { ru: 'шиншилла',   gender: 'f', en: 'Chinchilla' },
  tapir:      { ru: 'тапир',      gender: 'm', en: 'Tapir' },
  wombat:     { ru: 'вомбат',     gender: 'm', en: 'Wombat' },
  marmot:     { ru: 'сурок',      gender: 'm', en: 'Marmot' },
  toucan:     { ru: 'тукан',      gender: 'm', en: 'Toucan' },
  armadillo:  { ru: 'броненосец', gender: 'm', en: 'Armadillo' },
  cassowary:  { ru: 'казуар',     gender: 'm', en: 'Cassowary' },
  lynx:       { ru: 'рысь',       gender: 'f', en: 'Lynx' },
  okapi:      { ru: 'окапи',      gender: 'm', en: 'Okapi' },
};

/** Render alias in user's locale from adjectiveKey + animalKey */
function renderSantaAlias(adjectiveKey: string, animalKey: string, locale: string): string {
  const adj = SANTA_ADJ[adjectiveKey];
  const animal = SANTA_ANIMAL[animalKey];
  if (!adj || !animal) return locale === 'en' ? 'Participant' : 'Участник';
  if (locale === 'en') return `${adj.en} ${animal.en}`;
  return `${animal.gender === 'f' ? adj.ru_f : adj.ru_m} ${animal.ru}`;
}

/**
 * SantaAvatar — anonymous emoji avatar for Secret Santa.
 * Color is derived deterministically from the alias string (stable per round).
 * Never shows real profile photos. Uses animal emoji + color circle.
 */
function santaAliasHue(alias: string): number {
  let h = 2166136261;
  for (let i = 0; i < alias.length; i++) {
    h ^= alias.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h % 36) * 10; // 36 hues × 10° step
}

function SantaAvatar({ alias, emoji, size, border }: {
  alias: string;
  emoji: string;
  size: number;
  border?: string;
}) {
  const hue = santaAliasHue(alias);
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: `hsl(${hue}, 55%, 82%)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: Math.round(size * 0.55),
      ...(border ? { border } : {}),
    }}>
      {emoji || '🎅'}
    </div>
  );
}

// Frontend corpus for locale-aware alias rendering
// Keys must match the API corpus exactly
const SANTA_ADJ: Record<string, { ru_m: string; ru_f: string; en: string }> = {
  sleepy:     { ru_m: 'Сонный',      ru_f: 'Сонная',      en: 'Sleepy' },
  nimble:     { ru_m: 'Ловкий',      ru_f: 'Ловкая',       en: 'Nimble' },
  quiet:      { ru_m: 'Тихий',       ru_f: 'Тихая',        en: 'Quiet' },
  northern:   { ru_m: 'Северный',    ru_f: 'Северная',     en: 'Northern' },
  cheerful:   { ru_m: 'Весёлый',     ru_f: 'Весёлая',      en: 'Cheerful' },
  cunning:    { ru_m: 'Хитрый',      ru_f: 'Хитрая',       en: 'Cunning' },
  kind:       { ru_m: 'Добрый',      ru_f: 'Добрая',       en: 'Kind' },
  swift:      { ru_m: 'Быстрый',     ru_f: 'Быстрая',      en: 'Swift' },
  brave:      { ru_m: 'Смелый',      ru_f: 'Смелая',       en: 'Brave' },
  smart:      { ru_m: 'Умный',       ru_f: 'Умная',        en: 'Smart' },
  gentle:     { ru_m: 'Нежный',      ru_f: 'Нежная',       en: 'Gentle' },
  fluffy:     { ru_m: 'Пушистый',    ru_f: 'Пушистая',     en: 'Fluffy' },
  bright:     { ru_m: 'Яркий',       ru_f: 'Яркая',        en: 'Bright' },
  curious:    { ru_m: 'Любопытный',  ru_f: 'Любопытная',   en: 'Curious' },
  patient:    { ru_m: 'Терпеливый',  ru_f: 'Терпеливая',   en: 'Patient' },
  playful:    { ru_m: 'Игривый',     ru_f: 'Игривая',      en: 'Playful' },
  cozy:       { ru_m: 'Уютный',      ru_f: 'Уютная',       en: 'Cozy' },
  peaceful:   { ru_m: 'Спокойный',   ru_f: 'Спокойная',    en: 'Peaceful' },
  golden:     { ru_m: 'Золотой',     ru_f: 'Золотая',      en: 'Golden' },
  mysterious: { ru_m: 'Загадочный',  ru_f: 'Загадочная',   en: 'Mysterious' },
  lucky:      { ru_m: 'Удачливый',   ru_f: 'Удачливая',    en: 'Lucky' },
  energetic:  { ru_m: 'Бодрый',      ru_f: 'Бодрая',       en: 'Energetic' },
  wise:       { ru_m: 'Мудрый',      ru_f: 'Мудрая',       en: 'Wise' },
  rare:       { ru_m: 'Редкий',      ru_f: 'Редкая',       en: 'Rare' },
  honest:     { ru_m: 'Честный',     ru_f: 'Честная',      en: 'Honest' },
  courageous: { ru_m: 'Отважный',    ru_f: 'Отважная',     en: 'Courageous' },
  modest:     { ru_m: 'Скромный',    ru_f: 'Скромная',     en: 'Modest' },
  wonderful:  { ru_m: 'Чудесный',    ru_f: 'Чудесная',     en: 'Wonderful' },
  generous:   { ru_m: 'Щедрый',      ru_f: 'Щедрая',       en: 'Generous' },
  light:      { ru_m: 'Лёгкий',      ru_f: 'Лёгкая',       en: 'Light' },
};
const SANTA_ANIMAL: Record<string, { ru: string; gender: 'm' | 'f'; en: string }> = {
  giraffe:    { ru: 'жираф',      gender: 'm', en: 'Giraffe' },
  quokka:     { ru: 'квокка',     gender: 'f', en: 'Quokka' },
  manul:      { ru: 'манул',      gender: 'm', en: 'Pallas Cat' },
  penguin:    { ru: 'пингвин',    gender: 'm', en: 'Penguin' },
  fox:        { ru: 'лиса',       gender: 'f', en: 'Fox' },
  raccoon:    { ru: 'енот',       gender: 'm', en: 'Raccoon' },
  bear:       { ru: 'медведь',    gender: 'm', en: 'Bear' },
  squirrel:   { ru: 'белка',      gender: 'f', en: 'Squirrel' },
  hedgehog:   { ru: 'ёж',         gender: 'm', en: 'Hedgehog' },
  otter:      { ru: 'выдра',      gender: 'f', en: 'Otter' },
  panda:      { ru: 'панда',      gender: 'f', en: 'Panda' },
  koala:      { ru: 'коала',      gender: 'm', en: 'Koala' },
  capybara:   { ru: 'капибара',   gender: 'f', en: 'Capybara' },
  sloth:      { ru: 'ленивец',    gender: 'm', en: 'Sloth' },
  flamingo:   { ru: 'фламинго',   gender: 'm', en: 'Flamingo' },
  lemur:      { ru: 'лемур',      gender: 'm', en: 'Lemur' },
  alpaca:     { ru: 'альпака',    gender: 'f', en: 'Alpaca' },
  axolotl:    { ru: 'аксолотль',  gender: 'm', en: 'Axolotl' },
  narwhal:    { ru: 'нарвал',     gender: 'm', en: 'Narwhal' },
  platypus:   { ru: 'утконос',    gender: 'm', en: 'Platypus' },
  meerkat:    { ru: 'сурикат',    gender: 'm', en: 'Meerkat' },
  chinchilla: { ru: 'шиншилла',   gender: 'f', en: 'Chinchilla' },
  tapir:      { ru: 'тапир',      gender: 'm', en: 'Tapir' },
  wombat:     { ru: 'вомбат',     gender: 'm', en: 'Wombat' },
  marmot:     { ru: 'сурок',      gender: 'm', en: 'Marmot' },
  toucan:     { ru: 'тукан',      gender: 'm', en: 'Toucan' },
  armadillo:  { ru: 'броненосец', gender: 'm', en: 'Armadillo' },
  cassowary:  { ru: 'казуар',     gender: 'm', en: 'Cassowary' },
  lynx:       { ru: 'рысь',       gender: 'f', en: 'Lynx' },
  okapi:      { ru: 'окапи',      gender: 'm', en: 'Okapi' },
};

/** Render alias in user's locale from adjectiveKey + animalKey */
function renderSantaAlias(adjectiveKey: string, animalKey: string, locale: string): string {
  const adj = SANTA_ADJ[adjectiveKey];
  const animal = SANTA_ANIMAL[animalKey];
  if (!adj || !animal) return locale === 'en' ? 'Participant' : 'Участник';
  if (locale === 'en') return `${adj.en} ${animal.en}`;
  return `${animal.gender === 'f' ? adj.ru_f : adj.ru_m} ${animal.ru}`;
}

// ═══════════════════════════════════════════════════════
// PRO UPSELL SYSTEM
// ═══════════════════════════════════════════════════════

function ProBadge({ style }: { style?: React.CSSProperties } = {}) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      fontSize: 9, fontWeight: 800, letterSpacing: 0.6,
      padding: '2px 7px', borderRadius: 5,
      background: `linear-gradient(135deg, ${C.accent}20, ${C.accent}12)`,
      border: `1px solid ${C.accent}30`,
      color: C.accent,
      lineHeight: 1, verticalAlign: 'middle', ...style,
    }}>PRO</span>
  );
}

const getUpsellContent = (locale: Locale): Record<UpsellContext, {
  emoji: string; title: string; subtitle: string; showTable: boolean; benefits?: string[];
}> => ({
  comments: {
    emoji: '💬',
    title: t('upsell_comments_title', locale),
    subtitle: t('upsell_comments_subtitle', locale),
    showTable: false,
    benefits: [t('upsell_comments_b1', locale), t('upsell_comments_b2', locale), t('upsell_comments_b3', locale)],
  },
  url_import: {
    emoji: '🔗',
    title: t('upsell_url_title', locale),
    subtitle: t('upsell_url_subtitle', locale),
    showTable: false,
    benefits: [t('upsell_url_b1', locale), t('upsell_url_b2', locale), t('upsell_url_b3', locale)],
  },
  hints: {
    emoji: '💡',
    title: t('upsell_hints_title', locale),
    subtitle: t('upsell_hints_subtitle', locale),
    showTable: false,
    benefits: [t('upsell_hints_b1', locale), t('upsell_hints_b2', locale), t('upsell_hints_b3', locale)],
  },
  wishlist_limit: {
    emoji: '📋',
    title: t('upsell_wl_title', locale),
    subtitle: t('upsell_wl_subtitle', locale),
    showTable: true,
  },
  item_limit: {
    emoji: '🎁',
    title: t('upsell_item_title', locale),
    subtitle: t('upsell_item_subtitle', locale),
    showTable: true,
  },
  participant_limit: {
    emoji: '👥',
    title: t('upsell_part_title', locale),
    subtitle: t('upsell_part_subtitle', locale),
    showTable: true,
  },
  subscription_limit: {
    emoji: '🔔',
    title: t('upsell_sub_title', locale),
    subtitle: t('upsell_sub_subtitle', locale, { free: '2', pro: '5' }),
    showTable: true,
  },
  sort_recommended: {
    emoji: '✨',
    title: t('upsell_sort_title', locale),
    subtitle: t('upsell_sort_subtitle', locale),
    showTable: false,
    benefits: [t('upsell_sort_b1', locale), t('upsell_sort_b2', locale), t('upsell_sort_b3', locale)],
  },
});

// Centralized PRO benefits config — single source of truth for all paywall/plan screens
function getProBenefits(locale: Locale): Array<{ icon: string; title: string; subtitle: string }> {
  return [
    { icon: '📋', title: t('plan_pro_f1', locale), subtitle: t('plan_pro_sub1', locale) },
    { icon: '🎁', title: t('plan_pro_f2', locale), subtitle: t('plan_pro_sub2', locale) },
    { icon: '👥', title: t('plan_pro_f3', locale), subtitle: t('plan_pro_sub3', locale) },
    { icon: '💬', title: t('plan_pro_f4', locale), subtitle: t('plan_pro_sub4', locale) },
    { icon: '🔗', title: t('plan_pro_f5', locale), subtitle: t('plan_pro_sub5', locale) },
    { icon: '💡', title: t('plan_pro_f6', locale), subtitle: t('plan_pro_sub6', locale) },
    { icon: '👁', title: t('plan_pro_f7', locale), subtitle: t('plan_pro_sub7', locale) },
    { icon: '🛡', title: t('plan_pro_f8', locale), subtitle: t('plan_pro_sub8', locale) },
  ];
}

// ═══════════════════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════════════════

function BottomSheet({ isOpen, onClose, title, children }: {
  isOpen: boolean; onClose: () => void; title?: string; children: React.ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  // Keep onClose stable inside native listeners without re-subscribing
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);

  // Backdrop: block ALL touch scroll on the underlying screen via native non-passive listener
  useEffect(() => {
    const el = backdropRef.current;
    if (!el || !isOpen) return;
    const block = (e: TouchEvent) => e.preventDefault();
    el.addEventListener('touchmove', block, { passive: false });
    return () => el.removeEventListener('touchmove', block);
  }, [isOpen]);

  // Sheet: take FULL ownership of scrolling + swipe-to-dismiss.
  // iOS WKWebView (Telegram) claims the gesture once native scroll starts and
  // stops honouring preventDefault() after that point. Fix: always preventDefault
  // and drive el.scrollTop + el.style.transform directly — zero React re-renders
  // in the hot path means buttery-smooth 60 fps on the GPU compositor thread.
  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet || !isOpen) return;
    let prevY: number | null = null;
    let dismissOffset = 0;
    // Blur the keyboard at most once per gesture (prevents redundant calls)
    let blurFired = false;

    const setTranslate = (y: number) => {
      sheet.style.transform = y === 0 ? '' : `translateY(${y}px)`;
    };

    const onStart = (e: TouchEvent) => {
      if (!e.touches[0]) return;
      prevY = e.touches[0].clientY;
      dismissOffset = 0;
      blurFired = false;
      // Freeze any in-progress spring-back transition
      sheet.style.transition = 'none';
    };

    const onMove = (e: TouchEvent) => {
      if (prevY === null || !e.touches[0]) return;
      e.preventDefault(); // always prevent — we own all scroll behaviour

      const currentY = e.touches[0].clientY;
      const dy = currentY - prevY; // positive = finger moved down
      prevY = currentY;

      // Dismiss keyboard on first detected scroll motion — keeps the content
      // readable while scrolling and prevents gesture leakage into WebView.
      if (!blurFired && dy !== 0) {
        blurActiveField();
        blurFired = true;
      }

      if (dy < 0) {
        // Finger up → scroll content down
        sheet.scrollTop = Math.min(
          sheet.scrollTop - dy,
          sheet.scrollHeight - sheet.clientHeight,
        );
        if (dismissOffset > 0) {
          dismissOffset = 0;
          setTranslate(0);
        }
      } else if (dy > 0) {
        if (sheet.scrollTop > 0) {
          // Scroll content back toward top
          const next = sheet.scrollTop - dy;
          if (next > 0) {
            sheet.scrollTop = next;
          } else {
            // Hit top; leftover delta kicks off dismiss
            sheet.scrollTop = 0;
            dismissOffset = -next;
            setTranslate(dismissOffset);
          }
        } else {
          // At top → dismiss gesture
          dismissOffset += dy;
          setTranslate(dismissOffset);
        }
      }
    };

    const onEnd = () => {
      prevY = null;
      if (dismissOffset > 80) {
        // Animate slide-out then call onClose (no React state flip needed)
        sheet.style.transition = 'transform 0.22s ease-in';
        setTranslate(sheet.offsetHeight + 40);
        setTimeout(() => onCloseRef.current(), 220);
      } else if (dismissOffset > 0) {
        // Spring back
        sheet.style.transition = 'transform 0.3s cubic-bezier(0.32,0.72,0,1)';
        setTranslate(0);
      }
      dismissOffset = 0;
    };

    sheet.addEventListener('touchstart', onStart, { passive: true });
    sheet.addEventListener('touchmove', onMove, { passive: false });
    sheet.addEventListener('touchend', onEnd, { passive: true });
    return () => {
      sheet.removeEventListener('touchstart', onStart);
      sheet.removeEventListener('touchmove', onMove);
      sheet.removeEventListener('touchend', onEnd);
    };
  }, [isOpen]);

  if (!isOpen) return null;
  return (
    <>
      <div
        ref={backdropRef}
        onClick={() => { blurActiveField(); onClose(); }}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100 }}
      />
      <div
        ref={sheetRef}
        onClick={(e) => {
          // Tapping any non-editable area (labels, padding, dividers, buttons)
          // dismisses the keyboard — keeps UX clean without disabling tap-to-focus.
          if (!isEditableTarget(e.target)) blurActiveField();
        }}
        style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          background: C.surface, borderRadius: '20px 20px 0 0',
          padding: 24, zIndex: 101, maxHeight: '85vh', overflowY: 'auto',
          animation: 'slideUp 0.3s ease',
          willChange: 'transform',
        }}
      >
        <div style={{ width: 40, height: 4, background: C.textMuted, borderRadius: 100, margin: '0 auto 16px', opacity: 0.3, cursor: 'grab' }} />
        {title && <div style={{ fontSize: 17, fontWeight: 700, marginBottom: 16, fontFamily: font, color: C.text }}>{title}</div>}
        {children}
      </div>
    </>
  );
}

function ItemThumb({ item }: { item: Item | GuestItem }) {
  const [imgErr, setImgErr] = useState(false);
  if (item.imageUrl && !imgErr) {
    return (
      <img
        src={item.imageUrl}
        alt=""
        onError={() => setImgErr(true)}
        style={{ width: 52, height: 52, borderRadius: 12, objectFit: 'cover', flexShrink: 0, background: C.accentSoft }}
      />
    );
  }
  return (
    <div style={{
      width: 52, height: 52, borderRadius: 12, background: C.accentSoft,
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 26, flexShrink: 0,
    }}>
      {getEmoji(item.title)}
    </div>
  );
}

function WishCardOwner({ item, onTap, onDelete, onComplete, locale, sourceLabel }: {
  item: Item;
  onTap: (item: Item) => void;
  onDelete: (item: Item) => void;
  onComplete?: (item: Item) => void;
  locale: Locale;
  sourceLabel?: string;
}) {
  const isPurchased = item.status === 'purchased';
  const isReserved = item.status === 'reserved';
  return (
    <div
      onClick={() => onTap(item)}
      style={{
        background: C.card, borderRadius: 14, padding: 16,
        display: 'flex', gap: 14, alignItems: 'flex-start',
        border: `1px solid ${C.border}`, opacity: isPurchased ? 0.5 : 1,
        cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
      }}
    >
      <ItemThumb item={item} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{
            fontSize: 15, fontWeight: 600, fontFamily: font,
            color: isPurchased ? C.textMuted : C.text,
            textDecoration: isPurchased ? 'line-through' : 'none',
            lineHeight: 1.3, paddingRight: 8,
          }}>
            {item.title}
          </div>
          <span style={{
            flexShrink: 0, width: 32, height: 32, borderRadius: '50%',
            background: PRIO_BG[item.priority] ?? PRIO_BG[1],
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, lineHeight: 1,
          }}>{prioEmoji(item.priority)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          {item.price != null && <span style={{ fontSize: 14, fontWeight: 700, color: C.accent, fontFamily: font }}>{fmtPrice(item.price, locale, item.currency ?? 'RUB')}</span>}
          {item.url && <span style={{ fontSize: 11, color: C.textMuted, background: C.surface, padding: '2px 8px', borderRadius: 6 }}>{t('link_label', locale)}</span>}
        </div>
        <div style={{ marginTop: 10 }}>
          {isReserved && <span style={{ display: 'inline-block', padding: '6px 12px', borderRadius: 10, background: C.accentSoft, color: C.accent, fontSize: 13, fontWeight: 600 }}>{t('status_someone_reserved', locale)}</span>}
          {isPurchased && <span style={{ display: 'inline-block', padding: '6px 12px', borderRadius: 10, background: C.greenSoft, color: C.green, fontSize: 13, fontWeight: 600 }}>{t('status_gifted', locale)}</span>}
        </div>
        {sourceLabel && (
          <div style={{ marginTop: 6 }}>
            <span style={{
              display: 'inline-block', fontSize: 10, fontWeight: 500, color: C.textMuted,
              background: C.surface, border: `1px solid ${C.borderLight}`,
              padding: '1px 8px', borderRadius: 20,
            }}>
              {sourceLabel}
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

function WishCardGuest({ item, onTap, onReserve, onUnreserve, myActorHash, locale }: { item: GuestItem; onTap: (item: GuestItem) => void; onReserve: (item: GuestItem) => void; onUnreserve: (item: GuestItem) => void; myActorHash: string; locale: Locale }) {
  const isPurchased = item.status === 'purchased';
  const isReserved = item.status === 'reserved';
  const isReservedByMe = isReserved && !!myActorHash && item.reservedByActorHash === myActorHash;
  return (
    <div
      onClick={() => onTap(item)}
      style={{
        background: C.card, borderRadius: 14, padding: 16,
        display: 'flex', gap: 14, alignItems: 'flex-start',
        border: `1px solid ${C.border}`, opacity: isPurchased ? 0.5 : 1,
        cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
      }}
    >
      <ItemThumb item={item} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ fontSize: 15, fontWeight: 600, fontFamily: font, color: C.text, lineHeight: 1.3, paddingRight: 8, textDecoration: isPurchased ? 'line-through' : 'none' }}>
            {item.title}
          </div>
          <span style={{
            flexShrink: 0, width: 32, height: 32, borderRadius: '50%',
            background: PRIO_BG[item.priority] ?? PRIO_BG[1],
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 16, lineHeight: 1,
          }}>{prioEmoji(item.priority)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          {item.price != null && <span style={{ fontSize: 14, fontWeight: 700, color: C.accent, fontFamily: font }}>{fmtPrice(item.price, locale, item.currency ?? 'RUB')}</span>}
          {item.url && <a href={item.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ fontSize: 11, color: C.accent, background: C.accentSoft, padding: '2px 8px', borderRadius: 6, textDecoration: 'none' }}>{t('link_label', locale)}</a>}
        </div>
        <div style={{ marginTop: 10 }}>
          {item.status === 'available' && (
            <button onClick={(e) => { e.stopPropagation(); onReserve(item); }} style={{ ...btnPrimary, width: 'auto', padding: '8px 16px', fontSize: 13 }}>{t('reserve_btn', locale)}</button>
          )}
          {isReservedByMe && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ display: 'inline-block', padding: '6px 12px', borderRadius: 10, background: C.greenSoft, color: C.green, fontSize: 13, fontWeight: 600 }}>
                {t('reserved_by_me', locale)}
              </span>
              <button onClick={(e) => { e.stopPropagation(); onUnreserve(item); }} style={{ background: 'none', border: 'none', padding: '6px 8px', fontSize: 12, color: C.textMuted, cursor: 'pointer', fontFamily: font }}>{t('cancel', locale)}</button>
            </div>
          )}
          {isReserved && !isReservedByMe && (
            <span style={{ display: 'inline-block', padding: '6px 12px', borderRadius: 10, background: C.orangeSoft, color: C.orange, fontSize: 13, fontWeight: 600 }}>
              {t('already_reserved', locale)}
            </span>
          )}
          {isPurchased && <span style={{ display: 'inline-block', padding: '6px 12px', borderRadius: 10, background: C.greenSoft, color: C.green, fontSize: 13, fontWeight: 600 }}>{t('status_gifted', locale)}</span>}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// RESERVATION CARD (for "My Reservations" section)
// ═══════════════════════════════════════════════════════

function ReservationCard({ item, onTap, onUnreserve, animDelay, locale }: {
  item: ReservationItem;
  onTap: () => void;
  onUnreserve: () => void;
  animDelay: number;
  locale: Locale;
}) {
  return (
    <div
      onClick={onTap}
      style={{
        background: C.card, borderRadius: 14, padding: 16,
        display: 'flex', gap: 14, alignItems: 'flex-start',
        border: `1px solid ${C.border}`, cursor: 'pointer',
        WebkitTapHighlightColor: 'transparent',
        animation: `fadeIn 0.3s ease ${animDelay}s both`,
      }}
    >
      <ItemThumb item={item} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{
            fontSize: 15, fontWeight: 600, fontFamily: font, color: C.text,
            lineHeight: 1.3, paddingRight: 8,
          }}>
            {item.title}
          </div>
          {item.unreadComments > 0 && (
            <span style={{
              minWidth: 20, height: 20, borderRadius: 10,
              background: C.accent, color: '#fff',
              fontSize: 11, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: '0 6px', flexShrink: 0,
            }}>
              {item.unreadComments}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          {item.price != null && (
            <span style={{ fontSize: 14, fontWeight: 700, color: C.accent, fontFamily: font }}>
              {fmtPrice(item.price, locale, item.currency ?? 'RUB')}
            </span>
          )}
          <span style={{
            fontSize: 11, background: C.greenSoft, color: C.green,
            padding: '2px 8px', borderRadius: 6, fontWeight: 600,
          }}>
            {t('reservations_reserved', locale)}
          </span>
        </div>
        <div style={{ marginTop: 10 }}>
          <button
            onClick={(e) => { e.stopPropagation(); onUnreserve(); }}
            style={{
              background: C.redSoft, border: `1px solid rgba(248,113,113,0.3)`,
              borderRadius: 10, padding: '6px 14px', fontSize: 12,
              color: C.red, cursor: 'pointer', fontFamily: font, fontWeight: 500,
            }}
          >
            {t('reservations_unreserve', locale)}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// COMMENTS THREAD (module-level to keep stable identity)
// ═══════════════════════════════════════════════════════

function CommentsThread({ commentRole, comments, commentText, setCommentText, commentSending, myActorHash, onDeleteComment, onSendComment, isArchive, locale }: {
  commentRole: 'owner' | 'reserver' | null;
  comments: CommentDTO[];
  commentText: string;
  setCommentText: (t: string) => void;
  commentSending: boolean;
  myActorHash: string;
  locale: Locale;
  onDeleteComment: (id: string) => void;
  onSendComment: () => void;
  isArchive?: boolean;
}) {
  if (!commentRole) return null;

  const canDelete = (c: CommentDTO) => {
    if (c.type === 'SYSTEM') return false;
    if (commentRole === 'owner') return true;
    return c.authorActorHash === myActorHash;
  };

  const isMine = (c: CommentDTO) => c.authorActorHash === myActorHash;

  return (
    <div style={{ marginTop: 24, padding: 20, background: C.surface, borderRadius: 20 }}>
      <div style={{ fontSize: 17, fontWeight: 600, color: C.text, marginBottom: 4, fontFamily: font }}>
        {t('comments_title', locale)}
      </div>
      <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 16, lineHeight: 1.4 }}>
        {t('comments_subtitle', locale)}
      </div>

      {isArchive && (
        <div style={{ fontSize: 12, color: C.orange, background: C.orangeSoft, padding: '8px 14px', borderRadius: 12, marginBottom: 14 }}>
          {t('comments_archive_warning', locale)}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {comments.length === 0 && (
          <div style={{ textAlign: 'center', fontSize: 14, color: C.textMuted, padding: '24px 0 16px' }}>
            {t('comments_empty', locale)}
          </div>
        )}
        {comments.map(c => (
          c.type === 'SYSTEM' ? (
            <div key={c.id} style={{
              textAlign: 'center', fontSize: 12, color: C.textMuted,
              padding: '8px 14px', background: C.bg, borderRadius: 12, margin: '6px 0',
            }}>
              {c.text} · {new Date(c.createdAt).toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
            </div>
          ) : (
            <div key={c.id} style={{
              alignSelf: isMine(c) ? 'flex-end' : 'flex-start',
              maxWidth: '75%',
            }}>
              {!isMine(c) && (
                <div style={{ fontSize: 12, color: C.accent, marginBottom: 3, fontWeight: 600, fontFamily: font }}>
                  {c.authorDisplayName ?? t('comments_anon', locale)}
                </div>
              )}
              {isMine(c) && (
                <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginBottom: 3, fontWeight: 500, fontFamily: font, textAlign: 'right' }}>
                  {t('comments_me', locale)}
                </div>
              )}
              <div style={{
                padding: '12px 16px', borderRadius: 18,
                background: isMine(c) ? C.accent : C.card,
                color: isMine(c) ? '#fff' : C.text,
                fontSize: 15, lineHeight: 1.45,
                border: isMine(c) ? 'none' : `1px solid ${C.border}`,
              }}>
                {c.text}
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  marginTop: 6, gap: 8,
                }}>
                  <span style={{
                    fontSize: 11,
                    color: isMine(c) ? 'rgba(255,255,255,0.45)' : C.textMuted,
                  }}>
                    {new Date(c.createdAt).toLocaleTimeString(locale === 'ru' ? 'ru-RU' : 'en-US', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  {canDelete(c) && !isArchive && (
                    <button
                      onClick={() => void onDeleteComment(c.id)}
                      style={{
                        background: 'none', border: 'none', padding: '4px 6px', cursor: 'pointer',
                        fontSize: 12, color: isMine(c) ? 'rgba(255,255,255,0.35)' : C.textMuted,
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              </div>
            </div>
          )
        ))}
      </div>

      {/* Composer */}
      {!isArchive && (
        <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'flex-end' }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <textarea
              style={{
                ...inputStyle,
                minHeight: 48, maxHeight: 100, resize: 'none',
                paddingRight: 48, padding: '14px 48px 14px 16px',
                borderRadius: 16, fontSize: 15,
                background: C.bg,
              }}
              placeholder={t('comments_placeholder', locale)}
              value={commentText}
              onChange={(e) => { setCommentText(e.target.value.slice(0, 300)); growTextarea(e.target); }}
              maxLength={300}
              onFocus={(e) => handleTextareaFocus(e.currentTarget)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void onSendComment(); } }}
            />
            <span style={{
              position: 'absolute', right: 14, bottom: 10,
              fontSize: 10, color: C.textMuted,
              opacity: commentText.length > 280 ? 1 : 0.5,
              ...(commentText.length > 280 ? { color: C.orange } : {}),
            }}>
              {commentText.length}/300
            </span>
          </div>
          <button
            onClick={() => void onSendComment()}
            disabled={!commentText.trim() || commentSending}
            style={{
              ...btnPrimary, width: 40, height: 40, padding: 0, borderRadius: 20,
              opacity: commentText.trim() ? 1 : 0.35, flexShrink: 0, fontSize: 16,
            }}
          >
            {commentSending ? '…' : '↑'}
          </button>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════
// ADD-ON OFFER HELPERS (module-level, no state)
// ═══════════════════════════════════════════════════════

const CONTEXT_ADDON_SKUS: Partial<Record<UpsellContext, string[]>> = {
  wishlist_limit:    ['extra_wishlist_slot'],
  item_limit:        ['extra_items_5', 'extra_items_15'],
  subscription_limit:['extra_subscription_slot'],
  hints:             ['hints_pack_5', 'hints_pack_10'],
  url_import:        ['import_pack_10', 'import_pack_25'],
};

function getAddonOffers(locale: Locale): Record<string, { title: string; tag: string }> {
  return {
    extra_wishlist_slot:     { title: t('addon_extra_wishlist_title', locale),      tag: t('addon_tag_extra_wishlist_slot', locale) },
    extra_subscription_slot:{ title: t('addon_extra_subscription_title', locale),  tag: t('addon_tag_extra_subscription_slot', locale) },
    extra_items_5:          { title: t('addon_extra_items_5_title', locale),        tag: t('addon_tag_extra_items_5', locale) },
    extra_items_15:         { title: t('addon_extra_items_15_title', locale),       tag: t('addon_tag_extra_items_15', locale) },
    hints_pack_5:           { title: t('addon_hints_pack_5_title', locale),         tag: t('addon_tag_hints_pack_5', locale) },
    hints_pack_10:          { title: t('addon_hints_pack_10_title', locale),        tag: t('addon_tag_hints_pack_10', locale) },
    import_pack_10:         { title: t('addon_import_pack_10_title', locale),       tag: t('addon_tag_import_pack_10', locale) },
    import_pack_25:         { title: t('addon_import_pack_25_title', locale),       tag: t('addon_tag_import_pack_25', locale) },
    seasonal_decoration:    { title: t('addon_seasonal_decoration_title', locale),  tag: t('addon_seasonal_decoration_desc', locale) },
  };
}

// ═══════════════════════════════════════════════════════
// PRO UPSELL SHEET (context-aware)
// ═══════════════════════════════════════════════════════

function ProUpsellSheet({ state, onClose, onUpgrade, checkoutLoading, onBuyAddon, addonCheckoutLoading, availableSkus, cappedAddonCodes, locale }: {
  state: UpsellSheetState;
  onClose: () => void;
  onUpgrade: () => void;
  checkoutLoading: boolean;
  onBuyAddon: (skuCode: string, targetId?: string) => void;
  addonCheckoutLoading: boolean;
  availableSkus: SkuInfo[];
  cappedAddonCodes: string[];
  locale: Locale;
}) {
  const content = state ? getUpsellContent(locale)[state.context] : null;
  return (
    <BottomSheet isOpen={state !== null} onClose={onClose}>
      {content && (
        <div style={{ textAlign: 'center', padding: '0 0 8px' }}>
          {/* Hero emoji with gradient glow */}
          <div style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 68, height: 68, borderRadius: 22,
            background: `linear-gradient(145deg, ${C.accent}22, ${C.accent}08)`,
            border: `1px solid ${C.accent}18`,
            fontSize: 32, marginBottom: 16,
          }}>
            {content.emoji}
          </div>

          <div style={{ fontSize: 20, fontWeight: 800, color: C.text, lineHeight: 1.3, fontFamily: font }}>
            {content.title}
          </div>
          <div style={{ fontSize: 14, color: C.textSec, marginTop: 8, lineHeight: 1.5, padding: '0 4px' }}>
            {content.subtitle}
          </div>

          {/* Benefits list for feature gates */}
          {content.benefits && (
            <div style={{ marginTop: 18, textAlign: 'left', padding: '0 4px' }}>
              {content.benefits.map((b, i) => (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '7px 0', fontSize: 14, color: C.textSec, lineHeight: 1.3,
                }}>
                  <span style={{
                    width: 22, height: 22, borderRadius: 11,
                    background: C.accentSoft, color: C.accent,
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 12, flexShrink: 0, fontWeight: 700,
                  }}>✓</span>
                  {b}
                </div>
              ))}
            </div>
          )}

          {/* Two semantic blocks for limit gates */}
          {content.showTable && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20 }}>
              {/* Block 1: what you have now (Free) */}
              <div style={{ background: C.bg, borderRadius: 14, padding: '12px 14px' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  {t('plan_now_block', locale)}
                </div>
                {[t('plan_free_f1', locale), t('plan_free_f2', locale), t('plan_free_f3', locale)].map((f, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '3px 0', fontSize: 13, color: C.textSec, lineHeight: 1.4 }}>
                    <span style={{ color: C.textMuted, flexShrink: 0, marginTop: 1 }}>–</span>
                    {f}
                  </div>
                ))}
              </div>
              {/* Block 2: with Pro */}
              <div style={{ background: C.card, borderRadius: 14, padding: '12px 14px', border: `1px solid ${C.accent}30` }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.accent, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  {t('plan_pro_block', locale)}
                </div>
                {getProBenefits(locale).map((b, i) => (
                  <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', padding: '3px 0', fontSize: 13, color: C.textSec, lineHeight: 1.4 }}>
                    <span style={{ color: C.green, flexShrink: 0, fontWeight: 700, marginTop: 1 }}>✓</span>
                    {b.title}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Price */}
          <div style={{ marginTop: 22, fontSize: 14, color: C.textSec }}>
            <span style={{ fontSize: 24, fontWeight: 800, color: C.text }}>100</span>
            {' '}
            <span style={{ fontSize: 16, fontWeight: 600, color: C.text }}>Stars</span>
            {' '}{t('upsell_per_month', locale)}
          </div>

          {/* CTA */}
          <button
            style={{
              ...btnPrimary, marginTop: 18, width: '100%',
              fontSize: 16, padding: '16px 24px',
              background: `linear-gradient(135deg, ${C.accent}, #6B5CE7)`,
            }}
            onClick={onUpgrade}
            disabled={checkoutLoading || addonCheckoutLoading}
          >
            {checkoutLoading ? t('upsell_checkout_loading', locale) : t('upsell_cta', locale)}
          </button>

          {/* ── One-time add-on offers (for limit-gate contexts) ── */}
          {(() => {
            const contextSkuCodes = state?.context ? (CONTEXT_ADDON_SKUS[state.context] ?? []) : [];
            const skusToShow = contextSkuCodes
              .map(code => availableSkus.find(s => s.code === code))
              .filter((s): s is SkuInfo => s !== undefined);
            if (skusToShow.length === 0) return null;
            const offers = getAddonOffers(locale);
            const isLoading = addonCheckoutLoading || checkoutLoading;
            return (
              <div style={{ marginTop: 24 }}>
                {/* Section header */}
                <div style={{ textAlign: 'left', marginBottom: 10 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.textSec, letterSpacing: 0.1 }}>
                    {t('addon_section_header', locale)}
                  </div>
                  <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                    {t('addon_section_hint', locale)}
                  </div>
                </div>

                {/* Offer cards */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {skusToShow.map(sku => {
                    const offer = offers[sku.code];
                    if (!offer) return null;
                    const isCapped = cappedAddonCodes.includes(sku.code);
                    return (
                      <div
                        key={sku.code}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 12,
                          background: isCapped ? C.card : C.surface,
                          borderRadius: 14,
                          padding: '12px 14px',
                          border: `1px solid ${isCapped ? C.borderLight : C.border}`,
                          textAlign: 'left',
                          opacity: isCapped ? 0.7 : 1,
                        }}
                      >
                        {/* Left: title + tag (or cap message) */}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: isCapped ? C.textSec : C.text, lineHeight: 1.3 }}>
                            {offer.title}
                          </div>
                          <div style={{ fontSize: 12, color: C.textMuted, marginTop: 3, lineHeight: 1.4 }}>
                            {isCapped ? t('addon_cap_reached_sub', locale) : offer.tag}
                          </div>
                        </div>

                        {/* Right: cap badge OR price + buy button */}
                        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                          {isCapped ? (
                            <div style={{
                              fontSize: 12, fontWeight: 600, color: C.textSec,
                              background: C.surface, border: `1px solid ${C.border}`,
                              borderRadius: 8, padding: '5px 10px', whiteSpace: 'nowrap',
                            }}>
                              {t('addon_cap_reached', locale)}
                            </div>
                          ) : (
                            <>
                              <div style={{ fontSize: 12, fontWeight: 700, color: C.textSec, whiteSpace: 'nowrap' }}>
                                {sku.price} ⭐
                              </div>
                              <button
                                onClick={() => onBuyAddon(sku.code, state?.wishlistId)}
                                disabled={isLoading}
                                style={{
                                  background: isLoading ? C.surface : C.accentSoft,
                                  color: C.accent,
                                  border: `1px solid ${C.accent}40`,
                                  borderRadius: 8,
                                  padding: '5px 12px',
                                  fontSize: 13,
                                  fontWeight: 700,
                                  cursor: isLoading ? 'default' : 'pointer',
                                  fontFamily: font,
                                  whiteSpace: 'nowrap',
                                  opacity: isLoading ? 0.5 : 1,
                                  transition: 'opacity 0.15s',
                                }}
                              >
                                {addonCheckoutLoading ? '…' : t('addon_cta_buy', locale)}
                              </button>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          <button
            style={{ ...btnGhost, width: '100%', marginTop: 14, fontSize: 14 }}
            onClick={onClose}
          >
            {t('upsell_not_now', locale)}
          </button>
          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 10 }}>
            {t('upsell_auto_renew', locale)}
          </div>
        </div>
      )}
    </BottomSheet>
  );
}

// ═══════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════

export default function MiniApp({ apiBase, botUsername, miniappShortName }: { apiBase: string; botUsername: string; miniappShortName: string }) {
  /** Build t.me deep link.
   *  Uses ?startapp= format which opens the Mini App directly via BotFather configuration.
   *  Format: https://t.me/<BOT>?startapp=<payload>
   *  The Mini App reads the payload from tg.initDataUnsafe.start_param or URL ?startapp= param.
   */
  const buildTgDeepLink = (payload?: string) => {
    if (!botUsername) return null;
    const base = `https://t.me/${botUsername}`;
    return payload ? `${base}?startapp=${encodeURIComponent(payload)}` : base;
  };

  const tgRef = useRef<Window['Telegram']>( undefined);
  const initDataRef = useRef<string>('');
  const urlStartParamRef = useRef<string>(''); // captured for "Open in Telegram" fallback
  const myActorHashRef = useRef<string>(''); // SHA-256 hash of tg_actor:{telegramId}

  const [screen, setScreen] = useState<Screen>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  const [tgUser, setTgUser] = useState<TgUser | null>(null);
  const [locale, setLocale] = useState<Locale>('ru');

  // Owner state
  const [wishlists, setWishlists] = useState<Wishlist[]>([]);
  const [planLimits, setPlanLimits] = useState({ wishlists: 2, items: 20 });
  const [planInfo, setPlanInfo] = useState<PlanInfo>({
    code: 'FREE', wishlists: 2, items: 20, subscriptions: 2, participants: 5, features: [],
  });
  const [subscription, setSubscription] = useState<SubscriptionInfo>(null);
  const [upsellSheet, setUpsellSheet] = useState<UpsellSheetState>(null);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [addonCheckoutLoading, setAddonCheckoutLoading] = useState(false);
  // Wishlist picker for item-scoped SKUs when user has multiple wishlists
  const [wishlistPickerSku, setWishlistPickerSku] = useState<string | null>(null);
  // Account-scoped SKUs that hit their global purchase cap this session
  const [globalCappedSkus, setGlobalCappedSkus] = useState<string[]>([]);
  // Wishlist-scoped cap: wishlistId → array of SKU codes that are capped for that wishlist
  const [wishlistCappedSkus, setWishlistCappedSkus] = useState<Record<string, string[]>>({});
  const [addOns, setAddOns] = useState<AddOnsInfo>({ extraWishlistSlots: 0, extraSubscriptionSlots: 0, seasonalWishlists: [] });
  const [credits, setCredits] = useState<CreditsInfo>({ hintCredits: 0, importCredits: 0 });
  const [availableSkus, setAvailableSkus] = useState<SkuInfo[]>([]);

  // SKU codes that are visually "globally capped" on offer cards.
  // Wishlist-scoped SKUs (extra_items_5/15, seasonal_decoration) are only globally
  // capped if EVERY wishlist has hit the cap — otherwise the card stays active so the
  // user can pick a different wishlist.
  const WISHLIST_SCOPED_SKUS = ['extra_items_5', 'extra_items_15', 'seasonal_decoration'];
  const cappedAddonCodes = useMemo<string[]>(() => {
    const result = [...globalCappedSkus];
    for (const sku of WISHLIST_SCOPED_SKUS) {
      if (wishlists.length > 0 && wishlists.every(wl => wishlistCappedSkus[wl.id]?.includes(sku))) {
        if (!result.includes(sku)) result.push(sku);
      }
    }
    return result;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalCappedSkus, wishlistCappedSkus, wishlists]);

  const [showCancelSub, setShowCancelSub] = useState(false);
  const [cancelSubLoading, setCancelSubLoading] = useState(false);

  // Onboarding state
  const [onboardingState, setOnboardingState] = useState<{
    id: string; status: string; variantKey: string | null; entryPoint: string | null;
    demoItemId: string | null; completionReason: string | null;
  } | null>(null);
  const [onboardingDemoItem, setOnboardingDemoItem] = useState<Item | null>(null);
  const [onboardingDraftsHaveUserContent, setOnboardingDraftsHaveUserContent] = useState(false);
  const [showOnboardingSoftCta, setShowOnboardingSoftCta] = useState(false);
  const [onboardingLoading, setOnboardingLoading] = useState(false);
  const onboardingCheckedRef = useRef(false); // prevent double-check per session

  const [godMode, setGodMode] = useState(false);
  const [canGodMode, setCanGodMode] = useState(false);
  const [godModeLoading, setGodModeLoading] = useState(false);
  const [santaTestModeLoading, setSantaTestModeLoading] = useState(false);
  const [godStats, setGodStats] = useState<GodStats | null>(null);
  const [godStatsLoading, setGodStatsLoading] = useState(false);
  const [godStatsError, setGodStatsError] = useState(false);
  const [godStatsRefreshedAt, setGodStatsRefreshedAt] = useState<Date | null>(null);
  const [godStatsDetailsOpen, setGodStatsDetailsOpen] = useState(false);
  const godStatsRefreshIdRef = useRef(0);
  const [currentWl, setCurrentWl] = useState<Wishlist | null>(null);
  const [items, setItems] = useState<Item[]>([]);

  // Profile state
  const [profileData, setProfileData] = useState<{
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
  } | null>(null);
  const [profileStats, setProfileStats] = useState<{
    wishlists: number; wishlistsLimit: number;
    totalWishes: number; wishesLimit: number;
    reservedByMe: number; archived: number;
  } | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);
  const [titlePressed, setTitlePressed] = useState(false); // pressed-state for tappable item title
  const [editingProfile, setEditingProfile] = useState(false);
  const [editProfileName, setEditProfileName] = useState('');
  const [editProfileUsername, setEditProfileUsername] = useState('');
  const [editProfileBio, setEditProfileBio] = useState('');
  const [editProfileBirthday, setEditProfileBirthday] = useState('');
  const [editProfileSaving, setEditProfileSaving] = useState(false);
  const bioTextareaRef = useRef<HTMLTextAreaElement>(null);
  // ── Avatar upload ─────────────────────────────────────────────────────────
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const [showAvatarSheet, setShowAvatarSheet] = useState(false);
  const [avatarUploading, setAvatarUploading] = useState(false);

  // Settings state
  const [settingsData, setSettingsData] = useState<{
    language: string;
    defaultCurrency: 'RUB' | 'USD';
    notifications: { comments: boolean; reservations: boolean; subscriptions: boolean; marketing: boolean };
    privacy: { profileVisibility: string; subscribePolicy: string; commentsEnabled: boolean; hintsEnabled: boolean };
    appBehavior: { newWishlistPosition: string };
    isPro: boolean;
    supportId?: string | null;
  } | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  // Track which screen the user came from before opening settings (for correct back navigation)
  const [settingsOriginScreen, setSettingsOriginScreen] = useState<Screen>('my-wishlists');
  const [showProfileVisibilitySheet, setShowProfileVisibilitySheet] = useState(false);
  const [showSubscribePolicySheet, setShowSubscribePolicySheet] = useState(false);
  const [showCommentsDefaultSheet, setShowCommentsDefaultSheet] = useState(false);

  // Archive state
  const [archiveItems, setArchiveItems] = useState<Item[]>([]);
  const [archiveMode, setArchiveMode] = useState<ArchiveMode>('wishlist');
  const [globalArchiveItems, setGlobalArchiveItems] = useState<GlobalArchiveItem[]>([]);
  // Archive multi-select state
  const [archiveSelectMode, setArchiveSelectMode] = useState(false);
  const [archiveSelected, setArchiveSelected] = useState<string[]>([]);
  const [showArchiveBulkDeleteConfirm, setShowArchiveBulkDeleteConfirm] = useState(false);
  const [showArchivePurgeConfirm, setShowArchivePurgeConfirm] = useState(false);
  const [archivePurgeStep, setArchivePurgeStep] = useState<1 | 2>(1);
  const [archiveBulkLoading, setArchiveBulkLoading] = useState(false);

  // My Reservations state
  const [reservations, setReservations] = useState<ReservationItem[]>([]);
  const [reservationsCount, setReservationsCount] = useState(0);
  const [reservationsLoading, setReservationsLoading] = useState(false);
  const [fromReservations, setFromReservations] = useState(false);
  const [santaDetailContext, setSantaDetailContext] = useState<{
    source: 'reservation' | 'receiver-wishlist';
    campaignId: string;
    campaignTitle: string;
    campaignStatus: string;
    giftStatus: string;
  } | null>(null);
  // Santa reservations (items reserved via Secret Santa assignment)
  const [santaReservationItems, setSantaReservationItems] = useState<SantaReservationItem[]>([]);
  const [santaReservationItemsLoading, setSantaReservationItemsLoading] = useState(false);

  // Home hub tab navigation
  const [homeTab, setHomeTab] = useState<HomeTab>('wishlists');
  const [homeReturnTab, setHomeReturnTab] = useState<HomeTab | null>(null);
  // All items flat list (for "Wishes" tab)
  const [allItems, setAllItems] = useState<AllItem[]>([]);
  const [allItemsLoading, setAllItemsLoading] = useState(false);
  const [allItemsPriorityFilter, setAllItemsPriorityFilter] = useState<number | null>(null);
  // Keyboard open detection — used to hide fixed CTAs so they don't float above the keyboard
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  // Guest state
  const [guestWl, setGuestWl] = useState<{ id: string; slug: string; title: string; description: string | null; deadline: string | null; ownerName: string | null; ownerAvatarUrl: string | null } | null>(null);
  const [guestItems, setGuestItems] = useState<GuestItem[]>([]);

  // Item detail view (for both owner and guest)
  const [viewingItem, setViewingItem] = useState<(Item | GuestItem) | null>(null);
  const [pendingEditItem, setPendingEditItem] = useState<Item | null>(null);

  // UI state
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [loading, setLoading] = useState(false);

  // Owner forms
  const [showCreateWl, setShowCreateWl] = useState(false);
  const [wlTitle, setWlTitle] = useState('');
  const [wlDeadline, setWlDeadline] = useState('');

  const [showItemForm, setShowItemForm] = useState(false);
  const [editingItem, setEditingItem] = useState<Item | null>(null);
  const [itemTitle, setItemTitle] = useState('');
  const [itemDescription, setItemDescription] = useState('');
  const itemDescTextareaRef = useRef<HTMLTextAreaElement>(null);
  const [itemUrl, setItemUrl] = useState('');
  const [itemPrice, setItemPrice] = useState(''); // raw digits only, e.g. "5000000"
  const priceInputRef = useRef<HTMLInputElement>(null);
  const [itemPriority, setItemPriority] = useState<1 | 2 | 3>(2);
  const [itemCurrency, setItemCurrency] = useState<'RUB' | 'USD'>('RUB');
  const [defaultCurrency, setDefaultCurrency] = useState<'RUB' | 'USD'>('RUB');
  const [itemImageUrl, setItemImageUrl] = useState(''); // existing/saved URL from DB

  // Photo upload state
  const [itemPhotoFile, setItemPhotoFile] = useState<File | null>(null);
  const [itemPhotoLocalUrl, setItemPhotoLocalUrl] = useState<string | null>(null);
  const [itemPhotoDeleted, setItemPhotoDeleted] = useState(false);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoPickerImgErr, setPhotoPickerImgErr] = useState(false);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // Anti-spam throttle for upsell sheets
  const upsellLastShownRef = useRef<Partial<Record<UpsellContext, number>>>({});
  const upsellAutoShownThisSession = useRef(false);

  // Delete confirmation
  const [deletingItem, setDeletingItem] = useState<Item | null>(null);

  // Rename wishlist
  const [showRenameWl, setShowRenameWl] = useState(false);
  const [renameWlTitle, setRenameWlTitle] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [showWlManage, setShowWlManage] = useState(false);
  const [showArchiveWlConfirm, setShowArchiveWlConfirm] = useState(false);
  const [archivingWl, setArchivingWl] = useState(false);

  // ── Delete wishlist flow ──────────────────────────────────────────────────
  const [showDeleteWl1, setShowDeleteWl1] = useState(false);       // step 1: confirm
  const [showDeleteWl2, setShowDeleteWl2] = useState(false);       // step 2: truly confirm
  const [showDeleteWlReserved, setShowDeleteWlReserved] = useState(false); // reserved items warning
  const [deletingWl, setDeletingWl] = useState(false);

  // ── Transfer reserved items ───────────────────────────────────────────────
  const [showTransferPicker, setShowTransferPicker] = useState(false);
  const [transferingItems, setTransferingItems] = useState(false);
  const [transferTargetId, setTransferTargetId] = useState<string | null>(null);

  // ── Privacy settings per wishlist ────────────────────────────────────────
  const [showWlPrivacy, setShowWlPrivacy] = useState(false);
  const [privacySaving, setPrivacySaving] = useState(false);
  const [privacyDraftVisibility, setPrivacyDraftVisibility] = useState<WishlistVisibility>('link_only');
  const [privacyDraftAllowSubs, setPrivacyDraftAllowSubs] = useState<AllowSubscriptions>('all');
  const [privacyDraftCommentPolicy, setPrivacyDraftCommentPolicy] = useState<CommentPolicy>('all');
  const [pendingUnreserveAction, setPendingUnreserveAction] = useState<(() => Promise<void>) | null>(null);
  const [unreservingConfirm, setUnreservingConfirm] = useState(false);

  // Subscriptions (following)
  const [myWishlistsTab, setMyWishlistsTab] = useState<'mine' | 'subscribed'>('mine');
  const [subscriptions, setSubscriptions] = useState<SubscribedWishlist[]>([]);
  const [subscriptionsLoading, setSubscriptionsLoading] = useState(false);
  // Guest subscription state
  const [guestSubId, setGuestSubId] = useState<string | null>(null);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [subscriberCount, setSubscriberCount] = useState(0);
  const [subscribing, setSubscribing] = useState(false);
  // Items with unreads (for highlight in guest-view opened from subscriptions)
  const [guestUnreadEntityIds, setGuestUnreadEntityIds] = useState<string[]>([]);

  // Guest filter & sort state
  const [guestBudgetMax, setGuestBudgetMax] = useState<number | null>(null);
  const [guestCustomBudget, setGuestCustomBudget] = useState('');
  const [guestPriorityFilter, setGuestPriorityFilter] = useState<number[]>([1, 2, 3]);
  const [guestSort, setGuestSort] = useState<GuestSort>('default');
  const [guestFilterOpen, setGuestFilterOpen] = useState(false);
  // Local (sheet-draft) states — applied only on "Apply"
  const [draftBudget, setDraftBudget] = useState<number | null>(null);
  const [draftCustomBudget, setDraftCustomBudget] = useState('');
  const [draftPriorities, setDraftPriorities] = useState<number[]>([1, 2, 3]);

  // Wishlist reorder state
  const [reorderMode, setReorderMode] = useState(false);
  const [reorderList, setReorderList] = useState<Wishlist[]>([]);
  const [reorderSaving, setReorderSaving] = useState(false);
  const [reorderDragIdx, setReorderDragIdx] = useState<number | null>(null);
  const [reorderDragOverIdx, setReorderDragOverIdx] = useState<number | null>(null);

  // Item reorder state
  const [itemReorderMode, setItemReorderMode] = useState(false);
  const [itemReorderList, setItemReorderList] = useState<Item[]>([]);
  const [itemReorderSaving, setItemReorderSaving] = useState(false);
  const [itemReorderDragIdx, setItemReorderDragIdx] = useState<number | null>(null);

  // Home tab swipe gesture tracking
  const homeSwipeStartX = useRef<number | null>(null);
  const homeSwipeStartY = useRef<number | null>(null);

  // Guest forms
  const [reservingItem, setReservingItem] = useState<GuestItem | null>(null);
  const [guestName, setGuestName] = useState('');

  // Comments
  const [comments, setComments] = useState<CommentDTO[]>([]);
  const [commentText, setCommentText] = useState('');
  const [commentRole, setCommentRole] = useState<'owner' | 'reserver' | null>(null);
  const [commentSending, setCommentSending] = useState(false);

  // Hint state
  const [hintLoading, setHintLoading] = useState(false);
  const [hintClosing, setHintClosing] = useState(false);

  // Description editing
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionText, setDescriptionText] = useState('');
  const descTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Drafts (Неразобранное)
  const [draftsWishlistId, setDraftsWishlistId] = useState<string | null>(null);
  const [draftsCount, setDraftsCount] = useState(0);
  const [draftsItems, setDraftsItems] = useState<Item[]>([]);
  const [showMovePicker, setShowMovePicker] = useState(false);
  const [movingItem, setMovingItem] = useState<Item | null>(null);
  const [pendingMoveItemId, setPendingMoveItemId] = useState<string | null>(null);
  const [importUrl, setImportUrl] = useState('');
  const [importLoading, setImportLoading] = useState(false);
  const [fromDrafts, setFromDrafts] = useState(false);
  // ── Drafts multi-select ───────────────────────────────────────────────────
  const [draftsSelectMode, setDraftsSelectMode] = useState(false);
  const [draftsSelected, setDraftsSelected] = useState<string[]>([]);
  const [showBulkMovePicker, setShowBulkMovePicker] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [draftsBulkLoading, setDraftsBulkLoading] = useState(false);

  // ── Secret Santa state ───────────────────────────────────────────────────
  const [santaSeason, setSantaSeason] = useState<{ inSeason: boolean; canCreate: boolean; seasonStart: string | null; seasonEnd: string | null; testMode: boolean } | null>(null);
  const [santaCampaigns, setSantaCampaigns] = useState<{ owned: SantaCampaignSummary[]; joined: SantaCampaignSummary[] }>({ owned: [], joined: [] });
  const [santaCampaignsLoading, setSantaCampaignsLoading] = useState(false);
  const [currentSantaCampaign, setCurrentSantaCampaign] = useState<SantaCampaignDetail | null>(null);
  const [santaCreateLoading, setSantaCreateLoading] = useState(false);
  // Create form
  const [santaCreateTitle, setSantaCreateTitle] = useState('');
  const [santaCreateDesc, setSantaCreateDesc] = useState('');
  const [santaCreateMinBudget, setSantaCreateMinBudget] = useState('');
  const [santaCreateMaxBudget, setSantaCreateMaxBudget] = useState('');
  const [santaCreateCurrency, setSantaCreateCurrency] = useState<'RUB' | 'USD'>('RUB');
  // Join (from deep link)
  const [santaJoinToken, setSantaJoinToken] = useState<string | null>(null);
  const [santaJoinPreview, setSantaJoinPreview] = useState<SantaJoinPreview | null>(null);
  const [santaJoinLoading, setSantaJoinLoading] = useState(false);
  const [santaJoinDone, setSantaJoinDone] = useState(false);
  // Link wishlist to campaign
  const [showSantaWishlistPicker, setShowSantaWishlistPicker] = useState(false);
  const [santaWishlistPickerLoading, setSantaWishlistPickerLoading] = useState(false);
  // P0: campaign id to return to after creating a new wishlist from Santa flow
  const [santaWishlistPickerReturnId, setSantaWishlistPickerReturnId] = useState<string | null>(null);
  // Receiver's wishlist (giver view — role-aware, no receiver userId)
  const [santaReceiverWishlist, setSantaReceiverWishlist] = useState<{
    role: 'giver'; giftStatus: string; giftNote: string | null;
    receiver: { displayName: string; avatarUrl: string | null };
    wishlist: { title: string } | null;
    items: { id: string; title: string; url: string | null; priceText: string | null; currency: string; priority: number; imageUrl: string | null; status: string; reservedByMe: boolean }[];
    myReservations: { id: string; title: string }[];
  } | null>(null);
  const [santaReceiverWishlistLoading, setSantaReceiverWishlistLoading] = useState(false);
  const [santaWishlistReservingId, setSantaWishlistReservingId] = useState<string | null>(null);
  const [santaSwitchModalOpen, setSantaSwitchModalOpen] = useState(false);
  // Receiver inbound status (no giver identity) — Batch 3: uses semantic signal, not raw giftStatus
  const [santaInboundStatus, setSantaInboundStatus] = useState<{
    hasGiver: boolean;
    signal: 'waiting' | 'in_progress' | 'ready' | 'received';
    canConfirmReceived: boolean;
    canReveal: boolean;
    revealedAt: string | null;
  } | null>(null);
  const [santaInboundLoading, setSantaInboundLoading] = useState(false);
  // Draw state
  const [santaDrawLoading, setSantaDrawLoading] = useState(false);
  const [santaDrawValidation, setSantaDrawValidation] = useState<{
    feasible: boolean; participantCount?: number;
    reason?: string; problematicExclusions?: { userId1: string; name1: string; userId2: string; name2: string; groupLabel?: string | null }[];
  } | null>(null);
  const [santaDrawValidationLoading, setSantaDrawValidationLoading] = useState(false);
  // Reveal state — Batch 3: includes isFirstReveal, giftNote, revealedAt
  const [santaReveal, setSantaReveal] = useState<{
    revealed: boolean;
    isFirstReveal?: boolean;
    giver?: { displayName: string; avatarUrl: null; emoji: string; adjectiveKey: string; animalKey: string };
    giftNote?: string | null;
    revealedAt?: string;
  } | null>(null);
  const [santaRevealLoading, setSantaRevealLoading] = useState(false);
  // Hint state (Batch 2.5) — giver-side
  const [santaHintRequest, setSantaHintRequest] = useState<{
    id: string; status: string; requestedAt: string; expiresAt: string; fulfilledAt: string | null;
    selectedItems: { id: string; title: string; priceText: string | null; url: string | null }[] | null;
  } | null>(null);
  const [santaHintRequestLoading, setSantaHintRequestLoading] = useState(false);
  // Hint state — receiver-side (inbound)
  const [santaHintInbound, setSantaHintInbound] = useState<{
    hasPendingHint: boolean; hint: { id: string; status: string; requestedAt: string; expiresAt: string } | null;
  } | null>(null);
  const [santaHintInboundLoading, setSantaHintInboundLoading] = useState(false);
  const [santaHintPickerOpen, setSantaHintPickerOpen] = useState(false);
  const [santaHintPickerItems, setSantaHintPickerItems] = useState<{ id: string; title: string; priceText: string | null }[]>([]);
  const [santaHintPickerSelectedIds, setSantaHintPickerSelectedIds] = useState<string[]>([]);
  const [santaHintFulfillLoading, setSantaHintFulfillLoading] = useState(false);
  // Chat state (Batch 4.1)
  type ChatMessage = {
    id: string;
    messageType: 'USER' | 'SYSTEM';
    body: string;
    systemEvent: string | null;
    payload: Record<string, string> | null;
    sender: { displayName: string; avatarUrl: null; emoji: string | null; adjectiveKey: string | null; animalKey: string | null; isMe: boolean } | null;
    createdAt: string;
  };
  const [santaChatMessages, setSantaChatMessages] = useState<ChatMessage[]>([]);
  const [santaChatHasMore, setSantaChatHasMore] = useState(false);
  const [santaChatLoading, setSantaChatLoading] = useState(false);
  const [santaChatInput, setSantaChatInput] = useState('');
  const [santaChatSending, setSantaChatSending] = useState(false);
  const [santaChatIsMuted, setSantaChatIsMuted] = useState(false);
  // Polls state (Batch 4.2)
  type PollResult = { optionIndex: number; count: number; percentage: number; voters: { displayName: string; emoji: string | null }[] | null };
  type Poll = {
    id: string; question: string; options: string[]; isAnonymous: boolean;
    createdAt: string; deadlineAt: string | null; closedAt: string | null;
    isOpen: boolean; myVote: number | null; results: PollResult[];
  };
  const [santaPolls, setSantaPolls] = useState<Poll[]>([]);
  const [santaPollsLoading, setSantaPollsLoading] = useState(false);
  const [santaPollCreateOpen, setSantaPollCreateOpen] = useState(false);
  const [santaPollCreateQuestion, setSantaPollCreateQuestion] = useState('');
  const [santaPollCreateOptions, setSantaPollCreateOptions] = useState<string[]>(['', '']);
  const [santaPollCreateAnonymous, setSantaPollCreateAnonymous] = useState(false);
  const [santaPollCreateSubmitting, setSantaPollCreateSubmitting] = useState(false);
  // Batch 5.3: Organizer panel state
  type OrganizerSummary = {
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
  const [santaOrganizerSummary, setSantaOrganizerSummary] = useState<OrganizerSummary | null>(null);
  const [santaOrganizerLoading, setSantaOrganizerLoading] = useState(false);
  // Exit request state
  const [santaExitRequestSheetOpen, setSantaExitRequestSheetOpen] = useState(false);
  const [santaExitRequestReason, setSantaExitRequestReason] = useState('');
  const [santaExitRequestSubmitting, setSantaExitRequestSubmitting] = useState(false);

  // Exclusions state (Batch 5.1)
  type ExclusionPair = { id: string; userId1: string; name1: string; userId2: string; name2: string };
  type ExclusionGroup = { id: string; label: string; activeCount: number; members: { userId: string; displayName: string; emoji: string | null; adjectiveKey: string | null; animalKey: string | null; avatarUrl: null; isStale: boolean }[] };
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

  // ── Wishes tab: filtered by priority ─────────────────────────────────────
  const filteredAllItems = useMemo(() => {
    if (allItemsPriorityFilter === null) return allItems;
    return allItems.filter((item) => item.priority === allItemsPriorityFilter);
  }, [allItems, allItemsPriorityFilter]);

  // ── Guest view: computed filtered + sorted items ─────────────────────────
  const { guestMainList, guestNoPriceBlock } = useMemo(() => {
    const isPro = planInfo.code === 'PRO';
    const budgetActive = guestBudgetMax !== null;
    const highPrioSelected = guestPriorityFilter.includes(3);

    // Step 1: filter by priority
    const byPriority = guestItems.filter(
      (item) => guestPriorityFilter.length === 0 || guestPriorityFilter.includes(item.priority),
    );

    // Step 2: split into priced-list vs no-price block (only when budget active)
    let mainList: GuestItem[];
    let noPriceBlock: GuestItem[] = [];

    if (budgetActive) {
      mainList = byPriority.filter((item) => item.price != null && item.price <= guestBudgetMax!);
      if (highPrioSelected) {
        noPriceBlock = byPriority
          .filter((item) => item.price == null && item.priority === 3)
          .slice(0, 3);
      }
    } else {
      mainList = byPriority;
    }

    // Step 3: sort main list
    const sorted = [...mainList].sort((a, b) => {
      switch (guestSort) {
        case 'price_asc': {
          const pa = a.price ?? Infinity;
          const pb = b.price ?? Infinity;
          return pa !== pb ? pa - pb : 0;
        }
        case 'price_desc': {
          const pa2 = a.price ?? -Infinity;
          const pb2 = b.price ?? -Infinity;
          return pa2 !== pb2 ? pb2 - pa2 : 0;
        }
        case 'priority_desc':
          return b.priority !== a.priority ? b.priority - a.priority : 0;
        case 'recommended':
          if (!isPro) return 0; // fallback to natural order if somehow rendered without Pro
          return guestRecommendedScore(b, guestBudgetMax) - guestRecommendedScore(a, guestBudgetMax);
        default:
          return 0; // preserve natural server order
      }
    });

    return { guestMainList: sorted, guestNoPriceBlock: noPriceBlock };
  }, [guestItems, guestBudgetMax, guestPriorityFilter, guestSort, planInfo.code]);

  // ── Guest filter active check ─────────────────────────────────────────────
  const guestFiltersActive = guestBudgetMax !== null || guestPriorityFilter.length < 3;
  const guestFilterBadge = [
    guestBudgetMax !== null ? 1 : 0,
    guestPriorityFilter.length < 3 ? 1 : 0,
  ].reduce((a, b) => a + b, 0);

  // Analytics stub — will be replaced with real analytics later
  const trackEvent = useCallback((event: string, props?: Record<string, unknown>) => {
    // eslint-disable-next-line no-console
    console.log(`[analytics] ${event}`, props ?? '');
  }, []);

  /** Show context-aware PRO upsell sheet with anti-spam throttling.
   *  auto=true (402 response): max 1 auto-show per session + 30s cooldown.
   *  explicit tap: always shows. */
  const showUpsell = useCallback((context: UpsellContext, opts?: { auto?: boolean; wishlistId?: string }) => {
    const now = Date.now();
    if (opts?.auto) {
      if (upsellAutoShownThisSession.current) return;
      if (now - (upsellLastShownRef.current[context] ?? 0) < 30_000) return;
      upsellAutoShownThisSession.current = true;
    }
    upsellLastShownRef.current[context] = now;
    setUpsellSheet({ context, wishlistId: opts?.wishlistId });
    trackEvent(`pro_entrypoint_viewed_${context}`);
    try { tgRef.current?.WebApp?.HapticFeedback?.impactOccurred?.('light'); } catch { /* ok */ }
  }, [trackEvent]);

  const pushToast = useCallback((message: string, kind: Toast['kind']) => {
    const toast: Toast = { id: crypto.randomUUID(), message, kind };
    setToasts((prev) => [toast, ...prev].slice(0, 3));
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== toast.id)), 2800);
  }, []);

  // Auto-grow textareas using useLayoutEffect (fires before paint, synchronous).
  // height:'0px' → not 'auto' → so scrollHeight = content only, not rows=2 intrinsic height.
  useLayoutEffect(() => {
    if (!editingProfile || !bioTextareaRef.current) return;
    growTextarea(bioTextareaRef.current);
  }, [editingProfile, editProfileBio]);

  useLayoutEffect(() => {
    if (!showItemForm || !itemDescTextareaRef.current) return;
    growTextarea(itemDescTextareaRef.current);
  }, [showItemForm, itemDescription]);

  useLayoutEffect(() => {
    if (!editingDescription || !descTextareaRef.current) return;
    growTextarea(descTextareaRef.current);
  }, [editingDescription, descriptionText]);

  const tgFetch = useCallback(async (path: string, init?: RequestInit) => {
    const url = `${apiBase}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'X-TG-INIT-DATA': initDataRef.current,
          ...(init?.headers as Record<string, string> | undefined),
        },
      });
      clearTimeout(timer);
      // Maintenance mode: API responds 503 + code=MAINTENANCE
      if (res.status === 503) {
        const json = await res.json().catch(() => ({})) as { code?: string };
        const err = new Error(json.code === 'MAINTENANCE' ? 'MAINTENANCE' : 'UNAVAILABLE') as Error & { kind: string };
        err.kind = json.code === 'MAINTENANCE' ? 'maintenance' : 'unavailable';
        throw err;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && (err.name === 'AbortError' || (err as { kind?: string }).kind)) {
        throw err;
      }
      const wrapped = new Error(`Fetch ${url}: ${err instanceof Error ? err.message : String(err)}`) as Error & { kind: string };
      wrapped.kind = 'unavailable';
      throw wrapped;
    }
  }, [apiBase]);

  // --- Santa season loader (used on init + after god/testMode toggles)
  const loadSantaSeason = useCallback(async () => {
    try {
      const r = await tgFetch('/tg/santa/season');
      if (r.ok) setSantaSeason(await r.json() as { inSeason: boolean; canCreate: boolean; seasonStart: string | null; seasonEnd: string | null; testMode: boolean });
    } catch {}
  }, [tgFetch]);

  const loadGodStats = useCallback(async () => {
    // Race condition guard: only apply state from the latest request
    const myId = ++godStatsRefreshIdRef.current;
    setGodStatsLoading(true);
    setGodStatsError(false);
    try {
      const r = await tgFetch('/tg/me/god-stats');
      if (myId !== godStatsRefreshIdRef.current) return; // stale response — discard
      if (r.ok) {
        setGodStats(await r.json() as GodStats);
        setGodStatsRefreshedAt(new Date());
      } else {
        setGodStatsError(true);
        // deliberately NOT clearing godStats — keep stale data visible
      }
    } catch {
      if (myId !== godStatsRefreshIdRef.current) return;
      setGodStatsError(true);
    } finally {
      if (myId === godStatsRefreshIdRef.current) setGodStatsLoading(false);
    }
  }, [tgFetch]);

  // --- Owner API calls
  const loadWishlists = useCallback(async () => {
    const res = await tgFetch('/tg/wishlists');
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${text || res.statusText}`);
    }
    const json = await res.json() as {
      wishlists: Wishlist[];
      plan: PlanInfo;
      subscription: SubscriptionInfo;
      drafts?: { wishlistId: string; count: number } | null;
      reservationsCount?: number;
      godMode?: boolean;
      canGodMode?: boolean;
      addOns?: AddOnsInfo;
      credits?: CreditsInfo;
      skus?: SkuInfo[];
    };
    setWishlists(json.wishlists);
    setPlanInfo(json.plan);
    setSubscription(json.subscription);
    if (json.godMode !== undefined) setGodMode(json.godMode);
    if (json.canGodMode !== undefined) setCanGodMode(json.canGodMode);
    setPlanLimits({ wishlists: json.plan.wishlists, items: json.plan.items });
    if (json.addOns) setAddOns(json.addOns);
    if (json.credits) setCredits(json.credits);
    if (json.skus) setAvailableSkus(json.skus);
    if (json.drafts) {
      setDraftsWishlistId(json.drafts.wishlistId);
      setDraftsCount(json.drafts.count);
    } else {
      setDraftsWishlistId(null);
      setDraftsCount(0);
    }
    setReservationsCount(json.reservationsCount ?? 0);
  }, [tgFetch]);

  const loadReservations = useCallback(async () => {
    setReservationsLoading(true);
    setSantaReservationItemsLoading(true);
    try {
      const [res, santaRes] = await Promise.all([
        tgFetch('/tg/reservations'),
        tgFetch('/tg/santa/my-reservations'),
      ]);
      if (res.ok) {
        const json = await res.json() as { reservations: ReservationItem[] };
        setReservations(json.reservations);
        const santaJson = santaRes.ok ? await santaRes.json() as { reservations: SantaReservationItem[] } : { reservations: [] };
        setSantaReservationItems(santaJson.reservations);
        setReservationsCount(json.reservations.length + santaJson.reservations.length);
      }
    } catch {
      // silent
    } finally {
      setReservationsLoading(false);
      setSantaReservationItemsLoading(false);
    }
  }, [tgFetch]);

  const loadAllItems = useCallback(async () => {
    setAllItemsLoading(true);
    try {
      const res = await tgFetch('/tg/items');
      if (!res.ok) return;
      const json = await res.json() as { items: AllItem[] };
      setAllItems(json.items);
    } catch {
      // silent
    } finally {
      setAllItemsLoading(false);
    }
  }, [tgFetch]);

  // Onboarding check — called once per session. Returns true if redirected to onboarding screens.
  const checkOnboarding = useCallback(async (): Promise<boolean> => {
    if (onboardingCheckedRef.current) return false;
    onboardingCheckedRef.current = true;
    try {
      const res = await tgFetch('/tg/onboarding/status');
      if (!res.ok) return false;
      const json = await res.json() as {
        eligible: boolean;
        reason: string;
        forcedRollout: boolean;
        draftsHaveUserContent: boolean;
        state: { id: string; status: string; variantKey: string | null; entryPoint: string | null; demoItemId: string | null; completionReason: string | null } | null;
      };
      if (json.state) setOnboardingState(json.state);
      if (!json.eligible) return false;
      setOnboardingDraftsHaveUserContent(json.draftsHaveUserContent);
      if (json.draftsHaveUserContent) {
        // Soft CTA — user has existing items in drafts; ask before showing demo
        setShowOnboardingSoftCta(true);
        return false;
      } else {
        // Direct entry — show onboarding entry screen immediately
        setScreen('onboarding-entry');
        return true;
      }
    } catch {
      // silent — onboarding is non-critical
      return false;
    }
  }, [tgFetch]);

  const startOnboarding = useCallback(async (entryPoint: string) => {
    setOnboardingLoading(true);
    try {
      const res = await tgFetch('/tg/onboarding/start', {
        method: 'POST',
        body: JSON.stringify({ onboardingKey: 'hello_activation', entryPoint }),
      });
      if (!res.ok) return;
      const json = await res.json() as {
        state: { id: string; status: string; variantKey: string | null; entryPoint: string | null; demoItemId: string | null; completionReason: string | null };
        demoItem: Item | null;
      };
      setOnboardingState(json.state);
      if (json.demoItem) setOnboardingDemoItem(json.demoItem);
      setShowOnboardingSoftCta(false);
      setScreen('onboarding-demo');
    } catch {
      // silent
    } finally {
      setOnboardingLoading(false);
    }
  }, [tgFetch]);

  const dismissOnboarding = useCallback(async () => {
    setShowOnboardingSoftCta(false);
    try {
      await tgFetch('/tg/onboarding/dismiss', {
        method: 'POST',
        body: JSON.stringify({ onboardingKey: 'hello_activation' }),
      });
      setOnboardingState(prev => prev ? { ...prev, status: 'DISMISSED' } : prev);
    } catch {
      // silent
    }
  }, [tgFetch]);

  const loadSubscriptions = useCallback(async () => {
    setSubscriptionsLoading(true);
    try {
      const res = await tgFetch('/tg/me/subscriptions');
      if (!res.ok) return;
      const json = await res.json() as { subscriptions: SubscribedWishlist[] };
      setSubscriptions(json.subscriptions);
    } catch {
      // silent
    } finally {
      setSubscriptionsLoading(false);
    }
  }, [tgFetch]);

  const loadGuestSubscriptionStatus = useCallback(async (wishlistId: string) => {
    try {
      const res = await tgFetch(`/tg/wishlists/${wishlistId}/subscribe`);
      if (!res.ok) return;
      const json = await res.json() as { subscribed: boolean; subscriberCount: number };
      setIsSubscribed(json.subscribed);
      setSubscriberCount(json.subscriberCount);
    } catch {
      // silent
    }
  }, [tgFetch]);

  const handleSubscribe = useCallback(async (wishlistId: string) => {
    setSubscribing(true);
    try {
      const res = await tgFetch(`/tg/wishlists/${wishlistId}/subscribe`, { method: 'POST' });
      if (res.status === 402) {
        showUpsell('subscription_limit', { auto: true });
        return;
      }
      if (res.status === 403) {
        const json = await res.json().catch(() => ({})) as { error?: string };
        if (json.error === 'subscriptions_closed') {
          pushToast(t('subs_closed_toast', locale), 'error');
          return;
        }
      }
      if (!res.ok) return;
      const json = await res.json() as { subscription: { id: string; wishlistId: string } };
      setGuestSubId(json.subscription.id);
      setIsSubscribed(true);
      setSubscriberCount((c) => c + 1);
      pushToast(t('sub_subscribed_toast', 'ru'), 'success');
    } catch {
      // silent
    } finally {
      setSubscribing(false);
    }
  }, [tgFetch, showUpsell, pushToast]);

  const handleUnsubscribe = useCallback(async (wishlistId: string) => {
    setSubscribing(true);
    try {
      const res = await tgFetch(`/tg/wishlists/${wishlistId}/subscribe`, { method: 'DELETE' });
      if (!res.ok) return;
      setGuestSubId(null);
      setIsSubscribed(false);
      setSubscriberCount((c) => Math.max(0, c - 1));
      pushToast(t('sub_unsubscribed_toast', 'ru'), 'success');
    } catch {
      // silent
    } finally {
      setSubscribing(false);
    }
  }, [tgFetch, pushToast]);

  const loadProfile = useCallback(async () => {
    setProfileLoading(true);
    try {
      const res = await tgFetch('/tg/me/profile');
      if (!res.ok) throw new Error();
      const data = await res.json() as {
        profile: typeof profileData;
        stats: typeof profileStats;
        plan: PlanInfo;
        subscription: SubscriptionInfo;
        godMode: boolean;
        canGodMode: boolean;
      };
      setProfileData(data.profile);
      setProfileStats(data.stats);
      if (data.profile?.defaultCurrency) setDefaultCurrency(data.profile.defaultCurrency);
      setPlanInfo(data.plan);
      if (data.subscription) setSubscription(data.subscription);
      setGodMode(data.godMode);
      setCanGodMode(data.canGodMode);
    } catch {
      pushToast(t('toast_load_error', locale), 'error');
    } finally {
      setProfileLoading(false);
    }
  }, [tgFetch, locale, pushToast]);

  const handleAvatarFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (avatarInputRef.current) avatarInputRef.current.value = '';
    if (!file.type.startsWith('image/')) {
      pushToast(t('item_photo_only_images', locale), 'error');
      return;
    }
    if (file.size > 30 * 1024 * 1024) {
      pushToast(t('item_photo_too_large', locale), 'error');
      return;
    }
    setAvatarUploading(true);
    setShowAvatarSheet(false);
    try {
      const formData = new FormData();
      formData.append('avatar', file);
      const res = await fetch(`${apiBase}/tg/me/profile/avatar`, {
        method: 'POST',
        headers: { 'X-TG-INIT-DATA': initDataRef.current },
        body: formData,
      });
      if (!res.ok) throw new Error();
      const data = await res.json() as { avatarUrl: string; avatarThumbUrl: string; avatarUpdatedAt: string };
      setProfileData(prev => prev ? { ...prev, avatarUrl: data.avatarUrl, avatarThumbUrl: data.avatarThumbUrl, avatarUpdatedAt: data.avatarUpdatedAt } : prev);
      pushToast(t('profile_avatar_saved', locale), 'success');
    } catch {
      pushToast(t('toast_save_error', locale), 'error');
    } finally {
      setAvatarUploading(false);
    }
  }, [apiBase, locale, pushToast]);

  const handleAvatarDelete = useCallback(async () => {
    setAvatarUploading(true);
    setShowAvatarSheet(false);
    try {
      const res = await fetch(`${apiBase}/tg/me/profile/avatar`, {
        method: 'DELETE',
        headers: { 'X-TG-INIT-DATA': initDataRef.current },
      });
      if (!res.ok) throw new Error();
      setProfileData(prev => prev ? { ...prev, avatarUrl: null, avatarThumbUrl: null, avatarUpdatedAt: null } : prev);
      pushToast(t('profile_avatar_removed', locale), 'success');
    } catch {
      pushToast(t('toast_save_error', locale), 'error');
    } finally {
      setAvatarUploading(false);
    }
  }, [apiBase, locale, pushToast]);

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    try {
      const res = await tgFetch('/tg/me/settings');
      if (!res.ok) throw new Error();
      setSettingsData(await res.json());
    } catch {
      pushToast(t('toast_load_error', locale), 'error');
    } finally {
      setSettingsLoading(false);
    }
  }, [tgFetch, locale, pushToast]);

  const patchSettings = useCallback(async (patch: Record<string, unknown>) => {
    try {
      const res = await tgFetch('/tg/me/settings', {
        method: 'PATCH',
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error();
      setSettingsData(await res.json());
      if (patch.defaultCurrency) setDefaultCurrency(patch.defaultCurrency as 'RUB' | 'USD');
    } catch {
      pushToast(t('toast_save_error', locale), 'error');
    }
  }, [tgFetch, locale, pushToast]);

  const loadItems = useCallback(async (wishlistId: string) => {
    const res = await tgFetch(`/tg/wishlists/${wishlistId}/items`);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`API ${res.status}: ${text || res.statusText}`);
    }
    const json = await res.json() as { items: Item[] };
    setItems(json.items);
  }, [tgFetch]);

  // --- Drafts API calls
  const loadDrafts = useCallback(async () => {
    if (!draftsWishlistId) return;
    const res = await tgFetch(`/tg/wishlists/${draftsWishlistId}/items`);
    if (!res.ok) return;
    const json = await res.json() as { items: Item[] };
    setDraftsItems(json.items);
    setDraftsCount(json.items.length);
  }, [tgFetch, draftsWishlistId]);

  const handleImportUrl = useCallback(async () => {
    const url = importUrl.trim();
    if (!url) return;
    setImportLoading(true);
    try {
      const res = await tgFetch('/tg/import-url', {
        method: 'POST',
        body: JSON.stringify({ url, source: 'miniapp' }),
      });
      if (!res.ok) {
        if (res.status === 402) {
          const body = await res.json().catch(() => ({})) as { feature?: string };
          if (body.feature === 'url_import') {
            showUpsell('url_import', { auto: true });
          } else if (planInfo.code === 'FREE') {
            showUpsell('item_limit', { auto: true });
          } else {
            pushToast(t('toast_plan_limit', locale), 'error');
          }
          return;
        }
        const body = await res.json().catch(() => ({})) as { error?: string };
        pushToast(body.error || t('toast_url_error', locale), 'error');
        return;
      }
      setImportUrl('');
      // Reload drafts + wishlists (to update drafts count)
      await loadDrafts();
      await loadWishlists();
      pushToast(t('drafts_card_created', locale), 'success');
    } catch {
      pushToast(t('toast_url_import_error', locale), 'error');
    } finally {
      setImportLoading(false);
    }
  }, [importUrl, tgFetch, pushToast, loadDrafts, loadWishlists]);

  const handleMoveItem = useCallback(async (itemId: string, targetWishlistId: string, fromItemDetail = false) => {
    try {
      const res = await tgFetch(`/tg/items/${itemId}/move`, {
        method: 'POST',
        body: JSON.stringify({ targetWishlistId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        pushToast(body.error || t('toast_move_error', locale), 'error');
        return;
      }
      const targetWl = wishlists.find(w => w.id === targetWishlistId);
      pushToast(t('drafts_moved', locale, { name: targetWl?.title || 'wishlist' }), 'success');
      setShowMovePicker(false);
      setMovingItem(null);
      if (fromItemDetail) {
        // Navigate away from item-detail: optimistically remove from drafts,
        // go to drafts if any remain, otherwise to main wishlist screen.
        const remaining = draftsItems.filter(d => d.id !== itemId);
        setDraftsItems(remaining);
        setDraftsCount(Math.max(0, remaining.length));
        setViewingItem(null);
        setFromDrafts(false);
        setScreen(remaining.length > 0 ? 'drafts' : 'my-wishlists');
      }
      // Reload drafts + wishlists to reconcile server state
      await loadDrafts();
      await loadWishlists();
    } catch {
      pushToast(t('toast_move_error_generic', locale), 'error');
    }
  }, [tgFetch, pushToast, wishlists, loadDrafts, loadWishlists, draftsItems]);

  const handleArchiveDraft = useCallback(async (item: Item) => {
    const res = await tgFetch(`/tg/items/${item.id}`, { method: 'DELETE' });
    if (!res.ok) { pushToast(t('toast_error_generic', locale), 'error'); return; }
    setDraftsItems(prev => prev.filter(i => i.id !== item.id));
    setDraftsCount(prev => Math.max(0, prev - 1));
    pushToast(t('drafts_archived_toast', locale), 'success');
  }, [tgFetch, pushToast]);

  const handleBulkMove = useCallback(async (targetWishlistId: string) => {
    if (draftsSelected.length === 0) return;
    setDraftsBulkLoading(true);
    try {
      const res = await tgFetch('/tg/items/bulk-move', {
        method: 'POST',
        body: JSON.stringify({ itemIds: draftsSelected, targetWishlistId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        pushToast(body.error || t('toast_move_error', locale), 'error');
        return;
      }
      const data = await res.json() as { moved: string[]; failed: Array<{ itemId: string; reason: string }> };
      setShowBulkMovePicker(false);
      setDraftsSelectMode(false);
      setDraftsSelected([]);
      if (data.moved.length === 0) {
        pushToast(t('toast_move_error', locale), 'error');
      } else if (data.moved.length < draftsSelected.length) {
        pushToast(t('drafts_bulk_moved_partial', locale, { moved: data.moved.length, total: draftsSelected.length }), 'success');
      } else {
        pushToast(t('drafts_bulk_moved', locale, { n: data.moved.length }), 'success');
      }
      await loadDrafts();
      await loadWishlists();
    } catch {
      pushToast(t('toast_move_error_generic', locale), 'error');
    } finally {
      setDraftsBulkLoading(false);
    }
  }, [draftsSelected, tgFetch, pushToast, locale, loadDrafts, loadWishlists]);

  const handleBulkDelete = useCallback(async () => {
    if (draftsSelected.length === 0) return;
    setDraftsBulkLoading(true);
    try {
      const res = await tgFetch('/tg/items/bulk-delete', {
        method: 'POST',
        body: JSON.stringify({ itemIds: draftsSelected }),
      });
      if (!res.ok) {
        pushToast(t('toast_error_generic', locale), 'error');
        return;
      }
      const data = await res.json() as { deleted: number };
      setShowBulkDeleteConfirm(false);
      setDraftsSelectMode(false);
      setDraftsSelected([]);
      pushToast(t('drafts_bulk_deleted', locale, { n: data.deleted }), 'success');
      await loadDrafts();
    } catch {
      pushToast(t('toast_error_generic', locale), 'error');
    } finally {
      setDraftsBulkLoading(false);
    }
  }, [draftsSelected, tgFetch, pushToast, locale, loadDrafts]);

  // --- Guest API calls
  const loadGuestWishlist = useCallback(async (param: string) => {
    type GuestResponse = {
      wishlist: { id: string; slug: string; title: string; description: string | null; deadline: string | null; ownerName?: string | null; ownerAvatarUrl?: string | null };
      items: Array<{
        id: string; title: string; description: string | null; url: string; priceText: string | null;
        imageUrl: string | null;
        priority: 'LOW' | 'MEDIUM' | 'HIGH'; status: 'AVAILABLE' | 'RESERVED' | 'PURCHASED';
        reservedByDisplayName: string | null;
        reservedByActorHash: string | null;
      }>;
    };

    // Try share-token endpoint first; fall back to slug endpoint on ANY non-ok response
    // (the share endpoint may 500 if shareToken column doesn't exist yet in DB)
    let json: GuestResponse | null = null;
    let resolved = false;
    try {
      const tokenRes = await fetch(`${apiBase}/public/share/${encodeURIComponent(param)}`, { cache: 'no-store' });
      if (tokenRes.ok) {
        json = await tokenRes.json() as GuestResponse;
        resolved = true;
      }
    } catch { /* network error — fall through to slug */ }

    if (!resolved) {
      const slugRes = await fetch(`${apiBase}/public/wishlists/${encodeURIComponent(param)}`, { cache: 'no-store' });
      if (slugRes.status === 404) throw new Error(t('error_load_failed', locale));
      if (!slugRes.ok) throw new Error(t('error_load_failed', locale));
      json = await slugRes.json() as GuestResponse;
    }

    if (!json) throw new Error(t('error_load_failed', locale));

    const priorityMap: Record<string, 1 | 2 | 3> = { LOW: 1, MEDIUM: 2, HIGH: 3 };
    setGuestWl({ ...json.wishlist, ownerName: json.wishlist.ownerName ?? null, ownerAvatarUrl: json.wishlist.ownerAvatarUrl ?? null });
    const mappedItems = json.items.map((i) => ({
      id: i.id,
      title: i.title,
      description: i.description ?? null,
      url: i.url || null,
      price: i.priceText ? Number(i.priceText) || null : null,
      imageUrl: i.imageUrl ?? null,
      priority: priorityMap[i.priority] ?? 2,
      position: (i as { position?: number }).position ?? 0,
      status: i.status.toLowerCase() as 'available' | 'reserved' | 'purchased',
      reservedByDisplayName: i.reservedByDisplayName,
      reservedByActorHash: i.reservedByActorHash ?? null,
    }));
    setGuestItems(mappedItems);
    return mappedItems;
  }, [apiBase]);

  const loadComments = useCallback(async (itemId: string) => {
    try {
      const res = await tgFetch(`/tg/items/${itemId}/comments`);
      if (res.status === 403) {
        setCommentRole(null);
        setComments([]);
        return;
      }
      if (!res.ok) {
        setCommentRole(null);
        setComments([]);
        return;
      }
      const json = await res.json() as { comments: CommentDTO[]; role: 'owner' | 'reserver' };
      setComments(json.comments);
      setCommentRole(json.role);
    } catch {
      setCommentRole(null);
      setComments([]);
    }
  }, [tgFetch]);

  const handleSendComment = useCallback(async () => {
    if (!viewingItem || !commentText.trim() || commentSending) return;
    const text = commentText.trim();
    // Client-side validation
    if (text.length > 300) { pushToast(t('comments_max_chars', locale), 'error'); return; }
    const stripped = text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s.…]+/gu, '');
    if (stripped.length === 0) { pushToast(t('comments_write_something', locale), 'error'); return; }

    setCommentSending(true);
    try {
      const res = await tgFetch(`/tg/items/${viewingItem.id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        if (res.status === 402) {
          showUpsell('comments', { auto: true });
          return;
        }
        const json = await res.json().catch(() => ({})) as { error?: string };
        if (res.status === 403 && json.error === 'comments_restricted') {
          pushToast(t('comments_restricted_toast', locale), 'error');
          return;
        }
        pushToast(json.error || t('comments_send_error', locale), 'error');
        return;
      }
      const json = await res.json() as { comment: CommentDTO };
      setComments(prev => [...prev, json.comment]);
      setCommentText('');
    } finally {
      setCommentSending(false);
    }
  }, [viewingItem, commentText, commentSending, tgFetch, pushToast]);

  const handleDeleteComment = useCallback(async (commentId: string) => {
    if (!viewingItem) return;
    const res = await tgFetch(`/tg/items/${viewingItem.id}/comments/${commentId}`, { method: 'DELETE' });
    if (res.ok) {
      setComments(prev => prev.filter(c => c.id !== commentId));
    } else {
      pushToast(t('comments_delete_error', locale), 'error');
    }
  }, [viewingItem, tgFetch, pushToast, locale]);

  const handleHintTap = useCallback(async (item: Item) => {
    if (hintLoading || hintClosing) return;
    // Free users → show upsell
    if (planInfo.code === 'FREE') { showUpsell('hints'); return; }
    setHintLoading(true);
    try {
      const res = await tgFetch(`/tg/items/${item.id}/hint`, { method: 'POST' });
      if (!res.ok) {
        if (res.status === 402) { showUpsell('hints'); return; }
        if (res.status === 403) {
          const json = await res.json().catch(() => ({})) as { error?: string };
          if (json.error === 'hints_disabled') { pushToast(t('hints_disabled_toast', locale), 'error'); return; }
        }
        const json = await res.json().catch(() => ({})) as {
          error?: string;
          message?: string;
          retryAfterSeconds?: number;
        };
        if (res.status === 429 && json.retryAfterSeconds != null) {
          const msg = (json.message || t('hint_limit_exhausted', locale)) + ' ' + formatRetryAfter(json.retryAfterSeconds, locale);
          pushToast(msg, 'error');
        } else {
          pushToast(json.message || json.error || t('comments_send_error', locale), 'error');
        }
        return;
      }
      // Show brief transition overlay, then navigate to bot chat
      try { tgRef.current?.WebApp?.HapticFeedback?.notificationOccurred?.('success'); } catch { /* ok */ }
      setHintClosing(true);
      // Minimal delay for overlay to paint, then navigate to bot
      setTimeout(() => {
        try {
          window.Telegram?.WebApp?.openTelegramLink?.(`https://t.me/${botUsername}`);
        } catch { /* ok */ }
        // Fallback: if openTelegramLink didn't close the mini app, try close()
        setTimeout(() => {
          setHintClosing(false);
          try { window.Telegram?.WebApp?.close?.(); } catch { /* ok */ }
        }, 300);
      }, 100);
    } finally {
      setHintLoading(false);
    }
  }, [hintLoading, hintClosing, planInfo, tgFetch, pushToast, showUpsell]);

  const handleSaveDescription = useCallback(async () => {
    if (!viewingItem) return;
    setLoading(true);
    try {
      const desc = descriptionText.trim() || null;
      const res = await tgFetch(`/tg/items/${viewingItem.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ description: desc }),
      });
      if (!res.ok) { pushToast(t('toast_save_error', locale), 'error'); return; }
      const updated = { ...viewingItem, description: desc };
      setViewingItem(updated);
      setItems(prev => prev.map(i => i.id === viewingItem.id ? { ...i, description: desc } : i));
      setEditingDescription(false);
      pushToast(t('description_saved', locale), 'success');
    } finally {
      setLoading(false);
    }
  }, [viewingItem, descriptionText, tgFetch, pushToast]);

  // --- Upgrade to PRO
  const handleUpgradeToPro = useCallback(async () => {
    trackEvent('pro_cta_clicked');
    setCheckoutLoading(true);
    try {
      const res = await tgFetch('/tg/billing/pro/checkout', { method: 'POST' });
      if (res.status === 409) {
        pushToast(t('toast_already_pro', locale), 'success');
        setCheckoutLoading(false);
        return;
      }
      if (!res.ok) {
        pushToast(t('toast_checkout_error', locale), 'error');
        trackEvent('checkout_failed');
        setCheckoutLoading(false);
        return;
      }
      const resData = await res.json() as { invoiceUrl?: string; alreadySubscribed?: boolean };
      if (resData.alreadySubscribed || !resData.invoiceUrl) {
        pushToast(t('toast_already_pro', locale), 'success');
        setCheckoutLoading(false);
        // Sync latest state
        try {
          const syncRes = await tgFetch('/tg/billing/pro/sync', { method: 'POST' });
          if (syncRes.ok) {
            const d = await syncRes.json() as { plan: PlanInfo; subscription: SubscriptionInfo };
            setPlanInfo(d.plan);
            setSubscription(d.subscription);
            setPlanLimits({ wishlists: d.plan.wishlists, items: d.plan.items });
          }
        } catch { /* ok */ }
        return;
      }
      const invoiceUrl = resData.invoiceUrl;
      trackEvent('checkout_started');

      const tg = tgRef.current?.WebApp;
      if (!tg?.openInvoice) {
        pushToast(t('toast_update_telegram', locale), 'error');
        setCheckoutLoading(false);
        return;
      }

      tg.HapticFeedback?.impactOccurred?.('medium');

      tg.openInvoice(invoiceUrl, async (status: string) => {
        if (status === 'paid') {
          // Poll sync until plan is PRO (bot needs time to process payment)
          let syncData: { plan: PlanInfo; subscription: SubscriptionInfo } | null = null;
          for (let attempt = 0; attempt < 6; attempt++) {
            if (attempt > 0) await new Promise(r => setTimeout(r, 1000));
            try {
              const syncRes = await tgFetch('/tg/billing/pro/sync', { method: 'POST' });
              if (syncRes.ok) {
                syncData = await syncRes.json() as { plan: PlanInfo; subscription: SubscriptionInfo };
                if (syncData.plan.code === 'PRO') break;
              }
            } catch { /* retry */ }
          }
          if (syncData?.plan.code === 'PRO') {
            setPlanInfo(syncData.plan);
            setSubscription(syncData.subscription);
            setPlanLimits({ wishlists: syncData.plan.wishlists, items: syncData.plan.items });
            tg.HapticFeedback?.notificationOccurred?.('success');
            pushToast(t('toast_pro_activated', locale), 'success');
            trackEvent('checkout_succeeded');
            setUpsellSheet(null);
            loadWishlists().catch(() => {});
            // Reload comments if user was viewing an item
            if (viewingItem) loadComments(viewingItem.id);
          } else {
            // Fallback: payment went through but sync didn't catch up yet
            pushToast(t('toast_payment_syncing', locale), 'success');
            trackEvent('checkout_succeeded');
            setUpsellSheet(null);
            // Schedule a delayed retry
            setTimeout(async () => {
              try {
                const r = await tgFetch('/tg/billing/pro/sync', { method: 'POST' });
                if (r.ok) {
                  const d = await r.json() as { plan: PlanInfo; subscription: SubscriptionInfo };
                  setPlanInfo(d.plan);
                  setSubscription(d.subscription);
                  setPlanLimits({ wishlists: d.plan.wishlists, items: d.plan.items });
                  loadWishlists().catch(() => {});
                  if (viewingItem) loadComments(viewingItem.id);
                }
              } catch { /* ok */ }
            }, 5000);
          }
        } else if (status === 'failed') {
          pushToast(t('toast_payment_failed', locale), 'error');
          trackEvent('checkout_failed');
        }
        setCheckoutLoading(false);
      });
    } catch {
      pushToast(t('error_generic', locale), 'error');
      setCheckoutLoading(false);
    }
  }, [tgFetch, pushToast, loadWishlists, trackEvent, viewingItem, loadComments]);

  // --- Subscription management (cancel / reactivate)
  const handleCancelSub = useCallback(async () => {
    setCancelSubLoading(true);
    try {
      const res = await tgFetch('/tg/billing/subscription/cancel', { method: 'POST' });
      if (res.ok) {
        const data = await res.json() as { subscription: { id: string; status: string; periodEnd: string; cancelAtPeriodEnd: boolean; cancelledAt: string | null } };
        setSubscription({
          id: data.subscription.id,
          status: data.subscription.status as 'ACTIVE' | 'CANCELLED',
          periodEnd: data.subscription.periodEnd,
          cancelAtPeriodEnd: true,
          cancelledAt: data.subscription.cancelledAt,
        });
        tgRef.current?.WebApp?.HapticFeedback?.notificationOccurred?.('warning');
        const cancelledPeriodEnd = new Date(data.subscription.periodEnd).toLocaleDateString(
          locale === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'long' },
        );
        pushToast(t('cancel_success', locale, { date: cancelledPeriodEnd }), 'success');
        trackEvent('subscription_cancelled');
      } else {
        pushToast(t('toast_cancel_error', locale), 'error');
      }
    } catch {
      pushToast(t('error_generic', locale), 'error');
    } finally {
      setCancelSubLoading(false);
      setShowCancelSub(false);
    }
  }, [tgFetch, pushToast, trackEvent, locale]);

  const handleReactivateSub = useCallback(async () => {
    setCancelSubLoading(true);
    try {
      const res = await tgFetch('/tg/billing/subscription/reactivate', { method: 'POST' });
      if (res.ok) {
        const data = await res.json() as { subscription: { id: string; status: string; periodEnd: string; cancelAtPeriodEnd: boolean; cancelledAt: string | null } };
        setSubscription({
          id: data.subscription.id,
          status: data.subscription.status as 'ACTIVE' | 'CANCELLED',
          periodEnd: data.subscription.periodEnd,
          cancelAtPeriodEnd: false,
          cancelledAt: null,
        });
        tgRef.current?.WebApp?.HapticFeedback?.notificationOccurred?.('success');
        pushToast(t('toast_renewal_resumed', locale), 'success');
        trackEvent('subscription_reactivated');
      } else {
        // Reactivate failed — maybe cancelled externally, offer new checkout
        pushToast(t('toast_renewing_new', locale), 'success');
        void handleUpgradeToPro();
      }
    } catch {
      pushToast(t('error_generic', locale), 'error');
    } finally {
      setCancelSubLoading(false);
    }
  }, [tgFetch, pushToast, trackEvent, handleUpgradeToPro]);

  // --- One-time add-on purchase
  const handleBuyAddon = useCallback(async (skuCode: string, targetId?: string) => {
    trackEvent('addon_cta_clicked', { sku: skuCode });
    setAddonCheckoutLoading(true);
    try {
      const res = await tgFetch('/tg/billing/addon/checkout', {
        method: 'POST',
        body: JSON.stringify({ skuCode, targetId }),
      });
      if (res.status === 409) {
        let errCode = 'cap_reached';
        try { errCode = ((await res.json()) as { error?: string }).error ?? 'cap_reached'; } catch { /* ignore */ }

        if (errCode === 'wishlist_cap_reached' && targetId) {
          // Per-wishlist cap — only this wishlist+SKU is capped, not the whole SKU.
          // Compute the new capped map synchronously so we can check remaining eligibility.
          const prevForWl = wishlistCappedSkus[targetId] ?? [];
          const newForWl = prevForWl.includes(skuCode) ? prevForWl : [...prevForWl, skuCode];
          const newCapped = { ...wishlistCappedSkus, [targetId]: newForWl };
          setWishlistCappedSkus(newCapped);

          // Are there other wishlists still eligible for this SKU?
          const remaining = wishlists.filter(wl => !newCapped[wl.id]?.includes(skuCode));
          if (remaining.length > 0) {
            // Re-open the picker with remaining eligible wishlists highlighted
            pushToast(t('addon_wishlist_cap_toast', locale), 'info');
            setWishlistPickerSku(skuCode);
          } else {
            // All wishlists are now capped — treat as global cap
            setGlobalCappedSkus(prev => prev.includes(skuCode) ? prev : [...prev, skuCode]);
            pushToast(t('addon_cap_reached', locale), 'info');
          }
        } else {
          // Account-scoped global cap (extra_wishlist_slot, extra_subscription_slot)
          setGlobalCappedSkus(prev => prev.includes(skuCode) ? prev : [...prev, skuCode]);
          pushToast(t('addon_cap_reached', locale), 'info');
        }
        setAddonCheckoutLoading(false);
        return;
      }
      if (!res.ok) {
        pushToast(t('addon_checkout_error', locale), 'error');
        setAddonCheckoutLoading(false);
        return;
      }
      const resData = await res.json() as { invoiceUrl?: string };
      if (!resData.invoiceUrl) {
        pushToast(t('addon_checkout_error', locale), 'error');
        setAddonCheckoutLoading(false);
        return;
      }
      const tg = tgRef.current?.WebApp;
      if (!tg?.openInvoice) {
        pushToast(t('toast_update_telegram', locale), 'error');
        setAddonCheckoutLoading(false);
        return;
      }
      tg.HapticFeedback?.impactOccurred?.('medium');
      tg.openInvoice(resData.invoiceUrl, async (status: string) => {
        if (status === 'paid') {
          // Poll sync until add-ons are updated
          let synced = false;
          for (let attempt = 0; attempt < 6; attempt++) {
            if (attempt > 0) await new Promise(r => setTimeout(r, 1000));
            try {
              const syncRes = await tgFetch('/tg/billing/addon/sync', { method: 'POST' });
              if (syncRes.ok) {
                const d = await syncRes.json() as { addOns: AddOnsInfo; credits: CreditsInfo; skus: SkuInfo[] };
                setAddOns(d.addOns);
                setCredits(d.credits);
                if (d.skus) setAvailableSkus(d.skus);
                synced = true;
                break;
              }
            } catch { /* retry */ }
          }
          tg.HapticFeedback?.notificationOccurred?.('success');
          const toastKey: string = skuCode.startsWith('extra_wishlist') ? 'addon_activated_wishlist'
            : skuCode.startsWith('extra_subscription') ? 'addon_activated_subscription'
            : skuCode.startsWith('extra_items') ? 'addon_activated_items'
            : skuCode.startsWith('hints') ? 'addon_activated_hints'
            : skuCode.startsWith('import') ? 'addon_activated_imports'
            : 'addon_activated_seasonal';
          if (synced) {
            pushToast(t(toastKey as Parameters<typeof t>[0], locale), 'success');
          } else {
            pushToast(t('addon_syncing', locale), 'success');
          }
          trackEvent('addon_checkout_succeeded', { sku: skuCode });
          setUpsellSheet(null);
          loadWishlists().catch(() => {});
        } else if (status === 'cancelled') {
          trackEvent('addon_checkout_cancelled', { sku: skuCode });
        } else if (status === 'failed') {
          pushToast(t('toast_payment_failed', locale), 'error');
          trackEvent('addon_checkout_failed', { sku: skuCode });
        }
        setAddonCheckoutLoading(false);
      });
    } catch {
      pushToast(t('addon_checkout_error', locale), 'error');
      setAddonCheckoutLoading(false);
    }
  }, [tgFetch, pushToast, trackEvent, loadWishlists, locale, wishlistCappedSkus, wishlists]);

  // --- Navigation with Telegram BackButton
  const navBack = useCallback(async () => {
    // Cancel active reorder modes before navigating away
    if (itemReorderMode) { cancelItemReorderMode(); return; }
    if (reorderMode) { cancelReorderMode(); return; }
    if (screen === 'item-detail') {
      setViewingItem(null);
      if (fromDrafts) {
        setFromDrafts(false);
        setScreen('drafts');
      } else if (homeReturnTab !== null) {
        const tab = homeReturnTab;
        setHomeReturnTab(null);
        setHomeTab(tab);
        if (tab === 'wishes') void loadAllItems();
        setScreen('my-wishlists');
      } else {
        setScreen('wishlist-detail');
      }
    } else if (screen === 'guest-item-detail') {
      setViewingItem(null);
      const ctx = santaDetailContext;
      setSantaDetailContext(null);
      if (ctx?.source === 'receiver-wishlist') {
        setScreen('santa-receiver-wishlist');
      } else if (homeReturnTab !== null) {
        const tab = homeReturnTab;
        setHomeReturnTab(null);
        setHomeTab(tab);
        if (tab === 'reservations') void loadReservations();
        setScreen('my-wishlists');
      } else if (fromReservations) {
        setFromReservations(false);
        setScreen('my-reservations');
      } else {
        setScreen('guest-view');
      }
    } else if (screen === 'my-reservations') {
      setScreen('my-wishlists');
    } else if (screen === 'drafts') {
      if (draftsSelectMode) {
        setDraftsSelectMode(false);
        setDraftsSelected([]);
      } else {
        setScreen('my-wishlists');
      }
    } else if (screen === 'wishlist-detail' || screen === 'guest-view') {
      if (itemReorderMode) cancelItemReorderMode();
      setCurrentWl(null);
      setScreen('my-wishlists');
      if (screen === 'guest-view') {
        loadWishlists().catch(() => { /* silent — screen already set */ });
      }
    } else if (screen === 'profile') {
      setScreen('my-wishlists');
    } else if (screen === 'settings') {
      // Return to the screen the user came from; fall back to my-wishlists if unknown
      const origin = settingsOriginScreen && settingsOriginScreen !== 'settings' ? settingsOriginScreen : 'my-wishlists';
      setScreen(origin);
    } else if (screen === 'my-wishlists' && santaWishlistPickerReturnId) {
      // P0: Return to Santa campaign after creating a new wishlist from the picker
      const returnCampId = santaWishlistPickerReturnId;
      setSantaWishlistPickerReturnId(null);
      const [detailRes] = await Promise.all([
        tgFetch(`/tg/santa/campaigns/${returnCampId}`),
        loadWishlists(), // refresh wishlists so the new one appears in the picker
      ]);
      if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
      setShowSantaWishlistPicker(true); // re-open picker with fresh wishlist list
      setScreen('santa-campaign');
    } else if (screen === 'santa-hub') {
      setScreen('my-wishlists');
    } else if (screen === 'santa-create') {
      setScreen('santa-hub');
    } else if (screen === 'santa-exclusions') {
      // Back from exclusions → return to campaign detail, reset exclusions state
      setSantaExclPairs([]);
      setSantaExclGroups([]);
      setSantaExclAddPairOpen(false);
      setSantaExclPairA('');
      setSantaExclPairB('');
      setSantaExclGroupSheetOpen(false);
      setSantaExclGroupLabel('');
      setSantaExclAddMemberGroupId(null);
      setSantaExclAddMemberUserId('');
      setScreen('santa-campaign');
    } else if (screen === 'santa-polls') {
      // Back from polls → return to campaign detail, reset polls state
      setSantaPolls([]);
      setSantaPollCreateOpen(false);
      setSantaPollCreateQuestion('');
      setSantaPollCreateOptions(['', '']);
      setSantaPollCreateAnonymous(false);
      setScreen('santa-campaign');
    } else if (screen === 'santa-receiver-wishlist') {
      // Back from Santa-safe wishlist → return to campaign detail, re-fetch to refresh reservedItems + status
      setSantaReceiverWishlist(null);
      setScreen('santa-campaign');
      // Re-fetch campaign detail so reservedItems + giftStatus are fresh
      if (currentSantaCampaign) {
        void tgFetch(`/tg/santa/campaigns/${currentSantaCampaign.campaign.id}`).then(r => {
          if (r.ok) r.json().then(d => setCurrentSantaCampaign(d as SantaCampaignDetail));
        });
      }
    } else if (screen === 'santa-chat') {
      // Back from chat → return to campaign detail, reset chat state
      setSantaChatMessages([]);
      setSantaChatHasMore(false);
      setSantaChatInput('');
      setSantaChatSending(false);
      setScreen('santa-campaign');
    } else if (screen === 'santa-organizer') {
      // Back from organizer panel → return to campaign detail
      setSantaOrganizerSummary(null);
      setScreen('santa-campaign');
    } else if (screen === 'santa-campaign') {
      setCurrentSantaCampaign(null);
      setSantaReceiverWishlist(null);
      setSantaWishlistReservingId(null);
      setSantaSwitchModalOpen(false);
      setSantaInboundStatus(null);
      setSantaDrawValidation(null);
      setSantaReveal(null);
      setSantaRevealLoading(false); // L5: reset reveal loading on back-nav to prevent stuck state
      setSantaHintRequest(null);
      setSantaHintInbound(null);
      setSantaHintPickerOpen(false);
      setSantaHintPickerItems([]);
      setSantaHintPickerSelectedIds([]);
      setScreen('santa-hub');
      // M2: refresh hub list so statuses (draw/cancel/complete) are not stale
      void tgFetch('/tg/santa/campaigns').then(r => r.ok ? r.json().then(d => setSantaCampaigns(d as typeof santaCampaigns)) : null);
    } else if (screen === 'santa-join') {
      setSantaJoinPreview(null);
      setSantaJoinDone(false);
      setScreen('my-wishlists');
    } else if (screen === 'onboarding-entry') {
      if (wishlists.length === 0) {
        // No wishlists yet — close Mini App (nothing to go back to)
        (window as Window & { Telegram?: { WebApp?: { close?: () => void } } }).Telegram?.WebApp?.close?.();
      } else {
        setScreen('my-wishlists');
      }
    } else if (screen === 'onboarding-demo' || screen === 'onboarding-complete') {
      setScreen('my-wishlists');
    } else if (screen === 'share') {
      setScreen('wishlist-detail');
    } else if (screen === 'archive') {
      if (archiveSelectMode) {
        setArchiveSelectMode(false);
        setArchiveSelected([]);
      } else if (archiveMode === 'global') {
        setScreen('profile');
      } else {
        setScreen('wishlist-detail');
      }
    }
  }, [screen, archiveMode, archiveSelectMode, draftsSelectMode, settingsOriginScreen, loadWishlists, loadAllItems, loadReservations, fromDrafts, fromReservations, homeReturnTab, itemReorderMode, reorderMode, santaWishlistPickerReturnId, tgFetch, setSantaCampaigns, setShowSantaWishlistPicker]);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;
    tg.BackButton.onClick(navBack);
    return () => tg.BackButton.offClick(navBack);
  }, [navBack]);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;
    if ((screen === 'my-wishlists' && !santaWishlistPickerReturnId) || screen === 'loading' || screen === 'error' || screen === 'maintenance') {
      tg.BackButton.hide();
    } else {
      tg.BackButton.show();
    }
  }, [screen, santaWishlistPickerReturnId]);

  // --- Init
  useEffect(() => {
    // Capture start_param from URL query for graceful browser fallback
    if (typeof window !== 'undefined') {
      urlStartParamRef.current = new URLSearchParams(window.location.search).get('startapp') ?? '';
    }

    let attempts = 0;
    const tryInit = () => {
      const tg = window.Telegram?.WebApp;
      if (!tg) {
        if (attempts++ < 40) {
          setTimeout(tryInit, 100); // retry up to 4s while SDK loads
        } else {
          setErrorMsg(t('error_open_in_telegram', locale));
          setScreen('error');
        }
        return;
      }

      try {
        tgRef.current = window.Telegram;
        initDataRef.current = tg.initData;
        tg.ready();
        tg.expand();
        try { tg.setHeaderColor(C.bg); } catch { /* some versions don't support */ }
        try { tg.setBackgroundColor(C.bg); } catch { /* some versions don't support */ }
      } catch (sdkErr) {
        // eslint-disable-next-line no-console
        console.error('[WishBoard] SDK error:', sdkErr);
        setErrorMsg(t('error_load_failed', locale));
        setScreen('error');
        return;
      }

      // start_param from deep link (?startapp=) OR from URL query (?startapp=)
      // The URL query fallback handles WebApp-button opens from bot messages
      // (when bot replies to /start with an inline webApp button, start_param is not set
      //  but the URL contains ?startapp=<payload>)
      const startParam = tg.initDataUnsafe.start_param
        || new URLSearchParams(window.location.search).get('startapp')
        || '';
      const user = tg.initDataUnsafe.user;
      if (user) {
        setTgUser(user);
        computeActorHash(user.id).then(h => { myActorHashRef.current = h; }).catch(() => {});
      }
      const lang = tg?.initDataUnsafe?.user?.language_code;
      if (lang !== undefined) {
        const detectedLocale = detectLocale(lang);
        setLocale(detectedLocale);
        // Seed default currency from locale so the create-item form is correct
        // before profile is lazily loaded. loadProfile() will override this if
        // the user has explicitly set a different currency preference.
        if (detectedLocale !== 'ru') setDefaultCurrency('USD');
      }

      // If not inside real Telegram (initData is empty), show "Open in Telegram"
      // instead of attempting a doomed auth/API flow.
      if (!tg.initData) {
        setErrorMsg(t('error_open_in_telegram', locale));
        setScreen('error');
        return;
      }

      const handleErr = (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        const kind = (e as { kind?: string }).kind;
        // eslint-disable-next-line no-console
        console.error('[WishBoard]', msg, { apiBase, initData: tg.initData?.substring(0, 50) });
        if (kind === 'maintenance' || msg === 'MAINTENANCE') {
          setScreen('maintenance');
        } else if (kind === 'unavailable' || msg === 'UNAVAILABLE') {
          setScreen('maintenance');
        } else {
          setErrorMsg(t('error_load_failed', locale));
          setScreen('error');
        }
      };

      if (startParam && startParam.startsWith('santa_')) {
        // Deep link from Santa invite.
        // Two formats are supported:
        //   santa_join_{token}  — generated by bot when handling /start command
        //   santa_{token}       — direct link copied from campaign screen
        const isBotFormat = startParam.startsWith('santa_join_');
        const token = isBotFormat
          ? startParam.slice('santa_join_'.length)
          : startParam.slice('santa_'.length);
        setSantaJoinToken(token);
        setSantaJoinDone(false);
        setSantaJoinLoading(true);
        tgFetch(`/tg/santa/invite/${encodeURIComponent(token)}`)
          .then(async (res) => {
            if (res.ok) {
              const json = await res.json() as { campaign: SantaJoinPreview; alreadyJoined?: boolean };
              setSantaJoinPreview(json.campaign);
              if (json.alreadyJoined) {
                // Already a participant — navigate directly to campaign detail
                const detailRes = await tgFetch(`/tg/santa/campaigns/${json.campaign.id}`);
                if (detailRes.ok) {
                  setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                  setScreen('santa-campaign');
                } else {
                  setScreen('santa-join'); // fallback: show preview
                }
              } else {
                setScreen('santa-join');
              }
            } else {
              const json = await res.json() as { error?: string; campaignId?: string };
              setSantaJoinPreview(null);
              if (json.error === 'Campaign cancelled') {
                setSantaJoinPreview({ id: '', title: '', description: null, status: 'CANCELLED', type: 'CLASSIC', minBudget: null, maxBudget: null, currency: 'RUB', participantCount: 0, ownerName: null, ownerAvatarUrl: null });
              } else if (json.campaignId) {
                // Campaign not accepting new members — check if user is a participant
                const detailRes = await tgFetch(`/tg/santa/campaigns/${json.campaignId}`);
                if (detailRes.ok) {
                  setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                  setScreen('santa-campaign');
                  return; // skip santa-join
                }
              }
              setScreen('santa-join');
            }
          })
          .catch(() => setScreen('my-wishlists'))
          .finally(() => setSantaJoinLoading(false));
        loadWishlists().catch(() => {});
      } else if (startParam && startParam.startsWith('draft_')) {
        // Deep link from bot: open draft item
        const draftItemId = startParam.slice(6); // strip "draft_"
        loadWishlists()
          .then(async () => {
            // Load drafts items to find the target
            const dRes = await tgFetch('/tg/wishlists');
            if (dRes.ok) {
              const dJson = await dRes.json() as { drafts?: { wishlistId: string; count: number } | null };
              if (dJson.drafts) {
                const itemsRes = await tgFetch(`/tg/wishlists/${dJson.drafts.wishlistId}/items`);
                if (itemsRes.ok) {
                  const itemsJson = await itemsRes.json() as { items: Item[] };
                  setDraftsItems(itemsJson.items);
                  setDraftsCount(itemsJson.items.length);
                  setDraftsWishlistId(dJson.drafts.wishlistId);
                  const found = itemsJson.items.find(i => i.id === draftItemId);
                  if (found) {
                    setViewingItem(found);
                    setFromDrafts(true);
                    setScreen('item-detail');
                    return;
                  }
                }
              }
            }
            // Fallback: show drafts list
            setScreen('drafts');
          })
          .catch(handleErr);
      } else if (startParam && startParam.includes('__item_')) {
        // Deep link to specific item (e.g. from hint): <slug>__item_<itemId>
        const sepIdx = startParam.indexOf('__item_');
        const slug = startParam.slice(0, sepIdx);
        const targetItemId = startParam.slice(sepIdx + 7);
        loadGuestWishlist(slug)
          .then((items) => {
            const found = items.find((i) => i.id === targetItemId);
            if (found) {
              setViewingItem(found);
              setScreen('guest-item-detail');
            } else {
              // Item not found (deleted/completed) — show wishlist
              setScreen('guest-view');
            }
          })
          .catch(handleErr);
        loadWishlists().catch(() => { /* non-critical for guest flow */ });
      } else if (startParam) {
        // Load guest wishlist AND owner wishlists in parallel.
        // Owner wishlists are needed so that "back" from guest-view shows
        // the user's own data instead of an empty "Пока пусто" screen.
        loadGuestWishlist(startParam)
          .then(() => setScreen('guest-view'))
          .catch(handleErr);
        loadWishlists().catch(() => { /* non-critical for guest flow */ });
      } else {
        loadWishlists()
          .then(async () => {
            void loadReservations();
            // Check onboarding first — if eligible, it sets screen to 'onboarding-entry'
            const redirected = await checkOnboarding();
            if (!redirected) setScreen('my-wishlists');
          })
          .catch(handleErr);
      }
      // Always pre-load profile data so ownerName is available on the
      // Share screen without requiring the user to visit Profile first.
      loadProfile().catch(() => { /* non-critical — share screen has fallback */ });
      // Pre-load Santa season info
      loadSantaSeason().catch(() => {});
    };
    tryInit();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load god stats when god mode is enabled; clear when disabled
  useEffect(() => {
    if (godMode) void loadGodStats();
    else { setGodStats(null); setGodStatsError(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [godMode]);

  // --- Keyboard open detection via visualViewport (hides fixed bottom CTAs)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const vv = window.visualViewport;
    const handleResize = () => {
      // Keyboard is considered open when visual viewport shrinks >150px vs window height
      setKeyboardOpen(window.innerHeight - vv.height > 150);
    };
    vv.addEventListener('resize', handleResize);
    return () => vv.removeEventListener('resize', handleResize);
  }, []);

  // --- Scroll boundary guard: prevent gesture leakage into Telegram WebView dismiss ─────────────
  // Problem: when the user is at the bottom of the scroll container and tries to scroll
  // back UP, the initial gesture momentarily looks like an overscroll bounce at the
  // bottom edge.  iOS/Telegram's WKWebView then hijacks the subsequent upward motion
  // as a "swipe to dismiss the mini-app" gesture instead of letting the container
  // scroll back up.
  //
  // Mechanism: we track the touch start position and, on each touchmove, if the
  // container is sitting exactly at its top (scrollTop ≤ 0) and the finger is moving
  // DOWN, OR at its bottom (scrollTop + clientHeight ≥ scrollHeight) and the finger
  // is moving UP, we call preventDefault() to absorb the overscroll before it can
  // propagate to the native dismiss handler.  This must be { passive: false } so
  // preventDefault() is actually honoured.
  //
  // This is intentionally placed on the global scroll container so every list screen
  // (wishlist-detail, archive, drafts, my-reservations, guest-view, Santa screens)
  // benefits automatically — no per-screen wiring needed.
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;

    let startY = 0;

    const onTouchStart = (e: TouchEvent) => {
      startY = e.touches[0]?.clientY ?? 0;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!e.touches[0]) return;
      const dy = e.touches[0].clientY - startY; // > 0 = finger moved down

      const atTop    = el.scrollTop <= 0;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;

      // At top + pulling down → would bounce up (and look like a dismiss swipe)
      // At bottom + pushing up → would bounce down → Telegram then intercepts the
      //   next downward motion as "close app" instead of "scroll back up"
      if ((atTop && dy > 0) || (atBottom && dy < 0)) {
        e.preventDefault();
      }
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove',  onTouchMove,  { passive: false });

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove',  onTouchMove);
    };
  }, []); // runs once — el is stable (ref, never replaced)

  // --- Load subscription status when entering guest-view (for subscribe button)
  useEffect(() => {
    if (screen === 'guest-view' && guestWl && tgUser) {
      void loadGuestSubscriptionStatus(guestWl.id);
    }
    if (screen !== 'guest-view') {
      // Reset guest subscription state when leaving guest-view
      setIsSubscribed(false);
      setSubscriberCount(0);
      setGuestSubId(null);
      setGuestUnreadEntityIds([]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, guestWl?.id]);

  // --- Ownership detection: if user opens their OWN wishlist via a shared link,
  // switch from guest-view to owner wishlist-detail automatically.
  useEffect(() => {
    if (screen === 'guest-view' && guestWl && wishlists.length > 0) {
      const ownWl = wishlists.find((w) => w.id === guestWl.id || w.slug === guestWl.slug);
      if (ownWl) {
        setCurrentWl(ownWl);
        loadItems(ownWl.id).catch(() => { /* silent */ });
        setScreen('wishlist-detail');
      }
    }
  }, [screen, guestWl, wishlists, loadItems]);


  // --- Deferred edit: open edit form AFTER navigating to the target screen.
  // For regular items: navigate to wishlist-detail first (BottomSheet inside
  // position:fixed+overflowY:auto glitches in Telegram WebView).
  // For draft items: navigate to 'drafts' — the form is a global BottomSheet
  // (position:fixed) so it renders correctly on top of any screen.
  useEffect(() => {
    if (!pendingEditItem) return;
    if (screen === 'wishlist-detail' || screen === 'drafts') {
      openEditItem(pendingEditItem);
      setPendingEditItem(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingEditItem, screen]);

  // Load comments when viewing an item detail screen
  useEffect(() => {
    if (viewingItem && (screen === 'item-detail' || screen === 'guest-item-detail')) {
      loadComments(viewingItem.id);
      // Mark comments as read for reservation items (fire-and-forget)
      if (screen === 'guest-item-detail' && fromReservations) {
        tgFetch(`/tg/items/${viewingItem.id}/comments/mark-read`, { method: 'POST', body: '{}' }).catch(() => {});
        setReservations((prev) => prev.map((r) => r.id === viewingItem.id ? { ...r, unreadComments: 0 } : r));
      }
    } else {
      setComments([]);
      setCommentRole(null);
      setCommentText('');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewingItem, screen, loadComments]);

  // Auto-load receiver wishlist when giver card mounts with a linked wishlist
  useEffect(() => {
    if (
      screen === 'santa-campaign' &&
      currentSantaCampaign?.campaign.status === 'ACTIVE' &&
      currentSantaCampaign.myAssignment?.receiver.hasLinkedWishlist &&
      !santaReceiverWishlist &&
      !santaReceiverWishlistLoading
    ) {
      const campId = currentSantaCampaign.campaign.id;
      setSantaReceiverWishlistLoading(true);
      tgFetch(`/tg/santa/campaigns/${campId}/inbound/wishlist`)
        .then(res => res.ok ? res.json() : null)
        .then(data => { if (data) setSantaReceiverWishlist(data as typeof santaReceiverWishlist); })
        .finally(() => setSantaReceiverWishlistLoading(false));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screen, currentSantaCampaign?.campaign.id, currentSantaCampaign?.myAssignment?.receiver.hasLinkedWishlist]);

  // --- Owner actions
  const handleCreateWishlist = async () => {
    if (!wlTitle.trim()) return;
    setLoading(true);
    try {
      const res = await tgFetch('/tg/wishlists', {
        method: 'POST',
        body: JSON.stringify({ title: wlTitle.trim(), deadline: wlDeadline ? new Date(wlDeadline).toISOString() : null }),
      });
      if (res.status === 402) {
        if (planInfo.code === 'FREE') {
          showUpsell('wishlist_limit', { auto: true });
        } else {
          pushToast(t('toast_max_wishlists', locale, { n: planLimits.wishlists }), 'error');
        }
        return;
      }
      if (!res.ok) { pushToast(t('toast_create_error', locale), 'error'); return; }
      const json = await res.json() as { wishlist: Wishlist };
      const addToTop = !settingsData || settingsData.appBehavior.newWishlistPosition !== 'bottom';
      setWishlists((prev) => addToTop ? [json.wishlist, ...prev] : [...prev, json.wishlist]);
      setShowCreateWl(false);
      setWlTitle(''); setWlDeadline('');
      // If there was a deferred move intent (user tapped "Move" but had no wishlist yet),
      // auto-complete the move into the newly created wishlist.
      if (pendingMoveItemId) {
        const itemId = pendingMoveItemId;
        setPendingMoveItemId(null);
        try {
          const mRes = await tgFetch(`/tg/items/${itemId}/move`, {
            method: 'POST',
            body: JSON.stringify({ targetWishlistId: json.wishlist.id }),
          });
          if (mRes.ok) {
            void loadDrafts();
            // Update itemCount in the wishlists state so home counter reflects the moved item
            setWishlists(prev => prev.map(wl => wl.id === json.wishlist.id ? { ...wl, itemCount: wl.itemCount + 1 } : wl));
            pushToast(t('drafts_moved', locale, { name: json.wishlist.title }), 'success');
          } else {
            pushToast(t('wishlist_created', locale), 'success');
          }
        } catch {
          pushToast(t('wishlist_created', locale), 'success');
        }
      } else {
        pushToast(t('wishlist_created', locale), 'success');
      }
      // Navigate into new wishlist and load its items (will include moved item if move succeeded)
      setCurrentWl(json.wishlist);
      setItems([]);
      await loadItems(json.wishlist.id);
      setScreen('wishlist-detail');
    } finally {
      setLoading(false);
    }
  };

  const enterReorderMode = () => {
    tgRef.current?.WebApp?.expand?.();
    tgRef.current?.WebApp?.disableVerticalSwipes?.();
    setReorderList([...wishlists]);
    setReorderDragIdx(null);
    setReorderDragOverIdx(null);
    setReorderMode(true);
  };

  const cancelReorderMode = () => {
    tgRef.current?.WebApp?.enableVerticalSwipes?.();
    setReorderMode(false);
    setReorderList([]);
    setReorderDragIdx(null);
    setReorderDragOverIdx(null);
  };

  const handleSaveReorder = async () => {
    if (reorderSaving) return;
    setReorderSaving(true);
    try {
      const res = await tgFetch('/tg/wishlists/reorder', {
        method: 'POST',
        body: JSON.stringify({ orderedIds: reorderList.map(w => w.id) }),
      });
      if (!res.ok) { pushToast(t('wl_reorder_error', locale), 'error'); return; }
      setWishlists([...reorderList]);
      tgRef.current?.WebApp?.enableVerticalSwipes?.();
      setReorderMode(false);
      setReorderList([]);
      pushToast(t('wl_reorder_saved', locale), 'success');
    } finally {
      setReorderSaving(false);
    }
  };

  // Scroll container ref for auto-scroll during drag
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Drag-and-drop handlers for wishlist reorder (pointer capture)
  const reorderPointerStartY = useRef<number>(0);
  const reorderPointerIdx = useRef<number | null>(null);

  const handleReorderPointerDown = (e: React.PointerEvent, idx: number) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    reorderPointerStartY.current = e.clientY;
    reorderPointerIdx.current = idx;
    setReorderDragIdx(idx);
    setReorderDragOverIdx(idx);
  };

  const handleReorderPointerMove = (e: React.PointerEvent, idx: number) => {
    e.preventDefault();
    if (reorderPointerIdx.current === null || reorderPointerIdx.current !== idx) return;

    // Auto-scroll when pointer is near viewport edges
    const sc = scrollContainerRef.current;
    if (sc) {
      const SCROLL_ZONE = 80;
      const SCROLL_SPEED = 8;
      if (e.clientY < SCROLL_ZONE) sc.scrollTop -= SCROLL_SPEED;
      else if (e.clientY > window.innerHeight - SCROLL_ZONE) sc.scrollTop += SCROLL_SPEED;
    }

    const deltaY = e.clientY - reorderPointerStartY.current;
    const cardHeight = 82; // approximate card height + gap
    const steps = Math.round(deltaY / cardHeight);
    const newIdx = Math.max(0, Math.min(reorderList.length - 1, idx + steps));
    setReorderDragOverIdx(newIdx);
    if (newIdx !== reorderDragOverIdx) {
      setReorderList(prev => {
        const next = [...prev];
        const [item] = next.splice(idx, 1);
        next.splice(newIdx, 0, item!);
        reorderPointerIdx.current = newIdx;
        reorderPointerStartY.current = e.clientY;
        return next;
      });
      setReorderDragIdx(newIdx);
      setReorderDragOverIdx(newIdx);
    }
  };

  const handleReorderPointerUp = () => {
    reorderPointerIdx.current = null;
    setReorderDragIdx(null);
    setReorderDragOverIdx(null);
  };

  // ── Item reorder handlers ──────────────────────────────────────────────────
  const enterItemReorderMode = () => {
    tgRef.current?.WebApp?.expand?.();
    tgRef.current?.WebApp?.disableVerticalSwipes?.();
    setItemReorderList([...items]);
    setItemReorderDragIdx(null);
    setItemReorderMode(true);
  };

  const cancelItemReorderMode = () => {
    tgRef.current?.WebApp?.enableVerticalSwipes?.();
    setItemReorderMode(false);
    setItemReorderList([]);
    setItemReorderDragIdx(null);
  };

  const handleSaveItemReorder = async () => {
    if (itemReorderSaving || !currentWl) return;
    setItemReorderSaving(true);
    try {
      const prioMap: Record<number, 'LOW' | 'MEDIUM' | 'HIGH'> = { 3: 'HIGH', 2: 'MEDIUM', 1: 'LOW' };
      const groups = ([3, 2, 1] as const)
        .map(prioNum => {
          const orderedIds = itemReorderList
            .filter(it => it.priority === prioNum)
            .map(it => it.id);
          return orderedIds.length > 0 ? { priority: prioMap[prioNum]!, orderedIds } : null;
        })
        .filter((g): g is NonNullable<typeof g> => g !== null);

      const res = await tgFetch(`/tg/wishlists/${currentWl.id}/items/reorder`, {
        method: 'POST',
        body: JSON.stringify({ groups }),
      });
      if (!res.ok) { pushToast(t('wl_reorder_error', locale), 'error'); return; }
      setItems([...itemReorderList]);
      tgRef.current?.WebApp?.enableVerticalSwipes?.();
      setItemReorderMode(false);
      setItemReorderList([]);
      pushToast(t('wl_reorder_saved', locale), 'success');
    } finally {
      setItemReorderSaving(false);
    }
  };

  const itemReorderPointerStartY = useRef<number>(0);
  const itemReorderPointerIdx = useRef<number | null>(null);

  const handleItemReorderPointerDown = (e: React.PointerEvent, idx: number) => {
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    itemReorderPointerStartY.current = e.clientY;
    itemReorderPointerIdx.current = idx;
    setItemReorderDragIdx(idx);
  };

  const handleItemReorderPointerMove = (e: React.PointerEvent, idx: number) => {
    e.preventDefault();
    if (itemReorderPointerIdx.current === null || itemReorderPointerIdx.current !== idx) return;

    // Auto-scroll when pointer is near viewport edges
    const sc = scrollContainerRef.current;
    if (sc) {
      const SCROLL_ZONE = 80;
      const SCROLL_SPEED = 8;
      if (e.clientY < SCROLL_ZONE) sc.scrollTop -= SCROLL_SPEED;
      else if (e.clientY > window.innerHeight - SCROLL_ZONE) sc.scrollTop += SCROLL_SPEED;
    }

    const deltaY = e.clientY - itemReorderPointerStartY.current;
    const cardHeight = 72;
    const steps = Math.round(deltaY / cardHeight);
    const draggedItem = itemReorderList[idx];
    if (!draggedItem) return;

    // Only allow dragging within same priority group
    const samePrioIndices = itemReorderList
      .map((it, i) => it.priority === draggedItem.priority ? i : -1)
      .filter(i => i >= 0);
    const minIdx = samePrioIndices[0] ?? 0;
    const maxIdx = samePrioIndices[samePrioIndices.length - 1] ?? itemReorderList.length - 1;
    const newIdx = Math.max(minIdx, Math.min(maxIdx, idx + steps));

    if (newIdx !== idx) {
      setItemReorderList(prev => {
        const next = [...prev];
        const [item] = next.splice(idx, 1);
        next.splice(newIdx, 0, item!);
        itemReorderPointerIdx.current = newIdx;
        itemReorderPointerStartY.current = e.clientY;
        return next;
      });
      setItemReorderDragIdx(newIdx);
    }
  };

  const handleItemReorderPointerUp = () => {
    itemReorderPointerIdx.current = null;
    setItemReorderDragIdx(null);
  };

  const handleRenameWishlist = async () => {
    if (!currentWl) return;
    const trimmed = renameWlTitle.trim();
    if (!trimmed || trimmed === currentWl.title) return;
    setRenameSaving(true);
    try {
      const res = await tgFetch(`/tg/wishlists/${currentWl.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) { pushToast(t('toast_save_error', locale), 'error'); return; }
      const json = await res.json() as { wishlist: { title: string } };
      const newTitle = json.wishlist.title;
      setCurrentWl((prev) => prev ? { ...prev, title: newTitle } : prev);
      setWishlists((prev) => prev.map((wl) => wl.id === currentWl.id ? { ...wl, title: newTitle } : wl));
      setShowRenameWl(false);
      pushToast(t('rename_success', locale), 'success');
    } finally {
      setRenameSaving(false);
    }
  };

  const openWishlist = async (wl: Wishlist) => {
    setCurrentWl(wl);
    setScreen('wishlist-detail');
    setLoading(true);
    try {
      await loadItems(wl.id);
    } catch {
      pushToast(t('toast_load_error', locale), 'error');
    } finally {
      setLoading(false);
    }
  };

  const resetItemForm = () => {
    setItemTitle(''); setItemDescription(''); setItemUrl(''); setItemPrice(''); setItemPriority(2); setItemCurrency(defaultCurrency); setItemImageUrl('');
    setItemPhotoFile(null);
    if (itemPhotoLocalUrl) URL.revokeObjectURL(itemPhotoLocalUrl);
    setItemPhotoLocalUrl(null);
    setItemPhotoDeleted(false);
    setPhotoError(null);
    setPhotoPickerImgErr(false);
    setEditingItem(null);
    if (photoInputRef.current) photoInputRef.current.value = '';
  };

  const openEditItem = (item: Item) => {
    setEditingItem(item);
    setItemTitle(item.title);
    setItemDescription(item.description?.replace(/\n+$/, '') ?? '');
    setItemUrl(item.url ?? '');
    setItemPrice(item.price != null ? String(item.price) : '');
    setItemPriority(item.priority);
    setItemCurrency(item.currency ?? 'RUB');
    setItemImageUrl(item.imageUrl ?? '');
    setItemPhotoFile(null);
    if (itemPhotoLocalUrl) URL.revokeObjectURL(itemPhotoLocalUrl);
    setItemPhotoLocalUrl(null);
    setItemPhotoDeleted(false);
    setPhotoError(null);
    setPhotoPickerImgErr(false);
    if (photoInputRef.current) photoInputRef.current.value = '';
    setShowItemForm(true);
  };

  const handlePhotoSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoError(null);
    if (!file.type.startsWith('image/')) {
      setPhotoError(t('item_photo_only_images', locale));
      if (photoInputRef.current) photoInputRef.current.value = '';
      return;
    }
    if (file.size > 30 * 1024 * 1024) {
      setPhotoError(t('item_photo_too_large', locale));
      if (photoInputRef.current) photoInputRef.current.value = '';
      return;
    }
    if (itemPhotoLocalUrl) URL.revokeObjectURL(itemPhotoLocalUrl);
    const localUrl = URL.createObjectURL(file);
    setItemPhotoFile(file);
    setItemPhotoLocalUrl(localUrl);
    setItemPhotoDeleted(false);
  };

  const handlePhotoDelete = () => {
    if (itemPhotoLocalUrl) URL.revokeObjectURL(itemPhotoLocalUrl);
    setItemPhotoFile(null);
    setItemPhotoLocalUrl(null);
    setItemPhotoDeleted(true);
    setPhotoError(null);
    if (photoInputRef.current) photoInputRef.current.value = '';
  };

  const uploadPhoto = useCallback(async (itemId: string, file: File): Promise<string | null> => {
    const formData = new FormData();
    formData.append('photo', file);
    try {
      const res = await fetch(`${apiBase}/tg/items/${itemId}/photo`, {
        method: 'POST',
        headers: { 'X-TG-INIT-DATA': initDataRef.current },
        body: formData,
      });
      if (!res.ok) {
        let msg = t('item_photo_error', locale);
        try { const j = await res.json() as { error?: string }; if (j.error) msg = j.error; } catch { /* */ }
        setPhotoError(msg);
        return null;
      }
      const json = await res.json() as { photoUrl: string };
      return json.photoUrl;
    } catch {
      setPhotoError(t('item_photo_network_error', locale));
      return null;
    }
  }, [apiBase, initDataRef]);

  const handleSaveItem = async () => {
    if (!itemTitle.trim()) return;
    // currentWl is only required when creating a new item; for edits we use editingItem.wishlistId
    if (!editingItem && !currentWl) return;
    setLoading(true);
    setPhotoError(null);
    try {
      const body = {
        title: itemTitle.trim(),
        description: itemDescription.trim() || null,
        url: itemUrl.trim() || undefined,
        price: itemPrice ? Number(itemPrice) : null,
        priority: itemPriority,
        currency: itemCurrency,
        // imageUrl is managed via dedicated photo endpoints — not sent here
      };

      if (editingItem) {
        const res = await tgFetch(`/tg/items/${editingItem.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        if (!res.ok) { pushToast(t('toast_save_error', locale), 'error'); return; }
        const json = await res.json() as { item: Item };
        let finalItem = json.item;

        if (itemPhotoFile) {
          setPhotoUploading(true);
          const photoUrl = await uploadPhoto(editingItem.id, itemPhotoFile);
          setPhotoUploading(false);
          if (photoUrl) finalItem = { ...finalItem, imageUrl: photoUrl };
        } else if (itemPhotoDeleted && editingItem.imageUrl) {
          const delRes = await tgFetch(`/tg/items/${editingItem.id}/photo`, { method: 'DELETE' });
          if (delRes.ok) finalItem = { ...finalItem, imageUrl: null };
        }

        // Reload the right container. Draft items live in SYSTEM_DRAFTS — use
        // loadDrafts() so the drafts list reflects the update. Regular items use
        // loadItems() which reloads the current wishlist sorted by priority DESC.
        const savingDraftItem = editingItem.wishlistId === draftsWishlistId;
        if (savingDraftItem) {
          await loadDrafts();
          setScreen('drafts'); // Return to drafts screen after saving
        } else {
          await loadItems(editingItem.wishlistId ?? currentWl!.id);
        }
        pushToast(t('item_saved', locale), 'success');
      } else {
        // currentWl is guaranteed non-null here: the early return above
        // (`if (!editingItem && !currentWl) return`) ensures this branch is only
        // reached when creating a new item, which requires currentWl to be set.
        const res = await tgFetch(`/tg/wishlists/${currentWl!.id}/items`, { method: 'POST', body: JSON.stringify(body) });
        if (res.status === 402) {
          if (planInfo.code === 'FREE') {
            showUpsell('item_limit', { auto: true, wishlistId: currentWl!.id });
          } else {
            pushToast(t('toast_max_items', locale, { n: planLimits.items + (addOns.extraItemsPerWishlist?.[currentWl!.id] ?? 0) }), 'error');
          }
          return;
        }
        if (!res.ok) { pushToast(t('toast_add_error', locale), 'error'); return; }
        const json = await res.json() as { item: Item };

        if (itemPhotoFile) {
          setPhotoUploading(true);
          await uploadPhoto(json.item.id, itemPhotoFile);
          setPhotoUploading(false);
        }

        // Reload from API to get correct sorted position
        setWishlists((prev) => prev.map((wl) => wl.id === currentWl!.id ? { ...wl, itemCount: wl.itemCount + 1 } : wl));
        await loadItems(currentWl!.id);
        pushToast(t('item_added', locale), 'success');
      }
      blurActiveField();
      setShowItemForm(false);
      resetItemForm();
    } finally {
      setLoading(false);
      setPhotoUploading(false);
    }
  };

  const handleDeleteItem = async (item: Item) => {
    setLoading(true);
    try {
      const res = await tgFetch(`/tg/items/${item.id}`, { method: 'DELETE' });
      if (!res.ok) { pushToast(t('toast_delete_error', locale), 'error'); return; }

      // Determine origin: drafts vs regular wishlist, then update the right state.
      // Use draftsItems membership (not fromDrafts flag) — flag is already cleared
      // by the time confirm is tapped.
      const isDraftsItem = draftsItems.some((d) => d.id === item.id);
      if (isDraftsItem) {
        const remaining = draftsItems.filter((d) => d.id !== item.id);
        setDraftsItems(remaining);
        setDraftsCount(remaining.length);
        // Last draft deleted → go home; otherwise drafts screen is already showing
        if (remaining.length === 0) setScreen('my-wishlists');
      } else if (currentWl) {
        setItems((prev) => prev.filter((i) => i.id !== item.id));
        setWishlists((prev) =>
          prev.map((wl) =>
            wl.id === currentWl.id ? { ...wl, itemCount: Math.max(0, wl.itemCount - 1) } : wl,
          ),
        );
      }

      pushToast(t('delete_deleted', locale), 'success');
    } finally {
      setLoading(false);
    }
  };

  // --- Archive actions
  const loadArchive = async () => {
    if (!currentWl) return;
    setLoading(true);
    try {
      const res = await tgFetch(`/tg/wishlists/${currentWl.id}/archive`);
      if (!res.ok) { pushToast(t('toast_archive_error', locale), 'error'); return; }
      const json = await res.json() as { items: Item[] };
      setArchiveItems(json.items);
      setArchiveMode('wishlist');
      setScreen('archive');
    } finally {
      setLoading(false);
    }
  };

  // Global archive: all archived items across all wishlists (opened from profile)
  const loadGlobalArchive = async () => {
    setLoading(true);
    try {
      const res = await tgFetch('/tg/archive');
      if (!res.ok) { pushToast(t('toast_archive_error', locale), 'error'); return; }
      const json = await res.json() as { items: GlobalArchiveItem[] };
      setGlobalArchiveItems(json.items);
      setArchiveMode('global');
      setScreen('archive');
    } finally {
      setLoading(false);
    }
  };

  const handleCompleteItem = async (item: Item) => {
    if (!currentWl) return;
    setLoading(true);
    try {
      const res = await tgFetch(`/tg/items/${item.id}/complete`, { method: 'POST' });
      if (!res.ok) { pushToast(t('toast_error_generic', locale), 'error'); return; }
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setWishlists((prev) => prev.map((wl) => wl.id === currentWl.id ? { ...wl, itemCount: Math.max(0, wl.itemCount - 1) } : wl));
      pushToast(t('archive_received_toast', locale), 'success');
      try { tgRef.current?.WebApp?.HapticFeedback?.notificationOccurred('success'); } catch { /* ok */ }
    } finally {
      setLoading(false);
    }
  };

  const handleRestoreItem = async (item: Item | GlobalArchiveItem) => {
    setLoading(true);
    try {
      const res = await tgFetch(`/tg/items/${item.id}/restore`, { method: 'POST' });
      if (!res.ok) { pushToast(t('toast_restore_error', locale), 'error'); return; }
      const json = await res.json() as { item: Item; wishlistId: string; wishlistTitle: string };

      if (archiveMode === 'global') {
        setGlobalArchiveItems((prev) => prev.filter((i) => i.id !== item.id));
      } else {
        setArchiveItems((prev) => prev.filter((i) => i.id !== item.id));
        // In wishlist mode, add back to current wishlist's items list
        if (currentWl && json.wishlistId === currentWl.id) {
          setItems((prev) => [...prev, json.item]);
        }
      }

      // Update correct wishlist item count regardless of mode
      if (json.wishlistId) {
        setWishlists((prev) => prev.map((wl) =>
          wl.id === json.wishlistId ? { ...wl, itemCount: wl.itemCount + 1 } : wl,
        ));
      }

      // Keep profile stats counter in sync
      setProfileStats((prev) => prev ? { ...prev, archived: Math.max(0, prev.archived - 1) } : prev);

      pushToast(t('archive_restored', locale), 'success');
    } finally {
      setLoading(false);
    }
  };

  const handleBulkRestore = useCallback(async () => {
    if (archiveSelected.length === 0) return;
    setArchiveBulkLoading(true);
    try {
      const res = await tgFetch('/tg/items/bulk-restore', {
        method: 'POST',
        body: JSON.stringify({ itemIds: archiveSelected }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        pushToast(body.error || t('toast_error_generic', locale), 'error');
        return;
      }
      const data = await res.json() as { ok: boolean; restored: string[]; failed: Array<{ itemId: string; reason: string }> };
      const restoredCount = data.restored.length;
      const failedArchived = data.failed.filter((f) => f.reason === 'wishlist_archived').length;
      const total = archiveSelected.length;

      // Remove restored items from the display list
      const restoredSet = new Set(data.restored);
      if (archiveMode === 'global') {
        setGlobalArchiveItems((prev) => prev.filter((i) => !restoredSet.has(i.id)));
      } else {
        setArchiveItems((prev) => prev.filter((i) => !restoredSet.has(i.id)));
      }
      // Update profile stats
      setProfileStats((prev) => prev ? { ...prev, archived: Math.max(0, prev.archived - restoredCount) } : prev);

      setArchiveSelectMode(false);
      setArchiveSelected([]);

      if (restoredCount === total) {
        pushToast(t('archive_bulk_restored', locale, { n: restoredCount }), 'success');
      } else if (restoredCount > 0) {
        pushToast(t('archive_bulk_restored_partial', locale, { restored: restoredCount, total, failed: failedArchived }), 'success');
      } else {
        pushToast(t('toast_error_generic', locale), 'error');
      }
    } catch {
      pushToast(t('toast_error_generic', locale), 'error');
    } finally {
      setArchiveBulkLoading(false);
    }
  }, [archiveSelected, tgFetch, pushToast, locale, archiveMode]);

  const handleBulkHardDelete = useCallback(async () => {
    if (archiveSelected.length === 0) return;
    setArchiveBulkLoading(true);
    try {
      const res = await tgFetch('/tg/items/bulk-hard-delete', {
        method: 'POST',
        body: JSON.stringify({ itemIds: archiveSelected }),
      });
      if (!res.ok) {
        pushToast(t('toast_error_generic', locale), 'error');
        return;
      }
      const data = await res.json() as { deleted: number };
      const deletedSet = new Set(archiveSelected);
      if (archiveMode === 'global') {
        setGlobalArchiveItems((prev) => prev.filter((i) => !deletedSet.has(i.id)));
      } else {
        setArchiveItems((prev) => prev.filter((i) => !deletedSet.has(i.id)));
      }
      setProfileStats((prev) => prev ? { ...prev, archived: Math.max(0, prev.archived - data.deleted) } : prev);
      setShowArchiveBulkDeleteConfirm(false);
      setArchiveSelectMode(false);
      setArchiveSelected([]);
      pushToast(t('archive_bulk_deleted', locale, { n: data.deleted }), 'success');
    } catch {
      pushToast(t('toast_error_generic', locale), 'error');
    } finally {
      setArchiveBulkLoading(false);
    }
  }, [archiveSelected, tgFetch, pushToast, locale, archiveMode]);

  const handlePurgeArchive = useCallback(async () => {
    setArchiveBulkLoading(true);
    try {
      const res = await tgFetch('/tg/archive/purge', { method: 'POST' });
      if (!res.ok) {
        pushToast(t('toast_error_generic', locale), 'error');
        return;
      }
      const data = await res.json() as { deleted: number };
      setGlobalArchiveItems([]);
      setArchiveItems([]);
      setProfileStats((prev) => prev ? { ...prev, archived: 0 } : prev);
      setShowArchivePurgeConfirm(false);
      setArchivePurgeStep(1);
      setArchiveSelectMode(false);
      setArchiveSelected([]);
      pushToast(t('archive_purged', locale, { n: data.deleted }), 'success');
    } catch {
      pushToast(t('toast_error_generic', locale), 'error');
    } finally {
      setArchiveBulkLoading(false);
    }
  }, [tgFetch, pushToast, locale]);

  const handleArchiveWishlist = async () => {
    if (!currentWl) return;
    setArchivingWl(true);
    try {
      const res = await tgFetch(`/tg/wishlists/${currentWl.id}/archive`, { method: 'POST' });
      if (!res.ok) { pushToast(t('toast_error_generic', locale), 'error'); return; }
      setWishlists((prev) => prev.filter((wl) => wl.id !== currentWl.id));
      setShowArchiveWlConfirm(false);
      setShowWlManage(false);
      setScreen('my-wishlists');
      pushToast(t('wl_archived_toast', locale), 'success');
      try { tgRef.current?.WebApp?.HapticFeedback?.notificationOccurred('success'); } catch { /* ok */ }
    } finally {
      setArchivingWl(false);
    }
  };

  // --- Delete wishlist handlers ─────────────────────────────────────────────

  /** Entry point: called from manage menu. Routes to reserved-warning or step-1. */
  const startDeleteWishlist = () => {
    setShowWlManage(false);
    if ((currentWl?.reservedCount ?? 0) > 0) {
      setShowDeleteWlReserved(true);
    } else {
      setShowDeleteWl1(true);
    }
  };

  /** Final hard delete — called after all confirmations (or after transfer) */
  const handleDeleteWishlist = async () => {
    if (!currentWl || deletingWl) return;
    setDeletingWl(true);
    try {
      const res = await tgFetch(`/tg/wishlists/${currentWl.id}`, { method: 'DELETE' });
      if (!res.ok) { pushToast(t('toast_error_generic', locale), 'error'); return; }
      setWishlists((prev) => prev.filter((wl) => wl.id !== currentWl.id));
      setShowDeleteWl2(false);
      setShowDeleteWl1(false);
      setShowDeleteWlReserved(false);
      setCurrentWl(null);
      setScreen('my-wishlists');
      pushToast(t('wl_deleted_toast', locale), 'success');
      // Update profile stats
      setProfileStats((prev) => prev ? { ...prev, wishlists: Math.max(0, prev.wishlists - 1) } : prev);
    } finally {
      setDeletingWl(false);
    }
  };

  /** Transfer all reserved items from currentWl to transferTargetId, then delete. */
  const handleTransferAndDelete = async () => {
    if (!currentWl || !transferTargetId || transferingItems) return;
    setTransferingItems(true);
    try {
      const res = await tgFetch(`/tg/wishlists/${currentWl.id}/transfer-items`, {
        method: 'POST',
        body: JSON.stringify({ targetWishlistId: transferTargetId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string; available?: number };
        if (err.error === 'insufficient_capacity') {
          pushToast(t('wl_transfer_no_space', locale, { count: err.available ?? 0 }), 'error');
        } else {
          pushToast(t('wl_transfer_error', locale), 'error');
        }
        return;
      }
      const json = await res.json() as { transferred: number };
      // Update target wishlist item count in state
      setWishlists((prev) => prev.map((wl) =>
        wl.id === transferTargetId
          ? { ...wl, itemCount: wl.itemCount + json.transferred, reservedCount: wl.reservedCount + json.transferred }
          : wl,
      ));
      setShowTransferPicker(false);
      // Now hard-delete the source wishlist
      await handleDeleteWishlist();
      pushToast(t('wl_transfer_done_toast', locale), 'success');
    } finally {
      setTransferingItems(false);
    }
  };

  // --- Privacy settings handler ────────────────────────────────────────────

  const handleSaveWlPrivacy = async (
    visibility: WishlistVisibility,
    allowSubscriptions: AllowSubscriptions,
    commentPolicy: CommentPolicy,
  ) => {
    if (!currentWl || privacySaving) return;
    setPrivacySaving(true);
    try {
      const res = await tgFetch(`/tg/wishlists/${currentWl.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          visibility: visibility.toUpperCase(),
          allowSubscriptions: allowSubscriptions.toUpperCase(),
          commentPolicy: commentPolicy.toUpperCase(),
        }),
      });
      if (res.status === 403) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        if (err.error === 'pro_required') { pushToast(t('settings_pro_required', locale), 'error'); return; }
        pushToast(t('toast_error_generic', locale), 'error');
        return;
      }
      if (!res.ok) { pushToast(t('toast_save_error', locale), 'error'); return; }
      const json = await res.json() as { wishlist: { visibility: WishlistVisibility; allowSubscriptions: AllowSubscriptions; commentPolicy: CommentPolicy } };
      setCurrentWl((prev) => prev ? {
        ...prev,
        visibility: json.wishlist.visibility,
        allowSubscriptions: json.wishlist.allowSubscriptions,
        commentPolicy: json.wishlist.commentPolicy,
      } : prev);
      setWishlists((prev) => prev.map((wl) => wl.id === currentWl.id ? {
        ...wl,
        visibility: json.wishlist.visibility,
        allowSubscriptions: json.wishlist.allowSubscriptions,
        commentPolicy: json.wishlist.commentPolicy,
      } : wl));
      setShowWlPrivacy(false);
      pushToast(t('wl_privacy_saved', locale), 'success');
    } finally {
      setPrivacySaving(false);
    }
  };

  // --- Guest actions
  const handleReserve = async () => {
    if (!reservingItem || !guestName.trim()) return;
    setLoading(true);
    try {
      const res = await tgFetch(`/tg/items/${reservingItem.id}/reserve`, {
        method: 'POST',
        body: JSON.stringify({ displayName: guestName.trim() }),
      });
      if (res.status === 409) { pushToast(t('toast_already_reserved', locale), 'error'); return; }
      if (res.status === 402) { pushToast(t('toast_max_participants', locale), 'error'); return; }
      if (!res.ok) { pushToast(t('error_generic', locale), 'error'); return; }
      const updatedItem = { ...reservingItem, status: 'reserved' as const, reservedByDisplayName: guestName.trim(), reservedByActorHash: myActorHashRef.current };
      setGuestItems((prev) => prev.map((i) => i.id === reservingItem.id ? updatedItem : i));
      if (viewingItem && viewingItem.id === reservingItem.id) setViewingItem(updatedItem);
      setReservationsCount((prev) => prev + 1);
      setProfileStats((prev) => prev ? { ...prev, reservedByMe: prev.reservedByMe + 1 } : prev);
      pushToast(t('reserve_success', locale), 'success');
      setReservingItem(null);
      setGuestName('');
    } finally {
      setLoading(false);
    }
  };

  const handleUnreserve = async (item: GuestItem) => {
    setLoading(true);
    try {
      const res = await tgFetch(`/tg/items/${item.id}/unreserve`, { method: 'POST', body: '{}' });
      if (!res.ok) { pushToast(t('toast_error_generic', locale), 'error'); return; }
      const updatedItem = { ...item, status: 'available' as const, reservedByDisplayName: null, reservedByActorHash: null };
      setGuestItems((prev) => prev.map((i) => i.id === item.id ? updatedItem : i));
      if (viewingItem && viewingItem.id === item.id) setViewingItem(updatedItem);
      // Also remove from reservations list if present
      setReservations((prev) => prev.filter((r) => r.id !== item.id));
      setReservationsCount((prev) => Math.max(0, prev - 1));
      setProfileStats((prev) => prev ? { ...prev, reservedByMe: Math.max(0, prev.reservedByMe - 1) } : prev);
      pushToast(t('unreserve_success', locale), 'success');
    } finally {
      setLoading(false);
    }
  };

  const handleUnreserveFromReservations = async (item: ReservationItem) => {
    setLoading(true);
    try {
      const res = await tgFetch(`/tg/items/${item.id}/unreserve`, { method: 'POST', body: '{}' });
      if (!res.ok) { pushToast(t('toast_error_generic', locale), 'error'); return; }
      setReservations((prev) => prev.filter((r) => r.id !== item.id));
      setReservationsCount((prev) => Math.max(0, prev - 1));
      setProfileStats((prev) => prev ? { ...prev, reservedByMe: Math.max(0, prev.reservedByMe - 1) } : prev);
      pushToast(t('unreserve_success', locale), 'success');
    } finally {
      setLoading(false);
    }
  };

  const handleUnreserveSantaItem = async (item: SantaReservationItem, onSuccess?: () => void) => {
    setLoading(true);
    try {
      const res = await tgFetch(`/tg/santa/campaigns/${item.campaignId}/inbound/reserve/${item.id}`, { method: 'DELETE' });
      if (!res.ok) { pushToast(t('toast_error_generic', locale), 'error'); return; }
      setSantaReservationItems((prev) => prev.filter((r) => r.id !== item.id));
      setReservationsCount((prev) => Math.max(0, prev - 1));
      setProfileStats((prev) => prev ? { ...prev, reservedByMe: Math.max(0, prev.reservedByMe - 1) } : prev);
      pushToast(t('unreserve_success', locale), 'success');
      onSuccess?.();
    } finally {
      setLoading(false);
    }
  };

  const handleSantaReceiverReserve = useCallback(async (itemId: string) => {
    const campId = currentSantaCampaign?.campaign.id;
    if (!campId) return;
    setSantaWishlistReservingId(itemId);
    try {
      const r = await tgFetch(`/tg/santa/campaigns/${campId}/inbound/reserve`, {
        method: 'POST', body: JSON.stringify({ itemId }),
      });
      if (r.ok) {
        const data = await r.json() as { myReservations: { id: string; title: string }[] };
        setSantaReceiverWishlist(prev => prev ? {
          ...prev,
          myReservations: data.myReservations,
          items: prev.items.map(it => ({ ...it, reservedByMe: data.myReservations.some(rv => rv.id === it.id) })),
        } : prev);
        setCurrentSantaCampaign(prev => prev?.myAssignment ? {
          ...prev,
          myAssignment: { ...prev.myAssignment, reservedItems: data.myReservations,
            giftStatus: data.myReservations.length > 0 ? 'SELECTED_FROM_WISHLIST' : prev.myAssignment.giftStatus },
        } : prev);
        setViewingItem(prev => prev?.id === itemId
          ? { ...prev, status: 'reserved', reservedByActorHash: myActorHashRef.current } as GuestItem
          : prev);
      } else { pushToast(t('toast_error_generic', locale), 'error'); }
    } catch { pushToast(t('toast_error_generic', locale), 'error'); }
    finally { setSantaWishlistReservingId(null); }
  }, [tgFetch, currentSantaCampaign, locale]);

  const handleSantaReceiverUnreserve = useCallback(async (itemId: string) => {
    const campId = currentSantaCampaign?.campaign.id;
    if (!campId) return;
    setSantaWishlistReservingId(itemId);
    try {
      const r = await tgFetch(`/tg/santa/campaigns/${campId}/inbound/reserve/${itemId}`, { method: 'DELETE' });
      if (r.ok) {
        const data = await r.json() as { myReservations: { id: string; title: string }[] };
        setSantaReceiverWishlist(prev => prev ? {
          ...prev,
          myReservations: data.myReservations,
          items: prev.items.map(it => ({ ...it, reservedByMe: data.myReservations.some(rv => rv.id === it.id) })),
        } : prev);
        setCurrentSantaCampaign(prev => prev?.myAssignment ? {
          ...prev,
          myAssignment: { ...prev.myAssignment, reservedItems: data.myReservations,
            giftStatus: data.myReservations.length === 0 ? 'PENDING' : prev.myAssignment.giftStatus },
        } : prev);
        setViewingItem(prev => prev?.id === itemId
          ? { ...prev, status: 'available', reservedByActorHash: null } as GuestItem
          : prev);
      } else { pushToast(t('toast_error_generic', locale), 'error'); }
    } catch { pushToast(t('toast_error_generic', locale), 'error'); }
    finally { setSantaWishlistReservingId(null); }
  }, [tgFetch, currentSantaCampaign, locale]);

  const openSantaCampaignFromDetail = useCallback(async (ctx: NonNullable<typeof santaDetailContext>) => {
    setSantaDetailContext(null);
    setViewingItem(null);
    setFromReservations(false);
    if (ctx.source === 'receiver-wishlist' && currentSantaCampaign?.campaign.id === ctx.campaignId) {
      setScreen('santa-campaign');
      return;
    }
    setLoading(true);
    try {
      const r = await tgFetch(`/tg/santa/campaigns/${ctx.campaignId}`);
      if (r.ok) { setCurrentSantaCampaign(await r.json() as SantaCampaignDetail); setScreen('santa-campaign'); }
      else pushToast(t('toast_error_generic', locale), 'error');
    } catch { pushToast(t('toast_error_generic', locale), 'error'); }
    finally { setLoading(false); }
  }, [tgFetch, currentSantaCampaign, locale]);

  const fmtDeadline = (d: string | null) => {
    if (!d) return null;
    return new Date(d).toLocaleDateString(locale === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'long' });
  };

  // ─────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────

  const totalItems = wishlists.reduce((n, wl) => n + wl.itemCount, 0);

  return (
    <div ref={scrollContainerRef} style={{
      position: 'fixed', inset: 0, overflowY: 'auto', overflowX: 'hidden',
      background: C.bg, fontFamily: font, color: C.text,
      // Prevent scroll-chaining into Telegram WebView: when this container
      // reaches its top/bottom edge the gesture must NOT propagate upward to
      // the native dismiss-swipe handler.  CSS alone covers modern WKWebView;
      // the JS touchmove guard below covers older / stricter configurations.
      overscrollBehaviorY: 'contain',
      // Retain native-speed momentum scrolling on iOS (still respected in
      // WKWebView even though the property is deprecated in stock Safari).
      WebkitOverflowScrolling: 'touch',
      // Hint to the compositor: only vertical panning is expected here, so it
      // should not speculatively start a horizontal/dismiss gesture.
      touchAction: 'pan-y',
    }}>
      <style>{`
        @keyframes fadeIn { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }
        @keyframes slideUp { from { opacity:0; transform:translateY(100%) } to { opacity:1; transform:translateY(0) } }
        @keyframes toastIn { from { opacity:0; transform:translateY(20px) scale(0.95) } to { opacity:1; transform:translateY(0) scale(1) } }
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.5 } }
        * { box-sizing:border-box; -webkit-tap-highlight-color:transparent }
        input, textarea, select { -webkit-appearance:none }
        /* Prevent the Telegram WebView from swallowing scroll gestures when the
           mini-app's scroll container is at a boundary.  Redundant with the JS
           touchmove guard below, but belt-and-suspenders: CSS fires before any
           JS and is cheaper.  "none" here applies to html/body — the scroll
           container itself gets "contain" via inline style above. */
        html, body { overscroll-behavior: none; }
        /* ── Seasonal snowflake animation ─────────────────────────────────────
           Only transform + opacity → compositor-thread only, no layout/paint. */
        @keyframes snowfall {
          0%   { transform: translateY(-10px) rotate(0deg);   opacity: 0;   }
          12%  { opacity: 1; }
          88%  { opacity: 1; }
          100% { transform: translateY(80px)  rotate(200deg); opacity: 0;   }
        }
        @media (prefers-reduced-motion: reduce) {
          .snowflake { animation: none !important; opacity: 0 !important; }
        }
      `}</style>

      {/* ── LOADING ── */}
      {screen === 'loading' && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 40 }}>🎁</div>
          <div style={{ color: C.textMuted, fontSize: 15 }}>{t('loading', locale)}</div>
        </div>
      )}

      {/* ── ERROR ── */}
      {screen === 'error' && (() => {
        const isTgRequired = errorMsg === t('error_open_in_telegram', locale);
        const tgDeepLink = buildTgDeepLink(urlStartParamRef.current || undefined);
        return (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: 16, padding: 24 }}>
            <div style={{ fontSize: 48 }}>{isTgRequired ? '✈️' : '😕'}</div>
            <div style={{ fontSize: 18, fontWeight: 700, textAlign: 'center', color: C.text }}>
              {isTgRequired ? t('error_open_in_telegram', locale) : t('error_loading', locale)}
            </div>
            <div style={{ fontSize: 15, color: C.textSec, textAlign: 'center', lineHeight: 1.5 }}>
              {isTgRequired
                ? t('error_telegram_only', locale)
                : (errorMsg || t('error_unknown', locale))}
            </div>
            {isTgRequired && tgDeepLink ? (
              <a href={tgDeepLink} style={{ textDecoration: 'none' }}>
                <button style={{ ...btnPrimary, marginTop: 8, width: 220 }}>
                  {t('error_open_in_telegram_btn', locale)}
                </button>
              </a>
            ) : (
              <button
                style={{ ...btnPrimary, marginTop: 8, width: 200 }}
                onClick={() => window.location.reload()}
              >
                {t('retry', locale)}
              </button>
            )}
          </div>
        );
      })()}

      {/* ── MAINTENANCE ── */}
      {screen === 'maintenance' && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: 16, padding: 24 }}>
          <div style={{ fontSize: 48 }}>🔧</div>
          <div style={{ fontSize: 18, fontWeight: 700, textAlign: 'center', color: C.text }}>
            {t('maintenance_title', locale)}
          </div>
          <div style={{ fontSize: 15, color: C.textSec, textAlign: 'center', lineHeight: 1.5 }}>
            {t('maintenance_body', locale)}
          </div>
          <button
            style={{ ...btnPrimary, marginTop: 8, width: 200 }}
            onClick={() => { setScreen('loading'); window.location.reload(); }}
          >
            {t('maintenance_retry', locale)}
          </button>
        </div>
      )}

      {/* ══════════════════════════════════════════════
          OWNER — MY WISHLISTS
          ══════════════════════════════════════════════ */}
      {screen === 'my-wishlists' && (
        <div
          style={{ padding: '16px 20px 120px' }}
          onTouchStart={(e) => {
            if (reorderMode || itemReorderMode) return;
            const target = e.target as HTMLElement;
            if (target.closest('button, a, input, textarea')) return;
            const t = e.touches[0];
            if (t) { homeSwipeStartX.current = t.clientX; homeSwipeStartY.current = t.clientY; }
          }}
          onTouchEnd={(e) => {
            if (homeSwipeStartX.current === null) return;
            if (reorderMode || itemReorderMode) { homeSwipeStartX.current = null; return; }
            const t = e.changedTouches[0];
            if (!t) { homeSwipeStartX.current = null; return; }
            const dx = t.clientX - homeSwipeStartX.current;
            const dy = t.clientY - (homeSwipeStartY.current ?? t.clientY);
            homeSwipeStartX.current = null; homeSwipeStartY.current = null;
            if (Math.abs(dx) < 60) return;
            if (Math.abs(dx) < Math.abs(dy) * 1.5) return;
            const tabs: HomeTab[] = ['wishlists', 'wishes', 'reservations'];
            const idx = tabs.indexOf(homeTab);
            if (dx < 0 && idx < tabs.length - 1) {
              const next = tabs[idx + 1]!;
              setHomeTab(next);
              if (next === 'wishes') void loadAllItems();
              else if (next === 'reservations' && reservations.length === 0 && santaReservationItems.length === 0) void loadReservations();
            } else if (dx > 0 && idx > 0) {
              setHomeTab(tabs[idx - 1]!);
            }
          }}
        >
          {/* ── Seasonal snowflakes — header area only, purely decorative ── */}
          <div style={{ position: 'relative' }}>
            {santaSeason?.inSeason && <SnowflakeOverlay height={72} />}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20, position: 'relative', zIndex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {/* Avatar → Profile; hat prop adds the seasonal SVG overlay */}
              <button
                onClick={() => { loadProfile(); setScreen('profile'); }}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', flexShrink: 0 }}
                aria-label={t('profile_title', locale)}
              >
                <UserAvatar
                  avatarUrl={profileData?.avatarUrl}
                  name={resolveOwnerName(profileData, tgUser)}
                  size={36}
                  accent={C.accent}
                  hat={santaSeason?.inSeason ?? false}
                />
              </button>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <h1 style={{ fontSize: 24, fontWeight: 800, fontFamily: font, color: C.text, margin: 0 }}>WishBoard</h1>
                  {planInfo.code === 'PRO' && (
                    <span style={{
                      fontSize: 10, fontWeight: 800, letterSpacing: 0.6, padding: '3px 8px',
                      borderRadius: 6,
                      background: `linear-gradient(135deg, ${C.accent}20, ${C.accent}12)`,
                      border: `1px solid ${C.accent}30`,
                      color: C.accent,
                    }}>PRO</span>
                  )}
                </div>
                <p style={{ fontSize: 13, color: C.textMuted, margin: '4px 0 0' }}>
                  {tgUser ? t('greeting', locale, { name: tgUser.first_name }) : t('my_wishlists', locale)}
                </p>
              </div>
            </div>
            <button
              onClick={() => { setSettingsOriginScreen(screen); loadSettings(); setScreen('settings'); }}
              style={{
                background: 'none', border: 'none', padding: 8, cursor: 'pointer',
                fontSize: 20, color: C.textMuted, lineHeight: 1,
              }}
              aria-label={t('settings_title', locale)}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>
          </div>
          </div>{/* end seasonal wrapper */}

          {/* ─── Primary home nav: Вишлисты | Желания | Мои брони ─── */}
          {(() => {
            const homeTabs = [
              { tab: 'wishlists' as HomeTab, count: wishlists.length, label: t('home_tab_wishlists', locale) },
              { tab: 'wishes' as HomeTab, count: totalItems, label: t('home_tab_wishes', locale) },
              { tab: 'reservations' as HomeTab, count: reservationsCount, label: t('home_tab_bookings', locale) },
            ];
            const activeIdx = homeTabs.findIndex(s => s.tab === homeTab);
            return (
              <div style={{ position: 'relative', display: 'flex', marginBottom: 20, borderBottom: `1px solid ${C.border}` }}>
                {homeTabs.map((seg) => {
                  const isActive = homeTab === seg.tab;
                  return (
                    <button
                      key={seg.tab}
                      onClick={() => {
                        setHomeTab(seg.tab);
                        if (seg.tab === 'wishes') void loadAllItems();
                        else if (seg.tab === 'reservations' && reservations.length === 0 && santaReservationItems.length === 0) void loadReservations();
                      }}
                      style={{
                        flex: 1, background: 'none', border: 'none', cursor: 'pointer',
                        padding: '10px 4px 14px', fontFamily: font,
                        WebkitTapHighlightColor: 'transparent',
                        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                      }}
                    >
                      <span style={{
                        fontSize: 22, fontWeight: 800, lineHeight: 1, fontFamily: font,
                        color: isActive ? C.accent : C.text,
                        transition: 'color 0.18s',
                      }}>{seg.count}</span>
                      <span style={{
                        fontSize: 11,
                        fontWeight: isActive ? 700 : 500,
                        color: isActive ? C.text : C.textMuted,
                        transition: 'color 0.18s',
                      }}>{seg.label}</span>
                    </button>
                  );
                })}
                {/* Animated underline */}
                <div style={{
                  position: 'absolute', bottom: 0, height: 2, borderRadius: 1,
                  width: 'calc(100% / 3)',
                  left: `calc(100% / 3 * ${activeIdx < 0 ? 0 : activeIdx})`,
                  background: C.accent,
                  transition: 'left 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
                }} />
              </div>
            );
          })()}

          {/* Mine/Subscribed sub-selector — only in Wishlists tab */}
          {homeTab === 'wishlists' && (
            <div style={{ display: 'flex', gap: 4, marginBottom: 16, background: C.surface, borderRadius: 12, padding: 4 }}>
              {(['mine', 'subscribed'] as const).map((tab) => {
                const isActive = myWishlistsTab === tab;
                const totalUnread = subscriptions.reduce((s, sub) => s + sub.unreadCount, 0);
                return (
                  <button
                    key={tab}
                    onClick={() => {
                      setMyWishlistsTab(tab);
                      if (tab === 'subscribed') void loadSubscriptions();
                    }}
                    style={{
                      flex: 1, padding: '8px 4px', borderRadius: 8, border: 'none', cursor: 'pointer',
                      fontFamily: font, fontSize: 14, fontWeight: 600, transition: 'all 0.2s',
                      background: isActive ? C.accent : 'transparent',
                      color: isActive ? '#fff' : C.textSec,
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    }}
                  >
                    {tab === 'mine' ? t('sub_tab_my', locale) : t('sub_tab_subscribed', locale)}
                    {tab === 'subscribed' && totalUnread > 0 && (
                      <span style={{
                        minWidth: 18, height: 18, borderRadius: 9, padding: '0 5px',
                        background: isActive ? 'rgba(255,255,255,0.3)' : C.orange,
                        color: '#fff', fontSize: 10, fontWeight: 700,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}>{totalUnread}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {/* Subscribed wishlists */}
          {homeTab === 'wishlists' && myWishlistsTab === 'subscribed' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {subscriptionsLoading && (
                <div style={{ textAlign: 'center', padding: '32px 0', color: C.textMuted, fontSize: 14 }}>{t('loading', locale)}</div>
              )}
              {!subscriptionsLoading && subscriptions.length === 0 && (
                <div style={{ textAlign: 'center', padding: '48px 24px' }}>
                  <div style={{ fontSize: 48, marginBottom: 16 }}>👥</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t('sub_empty_title', locale)}</div>
                  <div style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.5 }}>{t('sub_empty_hint', locale)}</div>
                </div>
              )}
              {subscriptions.map((sub, i) => (
                <div
                  key={sub.id}
                  onClick={async () => {
                    if (sub.unreadCount > 0) {
                      void tgFetch(`/tg/me/subscriptions/${sub.id}/read`, { method: 'POST' });
                      setSubscriptions((prev) => prev.map((s) => s.id === sub.id ? { ...s, unreadCount: 0, unreadEntityIds: [] } : s));
                    }
                    setGuestUnreadEntityIds(sub.unreadEntityIds);
                    setGuestSubId(sub.id);
                    setIsSubscribed(true);
                    setSubscriberCount(0);
                    setScreen('loading');
                    try {
                      await loadGuestWishlist(sub.wishlist.slug);
                      setScreen('guest-view');
                    } catch {
                      setScreen('my-wishlists');
                    }
                  }}
                  style={{
                    background: C.card, borderRadius: 16, padding: 18, cursor: 'pointer',
                    border: sub.unreadCount > 0 ? `1px solid ${C.orange}40` : `1px solid ${C.border}`,
                    animation: `fadeIn 0.3s ease ${i * 0.08}s both`,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                        <div style={{ fontSize: 16, fontWeight: 700, fontFamily: font, color: C.text }}>{sub.wishlist.title}</div>
                        {sub.unreadCount > 0 && (
                          <span style={{
                            minWidth: 18, height: 18, borderRadius: 9, padding: '0 5px',
                            background: C.orange, color: '#fff', fontSize: 10, fontWeight: 700,
                            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
                          }}>{sub.unreadCount}</span>
                        )}
                      </div>
                      <div style={{ fontSize: 12, color: C.textMuted, display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
                        <UserAvatar avatarUrl={sub.wishlist.ownerAvatarUrl} name={sub.wishlist.ownerName} size={16} accent={C.accent} />
                        <span>{sub.wishlist.ownerName} · {sub.wishlist.itemCount} {t('stats_wishes', locale)}{sub.wishlist.deadline ? ` · 📅 ${fmtDeadline(sub.wishlist.deadline)}` : ''}</span>
                      </div>
                    </div>
                    <span style={{ fontSize: 20, color: C.textMuted }}>›</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ── WISHLISTS TAB — mine subtab ─────────────────────────── */}
          {homeTab === 'wishlists' && myWishlistsTab === 'mine' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {draftsCount > 0 && (
              <div onClick={() => { void loadDrafts(); setScreen('drafts'); }} style={{
                background: `linear-gradient(135deg, ${C.orange}20, ${C.orange}08)`,
                borderRadius: 16, padding: '16px 20px', cursor: 'pointer',
                border: `1px solid ${C.orange}25`,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                animation: 'fadeIn 0.3s ease',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 24 }}>📥</span>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, fontFamily: font, color: C.text }}>{t('drafts_title', locale)}</div>
                    <div style={{ fontSize: 12, color: C.textMuted }}>
                      {draftsCount} {pluralize(draftsCount, t('cards_one', locale), t('cards_few', locale), t('cards_many', locale), locale)}
                    </div>
                  </div>
                </div>
                <span style={{ fontSize: 20, color: C.orange }}>›</span>
              </div>
            )}

            {/* ── Santa Home Block ──────────────────────────────────────── */}
            {santaSeason?.inSeason && (
              <div
                onClick={async () => {
                  setSantaCampaignsLoading(true);
                  const res = await tgFetch('/tg/santa/campaigns');
                  if (res.ok) setSantaCampaigns(await res.json() as typeof santaCampaigns);
                  setSantaCampaignsLoading(false);
                  setScreen('santa-hub');
                }}
                style={{
                  background: `linear-gradient(135deg, rgba(124,106,255,0.15), rgba(124,106,255,0.05))`,
                  borderRadius: 16, padding: '16px 20px', cursor: 'pointer',
                  border: `1px solid ${C.accent}25`,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  animation: 'fadeIn 0.3s ease',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 24 }}>🎅</span>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, fontFamily: font, color: C.text }}>{t('santa_home_title', locale)}</div>
                    <div style={{ fontSize: 12, color: C.textMuted }}>{t('santa_home_subtitle', locale)}</div>
                  </div>
                </div>
                <span style={{ fontSize: 20, color: C.accent }}>›</span>
              </div>
            )}

            {/* ── Reorder trigger button (only in normal mode, 2+ wishlists) ── */}
            {!reorderMode && wishlists.length >= 2 && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: -4, marginTop: -4 }}>
                <button
                  onClick={enterReorderMode}
                  style={{
                    background: 'none', border: 'none', padding: '4px 0 4px 12px', cursor: 'pointer',
                    fontSize: 13, color: C.textMuted, display: 'flex', alignItems: 'center', gap: 4,
                    fontFamily: font,
                  }}
                >
                  <span>↕</span>
                  <span>{t('wl_reorder_start', locale)}</span>
                </button>
              </div>
            )}

            {/* ── Reorder mode ── */}
            {reorderMode && (
              <>
                <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                  <button
                    style={{ ...btnPrimary, flex: 1, opacity: reorderSaving ? 0.6 : 1 }}
                    onClick={() => void handleSaveReorder()}
                    disabled={reorderSaving}
                  >
                    {reorderSaving ? '…' : t('wl_reorder_save', locale)}
                  </button>
                  <button
                    style={{ ...btnGhost, flex: 1 }}
                    onClick={cancelReorderMode}
                  >
                    {t('wl_reorder_cancel', locale)}
                  </button>
                </div>
                {reorderList.map((wl, i) => (
                  <div
                    key={wl.id}
                    style={{
                      background: reorderDragIdx === i ? C.accent + '22' : C.card,
                      borderRadius: 16, padding: '14px 18px',
                      border: `1px solid ${reorderDragIdx === i ? C.accent : C.border}`,
                      display: 'flex', alignItems: 'center', gap: 12,
                      transition: 'background 0.15s, border-color 0.15s',
                      userSelect: 'none', touchAction: 'none',
                    }}
                  >
                    <div
                      onPointerDown={(e) => handleReorderPointerDown(e, i)}
                      onPointerMove={(e) => handleReorderPointerMove(e, i)}
                      onPointerUp={handleReorderPointerUp}
                      onPointerCancel={handleReorderPointerUp}
                      style={{
                        fontSize: 20, color: C.textMuted, cursor: 'grab', padding: '4px 8px 4px 0',
                        lineHeight: 1, flexShrink: 0, touchAction: 'none',
                      }}
                    >
                      ⠿
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, fontFamily: font, color: C.text }}>{wl.title}</div>
                      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                        {t('wishlist_count', locale, { count: wl.itemCount, reserved: wl.reservedCount })}
                      </div>
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* ── Normal mode ── */}
            {!reorderMode && wishlists.map((wl, i) => (
              <div key={wl.id} onClick={() => void openWishlist(wl)} style={{
                background: C.card, borderRadius: 16, padding: 18, cursor: 'pointer',
                border: `1px solid ${C.border}`, animation: `fadeIn 0.3s ease ${(i + 1) * 0.08}s both`,
                opacity: wl.readOnly ? 0.6 : 1,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <div style={{ fontSize: 16, fontWeight: 700, fontFamily: font, color: C.text }}>{wl.title}</div>
                      {wl.readOnly && (
                        <span style={{
                          fontSize: 10, fontWeight: 600, padding: '2px 6px',
                          borderRadius: 4, background: C.orangeSoft, color: C.orange,
                        }}>{t('view_only', locale)}</span>
                      )}
                    </div>
                    <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>
                      {t('wishlist_count', locale, { count: wl.itemCount, reserved: wl.reservedCount })}
                    </div>
                  </div>
                  <span style={{ fontSize: 20, color: C.textMuted }}>›</span>
                </div>
                {wl.itemCount > 0 && (
                  <div style={{ marginTop: 12, height: 4, borderRadius: 100, background: C.surface, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%',
                      width: `${(wl.reservedCount / wl.itemCount) * 100}%`,
                      background: `linear-gradient(90deg, ${C.accent}, ${C.green})`,
                      borderRadius: 100, transition: 'width 0.5s',
                    }} />
                  </div>
                )}
                {wl.deadline && (
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 8 }}>📅 {fmtDeadline(wl.deadline)}</div>
                )}
              </div>
            ))}

            {!reorderMode && wishlists.length === 0 && (
              <div style={{ textAlign: 'center', padding: '48px 24px' }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>🎁</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t('empty_state_title', locale)}</div>
                <div style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.5 }}>
                  {t('empty_state_subtitle', locale)}
                </div>
              </div>
            )}

            {!reorderMode && (
              <div style={{ textAlign: 'center', padding: '4px 0', fontSize: 12, color: C.textMuted }}>
                {t('plan_status', locale, { plan: planInfo.code === 'PRO' ? 'Pro' : 'Free', count: wishlists.length, max: planLimits.wishlists })}
              </div>
            )}
            {!reorderMode && planInfo.code === 'FREE' && (
              <button style={{ ...btnGhost, width: '100%', fontSize: 13, color: C.accent }} onClick={() => showUpsell('wishlist_limit')}>
                {t('connect_pro', locale)}
              </button>
            )}
            {!reorderMode && <button style={btnPrimary} onClick={() => setShowCreateWl(true)}>{t('create_wishlist_btn', locale)}</button>}
          </div>
          )}

          {/* ── WISHES TAB ──────────────────────────────────────────── */}
          {homeTab === 'wishes' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {/* Priority filter chips */}
              {!allItemsLoading && allItems.length > 0 && (
                <div style={{ display: 'flex', gap: 8, overflowX: 'auto', paddingBottom: 2, scrollbarWidth: 'none' }}>
                  {/* "All" chip */}
                  <button
                    onClick={() => setAllItemsPriorityFilter(null)}
                    style={{
                      flexShrink: 0,
                      padding: '6px 14px',
                      borderRadius: 20,
                      border: 'none',
                      fontSize: 13,
                      fontWeight: allItemsPriorityFilter === null ? 700 : 500,
                      cursor: 'pointer',
                      background: allItemsPriorityFilter === null ? C.accent : C.surface,
                      color: allItemsPriorityFilter === null ? '#fff' : C.text,
                      transition: 'all 0.15s ease',
                    }}
                  >
                    {t('filter_all', locale)}
                  </button>
                  {getPriorities(locale).slice().reverse().map((p) => {
                    const active = allItemsPriorityFilter === p.value;
                    return (
                      <button
                        key={p.value}
                        onClick={() => setAllItemsPriorityFilter(active ? null : p.value)}
                        style={{
                          flexShrink: 0,
                          display: 'flex',
                          alignItems: 'center',
                          gap: 5,
                          padding: '6px 14px',
                          borderRadius: 20,
                          border: 'none',
                          fontSize: 13,
                          fontWeight: active ? 700 : 500,
                          cursor: 'pointer',
                          background: active ? PRIO_BG[p.value] : C.surface,
                          color: active ? PRIO_COLOR[p.value] : C.text,
                          transition: 'all 0.15s ease',
                        }}
                      >
                        <span>{p.emoji}</span>
                        <span>{p.label}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {allItemsLoading && (
                <div style={{ textAlign: 'center', padding: '48px 24px' }}>
                  <div style={{ fontSize: 32, marginBottom: 12, animation: 'fadeIn 0.3s ease' }}>⏳</div>
                  <div style={{ fontSize: 14, color: C.textMuted }}>{t('loading', locale)}</div>
                </div>
              )}
              {!allItemsLoading && allItems.length === 0 && (
                <div style={{ textAlign: 'center', padding: '48px 24px' }}>
                  <div style={{ fontSize: 48, marginBottom: 16 }}>✨</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t('wishes_all_empty_title', locale)}</div>
                  <div style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.5 }}>{t('wishes_all_empty_hint', locale)}</div>
                </div>
              )}
              {!allItemsLoading && allItems.length > 0 && filteredAllItems.length === 0 && (
                <div style={{ textAlign: 'center', padding: '48px 24px' }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>🔍</div>
                  <div style={{ fontSize: 15, color: C.textMuted, marginBottom: 16 }}>{t('guest_filter_empty', locale)}</div>
                  <button
                    onClick={() => setAllItemsPriorityFilter(null)}
                    style={{ ...btnSecondary, padding: '10px 24px', fontSize: 14 }}
                  >
                    {t('filter_reset', locale)}
                  </button>
                </div>
              )}
              {filteredAllItems.map((item) => (
                <WishCardOwner
                  key={item.id}
                  item={item}
                  locale={locale}
                  sourceLabel={item.wishlistTitle}
                  onTap={(it) => {
                    const wl = wishlists.find(w => w.id === it.wishlistId) ?? null;
                    setCurrentWl(wl);
                    if (wl) void loadItems(wl.id);
                    setViewingItem(it);
                    setHomeReturnTab('wishes');
                    setScreen('item-detail');
                  }}
                  onDelete={() => {}}
                />
              ))}
            </div>
          )}

          {/* ── RESERVATIONS TAB ────────────────────────────────────── */}
          {homeTab === 'reservations' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {reservationsLoading && reservations.length === 0 && santaReservationItems.length === 0 && (
                <div style={{ textAlign: 'center', padding: '48px 24px' }}>
                  <div style={{ fontSize: 32, marginBottom: 12, animation: 'fadeIn 0.3s ease' }}>⏳</div>
                  <div style={{ fontSize: 14, color: C.textMuted }}>{t('reservations_loading', locale)}</div>
                </div>
              )}
              {!reservationsLoading && !santaReservationItemsLoading && reservations.length === 0 && santaReservationItems.length === 0 && (
                <div style={{ textAlign: 'center', padding: '48px 24px' }}>
                  <div style={{ fontSize: 48, marginBottom: 16 }}>🎁</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t('reservations_empty_title', locale)}</div>
                  <div style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.5 }}>{t('reservations_empty_hint', locale)}</div>
                </div>
              )}
              {/* Santa reservations sub-section */}
              {santaReservationItems.length > 0 && (() => {
                const campGroups: Record<string, { campaignTitle: string; campaignStatus: string; items: SantaReservationItem[] }> = {};
                for (const r of santaReservationItems) {
                  const g = campGroups[r.campaignId] ?? (campGroups[r.campaignId] = { campaignTitle: r.campaignTitle, campaignStatus: r.campaignStatus, items: [] });
                  g.items.push(r);
                }
                let si = 0;
                return (
                  <div style={{ marginBottom: 4 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 10 }}>
                      🎅 {t('santa_reservations_section_title', locale)}
                    </div>
                    {Object.entries(campGroups).map(([campaignId, group]) => (
                      <div key={campaignId} style={{ marginBottom: 14 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                          <div style={{ fontSize: 13, fontWeight: 700, color: C.text, fontFamily: font }}>{group.campaignTitle}</div>
                          {group.campaignStatus === 'COMPLETED' && (
                            <div style={{ fontSize: 10, fontWeight: 600, color: C.textMuted, background: C.surface, borderRadius: 5, padding: '2px 5px' }}>
                              {t('santa_reservations_completed', locale)}
                            </div>
                          )}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                          {group.items.map((item) => {
                            const delay = si * 0.06; si++;
                            return (
                              <ReservationCard
                                key={item.id}
                                item={item as unknown as ReservationItem}
                                animDelay={delay}
                                locale={locale}
                                onTap={async () => {
                                  setSantaReceiverWishlistLoading(true);
                                  try {
                                    const [detailRes, wlRes] = await Promise.all([
                                      tgFetch(`/tg/santa/campaigns/${campaignId}`),
                                      tgFetch(`/tg/santa/campaigns/${campaignId}/inbound/wishlist`),
                                    ]);
                                    if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                                    if (wlRes.ok) setSantaReceiverWishlist(await wlRes.json() as typeof santaReceiverWishlist);
                                    setScreen('santa-receiver-wishlist');
                                  } catch {
                                    pushToast(t('toast_error_generic', locale), 'error');
                                  } finally {
                                    setSantaReceiverWishlistLoading(false);
                                  }
                                }}
                                onUnreserve={() => setPendingUnreserveAction(() => () => handleUnreserveSantaItem(item))}
                              />
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              })()}
              {reservations.length > 0 && (() => {
                const groups: Record<string, { ownerName: string; ownerAvatarUrl: string | null; items: ReservationItem[] }> = {};
                for (const r of reservations) {
                  const g = groups[r.ownerId] ?? (groups[r.ownerId] = { ownerName: r.ownerName, ownerAvatarUrl: r.ownerAvatarUrl, items: [] });
                  g.items.push(r);
                }
                let globalIdx = 0;
                return Object.entries(groups).map(([ownerId, group]) => (
                  <div key={ownerId} style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                      <UserAvatar avatarUrl={group.ownerAvatarUrl} name={group.ownerName} size={32} accent={C.accent} />
                      <div style={{ fontSize: 14, fontWeight: 700, color: C.text, fontFamily: font }}>{group.ownerName}</div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {group.items.map((item) => {
                        const delay = globalIdx * 0.06;
                        globalIdx++;
                        return (
                          <ReservationCard
                            key={item.id}
                            item={item}
                            animDelay={delay}
                            locale={locale}
                            onTap={() => {
                              setViewingItem({
                                ...item,
                                reservedByDisplayName: null,
                                reservedByActorHash: myActorHashRef.current,
                              } as GuestItem);
                              setHomeReturnTab('reservations');
                              setScreen('guest-item-detail');
                            }}
                            onUnreserve={() => setPendingUnreserveAction(() => () => handleUnreserveFromReservations(item))}
                          />
                        );
                      })}
                    </div>
                  </div>
                ));
              })()}
            </div>
          )}

          <BottomSheet isOpen={showCreateWl} onClose={() => setShowCreateWl(false)} title={t('new_wishlist', locale)}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('wishlist_name', locale)}</label>
                <div style={{ position: 'relative' }}>
                  <input style={{ ...inputStyle, paddingRight: wlTitle ? 40 : 16 }} placeholder={t('wishlist_name_placeholder', locale)} value={wlTitle} onChange={(e) => setWlTitle(e.target.value)} autoFocus />
                  {wlTitle && (
                    <button
                      onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                      onClick={(e) => { e.stopPropagation(); setWlTitle(''); }}
                      style={{
                        position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                        background: C.textMuted + '33', border: 'none', borderRadius: 10, width: 20, height: 20,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: C.textSec, fontSize: 11, cursor: 'pointer', padding: 0, lineHeight: 1,
                      }}
                    >✕</button>
                  )}
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('wishlist_deadline', locale)}</label>
                <div style={{ position: 'relative' }}>
                  {/* minHeight matches text input; paddingRight always 40 to reserve clear-button zone */}
                  <input
                    style={{ ...inputStyle, colorScheme: 'dark', minHeight: 50, paddingRight: 40 }}
                    type="date"
                    value={wlDeadline}
                    onChange={(e) => setWlDeadline(e.target.value)}
                  />
                  {wlDeadline && (
                    <button
                      onPointerDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
                      onClick={(e) => { e.stopPropagation(); setWlDeadline(''); }}
                      style={{
                        position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)',
                        background: C.textMuted + '33', border: 'none', borderRadius: 10, width: 20, height: 20,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: C.textSec, fontSize: 11, cursor: 'pointer', padding: 0, lineHeight: 1,
                        zIndex: 2,
                      }}
                    >✕</button>
                  )}
                </div>
              </div>
              <button style={{ ...btnPrimary, opacity: wlTitle.trim() ? 1 : 0.5 }} onClick={() => void handleCreateWishlist()} disabled={!wlTitle.trim() || loading}>
                {loading ? '…' : t('wishlist_create_btn', locale)}
              </button>
            </div>
          </BottomSheet>
        </div>
      )}

      {/* ══════════════════════════════════════════════
          DRAFTS — НЕРАЗОБРАННОЕ
          ══════════════════════════════════════════════ */}
      {screen === 'drafts' && (
        <div style={{ padding: '16px 20px 120px' }}>
          {/* Header */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
              <div>
                <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: font, color: C.text, margin: 0 }}>📥 {t('drafts_title', locale)}</h1>
                <p style={{ fontSize: 13, color: C.textMuted, margin: '4px 0 0' }}>
                  {draftsSelectMode
                    ? t('drafts_selected_n', locale, { n: draftsSelected.length })
                    : draftsItems.length > 0
                      ? `${draftsItems.length} ${pluralize(draftsItems.length, t('cards_one', locale), t('cards_few', locale), t('cards_many', locale), locale)}`
                      : t('drafts_send_link', locale)}
                </p>
              </div>
              {draftsItems.length > 0 && !draftsSelectMode && (
                <button
                  style={{ ...btnGhost, padding: '8px 14px', fontSize: 13, flexShrink: 0, marginTop: 2 }}
                  onClick={() => { setDraftsSelectMode(true); setDraftsSelected([]); }}
                >
                  {t('drafts_select', locale)}
                </button>
              )}
              {draftsSelectMode && (
                <button
                  style={{ ...btnGhost, padding: '8px 14px', fontSize: 13, flexShrink: 0, marginTop: 2, color: C.textMuted }}
                  onClick={() => { setDraftsSelectMode(false); setDraftsSelected([]); }}
                >
                  {t('drafts_cancel_select', locale)}
                </button>
              )}
            </div>
          </div>

          {/* Bulk action bar — visible in select mode */}
          {draftsSelectMode && (
            <div style={{
              position: 'sticky', top: 0, zIndex: 10,
              background: C.surface, borderBottom: `1px solid ${C.border}`,
              padding: '10px 0', marginBottom: 16,
              display: 'flex', gap: 8, alignItems: 'center',
            }}>
              <button
                style={{ ...btnGhost, padding: '8px 12px', fontSize: 13, flex: 1 }}
                onClick={() => {
                  if (draftsSelected.length === draftsItems.length) {
                    setDraftsSelected([]);
                  } else {
                    setDraftsSelected(draftsItems.map(i => i.id));
                  }
                }}
              >
                {draftsSelected.length === draftsItems.length ? t('drafts_deselect_all', locale) : t('drafts_select_all', locale)}
              </button>
              <button
                style={{
                  ...btnPrimary, padding: '8px 14px', fontSize: 13,
                  opacity: draftsSelected.length > 0 && !draftsBulkLoading ? 1 : 0.4,
                }}
                disabled={draftsSelected.length === 0 || draftsBulkLoading}
                onClick={() => setShowBulkMovePicker(true)}
              >
                📁 {t('drafts_move', locale)}
              </button>
              <button
                style={{
                  ...btnGhost, padding: '8px 14px', fontSize: 13, color: C.red,
                  opacity: draftsSelected.length > 0 && !draftsBulkLoading ? 1 : 0.4,
                }}
                disabled={draftsSelected.length === 0 || draftsBulkLoading}
                onClick={() => setShowBulkDeleteConfirm(true)}
              >
                🗑
              </button>
            </div>
          )}

          {/* URL input — hidden in select mode, with PRO badge for FREE users */}
          {!draftsSelectMode && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
              <div style={{ position: 'relative', flex: 1 }}>
                <input
                  style={{ ...inputStyle, flex: 1, paddingRight: planInfo.code === 'FREE' ? 52 : 16 }}
                  placeholder={planInfo.code === 'FREE' ? t('drafts_url_pro_placeholder', locale) : t('drafts_url_placeholder', locale)}
                  value={importUrl}
                  onChange={(e) => setImportUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (planInfo.code === 'FREE') { showUpsell('url_import'); return; }
                      void handleImportUrl();
                    }
                  }}
                />
                {planInfo.code === 'FREE' && (
                  <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)' }}>
                    <ProBadge />
                  </span>
                )}
              </div>
              <button
                style={{
                  ...btnPrimary,
                  width: 48, minWidth: 48, padding: 0,
                  opacity: importUrl.trim() && !importLoading ? 1 : 0.5,
                }}
                onClick={() => {
                  if (planInfo.code === 'FREE') { showUpsell('url_import'); return; }
                  void handleImportUrl();
                }}
                disabled={!importUrl.trim() || importLoading}
              >
                {importLoading ? '…' : '📥'}
              </button>
            </div>
          )}

          {/* Draft items list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {draftsItems.map((item, i) => {
              const isSelected = draftsSelected.includes(item.id);
              return (
                <div
                  key={item.id}
                  style={{
                    background: draftsSelectMode && isSelected ? C.accentSoft : C.card,
                    borderRadius: 16, padding: 16,
                    border: draftsSelectMode && isSelected ? `1.5px solid ${C.accent}` : `1px solid ${C.border}`,
                    animation: `fadeIn 0.3s ease ${i * 0.06}s both`,
                    cursor: draftsSelectMode ? 'pointer' : 'default',
                    WebkitTapHighlightColor: 'transparent',
                    transition: 'background 0.15s, border-color 0.15s',
                  }}
                  onClick={draftsSelectMode ? () => {
                    setDraftsSelected(prev =>
                      prev.includes(item.id) ? prev.filter(id => id !== item.id) : [...prev, item.id]
                    );
                  } : undefined}
                >
                  <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
                    {/* Checkbox circle in select mode */}
                    {draftsSelectMode && (
                      <div style={{
                        width: 22, height: 22, borderRadius: 11, flexShrink: 0, marginTop: 2,
                        border: `2px solid ${isSelected ? C.accent : C.border}`,
                        background: isSelected ? C.accent : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        transition: 'background 0.15s, border-color 0.15s',
                      }}>
                        {isSelected && <span style={{ color: '#fff', fontSize: 12, lineHeight: 1 }}>✓</span>}
                      </div>
                    )}
                    {item.imageUrl && (
                      <img
                        src={item.imageUrl}
                        alt=""
                        style={{ width: 56, height: 56, borderRadius: 10, objectFit: 'cover', flexShrink: 0 }}
                        onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }}
                      />
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 15, fontWeight: 600, color: C.text, fontFamily: font, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.title}
                      </div>
                      {item.sourceDomain && (
                        <div style={{ fontSize: 12, color: C.orange, marginTop: 2 }}>
                          🔗 {item.sourceDomain}
                        </div>
                      )}
                      {item.price != null && item.price > 0 && (
                        <div style={{ fontSize: 13, color: C.textSec, marginTop: 2 }}>
                          💰 {fmtPrice(item.price, locale, item.currency ?? 'RUB')}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Action buttons — hidden in select mode */}
                  {!draftsSelectMode && (
                    <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                      <button
                        style={{ ...btnSecondary, flex: 1, padding: '10px 0', fontSize: 13 }}
                        onClick={() => { setMovingItem(item); setShowMovePicker(true); }}
                      >
                        📁 {t('drafts_move', locale)}
                      </button>
                      <button
                        style={{ ...btnGhost, padding: '10px 12px', fontSize: 13, color: C.textMuted }}
                        onClick={() => handleArchiveDraft(item)}
                      >
                        📦 {t('drafts_archive', locale)}
                      </button>
                      <button
                        style={{ ...btnGhost, padding: '10px 12px', fontSize: 13 }}
                        onClick={() => {
                          setViewingItem(item);
                          setFromDrafts(true);
                          setScreen('item-detail');
                        }}
                      >
                        {t('drafts_open', locale)}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {draftsItems.length === 0 && !importLoading && (
            <div style={{ textAlign: 'center', padding: '48px 24px' }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>📥</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t('drafts_empty', locale)}</div>
              <div style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.5 }}>
                {t('drafts_empty_hint', locale)}
              </div>
            </div>
          )}

        </div>
      )}

      {/* ══════════════════════════════════════════════
          MY RESERVATIONS
          ══════════════════════════════════════════════ */}
      {screen === 'my-reservations' && (
        <div style={{ padding: '16px 20px 120px' }}>
          <div style={{ marginBottom: 20 }}>
            <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: font, color: C.text, margin: 0 }}>🎁 {t('reservations_title', locale)}</h1>
            <p style={{ fontSize: 13, color: C.textMuted, margin: '4px 0 0' }}>
              {reservationsCount > 0
                ? `${reservationsCount} ${pluralize(reservationsCount, t('wishes_one', locale), t('wishes_few', locale), t('wishes_many', locale), locale)}`
                : t('reservations_empty_hint', locale)}
            </p>
          </div>

          {reservationsLoading && reservations.length === 0 && santaReservationItems.length === 0 && (
            <div style={{ textAlign: 'center', padding: '48px 24px' }}>
              <div style={{ fontSize: 32, marginBottom: 12, animation: 'fadeIn 0.3s ease' }}>⏳</div>
              <div style={{ fontSize: 14, color: C.textMuted }}>{t('reservations_loading', locale)}</div>
            </div>
          )}

          {!reservationsLoading && !santaReservationItemsLoading && reservations.length === 0 && santaReservationItems.length === 0 && (
            <div style={{ textAlign: 'center', padding: '48px 24px' }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>🎁</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t('reservations_empty_title', locale)}</div>
              <div style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.5 }}>
                {t('reservations_empty_hint', locale)}
              </div>
            </div>
          )}

          {/* ── Santa reservations section ── */}
          {santaReservationItems.length > 0 && (() => {
            // Group by campaignId
            const campGroups: Record<string, { campaignTitle: string; campaignStatus: string; items: SantaReservationItem[] }> = {};
            for (const r of santaReservationItems) {
              const g = campGroups[r.campaignId] ?? (campGroups[r.campaignId] = { campaignTitle: r.campaignTitle, campaignStatus: r.campaignStatus, items: [] });
              g.items.push(r);
            }
            let santaIdx = 0;
            return (
              <div style={{ marginBottom: 28 }}>
                {/* Section header */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                    🎅 {t('santa_reservations_section_title', locale)}
                  </div>
                </div>
                {Object.entries(campGroups).map(([campaignId, group]) => (
                  <div key={campaignId} style={{ marginBottom: 20 }}>
                    {/* Campaign label */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: C.text, fontFamily: font }}>{group.campaignTitle}</div>
                      {group.campaignStatus === 'COMPLETED' && (
                        <div style={{ fontSize: 11, fontWeight: 600, color: C.textMuted, background: C.surface, borderRadius: 6, padding: '2px 6px' }}>
                          {t('santa_reservations_completed', locale)}
                        </div>
                      )}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {group.items.map((item) => {
                        const delay = santaIdx * 0.06;
                        santaIdx++;
                        return (
                          <ReservationCard
                            key={item.id}
                            item={item as unknown as ReservationItem}
                            animDelay={delay}
                            locale={locale}
                            onTap={() => {
                              setSantaDetailContext({
                                source: 'reservation',
                                campaignId: item.campaignId,
                                campaignTitle: item.campaignTitle,
                                campaignStatus: item.campaignStatus,
                                giftStatus: item.giftStatus,
                              });
                              setViewingItem({ ...item, reservedByDisplayName: null, reservedByActorHash: myActorHashRef.current } as unknown as GuestItem);
                              setFromReservations(true);
                              setScreen('guest-item-detail');
                            }}
                            onUnreserve={() => setPendingUnreserveAction(() => () => handleUnreserveSantaItem(item))}
                          />
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}

          {reservations.length > 0 && (() => {
            const groups: Record<string, { ownerName: string; ownerAvatarUrl: string | null; items: ReservationItem[] }> = {};
            for (const r of reservations) {
              const g = groups[r.ownerId] ?? (groups[r.ownerId] = { ownerName: r.ownerName, ownerAvatarUrl: r.ownerAvatarUrl, items: [] });
              g.items.push(r);
            }
            let globalIdx = 0;
            return Object.entries(groups).map(([ownerId, group]) => (
              <div key={ownerId} style={{ marginBottom: 24 }}>
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12,
                    cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
                  }}
                  onClick={() => pushToast(t('toast_profile_coming', locale), 'success')}
                >
                  <UserAvatar avatarUrl={group.ownerAvatarUrl} name={group.ownerName || t('api_user_fallback', locale)} size={36} accent={C.accent} />
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: C.text, fontFamily: font }}>{group.ownerName}</div>
                    <div style={{ fontSize: 12, color: C.textMuted }}>
                      {group.items.length} {pluralize(group.items.length, t('wishes_one', locale), t('wishes_few', locale), t('wishes_many', locale), locale)}
                    </div>
                  </div>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {group.items.map((item) => {
                    const delay = globalIdx * 0.06;
                    globalIdx++;
                    return (
                      <ReservationCard
                        key={item.id}
                        item={item}
                        animDelay={delay}
                        locale={locale}
                        onTap={() => {
                          setViewingItem({
                            ...item,
                            reservedByDisplayName: null,
                            reservedByActorHash: myActorHashRef.current,
                          } as GuestItem);
                          setFromReservations(true);
                          setScreen('guest-item-detail');
                        }}
                        onUnreserve={() => setPendingUnreserveAction(() => () => handleUnreserveFromReservations(item))}
                      />
                    );
                  })}
                </div>
              </div>
            ));
          })()}
        </div>
      )}

      {/* ══════════════════════════════════════════════
          OWNER — WISHLIST DETAIL
          ══════════════════════════════════════════════ */}
      {screen === 'wishlist-detail' && currentWl && (
        <div style={{ padding: '16px 20px', paddingBottom: 'calc(90px + env(safe-area-inset-bottom, 0px))' }}>
          {/* ── Wishlist detail header ── */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, marginBottom: 16 }}>
            {/* Left: title + meta */}
            <div style={{ flex: 1, minWidth: 0 }}>
              <h1 style={{
                fontSize: 20, fontWeight: 700, fontFamily: font, color: C.text, margin: 0,
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
                overflow: 'hidden', textOverflow: 'ellipsis', lineHeight: 1.3,
              }}>{currentWl.title}</h1>
              <p style={{ fontSize: 12, color: C.textMuted, margin: '4px 0 0' }}>
                {t('wishes_count', locale, { count: items.length })}
                {currentWl.deadline && ` • ${fmtDeadline(currentWl.deadline)}`}
              </p>
            </div>
            {/* Right: vertical action stack */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
              <button
                onClick={() => setScreen('share')}
                style={{ ...btnPrimary, width: 'auto', padding: '8px 16px', fontSize: 13 }}
              >
                {t('share_btn', locale)}
              </button>
              {/* Manage button — always visible to owner (wishlist-detail is owner-only) */}
              <button
                onClick={() => setShowWlManage(true)}
                style={{ ...btnGhost, padding: '8px 16px', fontSize: 13 }}
              >
                {t('wl_manage_btn', locale)}
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {currentWl.readOnly && (
              <div style={{
                borderRadius: 12, padding: '14px 16px', fontSize: 13,
                display: 'flex', alignItems: 'center', gap: 10,
                background: C.orangeSoft, color: C.orange, lineHeight: 1.5,
              }}>
                <span>🔒</span>
                <span>
                  {t('read_only_notice', locale)}{' '}
                  <span onClick={() => showUpsell('wishlist_limit')} style={{ textDecoration: 'underline', cursor: 'pointer', fontWeight: 600 }}>
                    {t('read_only_upgrade', locale)}
                  </span>{t('read_only_to_edit', locale)}
                </span>
              </div>
            )}
            <div style={{ borderRadius: 12, padding: '12px 16px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10, background: C.accentSoft, color: C.accent, lineHeight: 1.5 }}>
              <span>👁</span><span>{t('surprise_notice', locale)}</span>
            </div>

            {loading && items.length === 0 && (
              <div style={{ textAlign: 'center', padding: 40, color: C.textMuted }}>{t('loading', locale)}</div>
            )}

            {/* ── Item reorder mode ── */}
            {itemReorderMode && (
              <>
                <div style={{ display: 'flex', gap: 8, marginBottom: 4 }}>
                  <button
                    style={{ ...btnPrimary, flex: 1, opacity: itemReorderSaving ? 0.6 : 1 }}
                    onClick={() => void handleSaveItemReorder()}
                    disabled={itemReorderSaving}
                  >
                    {itemReorderSaving ? '…' : t('wl_reorder_save', locale)}
                  </button>
                  <button style={{ ...btnGhost, flex: 1 }} onClick={cancelItemReorderMode}>
                    {t('wl_reorder_cancel', locale)}
                  </button>
                </div>
                <div style={{ fontSize: 12, color: C.textMuted, textAlign: 'center', marginBottom: 8, lineHeight: 1.4 }}>
                  {t('item_reorder_hint', locale)}
                </div>
                {([3, 2, 1] as const).map(prioNum => {
                  const groupItems = itemReorderList.filter(it => it.priority === prioNum);
                  if (groupItems.length === 0) return null;
                  const prioLabel = getPriorities(locale).find(p => p.value === prioNum)?.label ?? '';
                  const prioIcon = prioNum === 3 ? '🔴' : prioNum === 2 ? '🟡' : '🟢';
                  return (
                    <div key={prioNum}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, letterSpacing: 0.5, marginBottom: 6, marginTop: 4, display: 'flex', alignItems: 'center', gap: 4 }}>
                        <span>{prioIcon}</span><span style={{ textTransform: 'uppercase' }}>{prioLabel}</span>
                      </div>
                      {groupItems.map(item => {
                        const globalIdx = itemReorderList.findIndex(it => it.id === item.id);
                        const isDragging = itemReorderDragIdx === globalIdx;
                        return (
                          <div
                            key={item.id}
                            style={{
                              background: isDragging ? C.accent + '22' : C.card,
                              borderRadius: 14, padding: '12px 14px', marginBottom: 8,
                              border: `1px solid ${isDragging ? C.accent : C.border}`,
                              display: 'flex', alignItems: 'center', gap: 10,
                              transition: 'background 0.12s, border-color 0.12s',
                              userSelect: 'none', touchAction: 'none',
                            }}
                          >
                            <div
                              onPointerDown={(e) => handleItemReorderPointerDown(e, globalIdx)}
                              onPointerMove={(e) => handleItemReorderPointerMove(e, globalIdx)}
                              onPointerUp={handleItemReorderPointerUp}
                              onPointerCancel={handleItemReorderPointerUp}
                              style={{ fontSize: 20, color: C.textMuted, cursor: 'grab', padding: '4px 6px 4px 0', lineHeight: 1, flexShrink: 0, touchAction: 'none' }}
                            >
                              ⠿
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 14, fontWeight: 600, color: C.text, fontFamily: font, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                {item.title}
                              </div>
                              {item.price != null && (
                                <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                                  {fmtPrice(item.price, locale, item.currency ?? 'RUB')}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </>
            )}

            {/* ── Normal mode items ── */}
            {!itemReorderMode && items.map((item, i) => (
              <div key={item.id} style={{ animation: `fadeIn 0.3s ease ${i * 0.06}s both` }}>
                <WishCardOwner item={item} onTap={(it) => { setViewingItem(it); setScreen('item-detail'); }} onDelete={setDeletingItem} onComplete={handleCompleteItem} locale={locale} />
              </div>
            ))}

            {!itemReorderMode && !loading && items.length === 0 && (
              <div style={{ textAlign: 'center', padding: '48px 24px' }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>✨</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t('add_first_wish', locale)}</div>
                <div style={{ fontSize: 14, color: C.textMuted }}>{t('add_first_wish_hint', locale)}</div>
              </div>
            )}

            {!itemReorderMode && !currentWl.readOnly && (
              <div style={{ textAlign: 'center', padding: '4px 0', fontSize: 12, color: C.textMuted }}>
                {t('items_limit_status', locale, { count: items.length, max: planLimits.items + (addOns.extraItemsPerWishlist?.[currentWl.id] ?? 0) })}
              </div>
            )}
          </div>

        </div>
      )}

      {/* ══════════════════════════════════════════════
          OWNER — ITEM DETAIL (view + actions)
          ══════════════════════════════════════════════ */}
      {screen === 'item-detail' && viewingItem && (() => {
        const displayTitle = normalizeTitle(viewingItem.title);
        const copyTitle = async () => {
          if (!displayTitle) return;
          try {
            if (typeof window !== 'undefined' && window.Telegram?.WebApp?.writeToClipboard) {
              window.Telegram.WebApp.writeToClipboard(displayTitle);
              pushToast(t('title_copied', locale), 'success');
              return;
            }
            await navigator.clipboard.writeText(displayTitle);
            pushToast(t('title_copied', locale), 'success');
          } catch {
            try {
              const ta = document.createElement('textarea');
              ta.value = displayTitle;
              ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              document.body.removeChild(ta);
              pushToast(t('title_copied', locale), 'success');
            } catch {
              pushToast(t('title_copy_error', locale), 'error');
            }
          }
        };
        return (
        <div style={{ padding: '0 0 40px' }}>
          {/* Hero image */}
          <div style={{ padding: '16px 16px 0' }}>
            {viewingItem.imageUrl ? (
              <img src={viewingItem.imageUrl} alt="" style={{ width: '100%', height: 230, objectFit: 'cover', borderRadius: 20, display: 'block', background: C.surface }} />
            ) : (
              <div style={{ width: '100%', height: 180, borderRadius: 20, background: C.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 56 }}>
                {getEmoji(viewingItem.title)}
              </div>
            )}
          </div>

          {/* Content */}
          <div style={{ padding: '20px 20px 0' }}>
            {/* Title (left) + Meta-block: price + priority centered on same axis (right) */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
              <h1
                onClick={() => { if (displayTitle) void copyTitle(); }}
                onPointerDown={() => { if (displayTitle) setTitlePressed(true); }}
                onPointerUp={() => setTitlePressed(false)}
                onPointerLeave={() => setTitlePressed(false)}
                onPointerCancel={() => setTitlePressed(false)}
                style={{
                  flex: 1, minWidth: 0,
                  fontSize: 22, fontWeight: 700, fontFamily: font, color: C.text,
                  margin: 0, lineHeight: 1.25,
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
                  overflow: 'hidden', textOverflow: 'ellipsis',
                  cursor: displayTitle ? 'pointer' : 'default',
                  opacity: titlePressed ? 0.55 : 1,
                  transition: titlePressed ? 'none' : 'opacity 0.2s',
                  userSelect: 'none', WebkitUserSelect: 'none',
                }}
              >{displayTitle}</h1>
              {/* Meta-block: width = max-content so both items share same center axis */}
              <div style={{
                flexShrink: 0,
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                gap: 7,
                width: 'max-content', maxWidth: '46%',
              }}>
                {viewingItem.price != null && (
                  <div style={{
                    fontSize: 17, fontWeight: 700, color: C.accent,
                    whiteSpace: 'nowrap', lineHeight: 1, paddingTop: 3,
                    fontVariantNumeric: 'tabular-nums', textAlign: 'center',
                  }}>
                    {fmtPrice(viewingItem.price, locale, viewingItem.currency ?? 'RUB')}
                  </div>
                )}
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '4px 10px', borderRadius: 100,
                  background: PRIO_BG[viewingItem.priority] ?? PRIO_BG[1],
                  fontSize: 12, fontWeight: 600,
                  color: PRIO_COLOR[viewingItem.priority] ?? PRIO_COLOR[1],
                  whiteSpace: 'nowrap',
                }}>
                  {prioEmoji(viewingItem.priority)}{' '}
                  {getPriorities(locale).find((p) => p.value === viewingItem!.priority)?.label}
                </div>
              </div>
            </div>

            {/* URL + source badge */}
            {viewingItem.url && (
              <div style={{ marginTop: 0, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                <a href={viewingItem.url} target="_blank" rel="noreferrer" style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13,
                  color: C.accent, background: C.accentSoft, padding: '8px 14px',
                  borderRadius: 12, textDecoration: 'none', wordBreak: 'break-all',
                }}>
                  🔗 {viewingItem.sourceDomain || viewingItem.url.replace(/^https?:\/\//, '').slice(0, 40)}{!viewingItem.sourceDomain && viewingItem.url.length > 47 ? '…' : ''}
                </a>
              </div>
            )}

            {/* Status badge */}
            {(viewingItem.status === 'reserved' || viewingItem.status === 'purchased') && (
              <div style={{ marginTop: 14 }}>
                {viewingItem.status === 'reserved' && <span style={{ display: 'inline-block', padding: '8px 14px', borderRadius: 12, background: C.accentSoft, color: C.accent, fontSize: 14, fontWeight: 600 }}>{t('status_someone_reserved', locale)}</span>}
                {viewingItem.status === 'purchased' && <span style={{ display: 'inline-block', padding: '8px 14px', borderRadius: 12, background: C.greenSoft, color: C.green, fontSize: 14, fontWeight: 600 }}>{t('status_gifted', locale)}</span>}
              </div>
            )}

            {/* Description section */}
            <div style={{ marginTop: 24 }}>
              {viewingItem.description ? (
                <>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <span style={{ fontSize: 17, fontWeight: 600, color: C.text, fontFamily: font }}>{t('description_title', locale)}</span>
                    <span
                      onClick={() => { setDescriptionText(viewingItem.description?.replace(/\n+$/, '') ?? ''); setEditingDescription(true); }}
                      style={{ fontSize: 13, color: C.accent, cursor: 'pointer', fontFamily: font }}
                    >
                      {t('description_edit', locale)}
                    </span>
                  </div>
                  <div style={{ fontSize: 15, color: C.textSec, lineHeight: 1.65 }}>
                    {viewingItem.description}
                  </div>
                </>
              ) : (
                <div
                  onClick={() => { setDescriptionText(''); setEditingDescription(true); }}
                  style={{
                    padding: 20, textAlign: 'center', cursor: 'pointer',
                    background: C.surface, borderRadius: 16,
                    border: `1px dashed ${C.borderLight}`,
                  }}
                >
                  <div style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.5, marginBottom: 8 }}>
                    {t('description_add_prompt', locale)}
                  </div>
                  <span style={{ fontSize: 14, color: C.accent, fontWeight: 600, fontFamily: font }}>{t('description_add_btn', locale)}</span>
                </div>
              )}
            </div>

            {/* Comments — full for PRO, locked placeholder for FREE */}
            {planInfo.code === 'PRO' ? (
              <CommentsThread
                commentRole={commentRole}
                comments={comments}
                commentText={commentText}
                setCommentText={setCommentText}
                commentSending={commentSending}
                myActorHash={myActorHashRef.current}
                onDeleteComment={handleDeleteComment}
                onSendComment={handleSendComment}
                isArchive={viewingItem.status === 'completed' || viewingItem.status === 'deleted'}
                locale={locale}
              />
            ) : (
              <div
                onClick={() => showUpsell('comments')}
                style={{
                  marginTop: 24, padding: 20, background: C.surface, borderRadius: 20,
                  cursor: 'pointer', border: `1px solid ${C.accent}15`,
                  transition: 'border-color 0.2s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 20 }}>💬</span>
                  <span style={{ fontSize: 16, fontWeight: 600, color: C.text, fontFamily: font }}>{t('comments_pro_title', locale)}</span>
                  <ProBadge />
                </div>
                <div style={{ fontSize: 13, color: C.textSec, lineHeight: 1.4 }}>
                  {t('comments_pro_hint', locale)}
                </div>
                <div style={{ marginTop: 12, fontSize: 13, color: C.accent, fontWeight: 600 }}>
                  {t('comments_pro_more', locale)}
                </div>
              </div>
            )}

            {/* Hint button — only show for available items */}
            {viewingItem.status === 'available' && (
              <div
                onClick={() => !hintLoading && handleHintTap(viewingItem as Item)}
                style={{
                  marginTop: 16, padding: 16, background: C.surface, borderRadius: 16,
                  display: 'flex', alignItems: 'center', gap: 12, cursor: hintLoading ? 'wait' : 'pointer',
                  border: `1px solid ${C.accent}10`, opacity: hintLoading ? 0.6 : 1,
                  transition: 'opacity 0.15s',
                }}
              >
                <span style={{ fontSize: 22 }}>💡</span>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{t('hint_friends_btn', locale)}</span>
                    {planInfo.code === 'FREE' && <ProBadge />}
                  </div>
                  <div style={{ fontSize: 12, color: C.textMuted }}>{t('hint_subtitle', locale)}</div>
                </div>
                <span style={{ fontSize: 16, color: C.textMuted }}>›</span>
              </div>
            )}
            {viewingItem.status === 'reserved' && (
              <div
                style={{
                  marginTop: 16, padding: 16, background: C.surface, borderRadius: 16,
                  display: 'flex', alignItems: 'center', gap: 12, opacity: 0.5,
                  border: `1px solid ${C.accent}10`,
                }}
              >
                <span style={{ fontSize: 22 }}>💡</span>
                <div style={{ flex: 1 }}>
                  <span style={{ fontSize: 14, fontWeight: 600, color: C.textSec }}>{t('hint_friends_btn', locale)}</span>
                  <div style={{ fontSize: 12, color: C.textMuted }}>{t('hint_reserved_notice', locale)}</div>
                </div>
              </div>
            )}

            {/* Owner actions — layout depends on whether item lives in Drafts */}
            {viewingItem.status !== 'purchased' && (() => {
              // Detect draft: fromDrafts flag (set when opening from drafts screen)
              // or membership in the local draftsItems list (handles edge cases where
              // the flag was already cleared, e.g. after a navigation effect fires).
              const isDraftItem = fromDrafts || draftsItems.some(d => d.id === (viewingItem as Item).id);
              return (
                <div style={{ marginTop: 24, marginBottom: 32 }}>
                  {isDraftItem ? (
                    <button
                      onClick={() => { setMovingItem(viewingItem as Item); setShowMovePicker(true); }}
                      style={{ ...btnPrimary, width: '100%', borderRadius: 16, padding: '16px 24px', fontSize: 16 }}
                    >
                      {t('item_move_cta', locale)}
                    </button>
                  ) : (
                    <button onClick={() => {
                      setPendingEditItem(viewingItem as Item);
                      setViewingItem(null);
                      setScreen('wishlist-detail');
                    }} style={{ ...btnPrimary, width: '100%', borderRadius: 16, padding: '16px 24px', fontSize: 16 }}>
                      {t('edit_btn', locale)}
                    </button>
                  )}
                  <div style={{ display: 'flex', gap: 12, marginTop: 10 }}>
                    {isDraftItem ? (
                      // Draft: Edit in secondary slot (no Received).
                      // Navigate to 'drafts' (not 'wishlist-detail') so pendingEditItem
                      // effect fires with currentWl intact for the drafts flow.
                      <button onClick={() => {
                        setPendingEditItem(viewingItem as Item);
                        setViewingItem(null);
                        setScreen('drafts');
                      }} style={{
                        ...btnBase, flex: 1, background: C.surface, color: C.text,
                        border: `1px solid ${C.borderLight}`, borderRadius: 14,
                        padding: '12px 16px', fontSize: 14, fontWeight: 500,
                      }}>
                        {t('edit_btn', locale)}
                      </button>
                    ) : (
                      // Regular: Received
                      <button onClick={() => {
                        setShowItemForm(false);
                        resetItemForm();
                        handleCompleteItem(viewingItem as Item);
                        setViewingItem(null);
                        setScreen('wishlist-detail');
                      }} style={{
                        ...btnBase, flex: 1, background: C.surface, color: C.green,
                        border: `1px solid ${C.borderLight}`, borderRadius: 14,
                        padding: '12px 16px', fontSize: 14, fontWeight: 500,
                      }}>
                        {t('received_btn', locale)}
                      </button>
                    )}
                    <button onClick={() => {
                      const item = viewingItem as Item;
                      setViewingItem(null);
                      if (fromDrafts) {
                        setFromDrafts(false);
                        setScreen('drafts');
                      } else {
                        setScreen('wishlist-detail');
                      }
                      setDeletingItem(item);
                    }} style={{
                      ...btnBase, flex: 1, background: C.redSoft, color: C.red,
                      border: 'none', borderRadius: 14,
                      padding: '12px 16px', fontSize: 14, fontWeight: 600,
                    }}>
                      {t('delete_btn', locale)}
                    </button>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
        );
      })()}

      {/* ══════════════════════════════════════════════
          GUEST — ITEM DETAIL (view only)
          ══════════════════════════════════════════════ */}
      {screen === 'guest-item-detail' && viewingItem && (
        <div style={{ padding: '0 0 40px' }}>
          {/* Hero image */}
          <div style={{ padding: '16px 16px 0' }}>
            {viewingItem.imageUrl ? (
              <img src={viewingItem.imageUrl} alt="" style={{ width: '100%', height: 230, objectFit: 'cover', borderRadius: 20, display: 'block', background: C.surface }} />
            ) : (
              <div style={{ width: '100%', height: 180, borderRadius: 20, background: C.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 56 }}>
                {getEmoji(viewingItem.title)}
              </div>
            )}
          </div>

          {/* Content */}
          <div style={{ padding: '20px 20px 0' }}>
            {/* Santa context block */}
            {santaDetailContext && (
              <div style={{
                background: 'rgba(124,106,255,0.08)', border: '1px solid rgba(124,106,255,0.2)',
                borderRadius: 12, padding: '10px 14px', marginBottom: 16,
                display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8,
              }}>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.accent, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    🎅 Тайный Санта
                  </div>
                  <div style={{ fontSize: 13, color: C.text }}>{santaDetailContext.campaignTitle}</div>
                  <div style={{ fontSize: 11, color: C.textMuted }}>
                    {t(`santa_gift_status_${santaDetailContext.giftStatus.toLowerCase()}` as never, locale) || santaDetailContext.giftStatus}
                  </div>
                </div>
                <button
                  onClick={() => void openSantaCampaignFromDetail(santaDetailContext)}
                  style={{ fontSize: 12, color: C.accent, background: C.accentSoft, border: 'none',
                    borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontFamily: font }}
                >
                  Открыть кампанию
                </button>
              </div>
            )}
            {/* Title (left) + Meta-block: price + priority centered on same axis (right) */}
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: 14 }}>
              <h1 style={{
                flex: 1, minWidth: 0,
                fontSize: 22, fontWeight: 700, fontFamily: font, color: C.text,
                margin: 0, lineHeight: 1.25,
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
                overflow: 'hidden', textOverflow: 'ellipsis',
              }}>{normalizeTitle(viewingItem.title)}</h1>
              <div style={{
                flexShrink: 0,
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                gap: 7,
                width: 'max-content', maxWidth: '46%',
              }}>
                {viewingItem.price != null && (
                  <div style={{
                    fontSize: 17, fontWeight: 700, color: C.accent,
                    whiteSpace: 'nowrap', lineHeight: 1, paddingTop: 3,
                    fontVariantNumeric: 'tabular-nums', textAlign: 'center',
                  }}>
                    {fmtPrice(viewingItem.price, locale, viewingItem.currency ?? 'RUB')}
                  </div>
                )}
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 5,
                  padding: '4px 10px', borderRadius: 100,
                  background: PRIO_BG[viewingItem.priority] ?? PRIO_BG[1],
                  fontSize: 12, fontWeight: 600,
                  color: PRIO_COLOR[viewingItem.priority] ?? PRIO_COLOR[1],
                  whiteSpace: 'nowrap',
                }}>
                  {prioEmoji(viewingItem.priority)}{' '}
                  {getPriorities(locale).find((p) => p.value === viewingItem!.priority)?.label}
                </div>
              </div>
            </div>

            {/* URL */}
            {viewingItem.url && (
              <div style={{ marginTop: 0 }}>
                <a href={viewingItem.url} target="_blank" rel="noreferrer" style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13,
                  color: C.accent, background: C.accentSoft, padding: '8px 14px',
                  borderRadius: 12, textDecoration: 'none', wordBreak: 'break-all',
                }}>
                  🔗 {viewingItem.url.replace(/^https?:\/\//, '').slice(0, 40)}{viewingItem.url.length > 47 ? '…' : ''}
                </a>
              </div>
            )}

            {/* Description — read-only for guests */}
            {viewingItem.description && (
              <div style={{ marginTop: 24 }}>
                <div style={{ fontSize: 17, fontWeight: 600, color: C.text, fontFamily: font, marginBottom: 10 }}>
                  {t('description_title', locale)}
                </div>
                <div style={{ fontSize: 15, color: C.textSec, lineHeight: 1.65 }}>
                  {viewingItem.description}
                </div>
              </div>
            )}

            {/* Action zone */}
            <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
              {santaDetailContext ? (() => {
                const rState = getSantaItemReservationState(
                  viewingItem.status,
                  (viewingItem as GuestItem).reservedByActorHash ?? null,
                  myActorHashRef.current,
                );
                if (santaDetailContext.source === 'reservation') {
                  return (
                    <>
                      <span style={{ display: 'inline-block', padding: '10px 16px', borderRadius: 12, background: C.greenSoft, color: C.green, fontSize: 14, fontWeight: 600 }}>
                        {t('reserved_by_me', locale)}
                      </span>
                      <button
                        onClick={() => {
                          const si = santaReservationItems.find(i => i.id === viewingItem.id);
                          if (si) setPendingUnreserveAction(() => () => handleUnreserveSantaItem(si, () => {
                            setSantaDetailContext(null);
                            setViewingItem(null);
                            setFromReservations(false);
                            setScreen('my-reservations');
                          }));
                        }}
                        style={{
                          ...btnBase, width: '100%', background: C.redSoft, color: C.red,
                          border: '1px solid rgba(248,113,113,0.3)', borderRadius: 14,
                          padding: '12px 16px', fontSize: 14, fontWeight: 500,
                        }}
                      >
                        {t('cancel_reservation', locale)}
                      </button>
                    </>
                  );
                } else {
                  const isReserving = santaWishlistReservingId === viewingItem.id;
                  const isReadOnly = !['OPEN', 'LOCKED', 'ACTIVE'].includes(santaDetailContext.campaignStatus);
                  return (
                    <>
                      {rState === 'reserved-by-me' && (
                        <span style={{ display: 'inline-block', padding: '10px 16px', borderRadius: 12, background: C.greenSoft, color: C.green, fontSize: 14, fontWeight: 600 }}>
                          {t('reserved_by_me', locale)}
                        </span>
                      )}
                      {rState === 'reserved-by-other' && (
                        <span style={{ display: 'inline-block', padding: '10px 16px', borderRadius: 12, background: C.orangeSoft, color: C.orange, fontSize: 14, fontWeight: 600 }}>
                          {t('already_reserved', locale)}
                        </span>
                      )}
                      {(rState === 'available' || rState === 'reserved-by-me') && !isReadOnly && (
                        <button
                          disabled={isReserving}
                          onClick={() => rState === 'reserved-by-me'
                            ? void handleSantaReceiverUnreserve(viewingItem.id)
                            : void handleSantaReceiverReserve(viewingItem.id)}
                          style={{ ...btnPrimary, width: '100%', borderRadius: 16, padding: '16px 24px', fontSize: 16, opacity: isReserving ? 0.6 : 1 }}
                        >
                          {isReserving ? '…' : rState === 'reserved-by-me' ? t('cancel_reservation', locale) : t('reserve_btn', locale)}
                        </button>
                      )}
                    </>
                  );
                }
              })() : (
                <>
                  {viewingItem.status === 'available' && (
                    <button onClick={() => { setReservingItem(viewingItem as GuestItem); setGuestName(tgUser?.first_name ?? ''); }}
                      style={{ ...btnPrimary, width: '100%', borderRadius: 16, padding: '16px 24px', fontSize: 16 }}>
                      {t('reserve_btn', locale)}
                    </button>
                  )}
                  {viewingItem.status === 'reserved' && !!myActorHashRef.current && (viewingItem as GuestItem).reservedByActorHash === myActorHashRef.current && (
                    <>
                      <span style={{ display: 'inline-block', padding: '10px 16px', borderRadius: 12, background: C.greenSoft, color: C.green, fontSize: 14, fontWeight: 600 }}>
                        {t('reserved_by_me', locale)}
                      </span>
                      <button onClick={() => setPendingUnreserveAction(() => () => handleUnreserve(viewingItem as GuestItem))}
                        style={{
                          ...btnBase, width: '100%', background: C.redSoft, color: C.red,
                          border: `1px solid rgba(248,113,113,0.3)`, borderRadius: 14,
                          padding: '12px 16px', fontSize: 14, fontWeight: 500,
                        }}>
                        {t('cancel_reservation', locale)}
                      </button>
                    </>
                  )}
                  {viewingItem.status === 'reserved' && !(!!myActorHashRef.current && (viewingItem as GuestItem).reservedByActorHash === myActorHashRef.current) && (
                    <span style={{ display: 'inline-block', padding: '10px 16px', borderRadius: 12, background: C.orangeSoft, color: C.orange, fontSize: 14, fontWeight: 600 }}>
                      {t('already_reserved', locale)}
                    </span>
                  )}
                  {viewingItem.status === 'purchased' && (
                    <span style={{ display: 'inline-block', padding: '10px 16px', borderRadius: 12, background: C.greenSoft, color: C.green, fontSize: 14, fontWeight: 600 }}>
                      {t('status_gifted', locale)}
                    </span>
                  )}
                </>
              )}
            </div>

            {/* Comments — for reserver and owner */}
            <CommentsThread
              commentRole={commentRole}
              comments={comments}
              commentText={commentText}
              setCommentText={setCommentText}
              commentSending={commentSending}
              myActorHash={myActorHashRef.current}
              onDeleteComment={handleDeleteComment}
              onSendComment={handleSendComment}
              isArchive={viewingItem.status === 'completed' || viewingItem.status === 'deleted'}
              locale={locale}
            />

            {/* Hint for third parties */}
            {viewingItem.status === 'available' && !commentRole && (
              <div style={{ fontSize: 13, color: C.textMuted, textAlign: 'center', marginTop: 16, lineHeight: 1.5, padding: '0 16px' }}>
                {t('after_reserve_hint', locale)}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════
          OWNER — SHARE
          ══════════════════════════════════════════════ */}
      {screen === 'share' && currentWl && (
        <ShareScreen
          wishlist={currentWl}
          itemCount={items.length}
          tgUser={tgUser}
          ownerName={resolveOwnerName(profileData, tgUser)}
          ownerAvatarUrl={profileData?.avatarUrl ?? null}
          onCopied={() => pushToast(t('share_copied', locale), 'success')}
          locale={locale}
          buildTgDeepLink={buildTgDeepLink}
          isPro={planInfo.code === 'PRO'}
          tgFetch={tgFetch}
        />
      )}

      {/* ══════════════════════════════════════════════
          GUEST VIEW
          ══════════════════════════════════════════════ */}
      {screen === 'guest-view' && guestWl && (
        <div style={{ padding: '16px 20px 120px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '8px 0 20px' }}>
            <UserAvatar
              avatarUrl={guestWl.ownerAvatarUrl}
              name={guestWl.ownerName ?? '🎁'}
              size={48}
              accent={C.accent}
            />
            <div style={{ flex: 1, minWidth: 0 }}>
              {guestWl.ownerName && (
                <div style={{ fontSize: 13, fontWeight: 600, color: C.accent, marginBottom: 2 }}>{guestWl.ownerName}</div>
              )}
              <div style={{ fontSize: 18, fontWeight: 700, fontFamily: font, color: C.text }}>{guestWl.title}</div>
              {guestWl.description && <div style={{ fontSize: 13, color: C.textMuted }}>{guestWl.description}</div>}
              {guestWl.deadline && (
                <div style={{ fontSize: 12, color: C.textMuted }}>📅 {fmtDeadline(guestWl.deadline)}</div>
              )}
            </div>
            {/* Subscribe button — right corner, only for logged-in users */}
            {tgUser && (
              <button
                key={isSubscribed ? 'subscribed' : 'not-subscribed'}
                onClick={() => {
                  if (isSubscribed) {
                    void handleUnsubscribe(guestWl.id);
                  } else {
                    void handleSubscribe(guestWl.id);
                  }
                }}
                disabled={subscribing}
                style={{
                  flexShrink: 0, padding: '8px 14px', borderRadius: 20, border: 'none', cursor: 'pointer',
                  fontFamily: font, fontSize: 12, fontWeight: 600,
                  background: isSubscribed ? C.surface : C.accent,
                  color: isSubscribed ? C.textSec : '#fff',
                  opacity: subscribing ? 0.7 : 1,
                }}
              >
                {isSubscribed ? `✓ ${t('sub_subscribed_btn', locale)}` : t('sub_subscribe_btn', locale)}
              </button>
            )}
          </div>

          {/* ── Filter & Sort bar ─────────────────────────────────────── */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 14, overflowX: 'auto', paddingBottom: 2 }}>
            {/* Filter button */}
            <button
              onClick={() => {
                setDraftBudget(guestBudgetMax);
                setDraftCustomBudget(guestCustomBudget);
                setDraftPriorities([...guestPriorityFilter]);
                setGuestFilterOpen(true);
              }}
              style={{
                flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 5,
                padding: '7px 13px', borderRadius: 20, border: 'none', cursor: 'pointer',
                fontFamily: font, fontSize: 13, fontWeight: 600, transition: 'all 0.18s',
                background: guestFiltersActive ? C.accent : C.surface,
                color: guestFiltersActive ? '#fff' : C.text,
              }}
            >
              <span style={{ fontSize: 14 }}>⚙</span>
              {t('filter_label', locale)}
              {guestFilterBadge > 0 && (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  minWidth: 18, height: 18, borderRadius: 9, fontSize: 11, fontWeight: 700,
                  background: 'rgba(255,255,255,0.3)', color: '#fff', padding: '0 4px',
                }}>{guestFilterBadge}</span>
              )}
            </button>

            {/* Sort chips */}
            {(
              [
                { key: 'default',        label: t('sort_default',       locale) },
                { key: 'price_asc',      label: t('sort_price_asc',     locale) },
                { key: 'price_desc',     label: t('sort_price_desc',    locale) },
                { key: 'priority_desc',  label: t('sort_priority_desc', locale) },
                { key: 'recommended',    label: t('sort_recommended',   locale), pro: true },
              ] as { key: GuestSort; label: string; pro?: boolean }[]
            ).map(({ key, label, pro }) => {
              const isActive = guestSort === key;
              return (
                <button
                  key={key}
                  onClick={() => {
                    if (pro && planInfo.code !== 'PRO') {
                      showUpsell('sort_recommended');
                      return;
                    }
                    setGuestSort(key);
                  }}
                  style={{
                    flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '7px 13px', borderRadius: 20, border: 'none', cursor: 'pointer',
                    fontFamily: font, fontSize: 13, fontWeight: isActive ? 700 : 500,
                    transition: 'all 0.18s',
                    background: isActive ? C.accent : C.surface,
                    color: isActive ? '#fff' : C.text,
                    opacity: pro && planInfo.code !== 'PRO' ? 0.75 : 1,
                  }}
                >
                  {label}
                  {pro && planInfo.code !== 'PRO' && <ProBadge style={{ marginLeft: 2 }} />}
                </button>
              );
            })}
          </div>

          {/* ── Main list ─────────────────────────────────────────────────── */}
          {guestMainList.length === 0 && !guestNoPriceBlock.length ? (
            <div style={{ textAlign: 'center', padding: '48px 24px' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>🔍</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginBottom: 6 }}>
                {t('guest_filter_empty', locale)}
              </div>
              {guestFiltersActive && (
                <button
                  onClick={() => { setGuestBudgetMax(null); setGuestCustomBudget(''); setGuestPriorityFilter([1, 2, 3]); }}
                  style={{ ...btnSecondary, width: 'auto', padding: '10px 20px', fontSize: 14, marginTop: 12 }}
                >
                  {t('guest_filter_reset', locale)}
                </button>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {guestMainList.map((item, i) => {
                const hasUnread = guestUnreadEntityIds.includes(item.id);
                return (
                  <div key={item.id} style={{ animation: `fadeIn 0.3s ease ${i * 0.06}s both`, position: 'relative' }}>
                    {hasUnread && (
                      <span style={{
                        position: 'absolute', top: 10, right: 10, zIndex: 2,
                        width: 8, height: 8, borderRadius: '50%', background: C.orange,
                        boxShadow: `0 0 6px ${C.orange}`,
                      }} />
                    )}
                    <WishCardGuest
                      item={item}
                      onTap={(it) => { setViewingItem(it); setScreen('guest-item-detail'); }}
                      onReserve={(w) => { setReservingItem(w); setGuestName(tgUser?.first_name ?? ''); }}
                      onUnreserve={handleUnreserve}
                      myActorHash={myActorHashRef.current}
                      locale={locale}
                    />
                  </div>
                );
              })}

              {/* ── No-price high-priority block ───────────────────────────── */}
              {guestNoPriceBlock.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div style={{
                    fontSize: 12, fontWeight: 600, color: C.textMuted,
                    marginBottom: 10, paddingLeft: 2,
                    display: 'flex', alignItems: 'center', gap: 6,
                  }}>
                    <span>😍</span>
                    {t('guest_no_price_title', locale)}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {guestNoPriceBlock.map((item, i) => (
                      <div key={item.id} style={{ animation: `fadeIn 0.3s ease ${i * 0.06}s both` }}>
                        <WishCardGuest
                          item={item}
                          onTap={(it) => { setViewingItem(it); setScreen('guest-item-detail'); }}
                          onReserve={(w) => { setReservingItem(w); setGuestName(tgUser?.first_name ?? ''); }}
                          onUnreserve={handleUnreserve}
                          myActorHash={myActorHashRef.current}
                          locale={locale}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

        </div>
      )}

      {/* ══════════════════════════════════════════════
          GUEST FILTER BOTTOM SHEET
          ══════════════════════════════════════════════ */}
      <BottomSheet
        isOpen={guestFilterOpen}
        onClose={() => setGuestFilterOpen(false)}
        title={t('filter_label', locale)}
      >
        <div style={{ padding: '0 0 16px' }}>
          {/* Budget section */}
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.textMuted, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {t('filter_budget_label', locale)}
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
              {getGuestBudgetPresets(locale).map((preset) => {
                const isActive = draftBudget === preset.max && (preset.max !== null || draftCustomBudget === '');
                return (
                  <button
                    key={preset.max ?? 'all'}
                    onClick={() => { setDraftBudget(preset.max); setDraftCustomBudget(''); }}
                    style={{
                      padding: '7px 14px', borderRadius: 20, border: 'none', cursor: 'pointer',
                      fontFamily: font, fontSize: 13, fontWeight: 600, transition: 'all 0.18s',
                      background: isActive ? C.accent : C.surface,
                      color: isActive ? '#fff' : C.text,
                    }}
                  >{preset.label}</button>
                );
              })}
            </div>
            {/* Custom budget input */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="number"
                min={1}
                step={1}
                placeholder={t('filter_custom_placeholder', locale)}
                value={draftCustomBudget}
                onChange={(e) => {
                  const raw = e.target.value.replace(/[^0-9]/g, '');
                  setDraftCustomBudget(raw);
                  const num = parseInt(raw, 10);
                  if (!isNaN(num) && num > 0) {
                    setDraftBudget(num);
                  } else if (raw === '') {
                    setDraftBudget(null);
                  }
                }}
                style={{
                  flex: 1, padding: '10px 14px', borderRadius: 12,
                  border: `1.5px solid ${draftCustomBudget ? C.accent : C.border}`,
                  background: C.surface, color: C.text,
                  fontFamily: font, fontSize: 14, outline: 'none',
                  MozAppearance: 'textfield',
                } as React.CSSProperties}
              />
              {draftCustomBudget && (
                <button
                  onClick={() => { setDraftCustomBudget(''); setDraftBudget(null); }}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.textMuted, fontSize: 20, padding: '0 4px', lineHeight: 1 }}
                >×</button>
              )}
            </div>
          </div>

          {/* Priority section */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: C.textMuted, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
              {t('filter_priority_label', locale)}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {getPriorities(locale).map((p) => {
                const isActive = draftPriorities.includes(p.value);
                return (
                  <button
                    key={p.value}
                    onClick={() => {
                      setDraftPriorities((prev) => {
                        if (isActive) {
                          // Don't deselect if it's the last one
                          if (prev.length === 1) return prev;
                          return prev.filter((v) => v !== p.value);
                        }
                        return [...prev, p.value].sort();
                      });
                    }}
                    style={{
                      flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
                      gap: 4, padding: '10px 8px', borderRadius: 12,
                      border: `2px solid ${isActive ? PRIO_COLOR[p.value] : C.border}`,
                      cursor: 'pointer', fontFamily: font, transition: 'all 0.18s',
                      background: isActive ? PRIO_BG[p.value] : C.surface,
                    }}
                  >
                    <span style={{ fontSize: 20 }}>{p.emoji}</span>
                    <span style={{ fontSize: 11, fontWeight: 600, color: isActive ? PRIO_COLOR[p.value] : C.textMuted }}>{p.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={() => {
                setDraftBudget(null); setDraftCustomBudget(''); setDraftPriorities([1, 2, 3]);
              }}
              style={{ ...btnSecondary, flex: 1, padding: '13px', fontSize: 14 }}
            >
              {t('filter_reset', locale)}
            </button>
            <button
              onClick={() => {
                setGuestBudgetMax(draftBudget);
                setGuestCustomBudget(draftCustomBudget);
                setGuestPriorityFilter(draftPriorities);
                setGuestFilterOpen(false);
              }}
              style={{ ...btnPrimary, flex: 2, padding: '13px', fontSize: 14 }}
            >
              {t('filter_apply', locale)}
            </button>
          </div>
        </div>
      </BottomSheet>

      {/* ══════════════════════════════════════════════
          ARCHIVE  (mode: 'wishlist' | 'global')
          ══════════════════════════════════════════════ */}
      {screen === 'archive' && (archiveMode === 'global' || currentWl) && (() => {
        const displayItems = archiveMode === 'global' ? globalArchiveItems : archiveItems;
        return (
          <div style={{ padding: '16px 20px 120px' }}>
            {/* ── Header ── */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h1 style={{ fontSize: 20, fontWeight: 700, fontFamily: font, color: C.text, margin: 0 }}>
                    📦 {archiveSelectMode ? t('archive_selected_n', locale, { n: archiveSelected.length }) : t('archive_title', locale)}
                  </h1>
                  {archiveMode === 'wishlist' && currentWl && !archiveSelectMode && (
                    <p style={{ fontSize: 12, color: C.textMuted, margin: '2px 0 0' }}>{currentWl.title}</p>
                  )}
                  {!archiveSelectMode && (
                    <p style={{ fontSize: 11, color: C.orange, margin: '6px 0 0' }}>{t('archive_retention', locale)}</p>
                  )}
                </div>
                {/* Right header actions */}
                <div style={{ display: 'flex', gap: 6, flexShrink: 0, marginTop: 2 }}>
                  {displayItems.length > 0 && !archiveSelectMode && (
                    <>
                      {/* Trash icon → enter select mode */}
                      <button
                        style={{ background: 'none', border: 'none', padding: '6px 8px', cursor: 'pointer', color: C.textMuted, borderRadius: 8 }}
                        onClick={() => { setArchiveSelectMode(true); setArchiveSelected([]); }}
                        title={t('archive_purge_btn', locale)}
                      >
                        🗑
                      </button>
                      {/* Select button */}
                      <button
                        style={{ ...btnGhost, padding: '6px 12px', fontSize: 13 }}
                        onClick={() => { setArchiveSelectMode(true); setArchiveSelected([]); }}
                      >
                        {t('archive_select', locale)}
                      </button>
                    </>
                  )}
                  {archiveSelectMode && (
                    <button
                      style={{ ...btnGhost, padding: '6px 12px', fontSize: 13, color: C.textMuted }}
                      onClick={() => { setArchiveSelectMode(false); setArchiveSelected([]); }}
                    >
                      {t('archive_cancel_select', locale)}
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* ── Sticky action bar in select mode ── */}
            {archiveSelectMode && (
              <div style={{
                position: 'sticky', top: 0, zIndex: 10,
                background: C.surface, borderBottom: `1px solid ${C.border}`,
                padding: '10px 0', marginBottom: 14,
                display: 'flex', gap: 8, alignItems: 'center',
              }}>
                {/* Select all / Deselect all */}
                <button
                  style={{ ...btnGhost, padding: '8px 12px', fontSize: 13, flex: 1 }}
                  onClick={() => {
                    if (archiveSelected.length === displayItems.length) {
                      setArchiveSelected([]);
                    } else {
                      setArchiveSelected(displayItems.map((i) => i.id));
                    }
                  }}
                >
                  {archiveSelected.length === displayItems.length ? t('archive_deselect_all', locale) : t('archive_select_all', locale)}
                </button>
                {/* Restore */}
                <button
                  style={{
                    ...btnPrimary, padding: '8px 12px', fontSize: 13,
                    opacity: archiveSelected.length > 0 && !archiveBulkLoading ? 1 : 0.4,
                  }}
                  disabled={archiveSelected.length === 0 || archiveBulkLoading}
                  onClick={() => void handleBulkRestore()}
                >
                  {archiveBulkLoading ? '…' : t('archive_bulk_restore_btn', locale)}
                </button>
                {/* Hard delete */}
                <button
                  style={{
                    ...btnGhost, padding: '8px 12px', fontSize: 13, color: C.red,
                    opacity: archiveSelected.length > 0 && !archiveBulkLoading ? 1 : 0.4,
                  }}
                  disabled={archiveSelected.length === 0 || archiveBulkLoading}
                  onClick={() => setShowArchiveBulkDeleteConfirm(true)}
                >
                  🗑
                </button>
                {/* Purge entire archive (only in global mode) */}
                {archiveMode === 'global' && displayItems.length > 0 && (
                  <button
                    style={{
                      ...btnGhost, padding: '8px 10px', fontSize: 12, color: C.textMuted,
                    }}
                    disabled={archiveBulkLoading}
                    onClick={() => { setArchivePurgeStep(1); setShowArchivePurgeConfirm(true); }}
                    title={t('archive_purge_btn', locale)}
                  >
                    ☠️
                  </button>
                )}
              </div>
            )}

            {/* ── Empty state ── */}
            {displayItems.length === 0 && !loading && (
              <div style={{ textAlign: 'center', padding: '48px 24px' }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>📦</div>
                <div style={{ fontSize: 15, color: C.textMuted, lineHeight: 1.5 }}>{t('archive_empty', locale)}</div>
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 8 }}>{t('archive_empty_hint', locale)}</div>
              </div>
            )}

            {/* ── Item list ── */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {displayItems.map((item, i) => {
                const isSelected = archiveSelected.includes(item.id);
                return (
                  <div
                    key={item.id}
                    style={{ animation: `fadeIn 0.3s ease ${i * 0.06}s both` }}
                    onClick={archiveSelectMode ? () => {
                      setArchiveSelected((prev) =>
                        prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id]
                      );
                    } : undefined}
                  >
                    <div style={{
                      background: archiveSelectMode && isSelected ? C.accentSoft : C.card,
                      borderRadius: 14, padding: 16,
                      display: 'flex', gap: 14, alignItems: 'flex-start',
                      border: archiveSelectMode && isSelected ? `1.5px solid ${C.accent}` : `1px solid ${C.border}`,
                      opacity: archiveSelectMode ? 1 : 0.7,
                      cursor: archiveSelectMode ? 'pointer' : 'default',
                      WebkitTapHighlightColor: 'transparent',
                      transition: 'background 0.15s, border-color 0.15s',
                    }}>
                      {/* Checkbox in select mode */}
                      {archiveSelectMode && (
                        <div style={{
                          width: 22, height: 22, borderRadius: 11, flexShrink: 0, marginTop: 2,
                          border: `2px solid ${isSelected ? C.accent : C.border}`,
                          background: isSelected ? C.accent : 'transparent',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          transition: 'background 0.15s, border-color 0.15s',
                        }}>
                          {isSelected && <span style={{ color: '#fff', fontSize: 12, lineHeight: 1 }}>✓</span>}
                        </div>
                      )}
                      {!archiveSelectMode && <ItemThumb item={item} />}
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 15, fontWeight: 600, fontFamily: font, color: C.textMuted, lineHeight: 1.3, textDecoration: 'line-through' }}>
                          {item.title}
                        </div>
                        {archiveMode === 'global' && (item as GlobalArchiveItem).wishlistTitle && (
                          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>
                            📋 {(item as GlobalArchiveItem).wishlistTitle}
                            {(item as GlobalArchiveItem).wishlistIsArchived && (
                              <span style={{ marginLeft: 4, color: C.orange, fontSize: 10 }}>📦</span>
                            )}
                          </div>
                        )}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                          {item.status === 'completed' && (
                            <span style={{ fontSize: 11, background: C.greenSoft, color: C.green, padding: '2px 8px', borderRadius: 6, fontWeight: 600 }}>{t('archive_received', locale)}</span>
                          )}
                          {item.status === 'deleted' && (
                            <span style={{ fontSize: 11, background: C.surface, color: C.textMuted, padding: '2px 8px', borderRadius: 6, fontWeight: 600 }}>{t('archive_deleted', locale)}</span>
                          )}
                          {item.price != null && <span style={{ fontSize: 13, color: C.textMuted }}>{fmtPrice(item.price, locale, item.currency ?? 'RUB')}</span>}
                        </div>
                        {/* Restore button — hidden in select mode */}
                        {!archiveSelectMode && (
                          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                            <button onClick={() => void handleRestoreItem(item)} style={{ ...btnGhost, fontSize: 12, padding: '6px 10px', color: C.accent }}>{t('archive_restore', locale)}</button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════
          PROFILE
          ══════════════════════════════════════════════ */}
      {screen === 'profile' && (
        <div style={{ padding: '16px 20px 120px', animation: 'fadeIn 0.3s ease' }}>
          {/* Header with gear icon for settings */}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: font, color: C.text, margin: 0 }}>
              {t('profile_title', locale)}
            </h1>
            <button onClick={() => { setSettingsOriginScreen(screen); loadSettings(); setScreen('settings'); }} style={{ background: 'none', border: 'none', padding: 8, cursor: 'pointer', color: C.textMuted }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>
          </div>

          {profileLoading && !profileData ? (
            <div style={{ textAlign: 'center', padding: 40, color: C.textMuted }}>{t('loading', locale)}</div>
          ) : profileData && (
            <>
              {/* ── Hero card — asymmetric left-anchored layout ── */}
              <div style={{
                background: C.card,
                borderRadius: 20,
                padding: '18px 18px 20px',
                marginBottom: 16,
                border: `1px solid ${C.borderLight}`,
              }}>
                {/* Top row: avatar (left anchor) + edit button (top-right) */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
                  {/* Avatar with camera badge */}
                  <div
                    onClick={() => setShowAvatarSheet(true)}
                    style={{
                      width: 76, height: 76, borderRadius: '50%',
                      background: `linear-gradient(135deg, ${C.accent}, ${C.accent}80)`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 30, fontWeight: 700, color: '#fff',
                      cursor: 'pointer', flexShrink: 0, position: 'relative',
                      ...(profileData.avatarUrl
                        ? { backgroundImage: `url(${profileData.avatarUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                        : {}),
                    }}>
                    {!profileData.avatarUrl && !avatarUploading && (profileData.displayName || tgUser?.first_name || '?')[0]!.toUpperCase()}
                    {avatarUploading && (
                      <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: '#fff' }}>…</div>
                    )}
                    {!avatarUploading && (
                      <div style={{ position: 'absolute', bottom: 0, right: 0, width: 24, height: 24, borderRadius: '50%', background: C.accent, display: 'flex', alignItems: 'center', justifyContent: 'center', border: `2px solid ${C.card}` }}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                      </div>
                    )}
                    {/* Seasonal hat — sits top-right, pointer-events:none (handled by SantaHatOverlay) */}
                    {santaSeason?.inSeason && <SantaHatOverlay size={76} />}
                  </div>

                  {/* Edit icon button — top-right of card */}
                  <button
                    onClick={() => {
                      setEditProfileName(profileData.displayName || '');
                      setEditProfileUsername(profileData.username || '');
                      setEditProfileBio(profileData.bio?.replace(/\n+$/, '') || '');
                      setEditProfileBirthday(profileData.birthday ? profileData.birthday.slice(0, 10) : '');
                      setEditingProfile(true);
                    }}
                    style={{
                      background: C.surface, border: 'none',
                      width: 34, height: 34, borderRadius: 10,
                      cursor: 'pointer', flexShrink: 0,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      color: C.textMuted,
                    }}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                  </button>
                </div>

                {/* Identity — left-aligned column */}
                <div style={{ fontSize: 21, fontWeight: 800, color: C.text, fontFamily: font, lineHeight: 1.15, letterSpacing: -0.3 }}>
                  {profileData.displayName || tgUser?.first_name || t('profile_display_name', locale)}
                </div>

                {/* Username + plan badge on one row */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 5, flexWrap: 'wrap' }}>
                  {profileData.username && (
                    <span style={{ fontSize: 13, color: C.textMuted, fontWeight: 500 }}>@{profileData.username}</span>
                  )}
                  <span style={{
                    fontSize: 10, fontWeight: 800, letterSpacing: 0.7, padding: '3px 8px',
                    borderRadius: 6, lineHeight: 1.4,
                    background: planInfo.code === 'PRO'
                      ? `linear-gradient(135deg, ${C.accent}28, ${C.accent}14)`
                      : C.surface,
                    border: `1px solid ${planInfo.code === 'PRO' ? C.accent + '45' : C.borderLight}`,
                    color: planInfo.code === 'PRO' ? C.accent : C.textSec,
                  }}>
                    {planInfo.code}
                  </span>
                </div>

                {/* Bio — only if present, no top margin if absent */}
                {profileData.bio && (
                  <div style={{ fontSize: 13, color: C.textSec, marginTop: 10, lineHeight: 1.55 }}>
                    {profileData.bio}
                  </div>
                )}
              </div>

              {/* Stats card */}
              {profileStats && (
                <div style={{ background: C.card, borderRadius: 16, padding: 16, marginBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.textSec, marginBottom: 12 }}>
                    {t('profile_stats_title', locale)}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                    <div onClick={() => setScreen('my-wishlists')} style={{ cursor: 'pointer', background: C.surface, borderRadius: 12, padding: 12 }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: C.accent, fontFamily: font }}>
                        {profileStats.wishlists}
                      </div>
                      <div style={{ fontSize: 11, color: C.textMuted }}>
                        {t('profile_wishlists_of', locale, { count: profileStats.wishlists, max: profileStats.wishlistsLimit })}
                      </div>
                    </div>
                    <div onClick={() => { setHomeTab('wishes'); void loadAllItems(); setScreen('my-wishlists'); }} style={{ cursor: 'pointer', background: C.surface, borderRadius: 12, padding: 12 }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: C.accent, fontFamily: font }}>
                        {profileStats.totalWishes}
                      </div>
                      <div style={{ fontSize: 11, color: C.textMuted }}>{t('profile_wishes_total', locale)}</div>
                    </div>
                    <div onClick={() => setScreen('my-reservations')} style={{ cursor: 'pointer', background: C.surface, borderRadius: 12, padding: 12 }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: C.green, fontFamily: font }}>
                        {profileStats.reservedByMe}
                      </div>
                      <div style={{ fontSize: 11, color: C.textMuted }}>{t('profile_reserved_by_me', locale)}</div>
                    </div>
                    <div onClick={() => { void loadGlobalArchive(); }} style={{ cursor: 'pointer', background: C.surface, borderRadius: 12, padding: 12 }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: C.orange, fontFamily: font }}>
                        {profileStats.archived}
                      </div>
                      <div style={{ fontSize: 11, color: C.textMuted }}>{t('profile_archived', locale)}</div>
                    </div>
                  </div>
                </div>
              )}

              {/* My Plan card — FREE: two semantic blocks; PRO: feature table */}
              {planInfo.code === 'FREE' ? (
                <>
                  {/* FREE — current plan block */}
                  <div style={{ marginBottom: 12 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.textSec, marginBottom: 8 }}>
                      {t('settings_your_plan', locale)}
                    </div>
                    <div style={{ background: C.card, borderRadius: 16, padding: 16, border: `1px solid ${C.border}` }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                        <span style={{ fontSize: 15, fontWeight: 700, color: C.text, fontFamily: font }}>Free</span>
                        <span style={{ fontSize: 12, color: C.textMuted }}>{t('settings_free_subtitle', locale)}</span>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                        {[t('plan_free_f1', locale), t('plan_free_f2', locale), t('plan_free_f3', locale)].map((f, i) => (
                          <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 14, color: C.textSec, lineHeight: 1.4 }}>
                            <span style={{ color: C.textMuted, flexShrink: 0 }}>–</span>
                            {f}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* FREE — Pro unlock block */}
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.textSec, marginBottom: 8 }}>
                      {t('settings_pro_unlock_title', locale)}
                    </div>
                    <div style={{
                      background: `linear-gradient(145deg, ${C.card}, ${C.accent}08)`,
                      borderRadius: 16, padding: 16,
                      border: `1px solid ${C.accent}25`,
                    }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                        {getProBenefits(locale).map((b, i) => (
                          <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                            <span style={{
                              width: 22, height: 22, borderRadius: 11, flexShrink: 0, marginTop: 1,
                              background: C.accentSoft, color: C.accent,
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 11, fontWeight: 800,
                            }}>✓</span>
                            <div>
                              <div style={{ fontSize: 14, fontWeight: 600, color: C.text, lineHeight: 1.3 }}>{b.title}</div>
                              <div style={{ fontSize: 12, color: C.textMuted, marginTop: 1, lineHeight: 1.4 }}>{b.subtitle}</div>
                            </div>
                          </div>
                        ))}
                      </div>
                      <div style={{ paddingTop: 14, borderTop: `1px solid ${C.accent}20`, marginBottom: 14 }}>
                        <span style={{ fontSize: 22, fontWeight: 800, color: C.text }}>100</span>
                        {' '}
                        <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>Stars</span>
                        <span style={{ fontSize: 13, color: C.textSec }}> {t('upsell_per_month', locale)}</span>
                      </div>
                      <button
                        style={{ ...btnPrimary, width: '100%', background: `linear-gradient(135deg, ${C.accent}, #6B5CE7)` }}
                        onClick={() => showUpsell('wishlist_limit')}
                      >
                        {t('connect_pro', locale)}
                      </button>
                      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 8, textAlign: 'center' }}>
                        {t('upsell_auto_renew', locale)}
                      </div>
                    </div>
                  </div>

                  {/* One-time upgrades block — shown when availableSkus populated */}
                  {availableSkus.length > 0 && (() => {
                    const planScreenSkus = ['extra_wishlist_slot', 'extra_items_5', 'extra_items_15', 'extra_subscription_slot']
                      .map(code => availableSkus.find(s => s.code === code))
                      .filter((s): s is SkuInfo => s !== undefined);
                    if (planScreenSkus.length === 0) return null;
                    const offers = getAddonOffers(locale);
                    const isLoading = addonCheckoutLoading || checkoutLoading;
                    return (
                      <div style={{ marginBottom: 16 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: C.textSec, marginBottom: 8 }}>
                          {t('addon_section_header', locale)}
                        </div>
                        <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>
                          {t('addon_section_hint', locale)}
                        </div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {planScreenSkus.map(sku => {
                            const offer = offers[sku.code];
                            if (!offer) return null;
                            // item-slot SKUs require a target wishlist — skip if no wishlists yet
                            if ((sku.code === 'extra_items_5' || sku.code === 'extra_items_15') && wishlists.length === 0) return null;
                            const isCapped = cappedAddonCodes.includes(sku.code);
                            return (
                              <div
                                key={sku.code}
                                style={{
                                  display: 'flex', alignItems: 'center', gap: 12,
                                  background: isCapped ? C.surface : C.card,
                                  borderRadius: 14, padding: '12px 14px',
                                  border: `1px solid ${isCapped ? C.borderLight : C.border}`,
                                  opacity: isCapped ? 0.7 : 1,
                                }}
                              >
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <div style={{ fontSize: 14, fontWeight: 700, color: isCapped ? C.textSec : C.text, lineHeight: 1.3 }}>
                                    {offer.title}
                                  </div>
                                  <div style={{ fontSize: 12, color: C.textMuted, marginTop: 3, lineHeight: 1.4 }}>
                                    {isCapped ? t('addon_cap_reached_sub', locale) : offer.tag}
                                  </div>
                                </div>
                                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
                                  {isCapped ? (
                                    <div style={{
                                      fontSize: 12, fontWeight: 600, color: C.textSec,
                                      background: C.card, border: `1px solid ${C.border}`,
                                      borderRadius: 8, padding: '5px 10px', whiteSpace: 'nowrap',
                                    }}>
                                      {t('addon_cap_reached', locale)}
                                    </div>
                                  ) : (
                                    <>
                                      <div style={{ fontSize: 12, fontWeight: 700, color: C.textSec, whiteSpace: 'nowrap' }}>
                                        {sku.price} ⭐
                                      </div>
                                      <button
                                        onClick={() => {
                                          const needsTarget = sku.code === 'extra_items_5' || sku.code === 'extra_items_15';
                                          if (needsTarget) {
                                            if (wishlists.length === 1 && wishlists[0]) {
                                              void handleBuyAddon(sku.code, wishlists[0].id);
                                            } else {
                                              setWishlistPickerSku(sku.code);
                                            }
                                          } else {
                                            void handleBuyAddon(sku.code, undefined);
                                          }
                                        }}
                                        disabled={isLoading}
                                        style={{
                                          background: isLoading ? C.surface : C.accentSoft,
                                          color: C.accent,
                                          border: `1px solid ${C.accent}40`,
                                          borderRadius: 8, padding: '5px 12px',
                                          fontSize: 13, fontWeight: 700,
                                          cursor: isLoading ? 'default' : 'pointer',
                                          fontFamily: font, whiteSpace: 'nowrap',
                                          opacity: isLoading ? 0.5 : 1,
                                          transition: 'opacity 0.15s',
                                        }}
                                      >
                                        {addonCheckoutLoading ? '…' : t('addon_cta_buy', locale)}
                                      </button>
                                    </>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}
                </>
              ) : (
                /* PRO — feature table + subscription info + cancel/resume */
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.textSec, marginBottom: 8 }}>
                    {t('profile_plan_title', locale)}
                  </div>
                  <div style={{
                    background: `linear-gradient(145deg, ${C.card}, ${C.accent}08)`,
                    borderRadius: 16, padding: 20,
                    border: `1px solid ${C.accent}25`,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                      <span style={{ fontSize: 15, fontWeight: 600, color: C.textSec, fontFamily: font }}>{t('settings_plan', locale)}</span>
                      <span style={{
                        fontSize: 12, fontWeight: 800, letterSpacing: 0.5, padding: '4px 10px', borderRadius: 6,
                        background: `linear-gradient(135deg, ${C.accent}22, ${C.accent}12)`,
                        border: `1px solid ${C.accent}30`, color: C.accent,
                      }}>PRO</span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {[
                        { label: t('settings_wishlists', locale), value: t('settings_up_to', locale, { n: planInfo.wishlists }), desc: t('settings_desc_wishlists', locale) },
                        { label: t('settings_wishes_each', locale), value: t('settings_up_to', locale, { n: planInfo.items }), desc: t('settings_desc_wishes', locale) },
                        { label: t('settings_participants', locale), value: t('settings_up_to', locale, { n: planInfo.participants }), desc: t('settings_desc_participants', locale) },
                      ].map((row) => (
                        <div key={row.label}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 14, color: C.textSec }}>{row.label}</span>
                            <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{row.value}</span>
                          </div>
                          <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{row.desc}</div>
                        </div>
                      ))}
                      {[
                        { label: t('settings_comments', locale), desc: t('settings_desc_comments', locale) },
                        { label: t('settings_url_import', locale), desc: t('settings_desc_url_import', locale) },
                        { label: t('settings_hints', locale), desc: t('settings_desc_hints', locale) },
                        { label: t('settings_subscriptions', locale), desc: t('settings_desc_subscriptions', locale) },
                        { label: t('settings_privacy_pro', locale), desc: t('settings_desc_privacy_pro', locale) },
                      ].map((row) => (
                        <div key={row.label}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontSize: 14, color: C.textSec }}>{row.label}</span>
                            <span style={{ fontSize: 13, color: C.green, fontWeight: 600 }}>✓</span>
                          </div>
                          <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{row.desc}</div>
                        </div>
                      ))}
                    </div>

                    {/* Subscription info — ACTIVE_RENEWING */}
                    {subscription && !subscription.cancelAtPeriodEnd && subscription.status !== 'CANCELLED' && (
                      <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 13, color: C.textSec }}>{t('settings_next_renewal', locale)}</span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
                            {new Date(subscription.periodEnd).toLocaleDateString(locale === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'long' })}
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Subscription info — ACTIVE_CANCELLED */}
                    {subscription && (subscription.cancelAtPeriodEnd || subscription.status === 'CANCELLED') && (
                      <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '10px 14px', borderRadius: 10,
                          background: C.orangeSoft, fontSize: 13, color: C.orange, lineHeight: 1.4,
                        }}>
                          <span>⏳</span>
                          <span>
                            {t('settings_renewal_disabled', locale)}{' '}
                            <strong>{new Date(subscription.periodEnd).toLocaleDateString(locale === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'long' })}</strong>.
                          </span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Plan action buttons */}
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {subscription && !subscription.cancelAtPeriodEnd && subscription.status !== 'CANCELLED' && (
                      <button
                        style={{ ...btnSecondary, width: '100%', fontSize: 14 }}
                        onClick={() => setShowCancelSub(true)}
                      >
                        {t('settings_cancel_renewal', locale)}
                      </button>
                    )}
                    {subscription && (subscription.cancelAtPeriodEnd || subscription.status === 'CANCELLED') && (
                      <button
                        style={{ ...btnPrimary, width: '100%', background: `linear-gradient(135deg, ${C.accent}, #6B5CE7)` }}
                        onClick={() => void handleReactivateSub()}
                        disabled={cancelSubLoading}
                      >
                        {cancelSubLoading ? t('settings_resuming', locale) : t('settings_resume_sub', locale)}
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Public Profile section */}
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.textSec, marginBottom: 8 }}>
                  {t('profile_public_title', locale)}
                </div>
                <div style={{ background: C.card, borderRadius: 16, padding: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: `1px solid ${C.border}` }}>
                    <span style={{ fontSize: 14, color: C.text }}>{t('profile_birthday', locale)}</span>
                    <span style={{ fontSize: 14, color: profileData.birthday ? C.text : C.textMuted }}>
                      {profileData.birthday ? new Date(profileData.birthday).toLocaleDateString(locale === 'ru' ? 'ru-RU' : 'en-US', {
                        day: 'numeric', month: 'long', ...(profileData.hideYear ? {} : { year: 'numeric' })
                      }) : '\u2014'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: `1px solid ${C.border}` }}>
                    <span style={{ fontSize: 14, color: C.text }}>{t('profile_hide_year', locale)}</span>
                    <button
                      onClick={async () => {
                        try {
                          const res = await tgFetch('/tg/me/profile', {
                            method: 'PATCH',
                            body: JSON.stringify({ hideYear: !profileData.hideYear }),
                          });
                          if (res.ok) {
                            setProfileData(prev => prev ? { ...prev, hideYear: !prev.hideYear } : prev);
                          }
                        } catch { /* silent */ }
                      }}
                      style={{
                        width: 50, height: 28, borderRadius: 14, border: 'none', cursor: 'pointer',
                        background: profileData.hideYear ? C.accent : C.surface,
                        position: 'relative', transition: 'background 0.2s',
                      }}
                    >
                      <div style={{
                        width: 22, height: 22, borderRadius: 11,
                        background: '#fff', position: 'absolute', top: 3,
                        left: profileData.hideYear ? 25 : 3,
                        transition: 'left 0.2s',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                      }} />
                    </button>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0' }}>
                    <div>
                      <div style={{ fontSize: 14, color: C.text }}>{t('profile_avatar_public', locale)}</div>
                      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{t('profile_avatar_public_hint', locale)}</div>
                    </div>
                    <button
                      onClick={async () => {
                        const next = !profileData.avatarPublic;
                        setProfileData(prev => prev ? { ...prev, avatarPublic: next } : prev);
                        try {
                          await tgFetch('/tg/me/profile', {
                            method: 'PATCH',
                            body: JSON.stringify({ avatarPublic: next }),
                          });
                        } catch {
                          // Revert on error
                          setProfileData(prev => prev ? { ...prev, avatarPublic: !next } : prev);
                        }
                      }}
                      style={{
                        width: 50, height: 28, borderRadius: 14, border: 'none', cursor: 'pointer',
                        background: profileData.avatarPublic ? C.accent : C.surface,
                        position: 'relative', transition: 'background 0.2s', flexShrink: 0, marginLeft: 12,
                      }}
                    >
                      <div style={{
                        width: 22, height: 22, borderRadius: 11,
                        background: '#fff', position: 'absolute', top: 3,
                        left: profileData.avatarPublic ? 25 : 3,
                        transition: 'left 0.2s',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                      }} />
                    </button>
                  </div>
                </div>
              </div>

              {/* God mode toggle — dev only, moved from settings */}
              {canGodMode && (
                <div style={{
                  marginBottom: 16, padding: 16, borderRadius: 12,
                  background: godMode ? '#ff990015' : C.card,
                  border: `1px dashed ${godMode ? '#ff9900' : C.border}`,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <div style={{ fontSize: 14, fontWeight: 700, color: godMode ? '#ff9900' : C.textSec, fontFamily: font }}>
                        {t('settings_god_mode', locale)}
                      </div>
                      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                        {godMode ? t('settings_god_active', locale) : t('settings_god_inactive', locale)}
                      </div>
                    </div>
                    <button
                      onClick={async () => {
                        if (godModeLoading) return;
                        setGodModeLoading(true);
                        try {
                          const res = await tgFetch('/tg/me/god-mode', { method: 'POST' });
                          if (res.ok) {
                            const data = await res.json() as { godMode: boolean };
                            setGodMode(data.godMode);
                            try { tgRef.current?.WebApp?.HapticFeedback?.impactOccurred?.('medium'); } catch {}
                            loadWishlists().catch(() => {});
                            loadSantaSeason().catch(() => {});
                          } else {
                            pushToast(t('toast_god_toggle_error', locale), 'error');
                          }
                        } catch {
                          pushToast(t('error_network', locale), 'error');
                        } finally {
                          setGodModeLoading(false);
                        }
                      }}
                      disabled={godModeLoading}
                      style={{
                        width: 50, height: 28, borderRadius: 14, border: 'none', cursor: 'pointer',
                        background: godMode ? '#ff9900' : C.surface,
                        position: 'relative', transition: 'background 0.2s',
                        opacity: godModeLoading ? 0.5 : 1,
                      }}
                    >
                      <div style={{
                        width: 22, height: 22, borderRadius: 11,
                        background: '#fff', position: 'absolute', top: 3,
                        left: godMode ? 25 : 3,
                        transition: 'left 0.2s',
                        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                      }} />
                    </button>
                  </div>

                  {/* Santa test mode — visible only when godMode is active */}
                  {godMode && (
                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#cc0000', fontFamily: font }}>🎅 Santa test mode</div>
                          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                            {santaSeason?.testMode ? 'Secret Santa block visible' : 'Secret Santa block hidden'}
                          </div>
                        </div>
                        <button
                          onClick={async () => {
                            if (santaTestModeLoading) return;
                            setSantaTestModeLoading(true);
                            try {
                              const res = await tgFetch('/tg/santa/season/test-mode', { method: 'POST' });
                              if (res.ok) {
                                try { tgRef.current?.WebApp?.HapticFeedback?.impactOccurred?.('light'); } catch {}
                                await loadSantaSeason();
                              } else {
                                pushToast('Failed to toggle santa test mode', 'error');
                              }
                            } catch {
                              pushToast(t('error_network', locale), 'error');
                            } finally {
                              setSantaTestModeLoading(false);
                            }
                          }}
                          disabled={santaTestModeLoading}
                          style={{
                            width: 50, height: 28, borderRadius: 14, border: 'none', cursor: 'pointer',
                            background: santaSeason?.testMode ? '#cc0000' : C.surface,
                            position: 'relative', transition: 'background 0.2s',
                            opacity: santaTestModeLoading ? 0.5 : 1,
                          }}
                        >
                          <div style={{
                            width: 22, height: 22, borderRadius: 11,
                            background: '#fff', position: 'absolute', top: 3,
                            left: santaSeason?.testMode ? 25 : 3,
                            transition: 'left 0.2s',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                          }} />
                        </button>
                      </div>
                    </div>
                  )}

                  {/* ─── Analytics block — only when godMode active ─── */}
                  {godMode && (() => {
                    const pct = (n: number, total: number) =>
                      total > 0 ? Math.round((n / total) * 100) : 0;

                    const fmt1 = (n: number) =>
                      n === 0 ? '—' : Number.isFinite(n) ? n.toFixed(1) : '—';

                    const relativeTime = (d: Date | null): string => {
                      if (!d) return '';
                      const sec = Math.round((Date.now() - d.getTime()) / 1000);
                      if (sec < 10) return 'только что';
                      if (sec < 60) return `${sec} сек назад`;
                      const min = Math.round(sec / 60);
                      if (min < 60) return `${min} мин назад`;
                      return d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
                    };

                    // Funnel = уникальные пользователи
                    const funnelSteps = godStats ? [
                      { label: 'Все пользователи',                    value: godStats.funnel.totalUsers },
                      { label: 'Создали хотя бы один вишлист',        value: godStats.funnel.usersWithWishlist },
                      { label: 'Создали хотя бы одно желание',        value: godStats.funnel.usersWithItem },
                      { label: 'Перешли хотя бы по одной ссылке',    value: godStats.funnel.usersWithLinkOpen ?? godStats.funnel.usersWhoInitiatedShare },
                      { label: 'Забронировали хотя бы один подарок', value: godStats.funnel.usersWithReservation },
                    ] : [];

                    return (
                      <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
                        {/* Header row */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                          <div style={{ fontSize: 12, fontWeight: 700, color: '#ff9900', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                            📊 Аналитика
                          </div>
                          <button
                            onClick={() => void loadGodStats()}
                            disabled={godStatsLoading}
                            style={{
                              background: 'none', border: 'none', cursor: godStatsLoading ? 'wait' : 'pointer',
                              fontSize: 11, color: C.textMuted, padding: '2px 6px', borderRadius: 6,
                              opacity: godStatsLoading ? 0.4 : 1, fontFamily: font,
                              display: 'flex', alignItems: 'center', gap: 4,
                            }}
                          >
                            <span style={{ display: 'inline-block', animation: godStatsLoading ? 'spin 1s linear infinite' : 'none' }}>↻</span>
                            {godStatsLoading ? 'Загружаю…' : 'Обновить'}
                          </button>
                        </div>

                        {/* Error — non-destructive: shown above existing data */}
                        {godStatsError && !godStatsLoading && (
                          <div style={{ fontSize: 11, color: C.red, padding: '4px 0 6px', display: 'flex', alignItems: 'center', gap: 4 }}>
                            ⚠ Ошибка обновления{godStats ? ' — показаны старые данные' : ''}
                          </div>
                        )}

                        {/* First load spinner — only when no data yet */}
                        {godStatsLoading && !godStats && (
                          <div style={{ fontSize: 12, color: C.textMuted, textAlign: 'center', padding: '8px 0' }}>
                            Загружаю…
                          </div>
                        )}

                        {godStats && (() => {
                          const o = godStats.overview;
                          const e = godStats.engagement;
                          const pro = godStats.proLimits24h;
                          const overviewRows: [string, string | number, string, string | number][] = [
                            ['Пользователей', o.totalUsers,        'Новых 24ч',     o.newUsers24h],
                            ['Новых 7д',      o.newUsers7d,        'Активных 7д',   o.activeUsers7d],
                            ['Активных 30д',  o.activeUsers30d,    'PRO',           o.proUsers],
                            ['Вишлистов',     o.totalWishlists,    'Желаний',       o.totalItems],
                            ['Броней',        o.totalReservations, 'PRO %',         `${pct(o.proUsers, o.totalUsers)}%`],
                          ];
                          const avgItemsPerWl = fmt1(o.totalWishlists > 0 ? o.totalItems / o.totalWishlists : 0);
                          const avgWlPerUser  = fmt1(godStats.funnel.usersWithWishlist > 0 ? o.totalWishlists / godStats.funnel.usersWithWishlist : 0);

                          return (
                            <>
                              {/* ── Обзор ── */}
                              <div style={{ marginBottom: 10 }}>
                                <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>
                                  Обзор
                                </div>
                                {overviewRows.map(([lA, vA, lB, vB], i) => (
                                  <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', marginBottom: 4 }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', paddingRight: 10 }}>
                                      <span style={{ fontSize: 12, color: C.textMuted }}>{lA}</span>
                                      <span style={{ fontSize: 12, fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{vA}</span>
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', paddingLeft: 10, borderLeft: `1px solid ${C.border}` }}>
                                      <span style={{ fontSize: 12, color: C.textMuted }}>{lB}</span>
                                      <span style={{ fontSize: 12, fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{vB}</span>
                                    </div>
                                  </div>
                                ))}
                                <div style={{ fontSize: 10, color: C.textMuted, marginTop: 5, lineHeight: 1.6 }}>
                                  желаний/вишлист <span style={{ color: C.textSec, fontWeight: 600 }}>{avgItemsPerWl}</span>
                                  {' · '}
                                  вишлистов/польз. <span style={{ color: C.textSec, fontWeight: 600 }}>{avgWlPerUser}</span>
                                </div>
                              </div>

                              {/* ── Воронка · уникальные пользователи ── */}
                              <div style={{ marginBottom: 10 }}>
                                <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 6 }}>
                                  Воронка · % от всех пользователей
                                </div>
                                {funnelSteps.map((step, i) => {
                                  const p = pct(step.value, godStats.funnel.totalUsers);
                                  const isFirst = i === 0;
                                  return (
                                    <div key={i} style={{ marginBottom: 6 }}>
                                      {/* label on its own line, value right-aligned — prevents overlap on long RU text */}
                                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 2, gap: 8 }}>
                                        <span style={{ fontSize: 10, color: C.textSec, lineHeight: 1.4, flex: 1 }}>{step.label}</span>
                                        <span style={{ fontSize: 11, color: C.text, fontVariantNumeric: 'tabular-nums', flexShrink: 0, whiteSpace: 'nowrap' }}>
                                          {step.value}
                                          {!isFirst && <span style={{ color: C.textMuted, marginLeft: 4 }}>{p}%</span>}
                                        </span>
                                      </div>
                                      <div style={{ height: 4, borderRadius: 2, background: C.border, overflow: 'hidden' }}>
                                        <div style={{
                                          height: '100%', borderRadius: 2,
                                          width: `${isFirst ? 100 : p}%`,
                                          background: isFirst ? '#ff9900' : C.accent,
                                          transition: 'width 0.4s ease',
                                        }} />
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>

                              {/* ── Детали (expandable) ── */}
                              <div style={{ marginBottom: 8 }}>
                                <button
                                  onClick={() => setGodStatsDetailsOpen(v => !v)}
                                  style={{
                                    background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                                    fontSize: 10, fontWeight: 700, color: C.textMuted,
                                    letterSpacing: '0.08em', textTransform: 'uppercase', fontFamily: font,
                                    display: 'flex', alignItems: 'center', gap: 4,
                                  }}
                                >
                                  {godStatsDetailsOpen ? '▾' : '▸'} Детали
                                </button>
                                {godStatsDetailsOpen && (
                                  <div style={{ marginTop: 6 }}>
                                    {/* Engagement totals */}
                                    {([
                                      ['Комментариев', e.totalComments],
                                      ['Подписок',     e.totalWishlistSubs],
                                    ] as [string, number][]).map(([lbl, val]) => (
                                      <div key={lbl} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                                        <span style={{ fontSize: 11, color: C.textMuted }}>{lbl}</span>
                                        <span style={{ fontSize: 11, fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{val}</span>
                                      </div>
                                    ))}

                                    {/* Шаринг */}
                                    <div style={{ marginTop: 6, paddingTop: 5, borderTop: `1px solid ${C.border}` }}>
                                      <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4 }}>
                                        Шаринг
                                      </div>
                                      {([
                                        ['Перешли по ссылке на вишлист', godStats.funnel.usersWithLinkOpen ?? godStats.funnel.usersWhoInitiatedShare],
                                        ['Переходов по ссылке',          godStats.funnel.sharedLinkOpens],
                                        ['Открыли чужой вишлист',        godStats.funnel.wishlistsWithLinkOpen],
                                      ] as [string, number][]).map(([lbl, val]) => (
                                        <div key={lbl} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                                          <span style={{ fontSize: 11, color: C.textMuted }}>{lbl}</span>
                                          <span style={{ fontSize: 11, fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{val}</span>
                                        </div>
                                      ))}
                                    </div>

                                    {/* Ошибки за 24ч */}
                                    {godStats.errors24h && (() => {
                                      const errs = godStats.errors24h!;
                                      return (
                                        <div style={{ marginTop: 6, paddingTop: 5, borderTop: `1px solid ${C.border}` }}>
                                          <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4 }}>
                                            Ошибки за 24 часа
                                          </div>
                                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                                            <span style={{ fontSize: 11, color: C.textMuted }}>Всего ошибок</span>
                                            <span style={{ fontSize: 11, fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{errs.total}</span>
                                          </div>
                                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: errs.total > 0 ? 5 : 0 }}>
                                            <span style={{ fontSize: 11, color: C.textMuted }}>Пользователей затронуто</span>
                                            <span style={{ fontSize: 11, fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{errs.affectedUsers}</span>
                                          </div>
                                          {errs.total === 0 ? (
                                            <div style={{ fontSize: 10, color: C.textMuted, marginTop: 3 }}>Ошибок за последние 24 часа не было</div>
                                          ) : (
                                            errs.top.map((err, i) => (
                                              <div key={i} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                                                <span style={{ fontSize: 10, color: C.textMuted, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                                  {err.method} {err.route} · {err.status}
                                                </span>
                                                <span style={{ fontSize: 10, color: C.textSec, fontVariantNumeric: 'tabular-nums', flexShrink: 0, marginLeft: 6 }}>{err.count}</span>
                                              </div>
                                            ))
                                          )}
                                        </div>
                                      );
                                    })()}

                                    {/* PRO ограничения за 24ч */}
                                    {pro && (
                                      <div style={{ marginTop: 6, paddingTop: 5, borderTop: `1px solid ${C.border}` }}>
                                        <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4 }}>
                                          Ограничения PRO за 24 часа
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                                          <span style={{ fontSize: 11, color: C.textMuted }}>Срабатываний ограничений</span>
                                          <span style={{ fontSize: 11, fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{pro.totalHits}</span>
                                        </div>
                                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 5 }}>
                                          <span style={{ fontSize: 11, color: C.textMuted }}>Столкнулись с ограничениями</span>
                                          <span style={{ fontSize: 11, fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{pro.uniqueUsers}</span>
                                        </div>
                                        {([
                                          ['Импорт по ссылке недоступен', pro.byType.urlImport],
                                          ['Подсказки недоступны',        pro.byType.hints],
                                          ['Комментарии недоступны',      pro.byType.comments],
                                          ['Лимит по вишлистам',          pro.byType.wishlistLimit],
                                          ['Лимит по желаниям',           pro.byType.itemLimit],
                                        ] as [string, number][]).filter(([, v]) => v > 0).map(([lbl, val]) => (
                                          <div key={lbl} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                                            <span style={{ fontSize: 10, color: C.textMuted }}>↳ {lbl}</span>
                                            <span style={{ fontSize: 10, color: C.textSec, fontVariantNumeric: 'tabular-nums' }}>{val}</span>
                                          </div>
                                        ))}
                                      </div>
                                    )}

                                    {/* Онбординг hello_activation (30д) */}
                                    {godStats.onboarding?.hello_activation && (() => {
                                      const ob = godStats.onboarding.hello_activation;
                                      return (
                                        <div style={{ marginTop: 6, paddingTop: 5, borderTop: `1px solid ${C.border}` }}>
                                          <div style={{ fontSize: 10, fontWeight: 700, color: C.textMuted, letterSpacing: '0.06em', textTransform: 'uppercase', marginBottom: 4 }}>
                                            Онбординг hello_activation (30д)
                                          </div>
                                          {([
                                            ['Запустили (wildberries)',    ob.wildberries],
                                            ['Запустили (goldapple)',      ob.goldapple],
                                            ['Запустили (ozon)',           ob.ozon],
                                            ['Запустили (yandex_market)', ob.yandex_market],
                                            ['Завершили онбординг',        ob.completed],
                                          ] as [string, number][]).map(([lbl, val]) => (
                                            <div key={lbl} style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                                              <span style={{ fontSize: 11, color: C.textMuted }}>{lbl}</span>
                                              <span style={{ fontSize: 11, fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{val}</span>
                                            </div>
                                          ))}
                                        </div>
                                      );
                                    })()}

                                    {/* Пояснения */}
                                    <div style={{ fontSize: 10, color: C.textMuted, marginTop: 8, lineHeight: 1.6, paddingTop: 5, borderTop: `1px solid ${C.border}` }}>
                                      <div>Активность = создали или обновили вишлист или желание</div>
                                      <div>Переход по ссылке = открыли вишлист, которым поделились</div>
                                      <div>Забронировали = создали бронь в чужом вишлисте</div>
                                    </div>
                                  </div>
                                )}
                              </div>

                              {/* Timestamp */}
                              <div style={{ fontSize: 10, color: C.textMuted, textAlign: 'right', lineHeight: 1.4 }}>
                                {godStatsRefreshedAt
                                  ? <>Обновлено {relativeTime(godStatsRefreshedAt)} · {godStatsRefreshedAt.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</>
                                  : new Date(godStats.generatedAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
                                }
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    );
                  })()}
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════
          SETTINGS
          ══════════════════════════════════════════════ */}
      {screen === 'settings' && (() => {
        const SettingsSection = ({ title, children }: { title: string; children: React.ReactNode }) => (
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, marginBottom: 8, textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>{title}</div>
            <div style={{
              background: santaSeason?.inSeason
                ? `linear-gradient(to bottom, rgba(160,210,240,.09) 0%, transparent 10px), ${C.card}`
                : C.card,
              borderRadius: 16, padding: '4px 16px',
              ...(santaSeason?.inSeason ? { borderTop: '1px solid rgba(180,220,245,.18)' } : {}),
            }}>{children}</div>
          </div>
        );

        const SettingsRow = ({ label, value, hint, onClick, proBadge }: { label: string; value: string; hint?: string; onClick?: () => void; proBadge?: boolean }) => (
          <div onClick={onClick} style={{ padding: '12px 0', borderBottom: `1px solid ${C.border}`, cursor: onClick ? 'pointer' : 'default' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, flex: 1, minWidth: 0 }}>
                <span style={{ fontSize: 14, color: C.text }}>{label}</span>
                {proBadge && <ProBadge />}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, paddingTop: 1 }}>
                <span style={{ fontSize: 14, color: C.textMuted, textAlign: 'right' }}>{value}</span>
                {onClick && <span style={{ fontSize: 18, color: C.textMuted, lineHeight: 1 }}>›</span>}
              </div>
            </div>
            {hint && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>{hint}</div>}
          </div>
        );

        const SettingsToggle = ({ label, value, disabled, proBadge, onChange }: {
          label: string; value: boolean; disabled?: boolean; proBadge?: boolean; onChange: (v: boolean) => void;
        }) => (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: `1px solid ${C.border}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 14, color: disabled ? C.textMuted : C.text }}>{label}</span>
              {proBadge && <ProBadge />}
            </div>
            <button
              onClick={() => onChange(!value)}
              disabled={disabled && !proBadge}
              style={{
                width: 50, height: 28, borderRadius: 14, border: 'none', cursor: disabled ? 'default' : 'pointer',
                // When disabled: show actual value but muted (ON=muted accent, OFF=muted surface)
                // so users can see the real effective state even when they can't edit it
                background: value
                  ? (disabled ? C.accent + '99' : C.accent)
                  : C.surface,
                position: 'relative', transition: 'background 0.2s',
              }}
            >
              <div style={{
                width: 22, height: 22, borderRadius: 11,
                background: disabled ? 'rgba(255,255,255,0.7)' : '#fff',
                position: 'absolute', top: 3,
                left: value ? 25 : 3,
                transition: 'left 0.2s',
                boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
              }} />
            </button>
          </div>
        );

        const SettingsActionRow = ({ label, color, onClick }: { label: string; color?: string; onClick: () => void }) => (
          <div
            onClick={onClick}
            onPointerDown={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.45'; }}
            onPointerUp={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
            onPointerLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderBottom: `1px solid ${C.border}`, cursor: 'pointer', transition: 'opacity 0.12s' }}
          >
            <span style={{ fontSize: 14, color: color || C.text }}>{label}</span>
            <span style={{ fontSize: 14, color: C.textMuted }}>{'\u203A'}</span>
          </div>
        );

        return (
        <div style={{ padding: '16px 20px 120px', animation: 'fadeIn 0.3s ease' }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: font, color: C.text, margin: '0 0 20px' }}>
            {t('settings_title', locale)}
          </h1>

          {settingsLoading && !settingsData ? (
            <div style={{ textAlign: 'center', padding: 40, color: C.textMuted }}>{t('loading', locale)}</div>
          ) : settingsData && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

              {/* General */}
              <SettingsSection title={t('settings_general', locale)}>
                <SettingsRow label={t('settings_language', locale)} value={locale === 'ru' ? 'Русский' : 'English'} hint={t('settings_language_auto', locale)} />
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0' }}>
                  <span style={{ fontSize: 14, color: C.text }}>{t('settings_default_currency', locale)}</span>
                  <div style={{ display: 'flex', gap: 4, background: C.bg, borderRadius: 8, padding: 2 }}>
                    {(['RUB', 'USD'] as const).map(c => (
                      <button key={c} onClick={() => patchSettings({ defaultCurrency: c })} style={{
                        padding: '6px 12px', borderRadius: 6, border: 'none', fontSize: 13, fontWeight: 600,
                        cursor: 'pointer', fontFamily: font,
                        background: settingsData.defaultCurrency === c ? C.accent : 'transparent',
                        color: settingsData.defaultCurrency === c ? '#fff' : C.textMuted,
                      }}>
                        {c === 'RUB' ? '₽' : '$'}
                      </button>
                    ))}
                  </div>
                </div>
              </SettingsSection>

              {/* Notifications */}
              <SettingsSection title={t('settings_notifications_title', locale)}>
                <SettingsToggle
                  label={t('settings_notify_comments', locale)}
                  value={settingsData.notifications.comments}
                  disabled={!settingsData.isPro}
                  proBadge={!settingsData.isPro}
                  onChange={(v) => settingsData.isPro ? patchSettings({ notifications: { ...settingsData.notifications, comments: v } }) : showUpsell('comments')}
                />
                <SettingsToggle
                  label={t('settings_notify_reservations', locale)}
                  value={settingsData.notifications.reservations}
                  disabled={!settingsData.isPro}
                  proBadge={!settingsData.isPro}
                  onChange={(v) => settingsData.isPro ? patchSettings({ notifications: { ...settingsData.notifications, reservations: v } }) : showUpsell('comments')}
                />
                <SettingsToggle
                  label={t('settings_notify_subscriptions', locale)}
                  value={settingsData.notifications.subscriptions}
                  disabled={!settingsData.isPro}
                  proBadge={!settingsData.isPro}
                  onChange={(v) => settingsData.isPro ? patchSettings({ notifications: { ...settingsData.notifications, subscriptions: v } }) : showUpsell('comments')}
                />
                <SettingsToggle
                  label={t('settings_notify_marketing', locale)}
                  value={settingsData.notifications.marketing}
                  disabled={!settingsData.isPro}
                  proBadge={!settingsData.isPro}
                  onChange={(v) => settingsData.isPro ? patchSettings({ notifications: { ...settingsData.notifications, marketing: v } }) : showUpsell('comments')}
                />
              </SettingsSection>

              {/* Privacy */}
              <SettingsSection title={t('settings_privacy_title', locale)}>
                <SettingsRow
                  label={t('settings_profile_visibility', locale)}
                  value={settingsData.privacy.profileVisibility === 'ALL' ? t('privacy_value_all', locale) : settingsData.privacy.profileVisibility === 'NOBODY' ? t('privacy_value_nobody', locale) : settingsData.privacy.profileVisibility === 'LINK_ONLY' ? t('visibility_link_only', locale) : settingsData.privacy.profileVisibility}
                  onClick={() => setShowProfileVisibilitySheet(true)}
                />
                <SettingsRow
                  label={t('settings_subscribe_policy', locale)}
                  value={settingsData.privacy.subscribePolicy === 'ALL' ? t('privacy_value_all', locale) : settingsData.privacy.subscribePolicy === 'NOBODY' ? t('privacy_subs_nobody_new', locale) : settingsData.privacy.subscribePolicy === 'LINK_ONLY' ? t('subscribe_link_only', locale) : settingsData.privacy.subscribePolicy}
                  onClick={() => setShowSubscribePolicySheet(true)}
                />
                <SettingsRow
                  label={t('settings_allow_comments', locale)}
                  value={settingsData.privacy.commentsEnabled ? t('privacy_comments_anyone', locale) : t('privacy_comments_subs_only', locale)}
                  proBadge={!settingsData.isPro}
                  onClick={settingsData.isPro ? () => setShowCommentsDefaultSheet(true) : () => showUpsell('comments')}
                />
                <SettingsToggle
                  label={t('settings_allow_hints', locale)}
                  value={settingsData.privacy.hintsEnabled}
                  onChange={(v) => patchSettings({ privacy: { ...settingsData.privacy, hintsEnabled: v } })}
                />
                <div style={{ padding: '12px 0', borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 14, color: C.textMuted }}>{t('settings_reserved_visibility', locale)}</span>
                    <span style={{ fontSize: 12, color: C.textMuted }}>{t('settings_coming_soon', locale)}</span>
                  </div>
                </div>
              </SettingsSection>

              {/* App Behavior */}
              <SettingsSection title={t('settings_app_behavior_title', locale)}>
                <SettingsToggle
                  label={t('settings_wishlists_on_top', locale)}
                  value={settingsData.isPro && settingsData.appBehavior.newWishlistPosition === 'top'}
                  disabled={!settingsData.isPro}
                  proBadge={!settingsData.isPro}
                  onChange={(v) => {
                    if (!settingsData.isPro) { showUpsell('wishlist_limit'); return; }
                    patchSettings({ appBehavior: { ...settingsData.appBehavior, newWishlistPosition: v ? 'top' : 'bottom' } });
                  }}
                />
                <div style={{ padding: '12px 0', borderBottom: `1px solid ${C.border}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 14, color: C.textMuted }}>{t('settings_sorting_default', locale)}</span>
                    <span style={{ fontSize: 12, color: C.textMuted }}>{t('settings_coming_soon', locale)}</span>
                  </div>
                </div>
              </SettingsSection>

              {/* Support */}
              <SettingsSection title={t('settings_support_title', locale)}>
                <SettingsActionRow label={t('settings_report_problem', locale)} onClick={() => {
                  try { window.Telegram?.WebApp?.openTelegramLink?.(`https://t.me/${botUsername}`); } catch { /* ok */ }
                }} />
                <SettingsActionRow label={t('settings_contact_support', locale)} onClick={async () => {
                  try { tgRef.current?.WebApp?.HapticFeedback?.impactOccurred?.('light'); } catch { /* ok */ }
                  trackEvent('settings_support_contact_tap');

                  const supportUrl = 'https://t.me/Wish_Support';
                  const openChat = () => {
                    try {
                      if (window.Telegram?.WebApp?.openTelegramLink) {
                        window.Telegram.WebApp.openTelegramLink(supportUrl);
                      } else {
                        window.open(supportUrl, '_blank');
                      }
                      trackEvent('settings_support_contact_opened');
                    } catch {
                      window.open(supportUrl, '_blank');
                      trackEvent('settings_support_contact_opened');
                    }
                  };

                  const id = settingsData.supportId;
                  if (!id) {
                    openChat();
                    pushToast(t('support_contact_opened', locale), 'success');
                    return;
                  }

                  // Try to copy support ID then open chat
                  const copyId = async (): Promise<boolean> => {
                    try {
                      if (typeof window !== 'undefined' && window.Telegram?.WebApp?.writeToClipboard) {
                        window.Telegram.WebApp.writeToClipboard(id);
                        return true;
                      }
                      await navigator.clipboard.writeText(id);
                      return true;
                    } catch {
                      try {
                        const ta = document.createElement('textarea');
                        ta.value = id;
                        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
                        document.body.appendChild(ta);
                        ta.focus(); ta.select();
                        document.execCommand('copy');
                        document.body.removeChild(ta);
                        return true;
                      } catch {
                        return false;
                      }
                    }
                  };

                  const copied = await copyId();
                  openChat();
                  if (copied) {
                    pushToast(t('support_contact_id_copied', locale), 'success');
                    trackEvent('settings_support_id_copied');
                  } else {
                    pushToast(t('support_contact_id_copy_failed', locale), 'error');
                    trackEvent('settings_support_id_copy_failed');
                  }
                }} />
                <SettingsActionRow label={t('settings_faq', locale)} onClick={() => pushToast(t('settings_coming_soon', locale), 'success')} />
                <SettingsActionRow label={t('settings_legal', locale)} onClick={() => pushToast(t('settings_coming_soon', locale), 'success')} />
                <SettingsActionRow label={t('settings_delete_account', locale)} color={C.red} onClick={() => setShowDeleteAccount(true)} />
              </SettingsSection>

              {/* Support ID — owner-only, read-only copy block */}
              {settingsData.supportId && (
                <div style={{
                  background: C.surface, borderRadius: 16, padding: '14px 16px',
                  display: 'flex', flexDirection: 'column', gap: 8,
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                      <span style={{ fontSize: 12, color: C.textMuted, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                        {t('support_id_label', locale)}
                      </span>
                      <span style={{
                        fontSize: 14, color: C.text, fontFamily: 'monospace',
                        wordBreak: 'break-all', letterSpacing: '0.05em',
                      }}>
                        {settingsData.supportId}
                      </span>
                    </div>
                    <button
                      onClick={async () => {
                        const id = settingsData.supportId!;
                        try {
                          // Telegram Mini App clipboard API (preferred in TG environment)
                          if (typeof window !== 'undefined' && window.Telegram?.WebApp?.writeToClipboard) {
                            window.Telegram.WebApp.writeToClipboard(id);
                            pushToast(t('support_id_copied', locale), 'success');
                            return;
                          }
                          // Standard Clipboard API
                          await navigator.clipboard.writeText(id);
                          pushToast(t('support_id_copied', locale), 'success');
                        } catch {
                          // Fallback: execCommand (legacy browsers / restricted contexts)
                          try {
                            const ta = document.createElement('textarea');
                            ta.value = id;
                            ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
                            document.body.appendChild(ta);
                            ta.focus(); ta.select();
                            document.execCommand('copy');
                            document.body.removeChild(ta);
                            pushToast(t('support_id_copied', locale), 'success');
                          } catch {
                            pushToast(t('support_id_copy_error', locale), 'error');
                          }
                        }
                      }}
                      style={{
                        flexShrink: 0,
                        padding: '8px 14px', borderRadius: 10, border: 'none',
                        background: C.accent + '18', color: C.accent,
                        fontSize: 13, fontWeight: 600, cursor: 'pointer',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {t('support_id_copy', locale)}
                    </button>
                  </div>
                  <span style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.4 }}>
                    {t('support_id_hint', locale)}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
        );
      })()}

      {/* ── GLOBAL OVERLAYS (not tied to any screen — BottomSheet is position:fixed) ── */}

      {/* ── Fixed "Add wish" CTA — wishlist-detail owner view only ── */}
      {screen === 'wishlist-detail' &&
       currentWl &&
       !currentWl.readOnly &&
       currentWl.id !== draftsWishlistId &&
       !itemReorderMode &&
       !showItemForm &&
       !keyboardOpen && (
        <div style={{
          position: 'fixed',
          bottom: 0, left: 0, right: 0,
          zIndex: 50,
          // Gradient fade so the button visually merges with the list background
          background: `linear-gradient(to top, ${C.bg} 55%, transparent)`,
          padding: '20px 20px 0',
          paddingBottom: 'max(16px, env(safe-area-inset-bottom, 16px))',
          pointerEvents: 'none',
        }}>
          <button
            onClick={() => { resetItemForm(); setShowItemForm(true); }}
            style={{
              ...btnPrimary,
              height: 50,
              borderRadius: 14,
              fontSize: 15,
              pointerEvents: 'auto',
              boxShadow: '0 2px 12px rgba(0,0,0,0.18)',
            }}
          >
            {t('add_wish_btn', locale)}
          </button>
        </div>
      )}

      {/* ── Move item to wishlist picker — triggered from Drafts screen or item-detail ── */}
      <BottomSheet isOpen={showMovePicker} onClose={() => { setShowMovePicker(false); setMovingItem(null); }} title={t('drafts_move_title', locale)}>
        {(() => {
          const moveTargets = wishlists.filter(wl => wl.id !== draftsWishlistId);
          const calledFromItemDetail = screen === 'item-detail';
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {moveTargets.length === 0 && (
                <div style={{ textAlign: 'center', padding: '24px 0' }}>
                  <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 12 }}>{t('drafts_create_first', locale)}</div>
                  <button style={btnPrimary} onClick={() => { if (movingItem) setPendingMoveItemId(movingItem.id); setShowMovePicker(false); setMovingItem(null); setScreen('my-wishlists'); setShowCreateWl(true); }}>
                    {t('create_wishlist_btn', locale)}
                  </button>
                </div>
              )}
              {moveTargets.map((wl) => (
                <button
                  key={wl.id}
                  style={{
                    ...btnGhost,
                    width: '100%', textAlign: 'left', padding: '14px 16px',
                    borderRadius: 12, background: C.surface,
                    border: `1px solid ${C.border}`,
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}
                  onClick={() => { if (movingItem) void handleMoveItem(movingItem.id, wl.id, calledFromItemDetail); }}
                >
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{wl.title}</div>
                    <div style={{ fontSize: 12, color: C.textMuted }}>{t('wishes_count', locale, { count: wl.itemCount })}</div>
                  </div>
                  <span style={{ color: C.textMuted }}>›</span>
                </button>
              ))}
            </div>
          );
        })()}
      </BottomSheet>

      {/* ── Bulk move picker ── */}
      <BottomSheet isOpen={showBulkMovePicker} onClose={() => { if (!draftsBulkLoading) setShowBulkMovePicker(false); }} title={t('drafts_move_title', locale)}>
        {(() => {
          const moveTargets = wishlists.filter(wl => wl.id !== draftsWishlistId);
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {moveTargets.length === 0 && (
                <div style={{ textAlign: 'center', padding: '24px 0' }}>
                  <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 12 }}>{t('drafts_create_first', locale)}</div>
                  <button style={btnPrimary} onClick={() => { setShowBulkMovePicker(false); setDraftsSelectMode(false); setDraftsSelected([]); setScreen('my-wishlists'); setShowCreateWl(true); }}>
                    {t('create_wishlist_btn', locale)}
                  </button>
                </div>
              )}
              {moveTargets.map((wl) => (
                <button
                  key={wl.id}
                  style={{
                    ...btnGhost,
                    width: '100%', textAlign: 'left', padding: '14px 16px',
                    borderRadius: 12, background: C.surface,
                    border: `1px solid ${C.border}`,
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    opacity: draftsBulkLoading ? 0.6 : 1,
                  }}
                  disabled={draftsBulkLoading}
                  onClick={() => void handleBulkMove(wl.id)}
                >
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{wl.title}</div>
                    <div style={{ fontSize: 12, color: C.textMuted }}>{t('wishes_count', locale, { count: wl.itemCount })}</div>
                  </div>
                  {draftsBulkLoading ? <span style={{ color: C.textMuted, fontSize: 13 }}>…</span> : <span style={{ color: C.textMuted }}>›</span>}
                </button>
              ))}
            </div>
          );
        })()}
      </BottomSheet>

      {/* ── Bulk delete confirmation ── */}
      <BottomSheet isOpen={showBulkDeleteConfirm} onClose={() => { if (!draftsBulkLoading) setShowBulkDeleteConfirm(false); }} title={t('drafts_bulk_delete_title', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ margin: 0, fontSize: 14, color: C.textSec, lineHeight: 1.5 }}>
            {t('drafts_bulk_delete_desc', locale)}
          </p>
          <button
            style={{
              ...btnPrimary,
              background: C.red, width: '100%', padding: '14px 0', fontSize: 15,
              opacity: draftsBulkLoading ? 0.6 : 1,
            }}
            disabled={draftsBulkLoading}
            onClick={() => void handleBulkDelete()}
          >
            {draftsBulkLoading ? '…' : t('drafts_bulk_delete_cta', locale, { n: draftsSelected.length })}
          </button>
          <button
            style={{ ...btnGhost, width: '100%', padding: '14px 0', fontSize: 15, color: C.textMuted }}
            disabled={draftsBulkLoading}
            onClick={() => setShowBulkDeleteConfirm(false)}
          >
            {t('drafts_cancel_select', locale)}
          </button>
        </div>
      </BottomSheet>

      {/* ── Archive bulk hard-delete confirmation ── */}
      <BottomSheet
        isOpen={showArchiveBulkDeleteConfirm}
        onClose={() => { if (!archiveBulkLoading) setShowArchiveBulkDeleteConfirm(false); }}
        title={t('archive_bulk_delete_title', locale)}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ margin: 0, fontSize: 14, color: C.textSec, lineHeight: 1.5 }}>
            {t('archive_bulk_delete_desc', locale)}
          </p>
          <button
            style={{
              ...btnPrimary,
              background: C.red, width: '100%', padding: '14px 0', fontSize: 15,
              opacity: archiveBulkLoading ? 0.6 : 1,
            }}
            disabled={archiveBulkLoading}
            onClick={() => void handleBulkHardDelete()}
          >
            {archiveBulkLoading ? '…' : t('archive_bulk_delete_cta', locale, { n: archiveSelected.length })}
          </button>
          <button
            style={{ ...btnGhost, width: '100%', padding: '14px 0', fontSize: 15, color: C.textMuted }}
            disabled={archiveBulkLoading}
            onClick={() => setShowArchiveBulkDeleteConfirm(false)}
          >
            {t('archive_cancel_select', locale)}
          </button>
        </div>
      </BottomSheet>

      {/* ── Archive purge — 2-step confirmation ── */}
      <BottomSheet
        isOpen={showArchivePurgeConfirm}
        onClose={() => { if (!archiveBulkLoading) { setShowArchivePurgeConfirm(false); setArchivePurgeStep(1); } }}
        title={archivePurgeStep === 1 ? t('archive_purge_step1_title', locale) : t('archive_purge_step2_title', locale)}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {archivePurgeStep === 1 ? (
            <>
              <p style={{ margin: 0, fontSize: 14, color: C.textSec, lineHeight: 1.5 }}>
                {t('archive_purge_step1_desc', locale)}
              </p>
              <button
                style={{ ...btnPrimary, background: C.red, width: '100%', padding: '14px 0', fontSize: 15 }}
                onClick={() => setArchivePurgeStep(2)}
              >
                {t('archive_purge_btn', locale)}
              </button>
              <button
                style={{ ...btnGhost, width: '100%', padding: '14px 0', fontSize: 15, color: C.textMuted }}
                onClick={() => { setShowArchivePurgeConfirm(false); setArchivePurgeStep(1); }}
              >
                {t('archive_cancel_select', locale)}
              </button>
            </>
          ) : (
            <>
              <p style={{ margin: 0, fontSize: 14, color: C.textSec, lineHeight: 1.5 }}>
                {t('archive_purge_step2_desc', locale, {
                  n: archiveMode === 'global' ? globalArchiveItems.length : archiveItems.length,
                })}
              </p>
              <button
                style={{
                  ...btnPrimary,
                  background: C.red, width: '100%', padding: '14px 0', fontSize: 15,
                  opacity: archiveBulkLoading ? 0.6 : 1,
                }}
                disabled={archiveBulkLoading}
                onClick={() => void handlePurgeArchive()}
              >
                {archiveBulkLoading ? '…' : t('archive_purge_cta', locale)}
              </button>
              <button
                style={{ ...btnGhost, width: '100%', padding: '14px 0', fontSize: 15, color: C.textMuted }}
                disabled={archiveBulkLoading}
                onClick={() => setArchivePurgeStep(1)}
              >
                ← {t('archive_cancel_select', locale)}
              </button>
            </>
          )}
        </div>
      </BottomSheet>

      {/* ── Profile visibility sheet ── */}
      <BottomSheet isOpen={showProfileVisibilitySheet} onClose={() => setShowProfileVisibilitySheet(false)} title={t('privacy_profile_sheet_title', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(['ALL', 'NOBODY'] as const).map((opt) => {
            const isSelected = settingsData?.privacy.profileVisibility === opt;
            return (
              <button
                key={opt}
                onClick={() => {
                  void patchSettings({ privacy: { ...settingsData!.privacy, profileVisibility: opt } });
                  setShowProfileVisibilitySheet(false);
                }}
                style={{
                  background: isSelected ? C.accentSoft : C.surface,
                  border: isSelected ? `1.5px solid ${C.accent}` : '1.5px solid transparent',
                  borderRadius: 14, padding: '14px 18px', textAlign: 'left',
                  cursor: 'pointer', fontFamily: font, fontSize: 15, color: C.text,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}
              >
                <div>
                  <div style={{ fontWeight: isSelected ? 600 : 400 }}>
                    {opt === 'ALL' ? t('privacy_value_all', locale) : t('privacy_value_nobody', locale)}
                  </div>
                  {opt === 'NOBODY' && (
                    <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                      {t('privacy_profile_closed_hint', locale)}
                    </div>
                  )}
                </div>
                {isSelected && <span style={{ color: C.accent, fontSize: 18 }}>✓</span>}
              </button>
            );
          })}
        </div>
      </BottomSheet>

      {/* ── Subscribe policy sheet ── */}
      <BottomSheet isOpen={showSubscribePolicySheet} onClose={() => setShowSubscribePolicySheet(false)} title={t('privacy_subs_sheet_title', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(['ALL', 'NOBODY'] as const).map((opt) => {
            const isSelected = settingsData?.privacy.subscribePolicy === opt;
            return (
              <button
                key={opt}
                onClick={() => {
                  void patchSettings({ privacy: { ...settingsData!.privacy, subscribePolicy: opt } });
                  setShowSubscribePolicySheet(false);
                }}
                style={{
                  background: isSelected ? C.accentSoft : C.surface,
                  border: isSelected ? `1.5px solid ${C.accent}` : '1.5px solid transparent',
                  borderRadius: 14, padding: '14px 18px', textAlign: 'left',
                  cursor: 'pointer', fontFamily: font, fontSize: 15, color: C.text,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}
              >
                <div>
                  <div style={{ fontWeight: isSelected ? 600 : 400 }}>
                    {opt === 'ALL' ? t('privacy_value_all', locale) : t('privacy_subs_nobody_new', locale)}
                  </div>
                  {opt === 'NOBODY' && (
                    <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                      {t('privacy_subs_existing_kept', locale)}
                    </div>
                  )}
                </div>
                {isSelected && <span style={{ color: C.accent, fontSize: 18 }}>✓</span>}
              </button>
            );
          })}
        </div>
      </BottomSheet>

      {/* ── Comments default policy sheet ── */}
      <BottomSheet isOpen={showCommentsDefaultSheet} onClose={() => setShowCommentsDefaultSheet(false)} title={t('settings_allow_comments', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {([true, false] as const).map((opt) => {
            const isSelected = settingsData?.privacy.commentsEnabled === opt;
            return (
              <button
                key={String(opt)}
                onClick={() => {
                  void patchSettings({ privacy: { ...settingsData!.privacy, commentsEnabled: opt } });
                  setShowCommentsDefaultSheet(false);
                }}
                style={{
                  background: isSelected ? C.accentSoft : C.surface,
                  border: isSelected ? `1.5px solid ${C.accent}` : '1.5px solid transparent',
                  borderRadius: 14, padding: '14px 18px', textAlign: 'left',
                  cursor: 'pointer', fontFamily: font, fontSize: 15, color: C.text,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}
              >
                <span style={{ fontWeight: isSelected ? 600 : 400 }}>
                  {opt ? t('privacy_comments_anyone', locale) : t('privacy_comments_subs_only', locale)}
                </span>
                {isSelected && <span style={{ color: C.accent, fontSize: 18 }}>✓</span>}
              </button>
            );
          })}
        </div>
      </BottomSheet>

      {/* ── Wishlist management sheet ── */}
      <BottomSheet isOpen={showWlManage} onClose={() => setShowWlManage(false)} title={t('wl_manage_title', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Edit wishlist */}
          <button
            onClick={() => {
              setShowWlManage(false);
              if (currentWl) { setRenameWlTitle(currentWl.title); setShowRenameWl(true); }
            }}
            style={{
              background: C.surface, border: 'none', borderRadius: 14, padding: '16px 18px',
              textAlign: 'left', cursor: 'pointer', fontFamily: font,
              fontSize: 16, color: C.text, display: 'flex', alignItems: 'center', gap: 12,
            }}
          >
            <span style={{ fontSize: 20 }}>✏️</span>
            {t('wl_edit', locale)}
          </button>
          {/* Reorder wishes (items) */}
          <button
            onClick={() => {
              setShowWlManage(false);
              enterItemReorderMode();
            }}
            style={{
              background: C.surface, border: 'none', borderRadius: 14, padding: '16px 18px',
              textAlign: 'left', cursor: 'pointer', fontFamily: font,
              fontSize: 16, color: C.text, display: 'flex', alignItems: 'center', gap: 12,
            }}
          >
            <span style={{ fontSize: 20 }}>↕️</span>
            <span>{t('wl_reorder', locale)}</span>
          </button>
          {/* Privacy settings */}
          <button
            onClick={() => {
              setShowWlManage(false);
              if (currentWl) {
                setPrivacyDraftVisibility(currentWl.visibility ?? 'link_only');
                setPrivacyDraftAllowSubs(currentWl.allowSubscriptions ?? 'all');
                setPrivacyDraftCommentPolicy(currentWl.commentPolicy ?? 'all');
              }
              setShowWlPrivacy(true);
            }}
            style={{
              background: C.surface, border: 'none', borderRadius: 14, padding: '16px 18px',
              textAlign: 'left', cursor: 'pointer', fontFamily: font,
              fontSize: 16, color: C.text, display: 'flex', alignItems: 'center', gap: 12,
            }}
          >
            <span style={{ fontSize: 20 }}>🔒</span>
            {t('wl_manage_privacy', locale)}
          </button>
          {/* Archive wishlist */}
          <button
            onClick={() => {
              setShowWlManage(false);
              setShowArchiveWlConfirm(true);
            }}
            style={{
              background: C.surface, border: 'none', borderRadius: 14, padding: '16px 18px',
              textAlign: 'left', cursor: 'pointer', fontFamily: font,
              fontSize: 16, color: C.orange, display: 'flex', alignItems: 'center', gap: 12,
            }}
          >
            <span style={{ fontSize: 20 }}>📦</span>
            {t('wl_archive', locale)}
          </button>
          {/* Delete wishlist */}
          <button
            onClick={() => startDeleteWishlist()}
            style={{
              background: C.redSoft, border: 'none', borderRadius: 14, padding: '16px 18px',
              textAlign: 'left', cursor: 'pointer', fontFamily: font,
              fontSize: 16, color: C.red, display: 'flex', alignItems: 'center', gap: 12,
            }}
          >
            <span style={{ fontSize: 20 }}>🗑️</span>
            {t('wl_delete_btn', locale)}
          </button>
          {/* Cancel */}
          <button
            onClick={() => setShowWlManage(false)}
            style={{ ...btnGhost, marginTop: 4 }}
          >
            {t('wl_cancel', locale)}
          </button>
        </div>
      </BottomSheet>

      {/* ── Archive wishlist confirmation ── */}
      <BottomSheet isOpen={showArchiveWlConfirm} onClose={() => setShowArchiveWlConfirm(false)} title={t('wl_archive_confirm_title', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <p style={{ fontSize: 14, color: C.textSec, margin: 0, lineHeight: 1.6 }}>
            {t('wl_archive_confirm_body', locale)}
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button style={{ ...btnSecondary, flex: 1 }} onClick={() => setShowArchiveWlConfirm(false)}>
              {t('wl_cancel', locale)}
            </button>
            <button
              style={{ ...btnPrimary, flex: 1, background: C.orange, opacity: archivingWl ? 0.6 : 1 }}
              onClick={() => void handleArchiveWishlist()}
              disabled={archivingWl}
            >
              {archivingWl ? '…' : t('wl_archive_confirm_btn', locale)}
            </button>
          </div>
        </div>
      </BottomSheet>

      {/* ── Delete wishlist step 1: offer archive alternative ── */}
      <BottomSheet isOpen={showDeleteWl1} onClose={() => setShowDeleteWl1(false)} title={t('wl_delete_title', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ fontSize: 14, color: C.textSec, margin: 0, lineHeight: 1.6 }}>
            {t('wl_delete_body', locale)}
          </p>
          <button
            onClick={() => {
              setShowDeleteWl1(false);
              setShowArchiveWlConfirm(true);
            }}
            style={{
              background: C.surface, border: 'none', borderRadius: 14, padding: '16px 18px',
              textAlign: 'left', cursor: 'pointer', fontFamily: font,
              fontSize: 15, color: C.text, display: 'flex', alignItems: 'center', gap: 12,
            }}
          >
            <span style={{ fontSize: 20 }}>📦</span>
            {t('wl_delete_to_archive', locale)}
          </button>
          <button
            onClick={() => {
              setShowDeleteWl1(false);
              setShowDeleteWl2(true);
            }}
            style={{
              background: C.redSoft, border: 'none', borderRadius: 14, padding: '16px 18px',
              textAlign: 'left', cursor: 'pointer', fontFamily: font,
              fontSize: 15, color: C.red, display: 'flex', alignItems: 'center', gap: 12,
            }}
          >
            <span style={{ fontSize: 20 }}>🗑️</span>
            {t('wl_delete_irreversible', locale)}
          </button>
          <button onClick={() => setShowDeleteWl1(false)} style={{ ...btnGhost }}>
            {t('wl_cancel', locale)}
          </button>
        </div>
      </BottomSheet>

      {/* ── Delete wishlist step 2: final confirmation ── */}
      <BottomSheet isOpen={showDeleteWl2} onClose={() => { if (!deletingWl) setShowDeleteWl2(false); }} title={t('wl_delete_confirm2_title', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <p style={{ fontSize: 14, color: C.textSec, margin: 0, lineHeight: 1.6 }}>
            {t('wl_delete_confirm2_body', locale)}
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              style={{ ...btnSecondary, flex: 1 }}
              onClick={() => setShowDeleteWl2(false)}
              disabled={deletingWl}
            >
              {t('wl_cancel', locale)}
            </button>
            <button
              style={{ ...btnPrimary, flex: 1, background: C.red, opacity: deletingWl ? 0.6 : 1 }}
              onClick={() => void handleDeleteWishlist()}
              disabled={deletingWl}
            >
              {deletingWl ? '…' : t('wl_delete_confirm2_btn', locale)}
            </button>
          </div>
        </div>
      </BottomSheet>

      {/* ── Delete with reserved items warning ── */}
      <BottomSheet isOpen={showDeleteWlReserved} onClose={() => { if (!deletingWl && !transferingItems) setShowDeleteWlReserved(false); }} title={t('wl_delete_reserved_title', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 14, color: C.textSec, margin: 0, lineHeight: 1.6 }}>
            {t('wl_delete_reserved_body', locale)}
          </p>
          <button
            onClick={() => {
              setShowDeleteWlReserved(false);
              setTransferTargetId(null);
              setShowTransferPicker(true);
            }}
            style={{
              background: C.surface, border: 'none', borderRadius: 14, padding: '16px 18px',
              textAlign: 'left', cursor: 'pointer', fontFamily: font,
              fontSize: 15, color: C.text, display: 'flex', alignItems: 'center', gap: 12,
            }}
          >
            <span style={{ fontSize: 20 }}>📤</span>
            {t('wl_delete_reserved_transfer', locale)}
          </button>
          <button
            onClick={() => {
              setShowDeleteWlReserved(false);
              setShowDeleteWl2(true);
            }}
            style={{
              background: C.redSoft, border: 'none', borderRadius: 14, padding: '16px 18px',
              textAlign: 'left', cursor: 'pointer', fontFamily: font,
              fontSize: 15, color: C.red, display: 'flex', alignItems: 'center', gap: 12,
            }}
          >
            <span style={{ fontSize: 20 }}>🗑️</span>
            {t('wl_delete_reserved_force', locale)}
          </button>
          <button onClick={() => setShowDeleteWlReserved(false)} style={{ ...btnGhost }} disabled={deletingWl || transferingItems}>
            {t('wl_cancel', locale)}
          </button>
        </div>
      </BottomSheet>

      {/* ── Transfer reserved items picker ── */}
      <BottomSheet isOpen={showTransferPicker} onClose={() => { if (!transferingItems) setShowTransferPicker(false); }} title={t('wl_transfer_title', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <p style={{ fontSize: 13, color: C.textSec, margin: 0 }}>{t('wl_transfer_hint', locale)}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {wishlists
              .filter((wl) => wl.id !== currentWl?.id)
              .map((wl) => {
                const isArchived = false; // wishlists list only shows non-archived
                const reservedCount = currentWl?.reservedCount ?? 0;
                const availableSlots = (planInfo.items - (wl.itemCount - wl.reservedCount));
                const hasSpace = availableSlots >= reservedCount;
                const isDisabled = isArchived || !hasSpace;
                const isSelected = transferTargetId === wl.id;
                return (
                  <button
                    key={wl.id}
                    onClick={() => !isDisabled && setTransferTargetId(wl.id)}
                    disabled={isDisabled}
                    style={{
                      background: isSelected ? C.accentSoft : C.surface,
                      border: isSelected ? `2px solid ${C.accent}` : '2px solid transparent',
                      borderRadius: 12, padding: '12px 16px',
                      textAlign: 'left', cursor: isDisabled ? 'not-allowed' : 'pointer', fontFamily: font,
                      opacity: isDisabled ? 0.5 : 1,
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 18 }}>{getEmoji(wl.title)}</span>
                      <div>
                        <div style={{ fontSize: 14, color: C.text, fontWeight: 600 }}>{wl.title}</div>
                        <div style={{ fontSize: 12, color: C.textMuted }}>
                          {wl.itemCount} {locale === 'ru' ? 'желаний' : 'wishes'}
                        </div>
                      </div>
                    </div>
                    {isArchived && (
                      <span style={{ fontSize: 11, color: C.textMuted, background: C.surface, padding: '2px 8px', borderRadius: 6 }}>
                        {t('wl_transfer_archived', locale)}
                      </span>
                    )}
                    {!isArchived && !hasSpace && (
                      <span style={{ fontSize: 11, color: C.red }}>
                        {t('wl_transfer_no_space', locale, { count: availableSlots })}
                      </span>
                    )}
                    {isSelected && (
                      <span style={{ fontSize: 18, color: C.accent }}>✓</span>
                    )}
                  </button>
                );
              })
            }
            {wishlists.filter((wl) => wl.id !== currentWl?.id).length === 0 && (
              <p style={{ fontSize: 14, color: C.textMuted, textAlign: 'center', padding: '20px 0' }}>
                {locale === 'ru' ? 'Нет других вишлистов' : 'No other wishlists'}
              </p>
            )}
          </div>
          <button
            style={{ ...btnPrimary, opacity: (!transferTargetId || transferingItems) ? 0.5 : 1 }}
            disabled={!transferTargetId || transferingItems}
            onClick={() => void handleTransferAndDelete()}
          >
            {transferingItems ? '…' : t('wl_transfer_btn', locale)}
          </button>
          <button onClick={() => setShowTransferPicker(false)} style={{ ...btnGhost }} disabled={transferingItems}>
            {t('wl_cancel', locale)}
          </button>
        </div>
      </BottomSheet>

      {/* ── Privacy settings per wishlist ── */}
      <BottomSheet isOpen={showWlPrivacy} onClose={() => { if (!privacySaving) setShowWlPrivacy(false); }} title={t('wl_privacy_title', locale)}>
        {(() => {
          const isPro = planInfo.code === 'PRO';
          const visOptions: { value: WishlistVisibility; label: string; desc: string; pro: boolean }[] = [
            { value: 'link_only', label: t('wl_visibility_link_only', locale), desc: t('wl_visibility_link_only_desc', locale), pro: false },
            { value: 'public_profile', label: t('wl_visibility_public', locale), desc: t('wl_visibility_public_desc', locale), pro: true },
            { value: 'private', label: t('wl_visibility_private', locale), desc: t('wl_visibility_private_desc', locale), pro: true },
          ];
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

              {/* Visibility */}
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                  {t('wl_visibility_section', locale)}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {visOptions.map((opt) => {
                    const selected = privacyDraftVisibility === opt.value;
                    return (
                      <button
                        key={opt.value}
                        onClick={() => {
                          if (opt.pro && !isPro) { showUpsell('wishlist_limit'); return; }
                          setPrivacyDraftVisibility(opt.value);
                        }}
                        style={{
                          background: selected ? C.accentSoft : C.surface,
                          border: selected ? `2px solid ${C.accent}` : '2px solid transparent',
                          borderRadius: 12, padding: '12px 14px',
                          textAlign: 'left', cursor: 'pointer', fontFamily: font,
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10,
                        }}
                      >
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{opt.label}</span>
                            {opt.pro && !isPro && (
                              <span style={{ fontSize: 10, fontWeight: 700, color: C.accent, background: C.accentSoft, padding: '2px 6px', borderRadius: 6 }}>PRO</span>
                            )}
                          </div>
                          <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{opt.desc}</div>
                        </div>
                        {selected && <span style={{ fontSize: 16, color: C.accent, flexShrink: 0 }}>✓</span>}
                      </button>
                    );
                  })}
                </div>
                {privacyDraftVisibility === 'private' && (
                  <p style={{ fontSize: 12, color: C.textMuted, margin: '8px 0 0', lineHeight: 1.5 }}>
                    {t('wl_visibility_private_hint', locale)}
                  </p>
                )}
              </div>

              {/* Allow subscriptions */}
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                  {t('wl_subs_section', locale)}
                </div>
                <div style={{ display: 'flex', gap: 4, background: C.bg, borderRadius: 10, padding: 3 }}>
                  {([['all', t('wl_subs_all', locale), false], ['nobody', t('wl_subs_nobody', locale), true]] as [AllowSubscriptions, string, boolean][]).map(([val, label, pro]) => {
                    const selected = privacyDraftAllowSubs === val;
                    return (
                      <button
                        key={val}
                        onClick={() => {
                          if (pro && !isPro) { showUpsell('wishlist_limit'); return; }
                          setPrivacyDraftAllowSubs(val);
                        }}
                        style={{
                          flex: 1, padding: '8px 4px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: font,
                          fontSize: 13, fontWeight: 600,
                          background: selected ? C.accent : 'transparent',
                          color: selected ? '#fff' : C.textMuted,
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                        }}
                      >
                        {label}
                        {pro && !isPro && <span style={{ fontSize: 9, fontWeight: 700, color: selected ? 'rgba(255,255,255,0.8)' : C.accent }}>PRO</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Comment policy */}
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 10 }}>
                  {t('wl_comment_section', locale)}
                </div>
                <div style={{ display: 'flex', gap: 4, background: C.bg, borderRadius: 10, padding: 3 }}>
                  {([['all', t('wl_comment_all', locale), false], ['subscribers', t('wl_comment_subscribers', locale), true]] as [CommentPolicy, string, boolean][]).map(([val, label, pro]) => {
                    const selected = privacyDraftCommentPolicy === val;
                    return (
                      <button
                        key={val}
                        onClick={() => {
                          if (pro && !isPro) { showUpsell('wishlist_limit'); return; }
                          setPrivacyDraftCommentPolicy(val);
                        }}
                        style={{
                          flex: 1, padding: '8px 4px', borderRadius: 8, border: 'none', cursor: 'pointer', fontFamily: font,
                          fontSize: 13, fontWeight: 600,
                          background: selected ? C.accent : 'transparent',
                          color: selected ? '#fff' : C.textMuted,
                          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                        }}
                      >
                        {label}
                        {pro && !isPro && <span style={{ fontSize: 9, fontWeight: 700, color: selected ? 'rgba(255,255,255,0.8)' : C.accent }}>PRO</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              <button
                style={{ ...btnPrimary, opacity: privacySaving ? 0.6 : 1 }}
                disabled={privacySaving}
                onClick={() => void handleSaveWlPrivacy(privacyDraftVisibility, privacyDraftAllowSubs, privacyDraftCommentPolicy)}
              >
                {privacySaving ? '…' : t('save', locale)}
              </button>
            </div>
          );
        })()}
      </BottomSheet>

      {/* ── Unreserve confirmation ── */}
      <BottomSheet isOpen={!!pendingUnreserveAction} onClose={() => { if (!unreservingConfirm) setPendingUnreserveAction(null); }} title={t('unreserve_confirm_title', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <p style={{ fontSize: 14, color: C.textSec, margin: 0, lineHeight: 1.6 }}>
            {t('unreserve_confirm_body', locale)}
          </p>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              style={{ ...btnSecondary, flex: 1 }}
              onClick={() => setPendingUnreserveAction(null)}
              disabled={unreservingConfirm}
            >
              {t('cancel', locale)}
            </button>
            <button
              style={{ ...btnPrimary, flex: 1, background: C.red, opacity: unreservingConfirm ? 0.6 : 1 }}
              disabled={unreservingConfirm}
              onClick={async () => {
                if (!pendingUnreserveAction || unreservingConfirm) return;
                setUnreservingConfirm(true);
                try {
                  await pendingUnreserveAction();
                  setPendingUnreserveAction(null);
                } finally {
                  setUnreservingConfirm(false);
                }
              }}
            >
              {unreservingConfirm ? '…' : t('unreserve_confirm_btn', locale)}
            </button>
          </div>
        </div>
      </BottomSheet>

      <BottomSheet isOpen={showRenameWl} onClose={() => setShowRenameWl(false)} title={t('rename_title', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('wishlist_name', locale)}</label>
            <input
              style={inputStyle}
              value={renameWlTitle}
              onChange={(e) => setRenameWlTitle(e.target.value.slice(0, 80))}
              autoFocus
              placeholder={t('rename_placeholder', locale)}
              maxLength={80}
            />
            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4, textAlign: 'right' }}>{renameWlTitle.length}/80</div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              style={{ ...btnSecondary, flex: 1 }}
              onClick={() => setShowRenameWl(false)}
            >{t('cancel', locale)}</button>
            <button
              style={{ ...btnPrimary, flex: 1, opacity: renameWlTitle.trim() && renameWlTitle.trim() !== currentWl?.title ? 1 : 0.5 }}
              onClick={() => void handleRenameWishlist()}
              disabled={!renameWlTitle.trim() || renameWlTitle.trim() === currentWl?.title || renameSaving}
            >{renameSaving ? '…' : t('save', locale)}</button>
          </div>
        </div>
      </BottomSheet>
      <BottomSheet isOpen={editingDescription} onClose={() => setEditingDescription(false)} title={t('description_title', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <textarea
              style={{ ...inputStyle, minHeight: 48, resize: 'none', overflow: 'hidden' }}
              maxLength={500}
              placeholder={t('description_placeholder', locale)}
              value={descriptionText}
              ref={descTextareaRef}
              onChange={(e) => setDescriptionText(e.target.value)}
              autoFocus
            />
            <div style={{ fontSize: 12, color: descriptionText.length > 480 ? C.orange : C.textMuted, textAlign: 'right', marginTop: 4 }}>
              {descriptionText.length}/500
            </div>
          </div>
          <button
            style={{ ...btnPrimary, opacity: loading ? 0.5 : 1 }}
            onClick={() => void handleSaveDescription()}
            disabled={loading}
          >
            {loading ? '…' : `💾 ${t('save', locale)}`}
          </button>
        </div>
      </BottomSheet>
      <BottomSheet isOpen={!!reservingItem} onClose={() => setReservingItem(null)} title={t('reserve_title', locale)}>
        {reservingItem && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: 12, background: C.bg, borderRadius: 12 }}>
              <div style={{ width: 44, height: 44, borderRadius: 10, background: C.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}>🎁</div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, color: C.text, fontFamily: font }}>{reservingItem.title}</div>
                {reservingItem.price != null && <div style={{ fontSize: 14, color: C.accent, fontWeight: 700, marginTop: 2 }}>{fmtPrice(reservingItem.price, locale, reservingItem.currency ?? 'RUB')}</div>}
              </div>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('reserve_name_label', locale)}</label>
              <input style={inputStyle} placeholder={t('reserve_name_placeholder', locale)} value={guestName} onChange={(e) => setGuestName(e.target.value)} autoFocus />
            </div>
            <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.5 }} dangerouslySetInnerHTML={{ __html: t('reserve_privacy', locale) }} />
            <div style={{ display: 'flex', gap: 10 }}>
              <button style={{ ...btnGhost, flex: 1, width: '100%' }} onClick={() => setReservingItem(null)}>{t('cancel', locale)}</button>
              <button
                style={{ ...btnPrimary, flex: 2, opacity: guestName.trim() ? 1 : 0.5 }}
                onClick={() => void handleReserve()}
                disabled={!guestName.trim() || loading}
              >
                {loading ? '…' : t('reserve_btn', locale)}
              </button>
            </div>
          </div>
        )}
      </BottomSheet>
      <BottomSheet isOpen={showItemForm} onClose={() => { blurActiveField(); setShowItemForm(false); resetItemForm(); }} title={editingItem ? t('item_form_edit', locale) : t('item_form_new', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('item_name', locale)}</label>
            <input style={inputStyle} placeholder={t('item_name_placeholder', locale)} value={itemTitle} onChange={(e) => setItemTitle(e.target.value)} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('item_description', locale)}</label>
            <textarea
              style={{ ...inputStyle, minHeight: 48, resize: 'none', overflow: 'hidden' }}
              maxLength={500}
              placeholder={t('item_description_placeholder', locale)}
              value={itemDescription}
              ref={itemDescTextareaRef}
              onChange={(e) => setItemDescription(e.target.value)}
              onFocus={(e) => handleTextareaFocus(e.currentTarget)}
            />
            <div style={{ fontSize: 11, color: C.textMuted, textAlign: 'right', marginTop: 2 }}>{itemDescription.length}/500</div>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('item_url', locale)}</label>
            <input style={inputStyle} placeholder="https://…" value={itemUrl} onChange={(e) => setItemUrl(e.target.value)} />
          </div>
          {/* ── Photo picker ── */}
          {(() => {
            const photoPreviewSrc = itemPhotoDeleted ? null : (itemPhotoLocalUrl ?? (itemImageUrl || null));
            const hasPhoto = !!(itemPhotoLocalUrl || (!itemPhotoDeleted && itemImageUrl));
            return (
          <div>
            <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 8 }}>{t('item_photo', locale)}</label>
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              {/* Preview square */}
              <div style={{
                width: 80, height: 80, borderRadius: 12, overflow: 'hidden', flexShrink: 0,
                background: C.card, border: `1px solid ${C.borderLight}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
              }}>
                {photoPreviewSrc && !photoPickerImgErr ? (
                  <img
                    src={photoPreviewSrc}
                    onError={() => setPhotoPickerImgErr(true)}
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    alt=""
                  />
                ) : (
                  <span style={{ fontSize: 28, opacity: 0.35 }}>🖼</span>
                )}
              </div>

              {/* Actions */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
                <button
                  type="button"
                  onClick={() => { setPhotoError(null); setPhotoPickerImgErr(false); photoInputRef.current?.click(); }}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    background: 'none', border: 'none', padding: 0,
                    fontSize: 14, fontWeight: 500, color: C.green, cursor: 'pointer', fontFamily: font,
                  }}
                >
                  <span>📎</span>
                  <span>{hasPhoto ? t('item_photo_replace', locale) : t('item_photo_select', locale)}</span>
                </button>

                {hasPhoto && (
                  <button
                    type="button"
                    onClick={handlePhotoDelete}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      background: 'none', border: 'none', padding: 0,
                      fontSize: 14, fontWeight: 500, color: C.red, cursor: 'pointer', fontFamily: font,
                    }}
                  >
                    <span>🗑</span>
                    <span>{t('item_photo_delete', locale)}</span>
                  </button>
                )}

                {photoError && (
                  <span style={{ fontSize: 12, color: C.red, lineHeight: 1.4 }}>{photoError}</span>
                )}
                {photoUploading && (
                  <span style={{ fontSize: 12, color: C.textMuted }}>{t('item_photo_uploading', locale)}</span>
                )}
              </div>
            </div>

            <input
              ref={photoInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={handlePhotoSelect}
            />
          </div>
            );
          })()}
          <div>
            <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('item_price', locale)}</label>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                {(['RUB', 'USD'] as const).map(c => (
                  <button
                    key={c}
                    type="button"
                    onClick={() => setItemCurrency(c)}
                    style={{
                      ...btnGhost,
                      width: 'auto',
                      padding: '6px 12px',
                      fontSize: 13,
                      background: itemCurrency === c ? C.accentSoft : 'transparent',
                      color: itemCurrency === c ? C.accent : C.textMuted,
                      border: `1px solid ${itemCurrency === c ? C.accent + '40' : C.borderLight}`,
                      borderRadius: 8,
                    }}
                  >
                    {c === 'RUB' ? '₽' : '$'}
                  </button>
                ))}
              </div>
              {/* Price input with currency suffix — same layout for RUB and USD */}
              <div
                style={{
                  ...inputStyle,
                  flex: 1,
                  width: 'auto',
                  padding: 0,
                  display: 'flex',
                  alignItems: 'center',
                  cursor: 'text',
                }}
                onClick={() => priceInputRef.current?.focus()}
              >
                <input
                  ref={priceInputRef}
                  style={{
                    flex: 1,
                    border: 'none',
                    background: 'transparent',
                    outline: 'none',
                    color: C.text,
                    fontSize: 16,
                    fontFamily: font,
                    padding: '14px 6px 14px 16px',
                    minWidth: 0,
                  }}
                  placeholder="0"
                  type="text"
                  inputMode="numeric"
                  value={formatPriceForDisplay(itemPrice)}
                  onChange={(e) => {
                    const cursorPos = e.target.selectionStart ?? e.target.value.length;
                    const displayedValue = e.target.value;
                    const raw = parsePriceFromDisplay(displayedValue);
                    const digitsBeforeCursor = parsePriceFromDisplay(displayedValue.slice(0, cursorPos)).length;
                    setItemPrice(raw);
                    requestAnimationFrame(() => {
                      const input = priceInputRef.current;
                      if (!input) return;
                      const newFormatted = formatPriceForDisplay(raw);
                      let digitsSeen = 0;
                      let newPos = newFormatted.length;
                      if (digitsBeforeCursor === 0) {
                        newPos = 0;
                      } else {
                        for (let i = 0; i < newFormatted.length; i++) {
                          if (/\d/.test(newFormatted[i]!)) {
                            digitsSeen++;
                            if (digitsSeen === digitsBeforeCursor) { newPos = i + 1; break; }
                          }
                        }
                      }
                      input.selectionStart = newPos;
                      input.selectionEnd = newPos;
                    });
                  }}
                />
                <span style={{
                  paddingRight: 14,
                  fontSize: 16,
                  color: C.textMuted,
                  flexShrink: 0,
                  userSelect: 'none',
                  pointerEvents: 'none',
                }}>
                  {itemCurrency === 'RUB' ? '₽' : '$'}
                </span>
              </div>
            </div>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('item_priority', locale)}</label>
            <div style={{ display: 'flex', gap: 10 }}>
              {getPriorities(locale).map((p) => {
                const isSelected = itemPriority === p.value;
                const pc = PRIO_COLOR[p.value];
                const pb = PRIO_BG[p.value];
                return (
                  <div key={p.value} onClick={() => setItemPriority(p.value as 1 | 2 | 3)} style={{
                    flex: 1, padding: '12px 8px', borderRadius: 12, textAlign: 'center', cursor: 'pointer', transition: 'all 0.2s',
                    background: isSelected ? pb : C.surface,
                    border: `1.5px solid ${isSelected ? pc : C.border}`,
                  }}>
                    <div style={{ fontSize: 22, marginBottom: 4 }}>{p.emoji}</div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: isSelected ? pc : C.text, marginBottom: 2 }}>{p.label}</div>
                    <div style={{ fontSize: 10, color: C.textMuted, lineHeight: 1.2 }}>{p.sub}</div>
                  </div>
                );
              })}
            </div>
          </div>
          <button style={{ ...btnPrimary, opacity: itemTitle.trim() ? 1 : 0.5 }} onClick={() => void handleSaveItem()} disabled={!itemTitle.trim() || loading}>
            {loading ? '…' : editingItem ? `💾 ${t('save', locale)}` : t('item_add_btn', locale)}
          </button>
        </div>
      </BottomSheet>

      {/* Delete confirmation */}
      <BottomSheet isOpen={!!deletingItem} onClose={() => setDeletingItem(null)} title={t('delete_title', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 15, color: C.textSec, lineHeight: 1.5 }}>{deletingItem?.title}</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button style={{ ...btnGhost, flex: 1 }} onClick={() => setDeletingItem(null)}>{t('cancel', locale)}</button>
            <button
              style={{ ...btnPrimary, flex: 2, background: C.red }}
              onClick={() => {
                if (deletingItem) {
                  void handleDeleteItem(deletingItem);
                  setDeletingItem(null);
                }
              }}
            >
              🗑 {t('delete', locale)}
            </button>
          </div>
        </div>
      </BottomSheet>

      {/* ── PRO UPSELL BOTTOM SHEET (CONTEXT-AWARE) ── */}
      <ProUpsellSheet
        state={upsellSheet}
        onClose={() => {
          if (upsellSheet) trackEvent(`pro_sheet_dismissed_${upsellSheet.context}`);
          setUpsellSheet(null);
        }}
        onUpgrade={() => {
          if (upsellSheet) trackEvent(`pro_cta_clicked_${upsellSheet.context}`);
          void handleUpgradeToPro();
        }}
        checkoutLoading={checkoutLoading}
        onBuyAddon={handleBuyAddon}
        addonCheckoutLoading={addonCheckoutLoading}
        availableSkus={availableSkus}
        cappedAddonCodes={cappedAddonCodes}
        locale={locale}
      />

      {/* ── CANCEL SUBSCRIPTION CONFIRMATION ── */}
      <BottomSheet isOpen={showCancelSub} onClose={() => setShowCancelSub(false)}>
        {(() => {
          const periodEndDate = subscription
            ? new Date(subscription.periodEnd).toLocaleDateString(
                locale === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'long' },
              )
            : null;

          const cancelFeatures: { key: string }[] = [
            { key: 'cancel_feat_wishlists' },
            { key: 'cancel_feat_items' },
            { key: 'cancel_feat_participants' },
            { key: 'cancel_feat_comments' },
            { key: 'cancel_feat_url' },
            { key: 'cancel_feat_hints' },
            { key: 'cancel_feat_subs' },
            { key: 'cancel_feat_privacy' },
          ];

          return (
            <div style={{ padding: '0 0 8px' }}>
              {/* Icon + Title */}
              <div style={{ textAlign: 'center', marginBottom: 16 }}>
                <div style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  width: 52, height: 52, borderRadius: 16,
                  background: C.accentSoft, fontSize: 26, marginBottom: 14,
                }}>
                  💎
                </div>
                <div style={{ fontSize: 17, fontWeight: 800, color: C.text, lineHeight: 1.3, fontFamily: font }}>
                  {t('cancel_title', locale)}
                </div>
                <div style={{ fontSize: 13, color: C.textSec, marginTop: 6, lineHeight: 1.5 }}>
                  {periodEndDate
                    ? t('cancel_notice', locale, { date: periodEndDate })
                    : t('cancel_notice_fallback', locale)}
                  {' '}
                  {t('cancel_after', locale)}
                </div>
              </div>

              {/* What becomes unavailable */}
              <div style={{
                background: C.surface, borderRadius: 14,
                padding: '12px 14px', marginBottom: 12,
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.textMuted, marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                  {t('cancel_features_title', locale)}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {cancelFeatures.map(({ key }) => (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 0' }}>
                      <span style={{
                        width: 20, height: 20, borderRadius: 10, flexShrink: 0,
                        background: C.accentSoft, color: C.accent,
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 11, fontWeight: 800,
                      }}>✓</span>
                      <span style={{ fontSize: 14, color: C.text, flex: 1 }}>{t(key as Parameters<typeof t>[0], locale)}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Support block — only if botUsername is available */}
              {botUsername && (
                <div style={{
                  background: C.surface, borderRadius: 12, padding: '10px 14px',
                  marginBottom: 14, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
                }}>
                  <span style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.4, flex: 1 }}>
                    {t('cancel_support_text', locale)}
                  </span>
                  <button
                    onClick={() => {
                      try { window.Telegram?.WebApp?.openTelegramLink?.(`https://t.me/${botUsername}`); } catch { /* ok */ }
                    }}
                    style={{
                      flexShrink: 0, background: 'none', border: `1px solid ${C.border}`,
                      borderRadius: 20, padding: '6px 12px', cursor: 'pointer',
                      fontFamily: font, fontSize: 12, fontWeight: 600, color: C.accent,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t('cancel_support_btn', locale)}
                  </button>
                </div>
              )}

              {/* CTAs — Keep Pro first, then Cancel (reversed from before) */}
              <button
                style={{ ...btnPrimary, width: '100%', fontSize: 15, padding: '14px 24px' }}
                onClick={() => setShowCancelSub(false)}
              >
                {t('cancel_keep', locale)}
              </button>
              <button
                style={{
                  ...btnGhost, width: '100%', marginTop: 6, fontSize: 14,
                  color: C.red,
                }}
                onClick={() => void handleCancelSub()}
                disabled={cancelSubLoading}
              >
                {cancelSubLoading ? t('cancel_cancelling', locale) : t('cancel_btn', locale)}
              </button>
            </div>
          );
        })()}
      </BottomSheet>

      {/* ── EDIT PROFILE BOTTOM SHEET ── */}
      <BottomSheet isOpen={editingProfile} onClose={() => setEditingProfile(false)} title={t('profile_title', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('profile_display_name', locale)}</label>
            <input style={inputStyle} placeholder={t('profile_display_name_placeholder', locale)} value={editProfileName} onChange={(e) => setEditProfileName(e.target.value)} autoFocus />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('profile_username', locale)}</label>
            <input style={inputStyle} placeholder={t('profile_username_placeholder', locale)} value={editProfileUsername} onChange={(e) => setEditProfileUsername(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))} />
            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>{t('profile_username_hint', locale)}</div>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('profile_bio', locale)}</label>
            <textarea
              style={{ ...inputStyle, minHeight: 48, resize: 'none', overflow: 'hidden' }}
              maxLength={200}
              placeholder={t('profile_bio_placeholder', locale)}
              value={editProfileBio}
              ref={bioTextareaRef}
              onChange={(e) => setEditProfileBio(e.target.value)}
            />
            <div style={{ fontSize: 11, color: C.textMuted, textAlign: 'right', marginTop: 2 }}>{editProfileBio.length}/200</div>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('profile_birthday', locale)}</label>
            <input
              style={{ ...inputStyle, colorScheme: 'dark' }}
              type="date"
              max={new Date().toISOString().slice(0, 10)}
              value={editProfileBirthday}
              onChange={(e) => setEditProfileBirthday(e.target.value)}
            />
          </div>
          <button
            style={{ ...btnPrimary, opacity: editProfileSaving ? 0.5 : 1 }}
            onClick={async () => {
              setEditProfileSaving(true);
              try {
                const res = await tgFetch('/tg/me/profile', {
                  method: 'PATCH',
                  body: JSON.stringify({
                    displayName: editProfileName.trim() || null,
                    username: editProfileUsername.trim() || null,
                    bio: editProfileBio.trim() || null,
                    birthday: editProfileBirthday || null,
                  }),
                });
                if (!res.ok) {
                  const body = await res.json().catch(() => ({})) as { error?: string };
                  pushToast(body.error || t('toast_save_error', locale), 'error');
                  return;
                }
                pushToast(t('profile_saved', locale), 'success');
                setEditingProfile(false);
                loadProfile();
              } catch {
                pushToast(t('toast_save_error', locale), 'error');
              } finally {
                setEditProfileSaving(false);
              }
            }}
            disabled={editProfileSaving}
          >
            {editProfileSaving ? '\u2026' : t('save', locale)}
          </button>
        </div>
      </BottomSheet>

      {/* ── DELETE ACCOUNT BOTTOM SHEET ── */}
      <BottomSheet isOpen={showDeleteAccount} onClose={() => setShowDeleteAccount(false)}>
        <div style={{ textAlign: 'center', padding: '0 0 8px' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 56, height: 56, borderRadius: 18,
            background: C.redSoft, fontSize: 28, marginBottom: 16,
          }}>
            {'⚠️'}
          </div>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.text, lineHeight: 1.3, fontFamily: font }}>
            {t('settings_delete_confirm_title', locale)}
          </div>
          <div style={{ fontSize: 14, color: C.textSec, marginTop: 8, lineHeight: 1.5, padding: '0 8px' }}>
            {t('settings_delete_warning', locale)}
          </div>
          <button
            style={{ ...btnPrimary, marginTop: 20, width: '100%', background: C.red, fontSize: 15, padding: '14px 24px' }}
            onClick={async () => {
              try {
                const res = await tgFetch('/tg/me/account', { method: 'DELETE' });
                if (res.ok) {
                  try { window.Telegram?.WebApp?.close?.(); } catch { /* ok */ }
                } else {
                  pushToast(t('error_generic', locale), 'error');
                }
              } catch {
                pushToast(t('error_generic', locale), 'error');
              }
            }}
          >
            {t('settings_delete_btn', locale)}
          </button>
          <button
            style={{ ...btnGhost, width: '100%', marginTop: 8, fontSize: 14 }}
            onClick={() => setShowDeleteAccount(false)}
          >
            {t('cancel', locale)}
          </button>
        </div>
      </BottomSheet>

      {/* ── Avatar action sheet ── */}
      <BottomSheet isOpen={showAvatarSheet} onClose={() => setShowAvatarSheet(false)} title={t('profile_change_avatar', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <button
            onClick={() => { setShowAvatarSheet(false); setTimeout(() => avatarInputRef.current?.click(), 50); }}
            style={{ ...btnPrimary, width: '100%', background: C.accent }}
          >
            {t('profile_avatar_upload', locale)}
          </button>
          {profileData?.avatarUrl && (
            <button
              onClick={() => void handleAvatarDelete()}
              style={{ ...btnSecondary, width: '100%', color: C.red, borderColor: C.red + '40' }}
            >
              {t('profile_avatar_remove', locale)}
            </button>
          )}
          <button onClick={() => setShowAvatarSheet(false)} style={{ ...btnGhost, width: '100%' }}>
            {t('cancel', locale)}
          </button>
        </div>
      </BottomSheet>

      {/* Wishlist picker for item-scoped add-on purchases */}
      <BottomSheet
        isOpen={!!wishlistPickerSku}
        onClose={() => setWishlistPickerSku(null)}
        title={locale === 'ru' ? 'Выберите вишлист' : 'Choose a wishlist'}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 8 }}>
          <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 4 }}>
            {locale === 'ru'
              ? 'Для какого вишлиста добавить слоты желаний?'
              : 'Which wishlist should get extra item slots?'}
          </div>
          {wishlists.map(wl => {
            const extraSlots = addOns.extraItemsPerWishlist?.[wl.id] ?? 0;
            // Per-wishlist eligibility: capped if this specific wishlist+SKU hit the limit
            const isWlCapped = !!(wishlistPickerSku && wishlistCappedSkus[wl.id]?.includes(wishlistPickerSku));
            return (
              <button
                key={wl.id}
                onClick={() => {
                  if (isWlCapped) return; // already at max for this wishlist
                  const sku = wishlistPickerSku;
                  setWishlistPickerSku(null);
                  if (sku) void handleBuyAddon(sku, wl.id);
                }}
                disabled={addonCheckoutLoading || isWlCapped}
                style={{
                  background: isWlCapped ? C.card : C.surface,
                  border: `1px solid ${isWlCapped ? C.borderLight : C.border}`,
                  borderRadius: 12, padding: '12px 14px', textAlign: 'left',
                  cursor: isWlCapped ? 'default' : 'pointer', fontFamily: font,
                  display: 'flex', alignItems: 'center', gap: 10,
                  opacity: (addonCheckoutLoading || isWlCapped) ? 0.55 : 1,
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: isWlCapped ? C.textMuted : C.text }}>
                    {wl.title}
                  </div>
                  <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                    {wl.itemCount} {locale === 'ru' ? 'желаний' : 'wishes'}
                    {' · '}
                    {locale === 'ru' ? 'лимит' : 'limit'}: {planLimits.items + extraSlots}
                    {extraSlots > 0 && <span style={{ color: C.accent }}> (+{extraSlots})</span>}
                    {isWlCapped && (
                      <span style={{ color: C.textMuted }}> · {t('addon_wishlist_cap_label', locale)}</span>
                    )}
                  </div>
                </div>
                {isWlCapped
                  ? <div style={{ fontSize: 13, color: C.textMuted, flexShrink: 0 }}>✓</div>
                  : <div style={{ fontSize: 18, color: C.textMuted, flexShrink: 0 }}>›</div>}
              </button>
            );
          })}
          <button
            onClick={() => setWishlistPickerSku(null)}
            style={{ ...btnGhost, marginTop: 4 }}
          >
            {t('cancel', locale)}
          </button>
        </div>
      </BottomSheet>

      {/* Hidden avatar file input */}
      <input
        ref={avatarInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(e) => void handleAvatarFileSelect(e)}
      />

      {/* ── HINT CLOSING OVERLAY ── */}
      {hintClosing && (
        <>
          <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 200 }} />
          <div style={{
            position: 'fixed', inset: 0, zIndex: 201,
            display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{ fontSize: 40, animation: 'pulse 1s ease-in-out infinite' }}>💡</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginTop: 16, fontFamily: font }}>
              {t('hint_closing', locale)}
            </div>
          </div>
        </>
      )}

      {/* ══════════════════════════════════════════════
          SECRET SANTA — HUB
          ══════════════════════════════════════════════ */}
      {screen === 'santa-hub' && (() => {
        // ── Campaign grouping: active vs finished ──────────────────────────
        const FINISHED_STATUSES = new Set<string>(['COMPLETED', 'CANCELLED']);
        type HubCampaign = (typeof santaCampaigns.owned)[number];
        const withRole = (arr: HubCampaign[], role: 'organizer' | 'participant') =>
          arr.map(c => ({ ...c, _role: role }));

        const owned  = withRole(santaCampaigns.owned,  'organizer');
        const joined = withRole(santaCampaigns.joined, 'participant');
        const all    = [...owned, ...joined];

        const activeCamps   = all.filter(c => !FINISHED_STATUSES.has(c.status));
        const finishedCamps = all.filter(c =>  FINISHED_STATUSES.has(c.status));

        const openCampaign = async (id: string) => {
          const res = await tgFetch(`/tg/santa/campaigns/${id}`);
          if (res.ok) {
            const json = await res.json() as SantaCampaignDetail;
            setCurrentSantaCampaign(json);
            setScreen('santa-campaign');
          }
        };

        const CampaignCard = ({ c, dimmed = false }: { c: HubCampaign & { _role: 'organizer' | 'participant' }; dimmed?: boolean }) => (
          <button
            key={c.id}
            onClick={() => void openCampaign(c.id)}
            style={{
              background: C.card, border: 'none', borderRadius: 14,
              padding: '14px 16px', cursor: 'pointer', textAlign: 'left',
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              opacity: dimmed ? 0.65 : 1,
              transition: 'opacity 0.15s',
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', marginBottom: 3 }}>
                <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{c.title}</span>
                {/* Role pill */}
                <span style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
                  padding: '2px 6px', borderRadius: 5,
                  background: c._role === 'organizer' ? `${C.accent}18` : `${C.textMuted}14`,
                  color: c._role === 'organizer' ? C.accent : C.textMuted,
                  flexShrink: 0,
                }}>
                  {c._role === 'organizer'
                    ? (locale === 'ru' ? 'Организатор' : 'Organizer')
                    : (locale === 'ru' ? 'Участник'    : 'Member')}
                </span>
              </div>
              <div style={{ fontSize: 12, color: C.textMuted }}>
                {t('santa_campaign_participants', locale, { count: c.participantCount })}
                {' · '}
                <span style={dimmed ? { fontWeight: 600 } : {}}>
                  {t(`santa_campaign_status_${c.status.toLowerCase()}` as never, locale) || c.status}
                </span>
              </div>
            </div>
            <div style={{ color: C.textMuted, fontSize: 18, flexShrink: 0, paddingLeft: 8 }}>›</div>
          </button>
        );

        return (
          <div style={{ padding: '16px 20px 120px' }}>
            {/* ── Header with optional snowflakes ── */}
            <div style={{ position: 'relative', marginBottom: 24 }}>
              {santaSeason?.inSeason && <SnowflakeOverlay height={60} />}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'relative', zIndex: 1 }}>
                <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: font, color: C.text, margin: 0 }}>🎅 {t('santa_hub_title', locale)}</h1>
                {santaSeason?.canCreate && (
                  <button
                    onClick={() => {
                      setSantaCreateTitle(''); setSantaCreateDesc('');
                      setSantaCreateMinBudget(''); setSantaCreateMaxBudget('');
                      setScreen('santa-create');
                    }}
                    style={{ background: C.accent, border: 'none', borderRadius: 12, color: '#fff', fontSize: 14, fontWeight: 600, padding: '8px 16px', cursor: 'pointer', flexShrink: 0 }}
                  >
                    {t('santa_home_create_btn', locale)}
                  </button>
                )}
              </div>
            </div>

            {/* ── Loading ── */}
            {santaCampaignsLoading && (
              <div style={{ color: C.textMuted, fontSize: 14, textAlign: 'center', padding: 40 }}>{t('loading', locale)}</div>
            )}

            {/* ── Empty state ── */}
            {!santaCampaignsLoading && all.length === 0 && (
              <div style={{ background: C.card, borderRadius: 16, padding: 24, textAlign: 'center' }}>
                <div style={{ fontSize: 40, marginBottom: 12 }}>🎁</div>
                <div style={{ color: C.textMuted, fontSize: 14 }}>{t('santa_home_empty', locale)}</div>
                {santaSeason?.canCreate && (
                  <button
                    onClick={() => setScreen('santa-create')}
                    style={{ marginTop: 16, background: C.accent, border: 'none', borderRadius: 12, color: '#fff', fontSize: 15, fontWeight: 600, padding: '12px 24px', cursor: 'pointer' }}
                  >
                    {t('santa_home_create_btn', locale)}
                  </button>
                )}
              </div>
            )}

            {/* ── Active campaigns ── */}
            {!santaCampaignsLoading && activeCamps.length > 0 && (
              <div style={{ marginBottom: finishedCamps.length > 0 ? 28 : 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  {locale === 'ru' ? 'Активные' : 'Active'}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {activeCamps.map(c => <CampaignCard key={c.id} c={c} />)}
                </div>
              </div>
            )}

            {/* ── Finished campaigns ── */}
            {!santaCampaignsLoading && finishedCamps.length > 0 && (
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  {locale === 'ru' ? 'Завершённые' : 'Finished'}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {finishedCamps.map(c => <CampaignCard key={c.id} c={c} dimmed />)}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════
          SECRET SANTA — CREATE
          ══════════════════════════════════════════════ */}
      {screen === 'santa-create' && (
        <div style={{ padding: '16px 20px 120px' }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: font, color: C.text, marginTop: 8, marginBottom: 24 }}>
            {t('santa_create_title', locale)}
          </h1>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, display: 'block', marginBottom: 6 }}>{t('santa_create_name_label', locale)}</label>
              <input
                value={santaCreateTitle}
                onChange={e => setSantaCreateTitle(e.target.value)}
                placeholder={t('santa_create_name_placeholder', locale)}
                maxLength={80}
                style={{ width: '100%', background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: '12px 16px', fontSize: 15, color: C.text, fontFamily: font, boxSizing: 'border-box' }}
              />
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, display: 'block', marginBottom: 6 }}>{t('santa_create_desc_label', locale)}</label>
              <textarea
                value={santaCreateDesc}
                onChange={e => setSantaCreateDesc(e.target.value)}
                placeholder={t('santa_create_desc_placeholder', locale)}
                maxLength={500}
                rows={3}
                style={{ width: '100%', background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: '12px 16px', fontSize: 14, color: C.text, fontFamily: font, boxSizing: 'border-box', resize: 'none' }}
              />
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, display: 'block', marginBottom: 6 }}>{t('santa_create_budget_min', locale)}</label>
                <input
                  type="number"
                  value={santaCreateMinBudget}
                  onChange={e => setSantaCreateMinBudget(e.target.value)}
                  placeholder="0"
                  min={0}
                  style={{ width: '100%', background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: '12px 16px', fontSize: 15, color: C.text, fontFamily: font, boxSizing: 'border-box' }}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, display: 'block', marginBottom: 6 }}>{t('santa_create_budget_max', locale)}</label>
                <input
                  type="number"
                  value={santaCreateMaxBudget}
                  onChange={e => setSantaCreateMaxBudget(e.target.value)}
                  placeholder="0"
                  min={0}
                  style={{ width: '100%', background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: '12px 16px', fontSize: 15, color: C.text, fontFamily: font, boxSizing: 'border-box' }}
                />
              </div>
            </div>
            <div>
              <label style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, display: 'block', marginBottom: 6 }}>{t('santa_create_currency_label', locale)}</label>
              <div style={{ display: 'flex', gap: 8 }}>
                {(['RUB', 'USD'] as const).map(cur => (
                  <button
                    key={cur}
                    onClick={() => setSantaCreateCurrency(cur)}
                    style={{
                      flex: 1, padding: '10px 0', borderRadius: 12, border: `2px solid ${santaCreateCurrency === cur ? C.accent : C.border}`,
                      background: santaCreateCurrency === cur ? `${C.accent}20` : C.card,
                      color: santaCreateCurrency === cur ? C.accent : C.textMuted,
                      fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: font,
                    }}
                  >
                    {cur === 'RUB' ? '₽ RUB' : '$ USD'}
                  </button>
                ))}
              </div>
            </div>
            <button
              disabled={!santaCreateTitle.trim() || santaCreateLoading}
              onClick={async () => {
                if (!santaCreateTitle.trim()) return;
                setSantaCreateLoading(true);
                try {
                  const body: Record<string, unknown> = { title: santaCreateTitle.trim(), currency: santaCreateCurrency };
                  if (santaCreateDesc.trim()) body.description = santaCreateDesc.trim();
                  if (santaCreateMinBudget) body.minBudget = parseInt(santaCreateMinBudget, 10);
                  if (santaCreateMaxBudget) body.maxBudget = parseInt(santaCreateMaxBudget, 10);
                  const res = await tgFetch('/tg/santa/campaigns', { method: 'POST', body: JSON.stringify(body) });
                  if (res.ok) {
                    const json = await res.json() as { campaign: SantaCampaignSummary };
                    // Open the campaign immediately
                    const detailRes = await tgFetch(`/tg/santa/campaigns/${json.campaign.id}`);
                    if (detailRes.ok) {
                      const detail = await detailRes.json() as SantaCampaignDetail;
                      setCurrentSantaCampaign(detail);
                    }
                    setSantaCampaigns(prev => ({ ...prev, owned: [{ ...json.campaign, participantCount: 0 }, ...prev.owned] }));
                    pushToast(t('done', locale), 'success');
                    setScreen('santa-campaign');
                  } else {
                    pushToast(t('error_generic', locale), 'error');
                  }
                } catch {
                  pushToast(t('error_network', locale), 'error');
                } finally {
                  setSantaCreateLoading(false);
                }
              }}
              style={{
                background: !santaCreateTitle.trim() || santaCreateLoading ? C.textMuted : C.accent,
                border: 'none', borderRadius: 14, color: '#fff', fontSize: 15, fontWeight: 700,
                padding: '14px 0', cursor: !santaCreateTitle.trim() || santaCreateLoading ? 'not-allowed' : 'pointer',
                fontFamily: font, width: '100%',
              }}
            >
              {santaCreateLoading ? t('loading', locale) : t('santa_create_submit', locale)}
            </button>
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════
          SECRET SANTA — CAMPAIGN DETAIL
          ══════════════════════════════════════════════ */}
      {screen === 'santa-campaign' && currentSantaCampaign && (() => {
        const camp = currentSantaCampaign.campaign;
        const participants = currentSantaCampaign.participants;
        const myAssignment = currentSantaCampaign.myAssignment;
        const myAlias = currentSantaCampaign.myAlias;
        const isOwner = camp.isOwner;
        const isOrg = camp.isOrganizer;
        const myRole = currentSantaCampaign.myRole;
        const pendingExitRequestId = currentSantaCampaign.pendingExitRequestId;
        const pendingExitRequestCount = currentSantaCampaign.pendingExitRequestCount ?? 0;
        const { currentRoundNumber, totalRounds } = currentSantaCampaign;
        const showRoundBadge = (currentRoundNumber ?? 0) > 1 || totalRounds > 1;
        // canStartNextRound: all ownerProgress assignments are in terminal states (RECEIVED | MISSED_DEADLINE | ORPHANED)
        const ownerProgress = currentSantaCampaign.ownerProgress?.progress;
        const totalAssignments = ownerProgress
          ? ownerProgress.pending + ownerProgress.buying + ownerProgress.selectedFromWishlist +
            ownerProgress.selectedOutside + ownerProgress.declinedToSay +
            ownerProgress.sent + ownerProgress.received + ownerProgress.missedDeadline + (ownerProgress.orphaned ?? 0)
          : 0;
        const terminalCount = ownerProgress
          ? ownerProgress.received + ownerProgress.missedDeadline + (ownerProgress.orphaned ?? 0)
          : 0;
        const isRoundComplete = totalAssignments > 0 && terminalCount === totalAssignments;
        const canStartNextRound = isOwner && isRoundComplete && camp.status === 'ACTIVE';
        const statusKey = `santa_campaign_status_${camp.status.toLowerCase().replace('_', '_')}` as string;

        const copyInviteLink = () => {
          const botLink = `https://t.me/${botUsername}?start=santa_${camp.inviteToken}`;
          void navigator.clipboard.writeText(botLink).then(() => pushToast(t('santa_campaign_invite_copied', locale), 'success'));
        };

        return (
          <div style={{ padding: '16px 20px 120px' }}>
            <div style={{ marginBottom: 20 }}>
              <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: font, color: C.text, margin: '8px 0 4px' }}>{camp.title}</h1>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 8,
                  background: camp.status === 'ACTIVE' ? C.greenSoft : camp.status === 'CANCELLED' ? C.redSoft : `${C.accent}20`,
                  color: camp.status === 'ACTIVE' ? C.green : camp.status === 'CANCELLED' ? C.red : C.accent,
                }}>
                  {t(statusKey, locale) || camp.status}
                </span>
                {isOwner && <span style={{ fontSize: 12, color: C.textMuted }}>👑 {locale === 'ru' ? 'Владелец' : 'Owner'}</span>}
                {!isOwner && myRole === 'ADMIN' && <span style={{ fontSize: 12, color: C.accent }}>{t('santa_organizer_badge', locale)}</span>}
                {showRoundBadge && currentRoundNumber && (
                  <span style={{ fontSize: 12, fontWeight: 600, color: C.accent, background: `${C.accent}15`, padding: '3px 10px', borderRadius: 8 }}>
                    {totalRounds > 1
                      ? t('santa_round_of', locale, { current: String(currentRoundNumber), total: String(totalRounds) })
                      : t('santa_round_label', locale, { n: String(currentRoundNumber) })}
                  </span>
                )}
              </div>
              {camp.description && (
                <p style={{ fontSize: 14, color: C.textSec, marginTop: 8, lineHeight: 1.5 }}>{camp.description}</p>
              )}
              {(camp.minBudget || camp.maxBudget) && (
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>
                  {camp.minBudget && camp.maxBudget
                    ? t('santa_campaign_budget', locale, { min: camp.minBudget, max: camp.maxBudget, currency: camp.currency })
                    : camp.minBudget
                      ? t('santa_campaign_budget_from', locale, { min: camp.minBudget, currency: camp.currency })
                      : t('santa_campaign_budget_to', locale, { max: camp.maxBudget!, currency: camp.currency })}
                </div>
              )}
            </div>

            {/* Pending exit request banner (for participant who submitted a request) */}
            {pendingExitRequestId && (
              <div style={{ background: `${C.accent}15`, border: `1px solid ${C.accent}40`, borderRadius: 12, padding: '12px 16px', marginBottom: 12, fontSize: 13, color: C.accent, textAlign: 'center' }}>
                ⏳ {t('santa_exit_request_pending_banner', locale)}
              </div>
            )}

            {/* Organizer controls */}
            {isOrg && camp.status !== 'COMPLETED' && camp.status !== 'CANCELLED' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
                {camp.status === 'DRAFT' && (
                  <button
                    onClick={async () => {
                      const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/open`, { method: 'POST' });
                      if (res.ok) {
                        const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                        if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                        pushToast(t('done', locale), 'success');
                      } else pushToast(t('error_generic', locale), 'error');
                    }}
                    style={{ background: C.accent, border: 'none', borderRadius: 12, color: '#fff', fontSize: 14, fontWeight: 600, padding: '12px 0', cursor: 'pointer', fontFamily: font }}
                  >
                    {t('santa_campaign_open_btn', locale)}
                  </button>
                )}
                {camp.status === 'OPEN' && participants.filter(p => p.status === 'JOINED').length >= 2 && (
                  <button
                    onClick={async () => {
                      const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/lock`, { method: 'POST' });
                      if (res.ok) {
                        const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                        if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                        pushToast(t('done', locale), 'success');
                      } else pushToast(t('error_generic', locale), 'error');
                    }}
                    style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, color: C.text, fontSize: 14, fontWeight: 600, padding: '12px 0', cursor: 'pointer', fontFamily: font }}
                  >
                    {t('santa_campaign_lock_btn', locale)}
                  </button>
                )}

                {/* Draw controls — owner-only when LOCKED */}
                {isOwner && camp.status === 'LOCKED' && (
                  <div style={{ background: C.card, borderRadius: 14, padding: 16 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, marginBottom: 10 }}>
                      {locale === 'ru' ? 'Жеребьёвка' : 'Draw'}
                    </div>

                    {/* Validate button */}
                    {!santaDrawValidation && (
                      <button
                        disabled={santaDrawValidationLoading}
                        onClick={async () => {
                          setSantaDrawValidationLoading(true);
                          const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/draw/validate`);
                          if (res.ok) setSantaDrawValidation(await res.json() as typeof santaDrawValidation);
                          else pushToast(t('error_generic', locale), 'error');
                          setSantaDrawValidationLoading(false);
                        }}
                        style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, color: C.text, fontSize: 13, fontWeight: 600, padding: '10px 0', cursor: santaDrawValidationLoading ? 'wait' : 'pointer', width: '100%', fontFamily: font }}
                      >
                        {santaDrawValidationLoading ? t('loading', locale) : t('santa_draw_validate_btn', locale)}
                      </button>
                    )}

                    {/* Validation result */}
                    {santaDrawValidation && (
                      <div style={{ marginBottom: 10 }}>
                        {santaDrawValidation.feasible ? (
                          <div style={{ fontSize: 13, color: C.green, marginBottom: 8 }}>
                            ✓ {t('santa_draw_feasible', locale, { count: santaDrawValidation.participantCount ?? 0 })}
                          </div>
                        ) : (
                          <div style={{ fontSize: 13, color: C.red, marginBottom: 8 }}>
                            ✗ {t('santa_draw_infeasible', locale)}
                            {santaDrawValidation.problematicExclusions && santaDrawValidation.problematicExclusions.length > 0 && (
                              <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>
                                {t('santa_draw_infeasible_hint', locale, {
                                  names: santaDrawValidation.problematicExclusions.map(e => {
                                    const base = `${e.name1} & ${e.name2}`;
                                    return e.groupLabel ? `${base} (${t('santa_draw_infeasible_group', locale, { label: e.groupLabel })})` : base;
                                  }).join(', '),
                                })}
                              </div>
                            )}
                          </div>
                        )}
                        <button
                          onClick={() => setSantaDrawValidation(null)}
                          style={{ background: 'none', border: 'none', color: C.textMuted, fontSize: 12, cursor: 'pointer', padding: 0 }}
                        >
                          {locale === 'ru' ? 'Перепроверить' : 'Re-check'}
                        </button>
                      </div>
                    )}

                    {/* Run draw button — enabled only if validated feasible */}
                    <button
                      disabled={santaDrawLoading || (santaDrawValidation !== null && !santaDrawValidation.feasible)}
                      onClick={async () => {
                        if (!confirm(locale === 'ru' ? `Запустить жеребьёвку для ${participants.filter(p => p.status === 'JOINED').length} участников?` : `Run draw for ${participants.filter(p => p.status === 'JOINED').length} participants?`)) return;
                        setSantaDrawLoading(true);
                        const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/draw`, { method: 'POST' });
                        setSantaDrawLoading(false);
                        if (res.ok) {
                          const json = await res.json() as { assignmentCount: number };
                          setSantaDrawValidation(null);
                          pushToast(t('santa_draw_success', locale, { count: json.assignmentCount }), 'success');
                          const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                          if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                        } else {
                          const err = await res.json() as { error: string; reason?: string; problematicExclusions?: { userId1: string; name1: string; userId2: string; name2: string }[] };
                          if (err.error === 'draw_already_running') pushToast(t('santa_draw_already_running', locale), 'error');
                          else if (err.error === 'draw_infeasible') {
                            setSantaDrawValidation({ feasible: false, reason: err.reason, problematicExclusions: err.problematicExclusions });
                            pushToast(t('santa_draw_infeasible', locale), 'error');
                          } else pushToast(t('santa_draw_failed', locale), 'error');
                        }
                      }}
                      style={{
                        background: santaDrawLoading || (santaDrawValidation !== null && !santaDrawValidation.feasible)
                          ? C.textMuted : C.accent,
                        border: 'none', borderRadius: 10, color: '#fff', fontSize: 14, fontWeight: 700,
                        padding: '12px 0', cursor: santaDrawLoading ? 'wait' : 'pointer', width: '100%', fontFamily: font, marginTop: 4,
                      }}
                    >
                      {santaDrawLoading ? t('santa_draw_in_progress', locale) : t('santa_draw_btn', locale)}
                    </button>
                  </div>
                )}

                {camp.status === 'DRAW_IN_PROGRESS' && (
                  <div style={{ background: `${C.accent}15`, borderRadius: 12, padding: '12px 16px', fontSize: 13, color: C.accent, fontWeight: 600, textAlign: 'center' }}>
                    ⏳ {t('santa_draw_in_progress', locale)}
                  </div>
                )}
              </div>
            )}

            {/* Invite link (owner only, OPEN campaigns) */}
            {isOwner && camp.inviteToken && ['DRAFT', 'OPEN'].includes(camp.status) && (
              <div style={{ background: C.card, borderRadius: 14, padding: '14px 16px', marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, marginBottom: 8 }}>{t('santa_campaign_invite_link', locale)}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, color: C.textSec, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {`t.me/${botUsername}?start=santa_${camp.inviteToken}`}
                  </span>
                  <button onClick={copyInviteLink} style={{ background: C.accent, border: 'none', borderRadius: 8, color: '#fff', fontSize: 12, fontWeight: 600, padding: '6px 12px', cursor: 'pointer', flexShrink: 0 }}>
                    {t('copy', locale)}
                  </button>
                </div>
              </div>
            )}

            {/* My alias — shown after draw, to all participants including organizer */}
            {myAlias && (
              <div style={{ background: `${C.accent}12`, borderRadius: 14, padding: '12px 16px', marginBottom: 16, border: `1px solid ${C.accent}30` }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <SantaAvatar alias={myAlias.alias} emoji={myAlias.emoji} size={40} hat={santaSeason?.inSeason} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 2 }}>
                      {locale === 'ru' ? 'Твоё имя в этой жеребьёвке' : 'Your name in this round'}
                    </div>
                    <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>
                      {renderSantaAlias(myAlias.adjectiveKey, myAlias.animalKey, locale) || myAlias.alias}
                    </div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                      {locale === 'ru'
                        ? 'Имя меняется автоматически в каждом новом раунде'
                        : 'Name changes automatically each new round'}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Participants */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                {t('santa_campaign_participants', locale, { count: participants.filter(p => p.status === 'JOINED').length })}
              </div>
              <div style={{ background: C.card, borderRadius: 14, overflow: 'hidden' }}>
                {participants.filter(p => p.status === 'JOINED').map((p, idx) => (
                  <div
                    key={p.id}
                    style={{
                      padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10,
                      borderBottom: idx < participants.filter(px => px.status === 'JOINED').length - 1 ? `1px solid ${C.border}` : 'none',
                    }}
                  >
                    <SantaAvatar alias={p.displayName || p.id} emoji={p.emoji || '🎅'} size={32} hat={santaSeason?.inSeason} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
                          {renderSantaAlias(p.adjectiveKey, p.animalKey, locale) || p.displayName || (locale === 'ru' ? 'Участник' : 'Participant')}
                          {p.isMe && <span style={{ fontSize: 11, color: C.textMuted, marginLeft: 4 }}>({locale === 'ru' ? 'я' : 'me'})</span>}
                        </span>
                        {p.role === 'ADMIN' && (
                          <span style={{ fontSize: 11, fontWeight: 700, color: C.accent, background: `${C.accent}15`, padding: '1px 6px', borderRadius: 6 }}>
                            {t('santa_role_admin', locale)}
                          </span>
                        )}
                      </div>
                      {p.hasLinkedWishlist && <div style={{ fontSize: 12, color: C.green }}>🎁 {t('santa_wishlist_linked_label', locale)}</div>}
                    </div>
                    {/* Role management (owner only) */}
                    {isOwner && !p.isMe && (
                      <button
                        onClick={async () => {
                          const newRole = p.role === 'ADMIN' ? 'PARTICIPANT' : 'ADMIN';
                          const aliasName = renderSantaAlias(p.adjectiveKey, p.animalKey, locale) || p.displayName || p.id;
                          const confirmMsg = newRole === 'ADMIN'
                            ? t('santa_role_promote_confirm', locale, { name: aliasName })
                            : t('santa_role_demote_confirm', locale, { name: aliasName });
                          if (!confirm(confirmMsg)) return;
                          const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/participants/${p.userId}/role`, {
                            method: 'PATCH',
                            body: JSON.stringify({ role: newRole }),
                          });
                          if (res.ok) {
                            const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                            if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                            pushToast(t('done', locale), 'success');
                          } else pushToast(t('error_generic', locale), 'error');
                        }}
                        style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 8, padding: '4px 8px', fontSize: 11, color: C.textMuted, cursor: 'pointer', fontFamily: font, flexShrink: 0 }}
                        title={p.role === 'ADMIN' ? t('santa_role_demote', locale) : t('santa_role_promote', locale)}
                      >
                        {p.role === 'ADMIN' ? '🛡✕' : '🛡+'}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Organizer progress view (post-draw) — aggregate only, no individual pairs */}
            {isOrg && currentSantaCampaign.ownerProgress && ['ACTIVE', 'COMPLETED'].includes(camp.status) && (
              <div style={{ background: C.card, borderRadius: 14, padding: 16, marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, marginBottom: 12 }}>
                  {t('santa_gift_status_title', locale)}
                </div>
                {(() => {
                  const p = currentSantaCampaign.ownerProgress!.progress;
                  const total = p.pending + p.buying + p.selectedFromWishlist + p.selectedOutside
                    + p.declinedToSay + p.missedDeadline + p.sent + p.received + (p.orphaned ?? 0);
                  const allTerminal = total > 0 && p.pending === 0 && p.buying === 0 && p.selectedFromWishlist === 0
                    && p.selectedOutside === 0 && p.declinedToSay === 0 && p.sent === 0;
                  return (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {allTerminal && (
                        <div style={{ fontSize: 14, fontWeight: 700, color: C.green, marginBottom: 4 }}>
                          {t('santa_gift_all_received', locale)}
                        </div>
                      )}
                      {[
                        { key: 'pending', count: p.pending, label: t('santa_gift_progress_pending', locale, { count: p.pending, total }), color: C.textSec },
                        { key: 'missed', count: p.missedDeadline, label: t('santa_gift_progress_missed_deadline', locale, { count: p.missedDeadline }), color: '#e05' },
                        { key: 'orphaned', count: p.orphaned ?? 0, label: t('santa_gift_status_orphaned', locale), color: C.textMuted },
                        { key: 'buying', count: p.buying, label: t('santa_gift_progress_buying', locale, { count: p.buying }), color: C.textSec },
                        { key: 'wishlist', count: p.selectedFromWishlist, label: t('santa_gift_progress_selected_wishlist', locale, { count: p.selectedFromWishlist }), color: C.accent },
                        { key: 'outside', count: p.selectedOutside, label: t('santa_gift_progress_selected_outside', locale, { count: p.selectedOutside }), color: C.accent },
                        { key: 'declined', count: p.declinedToSay, label: t('santa_gift_progress_declined', locale, { count: p.declinedToSay }), color: C.textSec },
                        { key: 'sent', count: p.sent, label: t('santa_gift_progress_sent', locale, { count: p.sent }), color: C.accent },
                        { key: 'received', count: p.received, label: t('santa_gift_progress_received', locale, { count: p.received }), color: C.green },
                        { key: 'noWishlist', count: p.withoutWishlist, label: t('santa_gift_progress_without_wishlist', locale, { count: p.withoutWishlist }), color: C.textMuted },
                      ].filter(row => row.count > 0).map(row => (
                        <div key={row.key} style={{ fontSize: 13, color: row.color }}>{row.label}</div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* ══ MY WISHLIST — Prominent block, visible to all JOINED participants ══ */}
            {(() => {
              const me = participants.find(p => p.isMe);
              if (!me || me.status !== 'JOINED') return null;
              // isReadOnly only for terminal states; ACTIVE allows late linking (backend supports it)
              const isReadOnly = ['COMPLETED', 'CANCELLED'].includes(camp.status);
              return (
                <div style={{ background: C.card, borderRadius: 14, padding: 16, marginBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, marginBottom: 10 }}>
                    🎁 {t('santa_my_wishlist_section', locale)}
                  </div>
                  {me.linkedWishlist ? (
                    // State B: wishlist linked — only show status, never the title
                    <div>
                      <div style={{ fontSize: 13, color: C.green, marginBottom: 8 }}>
                        ✓ {t('santa_wishlist_linked_label', locale)}
                      </div>
                      {isReadOnly ? (
                        <div style={{ fontSize: 12, color: C.green }}>✓ {t('santa_wishlist_linked_label', locale)}</div>
                      ) : (
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <button
                            onClick={() => { setSantaWishlistPickerReturnId(camp.id); setScreen('my-wishlists'); }}
                            style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, color: C.text, fontSize: 13, fontWeight: 600, padding: '8px 14px', cursor: 'pointer', fontFamily: font }}
                          >
                            {t('santa_wishlist_open', locale)}
                          </button>
                          <button
                            onClick={() => setShowSantaWishlistPicker(true)}
                            style={{ background: 'none', border: 'none', color: C.accent, fontSize: 13, fontWeight: 600, cursor: 'pointer', padding: '8px 0' }}
                          >
                            {t('santa_wishlist_change', locale)}
                          </button>
                        </div>
                      )}
                    </div>
                  ) : isReadOnly ? (
                    // Terminal state, no wishlist linked — informational only
                    <div style={{ fontSize: 13, color: C.textMuted }}>
                      {t('santa_campaign_wishlist_not_linked_active', locale)}
                    </div>
                  ) : (
                    // State A: no wishlist linked, campaign is editable
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <div style={{ fontSize: 13, color: C.textMuted }}>
                        {t('santa_wishlist_not_linked', locale)}
                      </div>
                      <button
                        onClick={() => setShowSantaWishlistPicker(true)}
                        style={{ background: C.accent, border: 'none', borderRadius: 12, color: '#fff', fontSize: 14, fontWeight: 600, padding: '12px 16px', cursor: 'pointer', width: '100%', fontFamily: font }}
                      >
                        {t('santa_wishlist_select_from_mine', locale)}
                      </button>
                      <button
                        onClick={() => { setSantaWishlistPickerReturnId(camp.id); setShowSantaWishlistPicker(false); setScreen('my-wishlists'); }}
                        style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, color: C.text, fontSize: 13, fontWeight: 600, padding: '10px 16px', cursor: 'pointer', width: '100%', fontFamily: font }}
                      >
                        {t('santa_wishlist_picker_create_new', locale)}
                      </button>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Giver view (post-draw) — role: giver, no receiverUserId/participantId exposed */}
            {myAssignment && myAssignment.role === 'giver' && ['ACTIVE', 'COMPLETED'].includes(camp.status) && (
              <div style={{ background: C.card, borderRadius: 14, padding: 16, marginBottom: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, marginBottom: 8 }}>
                  {t('santa_gift_my_recipient', locale)}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
                  <SantaAvatar alias={myAssignment.receiver.displayName} emoji={myAssignment.receiver.emoji || '🎅'} size={36} hat={santaSeason?.inSeason} />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
                      {renderSantaAlias(myAssignment.receiver.adjectiveKey, myAssignment.receiver.animalKey, locale) || myAssignment.receiver.displayName}
                    </div>
                    <div style={{ fontSize: 12, color: C.textMuted }}>
                      {t(`santa_gift_status_${myAssignment.giftStatus.toLowerCase()}` as never, locale) || myAssignment.giftStatus}
                    </div>
                  </div>
                </div>

                {/* Gift status controls — Batch 3: 3-choice giver flow */}
                {myAssignment.giftStatus !== 'RECEIVED' && (() => {
                  const gs = myAssignment.giftStatus;
                  const canChoose = ['PENDING', 'BUYING', 'MISSED_DEADLINE'].includes(gs);
                  const hasChosen = ['SELECTED_FROM_WISHLIST', 'SELECTED_OUTSIDE', 'DECLINED_TO_SAY'].includes(gs);
                  const isSent = gs === 'SENT';

                  const updateStatus = async (status: string) => {
                    if (status === gs) return; // M2: no-op on self-transition — avoids 409 on tapping active button
                    const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/gift-status`, { method: 'PATCH', body: JSON.stringify({ status }) });
                    if (res.ok) {
                      const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                      if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                    }
                  };

                  const btnStyle = (accent?: boolean) => ({
                    background: accent ? C.accent : C.surface,
                    border: accent ? 'none' : `1px solid ${C.border}`,
                    borderRadius: 10,
                    color: accent ? '#fff' : C.text,
                    fontSize: 13,
                    fontWeight: 600,
                    padding: '8px 14px',
                    cursor: 'pointer',
                    fontFamily: font,
                  } as React.CSSProperties);

                  // Helper: handle switch-away from wishlist with confirm modal if reservations exist
                  const handleSwitchFromWishlist = async (newStatus: string) => {
                    const hasReservations = (myAssignment.reservedItems?.length ?? 0) > 0;
                    if (hasReservations && gs === 'SELECTED_FROM_WISHLIST') {
                      setSantaSwitchModalOpen(true);
                      return;
                    }
                    await updateStatus(newStatus);
                  };

                  return (
                    <div style={{ marginBottom: 12 }}>
                      {/* Current status label */}
                      <div style={{ fontSize: 12, color: gs === 'MISSED_DEADLINE' ? '#e05' : C.textMuted, marginBottom: 8 }}>
                        {t('santa_gift_status_title', locale)}: <b>{t(`santa_gift_status_${gs.toLowerCase()}` as never, locale) || gs}</b>
                      </div>

                      {/* Reserved items summary badge */}
                      {(myAssignment.reservedItems?.length ?? 0) > 0 && (
                        <div style={{ fontSize: 12, color: C.accent, background: C.accentSoft, borderRadius: 8, padding: '4px 10px', marginBottom: 8, display: 'inline-block' }}>
                          {myAssignment.reservedItems.length === 1
                            ? t('santa_wishlist_my_reservations_one', locale).replace('{{title}}', myAssignment.reservedItems[0]?.title ?? '')
                            : t('santa_wishlist_my_reservations_many', locale).replace('{{n}}', String(myAssignment.reservedItems.length))}
                        </div>
                      )}

                      {/* 3-choice buttons when undecided or coming from legacy BUYING / missed deadline */}
                      {(canChoose || hasChosen) && !isSent && (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {(canChoose || hasChosen) && (
                            <>
                              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 2 }}>
                                {t('santa_gift_choose_title', locale)}
                              </div>
                              {/* P0.3: show note if receiver has no wishlist */}
                              {!myAssignment.receiver.hasLinkedWishlist && (
                                <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4 }}>
                                  ⚠️ {t('santa_campaign_receiver_no_wishlist_yet', locale)}
                                </div>
                              )}
                              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                {/* Wishlist button: opens Santa-safe wishlist screen */}
                                <button
                                  onClick={async () => {
                                    if (!myAssignment.receiver.hasLinkedWishlist) return;
                                    setSantaReceiverWishlistLoading(true);
                                    const r = await tgFetch(`/tg/santa/campaigns/${camp.id}/inbound/wishlist`);
                                    if (r.ok) setSantaReceiverWishlist(await r.json() as typeof santaReceiverWishlist);
                                    setSantaReceiverWishlistLoading(false);
                                    setScreen('santa-receiver-wishlist');
                                  }}
                                  disabled={!myAssignment.receiver.hasLinkedWishlist || santaReceiverWishlistLoading}
                                  style={{ ...btnStyle(gs === 'SELECTED_FROM_WISHLIST'), fontSize: 12, opacity: myAssignment.receiver.hasLinkedWishlist ? 1 : 0.4, cursor: myAssignment.receiver.hasLinkedWishlist ? 'pointer' : 'not-allowed' }}
                                >
                                  📋 {santaReceiverWishlistLoading ? t('loading', locale) : t('santa_gift_mark_selected_from_wishlist', locale)}
                                </button>
                                <button
                                  onClick={() => handleSwitchFromWishlist('SELECTED_OUTSIDE')}
                                  style={{ ...btnStyle(gs === 'SELECTED_OUTSIDE'), fontSize: 12 }}
                                >
                                  🛍 {t('santa_gift_mark_selected_outside', locale)}
                                </button>
                                <button
                                  onClick={() => handleSwitchFromWishlist('DECLINED_TO_SAY')}
                                  style={{ ...btnStyle(gs === 'DECLINED_TO_SAY'), fontSize: 12 }}
                                >
                                  🎁 {t('santa_gift_mark_declined_to_say', locale)}
                                </button>
                              </div>
                            </>
                          )}
                          {/* Mark sent — available from any non-terminal state except PENDING/MISSED_DEADLINE */}
                          {(hasChosen || gs === 'BUYING') && (
                            <button
                              onClick={async () => {
                                if (!window.confirm(t('santa_gift_mark_sent_confirm', locale))) return;
                                await updateStatus('SENT');
                              }}
                              style={{ ...btnStyle(true), marginTop: 4 }}
                            >
                              📦 {t('santa_gift_mark_sent', locale)}
                            </button>
                          )}
                        </div>
                      )}

                      {/* Sent confirmation state */}
                      {isSent && (
                        <div style={{ fontSize: 13, color: C.green, fontWeight: 600 }}>
                          ✓ {t('santa_campaign_gift_status_sent', locale)}
                        </div>
                      )}

                      {/* Confirm modal: switch away from wishlist reservations */}
                      {santaSwitchModalOpen && (
                        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
                          onClick={() => setSantaSwitchModalOpen(false)}>
                          <div style={{ background: C.card, borderRadius: '16px 16px 0 0', padding: '24px 20px 32px', width: '100%', maxWidth: 480 }}
                            onClick={e => e.stopPropagation()}>
                            <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>
                              {t('santa_wishlist_switch_modal_title', locale)}
                            </div>
                            <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 20 }}>
                              {t('santa_wishlist_switch_modal_body', locale)}
                            </div>
                            <button
                              onClick={async () => {
                                setSantaSwitchModalOpen(false);
                                await updateStatus('SELECTED_OUTSIDE');
                              }}
                              style={{ ...btnPrimary, background: '#e05050', marginBottom: 10 }}
                            >
                              {t('santa_wishlist_switch_confirm', locale)}
                            </button>
                            <button onClick={() => setSantaSwitchModalOpen(false)} style={btnSecondary}>
                              {t('cancel', locale)}
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* View receiver's wishlist — opens dedicated Santa-safe wishlist screen */}
                {currentSantaCampaign.myAssignment?.receiver.hasLinkedWishlist ? (
                  <button
                    disabled={santaReceiverWishlistLoading}
                    onClick={async () => {
                      setSantaReceiverWishlistLoading(true);
                      const r = await tgFetch(`/tg/santa/campaigns/${camp.id}/inbound/wishlist`);
                      if (r.ok) setSantaReceiverWishlist(await r.json() as typeof santaReceiverWishlist);
                      setSantaReceiverWishlistLoading(false);
                      setScreen('santa-receiver-wishlist');
                    }}
                    style={{ background: 'none', border: `1px solid ${C.accent}`, borderRadius: 10, color: C.accent, fontSize: 13, fontWeight: 600, padding: '8px 16px', cursor: santaReceiverWishlistLoading ? 'wait' : 'pointer', width: '100%', fontFamily: font }}
                  >
                    {santaReceiverWishlistLoading ? t('loading', locale) : `📋 ${t('santa_campaign_receiver_wishlist', locale)}`}
                  </button>
                ) : (
                  <div style={{ fontSize: 13, color: C.textMuted, textAlign: 'center', padding: '8px 0' }}>
                    {t('santa_campaign_receiver_no_wishlist_yet', locale)}
                  </div>
                )}

                {/* ── Hint section (Batch 2.5) — giver requests anonymous wishlist hint ── */}
                {camp.status === 'ACTIVE' && (
                  <div style={{ marginTop: 12, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
                    {/* No hint yet — show request button */}
                    {!santaHintRequest && (
                      <button
                        disabled={santaHintRequestLoading}
                        onClick={async () => {
                          setSantaHintRequestLoading(true);
                          const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/hints`, { method: 'POST' });
                          if (res.ok) {
                            const data = await res.json() as typeof santaHintRequest;
                            setSantaHintRequest(data);
                          } else {
                            const err = await res.json() as { error?: string };
                            if (err.error === 'pro_required') pushToast(t('santa_hint_pro_required', locale), 'error');
                            else if (err.error === 'receiver_no_wishlist') pushToast(t('santa_hint_no_wishlist', locale), 'error');
                            else pushToast(t('error_generic', locale), 'error');
                          }
                          setSantaHintRequestLoading(false);
                        }}
                        style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 10, color: C.textSec, fontSize: 13, padding: '8px 16px', cursor: santaHintRequestLoading ? 'wait' : 'pointer', width: '100%', fontFamily: font }}
                      >
                        {santaHintRequestLoading ? t('loading', locale) : `💡 ${t('santa_hint_request_btn', locale)}`}
                      </button>
                    )}

                    {/* Hint exists — show status */}
                    {santaHintRequest && (
                      <div>
                        <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 6 }}>💡</div>
                        {santaHintRequest.status === 'PENDING' && (
                          <div style={{ fontSize: 13, color: C.textSec }}>{t('santa_hint_pending', locale)}</div>
                        )}
                        {santaHintRequest.status === 'FULFILLED' && (
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 600, color: C.green, marginBottom: 8 }}>✓ {t('santa_hint_fulfilled', locale)}</div>
                            {santaHintRequest.selectedItems && santaHintRequest.selectedItems.length > 0 && (
                              <div>
                                <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 4 }}>{t('santa_hint_selected_items_title', locale)}</div>
                                {santaHintRequest.selectedItems.map(item => (
                                  <div key={item.id} style={{ background: C.surface, borderRadius: 8, padding: '8px 10px', marginBottom: 4 }}>
                                    <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{item.title}</div>
                                    {item.priceText && <div style={{ fontSize: 12, color: C.textMuted }}>{item.priceText}</div>}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                        {santaHintRequest.status === 'EXPIRED' && (
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                            <div style={{ fontSize: 13, color: C.textMuted }}>{t('santa_hint_expired', locale)}</div>
                            <button
                              disabled={santaHintRequestLoading}
                              onClick={async () => {
                                setSantaHintRequest(null);
                                setSantaHintRequestLoading(true);
                                const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/hints`, { method: 'POST' });
                                if (res.ok) setSantaHintRequest(await res.json() as typeof santaHintRequest);
                                else pushToast(t('error_generic', locale), 'error');
                                setSantaHintRequestLoading(false);
                              }}
                              style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 8, color: C.textSec, fontSize: 12, padding: '6px 12px', cursor: 'pointer', fontFamily: font }}
                            >
                              {santaHintRequestLoading ? t('loading', locale) : t('santa_hint_request_btn', locale)}
                            </button>
                          </div>
                        )}
                        {santaHintRequest.status === 'CANCELLED' && (
                          <div style={{ fontSize: 13, color: C.textMuted }}>{t('santa_hint_cancelled', locale)}</div>
                        )}

                        {/* Poll for updates — refresh hint status */}
                        {santaHintRequest.status === 'PENDING' && (
                          <button
                            disabled={santaHintRequestLoading}
                            onClick={async () => {
                              setSantaHintRequestLoading(true);
                              const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/hints`);
                              if (res.ok) {
                                const data = await res.json() as { hint: typeof santaHintRequest };
                                if (data.hint) setSantaHintRequest(data.hint);
                              }
                              setSantaHintRequestLoading(false);
                            }}
                            style={{ marginTop: 8, background: 'none', border: 'none', color: C.textMuted, fontSize: 12, padding: '4px 0', cursor: 'pointer', fontFamily: font }}
                          >
                            {santaHintRequestLoading ? t('loading', locale) : t('santa_hint_refresh', locale)}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Receiver inbound view (post-draw) — role: receiver, no giver identity */}
            {!isOwner && ['ACTIVE', 'COMPLETED'].includes(camp.status) && (() => {
              const myParticipant = participants.find(p => p.isMe);
              if (!myParticipant) return null;
              return (
                <div style={{ background: C.card, borderRadius: 14, padding: 16, marginBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, marginBottom: 8 }}>
                    {t('santa_my_gift_label', locale)}
                  </div>

                  {/* Load inbound status on demand */}
                  {!santaInboundStatus && (
                    <button
                      disabled={santaInboundLoading}
                      onClick={async () => {
                        setSantaInboundLoading(true);
                        const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/inbound/status`);
                        if (res.ok) setSantaInboundStatus(await res.json() as typeof santaInboundStatus);
                        setSantaInboundLoading(false);
                      }}
                      style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 10, color: C.text, fontSize: 13, padding: '8px 16px', cursor: 'pointer', width: '100%' }}
                    >
                      {santaInboundLoading ? t('loading', locale) : t('santa_check_status_btn', locale)}
                    </button>
                  )}

                  {santaInboundStatus && (
                    <div>
                      {/* Batch 3: semantic signal display — never exposes raw giftStatus */}
                      {santaInboundStatus.signal === 'waiting' && (
                        <div style={{ fontSize: 13, color: C.textSec }}>{t('santa_inbound_signal_waiting', locale)}</div>
                      )}
                      {santaInboundStatus.signal === 'in_progress' && (
                        <div style={{ fontSize: 13, color: C.accent, fontWeight: 600 }}>🎁 {t('santa_inbound_signal_in_progress', locale)}</div>
                      )}
                      {santaInboundStatus.signal === 'ready' && (
                        <div style={{ fontSize: 13, color: C.accent, fontWeight: 700 }}>📦 {t('santa_inbound_signal_ready', locale)}</div>
                      )}
                      {santaInboundStatus.signal === 'received' && (
                        <div style={{ fontSize: 13, color: C.green, fontWeight: 700 }}>✓ {t('santa_inbound_signal_received', locale)}</div>
                      )}

                      {/* Confirm received — only when signal === 'ready' (giftStatus SENT on backend) */}
                      {santaInboundStatus.canConfirmReceived && (
                        <button
                          onClick={async () => {
                            if (!window.confirm(t('santa_inbound_confirm_received_confirm', locale))) return;
                            const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/confirm-received`, { method: 'POST' });
                            if (res.ok) {
                              const json = await res.json() as { campaignCompleted: boolean; canReveal: boolean };
                              setSantaInboundStatus(prev => prev ? {
                                ...prev,
                                signal: 'received',
                                canConfirmReceived: false,
                                canReveal: json.canReveal,
                              } : prev);
                              pushToast(json.campaignCompleted ? t('santa_gift_all_received', locale) : t('done', locale), 'success');
                              const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                              if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                            }
                          }}
                          style={{ marginTop: 12, background: C.green, border: 'none', borderRadius: 10, color: '#000', fontSize: 13, fontWeight: 700, padding: '10px 0', cursor: 'pointer', width: '100%', fontFamily: font }}
                        >
                          {t('santa_inbound_confirm_received_btn', locale)}
                        </button>
                      )}

                      {/* Reveal button — visible immediately after RECEIVED (canReveal: true) */}
                      {santaInboundStatus.canReveal && !santaReveal && (
                        <button
                          disabled={santaRevealLoading}
                          onClick={async () => {
                            setSantaRevealLoading(true);
                            const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/reveal`);
                            if (res.ok) setSantaReveal(await res.json() as typeof santaReveal);
                            else pushToast(t('error_generic', locale), 'error');
                            setSantaRevealLoading(false);
                          }}
                          style={{ marginTop: 8, background: C.accent, border: 'none', borderRadius: 10, color: '#fff', fontSize: 13, fontWeight: 700, padding: '10px 0', cursor: santaRevealLoading ? 'wait' : 'pointer', width: '100%', fontFamily: font }}
                        >
                          🎅 {santaRevealLoading ? t('loading', locale) : t('santa_inbound_reveal_btn', locale)}
                        </button>
                      )}

                      {/* Reveal result — alias-only, forever */}
                      {santaInboundStatus.canReveal && santaReveal?.revealed && santaReveal.giver && (
                        <div style={{ marginTop: 12, background: `${C.accent}12`, borderRadius: 12, padding: 14, border: `1px solid ${C.accent}30` }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 10 }}>
                            🎅 {locale === 'ru' ? 'Твой Санта открыт!' : 'Your Santa revealed!'}
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                            <SantaAvatar alias={santaReveal.giver.displayName} emoji={santaReveal.giver.emoji || '🎅'} size={44} hat={santaSeason?.inSeason} />
                            <div>
                              <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
                                {renderSantaAlias(santaReveal.giver.adjectiveKey ?? '', santaReveal.giver.animalKey ?? '', locale) || santaReveal.giver.displayName}
                              </div>
                              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                                {locale === 'ru' ? 'Это твой Тайный Санта в этом раунде' : 'Your Secret Santa this round'}
                              </div>
                            </div>
                          </div>
                          {santaReveal.giftNote ? (
                            <div style={{ fontSize: 13, color: C.textSec, marginTop: 6 }}>
                              <span style={{ color: C.textMuted }}>{t('santa_reveal_note_label', locale)}</span>{' '}
                              {santaReveal.giftNote}
                            </div>
                          ) : (
                            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 4 }}>{t('santa_reveal_no_note', locale)}</div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

            {/* Receiver inbound hint card (Batch 2.5) — shown when receiver has a PENDING hint request */}
            {!isOwner && camp.status === 'ACTIVE' && (() => {
              const myParticipant = participants.find(p => p.isMe);
              if (!myParticipant) return null;
              return (
                <div>
                  {/* Load hint on demand (lazy — don't auto-poll to preserve anonymity perception) */}
                  {!santaHintInbound && (
                    <button
                      disabled={santaHintInboundLoading}
                      onClick={async () => {
                        setSantaHintInboundLoading(true);
                        const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/inbound/hint`);
                        if (res.ok) setSantaHintInbound(await res.json() as typeof santaHintInbound);
                        setSantaHintInboundLoading(false);
                      }}
                      style={{ display: 'none' }} // Trigger is the card below; this is just a mount-guard
                    />
                  )}

                  {/* Only render the hint card when there's an active PENDING hint */}
                  {santaHintInbound?.hasPendingHint && santaHintInbound.hint && (
                    <div style={{ background: `${C.accent}15`, borderRadius: 14, padding: 16, marginBottom: 16, border: `1px solid ${C.accent}30` }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 6 }}>
                        💡 {t('santa_hint_inbound_title', locale)}
                      </div>
                      <div style={{ fontSize: 13, color: C.textSec, marginBottom: 12 }}>
                        {t('santa_hint_inbound_desc', locale)}
                      </div>
                      <button
                        onClick={async () => {
                          // Load receiver's own linked wishlist items for selection
                          if (!myParticipant.linkedWishlist?.id) {
                            pushToast(t('santa_hint_inbound_no_items', locale), 'error');
                            return;
                          }
                          setSantaHintInboundLoading(true);
                          const res = await tgFetch(`/tg/wishlists/${myParticipant.linkedWishlist.id}/items`);
                          if (res.ok) {
                            const data = await res.json() as { items?: { id: string; title: string; priceText: string | null; status: string }[] };
                            const available = (data.items ?? []).filter(i => i.status === 'AVAILABLE');
                            if (available.length === 0) {
                              pushToast(t('santa_hint_inbound_no_items', locale), 'error');
                            } else {
                              setSantaHintPickerItems(available);
                              setSantaHintPickerSelectedIds([]);
                              setSantaHintPickerOpen(true);
                            }
                          } else {
                            pushToast(t('error_generic', locale), 'error');
                          }
                          setSantaHintInboundLoading(false);
                        }}
                        disabled={santaHintInboundLoading}
                        style={{ background: C.accent, border: 'none', borderRadius: 10, color: '#fff', fontSize: 13, fontWeight: 600, padding: '10px 0', cursor: santaHintInboundLoading ? 'wait' : 'pointer', width: '100%', fontFamily: font }}
                      >
                        {santaHintInboundLoading ? t('loading', locale) : t('santa_hint_inbound_select_items', locale)}
                      </button>
                    </div>
                  )}

                  {/* Lazy-load trigger: check for pending hint when component first mounts */}
                  {santaHintInbound === null && !santaHintInboundLoading && camp.status === 'ACTIVE' && (
                    <div
                      ref={(el) => {
                        if (el && santaHintInbound === null && !santaHintInboundLoading) {
                          void (async () => {
                            setSantaHintInboundLoading(true);
                            const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/inbound/hint`);
                            if (res.ok) setSantaHintInbound(await res.json() as typeof santaHintInbound);
                            setSantaHintInboundLoading(false);
                          })();
                        }
                      }}
                    />
                  )}
                </div>
              );
            })()}

            {/* Reveal section — Batch 3: standalone reveal card for campaign-COMPLETED state
                when inbound status wasn't already loaded (e.g. user navigates back).
                Primary reveal UX lives inside the inbound status card above.         */}
            {camp.status === 'COMPLETED' && !santaInboundStatus && (() => {
              const myParticipant = participants.find(p => p.isMe);
              if (!myParticipant || isOwner) return null;
              return (
                <div style={{ background: `${C.accent}10`, borderRadius: 14, padding: 16, marginBottom: 16, border: `1px solid ${C.accent}30` }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 8 }}>
                    🎅 {t('santa_reveal_title', locale)}
                  </div>
                  {!santaReveal ? (
                    <button
                      disabled={santaRevealLoading}
                      onClick={async () => {
                        setSantaRevealLoading(true);
                        const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/reveal`);
                        if (res.ok) {
                          const data = await res.json() as typeof santaReveal;
                          setSantaReveal(data);
                        } else {
                          const err = await res.json().catch(() => ({})) as { error?: string };
                          if (err.error === 'reveal_not_available') {
                            pushToast(t('santa_reveal_not_received_yet', locale), 'error');
                          } else {
                            pushToast(t('error_generic', locale), 'error');
                          }
                        }
                        setSantaRevealLoading(false);
                      }}
                      style={{ background: C.accent, border: 'none', borderRadius: 10, color: '#fff', fontSize: 13, fontWeight: 600, padding: '10px 0', cursor: santaRevealLoading ? 'wait' : 'pointer', width: '100%', fontFamily: font }}
                    >
                      {santaRevealLoading ? t('loading', locale) : t('santa_reveal_btn', locale)}
                    </button>
                  ) : santaReveal?.revealed && santaReveal.giver ? (
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                        <SantaAvatar alias={santaReveal.giver.displayName} emoji={santaReveal.giver.emoji || '🎅'} size={44} hat={santaSeason?.inSeason} />
                        <div>
                          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
                            {renderSantaAlias(santaReveal.giver.adjectiveKey ?? '', santaReveal.giver.animalKey ?? '', locale) || santaReveal.giver.displayName}
                          </div>
                          <div style={{ fontSize: 11, color: C.textMuted }}>
                            {locale === 'ru' ? 'Твой Тайный Санта' : 'Your Secret Santa'}
                          </div>
                        </div>
                      </div>
                      {santaReveal.giftNote ? (
                        <div style={{ fontSize: 13, color: C.textSec }}>
                          <span style={{ color: C.textMuted }}>{t('santa_reveal_note_label', locale)}</span>{' '}
                          {santaReveal.giftNote}
                        </div>
                      ) : (
                        <div style={{ fontSize: 12, color: C.textMuted }}>{t('santa_reveal_no_note', locale)}</div>
                      )}
                    </div>
                  ) : (
                    <div style={{ fontSize: 13, color: C.textMuted }}>{t('santa_reveal_not_ready', locale)}</div>
                  )}
                </div>
              );
            })()}

            {/* Leave campaign (non-owner, pre-draw) */}
            {!isOwner && ['OPEN', 'DRAFT'].includes(camp.status) && (
              <button
                onClick={async () => {
                  if (!confirm(t('santa_leave_confirm', locale, { title: camp.title }))) return;
                  const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/leave`, { method: 'POST' });
                  if (res.ok) {
                    setCurrentSantaCampaign(null);
                    setSantaCampaigns(prev => ({
                      ...prev,
                      joined: prev.joined.filter(c => c.id !== camp.id),
                    }));
                    setScreen('santa-hub');
                  }
                }}
                style={{ background: 'none', border: `1px solid ${C.red}40`, borderRadius: 12, color: C.red, fontSize: 13, fontWeight: 600, padding: '10px 0', cursor: 'pointer', fontFamily: font, width: '100%', marginTop: 8 }}
              >
                {t('santa_leave_btn', locale)}
              </button>
            )}

            {/* Exit request for LOCKED/ACTIVE campaigns (non-owner, no pending request) */}
            {!isOwner && ['LOCKED', 'ACTIVE'].includes(camp.status) && !pendingExitRequestId && (() => {
              const myP = participants.find(p => p.isMe);
              if (!myP || myP.status !== 'JOINED') return null;
              return (
                <button
                  onClick={() => setSantaExitRequestSheetOpen(true)}
                  style={{ background: 'none', border: `1px solid ${C.red}40`, borderRadius: 12, color: C.red, fontSize: 13, fontWeight: 600, padding: '10px 0', cursor: 'pointer', fontFamily: font, width: '100%', marginTop: 8 }}
                >
                  {t('santa_exit_request_submit', locale)}
                </button>
              );
            })()}

            {/* Exit request bottom sheet */}
            {santaExitRequestSheetOpen && (
              <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, background: C.surface, borderTop: `1px solid ${C.border}`, borderRadius: '20px 20px 0 0', padding: '20px 20px 40px', zIndex: 1000 }}>
                <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 12 }}>{t('santa_exit_request_title', locale)}</div>
                <textarea
                  value={santaExitRequestReason}
                  onChange={e => setSantaExitRequestReason(e.target.value)}
                  placeholder={t('santa_exit_request_reason_placeholder', locale)}
                  rows={3}
                  maxLength={300}
                  style={{ width: '100%', borderRadius: 10, border: `1px solid ${C.border}`, padding: '10px 12px', fontSize: 14, fontFamily: font, color: C.text, background: C.card, resize: 'none', boxSizing: 'border-box' }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button
                    onClick={() => { setSantaExitRequestSheetOpen(false); setSantaExitRequestReason(''); }}
                    style={{ flex: 1, background: 'none', border: `1px solid ${C.border}`, borderRadius: 10, color: C.textSec, fontSize: 14, fontWeight: 600, padding: '10px 0', cursor: 'pointer', fontFamily: font }}
                  >
                    {t('cancel', locale)}
                  </button>
                  <button
                    disabled={santaExitRequestSubmitting}
                    onClick={async () => {
                      setSantaExitRequestSubmitting(true);
                      const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/exit-request`, {
                        method: 'POST',
                        body: JSON.stringify({ reason: santaExitRequestReason.trim() || undefined }),
                      });
                      if (res.ok) {
                        setSantaExitRequestSheetOpen(false);
                        setSantaExitRequestReason('');
                        // Re-fetch campaign to get pendingExitRequestId
                        const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                        if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                        pushToast(t('santa_exit_request_submitted', locale), 'success');
                      } else {
                        const err = await res.json().catch(() => ({})) as { error?: string };
                        if (err.error === 'exit_request_already_pending') pushToast(t('santa_exit_request_pending_banner', locale), 'info');
                        else pushToast(t('error_generic', locale), 'error');
                      }
                      setSantaExitRequestSubmitting(false);
                    }}
                    style={{ flex: 2, background: C.red, border: 'none', borderRadius: 10, color: '#fff', fontSize: 14, fontWeight: 700, padding: '10px 0', cursor: santaExitRequestSubmitting ? 'wait' : 'pointer', fontFamily: font, opacity: santaExitRequestSubmitting ? 0.6 : 1 }}
                  >
                    {santaExitRequestSubmitting ? '…' : t('santa_exit_request_submit', locale)}
                  </button>
                </div>
              </div>
            )}

            {/* Cancel campaign (owner only) */}
            {isOwner && !['COMPLETED', 'CANCELLED'].includes(camp.status) && (
              <button
                onClick={async () => {
                  if (!confirm(t('santa_campaign_cancel_confirm', locale))) return;
                  const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/cancel`, { method: 'POST' });
                  if (res.ok) {
                    const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                    if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                    pushToast(t('done', locale), 'success');
                  }
                }}
                style={{ background: 'none', border: `1px solid ${C.red}40`, borderRadius: 12, color: C.red, fontSize: 13, fontWeight: 600, padding: '10px 0', cursor: 'pointer', fontFamily: font, width: '100%', marginTop: 8 }}
              >
                {t('santa_campaign_cancel_btn', locale)}
              </button>
            )}

            {/* Multi-round controls — owner-only lifecycle actions */}
            {isOwner && camp.status === 'ACTIVE' && (
              <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {/* Start next round — only when current round is complete */}
                {canStartNextRound && (
                  <button
                    onClick={async () => {
                      const nextN = (currentRoundNumber ?? 1) + 1;
                      if (!confirm(t('santa_round_start_confirm', locale, { n: String(nextN) }))) return;
                      const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/rounds`, { method: 'POST' });
                      if (res.ok) {
                        const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                        if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                        pushToast(t('done', locale), 'success');
                      } else {
                        const err = await res.json() as { error?: string };
                        if (err.error === 'round_not_complete') pushToast(t('santa_round_not_terminal', locale), 'error');
                        else pushToast(t('error_generic', locale), 'error');
                      }
                    }}
                    style={{ background: C.accent, border: 'none', borderRadius: 12, color: '#fff', fontSize: 13, fontWeight: 700, padding: '12px 0', cursor: 'pointer', fontFamily: font, width: '100%' }}
                  >
                    {t('santa_round_start_next', locale, { n: String((currentRoundNumber ?? 1) + 1) })}
                  </button>
                )}

                {/* Force-complete campaign — always visible to owner when ACTIVE */}
                <button
                  onClick={async () => {
                    if (!confirm(t('santa_round_complete_confirm', locale))) return;
                    const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/complete`, { method: 'POST' });
                    if (res.ok) {
                      const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                      if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                      pushToast(t('done', locale), 'success');
                    } else pushToast(t('error_generic', locale), 'error');
                  }}
                  style={{ background: 'none', border: `1px solid ${C.border}`, borderRadius: 12, color: C.textSec, fontSize: 13, fontWeight: 600, padding: '10px 0', cursor: 'pointer', fontFamily: font, width: '100%' }}
                >
                  {t('santa_round_complete_btn', locale)}
                </button>
              </div>
            )}

            {/* (wishlist section moved above — see below giver block) */}

            {/* Chat button + unread badge (Batch 4.1) */}
            {['OPEN', 'LOCKED', 'ACTIVE', 'COMPLETED', 'CANCELLED'].includes(camp.status) && (
              <button
                onClick={async () => {
                  setSantaChatLoading(true);
                  setSantaChatMessages([]);
                  setSantaChatHasMore(false);
                  setSantaChatInput('');
                  setSantaChatIsMuted(currentSantaCampaign.isMuted);
                  setScreen('santa-chat');
                  try {
                    const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/chat?limit=50`);
                    if (res.ok) {
                      const data = await res.json() as { messages: ChatMessage[]; hasMore: boolean; totalUnread: number; isMuted: boolean };
                      // API returns DESC; reverse to show oldest-first
                      setSantaChatMessages([...data.messages].reverse());
                      setSantaChatHasMore(data.hasMore);
                      setSantaChatIsMuted(data.isMuted);
                      // Mark as read if we have messages
                      if (data.messages.length > 0) {
                        const newestId = data.messages[0]!.id;
                        void tgFetch(`/tg/santa/campaigns/${camp.id}/chat/read`, { method: 'POST', body: JSON.stringify({ lastReadMessageId: newestId }) });
                      }
                    }
                  } finally {
                    setSantaChatLoading(false);
                  }
                }}
                style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: '12px 16px', cursor: 'pointer', width: '100%', fontFamily: font, marginTop: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 18 }}>💬</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{t('santa_chat_open_btn', locale)}</span>
                </div>
                {currentSantaCampaign.chatUnreadCount > 0 && (
                  <span style={{ minWidth: 20, height: 20, borderRadius: 10, background: C.orange, color: '#000', fontSize: 11, fontWeight: 700, padding: '0 6px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {currentSantaCampaign.chatUnreadCount}
                  </span>
                )}
              </button>
            )}

            {/* Organizer panel button (Batch 5.3) — organizer only */}
            {isOrg && !['DRAFT'].includes(camp.status) && (
              <button
                onClick={async () => {
                  setSantaOrganizerSummary(null);
                  setSantaOrganizerLoading(true);
                  setScreen('santa-organizer');
                  try {
                    const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/organizer/summary`);
                    if (res.ok) setSantaOrganizerSummary(await res.json() as OrganizerSummary);
                  } finally {
                    setSantaOrganizerLoading(false);
                  }
                }}
                style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: '12px 16px', cursor: 'pointer', width: '100%', fontFamily: font, marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 18 }}>🛡</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{t('santa_organizer_open_btn', locale)}</span>
                </div>
                {pendingExitRequestCount > 0 && (
                  <span style={{ minWidth: 20, height: 20, borderRadius: 10, background: C.orange, color: '#000', fontSize: 11, fontWeight: 700, padding: '0 6px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {pendingExitRequestCount}
                  </span>
                )}
              </button>
            )}

            {/* Exclusions button (Batch 5.1) — organizer only, pre-draw statuses */}
            {isOrg && ['DRAFT', 'OPEN', 'LOCKED'].includes(camp.status) && (
              <button
                onClick={async () => {
                  setSantaExclPairs([]);
                  setSantaExclGroups([]);
                  setSantaExclLoading(true);
                  setScreen('santa-exclusions');
                  try {
                    const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/exclusions`);
                    if (res.ok) {
                      const data = await res.json() as { exclusions: ExclusionPair[]; groups: ExclusionGroup[] };
                      setSantaExclPairs(data.exclusions);
                      setSantaExclGroups(data.groups);
                    }
                  } finally {
                    setSantaExclLoading(false);
                  }
                }}
                style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: '12px 16px', cursor: 'pointer', width: '100%', fontFamily: font, marginTop: 8, display: 'flex', alignItems: 'center', gap: 8 }}
              >
                <span style={{ fontSize: 18 }}>🚫</span>
                <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{t('santa_excl_open_btn', locale)}</span>
                {(santaExclPairs.length + santaExclGroups.length) > 0 && (
                  <span style={{ marginLeft: 'auto', fontSize: 12, color: C.textMuted }}>{santaExclPairs.length + santaExclGroups.length}</span>
                )}
              </button>
            )}

            {/* Polls button (Batch 4.2) — visible for ACTIVE campaigns */}
            {camp.status === 'ACTIVE' && (
              <button
                onClick={async () => {
                  setSantaPolls([]);
                  setSantaPollsLoading(true);
                  setScreen('santa-polls');
                  try {
                    const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/polls`);
                    if (res.ok) {
                      const data = await res.json() as { polls: Poll[] };
                      setSantaPolls(data.polls);
                    }
                  } finally {
                    setSantaPollsLoading(false);
                  }
                }}
                style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: '12px 16px', cursor: 'pointer', width: '100%', fontFamily: font, marginTop: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 18 }}>📊</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{t('santa_polls_open_btn', locale)}</span>
                </div>
              </button>
            )}

            {/* Hint item picker sheet (Batch 2.5) — receiver selects 1–3 items for their giver */}
            <BottomSheet
              isOpen={santaHintPickerOpen}
              onClose={() => {
                setSantaHintPickerOpen(false);
                setSantaHintPickerSelectedIds([]);
              }}
              title={t('santa_hint_inbound_select_items', locale)}
            >
              <div>
                <div style={{ fontSize: 13, color: C.textSec, marginBottom: 12 }}>
                  {t('santa_hint_inbound_desc', locale)}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                  {santaHintPickerItems.map(item => {
                    const selected = santaHintPickerSelectedIds.includes(item.id);
                    const maxReached = santaHintPickerSelectedIds.length >= 3 && !selected;
                    return (
                      <button
                        key={item.id}
                        disabled={maxReached}
                        onClick={() => {
                          setSantaHintPickerSelectedIds(prev =>
                            selected ? prev.filter(id => id !== item.id) : [...prev, item.id]
                          );
                        }}
                        style={{
                          background: selected ? `${C.accent}20` : C.surface,
                          border: `1.5px solid ${selected ? C.accent : C.border}`,
                          borderRadius: 12, padding: '10px 14px', cursor: maxReached ? 'not-allowed' : 'pointer',
                          textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          opacity: maxReached ? 0.4 : 1,
                        }}
                      >
                        <div>
                          <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{item.title}</div>
                          {item.priceText && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{item.priceText}</div>}
                        </div>
                        {selected && <span style={{ color: C.accent, fontSize: 18, fontWeight: 700 }}>✓</span>}
                      </button>
                    );
                  })}
                </div>
                <button
                  disabled={santaHintPickerSelectedIds.length === 0 || santaHintFulfillLoading}
                  onClick={async () => {
                    if (!santaHintInbound?.hint) return;
                    setSantaHintFulfillLoading(true);
                    const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/inbound/hint/fulfill`, {
                      method: 'POST',
                      body: JSON.stringify({ hintId: santaHintInbound.hint.id, selectedItemIds: santaHintPickerSelectedIds }),
                    });
                    if (res.ok) {
                      pushToast(t('santa_hint_inbound_submitted', locale), 'success');
                      setSantaHintInbound({ hasPendingHint: false, hint: { ...santaHintInbound.hint, status: 'FULFILLED' } });
                      setSantaHintPickerOpen(false);
                      setSantaHintPickerSelectedIds([]);
                    } else {
                      const err = await res.json() as { error?: string };
                      if (err.error === 'invalid_items') pushToast(locale === 'ru' ? 'Некоторые желания недоступны' : 'Some items are unavailable', 'error');
                      else pushToast(t('error_generic', locale), 'error');
                    }
                    setSantaHintFulfillLoading(false);
                  }}
                  style={{
                    background: santaHintPickerSelectedIds.length === 0 ? C.border : C.accent,
                    border: 'none', borderRadius: 12, color: '#fff', fontSize: 14, fontWeight: 700,
                    padding: '12px 0', cursor: santaHintPickerSelectedIds.length === 0 ? 'not-allowed' : 'pointer',
                    width: '100%', fontFamily: font,
                  }}
                >
                  {santaHintFulfillLoading
                    ? t('loading', locale)
                    : `${t('santa_hint_inbound_submit', locale)} (${santaHintPickerSelectedIds.length}/3)`}
                </button>
              </div>
            </BottomSheet>

            {/* Wishlist picker sheet */}
            <BottomSheet isOpen={showSantaWishlistPicker} onClose={() => setShowSantaWishlistPicker(false)} title={t('santa_campaign_link_wishlist', locale)}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {wishlists.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: '24px 0' }}>
                    <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 16 }}>
                      {t('santa_wishlist_picker_empty', locale)}
                    </div>
                    <button
                      onClick={() => {
                        setSantaWishlistPickerReturnId(camp.id);
                        setShowSantaWishlistPicker(false);
                        setScreen('my-wishlists');
                      }}
                      style={{ background: C.accent, border: 'none', borderRadius: 12, color: '#fff', fontSize: 14, fontWeight: 600, padding: '12px 24px', cursor: 'pointer', fontFamily: font }}
                    >
                      {t('santa_wishlist_picker_create_new', locale)}
                    </button>
                  </div>
                ) : (
                  wishlists.map(wl => (
                    <button
                      key={wl.id}
                      onClick={async () => {
                        setSantaWishlistPickerLoading(true);
                        const res = await tgFetch(`/tg/santa/campaigns/${camp.id}/wishlist`, { method: 'PATCH', body: JSON.stringify({ wishlistId: wl.id }) });
                        if (res.ok) {
                          const detailRes = await tgFetch(`/tg/santa/campaigns/${camp.id}`);
                          if (detailRes.ok) setCurrentSantaCampaign(await detailRes.json() as SantaCampaignDetail);
                          setShowSantaWishlistPicker(false);
                        } else pushToast(t('error_generic', locale), 'error');
                        setSantaWishlistPickerLoading(false);
                      }}
                      disabled={santaWishlistPickerLoading}
                      style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: '12px 16px', cursor: 'pointer', textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                    >
                      <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{wl.title}</span>
                      <span style={{ color: C.textMuted, fontSize: 18 }}>›</span>
                    </button>
                  ))
                )}
              </div>
            </BottomSheet>
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════
          SECRET SANTA — POLLS (Batch 4.2)
          ══════════════════════════════════════════════ */}
      {screen === 'santa-polls' && currentSantaCampaign && (() => {
        const camp = currentSantaCampaign.campaign;
        const campId = camp.id;
        const isOwner = camp.isOwner;

        const vote = async (pollId: string, optionIndex: number) => {
          const res = await tgFetch(`/tg/santa/campaigns/${campId}/polls/${pollId}/vote`, { method: 'POST', body: JSON.stringify({ optionIndex }) });
          if (res.ok) {
            const data = await res.json() as { poll: Poll };
            setSantaPolls(prev => prev.map(p => p.id === pollId ? data.poll : p));
          } else {
            const err = await res.json().catch(() => ({})) as { error?: string };
            if (err.error === 'already_voted') pushToast(t('santa_polls_already_voted', locale), 'info');
          }
        };

        const closePoll = async (pollId: string) => {
          const res = await tgFetch(`/tg/santa/campaigns/${campId}/polls/${pollId}/close`, { method: 'POST' });
          if (res.ok) {
            const data = await res.json() as { poll: Poll };
            setSantaPolls(prev => prev.map(p => p.id === pollId ? data.poll : p));
          }
        };

        const createPoll = async () => {
          const opts = santaPollCreateOptions.filter(o => o.trim());
          if (opts.length < 2) { pushToast(t('santa_polls_min_options', locale), 'error'); return; }
          if (!santaPollCreateQuestion.trim()) return;
          setSantaPollCreateSubmitting(true);
          try {
            const res = await tgFetch(`/tg/santa/campaigns/${campId}/polls`, {
              method: 'POST',
              body: JSON.stringify({ question: santaPollCreateQuestion.trim(), options: opts, isAnonymous: santaPollCreateAnonymous }),
            });
            if (res.ok) {
              const data = await res.json() as { poll: Poll };
              setSantaPolls(prev => [data.poll, ...prev]);
              setSantaPollCreateOpen(false);
              setSantaPollCreateQuestion('');
              setSantaPollCreateOptions(['', '']);
              setSantaPollCreateAnonymous(false);
              pushToast(t('done', locale), 'success');
            }
          } finally {
            setSantaPollCreateSubmitting(false);
          }
        };

        return (
          <div style={{ padding: '16px 20px 120px' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
              <button onClick={navBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: C.accent, fontSize: 22 }}>←</button>
              <h1 style={{ fontSize: 20, fontWeight: 800, fontFamily: font, color: C.text, margin: 0, flex: 1 }}>
                📊 {t('santa_polls_title', locale)}
              </h1>
              {isOwner && (
                <button
                  onClick={() => setSantaPollCreateOpen(true)}
                  style={{ background: C.accent, border: 'none', borderRadius: 12, padding: '8px 14px', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer', fontFamily: font }}
                >
                  {t('santa_polls_new', locale)}
                </button>
              )}
            </div>

            {/* Empty */}
            {!santaPollsLoading && santaPolls.length === 0 && (
              <div style={{ textAlign: 'center', color: C.textSec, fontSize: 14, padding: '40px 0' }}>
                {t('santa_polls_empty', locale)}
              </div>
            )}

            {/* Loading */}
            {santaPollsLoading && (
              <div style={{ textAlign: 'center', color: C.textSec, padding: '40px 0' }}>{t('loading', locale)}</div>
            )}

            {/* Poll list */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {santaPolls.map(poll => {
                const totalVotes = poll.results.reduce((s, r) => s + r.count, 0);
                return (
                  <div key={poll.id} style={{ background: C.card, borderRadius: 16, padding: '16px', border: `1px solid ${C.border}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
                      <div style={{ fontSize: 15, fontWeight: 700, color: C.text, flex: 1 }}>{poll.question}</div>
                      <span style={{ fontSize: 11, fontWeight: 600, padding: '2px 8px', borderRadius: 8, background: poll.isOpen ? `${C.green}20` : `${C.textSec}15`, color: poll.isOpen ? C.green : C.textSec, whiteSpace: 'nowrap' }}>
                        {poll.isOpen ? t('santa_polls_active', locale) : t('santa_polls_closed', locale)}
                      </span>
                    </div>

                    {/* Options */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {poll.options.map((opt, idx) => {
                        const result = poll.results[idx];
                        const isMyVote = poll.myVote === idx;
                        const pct = result?.percentage ?? 0;
                        return (
                          <div key={idx}>
                            <div
                              onClick={() => { if (poll.isOpen && poll.myVote === null) void vote(poll.id, idx); }}
                              style={{ cursor: poll.isOpen && poll.myVote === null ? 'pointer' : 'default', borderRadius: 10, border: `1px solid ${isMyVote ? C.accent : C.border}`, padding: '8px 12px', position: 'relative', overflow: 'hidden', background: C.bg }}
                            >
                              {/* Progress bar */}
                              <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, background: isMyVote ? `${C.accent}20` : `${C.textSec}10`, borderRadius: 10 }} />
                              <div style={{ position: 'relative', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  {isMyVote && <span style={{ color: C.accent, fontSize: 14 }}>✓</span>}
                                  <span style={{ fontSize: 14, color: C.text }}>{opt}</span>
                                </div>
                                <span style={{ fontSize: 12, color: C.textSec, fontWeight: 600 }}>{pct}%</span>
                              </div>
                            </div>
                            {/* Voters (public only) */}
                            {!poll.isAnonymous && result?.voters && result.voters.length > 0 && (
                              <div style={{ fontSize: 11, color: C.textSec, marginTop: 2, paddingLeft: 4 }}>
                                {result.voters.map(v => v.displayName).join(', ')}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {/* Footer */}
                    <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 12, color: C.textSec }}>
                        {t('santa_polls_votes_count', locale, { n: String(totalVotes) })}
                        {poll.isAnonymous && <span style={{ marginLeft: 6 }}>· {t('santa_polls_voters_hidden', locale)}</span>}
                      </span>
                      {isOwner && poll.isOpen && (
                        <button
                          onClick={() => void closePoll(poll.id)}
                          style={{ background: 'none', border: `1px solid ${C.red}40`, borderRadius: 8, padding: '4px 10px', color: C.red, fontSize: 12, cursor: 'pointer', fontFamily: font }}
                        >
                          {t('santa_polls_close', locale)}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Create poll sheet */}
            <BottomSheet isOpen={santaPollCreateOpen} onClose={() => setSantaPollCreateOpen(false)} title={t('santa_polls_new', locale)}>
              <div>
                <div style={{ fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('santa_polls_question', locale)}</div>
                <input
                  value={santaPollCreateQuestion}
                  onChange={e => setSantaPollCreateQuestion(e.target.value)}
                  placeholder={t('santa_polls_question_placeholder', locale)}
                  maxLength={300}
                  style={{ width: '100%', background: `${C.textSec}10`, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', fontSize: 14, color: C.text, fontFamily: font, outline: 'none', boxSizing: 'border-box' }}
                />

                <div style={{ marginTop: 16, marginBottom: 6, fontSize: 13, color: C.textSec }}>Варианты ответов</div>
                {santaPollCreateOptions.map((opt, idx) => (
                  <div key={idx} style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                    <input
                      value={opt}
                      onChange={e => { const arr = [...santaPollCreateOptions]; arr[idx] = e.target.value; setSantaPollCreateOptions(arr); }}
                      placeholder={t('santa_polls_option_placeholder', locale, { n: String(idx + 1) })}
                      maxLength={100}
                      style={{ flex: 1, background: `${C.textSec}10`, border: `1px solid ${C.border}`, borderRadius: 10, padding: '8px 12px', fontSize: 14, color: C.text, fontFamily: font, outline: 'none' }}
                    />
                    {santaPollCreateOptions.length > 2 && (
                      <button onClick={() => setSantaPollCreateOptions(prev => prev.filter((_, i) => i !== idx))} style={{ background: 'none', border: 'none', color: C.red, cursor: 'pointer', fontSize: 18, padding: '0 4px' }}>×</button>
                    )}
                  </div>
                ))}
                {santaPollCreateOptions.length < 10 && (
                  <button onClick={() => setSantaPollCreateOptions(prev => [...prev, ''])} style={{ background: 'none', border: 'none', color: C.accent, fontSize: 13, cursor: 'pointer', padding: '4px 0', fontFamily: font }}>
                    {t('santa_polls_add_option', locale)}
                  </button>
                )}

                <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 10 }}>
                  <input type="checkbox" checked={santaPollCreateAnonymous} onChange={e => setSantaPollCreateAnonymous(e.target.checked)} id="anon-toggle" />
                  <label htmlFor="anon-toggle" style={{ fontSize: 14, color: C.text, cursor: 'pointer' }}>{t('santa_polls_anonymous', locale)}</label>
                </div>

                <button
                  onClick={() => void createPoll()}
                  disabled={santaPollCreateSubmitting}
                  style={{ marginTop: 20, background: C.accent, border: 'none', borderRadius: 12, padding: '13px 0', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', width: '100%', fontFamily: font, opacity: santaPollCreateSubmitting ? 0.6 : 1 }}
                >
                  {santaPollCreateSubmitting ? t('loading', locale) : t('santa_polls_create', locale)}
                </button>
              </div>
            </BottomSheet>
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════
          SECRET SANTA — RECEIVER WISHLIST SCREEN
          (Santa-safe, giver can reserve/unreserve items,
           no receiver identity exposed)
          ══════════════════════════════════════════════ */}
      {screen === 'santa-receiver-wishlist' && currentSantaCampaign && (() => {
        const camp = currentSantaCampaign.campaign;
        const wl = santaReceiverWishlist;
        const giftStatusTerminal = ['SENT', 'RECEIVED'].includes(wl?.giftStatus ?? '');
        const isReadOnly = camp.status !== 'ACTIVE' || giftStatusTerminal;

        const handleReserve = async (itemId: string) => {
          if (isReadOnly) return;
          setSantaWishlistReservingId(itemId);
          try {
            const r = await tgFetch(`/tg/santa/campaigns/${camp.id}/inbound/reserve`, {
              method: 'POST', body: JSON.stringify({ itemId }),
            });
            if (r.ok) {
              const data = await r.json() as { myReservations: { id: string; title: string }[] };
              setSantaReceiverWishlist(prev => prev ? {
                ...prev,
                myReservations: data.myReservations,
                items: prev.items.map(it => ({ ...it, reservedByMe: data.myReservations.some(rv => rv.id === it.id) })),
              } : prev);
              // Update parent campaign detail reservedItems
              setCurrentSantaCampaign(prev => prev && prev.myAssignment ? {
                ...prev,
                myAssignment: { ...prev.myAssignment, reservedItems: data.myReservations, giftStatus: 'SELECTED_FROM_WISHLIST' },
              } : prev);
            } else {
              const errBody = await r.json().catch(() => ({})) as { error?: string; message?: string };
              console.error('[reserve] failed', r.status, errBody);
              pushToast(errBody.message || errBody.error || t('toast_error_generic', locale), 'error');
            }
          } catch (err) {
            console.error('[reserve] fetch error', err);
            pushToast(t('toast_error_generic', locale), 'error');
          } finally {
            setSantaWishlistReservingId(null);
          }
        };

        const handleUnreserve = async (itemId: string) => {
          if (isReadOnly) return;
          setSantaWishlistReservingId(itemId);
          try {
            const r = await tgFetch(`/tg/santa/campaigns/${camp.id}/inbound/reserve/${itemId}`, { method: 'DELETE' });
            if (r.ok) {
              const data = await r.json() as { myReservations: { id: string; title: string }[] };
              setSantaReceiverWishlist(prev => prev ? {
                ...prev,
                myReservations: data.myReservations,
                items: prev.items.map(it => ({ ...it, reservedByMe: data.myReservations.some(rv => rv.id === it.id) })),
              } : prev);
              // Update parent campaign detail
              setCurrentSantaCampaign(prev => prev && prev.myAssignment ? {
                ...prev,
                myAssignment: {
                  ...prev.myAssignment,
                  reservedItems: data.myReservations,
                  giftStatus: data.myReservations.length === 0 ? 'PENDING' : prev.myAssignment.giftStatus,
                },
              } : prev);
            } else {
              const errBody = await r.json().catch(() => ({})) as { error?: string; message?: string };
              console.error('[unreserve] failed', r.status, errBody);
              pushToast(errBody.message || errBody.error || t('toast_error_generic', locale), 'error');
            }
          } catch (err) {
            console.error('[unreserve] fetch error', err);
            pushToast(t('toast_error_generic', locale), 'error');
          } finally {
            setSantaWishlistReservingId(null);
          }
        };

        return (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: C.bg }}>
            {/* Header */}
            <div style={{ padding: '16px 20px 8px', borderBottom: `1px solid ${C.border}` }}>
              <div style={{ fontSize: 17, fontWeight: 700, color: C.text }}>
                {t('santa_wishlist_screen_title', locale)}
              </div>
              {wl?.wishlist?.title && (
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>{wl.wishlist.title}</div>
              )}
            </div>

            {/* Reserved summary banner */}
            {(wl?.myReservations?.length ?? 0) > 0 && (
              <div style={{ background: C.accentSoft, padding: '10px 20px', borderBottom: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 13, color: C.accent, fontWeight: 600 }}>
                  {(wl!.myReservations.length === 1)
                    ? t('santa_wishlist_my_reservations_one', locale).replace('{{title}}', wl!.myReservations[0]?.title ?? '')
                    : t('santa_wishlist_my_reservations_many', locale).replace('{{n}}', String(wl!.myReservations.length))}
                </div>
              </div>
            )}

            {/* Read-only banner for terminal gift status */}
            {giftStatusTerminal && (
              <div style={{ background: C.surface, padding: '10px 20px', borderBottom: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 15 }}>🔒</span>
                <div style={{ fontSize: 13, color: C.textMuted }}>
                  {t('santa_wishlist_read_only_sent', locale)}
                </div>
              </div>
            )}

            {/* Items list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px' }}>
              {!wl || wl.items.length === 0 ? (
                <div style={{ textAlign: 'center', color: C.textMuted, fontSize: 14, marginTop: 40 }}>
                  {t('santa_wishlist_empty', locale)}
                </div>
              ) : (
                wl.items.map(item => {
                  const reservedByMe = item.reservedByMe;
                  const reservedByOther = item.status === 'RESERVED' && !reservedByMe;
                  const isReserving = santaWishlistReservingId === item.id;

                  return (
                    <div key={item.id}
                      style={{
                        background: C.card, borderRadius: 12, padding: '12px 14px', marginBottom: 10,
                        border: reservedByMe ? `2px solid ${C.accent}` : `1px solid ${C.border}`,
                        opacity: reservedByOther ? 0.6 : 1,
                        cursor: 'pointer',
                      }}
                      onClick={() => {
                        setSantaDetailContext({
                          source: 'receiver-wishlist',
                          campaignId: camp.id,
                          campaignTitle: camp.title,
                          campaignStatus: camp.status,
                          giftStatus: wl?.giftStatus ?? '',
                        });
                        setViewingItem({
                          id: item.id,
                          title: item.title,
                          description: null,
                          url: item.url,
                          price: null,
                          imageUrl: item.imageUrl,
                          priority: (item.priority as 1 | 2 | 3) ?? 2,
                          position: 0,
                          // Santa reservations live in SantaItemReservation, not Item.status.
                          // Force 'reserved' when reservedByMe so getSantaItemReservationState
                          // correctly returns 'reserved-by-me' instead of 'available'.
                          status: reservedByMe ? 'reserved' : item.status.toLowerCase() as GuestItem['status'],
                          currency: (item.currency as GuestItem['currency']) ?? 'RUB',
                          reservedByDisplayName: null,
                          reservedByActorHash: reservedByMe ? myActorHashRef.current : null,
                        } as GuestItem);
                        setScreen('guest-item-detail');
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                        {/* Item image */}
                        {item.imageUrl && (
                          <img src={item.imageUrl} alt="" style={{ width: 52, height: 52, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }} />
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 2 }}>{item.title}</div>
                          {item.priceText && (
                            <div style={{ fontSize: 12, color: C.textMuted }}>{item.priceText}</div>
                          )}
                          {reservedByMe && (
                            <div style={{ fontSize: 11, color: C.accent, fontWeight: 600, marginTop: 4 }}>
                              ✓ {t('santa_wishlist_reserved_by_me', locale)}
                            </div>
                          )}
                          {reservedByOther && (
                            <div style={{ fontSize: 11, color: C.textMuted, marginTop: 4 }}>
                              🔒 {t('santa_wishlist_reserved_by_other', locale)}
                            </div>
                          )}
                        </div>
                        {/* Action button */}
                        {!isReadOnly && !reservedByOther && (
                          <button
                            disabled={isReserving}
                            onClick={(e) => { e.stopPropagation(); void (reservedByMe ? handleSantaReceiverUnreserve(item.id) : handleSantaReceiverReserve(item.id)); }}
                            style={{
                              flexShrink: 0,
                              background: reservedByMe ? C.surface : C.accent,
                              color: reservedByMe ? C.textSec : '#fff',
                              border: reservedByMe ? `1px solid ${C.border}` : 'none',
                              borderRadius: 8, padding: '6px 12px', fontSize: 12, fontWeight: 600,
                              cursor: isReserving ? 'wait' : 'pointer', fontFamily: font,
                              opacity: isReserving ? 0.6 : 1,
                            }}
                          >
                            {isReserving ? '…' : reservedByMe ? t('santa_wishlist_unreserve', locale) : t('santa_wishlist_reserve', locale)}
                          </button>
                        )}
                        {/* Open link */}
                        {item.url && (
                          <a
                            href={item.url} target="_blank" rel="noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            style={{ flexShrink: 0, fontSize: 11, color: C.accent, textDecoration: 'none', padding: '6px 0' }}
                          >
                            🔗
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════
          SECRET SANTA — CHAT (Batch 4.1)
          ══════════════════════════════════════════════ */}
      {screen === 'santa-chat' && currentSantaCampaign && (() => {
        const camp = currentSantaCampaign.campaign;
        const campId = camp.id;
        const isReadOnly = ['COMPLETED', 'CANCELLED'].includes(camp.status);

        // Render system message body from systemEvent + payload
        const renderSystemMsg = (msg: { systemEvent: string | null; payload: Record<string, string> | null }): string => {
          const name = msg.payload?.displayName ?? '';
          switch (msg.systemEvent) {
            case 'participant_joined': return t('santa_chat_system_joined', locale, { name });
            case 'participant_left': return t('santa_chat_system_left', locale, { name });
            case 'participant_removed': return t('santa_chat_system_removed', locale, { name });
            case 'draw_done': return t('santa_chat_system_draw_done', locale);
            case 'campaign_cancelled': return t('santa_chat_system_cancelled', locale);
            case 'campaign_completed': return t('santa_chat_system_completed', locale);
            default: return msg.systemEvent ?? '';
          }
        };

        const loadEarlier = async () => {
          if (!santaChatHasMore || santaChatLoading) return;
          const oldest = santaChatMessages[0];
          if (!oldest) return;
          setSantaChatLoading(true);
          try {
            const res = await tgFetch(`/tg/santa/campaigns/${campId}/chat?limit=50&before=${oldest.id}`);
            if (res.ok) {
              const data = await res.json() as { messages: ChatMessage[]; hasMore: boolean };
              const reversed = [...data.messages].reverse();
              setSantaChatMessages(prev => [...reversed, ...prev]);
              setSantaChatHasMore(data.hasMore);
            }
          } finally {
            setSantaChatLoading(false);
          }
        };

        const sendMessage = async () => {
          if (!santaChatInput.trim() || santaChatSending || isReadOnly) return;
          if (santaChatInput.length > 1000) { pushToast(t('santa_chat_message_too_long', locale), 'error'); return; }
          const body = santaChatInput.trim();
          setSantaChatInput('');
          setSantaChatSending(true);
          try {
            const res = await tgFetch(`/tg/santa/campaigns/${campId}/chat`, { method: 'POST', body: JSON.stringify({ body }) });
            if (res.ok) {
              const data = await res.json() as { message: ChatMessage };
              setSantaChatMessages(prev => [...prev, data.message]);
              // Mark self as read
              void tgFetch(`/tg/santa/campaigns/${campId}/chat/read`, { method: 'POST', body: JSON.stringify({ lastReadMessageId: data.message.id }) });
            } else {
              pushToast(t('santa_chat_send_error', locale), 'error');
              setSantaChatInput(body); // restore input on failure
            }
          } catch {
            pushToast(t('santa_chat_send_error', locale), 'error');
            setSantaChatInput(body);
          } finally {
            setSantaChatSending(false);
          }
        };

        const toggleMute = async () => {
          const method = santaChatIsMuted ? 'DELETE' : 'POST';
          const res = await tgFetch(`/tg/santa/campaigns/${campId}/mute`, { method });
          if (res.ok) {
            setSantaChatIsMuted(!santaChatIsMuted);
            // update campaign detail isMuted
            setCurrentSantaCampaign(prev => prev ? { ...prev, isMuted: !santaChatIsMuted } : prev);
          }
        };

        return (
          <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: C.bg }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 16px', background: C.card, borderBottom: `1px solid ${C.border}`, flexShrink: 0 }}>
              <button onClick={navBack} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: C.accent, fontSize: 22 }}>←</button>
              <div style={{ flex: 1, fontSize: 15, fontWeight: 700, color: C.text, fontFamily: font, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {camp.title}
              </div>
              <button
                onClick={toggleMute}
                title={santaChatIsMuted ? t('santa_chat_unmute', locale) : t('santa_chat_mute', locale)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, opacity: isReadOnly ? 0.4 : 1 }}
              >
                {santaChatIsMuted ? '🔕' : '🔔'}
              </button>
            </div>

            {/* Messages area */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* Load earlier */}
              {santaChatHasMore && (
                <button
                  onClick={loadEarlier}
                  disabled={santaChatLoading}
                  style={{ background: 'none', border: 'none', color: C.accent, fontSize: 13, cursor: 'pointer', padding: '4px 0', alignSelf: 'center', fontFamily: font }}
                >
                  {santaChatLoading ? t('loading', locale) : t('santa_chat_load_earlier', locale)}
                </button>
              )}

              {/* Empty state */}
              {santaChatMessages.length === 0 && !santaChatLoading && (
                <div style={{ textAlign: 'center', color: C.textSec, fontSize: 14, padding: '40px 0' }}>
                  {t('santa_chat_empty', locale)}
                </div>
              )}

              {/* Messages */}
              {santaChatMessages.map(msg => {
                if (msg.messageType === 'SYSTEM') {
                  return (
                    <div key={msg.id} style={{ display: 'flex', justifyContent: 'center', margin: '4px 0' }}>
                      <div style={{ background: `${C.textSec}20`, borderRadius: 12, padding: '4px 12px', fontSize: 12, color: C.textSec, textAlign: 'center', maxWidth: '80%' }}>
                        {renderSystemMsg(msg)}
                      </div>
                    </div>
                  );
                }
                const isMe = msg.sender?.isMe ?? false;
                return (
                  <div key={msg.id} style={{ display: 'flex', flexDirection: isMe ? 'row-reverse' : 'row', gap: 8, alignItems: 'flex-end' }}>
                    {/* Avatar (only for others) */}
                    {!isMe && (
                      <SantaAvatar
                        alias={msg.sender?.displayName ?? '?'}
                        emoji={msg.sender?.emoji ?? '🎅'}
                        size={28}
                        hat={santaSeason?.inSeason}
                      />
                    )}
                    <div style={{ maxWidth: '70%' }}>
                      {!isMe && (
                        <div style={{ fontSize: 11, color: C.textSec, marginBottom: 2, fontWeight: 600 }}>
                          {msg.sender?.adjectiveKey && msg.sender?.animalKey
                            ? renderSantaAlias(msg.sender.adjectiveKey, msg.sender.animalKey, locale)
                            : msg.sender?.displayName}
                        </div>
                      )}
                      <div style={{ background: isMe ? C.accent : C.card, color: isMe ? '#fff' : C.text, borderRadius: isMe ? '16px 16px 4px 16px' : '16px 16px 16px 4px', padding: '8px 12px', fontSize: 14, lineHeight: 1.4, wordBreak: 'break-word' }}>
                        {msg.body}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Read-only notice */}
            {isReadOnly && (
              <div style={{ background: `${C.textSec}15`, padding: '8px 16px', textAlign: 'center', fontSize: 12, color: C.textSec, flexShrink: 0 }}>
                {camp.status === 'COMPLETED' ? t('santa_chat_read_only_completed', locale) : t('santa_chat_read_only_cancelled', locale)}
              </div>
            )}

            {/* Input bar */}
            {!isReadOnly && (
              <div style={{ display: 'flex', gap: 8, padding: '10px 16px', background: C.card, borderTop: `1px solid ${C.border}`, flexShrink: 0 }}>
                <input
                  value={santaChatInput}
                  onChange={e => setSantaChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendMessage(); } }}
                  placeholder={t('santa_chat_input_placeholder', locale)}
                  maxLength={1000}
                  style={{ flex: 1, background: `${C.textSec}10`, border: `1px solid ${C.border}`, borderRadius: 20, padding: '8px 14px', fontSize: 14, color: C.text, fontFamily: font, outline: 'none' }}
                />
                <button
                  onClick={() => void sendMessage()}
                  disabled={!santaChatInput.trim() || santaChatSending}
                  style={{ background: C.accent, border: 'none', borderRadius: 20, padding: '8px 16px', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: font, opacity: (!santaChatInput.trim() || santaChatSending) ? 0.5 : 1, flexShrink: 0 }}
                >
                  {santaChatSending ? '…' : t('santa_chat_send', locale)}
                </button>
              </div>
            )}
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════
          SECRET SANTA — EXCLUSIONS (Batch 5.1)
          ══════════════════════════════════════════════ */}
      {screen === 'santa-exclusions' && currentSantaCampaign && (() => {
        const camp = currentSantaCampaign.campaign;
        const campId = camp.id;
        const joinedParticipants = currentSantaCampaign.participants.filter(p => p.status === 'JOINED');
        const isPro = planInfo.code === 'PRO';

        const reloadExclusions = async () => {
          const res = await tgFetch(`/tg/santa/campaigns/${campId}/exclusions`);
          if (res.ok) {
            const data = await res.json() as { exclusions: ExclusionPair[]; groups: ExclusionGroup[] };
            setSantaExclPairs(data.exclusions);
            setSantaExclGroups(data.groups);
          }
        };

        const addPair = async () => {
          if (!santaExclPairA || !santaExclPairB || santaExclPairA === santaExclPairB) return;
          setSantaExclPairSaving(true);
          try {
            const res = await tgFetch(`/tg/santa/campaigns/${campId}/exclusions`, {
              method: 'POST',
              body: JSON.stringify({ userId1: santaExclPairA, userId2: santaExclPairB }),
            });
            if (res.ok) {
              setSantaExclAddPairOpen(false);
              setSantaExclPairA('');
              setSantaExclPairB('');
              await reloadExclusions();
              pushToast(t('done', locale), 'success');
            } else {
              const err = await res.json() as { error?: string };
              pushToast(err.error ?? t('error_generic', locale), 'error');
            }
          } finally {
            setSantaExclPairSaving(false);
          }
        };

        const deletePair = async (id: string) => {
          const res = await tgFetch(`/tg/santa/campaigns/${campId}/exclusions/${id}`, { method: 'DELETE' });
          if (res.ok) {
            setSantaExclPairs(prev => prev.filter(p => p.id !== id));
          } else pushToast(t('error_generic', locale), 'error');
        };

        const createGroup = async () => {
          if (!santaExclGroupLabel.trim()) return;
          setSantaExclGroupSaving(true);
          try {
            const res = await tgFetch(`/tg/santa/campaigns/${campId}/exclusions/groups`, {
              method: 'POST',
              body: JSON.stringify({ label: santaExclGroupLabel.trim() }),
            });
            if (res.ok) {
              setSantaExclGroupSheetOpen(false);
              setSantaExclGroupLabel('');
              await reloadExclusions();
              pushToast(t('done', locale), 'success');
            } else pushToast(t('error_generic', locale), 'error');
          } finally {
            setSantaExclGroupSaving(false);
          }
        };

        const deleteGroup = async (groupId: string, label: string) => {
          if (!confirm(t('santa_excl_delete_group_confirm', locale, { label }))) return;
          const res = await tgFetch(`/tg/santa/campaigns/${campId}/exclusions/groups/${groupId}`, { method: 'DELETE' });
          if (res.ok) {
            setSantaExclGroups(prev => prev.filter(g => g.id !== groupId));
          } else pushToast(t('error_generic', locale), 'error');
        };

        const addMember = async () => {
          if (!santaExclAddMemberGroupId || !santaExclAddMemberUserId) return;
          setSantaExclAddMemberSaving(true);
          try {
            const res = await tgFetch(`/tg/santa/campaigns/${campId}/exclusions/groups/${santaExclAddMemberGroupId}/members`, {
              method: 'POST',
              body: JSON.stringify({ userId: santaExclAddMemberUserId }),
            });
            if (res.ok) {
              setSantaExclAddMemberGroupId(null);
              setSantaExclAddMemberUserId('');
              await reloadExclusions();
              pushToast(t('done', locale), 'success');
            } else {
              const err = await res.json() as { error?: string };
              pushToast(err.error ?? t('error_generic', locale), 'error');
            }
          } finally {
            setSantaExclAddMemberSaving(false);
          }
        };

        const removeMember = async (groupId: string, userId: string) => {
          const res = await tgFetch(`/tg/santa/campaigns/${campId}/exclusions/groups/${groupId}/members/${userId}`, { method: 'DELETE' });
          if (res.ok) {
            setSantaExclGroups(prev => prev.map(g => g.id === groupId
              ? { ...g, members: g.members.filter(m => m.userId !== userId) }
              : g
            ));
          } else pushToast(t('error_generic', locale), 'error');
        };

        return (
          <div style={{ padding: '16px 20px 120px' }}>
            <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: font, color: C.text, margin: '8px 0 20px' }}>
              🚫 {t('santa_excl_title', locale)}
            </h1>

            {santaExclLoading && (
              <div style={{ color: C.textMuted, fontSize: 14, textAlign: 'center', padding: 40 }}>{t('loading', locale)}</div>
            )}

            {!santaExclLoading && (
              <>
                {/* Individual pairs section */}
                <div style={{ marginBottom: 24 }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
                    {t('santa_excl_pairs_section', locale)}
                  </div>

                  {santaExclPairs.length === 0 && (
                    <div style={{ fontSize: 13, color: C.textMuted, padding: '12px 0' }}>{t('santa_excl_empty', locale)}</div>
                  )}

                  {santaExclPairs.map(pair => (
                    <div key={pair.id} style={{ background: C.card, borderRadius: 12, padding: '10px 14px', marginBottom: 8, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 14, color: C.text }}>
                        {pair.name1} — {pair.name2}
                      </span>
                      <button
                        onClick={() => void deletePair(pair.id)}
                        style={{ background: 'none', border: 'none', color: C.red, fontSize: 18, cursor: 'pointer', padding: '0 4px', lineHeight: 1 }}
                      >×</button>
                    </div>
                  ))}

                  {isPro ? (
                    <button
                      onClick={() => setSantaExclAddPairOpen(true)}
                      style={{ background: 'none', border: `1px dashed ${C.accent}`, borderRadius: 12, color: C.accent, fontSize: 13, fontWeight: 600, padding: '10px 14px', cursor: 'pointer', width: '100%', fontFamily: font, marginTop: 4 }}
                    >
                      {t('santa_excl_add_pair', locale)}
                    </button>
                  ) : (
                    <div style={{ background: `${C.accent}10`, borderRadius: 12, padding: '10px 14px', fontSize: 13, color: C.accent, marginTop: 4 }}>
                      🔒 {t('santa_excl_pro_hint', locale)}
                    </div>
                  )}
                </div>

                {/* Groups section */}
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 }}>
                    {t('santa_excl_groups_section', locale)}
                  </div>

                  {santaExclGroups.length === 0 && (
                    <div style={{ fontSize: 13, color: C.textMuted, padding: '12px 0' }}>{t('santa_excl_groups_empty', locale)}</div>
                  )}

                  {santaExclGroups.map(group => (
                    <div key={group.id} style={{ background: C.card, borderRadius: 12, padding: '12px 14px', marginBottom: 10 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{group.label}</span>
                        <button
                          onClick={() => void deleteGroup(group.id, group.label)}
                          style={{ background: 'none', border: 'none', color: C.red, fontSize: 13, cursor: 'pointer', padding: '0 4px' }}
                        >
                          {t('delete', locale)}
                        </button>
                      </div>

                      {/* Warn if fewer than 2 active members — group has no draw effect */}
                      {group.activeCount < 2 && (
                        <div style={{ fontSize: 11, color: C.orange ?? C.textMuted, marginBottom: 6 }}>
                          ⚠️ {locale === 'ru'
                            ? 'Группа не влияет на жеребьёвку (нужно ≥ 2 активных участника)'
                            : 'Group has no effect on draw (need ≥ 2 active members)'}
                        </div>
                      )}

                      {group.members.map(member => {
                        const name = member.adjectiveKey && member.animalKey
                          ? renderSantaAlias(member.adjectiveKey, member.animalKey, locale)
                          : member.displayName || member.userId;
                        return (
                          <div key={member.userId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', opacity: member.isStale ? 0.45 : 1 }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                              <SantaAvatar alias={name} emoji={member.emoji ?? '🎅'} size={24} hat={santaSeason?.inSeason} />
                              <span style={{ fontSize: 13, color: member.isStale ? C.textMuted : C.textSec }}>
                                {name}{member.isStale ? (locale === 'ru' ? ' (вышел)' : ' (left)') : ''}
                              </span>
                            </div>
                            <button
                              onClick={() => void removeMember(group.id, member.userId)}
                              style={{ background: 'none', border: 'none', color: C.red, fontSize: 16, cursor: 'pointer', padding: '0 4px' }}
                            >×</button>
                          </div>
                        );
                      })}

                      {isPro && (
                        <button
                          onClick={() => { setSantaExclAddMemberGroupId(group.id); setSantaExclAddMemberUserId(''); }}
                          style={{ background: 'none', border: 'none', color: C.accent, fontSize: 13, cursor: 'pointer', padding: '6px 0 0', fontFamily: font }}
                        >
                          + {t('santa_excl_member_add', locale)}
                        </button>
                      )}
                    </div>
                  ))}

                  {isPro ? (
                    <button
                      onClick={() => { setSantaExclGroupLabel(''); setSantaExclGroupSheetOpen(true); }}
                      style={{ background: 'none', border: `1px dashed ${C.accent}`, borderRadius: 12, color: C.accent, fontSize: 13, fontWeight: 600, padding: '10px 14px', cursor: 'pointer', width: '100%', fontFamily: font, marginTop: 4 }}
                    >
                      {t('santa_excl_add_group', locale)}
                    </button>
                  ) : (
                    santaExclGroups.length === 0 && (
                      <div style={{ background: `${C.accent}10`, borderRadius: 12, padding: '10px 14px', fontSize: 13, color: C.accent, marginTop: 4 }}>
                        🔒 {t('santa_excl_pro_hint', locale)}
                      </div>
                    )
                  )}
                </div>
              </>
            )}

            {/* Add pair sheet */}
            <BottomSheet isOpen={santaExclAddPairOpen} onClose={() => setSantaExclAddPairOpen(false)} title={t('santa_excl_add_pair', locale)}>
              <div>
                <div style={{ fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('santa_excl_select_a', locale)}</div>
                <select
                  value={santaExclPairA}
                  onChange={e => setSantaExclPairA(e.target.value)}
                  style={{ width: '100%', background: `${C.textSec}10`, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', fontSize: 14, color: C.text, fontFamily: font, outline: 'none', boxSizing: 'border-box', marginBottom: 12 }}
                >
                  <option value="">—</option>
                  {joinedParticipants.map(p => (
                    <option key={p.userId} value={p.userId}>{p.displayName || p.userId}</option>
                  ))}
                </select>

                <div style={{ fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('santa_excl_select_b', locale)}</div>
                <select
                  value={santaExclPairB}
                  onChange={e => setSantaExclPairB(e.target.value)}
                  style={{ width: '100%', background: `${C.textSec}10`, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', fontSize: 14, color: C.text, fontFamily: font, outline: 'none', boxSizing: 'border-box', marginBottom: 16 }}
                >
                  <option value="">—</option>
                  {joinedParticipants.filter(p => p.userId !== santaExclPairA).map(p => (
                    <option key={p.userId} value={p.userId}>{p.displayName || p.userId}</option>
                  ))}
                </select>

                {santaExclPairA && santaExclPairB && (
                  <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 12 }}>
                    {t('santa_excl_pair_conflict', locale, {
                      name1: joinedParticipants.find(p => p.userId === santaExclPairA)?.displayName ?? santaExclPairA,
                      name2: joinedParticipants.find(p => p.userId === santaExclPairB)?.displayName ?? santaExclPairB,
                    })}
                  </div>
                )}

                <button
                  onClick={() => void addPair()}
                  disabled={!santaExclPairA || !santaExclPairB || santaExclPairA === santaExclPairB || santaExclPairSaving}
                  style={{ background: C.accent, border: 'none', borderRadius: 12, padding: '13px 0', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', width: '100%', fontFamily: font, opacity: (!santaExclPairA || !santaExclPairB || santaExclPairA === santaExclPairB || santaExclPairSaving) ? 0.5 : 1 }}
                >
                  {santaExclPairSaving ? t('loading', locale) : t('santa_excl_confirm_add', locale)}
                </button>
              </div>
            </BottomSheet>

            {/* Create group sheet */}
            <BottomSheet isOpen={santaExclGroupSheetOpen} onClose={() => setSantaExclGroupSheetOpen(false)} title={t('santa_excl_add_group', locale)}>
              <div>
                <div style={{ fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('santa_excl_group_label', locale)}</div>
                <input
                  value={santaExclGroupLabel}
                  onChange={e => setSantaExclGroupLabel(e.target.value)}
                  placeholder={t('santa_excl_group_label_placeholder', locale)}
                  maxLength={80}
                  style={{ width: '100%', background: `${C.textSec}10`, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', fontSize: 14, color: C.text, fontFamily: font, outline: 'none', boxSizing: 'border-box', marginBottom: 16 }}
                />
                <button
                  onClick={() => void createGroup()}
                  disabled={!santaExclGroupLabel.trim() || santaExclGroupSaving}
                  style={{ background: C.accent, border: 'none', borderRadius: 12, padding: '13px 0', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', width: '100%', fontFamily: font, opacity: (!santaExclGroupLabel.trim() || santaExclGroupSaving) ? 0.5 : 1 }}
                >
                  {santaExclGroupSaving ? t('loading', locale) : t('santa_excl_confirm_add', locale)}
                </button>
              </div>
            </BottomSheet>

            {/* Add member to group sheet */}
            <BottomSheet isOpen={santaExclAddMemberGroupId !== null} onClose={() => { setSantaExclAddMemberGroupId(null); setSantaExclAddMemberUserId(''); }} title={t('santa_excl_add_members', locale)}>
              {santaExclAddMemberGroupId && (() => {
                const group = santaExclGroups.find(g => g.id === santaExclAddMemberGroupId);
                const alreadyInGroup = new Set(group?.members.map(m => m.userId) ?? []);
                const available = joinedParticipants.filter(p => !alreadyInGroup.has(p.userId));
                return (
                  <div>
                    {available.length === 0 ? (
                      <div style={{ fontSize: 14, color: C.textMuted, textAlign: 'center', padding: '20px 0' }}>
                        {locale === 'ru' ? 'Все участники уже в группе' : 'All participants already in group'}
                      </div>
                    ) : (
                      <>
                        <select
                          value={santaExclAddMemberUserId}
                          onChange={e => setSantaExclAddMemberUserId(e.target.value)}
                          style={{ width: '100%', background: `${C.textSec}10`, border: `1px solid ${C.border}`, borderRadius: 10, padding: '10px 12px', fontSize: 14, color: C.text, fontFamily: font, outline: 'none', boxSizing: 'border-box', marginBottom: 16 }}
                        >
                          <option value="">—</option>
                          {available.map(p => (
                            <option key={p.userId} value={p.userId}>{p.displayName || p.userId}</option>
                          ))}
                        </select>
                        <button
                          onClick={() => void addMember()}
                          disabled={!santaExclAddMemberUserId || santaExclAddMemberSaving}
                          style={{ background: C.accent, border: 'none', borderRadius: 12, padding: '13px 0', color: '#fff', fontSize: 15, fontWeight: 700, cursor: 'pointer', width: '100%', fontFamily: font, opacity: (!santaExclAddMemberUserId || santaExclAddMemberSaving) ? 0.5 : 1 }}
                        >
                          {santaExclAddMemberSaving ? t('loading', locale) : t('santa_excl_member_add', locale)}
                        </button>
                      </>
                    )}
                  </div>
                );
              })()}
            </BottomSheet>
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════
          SECRET SANTA — ORGANIZER PANEL (Batch 5.3)
          ══════════════════════════════════════════════ */}
      {screen === 'santa-organizer' && currentSantaCampaign && (() => {
        const camp = currentSantaCampaign.campaign;
        const campId = camp.id;
        const campIsOwner = camp.isOwner;   // approve/deny are owner-only even in organizer screen
        const summary = santaOrganizerSummary;

        return (
          <div style={{ padding: '16px 20px 120px' }}>
            <h1 style={{ fontSize: 20, fontWeight: 800, fontFamily: font, color: C.text, margin: '8px 0 4px' }}>
              🛡 {t('santa_organizer_title', locale)}
            </h1>
            <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 20 }}>{camp.title}</div>

            {santaOrganizerLoading && (
              <div style={{ fontSize: 14, color: C.textMuted, textAlign: 'center', marginTop: 40 }}>{t('loading', locale)}</div>
            )}

            {summary && !santaOrganizerLoading && (
              <>
                {/* Pending exit requests */}
                {summary.pendingExitRequests.length > 0 && (
                  <div style={{ background: C.card, borderRadius: 14, padding: 16, marginBottom: 16 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, marginBottom: 10 }}>
                      {t('santa_organizer_exit_requests', locale, { n: String(summary.pendingExitRequests.length) })}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {summary.pendingExitRequests.map(req => {
                        const reqAlias = req.adjectiveKey && req.animalKey
                          ? renderSantaAlias(req.adjectiveKey, req.animalKey, locale)
                          : req.displayName;
                        return (
                        <div key={req.id} style={{ background: C.surface, borderRadius: 10, padding: '10px 12px' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                            <SantaAvatar alias={reqAlias} emoji={req.emoji ?? '🎅'} size={28} hat={santaSeason?.inSeason} />
                            <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{reqAlias}</span>
                          </div>
                          {req.reason && <div style={{ fontSize: 12, color: C.textSec, marginBottom: 8 }}>{req.reason}</div>}
                          {/* Approve/deny are owner-only; admins can see the request but cannot act on it */}
                          {campIsOwner && (
                          <div style={{ display: 'flex', gap: 8 }}>
                            <button
                              onClick={async () => {
                                if (!confirm(`${t('santa_exit_request_approve', locale)} ${reqAlias}?`)) return;
                                const res = await tgFetch(`/tg/santa/campaigns/${campId}/exit-requests/${req.id}/approve`, { method: 'POST' });
                                if (res.ok) {
                                  // Reload summary
                                  const refreshRes = await tgFetch(`/tg/santa/campaigns/${campId}/organizer/summary`);
                                  if (refreshRes.ok) setSantaOrganizerSummary(await refreshRes.json() as OrganizerSummary);
                                  pushToast(t('done', locale), 'success');
                                } else pushToast(t('error_generic', locale), 'error');
                              }}
                              style={{ flex: 1, background: C.green, border: 'none', borderRadius: 8, color: '#fff', fontSize: 12, fontWeight: 700, padding: '7px 0', cursor: 'pointer', fontFamily: font }}
                            >
                              {t('santa_exit_request_approve', locale)}
                            </button>
                            <button
                              onClick={async () => {
                                const res = await tgFetch(`/tg/santa/campaigns/${campId}/exit-requests/${req.id}/deny`, { method: 'POST' });
                                if (res.ok) {
                                  const refreshRes = await tgFetch(`/tg/santa/campaigns/${campId}/organizer/summary`);
                                  if (refreshRes.ok) setSantaOrganizerSummary(await refreshRes.json() as OrganizerSummary);
                                  pushToast(t('done', locale), 'success');
                                } else pushToast(t('error_generic', locale), 'error');
                              }}
                              style={{ flex: 1, background: 'none', border: `1px solid ${C.red}`, borderRadius: 8, color: C.red, fontSize: 12, fontWeight: 700, padding: '7px 0', cursor: 'pointer', fontFamily: font }}
                            >
                              {t('santa_exit_request_deny', locale)}
                            </button>
                          </div>
                          )}
                        </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Gift progress */}
                {summary.giftProgress && (
                  <div style={{ background: C.card, borderRadius: 14, padding: 16, marginBottom: 16 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.textMuted, marginBottom: 10 }}>
                      {t('santa_organizer_progress', locale)}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {[
                        { key: 'pending', v: summary.giftProgress.pending, label: t('santa_gift_progress_pending', locale, { count: summary.giftProgress.pending, total: 0 }), color: C.textSec },
                        { key: 'buying', v: summary.giftProgress.buying, label: t('santa_gift_progress_buying', locale, { count: summary.giftProgress.buying }), color: C.textSec },
                        { key: 'selectedFromWishlist', v: summary.giftProgress.selectedFromWishlist, label: t('santa_gift_progress_selected_wishlist', locale, { count: summary.giftProgress.selectedFromWishlist }), color: C.accent },
                        { key: 'selectedOutside', v: summary.giftProgress.selectedOutside, label: t('santa_gift_progress_selected_outside', locale, { count: summary.giftProgress.selectedOutside }), color: C.accent },
                        { key: 'declinedToSay', v: summary.giftProgress.declinedToSay, label: t('santa_gift_progress_declined', locale, { count: summary.giftProgress.declinedToSay }), color: C.textSec },
                        { key: 'sent', v: summary.giftProgress.sent, label: t('santa_gift_progress_sent', locale, { count: summary.giftProgress.sent }), color: C.accent },
                        { key: 'received', v: summary.giftProgress.received, label: t('santa_gift_progress_received', locale, { count: summary.giftProgress.received }), color: C.green },
                        { key: 'missedDeadline', v: summary.giftProgress.missedDeadline, label: t('santa_gift_progress_missed_deadline', locale, { count: summary.giftProgress.missedDeadline }), color: '#e05' },
                        { key: 'orphaned', v: summary.giftProgress.orphaned, label: t('santa_gift_status_orphaned', locale), color: C.textMuted },
                      ].filter(r => r.v > 0).map(r => (
                        <div key={r.key} style={{ fontSize: 13, color: r.color }}>{r.label}</div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Participants list with role badges */}
                <div style={{ background: C.card, borderRadius: 14, overflow: 'hidden', marginBottom: 16 }}>
                  <div style={{ padding: '12px 16px 8px', fontSize: 13, fontWeight: 600, color: C.textMuted }}>
                    {t('santa_organizer_participants', locale, { n: String(summary.participants.filter(p => p.status === 'JOINED').length) })}
                  </div>
                  {summary.participants.filter(p => p.status === 'JOINED').map((p, idx, arr) => {
                    const pAlias = p.adjectiveKey && p.animalKey
                      ? renderSantaAlias(p.adjectiveKey, p.animalKey, locale)
                      : p.displayName;
                    return (
                    <div key={p.id} style={{ padding: '10px 16px', display: 'flex', alignItems: 'center', gap: 10, borderBottom: idx < arr.length - 1 ? `1px solid ${C.border}` : 'none' }}>
                      <SantaAvatar alias={pAlias} emoji={p.emoji ?? '🎅'} size={30} hat={santaSeason?.inSeason} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{pAlias}</span>
                          {p.role === 'ADMIN' && (
                            <span style={{ fontSize: 10, fontWeight: 700, color: C.accent, background: `${C.accent}15`, padding: '1px 5px', borderRadius: 5 }}>
                              {t('santa_role_admin', locale)}
                            </span>
                          )}
                        </div>
                        {p.hasLinkedWishlist ? (
                          <div style={{ fontSize: 11, color: C.green, marginTop: 2 }}>🎁 {t('santa_wishlist_linked_label', locale)}</div>
                        ) : (
                          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>⚠️ {t('santa_campaign_wishlist_not_linked_active', locale)}</div>
                        )}
                      </div>
                    </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════
          SECRET SANTA — JOIN
          ══════════════════════════════════════════════ */}
      {screen === 'santa-join' && (
        <div style={{ padding: '16px 20px 120px' }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: font, color: C.text, margin: '8px 0 24px' }}>
            🎅 {t('santa_join_title', locale)}
          </h1>

          {santaJoinLoading && (
            <div style={{ color: C.textMuted, fontSize: 14, textAlign: 'center', padding: 40 }}>{t('loading', locale)}</div>
          )}

          {/* P0-B: fallback when invite resolves to no preview (e.g. campaign not open, unknown error) */}
          {!santaJoinLoading && !santaJoinPreview && (
            <div style={{ background: C.card, borderRadius: 16, padding: 24, textAlign: 'center' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>🔒</div>
              <div style={{ color: C.textMuted, fontSize: 14, marginBottom: 16 }}>
                {locale === 'ru' ? 'Кампания недоступна или не принимает участников' : 'This campaign is not available or not accepting participants'}
              </div>
              <button
                onClick={() => setScreen('my-wishlists')}
                style={{ background: C.accent, border: 'none', borderRadius: 12, color: '#fff', fontSize: 14, fontWeight: 600, padding: '12px 24px', cursor: 'pointer', fontFamily: font }}
              >
                {locale === 'ru' ? 'На главную' : 'Go home'}
              </button>
            </div>
          )}

          {!santaJoinLoading && santaJoinPreview && santaJoinPreview.status === 'CANCELLED' && (
            <div style={{ background: C.redSoft, borderRadius: 16, padding: 24, textAlign: 'center' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>❌</div>
              <div style={{ color: C.red, fontSize: 14, fontWeight: 600 }}>{t('santa_join_cancelled', locale)}</div>
            </div>
          )}

          {!santaJoinLoading && santaJoinPreview && santaJoinPreview.status !== 'CANCELLED' && (
            <div>
              <div style={{ background: C.card, borderRadius: 16, padding: 20, marginBottom: 20 }}>
                <h2 style={{ fontSize: 20, fontWeight: 800, color: C.text, margin: '0 0 8px' }}>{santaJoinPreview.title}</h2>
                {santaJoinPreview.ownerName && (
                  <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 4 }}>
                    {t('santa_join_organizer', locale, { name: santaJoinPreview.ownerName })}
                  </div>
                )}
                <div style={{ fontSize: 13, color: C.textMuted, marginBottom: 4 }}>
                  {t('santa_join_participants', locale, { count: santaJoinPreview.participantCount })}
                </div>
                {santaJoinPreview.minBudget && santaJoinPreview.maxBudget && (
                  <div style={{ fontSize: 13, color: C.textMuted }}>
                    {t('santa_join_budget', locale, { min: santaJoinPreview.minBudget, max: santaJoinPreview.maxBudget, currency: santaJoinPreview.currency })}
                  </div>
                )}
                {santaJoinPreview.description && (
                  <p style={{ fontSize: 13, color: C.textSec, marginTop: 8, lineHeight: 1.5 }}>{santaJoinPreview.description}</p>
                )}
              </div>

              {santaJoinDone ? (
                <div style={{ background: C.greenSoft, borderRadius: 16, padding: 20, textAlign: 'center' }}>
                  <div style={{ fontSize: 40, marginBottom: 8 }}>✅</div>
                  <div style={{ color: C.green, fontSize: 15, fontWeight: 700 }}>
                    {t('santa_join_success', locale, { title: santaJoinPreview.title })}
                  </div>
                  <button
                    onClick={async () => {
                      setSantaCampaignsLoading(true);
                      const res = await tgFetch('/tg/santa/campaigns');
                      if (res.ok) setSantaCampaigns(await res.json() as typeof santaCampaigns);
                      setSantaCampaignsLoading(false);
                      setScreen('santa-hub');
                    }}
                    style={{ marginTop: 16, background: C.accent, border: 'none', borderRadius: 12, color: '#fff', fontSize: 15, fontWeight: 600, padding: '12px 24px', cursor: 'pointer' }}
                  >
                    {t('santa_home_my_campaigns', locale)}
                  </button>
                </div>
              ) : (
                <button
                  disabled={santaJoinLoading || !['OPEN', 'DRAFT'].includes(santaJoinPreview.status)}
                  onClick={async () => {
                    if (!santaJoinToken) return;
                    setSantaJoinLoading(true);
                    try {
                      const res = await tgFetch(`/tg/santa/campaigns/${santaJoinPreview.id}/join`, { method: 'POST' });
                      if (res.ok) {
                        setSantaJoinDone(true);
                      } else {
                        const json = await res.json() as { error?: string };
                        pushToast(json.error === 'Not accepting' ? t('santa_join_closed', locale) : t('error_generic', locale), 'error');
                      }
                    } catch {
                      pushToast(t('error_network', locale), 'error');
                    } finally {
                      setSantaJoinLoading(false);
                    }
                  }}
                  style={{
                    background: !['OPEN', 'DRAFT'].includes(santaJoinPreview.status) ? C.textMuted : C.accent,
                    border: 'none', borderRadius: 14, color: '#fff', fontSize: 15, fontWeight: 700,
                    padding: '14px 0', cursor: !['OPEN', 'DRAFT'].includes(santaJoinPreview.status) ? 'not-allowed' : 'pointer',
                    fontFamily: font, width: '100%',
                  }}
                >
                  {!['OPEN', 'DRAFT'].includes(santaJoinPreview.status) ? t('santa_join_closed', locale) : t('santa_join_btn', locale)}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── ONBOARDING SOFT CTA BANNER (shown when drafts have user content) ── */}
      {showOnboardingSoftCta && screen === 'my-wishlists' && (
        <div style={{
          position: 'fixed', bottom: 80, left: 16, right: 16, zIndex: 150,
          background: C.card, borderRadius: 16, padding: '14px 16px',
          boxShadow: '0 8px 24px rgba(0,0,0,0.35)', border: `1px solid ${C.borderLight}`,
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 10 }}>
            {t('onboarding_soft_cta_title', locale)}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => void startOnboarding('manual_cta')}
              disabled={onboardingLoading}
              style={{ flex: 1, padding: '10px 0', borderRadius: 12, border: 'none', background: C.accent, color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: font, opacity: onboardingLoading ? 0.6 : 1 }}
            >
              {t('onboarding_soft_cta_yes', locale)}
            </button>
            <button
              onClick={() => void dismissOnboarding()}
              style={{ flex: 1, padding: '10px 0', borderRadius: 12, border: `1px solid ${C.borderLight}`, background: 'none', color: C.textSec, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: font }}
            >
              {t('onboarding_soft_cta_no', locale)}
            </button>
          </div>
        </div>
      )}

      {/* ── ONBOARDING ENTRY SCREEN ── */}
      {screen === 'onboarding-entry' && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 100,
          background: 'linear-gradient(160deg, #0f0a1e 0%, #0d1628 55%, #091520 100%)',
          display: 'flex', flexDirection: 'column', fontFamily: font, overflowY: 'auto',
        }}>
          {/* Skip top-right */}
          <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 1 }}>
            <button
              onClick={() => void dismissOnboarding().then(() => setScreen('my-wishlists'))}
              style={{ background: 'rgba(255,255,255,0.1)', border: 'none', borderRadius: 20, padding: '6px 14px', color: 'rgba(255,255,255,0.45)', fontSize: 13, cursor: 'pointer', fontFamily: font }}
            >
              {t('onboarding_entry_skip', locale)}
            </button>
          </div>

          {/* Mock wish cards hero */}
          <div style={{ paddingTop: 52, paddingBottom: 4, display: 'flex', justifyContent: 'center', alignItems: 'flex-end', gap: 0 }}>
            {(locale === 'ru' ? [
              { emoji: '🎸', title: 'Гитара Fender', price: '45 000 ₽', rotate: -8, ty: 12, accent: '#a78bfa' },
              { emoji: '👟', title: 'Nike Air Max', price: '12 500 ₽', rotate: 0, ty: 0, accent: '#f472b6' },
              { emoji: '📷', title: 'Fujifilm X100', price: '110 000 ₽', rotate: 8, ty: 12, accent: '#fb923c' },
            ] : [
              { emoji: '🎧', title: 'AirPods Pro', price: '$249', rotate: -8, ty: 12, accent: '#a78bfa' },
              { emoji: '👟', title: 'Nike Air Max', price: '$120', rotate: 0, ty: 0, accent: '#f472b6' },
              { emoji: '📚', title: 'Kindle Paperwhite', price: '$139', rotate: 8, ty: 12, accent: '#fb923c' },
            ] as { emoji: string; title: string; price: string; rotate: number; ty: number; accent: string }[]).map((card, i) => (
              <div key={i} style={{
                background: 'rgba(255,255,255,0.07)',
                border: '1px solid rgba(255,255,255,0.13)',
                borderRadius: 16, padding: '14px 12px', width: 108,
                marginLeft: i > 0 ? -14 : 0,
                transform: `rotate(${card.rotate}deg) translateY(${card.ty}px)`,
                boxShadow: i === 1 ? '0 16px 48px rgba(124,106,255,0.35)' : '0 4px 16px rgba(0,0,0,0.5)',
                zIndex: i === 1 ? 2 : 1, position: 'relative',
              }}>
                <div style={{ fontSize: 26, marginBottom: 8 }}>{card.emoji}</div>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#fff', lineHeight: 1.3, marginBottom: 5 }}>{card.title}</div>
                <div style={{ fontSize: 11, color: card.accent, fontWeight: 700 }}>{card.price}</div>
              </div>
            ))}
          </div>

          {/* Headline */}
          <div style={{ padding: '26px 28px 18px', textAlign: 'center' }}>
            <div style={{ fontSize: 26, fontWeight: 800, color: '#fff', lineHeight: 1.2, letterSpacing: '-0.02em', marginBottom: 10 }}>
              {t('onboarding_entry_title', locale)}
            </div>
            <div style={{ fontSize: 15, color: 'rgba(255,255,255,0.5)', lineHeight: 1.55 }}>
              {t('onboarding_entry_subtitle', locale)}
            </div>
          </div>

          {/* Feature highlights */}
          <div style={{ padding: '0 20px', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {([
              { icon: '✨', title: locale === 'ru' ? 'Любой товар из сети' : 'Any item from the web', desc: locale === 'ru' ? 'Вставь ссылку — карточка соберётся сама' : 'Paste a link and the card fills itself' },
              { icon: '🔗', title: locale === 'ru' ? 'Делись без регистрации' : 'Share without sign-up', desc: locale === 'ru' ? 'Твои желания открываются по ссылке' : 'Your list opens via a simple link' },
              { icon: '🎁', title: locale === 'ru' ? 'Сюрприз не раскроется' : 'No spoilers', desc: locale === 'ru' ? 'Кто что берёт — видно только дарящим' : 'Who picks what stays secret from you' },
            ] as { icon: string; title: string; desc: string }[]).map((f, i) => (
              <div key={i} style={{
                display: 'flex', gap: 12, alignItems: 'center',
                background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 14, padding: '11px 14px',
              }}>
                <div style={{ fontSize: 20, width: 28, textAlign: 'center', flexShrink: 0 }}>{f.icon}</div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#fff', marginBottom: 2 }}>{f.title}</div>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', lineHeight: 1.4 }}>{f.desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* CTA */}
          <div style={{ padding: '20px 20px 44px', marginTop: 'auto' }}>
            <button
              onClick={() => void startOnboarding(wishlists.length === 0 ? 'first_open' : 'organic_returning_underactivated')}
              disabled={onboardingLoading}
              style={{
                width: '100%', padding: '17px 0', borderRadius: 16, border: 'none',
                background: 'linear-gradient(135deg, #7c6aff 0%, #a855f7 100%)',
                color: '#fff', fontSize: 17, fontWeight: 700, cursor: 'pointer', fontFamily: font,
                boxShadow: '0 8px 24px rgba(124,106,255,0.4)', opacity: onboardingLoading ? 0.7 : 1,
              }}
            >
              {onboardingLoading ? '…' : t('onboarding_entry_cta', locale)}
            </button>
          </div>
        </div>
      )}

      {/* ── ONBOARDING DEMO SCREEN ── */}
      {screen === 'onboarding-demo' && onboardingDemoItem && (
        <div style={{ position: 'fixed', inset: 0, background: C.bg, zIndex: 100, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
          {/* Header */}
          <div style={{ display: 'flex', alignItems: 'center', padding: '16px 16px 0', gap: 8 }}>
            <button onClick={() => setScreen('my-wishlists')} style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: C.text, fontFamily: font, fontSize: 15 }}>
              ← {t('back', locale)}
            </button>
          </div>

          <div style={{ padding: '20px 20px 0', textAlign: 'center' }}>
            <div style={{ fontSize: 19, fontWeight: 700, color: C.text, marginBottom: 6 }}>{t('onboarding_demo_title', locale)}</div>
            <div style={{ fontSize: 14, color: C.textSec, lineHeight: 1.5 }}>{t('onboarding_demo_subtitle', locale)}</div>
          </div>

          {/* Demo item card */}
          <div style={{ margin: '20px 16px 0', background: C.card, borderRadius: 16, overflow: 'hidden', border: `1px solid ${C.borderLight}`, cursor: 'pointer' }}
            onClick={() => {
              setViewingItem(onboardingDemoItem);
              setFromDrafts(true);
              setScreen('item-detail');
            }}
          >
            {onboardingDemoItem.imageUrl && (
              <img src={onboardingDemoItem.imageUrl} alt="" style={{ width: '100%', height: 160, objectFit: 'cover', display: 'block' }} />
            )}
            <div style={{ padding: '14px 16px' }}>
              <div style={{ fontSize: 16, fontWeight: 600, color: C.text, marginBottom: 4 }}>{onboardingDemoItem.title}</div>
              {onboardingDemoItem.price != null && (
                <div style={{ fontSize: 14, color: C.accent, fontWeight: 600 }}>
                  {onboardingDemoItem.price} {onboardingDemoItem.currency ?? 'RUB'}
                </div>
              )}
            </div>
          </div>

          <div style={{ padding: '16px 16px 40px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              onClick={() => {
                setViewingItem(onboardingDemoItem);
                setFromDrafts(true);
                setScreen('item-detail');
              }}
              style={{ padding: '14px 0', borderRadius: 14, border: 'none', background: C.accent, color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: font }}
            >
              {t('onboarding_demo_edit_btn', locale)}
            </button>
          </div>
        </div>
      )}

      {/* ── ONBOARDING COMPLETE SCREEN ── */}
      {screen === 'onboarding-complete' && (
        <div style={{ position: 'fixed', inset: 0, background: C.bg, zIndex: 100, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '32px 24px' }}>
          <div style={{ fontSize: 56, marginBottom: 20 }}>🎉</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.text, textAlign: 'center', marginBottom: 10 }}>{t('onboarding_complete_title', locale)}</div>
          <div style={{ fontSize: 15, color: C.textSec, textAlign: 'center', lineHeight: 1.5, marginBottom: 32 }}>{t('onboarding_complete_subtitle', locale)}</div>
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 12 }}>
            {wishlists.length > 0 && (
              <button
                onClick={() => {
                  const wl = wishlists[0];
                  if (wl) {
                    setCurrentWl(wl);
                    setScreen('share');
                  }
                }}
                style={{ padding: '16px 0', borderRadius: 14, border: 'none', background: C.accent, color: '#fff', fontSize: 16, fontWeight: 700, cursor: 'pointer', fontFamily: font, width: '100%' }}
              >
                {t('onboarding_complete_share_btn', locale)}
              </button>
            )}
            <button
              onClick={() => { setOnboardingState(null); setScreen('my-wishlists'); }}
              style={{ padding: '14px 0', borderRadius: 14, border: `1px solid ${C.borderLight}`, background: 'none', color: C.textSec, fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: font, width: '100%' }}
            >
              {t('onboarding_complete_done_btn', locale)}
            </button>
          </div>
        </div>
      )}

      {/* ── TOASTS ── */}
      <div style={{ position: 'fixed', bottom: 24, left: 16, right: 16, zIndex: 200, display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none' }}>
        {toasts.map((t) => (
          <div key={t.id} style={{
            background: C.card, borderRadius: 14, padding: '14px 18px',
            fontSize: 14, fontWeight: 600, textAlign: 'center',
            border: `1px solid ${C.borderLight}`,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            animation: 'toastIn 0.3s ease',
            color: t.kind === 'success' ? C.green : t.kind === 'info' ? C.textSec : C.red,
          }}>
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────
// SHARE SCREEN (extracted to keep main component tidy)
// ─────────────────────────────────────────────────

function ShareScreen({ wishlist, itemCount, tgUser, ownerName, ownerAvatarUrl, onCopied, buildTgDeepLink, isPro, locale, tgFetch }: {
  wishlist: Wishlist;
  itemCount: number;
  tgUser: TgUser | null;
  ownerName: string;
  ownerAvatarUrl?: string | null;
  onCopied: () => void;
  buildTgDeepLink: (payload?: string) => string | null;
  isPro?: boolean;
  locale: Locale;
  tgFetch: (path: string, opts?: RequestInit) => Promise<Response>;
}) {
  const [copied, setCopied] = useState(false);
  // shareToken is fetched on mount via POST /tg/wishlists/:id/share-token.
  // This records "intent to share" (usersWhoInitiatedShare metric) and produces
  // a token-based link that is tracked when guests open it (sharedLinkOpens metric).
  // Falls back to slug-based link if the API call fails so sharing never breaks.
  const [shareToken, setShareToken] = useState<string | null>(wishlist.shareToken ?? null);
  const [tokenLoading, setTokenLoading] = useState(!wishlist.shareToken);

  useEffect(() => {
    // If we already have a token (from wishlist object), skip the API call
    if (wishlist.shareToken) { setShareToken(wishlist.shareToken); setTokenLoading(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const r = await tgFetch(`/tg/wishlists/${wishlist.id}/share-token`, { method: 'POST' });
        if (!cancelled && r.ok) {
          const data = await r.json() as { shareToken: string };
          setShareToken(data.shareToken);
        }
      } catch { /* ignore — fall back to slug */ }
      finally { if (!cancelled) setTokenLoading(false); }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wishlist.id]);

  // Use token-based link when available; fall back to slug for resilience
  const shareLinkPayload = shareToken ?? wishlist.slug;
  const shareLink = buildTgDeepLink(shareLinkPayload);
  const linkError = !shareLink; // only fails if botUsername env var is missing

  const fmtDeadline = (d: string | null) => {
    if (!d) return null;
    return new Date(d).toLocaleDateString(locale === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'long' });
  };

  const copy = async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
    } catch {
      // Fallback for older browsers / non-HTTPS contexts
      const ta = document.createElement('textarea');
      ta.value = shareLink;
      ta.style.cssText = 'position:fixed;left:-9999px;opacity:0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      document.body.removeChild(ta);
    }
    setCopied(true);
    onCopied();
    setTimeout(() => setCopied(false), 2000);
  };

  const shareToTelegram = () => {
    if (!shareLink) return;
    // Format:
    //   {name} делится своим вишлистом:
    //   [empty line]
    //   🎁 {title}
    //   Посмотри, что можно подарить 👇
    const intro = ownerName ? `${t('share_intro', locale, { name: ownerName })}\n\n` : '';
    const shareText = `${intro}🎁 ${wishlist.title}\n${t('share_cta', locale)}`;
    const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(shareLink)}&text=${encodeURIComponent(shareText)}`;
    try {
      window.Telegram?.WebApp.openTelegramLink(tgShareUrl);
    } catch {
      // Fallback if openTelegramLink is unavailable
      window.open(tgShareUrl, '_blank');
    }
  };

  const font = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif";
  const C_local = { accent: '#7C6AFF', text: '#F4F4F6', textSec: '#9CA3AF', textMuted: '#6B7280', bg: '#1B1B1F', surface: '#26262C', border: 'rgba(255,255,255,0.06)', borderLight: 'rgba(255,255,255,0.1)', green: '#34D399', greenSoft: 'rgba(52,211,153,0.12)', blue: '#3B82F6', red: '#EF4444', redSoft: 'rgba(239,68,68,0.12)' };

  return (
    <div style={{ padding: '16px 20px 120px' }}>
      <h1 style={{ fontSize: 20, fontWeight: 700, fontFamily: font, color: C_local.text, margin: '8px 0 20px' }}>{t('share_title', locale)}</h1>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, alignItems: 'center' }}>
        <div style={{
          background: `linear-gradient(135deg, ${C_local.accent}25, ${C_local.accent}08)`,
          borderRadius: 20, padding: 28, textAlign: 'center', width: '100%',
          border: `1px solid ${C_local.accent}18`,
        }}>
          <div style={{ margin: '0 auto 14px', width: 'fit-content' }}>
            <UserAvatar avatarUrl={ownerAvatarUrl} name={ownerName} size={64} accent={C_local.accent} />
          </div>
          <div style={{ fontSize: 20, fontWeight: 800, fontFamily: font, color: C_local.text }}>{ownerName}</div>
          <div style={{ fontSize: 14, color: C_local.textSec, marginTop: 4 }}>{wishlist.title}</div>
          <div style={{ fontSize: 13, color: C_local.textMuted, marginTop: 4 }}>
            {itemCount} {pluralize(itemCount, t('wishes_one', locale), t('wishes_few', locale), t('wishes_many', locale), locale)}{wishlist.deadline ? ` • ${fmtDeadline(wishlist.deadline)}` : ''}
          </div>
        </div>

        {linkError ? (
          <div style={{ borderRadius: 12, padding: '12px 16px', fontSize: 13, background: C_local.redSoft, color: C_local.red, width: '100%', lineHeight: 1.5, boxSizing: 'border-box', textAlign: 'center' }}>
            {t('share_link_error', locale)}
          </div>
        ) : (
          <>
            <div style={{
              background: C_local.bg, borderRadius: 12, padding: '12px 16px',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              width: '100%', border: `1px solid ${C_local.border}`, boxSizing: 'border-box',
            }}>
              <span style={{ fontSize: 13, color: C_local.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {shareLink}
              </span>
              <span onClick={copy} style={{ fontSize: 12, color: copied ? C_local.green : C_local.accent, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap', marginLeft: 10 }}>
                {copied ? '✅' : t('copy', locale)}
              </span>
            </div>

            <button onClick={shareToTelegram} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 24px', borderRadius: 14, border: 'none', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: font, transition: 'all 0.15s', width: '100%', background: C_local.blue, color: '#fff' }}>
              {t('share_tg_btn', locale)}
            </button>

            <button onClick={copy} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 24px', borderRadius: 14, border: 'none', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: font, transition: 'all 0.15s', width: '100%', background: C_local.accent, color: '#fff' }}>
              {t('share_copy_btn', locale)}
            </button>
          </>
        )}

        <div style={{ borderRadius: 12, padding: '12px 16px', fontSize: 12, background: C_local.greenSoft, color: C_local.green, width: '100%', lineHeight: 1.5, boxSizing: 'border-box' }}>
          {t('share_privacy', locale)}
        </div>
      </div>
    </div>
  );
}
