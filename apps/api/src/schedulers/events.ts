// Events Calendar scheduler (P5r-4) — extracted from apps/api/src/index.ts.
// Single 5-min cron that drives gift-occasion reminders: finds due
// `GiftOccasionReminder` rows, formats locale-specific notification text,
// sends a Telegram bot message + writes a `CalendarInboxEntry`, marks
// the reminder sent, then schedules the next occurrence for recurring
// occasions (using getNextOccurrenceDate / computeReminderSchedule /
// buildReminderEpisodeKey helpers from index.ts — those are also
// consumed by gift-notes.routes.ts via the same dep contract).
//
// Cadence (5 * 60 * 1000 ms), log labels, and structured fields preserved
// byte-identical for ops continuity.
//
// Best-effort: errors logged but never bubble out of setInterval; next
// 5-minute cycle re-attempts.

import type { PrismaClient } from '@wishlist/db';
import type { Logger } from 'pino';
import {
  resolveEffectiveLocale,
  type Locale,
  type LanguageMode,
  type LanguageSettings,
} from '@wishlist/shared';
import {
  getNextOccurrenceDate,
  computeReminderSchedule,
  buildReminderEpisodeKey,
} from '../services/calendar';

export type EventSchedulerDeps = {
  prisma: PrismaClient;
  logger: Logger;
  sendTgBotMessage: (chatId: string, text: string, replyMarkup?: Record<string, unknown>) => Promise<boolean>;
  BOT_TOKEN_FOR_DM: string;
};

