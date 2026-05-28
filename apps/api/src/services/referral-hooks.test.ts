// Unit tests for services/referral-hooks.ts.
//
// Two public functions: notifyReferralInviterRewarded (best-effort DM with
// locale resolution + delivery analytics) and runReferralProgressHook (the
// qualify + reward pipeline with branching analytics for every outcome).
//
// Strategy: mock @wishlist/db + analytics + Telegram + logger at module
// boundaries. The shared resolver is real (we want per-recipient locale
// behaviour covered end-to-end here).

import { describe, it, expect, beforeEach, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userProfileFindUnique: vi.fn(),
  loadReferralConfig: vi.fn(),
  markFirstWishlist: vi.fn(),
  markFirstItem: vi.fn(),
  tryQualifyAttribution: vi.fn(),
  processReward: vi.fn(),
  sendTgBotMessage: vi.fn(),
  trackAnalyticsEvent: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
  loggerInfo: vi.fn(),
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    user: { findUnique: shared.userFindUnique },
    userProfile: { findUnique: shared.userProfileFindUnique },
  },
  loadReferralConfig: shared.loadReferralConfig,
  markFirstWishlist: shared.markFirstWishlist,
  markFirstItem: shared.markFirstItem,
  tryQualifyAttribution: shared.tryQualifyAttribution,
  processReward: shared.processReward,
}));

vi.mock('../telegram/botApi', () => ({
  sendTgBotMessage: shared.sendTgBotMessage,
}));

vi.mock('./analytics', () => ({
  trackAnalyticsEvent: shared.trackAnalyticsEvent,
}));

vi.mock('../logger', () => ({
  default: {
    warn: shared.loggerWarn,
    error: shared.loggerError,
    debug: shared.loggerDebug,
    info: shared.loggerInfo,
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  },
}));

import { notifyReferralInviterRewarded, runReferralProgressHook } from './referral-hooks';

beforeEach(() => {
  for (const v of Object.values(shared)) (v as ReturnType<typeof vi.fn>).mockReset?.();
  shared.loadReferralConfig.mockResolvedValue({ notifyInviterReward: true });
  // Default: organic user (no invite). Tests that exercise the invitee branch
  // override this with mockResolvedValueOnce({ referredByUserId: 'inviter-X' }).
  shared.userProfileFindUnique.mockResolvedValue({ referredByUserId: null });
});

describe('notifyReferralInviterRewarded', () => {
  it('skips entirely when config.notifyInviterReward is false', async () => {
    shared.loadReferralConfig.mockResolvedValueOnce({ notifyInviterReward: false });
    await notifyReferralInviterRewarded('inviter-1', 7);
    expect(shared.userFindUnique).not.toHaveBeenCalled();
    expect(shared.sendTgBotMessage).not.toHaveBeenCalled();
  });

  it('skips when inviter has no telegramChatId', async () => {
    shared.userFindUnique.mockResolvedValueOnce({ telegramChatId: null, profile: null });
    await notifyReferralInviterRewarded('inviter-2', 7);
    expect(shared.sendTgBotMessage).not.toHaveBeenCalled();
    expect(shared.trackAnalyticsEvent).not.toHaveBeenCalled();
  });

  it('sends DM in inviter\'s locale and emits sent event on success', async () => {
    shared.userFindUnique.mockResolvedValueOnce({
      telegramChatId: 'chat-ru',
      profile: { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'ru', language: null },
    });
    shared.sendTgBotMessage.mockResolvedValueOnce(true);

    await notifyReferralInviterRewarded('inviter-3', 30);

    expect(shared.sendTgBotMessage).toHaveBeenCalledWith('chat-ru', expect.any(String));
    expect(shared.trackAnalyticsEvent).toHaveBeenCalledWith({
      event: 'referral.bot_notification_sent',
      userId: 'inviter-3',
      props: { type: 'reward', daysGranted: 30 },
    });
  });

  it('emits delivery_failed event when sendTgBotMessage returns false', async () => {
    shared.userFindUnique.mockResolvedValueOnce({
      telegramChatId: 'chat',
      profile: { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'en', language: null },
    });
    shared.sendTgBotMessage.mockResolvedValueOnce(false);

    await notifyReferralInviterRewarded('inviter-4', 14);

    expect(shared.trackAnalyticsEvent).toHaveBeenCalledWith({
      event: 'referral.bot_notification_delivery_failed',
      userId: 'inviter-4',
      props: { type: 'reward', daysGranted: 14 },
    });
  });

  it('does not throw on inner errors — wraps everything in try/catch', async () => {
    shared.userFindUnique.mockRejectedValueOnce(new Error('DB down'));
    await expect(notifyReferralInviterRewarded('inviter-5', 7)).resolves.toBeUndefined();
    expect(shared.loggerWarn).toHaveBeenCalled();
  });

  it('uses per-inviter locale (different inviters → different language text) — L1 regression', async () => {
    shared.userFindUnique
      .mockResolvedValueOnce({
        telegramChatId: 'c1',
        profile: { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'ru', language: null },
      })
      .mockResolvedValueOnce({
        telegramChatId: 'c2',
        profile: { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'en', language: null },
      });
    shared.sendTgBotMessage.mockResolvedValue(true);

    await notifyReferralInviterRewarded('i1', 7);
    await notifyReferralInviterRewarded('i2', 7);

    const ruMsg = shared.sendTgBotMessage.mock.calls[0]![1];
    const enMsg = shared.sendTgBotMessage.mock.calls[1]![1];
    // Two different locales must yield two different messages — guards against
    // accidental hardcoding of `'ru'` re-creeping in.
    expect(ruMsg).not.toBe(enMsg);
  });
});

