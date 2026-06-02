// Integration tests for the event-pushes pipeline (P0.3) against real Postgres.
//
// Covers what a mock can't:
//   • enqueue idempotency via the unique dedupeKey (re-enqueue = no-op);
//   • fan-out to active co-members only (never the actor);
//   • flush grouping (N wishes from one member → ONE message);
//   • per-type opt-out + circle mute → SUPPRESSED, no send;
//   • quiet-hours deferral (row stays PENDING, groupUntil pushed forward);
//   • rolling daily cap → deferral;
//   • preferences read/defaults + validation;
//   • per-circle mute reflected in listMyCircles.
//
// Auto-skips when DATABASE_URL is not set (local fast path); always runs on CI.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Logger } from 'pino';
import { getTestPrisma, disconnectTestPrisma } from '../setup-pg';
import {
  enqueueNewWishFromItem,
  enqueueReservationChangedForItem,
  enqueueCircleJoined,
  flushDueEventNotifications,
  getNotificationPreferences,
  updateNotificationPreferences,
  purgeOldEventNotifications,
  DAILY_MESSAGE_CAP,
} from '../../src/services/event-notifications';
import { setCircleMute, listMyCircles, CircleError } from '../../src/services/circles.service';

const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;
const PREFIX = 'int-evnotif';

if (SKIP) {
  // eslint-disable-next-line no-console
  console.warn('[integration] DATABASE_URL not set — skipping event-notifications tests');
}

const noopLogger = { info() {}, error() {}, warn() {}, debug() {} } as unknown as Logger;

