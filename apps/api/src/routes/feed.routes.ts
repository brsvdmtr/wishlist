// Home feed (P0.2 — «Главная → лента близких») router.
//
// Mounted via `tgRouter.use(feedRouter)` in apps/api/src/index.ts. A single
// read-only endpoint; the aggregation + surprise invariant live in
// services/feed.service.ts (handler stays thin: read params, call service,
// shape response). No state transition → no idempotency / rate-limit category
// (those are for POST/PATCH/DELETE per docs/API_SECURITY.md).

import { Router } from 'express';

import { asyncHandler } from '../lib/asyncHandler';
import { getFeed } from '../services/feed.service';

type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type FeedRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<{ id: string }>;
};

export function registerFeedRouter(deps: FeedRouterDeps): Router {
  const { getOrCreateTgUser } = deps;
  const router = Router();

  // GET /tg/feed[?circleId=<id>] — ranked home feed scoped to the viewer's
  // circles. Optional circleId scopes content to one circle (the chip filter);
  // the returned `circles` list always covers all of the viewer's circles.
  router.get(
    '/feed',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);
      const circleIdRaw = req.query.circleId;
      const circleId = typeof circleIdRaw === 'string' && circleIdRaw.trim() ? circleIdRaw.trim() : null;
      const feed = await getFeed({ viewerId: user.id, circleId });
      res.json(feed);
    }),
  );

  return router;
}
