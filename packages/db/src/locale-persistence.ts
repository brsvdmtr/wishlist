// Atomic UPSERT of locale segmentation fields on UserProfile, shared by:
//   - apps/api/src/index.ts tgRouter middleware (Mini App auth path)
//   - apps/bot/src/index.ts /start handler (bot path)
//
// "Atomic" = single Postgres INSERT ... ON CONFLICT DO UPDATE statement, so
// concurrent /start retries (Telegram webhook redelivery) AND a parallel API
// request from the same user CANNOT race into a unique-constraint violation
// nor read-modify-write the bucket out from under each other.
//
// The "never downgrade a known bucket to 'unknown'" invariant lives here as
// a single SQL expression — both call sites hit this helper instead of
// re-implementing the COALESCE/NULLIF/CASE chain.

import crypto from 'node:crypto';
import { isSupportedImportRegion, normalizeLocale, type MarketBucket } from '@wishlist/shared';
import { prisma } from './index';

export type PersistBucketTarget =
  | { userId: string }
  | { telegramId: string };

export interface PersistBucketInput {
  /** Either internal User.id (cuid) or Telegram numeric id as string. */
  target: PersistBucketTarget;
  /** Raw Telegram language_code (e.g. 'ru', 'en-US'). Null = no signal. */
  rawLanguage: string | null;
  /** Resolved market bucket from `resolveMarketBucket(...)`. */
  bucket: MarketBucket;
}

/**
 * Atomically upsert UserProfile.language / normalizedLocale / marketBucket /
 * supportedImportRegion. NEVER downgrades a known bucket to 'unknown' —
 * missing signals on this request preserve any previously-resolved bucket.
 *
 * For the INSERT branch (no existing profile), we mint a UUID id rather than
 * a Prisma cuid because raw SQL cannot invoke Prisma's client-side default.
 * The id is a string, the column is `String @id`; format inconsistency is
 * cosmetic — no downstream code parses the id format.
 *
 * Skip-write fast path: when bucket='unknown' AND rawLanguage is null we
 * have no useful signal at all, so persisting an empty profile is wasted
 * I/O; the caller should early-return before invoking this helper.
 */
export async function persistResolvedBucket(input: PersistBucketInput): Promise<void> {
  const { target, rawLanguage, bucket } = input;
  const newProfileId = crypto.randomUUID();
  const normLocale = rawLanguage ? normalizeLocale(rawLanguage) : null;
  const importRegion = isSupportedImportRegion(bucket);
  // Default currency for a brand-new profile only — preserved on conflict.
  const defaultCurrency = bucket === 'ru' ? 'RUB' : 'USD';

  // Resolve userId via either direct value or sub-select on telegramId.
  // Both paths feed the same INSERT…ON CONFLICT below; only the source of
  // userId differs. The userIdExpr placeholder is parameterised to keep
  // SQL injection out of the picture.
  if ('userId' in target) {
    await prisma.$executeRawUnsafe(
      buildUpsertSql('$2'),
      newProfileId,        // $1 — id for INSERT branch
      target.userId,       // $2 — userId
      defaultCurrency,     // $3
      rawLanguage,         // $4
      normLocale,          // $5
      bucket,              // $6
      importRegion,        // $7
    );
  } else {
    await prisma.$executeRawUnsafe(
      buildUpsertSql('(SELECT id FROM "User" WHERE "telegramId" = $2)'),
      newProfileId,        // $1 — id for INSERT branch
      target.telegramId,   // $2 — telegramId for sub-select
      defaultCurrency,     // $3
      rawLanguage,         // $4
      normLocale,          // $5
      bucket,              // $6
      importRegion,        // $7
    );
  }
}

function buildUpsertSql(userIdExpr: string): string {
  return `
    INSERT INTO "UserProfile" (
      id, "userId", "defaultCurrency", language, "normalizedLocale",
      "marketBucket", "supportedImportRegion", "createdAt", "updatedAt"
    )
    SELECT
      $1,
      ${userIdExpr},
      $3::"Currency",
      $4,
      $5,
      NULLIF($6, 'unknown'),
      CASE WHEN $6 = 'unknown' THEN NULL ELSE $7 END,
      NOW(),
      NOW()
    WHERE ${userIdExpr} IS NOT NULL
    ON CONFLICT ("userId") DO UPDATE SET
      language = COALESCE(EXCLUDED.language, "UserProfile".language),
      "normalizedLocale" = COALESCE(EXCLUDED."normalizedLocale", "UserProfile"."normalizedLocale"),
      "marketBucket" = COALESCE(NULLIF($6, 'unknown'), "UserProfile"."marketBucket"),
      "supportedImportRegion" = CASE WHEN $6 = 'unknown' THEN "UserProfile"."supportedImportRegion" ELSE $7 END,
      "updatedAt" = NOW()
    WHERE
      COALESCE(EXCLUDED.language, "UserProfile".language) IS DISTINCT FROM "UserProfile".language
      OR COALESCE(EXCLUDED."normalizedLocale", "UserProfile"."normalizedLocale") IS DISTINCT FROM "UserProfile"."normalizedLocale"
      OR COALESCE(NULLIF($6, 'unknown'), "UserProfile"."marketBucket") IS DISTINCT FROM "UserProfile"."marketBucket"
      OR ($6 <> 'unknown' AND $7 IS DISTINCT FROM "UserProfile"."supportedImportRegion")
  `;
}
