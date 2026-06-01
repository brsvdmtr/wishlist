// Circles (Близкие) — P0.1 service layer.
//
// Owns ALL membership, visibility, capacity and the surprise invariant for
// the Circles feature. Route handlers (routes/circles.routes.ts) stay thin:
// read params, call a function here, shape the response. State transitions
// (CircleMembership.status ACTIVE↔LEFT, CircleInvite.revokedAt) live here, not
// in route bodies, per API_ARCHITECTURE_RULES.
//
// ── The surprise invariant (crown jewel) ────────────────────────────────────
// The wishlist OWNER must never learn who reserved their wishes, even inside a
// circle. This is a RULE, not a setting. `mapCircleItemForViewer` strips ALL
// reservation state when the viewer is the list owner — so the client
// physically never receives it. Mirrors the SecretReservation predicate
// ("viewer is owner → strip"). Covered by unit + integration tests.
//
// Display name in the Mini App is «Близкие»; internal names stay `circle`.

import { randomBytes } from 'node:crypto';

import { prisma } from '@wishlist/db';

import { getEffectiveEntitlements } from './entitlement';
import { daysUntilNextBirthday } from './birthday-reminders';

// ── Constants & validation ───────────────────────────────────────────────────

export const CIRCLE_TYPES = ['FAMILY', 'FRIENDS', 'COLLEAGUES', 'COUPLE'] as const;
export type CircleTypeValue = (typeof CIRCLE_TYPES)[number];
const CIRCLE_TYPE_SET = new Set<string>(CIRCLE_TYPES);

const NAME_MAX = 60;
const EMOJI_MAX = 16; // a few codepoints (some emoji are multi-codepoint)
export const INVITE_TTL_DAYS = 30;
// Anti-abuse ceiling on circles one user can own. Generous — real users have a
// handful; this only stops a script from minting thousands. Not a monetized
// limit (FREE/PRO differ on circle SIZE via `participants`, not circle count).
export const MAX_OWNED_CIRCLES = 50;

/** Typed failure the routes translate to an HTTP status (or a paywall). */
export class CircleError extends Error {
  constructor(
    public code: string,
    public httpStatus: number,
    public meta?: Record<string, unknown>,
  ) {
    super(code);
    this.name = 'CircleError';
  }
}

export function normalizeCircleName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) throw new CircleError('invalid_name', 400);
  if (trimmed.length > NAME_MAX) throw new CircleError('invalid_name', 400, { max: NAME_MAX });
  return trimmed;
}

export function normalizeCircleType(type: unknown): CircleTypeValue {
  if (typeof type !== 'string' || !CIRCLE_TYPE_SET.has(type)) {
    throw new CircleError('invalid_type', 400, { allowed: CIRCLE_TYPES });
  }
  return type as CircleTypeValue;
}

export function normalizeEmoji(emoji: unknown): string | null {
  if (emoji == null) return null;
  if (typeof emoji !== 'string') return null;
  const trimmed = emoji.trim();
  if (!trimmed) return null;
  // Count UTF-16 code units defensively; emoji can be multi-codepoint.
  return [...trimmed].slice(0, EMOJI_MAX).join('');
}

/** url-safe, ~16 chars, [A-Za-z0-9_-]. Matches the frontend `circ_` parser. */
export function generateInviteToken(): string {
  return randomBytes(12).toString('base64url');
}

// ── Surprise invariant + item shaping (pure, unit-tested) ─────────────────────

export interface CircleItemInput {
  id: string;
  title: string;
  url: string | null;
  priceText: string | null;
  currency: string | null;
  imageUrl: string | null;
  priority: string | null;
  description: string | null;
  categoryId: string | null;
}

export interface CircleItemView {
  id: string;
  title: string;
  url: string | null;
  priceText: string | null;
  currency: string | null;
  imageUrl: string | null;
  priority: string | null;
  description: string | null;
  categoryId: string | null;
  reserved: boolean;
  reservedByMe: boolean;
}

