// ShowcaseRoot — F4 Wave D-2 cluster file (REFACTOR_MINIAPP_TSX_PLAN).
//
// Bundles the 2 Showcase screens (showcase-editor + showcase-preview, ~858
// LOC of JSX) into a single lazy-loaded module. Loaded via
// `next/dynamic({ ssr: false })` from `apps/web/app/miniapp/MiniApp.tsx`,
// so the chunk doesn't ship with the initial Mini App page bundle —
// showcase code only downloads when a user opens the editor or preview
// (cold path: tab → profile → "edit showcase").
//
// State source: `useShowcaseState` is invoked exactly once in MiniAppInner
// and the 17 returned fields are forwarded through `ctx`. The setters flow
// back into the same React state tree — no duplicate state.
//
// Sub-screens (selected by `ctx.screen`):
//   1. showcase-editor   — owner-only multi-section editor (cover, bio,
//                          pins, preferences, sizes, brands, anti-gift)
//                          with progress meter + save/preview CTAs
//   2. showcase-preview  — visual preview matching the public profile view
//
// Implementation discipline:
// - JSX is copied verbatim from MiniApp.tsx — DO NOT migrate styles or
//   refactor logic in this PR. Bundle savings only; cosmetic changes
//   ride future on-touch PRs.
// - `ctx` types intersect `ShowcaseState` (setters keep
//   `Dispatch<SetStateAction<T>>` signatures) with the loose helpers bag.

'use client';

