// Santa schedulers + startup jobs (P5r-3) — extracted from
// apps/api/src/index.ts. Three hourly cron blocks (hint expiry, deadline
// missed, deadline warning) plus a hourly seasonal-events wrapper.
// Section 2.A helpers (getSeasonStartYear / getSantaSeasonInfo /
// sendSeasonalBroadcast / maybeRunSeasonalEvents / generateSantaAliases /
// SANTA_*) STAY in index.ts because they're consumed by santa.routes.ts
// via deps and by `runSantaStartupJobs` below — passing them as deps
// here keeps a single source-of-truth.
//
// Cadence (60 * 60 * 1000 ms), log labels, structured fields, and
// best-effort try/catch behavior preserved byte-identical.
//
// Startup jobs (called from app.listen):
//   1. SantaGlobalConfig singleton upsert (idempotent — preserves
//      existing santaEnabled value if already set, creates with
//      santaEnabled=true on a fresh DB).
//   2. Alias backfill loop — generates aliases for any DRAW_DONE rounds
//      that don't have aliases yet. Idempotent (skipDuplicates).
// Both are fire-and-forget (`void`) so they never delay the server boot.

import type { PrismaClient } from '@wishlist/db';
import type { Logger } from 'pino';

// Mirror of `generateSantaAliases` return shape from index.ts. Kept
// structural so we don't pull in the full Santa types.
type SantaAliasRecord = {
  participantId: string;
  alias: string;
  emoji: string;
  adjectiveKey: string;
  animalKey: string;
};

export type SantaSchedulerDeps = {
  prisma: PrismaClient;
  logger: Logger;
  maybeRunSeasonalEvents: () => Promise<void>;
};

export type SantaStartupDeps = {
  prisma: PrismaClient;
  logger: Logger;
  generateSantaAliases: (roundId: string, participantIds: string[]) => SantaAliasRecord[];
};

export function startSantaSchedulers(deps: SantaSchedulerDeps): void {
  const { prisma, logger, maybeRunSeasonalEvents } = deps;

  // Santa hint expiry: mark PENDING santa hint requests past their TTL as EXPIRED (hourly)
  setInterval(async () => {
    try {
      const expired = await prisma.santaHintRequest.updateMany({
        where: { status: 'PENDING', expiresAt: { lte: new Date() } },
        data: { status: 'EXPIRED' },
      });
      if (expired.count > 0) {
        logger.info({ count: expired.count }, 'santa-hints: expired hint requests');
      }
    } catch (err) {
      logger.error({ err }, 'santa-hints expiry check failed');
    }
  }, 60 * 60 * 1000);

  // Santa deadline enforcement: mark overdue PENDING/BUYING assignments as MISSED_DEADLINE (hourly)
  // Recoverable: giver can still update their status after missing the deadline.
  setInterval(async () => {
    try {
      const now = new Date();
      // Find rounds belonging to ACTIVE campaigns whose drawAt has passed
      const overdueRounds = await prisma.santaRound.findMany({
        where: {
          campaign: { status: 'ACTIVE', drawAt: { lte: now, not: null } },
          drawStatus: 'DONE',
        },
        select: { id: true, campaignId: true },
      });
      if (overdueRounds.length === 0) return;

      let totalMissed = 0;
      for (const round of overdueRounds) {
        // Find assignments still in actionable but uncommitted states
        const overdueAssignments = await prisma.santaAssignment.findMany({
          where: { roundId: round.id, giftStatus: { in: ['PENDING', 'BUYING'] } },
          select: { id: true, giver: { select: { userId: true } } },
        });
        if (overdueAssignments.length === 0) continue;

        // Bulk update — MISSED_DEADLINE is recoverable (giver can still pick a status)
        await prisma.santaAssignment.updateMany({
          where: { id: { in: overdueAssignments.map(a => a.id) } },
          data: { giftStatus: 'MISSED_DEADLINE' },
        });
        totalMissed += overdueAssignments.length;

        // Create DEADLINE_MISSED notifications — batch insert, deduped per assignment
        await prisma.santaNotification.createMany({
          data: overdueAssignments.map(a => ({
            campaignId: round.campaignId,
            userId: a.giver.userId,
            type: 'DEADLINE_MISSED' as const,
            payload: { assignmentId: a.id },
            dedupeKey: `missed:${a.id}`,   // unique per (user, DEADLINE_MISSED, assignment)
          })),
          skipDuplicates: true,
        }).catch(() => { /* non-fatal */ });
      }

      if (totalMissed > 0) {
        logger.info({ count: totalMissed }, 'santa-deadlines: marked assignments as MISSED_DEADLINE');
      }
    } catch (err) {
      logger.error({ err }, 'santa-deadlines missed-deadline job failed');
    }
  }, 60 * 60 * 1000);

  // Santa deadline warning: notify PENDING/BUYING givers ~3 days before drawAt (hourly check)
  // Warning window: between 72h and 96h before drawAt (fires once per ~day, not every hour).
  setInterval(async () => {
    try {
      const now = new Date();
      const warningWindowStart = new Date(now.getTime() + 72 * 60 * 60 * 1000);  // 3 days from now
      const warningWindowEnd   = new Date(now.getTime() + 96 * 60 * 60 * 1000);  // 4 days from now

      const warningRounds = await prisma.santaRound.findMany({
        where: {
          campaign: {
            status: 'ACTIVE',
            drawAt: { gte: warningWindowStart, lte: warningWindowEnd },
          },
          drawStatus: 'DONE',
        },
        select: { id: true, campaignId: true },
      });
      if (warningRounds.length === 0) return;

      let totalWarned = 0;
      for (const round of warningRounds) {
        const pendingAssignments = await prisma.santaAssignment.findMany({
          where: { roundId: round.id, giftStatus: { in: ['PENDING', 'BUYING'] } },
          select: { id: true, giver: { select: { userId: true } } },
        });
        if (pendingAssignments.length === 0) continue;

        // Batch insert DEADLINE_WARNING — deduped per assignment via dedupeKey; no findFirst needed
        const warnResult = await prisma.santaNotification.createMany({
          data: pendingAssignments.map(a => ({
            campaignId: round.campaignId,
            userId: a.giver.userId,
            type: 'DEADLINE_WARNING' as const,
            payload: { assignmentId: a.id },
            dedupeKey: `warn:${a.id}`,    // unique per (user, DEADLINE_WARNING, assignment)
          })),
          skipDuplicates: true,
        }).catch(() => ({ count: 0 }));
        totalWarned += warnResult.count;
      }

      if (totalWarned > 0) {
        logger.info({ count: totalWarned }, 'santa-deadlines: sent DEADLINE_WARNING to givers');
      }
    } catch (err) {
      logger.error({ err }, 'santa-deadlines deadline-warning job failed');
    }
  }, 60 * 60 * 1000);

  // Santa seasonal events: check every hour for calendar milestones (Nov 1, Feb 1).
  // Idempotent — safe to run hourly; each broadcast fires at most once per year via DB dedup.
  setInterval(() => { void maybeRunSeasonalEvents(); }, 60 * 60 * 1000);
}