/**
 * Shape one item for a circle viewer, enforcing the surprise invariant.
 *
 * Reservation state is passed in by the caller and derived from
 * `CircleReservation` — NEVER from the public `Item.status` (which would leak
 * non-circle reservations and isn't the circle's source of truth). If the
 * viewer IS the list owner, every reservation signal is stripped — the owner
 * sees their own wishes as if untouched, preserving the surprise. For anyone
 * else, the binary `reserved` is exposed (so gifts aren't doubled) but the
 * reserver's identity is NEVER carried — only the viewer's own `reservedByMe`.
 */
export function mapCircleItemForViewer(
  item: CircleItemInput,
  viewerId: string,
  ownerId: string,
  reservation: { reserved: boolean; reservedByMe: boolean },
): CircleItemView {
  const base = {
    id: item.id,
    title: item.title,
    url: item.url,
    priceText: item.priceText,
    currency: item.currency,
    imageUrl: item.imageUrl,
    priority: item.priority,
    description: item.description,
    categoryId: item.categoryId,
  };
  if (viewerId === ownerId) {
    // Owner viewing own list — surprise preserved, no reservation state at all.
    return { ...base, reserved: false, reservedByMe: false };
  }
  return { ...base, reserved: reservation.reserved, reservedByMe: reservation.reservedByMe };
}

/** Item statuses visible inside a circle (active wishes only). */
const VISIBLE_ITEM_STATUSES = ['AVAILABLE', 'RESERVED', 'PURCHASED'] as const;

// ── Member display helpers ────────────────────────────────────────────────────

// Only the fields memberDisplayName actually reads — callers pass richer
// profile selects (avatarUrl, birthday); width subtyping accepts the excess.
interface MemberUserShape {
  firstName: string | null;
  profile: { displayName: string | null } | null;
}

function memberDisplayName(user: MemberUserShape): string {
  return user.profile?.displayName?.trim() || user.firstName?.trim() || 'Кто-то';
}

// ── Capacity ──────────────────────────────────────────────────────────────────

/**
 * Circle size cap = the OWNER's plan participant limit (FREE 10 / PRO 20).
 * Reuses the existing `participants` entitlement per the P0.1 spec.
 */
export async function getCircleCapacity(ownerId: string): Promise<number> {
  // getEffectiveEntitlements auto-resolves god-mode from the env allowlist
  // (the deprecated User.godMode DB column is not authoritative).
  const ent = await getEffectiveEntitlements(ownerId);
  return ent.plan.participants;
}

function countActiveMembers(circleId: string): Promise<number> {
  return prisma.circleMembership.count({ where: { circleId, status: 'ACTIVE' } });
}

// ── Membership guard ──────────────────────────────────────────────────────────

interface MembershipContext {
  role: 'OWNER' | 'MEMBER';
  ownerId: string;
}

async function requireActiveMember(circleId: string, userId: string): Promise<MembershipContext> {
  const m = await prisma.circleMembership.findUnique({
    where: { circleId_userId: { circleId, userId } },
    select: { status: true, role: true, circle: { select: { ownerId: true } } },
  });
  if (!m || m.status !== 'ACTIVE') throw new CircleError('not_member', 403);
  return { role: m.role, ownerId: m.circle.ownerId };
}

// ── Create ──────────────────────────────────────────────────────────────────

export async function createCircle(params: {
  ownerId: string;
  name: unknown;
  type: unknown;
  emoji?: unknown;
}): Promise<{ id: string; name: string; type: CircleTypeValue; emoji: string | null }> {
  const name = normalizeCircleName(params.name);
  const type = normalizeCircleType(params.type);
  const emoji = normalizeEmoji(params.emoji);

  const owned = await prisma.circle.count({ where: { ownerId: params.ownerId } });
  if (owned >= MAX_OWNED_CIRCLES) {
    throw new CircleError('too_many_circles', 409, { max: MAX_OWNED_CIRCLES });
  }

  const circle = await prisma.circle.create({
    data: {
      name,
      type,
      emoji,
      ownerId: params.ownerId,
      memberships: { create: { userId: params.ownerId, role: 'OWNER', status: 'ACTIVE' } },
    },
    select: { id: true, name: true, type: true, emoji: true },
  });
  return { id: circle.id, name: circle.name, type: circle.type as CircleTypeValue, emoji: circle.emoji };
}

