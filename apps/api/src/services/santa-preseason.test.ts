// Unit tests for services/santa-preseason.ts (E23).
//
// Coverage = the five task self-checks + the phased-wave mechanics:
//   1. Marketing opt-out respected (null-safe — null-profile users INCLUDED).
//   2. One user never gets a duplicate (dedup in the audience filter + P2002 skip).
//   3. Control group gets NO DM (and no dm_sent event).
//   4. >15% mute = stop-rule (trips above sample+threshold; does NOT trip below).
//   5. Dry-run recipients list (counts + per-segment breakdown, no sends).
// Plus: daily-cap halt, empty-audience completion, delivered → dm_sent,
// transient failure → touch deleted (retry), permanent failure → stopReason.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const h = vi.hoisted(() => {
  class MockKnownRequestError extends Error {
    code: string;
    constructor(code: string) {
      super('mock prisma known error');
      this.code = code;
    }
  }
  return {
    MockKnownRequestError,
    broadcastUpsert: vi.fn(),
    broadcastUpdate: vi.fn(),
    touchCount: vi.fn(),
    touchCreate: vi.fn(),
    touchUpdate: vi.fn(),
    touchDelete: vi.fn(),
    userFindMany: vi.fn(),
    getExperimentAssignment: vi.fn(),
    trackProductEvent: vi.fn(),
    sendAdminAlert: vi.fn(),
    fetch: vi.fn(),
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    loggerError: vi.fn(),
  };
});

vi.mock('@wishlist/db', () => ({
  prisma: {
    santaPreseasonBroadcast: { upsert: h.broadcastUpsert, update: h.broadcastUpdate },
    santaPreseasonTouch: {
      count: h.touchCount,
      create: h.touchCreate,
      update: h.touchUpdate,
      delete: h.touchDelete,
    },
    user: { findMany: h.userFindMany },
  },
  Prisma: { PrismaClientKnownRequestError: h.MockKnownRequestError },
}));

vi.mock('./experiments.service', () => ({ getExperimentAssignment: h.getExperimentAssignment }));
vi.mock('./analytics', () => ({ trackProductEvent: h.trackProductEvent }));
vi.mock('./locale', () => ({ profileToLanguageSettings: () => ({}) }));
vi.mock('../notifications/adminAlerts', () => ({ sendAdminAlert: h.sendAdminAlert }));
vi.mock('../logger', () => ({
  default: { info: h.loggerInfo, warn: h.loggerWarn, error: h.loggerError, debug: vi.fn() },
}));

import {
  isPreseasonWindow,
  primarySegment,
  computePreseasonAudience,
  runPreseasonWave,
  PRESEASON_EXPERIMENT_KEY,
} from './santa-preseason';

const NOW = new Date('2026-11-01T08:00:00Z'); // in window, season 2026
const SEASON = 2026;
const CONFIG = { enabled: true, rolloutPercent: 85 };

// Settled-cohort / cap counts, keyed off the distinctive `where` shape so the
// test is independent of call order.
const counts = { settledSent: 0, settledMuted: 0, priorDaySends: 0, sentToday: 0 };

function zeroCounts() {
  counts.settledSent = 0;
  counts.settledMuted = 0;
  counts.priorDaySends = 0;
  counts.sentToday = 0;
}

function emptySegmentCounts() {
  return {
    santaParticipations: 0,
    ownedSantaCampaigns: 0,
    wishlistSubscriptions: 0,
    profileSubscriptions: 0,
    groupGiftParticipations: 0,
    groupGiftsOrganized: 0,
  };
}

function candidate(id: string, seg: Partial<ReturnType<typeof emptySegmentCounts>> = {}) {
  return {
    id,
    telegramChatId: `chat-${id}`,
    profile: { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'en', language: null },
    _count: { ...emptySegmentCounts(), ...seg },
  };
}

beforeEach(() => {
  for (const v of Object.values(h)) (v as { mockReset?: () => void }).mockReset?.();
  zeroCounts();
  process.env.BOT_TOKEN = 'test-token';
  vi.stubGlobal('fetch', h.fetch);

  // Default happy-path wiring.
  h.broadcastUpsert.mockResolvedValue({ seasonYear: SEASON, status: 'running' });
  h.broadcastUpdate.mockResolvedValue({});
  h.touchCount.mockImplementation(async (args: { where: Record<string, any> }) => {
    const w = args.where;
    if (w.mutedAt) return counts.settledMuted;
    if (w.delivered === true) return counts.settledSent;
    if (w.sentAt?.gte) return counts.sentToday;
    if (w.sentAt?.not === null) return counts.priorDaySends;
    return 0;
  });
  h.touchCreate.mockResolvedValue({ id: 'touch-1' });
  h.touchUpdate.mockResolvedValue({});
  h.touchDelete.mockResolvedValue({});
  h.userFindMany.mockResolvedValue([]);
  h.fetch.mockResolvedValue({ json: async () => ({ ok: true }) });
  h.getExperimentAssignment.mockResolvedValue({ key: PRESEASON_EXPERIMENT_KEY, variant: 'treatment', holdout: false, active: true });
});

