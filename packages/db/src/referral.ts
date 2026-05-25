/**
 * Referral program — shared core logic.
 *
 * Lives in @wishlist/db because both apps/api (HTTP endpoints, qualify hooks)
 * and apps/bot (parse /start payload, record attribution) need to drive the
 * same state machine with the same invariants.
 *
 * Design notes:
 * - All mutating functions are idempotent where possible (write guards like
 *   `updateMany where status = 'PENDING_ACTIVATION'` catch concurrent runs).
 * - No analytics events fire from here — the CALLER emits events so that
 *   trace context (route, request ID, session) stays in one place.
 * - Functions return structured discriminated unions instead of throwing on
 *   expected outcomes (program_disabled, code_not_found, etc.). Only
 *   unexpected DB errors bubble up.
 * - Config is cached 60s. Mutations through the admin path MUST call
 *   `invalidateReferralConfigCache()` for instant rollout toggles.
 *
 * See /mockups/referral-program.html for the full product spec.
 */

import { PrismaClient, Prisma } from '@prisma/client';
import type {
  ReferralAttribution,
  ReferralAttributionStatus,
  ReferralRejectReason,
  ReferralProgramConfig,
} from '@prisma/client';
import crypto from 'crypto';
import { z } from 'zod';

// ====================================================================
// Types
// ====================================================================

/** Signal names match event suffixes in shared/analyticsEvents.ts */
export type FraudSignalName =
  | 'ip_cluster'
  | 'device_fingerprint'
  | 'velocity'
  | 'inactive_invitee'
  | 'same_tz_cluster'
  | 'self_referral'
  | 'suspicious_onboarding'
  | 'account_age_delta';

export interface FraudSignalHit {
  signal: FraudSignalName;
  weight: number;
  details: Record<string, unknown>;
}

export interface AttributionContext {
  inviterUserId: string;
  inviteeUserId: string;
  referralCode: string;
  ipHash?: string | null;
  deviceFingerprintHash?: string | null;
  timezone?: string | null;
  locale?: string | null;
  telegramClient?: string | null;
  platform?: string | null;
}

/** Discriminated result — caller decides what to do per case. */
export type AttributionResult =
  | { kind: 'attributed'; attributionId: string; windowDeadlineAt: Date }
  | {
      kind: 'rejected';
      reason: ReferralRejectReason;
      // For most reject reasons, we do NOT create a ReferralAttribution row
      // (keeps the table clean for dashboards). The signal goes only through
      // analytics — caller emits referral.attribution_rejected_on_write.
      persisted: false;
    }
  | { kind: 'program_disabled' }
  | { kind: 'code_not_found' }
  | { kind: 'race_lost' }; // another attribution won the unique constraint race

export type QualificationResult =
  | { kind: 'not_ready' }
  | { kind: 'not_applicable' }
  | { kind: 'already_processed' }
  | { kind: 'qualified'; attributionId: string; inviterUserId: string };

/** After qualify, the decision pipeline resolves to one of these terminal-ish states. */
export type RewardDecision =
  | { kind: 'rewarded'; rewardId: string; newExpiryAt: Date; daysGranted: number }
  | { kind: 'review_queued'; attributionId: string; fraudScore: number; signals: FraudSignalHit[] }
  | { kind: 'auto_rejected'; attributionId: string; fraudScore: number; signals: FraudSignalHit[] }
  | { kind: 'cap_rejected'; attributionId: string; reason: 'cap_monthly' | 'cap_yearly'; monthlyUsed: number; yearlyUsed: number }
  | { kind: 'already_granted' }
  | { kind: 'not_qualified' };

// ====================================================================
// Constants & alphabet
// ====================================================================

/** Common time window constant. Avoids scattering magic numbers. */
const DAY_MS = 86_400_000;

export const REFERRAL_CODE_LENGTH = 6;
/** No visually ambiguous chars (0/O, 1/I/L). 31 chars → 31^6 ≈ 887M codes. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CONFIG_CACHE_TTL_MS = 60_000;
const MAX_CODE_GENERATION_ATTEMPTS = 8;
/**
 * Invitee is considered "new" if their User row was created within this window
 * before the attribution attempt. Prevents old users from claiming attribution
 * via /start ref_<code>.
 */
const MAX_USER_AGE_FOR_NEW_ATTRIBUTION_MS = 2 * 60_000; // 2 min
/**
 * account_age_delta fraud signal only fires when the INVITER is also a recent
 * account (within this window). Otherwise organic referrals between friends
 * who both just signed up would produce false positives.
 */
const ACCOUNT_AGE_DELTA_INVITER_MAX_AGE_MS = 24 * 60 * 60_000; // 24h
const ACCOUNT_AGE_DELTA_THRESHOLD_MS = 5 * 60_000; // 5 min
/** Suspicious onboarding = attribution→qualify under this threshold. */
const SUSPICIOUS_ONBOARDING_THRESHOLD_MS = 30_000;
/** Sweep batch — bounded per iteration so one tick doesn't lock up the DB. */
const SWEEP_BATCH_SIZE = 500;
/** Hard cap on sweep iterations per tick to prevent runaway loops on bugs. */
const SWEEP_MAX_ITERATIONS = 20;

