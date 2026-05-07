// Secret Santa season + alias system (P5s-4 — extracted from
// apps/api/src/index.ts). 13 identifiers covering:
//
//   1. Season window math (pure):
//      - getSeasonStartYear(now) — canonical Nov-year key
//      - getSeasonCalendar(now)  — Nov 15 → Feb 15 UTC window
//
//   2. Season status resolver (DB-aware):
//      - getSantaSeasonInfo(userId, santaTestMode) — combines global
//        kill-switch + per-year admin override + calendar default.
//
//   3. Anonymous alias system (pure):
//      - SANTA_ADJECTIVES, SANTA_ANIMALS — locale dictionaries.
//      - SANTA_ADJ_KEYS, SANTA_ANIMAL_KEYS — derived key arrays.
//      - santaSeededRng (mulberry32) + santaHashStr (FNV-1a) +
//        santaShuffle (Fisher-Yates) — deterministic primitives.
//      - generateSantaAliases(roundId, ids) — composes all above.
//
//   4. Seasonal broadcast pipeline (DB + Telegram fan-out):
//      - sendSeasonalBroadcast(type, year) — paginated DM with
//        SantaSeasonalBroadcastLog dedup lock.
//      - maybeRunSeasonalEvents() — hourly cron entrypoint, calendar
//        gates (Nov 1 PROMO, Feb 1 CLOSING_SOON).
//
// Bodies are byte-identical to their previous in-place definitions in
// apps/api/src/index.ts (lines 1350–1438, 1451–1587, 1934–2043).
//
// Strategy A: source moves here; routes/santa.routes.ts continues
// receiving 5 helpers via deps factory; schedulers/santa.ts continues
// receiving maybeRunSeasonalEvents + generateSantaAliases via deps.
// Signatures unchanged — index.ts imports and threads through existing
// factory call-sites.
//
// Module-state: zero. No timers (those live in schedulers/santa.ts).
// All deps are stable already-extracted modules: prisma, logger,
// sendTgNotification (telegram/botApi), sendAdminAlert
// (notifications/adminAlerts).

import { prisma } from '@wishlist/db';
import { sendTgNotification } from '../telegram/botApi';
import { sendAdminAlert } from '../notifications/adminAlerts';
import logger from '../logger';

/**
 * Returns the canonical "season start year" — the November year that anchors the current
 * or upcoming Santa season. This is the single source of truth for:
 *   - SantaSeasonConfig.seasonYear  (DB override lookup key)
 *   - SantaSeasonalBroadcastLog.year (broadcast dedup key)
 *   - getSeasonCalendar()            (season window computation)
 *
 * The Santa season crosses the calendar year boundary: Nov 15 (year Y) → Feb 15 (year Y+1).
 * Any date in Jan 1 – Feb 15 belongs to the season that STARTED last November (year Y-1).
 * All other dates belong to the season starting this November (year Y, current or upcoming).
 *
 * All comparisons use UTC to be timezone-independent (server TZ never affects the result).
 *
 * Examples:
 *   2026-10-31 UTC → 2026  (off-season; next season opens Nov 15, 2026)
 *   2026-11-01 UTC → 2026  (promo day; season key = 2026)
 *   2026-11-15 UTC → 2026  (season opens)
 *   2026-12-25 UTC → 2026  (mid-season)
 *   2027-01-10 UTC → 2026  ← Jan is still the 2026 season, NOT 2027
 *   2027-02-10 UTC → 2026  ← Feb 10 is still the 2026 season, closing Feb 15
 *   2027-02-15 UTC → 2026  ← last day of the 2026 season
 *   2027-02-16 UTC → 2027  (off-season; next season key = 2027)
 *   2027-11-15 UTC → 2027  (new 2027 season opens)
 *   2027-11-20 UTC → 2027  (2027 season, NOT 2026)
 */
export function getSeasonStartYear(now: Date): number {
  const m = now.getUTCMonth() + 1; // 1–12, UTC
  const d = now.getUTCDate();       // UTC day
  const y = now.getUTCFullYear();   // UTC year
  // Jan 1 – Feb 15 UTC: tail of the season that started Nov of year Y-1
  return (m === 1 || (m === 2 && d <= 15)) ? y - 1 : y;
}

/**
 * Pure calendar helper — season window is Nov 15 00:00 UTC (seasonStartYear) →
 * Feb 15 23:59:59.999 UTC (seasonStartYear+1).
 * Uses UTC timestamps throughout to be timezone-independent.
 * Requires zero DB access. Works correctly for any calendar year, forever.
 */