describe('isPreseasonWindow (Nov 1–14 UTC)', () => {
  it('true inside the window, false outside', () => {
    expect(isPreseasonWindow(new Date('2026-11-01T00:00:00Z'))).toBe(true);
    expect(isPreseasonWindow(new Date('2026-11-14T23:59:59Z'))).toBe(true);
    expect(isPreseasonWindow(new Date('2026-11-15T00:00:00Z'))).toBe(false); // season opens
    expect(isPreseasonWindow(new Date('2026-10-31T23:00:00Z'))).toBe(false);
    expect(isPreseasonWindow(new Date('2026-12-01T00:00:00Z'))).toBe(false);
  });
});

describe('primarySegment (precedence past_santa > social > active_owner)', () => {
  it('past_santa wins on any santa count', () => {
    expect(primarySegment({ ...emptySegmentCounts(), santaParticipations: 1, wishlistSubscriptions: 9 })).toBe('past_santa');
    expect(primarySegment({ ...emptySegmentCounts(), ownedSantaCampaigns: 1 })).toBe('past_santa');
  });
  it('social when only subscriptions / group-gift', () => {
    expect(primarySegment({ ...emptySegmentCounts(), profileSubscriptions: 1 })).toBe('social');
    expect(primarySegment({ ...emptySegmentCounts(), groupGiftsOrganized: 2 })).toBe('social');
  });
  it('active_owner by elimination', () => {
    expect(primarySegment(emptySegmentCounts())).toBe('active_owner');
  });
});

describe('self-check #1 + #2 — audience filter (opt-out null-safe, dedup)', () => {
  it('excludes opt-outs null-safely and dedups already-touched users', async () => {
    h.userFindMany.mockResolvedValue([]);
    await computePreseasonAudience({ seasonYear: SEASON, now: NOW });

    const where = h.userFindMany.mock.calls[0]![0].where;
    // NULL-SAFE opt-out: NOT(notifyMarketing=false), never is(true) — so a user
    // with no UserProfile row is still INCLUDED.
    expect(where.NOT).toEqual({ profile: { is: { notifyMarketing: false } } });
    expect(where).not.toHaveProperty('profile.is.notifyMarketing', true);
    // Dedup: nobody already touched this season.
    expect(where.santaPreseasonTouches).toEqual({ none: { seasonYear: SEASON } });
    // Telegram-reachable only.
    expect(where.telegramChatId).toEqual({ not: null });
    // Three segments OR'd.
    expect(Array.isArray(where.OR)).toBe(true);
    expect(where.OR.length).toBe(7); // 2 past-santa + 1 active-owner + 4 social
  });
});

describe('self-check #5 — dry-run recipients list', () => {
  it('tallies totals + per-primary-segment, returns a sample, sends nothing', async () => {
    h.userFindMany.mockResolvedValue([
      { id: 'a', _count: { ...emptySegmentCounts(), santaParticipations: 2 } },        // past_santa
      { id: 'b', _count: { ...emptySegmentCounts(), profileSubscriptions: 1 } },        // social
      { id: 'c', _count: emptySegmentCounts() },                                        // active_owner
      { id: 'd', _count: { ...emptySegmentCounts(), ownedSantaCampaigns: 1 } },         // past_santa
    ]);

    const res = await computePreseasonAudience({ seasonYear: SEASON, now: NOW, sampleSize: 2 });

    expect(res.total).toBe(4);
    expect(res.bySegment).toEqual({ past_santa: 2, social: 1, active_owner: 1 });
    expect(res.sample).toHaveLength(2);
    // Dry-run must never send or write.
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.touchCreate).not.toHaveBeenCalled();
  });
});

describe('runPreseasonWave — latch', () => {
  it('returns immediately when the broadcast is already stopped', async () => {
    h.broadcastUpsert.mockResolvedValue({ seasonYear: SEASON, status: 'stopped' });
    await runPreseasonWave({ now: NOW, seasonYear: SEASON, config: CONFIG });
    expect(h.touchCount).not.toHaveBeenCalled();
    expect(h.userFindMany).not.toHaveBeenCalled();
  });

  it('marks completed when the audience is drained', async () => {
    h.userFindMany.mockResolvedValue([]);
    await runPreseasonWave({ now: NOW, seasonYear: SEASON, config: CONFIG });
    expect(h.broadcastUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { seasonYear: SEASON }, data: expect.objectContaining({ status: 'completed' }) }),
    );
  });
});

