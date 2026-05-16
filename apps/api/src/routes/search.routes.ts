// Telegram-auth router for /tg/search and /tg/access/wishlist-opened.
//
// Same factory pattern as the other extracted routers. Mounted via
// `tgRouter.use(searchRouter)` in apps/api/src/index.ts. The parent tgRouter
// auth/locale/rate-limit chain already runs before any handler here. The
// `search` and `access.record` categories live in security/rateLimits.ts.
//
// Endpoints:
//   - GET  /tg/search                  — read-only global search (no idempotency)
//   - POST /tg/access/wishlist-opened  — fire-and-forget FWA recorder
//
// Privacy notes (enforced by services/search.ts, mirrored here for review):
//   - Raw query is never logged. Analytics gets `normalizedQuery.length` and
//     a SHA-1 hash of the normalized query so god-mode debugging can still
//     correlate without leaking content.
//   - Secret reservations are only ever surfaced to their own creator.
//   - Free users get a `pro_locked` aggregate when PRO-only types match;
//     titles/owners never leak.

import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';

import { asyncHandler } from '../lib/asyncHandler';
import { zodError } from '../lib/http';
import { getRequestLocale } from '../lib/locale';
import { createRateLimiter } from '../security';
import {
  performGlobalSearch,
  SEARCH_MAX_QUERY,
  type SearchResultType,
} from '../services/search';
import {
  recordForeignWishlistAccess,
  isValidForeignWishlistAccessSource,
} from '../services/foreign-wishlist-access';

const ALL_TYPES = [
  'item',
  'wishlist',
  'category',
  'reservation',
  'user',
  'event',
  'setting',
  'anti_gift',
  'faq',
  'action',
] as const;

// Minimal structural shape of the User row we read here. Wider runtime
// payload from getOrCreateTgUser is fine.
type SearchRouterUser = {
  id: string;
  godMode: boolean;
};

type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type SearchRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<SearchRouterUser>;
  trackAnalyticsEvent: (args: { event: string; userId?: string; props?: Record<string, unknown> }) => void;
};

export function registerSearchRouter(deps: SearchRouterDeps): Router {
  const { getOrCreateTgUser, trackAnalyticsEvent } = deps;
  const searchRouter = Router();

  const searchLimiter = createRateLimiter('search');
  const accessLimiter = createRateLimiter('access.record');

  // ─── GET /tg/search ───────────────────────────────────────────────────────
  searchRouter.get(
    '/search',
    searchLimiter,
    asyncHandler(async (req, res) => {
      const parsed = z
        .object({
          q: z.string().max(SEARCH_MAX_QUERY * 2).optional(),
          types: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(20).optional(),
        })
        .safeParse(req.query);
      if (!parsed.success) return zodError(res, parsed.error);

      const q = (parsed.data.q ?? '').slice(0, SEARCH_MAX_QUERY);
      const user = await getOrCreateTgUser(req.tgUser!);
      const locale = getRequestLocale(req);

      const typesParam = parsed.data.types?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
      const allowedTypes: SearchResultType[] = [];
      for (const t of typesParam) {
        if ((ALL_TYPES as readonly string[]).includes(t)) {
          allowedTypes.push(t as SearchResultType);
        }
      }

      const startedAt = Date.now();
      const response = await performGlobalSearch({
        userId: user.id,
        query: q,
        locale,
        types: allowedTypes.length > 0 ? allowedTypes : null,
        perGroupLimit: parsed.data.limit ?? undefined,
      });
      const latencyMs = Date.now() - startedAt;

      // Telemetry — privacy-safe. We log a one-way SHA-1 hash of the
      // normalized query, NEVER the query itself. queryLength + resultCount
      // are aggregate.
      const tgUserId = req.tgUser?.id != null ? String(req.tgUser.id) : undefined;
      const normalizedLen = response.normalizedQuery.length;
      const normalizedHash =
        normalizedLen >= 2
          ? crypto.createHash('sha1').update(response.normalizedQuery).digest('hex').slice(0, 12)
          : null;
      const resultCount = response.groups.reduce((acc, g) => acc + g.items.length, 0);
      const hasProResults = response.groups.some((g) => g.type === 'pro_locked');

      if (normalizedLen >= 2) {
        try {
          trackAnalyticsEvent({
            event: 'search.query_completed',
            userId: tgUserId,
            props: {
              queryLength: normalizedLen,
              normalizedQueryHash: normalizedHash,
              resultCount,
              resultTypes: response.groups.map((g) => g.type),
              latencyMs,
              hasProResults,
              isProUser: response.isPro,
              locale,
              partial: response.partial,
              failedGroups: response.failedGroups,
            },
          });
        } catch {
          // Analytics never blocks the read path.
        }
      }

      return res.json(response);
    }),
  );

  // ─── POST /tg/access/wishlist-opened ──────────────────────────────────────
  // Fire-and-forget access history recorder. The Mini App calls this once
  // when a foreign wishlist screen renders successfully.
  //
  // SECURITY INVARIANTS (DO NOT WEAKEN):
  //   - **Auth required.** Mounted on tgRouter which has requireTelegramAuth
  //     in the middleware chain (parent index.ts). Unauth callers get 401
  //     before they reach this handler.
  //   - **Server-resolved identity.** `userId` comes from
  //     `getOrCreateTgUser(req.tgUser!)`. The body schema does NOT accept a
  //     userId; any client-supplied identity is rejected by the zod schema.
  //   - **Server-side access check.** The recordForeignWishlistAccess helper
  //     does NOT trust the caller — it re-fetches the wishlist row and
  //     refuses to write if the user is the owner, the wishlist is
  //     archived / private / drafts, or LINK_ONLY without a shareToken.
  //   - **Server-side sourceRef hashing.** Raw shareToken passed in
  //     `sourceRef` is hashed with SHA-256 server-side. The hash is what
  //     ends up in the DB column.
  //
  // No idempotency middleware: the helper is upsert-keyed on (userId,
  // wishlistId). Duplicates safely refresh lastOpenedAt + source/sourceRef.
  searchRouter.post(
    '/access/wishlist-opened',
    accessLimiter,
    asyncHandler(async (req, res) => {
      const parsed = z
        .object({
          wishlistId: z.string().min(1).max(64),
          source: z.string().min(1).max(40).default('direct_open'),
          // share_link: raw shareToken (server hashes). curated_selection:
          // CuratedSelection.id. Capped at 256 chars defensively.
          sourceRef: z.string().min(1).max(256).optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);

      const user = await getOrCreateTgUser(req.tgUser!);
      const source = isValidForeignWishlistAccessSource(parsed.data.source)
        ? parsed.data.source
        : 'unknown';

      const outcome = await recordForeignWishlistAccess({
        userId: user.id,
        wishlistId: parsed.data.wishlistId,
        source,
        sourceRef: parsed.data.sourceRef ?? null,
      });

      // Always 200 — caller treats this as fire-and-forget. The outcome is
      // included for FE debugging only; the FE must not gate UX on it.
      return res.json({ ok: outcome.ok, reason: 'reason' in outcome ? outcome.reason : null });
    }),
  );

  return searchRouter;
}
