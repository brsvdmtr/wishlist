// Unit test for the daily retention tick that emits
// referral.invitee_retained_d7 / d30 — gate C3 of the referral re-enable
// plan (docs/research/referral-decision.md § 7.3).

import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';
import { runReferralRetentionTick } from './referral-retention';

const DAY = 24 * 60 * 60 * 1000;

type Att = {
  id: string;
  invitedUserId: string;
  inviterUserId: string;
  attributedAt: Date;
  status: string;
};

type Activity = { userId: string; date: Date; sessionStarted: number };

type AnalyticsRow = { event: string; props: Record<string, unknown> | null };

function makeDeps(opts: {
  attributions: Att[];
  activities: Activity[];
  preExistingAnalytics?: AnalyticsRow[];
}) {
  const captured: Array<{ event: string; userId?: string; props?: Record<string, unknown> }> = [];
  const analyticsRows: AnalyticsRow[] = [...(opts.preExistingAnalytics ?? [])];

  const prisma = {
    referralAttribution: {
      findMany: async (args: { where: { attributedAt: { gte: Date; lt: Date }; status: { in: string[] } } }) => {
        return opts.attributions.filter(
          (a) =>
            a.attributedAt >= args.where.attributedAt.gte &&
            a.attributedAt < args.where.attributedAt.lt &&
            args.where.status.in.includes(a.status),
        );
      },
    },
    userDailyActivity: {
      findFirst: async (args: {
        where: { userId: string; date: { gte: Date; lt: Date }; sessionStarted: { gt: number } };
      }) => {
        const hit = opts.activities.find(
          (a) =>
            a.userId === args.where.userId &&
            a.date >= args.where.date.gte &&
            a.date < args.where.date.lt &&
            a.sessionStarted > args.where.sessionStarted.gt,
        );
        return hit ? { userId: hit.userId } : null;
      },
    },
    analyticsEvent: {
      findFirst: async (args: {
        where: { event: string; props: { path: string[]; equals: unknown } };
      }) => {
        return analyticsRows.find(
          (r) => r.event === args.where.event && r.props?.[args.where.props.path[0]!] === args.where.props.equals,
        ) ?? null;
      },
    },
  };

  const trackAnalyticsEvent = (input: { event: string; userId?: string; props?: Record<string, unknown> }) => {
    captured.push(input);
    analyticsRows.push({ event: input.event, props: (input.props ?? null) as Record<string, unknown> | null });
  };

  const logger: Logger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;

  return { captured, deps: { prisma: prisma as never, logger, trackAnalyticsEvent } };
}

describe('runReferralRetentionTick', () => {
  it('emits invitee_retained_d7 when invitee had activity in the day-7 window', async () => {
    const now = Date.now();
    const { captured, deps } = makeDeps({
      attributions: [{
        id: 'a1',
        invitedUserId: 'invitee1',
        inviterUserId: 'inviter1',
        attributedAt: new Date(now - 7 * DAY - 6 * 60 * 60_000), // ~7d ago, inside (now-8d, now-7d)
        status: 'QUALIFIED',
      }],
      activities: [{
        userId: 'invitee1',
        date: new Date(now - 6 * 60 * 60_000), // anchor + 7d ≈ now, inside window
        sessionStarted: 1,
      }],
    });
    const result = await runReferralRetentionTick(deps);
    expect(result.emitted.d7).toBe(1);
    expect(result.emitted.d30).toBe(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]).toMatchObject({
      event: 'referral.invitee_retained_d7',
      userId: 'invitee1',
      props: { attributionId: 'a1', inviterUserId: 'inviter1', deltaDays: 7 },
    });
  });

  it('does NOT emit when invitee had no sessionStarted activity', async () => {
    const now = Date.now();
    const { captured, deps } = makeDeps({
      attributions: [{
        id: 'a1',
        invitedUserId: 'invitee1',
        inviterUserId: 'inviter1',
        attributedAt: new Date(now - 7 * DAY - 6 * 60 * 60_000),
        status: 'QUALIFIED',
      }],
      activities: [], // no activity at all
    });
    const result = await runReferralRetentionTick(deps);
    expect(result.emitted.d7).toBe(0);
    expect(captured).toHaveLength(0);
  });

  it('is idempotent — does NOT re-emit when invitee_retained_d7 already exists for the attribution', async () => {
    const now = Date.now();
    const { captured, deps } = makeDeps({
      attributions: [{
        id: 'a1',
        invitedUserId: 'invitee1',
        inviterUserId: 'inviter1',
        attributedAt: new Date(now - 7 * DAY - 6 * 60 * 60_000),
        status: 'QUALIFIED',
      }],
      activities: [{ userId: 'invitee1', date: new Date(now - 6 * 60 * 60_000), sessionStarted: 1 }],
      preExistingAnalytics: [
        { event: 'referral.invitee_retained_d7', props: { attributionId: 'a1' } },
      ],
    });
    const result = await runReferralRetentionTick(deps);
    expect(result.emitted.d7).toBe(0);
    expect(captured).toHaveLength(0);
  });

  it('emits d30 separately from d7 (independent cohort windows)', async () => {
    const now = Date.now();
    const { captured, deps } = makeDeps({
      attributions: [{
        id: 'a30',
        invitedUserId: 'invitee2',
        inviterUserId: 'inviter2',
        attributedAt: new Date(now - 30 * DAY - 6 * 60 * 60_000),
        status: 'REWARDED',
      }],
      activities: [{
        userId: 'invitee2',
        date: new Date(now - 6 * 60 * 60_000), // anchor + 30d ≈ now
        sessionStarted: 3,
      }],
    });
    const result = await runReferralRetentionTick(deps);
    expect(result.emitted.d30).toBe(1);
    expect(result.emitted.d7).toBe(0);
    expect(captured[0]).toMatchObject({
      event: 'referral.invitee_retained_d30',
      props: { attributionId: 'a30', deltaDays: 30 },
    });
  });

  it('skips attributions in REJECTED state (no retention metric for rejected referrals)', async () => {
    const now = Date.now();
    const { captured, deps } = makeDeps({
      attributions: [{
        id: 'arej',
        invitedUserId: 'invitee3',
        inviterUserId: 'inviter3',
        attributedAt: new Date(now - 7 * DAY - 6 * 60 * 60_000),
        status: 'REJECTED',
      }],
      activities: [{ userId: 'invitee3', date: new Date(now - 6 * 60 * 60_000), sessionStarted: 5 }],
    });
    const result = await runReferralRetentionTick(deps);
    expect(result.emitted.d7).toBe(0);
    expect(captured).toHaveLength(0);
  });
});
