import { prisma } from '@wishlist/db';
import { logIdempotencyCleanup } from './securityEvents';
import logger from '../logger';

// In-process cleanup: deletes IdempotencyKey rows past `expiresAt`. Run hourly.
// Prefer this over an external cron because the API is a single-instance Docker
// container — no orchestration to set up, and the job dies cleanly with the
// process. If we ever shard the API, gate this behind a leader-election flag
// so only one replica deletes (Prisma deleteMany is safe under contention,
// just wasteful).

const ONE_HOUR_MS = 60 * 60 * 1000;

let started = false;
let intervalHandle: NodeJS.Timeout | null = null;

export function startIdempotencyCleanupJob(): void {
  if (started) return;
  // Belt-and-suspenders: a parallel kill switch and a test guard. Tests that
  // really need the job set CLEANUP_JOB_IN_TEST=true; everyone else gets
  // a quiet event loop.
  if (process.env.NODE_ENV === 'test' && process.env.CLEANUP_JOB_IN_TEST !== 'true') return;
  if ((process.env.SECURITY_CLEANUP_JOB_ENABLED ?? '').toLowerCase() === 'false') {
    logger.info({ event: 'api.idempotency_cleanup_disabled' }, 'idempotency cleanup job disabled by env');
    return;
  }
  started = true;
  // Run once a few seconds after boot so the API is healthy first; the
  // first sweep is cheap (table likely empty) but DB still has to be up.
  setTimeout(() => { void runOnce(); }, 30 * 1000).unref?.();
  intervalHandle = setInterval(() => { void runOnce(); }, ONE_HOUR_MS);
  intervalHandle.unref?.();
}

export function stopIdempotencyCleanupJob(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  started = false;
}

export async function runOnce(): Promise<void> {
  const startedAt = Date.now();
  try {
    const result = await prisma.idempotencyKey.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    logIdempotencyCleanup({
      deletedCount: result.count,
      durationMs: Date.now() - startedAt,
    });
  } catch (err) {
    logger.error(
      {
        event: 'api.idempotency_cleanup_failed',
        error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
        durationMs: Date.now() - startedAt,
      },
      'idempotency_cleanup_failed',
    );
  }
}
