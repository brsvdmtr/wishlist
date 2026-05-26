// ProfileRoot — F4 Wave D-4 cluster file (REFACTOR_MINIAPP_TSX_PLAN).
//
// Bundles the single Profile screen (~1771 LOC of JSX) into a lazy-loaded
// module. Loaded via `next/dynamic({ ssr: false })` from
// `apps/web/app/miniapp/MiniApp.tsx`, so the chunk doesn't ship with the
// initial Mini App page bundle — profile code only downloads when a user
// opens the profile tab (cold path: not first-paint, but commonly visited
// post-onboarding).
//
// State strategy: F7 `useProfileState` owns the cluster — server-fetched
// profile (profileData / profileStats / profileLoading), the edit-form
// cluster (editingProfile + 4 form fields + bioTextareaRef +
// editProfileSaving), and the avatar-upload cluster (avatarInputRef +
// showAvatarSheet + avatarUploading). 13 useState cells + 2 useRefs are
// consolidated. The EditProfile + Avatar BottomSheets still live in
// MiniApp.tsx (they're global modals not gated on `screen === 'profile'`),
// but they read the same `profileState` instance via destructure — flipping
// the open flag inside this cluster works because the BottomSheet
// subscribes to the same React state cell. Sibling-owned reads
// (planInfo, subscription, godStats, retention, wishlists) come through
// the `ctx` bag.
//
// The Profile screen also embeds 4 inline UI primitives (CollapsibleBlock,
// SectionCard, KpiRow, relativeTime) used by the god-mode analytics
// panel. Those stay INSIDE the screen IIFE so the byte-identical JSX
// copies cleanly.
//
// Implementation discipline:
// - JSX is copied verbatim from MiniApp.tsx — DO NOT migrate styles or
//   refactor logic in this PR. Bundle savings only; cosmetic changes
//   ride future on-touch PRs.
// - `ctx` is `ProfileState & {...}` — the F7 hook's return shape intersected
//   with the remaining closure refs (helpers / setters from MiniAppInner
//   that the screen needs but the hook doesn't own). The tightening pass
//   moved every former `any` slot to a named DTO — 0 `any` remaining.
// - The edit-form BottomSheet and avatar-upload BottomSheet remain in
//   MiniApp.tsx (they're global modals not gated on `screen === 'profile'`).
//   They read setEditingProfile / setShowAvatarSheet which are also
//   forwarded here — flipping the open flag inside this cluster works
//   because the BottomSheet subscribes to the same state cell.

'use client';

import React, { Fragment } from 'react';
import { Button, Chip } from '@wishlist/ui';
import { t, localeToBCP47, type Locale } from '@wishlist/shared';
import { SantaHatOverlay } from '../../components/SantaHatOverlay';
import { ProBadge } from '../../components/ProBadge';
import type { ComponentType, Dispatch, SetStateAction } from 'react';
import type {
  GodStats, HomeTab, PlanInfo, ProfileData, ProfileStats,
  ReferralProfileTileFromConfigProps, ReferralRulesConfig,
  RetentionStats, SantaSeason, Screen, SkuInfo, SubscriptionInfo,
  TgUser, Wishlist,
} from '../../MiniApp';
import type { ProfileState } from '../../hooks/useProfileState';
import type { GnAccess } from '../../hooks/useGiftNotesState';
import type { ShowcaseData } from '../../hooks/useShowcaseState';
import type {
  LegacyColorBag, PushToast, SetScreen, SetUpsellSheet,
  ShowUpsell, TgFetch, TrackEvent,
} from '../../_shared/closure-types';

export type ProfileRootCtx = ProfileState & {
  // module-level constants forwarded from MiniApp.tsx
  C: LegacyColorBag;
  font: string;
  locale: Locale;
  // hot-path helpers — real signatures from `_shared/closure-types`.
  tgFetch: TgFetch;
  setScreen: SetScreen;
  pushToast: PushToast;
  showUpsell: ShowUpsell;
  setUpsellSheet: SetUpsellSheet;
  trackEvent: TrackEvent;
  // module-level helpers used by KpiRow/CollapsibleBlock locale formatting
  localeToBCP47: typeof localeToBCP47;
  // profileData / profileStats / profileLoading provided by ProfileState intersection.
  // Shared sibling-cluster state forwarded as-is.
  tgUser: TgUser | null;
  planInfo: PlanInfo;
  subscription: SubscriptionInfo;
  proSource: string | null;
  promoPro: { id: string; expiresAt: string | null; campaignCode: string } | null;
  wishlists: Wishlist[];
  santaSeason: SantaSeason | null;
  // NOTE: `isPro`, `isProExpired`, `isLifetime` are NOT in ctx — they're
  // derived inline inside the Profile JSX IIFE (and would otherwise
  // shadow the inline `const isPro = ...` declarations).
  // god-mode + analytics (read by Profile dev panel)
  godMode: boolean;
  godModeLoading: boolean;
  setGodMode: Dispatch<SetStateAction<boolean>>;
  setGodModeLoading: Dispatch<SetStateAction<boolean>>;
  godStats: GodStats | null;
  godStatsLoading: boolean;
  godStatsError: boolean;
  godStatsRefreshedAt: Date | null;
  godStatsDetailsOpen: boolean;
  setGodStatsDetailsOpen: Dispatch<SetStateAction<boolean>>;
  loadGodStats: (scope?: string, periodOverride?: string) => Promise<void>;
  retentionStats: RetentionStats | null;
  retentionLoading: boolean;
  retentionOpen: boolean;
  retentionPeriod: number;
  setRetentionStats: Dispatch<SetStateAction<RetentionStats | null>>;
  setRetentionLoading: Dispatch<SetStateAction<boolean>>;
  setRetentionOpen: Dispatch<SetStateAction<boolean>>;
  setRetentionPeriod: Dispatch<SetStateAction<number>>;
  acqPeriod: '24h' | '7d' | '30d';
  setAcqPeriod: Dispatch<SetStateAction<'24h' | '7d' | '30d'>>;
  activationTab: 'funnel' | 'onboarding' | 'acq';
  setActivationTab: Dispatch<SetStateAction<'funnel' | 'onboarding' | 'acq'>>;
  // subscription cancel/reactivate flow
  cancelSubLoading: boolean;
  setShowCancelSub: Dispatch<SetStateAction<boolean>>;
  // santa test-mode (god-mode)
  santaTestModeLoading: boolean;
  setSantaTestModeLoading: Dispatch<SetStateAction<boolean>>;
  // misc handlers Profile calls
  setShowDeleteAccount: Dispatch<SetStateAction<boolean>>;
  setSettingsOriginScreen: Dispatch<SetStateAction<Screen>>;
  setHomeTab: Dispatch<SetStateAction<HomeTab>>;
  // additional refs/helpers Profile reads
  tgRef: { current: Window['Telegram'] };
  hasNewInSettings: boolean;
  buildTgDeepLink: (payload?: string) => string | null;
  handleBuyAddon: (skuCode: string, targetId?: string) => Promise<void>;
  handleReactivateSub: () => Promise<void>;
  addonCheckoutLoading: boolean;
  addonLoadingSku: string | null;
  checkoutLoading: boolean;
  setWishlistPickerSku: Dispatch<SetStateAction<string | null>>;
  // setProfileData provided by ProfileState intersection.
  showLocaleDebug: boolean;
  setShowLocaleDebug: Dispatch<SetStateAction<boolean>>;
  loadWishlists: () => Promise<void>;
  loadAllItems: () => Promise<void>;
  loadGlobalArchive: () => Promise<void>;
  loadSettings: () => Promise<void>;
  loadShowcase: () => Promise<void>;
  loadSantaSeason: () => Promise<void>;
  showcaseData: ShowcaseData | null;
  gnAccess: GnAccess;
  canGodMode: boolean;
  availableSkus: SkuInfo[];
  cappedAddonCodes: string[];
  getAddonOffers: (locale: Locale) => Record<string, { title: string; tag: string }>;
  getProBenefits: (locale: Locale) => Array<{
    icon: string; title: string; subtitle: string; isNew?: boolean; resSection?: boolean;
  }>;
  openReferralScreen: (entryPoint?: string) => void;
  referralRulesConfig: ReferralRulesConfig | null;
  ReferralProfileTileFromConfig: ComponentType<ReferralProfileTileFromConfigProps>;
};

export interface ProfileRootProps {
  /** Active screen name; passed for symmetry with sibling Root components. */
  screen: string;
  /** Bag of closure refs forwarded from MiniAppInner. See `ProfileRootCtx`. */
  ctx: ProfileRootCtx;
}

/**
 * Lazy-loaded Profile cluster root.
 *
 * Destructures everything the JSX needs from `ctx` at the top, then
 * returns the inline screen block guarded by `screen === 'profile'`
 * exactly as in the original MiniApp.tsx — keeps the JSX byte-identical.
 */
