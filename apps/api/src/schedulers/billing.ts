// Billing / promo / degradation schedulers (P5r-2) — extracted from
// apps/api/src/index.ts. Four independent hourly setInterval jobs that
// expire subscriptions, expire promo redemptions (and start grace period
// for users who lost PRO), archive over-limit data after grace ends, and
// finally purge archived data after the 90-day archive window. All
// cadences (60 * 60 * 1000 ms), log messages, structured fields, and
// error-handling semantics are preserved byte-identical.
//
//   1. subscription expiry — flips ACTIVE/CANCELLED Subscriptions whose
//      currentPeriodEnd has passed → EXPIRED.
//   2. promo redemption expiry — flips ACTIVE PromoRedemptions whose
//      expiresAt has passed → EXPIRED, then for each EXPIRED redemption
//      in the last 2h, starts a GRACE_PERIOD on DegradationState if the
//      user has no other active paid sub.
//   3. degradation grace — for DegradationStates whose graceEndsAt has
//      passed: re-check entitlement (PRO regained = phase=NONE), else
//      archive newest wishlists beyond FREE.wishlists + newest items
//      beyond FREE.items per remaining wishlist; advance phase=ARCHIVED
//      with purgeScheduledAt = now+90d.
//   4. degradation purge — for ARCHIVED DegradationStates past their
//      purgeScheduledAt: PRO regained = restore archived data + phase=
//      NONE; else permanently delete archived wishlists/items + phase=
//      PURGED.
//
// All four jobs are best-effort: errors are logged but never bubble out
// of the setInterval callback; the next hourly cycle re-attempts work.
//
// Deps:
//   - prisma — direct DB access for all 4 jobs (subscription, promo,
//     degradationState, wishlist, item).
//   - logger — structured logs for ops/dashboards.
//   - getUserEntitlement — used by jobs 3 + 4 to check `ent.isPro`
//     (entitlement re-resolution: user may have regained PRO since
//     grace was started).
//   - PLANS — used by job 3 to read FREE.wishlists / FREE.items
//     thresholds for archive-overflow logic.

import type { PrismaClient } from '@wishlist/db';
import type { Logger } from 'pino';
import { LIFETIME_BILLING_PERIOD } from '@wishlist/shared';

// Minimal structural type for getUserEntitlement — handlers in this file
// only access `.isPro`. Mirrors index.ts:533 return type narrowed.
type BillingSchedulerEntitlement = { isPro: boolean };

// Minimal structural type for PLANS — schedulers only read FREE thresholds.
type BillingSchedulerPlans = {
  FREE: { wishlists: number; items: number };
};

export type BillingSchedulerDeps = {
  prisma: PrismaClient;
  logger: Logger;
  getUserEntitlement: (userId: string, godMode?: boolean) => Promise<BillingSchedulerEntitlement>;
  PLANS: BillingSchedulerPlans;
};