/**
 * Santa startup jobs — invoked from inside `app.listen` callback.
 * Two fire-and-forget tasks:
 *   1. Ensure SantaGlobalConfig singleton exists.
 *   2. Backfill aliases for DONE rounds that don't have aliases yet.
 * Both are wrapped in `void`/`.catch` to never block server start.
 */
export function runSantaStartupJobs(deps: SantaStartupDeps): void {
  const { prisma, logger, generateSantaAliases } = deps;

  // Ensure SantaGlobalConfig singleton exists.
  // This is idempotent — upsert preserves the existing santaEnabled value if already set.
  // If the row doesn't exist yet (fresh DB), it is created with santaEnabled=true (default on).
  void prisma.santaGlobalConfig.upsert({
    where:  { id: 'global' },
    create: { id: 'global', santaEnabled: true },
    update: {}, // never overwrite an existing setting on startup
  }).catch(err => {
    logger.error({ err }, 'startup: SantaGlobalConfig upsert failed');
  });

  // Backfill: generate aliases for all existing rounds that have none yet.
  // Idempotent — skipDuplicates; non-blocking; never fails startup.
  void (async () => {
    try {
      const rounds = await prisma.santaRound.findMany({
        where: {
          drawStatus: 'DONE',
          aliases: { none: {} },
        },
        select: {
          id: true,
          assignments: {
            select: { giverParticipantId: true, receiverParticipantId: true },
          },
        },
      });
      for (const round of rounds) {
        const participantIds = [
          ...new Set([
            ...round.assignments.map(a => a.giverParticipantId),
            ...round.assignments.map(a => a.receiverParticipantId),
          ]),
        ];
        if (participantIds.length === 0) continue;
        const aliasData = generateSantaAliases(round.id, participantIds);
        await prisma.santaParticipantAlias.createMany({
          data: aliasData.map(a => ({ roundId: round.id, ...a })),
          skipDuplicates: true,
        });
        logger.info({ count: aliasData.length, roundId: round.id }, 'startup: backfilled aliases for round');
      }
      if (rounds.length > 0) {
        logger.info({ rounds: rounds.length }, 'startup: Santa alias backfill complete');
      }
    } catch (err) {
      logger.error({ err }, 'startup: Santa alias backfill failed (non-fatal)');
    }
  })();
}
