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
import { t, resolveLocaleWithSource } from '@wishlist/shared';
import { sendTgNotification } from '../telegram/botApi';
import { profileToLanguageSettings } from './locale';
import { sendAdminAlert } from '../notifications/adminAlerts';
import { readExperimentConfig } from './experiments.service';
import { runPreseasonWave, isPreseasonWindow, PRESEASON_EXPERIMENT_KEY } from './santa-preseason';
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
//
// Mirror dictionary: `apps/web/app/miniapp/MiniApp.tsx` has frontend
// counterparts `SANTA_ADJ` and `SANTA_ANIMAL` with IDENTICAL data but slightly
// different field NAMES (`ru_m` / `ru_f` on the frontend vs `m` / `f` here —
// purely historical, kept for backward compat). When adding or fixing a
// translation, update BOTH files. The locale-key-parity test in
// `santa-season.test.ts` catches missing locale fields server-side but does
// not cross-check the two files — keep them in sync by hand.

export const SANTA_ADJECTIVES: Record<string, { m: string; f: string; en: string; 'zh-CN': string; hi: string; es_m: string; es_f: string; ar_m: string; ar_f: string }> = {
  sleepy: { m: 'Сонный', f: 'Сонная', en: 'Sleepy', 'zh-CN': '瞌睡的', hi: 'नींद वाला', es_m: 'Soñoliento', es_f: 'Soñolienta', ar_m: 'نعسان', ar_f: 'نعسانة' },
  nimble: { m: 'Ловкий', f: 'Ловкая', en: 'Nimble', 'zh-CN': '敏捷的', hi: 'फुर्तीला', es_m: 'Ágil', es_f: 'Ágil', ar_m: 'رشيق', ar_f: 'رشيقة' },
  quiet: { m: 'Тихий', f: 'Тихая', en: 'Quiet', 'zh-CN': '安静的', hi: 'शांत', es_m: 'Silencioso', es_f: 'Silenciosa', ar_m: 'هادئ', ar_f: 'هادئة' },
  northern: { m: 'Северный', f: 'Северная', en: 'Northern', 'zh-CN': '北方的', hi: 'उत्तरी', es_m: 'Norteño', es_f: 'Norteña', ar_m: 'شمالي', ar_f: 'شمالية' },
  cheerful: { m: 'Весёлый', f: 'Весёлая', en: 'Cheerful', 'zh-CN': '快乐的', hi: 'खुशमिज़ाज', es_m: 'Alegre', es_f: 'Alegre', ar_m: 'مرح', ar_f: 'مرحة' },
  cunning: { m: 'Хитрый', f: 'Хитрая', en: 'Cunning', 'zh-CN': '狡黠的', hi: 'चालाक', es_m: 'Astuto', es_f: 'Astuta', ar_m: 'ماكر', ar_f: 'ماكرة' },
  kind: { m: 'Добрый', f: 'Добрая', en: 'Kind', 'zh-CN': '善良的', hi: 'दयालु', es_m: 'Bondadoso', es_f: 'Bondadosa', ar_m: 'طيب', ar_f: 'طيبة' },
  swift: { m: 'Быстрый', f: 'Быстрая', en: 'Swift', 'zh-CN': '迅捷的', hi: 'तेज़', es_m: 'Veloz', es_f: 'Veloz', ar_m: 'سريع', ar_f: 'سريعة' },
  brave: { m: 'Смелый', f: 'Смелая', en: 'Brave', 'zh-CN': '勇敢的', hi: 'बहादुर', es_m: 'Valiente', es_f: 'Valiente', ar_m: 'شجاع', ar_f: 'شجاعة' },
  smart: { m: 'Умный', f: 'Умная', en: 'Smart', 'zh-CN': '聪明的', hi: 'होशियार', es_m: 'Listo', es_f: 'Lista', ar_m: 'ذكي', ar_f: 'ذكية' },
  gentle: { m: 'Нежный', f: 'Нежная', en: 'Gentle', 'zh-CN': '温柔的', hi: 'कोमल', es_m: 'Tierno', es_f: 'Tierna', ar_m: 'لطيف', ar_f: 'لطيفة' },
  fluffy: { m: 'Пушистый', f: 'Пушистая', en: 'Fluffy', 'zh-CN': '蓬松的', hi: 'रोयेंदार', es_m: 'Mullido', es_f: 'Mullida', ar_m: 'زغبي', ar_f: 'زغبية' },
  bright: { m: 'Яркий', f: 'Яркая', en: 'Bright', 'zh-CN': '明亮的', hi: 'चमकीला', es_m: 'Brillante', es_f: 'Brillante', ar_m: 'ساطع', ar_f: 'ساطعة' },
  curious: { m: 'Любопытный', f: 'Любопытная', en: 'Curious', 'zh-CN': '好奇的', hi: 'जिज्ञासु', es_m: 'Curioso', es_f: 'Curiosa', ar_m: 'فضولي', ar_f: 'فضولية' },
  patient: { m: 'Терпеливый', f: 'Терпеливая', en: 'Patient', 'zh-CN': '耐心的', hi: 'धैर्यवान', es_m: 'Paciente', es_f: 'Paciente', ar_m: 'صبور', ar_f: 'صبورة' },
  playful: { m: 'Игривый', f: 'Игривая', en: 'Playful', 'zh-CN': '顽皮的', hi: 'खिलंदड़', es_m: 'Juguetón', es_f: 'Juguetona', ar_m: 'لعوب', ar_f: 'لعوبة' },
  cozy: { m: 'Уютный', f: 'Уютная', en: 'Cozy', 'zh-CN': '舒适的', hi: 'आरामदायक', es_m: 'Acogedor', es_f: 'Acogedora', ar_m: 'دافئ', ar_f: 'دافئة' },
  peaceful: { m: 'Спокойный', f: 'Спокойная', en: 'Peaceful', 'zh-CN': '平和的', hi: 'शांतिप्रिय', es_m: 'Apacible', es_f: 'Apacible', ar_m: 'وديع', ar_f: 'وديعة' },
  golden: { m: 'Золотой', f: 'Золотая', en: 'Golden', 'zh-CN': '金色的', hi: 'सुनहरा', es_m: 'Dorado', es_f: 'Dorada', ar_m: 'ذهبي', ar_f: 'ذهبية' },
  mysterious: { m: 'Загадочный', f: 'Загадочная', en: 'Mysterious', 'zh-CN': '神秘的', hi: 'रहस्यमय', es_m: 'Misterioso', es_f: 'Misteriosa', ar_m: 'غامض', ar_f: 'غامضة' },
  lucky: { m: 'Удачливый', f: 'Удачливая', en: 'Lucky', 'zh-CN': '幸运的', hi: 'भाग्यशाली', es_m: 'Afortunado', es_f: 'Afortunada', ar_m: 'محظوظ', ar_f: 'محظوظة' },
  energetic: { m: 'Бодрый', f: 'Бодрая', en: 'Energetic', 'zh-CN': '活力的', hi: 'ऊर्जावान', es_m: 'Enérgico', es_f: 'Enérgica', ar_m: 'نشيط', ar_f: 'نشيطة' },
  wise: { m: 'Мудрый', f: 'Мудрая', en: 'Wise', 'zh-CN': '睿智的', hi: 'बुद्धिमान', es_m: 'Sabio', es_f: 'Sabia', ar_m: 'حكيم', ar_f: 'حكيمة' },
  rare: { m: 'Редкий', f: 'Редкая', en: 'Rare', 'zh-CN': '稀有的', hi: 'दुर्लभ', es_m: 'Raro', es_f: 'Rara', ar_m: 'نادر', ar_f: 'نادرة' },
  honest: { m: 'Честный', f: 'Честная', en: 'Honest', 'zh-CN': '诚实的', hi: 'ईमानदार', es_m: 'Honesto', es_f: 'Honesta', ar_m: 'صادق', ar_f: 'صادقة' },
  courageous: { m: 'Отважный', f: 'Отважная', en: 'Courageous', 'zh-CN': '英勇的', hi: 'साहसी', es_m: 'Audaz', es_f: 'Audaz', ar_m: 'باسل', ar_f: 'باسلة' },
  modest: { m: 'Скромный', f: 'Скромная', en: 'Modest', 'zh-CN': '谦逊的', hi: 'विनम्र', es_m: 'Modesto', es_f: 'Modesta', ar_m: 'متواضع', ar_f: 'متواضعة' },
  wonderful: { m: 'Чудесный', f: 'Чудесная', en: 'Wonderful', 'zh-CN': '奇妙的', hi: 'अद्भुत', es_m: 'Maravilloso', es_f: 'Maravillosa', ar_m: 'رائع', ar_f: 'رائعة' },
  generous: { m: 'Щедрый', f: 'Щедрая', en: 'Generous', 'zh-CN': '慷慨的', hi: 'उदार', es_m: 'Generoso', es_f: 'Generosa', ar_m: 'كريم', ar_f: 'كريمة' },
  light: { m: 'Лёгкий', f: 'Лёгкая', en: 'Light', 'zh-CN': '轻盈的', hi: 'हल्का', es_m: 'Ligero', es_f: 'Ligera', ar_m: 'خفيف', ar_f: 'خفيفة' },
};

