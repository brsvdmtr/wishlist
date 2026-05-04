// Telegram-auth router for /tg/selections/* (6 handlers) and /tg/archive/*
// (2 handlers) — 8 read/write endpoints sharing the CuratedSelection /
// CuratedSelectionSubscription / Item tables.
//
// Mounted via `tgRouter.use(selectionsArchiveRouter)` in
// apps/api/src/index.ts alongside the other early P5 routers, immediately
// after onboardingRouter (~line 1834). All 3 deps (getOrCreateTgUser,
// trackEvent, mapTgItem) are hoisted function declarations defined long
// before the mount point (lines 731, 1287, 1402), so wiring here is
// TDZ-safe — no relocation needed.
//
// Same factory pattern as P5a/P5b/P5c/P5d/P5e/P5f/P5g/P5h. Handler bodies
// are byte-identical to their previous in-place definitions in index.ts
// (lines 3152–3323, 4962–4985, 5308–5338) — only `tgRouter.` ->
// `selectionsArchiveRouter.` and indent +2.
//
// Cross-domain coupling — the following sibling routes touch the same
// tables but are intentionally OUT OF SCOPE for this split because they
// are core wishlist/items routes:
//   - POST   /tg/wishlists/:id/selections   (CREATE selection — Pro-gated)
//   - GET    /tg/wishlists/:id/selections   (LIST owner's selections)
//   - POST   /tg/wishlists/:id/archive
//   - POST   /tg/wishlists/:id/unarchive
//   - GET    /tg/wishlists/:id/archive
//   - POST   /tg/items/bulk-archive
// They will move when wishlist/items domains are split.
//
// `generateUniqueCuratedToken` (index.ts:3031) is intentionally NOT
// migrated — it is the sole helper for POST /tg/wishlists/:id/selections,
// which stays in index.ts.
//
// Pre-existing security gaps (NOT addressed in this PR — Wave-2 follow-up):
//   - POST /tg/archive/purge has no protectTgRoute(...) registration; it
//     is a destructive cascade-delete with no idempotency / rate-limit.
//
// No `protectTgRoute(...)` chains are migrated with this router. The
// 3 selections registrations that DO have idem (`DELETE /selections/:id`,
// `POST /selections/:id/subscribe`, `DELETE /selections/:id/subscribe`)
// stay in index.ts at lines 1655–1657 — registered as `tgRouter.all(...)`
// path-scoped middleware, they fire BEFORE the handlers in this router
// because tgRouter's middleware chain runs to completion before sub-router
// dispatch.

import { Router } from 'express';
import { prisma } from '@wishlist/db';

import { asyncHandler } from '../lib/asyncHandler';

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

// Minimal structural shape of the User row that all 8 handlers read.
type SelectionsArchiveUser = {
  id: string;
};

export type SelectionsArchiveRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<SelectionsArchiveUser>;
  trackEvent: (event: string, userId?: string, props?: Record<string, unknown>) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mapTgItem at index.ts:1287 takes a structurally-typed Item; GET /archive passes the full select.
  mapTgItem: (item: any) => any;
};