// ── Invites ───────────────────────────────────────────────────────────────────

/**
 * Returns the circle's active invite link, creating one if none exists.
 * CAPACITY-GATED (AC#5): if the circle is already at the owner's plan limit,
 * throws `circle_capacity_reached` (the route turns it into a 402 paywall) —
 * the link is not handed out, so the invite "doesn't go out until upgrade".
 */
export async function getOrCreateActiveInvite(params: {
  circleId: string;
  actorId: string;
}): Promise<{ token: string; expiresAt: Date | null; memberCount: number; capacity: number }> {
  const ctx = await requireActiveMember(params.circleId, params.actorId);

  const [memberCount, capacity] = await Promise.all([
    countActiveMembers(params.circleId),
    getCircleCapacity(ctx.ownerId),
  ]);
  if (memberCount >= capacity) {
    throw new CircleError('circle_capacity_reached', 402, { capacity, current: memberCount });
  }

  const now = new Date();
  const existing = await prisma.circleInvite.findFirst({
    where: {
      circleId: params.circleId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { createdAt: 'desc' },
    select: { token: true, expiresAt: true },
  });
  if (existing) return { token: existing.token, expiresAt: existing.expiresAt, memberCount, capacity };

  const expiresAt = new Date(now.getTime() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  const created = await prisma.circleInvite.create({
    data: { token: generateInviteToken(), circleId: params.circleId, createdBy: params.actorId, expiresAt },
    select: { token: true, expiresAt: true },
  });
  return { token: created.token, expiresAt: created.expiresAt, memberCount, capacity };
}

async function findValidInvite(token: string) {
  const now = new Date();
  const invite = await prisma.circleInvite.findFirst({
    where: { token, revokedAt: null, OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
    select: { token: true, circleId: true, createdBy: true },
  });
  if (!invite) throw new CircleError('invite_invalid', 404);
  return invite;
}

export interface InvitePreview {
  circleId: string;
  name: string;
  type: CircleTypeValue;
  emoji: string | null;
  memberCount: number;
  members: Array<{ name: string; avatarUrl: string | null }>;
  invitedBy: string | null;
  alreadyMember: boolean;
}

/** Preview shown to an invitee before they tap «Вступить» (frame C1). */
export async function getInvitePreview(params: { token: string; viewerId: string }): Promise<InvitePreview> {
  const invite = await findValidInvite(params.token);
  const circle = await prisma.circle.findUnique({
    where: { id: invite.circleId },
    select: { id: true, name: true, type: true, emoji: true },
  });
  if (!circle) throw new CircleError('invite_invalid', 404);

  const members = await prisma.circleMembership.findMany({
    where: { circleId: circle.id, status: 'ACTIVE' },
    orderBy: { joinedAt: 'asc' },
    take: 8,
    select: { userId: true, user: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } } },
  });
  const memberCount = await countActiveMembers(circle.id);

  const inviter = await prisma.user.findUnique({
    where: { id: invite.createdBy },
    select: { firstName: true, profile: { select: { displayName: true } } },
  });

  return {
    circleId: circle.id,
    name: circle.name,
    type: circle.type as CircleTypeValue,
    emoji: circle.emoji,
    memberCount,
    members: members.map((m) => ({ name: memberDisplayName(m.user), avatarUrl: m.user.profile?.avatarUrl ?? null })),
    invitedBy: inviter ? (inviter.profile?.displayName?.trim() || inviter.firstName?.trim() || null) : null,
    alreadyMember: members.some((m) => m.userId === params.viewerId),
  };
}

// ── Join ──────────────────────────────────────────────────────────────────────

export interface JoinResult {
  circle: { id: string; name: string; type: CircleTypeValue; emoji: string | null; ownerId: string };
  isNew: boolean; // a membership transition happened (new join or rejoin)
  alreadyMember: boolean;
}

/**
 * Join via invite token. Idempotent by (circleId, userId): re-tapping a link
 * the user already joined returns the existing membership without change.
 * A LEFT membership is reactivated. CAPACITY backstop (race for the last slot):
 * a new/reactivating join past the owner's limit throws `circle_full` (409) —
 * informational to the joiner; the owner is the one who must upgrade.
 */
export async function joinByToken(params: { token: string; userId: string }): Promise<JoinResult> {
  const invite = await findValidInvite(params.token);
  const circle = await prisma.circle.findUnique({
    where: { id: invite.circleId },
    select: { id: true, name: true, type: true, emoji: true, ownerId: true },
  });
  if (!circle) throw new CircleError('invite_invalid', 404);

  const shaped = {
    id: circle.id,
    name: circle.name,
    type: circle.type as CircleTypeValue,
    emoji: circle.emoji,
    ownerId: circle.ownerId,
  };

  const result = await prisma.$transaction(async (tx) => {
    // Serialize concurrent joins to THIS circle so the capacity check below is
    // race-free: two users racing for the last slot can't both read
    // activeCount < limit. The row lock is released at transaction end.
    await tx.$queryRaw`SELECT id FROM "Circle" WHERE id = ${circle.id} FOR UPDATE`;

    const existing = await tx.circleMembership.findUnique({
      where: { circleId_userId: { circleId: circle.id, userId: params.userId } },
      select: { id: true, status: true },
    });
    if (existing && existing.status === 'ACTIVE') {
      return { isNew: false, alreadyMember: true };
    }

    // New join or reactivating a LEFT membership — both consume a slot.
    const activeCount = await tx.circleMembership.count({ where: { circleId: circle.id, status: 'ACTIVE' } });
    const ent = await getEffectiveEntitlements(circle.ownerId); // auto-resolves env god-mode
    if (activeCount >= ent.plan.participants) {
      throw new CircleError('circle_full', 409, { capacity: ent.plan.participants, current: activeCount });
    }

    if (existing) {
      await tx.circleMembership.update({
        where: { id: existing.id },
        data: { status: 'ACTIVE', role: 'MEMBER', leftAt: null, joinedAt: new Date() },
      });
    } else {
      await tx.circleMembership.create({
        data: { circleId: circle.id, userId: params.userId, role: 'MEMBER', status: 'ACTIVE' },
      });
    }
    return { isNew: true, alreadyMember: false };
  });

  return { circle: shaped, isNew: result.isNew, alreadyMember: result.alreadyMember };
}

// ── Leave / remove / delete ─────────────────────────────────────────────────

export async function leaveCircle(params: { circleId: string; userId: string }): Promise<void> {
  const m = await prisma.circleMembership.findUnique({
    where: { circleId_userId: { circleId: params.circleId, userId: params.userId } },
    select: { id: true, status: true, role: true },
  });
  if (!m || m.status !== 'ACTIVE') return; // idempotent
  if (m.role === 'OWNER') throw new CircleError('owner_cannot_leave', 409);
  await prisma.circleMembership.update({ where: { id: m.id }, data: { status: 'LEFT', leftAt: new Date() } });
}

export async function removeMember(params: {
  circleId: string;
  actorId: string;
  targetUserId: string;
}): Promise<void> {
  const ctx = await requireActiveMember(params.circleId, params.actorId);
  if (ctx.role !== 'OWNER') throw new CircleError('forbidden', 403);
  if (params.targetUserId === ctx.ownerId) throw new CircleError('cannot_remove_owner', 409);
  await prisma.circleMembership.updateMany({
    where: { circleId: params.circleId, userId: params.targetUserId, status: 'ACTIVE' },
    data: { status: 'LEFT', leftAt: new Date() },
  });
}

export async function deleteCircle(params: { circleId: string; actorId: string }): Promise<void> {
  const ctx = await requireActiveMember(params.circleId, params.actorId);
  if (ctx.role !== 'OWNER') throw new CircleError('forbidden', 403);
  await prisma.circle.delete({ where: { id: params.circleId } });
}

// ── Read models ───────────────────────────────────────────────────────────────

export interface CircleListEntry {
  id: string;
  name: string;
  type: CircleTypeValue;
  emoji: string | null;
  role: 'OWNER' | 'MEMBER';
  memberCount: number;
  members: Array<{ name: string; avatarUrl: string | null }>;
  nextEvent: { name: string; daysUntil: number } | null;
}

export async function listMyCircles(userId: string): Promise<CircleListEntry[]> {
  const memberships = await prisma.circleMembership.findMany({
    where: { userId, status: 'ACTIVE' },
    select: { role: true, circle: { select: { id: true, name: true, type: true, emoji: true } } },
  });
  if (memberships.length === 0) return [];

  const circleIds = memberships.map((m) => m.circle.id);
  const allMembers = await prisma.circleMembership.findMany({
    where: { circleId: { in: circleIds }, status: 'ACTIVE' },
    select: {
      circleId: true,
      userId: true,
      joinedAt: true,
      user: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true, birthday: true } } } },
    },
    orderBy: { joinedAt: 'asc' },
  });

  const byCircle = new Map<string, typeof allMembers>();
  for (const m of allMembers) {
    const arr = byCircle.get(m.circleId) ?? [];
    arr.push(m);
    byCircle.set(m.circleId, arr);
  }

  const now = new Date();
  const entries = memberships.map((ms) => {
    const members = byCircle.get(ms.circle.id) ?? [];
    // Nearest event among OTHER members (you don't gift yourself).
    let nextEvent: { name: string; daysUntil: number } | null = null;
    for (const m of members) {
      if (m.userId === userId) continue;
      const d = daysUntilNextBirthday(m.user.profile?.birthday ?? null, now);
      if (d == null) continue;
      if (!nextEvent || d < nextEvent.daysUntil) nextEvent = { name: memberDisplayName(m.user), daysUntil: d };
    }
    return {
      id: ms.circle.id,
      name: ms.circle.name,
      type: ms.circle.type as CircleTypeValue,
      emoji: ms.circle.emoji,
      role: ms.role,
      memberCount: members.length,
      members: members.slice(0, 5).map((m) => ({ name: memberDisplayName(m.user), avatarUrl: m.user.profile?.avatarUrl ?? null })),
      nextEvent,
    };
  });

  // Circles with a soon event float up; ties + no-event keep insertion order.
  entries.sort((a, b) => {
    if (a.nextEvent && b.nextEvent) return a.nextEvent.daysUntil - b.nextEvent.daysUntil;
    if (a.nextEvent) return -1;
    if (b.nextEvent) return 1;
    return 0;
  });
  return entries;
}

