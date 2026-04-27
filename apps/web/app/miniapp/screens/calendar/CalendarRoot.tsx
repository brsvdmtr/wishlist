/**
 * Events Calendar — feature root.
 *
 * Owns: subscreen routing, list-load lifecycle, paywall-gate logic.
 * Replaces the old `CalendarScreenV21.tsx` stub.
 *
 * Design source: ui_kits/miniapp/calendar/* (design pack v2.1 from 2026-04-26).
 * Backend: /tg/gift-occasions* + /tg/calendar/* (apps/api/src/index.ts).
 */

'use client';

import React, { useCallback, useEffect, useState, type MutableRefObject } from 'react';
import type { Locale } from '@wishlist/shared';
import type { TgFetch } from './api';
import * as api from './api';
import type { OccasionListItem, OccasionDetail, CalendarView, CalendarEntitlement, TodayContext } from './types';
import { CalendarMain } from './CalendarMain';
import { CalendarDetail } from './CalendarDetail';
import { CalendarCreate } from './CalendarCreate';
import { CalendarPaywall } from './CalendarPaywall';
import { CalendarOnboarding } from './CalendarPaywall';
import { CalendarImport } from './CalendarImport';
import { CalendarInbox } from './CalendarInbox';
import { CalendarRecap } from './CalendarRecap';
import { ct } from './i18n';

export interface CalendarRootProps {
  tgFetch: TgFetch;
  locale: Locale;
  /** Pulled from /tg/me in MiniApp.tsx; tells us whether feature is unlocked. */
  entitlement: CalendarEntitlement;
  /** When user pays via Stars and we receive `successful_payment` webhook,
   * MiniApp re-fetches /tg/me. Calling this triggers that refresh from inside the feature. */
  onEntitlementMaybeChanged: () => void;
  onBack: () => void;
  onShowToast: (text: string, kind?: 'info' | 'success' | 'error') => void;
  /** Optional ref provided by MiniApp's navBack so Telegram BackButton can pop
   * sub-screens (detail / create / etc.) instead of exiting the feature. */
  subscreenBackRef?: MutableRefObject<(() => boolean) | null>;
}

type Screen =
  | { kind: 'main' }
  | { kind: 'detail'; occasionId: string }
  | { kind: 'create'; prefill?: { type?: 'BIRTHDAY' | 'ANNIVERSARY' | 'HOLIDAY' | 'OTHER'; linkedUserId?: string } }
  | { kind: 'inbox' }
  | { kind: 'recap'; year: number }
  | { kind: 'import-friends' }
  | { kind: 'import-holidays' };

