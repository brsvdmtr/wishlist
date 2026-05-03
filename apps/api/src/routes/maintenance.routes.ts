// Telegram-auth router for POST /tg/maintenance-exposure and
// POST /tg/maintenance-return (2 handlers). Mounted via
// `tgRouter.use(maintenanceRouter)` in apps/api/src/index.ts.
//
// IMPORTANT: the global maintenance gate at app.use(['/tg', '/public'], ...)
// in index.ts allow-lists POST /maintenance-exposure during MAINTENANCE_MODE.
// That gate runs BEFORE tgRouter, so it sees req.path relative to the /tg
// mount — the exception still works after this extraction (req.path stays
// '/maintenance-exposure' regardless of which sub-router contains the
// handler).
//
// `recordMaintenanceExposure` is shared with internal.routes (POST
// /internal/maintenance/exposure), so it stays in index.ts and is passed
// here via `deps`.

import { Router } from 'express';
import { prisma } from '@wishlist/db';

import { asyncHandler } from '../lib/asyncHandler';

type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type MaintenanceRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<{ id: string; telegramChatId: string | null }>;
  trackEvent: (event: string, userId?: string, props?: Record<string, unknown>) => void;
  recordMaintenanceExposure: (userId: string, surface: string, locale: string, telegramChatId: string | null) => Promise<string>;
};

export function registerMaintenanceRouter(deps: MaintenanceRouterDeps): Router {
  const { getOrCreateTgUser, trackEvent, recordMaintenanceExposure } = deps;

  const maintenanceRouter = Router();

  // POST /tg/maintenance-exposure — record that the current user saw the maintenance screen.
  // This endpoint is exempted from the maintenance middleware so it works during outages.
  maintenanceRouter.post(
    '/maintenance-exposure',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);
      const locale = (req.body?.locale as string) || 'ru';
      const surface = (req.body?.surface as string) || 'miniapp';
      const incidentId = await recordMaintenanceExposure(
        user.id,
        surface,
        locale,
        user.telegramChatId ?? null,
      );
      return res.json({ ok: true, incidentId });
    }),
  );
  
  // POST /tg/maintenance-return — mark user as returned after recovery (lightweight, best-effort)
  maintenanceRouter.post(
    '/maintenance-return',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);
      const surface = (req.body?.surface as string) || 'miniapp';
  
      // Find the most recently recovered incident with unreturned exposure for this user
      const exposure = await prisma.maintenanceExposure.findFirst({
        where: {
          userId: user.id,
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
      trackEvent(wasNotified ? 'maintenance_returned_after_notice' : 'maintenance_returned_without_notice', user.id, {
        incidentId: exposure.incidentId,
        ...(wasNotified && exposure.notifiedAt ? { timeFromNoticeSec: Math.round((Date.now() - exposure.notifiedAt.getTime()) / 1000) } : {}),
      });
  
      return res.json({ marked: true });
    }),
  );

  return maintenanceRouter;
}
