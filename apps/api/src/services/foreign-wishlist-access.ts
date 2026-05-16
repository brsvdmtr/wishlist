// Foreign wishlist access history helper.
//
// Records (userId, wishlistId, source, sourceRef?) when a user successfully
// opens a wishlist they do not own. The row is access HISTORY, never a
// permission grant: every search hit / click is re-checked for live access
// regardless of whether a history row exists.
//
// Called from a single FE-triggered endpoint (POST /tg/access/wishlist-opened)
// plus a handful of authenticated state-changing routes (subscribe,
// reserve, secret-reserve, curated subscribe/view). Re-using a helper
// keeps the validation, hashing, and dedup logic in one spot.
//
// `sourceRef` (optional) is an opaque credential pin used at search-time
// to enforce revocation correctness for credential-based access:
//   - share_link        → hashShareToken(rawShareToken) (SHA-256 hex)
//   - curated_selection → CuratedSelection.id (plain UUID-ish string)
// For relation-grounded sources (subscription, reservation, profile,
// santa) sourceRef is null because the relation table itself is the
// authoritative ongoing access check.

import { prisma } from '@wishlist/db';
import crypto from 'node:crypto';

export const FOREIGN_WISHLIST_ACCESS_SOURCES = [
  'share_link',
  'curated_selection',
  'subscription',
  'reservation',
  'profile',
  'santa',
  'direct_open',
  'unknown',
] as const;

export type ForeignWishlistAccessSource = (typeof FOREIGN_WISHLIST_ACCESS_SOURCES)[number];

export function isValidForeignWishlistAccessSource(value: string): value is ForeignWishlistAccessSource {
  return (FOREIGN_WISHLIST_ACCESS_SOURCES as readonly string[]).includes(value);
}

export interface RecordForeignWishlistAccessArgs {
  userId: string;
  wishlistId: string;
  source: ForeignWishlistAccessSource;
  /**
   * Optional credential pin. Only meaningful for credential-based sources:
   *   - share_link        → caller passes the raw shareToken; we hash here.
   *   - curated_selection → caller passes CuratedSelection.id.
   * Ignored for all other sources (where the source itself implies
   * relation-grounded access).
   */
  sourceRef?: string | null;
}

/** Stable hash used to pin a shareToken into ForeignWishlistAccess.sourceRef. */
export function hashShareToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export type RecordForeignWishlistAccessResult =
  | { ok: true; recorded: boolean; reason?: string }
  | { ok: false; reason: 'own_wishlist' | 'wishlist_missing' | 'access_denied' | 'wishlist_archived' | 'invalid_input' };

/**
 * Record (or refresh `lastOpenedAt` on) an existing access row.
 *
 * Returns ok=false in the following cases — DO NOT treat as errors:
 *   - own_wishlist:  caller is owner, no history needed
 *   - wishlist_missing: wishlist id doesn't exist
 *   - access_denied: live access check failed (LINK_ONLY w/ no shareToken,
 *     archived, deleted, blocked, etc.)
 *
 * Idempotent + safe to fire-and-forget from any access-success branch.
 */
