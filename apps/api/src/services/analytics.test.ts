// Unit tests for services/analytics.ts.
//
// Both functions are fire-and-forget: writes are awaited via `.catch()` and
// debug-logged on failure. Tests assert dispatch behaviour (does it call
// prisma.analyticsEvent.create?) plus the truncation and allowlist contracts.
//
// The Prisma client and logger are mocked at module-load time so the tests
// run in zero-IO mode.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  create: vi.fn(),
  loggerInfo: vi.fn(),
  loggerDebug: vi.fn(),
}));

vi.mock('@wishlist/db', () => ({
  prisma: { analyticsEvent: { create: shared.create } },
}));

vi.mock('../logger', () => ({
  default: {
    info: shared.loggerInfo,
    debug: shared.loggerDebug,
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { trackEvent, trackAnalyticsEvent, trackProductEvent } from './analytics';
import { ANALYTICS_EVENTS } from '@wishlist/shared';

beforeEach(() => {
  shared.create.mockReset();
  shared.create.mockResolvedValue({});
  shared.loggerInfo.mockReset();
  shared.loggerDebug.mockReset();
});

describe('trackEvent — logging side', () => {
  it('always emits a logger.info line with event, userId, props', () => {
    trackEvent('generic_event_not_persisted', 'u1', { foo: 'bar' });
    expect(shared.loggerInfo).toHaveBeenCalledWith(
      { event: 'generic_event_not_persisted', userId: 'u1', props: { foo: 'bar' } },
      'analytics event',
    );
  });

  it('logs even when userId is missing', () => {
    trackEvent('anonymous_event');
    expect(shared.loggerInfo).toHaveBeenCalled();
  });
});

describe('trackEvent — persistence prefix allowlist', () => {
  const prefixes = [
    'feature_gate_hit_pro',
    'onboarding_step_1',
    'demo_item_clicked',
    'gift_redeemed',
    'first_share_prompt_shown',
    'ready_share_prompt_accepted',
    'group_gift_created',
    'secret_res.created',
    'showcase.viewed',
    'public_profile.opened',
    'error:billing.invoice_failed',
  ];

  for (const event of prefixes) {
    it(`persists ${event} when userId is provided`, () => {
      trackEvent(event, 'u1', { source: 'test' });
      expect(shared.create).toHaveBeenCalledOnce();
      const args = shared.create.mock.calls[0]![0];
      expect(args.data.event).toBe(event);
      expect(args.data.userId).toBe('u1');
      expect(args.data.props).toEqual({ source: 'test' });
    });
  }

  it('does NOT persist an event with userId when prefix is not in allowlist', () => {
    trackEvent('random_event_not_in_allowlist', 'u1');
    expect(shared.create).not.toHaveBeenCalled();
  });

  it('does NOT persist an allowlisted event without a userId', () => {
    trackEvent('onboarding_step_5', undefined);
    expect(shared.create).not.toHaveBeenCalled();
  });

  it('swallows Prisma write errors and downgrades to debug log', async () => {
    shared.create.mockRejectedValueOnce(new Error('DB down'));
    // Must not throw — fire-and-forget.
    expect(() => trackEvent('feature_gate_hit_pro', 'u1')).not.toThrow();
    // Wait a microtask for .catch() to fire.
    await Promise.resolve();
    await Promise.resolve();
    expect(shared.loggerDebug).toHaveBeenCalled();
  });
});

describe('trackAnalyticsEvent — allowlist + truncation', () => {
  // Pick first known event from the shared allowlist — tests stay valid even
  // if ANALYTICS_EVENTS is re-ordered, as long as it stays non-empty.
  const knownEvent = ANALYTICS_EVENTS[0]!;

  it('persists an allowlisted event', () => {
    trackAnalyticsEvent({ event: knownEvent, userId: 'u1', props: { x: 1 } });
    expect(shared.create).toHaveBeenCalledOnce();
    expect(shared.create.mock.calls[0]![0].data.event).toBe(knownEvent);
  });

  it('silently drops events not in the allowlist', () => {
    trackAnalyticsEvent({ event: 'definitely_not_in_allowlist_xyz', userId: 'u1' });
    expect(shared.create).not.toHaveBeenCalled();
  });

  it('passes null userId through when not provided (anonymous events)', () => {
    trackAnalyticsEvent({ event: knownEvent });
    expect(shared.create).toHaveBeenCalledOnce();
    expect(shared.create.mock.calls[0]![0].data.userId).toBeNull();
  });

  it('truncates a long string prop to 300 chars + ellipsis', () => {
    const long = 'x'.repeat(500);
    trackAnalyticsEvent({ event: knownEvent, userId: 'u1', props: { msg: long } });
    const stored = shared.create.mock.calls[0]![0].data.props;
    expect(stored.msg.length).toBe(303);
    expect(stored.msg.endsWith('...')).toBe(true);
  });

  it('replaces props with { _truncated: true } when total serialized > 1024 bytes', () => {
    // 10 keys of 200 chars each — each under the 300 char cap so not
    // individually truncated, but combined > 1024 bytes when serialised.
    const props: Record<string, string> = {};
    for (let i = 0; i < 10; i++) props[`k${i}`] = 'a'.repeat(200);
    trackAnalyticsEvent({ event: knownEvent, userId: 'u1', props });
    expect(shared.create.mock.calls[0]![0].data.props).toEqual({ _truncated: true });
  });

  it('leaves small props alone', () => {
    trackAnalyticsEvent({ event: knownEvent, userId: 'u1', props: { plan: 'pro' } });
    expect(shared.create.mock.calls[0]![0].data.props).toEqual({ plan: 'pro' });
  });

  it('handles missing props gracefully', () => {
    trackAnalyticsEvent({ event: knownEvent, userId: 'u1' });
    expect(shared.create).toHaveBeenCalledOnce();
    expect(shared.create.mock.calls[0]![0].data.props).toBeUndefined();
  });

  it('swallows Prisma write errors', async () => {
    shared.create.mockRejectedValueOnce(new Error('DB locked'));
    expect(() => trackAnalyticsEvent({ event: knownEvent, userId: 'u1' })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(shared.loggerDebug).toHaveBeenCalled();
  });
});

describe('trackProductEvent — typed taxonomy helper', () => {
  it('persists a serverOnly event (payment.completed) from backend code', () => {
    trackProductEvent({ event: 'payment.completed', userId: 'u1', props: { amount: 100 } });
    expect(shared.create).toHaveBeenCalledOnce();
    const args = shared.create.mock.calls[0]![0];
    expect(args.data.event).toBe('payment.completed');
    expect(args.data.userId).toBe('u1');
    expect(args.data.props).toEqual({ amount: 100 });
  });

  it('persists a clientAllowed event (paywall.viewed)', () => {
    trackProductEvent({ event: 'paywall.viewed', userId: 'u1', props: { plan: 'monthly' } });
    expect(shared.create).toHaveBeenCalledOnce();
    expect(shared.create.mock.calls[0]![0].data.event).toBe('paywall.viewed');
  });

  it('persists pro.activated and subscription.renewed (server-authoritative)', () => {
    trackProductEvent({ event: 'pro.activated', userId: 'u1' });
    trackProductEvent({ event: 'subscription.renewed', userId: 'u1' });
    expect(shared.create).toHaveBeenCalledTimes(2);
    expect(shared.create.mock.calls[0]![0].data.event).toBe('pro.activated');
    expect(shared.create.mock.calls[1]![0].data.event).toBe('subscription.renewed');
  });

  it('silently drops events not in PRODUCT_EVENTS (defense in depth)', () => {
    // Compile-time `event` is typed, but a caller reaching this through
    // `any`-typed dispatch should still be rejected at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trackProductEvent({ event: 'definitely_not_in_product_events' as any, userId: 'u1' });
    expect(shared.create).not.toHaveBeenCalled();
  });

  it('does NOT accept legacy ANALYTICS_EVENTS names (wishlist.created)', () => {
    // The typed helper is intentionally distinct from `trackAnalyticsEvent`.
    // A legacy event name is not in PRODUCT_EVENTS and gets dropped here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    trackProductEvent({ event: 'wishlist.created' as any, userId: 'u1' });
    expect(shared.create).not.toHaveBeenCalled();
  });

  it('passes null userId through when not provided', () => {
    trackProductEvent({ event: 'paywall.viewed' });
    expect(shared.create).toHaveBeenCalledOnce();
    expect(shared.create.mock.calls[0]![0].data.userId).toBeNull();
  });

  it('truncates long string props (300 char cap)', () => {
    const long = 'x'.repeat(500);
    trackProductEvent({ event: 'paywall.viewed', userId: 'u1', props: { msg: long } });
    const stored = shared.create.mock.calls[0]![0].data.props;
    expect(stored.msg.length).toBe(303);
    expect(stored.msg.endsWith('...')).toBe(true);
  });

  it('replaces props with { _truncated: true } when serialised > 1024 bytes', () => {
    const props: Record<string, string> = {};
    for (let i = 0; i < 10; i++) props[`k${i}`] = 'a'.repeat(200);
    trackProductEvent({ event: 'paywall.viewed', userId: 'u1', props });
    expect(shared.create.mock.calls[0]![0].data.props).toEqual({ _truncated: true });
  });

  it('swallows Prisma write errors and logs debug', async () => {
    shared.create.mockRejectedValueOnce(new Error('DB locked'));
    expect(() => trackProductEvent({ event: 'paywall.viewed', userId: 'u1' })).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(shared.loggerDebug).toHaveBeenCalled();
  });
});

describe('PII sanitization — user content never reaches the AnalyticsEvent table', () => {
  const knownEvent = ANALYTICS_EVENTS[0]!;

  it('trackEvent strips title/description from persisted props', () => {
    trackEvent('feature_gate_hit_pro', 'u1', {
      itemId: 'i1',
      source: 'manual',
      title: 'My private wish title',
      description: 'A long personal description',
    });
    expect(shared.create).toHaveBeenCalledOnce();
    expect(shared.create.mock.calls[0]![0].data.props).toEqual({ itemId: 'i1', source: 'manual' });
  });

  it('trackEvent logs sanitized props — no raw user content in pino logs', () => {
    // item_created flows through trackEvent (log-only here — `item_` is not a
    // persistence prefix); the log line must not carry content either.
    trackEvent('item_created', 'u1', { wishlistId: 'w1', title: 'secret', description: 'secret' });
    expect(shared.loggerInfo).toHaveBeenCalledWith(
      { event: 'item_created', userId: 'u1', props: { wishlistId: 'w1' } },
      'analytics event',
    );
  });

  it('trackAnalyticsEvent strips comment / hint / search content keys', () => {
    trackAnalyticsEvent({
      event: knownEvent,
      userId: 'u1',
      props: { itemId: 'i1', commentText: 'private', hintText: 'private', query: 'private search' },
    });
    expect(shared.create.mock.calls[0]![0].data.props).toEqual({ itemId: 'i1' });
  });

  it('trackProductEvent strips freeform-content keys', () => {
    trackProductEvent({ event: 'paywall.viewed', userId: 'u1', props: { plan: 'monthly', note: 'freeform note' } });
    expect(shared.create.mock.calls[0]![0].data.props).toEqual({ plan: 'monthly' });
  });
});