export const SANTA_ANIMALS: Record<string, { ru: string; gender: 'm' | 'f'; emoji: string; en: string; 'zh-CN': string; hi: string; es: string; ar: string }> = {
  giraffe: { ru: 'жираф', gender: 'm', emoji: '🦒', en: 'Giraffe', 'zh-CN': '长颈鹿', hi: 'जिराफ़', es: 'Jirafa', ar: 'زرافة' },
  quokka: { ru: 'квокка', gender: 'f', emoji: '🦘', en: 'Quokka', 'zh-CN': '短尾矮袋鼠', hi: 'क्वोक्का', es: 'Quokka', ar: 'كوكا' },
  manul: { ru: 'манул', gender: 'm', emoji: '🐱', en: 'Pallas Cat', 'zh-CN': '兔狲', hi: 'मनुल', es: 'Gato manul', ar: 'قط مانول' },
  penguin: { ru: 'пингвин', gender: 'm', emoji: '🐧', en: 'Penguin', 'zh-CN': '企鹅', hi: 'पेंगुइन', es: 'Pingüino', ar: 'بطريق' },
  fox: { ru: 'лиса', gender: 'f', emoji: '🦊', en: 'Fox', 'zh-CN': '狐狸', hi: 'लोमड़ी', es: 'Zorra', ar: 'ثعلبة' },
  raccoon: { ru: 'енот', gender: 'm', emoji: '🦝', en: 'Raccoon', 'zh-CN': '浣熊', hi: 'रैकून', es: 'Mapache', ar: 'راكون' },
  bear: { ru: 'медведь', gender: 'm', emoji: '🐻', en: 'Bear', 'zh-CN': '熊', hi: 'भालू', es: 'Oso', ar: 'دب' },
  squirrel: { ru: 'белка', gender: 'f', emoji: '🐿️', en: 'Squirrel', 'zh-CN': '松鼠', hi: 'गिलहरी', es: 'Ardilla', ar: 'سنجاب' },
  hedgehog: { ru: 'ёж', gender: 'm', emoji: '🦔', en: 'Hedgehog', 'zh-CN': '刺猬', hi: 'हेजहोग', es: 'Erizo', ar: 'قنفذ' },
  otter: { ru: 'выдра', gender: 'f', emoji: '🦦', en: 'Otter', 'zh-CN': '水獭', hi: 'ऊदबिलाव', es: 'Nutria', ar: 'ثعلب الماء' },
  panda: { ru: 'панда', gender: 'f', emoji: '🐼', en: 'Panda', 'zh-CN': '熊猫', hi: 'पांडा', es: 'Panda', ar: 'باندا' },
  koala: { ru: 'коала', gender: 'm', emoji: '🐨', en: 'Koala', 'zh-CN': '考拉', hi: 'कोआला', es: 'Koala', ar: 'كوالا' },
  capybara: { ru: 'капибара', gender: 'f', emoji: '🦫', en: 'Capybara', 'zh-CN': '水豚', hi: 'कैपीबारा', es: 'Capibara', ar: 'كابيبارا' },
  sloth: { ru: 'ленивец', gender: 'm', emoji: '🦥', en: 'Sloth', 'zh-CN': '树懒', hi: 'स्लॉथ', es: 'Perezoso', ar: 'كسلان' },
  flamingo: { ru: 'фламинго', gender: 'm', emoji: '🦩', en: 'Flamingo', 'zh-CN': '火烈鸟', hi: 'फ्लेमिंगो', es: 'Flamenco', ar: 'فلامنجو' },
  lemur: { ru: 'лемур', gender: 'm', emoji: '🐒', en: 'Lemur', 'zh-CN': '狐猴', hi: 'लीमर', es: 'Lémur', ar: 'ليمور' },
  alpaca: { ru: 'альпака', gender: 'f', emoji: '🦙', en: 'Alpaca', 'zh-CN': '羊驼', hi: 'अल्पाका', es: 'Alpaca', ar: 'ألبكة' },
  axolotl: { ru: 'аксолотль', gender: 'm', emoji: '🫧', en: 'Axolotl', 'zh-CN': '蝾螈', hi: 'एक्सोलॉटल', es: 'Ajolote', ar: 'أكسولوتل' },
  narwhal: { ru: 'нарвал', gender: 'm', emoji: '🌊', en: 'Narwhal', 'zh-CN': '独角鲸', hi: 'नरव्हेल', es: 'Narval', ar: 'نرول' },
  platypus: { ru: 'утконос', gender: 'm', emoji: '🦆', en: 'Platypus', 'zh-CN': '鸭嘴兽', hi: 'प्लैटिपस', es: 'Ornitorrinco', ar: 'منقار البط' },
  meerkat: { ru: 'сурикат', gender: 'm', emoji: '🐾', en: 'Meerkat', 'zh-CN': '猫鼬', hi: 'मीरकैट', es: 'Suricata', ar: 'نمس' },
  chinchilla: { ru: 'шиншилла', gender: 'f', emoji: '🐭', en: 'Chinchilla', 'zh-CN': '毛丝鼠', hi: 'चिनचिला', es: 'Chinchilla', ar: 'شنشيلا' },
  tapir: { ru: 'тапир', gender: 'm', emoji: '🦏', en: 'Tapir', 'zh-CN': '貘', hi: 'टपीर', es: 'Tapir', ar: 'تابير' },
  wombat: { ru: 'вомбат', gender: 'm', emoji: '🐨', en: 'Wombat', 'zh-CN': '袋熊', hi: 'वोम्बैट', es: 'Wombat', ar: 'ومبت' },
  marmot: { ru: 'сурок', gender: 'm', emoji: '🐿️', en: 'Marmot', 'zh-CN': '土拨鼠', hi: 'मारमॉट', es: 'Marmota', ar: 'مرموط' },
  toucan: { ru: 'тукан', gender: 'm', emoji: '🦜', en: 'Toucan', 'zh-CN': '巨嘴鸟', hi: 'टूकेन', es: 'Tucán', ar: 'طوقان' },
  armadillo: { ru: 'броненосец', gender: 'm', emoji: '🛡️', en: 'Armadillo', 'zh-CN': '犰狳', hi: 'आर्माडिलो', es: 'Armadillo', ar: 'أرماديللو' },
  cassowary: { ru: 'казуар', gender: 'm', emoji: '🐦', en: 'Cassowary', 'zh-CN': '鹤鸵', hi: 'कैसोवरी', es: 'Casuario', ar: 'شبنم' },
  lynx: { ru: 'рысь', gender: 'f', emoji: '🐱', en: 'Lynx', 'zh-CN': '猞猁', hi: 'लिंक्स', es: 'Lince', ar: 'وشق' },
  okapi: { ru: 'окапи', gender: 'm', emoji: '🦌', en: 'Okapi', 'zh-CN': '霍加狓', hi: 'ओकापी', es: 'Okapi', ar: 'أوكابي' },
};

