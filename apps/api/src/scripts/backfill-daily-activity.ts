// One-shot backfill: re-aggregate AnalyticsEvent into UserDailyActivity
// over a range of UTC calendar days. Idempotent — re-running the same
// range overwrites prior rows with the same computed counters.
//
// AnalyticsEvent has a 90-day TTL, so the default window (last 90 days)
// captures everything still queryable. Older days have no source events
// to aggregate; they'll yield empty results (logged, no row written).
//
// Usage (inside the API container):
//   node /app/apps/api/dist/scripts/backfill-daily-activity.js
//   node /app/apps/api/dist/scripts/backfill-daily-activity.js --dry-run
//   node /app/apps/api/dist/scripts/backfill-daily-activity.js --from 2026-04-01 --to 2026-04-30
//   node /app/apps/api/dist/scripts/backfill-daily-activity.js --days 7
//
// Local invocation: pnpm -C apps/api exec tsx src/scripts/backfill-daily-activity.ts --dry-run
//
// Output: per-day { date, users, events, dryRun } + final summary.

import { prisma } from '@wishlist/db';

import {
  aggregateDateRange,
  startOfUtcDay,
} from '../services/daily-activity.service';

type Args = {
  dryRun: boolean;
  from: Date;
  to: Date;
};

const DEFAULT_DAYS = 90;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDateFlag(name: string, raw: string | undefined): Date {
  if (!raw || !DATE_RE.test(raw)) {
    throw new Error(`${name} requires YYYY-MM-DD, got: ${JSON.stringify(raw)}`);
  }
  // Parse as UTC midnight — matches the rollup's UTC-day semantics.
  const d = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`${name} is not a valid date: ${JSON.stringify(raw)}`);
  }
  return d;
}

function parseArgs(argv: ReadonlyArray<string>): Args {
  const dryRun = argv.includes('--dry-run');
  const fromIdx = argv.indexOf('--from');
  const toIdx = argv.indexOf('--to');
  const daysIdx = argv.indexOf('--days');

  const today = startOfUtcDay(new Date());

  let from: Date;
  let to: Date;

  if (fromIdx >= 0 || toIdx >= 0) {
    if (fromIdx < 0 || toIdx < 0) {
      throw new Error('--from and --to must be passed together');
    }
    from = parseDateFlag('--from', argv[fromIdx + 1]);
    to = parseDateFlag('--to', argv[toIdx + 1]);
    if (from.getTime() > to.getTime()) {
      throw new Error(`--from (${from.toISOString().slice(0, 10)}) must be ≤ --to (${to.toISOString().slice(0, 10)})`);
    }
  } else if (daysIdx >= 0) {
    const raw = argv[daysIdx + 1];
    const parsed = Number(raw);
    if (raw === undefined || !Number.isFinite(parsed) || parsed < 1 || !Number.isInteger(parsed)) {
      throw new Error(`--days requires a positive integer, got: ${JSON.stringify(raw)}`);
    }
    to = today;
    from = new Date(today.getTime() - (parsed - 1) * 86_400_000);
  } else {
    to = today;
    from = new Date(today.getTime() - (DEFAULT_DAYS - 1) * 86_400_000);
  }

  return { dryRun, from, to };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const dayCount = Math.round((args.to.getTime() - args.from.getTime()) / 86_400_000) + 1;

  console.log(
    `[backfill-daily-activity] from=${args.from.toISOString().slice(0, 10)} ` +
      `to=${args.to.toISOString().slice(0, 10)} days=${dayCount}` +
      (args.dryRun ? ' [DRY RUN]' : ''),
  );

  const results = await aggregateDateRange(prisma, args.from, args.to, { dryRun: args.dryRun });

  let totalUsers = 0;
  let totalEvents = 0;
  let totalDropped = 0;
  for (const r of results) {
    totalUsers += r.users;
    totalEvents += r.events;
    totalDropped += r.droppedUsers;
    const droppedTag = r.droppedUsers > 0 ? ` droppedUsers=${r.droppedUsers}` : '';
    console.log(
      `[backfill-daily-activity] ${r.date.toISOString().slice(0, 10)}: ` +
        `users=${r.users} events=${r.events}${droppedTag}${r.dryRun ? ' [dry]' : ''}`,
    );
  }

  console.log(
    `[backfill-daily-activity] done: days=${results.length} ` +
      `userDayRows=${totalUsers} eventsScanned=${totalEvents} ` +
      `droppedUsers=${totalDropped}` +
      (args.dryRun ? ' [no writes]' : ''),
  );
}

main()
  .catch((err) => {
    console.error('[backfill-daily-activity] fatal:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
