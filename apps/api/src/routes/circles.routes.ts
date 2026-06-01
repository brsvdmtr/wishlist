// Circles (Близкие) — P0.1 router.
//
// Mounted via `tgRouter.use(circlesRouter)` in apps/api/src/index.ts. Security
// (rate-limit + idempotency) is registered there via protectTgRoute(...), same
// as every other domain. Handlers stay thin: validate, call
// services/circles.service.ts, shape the response. State transitions and the
// surprise invariant live in the service, never here.

import { Router, type Response } from 'express';

import { prisma } from '@wishlist/db';
import { t, resolveLocaleWithSource } from '@wishlist/shared';

import { asyncHandler } from '../lib/asyncHandler';
import { sendTgBotMessage } from '../telegram/botApi';
import { escapeTgHtml } from '../telegram/html';
import { buildCircleShareLink } from '../telegram/deepLinks';
import { buildOpenCircleKeyboard } from '../notifications/openCircleKeyboard';
import { profileToLanguageSettings } from '../services/locale';
import { sendPaywall, makePlanLimitReached } from '../services/paywall';
import { trackEvent } from '../services/analytics';
import * as circles from '../services/circles.service';
import { CircleError } from '../services/circles.service';

type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type CirclesRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<{ id: string }>;
};

// Map a CircleError to an HTTP response. `circle_capacity_reached` (owner hit
// the FREE limit while inviting, AC#5) becomes a 402 paywall so the Mini App
// shows the upgrade sheet; everything else is a plain status+code envelope.
function handleCircleError(e: unknown, res: Response): boolean {
  if (!(e instanceof CircleError)) return false;
  if (e.code === 'circle_capacity_reached') {
    sendPaywall(
      res,
      402,
      makePlanLimitReached('circle_participants', {
        limit: Number(e.meta?.capacity ?? 0),
        current: Number(e.meta?.current ?? 0),
        context: 'participant_limit',
      }),
    );
    return true;
  }
  res.status(e.httpStatus).json({ error: e.code, ...(e.meta ? { meta: e.meta } : {}) });
  return true;
}

async function runCircle(res: Response, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (!handleCircleError(e, res)) throw e;
  }
}

function requireParam(value: string | undefined): string {
  const v = (value ?? '').trim();
  if (!v) throw new CircleError('bad_request', 400);
  return v;
}