export interface CircleMemberView {
  userId: string;
  name: string;
  avatarUrl: string | null;
  role: 'OWNER' | 'MEMBER';
  isMe: boolean;
  sharedListCount: number;
  nextEvent: { daysUntil: number } | null;
}

export interface CircleDetail {
  id: string;
  name: string;
  type: CircleTypeValue;
  emoji: string | null;
  myRole: 'OWNER' | 'MEMBER';
  memberCount: number;
  capacity: number;
  members: CircleMemberView[];
}

export async function getCircleDetail(params: { circleId: string; viewerId: string }): Promise<CircleDetail> {
  const ctx = await requireActiveMember(params.circleId, params.viewerId);
  const circle = await prisma.circle.findUnique({
    where: { id: params.circleId },
    select: { id: true, name: true, type: true, emoji: true, ownerId: true },
  });
  if (!circle) throw new CircleError('not_found', 404);

  const members = await prisma.circleMembership.findMany({
    where: { circleId: params.circleId, status: 'ACTIVE' },
    orderBy: { joinedAt: 'asc' },
    select: {
      userId: true,
      role: true,
      user: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true, birthday: true } } } },
    },
  });

  const shareCounts = await prisma.circleWishlistShare.groupBy({
    by: ['sharedByUserId'],
    where: { circleId: params.circleId },
    _count: { _all: true },
  });
  const sharedByUser = new Map(shareCounts.map((s) => [s.sharedByUserId, s._count._all]));

  const now = new Date();
  const memberViews: CircleMemberView[] = members.map((m) => {
    const d = daysUntilNextBirthday(m.user.profile?.birthday ?? null, now);
    return {
      userId: m.userId,
      name: memberDisplayName(m.user),
      avatarUrl: m.user.profile?.avatarUrl ?? null,
      role: m.role,
      isMe: m.userId === params.viewerId,
      sharedListCount: sharedByUser.get(m.userId) ?? 0,
      nextEvent: d == null ? null : { daysUntil: d },
    };
  });

  // Members with a soon event first (by daysUntil asc), the rest after.
  memberViews.sort((a, b) => {
    if (a.nextEvent && b.nextEvent) return a.nextEvent.daysUntil - b.nextEvent.daysUntil;
    if (a.nextEvent) return -1;
    if (b.nextEvent) return 1;
    return 0;
  });

  const capacity = await getCircleCapacity(circle.ownerId);
  return {
    id: circle.id,
    name: circle.name,
    type: circle.type as CircleTypeValue,
    emoji: circle.emoji,
    myRole: ctx.role,
    memberCount: members.length,
    capacity,
    members: memberViews,
  };
}