export function getSeasonCalendar(now: Date): { inSeason: boolean; seasonStart: Date; seasonEnd: Date } {
  const startYear   = getSeasonStartYear(now);
  const seasonStart = new Date(Date.UTC(startYear,     10, 15));               // Nov 15 00:00:00.000 UTC
  const seasonEnd   = new Date(Date.UTC(startYear + 1,  1, 15, 23, 59, 59, 999)); // Feb 15 23:59:59.999 UTC
  return { inSeason: now >= seasonStart && now <= seasonEnd, seasonStart, seasonEnd };
}

/**
 * Compute season status and create-permission for the requesting user.
 *
 * Resolution priority (first match wins):
 *   1. SantaGlobalConfig.santaEnabled = false  → always off (unless santaTestMode)
 *   2. santaTestMode = true                    → always on (godMode bypass)
 *   3. SantaSeasonConfig row for current year  → explicit admin override (per-year dates)
 *   4. getSeasonCalendar()                     → automatic, recurring, zero annual setup
 *
 * Never mutates DB.
 */
export async function getSantaSeasonInfo(userId: string, santaTestMode: boolean) {
  const now        = new Date();
  // seasonYear is the November-start year of the current season (e.g. 2026 for Jan/Feb 2027).
  // This is the canonical DB key — must match SantaSeasonConfig.seasonYear.
  // Using getSeasonStartYear() (not now.getFullYear()) is what makes Jan/Feb 2027 correctly
  // resolve to the 2026 season row instead of a non-existent 2027 row.
  const seasonYear = getSeasonStartYear(now);

  // 1. Global kill switch — allows retiring Santa entirely without touching per-year rows.
  //    Bypassed by santaTestMode so godMode users can always test even after retirement.
  if (!santaTestMode) {
    const globalConfig = await prisma.santaGlobalConfig.findUnique({ where: { id: 'global' } });
    if (globalConfig && !globalConfig.santaEnabled) {
      return { inSeason: false, canCreate: false, seasonStart: null, seasonEnd: null, config: null };
    }
  }

  // 2. santaTestMode: bypass season window and missing-config guard entirely.
  //    Must be checked before DB row query so god-mode users always land in-season.
  if (santaTestMode) {
    const config = await prisma.santaSeasonConfig.findUnique({ where: { seasonYear } });
    const cal    = getSeasonCalendar(now);
    return {
      inSeason:    true,
      canCreate:   true,
      seasonStart: (config?.seasonStartAt ?? cal.seasonStart).toISOString(),
      seasonEnd:   (config?.seasonEndAt   ?? cal.seasonEnd).toISOString(),
      config:      config ?? null,
    };
  }

  // 3. Explicit per-year admin override row takes priority over calendar.
  //    seasonYear = getSeasonStartYear(now) ensures Jan/Feb 2027 finds the 2026 row, not 2027.
  const config = await prisma.santaSeasonConfig.findUnique({ where: { seasonYear } });
  if (config) {
    const inSeason  = now >= config.seasonStartAt && now <= config.seasonEndAt;
    const canCreate = inSeason && config.campaignCreateEnabled;
    return {
      inSeason,
      canCreate,
      seasonStart: config.seasonStartAt.toISOString(),
      seasonEnd:   config.seasonEndAt.toISOString(),
      config,
    };
  }

  // 4. No DB override — apply recurring calendar rules (Nov 15 → Feb 15).
  //    Works automatically for every year: 2026, 2027, 2028, … with zero annual setup.
  const { inSeason, seasonStart, seasonEnd } = getSeasonCalendar(now);
  return {
    inSeason,
    canCreate:   inSeason, // calendar default: all in-season users may create
    seasonStart: seasonStart.toISOString(),
    seasonEnd:   seasonEnd.toISOString(),
    config:      null,
  };
}

// ─── Santa Anonymous Alias System ────────────────────────────────────────────
// Corpus: 30 adjectives × 30 animals = 900 unique combinations per round.
// adjectiveKey / animalKey are locale-independent; alias string is pre-rendered in RU.
// Frontend re-renders in user's locale using the keys.

