/**
 * Test data builders for integration tests.
 *
 * Each factory returns a payload suitable for `prisma.<model>.create({ data: ... })`.
 * Overrides win over defaults; defaults are minimal-but-valid.
 *
 * Add a factory when 3+ tests need the same model. Don't pre-emptively build
 * factories for every Prisma model — only what's actively used.
 */

import { randomUUID } from 'node:crypto';

let counter = 0;
const seq = () => ++counter;

export function userFactory(overrides: Partial<{
  id: string;
  telegramId: bigint;
  firstName: string;
  lastName: string | null;
  username: string | null;
  languageCode: string | null;
  photoUrl: string | null;
}> = {}) {
  const n = seq();
  return {
    id: overrides.id ?? `u_${randomUUID()}`,
    telegramId: overrides.telegramId ?? BigInt(100000 + n),
    firstName: overrides.firstName ?? `User${n}`,
    lastName: overrides.lastName ?? null,
    username: overrides.username ?? null,
    languageCode: overrides.languageCode ?? 'en',
    photoUrl: overrides.photoUrl ?? null,
    ...overrides,
  };
}

export function wishlistFactory(overrides: Partial<{
  id: string;
  ownerId: string;
  title: string;
  type: 'REGULAR' | 'SYSTEM_DRAFTS';
  shareToken: string | null;
}> & { ownerId: string }) {
  const n = seq();
  return {
    id: overrides.id ?? `w_${randomUUID()}`,
    ownerId: overrides.ownerId,
    title: overrides.title ?? `Wishlist ${n}`,
    type: overrides.type ?? ('REGULAR' as const),
    shareToken: overrides.shareToken ?? null,
    ...overrides,
  };
}

export function itemFactory(overrides: Partial<{
  id: string;
  wishlistId: string;
  title: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH';
  status: 'AVAILABLE' | 'RESERVED' | 'PURCHASED' | 'COMPLETED' | 'DELETED' | 'ARCHIVED';
  position: number;
  price: number | null;
  url: string | null;
}> & { wishlistId: string }) {
  const n = seq();
  return {
    id: overrides.id ?? `i_${randomUUID()}`,
    wishlistId: overrides.wishlistId,
    title: overrides.title ?? `Item ${n}`,
    priority: overrides.priority ?? ('MEDIUM' as const),
    status: overrides.status ?? ('AVAILABLE' as const),
    position: overrides.position ?? n,
    price: overrides.price ?? null,
    url: overrides.url ?? null,
    ...overrides,
  };
}
