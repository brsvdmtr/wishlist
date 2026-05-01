// Generate a unique 12-char URL-safe share token for a wishlist.
//
// 9 random bytes → base64url → exactly 12 chars (no '=' padding). Collision
// space is 64^12 ≈ 4.7e21, so 10 retries is overkill but matches the slug
// generator's pattern. Final fallback strips dashes from a UUID and slices
// to 12 chars to guarantee a result even if the cosmic-ray retry budget is
// exhausted.

import crypto from 'node:crypto';
import { prisma } from '@wishlist/db';

export async function generateUniqueShareToken(): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const token = crypto.randomBytes(9).toString('base64url'); // 12-char URL-safe token
    const existing = await prisma.wishlist.findUnique({ where: { shareToken: token } });
    if (!existing) return token;
  }
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}
