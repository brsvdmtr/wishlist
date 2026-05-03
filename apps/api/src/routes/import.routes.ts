// Telegram-auth router for POST /tg/import-url (1 handler).
// Mounted via `tgRouter.use(importRouter)` in apps/api/src/index.ts.
//
// PRO-only feature: imports an item draft from a third-party URL via
// importUrlForUser (shared with internal.routes /internal/import-url).
// The runtime function lives in index.ts so internal.routes and this
// router share the same closure; the dep type here is structurally
// wider than internal's because the Mini App passes a 5th arg
// (`{ noCache: true }`) which the bot caller doesn't.
//
// importUrlLimiter (rate-limit, 10/min/user) is import-only — verified
// by grep — and migrates with this file at module scope.

import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { t } from '@wishlist/shared';

import { asyncHandler } from '../lib/asyncHandler';
import { zodError } from '../lib/http';
import { getRequestLocale } from '../lib/locale';
import { validateUrl } from '../url-parser.js';

type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type ImportRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<{ id: string }>;
  // Narrow structural shape — only `.plan.code` and `.plan.features` are read.
  getUserEntitlement: (userId: string, godMode?: boolean) => Promise<{ plan: { code: string; features: readonly string[] } }>;
  trackEvent: (event: string, userId?: string, props?: Record<string, unknown>) => void;
  trackAnalyticsEvent: (params: { event: string; userId?: string; props?: Record<string, unknown> }) => void;
  // 5-arg signature — Mini App passes opts; internal.routes only uses 4 args.
  // Wide return — handler reads `.item.title`, `.item.price`.
  importUrlForUser: (
    userId: string,
    url: string,
    note?: string,
    source?: string,
    opts?: { noCache?: boolean },
  ) => Promise<{ item: { price?: unknown; title?: string }; [key: string]: unknown }>;
  DRAFTS_ITEM_LIMIT: number;
};

// ─── Import URL: TG endpoint ────────────────────────────────────────────────

const importUrlLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => req.tgUser ? String(req.tgUser.id) : 'anon',
  handler: (_req: Request, res: Response) => {
    const locale = getRequestLocale(_req);
    res.status(429).json({ error: t('api_import_rate_limit', locale) });
  },
  validate: false,
});

export function registerImportRouter(deps: ImportRouterDeps): Router {
  const {
    getOrCreateTgUser,
    getUserEntitlement,
    trackEvent,
    trackAnalyticsEvent,
    importUrlForUser,
    DRAFTS_ITEM_LIMIT,
  } = deps;

  const importRouter = Router();

  importRouter.post(
    '/import-url',
    importUrlLimiter,
    asyncHandler(async (req, res) => {
      const parsed = z.object({
        url: z.string().min(1).max(2048),
        note: z.string().max(500).optional(),
        source: z.string().max(20).optional(),
      }).safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);
  
      // Validate URL first
      try { validateUrl(parsed.data.url); } catch (err: any) {
        return res.status(400).json({ error: err.message || 'Invalid URL' });
      }
  
      const user = await getOrCreateTgUser(req.tgUser!);
  
      // Feature gate: import by URL requires PRO
      const ent = await getUserEntitlement(user.id);
      if (!ent.plan.features.includes('url_import')) {
        trackEvent('feature_gate_hit_url_import', user.id);
        return res.status(402).json({ error: 'Pro feature', feature: 'url_import', planCode: ent.plan.code });
      }
  
      let importDomain = '';
      try { importDomain = new URL(parsed.data.url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
  
      trackAnalyticsEvent({
        event: 'import.started',
        userId: user.id,
        props: { domain: importDomain },
      });
  
      try {
        const noCache = req.headers['x-parse-no-cache'] === '1';
        const result = await importUrlForUser(user.id, parsed.data.url, parsed.data.note, parsed.data.source || 'miniapp', noCache ? { noCache: true } : undefined);
  
        trackAnalyticsEvent({
          event: 'import.succeeded',
          userId: user.id,
          props: { domain: importDomain, hasPrice: !!result.item.price, hasTitle: !!result.item.title },
        });
  
        return res.status(201).json(result);
      } catch (err: any) {
        trackAnalyticsEvent({
          event: 'import.failed',
          userId: user.id,
          props: { domain: importDomain, reason: String(err.message ?? 'unknown').slice(0, 200) },
        });
  
        if (err.statusCode === 402) {
          return res.status(402).json({ error: t('api_import_too_many', getRequestLocale(req)), limit: DRAFTS_ITEM_LIMIT });
        }
        throw err;
      }
    }),
  );

  return importRouter;
}
