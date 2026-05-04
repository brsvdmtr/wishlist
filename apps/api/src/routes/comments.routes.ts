// Telegram-auth router for /tg/items/:id/comments* — 4 handlers covering the
// owner/reserver-only comment thread on each item.
//
// Mounted via `tgRouter.use(commentsRouter)` in apps/api/src/index.ts
// alongside the other early P5 sub-routers, AFTER the protectTgRoute(...)
// chain at lines 1547–1548 (POST /items/:id/comments + DELETE
// /items/:id/comments/:commentId) — those `tgRouter.all(...)` middleware
// fire BEFORE sub-router dispatch, so security gates remain in effect.
//
// Same factory pattern as P5a–P5j. Handler bodies are byte-identical to
// their previous in-place definitions in index.ts (lines 4201–4652) — only
// `tgRouter.` -> `commentsRouter.` and indent +2.
//
// Helpers that STAY in index.ts (passed via deps because they have other
// consumers in the monolith):
//   - getItemRole    (line 1313) — also used by GET /tg/items/:id (line
//     ~4181), an out-of-scope core items route.
//   - getOrCreateTgUser / getEffectiveEntitlements / trackEvent /
//     tgActorHash — universal cross-domain helpers.
//
// Pre-existing security gap (NOT addressed in this PR — Wave-2 follow-up):
//   - POST /tg/items/:id/comments/mark-read has no protectTgRoute(...)
//     registration. State-changing (CommentReadCursor upsert) but
//     idempotent by nature — low risk.
//
// Special note — analytics suppression at index.ts:1419
//   `if (status === 403 && route === '/tg/items/:id/comments') return;`
// is in middleware error-tracking and stays in index.ts. The comparison
// uses Express's matched-route pattern, which still resolves to
// '/tg/items/:id/comments' even after the handler moves into this
// sub-router (Express records the full route prefix on req.route).

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '@wishlist/db';
import { t, type Locale } from '@wishlist/shared';

import { asyncHandler } from '../lib/asyncHandler';
import { zodError } from '../lib/http';
import { getRequestLocale } from '../lib/locale';
import { secureCompare } from '../lib/crypto';
import { escapeTgHtml } from '../telegram/html';
import { buildCommentReplyDeepLink } from '../telegram/deepLinks';
import { queueCommentNotification, queueReplyAuthorNotification } from '../notifications/commentNotificationQueue';
import logger from '../logger';

// Shape of the Telegram initData user object — duplicated from index.ts to
// avoid coupling routes/* to a non-exported local type. Structurally
// equivalent to `TelegramUser` at index.ts:333.
type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

// Minimal structural shape of the User row that mark-read reads.
type CommentsUser = {
  id: string;
};

// Structural shape of getEffectiveEntitlements return that POST /comments
// reads (`.plan.features`, `.plan.code`).
type CommentsEntitlements = {
  plan: { code: string; features: readonly string[] };
};

// Mirror of index.ts:1313 getItemRole return shape — kept structural so the
// dep contract here doesn't drag the full prisma Item type.
type ItemRole = 'owner' | 'reserver' | 'third_party';

type GetItemRoleResult = {
  role: ItemRole;
  item: {
    id: string;
    status: string;
    reservationEpoch: number;
    reserverUserId: string | null;
    title: string;
    wishlist: { ownerId: string };
    reservationEvents: { actorHash: string; comment: string | null }[];
  };
  actorHash: string;
  user: { id: string; telegramChatId: string | null };
};

export type CommentsRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<CommentsUser>;
  getEffectiveEntitlements: (userId: string, godMode?: boolean) => Promise<CommentsEntitlements>;
  getItemRole: (itemId: string, tgUser: TelegramUserShape) => Promise<GetItemRoleResult | null>;
  trackEvent: (event: string, userId?: string, props?: Record<string, unknown>) => void;
  tgActorHash: (telegramId: number) => string;
};