describe('runReferralProgressHook — milestone marking', () => {
  beforeEach(() => {
    shared.tryQualifyAttribution.mockResolvedValue({ kind: 'not_qualified' });
  });

  it('first_wishlist milestone calls markFirstWishlist + tracks event with hasAttribution=false for organic user', async () => {
    await runReferralProgressHook('u1', 'first_wishlist');
    expect(shared.markFirstWishlist).toHaveBeenCalled();
    expect(shared.markFirstItem).not.toHaveBeenCalled();
    expect(shared.trackAnalyticsEvent).toHaveBeenCalledWith({
      event: 'referral.first_wishlist_created',
      userId: 'u1',
      props: { hasAttribution: false },
    });
  });

  it('first_item milestone calls markFirstItem + tracks event with hasAttribution=false for organic user', async () => {
    await runReferralProgressHook('u2', 'first_item');
    expect(shared.markFirstItem).toHaveBeenCalled();
    expect(shared.markFirstWishlist).not.toHaveBeenCalled();
    expect(shared.trackAnalyticsEvent).toHaveBeenCalledWith({
      event: 'referral.first_item_created',
      userId: 'u2',
      props: { hasAttribution: false },
    });
  });

  it('first_wishlist for invitee (referredByUserId set) emits hasAttribution=true', async () => {
    shared.userProfileFindUnique.mockResolvedValueOnce({ referredByUserId: 'inviter-7' });
    await runReferralProgressHook('invitee-1', 'first_wishlist');
    expect(shared.trackAnalyticsEvent).toHaveBeenCalledWith({
      event: 'referral.first_wishlist_created',
      userId: 'invitee-1',
      props: { hasAttribution: true },
    });
  });

  it('first_item for invitee (referredByUserId set) emits hasAttribution=true', async () => {
    shared.userProfileFindUnique.mockResolvedValueOnce({ referredByUserId: 'inviter-9' });
    await runReferralProgressHook('invitee-2', 'first_item');
    expect(shared.trackAnalyticsEvent).toHaveBeenCalledWith({
      event: 'referral.first_item_created',
      userId: 'invitee-2',
      props: { hasAttribution: true },
    });
  });

  it('treats missing UserProfile row as hasAttribution=false (no crash)', async () => {
    shared.userProfileFindUnique.mockResolvedValueOnce(null);
    await runReferralProgressHook('u-noprofile', 'first_wishlist');
    expect(shared.trackAnalyticsEvent).toHaveBeenCalledWith({
      event: 'referral.first_wishlist_created',
      userId: 'u-noprofile',
      props: { hasAttribution: false },
    });
  });

  it('exits early when not qualified — no reward processing', async () => {
    shared.tryQualifyAttribution.mockResolvedValueOnce({ kind: 'not_qualified' });
    await runReferralProgressHook('u3', 'first_wishlist');
    expect(shared.processReward).not.toHaveBeenCalled();
  });
});

