// Notification preferences — P0.3 «Событийные пуши».
//
// Read + patch the user's circle event-push preferences (per-type toggles,
// quiet hours, timezone). FREE for everyone — these pushes are a retention
// driver, not a Pro feature, so there is no entitlement gate here. Thin
// handlers: validate, call services/event-notifications.ts, shape the response.
// State + validation live in the service. Per-circle mute is circle-scoped and
// lives in circles.routes.ts (`PUT /tg/circles/:id/mute`).

import { Router } from 'express';

import { asyncHandler } from '../lib/asyncHandler';
import {
  getNotificationPreferences,
  updateNotificationPreferences,
  type NotificationPreferences,
} from '../services/event-notifications';

type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type NotificationPreferencesRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<{ id: string }>;
};

export function registerNotificationPreferencesRouter(deps: NotificationPreferencesRouterDeps): Router {
  const { getOrCreateTgUser } = deps;
  const router = Router();

  // GET /tg/notification-preferences — current preferences (defaults if no row).
  router.get(
    '/notification-preferences',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);
      const preferences = await getNotificationPreferences(user.id);
      res.json({ preferences });
    }),
  );

  // PATCH /tg/notification-preferences — partial update (toggles / quiet hours).
  router.patch(
    '/notification-preferences',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);
      const body = (req.body ?? {}) as Partial<NotificationPreferences>;
      try {
        const preferences = await updateNotificationPreferences(user.id, body);
        res.json({ preferences });
      } catch (e) {
        if (e instanceof Error && (e.message === 'invalid_time' || e.message === 'invalid_timezone')) {
          return res.status(400).json({ error: e.message });
        }
        throw e;
      }
    }),
  );

  return router;
}
