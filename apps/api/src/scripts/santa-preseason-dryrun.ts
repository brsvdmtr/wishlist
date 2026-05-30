// E23 — Santa pre-season teaser DM: DRY-RUN recipients list (self-check #5).
//
// Computes the eligible audience WITHOUT sending anything: the total, the
// per-primary-segment breakdown (past_santa / social / active_owner), and a
// sample of userIds. Lets the operator preview exactly who would receive the
// teaser before flipping EXP_SANTA_PRESEASON_DM_ENABLED on near Nov 1.
//
// Read-only. The same eligibility filter the live wave uses
// (services/santa-preseason.ts::buildAudienceWhere): segments OR'd together,
// minus marketing opt-outs (null-safe), minus anyone already touched this
// season.
//
// Usage (inside the API container):
//   node /app/apps/api/dist/scripts/santa-preseason-dryrun.js
//   node /app/apps/api/dist/scripts/santa-preseason-dryrun.js --season 2026 --sample 50
//
// Local invocation:
//   pnpm -C apps/api exec tsx src/scripts/santa-preseason-dryrun.ts --season 2026

import { prisma } from '@wishlist/db';

import { computePreseasonAudience } from '../services/santa-preseason';
import { getSeasonStartYear } from '../services/santa-season';

function parseArgs(argv: ReadonlyArray<string>): { seasonYear: number; sampleSize: number } {
  const now = new Date();
  const seasonIdx = argv.indexOf('--season');
  const sampleIdx = argv.indexOf('--sample');

  let seasonYear = getSeasonStartYear(now);
  if (seasonIdx >= 0) {
    const raw = argv[seasonIdx + 1];
    const parsed = Number(raw);
    if (raw === undefined || !Number.isInteger(parsed) || parsed < 2024 || parsed > 2100) {
      throw new Error(`--season requires a 4-digit year, got: ${JSON.stringify(raw)}`);
    }
    seasonYear = parsed;
  }

  let sampleSize = 25;
  if (sampleIdx >= 0) {
    const raw = argv[sampleIdx + 1];
    const parsed = Number(raw);
    if (raw === undefined || !Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`--sample requires a non-negative integer, got: ${JSON.stringify(raw)}`);
    }
    sampleSize = parsed;
  }

  return { seasonYear, sampleSize };
}

async function main(): Promise<void> {
  const { seasonYear, sampleSize } = parseArgs(process.argv.slice(2));
  console.log(`[santa-preseason-dryrun] season=${seasonYear} [DRY RUN — no sends]`);

  const audience = await computePreseasonAudience({ seasonYear, sampleSize });

  console.log(`[santa-preseason-dryrun] eligible total: ${audience.total}`);
  console.log(
    `[santa-preseason-dryrun] by segment: ` +
      `past_santa=${audience.bySegment.past_santa} ` +
      `social=${audience.bySegment.social} ` +
      `active_owner=${audience.bySegment.active_owner}`,
  );
  console.log(`[santa-preseason-dryrun] sample (${audience.sample.length}):`);
  for (const s of audience.sample) {
    console.log(`  ${s.userId}  [${s.segment}]`);
  }
}

main()
  .catch((err) => {
    console.error('[santa-preseason-dryrun] fatal:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
