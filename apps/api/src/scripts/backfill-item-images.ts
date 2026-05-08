// One-shot backfill: for every Item whose imageUrl is a remote http(s) URL,
// download the photo via downloadAndProcessImage and replace imageUrl with
// the resulting local /api/uploads/<file>.jpg path.
//
// Same pipeline as the URL-import flow added in the same change. Run inside
// the prod api container (UPLOAD_DIR is bind-mounted) so the resulting files
// land in the same volume Express serves.
//
// Usage:
//   docker exec wishlist-prod-api-1 node /app/apps/api/dist/scripts/backfill-item-images.js
//   docker exec wishlist-prod-api-1 node /app/apps/api/dist/scripts/backfill-item-images.js --limit 5   (smoke test)
//   docker exec wishlist-prod-api-1 node /app/apps/api/dist/scripts/backfill-item-images.js --dry-run   (no DB writes)
//
// Output: per-item line + final summary { total, downloaded, skipped, failed }.

import { prisma } from '@wishlist/db';
import { downloadAndProcessImage } from '../uploads/imageProcessor';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const limitFlagIdx = args.indexOf('--limit');
const limit = limitFlagIdx >= 0 ? Number(args[limitFlagIdx + 1] || '0') : 0;
const concurrency = 3; // be polite to marketplace CDNs

async function main(): Promise<void> {
  const where = {
    imageUrl: { startsWith: 'http' },
  } as const;

  const total = await prisma.item.count({ where });
  console.log(`[backfill] found ${total} item(s) with remote imageUrl${limit ? ` (processing first ${limit})` : ''}${dryRun ? ' [DRY RUN]' : ''}`);

  const items = await prisma.item.findMany({
    where,
    select: { id: true, imageUrl: true, sourceDomain: true, title: true },
    orderBy: { createdAt: 'desc' },
    ...(limit > 0 ? { take: limit } : {}),
  });

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;

  // Simple concurrency limiter: chunk the list and await Promise.all per chunk.
  for (let i = 0; i < items.length; i += concurrency) {
    const chunk = items.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (item) => {
        const remoteUrl = item.imageUrl!;
        try {
          const cached = await downloadAndProcessImage(remoteUrl, {
            maxDim: 1600,
            quality: 80,
            suffix: 'full',
          });
          const localPath = `/api/uploads/${cached.filename}`;
          if (!dryRun) {
            await prisma.item.update({
              where: { id: item.id },
              data: { imageUrl: localPath },
            });
          }
          downloaded++;
          console.log(`[backfill] ok  ${item.id} (${item.sourceDomain ?? '?'}) -> ${localPath} ${cached.sizeBytes}b ${cached.width}x${cached.height}`);
        } catch (err) {
          const msg = (err as Error).message;
          // Treat 404/403/redirect/not-an-image as "skip" — image source likely
          // dead or moved; the user still has the remote URL as fallback.
          const isPermanent = /HTTP (404|403|410)|Redirect|Not an image/.test(msg);
          if (isPermanent) {
            skipped++;
            console.log(`[backfill] skip ${item.id} (${item.sourceDomain ?? '?'}): ${msg}`);
          } else {
            failed++;
            console.error(`[backfill] FAIL ${item.id} (${item.sourceDomain ?? '?'}): ${msg}`);
          }
        }
      }),
    );
  }

  console.log(`[backfill] done: total=${items.length} downloaded=${downloaded} skipped=${skipped} failed=${failed}`);
}

main()
  .catch((err) => {
    console.error('[backfill] fatal:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
