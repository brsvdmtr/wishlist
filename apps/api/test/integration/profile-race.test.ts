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
import { getTestPrisma, resetDb, disconnectTestPrisma } from '../setup-pg';
import { getOrCreateProfile } from '../../src/profile';

const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;

if (SKIP) {
  // Surface the skip explicitly so CI logs make the gap visible.
  // eslint-disable-next-line no-console
  console.warn('[integration] DATABASE_URL not set — skipping profile-race integration tests');
}

suite('getOrCreateProfile — real Postgres', () => {
  const userIds: string[] = [];

  beforeAll(async () => {
    const db = getTestPrisma();
    await resetDb();
    // Seed three users for the tests below.
    for (let i = 1; i <= 5; i++) {
      const id = `int-test-u${i}`;
      await db.user.create({ data: { id, telegramId: `${1_000_000 + i}` } });
      userIds.push(id);
    }
  });

  afterAll(async () => {
    await disconnectTestPrisma();
  });

  beforeEach(async () => {
    // Clear any profiles created in prior tests so each test starts fresh.
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
    // This is the regression test for the 2026-04-30 incident. We fire 5
    // concurrent getOrCreateProfile calls for the SAME userId. One INSERT
    // wins at the unique constraint; the other 4 catch P2002 + re-fetch.
    // Expected outcome: 5 promises resolve, all return the same profile.id,
    // no rejection.
    const results = await Promise.all(
      Array.from({ length: 5 }, () => getOrCreateProfile(userIds[1]!, 'en')),
    );

    const ids = new Set(results.map((p) => p.id));
    expect(ids.size).toBe(1); // exactly one row created, all 5 returned it
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
    // Create a profile manually without supportId
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
    // Serial loop — no race; just verify each generated id is unique.
    for (let i = 0; i < 10; i++) {
      const u = await db.user.create({ data: { telegramId: `${9_000_000 + i}` } });
      const p = await getOrCreateProfile(u.id, 'en');
      expect(seen.has(p.supportId!)).toBe(false);
      seen.add(p.supportId!);
    }
  });
});