/**
 * Rolling-window lengths for reward caps. Exported so any stats-display code
 * (e.g. /tg/referral/stats) uses the same boundaries as checkRewardCap —
 * otherwise "2/3 used this month" in the UI could disagree with the backend
 * enforcement point.
 */
export const REWARD_CAP_MONTHLY_WINDOW_DAYS = 30;
export const REWARD_CAP_YEARLY_WINDOW_DAYS = 365;

// ====================================================================
// Config cache + schema
// ====================================================================

/**
 * Shape of the JSON `fraudSignalWeights` column. Validated on every load so
 * malformed rows (manual admin edits, corrupted JSON) fail closed with a
 * descriptive error instead of producing NaN scores at runtime.
 */
const FraudSignalWeightsSchema = z
  .object({
    ip_cluster: z.number().int().min(0).max(100).optional(),
    device_fingerprint: z.number().int().min(0).max(100).optional(),
    velocity: z.number().int().min(0).max(100).optional(),
    inactive_invitee: z.number().int().min(0).max(100).optional(),
    same_tz_cluster: z.number().int().min(0).max(100).optional(),
    self_referral: z.number().int().min(0).max(100).optional(),
    suspicious_onboarding: z.number().int().min(0).max(100).optional(),
    account_age_delta: z.number().int().min(0).max(100).optional(),
  })
  .catchall(z.number().int().min(0).max(100));

export type FraudSignalWeights = z.infer<typeof FraudSignalWeightsSchema>;

/**
 * Per-process cache. Note: multi-node deploys will tolerate up to
 * CONFIG_CACHE_TTL_MS of drift between nodes. If instant propagation of admin
 * config changes is ever required, replace this with a pub/sub (Redis) or
 * drop the cache entirely.
 */
let configCache: { data: ReferralProgramConfig; loadedAt: number } | null = null;

export async function loadReferralConfig(prisma: PrismaClient): Promise<ReferralProgramConfig> {
  const now = Date.now();
  if (configCache && now - configCache.loadedAt < CONFIG_CACHE_TTL_MS) {
    return configCache.data;
  }
  const row = await prisma.referralProgramConfig.findUnique({ where: { id: 'default' } });
  if (!row) {
    // Migration seed ensures singleton row exists. Missing row = infra bug,
    // not a runtime condition — throw loudly.
    throw new Error('[referral] ReferralProgramConfig "default" row missing — migration seed failed?');
  }
  // Validate fraudSignalWeights shape — fail-closed rather than produce NaN
  // scores if an admin wrote bad JSON.
  const parsed = FraudSignalWeightsSchema.safeParse(row.fraudSignalWeights);
  if (!parsed.success) {
    throw new Error(
      `[referral] ReferralProgramConfig.fraudSignalWeights is malformed: ${parsed.error.message}`,
    );
  }
  configCache = { data: row, loadedAt: now };
  return row;
}

export function invalidateReferralConfigCache(): void {
  configCache = null;
}

// ====================================================================
// Hashing (PII-safe)
// ====================================================================

/**
 * Salt MUST be set via REFERRAL_IP_HASH_SALT env in prod. In dev/test, a
 * predictable fallback is used so tests are reproducible. Any fallback in
 * production would enable dictionary attacks against the IP/fingerprint
 * hashes, so we fail fast on import.
 */
const IP_SALT = (() => {
  const fromEnv = process.env.REFERRAL_IP_HASH_SALT;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      '[referral] REFERRAL_IP_HASH_SALT must be set (>=16 chars) in production — PII-hash fallback disabled',
    );
  }
  return 'wishlist-referral-dev-salt';
})();

export function hashIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  return crypto.createHash('sha256').update(`ip:${ip}:${IP_SALT}`).digest('hex').slice(0, 16);
}

export function hashFingerprint(fp: string | null | undefined): string | null {
  if (!fp) return null;
  return crypto.createHash('sha256').update(`fp:${fp}:${IP_SALT}`).digest('hex').slice(0, 16);
}

// ====================================================================
// Code generation
// ====================================================================

export function generateCandidateCode(length: number = REFERRAL_CODE_LENGTH): string {
  // Use rejection sampling across 256 to avoid modulo bias (alphabet=31, 256 % 31 ≠ 0).
  const out: string[] = [];
  while (out.length < length) {
    const bytes = crypto.randomBytes(length * 2);
    for (const b of bytes) {
      if (b >= 248) continue; // 248 = 8 * 31 — reject to avoid bias
      out.push(CODE_ALPHABET[b % CODE_ALPHABET.length]!);
      if (out.length >= length) break;
    }
  }
  return out.join('');
}

/**
 * Lazily generate + persist a referral code for this user.
 *
 * Returns existing code if already set. Safe under concurrent calls for the
 * same user: uses `updateMany WHERE referralCode IS NULL` so only the first
 * call writes; subsequent calls re-read the winning code and return it.
 *
 * Called from `/tg/referral/me` the first time a user opens the screen, OR
 * from qualifying flows that need the code early.
 */
