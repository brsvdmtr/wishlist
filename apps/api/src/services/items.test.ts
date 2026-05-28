// Unit tests for services/items.ts.
//
// Strategy: mock Prisma at the boundary; cover pure mappers exhaustively;
// for orchestration helpers (cancelItemHints, notifySubscribersOfChange,
// getItemRole) verify the right queries fire with the right shapes.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  hint: { updateMany: vi.fn() },
  wishlistSubscription: { findMany: vi.fn() },
  wishlist: { findUnique: vi.fn() },
  wishlistItemPlacement: { count: vi.fn() },
  item: { findUnique: vi.fn() },
  subscriptionUnread: { upsert: vi.fn() },
  user: { upsert: vi.fn() },
  sendTgBotMessage: vi.fn(),
  sendTgNotification: vi.fn(),
  loggerDebug: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    hint: shared.hint,
    wishlistSubscription: shared.wishlistSubscription,
    wishlist: shared.wishlist,
    wishlistItemPlacement: shared.wishlistItemPlacement,
    item: shared.item,
    subscriptionUnread: shared.subscriptionUnread,
    user: shared.user,
  },
}));

vi.mock('../telegram/botApi', () => ({
  sendTgBotMessage: shared.sendTgBotMessage,
  sendTgNotification: shared.sendTgNotification,
}));

vi.mock('../logger', () => ({
  default: {
    debug: shared.loggerDebug,
    info: shared.loggerInfo,
    warn: shared.loggerWarn,
    error: shared.loggerError,
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  },
}));

import {
  ACTIVE_STATUSES,
  cancelItemHints,
  countItemPlacements,
  extractNumericPrice,
  priorityToNum,
  numToPriority,
  mapTgItem,
  notifySubscribersOfChange,
  getItemRole,
} from './items';

beforeEach(() => {
  for (const m of Object.values(shared)) (m as ReturnType<typeof vi.fn>).mockReset?.();
});

describe('ACTIVE_STATUSES', () => {
  it('lists exactly the three active item statuses in canonical order', () => {
    expect(ACTIVE_STATUSES).toEqual(['AVAILABLE', 'RESERVED', 'PURCHASED']);
  });

  it('is readonly tuple (compile-time guarantee via `as const`)', () => {
    // Runtime sanity: index 0 is the canonical "available" status.
    expect(ACTIVE_STATUSES[0]).toBe('AVAILABLE');
  });
});

describe('priorityToNum / numToPriority', () => {
  it('LOW ⟷ 1', () => {
    expect(priorityToNum('LOW')).toBe(1);
    expect(numToPriority(1)).toBe('LOW');
  });

  it('MEDIUM ⟷ 2', () => {
    expect(priorityToNum('MEDIUM')).toBe(2);
    expect(numToPriority(2)).toBe('MEDIUM');
  });

  it('HIGH ⟷ 3', () => {
    expect(priorityToNum('HIGH')).toBe(3);
    expect(numToPriority(3)).toBe('HIGH');
  });

  it('numToPriority falls back to MEDIUM for unknown numbers (defensive)', () => {
    expect(numToPriority(0)).toBe('MEDIUM');
    expect(numToPriority(99)).toBe('MEDIUM');
  });

  it('round-trips for every known priority', () => {
    for (const p of ['LOW', 'MEDIUM', 'HIGH'] as const) {
      expect(numToPriority(priorityToNum(p))).toBe(p);
    }
  });
});

