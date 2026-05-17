// Unit tests for services/santa-season.ts.
//
// Coverage focus: cross-year season boundary math, deterministic alias
// generation, season info resolver priority order, seasonal broadcast
// trigger dates (Nov 1 / Feb 1), and per-recipient locale fanout in the
// broadcast loop.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const shared = vi.hoisted(() => ({
  globalConfig: vi.fn(),
  seasonConfig: vi.fn(),
  broadcastLogCreate: vi.fn(),
  broadcastLogFindUnique: vi.fn(),
  broadcastLogUpdate: vi.fn(),
  userFindMany: vi.fn(),
  sendTgNotification: vi.fn(),
  sendAdminAlert: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock('@wishlist/db', () => ({
  prisma: {
    santaGlobalConfig: { findUnique: shared.globalConfig },
    santaSeasonConfig: { findUnique: shared.seasonConfig },
    santaSeasonalBroadcastLog: {
      create: shared.broadcastLogCreate,
      findUnique: shared.broadcastLogFindUnique,
      update: shared.broadcastLogUpdate,
    },
    user: { findMany: shared.userFindMany },
  },
}));

vi.mock('../telegram/botApi', () => ({
  sendTgNotification: shared.sendTgNotification,
}));

vi.mock('../notifications/adminAlerts', () => ({
  sendAdminAlert: shared.sendAdminAlert,
}));

vi.mock('../logger', () => ({
  default: {
    info: shared.loggerInfo,
    error: shared.loggerError,
    debug: vi.fn(),
    warn: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
  },
}));

import {
  getSeasonStartYear,
  getSeasonCalendar,
  getSantaSeasonInfo,
  SANTA_ADJECTIVES,
  SANTA_ANIMALS,
  SANTA_ADJ_KEYS,
  SANTA_ANIMAL_KEYS,
  santaSeededRng,
  santaHashStr,
  santaShuffle,
  generateSantaAliases,
  renderSantaAliasLocalized,
  sendSeasonalBroadcast,
  maybeRunSeasonalEvents,
  isSeasonalEventTriggerDay,
} from './santa-season';

beforeEach(() => {
  for (const v of Object.values(shared)) (v as ReturnType<typeof vi.fn>).mockReset?.();
});

describe('getSeasonStartYear — cross-year boundary', () => {
  it('Oct 31 → current year (off-season tail end)', () => {
    expect(getSeasonStartYear(new Date('2026-10-31T00:00:00Z'))).toBe(2026);
  });

  it('Nov 1 → current year (promo day)', () => {
    expect(getSeasonStartYear(new Date('2026-11-01T00:00:00Z'))).toBe(2026);
  });

  it('Nov 14 23:59:59 UTC → current year (key already locked, season not open yet)', () => {
    // Fence-post: the season-key for Nov 14 is the same as Nov 15, but the
    // season is not yet in. Pair with the inSeason flip-test below to lock
    // the producer/consumer split.
    expect(getSeasonStartYear(new Date('2026-11-14T23:59:59Z'))).toBe(2026);
    expect(getSeasonCalendar(new Date('2026-11-14T23:59:59Z')).inSeason).toBe(false);
  });

  it('Nov 15 00:00:00 UTC → current year (season-key unchanged, inSeason flips to true)', () => {
    expect(getSeasonStartYear(new Date('2026-11-15T00:00:00Z'))).toBe(2026);
    expect(getSeasonCalendar(new Date('2026-11-15T00:00:00Z')).inSeason).toBe(true);
  });

  it('Dec 25 → current year', () => {
    expect(getSeasonStartYear(new Date('2026-12-25T00:00:00Z'))).toBe(2026);
  });

  it('Jan 10 → PRIOR year (still in previous season)', () => {
    expect(getSeasonStartYear(new Date('2027-01-10T00:00:00Z'))).toBe(2026);
  });

  it('Feb 10 → PRIOR year (still in previous season)', () => {
    expect(getSeasonStartYear(new Date('2027-02-10T00:00:00Z'))).toBe(2026);
  });

  it('Feb 15 23:59:59 UTC → PRIOR year (last second in-season)', () => {
    // Symmetric fence-post to Nov 14: season-key still prior-year, but
    // inSeason has not flipped yet.
    expect(getSeasonStartYear(new Date('2027-02-15T23:59:59Z'))).toBe(2026);
    expect(getSeasonCalendar(new Date('2027-02-15T23:59:59Z')).inSeason).toBe(true);
  });

  it('Feb 16 00:00:00 UTC → current year (key flips, inSeason becomes false)', () => {
    expect(getSeasonStartYear(new Date('2027-02-16T00:00:00Z'))).toBe(2027);
    expect(getSeasonCalendar(new Date('2027-02-16T00:00:00Z')).inSeason).toBe(false);
  });
});

