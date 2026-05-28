// Tests for schedulers/reservations.ts — reservation reminder + smart-res
// auto-release + smart-res reminder. Three setIntervals across two exported
// factories.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Logger } from 'pino';
import type { PrismaClient } from '@wishlist/db';
import {
  startReservationReminderScheduler,
  startSmartReservationSchedulers,
} from './reservations';

const FIFTEEN_MIN_MS = 15 * 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;
const fakeLogger = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() } as unknown as Logger);

let prisma: {
  reservationMeta: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
  user: { findUnique: ReturnType<typeof vi.fn> };
  item: { update: ReturnType<typeof vi.fn> };
  reservationEvent: { create: ReturnType<typeof vi.fn> };
  comment: { create: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn> };
};
let sendTgBotMessage: ReturnType<typeof vi.fn>;
let sendTgNotification: ReturnType<typeof vi.fn>;
let getSmartResLeadHours: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  prisma = {
    reservationMeta: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({}),
    },
    user: { findUnique: vi.fn().mockResolvedValue(null) },
    item: { update: vi.fn().mockResolvedValue({}) },
    reservationEvent: { create: vi.fn().mockResolvedValue({}) },
    // updateMany hit only by the smart-res auto-release tx body (sets
    // 30-day TTL on comments). Drop it and the catch-block silently
    // swallows the resulting "fn not a function" error, hiding the
    // post-tx notification path — same shape of bug the 2026-04-30
    // mock-Prisma race recurrence taught.
    comment: { create: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({}) },
  };
  sendTgBotMessage = vi.fn().mockResolvedValue(true);
  sendTgNotification = vi.fn().mockResolvedValue(undefined);
  getSmartResLeadHours = vi.fn().mockReturnValue(24);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('startReservationReminderScheduler', () => {
  function start() {
    startReservationReminderScheduler({
      prisma: prisma as unknown as PrismaClient,
      logger: fakeLogger(),
      sendTgBotMessage,
    });
  }

  it('queries reminders every 15 min', async () => {
    start();
    await vi.advanceTimersByTimeAsync(FIFTEEN_MIN_MS);
    expect(prisma.reservationMeta.findMany).toHaveBeenCalledOnce();
    const arg = prisma.reservationMeta.findMany.mock.calls[0]![0];
    expect(arg.where.reminderSent).toBe(false);
    expect(arg.where.active).toBe(true);
    expect(arg.take).toBe(50);
  });

  it('sends DM to reserver in their locale with deep-link + purchased buttons', async () => {
    prisma.reservationMeta.findMany.mockResolvedValueOnce([{
      id: 'meta1', reserverUserId: 'u-reserver', note: null, reminderAt: new Date(), reminderDates: null,
      item: { id: 'i1', title: 'PS5', priceText: null, currency: 'RUB', wishlist: { owner: { firstName: 'Anna', profile: { displayName: null } } } },
    }]);
    prisma.user.findUnique.mockResolvedValueOnce({
      telegramChatId: 'chat-1',
      profile: { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'en', language: null },
    });

    start();
    await vi.advanceTimersByTimeAsync(FIFTEEN_MIN_MS);

    expect(sendTgBotMessage).toHaveBeenCalledOnce();
    const [chatId, text, kb] = sendTgBotMessage.mock.calls[0]!;
    expect(chatId).toBe('chat-1');
    expect(text).toContain('PS5');
    expect(kb.inline_keyboard[0]).toHaveLength(2);
  });

  it('skips reserver without telegramChatId', async () => {
    prisma.reservationMeta.findMany.mockResolvedValueOnce([{
      id: 'meta1', reserverUserId: 'u1', note: null, reminderAt: new Date(), reminderDates: null,
      item: { id: 'i1', title: 'X', priceText: null, currency: 'RUB', wishlist: { owner: { firstName: '', profile: null } } },
    }]);
    prisma.user.findUnique.mockResolvedValueOnce({ telegramChatId: null, profile: null });

    start();
    await vi.advanceTimersByTimeAsync(FIFTEEN_MIN_MS);

    expect(sendTgBotMessage).not.toHaveBeenCalled();
  });

  it('includes price block when priceText is set', async () => {
    prisma.reservationMeta.findMany.mockResolvedValueOnce([{
      id: 'meta1', reserverUserId: 'u1', note: null, reminderAt: new Date(), reminderDates: null,
      item: { id: 'i1', title: 'PS5', priceText: '50000', currency: 'RUB', wishlist: { owner: { firstName: 'Z', profile: null } } },
    }]);
    prisma.user.findUnique.mockResolvedValueOnce({
      telegramChatId: 'c', profile: { normalizedLocale: 'ru', languageMode: 'auto', manualLanguage: null, language: null },
    });

    start();
    await vi.advanceTimersByTimeAsync(FIFTEEN_MIN_MS);

    const text = sendTgBotMessage.mock.calls[0]![1];
    expect(text).toContain('50000');
  });

  it('top-level error containment', async () => {
    prisma.reservationMeta.findMany.mockRejectedValueOnce(new Error('DB'));
    expect(() => start()).not.toThrow();
    await vi.advanceTimersByTimeAsync(FIFTEEN_MIN_MS);
  });
});