export function registerCommentsRouter(deps: CommentsRouterDeps): Router {
  const {
    getOrCreateTgUser,
    getEffectiveEntitlements,
    getItemRole,
    trackEvent,
    tgActorHash,
  } = deps;

  const commentsRouter = Router();

  // GET /tg/items/:id/comments — list comments (owner/reserver only)
  commentsRouter.get(
    '/items/:id/comments',
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      if (!id) return res.status(400).json({ error: 'Missing item id' });

      const ctx = await getItemRole(id, req.tgUser!);
      if (!ctx) return res.status(404).json({ error: 'Item not found' });
      if (ctx.role === 'third_party') return res.status(403).json({ error: 'Forbidden' });

      const comments = await prisma.comment.findMany({
        where: { itemId: id },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, type: true, authorActorHash: true, authorDisplayName: true,
          text: true, reservationEpoch: true, createdAt: true,
          parentCommentId: true, scheduledDeleteAt: true,
        },
      });

      // Build parent-preview map. We look up parents among the same item's comments (cheap — already loaded).
      // For reserver viewing a parent from an older reservation epoch, we hide text/name but still mark it present.
      const byId = new Map(comments.map(c => [c.id, c]));
      const PARENT_PREVIEW_TEXT_MAX = 120;

      // For reserver: anonymize previous epoch comments
      const locale = getRequestLocale(req);
      const mapped = comments.map((c) => {
        let parentPreview: null | {
          id: string;
          text: string;
          authorDisplayName: string | null;
          deleted: boolean;
        } = null;

        if (c.parentCommentId) {
          const parent = byId.get(c.parentCommentId);
          if (!parent) {
            // fk was SET NULL elsewhere or parent not in this item — treat as missing
            parentPreview = { id: c.parentCommentId, text: '', authorDisplayName: null, deleted: true };
          } else {
            // internal reason classification — not exposed to client but drives the flag
            let unavailableReason: null | 'missing' | 'ttl_hidden' | 'epoch_hidden' = null;
            if (parent.scheduledDeleteAt) unavailableReason = 'ttl_hidden';
            else if (
              ctx.role === 'reserver' &&
              parent.type === 'USER' &&
              parent.reservationEpoch < ctx.item.reservationEpoch &&
              parent.authorActorHash !== ctx.actorHash
            ) {
              unavailableReason = 'epoch_hidden';
            }

            if (unavailableReason) {
              parentPreview = { id: parent.id, text: '', authorDisplayName: null, deleted: true };
            } else {
              const truncated = parent.text.length > PARENT_PREVIEW_TEXT_MAX
                ? parent.text.slice(0, PARENT_PREVIEW_TEXT_MAX - 1) + '…'
                : parent.text;
              parentPreview = {
                id: parent.id,
                text: truncated,
                authorDisplayName: parent.authorDisplayName ?? null,
                deleted: false,
              };
            }
          }
        }

        const base = {
          id: c.id,
          type: c.type,
          authorActorHash: c.authorActorHash,
          authorDisplayName: c.authorDisplayName,
          text: c.text,
          reservationEpoch: c.reservationEpoch,
          createdAt: c.createdAt.toISOString(),
          parentCommentId: c.parentCommentId,
          parentPreview,
        };

        if (
          ctx.role === 'reserver' &&
          c.type === 'USER' &&
          c.reservationEpoch < ctx.item.reservationEpoch &&
          c.authorActorHash !== ctx.actorHash
        ) {
          return { ...base, authorDisplayName: t('comments_anon', locale) };
        }
        return base;
      });

      return res.json({ comments: mapped, role: ctx.role });
    }),
  );

  // POST /tg/items/:id/comments — create comment (owner/reserver only)
  commentsRouter.post(
    '/items/:id/comments',
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      if (!id) return res.status(400).json({ error: 'Missing item id' });

      const ctx = await getItemRole(id, req.tgUser!);
      if (!ctx) return res.status(404).json({ error: 'Item not found' });
      if (ctx.role === 'third_party') return res.status(403).json({ error: 'Forbidden' });

      // Feature gate: comments require PRO — allowed if either owner or commenter has it.
      // Use getEffectiveEntitlements so god-mode is honoured (auto-resolves from DB).
      const ownerEnt = await getEffectiveEntitlements(ctx.item.wishlist.ownerId);
      const commenterEnt = ctx.role === 'owner' ? ownerEnt : await getEffectiveEntitlements(ctx.user.id);
      if (!ownerEnt.plan.features.includes('comments') && !commenterEnt.plan.features.includes('comments')) {
        trackEvent('feature_gate_hit_comments', ctx.user.id);
        return res.status(402).json({ error: 'Pro feature', feature: 'comments', planCode: commenterEnt.plan.code });
      }

      // Check wishlist commentPolicy (subscribers-only restriction)
      if (ctx.role !== 'owner') {
        const itemWishlist = await prisma.item.findUnique({
          where: { id },
          select: { wishlist: { select: { id: true, commentPolicy: true } } },
        });
        if (itemWishlist?.wishlist.commentPolicy === 'SUBSCRIBERS') {
          const isSub = await prisma.wishlistSubscription.findFirst({
            where: { wishlistId: itemWishlist.wishlist.id, subscriberId: ctx.user.id },
            select: { id: true },
          });
          if (!isSub) {
            return res.status(403).json({ error: 'comments_restricted' });
          }
        }
      }

      // Reject archived items
      if (ctx.item.status === 'COMPLETED' || ctx.item.status === 'DELETED') {
        const locale = getRequestLocale(req);
        return res.status(400).json({ error: t('api_comment_archived', locale) });
      }

      // Validate text + optional parentCommentId
      const parsed = z.object({
        text: z.string().min(1).max(300),
        parentCommentId: z.string().cuid().optional(),
      }).safeParse(req.body);
      if (!parsed.success) return zodError(res, parsed.error);
      const text = parsed.data.text.trim();
      if (!text) {
        const locale = getRequestLocale(req);
        return res.status(400).json({ error: t('api_comment_empty', locale) });
      }

      // Reject emoji/dots only
      const stripped = text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}\s.…]+/gu, '');
      if (stripped.length === 0) {
        const locale = getRequestLocale(req);
        return res.status(400).json({ error: t('api_comment_meaningful', locale) });
      }

      // Validate parentCommentId (strict — no silent normalization)
      let parent: { id: string; itemId: string; type: 'USER' | 'SYSTEM'; parentCommentId: string | null; authorActorHash: string | null; scheduledDeleteAt: Date | null } | null = null;
      if (parsed.data.parentCommentId) {
        parent = await prisma.comment.findUnique({
          where: { id: parsed.data.parentCommentId },
          select: { id: true, itemId: true, type: true, parentCommentId: true, authorActorHash: true, scheduledDeleteAt: true },
        });
        if (!parent) {
          return res.status(404).json({ error: 'parent_not_found' });
        }
        if (parent.itemId !== id) {
          return res.status(400).json({ error: 'parent_item_mismatch' });
        }
        if (parent.type !== 'USER') {
          return res.status(400).json({ error: 'parent_not_user_comment' });
        }
        if (parent.parentCommentId !== null) {
          // One-level reply only — no silent upgrade. UI should target upstream parent itself.
          return res.status(400).json({ error: 'parent_is_reply' });
        }
        if (parent.scheduledDeleteAt) {
          return res.status(400).json({ error: 'parent_unavailable' });
        }
      }

      // Anti-spam checks
      const now = Date.now();

      // 1. Cooldown 10s
      const lastComment = await prisma.comment.findFirst({
        where: { itemId: id, authorActorHash: ctx.actorHash, type: 'USER' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, text: true },
      });
      if (lastComment && now - lastComment.createdAt.getTime() < 10_000) {
        return res.status(429).json({ error: t('api_comment_cooldown', getRequestLocale(req)) });
      }

      // 2. Deduplicate
      if (lastComment && lastComment.text === text) {
        return res.status(400).json({ error: t('api_comment_duplicate', getRequestLocale(req)) });
      }

      // 3. Max 3 consecutive without reply
      const recent3 = await prisma.comment.findMany({
        where: { itemId: id, type: 'USER' },
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: { authorActorHash: true },
      });
      if (recent3.length >= 3 && recent3.every((c) => c.authorActorHash === ctx.actorHash)) {
        return res.status(429).json({ error: t('api_comment_wait_reply', getRequestLocale(req)) });
      }

      // 4. Max 10/hour
      const hourAgo = new Date(now - 3600_000);
      const hourCount = await prisma.comment.count({
        where: { itemId: id, authorActorHash: ctx.actorHash, type: 'USER', createdAt: { gte: hourAgo } },
      });
      if (hourCount >= 10) {
        return res.status(429).json({ error: t('api_comment_hour_limit', getRequestLocale(req)) });
      }

      // 5. Max 20/30 days
      const monthAgo = new Date(now - 30 * 86400_000);
      const monthCount = await prisma.comment.count({
        where: { itemId: id, authorActorHash: ctx.actorHash, type: 'USER', createdAt: { gte: monthAgo } },
      });
      if (monthCount >= 20) {
        return res.status(429).json({ error: t('api_comment_month_limit', getRequestLocale(req)) });
      }

      // Determine display name: use reservation display name for reserver, Telegram name for owner
      const displayName = ctx.role === 'reserver'
        ? (ctx.item.reservationEvents[0]?.comment ?? req.tgUser!.first_name)
        : req.tgUser!.first_name;

      const comment = await prisma.comment.create({
        data: {
          itemId: id,
          type: 'USER',
          authorActorHash: ctx.actorHash,
          authorDisplayName: displayName,
          text,
          reservationEpoch: ctx.item.reservationEpoch,
          parentCommentId: parent?.id ?? null,
        },
        select: {
          id: true, type: true, authorActorHash: true, authorDisplayName: true,
          text: true, reservationEpoch: true, createdAt: true,
          parentCommentId: true,
        },
      });

      // Build inline keyboard for the primary comment notification — a "Reply to comment" button
      // that opens the mini app deep-linked to this specific comment with reply mode active.
      const notifLocale: Locale = 'ru'; // notifications to other users default to Russian
      const replyBtnLabel = t('comment_reply_btn', notifLocale);
      const deepLinkUrl = buildCommentReplyDeepLink(id, comment.id);
      const commentReplyMarkup = {
        inline_keyboard: [[{ text: replyBtnLabel, web_app: { url: deepLinkUrl } }]],
      };

      // Notify the other party (recipient of the notification = the one who did NOT write this comment)
      let notifiedRecipientUserId: string | null = null;
      if (ctx.role === 'reserver') {
        // Notify owner
        const owner = await prisma.user.findUnique({
          where: { id: ctx.item.wishlist.ownerId },
          select: { telegramChatId: true, id: true },
        });
        if (owner?.telegramChatId) {
          const key = `${id}:${owner.id}`;
          queueCommentNotification(
            key, owner.telegramChatId, ctx.item.title,
            t('notif_commented_reserver', notifLocale, {
              name: escapeTgHtml(displayName),
              title: escapeTgHtml(ctx.item.title),
              text: escapeTgHtml(text),
            }),
            commentReplyMarkup,
          );
          notifiedRecipientUserId = owner.id;
        }
      } else if (ctx.role === 'owner' && ctx.item.reserverUserId) {
        // Notify reserver
        const reserver = await prisma.user.findUnique({
          where: { id: ctx.item.reserverUserId },
          select: { telegramChatId: true, id: true },
        });
        if (reserver?.telegramChatId) {
          const key = `${id}:${reserver.id}`;
          queueCommentNotification(
            key, reserver.telegramChatId, ctx.item.title,
            t('notif_commented_owner', notifLocale, {
              title: escapeTgHtml(ctx.item.title),
              text: escapeTgHtml(text),
            }),
            commentReplyMarkup,
          );
          notifiedRecipientUserId = reserver.id;
        }
      }
      if (notifiedRecipientUserId) {
        trackEvent('comment_reply_notification_sent', ctx.user.id, {
          itemId: id,
          commentId: comment.id,
          recipientUserId: notifiedRecipientUserId,
          role: ctx.role,
          isReply: parent !== null,
        });
      }

      // ── If this comment is a reply, separately notify the author of the parent comment. ──
      // This is a distinct channel from the "someone commented" notification above — different recipient,
      // different dedupe key, different message. Fire-and-forget.
      if (parent) {
        try {
          // Resolve parent author user: parent.authorActorHash maps to either the owner or the current reserver.
          // We fetch the owner once (needs telegramId to derive their actorHash) and compare.
          let parentAuthorUser: { id: string; telegramChatId: string | null } | null = null;

          const owner = await prisma.user.findUnique({
            where: { id: ctx.item.wishlist.ownerId },
            select: { id: true, telegramChatId: true, telegramId: true },
          });
          const ownerActorHash = owner?.telegramId
            ? tgActorHash(Number(owner.telegramId))
            : null;

          if (ownerActorHash && parent.authorActorHash && secureCompare(ownerActorHash, parent.authorActorHash)) {
            parentAuthorUser = { id: owner!.id, telegramChatId: owner!.telegramChatId };
          } else if (ctx.item.reserverUserId) {
            // Reserver match — only if current reservation is the same actor as the parent comment
            const currentReserverActor = ctx.item.reservationEvents[0]?.actorHash ?? null;
            if (currentReserverActor && parent.authorActorHash && secureCompare(currentReserverActor, parent.authorActorHash)) {
              parentAuthorUser = await prisma.user.findUnique({
                where: { id: ctx.item.reserverUserId },
                select: { id: true, telegramChatId: true },
              });
            }
          }

          if (
            parentAuthorUser &&
            parentAuthorUser.telegramChatId &&
            parentAuthorUser.id !== ctx.user.id // don't self-notify
          ) {
            const replyText = t('notif_comment_reply', notifLocale, {
              title: escapeTgHtml(ctx.item.title),
              ownerName: escapeTgHtml(displayName),
              text: escapeTgHtml(text),
            });
            queueReplyAuthorNotification(
              parent.id,
              parentAuthorUser.id,
              parentAuthorUser.telegramChatId,
              replyText,
              commentReplyMarkup,
            );
            trackEvent('comment_reply_sent_notification_to_author', ctx.user.id, {
              itemId: id,
              parentCommentId: parent.id,
              replyCommentId: comment.id,
              recipientUserId: parentAuthorUser.id,
            });
          } else {
            trackEvent('comment_reply_sent_notification_failed', ctx.user.id, {
              itemId: id,
              parentCommentId: parent.id,
              reason: !parentAuthorUser ? 'author_not_resolved' :
                      !parentAuthorUser.telegramChatId ? 'no_chat_id' :
                      'self_reply',
            });
          }
        } catch (err) {
          // never fail the main POST because of notification side-effects
          logger.warn({ err, parentCommentId: parent.id }, 'reply-author notification failed');
          trackEvent('comment_reply_sent_notification_failed', ctx.user.id, {
            itemId: id,
            parentCommentId: parent.id,
            reason: 'exception',
          });
        }
      }

      return res.status(201).json({ comment: { ...comment, createdAt: comment.createdAt.toISOString(), parentPreview: null } });
    }),
  );

  // DELETE /tg/items/:id/comments/:commentId — delete comment
  commentsRouter.delete(
    '/items/:id/comments/:commentId',
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      const commentId = req.params.commentId ?? '';
      if (!id || !commentId) return res.status(400).json({ error: 'Missing ids' });

      const ctx = await getItemRole(id, req.tgUser!);
      if (!ctx) return res.status(404).json({ error: 'Item not found' });
      if (ctx.role === 'third_party') return res.status(403).json({ error: 'Forbidden' });

      const comment = await prisma.comment.findUnique({
        where: { id: commentId },
        select: { id: true, type: true, authorActorHash: true, itemId: true, parentCommentId: true },
      });
      if (!comment || comment.itemId !== id) return res.status(404).json({ error: 'Comment not found' });

      // System comments cannot be deleted manually
      if (comment.type === 'SYSTEM') return res.status(403).json({ error: t('api_system_cant_delete', getRequestLocale(req)) });

      // Owner can delete any USER comment; reserver can delete only own
      if (ctx.role === 'reserver' && comment.authorActorHash !== ctx.actorHash) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      // If this is a top-level comment with replies, they will be SET NULL'd by FK and become
      // orphan normal comments in the UI. Track this to monitor how often it happens.
      let orphanedRepliesCount = 0;
      if (comment.parentCommentId === null) {
        orphanedRepliesCount = await prisma.comment.count({ where: { parentCommentId: commentId } });
      }

      await prisma.comment.delete({ where: { id: commentId } });
      if (orphanedRepliesCount > 0) {
        trackEvent('comment_deleted_with_replies', ctx.user.id, {
          itemId: id,
          commentId,
          orphanedRepliesCount,
          role: ctx.role,
        });
      }
      return res.json({ ok: true });
    }),
  );

  // POST /tg/items/:id/comments/mark-read — mark comments as read for current user
  commentsRouter.post(
    '/items/:id/comments/mark-read',
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      if (!id) return res.status(400).json({ error: 'Missing item id' });

      const user = await getOrCreateTgUser(req.tgUser!);

      await prisma.commentReadCursor.upsert({
        where: { userId_itemId: { userId: user.id, itemId: id } },
        update: { lastReadAt: new Date() },
        create: { userId: user.id, itemId: id, lastReadAt: new Date() },
      });

      return res.json({ ok: true });
    }),
  );

  return commentsRouter;
}
