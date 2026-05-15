// Unit tests for services/url-import.ts createImportUrlForUser factory.
//
// The function composes: draftsWishlist lookup, capacity gate, parseUrl,
// image download/cache, transactional Item insert + placement, and analytics
// events. Tests cover the branching: capacity gate, parser-result states
// (ok / partial / failed / threw), image-cache fallback path, transaction
// rollback + orphaned-image cleanup, first-item analytics.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  itemCount: vi.fn(),
  itemCreate: vi.fn(),
  itemCountAll: vi.fn(),
  $transaction: vi.fn(),
  parseUrl: vi.fn(),
  ensureItemPlacement: vi.fn(),
  downloadAndProcessImage: vi.fn(),
  deleteUploadFile: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock('@wishlist/db', () => {
  const item = { count: shared.itemCount, create: shared.itemCreate };
  return {
    prisma: {
      item,
      wishlistItemPlacement: {},
      wishlistCategory: {},
      $transaction: shared.$transaction,
    },
  };
});

vi.mock('../url-parser.js', () => ({
  parseUrl: shared.parseUrl,
}));

vi.mock('../placements/ensureItemPlacement', () => ({
  ensureItemPlacement: shared.ensureItemPlacement,
}));

vi.mock('../uploads/imageProcessor', () => ({
  downloadAndProcessImage: shared.downloadAndProcessImage,
}));

vi.mock('../uploads/uploadCleanup', () => ({
  deleteUploadFile: shared.deleteUploadFile,
}));

vi.mock('../logger', () => ({
  default: {
    warn: shared.loggerWarn,
    info: shared.loggerInfo,
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  },
}));

import { createImportUrlForUser } from './url-import';

// Each test re-creates the function so we get clean closure state.
let trackEvent: ReturnType<typeof vi.fn>;
let getOrCreateDraftsWishlist: ReturnType<typeof vi.fn>;
let importUrlForUser: ReturnType<typeof createImportUrlForUser>;

beforeEach(() => {
  for (const v of Object.values(shared)) (v as ReturnType<typeof vi.fn>).mockReset?.();
  shared.itemCount.mockResolvedValue(0);
  shared.itemCountAll.mockResolvedValue(1);
  // Item count call sequence: first call = drafts capacity, second = totalUserItems.
  let nthItemCount = 0;
  shared.itemCount.mockImplementation(() => {
    nthItemCount += 1;
    if (nthItemCount === 1) return Promise.resolve(0); // drafts capacity OK
    return Promise.resolve(2); // total user items
  });

  shared.$transaction.mockImplementation(async (fn) => {
    // The tx object exposes the same item / placement / category interfaces
    // as prisma. Just pass the same mocks.
    return fn({
      item: { create: shared.itemCreate },
      wishlistItemPlacement: {},
      wishlistCategory: {},
    });
  });
  shared.itemCreate.mockResolvedValue({
    id: 'i-new',
    wishlistId: 'drafts-1',
    title: 'Book',
    url: 'https://example.com/x',
    priceText: '500',
    imageUrl: null,
    priority: 'MEDIUM',
    status: 'AVAILABLE',
    description: null,
    sourceUrl: 'https://example.com/x',
    sourceDomain: 'example.com',
    importMethod: 'bot',
    currency: null,
  });
  shared.ensureItemPlacement.mockResolvedValue(undefined);

  trackEvent = vi.fn();
  getOrCreateDraftsWishlist = vi.fn().mockResolvedValue({ id: 'drafts-1' });
  importUrlForUser = createImportUrlForUser({ trackEvent, getOrCreateDraftsWishlist });
});

describe('importUrlForUser — capacity gate', () => {
  it('throws 402 when SYSTEM_DRAFTS has reached DRAFTS_ITEM_LIMIT (50)', async () => {
    shared.itemCount.mockReset();
    shared.itemCount.mockResolvedValueOnce(50); // drafts capacity hit

    await expect(importUrlForUser('u1', 'https://x.com/p')).rejects.toMatchObject({
      message: 'Drafts limit reached',
      statusCode: 402,
    });
    expect(shared.parseUrl).not.toHaveBeenCalled();
    expect(shared.itemCreate).not.toHaveBeenCalled();
  });

  it('allows import when drafts count is at the limit-minus-one', async () => {
    shared.itemCount.mockReset();
    let n = 0;
    shared.itemCount.mockImplementation(() => {
      n += 1;
      if (n === 1) return Promise.resolve(49);
      return Promise.resolve(5);
    });
    shared.parseUrl.mockResolvedValueOnce({
      title: 'Book',
      description: null,
      priceText: '500',
      imageUrl: null,
      sourceDomain: 'x.com',
      canonicalUrl: 'https://x.com/p',
    });

    await expect(importUrlForUser('u1', 'https://x.com/p')).resolves.toBeDefined();
  });
});

