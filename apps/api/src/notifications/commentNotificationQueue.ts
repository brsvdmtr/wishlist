// Comment / reply notification queues.
//
// Two debounced queues with separate keyspaces:
//
// 1. queueCommentNotification — per (item, recipient) key.
//    First notification fires immediately (with optional inline keyboard).
//    Subsequent comments within a 30 s window increment a counter; when the
//    timer fires, ONE batch summary message is sent. The batch carries the
//    LATEST reply markup so the user can still tap "Reply" — otherwise
//    2+ comments in 30 s would land without a CTA.
//
// 2. queueReplyAuthorNotification — per (parentCommentId, recipient) key.
//    Pure dedupe: if the same parent receives multiple replies within 30 s,
//    only the first triggers a notification. No batching, no counter — used
//    for "someone replied to your comment" pings to the comment author.
//
// Both queues hold module-level Maps. Node's module cache makes them
// singletons across the API process. Timers are setTimeout-based; entries
// auto-clean themselves when the timer fires.
//
// Notification language: passed in by the caller as `recipientLocale`. The
// caller resolves the recipient's effective locale (manual → live → persisted
// → legacy → 'en') via `resolveLocaleWithSource` and hands it through; this
// queue uses it for the deferred batch-summary text so the immediate and
// follow-up notifications match the recipient's language.

import { t, pluralize, type Locale } from '@wishlist/shared';
import { sendTgBotMessage, sendTgNotification } from '../telegram/botApi';
import { escapeTgHtml } from '../telegram/html';

type PendingEntry = {
  chatId: string;
  itemTitle: string;
  count: number;
  lastReplyMarkup?: Record<string, unknown>;
  recipientLocale: Locale;
  timer: ReturnType<typeof setTimeout>;
};

const pendingNotifications = new Map<string, PendingEntry>();

export function queueCommentNotification(
  key: string,
  chatId: string,
  itemTitle: string,
  text: string,
  recipientLocale: Locale,
  replyMarkup?: Record<string, unknown>,
) {
  const existing = pendingNotifications.get(key);
  if (existing) {
    existing.count++;
    // Refresh CTA to point at the most recent comment (used when batch timer fires)
    if (replyMarkup) existing.lastReplyMarkup = replyMarkup;
    return;
  }

  // Send first notification immediately (with inline keyboard if provided)
  if (replyMarkup) void sendTgBotMessage(chatId, text, replyMarkup);
  else void sendTgNotification(chatId, text);

  const entry: PendingEntry = {
    chatId,
    itemTitle,
    count: 0,
    lastReplyMarkup: replyMarkup,
    recipientLocale,
    timer: setTimeout(() => {
      const e = pendingNotifications.get(key);
      pendingNotifications.delete(key);
      if (!e || e.count === 0) return;
      const word = pluralize(
        e.count,
        t('notif_batch_comments_word_one', e.recipientLocale),
        t('notif_batch_comments_word_few', e.recipientLocale),
        t('notif_batch_comments_word_many', e.recipientLocale),
        e.recipientLocale,
      );
      const batchText = t('notif_batch_comments', e.recipientLocale, {
        count: e.count, word, title: escapeTgHtml(e.itemTitle),
      });
      // Include latest CTA so the user can tap "Reply" from the batch summary too
      if (e.lastReplyMarkup) void sendTgBotMessage(e.chatId, batchText, e.lastReplyMarkup);
      else void sendTgNotification(e.chatId, batchText);
    }, 30_000),
  };
  pendingNotifications.set(key, entry);
}

const pendingReplyNotifications = new Map<string, { timer: ReturnType<typeof setTimeout> }>();

export function queueReplyAuthorNotification(
  parentCommentId: string,
  recipientUserId: string,
  chatId: string,
  text: string,
  replyMarkup: Record<string, unknown>,
) {
  const key = `reply:${parentCommentId}:${recipientUserId}`;
  if (pendingReplyNotifications.has(key)) return; // dedupe within window
  void sendTgBotMessage(chatId, text, replyMarkup);
  const timer = setTimeout(() => { pendingReplyNotifications.delete(key); }, 30_000);
  pendingReplyNotifications.set(key, { timer });
}