export const SANTA_ADJECTIVES: Record<string, { m: string; f: string; en: string }> = {
  sleepy:     { m: 'Сонный',      f: 'Сонная',      en: 'Sleepy' },
  nimble:     { m: 'Ловкий',      f: 'Ловкая',       en: 'Nimble' },
  quiet:      { m: 'Тихий',       f: 'Тихая',        en: 'Quiet' },
  northern:   { m: 'Северный',    f: 'Северная',     en: 'Northern' },
  cheerful:   { m: 'Весёлый',     f: 'Весёлая',      en: 'Cheerful' },
  cunning:    { m: 'Хитрый',      f: 'Хитрая',       en: 'Cunning' },
  kind:       { m: 'Добрый',      f: 'Добрая',       en: 'Kind' },
  swift:      { m: 'Быстрый',     f: 'Быстрая',      en: 'Swift' },
  brave:      { m: 'Смелый',      f: 'Смелая',       en: 'Brave' },
  smart:      { m: 'Умный',       f: 'Умная',        en: 'Smart' },
  gentle:     { m: 'Нежный',      f: 'Нежная',       en: 'Gentle' },
  fluffy:     { m: 'Пушистый',    f: 'Пушистая',     en: 'Fluffy' },
  bright:     { m: 'Яркий',       f: 'Яркая',        en: 'Bright' },
  curious:    { m: 'Любопытный',  f: 'Любопытная',   en: 'Curious' },
  patient:    { m: 'Терпеливый',  f: 'Терпеливая',   en: 'Patient' },
  playful:    { m: 'Игривый',     f: 'Игривая',      en: 'Playful' },
  cozy:       { m: 'Уютный',      f: 'Уютная',       en: 'Cozy' },
  peaceful:   { m: 'Спокойный',   f: 'Спокойная',    en: 'Peaceful' },
  golden:     { m: 'Золотой',     f: 'Золотая',      en: 'Golden' },
  mysterious: { m: 'Загадочный',  f: 'Загадочная',   en: 'Mysterious' },
  lucky:      { m: 'Удачливый',   f: 'Удачливая',    en: 'Lucky' },
  energetic:  { m: 'Бодрый',      f: 'Бодрая',       en: 'Energetic' },
  wise:       { m: 'Мудрый',      f: 'Мудрая',       en: 'Wise' },
  rare:       { m: 'Редкий',      f: 'Редкая',       en: 'Rare' },
  honest:     { m: 'Честный',     f: 'Честная',      en: 'Honest' },
  courageous: { m: 'Отважный',    f: 'Отважная',     en: 'Courageous' },
  modest:     { m: 'Скромный',    f: 'Скромная',     en: 'Modest' },
  wonderful:  { m: 'Чудесный',    f: 'Чудесная',     en: 'Wonderful' },
  generous:   { m: 'Щедрый',      f: 'Щедрая',       en: 'Generous' },
  light:      { m: 'Лёгкий',      f: 'Лёгкая',       en: 'Light' },
};

export const SANTA_ANIMALS: Record<string, { ru: string; gender: 'm' | 'f'; emoji: string; en: string }> = {
  giraffe:    { ru: 'жираф',      gender: 'm', emoji: '🦒', en: 'Giraffe' },
  quokka:     { ru: 'квокка',     gender: 'f', emoji: '🦘', en: 'Quokka' },
  manul:      { ru: 'манул',      gender: 'm', emoji: '🐱', en: 'Pallas Cat' },
  penguin:    { ru: 'пингвин',    gender: 'm', emoji: '🐧', en: 'Penguin' },
  fox:        { ru: 'лиса',       gender: 'f', emoji: '🦊', en: 'Fox' },
  raccoon:    { ru: 'енот',       gender: 'm', emoji: '🦝', en: 'Raccoon' },
  bear:       { ru: 'медведь',    gender: 'm', emoji: '🐻', en: 'Bear' },
  squirrel:   { ru: 'белка',      gender: 'f', emoji: '🐿️', en: 'Squirrel' },
  hedgehog:   { ru: 'ёж',         gender: 'm', emoji: '🦔', en: 'Hedgehog' },
  otter:      { ru: 'выдра',      gender: 'f', emoji: '🦦', en: 'Otter' },
  panda:      { ru: 'панда',      gender: 'f', emoji: '🐼', en: 'Panda' },
  koala:      { ru: 'коала',      gender: 'm', emoji: '🐨', en: 'Koala' },
  capybara:   { ru: 'капибара',   gender: 'f', emoji: '🦫', en: 'Capybara' },
  sloth:      { ru: 'ленивец',    gender: 'm', emoji: '🦥', en: 'Sloth' },
  flamingo:   { ru: 'фламинго',   gender: 'm', emoji: '🦩', en: 'Flamingo' },
  lemur:      { ru: 'лемур',      gender: 'm', emoji: '🐒', en: 'Lemur' },
  alpaca:     { ru: 'альпака',    gender: 'f', emoji: '🦙', en: 'Alpaca' },
  axolotl:    { ru: 'аксолотль',  gender: 'm', emoji: '🫧', en: 'Axolotl' },
  narwhal:    { ru: 'нарвал',     gender: 'm', emoji: '🌊', en: 'Narwhal' },
  platypus:   { ru: 'утконос',    gender: 'm', emoji: '🦆', en: 'Platypus' },
  meerkat:    { ru: 'сурикат',    gender: 'm', emoji: '🐾', en: 'Meerkat' },
  chinchilla: { ru: 'шиншилла',   gender: 'f', emoji: '🐭', en: 'Chinchilla' },
  tapir:      { ru: 'тапир',      gender: 'm', emoji: '🦏', en: 'Tapir' },
  wombat:     { ru: 'вомбат',     gender: 'm', emoji: '🐨', en: 'Wombat' },
  marmot:     { ru: 'сурок',      gender: 'm', emoji: '🐿️', en: 'Marmot' },
  toucan:     { ru: 'тукан',      gender: 'm', emoji: '🦜', en: 'Toucan' },
  armadillo:  { ru: 'броненосец', gender: 'm', emoji: '🛡️', en: 'Armadillo' },
  cassowary:  { ru: 'казуар',     gender: 'm', emoji: '🐦', en: 'Cassowary' },
  lynx:       { ru: 'рысь',       gender: 'f', emoji: '🐱', en: 'Lynx' },
  okapi:      { ru: 'окапи',      gender: 'm', emoji: '🦌', en: 'Okapi' },
};

