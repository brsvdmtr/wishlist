// Unit tests for services/foreign-wishlist-access.ts.
//
// The helper is mostly a Prisma upsert + a live-access pre-check. Mock
// Prisma at the boundary and verify the access gates trigger the right
// outcomes — own-wishlist short-circuits, archived rejects, missing share
// token rejects, the happy path performs the upsert.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const shared = vi.hoisted(() => ({
  wishlist: { findUnique: vi.fn() },
  fwa: { upsert: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
  wishlistSubscription: { findUnique: vi.fn() },
  profileSubscription: { findFirst: vi.fn() },
  santaParticipant: { findFirst: vi.fn() },
  reservationMeta: { findFirst: vi.fn() },
  item: { findFirst: vi.fn() },
  secretReservation: { findFirst: vi.fn() },
  curatedSelectionSubscription: { findFirst: vi.fn() },
  curatedSelection: { findUnique: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    wishlist: shared.wishlist,
    foreignWishlistAccess: shared.fwa,
    wishlistSubscription: shared.wishlistSubscription,
    profileSubscription: shared.profileSubscription,
    santaParticipant: shared.santaParticipant,
    reservationMeta: shared.reservationMeta,
    item: shared.item,
    secretReservation: shared.secretReservation,
    curatedSelectionSubscription: shared.curatedSelectionSubscription,
    curatedSelection: shared.curatedSelection,
  },
}));

import {
  recordForeignWishlistAccess,
  isValidForeignWishlistAccessSource,
  listForeignWishlistAccessIds,
  checkForeignWishlistLiveAccess,
  hashShareToken,
  FOREIGN_WISHLIST_ACCESS_SOURCES,
} from './foreign-wishlist-access';

beforeEach(() => {
  for (const k of Object.keys(shared)) {
    // Iterate over all mocked Prisma table proxies and reset every fn.
    const table = (shared as Record<string, Record<string, ReturnType<typeof vi.fn>>>)[k];
    if (!table) continue;
    for (const fnKey of Object.keys(table)) {
      const fn = table[fnKey];
      if (fn && typeof fn.mockReset === 'function') fn.mockReset();
    }
  }
  // Default: no relations exist unless the test overrides.
  shared.wishlistSubscription.findUnique.mockResolvedValue(null);
  shared.profileSubscription.findFirst.mockResolvedValue(null);
  shared.santaParticipant.findFirst.mockResolvedValue(null);
  shared.reservationMeta.findFirst.mockResolvedValue(null);
  shared.item.findFirst.mockResolvedValue(null);
  shared.secretReservation.findFirst.mockResolvedValue(null);
  shared.curatedSelectionSubscription.findFirst.mockResolvedValue(null);
  shared.fwa.findUnique.mockResolvedValue(null);
});

describe('isValidForeignWishlistAccessSource', () => {
  it('accepts all canonical sources', () => {
    for (const s of FOREIGN_WISHLIST_ACCESS_SOURCES) {
      expect(isValidForeignWishlistAccessSource(s)).toBe(true);
    }
  });

  it('rejects unknown strings', () => {
    expect(isValidForeignWishlistAccessSource('hax')).toBe(false);
    expect(isValidForeignWishlistAccessSource('')).toBe(false);
  });
});