export async function recordForeignWishlistAccess(
  args: RecordForeignWishlistAccessArgs,
): Promise<RecordForeignWishlistAccessResult> {
  if (!args.userId || !args.wishlistId) {
    return { ok: false, reason: 'invalid_input' };
  }

  // Live access check first — never record an entry the user couldn't open
  // right now. This stays in sync with the search-time live re-check.
  const wishlist = await prisma.wishlist.findUnique({
    where: { id: args.wishlistId },
    select: {
      id: true,
      ownerId: true,
      archivedAt: true,
      type: true,
      visibility: true,
      shareToken: true,
    },
  });
  if (!wishlist) return { ok: false, reason: 'wishlist_missing' };
  if (wishlist.ownerId === args.userId) return { ok: false, reason: 'own_wishlist' };
  if (wishlist.archivedAt) return { ok: false, reason: 'wishlist_archived' };
  if (wishlist.type === 'SYSTEM_DRAFTS') return { ok: false, reason: 'access_denied' };
  if (wishlist.visibility === 'LINK_ONLY' && !wishlist.shareToken) {
    // Owner revoked the share token — no recording.
    return { ok: false, reason: 'access_denied' };
  }
  if (wishlist.visibility === 'PRIVATE') {
    // Private wishlists never reach search-time scope; record nothing.
    return { ok: false, reason: 'access_denied' };
  }

  // Normalise sourceRef: keep only for credential-based sources, hash
  // share-tokens to keep raw tokens out of the database.
  let sourceRef: string | null = null;
  if (args.source === 'share_link' && args.sourceRef) {
    sourceRef = hashShareToken(args.sourceRef);
  } else if (args.source === 'curated_selection' && args.sourceRef) {
    sourceRef = args.sourceRef;
  }

  // Atomic upsert keyed by (userId, wishlistId). Bumps lastOpenedAt on every
  // call so the "uses opened" UI can sort by recency later if we want.
  // We refresh `source` and `sourceRef` on update too so a later open via a
  // different credential (owner regenerated shareToken; user re-opened via
  // new link) replaces the stale pin with the current one — otherwise the
  // search-time live check would always reject after a single token reset.
  await prisma.foreignWishlistAccess.upsert({
    where: { userId_wishlistId: { userId: args.userId, wishlistId: args.wishlistId } },
    create: {
      userId: args.userId,
      wishlistId: args.wishlistId,
      source: args.source,
      sourceRef,
      firstOpenedAt: new Date(),
      lastOpenedAt: new Date(),
    },
    update: {
      lastOpenedAt: new Date(),
      source: args.source,
      sourceRef,
    },
  });

  return { ok: true, recorded: true };
}

/**
 * Bulk read of accessible-history wishlist ids for a user. Used by the
 * search service's scope builder so we don't have to import Prisma there
 * (keeps the service narrow).
 */
export async function listForeignWishlistAccessIds(userId: string): Promise<string[]> {
  const rows = await prisma.foreignWishlistAccess.findMany({
    where: { userId },
    select: { wishlistId: true },
  });
  return rows.map((r) => r.wishlistId);
}

export type ForeignWishlistAccessRow = {
  wishlistId: string;
  source: string;
  sourceRef: string | null;
};

/** Bulk read of FWA rows with their source pins. Used by buildAccessibleScope. */
export async function listForeignWishlistAccessRows(userId: string): Promise<ForeignWishlistAccessRow[]> {
  return prisma.foreignWishlistAccess.findMany({
    where: { userId },
    select: { wishlistId: true, source: true, sourceRef: true },
  });
}

export type ForeignWishlistAccessCheck =
  | { allowed: true }
  | { allowed: false; reason: 'not_found' | 'archived' | 'private' | 'drafts' | 'own_wishlist' | 'no_relation' | 'revoked' };

/**
 * Hard live access check for a single (userId, wishlistId). Used by
 * GET /tg/wishlists/:id/access-view (the search-result-click navigation
 * path) and could be called by any future "open by ID" endpoint.
 *
 * Returns allowed=true iff the user has a current right to view the
 * wishlist's content. Considers:
 *   - own_wishlist: blocked here (caller should route to the owner view).
 *   - archived / private / SYSTEM_DRAFTS: rejected.
 *   - LINK_ONLY: requires either a current relation (subscription, profile
 *     follow, santa, active reservation, active secret reservation, live
 *     curated selection subscription) OR an FWA row whose sourceRef pin
 *     matches the current credential.
 *   - PUBLIC_PROFILE: any authenticated user with FWA row OR relation.
 */
