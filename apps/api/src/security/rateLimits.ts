import rateLimit, { type Options as RateLimitOptions } from 'express-rate-limit';
import type { Request, Response } from 'express';
import { hashUserAgent, resolveActorKey } from './ipHash';
import { logRateLimited } from './securityEvents';
import { SecurityErrorCode, isSecurityFeatureEnabled } from './types';

// Centralised rate-limit categories. Limits target abuse + retry storms
// without blocking legitimate users — even noisy ones. NAT-friendly: we key
// off actorHash when authenticated and only fall back to ipHash for unauth.
//
// ──────────────────────────────────────────────────────────────────────────
// Storage: express-rate-limit's default in-memory MemoryStore. Single API
// instance today (Docker on Timeweb) → counters live where requests land,
// no coordination needed.
//
// TODO(multi-instance): if/when we shard the API, swap MemoryStore for a
// shared Redis store (rate-limit-redis). The category names below stay the
// same — only the `store` field on each `rateLimit({...})` changes.
// ──────────────────────────────────────────────────────────────────────────

export type CategoryName =
  | 'global.auth'         // 300 / 5m   per actorHash on /tg/*
  | 'global.unauth'       // 30  / 1m   per ipHash for non-Telegram callers
  | 'state.changing'      // 60  / 5m   per actorHash on POST/PATCH/DELETE
  | 'item.create'         // 20  / 10m  per actorHash
  | 'item.bulk'           // 10  / 10m  per actorHash
  | 'wishlist.create'     // 10  / 1h   per actorHash
  | 'comment.minute'      // 10  / 1m   per actorHash
  | 'comment.hour'        // 50  / 1h   per actorHash
  | 'reservation.short'   // 10  / 5m   per actorHash
  | 'reservation.day'     // 50  / 1d   per actorHash
  | 'share.hour'          // 10  / 1h   per actorHash
  | 'import.short'        // 5   / 10m  per actorHash
  | 'import.day'          // 30  / 1d   per actorHash
  | 'payment'             // 5   / 10m  per actorHash
  | 'referral.hour'       // 5   / 1h   per actorHash
  | 'referral.day'        // 20  / 1d   per actorHash
  | 'public.share.view'   // 120 / 1m   per ipHash (gentle — real guests)
  | 'health.deep'         // 10  / 1m   per ipHash (external probes)
  | 'santa.draw'          // 3   / 10m  per actorHash (irreversible expensive op; multi-tap guard)
  | 'santa.admin'         // 10  / 1m   per actorHash (admin/season/global-config — admin gating)
  | 'search'              // 30  / 1m   per actorHash (read-only GET /tg/search; tight enough to throttle typing-bursts that bypass FE debounce, loose enough for normal typing cadence)
  | 'access.record'       // 60  / 5m   per actorHash (POST /tg/access/wishlist-opened — fire-and-forget FWA write)
  | 'research.read'       // 60  / 5m   per actorHash (GET /tg/research/* — survey load + progress)
  | 'research.write';     // 30  / 5m   per actorHash (POST /tg/research/*/answer|complete|dismiss — 10 questions × ~1 answer + complete + dismiss ≈ 12 writes, generous headroom for retries)

type CategoryConfig = {
  windowMs: number;
  limit: number;
  keyKind: 'actor' | 'ip'; // actorHash → falls back to ipHash for unauth; ip → always ipHash
};

