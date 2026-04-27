// Barrel export for the security layer. Phase 1 ships the building blocks;
// Phase 2 wires them into routes in apps/api/src/index.ts. See
// docs/API_SECURITY.md (added in Phase 4) for the public contract.

export {
  createIdempotencyMiddleware,
  type IdempotencyOptions,
} from './idempotency';

export {
  createRateLimiter,
  combineLimiters,
  type CategoryName,
} from './rateLimits';

export {
  ipThrottleGate,
  suspiciousUnauthPostGate,
  recordIpEvent,
  isIpThrottled,
  __resetIpThrottleForTests,
} from './ipThrottle';

export {
  startIdempotencyCleanupJob,
  stopIdempotencyCleanupJob,
  runOnce as runIdempotencyCleanupOnce,
} from './cleanupJob';

export {
  getClientIp,
  hashIp,
  hashUserAgent,
  hashIdempotencyKey,
  resolveActorKey,
  tgActorHashFromTelegramId,
} from './ipHash';

export {
  computeRequestHash,
  stableStringify,
} from './requestHash';

export {
  SecurityErrorCode,
  isSecurityFeatureEnabled,
  IDEMPOTENCY_KEY_REGEX,
  IDEMPOTENCY_BILLING_TTL_MINUTES,
  IDEMPOTENCY_DEFAULT_TTL_MINUTES,
} from './types';
