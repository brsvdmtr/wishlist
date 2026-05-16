// Unit tests for services/foreign-wishlist-access.ts.
//
// The helper is mostly a Prisma upsert + a live-access pre-check. Mock
// Prisma at the boundary and verify the access gates trigger the right
// outcomes — own-wishlist short-circuits, archived rejects, missing share
// token rejects, the happy path performs the upsert.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const shared = vi.hoisted(() => ({
  wishlist: { findUnique: vi.fn() },
  fwa: { upsert: vi.fn(), findMany: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    wishlist: shared.wishlist,
    foreignWishlistAccess: shared.fwa,
  },
}));

import {
  recordForeignWishlistAccess,
  isValidForeignWishlistAccessSource,
  listForeignWishlistAccessIds,
  FOREIGN_WISHLIST_ACCESS_SOURCES,
} from './foreign-wishlist-access';

beforeEach(() => {
  shared.wishlist.findUnique.mockReset();
  shared.fwa.upsert.mockReset();
  shared.fwa.findMany.mockReset();
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