export async function ensureReferralCode(prisma: PrismaClient, userId: string): Promise<string> {
  // Fast path: if a code is already persisted, return it immediately.
  const existing = await prisma.userProfile.findUnique({
    where: { userId },
    select: { referralCode: true },
  });
  if (existing?.referralCode) return existing.referralCode;

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < MAX_CODE_GENERATION_ATTEMPTS; attempt++) {
    const candidate = generateCandidateCode();
    try {
      // Step 1: make sure the UserProfile row exists. If we win the `create`
      // branch, the code is attached atomically — no second write needed.
      // If the row pre-exists, `update: {}` is a no-op and we'll race-fill below.
      // Why upsert instead of updateMany-only: /tg/referral/me is called
      // before getOrCreateProfile in some flows (the invitee-perspective users),
      // so we can't assume a UserProfile row exists yet. updateMany against
      // a missing row silently returns count=0 and would loop forever.
      await prisma.userProfile.upsert({
        where: { userId },
        create: { userId, referralCode: candidate, referralCodeCreatedAt: new Date() },
        update: {},
      });

      // Step 2: the row is now guaranteed to exist. Does it have a code?
      const afterUpsert = await prisma.userProfile.findUnique({
        where: { userId },
        select: { referralCode: true },
      });
      if (afterUpsert?.referralCode) return afterUpsert.referralCode;

      // Step 3: row exists with null code (it pre-existed without a code, and
      // our upsert's `update: {}` didn't touch it). Race-safe fill.
      const filled = await prisma.userProfile.updateMany({
        where: { userId, referralCode: null },
        data: { referralCode: candidate, referralCodeCreatedAt: new Date() },
      });
      if (filled.count === 1) return candidate;

      // Another writer won the race between step 2 and step 3. Re-read.
      const winner = await prisma.userProfile.findUnique({
        where: { userId },
        select: { referralCode: true },
      });
      if (winner?.referralCode) return winner.referralCode;
      // Very unlikely: still null (someone set then unset between writes). Retry.
    } catch (e) {
      lastErr = e;
      // P2002 on referralCode means collision with another user's code
      // (~10^-6 probability per attempt at 36^6 keyspace). Regenerate.
      // P2002 on userId can happen if two upserts race on a missing row —
      // the loser retries and finds the row on the next iteration.
      if (isUniqueViolation(e)) continue;
      throw e;
    }
  }
  throw new Error(
    `[referral] code_generation_collision_retry_exhausted after ${MAX_CODE_GENERATION_ATTEMPTS} attempts: ${String(lastErr)}`,
  );
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

// ====================================================================
// Code resolution
// ====================================================================

/** Look up inviter user by their referral code (returns null for unknown codes). */
export async function resolveReferralCode(
  prisma: PrismaClient,
  code: string,
): Promise<{ inviterUserId: string } | null> {
  // Normalize: code is case-sensitive per alphabet, but we'll be forgiving on input
  const normalized = code.trim().toUpperCase();
  if (!/^[A-Z2-9]{4,8}$/.test(normalized)) return null;
  const profile = await prisma.userProfile.findUnique({
    where: { referralCode: normalized },
    select: { userId: true },
  });
  return profile ? { inviterUserId: profile.userId } : null;
}

// ====================================================================
// Attribution creation
// ====================================================================

/**
 * Records first-touch attribution of invitee to inviter. Called ONCE during
 * the invitee's /start ref_<code> handling.
 *
 * Rejection model:
 * - Most rejections (not-new-user, already-had-wishlist, etc.) do NOT write
 *   a ReferralAttribution row — signal goes only through analytics.
 * - Race-loss (unique violation on invitedUserId) returns 'race_lost'.
 * - `SELF_REFERRAL_DETECTED` is also analytics-only.
 *
 * Caller is responsible for:
 * - Calling resolveReferralCode() first
 * - Emitting referral.attribution_rejected_on_write for reject outcomes
 * - Emitting referral.attributed / referral.pending_activation on success
 */
