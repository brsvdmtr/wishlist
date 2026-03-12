'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
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

const getPriceFilters = (locale: Locale) => [
  { label: t('filter_all', locale), max: null },
  { label: t('filter_under_3k', locale), max: 3000 },
  { label: t('filter_under_10k', locale), max: 10000 },
  { label: t('filter_under_25k', locale), max: 25000 },
];

const getPriorities = (locale: Locale) => [
  { value: 1, emoji: '👍', label: t('priority_low', locale),    sub: t('priority_low_sub', locale) },
  { value: 2, emoji: '❤️', label: t('priority_medium', locale), sub: t('priority_medium_sub', locale) },
  { value: 3, emoji: '🔥', label: t('priority_high', locale),   sub: t('priority_high_sub', locale) },
];

const prioEmoji = (p: number) => ({ 1: '👍', 2: '❤️', 3: '🔥' } as Record<number, string>)[p] ?? '👍';
const fmtPrice = (p: number | null, locale: Locale = 'ru') => p ? `${p.toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US')} ₽` : null;

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

type Wishlist = {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  deadline: string | null;
  itemCount: number;
  reservedCount: number;
  readOnly?: boolean;
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
  | 'wishlist_limit' | 'item_limit' | 'participant_limit';

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
  status: 'available' | 'reserved' | 'purchased' | 'completed' | 'deleted';
  sourceUrl?: string | null;
  sourceDomain?: string | null;
  importMethod?: string | null;
};

type GuestItem = Item & { reservedByDisplayName: string | null; reservedByActorHash: string | null };

type ReservationItem = Item & {
  ownerName: string;
  ownerId: string;
  unreadComments: number;
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

type Screen = 'loading' | 'error' | 'my-wishlists' | 'wishlist-detail' | 'item-detail' | 'share' | 'guest-view' | 'guest-item-detail' | 'archive' | 'drafts' | 'settings' | 'my-reservations';
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
});

// ═══════════════════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════════════════

function BottomSheet({ isOpen, onClose, title, children }: {
  isOpen: boolean; onClose: () => void; title?: string; children: React.ReactNode;
}) {
  if (!isOpen) return null;
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 100 }} />
      <div style={{
        position: 'fixed', bottom: 0, left: 0, right: 0,
        background: C.surface, borderRadius: '20px 20px 0 0',
        padding: 24, zIndex: 101, maxHeight: '85vh', overflowY: 'auto',
        animation: 'slideUp 0.3s ease',
      }}>
        <div style={{ width: 40, height: 4, background: C.textMuted, borderRadius: 100, margin: '0 auto 16px', opacity: 0.3 }} />
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

