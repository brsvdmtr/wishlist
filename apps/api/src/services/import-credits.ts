// Credit model for URL import (the activation-critical monetization fix).
//
// URL import is no longer a hard PRO gate. FREE users get
// FREE_IMPORT_QUOTA_PER_MONTH imports per UTC calendar month; PRO is
// unlimited; paid import_pack_* credits (UserCredits.importCredits) top up
// beyond the free allowance.
//
// Monthly reset is LAZY — there is no scheduler. consumeImportCredit() stamps
// the current "YYYY-MM" bucket onto UserCredits.freeImportsPeriod and treats a
// stale bucket as a zeroed counter. resolveFreeImports() applies the same rule
// on the read path so the displayed counter is always period-correct.
//
// Consumption order on a successful import: free monthly quota first, then
// paid importCredits. PRO callers must gate on isPro and never reach
// consumeImportCredit().
//
// Consumers:
//   - routes/import.routes.ts   — Mini App POST /tg/import-url
//   - routes/internal.routes.ts — bot     POST /internal/import-url
//   - services/entitlement.ts   — getEffectiveEntitlements (counter payload),
//     via the pure resolveFreeImports helper only (no cycle).

import { randomUUID } from 'node:crypto';

import { prisma } from '@wishlist/db';

import logger from '../logger';
import { trackAnalyticsEvent } from './analytics';

/** FREE-tier URL imports per UTC calendar month. Env-tunable so the quota can
 *  be A/B'd (5 ↔ 10) without a redeploy; a value of 0 disables the free tier
 *  (FREE then needs paid credits or PRO). */
export const FREE_IMPORT_QUOTA_PER_MONTH = Math.max(
  0,
  parseInt(process.env.FREE_IMPORT_QUOTA_PER_MONTH ?? '5', 10) || 0,
);

