import type { Request, Response, NextFunction } from 'express';
import { prisma, Prisma } from '@wishlist/db';
import { computeRequestHash } from './requestHash';
import { hashIdempotencyKey, resolveActorKey } from './ipHash';
import {
  logIdempotencyConflict,
  logIdempotencyDbError,
  logIdempotencyInProgress,
  logIdempotencyKeyStale,
  logIdempotencyReplay,
  logIdempotencyRetryAfterFailed,
  logIdemMissingOnCriticalEndpoint,
} from './securityEvents';
import {
  IDEMPOTENCY_BILLING_TTL_MINUTES,
  IDEMPOTENCY_DEFAULT_TTL_MINUTES,
  IDEMPOTENCY_FAILED_COOLDOWN_SECONDS,
  IDEMPOTENCY_KEY_REGEX,
  IDEMPOTENCY_LOCK_SECONDS,
  IDEMPOTENCY_RESPONSE_BODY_BYTES_MAX,
  SecurityErrorCode,
  isSecurityFeatureEnabled,
} from './types';

// Per-endpoint config. Pass `endpointKey` explicitly (route pattern, e.g.
// `POST /tg/wishlists/:id/items`) — that string is what the unique index
// stores in `path`, so it must be stable across deploys.
export type IdempotencyOptions = {
  // Stable identifier for the endpoint, used as the `path` column. Must NOT
  // contain literal IDs — those go into requestHash via originalUrl.
  endpointKey: string;
  // Higher-level grouping for logs/metrics (e.g. 'item.create', 'payment').
  category: string;
  // Override the 24 h default TTL. Billing endpoints get 7 d via `ttlMinutes`.
  ttlMinutes?: number;
  // If true, treat this as a billing-class endpoint: a missing/invalid
  // Idempotency-Key header is logged for monitoring even though we don't 400.
  critical?: boolean;
  // Multipart / large-response endpoints opt out of body replay. We still
  // hold the lock so concurrent retries don't double-execute, but on replay
  // we return 409 IDEMPOTENCY_RESPONSE_NOT_REPLAYABLE.
  noResponseReplay?: boolean;
};

export function createIdempotencyMiddleware(opts: IdempotencyOptions) {
  const ttlMinutes = opts.ttlMinutes ?? IDEMPOTENCY_DEFAULT_TTL_MINUTES;

  return async function idempotencyMiddleware(req: Request, res: Response, next: NextFunction) {
    // 1. Hard-bypass conditions — never block GET, never block when killed.
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    if (!isSecurityFeatureEnabled('SECURITY_IDEMPOTENCY_ENABLED')) return next();

    const headerRaw = req.header('idempotency-key') || req.header('Idempotency-Key');
    const { actorHash, ipHash, key: actorKey } = resolveActorKey(req);
    const baseLogCtx = { path: opts.endpointKey, method: req.method, actorHash, ipHash };

    // 2. Soft-require: no header → pass through. For critical endpoints we
    //    log the absence so we can monitor adoption + spot abuse.
    if (!headerRaw) {
      if (opts.critical) {
        logIdemMissingOnCriticalEndpoint({ ...baseLogCtx, reason: 'no_header' });
      }
      return next();
    }
    const key = headerRaw.trim();
    if (!IDEMPOTENCY_KEY_REGEX.test(key)) {
      if (opts.critical) {
        logIdemMissingOnCriticalEndpoint({ ...baseLogCtx, reason: 'invalid_header' });
      }
      return res.status(400).json({
        error: SecurityErrorCode.INVALID_IDEMPOTENCY_KEY,
        message: 'Idempotency-Key must be 16-128 chars [A-Za-z0-9_-].',
      });
    }
    const keyHash = hashIdempotencyKey(key);

    // 3. Compute requestHash from method + literal URL + actor + body + query.
    //    `originalUrl` carries the literal :id values; `endpointKey` is the
    //    stable route pattern used by the unique index. The two together let
    //    us detect "same key reused on different :id" as a conflict.
    const requestHash = computeRequestHash({
      method: req.method,
      originalUrl: req.originalUrl,
      actorKey,
      body: req.body,
      query: req.query,
    });

    const now = new Date();
    const lockedUntil = new Date(now.getTime() + IDEMPOTENCY_LOCK_SECONDS * 1000);
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);
    const userId = await resolveUserIdSafe(req);

    // 4. Insert-or-conflict. The unique index on (key, actorHash, method, path)
    //    serialises concurrent first-arrivers — exactly one wins the insert,
    //    the rest see P2002 and fall through to the existing-row branch.
    let ownsLock = false;
    try {
      await prisma.idempotencyKey.create({
        data: {
          key,
          userId,
          actorHash,
          actorKey,
          method: req.method,
          path: opts.endpointKey,
          requestHash,
          status: 'processing',
          lockedUntil,
          expiresAt,
        },
      });
      ownsLock = true;
    } catch (err) {
      if (!isUniqueViolation(err)) {
        // Fail-open: a Postgres outage on the idempotency table must not
        // break legitimate POSTs. Log loudly and let the handler run.
        logIdempotencyDbError({
          path: opts.endpointKey,
          method: req.method,
          phase: 'insert',
          error: errToString(err),
        });
        return next();
      }
    }

    if (!ownsLock) {
      // 5. We lost the insert race — inspect the existing row and decide
      //    whether to replay, conflict, or take over a stale lock.
      const decision = await handleExisting({
        req, res, opts,
        key, actorHash, actorKey, requestHash, baseLogCtx, keyHash, lockedUntil, now,
      });
      if (decision === 'short_circuited') return; // response already sent
      if (decision === 'took_over_failed_lock') ownsLock = true;
    }

    if (!ownsLock) {
      // Defensive: handleExisting() either short-circuits or hands us the
      // lock. If we somehow get here, fail-open (run the handler) rather
      // than leaving the request hanging.
      return next();
    }

    // 6. Wrap res.json/res.send so we capture the response payload, then
    //    persist on res.on('finish'). 'finish' fires after the response is
    //    fully sent, so we don't block the user on the DB write.
    instrumentResponseAndPersist({
      req, res, opts, key, actorKey, expiresAt,
    });
    return next();
  };
}

