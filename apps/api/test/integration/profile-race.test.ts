// Integration tests against a real Postgres — pin the P2002-safe behaviour
// of getOrCreateProfile that the previous mock-only test could only assert
// via simulated rejection. The 2026-04-19 fix (upsert with empty update)
// regressed in prod 2026-04-30 precisely because Prisma's empty-update
// upsert doesn't reliably compile to native ON CONFLICT. This test catches
// the same class against the real engine.
//
// Auto-skip when DATABASE_URL is not set so local pnpm test stays fast and
// doesn't require a Postgres container running. CI provides DATABASE_URL
// via the postgres service container in .github/workflows/test.yml.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { getTestPrisma, disconnectTestPrisma } from '../setup-pg';
import { getOrCreateProfile } from '../../src/profile';

const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;

// Unique prefix per file so parallel integration test files don't trample
// each other's fixtures (vitest runs files in parallel workers; the
// single Postgres DB is shared).
const PREFIX = 'int-profile';

if (SKIP) {
  // eslint-disable-next-line no-console
  console.warn('[integration] DATABASE_URL not set — skipping profile-race integration tests');
}

suite('getOrCreateProfile — real Postgres', () => {
  const userIds: string[] = [];

  beforeAll(async () => {
    const db = getTestPrisma();
    // Clean only own-prefixed data so we don't trample other files in flight.
    await db.userProfile.deleteMany({ where: { user: { telegramId: { startsWith: PREFIX } } } });
    await db.user.deleteMany({ where: { telegramId: { startsWith: PREFIX } } });
    for (let i = 1; i <= 5; i++) {
      const u = await db.user.create({ data: { telegramId: `${PREFIX}-${i}` } });
      userIds.push(u.id);
    }
  });

  afterAll(async () => {
    const db = getTestPrisma();
    await db.userProfile.deleteMany({ where: { userId: { in: userIds } } });
    await db.user.deleteMany({ where: { id: { in: userIds } } });
    await disconnectTestPrisma();
  });

  beforeEach(async () => {
    const db = getTestPrisma();
    await db.userProfile.deleteMany({ where: { userId: { in: userIds } } });
  });

  it('returns existing profile on subsequent calls without throwing', async () => {
    const a = await getOrCreateProfile(userIds[0]!, 'ru');
    const b = await getOrCreateProfile(userIds[0]!, 'ru');
    expect(a.id).toBe(b.id);
    expect(a.userId).toBe(userIds[0]!);
  });

  it('Postgres-side P2002 race: 5 concurrent calls all settle on the same row', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => getOrCreateProfile(userIds[1]!, 'en')),
    );
    const ids = new Set(results.map((p) => p.id));
    expect(ids.size).toBe(1);
    expect(results.every((r) => r.userId === userIds[1]!)).toBe(true);
  });

  it('races two parallel calls for distinct users — each gets its own row', async () => {
    const [a, b] = await Promise.all([
      getOrCreateProfile(userIds[2]!, 'ru'),
      getOrCreateProfile(userIds[3]!, 'en'),
    ]);
    expect(a.userId).toBe(userIds[2]!);
    expect(b.userId).toBe(userIds[3]!);
    expect(a.id).not.toBe(b.id);
  });

  it('sets defaultCurrency based on locale parameter', async () => {
    const ru = await getOrCreateProfile(userIds[4]!, 'ru');
    expect(ru.defaultCurrency).toBe('RUB');
  });

  it('lazy-backfills supportId on a profile that was created without one', async () => {
    const db = getTestPrisma();
    await db.userProfile.create({
      data: { userId: userIds[0]!, defaultCurrency: 'USD', supportId: null },
    });
    const result = await getOrCreateProfile(userIds[0]!, 'en');
    expect(result.supportId).toBeTruthy();
    expect(result.supportId).toMatch(/^[a-f0-9]+$/);
  });

  it('supportId is unique-per-user even under serial creation pressure', async () => {
    const db = getTestPrisma();
    const seen = new Set<string>();
    const localUsers: string[] = [];
    try {
      for (let i = 0; i < 10; i++) {
        const u = await db.user.create({ data: { telegramId: `${PREFIX}-bulk-${i}` } });
        localUsers.push(u.id);
        const p = await getOrCreateProfile(u.id, 'en');
        expect(seen.has(p.supportId!)).toBe(false);
        seen.add(p.supportId!);
      }
    } finally {
      await db.userProfile.deleteMany({ where: { userId: { in: localUsers } } });
      await db.user.deleteMany({ where: { id: { in: localUsers } } });
    }
  });
});