/** UTC calendar-month bucket key, e.g. "2026-05". */
export function currentImportPeriod(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

export type FreeImportState = {
  freeLimit: number;
  freeUsed: number;
  freeRemaining: number;
};

/** Pure, period-aware resolver: a UserCredits row whose freeImportsPeriod is
 *  not the current month counts as zero used (lazy reset). Shared by the read
 *  path (getEffectiveEntitlements → counter) and getImportAllowance so the
 *  reset rule lives in exactly one place. */
export function resolveFreeImports(
  row: { freeImportsUsed: number; freeImportsPeriod: string | null } | null,
  now: Date = new Date(),
): FreeImportState {
  const freeLimit = FREE_IMPORT_QUOTA_PER_MONTH;
  const period = currentImportPeriod(now);
  const used = row && row.freeImportsPeriod === period ? row.freeImportsUsed : 0;
  const clampedUsed = Math.min(Math.max(used, 0), freeLimit);
  return {
    freeLimit,
    freeUsed: clampedUsed,
    freeRemaining: Math.max(0, freeLimit - clampedUsed),
  };
}

export type ImportAllowance = FreeImportState & {
  allowed: boolean;
  isPro: boolean;
  paidCredits: number;
  /** Which bucket the next import would draw from. */
  source: 'pro' | 'free' | 'paid' | 'none';
};

/** Can this user import a URL right now? PRO is always allowed (unlimited);
 *  FREE is allowed while monthly quota OR paid credits remain. Read-only —
 *  the actual decrement happens in consumeImportCredit() after the import
 *  succeeds. */
export async function getImportAllowance(userId: string, isPro: boolean): Promise<ImportAllowance> {
  if (isPro) {
    const freeLimit = FREE_IMPORT_QUOTA_PER_MONTH;
    return {
      allowed: true,
      isPro: true,
      freeLimit,
      freeUsed: 0,
      freeRemaining: freeLimit,
      paidCredits: 0,
      source: 'pro',
    };
  }
  const row = await prisma.userCredits.findUnique({ where: { userId } });
  const free = resolveFreeImports(row);
  const paidCredits = row?.importCredits ?? 0;
  const source: ImportAllowance['source'] =
    free.freeRemaining > 0 ? 'free' : paidCredits > 0 ? 'paid' : 'none';
  return { ...free, allowed: source !== 'none', isPro: false, paidCredits, source };
}

export type ConsumeImportResult = FreeImportState & {
  consumed: 'free' | 'paid' | 'none';
  paidCredits: number;
};

/** Consume one import credit AFTER a successful import. Free monthly quota is
 *  spent before paid credits.
 *
 *  Concurrency-safe: each branch is a single conditional UPDATE/INSERT, so
 *  parallel imports by the same user can never push freeImportsUsed past the
 *  quota or importCredits below zero — Postgres serializes the row writes and
 *  the WHERE clause re-evaluates against the committed state.
 *
 *  Best-effort by design: if nothing is left to consume (lost a race, or a PRO
 *  user slipped through), it returns consumed:'none' instead of throwing — the
 *  import already created an item and is never rolled back for a credit miss.
 *
 *  NEVER call for PRO users; callers gate on isPro first. */
export async function consumeImportCredit(
  userId: string,
  opts: { source: string },
): Promise<ConsumeImportResult> {
  const period = currentImportPeriod();
  let consumed: ConsumeImportResult['consumed'] = 'none';

  // 1. Try the monthly free quota. One atomic statement: INSERT seeds a fresh
  //    row at used=1; on conflict the WHERE on DO UPDATE enforces the cap (a
  //    stale period counts as 0 used, which also performs the lazy reset).
  //    0 rows affected ⇒ row exists and the quota is full.
  if (FREE_IMPORT_QUOTA_PER_MONTH > 0) {
    const freeRows = await prisma.$executeRaw`
      INSERT INTO "UserCredits" ("id", "userId", "freeImportsUsed", "freeImportsPeriod", "updatedAt")
      VALUES (${randomUUID()}, ${userId}, 1, ${period}, now())
      ON CONFLICT ("userId") DO UPDATE SET
        "freeImportsUsed" = CASE
          WHEN "UserCredits"."freeImportsPeriod" IS NOT DISTINCT FROM ${period}
          THEN "UserCredits"."freeImportsUsed" + 1
          ELSE 1 END,
        "freeImportsPeriod" = ${period},
        "updatedAt" = now()
      WHERE (CASE
        WHEN "UserCredits"."freeImportsPeriod" IS NOT DISTINCT FROM ${period}
        THEN "UserCredits"."freeImportsUsed"
        ELSE 0 END) < ${FREE_IMPORT_QUOTA_PER_MONTH}
    `;
    if (freeRows > 0) consumed = 'free';
  }

  // 2. Free quota full → spend a paid credit.
  if (consumed === 'none') {
    const paidRows = await prisma.$executeRaw`
      UPDATE "UserCredits"
      SET "importCredits" = "importCredits" - 1, "updatedAt" = now()
      WHERE "userId" = ${userId} AND "importCredits" > 0
    `;
    if (paidRows > 0) consumed = 'paid';
  }

  // 3. Read back the post-consume state for the response + analytics.
  const row = await prisma.userCredits.findUnique({ where: { userId } });
  const free = resolveFreeImports(row);
  const result: ConsumeImportResult = {
    ...free,
    consumed,
    paidCredits: row?.importCredits ?? 0,
  };

  if (consumed === 'free') {
    trackAnalyticsEvent({
      event: 'import.free_quota_used',
      userId,
      props: {
        source: opts.source,
        freeUsed: free.freeUsed,
        freeLimit: free.freeLimit,
        freeRemaining: free.freeRemaining,
      },
    });
    // Fires once, when this import drains the last free credit of the month.
    if (free.freeRemaining === 0) {
      trackAnalyticsEvent({
        event: 'import.free_quota_exhausted',
        userId,
        props: { source: opts.source, freeLimit: free.freeLimit },
      });
    }
  } else if (consumed === 'none') {
    // Callers check getImportAllowance first, so this is a lost race or a
    // misrouted PRO user — log it, don't fail the request.
    logger.warn(
      { event: 'import_credits.consume_noop', userId, source: opts.source },
      'consumeImportCredit found no credit to consume',
    );
  }

  return result;
}