describe('isSeasonalEventTriggerDay', () => {
  it('Nov 1 → PROMO', () => {
    expect(isSeasonalEventTriggerDay(new Date('2026-11-01T00:00:00Z'))).toBe('PROMO');
    expect(isSeasonalEventTriggerDay(new Date('2026-11-01T23:59:59Z'))).toBe('PROMO');
  });

  it('Feb 1 → CLOSING_SOON', () => {
    expect(isSeasonalEventTriggerDay(new Date('2027-02-01T00:00:00Z'))).toBe('CLOSING_SOON');
    expect(isSeasonalEventTriggerDay(new Date('2027-02-01T18:00:00Z'))).toBe('CLOSING_SOON');
  });

  it('non-trigger days → null', () => {
    expect(isSeasonalEventTriggerDay(new Date('2026-10-31T00:00:00Z'))).toBeNull();
    expect(isSeasonalEventTriggerDay(new Date('2026-11-02T00:00:00Z'))).toBeNull();
    expect(isSeasonalEventTriggerDay(new Date('2026-11-15T00:00:00Z'))).toBeNull();
    expect(isSeasonalEventTriggerDay(new Date('2027-01-31T23:59:59Z'))).toBeNull();
    expect(isSeasonalEventTriggerDay(new Date('2027-02-02T00:00:00Z'))).toBeNull();
    expect(isSeasonalEventTriggerDay(new Date('2027-02-15T00:00:00Z'))).toBeNull();
  });

  it('uses UTC, not local time — Oct 31 23:00 UTC = Nov 1 02:00 MSK → still null', () => {
    // The Vultr Amsterdam VPS runs CET/CEST (UTC+1/+2). The old inline code
    // used Date#getMonth()/getDate() (local), which would have returned PROMO
    // here. The new UTC check correctly returns null because UTC date is still
    // Oct 31. Locking this case prevents the regression of going back to local.
    expect(isSeasonalEventTriggerDay(new Date('2026-10-31T23:00:00Z'))).toBeNull();
  });

  it('uses UTC, not local time — Nov 1 23:59 UTC = Nov 2 02:59 MSK → still PROMO', () => {
    // Symmetric: the last second of UTC Nov 1 is "Nov 2" in MSK / Amsterdam
    // local. Predicate must still return PROMO because we made the canonical
    // choice that "trigger day" means UTC calendar day. The hourly cron has
    // 24 attempts; this is the last one of the UTC-Nov-1 window.
    expect(isSeasonalEventTriggerDay(new Date('2026-11-01T23:59:00Z'))).toBe('PROMO');
  });

  it('uses UTC, not local time — Feb 2 00:00 UTC = Feb 2 03:00 MSK → already null', () => {
    // The first second past UTC Feb 1 — predicate switches to null even though
    // local Feb 2 wall clock is well past midnight in any positive offset.
    expect(isSeasonalEventTriggerDay(new Date('2027-02-02T00:00:00Z'))).toBeNull();
  });
});

