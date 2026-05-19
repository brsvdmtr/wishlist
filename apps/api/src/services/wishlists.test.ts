// Unit tests for services/wishlists.ts.
//
// Three exports: DRAFTS_ITEM_LIMIT constant, reassignPrimaryBeforeWishlistDelete
// helper, and createGetOrCreateDraftsWishlist factory. All Prisma access is
// mocked at the module boundary — the goal here is to pin the orchestration
// logic (which queries, in what order, with what data) without a real DB.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  item: { findMany: vi.fn(), update: vi.fn() },
  wishlistItemPlacement: { findFirst: vi.fn() },
  wishlist: { findFirst: vi.fn(), create: vi.fn(), count: vi.fn() },
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    item: shared.item,
    wishlistItemPlacement: shared.wishlistItemPlacement,
    wishlist: shared.wishlist,
  },
}));

import {
  DRAFTS_ITEM_LIMIT,
  reassignPrimaryBeforeWishlistDelete,
  createGetOrCreateDraftsWishlist,
  evaluateGuestConversion,
} from './wishlists';

beforeEach(() => {
  for (const m of [shared.item.findMany, shared.item.update, shared.wishlistItemPlacement.findFirst, shared.wishlist.findFirst, shared.wishlist.create, shared.wishlist.count]) {
    m.mockReset();
  }
});

describe('DRAFTS_ITEM_LIMIT', () => {
  it('caps the SYSTEM_DRAFTS wishlist at 50 items', () => {
    expect(DRAFTS_ITEM_LIMIT).toBe(50);
  });
});

describe('reassignPrimaryBeforeWishlistDelete', () => {
  it('no-ops when the deleting wishlist has no primary items', async () => {
    shared.item.findMany.mockResolvedValueOnce([]);
    await reassignPrimaryBeforeWishlistDelete('w1');
    expect(shared.wishlistItemPlacement.findFirst).not.toHaveBeenCalled();
    expect(shared.item.update).not.toHaveBeenCalled();
  });

  it('reassigns primary for items that have another placement (oldest wins)', async () => {
    shared.item.findMany.mockResolvedValueOnce([{ id: 'i1' }, { id: 'i2' }]);
    shared.wishlistItemPlacement.findFirst
      .mockResolvedValueOnce({ wishlistId: 'w2', position: 5, categoryId: 'c1' })
      .mockResolvedValueOnce({ wishlistId: 'w3', position: 1, categoryId: null });
    shared.item.update.mockResolvedValue({});

    await reassignPrimaryBeforeWishlistDelete('w1');

    expect(shared.item.update).toHaveBeenCalledTimes(2);
    expect(shared.item.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'i1' },
      data: { wishlistId: 'w2', position: 5, categoryId: 'c1' },
    });
    expect(shared.item.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'i2' },
      data: { wishlistId: 'w3', position: 1, categoryId: null },
    });
  });

  it('skips items whose only placement is the deleting wishlist (let cascade handle)', async () => {
    shared.item.findMany.mockResolvedValueOnce([{ id: 'lone1' }, { id: 'lone2' }]);
    shared.wishlistItemPlacement.findFirst.mockResolvedValue(null);

    await reassignPrimaryBeforeWishlistDelete('w1');

    expect(shared.item.update).not.toHaveBeenCalled();
  });

  it('orders the placement lookup by addedAt ascending (oldest = stable target)', async () => {
    shared.item.findMany.mockResolvedValueOnce([{ id: 'i1' }]);
    shared.wishlistItemPlacement.findFirst.mockResolvedValueOnce({ wishlistId: 'w2', position: 0, categoryId: null });
    shared.item.update.mockResolvedValueOnce({});

    await reassignPrimaryBeforeWishlistDelete('w1');

    const arg = shared.wishlistItemPlacement.findFirst.mock.calls[0]![0];
    expect(arg.orderBy).toEqual({ addedAt: 'asc' });
    expect(arg.where).toEqual({ itemId: 'i1', wishlistId: { not: 'w1' } });
  });
});

