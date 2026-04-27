// Shared types and error codes for the security layer (idempotency, rate-limit,
// IP-throttle). All client-facing codes are documented in docs/API_SECURITY.md.

export const SecurityErrorCode = {
  // Idempotency
  INVALID_IDEMPOTENCY_KEY: 'INVALID_IDEMPOTENCY_KEY',
  IDEMPOTENCY_REQUEST_IN_PROGRESS: 'IDEMPOTENCY_REQUEST_IN_PROGRESS',
  IDEMPOTENCY_KEY_STALE: 'IDEMPOTENCY_KEY_STALE',
  IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST: 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
  IDEMPOTENCY_ACTOR_MISMATCH: 'IDEMPOTENCY_ACTOR_MISMATCH',
  IDEMPOTENCY_RESPONSE_NOT_REPLAYABLE: 'IDEMPOTENCY_RESPONSE_NOT_REPLAYABLE',
  IDEMPOTENCY_FAILED_RECENTLY: 'IDEMPOTENCY_FAILED_RECENTLY',

  // Rate limit / throttle
  RATE_LIMITED: 'RATE_LIMITED',
  IP_THROTTLED: 'IP_THROTTLED',
} as const;

export type SecurityErrorCode = typeof SecurityErrorCode[keyof typeof SecurityErrorCode];

// Cap on stored idempotency response bodies. Most P0 endpoints return <5 KB,
// so this is a safety net rather than a tight limit.
export const IDEMPOTENCY_RESPONSE_BODY_BYTES_MAX = 64 * 1024;

// Default lock window — long enough for typical handlers (DB + Stars API),
// short enough that a crashed handler unlocks for retry within a minute.
export const IDEMPOTENCY_LOCK_SECONDS = 30;

// Default TTL — 24 h for everything except billing endpoints.
export const IDEMPOTENCY_DEFAULT_TTL_MINUTES = 24 * 60;
export const IDEMPOTENCY_BILLING_TTL_MINUTES = 7 * 24 * 60;

// 5xx cooldown: how long to keep a `failed` row locked before allowing retry
// with the same key. Short window protects against retry storms while still
// letting an honest client recover after an intermittent error.
export const IDEMPOTENCY_FAILED_COOLDOWN_SECONDS = 60 * 5;

// `[A-Za-z0-9_-]{16,128}` — covers UUIDs, ULIDs, base64url, our `idem_<rand>`
// fallback. No dots/slashes/whitespace.
export const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9_-]{16,128}$/;

// Body fields that must NOT influence the request hash — adding these would
// make legitimate retries look like new requests. Keep this list aligned with
// what the MiniApp is allowed to attach to bodies for tracing.
export const VOLATILE_BODY_FIELDS = new Set([
  'clientEventId',
  '__retryAttempt',
  '__telemetry',
  'clientTimestamp',
  'localTimestamp',
  'traceId',
  'requestId',
  'analyticsSessionId',
  'bootSessionId',
]);

// Env kill-switch helper. Defaults: enabled everywhere except `NODE_ENV=test`,
// where the system stays off unless explicitly enabled. This keeps existing
// tests independent of the new layer until they opt in.
export function isSecurityFeatureEnabled(envVar: string): boolean {
  const v = (process.env[envVar] ?? '').toLowerCase().trim();
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  return process.env.NODE_ENV !== 'test';
}
