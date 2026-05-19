// Recipient selection for the research-survey send loop.
//
// Pipeline (per call to `selectSurveyRecipients`):
//   1. base filter — applied to every candidate
//        - godMode = false
//        - telegramId IS NOT NULL
//        - profile.notifyMarketing = true                     (Wave 1 rule 4)
//        - User.createdAt < NOW() - 7 days                    (rule H: new-user grace)
//        - no prior ResearchSurveyInvite for this surveyId    (rule 1)
//        - no prior completed ResearchSurveyResponse for the same slug (rule 2)
//        - no LifecycleTouch sent in the last 24h             (rule G)
//        - resolveSurveyLocale(...) ∈ {ru, en}                (Wave 1 locale gate)
//
//   2. segment assignment (mutually exclusive, in priority order):
//        S7 (paid)  → S5 (guest reservers)  → S3 (shared)
//        → S1 (activated) → S2 (created, not shared) → S8 (inactive)
//      Each user is assigned to the first matching segment; subsequent
//      segments skip them. This keeps the dataset disjoint without losing
//      the high-value signal from overlapping users.
//
//   3. S8 only: classify into 5 behavioral substrata (opened_only,
//      wishlist_no_item, item_no_share, shared_no_guest_action,
//      activated_then_churned) and stratified-sample down to the cap.
//      Backfill rule: if a substratum has fewer eligible than its even
//      share, redistribute the unused slots proportionally to the
//      remaining substrata's eligibility counts.
//
// Output: `RecipientSelection[]` ready for direct insert into
// ResearchSurveyInvite (one row per user).

import { prisma } from '@wishlist/db';
import { resolveSurveyLocale, type SurveyLocale } from './locale';

export type SegmentId = 'S1' | 'S2' | 'S3' | 'S5' | 'S7' | 'S8';

export type S8Subtype =
  | 'opened_only'
  | 'wishlist_no_item'
  | 'item_no_share'
  | 'shared_no_guest_action'
  | 'activated_then_churned';

export interface RecipientSelection {
  userId: string;
  segmentId: SegmentId;
  segmentSubtype: S8Subtype | null;
  locale: SurveyLocale;
}

export interface SelectionInput {
  surveyId: string;
  surveySlug: string;
  s8Cap: number;
  // Optional deterministic shuffle seed (tests). When null, uses Math.random.
  shuffleSeed?: number;
  // Override "now" for tests.
  now?: Date;
}

export interface SelectionReport {
  recipients: RecipientSelection[];
  countsBySegment: Record<SegmentId, number>;
  s8CountsBySubtype: Record<S8Subtype, number>;
  skipped: {
    /** Base-filter pool size before segment matching. */
    eligible: number;
    /** Eligible but locale didn't resolve to ru/en. */
    nonRuEn: number;
  };
}

// Type used by the substrata classifier — keep minimal so the query stays cheap.
interface S8ClassifierRow {
  userId: string;
  locale: SurveyLocale;
  hasRegularWishlist: boolean;
  hasRealItem: boolean;
  hasShareToken: boolean;
  hasGuestEngagement: boolean;
}

