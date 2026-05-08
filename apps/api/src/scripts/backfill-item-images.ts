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
let limit = 0;
if (limitFlagIdx >= 0) {
  const raw = args[limitFlagIdx + 1];
  const parsed = Number(raw);
  // Reject NaN / negative / non-integer — silently widening scope on a typo'd
  // arg would be a footgun on a destructive prod backfill.
  if (raw === undefined || !Number.isFinite(parsed) || parsed < 0 || !Number.isInteger(parsed)) {
    console.error(`[backfill] --limit requires a non-negative integer, got: ${JSON.stringify(raw)}`);
    process.exit(2);
  }
  limit = parsed;
}
const concurrency = 3; // be polite to marketplace CDNs

async function main(): Promise<void> {
  // Match http:// or https:// only — startsWith: 'http' would also match
  // garbage like 'httpfoo' or 'httpsbar' if the column ever held junk.
  const where = {
    OR: [
      { imageUrl: { startsWith: 'http://' } },
      { imageUrl: { startsWith: 'https://' } },
    ],
  };

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
          if (dryRun) {
            // Don't touch network or disk — just announce what we would do.
            // For real reachability testing, run with --limit N (no --dry-run).
            downloaded++;
            console.log(`[backfill] WOULD download ${item.id} (${item.sourceDomain ?? '?'}) <- ${remoteUrl}`);
            return;
          }
          const cached = await downloadAndProcessImage(remoteUrl, {
            maxDim: 1600,
            quality: 80,
            suffix: 'full',
          });
          const localPath = `/api/uploads/${cached.filename}`;
          await prisma.item.update({
            where: { id: item.id },
            data: { imageUrl: localPath },
          });
          downloaded++;
          console.log(`[backfill] ok  ${item.id} (${item.sourceDomain ?? '?'}) -> ${localPath} ${cached.sizeBytes}b ${cached.width}x${cached.height}`);
        } catch (err) {
          const msg = (err as Error).message;
          // Treat structurally-permanent failures as "skip" — the image source
          // is dead, moved, oversize, or wrong type, and a re-run will not
          // recover it. The user still has the remote URL as fallback.
          //
          // Strings here must match the throws in downloadAndProcessImage and
          // the SSRF helpers in url-parser.ts. Update both sides together.
          const isPermanent =
            /HTTP (4\d\d|410)/.test(msg) ||                 // 4xx + 410 from response status
            /Redirect not followed/.test(msg) ||            // 3xx (we don't follow redirects)
            /Not an allowed image type/.test(msg) ||        // content-type rejection
            /Image too large/.test(msg) ||                  // size cap exceeded
            /Ссылка на (внутренний|локальный) адрес/.test(msg); // SSRF reject (validateUrl/assertDnsIsSafe)
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