export async function tryCreateAttribution(
  prisma: PrismaClient,
  ctx: AttributionContext,
): Promise<AttributionResult> {
  const config = await loadReferralConfig(prisma);

  if (!config.enabled) return { kind: 'program_disabled' };

  // Gate 1: self-referral
  if (ctx.inviterUserId === ctx.inviteeUserId) {
    return { kind: 'rejected', reason: 'SELF_REFERRAL_DETECTED', persisted: false };
  }

  // Gate 2: invitee already attributed (race path)
  const inviteeProfile = await prisma.userProfile.findUnique({
    where: { userId: ctx.inviteeUserId },
    select: {
      referredByUserId: true,
      firstWishlistAt: true,
      firstItemAt: true,
    },
  });
  if (inviteeProfile?.referredByUserId) {
    return { kind: 'rejected', reason: 'INVITEE_ALREADY_ATTRIBUTED', persisted: false };
  }
  if (inviteeProfile?.firstWishlistAt) {
    return { kind: 'rejected', reason: 'INVITEE_HAD_PRIOR_WISHLIST', persisted: false };
  }
  if (inviteeProfile?.firstItemAt) {
    return { kind: 'rejected', reason: 'INVITEE_HAD_PRIOR_ITEM', persisted: false };
  }

  // Gate 3: invitee must exist AND be recently created (protects against
  // old accounts claiming attribution via /start ref_<code>).
  const invitee = await prisma.user.findUnique({
    where: { id: ctx.inviteeUserId },
    select: { createdAt: true },
  });
  if (!invitee) {
    // User was deleted between bot /start and attribution attempt, or caller
    // passed a bad ID. Surface as SYSTEM_CONFLICT so the caller knows this
    // isn't a retryable race — the FK would fail below anyway.
    return { kind: 'rejected', reason: 'SYSTEM_CONFLICT', persisted: false };
  }
  if (Date.now() - invitee.createdAt.getTime() > MAX_USER_AGE_FOR_NEW_ATTRIBUTION_MS) {
    return { kind: 'rejected', reason: 'INVITEE_NOT_NEW_USER', persisted: false };
  }

  // All gates passed — record attribution + mark profile
  const windowDeadline = new Date(Date.now() + config.qualificationWindowDays * DAY_MS);
  const configSnapshot = buildConfigSnapshot(config);

  try {
    const created = await prisma.$transaction(async (tx) => {
      const attribution = await tx.referralAttribution.create({
        data: {
          inviterUserId: ctx.inviterUserId,
          invitedUserId: ctx.inviteeUserId,
          referralCode: ctx.referralCode,
          source: 'telegram',
          status: 'PENDING_ACTIVATION',
          attributedAt: new Date(),
          windowDeadlineAt: windowDeadline,
          ipHash: ctx.ipHash ?? null,
          deviceFingerprintHash: ctx.deviceFingerprintHash ?? null,
          timezone: ctx.timezone ?? null,
          locale: ctx.locale ?? null,
          telegramClient: ctx.telegramClient ?? null,
          platform: ctx.platform ?? null,
          configVersion: config.configVersion,
          configSnapshot: configSnapshot as Prisma.InputJsonValue,
        },
        select: { id: true, windowDeadlineAt: true },
      });
      // Upsert (not update) — bot /start only creates a User row; UserProfile
      // is lazily created by the Mini App's getOrCreateProfile. A user who
      // clicks a ref link as their very first interaction (no Mini App yet)
      // would have no UserProfile row → update() would P2025-throw. Upsert
      // covers both: create on first touch, apply the referral marks either way.
      await tx.userProfile.upsert({
        where: { userId: ctx.inviteeUserId },
        update: {
          referredByUserId: ctx.inviterUserId,
          referredAt: new Date(),
        },
        create: {
          userId: ctx.inviteeUserId,
          referredByUserId: ctx.inviterUserId,
          referredAt: new Date(),
        },
      });
      return attribution;
    });
    return { kind: 'attributed', attributionId: created.id, windowDeadlineAt: created.windowDeadlineAt };
  } catch (e) {
    if (isUniqueViolation(e)) {
      // invitedUserId unique — another attribution was created concurrently.
      // Caller emits referral.concurrent_attribution_blocked.
      return { kind: 'race_lost' };
    }
    throw e;
  }
}

// ====================================================================
// Qualify + advance state machine
// ====================================================================

/**
 * Write firstBotStartAt once. Idempotent. Called from bot /start handler.
 *
 * Upsert-first pattern: the bot's /start upserts User but not UserProfile,
 * and this mark runs on the REJECTED-attribution path too (code_not_found,
 * not-new-user, etc. — where tryCreateAttribution never gets to create the
 * profile). Plain updateMany against a missing row silently returns count=0
 * and the funnel stat never lands. Upsert ensures the row exists, then the
 * follow-up updateMany is the idempotent "set-if-null" path for repeat /start.
 */
export async function markFirstBotStart(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.userProfile.upsert({
    where: { userId },
    update: {},
    create: { userId, firstBotStartAt: new Date() },
  });
  await prisma.userProfile.updateMany({
    where: { userId, firstBotStartAt: null },
    data: { firstBotStartAt: new Date() },
  });
}

/**
 * Write firstWishlistAt once. Idempotent. Called after POST /tg/wishlists.
 *
 * Upsert-first pattern: most Mini App sessions hit /tg/me (which runs
 * getOrCreateProfile) before wishlist creation, but some entry points skip
 * that. We can't lose the mark — if the profile is missing, attribution would
 * never qualify. Upsert creates the row with the mark on first miss; the
 * follow-up updateMany is the idempotent "set-if-null" path.
 */
export async function markFirstWishlist(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.userProfile.upsert({
    where: { userId },
    update: {},
    create: { userId, firstWishlistAt: new Date() },
  });
  await prisma.userProfile.updateMany({
    where: { userId, firstWishlistAt: null },
    data: { firstWishlistAt: new Date() },
  });
}

/** Write firstItemAt once. Idempotent. Called after POST /tg/wishlists/:id/items. */
export async function markFirstItem(prisma: PrismaClient, userId: string): Promise<void> {
  await prisma.userProfile.upsert({
    where: { userId },
    update: {},
    create: { userId, firstItemAt: new Date() },
  });
  await prisma.userProfile.updateMany({
    where: { userId, firstItemAt: null },
    data: { firstItemAt: new Date() },
  });
}

