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

import { parseUrl } from '../url-parser.js';
import { ensureItemPlacement } from '../placements/ensureItemPlacement';

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

    const item = await prisma.item.create({
      data: {
        wishlistId: draftsWl.id,
        title: title.slice(0, 200),
        url: parsed.canonicalUrl || rawUrl,
        description,
        priceText: extractNumericPrice(parsed.priceText),
        imageUrl: parsed.imageUrl ?? null,
        sourceUrl: rawUrl,
        sourceDomain: parsed.sourceDomain,
        importMethod: source || 'bot',
      },
      select: {
        id: true, wishlistId: true, title: true, url: true, priceText: true,
        imageUrl: true, priority: true, status: true, description: true,
        sourceUrl: true, sourceDomain: true, importMethod: true, currency: true,
      },
    });
    // Dual-write: mirror into placement table.
    await ensureItemPlacement(prisma, { wishlistId: draftsWl.id, itemId: item.id });

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
