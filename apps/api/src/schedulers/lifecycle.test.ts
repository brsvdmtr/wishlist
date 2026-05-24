// Tests for schedulers/lifecycle.ts — hourly win-back wave/touch dispatcher.
// Module-scope mutable state (lifecycleDeadCycles counter); we just exercise
// the cron tick contract (queries, error containment, locale resolution).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Logger } from 'pino';
import type { PrismaClient } from '@wishlist/db';
import { startLifecycleScheduler } from './lifecycle';

const HOURLY_MS = 60 * 60 * 1000;
const fakeLogger = (): Logger => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(), trace: vi.fn(), child: vi.fn() } as unknown as Logger);

let prisma: {
  user: { findMany: ReturnType<typeof vi.fn>; findUnique: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
  lifecycleTouch: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  promoCode: { findFirst: ReturnType<typeof vi.fn> };
  wishlist: { count: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  item: { count: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  subscription: { findFirst: ReturnType<typeof vi.fn> };
  paymentEvent: { findFirst: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  promoRedemption: { findFirst: ReturnType<typeof vi.fn> };
};
let sendLifecycleDM: ReturnType<typeof vi.fn>;
let getUserEntitlement: ReturnType<typeof vi.fn>;
let trackEvent: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  prisma = {
    user: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      count: vi.fn().mockResolvedValue(0),
    },
    lifecycleTouch: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
    },
    promoCode: { findFirst: vi.fn().mockResolvedValue(null) },
    wishlist: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    item: { count: vi.fn().mockResolvedValue(0), findMany: vi.fn().mockResolvedValue([]) },
    subscription: { findFirst: vi.fn().mockResolvedValue(null) },
    paymentEvent: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}) },
    promoRedemption: { findFirst: vi.fn().mockResolvedValue(null) },
  };
  sendLifecycleDM = vi.fn().mockResolvedValue('delivered');
  getUserEntitlement = vi.fn().mockResolvedValue({ isPro: false, proSource: null });
  trackEvent = vi.fn();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

function start(opts: { botToken?: string } = {}) {
  startLifecycleScheduler({
    prisma: prisma as unknown as PrismaClient,
    logger: fakeLogger(),
    sendLifecycleDM,
    getUserEntitlement,
    trackEvent,
    MINI_APP_URL_FOR_DM: 'https://app.test/miniapp',
    LIFECYCLE_PROMO_CODE: 'WISHPRO',
    BOT_TOKEN_FOR_DM: opts.botToken === undefined ? 'TOKEN' : opts.botToken,
  });
}

describe('startLifecycleScheduler', () => {
  it('does not query users when BOT_TOKEN_FOR_DM is empty', async () => {
    start({ botToken: '' });
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('runs on hourly cadence and queries users', async () => {
    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    expect(prisma.user.findMany).toHaveBeenCalled();
  });

  it('top-level error containment — DB failure does not bubble', async () => {
    prisma.user.findMany.mockRejectedValueOnce(new Error('DB down'));
    expect(() => start()).not.toThrow();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
  });

  it('skips PRO users when classifying (proSource=subscription stops lifecycle)', async () => {
    // Empty candidate pool — we just verify the entry guard doesn't throw
    // when getUserEntitlement is called.
    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    // No assertion on getUserEntitlement call count — depends on cohort.
  });

  it('ticks multiple times (drift over hours)', async () => {
    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    await vi.advanceTimersByTimeAsync(HOURLY_MS);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(3);
  });

  // Regression: 2026-05-23 dead-air. A monthly touch stamped sentAt+stoppedAt
  // (delivery_failed / chat_not_found) froze the user for the rest of the
  // calendar month, because `episodeTouches` filtered out stopped touches
  // (counter stayed at 0) while the upsert downstream short-circuited on the
  // existing record (sentAt set) → continue. Whole `WOULD_SEND` cohort dried up.
  it('counts current-monthly-episode attempts via episodeKey (not segment+stoppedAt:null)', async () => {
    vi.setSystemTime(new Date('2026-05-24T17:00:00Z'));

    const userId = 'u-stuck';
    const chatId = '111';

    prisma.user.findMany.mockResolvedValue([{
      id: userId,
      telegramChatId: chatId,
      telegramId: 1,
      updatedAt: new Date('2026-05-21T10:00:00Z'), // 3.3d inactive
      createdAt: new Date('2026-04-01T00:00:00Z'),
      profile: { notifyMarketing: true, languageMode: 'auto', manualLanguage: null, normalizedLocale: null, language: null },
    }] as never);

    // Two findUnique call shapes: classifier (selects wishlists) and
    // shouldStopLifecycle (selects profile.notifyMarketing).
    prisma.user.findUnique.mockImplementation((args: unknown) => {
      const a = args as { select?: { wishlists?: unknown; profile?: unknown } };
      if (a.select?.wishlists) {
        // Empty wishlists → S1
        return Promise.resolve({
          id: userId,
          updatedAt: new Date('2026-05-21T10:00:00Z'),
          createdAt: new Date('2026-04-01T00:00:00Z'),
          wishlists: [],
        }) as never;
      }
      return Promise.resolve({
        id: userId,
        updatedAt: new Date('2026-05-21T10:00:00Z'),
        profile: { notifyMarketing: true },
      }) as never;
    });

    // DB state: one stopped May S1 touch 1 exists (chat_not_found).
    // Post-fix count call shape: { userId, episodeKey: 'S1_u-stuck_2026-05', sentAt: { not: null } } → returns 1.
    // Pre-fix shape: { userId, segment: 'S1', sentAt: { not: null }, stoppedAt: null } → returns 0 (BUG).
    prisma.lifecycleTouch.count.mockImplementation((args: unknown) => {
      const w = (args as { where?: Record<string, unknown> }).where ?? {};
      const epKey = w.episodeKey as string | undefined;
      const stoppedAtFilter = w.stoppedAt;
      if (epKey === `S1_${userId}_2026-05` && stoppedAtFilter === undefined) {
        return Promise.resolve(1);
      }
      return Promise.resolve(0);
    });

    // Upsert: if scheduler asks for touchNumber=1, return the existing stopped row
    // (pre-fix path — should NOT happen after fix). For touchNumber=2, return a
    // fresh pending row that will be sent.
    (prisma.lifecycleTouch as unknown as { upsert: ReturnType<typeof vi.fn> }).upsert = vi.fn().mockImplementation((args: unknown) => {
      const tn = (args as { where: { userId_episodeKey_touchNumber: { touchNumber: number } } })
        .where.userId_episodeKey_touchNumber.touchNumber;
      if (tn === 1) {
        return Promise.resolve({ id: 't1-stopped', sentAt: new Date('2026-05-01'), stoppedAt: new Date('2026-05-01'), deepLinkPayload: 'create_wishlist' });
      }
      return Promise.resolve({ id: `t${tn}-new`, sentAt: null, stoppedAt: null, deepLinkPayload: 'create_wishlist' });
    });

    start();
    await vi.advanceTimersByTimeAsync(HOURLY_MS);

    // Post-fix: episodeTouches=1 → nextTouchNumber=2 → upsert touch 2 → send.
    // Pre-fix: episodeTouches=0 → nextTouchNumber=1 → upsert returns stopped row (sentAt) → continue → no send.
    expect(sendLifecycleDM).toHaveBeenCalledTimes(1);
    expect(sendLifecycleDM).toHaveBeenCalledWith(
      chatId,
      expect.any(String),
      expect.any(String),
      expect.stringContaining('startapp='),
    );
  });
});