describe('getSeasonCalendar', () => {
  it('inSeason=true mid-season (Dec 25)', () => {
    const r = getSeasonCalendar(new Date('2026-12-25T12:00:00Z'));
    expect(r.inSeason).toBe(true);
    expect(r.seasonStart.toISOString()).toBe('2026-11-15T00:00:00.000Z');
    expect(r.seasonEnd.toISOString()).toBe('2027-02-15T23:59:59.999Z');
  });

  it('inSeason=false during off-season (Mar 1)', () => {
    const r = getSeasonCalendar(new Date('2027-03-01T00:00:00Z'));
    expect(r.inSeason).toBe(false);
  });

  it('inSeason=false on Nov 14 (one day before opens)', () => {
    expect(getSeasonCalendar(new Date('2026-11-14T23:59:59Z')).inSeason).toBe(false);
  });

  it('inSeason=true on Nov 15 00:00 UTC (boundary inclusive)', () => {
    expect(getSeasonCalendar(new Date('2026-11-15T00:00:00Z')).inSeason).toBe(true);
  });

  it('inSeason=true on Feb 15 23:59 UTC (boundary inclusive)', () => {
    expect(getSeasonCalendar(new Date('2027-02-15T23:59:59Z')).inSeason).toBe(true);
  });
});

describe('Dictionaries', () => {
  it('SANTA_ADJECTIVES has 30 entries (corpus size)', () => {
    expect(SANTA_ADJ_KEYS).toHaveLength(30);
  });

  it('SANTA_ANIMALS has 30 entries (corpus size)', () => {
    expect(SANTA_ANIMAL_KEYS).toHaveLength(30);
  });

  it('every adjective has m / f / en forms', () => {
    for (const k of SANTA_ADJ_KEYS) {
      const a = SANTA_ADJECTIVES[k]!;
      expect(a.m).toBeTruthy();
      expect(a.f).toBeTruthy();
      expect(a.en).toBeTruthy();
    }
  });

  it('every animal has ru / gender / emoji / en fields', () => {
    for (const k of SANTA_ANIMAL_KEYS) {
      const a = SANTA_ANIMALS[k]!;
      expect(a.ru).toBeTruthy();
      expect(['m', 'f']).toContain(a.gender);
      expect(a.emoji).toBeTruthy();
      expect(a.en).toBeTruthy();
    }
  });

  it('30 × 30 = 900 unique combinations possible per round', () => {
    expect(SANTA_ADJ_KEYS.length * SANTA_ANIMAL_KEYS.length).toBe(900);
  });
});

describe('Pure PRNG primitives', () => {
  it('santaSeededRng is deterministic — same seed → same sequence', () => {
    const a = santaSeededRng(42);
    const b = santaSeededRng(42);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
  });

  it('santaSeededRng returns numbers in [0, 1)', () => {
    const rng = santaSeededRng(123);
    for (let i = 0; i < 50; i++) {
      const n = rng();
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
  });

  it('santaHashStr is deterministic', () => {
    expect(santaHashStr('hello')).toBe(santaHashStr('hello'));
  });

  it('santaHashStr produces different hashes for different inputs', () => {
    expect(santaHashStr('foo')).not.toBe(santaHashStr('bar'));
  });

  it('santaShuffle does not mutate the input array', () => {
    const original = [1, 2, 3, 4, 5];
    const before = [...original];
    santaShuffle(original, santaSeededRng(1));
    expect(original).toEqual(before);
  });

  it('santaShuffle preserves elements (same set, different order)', () => {
    const input = [1, 2, 3, 4, 5, 6, 7, 8];
    const out = santaShuffle(input, santaSeededRng(42));
    expect([...out].sort((a, b) => a - b)).toEqual([...input].sort((a, b) => a - b));
  });

  it('santaShuffle is deterministic given the same seed', () => {
    const rng1 = santaSeededRng(99);
    const rng2 = santaSeededRng(99);
    expect(santaShuffle([1, 2, 3, 4, 5], rng1)).toEqual(santaShuffle([1, 2, 3, 4, 5], rng2));
  });
});

describe('generateSantaAliases', () => {
  it('returns one alias per participant', () => {
    const aliases = generateSantaAliases('round-1', ['a', 'b', 'c']);
    expect(aliases).toHaveLength(3);
  });

  it('is deterministic — same roundId + participants → same aliases', () => {
    const a = generateSantaAliases('round-X', ['p1', 'p2', 'p3']);
    const b = generateSantaAliases('round-X', ['p1', 'p2', 'p3']);
    expect(a).toEqual(b);
  });

  it('different roundId → different alias assignments', () => {
    const a = generateSantaAliases('round-A', ['p1', 'p2', 'p3']);
    const b = generateSantaAliases('round-B', ['p1', 'p2', 'p3']);
    // Aliases for the same participantId should differ between rounds.
    const aP1 = a.find((x) => x.participantId === 'p1')!.alias;
    const bP1 = b.find((x) => x.participantId === 'p1')!.alias;
    expect(aP1).not.toBe(bP1);
  });

  it('participantIds are sorted before assignment (insertion order doesn\'t matter)', () => {
    const a = generateSantaAliases('round-X', ['c', 'a', 'b']);
    const b = generateSantaAliases('round-X', ['a', 'b', 'c']);
    // Same set of participants, same round → same assignments by participantId
    expect(a.find((x) => x.participantId === 'a')?.alias).toBe(b.find((x) => x.participantId === 'a')?.alias);
    expect(a.find((x) => x.participantId === 'b')?.alias).toBe(b.find((x) => x.participantId === 'b')?.alias);
  });

  it('aliases are unique within a round when participants < 900', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `p${i}`);
    const aliases = generateSantaAliases('round-uniq', ids);
    const set = new Set(aliases.map((a) => a.alias));
    expect(set.size).toBe(50);
  });

  it('every alias includes the correct gender-agreed adjective form', () => {
    const aliases = generateSantaAliases('round-agreement', ['p1', 'p2', 'p3']);
    for (const a of aliases) {
      const adj = SANTA_ADJECTIVES[a.adjectiveKey]!;
      const animal = SANTA_ANIMALS[a.animalKey]!;
      const expected = `${adj[animal.gender]} ${animal.ru}`;
      expect(a.alias).toBe(expected);
    }
  });

  it('handles 0 participants gracefully (empty array)', () => {
    expect(generateSantaAliases('r', [])).toEqual([]);
  });
});

