// Tests for schedulers/events.ts — 5-min gift-occasion reminder cron.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Logger } from 'pino';
import type { PrismaClient } from '@wishlist/db';
import { startEventSchedulers } from './events';

const FIVE_MIN_MS = 5 * 60 * 1000;
const fakeLogger = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() } as unknown as Logger);

let prisma: {
  giftOccasionReminder: { findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  calendarInboxEntry: { create: ReturnType<typeof vi.fn> };
};
let sendTgBotMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  prisma = {
    giftOccasionReminder: {
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
    },
    calendarInboxEntry: { create: vi.fn().mockResolvedValue({}) },
  };
  sendTgBotMessage = vi.fn().mockResolvedValue(true);
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function start(token = 'TOKEN') {
  startEventSchedulers({
    prisma: prisma as unknown as PrismaClient,
    logger: fakeLogger(),
    sendTgBotMessage,
    BOT_TOKEN_FOR_DM: token,
  });
}

function dueReminder(overrides: Partial<{
  id: string; offsetDays: number; timeOfDay: string; occasionStatus: string;
  recurrence: string; eventDate: Date | null; chatId: string | null;
  locale: string;
}> = {}) {
  return {
    id: overrides.id ?? 'r1',
    ownerUserId: 'u1',
    occasionId: 'occ1',
    offsetDays: overrides.offsetDays ?? -1,
    timeOfDay: overrides.timeOfDay ?? '10:00',
    enabled: true,
    occasion: {
      id: 'occ1',
      title: 'Mom Birthday',
      type: 'BIRTHDAY',
      emoji: null,
      eventDate: overrides.eventDate ?? new Date('2026-06-15T00:00:00Z'),
      recurrence: overrides.recurrence ?? 'YEARLY',
      personName: null,
      eventTime: null,
      location: null,
      status: overrides.occasionStatus ?? 'ACTIVE',
      linkedUser: null,
    },
    owner: {
      id: 'u1',
      telegramChatId: overrides.chatId === undefined ? 'chat-1' : overrides.chatId,
      profile: { languageMode: 'auto', manualLanguage: null, normalizedLocale: overrides.locale ?? 'ru', language: null },
    },
  };
}

describe('startEventSchedulers', () => {
  it('does nothing when BOT_TOKEN_FOR_DM is empty', async () => {
    start('');
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    expect(prisma.giftOccasionReminder.findMany).not.toHaveBeenCalled();
  });

  it('queries due reminders every 5 minutes', async () => {
    start();
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    expect(prisma.giftOccasionReminder.findMany).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    expect(prisma.giftOccasionReminder.findMany).toHaveBeenCalledTimes(2);
  });

  it('batches up to 50 reminders per tick', async () => {
    start();
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    expect(prisma.giftOccasionReminder.findMany.mock.calls[0]![0].take).toBe(50);
  });

  it('archived occasion → marks reminder sent but delivered=false (no DM)', async () => {
    prisma.giftOccasionReminder.findMany.mockResolvedValueOnce([
      dueReminder({ occasionStatus: 'ARCHIVED' }),
    ]);
    start();
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);

    expect(sendTgBotMessage).not.toHaveBeenCalled();
    expect(prisma.giftOccasionReminder.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { sentAt: expect.any(Date), delivered: false },
    });
  });

  it('active occasion + chatId → sends DM with deep-link button, writes inbox entry, marks sent', async () => {
    prisma.giftOccasionReminder.findMany.mockResolvedValueOnce([dueReminder()]);
    start();
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);

    expect(sendTgBotMessage).toHaveBeenCalledOnce();
    const [chatId, text, kb] = sendTgBotMessage.mock.calls[0]!;
    expect(chatId).toBe('chat-1');
    expect(text).toContain('<b>');
    expect(kb.inline_keyboard[0][0].url).toBeTruthy();

    expect(prisma.calendarInboxEntry.create).toHaveBeenCalledOnce();
    expect(prisma.giftOccasionReminder.update).toHaveBeenCalledWith({
      where: { id: 'r1' },
      data: { sentAt: expect.any(Date), delivered: true },
    });
  });

  it('locales: ru, en, zh-CN, hi, es, ar all produce distinct text', async () => {
    const messages: Array<[string, string]> = [];
    sendTgBotMessage.mockImplementation((chatId: string, text: string) => {
      messages.push([chatId, text]);
      return Promise.resolve(true);
    });
    prisma.giftOccasionReminder.findMany.mockResolvedValueOnce(['ru', 'en', 'zh-CN', 'hi', 'es', 'ar'].map((locale, i) => dueReminder({ id: `r${i}`, locale, chatId: `c${i}` })));
    start();
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);

    expect(messages).toHaveLength(6);
    const uniq = new Set(messages.map(([, t]) => t));
    expect(uniq.size).toBe(6); // every locale produces distinct text
  });

  it('offsetDays -1 (1 day before) uses "tomorrow"-flavoured text', async () => {
    prisma.giftOccasionReminder.findMany.mockResolvedValueOnce([dueReminder({ offsetDays: -1, locale: 'en' })]);
    start();
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    const text = sendTgBotMessage.mock.calls[0]![1];
    expect(text).toContain('Tomorrow');
  });

  it('offsetDays 0 (event day) uses "Today" header', async () => {
    prisma.giftOccasionReminder.findMany.mockResolvedValueOnce([dueReminder({ offsetDays: 0, locale: 'en' })]);
    start();
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    const text = sendTgBotMessage.mock.calls[0]![1];
    expect(text).toContain('Today');
  });

  it('YEARLY recurrence → schedules next occurrence reminder', async () => {
    prisma.giftOccasionReminder.findMany.mockResolvedValueOnce([dueReminder({ recurrence: 'YEARLY', offsetDays: -1, eventDate: new Date('2026-06-15T00:00:00Z') })]);
    start();
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);

    expect(prisma.giftOccasionReminder.create).toHaveBeenCalledOnce();
    const data = prisma.giftOccasionReminder.create.mock.calls[0]![0].data;
    expect(data.occasionId).toBe('occ1');
    expect(data.offsetDays).toBe(-1);
    expect(data.episodeKey).toBeTruthy();
  });

  it('NONE recurrence → does NOT schedule next reminder', async () => {
    prisma.giftOccasionReminder.findMany.mockResolvedValueOnce([dueReminder({ recurrence: 'NONE' })]);
    start();
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    expect(prisma.giftOccasionReminder.create).not.toHaveBeenCalled();
  });

  it('P2002 on next-occurrence insert is swallowed (already scheduled)', async () => {
    prisma.giftOccasionReminder.findMany.mockResolvedValueOnce([dueReminder({ recurrence: 'YEARLY' })]);
    prisma.giftOccasionReminder.create.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
    start();
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
    // Should not throw — outer catch logs but we want no throw to propagate.
  });

  it('owner without chatId → still records inbox entry but no DM', async () => {
    prisma.giftOccasionReminder.findMany.mockResolvedValueOnce([dueReminder({ chatId: null })]);
    start();
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);

    expect(sendTgBotMessage).not.toHaveBeenCalled();
    expect(prisma.calendarInboxEntry.create).toHaveBeenCalledOnce();
  });

  it('top-level error containment', async () => {
    prisma.giftOccasionReminder.findMany.mockRejectedValueOnce(new Error('DB down'));
    expect(() => start()).not.toThrow();
    await vi.advanceTimersByTimeAsync(FIVE_MIN_MS);
  });
});
