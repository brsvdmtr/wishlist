import logger from '../logger';

// Centralised structured-log helpers for the security layer. Keeping the call
// sites here means the event names are exhaustive in one place — log audits
// can grep `securityEvents.ts` to know everything the API emits.
//
// Hard rules (do NOT relax):
//   * never log raw Idempotency-Key  → use hashIdempotencyKey()
//   * never log raw IP               → use hashIp()
//   * never log full initData / PII  → caller must scrub before reaching here
//   * never log free-form user input (comments, item titles)
//
// Severity: info for normal protective hits (replay, rate-limited),
// warn for misuse signals (conflict, suspicious), error reserved for
// internal failures (DB write rejected etc).

type Base = {
  path: string;
  method: string;
  actorHash: string | null;
  ipHash: string;
};

export function logRateLimited(ev: Base & {
  limitKey: string;
  retryAfterSec: number;
  uaHash: string;
}) {
  logger.info({ event: 'api.rate_limited', ...ev }, 'rate_limited');
}

export function logIdempotencyReplay(ev: Base & {
  keyHash: string;
  originalCreatedAt: Date;
}) {
  logger.info(
    { event: 'api.idempotency_replay', ...ev, originalCreatedAt: ev.originalCreatedAt.toISOString() },
    'idempotency_replay',
  );
}

export function logIdempotencyConflict(ev: Base & {
  keyHash: string;
  reason: 'different_request' | 'actor_mismatch' | 'response_not_replayable';
}) {
  logger.warn({ event: 'api.idempotency_conflict', ...ev }, 'idempotency_conflict');
}

export function logIdempotencyInProgress(ev: Base & {
  keyHash: string;
}) {
  logger.info({ event: 'api.idempotency_in_progress', ...ev }, 'idempotency_in_progress');
}

export function logIdempotencyKeyStale(ev: Base & {
  keyHash: string;
}) {
  logger.warn({ event: 'api.idempotency_key_stale', ...ev }, 'idempotency_key_stale');
}

export function logIdempotencyRetryAfterFailed(ev: Base & {
  keyHash: string;
  previousFailedAt: Date;
}) {
  logger.info(
    { event: 'api.idempotency_retry_after_failed', ...ev, previousFailedAt: ev.previousFailedAt.toISOString() },
    'idempotency_retry_after_failed',
  );
}

export function logIdempotencyDbError(ev: {
  path: string;
  method: string;
  phase: 'lookup' | 'insert' | 'update' | 'finish_save';
  error: string;
}) {
  logger.error({ event: 'api.idempotency_db_error', ...ev }, 'idempotency_db_error');
}

export function logIdemMissingOnCriticalEndpoint(ev: Base & {
  reason: 'no_header' | 'invalid_header';
}) {
  logger.warn({ event: 'api.idem_missing_on_critical_endpoint', ...ev }, 'idem_missing_on_critical_endpoint');
}

export function logSuspiciousActivity(ev: Base & {
  reason: string;
}) {
  logger.warn({ event: 'api.suspicious_activity', ...ev }, 'suspicious_activity');
}

export function logIpThrottled(ev: {
  ipHash: string;
  reason: string;
  retryAfterSec: number;
  path: string;
  method: string;
}) {
  logger.warn({ event: 'api.ip_throttled', ...ev }, 'ip_throttled');
}

export function logIdempotencyCleanup(ev: { deletedCount: number; durationMs: number }) {
  logger.info({ event: 'api.idempotency_cleanup_completed', ...ev }, 'idempotency_cleanup_completed');
}