/**
 * Check if invitee has satisfied qualifying criteria and transition attribution
 * from PENDING_ACTIVATION → QUALIFIED. Caller then routes to processReward().
 *
 * Guard via `updateMany where status = 'PENDING_ACTIVATION'` ensures no double
 * transition if two hooks fire concurrently (wishlist + item created in quick
 * succession).
 */
export async function tryQualifyAttribution(
  prisma: PrismaClient,
  inviteeUserId: string,
): Promise<QualificationResult> {
  const attribution = await prisma.referralAttribution.findFirst({
    where: { invitedUserId: inviteeUserId, status: 'PENDING_ACTIVATION' },
    select: { id: true, windowDeadlineAt: true, inviterUserId: true },
  });
  if (!attribution) return { kind: 'not_applicable' };

  if (attribution.windowDeadlineAt < new Date()) {
    // Expired — let the cron sweeper handle it; don't race.
    return { kind: 'already_processed' };
  }

  const [config, profile] = await Promise.all([
    loadReferralConfig(prisma),
    prisma.userProfile.findUnique({
      where: { userId: inviteeUserId },
      select: { firstWishlistAt: true, firstItemAt: true },
    }),
  ]);

  const hasWishlist = !!profile?.firstWishlistAt;
  const hasItem = !!profile?.firstItemAt;

  if (config.requireWishlist && !hasWishlist) return { kind: 'not_ready' };
  if (config.requireItem && !hasItem) return { kind: 'not_ready' };

  const updated = await prisma.referralAttribution.updateMany({
    where: { id: attribution.id, status: 'PENDING_ACTIVATION' },
    data: { status: 'QUALIFIED', qualifiedAt: new Date() },
  });

  if (updated.count === 0) return { kind: 'already_processed' };

  return { kind: 'qualified', attributionId: attribution.id, inviterUserId: attribution.inviterUserId };
}

// ====================================================================
// Fraud scoring
// ====================================================================

/**
 * Pull fraud signal weights for this attribution. Prefers `configSnapshot.fraudSignalWeights`
 * (frozen at attribution time for reproducibility), falling back to the current config
 * if the snapshot is missing or malformed. This keeps scoring consistent with what was
 * promised when the attribution was recorded, even if admin edits weights afterwards.
 */
function resolveWeightsForAttribution(
  snapshot: Prisma.JsonValue | null,
  currentConfig: ReferralProgramConfig,
): FraudSignalWeights {
  if (snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot)) {
    const snapWeights = (snapshot as Record<string, unknown>).fraudSignalWeights;
    if (snapWeights) {
      const parsed = FraudSignalWeightsSchema.safeParse(snapWeights);
      if (parsed.success) return parsed.data;
    }
  }
  // Fall through to current config — already validated in loadReferralConfig.
  return FraudSignalWeightsSchema.parse(currentConfig.fraudSignalWeights);
}

/**
 * Evaluate fraud signals for a given attribution. Pure read — does NOT persist.
 * Caller persists to ReferralAttribution.fraudScore + triggeredSignals as part
 * of the reward decision transaction.
 *
 * Weights are taken from the attribution's frozen configSnapshot when available
 * (reproducibility) and from the current config otherwise. Thresholds for
 * whether-a-signal-fires are hard-coded here — they're behavioural, not policy.
 */
