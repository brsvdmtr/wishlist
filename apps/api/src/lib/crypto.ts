// Timing-safe string comparison via SHA-256 digests.
//
// Used for actorHash verification, internal-key checks, admin-key checks, and
// Telegram initData hash comparison. Hashing both sides first guarantees
// fixed-length input to timingSafeEqual regardless of caller-supplied length.

import crypto from 'node:crypto';

export function secureCompare(a: string, b: string): boolean {
  const aHash = crypto.createHash('sha256').update(a).digest();
  const bHash = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(aHash, bHash);
}