export function startEventSchedulers(deps: EventSchedulerDeps): void {
  const {
    prisma,
    logger,
    sendTgBotMessage,
    BOT_TOKEN_FOR_DM,
  } = deps;

  // ─── Events Calendar reminders cron (every 5 min) ───────────────────────────
  setInterval(async () => {
    if (!BOT_TOKEN_FOR_DM) return;
    try {
      const now = new Date();
      const due = await prisma.giftOccasionReminder.findMany({
        where: { scheduledFor: { lte: now, not: null }, sentAt: null, enabled: true },
        take: 50,
        include: {
          occasion: {
            select: {
              id: true, title: true, type: true, emoji: true, eventDate: true, recurrence: true,
              personName: true, eventTime: true, location: true, status: true,
              linkedUser: { select: { profile: { select: { displayName: true, username: true } }, firstName: true } },
            },
          },
          owner: { select: { id: true, telegramChatId: true, profile: { select: { languageMode: true, manualLanguage: true } } } },
        },
      });
      if (due.length === 0) return;

      let sent = 0;
      for (const r of due) {
        if (r.occasion.status === 'ARCHIVED') {
          await prisma.giftOccasionReminder.update({ where: { id: r.id }, data: { sentAt: new Date(), delivered: false } });
          continue;
        }
        const chatId = r.owner.telegramChatId;
        const langSettings: LanguageSettings | null = r.owner.profile
          ? { languageMode: (r.owner.profile.languageMode as LanguageMode) ?? 'auto', manualLanguage: (r.owner.profile.manualLanguage as Locale | null) ?? null }
          : null;
        const locale: Locale = resolveEffectiveLocale(langSettings, undefined);
        const emoji = r.occasion.emoji ?? (r.occasion.type === 'BIRTHDAY' ? '🎂' : r.occasion.type === 'ANNIVERSARY' ? '💍' : r.occasion.type === 'HOLIDAY' ? '🎉' : '📅');
        const titleText = r.occasion.title;
        let title: string;
        let body: string;
        if (r.offsetDays === 0) {
          switch (locale) {
            case 'en': title = `${emoji} Today: ${titleText}`; body = 'Don’t forget to celebrate!'; break;
            case 'zh-CN': title = `${emoji} 今天：${titleText}`; body = '别忘了庆祝！'; break;
            case 'hi': title = `${emoji} आज: ${titleText}`; body = 'मनाना न भूलें!'; break;
            case 'es': title = `${emoji} Hoy: ${titleText}`; body = '¡No olvides celebrar!'; break;
            case 'ar': title = `${emoji} اليوم: ${titleText}`; body = 'لا تنسَ الاحتفال!'; break;
            default: title = `${emoji} Сегодня: ${titleText}`; body = 'Не забудьте поздравить!';
          }
        } else if (r.offsetDays > 0) {
          switch (locale) {
            case 'en': title = `${emoji} ${titleText} — ${r.offsetDays} day(s) ago`; body = 'Was the gift well-received?'; break;
            case 'zh-CN': title = `${emoji} ${titleText} —— ${r.offsetDays} 天前`; body = '礼物喜欢吗？'; break;
            case 'hi': title = `${emoji} ${titleText} — ${r.offsetDays} दिन पहले`; body = 'क्या उपहार पसंद आया?'; break;
            case 'es': title = `${emoji} ${titleText} — hace ${r.offsetDays} día(s)`; body = '¿Le gustó el regalo?'; break;
            case 'ar': title = `${emoji} ${titleText} — قبل ${r.offsetDays} يوم(أيام)`; body = 'هل أعجب الهدية؟'; break;
            default: title = `${emoji} ${titleText} — ${r.offsetDays} дн назад`; body = 'Подарок понравился?';
          }
        } else {
          const days = Math.abs(r.offsetDays);
          switch (locale) {
            case 'en': title = `${emoji} ${titleText} in ${days} day(s)`; body = days <= 1 ? 'Tomorrow!' : 'Time to pick a gift.'; break;
            case 'zh-CN': title = `${emoji} ${titleText} 还有 ${days} 天`; body = days <= 1 ? '明天！' : '该挑选礼物了。'; break;
            case 'hi': title = `${emoji} ${titleText} ${days} दिन में`; body = days <= 1 ? 'कल!' : 'उपहार चुनने का समय।'; break;
            case 'es': title = `${emoji} ${titleText} en ${days} día(s)`; body = days <= 1 ? '¡Mañana!' : 'Es hora de elegir un regalo.'; break;
            case 'ar': title = `${emoji} ${titleText} بعد ${days} يوم(أيام)`; body = days <= 1 ? 'غداً!' : 'حان وقت اختيار هدية.'; break;
            default: title = `${emoji} ${titleText} через ${days} дн.`; body = days <= 1 ? 'Уже завтра!' : 'Время подобрать подарок.';
          }
        }

        let delivered = false;
        if (chatId) {
          const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const text = `<b>${esc(title)}</b>\n\n${esc(body)}`;
          delivered = await sendTgBotMessage(chatId, text, {
            inline_keyboard: [[
              { text: locale === 'ru' ? '📱 Открыть' : 'Open', url: 'https://t.me/WishBoardBot/app' },
            ]],
          });
          if (delivered) sent++;
        }

        await prisma.calendarInboxEntry.create({
          data: {
            ownerUserId: r.ownerUserId,
            occasionId: r.occasionId,
            type: r.offsetDays === 0 ? 'EVENT_TODAY' : 'REMINDER',
            emoji,
            title,
            body,
          },
        });

        await prisma.giftOccasionReminder.update({
          where: { id: r.id },
          data: { sentAt: now, delivered },
        });

        if (r.occasion.recurrence !== 'NONE' && r.occasion.eventDate) {
          const nextOcc = getNextOccurrenceDate(r.occasion.eventDate, r.occasion.recurrence);
          if (nextOcc && nextOcc.getTime() > now.getTime()) {
            const nextSched = computeReminderSchedule(nextOcc, 'NONE', r.offsetDays, r.timeOfDay);
            if (nextSched.getTime() > now.getTime()) {
              const nextEpisodeKey = buildReminderEpisodeKey(r.occasionId, r.offsetDays, nextSched);
              try {
                await prisma.giftOccasionReminder.create({
                  data: {
                    occasionId: r.occasionId,
                    ownerUserId: r.ownerUserId,
                    offsetDays: r.offsetDays,
                    timeOfDay: r.timeOfDay,
                    enabled: r.enabled,
                    scheduledFor: nextSched,
                    episodeKey: nextEpisodeKey,
                  },
                });
              } catch (err: unknown) {
                const e = err as { code?: string };
                if (e.code !== 'P2002') throw err;
              }
            }
          }
        }
      }
      if (sent > 0) logger.info({ count: sent }, 'gift-occasion-reminders: sent reminders');
    } catch (err) {
      logger.error({ err }, 'gift-occasion-reminders job failed');
    }
  }, 5 * 60 * 1000);
}