export function registerSelectionsArchiveRouter(deps: SelectionsArchiveRouterDeps): Router {
  const { getOrCreateTgUser, trackEvent, mapTgItem } = deps;

  const selectionsArchiveRouter = Router();

  // DELETE /tg/selections/:id — deactivate a curated selection
  selectionsArchiveRouter.delete(
    '/selections/:id',
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      if (!id) return res.status(400).json({ error: 'Missing selection id' });

      const user = await getOrCreateTgUser(req.tgUser!);
      const selection = await prisma.curatedSelection.findUnique({ where: { id }, select: { ownerId: true } });
      if (!selection) return res.status(404).json({ error: 'Selection not found' });
      if (selection.ownerId !== user.id) return res.status(403).json({ error: 'Forbidden' });

      await prisma.curatedSelection.update({ where: { id }, data: { deactivatedAt: new Date() } });
      trackEvent('selection_deactivated', user.id, { selectionId: id });

      return res.json({ ok: true });
    }),
  );

  // POST /tg/selections/:id/subscribe — subscribe to a curated selection
  selectionsArchiveRouter.post(
    '/selections/:id/subscribe',
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      if (!id) return res.status(400).json({ error: 'Missing selection id' });

      const user = await getOrCreateTgUser(req.tgUser!);
      const selection = await prisma.curatedSelection.findUnique({
        where: { id },
        select: { id: true, ownerId: true, deactivatedAt: true, expiresAt: true },
      });
      if (!selection) return res.status(404).json({ error: 'Selection not found' });
      if (selection.ownerId === user.id) return res.status(400).json({ error: 'Cannot subscribe to own selection' });
      if (selection.deactivatedAt || selection.expiresAt < new Date()) {
        return res.status(410).json({ error: 'Selection expired' });
      }

      await prisma.curatedSelectionSubscription.upsert({
        where: { curatedSelectionId_subscriberId: { curatedSelectionId: id, subscriberId: user.id } },
        update: {},
        create: { curatedSelectionId: id, subscriberId: user.id },
      });

      trackEvent('selection_subscribed', user.id, { selectionId: id });
      return res.json({ ok: true, subscribed: true });
    }),
  );

  // DELETE /tg/selections/:id/subscribe — unsubscribe from a curated selection
  selectionsArchiveRouter.delete(
    '/selections/:id/subscribe',
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      if (!id) return res.status(400).json({ error: 'Missing selection id' });

      const user = await getOrCreateTgUser(req.tgUser!);
      await prisma.curatedSelectionSubscription.deleteMany({
        where: { curatedSelectionId: id, subscriberId: user.id },
      });

      trackEvent('selection_unsubscribed', user.id, { selectionId: id });
      return res.json({ ok: true, subscribed: false });
    }),
  );

  // GET /tg/selections/:id/subscribe — check subscription status
  selectionsArchiveRouter.get(
    '/selections/:id/subscribe',
    asyncHandler(async (req, res) => {
      const id = req.params.id ?? '';
      if (!id) return res.status(400).json({ error: 'Missing selection id' });

      const user = await getOrCreateTgUser(req.tgUser!);
      const sub = await prisma.curatedSelectionSubscription.findUnique({
        where: { curatedSelectionId_subscriberId: { curatedSelectionId: id, subscriberId: user.id } },
        select: { id: true },
      });

      return res.json({ subscribed: !!sub });
    }),
  );

  // GET /tg/selections/by-token/:token — authenticated curated selection view (includes isSubscribed + isOwner)
  selectionsArchiveRouter.get(
    '/selections/by-token/:token',
    asyncHandler(async (req, res) => {
      const token = req.params.token ?? '';
      if (!token) return res.status(400).json({ error: 'Missing token' });

      const user = await getOrCreateTgUser(req.tgUser!);
      const selection = await prisma.curatedSelection.findUnique({
        where: { shareToken: token },
        select: {
          id: true, title: true, ownerId: true, expiresAt: true, deactivatedAt: true,
          owner: { select: { firstName: true, profile: { select: { displayName: true } } } },
          items: { orderBy: { position: 'asc' }, select: { id: true, title: true, priceText: true, currency: true, imageUrl: true, url: true, description: true, position: true } },
        },
      });
      if (!selection) return res.status(404).json({ error: 'Selection not found' });

      const expired = !!selection.deactivatedAt || selection.expiresAt < new Date();
      if (expired) {
        return res.status(410).json({ error: 'expired', expiresAt: selection.expiresAt });
      }

      const isOwner = selection.ownerId === user.id;
      let isSubscribed = false;
      if (!isOwner) {
        const sub = await prisma.curatedSelectionSubscription.findUnique({
          where: { curatedSelectionId_subscriberId: { curatedSelectionId: selection.id, subscriberId: user.id } },
          select: { id: true },
        });
        isSubscribed = !!sub;
      }

      // Track view — fire-and-forget
      prisma.curatedSelection.update({ where: { shareToken: token }, data: { viewCount: { increment: 1 } } }).catch(() => {});
      trackEvent('selection_viewed', user.id, { selectionId: selection.id });

      const ownerName = selection.owner.profile?.displayName || selection.owner.firstName || null;

      return res.json({
        selection: {
          id: selection.id,
          title: selection.title,
          itemCount: selection.items.length,
          expiresAt: selection.expiresAt,
          ownerName,
          isOwner,
          isSubscribed,
          items: selection.items,
        },
      });
    }),
  );

  // GET /tg/selections/subscribed — list subscribed curated selections
  selectionsArchiveRouter.get(
    '/selections/subscribed',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);
      const subs = await prisma.curatedSelectionSubscription.findMany({
        where: { subscriberId: user.id },
        orderBy: { createdAt: 'desc' },
        select: {
          createdAt: true,
          curatedSelection: {
            select: {
              id: true, shareToken: true, title: true, expiresAt: true,
              deactivatedAt: true, createdAt: true,
              owner: { select: { firstName: true, profile: { select: { displayName: true } } } },
              _count: { select: { items: true } },
            },
          },
        },
      });

      const selections = subs
        .filter(s => !s.curatedSelection.deactivatedAt && s.curatedSelection.expiresAt > new Date())
        .map(s => ({
          id: s.curatedSelection.id,
          shareToken: s.curatedSelection.shareToken,
          title: s.curatedSelection.title,
          itemCount: s.curatedSelection._count.items,
          ownerName: s.curatedSelection.owner.profile?.displayName || s.curatedSelection.owner.firstName || null,
          expiresAt: s.curatedSelection.expiresAt,
          subscribedAt: s.createdAt,
        }));

      return res.json({ selections });
    }),
  );

  // POST /tg/archive/purge — permanently delete ALL archived items for the current user
  // Two-step confirmation is enforced in the frontend; this endpoint is the final destructive step.
  selectionsArchiveRouter.post(
    '/archive/purge',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);

      const items = await prisma.item.findMany({
        where: {
          status: { in: ['DELETED', 'COMPLETED'] },
          wishlist: { ownerId: user.id },
        },
        select: { id: true },
      });

      if (items.length === 0) return res.json({ deleted: 0 });

      await prisma.item.deleteMany({
        where: { id: { in: items.map((i) => i.id) } },
      });

      return res.json({ deleted: items.length });
    }),
  );

  // GET /tg/archive — global user archive (ALL DELETED + COMPLETED items across all wishlists)
  selectionsArchiveRouter.get(
    '/archive',
    asyncHandler(async (req, res) => {
      const user = await getOrCreateTgUser(req.tgUser!);

      const items = await prisma.item.findMany({
        where: {
          status: { in: ['DELETED', 'COMPLETED'] },
          wishlist: { ownerId: user.id },
        },
        orderBy: [{ updatedAt: 'desc' }],
        select: {
          id: true, wishlistId: true, title: true, url: true, priceText: true,
          currency: true, imageUrl: true, priority: true, position: true,
          status: true, description: true, sourceUrl: true, sourceDomain: true,
          importMethod: true,
          wishlist: { select: { id: true, title: true, archivedAt: true } },
        },
      });

      return res.json({
        items: items.map(({ wishlist, ...item }) => ({
          ...mapTgItem(item),
          wishlistTitle: wishlist.title,
          wishlistId: wishlist.id,
          wishlistIsArchived: wishlist.archivedAt !== null,
        })),
      });
    }),
  );

  return selectionsArchiveRouter;
}