export const SANTA_ADJ_KEYS = Object.keys(SANTA_ADJECTIVES);
export const SANTA_ANIMAL_KEYS = Object.keys(SANTA_ANIMALS);

/** mulberry32 — fast seeded PRNG returning [0, 1) */
export function santaSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash of a string */
export function santaHashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

/** Fisher-Yates shuffle with seeded RNG (returns new array) */
export function santaShuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/** Generate round-scoped aliases for a set of participantIds.
 *  Deterministic: same roundId + same participantIds → same aliases.
 *  Unique within round by construction (shuffled combos, assigned sequentially). */
export function generateSantaAliases(
  roundId: string,
  participantIds: string[],
): Array<{ participantId: string; alias: string; emoji: string; adjectiveKey: string; animalKey: string }> {
  const seed = santaHashStr(roundId);
  const rng  = santaSeededRng(seed);

  // Build full combo list
  const combos: Array<{ adjKey: string; animalKey: string }> = [];
  for (const adjKey of SANTA_ADJ_KEYS) {
    for (const animalKey of SANTA_ANIMAL_KEYS) {
      combos.push({ adjKey, animalKey });
    }
  }
  // Shuffle with round seed → unique ordering per round
  const shuffled = santaShuffle(combos, rng);

  // Assign to participants in deterministic order (sort by participantId)
  const sorted = [...participantIds].sort();

  return sorted.map((pid, i) => {
    const combo = shuffled[i % shuffled.length]!;
    const adj   = SANTA_ADJECTIVES[combo.adjKey]!;
    const animal = SANTA_ANIMALS[combo.animalKey]!;
    const aliasStr = `${adj[animal.gender]} ${animal.ru}`;
    return {
      participantId: pid,
      alias: aliasStr,
      emoji: animal.emoji,
      adjectiveKey: combo.adjKey,
      animalKey: combo.animalKey,
    };
  });
}

// ─── Santa seasonal broadcasts ───────────────────────────────────────────────

/**
 * Send a seasonal broadcast Telegram message to every user who has a telegramChatId.
 * Deduplication is handled by SantaSeasonalBroadcastLog — inserting the log row acts as a
 * distributed lock: if the row already exists (unique constraint), this function exits
 * immediately.  Safe to call concurrently or in a crash-restart scenario.
 *
 * @param type        'PROMO' (sent Nov 1) or 'CLOSING_SOON' (sent Feb 1)
 * @param seasonYear  The November-start year of the season (e.g. 2026 for Nov 2026 → Feb 2027)
 */
