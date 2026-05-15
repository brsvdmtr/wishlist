// Reservation schedulers (P5r-4) — extracted from apps/api/src/index.ts.
// Three independent setInterval jobs split across two exported functions
// so the caller (index.ts) can preserve the original registration order
// (reservation-reminder → events-calendar → smart-res-auto-release →
// smart-res-reminder) by interleaving the events scheduler call between
// `startReservationReminderScheduler` and `startSmartReservationSchedulers`.
//
//   1. reservation reminder (every 15 min) — for ReservationMeta rows
//      whose `reminderAt` has passed and `reminderSent === false`. Sends
//      a Telegram bot message to the reserver, then either cycles to
//      the next scheduled `reminderDates` entry or marks `reminderSent`.
//      Exposed via `startReservationReminderScheduler(deps)`.
//   2. smart-res auto-release (every 5 min) — for ReservationMeta rows
//      where isSmartRes && active && expiresAt <= now: revert Item to
//      AVAILABLE, write UNRESERVED ReservationEvent + SYSTEM auto-
//      released comment (with 30d TTL), notify gifter + owner.
//   3. smart-res reminder (every 15 min) — for active SmartRes rows in
//      the reminder window (lead hours before expiresAt): notify
//      reserver once.
//   Both smart-res jobs exposed via `startSmartReservationSchedulers(deps)`.
//
// Cadences (15-min, 5-min, 15-min) and log labels preserved byte-identical
// for ops continuity. All three jobs are best-effort: errors are logged
// but never bubble out of the setInterval callback; the next cycle
// re-attempts work.

import type { PrismaClient } from '@wishlist/db';
import type { Logger } from 'pino';
import { t, resolveLocaleWithSource } from '@wishlist/shared';
import { buildReservationReminderDeepLink } from '../telegram/deepLinks';
import { profileToLanguageSettings } from '../services/locale';

export type ReservationReminderDeps = {
  prisma: PrismaClient;
  logger: Logger;
  sendTgBotMessage: (chatId: string, text: string, replyMarkup?: Record<string, unknown>) => Promise<boolean>;
};

export type SmartReservationSchedulerDeps = {
  prisma: PrismaClient;
  logger: Logger;
  sendTgNotification: (chatId: string, text: string) => Promise<void>;
  getSmartResLeadHours: (ttlH: number) => number;
  SYSTEM_ACTOR_HASH: string;
};

/**
 * Reservation reminder cron (15-min cadence). First in original
 * registration order — index.ts calls this BEFORE startEventSchedulers
 * to preserve byte-for-byte sequencing.
 */
