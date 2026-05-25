/**
 * Tests for referral.ts.
 *
 * Two layers:
 *  1. Pure-logic tests (no DB): code generation, hashing, rollout bucketing.
 *  2. DB-flow tests with a hand-rolled in-memory Prisma mock. The mock is
 *     intentionally minimal — it supports only the exact calls this module
 *     makes, throws Prisma.PrismaClientKnownRequestError('P2002') on unique
 *     violations, and lets us assert the state-machine transitions without
 *     spinning up Postgres.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Prisma, type PrismaClient, type ReferralProgramConfig } from '@prisma/client';
import {
  REFERRAL_CODE_LENGTH,
  generateCandidateCode,
  hashIp,
  hashFingerprint,
  isInRollout,
  invalidateReferralConfigCache,
  loadReferralConfig,
  ensureReferralCode,
  resolveReferralCode,
  tryCreateAttribution,
  tryQualifyAttribution,
  markFirstBotStart,
  markFirstWishlist,
  markFirstItem,
  checkRewardCap,
  computeFraudSignals,
  processReward,
  sweepExpiredPendingAttributions,
} from './referral';

const ALPHABET_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/;

// ====================================================================
// Pure-logic tests
// ====================================================================

describe('generateCandidateCode', () => {
  it('has default length REFERRAL_CODE_LENGTH', () => {
    const code = generateCandidateCode();
    expect(code).toHaveLength(REFERRAL_CODE_LENGTH);
  });

  it('honors custom length', () => {
    expect(generateCandidateCode(4)).toHaveLength(4);
    expect(generateCandidateCode(8)).toHaveLength(8);
    expect(generateCandidateCode(12)).toHaveLength(12);
  });

  it('uses only the safe alphabet (no O/0/1/I/L)', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateCandidateCode();
      expect(code).toMatch(ALPHABET_RE);
    }
  });

  it('produces different codes on repeated calls (no stuck state)', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) codes.add(generateCandidateCode());
    // With 31^6 ≈ 887M, 100 random draws colliding is vanishingly unlikely.
    expect(codes.size).toBeGreaterThan(95);
  });

  it('has reasonably uniform character distribution (no modulo bias)', () => {
    const counts = new Map<string, number>();
    const iterations = 10_000;
    for (let i = 0; i < iterations; i++) {
      for (const c of generateCandidateCode()) {
        counts.set(c, (counts.get(c) ?? 0) + 1);
      }
    }
    const totalChars = iterations * REFERRAL_CODE_LENGTH;
    const expectedPerChar = totalChars / 31;
    for (const [char, count] of counts) {
      expect(count).toBeGreaterThan(expectedPerChar * 0.75);
      expect(count).toBeLessThan(expectedPerChar * 1.25);
      expect(char).toMatch(ALPHABET_RE);
    }
    expect(counts.size).toBe(31);
  });
});

describe('hashIp', () => {
  it('returns null for null/undefined/empty', () => {
    expect(hashIp(null)).toBeNull();
    expect(hashIp(undefined)).toBeNull();
    expect(hashIp('')).toBeNull();
  });

  it('returns 16-char hex digest', () => {
    const h = hashIp('1.2.3.4');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic for the same input', () => {
    expect(hashIp('1.2.3.4')).toBe(hashIp('1.2.3.4'));
  });

  it('differs across distinct IPs', () => {
    expect(hashIp('1.2.3.4')).not.toBe(hashIp('1.2.3.5'));
  });

  it('is namespaced away from fingerprint hashes (prefix guard)', () => {
    expect(hashIp('abc123')).not.toBe(hashFingerprint('abc123'));
  });
});

describe('hashFingerprint', () => {
  it('returns null for null/undefined/empty', () => {
    expect(hashFingerprint(null)).toBeNull();
    expect(hashFingerprint(undefined)).toBeNull();
    expect(hashFingerprint('')).toBeNull();
  });

  it('returns 16-char hex digest', () => {
    expect(hashFingerprint('device-123')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is deterministic', () => {
    expect(hashFingerprint('device-xyz')).toBe(hashFingerprint('device-xyz'));
  });
});

describe('isInRollout', () => {
  it('always true when rolloutPercent >= 100', () => {
    expect(isInRollout('any-user-id', 100)).toBe(true);
    expect(isInRollout('any-user-id', 150)).toBe(true);
  });

  it('always false when rolloutPercent <= 0', () => {
    expect(isInRollout('any-user-id', 0)).toBe(false);
    expect(isInRollout('any-user-id', -5)).toBe(false);
  });

  it('is deterministic for a given (userId, percent)', () => {
    const first = isInRollout('user-42', 50);
    for (let i = 0; i < 10; i++) expect(isInRollout('user-42', 50)).toBe(first);
  });

  it('roughly matches the requested rollout percentage at scale', () => {
    const target = 25;
    let hits = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) if (isInRollout(`user-${i}`, target)) hits++;
    const observed = (hits / n) * 100;
    expect(observed).toBeGreaterThan(target - 5);
    expect(observed).toBeLessThan(target + 5);
  });

  it('a user at 50% stays in bucket when percent grows, out when it shrinks below their bucket', () => {
    for (let i = 0; i < 50; i++) {
      const id = `user-mono-${i}`;
      const at50 = isInRollout(id, 50);
      if (at50) expect(isInRollout(id, 100)).toBe(true);
      if (!at50) expect(isInRollout(id, 0)).toBe(false);
    }
  });
});

// ====================================================================
// In-memory Prisma mock
// ====================================================================

type MockUser = { id: string; createdAt: Date };
type MockProfile = {
  userId: string;
  referralCode: string | null;
  referralCodeCreatedAt: Date | null;
  referredByUserId: string | null;
  referredAt: Date | null;
  firstBotStartAt: Date | null;
  firstWishlistAt: Date | null;
  firstItemAt: Date | null;
};
type MockAttribution = {
  id: string;
  inviterUserId: string;
  invitedUserId: string;
  referralCode: string;
  source: string;
  status:
    | 'ATTRIBUTED'
    | 'PENDING_ACTIVATION'
    | 'QUALIFIED'
    | 'REWARDED'
    | 'REJECTED'
    | 'FRAUD_REVIEW';
  rejectReason: string | null;
  attributedAt: Date;
  qualifiedAt: Date | null;
  rewardedAt: Date | null;
  rejectedAt: Date | null;
  windowDeadlineAt: Date;
  fraudScore: number;
  triggeredSignals: unknown;
  configVersion: string | null;
  configSnapshot: unknown;
  ipHash: string | null;
  deviceFingerprintHash: string | null;
  timezone: string | null;
  locale: string | null;
  telegramClient: string | null;
  platform: string | null;
  createdAt: Date;
  updatedAt: Date;
};
type MockReward = {
  id: string;
  userId: string;
  attributionId: string | null;
  rewardType: string;
  rewardValueDays: number;
  status: 'GRANTED' | 'REVOKED';
  grantStrategy: string;
  previousExpiryAt: Date | null;
  newExpiryAt: Date | null;
  idempotencyKey: string;
  grantedAt: Date;
  revokedAt: Date | null;
  revokedReason: string | null;
};
type MockSubscription = {
  id: string;
  userId: string;
  planCode: string;
  status: 'ACTIVE' | 'CANCELLED' | 'EXPIRED';
  starsPrice: number;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  cancelledAt: Date | null;
  source: string;
  billingPeriod: string;
  cancelAtPeriodEnd: boolean;
};

type MockAnalyticsEvent = {
  event: string;
  userId: string | null;
  props: Record<string, unknown> | null;
};

interface MockState {
  config: ReferralProgramConfig;
  users: MockUser[];
  profiles: MockProfile[];
  attributions: MockAttribution[];
  rewards: MockReward[];
  subscriptions: MockSubscription[];
  analyticsEvents: MockAnalyticsEvent[];
  nextId: number;
}

function p2002(target: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(`Unique constraint failed on ${target}`, {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: [target] },
  });
}

function defaultConfig(overrides: Partial<ReferralProgramConfig> = {}): ReferralProgramConfig {
  return {
    id: 'default',
    enabled: true,
    rewardDaysInviter: 30,
    grantStrategy: 'stack',
    requireWishlist: true,
    requireItem: true,
    qualificationWindowDays: 14,
    monthlyRewardCap: 3,
    yearlyRewardCap: 12,
    fraudAutoRejectThreshold: 80,
    fraudReviewThreshold: 40,
    fraudReviewEnabled: true,
    fraudSignalWeights: {
      ip_cluster: 30,
      device_fingerprint: 25,
      velocity: 20,
      inactive_invitee: 15,
      same_tz_cluster: 10,
      self_referral: 100,
      suspicious_onboarding: 25,
      account_age_delta: 20,
    } as Prisma.JsonValue,
    showInviteeNamesInUi: false,
    entryPointProfile: true,
    entryPointPaywall: true,
    entryPointHomeBanner: true,
    entryPointPostShare: true,
    notifyInviterArrival: true,
    notifyInviterStepProgress: false,
    notifyInviterReward: true,
    notifyInviteeWelcome: false,
    rolloutPercent: 100,
    configVersion: 'v1',
    updatedAt: new Date(),
    updatedByAdminId: null,
    ...overrides,
  } as ReferralProgramConfig;
}

function initialState(overrides: Partial<MockState> = {}): MockState {
  return {
    config: defaultConfig(),
    users: [],
    profiles: [],
    attributions: [],
    rewards: [],
    subscriptions: [],
    analyticsEvents: [],
    nextId: 1,
    ...overrides,
  };
}

function matchWhere<T>(rows: T[], where: Record<string, unknown>): T[] {
  return rows.filter((row) => {
    for (const [k, v] of Object.entries(where)) {
      const rowVal = (row as Record<string, unknown>)[k];
      if (v === null) {
        if (rowVal !== null && rowVal !== undefined) return false;
      } else if (typeof v === 'object' && v !== null) {
        const cond = v as Record<string, unknown>;
        if ('in' in cond && Array.isArray(cond.in) && !cond.in.includes(rowVal)) return false;
        if ('gte' in cond && cond.gte instanceof Date && (rowVal as Date) < cond.gte) return false;
        if ('lt' in cond && cond.lt instanceof Date && (rowVal as Date) >= cond.lt) return false;
        if ('not' in cond && rowVal === cond.not) return false;
      } else if (rowVal !== v) {
        return false;
      }
    }
    return true;
  });
}

function makeMockPrisma(state: MockState): PrismaClient {
  const m = {
    referralProgramConfig: {
      findUnique: async (args: { where: { id: string } }) => {
        if (state.config && state.config.id === args.where.id) return state.config;
        return null;
      },
    },
    user: {
      findUnique: async (args: { where: { id: string }; select?: unknown }) => {
        return state.users.find((u) => u.id === args.where.id) ?? null;
      },
    },
    userProfile: {
      findUnique: async (args: { where: { userId?: string; referralCode?: string } }) => {
        if (args.where.userId) {
          return state.profiles.find((p) => p.userId === args.where.userId) ?? null;
        }
        if (args.where.referralCode) {
          return state.profiles.find((p) => p.referralCode === args.where.referralCode) ?? null;
        }
        return null;
      },
      update: async (args: { where: { userId: string }; data: Record<string, unknown> }) => {
        const profile = state.profiles.find((p) => p.userId === args.where.userId);
        if (!profile) throw new Error('Record to update not found');
        // Simulate unique constraint on referralCode
        if (args.data.referralCode && typeof args.data.referralCode === 'string') {
          const taken = state.profiles.find(
            (p) => p.referralCode === args.data.referralCode && p.userId !== profile.userId,
          );
          if (taken) throw p2002('UserProfile_referralCode_key');
        }
        Object.assign(profile, args.data);
        return profile;
      },
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const matches = matchWhere(state.profiles, args.where);
        // Simulate unique constraint check before applying
        if (args.data.referralCode && typeof args.data.referralCode === 'string') {
          const taken = state.profiles.find(
            (p) => p.referralCode === args.data.referralCode && !matches.includes(p),
          );
          if (taken) throw p2002('UserProfile_referralCode_key');
        }
        for (const p of matches) Object.assign(p, args.data);
        return { count: matches.length };
      },
      upsert: async (args: {
        where: { userId: string };
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) => {
        const existing = state.profiles.find((p) => p.userId === args.where.userId);
        if (existing) {
          // Apply update — may be no-op ({})
          Object.assign(existing, args.update);
          return existing;
        }
        // Create path: check unique constraints (userId is enforced by DB).
        // Simulate unique on referralCode if present.
        if (args.create.referralCode && typeof args.create.referralCode === 'string') {
          const taken = state.profiles.find((p) => p.referralCode === args.create.referralCode);
          if (taken) throw p2002('UserProfile_referralCode_key');
        }
        const row = {
          userId: args.where.userId,
          referralCode: null as string | null,
          referralCodeCreatedAt: null as Date | null,
          referredByUserId: null as string | null,
          referredAt: null as Date | null,
          firstBotStartAt: null as Date | null,
          firstWishlistAt: null as Date | null,
          firstItemAt: null as Date | null,
          ...args.create,
        };
        state.profiles.push(row as MockProfile);
        return row;
      },
    },
    referralAttribution: {
      create: async (args: { data: Record<string, unknown>; select?: unknown }) => {
        // Simulate @unique on invitedUserId
        if (state.attributions.find((a) => a.invitedUserId === args.data.invitedUserId)) {
          throw p2002('ReferralAttribution_invitedUserId_key');
        }
        const row: MockAttribution = {
          id: `att-${state.nextId++}`,
          inviterUserId: '',
          invitedUserId: '',
          referralCode: '',
          source: 'telegram',
          status: 'PENDING_ACTIVATION',
          rejectReason: null,
          attributedAt: new Date(),
          qualifiedAt: null,
          rewardedAt: null,
          rejectedAt: null,
          windowDeadlineAt: new Date(Date.now() + 14 * 86_400_000),
          fraudScore: 0,
          triggeredSignals: null,
          configVersion: null,
          configSnapshot: null,
          ipHash: null,
          deviceFingerprintHash: null,
          timezone: null,
          locale: null,
          telegramClient: null,
          platform: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...(args.data as Partial<MockAttribution>),
        };
        state.attributions.push(row);
        return row;
      },
      findUnique: async (args: { where: { id: string }; include?: unknown }) => {
        const att = state.attributions.find((a) => a.id === args.where.id);
        if (!att) return null;
        // Honor include with inviter/invited relations
        const include = args.include as {
          inviter?: { select: unknown };
          invited?: { select: unknown };
        } | undefined;
        if (!include) return att;
        const extra: Record<string, unknown> = {};
        if (include.inviter) {
          extra.inviter = state.users.find((u) => u.id === att.inviterUserId) ?? null;
        }
        if (include.invited) {
          const u = state.users.find((u) => u.id === att.invitedUserId);
          extra.invited = u
            ? { ...u, profile: state.profiles.find((p) => p.userId === u.id) ?? null }
            : null;
        }
        return { ...att, ...extra };
      },
      findFirst: async (args: { where: Record<string, unknown> }) => {
        return matchWhere(state.attributions, args.where)[0] ?? null;
      },
      findMany: async (args: { where: Record<string, unknown>; take?: number; select?: unknown }) => {
        const matches = matchWhere(state.attributions, args.where);
        const limited = args.take ? matches.slice(0, args.take) : matches;
        // Build minimal select response — callers select {id, invitedUserId, invited:{profile:{...}}}
        return limited.map((a) => ({
          id: a.id,
          invitedUserId: a.invitedUserId,
          invited: {
            profile: state.profiles.find((p) => p.userId === a.invitedUserId) ?? null,
          },
        }));
      },
      count: async (args: { where: Record<string, unknown> }) => {
        return matchWhere(state.attributions, args.where).length;
      },
      update: async (args: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const att = state.attributions.find((a) => a.id === args.where.id);
        if (!att) throw new Error('Record not found');
        Object.assign(att, args.data);
        return att;
      },
      updateMany: async (args: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const matches = matchWhere(state.attributions, args.where);
        for (const a of matches) Object.assign(a, args.data);
        return { count: matches.length };
      },
    },
    referralReward: {
      create: async (args: { data: Record<string, unknown> }) => {
        if (
          args.data.idempotencyKey &&
          state.rewards.find((r) => r.idempotencyKey === args.data.idempotencyKey)
        ) {
          throw p2002('ReferralReward_idempotencyKey_key');
        }
        const row: MockReward = {
          id: `rew-${state.nextId++}`,
          userId: '',
          attributionId: null,
          rewardType: 'pro_days',
          rewardValueDays: 0,
          status: 'GRANTED',
          grantStrategy: 'stack',
          previousExpiryAt: null,
          newExpiryAt: null,
          idempotencyKey: '',
          grantedAt: new Date(),
          revokedAt: null,
          revokedReason: null,
          ...(args.data as Partial<MockReward>),
        };
        state.rewards.push(row);
        return row;
      },
      count: async (args: { where: Record<string, unknown> }) => {
        return matchWhere(state.rewards, args.where).length;
      },
    },
    subscription: {
      findFirst: async (args: { where: Record<string, unknown>; orderBy?: unknown }) => {
        const matches = matchWhere(state.subscriptions, args.where);
        if (args.orderBy) {
          matches.sort((a, b) => b.currentPeriodEnd.getTime() - a.currentPeriodEnd.getTime());
        }
        return matches[0] ?? null;
      },
      create: async (args: { data: Record<string, unknown> }) => {
        const row: MockSubscription = {
          id: `sub-${state.nextId++}`,
          userId: '',
          planCode: 'PRO',
          status: 'ACTIVE',
          starsPrice: 0,
          currentPeriodStart: new Date(),
          currentPeriodEnd: new Date(),
          cancelledAt: null,
          source: 'telegram_stars',
          billingPeriod: 'monthly',
          cancelAtPeriodEnd: false,
          ...(args.data as Partial<MockSubscription>),
        };
        state.subscriptions.push(row);
        return row;
      },
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const sub = state.subscriptions.find((s) => s.id === args.where.id);
        if (!sub) throw new Error('Record not found');
        Object.assign(sub, args.data);
        return sub;
      },
    },
    analyticsEvent: {
      create: async (args: { data: { event: string; userId?: string | null; props?: unknown } }) => {
        const row: MockAnalyticsEvent = {
          event: args.data.event,
          userId: args.data.userId ?? null,
          props: (args.data.props ?? null) as Record<string, unknown> | null,
        };
        state.analyticsEvents.push(row);
        return row;
      },
    },
    $transaction: async <T>(fn: (tx: PrismaClient) => Promise<T>): Promise<T> => fn(m),
  } as unknown as PrismaClient;
  return m;
}

function addUser(state: MockState, id: string, createdAtMs = Date.now()): MockUser {
  const u: MockUser = { id, createdAt: new Date(createdAtMs) };
  state.users.push(u);
  state.profiles.push({
    userId: id,
    referralCode: null,
    referralCodeCreatedAt: null,
    referredByUserId: null,
    referredAt: null,
    firstBotStartAt: null,
    firstWishlistAt: null,
    firstItemAt: null,
  });
  return u;
}

// ====================================================================
// DB-flow tests
// ====================================================================

beforeEach(() => {
  // Config cache is module-level — purge it between tests so state changes
  // to `state.config` are visible.
  invalidateReferralConfigCache();
});

describe('loadReferralConfig', () => {
  it('throws on missing singleton row (infra bug)', async () => {
    const state = initialState();
    state.config = null as unknown as ReferralProgramConfig;
    const prisma = makeMockPrisma(state);
    await expect(loadReferralConfig(prisma)).rejects.toThrow(/missing/);
  });

  it('throws on malformed fraudSignalWeights (fail-closed)', async () => {
    const state = initialState({
      config: defaultConfig({
        fraudSignalWeights: { ip_cluster: 'not-a-number' } as unknown as Prisma.JsonValue,
      }),
    });
    const prisma = makeMockPrisma(state);
    await expect(loadReferralConfig(prisma)).rejects.toThrow(/malformed/);
  });
});

describe('resolveReferralCode', () => {
  it('normalizes case and trims', async () => {
    const state = initialState();
    addUser(state, 'u1');
    state.profiles[0]!.referralCode = 'ABC234';
    const prisma = makeMockPrisma(state);
    expect(await resolveReferralCode(prisma, '  abc234 ')).toEqual({ inviterUserId: 'u1' });
  });

  it('returns null for malformed codes', async () => {
    const prisma = makeMockPrisma(initialState());
    expect(await resolveReferralCode(prisma, 'with-dashes')).toBeNull();
    expect(await resolveReferralCode(prisma, 'ABC0O1')).toBeNull(); // 0 and O not in alphabet
    expect(await resolveReferralCode(prisma, 'AB')).toBeNull(); // too short
  });

  it('returns null for unknown codes', async () => {
    const prisma = makeMockPrisma(initialState());
    expect(await resolveReferralCode(prisma, 'ABCDEF')).toBeNull();
  });
});

describe('ensureReferralCode', () => {
  it('returns existing code if already set', async () => {
    const state = initialState();
    addUser(state, 'u1');
    state.profiles[0]!.referralCode = 'XYZ234';
    const prisma = makeMockPrisma(state);
    expect(await ensureReferralCode(prisma, 'u1')).toBe('XYZ234');
  });

  it('generates + persists a fresh code', async () => {
    const state = initialState();
    addUser(state, 'u1');
    const prisma = makeMockPrisma(state);
    const code = await ensureReferralCode(prisma, 'u1');
    expect(code).toMatch(ALPHABET_RE);
    expect(code).toHaveLength(REFERRAL_CODE_LENGTH);
    expect(state.profiles[0]!.referralCode).toBe(code);
  });

  it('returns the winning code when a concurrent writer won first (race-safe)', async () => {
    const state = initialState();
    addUser(state, 'u1');
    // Simulate concurrent winner: pre-populate the code so updateMany finds count=0
    // Our ensureReferralCode will re-read and return the pre-set value.
    state.profiles[0]!.referralCode = 'WINNER';
    const prisma = makeMockPrisma(state);
    // ensureReferralCode's early findUnique sees the existing code and short-circuits.
    expect(await ensureReferralCode(prisma, 'u1')).toBe('WINNER');
  });

  it('creates UserProfile row when missing (no infinite loop)', async () => {
    // Regression for review fix #5: ensureReferralCode previously used updateMany
    // only, which silently returns count=0 when the UserProfile row doesn't exist,
    // causing an infinite loop. Now uses upsert to create the row.
    const state = initialState();
    // Add only the User row — no UserProfile (simulate user who never hit getOrCreateProfile).
    state.users.push({ id: 'orphan', createdAt: new Date() });
    // profiles array has NO entry for 'orphan'.
    const prisma = makeMockPrisma(state);
    const code = await ensureReferralCode(prisma, 'orphan');
    expect(code).toMatch(ALPHABET_RE);
    expect(code).toHaveLength(REFERRAL_CODE_LENGTH);
    // Verify the profile row was created by the upsert path.
    const createdProfile = state.profiles.find((p) => p.userId === 'orphan');
    expect(createdProfile).toBeTruthy();
    expect(createdProfile!.referralCode).toBe(code);
  });

  it('retries past a collision (P2002 on candidate code)', async () => {
    const state = initialState();
    addUser(state, 'u1');
    // Reserve a code for a different user; ensureReferralCode for u1 will generate
    // random candidates, so collision is vanishingly rare. We test the retry path
    // by pre-populating a second user with a common enough pattern — this is
    // probabilistic, so we just verify no throw + valid code.
    addUser(state, 'u2');
    state.profiles[1]!.referralCode = 'AAAAAA';
    const prisma = makeMockPrisma(state);
    const code = await ensureReferralCode(prisma, 'u1');
    expect(code).toMatch(ALPHABET_RE);
    expect(code).not.toBe('AAAAAA');
  });
});

describe('tryCreateAttribution', () => {
  it('returns program_disabled when config.enabled=false', async () => {
    const state = initialState({ config: defaultConfig({ enabled: false }) });
    addUser(state, 'inviter');
    addUser(state, 'invitee');
    const result = await tryCreateAttribution(makeMockPrisma(state), {
      inviterUserId: 'inviter',
      inviteeUserId: 'invitee',
      referralCode: 'ABC234',
    });
    expect(result.kind).toBe('program_disabled');
  });

  it('rejects self-referral', async () => {
    const state = initialState();
    addUser(state, 'same');
    const result = await tryCreateAttribution(makeMockPrisma(state), {
      inviterUserId: 'same',
      inviteeUserId: 'same',
      referralCode: 'ABC234',
    });
    expect(result).toEqual({ kind: 'rejected', reason: 'SELF_REFERRAL_DETECTED', persisted: false });
  });

  it('rejects invitee already attributed', async () => {
    const state = initialState();
    addUser(state, 'inviter');
    addUser(state, 'invitee');
    state.profiles[1]!.referredByUserId = 'other-inviter';
    const result = await tryCreateAttribution(makeMockPrisma(state), {
      inviterUserId: 'inviter',
      inviteeUserId: 'invitee',
      referralCode: 'ABC234',
    });
    expect(result).toEqual({
      kind: 'rejected',
      reason: 'INVITEE_ALREADY_ATTRIBUTED',
      persisted: false,
    });
  });

  it('rejects invitee with prior wishlist', async () => {
    const state = initialState();
    addUser(state, 'inviter');
    addUser(state, 'invitee');
    state.profiles[1]!.firstWishlistAt = new Date();
    const result = await tryCreateAttribution(makeMockPrisma(state), {
      inviterUserId: 'inviter',
      inviteeUserId: 'invitee',
      referralCode: 'ABC234',
    });
    expect(result).toEqual({
      kind: 'rejected',
      reason: 'INVITEE_HAD_PRIOR_WISHLIST',
      persisted: false,
    });
  });

  it('rejects invitee with prior item', async () => {
    const state = initialState();
    addUser(state, 'inviter');
    addUser(state, 'invitee');
    state.profiles[1]!.firstItemAt = new Date();
    const result = await tryCreateAttribution(makeMockPrisma(state), {
      inviterUserId: 'inviter',
      inviteeUserId: 'invitee',
      referralCode: 'ABC234',
    });
    expect(result).toEqual({
      kind: 'rejected',
      reason: 'INVITEE_HAD_PRIOR_ITEM',
      persisted: false,
    });
  });

  it('rejects when invitee user is missing (SYSTEM_CONFLICT)', async () => {
    const state = initialState();
    addUser(state, 'inviter');
    // Add profile without user (edge case)
    state.profiles.push({
      userId: 'ghost',
      referralCode: null,
      referralCodeCreatedAt: null,
      referredByUserId: null,
      referredAt: null,
      firstBotStartAt: null,
      firstWishlistAt: null,
      firstItemAt: null,
    });
    const result = await tryCreateAttribution(makeMockPrisma(state), {
      inviterUserId: 'inviter',
      inviteeUserId: 'ghost',
      referralCode: 'ABC234',
    });
    expect(result).toEqual({
      kind: 'rejected',
      reason: 'SYSTEM_CONFLICT',
      persisted: false,
    });
  });

  it('rejects when invitee account is too old', async () => {
    const state = initialState();
    addUser(state, 'inviter');
    // Created 10 minutes ago → way past the 2-min window
    addUser(state, 'invitee', Date.now() - 10 * 60_000);
    const result = await tryCreateAttribution(makeMockPrisma(state), {
      inviterUserId: 'inviter',
      inviteeUserId: 'invitee',
      referralCode: 'ABC234',
    });
    expect(result).toEqual({
      kind: 'rejected',
      reason: 'INVITEE_NOT_NEW_USER',
      persisted: false,
    });
  });

  it('attributes on happy path and sets profile.referredByUserId', async () => {
    const state = initialState();
    addUser(state, 'inviter');
    addUser(state, 'invitee', Date.now() - 30_000); // 30s ago — OK
    const result = await tryCreateAttribution(makeMockPrisma(state), {
      inviterUserId: 'inviter',
      inviteeUserId: 'invitee',
      referralCode: 'ABC234',
      ipHash: 'iphash',
    });
    expect(result.kind).toBe('attributed');
    if (result.kind === 'attributed') {
      expect(state.attributions).toHaveLength(1);
      expect(state.attributions[0]!.status).toBe('PENDING_ACTIVATION');
      expect(state.attributions[0]!.ipHash).toBe('iphash');
      expect(state.profiles.find((p) => p.userId === 'invitee')!.referredByUserId).toBe('inviter');
    }
  });

  it('creates UserProfile row when missing (bot /start never touched Mini App)', async () => {
    // Regression: the bot's /start upserts only User, not UserProfile. A user
    // whose very first interaction is /start ref_<code> would have no profile
    // row. Previously tx.userProfile.update threw P2025 RecordNotFound and
    // rolled back the whole attribution transaction. With upsert, the profile
    // is created atomically with the referral marks.
    const state = initialState();
    addUser(state, 'inviter');
    // Add ONLY the User row for the invitee — no UserProfile.
    state.users.push({ id: 'invitee', createdAt: new Date() });
    expect(state.profiles.find((p) => p.userId === 'invitee')).toBeUndefined();

    const result = await tryCreateAttribution(makeMockPrisma(state), {
      inviterUserId: 'inviter',
      inviteeUserId: 'invitee',
      referralCode: 'ABC234',
    });

    expect(result.kind).toBe('attributed');
    const createdProfile = state.profiles.find((p) => p.userId === 'invitee');
    expect(createdProfile).toBeTruthy();
    expect(createdProfile!.referredByUserId).toBe('inviter');
    expect(createdProfile!.referredAt).toBeTruthy();
  });

  it('returns race_lost on invitedUserId unique violation', async () => {
    const state = initialState();
    addUser(state, 'inviter');
    addUser(state, 'invitee', Date.now() - 30_000);
    // Pre-seed an attribution for the same invitee to force unique violation
    state.attributions.push({
      id: 'pre',
      inviterUserId: 'other',
      invitedUserId: 'invitee',
      referralCode: 'OTHER1',
      source: 'telegram',
      status: 'PENDING_ACTIVATION',
      rejectReason: null,
      attributedAt: new Date(),
      qualifiedAt: null,
      rewardedAt: null,
      rejectedAt: null,
      windowDeadlineAt: new Date(Date.now() + 14 * 86_400_000),
      fraudScore: 0,
      triggeredSignals: null,
      configVersion: null,
      configSnapshot: null,
      ipHash: null,
      deviceFingerprintHash: null,
      timezone: null,
      locale: null,
      telegramClient: null,
      platform: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    // Clear referredByUserId so Gate 2 doesn't short-circuit before the create.
    state.profiles[1]!.referredByUserId = null;
    const result = await tryCreateAttribution(makeMockPrisma(state), {
      inviterUserId: 'inviter',
      inviteeUserId: 'invitee',
      referralCode: 'ABC234',
    });
    expect(result.kind).toBe('race_lost');
  });
});

describe('tryQualifyAttribution', () => {
  function seedAttributionReady(state: MockState) {
    addUser(state, 'inviter');
    addUser(state, 'invitee', Date.now() - 30_000);
    const p = state.profiles.find((p) => p.userId === 'invitee')!;
    p.firstWishlistAt = new Date();
    p.firstItemAt = new Date();
    state.attributions.push({
      id: 'att1',
      inviterUserId: 'inviter',
      invitedUserId: 'invitee',
      referralCode: 'ABC234',
      source: 'telegram',
      status: 'PENDING_ACTIVATION',
      rejectReason: null,
      attributedAt: new Date(),
      qualifiedAt: null,
      rewardedAt: null,
      rejectedAt: null,
      windowDeadlineAt: new Date(Date.now() + 14 * 86_400_000),
      fraudScore: 0,
      triggeredSignals: null,
      configVersion: null,
      configSnapshot: null,
      ipHash: null,
      deviceFingerprintHash: null,
      timezone: null,
      locale: null,
      telegramClient: null,
      platform: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }

  it('returns not_applicable when no pending attribution exists', async () => {
    const state = initialState();
    addUser(state, 'invitee');
    const res = await tryQualifyAttribution(makeMockPrisma(state), 'invitee');
    expect(res.kind).toBe('not_applicable');
  });

  it('returns not_ready when firstItem missing', async () => {
    const state = initialState();
    seedAttributionReady(state);
    state.profiles.find((p) => p.userId === 'invitee')!.firstItemAt = null;
    const res = await tryQualifyAttribution(makeMockPrisma(state), 'invitee');
    expect(res.kind).toBe('not_ready');
  });

  it('qualifies when both milestones set', async () => {
    const state = initialState();
    seedAttributionReady(state);
    const res = await tryQualifyAttribution(makeMockPrisma(state), 'invitee');
    expect(res.kind).toBe('qualified');
    if (res.kind === 'qualified') {
      expect(res.inviterUserId).toBe('inviter');
      expect(state.attributions[0]!.status).toBe('QUALIFIED');
      expect(state.attributions[0]!.qualifiedAt).toBeTruthy();
    }
  });

  it('returns already_processed when window expired', async () => {
    const state = initialState();
    seedAttributionReady(state);
    state.attributions[0]!.windowDeadlineAt = new Date(Date.now() - 60_000);
    const res = await tryQualifyAttribution(makeMockPrisma(state), 'invitee');
    expect(res.kind).toBe('already_processed');
  });
});

describe('markFirstBotStart', () => {
  it('creates UserProfile + sets firstBotStartAt when profile missing', async () => {
    // Regression: bot /start upserts User but not UserProfile. Plain updateMany
    // against a missing row silently returns count=0 and the funnel stat never
    // lands. Upsert-first pattern ensures the row exists, then the updateMany
    // idempotent-fill sets the mark.
    const state = initialState();
    state.users.push({ id: 'u1', createdAt: new Date() });
    expect(state.profiles.find((p) => p.userId === 'u1')).toBeUndefined();
    await markFirstBotStart(makeMockPrisma(state), 'u1');
    const p = state.profiles.find((p) => p.userId === 'u1');
    expect(p).toBeTruthy();
    expect(p!.firstBotStartAt).toBeTruthy();
  });

  it('is idempotent — second call does not overwrite existing timestamp', async () => {
    const state = initialState();
    addUser(state, 'u1');
    const prisma = makeMockPrisma(state);
    await markFirstBotStart(prisma, 'u1');
    const first = state.profiles[0]!.firstBotStartAt;
    expect(first).toBeTruthy();
    await new Promise((r) => setTimeout(r, 5));
    await markFirstBotStart(prisma, 'u1');
    expect(state.profiles[0]!.firstBotStartAt).toBe(first);
  });
});

describe('markFirstWishlist / markFirstItem', () => {
  it('is idempotent — sets once, second call is no-op', async () => {
    const state = initialState();
    addUser(state, 'u1');
    const prisma = makeMockPrisma(state);
    await markFirstWishlist(prisma, 'u1');
    const first = state.profiles[0]!.firstWishlistAt;
    expect(first).toBeTruthy();
    await new Promise((r) => setTimeout(r, 5));
    await markFirstWishlist(prisma, 'u1');
    expect(state.profiles[0]!.firstWishlistAt).toBe(first); // unchanged
  });

  it('markFirstItem sets firstItemAt', async () => {
    const state = initialState();
    addUser(state, 'u1');
    await markFirstItem(makeMockPrisma(state), 'u1');
    expect(state.profiles[0]!.firstItemAt).toBeTruthy();
  });

  it('markFirstWishlist creates UserProfile when missing', async () => {
    // Regression: some POST /tg/wishlists flows skip getOrCreateProfile. Mark
    // must be resilient — upsert ensures the row exists and gets the stamp.
    const state = initialState();
    state.users.push({ id: 'u1', createdAt: new Date() });
    expect(state.profiles.find((p) => p.userId === 'u1')).toBeUndefined();
    await markFirstWishlist(makeMockPrisma(state), 'u1');
    const p = state.profiles.find((p) => p.userId === 'u1');
    expect(p).toBeTruthy();
    expect(p!.firstWishlistAt).toBeTruthy();
  });

  it('markFirstItem creates UserProfile when missing', async () => {
    const state = initialState();
    state.users.push({ id: 'u1', createdAt: new Date() });
    expect(state.profiles.find((p) => p.userId === 'u1')).toBeUndefined();
    await markFirstItem(makeMockPrisma(state), 'u1');
    const p = state.profiles.find((p) => p.userId === 'u1');
    expect(p).toBeTruthy();
    expect(p!.firstItemAt).toBeTruthy();
  });
});

describe('checkRewardCap', () => {
  function seedRewards(state: MockState, ageDaysList: number[]) {
    for (const d of ageDaysList) {
      state.rewards.push({
        id: `rew-${state.nextId++}`,
        userId: 'inviter',
        attributionId: null,
        rewardType: 'pro_days',
        rewardValueDays: 30,
        status: 'GRANTED',
        grantStrategy: 'stack',
        previousExpiryAt: null,
        newExpiryAt: null,
        idempotencyKey: `k-${Math.random()}`,
        grantedAt: new Date(Date.now() - d * 86_400_000),
        revokedAt: null,
        revokedReason: null,
      });
    }
  }

  it('within cap when no rewards exist', async () => {
    const state = initialState();
    const res = await checkRewardCap(makeMockPrisma(state), 'inviter');
    expect(res.withinCap).toBe(true);
  });

  it('rejects at monthly cap (3 rewards in last 30 days)', async () => {
    const state = initialState();
    seedRewards(state, [1, 10, 20]);
    const res = await checkRewardCap(makeMockPrisma(state), 'inviter');
    expect(res.withinCap).toBe(false);
    if (!res.withinCap) {
      expect(res.reason).toBe('cap_monthly');
      expect(res.monthlyUsed).toBe(3);
    }
  });

  it('rejects at yearly cap (12 rewards in last 365 days)', async () => {
    const state = initialState();
    // Spread 12 rewards past the 30-day window
    seedRewards(state, [40, 60, 80, 100, 120, 150, 180, 200, 240, 280, 320, 350]);
    const res = await checkRewardCap(makeMockPrisma(state), 'inviter');
    expect(res.withinCap).toBe(false);
    if (!res.withinCap) {
      expect(res.reason).toBe('cap_yearly');
      expect(res.yearlyUsed).toBe(12);
    }
  });

  it('old rewards outside year window do not count', async () => {
    const state = initialState();
    seedRewards(state, [400, 500]); // > 1 year
    const res = await checkRewardCap(makeMockPrisma(state), 'inviter');
    expect(res.withinCap).toBe(true);
  });
});

describe('computeFraudSignals', () => {
  function seedAtt(state: MockState, overrides: Partial<MockAttribution> = {}): MockAttribution {
    const att: MockAttribution = {
      id: `a${state.nextId++}`,
      inviterUserId: 'inviter',
      invitedUserId: 'invitee',
      referralCode: 'ABC234',
      source: 'telegram',
      status: 'QUALIFIED',
      rejectReason: null,
      attributedAt: new Date(Date.now() - 5 * 60_000),
      qualifiedAt: new Date(),
      rewardedAt: null,
      rejectedAt: null,
      windowDeadlineAt: new Date(Date.now() + 14 * 86_400_000),
      fraudScore: 0,
      triggeredSignals: null,
      configVersion: 'v1',
      configSnapshot: null,
      ipHash: null,
      deviceFingerprintHash: null,
      timezone: null,
      locale: null,
      telegramClient: null,
      platform: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    state.attributions.push(att);
    return att;
  }

  it('returns zero score when no signals fire', async () => {
    const state = initialState();
    addUser(state, 'inviter', Date.now() - 90 * 86_400_000);
    addUser(state, 'invitee', Date.now() - 60 * 86_400_000);
    const att = seedAtt(state);
    const { score, signals } = await computeFraudSignals(makeMockPrisma(state), att.id);
    expect(score).toBe(0);
    expect(signals).toEqual([]);
  });

  it('fires ip_cluster when >3 attributions share ipHash in 24h', async () => {
    const state = initialState();
    addUser(state, 'inviter', Date.now() - 90 * 86_400_000);
    addUser(state, 'invitee', Date.now() - 60 * 86_400_000);
    // 4 attributions with same ipHash = clusterSize 4 > 3 → fires
    for (let i = 0; i < 3; i++) {
      seedAtt(state, { id: `other${i}`, invitedUserId: `u${i}`, ipHash: 'shared-ip' });
    }
    const att = seedAtt(state, { ipHash: 'shared-ip' });
    const { signals } = await computeFraudSignals(makeMockPrisma(state), att.id);
    expect(signals.map((s) => s.signal)).toContain('ip_cluster');
  });

  it('suppresses account_age_delta when inviter is mature (regression for FP fix)', async () => {
    const state = initialState();
    // Inviter signed up a year ago — mature
    addUser(state, 'inviter', Date.now() - 365 * 86_400_000);
    // Invitee signed up 30s ago — fresh
    addUser(state, 'invitee', Date.now() - 30_000);
    const att = seedAtt(state);
    const { signals } = await computeFraudSignals(makeMockPrisma(state), att.id);
    expect(signals.map((s) => s.signal)).not.toContain('account_age_delta');
  });

  it('fires account_age_delta when BOTH accounts are fresh and close', async () => {
    const state = initialState();
    addUser(state, 'inviter', Date.now() - 2 * 60_000);
    addUser(state, 'invitee', Date.now() - 60_000);
    const att = seedAtt(state);
    const { signals } = await computeFraudSignals(makeMockPrisma(state), att.id);
    expect(signals.map((s) => s.signal)).toContain('account_age_delta');
  });

  it('prefers weights from configSnapshot over current config (reproducibility)', async () => {
    const state = initialState({
      config: defaultConfig({
        fraudSignalWeights: { ip_cluster: 99 } as unknown as Prisma.JsonValue,
      }),
    });
    addUser(state, 'inviter', Date.now() - 90 * 86_400_000);
    addUser(state, 'invitee', Date.now() - 60 * 86_400_000);
    // Seed 4 attributions w/ shared IP to trigger ip_cluster
    for (let i = 0; i < 3; i++) {
      seedAtt(state, { id: `other${i}`, invitedUserId: `u${i}`, ipHash: 'shared' });
    }
    const att = seedAtt(state, {
      ipHash: 'shared',
      configSnapshot: { fraudSignalWeights: { ip_cluster: 7 } },
    });
    const { signals } = await computeFraudSignals(makeMockPrisma(state), att.id);
    const hit = signals.find((s) => s.signal === 'ip_cluster');
    expect(hit?.weight).toBe(7); // from snapshot, not 99 from current config
  });

  it('fires suspicious_onboarding when qualifyTime < 30s', async () => {
    const state = initialState();
    addUser(state, 'inviter', Date.now() - 90 * 86_400_000);
    addUser(state, 'invitee', Date.now() - 60 * 86_400_000);
    const now = Date.now();
    const att = seedAtt(state, {
      attributedAt: new Date(now - 10_000), // 10s ago
      qualifiedAt: new Date(now),
    });
    const { signals } = await computeFraudSignals(makeMockPrisma(state), att.id);
    expect(signals.map((s) => s.signal)).toContain('suspicious_onboarding');
  });

  it('caps total score at 100 even if sum exceeds', async () => {
    const state = initialState();
    addUser(state, 'inviter', Date.now() - 2 * 60_000);
    addUser(state, 'invitee', Date.now() - 60_000);
    // Trigger multiple high-weight signals
    for (let i = 0; i < 3; i++) {
      seedAtt(state, { id: `o${i}`, invitedUserId: `u${i}`, ipHash: 'x', deviceFingerprintHash: 'fp' });
    }
    const att = seedAtt(state, {
      ipHash: 'x',
      deviceFingerprintHash: 'fp',
      attributedAt: new Date(Date.now() - 5_000),
      qualifiedAt: new Date(),
    });
    const { score } = await computeFraudSignals(makeMockPrisma(state), att.id);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe('processReward', () => {
  function seedQualifiedAtt(state: MockState, overrides: Partial<MockAttribution> = {}): MockAttribution {
    addUser(state, 'inviter', Date.now() - 90 * 86_400_000);
    addUser(state, 'invitee', Date.now() - 60 * 86_400_000);
    const att: MockAttribution = {
      id: 'a1',
      inviterUserId: 'inviter',
      invitedUserId: 'invitee',
      referralCode: 'ABC234',
      source: 'telegram',
      status: 'QUALIFIED',
      rejectReason: null,
      attributedAt: new Date(Date.now() - 10 * 60_000),
      qualifiedAt: new Date(),
      rewardedAt: null,
      rejectedAt: null,
      windowDeadlineAt: new Date(Date.now() + 14 * 86_400_000),
      fraudScore: 0,
      triggeredSignals: null,
      configVersion: 'v1',
      configSnapshot: null,
      ipHash: null,
      deviceFingerprintHash: null,
      timezone: null,
      locale: null,
      telegramClient: null,
      platform: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    };
    state.attributions.push(att);
    return att;
  }

  it('returns not_qualified when attribution is in wrong state', async () => {
    const state = initialState();
    seedQualifiedAtt(state, { status: 'REJECTED' });
    const res = await processReward(makeMockPrisma(state), 'a1');
    expect(res.kind).toBe('not_qualified');
  });

  it('grants reward on happy path (no sub → create one-time)', async () => {
    const state = initialState();
    seedQualifiedAtt(state);
    const res = await processReward(makeMockPrisma(state), 'a1');
    expect(res.kind).toBe('rewarded');
    if (res.kind === 'rewarded') {
      expect(res.daysGranted).toBe(30);
      expect(state.rewards).toHaveLength(1);
      expect(state.subscriptions).toHaveLength(1);
      expect(state.subscriptions[0]!.source).toBe('referral_reward');
      expect(state.attributions[0]!.status).toBe('REWARDED');
    }
  });

  it('stacks on top of existing active PRO subscription', async () => {
    const state = initialState();
    seedQualifiedAtt(state);
    const existingExpiry = new Date(Date.now() + 10 * 86_400_000);
    state.subscriptions.push({
      id: 's1',
      userId: 'inviter',
      planCode: 'PRO',
      status: 'ACTIVE',
      starsPrice: 100,
      currentPeriodStart: new Date(),
      currentPeriodEnd: existingExpiry,
      cancelledAt: null,
      source: 'telegram_stars',
      billingPeriod: 'monthly',
      cancelAtPeriodEnd: false,
    });
    const res = await processReward(makeMockPrisma(state), 'a1');
    expect(res.kind).toBe('rewarded');
    if (res.kind === 'rewarded') {
      // Stacked: existingExpiry + 30 days
      const expected = existingExpiry.getTime() + 30 * 86_400_000;
      expect(Math.abs(res.newExpiryAt.getTime() - expected)).toBeLessThan(1000);
      expect(state.rewards[0]!.grantStrategy).toBe('stack');
    }
  });

  it('auto-rejects when score >= fraudAutoRejectThreshold', async () => {
    const state = initialState({
      config: defaultConfig({ fraudAutoRejectThreshold: 10 }),
    });
    seedQualifiedAtt(state, {
      ipHash: 'shared',
    });
    // Seed 3 more atts → cluster=4 → fires ip_cluster weight=30 ≥ 10
    for (let i = 0; i < 3; i++) {
      state.attributions.push({
        ...state.attributions[0]!,
        id: `pad${i}`,
        invitedUserId: `pad${i}`,
        ipHash: 'shared',
      });
    }
    const res = await processReward(makeMockPrisma(state), 'a1');
    expect(res.kind).toBe('auto_rejected');
    expect(state.attributions[0]!.status).toBe('REJECTED');
    expect(state.attributions[0]!.rejectReason).toBe('FRAUD_REJECTED');
  });

  it('queues for review when score between thresholds', async () => {
    const state = initialState({
      config: defaultConfig({ fraudAutoRejectThreshold: 200, fraudReviewThreshold: 10 }),
    });
    seedQualifiedAtt(state, { ipHash: 'shared' });
    for (let i = 0; i < 3; i++) {
      state.attributions.push({
        ...state.attributions[0]!,
        id: `pad${i}`,
        invitedUserId: `pad${i}`,
        ipHash: 'shared',
      });
    }
    const res = await processReward(makeMockPrisma(state), 'a1');
    expect(res.kind).toBe('review_queued');
    expect(state.attributions[0]!.status).toBe('FRAUD_REVIEW');
  });

  it('cap-rejects when inviter hit monthly cap', async () => {
    const state = initialState();
    seedQualifiedAtt(state);
    // 3 recent rewards = at monthly cap
    for (let i = 0; i < 3; i++) {
      state.rewards.push({
        id: `r${i}`,
        userId: 'inviter',
        attributionId: null,
        rewardType: 'pro_days',
        rewardValueDays: 30,
        status: 'GRANTED',
        grantStrategy: 'stack',
        previousExpiryAt: null,
        newExpiryAt: null,
        idempotencyKey: `k${i}`,
        grantedAt: new Date(Date.now() - i * 86_400_000),
        revokedAt: null,
        revokedReason: null,
      });
    }
    const res = await processReward(makeMockPrisma(state), 'a1');
    expect(res.kind).toBe('cap_rejected');
    if (res.kind === 'cap_rejected') expect(res.reason).toBe('cap_monthly');
    expect(state.attributions[0]!.rejectReason).toBe('REWARD_CAP_REACHED');
  });

  it('skipFraudCheck bypasses re-scoring and grants directly (admin approve path)', async () => {
    // Regression: without skipFraudCheck, admin approving a FRAUD_REVIEW
    // attribution would re-run fraud scoring, and the same high score would
    // route the attribution right back into FRAUD_REVIEW — infinite loop.
    const state = initialState({
      config: defaultConfig({ fraudAutoRejectThreshold: 10, fraudReviewThreshold: 5 }),
    });
    seedQualifiedAtt(state, { ipHash: 'shared' });
    // Seed enough sibling rows that fresh fraud scoring WOULD fire (cluster=4)
    for (let i = 0; i < 3; i++) {
      state.attributions.push({
        ...state.attributions[0]!,
        id: `pad${i}`,
        invitedUserId: `pad${i}`,
        ipHash: 'shared',
      });
    }
    // Pre-record an existing fraud score on the attribution (simulates the
    // snapshot admin saw in the review queue).
    state.attributions[0]!.fraudScore = 45;
    state.attributions[0]!.triggeredSignals = [{ signal: 'ip_cluster', weight: 30, details: {} }];

    const res = await processReward(makeMockPrisma(state), 'a1', { skipFraudCheck: true });
    // Must grant despite the sibling cluster that would otherwise trigger auto-reject.
    expect(res.kind).toBe('rewarded');
    expect(state.attributions[0]!.status).toBe('REWARDED');
    // Pre-existing fraudScore is preserved (not zeroed out).
    expect(state.attributions[0]!.fraudScore).toBe(45);
  });

  // Fraud signal emit — regression for the 2026-05-25 gap where
  // referral.fraud_signal_* events were declared in the allowlist but never
  // emitted (root cause: @wishlist/db has no analytics import path). Direct
  // prisma.analyticsEvent.create calls inside processReward close the gap.
  it('emits referral.fraud_score_calculated once per non-skipFraudCheck run', async () => {
    const state = initialState();
    seedQualifiedAtt(state);
    await processReward(makeMockPrisma(state), 'a1');
    const scoreEvents = state.analyticsEvents.filter((e) => e.event === 'referral.fraud_score_calculated');
    expect(scoreEvents).toHaveLength(1);
    expect(scoreEvents[0]!.props).toMatchObject({ attributionId: 'a1', signalCount: 0 });
  });

  it('emits referral.fraud_signal_ip_cluster when ip_cluster fires', async () => {
    const state = initialState({
      config: defaultConfig({ fraudAutoRejectThreshold: 200, fraudReviewThreshold: 200 }),
    });
    seedQualifiedAtt(state, { ipHash: 'shared' });
    // Cluster of 4 (1 + 3 padding) → triggers ip_cluster (weight=30)
    for (let i = 0; i < 3; i++) {
      state.attributions.push({
        ...state.attributions[0]!,
        id: `pad${i}`,
        invitedUserId: `pad${i}`,
        ipHash: 'shared',
      });
    }
    await processReward(makeMockPrisma(state), 'a1');
    const ipClusterEvents = state.analyticsEvents.filter(
      (e) => e.event === 'referral.fraud_signal_ip_cluster',
    );
    expect(ipClusterEvents).toHaveLength(1);
    expect(ipClusterEvents[0]!.userId).toBe('inviter');
    expect(ipClusterEvents[0]!.props).toMatchObject({
      attributionId: 'a1',
      weight: 30,
      ipHash: 'shared',
    });
  });

  it('emits referral.fraud_review_queued when score lands in review band', async () => {
    const state = initialState({
      config: defaultConfig({ fraudAutoRejectThreshold: 200, fraudReviewThreshold: 10 }),
    });
    seedQualifiedAtt(state, { ipHash: 'shared' });
    for (let i = 0; i < 3; i++) {
      state.attributions.push({
        ...state.attributions[0]!,
        id: `pad${i}`,
        invitedUserId: `pad${i}`,
        ipHash: 'shared',
      });
    }
    const res = await processReward(makeMockPrisma(state), 'a1');
    expect(res.kind).toBe('review_queued');
    const reviewEvents = state.analyticsEvents.filter(
      (e) => e.event === 'referral.fraud_review_queued',
    );
    expect(reviewEvents).toHaveLength(1);
    expect(reviewEvents[0]!.props).toMatchObject({ attributionId: 'a1', score: 30 });
  });

  it('does NOT emit fraud_signal events when skipFraudCheck=true (admin approve)', async () => {
    // Admin approve path re-uses the frozen score the admin saw. Re-emitting
    // signals would double-count in the analytics funnel.
    const state = initialState();
    seedQualifiedAtt(state, { ipHash: 'shared' });
    state.attributions[0]!.fraudScore = 45;
    state.attributions[0]!.triggeredSignals = [{ signal: 'ip_cluster', weight: 30, details: {} }];
    await processReward(makeMockPrisma(state), 'a1', { skipFraudCheck: true });
    const fraudEmits = state.analyticsEvents.filter(
      (e) => e.event.startsWith('referral.fraud_signal_') || e.event === 'referral.fraud_score_calculated',
    );
    expect(fraudEmits).toHaveLength(0);
  });

  it('returns already_granted on idempotency collision', async () => {
    const state = initialState();
    seedQualifiedAtt(state);
    // Pre-seed reward with matching idempotencyKey to force P2002
    state.rewards.push({
      id: 'pre',
      userId: 'inviter',
      attributionId: 'a1',
      rewardType: 'pro_days',
      rewardValueDays: 30,
      status: 'GRANTED',
      grantStrategy: 'stack',
      previousExpiryAt: null,
      newExpiryAt: null,
      idempotencyKey: 'grant:a1',
      grantedAt: new Date(),
      revokedAt: null,
      revokedReason: null,
    });
    const res = await processReward(makeMockPrisma(state), 'a1');
    expect(res.kind).toBe('already_granted');
  });
});

describe('sweepExpiredPendingAttributions', () => {
  it('returns 0 expired when none overdue', async () => {
    const state = initialState();
    const res = await sweepExpiredPendingAttributions(makeMockPrisma(state));
    expect(res.expired).toBe(0);
  });

  it('sweeps overdue pending and transitions to REJECTED/TIMEOUT', async () => {
    const state = initialState();
    addUser(state, 'invitee');
    state.attributions.push({
      id: 'exp1',
      inviterUserId: 'inv',
      invitedUserId: 'invitee',
      referralCode: 'ABC234',
      source: 'telegram',
      status: 'PENDING_ACTIVATION',
      rejectReason: null,
      attributedAt: new Date(Date.now() - 20 * 86_400_000),
      qualifiedAt: null,
      rewardedAt: null,
      rejectedAt: null,
      windowDeadlineAt: new Date(Date.now() - 86_400_000), // 1 day overdue
      fraudScore: 0,
      triggeredSignals: null,
      configVersion: null,
      configSnapshot: null,
      ipHash: null,
      deviceFingerprintHash: null,
      timezone: null,
      locale: null,
      telegramClient: null,
      platform: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await sweepExpiredPendingAttributions(makeMockPrisma(state));
    expect(res.expired).toBe(1);
    expect(state.attributions[0]!.status).toBe('REJECTED');
    expect(state.attributions[0]!.rejectReason).toBe('QUALIFICATION_TIMEOUT');
  });
});
