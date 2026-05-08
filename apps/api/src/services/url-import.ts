// URL import flow (P5s-9 — extracted from apps/api/src/index.ts).
//
// Single function — `importUrlForUser` — that takes a raw URL, parses it
// via `parseUrl` (the marketplace-orchestrator + legacy fallback in
// `../url-parser.js`), enforces the per-user SYSTEM_DRAFTS capacity cap,
// creates the resulting `Item` with dual-placement write, and fires the
// canonical `item_created` analytics event.
//
// Body is byte-identical to its previous in-place definition in
// `apps/api/src/index.ts:1475`. Only the ambient closure deps changed:
//
//   - `getOrCreateDraftsWishlist` was a hoisted function in index.ts;
//     now passed via `deps` because its source already moved to
//     `services/wishlists.ts` in P5s-7 (factory closing over trackEvent).
//   - `trackEvent` was a hoisted function in index.ts; passed via `deps`
//     because analytics extraction is deferred to P5s-5.
//
// All other helpers are direct imports from sibling service modules
// (P5s-6 items + P5s-7 wishlists + P5s-9 self-contained module imports).
//
// Strategy A: source moves here; `routes/import.routes.ts`,
// `routes/internal.routes.ts`, `routes/onboarding.routes.ts` continue
// receiving the resulting function via existing `deps` factory contracts
// — signatures unchanged.

import { prisma } from '@wishlist/db';

import logger from '../logger';
import { parseUrl } from '../url-parser.js';
import { ensureItemPlacement } from '../placements/ensureItemPlacement';
import { downloadAndProcessImage } from '../uploads/imageProcessor';
import { deleteUploadFile } from '../uploads/uploadCleanup';

import { ACTIVE_STATUSES, extractNumericPrice, mapTgItem } from './items';
import { DRAFTS_ITEM_LIMIT } from './wishlists';

// ─── Types ──────────────────────────────────────────────────────────────────

export type TrackEventFn = (event: string, userId?: string, props?: Record<string, unknown>) => void;

export type GetOrCreateDraftsWishlistFn = (userId: string) => Promise<{ id: string }>;

export type ImportUrlResult = {
  item: ReturnType<typeof mapTgItem>;
  wishlistId: string;
  parseStatus: 'ok' | 'partial' | 'failed';
};

export type ImportUrlForUserFn = (
  userId: string,
  rawUrl: string,
  note?: string,
  source?: string,
  parseOpts?: { noCache?: boolean },
) => Promise<ImportUrlResult>;

// ─── Helpers ────────────────────────────────────────────────────────────────

// Atomic Item insert + placement upsert. Both writes share one transaction so
// a placement failure (e.g. resolveDefaultCategoryId throws on a corrupted
// wishlist) rolls back the Item row, keeping the file/row pair consistent.
type CreateItemTx = Pick<typeof prisma, 'item' | 'wishlistItemPlacement' | 'wishlistCategory'>;
async function createItemWithPlacement(
  tx: CreateItemTx,
  data: {
    wishlistId: string;
    title: string;
    url: string;
    description: string | null;
    priceText: string | null;
    imageUrl: string | null;
    sourceUrl: string;
    sourceDomain: string | null;
    importMethod: string;
  },
) {
  const created = await tx.item.create({
    data,
    select: {
      id: true, wishlistId: true, title: true, url: true, priceText: true,
      imageUrl: true, priority: true, status: true, description: true,
      sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
    },
  });
  await ensureItemPlacement(tx, { wishlistId: data.wishlistId, itemId: created.id });
  return created;
}

// ─── Factory ────────────────────────────────────────────────────────────────

