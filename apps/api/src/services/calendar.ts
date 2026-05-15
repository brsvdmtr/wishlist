// Pure date arithmetic for the Events Calendar / Gift Notes feature
// (P5s-8 — extracted from apps/api/src/index.ts).
//
// Three pure functions shared between the gift-notes route handlers and
// the events scheduler. No Prisma, no fetch, no logger — only native
// Date math + string formatting. Bodies byte-identical to their previous
// in-place definitions in index.ts.
//
// Strategy B: direct import. Routes and the scheduler import from here
// rather than receiving via deps factory; the previous deps signatures
// dropped these three entries in the same PR.
//
// Consumers:
//   - apps/api/src/routes/gift-notes.routes.ts (Mini App reminder CRUD,
//     occasion list with `nextOccurrence` projection).
//   - apps/api/src/schedulers/events.ts (5-min cron that re-schedules
//     fired reminders for the next occurrence of recurring occasions).

/** Compute next occurrence date. Handles Feb29 + day>daysInMonth */
export function getNextOccurrenceDate(eventDate: Date, recurrence: string): Date | null {
  if (recurrence === 'NONE') return eventDate;
  const now = new Date();
  const nowStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const [nowY, nowM, nowD] = nowStr.split('-').map(Number) as [number, number, number];
  const todayNum = nowY * 10000 + nowM * 100 + nowD;
  const evM = eventDate.getUTCMonth() + 1;
  const evD = eventDate.getUTCDate();
  if (recurrence === 'YEARLY') {
    for (let y = nowY; y <= nowY + 1; y++) {
      const dim = new Date(y, evM, 0).getDate();
      const day = Math.min(evD, dim);
      if (y * 10000 + evM * 100 + day >= todayNum) return new Date(Date.UTC(y, evM - 1, day));
    }
  }
  if (recurrence === 'MONTHLY') {
    for (let offset = 0; offset <= 1; offset++) {
      const m = nowM + offset;
      const y = nowY + Math.floor((m - 1) / 12);
      const mN = ((m - 1) % 12) + 1;
      const dim = new Date(y, mN, 0).getDate();
      const day = Math.min(evD, dim);
      if (y * 10000 + mN * 100 + day >= todayNum) return new Date(Date.UTC(y, mN - 1, day));
    }
  }
  return eventDate;
}

export function computeReminderSchedule(eventDate: Date, recurrence: string, offsetDays: number, timeOfDay: string): Date {
  const next = getNextOccurrenceDate(eventDate, recurrence) ?? eventDate;
  const [hh, mm] = timeOfDay.split(':').map(Number) as [number, number];
  const base = new Date(next.getTime());
  base.setUTCDate(base.getUTCDate() + offsetDays);
  base.setUTCHours(hh - 3, mm, 0, 0); // MSK→UTC
  return base;
}

export function buildReminderEpisodeKey(occasionId: string, offsetDays: number, scheduledFor: Date): string {
  const y = scheduledFor.getUTCFullYear();
  const m = String(scheduledFor.getUTCMonth() + 1).padStart(2, '0');
  return `occ_${occasionId}_off${offsetDays}_${y}_${m}`;
}

/**
 * Calendar-day difference between `target` (already at UTC midnight) and
 * `now` (any time of day). Both sides are normalised to UTC midnight before
 * subtraction, so the result is an integer number of *calendar days*, not
 * fractional 24-hour windows.
 *
 * Why this exists: a 2026-04-30 prod bug rendered the badge "СЕГОДНЯ"
 * for an event tomorrow at 00:00 UTC, queried in the evening. The buggy
 * formula `(target - Date.now()) / 86400_000` produced ~0.36 → Math.round → 0,
 * which the frontend interprets as "today." The fix is to compare two
 * UTC-midnights — `nextDate` is already there (built via `Date.UTC(y, m, d)`),
 * `now` must be normalised explicitly.
 *
 * Pass `now` as a parameter (not via `new Date()` inside) so the function
 * stays trivially testable and time-of-day independent at the seam.
 */
export function daysUntilFromUtcMidnight(target: Date, now: Date): number {
  const todayUtcMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target.getTime() - todayUtcMs) / 86400_000);
}
