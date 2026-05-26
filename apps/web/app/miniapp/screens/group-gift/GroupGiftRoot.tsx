// GroupGiftRoot — F4 Wave D-3 cluster file (REFACTOR_MINIAPP_TSX_PLAN).
//
// Bundles the 5 Group Gift screens (~960 LOC of JSX) into a single
// lazy-loaded module. Loaded via `next/dynamic({ ssr: false })` from
// `apps/web/app/miniapp/MiniApp.tsx`, so the chunk doesn't ship with the
// initial Mini App page bundle — group-gift code only downloads when a
// user navigates to a group-gift-* screen (cold path: only reached via
// item detail → "create group gift" CTA or deep-link join token).
//
// State source: `useGroupGiftState` is invoked exactly once in
// MiniAppInner and the 18 returned fields are forwarded through `ctx`.
// The setters flow back into the same React state tree — no duplicate
// state.
//
// Sub-screens (selected by `ctx.screen`):
//   1. group-gift-paywall — feature-gate before unlock (Stars price)
//   2. group-gift-create  — organizer create form (target, deadline, note, my-amount)
//   3. group-gift-detail  — overview: progress, participants, actions
//   4. group-gift-join    — invitee join form (amount-only)
//   5. group-gift-chat    — campaign chat (messages + send input)
//
// Implementation discipline:
// - JSX is copied verbatim from MiniApp.tsx — DO NOT migrate styles or
//   refactor logic in this PR. Bundle savings only; cosmetic changes
//   ride future on-touch PRs.
// - `ctx` types intersect `GroupGiftState` (setters keep
//   `Dispatch<SetStateAction<T>>` signatures) with the loose helpers bag.

'use client';