describe('importUrlForUser — parser result states', () => {
  it('parseStatus=ok when title + price + image all present', async () => {
    shared.parseUrl.mockResolvedValueOnce({
      title: 'Book', description: null, priceText: '500', imageUrl: null,
      sourceDomain: 'x.com', canonicalUrl: 'https://x.com/p',
    });

    const result = await importUrlForUser('u1', 'https://x.com/p');
    expect(result.parseStatus).toBe('ok');
  });

  it('parseStatus=partial when title present but no price', async () => {
    shared.parseUrl.mockResolvedValueOnce({
      title: 'Book', description: null, priceText: null, imageUrl: null,
      sourceDomain: 'x.com', canonicalUrl: 'https://x.com/p',
    });

    expect((await importUrlForUser('u1', 'https://x.com/p')).parseStatus).toBe('partial');
  });

  it('parseStatus=failed when title + price + image all missing', async () => {
    shared.parseUrl.mockResolvedValueOnce({
      title: null, description: null, priceText: null, imageUrl: null,
      sourceDomain: 'x.com', canonicalUrl: 'https://x.com/p',
    });

    expect((await importUrlForUser('u1', 'https://x.com/p')).parseStatus).toBe('failed');
  });

  it('parseStatus=failed and hostname fallback when parseUrl throws', async () => {
    shared.parseUrl.mockRejectedValueOnce(new Error('network unreachable'));

    const result = await importUrlForUser('u1', 'https://www.fancysite.example.com/sku/abc');

    expect(result.parseStatus).toBe('failed');
    // Title falls back to sourceDomain when no parsed title; hostname strips www.
    const createArg = shared.itemCreate.mock.calls[0]![0];
    expect(createArg.data.sourceDomain).toBe('fancysite.example.com');
  });

  it('uses hostname "link" when rawUrl is unparseable', async () => {
    shared.parseUrl.mockRejectedValueOnce(new Error('boom'));

    await importUrlForUser('u1', 'not-even-a-url');

    const createArg = shared.itemCreate.mock.calls[0]![0];
    expect(createArg.data.sourceDomain).toBe('link');
  });
});

describe('importUrlForUser — image caching', () => {
  it('uses /api/uploads URL when downloadAndProcessImage succeeds', async () => {
    shared.parseUrl.mockResolvedValueOnce({
      title: 'Book', description: null, priceText: '500',
      imageUrl: 'https://cdn.example.com/full.jpg',
      sourceDomain: 'x.com', canonicalUrl: 'https://x.com/p',
    });
    shared.downloadAndProcessImage.mockResolvedValueOnce({ filename: 'abc-123-full.jpg' });

    await importUrlForUser('u1', 'https://x.com/p');

    const createArg = shared.itemCreate.mock.calls[0]![0];
    expect(createArg.data.imageUrl).toBe('/api/uploads/abc-123-full.jpg');
  });

  it('falls back to remote URL when downloadAndProcessImage fails (non-fatal)', async () => {
    shared.parseUrl.mockResolvedValueOnce({
      title: 'Book', description: null, priceText: '500',
      imageUrl: 'https://cdn.example.com/full.jpg',
      sourceDomain: 'x.com', canonicalUrl: 'https://x.com/p',
    });
    shared.downloadAndProcessImage.mockRejectedValueOnce(new Error('CDN timeout'));

    await importUrlForUser('u1', 'https://x.com/p');

    const createArg = shared.itemCreate.mock.calls[0]![0];
    expect(createArg.data.imageUrl).toBe('https://cdn.example.com/full.jpg');
    expect(shared.loggerWarn).toHaveBeenCalled();
  });

  it('cleans up the cached file when the DB transaction rolls back afterwards', async () => {
    shared.parseUrl.mockResolvedValueOnce({
      title: 'Book', description: null, priceText: '500',
      imageUrl: 'https://cdn.example.com/full.jpg',
      sourceDomain: 'x.com', canonicalUrl: 'https://x.com/p',
    });
    shared.downloadAndProcessImage.mockResolvedValueOnce({ filename: 'orphan-id-full.jpg' });
    shared.$transaction.mockRejectedValueOnce(new Error('placement failed'));

    await expect(importUrlForUser('u1', 'https://x.com/p')).rejects.toThrow('placement failed');
    expect(shared.deleteUploadFile).toHaveBeenCalledWith('/api/uploads/orphan-id-full.jpg');
  });

  it('does not call deleteUploadFile when no image was downloaded', async () => {
    shared.parseUrl.mockResolvedValueOnce({
      title: 'Book', description: null, priceText: '500', imageUrl: null,
      sourceDomain: 'x.com', canonicalUrl: 'https://x.com/p',
    });
    shared.$transaction.mockRejectedValueOnce(new Error('placement failed'));

    await expect(importUrlForUser('u1', 'https://x.com/p')).rejects.toThrow();
    expect(shared.deleteUploadFile).not.toHaveBeenCalled();
  });
});

