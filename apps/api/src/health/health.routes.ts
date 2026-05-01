// Health endpoints — no auth, no maintenance gate.
//
//   GET /health        Lightweight liveness probe. Reports MAINTENANCE_MODE
//                      (so an external monitor can distinguish "down" from
//                      "deliberately offline") and the deployed release tag.
//   GET /health/deep   Readiness probe. Verifies DB connectivity and that the
//                      bot heartbeat is recent (<= 120 s). Returns 503 with
//                      details if anything is degraded.
//
// Both routes preserve the original handler logic byte-for-byte. The shared
// helper now lives in ../lib/asyncHandler.

import type { Express } from 'express';
import { prisma } from '@wishlist/db';
import { asyncHandler } from '../lib/asyncHandler';

export function registerHealthRoutes(app: Express): void {
  app.get('/health', (_req, res) => {
    const maintenance = (process.env.MAINTENANCE_MODE ?? '').toLowerCase() === 'true';
    res.json({ ok: !maintenance, maintenance, release: process.env.APP_RELEASE ?? 'unknown' });
  });

  app.get('/health/deep', asyncHandler(async (_req, res) => {
    const checks: Record<string, unknown> = {};
    let ok = true;

    // DB check
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.db = 'ok';
    } catch (err) {
      checks.db = { error: String(err) };
      ok = false;
    }

    // Bot heartbeat check (stale if > 120 s)
    try {
      const hb = await prisma.serviceHeartbeat.findUnique({ where: { serviceName: 'bot' } });
      if (!hb) {
        checks.bot = 'no_heartbeat';
        ok = false;
      } else {
        const ageSec = (Date.now() - hb.updatedAt.getTime()) / 1000;
        if (ageSec > 120) {
          checks.bot = { stale: true, ageSec: Math.round(ageSec) };
          ok = false;
        } else {
          checks.bot = { ok: true, ageSec: Math.round(ageSec) };
        }
      }
    } catch (err) {
      checks.bot = { error: String(err) };
      ok = false;
    }

    checks.version = process.env.npm_package_version ?? 'unknown';

    return res.status(ok ? 200 : 503).json({ ok, checks });
  }));
}