export async function sendSeasonalBroadcast(type: 'PROMO' | 'CLOSING_SOON', seasonYear: number): Promise<void> {
  // Insert log row FIRST — acts as an atomic write-once lock.
  // Unique constraint on (year, type) means only the first caller proceeds; all others exit.
  try {
    await prisma.santaSeasonalBroadcastLog.create({
      data: { year: seasonYear, type },
    });
  } catch {
    // UniqueConstraintViolation = already sent (or concurrent runner beat us). Skip.
    return;
  }

  const BATCH      = 25;   // users per DB page
  const PAUSE_MS   = 1200; // ~20 req/s; Telegram allows 30 req/s per bot

  // RU + EN in one message — we don't store per-user locale, so serve both languages.
  const textRu = type === 'PROMO'
    ? '🎅 Тайный Санта скоро открывается! Подготовьте вишлист — обмен подарками начнётся 15 ноября.'
    : '⏰ Тайный Санта закроется 15 февраля. Успейте завершить обмен подарками!';
  const textEn = type === 'PROMO'
    ? '🎅 Secret Santa is opening soon! Prepare your wishlist — the gift exchange starts November 15.'
    : '⏰ Secret Santa closes on February 15. Make sure to finish your gift exchange!';
  const text = `${textRu}\n\n${textEn}`;

  let cursor: string | undefined;
  let totalSent = 0;

  // eslint-disable-next-line no-constant-condition
  for (;;) {
    const users = await prisma.user.findMany({
      where:   { telegramChatId: { not: null } },
      select:  { id: true, telegramChatId: true },
      take:    BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
    });

    if (users.length === 0) break;

    for (const u of users) {
      if (!u.telegramChatId) continue;
      await sendTgNotification(u.telegramChatId, text);
      totalSent++;
    }

    cursor = users[users.length - 1]!.id;
    if (users.length < BATCH) break;
    await new Promise<void>(r => setTimeout(r, PAUSE_MS));
  }

  // Record final count for audit trail
  await prisma.santaSeasonalBroadcastLog.update({
    where: { year_type: { year: seasonYear, type } },
    data:  { userCount: totalSent },
  }).catch(() => { /* non-fatal */ });

  logger.info({ type, seasonYear, totalSent }, 'santa-season: broadcast sent');
  void sendAdminAlert(`🎅 Santa broadcast <b>${type}</b> (season ${seasonYear}) sent to <b>${totalSent}</b> users`);
}

/**
 * Idempotent seasonal event handler — runs hourly, triggers broadcasts on calendar milestones.
 *
 * Triggers:
 *   Nov 1  → PROMO broadcast for this year's upcoming season
 *   Feb 1  → CLOSING_SOON broadcast for the season that started last November
 *
 * Deduplication via SantaSeasonalBroadcastLog ensures each broadcast fires exactly once per year,
 * regardless of restarts, multi-instance deployments, or the hourly tick firing multiple times
 * on the same day.
 */
export async function maybeRunSeasonalEvents(): Promise<void> {
  try {
    // Abort if the feature is globally disabled
    const globalConfig = await prisma.santaGlobalConfig.findUnique({ where: { id: 'global' } });
    if (!globalConfig?.santaEnabled) return;

    const now        = new Date();
    const seasonYear = getSeasonStartYear(now); // canonical season key (Nov-year); handles cross-year boundary
    const month      = now.getMonth() + 1;
    const day        = now.getDate();

    // ── November 1: promo notification ──────────────────────────────────────
    // Nov 1, 2026 → seasonYear = getSeasonStartYear = 2026 (season opens Nov 15, 2026) ✓
    if (month === 11 && day === 1) {
      const alreadySent = await prisma.santaSeasonalBroadcastLog.findUnique({
        where: { year_type: { year: seasonYear, type: 'PROMO' } },
      });
      if (!alreadySent) {
        logger.info({ seasonYear }, 'santa-season: Nov 1 triggering PROMO broadcast');
        void sendSeasonalBroadcast('PROMO', seasonYear);
      }
    }

    // ── February 1: closing-soon notification ───────────────────────────────
    // Feb 1, 2027 → seasonYear = getSeasonStartYear = 2026 (season started Nov 2026) ✓
    // getSeasonStartYear() handles the cross-year shift automatically — no manual "year - 1" needed.
    if (month === 2 && day === 1) {
      const alreadySent = await prisma.santaSeasonalBroadcastLog.findUnique({
        where: { year_type: { year: seasonYear, type: 'CLOSING_SOON' } },
      });
      if (!alreadySent) {
        logger.info({ seasonYear }, 'santa-season: Feb 1 triggering CLOSING_SOON broadcast');
        void sendSeasonalBroadcast('CLOSING_SOON', seasonYear);
      }
    }
  } catch (err) {
    logger.error({ err }, 'santa-season seasonal event check failed');
  }
}