describe('runReferralProgressHook — qualified outcomes', () => {
  beforeEach(() => {
    shared.tryQualifyAttribution.mockResolvedValue({
      kind: 'qualified',
      attributionId: 'attr-1',
      inviterUserId: 'inviter-1',
    });
  });

  it('rewarded → tracks rewarded + pro_subscription_extended + fires DM', async () => {
    shared.processReward.mockResolvedValueOnce({
      kind: 'rewarded',
      rewardId: 'rw-1',
      daysGranted: 30,
      newExpiryAt: new Date('2099-01-01'),
    });
    shared.userFindUnique.mockResolvedValueOnce({
      telegramChatId: 'c',
      profile: { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'ru', language: null },
    });
    shared.sendTgBotMessage.mockResolvedValueOnce(true);

    await runReferralProgressHook('u1', 'first_wishlist');

    const events = shared.trackAnalyticsEvent.mock.calls.map((c) => c[0].event);
    expect(events).toContain('referral.rewarded');
    expect(events).toContain('referral.pro_subscription_extended');
    // Allow the fire-and-forget DM to flush.
    await Promise.resolve();
    await Promise.resolve();
  });

  it('auto_rejected → tracks referral.rejected with FRAUD_REJECTED reason', async () => {
    shared.processReward.mockResolvedValueOnce({
      kind: 'auto_rejected',
      fraudScore: 95,
      signals: ['ip_overlap', 'rapid_signup'],
    });

    await runReferralProgressHook('u1', 'first_item');

    const rejected = shared.trackAnalyticsEvent.mock.calls.find((c) => c[0].event === 'referral.rejected');
    expect(rejected).toBeDefined();
    expect(rejected![0].props).toMatchObject({
      reason: 'FRAUD_REJECTED',
      fraudScore: 95,
      signalCount: 2,
    });
  });

  it('review_queued → tracks fraud_review_queued', async () => {
    shared.processReward.mockResolvedValueOnce({
      kind: 'review_queued',
      fraudScore: 60,
      signals: ['mild_signal'],
    });

    await runReferralProgressHook('u1', 'first_item');

    expect(shared.trackAnalyticsEvent.mock.calls.some((c) => c[0].event === 'referral.fraud_review_queued')).toBe(true);
  });

  it('cap_rejected → tracks rejected with REWARD_CAP_REACHED + cap_check_performed', async () => {
    shared.processReward.mockResolvedValueOnce({
      kind: 'cap_rejected',
      reason: 'MONTHLY_CAP',
      monthlyUsed: 5,
      yearlyUsed: 25,
    });

    await runReferralProgressHook('u1', 'first_item');

    const events = shared.trackAnalyticsEvent.mock.calls.map((c) => c[0].event);
    expect(events).toContain('referral.rejected');
    expect(events).toContain('referral.cap_check_performed');

    const rejected = shared.trackAnalyticsEvent.mock.calls.find((c) => c[0].event === 'referral.rejected');
    expect(rejected![0].props.reason).toBe('REWARD_CAP_REACHED');
  });

  it('already_granted → tracks idempotency_hit', async () => {
    shared.processReward.mockResolvedValueOnce({ kind: 'already_granted' });

    await runReferralProgressHook('u1', 'first_item');

    expect(shared.trackAnalyticsEvent.mock.calls.some((c) => c[0].event === 'referral.idempotency_hit')).toBe(true);
  });

  it('not_qualified after qualify → invariant_violation + defensive warn', async () => {
    shared.processReward.mockResolvedValueOnce({ kind: 'not_qualified' });

    await runReferralProgressHook('u1', 'first_item');

    expect(shared.loggerWarn).toHaveBeenCalled();
    expect(shared.trackAnalyticsEvent.mock.calls.some((c) => c[0].event === 'referral.attribution_invariant_violation')).toBe(true);
  });
});

describe('runReferralProgressHook — error containment', () => {
  it('does not throw if markFirstWishlist fails — tracks reward_grant_failed', async () => {
    shared.markFirstWishlist.mockRejectedValueOnce(new Error('DB locked'));

    await expect(runReferralProgressHook('u1', 'first_wishlist')).resolves.toBeUndefined();
    expect(shared.loggerError).toHaveBeenCalled();
    expect(shared.trackAnalyticsEvent.mock.calls.some((c) => c[0].event === 'referral.reward_grant_failed')).toBe(true);
  });

  it('does not throw if tryQualifyAttribution fails', async () => {
    shared.tryQualifyAttribution.mockRejectedValueOnce(new Error('oops'));
    await expect(runReferralProgressHook('u1', 'first_item')).resolves.toBeUndefined();
  });

  it('does not throw if processReward fails', async () => {
    shared.tryQualifyAttribution.mockResolvedValueOnce({
      kind: 'qualified', attributionId: 'a', inviterUserId: 'i',
    });
    shared.processReward.mockRejectedValueOnce(new Error('reward DB'));
    await expect(runReferralProgressHook('u1', 'first_item')).resolves.toBeUndefined();
  });
});