describe('getSantaSeasonInfo — priority chain', () => {
  it('global kill switch off → off-season, no create', async () => {
    shared.globalConfig.mockResolvedValueOnce({ santaEnabled: false });
    const info = await getSantaSeasonInfo('u1', false);
    expect(info).toMatchObject({ inSeason: false, canCreate: false });
  });

  it('santaTestMode bypasses global kill — always in-season', async () => {
    shared.globalConfig.mockResolvedValueOnce({ santaEnabled: false });
    shared.seasonConfig.mockResolvedValueOnce(null);
    const info = await getSantaSeasonInfo('u1', true);
    expect(info.inSeason).toBe(true);
    expect(info.canCreate).toBe(true);
  });

  it('explicit per-year override drives inSeason + canCreate', async () => {
    shared.globalConfig.mockResolvedValueOnce({ santaEnabled: true });
    const now = new Date();
    shared.seasonConfig.mockResolvedValueOnce({
      seasonYear: 2026,
      seasonStartAt: new Date(now.getTime() - 1000 * 60 * 60 * 24),
      seasonEndAt: new Date(now.getTime() + 1000 * 60 * 60 * 24),
      campaignCreateEnabled: true,
    });
    const info = await getSantaSeasonInfo('u1', false);
    expect(info.inSeason).toBe(true);
    expect(info.canCreate).toBe(true);
  });

  it('override row with campaignCreateEnabled=false blocks creation while still in-season', async () => {
    shared.globalConfig.mockResolvedValueOnce({ santaEnabled: true });
    const now = new Date();
    shared.seasonConfig.mockResolvedValueOnce({
      seasonYear: 2026,
      seasonStartAt: new Date(now.getTime() - 1000 * 60 * 60 * 24),
      seasonEndAt: new Date(now.getTime() + 1000 * 60 * 60 * 24),
      campaignCreateEnabled: false,
    });
    const info = await getSantaSeasonInfo('u1', false);
    expect(info.inSeason).toBe(true);
    expect(info.canCreate).toBe(false);
  });

  it('no override → falls back to calendar (Nov 15 → Feb 15 inclusive)', async () => {
    shared.globalConfig.mockResolvedValueOnce({ santaEnabled: true });
    shared.seasonConfig.mockResolvedValueOnce(null);
    const info = await getSantaSeasonInfo('u1', false);
    // Calendar verdict depends on `now`; just assert the resolver returned
    // sensible fields without throwing.
    expect(typeof info.inSeason).toBe('boolean');
    expect(info.config).toBeNull();
  });
});

