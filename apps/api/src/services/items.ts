// Items domain (P5s-6 — extracted from apps/api/src/index.ts).
//
// 9 identifiers + 1 internal type that drive item-level CRUD, mappers,
// hints cancellation, and subscriber notifications. Bodies byte-identical
// to their previous in-place definitions in index.ts.
//
// Strategy A: source moves here; routes continue receiving these via the
// existing factory `deps` contracts in `routes/items.routes.ts`,
// `routes/wishlists.routes.ts`, `routes/reservations.routes.ts`,
// `routes/comments.routes.ts`, `routes/santa.routes.ts`,
// `routes/selections-archive.routes.ts`, `routes/onboarding.routes.ts`,
// `routes/public.routes.ts`, and `routes/me.routes.ts` — signatures
// unchanged. Index.ts imports from here and continues passing through
// the factory deps.
//
// Internal coupling kept inside the module:
//   - `mapTgItem` calls `priorityToNum` (private to this file).
//   - `getItemRole` calls `getOrCreateTgUser` and `tgActorHash` (both
//     already in `./telegram-auth`).
//   - `notifySubscribersOfChange` uses `sendTgBotMessage` /
//     `sendTgNotification` from `../telegram/botApi` and `t` from
//     `@wishlist/shared`.

import { prisma } from '@wishlist/db';
import { t, type Locale } from '@wishlist/shared';

import logger from '../logger';
import { secureCompare } from '../lib/crypto';
import { sendTgBotMessage, sendTgNotification } from '../telegram/botApi';
import { getOrCreateTgUser, tgActorHash, type TelegramUser } from './telegram-auth';

// ─── Status tuple shared with multiple route handlers ────────────────────────
export const ACTIVE_STATUSES = ['AVAILABLE', 'RESERVED', 'PURCHASED'] as const;

// ─── Hints lifecycle ─────────────────────────────────────────────────────────

/** Cancel all active hints for an item (called when item leaves AVAILABLE state). */
export async function cancelItemHints(itemId: string): Promise<void> {
  try {
    await prisma.hint.updateMany({
      where: { itemId, status: { in: ['SENT', 'DELIVERED'] } },
      data: { status: 'CANCELLED' },
    });
  } catch { /* best-effort */ }
}

// ─── Subscribers fan-out ─────────────────────────────────────────────────────

/**
 * Record unread changes for subscribers of a wishlist and send Telegram notifications.
 * Fire-and-forget — never throws.
 *
 * For item_added / item_updated events we attach an inline-keyboard button that
 * deep-links into the Mini App at the specific item via the existing
 * `<slug>__item_<itemId>` startapp format (parsed in MiniApp.tsx bootstrap).
 * Wishlist-only updates currently ship without a button — no slug-only handler
 * in the bootstrap parser yet.
 */
export async function notifySubscribersOfChange(
  wishlistId: string,
  entityId: string,
  changedFields: string[],
  eventType: 'item_added' | 'item_updated' | 'wishlist_updated',
  meta: { itemTitle?: string; wishlistTitle?: string; ownerName?: string },
): Promise<void> {
  try {
    const subs = await prisma.wishlistSubscription.findMany({
      where: { wishlistId },
      select: { id: true, subscriber: { select: { id: true, telegramChatId: true } } },
    });
    if (subs.length === 0) return;

    // Resolve the wishlist slug once for deep-link construction (item events only).
    const isItemEvent = eventType === 'item_added' || eventType === 'item_updated';
    let deepLinkUrl: string | null = null;
    if (isItemEvent) {
      const wl = await prisma.wishlist.findUnique({ where: { id: wishlistId }, select: { slug: true } });
      if (wl?.slug) {
        const miniAppUrl = process.env.MINI_APP_URL ?? (process.env.WEB_ORIGIN ? `${process.env.WEB_ORIGIN}/miniapp` : 'https://wishlistik.ru/miniapp');
        deepLinkUrl = `${miniAppUrl}?startapp=${encodeURIComponent(wl.slug)}__item_${encodeURIComponent(entityId)}`;
      }
    }

    const notifLocale: Locale = 'ru';
    await Promise.all(
      subs.map(async (sub) => {
        // Upsert unread markers
        await Promise.all(
          changedFields.map((field) =>
            prisma.subscriptionUnread.upsert({
              where: { subId_entityId_fieldName: { subId: sub.id, entityId, fieldName: field } },
              update: {},
              create: { subId: sub.id, entityId, fieldName: field },
            }),
          ),
        );

        // Send Telegram notification
        const chatId = sub.subscriber.telegramChatId;
        if (!chatId) return;

        let text = '';
        if (eventType === 'item_added') {
          text = t('sub_notification_new_item', notifLocale, {
            owner: meta.ownerName ?? '…',
            title: meta.itemTitle ?? '…',
            wishlist: meta.wishlistTitle ?? '…',
          });
        } else if (eventType === 'item_updated') {
          text = t('sub_notification_updated', notifLocale, {
            title: meta.itemTitle ?? '…',
            wishlist: meta.wishlistTitle ?? '…',
          });
        } else {
          text = t('sub_notification_wishlist_updated', notifLocale, {
            title: meta.wishlistTitle ?? '…',
          });
        }

        if (deepLinkUrl) {
          // Use sendTgBotMessage (supports reply_markup) instead of sendTgNotification.
          // Button text "🎁 Перейти к желанию" — same RU-only stance as the message text.
          void sendTgBotMessage(chatId, text, {
            inline_keyboard: [[{ text: '🎁 Перейти к желанию', web_app: { url: deepLinkUrl } }]],
          });
        } else {
          void sendTgNotification(chatId, text);
        }
      }),
    );
  } catch (err) {
    logger.error({ err }, 'notifySubscribersOfChange error');
  }
}

