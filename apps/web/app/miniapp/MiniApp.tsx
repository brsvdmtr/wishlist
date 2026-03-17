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
};

type PlanInfo = {
  code: 'FREE' | 'PRO';
  wishlists: number;
  items: number;
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

type UpsellContext =
  | 'comments' | 'url_import' | 'hints'
  | 'wishlist_limit' | 'item_limit' | 'participant_limit' | 'subscription_limit'
  | 'sort_recommended';

type UpsellSheetState = { context: UpsellContext } | null;

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
  };
  unreadCount: number;
  unreadEntityIds: string[];
};

type ReservationItem = Item & {
  ownerName: string;
  ownerId: string;
  unreadComments: number;
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

type Screen = 'loading' | 'error' | 'maintenance' | 'my-wishlists' | 'wishlist-detail' | 'item-detail' | 'share' | 'guest-view' | 'guest-item-detail' | 'archive' | 'drafts' | 'settings' | 'my-reservations' | 'profile';
type Toast = { id: string; message: string; kind: 'success' | 'error' };

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
    emoji: '👥',
    title: t('upsell_wishlist_title', locale),
    subtitle: t('sub_pro_upsell', locale, { max: '7' }),
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

    const setTranslate = (y: number) => {
      sheet.style.transform = y === 0 ? '' : `translateY(${y}px)`;
    };

    const onStart = (e: TouchEvent) => {
      if (!e.touches[0]) return;
      prevY = e.touches[0].clientY;
      dismissOffset = 0;
      // Freeze any in-progress spring-back transition
      sheet.style.transition = 'none';
    };

    const onMove = (e: TouchEvent) => {
      if (prevY === null || !e.touches[0]) return;
      e.preventDefault(); // always prevent — we own all scroll behaviour

      const currentY = e.touches[0].clientY;
      const dy = currentY - prevY; // positive = finger moved down
      prevY = currentY;

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
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100 }}
      />
      <div
        ref={sheetRef}
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
// PRO UPSELL SHEET (context-aware)
// ═══════════════════════════════════════════════════════

