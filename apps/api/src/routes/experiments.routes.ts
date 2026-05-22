// Experiment infrastructure — 1 endpoint under /tg/experiments/*.
//
// Mounted via `tgRouter.use(experimentsRouter)` in apps/api/src/index.ts,
// behind the global requireTelegramAuth, so `req.tgUser!` is safe to deref.
//
// GET /tg/experiments/:key is the Mini App side of the `useExperiment` hook:
// it returns the caller's sticky variant for one experiment. The handler is
// deliberately thin — all bucketing, env-flag reading and persistence live in
// services/experiments.service.ts.

import { Router } from 'express';
import { asyncHandler } from '../lib/asyncHandler';
import { createRateLimiter } from '../security';
import {
  getExperimentAssignment,
  isValidExperimentKey,
  readExperimentConfig,
} from '../services/experiments.service';

type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

type ExperimentsRouterUser = { id: string };

export interface ExperimentsRouterDeps {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<ExperimentsRouterUser>;
}

export function registerExperimentsRouter(deps: ExperimentsRouterDeps): Router {
  const { getOrCreateTgUser } = deps;
  const router = Router();

  // ── GET /tg/experiments/:key ─────────────────────────────────────────
  // Resolve this user's variant for one experiment. First exposure persists
  // the assignment and emits `experiment.assigned`; later calls are sticky.
  // Behind the gentle `research.read` limiter — the assignment write is an
  // idempotent first-exposure insert, not a user-driven mutation.
  router.get(
    '/experiments/:key',
    createRateLimiter('research.read'),
    asyncHandler(async (req, res) => {
      const key = req.params.key ?? '';
      if (!isValidExperimentKey(key)) {
        return res.status(400).json({ error: 'INVALID_EXPERIMENT_KEY' });
      }
      const user = await getOrCreateTgUser(req.tgUser!);
      const result = await getExperimentAssignment(user.id, key, readExperimentConfig(key));
      return res.json(result);
    }),
  );

  return router;
}
