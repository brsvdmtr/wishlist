// Birthday reminders pure helpers (P5r-6) — extracted from
// apps/api/src/index.ts. Six pure utility functions plus the MSK
// timezone offset constant they all depend on.
//
// Two of these (`daysUntilNextBirthday`, `pickBirthdayDisplayName`) are
// also consumed by `apps/api/src/routes/birthday-reminders.routes.ts`
// via the deps factory (the routes file declared them as dep contract
// fields back in P5e). After this extraction, index.ts imports them
// from here and continues to pass them through to the routes factory
// — the routes contract is unchanged.
//
// `BIRTHDAY_TZ_OFFSET_HOURS` is exported alongside because every helper
// in this module references it, and the scheduler module
// (`schedulers/birthday-reminders.ts`) also re-imports it from here so
// `recipientHitDailyCap` keeps the same byte-identical UTC math. Keeping
// the constant adjacent to the helpers that use it avoids a
// scheduler→service circular concern.
//
// All functions preserved byte-identical from their inline
// declarations in index.ts.

/** MSK timezone offset (hours). Matches GiftOccasionReminder cron. */
export const BIRTHDAY_TZ_OFFSET_HOURS = 3;

/** Day of month (1..31) of birthday in MSK, or null if no birthday set. */
export function getMskBirthdayDay(birthday: Date | null): { month: number; day: number } | null {
  if (!birthday) return null;
  // Birthday is stored as DateTime; only month+day matter (year may be 2000 carrier or real).
  // Read in UTC then shift by MSK offset for the day boundary.
  const mskMs = birthday.getTime() + BIRTHDAY_TZ_OFFSET_HOURS * 3600_000;
  const d = new Date(mskMs);
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Today's date in MSK as { y, m, d }. */
export function getMskToday(now: Date): { year: number; month: number; day: number; hour: number } {
  const mskMs = now.getTime() + BIRTHDAY_TZ_OFFSET_HOURS * 3600_000;
  const d = new Date(mskMs);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
  };
}

/** Days from MSK today to the next occurrence of this birthday (0..365). */
export function daysUntilNextBirthday(birthday: Date | null, now: Date): number | null {
  const todayMsk = getMskToday(now);
  const md = getMskBirthdayDay(birthday);
  if (!md) return null;
  const todayMs = Date.UTC(todayMsk.year, todayMsk.month - 1, todayMsk.day) / 86400_000;
  let candidateY = todayMsk.year;
  let day = md.day;
  if (md.month === 2 && md.day === 29) {
    const isLeap = (candidateY % 4 === 0 && candidateY % 100 !== 0) || (candidateY % 400 === 0);
    if (!isLeap) day = 28;
  }
  let bdayMs = Date.UTC(candidateY, md.month - 1, day) / 86400_000;
  if (bdayMs < todayMs) {
    candidateY += 1;
    let day2 = md.day;
    if (md.month === 2 && md.day === 29) {
      const isLeap = (candidateY % 4 === 0 && candidateY % 100 !== 0) || (candidateY % 400 === 0);
      if (!isLeap) day2 = 28;
    }
    bdayMs = Date.UTC(candidateY, md.month - 1, day2) / 86400_000;
  }
  return Math.round(bdayMs - todayMs);
}

/**
 * Format the occurrenceKey ("YYYY-MM-DD") for a birthday user's upcoming
 * birthday at the given offset from MSK today. Used for the unique constraint
 * on BirthdayReminderDelivery so reruns are idempotent.
 */
export function buildOccurrenceKey(birthday: Date, todayMsk: { year: number; month: number; day: number }, offsetDays: number): string | null {
  const md = getMskBirthdayDay(birthday);
  if (!md) return null;
  // Target date = today + offsetDays. Birthday must fall on that day.
  const todayMs = Date.UTC(todayMsk.year, todayMsk.month - 1, todayMsk.day);
  const targetMs = todayMs + offsetDays * 86400_000;
  const target = new Date(targetMs);
  const y = target.getUTCFullYear();
  // Birthday occurrence date in target's calendar year. Feb 29 collapse handled separately —
  // for occurrenceKey we use the year that the birthday falls in (i.e. target year).
  let day = md.day;
  if (md.month === 2 && md.day === 29) {
    const isLeap = (y % 4 === 0 && y % 100 !== 0) || (y % 400 === 0);
    if (!isLeap) day = 28;
  }
  return `${y}-${String(md.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Return the next MSK 10:00 as a Date for `deferredUntil` use. */
export function nextMskMorning(now: Date): Date {
  const today = getMskToday(now);
  // Next-day 10:00 MSK = next-day UTC 07:00.
  const nextDayUtcStartMs = Date.UTC(today.year, today.month - 1, today.day) + 86400_000;
  return new Date(nextDayUtcStartMs + (10 - BIRTHDAY_TZ_OFFSET_HOURS) * 3600_000);
}

/** Pick the displayable name for a birthday user. */
export function pickBirthdayDisplayName(p: { displayName: string | null; username: string | null; firstName?: string | null }): string {
  return (p.displayName?.trim() || p.username?.trim() || p.firstName?.trim() || 'WishBoard') as string;
}
