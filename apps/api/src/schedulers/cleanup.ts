// Cleanup schedulers (P5r-1) — extracted from apps/api/src/index.ts.
// Three independent hourly setInterval jobs that delete expired/abandoned
// rows. No helper coupling beyond direct imports (prisma + logger +
// deleteUploadFile). Cadence (60 * 60 * 1000 ms) and log messages are
// preserved byte-identical for ops continuity.
//
//   1. comments TTL — purge `Comment` rows past `scheduledDeleteAt`.
//   2. curated selection subscriptions cleanup — purge subscriptions when
//      the parent CuratedSelection has expired or been deactivated.
//   3. archive purge — hard-delete `Item` rows past their 90-day
//      `purgeAfter` window plus their associated upload files.
//
// All three jobs are best-effort: errors are logged but never bubble out
// of the setInterval callback; the next hourly cycle re-attempts work.

import type { PrismaClient } from '@wishlist/db';
import type { Logger } from 'pino';

export type CleanupSchedulerDeps = {
  prisma: PrismaClient;
  logger: Logger;
  deleteUploadFile: (imageUrl: string | null) => void;
};

export function startCleanupSchedulers(deps: CleanupSchedulerDeps): void {
  const { prisma, logger, deleteUploadFile } = deps;

  // TTL cleanup for expired comments (runs every hour)
  setInterval(async () => {
    try {
      const result = await prisma.comment.deleteMany({
        where: { scheduledDeleteAt: { lte: new Date() } },
      });
      if (result.count > 0) {
        logger.info({ count: result.count }, 'ttl: cleaned expired comments');
      }
    } catch (err) {
      logger.error({ err }, 'ttl cleanup failed');
    }
  }, 60 * 60 * 1000);

  // TTL cleanup for expired curated selections — delete subscriptions to expired/deactivated selections (hourly)
  setInterval(async () => {
    try {
      const result = await prisma.curatedSelectionSubscription.deleteMany({
        where: {
          curatedSelection: {
            OR: [
              { expiresAt: { lte: new Date() } },
              { deactivatedAt: { not: null } },
            ],
          },
        },
      });
      if (result.count > 0) {
        logger.info({ count: result.count }, 'ttl: cleaned subscriptions for expired/deactivated curated selections');
      }
    } catch (err) {
      logger.error({ err }, 'curated selection subscription ttl cleanup failed');
    }
  }, 60 * 60 * 1000);

  // Archive purge: hard-delete items past 90-day TTL + cleanup media files (hourly)
  setInterval(async () => {
    try {
      const expired = await prisma.item.findMany({
        where: { purgeAfter: { lte: new Date() } },
        select: { id: true, imageUrl: true },
        take: 100, // batch limit — rest picked up next hour
      });
      if (expired.length === 0) return;

      logger.info({ count: expired.length }, 'purge: found expired archive items');
      let deleted = 0, files = 0, errors = 0;

      for (const item of expired) {
        try {
          // DB first, files second — orphaned files are harmless, orphaned DB records with broken images are not
          await prisma.item.delete({ where: { id: item.id } });
          deleted++;
          if (item.imageUrl) {
            deleteUploadFile(item.imageUrl);
            files++;
          }
        } catch (err) {
          errors++;
          logger.error({ err, itemId: item.id }, 'purge: item deletion failed');
        }
      }

      logger.info({ deleted, files, errors }, 'purge: done');
    } catch (err) {
      logger.error({ err }, 'purge job failed');
    }
  }, 60 * 60 * 1000);
}
