// Integration tests against a real Postgres — pin the P2002-safe behaviour
// of E04's `createGetOrCreateDefaultWishlist` factory under concurrent
// bootstrap pressure. The 2026-04-30 `getOrCreateProfile` regression (see
// apps/api/test/integration/profile-race.test.ts) is the canonical lesson
// here: a mock-Prisma test cannot prove that the
// `findFirst → create → catch P2002 → findFirst` sequence works under
// real concurrent transactions on a real index. The Mini App fires
// several /tg/me/profile calls in parallel at boot (see profile.ts
// comment); if the race recovery is wrong, users start seeing duplicate
// REGULAR wishlists.
//
// What this file pins:
//
//   1. Repeated calls for the same user settle on a single REGULAR row.
//   2. 5 concurrent calls produce EXACTLY one REGULAR row + everyone
//      gets the same id back (no orphan duplicates).
//   3. Distinct users each get their own row (no cross-user pollution).
//   4. A user with a pre-existing manual REGULAR wishlist gets that one
//      returned unchanged — no new isDefault row inserted.
//   5. The partial unique index `(ownerId) WHERE isDefault=true`
//      enforces "at most one default per owner" at the DB level —
//      direct INSERT of a second default row raises P2002.
//
// Auto-skip when DATABASE_URL is not set so local `pnpm test` stays
// fast and doesn't require Postgres running. CI provides DATABASE_URL
// via the postgres service container in .github/workflows/test.yml.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { getTestPrisma, disconnectTestPrisma } from '../setup-pg';
import { createGetOrCreateDefaultWishlist } from '../../src/services/wishlists';

const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;

// Unique prefix per file so parallel integration test files don't trample
// each other's fixtures (vitest runs files in parallel workers; the
// single Postgres DB is shared).
const PREFIX = 'int-default-wl';

if (SKIP) {
  // eslint-disable-next-line no-console
  console.warn('[integration] DATABASE_URL not set — skipping default-wishlist race integration tests');
}