describe('self-check #4 — >15% mute stop-rule', () => {
  it('STOPS when settled cohort ≥ sample and mute rate > 15%', async () => {
    counts.settledSent = 250;
    counts.settledMuted = 50; // 20%
    await runPreseasonWave({ now: NOW, seasonYear: SEASON, config: CONFIG });

    expect(h.broadcastUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'stopped' }) }),
    );
    expect(h.sendAdminAlert).toHaveBeenCalled();
    // Hard stop — never fetches the next slice.
    expect(h.userFindMany).not.toHaveBeenCalled();
  });

  it('does NOT stop when mute rate is below 15%', async () => {
    counts.settledSent = 250;
    counts.settledMuted = 30; // 12%
    await runPreseasonWave({ now: NOW, seasonYear: SEASON, config: CONFIG });
    expect(h.broadcastUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'stopped' }) }),
    );
    expect(h.userFindMany).toHaveBeenCalled(); // proceeds to send
  });

  it('does NOT stop below the minimum sample, even at a high mute rate', async () => {
    counts.settledSent = 100; // < MIN_SAMPLE (200)
    counts.settledMuted = 90; // 90% — but sample too small to trust
    await runPreseasonWave({ now: NOW, seasonYear: SEASON, config: CONFIG });
    expect(h.broadcastUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'stopped' }) }),
    );
    expect(h.userFindMany).toHaveBeenCalled();
  });
});

describe('runPreseasonWave — daily cap', () => {
  it('halts the tick (no fetch) once the daily cap is reached', async () => {
    counts.priorDaySends = 10; // not the first day → DAILY_CAP (2000)
    counts.sentToday = 2000; // cap reached → budget 0
    await runPreseasonWave({ now: NOW, seasonYear: SEASON, config: CONFIG });
    expect(h.userFindMany).not.toHaveBeenCalled();
  });
});

describe('self-check #3 — control group gets no DM', () => {
  it('records a control touch but never sends or emits dm_sent', async () => {
    h.getExperimentAssignment.mockResolvedValue({ key: PRESEASON_EXPERIMENT_KEY, variant: 'control', holdout: false, active: true });
    h.userFindMany.mockResolvedValue([candidate('u1', { santaParticipations: 1 })]);

    await runPreseasonWave({ now: NOW, seasonYear: SEASON, config: CONFIG });

    expect(h.touchCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ variant: 'control', stopReason: 'control' }) }),
    );
    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.trackProductEvent).not.toHaveBeenCalled();
    expect(h.touchUpdate).not.toHaveBeenCalled();
  });
});

describe('runPreseasonWave — treatment send outcomes', () => {
  it('delivered → stamps sentAt/delivered and emits santa_preseason.dm_sent', async () => {
    h.userFindMany.mockResolvedValue([candidate('u1', { ownedSantaCampaigns: 1 })]);
    h.fetch.mockResolvedValue({ json: async () => ({ ok: true }) });

    await runPreseasonWave({ now: NOW, seasonYear: SEASON, config: CONFIG });

    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(h.touchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'touch-1' }, data: expect.objectContaining({ delivered: true, stopReason: null }) }),
    );
    expect(h.trackProductEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'santa_preseason.dm_sent', userId: 'u1', props: expect.objectContaining({ seasonYear: SEASON, segment: 'past_santa' }) }),
    );
    expect(h.touchDelete).not.toHaveBeenCalled();
  });

  it('transient failure (429) → deletes the touch so the user retries next tick', async () => {
    h.userFindMany.mockResolvedValue([candidate('u1')]);
    h.fetch.mockResolvedValue({ json: async () => ({ ok: false, error_code: 429, description: 'Too Many Requests' }) });

    await runPreseasonWave({ now: NOW, seasonYear: SEASON, config: CONFIG });

    expect(h.touchDelete).toHaveBeenCalledWith({ where: { id: 'touch-1' } });
    expect(h.trackProductEvent).not.toHaveBeenCalled();
    expect(h.touchUpdate).not.toHaveBeenCalled();
  });

  it('permanent failure (403 bot blocked) → keeps the touch with stopReason, no retry, no event', async () => {
    h.userFindMany.mockResolvedValue([candidate('u1')]);
    h.fetch.mockResolvedValue({ json: async () => ({ ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }) });

    await runPreseasonWave({ now: NOW, seasonYear: SEASON, config: CONFIG });

    expect(h.touchUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ delivered: false, stopReason: 'bot_blocked' }) }),
    );
    expect(h.touchDelete).not.toHaveBeenCalled();
    expect(h.trackProductEvent).not.toHaveBeenCalled();
  });

  it('P2002 on touch create (raced by another tick) → skips without sending or crashing', async () => {
    h.userFindMany.mockResolvedValue([candidate('u1')]);
    h.touchCreate.mockRejectedValueOnce(new h.MockKnownRequestError('P2002'));

    await runPreseasonWave({ now: NOW, seasonYear: SEASON, config: CONFIG });

    expect(h.fetch).not.toHaveBeenCalled();
    expect(h.loggerError).not.toHaveBeenCalled(); // handled, not a crash
  });
});
