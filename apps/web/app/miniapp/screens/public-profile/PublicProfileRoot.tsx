// PublicProfileRoot — F4 Wave A++ cluster file (REFACTOR_MINIAPP_TSX_PLAN).
//
// Bundles the single public-profile screen (~379 LOC of JSX) into a
// lazy-loaded module. Loaded via `next/dynamic({ ssr: false })` from
// `apps/web/app/miniapp/MiniApp.tsx`, so the chunk doesn't ship with
// the initial Mini App page bundle — public-profile code only downloads
// when a visitor lands on a `profile_{username}` deep-link (cold path:
// not first-paint, only relevant for friend-discovery flows).
//
// State strategy: NO dedicated state hook. publicProfile* state lives
// in MiniAppInner alongside guest-view / birthday-context / showcase
// state that is read by SHARED helpers (subscribeToProfile,
// unsubscribeFromProfile, loadGuestWishlist). Extracting to a hook
// would split state from helpers — keep state inline and forward via
// ctx, same trade-off as ProfileRoot.
//
// Implementation discipline:
// - JSX is copied verbatim from MiniApp.tsx — DO NOT migrate styles or
//   refactor logic in this PR. Bundle savings only; cosmetic changes
//   ride future on-touch PRs.
// - `ctx` is typed as `Record<string, any>` for now; a tighter
//   PublicProfileRootCtx type is deferred to a follow-up alongside the
//   ProfileRoot/SantaRoot tightening pass.
// - The birthday context Banner + birthday-attributed analytics events
//   are forwarded (setBirthdayContext, trackBirthdayAttributedEvent)
//   so this screen still records `birthday.banner_seen` /
//   `public_profile.viewed` / `public_profile.wishlist_opened`.

'use client';

import React from 'react';
import { Banner, Card, Chip } from '@wishlist/ui';
import { t, type Locale } from '@wishlist/shared';
import type { PublicProfileState } from '../../hooks/usePublicProfileState';