export const SANTA_ADJ_KEYS = Object.keys(SANTA_ADJECTIVES);
export const SANTA_ANIMAL_KEYS = Object.keys(SANTA_ANIMALS);

/**
 * Render an alias string in the recipient's locale from key pair + locale.
 * Use this server-side wherever we display an alias to a Telegram user
 * (bot notifications, lifecycle DMs, broadcasts) so non-RU users don't
 * receive Russian text.
 *
 * Mirrors the frontend `renderSantaAlias` in apps/web/app/miniapp/MiniApp.tsx —
 * keep both in sync.
 */
export function renderSantaAliasLocalized(adjectiveKey: string, animalKey: string, locale: string): string | null {
  const adj = SANTA_ADJECTIVES[adjectiveKey];
  const animal = SANTA_ANIMALS[animalKey];
  if (!adj || !animal) return null;
  switch (locale) {
    case 'en':    return `${adj.en} ${animal.en}`;
    case 'zh-CN': return `${adj['zh-CN']}${animal['zh-CN']}`;
    case 'hi':    return `${adj.hi} ${animal.hi}`;
    case 'es':    return `${animal.es} ${animal.gender === 'f' ? adj.es_f : adj.es_m}`;
    case 'ar':    return `${animal.ar} ${animal.gender === 'f' ? adj.ar_f : adj.ar_m}`;
    default:      return `${animal.gender === 'f' ? adj.f : adj.m} ${animal.ru}`;
  }
}

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

  // Per-recipient locale via the canonical resolver chain — every user receives
  // the broadcast in their own language. Was: hardcoded `textRu + textEn` blob
  // sent to every user (so zh-CN/hi/es/ar speakers got two foreign languages).
  const key = type === 'PROMO' ? 'santa_broadcast_promo' : 'santa_broadcast_closing_soon';

  let cursor: string | undefined;
  let totalSent = 0;

  // eslint-disable-next-line no-constant-condition
  for (;;) {
    const users = await prisma.user.findMany({
      // notifyMarketing opt-out (PRO-only) is now respected. NULL-safe: users
      // with no UserProfile row (default marketing "on") still receive it — only
      // explicit opt-outs (notifyMarketing=false) are excluded. Previously this
      // broadcast blasted every user regardless of opt-out (compliance gap).
      where:   { telegramChatId: { not: null }, NOT: { profile: { is: { notifyMarketing: false } } } },
      select:  { id: true, telegramChatId: true, profile: { select: { languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } } },
      take:    BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      orderBy: { id: 'asc' },
    });

    if (users.length === 0) break;

    for (const u of users) {
      if (!u.telegramChatId) continue;
      const { locale } = resolveLocaleWithSource(profileToLanguageSettings(u.profile));
      await sendTgNotification(u.telegramChatId, t(key, locale));
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
 * Pure date predicate — does `now` fall on a seasonal broadcast trigger day?
 *
 * Trigger days (UTC):
 *   Nov 1  → PROMO         (the season opening on Nov 15 of the same year)
 *   Feb 1  → CLOSING_SOON  (the season started last November; key = year-1)
 *
 * Uses UTC (matches `getSeasonStartYear` / `getSeasonCalendar` which both
 * already worked in UTC). Earlier the inline trigger check inside
 * `maybeRunSeasonalEvents` used `Date#getMonth()` / `getDate()` (local time),
 * which on the Vultr Amsterdam VPS (CET/CEST = UTC+1/+2) caused the broadcast
 * to fire ~1–2 hours before the canonical season-year cutover. Switching to
 * UTC here aligns the trigger with the canonical season key and removes the
 * server-TZ dependency. The hourly cron has 24 attempts to land inside the
 * trigger day; idempotency is guaranteed by SantaSeasonalBroadcastLog, so the
 * net effect of the switch is "broadcast still fires once on calendar Nov 1
 * UTC / Feb 1 UTC" rather than "broadcast fires 1–2 hours earlier".
 *
 * Extracted from `maybeRunSeasonalEvents` so the trigger-day logic is
 * unit-testable with fixed dates. The async handler reads this predicate
 * once and acts on the result.
 */
export function isSeasonalEventTriggerDay(now: Date): 'PROMO' | 'CLOSING_SOON' | null {
  const month = now.getUTCMonth() + 1;
  const day = now.getUTCDate();
  if (month === 11 && day === 1) return 'PROMO';
  if (month === 2 && day === 1) return 'CLOSING_SOON';
  return null;
}

/**
 * Idempotent seasonal event handler — runs hourly, triggers broadcasts on calendar milestones.
 *
 * Deduplication via SantaSeasonalBroadcastLog ensures each broadcast fires exactly once per year,
 * regardless of restarts, multi-instance deployments, or the hourly tick firing multiple times
 * on the same day.
 *
 * `now` defaults to `new Date()`; pass an explicit value for tests so the
 * trigger-day branch is exercisable on any day of the year.
 */
export async function maybeRunSeasonalEvents(now: Date = new Date()): Promise<void> {
  try {
    // Abort if the feature is globally disabled
    const globalConfig = await prisma.santaGlobalConfig.findUnique({ where: { id: 'global' } });
    if (!globalConfig?.santaEnabled) return;

    // ── E23 pre-season teaser DM — supersedes the legacy Nov-1 PROMO blast ──
    // When the santa-preseason-dm experiment is ENABLED, E23 owns the Nov 1–14
    // window: it runs the segmented, opt-out-respecting, A/B-controlled,
    // mute-kill-switched teaser wave (advancing one tick per hour), and on Nov 1
    // tombstones the legacy PROMO log row so the broadcast below can NEVER also
    // fire this season — even if the flag is toggled off mid-window. When the
    // experiment is OFF (default), this whole block is a no-op and the legacy
    // PROMO fires exactly as before. The pre-season wave sits behind the same
    // santaEnabled kill-switch above (no teaser for a disabled feature).
    const preseasonConfig = readExperimentConfig(PRESEASON_EXPERIMENT_KEY);
    if (preseasonConfig.enabled && isPreseasonWindow(now)) {
      const preseasonYear = getSeasonStartYear(now);
      await runPreseasonWave({ now, seasonYear: preseasonYear, config: preseasonConfig });
      if (now.getUTCMonth() === 10 && now.getUTCDate() === 1) {
        await prisma.santaSeasonalBroadcastLog
          .create({ data: { year: preseasonYear, type: 'PROMO' } })
          .catch(() => { /* already tombstoned by an earlier tick — fine */ });
      }
    }

    const trigger = isSeasonalEventTriggerDay(now);
    if (!trigger) return;

    const seasonYear = getSeasonStartYear(now); // canonical season key (Nov-year); handles cross-year boundary

    const alreadySent = await prisma.santaSeasonalBroadcastLog.findUnique({
      where: { year_type: { year: seasonYear, type: trigger } },
    });
    if (alreadySent) return;

    logger.info({ seasonYear, trigger }, 'santa-season: trigger day matched, broadcasting');
    void sendSeasonalBroadcast(trigger, seasonYear);
  } catch (err) {
    logger.error({ err }, 'santa-season seasonal event check failed');
  }
}