describe('importUrlForUser — description composition', () => {
  beforeEach(() => {
    shared.parseUrl.mockResolvedValue({
      title: 'X', description: 'parsed desc', priceText: '1', imageUrl: null,
      sourceDomain: 'x.com', canonicalUrl: 'https://x.com/p',
    });
  });

  it('merges user note + parsed description with 💬 prefix', async () => {
    await importUrlForUser('u1', 'https://x.com/p', 'my note');
    const arg = shared.itemCreate.mock.calls[0]![0];
    expect(arg.data.description).toContain('💬 my note');
    expect(arg.data.description).toContain('parsed desc');
  });

  it('user note alone (no parsed description) → note only', async () => {
    shared.parseUrl.mockReset();
    shared.parseUrl.mockResolvedValue({
      title: 'X', description: null, priceText: '1', imageUrl: null,
      sourceDomain: 'x.com', canonicalUrl: 'https://x.com/p',
    });

    await importUrlForUser('u1', 'https://x.com/p', 'just a note');
    expect(shared.itemCreate.mock.calls[0]![0].data.description).toBe('just a note');
  });

  it('parsed description alone (no note) → parsed only', async () => {
    await importUrlForUser('u1', 'https://x.com/p');
    expect(shared.itemCreate.mock.calls[0]![0].data.description).toBe('parsed desc');
  });

  it('truncates combined description to 500 chars', async () => {
    shared.parseUrl.mockReset();
    shared.parseUrl.mockResolvedValue({
      title: 'X', description: 'd'.repeat(2000), priceText: '1', imageUrl: null,
      sourceDomain: 'x.com', canonicalUrl: 'https://x.com/p',
    });

    await importUrlForUser('u1', 'https://x.com/p', 'n');
    expect(shared.itemCreate.mock.calls[0]![0].data.description.length).toBe(500);
  });
});

describe('importUrlForUser — analytics', () => {
  beforeEach(() => {
    shared.parseUrl.mockResolvedValue({
      title: 'Book', description: null, priceText: '500', imageUrl: null,
      sourceDomain: 'x.com', canonicalUrl: 'https://x.com/p',
    });
  });

  it('fires item_created on every import', async () => {
    await importUrlForUser('u1', 'https://x.com/p');
    expect(trackEvent).toHaveBeenCalledWith(
      'item_created',
      'u1',
      expect.objectContaining({
        wishlistType: 'SYSTEM_DRAFTS',
        triggeredFromDrafts: true,
      }),
    );
  });

  it('fires first_item_created additionally when this is the user\'s first item', async () => {
    shared.itemCount.mockReset();
    let n = 0;
    shared.itemCount.mockImplementation(() => {
      n += 1;
      if (n === 1) return Promise.resolve(0); // drafts capacity OK
      return Promise.resolve(1); // total user items == 1
    });

    await importUrlForUser('u1', 'https://x.com/p');

    const events = trackEvent.mock.calls.map((c) => c[0]);
    expect(events).toContain('item_created');
    expect(events).toContain('first_item_created');
  });

  it('does NOT fire first_item_created when user already has multiple items', async () => {
    shared.itemCount.mockReset();
    let n = 0;
    shared.itemCount.mockImplementation(() => {
      n += 1;
      if (n === 1) return Promise.resolve(0);
      return Promise.resolve(5);
    });

    await importUrlForUser('u1', 'https://x.com/p');

    expect(trackEvent.mock.calls.some((c) => c[0] === 'first_item_created')).toBe(false);
  });

  it('tags platform=bot when source=bot', async () => {
    await importUrlForUser('u1', 'https://x.com/p', undefined, 'bot');
    const props = trackEvent.mock.calls.find((c) => c[0] === 'item_created')![2];
    expect(props.platform).toBe('bot');
    expect(props.source).toBe('bot');
  });

  it('tags platform=miniapp when source is not bot', async () => {
    await importUrlForUser('u1', 'https://x.com/p', undefined, 'import_url');
    const props = trackEvent.mock.calls.find((c) => c[0] === 'item_created')![2];
    expect(props.platform).toBe('miniapp');
    expect(props.source).toBe('import_url');
  });
});

describe('importUrlForUser — title truncation', () => {
  it('clamps title to 200 chars', async () => {
    shared.parseUrl.mockResolvedValueOnce({
      title: 'x'.repeat(500), description: null, priceText: '500', imageUrl: null,
      sourceDomain: 'x.com', canonicalUrl: 'https://x.com/p',
    });

    await importUrlForUser('u1', 'https://x.com/p');
    expect(shared.itemCreate.mock.calls[0]![0].data.title.length).toBe(200);
  });
});
