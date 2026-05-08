// One-shot backfill: re-resolve market bucket for every user whose
// UserProfile.marketBucket is NULL or 'unknown', plus create missing
// UserProfile rows for users who only ever /start-ed the bot.
//
// Signals available offline (post-hoc, no live request):
//   1. UserProfile.language (raw Telegram language_code captured earlier)
//   2. User.firstName Unicode-script analysis
// IP geolocation is NOT used here — the IP at /start time was not stored.
//
// Behaviour: never downgrades a non-unknown bucket. Users whose firstName
// is Latin-script and whose language was never captured remain 'unknown' —
// that's the genuine ceiling for offline backfill; the in-request middleware
// will resolve them on next interaction via X-Browser-* headers + IP geo.
//
// Usage:
//   docker exec wishlist-prod-api-1 node /app/apps/api/dist/scripts/backfill-market-buckets.js
//   docker exec wishlist-prod-api-1 node /app/apps/api/dist/scripts/backfill-market-buckets.js --dry-run

import { prisma } from '@wishlist/db';
import {
  resolveMarketBucket,
  normalizeLocale,
  isSupportedImportRegion,
  type MarketBucket,
  type MarketBucketSource,
} from '@wishlist/shared';

const dryRun = process.argv.includes('--dry-run');

interface Stats {
  scanned: number;
  profiles_created: number;
  buckets_resolved: number;
  buckets_unchanged: number;
  by_source: Record<MarketBucketSource, number>;
  by_bucket: Record<MarketBucket, number>;
}

const SOURCES: MarketBucketSource[] = ['language_code', 'browser_language', 'timezone', 'country_code', 'first_name', 'unknown'];
const BUCKETS: MarketBucket[] = ['ru', 'ar', 'en', 'hi', 'zh-CN', 'es', 'other_known', 'unknown'];

function emptyStats(): Stats {
  return {
    scanned: 0,
    profiles_created: 0,
    buckets_resolved: 0,
    buckets_unchanged: 0,
    by_source: SOURCES.reduce((acc, s) => ({ ...acc, [s]: 0 }), {} as Record<MarketBucketSource, number>),
    by_bucket: BUCKETS.reduce((acc, b) => ({ ...acc, [b]: 0 }), {} as Record<MarketBucket, number>),
  };
}

async function backfillUsersWithoutProfile(stats: Stats): Promise<void> {
  // Users who /start-ed the bot but never opened the Mini App: no
  // UserProfile row at all. Create one only when script analysis yields a
  // recognised bucket — we deliberately leave the orphan untouched when
  // bucket='unknown' because writing an empty profile (NULL bucket, NULL
  // language) gives the dashboard nothing new (LEFT JOIN already coalesces
  // missing profile to 'unknown') and would steal the chance for the next
  // live request from this user (Mini App or bot interaction) to populate
  // the row with full identity fields via the auth/upsert path.
  const orphans = await prisma.user.findMany({
    where: { profile: null },
    select: { id: true, firstName: true },
  });
  console.log(`[backfill] users without profile: ${orphans.length}`);

  for (const u of orphans) {
    stats.scanned++;
    const { bucket, source } = resolveMarketBucket({ firstName: u.firstName });
    stats.by_source[source]++;
    stats.by_bucket[bucket]++;
    if (bucket === 'unknown') continue;

    if (dryRun) {
      stats.profiles_created++;
      stats.buckets_resolved++;
      continue;
    }

    try {
      await prisma.userProfile.create({
        data: {
          userId: u.id,
          defaultCurrency: bucket === 'ru' ? 'RUB' : 'USD',
          marketBucket: bucket,
          supportedImportRegion: isSupportedImportRegion(bucket),
        },
      });
      stats.profiles_created++;
      stats.buckets_resolved++;
    } catch (err) {
      console.error(`[backfill] create profile failed for ${u.id}:`, err);
    }
  }
}

async function backfillProfilesWithUnknownBucket(stats: Stats): Promise<void> {
  // Profiles where bucket is NULL or 'unknown' — try to resolve from
  // the persisted language column + linked User.firstName.
  const targets = await prisma.userProfile.findMany({
    where: { OR: [{ marketBucket: null }, { marketBucket: 'unknown' }] },
    select: {
      userId: true,
      language: true,
      marketBucket: true,
      user: { select: { firstName: true } },
    },
  });
  console.log(`[backfill] profiles with NULL/unknown bucket: ${targets.length}`);

  for (const p of targets) {
    stats.scanned++;
    const { bucket, source } = resolveMarketBucket({
      languageCode: p.language,
      firstName: p.user.firstName,
    });
    stats.by_source[source]++;
    stats.by_bucket[bucket]++;
    if (bucket === 'unknown') {
      stats.buckets_unchanged++;
      continue;
    }
    if (p.marketBucket === bucket) {
      stats.buckets_unchanged++;
      continue;
    }

    if (dryRun) {
      stats.buckets_resolved++;
      continue;
    }

    try {
      const normLocale = p.language ? normalizeLocale(p.language) : null;
      await prisma.userProfile.update({
        where: { userId: p.userId },
        data: {
          marketBucket: bucket,
          supportedImportRegion: isSupportedImportRegion(bucket),
          ...(normLocale ? { normalizedLocale: normLocale } : {}),
        },
      });
      stats.buckets_resolved++;
    } catch (err) {
      console.error(`[backfill] update profile failed for ${p.userId}:`, err);
    }
  }
}

async function main(): Promise<void> {
  const stats = emptyStats();
  console.log(`[backfill] mode: ${dryRun ? 'DRY-RUN' : 'WRITE'}`);
  await backfillUsersWithoutProfile(stats);
  await backfillProfilesWithUnknownBucket(stats);
  console.log('[backfill] done', JSON.stringify(stats, null, 2));
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