// ─── handleExisting ──────────────────────────────────────────────────────────
// Inspects an existing IdempotencyKey row when the insert race is lost.
// Returns:
//   'short_circuited'         — the middleware already wrote a response (replay/409)
//   'took_over_failed_lock'   — caller now owns the lock and should run the handler
//   'pass_through'            — fail-open path; rare, used on DB read errors

async function handleExisting(args: {
  req: Request;
  res: Response;
  opts: IdempotencyOptions;
  key: string;
  actorHash: string | null;
  actorKey: string;
  requestHash: string;
  baseLogCtx: { path: string; method: string; actorHash: string | null; ipHash: string };
  keyHash: string;
  lockedUntil: Date;
  now: Date;
}): Promise<'short_circuited' | 'took_over_failed_lock' | 'pass_through'> {
  const { req, res, opts, key, actorHash, actorKey, requestHash, baseLogCtx, keyHash, lockedUntil, now } = args;

  let existing;
  try {
    existing = await prisma.idempotencyKey.findUnique({
      where: {
        key_actorKey_method_path: {
          key,
          actorKey,
          method: req.method,
          path: opts.endpointKey,
        },
      },
    });
  } catch (err) {
    logIdempotencyDbError({
      path: opts.endpointKey,
      method: req.method,
      phase: 'lookup',
      error: errToString(err),
    });
    return 'pass_through';
  }

  if (!existing) {
    // Race: insert collided but the row vanished (cleanup job?). Fail-open.
    return 'pass_through';
  }

  // Actor mismatch is its own case — treat as conflict, never replay another
  // user's response. This is defence-in-depth: with `actorHash` in the unique
  // key, the same row implies the same actor; mismatch here means an unauth
  // request landed on a row owned by an authed actor (or vice versa).
  if (existing.actorHash !== actorHash) {
    logIdempotencyConflict({ ...baseLogCtx, keyHash, reason: 'actor_mismatch' });
    res.status(409).json({
      error: SecurityErrorCode.IDEMPOTENCY_ACTOR_MISMATCH,
      message: 'Idempotency-Key belongs to a different actor.',
    });
    return 'short_circuited';
  }

  if (existing.status === 'processing') {
    if (existing.lockedUntil && existing.lockedUntil.getTime() > now.getTime()) {
      logIdempotencyInProgress({ ...baseLogCtx, keyHash });
      res.setHeader('Retry-After', '5');
      res.status(409).json({
        error: SecurityErrorCode.IDEMPOTENCY_REQUEST_IN_PROGRESS,
        message: 'This action is already in progress.',
        retryAfterSec: 5,
      });
      return 'short_circuited';
    }
    // Stale lock — handler likely crashed. Per agreed policy we DO NOT auto-
    // replay this; the client must mint a new key. Auto-recovering would risk
    // running the operation twice if the original handler is still alive.
    logIdempotencyKeyStale({ ...baseLogCtx, keyHash });
    res.status(409).json({
      error: SecurityErrorCode.IDEMPOTENCY_KEY_STALE,
      message: 'Previous attempt did not complete. Retry with a new Idempotency-Key.',
    });
    return 'short_circuited';
  }

  if (existing.status === 'completed') {
    if (existing.requestHash !== requestHash) {
      logIdempotencyConflict({ ...baseLogCtx, keyHash, reason: 'different_request' });
      res.status(409).json({
        error: SecurityErrorCode.IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST,
        message: 'Idempotency-Key was previously used with a different request.',
      });
      return 'short_circuited';
    }
    // Response too large to store, or this endpoint opted out of body replay.
    if (existing.responseTruncated || existing.responseBody === null) {
      logIdempotencyConflict({ ...baseLogCtx, keyHash, reason: 'response_not_replayable' });
      res.status(409).json({
        error: SecurityErrorCode.IDEMPOTENCY_RESPONSE_NOT_REPLAYABLE,
        message: 'Original response cannot be replayed. Verify state and retry with a new Idempotency-Key if needed.',
      });
      return 'short_circuited';
    }
    // Replay the stored response. Only safe headers are written — Set-Cookie,
    // Location, etc. from the original response are intentionally dropped.
    logIdempotencyReplay({
      ...baseLogCtx,
      keyHash,
      originalCreatedAt: existing.createdAt,
    });
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Idempotent-Replay', '1');
    res.status(existing.responseStatus ?? 200).json(existing.responseBody);
    return 'short_circuited';
  }

  // status === 'failed'
  if (existing.lockedUntil && existing.lockedUntil.getTime() > now.getTime()) {
    // Recent failure — keep cooling down so a retry storm can't hammer
    // a flaky downstream (Telegram Stars API, DB) before it recovers.
    const retryAfterSec = Math.max(
      1,
      Math.ceil((existing.lockedUntil.getTime() - now.getTime()) / 1000),
    );
    res.setHeader('Retry-After', String(retryAfterSec));
    res.status(409).json({
      error: SecurityErrorCode.IDEMPOTENCY_FAILED_RECENTLY,
      message: 'Previous attempt failed; cooling down.',
      retryAfterSec,
    });
    return 'short_circuited';
  }
  // Cooldown elapsed → take over the lock and re-run the handler with the
  // SAME key. This is the one place we mutate an existing row from the
  // middleware; we update requestHash in case the client retried with a
  // slightly different (still-valid) body.
  try {
    await prisma.idempotencyKey.update({
      where: {
        key_actorKey_method_path: {
          key,
          actorKey,
          method: req.method,
          path: opts.endpointKey,
        },
      },
      data: {
        status: 'processing',
        lockedUntil,
        requestHash,
        responseStatus: null,
        responseBody: Prisma.JsonNull,
        responseTruncated: false,
      },
    });
  } catch (err) {
    logIdempotencyDbError({
      path: opts.endpointKey,
      method: req.method,
      phase: 'update',
      error: errToString(err),
    });
    return 'pass_through';
  }
  logIdempotencyRetryAfterFailed({
    ...baseLogCtx,
    keyHash,
    previousFailedAt: existing.updatedAt,
  });
  return 'took_over_failed_lock';
}

