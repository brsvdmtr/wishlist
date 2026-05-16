// PRO renewal reminder scheduler (P5r-5) — extracted from
// apps/api/src/index.ts. Hourly cron that fires Telegram DM reminders
// to PRO subscribers approaching renewal at two milestones:
//   - 7 days before currentPeriodEnd (window 6d–8d)
//   - 1 day  before currentPeriodEnd (window 12h–36h)
// Sent only to subs that won't auto-renew: yearly one-time purchases, or
// monthly subs the user cancelled (cancelAtPeriodEnd=true). Active monthly
// auto-renewals are silent (Telegram charges automatically, no action
// needed).
//
// Cadence (60 * 60 * 1000 ms), milestone windows, filters, idempotency
// formula (`reminder:<ms>:<subId>:<periodEndISO>`), i18n keys, date
// formatting, log labels, and PaymentEvent marker behavior preserved
// byte-identical for ops continuity.
//
// `sendLifecycleDM` is imported via deps from ../services/lifecycle.ts
// (shared with the lifecycle scheduler).
//
// Idempotency: synthetic PaymentEvent id `reminder:<ms>:<subId>:<periodEndISO>`
// — the @unique on telegramPaymentChargeId prevents duplicate sends.
//
// Best-effort: errors logged via 'pro-renewal-reminder cycle failed' but
// never bubble out of setInterval; next cycle re-attempts work.

import type { PrismaClient } from '@wishlist/db';
import type { Logger } from 'pino';
import { t, resolveLocaleWithSource, LIFETIME_BILLING_PERIOD } from '@wishlist/shared';
import type { SendLifecycleDM } from '../services/lifecycle';
import { profileToLanguageSettings } from '../services/locale';

type TrackEvent = (event: string, userId?: string, props?: Record<string, unknown>) => void;

export type ProRenewalSchedulerDeps = {
  prisma: PrismaClient;
  logger: Logger;
  sendLifecycleDM: SendLifecycleDM;
  trackEvent: TrackEvent;
  PRO_PLAN_CODE: string;
  MINI_APP_URL_FOR_DM: string;
};

export function startProRenewalReminderScheduler(deps: ProRenewalSchedulerDeps): void {
  const { prisma, logger, sendLifecycleDM, trackEvent, PRO_PLAN_CODE, MINI_APP_URL_FOR_DM } = deps;

  setInterval(async () => {
    try {
      const now = new Date();
      const windows = [
        { milestone: '7d' as const, lo: now.getTime() + 6 * 24 * 60 * 60 * 1000, hi: now.getTime() + 8 * 24 * 60 * 60 * 1000, key: 'bot_pro_renewal_7d' as const },
        { milestone: '1d' as const, lo: now.getTime() + 12 * 60 * 60 * 1000, hi: now.getTime() + 36 * 60 * 60 * 1000, key: 'bot_pro_renewal_1d' as const },
      ];

      for (const w of windows) {
        const subs = await prisma.subscription.findMany({
          where: {
            planCode: PRO_PLAN_CODE,
            status: 'ACTIVE',
            currentPeriodEnd: { gte: new Date(w.lo), lte: new Date(w.hi) },
            // Lifetime never receives renewal reminders — its sentinel
            // currentPeriodEnd (2099-12-31) is far outside the 7d / 1d windows
            // already, but we exclude billingPeriod='lifetime' explicitly so a
            // future change to the sentinel (or an admin-set date) cannot
            // accidentally page lifetime users.
            NOT: { billingPeriod: LIFETIME_BILLING_PERIOD },
            OR: [
              { billingPeriod: 'yearly' },
              { cancelAtPeriodEnd: true },
            ],
          },
          include: {
            user: {
              select: { id: true, telegramChatId: true, profile: { select: { languageMode: true, manualLanguage: true, notifyMarketing: true, normalizedLocale: true, language: true } } },
            },
          },
        });

        for (const sub of subs) {
          if (!sub.user.telegramChatId) continue;
          if (sub.user.profile && sub.user.profile.notifyMarketing === false) continue;

          const reminderId = `reminder:${w.milestone}:${sub.id}:${sub.currentPeriodEnd.toISOString()}`;
          const existing = await prisma.paymentEvent.findUnique({ where: { telegramPaymentChargeId: reminderId } });
          if (existing) continue;

          const { locale, source: localeSource } = resolveLocaleWithSource(
            profileToLanguageSettings(sub.user.profile),
          );
          const dateFmtLocale =
            locale === 'ru' ? 'ru-RU'
            : locale === 'zh-CN' ? 'zh-CN'
            : locale === 'hi' ? 'hi-IN'
            : locale === 'es' ? 'es-ES'
            : locale === 'ar' ? 'ar'
            : 'en-US';
          const fmtDate = sub.currentPeriodEnd.toLocaleDateString(dateFmtLocale, { day: 'numeric', month: 'long', year: 'numeric' });
          const text = t(w.key, locale, { date: fmtDate });

          // Deep-link the button to the PRO paywall so users land on the
          // renew/upgrade screen, not the home tab. MiniApp.tsx reads
          // `startapp` from window.location.search and maps `upgrade_pro`
          // to `showUpsell('pro_main')` (paywall sheet with monthly /
          // yearly / lifetime tiles). Matches the deep-link pattern used by
          // schedulers/lifecycle.ts (S1–S4 win-back touches).
          const webAppUrl = `${MINI_APP_URL_FOR_DM}?startapp=upgrade_pro`;
          const outcome = await sendLifecycleDM(sub.user.telegramChatId, text, locale, webAppUrl);
          if (outcome === 'transient_failure') continue; // retry next hour

          // Persist idempotency marker (even on permanent failure — we've tried and
          // won't spam on retry; user can re-engage from the app).
          await prisma.paymentEvent.create({
            data: {
              subscriptionId: sub.id,
              userId: sub.userId,
              telegramPaymentChargeId: reminderId,
              invoicePayload: reminderId,
              totalAmount: 0,
              currency: 'XTR',
              eventType: `reminder_sent_${w.milestone}`,
            },
          }).catch((err) => logger.warn({ err, reminderId }, 'reminder marker insert failed'));

          if (outcome === 'delivered') {
            trackEvent(`pro_renewal_reminder_${w.milestone}`, sub.userId, { billingPeriod: sub.billingPeriod });
          }
          logger.info({ milestone: w.milestone, userId: sub.userId.slice(0, 8), locale, localeSource, outcome }, 'pro_renewal_reminder_attempt');
        }
      }
    } catch (err) {
      logger.error({ err }, 'pro-renewal-reminder cycle failed');
    }
  }, 60 * 60 * 1000);
}