suite('event-notifications — real Postgres', () => {
  let db: ReturnType<typeof getTestPrisma>;
  let seq = 0;
  let sends: Array<{ chatId: string; text: string; markup?: Record<string, unknown> }>;

  const fakeSend = async (chatId: string, text: string, markup?: Record<string, unknown>) => {
    sends.push({ chatId, text, markup });
    return true;
  };
  const flush = (now: Date) => flushDueEventNotifications({ logger: noopLogger, sendTgBotMessage: fakeSend, now });

  async function clean() {
    await db.user.deleteMany({ where: { telegramId: { startsWith: PREFIX } } });
  }
  async function mkUser(first: string, opts?: { chat?: boolean; profile?: Record<string, unknown> }) {
    seq += 1;
    const user = await db.user.create({
      data: {
        telegramId: `${PREFIX}-${seq}-${first}`,
        firstName: `${first}${seq}`,
        telegramChatId: opts?.chat === false ? null : `${PREFIX}-chat-${seq}`,
      },
    });
    if (opts?.profile) {
      await db.userProfile.create({ data: { userId: user.id, ...opts.profile } });
    }
    return user;
  }
  // A recipient with a profile; quiet hours OFF by default so timing is
  // deterministic. Override `profile` to exercise opt-out / quiet hours.
  function recipientProfile(extra?: Record<string, unknown>) {
    return { quietHoursEnabled: false, normalizedLocale: 'ru', languageMode: 'auto', ...extra };
  }
  async function mkCircle(ownerId: string) {
    seq += 1;
    return db.circle.create({
      data: {
        name: `Семья ${seq}`,
        type: 'FAMILY',
        ownerId,
        memberships: { create: { userId: ownerId, role: 'OWNER', status: 'ACTIVE' } },
      },
    });
  }
  async function addMember(circleId: string, userId: string, opts?: { mutedAt?: Date }) {
    return db.circleMembership.create({
      data: { circleId, userId, role: 'MEMBER', status: 'ACTIVE', mutedAt: opts?.mutedAt ?? null },
    });
  }
  async function mkSharedListWithItem(ownerId: string, circleId: string) {
    seq += 1;
    const wl = await db.wishlist.create({ data: { ownerId, slug: `${PREFIX}-wl-${seq}`, title: `L${seq}`, type: 'REGULAR' } });
    await db.circleWishlistShare.create({ data: { circleId, wishlistId: wl.id, sharedByUserId: ownerId } });
    const item = await db.item.create({
      data: { wishlistId: wl.id, title: `Item ${seq}`, url: `https://ex.com/${PREFIX}-${seq}`, status: 'AVAILABLE' },
    });
    return { wl, item };
  }

  beforeAll(async () => {
    process.env.EVENT_NOTIFICATIONS_ENABLED = 'true';
    db = getTestPrisma();
    await clean();
  });
  afterAll(async () => { await clean(); await disconnectTestPrisma(); });
  beforeEach(async () => { await clean(); sends = []; });

  it('enqueueNewWishFromItem fans out to active co-members only, and dedupes', async () => {
    const actor = await mkUser('actor');
    const r1 = await mkUser('r1');
    const r2 = await mkUser('r2');
    const circle = await mkCircle(actor.id);
    await addMember(circle.id, r1.id);
    await addMember(circle.id, r2.id);
    const { wl, item } = await mkSharedListWithItem(actor.id, circle.id);

    await enqueueNewWishFromItem({ itemId: item.id, wishlistId: wl.id, actorUserId: actor.id });

    let rows = await db.eventNotification.findMany({ where: { type: 'NEW_WISH' } });
    expect(rows.map((r) => r.recipientUserId).sort()).toEqual([r1.id, r2.id].sort());
    expect(rows.find((r) => r.recipientUserId === actor.id)).toBeUndefined();

    // Idempotent: re-enqueue the same item → no new rows.
    await enqueueNewWishFromItem({ itemId: item.id, wishlistId: wl.id, actorUserId: actor.id });
    rows = await db.eventNotification.findMany({ where: { type: 'NEW_WISH' } });
    expect(rows.length).toBe(2);
  });

  it('flush groups N wishes from one member into a single message', async () => {
    const actor = await mkUser('actor');
    const r = await mkUser('r', { profile: recipientProfile() });
    const circle = await mkCircle(actor.id);
    await addMember(circle.id, r.id);
    const { wl } = await mkSharedListWithItem(actor.id, circle.id);
    // two distinct items on the same shared list
    const t0 = new Date('2026-06-02T12:00:00Z');
    const i1 = await db.item.create({ data: { wishlistId: wl.id, title: 'Sony', url: `https://ex.com/${PREFIX}-i1`, status: 'AVAILABLE' } });
    const i2 = await db.item.create({ data: { wishlistId: wl.id, title: 'Lego', url: `https://ex.com/${PREFIX}-i2`, status: 'AVAILABLE' } });
    await enqueueNewWishFromItem({ itemId: i1.id, wishlistId: wl.id, actorUserId: actor.id, now: t0 });
    await enqueueNewWishFromItem({ itemId: i2.id, wishlistId: wl.id, actorUserId: actor.id, now: t0 });

    const res = await flush(new Date(t0.getTime() + 61 * 60_000));
    expect(res.messagesSent).toBe(1);
    expect(sends.length).toBe(1);
    expect(sends[0]!.text).toContain('2'); // "2 new wishes"
    const rows = await db.eventNotification.findMany({ where: { recipientUserId: r.id } });
    expect(rows.every((x) => x.status === 'SENT' && x.delivered)).toBe(true);
  });

  it('flush suppresses a type the recipient opted out of', async () => {
    const actor = await mkUser('actor');
    const r = await mkUser('r', { profile: recipientProfile({ notifyCircleNewWishes: false }) });
    const circle = await mkCircle(actor.id);
    await addMember(circle.id, r.id);
    const { wl, item } = await mkSharedListWithItem(actor.id, circle.id);
    const t0 = new Date('2026-06-02T12:00:00Z');
    await enqueueNewWishFromItem({ itemId: item.id, wishlistId: wl.id, actorUserId: actor.id, now: t0 });

    await flush(new Date(t0.getTime() + 61 * 60_000));
    expect(sends.length).toBe(0);
    const row = await db.eventNotification.findFirst({ where: { recipientUserId: r.id } });
    expect(row?.status).toBe('SUPPRESSED');
  });

  it('flush suppresses a muted circle', async () => {
    const actor = await mkUser('actor');
    const r = await mkUser('r', { profile: recipientProfile() });
    const circle = await mkCircle(actor.id);
    await addMember(circle.id, r.id, { mutedAt: new Date() });
    const { wl, item } = await mkSharedListWithItem(actor.id, circle.id);
    const t0 = new Date('2026-06-02T12:00:00Z');
    await enqueueNewWishFromItem({ itemId: item.id, wishlistId: wl.id, actorUserId: actor.id, now: t0 });

    await flush(new Date(t0.getTime() + 61 * 60_000));
    expect(sends.length).toBe(0);
    const row = await db.eventNotification.findFirst({ where: { recipientUserId: r.id } });
    expect(row?.status).toBe('SUPPRESSED');
  });

  it('flush defers during quiet hours (row stays PENDING, groupUntil pushed forward)', async () => {
    const actor = await mkUser('actor');
    const r = await mkUser('r', {
      profile: recipientProfile({ quietHoursEnabled: true, notifyTimezone: 'UTC', quietHoursStart: '00:00', quietHoursEnd: '23:00' }),
    });
    const circle = await mkCircle(actor.id);
    await addMember(circle.id, r.id);
    const { wl, item } = await mkSharedListWithItem(actor.id, circle.id);
    const flushNow = new Date('2026-06-02T12:00:00Z'); // 12:00 UTC ∈ [00:00,23:00) quiet
    const enqueueNow = new Date(flushNow.getTime() - 61 * 60_000);
    await enqueueNewWishFromItem({ itemId: item.id, wishlistId: wl.id, actorUserId: actor.id, now: enqueueNow });

    const res = await flush(flushNow);
    expect(res.deferred).toBe(1);
    expect(sends.length).toBe(0);
    const row = await db.eventNotification.findFirst({ where: { recipientUserId: r.id } });
    expect(row?.status).toBe('PENDING');
    expect(row!.groupUntil.getTime()).toBeGreaterThan(flushNow.getTime());
  });

  it('flush defers when the rolling daily cap is reached', async () => {
    const actor = await mkUser('actor');
    const r = await mkUser('r', { profile: recipientProfile() });
    const circle = await mkCircle(actor.id);
    await addMember(circle.id, r.id);
    const { wl, item } = await mkSharedListWithItem(actor.id, circle.id);
    const flushNow = new Date('2026-06-02T12:00:00Z');

    // Pre-seed CAP delivered messages in the last 24h (distinct groupKey+sentAt → distinct messages).
    const sentAt = new Date(flushNow.getTime() - 60 * 60_000);
    for (let i = 0; i < DAILY_MESSAGE_CAP; i++) {
      await db.eventNotification.create({
        data: {
          recipientUserId: r.id, type: 'NEW_WISH', dedupeKey: `${PREFIX}-cap-${seq}-${i}`,
          payload: {}, groupKey: `${r.id}:cap-${i}`, groupUntil: sentAt, status: 'SENT', delivered: true, sentAt,
        },
      });
    }

    const enqueueNow = new Date(flushNow.getTime() - 61 * 60_000);
    await enqueueNewWishFromItem({ itemId: item.id, wishlistId: wl.id, actorUserId: actor.id, now: enqueueNow });

    const res = await flush(flushNow);
    expect(res.deferred).toBe(1);
    expect(sends.length).toBe(0);
    const row = await db.eventNotification.findFirst({ where: { recipientUserId: r.id, dedupeKey: { not: { startsWith: `${PREFIX}-cap` } } } });
    expect(row?.status).toBe('PENDING');
  });

  it('enqueueCircleJoined notifies the owner and flush delivers it', async () => {
    const owner = await mkUser('owner', { profile: recipientProfile() });
    const joiner = await mkUser('joiner');
    const circle = await mkCircle(owner.id);
    const t0 = new Date('2026-06-02T12:00:00Z');
    await enqueueCircleJoined({ circleId: circle.id, recipientUserId: owner.id, actorUserId: joiner.id, actorName: 'Аня', circleName: circle.name, now: t0 });

    const row = await db.eventNotification.findFirst({ where: { type: 'CIRCLE_JOINED' } });
    expect(row?.recipientUserId).toBe(owner.id);

    const res = await flush(new Date(t0.getTime() + 6 * 60_000));
    expect(res.messagesSent).toBe(1);
    expect(sends[0]!.text).toContain('Аня');
  });

  it('enqueueReservationChangedForItem warns the circle reserver, never the owner', async () => {
    const owner = await mkUser('owner');
    const reserver = await mkUser('reserver', { profile: recipientProfile() });
    const circle = await mkCircle(owner.id);
    await addMember(circle.id, reserver.id);
    const { item } = await mkSharedListWithItem(owner.id, circle.id);
    await db.circleReservation.create({ data: { circleId: circle.id, itemId: item.id, reserverUserId: reserver.id } });

    await enqueueReservationChangedForItem({ itemId: item.id, changeKind: 'edited' });

    const rows = await db.eventNotification.findMany({ where: { type: 'RESERVATION_CHANGED' } });
    expect(rows.length).toBe(1);
    expect(rows[0]!.recipientUserId).toBe(reserver.id);
    expect(rows.find((r) => r.recipientUserId === owner.id)).toBeUndefined();
  });

  it('preferences: defaults for a profile-less user, persist on patch, reject bad time', async () => {
    const u = await mkUser('prefs', { chat: false });
    const defaults = await getNotificationPreferences(u.id);
    expect(defaults.notifyCircleEvents).toBe(true);
    expect(defaults.quietHoursStart).toBe('22:00');

    const updated = await updateNotificationPreferences(u.id, { notifyCircleEvents: false, quietHoursStart: '23:30' });
    expect(updated.notifyCircleEvents).toBe(false);
    expect(updated.quietHoursStart).toBe('23:30');
    const reread = await getNotificationPreferences(u.id);
    expect(reread.notifyCircleEvents).toBe(false);

    await expect(updateNotificationPreferences(u.id, { quietHoursStart: '99:99' })).rejects.toThrow('invalid_time');
  });

  it('setCircleMute is reflected in listMyCircles', async () => {
    const owner = await mkUser('owner');
    const circle = await mkCircle(owner.id);

    await setCircleMute({ circleId: circle.id, userId: owner.id, muted: true });
    let list = await listMyCircles(owner.id);
    expect(list.find((c) => c.id === circle.id)?.muted).toBe(true);

    await setCircleMute({ circleId: circle.id, userId: owner.id, muted: false });
    list = await listMyCircles(owner.id);
    expect(list.find((c) => c.id === circle.id)?.muted).toBe(false);
  });

  it('setCircleMute on a circle you are not a member of throws 403 (the route maps this to a 403)', async () => {
    const owner = await mkUser('owner');
    const outsider = await mkUser('outsider');
    const circle = await mkCircle(owner.id);
    await expect(setCircleMute({ circleId: circle.id, userId: outsider.id, muted: true }))
      .rejects.toMatchObject({ code: 'not_member', httpStatus: 403 });
    expect(CircleError).toBeDefined();
  });

  it('flush is concurrency-safe: a SENDING-claimed bucket is not double-sent', async () => {
    const actor = await mkUser('actor');
    const r = await mkUser('r', { profile: recipientProfile() });
    const circle = await mkCircle(actor.id);
    await addMember(circle.id, r.id);
    const { wl, item } = await mkSharedListWithItem(actor.id, circle.id);
    const t0 = new Date('2026-06-02T12:00:00Z');
    await enqueueNewWishFromItem({ itemId: item.id, wishlistId: wl.id, actorUserId: actor.id, now: t0 });

    // Simulate a crashed prior tick that left the row claimed in SENDING.
    await db.eventNotification.updateMany({ where: { recipientUserId: r.id }, data: { status: 'SENDING' } });

    // The next flush reclaims the orphan and delivers exactly once.
    const res = await flush(new Date(t0.getTime() + 61 * 60_000));
    expect(res.messagesSent).toBe(1);
    expect(sends.length).toBe(1);
  });

  it('flush gives up after MAX attempts on a persistently failing send (no infinite retry)', async () => {
    const actor = await mkUser('actor');
    const r = await mkUser('r', { profile: recipientProfile() });
    const circle = await mkCircle(actor.id);
    await addMember(circle.id, r.id);
    const { wl, item } = await mkSharedListWithItem(actor.id, circle.id);
    const t0 = new Date('2026-06-02T12:00:00Z');
    await enqueueNewWishFromItem({ itemId: item.id, wishlistId: wl.id, actorUserId: actor.id, now: t0 });

    const failingSend = async () => false; // transient/terminal indistinguishable
    const failFlush = (now: Date) => flushDueEventNotifications({ logger: noopLogger, sendTgBotMessage: failingSend, now });

    // attempt 1 → defer (PENDING, attempts=1), attempt 2 → defer (attempts=2),
    // attempt 3 → give up (SENT delivered=false). Advance groupUntil each round.
    let now = new Date(t0.getTime() + 61 * 60_000);
    for (let i = 0; i < 3; i++) {
      await failFlush(now);
      now = new Date(now.getTime() + 60 * 60_000);
    }
    const row = await db.eventNotification.findFirst({ where: { recipientUserId: r.id } });
    expect(row?.status).toBe('SENT');
    expect(row?.delivered).toBe(false);
  });

  it('purge keeps terminal history for the full retention window; only drops stuck non-terminal rows past the stale floor', async () => {
    const r = await mkUser('r');
    const now = new Date('2026-06-02T12:00:00Z');
    const daysAgo = (d: number) => new Date(now.getTime() - d * 24 * 3600_000);
    const mk = (suffix: string, status: string, createdAt: Date) =>
      db.eventNotification.create({
        data: {
          recipientUserId: r.id, type: 'NEW_WISH', dedupeKey: `${PREFIX}-purge-${seq++}-${suffix}`,
          payload: {}, groupKey: `${r.id}:p`, groupUntil: createdAt, status, createdAt,
        },
      });
    const oldSent = await mk('a', 'SENT', daysAgo(31));              // terminal + >30d → delete
    const oldPending = await mk('b', 'PENDING', daysAgo(8));         // non-terminal + >7d → delete
    // Regression guard: a SENT row in the 7–30d window MUST survive. Under the
    // pre-fix bug (stale clause had no status filter) it was wrongly deleted at
    // ~7d, shrinking retention to a week and erasing the delivery record.
    const midSent = await mk('e', 'SENT', daysAgo(12));             // terminal + <30d → KEEP
    const recentSuppressed = await mk('c', 'SUPPRESSED', daysAgo(3)); // terminal + recent → keep
    const freshPending = await mk('d', 'PENDING', daysAgo(1));       // non-terminal + fresh → keep

    const deleted = await purgeOldEventNotifications(now);
    expect(deleted).toBe(2);
    const surviving = await db.eventNotification.findMany({ where: { recipientUserId: r.id }, select: { id: true } });
    const ids = surviving.map((x) => x.id).sort();
    expect(ids).toEqual([midSent.id, recentSuppressed.id, freshPending.id].sort());
    expect(ids).toContain(midSent.id);     // the regression assertion
    expect(ids).not.toContain(oldSent.id);
    expect(ids).not.toContain(oldPending.id);
  });
});