export async function computeFraudSignals(
  prisma: PrismaClient,
  attributionId: string,
): Promise<{ score: number; signals: FraudSignalHit[] }> {
  const att = await prisma.referralAttribution.findUnique({
    where: { id: attributionId },
    include: {
      inviter: { select: { createdAt: true } },
      invited: { select: { createdAt: true, id: true } },
    },
  });
  if (!att) return { score: 0, signals: [] };

  const config = await loadReferralConfig(prisma);
  const weights = resolveWeightsForAttribution(att.configSnapshot, config);
  const hits: FraudSignalHit[] = [];
  const now = Date.now();

  // ip_cluster: >3 attributions from same ipHash in 24h (includes self).
  if (att.ipHash) {
    const ipWindow = new Date(now - DAY_MS);
    const clusterSize = await prisma.referralAttribution.count({
      where: { ipHash: att.ipHash, attributedAt: { gte: ipWindow } },
    });
    if (clusterSize > 3) {
      hits.push({
        signal: 'ip_cluster',
        weight: weights.ip_cluster ?? 30,
        details: { ipHash: att.ipHash, clusterSize, windowMinutes: 1440 },
      });
    }
  }

  // device_fingerprint: same fp used across >2 attributions ever.
  if (att.deviceFingerprintHash) {
    const fpCount = await prisma.referralAttribution.count({
      where: { deviceFingerprintHash: att.deviceFingerprintHash },
    });
    if (fpCount > 2) {
      hits.push({
        signal: 'device_fingerprint',
        weight: weights.device_fingerprint ?? 25,
        details: { fingerprintHash: att.deviceFingerprintHash, priorAttributions: fpCount },
      });
    }
  }

  // velocity: inviter had >5 attributions in last 24h.
  const inviterRecent = await prisma.referralAttribution.count({
    where: {
      inviterUserId: att.inviterUserId,
      attributedAt: { gte: new Date(now - DAY_MS) },
    },
  });
  if (inviterRecent > 5) {
    hits.push({
      signal: 'velocity',
      weight: weights.velocity ?? 20,
      details: { inviterAttributionsLast24h: inviterRecent },
    });
  }

  // account_age_delta: invitee created within 5min of inviter.
  //
  // To avoid false positives on organic word-of-mouth (two friends who both
  // signed up today), require the inviter to ALSO be a recent account. A
  // mature inviter referring a brand-new friend is normal; two fresh accounts
  // 30 seconds apart from the same ip_cluster is the fraud pattern.
  const inviterAgeMs = now - att.inviter.createdAt.getTime();
  const ageDeltaMs = Math.abs(
    att.invited.createdAt.getTime() - att.inviter.createdAt.getTime(),
  );
  if (
    ageDeltaMs < ACCOUNT_AGE_DELTA_THRESHOLD_MS &&
    inviterAgeMs < ACCOUNT_AGE_DELTA_INVITER_MAX_AGE_MS
  ) {
    hits.push({
      signal: 'account_age_delta',
      weight: weights.account_age_delta ?? 20,
      details: {
        deltaMs: ageDeltaMs,
        inviterAgeDays: Math.floor(inviterAgeMs / DAY_MS),
        inviterAgeHours: Math.floor(inviterAgeMs / (60 * 60_000)),
      },
    });
  }

  // suspicious_onboarding: qualifyTime < 30s (bot-like speed).
  if (att.qualifiedAt) {
    const timeToQualifyMs = att.qualifiedAt.getTime() - att.attributedAt.getTime();
    if (timeToQualifyMs < SUSPICIOUS_ONBOARDING_THRESHOLD_MS) {
      hits.push({
        signal: 'suspicious_onboarding',
        weight: weights.suspicious_onboarding ?? 25,
        details: { timeToQualifyMs },
      });
    }
  }

  // TODO (future slices): inactive_invitee (post-qualify activity window),
  //   same_tz_cluster (geo bucket), self_referral (phone/email hash comparison).
  // Stubbed — will emit 0-weight signals in analytics when we add them.

  const score = Math.min(100, hits.reduce((sum, h) => sum + h.weight, 0));
  return { score, signals: hits };
}

// ====================================================================
// Cap enforcement
// ====================================================================

export async function checkRewardCap(
  prisma: PrismaClient,
  inviterUserId: string,
): Promise<
  | { withinCap: true; monthlyUsed: number; yearlyUsed: number }
  | { withinCap: false; reason: 'cap_monthly' | 'cap_yearly'; monthlyUsed: number; yearlyUsed: number }
> {
  const config = await loadReferralConfig(prisma);
  const monthAgo = new Date(Date.now() - REWARD_CAP_MONTHLY_WINDOW_DAYS * DAY_MS);
  const yearAgo = new Date(Date.now() - REWARD_CAP_YEARLY_WINDOW_DAYS * DAY_MS);

  const [monthlyUsed, yearlyUsed] = await Promise.all([
    prisma.referralReward.count({
      where: { userId: inviterUserId, status: 'GRANTED', grantedAt: { gte: monthAgo } },
    }),
    prisma.referralReward.count({
      where: { userId: inviterUserId, status: 'GRANTED', grantedAt: { gte: yearAgo } },
    }),
  ]);

  if (monthlyUsed >= config.monthlyRewardCap) {
    return { withinCap: false, reason: 'cap_monthly', monthlyUsed, yearlyUsed };
  }
  if (yearlyUsed >= config.yearlyRewardCap) {
    return { withinCap: false, reason: 'cap_yearly', monthlyUsed, yearlyUsed };
  }
  return { withinCap: true, monthlyUsed, yearlyUsed };
}

// ====================================================================
// Reward grant + terminal decision pipeline
// ====================================================================

/**
 * Terminal decision for a qualified attribution. Runs fraud + cap checks,
 * then either grants PRO days (stack strategy) or routes to review / reject.
 * Idempotent via ReferralReward.idempotencyKey unique constraint.
 *
 * @param options.skipFraudCheck — for admin approve path. When a human has
 *   already inspected the FRAUD_REVIEW signals and decided to grant, we must
 *   NOT re-score (fresh scoring would just bounce the attribution back into
 *   FRAUD_REVIEW in a loop). Cap enforcement still runs — admin overrides
 *   fraud, not spending limits.
 */