export async function selectSurveyRecipients(input: SelectionInput): Promise<SelectionReport> {
  const now = input.now ?? new Date();
  const recipients: RecipientSelection[] = [];
  const assigned = new Set<string>();
  const countsBySegment: Record<SegmentId, number> = { S1: 0, S2: 0, S3: 0, S5: 0, S7: 0, S8: 0 };
  const s8CountsBySubtype: Record<S8Subtype, number> = {
    opened_only: 0,
    wishlist_no_item: 0,
    item_no_share: 0,
    shared_no_guest_action: 0,
    activated_then_churned: 0,
  };

  const eligiblePool = await loadEligiblePool(input.surveyId, input.surveySlug, now);
  const eligible = eligiblePool.length;
  let nonRuEn = 0;
  const localeByUser = new Map<string, SurveyLocale>();
  const eligibleIds: string[] = [];
  for (const u of eligiblePool) {
    const locale = resolveSurveyLocale({
      profile: u.profile,
      telegramLanguageCode: u.profile?.language ?? undefined,
      marketBucket: u.profile?.marketBucket ?? null,
    });
    if (!locale) {
      nonRuEn += 1;
      continue;
    }
    localeByUser.set(u.id, locale);
    eligibleIds.push(u.id);
  }

  // ── S7 (paid PRO) ──
  const s7 = await querySegmentS7(eligibleIds, now);
  for (const u of s7) {
    if (assigned.has(u)) continue;
    const locale = localeByUser.get(u);
    if (!locale) continue;
    recipients.push({ userId: u, segmentId: 'S7', segmentSubtype: null, locale });
    assigned.add(u);
    countsBySegment.S7 += 1;
  }

  // ── S5 (guest reservers) ──
  const remaining1 = eligibleIds.filter((u) => !assigned.has(u));
  const s5 = await querySegmentS5(remaining1);
  for (const u of s5) {
    if (assigned.has(u)) continue;
    const locale = localeByUser.get(u);
    if (!locale) continue;
    recipients.push({ userId: u, segmentId: 'S5', segmentSubtype: null, locale });
    assigned.add(u);
    countsBySegment.S5 += 1;
  }

  // ── S3 (shared, variant B: shareOpenCount > 0) ──
  const remaining2 = eligibleIds.filter((u) => !assigned.has(u));
  const s3 = await querySegmentS3(remaining2);
  for (const u of s3) {
    if (assigned.has(u)) continue;
    const locale = localeByUser.get(u);
    if (!locale) continue;
    recipients.push({ userId: u, segmentId: 'S3', segmentSubtype: null, locale });
    assigned.add(u);
    countsBySegment.S3 += 1;
  }

  // ── S1 (activated owners) ──
  const remaining3 = eligibleIds.filter((u) => !assigned.has(u));
  const s1 = await querySegmentS1(remaining3);
  for (const u of s1) {
    if (assigned.has(u)) continue;
    const locale = localeByUser.get(u);
    if (!locale) continue;
    recipients.push({ userId: u, segmentId: 'S1', segmentSubtype: null, locale });
    assigned.add(u);
    countsBySegment.S1 += 1;
  }

  // ── S2 (created wishlist, did not share) ──
  const remaining4 = eligibleIds.filter((u) => !assigned.has(u));
  const s2 = await querySegmentS2(remaining4);
  for (const u of s2) {
    if (assigned.has(u)) continue;
    const locale = localeByUser.get(u);
    if (!locale) continue;
    recipients.push({ userId: u, segmentId: 'S2', segmentSubtype: null, locale });
    assigned.add(u);
    countsBySegment.S2 += 1;
  }

  // ── S8 (inactive 30+ days) with behavioral substrata + cap ──
  const remainingForS8 = eligibleIds.filter((u) => !assigned.has(u));
  const s8Candidates = await classifyS8(remainingForS8, now);
  const balanced = stratifiedSample(
    s8Candidates,
    localeByUser,
    input.s8Cap,
    input.shuffleSeed,
  );
  for (const pick of balanced) {
    recipients.push({
      userId: pick.userId,
      segmentId: 'S8',
      segmentSubtype: pick.subtype,
      locale: pick.locale,
    });
    assigned.add(pick.userId);
    countsBySegment.S8 += 1;
    s8CountsBySubtype[pick.subtype] += 1;
  }

  return { recipients, countsBySegment, s8CountsBySubtype, skipped: { eligible, nonRuEn } };
}