function WishCardOwner({ item, onTap, onDelete, onComplete, locale }: {
  item: Item;
  onTap: (item: Item) => void;
  onDelete: (item: Item) => void;
  onComplete?: (item: Item) => void;
  locale: Locale;
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
          <span style={{ fontSize: 16, flexShrink: 0 }}>{prioEmoji(item.priority)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          {item.price != null && <span style={{ fontSize: 14, fontWeight: 700, color: C.accent, fontFamily: font }}>{fmtPrice(item.price, locale)}</span>}
          {item.url && <span style={{ fontSize: 11, color: C.textMuted, background: C.surface, padding: '2px 8px', borderRadius: 6 }}>{t('link_label', locale)}</span>}
        </div>
        <div style={{ marginTop: 10 }}>
          {isReserved && <span style={{ display: 'inline-block', padding: '6px 12px', borderRadius: 10, background: C.accentSoft, color: C.accent, fontSize: 13, fontWeight: 600 }}>{t('status_someone_reserved', locale)}</span>}
          {isPurchased && <span style={{ display: 'inline-block', padding: '6px 12px', borderRadius: 10, background: C.greenSoft, color: C.green, fontSize: 13, fontWeight: 600 }}>{t('status_gifted', locale)}</span>}
        </div>
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
          <span style={{ fontSize: 16, flexShrink: 0 }}>{prioEmoji(item.priority)}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
          {item.price != null && <span style={{ fontSize: 14, fontWeight: 700, color: C.accent, fontFamily: font }}>{fmtPrice(item.price, locale)}</span>}
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
              {fmtPrice(item.price, locale)}
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
              background: 'none', border: `1px solid ${C.borderLight}`,
              borderRadius: 10, padding: '6px 14px', fontSize: 12,
              color: C.textMuted, cursor: 'pointer', fontFamily: font,
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
              onChange={(e) => setCommentText(e.target.value.slice(0, 300))}
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

          {/* Comparison table for limit gates */}
          {content.showTable && (
            <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
              <div style={{ flex: 1, background: C.bg, borderRadius: 14, padding: 14 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.textMuted, marginBottom: 12, fontFamily: font }}>Free</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {[
                    { label: t('table_wishlists', locale), val: '2' },
                    { label: t('table_wishes', locale), val: '30' },
                    { label: t('table_participants', locale), val: '5' },
                    { label: t('table_comments', locale), val: '—' },
                    { label: t('table_by_link', locale), val: '—' },
                    { label: t('table_hints', locale), val: '—' },
                  ].map((r) => (
                    <div key={r.label} style={{ fontSize: 12, color: r.val === '—' ? C.textMuted : C.textSec, lineHeight: 1.3 }}>
                      <div style={{ fontWeight: 600 }}>{r.val}</div>
                      <div style={{ fontSize: 10, color: C.textMuted }}>{r.label}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{
                flex: 1, background: C.card, borderRadius: 14, padding: 14,
                border: `1px solid ${C.accent}30`,
                boxShadow: `0 0 24px ${C.accent}08`,
              }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: C.accent, marginBottom: 12, fontFamily: font }}>PRO</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {[
                    { label: t('table_wishlists', locale), val: '10' },
                    { label: t('table_wishes', locale), val: '100' },
                    { label: t('table_participants', locale), val: '20' },
                    { label: t('table_comments', locale), val: '✓' },
                    { label: t('table_by_link', locale), val: '✓' },
                    { label: t('table_hints', locale), val: '✓' },
                  ].map((r) => (
                    <div key={r.label} style={{ fontSize: 12, color: r.val === '✓' ? C.green : C.text, lineHeight: 1.3 }}>
                      <div style={{ fontWeight: 600 }}>{r.val}</div>
                      <div style={{ fontSize: 10, color: C.textSec }}>{r.label}</div>
                    </div>
                  ))}
                </div>
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

  // Archive state
  const [archiveItems, setArchiveItems] = useState<Item[]>([]);

  // My Reservations state
  const [reservations, setReservations] = useState<ReservationItem[]>([]);
  const [reservationsCount, setReservationsCount] = useState(0);
  const [reservationsLoading, setReservationsLoading] = useState(false);
  const [fromReservations, setFromReservations] = useState(false);

  // Guest state
  const [guestWl, setGuestWl] = useState<{ id: string; slug: string; title: string; description: string | null; deadline: string | null } | null>(null);
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
  const [itemUrl, setItemUrl] = useState('');
  const [itemPrice, setItemPrice] = useState('');
  const [itemPriority, setItemPriority] = useState<1 | 2 | 3>(2);
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

  // Guest forms
  const [priceFilter, setPriceFilter] = useState(0);
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

  // Drafts (Неразобранное)
  const [draftsWishlistId, setDraftsWishlistId] = useState<string | null>(null);
  const [draftsCount, setDraftsCount] = useState(0);
  const [draftsItems, setDraftsItems] = useState<Item[]>([]);
  const [showMovePicker, setShowMovePicker] = useState(false);
  const [movingItem, setMovingItem] = useState<Item | null>(null);
  const [importUrl, setImportUrl] = useState('');
  const [importLoading, setImportLoading] = useState(false);
  const [fromDrafts, setFromDrafts] = useState(false);

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

  const tgFetch = useCallback(async (path: string, init?: RequestInit) => {
    const url = `${apiBase}${path}`;
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          'X-TG-INIT-DATA': initDataRef.current,
          ...(init?.headers as Record<string, string> | undefined),
        },
      });
      return res;
    } catch (err) {
      throw new Error(`Fetch ${url}: ${err instanceof Error ? err.message : String(err)}`);
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

  const handleMoveItem = useCallback(async (itemId: string, targetWishlistId: string) => {
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
      // Reload drafts + wishlists
      await loadDrafts();
      await loadWishlists();
    } catch {
      pushToast(t('toast_move_error_generic', locale), 'error');
    }
  }, [tgFetch, pushToast, wishlists, loadDrafts, loadWishlists]);

  const handleArchiveDraft = useCallback(async (item: Item) => {
    const res = await tgFetch(`/tg/items/${item.id}`, { method: 'DELETE' });
    if (!res.ok) { pushToast(t('toast_error_generic', locale), 'error'); return; }
    setDraftsItems(prev => prev.filter(i => i.id !== item.id));
    setDraftsCount(prev => Math.max(0, prev - 1));
    pushToast(t('drafts_archived_toast', locale), 'success');
  }, [tgFetch, pushToast]);

  // --- Guest API calls
  const loadGuestWishlist = useCallback(async (param: string) => {
    type GuestResponse = {
      wishlist: { id: string; slug: string; title: string; description: string | null; deadline: string | null };
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
    setGuestWl(json.wishlist);
    const mappedItems = json.items.map((i) => ({
      id: i.id,
      title: i.title,
      description: i.description ?? null,
      url: i.url || null,
      price: i.priceText ? Number(i.priceText) || null : null,
      imageUrl: i.imageUrl ?? null,
      priority: priorityMap[i.priority] ?? 2,
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
        pushToast(t('cancel_success', locale), 'success');
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
  }, [tgFetch, pushToast, trackEvent]);

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
    if (screen === 'item-detail') {
      setViewingItem(null);
      if (fromDrafts) {
        setFromDrafts(false);
        setScreen('drafts');
      } else {
        setScreen('wishlist-detail');
      }
    } else if (screen === 'guest-item-detail') {
      setViewingItem(null);
      if (fromReservations) {
        setFromReservations(false);
        setScreen('my-reservations');
      } else {
        setScreen('guest-view');
      }
    } else if (screen === 'my-reservations') {
      setScreen('my-wishlists');
    } else if (screen === 'drafts') {
      setScreen('my-wishlists');
    } else if (screen === 'wishlist-detail' || screen === 'guest-view') {
      setCurrentWl(null);
      setScreen('my-wishlists');
      if (screen === 'guest-view') {
        loadWishlists().catch(() => { /* silent — screen already set */ });
      }
    } else if (screen === 'settings') {
      setScreen('my-wishlists');
    } else if (screen === 'share' || screen === 'archive') {
      setScreen('wishlist-detail');
    }
  }, [screen, loadWishlists, fromDrafts, fromReservations]);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;
    tg.BackButton.onClick(navBack);
    return () => tg.BackButton.offClick(navBack);
  }, [navBack]);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (!tg) return;
    if (screen === 'my-wishlists' || screen === 'loading' || screen === 'error') {
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
        // eslint-disable-next-line no-console
        console.error('[WishBoard]', msg, { apiBase, initData: tg.initData?.substring(0, 50) });
        setErrorMsg(t('error_load_failed', locale));
        setScreen('error');
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
    };
    tryInit();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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


  // --- Deferred edit: open edit form AFTER navigating back to wishlist-detail
  // (BottomSheet with position:fixed inside another position:fixed+overflowY:auto
  //  glitches in Telegram WebView, so we navigate first, then open the form)
  useEffect(() => {
    if (pendingEditItem && screen === 'wishlist-detail') {
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
      setWishlists((prev) => [json.wishlist, ...prev]);
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
    setItemTitle(''); setItemDescription(''); setItemUrl(''); setItemPrice(''); setItemPriority(2); setItemImageUrl('');
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
    setItemDescription(item.description ?? '');
    setItemUrl(item.url ?? '');
    setItemPrice(item.price != null ? String(item.price) : '');
    setItemPriority(item.priority);
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
    if (!itemTitle.trim() || !currentWl) return;
    setLoading(true);
    setPhotoError(null);
    try {
      const body = {
        title: itemTitle.trim(),
        description: itemDescription.trim() || null,
        url: itemUrl.trim() || undefined,
        price: itemPrice ? Number(itemPrice) : null,
        priority: itemPriority,
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

        // Reload from API so list order reflects server-side sort (priority DESC)
        await loadItems(editingItem.wishlistId ?? currentWl.id);
        pushToast(t('item_saved', locale), 'success');
      } else {
        const res = await tgFetch(`/tg/wishlists/${currentWl.id}/items`, { method: 'POST', body: JSON.stringify(body) });
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
        setWishlists((prev) => prev.map((wl) => wl.id === currentWl.id ? { ...wl, itemCount: wl.itemCount + 1 } : wl));
        await loadItems(currentWl.id);
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
    if (!currentWl) return;
    setLoading(true);
    try {
      const res = await tgFetch(`/tg/items/${item.id}`, { method: 'DELETE' });
      if (!res.ok) { pushToast(t('toast_delete_error', locale), 'error'); return; }
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setWishlists((prev) => prev.map((wl) => wl.id === currentWl.id ? { ...wl, itemCount: Math.max(0, wl.itemCount - 1) } : wl));
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

  const handleRestoreItem = async (item: Item) => {
    setLoading(true);
    try {
      const res = await tgFetch(`/tg/items/${item.id}/restore`, { method: 'POST' });
      if (!res.ok) { pushToast(t('toast_restore_error', locale), 'error'); return; }
      const json = await res.json() as { item: Item };
      setArchiveItems((prev) => prev.filter((i) => i.id !== item.id));
      setItems((prev) => [...prev, json.item]);
      if (currentWl) {
        setWishlists((prev) => prev.map((wl) => wl.id === currentWl!.id ? { ...wl, itemCount: wl.itemCount + 1 } : wl));
      }
      pushToast(t('archive_restored', locale), 'success');
    } finally {
      setLoading(false);
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

  const totalReserved = Object.values(wishlists).reduce((n, wl) => n + wl.reservedCount, 0);
  const totalItems = wishlists.reduce((n, wl) => n + wl.itemCount, 0);

  return (
    <div style={{
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

      {/* ══════════════════════════════════════════════
          OWNER — MY WISHLISTS
          ══════════════════════════════════════════════ */}
      {screen === 'my-wishlists' && (
        <div style={{ padding: '16px 20px 120px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
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
            <button
              onClick={() => setScreen('settings')}
              style={{
                background: 'none', border: 'none', padding: 8, cursor: 'pointer',
                fontSize: 20, color: C.textMuted, lineHeight: 1,
              }}
              aria-label={t('settings_title', locale)}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {wishlists.length > 0 && (
              <div style={{
                background: `linear-gradient(135deg, ${C.accent}18, ${C.accent}06)`,
                borderRadius: 16, padding: '16px 20px', border: `1px solid ${C.accent}15`,
                animation: 'fadeIn 0.3s ease',
              }}>
                <div style={{ fontSize: 13, color: C.textSec, marginBottom: 8 }}>📊 {t('stats_total', locale)}</div>
                <div style={{ display: 'flex', gap: 24 }}>
                  {[
                    { n: wishlists.length, l: t('stats_wishlists', locale), c: C.text },
                    { n: totalItems, l: t('stats_wishes', locale), c: C.accent },
                    { n: totalReserved, l: t('stats_reserved', locale), c: C.green },
                  ].map((s, i) => (
                    <div key={i}>
                      <div style={{ fontSize: 24, fontWeight: 800, color: s.c, fontFamily: font }}>{s.n}</div>
                      <div style={{ fontSize: 11, color: C.textMuted }}>{s.l}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

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

            {/* Забронировано мной — always visible */}
            {reservationsCount > 0 ? (
              <div
                onClick={() => { void loadReservations(); setScreen('my-reservations'); }}
                style={{
                  background: `linear-gradient(135deg, ${C.green}20, ${C.green}08)`,
                  borderRadius: 16, padding: '16px 20px', cursor: 'pointer',
                  border: `1px solid ${C.green}25`,
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  animation: 'fadeIn 0.3s ease',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 24 }}>🎁</span>
                  <div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 15, fontWeight: 700, fontFamily: font, color: C.text }}>{t('reservations_title', locale)}</span>
                      <span style={{
                        minWidth: 20, height: 20, borderRadius: 10,
                        background: C.green, color: '#fff',
                        fontSize: 11, fontWeight: 700,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        padding: '0 6px',
                      }}>{reservationsCount}</span>
                    </div>
                    <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                      {reservations.length > 0
                        ? reservations.slice(0, 3).map(r => r.title).join(', ').slice(0, 50) + (reservations.length > 3 ? '…' : '')
                        : t('reservations_open_list', locale)}
                    </div>
                  </div>
                </div>
                <span style={{ fontSize: 20, color: C.green }}>›</span>
              </div>
            ) : (
              <div style={{
                background: C.surface, borderRadius: 16, padding: '16px 20px',
                border: `1px solid ${C.border}`,
                animation: 'fadeIn 0.3s ease',
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 24 }}>🎁</span>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, fontFamily: font, color: C.text }}>{t('reservations_title', locale)}</div>
                    <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{t('reservations_empty_hint', locale)}</div>
                  </div>
                </div>
              </div>
            )}

            {wishlists.map((wl, i) => (
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

            {wishlists.length === 0 && (
              <div style={{ textAlign: 'center', padding: '48px 24px' }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>🎁</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t('empty_state_title', locale)}</div>
                <div style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.5 }}>
                  {t('empty_state_subtitle', locale)}
                </div>
              </div>
            )}

            <div style={{ textAlign: 'center', padding: '4px 0', fontSize: 12, color: C.textMuted }}>
              {t('plan_status', locale, { plan: planInfo.code === 'PRO' ? 'Pro' : 'Free', count: wishlists.length, max: planLimits.wishlists })}
            </div>
            {planInfo.code === 'FREE' && (
              <button style={{ ...btnGhost, width: '100%', fontSize: 13, color: C.accent }} onClick={() => showUpsell('wishlist_limit')}>
                {t('connect_pro', locale)}
              </button>
            )}
            <button style={btnPrimary} onClick={() => setShowCreateWl(true)}>{t('create_wishlist_btn', locale)}</button>
          </div>

          <BottomSheet isOpen={showCreateWl} onClose={() => setShowCreateWl(false)} title={t('new_wishlist', locale)}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('wishlist_name', locale)}</label>
                <div style={{ position: 'relative' }}>
                  <input style={{ ...inputStyle, paddingRight: wlTitle ? 36 : 16 }} placeholder={t('wishlist_name_placeholder', locale)} value={wlTitle} onChange={(e) => setWlTitle(e.target.value)} autoFocus />
                  {wlTitle && (
                    <button
                      onClick={() => setWlTitle('')}
                      style={{
                        position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
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
                  <input style={{ ...inputStyle, colorScheme: 'dark', paddingRight: wlDeadline ? 36 : 16 }} type="date" value={wlDeadline} onChange={(e) => setWlDeadline(e.target.value)} />
                  {wlDeadline && (
                    <button
                      onClick={() => setWlDeadline('')}
                      style={{
                        position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
                        background: C.textMuted + '33', border: 'none', borderRadius: 10, width: 20, height: 20,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: C.textSec, fontSize: 11, cursor: 'pointer', padding: 0, lineHeight: 1,
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
          <div style={{ marginBottom: 20 }}>
            <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: font, color: C.text, margin: 0 }}>📥 {t('drafts_title', locale)}</h1>
            <p style={{ fontSize: 13, color: C.textMuted, margin: '4px 0 0' }}>
              {draftsItems.length > 0
                ? `${draftsItems.length} ${pluralize(draftsItems.length, t('cards_one', locale), t('cards_few', locale), t('cards_many', locale), locale)}`
                : t('drafts_send_link', locale)}
            </p>
          </div>

          {/* URL input — with PRO badge for FREE users */}
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

          {/* Draft items list */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {draftsItems.map((item, i) => (
              <div key={item.id} style={{
                background: C.card, borderRadius: 16, padding: 16,
                border: `1px solid ${C.border}`,
                animation: `fadeIn 0.3s ease ${i * 0.06}s both`,
              }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
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
                        💰 {Number(item.price).toLocaleString(locale === 'ru' ? 'ru-RU' : 'en-US')} ₽
                      </div>
                    )}
                  </div>
                </div>

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
              </div>
            ))}
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

          {/* Move to wishlist BottomSheet */}
          <BottomSheet isOpen={showMovePicker} onClose={() => { setShowMovePicker(false); setMovingItem(null); }} title={t('drafts_move_title', locale)}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {wishlists.length === 0 && (
                <div style={{ textAlign: 'center', padding: '24px 0' }}>
                  <div style={{ fontSize: 14, color: C.textMuted, marginBottom: 12 }}>{t('drafts_create_first', locale)}</div>
                  <button style={btnPrimary} onClick={() => { setShowMovePicker(false); setMovingItem(null); setScreen('my-wishlists'); setShowCreateWl(true); }}>
                    {t('create_wishlist_btn', locale)}
                  </button>
                </div>
              )}
              {wishlists.map((wl) => (
                <button
                  key={wl.id}
                  style={{
                    ...btnGhost,
                    width: '100%', textAlign: 'left', padding: '14px 16px',
                    borderRadius: 12, background: C.surface,
                    border: `1px solid ${C.border}`,
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}
                  onClick={() => { if (movingItem) void handleMoveItem(movingItem.id, wl.id); }}
                >
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 600, color: C.text }}>{wl.title}</div>
                    <div style={{ fontSize: 12, color: C.textMuted }}>{t('wishes_count', locale, { count: wl.itemCount })}</div>
                  </div>
                  <span style={{ color: C.textMuted }}>›</span>
                </button>
              ))}
            </div>
          </BottomSheet>
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
                        onUnreserve={() => void handleUnreserveFromReservations(item)}
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
        <div style={{ padding: '16px 20px 120px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <h1 style={{ fontSize: 20, fontWeight: 700, fontFamily: font, color: C.text, margin: 0 }}>{currentWl.title}</h1>
                <button
                  onClick={() => { setRenameWlTitle(currentWl.title); setShowRenameWl(true); }}
                  style={{ background: 'none', border: 'none', padding: 4, cursor: 'pointer', fontSize: 14, color: C.textMuted, lineHeight: 1, flexShrink: 0 }}
                  aria-label={t('rename_title', locale)}
                >✏️</button>
              </div>
              <p style={{ fontSize: 12, color: C.textMuted, margin: '2px 0 0' }}>
                {t('wishes_count', locale, { count: items.length })}
                {currentWl.deadline && ` • ${fmtDeadline(currentWl.deadline)}`}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button
                onClick={() => void loadArchive()}
                style={{ ...btnGhost, padding: '8px 12px', fontSize: 13 }}
              >
                📦 {t('archive_btn', locale)}
              </button>
              <button
                onClick={() => setScreen('share')}
                style={{ ...btnPrimary, width: 'auto', padding: '8px 16px', fontSize: 13 }}
              >
                {t('share_btn', locale)}
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

            {items.map((item, i) => (
              <div key={item.id} style={{ animation: `fadeIn 0.3s ease ${i * 0.06}s both` }}>
                <WishCardOwner item={item} onTap={(it) => { setViewingItem(it); setScreen('item-detail'); }} onDelete={setDeletingItem} onComplete={handleCompleteItem} locale={locale} />
              </div>
            ))}

            {!loading && items.length === 0 && (
              <div style={{ textAlign: 'center', padding: '48px 24px' }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>✨</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8 }}>{t('add_first_wish', locale)}</div>
                <div style={{ fontSize: 14, color: C.textMuted }}>{t('add_first_wish_hint', locale)}</div>
              </div>
            )}

            {!currentWl.readOnly && (
              <button style={btnSecondary} onClick={() => { resetItemForm(); setShowItemForm(true); }}>{t('add_wish_btn', locale)}</button>
            )}
          </div>

        </div>
      )}

      {/* ══════════════════════════════════════════════
          OWNER — ITEM DETAIL (view + actions)
          ══════════════════════════════════════════════ */}
      {screen === 'item-detail' && viewingItem && (
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
            {/* Title */}
            <h1 style={{
              fontSize: 26, fontWeight: 700, fontFamily: font, color: C.text,
              margin: '0 0 10px', lineHeight: 1.25,
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
              overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{viewingItem.title}</h1>

            {/* Price */}
            {viewingItem.price != null && (
              <div style={{ fontSize: 22, fontWeight: 700, color: C.accent, marginBottom: 10 }}>
                {fmtPrice(viewingItem.price, locale)}
              </div>
            )}

            {/* Priority pill */}
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '6px 12px', borderRadius: 100,
              background: C.surface, border: `1px solid ${C.borderLight}`,
              fontSize: 13, fontWeight: 500, color: C.textSec,
            }}>
              {viewingItem.priority === 3 ? '🔥' : viewingItem.priority === 2 ? '💜' : '✨'}{' '}
              {getPriorities(locale).find((p) => p.value === viewingItem!.priority)?.label}
            </div>

            {/* URL + source badge */}
            {viewingItem.url && (
              <div style={{ marginTop: 12, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
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
                      onClick={() => { setDescriptionText(viewingItem.description ?? ''); setEditingDescription(true); }}
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

            {/* Owner actions */}
            {viewingItem.status !== 'purchased' && (
              <div style={{ marginTop: 24, marginBottom: 32 }}>
                <button onClick={() => {
                  setPendingEditItem(viewingItem as Item);
                  setViewingItem(null);
                  setScreen('wishlist-detail');
                }} style={{ ...btnPrimary, width: '100%', borderRadius: 16, padding: '16px 24px', fontSize: 16 }}>
                  {t('edit_btn', locale)}
                </button>
                <div style={{ display: 'flex', gap: 12, marginTop: 10 }}>
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
                  <button onClick={() => {
                    const item = viewingItem as Item;
                    setViewingItem(null);
                    setScreen('wishlist-detail');
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
            )}
          </div>
        </div>
      )}

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
            {/* Title */}
            <h1 style={{
              fontSize: 26, fontWeight: 700, fontFamily: font, color: C.text,
              margin: '0 0 10px', lineHeight: 1.25,
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const,
              overflow: 'hidden', textOverflow: 'ellipsis',
            }}>{viewingItem.title}</h1>

            {/* Price */}
            {viewingItem.price != null && (
              <div style={{ fontSize: 22, fontWeight: 700, color: C.accent, marginBottom: 10 }}>
                {fmtPrice(viewingItem.price, locale)}
              </div>
            )}

            {/* Priority pill */}
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              padding: '6px 12px', borderRadius: 100,
              background: C.surface, border: `1px solid ${C.borderLight}`,
              fontSize: 13, fontWeight: 500, color: C.textSec,
            }}>
              {viewingItem.priority === 3 ? '🔥' : viewingItem.priority === 2 ? '💜' : '✨'}{' '}
              {getPriorities(locale).find((p) => p.value === viewingItem!.priority)?.label}
            </div>

            {/* URL */}
            {viewingItem.url && (
              <div style={{ marginTop: 12 }}>
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
                  <button onClick={() => void handleUnreserve(viewingItem as GuestItem)}
                    style={{
                      ...btnBase, width: '100%', background: 'transparent', color: C.textMuted,
                      border: `1px solid ${C.borderLight}`, borderRadius: 14,
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
              fontSize: 20, fontWeight: 700, color: '#fff',
            }}>
              🎁
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, fontFamily: font, color: C.text }}>{guestWl.title}</div>
              {guestWl.description && <div style={{ fontSize: 13, color: C.textMuted }}>{guestWl.description}</div>}
              {guestWl.deadline && (
                <div style={{ fontSize: 12, color: C.textMuted }}>📅 {fmtDeadline(guestWl.deadline)}</div>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            {getPriceFilters(locale).map((pf, i) => (
              <button key={i} onClick={() => setPriceFilter(i)} style={{
                padding: '6px 14px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                border: 'none', cursor: 'pointer', fontFamily: font, transition: 'all 0.2s',
                background: priceFilter === i ? C.accent : C.surface,
                color: priceFilter === i ? '#fff' : C.textSec,
              }}>{pf.label}</button>
            ))}
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {guestItems
              .filter((i) => !getPriceFilters(locale)[priceFilter]?.max || !i.price || i.price <= (getPriceFilters(locale)[priceFilter]?.max ?? Infinity))
              .map((item, i) => (
                <div key={item.id} style={{ animation: `fadeIn 0.3s ease ${i * 0.06}s both` }}>
                  <WishCardGuest item={item} onTap={(it) => { setViewingItem(it); setScreen('guest-item-detail'); }} onReserve={(w) => { setReservingItem(w); setGuestName(tgUser?.first_name ?? ''); }} onUnreserve={handleUnreserve} myActorHash={myActorHashRef.current} locale={locale} />
                </div>
              ))}
          </div>

        </div>
      )}

      {/* ══════════════════════════════════════════════
          ARCHIVE
          ══════════════════════════════════════════════ */}
      {screen === 'archive' && currentWl && (
        <div style={{ padding: '16px 20px 120px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 700, fontFamily: font, color: C.text, margin: 0 }}>📦 {t('archive_title', locale)}</h1>
              <p style={{ fontSize: 12, color: C.textMuted, margin: '2px 0 0' }}>{currentWl.title}</p>
              <p style={{ fontSize: 11, color: C.orange, margin: '6px 0 0' }}>{t('archive_retention', locale)}</p>
            </div>
            <button onClick={() => setScreen('wishlist-detail')} style={{ ...btnGhost, fontSize: 13, padding: '8px 14px' }}>← {t('back', locale)}</button>
          </div>

          {archiveItems.length === 0 && !loading && (
            <div style={{ textAlign: 'center', padding: '48px 24px' }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>📦</div>
              <div style={{ fontSize: 15, color: C.textMuted, lineHeight: 1.5 }}>{t('archive_empty', locale)}</div>
              <div style={{ fontSize: 13, color: C.textMuted, marginTop: 8 }}>{t('archive_empty_hint', locale)}</div>
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {archiveItems.map((item, i) => (
              <div key={item.id} style={{ animation: `fadeIn 0.3s ease ${i * 0.06}s both` }}>
                <div style={{
                  background: C.card, borderRadius: 14, padding: 16,
                  display: 'flex', gap: 14, alignItems: 'flex-start',
                  border: `1px solid ${C.border}`, opacity: 0.7,
                }}>
                  <ItemThumb item={item} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div style={{ fontSize: 15, fontWeight: 600, fontFamily: font, color: C.textMuted, lineHeight: 1.3, paddingRight: 8, textDecoration: 'line-through' }}>
                        {item.title}
                      </div>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                      {item.status === 'completed' && (
                        <span style={{ fontSize: 11, background: C.greenSoft, color: C.green, padding: '2px 8px', borderRadius: 6, fontWeight: 600 }}>{t('archive_received', locale)}</span>
                      )}
                      {item.status === 'deleted' && (
                        <span style={{ fontSize: 11, background: C.surface, color: C.textMuted, padding: '2px 8px', borderRadius: 6, fontWeight: 600 }}>{t('archive_deleted', locale)}</span>
                      )}
                      {item.price != null && <span style={{ fontSize: 13, color: C.textMuted }}>{fmtPrice(item.price, locale)}</span>}
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
      )}

      {/* ══════════════════════════════════════════════
          SETTINGS
          ══════════════════════════════════════════════ */}
      {screen === 'settings' && (
        <div style={{ padding: '16px 20px 120px' }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, fontFamily: font, color: C.text, margin: '0 0 20px' }}>{t('settings_title', locale)}</h1>

          {/* Current plan card */}
          <div style={{
            background: planInfo.code === 'PRO'
              ? `linear-gradient(145deg, ${C.card}, ${C.accent}08)`
              : C.card,
            borderRadius: 16, padding: 20,
            border: `1px solid ${planInfo.code === 'PRO' ? C.accent + '25' : C.border}`,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <span style={{ fontSize: 15, fontWeight: 600, color: C.textSec, fontFamily: font }}>{t('settings_plan', locale)}</span>
              <span style={{
                fontSize: 12, fontWeight: 800, letterSpacing: 0.5, padding: '4px 10px',
                borderRadius: 6,
                background: planInfo.code === 'PRO'
                  ? `linear-gradient(135deg, ${C.accent}22, ${C.accent}12)`
                  : C.surface,
                border: planInfo.code === 'PRO' ? `1px solid ${C.accent}30` : 'none',
                color: planInfo.code === 'PRO' ? C.accent : C.textSec,
              }}>
                {planInfo.code === 'PRO' ? 'PRO' : 'Free'}
              </span>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {[
                { label: t('settings_wishlists', locale), value: t('settings_up_to', locale, { n: planInfo.wishlists }), desc: planInfo.code === 'PRO' ? t('settings_desc_wishlists', locale) : null },
                { label: t('settings_wishes_each', locale), value: t('settings_up_to', locale, { n: planInfo.items }), desc: planInfo.code === 'PRO' ? t('settings_desc_wishes', locale) : null },
                { label: t('settings_participants', locale), value: t('settings_up_to', locale, { n: planInfo.participants }), desc: planInfo.code === 'PRO' ? t('settings_desc_participants', locale) : null },
              ].map((row) => (
                <div key={row.label}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontSize: 14, color: C.textSec }}>{row.label}</span>
                    <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{row.value}</span>
                  </div>
                  {row.desc && <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{row.desc}</div>}
                </div>
              ))}
              {planInfo.code === 'PRO' && (
                <>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 14, color: C.textSec }}>{t('settings_comments', locale)}</span>
                      <span style={{ fontSize: 13, color: C.green, fontWeight: 600 }}>✓</span>
                    </div>
                    <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{t('settings_desc_comments', locale)}</div>
                  </div>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 14, color: C.textSec }}>{t('settings_url_import', locale)}</span>
                      <span style={{ fontSize: 13, color: C.green, fontWeight: 600 }}>✓</span>
                    </div>
                    <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{t('settings_desc_url_import', locale)}</div>
                  </div>
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ fontSize: 14, color: C.textSec }}>{t('settings_hints', locale)}</span>
                      <span style={{ fontSize: 13, color: C.green, fontWeight: 600 }}>✓</span>
                    </div>
                    <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{t('settings_desc_hints', locale)}</div>
                  </div>
                </>
              )}
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

            {/* Subscription info — ACTIVE_CANCELLED (cancelAtPeriodEnd or status CANCELLED) */}
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

          {/* Action buttons */}
          <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {/* ACTIVE_RENEWING: offer to cancel renewal */}
            {subscription && !subscription.cancelAtPeriodEnd && subscription.status !== 'CANCELLED' && (
              <button
                style={{ ...btnSecondary, width: '100%', fontSize: 14 }}
                onClick={() => setShowCancelSub(true)}
              >
                {t('settings_cancel_renewal', locale)}
              </button>
            )}

            {/* ACTIVE_CANCELLED: offer to reactivate */}
            {subscription && (subscription.cancelAtPeriodEnd || subscription.status === 'CANCELLED') && (
              <button
                style={{
                  ...btnPrimary, width: '100%',
                  background: `linear-gradient(135deg, ${C.accent}, #6B5CE7)`,
                }}
                onClick={() => void handleReactivateSub()}
                disabled={cancelSubLoading}
              >
                {cancelSubLoading ? t('settings_resuming', locale) : t('settings_resume_sub', locale)}
              </button>
            )}

            {/* FREE: offer to subscribe */}
            {planInfo.code === 'FREE' && (
              <button
                style={{
                  ...btnPrimary, width: '100%',
                  background: `linear-gradient(135deg, ${C.accent}, #6B5CE7)`,
                }}
                onClick={() => showUpsell('wishlist_limit')}
              >
                {t('connect_pro', locale)}
              </button>
            )}
          </div>

          {/* God Mode toggle — dev only, whitelisted users */}
          {canGodMode && (
            <div style={{
              marginTop: 32, padding: 16, borderRadius: 12,
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
                        // Refresh plan data to reflect god mode changes
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
        </div>
      )}

      {/* ── GLOBAL OVERLAYS (not tied to any screen — BottomSheet is position:fixed) ── */}
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
              style={{ ...inputStyle, minHeight: 100, resize: 'vertical' }}
              maxLength={500}
              placeholder={t('description_placeholder', locale)}
              value={descriptionText}
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
                {reservingItem.price != null && <div style={{ fontSize: 14, color: C.accent, fontWeight: 700, marginTop: 2 }}>{fmtPrice(reservingItem.price, locale)}</div>}
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
              style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }}
              maxLength={500}
              placeholder={t('item_description_placeholder', locale)}
              value={itemDescription}
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
            <input style={inputStyle} placeholder="0 ₽" type="number" value={itemPrice} onChange={(e) => setItemPrice(e.target.value)} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>{t('item_priority', locale)}</label>
            <div style={{ display: 'flex', gap: 10 }}>
              {getPriorities(locale).map((p) => (
                <div key={p.value} onClick={() => setItemPriority(p.value as 1 | 2 | 3)} style={{
                  flex: 1, padding: '12px 8px', borderRadius: 12, textAlign: 'center', cursor: 'pointer', transition: 'all 0.2s',
                  background: itemPriority === p.value ? C.accentSoft : C.surface,
                  border: `1px solid ${itemPriority === p.value ? C.accentGlow : C.border}`,
                }}>
                  <div style={{ fontSize: 22, marginBottom: 4 }}>{p.emoji}</div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: itemPriority === p.value ? C.accent : C.text, marginBottom: 2 }}>{p.label}</div>
                  <div style={{ fontSize: 10, color: C.textMuted, lineHeight: 1.2 }}>{p.sub}</div>
                </div>
              ))}
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
        <div style={{ textAlign: 'center', padding: '0 0 8px' }}>
          <div style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 56, height: 56, borderRadius: 18,
            background: C.orangeSoft, fontSize: 28, marginBottom: 16,
          }}>
            ⚠️
          </div>
          <div style={{ fontSize: 18, fontWeight: 800, color: C.text, lineHeight: 1.3, fontFamily: font }}>
            {t('cancel_title', locale)}
          </div>
          <div style={{ fontSize: 14, color: C.textSec, marginTop: 8, lineHeight: 1.5, padding: '0 8px' }}>
            {t('cancel_notice', locale)}{' '}
            <strong>{subscription ? new Date(subscription.periodEnd).toLocaleDateString(locale === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'long' }) : ''}</strong>.
            {' '}{t('cancel_after', locale)}
          </div>
          <button
            style={{ ...btnPrimary, marginTop: 20, width: '100%', background: C.red, fontSize: 15, padding: '14px 24px' }}
            onClick={() => void handleCancelSub()}
            disabled={cancelSubLoading}
          >
            {cancelSubLoading ? t('cancel_cancelling', locale) : t('cancel_btn', locale)}
          </button>
          <button
            style={{ ...btnGhost, width: '100%', marginTop: 8, fontSize: 14 }}
            onClick={() => setShowCancelSub(false)}
          >
            {t('cancel_keep', locale)}
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

function ShareScreen({ wishlist, itemCount, tgUser, onCopied, buildTgDeepLink, isPro, locale }: {
  wishlist: Wishlist;
  itemCount: number;
  tgUser: TgUser | null;
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
    const shareText = t('share_text', locale, { title: wishlist.title });
    const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(shareLink)}&text=${encodeURIComponent(shareText)}`;
    try {
      window.Telegram?.WebApp.openTelegramLink(tgShareUrl);
    } catch {
      // Fallback if openTelegramLink is unavailable
      window.open(tgShareUrl, '_blank');
    }
  };

  const initials = tgUser?.first_name?.[0]?.toUpperCase() ?? '?';
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
          <div style={{ fontSize: 20, fontWeight: 800, fontFamily: font, color: C_local.text }}>{tgUser?.first_name ?? t('bot_menu_btn', locale)}</div>
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
