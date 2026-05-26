// ReferralRoot — F4 Wave A++ cluster file (REFACTOR_MINIAPP_TSX_PLAN).
//
// Bundles BOTH referral screens (~568 LOC of JSX combined) into a single
// lazy-loaded module:
//   1. referral          — main program screen (~401 LOC)
//      hero, stats strip, cap indicator, share link, share-sheet,
//      rules-sheet, "how it works" block, history preview CTA
//   2. referral-history  — paged invitee history (~167 LOC)
//      per-attribution status card, pending-progress checklist,
//      cursor pagination button
//
// Loaded via `next/dynamic({ ssr: false })` from
// `apps/web/app/miniapp/MiniApp.tsx`, so the chunk doesn't ship with the
// initial Mini App page bundle — referral code only downloads when a user
// opens the referral tile from Settings or the home banner (cold path:
// settings-side, not first-paint).
//
// State strategy: NO dedicated state hook. Referral state lives in
// MiniAppInner alongside callers (openReferralScreen,
// openReferralHistoryScreen, loadReferralMe, loadReferralHistory) and
// the home-banner / paywall entry points. Extracting to a hook would
// split state from helpers — keep state inline and forward via ctx,
// same trade-off as ProfileRoot/PublicProfileRoot.
//
// Implementation discipline:
// - JSX is copied verbatim from MiniApp.tsx — DO NOT migrate styles or
//   refactor logic in this PR. Bundle savings only; cosmetic changes
//   ride future on-touch PRs.
// - The two local helpers `copyLink` / `shareToTelegram` / `systemShare`
//   that lived inside the referral screen IIFE stay inline here — they
//   close over `referralMe.link` / `referralMe.shareText` and the
//   `setReferralShareSheet` setter.
// - `ctx` is typed as a loose interface with `any` where the original
//   was loose; tightening to the actual ReferralMe / ReferralHistoryItem
//   DTOs is a separate concern (those types are declared inline in
//   MiniAppInner today).

'use client';

import React from 'react';
import { ListRow, SectionHeader, StatTile } from '@wishlist/ui';
import { t, localeToBCP47, type Locale } from '@wishlist/shared';
import type { ReferralState } from '../../hooks/useReferralState';
import type {
  LegacyColorBag, PushToast, TrackEvent,
} from '../../_shared/closure-types';

export type ReferralRootCtx = ReferralState & {
  // module-level constants forwarded from MiniApp.tsx
  C: LegacyColorBag;
  font: string;
  locale: Locale;
  // helpers + setters from MiniAppInner closure — real signatures from
  // `_shared/closure-types`.
  pushToast: PushToast;
  trackEvent: TrackEvent;
  // referral state (referralMe / referralHistory / referralRulesConfig /
  // share + rules sheets + loaders) provided by ReferralState intersection.
  loadReferralMe: () => Promise<void> | void;
  loadReferralHistory: (reset?: boolean) => Promise<void> | void;
  openReferralHistoryScreen: () => void;
};

export interface ReferralRootProps {
  /** Active screen name; controls which of the 2 sub-blocks renders. */
  screen: string;
  /** Bag of closure refs forwarded from MiniAppInner. See `ReferralRootCtx`. */
  ctx: ReferralRootCtx;
}

/**
 * Lazy-loaded Referral cluster root.
 *
 * Destructures everything the JSX needs from `ctx` at the top, then
 * returns a fragment containing the 2 inline screen blocks. Each block
 * is guarded by a `screen === '<name>'` check exactly as in the original
 * MiniApp.tsx — that keeps the JSX byte-identical.
 */