export interface MemberWishlistView {
  id: string;
  title: string;
  emoji: string | null;
  /** Owner's categories in their configured order (sortOrder); items carry categoryId. */
  categories: { id: string; name: string }[];
  items: CircleItemView[];
}

/**
 * A member's wishlists as shared into this circle, with items shaped through
 * the surprise invariant. When `memberId === viewerId` the viewer is looking
 * at their own list inside the circle (frame F2) — reservation state is
 * stripped by `mapCircleItemForViewer`.
 */
export async function getMemberWishlistsForViewer(params: {
  circleId: string;
  viewerId: string;
  memberId: string;
}): Promise<{ member: { name: string; avatarUrl: string | null }; wishlists: MemberWishlistView[]; isSelf: boolean }> {
  await requireActiveMember(params.circleId, params.viewerId);
  // Target must also be an active member, else their lists aren't in the circle.
  const target = await prisma.circleMembership.findUnique({
    where: { circleId_userId: { circleId: params.circleId, userId: params.memberId } },
    select: {
      status: true,
      user: { select: { firstName: true, profile: { select: { displayName: true, avatarUrl: true } } } },
    },
  });
  if (!target || target.status !== 'ACTIVE') throw new CircleError('not_member', 404);

  const shares = await prisma.circleWishlistShare.findMany({
    where: { circleId: params.circleId, wishlist: { ownerId: params.memberId } },
    select: {
      wishlist: {
        select: {
          id: true,
          title: true,
          emoji: true,
          ownerId: true,
          // Owner's categories, in their configured order — mirrored into the circle view.
          categories: {
            orderBy: { sortOrder: 'asc' },
            select: { id: true, name: true },
          },
          items: {
            where: { status: { in: [...VISIBLE_ITEM_STATUSES] } },
            orderBy: [{ priority: 'desc' }, { position: 'asc' }],
            select: {
              id: true,
              title: true,
              url: true,
              priceText: true,
              currency: true,
              imageUrl: true,
              priority: true,
              description: true,
              categoryId: true,
            },
          },
        },
      },
    },
  });

  // Reservation state comes from CircleReservation (owner-invisible by design),
  // NOT the public Item.status. One query for all items on this member's lists.
  const itemIds = shares.flatMap((s) => s.wishlist.items.map((it) => it.id));
  const reservations = itemIds.length
    ? await prisma.circleReservation.findMany({
        where: { itemId: { in: itemIds } },
        select: { itemId: true, reserverUserId: true },
      })
    : [];
  const reservedItems = new Set(reservations.map((r) => r.itemId));
  const myReservedItems = new Set(
    reservations.filter((r) => r.reserverUserId === params.viewerId).map((r) => r.itemId),
  );

  const wishlists = shares.map((s) => ({
    id: s.wishlist.id,
    title: s.wishlist.title,
    emoji: s.wishlist.emoji,
    categories: s.wishlist.categories,
    items: s.wishlist.items.map((it) =>
      mapCircleItemForViewer(it, params.viewerId, s.wishlist.ownerId, {
        reserved: reservedItems.has(it.id),
        reservedByMe: myReservedItems.has(it.id),
      }),
    ),
  }));

  return {
    member: {
      name: memberDisplayName(target.user),
      avatarUrl: target.user.profile?.avatarUrl ?? null,
    },
    wishlists,
    isSelf: params.viewerId === params.memberId,
  };
}

