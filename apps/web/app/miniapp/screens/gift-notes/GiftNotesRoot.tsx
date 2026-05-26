// GiftNotesRoot — F4 Wave C cluster file (REFACTOR_MINIAPP_TSX_PLAN).
//
// Bundles 3 Gift Notes screens (paywall, hub, occasion-detail) plus the
// 2 always-rendered BottomSheets (Create Occasion, Add Idea) into a single
// lazy-loaded module. Loaded via `next/dynamic({ ssr: false })` from
// `apps/web/app/miniapp/MiniApp.tsx`, so the chunk doesn't ship with the
// initial Mini App page bundle — gift-notes code only downloads when a
// user navigates to one of the gift-notes-* screens (cold path: deep
// link, settings tile, post-onboarding nudge).
//
// State source: `useGiftNotesState` is invoked exactly once in MiniAppInner
// and the ~19 returned fields are forwarded through `ctx`. The setters
// flow back into the same React state tree — no duplicate state.
//
// Sub-screens (selected by `ctx.screen`):
//   1. gift-notes-paywall    — demo-first paywall before unlock
//   2. gift-notes            — hub: occasion list + empty state with templates
//   3. gift-notes-occasion   — detail: occasion + ideas + actions + edit sheet
//
// Always-rendered (gated on `isAnyGiftNotesScreen`):
//   • Create Occasion BottomSheet (`showGnCreateOccasion`) — triggered from hub
//   • Add Idea BottomSheet         (`showGnAddIdea`)         — triggered from detail
//
// The `gift-notes-onboarding` screen (4-step post-unlock flow) stays inline
// in MiniApp.tsx as a thin 17-LOC dispatcher to the already-extracted
// `GiftNotesOnboardingContent` (F4 Wave A++, separate chunk).
//
// Implementation discipline:
// - JSX is copied verbatim from MiniApp.tsx — DO NOT migrate styles or
//   refactor logic in this PR. Bundle savings only; cosmetic changes
//   ride future on-touch PRs.
// - `ctx` types preserve `Dispatch<SetStateAction<T>>` for state setters
//   (via `GiftNotesState` intersection) while loose-typing helpers
//   (tgFetch / setScreen / pushToast) as `any` — same trade-off as
//   SantaRoot. Tightening is a follow-up.

'use client';

import React from 'react';
import {
  Button, Card,
  Sheet as BottomSheet,
  StickyCTAFade,
} from '@wishlist/ui';
import { t, localeToBCP47, type Locale } from '@wishlist/shared';
import { parsePaywallError } from '../../lib/paywall';
import type { GiftNotesState } from '../../hooks/useGiftNotesState';
import type {
  LegacyColorBag, PushToast, SetScreen, TgFetch,
} from '../../_shared/closure-types';

/**
 * GiftNotesRootCtx — closure refs forwarded from MiniAppInner.
 *
 * Intersection of the full `GiftNotesState` (all setters keep their inferred
 * `Dispatch<SetStateAction<T>>` signatures, so `setGnX(prev => ...)` still
 * type-checks) plus the helpers bag. Helpers now use real signatures from
 * `_shared/closure-types` (TgFetch/SetScreen/PushToast) so call-site
 * type-checks catch e.g. a missing `kind` on pushToast.
 */
export type GiftNotesRootCtx = GiftNotesState & {
  // module-level constants
  C: LegacyColorBag;
  font: string;
  locale: Locale;
  // hot-path helpers — real signatures from _shared/closure-types.
  tgFetch: TgFetch;
  setScreen: SetScreen;
  pushToast: PushToast;
};

export interface GiftNotesRootProps {
  /** Active gift-notes-* screen name; controls which sub-block renders. */
  screen: string;
  /** Bag of closure refs forwarded from MiniAppInner. See `GiftNotesRootCtx`. */
  ctx: GiftNotesRootCtx;
}

/**
 * Lazy-loaded Gift Notes cluster root.
 *
 * Destructures everything the JSX needs from `ctx` at the top, then returns
 * a fragment containing the 3 inline screen blocks and 2 always-rendered
 * BottomSheets. Each screen block is guarded by a `screen === '<name>'`
 * check exactly as in the original MiniApp.tsx — that keeps the JSX
 * byte-identical.
 */