describe('extractNumericPrice', () => {
  it('strips currency symbols and spaces (Russian-style prices, the common case)', () => {
    expect(extractNumericPrice('51 975 ₽')).toBe('51975');
    expect(extractNumericPrice('100 €')).toBe('100');
  });

  it('treats comma as decimal separator (European convention) — US-style "$1,299" parses to 1.299', () => {
    // Known ambiguity: the function `.replace(',', '.')` is biased toward
    // European decimal notation. For Russian/EU markets this matches their
    // local format; US thousand-separator notation gets reinterpreted.
    // Document the actual behaviour so a future "fix" can be deliberate.
    expect(extractNumericPrice('$1,299')).toBe('1.299');
  });

  it('handles non-breaking spaces', () => {
    expect(extractNumericPrice('51 975 ₽')).toBe('51975');
  });

  it('returns null for null', () => {
    expect(extractNumericPrice(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractNumericPrice('')).toBeNull();
  });

  it('returns null for strings with no digits', () => {
    expect(extractNumericPrice('abc xyz')).toBeNull();
  });

  it('converts comma to decimal point (European notation)', () => {
    expect(extractNumericPrice('19,99 €')).toBe('19.99');
  });

  it('parses a simple integer', () => {
    expect(extractNumericPrice('100')).toBe('100');
  });
});

describe('mapTgItem', () => {
  function input(overrides: Partial<Parameters<typeof mapTgItem>[0]> = {}) {
    return {
      id: 'i1',
      wishlistId: 'w1',
      title: 'Book',
      url: 'https://example.com',
      priceText: '1000',
      priority: 'MEDIUM' as const,
      status: 'AVAILABLE',
      ...overrides,
    };
  }

  it('converts priceText to numeric price; "1000" → 1000', () => {
    expect(mapTgItem(input({ priceText: '1000' })).price).toBe(1000);
  });

  it('coerces non-numeric priceText to null (NOT NaN)', () => {
    expect(mapTgItem(input({ priceText: 'twenty bucks' })).price).toBeNull();
  });

  it('lowercases status', () => {
    expect(mapTgItem(input({ status: 'AVAILABLE' })).status).toBe('available');
    expect(mapTgItem(input({ status: 'RESERVED' })).status).toBe('reserved');
  });

  it('emits priority as number (1/2/3) for the frontend', () => {
    expect(mapTgItem(input({ priority: 'HIGH' })).priority).toBe(3);
    expect(mapTgItem(input({ priority: 'LOW' })).priority).toBe(1);
  });

  it('defaults position to 0 when missing', () => {
    expect(mapTgItem(input()).position).toBe(0);
  });

  it('converts empty url to null (avoids broken anchor tags on the frontend)', () => {
    expect(mapTgItem(input({ url: '' })).url).toBeNull();
  });

  it('passes through optional fields when present', () => {
    const out = mapTgItem(input({
      imageUrl: 'https://i/1.jpg',
      description: 'note',
      sourceDomain: 'wb.ru',
      sourceUrl: 'https://wb.ru/x',
      importMethod: 'auto',
      currency: 'RUB',
    }));
    expect(out.imageUrl).toBe('https://i/1.jpg');
    expect(out.description).toBe('note');
    expect(out.sourceDomain).toBe('wb.ru');
    expect(out.sourceUrl).toBe('https://wb.ru/x');
    expect(out.importMethod).toBe('auto');
    expect(out.currency).toBe('RUB');
  });

  it('coerces undefined optional fields to null', () => {
    const out = mapTgItem(input());
    expect(out.imageUrl).toBeNull();
    expect(out.description).toBeNull();
    expect(out.sourceDomain).toBeNull();
  });
});

describe('cancelItemHints', () => {
  it('cancels all SENT + DELIVERED hints for the item', async () => {
    shared.hint.updateMany.mockResolvedValueOnce({ count: 3 });

    await cancelItemHints('i1');

    expect(shared.hint.updateMany).toHaveBeenCalledOnce();
    const arg = shared.hint.updateMany.mock.calls[0]![0];
    expect(arg.where).toEqual({ itemId: 'i1', status: { in: ['SENT', 'DELIVERED'] } });
    expect(arg.data).toEqual({ status: 'CANCELLED' });
  });

  it('swallows Prisma errors (best-effort)', async () => {
    shared.hint.updateMany.mockRejectedValueOnce(new Error('DB down'));
    await expect(cancelItemHints('i1')).resolves.toBeUndefined();
  });
});

describe('countItemPlacements', () => {
  it('returns the count from prisma.wishlistItemPlacement.count', async () => {
    shared.wishlistItemPlacement.count.mockResolvedValueOnce(7);
    expect(await countItemPlacements('i1')).toBe(7);
    expect(shared.wishlistItemPlacement.count).toHaveBeenCalledWith({ where: { itemId: 'i1' } });
  });
});

describe('notifySubscribersOfChange — per-recipient locale resolution', () => {
  beforeEach(() => {
    process.env.MINI_APP_URL = 'https://app.test/miniapp';
  });

  it('returns silently when no subscribers exist', async () => {
    shared.wishlistSubscription.findMany.mockResolvedValueOnce([]);

    await notifySubscribersOfChange('w1', 'i1', ['title'], 'item_added', {
      itemTitle: 'X', wishlistTitle: 'Y', ownerName: 'Z',
    });

    expect(shared.sendTgBotMessage).not.toHaveBeenCalled();
    expect(shared.sendTgNotification).not.toHaveBeenCalled();
  });

  it('uses each subscriber\'s persisted locale (NOT a fixed `ru`) — L1 regression', async () => {
    shared.wishlistSubscription.findMany.mockResolvedValueOnce([
      {
        id: 'sub1',
        subscriber: {
          id: 'recipient-ru',
          telegramChatId: 'chat-ru',
          profile: { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'ru', language: null },
        },
      },
      {
        id: 'sub2',
        subscriber: {
          id: 'recipient-en',
          telegramChatId: 'chat-en',
          profile: { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'en', language: null },
        },
      },
    ]);
    shared.wishlist.findUnique.mockResolvedValueOnce({ slug: 'birthday' });
    shared.subscriptionUnread.upsert.mockResolvedValue({});

    await notifySubscribersOfChange('w1', 'item-42', ['title'], 'item_added', {
      itemTitle: 'PS5', wishlistTitle: 'Birthday', ownerName: 'Алексей',
    });

    expect(shared.sendTgBotMessage).toHaveBeenCalledTimes(2);
    const [chat1, text1] = shared.sendTgBotMessage.mock.calls[0]!;
    const [chat2, text2] = shared.sendTgBotMessage.mock.calls[1]!;

    // Both went to their respective chats.
    const calls = [{ chat: chat1, text: text1 }, { chat: chat2, text: text2 }];
    expect(calls.map((c) => c.chat).sort()).toEqual(['chat-en', 'chat-ru']);

    // The two messages must NOT be identical — one is Russian, one is English.
    // Concrete regression: hardcoded `const notifLocale: Locale = 'ru'` would
    // produce two identical Russian strings even for the en-recipient.
    expect(text1).not.toBe(text2);
  });

  it('attaches a deep-link inline-keyboard button for item events', async () => {
    shared.wishlistSubscription.findMany.mockResolvedValueOnce([
      {
        id: 's1',
        subscriber: {
          id: 'r1',
          telegramChatId: 'c1',
          profile: { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'en', language: null },
        },
      },
    ]);
    shared.wishlist.findUnique.mockResolvedValueOnce({ slug: 'birthday' });
    shared.subscriptionUnread.upsert.mockResolvedValue({});

    await notifySubscribersOfChange('w1', 'item-42', ['title'], 'item_added', {
      itemTitle: 'PS5', wishlistTitle: 'Birthday', ownerName: 'Алексей',
    });

    expect(shared.sendTgBotMessage).toHaveBeenCalledOnce();
    const [, , kb] = shared.sendTgBotMessage.mock.calls[0]!;
    expect(kb.inline_keyboard).toHaveLength(1);
    const button = kb.inline_keyboard[0][0];
    expect(button.web_app.url).toContain('startapp=birthday__item_item-42');
    expect(button.text).toBeTruthy();
  });

  it('falls back to plain sendTgNotification when wishlist has no slug (no deep-link)', async () => {
    shared.wishlistSubscription.findMany.mockResolvedValueOnce([
      {
        id: 's1',
        subscriber: {
          id: 'r1',
          telegramChatId: 'c1',
          profile: { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'en', language: null },
        },
      },
    ]);
    shared.wishlist.findUnique.mockResolvedValueOnce({ slug: null });
    shared.subscriptionUnread.upsert.mockResolvedValue({});

    await notifySubscribersOfChange('w1', 'item-42', ['title'], 'item_added', {
      itemTitle: 'X', wishlistTitle: 'Y', ownerName: 'Z',
    });

    expect(shared.sendTgBotMessage).not.toHaveBeenCalled();
    expect(shared.sendTgNotification).toHaveBeenCalledOnce();
  });

  it('wishlist_updated event sends without a deep-link button', async () => {
    shared.wishlistSubscription.findMany.mockResolvedValueOnce([
      {
        id: 's1',
        subscriber: {
          id: 'r1',
          telegramChatId: 'c1',
          profile: { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'en', language: null },
        },
      },
    ]);
    shared.subscriptionUnread.upsert.mockResolvedValue({});

    await notifySubscribersOfChange('w1', 'w1', ['title'], 'wishlist_updated', {
      wishlistTitle: 'Renamed',
    });

    expect(shared.sendTgBotMessage).not.toHaveBeenCalled();
    expect(shared.sendTgNotification).toHaveBeenCalledOnce();
  });

  it('does not throw when an inner step fails — logs at error level', async () => {
    shared.wishlistSubscription.findMany.mockRejectedValueOnce(new Error('DB down'));

    await expect(
      notifySubscribersOfChange('w1', 'i1', ['title'], 'item_added', {}),
    ).resolves.toBeUndefined();
    expect(shared.loggerError).toHaveBeenCalled();
  });

  it('escapes user-controlled fields before HTML interpolation — Tg parse_mode=HTML injection regression', async () => {
    // Pre-fix: itemTitle/wishlistTitle/ownerName flowed unescaped into a
    // template rendered with `parse_mode: 'HTML'`, so a user could set an
    // item title to `<a href="https://evil">click</a>` and have it become a
    // real clickable link in every subscriber's Telegram notification.
    shared.wishlistSubscription.findMany.mockResolvedValueOnce([
      {
        id: 's1',
        subscriber: {
          id: 'r1',
          telegramChatId: 'c1',
          profile: { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'en', language: null },
        },
      },
    ]);
    shared.wishlist.findUnique.mockResolvedValueOnce({ slug: 'birthday' });
    shared.subscriptionUnread.upsert.mockResolvedValue({});

    await notifySubscribersOfChange('w1', 'item-99', ['title'], 'item_added', {
      itemTitle: '<a href="https://evil">click</a>',
      wishlistTitle: 'B&day <b>list</b>',
      ownerName: '<script>x</script>',
    });

    expect(shared.sendTgBotMessage).toHaveBeenCalledOnce();
    const [, text] = shared.sendTgBotMessage.mock.calls[0]!;
    // Tags must be escaped: no raw `<a`, `<b>`, `<script>` reaches Telegram.
    expect(text).not.toContain('<a href');
    expect(text).not.toContain('<b>');
    expect(text).not.toContain('<script');
    // Escaped sequences must be present (proves escapeTgHtml was applied to
    // each interpolated value, not bypassed):
    expect(text).toContain('&lt;a href=');
    expect(text).toContain('&lt;b&gt;');
    expect(text).toContain('&lt;script&gt;');
    expect(text).toContain('B&amp;day');
  });

  it('skips subscribers without telegramChatId (cannot DM)', async () => {
    shared.wishlistSubscription.findMany.mockResolvedValueOnce([
      {
        id: 's1',
        subscriber: {
          id: 'r1',
          telegramChatId: null,
          profile: { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'en', language: null },
        },
      },
    ]);
    shared.wishlist.findUnique.mockResolvedValueOnce({ slug: 'x' });
    shared.subscriptionUnread.upsert.mockResolvedValue({});

    await notifySubscribersOfChange('w1', 'i1', ['title'], 'item_added', {});

    expect(shared.sendTgBotMessage).not.toHaveBeenCalled();
    expect(shared.sendTgNotification).not.toHaveBeenCalled();
    // Unread markers still upserted (subscription is still active).
    expect(shared.subscriptionUnread.upsert).toHaveBeenCalled();
  });
});

describe('getItemRole', () => {
  const tgUser = { id: 42, first_name: 'T' };

  function mockUserUpsert(userId: string, chatId: string | null = null) {
    shared.user.upsert.mockResolvedValueOnce({ id: userId, telegramChatId: chatId });
  }

  it('returns null when the item does not exist', async () => {
    mockUserUpsert('u1');
    shared.item.findUnique.mockResolvedValueOnce(null);

    expect(await getItemRole('missing', tgUser)).toBeNull();
  });

  it('returns role=owner when the requesting user owns the wishlist', async () => {
    mockUserUpsert('owner-id');
    shared.item.findUnique.mockResolvedValueOnce({
      id: 'i1', status: 'AVAILABLE', reservationEpoch: 0, reserverUserId: null,
      title: 'X',
      wishlist: { ownerId: 'owner-id' },
      reservationEvents: [],
    });

    const result = await getItemRole('i1', tgUser);
    expect(result?.role).toBe('owner');
  });

  it('returns role=third_party for an unrelated user looking at an AVAILABLE item', async () => {
    mockUserUpsert('other-id');
    shared.item.findUnique.mockResolvedValueOnce({
      id: 'i1', status: 'AVAILABLE', reservationEpoch: 0, reserverUserId: null,
      title: 'X',
      wishlist: { ownerId: 'someone-else' },
      reservationEvents: [],
    });

    expect((await getItemRole('i1', tgUser))?.role).toBe('third_party');
  });
});