export function ProfileRoot(props: ProfileRootProps) {
  const { ctx, screen } = props;

  // ── Module-level constants forwarded from MiniApp.tsx ────────────────
  const { C, font, locale } = ctx;
  // localeToBCP47 is imported above, but Profile also reads it via ctx
  // in case a future tighter typing wants to inject a mock — alias to
  // silence the unused-var rule.
  void ctx.localeToBCP47;

  // ── Helpers + state from MiniAppInner closure ────────────────────────
  const {
    tgFetch, setScreen, pushToast, showUpsell, setUpsellSheet, trackEvent,
    profileData, profileStats, profileLoading,
    tgUser, planInfo, subscription,
    proSource, promoPro,
    wishlists, santaSeason,
    godMode, godModeLoading, setGodMode, setGodModeLoading,
    godStats, godStatsLoading, godStatsError, godStatsRefreshedAt,
    godStatsDetailsOpen, setGodStatsDetailsOpen,
    loadGodStats,
    retentionStats, retentionLoading, retentionOpen, retentionPeriod,
    setRetentionStats, setRetentionLoading, setRetentionOpen, setRetentionPeriod,
    acqPeriod, setAcqPeriod,
    activationTab, setActivationTab,
    setEditingProfile, setEditProfileName, setEditProfileUsername,
    setEditProfileBio, setEditProfileBirthday,
    setShowAvatarSheet, avatarUploading,
    cancelSubLoading, setShowCancelSub,
    santaTestModeLoading, setSantaTestModeLoading,
    setShowDeleteAccount, setSettingsOriginScreen, setHomeTab,
    tgRef, hasNewInSettings, buildTgDeepLink,
    handleBuyAddon, handleReactivateSub,
    addonCheckoutLoading, addonLoadingSku, checkoutLoading,
    setWishlistPickerSku, setProfileData,
    showLocaleDebug, setShowLocaleDebug,
    loadWishlists, loadAllItems, loadGlobalArchive, loadSettings,
    loadShowcase, loadSantaSeason,
    showcaseData, gnAccess, canGodMode,
    availableSkus, cappedAddonCodes, getAddonOffers, getProBenefits,
    openReferralScreen, referralRulesConfig, ReferralProfileTileFromConfig,
  } = ctx;

  return (
    <>
      {screen === 'profile' && (
        <div style={{ padding: '16px 20px 120px', animation: 'fadeIn 0.3s ease' }}>
          {profileLoading && !profileData ? (
            <div style={{ textAlign: 'center', padding: 40, color: C.textMuted }}>{t('loading', locale)}</div>
          ) : profileData && (
            <>
              {/* ── v2.1 Profile Hero — layered gradient + conic-ring + 88px avatar ── */}
              <div style={{
                position: 'relative', textAlign: 'center',
                margin: '8px 0 18px',
                padding: '24px 20px 22px',
                borderRadius: 28, overflow: 'hidden',
                background:
                  'radial-gradient(circle at 50% 120%, var(--wb-accent-deep), transparent 60%),' +
                  'radial-gradient(circle at 100% 0%, var(--wb-accent-strong), transparent 50%),' +
                  'linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01)),' +
                  'var(--wb-card-strong)',
                border: '1px solid var(--wb-border)',
                boxShadow: '0 20px 50px -20px var(--wb-accent-shadow), inset 0 1px 0 rgba(255,255,255,0.08)',
                WebkitBackdropFilter: 'blur(20px)' as never,
                backdropFilter: 'blur(20px)' as never,
              }}>
                {/* Conic-gradient ring overlay (decorative) */}
                <div aria-hidden="true" style={{
                  position: 'absolute', inset: -1, borderRadius: 'inherit',
                  background: 'conic-gradient(from 140deg at 50% 50%, transparent 0deg, var(--wb-accent-soft-strong) 80deg, transparent 160deg)',
                  opacity: 0.35, pointerEvents: 'none',
                  WebkitMask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
                  mask: 'linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0)',
                  WebkitMaskComposite: 'xor' as never,
                  maskComposite: 'exclude',
                  padding: 1,
                }} />

                {/* Edit button — top right */}
                <button
                  onClick={() => {
                    setEditProfileName(profileData.displayName || '');
                    setEditProfileUsername(profileData.username || '');
                    setEditProfileBio(profileData.bio?.replace(/\n+$/, '') || '');
                    setEditProfileBirthday(profileData.birthday ? profileData.birthday.slice(0, 10) : '');
                    setEditingProfile(true);
                  }}
                  style={{
                    position: 'absolute', top: 12, right: 12, zIndex: 1,
                    background: 'var(--wb-surface)', border: '1px solid var(--wb-border)',
                    width: 36, height: 36, borderRadius: 14,
                    WebkitBackdropFilter: 'blur(20px) saturate(140%)' as never,
                    backdropFilter: 'blur(20px) saturate(140%)' as never,
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--wb-text)',
                  }}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                  </svg>
                </button>

                {/* Avatar XL — v2.1 88px with accent gradient + ambient shadow + inset top */}
                <div style={{ display: 'inline-block', position: 'relative', marginBottom: 12 }}>
                  <div
                    onClick={() => setShowAvatarSheet(true)}
                    style={{
                      width: 88, height: 88, borderRadius: '50%',
                      background: 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 36, fontWeight: 700, color: '#fff', letterSpacing: '-0.02em',
                      cursor: 'pointer', position: 'relative',
                      boxShadow: '0 12px 32px var(--wb-accent-shadow), inset 0 2px 0 rgba(255,255,255,0.25)',
                      ...(profileData.avatarUrl
                        ? { backgroundImage: `url(${profileData.avatarUrl})`, backgroundSize: 'cover', backgroundPosition: 'center' }
                        : {}),
                    }}>
                    {!profileData.avatarUrl && !avatarUploading && (profileData.displayName || tgUser?.first_name || '?')[0]!.toUpperCase()}
                    {avatarUploading && (
                      <div style={{ position: 'absolute', inset: 0, borderRadius: '50%', background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, color: '#fff' }}>…</div>
                    )}
                    {santaSeason?.inSeason && <SantaHatOverlay size={88} />}
                    {/* Outer ring -3px */}
                    <div aria-hidden="true" style={{ position: 'absolute', inset: -3, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.12)', pointerEvents: 'none' }} />
                  </div>
                  {!avatarUploading && (
                    <div onClick={() => setShowAvatarSheet(true)} style={{ position: 'absolute', bottom: 2, right: 2, width: 28, height: 28, borderRadius: '50%', background: 'var(--wb-accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid var(--wb-bg-elev)', cursor: 'pointer', boxShadow: '0 0 12px var(--wb-accent-shadow-soft)' }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>
                    </div>
                  )}
                </div>

                {/* PRO pill — Chip primitive, `pro` tone is canonical gradient pill */}
                {planInfo.code === 'PRO' && (
                  <div style={{ marginBottom: 10 }}>
                    <Chip
                      tone="pro"
                      size="sm"
                      icon={<span style={{ width: 6, height: 6, borderRadius: '50%', background: 'rgba(255,255,255,0.95)', boxShadow: '0 0 6px rgba(255,255,255,0.6)' }} />}
                    >
                      PRO
                    </Chip>
                  </div>
                )}

                {/* Name */}
                <div style={{ fontSize: 24, fontWeight: 800, color: '#fff', letterSpacing: '-0.02em', lineHeight: 1.2, fontFamily: font }}>
                  {profileData.displayName || tgUser?.first_name || t('profile_display_name', locale)}
                </div>

                {/* Username */}
                <div style={{ fontSize: 14, color: C.textMuted, marginTop: 4, fontWeight: 500 }}>
                  {profileData.username ? `@${profileData.username}` : t('profile_no_username', locale)}
                </div>

                {/* Bio */}
                {profileData.bio && (
                  <div style={{ fontSize: 13, color: C.textSec, marginTop: 8, lineHeight: 1.4, padding: '0 20px' }}>
                    {profileData.bio}
                  </div>
                )}

                {/* Stats row */}
                {profileStats && (
                  <div style={{ display: 'flex', gap: 0, marginTop: 16, background: 'rgba(255,255,255,0.03)', borderRadius: 14, border: '1px solid rgba(255,255,255,0.04)', overflow: 'hidden' }}>
                    <div onClick={() => setScreen('my-wishlists')} style={{ flex: 1, textAlign: 'center', padding: '14px 8px', borderRight: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer' }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#fff', letterSpacing: '-0.02em' }}>{profileStats.wishlists}</div>
                      <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>{t('profile_stat_wishlists', locale)}</div>
                    </div>
                    <div onClick={() => { setHomeTab('wishes'); void loadAllItems(); setScreen('my-wishlists'); }} style={{ flex: 1, textAlign: 'center', padding: '14px 8px', borderRight: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer' }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#fff', letterSpacing: '-0.02em' }}>{profileStats.totalWishes}</div>
                      <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>{t('profile_stat_wishes', locale)}</div>
                    </div>
                    <div onClick={() => setScreen('my-reservations')} style={{ flex: 1, textAlign: 'center', padding: '14px 8px', borderRight: '1px solid rgba(255,255,255,0.04)', cursor: 'pointer' }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#fff', letterSpacing: '-0.02em' }}>{profileStats.reservedByMe}</div>
                      <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>{t('profile_stat_reserved', locale)}</div>
                    </div>
                    <div onClick={() => { void loadGlobalArchive(); }} style={{ flex: 1, textAlign: 'center', padding: '14px 8px', cursor: 'pointer' }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#fff', letterSpacing: '-0.02em' }}>{profileStats.archived}</div>
                      <div style={{ fontSize: 10, color: C.textMuted, marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>{t('profile_stat_archived', locale)}</div>
                    </div>
                  </div>
                )}

                {/* Action buttons — Button primitives, settings first / share second.
                    `surface` = glass-secondary per v2.1; `primary-gradient` = brand CTA. */}
                <div style={{ display: 'flex', gap: 8, marginTop: 16, marginBottom: 8 }}>
                  <Button
                    variant="surface"
                    size="md"
                    onClick={() => { setSettingsOriginScreen(screen); loadSettings(); setScreen('settings'); }}
                    leftIcon={
                      <span style={{ position: 'relative', display: 'inline-flex' }}>
                        ⚙️
                        {hasNewInSettings && (
                          <span
                            aria-hidden="true"
                            style={{ position: 'absolute', top: -1, right: -5, width: 7, height: 7, borderRadius: '50%', background: 'var(--wb-warning, #FBBF24)' }}
                          />
                        )}
                      </span>
                    }
                  >
                    {t('settings_title', locale)}
                  </Button>
                  <Button
                    variant="primary-gradient"
                    size="md"
                    onClick={() => {
                      if (!profileData?.username) {
                        pushToast(t('share_profile_need_username', locale), 'info');
                        setEditProfileName(profileData?.displayName || '');
                        setEditProfileUsername('');
                        setEditProfileBio(profileData?.bio?.replace(/\n+$/, '') || '');
                        setEditProfileBirthday(profileData?.birthday ? profileData.birthday.slice(0, 10) : '');
                        setEditingProfile(true);
                        return;
                      }
                      const link = buildTgDeepLink(`profile_${profileData.username}`);
                      if (!link) return;
                      const shareText = `${profileData.displayName || profileData.username}\n${t('share_profile_cta', locale)}`;
                      const tgShareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(shareText)}`;
                      (window as any).Telegram?.WebApp?.openTelegramLink?.(tgShareUrl);
                    }}
                  >
                    {t('share_profile_btn_full', locale)}
                  </Button>
                </div>
              </div>

              {/* Spacer between header and plan */}
              <div style={{ height: 12 }} />

              {/* ── Referral program entry tile ── */}
              {/* Config is preloaded in app init (loadReferralRulesConfig).
                  Tile hides when program is off for this user (out of rollout
                  / disabled) or when entryPointProfile is false in admin config.
                  Impression fires once per profile-screen mount for funnel data. */}
              <ReferralProfileTileFromConfig
                config={referralRulesConfig}
                locale={locale}
                onOpen={() => openReferralScreen('profile_tile')}
                trackEvent={trackEvent}
              />

              {/* ── PRO Showcase entry card ── */}
              {(() => {
                const isPro = planInfo.code === 'PRO';
                const isProExpired = !isPro && !!subscription && subscription.status !== 'ACTIVE';
                const sc = showcaseData;
                const hasAnyContent = !!sc && (
                  !!sc.coverUrl || !!sc.bio || (sc.pinnedIds?.length ?? 0) > 0 ||
                  !!sc.preferences || !!sc.sizes?.clothing || !!sc.sizes?.shoes ||
                  !!sc.sizes?.ring || !!sc.sizes?.other || (sc.brands?.length ?? 0) > 0
                );
                const state: 'locked' | 'expired' | 'empty' | 'partial' | 'full' = !isPro
                  ? (isProExpired && hasAnyContent ? 'expired' : 'locked')
                  : (!hasAnyContent ? 'empty' : (sc?.enabled ? 'full' : 'partial'));

                const handleOpen = () => {
                  if (!isPro) {
                    trackEvent('showcase.paywall_viewed');
                    showUpsell('showcase');
                    return;
                  }
                  trackEvent('showcase.editor_opened');
                  loadShowcase();
                  setScreen('showcase-editor');
                };

                return (
                  <div style={{ marginBottom: 12 }}>
                    <div
                      onClick={handleOpen}
                      style={{
                        position: 'relative', cursor: 'pointer',
                        borderRadius: 18,
                        background: state === 'full'
                          ? `linear-gradient(135deg, rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.133), rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.031))`
                          : C.card,
                        border: `1px solid ${state === 'full' ? `rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.251)` : C.border}`,
                        padding: 16, overflow: 'hidden',
                      }}
                    >
                      {/* Cover thumbnail backdrop for full state */}
                      {state === 'full' && sc?.coverUrl && (
                        <div style={{
                          position: 'absolute', inset: 0,
                          backgroundImage: `linear-gradient(135deg, rgba(27,27,31,0.78), rgba(27,27,31,0.94)), url(${sc.coverUrl})`,
                          backgroundSize: 'cover', backgroundPosition: 'center',
                          pointerEvents: 'none',
                        }} />
                      )}
                      <div style={{ position: 'relative', display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                        <div style={{
                          width: 44, height: 44, borderRadius: 12,
                          background: `linear-gradient(135deg, ${C.accent}, var(--wb-accent-deep, #5B4BD6))`,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 22, flexShrink: 0,
                        }}>✨</div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
                            <span style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
                              {t('showcase_entry_title', locale)}
                            </span>
                            {!isPro && <ProBadge />}
                            {state === 'expired' && (
                              <span style={{
                                fontSize: 10, fontWeight: 700, color: C.textMuted,
                                background: 'rgba(255,255,255,0.06)', padding: '2px 6px',
                                borderRadius: 6,
                              }}>{t('showcase_entry_expired_badge', locale)}</span>
                            )}
                            {state === 'full' && (
                              <span style={{ fontSize: 11, color: C.green }}>● {t('showcase_section_configured', locale)}</span>
                            )}
                          </div>
                          <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.4 }}>
                            {state === 'expired'
                              ? t('showcase_entry_expired_note', locale)
                              : t('showcase_entry_desc', locale)}
                          </div>
                        </div>
                        <div style={{
                          color: C.accent, fontSize: 13, fontWeight: 600,
                          padding: '6px 10px', borderRadius: 10, flexShrink: 0,
                          background: 'rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.12)',
                        }}>
                          {state === 'locked' || state === 'expired'
                            ? t('showcase_entry_locked_cta', locale)
                            : state === 'empty'
                              ? t('showcase_entry_empty_cta', locale)
                              : t('showcase_entry_full_cta', locale)}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

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
                        <span style={{ fontSize: 15, fontWeight: 700, color: C.text, fontFamily: font }}>{t('plan_name_free', locale)}</span>
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

                  {/* FREE — Promo code block (always visible, never hidden after success) */}
                  {proSource !== 'subscription' && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: C.textSec, marginBottom: 8 }}>
                        {t('promo_title', locale)}
                      </div>
                      <div style={{ background: C.card, borderRadius: 16, padding: 16, border: `1px solid ${C.border}` }}>
                        {/* Active promo status — shown above input, not instead of it */}
                        {promoPro && (
                          <div style={{ marginBottom: 12 }}>
                            <div style={{
                              display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
                              background: `rgba(74, 222, 128, 0.071)`, borderRadius: 12, border: `1px solid rgba(74, 222, 128, 0.145)`,
                            }}>
                              <span style={{ fontSize: 16 }}>✅</span>
                              <span style={{ fontSize: 13, fontWeight: 600, color: C.green, lineHeight: 1.3 }}>
                                {promoPro.expiresAt
                                  ? t('promo_success', locale, { date: new Date(promoPro.expiresAt).toLocaleDateString(localeToBCP47(locale), { day: '2-digit', month: '2-digit', year: 'numeric' }) })
                                  : t('pro_forever', locale)}
                              </span>
                            </div>
                            <Button
                              variant="primary-gradient"
                              size="md"
                              style={{ marginTop: 8 }}
                              onClick={() => showUpsell('wishlist_limit')}
                            >
                              {t('promo_keep_pro', locale)}
                            </Button>
                          </div>
                        )}
                        {/* Input + button — always visible, vertical layout for mobile */}
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          <input
                            id="promo-input"
                            type="text"
                            placeholder={t('promo_placeholder', locale)}
                            style={{
                              width: '100%', padding: '12px 14px', fontSize: 14, fontWeight: 500,
                              background: C.surface, color: C.text, border: `1px solid ${C.borderLight}`,
                              borderRadius: 12, outline: 'none', fontFamily: font,
                              boxSizing: 'border-box',
                            }}
                            autoCapitalize="characters"
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                (e.target as HTMLInputElement).blur();
                                // Trigger activate on Enter
                                document.getElementById('promo-activate-btn')?.click();
                              }
                            }}
                          />
                          <Button
                            id="promo-activate-btn"
                            variant="primary"
                            size="md"
                            onClick={async () => {
                              const input = document.getElementById('promo-input') as HTMLInputElement | null;
                              if (!input?.value?.trim()) return;
                              const code = input.value.trim();
                              const btn = document.getElementById('promo-activate-btn') as HTMLButtonElement | null;
                              if (input) input.disabled = true;
                              if (btn) { btn.disabled = true; btn.textContent = t('promo_activating', locale); }
                              try {
                                const r = await tgFetch('/tg/promo/apply', {
                                  method: 'POST',
                                  body: JSON.stringify({ code }),
                                  idempotency: { action: `promo.apply:${code}` },
                                });
                                const data = await r.json() as any;
                                if (r.ok) {
                                  if (data.status === 'activated' || data.status === 'already_active') {
                                    pushToast(data.status === 'already_active' ? t('promo_already_active', locale) : t('promo_success', locale, { date: new Date(data.expiresAt).toLocaleDateString(localeToBCP47(locale)) }), 'success');
                                    if (input) input.value = '';
                                    loadWishlists().catch(() => {});
                                  } else if (data.status === 'accepted_for_paid') {
                                    pushToast(t('promo_accepted_paid', locale), 'success');
                                    if (input) input.value = '';
                                  }
                                } else {
                                  const errKey = data.error === 'already_used' ? 'promo_already_used'
                                    : data.error === 'invalid_code' ? 'promo_invalid'
                                    : data.error === 'campaign_exhausted' ? 'promo_campaign_exhausted'
                                    : 'promo_error';
                                  pushToast(t(errKey, locale), 'error');
                                }
                              } catch {
                                pushToast(t('promo_error', locale), 'error');
                              } finally {
                                if (input) input.disabled = false;
                                if (btn) { btn.disabled = false; btn.textContent = t('promo_activate', locale); }
                              }
                            }}
                          >
                            {t('promo_activate', locale)}
                          </Button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* FREE — Pro unlock block */}
                  <div style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.textSec, marginBottom: 8 }}>
                      {t('settings_pro_unlock_title', locale)}
                    </div>
                    <div style={{
                      background: `linear-gradient(145deg, ${C.card}, rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.031))`,
                      borderRadius: 16, padding: 16,
                      border: `1px solid rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.145)`,
                    }}>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                        {getProBenefits(locale).map((b, i, arr) => {
                          const firstRes = b.resSection && (i === 0 || !arr[i - 1]?.resSection);
                          return (
                            <Fragment key={i}>
                              {firstRes && (
                                <div style={{
                                  fontSize: 11, fontWeight: 700, color: C.accent,
                                  textTransform: 'uppercase', letterSpacing: 0.4,
                                  paddingTop: 8, marginBottom: -2,
                                  borderTop: `1px solid rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.125)`,
                                }}>
                                  {t('plan_pro_res_section', locale)}
                                </div>
                              )}
                              <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                                <span style={{
                                  width: 22, height: 22, borderRadius: 11, flexShrink: 0, marginTop: 1,
                                  background: C.accentSoft, color: C.accent,
                                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                                  fontSize: 11, fontWeight: 800,
                                }}>✓</span>
                                <div>
                                  <div style={{ fontSize: 14, fontWeight: 600, color: C.text, lineHeight: 1.3 }}>
                                    {b.title}
                                    {b.isNew && (
                                      <span style={{
                                        display: 'inline-block', padding: '1px 6px', borderRadius: 4,
                                        fontSize: 9, fontWeight: 800, background: C.accent, color: '#fff',
                                        marginLeft: 6, verticalAlign: 'middle', letterSpacing: 0.5,
                                      }}>NEW</span>
                                    )}
                                  </div>
                                  <div style={{ fontSize: 12, color: C.textMuted, marginTop: 1, lineHeight: 1.4 }}>{b.subtitle}</div>
                                </div>
                              </div>
                            </Fragment>
                          );
                        })}
                      </div>
                      <div style={{ paddingTop: 14, borderTop: `1px solid rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.125)`, marginBottom: 14 }}>
                        <span style={{ fontSize: 22, fontWeight: 800, color: C.text }}>100</span>
                        {' '}
                        <span style={{ fontSize: 15, fontWeight: 600, color: C.text }}>Stars</span>
                        <span style={{ fontSize: 13, color: C.textSec }}> {t('upsell_per_month', locale)}</span>
                      </div>
                      <Button
                        variant="primary-gradient"
                        onClick={() => showUpsell('pro_main')}
                      >
                        {t('connect_pro', locale)}
                      </Button>
                      <div style={{ fontSize: 11, color: C.textMuted, marginTop: 8, textAlign: 'center' }}>
                        {t('upsell_auto_renew', locale)}
                      </div>
                    </div>
                  </div>

                  {/* One-time upgrades block — shown when availableSkus populated */}
                  {availableSkus.length > 0 && (() => {
                    const planScreenSkus = ['extra_wishlist_slot', 'extra_items_5', 'extra_items_15', 'extra_subscription_slot', 'gift_notes_unlock', 'reservation_pro_unlock']
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
                            // gift_notes_unlock — hide if already unlocked (via purchase or PRO)
                            if (sku.code === 'gift_notes_unlock' && gnAccess.unlocked) return null;
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
                                      <Button
                                        variant="secondary"
                                        size="sm"
                                        fullWidth={false}
                                        // Only THIS row animates while THIS sku checks out.
                                        loading={addonLoadingSku === sku.code}
                                        disabled={isLoading}
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
                                        style={{ borderRadius: 8, padding: '5px 12px', fontSize: 13, fontWeight: 700, minHeight: 0, whiteSpace: 'nowrap' }}
                                      >
                                        {t('addon_cta_buy', locale)}
                                      </Button>
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
                  {(() => {
                    // Single lifetime gate for the entire Settings PRO card —
                    // header label + badge, period-end / cancelled banners,
                    // cancel/reactivate buttons, and the no-renewal note all
                    // branch on the same `isLifetime` value below.
                    const isLifetime = subscription?.billingPeriod === 'lifetime';
                    return (
                  <>
                  <div style={{
                    background: `linear-gradient(145deg, ${C.card}, rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.031))`,
                    borderRadius: 16, padding: 20,
                    border: `1px solid rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.145)`,
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                      <span style={{ fontSize: 15, fontWeight: 600, color: C.textSec, fontFamily: font }}>
                        {isLifetime ? (
                          <>
                            <span style={{ marginRight: 8 }}>∞</span>
                            {t('pro_lifetime_active_title', locale)}
                          </>
                        ) : t('settings_plan', locale)}
                      </span>
                      <span style={isLifetime ? {
                        fontSize: 11, fontWeight: 800, letterSpacing: 0.4, padding: '4px 10px', borderRadius: 100,
                        background: 'var(--wb-warning, #FBBF24)', color: '#1a1300',
                        boxShadow: '0 4px 14px rgba(251,191,36,0.40), inset 0 1px 0 rgba(255,255,255,0.4)',
                        textTransform: 'uppercase' as const,
                      } : {
                        fontSize: 12, fontWeight: 800, letterSpacing: 0.5, padding: '4px 10px', borderRadius: 6,
                        background: `linear-gradient(135deg, rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.133), rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.071))`,
                        border: `1px solid rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.188)`,
                        color: C.accent,
                      }}>{isLifetime ? t('paywall_plan_lifetime_badge', locale) : 'PRO'}</span>
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
                        { label: t('settings_event_calendar', locale), desc: t('settings_desc_event_calendar', locale) },
                        { label: t('settings_lite_share', locale), desc: t('settings_desc_lite_share', locale) },
                        { label: t('settings_dont_gift', locale), desc: t('settings_desc_dont_gift', locale) },
                        { label: t('smart_res_section_title', locale), desc: t('smart_res_toggle_hint', locale) },
                        { label: `🔒 ${t('plan_pro_f19', locale)}`, desc: t('plan_pro_sub19', locale) },
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

                    {/* Subscription info — LIFETIME (gold "no expiration" + monthly-still-active hint) */}
                    {isLifetime && (
                      <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '10px 14px', borderRadius: 12,
                          background: 'rgba(251,191,36,0.10)',
                          border: '1px solid rgba(251,191,36,0.28)',
                          fontSize: 13, color: C.text, lineHeight: 1.4,
                        }}>
                          <span style={{ fontSize: 15 }}>∞</span>
                          <span><strong>{t('pro_lifetime_active_desc', locale)}</strong></span>
                        </div>
                        <div style={{
                          marginTop: 10, fontSize: 12, color: C.textMuted, lineHeight: 1.5,
                          padding: '0 4px',
                        }}>
                          {t('pro_lifetime_existing_monthly_warning', locale)}
                        </div>
                      </div>
                    )}

                    {/* Subscription info — ACTIVE_RENEWING (non-lifetime only) */}
                    {!isLifetime && subscription && !subscription.cancelAtPeriodEnd && subscription.status !== 'CANCELLED' && (
                      <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 13, color: C.textSec }}>{t('settings_next_renewal', locale)}</span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
                            {new Date(subscription.periodEnd).toLocaleDateString(localeToBCP47(locale), { day: 'numeric', month: 'long', year: 'numeric' })}
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Subscription info — ACTIVE_CANCELLED (non-lifetime only) */}
                    {!isLifetime && subscription && (subscription.cancelAtPeriodEnd || subscription.status === 'CANCELLED') && (
                      <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '10px 14px', borderRadius: 10,
                          background: C.orangeSoft, fontSize: 13, color: C.orange, lineHeight: 1.4,
                        }}>
                          <span>⏳</span>
                          <span>
                            {t('settings_renewal_disabled', locale)}{' '}
                            <strong>{new Date(subscription.periodEnd).toLocaleDateString(localeToBCP47(locale), { day: 'numeric', month: 'long', year: 'numeric' })}</strong>.
                          </span>
                        </div>
                      </div>
                    )}

                    {/* Promo-PRO status — persistent, survives refresh */}
                    {proSource === 'promo' && promoPro && (
                      <div style={{ marginTop: 16, paddingTop: 14, borderTop: `1px solid ${C.border}` }}>
                        <div style={{
                          display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px',
                          background: `rgba(74, 222, 128, 0.071)`, borderRadius: 10, border: `1px solid rgba(74, 222, 128, 0.145)`,
                        }}>
                          <span style={{ fontSize: 15 }}>🎁</span>
                          <span style={{ fontSize: 13, fontWeight: 600, color: C.green, lineHeight: 1.3 }}>
                            {promoPro.expiresAt
                              ? t('promo_success', locale, { date: new Date(promoPro.expiresAt).toLocaleDateString(localeToBCP47(locale), { day: '2-digit', month: '2-digit', year: 'numeric' }) })
                              : t('pro_forever', locale)}
                          </span>
                        </div>
                        <Button
                          variant="primary-gradient"
                          size="md"
                          style={{ marginTop: 10 }}
                          onClick={() => showUpsell('wishlist_limit')}
                        >
                          {t('promo_keep_pro', locale)}
                        </Button>
                      </div>
                    )}

                    {/* Paid PRO + accepted promo fallback B */}
                    {proSource === 'subscription' && promoPro === null && (() => {
                      // Check if user has an accepted_for_paid redemption (we don't have this in state yet, so skip for now)
                      return null;
                    })()}
                  </div>

                  {/* Plan action buttons — hidden for lifetime (no auto-renewal to manage). */}
                  {!isLifetime && (
                    <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {subscription && !subscription.cancelAtPeriodEnd && subscription.status !== 'CANCELLED' && (
                        <Button variant="secondary" onClick={() => setShowCancelSub(true)}>
                          {t('settings_cancel_renewal', locale)}
                        </Button>
                      )}
                      {subscription && (subscription.cancelAtPeriodEnd || subscription.status === 'CANCELLED') && (
                        <Button
                          variant="primary-gradient"
                          loading={cancelSubLoading}
                          disabled={cancelSubLoading}
                          onClick={() => void handleReactivateSub()}
                        >
                          {t('settings_resume_sub', locale)}
                        </Button>
                      )}
                    </div>
                  )}
                  {isLifetime && (
                    <div style={{
                      marginTop: 14, fontSize: 11.5, color: C.textMuted, lineHeight: 1.5,
                      textAlign: 'center', letterSpacing: 0.05,
                    }}>
                      {t('pro_lifetime_no_renewal_note', locale)}
                    </div>
                  )}
                  </>
                    );
                  })()}
                </div>
              )}

              {/* Promo code input — shown for PRO users too (promo-PRO or paid, for future codes) */}
              {planInfo.code === 'PRO' && (
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.textSec, marginBottom: 8 }}>
                    {t('promo_title', locale)}
                  </div>
                  <div style={{ background: C.card, borderRadius: 16, padding: 16, border: `1px solid ${C.border}` }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                      <input
                        id="promo-input-pro"
                        type="text"
                        placeholder={t('promo_placeholder', locale)}
                        style={{
                          width: '100%', padding: '12px 14px', fontSize: 14, fontWeight: 500,
                          background: C.surface, color: C.text, border: `1px solid ${C.borderLight}`,
                          borderRadius: 12, outline: 'none', fontFamily: font, boxSizing: 'border-box',
                        }}
                        autoCapitalize="characters"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            (e.target as HTMLInputElement).blur();
                            document.getElementById('promo-activate-btn-pro')?.click();
                          }
                        }}
                      />
                      <Button
                        id="promo-activate-btn-pro"
                        variant="primary"
                        size="md"
                        onClick={async () => {
                          const input = document.getElementById('promo-input-pro') as HTMLInputElement | null;
                          if (!input?.value?.trim()) return;
                          const code = input.value.trim();
                          const btn = document.getElementById('promo-activate-btn-pro') as HTMLButtonElement | null;
                          if (input) input.disabled = true;
                          if (btn) { btn.disabled = true; btn.textContent = t('promo_activating', locale); }
                          try {
                            const r = await tgFetch('/tg/promo/apply', { method: 'POST', body: JSON.stringify({ code }), idempotency: { action: `promo.apply:${code}` } });
                            const data = await r.json() as any;
                            if (r.ok) {
                              if (data.status === 'activated' || data.status === 'already_active') {
                                pushToast(t(data.status === 'already_active' ? 'promo_already_active' : 'promo_success', locale, { date: data.expiresAt ? new Date(data.expiresAt).toLocaleDateString(localeToBCP47(locale)) : '' }), 'success');
                                if (input) input.value = '';
                                loadWishlists().catch(() => {});
                              } else if (data.status === 'accepted_for_paid') {
                                pushToast(t('promo_accepted_paid', locale), 'success');
                                if (input) input.value = '';
                              }
                            } else {
                              const errKey = data.error === 'already_used' ? 'promo_already_used' : data.error === 'invalid_code' ? 'promo_invalid' : data.error === 'campaign_exhausted' ? 'promo_campaign_exhausted' : 'promo_error';
                              pushToast(t(errKey, locale), 'error');
                            }
                          } catch { pushToast(t('promo_error', locale), 'error'); }
                          finally {
                            if (input) input.disabled = false;
                            if (btn) { btn.disabled = false; btn.textContent = t('promo_activate', locale); }
                          }
                        }}
                      >
                        {t('promo_activate', locale)}
                      </Button>
                    </div>
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
                      {profileData.birthday ? new Date(profileData.birthday).toLocaleDateString(localeToBCP47(locale), {
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
                            idempotency: { action: 'me.profile.hide-year' },
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
                            idempotency: { action: 'me.profile.avatar-public' },
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
                          const res = await tgFetch('/tg/me/god-mode', { method: 'POST', idempotency: { action: 'me.god-mode' } });
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
                              const res = await tgFetch('/tg/santa/season/test-mode', {
                                method: 'POST',
                                idempotency: { action: 'santa.admin.test-mode' },
                              });
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

                  {/* Locale debug toggle — only when godMode active */}
                  {godMode && (
                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${C.border}` }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#7fdbca', fontFamily: font }}>🛠 Locale debug</div>
                          <div style={{ fontSize: 11, color: C.textMuted, marginTop: 2 }}>
                            {showLocaleDebug ? 'Panel visible in settings' : 'Panel hidden'}
                          </div>
                        </div>
                        <button
                          onClick={() => setShowLocaleDebug((v: boolean) => !v)}
                          style={{
                            width: 50, height: 28, borderRadius: 14, border: 'none', cursor: 'pointer',
                            background: showLocaleDebug ? '#7fdbca' : C.surface,
                            position: 'relative', transition: 'background 0.2s',
                          }}
                        >
                          <div style={{
                            width: 22, height: 22, borderRadius: 11,
                            background: '#fff', position: 'absolute', top: 3,
                            left: showLocaleDebug ? 25 : 3,
                            transition: 'left 0.2s',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
                          }} />
                        </button>
                      </div>
                    </div>
                  )}

                  {/* ─── God Mode Dashboard ─── */}
                  {godMode && (() => {
                    const pct = (n: number, d: number) => d > 0 ? Math.round(n / d * 100) : 0;
                    const fmt1 = (n: number) => n === 0 ? '—' : Number.isFinite(n) ? n.toFixed(1) : '—';
                    const relativeTime = (d: Date | null) => {
                      if (!d) return '';
                      const sec = Math.round((Date.now() - d.getTime()) / 1000);
                      if (sec < 10) return 'только что';
                      if (sec < 60) return `${sec} сек назад`;
                      const min = Math.round(sec / 60);
                      return min < 60 ? `${min} мин назад` : d.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' });
                    };
                    /** Smart delta: mutes % when base < 10 to avoid misleading +100% on tiny numbers */
                    const safeDelta = (cur: number, prev: number): { str: string; color: string } => {
                      if (prev === 0 && cur === 0) return { str: '—', color: C.textMuted };
                      if (prev === 0) return { str: `+${cur}`, color: C.green };
                      const d = cur - prev;
                      const p = Math.round((d / prev) * 100);
                      const pStr = prev >= 10 ? ` (${p >= 0 ? '+' : ''}${p}%)` : '';
                      return { str: `${d >= 0 ? '+' : ''}${d}${pStr}`, color: d > 0 ? C.green : d < 0 ? (p <= -30 ? C.red : C.orange) : C.textMuted };
                    };
                    const loadRetention = async (period: number) => {
                      setRetentionLoading(true);
                      try { const r = await tgFetch(`/tg/me/retention-stats?period=${period}`); if (r.ok) setRetentionStats(await r.json()); } catch {}
                      setRetentionLoading(false);
                    };

                    // ── Shared components ──
                    const SectionCard = ({ children, style: s }: { children: React.ReactNode; style?: React.CSSProperties }) => (
                      <div style={{ background: C.surface, borderRadius: 12, padding: '10px 12px', marginBottom: 8, ...s }}>{children}</div>
                    );
                    const SectionTitle = ({ icon, label, color, badge }: { icon: string; label: string; color: string; badge?: string }) => (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, marginTop: 4 }}>
                        <span style={{ fontSize: 12 }}>{icon}</span>
                        <span style={{ fontSize: 11, fontWeight: 700, color, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{label}</span>
                        {badge && <span style={{ fontSize: 8, fontWeight: 600, color: C.textMuted, background: 'rgba(255,255,255,0.06)', borderRadius: 4, padding: '1px 5px' }}>{badge}</span>}
                      </div>
                    );
                    const KpiRow = ({ label, value, color, hint, isPartial }: { label: string; value: string | number; color?: string; hint?: string; isPartial?: boolean }) => (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', padding: '3px 0' }}>
                        <span style={{ fontSize: 11, color: isPartial ? C.textMuted : C.textSec }}>{label}{hint ? <span style={{ fontSize: 9, color: '#555', marginLeft: 4 }}>({hint})</span> : null}</span>
                        <span style={{ fontSize: 11, fontWeight: 600, color: color ?? C.text, fontVariantNumeric: 'tabular-nums', opacity: isPartial ? 0.7 : 1 }}>{value}</span>
                      </div>
                    );
                    const DeltaRow = ({ label, cur, prev, isEvent }: { label: string; cur: number; prev: number; isEvent?: boolean }) => {
                      const d = safeDelta(cur, prev);
                      return (
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 0' }}>
                          <span style={{ fontSize: 11, color: isEvent ? C.textMuted : C.textSec }}>{label}</span>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <span style={{ fontSize: 12, fontWeight: 600, color: isEvent ? C.textMuted : C.text, fontVariantNumeric: 'tabular-nums', opacity: isEvent ? 0.7 : 1 }}>{cur}</span>
                            <span style={{ fontSize: 10, color: d.color, minWidth: 44, textAlign: 'right' }}>{d.str}</span>
                          </div>
                        </div>
                      );
                    };
                    /** Conversion % with color coding */
                    const ConvPct = ({ val, isPartial }: { val: number | null; isPartial?: boolean }) => {
                      if (val == null) return null;
                      const c = isPartial ? C.textMuted : val >= 30 ? C.green : val <= 5 ? C.orange : C.text;
                      return <span style={{ fontSize: 12, fontWeight: 600, color: c, fontVariantNumeric: 'tabular-nums', opacity: isPartial ? 0.7 : 1 }}>{val}%</span>;
                    };
                    /** "partial" badge for event-based metrics */
                    const PartialBadge = () => (
                      <span style={{ fontSize: 7, fontWeight: 700, color: 'var(--wb-warning, #FBBF24)', background: 'rgba(251,191,36,0.12)', borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase', letterSpacing: '0.03em', verticalAlign: 'middle', marginLeft: 4 }}>event</span>
                    );
                    /** DB truth badge */
                    const DbBadge = () => (
                      <span style={{ fontSize: 7, fontWeight: 700, color: '#5B8DEF', background: 'rgba(91,141,239,0.12)', borderRadius: 3, padding: '1px 5px', textTransform: 'uppercase', letterSpacing: '0.03em', verticalAlign: 'middle', marginLeft: 4 }}>бд</span>
                    );
                    const SectionDivider = () => <div style={{ height: 1, background: 'rgba(255,255,255,0.04)', margin: '6px 0' }} />;
                    const CollapsibleBlock = ({ title, open, onToggle, children, color, badge }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode; color?: string; badge?: React.ReactNode }) => (
                      <div>
                        <button onClick={onToggle} style={{ background: 'none', border: 'none', cursor: 'pointer', width: '100%', padding: '6px 0', textAlign: 'left', fontFamily: font, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ fontSize: 10, fontWeight: 600, color: color ?? C.textMuted, display: 'flex', alignItems: 'center', gap: 4 }}>{open ? '▾' : '▸'} {title}{badge}</span>
                        </button>
                        {open && children}
                      </div>
                    );

                    return (
                      <div style={{ marginTop: 14, paddingTop: 12, borderTop: `1px solid rgba(255,255,255,0.08)` }}>
                        {/* ── Dashboard Header ── */}
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontSize: 14 }}>📊</span>
                            <span style={{ fontSize: 13, fontWeight: 700, color: '#ff9900', letterSpacing: '0.04em' }}>Дашборд</span>
                          </div>
                          <button onClick={() => void loadGodStats()} disabled={godStatsLoading} style={{ background: C.surface, border: 'none', cursor: godStatsLoading ? 'wait' : 'pointer', fontSize: 11, color: C.textMuted, padding: '4px 10px', borderRadius: 8, opacity: godStatsLoading ? 0.5 : 1, fontFamily: font, display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ display: 'inline-block', animation: godStatsLoading ? 'spin 1s linear infinite' : 'none', fontSize: 12 }}>↻</span>
                            {godStatsLoading ? '…' : 'Обновить'}
                          </button>
                        </div>
                        {godStatsError && !godStatsLoading && (
                          <div style={{ fontSize: 11, color: C.red, padding: '4px 8px 6px', display: 'flex', alignItems: 'center', gap: 4, background: C.redSoft, borderRadius: 8, marginBottom: 8 }}>⚠ Ошибка{godStats ? ' — показаны старые данные' : ''}</div>
                        )}
                        {godStatsLoading && !godStats && (
                          <div style={{ fontSize: 12, color: C.textMuted, textAlign: 'center', padding: '16px 0' }}>Загружаю…</div>
                        )}
                        {godStats && (() => {
                          const o = godStats.overview;
                          const acq = godStats.acquisition;
                          return (
                            <>
                              {/* ═══════════════════════════════════════════
                                  A. ОБЗОР — executive summary grid
                                  ═══════════════════════════════════════════ */}
                              <SectionTitle icon="◉" label="Обзор" color="#FF9500" />
                              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, marginBottom: 4 }}>
                                {([
                                  ['Пользователи', o.totalUsers, '#FF9500'],
                                  ['Новые 24ч', o.newUsers24h, null],
                                  ['Новые 7д', o.newUsers7d, null],
                                  ['Актив. 7д', o.activeUsers7d, '#5B8DEF'],
                                  ['Актив. 30д', o.activeUsers30d, null],
                                  ['Вишлисты', o.totalWishlists, null],
                                  ['Желания', o.totalItems, null],
                                  ['Брони', o.totalReservations, '#34C759'],
                                  ['PRO', o.proUsers, '#AF52DE'],
                                ] as [string, number, string | null][]).map(([label, value, accent]) => (
                                  <div key={label} style={{ background: C.surface, borderRadius: 10, padding: '6px 8px' }}>
                                    <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 2, lineHeight: 1 }}>{label}</div>
                                    <div style={{ fontSize: 15, fontWeight: 700, color: accent ?? C.text, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{value}</div>
                                  </div>
                                ))}
                              </div>
                              <div style={{ fontSize: 10, color: C.textMuted, marginBottom: 2, padding: '0 2px', lineHeight: 1.5 }}>
                                жел./вишл. <span style={{ color: C.textSec, fontWeight: 600 }}>{fmt1(o.totalWishlists > 0 ? o.totalItems / o.totalWishlists : 0)}</span>
                                {' · '}
                                вишл./польз. <span style={{ color: C.textSec, fontWeight: 600 }}>{fmt1(godStats.funnel.usersWithWishlist > 0 ? o.totalWishlists / godStats.funnel.usersWithWishlist : 0)}</span>
                                {' · '}
                                PRO <span style={{ color: '#AF52DE', fontWeight: 600 }}>{pct(o.proUsers, o.totalUsers)}%</span>
                              </div>

                              <SectionDivider />

                              {/* ═══════════════════════════════════════════
                                  B. АКТИВАЦИЯ — tabbed: funnel / onboarding / acquisition
                                  ═══════════════════════════════════════════ */}
                              <SectionTitle icon="⚡" label="Активация" color="#5B8DEF" />
                              <div style={{ display: 'flex', gap: 0, marginBottom: 8, background: C.bg, borderRadius: 10, padding: 2, border: `1px solid ${C.border}` }}>
                                {(['funnel', 'onboarding', 'acq'] as const).map((tab) => (
                                  <button key={tab} onClick={() => setActivationTab(tab)} style={{
                                    flex: 1, padding: '5px 0', borderRadius: 8, border: 'none', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                                    background: activationTab === tab ? '#5B8DEF' : 'transparent',
                                    color: activationTab === tab ? '#fff' : C.textMuted, fontFamily: font,
                                    transition: 'background 0.2s, color 0.2s',
                                  }}>
                                    {tab === 'funnel' ? 'Воронка' : tab === 'onboarding' ? 'Онбординг' : 'Привлечение'}
                                  </button>
                                ))}
                              </div>

                              {/* ── B1: Funnel ── */}
                              {activationTab === 'funnel' && (() => {
                                const steps = [
                                  { label: 'Любой вишлист', value: godStats.funnel.usersWithAnyWishlist ?? godStats.funnel.usersWithWishlist },
                                  { label: 'Обычный вишлист', value: godStats.funnel.usersWithWishlist },
                                  { label: 'Добавили желание', value: godStats.funnel.usersWithItem },
                                  { label: 'Перешли по ссылке', value: godStats.funnel.usersWithLinkOpen ?? godStats.funnel.usersWhoInitiatedShare },
                                  { label: 'Забронировали', value: godStats.funnel.usersWithReservation },
                                ];
                                const total = godStats.funnel.totalUsers;
                                return (
                                  <SectionCard>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                                      <span style={{ fontSize: 10, color: C.textMuted }}>Всего пользователей</span>
                                      <span style={{ fontSize: 12, fontWeight: 700, color: '#FF9500', fontVariantNumeric: 'tabular-nums' }}>{total}</span>
                                    </div>
                                    {steps.map((step, i) => {
                                      const p = pct(step.value, total);
                                      return (
                                        <div key={i} style={{ marginBottom: 4 }}>
                                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 2 }}>
                                            <span style={{ fontSize: 11, color: C.textSec }}>{step.label}</span>
                                            <span style={{ fontSize: 11, fontWeight: 600, color: C.text, fontVariantNumeric: 'tabular-nums' }}>
                                              {step.value} <span style={{ color: C.textMuted, fontWeight: 400, fontSize: 10 }}>{p}%</span>
                                            </span>
                                          </div>
                                          <div style={{ height: 3, borderRadius: 2, background: C.border, overflow: 'hidden' }}>
                                            <div style={{ height: '100%', borderRadius: 2, width: `${p}%`, background: '#5B8DEF', transition: 'width 0.4s ease' }} />
                                          </div>
                                        </div>
                                      );
                                    })}
                                  </SectionCard>
                                );
                              })()}

                              {/* ── B2: Onboarding ── */}
                              {activationTab === 'onboarding' && (() => {
                                const ab = godStats.onboardingAB;
                                if (!ab) return <SectionCard><div style={{ fontSize: 11, color: C.textMuted, padding: '4px 0' }}>Нет данных онбординга</div></SectionCard>;
                                const v2s = ab.started['v2_try'] ?? 0;
                                const v2c = ab.completed['v2_try'] ?? 0;
                                const v2wl = ab.firstWishlist['v2_try'] ?? 0;
                                const v2item = ab.firstItem['v2_try'] ?? 0;
                                const convRate = ab.conversionRates?.['v2_try']?.startToComplete ?? '—';
                                return (
                                  <SectionCard>
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 12px', marginBottom: 4 }}>
                                      {([['Начали', v2s], ['Завершили', v2c], ['1й вишлист', v2wl], ['1й item', v2item]] as [string, number][]).map(([label, val]) => (
                                        <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', borderBottom: `1px solid ${C.border}` }}>
                                          <span style={{ fontSize: 11, color: C.textMuted }}>{label}</span>
                                          <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--wb-accent, #8B7BFF)', fontVariantNumeric: 'tabular-nums' }}>{val}</span>
                                        </div>
                                      ))}
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: `1px solid ${C.border}`, marginBottom: 4 }}>
                                      <span style={{ fontSize: 11, color: C.textMuted }}>Конв. start→complete</span>
                                      <span style={{ fontSize: 12, fontWeight: 700, color: v2s > 0 ? (v2c / v2s >= 0.5 ? C.green : v2c / v2s >= 0.2 ? C.orange : C.red) : C.textMuted }}>{convRate}</span>
                                    </div>
                                    {Object.keys(ab.v2AcquisitionPaths).length > 0 && (
                                      <>
                                        <div style={{ fontSize: 9, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2, marginTop: 2 }}>Пути</div>
                                        {Object.entries(ab.v2AcquisitionPaths).map(([path, count]) => (
                                          <div key={path} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0' }}>
                                            <span style={{ fontSize: 11, color: C.textSec }}>{path}</span>
                                            <span style={{ fontSize: 11, fontWeight: 600, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{count as number}</span>
                                          </div>
                                        ))}
                                      </>
                                    )}
                                  </SectionCard>
                                );
                              })()}

                              {/* ── B3: Acquisition ── */}
                              {activationTab === 'acq' && (() => {
                                if (!acq) return <SectionCard><div style={{ fontSize: 11, color: C.textMuted, padding: '4px 0' }}>Нет данных привлечения</div></SectionCard>;
                                const c = acq.current; const p = acq.previous;
                                const evCov = acq.eventCoverage;
                                const pDays = evCov?.periodDays ?? (acqPeriod === '24h' ? 1 : acqPeriod === '30d' ? 30 : 7);
                                const anyEventIncomplete = evCov ? (evCov.botStartsDays < pDays || evCov.miniappOpensDays < pDays || evCov.guestEventsDays < pDays) : false;
                                return (
                                  <>
                                    <div style={{ display: 'flex', gap: 2, marginBottom: 8, background: C.bg, borderRadius: 8, padding: 2 }}>
                                      {(['24h', '7d', '30d'] as const).map(pd => (
                                        <button key={pd} onClick={() => { setAcqPeriod(pd); loadGodStats(undefined, pd); }} style={{
                                          flex: 1, padding: '4px 0', borderRadius: 6, border: 'none', fontSize: 11, fontWeight: 600, cursor: 'pointer',
                                          background: acqPeriod === pd ? C.accent : 'transparent',
                                          color: acqPeriod === pd ? '#fff' : C.textMuted, fontFamily: font,
                                        }}>{pd}</button>
                                      ))}
                                    </div>
                                    {acq.excludedTestUsers > 0 && <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 4 }}>без тестовых ({acq.excludedTestUsers})</div>}
                                    <SectionCard>
                                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
                                        <span style={{ fontSize: 9, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Рост</span>
                                        <DbBadge />
                                      </div>
                                      <DeltaRow label="Новых пользователей" cur={c.newUsers} prev={p.newUsers} />
                                      <DeltaRow label="Первый вишлист" cur={c.firstWishlist} prev={p.firstWishlist} />
                                      <DeltaRow label="Первое желание" cur={c.firstWish} prev={p.firstWish} />
                                      <DeltaRow label="Поделились" cur={c.ownersShared} prev={p.ownersShared} />
                                      <DeltaRow label="Гостевых просмотров" cur={c.guestOpens} prev={p.guestOpens} />
                                      <DeltaRow label="Забронировали" cur={c.reservers} prev={p.reservers} />
                                    </SectionCard>
                                    {acq.conversions.newToWishlist != null && (
                                      <SectionCard style={{ marginTop: -4 }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3 }}>
                                          <span style={{ fontSize: 9, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Конверсии</span>
                                          <DbBadge />
                                        </div>
                                        {([
                                          ['Новый → вишлист', acq.conversions.newToWishlist],
                                          ['Новый → желание', acq.conversions.newToWish],
                                          ['Вишлист → шеринг', acq.conversions.wishlistToShare],
                                        ] as [string, number | null][]).filter(([, v]) => v != null).map(([label, val]) => (
                                          <div key={label as string} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
                                            <span style={{ fontSize: 11, color: C.textSec }}>{label as string}</span>
                                            <ConvPct val={val as number} />
                                          </div>
                                        ))}
                                      </SectionCard>
                                    )}
                                    {acq.sources.length > 0 && (
                                      <CollapsibleBlock title="Источники новых" open={godStatsDetailsOpen} onToggle={() => setGodStatsDetailsOpen((v: boolean) => !v)}>
                                        <SectionCard style={{ marginTop: 4 }}>
                                          <div style={{ display: 'flex', padding: '0 0 3px', borderBottom: `1px solid ${C.border}`, marginBottom: 2 }}>
                                            <span style={{ fontSize: 8, color: C.textMuted, flex: 1 }}>Источник</span>
                                            <span style={{ fontSize: 8, color: C.textMuted, width: 30, textAlign: 'right' }}>Нов.</span>
                                            <span style={{ fontSize: 8, color: C.textMuted, width: 28, textAlign: 'right' }}>Вишл.</span>
                                            <span style={{ fontSize: 8, color: C.textMuted, width: 26, textAlign: 'right' }}>Жел.</span>
                                          </div>
                                          {acq.sources.map(s => (
                                            <div key={s.key} style={{ display: 'flex', padding: '2px 0' }}>
                                              <span style={{ fontSize: 10, color: C.textSec, flex: 1 }}>{s.label}</span>
                                              <span style={{ fontSize: 10, fontWeight: 600, color: C.text, width: 30, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{s.newUsers}</span>
                                              <span style={{ fontSize: 10, color: C.textMuted, width: 28, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{s.withWishlist}</span>
                                              <span style={{ fontSize: 10, color: C.textMuted, width: 26, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{s.withWish}</span>
                                            </div>
                                          ))}
                                        </SectionCard>
                                      </CollapsibleBlock>
                                    )}
                                    {anyEventIncomplete && <div style={{ fontSize: 9, color: 'var(--wb-warning, #FBBF24)', background: 'rgba(251,191,36,0.06)', borderRadius: 8, padding: '4px 8px', marginTop: 4 }}>⚡ Часть событий: неполное покрытие периода</div>}
                                  </>
                                );
                              })()}

                              <SectionDivider />

                              {/* ═══════════════════════════════════════════
                                  C. SOCIAL LOOP — key growth hypothesis
                                  ═══════════════════════════════════════════ */}
                              <SectionTitle icon="🔗" label="Social loop" color="#34C759" badge={acqPeriod} />
                              {acq ? (() => {
                                const c = acq.current; const p = acq.previous;
                                const evCov = acq.eventCoverage;
                                const pDays = evCov?.periodDays ?? (acqPeriod === '24h' ? 1 : acqPeriod === '30d' ? 30 : 7);
                                const guestIncomplete = evCov ? evCov.guestEventsDays < pDays : false;
                                return (
                                  <>
                                    {/* Key numbers grid */}
                                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, marginBottom: 6 }}>
                                      {([
                                        ['Поделились', c.ownersShared, p.ownersShared, '#34C759'],
                                        ['Ссылок создано', c.shareLinksGenerated, p.shareLinksGenerated, null],
                                        ['Гостевые просмотры', c.guestOpens, p.guestOpens, '#5B8DEF'],
                                        ['Забронировали', c.reservers, p.reservers, '#FF9500'],
                                      ] as [string, number, number, string | null][]).map(([label, cur, prev, accent]) => {
                                        const d = safeDelta(cur, prev);
                                        return (
                                          <div key={label} style={{ background: C.surface, borderRadius: 10, padding: '6px 10px' }}>
                                            <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 2, lineHeight: 1 }}>{label}</div>
                                            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                                              <span style={{ fontSize: 16, fontWeight: 700, color: accent ?? C.text, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{cur}</span>
                                              <span style={{ fontSize: 9, color: d.color }}>{d.str}</span>
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                    {/* Всего броней */}
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '3px 10px', background: C.surface, borderRadius: 8, marginBottom: 6 }}>
                                      <span style={{ fontSize: 10, color: C.textMuted }}>Всего броней за период</span>
                                      <span style={{ fontSize: 12, fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{c.totalReservations}</span>
                                    </div>
                                    {/* Conversions */}
                                    <SectionCard>
                                      {acq.conversions.wishlistToShare != null && (
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0' }}>
                                          <span style={{ fontSize: 11, color: C.textSec }}>Вишлист → шеринг<DbBadge /></span>
                                          <ConvPct val={acq.conversions.wishlistToShare} />
                                        </div>
                                      )}
                                      {acq.conversions.shareToGuestOpen != null && (
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0' }}>
                                          <span style={{ fontSize: 11, color: C.textMuted }}>Ссылка → просмотр<PartialBadge /></span>
                                          <ConvPct val={acq.conversions.shareToGuestOpen} isPartial />
                                        </div>
                                      )}
                                      {acq.conversions.guestToReserve != null && (
                                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0' }}>
                                          <span style={{ fontSize: 11, color: C.textMuted }}>Просмотр → бронь<PartialBadge /></span>
                                          <ConvPct val={acq.conversions.guestToReserve} isPartial />
                                        </div>
                                      )}
                                      {guestIncomplete && <div style={{ fontSize: 8, color: 'var(--wb-warning, #FBBF24)', marginTop: 4 }}>⚡ Гостевые события — неполное покрытие</div>}
                                    </SectionCard>
                                  </>
                                );
                              })() : <div style={{ fontSize: 11, color: C.textMuted, padding: '4px 0' }}>Нет данных</div>}

                              <SectionDivider />

                              {/* ═══════════════════════════════════════════
                                  D. СЕГМЕНТЫ — market buckets (primary), import & bucket funnel (secondary)
                                  ═══════════════════════════════════════════ */}
                              <SectionTitle icon="🌍" label="Сегменты" color="#AF52DE" />
                              {godStats.marketBuckets && godStats.marketBuckets.length > 0 ? (() => {
                                const buckets = godStats.marketBuckets!;
                                const bucketTotal = buckets.reduce((s, b) => s + b.total, 0);
                                const maxBucket = Math.max(...buckets.map(b => b.total), 1);
                                const bucketColors: Record<string, string> = {
                                  ru: '#5B8DEF', en: '#34C759', ar: '#30D5C8', hi: '#FFB340',
                                  'zh-CN': '#FF6B6B', es: '#AF52DE', other_known: '#8E8E93', unknown: '#444',
                                };
                                return (
                                  <>
                                    <SectionCard>
                                      {buckets.map(b => {
                                        const share = bucketTotal > 0 ? (b.total / bucketTotal * 100) : 0;
                                        return (
                                          <div key={b.bucket} style={{ marginBottom: 3 }}>
                                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '2px 0' }}>
                                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
                                                <div style={{ width: 8, height: 8, borderRadius: 2, background: bucketColors[b.bucket] ?? '#8E8E93', flexShrink: 0 }} />
                                                <span style={{ fontSize: 11, color: C.text }}>{b.label}</span>
                                              </div>
                                              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                                <span style={{ fontSize: 11, fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums', width: 36, textAlign: 'right' }}>{b.total}</span>
                                                {b.new7d > 0 && <span style={{ fontSize: 9, color: C.green, fontVariantNumeric: 'tabular-nums', width: 24, textAlign: 'right' }}>+{b.new7d}</span>}
                                                {b.new7d <= 0 && <span style={{ width: 24 }} />}
                                                <span style={{ fontSize: 9, color: C.textMuted, fontVariantNumeric: 'tabular-nums', width: 26, textAlign: 'right' }}>{share.toFixed(0)}%</span>
                                              </div>
                                            </div>
                                            <div style={{ height: 2, borderRadius: 1, background: C.border, overflow: 'hidden', marginLeft: 14 }}>
                                              <div style={{ height: '100%', borderRadius: 1, width: `${(b.total / maxBucket) * 100}%`, background: bucketColors[b.bucket] ?? '#8E8E93', transition: 'width 0.3s ease' }} />
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </SectionCard>
                                    {/* Import split — secondary, compact */}
                                    {godStats.importSplit && (() => {
                                      const is = godStats.importSplit!;
                                      const total = is.supported.total + is.unsupported.total;
                                      return (
                                        <div style={{ display: 'flex', gap: 4, marginBottom: 6 }}>
                                          <div style={{ flex: 1, background: C.surface, borderRadius: 8, padding: '5px 8px' }}>
                                            <div style={{ fontSize: 8, color: C.textMuted, marginBottom: 1 }}>Импорт доступен</div>
                                            <div style={{ fontSize: 13, fontWeight: 700, color: '#34C759', fontVariantNumeric: 'tabular-nums' }}>{is.supported.total} <span style={{ fontSize: 9, fontWeight: 400, color: C.textMuted }}>{total > 0 ? `${(is.supported.total / total * 100).toFixed(0)}%` : ''}</span></div>
                                          </div>
                                          <div style={{ flex: 1, background: C.surface, borderRadius: 8, padding: '5px 8px' }}>
                                            <div style={{ fontSize: 8, color: C.textMuted, marginBottom: 1 }}>Недоступен</div>
                                            <div style={{ fontSize: 13, fontWeight: 700, color: C.textMuted, fontVariantNumeric: 'tabular-nums' }}>{is.unsupported.total}</div>
                                          </div>
                                        </div>
                                      );
                                    })()}
                                    {/* Bucket funnel — collapsible detail */}
                                    {godStats.bucketFunnel && godStats.bucketFunnel.length > 0 && (
                                      <CollapsibleBlock title="Конверсия по рынкам · 7д" open={godStatsDetailsOpen} onToggle={() => setGodStatsDetailsOpen((v: boolean) => !v)} color={C.textMuted}>
                                        <SectionCard style={{ marginTop: 4 }}>
                                          <div style={{ display: 'flex', padding: '0 0 3px', borderBottom: `1px solid ${C.border}`, gap: 2, marginBottom: 2 }}>
                                            <span style={{ fontSize: 8, color: C.textMuted, flex: 1 }}>Рынок</span>
                                            <span style={{ fontSize: 8, color: C.textMuted, width: 26, textAlign: 'right' }}>Нов.</span>
                                            <span style={{ fontSize: 8, color: C.textMuted, width: 26, textAlign: 'right' }}>Вишл.</span>
                                            <span style={{ fontSize: 8, color: C.textMuted, width: 26, textAlign: 'right' }}>Жел.</span>
                                            <span style={{ fontSize: 8, color: C.textMuted, width: 24, textAlign: 'right' }}>Онб.</span>
                                            <span style={{ fontSize: 8, color: C.textMuted, width: 20, textAlign: 'right' }}>Имп.</span>
                                          </div>
                                          {godStats.bucketFunnel!.map(b => (
                                            <div key={b.bucket} style={{ display: 'flex', padding: '2px 0', gap: 2, alignItems: 'center' }}>
                                              <span style={{ fontSize: 9, color: C.text, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{b.label}</span>
                                              <span style={{ fontSize: 9, fontWeight: 600, color: C.text, width: 26, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{b.newUsers}</span>
                                              <span style={{ fontSize: 9, color: C.textMuted, width: 26, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{b.firstWishlist}</span>
                                              <span style={{ fontSize: 9, color: C.textMuted, width: 26, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{b.firstItem}</span>
                                              <span style={{ fontSize: 9, color: C.textMuted, width: 24, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{b.onbStarted}</span>
                                              <span style={{ fontSize: 9, color: b.importFails > 0 ? '#FF6B6B' : C.textMuted, width: 20, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{b.importAttempts > 0 ? `${b.importAttempts}` : '—'}</span>
                                            </div>
                                          ))}
                                          {/* Quick conversion summary for markets with n>=5 */}
                                          <div style={{ marginTop: 4, fontSize: 9, color: C.textMuted, lineHeight: 1.6, display: 'flex', flexWrap: 'wrap', gap: '0 8px' }}>
                                            {godStats.bucketFunnel!.filter(b => b.newUsers >= 5).map(b => {
                                              const conv = b.newUsers > 0 ? b.firstWishlist / b.newUsers : 0;
                                              return (
                                                <span key={b.bucket}>
                                                  {b.label}: <span style={{ fontWeight: 700, color: conv >= 0.3 ? '#34C759' : conv >= 0.1 ? '#FFB340' : '#FF6B6B' }}>
                                                    {b.newUsers > 0 ? `${(conv * 100).toFixed(0)}%` : '—'}
                                                  </span>
                                                </span>
                                              );
                                            })}
                                          </div>
                                        </SectionCard>
                                      </CollapsibleBlock>
                                    )}
                                  </>
                                );
                              })() : <div style={{ fontSize: 11, color: C.textMuted }}>—</div>}

                              <SectionDivider />

                              {/* ═══════════════════════════════════════════
                                  D2. REFERRAL PROGRAM — лайфтайм + 24ч + 7д
                                  ═══════════════════════════════════════════ */}
                              {godStats.referral && (() => {
                                const r = godStats.referral;
                                const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;
                                // Colour the conv rate: high=green, mid=amber, low=red. Shows
                                // at-a-glance health without reading raw percentages.
                                const convColor = (v: number) => v >= 0.25 ? '#34C759' : v >= 0.1 ? '#FFB340' : '#FF6B6B';
                                return (
                                  <>
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
                                      <span style={{ fontSize: 11, fontWeight: 700, color: C.accent, letterSpacing: 0.3, textTransform: 'uppercase' }}>Рефералка</span>
                                      <span style={{
                                        fontSize: 9, padding: '1px 6px', borderRadius: 4, fontWeight: 700,
                                        background: r.enabled ? 'rgba(52,199,89,0.15)' : 'rgba(255,107,107,0.15)',
                                        color: r.enabled ? '#34C759' : '#FF6B6B',
                                      }}>{r.enabled ? `ON · ${r.rolloutPercent}%` : 'OFF'}</span>
                                      <span style={{ fontSize: 9, color: C.textMuted, marginLeft: 'auto' }}>
                                        +{r.rewardDays}д · cap {r.caps.monthly}/мес
                                      </span>
                                    </div>

                                    {/* Row 1: Лайфтайм totals — labels reserve fixed height so numbers
                                        line up even when one label wraps to 2 lines */}
                                    <SectionCard>
                                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
                                        {[
                                          { label: 'Всего\nпривлечений', value: r.lifetime.totalAttributions, color: C.text },
                                          { label: 'Засчитано', value: r.lifetime.rewardedCount, color: '#34C759' },
                                          { label: 'Выдано\nдней', value: r.lifetime.totalDaysGranted, color: C.accent },
                                          { label: 'В очереди\nфрод', value: r.fraudReviewQueue, color: r.fraudReviewQueue > 0 ? '#FFB340' : C.textMuted },
                                        ].map((cell, i) => (
                                          <div key={i} style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                                            <div style={{ fontSize: 9, color: C.textMuted, minHeight: 24, lineHeight: 1.2, whiteSpace: 'pre-line' }}>{cell.label}</div>
                                            <div style={{ fontSize: 15, fontWeight: 700, color: cell.color, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{cell.value}</div>
                                          </div>
                                        ))}
                                      </div>
                                    </SectionCard>

                                    {/* Row 2: rolling windows */}
                                    <SectionCard style={{ marginTop: 4 }}>
                                      <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 4 }}>За последние 24ч / 7д</div>
                                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
                                        {[
                                          { label: '24ч · attributions', value: r.rolling24h.attributions, color: C.text },
                                          { label: '24ч · rewarded', value: r.rolling24h.byStatus.REWARDED, color: '#34C759' },
                                          { label: '7д · attributions', value: r.rolling7d.attributions, color: C.text },
                                          { label: '7д · rewarded', value: r.rolling7d.rewardedCount, color: '#34C759' },
                                        ].map((cell, i) => (
                                          <div key={i} style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
                                            <div style={{ fontSize: 9, color: C.textMuted, minHeight: 12, lineHeight: 1.2 }}>{cell.label}</div>
                                            <div style={{ fontSize: 13, fontWeight: 600, color: cell.color, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{cell.value}</div>
                                          </div>
                                        ))}
                                      </div>
                                    </SectionCard>

                                    {/* Row 3: Status breakdown (lifetime) + conversions */}
                                    <SectionCard style={{ marginTop: 4 }}>
                                      <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 4 }}>Статусы · лайфтайм</div>
                                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
                                        {[
                                          { key: 'PENDING_ACTIVATION', label: 'Ожидают', color: '#FFB340' },
                                          { key: 'QUALIFIED', label: 'Квалиф.', color: C.accent },
                                          { key: 'REWARDED', label: 'Награда', color: '#34C759' },
                                          { key: 'REJECTED', label: 'Отклон.', color: '#FF6B6B' },
                                          { key: 'FRAUD_REVIEW', label: 'Фрод', color: '#FFB340' },
                                        ].map((s) => (
                                          <div key={s.key} style={{
                                            padding: '3px 8px', borderRadius: 6, fontSize: 9, fontWeight: 600,
                                            background: r.lifetime.byStatus[s.key]! > 0 ? `${s.color}22` : C.surface,
                                            color: r.lifetime.byStatus[s.key]! > 0 ? s.color : C.textMuted,
                                            fontVariantNumeric: 'tabular-nums',
                                          }}>
                                            {s.label} · <b>{r.lifetime.byStatus[s.key] ?? 0}</b>
                                          </div>
                                        ))}
                                      </div>
                                      <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 3 }}>Конверсии · лайфтайм</div>
                                      <div style={{ display: 'flex', gap: 10, fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
                                        <span>→ Квал. <b style={{ color: convColor(r.conversions.attributed_to_qualified) }}>{pct1(r.conversions.attributed_to_qualified)}</b></span>
                                        <span>→ Награда <b style={{ color: convColor(r.conversions.attributed_to_rewarded) }}>{pct1(r.conversions.attributed_to_rewarded)}</b></span>
                                        <span>Квал.→Нагр. <b style={{ color: convColor(r.conversions.qualified_to_rewarded) }}>{pct1(r.conversions.qualified_to_rewarded)}</b></span>
                                      </div>
                                    </SectionCard>

                                    {/* Row 4: Reject reasons (only if any) */}
                                    {Object.keys(r.rejectReasons).length > 0 && (
                                      <SectionCard style={{ marginTop: 4 }}>
                                        <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 4 }}>Причины отклонений · лайфтайм</div>
                                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                                          {(Object.entries(r.rejectReasons) as [string, number][])
                                            .sort((a, b) => b[1] - a[1])
                                            .map(([reason, count]) => (
                                              <span key={reason} style={{
                                                fontSize: 9, padding: '2px 7px', borderRadius: 5, fontWeight: 600,
                                                background: C.surface, color: C.textSec, fontVariantNumeric: 'tabular-nums',
                                              }}>
                                                {reason.replace('INVITEE_', '').replace('_', ' ').toLowerCase()} · <b style={{ color: C.text }}>{count}</b>
                                              </span>
                                            ))}
                                        </div>
                                      </SectionCard>
                                    )}

                                    {/* Row 5: Top inviters (only if any) */}
                                    {r.topInviters.length > 0 && (
                                      <SectionCard style={{ marginTop: 4 }}>
                                        <div style={{ fontSize: 9, color: C.textMuted, marginBottom: 4 }}>Топ-инвайтеры · по наградам</div>
                                        {r.topInviters.map((ti, idx) => (
                                          <div key={ti.userId} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', fontSize: 10 }}>
                                            <span style={{ width: 14, color: C.textMuted, fontVariantNumeric: 'tabular-nums' }}>{idx + 1}.</span>
                                            <span style={{ flex: 1, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                              {ti.name ?? (ti.telegramId ? `tg:${ti.telegramId}` : ti.userId.slice(0, 8))}
                                            </span>
                                            <span style={{ color: '#34C759', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>+{ti.rewardedCount}</span>
                                          </div>
                                        ))}
                                      </SectionCard>
                                    )}

                                    <SectionDivider />
                                  </>
                                );
                              })()}

                              {/* ═══════════════════════════════════════════
                                  E. RETENTION / WIN-BACK / DEBUG — collapsed by default
                                  ═══════════════════════════════════════════ */}
                              <CollapsibleBlock
                                title="Retention & Win-back"
                                color="var(--wb-success, #4ADE80)"
                                open={retentionOpen}
                                onToggle={async () => {
                                  if (retentionOpen) { setRetentionOpen(false); return; }
                                  setRetentionOpen(true);
                                  await loadRetention(retentionPeriod);
                                }}
                              >
                                {retentionLoading && !retentionStats && (
                                  <div style={{ fontSize: 11, color: C.textMuted, padding: '8px 0' }}>Загрузка…</div>
                                )}
                                {retentionStats && (() => {
                                  const rv = retentionStats;
                                  const ov = rv.overview;
                                  const dbg = rv.debug;
                                  const segNames: Record<string, string> = { S1: 'S1 · Нет вишлиста', S2: 'S2 · Нет желаний', S3: 'S3 · Нет шеринга', S4: 'S4 · Давно неактивен' };
                                  return (
                                    <div style={{ marginTop: 4 }}>
                                      {/* Period selector */}
                                      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
                                        {[7, 30, 90].map(d => (
                                          <button key={d} onClick={() => { setRetentionPeriod(d); void loadRetention(d); }} style={{
                                            fontSize: 11, padding: '4px 10px', borderRadius: 8, border: 'none', cursor: 'pointer',
                                            background: retentionPeriod === d ? 'var(--wb-success, #4ADE80)' : C.surface,
                                            color: retentionPeriod === d ? '#000' : C.textMuted, fontWeight: 600, fontFamily: font,
                                          }}>{d} дн.</button>
                                        ))}
                                      </div>
                                      {/* Overview KPIs */}
                                      <SectionCard>
                                        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0 12px' }}>
                                          <KpiRow label="Отправлено" value={ov.sent} />
                                          <KpiRow label="Доставлено" value={ov.delivered} />
                                          <KpiRow label="Возврат 72ч" value={ov.returned72h} color="var(--wb-warning, #FBBF24)" hint={ov.returnRate72h} />
                                          <KpiRow label="Цел. шаг 7д" value={ov.targetCompleted7d} color="var(--wb-accent, #8B7BFF)" hint={ov.targetRate7d ?? '—'} />
                                          <KpiRow label="Промо активировано" value={ov.promoRedeemed} color="var(--wb-success, #4ADE80)" />
                                          <KpiRow label="PRO-доступов" value={ov.activeGrants} color="var(--wb-success, #4ADE80)" />
                                        </div>
                                      </SectionCard>
                                      {/* Segments */}
                                      {rv.bySegment.filter(s => s.sent > 0).map(s => (
                                        <SectionCard key={s.segment} style={{ marginBottom: 4 }}>
                                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 3 }}>
                                            <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--wb-success, #4ADE80)' }}>{segNames[s.segment] || s.segment}</span>
                                            <span style={{ fontSize: 9, color: C.textMuted }}>{s.targetAction || '—'}</span>
                                          </div>
                                          {s.promoPolicy && <KpiRow label="Промо" value={s.promoPolicy} color="var(--wb-accent, #8B7BFF)" />}
                                          <div style={{ display: 'flex', gap: 10 }}>
                                            <div style={{ flex: 1 }}>
                                              <KpiRow label="Отпр." value={s.sent} />
                                              <KpiRow label="Возвр. 72ч" value={s.returned72h} color="var(--wb-warning, #FBBF24)" hint={s.returnRate72h} />
                                            </div>
                                            <div style={{ flex: 1 }}>
                                              <KpiRow label="Дост." value={s.delivered} />
                                              <KpiRow label="Цел. 7д" value={s.targetCompleted7d} color="var(--wb-accent, #8B7BFF)" hint={s.targetRate7d ?? '—'} />
                                            </div>
                                          </div>
                                          {(s.promoDelivered > 0 || s.promoRedeemed > 0) && (
                                            <div style={{ marginTop: 3, paddingTop: 3, borderTop: `1px solid ${C.border}` }}>
                                              <KpiRow label="Промо дост." value={s.promoDelivered} />
                                              <KpiRow label="Промо → цел." value={s.promoTargetCompleted ?? 0} color="var(--wb-accent, #8B7BFF)" hint={s.promoTargetRate ?? '—'} />
                                              <KpiRow label="Промо актив." value={s.promoRedeemed} color="var(--wb-success, #4ADE80)" />
                                              {s.nonPromoTargetCompleted != null && <KpiRow label="Без промо → цел." value={s.nonPromoTargetCompleted} color={C.textMuted} hint={s.nonPromoTargetRate ?? '—'} />}
                                            </div>
                                          )}
                                        </SectionCard>
                                      ))}
                                      {/* By-touch waves — debug-level detail, already inside collapsed Retention */}
                                      {rv.byTouch.length > 0 && (
                                        <div style={{ padding: '4px 8px', background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: `1px dashed ${C.border}`, marginBottom: 4, marginTop: 4 }}>
                                          <div style={{ fontSize: 9, color: C.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>По волнам</div>
                                          {rv.byTouch.map(t => (
                                            <div key={`${t.segment}-${t.touchNumber}`} style={{ display: 'flex', justifyContent: 'space-between', padding: '2px 0', ...(t.disabled ? { opacity: 0.4 } : {}) }}>
                                              <span style={{ fontSize: 10, color: C.textSec }}>{t.segment} · В{t.touchNumber}{t.disabled ? ' 🚫' : ''}</span>
                                              <span style={{ fontSize: 10, color: C.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                                                {t.sent}→{t.delivered} · <span style={{ color: 'var(--wb-warning, #FBBF24)' }}>{t.returnRate72h}</span> · <span style={{ color: 'var(--wb-accent, #8B7BFF)' }}>{t.targetRate7d}</span>
                                              </span>
                                            </div>
                                          ))}
                                        </div>
                                      )}
                                      {/* Debug footer */}
                                      {dbg && (
                                        <div style={{ padding: '3px 8px', background: 'rgba(255,255,255,0.02)', borderRadius: 6, border: `1px dashed ${C.border}` }}>
                                          <div style={{ fontSize: 9, color: '#555' }}>
                                            🔍 Touches: {dbg.totalTouchesInPeriod} · Excl.: {dbg.excludedTestUsers}
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })()}
                              </CollapsibleBlock>

                              {/* ── Timestamp ── */}
                              <div style={{ fontSize: 9, color: C.textMuted, textAlign: 'right', marginTop: 8, paddingTop: 6, borderTop: `1px solid ${C.border}` }}>
                                {godStatsRefreshedAt
                                  ? <>↻ {relativeTime(godStatsRefreshedAt)} · {godStatsRefreshedAt.toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}</>
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
    </>
  );
}