export async function checkForeignWishlistLiveAccess(
  userId: string,
  wishlistId: string,
): Promise<ForeignWishlistAccessCheck> {
  const wishlist = await prisma.wishlist.findUnique({
    where: { id: wishlistId },
    select: {
      id: true, ownerId: true, archivedAt: true, type: true,
      visibility: true, shareToken: true,
    },
  });
  if (!wishlist) return { allowed: false, reason: 'not_found' };
  if (wishlist.ownerId === userId) return { allowed: false, reason: 'own_wishlist' };
  if (wishlist.archivedAt) return { allowed: false, reason: 'archived' };
  if (wishlist.type === 'SYSTEM_DRAFTS') return { allowed: false, reason: 'drafts' };
  if (wishlist.visibility === 'PRIVATE') return { allowed: false, reason: 'private' };

  // Pull every relation that could grant ongoing access. Run in parallel.
  const [
    wlSub, profileSub, santaPart, activeRes, publicRes, secretRes,
    curatedSub, fwa,
  ] = await Promise.all([
    prisma.wishlistSubscription.findUnique({
      where: { wishlistId_subscriberId: { wishlistId, subscriberId: userId } },
      select: { id: true },
    }),
    prisma.profileSubscription.findFirst({
      where: { subscriberId: userId, targetUserId: wishlist.ownerId },
      select: { id: true },
    }),
    prisma.santaParticipant.findFirst({
      where: { userId, status: 'JOINED', linkedWishlistId: wishlistId },
      select: { id: true },
    }),
    prisma.reservationMeta.findFirst({
      where: { reserverUserId: userId, active: true, item: { wishlistId } },
      select: { id: true },
    }),
    prisma.item.findFirst({
      where: { wishlistId, reserverUserId: userId, status: { in: ['RESERVED', 'PURCHASED'] } },
      select: { id: true },
    }),
    prisma.secretReservation.findFirst({
      where: { reserverUserId: userId, status: 'ACTIVE', item: { wishlistId } },
      select: { id: true },
    }),
    prisma.curatedSelectionSubscription.findFirst({
      where: {
        subscriberId: userId,
        curatedSelection: { wishlistId, deactivatedAt: null, expiresAt: { gt: new Date() } },
      },
      select: { id: true },
    }),
    prisma.foreignWishlistAccess.findUnique({
      where: { userId_wishlistId: { userId, wishlistId } },
      select: { source: true, sourceRef: true },
    }),
  ]);

  const hasRelation = !!(wlSub || profileSub || santaPart || activeRes || publicRes || secretRes || curatedSub);
  if (hasRelation) return { allowed: true };

  // No live relation — fall back to the FWA pin. For LINK_ONLY require the
  // pin to still match the current credential.
  if (!fwa) return { allowed: false, reason: 'no_relation' };

  if (wishlist.visibility === 'LINK_ONLY') {
    if (!wishlist.shareToken) return { allowed: false, reason: 'revoked' };
    if (fwa.source === 'share_link') {
      if (!fwa.sourceRef) return { allowed: false, reason: 'revoked' };
      if (fwa.sourceRef !== hashShareToken(wishlist.shareToken)) {
        return { allowed: false, reason: 'revoked' };
      }
      return { allowed: true };
    }
    if (fwa.source === 'curated_selection') {
      if (!fwa.sourceRef) return { allowed: false, reason: 'revoked' };
      const sel = await prisma.curatedSelection.findUnique({
        where: { id: fwa.sourceRef },
        select: { wishlistId: true, deactivatedAt: true, expiresAt: true },
      });
      if (!sel || sel.wishlistId !== wishlistId || sel.deactivatedAt || sel.expiresAt < new Date()) {
        return { allowed: false, reason: 'revoked' };
      }
      return { allowed: true };
    }
    // Any other source (subscription/reservation/etc) reached here means the
    // backing relation has gone — treat as revoked. direct_open/unknown for
    // LINK_ONLY also gets rejected by design (we can't prove the user still
    // has the link).
    return { allowed: false, reason: 'revoked' };
  }

  // PUBLIC_PROFILE — any FWA row is enough to keep it findable. Visibility
  // alone makes the content public; FWA is just there to scope search.
  return { allowed: true };
}