// ─── Placement helpers ──────────────────────────────────────────────────────

/**
 * Count how many wishlists an item is currently placed in.
 * Used to render "🔗 В N" badges and to guard the "remove last placement" flow.
 */
export async function countItemPlacements(itemId: string): Promise<number> {
  return prisma.wishlistItemPlacement.count({ where: { itemId } });
}

// ─── Pure mappers / parsers ─────────────────────────────────────────────────

/** Extract numeric price from formatted string like "51 975 ₽" → "51975" */
export function extractNumericPrice(priceText: string | null): string | null {
  if (!priceText) return null;
  // Remove currency symbols, spaces, non-breaking spaces
  const digits = priceText.replace(/[^\d.,]/g, '').replace(',', '.');
  if (!digits) return null;
  const num = parseFloat(digits);
  return isNaN(num) ? null : String(num);
}

export function priorityToNum(p: 'LOW' | 'MEDIUM' | 'HIGH'): 1 | 2 | 3 {
  return p === 'LOW' ? 1 : p === 'HIGH' ? 3 : 2;
}
export function numToPriority(n: number): 'LOW' | 'MEDIUM' | 'HIGH' {
  return n === 1 ? 'LOW' : n === 3 ? 'HIGH' : 'MEDIUM';
}

export function mapTgItem(item: {
  id: string;
  wishlistId: string;
  title: string;
  url: string;
  priceText: string | null;
  currency?: string;
  imageUrl?: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  position?: number;
  status: string;
  description?: string | null;
  sourceUrl?: string | null;
  sourceDomain?: string | null;
  importMethod?: string | null;
}) {
  return {
    id: item.id,
    wishlistId: item.wishlistId,
    title: item.title,
    url: item.url || null,
    price: item.priceText ? (Number(item.priceText) || null) : null,
    currency: item.currency ?? null,
    imageUrl: item.imageUrl ?? null,
    priority: priorityToNum(item.priority),
    position: item.position ?? 0,
    status: item.status.toLowerCase(),
    description: item.description ?? null,
    sourceUrl: item.sourceUrl ?? null,
    sourceDomain: item.sourceDomain ?? null,
    importMethod: item.importMethod ?? null,
  };
}

// ─── Item role resolution ───────────────────────────────────────────────────

export type ItemRole = 'owner' | 'reserver' | 'third_party';

export async function getItemRole(
  itemId: string,
  tgUser: TelegramUser,
): Promise<{
  role: ItemRole;
  item: { id: string; status: string; reservationEpoch: number; reserverUserId: string | null; title: string; wishlist: { ownerId: string }; reservationEvents: { actorHash: string; comment: string | null }[] };
  actorHash: string;
  user: { id: string; telegramChatId: string | null };
} | null> {
  const actorHash = tgActorHash(tgUser.id);
  const user = await getOrCreateTgUser(tgUser);

  const item = await prisma.item.findUnique({
    where: { id: itemId },
    select: {
      id: true, status: true, reservationEpoch: true, reserverUserId: true, title: true,
      wishlist: { select: { ownerId: true } },
      reservationEvents: {
        where: { type: 'RESERVED' },
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { actorHash: true, comment: true },
      },
    },
  });
  if (!item) return null;

  if (item.wishlist.ownerId === user.id) {
    return { role: 'owner', item, actorHash, user };
  }

  if (
    item.status === 'RESERVED' &&
    item.reservationEvents.length > 0 &&
    secureCompare(item.reservationEvents[0]!.actorHash, actorHash)
  ) {
    return { role: 'reserver', item, actorHash, user };
  }

  return { role: 'third_party', item, actorHash, user };
}