describe('startSmartReservationSchedulers', () => {
  function start() {
    startSmartReservationSchedulers({
      prisma: prisma as unknown as PrismaClient,
      logger: fakeLogger(),
      sendTgNotification,
      sendTgBotMessage,
      getSmartResLeadHours,
      SYSTEM_ACTOR_HASH: '00000000-0000-0000-0000-000000000000',
    });
  }

  it('starts auto-release on 5-min cadence', async () => {
    start();
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    // findMany called for both auto-release and reminder jobs (separate intervals)
    expect(prisma.reservationMeta.findMany).toHaveBeenCalled();
  });

  it('error containment for both jobs', async () => {
    prisma.reservationMeta.findMany.mockRejectedValue(new Error('DB'));
    expect(() => start()).not.toThrow();
    await vi.advanceTimersByTimeAsync(FIFTEEN_MIN_MS);
  });

  it('notifies owner with "Open wish" inline button containing item_<id> deep link on auto-release', async () => {
    // Exercises the smart-res auto-release path end-to-end:
    //  - expired ReservationMeta is loaded
    //  - the item transition succeeds (mocked $transaction)
    //  - the gifter is notified via sendTgNotification (plain text, no button)
    //  - the owner is notified via sendTgBotMessage WITH an inline_keyboard
    //    containing the `item_<id>` startapp deep link → key UX contract for
    //    this PR; regressing it removes the button and leaves owners with
    //    no navigation.
    const itemId = 'cmaa1bb2ccddee01';
    const ownerChat = 'chat-owner';
    prisma.reservationMeta.findMany
      .mockResolvedValueOnce([{
        id: 'metaA', reserverUserId: 'u-reserver', isSmartRes: true, active: true,
        expiresAt: new Date(Date.now() - 1000),
        item: {
          id: itemId, title: 'Gold Apple', status: 'RESERVED',
          reserverUserId: 'u-reserver', reservationEpoch: 1,
          wishlist: {
            ownerId: 'u-owner',
            owner: {
              telegramChatId: ownerChat,
              profile: { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'ru', language: null },
            },
          },
        },
      }])
      // reminder job's findMany fires immediately after; return empty
      .mockResolvedValue([]);
    // The transactional update inside the auto-release path uses
    // prisma.$transaction(callback). The factory destructures `prisma` and
    // calls $transaction directly, so we proxy through a passthrough fn that
    // hands the same `tx` (= prisma mock) back to the callback.
    (prisma as unknown as { $transaction: (fn: (tx: unknown) => unknown) => Promise<unknown> }).$transaction =
      ((fn: (tx: unknown) => unknown) => Promise.resolve(fn(prisma))) as never;
    // reservationMeta.update is hit twice in the success path (once inside
    // tx, once not) — both succeed.
    prisma.reservationMeta.update.mockResolvedValue({});
    // Reserver-side lookup (for the gifter notification).
    prisma.user.findUnique.mockResolvedValueOnce({
      telegramChatId: 'chat-reserver',
      profile: { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'ru', language: null },
    });

    start();
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    // Let the awaited $transaction + subsequent owner notification resolve.
    await Promise.resolve();
    await Promise.resolve();

    expect(sendTgBotMessage).toHaveBeenCalledOnce();
    const [chatId, text, replyMarkup] = sendTgBotMessage.mock.calls[0]!;
    expect(chatId).toBe(ownerChat);
    expect(text).toContain('Gold Apple');
    expect(replyMarkup.inline_keyboard).toHaveLength(1);
    expect(replyMarkup.inline_keyboard[0]).toHaveLength(1);
    const btn = replyMarkup.inline_keyboard[0][0];
    expect(btn.text).toMatch(/Перейти|Open|查看|देखें|Ver|عرض/);
    expect(btn.web_app.url).toContain(`startapp=item_${itemId}`);

    // M3: Decouple the notification assertion from "tx body never errored".
    // Without this check, a future tx-body change that silently throws
    // before the notification block would leave sendTgBotMessage at 0 calls
    // — looks like a "keyboard wiring broke" failure, but it's actually
    // "tx body broke and the catch swallowed it". Asserting that the item
    // transition actually fired lets the failure attribution point at the
    // right layer.
    expect(prisma.item.update).toHaveBeenCalledWith({
      where: { id: itemId },
      data: { status: 'AVAILABLE', reserverUserId: null },
    });
  });

  it('smart-res reminder cron skips self-reservation and marks reminderSent to break the cycle', async () => {
    // Self-reservation as bookmark flow: reminder ("your reservation
    // expires in X hours") is meaningless when the reserver IS the owner.
    // Without the guard, the cron would re-evaluate the row every 15 min
    // forever (reminderSent stays false). The fix marks reminderSent=true
    // so the row is excluded from future queries — same shape as the
    // "no chat ID" branch.
    //
    // The factory registers two concurrent intervals (auto-release at 5min,
    // reminder at 15min) that both query `reservationMeta.findMany` with
    // different `where` clauses. Dispatching the mock by where-shape
    // (`expiresAt.lte` = auto-release; `expiresAt.gt` = reminder) is more
    // robust than `mockResolvedValueOnce` chains, which would shift when
    // the timer advances across multiple auto-release ticks.
    const itemId = 'cmaa1bb2ccddee03';
    const reminderRow = {
      id: 'metaC', reserverUserId: 'u-self', isSmartRes: true, active: true, reminderSent: false,
      expiresAt: new Date(Date.now() + 1 * 3600000), // expires in 1h, well inside lead window
      smartResTtlHours: 72,
      item: {
        id: itemId, title: 'Self Bookmark',
        wishlist: { ownerId: 'u-self' },
      },
    };
    prisma.reservationMeta.findMany.mockImplementation(async (args: { where?: { expiresAt?: { lte?: Date; gt?: Date } } }) => {
      const expiresAt = args.where?.expiresAt;
      // Reminder cron uses { not: null, gt: now }; auto-release uses { lte: now }.
      // Fail loud if neither key is present — surfaces a future where-clause
      // refactor that breaks this dispatch, instead of silently returning
      // [] and letting the test pass as a no-op.
      if (expiresAt && 'gt' in expiresAt && expiresAt.gt) return [reminderRow];
      if (expiresAt && 'lte' in expiresAt && expiresAt.lte) return [];
      throw new Error(`unexpected reservationMeta.findMany where shape: ${JSON.stringify(args.where)}`);
    });

    start();
    await vi.advanceTimersByTimeAsync(FIFTEEN_MIN_MS);
    await Promise.resolve();
    await Promise.resolve();

    // Notification path is skipped: the reserver-lookup user.findUnique
    // never fires because we early-continue before it.
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(sendTgNotification).not.toHaveBeenCalled();
    // reminderSent flag is set to true so the row is filtered out of next
    // cron tick — prevents an infinite re-evaluation loop on bookmark rows.
    expect(prisma.reservationMeta.update).toHaveBeenCalledWith({
      where: { id: 'metaC' },
      data: { reminderSent: true },
    });
  });

  it('smart-res reminder cron self-res guard fires BEFORE the window-start check (no cron starvation)', async () => {
    // Regression guard for the iteration-3 review M1: the guard must
    // short-circuit on self-reservation regardless of whether the row is
    // in the reminder lead-time window. Without this ordering, a fleet of
    // self-res bookmarks far from their expiry (`expiresAt > now + leadH`)
    // would refetch in every 15-min tick, eating the `take: 50` budget and
    // starving genuine cross-user reminders.
    //
    // Setup: TTL = 72h, leadH = 24h, expiresAt = now + 48h → windowStart
    // is at now + 24h, well in the future. The pre-fix code would
    // `continue` at the windowStart check and never write reminderSent.
    const itemId = 'cmaa1bb2ccddee04';
    const farFutureReminderRow = {
      id: 'metaD', reserverUserId: 'u-self', isSmartRes: true, active: true, reminderSent: false,
      expiresAt: new Date(Date.now() + 48 * 3600000), // 48h out, way before lead window
      smartResTtlHours: 72,
      item: {
        id: itemId, title: 'Far Bookmark',
        wishlist: { ownerId: 'u-self' },
      },
    };
    prisma.reservationMeta.findMany.mockImplementation(async (args: { where?: { expiresAt?: { lte?: Date; gt?: Date } } }) => {
      const expiresAt = args.where?.expiresAt;
      if (expiresAt && 'gt' in expiresAt && expiresAt.gt) return [farFutureReminderRow];
      if (expiresAt && 'lte' in expiresAt && expiresAt.lte) return [];
      throw new Error(`unexpected reservationMeta.findMany where shape: ${JSON.stringify(args.where)}`);
    });

    start();
    await vi.advanceTimersByTimeAsync(FIFTEEN_MIN_MS);
    await Promise.resolve();
    await Promise.resolve();

    // The reminder cron must mark this far-future bookmark even though
    // it's outside the window — that's how the cron stops re-querying it.
    expect(prisma.reservationMeta.update).toHaveBeenCalledWith({
      where: { id: 'metaD' },
      data: { reminderSent: true },
    });
    expect(sendTgNotification).not.toHaveBeenCalled();
  });

  it('skips both notifications when reserver is the owner (self-reservation auto-release)', async () => {
    // Self-reservation as a bookmark flow: owner reserved their own item
    // (allowed by the public reserve route), it smart-res-expired, and
    // auto-released. Sending "your reservation expired" + "your wish is
    // available again" to the same chat is noise. The guard added in this
    // PR makes BOTH notifications skip on self-reservation.
    const itemId = 'cmaa1bb2ccddee02';
    prisma.reservationMeta.findMany
      .mockResolvedValueOnce([{
        id: 'metaB', reserverUserId: 'u-self', isSmartRes: true, active: true,
        expiresAt: new Date(Date.now() - 1000),
        item: {
          id: itemId, title: 'Self Item', status: 'RESERVED',
          reserverUserId: 'u-self', reservationEpoch: 1,
          wishlist: {
            ownerId: 'u-self', // same as reserverUserId → self-reservation
            owner: {
              telegramChatId: 'chat-self',
              profile: { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'ru', language: null },
            },
          },
        },
      }])
      .mockResolvedValue([]);
    (prisma as unknown as { $transaction: (fn: (tx: unknown) => unknown) => Promise<unknown> }).$transaction =
      ((fn: (tx: unknown) => unknown) => Promise.resolve(fn(prisma))) as never;
    prisma.reservationMeta.update.mockResolvedValue({});

    start();
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    await Promise.resolve();
    await Promise.resolve();

    // Tx body still fires (the item must transition back to AVAILABLE).
    expect(prisma.item.update).toHaveBeenCalledWith({
      where: { id: itemId },
      data: { status: 'AVAILABLE', reserverUserId: null },
    });
    // But neither notification goes out.
    expect(sendTgBotMessage).not.toHaveBeenCalled();
    expect(sendTgNotification).not.toHaveBeenCalled();
  });
});
