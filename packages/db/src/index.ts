import { PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { __wishlistPrisma?: PrismaClient };

// Ensure a single PrismaClient instance in dev (hot reload, ts-node-dev).
export const prisma = globalForPrisma.__wishlistPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__wishlistPrisma = prisma;
}

export { PrismaClient, Prisma } from '@prisma/client';

// Locale segmentation persistence — shared by api middleware + bot /start.
export { persistResolvedBucket, type PersistBucketInput, type PersistBucketTarget } from './locale-persistence';

// Referral program — shared core logic (used by api + bot).
// See packages/db/src/referral.ts for the full module; this re-export keeps
// callers on `import { ... } from '@wishlist/db'`.
export {
  // Types
  type FraudSignalName,
  type FraudSignalHit,
  type AttributionContext,
  type AttributionResult,
  type QualificationResult,
  type RewardDecision,
  // Constants
  REFERRAL_CODE_LENGTH,
  REWARD_CAP_MONTHLY_WINDOW_DAYS,
  REWARD_CAP_YEARLY_WINDOW_DAYS,
  // Config
  loadReferralConfig,
  invalidateReferralConfigCache,
  // Hashing
  hashIp,
  hashFingerprint,
  // Code gen + resolve
  generateCandidateCode,
  ensureReferralCode,
  resolveReferralCode,
  // Attribution
  tryCreateAttribution,
  // Funnel marks
  markFirstBotStart,
  markFirstWishlist,
  markFirstItem,
  // Qualify + reward pipeline
  tryQualifyAttribution,
  computeFraudSignals,
  checkRewardCap,
  processReward,
  // Cron
  sweepExpiredPendingAttributions,
  // Rollout
  isInRollout,
} from './referral';