describe('recordForeignWishlistAccess', () => {
  it('refuses empty inputs', async () => {
    const r = await recordForeignWishlistAccess({ userId: '', wishlistId: 'wl', source: 'direct_open' });
    expect(r.ok).toBe(false);
  });

  it('returns wishlist_missing when no row exists', async () => {
    shared.wishlist.findUnique.mockResolvedValue(null);
    const r = await recordForeignWishlistAccess({ userId: 'u1', wishlistId: 'wl-x', source: 'direct_open' });
    expect(r).toEqual({ ok: false, reason: 'wishlist_missing' });
    expect(shared.fwa.upsert).not.toHaveBeenCalled();
  });

  it('short-circuits on own wishlist (never records)', async () => {
    shared.wishlist.findUnique.mockResolvedValue({
      id: 'wl-1', ownerId: 'u1', archivedAt: null, type: 'REGULAR', visibility: 'LINK_ONLY', shareToken: 't',
    });
    const r = await recordForeignWishlistAccess({ userId: 'u1', wishlistId: 'wl-1', source: 'share_link' });
    expect(r).toEqual({ ok: false, reason: 'own_wishlist' });
    expect(shared.fwa.upsert).not.toHaveBeenCalled();
  });

  it('rejects archived wishlists', async () => {
    shared.wishlist.findUnique.mockResolvedValue({
      id: 'wl-1', ownerId: 'owner', archivedAt: new Date(), type: 'REGULAR', visibility: 'LINK_ONLY', shareToken: 't',
    });
    const r = await recordForeignWishlistAccess({ userId: 'u1', wishlistId: 'wl-1', source: 'subscription' });
    expect(r).toEqual({ ok: false, reason: 'wishlist_archived' });
  });

  it('rejects SYSTEM_DRAFTS wishlists', async () => {
    shared.wishlist.findUnique.mockResolvedValue({
      id: 'wl-1', ownerId: 'owner', archivedAt: null, type: 'SYSTEM_DRAFTS', visibility: 'LINK_ONLY', shareToken: 't',
    });
    const r = await recordForeignWishlistAccess({ userId: 'u1', wishlistId: 'wl-1', source: 'direct_open' });
    expect(r).toEqual({ ok: false, reason: 'access_denied' });
  });

  it('rejects LINK_ONLY wishlists with revoked share token', async () => {
    shared.wishlist.findUnique.mockResolvedValue({
      id: 'wl-1', ownerId: 'owner', archivedAt: null, type: 'REGULAR', visibility: 'LINK_ONLY', shareToken: null,
    });
    const r = await recordForeignWishlistAccess({ userId: 'u1', wishlistId: 'wl-1', source: 'share_link' });
    expect(r).toEqual({ ok: false, reason: 'access_denied' });
    expect(shared.fwa.upsert).not.toHaveBeenCalled();
  });

  it('rejects PRIVATE wishlists', async () => {
    shared.wishlist.findUnique.mockResolvedValue({
      id: 'wl-1', ownerId: 'owner', archivedAt: null, type: 'REGULAR', visibility: 'PRIVATE', shareToken: null,
    });
    const r = await recordForeignWishlistAccess({ userId: 'u1', wishlistId: 'wl-1', source: 'direct_open' });
    expect(r).toEqual({ ok: false, reason: 'access_denied' });
  });

  it('upserts on happy path (foreign + active + valid)', async () => {
    shared.wishlist.findUnique.mockResolvedValue({
      id: 'wl-1', ownerId: 'owner', archivedAt: null, type: 'REGULAR', visibility: 'LINK_ONLY', shareToken: 'tok',
    });
    shared.fwa.upsert.mockResolvedValue({ id: 'fwa-1' });
    const r = await recordForeignWishlistAccess({ userId: 'u1', wishlistId: 'wl-1', source: 'share_link' });
    expect(r.ok).toBe(true);
    expect(shared.fwa.upsert).toHaveBeenCalledOnce();
    const upsertArgs = shared.fwa.upsert.mock.calls[0]?.[0] as {
      where: unknown;
      create: { source: string };
      update: { lastOpenedAt: Date };
    };
    expect(upsertArgs.where).toEqual({ userId_wishlistId: { userId: 'u1', wishlistId: 'wl-1' } });
    expect(upsertArgs.create.source).toBe('share_link');
    expect(upsertArgs.update.lastOpenedAt).toBeInstanceOf(Date);
  });
});

