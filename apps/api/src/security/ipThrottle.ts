import type { Request, Response, NextFunction } from 'express';
import { getClientIp, hashIp, resolveActorKey } from './ipHash';
import { logIpThrottled, logSuspiciousActivity } from './securityEvents';
import { SecurityErrorCode, isSecurityFeatureEnabled } from './types';

// In-memory sliding-window throttle for misbehaving IPs. Three triggers:
//   1. repeated auth_rejected (failed Telegram initData) — likely token
//      probing or replay attack
//   2. repeated 404 on /tg/* — likely scanner or bad client
//   3. POST without X-TG-INIT-DATA on /tg/* — suspicious; logged + soft cap
//
// Storage is per-process. NAT and corporate networks can share IPs, so
// limits are intentionally lenient — we'd rather miss an attacker than
// throttle real users behind a mobile carrier NAT.

type Bucket = {
  events: number[];     // timestamps (ms) of recent recorded events
  throttledUntil: number | null;
};

type Trigger = {
  windowMs: number;
  threshold: number;     // events within window before we throttle
  throttleMs: number;    // how long to throttle once tripped
};

export type TriggerName = 'auth_rejected' | 'not_found' | 'unauth_post';

const TRIGGERS: Record<TriggerName, Trigger> = {
  auth_rejected: { windowMs: 60 * 1000, threshold: 10, throttleMs: 5 * 60 * 1000 },
  not_found:     { windowMs: 60 * 1000, threshold: 30, throttleMs: 5 * 60 * 1000 },
  unauth_post:   { windowMs: 60 * 1000, threshold: 30, throttleMs: 5 * 60 * 1000 },
};

// Separate bucket per (ipHash, trigger) so a noisy 404 scanner doesn't
// poison the auth_rejected counter for the same IP and vice versa.
const buckets = new Map<string, Bucket>();

// Periodic GC: drop buckets that haven't been touched in 10 minutes. Keeps
// the Map bounded under a sustained scan from many distinct IPs. Skipped in
// tests so vitest doesn't keep the event loop open.
let gcStarted = false;
function ensureGcRunning() {
  if (gcStarted) return;
  if (process.env.NODE_ENV === 'test' && process.env.SECURITY_IP_THROTTLE_GC_IN_TEST !== 'true') return;
  gcStarted = true;
  const handle = setInterval(() => {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const [k, b] of buckets) {
      const lastEvent = b.events[b.events.length - 1] ?? 0;
      const stillThrottled = b.throttledUntil != null && b.throttledUntil > Date.now();
      if (!stillThrottled && lastEvent < cutoff) buckets.delete(k);
    }
  }, 60 * 1000);
  handle.unref?.();
}

function bucketKey(ipHash: string, trigger: string): string {
  return `${ipHash}|${trigger}`;
}

function getBucket(ipHash: string, trigger: string): Bucket {
  const k = bucketKey(ipHash, trigger);
  let b = buckets.get(k);
  if (!b) {
    b = { events: [], throttledUntil: null };
    buckets.set(k, b);
  }
  return b;
}

// Caller-side API for other layers (e.g. requireTelegramAuth on auth failure).
// Records one event of the given trigger and trips the throttle if threshold
// reached. Returns whether the IP is now throttled (so the caller can short-
// circuit instead of running expensive validation).
export function recordIpEvent(req: Request, trigger: TriggerName): { throttled: boolean; retryAfterSec: number | null } {
  if (!isSecurityFeatureEnabled('SECURITY_IP_THROTTLE_ENABLED')) {
    return { throttled: false, retryAfterSec: null };
  }
  ensureGcRunning();
  const cfg = TRIGGERS[trigger];
  const ipHash = hashIp(getClientIp(req));
  const b = getBucket(ipHash, trigger);
  const now = Date.now();

  if (b.throttledUntil && b.throttledUntil > now) {
    return { throttled: true, retryAfterSec: Math.ceil((b.throttledUntil - now) / 1000) };
  }

  // sliding-window prune
  const cutoff = now - cfg.windowMs;
  while (b.events.length > 0 && b.events[0]! < cutoff) b.events.shift();
  b.events.push(now);

  if (b.events.length >= cfg.threshold) {
    b.throttledUntil = now + cfg.throttleMs;
    b.events = []; // start fresh once tripped
    logIpThrottled({
      ipHash,
      reason: trigger,
      retryAfterSec: Math.ceil(cfg.throttleMs / 1000),
      path: req.originalUrl,
      method: req.method,
    });
    return { throttled: true, retryAfterSec: Math.ceil(cfg.throttleMs / 1000) };
  }
  return { throttled: false, retryAfterSec: null };
}

// Synchronous "is this IP currently throttled" check. Used at the start of
// hot paths to short-circuit before calling Telegram-init-data validation.
export function isIpThrottled(req: Request, trigger: TriggerName): { throttled: boolean; retryAfterSec: number | null } {
  if (!isSecurityFeatureEnabled('SECURITY_IP_THROTTLE_ENABLED')) {
    return { throttled: false, retryAfterSec: null };
  }
  const ipHash = hashIp(getClientIp(req));
  const b = buckets.get(bucketKey(ipHash, trigger));
  if (!b || !b.throttledUntil) return { throttled: false, retryAfterSec: null };
  const remaining = b.throttledUntil - Date.now();
  if (remaining <= 0) return { throttled: false, retryAfterSec: null };
  return { throttled: true, retryAfterSec: Math.ceil(remaining / 1000) };
}

// Express middleware: short-circuits with 429 IP_THROTTLED if any of the
// listed triggers are currently active for this IP. Callers compose this
// in front of expensive auth validation on /tg/*.
export function ipThrottleGate(triggers: (TriggerName)[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isSecurityFeatureEnabled('SECURITY_IP_THROTTLE_ENABLED')) return next();
    for (const t of triggers) {
      const { throttled, retryAfterSec } = isIpThrottled(req, t);
      if (throttled && retryAfterSec) {
        res.setHeader('Retry-After', String(retryAfterSec));
        return res.status(429).json({
          error: SecurityErrorCode.IP_THROTTLED,
          retryAfterSec,
        });
      }
    }
    return next();
  };
}

// Detect "POST without initData" on /tg/*. Bot uses /tg/* with admin keys
// internally, but those are routed through privateRouter and won't hit this
// gate. This is a soft signal — log + record + pass through; the limiter
// trips it once threshold is crossed.
export function suspiciousUnauthPostGate() {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isSecurityFeatureEnabled('SECURITY_IP_THROTTLE_ENABLED')) return next();
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const hasInitData = req.header('x-tg-init-data');
    if (hasInitData) return next();
    const { actorHash, ipHash } = resolveActorKey(req);
    logSuspiciousActivity({
      path: req.originalUrl,
      method: req.method,
      actorHash,
      ipHash,
      reason: 'unauth_post_on_tg',
    });
    const { throttled, retryAfterSec } = recordIpEvent(req, 'unauth_post');
    if (throttled && retryAfterSec) {
      res.setHeader('Retry-After', String(retryAfterSec));
      return res.status(429).json({
        error: SecurityErrorCode.IP_THROTTLED,
        retryAfterSec,
      });
    }
    return next();
  };
}

// Test-only: reset all buckets. Required because the Map persists across
// vitest's test cases inside the same module instance.
export function __resetIpThrottleForTests() {
  buckets.clear();
  gcStarted = false;
}
