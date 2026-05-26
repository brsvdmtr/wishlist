// GuestViewRoot — F4 Wave E cluster file (REFACTOR_MINIAPP_TSX_PLAN).
//
// Bundles the 2 visitor-facing screens (guest-view + guest-item-detail,
// ~1.15k LOC of JSX) plus the guest filter BottomSheet into a single
// lazy-loaded module. Loaded via `next/dynamic({ ssr: false })` from
// `apps/web/app/miniapp/MiniApp.tsx`, so the chunk doesn't ship with
// the initial Mini App page bundle — guest code only downloads when a
// user opens a deep-link to someone else's wishlist or item, which is a
// strictly cold-path entry. Owner-flow users never pay the download.
//
// State source: `useGuestViewState` is invoked exactly once in
// MiniAppInner and the 18 returned fields are forwarded through `ctx`.
// The setters flow back into the same React state tree — no duplicate
// state. Sibling state (santa, group-gift, comments, reservations,
// secret reservations, birthday context, profile data) is forwarded
// the same way.
//
// Sub-screens (selected by `ctx.screen`):
//   1. guest-view         — public wishlist preview with filter/sort,
//                           categories, dontGift block, subscribe CTA,
//                           and birthday-context banner.
//   2. guest-item-detail  — public item detail with reserve/secret/
//                           group-gift CTAs, Pro-only reservation
//                           management, comments thread, Santa-context
//                           variant.
//
// Plus the always-mounted GUEST FILTER BOTTOM SHEET (gated by the
// `guestFilterOpen` state cell). The sheet is only opened from
// guest-view, so co-locating it here keeps the entire surface together
// and lets the parent unmount it cleanly when the user leaves both
// screens.
//
// Implementation discipline:
// - JSX is copied verbatim from MiniApp.tsx — DO NOT migrate styles or
//   refactor logic in this PR. Bundle savings only; cosmetic changes
//   ride future on-touch PRs.
// - `ctx` types intersect `GuestViewState` (setters keep
//   `Dispatch<SetStateAction<T>>` signatures) with the typed helpers bag
//   from `_shared/closure-types`. The remaining `any` slots are
//   confined to forwarded React component types (4× `ComponentType<any>`
//   for the Wish*Card primitives + CommentsThread + 1× `Dispatch<...
//   any>>` for setPublicProfileData) — they'll resolve when those
//   primitives extract to packages/ui.
// - The 3 Wish*Card components and the CommentsThread component still
//   live in MiniApp.tsx (they're reused by owner-side screens). They are
//   forwarded via ctx as React component types — same pattern as
//   ProfileRoot's `ReferralProfileTileFromConfig`.

'use client';

import React from 'react';
import { Banner, Button, Card, CounterBadge, HeroCard, Sheet as BottomSheet } from '@wishlist/ui';
import { t, pluralize, localeToBCP47, type Locale } from '@wishlist/shared';
import { getEmoji } from '../../lib/emoji';
import { ProBadge } from '../../components/ProBadge';
import type { ComponentType, Dispatch, RefObject, SetStateAction } from 'react';
import type {
  BirthdayContext, CommentDTO, GuestItem, GuestSort, HomeTab, Item, PlanInfo,
  ReservationItem, SantaReservationItem, TgUser,
} from '../../MiniApp';
import type { GroupGiftData } from '../../hooks/useGroupGiftState';
import type { GuestViewState } from '../../hooks/useGuestViewState';
import type { SantaDetailContext } from '../../hooks/useSantaState';
import type {
  LegacyColorBag, PushToast, SetScreen, SetUpsellSheet,
  ShowUpsell, TgFetch, TrackEvent,
} from '../../_shared/closure-types';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Secret-reservation entitlement bag — mirrors the inline useState
 * default at MiniApp.tsx near 4293.
 */
export type SecretAccess = {
  unlocked: boolean;
  unlockType: string | null;
  priceXtr: number;
};

// `BirthdayContext` lives at module scope in MiniApp.tsx and is imported
// above — single source of truth shared with PublicProfileRoot + the
// home banner. The local copy that used to live here was structurally
// identical to the canonical one; keeping two declarations created a
// silent-divergence risk.

