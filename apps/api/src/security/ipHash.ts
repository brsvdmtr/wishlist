import crypto from 'node:crypto';
import type { Request } from 'express';

// Salt for hashing client IPs in logs and throttle buckets. Falls back to a
// build-time constant so dev/test still produce stable hashes; prod should
// always set IP_HASH_SALT in /opt/wishlist/.env.
const IP_HASH_SALT = process.env.IP_HASH_SALT || 'wishlist-iphash-default-salt';
const UA_HASH_SALT = process.env.UA_HASH_SALT || 'wishlist-uahash-default-salt';

// Reads the client IP. Express already has `trust proxy` set so req.ip respects
// X-Forwarded-For from nginx. Fallback to the raw socket address if req.ip
// is missing (e.g. unit tests with synthetic Request objects).
export function getClientIp(req: Request): string {
  const ip = (req.ip || req.socket?.remoteAddress || '').trim();
  return ip || 'unknown';
}

// 16-hex-char IP fingerprint for logs and throttle keys. Short enough to be
// unlinkable to the original IP without the salt, long enough that collisions
// are negligible at our scale.
export function hashIp(ip: string): string {
  return crypto.createHash('sha256').update(`${IP_HASH_SALT}|${ip}`).digest('hex').slice(0, 16);
}

// Truncated User-Agent hash for log fingerprinting. The first 256 chars of UA
// is enough to distinguish browser families without storing the full string.
export function hashUserAgent(ua: string | undefined): string {
  if (!ua) return 'none';
  const truncated = ua.slice(0, 256);
  return crypto.createHash('sha256').update(`${UA_HASH_SALT}|${truncated}`).digest('hex').slice(0, 16);
}

// 16-hex-char fingerprint of an Idempotency-Key for safe logging — never log
// the raw key (the user can craft a chosen-collision against an actor's
// other in-flight requests if the raw key leaks).
export function hashIdempotencyKey(key: string): string {
  return crypto.createHash('sha256').update(`idem|${key}`).digest('hex').slice(0, 16);
}

// Deterministic actorHash derived from a Telegram user ID. Mirrors the
// in-file `tgActorHash` helper used for analytics events; duplicated here so
// the security module has no inbound dependency on apps/api/src/index.ts.
export function tgActorHashFromTelegramId(telegramId: number | string): string {
  const h = crypto.createHash('sha256').update(`tg_actor:${telegramId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

// Resolve the canonical actor key for a request: actorHash if Telegram-auth'd,
// otherwise a hashed-IP fallback prefixed `ip:` so it never collides with a
// real actorHash UUID. Used by rate-limit and idempotency layers.
export function resolveActorKey(req: Request): { actorHash: string | null; ipHash: string; key: string } {
  const ip = getClientIp(req);
  const ipHash = hashIp(ip);
  const tgId = req.tgUser?.id;
  if (tgId !== undefined && tgId !== null) {
    const actorHash = tgActorHashFromTelegramId(tgId);
    return { actorHash, ipHash, key: actorHash };
  }
  return { actorHash: null, ipHash, key: `ip:${ipHash}` };
}