export function ReferralRoot(props: ReferralRootProps) {
  const { ctx, screen } = props;

  // ── Module-level constants forwarded from MiniApp.tsx ────────────────
  const { C, font, locale } = ctx;

  // ── Helpers + state from MiniAppInner closure ────────────────────────
  const {
    pushToast, trackEvent,
    referralMe, referralMeLoading, referralMeError, loadReferralMe,
    referralHistory, referralHistoryLoading, referralHistoryHasMore, loadReferralHistory,
    referralShareSheet, setReferralShareSheet,
    referralRulesOpen, setReferralRulesOpen,
    referralRulesConfig,
    openReferralHistoryScreen,
  } = ctx;

  return (
    <>
      {/* ══════════════════════════════════════════════
          REFERRAL PROGRAM — main screen
          ══════════════════════════════════════════════ */}
      {screen === 'referral' && (() => {
        // ── Local helpers ───────────────────────────────────────────────
        const copyLink = async () => {
          if (!referralMe?.link) return;
          try {
            await navigator.clipboard.writeText(referralMe.link);
            pushToast(t('referral_link_copied_toast', locale), 'success');
            trackEvent('referral.link_copied');
          } catch {
            // Fallback for older WebViews
            const ta = document.createElement('textarea');
            ta.value = referralMe.link;
            ta.style.position = 'fixed'; ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); pushToast(t('referral_link_copied_toast', locale), 'success'); trackEvent('referral.link_copied'); } catch {}
            document.body.removeChild(ta);
          }
        };
        const shareToTelegram = () => {
          if (!referralMe?.link || !referralMe?.shareText) return;
          // Use Telegram's native share flow: openTelegramLink with a t.me/share/url?url=&text=
          // Fallback: window.open(shareUrl) if WebApp API missing.
          const tg = (window as any).Telegram?.WebApp;
          const text = referralMe.shareText;
          // tg://msg_url will open the share picker natively inside Telegram.
          const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(referralMe.link)}&text=${encodeURIComponent(text)}`;
          trackEvent('referral.share_intent', { channel: 'telegram' });
          if (tg?.openTelegramLink) {
            tg.openTelegramLink(shareUrl);
          } else {
            window.open(shareUrl, '_blank');
          }
          trackEvent('referral.share_completed', { channel: 'telegram' });
          setReferralShareSheet(false);
        };
        const systemShare = async () => {
          if (!referralMe?.link || !referralMe?.shareText) return;
          trackEvent('referral.share_intent', { channel: 'system' });
          // navigator.share is widely supported in modern Telegram WebViews.
          if (typeof navigator.share === 'function') {
            try {
              await navigator.share({ title: 'WishBoard', text: referralMe.shareText, url: referralMe.link });
              trackEvent('referral.share_completed', { channel: 'system' });
            } catch (err: unknown) {
              // User cancelled — no analytics noise, just no-op.
              const name = (err as { name?: string } | null)?.name;
              if (name !== 'AbortError') {
                trackEvent('referral.share_failed', { channel: 'system', error: String(err) });
              }
            }
          } else {
            // Fallback: copy + toast.
            await copyLink();
          }
          setReferralShareSheet(false);
        };

        // ── Header (shared) ─────────────────────────────────────────────
        const ScreenHeader = (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: '-0.02em' }}>
              {t('referral_screen_title', locale)}
            </div>
          </div>
        );

        // ── Loading / error / disabled states ───────────────────────────
        if (referralMeLoading && !referralMe) {
          return (
            <div style={{ padding: '16px 20px 120px', animation: 'fadeIn 0.3s ease' }}>
              {ScreenHeader}
              <div style={{ textAlign: 'center', padding: 40, color: C.textMuted, fontSize: 14 }}>
                {t('referral_loading', locale)}
              </div>
            </div>
          );
        }
        if (referralMeError && !referralMe) {
          return (
            <div style={{ padding: '16px 20px 120px', animation: 'fadeIn 0.3s ease' }}>
              {ScreenHeader}
              <div style={{ textAlign: 'center', padding: 40, color: C.textMuted, fontSize: 14 }}>
                <div style={{ marginBottom: 12 }}>{t('referral_error', locale)}</div>
                <button
                  onClick={() => { void loadReferralMe(); }}
                  style={{ padding: '10px 20px', borderRadius: 12, background: C.surface, border: `1px solid ${C.border}`, color: C.accent, fontSize: 14, fontWeight: 600, cursor: 'pointer' }}>
                  {t('referral_error_retry', locale)}
                </button>
              </div>
            </div>
          );
        }
        if (!referralMe) return null;

        // Program disabled / out of rollout: show minimal placeholder.
        if (!referralMe.enabled) {
          return (
            <div style={{ padding: '16px 20px 120px', animation: 'fadeIn 0.3s ease' }}>
              {ScreenHeader}
              <div style={{ textAlign: 'center', padding: '40px 24px', background: C.card, border: `1px solid ${C.border}`, borderRadius: 20 }}>
                <div style={{ fontSize: 48, marginBottom: 14 }}>🎁</div>
                <SectionHeader center marginBottom={8}>{t('referral_disabled_title', locale)}</SectionHeader>
                <div style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.5, maxWidth: 320, margin: '0 auto' }}>
                  {t('referral_disabled_body', locale)}
                </div>
              </div>
            </div>
          );
        }

        // ── Active program UI ───────────────────────────────────────────
        const daysPerRef = referralMe.reward.daysPerRef;
        const hasInvited = referralMe.stats.totalAttributions > 0;
        const atCap = referralMe.caps.atMonthlyCap || referralMe.caps.atYearlyCap;
        const totalRewardDays = referralMe.stats.rewarded * daysPerRef;

        // Format a cap-reset date: 1st of next month. Keep local-calendar arithmetic
        // so the label matches the user's wall-clock — server uses rolling 30d, but
        // for UX we show the month boundary, which is close enough.
        const now = new Date();
        const capResetDate = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        // Locale-aware short date — Intl picks the right order (day-first
        // vs month-first) per locale automatically. Replaces a hand-rolled
        // RU/EN ternary that broke for hi/es/ar/zh-CN users.
        const capResetLabel = new Intl.DateTimeFormat(localeToBCP47(locale), { day: 'numeric', month: 'short' }).format(capResetDate);

        // Pending attribution cards (from history cache if loaded; otherwise a
        // placeholder derived from /me stats). For the main screen we only show
        // the aggregate — detailed progress lives on the history screen.
        const showProgressStrip = referralMe.stats.pendingActivation > 0;

        return (
          <div style={{ padding: '16px 20px 120px', animation: 'fadeIn 0.3s ease' }}>
            {ScreenHeader}

            {/* ── Hero ────────────────────────────────────────────────── */}
            <div style={{
              position: 'relative',
              textAlign: 'center',
              padding: hasInvited ? '18px 16px 16px' : '28px 20px 24px',
              marginBottom: 14,
              borderRadius: 20,
              background: `radial-gradient(circle at 50% 0%, rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.133) 0%, transparent 60%), ${C.card}`,
              border: `1px solid ${C.border}`,
              overflow: 'hidden',
            }}>
              <div style={{ fontSize: hasInvited ? 32 : 44, marginBottom: hasInvited ? 6 : 10 }}>🎁</div>
              <div style={{ fontSize: hasInvited ? 17 : 22, fontWeight: 800, color: C.text, lineHeight: 1.2, marginBottom: hasInvited ? 0 : 6, letterSpacing: '-0.01em' }}>
                {hasInvited
                  ? t('referral_hero_title_active', locale, { days: String(daysPerRef) })
                  : t('referral_hero_title_empty', locale)}
              </div>
              {!hasInvited && (
                <div style={{ fontSize: 13, color: C.textSec, lineHeight: 1.45, maxWidth: 320, margin: '0 auto' }}>
                  {t('referral_hero_subtitle', locale, { days: String(daysPerRef) })}
                </div>
              )}
            </div>

            {/* ── Stats strip (only when has progress) — StatTile primitive ── */}
            {hasInvited && (
              <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                <StatTile
                  n={referralMe.stats.totalAttributions}
                  label={t('referral_stat_invited', locale)}
                  tone="accent"
                />
                <StatTile
                  n={referralMe.stats.pendingActivation + referralMe.stats.qualified}
                  label={t('referral_stat_in_progress', locale)}
                  tone="neutral"
                />
                <StatTile
                  n={`+${totalRewardDays}`}
                  label={t('referral_stat_reward_days', locale)}
                  tone="success"
                />
              </div>
            )}

            {/* ── Cap indicator ──────────────────────────────────────── */}
            {hasInvited && (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px', marginBottom: 12,
                borderRadius: 12, background: atCap ? 'rgba(251,191,36,0.1)' : C.surface,
                border: `1px solid ${atCap ? 'rgba(251,191,36,0.25)' : C.border}`,
                fontSize: 12, color: atCap ? C.orange : C.textSec, lineHeight: 1.4,
              }}>
                <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {Array.from({ length: referralMe.caps.monthlyCap }).map((_, i) => (
                    <div key={i} style={{ width: 7, height: 7, borderRadius: '50%', background: i < referralMe.caps.monthlyUsed ? C.accent : 'rgba(255,255,255,0.12)' }} />
                  ))}
                </div>
                <span style={{ flex: 1 }}>
                  {atCap
                    ? t('referral_cap_at_limit', locale)
                    : t('referral_cap_label', locale, { used: String(referralMe.caps.monthlyUsed), cap: String(referralMe.caps.monthlyCap) })}
                </span>
                <span style={{ color: C.textMuted, flexShrink: 0, fontSize: 11 }}>
                  {t('referral_cap_reset_fmt', locale, { date: capResetLabel })}
                </span>
              </div>
            )}

            {/* ── Link display ──────────────────────────────────────── */}
            {referralMe.link && (
              <div
                onClick={copyLink}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px',
                  marginBottom: 10, borderRadius: 12, background: C.surface, border: `1px solid ${C.border}`,
                  cursor: 'pointer',
                }}>
                <div style={{ fontSize: 16, flexShrink: 0 }}>🔗</div>
                <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: C.textSec, fontFamily: 'ui-monospace, SFMono-Regular, monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {referralMe.link.replace(/^https?:\/\//, '')}
                </div>
                <div style={{ fontSize: 12, fontWeight: 600, color: C.accent, flexShrink: 0 }}>
                  {t('referral_link_copy_btn', locale)}
                </div>
              </div>
            )}

            {/* ── Primary/Secondary CTAs ────────────────────────────── */}
            <button
              onClick={shareToTelegram}
              disabled={!referralMe.link}
              style={{
                width: '100%', padding: '14px 20px', marginBottom: 8, borderRadius: 14,
                background: `linear-gradient(135deg, ${C.accent}, var(--wb-accent-deep, #5B4BD6))`, color: '#fff',
                fontSize: 15, fontWeight: 700, border: 'none', cursor: referralMe.link ? 'pointer' : 'default',
                fontFamily: font, opacity: referralMe.link ? 1 : 0.5,
                boxShadow: `0 4px 20px rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.188)`,
              }}>
              {t('referral_share_tg_btn', locale)}
            </button>
            <button
              onClick={() => { setReferralShareSheet(true); trackEvent('referral.share_action_sheet_opened'); }}
              disabled={!referralMe.link}
              style={{
                width: '100%', padding: '12px 20px', marginBottom: 16, borderRadius: 14,
                background: C.surface, color: C.text, fontSize: 14, fontWeight: 600,
                border: `1px solid ${C.border}`, cursor: referralMe.link ? 'pointer' : 'default',
                fontFamily: font, opacity: referralMe.link ? 1 : 0.5,
              }}>
              {t('referral_share_other_btn', locale)}
            </button>

            {/* ── Pending progress strip (compact — details on history) */}
            {showProgressStrip && (
              <div style={{ marginBottom: 18 }}>
                <div style={{ fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700, marginBottom: 10 }}>
                  {t('referral_progress_section', locale)}
                </div>
                <button
                  type="button"
                  onClick={openReferralHistoryScreen}
                  style={{ width: '100%', padding: '12px 14px', borderRadius: 14, background: C.card, border: `1px solid ${C.border}`, borderLeft: `3px solid ${C.orange}`, fontSize: 13, color: C.text, display: 'flex', gap: 10, alignItems: 'center', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left' }}>
                  <div style={{ width: 36, height: 36, borderRadius: '50%', background: C.orangeSoft, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0 }}>⏳</div>
                  <div style={{ flex: 1, fontSize: 13, color: C.textSec, lineHeight: 1.4 }}>
                    {t('referral_event_pending', locale)}
                    <span style={{ color: C.textMuted, marginLeft: 6, fontSize: 12 }}>
                      · {referralMe.stats.pendingActivation + referralMe.stats.qualified}
                    </span>
                  </div>
                  <div style={{ color: C.accent, fontSize: 13, fontWeight: 600, flexShrink: 0 }}>
                    →
                  </div>
                </button>
              </div>
            )}

            {/* ── History preview / empty state ─────────────────────── */}
            {!hasInvited && (
              <div style={{
                padding: 16, borderRadius: 14, background: C.surface, border: `1px solid ${C.border}`,
                textAlign: 'center', color: C.textMuted, fontSize: 13, lineHeight: 1.5, marginBottom: 18,
              }}>
                {t('referral_empty_progress', locale)}
              </div>
            )}

            {hasInvited && referralMe.stats.rewarded > 0 && (
              <button
                onClick={openReferralHistoryScreen}
                style={{
                  width: '100%', padding: '12px 16px', marginBottom: 16, borderRadius: 12,
                  background: 'transparent', color: C.accent, fontSize: 14, fontWeight: 600,
                  border: `1px solid rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.251)`, cursor: 'pointer', fontFamily: font,
                }}>
                {t('referral_history_full_btn', locale)} →
              </button>
            )}

            {/* ── How it works ─────────────────────────────────────── */}
            <div style={{
              padding: '14px 16px', borderRadius: 14, background: C.card, border: `1px solid ${C.border}`, marginBottom: 10,
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 12 }}>
                {t('referral_how_title', locale)}
              </div>
              {[1, 2, 3].map((n) => (
                <div key={n} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: n === 3 ? 0 : 10 }}>
                  <div style={{ width: 22, height: 22, borderRadius: '50%', background: C.accentSoft, color: C.accent, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>{n}</div>
                  <div style={{ fontSize: 13, color: C.textSec, lineHeight: 1.45, flex: 1 }}>
                    {n === 1 && t('referral_how_step_1', locale)}
                    {n === 2 && t('referral_how_step_2', locale)}
                    {n === 3 && t('referral_how_step_3', locale, { days: String(daysPerRef) })}
                  </div>
                </div>
              ))}
            </div>

            {/* ── Rules link ───────────────────────────────────────── */}
            <button
              onClick={() => { setReferralRulesOpen(true); trackEvent('referral.rules_opened'); }}
              style={{
                width: '100%', padding: 10, borderRadius: 12, background: 'transparent',
                color: C.textMuted, fontSize: 13, fontWeight: 500, border: 'none', cursor: 'pointer', fontFamily: font,
              }}>
              {t('referral_rules_btn', locale)}
            </button>

            {/* ── Share sheet (bottom overlay) ────────────────────── */}
            {referralShareSheet && referralMe.link && (
              <div
                onClick={() => setReferralShareSheet(false)}
                style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 90, animation: 'fadeIn 0.2s ease' }}>
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: 'absolute', bottom: 0, left: 0, right: 0,
                    background: C.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20,
                    padding: '8px 16px 24px', maxWidth: 520, margin: '0 auto',
                    animation: 'slideUp 0.25s ease',
                  }}>
                  <div style={{ width: 36, height: 4, background: C.border, borderRadius: 2, margin: '8px auto 16px' }} />
                  <div style={{ fontSize: 17, fontWeight: 700, color: C.text, marginBottom: 4 }}>
                    {t('referral_share_sheet_title', locale)}
                  </div>
                  <div style={{ fontSize: 12, color: C.textMuted, lineHeight: 1.4, marginBottom: 16 }}>
                    {t('referral_share_sheet_sub', locale)}
                  </div>
                  {[
                    { ic: '✈️', bg: 'rgba(51,144,236,0.15)', title: t('referral_share_sheet_tg_title', locale), sub: t('referral_share_sheet_tg_sub', locale), onClick: shareToTelegram },
                    { ic: '📋', bg: C.surface, title: t('referral_share_sheet_copy_title', locale), sub: referralMe.link.replace(/^https?:\/\//, ''), onClick: async () => { await copyLink(); setReferralShareSheet(false); } },
                    { ic: '↗', bg: C.accentSoft, title: t('referral_share_sheet_other_title', locale), sub: t('referral_share_sheet_other_sub', locale), onClick: systemShare },
                  ].map((row, i) => (
                    <ListRow
                      key={i}
                      variant="card"
                      interactive
                      onClick={row.onClick}
                      style={{ marginBottom: 8 }}
                      leading={<div style={{ width: 42, height: 42, borderRadius: 12, background: row.bg, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>{row.ic}</div>}
                      title={row.title}
                      subtitle={row.sub}
                      trailing={<span style={{ color: C.textMuted, fontSize: 18 }}>›</span>}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* ── Rules sheet ───────────────────────────────────── */}
            {referralRulesOpen && (
              <div
                onClick={() => setReferralRulesOpen(false)}
                style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 90, animation: 'fadeIn 0.2s ease' }}>
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: 'absolute', bottom: 0, left: 0, right: 0,
                    background: C.bg, borderTopLeftRadius: 20, borderTopRightRadius: 20,
                    padding: '8px 20px 28px', maxWidth: 520, margin: '0 auto', maxHeight: '85vh', overflowY: 'auto',
                    animation: 'slideUp 0.25s ease',
                  }}>
                  <div style={{ width: 36, height: 4, background: C.border, borderRadius: 2, margin: '8px auto 16px' }} />
                  <div style={{ fontSize: 18, fontWeight: 800, color: C.text, marginBottom: 14 }}>
                    {t('referral_rules_title', locale)}
                  </div>
                  {[
                    { t: t('referral_rules_reward_t', locale), b: t('referral_rules_reward_b', locale, { days: String(daysPerRef) }) },
                    // Prefer the live config value for windowDays (admin can change it).
                    // Falls back to the spec default of 14 if rules-config hasn't loaded.
                    { t: t('referral_rules_qualify_t', locale), b: t('referral_rules_qualify_b', locale, { windowDays: String(referralRulesConfig?.qualification.windowDays ?? 14) }) },
                    { t: t('referral_rules_cap_t', locale), b: t('referral_rules_cap_b', locale, { monthly: String(referralMe.caps.monthlyCap), yearly: String(referralMe.caps.yearlyCap) }) },
                    { t: t('referral_rules_fraud_t', locale), b: t('referral_rules_fraud_b', locale) },
                  ].map((row, i) => (
                    <div key={i} style={{ marginBottom: 14 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>{row.t}</div>
                      <div style={{ fontSize: 13, color: C.textSec, lineHeight: 1.5 }}>{row.b}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* ══════════════════════════════════════════════
          REFERRAL HISTORY — paged invitee list
          ══════════════════════════════════════════════ */}
      {screen === 'referral-history' && (() => {
        const headerJsx = (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ fontSize: 22, fontWeight: 800, color: C.text, letterSpacing: '-0.02em' }}>
              {t('referral_history_section', locale)}
            </div>
          </div>
        );
        if (referralHistoryLoading && referralHistory.length === 0) {
          return (
            <div style={{ padding: '16px 20px 120px', animation: 'fadeIn 0.3s ease' }}>
              {headerJsx}
              <div style={{ textAlign: 'center', padding: 40, color: C.textMuted, fontSize: 14 }}>
                {t('referral_loading', locale)}
              </div>
            </div>
          );
        }
        if (referralHistory.length === 0) {
          return (
            <div style={{ padding: '16px 20px 120px', animation: 'fadeIn 0.3s ease' }}>
              {headerJsx}
              <div style={{ textAlign: 'center', padding: 40, color: C.textMuted, fontSize: 14, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14 }}>
                {t('referral_history_empty', locale)}
              </div>
            </div>
          );
        }

        const fmtDate = (iso: string | null) => {
          if (!iso) return '';
          const d = new Date(iso);
          return new Intl.DateTimeFormat(localeToBCP47(locale), { day: 'numeric', month: 'short' }).format(d);
        };

        return (
          <div style={{ padding: '16px 20px 120px', animation: 'fadeIn 0.3s ease' }}>
            {headerJsx}
            {referralHistory.map(r => {
              const isRewarded = r.status === 'REWARDED';
              const isRejected = r.status === 'REJECTED' || r.status === 'FRAUD_REVIEW';
              const isPending = r.status === 'PENDING_ACTIVATION' || r.status === 'ATTRIBUTED' || r.status === 'QUALIFIED';
              const badgeBg = isRewarded ? C.greenSoft : isRejected ? C.redSoft : C.orangeSoft;
              const badgeColor = isRewarded ? C.green : isRejected ? C.red : C.orange;
              const badgeText = isRewarded
                ? t('referral_badge_rewarded', locale, { days: String(r.reward?.days ?? 30) })
                : isRejected
                  ? t('referral_badge_rejected', locale)
                  : t('referral_badge_pending', locale);
              const title = isRewarded
                ? t('referral_event_rewarded', locale)
                : isRejected
                  ? t('referral_event_rejected', locale)
                  : t('referral_event_pending', locale);
              const meta = isRewarded && r.reward
                ? t('referral_event_rewarded_meta', locale, { days: String(r.reward.days), date: fmtDate(r.reward.grantedAt) })
                : fmtDate(r.attributedAt);

              // ── Pending progress breakdown ───────────────────────────────
              // For pending attributions, show a concrete checklist of steps
              // so the inviter knows exactly what their friend still has to
              // do (and can nudge them with a specific ask). Steps follow the
              // qualify order: bot start → wishlist → item. First step is
              // implicit (arrived via ref link = bot start already done).
              const p = r.progress;
              const DAY_MS_LOCAL = 86_400_000;
              const windowEndMs = (() => {
                // Attribution window = 14 days by default; server puts the
                // exact deadline in windowDeadlineAt on the row, but history
                // payload doesn't carry it — derive from attributedAt + config.
                const attributedMs = new Date(r.attributedAt).getTime();
                const windowDays = referralRulesConfig?.qualification.windowDays ?? 14;
                return attributedMs + windowDays * DAY_MS_LOCAL;
              })();
              const daysLeft = Math.ceil((windowEndMs - Date.now()) / DAY_MS_LOCAL);
              const expiresSoonLabel =
                daysLeft <= 0 ? t('referral_progress_expired', locale)
                : daysLeft === 0 ? t('referral_progress_expires_today', locale)
                : t('referral_progress_expires_in', locale, { days: String(daysLeft) });
              const nextActionHint = !p.firstBotStart
                ? t('referral_progress_arrived', locale)  // shouldn't happen — bot start marks on /start ref_
                : !p.firstWishlist ? t('referral_progress_need_wishlist', locale)
                : !p.firstItem ? t('referral_progress_need_item', locale)
                : null; // both done — should be QUALIFIED, not pending

              return (
                <div key={r.id} style={{ padding: 14, marginBottom: 8, borderRadius: 14, background: C.card, border: `1px solid ${C.border}`, borderLeft: `3px solid ${badgeColor}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 38, height: 38, borderRadius: '50%', background: C.surface, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, color: C.textMuted, flexShrink: 0 }}>
                      {r.invitedDisplayName ? r.invitedDisplayName[0]!.toUpperCase() : '👤'}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
                        {r.invitedDisplayName ?? title}
                      </div>
                      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{meta}</div>
                    </div>
                    <div style={{ padding: '4px 9px', borderRadius: 8, fontSize: 11, fontWeight: 700, background: badgeBg, color: badgeColor, flexShrink: 0 }}>
                      {badgeText}
                    </div>
                  </div>

                  {/* Pending-only: per-step checklist + "what's next" hint + deadline */}
                  {isPending && (
                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
                      {/* Steps with ticks */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {[
                          { done: p.firstBotStart, label: t('referral_progress_arrived', locale) },
                          { done: p.firstWishlist, label: t('referral_progress_need_wishlist', locale) },
                          { done: p.firstItem, label: t('referral_progress_need_item', locale) },
                        ].map((step, i) => (
                          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{
                              width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
                              background: step.done ? C.greenSoft : C.surface,
                              border: `1px solid ${step.done ? C.green : C.border}`,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 11, color: step.done ? C.green : 'transparent',
                              fontWeight: 700,
                            }}>
                              {step.done ? '✓' : ''}
                            </div>
                            <span style={{
                              fontSize: 12, lineHeight: 1.3,
                              color: step.done ? C.textMuted : C.text,
                              textDecoration: step.done ? 'line-through' : 'none',
                              flex: 1,
                            }}>
                              {step.label}
                            </span>
                          </div>
                        ))}
                      </div>

                      {/* "What's next" hint + deadline */}
                      {nextActionHint && (
                        <div style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          gap: 10, marginTop: 10, paddingTop: 10, borderTop: `1px dashed ${C.border}`,
                          fontSize: 11, color: C.textMuted,
                        }}>
                          <span style={{ color: C.orange, fontWeight: 600 }}>→ {nextActionHint}</span>
                          <span style={{ flexShrink: 0 }}>{expiresSoonLabel}</span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            {referralHistoryHasMore && (
              <button
                onClick={() => { void loadReferralHistory(false); }}
                disabled={referralHistoryLoading}
                style={{
                  width: '100%', padding: '12px 16px', marginTop: 8, borderRadius: 12,
                  background: C.surface, color: C.accent, fontSize: 14, fontWeight: 600,
                  border: `1px solid ${C.border}`, cursor: referralHistoryLoading ? 'default' : 'pointer', fontFamily: font,
                  opacity: referralHistoryLoading ? 0.6 : 1,
                }}>
                {referralHistoryLoading ? t('referral_loading', locale) : t('referral_history_full_btn', locale)}
              </button>
            )}
          </div>
        );
      })()}

    </>
  );
}