describe('checkForeignWishlistLiveAccess', () => {
  const baseWl = {
    id: 'wl-1',
    ownerId: 'owner',
    archivedAt: null as Date | null,
    type: 'REGULAR' as const,
    visibility: 'LINK_ONLY' as const,
    shareToken: 'live-token',
  };

  it('returns not_found when the wishlist is missing', async () => {
    shared.wishlist.findUnique.mockResolvedValue(null);
    const r = await checkForeignWishlistLiveAccess('u1', 'wl-x');
    expect(r).toEqual({ allowed: false, reason: 'not_found' });
  });

  it('returns own_wishlist when caller owns it', async () => {
    shared.wishlist.findUnique.mockResolvedValue({ ...baseWl, ownerId: 'u1' });
    const r = await checkForeignWishlistLiveAccess('u1', 'wl-1');
    expect(r).toEqual({ allowed: false, reason: 'own_wishlist' });
  });

  it('returns archived for archived wishlists', async () => {
    shared.wishlist.findUnique.mockResolvedValue({ ...baseWl, archivedAt: new Date() });
    const r = await checkForeignWishlistLiveAccess('u1', 'wl-1');
    expect(r).toEqual({ allowed: false, reason: 'archived' });
  });

  it('returns drafts for SYSTEM_DRAFTS wishlists', async () => {
    shared.wishlist.findUnique.mockResolvedValue({ ...baseWl, type: 'SYSTEM_DRAFTS' });
    const r = await checkForeignWishlistLiveAccess('u1', 'wl-1');
    expect(r).toEqual({ allowed: false, reason: 'drafts' });
  });

  it('returns private for PRIVATE wishlists, even with relation', async () => {
    shared.wishlist.findUnique.mockResolvedValue({ ...baseWl, visibility: 'PRIVATE' });
    shared.wishlistSubscription.findUnique.mockResolvedValue({ id: 's1' });
    const r = await checkForeignWishlistLiveAccess('u1', 'wl-1');
    expect(r).toEqual({ allowed: false, reason: 'private' });
  });

  it('allows LINK_ONLY when the user has a live subscription (relation wins)', async () => {
    shared.wishlist.findUnique.mockResolvedValue(baseWl);
    shared.wishlistSubscription.findUnique.mockResolvedValue({ id: 's1' });
    const r = await checkForeignWishlistLiveAccess('u1', 'wl-1');
    expect(r).toEqual({ allowed: true });
  });

  it('allows LINK_ONLY when FWA pin matches the current shareToken hash', async () => {
    shared.wishlist.findUnique.mockResolvedValue(baseWl);
    shared.fwa.findUnique.mockResolvedValue({
      source: 'share_link',
      sourceRef: hashShareToken('live-token'),
    });
    const r = await checkForeignWishlistLiveAccess('u1', 'wl-1');
    expect(r).toEqual({ allowed: true });
  });

  it('rejects LINK_ONLY as revoked when FWA pin is stale (owner regenerated shareToken)', async () => {
    shared.wishlist.findUnique.mockResolvedValue(baseWl); // current token = "live-token"
    shared.fwa.findUnique.mockResolvedValue({
      source: 'share_link',
      sourceRef: hashShareToken('old-token-since-regenerated'),
    });
    const r = await checkForeignWishlistLiveAccess('u1', 'wl-1');
    expect(r).toEqual({ allowed: false, reason: 'revoked' });
  });

  it('rejects LINK_ONLY when shareToken has been entirely revoked (null)', async () => {
    shared.wishlist.findUnique.mockResolvedValue({ ...baseWl, shareToken: null });
    shared.fwa.findUnique.mockResolvedValue({
      source: 'share_link', sourceRef: hashShareToken('anything'),
    });
    const r = await checkForeignWishlistLiveAccess('u1', 'wl-1');
    expect(r).toEqual({ allowed: false, reason: 'revoked' });
  });

  it('rejects LINK_ONLY with no relation AND no FWA row at all', async () => {
    shared.wishlist.findUnique.mockResolvedValue(baseWl);
    const r = await checkForeignWishlistLiveAccess('u1', 'wl-1');
    expect(r).toEqual({ allowed: false, reason: 'no_relation' });
  });

  it('rejects LINK_ONLY with a FWA source=direct_open (cannot prove the user still has the link)', async () => {
    shared.wishlist.findUnique.mockResolvedValue(baseWl);
    shared.fwa.findUnique.mockResolvedValue({ source: 'direct_open', sourceRef: null });
    const r = await checkForeignWishlistLiveAccess('u1', 'wl-1');
    expect(r).toEqual({ allowed: false, reason: 'revoked' });
  });

  it('allows LINK_ONLY with curated_selection FWA pin pointing to an active selection', async () => {
    shared.wishlist.findUnique.mockResolvedValue(baseWl);
    shared.fwa.findUnique.mockResolvedValue({
      source: 'curated_selection', sourceRef: 'sel-1',
    });
    shared.curatedSelection.findUnique.mockResolvedValue({
      wishlistId: 'wl-1', deactivatedAt: null, expiresAt: new Date(Date.now() + 60_000),
    });
    const r = await checkForeignWishlistLiveAccess('u1', 'wl-1');
    expect(r).toEqual({ allowed: true });
  });

  it('rejects LINK_ONLY with curated_selection FWA pin pointing to a deactivated selection', async () => {
    shared.wishlist.findUnique.mockResolvedValue(baseWl);
    shared.fwa.findUnique.mockResolvedValue({
      source: 'curated_selection', sourceRef: 'sel-1',
    });
    shared.curatedSelection.findUnique.mockResolvedValue({
      wishlistId: 'wl-1', deactivatedAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    });
    const r = await checkForeignWishlistLiveAccess('u1', 'wl-1');
    expect(r).toEqual({ allowed: false, reason: 'revoked' });
  });

  it('rejects LINK_ONLY with curated_selection FWA pin pointing to an expired selection', async () => {
    shared.wishlist.findUnique.mockResolvedValue(baseWl);
    shared.fwa.findUnique.mockResolvedValue({
      source: 'curated_selection', sourceRef: 'sel-1',
    });
    shared.curatedSelection.findUnique.mockResolvedValue({
      wishlistId: 'wl-1', deactivatedAt: null, expiresAt: new Date(Date.now() - 60_000),
    });
    const r = await checkForeignWishlistLiveAccess('u1', 'wl-1');
    expect(r).toEqual({ allowed: false, reason: 'revoked' });
  });

  it('rejects curated_selection FWA pin that points to a DIFFERENT wishlist (cross-binding guard)', async () => {
    shared.wishlist.findUnique.mockResolvedValue(baseWl);
    shared.fwa.findUnique.mockResolvedValue({
      source: 'curated_selection', sourceRef: 'sel-1',
    });
    shared.curatedSelection.findUnique.mockResolvedValue({
      wishlistId: 'wl-OTHER', deactivatedAt: null, expiresAt: new Date(Date.now() + 60_000),
    });
    const r = await checkForeignWishlistLiveAccess('u1', 'wl-1');
    expect(r).toEqual({ allowed: false, reason: 'revoked' });
  });

  it('allows PUBLIC_PROFILE wishlists with any FWA row regardless of source', async () => {
    shared.wishlist.findUnique.mockResolvedValue({ ...baseWl, visibility: 'PUBLIC_PROFILE', shareToken: null });
    shared.fwa.findUnique.mockResolvedValue({ source: 'direct_open', sourceRef: null });
    const r = await checkForeignWishlistLiveAccess('u1', 'wl-1');
    expect(r).toEqual({ allowed: true });
  });

  it('allows when the user has an active SecretReservation in the wishlist (relation wins for LINK_ONLY)', async () => {
    shared.wishlist.findUnique.mockResolvedValue(baseWl);
    shared.secretReservation.findFirst.mockResolvedValue({ id: 'sr-1' });
    const r = await checkForeignWishlistLiveAccess('u1', 'wl-1');
    expect(r).toEqual({ allowed: true });
  });

  it('allows when the user owns a public reservation (Item.reserverUserId) in the wishlist', async () => {
    shared.wishlist.findUnique.mockResolvedValue(baseWl);
    shared.item.findFirst.mockResolvedValue({ id: 'i-1' });
    const r = await checkForeignWishlistLiveAccess('u1', 'wl-1');
    expect(r).toEqual({ allowed: true });
  });
});

describe('listForeignWishlistAccessIds', () => {
  it('returns the wishlist id list for the user', async () => {
    shared.fwa.findMany.mockResolvedValue([{ wishlistId: 'a' }, { wishlistId: 'b' }]);
    const r = await listForeignWishlistAccessIds('u1');
    expect(r).toEqual(['a', 'b']);
    expect(shared.fwa.findMany).toHaveBeenCalledWith({
      where: { userId: 'u1' },
      select: { wishlistId: true },
    });
  });

  it('returns [] when the user has no history', async () => {
    shared.fwa.findMany.mockResolvedValue([]);
    expect(await listForeignWishlistAccessIds('u1')).toEqual([]);
  });
});