function ProUpsellSheet({ state, onClose, onUpgrade, checkoutLoading, locale }: {
  state: UpsellSheetState;
  onClose: () => void;
  onUpgrade: () => void;
  checkoutLoading: boolean;
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
            disabled={checkoutLoading}
          >
            {checkoutLoading ? t('upsell_checkout_loading', locale) : t('upsell_cta', locale)}
          </button>
          <button
            style={{ ...btnGhost, width: '100%', marginTop: 8, fontSize: 14 }}
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
  const [planLimits, setPlanLimits] = useState({ wishlists: 2, items: 30 });
  const [planInfo, setPlanInfo] = useState<PlanInfo>({
    code: 'FREE', wishlists: 2, items: 30, participants: 5, features: [],
  });
  const [subscription, setSubscription] = useState<SubscriptionInfo>(null);
  const [upsellSheet, setUpsellSheet] = useState<UpsellSheetState>(null);
  const [checkoutLoading, setCheckoutLoading] = useState(false);
  const [showCancelSub, setShowCancelSub] = useState(false);
  const [cancelSubLoading, setCancelSubLoading] = useState(false);
  const [godMode, setGodMode] = useState(false);
  const [canGodMode, setCanGodMode] = useState(false);
  const [godModeLoading, setGodModeLoading] = useState(false);
  const [currentWl, setCurrentWl] = useState<Wishlist | null>(null);
  const [items, setItems] = useState<Item[]>([]);

  // Profile state
  const [profileData, setProfileData] = useState<{
    displayName: string | null;
    username: string | null;
    bio: string | null;
    avatarUrl: string | null;
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

  // My Reservations state
  const [reservations, setReservations] = useState<ReservationItem[]>([]);
  const [reservationsCount, setReservationsCount] = useState(0);
  const [reservationsLoading, setReservationsLoading] = useState(false);
  const [fromReservations, setFromReservations] = useState(false);

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
  const [guestWl, setGuestWl] = useState<{ id: string; slug: string; title: string; description: string | null; deadline: string | null; ownerName: string | null } | null>(null);
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
  const [importUrl, setImportUrl] = useState('');
  const [importLoading, setImportLoading] = useState(false);
  const [fromDrafts, setFromDrafts] = useState(false);
  // ── Drafts multi-select ───────────────────────────────────────────────────
  const [draftsSelectMode, setDraftsSelectMode] = useState(false);
  const [draftsSelected, setDraftsSelected] = useState<string[]>([]);
  const [showBulkMovePicker, setShowBulkMovePicker] = useState(false);
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [draftsBulkLoading, setDraftsBulkLoading] = useState(false);

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
  const showUpsell = useCallback((context: UpsellContext, opts?: { auto?: boolean }) => {
    const now = Date.now();
    if (opts?.auto) {
      if (upsellAutoShownThisSession.current) return;
      if (now - (upsellLastShownRef.current[context] ?? 0) < 30_000) return;
      upsellAutoShownThisSession.current = true;
    }
    upsellLastShownRef.current[context] = now;
    setUpsellSheet({ context });
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
    };
    setWishlists(json.wishlists);
    setPlanInfo(json.plan);
    setSubscription(json.subscription);
    if (json.godMode !== undefined) setGodMode(json.godMode);
    if (json.canGodMode !== undefined) setCanGodMode(json.canGodMode);
    setPlanLimits({ wishlists: json.plan.wishlists, items: json.plan.items });
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
    try {
      const res = await tgFetch('/tg/reservations');
      if (!res.ok) return;
      const json = await res.json() as { reservations: ReservationItem[] };
      setReservations(json.reservations);
      setReservationsCount(json.reservations.length);
    } catch {
      // silent
    } finally {
      setReservationsLoading(false);
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
      wishlist: { id: string; slug: string; title: string; description: string | null; deadline: string | null; ownerName?: string | null };
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
    setGuestWl({ ...json.wishlist, ownerName: json.wishlist.ownerName ?? null });
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

  // --- Navigation with Telegram BackButton
  const navBack = useCallback(() => {
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
      if (homeReturnTab !== null) {
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
    } else if (screen === 'share') {
      setScreen('wishlist-detail');
    } else if (screen === 'archive') {
      if (archiveMode === 'global') {
        setScreen('profile');
      } else {
        setScreen('wishlist-detail');
      }
    }
  }, [screen, archiveMode, settingsOriginScreen, loadWishlists, loadAllItems, loadReservations, fromDrafts, fromReservations, homeReturnTab, itemReorderMode, reorderMode]);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;
    tg.BackButton.onClick(navBack);
    return () => tg.BackButton.offClick(navBack);
  }, [navBack]);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;
    if (screen === 'my-wishlists' || screen === 'loading' || screen === 'error' || screen === 'maintenance') {
      tg.BackButton.hide();
    } else {
      tg.BackButton.show();
    }
  }, [screen]);

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
      if (lang !== undefined) setLocale(detectLocale(lang));

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

      if (startParam && startParam.startsWith('draft_')) {
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
          .then(() => {
            setScreen('my-wishlists');
            void loadReservations();
          })
          .catch(handleErr);
      }
      // Always pre-load profile data so ownerName is available on the
      // Share screen without requiring the user to visit Profile first.
      loadProfile().catch(() => { /* non-critical — share screen has fallback */ });
    };
    tryInit();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      pushToast(t('wishlist_created', locale), 'success');
      // Navigate into new wishlist
      setCurrentWl(json.wishlist);
      setItems([]);
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
            showUpsell('item_limit', { auto: true });
          } else {
            pushToast(t('toast_max_items', locale, { n: planLimits.items }), 'error');
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
    }}>
      <style>{`
        @keyframes fadeIn { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:translateY(0) } }
        @keyframes slideUp { from { opacity:0; transform:translateY(100%) } to { opacity:1; transform:translateY(0) } }
        @keyframes toastIn { from { opacity:0; transform:translateY(20px) scale(0.95) } to { opacity:1; transform:translateY(0) scale(1) } }
        @keyframes pulse { 0%,100% { opacity:1 } 50% { opacity:0.5 } }
        * { box-sizing:border-box; -webkit-tap-highlight-color:transparent }
        input, textarea, select { -webkit-appearance:none }
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
        <div style={{ padding: '16px 20px 120px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              {/* Avatar → Profile */}
              <button
                onClick={() => { loadProfile(); setScreen('profile'); }}
                style={{
                  width: 36, height: 36, borderRadius: '50%', border: 'none', cursor: 'pointer',
                  background: `linear-gradient(135deg, ${C.accent}, ${C.accent}80)`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 16, fontWeight: 700, color: '#fff', flexShrink: 0, padding: 0,
                }}
                aria-label={t('profile_title', locale)}
              >
                {(tgUser?.first_name ?? '?')[0]!.toUpperCase()}
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
                        else if (seg.tab === 'reservations' && reservations.length === 0) void loadReservations();
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
                      <div style={{ fontSize: 12, color: C.textMuted }}>
                        {sub.wishlist.ownerName} · {sub.wishlist.itemCount} {t('stats_wishes', locale)}
                        {sub.wishlist.deadline && ` · 📅 ${fmtDeadline(sub.wishlist.deadline)}`}
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
              {reservationsLoading && reservations.length === 0 && (
                <div style={{ textAlign: 'center', padding: '48px 24px' }}>
                  <div style={{ fontSize: 32, marginBottom: 12, animation: 'fadeIn 0.3s ease' }}>⏳</div>
                  <div style={{ fontSize: 14, color: C.textMuted }}>{t('reservations_loading', locale)}</div>
                </div>
              )}
              {!reservationsLoading && reservations.length === 0 && (
                <div style={{ textAlign: 'center', padding: '48px 24px' }}>
                  <div style={{ fontSize: 48, marginBottom: 16 }}>🎁</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t('reservations_empty_title', locale)}</div>
                  <div style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.5 }}>{t('reservations_empty_hint', locale)}</div>
                </div>
              )}
              {reservations.length > 0 && (() => {
                const groups: Record<string, { ownerName: string; items: ReservationItem[] }> = {};
                for (const r of reservations) {
                  const g = groups[r.ownerId] ?? (groups[r.ownerId] = { ownerName: r.ownerName, items: [] });
                  g.items.push(r);
                }
                let globalIdx = 0;
                return Object.entries(groups).map(([ownerId, group]) => (
                  <div key={ownerId} style={{ marginBottom: 8 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                      <div style={{
                        width: 32, height: 32, borderRadius: 16,
                        background: `linear-gradient(135deg, ${C.accent}, ${C.green})`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 14, fontWeight: 700, color: '#fff', flexShrink: 0,
                      }}>
                        {(group.ownerName || '?').charAt(0).toUpperCase()}
                      </div>
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

          {reservationsLoading && reservations.length === 0 && (
            <div style={{ textAlign: 'center', padding: '48px 24px' }}>
              <div style={{ fontSize: 32, marginBottom: 12, animation: 'fadeIn 0.3s ease' }}>⏳</div>
              <div style={{ fontSize: 14, color: C.textMuted }}>{t('reservations_loading', locale)}</div>
            </div>
          )}

          {!reservationsLoading && reservations.length === 0 && (
            <div style={{ textAlign: 'center', padding: '48px 24px' }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>🎁</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t('reservations_empty_title', locale)}</div>
              <div style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.5 }}>
                {t('reservations_empty_hint', locale)}
              </div>
            </div>
          )}

          {reservations.length > 0 && (() => {
            const groups: Record<string, { ownerName: string; items: ReservationItem[] }> = {};
            for (const r of reservations) {
              const g = groups[r.ownerId] ?? (groups[r.ownerId] = { ownerName: r.ownerName, items: [] });
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
                  <div style={{
                    width: 36, height: 36, borderRadius: 18,
                    background: `linear-gradient(135deg, ${C.accent}, ${C.green})`,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 16, fontWeight: 700, color: '#fff', flexShrink: 0,
                  }}>
                    {(group.ownerName || t('api_user_fallback', locale)).charAt(0).toUpperCase()}
                  </div>
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
                {t('items_limit_status', locale, { count: items.length, max: planLimits.items })}
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
          onCopied={() => pushToast(t('share_copied', locale), 'success')}
          locale={locale}
          buildTgDeepLink={buildTgDeepLink}
          isPro={planInfo.code === 'PRO'}
        />
      )}

      {/* ══════════════════════════════════════════════
          GUEST VIEW
          ══════════════════════════════════════════════ */}
      {screen === 'guest-view' && guestWl && (
        <div style={{ padding: '16px 20px 120px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, margin: '8px 0 20px' }}>
            <div style={{
              width: 48, height: 48, borderRadius: '50%',
              background: `linear-gradient(135deg, ${C.accent}, #a78bfa)`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 20, fontWeight: 700, color: '#fff', flexShrink: 0,
            }}>
              {guestWl.ownerName?.[0]?.toUpperCase() ?? '🎁'}
            </div>
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
            <div style={{ marginBottom: 16 }}>
              <h1 style={{ fontSize: 20, fontWeight: 700, fontFamily: font, color: C.text, margin: 0 }}>
                📦 {t('archive_title', locale)}
              </h1>
              {archiveMode === 'wishlist' && currentWl && (
                <p style={{ fontSize: 12, color: C.textMuted, margin: '2px 0 0' }}>{currentWl.title}</p>
              )}
              <p style={{ fontSize: 11, color: C.orange, margin: '6px 0 0' }}>{t('archive_retention', locale)}</p>
            </div>

            {displayItems.length === 0 && !loading && (
              <div style={{ textAlign: 'center', padding: '48px 24px' }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>📦</div>
                <div style={{ fontSize: 15, color: C.textMuted, lineHeight: 1.5 }}>{t('archive_empty', locale)}</div>
                <div style={{ fontSize: 13, color: C.textMuted, marginTop: 8 }}>{t('archive_empty_hint', locale)}</div>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {displayItems.map((item, i) => (
                <div key={item.id} style={{ animation: `fadeIn 0.3s ease ${i * 0.06}s both` }}>
                  <div style={{
                    background: C.card, borderRadius: 14, padding: 16,
                    display: 'flex', gap: 14, alignItems: 'flex-start',
                    border: `1px solid ${C.border}`, opacity: 0.7,
                  }}>
                    <ItemThumb item={item} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 15, fontWeight: 600, fontFamily: font, color: C.textMuted, lineHeight: 1.3, textDecoration: 'line-through' }}>
                        {item.title}
                      </div>
                      {archiveMode === 'global' && (item as GlobalArchiveItem).wishlistTitle && (
                        <div style={{ fontSize: 11, color: C.textMuted, marginTop: 3 }}>
                          📋 {(item as GlobalArchiveItem).wishlistTitle}
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
                      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                        <button onClick={() => void handleRestoreItem(item)} style={{ ...btnGhost, fontSize: 12, padding: '6px 10px', color: C.accent }}>{t('archive_restore', locale)}</button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
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
              {/* Avatar + Name + Badge section */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 24 }}>
                <div style={{
                  width: 80, height: 80, borderRadius: '50%',
                  background: `linear-gradient(135deg, ${C.accent}, ${C.accent}80)`,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 32, fontWeight: 700, color: '#fff', marginBottom: 12,
                  position: 'relative',
                  ...(profileData.avatarUrl ? { backgroundImage: `url(${profileData.avatarUrl})`, backgroundSize: 'cover' } : {}),
                }}>
                  {!profileData.avatarUrl && (profileData.displayName || tgUser?.first_name || '?')[0]!.toUpperCase()}
                </div>

                <div style={{ fontSize: 20, fontWeight: 700, color: C.text, fontFamily: font }}>
                  {profileData.displayName || tgUser?.first_name || t('profile_display_name', locale)}
                </div>

                {profileData.username && (
                  <div style={{ fontSize: 14, color: C.textMuted, marginTop: 2 }}>@{profileData.username}</div>
                )}

                <span style={{
                  marginTop: 8, fontSize: 11, fontWeight: 800, letterSpacing: 0.6, padding: '4px 12px',
                  borderRadius: 8,
                  background: planInfo.code === 'PRO' ? `linear-gradient(135deg, ${C.accent}25, ${C.accent}15)` : C.surface,
                  border: `1px solid ${planInfo.code === 'PRO' ? C.accent + '40' : C.borderLight}`,
                  color: planInfo.code === 'PRO' ? C.accent : C.textSec,
                }}>
                  {planInfo.code}
                </span>

                {profileData.bio && (
                  <div style={{ fontSize: 14, color: C.textSec, marginTop: 10, textAlign: 'center', maxWidth: 280 }}>
                    {profileData.bio}
                  </div>
                )}

                <button onClick={() => {
                  setEditProfileName(profileData.displayName || '');
                  setEditProfileUsername(profileData.username || '');
                  setEditProfileBio(profileData.bio?.replace(/\n+$/, '') || '');
                  setEditProfileBirthday(profileData.birthday ? profileData.birthday.slice(0, 10) : '');
                  setEditingProfile(true);
                }} style={{ ...btnGhost, marginTop: 12, fontSize: 13 }}>
                  {t('edit_btn', locale)}
                </button>
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
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0' }}>
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
            <div style={{ background: C.card, borderRadius: 16, padding: '4px 16px' }}>{children}</div>
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
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderBottom: `1px solid ${C.border}`, cursor: 'pointer' }}
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
                <SettingsActionRow label={t('settings_contact_support', locale)} onClick={() => {
                  try { window.Telegram?.WebApp?.openTelegramLink?.(`https://t.me/${botUsername}`); } catch { /* ok */ }
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
                  <button style={btnPrimary} onClick={() => { setShowMovePicker(false); setMovingItem(null); setScreen('my-wishlists'); setShowCreateWl(true); }}>
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
      <BottomSheet isOpen={showItemForm} onClose={() => { setShowItemForm(false); resetItemForm(); }} title={editingItem ? t('item_form_edit', locale) : t('item_form_new', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('item_name', locale)}</label>
            <input style={inputStyle} placeholder={t('item_name_placeholder', locale)} value={itemTitle} onChange={(e) => setItemTitle(e.target.value)} autoFocus />
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

      {/* ── TOASTS ── */}
      <div style={{ position: 'fixed', bottom: 24, left: 16, right: 16, zIndex: 200, display: 'flex', flexDirection: 'column', gap: 8, pointerEvents: 'none' }}>
        {toasts.map((t) => (
          <div key={t.id} style={{
            background: C.card, borderRadius: 14, padding: '14px 18px',
            fontSize: 14, fontWeight: 600, textAlign: 'center',
            border: `1px solid ${C.borderLight}`,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            animation: 'toastIn 0.3s ease',
            color: t.kind === 'success' ? C.green : C.red,
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

function ShareScreen({ wishlist, itemCount, tgUser, ownerName, onCopied, buildTgDeepLink, isPro, locale }: {
  wishlist: Wishlist;
  itemCount: number;
  tgUser: TgUser | null;
  ownerName: string;
  onCopied: () => void;
  buildTgDeepLink: (payload?: string) => string | null;
  isPro?: boolean;
  locale: Locale;
}) {
  const [copied, setCopied] = useState(false);

  // Build link directly from slug — no API call needed.
  // Each wishlist always has a slug; the guest flow already supports slug-based lookup
  // via GET /public/wishlists/:slug, so no share-token generation is required.
  const shareLink = buildTgDeepLink(wishlist.slug);
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
    // Prepend the owner's display name so recipients see who is sharing
    const namePrefix = ownerName ? `${ownerName}\n` : '';
    const shareText = `${namePrefix}${t('share_text', locale, { title: wishlist.title })}`;
    const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(shareLink)}&text=${encodeURIComponent(shareText)}`;
    try {
      window.Telegram?.WebApp.openTelegramLink(tgShareUrl);
    } catch {
      // Fallback if openTelegramLink is unavailable
      window.open(tgShareUrl, '_blank');
    }
  };

  const initials = ownerName?.[0]?.toUpperCase() ?? '?';
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
          <div style={{
            width: 64, height: 64, borderRadius: '50%',
            background: `linear-gradient(135deg, ${C_local.accent}, #a78bfa)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 28, fontWeight: 700, color: '#fff', margin: '0 auto 14px',
          }}>
            {initials}
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