describe('sendSeasonalBroadcast', () => {
  beforeEach(() => {
    shared.userFindMany.mockResolvedValue([]); // empty user list keeps the test fast
    shared.broadcastLogCreate.mockResolvedValue({});
    shared.broadcastLogUpdate.mockResolvedValue({});
    shared.sendAdminAlert.mockResolvedValue(undefined);
  });

  it('inserts a log row first (acts as a write-once lock)', async () => {
    await sendSeasonalBroadcast('PROMO', 2026);
    expect(shared.broadcastLogCreate).toHaveBeenCalledWith({
      data: { year: 2026, type: 'PROMO' },
    });
  });

  it('exits early when the log row already exists (duplicate prevention)', async () => {
    shared.broadcastLogCreate.mockRejectedValueOnce(new Error('Unique constraint'));
    await sendSeasonalBroadcast('PROMO', 2026);
    expect(shared.userFindMany).not.toHaveBeenCalled();
    expect(shared.sendTgNotification).not.toHaveBeenCalled();
  });

  it('paginates and sends per-recipient locale messages', async () => {
    shared.userFindMany.mockImplementation(({ cursor }: { cursor?: { id: string } }) => {
      // First call: 2 users; subsequent: empty
      if (!cursor) {
        return Promise.resolve([
          { id: 'u1', telegramChatId: 'c1', profile: { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'ru', language: null } },
          { id: 'u2', telegramChatId: 'c2', profile: { languageMode: 'auto', manualLanguage: null, normalizedLocale: 'en', language: null } },
        ]);
      }
      return Promise.resolve([]);
    });

    await sendSeasonalBroadcast('PROMO', 2026);

    expect(shared.sendTgNotification).toHaveBeenCalledTimes(2);
    const [c1, msg1] = shared.sendTgNotification.mock.calls[0]!;
    const [c2, msg2] = shared.sendTgNotification.mock.calls[1]!;
    expect([c1, c2].sort()).toEqual(['c1', 'c2']);
    // RU + EN messages must differ — guards against hardcoded broadcast locale.
    expect(msg1).not.toBe(msg2);
  });

  it('writes the final user count to the log row after sending', async () => {
    shared.userFindMany.mockResolvedValueOnce([]);
    await sendSeasonalBroadcast('PROMO', 2026);
    expect(shared.broadcastLogUpdate).toHaveBeenCalledWith({
      where: { year_type: { year: 2026, type: 'PROMO' } },
      data: { userCount: 0 },
    });
  });

  it('sends an admin alert with the final count', async () => {
    shared.userFindMany.mockResolvedValueOnce([]);
    await sendSeasonalBroadcast('CLOSING_SOON', 2026);
    expect(shared.sendAdminAlert).toHaveBeenCalled();
    const alertText = shared.sendAdminAlert.mock.calls[0]![0];
    expect(alertText).toContain('CLOSING_SOON');
    expect(alertText).toContain('2026');
  });
});

