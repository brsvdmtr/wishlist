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
  comment: { create: ReturnType<typeof vi.fn> };
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
    comment: { create: vi.fn().mockResolvedValue({}) },
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
});
