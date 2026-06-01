// Integration tests for Circles (Близкие) against real Postgres.
//
// The pure surprise-invariant logic is unit-tested with no DB
// (src/services/circles.service.test.ts). This file covers what a mock can't:
//   • idempotent join (unique(circleId,userId) — re-join is a no-op);
//   • capacity backstop at the owner's FREE plan limit (real count + 409);
//   • the surprise invariant END-TO-END through real Prisma selects
//     (owner-self view strips reservation state; guests see status, not author);
//   • visibility revocation when a member leaves (status=ACTIVE filter).
//
// Auto-skips when DATABASE_URL is not set (local fast path); always runs on CI.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getTestPrisma, disconnectTestPrisma } from '../setup-pg';
import {
  createCircle,
  getOrCreateActiveInvite,
  joinByToken,
  getCircleDetail,
  getMemberWishlistsForViewer,
  leaveCircle,
  removeMember,
  deleteCircle,
  getMyShares,
  setMyShares,
  reserveInCircle,
  unreserveInCircle,
  CircleError,
} from '../../src/services/circles.service';

const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;
const PREFIX = 'int-circles';

if (SKIP) {
  // eslint-disable-next-line no-console
  console.warn('[integration] DATABASE_URL not set — skipping circles integration tests');
}

suite('circles — real Postgres', () => {
  // Resolved lazily in beforeAll (not at suite-collection time) so that, when
  // DATABASE_URL is unset, describe.skip skips this suite cleanly instead of
  // throwing during collection.
  let db: ReturnType<typeof getTestPrisma>;
  let seq = 0;

  async function clean() {
    // Deleting users cascades to owned circles, memberships, wishlists, items.
    await db.user.deleteMany({ where: { telegramId: { startsWith: PREFIX } } });
  }
  async function mkUser(first = 'U') {
    seq += 1;
    return db.user.create({ data: { telegramId: `${PREFIX}-${seq}-${first}`, firstName: `${first}${seq}` } });
  }
  async function mkWishlistWithItem(ownerId: string, opts?: { status?: string; reserverUserId?: string | null }) {
    seq += 1;
    const wl = await db.wishlist.create({
      data: { ownerId, slug: `${PREFIX}-wl-${seq}`, title: `List ${seq}`, type: 'REGULAR' },
    });
    const item = await db.item.create({
      data: {
        wishlistId: wl.id,
        title: `Item ${seq}`,
        url: `https://example.com/${PREFIX}-${seq}`, // Item.url is required (NOT NULL)
        status: (opts?.status as 'AVAILABLE' | 'RESERVED' | 'PURCHASED' | undefined) ?? 'AVAILABLE',
        reserverUserId: opts?.reserverUserId ?? null,
      },
    });
    return { wl, item };
  }

  beforeAll(async () => { db = getTestPrisma(); await clean(); });
  afterAll(async () => { await clean(); await disconnectTestPrisma(); });
  beforeEach(clean);

  it('createCircle makes the creator an ACTIVE OWNER member', async () => {
    const owner = await mkUser('owner');
    const circle = await createCircle({ ownerId: owner.id, name: '  Семья ', type: 'FAMILY', emoji: '🏡' });
    expect(circle.name).toBe('Семья'); // trimmed

    const m = await db.circleMembership.findUnique({
      where: { circleId_userId: { circleId: circle.id, userId: owner.id } },
    });
    expect(m?.role).toBe('OWNER');
    expect(m?.status).toBe('ACTIVE');
  });

  it('join is idempotent by (circle,user) — re-tapping the link does not double-join', async () => {
    const owner = await mkUser('owner');
    const guest = await mkUser('guest');
    const circle = await createCircle({ ownerId: owner.id, name: 'Друзья', type: 'FRIENDS' });
    const invite = await getOrCreateActiveInvite({ circleId: circle.id, actorId: owner.id });

    const first = await joinByToken({ token: invite.token, userId: guest.id });
    expect(first.isNew).toBe(true);
    const second = await joinByToken({ token: invite.token, userId: guest.id });
    expect(second.isNew).toBe(false);
    expect(second.alreadyMember).toBe(true);

    const count = await db.circleMembership.count({ where: { circleId: circle.id, userId: guest.id } });
    expect(count).toBe(1);
  });

  it('reuses one active invite token instead of minting a new one each call', async () => {
    const owner = await mkUser('owner');
    const circle = await createCircle({ ownerId: owner.id, name: 'Семья', type: 'FAMILY' });
    const a = await getOrCreateActiveInvite({ circleId: circle.id, actorId: owner.id });
    const b = await getOrCreateActiveInvite({ circleId: circle.id, actorId: owner.id });
    expect(a.token).toBe(b.token);
  });

  it('blocks the join past the owner FREE participant cap (10) with circle_full', async () => {
    const owner = await mkUser('owner');
    const circle = await createCircle({ ownerId: owner.id, name: 'Семья', type: 'FAMILY' });
    const invite = await getOrCreateActiveInvite({ circleId: circle.id, actorId: owner.id });

    // Owner already occupies slot 1; add members until 10 active, then the 11th fails.
    for (let i = 0; i < 9; i++) {
      const u = await mkUser(`m${i}`);
      await joinByToken({ token: invite.token, userId: u.id });
    }
    expect(await db.circleMembership.count({ where: { circleId: circle.id, status: 'ACTIVE' } })).toBe(10);

    const overflow = await mkUser('overflow');
    await expect(joinByToken({ token: invite.token, userId: overflow.id })).rejects.toMatchObject({
      code: 'circle_full',
      httpStatus: 409,
    });
    await expect(joinByToken({ token: invite.token, userId: overflow.id })).rejects.toBeInstanceOf(CircleError);
  });

  it('SURPRISE INVARIANT: a circle reservation is invisible to the owner, "taken" to co-members', async () => {
    const owner = await mkUser('owner');
    const gifterB = await mkUser('B');
    const gifterC = await mkUser('C');
    const circle = await createCircle({ ownerId: owner.id, name: 'Семья', type: 'FAMILY' });
    const invite = await getOrCreateActiveInvite({ circleId: circle.id, actorId: owner.id });
    await joinByToken({ token: invite.token, userId: gifterB.id });
    await joinByToken({ token: invite.token, userId: gifterC.id });

    const { wl, item } = await mkWishlistWithItem(owner.id);
    await setMyShares({ circleId: circle.id, userId: owner.id, wishlistIds: [wl.id] });

    // B reserves the owner's wish INSIDE the circle.
    await reserveInCircle({ circleId: circle.id, viewerId: gifterB.id, itemId: item.id });

    // Item.status is untouched → nothing leaks via the public reservation path.
    expect((await db.item.findUnique({ where: { id: item.id } }))!.status).toBe('AVAILABLE');

    // B (the reserver) sees reserved + reservedByMe.
    const viewB = await getMemberWishlistsForViewer({ circleId: circle.id, viewerId: gifterB.id, memberId: owner.id });
    expect(viewB.isSelf).toBe(false);
    const itemB = viewB.wishlists[0]!.items[0]!;
    expect(itemB.reserved).toBe(true);
    expect(itemB.reservedByMe).toBe(true);
    expect(itemB).not.toHaveProperty('reserverUserId'); // identity never leaks

    // C (a different gifter) sees it's taken, but NOT who took it.
    const itemC = (await getMemberWishlistsForViewer({ circleId: circle.id, viewerId: gifterC.id, memberId: owner.id })).wishlists[0]!.items[0]!;
    expect(itemC.reserved).toBe(true);
    expect(itemC.reservedByMe).toBe(false);

    // OWNER viewing their OWN list: reservation state fully stripped (the rule).
    const viewOwner = await getMemberWishlistsForViewer({ circleId: circle.id, viewerId: owner.id, memberId: owner.id });
    expect(viewOwner.isSelf).toBe(true);
    const itemOwner = viewOwner.wishlists[0]!.items[0]!;
    expect(itemOwner.reserved).toBe(false);
    expect(itemOwner.reservedByMe).toBe(false);
  });

  it('circle reserve: cannot reserve your own wish; reserve is idempotent; unreserve clears it', async () => {
    const owner = await mkUser('owner');
    const guest = await mkUser('guest');
    const circle = await createCircle({ ownerId: owner.id, name: 'Семья', type: 'FAMILY' });
    const inv = await getOrCreateActiveInvite({ circleId: circle.id, actorId: owner.id });
    await joinByToken({ token: inv.token, userId: guest.id });
    const { wl, item } = await mkWishlistWithItem(owner.id);
    await setMyShares({ circleId: circle.id, userId: owner.id, wishlistIds: [wl.id] });

    // Owner cannot reserve their own wish.
    await expect(reserveInCircle({ circleId: circle.id, viewerId: owner.id, itemId: item.id }))
      .rejects.toMatchObject({ code: 'own_item', httpStatus: 403 });

    // Guest reserves twice (idempotent) → one row; then unreserves → zero.
    await reserveInCircle({ circleId: circle.id, viewerId: guest.id, itemId: item.id });
    await reserveInCircle({ circleId: circle.id, viewerId: guest.id, itemId: item.id });
    expect(await db.circleReservation.count({ where: { itemId: item.id } })).toBe(1);
    await unreserveInCircle({ circleId: circle.id, viewerId: guest.id, itemId: item.id });
    expect(await db.circleReservation.count({ where: { itemId: item.id } })).toBe(0);
  });

  it('a left member disappears from the circle and loses visibility (AC#4)', async () => {
    const owner = await mkUser('owner');
    const guest = await mkUser('guest');
    const circle = await createCircle({ ownerId: owner.id, name: 'Друзья', type: 'FRIENDS' });
    const invite = await getOrCreateActiveInvite({ circleId: circle.id, actorId: owner.id });
    await joinByToken({ token: invite.token, userId: guest.id });

    const { wl } = await mkWishlistWithItem(owner.id);
    await setMyShares({ circleId: circle.id, userId: owner.id, wishlistIds: [wl.id] });

    // Before leaving: guest can see the owner's shared list.
    const before = await getMemberWishlistsForViewer({ circleId: circle.id, viewerId: guest.id, memberId: owner.id });
    expect(before.wishlists.length).toBe(1);

    await leaveCircle({ circleId: circle.id, userId: guest.id });

    // Owner's detail no longer lists the guest.
    const detail = await getCircleDetail({ circleId: circle.id, viewerId: owner.id });
    expect(detail.members.some((m) => m.userId === guest.id)).toBe(false);
    expect(detail.memberCount).toBe(1);

    // The left guest can no longer read circle contents.
    await expect(getMemberWishlistsForViewer({ circleId: circle.id, viewerId: guest.id, memberId: owner.id }))
      .rejects.toMatchObject({ code: 'not_member' });
  });

  it('owner cannot leave their own circle (must delete/transfer)', async () => {
    const owner = await mkUser('owner');
    const circle = await createCircle({ ownerId: owner.id, name: 'Семья', type: 'FAMILY' });
    await expect(leaveCircle({ circleId: circle.id, userId: owner.id })).rejects.toMatchObject({
      code: 'owner_cannot_leave',
    });
  });

  it('per-circle visibility: getMyShares reflects setMyShares (replace semantics)', async () => {
    const owner = await mkUser('owner');
    const circle = await createCircle({ ownerId: owner.id, name: 'Коллеги', type: 'COLLEAGUES' });
    const { wl: wlA } = await mkWishlistWithItem(owner.id);
    const { wl: wlB } = await mkWishlistWithItem(owner.id);

    await setMyShares({ circleId: circle.id, userId: owner.id, wishlistIds: [wlA.id] });
    let shares = await getMyShares({ circleId: circle.id, userId: owner.id });
    expect(shares.find((s) => s.wishlistId === wlA.id)?.shared).toBe(true);
    expect(shares.find((s) => s.wishlistId === wlB.id)?.shared).toBe(false);

    // Replace: now only B is shared.
    await setMyShares({ circleId: circle.id, userId: owner.id, wishlistIds: [wlB.id] });
    shares = await getMyShares({ circleId: circle.id, userId: owner.id });
    expect(shares.find((s) => s.wishlistId === wlA.id)?.shared).toBe(false);
    expect(shares.find((s) => s.wishlistId === wlB.id)?.shared).toBe(true);
  });

  it('rejects sharing a wishlist the caller does not own', async () => {
    const owner = await mkUser('owner');
    const other = await mkUser('other');
    const circle = await createCircle({ ownerId: owner.id, name: 'Семья', type: 'FAMILY' });
    const { wl: foreign } = await mkWishlistWithItem(other.id);

    const res = await setMyShares({ circleId: circle.id, userId: owner.id, wishlistIds: [foreign.id] });
    expect(res.shared).toHaveLength(0); // foreign list silently dropped
    const count = await db.circleWishlistShare.count({ where: { circleId: circle.id } });
    expect(count).toBe(0);
  });

  it('cross-circle isolation: a list shared to circle A is NOT visible via circle B', async () => {
    const owner = await mkUser('owner');
    const guest = await mkUser('guest');
    const circleA = await createCircle({ ownerId: owner.id, name: 'A', type: 'FAMILY' });
    const circleB = await createCircle({ ownerId: owner.id, name: 'B', type: 'FRIENDS' });
    const invA = await getOrCreateActiveInvite({ circleId: circleA.id, actorId: owner.id });
    const invB = await getOrCreateActiveInvite({ circleId: circleB.id, actorId: owner.id });
    await joinByToken({ token: invA.token, userId: guest.id });
    await joinByToken({ token: invB.token, userId: guest.id });

    const { wl } = await mkWishlistWithItem(owner.id);
    await setMyShares({ circleId: circleA.id, userId: owner.id, wishlistIds: [wl.id] });

    const viaA = await getMemberWishlistsForViewer({ circleId: circleA.id, viewerId: guest.id, memberId: owner.id });
    expect(viaA.wishlists).toHaveLength(1);
    const viaB = await getMemberWishlistsForViewer({ circleId: circleB.id, viewerId: guest.id, memberId: owner.id });
    expect(viaB.wishlists).toHaveLength(0); // shared to A only — circle B sees nothing
  });

  it('owner removes a member; non-owner cannot; remove is idempotent', async () => {
    const owner = await mkUser('owner');
    const guest = await mkUser('guest');
    const other = await mkUser('other');
    const circle = await createCircle({ ownerId: owner.id, name: 'Семья', type: 'FAMILY' });
    const inv = await getOrCreateActiveInvite({ circleId: circle.id, actorId: owner.id });
    await joinByToken({ token: inv.token, userId: guest.id });
    await joinByToken({ token: inv.token, userId: other.id });

    // A non-owner member cannot remove anyone.
    await expect(removeMember({ circleId: circle.id, actorId: guest.id, targetUserId: other.id }))
      .rejects.toMatchObject({ code: 'forbidden', httpStatus: 403 });

    // Owner removes the guest → membership flips to LEFT.
    await removeMember({ circleId: circle.id, actorId: owner.id, targetUserId: guest.id });
    const m = await db.circleMembership.findUnique({ where: { circleId_userId: { circleId: circle.id, userId: guest.id } } });
    expect(m?.status).toBe('LEFT');

    // Idempotent: removing again is a no-op (no throw), guest stays gone.
    await removeMember({ circleId: circle.id, actorId: owner.id, targetUserId: guest.id });
    const detail = await getCircleDetail({ circleId: circle.id, viewerId: owner.id });
    expect(detail.members.some((x) => x.userId === guest.id)).toBe(false);
  });

  it('owner deletes a circle (cascades memberships); non-owner cannot', async () => {
    const owner = await mkUser('owner');
    const guest = await mkUser('guest');
    const circle = await createCircle({ ownerId: owner.id, name: 'Друзья', type: 'FRIENDS' });
    const inv = await getOrCreateActiveInvite({ circleId: circle.id, actorId: owner.id });
    await joinByToken({ token: inv.token, userId: guest.id });

    await expect(deleteCircle({ circleId: circle.id, actorId: guest.id }))
      .rejects.toMatchObject({ code: 'forbidden', httpStatus: 403 });

    await deleteCircle({ circleId: circle.id, actorId: owner.id });
    expect(await db.circle.findUnique({ where: { id: circle.id } })).toBeNull();
    expect(await db.circleMembership.count({ where: { circleId: circle.id } })).toBe(0);
  });

  it('invite is capacity-gated (AC#5): at the FREE cap, getOrCreateActiveInvite throws circle_capacity_reached (402)', async () => {
    const owner = await mkUser('owner');
    const circle = await createCircle({ ownerId: owner.id, name: 'Семья', type: 'FAMILY' });
    const inv = await getOrCreateActiveInvite({ circleId: circle.id, actorId: owner.id });
    for (let i = 0; i < 9; i++) {
      const u = await mkUser(`m${i}`);
      await joinByToken({ token: inv.token, userId: u.id });
    }
    // 10 active = FREE cap. The owner's next invite attempt is paywalled.
    await expect(getOrCreateActiveInvite({ circleId: circle.id, actorId: owner.id }))
      .rejects.toMatchObject({ code: 'circle_capacity_reached', httpStatus: 402 });
  });

  it('FOR UPDATE serializes the last-slot race: exactly one of N concurrent joins wins', async () => {
    const owner = await mkUser('owner');
    const circle = await createCircle({ ownerId: owner.id, name: 'Семья', type: 'FAMILY' });
    const inv = await getOrCreateActiveInvite({ circleId: circle.id, actorId: owner.id });
    // Fill to 9 active (owner + 8) → exactly one free slot under the cap of 10.
    for (let i = 0; i < 8; i++) {
      const u = await mkUser(`f${i}`);
      await joinByToken({ token: inv.token, userId: u.id });
    }
    expect(await db.circleMembership.count({ where: { circleId: circle.id, status: 'ACTIVE' } })).toBe(9);

    // Three distinct users race for the last slot, concurrently.
    const racers = await Promise.all([mkUser('r0'), mkUser('r1'), mkUser('r2')]);
    const results = await Promise.allSettled(racers.map((u) => joinByToken({ token: inv.token, userId: u.id })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2);
    // Never over the cap — the row lock made the count+insert atomic per circle.
    expect(await db.circleMembership.count({ where: { circleId: circle.id, status: 'ACTIVE' } })).toBe(10);
  });
});
