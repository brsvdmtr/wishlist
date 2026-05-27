// First-touch acquisition source for invitees arriving via `?start=ref_<CODE>`.
//
// The Mini App attribution beacon (POST /tg/analytics/attribution from
// apps/web/app/miniapp/lib/attribution.ts) covers share/curated/profile
// entry paths — but referral deep links are intercepted by the bot, not
// the Mini App, and the bot can't call that endpoint (no Telegram WebApp
// initData). So we write firstAcquisitionSource directly via Prisma here.
//
// Semantics match the HTTP endpoint:
//   - First-touch only: atomically writes only when firstAcquisitionSource
//     IS NULL — repeat calls for the same user are safe no-ops.
//   - Independent of referral-program enablement: we record the source for
//     cohort analysis even when the program is OFF and referredByUserId
//     never gets set.

import type { PrismaClient } from '@wishlist/db';

import logger from './logger';

export async function writeReferralAcquisitionSource(
  prisma: Pick<PrismaClient, 'userProfile'>,
  inviteeUserId: string,
  refCode: string,
): Promise<void> {
  try {
    await prisma.userProfile.updateMany({
      where: { userId: inviteeUserId, firstAcquisitionSource: null },
      data: {
        firstAcquisitionSource: 'referral',
        firstAcquisitionMedium: 'bot',
        firstAcquisitionRef: refCode,
        firstAcquisitionAt: new Date(),
      },
    });
  } catch (err) {
    logger.warn({ err, inviteeUserId }, '[referral] firstAcquisitionSource write failed');
  }
}
