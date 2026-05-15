// Unit tests for schedulers/referral.ts.
//
// Scheduler exposes only `startReferralSchedulers(deps)` which sets up a
// 15-min setInterval. Tests use fake timers to advance time and verify the
// sweep + analytics dispatch shape on each tick.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Logger } from 'pino';
import { startReferralSchedulers } from './referral';

const REFERRAL_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

function fakeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // Drain pending fake timers BEFORE switching back to real, otherwise the
  // clear runs against the (already-restored) real timer queue and no-ops.
  // The pattern matters: this scheduler file is the proof-of-shape for the
  // remaining 7 schedulers in Phase 3.
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('startReferralSchedulers — sweep tick', () => {
  it('does not run the sweep immediately (only on first interval tick)', async () => {
    const sweepFn = vi.fn().mockResolvedValue({ expired: 0 });
    const trackAnalyticsEvent = vi.fn();

    startReferralSchedulers({
      prisma: {} as never,
      logger: fakeLogger(),
      trackAnalyticsEvent,
      sweepExpiredPendingAttributions: sweepFn,
    });

    expect(sweepFn).not.toHaveBeenCalled();
  });

  it('runs the sweep on every 15-minute tick', async () => {
    const sweepFn = vi.fn().mockResolvedValue({ expired: 0 });
    const trackAnalyticsEvent = vi.fn();

    startReferralSchedulers({
      prisma: {} as never,
      logger: fakeLogger(),
      trackAnalyticsEvent,
      sweepExpiredPendingAttributions: sweepFn,
    });

    await vi.advanceTimersByTimeAsync(REFERRAL_SWEEP_INTERVAL_MS);
    expect(sweepFn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(REFERRAL_SWEEP_INTERVAL_MS);
    expect(sweepFn).toHaveBeenCalledTimes(2);
  });

  it('emits referral.qualification_timeout when at least one row expired', async () => {
    const sweepFn = vi.fn().mockResolvedValue({ expired: 5 });
    const trackAnalyticsEvent = vi.fn();
    const logger = fakeLogger();

    startReferralSchedulers({
      prisma: {} as never,
      logger,
      trackAnalyticsEvent,
      sweepExpiredPendingAttributions: sweepFn,
    });

    await vi.advanceTimersByTimeAsync(REFERRAL_SWEEP_INTERVAL_MS);

    expect(trackAnalyticsEvent).toHaveBeenCalledWith({
      event: 'referral.qualification_timeout',
      props: { expired: 5, source: 'cron' },
    });
    expect(logger.info).toHaveBeenCalled();
  });

  it('does NOT emit analytics or log when nothing expired (zero-noise idle ticks)', async () => {
    const sweepFn = vi.fn().mockResolvedValue({ expired: 0 });
    const trackAnalyticsEvent = vi.fn();
    const logger = fakeLogger();

    startReferralSchedulers({
      prisma: {} as never,
      logger,
      trackAnalyticsEvent,
      sweepExpiredPendingAttributions: sweepFn,
    });

    await vi.advanceTimersByTimeAsync(REFERRAL_SWEEP_INTERVAL_MS);

    expect(trackAnalyticsEvent).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('swallows sweep errors — logs at error level, never bubbles', async () => {
    const sweepFn = vi.fn().mockRejectedValue(new Error('DB down'));
    const trackAnalyticsEvent = vi.fn();
    const logger = fakeLogger();

    startReferralSchedulers({
      prisma: {} as never,
      logger,
      trackAnalyticsEvent,
      sweepExpiredPendingAttributions: sweepFn,
    });

    await vi.advanceTimersByTimeAsync(REFERRAL_SWEEP_INTERVAL_MS);

    expect(logger.error).toHaveBeenCalled();
    expect(trackAnalyticsEvent).not.toHaveBeenCalled();
  });

  it('continues ticking after a failed sweep (next tick recovers)', async () => {
    const sweepFn = vi.fn()
      .mockRejectedValueOnce(new Error('transient DB'))
      .mockResolvedValueOnce({ expired: 2 });
    const trackAnalyticsEvent = vi.fn();

    startReferralSchedulers({
      prisma: {} as never,
      logger: fakeLogger(),
      trackAnalyticsEvent,
      sweepExpiredPendingAttributions: sweepFn,
    });

    await vi.advanceTimersByTimeAsync(REFERRAL_SWEEP_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(REFERRAL_SWEEP_INTERVAL_MS);

    expect(sweepFn).toHaveBeenCalledTimes(2);
    expect(trackAnalyticsEvent).toHaveBeenCalledWith({
      event: 'referral.qualification_timeout',
      props: { expired: 2, source: 'cron' },
    });
  });
});
