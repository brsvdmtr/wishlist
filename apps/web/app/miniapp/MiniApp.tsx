'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

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

const PRICE_FILTERS = [
  { label: 'Все', max: null },
  { label: 'До 3 000 ₽', max: 3000 },
  { label: 'До 10 000 ₽', max: 10000 },
  { label: 'До 25 000 ₽', max: 25000 },
];

const PRIORITIES = [
  { value: 1, emoji: '👍', label: 'Неплохо',  sub: 'Низкий приоритет' },
  { value: 2, emoji: '❤️', label: 'Хочу',     sub: 'Средний приоритет' },
  { value: 3, emoji: '🔥', label: 'Мечтаю',   sub: 'Высокий приоритет' },
];

const prioEmoji = (p: number) => ({ 1: '👍', 2: '❤️', 3: '🔥' } as Record<number, string>)[p] ?? '👍';
const fmtPrice = (p: number | null) => p ? `${p.toLocaleString('ru-RU')} ₽` : null;

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
};

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
};

type GuestItem = Item & { reservedByDisplayName: string | null; reservedByActorHash: string | null };

type CommentDTO = {
  id: string;
  type: 'USER' | 'SYSTEM';
  authorActorHash: string | null;
  authorDisplayName: string | null;
  text: string;
  reservationEpoch: number;
  createdAt: string;
};

type Screen = 'loading' | 'error' | 'my-wishlists' | 'wishlist-detail' | 'item-detail' | 'share' | 'guest-view' | 'guest-item-detail' | 'archive';
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

function WishCardOwner({ item, onTap, onDelete, onComplete }: {
  item: Item;
  onTap: (item: Item) => void;
  onDelete: (item: Item) => void;
  onComplete?: (item: Item) => void;
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
          {item.price != null && <span style={{ fontSize: 14, fontWeight: 700, color: C.accent, fontFamily: font }}>{fmtPrice(item.price)}</span>}
          {item.url && <span style={{ fontSize: 11, color: C.textMuted, background: C.surface, padding: '2px 8px', borderRadius: 6 }}>🔗 ссылка</span>}
        </div>
        <div style={{ marginTop: 10 }}>
          {isReserved && <span style={{ display: 'inline-block', padding: '6px 12px', borderRadius: 10, background: C.accentSoft, color: C.accent, fontSize: 13, fontWeight: 600 }}>Кто-то выбрал этот подарок ✨</span>}
          {isPurchased && <span style={{ display: 'inline-block', padding: '6px 12px', borderRadius: 10, background: C.greenSoft, color: C.green, fontSize: 13, fontWeight: 600 }}>✅ Подарено</span>}
        </div>
      </div>
    </div>
  );
}