export function registerCirclesRouter(deps: CirclesRouterDeps): Router {
  const { getOrCreateTgUser } = deps;
  const router = Router();

  // POST /tg/circles — create a circle (caller becomes OWNER)
  router.post(
    '/circles',
    asyncHandler(async (req, res) =>
      runCircle(res, async () => {
        const user = await getOrCreateTgUser(req.tgUser!);
        const body = (req.body ?? {}) as { name?: unknown; type?: unknown; emoji?: unknown };
        const circle = await circles.createCircle({
          ownerId: user.id,
          name: body.name,
          type: body.type,
          emoji: body.emoji,
        });
        trackEvent('circle.created', user.id, { circleId: circle.id, type: circle.type });
        res.json({ circle });
      }),
    ),
  );

  // GET /tg/circles — my circles (active memberships), nearest-event preview
  router.get(
    '/circles',
    asyncHandler(async (req, res) =>
      runCircle(res, async () => {
        const user = await getOrCreateTgUser(req.tgUser!);
        const list = await circles.listMyCircles(user.id);
        res.json({ circles: list });
      }),
    ),
  );

  // GET /tg/circles/invite/:token — preview before joining (frame C1).
  // Registered before /circles/:id; distinct segment count, but explicit order
  // keeps intent obvious.
  router.get(
    '/circles/invite/:token',
    asyncHandler(async (req, res) =>
      runCircle(res, async () => {
        const user = await getOrCreateTgUser(req.tgUser!);
        const token = requireParam(req.params.token);
        const preview = await circles.getInvitePreview({ token, viewerId: user.id });
        res.json({ preview });
      }),
    ),
  );

  // POST /tg/circles/join — join via invite token (idempotent), notify owner
  router.post(
    '/circles/join',
    asyncHandler(async (req, res) =>
      runCircle(res, async () => {
        const user = await getOrCreateTgUser(req.tgUser!);
        const token = requireParam((req.body ?? {}).token);
        const result = await circles.joinByToken({ token, userId: user.id });

        if (result.isNew && user.id !== result.circle.ownerId) {
          trackEvent('circle.joined', user.id, { circleId: result.circle.id, role: 'MEMBER', via: 'deeplink' });
          // Notify the owner (explicit relationship — allowed). Recipient is the
          // owner, so resolve THEIR locale from their persisted profile.
          const owner = await prisma.user.findUnique({
            where: { id: result.circle.ownerId },
            select: {
              telegramChatId: true,
              profile: { select: { languageMode: true, manualLanguage: true, normalizedLocale: true, language: true } },
            },
          });
          if (owner?.telegramChatId) {
            const { locale: notifLocale } = resolveLocaleWithSource(profileToLanguageSettings(owner.profile));
            const joinerName = escapeTgHtml(req.tgUser?.first_name?.trim() || t('api_user_fallback', notifLocale));
            void sendTgBotMessage(
              owner.telegramChatId,
              t('circle_join_notif', notifLocale, { name: joinerName, circle: escapeTgHtml(result.circle.name) }),
              buildOpenCircleKeyboard(token, notifLocale),
            ).catch(() => {});
          }
        }

        res.json({ circle: result.circle, isNew: result.isNew, alreadyMember: result.alreadyMember });
      }),
    ),
  );

  // POST /tg/circles/:id/invite — get/create the shareable invite link.
  // Capacity-gated: at the FREE limit this throws → 402 paywall (AC#5).
  router.post(
    '/circles/:id/invite',
    asyncHandler(async (req, res) =>
      runCircle(res, async () => {
        const user = await getOrCreateTgUser(req.tgUser!);
        const circleId = requireParam(req.params.id);
        const invite = await circles.getOrCreateActiveInvite({ circleId, actorId: user.id });
        res.json({
          token: invite.token,
          link: buildCircleShareLink(invite.token),
          memberCount: invite.memberCount,
          capacity: invite.capacity,
          expiresAt: invite.expiresAt?.toISOString() ?? null,
        });
      }),
    ),
  );

  // GET /tg/circles/:id — circle detail (members sorted by nearest event)
  router.get(
    '/circles/:id',
    asyncHandler(async (req, res) =>
      runCircle(res, async () => {
        const user = await getOrCreateTgUser(req.tgUser!);
        const circleId = requireParam(req.params.id);
        const detail = await circles.getCircleDetail({ circleId, viewerId: user.id });
        res.json({ circle: detail });
      }),
    ),
  );

  // POST /tg/circles/:id/leave — leave a circle (owner must delete/transfer)
  router.post(
    '/circles/:id/leave',
    asyncHandler(async (req, res) =>
      runCircle(res, async () => {
        const user = await getOrCreateTgUser(req.tgUser!);
        const circleId = requireParam(req.params.id);
        await circles.leaveCircle({ circleId, userId: user.id });
        trackEvent('circle.left', user.id, { circleId });
        res.json({ ok: true });
      }),
    ),
  );

  // DELETE /tg/circles/:id — delete a circle (owner only)
  router.delete(
    '/circles/:id',
    asyncHandler(async (req, res) =>
      runCircle(res, async () => {
        const user = await getOrCreateTgUser(req.tgUser!);
        const circleId = requireParam(req.params.id);
        await circles.deleteCircle({ circleId, actorId: user.id });
        trackEvent('circle.deleted', user.id, { circleId });
        res.json({ ok: true });
      }),
    ),
  );

  // DELETE /tg/circles/:id/members/:userId — remove a member (owner only)
  router.delete(
    '/circles/:id/members/:userId',
    asyncHandler(async (req, res) =>
      runCircle(res, async () => {
        const user = await getOrCreateTgUser(req.tgUser!);
        const circleId = requireParam(req.params.id);
        const targetUserId = requireParam(req.params.userId);
        await circles.removeMember({ circleId, actorId: user.id, targetUserId });
        trackEvent('circle.member_removed', user.id, { circleId, targetUserId });
        res.json({ ok: true });
      }),
    ),
  );

  // GET /tg/circles/:id/members/:memberId/wishlists — a member's shared lists.
  // Surprise invariant applied in the service (owner self-view is stripped).
  router.get(
    '/circles/:id/members/:memberId/wishlists',
    asyncHandler(async (req, res) =>
      runCircle(res, async () => {
        const user = await getOrCreateTgUser(req.tgUser!);
        const circleId = requireParam(req.params.id);
        const memberId = requireParam(req.params.memberId);
        const data = await circles.getMemberWishlistsForViewer({ circleId, viewerId: user.id, memberId });
        if (memberId !== user.id) {
          trackEvent('circle.member_list_opened', user.id, { circleId, memberId });
        }
        res.json(data);
      }),
    ),
  );

  // POST /tg/circles/:id/items/:itemId/reserve — surprise-preserving circle
  // reservation (CircleReservation; never touches Item.status, never DMs owner)
  router.post(
    '/circles/:id/items/:itemId/reserve',
    asyncHandler(async (req, res) =>
      runCircle(res, async () => {
        const user = await getOrCreateTgUser(req.tgUser!);
        const circleId = requireParam(req.params.id);
        const itemId = requireParam(req.params.itemId);
        await circles.reserveInCircle({ circleId, viewerId: user.id, itemId });
        trackEvent('circle.item_reserved', user.id, { circleId, itemId });
        res.json({ ok: true });
      }),
    ),
  );

  // DELETE /tg/circles/:id/items/:itemId/reserve — cancel own circle reservation
  router.delete(
    '/circles/:id/items/:itemId/reserve',
    asyncHandler(async (req, res) =>
      runCircle(res, async () => {
        const user = await getOrCreateTgUser(req.tgUser!);
        const circleId = requireParam(req.params.id);
        const itemId = requireParam(req.params.itemId);
        await circles.unreserveInCircle({ circleId, viewerId: user.id, itemId });
        res.json({ ok: true });
      }),
    ),
  );

  // GET /tg/circles/:id/shares — which of MY lists this circle sees (toggles)
  router.get(
    '/circles/:id/shares',
    asyncHandler(async (req, res) =>
      runCircle(res, async () => {
        const user = await getOrCreateTgUser(req.tgUser!);
        const circleId = requireParam(req.params.id);
        const wishlists = await circles.getMyShares({ circleId, userId: user.id });
        res.json({ wishlists });
      }),
    ),
  );

  // PUT /tg/circles/:id/shares — replace the set of MY lists shared here
  router.put(
    '/circles/:id/shares',
    asyncHandler(async (req, res) =>
      runCircle(res, async () => {
        const user = await getOrCreateTgUser(req.tgUser!);
        const circleId = requireParam(req.params.id);
        const body = (req.body ?? {}) as { wishlistIds?: unknown };
        const result = await circles.setMyShares({ circleId, userId: user.id, wishlistIds: body.wishlistIds });
        res.json(result);
      }),
    ),
  );

  return router;
}
