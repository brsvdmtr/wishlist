// Frontend idempotency-key lifecycle for the Mini App.
//
// What this module does:
//   * mints UUID-shaped Idempotency-Key strings (with a fallback for older
//     Telegram WebViews that lack crypto.randomUUID)
//   * caches one key per "action" so retries of the same user attempt reuse it,
//     and the next attempt mints a fresh one
//   * tells callers whether a given API error code means "drop the cached key"
//     or "keep it for the next retry"
//
// What it does NOT do:
//   * persist anything across reloads. Cache is module-scoped → it dies when
//     the Mini App reopens, which is exactly what we want for /onboarding/start
//     (re-bootstrapping a day later mints a fresh key, no stale-key collision).

const actionKeyCache = new Map<string, string>();

export function newIdempotencyKey(): string {
  // crypto.randomUUID is the canonical source. Some older Telegram WebViews
  // (Android 4.x dust, in-app browsers in non-Telegram clients during Web App
  // testing) don't expose it, so fall back to a non-cryptographic but unique
  // composite of timestamp + double random — collisions are vanishingly rare
  // for the per-actor scope the server uses.
  if (typeof crypto !== 'undefined' && typeof (crypto as Crypto).randomUUID === 'function') {
    return (crypto as Crypto).randomUUID();
  }
  const r1 = Math.random().toString(36).slice(2, 12);
  const r2 = Math.random().toString(36).slice(2, 8);
  return `idem_${Date.now().toString(36)}_${r1}${r2}`;
}

// Look up a cached key for an action, or mint and cache one. Subsequent calls
// with the same `action` return the same key — that's how a button's retry
// loop keeps using the original key after a 5xx or network blip.
export function getOrCreateActionKey(action: string): string {
  let k = actionKeyCache.get(action);
  if (!k) {
    k = newIdempotencyKey();
    actionKeyCache.set(action, k);
  }
  return k;
}

// Drop the cached key — next call to getOrCreateActionKey(action) mints fresh.
// Called on success (operation completed, the next user attempt is a NEW
// operation) and on certain server-side error codes (see KEY_CLEAR_CODES).
export function clearActionKey(action: string): void {
  actionKeyCache.delete(action);
}

// Test/diagnostic helper. Not used by the app at runtime.
export function clearAllActionKeys(): void {
  actionKeyCache.clear();
}

// Fingerprint a key for telemetry. We never log the raw key (it's a per-actor
// secret of sorts — anyone holding it can replay or block that actor's
// in-flight operation on the server). djb2 is plenty for log-side dedup.
export function hashKeyForLog(key: string): string {
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Server-side error codes that mean: "this key is unusable, drop it; the next
// retry must be a brand-new operation". Aligned with apps/api/src/security/types.ts.
export const KEY_CLEAR_CODES: ReadonlySet<string> = new Set([
  'IDEMPOTENCY_KEY_STALE',
  'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
  'IDEMPOTENCY_RESPONSE_NOT_REPLAYABLE',
  'IDEMPOTENCY_RESPONSE_TOO_LARGE',
  'IDEMPOTENCY_ACTOR_MISMATCH',
  'INVALID_IDEMPOTENCY_KEY',
]);

// Codes that mean: "keep the key, retry will hit the replay or in-progress
// branch on the server". Includes rate-limit codes — the server doesn't burn
// the key on 429, the user just needs to wait.
export const KEY_KEEP_CODES: ReadonlySet<string> = new Set([
  'IDEMPOTENCY_REQUEST_IN_PROGRESS',
  'IDEMPOTENCY_FAILED_RECENTLY',
  'RATE_LIMITED',
  'IP_THROTTLED',
]);

// Codes that warrant a user-facing toast distinct from generic "error".
// tgFetch routes through this set to pick the right i18n key.
export type SecurityToastCode =
  | 'RATE_LIMITED'
  | 'IP_THROTTLED'
  | 'IDEMPOTENCY_REQUEST_IN_PROGRESS'
  | 'IDEMPOTENCY_KEY_STALE'
  | 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST'
  | 'IDEMPOTENCY_RESPONSE_NOT_REPLAYABLE'
  | 'IDEMPOTENCY_RESPONSE_TOO_LARGE'
  | 'IDEMPOTENCY_ACTOR_MISMATCH'
  | 'IDEMPOTENCY_FAILED_RECENTLY'
  | 'INVALID_IDEMPOTENCY_KEY';

export const SECURITY_TOAST_CODES: ReadonlySet<string> = new Set<SecurityToastCode>([
  'RATE_LIMITED',
  'IP_THROTTLED',
  'IDEMPOTENCY_REQUEST_IN_PROGRESS',
  'IDEMPOTENCY_KEY_STALE',
  'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
  'IDEMPOTENCY_RESPONSE_NOT_REPLAYABLE',
  'IDEMPOTENCY_RESPONSE_TOO_LARGE',
  'IDEMPOTENCY_ACTOR_MISMATCH',
  'IDEMPOTENCY_FAILED_RECENTLY',
  'INVALID_IDEMPOTENCY_KEY',
]);

// Codes the analytics layer treats as "client bug" so they surface separately
// from ordinary throttling. INVALID_IDEMPOTENCY_KEY means we sent something
// malformed; KEY_REUSED means the same action key was reused with different
// payload (call-site bug).
export const CLIENT_BUG_CODES: ReadonlySet<string> = new Set([
  'INVALID_IDEMPOTENCY_KEY',
  'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST',
  'IDEMPOTENCY_ACTOR_MISMATCH',
]);
