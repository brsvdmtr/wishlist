// Tests for schedulers/pro-renewal.ts — hourly Pro renewal reminders at
// 7d / 1d before currentPeriodEnd. Filters out lifetime + active auto-renewals.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Logger } from 'pino';
import type { PrismaClient } from '@wishlist/db';
import { startProRenewalReminderScheduler } from './pro-renewal';

const HOURLY_MS = 60 * 60 * 1000;
const fakeLogger = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() } as unknown as Logger);

let prisma: {
  subscription: { findMany: ReturnType<typeof vi.fn> };
  paymentEvent: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
};
let sendLifecycleDM: ReturnType<typeof vi.fn>;
let trackEvent: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  prisma = {
    subscription: { findMany: vi.fn().mockResolvedValue([]) },
    paymentEvent: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
  };
  sendLifecycleDM = vi.fn().mockResolvedValue('delivered');
  trackEvent = vi.fn();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function start() {
  startProRenewalReminderScheduler({
    prisma: prisma as unknown as PrismaClient,
    logger: fakeLogger(),
    sendLifecycleDM,
    trackEvent,
    PRO_PLAN_CODE: 'PRO',
    MINI_APP_URL_FOR_DM: 'https://app.test/miniapp',
  });
}

describe('startProRenewalReminderScheduler', () => {
  it('queries 7d AND 1d windows on each tick', async () => {
    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    expect(prisma.subscription.findMany).toHaveBeenCalledTimes(2);
  });

  it('excludes lifetime subscriptions via NOT billingPeriod', async () => {
    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    const where = prisma.subscription.findMany.mock.calls[0]![0].where;
    expect(where.NOT).toEqual({ billingPeriod: 'lifetime' });
  });

  it('targets only yearly OR cancelAtPeriodEnd subs (skips auto-renewing monthly)', async () => {
    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    const where = prisma.subscription.findMany.mock.calls[0]![0].where;
    expect(where.OR).toEqual([{ billingPeriod: 'yearly' }, { cancelAtPeriodEnd: true }]);
  });

  it('sends DM in recipient locale + tracks analytics on delivered', async () => {
    prisma.subscription.findMany
      .mockResolvedValueOnce([{
        id: 'sub1', userId: 'u1', billingPeriod: 'yearly',
        currentPeriodEnd: new Date('2099-12-31'),
        user: { id: 'u1', telegramChatId: 'chat-ru', profile: { languageMode: 'auto', manualLanguage: null, notifyMarketing: true, normalizedLocale: 'ru', language: null } },
      }])
      .mockResolvedValueOnce([]);

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(sendLifecycleDM).toHaveBeenCalledOnce();
    expect(trackEvent).toHaveBeenCalledWith('pro_renewal_reminder_7d', 'u1', { billingPeriod: 'yearly' });
    expect(prisma.paymentEvent.create).toHaveBeenCalledOnce();
  });

  // Regression — 2026-05-16. Reminder button used to open the home tab
  // because the URL was passed bare. MiniApp.tsx reads `startapp=upgrade_pro`
  // from window.location.search and surfaces the paywall sheet.
  it('deep-links the button to the PRO paywall (?startapp=upgrade_pro)', async () => {
    prisma.subscription.findMany
      .mockResolvedValueOnce([{
        id: 'sub1', userId: 'u1', billingPeriod: 'yearly',
        currentPeriodEnd: new Date('2099-12-31'),
        user: { id: 'u1', telegramChatId: 'chat', profile: { notifyMarketing: true, normalizedLocale: 'ru' } },
      }])
      .mockResolvedValueOnce([]);

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(sendLifecycleDM).toHaveBeenCalledOnce();
    const webAppUrl = sendLifecycleDM.mock.calls[0]![3];
    expect(webAppUrl).toBe('https://app.test/miniapp?startapp=upgrade_pro');
  });

  it('skips users who opted out of marketing notifications', async () => {
    prisma.subscription.findMany
      .mockResolvedValueOnce([{
        id: 'sub1', userId: 'u1', billingPeriod: 'yearly',
        currentPeriodEnd: new Date('2099-12-31'),
        user: { id: 'u1', telegramChatId: 'chat', profile: { notifyMarketing: false } },
      }])
      .mockResolvedValueOnce([]);

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(sendLifecycleDM).not.toHaveBeenCalled();
  });

  it('skips users without telegramChatId', async () => {
    prisma.subscription.findMany
      .mockResolvedValueOnce([{
        id: 'sub1', userId: 'u1', billingPeriod: 'yearly',
        currentPeriodEnd: new Date('2099-12-31'),
        user: { id: 'u1', telegramChatId: null, profile: {} },
      }])
      .mockResolvedValueOnce([]);

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(sendLifecycleDM).not.toHaveBeenCalled();
  });

  it('idempotency: skips reminder when paymentEvent marker already exists', async () => {
    prisma.subscription.findMany
      .mockResolvedValueOnce([{
        id: 'sub1', userId: 'u1', billingPeriod: 'yearly',
        currentPeriodEnd: new Date('2099-12-31'),
        user: { id: 'u1', telegramChatId: 'c', profile: { notifyMarketing: true } },
      }])
      .mockResolvedValueOnce([]);
    prisma.paymentEvent.findUnique.mockResolvedValueOnce({ id: 'existing' });

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(sendLifecycleDM).not.toHaveBeenCalled();
  });

  it('transient_failure → does NOT persist marker (retries next hour)', async () => {
    prisma.subscription.findMany
      .mockResolvedValueOnce([{
        id: 'sub1', userId: 'u1', billingPeriod: 'yearly',
        currentPeriodEnd: new Date('2099-12-31'),
        user: { id: 'u1', telegramChatId: 'c', profile: { notifyMarketing: true } },
      }])
      .mockResolvedValueOnce([]);
    sendLifecycleDM.mockResolvedValueOnce('transient_failure');

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(prisma.paymentEvent.create).not.toHaveBeenCalled();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('permanent_failure → persists marker but does NOT track analytics', async () => {
    prisma.subscription.findMany
      .mockResolvedValueOnce([{
        id: 'sub1', userId: 'u1', billingPeriod: 'yearly',
        currentPeriodEnd: new Date('2099-12-31'),
        user: { id: 'u1', telegramChatId: 'c', profile: { notifyMarketing: true } },
      }])
      .mockResolvedValueOnce([]);
    sendLifecycleDM.mockResolvedValueOnce('bot_blocked');

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    expect(prisma.paymentEvent.create).toHaveBeenCalledOnce();
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('swallows top-level errors — never bubbles out of setInterval', async () => {
    prisma.subscription.findMany.mockRejectedValueOnce(new Error('DB down'));
    expect(() => start()).not.toThrow();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
  });
});