const CATEGORIES: Record<CategoryName, CategoryConfig> = {
  'global.auth':       { windowMs: 5 * 60 * 1000,      limit: 300, keyKind: 'actor' },
  'global.unauth':     { windowMs: 60 * 1000,          limit: 30,  keyKind: 'ip' },
  'state.changing':    { windowMs: 5 * 60 * 1000,      limit: 60,  keyKind: 'actor' },
  'item.create':       { windowMs: 10 * 60 * 1000,     limit: 20,  keyKind: 'actor' },
  'item.bulk':         { windowMs: 10 * 60 * 1000,     limit: 10,  keyKind: 'actor' },
  'wishlist.create':   { windowMs: 60 * 60 * 1000,     limit: 10,  keyKind: 'actor' },
  'comment.minute':    { windowMs: 60 * 1000,          limit: 10,  keyKind: 'actor' },
  'comment.hour':      { windowMs: 60 * 60 * 1000,     limit: 50,  keyKind: 'actor' },
  'reservation.short': { windowMs: 5 * 60 * 1000,      limit: 10,  keyKind: 'actor' },
  'reservation.day':   { windowMs: 24 * 60 * 60 * 1000, limit: 50, keyKind: 'actor' },
  'share.hour':        { windowMs: 60 * 60 * 1000,     limit: 10,  keyKind: 'actor' },
  'import.short':      { windowMs: 10 * 60 * 1000,     limit: 5,   keyKind: 'actor' },
  'import.day':        { windowMs: 24 * 60 * 60 * 1000, limit: 30, keyKind: 'actor' },
  'payment':           { windowMs: 10 * 60 * 1000,     limit: 5,   keyKind: 'actor' },
  'referral.hour':     { windowMs: 60 * 60 * 1000,     limit: 5,   keyKind: 'actor' },
  'referral.day':      { windowMs: 24 * 60 * 60 * 1000, limit: 20, keyKind: 'actor' },
  'public.share.view': { windowMs: 60 * 1000,          limit: 120, keyKind: 'ip' },
  'health.deep':       { windowMs: 60 * 1000,          limit: 10,  keyKind: 'ip' },
  'santa.draw':        { windowMs: 10 * 60 * 1000,     limit: 3,   keyKind: 'actor' },
  'santa.admin':       { windowMs: 60 * 1000,          limit: 10,  keyKind: 'actor' },
  'search':            { windowMs: 60 * 1000,          limit: 30,  keyKind: 'actor' },
  'access.record':     { windowMs: 5 * 60 * 1000,      limit: 60,  keyKind: 'actor' },
  'research.read':     { windowMs: 5 * 60 * 1000,      limit: 60,  keyKind: 'actor' },
  'research.write':    { windowMs: 5 * 60 * 1000,      limit: 30,  keyKind: 'actor' },
};

// Cache one limiter instance per category. Counters are per-process; rebuilding
// the limiter on every request would also reset the counter, so we MUST cache.
const limiterCache = new Map<CategoryName, ReturnType<typeof rateLimit>>();

export function createRateLimiter(category: CategoryName) {
  const cached = limiterCache.get(category);
  if (cached) return cached;

  const cfg = CATEGORIES[category];
  const opts: Partial<RateLimitOptions> = {
    windowMs: cfg.windowMs,
    limit: cfg.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    // skip when the kill-switch is off — evaluated per-request so we can
    // toggle without restarting (env values are read at request time).
    skip: () => !isSecurityFeatureEnabled('SECURITY_RATE_LIMIT_ENABLED'),
    keyGenerator: (req: Request) => {
      const { actorHash, ipHash, key } = resolveActorKey(req);
      // actor-class limits should isolate per actor; if no actor is attached
      // (e.g. legacy paths reaching an actor-keyed limiter) fall back to ipHash.
      if (cfg.keyKind === 'actor') return actorHash ? `actor:${actorHash}` : `ip:${ipHash}`;
      return `ip:${ipHash}`;
      // Note: we never use key.includes(rawIp) — `key` is already hashed.
    },
    handler: (req: Request, res: Response) => {
      const retryAfterSec = Math.ceil(cfg.windowMs / 1000);
      const { actorHash, ipHash } = resolveActorKey(req);
      const uaHash = hashUserAgent(req.header('user-agent'));
      logRateLimited({
        path: req.originalUrl,
        method: req.method,
        actorHash,
        ipHash,
        limitKey: category,
        retryAfterSec,
        uaHash,
      });
      res.setHeader('Retry-After', String(retryAfterSec));
      res.status(429).json({
        error: SecurityErrorCode.RATE_LIMITED,
        limitKey: category,
        retryAfterSec,
      });
    },
  };
  const limiter = rateLimit(opts);
  limiterCache.set(category, limiter);
  return limiter;
}

// Compose multiple limiters in declaration order. Useful for endpoints that
// have both a short-window and a long-window limit (e.g. reservation.short
// AND reservation.day — burst protection plus daily cap).
export function combineLimiters(...categories: CategoryName[]) {
  const limiters = categories.map(createRateLimiter);
  return limiters; // Express accepts an array of middlewares directly
}