export function startReservationReminderScheduler(deps: ReservationReminderDeps): void {
  const { prisma, logger, sendTgBotMessage } = deps;

  // ─── Reservation reminder cron (every 15 min) ──────────────────────────────
  setInterval(async () => {
    try {
      const now = new Date();
      const due = await prisma.reservationMeta.findMany({
        where: { reminderAt: { lte: now }, reminderSent: false, active: true },
        take: 50,
        include: {
          item: {
            select: {
              id: true, title: true, priceText: true, currency: true,
              wishlist: {
                select: {
                  owner: {
                    select: {
                      firstName: true,
                      profile: { select: { displayName: true } },
                    },
                  },
                },
              },
            },
          },
        },
      });
      if (due.length === 0) return;

      let sent = 0;
      for (const meta of due) {
        // Recipient = reserver. Resolve their locale from persisted profile
        // fields — proactive cron, no live ctx.from.
        const reserver = await prisma.user.findUnique({
          where: { id: meta.reserverUserId },
          select: {
            telegramChatId: true,
            profile: { select: { languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } },
          },
        });
        if (reserver?.telegramChatId) {
          const { locale, source: localeSource } = resolveLocaleWithSource(
            profileToLanguageSettings(reserver.profile),
          );
          const ownerName = meta.item.wishlist.owner.profile?.displayName ?? meta.item.wishlist.owner.firstName ?? '';
          const bodyKey = meta.item.priceText ? 'notif_res_reminder_body_with_price' : 'notif_res_reminder_body';
          const bodyParams: Record<string, string> = { title: meta.item.title };
          if (meta.item.priceText) bodyParams.price = meta.item.priceText;
          let text = `${t('notif_res_reminder_header', locale)}\n\n${t(bodyKey, locale, bodyParams)}`;
          text += `\n${t('notif_res_reminder_from', locale, { owner: ownerName })}`;
          if (meta.note) text += `\n\n${t('notif_res_reminder_note', locale, { note: meta.note })}`;
          await sendTgBotMessage(reserver.telegramChatId, text, {
            inline_keyboard: [[
              { text: t('notif_res_reminder_btn_open', locale), url: buildReservationReminderDeepLink(meta.item.id, meta.id) },
              { text: t('notif_res_reminder_btn_purchased', locale), callback_data: `res_purchased:${meta.item.id}` },
            ]],
          });
          logger.debug({ metaId: meta.id, locale, localeSource }, 'reservation-reminder sent');
          sent++;
        }

        // Cycle to the next reminder date if there are more scheduled
        const allDates = (meta.reminderDates as string[] | null) ?? [];
        const firedTs = meta.reminderAt?.getTime() ?? 0;
        const remaining = allDates.filter(d => {
          const ts = new Date(d).getTime();
          return ts !== firedTs && ts > now.getTime();
        });
        remaining.sort();

        if (remaining.length > 0) {
          // Set reminderAt to the next nearest date, keep cycling
          await prisma.reservationMeta.update({
            where: { id: meta.id },
            data: { reminderAt: new Date(remaining[0]!), reminderSent: false, reminderDates: remaining },
          });
        } else {
          // All reminders fired — mark as sent, clear dates
          await prisma.reservationMeta.update({
            where: { id: meta.id },
            data: { reminderSent: true, reminderDates: [] },
          });
        }
      }
      if (sent > 0) logger.info({ count: sent }, 'reservation-reminders: sent reminders');
    } catch (err) {
      logger.error({ err }, 'reservation-reminders job failed');
    }
  }, 15 * 60 * 1000); // every 15 minutes
}

/**
 * Smart-res auto-release (5-min cadence) + smart-res reminder (15-min
 * cadence). Registered AFTER startEventSchedulers in index.ts to
 * preserve the original ordering — these were positions 3 and 4 in the
 * pre-extraction sequence (events-calendar was position 2).
 */