// ─── instrumentResponseAndPersist ────────────────────────────────────────────
// Wraps res.json / res.send to capture the response body in a closure, then
// on the response 'finish' event marks the IdempotencyKey row completed/failed.
// We never block the response on the DB write — persistence is fire-and-forget.

function instrumentResponseAndPersist(args: {
  req: Request;
  res: Response;
  opts: IdempotencyOptions;
  key: string;
  actorKey: string;
  expiresAt: Date;
}) {
  const { req, res, opts, key, actorKey, expiresAt } = args;

  // We hold the captured body until 'finish' fires. Marking with a sentinel
  // (not just `null`) lets us distinguish "no body sent" from "explicit null".
  let captured: { body: unknown; hasBody: boolean } = { body: null, hasBody: false };

  const origJson = res.json.bind(res);
  res.json = function patchedJson(body: unknown) {
    captured = { body, hasBody: true };
    return origJson(body);
  } as typeof res.json;

  const origSend = res.send.bind(res);
  res.send = function patchedSend(body?: unknown) {
    if (!captured.hasBody && body !== undefined) {
      // res.send may be called with a JSON string (e.g. via res.status().send(JSON.stringify(...)))
      if (typeof body === 'string') {
        try {
          captured = { body: JSON.parse(body), hasBody: true };
        } catch {
          captured = { body, hasBody: true };
        }
      } else {
        captured = { body, hasBody: true };
      }
    }
    return origSend(body as never);
  } as typeof res.send;

  res.on('finish', () => {
    void persistFinish({
      key, actorKey,
      method: req.method,
      path: opts.endpointKey,
      noResponseReplay: opts.noResponseReplay === true,
      statusCode: res.statusCode,
      body: captured.hasBody ? captured.body : null,
      expiresAt,
    });
  });
  res.on('close', () => {
    // 'close' without 'finish' means the client hung up before we sent a
    // response. Leave the row as 'processing' — its lockedUntil will expire
    // and the next request will hit the KEY_STALE path.
  });
}