describe('createGetOrCreateDraftsWishlist', () => {
  it('returns the existing SYSTEM_DRAFTS wishlist without creating a new one', async () => {
    const trackEvent = vi.fn();
    const factory = createGetOrCreateDraftsWishlist({ trackEvent });
    shared.wishlist.findFirst.mockResolvedValueOnce({ id: 'drafts-existing' });

    const result = await factory('user-1');

    expect(result).toEqual({ id: 'drafts-existing' });
    expect(shared.wishlist.create).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('creates a fresh SYSTEM_DRAFTS wishlist and tracks the canonical analytics event', async () => {
    const trackEvent = vi.fn();
    const factory = createGetOrCreateDraftsWishlist({ trackEvent });
    shared.wishlist.findFirst.mockResolvedValueOnce(null);
    shared.wishlist.create.mockResolvedValueOnce({ id: 'drafts-new' });
    shared.wishlist.count.mockResolvedValueOnce(1); // this is the user's first wishlist

    const result = await factory('user-2');

    expect(result).toEqual({ id: 'drafts-new' });
    expect(shared.wishlist.create).toHaveBeenCalledOnce();
    const arg = shared.wishlist.create.mock.calls[0]![0];
    expect(arg.data.ownerId).toBe('user-2');
    expect(arg.data.type).toBe('SYSTEM_DRAFTS');
    expect(arg.data.title).toBe('Неразобранное');
    // crypto.randomUUID().slice(0, 12) keeps the embedded hyphen at index 8,
    // so the suffix is hex + hyphen (e.g. "abcd1234-ab1").
    expect(arg.data.slug).toMatch(/^drafts-[a-f0-9-]{12}$/);

    expect(trackEvent).toHaveBeenCalledWith('wishlist_created', 'user-2', expect.objectContaining({
      wishlistId: 'drafts-new',
      wishlistType: 'SYSTEM_DRAFTS',
      source: 'auto_drafts',
      isFirstAnyWishlist: true,
    }));
  });

  it('reports isFirstAnyWishlist: false when user already has other wishlists', async () => {
    const trackEvent = vi.fn();
    const factory = createGetOrCreateDraftsWishlist({ trackEvent });
    shared.wishlist.findFirst.mockResolvedValueOnce(null);
    shared.wishlist.create.mockResolvedValueOnce({ id: 'drafts-co' });
    shared.wishlist.count.mockResolvedValueOnce(3); // already has 2 + drafts = 3

    await factory('user-3');

    expect(trackEvent.mock.calls[0]![2]).toMatchObject({ isFirstAnyWishlist: false });
  });
});

describe('evaluateGuestConversion', () => {
  it('emits with source=referral when user has referredByUserId on first wishlist', () => {
    expect(
      evaluateGuestConversion({
        existingRegularWishlistCount: 1,
        referredByUserId: 'inviter_42',
        firstAcquisitionSource: null,
      }),
    ).toEqual({ emit: true, source: 'referral' });
  });

  it('emits with source=share_link when first-touch was share_link', () => {
    expect(
      evaluateGuestConversion({
        existingRegularWishlistCount: 1,
        referredByUserId: null,
        firstAcquisitionSource: 'share_link',
      }),
    ).toEqual({ emit: true, source: 'share_link' });
  });

  it.each([
    'curated_selection',
    'public_profile',
    'shared',
  ])('emits with source=%s when first-touch matches the bounded list', (src) => {
    expect(
      evaluateGuestConversion({
        existingRegularWishlistCount: 1,
        referredByUserId: null,
        firstAcquisitionSource: src,
      }),
    ).toEqual({ emit: true, source: src });
  });

  it('referral wins over acquisition source when both present', () => {
    expect(
      evaluateGuestConversion({
        existingRegularWishlistCount: 1,
        referredByUserId: 'inviter_42',
        firstAcquisitionSource: 'share_link',
      }),
    ).toEqual({ emit: true, source: 'referral' });
  });

  it('does NOT emit on 2nd+ wishlist (existingRegular > 1)', () => {
    expect(
      evaluateGuestConversion({
        existingRegularWishlistCount: 2,
        referredByUserId: 'inviter_42',
        firstAcquisitionSource: 'share_link',
      }),
    ).toEqual({ emit: false });
  });

  it('does NOT emit for organic / direct users (no referral, no shared-content acquisition)', () => {
    expect(
      evaluateGuestConversion({
        existingRegularWishlistCount: 1,
        referredByUserId: null,
        firstAcquisitionSource: null,
      }),
    ).toEqual({ emit: false });
    expect(
      evaluateGuestConversion({
        existingRegularWishlistCount: 1,
        referredByUserId: null,
        firstAcquisitionSource: 'direct',
      }),
    ).toEqual({ emit: false });
    expect(
      evaluateGuestConversion({
        existingRegularWishlistCount: 1,
        referredByUserId: null,
        firstAcquisitionSource: 'organic',
      }),
    ).toEqual({ emit: false });
  });

  it('does NOT emit if existingRegular is 0 (defensive — shouldn`t happen in practice)', () => {
    expect(
      evaluateGuestConversion({
        existingRegularWishlistCount: 0,
        referredByUserId: 'x',
        firstAcquisitionSource: 'share_link',
      }),
    ).toEqual({ emit: false });
  });
});
