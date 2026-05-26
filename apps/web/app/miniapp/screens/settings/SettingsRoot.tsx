// SettingsRoot — F4 Wave D-1 cluster file (REFACTOR_MINIAPP_TSX_PLAN).
//
// Bundles the single Settings screen (~746 LOC of JSX) into a lazy-loaded
// module. Loaded via `next/dynamic({ ssr: false })` from
// `apps/web/app/miniapp/MiniApp.tsx`, so the chunk doesn't ship with the
// initial Mini App page bundle — settings code only downloads when a user
// taps the gear icon (cold-ish path: not first-paint, but visited often).
//
// State source: settings touches state owned by MANY clusters
// (profile, birthday-reminders, gift-notes access, link mgmt, planInfo,
// theme, etc.). Rather than create a `useSettingsState` hook that wraps
// `useState<{ cardDisplayMode }>` — too thin — we forward existing state
// via `ctx`. The screen is a consumer, not an owner. (`cardDisplayMode`
// is the only meaningful piece of state owned by Settings itself, and it
// stays in MiniAppInner because it's also read by the appearance-aware
// card rendering on `my-wishlists`.)
//
// Implementation discipline:
// - JSX is copied verbatim from MiniApp.tsx — DO NOT migrate styles or
//   refactor logic in this PR. Bundle savings only; cosmetic changes
//   ride future on-touch PRs.
// - `ctx` is typed loosely (helpers / state setters as `any`) — same
//   trade-off as SantaRoot/GiftNotesRoot. Tightening is a follow-up.
// - The 4 inline primitives (`SettingsSection/Row/Toggle/ActionRow`)
//   are recreated INSIDE the screen IIFE here to preserve byte-identical
//   behaviour (they wrap the DS primitives with santa-tint + locale-aware
//   "coming soon" + proBadge boolean→ReactNode bridges).

'use client';

import React from 'react';
import {
  SettingsActionRow as DSSettingsActionRow,
  SettingsRow as DSSettingsRow,
  SettingsSection as DSSettingsSection,
  SettingsToggle as DSSettingsToggle,
  SettingsDivider,
} from '@wishlist/ui';
import { t, pluralize, localeToBCP47, type Locale } from '@wishlist/shared';
import { ProBadge } from '../../components/ProBadge';
import { UserAvatar } from '../../components/UserAvatar';
import { resolveOwnerName } from '../../lib/wishlist-utils';
import type { ComponentType, Dispatch, SetStateAction } from 'react';
import type { PlanInfo, TgUser } from '../../MiniApp';
import type {
  LegacyColorBag, PushToast, SetScreen, SetUpsellSheet,
  ShowUpsell, TgFetch, TrackEvent,
} from '../../_shared/closure-types';

/**
 * SettingsRootCtx — closure refs forwarded from MiniAppInner.
 *
 * The Settings screen reads many disparate pieces of state owned by sibling
 * features (profile, birthday, link mgmt, etc.). Rather than create a
 * settings-specific state hook that would just re-forward the same names,
 * we pass them straight through. Helpers now carry real signatures from
 * `_shared/closure-types`; state shapes that are inline-anonymous in
 * MiniApp.tsx (profileData / birthdaySettings / settingsData / etc.)
 * stay loose with `any` — pinning them would require extracting those
 * anonymous useState types into named exports, which is its own refactor.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type SettingsRootCtx = {
  // module-level constants forwarded from MiniApp.tsx
  C: LegacyColorBag;
  font: string;
  locale: Locale;
  CARD_REDESIGN_ENABLED: boolean;
  LATEST_RELEASE_ID: string | null;
  // hot-path helpers — real signatures from _shared/closure-types.
  tgFetch: TgFetch;
  setScreen: SetScreen;
  pushToast: PushToast;
  showUpsell: ShowUpsell;
  setUpsellSheet: SetUpsellSheet;
  trackEvent: TrackEvent;
  normalizeLocale: typeof import('@wishlist/shared').normalizeLocale;
  // resolveOwnerName imported directly inside this file (F5) — no longer a ctx field.
  // misc state read by Settings
  scrollContainerRef: { current: HTMLDivElement | null };
  tgUser: TgUser | null;
  tgRef: { current: Window['Telegram'] };
  tgLangCodeRef: { current: string | undefined };
  // Anonymous inline-useState shapes in MiniApp.tsx — kept as `any`
  // pending a future extraction of these state cells into named types.
  profileData: any;
  settingsData: any;
  settingsLoading: boolean;
  godMode: boolean;
  showLocaleDebug: boolean;
  santaSeason: any;
  hasNewInSettings: boolean;
  linkMgmtData: any;
  dontGiftData: any;
  planInfo: PlanInfo;
  cardDisplayMode: string;
  setCardDisplayMode: Dispatch<SetStateAction<string>>;
  birthdaySettings: any;
  birthdaySettingsLoading: boolean;
  setBirthdaySettings: Dispatch<SetStateAction<any>>;
  setBirthdaySettingsLoading: Dispatch<SetStateAction<boolean>>;
  setBirthdayMutedList: Dispatch<SetStateAction<any>>;
  setChangelogSeenId: Dispatch<SetStateAction<string>>;
  setLegalDocId: Dispatch<SetStateAction<string | null>>;
  setShowCommentsDefaultSheet: Dispatch<SetStateAction<boolean>>;
  setShowDeleteAccount: Dispatch<SetStateAction<boolean>>;
  setShowLanguageSheet: Dispatch<SetStateAction<boolean>>;
  setShowProfileVisibilitySheet: Dispatch<SetStateAction<boolean>>;
  setShowReportProblemSheet: Dispatch<SetStateAction<boolean>>;
  setShowSubscribePolicySheet: Dispatch<SetStateAction<boolean>>;
  // settings-domain helpers (defined in MiniAppInner — useCallback)
  patchSettings: (patch: Record<string, unknown>) => Promise<void>;
  loadActiveLinks: () => Promise<void>;
  openDontGiftEdit: () => Promise<void>;
  // F1-lazy screen helper consumed inside Appearance block. The
  // dynamic() wrapper in MiniApp.tsx erases the inner prop shape, so a
  // ComponentType<any> matches what the consumer site can statically
  // observe.
  AppearanceSettings: ComponentType<any>;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export interface SettingsRootProps {
  /** Active screen name; passed for symmetry with sibling Root components. */
  screen: string;
  /** Bag of closure refs forwarded from MiniAppInner. See `SettingsRootCtx`. */
  ctx: SettingsRootCtx;
}