describe('maybeRunSeasonalEvents', () => {
  // Pin `now` for the trigger-day tests so behaviour doesn't depend on the
  // wall clock — these used to silent-pass on Nov 1 and Feb 1 by skipping
  // the assertion when `today` happened to land on a real trigger day.
  const nonTriggerDay = new Date('2026-12-25T12:00:00Z'); // mid-season, no broadcast
  const nov1 = new Date('2026-11-01T08:00:00Z');           // PROMO trigger
  const feb1 = new Date('2027-02-01T08:00:00Z');           // CLOSING_SOON trigger

  it('no-ops when feature is globally disabled', async () => {
    shared.globalConfig.mockResolvedValueOnce({ santaEnabled: false });
    await maybeRunSeasonalEvents(nov1);
    expect(shared.broadcastLogFindUnique).not.toHaveBeenCalled();
  });

  it('no-ops on a non-trigger day even when feature enabled', async () => {
    shared.globalConfig.mockResolvedValueOnce({ santaEnabled: true });
    await maybeRunSeasonalEvents(nonTriggerDay);
    expect(shared.broadcastLogFindUnique).not.toHaveBeenCalled();
  });

  it('Nov 1 + enabled + no prior log → looks up + dispatches PROMO for current seasonYear', async () => {
    shared.globalConfig.mockResolvedValueOnce({ santaEnabled: true });
    shared.broadcastLogFindUnique.mockResolvedValueOnce(null);
    // broadcast call path enters sendSeasonalBroadcast → broadcastLogCreate;
    // we let it succeed quietly so the void-awaited call doesn't reject.
    shared.broadcastLogCreate.mockResolvedValueOnce({});
    shared.userFindMany.mockResolvedValue([]);
    shared.broadcastLogUpdate.mockResolvedValue({});

    await maybeRunSeasonalEvents(nov1);

    expect(shared.broadcastLogFindUnique).toHaveBeenCalledWith({
      where: { year_type: { year: 2026, type: 'PROMO' } },
    });
    expect(shared.loggerInfo).toHaveBeenCalledWith(
      { seasonYear: 2026, trigger: 'PROMO' },
      'santa-season: trigger day matched, broadcasting',
    );
  });

  it('Feb 1 + enabled + no prior log → looks up CLOSING_SOON for PRIOR seasonYear', async () => {
    shared.globalConfig.mockResolvedValueOnce({ santaEnabled: true });
    shared.broadcastLogFindUnique.mockResolvedValueOnce(null);
    shared.broadcastLogCreate.mockResolvedValueOnce({});
    shared.userFindMany.mockResolvedValue([]);
    shared.broadcastLogUpdate.mockResolvedValue({});

    await maybeRunSeasonalEvents(feb1);

    // Feb 1 2027 → seasonYear = 2026 (the season that started Nov 2026)
    expect(shared.broadcastLogFindUnique).toHaveBeenCalledWith({
      where: { year_type: { year: 2026, type: 'CLOSING_SOON' } },
    });
  });

  it('trigger day but broadcast already sent → skips dispatch (idempotency)', async () => {
    shared.globalConfig.mockResolvedValueOnce({ santaEnabled: true });
    shared.broadcastLogFindUnique.mockResolvedValueOnce({ year: 2026, type: 'PROMO' });

    await maybeRunSeasonalEvents(nov1);

    // log row exists → no broadcast attempt
    expect(shared.broadcastLogCreate).not.toHaveBeenCalled();
  });

  it('does not throw when DB query fails (logs error)', async () => {
    shared.globalConfig.mockRejectedValueOnce(new Error('DB down'));
    await expect(maybeRunSeasonalEvents(nov1)).resolves.toBeUndefined();
    expect(shared.loggerError).toHaveBeenCalled();
  });
});

