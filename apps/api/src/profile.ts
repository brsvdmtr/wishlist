import crypto from 'node:crypto';
import { prisma, Prisma } from '@wishlist/db';
import type { Locale } from '@wishlist/shared';

/** Generate a cryptographically random, opaque, collision-safe Support ID.
 *  Format: 16-char lowercase hex (e.g. "8c7f0c2e9a4b1d63").
 *  Not derived from Telegram ID or any user-identifying data. */
export async function generateUniqueSupportId(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const id = crypto.randomBytes(8).toString('hex');
    const existing = await prisma.userProfile.findUnique({ where: { supportId: id } });
    if (!existing) return id;
  }
  return crypto.randomBytes(16).toString('hex');
}

export async function getOrCreateProfile(userId: string, locale?: Locale) {
  // Try to fetch an existing profile first to avoid generating a supportId we won't use.
  let profile = await prisma.userProfile.findUnique({ where: { userId } });

  if (!profile) {
    // New user: explicit create + catch P2002 → re-fetch. The mini-app boot
    // fires several GET /tg/me/profile concurrently and they all see
    // profile === null, so one INSERT wins and the rest race into P2002 on
    // UserProfile.userId. Prisma's upsert with `update: {}` was tried first
    // (281379a, 2026-04-19) but still raced in prod 2026-04-30 — empty update
    // doesn't reliably translate to native INSERT ... ON CONFLICT. Catching
    // P2002 and re-fetching is unconditionally race-safe.
    const supportId = await generateUniqueSupportId();
    try {
      profile = await prisma.userProfile.create({
        data: {
          userId,
          defaultCurrency: locale === 'ru' ? 'RUB' : 'USD',
          supportId,
        },
      });
    } catch (err) {
      const isUserIdConflict =
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002' &&
        Array.isArray((err.meta as { target?: unknown } | undefined)?.target) &&
        ((err.meta as { target: string[] }).target.includes('userId'));
      if (!isUserIdConflict) throw err;
      const existing = await prisma.userProfile.findUnique({ where: { userId } });
      if (!existing) throw err;
      profile = existing;
    }
  }

  if (!profile.supportId) {
    // Existing user without supportId (pre-migration row, or a row written by
    // the racing request before we added supportId): lazy backfill.
    const supportId = await generateUniqueSupportId();
    profile = await prisma.userProfile.update({
      where: { userId },
      data: { supportId },
    });
  }

  return profile;
}