export function createImportUrlForUser(deps: {
  trackEvent: TrackEventFn;
  getOrCreateDraftsWishlist: GetOrCreateDraftsWishlistFn;
}): ImportUrlForUserFn {
  const { trackEvent, getOrCreateDraftsWishlist } = deps;

  return async function importUrlForUser(
    userId: string,
    rawUrl: string,
    note?: string,
    source?: string,
    parseOpts?: { noCache?: boolean },
  ): Promise<ImportUrlResult> {
    const draftsWl = await getOrCreateDraftsWishlist(userId);

    // Check drafts limit
    const draftsCount = await prisma.item.count({
      where: { wishlistId: draftsWl.id, status: { in: [...ACTIVE_STATUSES] } },
    });
    if (draftsCount >= DRAFTS_ITEM_LIMIT) {
      throw Object.assign(new Error('Drafts limit reached'), { statusCode: 402 });
    }

    let parsed: Awaited<ReturnType<typeof parseUrl>>;
    let parseStatus: 'ok' | 'partial' | 'failed' = 'ok';

    try {
      parsed = await parseUrl(rawUrl, parseOpts);
      if (!parsed.title && !parsed.priceText && !parsed.imageUrl) {
        parseStatus = 'failed';
      } else if (!parsed.title || !parsed.priceText) {
        parseStatus = 'partial';
      }
    } catch {
      parseStatus = 'failed';
      let hostname = 'link';
      try { hostname = new URL(rawUrl).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
      parsed = {
        title: null,
        description: null,
        priceText: null,
        imageUrl: null,
        sourceDomain: hostname,
        canonicalUrl: rawUrl,
      };
    }

    const title = parsed.title || parsed.sourceDomain || 'Link';

    // Description: user note (if any) + parsed description
    let description: string | null = null;
    if (note && parsed.description) {
      description = `💬 ${note}\n\n${parsed.description}`.slice(0, 500);
    } else if (note) {
      description = note.slice(0, 500);
    } else if (parsed.description) {
      description = parsed.description.slice(0, 500);
    }

    // Cache the marketplace product photo on our own /uploads dir so the
    // Mini App stops loading multi-MB originals from external CDNs for
    // 88px thumbnails. Failure is non-fatal: fall back to the remote URL.
    //
    // freshlyCachedFilename tracks the file we just wrote, so the
    // orphan-cleanup branch only unlinks files this call site owns — never
    // a path that came from somewhere else (defence against future code that
    // might pre-populate `parsed.imageUrl` with a `/api/uploads/...` value).
    //
    // NOTE: not retry-safe. If a future caller wraps importUrlForUser in a
    // Prisma retry loop (e.g. for serialization failures), each attempt would
    // call downloadAndProcessImage again and write a fresh <uuid>-full.jpg,
    // leaking the prior attempts. Add external orphan tracking before
    // wrapping this in any retry harness.
    let storedImageUrl: string | null = parsed.imageUrl ?? null;
    let freshlyCachedFilename: string | null = null;
    if (storedImageUrl) {
      try {
        const cached = await downloadAndProcessImage(storedImageUrl, {
          maxDim: 1600,
          quality: 80,
          suffix: 'full',
        });
        storedImageUrl = `/api/uploads/${cached.filename}`;
        freshlyCachedFilename = cached.filename;
      } catch (err) {
        logger.warn(
          {
            event: 'url_import.image_cache_failed',
            sourceDomain: parsed.sourceDomain,
            err: err instanceof Error ? err.message : String(err),
          },
          'image cache failed, falling back to remote URL',
        );
      }
    }

    // Both DB writes go inside one transaction so a placement failure rolls
    // back the Item row — without that, an ensureItemPlacement throw would
    // leave an orphaned Item row AND a cached file referenced by no one
    // discoverable (item exists but is unplaced).

    let item: Awaited<ReturnType<typeof createItemWithPlacement>>;
    try {
      item = await prisma.$transaction(async (tx) => createItemWithPlacement(tx, {
        wishlistId: draftsWl.id,
        title: title.slice(0, 200),
        url: parsed.canonicalUrl || rawUrl,
        description,
        priceText: extractNumericPrice(parsed.priceText),
        imageUrl: storedImageUrl,
        sourceUrl: rawUrl,
        sourceDomain: parsed.sourceDomain,
        importMethod: source || 'bot',
      }));
    } catch (err) {
      if (freshlyCachedFilename) {
        // freshlyCachedFilename came from crypto.randomUUID() in
        // processImage — path-safe by construction; deleteUploadFile also
        // re-validates basename traversal as a belt-and-suspenders guard.
        deleteUploadFile(`/api/uploads/${freshlyCachedFilename}`);
        logger.warn(
          {
            event: 'url_import.image_orphan_cleanup',
            filename: freshlyCachedFilename,
            sourceDomain: parsed.sourceDomain,
            err: err instanceof Error ? err.message : String(err),
          },
          'item create rolled back, removed orphaned cached image',
        );
      }
      throw err;
    }

    // Canonical analytics: item created via import in SYSTEM_DRAFTS
    const totalUserItems = await prisma.item.count({ where: { wishlist: { ownerId: userId }, status: { not: 'DELETED' } } });
    trackEvent('item_created', userId, {
      itemId: item.id, wishlistId: draftsWl.id, wishlistType: 'SYSTEM_DRAFTS',
      source: source === 'bot' ? 'bot' : 'import_url',
      platform: source === 'bot' ? 'bot' : 'miniapp',
      isFirstItem: totalUserItems === 1,
      triggeredFromDrafts: true,
    });
    if (totalUserItems === 1) trackEvent('first_item_created', userId, { itemId: item.id, wishlistType: 'SYSTEM_DRAFTS', source: source === 'bot' ? 'bot' : 'import_url', platform: source === 'bot' ? 'bot' : 'miniapp' });

    return { item: mapTgItem(item), wishlistId: draftsWl.id, parseStatus };
  };
}
