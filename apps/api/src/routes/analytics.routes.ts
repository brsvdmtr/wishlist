// Telegram-auth router for POST /tg/analytics/attribution (1 handler).
// Mounted via `tgRouter.use(analyticsRouter)` in apps/api/src/index.ts.
//
// First-touch source attribution — atomically sets
// firstAcquisitionSource/Medium/Campaign/Ref/At on UserProfile only when
// firstAcquisitionSource IS NULL. Never overwrites. Returns
// { attributed: boolean }.

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

export type AnalyticsRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<{ id: string }>;
};

export function registerAnalyticsRouter(deps: AnalyticsRouterDeps): Router {
  const { getOrCreateTgUser } = deps;

  const analyticsRouter = Router();

  // POST /tg/analytics/attribution — First-touch source attribution.
  // Records firstAcquisitionSource/Medium/Campaign/Ref/At on UserProfile.
  // First-touch only: atomically sets fields only when firstAcquisitionSource IS NULL — never overwrites.
  // Returns { attributed: boolean } — true if this was the first (winning) attribution call.
  analyticsRouter.post('/analytics/attribution', asyncHandler(async (req, res) => {
    const user = await getOrCreateTgUser(req.tgUser!);
  
    const raw = req.body as Record<string, unknown>;
  
    // Sanitize: allow only alphanumeric, underscore, hyphen; truncate to 64 chars
    const sanitize = (val: unknown, maxLen = 64): string | null => {
      if (typeof val !== 'string' || !val.trim()) return null;
      const clean = val.replace(/[^a-z0-9_\-]/gi, '_').slice(0, maxLen);
      return clean || null;
    };
  
    const source = sanitize(raw.source);
    if (!source) return res.status(400).json({ error: 'source is required and must be a non-empty string' });
  
    const updated = await prisma.userProfile.updateMany({
      where: { userId: user.id, firstAcquisitionSource: null },
      data: {
        firstAcquisitionSource: source,
        firstAcquisitionMedium: sanitize(raw.medium),
        firstAcquisitionCampaign: sanitize(raw.campaign),
        firstAcquisitionRef: sanitize(raw.ref),
        firstAcquisitionAt: new Date(),
      },
    });
  
    return res.json({ attributed: updated.count > 0 });
  }));

  return analyticsRouter;
}