// ── Per-circle wishlist visibility (privacy, frame E) ─────────────────────────

export interface ShareOption {
  wishlistId: string;
  title: string;
  emoji: string | null;
  itemCount: number;
  shared: boolean;
}

export async function getMyShares(params: { circleId: string; userId: string }): Promise<ShareOption[]> {
  await requireActiveMember(params.circleId, params.userId);
  const [wishlists, shared] = await Promise.all([
    prisma.wishlist.findMany({
      where: { ownerId: params.userId, type: 'REGULAR' },
      orderBy: { position: 'asc' },
      select: { id: true, title: true, emoji: true, _count: { select: { items: true } } },
    }),
    prisma.circleWishlistShare.findMany({
      where: { circleId: params.circleId, sharedByUserId: params.userId },
      select: { wishlistId: true },
    }),
  ]);
  const sharedSet = new Set(shared.map((s) => s.wishlistId));
  return wishlists.map((w) => ({
    wishlistId: w.id,
    title: w.title,
    emoji: w.emoji,
    itemCount: w._count.items,
    shared: sharedSet.has(w.id),
  }));
}

/** Replace the set of the caller's wishlists shared into this circle. */
export async function setMyShares(params: {
  circleId: string;
  userId: string;
  wishlistIds: unknown;
}): Promise<{ shared: string[] }> {
  await requireActiveMember(params.circleId, params.userId);
  const requested = Array.isArray(params.wishlistIds)
    ? params.wishlistIds.filter((x): x is string => typeof x === 'string')
    : [];

  // Only the caller's own wishlists may be shared.
  const owned = requested.length
    ? await prisma.wishlist.findMany({
        where: { id: { in: requested }, ownerId: params.userId, type: 'REGULAR' },
        select: { id: true },
      })
    : [];
  const toShare = owned.map((w) => w.id);

  await prisma.$transaction([
    prisma.circleWishlistShare.deleteMany({ where: { circleId: params.circleId, sharedByUserId: params.userId } }),
    ...toShare.map((wishlistId) =>
      prisma.circleWishlistShare.create({
        data: { circleId: params.circleId, wishlistId, sharedByUserId: params.userId },
      }),
    ),
  ]);

  return { shared: toShare };
}