export function GiftNotesRoot(props: GiftNotesRootProps) {
  const { ctx, screen } = props;

  // ── Module-level constants forwarded from MiniApp.tsx ────────────────
  const { C, font, locale } = ctx;

  // ── Local helpers forwarded from MiniAppInner closure ────────────────
  const { tgFetch, setScreen, pushToast } = ctx;

  // ── Gift Notes state (from useGiftNotesState — destructured here for legibility) ──
  const {
    gnAccess, setGnAccess,
    gnOccasions, setGnOccasions,
    gnViewingOccasion, setGnViewingOccasion,
    gnLoading,
    showGnCreateOccasion, setShowGnCreateOccasion,
    showGnAddIdea, setShowGnAddIdea,
    gnFormTitle, setGnFormTitle,
    gnFormDate, setGnFormDate,
    gnFormType, setGnFormType,
    gnFormRecurrence, setGnFormRecurrence,
    gnFormPerson, setGnFormPerson,
    gnIdeaText, setGnIdeaText,
    gnIdeaLink, setGnIdeaLink,
    gnShowActions, setGnShowActions,
    gnShowEdit, setGnShowEdit,
    gnEditTitle, setGnEditTitle,
    gnEditPerson, setGnEditPerson,
    gnEditNote, setGnEditNote,
  } = ctx;

  return (
    <>
      {/* ══════════════════════════════════════════════
          GIFT NOTES — PAYWALL (demo-first)
          ══════════════════════════════════════════════ */}
      {screen === 'gift-notes-paywall' && (() => {
        const orangeSoft = 'rgba(251,191,36,0.12)';
        const pinkSoft = 'rgba(236,72,153,0.12)';
        const greenSoft = 'rgba(74, 222, 128, 0.12)';
        const ring = (pct: number, color: string) => {
          const offset = 107 - (107 * Math.min(Math.max(pct, 0), 1));
          return (
            <svg viewBox="0 0 40 40" style={{ position: 'absolute' as const, inset: 0, transform: 'rotate(-90deg)' }}>
              <circle cx="20" cy="20" r="17" fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3" />
              <circle cx="20" cy="20" r="17" fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray="107" strokeDashoffset={offset} />
            </svg>
          );
        };
        const demoCard = (p: { emoji: string; emojiBg: string; stripColor: string; ringColor: string; ringPct: number; daysN: string | number; title: string; person: string; ideasChip?: boolean }) => (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: '12px 14px', position: 'relative' as const, overflow: 'hidden' }}>
            <div style={{ position: 'absolute' as const, left: 0, top: 0, bottom: 0, width: 3, background: p.stripColor }} />
            <div style={{ width: 40, height: 40, borderRadius: 10, background: p.emojiBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>{p.emoji}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.title}</div>
              <div style={{ fontSize: 12, color: C.textSec, marginTop: 1 }}>{p.person}</div>
              {p.ideasChip && <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', fontSize: 10, fontWeight: 600, color: C.accent, background: C.accentSoft, padding: '3px 7px', borderRadius: 6, marginTop: 4 }}>{t('gn_demo_ideas_count', locale)}</span>}
            </div>
            <div style={{ width: 40, height: 40, position: 'relative' as const, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {ring(p.ringPct, p.ringColor)}
              <div style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'center', zIndex: 1 }}>
                <span style={{ fontSize: 12, fontWeight: 800, color: p.ringColor, lineHeight: 1 }}>{p.daysN}</span>
                <span style={{ fontSize: 7, fontWeight: 600, color: C.textMuted, marginTop: 1 }}>{t('gn_days_abbr', locale)}</span>
              </div>
            </div>
          </div>
        );
        const benefit = (iconEl: string, iconBg: string, iconColor: string, title: string, body: string) => (
          <div style={{ padding: 12, borderRadius: 14, background: C.surface, border: `1px solid ${C.border}` }}>
            <div style={{ width: 28, height: 28, borderRadius: 8, background: iconBg, color: iconColor, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, marginBottom: 8 }}>{iconEl}</div>
            <h4 style={{ fontSize: 13, fontWeight: 700, color: C.text, lineHeight: 1.3, margin: '0 0 2px', fontFamily: font }}>{title}</h4>
            <p style={{ fontSize: 11, color: C.textMuted, lineHeight: 1.4, margin: 0 }}>{body}</p>
          </div>
        );
        const buyClick = async () => {
          try {
            const r = await tgFetch('/tg/billing/gift-notes/checkout', {
              method: 'POST',
              idempotency: { action: 'billing.gift-notes.checkout' },
            });
            if (r.ok) {
              const d = await r.json() as { invoiceUrl?: string; alreadyUnlocked?: boolean };
              if (d.alreadyUnlocked) {
                const sr = await tgFetch('/tg/billing/gift-notes/sync', {
                  method: 'POST',
                  idempotency: { action: 'billing.gift-notes.sync' },
                });
                if (sr.ok) { const sd = await sr.json() as { giftNotes: typeof gnAccess }; setGnAccess(sd.giftNotes); }
                setScreen('gift-notes');
              } else if (d.invoiceUrl) {
                try { window.Telegram?.WebApp?.openInvoice?.(d.invoiceUrl, async (status: string) => {
                  if (status === 'paid') {
                    const sr = await tgFetch('/tg/billing/gift-notes/sync', {
                      method: 'POST',
                      idempotency: { action: 'billing.gift-notes.sync' },
                    });
                    if (sr.ok) { const sd = await sr.json() as { giftNotes: typeof gnAccess }; setGnAccess(sd.giftNotes); }
                    pushToast(t('gn_access_unlocked', locale), 'success');
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    try { const or = await tgFetch('/tg/gift-occasions'); if (or.ok) setGnOccasions((await or.json() as any).occasions); } catch {}
                    let onboarded = false;
                    try { onboarded = !!window.localStorage.getItem('gift_notes_onboarded'); } catch { /* ok */ }
                    setScreen(onboarded ? 'gift-notes' : 'gift-notes-onboarding');
                  }
                }); } catch { window.open(d.invoiceUrl, '_blank'); }
              }
            }
          } catch { pushToast('Error', 'error'); }
        };
        return (
          <div style={{ padding: '0 0 calc(110px + env(safe-area-inset-bottom))', animation: 'fadeIn 0.3s ease' }}>
            {/* Hero with demo stack */}
            <div style={{
              padding: '20px 20px 0',
              textAlign: 'center' as const,
              background:
                'radial-gradient(circle at 50% 0%, rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.22) 0%, transparent 60%),' +
                'radial-gradient(circle at 20% 30%, rgba(236,72,153,0.10) 0%, transparent 40%),' +
                'radial-gradient(circle at 80% 20%, rgba(251,191,36,0.08) 0%, transparent 40%)',
            }}>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, fontWeight: 700, color: C.accent, letterSpacing: '0.05em', textTransform: 'uppercase' as const, marginBottom: 14, padding: '5px 10px', borderRadius: 20, background: C.accentSoft, border: '1px solid rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.2)' }}>
                📅 {t('gn_brand', locale)}
              </div>
              <h1 style={{ fontSize: 24, fontWeight: 800, color: C.text, lineHeight: 1.2, margin: '0 0 8px', fontFamily: font }}>
                {t('gn_hero_title', locale)}
              </h1>
              <p style={{ fontSize: 14, color: C.textSec, lineHeight: 1.5, margin: '0 auto 18px', maxWidth: 300 }}>
                {t('gn_hero_subtitle', locale)}
              </p>

              {/* Demo card stack */}
              <div style={{ background: C.card, border: `1px solid ${C.borderLight}`, borderRadius: 20, padding: 14, textAlign: 'left' as const, boxShadow: '0 8px 32px rgba(0,0,0,0.35)', position: 'relative' as const, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, fontWeight: 600, color: C.textMuted, textTransform: 'uppercase' as const, letterSpacing: '0.05em', marginBottom: 12 }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--wb-success, #4ADE80)', boxShadow: '0 0 8px #34D399', display: 'inline-block', animation: 'gnDotPulse 2s infinite' }} />
                  {t('gn_demo_header', locale)}
                </div>
                <style>{`@keyframes gnDotPulse { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: 0.5; transform: scale(1.15); } }`}</style>
                <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
                  {demoCard({ emoji: '🎂', emojiBg: orangeSoft, stripColor: 'linear-gradient(180deg,var(--wb-warning, #FBBF24),#f59e0b)', ringColor: 'var(--wb-warning, #FBBF24)', ringPct: 0.85, daysN: 3, title: t('gn_demo_title_mom', locale), person: t('gn_demo_person_mom', locale), ideasChip: true })}
                  {demoCard({ emoji: '💍', emojiBg: pinkSoft, stripColor: `linear-gradient(180deg,${C.accent},var(--wb-accent-strong, #A78BFA))`, ringColor: C.accent, ringPct: 0.58, daysN: 12, title: t('gn_demo_title_anniv', locale), person: t('gn_demo_person_anniv', locale) })}
                  {demoCard({ emoji: '🎄', emojiBg: greenSoft, stripColor: 'linear-gradient(180deg, var(--wb-success, #34D399), var(--wb-success, #6ee7b7))', ringColor: 'var(--wb-success, #4ADE80)', ringPct: 0.05, daysN: 261, title: t('gn_demo_title_ny', locale), person: t('gn_demo_person_ny', locale) })}
                </div>
              </div>
            </div>

            {/* Benefits 2x2 */}
            <div style={{ padding: '16px 20px 0', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              {benefit('🔔', C.accentSoft, C.accent, t('gn_feat_push_title', locale), t('gn_feat_push_body', locale))}
              {benefit('💡', orangeSoft, 'var(--wb-warning, #FBBF24)', t('gn_feat_ideas_title', locale), t('gn_feat_ideas_body', locale))}
              {benefit('🔁', pinkSoft, '#EC4899', t('gn_feat_recurring_title', locale), t('gn_feat_recurring_body', locale))}
              {benefit('∞', greenSoft, 'var(--wb-success, #4ADE80)', t('gn_feat_unlimited_title', locale), t('gn_feat_unlimited_body', locale))}
            </div>

            {/* Social proof */}
            <div style={{ margin: '14px 20px 0', padding: '12px 14px', borderRadius: 14, background: 'linear-gradient(135deg, rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.08), rgba(236,72,153,0.05))', border: `1px solid ${C.border}`, display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ display: 'flex', flexShrink: 0 }}>
                {[{ bg: orangeSoft, e: '🎂' }, { bg: pinkSoft, e: '💍' }, { bg: greenSoft, e: '🎄' }].map((a, i) => (
                  <div key={i} style={{ width: 28, height: 28, borderRadius: '50%', background: a.bg, border: `2px solid ${C.bg}`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, marginLeft: i === 0 ? 0 : -8 }}>{a.e}</div>
                ))}
              </div>
              <div style={{ fontSize: 12, color: C.textSec, lineHeight: 1.4 }}>{t('gn_social_proof', locale)}</div>
            </div>

            {/* Price block */}
            <div style={{ margin: '18px 20px 0', padding: 18, borderRadius: 18, background: 'linear-gradient(135deg, rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.14) 0%, rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.04) 100%)', border: '1px solid rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.28)', position: 'relative' as const, overflow: 'hidden' }}>
              <div style={{ position: 'absolute' as const, right: -8, top: -20, fontSize: 80, opacity: 0.06, pointerEvents: 'none' as const }}>⭐</div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, fontWeight: 700, color: 'var(--wb-success, #4ADE80)', background: greenSoft, padding: '3px 7px', borderRadius: 5, marginBottom: 10, textTransform: 'uppercase' as const, letterSpacing: '0.05em' }}>
                ★ {t('gn_price_ribbon', locale)}
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 4 }}>
                <span style={{ fontSize: 32, fontWeight: 800, color: C.text, lineHeight: 1, fontFamily: font }}>{gnAccess.priceXtr}<span style={{ color: 'var(--wb-warning, #FBBF24)' }}>⭐</span></span>
                <span style={{ fontSize: 13, fontWeight: 600, color: C.textSec }}>{t('gn_price_approx', locale)}</span>
              </div>
              <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>{t('gn_price_subtext', locale)}</div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                {[
                  { t: t('gn_price_chip_forever_t', locale), b: t('gn_price_chip_forever_b', locale) },
                  { t: t('gn_price_chip_unlimited_t', locale), b: t('gn_price_chip_unlimited_b', locale) },
                  { t: t('gn_price_chip_pro_t', locale), b: t('gn_price_chip_pro_b', locale) },
                ].map((c, i) => (
                  <div key={i} style={{ flex: 1, padding: '8px 10px', borderRadius: 10, background: 'rgba(255,255,255,0.03)', fontSize: 11, color: C.textSec, textAlign: 'center' as const, lineHeight: 1.3 }}>
                    <strong style={{ color: C.text, display: 'block', fontWeight: 700 }}>{c.t}</strong>
                    {c.b}
                  </div>
                ))}
              </div>
            </div>

            {/* FAQ */}
            <div style={{ padding: '16px 20px 0' }}>
              {[
                { q: t('gn_faq_q_notify', locale), a: t('gn_faq_a_notify', locale) },
                { q: t('gn_faq_q_recurring', locale), a: t('gn_faq_a_recurring', locale) },
                { q: t('gn_faq_q_pro', locale), a: t('gn_faq_a_pro', locale, { price: gnAccess.priceXtr }) },
              ].map((f, i) => (
                <div key={i} style={{ padding: '12px 0', borderTop: i === 0 ? 'none' : `1px solid ${C.border}`, paddingTop: i === 0 ? 0 : 12 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.text, display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ width: 16, height: 16, borderRadius: '50%', background: C.accentSoft, color: C.accent, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, flexShrink: 0 }}>?</span>
                    {f.q}
                  </div>
                  <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.5, paddingLeft: 24 }}>{f.a}</div>
                </div>
              ))}
            </div>

            {/* Sticky CTA — StickyCTAFade primitive (v2.1) */}
            <StickyCTAFade bottom="calc(86px + env(safe-area-inset-bottom, 0px))" style={{ zIndex: 50, position: 'fixed' as const }}>
              <Button variant="primary-gradient" size="lg" onClick={buyClick}>
                ⭐ {t('gn_upsell_cta', locale, { price: gnAccess.priceXtr })}
              </Button>
              <button onClick={() => setScreen('my-wishlists')} style={{ width: '100%', padding: '10px', borderRadius: 10, border: 'none', background: 'transparent', color: C.textMuted, fontSize: 13, cursor: 'pointer', fontFamily: font, marginTop: 6 }}>
                {t('gn_upsell_later', locale)}
              </button>
            </StickyCTAFade>
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════
          GIFT NOTES — HUB (occasion list + empty state)
          ══════════════════════════════════════════════ */}
      {screen === 'gift-notes' && (() => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const active = gnOccasions.filter((o: any) => o.status === 'ACTIVE' && o.daysUntil != null).sort((a: any, b: any) => (a.daysUntil ?? 999) - (b.daysUntil ?? 999));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const noDate = gnOccasions.filter((o: any) => o.status === 'ACTIVE' && o.daysUntil == null);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const done = gnOccasions.filter((o: any) => o.status === 'DONE');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const archived = gnOccasions.filter((o: any) => o.status === 'ARCHIVED');
        const typeEmoji: Record<string, string> = { BIRTHDAY: '🎂', ANNIVERSARY: '💍', HOLIDAY: '🎄', OTHER: '🎁' };
        const typeBg: Record<string, string> = { BIRTHDAY: 'rgba(251,191,36,0.12)', ANNIVERSARY: 'rgba(236,72,153,0.12)', HOLIDAY: 'rgba(74, 222, 128, 0.12)', OTHER: C.accentSoft };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const totalIdeas = gnOccasions.reduce((sum: number, o: any) => sum + (o.ideasCount ?? 0), 0);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const openOccasion = async (o: any) => {
          const r = await tgFetch(`/tg/gift-occasions/${o.id}`);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (r.ok) { setGnViewingOccasion((await r.json() as any).occasion); setGnShowActions(false); setGnShowEdit(false); setScreen('gift-notes-occasion'); }
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const card = (o: any, i: number) => {
          const isUrgent = o.status === 'ACTIVE' && o.daysUntil != null && o.daysUntil <= 7;
          const isSoon = o.status === 'ACTIVE' && o.daysUntil != null && o.daysUntil > 7;
          const isDone = o.status === 'DONE';
          const isArchived = o.status === 'ARCHIVED';
          const stripColor = isUrgent ? 'linear-gradient(180deg, var(--wb-warning, #FBBF24), #f59e0b)' : isSoon ? `linear-gradient(180deg, ${C.accent}, #a78bfa)` : isDone ? 'linear-gradient(180deg, #34D399, #6ee7b7)' : 'transparent';
          return (
            <div key={o.id} onClick={() => openOccasion(o)}
              style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: '14px 16px', marginBottom: 10, cursor: 'pointer', position: 'relative' as const, overflow: 'hidden', opacity: isArchived ? 0.5 : 1, animation: `fadeIn 0.3s ease ${0.05 + i * 0.04}s both`, transition: 'border-color 0.15s' }}>
              {/* Priority strip */}
              <div style={{ position: 'absolute' as const, left: 0, top: 0, bottom: 0, width: 3, background: stripColor }} />
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                {/* Emoji in colored bg */}
                <div style={{ width: 44, height: 44, borderRadius: 12, background: typeBg[o.type] ?? C.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0, opacity: isDone ? 0.6 : 1 }}>
                  {typeEmoji[o.type] ?? '🎁'}
                </div>
                {/* Info */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: isDone ? C.textSec : C.text, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' }}>{o.title}</div>
                  {o.personName && <div style={{ fontSize: 13, color: C.textSec, marginTop: 1 }}>{o.personName}</div>}
                </div>
                {/* Right side: countdown ring or done chip */}
                {o.status === 'ACTIVE' && o.daysUntil != null && (
                  <div style={{ width: 44, height: 44, position: 'relative' as const, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <svg viewBox="0 0 44 44" style={{ position: 'absolute' as const, inset: 0, transform: 'rotate(-90deg)' }}>
                      <circle cx="22" cy="22" r="19" fill="none" stroke={C.surface} strokeWidth="3" />
                      <circle cx="22" cy="22" r="19" fill="none" stroke={isUrgent ? 'var(--wb-warning, #FBBF24)' : C.accent} strokeWidth="3" strokeLinecap="round"
                        strokeDasharray="119" strokeDashoffset={Math.max(0, 119 - (119 * Math.min(o.daysUntil, 60) / 60))} />
                    </svg>
                    <div style={{ display: 'flex', flexDirection: 'column' as const, alignItems: 'center', zIndex: 1 }}>
                      <span style={{ fontSize: 13, fontWeight: 800, color: isUrgent ? 'var(--wb-warning, #FBBF24)' : C.accent }}>{o.daysUntil}</span>
                      <span style={{ fontSize: 8, fontWeight: 600, color: C.textMuted, marginTop: -2 }}>{t('gn_days_abbr', locale)}</span>
                    </div>
                  </div>
                )}
                {isDone && <span style={{ padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600, background: 'rgba(74, 222, 128, 0.1)', color: 'var(--wb-success, #4ADE80)' }}>✓</span>}
                {!isDone && o.daysUntil == null && <span style={{ color: C.textMuted, fontSize: 18 }}>›</span>}
              </div>
              {/* Meta chips */}
              {(o.status === 'ACTIVE') && (o.daysUntil != null || o.ideasCount > 0) && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' as const }}>
                  {o.daysUntil != null && (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600,
                      background: isUrgent ? 'rgba(251,191,36,0.12)' : o.daysUntil === 0 ? 'rgba(251, 113, 133, 0.12)' : C.surface,
                      color: isUrgent ? 'var(--wb-warning, #FBBF24)' : o.daysUntil === 0 ? 'var(--wb-danger, #FB7185)' : C.textSec }}>
                      {isUrgent && '🔥 '}{o.daysUntil === 0 ? t('gn_today', locale) : o.daysUntil > 0 ? t('gn_days_left', locale, { n: o.daysUntil }) : t('gn_days_overdue', locale, { n: Math.abs(o.daysUntil) })}
                    </span>
                  )}
                  {o.ideasCount > 0 && <span style={{ padding: '4px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600, background: C.accentSoft, color: C.accent }}>💡 {t('gn_ideas_count', locale, { n: o.ideasCount })}</span>}
                </div>
              )}
            </div>
          );
        };

        const sectionLabel = (icon: string, title: string, count: number, color?: string) => (
          <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: color ?? C.textMuted }}>{icon}</span> {title} <span style={{ background: C.surface, padding: '1px 7px', borderRadius: 10, fontSize: 10, fontWeight: 600 }}>{count}</span>
          </div>
        );

        const isEmpty = !gnLoading && gnOccasions.length === 0;
        const orangeSoft = 'rgba(251,191,36,0.12)';
        const pinkSoft = 'rgba(236,72,153,0.12)';
        const greenSoft = 'rgba(74, 222, 128, 0.12)';

        const templateCard = (p: { emoji: string; emojiBg: string; stripColor: string; title: string; type: 'BIRTHDAY' | 'ANNIVERSARY' | 'HOLIDAY' | 'OTHER'; recurrence: 'YEARLY' | 'NONE' }) => (
          <div
            onClick={() => { setGnFormTitle(p.title); setGnFormDate(''); setGnFormType(p.type); setGnFormRecurrence(p.recurrence); setGnFormPerson(''); setShowGnCreateOccasion(true); }}
            style={{ display: 'flex', alignItems: 'center', gap: 12, background: C.card, border: `1px solid ${C.border}`, borderRadius: 14, padding: '12px 14px', position: 'relative' as const, overflow: 'hidden', cursor: 'pointer', opacity: 0.9, transition: 'opacity 0.15s, border-color 0.15s' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; (e.currentTarget as HTMLElement).style.borderColor = C.accent; }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.opacity = '0.9'; (e.currentTarget as HTMLElement).style.borderColor = C.border; }}
          >
            <div style={{ position: 'absolute' as const, left: 0, top: 0, bottom: 0, width: 3, background: p.stripColor }} />
            <div style={{ width: 40, height: 40, borderRadius: 10, background: p.emojiBg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, flexShrink: 0 }}>{p.emoji}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.title}</div>
              <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{t('gn_empty_template_tap', locale)}</div>
            </div>
            <div style={{ color: C.accent, fontSize: 18, fontWeight: 600, flexShrink: 0, paddingRight: 4 }}>＋</div>
          </div>
        );

        return (
          <div style={{ padding: '16px 20px 120px', animation: 'fadeIn 0.3s ease', display: 'flex', flexDirection: 'column' as const, minHeight: 'calc(100vh - 60px)' }}>
            {/* Header */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <div>
                <h1 style={{ fontSize: 22, fontWeight: 800, color: C.text, fontFamily: font, margin: 0 }}>{t('gn_title', locale)}</h1>
                <div style={{ fontSize: 13, color: C.textSec, marginTop: 2, fontFamily: font }}>
                  {isEmpty
                    ? t('gn_empty_description', locale)
                    : `${gnOccasions.length} ${t('gn_events_count', locale)}${totalIdeas > 0 ? ` · ${totalIdeas} ${t('gn_ideas_count_label', locale)}` : ''}`}
                </div>
              </div>
            </div>

            {gnLoading && <div style={{ textAlign: 'center', color: C.textMuted, padding: 20 }}>...</div>}

            {/* Empty state — template cards + small chips */}
            {isEmpty && (
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column' as const }}>
                <div style={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 16, padding: 14, marginBottom: 14 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: C.accent, textTransform: 'uppercase' as const, letterSpacing: '0.06em', marginBottom: 10 }}>
                    💡 {t('gn_inspiration_header', locale)}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column' as const, gap: 8 }}>
                    {templateCard({ emoji: '🎂', emojiBg: orangeSoft, stripColor: 'linear-gradient(180deg,var(--wb-warning, #FBBF24),#f59e0b)', title: t('gn_empty_template_bday', locale), type: 'BIRTHDAY', recurrence: 'YEARLY' })}
                    {templateCard({ emoji: '💍', emojiBg: pinkSoft, stripColor: 'linear-gradient(180deg,#EC4899,#f472b6)', title: t('gn_empty_template_anniv', locale), type: 'ANNIVERSARY', recurrence: 'YEARLY' })}
                    {templateCard({ emoji: '🎄', emojiBg: greenSoft, stripColor: 'linear-gradient(180deg, var(--wb-success, #34D399), var(--wb-success, #6ee7b7))', title: t('gn_empty_template_holiday', locale), type: 'HOLIDAY', recurrence: 'YEARLY' })}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' as const, marginBottom: 'auto' }}>
                  {[
                    { label: t('gn_empty_small_birth', locale), title: t('occasion_type_birth', locale), type: 'OTHER' as const, recurrence: 'NONE' as const },
                    { label: t('gn_empty_small_graduation', locale), title: t('occasion_type_graduation', locale), type: 'OTHER' as const, recurrence: 'NONE' as const },
                    { label: t('gn_empty_small_housewarming', locale), title: t('occasion_type_housewarming', locale), type: 'OTHER' as const, recurrence: 'NONE' as const },
                    { label: t('gn_empty_small_other', locale), title: t('gn_type_other', locale), type: 'OTHER' as const, recurrence: 'NONE' as const },
                  ].map((chip, i) => (
                    <div key={i} onClick={() => { setGnFormTitle(chip.title); setGnFormDate(''); setGnFormType(chip.type); setGnFormRecurrence(chip.recurrence); setGnFormPerson(''); setShowGnCreateOccasion(true); }}
                      style={{ padding: '8px 12px', background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, fontSize: 12, color: C.textSec, cursor: 'pointer', fontFamily: font }}>
                      {chip.label}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Sections */}
            {active.length > 0 && <div style={{ marginBottom: 14 }}>{sectionLabel('⚡', t('gn_upcoming', locale), active.length, 'var(--wb-warning, #FBBF24)')}{active.map(card)}</div>}
            {noDate.length > 0 && <div style={{ marginBottom: 14, marginTop: active.length > 0 ? 4 : 0 }}>{sectionLabel('📌', t('gn_no_date', locale), noDate.length)}{noDate.map(card)}</div>}
            {done.length > 0 && <div style={{ marginBottom: 14, marginTop: 4 }}>{sectionLabel('✓', t('gn_done', locale), done.length, 'var(--wb-success, #4ADE80)')}{done.map(card)}</div>}
            {archived.length > 0 && <div style={{ marginBottom: 14, marginTop: 4 }}>{sectionLabel('📦', t('gn_archive', locale), archived.length)}{archived.map(card)}</div>}

            {/* v2.1 FAB — + bottom-right above FloatingNav */}
            <button
              onClick={() => { setGnFormTitle(''); setGnFormDate(''); setGnFormType('BIRTHDAY'); setGnFormRecurrence('YEARLY'); setGnFormPerson(''); setShowGnCreateOccasion(true); }}
              aria-label={isEmpty ? t('gn_empty_cta_custom', locale) : t('gn_add_occasion', locale)}
              style={{
                position: 'fixed', right: 20,
                bottom: 'calc(96px + env(safe-area-inset-bottom, 0px))',
                width: 58, height: 58, borderRadius: 20,
                background: 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))',
                color: '#fff', fontSize: 26, fontWeight: 300, lineHeight: 1,
                border: 'none', cursor: 'pointer', zIndex: 50,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 14px 40px var(--wb-accent-shadow), inset 0 1px 0 rgba(255,255,255,0.24), 0 1px 2px rgba(0,0,0,0.3)',
                transition: 'transform 0.15s ease',
              }}
            >
              +
            </button>
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════
          GIFT NOTES — OCCASION DETAIL (occasion + ideas + actions + edit sheet)
          ══════════════════════════════════════════════ */}
      {screen === 'gift-notes-occasion' && gnViewingOccasion && (() => {
        const o = gnViewingOccasion;
        const typeLabel = ({ BIRTHDAY: t('gn_type_birthday', locale), ANNIVERSARY: t('gn_type_anniversary', locale), HOLIDAY: t('gn_type_holiday', locale), OTHER: t('gn_type_other', locale) } as Record<string, string>)[o.type] ?? o.type;
        const typeEmoji: Record<string, string> = { BIRTHDAY: '🎂', ANNIVERSARY: '💍', HOLIDAY: '🎄', OTHER: '🎁' };
        const typeBg: Record<string, string> = { BIRTHDAY: 'rgba(251,191,36,0.12)', ANNIVERSARY: 'rgba(236,72,153,0.12)', HOLIDAY: 'rgba(74, 222, 128, 0.12)', OTHER: C.accentSoft };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ideas = (o.ideas ?? []) as any[];
        const recurrenceLabel: Record<string, string> = { YEARLY: t('recurrence_yearly_short', locale), MONTHLY: t('recurrence_monthly_short', locale), NONE: t('recurrence_once', locale) };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const refreshOccasion = async () => { const r = await tgFetch(`/tg/gift-occasions/${o.id}`); if (r.ok) setGnViewingOccasion((await r.json() as any).occasion); };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const refreshList = async () => { try { const r = await tgFetch('/tg/gift-occasions'); if (r.ok) setGnOccasions((await r.json() as any).occasions); } catch {} };
        return (
          <div style={{ animation: 'fadeIn 0.3s ease', paddingBottom: 120 }}>
            {/* Hero section */}
            <div style={{ position: 'relative' as const, padding: '24px 20px 20px', background: 'linear-gradient(160deg, rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.06) 0%, transparent 60%)' }}>
              <button onClick={() => setScreen('gift-notes')} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', border: 'none', color: C.accent, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: font, padding: 0, marginBottom: 16 }}>
                ← {t('gn_title', locale)}
              </button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <div style={{ width: 56, height: 56, borderRadius: 16, background: typeBg[o.type] ?? C.accentSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, flexShrink: 0 }}>
                  {typeEmoji[o.type] ?? '🎁'}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 22, fontWeight: 800, color: o.status === 'DONE' ? 'var(--wb-success, #4ADE80)' : C.text, fontFamily: font }}>{o.title}</div>
                  <div style={{ fontSize: 13, color: C.textSec, marginTop: 2 }}>{typeLabel}{o.personName ? ` · ${o.personName}` : ''}</div>
                </div>
              </div>
            </div>

            {/* Stat cards */}
            {o.status === 'ACTIVE' && (
              <div style={{ display: 'flex', gap: 8, margin: '16px 20px 0', padding: 0 }}>
                {o.daysUntil != null && (
                  <div style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, textAlign: 'center' as const }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: o.daysUntil <= 7 ? 'var(--wb-warning, #FBBF24)' : C.text, fontFamily: font }}>{o.daysUntil}</div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{t('gn_days_left_label', locale)}</div>
                  </div>
                )}
                <div style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, textAlign: 'center' as const }}>
                  <div style={{ fontSize: 20, fontWeight: 800, color: C.text, fontFamily: font }}>{ideas.length}</div>
                  <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{t('gn_ideas_count_label', locale)}</div>
                </div>
                {o.recurrence && o.recurrence !== 'NONE' && (
                  <div style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 12, textAlign: 'center' as const }}>
                    <div style={{ fontSize: 20, fontWeight: 800, color: C.accent }}>🔄</div>
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>{recurrenceLabel[o.recurrence] ?? ''}</div>
                  </div>
                )}
              </div>
            )}
            {o.status === 'DONE' && (
              <div style={{ margin: '12px 20px 0', padding: '10px 14px', background: 'rgba(74, 222, 128, 0.08)', borderRadius: 12, fontSize: 13, fontWeight: 600, color: 'var(--wb-success, #4ADE80)', textAlign: 'center' as const }}>
                ✓ {t('gn_occasion_completed', locale)}
              </div>
            )}

            {/* Note */}
            {o.note && (
              <div style={{ margin: '14px 20px 0', padding: '12px 16px', background: C.surface, borderRadius: 12, border: `1px solid ${C.border}` }}>
                <div style={{ fontSize: 13, color: C.textSec, lineHeight: 1.5 }}>{o.note}</div>
              </div>
            )}

            {/* Action buttons row */}
            <div style={{ padding: '12px 20px 0', display: 'flex', gap: 8 }}>
              <button onClick={() => { setGnEditTitle(o.title); setGnEditPerson(o.personName ?? ''); setGnEditNote(o.note ?? ''); setGnShowEdit(true); setGnShowActions(false); }}
                style={{ flex: 1, padding: 10, borderRadius: 12, border: `1px solid rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.15)`, background: C.accentSoft, color: C.accent, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: font, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                ✏️ {t('gn_edit_occasion', locale)}
              </button>
              <button onClick={() => setGnShowActions(!gnShowActions)}
                style={{ padding: '10px 14px', borderRadius: 12, border: `1px solid ${C.border}`, background: C.surface, color: C.textSec, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: font }}>
                ⋯
              </button>
            </div>

            {/* Actions menu — compact sheet */}
            {gnShowActions && (
              <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, margin: '12px 20px 0', overflow: 'hidden' }}>
                {o.status === 'ACTIVE' && <button onClick={async () => { setGnShowActions(false); await tgFetch(`/tg/gift-occasions/${o.id}/complete`, { method: 'POST', idempotency: { action: `gift-occasion.complete:${o.id}` } }); pushToast(t('gn_occasion_completed', locale), 'success'); await refreshList(); setScreen('gift-notes'); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', border: 'none', background: 'none', width: '100%', textAlign: 'left' as const, cursor: 'pointer', fontSize: 14, fontWeight: 500, color: 'var(--wb-success, #4ADE80)', fontFamily: font }}>
                  <span style={{ fontSize: 15, width: 22, textAlign: 'center' as const, flexShrink: 0 }}>✅</span> {t('gn_complete', locale)}
                </button>}
                {o.status === 'ACTIVE' && <button onClick={async () => { setGnShowActions(false); await tgFetch(`/tg/gift-occasions/${o.id}/archive`, { method: 'POST', idempotency: { action: `gift-occasion.archive:${o.id}` } }); pushToast(t('gn_archive_occasion', locale), 'success'); await refreshList(); setScreen('gift-notes'); }}
                  style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', border: 'none', borderTop: `1px solid ${C.border}`, background: 'none', width: '100%', textAlign: 'left' as const, cursor: 'pointer', fontSize: 14, fontWeight: 500, color: C.text, fontFamily: font }}>
                  <span style={{ fontSize: 15, width: 22, textAlign: 'center' as const, flexShrink: 0 }}>📦</span> {t('gn_archive_occasion', locale)}
                </button>}
                <button onClick={async () => {
                  setGnShowActions(false);
                  if (!confirm(t('gn_confirm_delete', locale))) return;
                  await tgFetch(`/tg/gift-occasions/${o.id}`, { method: 'DELETE', idempotency: { action: `gift-occasion.delete:${o.id}` } });
                  pushToast(t('gn_occasion_deleted', locale), 'success');
                  await refreshList();
                  setScreen('gift-notes');
                }} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', border: 'none', borderTop: `1px solid ${C.border}`, background: 'none', width: '100%', textAlign: 'left' as const, cursor: 'pointer', fontSize: 14, fontWeight: 500, color: '#EF4444', fontFamily: font }}>
                  <span style={{ fontSize: 15, width: 22, textAlign: 'center' as const, flexShrink: 0 }}>🗑</span> {t('gn_delete_occasion', locale)}
                </button>
              </div>
            )}

            {/* Ideas section */}
            <div style={{ padding: '16px 20px 0' }}>
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: C.textMuted, textTransform: 'uppercase' as const, letterSpacing: '0.06em', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ color: C.accent }}>💡</span> {t('gn_ideas_label', locale)} <span style={{ background: C.surface, padding: '1px 7px', borderRadius: 10, fontSize: 10, fontWeight: 600 }}>{ideas.length}</span>
                </div>
              </div>

              {ideas.length === 0 && (
                <div style={{ textAlign: 'center' as const, padding: '32px 20px' }}>
                  <div style={{ fontSize: 40, marginBottom: 10 }}>💡</div>
                  <div style={{ fontSize: 15, fontWeight: 600, fontFamily: font, marginBottom: 4 }}>{t('gn_no_ideas_title', locale)}</div>
                  <div style={{ fontSize: 13, color: C.textSec, lineHeight: 1.4 }}>{t('gn_no_ideas_description', locale)}</div>
                </div>
              )}

              {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
              {ideas.map((idea: any, i: number) => (
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                <Card key={idea.id} variant="default" style={{ padding: '14px 16px', marginBottom: 8, opacity: idea.status === 'DONE' ? 0.5 : 1, animation: `fadeIn 0.3s ease ${0.05 + i * 0.03}s both` }}>
                  <div style={{ fontSize: 15, fontWeight: 600, color: C.text, textDecoration: idea.status === 'DONE' ? 'line-through' : 'none', lineHeight: 1.35, marginBottom: 4, display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical' as never, overflow: 'hidden' }}>{idea.text}</div>
                  {idea.link && <div style={{ fontSize: 12, color: C.accent, marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{idea.link}</div>}
                  {idea.price != null && <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginTop: 4 }}>{idea.price.toLocaleString()} {idea.currency ?? '₽'}</div>}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
                    <span style={{ fontSize: 11, color: C.textMuted }}>{new Date(idea.createdAt).toLocaleDateString(localeToBCP47(locale), { day: 'numeric', month: 'short' })}</span>
                    {idea.status === 'DONE' && <span style={{ fontSize: 11, color: 'var(--wb-success, #4ADE80)', fontWeight: 600 }}>✓ {t('gn_idea_status_selected', locale)}</span>}
                    {idea.status !== 'DONE' && <button onClick={async (e) => { e.stopPropagation(); await tgFetch(`/tg/gift-occasion-ideas/${idea.id}/complete`, { method: 'POST', idempotency: { action: `gift-occasion-idea.complete:${idea.id}` } }); await refreshOccasion(); pushToast(t('gn_idea_completed', locale), 'success'); }}
                      style={{ fontSize: 11, fontWeight: 600, color: 'var(--wb-success, #4ADE80)', background: 'none', border: 'none', cursor: 'pointer', fontFamily: font, padding: 0 }}>✓ {t('gn_complete', locale)}</button>}
                    <button onClick={async (e) => { e.stopPropagation(); await tgFetch(`/tg/gift-occasion-ideas/${idea.id}`, { method: 'DELETE', idempotency: { action: `gift-occasion-idea.delete:${idea.id}` } }); await refreshOccasion(); }}
                      style={{ fontSize: 11, fontWeight: 600, color: '#EF4444', background: 'none', border: 'none', cursor: 'pointer', fontFamily: font, padding: 0 }}>✕</button>
                  </div>
                </Card>
              ))}

              {/* v2.1 FAB — + idea bottom-right above FloatingNav */}
              <button
                onClick={() => { setGnIdeaText(''); setGnIdeaLink(''); setShowGnAddIdea(true); }}
                aria-label={t('gn_add_idea', locale)}
                style={{
                  position: 'fixed', right: 20,
                  bottom: 'calc(96px + env(safe-area-inset-bottom, 0px))',
                  width: 58, height: 58, borderRadius: 20,
                  background: 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))',
                  color: '#fff', fontSize: 26, fontWeight: 300, lineHeight: 1,
                  border: 'none', cursor: 'pointer', zIndex: 50,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  boxShadow: '0 14px 40px var(--wb-accent-shadow), inset 0 1px 0 rgba(255,255,255,0.24), 0 1px 2px rgba(0,0,0,0.3)',
                  transition: 'transform 0.15s ease',
                }}
              >
                +
              </button>
            </div>

            {/* Edit BottomSheet */}
            <BottomSheet isOpen={gnShowEdit} onClose={() => setGnShowEdit(false)} title={t('gn_edit_occasion', locale)}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <label style={{ fontSize: 12, color: C.textMuted, marginBottom: 4, display: 'block' }}>{t('gn_form_title', locale)}</label>
                  <div style={{ position: 'relative' as const }}>
                    <input value={gnEditTitle} onChange={e => { if (e.target.value.length <= 150) setGnEditTitle(e.target.value); }} style={{ width: '100%', padding: '10px 32px 10px 12px', borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface, color: C.text, fontSize: 14, fontFamily: font, boxSizing: 'border-box' as const }} />
                    {gnEditTitle && <button onClick={() => setGnEditTitle('')} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#555', fontSize: 14, cursor: 'pointer', padding: 0 }}>✕</button>}
                  </div>
                  <div style={{ fontSize: 10, color: C.textMuted, textAlign: 'right' as const, marginTop: 2 }}>{gnEditTitle.length} / 150</div>
                </div>
                <div>
                  <label style={{ fontSize: 12, color: C.textMuted, marginBottom: 4, display: 'block' }}>{t('gn_form_person', locale)}</label>
                  <div style={{ position: 'relative' as const }}>
                    <input value={gnEditPerson} onChange={e => { if (e.target.value.length <= 50) setGnEditPerson(e.target.value); }} placeholder={t('gn_ph_person', locale)} style={{ width: '100%', padding: '10px 32px 10px 12px', borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface, color: C.text, fontSize: 14, fontFamily: font, boxSizing: 'border-box' as const }} />
                    {gnEditPerson && <button onClick={() => setGnEditPerson('')} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#555', fontSize: 14, cursor: 'pointer', padding: 0 }}>✕</button>}
                  </div>
                  <div style={{ fontSize: 10, color: C.textMuted, textAlign: 'right' as const, marginTop: 2 }}>{gnEditPerson.length} / 50</div>
                </div>
                <div>
                  <label style={{ fontSize: 12, color: C.textMuted, marginBottom: 4, display: 'block' }}>{t('gn_description', locale)}</label>
                  <div style={{ position: 'relative' as const }}>
                    <textarea value={gnEditNote} onChange={e => { if (e.target.value.length <= 300) setGnEditNote(e.target.value); }} placeholder={t('gn_ph_note', locale)} style={{ width: '100%', padding: '10px 12px', borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface, color: C.text, fontSize: 14, fontFamily: font, boxSizing: 'border-box' as const, minHeight: 60, resize: 'none' as const }} />
                  </div>
                  <div style={{ fontSize: 10, color: C.textMuted, textAlign: 'right' as const, marginTop: 2 }}>{gnEditNote.length} / 300</div>
                </div>
                <Button
                  variant="primary-gradient"
                  disabled={!gnEditTitle.trim()}
                  onClick={async () => {
                    await tgFetch(`/tg/gift-occasions/${o.id}`, { method: 'PATCH', body: JSON.stringify({ title: gnEditTitle.trim(), personName: gnEditPerson.trim() || null, note: gnEditNote.trim() || null }), idempotency: { action: `gift-occasion.update:${o.id}` } });
                    setGnShowEdit(false);
                    pushToast(t('gn_occasion_updated', locale), 'success');
                    await refreshOccasion();
                  }}
                >
                  {t('save', locale)}
                </Button>
              </div>
            </BottomSheet>
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════
          GIFT NOTES — ALWAYS-RENDERED BOTTOM SHEETS
          ──────────────────────────────────────────────
          Always rendered (gated by the parent guard on any gift-notes-* screen
          being active). The sheets themselves only display when their `isOpen`
          state is true; they are opened from within the screens above.
          ══════════════════════════════════════════════ */}

      {/* Create Occasion BottomSheet — opened from hub (template card / FAB / chip)
          and from the onboarding-finish-create handler. */}
      <BottomSheet isOpen={showGnCreateOccasion} onClose={() => setShowGnCreateOccasion(false)} title={t('gn_add_occasion', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, color: C.textMuted, marginBottom: 4, display: 'block' }}>{t('gn_form_title', locale)}</label>
            <div style={{ position: 'relative' as const }}>
              <input value={gnFormTitle} onChange={e => { if (e.target.value.length <= 150) setGnFormTitle(e.target.value); }} placeholder={t('gn_ph_title', locale)} style={{ width: '100%', padding: '10px 32px 10px 12px', borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface, color: C.text, fontSize: 14, fontFamily: font, boxSizing: 'border-box' as const }} />
              {gnFormTitle && <button onClick={() => setGnFormTitle('')} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#555', fontSize: 14, cursor: 'pointer', padding: 0 }}>✕</button>}
            </div>
            <div style={{ fontSize: 10, color: '#444', textAlign: 'right' as const, marginTop: 2 }}>{gnFormTitle.length} / 150</div>
          </div>
          <div>
            <label style={{ fontSize: 12, color: C.textMuted, marginBottom: 4, display: 'block' }}>{t('gn_form_person', locale)}</label>
            <div style={{ position: 'relative' as const }}>
              <input value={gnFormPerson} onChange={e => { if (e.target.value.length <= 50) setGnFormPerson(e.target.value); }} placeholder={t('gn_ph_person', locale)} style={{ width: '100%', padding: '10px 32px 10px 12px', borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface, color: C.text, fontSize: 14, fontFamily: font, boxSizing: 'border-box' as const }} />
              {gnFormPerson && <button onClick={() => setGnFormPerson('')} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#555', fontSize: 14, cursor: 'pointer', padding: 0 }}>✕</button>}
            </div>
            <div style={{ fontSize: 10, color: '#444', textAlign: 'right' as const, marginTop: 2 }}>{gnFormPerson.length} / 50</div>
          </div>
          <div>
            <label style={{ fontSize: 12, color: C.textMuted, marginBottom: 4, display: 'block' }}>{t('gn_form_date', locale)}</label>
            <div style={{ position: 'relative' as const }}>
              <input type="date" value={gnFormDate} onChange={e => setGnFormDate(e.target.value)} style={{ width: '100%', padding: '10px 32px 10px 12px', borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface, color: gnFormDate ? C.text : 'transparent', fontSize: 14, fontFamily: font, boxSizing: 'border-box' as const, minHeight: 42 }} />
              {!gnFormDate && <span style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', fontSize: 14, color: C.textMuted, pointerEvents: 'none' }}>{t('gn_date_not_set', locale)}</span>}
              {gnFormDate && <button onClick={(e) => { e.stopPropagation(); setGnFormDate(''); }} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#555', fontSize: 14, cursor: 'pointer', padding: 0 }}>✕</button>}
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12, color: C.textMuted, marginBottom: 4, display: 'block' }}>{t('gn_form_type', locale)}</label>
            <div style={{ display: 'flex', gap: 6 }}>
              {([
                { type: 'BIRTHDAY' as const, emoji: '🎂', label: t('occasion_type_bday_short', locale) },
                { type: 'ANNIVERSARY' as const, emoji: '💍', label: t('occasion_type_anniv_short', locale) },
                { type: 'HOLIDAY' as const, emoji: '🎄', label: t('gn_type_holiday', locale) },
                { type: 'OTHER' as const, emoji: '🎁', label: t('gn_type_other', locale) },
              ]).map(tp => (
                <button key={tp.type} onClick={() => setGnFormType(tp.type)} style={{ flex: 1, padding: '10px 4px', borderRadius: 10, border: gnFormType === tp.type ? `1px solid rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.3)` : `1px solid ${C.border}`, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: font, background: gnFormType === tp.type ? C.accentSoft : C.surface, color: gnFormType === tp.type ? C.accent : C.textMuted, whiteSpace: 'nowrap' as const, display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 2 }}>
                  <span style={{ fontSize: 16 }}>{tp.emoji}</span>
                  {tp.label}
                </button>
              ))}
            </div>
          </div>
          {gnFormDate && (
            <div>
              <label style={{ fontSize: 12, color: C.textMuted, marginBottom: 4, display: 'block' }}>{t('gn_form_recurrence', locale)}</label>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['NONE', 'YEARLY', 'MONTHLY'] as const).map(r => (
                  <button key={r} onClick={() => setGnFormRecurrence(r)} style={{ flex: 1, padding: '10px 4px', borderRadius: 10, border: gnFormRecurrence === r ? `1px solid rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.3)` : `1px solid ${C.border}`, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: font, background: gnFormRecurrence === r ? C.accentSoft : C.surface, color: gnFormRecurrence === r ? C.accent : C.textSec, whiteSpace: 'nowrap' as const }}>{({ NONE: t('gn_recurrence_none', locale), YEARLY: t('gn_recurrence_yearly', locale), MONTHLY: t('gn_recurrence_monthly', locale) })[r]}</button>
                ))}
              </div>
            </div>
          )}
          <Button
            variant="primary-gradient"
            disabled={!gnFormTitle.trim()}
            style={{ marginTop: 4 }}
            onClick={async () => {
              const r = await tgFetch('/tg/gift-occasions', { method: 'POST', body: JSON.stringify({ title: gnFormTitle.trim(), eventDate: gnFormDate || undefined, type: gnFormType, recurrence: gnFormDate ? gnFormRecurrence : 'NONE', personName: gnFormPerson.trim() || undefined }), idempotency: { action: 'gift-occasion.create' } });
              if (r.ok) {
                setShowGnCreateOccasion(false);
                pushToast(t('gn_add_occasion', locale), 'success');
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                try { const or = await tgFetch('/tg/gift-occasions'); if (or.ok) setGnOccasions((await or.json() as any).occasions); } catch {}
              } else {
                // Gift Notes is gated by requireGiftNotes — post-2026-05
                // unification this returns 402 addon_required. Route to the
                // dedicated paywall screen instead of leaking machine codes.
                const body = await r.json().catch(() => null) as { error?: string; feature?: string } | null;
                const parsed = parsePaywallError(r.status, body);
                if (parsed?.feature === 'gift_notes' || body?.error === 'gift_notes_required') {
                  setShowGnCreateOccasion(false);
                  setScreen('gift-notes-paywall');
                  return;
                }
                pushToast(parsed?.message ?? body?.error ?? 'Error', 'error');
              }
            }}
          >
            {t('gn_add_occasion', locale)}
          </Button>
        </div>
      </BottomSheet>

      {/* Add Idea BottomSheet — opened from occasion-detail FAB. */}
      <BottomSheet isOpen={showGnAddIdea} onClose={() => setShowGnAddIdea(false)} title={t('gn_add_idea', locale)}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ fontSize: 12, color: C.textMuted, marginBottom: 4, display: 'block' }}>{t('gn_form_idea_text', locale)}</label>
            <div style={{ position: 'relative' as const }}>
              <input value={gnIdeaText} onChange={e => { if (e.target.value.length <= 500) setGnIdeaText(e.target.value); }} placeholder={t('gn_ph_idea', locale)} style={{ width: '100%', padding: '10px 32px 10px 12px', borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface, color: C.text, fontSize: 14, fontFamily: font, boxSizing: 'border-box' as const }} />
              {gnIdeaText && <button onClick={() => setGnIdeaText('')} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#555', fontSize: 14, cursor: 'pointer', padding: 0 }}>✕</button>}
            </div>
            <div style={{ fontSize: 10, color: '#444', textAlign: 'right' as const, marginTop: 2 }}>{gnIdeaText.length} / 500</div>
          </div>
          <div>
            <label style={{ fontSize: 12, color: C.textMuted, marginBottom: 4, display: 'block' }}>{t('gn_form_idea_link', locale)}</label>
            <div style={{ position: 'relative' as const }}>
              <input value={gnIdeaLink} onChange={e => setGnIdeaLink(e.target.value)} placeholder={t('gn_ph_link', locale)} style={{ width: '100%', padding: '10px 32px 10px 12px', borderRadius: 10, border: `1px solid ${C.border}`, background: C.surface, color: C.text, fontSize: 14, fontFamily: font, boxSizing: 'border-box' as const }} />
              {gnIdeaLink && <button onClick={() => setGnIdeaLink('')} style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: '#555', fontSize: 14, cursor: 'pointer', padding: 0 }}>✕</button>}
            </div>
          </div>
          <Button
            variant="primary-gradient"
            disabled={!gnIdeaText.trim()}
            onClick={async () => {
              if (!gnViewingOccasion) return;
              const r = await tgFetch(`/tg/gift-occasions/${gnViewingOccasion.id}/ideas`, { method: 'POST', body: JSON.stringify({ text: gnIdeaText.trim(), link: gnIdeaLink.trim() || undefined }), idempotency: { action: `gift-occasion-idea.create:${gnViewingOccasion.id}` } });
              if (r.ok) {
                setShowGnAddIdea(false);
                pushToast(t('gn_idea_saved', locale), 'success');
                const or = await tgFetch(`/tg/gift-occasions/${gnViewingOccasion.id}`);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                if (or.ok) setGnViewingOccasion((await or.json() as any).occasion);
              } else {
                // Same gift-notes paywall handling as the occasion-create site.
                const body = await r.json().catch(() => null) as { error?: string; feature?: string } | null;
                const parsed = parsePaywallError(r.status, body);
                if (parsed?.feature === 'gift_notes' || body?.error === 'gift_notes_required') {
                  setShowGnAddIdea(false);
                  setScreen('gift-notes-paywall');
                  return;
                }
                pushToast(parsed?.message ?? body?.error ?? 'Error', 'error');
              }
            }}
          >
            {t('gn_add_idea', locale)}
          </Button>
        </div>
      </BottomSheet>
    </>
  );
}