import React from 'react';
import { Button, Card } from '@wishlist/ui';
import { t, type Locale } from '@wishlist/shared';
import type { ShowcaseState, ShowcaseData } from '../../hooks/useShowcaseState';
import type {
  LegacyColorBag, NavBack, PushToast, SetScreen,
  ShowUpsell, TgFetch, TrackEvent,
} from '../../_shared/closure-types';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type ShowcaseRootCtx = ShowcaseState & {
  // module-level constants
  C: LegacyColorBag;
  font: string;
  locale: Locale;
  DONT_GIFT_PRESET_EMOJIS: Record<string, string>;
  // helpers from MiniAppInner closure — real signatures from
  // `_shared/closure-types`.
  tgFetch: TgFetch;
  setScreen: SetScreen;
  navBack: NavBack;
  pushToast: PushToast;
  trackEvent: TrackEvent;
  showUpsell: ShowUpsell;
  // showcase-domain helpers (defined in MiniAppInner — useCallback).
  // Patch type mirrors the inline `Partial<{...}>` argument of the
  // canonical `saveShowcase` definition in MiniApp.tsx.
  saveShowcase: (
    patch: Partial<{
      enabled: boolean;
      bio: string | null;
      pinnedIds: string[];
      preferences: string | null;
      sizeClothing: string | null;
      sizeShoes: string | null;
      sizeRing: string | null;
      sizeOther: string | null;
      chest: string | null;
      waist: string | null;
      hips: string | null;
      brands: string[];
    }>,
    opts?: { publish?: boolean; silent?: boolean },
  ) => Promise<boolean>;
  uploadShowcaseCover: (file: File) => Promise<void>;
  removeShowcaseCover: () => Promise<void>;
  openDontGiftEdit: () => Promise<void>;
  buildTgDeepLink: (payload?: string) => string | null;
  // misc shared state read by Showcase. profileData / dontGiftData stay
  // loose because their owning useStates are inline anonymous shapes
  // in MiniApp.tsx; promoting those is a deeper refactor.
  scrollContainerRef: { current: HTMLDivElement | null };
  dontGiftData: any;
  profileData: any;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface ShowcaseRootProps {
  /** Active showcase-* screen name; controls which sub-block renders. */
  screen: string;
  /** Bag of closure refs forwarded from MiniAppInner. See `ShowcaseRootCtx`. */
  ctx: ShowcaseRootCtx;
}

/**
 * Lazy-loaded Showcase cluster root.
 *
 * Destructures everything the JSX needs from `ctx` at the top, then
 * returns a fragment containing the 2 inline screen blocks. Each block
 * is guarded by a `screen === '<name>'` check exactly as in the original
 * MiniApp.tsx — keeps the JSX byte-identical.
 */
export function ShowcaseRoot(props: ShowcaseRootProps) {
  const { ctx, screen } = props;

  // ── Module-level constants forwarded from MiniApp.tsx ────────────────
  const { C, font, locale, DONT_GIFT_PRESET_EMOJIS } = ctx;

  // ── Helpers from MiniAppInner closure ────────────────────────────────
  const {
    tgFetch: _tgFetch,
    setScreen, navBack, pushToast, trackEvent,
    showUpsell: _showUpsell,
    saveShowcase, uploadShowcaseCover, removeShowcaseCover,
    openDontGiftEdit, buildTgDeepLink,
    scrollContainerRef, dontGiftData, profileData,
  } = ctx;
  // `tgFetch` and `showUpsell` are forwarded for parity with sibling
  // cluster ctx bags even though Showcase screens don't call them
  // directly — silence the unused-var warning by aliasing.
  void _tgFetch; void _showUpsell;

  // ── Showcase state (from useShowcaseState) ───────────────────────────
  const {
    showcaseData, setShowcaseData,
    showcaseAvailableWishlists,
    showcaseLoading,
    showcaseSaving,
    showcaseCoverUploading,
    showcasePublished, setShowcasePublished,
    showcaseBrandInput, setShowcaseBrandInput,
    showcaseCoverRemoveConfirm, setShowcaseCoverRemoveConfirm,
    showcaseCoverInputRef,
  } = ctx;

  return (
    <>
      {/* ─────────────────── SHOWCASE EDITOR ─────────────────── */}
      {screen === 'showcase-editor' && (() => {
        const sc = showcaseData;
        const pinnedIds = sc?.pinnedIds ?? [];
        const hasSizes = !!sc && !!(
          sc.sizes?.clothing || sc.sizes?.shoes || sc.sizes?.ring || sc.sizes?.other ||
          sc.sizes?.chest || sc.sizes?.waist || sc.sizes?.hips
        );
        const hasAntiGift = !!dontGiftData && (
          (dontGiftData.presets?.length ?? 0) > 0 ||
          (dontGiftData.customItems?.length ?? 0) > 0 ||
          !!dontGiftData.comment
        );
        const filledSections = !sc ? 0 : (
          (sc.coverUrl ? 1 : 0) +
          (sc.bio ? 1 : 0) +
          (pinnedIds.length > 0 ? 1 : 0) +
          (sc.preferences ? 1 : 0) +
          (hasSizes ? 1 : 0) +
          ((sc.brands?.length ?? 0) > 0 ? 1 : 0) +
          (hasAntiGift ? 1 : 0)
        );
        const totalSections = 7;
        const hasAnyContent = filledSections > 0;
        const togglePin = (id: string) => {
          if (!sc) return;
          const isIn = pinnedIds.includes(id);
          let next: string[];
          if (isIn) next = pinnedIds.filter((p) => p !== id);
          else {
            if (pinnedIds.length >= 3) {
              pushToast(t('showcase_section_pinned_limit', locale), 'info');
              return;
            }
            next = [...pinnedIds, id];
          }
          setShowcaseData({ ...sc, pinnedIds: next });
          void saveShowcase({ pinnedIds: next }, { silent: true });
        };
        const saveField = (data: Parameters<typeof saveShowcase>[0]) => {
          void saveShowcase(data, { silent: true });
        };
        const sectionStatus = (filled: boolean, customFilledLabel?: string) => (
          <span style={{
            fontSize: 12, fontWeight: 600,
            padding: '3px 10px', borderRadius: 20,
            background: filled ? 'rgba(74, 222, 128, 0.12)' : C.surface,
            color: filled ? C.green : C.textMuted,
            display: 'inline-flex', alignItems: 'center', gap: 4,
            whiteSpace: 'nowrap',
          }}>
            {filled
              ? `✓ ${customFilledLabel ?? t('showcase_section_done', locale)}`
              : t('showcase_section_not_filled', locale)}
          </span>
        );
        const sectionCardStyle: React.CSSProperties = {
          background: C.card, borderRadius: 14, padding: 16, marginBottom: 12,
          border: `1px solid ${C.border}`,
        };
        const sectionHeadStyle: React.CSSProperties = {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        };
        const sectionLeftStyle: React.CSSProperties = {
          display: 'flex', alignItems: 'center', gap: 10, minWidth: 0,
        };
        const sectionIconStyle: React.CSSProperties = { fontSize: 20, flexShrink: 0 };
        const sectionTitleStyle: React.CSSProperties = {
          fontSize: 15, fontWeight: 600, color: C.text,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        };
        const sectionDescStyle: React.CSSProperties = {
          fontSize: 12, color: C.textMuted, marginTop: 4, paddingLeft: 30, lineHeight: 1.35,
        };
        const clearBtnStyle: React.CSSProperties = {
          position: 'absolute', top: 8, right: 8, width: 24, height: 24,
          borderRadius: 12, border: 'none', background: 'rgba(255,255,255,0.08)',
          color: C.textMuted, cursor: 'pointer', fontFamily: font, fontSize: 14,
          lineHeight: '24px', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        };
        const bioLen = (sc?.bio ?? '').length;
        const prefLen = (sc?.preferences ?? '').length;
        const coverGradient = 'linear-gradient(135deg, #3a2d6e 0%, #1a1538 50%, #2d1f4e 100%)';
        const progressPct = Math.round((filledSections / totalSections) * 100);
        const progressHint = filledSections === 0
          ? t('showcase_progress_hint_empty', locale)
          : filledSections === totalSections
            ? t('showcase_progress_hint_full', locale)
            : t('showcase_progress_hint_partial', locale);
        const progressTitle = filledSections === totalSections
          ? t('showcase_progress_title_full', locale)
          : filledSections >= 4
            ? t('showcase_progress_title_almost', locale)
            : t('showcase_progress_title_default', locale);
        return (
          <div style={{ padding: '16px 0 140px', fontFamily: font, color: C.text, animation: 'fadeIn 0.3s ease' }}>
            {/* Telegram's native BackButton handles back navigation — no inline back button needed */}
            {showcaseLoading && !sc ? (
              <div style={{ padding: '80px 24px', textAlign: 'center', color: C.textMuted }}>{t('loading', locale)}</div>
            ) : sc && (
              <div style={{ padding: '4px 20px 24px' }}>
                {/* ── Page heading ── */}
                <div style={{ marginBottom: 20 }}>
                  <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 6, color: C.text }}>
                    {t('showcase_editor_heading', locale)}
                  </div>
                  <div style={{ fontSize: 13, color: C.textSec, lineHeight: 1.4 }}>
                    {t('showcase_editor_heading_desc', locale)}
                  </div>
                </div>

                {/* ── Progress bar ── */}
                <div style={{ background: C.card, borderRadius: 14, padding: '12px 16px', marginBottom: 12, border: `1px solid ${C.border}` }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>{progressTitle}</span>
                    <span style={{ fontSize: 12, color: C.accent, fontWeight: 700 }}>{filledSections} / {totalSections}</span>
                  </div>
                  <div style={{ background: C.surface, borderRadius: 6, height: 6, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%', width: `${progressPct}%`, borderRadius: 6,
                      background: filledSections === totalSections
                        ? `linear-gradient(90deg, ${C.green}, var(--wb-success, #6ee7b7))`
                        : `linear-gradient(90deg, ${C.accent}, var(--wb-accent-strong, #a78bfa))`,
                      transition: 'width 0.4s ease',
                    }} />
                  </div>
                  <div style={{ fontSize: 12, color: C.textMuted, marginTop: 8, lineHeight: 1.35 }}>{progressHint}</div>
                </div>

                {/* ── Cover ── */}
                <div style={sectionCardStyle}>
                  <div style={sectionHeadStyle}>
                    <div style={sectionLeftStyle}>
                      <span style={sectionIconStyle}>📷</span>
                      <span style={sectionTitleStyle}>{t('showcase_section_cover', locale)}</span>
                    </div>
                    {sectionStatus(!!sc.coverUrl)}
                  </div>
                  <div style={sectionDescStyle}>{t('showcase_section_cover_desc', locale)}</div>
                  <div
                    onClick={() => { if (!showcaseCoverUploading && !sc.coverUrl) showcaseCoverInputRef.current?.click(); }}
                    style={{
                      width: '100%', height: 140, borderRadius: 12, overflow: 'hidden', marginTop: 12,
                      cursor: sc.coverUrl ? 'default' : 'pointer',
                      background: sc.coverUrl
                        ? `url(${sc.coverUrl}) center/cover no-repeat`
                        : coverGradient,
                      position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    {!sc.coverUrl && !showcaseCoverUploading && (
                      <div style={{ textAlign: 'center', color: 'rgba(255,255,255,0.88)' }}>
                        <div style={{ fontSize: 32, marginBottom: 6 }}>📸</div>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{t('showcase_section_cover_upload', locale)}</div>
                      </div>
                    )}
                    {showcaseCoverUploading && (
                      <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 13 }}>
                        {t('showcase_section_cover_uploading', locale)}
                      </div>
                    )}
                    {sc.coverUrl && !showcaseCoverUploading && (
                      <div style={{ position: 'absolute', bottom: 8, right: 8, display: 'flex', gap: 6 }}>
                        <button
                          onClick={(e) => { e.stopPropagation(); showcaseCoverInputRef.current?.click(); }}
                          style={{ padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: font, background: 'rgba(0,0,0,0.6)', color: '#fff', border: 'none', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
                        >
                          {t('showcase_section_cover_replace', locale)}
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setShowcaseCoverRemoveConfirm(true); }}
                          aria-label={t('showcase_section_cover_remove', locale)}
                          style={{ padding: '6px 10px', borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: font, background: 'rgba(0,0,0,0.6)', color: '#fff', border: 'none', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', lineHeight: 1 }}
                        >×</button>
                      </div>
                    )}
                  </div>
                  <input
                    ref={showcaseCoverInputRef} type="file" accept="image/*"
                    style={{ display: 'none' }}
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (showcaseCoverInputRef.current) showcaseCoverInputRef.current.value = '';
                      if (file) await uploadShowcaseCover(file);
                    }}
                  />
                </div>

                {/* ── Bio ── */}
                <div style={sectionCardStyle}>
                  <div style={sectionHeadStyle}>
                    <div style={sectionLeftStyle}>
                      <span style={sectionIconStyle}>✍️</span>
                      <span style={sectionTitleStyle}>{t('showcase_section_bio', locale)}</span>
                    </div>
                    {sectionStatus(!!sc.bio)}
                  </div>
                  <div style={sectionDescStyle}>{t('showcase_section_bio_desc', locale)}</div>
                  <div style={{ position: 'relative', marginTop: 12 }}>
                    <textarea
                      value={sc.bio ?? ''}
                      maxLength={180}
                      placeholder={t('showcase_section_bio_placeholder', locale)}
                      onChange={(e) => setShowcaseData({ ...sc, bio: e.target.value })}
                      onBlur={() => saveField({ bio: sc.bio ?? null })}
                      rows={3}
                      style={{
                        width: '100%', boxSizing: 'border-box',
                        padding: sc.bio ? '12px 40px 12px 14px' : '12px 14px',
                        borderRadius: 10,
                        background: C.surface, color: C.text, fontSize: 14, fontFamily: font, lineHeight: 1.5,
                        border: `1px solid ${C.borderLight}`, outline: 'none', resize: 'none',
                      }}
                    />
                    {sc.bio && (
                      <button
                        type="button"
                        aria-label={t('showcase_input_clear', locale)}
                        onClick={() => {
                          setShowcaseData({ ...sc, bio: '' });
                          saveField({ bio: null });
                        }}
                        style={clearBtnStyle}
                      >×</button>
                    )}
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 11, color: C.textMuted, marginTop: 4 }}>{t('showcase_bio_limit', locale, { count: String(bioLen) })}</div>
                </div>

                {/* ── Pinned wishlists ── */}
                <div style={sectionCardStyle}>
                  <div style={sectionHeadStyle}>
                    <div style={sectionLeftStyle}>
                      <span style={sectionIconStyle}>📌</span>
                      <span style={sectionTitleStyle}>{t('showcase_section_pinned', locale)}</span>
                    </div>
                    {sectionStatus(pinnedIds.length > 0, `${pinnedIds.length}/3`)}
                  </div>
                  <div style={sectionDescStyle}>{t('showcase_section_pinned_desc', locale)}</div>
                  <div style={{ marginTop: 12 }}>
                  {showcaseAvailableWishlists.length === 0 ? (
                    <div style={{ padding: 16, background: C.surface, borderRadius: 12, textAlign: 'center', fontSize: 13, color: C.textMuted }}>
                      {t('showcase_section_pinned_empty', locale)}
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {showcaseAvailableWishlists.map((wl) => {
                        const isPinned = pinnedIds.includes(wl.id);
                        return (
                          <div key={wl.id}
                            onClick={() => togglePin(wl.id)}
                            style={{
                              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                              padding: 14, borderRadius: 12, cursor: 'pointer',
                              background: isPinned ? `rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.078)` : C.surface,
                              border: `1px solid ${isPinned ? `rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.333)` : C.border}`,
                            }}
                          >
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wl.title}</div>
                              <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{wl.itemCount} {t('wishes_count_short', locale)}</div>
                            </div>
                            <div style={{
                              width: 22, height: 22, borderRadius: 6, flexShrink: 0,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              background: isPinned ? C.accent : 'transparent',
                              border: `2px solid ${isPinned ? C.accent : C.border}`,
                              color: '#fff', fontSize: 13, fontWeight: 700,
                            }}>{isPinned ? '✓' : ''}</div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  </div>
                </div>

                {/* ── Preferences ── */}
                <div style={sectionCardStyle}>
                  <div style={sectionHeadStyle}>
                    <div style={sectionLeftStyle}>
                      <span style={sectionIconStyle}>💡</span>
                      <span style={sectionTitleStyle}>{t('showcase_section_preferences', locale)}</span>
                    </div>
                    {sectionStatus(!!sc.preferences)}
                  </div>
                  <div style={sectionDescStyle}>{t('showcase_section_preferences_desc', locale)}</div>
                  <div style={{ position: 'relative', marginTop: 12 }}>
                    <textarea
                      value={sc.preferences ?? ''}
                      maxLength={300}
                      placeholder={t('showcase_section_preferences_placeholder', locale)}
                      onChange={(e) => setShowcaseData({ ...sc, preferences: e.target.value })}
                      onBlur={() => saveField({ preferences: sc.preferences ?? null })}
                      rows={4}
                      style={{
                        width: '100%', boxSizing: 'border-box',
                        padding: sc.preferences ? '12px 40px 12px 14px' : '12px 14px',
                        borderRadius: 10,
                        background: C.surface, color: C.text, fontSize: 14, fontFamily: font, lineHeight: 1.5,
                        border: `1px solid ${C.borderLight}`, outline: 'none', resize: 'none',
                      }}
                    />
                    {sc.preferences && (
                      <button
                        type="button"
                        aria-label={t('showcase_input_clear', locale)}
                        onClick={() => {
                          setShowcaseData({ ...sc, preferences: '' });
                          saveField({ preferences: null });
                        }}
                        style={clearBtnStyle}
                      >×</button>
                    )}
                  </div>
                  <div style={{ textAlign: 'right', fontSize: 11, color: C.textMuted, marginTop: 4 }}>{t('showcase_pref_limit', locale, { count: String(prefLen) })}</div>
                </div>

                {/* ── Sizes ── */}
                <div style={sectionCardStyle}>
                  <div style={sectionHeadStyle}>
                    <div style={sectionLeftStyle}>
                      <span style={sectionIconStyle}>📏</span>
                      <span style={sectionTitleStyle}>{t('showcase_section_sizes', locale)}</span>
                    </div>
                    {sectionStatus(!!(sc.sizes.clothing || sc.sizes.shoes || sc.sizes.ring || sc.sizes.other || sc.sizes.chest || sc.sizes.waist || sc.sizes.hips))}
                  </div>
                  <div style={sectionDescStyle}>{t('showcase_section_sizes_desc', locale)}</div>
                  {(() => {
                    const sizeInputStyle = (hasVal: boolean): React.CSSProperties => ({
                      width: '100%', boxSizing: 'border-box',
                      padding: hasVal ? '10px 32px 10px 12px' : '10px 12px',
                      borderRadius: 10,
                      background: C.surface, color: C.text, fontSize: 14, fontFamily: font,
                      border: `1px solid ${C.borderLight}`, outline: 'none',
                    });
                    const sizeClearBtnStyle: React.CSSProperties = {
                      position: 'absolute', top: '50%', right: 6, transform: 'translateY(-50%)',
                      width: 22, height: 22, borderRadius: 11, border: 'none',
                      background: 'rgba(255,255,255,0.08)', color: C.textMuted,
                      cursor: 'pointer', fontFamily: font, fontSize: 13,
                      padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', lineHeight: 1,
                    };
                    const renderSizeInput = (key: keyof ShowcaseData['sizes'], labelKey: string, phKey: string, patchKey: string) => {
                      const sizeVal = (sc.sizes as any)[key] ?? '';
                      return (
                        <div key={key}>
                          <div style={{ fontSize: 11, color: C.textMuted, marginBottom: 4, fontWeight: 600 }}>{t(labelKey, locale)}</div>
                          <div style={{ position: 'relative' }}>
                            <input
                              type="text"
                              value={sizeVal}
                              placeholder={t(phKey, locale)}
                              onChange={(e) => setShowcaseData({ ...sc, sizes: { ...sc.sizes, [key]: e.target.value } })}
                              onBlur={() => saveField({ [patchKey]: (sizeVal as string)?.trim() || null } as any)}
                              style={sizeInputStyle(!!sizeVal)}
                            />
                            {sizeVal && (
                              <button
                                type="button"
                                aria-label={t('showcase_input_clear', locale)}
                                onClick={() => {
                                  setShowcaseData({ ...sc, sizes: { ...sc.sizes, [key]: '' } });
                                  saveField({ [patchKey]: null } as any);
                                }}
                                style={sizeClearBtnStyle}
                              >×</button>
                            )}
                          </div>
                        </div>
                      );
                    };
                    return (
                      <>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 12 }}>
                          {renderSizeInput('clothing', 'showcase_size_clothing', 'showcase_size_placeholder_clothing', 'sizeClothing')}
                          {renderSizeInput('shoes', 'showcase_size_shoes', 'showcase_size_placeholder_shoes', 'sizeShoes')}
                          {renderSizeInput('ring', 'showcase_size_ring', 'showcase_size_placeholder_ring', 'sizeRing')}
                          {renderSizeInput('other', 'showcase_size_other', 'showcase_size_placeholder_other', 'sizeOther')}
                        </div>
                        <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
                          <div style={{ fontSize: 11, color: C.textMuted, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase', marginBottom: 8 }}>
                            {t('showcase_measurements_title', locale)}
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                            {renderSizeInput('chest', 'showcase_size_chest', 'showcase_size_placeholder_chest', 'chest')}
                            {renderSizeInput('waist', 'showcase_size_waist', 'showcase_size_placeholder_waist', 'waist')}
                            {renderSizeInput('hips', 'showcase_size_hips', 'showcase_size_placeholder_hips', 'hips')}
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </div>

                {/* ── Brands ── */}
                <div style={sectionCardStyle}>
                  <div style={sectionHeadStyle}>
                    <div style={sectionLeftStyle}>
                      <span style={sectionIconStyle}>✨</span>
                      <span style={sectionTitleStyle}>{t('showcase_section_brands', locale)}</span>
                    </div>
                    {sectionStatus((sc.brands?.length ?? 0) > 0, `${sc.brands?.length ?? 0}/10`)}
                  </div>
                  <div style={sectionDescStyle}>{t('showcase_section_brands_desc', locale)}</div>
                  <div style={{ marginTop: 12 }}>
                  {(sc.brands?.length ?? 0) > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
                      {sc.brands.map((b, i) => (
                        <span key={i} style={{
                          padding: '6px 10px', borderRadius: 10, fontSize: 13, fontWeight: 600,
                          background: C.surface, border: `1px solid ${C.border}`, color: C.text,
                          display: 'inline-flex', alignItems: 'center', gap: 6,
                        }}>
                          {b}
                          <span
                            onClick={() => {
                              const next = sc.brands.filter((_, j) => j !== i);
                              setShowcaseData({ ...sc, brands: next });
                              void saveShowcase({ brands: next }, { silent: true });
                            }}
                            style={{ cursor: 'pointer', color: C.textMuted, fontSize: 14, lineHeight: 1, display: 'inline-flex', alignItems: 'center' }}
                          >×</span>
                        </span>
                      ))}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      type="text"
                      value={showcaseBrandInput}
                      placeholder={t('showcase_section_brands_placeholder', locale)}
                      maxLength={40}
                      disabled={sc.brands.length >= 10}
                      onChange={(e) => setShowcaseBrandInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const v = showcaseBrandInput.trim();
                          if (!v) return;
                          if (sc.brands.length >= 10) { pushToast(t('showcase_brand_limit_reached', locale), 'info'); return; }
                          if (sc.brands.some((b) => b.toLowerCase() === v.toLowerCase())) { setShowcaseBrandInput(''); return; }
                          const next = [...sc.brands, v];
                          setShowcaseData({ ...sc, brands: next });
                          setShowcaseBrandInput('');
                          void saveShowcase({ brands: next }, { silent: true });
                        }
                      }}
                      style={{
                        flex: 1, boxSizing: 'border-box', padding: '10px 12px', borderRadius: 10,
                        background: C.surface, color: C.text, fontSize: 14, fontFamily: font,
                        border: `1px solid ${C.border}`, outline: 'none',
                      }}
                    />
                    <button
                      onClick={() => {
                        const v = showcaseBrandInput.trim();
                        if (!v) return;
                        if (sc.brands.length >= 10) { pushToast(t('showcase_brand_limit_reached', locale), 'info'); return; }
                        if (sc.brands.some((b) => b.toLowerCase() === v.toLowerCase())) { setShowcaseBrandInput(''); return; }
                        const next = [...sc.brands, v];
                        setShowcaseData({ ...sc, brands: next });
                        setShowcaseBrandInput('');
                        void saveShowcase({ brands: next }, { silent: true });
                      }}
                      disabled={!showcaseBrandInput.trim() || sc.brands.length >= 10}
                      style={{
                        padding: '10px 14px', borderRadius: 10, fontSize: 13, fontWeight: 600,
                        background: showcaseBrandInput.trim() && sc.brands.length < 10 ? C.accent : C.surface,
                        color: showcaseBrandInput.trim() && sc.brands.length < 10 ? '#fff' : C.textMuted,
                        border: `1px solid ${C.border}`, cursor: showcaseBrandInput.trim() && sc.brands.length < 10 ? 'pointer' : 'default',
                        fontFamily: font,
                      }}
                    >{t('showcase_section_brands_add', locale)}</button>
                  </div>
                  {sc.brands.length >= 10 && (
                    <div style={{ fontSize: 11, color: C.textMuted, marginTop: 6 }}>{t('showcase_section_brands_limit', locale)}</div>
                  )}
                  </div>
                </div>

                {/* ── Anti-gifts (managed via global dont-gift sheet) ── */}
                <div style={sectionCardStyle}>
                  <div style={sectionHeadStyle}>
                    <div style={sectionLeftStyle}>
                      <span style={sectionIconStyle}>🚫</span>
                      <span style={sectionTitleStyle}>{t('showcase_section_antigift', locale)}</span>
                    </div>
                    {sectionStatus(hasAntiGift, t('showcase_section_configured', locale))}
                  </div>
                  <div style={sectionDescStyle}>{t('showcase_section_antigift_desc', locale)}</div>
                  <button
                    type="button"
                    onClick={() => { void openDontGiftEdit(); }}
                    style={{
                      marginTop: 12, width: '100%',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      padding: '10px 14px', borderRadius: 10, cursor: 'pointer', fontFamily: font,
                      background: C.surface, color: C.text, border: `1px solid ${C.borderLight}`,
                      fontSize: 14, fontWeight: 600, textAlign: 'left',
                    }}
                  >
                    <span style={{ color: C.accent }}>{t('showcase_section_antigift_cta', locale)}</span>
                    <span style={{ color: C.textMuted, fontSize: 18 }}>›</span>
                  </button>
                </div>

                {/* ── Preview + Save buttons — <Button> primitives ── */}
                <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      trackEvent('showcase.preview_opened');
                      // Reset scroll BEFORE setScreen so there's no visible jump
                      // while React is committing the new screen. The post-commit
                      // useEffect is a safety net for any layout-shift edge case.
                      if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
                      setScreen('showcase-preview');
                    }}
                    disabled={!hasAnyContent}
                  >
                    {t('showcase_editor_preview_cta', locale)}
                  </Button>
                  <Button
                    variant="primary-gradient"
                    loading={showcaseSaving}
                    disabled={showcaseSaving || !hasAnyContent}
                    onClick={async () => {
                      await saveShowcase({ enabled: true }, { publish: !sc.enabled });
                    }}
                  >
                    {t('showcase_editor_save', locale)}
                  </Button>
                </div>
              </div>
            )}

            {/* Cover remove confirm dialog */}
            {showcaseCoverRemoveConfirm && (
              <div
                onClick={() => setShowcaseCoverRemoveConfirm(false)}
                style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    width: '100%', maxWidth: 360, background: C.card, borderRadius: 18,
                    padding: 22, textAlign: 'center', border: `1px solid ${C.border}`,
                  }}
                >
                  <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>{t('showcase_cover_remove_title', locale)}</div>
                  <div style={{ fontSize: 13, color: C.textSec, lineHeight: 1.5, marginBottom: 18 }}>{t('showcase_cover_remove_desc', locale)}</div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <Button
                      variant="secondary"
                      style={{ flex: 1 }}
                      onClick={() => setShowcaseCoverRemoveConfirm(false)}
                    >
                      {t('cancel', locale)}
                    </Button>
                    <Button
                      variant="danger-solid"
                      style={{ flex: 1 }}
                      onClick={async () => {
                        setShowcaseCoverRemoveConfirm(false);
                        await removeShowcaseCover();
                      }}
                    >
                      {t('showcase_cover_remove_confirm', locale)}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {/* Published success overlay */}
            {showcasePublished && sc && (
              <div
                onClick={() => setShowcasePublished(false)}
                style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', zIndex: 120, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' }}
              >
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    width: '100%', maxWidth: 560, background: C.card, borderTopLeftRadius: 20, borderTopRightRadius: 20,
                    padding: '28px 24px calc(24px + env(safe-area-inset-bottom, 0px))', textAlign: 'center',
                  }}
                >
                  <div style={{ fontSize: 44, marginBottom: 12 }}>✨</div>
                  <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>{t('showcase_published_title', locale)}</div>
                  <div style={{ fontSize: 14, color: C.textSec, lineHeight: 1.5, marginBottom: 20 }}>{t('showcase_published_desc', locale)}</div>
                  <Button
                    variant="primary-gradient"
                    style={{ marginBottom: 8 }}
                    onClick={() => {
                      trackEvent('showcase.share_clicked');
                      const username = profileData?.username;
                      if (!username) { setShowcasePublished(false); return; }
                      const link = buildTgDeepLink(`profile_${username}`);
                      if (!link) { setShowcasePublished(false); return; }
                      const shareText = `${profileData?.displayName || username}\n${t('showcase_share_text', locale)}`;
                      const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(shareText)}`;
                      (window as any).Telegram?.WebApp?.openTelegramLink?.(tgShareUrl);
                      setShowcasePublished(false);
                    }}
                  >{t('showcase_published_share', locale)}</Button>
                  <Button
                    variant="ghost"
                    style={{ color: C.textSec }}
                    onClick={() => setShowcasePublished(false)}
                  >{t('showcase_published_later', locale)}</Button>
                </div>
              </div>
            )}
          </div>
        );
      })()}

      {/* ─────────────────── SHOWCASE PREVIEW ─────────────────── */}
      {screen === 'showcase-preview' && (() => {
        const sc = showcaseData;
        const pinnedWls = showcaseAvailableWishlists.filter((w) => sc?.pinnedIds.includes(w.id));
        const otherWls = showcaseAvailableWishlists.filter((w) => !sc?.pinnedIds.includes(w.id));
        const hasGarmentSizes = !!sc && !!(sc.sizes.clothing || sc.sizes.shoes || sc.sizes.ring || sc.sizes.other);
        const hasMeasurements = !!sc && !!(sc.sizes.chest || sc.sizes.waist || sc.sizes.hips);
        const hasSizes = hasGarmentSizes || hasMeasurements;
        const dg = profileData;
        return (
          <div style={{ fontFamily: font, color: C.text, animation: 'fadeIn 0.3s ease' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px', gap: 12, borderBottom: `1px solid ${C.border}`, background: C.bg }}>
              <button onClick={navBack} style={{ background: 'none', border: 'none', color: C.text, fontSize: 16, cursor: 'pointer', fontFamily: font, padding: '4px 0' }}>
                ‹ {t('showcase_preview_back', locale)}
              </button>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.textMuted }}>{t('showcase_preview_title', locale)}</div>
              <div style={{ width: 60 }} />
            </div>

            {sc && (() => {
              const hasAntiGift = !!dontGiftData && (
                (dontGiftData.presets?.length ?? 0) > 0 ||
                (dontGiftData.customItems?.length ?? 0) > 0 ||
                !!dontGiftData.comment
              );
              const scSectionStyle: React.CSSProperties = { padding: '0 20px', marginBottom: 20 };
              const scSectionTitleStyle: React.CSSProperties = {
                fontSize: 13, fontWeight: 600, textTransform: 'uppercase',
                letterSpacing: '0.06em', color: C.textMuted, marginBottom: 12,
              };
              return (
              <div>
                {/* Hero (Visual): cover + left-aligned avatar + info ─ */}
                <div style={{ position: 'relative' }}>
                  {sc.coverUrl ? (
                    <div style={{ position: 'relative', width: '100%', height: 220, backgroundImage: `url(${sc.coverUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }}>
                      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(27,27,31,0.18) 0%, rgba(27,27,31,0.72) 70%, rgba(27,27,31,1) 100%)' }} />
                    </div>
                  ) : (
                    <div style={{ position: 'relative', width: '100%', height: 180, background: 'linear-gradient(135deg, #2a1f5e 0%, #1a1040 40%, #3d2870 100%)' }}>
                      <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 80, background: `linear-gradient(to top, ${C.bg} 0%, transparent 100%)` }} />
                    </div>
                  )}
                  <div style={{ padding: '0 20px', marginTop: -44, position: 'relative', zIndex: 2 }}>
                    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14 }}>
                      <div style={{
                        width: 72, height: 72, borderRadius: '50%', overflow: 'hidden',
                        background: `linear-gradient(135deg, ${C.accent}, var(--wb-accent-strong, #a78bfa))`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        border: `3px solid ${C.bg}`, flexShrink: 0,
                      }}>
                        {dg?.avatarUrl
                          ? <img src={dg.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                          : <span style={{ fontSize: 32 }}>👤</span>}
                      </div>
                      <div style={{ paddingBottom: 4, minWidth: 0 }}>
                        <div style={{ fontSize: 20, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{dg?.displayName || dg?.username || ''}</span>
                          <span style={{
                            display: 'inline-flex', alignItems: 'center',
                            background: `linear-gradient(135deg, ${C.accent} 0%, var(--wb-accent-strong, #a78bfa) 100%)`,
                            color: '#fff', fontSize: 10, fontWeight: 700,
                            padding: '2px 8px', borderRadius: 10, letterSpacing: '0.04em',
                          }}>PRO</span>
                        </div>
                        {dg?.username && <div style={{ fontSize: 14, color: C.textMuted, marginTop: 2 }}>@{dg.username}</div>}
                      </div>
                    </div>
                    {(sc.bio || dg?.bio) && (
                      <div style={{ fontSize: 14, color: C.textSec, marginTop: 12, lineHeight: 1.45 }}>
                        {sc.bio || dg?.bio}
                      </div>
                    )}
                  </div>
                </div>

                <div style={{ height: 24 }} />

                {/* ── Pinned wishlists ── */}
                {pinnedWls.length > 0 && (
                  <div style={scSectionStyle}>
                    <div style={scSectionTitleStyle}>📌 {t('showcase_public_featured_title', locale)}</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      {pinnedWls.map((wl) => (
                        <div key={wl.id} style={{
                          background: C.surface, borderRadius: 12, padding: '14px 16px',
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          border: `1px solid ${C.border}`,
                        }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
                            <div style={{
                              width: 36, height: 36, borderRadius: 10,
                              background: C.accentSoft, color: C.accent,
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              fontSize: 18, flexShrink: 0,
                            }}>📌</div>
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 15, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wl.title}</div>
                              <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{wl.itemCount} {t('wishes_count_short', locale)}</div>
                            </div>
                          </div>
                          <span style={{ color: C.textMuted, fontSize: 18, flexShrink: 0, marginLeft: 8 }}>›</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── Preferences ── */}
                {sc.preferences && (
                  <div style={scSectionStyle}>
                    <div style={scSectionTitleStyle}>💡 {t('showcase_public_preferences_title', locale)}</div>
                    <Card variant="default" style={{ fontSize: 14, color: C.textSec, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{sc.preferences}</Card>
                  </div>
                )}

                {/* ── Sizes ── */}
                {hasSizes && (
                  <div style={scSectionStyle}>
                    <div style={scSectionTitleStyle}>📏 {t('showcase_public_sizes_title', locale)}</div>
                    {hasGarmentSizes && (
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        {([
                          ['clothing', sc.sizes.clothing],
                          ['shoes', sc.sizes.shoes],
                          ['ring', sc.sizes.ring],
                          ['other', sc.sizes.other],
                        ] as const).filter(([, v]) => !!v).map(([key, value]) => (
                          <div key={key} style={{ background: C.surface, borderRadius: 10, padding: '10px 14px', border: `1px solid ${C.border}` }}>
                            <div style={{ fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{t(`showcase_size_${key}` as any, locale)}</div>
                            <div style={{ fontSize: 15, fontWeight: 600 }}>{value}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    {hasMeasurements && (
                      <div style={{ marginTop: hasGarmentSizes ? 12 : 0 }}>
                        <div style={{ fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6, fontWeight: 600 }}>
                          {t('showcase_measurements_title', locale)}
                        </div>
                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                          {([
                            ['chest', sc.sizes.chest],
                            ['waist', sc.sizes.waist],
                            ['hips', sc.sizes.hips],
                          ] as const).filter(([, v]) => !!v).map(([key, value]) => (
                            <div key={key} style={{ background: C.surface, borderRadius: 10, padding: '10px 12px', border: `1px solid ${C.border}` }}>
                              <div style={{ fontSize: 11, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>{t(`showcase_size_${key}` as any, locale)}</div>
                              <div style={{ fontSize: 15, fontWeight: 600 }}>{value}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* ── Brands ── */}
                {sc.brands.length > 0 && (
                  <div style={scSectionStyle}>
                    <div style={scSectionTitleStyle}>✨ {t('showcase_public_brands_title', locale)}</div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                      {sc.brands.map((b, i) => (
                        <span key={i} style={{
                          display: 'inline-flex', alignItems: 'center',
                          padding: '6px 14px', borderRadius: 20,
                          fontSize: 13, fontWeight: 500,
                          background: C.accentSoft, color: C.accent,
                        }}>{b}</span>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── Anti-gifts (from dontGiftData, preview own) ── */}
                {hasAntiGift && dontGiftData && (
                  <div style={scSectionStyle}>
                    <div style={scSectionTitleStyle}>🚫 {t('showcase_public_antigift_title', locale)}</div>
                    {(dontGiftData.presets.length > 0 || dontGiftData.customItems.length > 0) && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                        {dontGiftData.presets.map((key: string) => (
                          <span key={`p-${key}`} style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            padding: '6px 12px', borderRadius: 20, fontSize: 13,
                            background: 'rgba(251, 113, 133, 0.12)', color: C.red,
                            border: '1px solid rgba(251, 113, 133, 0.15)',
                          }}>
                            <span>{DONT_GIFT_PRESET_EMOJIS[key] || '🚫'}</span>
                            {t(`dont_gift_preset_${key}` as any, locale)}
                          </span>
                        ))}
                        {dontGiftData.customItems.map((item: string, i: number) => (
                          <span key={`c-${i}`} style={{
                            display: 'inline-flex', alignItems: 'center',
                            padding: '6px 12px', borderRadius: 20, fontSize: 13,
                            background: 'rgba(251, 113, 133, 0.12)', color: C.red,
                            border: '1px solid rgba(251, 113, 133, 0.15)',
                          }}>{item}</span>
                        ))}
                      </div>
                    )}
                    {dontGiftData.comment && (
                      <div style={{
                        fontSize: 13, color: C.textSec, lineHeight: 1.45,
                        marginTop: 10, padding: '10px 14px',
                        background: C.surface, borderRadius: 10,
                        borderLeft: `3px solid ${C.red}`,
                      }}>{dontGiftData.comment}</div>
                    )}
                  </div>
                )}

                {/* ── Other wishlists ── */}
                {otherWls.length > 0 && (
                  <div style={scSectionStyle}>
                    <div style={scSectionTitleStyle}>{t('showcase_public_other_title', locale)}</div>
                    <div style={{ background: C.card, borderRadius: 12, padding: '4px 16px', border: `1px solid ${C.border}` }}>
                      {otherWls.map((wl, i) => (
                        <div key={wl.id} style={{
                          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          padding: '12px 0',
                          borderBottom: i < otherWls.length - 1 ? `1px solid ${C.border}` : 'none',
                        }}>
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wl.title}</div>
                            <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>{wl.itemCount} {t('wishes_count_short', locale)}</div>
                          </div>
                          <span style={{ color: C.textMuted, fontSize: 16, marginLeft: 8 }}>›</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div style={{ height: 20 }} />
              </div>
              );
            })()}
          </div>
        );
      })()}

    </>
  );
}
