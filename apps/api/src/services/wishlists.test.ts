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
  trackProductEvent: vi.fn(),
}));

vi.mock('@wishlist/db', async () => {
  // Real Prisma namespace for the P2002 error class — test sets it on the
  // mocked module so `err instanceof Prisma.PrismaClientKnownRequestError`
  // inside the service code resolves correctly.
  const actual = await vi.importActual<typeof import('@wishlist/db')>('@wishlist/db');
  return {
    Prisma: actual.Prisma,
    prisma: {
      item: shared.item,
      wishlistItemPlacement: shared.wishlistItemPlacement,
      wishlist: shared.wishlist,
    },
  };
});

vi.mock('./analytics', () => ({
  trackProductEvent: shared.trackProductEvent,
}));

import { Prisma } from '@wishlist/db';
import {
  DRAFTS_ITEM_LIMIT,
  reassignPrimaryBeforeWishlistDelete,
  createGetOrCreateDraftsWishlist,
  createGetOrCreateDefaultWishlist,
  DEFAULT_WISHLIST_EMOJI,
  evaluateGuestConversion,
} from './wishlists';

beforeEach(() => {
  for (const m of [
    shared.item.findMany,
    shared.item.update,
    shared.wishlistItemPlacement.findFirst,
    shared.wishlist.findFirst,
    shared.wishlist.create,
    shared.wishlist.count,
    shared.trackProductEvent,
  ]) {
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

describe('createGetOrCreateDefaultWishlist (E04)', () => {
  const buildFactory = () => {
    const trackEvent = vi.fn();
    return { trackEvent, factory: createGetOrCreateDefaultWishlist({ trackEvent }) };
  };

  it('returns existing REGULAR wishlist when user already owns one — no create, no events', async () => {
    const { trackEvent, factory } = buildFactory();
    shared.wishlist.findFirst.mockResolvedValueOnce({
      id: 'wl-manual',
      slug: 'wl-abc123def456',
      title: 'Мои подарки',
      isDefault: false,
    });

    const result = await factory('user-1', 'ru');

    expect(result).toEqual({
      id: 'wl-manual',
      slug: 'wl-abc123def456',
      title: 'Мои подарки',
      isDefault: false,
      alreadyExisted: true,
    });
    expect(shared.wishlist.create).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
    expect(shared.trackProductEvent).not.toHaveBeenCalled();
  });

  it('returns existing default (isDefault=true) on repeat bootstrap — no duplicate, no events', async () => {
    const { trackEvent, factory } = buildFactory();
    shared.wishlist.findFirst.mockResolvedValueOnce({
      id: 'wl-default-existing',
      slug: 'wl-aaaaaaaaaaaa',
      title: 'Мой вишлист',
      isDefault: true,
    });

    const result = await factory('user-2', 'ru');

    expect(result.alreadyExisted).toBe(true);
    expect(result.id).toBe('wl-default-existing');
    expect(shared.wishlist.create).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
    expect(shared.trackProductEvent).not.toHaveBeenCalled();
  });

  it('creates a fresh REGULAR wishlist with localized title + 🎁 + isDefault=true and emits BOTH legacy + new events', async () => {
    const { trackEvent, factory } = buildFactory();
    shared.wishlist.findFirst.mockResolvedValueOnce(null);
    shared.wishlist.create.mockResolvedValueOnce({
      id: 'wl-new',
      slug: 'wl-newuuid12345',
      title: 'Мой вишлист',
      isDefault: true,
    });

    const result = await factory('user-3', 'ru');

    expect(result).toEqual({
      id: 'wl-new',
      slug: 'wl-newuuid12345',
      title: 'Мой вишлист',
      isDefault: true,
      alreadyExisted: false,
    });
    expect(shared.wishlist.create).toHaveBeenCalledOnce();
    const arg = shared.wishlist.create.mock.calls[0]![0];
    expect(arg.data).toMatchObject({
      ownerId: 'user-3',
      title: 'Мой вишлист',
      emoji: DEFAULT_WISHLIST_EMOJI,
      type: 'REGULAR',
      isDefault: true,
    });
    expect(arg.data.slug).toMatch(/^wl-[a-f0-9-]{12}$/);
    // Legacy wishlist_created — keeps funnel/cohort dashboards counting all
    // wishlist creations including the E04 cohort.
    expect(trackEvent).toHaveBeenCalledWith('wishlist_created', 'user-3', expect.objectContaining({
      wishlistId: 'wl-new',
      wishlistType: 'REGULAR',
      source: 'auto_default',
      platform: 'system',
      isFirstRegularWishlist: true,
    }));
    // New PRODUCT_EVENTS taxonomy — E04-specific signal.
    expect(shared.trackProductEvent).toHaveBeenCalledOnce();
    expect(shared.trackProductEvent).toHaveBeenCalledWith({
      event: 'wishlist.default_created',
      userId: 'user-3',
      props: { wishlistId: 'wl-new', locale: 'ru' },
    });
  });

  it('honors English locale — title resolved via t(default_wishlist_title, en)', async () => {
    const { trackEvent, factory } = buildFactory();
    shared.wishlist.findFirst.mockResolvedValueOnce(null);
    shared.wishlist.create.mockResolvedValueOnce({
      id: 'wl-en',
      slug: 'wl-enenenenenen',
      title: 'My wishlist',
      isDefault: true,
    });

    await factory('user-4', 'en');

    const arg = shared.wishlist.create.mock.calls[0]![0];
    expect(arg.data.title).toBe('My wishlist');
    expect(trackEvent).toHaveBeenCalled();
    expect(shared.trackProductEvent).toHaveBeenCalledWith(
      expect.objectContaining({ props: expect.objectContaining({ locale: 'en' }) }),
    );
  });

  it('recovers from a P2002 race (partial-unique-index OR slug collision) by re-fetching whichever REGULAR won — emits NO events on race recovery', async () => {
    const { trackEvent, factory } = buildFactory();
    // Initial findFirst: empty (we believe we need to create)
    shared.wishlist.findFirst.mockResolvedValueOnce(null);
    // Create racing with another bootstrap → P2002
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique constraint', {
      code: 'P2002',
      clientVersion: 'test',
    });
    shared.wishlist.create.mockRejectedValueOnce(p2002);
    // Re-fetch picks up the racing-side write
    shared.wishlist.findFirst.mockResolvedValueOnce({
      id: 'wl-raced-in',
      slug: 'wl-rcrcrcrcrcrc',
      title: 'Мой вишлист',
      isDefault: true,
    });

    const result = await factory('user-5', 'ru');

    expect(result).toEqual({
      id: 'wl-raced-in',
      slug: 'wl-rcrcrcrcrcrc',
      title: 'Мой вишлист',
      isDefault: true,
      alreadyExisted: true,
    });
    // Critical: on race recovery the loser must NOT double-emit events
    // (the winner already emitted them when its own create succeeded).
    expect(trackEvent).not.toHaveBeenCalled();
    expect(shared.trackProductEvent).not.toHaveBeenCalled();
  });

  it('rethrows non-P2002 Prisma errors (defensive — caller decides what to do)', async () => {
    const { trackEvent, factory } = buildFactory();
    shared.wishlist.findFirst.mockResolvedValueOnce(null);
    const otherErr = new Prisma.PrismaClientKnownRequestError('foreign-key', {
      code: 'P2003',
      clientVersion: 'test',
    });
    shared.wishlist.create.mockRejectedValueOnce(otherErr);

    await expect(factory('user-6', 'ru')).rejects.toBe(otherErr);
    expect(trackEvent).not.toHaveBeenCalled();
    expect(shared.trackProductEvent).not.toHaveBeenCalled();
  });

  it('prefers oldest REGULAR by createdAt asc when multiple exist (canonical "first")', async () => {
    const { factory } = buildFactory();
    shared.wishlist.findFirst.mockResolvedValueOnce({
      id: 'wl-oldest',
      slug: 'wl-oldoldoldold',
      title: 'Первый',
      isDefault: false,
    });

    await factory('user-7', 'ru');

    const arg = shared.wishlist.findFirst.mock.calls[0]![0];
    expect(arg.where).toEqual({ ownerId: 'user-7', type: 'REGULAR' });
    expect(arg.orderBy).toEqual({ createdAt: 'asc' });
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
