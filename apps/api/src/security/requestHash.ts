import crypto from 'node:crypto';
import { VOLATILE_BODY_FIELDS } from './types';

// Stable JSON stringify — recursive, key-sorted. Required for requestHash so
// that `{a:1,b:2}` and `{b:2,a:1}` produce the same hash on retry. Volatile
// fields (clientEventId, traceId, …) are dropped at every nesting level so
// telemetry plumbing can't accidentally invalidate idempotency.
export function stableStringify(value: unknown): string {
  return stringifyInner(value);
}

function stringifyInner(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return 'null'; // mirror JSON.stringify for `undefined` at root
  const t = typeof v;
  if (t === 'number' || t === 'boolean') return JSON.stringify(v);
  if (t === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) {
    return '[' + v.map(stringifyInner).join(',') + ']';
  }
  if (t === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => !VOLATILE_BODY_FIELDS.has(k)).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + stringifyInner(obj[k])).join(',') + '}';
  }
  // bigint / symbol / function — should not appear in JSON bodies; coerce to string
  return JSON.stringify(String(v));
}

// Compose the request fingerprint used by idempotency replay/conflict checks.
// `originalUrl` carries literal route params (e.g. /tg/items/abc/reserve) and
// raw query, while `path` (route pattern) is what the unique index keys on.
// Including originalUrl here means a key reused across different :id values
// trips the `different_request` branch instead of replaying a stale response.
export function computeRequestHash(input: {
  method: string;
  originalUrl: string;
  actorKey: string | null;
  body: unknown;
  query: unknown;
}): string {
  const payload =
    `${input.method.toUpperCase()}\n` +
    `${input.originalUrl}\n` +
    `${input.actorKey ?? ''}\n` +
    `body:${stableStringify(input.body ?? {})}\n` +
    `query:${stableStringify(input.query ?? {})}`;
  return crypto.createHash('sha256').update(payload).digest('hex');
}