export async function processReward(
  prisma: PrismaClient,
  attributionId: string,
  options: { skipFraudCheck?: boolean } = {},
): Promise<RewardDecision> {
  const att = await prisma.referralAttribution.findUnique({
    where: { id: attributionId },
    select: { id: true, inviterUserId: true, status: true, fraudScore: true, triggeredSignals: true },
  });
  if (!att) return { kind: 'not_qualified' };
  if (att.status !== 'QUALIFIED') return { kind: 'not_qualified' };

  const config = await loadReferralConfig(prisma);

  // 1. Fraud signals — recomputed fresh unless we're in an admin-approve path.
  //    For admin approve we preserve whatever was already stored (the signals
  //    the admin saw when approving).
  let score: number;
  let signals: FraudSignalHit[];
  if (options.skipFraudCheck) {
    score = att.fraudScore;
    signals = Array.isArray(att.triggeredSignals) ? (att.triggeredSignals as unknown as FraudSignalHit[]) : [];
  } else {
    const computed = await computeFraudSignals(prisma, attributionId);
    score = computed.score;
    signals = computed.signals;

    // Telemetry: one fraud_score_calculated + one fraud_signal_<name> per
    // triggered signal. Fire-and-forget — never blocks the reward decision.
    // These events were declared in the allowlist on launch but never wired
    // to emit (root cause: this is a @wishlist/db layer file with no analytics
    // import path; we use direct prisma.analyticsEvent.create here to stay
    // self-sufficient). Added 2026-05-25 as part of the referral re-enable
    // gates (see docs/research/referral-decision.md § 7.4).
    prisma.analyticsEvent.create({
      data: {
        event: 'referral.fraud_score_calculated',
        userId: att.inviterUserId,
        props: { attributionId, score, signalCount: signals.length },
      },
    }).catch(() => {});
    for (const hit of signals) {
      prisma.analyticsEvent.create({
        data: {
          event: `referral.fraud_signal_${hit.signal}`,
          userId: att.inviterUserId,
          props: {
            attributionId,
            weight: hit.weight,
            score,
            ...hit.details,
          },
        },
      }).catch(() => {});
    }

    // 2. If auto-reject threshold — short-circuit to REJECTED with FRAUD_REJECTED
    if (score >= config.fraudAutoRejectThreshold) {
      await prisma.referralAttribution.update({
        where: { id: attributionId },
        data: {
          status: 'REJECTED',
          rejectReason: 'FRAUD_REJECTED',
          rejectedAt: new Date(),
          fraudScore: score,
          triggeredSignals: signals as unknown as Prisma.InputJsonValue,
        },
      });
      return { kind: 'auto_rejected', attributionId, fraudScore: score, signals };
    }

    // 3. If review threshold + review enabled — queue for admin
    if (config.fraudReviewEnabled && score >= config.fraudReviewThreshold) {
      await prisma.referralAttribution.update({
        where: { id: attributionId },
        data: {
          status: 'FRAUD_REVIEW',
          fraudScore: score,
          triggeredSignals: signals as unknown as Prisma.InputJsonValue,
        },
      });
      prisma.analyticsEvent.create({
        data: {
          event: 'referral.fraud_review_queued',
          userId: att.inviterUserId,
          props: { attributionId, score, signalCount: signals.length },
        },
      }).catch(() => {});
      return { kind: 'review_queued', attributionId, fraudScore: score, signals };
    }
  }

  // 4. Cap check
  const cap = await checkRewardCap(prisma, att.inviterUserId);
  if (!cap.withinCap) {
    await prisma.referralAttribution.update({
      where: { id: attributionId },
      data: {
        status: 'REJECTED',
        rejectReason: 'REWARD_CAP_REACHED',
        rejectedAt: new Date(),
        fraudScore: score,
        triggeredSignals: signals as unknown as Prisma.InputJsonValue,
      },
    });
    return {
      kind: 'cap_rejected',
      attributionId,
      reason: cap.reason,
      monthlyUsed: cap.monthlyUsed,
      yearlyUsed: cap.yearlyUsed,
    };
  }

  // 5. Grant — persist fraud score, extend subscription, write reward row,
  //    flip attribution to REWARDED. All in one transaction.
  return await grantRewardInternal(prisma, {
    attributionId,
    inviterUserId: att.inviterUserId,
    config,
    fraudScore: score,
    signals,
  });
}

async function grantRewardInternal(
  prisma: PrismaClient,
  params: {
    attributionId: string;
    inviterUserId: string;
    config: ReferralProgramConfig;
    fraudScore: number;
    signals: FraudSignalHit[];
  },
): Promise<RewardDecision> {
  const idempotencyKey = `grant:${params.attributionId}`;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const existingSub = await tx.subscription.findFirst({
        where: { userId: params.inviterUserId, planCode: 'PRO' },
        orderBy: { currentPeriodEnd: 'desc' },
      });

      const now = new Date();
      const daysMs = params.config.rewardDaysInviter * DAY_MS;
      const hasActivePro = existingSub && existingSub.currentPeriodEnd > now && existingSub.status === 'ACTIVE';

      const previousExpiryAt = hasActivePro ? existingSub!.currentPeriodEnd : null;
      let newExpiryAt: Date;
      let grantStrategy: string;

      if (params.config.grantStrategy === 'stack' && hasActivePro) {
        newExpiryAt = new Date(existingSub!.currentPeriodEnd.getTime() + daysMs);
        grantStrategy = 'stack';
      } else {
        newExpiryAt = new Date(now.getTime() + daysMs);
        grantStrategy = 'replace';
      }

      // Upsert subscription
      if (existingSub) {
        await tx.subscription.update({
          where: { id: existingSub.id },
          data: {
            currentPeriodEnd: newExpiryAt,
            status: 'ACTIVE',
            cancelledAt: null,
          },
        });
      } else {
        await tx.subscription.create({
          data: {
            userId: params.inviterUserId,
            planCode: 'PRO',
            status: 'ACTIVE',
            starsPrice: 0,
            currentPeriodStart: now,
            currentPeriodEnd: newExpiryAt,
            source: 'referral_reward',
            billingPeriod: 'one_time',
            cancelAtPeriodEnd: true,
          },
        });
      }

      // Record reward (idempotencyKey unique → double grant fails here)
      const reward = await tx.referralReward.create({
        data: {
          userId: params.inviterUserId,
          attributionId: params.attributionId,
          rewardType: 'pro_days',
          rewardValueDays: params.config.rewardDaysInviter,
          status: 'GRANTED',
          grantStrategy,
          previousExpiryAt,
          newExpiryAt,
          idempotencyKey,
        },
      });

      // Transition attribution
      await tx.referralAttribution.update({
        where: { id: params.attributionId },
        data: {
          status: 'REWARDED',
          rewardedAt: new Date(),
          fraudScore: params.fraudScore,
          triggeredSignals: params.signals as unknown as Prisma.InputJsonValue,
        },
      });

      return { rewardId: reward.id, newExpiryAt };
    });

    return {
      kind: 'rewarded',
      rewardId: result.rewardId,
      newExpiryAt: result.newExpiryAt,
      daysGranted: params.config.rewardDaysInviter,
    };
  } catch (e) {
    if (isUniqueViolation(e)) {
      // idempotencyKey collision — reward already exists for this attribution.
      // Safe retry case; analytics should emit referral.idempotency_hit.
      return { kind: 'already_granted' };
    }
    throw e;
  }
}

