// Telegram-auth router for /tg/profiles/:username/subscribe (3 handlers).
// Mounted via `tgRouter.use(profilesRouter)` in apps/api/src/index.ts.
//
// Trivial isolated domain — only operates on UserProfile + ProfileSubscription
// tables and uses one closure helper (getOrCreateTgUser). Same factory
// pattern as P4/P5a/P5b. Handler bodies byte-identical to their previous
// in-place definitions (only `tgRouter.` -> `profilesRouter.` + indent +2).

import { Router } from 'express';
import { prisma } from '@wishlist/db';

import { asyncHandler } from '../lib/asyncHandler';

type TelegramUserShape = {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
};

export type ProfilesRouterDeps = {
  getOrCreateTgUser: (tgUser: TelegramUserShape) => Promise<{ id: string }>;
};

export function registerProfilesRouter(deps: ProfilesRouterDeps): Router {
  const { getOrCreateTgUser } = deps;

  const profilesRouter = Router();

  // POST /tg/profiles/:username/subscribe — follow a profile
  profilesRouter.post(
    '/profiles/:username/subscribe',
    asyncHandler(async (req, res) => {
      const username = (req.params.username ?? '').trim();
      if (!username) return res.status(400).json({ error: 'Missing username' });
  
      const user = await getOrCreateTgUser(req.tgUser!);
  
      const targetProfile = await prisma.userProfile.findFirst({
        where: { username: { equals: username, mode: 'insensitive' } },
        select: { userId: true, profileVisibility: true, subscribePolicy: true },
      });
      if (!targetProfile) return res.status(404).json({ error: 'Profile not found' });
      if (targetProfile.userId === user.id) return res.status(400).json({ error: 'Cannot subscribe to your own profile' });
      if (targetProfile.profileVisibility === 'NOBODY') return res.status(404).json({ error: 'Profile not found' });
      if (targetProfile.subscribePolicy === 'NOBODY') return res.status(403).json({ error: 'subscriptions_closed' });
  
      const sub = await prisma.profileSubscription.upsert({
        where: { subscriberId_targetUserId: { subscriberId: user.id, targetUserId: targetProfile.userId } },
        update: {},
        create: { subscriberId: user.id, targetUserId: targetProfile.userId },
        select: { id: true, targetUserId: true, createdAt: true },
      });
  
      return res.json({ subscription: { id: sub.id, targetUserId: sub.targetUserId, createdAt: sub.createdAt.toISOString() } });
    }),
  );
  
  // DELETE /tg/profiles/:username/subscribe — unfollow a profile
  profilesRouter.delete(
    '/profiles/:username/subscribe',
    asyncHandler(async (req, res) => {
      const username = (req.params.username ?? '').trim();
      if (!username) return res.status(400).json({ error: 'Missing username' });
  
      const user = await getOrCreateTgUser(req.tgUser!);
  
      const targetProfile = await prisma.userProfile.findFirst({
        where: { username: { equals: username, mode: 'insensitive' } },
        select: { userId: true },
      });
      if (!targetProfile) return res.json({ ok: true }); // idempotent
  
      await prisma.profileSubscription.deleteMany({
        where: { subscriberId: user.id, targetUserId: targetProfile.userId },
      });
      return res.json({ ok: true });
    }),
  );
  
  // GET /tg/profiles/:username/subscribe — subscription status (for CTA state on public profile)
  profilesRouter.get(
    '/profiles/:username/subscribe',
    asyncHandler(async (req, res) => {
      const username = (req.params.username ?? '').trim();
      if (!username) return res.status(400).json({ error: 'Missing username' });
  
      const user = await getOrCreateTgUser(req.tgUser!);
  
      const targetProfile = await prisma.userProfile.findFirst({
        where: { username: { equals: username, mode: 'insensitive' } },
        select: { userId: true },
      });
      if (!targetProfile) return res.json({ subscribed: false });
      if (targetProfile.userId === user.id) return res.json({ subscribed: false, isOwn: true });
  
      const sub = await prisma.profileSubscription.findUnique({
        where: { subscriberId_targetUserId: { subscriberId: user.id, targetUserId: targetProfile.userId } },
        select: { id: true },
      });
      return res.json({ subscribed: !!sub });
    }),
  );

  return profilesRouter;
}