/* eslint-disable @typescript-eslint/no-explicit-any */
export type PublicProfileRootCtx = PublicProfileState & {
  // module-level constants forwarded from MiniApp.tsx
  C: Record<string, string>;
  font: string;
  locale: Locale;
  DONT_GIFT_PRESET_EMOJIS: Record<string, string>;
  // helpers + setters from MiniAppInner closure
  setScreen: any;
  subscribeToProfile: (username: string) => Promise<void> | void;
  unsubscribeFromProfile: (username: string) => Promise<void> | void;
  // shared misc state read by this screen
  profileData: any;
  birthdayContext: any;
  setBirthdayContext: any;
  trackBirthdayAttributedEvent: (event: string, props?: Record<string, unknown>) => void;
  setGuestViewReturnToProfileUsername: any;
  loadGuestWishlist: (slug: string) => Promise<any>;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface PublicProfileRootProps {
  /** Active screen name; passed for symmetry with sibling Root components. */
  screen: string;
  /** Bag of closure refs forwarded from MiniAppInner. See `PublicProfileRootCtx`. */
  ctx: PublicProfileRootCtx;
}

/**
 * Lazy-loaded PublicProfile cluster root.
 *
 * Destructures everything the JSX needs from `ctx` at the top, then
 * returns the inline screen block guarded by `screen === 'public-profile'`
 * exactly as in the original MiniApp.tsx — keeps the JSX byte-identical.
 */
export function PublicProfileRoot(props: PublicProfileRootProps) {
  const { ctx, screen } = props;

  // ── Module-level constants forwarded from MiniApp.tsx ────────────────
  const { C, font, locale, DONT_GIFT_PRESET_EMOJIS } = ctx;

  // ── Helpers + state from MiniAppInner closure ────────────────────────
  const {
    setScreen,
    publicProfileData, publicProfileLoading, publicProfileError,
    publicProfileUsername, publicProfileSubscribed, publicProfileSubInFlight,
    subscribeToProfile, unsubscribeFromProfile,
    profileData, birthdayContext, setBirthdayContext,
    trackBirthdayAttributedEvent,
    setGuestViewReturnToProfileUsername, loadGuestWishlist,
  } = ctx;

  if (screen !== 'public-profile') return null;

  const pp = publicProfileData;
  const isOwn = pp?.profile?.username && profileData?.username && pp.profile.username.toLowerCase() === profileData.username.toLowerCase();
  return (
    <div style={{ fontFamily: font, color: C.text, animation: 'fadeIn 0.3s ease' }}>
      {publicProfileLoading && (
        <div style={{ padding: '80px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
          <div style={{ color: C.textMuted, fontSize: 14 }}>{t('loading', locale)}</div>
        </div>
      )}

      {publicProfileError === 'not_found' && (
        <div style={{ padding: '80px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🔒</div>
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>{t('public_profile_not_found', locale)}</div>
          <div style={{ fontSize: 14, color: C.textMuted, lineHeight: 1.5 }}>{t('public_profile_not_found_hint', locale)}</div>
        </div>
      )}

      {publicProfileError === 'error' && (
        <div style={{ padding: '80px 24px', textAlign: 'center' }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>😔</div>
          <div style={{ fontSize: 16, fontWeight: 600, color: C.textMuted }}>{t('error_generic', locale)}</div>
        </div>
      )}

      {pp && !publicProfileLoading && !publicProfileError && (() => {
        // Birthday context banner — friend reminder where there's no public
        // wishlist. Shown above the profile content. Doesn't promise that
        // a wishlist will appear later; just suggests subscribing.
        const showBirthdayBanner = !!birthdayContext && !birthdayContext.isOwner && !birthdayContext.bannerDismissed;
        const showcase = pp.showcase;
        const hasShowcase = !!showcase;
        const pinnedIds = new Set<string>(showcase?.pinned.map((p: { id: string }) => p.id) ?? []);
        const nonPinnedWishlists = pp.wishlists.filter((wl: { id: string }) => !pinnedIds.has(wl.id));
        const sizes = showcase?.sizes;
        const hasGarmentSizes = !!sizes && (!!sizes.clothing || !!sizes.shoes || !!sizes.ring || !!sizes.other);
        const hasMeasurements = !!sizes && (!!sizes.chest || !!sizes.waist || !!sizes.hips);
        const hasSizes = hasGarmentSizes || hasMeasurements;
        const scSectionStyle: React.CSSProperties = { padding: '0 20px', marginBottom: 20 };
        const scSectionTitleStyle: React.CSSProperties = {
          fontSize: 13, fontWeight: 600, textTransform: 'uppercase',
          letterSpacing: '0.06em', color: C.textMuted, marginBottom: 12,
        };
        return (
        <div style={{ padding: 0 }}>
          {showBirthdayBanner && birthdayContext && (() => {
            const bctx = birthdayContext;
            const days = bctx.daysUntil ?? 0;
            const isToday = days === 0 || bctx.reminderKind === 'friend_today';
            const name = bctx.birthdayUser.displayName || bctx.birthdayUser.username || 'WishBoard';
            return (
              <div
                style={{ padding: '12px 16px 0' }}
                ref={(el) => {
                  if (el && !el.dataset.seen) {
                    el.dataset.seen = '1';
                    trackBirthdayAttributedEvent('birthday.banner_seen', { kind: bctx.reminderKind, target: 'profile' });
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
                    setBirthdayContext((prev: any) => prev ? { ...prev, bannerDismissed: true } : prev);
                    trackBirthdayAttributedEvent('birthday.banner_dismissed', { kind: bctx.reminderKind });
                  }}
                >
                  {pp.wishlists.length === 0
                    ? t('br_banner_friend_no_wishlist', locale, { name })
                    : (isToday
                        ? t('br_banner_friend_today_desc', locale, { name })
                        : t('br_banner_friend_desc', locale))}
                </Banner>
              </div>
            );
          })()}
          {/* ── v2.1 Hero: cover (when set) + layered accent gradient fallback + 88px avatar ── */}
          <div style={{ position: 'relative' }}>
            {hasShowcase && showcase?.coverUrl ? (
              <div style={{
                position: 'relative', width: '100%', height: 220,
                backgroundImage: `url(${showcase.coverUrl})`,
                backgroundSize: 'cover', backgroundPosition: 'center',
              }}>
                <div style={{
                  position: 'absolute', inset: 0,
                  background: 'linear-gradient(180deg, rgba(15,15,18,0.18) 0%, rgba(15,15,18,0.72) 70%, var(--wb-bg) 100%)',
                }} />
              </div>
            ) : (
              <div style={{
                position: 'relative', width: '100%', height: 200,
                background:
                  'radial-gradient(circle at 50% 120%, var(--wb-accent-deep), transparent 60%),' +
                  'radial-gradient(circle at 100% 0%, var(--wb-accent-strong), transparent 50%),' +
                  'linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01)),' +
                  'var(--wb-card-strong)',
                boxShadow: '0 20px 50px -20px var(--wb-accent-shadow), inset 0 1px 0 rgba(255,255,255,0.08)',
              }}>
                <div style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 80, background: 'linear-gradient(to top, var(--wb-bg) 0%, transparent 100%)' }} />
              </div>
            )}
            <div style={{ padding: '0 20px', marginTop: -52, position: 'relative', zIndex: 2 }}>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 14 }}>
                <div style={{
                  width: 88, height: 88, borderRadius: '50%', overflow: 'hidden',
                  background: 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  border: '3px solid var(--wb-bg)', flexShrink: 0,
                  boxShadow: '0 12px 32px var(--wb-accent-shadow), inset 0 2px 0 rgba(255,255,255,0.25)',
                  color: '#fff',
                }}>
                  {pp.profile.avatarUrl
                    ? <img src={pp.profile.avatarUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <span style={{ fontSize: 36, fontWeight: 700, letterSpacing: '-0.02em' }}>
                        {(pp.profile.displayName || pp.profile.username || '?')[0]!.toUpperCase()}
                      </span>}
                </div>
                <div style={{ paddingBottom: 4, minWidth: 0 }}>
                  <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: '-0.025em', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{pp.profile.displayName || pp.profile.username || publicProfileUsername}</span>
                    {hasShowcase && <Chip tone="pro" size="sm">PRO</Chip>}
                  </div>
                  {pp.profile.username && <div style={{ fontSize: 13.5, color: 'var(--wb-text-secondary)', marginTop: 2, fontFeatureSettings: '"tnum"' }}>@{pp.profile.username}</div>}
                </div>
              </div>
              {(showcase?.bio || pp.profile.bio) && (
                <div style={{ fontSize: 14, color: 'var(--wb-text-secondary)', marginTop: 12, lineHeight: 1.5, letterSpacing: '-0.005em' }}>
                  {showcase?.bio || pp.profile.bio}
                </div>
              )}
              {!isOwn && hasShowcase && pp.profile.username && (
                <button
                  onClick={() => {
                    const uname = pp.profile.username!;
                    if (publicProfileSubscribed) void unsubscribeFromProfile(uname);
                    else void subscribeToProfile(uname);
                  }}
                  disabled={publicProfileSubInFlight}
                  style={{
                    marginTop: 14,
                    width: '100%',
                    padding: '13px 16px',
                    borderRadius: 16,
                    border: publicProfileSubscribed ? '1px solid var(--wb-border)' : '1px solid var(--wb-accent-soft-strong)',
                    background: publicProfileSubscribed
                      ? 'var(--wb-card)'
                      : 'linear-gradient(135deg, var(--wb-accent), var(--wb-accent-deep))',
                    color: publicProfileSubscribed ? 'var(--wb-success)' : '#fff',
                    fontSize: 14,
                    fontWeight: 650,
                    letterSpacing: '-0.012em',
                    fontFamily: font,
                    cursor: publicProfileSubInFlight ? 'default' : 'pointer',
                    opacity: publicProfileSubInFlight ? 0.6 : 1,
                    transition: 'all 0.18s cubic-bezier(0.4, 0, 0.2, 1)',
                    WebkitBackdropFilter: publicProfileSubscribed ? 'blur(14px)' as never : undefined,
                    backdropFilter: publicProfileSubscribed ? 'blur(14px)' as never : undefined,
                    boxShadow: publicProfileSubscribed
                      ? undefined
                      : '0 12px 32px var(--wb-accent-shadow), inset 0 1px 0 rgba(255,255,255,0.22)',
                  }}
                >
                  {publicProfileSubscribed
                    ? t('public_profile_subscribed', locale)
                    : t('public_profile_subscribe', locale)}
                </button>
              )}
              {isOwn && (
                <div style={{ marginTop: 12 }}>
                  <Chip tone="accent" size="lg">{t('public_profile_this_is_you', locale)}</Chip>
                </div>
              )}
            </div>
          </div>

          <div style={{ height: 24 }} />

          {/* ── Pinned wishlists ── */}
          {hasShowcase && showcase && showcase.pinned.length > 0 && (
            <div style={scSectionStyle}>
              <div style={scSectionTitleStyle}>📌 {t('showcase_public_featured_title', locale)}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {showcase.pinned.map((wl: { id: string; slug: string; title: string; itemCount: number; reservedCount: number }) => (
                  <div key={wl.id}
                    onClick={() => {
                      trackBirthdayAttributedEvent('public_profile.wishlist_opened', { source: 'pinned' });
                      setGuestViewReturnToProfileUsername(pp.profile.username ?? null);
                      void loadGuestWishlist(wl.slug).then(() => { setScreen('guest-view'); window.scrollTo(0, 0); }).catch(() => {});
                    }}
                    style={{
                      background: C.surface, borderRadius: 12, padding: '14px 16px',
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                      border: `1px solid ${C.border}`, cursor: 'pointer',
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
                        <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                          {wl.itemCount} {t('wishes_count_short', locale)}
                          {wl.reservedCount > 0 ? ` · ${wl.reservedCount} ${t('reserved_count_short', locale)}` : ''}
                        </div>
                      </div>
                    </div>
                    <span style={{ color: C.textMuted, fontSize: 18, flexShrink: 0, marginLeft: 8 }}>›</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── Preferences ── */}
          {hasShowcase && showcase?.preferences && (
            <div style={scSectionStyle}>
              <div style={scSectionTitleStyle}>💡 {t('showcase_public_preferences_title', locale)}</div>
              <Card variant="default" style={{ fontSize: 14, color: C.textSec, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>
                {showcase.preferences}
              </Card>
            </div>
          )}

          {/* ── Sizes ── */}
          {hasShowcase && hasSizes && sizes && (
            <div style={scSectionStyle}>
              <div style={scSectionTitleStyle}>📏 {t('showcase_public_sizes_title', locale)}</div>
              {hasGarmentSizes && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {([
                    ['clothing', sizes.clothing],
                    ['shoes', sizes.shoes],
                    ['ring', sizes.ring],
                    ['other', sizes.other],
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
                      ['chest', sizes.chest],
                      ['waist', sizes.waist],
                      ['hips', sizes.hips],
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
          {hasShowcase && showcase && showcase.brands.length > 0 && (
            <div style={scSectionStyle}>
              <div style={scSectionTitleStyle}>✨ {t('showcase_public_brands_title', locale)}</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {showcase.brands.map((b: string, i: number) => (
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

          {/* ── Anti-gifts ── */}
          {hasShowcase && showcase?.antiGift && (
            <div style={scSectionStyle}>
              <div style={scSectionTitleStyle}>🚫 {t('showcase_public_antigift_title', locale)}</div>
              {(showcase.antiGift.presets.length > 0 || showcase.antiGift.customItems.length > 0) && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {showcase.antiGift.presets.map((key: string) => (
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
                  {showcase.antiGift.customItems.map((item: string, i: number) => (
                    <span key={`c-${i}`} style={{
                      display: 'inline-flex', alignItems: 'center',
                      padding: '6px 12px', borderRadius: 20, fontSize: 13,
                      background: 'rgba(251, 113, 133, 0.12)', color: C.red,
                      border: '1px solid rgba(251, 113, 133, 0.15)',
                    }}>{item}</span>
                  ))}
                </div>
              )}
              {showcase.antiGift.comment && (
                <div style={{
                  fontSize: 13, color: C.textSec, lineHeight: 1.45,
                  marginTop: 10, padding: '10px 14px',
                  background: C.surface, borderRadius: 10,
                  borderLeft: `3px solid ${C.red}`,
                  whiteSpace: 'pre-wrap',
                }}>{showcase.antiGift.comment}</div>
              )}
            </div>
          )}

          {/* ── Other (non-pinned) wishlists ── */}
          {nonPinnedWishlists.length === 0 && (!hasShowcase || (showcase?.pinned?.length ?? 0) === 0) ? (
            <div style={{ padding: '0 20px 20px' }}>
              <div style={{ padding: '32px 16px', textAlign: 'center', background: C.surface, borderRadius: 14 }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📭</div>
                <div style={{ fontSize: 14, color: C.textMuted }}>{t('public_profile_no_wishlists', locale)}</div>
              </div>
            </div>
          ) : nonPinnedWishlists.length > 0 ? (
            <div style={scSectionStyle}>
              <div style={scSectionTitleStyle}>
                {hasShowcase && showcase && showcase.pinned.length > 0
                  ? t('showcase_public_other_title', locale)
                  : t('public_profile_wishlists_title', locale)}
              </div>
              <div style={{ background: C.card, borderRadius: 12, padding: '4px 16px', border: `1px solid ${C.border}` }}>
                {nonPinnedWishlists.map((wl: { id: string; slug: string; title: string; itemCount: number; reservedCount: number }, i: number) => (
                  <div key={wl.id}
                    onClick={() => {
                      trackBirthdayAttributedEvent('public_profile.wishlist_opened', { source: 'list' });
                      setGuestViewReturnToProfileUsername(pp.profile.username ?? null);
                      void loadGuestWishlist(wl.slug).then(() => { setScreen('guest-view'); window.scrollTo(0, 0); }).catch(() => {});
                    }}
                    style={{
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                      padding: '12px 0', cursor: 'pointer',
                      borderBottom: i < nonPinnedWishlists.length - 1 ? `1px solid ${C.border}` : 'none',
                    }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{wl.title}</div>
                      <div style={{ fontSize: 12, color: C.textMuted, marginTop: 2 }}>
                        {wl.itemCount} {t('wishes_count_short', locale)}
                        {wl.reservedCount > 0 ? ` · ${wl.reservedCount} ${t('reserved_count_short', locale)}` : ''}
                      </div>
                    </div>
                    <span style={{ color: C.textMuted, fontSize: 16, marginLeft: 8 }}>›</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div style={{ height: 20 }} />
        </div>
        );
      })()}
    </div>
  );
}