import React from 'react';
import { Banner, Button, Card, Chip } from '@wishlist/ui';
import { t, localeToBCP47, type Locale } from '@wishlist/shared';
import { UserAvatar } from '../../components/UserAvatar';
import { parsePaywallError } from '../../lib/paywall';
import { resolveReservePrefill } from '../../lib/reservePrefill';
import type { Dispatch, SetStateAction } from 'react';
import type { GroupGiftState, GroupGiftData } from '../../hooks/useGroupGiftState';
import type { GuestItem, Item, TgUser } from '../../MiniApp';
import type {
  LegacyColorBag, NavBack, PushToast, SetScreen,
  ShowUpsell, TgFetch, TrackEvent,
} from '../../_shared/closure-types';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type GroupGiftRootCtx = GroupGiftState & {
  // module-level constants
  C: LegacyColorBag;
  font: string;
  locale: Locale;
  inputStyle: React.CSSProperties;
  // helpers from MiniAppInner closure — real signatures from
  // `_shared/closure-types`.
  tgFetch: TgFetch;
  setScreen: SetScreen;
  navBack: NavBack;
  pushToast: PushToast;
  trackEvent: TrackEvent;
  showUpsell: ShowUpsell;
  // domain helpers (defined in MiniAppInner — useCallback).
  buildTgDeepLink: (payload?: string) => string | null;
  handleBuyAddon: (skuCode: string, targetId?: string) => Promise<void>;
  setGuestItems: Dispatch<SetStateAction<GuestItem[]>>;
  // misc shared state read by Group Gift. viewingItem matches the
  // canonical `useState<(Item | GuestItem) | null>(null)`. profileData
  // stays loose because its useState is an inline anonymous shape.
  viewingItem: (Item | GuestItem) | null;
  profileData: any;
  tgUser: TgUser | null;
  addonCheckoutLoading: boolean;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface GroupGiftRootProps {
  /** Active group-gift-* screen name; controls which sub-block renders. */
  screen: string;
  /** Bag of closure refs forwarded from MiniAppInner. See `GroupGiftRootCtx`. */
  ctx: GroupGiftRootCtx;
}

/**
 * Lazy-loaded Group Gift cluster root.
 *
 * Destructures everything the JSX needs from `ctx` at the top, then
 * returns a fragment containing the 5 inline screen blocks. Each block
 * is guarded by a `screen === '<name>'` check exactly as in the original
 * MiniApp.tsx — keeps the JSX byte-identical.
 */
export function GroupGiftRoot(props: GroupGiftRootProps) {
  const { ctx, screen } = props;

  // ── Module-level constants forwarded from MiniApp.tsx ────────────────
  const { C, font, locale, inputStyle } = ctx;

  // ── Helpers from MiniAppInner closure ────────────────────────────────
  const {
    tgFetch, setScreen, navBack, pushToast, trackEvent,
    showUpsell: _showUpsell,
    buildTgDeepLink, handleBuyAddon, setGuestItems,
    viewingItem, profileData, tgUser, addonCheckoutLoading,
  } = ctx;
  void _showUpsell;

  // ── Group Gift state (from useGroupGiftState) ────────────────────────
  const {
    groupGiftData, setGroupGiftData,
    groupGiftCreateItemId,
    groupGiftCreateItem,
    groupGiftMessages, setGroupGiftMessages,
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
    ggAccess,
  } = ctx;

  return (
    <>
      {/* ── GROUP GIFT: PAYWALL ── */}
      {screen === 'group-gift-paywall' && viewingItem && (() => {
        const price = ggAccess.priceXtr;
        return (
          <div style={{ padding: '24px 16px calc(110px + env(safe-area-inset-bottom, 0px))', textAlign: 'center' }}>
            {/* v2.1 hero emoji plate — glass + layered gradient + accent-glow drop */}
            <div style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 88, height: 88, borderRadius: 22,
              background: 'linear-gradient(135deg, var(--wb-accent-soft-strong), var(--wb-accent-soft))',
              border: '1px solid var(--wb-accent-soft-strong)',
              fontSize: 44, marginBottom: 20,
              boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 12px 32px var(--wb-accent-shadow-soft)',
              WebkitBackdropFilter: 'blur(14px)' as never,
              backdropFilter: 'blur(14px)' as never,
            }}>
              <span style={{ filter: 'drop-shadow(0 4px 12px var(--wb-accent-shadow-soft))' }}>👥</span>
            </div>
            <div style={{
              fontSize: 26, fontWeight: 700, fontFamily: font,
              color: 'var(--wb-text)', marginBottom: 8,
              letterSpacing: '-0.035em', lineHeight: 1.05,
            }}>{t('gg_paywall_title', locale)}</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, margin: '20px 0' }}>
              {[
                { emoji: '👥', text: t('gg_paywall_f1', locale) },
                { emoji: '💬', text: t('gg_paywall_f2', locale) },
                { emoji: '🔗', text: t('gg_paywall_f3', locale) },
                { emoji: '🎯', text: t('gg_paywall_f4', locale) },
              ].map((f, i) => (
                <div key={i} style={{
                  background: 'var(--wb-card)',
                  border: '1px solid var(--wb-border)',
                  borderRadius: 18, padding: '14px 12px', textAlign: 'center',
                  WebkitBackdropFilter: 'blur(14px)' as never,
                  backdropFilter: 'blur(14px)' as never,
                }}>
                  <div style={{ fontSize: 26, marginBottom: 6 }}>{f.emoji}</div>
                  <div style={{
                    fontSize: 12.5, color: 'var(--wb-text-secondary)',
                    lineHeight: 1.3, letterSpacing: '-0.003em',
                  }}>{f.text}</div>
                </div>
              ))}
            </div>
            <div style={{
              background: 'var(--wb-card)',
              border: '1px solid var(--wb-border)',
              borderRadius: 20, padding: '20px 16px', margin: '20px 0',
              WebkitBackdropFilter: 'blur(16px)' as never,
              backdropFilter: 'blur(16px)' as never,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <span style={{
                  fontSize: 32, fontWeight: 700,
                  color: 'var(--wb-accent-strong)',
                  fontFamily: font,
                  letterSpacing: '-0.035em',
                  fontFeatureSettings: '"tnum"',
                }}>{price}</span>
                <span style={{ fontSize: 15, color: 'var(--wb-text-secondary)', fontWeight: 500 }}>Stars</span>
              </div>
              <div style={{
                display: 'inline-block', marginTop: 8, padding: '5px 11px',
                borderRadius: 10,
                background: 'var(--wb-accent-soft)',
                border: '1px solid var(--wb-accent-soft-strong)',
                color: 'var(--wb-accent-strong)',
                fontSize: 12, fontWeight: 650,
                letterSpacing: '-0.005em',
              }}>
                {t('gg_paywall_badge', locale)}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <Button
                variant="primary-gradient"
                fullWidth
                loading={addonCheckoutLoading}
                onClick={() => void handleBuyAddon('group_gift_unlock')}
              >
                ⭐ {t('gg_paywall_buy', locale).replace('{{price}}', String(price))}
              </Button>
              <Button
                variant="ghost"
                fullWidth
                onClick={() => setScreen('guest-item-detail')}
              >
                {t('gg_paywall_later', locale)}
              </Button>
            </div>
          </div>
        );
      })()}

      {/* ── GROUP GIFT: CREATE ── */}
      {screen === 'group-gift-create' && groupGiftCreateItem && (() => {
        const currSym = groupGiftCreateItem.currency === 'USD' ? '$' : groupGiftCreateItem.currency === 'EUR' ? '€' : '₽';
        return (
          <div style={{ padding: '16px 16px calc(110px + env(safe-area-inset-bottom, 0px))' }}>
            <div style={{
              fontSize: 26, fontWeight: 700, fontFamily: font,
              color: 'var(--wb-text)', marginBottom: 16,
              letterSpacing: '-0.035em', lineHeight: 1.05,
            }}>{'👥 ' + t('gg_create_title', locale)}</div>

            {/* v2.1 Item preview */}
            <div style={{
              display: 'flex', gap: 14, alignItems: 'center', padding: 14,
              background: 'var(--wb-card)',
              border: '1px solid var(--wb-border)',
              borderRadius: 18, marginBottom: 20,
              WebkitBackdropFilter: 'blur(14px)' as never,
              backdropFilter: 'blur(14px)' as never,
            }}>
              {groupGiftCreateItem.imageUrl ? (
                <img src={groupGiftCreateItem.imageUrl} alt="" loading="lazy" decoding="async" style={{ width: 50, height: 50, borderRadius: 14, objectFit: 'cover', flexShrink: 0 }} />
              ) : (
                <div style={{
                  width: 50, height: 50, borderRadius: 14,
                  background: 'linear-gradient(135deg, var(--wb-accent-soft-strong), var(--wb-accent-soft))',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 24, flexShrink: 0,
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
                }}>🎁</div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 15, fontWeight: 600,
                  color: 'var(--wb-text)', fontFamily: font,
                  letterSpacing: '-0.015em', lineHeight: 1.3,
                }}>{groupGiftCreateItem.title}</div>
                {groupGiftCreateItem.price != null && (
                  <div style={{
                    fontSize: 13, color: 'var(--wb-text-secondary)',
                    fontWeight: 650, marginTop: 2,
                    fontFeatureSettings: '"tnum"',
                  }}>
                    {groupGiftCreateItem.price.toLocaleString()} {currSym}
                  </div>
                )}
              </div>
            </div>

            {/* Form */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div>
                <label style={{
                  display: 'block', fontSize: 11, fontWeight: 600,
                  color: 'var(--wb-text-muted)', marginBottom: 8,
                  textTransform: 'uppercase' as const, letterSpacing: '0.7px',
                }}>{t('gg_create_target', locale)}</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="number" inputMode="numeric" value={ggTargetAmt} onChange={e => setGgTargetAmt(e.target.value)}
                    style={{ ...inputStyle, flex: 1, fontFeatureSettings: '"tnum"' }} placeholder={t('gg_amount_placeholder', locale)} />
                  <span style={{
                    fontSize: 16, color: 'var(--wb-text-secondary)',
                    fontWeight: 650, letterSpacing: '-0.012em',
                  }}>{currSym}</span>
                </div>
              </div>
              <div>
                <label style={{
                  display: 'block', fontSize: 11, fontWeight: 600,
                  color: 'var(--wb-text-muted)', marginBottom: 8,
                  textTransform: 'uppercase' as const, letterSpacing: '0.7px',
                }}>{t('gg_create_deadline', locale)}</label>
                <input type="date" value={ggDeadline} onChange={e => setGgDeadline(e.target.value)}
                  style={{ ...inputStyle, colorScheme: 'dark' }} />
              </div>
              <div>
                <label style={{
                  display: 'block', fontSize: 11, fontWeight: 600,
                  color: 'var(--wb-text-muted)', marginBottom: 8,
                  textTransform: 'uppercase' as const, letterSpacing: '0.7px',
                }}>{t('gg_create_note', locale)}</label>
                <textarea value={ggNote} onChange={e => setGgNote(e.target.value)} maxLength={500}
                  style={{ ...inputStyle, minHeight: 80, resize: 'vertical' }} placeholder={t('gg_create_note_ph', locale)} />
              </div>
              <div>
                <label style={{
                  display: 'block', fontSize: 11, fontWeight: 600,
                  color: 'var(--wb-text-muted)', marginBottom: 8,
                  textTransform: 'uppercase' as const, letterSpacing: '0.7px',
                }}>{t('gg_my_amount', locale)} ({currSym})</label>
                <input type="number" inputMode="numeric" value={ggMyAmount} onChange={e => setGgMyAmount(e.target.value)}
                  style={{ ...inputStyle, fontFeatureSettings: '"tnum"' }} placeholder="0" />
              </div>
            </div>

            {/* Info note */}
            <div style={{
              margin: '16px 0', padding: 12,
              background: 'var(--wb-card)',
              border: '1px solid var(--wb-border)',
              borderRadius: 14, display: 'flex', gap: 8, alignItems: 'flex-start',
              WebkitBackdropFilter: 'blur(14px)' as never,
              backdropFilter: 'blur(14px)' as never,
            }}>
              <span style={{ fontSize: 16 }}>ℹ️</span>
              <span style={{
                fontSize: 12.5, color: 'var(--wb-text-secondary)',
                lineHeight: 1.45, letterSpacing: '-0.003em',
              }}>{t('gg_create_info', locale)}</span>
            </div>

            <Button
              variant="primary-gradient"
              fullWidth
              loading={ggCreating}
              onClick={async () => {
                if (!ggTargetAmt || Number(ggTargetAmt) <= 0) return;
                setGgCreating(true);
                try {
                  const r = await tgFetch('/tg/items/' + groupGiftCreateItemId + '/group-gift', {
                    method: 'POST',
                    body: JSON.stringify({
                      targetAmount: Number(ggTargetAmt),
                      currency: groupGiftCreateItem.currency,
                      deadline: ggDeadline || undefined,
                      note: ggNote || undefined,
                      displayName: resolveReservePrefill(tgUser, profileData).value || undefined,
                      myAmount: ggMyAmount ? Number(ggMyAmount) : 0,
                    }),
                    idempotency: { action: `gg.create:${groupGiftCreateItemId}` },
                  });
                  if (!r.ok) {
                    // Group gift migrated 403→402 in the 2026-05 paywall
                    // unification (group_gift_unlock add-on is purchasable).
                    // Accept both: 402 from new backend, 403 from cached
                    // legacy clients hitting a stale API.
                    const body = await r.json().catch(() => ({})) as { error?: string; feature?: string };
                    const parsed = parsePaywallError(r.status, body);
                    const isPaywall =
                      parsed?.feature === 'group_gift' ||
                      body.error === 'group_gift_required';
                    if (isPaywall) {
                      setScreen('group-gift-paywall');
                    } else {
                      pushToast(t('error_generic', locale), 'error');
                    }
                    return;
                  }
                  const gg = await r.json() as GroupGiftData;
                  setGroupGiftData(gg);
                  pushToast(t('gg_toast_created', locale), 'success');
                  trackEvent('group_gift_created', { groupGiftId: gg.id });
                  setGuestItems((prev: any[]) => prev.map((gi: any) => gi.id === groupGiftCreateItemId ? { ...gi, status: 'reserved' as const } : gi));
                  setScreen('group-gift-detail');
                } catch {
                  pushToast(t('error_generic', locale), 'error');
                } finally {
                  setGgCreating(false);
                }
              }}
            >
              👥 {t('gg_create_btn', locale)}
            </Button>
          </div>
        );
      })()}

      {/* ── GROUP GIFT: DETAIL ── */}
      {screen === 'group-gift-detail' && groupGiftData && (() => {
        const gg = groupGiftData;
        const currSym = gg.currency === 'USD' ? '$' : gg.currency === 'EUR' ? '€' : '₽';
        const fmtAmt = (n: number) => n.toLocaleString() + ' ' + currSym;
        const deadlineDate = gg.deadline ? new Date(gg.deadline) : null;
        const deadlinePassed = deadlineDate ? deadlineDate < new Date() : false;

        return (
          <div style={{ padding: '16px 16px calc(110px + env(safe-area-inset-bottom, 0px))' }}>
            {/* Header badges — role + status — canonical Chip primitive. */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <Chip tone={gg.isOrganizer ? 'accent' : 'success'} size="lg">
                {gg.isOrganizer ? '⚡ ' + t('gg_badge_organizer', locale) : '👤 ' + t('gg_badge_participant', locale)}
              </Chip>
              <Chip tone={gg.status === 'OPEN' ? 'success' : gg.status === 'COMPLETED' ? 'accent' : 'danger'} size="md">
                {t(`gg_status_${gg.status.toLowerCase()}` as never, locale)}
              </Chip>
            </div>

            {/* v2.1 Item card — glass surface with v2.1 thumb spec */}
            <div style={{
              display: 'flex', gap: 14, alignItems: 'center', padding: 14,
              background: 'var(--wb-card)',
              border: '1px solid var(--wb-border)',
              borderRadius: 18, marginBottom: 16,
              WebkitBackdropFilter: 'blur(14px)' as never,
              backdropFilter: 'blur(14px)' as never,
            }}>
              {gg.item.imageUrl ? (
                <img src={gg.item.imageUrl} alt="" loading="lazy" decoding="async" style={{ width: 50, height: 50, borderRadius: 14, objectFit: 'cover', flexShrink: 0 }} />
              ) : (
                <div style={{
                  width: 50, height: 50, borderRadius: 14,
                  background: 'linear-gradient(135deg, var(--wb-accent-soft-strong), var(--wb-accent-soft))',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24,
                  flexShrink: 0,
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
                }}>🎁</div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--wb-text)', fontFamily: font, letterSpacing: '-0.015em', lineHeight: 1.3 }}>{gg.item.title}</div>
                {gg.item.price != null && (
                  <div style={{ fontSize: 13, color: 'var(--wb-text-secondary)', fontWeight: 650, marginTop: 2, fontFeatureSettings: '"tnum"' }}>
                    {gg.item.price.toLocaleString()} {currSym}
                  </div>
                )}
              </div>
            </div>

            {/* v2.1 Progress block — glass surface + accent-gradient bar with glow */}
            <div style={{
              background: 'var(--wb-card)',
              border: '1px solid var(--wb-border)',
              borderRadius: 22, padding: 18, marginBottom: 16,
              WebkitBackdropFilter: 'blur(16px)' as never,
              backdropFilter: 'blur(16px)' as never,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
                <span style={{ fontSize: 13, color: 'var(--wb-text-secondary)', letterSpacing: '-0.005em' }}>{t('gg_collected', locale)}</span>
                <span style={{ fontSize: 17, fontWeight: 700, color: 'var(--wb-text)', fontFamily: font, letterSpacing: '-0.025em', fontFeatureSettings: '"tnum"' }}>{fmtAmt(gg.collectedAmount)} / {fmtAmt(gg.targetAmount)}</span>
              </div>
              {/* Progress bar — v2.1 3px track + accent gradient with glow */}
              <div style={{ height: 3, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden', marginBottom: 14 }}>
                <div style={{
                  width: `${gg.progressPct}%`, height: '100%', borderRadius: 2,
                  background: 'linear-gradient(90deg, var(--wb-accent), var(--wb-accent-strong))',
                  boxShadow: '0 0 12px var(--wb-accent-shadow-soft)',
                  transition: 'width 0.5s ease',
                }} />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--wb-accent-strong)', letterSpacing: '-0.02em', fontFeatureSettings: '"tnum"' }}>{gg.progressPct}%</div>
                  <div style={{ fontSize: 11, color: 'var(--wb-text-muted)', marginTop: 2 }}>{t('gg_progress', locale)}</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--wb-text)', letterSpacing: '-0.02em', fontFeatureSettings: '"tnum"' }}>{gg.participantCount}</div>
                  <div style={{ fontSize: 11, color: 'var(--wb-text-muted)', marginTop: 2 }}>{t('gg_participants', locale)}</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--wb-warning)', letterSpacing: '-0.02em', fontFeatureSettings: '"tnum"' }}>{fmtAmt(gg.remaining)}</div>
                  <div style={{ fontSize: 11, color: 'var(--wb-text-muted)', marginTop: 2 }}>{t('gg_remaining', locale)}</div>
                </div>
              </div>
            </div>

            {/* Deadline banner — canonical Banner primitive. */}
            {deadlineDate && (
              <div style={{ marginBottom: 16 }}>
                <Banner tone={deadlinePassed ? 'danger' : 'warning'} icon={<span>{deadlinePassed ? '⚠️' : '⏰'}</span>}>
                  <div style={{ textAlign: 'center', fontWeight: 600 }}>
                    {deadlinePassed ? t('gg_deadline_passed', locale) : deadlineDate.toLocaleDateString(localeToBCP47(locale))}
                  </div>
                </Banner>
              </div>
            )}

            {/* Pinned info — Banner primitive with warning tone (amber left-strip effect). */}
            {gg.pinnedInfo && (
              <div style={{ marginBottom: 16 }}>
                <Banner tone="warning" icon={<span>📌</span>}>
                  <div style={{ fontSize: 12, color: C.orange, fontWeight: 600, marginBottom: 4 }}>{t('gg_pinned_info', locale)}</div>
                  <div style={{ fontSize: 14, color: C.text, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{gg.pinnedInfo}</div>
                </Banner>
              </div>
            )}

            {/* My amount (participant view) */}
            {!gg.isOrganizer && gg.isParticipant && (() => {
              const myP = gg.participants.find(p => p.isSelf);
              return myP ? (
                <div style={{ background: C.surface, borderRadius: 14, padding: 14, marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 12, color: C.textSec }}>{t('gg_my_amount', locale)}</div>
                    <div style={{ fontSize: 18, fontWeight: 700, color: C.accent, fontFamily: font }}>{myP.amount != null ? fmtAmt(myP.amount) : '—'}</div>
                  </div>
                  {gg.status === 'OPEN' && (
                    <button onClick={() => {
                      const newAmt = prompt(t('gg_join_amount', locale), String(myP.amount ?? 0));
                      if (newAmt === null) return;
                      void (async () => {
                        try {
                          const r = await tgFetch('/tg/group-gifts/' + gg.id + '/amount', {
                            method: 'PATCH',
                            body: JSON.stringify({ amount: Number(newAmt) || 0 }),
                            idempotency: { action: `gg.amount:${gg.id}` },
                          });
                          if (r.ok) {
                            const updated = await r.json() as GroupGiftData;
                            setGroupGiftData(updated);
                            pushToast(t('gg_toast_amount_updated', locale), 'success');
                          }
                        } catch { pushToast(t('error_generic', locale), 'error'); }
                      })();
                    }}
                      style={{ padding: '8px 14px', fontSize: 13, color: C.accent, background: 'transparent', border: 'none', cursor: 'pointer', fontFamily: 'inherit' }}>
                      {'✏️ ' + t('gg_edit_amount', locale)}
                    </button>
                  )}
                </div>
              ) : null;
            })()}

            {/* Participants list */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: C.textSec, marginBottom: 8 }}>{t('gg_participants', locale)} ({gg.participantCount})</div>
              {gg.participants.map(p => (
                <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 0', borderBottom: `1px solid ${C.border}` }}>
                  <UserAvatar avatarUrl={p.avatarUrl} name={p.displayName} size={36} accent={p.isOrganizer ? C.accent : C.green} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 14, color: C.text, fontWeight: p.isSelf ? 700 : 500 }}>
                      {p.displayName}{p.isSelf ? (' ← ' + t('me_label', locale)) : ''}
                    </div>
                    {p.isOrganizer && (
                      <span style={{ fontSize: 11, color: C.accent, fontWeight: 600 }}>{'⚡ ' + t('gg_badge_organizer', locale)}</span>
                    )}
                  </div>
                  {/* Organizer sees all amounts, participant sees only own */}
                  {p.amount != null && (
                    <span style={{ fontSize: 14, fontWeight: 600, color: C.accent }}>{fmtAmt(p.amount)}</span>
                  )}
                  {p.amount === null && (
                    <span style={{ fontSize: 13, color: C.green }}>✓</span>
                  )}
                </div>
              ))}
            </div>

            {/* ── Section 1: Primary actions (Chat + Share) ── */}
            <div style={{ display: 'flex', gap: 10, marginTop: 4 }}>
              <Button
                variant="secondary"
                style={{ flex: 1 }}
                onClick={() => {
                  void (async () => {
                    try {
                      const r = await tgFetch('/tg/group-gifts/' + gg.id + '/messages');
                      if (r.ok) {
                        const d = await r.json() as { messages: typeof groupGiftMessages };
                        setGroupGiftMessages(d.messages);
                      }
                    } catch { /* ignore */ }
                    setScreen('group-gift-chat');
                  })();
                }}
              >
                {'💬 ' + t('gg_write_chat', locale)}
              </Button>
              {gg.status === 'OPEN' && (
                <Button
                  variant="primary"
                  style={{ flex: 1 }}
                  onClick={() => {
                    const link = buildTgDeepLink(`gg_${gg.inviteToken}`) ?? `https://t.me/WishHub_bot?startapp=gg_${gg.inviteToken}`;
                    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(t('gg_share_text', locale).replace('{{name}}', gg.organizerName))}`;
                    try { window.Telegram?.WebApp.openTelegramLink(shareUrl); } catch { window.open(shareUrl, '_blank'); }
                    trackEvent('group_gift_shared', { groupGiftId: gg.id });
                  }}
                >
                  {'📤 ' + t('gg_share', locale)}
                </Button>
              )}
            </div>

            {/* ── Section 2: Management (organizer only) ── */}
            {gg.isOrganizer && gg.status === 'OPEN' && (
              <div style={{ marginTop: 24 }}>
                <div style={{ fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600, marginBottom: 8 }}>
                  {t('gg_section_manage', locale)}
                </div>
                <div style={{ background: C.surface, borderRadius: 14, overflow: 'hidden' }}>
                  <div
                    onClick={() => {
                      const newPinned = prompt(t('gg_edit_pinned', locale), gg.pinnedInfo ?? '');
                      if (newPinned === null) return;
                      void (async () => {
                        try {
                          const r = await tgFetch('/tg/group-gifts/' + gg.id + '/pinned', {
                            method: 'PATCH',
                            body: JSON.stringify({ pinnedInfo: newPinned }),
                            idempotency: { action: `gg.pinned:${gg.id}` },
                          });
                          if (r.ok) {
                            setGroupGiftData(prev => prev ? { ...prev, pinnedInfo: newPinned } : prev);
                            pushToast(t('gg_toast_pinned_updated', locale), 'success');
                          }
                        } catch { pushToast(t('error_generic', locale), 'error'); }
                      })();
                    }}
                    style={{
                      display: 'flex', alignItems: 'center', padding: '14px 16px',
                      cursor: 'pointer', WebkitTapHighlightColor: 'transparent',
                    }}
                  >
                    <span style={{ fontSize: 16, marginRight: 10 }}>📌</span>
                    <span style={{ flex: 1, fontSize: 14, color: C.text, fontWeight: 500 }}>{t('gg_edit_pinned', locale)}</span>
                    <span style={{ fontSize: 18, color: C.textMuted }}>›</span>
                  </div>
                </div>
              </div>
            )}

            {/* ── Section 3: Complete & Cancel (organizer) ── */}
            {gg.isOrganizer && gg.status === 'OPEN' && (
              <div style={{ marginTop: 24 }}>
                <Button
                  variant="primary"
                  size="md"
                  style={{ background: C.green }}
                  onClick={() => {
                    if (!confirm(t('gg_complete_confirm', locale))) return;
                    void (async () => {
                      try {
                        const r = await tgFetch('/tg/group-gifts/' + gg.id + '/complete', {
                          method: 'POST',
                          idempotency: { action: `gg.complete:${gg.id}` },
                        });
                        if (r.ok) {
                          setGroupGiftData(prev => prev ? { ...prev, status: 'COMPLETED' } : prev);
                          pushToast(t('gg_toast_completed', locale), 'success');
                        }
                      } catch { pushToast(t('error_generic', locale), 'error'); }
                    })();
                  }}
                >
                  {'✅ ' + t('gg_complete', locale)}
                </Button>
                <button onClick={() => {
                  if (!confirm(t('gg_cancel_confirm', locale))) return;
                  void (async () => {
                    try {
                      const r = await tgFetch('/tg/group-gifts/' + gg.id + '/cancel', {
                        method: 'POST',
                        idempotency: { action: `gg.cancel:${gg.id}` },
                      });
                      if (r.ok) {
                        setGroupGiftData(null);
                        pushToast(t('gg_toast_cancelled', locale), 'info');
                        setScreen('guest-view');
                      }
                    } catch { pushToast(t('error_generic', locale), 'error'); }
                  })();
                }} style={{
                  background: 'none', border: 'none', width: '100%', marginTop: 16, padding: '10px 0',
                  fontSize: 13, color: C.red, opacity: 0.7, cursor: 'pointer', fontFamily: font, fontWeight: 500, textAlign: 'center' as const,
                }}>
                  {'❌ ' + t('gg_cancel', locale)}
                </button>
              </div>
            )}

            {/* ── Participant: leave ── */}
            {!gg.isOrganizer && gg.isParticipant && gg.status === 'OPEN' && (
              <button onClick={() => {
                if (!confirm(t('gg_leave_confirm', locale))) return;
                void (async () => {
                  try {
                    const r = await tgFetch('/tg/group-gifts/' + gg.id + '/leave', {
                      method: 'POST',
                      idempotency: { action: `gg.leave:${gg.id}` },
                    });
                    if (r.ok) {
                      setGroupGiftData(null);
                      pushToast(t('gg_toast_left', locale), 'info');
                      setScreen('guest-view');
                    }
                  } catch { pushToast(t('error_generic', locale), 'error'); }
                })();
              }} style={{
                background: 'none', border: 'none', width: '100%', marginTop: 20, padding: '10px 0',
                fontSize: 13, color: C.red, opacity: 0.7, cursor: 'pointer', fontFamily: font, fontWeight: 500, textAlign: 'center' as const,
              }}>
                {t('gg_leave', locale)}
              </button>
            )}
          </div>
        );
      })()}

      {/* ── GROUP GIFT: JOIN ── */}
      {screen === 'group-gift-join' && groupGiftData && (() => {
        const gg = groupGiftData;
        const currSym = gg.currency === 'USD' ? '$' : gg.currency === 'EUR' ? '€' : '₽';
        const fmtAmt = (n: number) => n.toLocaleString() + ' ' + currSym;
        const deadlineDate = gg.deadline ? new Date(gg.deadline) : null;
        const daysLeft = deadlineDate ? Math.ceil((deadlineDate.getTime() - Date.now()) / 86400000) : null;
        const joinAmt = ggJoinAmt;
        const setJoinAmt = setGgJoinAmt;
        const joining = ggJoining;
        const setJoining = setGgJoining;

        return (
          <div style={{ padding: '24px 16px calc(110px + env(safe-area-inset-bottom, 0px))', textAlign: 'center' }}>
            <div style={{ fontSize: 52, marginBottom: 14, filter: 'drop-shadow(0 12px 28px var(--wb-accent-shadow-soft))' }}>🎁</div>
            <div style={{
              fontSize: 26, fontWeight: 700, fontFamily: font,
              color: 'var(--wb-text)', marginBottom: 6,
              letterSpacing: '-0.035em', lineHeight: 1.05,
            }}>{t('gg_join_title', locale)}</div>
            <div style={{
              fontSize: 14, color: 'var(--wb-text-secondary)',
              marginBottom: 20, letterSpacing: '-0.005em',
            }}>{t('gg_join_invited', locale).replace('{{name}}', gg.organizerName)}</div>

            {/* v2.1 Item card */}
            <div style={{
              display: 'flex', gap: 14, alignItems: 'center', padding: 14,
              background: 'var(--wb-card)',
              border: '1px solid var(--wb-border)',
              borderRadius: 18, marginBottom: 14, textAlign: 'left',
              WebkitBackdropFilter: 'blur(14px)' as never,
              backdropFilter: 'blur(14px)' as never,
            }}>
              {gg.item.imageUrl ? (
                <img src={gg.item.imageUrl} alt="" loading="lazy" decoding="async" style={{ width: 50, height: 50, borderRadius: 14, objectFit: 'cover', flexShrink: 0 }} />
              ) : (
                <div style={{
                  width: 50, height: 50, borderRadius: 14,
                  background: 'linear-gradient(135deg, var(--wb-accent-soft-strong), var(--wb-accent-soft))',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 24, flexShrink: 0,
                  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06)',
                }}>🎁</div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{
                  fontSize: 15, fontWeight: 600, color: 'var(--wb-text)',
                  letterSpacing: '-0.015em', lineHeight: 1.3,
                }}>{gg.item.title}</div>
                {gg.item.price != null && (
                  <div style={{
                    fontSize: 13, color: 'var(--wb-text-secondary)',
                    fontWeight: 650, marginTop: 2,
                    fontFeatureSettings: '"tnum"',
                  }}>{gg.item.price.toLocaleString()} {currSym}</div>
                )}
              </div>
            </div>

            {/* v2.1 Stats row */}
            <div style={{
              display: 'flex', justifyContent: 'space-around', margin: '14px 0',
              padding: 14,
              background: 'var(--wb-card)',
              border: '1px solid var(--wb-border)',
              borderRadius: 18,
              WebkitBackdropFilter: 'blur(14px)' as never,
              backdropFilter: 'blur(14px)' as never,
            }}>
              <div style={{ textAlign: 'center' }}>
                <div style={{
                  fontSize: 20, fontWeight: 700,
                  color: 'var(--wb-accent-strong)',
                  letterSpacing: '-0.02em', fontFeatureSettings: '"tnum"',
                }}>{gg.progressPct}%</div>
                <div style={{ fontSize: 11, color: 'var(--wb-text-muted)', marginTop: 2 }}>{t('gg_collected', locale)}</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{
                  fontSize: 20, fontWeight: 700, color: 'var(--wb-text)',
                  letterSpacing: '-0.02em', fontFeatureSettings: '"tnum"',
                }}>{gg.participantCount}</div>
                <div style={{ fontSize: 11, color: 'var(--wb-text-muted)', marginTop: 2 }}>{t('gg_participants', locale)}</div>
              </div>
              <div style={{ textAlign: 'center' }}>
                <div style={{
                  fontSize: 20, fontWeight: 700,
                  color: 'var(--wb-warning)',
                  letterSpacing: '-0.02em', fontFeatureSettings: '"tnum"',
                }}>{fmtAmt(gg.remaining)}</div>
                <div style={{ fontSize: 11, color: 'var(--wb-text-muted)', marginTop: 2 }}>{t('gg_remaining', locale)}</div>
              </div>
            </div>

            {/* Deadline banner — Banner primitive with warning tone.
                fontWeight inherits via outer style (deadline CTA needs emphasis). */}
            {deadlineDate && daysLeft != null && daysLeft > 0 && (
              <Banner tone="warning" icon="⏰" style={{ marginBottom: 14, fontWeight: 650 }}>
                {t('gg_join_deadline', locale).replace('{{date}}', deadlineDate.toLocaleDateString(localeToBCP47(locale))).replace('{{days}}', String(daysLeft))}
              </Banner>
            )}

            {/* Organizer note */}
            {gg.note && (
              <div style={{
                padding: 14, borderRadius: 14, marginBottom: 14,
                background: 'var(--wb-card)',
                border: '1px solid var(--wb-border)',
                borderLeft: '3px solid var(--wb-accent)',
                textAlign: 'left',
                WebkitBackdropFilter: 'blur(14px)' as never,
                backdropFilter: 'blur(14px)' as never,
              }}>
                <div style={{
                  fontSize: 14, color: 'var(--wb-text)',
                  whiteSpace: 'pre-wrap', letterSpacing: '-0.005em',
                  lineHeight: 1.45,
                }}>{gg.note}</div>
              </div>
            )}

            {/* Amount input */}
            <div style={{ textAlign: 'left', marginBottom: 14 }}>
              <label style={{
                display: 'block', fontSize: 11, fontWeight: 600,
                color: 'var(--wb-text-muted)', marginBottom: 8,
                textTransform: 'uppercase' as const, letterSpacing: '0.7px',
              }}>{t('gg_join_amount', locale)}</label>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="number" inputMode="numeric" value={joinAmt} onChange={e => setJoinAmt(e.target.value)}
                  style={{
                    ...inputStyle, flex: 1, fontSize: 20, textAlign: 'center',
                    fontWeight: 700, letterSpacing: '-0.025em',
                    fontFeatureSettings: '"tnum"',
                  }} placeholder={t('gg_join_amount_ph', locale)} autoFocus />
                <span style={{
                  fontSize: 18, color: 'var(--wb-text-secondary)',
                  fontWeight: 650, letterSpacing: '-0.015em',
                }}>{currSym}</span>
              </div>
            </div>

            {/* Info note */}
            <div style={{
              padding: 12, background: 'var(--wb-card)',
              border: '1px solid var(--wb-border)',
              borderRadius: 14, marginBottom: 20,
              display: 'flex', gap: 8, alignItems: 'flex-start', textAlign: 'left',
              WebkitBackdropFilter: 'blur(14px)' as never,
              backdropFilter: 'blur(14px)' as never,
            }}>
              <span style={{ fontSize: 14 }}>ℹ️</span>
              <span style={{
                fontSize: 12.5, color: 'var(--wb-text-secondary)',
                lineHeight: 1.45, letterSpacing: '-0.003em',
              }}>{t('gg_join_info', locale)}</span>
            </div>

            <Button
              variant="primary-gradient"
              fullWidth
              loading={joining}
              onClick={async () => {
                setJoining(true);
                try {
                  const r = await tgFetch('/tg/group-gifts/' + gg.id + '/join', {
                    method: 'POST',
                    body: JSON.stringify({
                      amount: Number(joinAmt) || 0,
                      displayName: resolveReservePrefill(tgUser, profileData).value || undefined,
                    }),
                    idempotency: { action: `gg.join:${gg.id}` },
                  });
                  if (r.status === 409) {
                    const updated = await (await tgFetch('/tg/group-gifts/' + gg.id)).json() as GroupGiftData;
                    setGroupGiftData(updated);
                    setScreen('group-gift-detail');
                    return;
                  }
                  if (!r.ok) { pushToast(t('error_generic', locale), 'error'); return; }
                  const updated = await r.json() as GroupGiftData;
                  setGroupGiftData(updated);
                  pushToast(t('gg_toast_joined', locale), 'success');
                  trackEvent('group_gift_joined', { groupGiftId: gg.id });
                  setScreen('group-gift-detail');
                } catch {
                  pushToast(t('error_generic', locale), 'error');
                } finally {
                  setJoining(false);
                }
              }}
            >
              ✋ {t('gg_join_btn', locale)}
            </Button>
          </div>
        );
      })()}

      {/* ── GROUP GIFT: CHAT ── */}
      {screen === 'group-gift-chat' && groupGiftData && (() => {
        const gg = groupGiftData;
        const chatMsg = ggChatMsg;
        const setChatMsg = setGgChatMsg;
        const sending = ggChatSending;
        const setSending = setGgChatSending;
        const messagesEndRef = ggMessagesEndRef;

        return (
          <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 60px)' }}>
            {/* v2.1 Chat header */}
            <div style={{
              padding: '12px 16px',
              borderBottom: '1px solid var(--wb-border)',
              display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0,
              background: 'var(--wb-surface)',
              WebkitBackdropFilter: 'blur(20px) saturate(140%)' as never,
              backdropFilter: 'blur(20px) saturate(140%)' as never,
            }}>
              <span style={{ fontSize: 18 }}>💬</span>
              <span style={{
                fontSize: 15, fontWeight: 650,
                color: 'var(--wb-text)', fontFamily: font,
                flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                letterSpacing: '-0.012em',
              }}>
                {t('gg_chat_title', locale)} · {gg.item.title}
              </span>
              <span style={{
                fontSize: 12, fontWeight: 650,
                color: 'var(--wb-accent-strong)',
                background: 'var(--wb-accent-soft)',
                border: '1px solid var(--wb-accent-soft-strong)',
                borderRadius: 100, padding: '3px 10px',
                fontFeatureSettings: '"tnum"',
              }}>👥 {gg.participantCount}</span>
            </div>

            {/* Pinned banner */}
            {gg.pinnedInfo && (
              <div style={{
                padding: '10px 16px',
                background: 'var(--wb-warning-soft)',
                border: '1px solid rgba(251,191,36,0.28)',
                borderBottom: '1px solid rgba(251,191,36,0.28)',
                flexShrink: 0,
                WebkitBackdropFilter: 'blur(14px)' as never,
                backdropFilter: 'blur(14px)' as never,
              }}>
                <div style={{
                  fontSize: 11, color: 'var(--wb-warning)',
                  fontWeight: 650, letterSpacing: '0.1px',
                  textTransform: 'uppercase' as const,
                }}>📌 {t('gg_chat_pinned', locale)}</div>
                <div style={{
                  fontSize: 13, color: 'var(--wb-text)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  marginTop: 2, letterSpacing: '-0.005em',
                }}>{gg.pinnedInfo}</div>
              </div>
            )}

            {/* Messages */}
            <div style={{ flex: 1, overflow: 'auto', padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              {groupGiftMessages.length === 0 && (
                <div style={{
                  textAlign: 'center',
                  color: 'var(--wb-text-muted)',
                  fontSize: 14, padding: 40,
                  letterSpacing: '-0.005em',
                }}>{t('gg_no_messages', locale)}</div>
              )}
              {groupGiftMessages.map(m => (
                m.type === 'SYSTEM' ? (
                  <div key={m.id} style={{
                    textAlign: 'center', fontSize: 12,
                    color: 'var(--wb-text-muted)', padding: '4px 0',
                    fontStyle: 'italic', letterSpacing: '-0.003em',
                  }}>{m.text}</div>
                ) : (
                  <div key={m.id} style={{ display: 'flex', gap: 8, alignItems: m.isSelf ? 'flex-end' : 'flex-start', flexDirection: m.isSelf ? 'row-reverse' : 'row' }}>
                    {!m.isSelf && <UserAvatar avatarUrl={m.senderAvatarUrl} name={m.senderName} size={28} accent="var(--wb-accent, #8B7BFF)" />}
                    <div style={{
                      maxWidth: '75%', padding: '9px 13px', borderRadius: 16,
                      background: m.isSelf
                        ? 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))'
                        : 'var(--wb-card)',
                      border: m.isSelf ? 'none' : '1px solid var(--wb-border)',
                      borderTopRightRadius: m.isSelf ? 4 : 16,
                      borderTopLeftRadius: m.isSelf ? 16 : 4,
                      WebkitBackdropFilter: m.isSelf ? undefined : 'blur(14px)' as never,
                      backdropFilter: m.isSelf ? undefined : 'blur(14px)' as never,
                      boxShadow: m.isSelf
                        ? '0 6px 16px var(--wb-accent-shadow-soft), inset 0 1px 0 rgba(255,255,255,0.18)'
                        : undefined,
                    }}>
                      {!m.isSelf && (
                        <div style={{
                          fontSize: 11, fontWeight: 650,
                          color: 'var(--wb-accent-strong)',
                          marginBottom: 2, letterSpacing: '-0.003em',
                        }}>{m.senderName}</div>
                      )}
                      <div style={{
                        fontSize: 14,
                        color: m.isSelf ? '#fff' : 'var(--wb-text)',
                        whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                        letterSpacing: '-0.005em', lineHeight: 1.35,
                      }}>{m.text}</div>
                      <div style={{
                        fontSize: 10,
                        color: m.isSelf ? 'rgba(255,255,255,0.6)' : 'var(--wb-text-muted)',
                        marginTop: 3, textAlign: 'right',
                        fontFeatureSettings: '"tnum"',
                      }}>
                        {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                  </div>
                )
              ))}
              <div ref={messagesEndRef} />
            </div>

            {/* v2.1 Input bar — glass with send FAB */}
            <div style={{
              padding: '10px 16px',
              borderTop: '1px solid var(--wb-border)',
              display: 'flex', gap: 10, alignItems: 'center', flexShrink: 0,
              background: 'var(--wb-surface)',
              WebkitBackdropFilter: 'blur(20px) saturate(140%)' as never,
              backdropFilter: 'blur(20px) saturate(140%)' as never,
            }}>
              <input
                value={chatMsg} onChange={e => setChatMsg(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && chatMsg.trim()) { e.preventDefault(); void sendChatMsg(); } }}
                style={{ ...inputStyle, flex: 1, borderRadius: 100, padding: '10px 16px' }}
                placeholder={t('gg_chat_input_ph', locale)}
              />
              <button
                disabled={!chatMsg.trim() || sending}
                onClick={() => void sendChatMsg()}
                style={{
                  width: 44, height: 44, borderRadius: '50%', border: 'none',
                  background: chatMsg.trim()
                    ? 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))'
                    : 'var(--wb-surface)',
                  color: '#fff', fontSize: 18, fontWeight: 650, cursor: chatMsg.trim() ? 'pointer' : 'default',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  opacity: sending ? 0.5 : 1,
                  boxShadow: chatMsg.trim()
                    ? '0 6px 16px var(--wb-accent-shadow-soft), inset 0 1px 0 rgba(255,255,255,0.2)'
                    : undefined,
                  transition: 'all 0.15s ease',
                  flexShrink: 0,
                }}>↑</button>
            </div>
          </div>
        );

        async function sendChatMsg() {
          if (!chatMsg.trim() || sending) return;
          setSending(true);
          try {
            const r = await tgFetch('/tg/group-gifts/' + gg.id + '/messages', {
              method: 'POST',
              body: JSON.stringify({ text: chatMsg.trim() }),
              idempotency: { action: `gg.message:${gg.id}` },
            });
            if (r.ok) {
              const msg = await r.json() as (typeof groupGiftMessages)[0];
              setGroupGiftMessages(prev => [...prev, msg]);
              setChatMsg('');
            }
          } catch { pushToast(t('error_generic', locale), 'error'); }
          finally { setSending(false); }
        }
      })()}
    </>
  );
}