export type GuestViewRootCtx = GuestViewState & {
  // ── Module-level constants forwarded from MiniApp.tsx ────────────────
  C: LegacyColorBag;
  font: string;
  locale: Locale;
  DONT_GIFT_PRESET_EMOJIS: Record<string, string>;
  CARD_REDESIGN_ENABLED: boolean;
  PRIO_BG: Record<number, string>;
  PRIO_COLOR: Record<number, string>;
  btnBase: React.CSSProperties;

  // ── Module-level helpers (functions defined in MiniApp.tsx) ──────────
  prioEmoji: (p: number) => string;
  fmtPrice: (p: number | null, locale?: Locale, currency?: 'RUB' | 'USD') => string | null;
  fmtDeadline: (d: string | null) => string | null;
  normalizeTitle: (raw: string | null | undefined) => string;
  getGuestBudgetPresets: (locale: Locale) => Array<{ max: number | null; label: string }>;
  getPriorities: (locale: Locale) => Array<{ value: number; label: string; emoji: string | undefined; sub?: string }>;
  getSantaItemReservationState: (
    status: string, reservedByActorHash: string | null, myActorHash: string,
  ) => 'available' | 'reserved-by-me' | 'reserved-by-other' | 'unavailable';
  resolveCardMode: (
    itemCount: number, cardDisplayMode: string | undefined, isPro: boolean,
  ) => 'compact' | 'showcase';

  // ── Hot-path helpers — real signatures from `_shared/closure-types` ──
  tgFetch: TgFetch;
  setScreen: SetScreen;
  pushToast: PushToast;
  trackEvent: TrackEvent;
  showUpsell: ShowUpsell;
  setUpsellSheet: SetUpsellSheet;

  // ── Card / Comments primitives reused from MiniApp.tsx ───────────────
  WishCardGuest: ComponentType<any>;
  WishCardCompact: ComponentType<any>;
  WishCardShowcase: ComponentType<any>;
  CommentsThread: ComponentType<any>;

  // ── Guest-view computed memos (owned by MiniAppInner useMemo) ────────
  guestMainList: GuestItem[];
  guestNoPriceBlock: GuestItem[];
  guestFiltersActive: boolean;
  guestFilterBadge: number;
  guestHasUserCategories: boolean;
  guestDefaultCategory: { id: string } | null;

  // ── Top-level shared state read by guest screens ─────────────────────
  viewingItem: (Item | GuestItem) | null;
  setViewingItem: Dispatch<SetStateAction<(Item | GuestItem) | null>>;
  setItemPhotoOpen: Dispatch<SetStateAction<boolean>>;
  homeReturnTab: HomeTab | null;
  fromReservations: boolean;
  setFromReservations: Dispatch<SetStateAction<boolean>>;
  myActorHashRef: { current: string };
  planInfo: PlanInfo;
  tgUser: TgUser | null;
  isSubscribed: boolean;
  subscribing: boolean;
  handleSubscribe: (wishlistId: string) => Promise<void>;
  handleUnsubscribe: (wishlistId: string) => Promise<void>;

  // Birthday context (forwarded — banner is reused here + on public-profile)
  birthdayContext: BirthdayContext | null;
  setBirthdayContext: Dispatch<SetStateAction<BirthdayContext | null>>;
  trackBirthdayAttributedEvent: (event: string, props?: Record<string, unknown>) => void;

  // Public-profile setters (clicked from the wishlist hero)
  setPublicProfileUsername: Dispatch<SetStateAction<string | null>>;
  setPublicProfileSubscribed: Dispatch<SetStateAction<boolean>>;
  setPublicProfileError: Dispatch<SetStateAction<string | null>>;
  setPublicProfileData: Dispatch<SetStateAction<any>>;
  loadProfileSubscribeStatus: (username: string) => Promise<void>;
  loadPublicProfile: (username: string) => Promise<void>;

  // Reservation / secret / Santa state read by guest-item-detail
  reservations: ReservationItem[];
  reservationPro: boolean;
  secretReservations: Array<{ itemId: string }>;
  secretAccess: SecretAccess;
  santaReservationItems: SantaReservationItem[];
  santaWishlistReservingId: string | null;
  santaDetailContext: SantaDetailContext | null;
  setSantaDetailContext: Dispatch<SetStateAction<SantaDetailContext | null>>;
  setPendingUnreserveAction: Dispatch<SetStateAction<(() => Promise<void>) | null>>;
  setResPurchasedConfirmItem: Dispatch<SetStateAction<ReservationItem | null>>;
  setResNoteText: Dispatch<SetStateAction<string>>;
  setResNoteSheetItem: Dispatch<SetStateAction<ReservationItem | null>>;
  setResReminderSheetItem: Dispatch<SetStateAction<ReservationItem | null>>;
  handleResReminderRemove: (itemId: string) => Promise<void>;
  handleSantaReceiverReserve: (itemId: string) => void | Promise<void>;
  handleSantaReceiverUnreserve: (itemId: string) => void | Promise<void>;
  handleUnreserveSantaItem: (item: SantaReservationItem, onSuccess?: () => void) => Promise<void>;
  handleUnreserve: (item: GuestItem) => Promise<void>;
  openSantaCampaignFromDetail: (ctx: SantaDetailContext) => Promise<void>;
  openReserveSheet: (item: GuestItem) => void;
  startSecretReservationFlow: (item: Item | GuestItem) => void;

  // Comments
  commentRole: 'owner' | 'reserver' | null;
  comments: CommentDTO[];
  commentText: string;
  setCommentText: Dispatch<SetStateAction<string>>;
  commentSending: boolean;
  handleDeleteComment: (commentId: string) => Promise<void>;
  handleSendComment: () => Promise<void>;
  replyingTo: CommentDTO | null;
  setReplyingTo: Dispatch<SetStateAction<CommentDTO | null>>;
  replyEntryRef: RefObject<{ itemId: string; commentId: string; consumed: boolean } | null>;
  highlightCommentId: string | null;
  commentNodeRefs: { current: Map<string, HTMLElement | null> } | RefObject<Map<string, HTMLElement | null>>;

  // Group-gift create flow (triggered from guest-item-detail CTA)
  ggAccess: { unlocked: boolean; priceXtr: number };
  setGroupGiftData: Dispatch<SetStateAction<GroupGiftData | null>>;
  setGroupGiftCreateItemId: Dispatch<SetStateAction<string | null>>;
  setGroupGiftCreateItem: Dispatch<SetStateAction<{
    title: string; imageUrl: string | null; price: number | null; currency: string;
  } | null>>;
  setGgTargetAmt: Dispatch<SetStateAction<string>>;
  setGgDeadline: Dispatch<SetStateAction<string>>;
  setGgNote: Dispatch<SetStateAction<string>>;
  setGgMyAmount: Dispatch<SetStateAction<string>>;
  setGgCreating: Dispatch<SetStateAction<boolean>>;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface GuestViewRootProps {
  /** Active screen name; controls which sub-block renders. */
  screen: string;
  /** Bag of closure refs forwarded from MiniAppInner. See `GuestViewRootCtx`. */
  ctx: GuestViewRootCtx;
}

/**
 * Lazy-loaded Guest View cluster root.
 *
 * Destructures everything the JSX needs from `ctx` at the top, then
 * returns a fragment containing both screen blocks + the filter sheet.
 * Each block is guarded by `screen === '<name>'` exactly as in the
 * original MiniApp.tsx — keeps the JSX byte-identical.
 */
export function GuestViewRoot(props: GuestViewRootProps) {
  const { ctx, screen } = props;

  // ── Module-level constants forwarded from MiniApp.tsx ────────────────
  const {
    C, font, locale,
    DONT_GIFT_PRESET_EMOJIS, CARD_REDESIGN_ENABLED,
    PRIO_BG, PRIO_COLOR, btnBase,
    prioEmoji, fmtPrice, fmtDeadline, normalizeTitle,
    getGuestBudgetPresets, getPriorities, getSantaItemReservationState,
    resolveCardMode,
  } = ctx;

  // ── Hot-path helpers ─────────────────────────────────────────────────
  const {
    tgFetch, setScreen, pushToast: _pushToast, trackEvent,
    showUpsell, setUpsellSheet,
  } = ctx;
  void _pushToast;

  // ── Card / Comments primitives forwarded from MiniApp.tsx ────────────
  const { WishCardGuest, WishCardCompact, WishCardShowcase, CommentsThread } = ctx;

  // ── Guest-view state from useGuestViewState ──────────────────────────
  const {
    guestWl,
    guestItems: _guestItems,
    guestCategories, guestCollapsedCats, setGuestCollapsedCats,
    guestDontGift, guestDontGiftExpanded, setGuestDontGiftExpanded,
    guestUnreadItemCounts,
    guestBudgetMax, setGuestBudgetMax,
    guestCustomBudget, setGuestCustomBudget,
    guestPriorityFilter, setGuestPriorityFilter,
    guestSort, setGuestSort,
    guestFilterOpen, setGuestFilterOpen,
    draftBudget, setDraftBudget,
    draftCustomBudget, setDraftCustomBudget,
    draftPriorities, setDraftPriorities,
  } = ctx;
  void _guestItems;

  // ── Guest computed memos + top-level shared state ────────────────────
  const {
    guestMainList, guestNoPriceBlock,
    guestFiltersActive, guestFilterBadge,
    guestHasUserCategories, guestDefaultCategory,
    viewingItem, setViewingItem, setItemPhotoOpen,
    homeReturnTab, setFromReservations,
    myActorHashRef, planInfo, tgUser,
    isSubscribed, subscribing, handleSubscribe, handleUnsubscribe,
    birthdayContext, setBirthdayContext, trackBirthdayAttributedEvent,
    setPublicProfileUsername, setPublicProfileSubscribed, setPublicProfileError,
    setPublicProfileData, loadProfileSubscribeStatus, loadPublicProfile,
    reservations, reservationPro,
    secretReservations, secretAccess,
    santaReservationItems, santaWishlistReservingId,
    santaDetailContext, setSantaDetailContext, setPendingUnreserveAction,
    setResPurchasedConfirmItem, setResNoteText, setResNoteSheetItem, setResReminderSheetItem,
    handleResReminderRemove, handleSantaReceiverReserve, handleSantaReceiverUnreserve,
    handleUnreserveSantaItem, handleUnreserve,
    openSantaCampaignFromDetail, openReserveSheet, startSecretReservationFlow,
    commentRole, comments, commentText, setCommentText, commentSending,
    handleDeleteComment, handleSendComment,
    replyingTo, setReplyingTo, replyEntryRef,
    highlightCommentId, commentNodeRefs,
    ggAccess, setGroupGiftData,
    setGroupGiftCreateItemId, setGroupGiftCreateItem,
    setGgTargetAmt, setGgDeadline, setGgNote, setGgMyAmount, setGgCreating,
  } = ctx;

  return (
    <>
      {/* ══════════════════════════════════════════════
          GUEST ITEM DETAIL
          ══════════════════════════════════════════════ */}
      {screen === 'guest-item-detail' && viewingItem && (
        <div style={{ padding: '0 0 140px', minHeight: 'calc(100vh + 1px)' }}>
          {/* Hero image */}
          <div style={{ padding: '16px 16px 0' }}>
            {viewingItem.imageUrl ? (
              <img
                src={viewingItem.imageUrl}
                alt=""
                decoding="async"
                onClick={() => setItemPhotoOpen(true)}
                style={{ width: '100%', height: 230, objectFit: 'cover', borderRadius: 20, display: 'block', background: C.surface, cursor: 'pointer', WebkitTapHighlightColor: 'transparent' }}
              />
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
                background: 'rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.08)', border: '1px solid rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.2)',
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
              <div style={{ marginTop: 0, maxWidth: '100%' }}>
                <a href={viewingItem.url} target="_blank" rel="noreferrer" style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13,
                  color: C.accent, background: C.accentSoft, padding: '8px 14px',
                  borderRadius: 12, textDecoration: 'none',
                  maxWidth: '100%', overflow: 'hidden',
                }}>
                  <span style={{ flexShrink: 0 }}>🔗</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {viewingItem.url.replace(/^https?:\/\//, '')}
                  </span>
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
                          border: '1px solid rgba(251, 113, 133, 0.3)', borderRadius: 14,
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
                        <Button
                          variant="primary"
                          size="lg"
                          loading={isReserving}
                          disabled={isReserving}
                          onClick={() => rState === 'reserved-by-me'
                            ? void handleSantaReceiverUnreserve(viewingItem.id)
                            : void handleSantaReceiverReserve(viewingItem.id)}
                        >
                          {rState === 'reserved-by-me' ? t('cancel_reservation', locale) : t('reserve_btn', locale)}
                        </Button>
                      )}
                    </>
                  );
                }
              })() : (
                <>
                  {viewingItem.status === 'available' && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, width: '100%' }}>
                      <Button
                        variant="primary"
                        size="lg"
                        onClick={() => openReserveSheet(viewingItem as GuestItem)}
                      >
                        {t('reserve_btn', locale)}
                      </Button>
                      {/* 🔒 Secret reservation CTA — directly under the primary "Reserve" for a cleaner stack */}
                      {(() => {
                        const existing = secretReservations.find((r) => r.itemId === viewingItem.id);
                        const label = existing ? t('sr_cta_open_secret', locale) : t('sr_cta_reserve_secretly', locale);
                        return (
                          <button
                            onClick={() => startSecretReservationFlow(viewingItem)}
                            style={{
                              width: '100%', padding: '14px 24px', borderRadius: 16,
                              border: '1px solid rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.22)',
                              background: 'rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.12)', color: 'var(--wb-accent-strong, #B4A6FF)',
                              fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: font,
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                            }}
                          >
                            {label}
                            {!existing && !secretAccess.unlocked && planInfo.code === 'FREE' && (
                              <ProBadge style={{ marginLeft: 4, padding: '2px 7px', height: 'auto', minHeight: 0 }} />
                            )}
                          </button>
                        );
                      })()}
                      <Button
                        variant="secondary"
                        size="md"
                        style={{ borderRadius: 16 }}
                        onClick={() => {
                          trackEvent('group_gift_cta_clicked', { itemId: viewingItem.id });
                          // Check entitlement first
                          void (async () => {
                            try {
                              const r = await tgFetch('/tg/items/' + viewingItem.id + '/group-gift', { method: 'GET' });
                              if (r.ok) {
                                const d = await r.json() as { hasGroupGift: boolean; groupGift?: GroupGiftData };
                                if (d.hasGroupGift && d.groupGift?.id) {
                                  setGroupGiftData(d.groupGift as GroupGiftData);
                                  setScreen('group-gift-detail');
                                  return;
                                }
                              }
                            } catch { /* ignore */ }
                            // No existing group gift — check entitlement
                            if (ggAccess.unlocked) {
                              setGroupGiftCreateItemId(viewingItem.id);
                              setGroupGiftCreateItem({
                                title: viewingItem.title,
                                imageUrl: viewingItem.imageUrl ?? null,
                                price: viewingItem.price ?? null,
                                currency: (viewingItem as GuestItem).currency ?? 'RUB',
                              });
                              setGgTargetAmt(viewingItem.price ? String(viewingItem.price) : '');
                              setGgDeadline(''); setGgNote(''); setGgMyAmount(''); setGgCreating(false);
                              setScreen('group-gift-create');
                            } else {
                              setScreen('group-gift-paywall');
                            }
                          })();
                        }}
                      >
                        {'👥 ' + t('gg_cta', locale)}
                      </Button>
                      <div style={{ fontSize: 12, color: C.textMuted, textAlign: 'center', lineHeight: 1.4, padding: '0 8px' }}>
                        {t('gg_cta_hint', locale)}
                      </div>
                    </div>
                  )}
                  {viewingItem.status === 'reserved' && !!myActorHashRef.current && (viewingItem as GuestItem).reservedByActorHash === myActorHashRef.current && (
                    <>
                      <span style={{ display: 'inline-block', padding: '10px 16px', borderRadius: 12, background: C.greenSoft, color: C.green, fontSize: 14, fontWeight: 600 }}>
                        {t('reserved_by_me', locale)}
                      </span>
                      {/* Unreserve button only when NOT from reservations tab (Pro sections handle it) */}
                      {homeReturnTab !== 'reservations' && (
                        <button onClick={() => setPendingUnreserveAction(() => () => handleUnreserve(viewingItem as GuestItem))}
                          style={{
                            ...btnBase, width: '100%', background: C.redSoft, color: C.red,
                            border: `1px solid rgba(251, 113, 133, 0.3)`, borderRadius: 14,
                            padding: '12px 16px', fontSize: 14, fontWeight: 500,
                          }}>
                          {t('cancel_reservation', locale)}
                        </button>
                      )}
                    </>
                  )}
                  {viewingItem.status === 'reserved' && !(!!myActorHashRef.current && (viewingItem as GuestItem).reservedByActorHash === myActorHashRef.current) && (
                    <>
                      <span style={{ display: 'inline-block', padding: '10px 16px', borderRadius: 12, background: C.orangeSoft, color: C.orange, fontSize: 14, fontWeight: 600 }}>
                        {t('already_reserved', locale)}
                      </span>
                      {/* 🔒 Secret reservation still available even when publicly reserved by someone else */}
                      {(() => {
                        const existing = secretReservations.find((r) => r.itemId === viewingItem.id);
                        const label = existing ? t('sr_cta_open_secret', locale) : t('sr_cta_save_secret_still', locale);
                        return (
                          <button
                            onClick={() => startSecretReservationFlow(viewingItem)}
                            style={{
                              width: '100%', padding: '14px 24px', borderRadius: 16,
                              border: '1px solid rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.22)',
                              background: 'rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.12)', color: 'var(--wb-accent-strong, #B4A6FF)',
                              fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: font,
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                            }}
                          >
                            {label}
                            {!existing && !secretAccess.unlocked && planInfo.code === 'FREE' && (
                              <ProBadge style={{ marginLeft: 4, padding: '2px 7px', height: 'auto', minHeight: 0 }} />
                            )}
                          </button>
                        );
                      })()}
                      <div style={{ fontSize: 12, color: C.textMuted, textAlign: 'center', lineHeight: 1.4, padding: '0 8px' }}>
                        {t('sr_cta_save_secret_hint', locale)}
                      </div>
                    </>
                  )}
                  {viewingItem.status === 'purchased' && (
                    <span style={{ display: 'inline-block', padding: '10px 16px', borderRadius: 12, background: C.greenSoft, color: C.green, fontSize: 14, fontWeight: 600 }}>
                      {t('status_gifted', locale)}
                    </span>
                  )}
                </>
              )}
            </div>

            {/* ── Reservation Pro: detail management ── */}
            {viewingItem.status === 'reserved' && !!myActorHashRef.current && (viewingItem as GuestItem).reservedByActorHash === myActorHashRef.current && homeReturnTab === 'reservations' && (() => {
              const resItem = reservations.find(r => r.id === viewingItem.id);
              if (!resItem) return null;
              const sectionLabel: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 10 };

              if (reservationPro) {
                const reminderDate = resItem.meta?.reminderAt ? new Date(resItem.meta.reminderAt) : null;
                const daysUntilReminder = reminderDate ? Math.max(0, Math.ceil((reminderDate.getTime() - Date.now()) / 86400000)) : null;
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                    {/* Separator */}
                    <div style={{ borderTop: `1px solid ${C.border}`, margin: '20px 0 16px' }} />

                    {/* Status section */}
                    <div style={sectionLabel}>{t('res_detail_status_label', locale)}</div>
                    <Card
                      variant="current"
                      padding="sm"
                      onClick={() => setResPurchasedConfirmItem(resItem)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 10,
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{ fontSize: 20 }}>✓</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: C.accent }}>{t('res_mark_purchased', locale)}</div>
                        <div style={{ fontSize: 12, color: C.textSec }}>{t('res_detail_purchased_subtitle', locale)}</div>
                      </div>
                      {/* iOS-style toggle */}
                      <div style={{
                        width: 44, height: 26, borderRadius: 13, cursor: 'pointer', position: 'relative',
                        background: resItem.meta?.purchased ? C.accent : C.surface,
                        transition: 'background 0.2s',
                      }}>
                        <div style={{
                          width: 22, height: 22, borderRadius: 11, background: '#fff',
                          position: 'absolute', top: 2,
                          left: resItem.meta?.purchased ? 20 : 2,
                          transition: 'left 0.2s',
                          boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                        }} />
                      </div>
                    </Card>

                    {/* Note section */}
                    <div style={{ ...sectionLabel, marginTop: 18 }}>{t('res_detail_note_label', locale)}</div>
                    <div style={{
                      background: C.card, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12,
                    }}>
                      <div style={{ fontSize: 14, color: resItem.meta?.note ? C.text : C.textMuted, lineHeight: 1.5, marginBottom: 6 }}>
                        {resItem.meta?.note || t('res_detail_note_empty', locale)}
                      </div>
                      <div style={{ textAlign: 'right' }}>
                        <span
                          onClick={() => { setResNoteText(resItem.meta?.note ?? ''); setResNoteSheetItem(resItem); }}
                          style={{ fontSize: 12, color: C.accent, cursor: 'pointer' }}
                        >
                          {t('res_detail_note_edit', locale)}
                        </span>
                      </div>
                    </div>

                    {/* Reminder section */}
                    <div style={{ ...sectionLabel, marginTop: 22 }}>{t('res_detail_reminder_label', locale)}</div>
                    {reminderDate ? (
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '14px 16px', borderRadius: 14,
                        background: C.orangeSoft, border: '1px solid rgba(251,191,36,0.2)',
                      }}>
                        <span style={{ fontSize: 20 }}>🔔</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 14, fontWeight: 700, color: C.orange }}>
                            {reminderDate.toLocaleDateString(localeToBCP47(locale), { day: 'numeric', month: 'long' })}
                            {t('datetime_separator_at', locale)}
                            {reminderDate.toLocaleTimeString(localeToBCP47(locale), { hour: '2-digit', minute: '2-digit' }).replace(/^0/, '')}
                          </div>
                          <div style={{ fontSize: 12, color: C.textSec, marginTop: 2 }}>
                            {daysUntilReminder !== null && daysUntilReminder > 0
                              ? t('res_detail_reminder_in_days', locale, { n: daysUntilReminder })
                              : t('gn_today', locale)}
                          </div>
                        </div>
                        <span
                          onClick={(e) => { e.stopPropagation(); handleResReminderRemove(resItem.id); }}
                          style={{ fontSize: 18, color: C.textSec, cursor: 'pointer', padding: '8px 10px', lineHeight: 1 }}
                        >
                          ✕
                        </span>
                      </div>
                    ) : (
                      <div
                        onClick={() => setResReminderSheetItem(resItem)}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 12,
                          padding: '14px 16px', borderRadius: 14, cursor: 'pointer',
                          background: C.card, border: `1px solid ${C.border}`,
                        }}
                      >
                        <span style={{ fontSize: 20 }}>🔔</span>
                        <div style={{ flex: 1, fontSize: 14, color: C.textSec }}>{t('res_reminder_btn', locale)}</div>
                        <span style={{ fontSize: 14, color: C.textMuted }}>›</span>
                      </div>
                    )}

                  </div>
                );
              } else {
                return (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
                    {/* Separator */}
                    <div style={{ borderTop: `1px solid ${C.border}`, margin: '20px 0 16px' }} />

                    {/* Locked items */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: '0 0 16px' }}>
                      {[
                        { icon: '📝', label: t('res_detail_note_label', locale) },
                        { icon: '✓', label: t('res_mark_purchased', locale) },
                        { icon: '🔔', label: t('res_detail_reminder_label', locale) },
                      ].map((item, i) => (
                        <div
                          key={i}
                          onClick={() => setUpsellSheet({ context: 'reservation_pro' })}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10,
                            padding: 12, borderRadius: 12, cursor: 'pointer',
                            border: `1px dashed ${C.borderLight}`, opacity: 0.6,
                            background: 'rgba(255,255,255,0.02)',
                          }}
                        >
                          <span style={{ fontSize: 18 }}>{item.icon}</span>
                          <div style={{ flex: 1, fontSize: 13, fontWeight: 600, color: C.textSec }}>{item.label}</div>
                          <ProBadge />
                        </div>
                      ))}
                    </div>

                    {/* Inline upsell */}
                    <div
                      onClick={() => setUpsellSheet({ context: 'reservation_pro' })}
                      style={{
                        margin: '0 0 16px', padding: '12px 16px', borderRadius: 12, cursor: 'pointer', textAlign: 'center',
                        background: `linear-gradient(135deg, ${C.accentSoft} 0%, rgba(212,168,83,0.06) 100%)`,
                        border: `1px solid rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.15)`,
                      }}
                    >
                      <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>{t('res_pro_upsell_detail_title', locale)}</div>
                      <div style={{ fontSize: 12, color: C.textSec, marginTop: 2 }}>{t('res_pro_upsell_detail_desc', locale)}</div>
                      <div style={{
                        display: 'inline-block', marginTop: 8, fontSize: 12, padding: '8px 16px',
                        borderRadius: 10, background: C.accent, color: '#fff', fontWeight: 700, cursor: 'pointer',
                      }}>
                        ⭐ Pro
                      </div>
                    </div>

                  </div>
                );
              }
            })()}

            {/* Comments — collapsible accordion */}
            <CommentsThread
              key={`res-${viewingItem.id}`}
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
              replyingTo={replyingTo}
              onStartReply={(c: CommentDTO) => {
                setReplyingTo(c);
                trackEvent('comment_reply_ui_tapped', { source: 'bubble', itemId: viewingItem.id, commentId: c.id });
              }}
              onCancelReply={() => {
                if (replyingTo) trackEvent('comment_reply_cancelled', { itemId: viewingItem.id, commentId: replyingTo.id, reason: 'user_cancel' });
                setReplyingTo(null);
              }}
              expandInitially={replyEntryRef.current?.itemId === viewingItem.id && !replyEntryRef.current?.consumed}
              highlightCommentId={highlightCommentId}
              commentNodeRefs={commentNodeRefs}
            />

            {/* Hint for third parties — hidden on guest-item-detail (gg_cta_hint already provides guidance) */}

            {/* Unreserve button — at the very bottom, below comments */}
            {viewingItem.status === 'reserved' && !!myActorHashRef.current && (viewingItem as GuestItem).reservedByActorHash === myActorHashRef.current && homeReturnTab === 'reservations' && (
              <button
                onClick={() => setPendingUnreserveAction(() => () => handleUnreserve(viewingItem as GuestItem))}
                style={{
                  ...btnBase, width: '100%', background: C.redSoft, color: C.red,
                  border: 'none', borderRadius: 14, marginTop: 16,
                  padding: '15px 18px', fontSize: 15, fontWeight: 700,
                }}
              >
                {t('cancel_reservation', locale)}
              </button>
            )}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════
          GUEST VIEW — public wishlist preview
          ══════════════════════════════════════════════ */}
      {screen === 'guest-view' && guestWl && (
        <div style={{ padding: '16px 20px 120px' }}>
          {/* ── Birthday context banner — shown when arriving from a friend
              birthday reminder. Offers wishlist-scoped CTAs.
              Banner is dismissible per-session (not persisted). */}
          {birthdayContext && !birthdayContext.isOwner && !birthdayContext.bannerDismissed && (() => {
            const ctx = birthdayContext;
            const days = ctx.daysUntil ?? 0;
            const isToday = days === 0 || ctx.reminderKind === 'friend_today';
            const name = ctx.birthdayUser.displayName || ctx.birthdayUser.username || 'WishBoard';
            const dayWord = pluralize(
              days,
              t('br_days_word_one', locale),
              t('br_days_word_few', locale),
              t('br_days_word_many', locale),
              locale,
            );
            // Fire banner_seen once per delivery; don't refire on re-renders.
            // Local one-shot via dataset on the wrapper div.
            return (
              <div
                style={{ marginBottom: 14 }}
                ref={(el) => {
                  if (el && !el.dataset.seen) {
                    el.dataset.seen = '1';
                    trackBirthdayAttributedEvent('birthday.banner_seen', { kind: ctx.reminderKind, target: 'wishlist' });
                  }
                }}
              >
                <Banner
                  tone={isToday ? 'warning' : 'info'}
                  icon={<span>{isToday ? '🎉' : '🎂'}</span>}
                  title={isToday
                    ? t('br_banner_friend_today_title', locale)
                    : t('br_banner_friend_title', locale, { name })}
                  onClose={() => {
                    setBirthdayContext((prev) => prev ? { ...prev, bannerDismissed: true } : prev);
                    trackBirthdayAttributedEvent('birthday.banner_dismissed', { kind: ctx.reminderKind });
                  }}
                >
                  {isToday
                    ? t('br_banner_friend_today_desc', locale, { name })
                    : (ctx.targetUnavailable
                        ? `${t('br_banner_target_unavailable_title', locale)}. ${t('br_banner_target_unavailable_desc', locale)}`
                        : `${t('br_banner_friend_desc', locale)}${days > 0 ? ` · ${days} ${dayWord}` : ''}`)}
                </Banner>
              </div>
            );
          })()}

          {/* ── v2.1 HeroCard — wishlist hero with emoji + meta + 3-stat row ──
              Replaces the legacy owner-Card.current. Owner identity carried
              in subtitle text + click-through; subscribe action moves below.
              Source: docs/design-system/mockups/approved/v2.1-refresh-all-screens.html
              (WishlistDetailScreen → .wb-hero) */}
          {(() => {
            const ownerClickable = !!guestWl.ownerUsername;
            const openOwnerProfile = () => {
              const uname = guestWl.ownerUsername;
              if (!uname) return;
              setPublicProfileUsername(uname);
              setPublicProfileSubscribed(false);
              setPublicProfileError(null);
              setPublicProfileData(null);
              void loadProfileSubscribeStatus(uname);
              void loadPublicProfile(uname);
              setScreen('public-profile');
              window.scrollTo(0, 0);
              trackEvent('profile_open_from_guest_view', { username: uname });
            };
            const totalCount = guestMainList.length + guestNoPriceBlock.length;
            const allGuestItems = [...guestMainList, ...guestNoPriceBlock];
            const reservedCount = allGuestItems.filter(it => it.status === 'reserved' || it.status === 'purchased').length;
            const subParts: string[] = [];
            if (guestWl.ownerName) subParts.push(guestWl.ownerName);
            if (guestWl.deadline) {
              const d = fmtDeadline(guestWl.deadline);
              if (d) subParts.push(d);
            }
            return (
              <div style={{ marginBottom: 14 }}>
                <HeroCard tone="accent">
                  <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
                    <div style={{ fontSize: 44, lineHeight: 1, filter: 'drop-shadow(0 4px 10px rgba(0,0,0,0.2))', flexShrink: 0 }}>
                      {getEmoji(guestWl.title) ?? '🎁'}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        onClick={ownerClickable ? openOwnerProfile : undefined}
                        style={{
                          fontSize: 26, fontWeight: 700, color: '#fff',
                          letterSpacing: '-0.035em', lineHeight: 1.05,
                          cursor: ownerClickable ? 'pointer' : 'default',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}
                      >
                        {guestWl.title}
                      </div>
                      {subParts.length > 0 && (
                        <div
                          onClick={ownerClickable ? openOwnerProfile : undefined}
                          style={{
                            fontSize: 13, opacity: 0.85, marginTop: 4,
                            letterSpacing: '-0.005em',
                            cursor: ownerClickable ? 'pointer' : 'default',
                          }}
                        >
                          {subParts.join(' · ')}
                          {ownerClickable && guestWl.ownerName ? ' ›' : ''}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Stat row — total + reserved. Participants/avatar stack
                      deferred until backend exposes per-wishlist contributors. */}
                  {totalCount > 0 && (
                    <div style={{ display: 'flex', gap: 18, marginTop: 18 }}>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.03em', fontFeatureSettings: '"tnum"' }}>
                          {totalCount}
                        </div>
                        <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>
                          {pluralize(totalCount, t('wishes_one', locale), t('wishes_few', locale), t('wishes_many', locale), locale)}
                        </div>
                      </div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-0.03em', fontFeatureSettings: '"tnum"' }}>
                          {reservedCount}
                        </div>
                        <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>
                          забронировано
                        </div>
                      </div>
                    </div>
                  )}
                </HeroCard>

                {/* Subscribe row — moved out of hero for v2.1 cleaner composition */}
                {tgUser && (
                  <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
                    <button
                      key={isSubscribed ? 'subscribed' : 'not-subscribed'}
                      onClick={() => {
                        if (isSubscribed) void handleUnsubscribe(guestWl.id);
                        else void handleSubscribe(guestWl.id);
                      }}
                      disabled={subscribing}
                      style={{
                        padding: '10px 16px', borderRadius: 100, border: '1px solid',
                        borderColor: isSubscribed ? 'var(--wb-border)' : 'var(--wb-accent-soft-strong)',
                        cursor: 'pointer', fontFamily: font, fontSize: 13, fontWeight: 650,
                        background: isSubscribed ? 'var(--wb-card)' : 'var(--wb-accent-soft)',
                        color: isSubscribed ? 'var(--wb-text-secondary)' : 'var(--wb-accent-strong)',
                        WebkitBackdropFilter: 'blur(14px)' as never,
                        backdropFilter: 'blur(14px)' as never,
                        opacity: subscribing ? 0.7 : 1,
                        transition: 'all 0.18s cubic-bezier(0.4, 0, 0.2, 1)',
                      }}
                    >
                      {isSubscribed ? `✓ ${t('sub_subscribed_btn', locale)}` : `+ ${t('sub_subscribe_btn', locale)}`}
                    </button>
                  </div>
                )}

                {guestWl.description && (
                  <div style={{ fontSize: 13, color: 'var(--wb-text-secondary)', marginTop: 10, padding: '0 4px', lineHeight: 1.4 }}>
                    {guestWl.description}
                  </div>
                )}
              </div>
            );
          })()}

          {/* ── Don't Gift block (guest view) ─────────────────────────── */}
          {guestDontGift && (guestDontGift.presets.length > 0 || guestDontGift.customItems.length > 0 || guestDontGift.comment) && (
            <>
              <div
                onClick={() => {
                  if (!guestDontGiftExpanded) trackEvent('dont_gift_guest_expanded');
                  setGuestDontGiftExpanded(!guestDontGiftExpanded);
                }}
                style={{
                  background: C.card, borderRadius: 16, padding: '14px 18px',
                  marginBottom: 4, cursor: 'pointer',
                  border: `1px solid rgba(251, 113, 133, 0.12)`,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 16 }}>🚫</span>
                    <span style={{ fontSize: 15, fontWeight: 600, color: C.text, fontFamily: font }}>
                      {t('dont_gift_guest_title', locale)}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {!guestDontGiftExpanded && (
                      <span style={{ fontSize: 12, color: C.textMuted }}>
                        {guestDontGift.presets.length + guestDontGift.customItems.length + (guestDontGift.comment ? 1 : 0)}
                      </span>
                    )}
                    <span style={{
                      fontSize: 12, color: C.textMuted, transition: 'transform 0.2s',
                      transform: guestDontGiftExpanded ? 'rotate(0deg)' : 'rotate(-90deg)',
                      display: 'inline-block',
                    }}>▼</span>
                  </div>
                </div>
                {guestDontGiftExpanded && (
                  <div style={{ marginTop: 12 }}>
                    {guestDontGift.presets.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
                        {guestDontGift.presets.map(p => (
                          <span key={p} style={{
                            padding: '5px 12px', borderRadius: 20, fontSize: 13, fontWeight: 500,
                            background: C.redSoft, color: C.red, fontFamily: font,
                          }}>
                            {DONT_GIFT_PRESET_EMOJIS[p] ?? ''} {t(('dont_gift_preset_' + p) as any, locale)}
                          </span>
                        ))}
                      </div>
                    )}
                    {guestDontGift.customItems.length > 0 && (
                      <div style={{ marginBottom: 8 }}>
                        {guestDontGift.customItems.map((item, i) => (
                          <div key={i} style={{ fontSize: 13, color: C.textSec, padding: '3px 0', lineHeight: 1.4 }}>
                            • {item}
                          </div>
                        ))}
                      </div>
                    )}
                    {guestDontGift.comment && (
                      <div style={{
                        fontSize: 13, color: C.textMuted, lineHeight: 1.5,
                        paddingTop: 8, borderTop: `1px solid ${C.border}`,
                      }}>
                        {guestDontGift.comment}
                      </div>
                    )}
                  </div>
                )}
              </div>
              {/* Separator */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '8px 0 14px' }}>
                <div style={{ flex: 1, height: 1, background: C.borderLight }} />
                <span style={{ fontSize: 13, color: C.textMuted, fontWeight: 600, whiteSpace: 'nowrap', fontFamily: font }}>
                  🎁 {t('dont_gift_guest_separator', locale)}
                </span>
                <div style={{ flex: 1, height: 1, background: C.borderLight }} />
              </div>
            </>
          )}

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
                <Button
                  variant="secondary"
                  size="sm"
                  fullWidth={false}
                  style={{ padding: '10px 20px', fontSize: 14, minHeight: 0, marginTop: 12 }}
                  onClick={() => { setGuestBudgetMax(null); setGuestCustomBudget(''); setGuestPriorityFilter([1, 2, 3]); }}
                >
                  {t('guest_filter_reset', locale)}
                </Button>
              )}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {(() => {
                // Shared guest card renderer
                const renderGuestCard = (item: GuestItem, i: number, totalItems: number) => {
                  const itemUnreadCount = guestUnreadItemCounts[item.id] ?? 0;
                  const hasSecret = secretReservations.some((r) => r.itemId === item.id);
                  const useNewCards = CARD_REDESIGN_ENABLED;
                  if (useNewCards) {
                    const cardMode = resolveCardMode(totalItems, undefined, false);
                    const stagger = cardMode === 'compact' ? 0.04 : 0.08;
                    const gap = cardMode === 'compact' ? 8 : 14;
                    const CardComp = cardMode === 'showcase' ? WishCardShowcase : WishCardCompact;
                    return (
                      <div key={item.id} style={{ animation: `fadeIn 0.3s ease ${i * stagger}s both`, marginBottom: gap, position: 'relative', ...(itemUnreadCount > 0 ? { border: `1px solid rgba(251,191,36,0.25)`, borderRadius: 16 } : {}) }}>
                        <CardComp
                          item={item}
                          isGuest
                          onTap={(it: GuestItem) => { setViewingItem(it); setScreen('guest-item-detail'); }}
                          onReserve={(w: GuestItem) => openReserveSheet(w)}
                          onUnreserve={handleUnreserve}
                          myActorHash={myActorHashRef.current}
                          locale={locale}
                          secretByMe={hasSecret}
                        />
                        <CounterBadge count={itemUnreadCount} tone="warning" style={{ zIndex: 10, minWidth: 22, height: 22 }} />
                      </div>
                    );
                  }
                  return (
                    <div key={item.id} style={{ animation: `fadeIn 0.3s ease ${i * 0.06}s both`, position: 'relative', ...(itemUnreadCount > 0 ? { border: `1px solid rgba(251,191,36,0.25)`, borderRadius: 16 } : {}) }}>
                      <WishCardGuest
                        item={item}
                        onTap={(it: GuestItem) => { setViewingItem(it); setScreen('guest-item-detail'); }}
                        onReserve={(w: GuestItem) => openReserveSheet(w)}
                        onUnreserve={handleUnreserve}
                        myActorHash={myActorHashRef.current}
                        locale={locale}
                        secretByMe={hasSecret}
                      />
                      {itemUnreadCount > 0 && (
                        <CounterBadge count={itemUnreadCount} tone="warning" style={{ top: 6, right: 6, zIndex: 10, minWidth: 22, height: 22 }} />
                      )}
                    </div>
                  );
                };

                // If guest wishlist has user-created categories, render grouped
                if (guestHasUserCategories) {
                  const sortedCats = [...guestCategories].sort((a, b) => a.sortOrder - b.sortOrder);
                  let gIdx = 0;
                  const allItems = [...guestMainList, ...guestNoPriceBlock];
                  return sortedCats.map(cat => {
                    const catItems = guestMainList.filter(it => {
                      const cid = it.categoryId ?? guestDefaultCategory?.id ?? '';
                      return cid === cat.id;
                    });
                    if (cat.isDefault && catItems.length === 0) return null;
                    const isCollapsed = guestCollapsedCats.has(cat.id);
                    return (
                      <div key={cat.id} style={{ marginBottom: 8 }}>
                        <div
                          style={{
                            display: 'flex', alignItems: 'center', gap: 8,
                            padding: '6px 2px 4px', cursor: 'pointer', userSelect: 'none',
                          }}
                          onClick={() => setGuestCollapsedCats(prev => {
                            const next = new Set(prev);
                            if (next.has(cat.id)) next.delete(cat.id); else next.add(cat.id);
                            return next;
                          })}
                        >
                          <span style={{
                            fontSize: 12, color: C.textMuted, transition: 'transform 0.2s',
                            transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
                            display: 'inline-block',
                          }}>▼</span>
                          <span style={{
                            fontSize: 14, fontWeight: 700, color: C.text, fontFamily: font,
                            flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {cat.isDefault ? t('cat_uncategorized', locale) : cat.name}
                          </span>
                          <span style={{ fontSize: 12, color: C.textMuted, fontWeight: 600, flexShrink: 0 }}>
                            {catItems.length}
                          </span>
                        </div>
                        {!isCollapsed && catItems.map(item => {
                          const idx = gIdx++;
                          return renderGuestCard(item, idx, allItems.length);
                        })}
                        {isCollapsed && (gIdx += catItems.length, null)}
                      </div>
                    );
                  });
                }

                // Flat list (no user categories)
                return guestMainList.map((item, i) => renderGuestCard(item, i, [...guestMainList, ...guestNoPriceBlock].length));
              })()}

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
                    {guestNoPriceBlock.map((item, i) => {
                      const itemUnreadCount = guestUnreadItemCounts[item.id] ?? 0;
                      const useNewCards = CARD_REDESIGN_ENABLED;
                      if (useNewCards) {
                        const CardComp = WishCardCompact;
                        return (
                          <div key={item.id} style={{ animation: `fadeIn 0.3s ease ${i * 0.04}s both`, marginBottom: 8, position: 'relative', ...(itemUnreadCount > 0 ? { border: `1px solid rgba(251,191,36,0.25)`, borderRadius: 16 } : {}) }}>
                            <CardComp
                              item={item}
                              isGuest
                              onTap={(it: GuestItem) => { setViewingItem(it); setScreen('guest-item-detail'); }}
                              onReserve={(w: GuestItem) => openReserveSheet(w)}
                              onUnreserve={handleUnreserve}
                              myActorHash={myActorHashRef.current}
                              locale={locale}
                            />
                            {itemUnreadCount > 0 && (
                              <CounterBadge count={itemUnreadCount} tone="warning" style={{ zIndex: 10, minWidth: 22, height: 22 }} />
                            )}
                          </div>
                        );
                      }
                      return (
                        <div key={item.id} style={{ animation: `fadeIn 0.3s ease ${i * 0.06}s both`, position: 'relative', ...(itemUnreadCount > 0 ? { border: `1px solid rgba(251,191,36,0.25)`, borderRadius: 16 } : {}) }}>
                          <WishCardGuest
                            item={item}
                            onTap={(it: GuestItem) => { setViewingItem(it); setScreen('guest-item-detail'); }}
                            onReserve={(w: GuestItem) => openReserveSheet(w)}
                            onUnreserve={handleUnreserve}
                            myActorHash={myActorHashRef.current}
                            locale={locale}
                          />
                          {itemUnreadCount > 0 && (
                            <CounterBadge count={itemUnreadCount} tone="warning" style={{ zIndex: 10, minWidth: 22, height: 22 }} />
                          )}
                        </div>
                      );
                    })}
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
            <Button
              variant="secondary"
              style={{ flex: 1, padding: '13px', fontSize: 14 }}
              onClick={() => {
                setDraftBudget(null); setDraftCustomBudget(''); setDraftPriorities([1, 2, 3]);
              }}
            >
              {t('filter_reset', locale)}
            </Button>
            <Button
              variant="primary"
              style={{ flex: 2, padding: '13px', fontSize: 14 }}
              onClick={() => {
                setGuestBudgetMax(draftBudget);
                setGuestCustomBudget(draftCustomBudget);
                setGuestPriorityFilter(draftPriorities);
                setGuestFilterOpen(false);
              }}
            >
              {t('filter_apply', locale)}
            </Button>
          </div>
        </div>
      </BottomSheet>

    </>
  );
}