export function startBillingSchedulers(deps: BillingSchedulerDeps): void {
  const { prisma, logger, getUserEntitlement, PLANS } = deps;

  // Subscription expiry: mark overdue subscriptions as EXPIRED (hourly).
  // Lifetime subscriptions are explicitly excluded — they have a 2099 sentinel
  // currentPeriodEnd (so they would never match anyway), but the explicit
  // billingPeriod !== 'lifetime' guard makes the contract obvious and survives
  // any future tweak to the sentinel date.
  setInterval(async () => {
    try {
      const expired = await prisma.subscription.updateMany({
        where: {
          status: { in: ['ACTIVE', 'CANCELLED'] },
          currentPeriodEnd: { lte: new Date() },
          NOT: { billingPeriod: LIFETIME_BILLING_PERIOD },
        },
        data: { status: 'EXPIRED' },
      });
      if (expired.count > 0) {
        logger.info({ count: expired.count }, 'billing: expired subscriptions');
      }
    } catch (err) {
      logger.error({ err }, 'billing expiry check failed');
    }
  }, 60 * 60 * 1000);

  // Promo expiry: mark ACTIVE promo redemptions past their expiresAt as EXPIRED (hourly)
  setInterval(async () => {
    try {
      const expired = await prisma.promoRedemption.updateMany({
        where: { status: 'ACTIVE', expiresAt: { lte: new Date() } },
        data: { status: 'EXPIRED' },
      });
      if (expired.count > 0) {
        logger.info({ count: expired.count }, 'promo: expired promo redemptions');
        // Start grace period for users who lost PRO (no paid sub either)
        const expiredRedemptions = await prisma.promoRedemption.findMany({
          where: { status: 'EXPIRED', expiresAt: { lte: new Date(), gte: new Date(Date.now() - 2 * 60 * 60 * 1000) } },
          select: { userId: true },
        });
        for (const r of expiredRedemptions) {
          // Only start degradation if user has no active paid sub
          const sub = await prisma.subscription.findFirst({
            where: { userId: r.userId, status: { in: ['ACTIVE', 'CANCELLED'] }, currentPeriodEnd: { gt: new Date() } },
          });
          if (!sub) {
            await prisma.degradationState.upsert({
              where: { userId: r.userId },
              update: {},  // don't overwrite existing degradation
              create: {
                userId: r.userId,
                phase: 'GRACE_PERIOD',
                graceEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
              },
            });
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'promo expiry check failed');
    }
  }, 60 * 60 * 1000);

  // Degradation: archive over-limit data after grace period ends (hourly)
  setInterval(async () => {
    try {
      const graceExpired = await prisma.degradationState.findMany({
        where: { phase: 'GRACE_PERIOD', graceEndsAt: { lte: new Date() } },
        include: { user: { select: { id: true } } },
      });
      for (const ds of graceExpired) {
        const userId = ds.userId;
        // Check if user regained PRO
        const ent = await getUserEntitlement(userId);
        if (ent.isPro) {
          await prisma.degradationState.update({ where: { id: ds.id }, data: { phase: 'NONE' } });
          continue;
        }
        // Archive newest wishlists beyond FREE limit
        const wishlists = await prisma.wishlist.findMany({
          where: { ownerId: userId, type: 'REGULAR', archivedAt: null },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        });
        const overLimitWls = wishlists.slice(PLANS.FREE.wishlists);
        const archivedWlIds: string[] = [];
        const archivedItemIds: string[] = [];
        if (overLimitWls.length > 0) {
          for (const wl of overLimitWls) {
            await prisma.wishlist.update({ where: { id: wl.id }, data: { archivedAt: new Date() } });
            archivedWlIds.push(wl.id);
          }
        }
        // Archive newest items beyond FREE limit in remaining wishlists
        const remainingWls = wishlists.slice(0, PLANS.FREE.wishlists);
        for (const wl of remainingWls) {
          const items = await prisma.item.findMany({
            where: { wishlistId: wl.id, status: { in: ['AVAILABLE', 'RESERVED'] }, archivedAt: null },
            orderBy: { createdAt: 'asc' },
            select: { id: true },
          });
          const overLimitItems = items.slice(PLANS.FREE.items);
          for (const it of overLimitItems) {
            await prisma.item.update({ where: { id: it.id }, data: { archivedAt: new Date() } });
            archivedItemIds.push(it.id);
          }
        }
        await prisma.degradationState.update({
          where: { id: ds.id },
          data: {
            phase: (archivedWlIds.length > 0 || archivedItemIds.length > 0) ? 'ARCHIVED' : 'NONE',
            archivedAt: new Date(),
            purgeScheduledAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
            archivedWishlistIds: JSON.stringify(archivedWlIds),
            archivedItemIds: JSON.stringify(archivedItemIds),
          },
        });
        if (archivedWlIds.length > 0 || archivedItemIds.length > 0) {
          logger.info({ wishlists: archivedWlIds.length, items: archivedItemIds.length, userId }, 'degradation: archived data');
        }
      }
    } catch (err) {
      logger.error({ err }, 'degradation archive job failed');
    }
  }, 60 * 60 * 1000);

  // Degradation: purge archived data after 90 days (hourly)
  setInterval(async () => {
    try {
      const toPurge = await prisma.degradationState.findMany({
        where: { phase: 'ARCHIVED', purgeScheduledAt: { lte: new Date() } },
      });
      for (const ds of toPurge) {
        // Check if user regained PRO
        const ent = await getUserEntitlement(ds.userId);
        if (ent.isPro) {
          // Restore archived data
          const wlIds: string[] = JSON.parse(ds.archivedWishlistIds || '[]');
          const itemIds: string[] = JSON.parse(ds.archivedItemIds || '[]');
          if (wlIds.length) await prisma.wishlist.updateMany({ where: { id: { in: wlIds } }, data: { archivedAt: null } });
          if (itemIds.length) await prisma.item.updateMany({ where: { id: { in: itemIds } }, data: { archivedAt: null } });
          await prisma.degradationState.update({ where: { id: ds.id }, data: { phase: 'NONE' } });
          continue;
        }
        // Purge: delete archived wishlists and items permanently
        const wlIds: string[] = JSON.parse(ds.archivedWishlistIds || '[]');
        const itemIds: string[] = JSON.parse(ds.archivedItemIds || '[]');
        if (itemIds.length) await prisma.item.deleteMany({ where: { id: { in: itemIds } } });
        if (wlIds.length) await prisma.wishlist.deleteMany({ where: { id: { in: wlIds } } });
        await prisma.degradationState.update({ where: { id: ds.id }, data: { phase: 'PURGED' } });
        logger.info({ wishlists: wlIds.length, items: itemIds.length, userId: ds.userId }, 'degradation: purged data');
      }
    } catch (err) {
      logger.error({ err }, 'degradation purge job failed');
    }
  }, 60 * 60 * 1000);
}