// ── Circle reservations (surprise-preserving, free, no owner notification) ────

/**
 * Reserve a co-member's circle-shared wish. Creates a CircleReservation —
 * NEVER touches Item.status and NEVER notifies the owner, so the surprise holds
 * (unlike the public `POST /tg/items/:id/reserve`). Idempotent per (item, user).
 */
export async function reserveInCircle(params: { circleId: string; viewerId: string; itemId: string }): Promise<void> {
  await requireActiveMember(params.circleId, params.viewerId);

  const item = await prisma.item.findUnique({
    where: { id: params.itemId },
    select: { id: true, status: true, wishlistId: true, wishlist: { select: { ownerId: true } } },
  });
  if (!item) throw new CircleError('item_not_found', 404);
  if (item.wishlist.ownerId === params.viewerId) throw new CircleError('own_item', 403);
  if (item.status === 'ARCHIVED' || item.status === 'DELETED') throw new CircleError('item_unavailable', 409);

  // The item must be visible to the viewer THROUGH this circle — i.e. its owner
  // shared the list here. Prevents reserving an item you can't legitimately see.
  const share = await prisma.circleWishlistShare.findUnique({
    where: { circleId_wishlistId: { circleId: params.circleId, wishlistId: item.wishlistId } },
    select: { id: true },
  });
  if (!share) throw new CircleError('not_visible', 403);

  await prisma.circleReservation.upsert({
    where: { itemId_reserverUserId: { itemId: params.itemId, reserverUserId: params.viewerId } },
    update: { circleId: params.circleId },
    create: { circleId: params.circleId, itemId: params.itemId, reserverUserId: params.viewerId },
  });
}

/** Cancel the caller's own circle reservation on an item. Idempotent. */
export async function unreserveInCircle(params: { circleId: string; viewerId: string; itemId: string }): Promise<void> {
  await requireActiveMember(params.circleId, params.viewerId);
  await prisma.circleReservation.deleteMany({
    where: { itemId: params.itemId, reserverUserId: params.viewerId },
  });
}