function WishCardGuest({ item, onTap, onReserve, onUnreserve, myActorHash }: { item: GuestItem; onTap: (item: GuestItem) => void; onReserve: (item: GuestItem) => void; onUnreserve: (item: GuestItem) => void; myActorHash: string }) {
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
          {item.price != null && <span style={{ fontSize: 14, fontWeight: 700, color: C.accent, fontFamily: font }}>{fmtPrice(item.price)}</span>}
          {item.url && <a href={item.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ fontSize: 11, color: C.accent, background: C.accentSoft, padding: '2px 8px', borderRadius: 6, textDecoration: 'none' }}>🔗 ссылка</a>}
        </div>
        <div style={{ marginTop: 10 }}>
          {item.status === 'available' && (
            <button onClick={(e) => { e.stopPropagation(); onReserve(item); }} style={{ ...btnPrimary, width: 'auto', padding: '8px 16px', fontSize: 13 }}>🎁 Забронировать</button>
          )}
          {isReservedByMe && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ display: 'inline-block', padding: '6px 12px', borderRadius: 10, background: C.greenSoft, color: C.green, fontSize: 13, fontWeight: 600 }}>
                ✅ Забронировано мной
              </span>
              <button onClick={(e) => { e.stopPropagation(); onUnreserve(item); }} style={{ background: 'none', border: 'none', padding: '6px 8px', fontSize: 12, color: C.textMuted, cursor: 'pointer', fontFamily: font }}>Отменить</button>
            </div>
          )}
          {isReserved && !isReservedByMe && (
            <span style={{ display: 'inline-block', padding: '6px 12px', borderRadius: 10, background: C.orangeSoft, color: C.orange, fontSize: 13, fontWeight: 600 }}>
              Уже забронировано
            </span>
          )}
          {isPurchased && <span style={{ display: 'inline-block', padding: '6px 12px', borderRadius: 10, background: C.greenSoft, color: C.green, fontSize: 13, fontWeight: 600 }}>✅ Подарено</span>}
        </div>
      </div>
    </div>
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

  // Owner state
  const [wishlists, setWishlists] = useState<Wishlist[]>([]);
  const [planLimits, setPlanLimits] = useState({ wishlists: 2, items: 10 });
  const [currentWl, setCurrentWl] = useState<Wishlist | null>(null);
  const [items, setItems] = useState<Item[]>([]);

  // Archive state
  const [archiveItems, setArchiveItems] = useState<Item[]>([]);

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

  // Delete confirmation
  const [deletingItem, setDeletingItem] = useState<Item | null>(null);

  // Guest forms
  const [priceFilter, setPriceFilter] = useState(0);
  const [reservingItem, setReservingItem] = useState<GuestItem | null>(null);
  const [guestName, setGuestName] = useState('');

  // Comments
  const [comments, setComments] = useState<CommentDTO[]>([]);
  const [commentText, setCommentText] = useState('');
  const [commentRole, setCommentRole] = useState<'owner' | 'reserver' | null>(null);
  const [commentSending, setCommentSending] = useState(false);

  // Description editing
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionText, setDescriptionText] = useState('');

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
    const json = await res.json() as { wishlists: Wishlist[]; plan: { wishlists: number; items: number } };
    setWishlists(json.wishlists);
    setPlanLimits(json.plan);
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
      if (slugRes.status === 404) throw new Error('Вишлист не найден');
      if (!slugRes.ok) throw new Error('Не удалось загрузить вишлист');
      json = await slugRes.json() as GuestResponse;
    }

    if (!json) throw new Error('Не удалось загрузить вишлист');

    const priorityMap: Record<string, 1 | 2 | 3> = { LOW: 1, MEDIUM: 2, HIGH: 3 };
    setGuestWl(json.wishlist);
    setGuestItems(json.items.map((i) => ({
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
    })));
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
    if (text.length > 300) { pushToast('Максимум 300 символов', 'error'); return; }
    const stripped = text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s.…]+/gu, '');
    if (stripped.length === 0) { pushToast('Напиши что-нибудь содержательное', 'error'); return; }

    setCommentSending(true);
    try {
      const res = await tgFetch(`/tg/items/${viewingItem.id}/comments`, {
        method: 'POST',
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: string };
        pushToast(json.error || 'Ошибка отправки', 'error');
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
      pushToast('Ошибка удаления', 'error');
    }
  }, [viewingItem, tgFetch, pushToast]);

  const handleSaveDescription = useCallback(async () => {
    if (!viewingItem) return;
    setLoading(true);
    try {
      const desc = descriptionText.trim() || null;
      const res = await tgFetch(`/tg/items/${viewingItem.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ description: desc }),
      });
      if (!res.ok) { pushToast('Ошибка сохранения', 'error'); return; }
      const updated = { ...viewingItem, description: desc };
      setViewingItem(updated);
      setItems(prev => prev.map(i => i.id === viewingItem.id ? { ...i, description: desc } : i));
      setEditingDescription(false);
      pushToast('Описание сохранено', 'success');
    } finally {
      setLoading(false);
    }
  }, [viewingItem, descriptionText, tgFetch, pushToast]);

  // --- Navigation with Telegram BackButton
  const navBack = useCallback(() => {
    if (screen === 'item-detail') {
      setViewingItem(null);
      setScreen('wishlist-detail');
    } else if (screen === 'guest-item-detail') {
      setViewingItem(null);
      setScreen('guest-view');
    } else if (screen === 'wishlist-detail' || screen === 'guest-view') {
      setCurrentWl(null);
      setScreen('my-wishlists');
      if (screen === 'guest-view') {
        loadWishlists().catch(() => { /* silent — screen already set */ });
      }
    } else if (screen === 'share' || screen === 'archive') {
      setScreen('wishlist-detail');
    }
  }, [screen, loadWishlists]);

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
          setErrorMsg('Открой в Telegram');
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
        setErrorMsg('Не удалось загрузить. Попробуй ещё раз.');
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

      // If not inside real Telegram (initData is empty), show "Open in Telegram"
      // instead of attempting a doomed auth/API flow.
      if (!tg.initData) {
        setErrorMsg('Открой в Telegram');
        setScreen('error');
        return;
      }

      const handleErr = (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        // eslint-disable-next-line no-console
        console.error('[WishBoard]', msg, { apiBase, initData: tg.initData?.substring(0, 50) });
        setErrorMsg('Не удалось загрузить. Попробуй ещё раз.');
        setScreen('error');
      };

      if (startParam) {
        // Load guest wishlist AND owner wishlists in parallel.
        // Owner wishlists are needed so that "back" from guest-view shows
        // the user's own data instead of an empty "Пока пусто" screen.
        loadGuestWishlist(startParam)
          .then(() => setScreen('guest-view'))
          .catch(handleErr);
        loadWishlists().catch(() => { /* non-critical for guest flow */ });
      } else {
        loadWishlists()
          .then(() => setScreen('my-wishlists'))
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
    } else {
      setComments([]);
      setCommentRole(null);
      setCommentText('');
    }
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
      if (res.status === 402) { pushToast(`Лимит Free: ${planLimits.wishlists} вишлиста ⭐`, 'error'); return; }
      if (!res.ok) { pushToast('Ошибка создания', 'error'); return; }
      const json = await res.json() as { wishlist: Wishlist };
      setWishlists((prev) => [json.wishlist, ...prev]);
      setShowCreateWl(false);
      setWlTitle(''); setWlDeadline('');
      pushToast('✅ Вишлист создан!', 'success');
      // Navigate into new wishlist
      setCurrentWl(json.wishlist);
      setItems([]);
      setScreen('wishlist-detail');
    } finally {
      setLoading(false);
    }
  };

  const openWishlist = async (wl: Wishlist) => {
    setCurrentWl(wl);
    setScreen('wishlist-detail');
    setLoading(true);
    try {
      await loadItems(wl.id);
    } catch {
      pushToast('Ошибка загрузки', 'error');
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
      setPhotoError('Только изображения (JPEG, PNG, WebP, GIF)');
      if (photoInputRef.current) photoInputRef.current.value = '';
      return;
    }
    if (file.size > 30 * 1024 * 1024) {
      setPhotoError('Файл слишком большой. Максимум 30 МБ');
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
        let msg = 'Ошибка загрузки фото';
        try { const j = await res.json() as { error?: string }; if (j.error) msg = j.error; } catch { /* */ }
        setPhotoError(msg);
        return null;
      }
      const json = await res.json() as { photoUrl: string };
      return json.photoUrl;
    } catch {
      setPhotoError('Ошибка сети при загрузке фото');
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
        if (!res.ok) { pushToast('Ошибка сохранения', 'error'); return; }
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
        pushToast('✅ Сохранено!', 'success');
      } else {
        const res = await tgFetch(`/tg/wishlists/${currentWl.id}/items`, { method: 'POST', body: JSON.stringify(body) });
        if (res.status === 402) { pushToast(`Лимит Free: ${planLimits.items} желаний ⭐`, 'error'); return; }
        if (!res.ok) { pushToast('Ошибка добавления', 'error'); return; }
        const json = await res.json() as { item: Item };

        if (itemPhotoFile) {
          setPhotoUploading(true);
          await uploadPhoto(json.item.id, itemPhotoFile);
          setPhotoUploading(false);
        }

        // Reload from API to get correct sorted position
        setWishlists((prev) => prev.map((wl) => wl.id === currentWl.id ? { ...wl, itemCount: wl.itemCount + 1 } : wl));
        await loadItems(currentWl.id);
        pushToast('✅ Желание добавлено!', 'success');
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
      if (!res.ok) { pushToast('Ошибка удаления', 'error'); return; }
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setWishlists((prev) => prev.map((wl) => wl.id === currentWl.id ? { ...wl, itemCount: Math.max(0, wl.itemCount - 1) } : wl));
      pushToast('🗑 Удалено', 'success');
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
      if (!res.ok) { pushToast('Ошибка загрузки архива', 'error'); return; }
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
      if (!res.ok) { pushToast('Ошибка', 'error'); return; }
      setItems((prev) => prev.filter((i) => i.id !== item.id));
      setWishlists((prev) => prev.map((wl) => wl.id === currentWl.id ? { ...wl, itemCount: Math.max(0, wl.itemCount - 1) } : wl));
      pushToast('Получено!', 'success');
      try { tgRef.current?.WebApp?.HapticFeedback?.notificationOccurred('success'); } catch { /* ok */ }
    } finally {
      setLoading(false);
    }
  };

  const handleRestoreItem = async (item: Item) => {
    setLoading(true);
    try {
      const res = await tgFetch(`/tg/items/${item.id}/restore`, { method: 'POST' });
      if (!res.ok) { pushToast('Ошибка восстановления', 'error'); return; }
      const json = await res.json() as { item: Item };
      setArchiveItems((prev) => prev.filter((i) => i.id !== item.id));
      setItems((prev) => [...prev, json.item]);
      if (currentWl) {
        setWishlists((prev) => prev.map((wl) => wl.id === currentWl!.id ? { ...wl, itemCount: wl.itemCount + 1 } : wl));
      }
      pushToast('Восстановлено!', 'success');
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
      if (res.status === 409) { pushToast('Уже забронировано', 'error'); return; }
      if (!res.ok) { pushToast('Что-то пошло не так', 'error'); return; }
      const updatedItem = { ...reservingItem, status: 'reserved' as const, reservedByDisplayName: guestName.trim(), reservedByActorHash: myActorHashRef.current };
      setGuestItems((prev) => prev.map((i) => i.id === reservingItem.id ? updatedItem : i));
      if (viewingItem && viewingItem.id === reservingItem.id) setViewingItem(updatedItem);
      pushToast('🎁 Забронировано!', 'success');
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
      if (!res.ok) { pushToast('Ошибка отмены', 'error'); return; }
      const updatedItem = { ...item, status: 'available' as const, reservedByDisplayName: null, reservedByActorHash: null };
      setGuestItems((prev) => prev.map((i) => i.id === item.id ? updatedItem : i));
      if (viewingItem && viewingItem.id === item.id) setViewingItem(updatedItem);
      pushToast('Бронь отменена', 'success');
    } finally {
      setLoading(false);
    }
  };

  const fmtDeadline = (d: string | null) => {
    if (!d) return null;
    return new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  };

  // ─────────────────────────────────────────────────
  // RENDER
  // ─────────────────────────────────────────────────

  const CommentsThread = ({ isArchive }: { isArchive?: boolean }) => {
    if (!commentRole) return null;

    const canDelete = (c: CommentDTO) => {
      if (c.type === 'SYSTEM') return false;
      if (commentRole === 'owner') return true; // owner can delete any USER
      return c.authorActorHash === myActorHashRef.current; // reserver: own only
    };

    return (
      <div style={{ marginTop: 20 }}>
        <div style={{ fontSize: 15, fontWeight: 600, color: C.text, marginBottom: 8, fontFamily: font }}>
          💬 Комментарии
        </div>
        <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 12, lineHeight: 1.4 }}>
          🔒 Комментарии видны только автору и тому, кто забронировал
        </div>

        {isArchive && (
          <div style={{ fontSize: 12, color: C.orange, background: C.orangeSoft, padding: '8px 12px', borderRadius: 10, marginBottom: 12 }}>
            Комментарии будут удалены через 30 дней
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {comments.length === 0 && (
            <div style={{ textAlign: 'center', fontSize: 13, color: C.textMuted, padding: '16px 0' }}>
              Пока нет комментариев
            </div>
          )}
          {comments.map(c => (
            c.type === 'SYSTEM' ? (
              <div key={c.id} style={{
                textAlign: 'center', fontSize: 11, color: C.textMuted,
                padding: '6px 12px', background: C.surface, borderRadius: 10, margin: '4px 0',
              }}>
                {c.text} · {new Date(c.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              </div>
            ) : (
              <div key={c.id} style={{
                alignSelf: c.authorActorHash === myActorHashRef.current ? 'flex-end' : 'flex-start',
                maxWidth: '80%', position: 'relative',
              }}>
                {c.authorActorHash !== myActorHashRef.current && (
                  <div style={{ fontSize: 11, color: C.accent, marginBottom: 2, fontWeight: 600, fontFamily: font }}>
                    {c.authorDisplayName ?? 'Аноним'}
                  </div>
                )}
                {c.authorActorHash === myActorHashRef.current && (
                  <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', marginBottom: 2, fontWeight: 600, fontFamily: font, textAlign: 'right' }}>
                    Я
                  </div>
                )}
                <div style={{
                  padding: '10px 14px', borderRadius: 14,
                  background: c.authorActorHash === myActorHashRef.current ? C.accent : C.card,
                  color: c.authorActorHash === myActorHashRef.current ? '#fff' : C.text,
                  fontSize: 14, lineHeight: 1.4,
                  border: c.authorActorHash === myActorHashRef.current ? 'none' : `1px solid ${C.border}`,
                }}>
                  {c.text}
                  <div style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    marginTop: 4, gap: 8,
                  }}>
                    <span style={{
                      fontSize: 10,
                      color: c.authorActorHash === myActorHashRef.current ? 'rgba(255,255,255,0.5)' : C.textMuted,
                    }}>
                      {new Date(c.createdAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    {canDelete(c) && !isArchive && (
                      <button
                        onClick={() => void handleDeleteComment(c.id)}
                        style={{
                          background: 'none', border: 'none', padding: '2px 4px', cursor: 'pointer',
                          fontSize: 10, color: c.authorActorHash === myActorHashRef.current ? 'rgba(255,255,255,0.4)' : C.textMuted,
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

        {/* Comment input — only for active items */}
        {!isArchive && (
          <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'flex-end' }}>
            <div style={{ flex: 1, position: 'relative' }}>
              <textarea
                style={{ ...inputStyle, minHeight: 44, maxHeight: 120, resize: 'none', paddingRight: 50 }}
                placeholder="Написать комментарий..."
                value={commentText}
                onChange={(e) => setCommentText(e.target.value.slice(0, 300))}
                maxLength={300}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void handleSendComment(); } }}
              />
              <span style={{
                position: 'absolute', right: 12, bottom: 8,
                fontSize: 10, color: commentText.length > 280 ? C.orange : C.textMuted,
              }}>
                {commentText.length}/300
              </span>
            </div>
            <button
              onClick={() => void handleSendComment()}
              disabled={!commentText.trim() || commentSending}
              style={{
                ...btnPrimary, width: 44, height: 44, padding: 0, borderRadius: 12,
                opacity: commentText.trim() ? 1 : 0.4, flexShrink: 0,
              }}
            >
              {commentSending ? '…' : '↑'}
            </button>
          </div>
        )}
      </div>
    );
  };

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
        * { box-sizing:border-box; -webkit-tap-highlight-color:transparent }
        input, textarea, select { -webkit-appearance:none }
      `}</style>

      {/* ── LOADING ── */}
      {screen === 'loading' && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 40 }}>🎁</div>
          <div style={{ color: C.textMuted, fontSize: 15 }}>Загрузка…</div>
        </div>
      )}

      {/* ── ERROR ── */}
      {screen === 'error' && (() => {
        const isTgRequired = errorMsg === 'Открой в Telegram';
        const tgDeepLink = buildTgDeepLink(urlStartParamRef.current || undefined);
        return (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', flexDirection: 'column', gap: 16, padding: 24 }}>
            <div style={{ fontSize: 48 }}>{isTgRequired ? '✈️' : '😕'}</div>
            <div style={{ fontSize: 18, fontWeight: 700, textAlign: 'center', color: C.text }}>
              {isTgRequired ? 'Открой в Telegram' : 'Ошибка загрузки'}
            </div>
            <div style={{ fontSize: 15, color: C.textSec, textAlign: 'center', lineHeight: 1.5 }}>
              {isTgRequired
                ? 'Это приложение работает только внутри Telegram'
                : (errorMsg || 'Неизвестная ошибка')}
            </div>
            {isTgRequired && tgDeepLink ? (
              <a href={tgDeepLink} style={{ textDecoration: 'none' }}>
                <button style={{ ...btnPrimary, marginTop: 8, width: 220 }}>
                  Открыть в Telegram
                </button>
              </a>
            ) : (
              <button
                style={{ ...btnPrimary, marginTop: 8, width: 200 }}
                onClick={() => window.location.reload()}
              >
                Повторить
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
              <h1 style={{ fontSize: 24, fontWeight: 800, fontFamily: font, color: C.text, margin: 0 }}>WishBoard</h1>
              <p style={{ fontSize: 13, color: C.textMuted, margin: '4px 0 0' }}>
                {tgUser ? `Привет, ${tgUser.first_name}!` : 'Мои вишлисты'}
              </p>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {wishlists.length > 0 && (
              <div style={{
                background: `linear-gradient(135deg, ${C.accent}18, ${C.accent}06)`,
                borderRadius: 16, padding: '16px 20px', border: `1px solid ${C.accent}15`,
                animation: 'fadeIn 0.3s ease',
              }}>
                <div style={{ fontSize: 13, color: C.textSec, marginBottom: 8 }}>📊 Всего</div>
                <div style={{ display: 'flex', gap: 24 }}>
                  {[
                    { n: wishlists.length, l: 'вишлиста', c: C.text },
                    { n: totalItems, l: 'желаний', c: C.accent },
                    { n: totalReserved, l: 'забронировано', c: C.green },
                  ].map((s, i) => (
                    <div key={i}>
                      <div style={{ fontSize: 24, fontWeight: 800, color: s.c, fontFamily: font }}>{s.n}</div>
                      <div style={{ fontSize: 11, color: C.textMuted }}>{s.l}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {wishlists.map((wl, i) => (
              <div key={wl.id} onClick={() => void openWishlist(wl)} style={{
                background: C.card, borderRadius: 16, padding: 18, cursor: 'pointer',
                border: `1px solid ${C.border}`, animation: `fadeIn 0.3s ease ${(i + 1) * 0.08}s both`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 700, fontFamily: font, color: C.text }}>{wl.title}</div>
                    <div style={{ fontSize: 13, color: C.textMuted, marginTop: 4 }}>
                      {wl.itemCount} желаний • {wl.reservedCount} забронировано
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
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 8 }}>📅 До {fmtDeadline(wl.deadline)}</div>
                )}
              </div>
            ))}

            {wishlists.length === 0 && (
              <div style={{ textAlign: 'center', padding: '48px 24px' }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>🎁</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8 }}>Пока пусто</div>
                <div style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.5 }}>
                  Создай первый вишлист и поделись с друзьями!
                </div>
              </div>
            )}

            <div style={{ textAlign: 'center', padding: '4px 0', fontSize: 12, color: C.textMuted }}>
              Free-план: {wishlists.length} из {planLimits.wishlists} вишлистов
            </div>
            <button style={btnPrimary} onClick={() => setShowCreateWl(true)}>＋ Создать вишлист</button>
          </div>

          <BottomSheet isOpen={showCreateWl} onClose={() => setShowCreateWl(false)} title="Новый вишлист">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>Название</label>
                <input style={inputStyle} placeholder="День рождения 2026 🎂" value={wlTitle} onChange={(e) => setWlTitle(e.target.value)} autoFocus />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>Дедлайн (необязательно)</label>
                <input style={{ ...inputStyle, colorScheme: 'dark' }} type="date" value={wlDeadline} onChange={(e) => setWlDeadline(e.target.value)} />
              </div>
              <button style={{ ...btnPrimary, opacity: wlTitle.trim() ? 1 : 0.5 }} onClick={() => void handleCreateWishlist()} disabled={!wlTitle.trim() || loading}>
                {loading ? '…' : '✨ Создать'}
              </button>
            </div>
          </BottomSheet>
        </div>
      )}

      {/* ══════════════════════════════════════════════
          OWNER — WISHLIST DETAIL
          ══════════════════════════════════════════════ */}
      {screen === 'wishlist-detail' && currentWl && (
        <div style={{ padding: '16px 20px 120px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
            <div>
              <h1 style={{ fontSize: 20, fontWeight: 700, fontFamily: font, color: C.text, margin: 0 }}>{currentWl.title}</h1>
              <p style={{ fontSize: 12, color: C.textMuted, margin: '2px 0 0' }}>
                {items.length} желаний
                {currentWl.deadline && ` • до ${fmtDeadline(currentWl.deadline)}`}
              </p>
            </div>
            <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
              <button
                onClick={() => void loadArchive()}
                style={{ ...btnGhost, padding: '8px 12px', fontSize: 13 }}
              >
                📦 Архив
              </button>
              <button
                onClick={() => setScreen('share')}
                style={{ ...btnPrimary, width: 'auto', padding: '8px 16px', fontSize: 13 }}
              >
                Поделиться
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ borderRadius: 12, padding: '12px 16px', fontSize: 13, display: 'flex', alignItems: 'center', gap: 10, background: C.accentSoft, color: C.accent, lineHeight: 1.5 }}>
              <span>👁</span><span>Ты не видишь, кто и что забронировал — сюрприз!</span>
            </div>

            {loading && items.length === 0 && (
              <div style={{ textAlign: 'center', padding: 40, color: C.textMuted }}>Загрузка…</div>
            )}

            {items.map((item, i) => (
              <div key={item.id} style={{ animation: `fadeIn 0.3s ease ${i * 0.06}s both` }}>
                <WishCardOwner item={item} onTap={(it) => { setViewingItem(it); setScreen('item-detail'); }} onDelete={setDeletingItem} onComplete={handleCompleteItem} />
              </div>
            ))}

            {!loading && items.length === 0 && (
              <div style={{ textAlign: 'center', padding: '48px 24px' }}>
                <div style={{ fontSize: 48, marginBottom: 16 }}>✨</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: C.text, marginBottom: 8 }}>Добавь первое желание</div>
                <div style={{ fontSize: 14, color: C.textMuted }}>Что бы ты хотел получить в подарок?</div>
              </div>
            )}

            <button style={btnSecondary} onClick={() => { resetItemForm(); setShowItemForm(true); }}>＋ Добавить желание</button>
          </div>

        </div>
      )}

      {/* ══════════════════════════════════════════════
          OWNER — ITEM DETAIL (view + actions)
          ══════════════════════════════════════════════ */}
      {screen === 'item-detail' && viewingItem && (
        <div style={{ padding: '16px 20px 120px' }}>
          {/* Large image */}
          {viewingItem.imageUrl ? (
            <img src={viewingItem.imageUrl} alt="" style={{ width: '100%', maxHeight: 280, objectFit: 'cover', borderRadius: 16, marginBottom: 20, background: C.surface }} />
          ) : (
            <div style={{ width: '100%', height: 140, borderRadius: 16, background: C.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 56, marginBottom: 20 }}>
              {getEmoji(viewingItem.title)}
            </div>
          )}
          <h1 style={{ fontSize: 22, fontWeight: 700, fontFamily: font, color: C.text, margin: '0 0 8px' }}>{viewingItem.title}</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 18, fontWeight: 700, color: C.accent }}>{viewingItem.price != null ? fmtPrice(viewingItem.price) : ''}</span>
            <span style={{ fontSize: 16 }}>{prioEmoji(viewingItem.priority)}</span>
            <span style={{ fontSize: 12, color: C.textMuted }}>{PRIORITIES.find((p) => p.value === viewingItem!.priority)?.label}</span>
          </div>
          {viewingItem.url && (
            <a href={viewingItem.url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: C.accent, background: C.accentSoft, padding: '8px 14px', borderRadius: 10, textDecoration: 'none', marginBottom: 16, wordBreak: 'break-all' }}>
              🔗 {viewingItem.url.replace(/^https?:\/\//, '').slice(0, 40)}{viewingItem.url.length > 47 ? '…' : ''}
            </a>
          )}
          {/* Description */}
          <div style={{ marginTop: 12, marginBottom: 16 }}>
            {viewingItem.description ? (
              <div style={{
                fontSize: 14, color: C.textSec, lineHeight: 1.6,
                padding: '12px 16px', background: C.surface, borderRadius: 12,
                border: `1px solid ${C.border}`,
              }}>
                {viewingItem.description}
                <div
                  onClick={() => { setDescriptionText(viewingItem.description ?? ''); setEditingDescription(true); }}
                  style={{ fontSize: 12, color: C.accent, marginTop: 8, cursor: 'pointer', fontFamily: font }}
                >
                  ✏️ Изменить описание
                </div>
              </div>
            ) : (
              <div
                onClick={() => { setDescriptionText(''); setEditingDescription(true); }}
                style={{
                  fontSize: 13, color: C.textMuted, padding: '12px 16px',
                  background: C.surface, borderRadius: 12, cursor: 'pointer',
                  border: `1px dashed ${C.borderLight}`, lineHeight: 1.5,
                }}
              >
                ＋ Добавь описание, чтобы друзьям было проще выбрать подарок
              </div>
            )}
          </div>
          {/* Status badge */}
          <div style={{ marginTop: 8, marginBottom: 20 }}>
            {viewingItem.status === 'reserved' && <span style={{ display: 'inline-block', padding: '8px 14px', borderRadius: 10, background: C.accentSoft, color: C.accent, fontSize: 14, fontWeight: 600 }}>Кто-то выбрал этот подарок ✨</span>}
            {viewingItem.status === 'purchased' && <span style={{ display: 'inline-block', padding: '8px 14px', borderRadius: 10, background: C.greenSoft, color: C.green, fontSize: 14, fontWeight: 600 }}>✅ Подарено</span>}
          </div>
          {/* Comments */}
          <CommentsThread isArchive={viewingItem.status === 'completed' || viewingItem.status === 'deleted'} />
          {/* Owner actions */}
          {viewingItem.status !== 'purchased' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button onClick={() => {
                // Navigate to wishlist-detail first, then open edit form via useEffect
                // (BottomSheet position:fixed glitches inside Telegram WebView)
                setPendingEditItem(viewingItem as Item);
                setViewingItem(null);
                setScreen('wishlist-detail');
              }} style={{ ...btnPrimary, width: '100%' }}>✏️ Редактировать</button>
              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => {
                  // Navigate back, then show delete confirmation
                  const item = viewingItem as Item;
                  setViewingItem(null);
                  setScreen('wishlist-detail');
                  setDeletingItem(item);
                }} style={{ ...btnGhost, flex: 1, color: C.red }}>🗑 Удалить</button>
                <button onClick={() => {
                  setShowItemForm(false);
                  resetItemForm();
                  handleCompleteItem(viewingItem as Item);
                  setViewingItem(null);
                  setScreen('wishlist-detail');
                }} style={{ ...btnGhost, flex: 1, color: C.green }}>Получено ✓</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════
          GUEST — ITEM DETAIL (view only)
          ══════════════════════════════════════════════ */}
      {screen === 'guest-item-detail' && viewingItem && (
        <div style={{ padding: '16px 20px 120px' }}>
          {viewingItem.imageUrl ? (
            <img src={viewingItem.imageUrl} alt="" style={{ width: '100%', maxHeight: 280, objectFit: 'cover', borderRadius: 16, marginBottom: 20, background: C.surface }} />
          ) : (
            <div style={{ width: '100%', height: 140, borderRadius: 16, background: C.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 56, marginBottom: 20 }}>
              {getEmoji(viewingItem.title)}
            </div>
          )}
          <h1 style={{ fontSize: 22, fontWeight: 700, fontFamily: font, color: C.text, margin: '0 0 8px' }}>{viewingItem.title}</h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span style={{ fontSize: 18, fontWeight: 700, color: C.accent }}>{viewingItem.price != null ? fmtPrice(viewingItem.price) : ''}</span>
            <span style={{ fontSize: 16 }}>{prioEmoji(viewingItem.priority)}</span>
            <span style={{ fontSize: 12, color: C.textMuted }}>{PRIORITIES.find((p) => p.value === viewingItem!.priority)?.label}</span>
          </div>
          {viewingItem.url && (
            <a href={viewingItem.url} target="_blank" rel="noreferrer" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: C.accent, background: C.accentSoft, padding: '8px 14px', borderRadius: 10, textDecoration: 'none', marginBottom: 16, wordBreak: 'break-all' }}>
              🔗 {viewingItem.url.replace(/^https?:\/\//, '').slice(0, 40)}{viewingItem.url.length > 47 ? '…' : ''}
            </a>
          )}
          {/* Description — read-only for guests */}
          {viewingItem.description && (
            <div style={{
              fontSize: 14, color: C.textSec, lineHeight: 1.6,
              padding: '12px 16px', background: C.surface, borderRadius: 12,
              border: `1px solid ${C.border}`, marginTop: 12,
            }}>
              {viewingItem.description}
            </div>
          )}
          <div style={{ marginTop: 8, marginBottom: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {viewingItem.status === 'available' && (
              <button onClick={() => { setReservingItem(viewingItem as GuestItem); setGuestName(tgUser?.first_name ?? ''); }} style={{ ...btnPrimary, width: '100%' }}>🎁 Забронировать</button>
            )}
            {viewingItem.status === 'reserved' && !!myActorHashRef.current && (viewingItem as GuestItem).reservedByActorHash === myActorHashRef.current && (
              <>
                <span style={{ display: 'inline-block', padding: '8px 14px', borderRadius: 10, background: C.greenSoft, color: C.green, fontSize: 14, fontWeight: 600 }}>
                  ✅ Забронировано мной
                </span>
                <button onClick={() => void handleUnreserve(viewingItem as GuestItem)} style={{ ...btnGhost, color: C.textSec, width: '100%' }}>Отменить бронь</button>
              </>
            )}
            {viewingItem.status === 'reserved' && !(!!myActorHashRef.current && (viewingItem as GuestItem).reservedByActorHash === myActorHashRef.current) && (
              <span style={{ display: 'inline-block', padding: '8px 14px', borderRadius: 10, background: C.orangeSoft, color: C.orange, fontSize: 14, fontWeight: 600 }}>
                Уже забронировано
              </span>
            )}
            {viewingItem.status === 'purchased' && <span style={{ display: 'inline-block', padding: '8px 14px', borderRadius: 10, background: C.greenSoft, color: C.green, fontSize: 14, fontWeight: 600 }}>✅ Подарено</span>}
          </div>
          {/* Comments — for reserver and owner */}
          <CommentsThread isArchive={viewingItem.status === 'completed' || viewingItem.status === 'deleted'} />

          {/* Hint for third parties */}
          {viewingItem.status === 'available' && !commentRole && (
            <div style={{ fontSize: 12, color: C.textMuted, textAlign: 'center', marginTop: 12, lineHeight: 1.5 }}>
              После бронирования можно оставить комментарий для автора
            </div>
          )}
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
          onCopied={() => pushToast('📨 Ссылка скопирована', 'success')}
          buildTgDeepLink={buildTgDeepLink}
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
                <div style={{ fontSize: 12, color: C.textMuted }}>📅 до {fmtDeadline(guestWl.deadline)}</div>
              )}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
            {PRICE_FILTERS.map((pf, i) => (
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
              .filter((i) => !PRICE_FILTERS[priceFilter]?.max || !i.price || i.price <= (PRICE_FILTERS[priceFilter]?.max ?? Infinity))
              .map((item, i) => (
                <div key={item.id} style={{ animation: `fadeIn 0.3s ease ${i * 0.06}s both` }}>
                  <WishCardGuest item={item} onTap={(it) => { setViewingItem(it); setScreen('guest-item-detail'); }} onReserve={(w) => { setReservingItem(w); setGuestName(tgUser?.first_name ?? ''); }} onUnreserve={handleUnreserve} myActorHash={myActorHashRef.current} />
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
              <h1 style={{ fontSize: 20, fontWeight: 700, fontFamily: font, color: C.text, margin: 0 }}>📦 Архив</h1>
              <p style={{ fontSize: 12, color: C.textMuted, margin: '2px 0 0' }}>{currentWl.title}</p>
            </div>
            <button onClick={() => setScreen('wishlist-detail')} style={{ ...btnGhost, fontSize: 13, padding: '8px 14px' }}>← Назад</button>
          </div>

          {archiveItems.length === 0 && !loading && (
            <div style={{ textAlign: 'center', padding: '48px 24px' }}>
              <div style={{ fontSize: 48, marginBottom: 16 }}>📦</div>
              <div style={{ fontSize: 15, color: C.textMuted, lineHeight: 1.5 }}>Архив пуст</div>
              <div style={{ fontSize: 13, color: C.textMuted, marginTop: 8 }}>Удалённые и полученные желания появятся здесь</div>
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
                        <span style={{ fontSize: 11, background: C.greenSoft, color: C.green, padding: '2px 8px', borderRadius: 6, fontWeight: 600 }}>Получено</span>
                      )}
                      {item.status === 'deleted' && (
                        <span style={{ fontSize: 11, background: C.surface, color: C.textMuted, padding: '2px 8px', borderRadius: 6, fontWeight: 600 }}>Удалено</span>
                      )}
                      {item.price != null && <span style={{ fontSize: 13, color: C.textMuted }}>{fmtPrice(item.price)}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      <button onClick={() => void handleRestoreItem(item)} style={{ ...btnGhost, fontSize: 12, padding: '6px 10px', color: C.accent }}>↩ Восстановить</button>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── GLOBAL OVERLAYS (not tied to any screen — BottomSheet is position:fixed) ── */}
      <BottomSheet isOpen={editingDescription} onClose={() => setEditingDescription(false)} title="Описание">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <textarea
              style={{ ...inputStyle, minHeight: 100, resize: 'vertical' }}
              maxLength={500}
              placeholder="Опиши подробнее, что хочешь..."
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
            {loading ? '…' : '💾 Сохранить'}
          </button>
        </div>
      </BottomSheet>
      <BottomSheet isOpen={!!reservingItem} onClose={() => setReservingItem(null)} title="Забронировать подарок?">
        {reservingItem && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: 12, background: C.bg, borderRadius: 12 }}>
              <div style={{ width: 44, height: 44, borderRadius: 10, background: C.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}>🎁</div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 600, color: C.text, fontFamily: font }}>{reservingItem.title}</div>
                {reservingItem.price != null && <div style={{ fontSize: 14, color: C.accent, fontWeight: 700, marginTop: 2 }}>{fmtPrice(reservingItem.price)}</div>}
              </div>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>Твоё имя (видят другие гости)</label>
              <input style={inputStyle} placeholder="Как тебя зовут?" value={guestName} onChange={(e) => setGuestName(e.target.value)} autoFocus />
            </div>
            <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.5 }}>
              🔒 Владелец вишлиста <b>не увидит</b>, кто какой подарок забронировал.
            </div>
            <div style={{ display: 'flex', gap: 10 }}>
              <button style={{ ...btnGhost, flex: 1, width: '100%' }} onClick={() => setReservingItem(null)}>Отмена</button>
              <button
                style={{ ...btnPrimary, flex: 2, opacity: guestName.trim() ? 1 : 0.5 }}
                onClick={() => void handleReserve()}
                disabled={!guestName.trim() || loading}
              >
                {loading ? '…' : '🎁 Забронировать'}
              </button>
            </div>
          </div>
        )}
      </BottomSheet>
      <BottomSheet isOpen={showItemForm} onClose={() => { setShowItemForm(false); resetItemForm(); }} title={editingItem ? 'Редактировать' : 'Новое желание'}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div>
            <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>Название</label>
            <input style={inputStyle} placeholder="Например: AirPods Pro 3" value={itemTitle} onChange={(e) => setItemTitle(e.target.value)} autoFocus />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>Описание (необязательно)</label>
            <textarea
              style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }}
              maxLength={500}
              placeholder="Подробности о желании..."
              value={itemDescription}
              onChange={(e) => setItemDescription(e.target.value)}
            />
            <div style={{ fontSize: 11, color: C.textMuted, textAlign: 'right', marginTop: 2 }}>{itemDescription.length}/500</div>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>Ссылка (необязательно)</label>
            <input style={inputStyle} placeholder="https://…" value={itemUrl} onChange={(e) => setItemUrl(e.target.value)} />
          </div>
          {/* ── Photo picker ── */}
          {(() => {
            const photoPreviewSrc = itemPhotoDeleted ? null : (itemPhotoLocalUrl ?? (itemImageUrl || null));
            const hasPhoto = !!(itemPhotoLocalUrl || (!itemPhotoDeleted && itemImageUrl));
            return (
          <div>
            <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 8 }}>Фото</label>
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
                  <span>{hasPhoto ? 'Заменить фото' : 'Выбрать фото'}</span>
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
                    <span>Удалить фото</span>
                  </button>
                )}

                {photoError && (
                  <span style={{ fontSize: 12, color: C.red, lineHeight: 1.4 }}>{photoError}</span>
                )}
                {photoUploading && (
                  <span style={{ fontSize: 12, color: C.textMuted }}>Загружаю...</span>
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
            <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>Цена (необязательно)</label>
            <input style={inputStyle} placeholder="0 ₽" type="number" value={itemPrice} onChange={(e) => setItemPrice(e.target.value)} />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 13, color: C.textSec, marginBottom: 6 }}>Приоритет</label>
            <div style={{ display: 'flex', gap: 10 }}>
              {PRIORITIES.map((p) => (
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
            {loading ? '…' : editingItem ? '💾 Сохранить' : '✨ Добавить'}
          </button>
        </div>
      </BottomSheet>

      {/* Delete confirmation */}
      <BottomSheet isOpen={!!deletingItem} onClose={() => setDeletingItem(null)} title="Удалить желание?">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div style={{ fontSize: 15, color: C.textSec, lineHeight: 1.5 }}>{deletingItem?.title}</div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button style={{ ...btnGhost, flex: 1 }} onClick={() => setDeletingItem(null)}>Отмена</button>
            <button
              style={{ ...btnPrimary, flex: 2, background: C.red }}
              onClick={() => {
                if (deletingItem) {
                  void handleDeleteItem(deletingItem);
                  setDeletingItem(null);
                }
              }}
            >
              🗑 Удалить
            </button>
          </div>
        </div>
      </BottomSheet>

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

function ShareScreen({ wishlist, itemCount, tgUser, onCopied, buildTgDeepLink }: {
  wishlist: Wishlist;
  itemCount: number;
  tgUser: TgUser | null;
  onCopied: () => void;
  buildTgDeepLink: (payload?: string) => string | null;
}) {
  const [copied, setCopied] = useState(false);

  // Build link directly from slug — no API call needed.
  // Each wishlist always has a slug; the guest flow already supports slug-based lookup
  // via GET /public/wishlists/:slug, so no share-token generation is required.
  const shareLink = buildTgDeepLink(wishlist.slug);
  const linkError = !shareLink; // only fails if botUsername env var is missing

  const fmtDeadline = (d: string | null) => {
    if (!d) return null;
    return new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
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
    const shareText = `🎁 ${wishlist.title}\nВыбирай подарок тут 👇`;
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
      <h1 style={{ fontSize: 20, fontWeight: 700, fontFamily: font, color: C_local.text, margin: '8px 0 20px' }}>Поделиться</h1>

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
          <div style={{ fontSize: 20, fontWeight: 800, fontFamily: font, color: C_local.text }}>{tgUser?.first_name ?? 'Вишлист'}</div>
          <div style={{ fontSize: 14, color: C_local.textSec, marginTop: 4 }}>{wishlist.title}</div>
          <div style={{ fontSize: 13, color: C_local.textMuted, marginTop: 4 }}>
            {itemCount} желаний{wishlist.deadline ? ` • до ${fmtDeadline(wishlist.deadline)}` : ''}
          </div>
        </div>

        {linkError ? (
          <div style={{ borderRadius: 12, padding: '12px 16px', fontSize: 13, background: C_local.redSoft, color: C_local.red, width: '100%', lineHeight: 1.5, boxSizing: 'border-box', textAlign: 'center' }}>
            Не удалось создать ссылку. Попробуй позже.
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
                {copied ? '✅' : 'Копировать'}
              </span>
            </div>

            <button onClick={shareToTelegram} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 24px', borderRadius: 14, border: 'none', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: font, transition: 'all 0.15s', width: '100%', background: C_local.blue, color: '#fff' }}>
              ✈️ Поделиться в Telegram
            </button>

            <button onClick={copy} style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '14px 24px', borderRadius: 14, border: 'none', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: font, transition: 'all 0.15s', width: '100%', background: C_local.accent, color: '#fff' }}>
              📋 Скопировать ссылку
            </button>
          </>
        )}

        <div style={{ borderRadius: 12, padding: '12px 16px', fontSize: 12, background: C_local.greenSoft, color: C_local.green, width: '100%', lineHeight: 1.5, boxSizing: 'border-box' }}>
          🔒 Друзья увидят список, но не узнают, кто что забронировал. Ты тоже не увидишь детали — сюрприз!
        </div>
      </div>
    </div>
  );
}