// ─────────────────────────────────────────────────────────────────────
// Base filter — eligible pool before segment matching.
// ─────────────────────────────────────────────────────────────────────
async function loadEligiblePool(surveyId: string, surveySlug: string, now: Date) {
  const newUserCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const lifecycleCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return await prisma.user.findMany({
    where: {
      godMode: false,
      telegramId: { not: null },
      createdAt: { lt: newUserCutoff },
      profile: { is: { notifyMarketing: true } },
      researchSurveyInvites: { none: { surveyId } },
      researchSurveyResponses: { none: { survey: { slug: surveySlug } } },
      lifecycleTouches: { none: { sentAt: { gt: lifecycleCutoff } } },
    },
    select: {
      id: true,
      profile: {
        select: {
          languageMode: true,
          manualLanguage: true,
          normalizedLocale: true,
          language: true,
          marketBucket: true,
        },
      },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────
// Per-segment queries (run against the already-base-filtered ID list).
// Each returns a list of userIds in no guaranteed order.
// ─────────────────────────────────────────────────────────────────────
async function querySegmentS7(userIds: string[], now: Date): Promise<string[]> {
  if (userIds.length === 0) return [];
  const subs = await prisma.subscription.findMany({
    where: {
      userId: { in: userIds },
      planCode: 'PRO',
      status: 'ACTIVE',
      currentPeriodEnd: { gt: now },
    },
    select: { userId: true },
    distinct: ['userId'],
  });
  return subs.map((s) => s.userId);
}

async function querySegmentS5(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await prisma.$queryRaw<{ userId: string }[]>`
    SELECT DISTINCT r."reserverUserId" AS "userId"
    FROM "ReservationEvent" r
    JOIN "Item" i ON i.id = r."itemId"
    JOIN "Wishlist" w ON w.id = i."wishlistId"
    WHERE r."reserverUserId" IS NOT NULL
      AND r."reserverUserId" = ANY(${userIds}::text[])
      AND w."ownerId" <> r."reserverUserId"
  `;
  return rows.map((r) => r.userId);
}

async function querySegmentS3(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const lists = await prisma.wishlist.findMany({
    where: {
      ownerId: { in: userIds },
      type: 'REGULAR',
      shareOpenCount: { gt: 0 },
    },
    select: { ownerId: true },
    distinct: ['ownerId'],
  });
  return lists.map((w) => w.ownerId);
}

async function querySegmentS1(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  const items = await prisma.item.findMany({
    where: {
      isDemo: false,
      status: { not: 'DELETED' },
      wishlist: { ownerId: { in: userIds }, type: 'REGULAR', archivedAt: null },
    },
    select: { wishlist: { select: { ownerId: true } } },
  });
  const set = new Set<string>();
  for (const r of items) set.add(r.wishlist.ownerId);
  return [...set];
}

async function querySegmentS2(userIds: string[]): Promise<string[]> {
  if (userIds.length === 0) return [];
  // Has a REGULAR active wishlist AND no shared one.
  const hasWishlist = await prisma.wishlist.findMany({
    where: { ownerId: { in: userIds }, type: 'REGULAR', archivedAt: null },
    select: { ownerId: true },
    distinct: ['ownerId'],
  });
  const candidates = new Set(hasWishlist.map((w) => w.ownerId));
  const shared = await prisma.wishlist.findMany({
    where: { ownerId: { in: [...candidates] }, type: 'REGULAR', shareToken: { not: null } },
    select: { ownerId: true },
    distinct: ['ownerId'],
  });
  for (const w of shared) candidates.delete(w.ownerId);
  return [...candidates];
}

// ─────────────────────────────────────────────────────────────────────
// S8 — classify into 5 behavioral substrata.
// Inactive cutoff: updatedAt < NOW() - 30 days.
// ─────────────────────────────────────────────────────────────────────
async function classifyS8(userIds: string[], now: Date): Promise<{ userId: string; subtype: S8Subtype }[]> {
  if (userIds.length === 0) return [];
  const inactiveCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, updatedAt: { lt: inactiveCutoff } },
    select: {
      id: true,
      wishlists: {
        where: { type: 'REGULAR', archivedAt: null },
        select: {
          shareToken: true,
          shareOpenCount: true,
          items: {
            where: { isDemo: false, status: { not: 'DELETED' } },
            select: { id: true },
            take: 1,
          },
        },
      },
    },
  });

  // Guest engagement check: ReservationMeta where ownerId = user AND active=true.
  // Done in a separate query keyed on the inactive set to keep the user select narrow.
  const inactiveIds = users.map((u) => u.id);
  const guestEngagedSet = new Set<string>();
  if (inactiveIds.length > 0) {
    const rows = await prisma.$queryRaw<{ ownerId: string }[]>`
      SELECT DISTINCT r."ownerId"
      FROM "ReservationMeta" r
      WHERE r."ownerId" = ANY(${inactiveIds}::text[])
        AND r."active" = true
    `;
    for (const r of rows) guestEngagedSet.add(r.ownerId);
  }

  return users.map((u) => {
    const wishlists = u.wishlists;
    const hasRegularWishlist = wishlists.length > 0;
    const hasRealItem = wishlists.some((w) => w.items.length > 0);
    const hasShareToken = wishlists.some((w) => w.shareToken != null);
    const hasShareOpens = wishlists.some((w) => w.shareOpenCount > 0);
    const hasGuestEngagement = hasShareOpens || guestEngagedSet.has(u.id);

    let subtype: S8Subtype;
    if (!hasRegularWishlist) subtype = 'opened_only';
    else if (!hasRealItem) subtype = 'wishlist_no_item';
    else if (!hasShareToken) subtype = 'item_no_share';
    else if (!hasGuestEngagement) subtype = 'shared_no_guest_action';
    else subtype = 'activated_then_churned';

    return { userId: u.id, subtype };
  });
}

// ─────────────────────────────────────────────────────────────────────
// Stratified sampling for S8.
// First pass: take min(cap/5, eligible(subtype)) from each subtype.
// Second pass: distribute leftover capacity to subtypes with surplus,
// proportionally to remaining eligible count.
// Within each subtype: shuffle (seeded if provided), then take N.
// ─────────────────────────────────────────────────────────────────────
function stratifiedSample(
  pool: { userId: string; subtype: S8Subtype }[],
  localeByUser: Map<string, SurveyLocale>,
  cap: number,
  seed: number | undefined,
): { userId: string; subtype: S8Subtype; locale: SurveyLocale }[] {
  if (pool.length === 0 || cap <= 0) return [];

  const buckets: Record<S8Subtype, string[]> = {
    opened_only: [],
    wishlist_no_item: [],
    item_no_share: [],
    shared_no_guest_action: [],
    activated_then_churned: [],
  };
  for (const row of pool) buckets[row.subtype].push(row.userId);

  const subtypes: S8Subtype[] = [
    'opened_only',
    'wishlist_no_item',
    'item_no_share',
    'shared_no_guest_action',
    'activated_then_churned',
  ];

  // Seeded shuffle (mulberry32) — keeps tests deterministic.
  let rngState = seed ?? Math.floor(Math.random() * 2 ** 31);
  const rng = () => {
    rngState = (rngState + 0x6d2b79f5) | 0;
    let t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (const s of subtypes) shuffleInPlace(buckets[s], rng);

  // Pass 1 — even share per subtype.
  const evenShare = Math.floor(cap / subtypes.length);
  const taken: Record<S8Subtype, string[]> = {
    opened_only: [],
    wishlist_no_item: [],
    item_no_share: [],
    shared_no_guest_action: [],
    activated_then_churned: [],
  };
  let consumed = 0;
  for (const s of subtypes) {
    const slot = Math.min(evenShare, buckets[s].length);
    taken[s] = buckets[s].slice(0, slot);
    consumed += slot;
  }

  // Pass 2 — backfill remaining capacity from subtypes with surplus,
  // proportional to remaining-eligible count.
  let remainingCap = cap - consumed;
  while (remainingCap > 0) {
    const candidates = subtypes.filter((s) => taken[s].length < buckets[s].length);
    if (candidates.length === 0) break;
    // Take 1 from the candidate with the most remaining slack — keeps the
    // distribution roughly proportional without floating-point gymnastics.
    candidates.sort(
      (a, b) => (buckets[b].length - taken[b].length) - (buckets[a].length - taken[a].length),
    );
    const pick = candidates[0]!;
    const next = buckets[pick][taken[pick].length];
    if (next == null) break;
    taken[pick].push(next);
    remainingCap -= 1;
  }

  const out: { userId: string; subtype: S8Subtype; locale: SurveyLocale }[] = [];
  for (const s of subtypes) {
    for (const userId of taken[s]) {
      const locale = localeByUser.get(userId);
      if (!locale) continue;
      out.push({ userId, subtype: s, locale });
    }
  }
  return out;
}

function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
}
