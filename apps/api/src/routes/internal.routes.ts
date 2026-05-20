// Internal router — bot → API communication. Mounted as `app.use('/internal',
// internalRouter)` in apps/api/src/index.ts. Auth: every route requires
// `X-INTERNAL-KEY` header equal to BOT_TOKEN (timing-safe via secureCompare).
//
// This file ships the router as a registerInternalRouter(deps) factory. Route
// handler bodies are byte-identical to their previous in-place definitions —
// the only delta is that helpers / constants which still live in index.ts
// (getUserEntitlement, importUrlForUser, DRAFTS_ITEM_LIMIT,
// recordMaintenanceExposure, trackEvent) are passed as `deps` and
// destructured at the top of the function so the bodies don't need any
// `deps.X` rewriting.
//
// requireInternalAuth and internalImportLimiter live here permanently — they
// are used only by this router.

import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '@wishlist/db';
import { t, resolveLocaleWithSource, profileToLanguageSettings, isSupportedLocale } from '@wishlist/shared';

import logger from '../logger';
import { asyncHandler } from '../lib/asyncHandler';
import { zodError } from '../lib/http';
import { secureCompare } from '../lib/crypto';
import { validateUrl } from '../url-parser.js';
import { sendTgBotMessage } from '../telegram/botApi';
import { sendAdminAlert } from '../notifications/adminAlerts';
import { trackAnalyticsEvent } from '../services/analytics';
import { getImportAllowance, consumeImportCredit } from '../services/import-credits';

export type InternalRouterDeps = {
  // The runtime shape of getUserEntitlement is wider than the surface we
  // touch here (PlanInfo + proSource + subscription + promoPro). The
  // structural narrow keeps `plan.features` (readonly so the upstream
  // `as const` tuple matches) plus `isPro` for the import credit gate.
  getUserEntitlement: (userId: string, godMode?: boolean) => Promise<{ plan: { features: readonly string[] }; isPro: boolean }>;
  importUrlForUser: (userId: string, url: string, note?: string, source?: string) => Promise<{ parseStatus: 'ok' | 'partial' | 'failed'; [key: string]: unknown }>;
  DRAFTS_ITEM_LIMIT: number;
  recordMaintenanceExposure: (userId: string, surface: string, locale: string, telegramChatId: string | null) => Promise<string>;
  trackEvent: (event: string, userId?: string, props?: Record<string, unknown>) => void;
};