/**
 * Lazy-loaded Settings cluster root.
 *
 * Destructures everything the JSX needs from `ctx` at the top, then returns
 * the inline screen block guarded by `screen === 'settings'` — exactly as
 * in the original MiniApp.tsx so the JSX is byte-identical.
 */
export function SettingsRoot(props: SettingsRootProps) {
  const { ctx, screen } = props;

  // ── Module-level constants forwarded from MiniApp.tsx ────────────────
  const { C, font, locale, CARD_REDESIGN_ENABLED, LATEST_RELEASE_ID } = ctx;

  // ── Hot-path helpers + setters ───────────────────────────────────────
  const {
    tgFetch, setScreen, pushToast, showUpsell, setUpsellSheet, trackEvent,
    normalizeLocale,
    scrollContainerRef, tgUser, tgRef, tgLangCodeRef,
    profileData, settingsData, settingsLoading,
    godMode, showLocaleDebug, santaSeason, hasNewInSettings,
    linkMgmtData, dontGiftData, planInfo,
    cardDisplayMode, setCardDisplayMode,
    birthdaySettings, birthdaySettingsLoading,
    setBirthdaySettings, setBirthdaySettingsLoading,
    setBirthdayMutedList,
    setChangelogSeenId, setLegalDocId,
    setShowCommentsDefaultSheet, setShowDeleteAccount, setShowLanguageSheet,
    setShowProfileVisibilitySheet, setShowReportProblemSheet, setShowSubscribePolicySheet,
    patchSettings, loadActiveLinks, openDontGiftEdit,
    AppearanceSettings,
  } = ctx;

  return (
    <>
      {/* ══════════════════════════════════════════════
          SETTINGS
          ══════════════════════════════════════════════ */}
      {screen === 'settings' && (() => {
        // ── Settings primitives ─────────────────────────────────────────────
        // The local `SettingsSection/Row/Toggle/ActionRow` closures were
        // extracted to `@wishlist/ui` (`SettingsList.tsx`). The legacy
        // call-sites in this screen pass `proBadge: boolean` / `newBadge: boolean`
        // — but the canonical primitives expect `ReactNode`. The bridge
        // closures below translate the boolean API → ReactNode + thread
        // santa-tint + localize the "coming soon" label, keeping JSX unchanged.
        const SDivider = SettingsDivider;
        const settingsNewBadgeNode = (
          <span style={{
            fontSize: 9, fontWeight: 700, color: '#fff',
            background: 'linear-gradient(135deg, var(--wb-success), #10B981)',
            padding: '2px 6px', borderRadius: 4,
            textTransform: 'uppercase' as const, letterSpacing: 0.5,
          }}>NEW</span>
        );
        const SettingsSection = ({ title, children, first }: { title: string; children: React.ReactNode; first?: boolean }) => (
          <DSSettingsSection title={title} first={first} santaTint={!!santaSeason?.inSeason}>
            {children}
          </DSSettingsSection>
        );
        const SettingsRow = ({ icon, label, value, hint, onClick, proBadge, disabled, valueSmall, newBadge }: {
          icon?: string; label: string; value?: string; hint?: string; onClick?: () => void; proBadge?: boolean; disabled?: boolean; valueSmall?: boolean; newBadge?: boolean;
        }) => (
          <DSSettingsRow
            icon={icon}
            label={label}
            value={value}
            hint={hint}
            onClick={onClick}
            disabled={disabled}
            valueSmall={valueSmall}
            comingSoonLabel={t('settings_coming_soon', locale)}
            proBadge={proBadge ? <ProBadge /> : undefined}
            newBadge={newBadge ? settingsNewBadgeNode : undefined}
          />
        );
        const SettingsToggle = ({ icon, label, value, disabled, proBadge, onChange }: {
          icon?: string; label: string; value: boolean; disabled?: boolean; proBadge?: boolean; onChange: (v: boolean) => void;
        }) => (
          <DSSettingsToggle
            icon={icon}
            label={label}
            value={value}
            disabled={disabled}
            onChange={onChange}
            proBadge={proBadge ? <ProBadge /> : undefined}
          />
        );
        const SettingsActionRow = DSSettingsActionRow;

        return (
        <div style={{ padding: '16px 20px 120px', animation: 'fadeIn 0.3s ease' }}>
          <h1 style={{ fontSize: 26, fontWeight: 700, fontFamily: font, color: 'var(--wb-text)', letterSpacing: '-0.035em', lineHeight: 1.05, margin: '0 0 20px' }}>
            {t('settings_title', locale)}
          </h1>

          {settingsLoading && !settingsData ? (
            <div style={{ textAlign: 'center', padding: 40, color: C.textMuted }}>{t('loading', locale)}</div>
          ) : settingsData && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>

              {/* ── DEBUG BLOCK — god mode + toggle only ── */}
              {godMode && showLocaleDebug && (() => {
                const rawLang = tgLangCodeRef.current;
                const normalized = normalizeLocale(rawLang);
                const fallbackUsed = !rawLang || (normalized === 'en' && !rawLang?.startsWith('en'));
                const rows: [string, string][] = [
                  ['build', process.env.NEXT_PUBLIC_BUILD_TIME ?? 'unknown'],
                  ['tg.language_code', rawLang ?? '(undefined)'],
                  ['normalized', normalized],
                  ['languageMode', settingsData.languageMode],
                  ['manualLanguage', settingsData.manualLanguage ?? 'null'],
                  ['effectiveLanguage (server)', settingsData.effectiveLanguage],
                  ['locale (client state)', locale],
                  ['fallback used', fallbackUsed ? 'YES ⚠️' : 'no'],
                ];
                return (
                  <div style={{
                    background: '#1a1a2e', borderRadius: 10, padding: '10px 12px',
                    fontFamily: 'monospace', fontSize: 11, color: '#7fdbca',
                    border: '1px solid #334',
                  }}>
                    <div style={{ color: '#ff6b6b', fontWeight: 700, marginBottom: 6 }}>🛠 locale debug</div>
                    {rows.map(([k, v]) => (
                      <div key={k} style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
                        <span style={{ color: '#aaa', minWidth: 160 }}>{k}</span>
                        <span style={{ color: '#fff' }}>{v}</span>
                      </div>
                    ))}
                  </div>
                );
              })()}
              {/* ── END DEBUG BLOCK ─────────────────────────────────────── */}

              {/* ── PROFILE CARD ── */}
              <div style={{
                background: 'linear-gradient(135deg, rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.08), rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.02))',
                border: '1px solid rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.15)',
                borderRadius: 20, padding: 18, marginTop: 4,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <UserAvatar
                    avatarUrl={profileData?.avatarUrl}
                    name={resolveOwnerName(profileData, tgUser)}
                    size={48}
                    accent={C.accent}
                    border={`2px solid ${C.accent}`}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 18, fontWeight: 700, color: C.text }}>{resolveOwnerName(profileData, tgUser)}</span>
                      {settingsData.isPro && <ProBadge />}
                    </div>
                    {(profileData?.username || tgUser?.username) && (
                      <div style={{ fontSize: 13, color: C.textMuted, marginTop: 2 }}>
                        @{profileData?.username || tgUser?.username}
                      </div>
                    )}
                  </div>
                </div>
                {settingsData.supportId && (
                  <div style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    marginTop: 16, paddingTop: 14,
                    borderTop: '1px solid rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.1)',
                  }}>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span style={{ fontSize: 11, color: C.textMuted, fontWeight: 500 }}>{t('support_id_label', locale)}</span>
                      <span style={{ fontFamily: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace", fontSize: 12, color: C.textSec, letterSpacing: 0.3 }}>
                        {settingsData.supportId}
                      </span>
                    </div>
                    <button
                      onClick={async () => {
                        const id = settingsData.supportId!;
                        try {
                          if (typeof window !== 'undefined' && window.Telegram?.WebApp?.writeToClipboard) {
                            window.Telegram.WebApp.writeToClipboard(id);
                            pushToast(t('support_id_copied', locale), 'success');
                            return;
                          }
                          await navigator.clipboard.writeText(id);
                          pushToast(t('support_id_copied', locale), 'success');
                        } catch {
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
                        flexShrink: 0, background: C.accentSoft, color: C.accent, border: 'none',
                        padding: '6px 14px', borderRadius: 10, fontSize: 12, fontWeight: 600,
                        cursor: 'pointer', fontFamily: font, transition: 'all 0.15s',
                      }}
                    >
                      {t('support_id_copy', locale)}
                    </button>
                  </div>
                )}
              </div>

              {/* v2.1 — Appearance (theme + accent). Locale-aware labels. */}
              {(() => {
                const ap = (() => {
                  switch (locale) {
                    case 'en':    return { accentTitle: 'Accent color',      themeTitle: 'App background', proHint: 'PRO', themeDarkName: 'Dark',    themeDarkSub: 'Default',        themeBlackName: 'Black',   themeBlackSub: 'OLED-friendly' };
                    case 'zh-CN': return { accentTitle: '强调色',              themeTitle: '应用背景',        proHint: 'PRO', themeDarkName: '深色',    themeDarkSub: '默认',            themeBlackName: '黑色',    themeBlackSub: 'OLED 省电' };
                    case 'hi':    return { accentTitle: 'एक्सेंट रंग',          themeTitle: 'ऐप पृष्ठभूमि',   proHint: 'PRO', themeDarkName: 'डार्क',  themeDarkSub: 'डिफ़ॉल्ट',        themeBlackName: 'ब्लैक',   themeBlackSub: 'OLED-किफायती' };
                    case 'es':    return { accentTitle: 'Color de acento',   themeTitle: 'Fondo de app',    proHint: 'PRO', themeDarkName: 'Oscuro',  themeDarkSub: 'Predeterminado', themeBlackName: 'Negro',   themeBlackSub: 'OLED-ahorro' };
                    case 'ar':    return { accentTitle: 'لون التمييز',       themeTitle: 'خلفية التطبيق',   proHint: 'PRO', themeDarkName: 'داكن',   themeDarkSub: 'افتراضي',        themeBlackName: 'أسود',    themeBlackSub: 'توفير OLED' };
                    default:      return { accentTitle: 'Акцентный цвет',    themeTitle: 'Фон приложения',  proHint: 'PRO', themeDarkName: 'Тёмный',  themeDarkSub: 'По умолчанию',   themeBlackName: 'Чёрный',  themeBlackSub: 'OLED-экономия' };
                  }
                })();
                return (
                  <div style={{ marginTop: 22, marginBottom: 4, marginLeft: -16, marginRight: -16 }}>
                    <AppearanceSettings
                      isPro={planInfo.code === 'PRO'}
                      onOpenPaywall={() => setUpsellSheet({ context: 'appearance' })}
                      labels={ap}
                    />
                  </div>
                );
              })()}

              {/* v2.1 — Calendar entry. Wrapped in SettingsSection so the
                  card width and chrome match neighbouring "Общее" /
                  "Уведомления" / "Приватность" sections exactly — earlier
                  this rendered as a standalone div with slightly different
                  padding / radius (18px vs SettingsSection's 20px) and read
                  as visually wider than its siblings. */}
              {(() => {
                const cal = (() => {
                  switch (locale) {
                    case 'en':    return { sectionTitle: 'Event calendar',  rowLabel: 'Calendar',          rowHint: 'Birthdays and wishlist deadlines' };
                    case 'zh-CN': return { sectionTitle: '事件日历',          rowLabel: '日历',              rowHint: '生日和心愿单截止日期' };
                    case 'hi':    return { sectionTitle: 'इवेंट कैलेंडर',     rowLabel: 'कैलेंडर',           rowHint: 'जन्मदिन और विशलिस्ट डेडलाइन' };
                    case 'es':    return { sectionTitle: 'Calendario',      rowLabel: 'Calendario',        rowHint: 'Cumpleaños y fechas límite de listas' };
                    case 'ar':    return { sectionTitle: 'تقويم الأحداث',   rowLabel: 'التقويم',           rowHint: 'أعياد الميلاد ومواعيد قوائم الرغبات' };
                    default:      return { sectionTitle: 'Календарь событий', rowLabel: 'Календарь',       rowHint: 'Дни рождения и дедлайны вишлистов' };
                  }
                })();
                return (
                  <SettingsSection title={cal.sectionTitle}>
                    <SettingsRow
                      icon={'\u{1F4C5}'}
                      label={cal.rowLabel}
                      hint={cal.rowHint}
                      onClick={() => setScreen('calendar')}
                    />
                  </SettingsSection>
                );
              })()}

              {/* ── Birthday Reminders ─────────────────────────────────────
                  Lazy-loads /tg/me/birthday-settings on first render.
                  Pro-only fields (audience EXTENDED, primary wishlist,
                  custom message, advanced windows) tap → upsell sheet
                  with `birthday_reminders_advanced` context. */}
              {(() => {
                const bs = birthdaySettings;
                if (!bs && !birthdaySettingsLoading) {
                  setBirthdaySettingsLoading(true);
                  void tgFetch('/tg/me/birthday-settings').then(async (r: Response) => {
                    if (r.ok) {
                      const data = await r.json();
                      setBirthdaySettings(data);
                      trackEvent('birthday.settings_opened');
                    }
                    setBirthdaySettingsLoading(false);
                  }).catch(() => setBirthdaySettingsLoading(false));
                  return null;
                }
                if (!bs) return null;
                const isPro = bs.isPro;
                const friend = bs.friendReminders;
                const owner = bs.ownerReminders;
                const recv = bs.receiving;

                const patchBirthday = async (body: Record<string, unknown>) => {
                  const res = await tgFetch('/tg/me/birthday-settings', {
                    method: 'PATCH',
                    body: JSON.stringify(body),
                    idempotency: { action: 'birthday.settings' },
                  } as never).catch(() => null);
                  if (!res) return;
                  if (res.status === 402) {
                    showUpsell('birthday_reminders_advanced', { auto: true });
                    trackEvent('birthday.paywall_shown', { context: 'birthday_reminders_advanced', via: 'auto_402' });
                    return;
                  }
                  if (res.ok) {
                    // Re-fetch to get the canonical state
                    void tgFetch('/tg/me/birthday-settings').then(async (r: Response) => {
                      if (r.ok) setBirthdaySettings(await r.json());
                    });
                  }
                };

                const formatBirthday = (iso: string | null): string => {
                  if (!iso) return t('settings_coming_soon', locale);
                  const d = new Date(iso);
                  return new Intl.DateTimeFormat(localeToBCP47(locale), { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(d);
                };

                return (
                  <SettingsSection title={t('br_section_title', locale)}>
                    <SettingsRow
                      icon={'\u{1F382}'}
                      label={t('profile_birthday', locale)}
                      value={bs.birthday ? formatBirthday(bs.birthday) : undefined}
                      onClick={() => setScreen('profile')}
                    />
                    {bs.birthday && (
                      <>
                        <SDivider />
                        <SettingsToggle
                          icon={'\u{1F514}'}
                          label={t('br_friend_reminders_label', locale)}
                          value={friend.enabled}
                          onChange={(v) => void patchBirthday({ friendRemindersEnabled: v })}
                        />
                        {friend.enabled && (
                          <>
                            <SDivider />
                            <SettingsRow
                              icon={'\u{1F465}'}
                              label={t('br_audience_label', locale)}
                              value={friend.audience === 'EXTENDED' ? t('br_audience_extended', locale) : t('br_audience_subscribers', locale)}
                              onClick={() => {
                                if (!isPro && friend.audience === 'SUBSCRIBERS') {
                                  showUpsell('birthday_reminders_advanced');
                                  trackEvent('birthday.paywall_shown', { context: 'audience_extended', via: 'tap' });
                                  return;
                                }
                                // Open audience picker — toggle between two values for now
                                void patchBirthday({ audience: friend.audience === 'EXTENDED' ? 'SUBSCRIBERS' : 'EXTENDED' });
                              }}
                            />
                            <SDivider />
                            <SettingsRow
                              icon={'\u{1F381}'}
                              label={t('br_primary_wishlist_label', locale)}
                              value={friend.primaryWishlist?.title ?? t('br_primary_wishlist_auto', locale)}
                              proBadge={!isPro}
                              onClick={() => {
                                if (!isPro) {
                                  showUpsell('birthday_reminders_advanced');
                                  trackEvent('birthday.paywall_shown', { context: 'primary_wishlist', via: 'tap' });
                                  return;
                                }
                                // Picker UI lives in Profile screen; for now scroll to it
                                setScreen('profile');
                              }}
                            />
                            <SDivider />
                            <SettingsRow
                              icon={'\u{270F}\u{FE0F}'}
                              label={t('br_custom_message_label', locale)}
                              value={friend.customMessage ?? undefined}
                              hint={!friend.customMessage ? t('br_custom_message_hint', locale) : undefined}
                              proBadge={!isPro}
                              onClick={() => {
                                if (!isPro) {
                                  showUpsell('birthday_reminders_advanced');
                                  trackEvent('birthday.paywall_shown', { context: 'custom_message', via: 'tap' });
                                  return;
                                }
                                const next = window.prompt(t('br_custom_message_title', locale), friend.customMessage ?? '');
                                if (next !== null) {
                                  void patchBirthday({ customMessage: next.slice(0, 200) });
                                }
                              }}
                            />
                            <SDivider />
                            <SettingsToggle
                              icon={'\u{2728}'}
                              label={t('br_advanced_windows_label', locale)}
                              value={friend.advancedWindowsEnabled && isPro}
                              proBadge={!isPro}
                              onChange={(v) => {
                                if (v && !isPro) {
                                  showUpsell('birthday_reminders_advanced');
                                  trackEvent('birthday.paywall_shown', { context: 'advanced_windows', via: 'toggle' });
                                  return;
                                }
                                void patchBirthday({ advancedWindowsEnabled: v });
                              }}
                            />
                          </>
                        )}
                      </>
                    )}
                    <SDivider />
                    <SettingsToggle
                      icon={'\u{1F4DD}'}
                      label={t('br_owner_reminders_label', locale)}
                      value={owner.enabled}
                      onChange={(v) => void patchBirthday({ ownerRemindersEnabled: v })}
                    />
                    <SDivider />
                    <SettingsToggle
                      icon={'\u{1F4E5}'}
                      label={t('br_receiving_label', locale)}
                      value={recv.enabled}
                      onChange={(v) => void patchBirthday({ receivingEnabled: v })}
                    />
                    {recv.mutedCount > 0 && (
                      <>
                        <SDivider />
                        <SettingsRow
                          icon={'\u{1F507}'}
                          label={t('br_muted_label', locale)}
                          value={pluralize(
                            recv.mutedCount,
                            t('br_muted_count_one', locale, { count: recv.mutedCount }),
                            t('br_muted_count_few', locale, { count: recv.mutedCount }),
                            t('br_muted_count_many', locale, { count: recv.mutedCount }),
                            locale,
                          )}
                          onClick={() => {
                            // Lazy-load muted list; navigation handled via inline modal
                            void tgFetch('/tg/birthday-reminders/muted').then(async (r: Response) => {
                              if (r.ok) {
                                const data = await r.json() as { muted: any };
                                setBirthdayMutedList(data.muted);
                              }
                            });
                          }}
                        />
                      </>
                    )}
                  </SettingsSection>
                );
              })()}

              {/* General */}
              <SettingsSection title={t('settings_general', locale)}>
                {(() => {
                  const LANG_NATIVE: Record<string, string> = {
                    ru: 'Русский', en: 'English', 'zh-CN': '中文', hi: 'हिन्दी', es: 'Español', ar: 'العربية',
                  };
                  const isAuto = settingsData.languageMode === 'auto';
                  const effectiveName = LANG_NATIVE[locale] ?? locale;
                  const hint = isAuto ? t('settings_language_auto', locale) : undefined;
                  return (
                    <SettingsRow
                      icon={'\u{1F310}'}
                      label={t('settings_language', locale)}
                      value={effectiveName}
                      hint={hint}
                      onClick={() => setShowLanguageSheet(true)}
                    />
                  );
                })()}
                <SDivider />
                <div style={{ display: 'flex', alignItems: 'center', padding: '14px 0', gap: 12 }}>
                  <div style={{
                    width: 28, height: 28, borderRadius: '50%',
                    background: C.accentSoft,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 14, flexShrink: 0,
                  }}>{'\u{1F4B0}'}</div>
                  <span style={{ fontSize: 15, fontWeight: 500, color: C.text, flex: 1 }}>{t('settings_default_currency', locale)}</span>
                  <div style={{ display: 'flex', background: C.surface, borderRadius: 10, padding: 3, gap: 2 }}>
                    {(['RUB', 'USD'] as const).map(c => (
                      <button key={c} onClick={() => patchSettings({ defaultCurrency: c })} style={{
                        padding: '5px 14px', borderRadius: 8, border: 'none', fontSize: 14, fontWeight: 600,
                        cursor: 'pointer', fontFamily: font,
                        background: settingsData.defaultCurrency === c ? C.accent : 'transparent',
                        color: settingsData.defaultCurrency === c ? '#fff' : C.textMuted,
                        boxShadow: settingsData.defaultCurrency === c ? '0 2px 8px rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.3)' : 'none',
                        transition: 'all 0.2s',
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
                  icon={'\u{1F4AC}'}
                  label={t('settings_notify_comments', locale)}
                  value={settingsData.notifications.comments}
                  disabled={!settingsData.isPro}
                  proBadge={!settingsData.isPro}
                  onChange={(v) => settingsData.isPro ? patchSettings({ notifications: { ...settingsData.notifications, comments: v } }) : showUpsell('comments')}
                />
                <SDivider />
                <SettingsToggle
                  icon={'\u{1F381}'}
                  label={t('settings_notify_reservations', locale)}
                  value={settingsData.notifications.reservations}
                  disabled={!settingsData.isPro}
                  proBadge={!settingsData.isPro}
                  onChange={(v) => settingsData.isPro ? patchSettings({ notifications: { ...settingsData.notifications, reservations: v } }) : showUpsell('comments')}
                />
                <SDivider />
                <SettingsToggle
                  icon={'\u{1F514}'}
                  label={t('settings_notify_subscriptions', locale)}
                  value={settingsData.notifications.subscriptions}
                  disabled={!settingsData.isPro}
                  proBadge={!settingsData.isPro}
                  onChange={(v) => settingsData.isPro ? patchSettings({ notifications: { ...settingsData.notifications, subscriptions: v } }) : showUpsell('comments')}
                />
                <SDivider />
                <SettingsToggle
                  icon={'\u{1F4E2}'}
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
                  icon={'\u{1F441}'}
                  label={t('settings_profile_visibility', locale)}
                  value={settingsData.privacy.profileVisibility === 'ALL' ? t('privacy_value_all', locale) : settingsData.privacy.profileVisibility === 'NOBODY' ? t('privacy_value_nobody', locale) : settingsData.privacy.profileVisibility === 'LINK_ONLY' ? t('visibility_link_only', locale) : settingsData.privacy.profileVisibility}
                  onClick={() => setShowProfileVisibilitySheet(true)}
                />
                <SDivider />
                <SettingsRow
                  icon={'\u{1F465}'}
                  label={t('settings_subscribe_policy', locale)}
                  value={settingsData.privacy.subscribePolicy === 'ALL' ? t('privacy_value_all', locale) : settingsData.privacy.subscribePolicy === 'NOBODY' ? t('privacy_subs_nobody_new', locale) : settingsData.privacy.subscribePolicy === 'LINK_ONLY' ? t('subscribe_link_only', locale) : settingsData.privacy.subscribePolicy}
                  onClick={() => setShowSubscribePolicySheet(true)}
                />
                <SDivider />
                <SettingsRow
                  icon={'\u{1F4AD}'}
                  label={t('settings_allow_comments', locale)}
                  value={settingsData.privacy.commentsEnabled ? t('privacy_comments_anyone', locale) : t('privacy_comments_subs_only', locale)}
                  valueSmall
                  proBadge={!settingsData.isPro}
                  onClick={settingsData.isPro ? () => setShowCommentsDefaultSheet(true) : () => showUpsell('comments')}
                />
                <SDivider />
                <SettingsToggle
                  icon={'\u{1F4A1}'}
                  label={t('settings_allow_hints', locale)}
                  value={settingsData.privacy.hintsEnabled}
                  onChange={(v) => patchSettings({ privacy: { ...settingsData.privacy, hintsEnabled: v } })}
                />
                <SDivider />
                <SettingsRow
                  icon={'\u{1F517}'}
                  label={t('settings_link_management', locale)}
                  value={linkMgmtData ? t('settings_link_management_count', locale, { count: (linkMgmtData.selections.length + linkMgmtData.wishlists.length + (linkMgmtData.profile ? 1 : 0)).toString() }) : ''}
                  valueSmall
                  newBadge
                  onClick={() => { setScreen('link-management'); void loadActiveLinks(); }}
                />
                <SDivider />
                <SettingsRow
                  icon={'\u{1F512}'}
                  label={t('settings_reserved_visibility', locale)}
                  value=""
                  disabled
                />
              </SettingsSection>

              {/* Customization */}
              <SettingsSection title={t('settings_app_behavior_title', locale)}>
                <SettingsToggle
                  icon={'\u{1F4CC}'}
                  label={t('settings_wishlists_on_top', locale)}
                  value={settingsData.isPro && settingsData.appBehavior.newWishlistPosition === 'top'}
                  disabled={!settingsData.isPro}
                  proBadge={!settingsData.isPro}
                  onChange={(v) => {
                    if (!settingsData.isPro) { showUpsell('wishlist_limit'); return; }
                    patchSettings({ appBehavior: { ...settingsData.appBehavior, newWishlistPosition: v ? 'top' : 'bottom' } });
                  }}
                />
                <SDivider />
                <SettingsRow
                  icon={'\u{1F512}'}
                  label={t('settings_sorting_default', locale)}
                  value=""
                  disabled
                />
                {/* Card display mode — only for canary + PRO users */}
                {CARD_REDESIGN_ENABLED && (
                  <>
                    <SDivider />
                    <div style={{ padding: '10px 0 6px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 12 }}>
                        <div style={{
                          width: 28, height: 28, borderRadius: '50%',
                          background: C.accentSoft,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 14, flexShrink: 0,
                        }}>{'\u{1F0CF}'}</div>
                        <span style={{ fontSize: 15, fontWeight: 500, color: C.text }}>{t('settings_card_layout', locale)}</span>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        {(['auto', 'showcase', 'compact'] as const).map(mode => {
                          const isActive = cardDisplayMode === mode;
                          const needsPro = mode !== 'auto' && planInfo.code !== 'PRO';
                          const modeIcon = mode === 'auto' ? '\u{1F4F1}' : mode === 'showcase' ? '\u{1F5BC}' : '\u{1F4CB}';
                          const modeLabel = mode === 'auto' ? t('settings_card_auto', locale)
                            : mode === 'showcase' ? t('settings_card_showcase', locale)
                            : t('settings_card_compact', locale);
                          return (
                            <button
                              key={mode}
                              onClick={() => {
                                if (needsPro) { showUpsell('wishlist_limit'); return; }
                                setCardDisplayMode(mode);
                                patchSettings({ appBehavior: { ...settingsData?.appBehavior, cardDisplayMode: mode } });
                              }}
                              style={{
                                flex: 1, display: 'flex', flexDirection: 'column' as const, alignItems: 'center',
                                gap: 5, padding: '12px 6px 10px', borderRadius: 14, cursor: 'pointer',
                                fontFamily: font,
                                background: isActive ? C.accentSoft : C.surface,
                                border: `1px solid ${isActive ? 'rgb(var(--wb-accent-r, 139) var(--wb-accent-g, 123) var(--wb-accent-b, 255) / 0.35)' : C.borderLight}`,
                                opacity: needsPro ? 0.5 : 1,
                                transition: 'all 0.2s',
                              }}
                            >
                              <span style={{ fontSize: 20, lineHeight: 1 }}>{modeIcon}</span>
                              <span style={{ fontSize: 12, fontWeight: 600, color: isActive ? C.accent : C.textSec }}>{modeLabel}{needsPro ? ' 👑' : ''}</span>
                            </button>
                          );
                        })}
                      </div>
                      <div style={{ fontSize: 10, color: C.textMuted, marginTop: 8, lineHeight: 1.4, padding: '0 2px 4px' }}>{t('settings_card_auto_hint', locale)}</div>
                    </div>
                  </>
                )}
              </SettingsSection>

              {/* Don't Gift — PRO feature */}
              <SettingsSection title={t('dont_gift_title', locale)}>
                <SettingsActionRow
                  icon={'🚫'}
                  label={t('dont_gift_settings_label', locale)}
                  onClick={() => {
                    trackEvent('dont_gift_settings_tap');
                    if (planInfo.code === 'FREE') {
                      showUpsell('dont_gift');
                      return;
                    }
                    void openDontGiftEdit();
                  }}
                />
                {planInfo.code === 'FREE' && (
                  <div style={{ padding: '0 16px 12px', fontSize: 12, color: C.textMuted, display: 'flex', alignItems: 'center', gap: 6 }}>
                    <ProBadge /> {t('dont_gift_settings_hint', locale)}
                  </div>
                )}
                {planInfo.code !== 'FREE' && dontGiftData && (dontGiftData.presets.length > 0 || dontGiftData.customItems.length > 0 || dontGiftData.comment) && (
                  <div style={{ padding: '0 16px 12px', fontSize: 12, color: C.green, fontWeight: 600 }}>
                    ✓ {t('dont_gift_filled', locale)}
                  </div>
                )}
              </SettingsSection>

              {/* Support & Service */}
              <SettingsSection title={t('settings_support_title', locale)}>
                <SettingsActionRow icon={'\u{1F4CB}'} label={t('settings_changelog', locale)} dot={hasNewInSettings} onClick={() => {
                  if (LATEST_RELEASE_ID) {
                    setChangelogSeenId(LATEST_RELEASE_ID);
                    try { window.localStorage.setItem('changelog_seen_id', LATEST_RELEASE_ID); } catch { /* ok */ }
                  }
                  // Reset scroll BEFORE setScreen so there's no visible jump
                  // while React is committing the new screen. The post-commit
                  // useEffect is a safety net for any layout-shift edge case.
                  if (scrollContainerRef.current) scrollContainerRef.current.scrollTop = 0;
                  setScreen('changelog');
                }} />
                <SDivider />
                <SettingsActionRow icon={'\u{1F6E0}'} label={t('settings_report_problem', locale)} onClick={() => {
                  setShowReportProblemSheet(true);
                }} />
                <SDivider />
                <SettingsActionRow icon={'\u{1F4AC}'} label={t('settings_contact_support', locale)} onClick={async () => {
                  try { tgRef.current?.WebApp?.HapticFeedback?.impactOccurred?.('light'); } catch { /* ok */ }
                  trackEvent('settings_support_contact_tap');

                  const supportUrl = 'https://t.me/Wish_Support';
                  const openChat = () => {
                    try {
                      if (window.Telegram?.WebApp?.openTelegramLink) {
                        window.Telegram.WebApp.openTelegramLink(supportUrl);
                      } else {
                        window.open(supportUrl, '_blank');
                      }
                      trackEvent('settings_support_contact_opened');
                    } catch {
                      window.open(supportUrl, '_blank');
                      trackEvent('settings_support_contact_opened');
                    }
                  };

                  const id = settingsData.supportId;
                  if (!id) {
                    openChat();
                    pushToast(t('support_contact_opened', locale), 'success');
                    return;
                  }

                  // Try to copy support ID then open chat
                  const copyId = async (): Promise<boolean> => {
                    try {
                      if (typeof window !== 'undefined' && window.Telegram?.WebApp?.writeToClipboard) {
                        window.Telegram.WebApp.writeToClipboard(id);
                        return true;
                      }
                      await navigator.clipboard.writeText(id);
                      return true;
                    } catch {
                      try {
                        const ta = document.createElement('textarea');
                        ta.value = id;
                        ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
                        document.body.appendChild(ta);
                        ta.focus(); ta.select();
                        document.execCommand('copy');
                        document.body.removeChild(ta);
                        return true;
                      } catch {
                        return false;
                      }
                    }
                  };

                  const copied = await copyId();
                  openChat();
                  if (copied) {
                    pushToast(t('support_contact_id_copied', locale), 'success');
                    trackEvent('settings_support_id_copied');
                  } else {
                    pushToast(t('support_contact_id_copy_failed', locale), 'error');
                    trackEvent('settings_support_id_copy_failed');
                  }
                }} />
                <SDivider />
                <SettingsActionRow icon={'\u{2753}'} label={t('settings_faq', locale)} onClick={() => setScreen('faq')} />
                <SDivider />
                <SettingsActionRow icon={'\u{1F4C4}'} label={t('settings_legal', locale)} onClick={() => { setLegalDocId(null); setScreen('legal'); }} />
              </SettingsSection>

              {/* Danger Zone — reuses SettingsActionRow with danger color.
                  Background keeps explicit 0.06 alpha (subtler than `--wb-danger-soft`'s 0.14)
                  — this container is a passive "zone" marker, not an inline alert. */}
              <div style={{
                background: 'rgba(251,113,133,0.06)',
                border: '1px solid rgba(251,113,133,0.12)',
                borderRadius: 20, padding: '4px 18px', marginTop: 18,
              }}>
                <SettingsActionRow
                  icon={'\u{1F5D1}'}
                  label={t('settings_delete_account', locale)}
                  color={C.red}
                  onClick={() => setShowDeleteAccount(true)}
                />
              </div>
            </div>
          )}
        </div>
        );
      })()}
    </>
  );
}
