// Integration test — hint idempotency window with real Postgres.
//
// The 2026-05-03 L4 lesson was a window-mismatch between API producer
// and bot consumer (30d vs 30min). The shared constant HINT_LOOKUP_WINDOW_MS
// in @wishlist/shared closes the literal gap; this integration test pins
// the BEHAVIOUR: a sender re-tapping after the window expires gets a fresh
// hint, not the stale zombie.
//
// Auto-skip without DATABASE_URL (local pnpm test fast path).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getTestPrisma, disconnectTestPrisma } from '../setup-pg';
import { HINT_LOOKUP_WINDOW_MS } from '@wishlist/shared';

const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;

// Unique prefix so parallel integration files don't collide on the
// shared Postgres database.
const PREFIX = 'int-hints';

if (SKIP) {
  // eslint-disable-next-line no-console
  console.warn('[integration] DATABASE_URL not set — skipping hint-window integration tests');
}

suite('HINT_LOOKUP_WINDOW_MS — real Postgres lookup semantics', () => {
  let userId: string;
  let itemId: string;
  let wishlistId: string;

  beforeAll(async () => {
    const db = getTestPrisma();
    // Clean only own-prefixed data.
    await db.hint.deleteMany({ where: { user: { telegramId: { startsWith: PREFIX } } } });
    await db.item.deleteMany({ where: { wishlist: { owner: { telegramId: { startsWith: PREFIX } } } } });
    await db.wishlist.deleteMany({ where: { owner: { telegramId: { startsWith: PREFIX } } } });
    await db.user.deleteMany({ where: { telegramId: { startsWith: PREFIX } } });

    const user = await db.user.create({ data: { telegramId: `${PREFIX}-owner` } });
    userId = user.id;

    const wishlist = await db.wishlist.create({
      data: {
        slug: `${PREFIX}-${Date.now()}`,
        ownerId: userId,
        title: 'Int test wishlist',
      },
    });
    wishlistId = wishlist.id;

    const item = await db.item.create({
      data: {
        wishlistId: wishlist.id,
        title: 'Item under test',
        url: 'https://example.com/x',
        status: 'AVAILABLE',
      },
    });
    itemId = item.id;
  });

  afterAll(async () => {
    const db = getTestPrisma();
    await db.hint.deleteMany({ where: { senderUserId: userId } });
    await db.item.deleteMany({ where: { wishlistId } });
    await db.wishlist.deleteMany({ where: { id: wishlistId } });
    await db.user.deleteMany({ where: { id: userId } });
    await disconnectTestPrisma();
  });

  beforeEach(async () => {
    const db = getTestPrisma();
    await db.hint.deleteMany({ where: { senderUserId: userId, itemId } });
  });

  it('value is the same shared constant on both API + bot side (literal pin)', () => {
    expect(HINT_LOOKUP_WINDOW_MS).toBe(30 * 60 * 1000);
  });

  it('a hint created within the window is found by the consumer-style lookup', async () => {
    const db = getTestPrisma();
    const fresh = await db.hint.create({
      data: {
        senderUserId: userId,
        itemId,
        status: 'SENT',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const windowStart = new Date(Date.now() - HINT_LOOKUP_WINDOW_MS);
    const found = await db.hint.findFirst({
      where: { senderUserId: userId, status: 'SENT', createdAt: { gte: windowStart } },
      orderBy: { createdAt: 'desc' },
    });

    expect(found?.id).toBe(fresh.id);
  });

  it('a hint older than the window is NOT returned by the consumer lookup', async () => {
    const db = getTestPrisma();
    const oldHint = await db.hint.create({
      data: {
        senderUserId: userId,
        itemId,
        status: 'SENT',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - HINT_LOOKUP_WINDOW_MS - 60_000),
      },
    });

    const windowStart = new Date(Date.now() - HINT_LOOKUP_WINDOW_MS);
    const found = await db.hint.findFirst({
      where: { senderUserId: userId, status: 'SENT', createdAt: { gte: windowStart } },
      orderBy: { createdAt: 'desc' },
    });

    expect(found).toBeNull();
    expect(oldHint.createdAt.getTime()).toBeLessThan(windowStart.getTime());
  });

  it('CANCELLED hints are skipped by the consumer lookup (stale-cleanup story)', async () => {
    const db = getTestPrisma();
    await db.hint.create({
      data: {
        senderUserId: userId,
        itemId,
        status: 'CANCELLED',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const windowStart = new Date(Date.now() - HINT_LOOKUP_WINDOW_MS);
    const found = await db.hint.findFirst({
      where: { senderUserId: userId, status: 'SENT', createdAt: { gte: windowStart } },
      orderBy: { createdAt: 'desc' },
    });

    expect(found).toBeNull();
  });

  it('multiple SENT hints in window → most-recent wins (createdAt desc)', async () => {
    const db = getTestPrisma();
    const olderId = (await db.hint.create({
      data: {
        senderUserId: userId,
        itemId,
        status: 'SENT',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 10 * 60_000),
      },
    })).id;

    const newer = await db.hint.create({
      data: {
        senderUserId: userId,
        itemId,
        status: 'SENT',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    const windowStart = new Date(Date.now() - HINT_LOOKUP_WINDOW_MS);
    const found = await db.hint.findFirst({
      where: { senderUserId: userId, status: 'SENT', createdAt: { gte: windowStart } },
      orderBy: { createdAt: 'desc' },
    });

    expect(found?.id).toBe(newer.id);
    expect(found?.id).not.toBe(olderId);
  });
});