function requireInternalAuth(req: Request, res: Response, next: NextFunction) {
  const botToken = process.env.BOT_TOKEN;
  if (!botToken) return res.status(500).json({ error: 'Not configured' });
  const provided = req.get('X-INTERNAL-KEY');
  if (!provided || !secureCompare(provided, botToken)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

export function registerInternalRouter(deps: InternalRouterDeps): Router {
  const {
    getUserEntitlement,
    importUrlForUser,
    DRAFTS_ITEM_LIMIT,
    recordMaintenanceExposure,
    trackEvent,
  } = deps;

  const internalRouter = Router();

  const internalImportLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many requests' },
    validate: false,
  });

  internalRouter.use(requireInternalAuth);

  internalRouter.post(
    '/import-url',
    internalImportLimiter,
    asyncHandler(async (req, res) => {
      const parsed = z.object({
        userId: z.string().min(1),
        url: z.string().min(1).max(2048),
        note: z.string().max(500).optional(),
        source: z.string().max(20).optional(),
      }).safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      // Validate URL
      try { validateUrl(parsed.data.url); } catch (err: any) {
        return res.status(400).json({ error: err.message || 'Invalid URL' });
      }

      // Credit gate: PRO unlimited; FREE gets a monthly quota + paid credits
      // (respect godMode for admin users). Same model as POST /tg/import-url.
      const user = await prisma.user.findUnique({ where: { id: parsed.data.userId }, select: { godMode: true } });
      const ent = await getUserEntitlement(parsed.data.userId, user?.godMode ?? false);
      const allowance = await getImportAllowance(parsed.data.userId, ent.isPro);
      if (!allowance.allowed) {
        trackEvent('feature_gate_hit_url_import', parsed.data.userId);
        trackAnalyticsEvent({
          event: 'import.credit_pack_suggested',
          userId: parsed.data.userId,
          props: { source: 'bot', freeLimit: allowance.freeLimit, paidCredits: allowance.paidCredits },
        });
        return res.status(402).json({
          error: 'import_quota_exhausted',
          feature: 'url_import',
          freeLimit: allowance.freeLimit,
          freeUsed: allowance.freeUsed,
          paidCredits: allowance.paidCredits,
        });
      }

      try {
        const result = await importUrlForUser(parsed.data.userId, parsed.data.url, parsed.data.note, parsed.data.source || 'bot');
        // Decrement on a real import (ok/partial); failed parse and PRO skip.
        if (!ent.isPro && (result.parseStatus === 'ok' || result.parseStatus === 'partial')) {
          await consumeImportCredit(parsed.data.userId, { source: 'bot' });
        }
        return res.status(201).json(result);
      } catch (err: any) {
        if (err.statusCode === 402) {
          return res.status(402).json({ error: 'Drafts limit reached', limit: DRAFTS_ITEM_LIMIT });
        }
        throw err;
      }
    }),
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // ─── Support ticket lookup (internal, for incident investigation) ────────────

  internalRouter.get(
    '/support/tickets/:ticketCode',
    asyncHandler(async (req, res) => {
      const { ticketCode } = req.params;
      const ticket = await prisma.supportTicket.findUnique({
        where: { ticketCode: ticketCode!.toUpperCase() },
        include: {
          messages: { orderBy: { createdAt: 'asc' }, select: {
            id: true, authorRole: true, kind: true, text: true, caption: true,
            telegramUserMsgId: true, telegramSupportMsgId: true, createdAt: true,
          }},
          user: { select: {
            id: true, telegramId: true, telegramChatId: true, firstName: true,
            godMode: true, createdAt: true, updatedAt: true,
            profile: { select: {
              displayName: true, username: true, defaultCurrency: true,
              profileVisibility: true, birthday: true,
            }},
          }},
        },
      });
      if (!ticket) return res.status(404).json({ error: 'Ticket not found' });

      // Recent context for incident investigation
      const userId = ticket.user.id;
      const [wishlistsCount, activeReservations, subscription, lastItem] = await Promise.all([
        prisma.wishlist.count({ where: { ownerId: userId, type: 'REGULAR' } }),
        prisma.item.count({ where: { reserverUserId: userId, status: 'RESERVED' } }),
        prisma.subscription.findFirst({ where: { userId, status: { not: 'CANCELLED' } }, orderBy: { createdAt: 'desc' }, select: { status: true, planCode: true, currentPeriodEnd: true } }),
        prisma.item.findFirst({ where: { wishlist: { ownerId: userId } }, orderBy: { updatedAt: 'desc' }, select: { updatedAt: true } }),
      ]);

      return res.json({
        ticket: {
          id: ticket.id, ticketCode: ticket.ticketCode, status: ticket.status,
          openedVia: ticket.openedVia, supportChatId: ticket.supportChatId,
          createdAt: ticket.createdAt, updatedAt: ticket.updatedAt, closedAt: ticket.closedAt,
        },
        user: { ...ticket.user, profile: ticket.user.profile ?? null },
        messages: ticket.messages,
        recentContext: {
          wishlistsCount,
          activeReservationsCount: activeReservations,
          subscriptionStatus: subscription?.status ?? 'NONE',
          currentPlan: subscription?.planCode ?? 'FREE',
          subscriptionEnd: subscription?.currentPeriodEnd ?? null,
          lastActivityAt: lastItem?.updatedAt ?? null,
        },
      });
    }),
  );

  // ─── Maintenance recovery endpoints (internal) ──────────────────────────────

  // GET /internal/maintenance/active-incident — is there an unresolved incident?
  internalRouter.get(
    '/maintenance/active-incident',
    asyncHandler(async (_req, res) => {
      const incident = await prisma.maintenanceIncident.findFirst({
        where: { status: { in: ['active', 'recovering'] } },
        orderBy: { startedAt: 'desc' },
      });
      if (!incident) return res.json({ active: false });
      return res.json({
        active: true,
        incidentId: incident.id,
        status: incident.status,
        startedAt: incident.startedAt,
        lastMaintenanceSignalAt: incident.lastMaintenanceSignalAt,
        exposureCount: incident.exposureCount,
      });
    }),
  );

  // POST /internal/maintenance/exposure — record exposure from bot side
  internalRouter.post(
    '/maintenance/exposure',
    asyncHandler(async (req, res) => {
      const parsed = z.object({
        telegramId: z.string().min(1),
        surface: z.enum(['bot', 'miniapp']).default('bot'),
        locale: z.string().max(10).default('ru'),
        telegramChatId: z.string().optional(),
      }).safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      const { telegramId, surface, locale, telegramChatId } = parsed.data;

      // Look up user by telegramId
      const user = await prisma.user.findUnique({ where: { telegramId } });
      if (!user) return res.status(404).json({ error: 'User not found' });

      const chatId = telegramChatId ?? user.telegramChatId ?? null;
      const incidentId = await recordMaintenanceExposure(user.id, surface, locale, chatId);
      return res.json({ ok: true, incidentId });
    }),
  );

  // POST /internal/maintenance/check-recovery — check if 15-min stability window passed
  internalRouter.post(
    '/maintenance/check-recovery',
    asyncHandler(async (_req, res) => {
      const maintenanceOn = (process.env.MAINTENANCE_MODE ?? '').toLowerCase() === 'true';
      if (maintenanceOn) {
        return res.json({ recovered: false, reason: 'maintenance_mode_active' });
      }

      const incident = await prisma.maintenanceIncident.findFirst({
        where: { status: { in: ['active', 'recovering'] } },
        orderBy: { startedAt: 'desc' },
      });
      if (!incident) return res.json({ recovered: false, reason: 'no_active_incident' });

      const STABILITY_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
      const msSinceLastSignal = Date.now() - incident.lastMaintenanceSignalAt.getTime();

      if (msSinceLastSignal < STABILITY_WINDOW_MS) {
        // Not yet stable — move to recovering state
        if (incident.status !== 'recovering') {
          await prisma.maintenanceIncident.update({
            where: { id: incident.id },
            data: { status: 'recovering' },
          });
        }
        return res.json({
          recovered: false,
          reason: 'stability_window_in_progress',
          incidentId: incident.id,
          elapsedMinutes: Math.round(msSinceLastSignal / 60000),
          remainingMinutes: Math.ceil((STABILITY_WINDOW_MS - msSinceLastSignal) / 60000),
        });
      }

      // 15 minutes stable — mark recovered
      const now = new Date();
      await prisma.maintenanceIncident.update({
        where: { id: incident.id },
        data: { status: 'recovered', endedAt: now, recoveryConfirmedAt: now },
      });

      trackEvent('maintenance_recovery_confirmed', 'system', {
        incidentId: incident.id,
        recoveryConfirmedAt: now.toISOString(),
      });

      return res.json({ recovered: true, incidentId: incident.id });
    }),
  );

  // POST /internal/maintenance/mark-return — mark user as returned after recovery
  internalRouter.post(
    '/maintenance/mark-return',
    asyncHandler(async (req, res) => {
      const parsed = z.object({
        userId: z.string().min(1),
        surface: z.enum(['bot', 'miniapp']).default('miniapp'),
      }).safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      const { userId, surface } = parsed.data;

      // Find the most recently recovered incident with unreturned exposure for this user
      const exposure = await prisma.maintenanceExposure.findFirst({
        where: {
          userId,
          surface,
          returnedAt: null,
          incident: { status: 'recovered', recoveryConfirmedAt: { not: null } },
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!exposure) return res.json({ marked: false });

      await prisma.maintenanceExposure.update({
        where: { id: exposure.id },
        data: { returnedAt: new Date() },
      });

      const wasNotified = !!exposure.notifiedAt;
      trackEvent(wasNotified ? 'maintenance_returned_after_notice' : 'maintenance_returned_without_notice', userId, {
        incidentId: exposure.incidentId,
        ...(wasNotified && exposure.notifiedAt ? { timeFromNoticeSec: Math.round((Date.now() - exposure.notifiedAt.getTime()) / 1000) } : {}),
      });

      return res.json({ marked: true, incidentId: exposure.incidentId, wasNotified });
    }),
  );

  // POST /internal/maintenance/send-recovery-notifications — send recovery messages
  internalRouter.post(
    '/maintenance/send-recovery-notifications',
    asyncHandler(async (_req, res) => {
      // Find the most recently recovered incident that still has unsent notifications
      const incident = await prisma.maintenanceIncident.findFirst({
        where: { status: 'recovered', recoveryConfirmedAt: { not: null } },
        orderBy: { recoveryConfirmedAt: 'desc' },
      });
      if (!incident) return res.json({ sent: 0, reason: 'no_recovered_incident' });

      // Get exposures that: haven't been notified AND haven't self-returned
      const exposures = await prisma.maintenanceExposure.findMany({
        where: {
          incidentId: incident.id,
          notifiedAt: null,
          returnedAt: null,
        },
        include: {
          user: {
            select: {
              telegramChatId: true,
              telegramId: true,
              profile: { select: { languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } },
            },
          },
        },
      });

      if (exposures.length === 0) return res.json({ sent: 0, reason: 'all_notified_or_returned' });

      const miniAppUrl = process.env.MINI_APP_URL ?? (process.env.WEB_ORIGIN ? `${process.env.WEB_ORIGIN}/miniapp` : 'https://wishlistik.ru/miniapp');
      let sentCount = 0;
      let failCount = 0;
      const BATCH_SIZE = 25;

      for (let i = 0; i < exposures.length; i += BATCH_SIZE) {
        const batch = exposures.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
          batch.map(async (exp) => {
            const chatId = exp.telegramChatId ?? exp.user.telegramChatId;
            if (!chatId) {
              failCount++;
              trackEvent('maintenance_recovery_notice_failed', exp.userId, { incidentId: incident.id, reason: 'no_chat_id' });
              return;
            }

            // Locale priority: user's current preference (resolver chain
            // through their profile) → snapshot from `MaintenanceExposure.locale`
            // (captured at incident time) → 'en' default. Current preference
            // wins because the user may have changed language since the
            // incident, and recovery message UX is "right now" not "at
            // incident time". Snapshot is a fallback for cold-start users
            // whose profile resolves to default_en.
            const { locale: resolved, source: localeSource } = resolveLocaleWithSource(
              profileToLanguageSettings(exp.user.profile),
            );
            const locale = localeSource === 'default_en' && exp.locale && isSupportedLocale(exp.locale)
              ? exp.locale
              : resolved;
            const text = t('maintenance_recovery_text', locale);
            const btnLabel = t('maintenance_recovery_btn', locale);

            const ok = await sendTgBotMessage(chatId, text, {
              inline_keyboard: [[{ text: btnLabel, web_app: { url: miniAppUrl } }]],
            });

            if (ok) {
              await prisma.maintenanceExposure.update({
                where: { id: exp.id },
                data: { notifiedAt: new Date() },
              });
              sentCount++;
              trackEvent('maintenance_recovery_notice_sent', exp.userId, {
                incidentId: incident.id, surface: exp.surface,
              });
            } else {
              failCount++;
              trackEvent('maintenance_recovery_notice_failed', exp.userId, {
                incidentId: incident.id, reason: 'send_failed',
              });
            }
          }),
        );

        // Telegram rate limit: pause 1s between batches
        if (i + BATCH_SIZE < exposures.length) {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      // Update incident counters
      await prisma.maintenanceIncident.update({
        where: { id: incident.id },
        data: { notificationsSent: { increment: sentCount } },
      }).catch(() => {});

      const summary = `🔔 Recovery notifications: ${sentCount} sent, ${failCount} failed out of ${exposures.length} eligible (incident ${incident.id})`;
      void sendAdminAlert(summary);
      logger.info({ incidentId: incident.id, sentCount, failCount }, 'maintenance recovery notifications sent');

      return res.json({ sent: sentCount, failed: failCount, total: exposures.length, incidentId: incident.id });
    }),
  );

  return internalRouter;
}