async function persistFinish(args: {
  key: string;
  actorKey: string;
  method: string;
  path: string;
  noResponseReplay: boolean;
  statusCode: number;
  body: unknown;
  expiresAt: Date;
}) {
  const { key, actorKey, method, path, noResponseReplay, statusCode, body, expiresAt } = args;
  try {
    if (statusCode >= 500) {
      // Don't cache server errors — they are usually transient. Hold the row
      // in 'failed' for a short cooldown so a retry storm can't hammer the
      // downstream until it recovers.
      const cooldown = new Date(Date.now() + IDEMPOTENCY_FAILED_COOLDOWN_SECONDS * 1000);
      await prisma.idempotencyKey.update({
        where: { key_actorKey_method_path: { key, actorKey, method, path } },
        data: {
          status: 'failed',
          responseStatus: statusCode,
          responseBody: Prisma.JsonNull,
          responseTruncated: false,
          lockedUntil: cooldown,
          expiresAt,
        },
      });
      return;
    }

    // 2xx/3xx/4xx — business outcome; cache so retries get the same answer.
    let storedBody: Prisma.InputJsonValue | typeof Prisma.JsonNull = Prisma.JsonNull;
    let truncated = false;
    if (noResponseReplay) {
      truncated = true; // marks "lock-only", not really truncated
    } else if (body !== null && body !== undefined) {
      // Use Buffer.byteLength so multi-byte characters are counted correctly.
      const serialized = safeStringify(body);
      if (serialized && Buffer.byteLength(serialized, 'utf8') <= IDEMPOTENCY_RESPONSE_BODY_BYTES_MAX) {
        storedBody = body as Prisma.InputJsonValue;
      } else {
        truncated = true;
      }
    }

    await prisma.idempotencyKey.update({
      where: { key_actorKey_method_path: { key, actorKey, method, path } },
      data: {
        status: 'completed',
        responseStatus: statusCode,
        responseBody: storedBody,
        responseTruncated: truncated,
        lockedUntil: null,
        expiresAt,
      },
    });
  } catch (err) {
    logIdempotencyDbError({ path, method, phase: 'finish_save', error: errToString(err) });
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002'
  );
}

function errToString(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function safeStringify(v: unknown): string | null {
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

// Resolve the internal User.id for the request (for `userId` column on the
// IdempotencyKey row — useful for support investigations). Best-effort: we
// never block the request on this lookup, and a missing user is fine.
async function resolveUserIdSafe(req: Request): Promise<string | null> {
  const tgId = req.tgUser?.id;
  if (!tgId) return null;
  try {
    const user = await prisma.user.findUnique({
      where: { telegramId: String(tgId) },
      select: { id: true },
    });
    return user?.id ?? null;
  } catch {
    return null;
  }
}
