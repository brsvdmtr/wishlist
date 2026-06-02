// P0.3 «Событийные пуши» scheduler.
//
// Two cron loops driving services/event-notifications.ts:
//   • flush (every 60s) — group due outbox rows, apply opt-out / mute / quiet
//     hours / daily cap, send one Telegram message per bucket.
//   • upcoming scan (hourly + a 30s startup kick) — enqueue EVENT_UPCOMING rows
//     for circle co-members whose birthday is 7 / 3 days out (year-keyed dedupe,
//     so it fires once per threshold regardless of how often the scan runs).
//
// Best-effort: errors are logged but never bubble out of setInterval; the next
// cycle re-attempts. The kill switch (EVENT_NOTIFICATIONS_ENABLED=false) is
// enforced inside the service, so toggling it stops both enqueue and flush
// without a redeploy.

import type { Logger } from 'pino';
import {
  flushDueEventNotifications,
  scanUpcomingEvents,
  purgeOldEventNotifications,
} from '../services/event-notifications';
import { trackProductEvent } from '../services/analytics';

export type EventNotificationsSchedulerDeps = {
  logger: Logger;
  sendTgBotMessage: (chatId: string, text: string, replyMarkup?: Record<string, unknown>) => Promise<boolean>;
  BOT_TOKEN_FOR_DM: string;
};

const FLUSH_INTERVAL_MS = 60 * 1000;
const SCAN_INTERVAL_MS = 60 * 60 * 1000;
const SCAN_STARTUP_DELAY_MS = 30 * 1000;
const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function startEventNotificationsScheduler(deps: EventNotificationsSchedulerDeps): void {
  const { logger, sendTgBotMessage, BOT_TOKEN_FOR_DM } = deps;

  // ─── Flush due grouping buckets (every minute) ──────────────────────────────
  // Re-entrancy guard: a single flush tick can run for tens of seconds (each
  // grouped send is a Telegram round-trip), so without this two `setInterval`
  // ticks could overlap and double-send. The atomic PENDING→SENDING claim in
  // the service is the second line of defence (and the multi-instance story).
  let flushing = false;
  setInterval(async () => {
    if (!BOT_TOKEN_FOR_DM || flushing) return;
    flushing = true;
    try {
      const res = await flushDueEventNotifications({
        logger,
        sendTgBotMessage,
        // Per-delivered-message product event. trackProductEvent is
        // fire-and-forget (swallows + debug-logs DB errors), so a flaky
        // AnalyticsEvent write never blocks or fails the flush. userId = the
        // recipient; props carry only the type + grouped flag (no PII).
        trackPushSent: ({ pushType, grouped, recipientId }) =>
          trackProductEvent({ event: 'push.sent', userId: recipientId, props: { pushType, grouped } }),
      });
      if (res.messagesSent > 0 || res.deferred > 0 || res.suppressed > 0) {
        logger.info(res, 'event-notifications: flush cycle');
      }
    } catch (err) {
      logger.error({ err }, 'event-notifications flush job failed');
    } finally {
      flushing = false;
    }
  }, FLUSH_INTERVAL_MS);

  // ─── Upcoming-events scan (hourly) ──────────────────────────────────────────
  const runScan = async () => {
    try {
      const res = await scanUpcomingEvents();
      if (res.enqueued > 0) logger.info({ enqueued: res.enqueued }, 'event-notifications: upcoming scan');
    } catch (err) {
      logger.error({ err }, 'event-notifications upcoming-scan job failed');
    }
  };
  setInterval(runScan, SCAN_INTERVAL_MS);
  // Startup kick so a deploy doesn't wait up to an hour for the first scan.
  setTimeout(runScan, SCAN_STARTUP_DELAY_MS);

  // ─── Retention purge (daily) ────────────────────────────────────────────────
  setInterval(async () => {
    try {
      const deleted = await purgeOldEventNotifications();
      if (deleted > 0) logger.info({ deleted }, 'event-notifications: purged old rows');
    } catch (err) {
      logger.error({ err }, 'event-notifications purge job failed');
    }
  }, PURGE_INTERVAL_MS);
}
