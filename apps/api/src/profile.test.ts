import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared mock state — vi.hoisted runs before vi.mock factories.
const shared = vi.hoisted(() => {
  class FakeP2002 extends Error {
    code = 'P2002';
    meta: { target: string[] };
    constructor(target: string[] = ['userId']) {
      super('Unique constraint failed');
      this.meta = { target };
    }
  }
  const userProfile = {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  };
  return { FakeP2002, userProfile };
});

vi.mock('@wishlist/db', () => ({
  prisma: { userProfile: shared.userProfile },
  Prisma: { PrismaClientKnownRequestError: shared.FakeP2002 },
}));

import { getOrCreateProfile } from './profile';

const { FakeP2002, userProfile } = shared;

beforeEach(() => {
  userProfile.findUnique.mockReset();
  userProfile.create.mockReset();
  userProfile.update.mockReset();
});

describe('getOrCreateProfile', () => {
  it('returns existing profile without calling create', async () => {
    const existing = { id: 'p1', userId: 'u1', supportId: 'abc123', defaultCurrency: 'RUB' };
    userProfile.findUnique.mockResolvedValueOnce(existing);

    const result = await getOrCreateProfile('u1', 'ru');

    expect(result).toBe(existing);
    expect(userProfile.create).not.toHaveBeenCalled();
    expect(userProfile.update).not.toHaveBeenCalled();
  });

  it('creates a new profile when none exists', async () => {
    userProfile.findUnique
      .mockResolvedValueOnce(null) // initial lookup: no profile
      .mockResolvedValueOnce(null); // generateUniqueSupportId: supportId not taken
    const created = { id: 'p2', userId: 'u2', supportId: 'fresh', defaultCurrency: 'RUB' };
    userProfile.create.mockResolvedValueOnce(created);

    const result = await getOrCreateProfile('u2', 'ru');

    expect(result).toBe(created);
    expect(userProfile.create).toHaveBeenCalledTimes(1);
    const createArg = userProfile.create.mock.calls[0]![0];
    expect(createArg.data.userId).toBe('u2');
    expect(createArg.data.defaultCurrency).toBe('RUB');
  });

  it('uses USD when locale is not ru', async () => {
    userProfile.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    userProfile.create.mockResolvedValueOnce({ id: 'p3', userId: 'u3', supportId: 'x', defaultCurrency: 'USD' });

    await getOrCreateProfile('u3', 'en');

    expect(userProfile.create.mock.calls[0]![0].data.defaultCurrency).toBe('USD');
  });

  // ─── Race condition: this is the bug. ────────────────────────────────────
  // Two concurrent callers both see profile === null and both invoke create().
  // The first INSERT wins; the second hits P2002 on userId. The fix: catch
  // P2002 and re-fetch — both callers should end up with the same row.
  it('is race-safe: parallel calls for same userId both return the winner row', async () => {
    const winner = { id: 'p4', userId: 'u4', supportId: 'first', defaultCurrency: 'RUB' };

    // findUnique sequence:
    //   Call A initial lookup → null
    //   Call B initial lookup → null
    //   Call A generateUniqueSupportId → null (id 'first' free)
    //   Call B generateUniqueSupportId → null (id 'second' free)
    //   Call B re-fetch after P2002 catch → winner
    let initialFindCount = 0;
    let supportIdFindCount = 0;
    userProfile.findUnique.mockImplementation(({ where }: { where: { userId?: string; supportId?: string } }) => {
      if (where.userId) {
        // First two calls (initial lookups for A and B): both miss.
        // Any later userId lookup is the catch-path re-fetch → returns winner.
        initialFindCount += 1;
        if (initialFindCount <= 2) return Promise.resolve(null);
        return Promise.resolve(winner);
      }
      // supportId lookup inside generateUniqueSupportId — always free (test harness).
      supportIdFindCount += 1;
      return Promise.resolve(null);
    });

    // create() simulates the DB: first call wins, second call raises P2002.
    let createCount = 0;
    userProfile.create.mockImplementation(() => {
      createCount += 1;
      if (createCount === 1) return Promise.resolve(winner);
      return Promise.reject(new FakeP2002(['userId']));
    });

    // Run two concurrent calls.
    const [a, b] = await Promise.all([
      getOrCreateProfile('u4', 'ru'),
      getOrCreateProfile('u4', 'ru'),
    ]);

    // Both should return the winner row — neither should throw.
    expect(a).toBe(winner);
    expect(b).toBe(winner);
    expect(createCount).toBe(2); // both attempted insert
    expect(supportIdFindCount).toBeGreaterThanOrEqual(2); // both generated supportId
  });

  it('rethrows P2002 if the conflict is on a different field (not userId)', async () => {
    userProfile.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    userProfile.create.mockRejectedValueOnce(new FakeP2002(['username']));

    await expect(getOrCreateProfile('u5', 'ru')).rejects.toMatchObject({
      code: 'P2002',
      meta: { target: ['username'] },
    });
  });

  it('rethrows non-P2002 errors verbatim', async () => {
    userProfile.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    const dbDown = new Error('connection refused');
    userProfile.create.mockRejectedValueOnce(dbDown);

    await expect(getOrCreateProfile('u6', 'ru')).rejects.toBe(dbDown);
  });

  it('rethrows P2002 if re-fetch unexpectedly returns null (write-then-delete edge case)', async () => {
    userProfile.findUnique
      .mockResolvedValueOnce(null) // initial lookup
      .mockResolvedValueOnce(null) // supportId free
      .mockResolvedValueOnce(null); // catch-path re-fetch finds nothing — bail out
    userProfile.create.mockRejectedValueOnce(new FakeP2002(['userId']));

    await expect(getOrCreateProfile('u7', 'ru')).rejects.toMatchObject({ code: 'P2002' });
  });

  it('lazy-backfills supportId on existing profile that has none', async () => {
    const stale = { id: 'p8', userId: 'u8', supportId: null, defaultCurrency: 'RUB' };
    const backfilled = { ...stale, supportId: 'newone' };
    userProfile.findUnique
      .mockResolvedValueOnce(stale)   // initial lookup
      .mockResolvedValueOnce(null);   // supportId free for generated id
    userProfile.update.mockResolvedValueOnce(backfilled);

    const result = await getOrCreateProfile('u8', 'ru');

    expect(result).toBe(backfilled);
    expect(userProfile.create).not.toHaveBeenCalled();
    expect(userProfile.update).toHaveBeenCalledTimes(1);
  });
});