export function CalendarRoot({ tgFetch, locale, entitlement, onEntitlementMaybeChanged, onBack, onShowToast, subscreenBackRef }: CalendarRootProps) {
  // Locked → paywall flow:
  // showLocked: user is on the calendar screen but feature is locked (free user clicked the entry)
  //   → render Locked teaser; CTA opens PaywallSheet (sheet by default; full from "show me everything")
  // showOnboarding: user just paid (first session post-purchase) → 4-step onboarding then main
  const [paywallOpen, setPaywallOpen] = useState<'sheet' | 'full' | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [paymentInProgress, setPaymentInProgress] = useState(false);

  const [screen, setScreen] = useState<Screen>({ kind: 'main' });
  const [view, setView] = useState<CalendarView>('month');
  const [occasions, setOccasions] = useState<OccasionListItem[] | null>(null);
  const [todayContext, setTodayContext] = useState<TodayContext | null>(null);
  const [activeDetail, setActiveDetail] = useState<OccasionDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState<{ birthdays: boolean; anniversaries: boolean; holidays: boolean; own: boolean }>({
    birthdays: true, anniversaries: true, holidays: true, own: true,
  });

  // Onboarding gate.
  //
  // Persistence migrated from localStorage-only to a server-side flag
  // (`User.calendarOnboardingSeenAt`, exposed via /tg/calendar/today-context):
  // the device-local flag made the 4-step intro repeat on every new surface
  // (iPhone → Mac → web), even when the same account had already finished
  // it. The local flag stays as a fallback for offline/loading races.
  //
  // Resolution order, checked once todayContext + occasions finish loading:
  //  1. server seenAt is set       → never onboard (also silence locally)
  //  2. user already has events    → never onboard (silently mark seen)
  //  3. local seen flag set        → never onboard
  //  4. brand-new, empty account   → show the 4-step intro
  const onboardingFlagKey = 'wb_calendar_onb_v1';
  useEffect(() => {
    if (!entitlement.unlocked || typeof window === 'undefined') return;
    // Wait for both initial loads to settle before deciding — otherwise we'd
    // flash onboarding on accounts that DO have events / DID see it before
    // simply because the data hasn't arrived yet.
    if (occasions === null || todayContext === null) return;

    const seenServer = todayContext.onboardingSeenAt ?? null;
    if (seenServer) {
      try { window.localStorage.setItem(onboardingFlagKey, '1'); } catch { /* ignore quota */ }
      setShowOnboarding(false);
      return;
    }
    if (occasions.length > 0) {
      try { window.localStorage.setItem(onboardingFlagKey, '1'); } catch { /* ignore quota */ }
      // Best-effort backfill on the server so OTHER devices skip onboarding
      // too — this user has clearly used the feature, no need to onboard them
      // anywhere. Errors are non-fatal: a transient failure just means we'll
      // try again next session.
      void api.markCalendarOnboardingSeen(tgFetch).catch(() => { /* ignore */ });
      setShowOnboarding(false);
      return;
    }

    const seen = window.localStorage.getItem(onboardingFlagKey);
    if (!seen) setShowOnboarding(true);
  }, [entitlement.unlocked, occasions, todayContext, tgFetch]);

  const closeOnboarding = useCallback((openCreate?: boolean) => {
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(onboardingFlagKey, '1'); } catch { /* ignore */ }
    }
    setShowOnboarding(false);
    // Persist on the server so future devices skip the intro. Fire-and-forget;
    // the local flag handles the immediate re-render path.
    void api.markCalendarOnboardingSeen(tgFetch).catch(() => { /* ignore */ });
    if (openCreate) setScreen({ kind: 'create' });
  }, [tgFetch]);

  const reloadOccasions = useCallback(async () => {
    if (!entitlement.unlocked) return;
    try {
      setLoading(true);
      const [list, today] = await Promise.all([
        api.listOccasions(tgFetch),
        api.getTodayContext(tgFetch).catch(() => ({ soonest: null })),
      ]);
      setOccasions(list.occasions);
      setTodayContext(today);
    } catch (err) {
      onShowToast('Не удалось загрузить события', 'error');
      // eslint-disable-next-line no-console
      console.error('Calendar list load failed', err);
    } finally {
      setLoading(false);
    }
  }, [tgFetch, entitlement.unlocked, onShowToast]);

  useEffect(() => {
    if (entitlement.unlocked) void reloadOccasions();
  }, [entitlement.unlocked, reloadOccasions]);

  // ─── Telegram BackButton sub-screen interceptor ───
  // Without this, Telegram BackButton runs MiniApp's navBack which exits the
  // calendar feature entirely — losing the user's place inside detail / create /
  // inbox / etc. Populate the parent's ref so navBack can pop the inner stack
  // first; clearing it on main lets Back exit the feature normally.
  useEffect(() => {
    if (!subscreenBackRef) return;

    // Paywall sheet open → close the sheet instead of exiting.
    if (paywallOpen !== null) {
      subscreenBackRef.current = () => { setPaywallOpen(null); return true; };
      return () => { subscreenBackRef.current = null; };
    }

    // Post-purchase onboarding → skip rather than bouncing to settings.
    if (showOnboarding) {
      subscreenBackRef.current = () => { closeOnboarding(false); return true; };
      return () => { subscreenBackRef.current = null; };
    }

    // Sub-screens → pop to calendar main.
    if (screen.kind !== 'main') {
      subscreenBackRef.current = () => {
        setActiveDetail(null);
        setScreen({ kind: 'main' });
        void reloadOccasions();
        return true;
      };
      return () => { subscreenBackRef.current = null; };
    }

    // Calendar main → let navBack exit the feature.
    subscreenBackRef.current = null;
  }, [screen.kind, paywallOpen, showOnboarding, subscreenBackRef, reloadOccasions, closeOnboarding]);

  // ─── Detail loader ───
  useEffect(() => {
    if (screen.kind !== 'detail') return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.getOccasion(tgFetch, screen.occasionId);
        if (!cancelled) setActiveDetail(r.occasion);
      } catch (err) {
        if (!cancelled) {
          onShowToast('Не удалось загрузить событие', 'error');
          // eslint-disable-next-line no-console
          console.error('Calendar detail load failed', err);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [screen, tgFetch, onShowToast]);

  // ─── Stars purchase flow ───
  const onUnlockClick = useCallback(async () => {
    if (paymentInProgress) return;
    setPaymentInProgress(true);
    try {
      const r = await api.checkoutGiftNotes(tgFetch);
      if (r.alreadyUnlocked) {
        // Sync entitlement and proceed
        try { await api.syncGiftNotes(tgFetch); } catch { /* ok */ }
        onEntitlementMaybeChanged();
        setPaywallOpen(null);
        setPaymentInProgress(false);
        return;
      }
      if (r.ok && r.invoiceUrl) {
        const tg = (window as unknown as { Telegram?: { WebApp?: { openInvoice?: (link: string, cb: (status: string) => void) => void } } }).Telegram?.WebApp;
        if (tg?.openInvoice) {
          tg.openInvoice(r.invoiceUrl, async (status) => {
            setPaymentInProgress(false);
            if (status === 'paid') {
              try { await api.syncGiftNotes(tgFetch); } catch { /* ok */ }
              setPaywallOpen(null);
              onShowToast('Оплачено! Открываем календарь', 'success');
              setTimeout(() => onEntitlementMaybeChanged(), 500);
            } else if (status === 'cancelled') {
              onShowToast('Оплата отменена', 'info');
            } else if (status === 'failed') {
              onShowToast('Не удалось оплатить', 'error');
            }
          });
        } else {
          window.open(r.invoiceUrl, '_blank');
          setPaymentInProgress(false);
        }
      } else {
        onShowToast(r.error ?? 'Не удалось создать счёт', 'error');
        setPaymentInProgress(false);
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Stars checkout failed', err);
      onShowToast('Ошибка покупки', 'error');
      setPaymentInProgress(false);
    }
  }, [tgFetch, paymentInProgress, onShowToast, onEntitlementMaybeChanged]);

  // ─── Render ───

  if (!entitlement.unlocked) {
    return (
      <CalendarPaywall
        locale={locale}
        priceXtr={entitlement.priceXtr}
        variant={paywallOpen ?? 'lock'}
        onOpenSheet={() => setPaywallOpen('sheet')}
        onOpenFull={() => setPaywallOpen('full')}
        onClose={() => setPaywallOpen(null)}
        onUnlock={onUnlockClick}
        onBack={onBack}
        loading={paymentInProgress}
      />
    );
  }

  if (showOnboarding) {
    return <CalendarOnboarding locale={locale} onSkip={() => closeOnboarding(false)} onCreateFirst={() => closeOnboarding(true)} />;
  }

  if (screen.kind === 'detail') {
    if (!activeDetail) {
      return (
        <div style={{ padding: 60, textAlign: 'center', color: 'var(--wb-text-muted)' }}>
          {ct('cal_back', locale)} ←
        </div>
      );
    }
    return (
      <CalendarDetail
        tgFetch={tgFetch}
        locale={locale}
        occasion={activeDetail}
        onBack={() => { setActiveDetail(null); setScreen({ kind: 'main' }); void reloadOccasions(); }}
        onShowToast={onShowToast}
        onMutated={async () => {
          const r = await api.getOccasion(tgFetch, screen.occasionId);
          setActiveDetail(r.occasion);
        }}
      />
    );
  }

  if (screen.kind === 'create') {
    return (
      <CalendarCreate
        tgFetch={tgFetch}
        locale={locale}
        prefill={screen.prefill}
        onCancel={() => setScreen({ kind: 'main' })}
        onCreated={async (id) => {
          await reloadOccasions();
          setScreen({ kind: 'detail', occasionId: id });
        }}
        onShowToast={onShowToast}
      />
    );
  }

  if (screen.kind === 'inbox') {
    return <CalendarInbox tgFetch={tgFetch} locale={locale} onBack={() => setScreen({ kind: 'main' })} onOpenOccasion={(id) => setScreen({ kind: 'detail', occasionId: id })} />;
  }

  if (screen.kind === 'recap') {
    return <CalendarRecap tgFetch={tgFetch} locale={locale} year={screen.year} onBack={() => setScreen({ kind: 'main' })} onShowToast={onShowToast} />;
  }

  if (screen.kind === 'import-friends' || screen.kind === 'import-holidays') {
    return (
      <CalendarImport
        tgFetch={tgFetch}
        locale={locale}
        kind={screen.kind === 'import-friends' ? 'friends' : 'holidays'}
        onBack={() => setScreen({ kind: 'main' })}
        onImported={async () => { await reloadOccasions(); setScreen({ kind: 'main' }); }}
        onShowToast={onShowToast}
      />
    );
  }

  return (
    <CalendarMain
      locale={locale}
      occasions={occasions ?? []}
      filters={filters}
      onFiltersChange={setFilters}
      todayContext={todayContext}
      view={view}
      onViewChange={setView}
      loading={loading}
      onBack={onBack}
      onAdd={() => setScreen({ kind: 'create' })}
      onOpenOccasion={(id) => setScreen({ kind: 'detail', occasionId: id })}
      onOpenInbox={() => setScreen({ kind: 'inbox' })}
      onOpenRecap={(year) => setScreen({ kind: 'recap', year })}
      onOpenImportFriends={() => setScreen({ kind: 'import-friends' })}
      onOpenImportHolidays={() => setScreen({ kind: 'import-holidays' })}
    />
  );
}