// ====================================================================
// Cron sweep
// ====================================================================

/**
 * Transition overdue PENDING_ACTIVATION attributions to REJECTED /
 * QUALIFICATION_TIMEOUT. Run every 15-60 min from a scheduler.
 *
 * Drains up to SWEEP_BATCH_SIZE × SWEEP_MAX_ITERATIONS rows per invocation
 * (default 10k) so a backlog spike eventually catches up without requiring
 * an ad-hoc script. The hard iteration cap prevents runaway loops if a bug
 * causes updateMany to leave rows in the matching state.
 */
export async function sweepExpiredPendingAttributions(
  prisma: PrismaClient,
): Promise<{ expired: number; inviteeStats: Array<{ hasWishlist: boolean; hasItem: boolean }> }> {
  const allExpiredStats: Array<{ hasWishlist: boolean; hasItem: boolean }> = [];
  let totalExpired = 0;

  for (let iteration = 0; iteration < SWEEP_MAX_ITERATIONS; iteration++) {
    const now = new Date();
    const batch = await prisma.referralAttribution.findMany({
      where: { status: 'PENDING_ACTIVATION', windowDeadlineAt: { lt: now } },
      select: {
        id: true,
        invitedUserId: true,
        invited: { select: { profile: { select: { firstWishlistAt: true, firstItemAt: true } } } },
      },
      take: SWEEP_BATCH_SIZE,
    });
    if (batch.length === 0) break;

    await prisma.referralAttribution.updateMany({
      where: { id: { in: batch.map((a) => a.id) } },
      data: {
        status: 'REJECTED',
        rejectReason: 'QUALIFICATION_TIMEOUT',
        rejectedAt: now,
      },
    });

    totalExpired += batch.length;
    for (const a of batch) {
      allExpiredStats.push({
        hasWishlist: !!a.invited.profile?.firstWishlistAt,
        hasItem: !!a.invited.profile?.firstItemAt,
      });
    }

    // Partial batch = drained. Break to avoid a final empty query.
    if (batch.length < SWEEP_BATCH_SIZE) break;
  }

  return { expired: totalExpired, inviteeStats: allExpiredStats };
}

// ====================================================================
// Rollout bucketing
// ====================================================================

/**
 * Deterministic rollout — same user always lands in same bucket.
 * 0..rolloutPercent-1 → in; rest → out. Used to soft-launch to 10% of users
 * before flipping to 100%.
 */
export function isInRollout(userId: string, rolloutPercent: number): boolean {
  if (rolloutPercent >= 100) return true;
  if (rolloutPercent <= 0) return false;
  const hash = crypto.createHash('sha256').update(`referral-rollout:${userId}`).digest();
  const bucket = hash.readUInt16BE(0) % 100;
  return bucket < rolloutPercent;
}

// ====================================================================
// Helpers
// ====================================================================

function buildConfigSnapshot(config: ReferralProgramConfig): Record<string, unknown> {
  return {
    rewardDaysInviter: config.rewardDaysInviter,
    grantStrategy: config.grantStrategy,
    requireWishlist: config.requireWishlist,
    requireItem: config.requireItem,
    qualificationWindowDays: config.qualificationWindowDays,
    monthlyRewardCap: config.monthlyRewardCap,
    yearlyRewardCap: config.yearlyRewardCap,
    fraudAutoRejectThreshold: config.fraudAutoRejectThreshold,
    fraudReviewThreshold: config.fraudReviewThreshold,
    fraudReviewEnabled: config.fraudReviewEnabled,
    fraudSignalWeights: config.fraudSignalWeights,
    configVersion: config.configVersion,
  };
}