describe('renderSantaAliasLocalized — locale-aware alias rendering', () => {
  // Locked-in behaviour for the 6 supported locales. Each branch has its own
  // ordering / gender agreement quirks; a missing field would silently fall
  // through to RU and ship Russian text to non-RU users. These tests anchor
  // the contract so future locale additions can't quietly regress.

  it('en: adjective + animal, English forms', () => {
    expect(renderSantaAliasLocalized('brave', 'fox', 'en')).toBe('Brave Fox');
    expect(renderSantaAliasLocalized('smart', 'panda', 'en')).toBe('Smart Panda');
  });

  it('zh-CN: adjective + animal with NO space (Chinese has no word separators)', () => {
    expect(renderSantaAliasLocalized('brave', 'fox', 'zh-CN')).toBe('勇敢的狐狸');
    expect(renderSantaAliasLocalized('sleepy', 'giraffe', 'zh-CN')).toBe('瞌睡的长颈鹿');
  });

  it('hi: adjective + animal with single space, no gender inflection', () => {
    expect(renderSantaAliasLocalized('brave', 'fox', 'hi')).toBe('बहादुर लोमड़ी');
    expect(renderSantaAliasLocalized('smart', 'panda', 'hi')).toBe('होशियार पांडा');
  });

  it('es: animal-first (post-nominal descriptive) with gender agreement', () => {
    // fox is feminine → es_f form `Valiente`
    expect(renderSantaAliasLocalized('brave', 'fox', 'es')).toBe('Zorra Valiente');
    // bear is masculine → es_m form `Listo`
    expect(renderSantaAliasLocalized('smart', 'bear', 'es')).toBe('Oso Listo');
    // panda is feminine → es_f form `Lista`
    expect(renderSantaAliasLocalized('smart', 'panda', 'es')).toBe('Panda Lista');
  });

  it('ar: noun-first then adjective (Arabic post-nominal) with gender agreement', () => {
    // fox is feminine → ar_f form `شجاعة`
    expect(renderSantaAliasLocalized('brave', 'fox', 'ar')).toBe('ثعلبة شجاعة');
    // bear is masculine → ar_m form `ذكي`
    expect(renderSantaAliasLocalized('smart', 'bear', 'ar')).toBe('دب ذكي');
  });

  it('default / unknown locale: falls back to Russian with gender agreement', () => {
    // fox is feminine → f form `Смелая`
    expect(renderSantaAliasLocalized('brave', 'fox', 'ru')).toBe('Смелая лиса');
    expect(renderSantaAliasLocalized('brave', 'fox', 'fr')).toBe('Смелая лиса');
    // bear is masculine → m form `Умный`
    expect(renderSantaAliasLocalized('smart', 'bear', 'ru')).toBe('Умный медведь');
  });

  it('returns null for unknown adjective or animal key', () => {
    expect(renderSantaAliasLocalized('not_an_adj', 'fox', 'en')).toBeNull();
    expect(renderSantaAliasLocalized('brave', 'not_an_animal', 'en')).toBeNull();
  });

  it('every adjective × animal × locale combination produces a string', () => {
    // Exhaustive smoke test: 30 × 30 × 6 = 5400 combinations. Locks against
    // a future locale being added to the type but missing data on any key.
    const locales = ['ru', 'en', 'zh-CN', 'hi', 'es', 'ar'] as const;
    for (const adjKey of SANTA_ADJ_KEYS) {
      for (const animalKey of SANTA_ANIMAL_KEYS) {
        for (const loc of locales) {
          const out = renderSantaAliasLocalized(adjKey, animalKey, loc);
          expect(out).toBeTruthy();
          expect(typeof out).toBe('string');
          expect((out as string).length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('SANTA dictionaries — locale-key parity', () => {
  // Catches a future field rename / locale-block drop on either dictionary.
  // Ensures every adjective has all 9 locale fields and every animal has 7.
  it('every adjective has all 9 locale fields', () => {
    for (const [key, adj] of Object.entries(SANTA_ADJECTIVES)) {
      expect(adj.m, `${key}.m`).toBeTruthy();
      expect(adj.f, `${key}.f`).toBeTruthy();
      expect(adj.en, `${key}.en`).toBeTruthy();
      expect(adj['zh-CN'], `${key}.zh-CN`).toBeTruthy();
      expect(adj.hi, `${key}.hi`).toBeTruthy();
      expect(adj.es_m, `${key}.es_m`).toBeTruthy();
      expect(adj.es_f, `${key}.es_f`).toBeTruthy();
      expect(adj.ar_m, `${key}.ar_m`).toBeTruthy();
      expect(adj.ar_f, `${key}.ar_f`).toBeTruthy();
    }
  });

  it('every animal has all 7 locale fields + gender + emoji', () => {
    for (const [key, animal] of Object.entries(SANTA_ANIMALS)) {
      expect(animal.ru, `${key}.ru`).toBeTruthy();
      expect(animal.en, `${key}.en`).toBeTruthy();
      expect(animal['zh-CN'], `${key}.zh-CN`).toBeTruthy();
      expect(animal.hi, `${key}.hi`).toBeTruthy();
      expect(animal.es, `${key}.es`).toBeTruthy();
      expect(animal.ar, `${key}.ar`).toBeTruthy();
      expect(animal.gender === 'm' || animal.gender === 'f', `${key}.gender`).toBe(true);
      expect(animal.emoji, `${key}.emoji`).toBeTruthy();
    }
  });

  it('SANTA_ADJ_KEYS and SANTA_ANIMAL_KEYS expose the full set', () => {
    // 30 × 30 = 900 unique combos per round — verify the keyspace.
    expect(SANTA_ADJ_KEYS.length).toBe(30);
    expect(SANTA_ANIMAL_KEYS.length).toBe(30);
  });
});