export function startSmartReservationSchedulers(deps: SmartReservationSchedulerDeps): void {
  const { prisma, logger, sendTgNotification, getSmartResLeadHours, SYSTEM_ACTOR_HASH } = deps;

  // ─── Smart Reservations: auto-release cron (every 5 min) ─────────────────────
  setInterval(async () => {
    try {
      const now = new Date();
      const expiredMetas = await prisma.reservationMeta.findMany({
        where: { isSmartRes: true, active: true, expiresAt: { lte: now } },
        take: 50,
        include: {
          item: {
            select: {
              id: true, title: true, status: true, reserverUserId: true, reservationEpoch: true,
              wishlist: {
                select: {
                  ownerId: true,
                  owner: {
                    select: {
                      telegramChatId: true,
                      profile: { select: { languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } },
                    },
                  },
                },
              },
            },
          },
        },
      });
      for (const meta of expiredMetas) {
        try {
          if (!meta.active) continue;
          // Repair: inconsistent state — item not RESERVED but meta still active
          if (meta.item.status !== 'RESERVED') {
            console.warn('Smart res auto-release: inconsistent state', { metaId: meta.id, itemId: meta.item.id, itemStatus: meta.item.status });
            await prisma.reservationMeta.update({
              where: { id: meta.id },
              data: { active: false, endedAt: now, endReason: 'inconsistent_state' },
            });
            continue;
          }
          // Guard: reservation belongs to someone else now
          if (meta.item.reserverUserId !== meta.reserverUserId) continue;

          await prisma.$transaction(async (tx) => {
            await tx.item.update({ where: { id: meta.item.id }, data: { status: 'AVAILABLE', reserverUserId: null } });
            await tx.reservationEvent.create({
              data: { itemId: meta.item.id, type: 'UNRESERVED', actorHash: SYSTEM_ACTOR_HASH, comment: 'auto_released' },
            });
            // SYSTEM comment text is persisted (not lazily rendered), so a single
            // locale at write-time is rendered identically to every later viewer.
            // 'ru' is the project's canonical persisted-text locale. Out of scope
            // for the 2026-05-10 send-locale resolver wave — proper fix is to
            // store {key, params} and render at read-time per viewer locale.
            await tx.comment.create({
              data: { itemId: meta.item.id, type: 'SYSTEM', text: t('api_system_auto_released', 'ru'), reservationEpoch: meta.item.reservationEpoch },
            });
            const ttl = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
            await tx.comment.updateMany({
              where: { itemId: meta.item.id, scheduledDeleteAt: null },
              data: { scheduledDeleteAt: ttl },
            });
            await tx.reservationMeta.update({
              where: { id: meta.id },
              data: { active: false, endedAt: now, endReason: 'auto_released' },
            });
          });

          // Notify gifter (= reserver). Per-recipient locale from persisted profile.
          const reserver = await prisma.user.findUnique({
            where: { id: meta.reserverUserId },
            select: {
              telegramChatId: true,
              profile: { select: { languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } },
            },
          });
          if (reserver?.telegramChatId) {
            const { locale: gifterLocale } = resolveLocaleWithSource(
              profileToLanguageSettings(reserver.profile),
            );
            void sendTgNotification(reserver.telegramChatId, t('notif_smart_res_auto_released_gifter', gifterLocale, { title: meta.item.title }));
          }
          // Notify owner. Owner's profile preloaded above with the wishlist
          // include — no extra round-trip.
          const ownerChatId = meta.item.wishlist.owner.telegramChatId;
          if (ownerChatId) {
            const { locale: ownerLocale } = resolveLocaleWithSource(
              profileToLanguageSettings(meta.item.wishlist.owner.profile),
            );
            void sendTgNotification(ownerChatId, t('notif_smart_res_auto_released_owner', ownerLocale, { title: meta.item.title }));
          }
          logger.info({ metaId: meta.id, itemId: meta.item.id }, 'smart-res: auto-released');
        } catch (err) {
          logger.error({ err, metaId: meta.id }, 'smart-res: auto-release item failed');
        }
      }
    } catch (err) {
      logger.error({ err }, 'smart-res: auto-release cron failed');
    }
  }, 5 * 60 * 1000);

  // ─── Smart Reservations: reminder cron (every 15 min) ────────────────────────
  setInterval(async () => {
    try {
      const now = new Date();
      const candidates = await prisma.reservationMeta.findMany({
        where: { isSmartRes: true, active: true, reminderSent: false, expiresAt: { not: null, gt: now } },
        take: 50,
        include: {
          item: { select: { id: true, title: true } },
        },
      });
      for (const meta of candidates) {
        try {
          if (!meta.expiresAt) continue;
          const leadH = getSmartResLeadHours(meta.smartResTtlHours ?? 72);
          const windowStart = meta.expiresAt.getTime() - leadH * 3600000;
          if (now.getTime() < windowStart) continue; // not in reminder window yet

          const reserver = await prisma.user.findUnique({
            where: { id: meta.reserverUserId },
            select: {
              telegramChatId: true,
              profile: { select: { languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } },
            },
          });
          if (!reserver?.telegramChatId) {
            // No chat ID — mark as sent to avoid retrying
            await prisma.reservationMeta.update({ where: { id: meta.id }, data: { reminderSent: true } });
            continue;
          }
          const { locale, source: localeSource } = resolveLocaleWithSource(
            profileToLanguageSettings(reserver.profile),
          );
          const hoursLeft = Math.max(1, Math.round((meta.expiresAt.getTime() - now.getTime()) / 3600000));
          const delivered = await sendTgNotification(reserver.telegramChatId, t('notif_smart_res_expiring', locale, { title: meta.item.title, hours: String(hoursLeft) }))
            .then(() => true).catch(() => false);
          logger.debug({ metaId: meta.id, locale, localeSource, delivered }, 'smart-res: reminder attempt');
          if (delivered) {
            await prisma.reservationMeta.update({ where: { id: meta.id }, data: { reminderSent: true } });
            logger.info({ metaId: meta.id, itemId: meta.item.id }, 'smart-res: reminder sent');
          }
          // On failure: leave reminderSent=false, cron retries next tick
        } catch (err) {
          logger.error({ err, metaId: meta.id }, 'smart-res: reminder item failed');
        }
      }
    } catch (err) {
      logger.error({ err }, 'smart-res: reminder cron failed');
    }
  }, 15 * 60 * 1000);
}