suite('createGetOrCreateDefaultWishlist — real Postgres', () => {
  const userIds: string[] = [];
  const trackEvent = vi.fn();
  const getOrCreate = createGetOrCreateDefaultWishlist({ trackEvent });

  beforeAll(async () => {
    const db = getTestPrisma();

    // Ensure the partial unique index exists in this test DB.
    //
    // The CI test job provisions the schema via `prisma db push` (fast,
    // straight from schema.prisma) but Prisma DSL CANNOT express partial
    // unique indexes (`WHERE isDefault = true`) — that's why the constraint
    // lives in the hand-written migration file
    // `20260525130000_unique_default_wishlist_per_owner/migration.sql`,
    // which only the `migration-replay` CI job (and prod's `migrate
    // deploy`) actually applies. Without this beforeAll step, the partial
    // index is MISSING in the test DB, both race-recovery tests below
    // (5-concurrent + manual-duplicate) silently mis-test the wrong
    // behaviour, and the suite turns red on the FIRST CI push of the
    // feature — exactly what happened in iter-3 (run 26395380959).
    //
    // `IF NOT EXISTS` makes this idempotent across beforeAll re-runs
    // AND across the migrate-deploy-already-applied case in the
    // migration-replay job (where the constraint is already there).
    await db.$executeRawUnsafe(
      'CREATE UNIQUE INDEX IF NOT EXISTS "Wishlist_ownerId_isDefault_partial_key" ON "Wishlist"("ownerId") WHERE "isDefault" = true',
    );

    // Clean only own-prefixed data so we don't trample other files in flight.
    await db.wishlist.deleteMany({ where: { owner: { telegramId: { startsWith: PREFIX } } } });
    await db.user.deleteMany({ where: { telegramId: { startsWith: PREFIX } } });
    for (let i = 1; i <= 8; i++) {
      const u = await db.user.create({ data: { telegramId: `${PREFIX}-${i}` } });
      userIds.push(u.id);
    }
  });

  afterAll(async () => {
    const db = getTestPrisma();
    await db.wishlist.deleteMany({ where: { ownerId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await disconnectTestPrisma();
  });

  beforeEach(async () => {
    const db = getTestPrisma();
    await db.wishlist.deleteMany({ where: { ownerId: { in: userIds } } });
    trackEvent.mockReset();
  });

  it('first call materialises one REGULAR wishlist with isDefault=true; repeat call returns the same row without creating another', async () => {
    const a = await getOrCreate(userIds[0]!, 'ru');
    expect(a.alreadyExisted).toBe(false);
    expect(a.isDefault).toBe(true);
    expect(a.title).toBe('Мой вишлист');

    const b = await getOrCreate(userIds[0]!, 'ru');
    expect(b.alreadyExisted).toBe(true);
    expect(b.id).toBe(a.id);

    const db = getTestPrisma();
    const count = await db.wishlist.count({ where: { ownerId: userIds[0]!, type: 'REGULAR' } });
    expect(count).toBe(1);
  });

  it('Postgres-side race — 5 concurrent calls all settle on the same row', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => getOrCreate(userIds[1]!, 'en')),
    );
    const ids = new Set(results.map((r) => r.id));
    expect(ids.size).toBe(1);

    const db = getTestPrisma();
    const count = await db.wishlist.count({ where: { ownerId: userIds[1]!, type: 'REGULAR' } });
    expect(count).toBe(1);

    // Exactly one of the 5 callers won the race and emitted analytics;
    // the others recovered via P2002 + findFirst and emitted nothing.
    // (Without the recovery, all 5 would emit and we'd over-count by 4×.)
    const created = results.filter((r) => !r.alreadyExisted);
    expect(created.length).toBe(1);
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith('wishlist_created', userIds[1]!, expect.objectContaining({
      source: 'auto_default',
      wishlistType: 'REGULAR',
    }));
  });

  it('races two parallel calls for distinct users — each gets its own row', async () => {
    const [a, b] = await Promise.all([
      getOrCreate(userIds[2]!, 'ru'),
      getOrCreate(userIds[3]!, 'en'),
    ]);
    expect(a.id).not.toBe(b.id);
    expect(a.title).toBe('Мой вишлист');
    expect(b.title).toBe('My wishlist');

    const db = getTestPrisma();
    const aCount = await db.wishlist.count({ where: { ownerId: userIds[2]!, type: 'REGULAR' } });
    const bCount = await db.wishlist.count({ where: { ownerId: userIds[3]!, type: 'REGULAR' } });
    expect(aCount).toBe(1);
    expect(bCount).toBe(1);
  });

  it('returns existing manual REGULAR wishlist unchanged — no isDefault row inserted alongside', async () => {
    const db = getTestPrisma();
    // Pre-seed a manual wishlist (isDefault stays false; the user named it themselves)
    const manual = await db.wishlist.create({
      data: {
        slug: `wl-manual-${userIds[4]!.slice(0, 8)}`,
        ownerId: userIds[4]!,
        title: 'Мои хотелки',
        type: 'REGULAR',
        isDefault: false,
      },
      select: { id: true },
    });

    const result = await getOrCreate(userIds[4]!, 'ru');
    expect(result.id).toBe(manual.id);
    expect(result.title).toBe('Мои хотелки'); // unchanged
    expect(result.isDefault).toBe(false); // unchanged
    expect(result.alreadyExisted).toBe(true);

    const count = await db.wishlist.count({ where: { ownerId: userIds[4]!, type: 'REGULAR' } });
    expect(count).toBe(1);
    expect(trackEvent).not.toHaveBeenCalled();
  });

  it('partial unique index enforces "at most one isDefault per owner" — a manual second INSERT raises P2002', async () => {
    const db = getTestPrisma();
    // First default — succeeds via the service.
    await getOrCreate(userIds[5]!, 'ru');
    // Manually attempt a second isDefault row for the same owner — should fail.
    await expect(
      db.wishlist.create({
        data: {
          slug: `wl-manual-dup-${userIds[5]!.slice(0, 8)}`,
          ownerId: userIds[5]!,
          title: 'Сломанный дефолт',
          type: 'REGULAR',
          isDefault: true,
        },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });

    const count = await db.wishlist.count({ where: { ownerId: userIds[5]!, type: 'REGULAR' } });
    expect(count).toBe(1);
  });

  it('after isDefault is cleared (onboarding rename) and the named wishlist is deleted, the NEXT bootstrap materialises a fresh default', async () => {
    const db = getTestPrisma();
    // First call creates the default.
    const first = await getOrCreate(userIds[6]!, 'ru');
    expect(first.isDefault).toBe(true);
    // Simulate onboarding rename: clear isDefault.
    await db.wishlist.update({ where: { id: first.id }, data: { isDefault: false, title: 'Named by user' } });
    // User deletes their named wishlist (rare but possible).
    await db.wishlist.delete({ where: { id: first.id } });
    trackEvent.mockReset();

    // Next bootstrap should materialise a fresh default.
    const second = await getOrCreate(userIds[6]!, 'ru');
    expect(second.alreadyExisted).toBe(false);
    expect(second.isDefault).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it('after isDefault is cleared (onboarding rename), repeat bootstrap calls return the renamed row unchanged — no new default materialises', async () => {
    const db = getTestPrisma();
    const first = await getOrCreate(userIds[7]!, 'ru');
    await db.wishlist.update({ where: { id: first.id }, data: { isDefault: false, title: 'Подарки на Новый год' } });
    trackEvent.mockReset();

    const second = await getOrCreate(userIds[7]!, 'ru');
    expect(second.id).toBe(first.id);
    expect(second.isDefault).toBe(false);
    expect(second.title).toBe('Подарки на Новый год');
    expect(second.alreadyExisted).toBe(true);
    expect(trackEvent).not.toHaveBeenCalled();

    const count = await db.wishlist.count({ where: { ownerId: userIds[7]!, type: 'REGULAR' } });
    expect(count).toBe(1);
  });
});
