import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import type { Request } from 'express';

// Force-enable the idempotency layer (NODE_ENV=test would otherwise default off).
process.env.SECURITY_IDEMPOTENCY_ENABLED = 'true';

// vi.hoisted runs before every vi.mock factory, giving us a place to keep
// shared state that the factories can close over without hitting Vitest's
// "Cannot access X before initialization" hoisting trap.
const shared = vi.hoisted(() => {
  class FakeP2002 extends Error {
    code = 'P2002';
    constructor() { super('Unique constraint failed'); }
  }
  const prismaMock = {
    idempotencyKey: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      deleteMany: vi.fn(),
    },
    user: { findUnique: vi.fn() },
  };
  const logCalls: Array<{ level: string; obj: any; msg: string }> = [];
  return { FakeP2002, prismaMock, logCalls };
});

vi.mock('./logger', () => ({
  default: {
    info:  (obj: any, msg: string) => { shared.logCalls.push({ level: 'info',  obj, msg }); },
    warn:  (obj: any, msg: string) => { shared.logCalls.push({ level: 'warn',  obj, msg }); },
    error: (obj: any, msg: string) => { shared.logCalls.push({ level: 'error', obj, msg }); },
    debug: () => {},
    fatal: () => {},
  },
}));

vi.mock('@wishlist/db', () => ({
  prisma: shared.prismaMock,
  Prisma: {
    JsonNull: '__JSON_NULL_SENTINEL__' as any,
    PrismaClientKnownRequestError: shared.FakeP2002,
  },
}));

// Imports MUST come after vi.mock (vitest hoists vi.mock above them, so by
// the time these run the mocked module is already in the registry).
import { createIdempotencyMiddleware } from './security/idempotency';

const { FakeP2002, prismaMock, logCalls } = shared;

// ─── Test helpers ────────────────────────────────────────────────────────────

const VALID_KEY = '12345678-aaaa-bbbb-cccc-1234567890ab';

function makeReq(over: Partial<Request> & Record<string, any> = {}): Request {
  // If the caller provides `headers`, use them verbatim (so `headers: {}` truly
  // means "no headers"). Otherwise default to a valid Idempotency-Key.
  const headers: Record<string, string> = (over as any).headers !== undefined
    ? (over as any).headers
    : { 'idempotency-key': VALID_KEY };
  const req: any = {
    method: 'POST',
    originalUrl: '/tg/wishlists',
    path: '/wishlists',
    headers,
    body: { title: 'X' },
    query: {},
    socket: { remoteAddress: '1.2.3.4' },
    ip: '1.2.3.4',
    tgUser: { id: 12345, first_name: 'T' },
    header(name: string) { return headers[name.toLowerCase()]; },
    get(name: string)    { return headers[name.toLowerCase()]; },
    ...over,
  };
  return req as Request;
}

function makeRes() {
  const headers: Record<string, string> = {};
  const finishHandlers: Array<() => void> = [];
  let body: any = null;
  let statusCode = 200;
  const res: any = {
    get statusCode() { return statusCode; },
    set statusCode(v: number) { statusCode = v; },
    setHeader: (k: string, v: string) => { headers[k.toLowerCase()] = String(v); },
    getHeader: (k: string) => headers[k.toLowerCase()],
    headers,
    status(code: number) { statusCode = code; return res; },
    json(b: any) { body = b; queueMicrotask(() => finishHandlers.forEach(h => h())); return res; },
    send(b: any) { body = b; queueMicrotask(() => finishHandlers.forEach(h => h())); return res; },
    on(evt: string, h: () => void) { if (evt === 'finish') finishHandlers.push(h); return res; },
    body: () => body,
    statusOf: () => statusCode,
  };
  return res;
}

async function flush() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  logCalls.length = 0;
  prismaMock.idempotencyKey.create.mockReset();
  prismaMock.idempotencyKey.update.mockReset();
  prismaMock.idempotencyKey.findUnique.mockReset();
  prismaMock.user.findUnique.mockReset();
  prismaMock.user.findUnique.mockResolvedValue({ id: 'user-1' });
  prismaMock.idempotencyKey.update.mockResolvedValue({});
});

afterEach(() => {
  vi.useRealTimers();
});

const mw = (overrides: Partial<Parameters<typeof createIdempotencyMiddleware>[0]> = {}) =>
  createIdempotencyMiddleware({
    endpointKey: 'POST /tg/wishlists',
    category: 'wishlist.create',
    ...overrides,
  });

// ─── Happy path ──────────────────────────────────────────────────────────────

describe('idempotency middleware — happy path & insert', () => {
  it('skips GET requests entirely (no Prisma calls)', async () => {
    const req = makeReq({ method: 'GET' });
    const res = makeRes();
    let nextCalled = false;
    await new Promise<void>((resolve) => {
      mw()(req, res as any, () => { nextCalled = true; resolve(); });
      setTimeout(resolve, 30);
    });
    expect(nextCalled).toBe(true);
    expect(prismaMock.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it('passes through when no Idempotency-Key header (soft-require)', async () => {
    const req = makeReq({ headers: {} });
    const res = makeRes();
    let nextCalled = false;
    await new Promise<void>((resolve) => {
      mw()(req, res as any, () => { nextCalled = true; resolve(); });
      setTimeout(resolve, 30);
    });
    expect(nextCalled).toBe(true);
    expect(prismaMock.idempotencyKey.create).not.toHaveBeenCalled();
  });

  it('rejects malformed key with 400 INVALID_IDEMPOTENCY_KEY', async () => {
    const req = makeReq({ headers: { 'idempotency-key': 'too-short' } });
    const res = makeRes();
    await new Promise<void>((resolve) => {
      mw()(req, res as any, () => resolve());
      setTimeout(resolve, 30);
    });
    expect(res.statusOf()).toBe(400);
    expect(res.body().error).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  it('first request creates a processing row and calls next()', async () => {
    prismaMock.idempotencyKey.create.mockResolvedValue({});
    const req = makeReq();
    const res = makeRes();
    let nextCalled = false;
    await new Promise<void>((resolve) => {
      mw()(req, res as any, () => { nextCalled = true; resolve(); });
      setTimeout(resolve, 30);
    });

    expect(prismaMock.idempotencyKey.create).toHaveBeenCalledOnce();
    expect(nextCalled).toBe(true);
    const created = prismaMock.idempotencyKey.create.mock.calls[0]![0].data;
    expect(created.key).toBe(VALID_KEY);
    expect(created.status).toBe('processing');
    expect(created.method).toBe('POST');
    expect(created.path).toBe('POST /tg/wishlists');
    expect(created.actorHash).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(created.actorKey).toBe(created.actorHash);
  });

  it('persists the response body on finish (status 200)', async () => {
    prismaMock.idempotencyKey.create.mockResolvedValue({});
    const req = makeReq();
    const res = makeRes();
    await new Promise<void>((resolve) => {
      mw()(req, res as any, () => {
        res.status(200).json({ id: 'wl-1', title: 'X' });
        resolve();
      });
    });
    await flush();

    expect(prismaMock.idempotencyKey.update).toHaveBeenCalled();
    const updateCall = prismaMock.idempotencyKey.update.mock.calls.at(-1)![0];
    expect(updateCall.data.status).toBe('completed');
    expect(updateCall.data.responseStatus).toBe(200);
    expect(updateCall.data.responseBody).toEqual({ id: 'wl-1', title: 'X' });
    expect(updateCall.data.responseTruncated).toBe(false);
  });

  it('marks row failed (no body) on 5xx response', async () => {
    prismaMock.idempotencyKey.create.mockResolvedValue({});
    const req = makeReq();
    const res = makeRes();
    await new Promise<void>((resolve) => {
      mw()(req, res as any, () => {
        res.status(500).json({ error: 'boom' });
        resolve();
      });
    });
    await flush();

    const updateCall = prismaMock.idempotencyKey.update.mock.calls.at(-1)![0];
    expect(updateCall.data.status).toBe('failed');
    expect(updateCall.data.responseStatus).toBe(500);
  });
});

// ─── Collision branches (replay / 409 / takeover) ────────────────────────────

const futureLock = () => new Date(Date.now() + 30 * 1000);
const pastLock   = () => new Date(Date.now() - 60 * 1000);

describe('idempotency middleware — collision branches', () => {
  it('replays a completed row when requestHash matches', async () => {
    const { computeRequestHash } = await import('./security/requestHash');
    const { tgActorHashFromTelegramId } = await import('./security/ipHash');

    prismaMock.idempotencyKey.create.mockRejectedValue(new FakeP2002());
    const matchingHash = computeRequestHash({
      method: 'POST',
      originalUrl: '/tg/wishlists',
      actorKey: tgActorHashFromTelegramId(12345),
      body: { title: 'X' },
      query: {},
    });
    prismaMock.idempotencyKey.findUnique.mockResolvedValue({
      actorHash: tgActorHashFromTelegramId(12345),
      requestHash: matchingHash,
      responseStatus: 201,
      responseBody: { id: 'wl-1', title: 'X' },
      responseTruncated: false,
      status: 'completed',
      lockedUntil: null,
      createdAt: new Date(Date.now() - 60_000),
      updatedAt: new Date(Date.now() - 60_000),
    });

    let nextCalled = false;
    const req = makeReq();
    const res = makeRes();
    await new Promise<void>((resolve) => {
      mw()(req, res as any, () => { nextCalled = true; resolve(); });
      setTimeout(resolve, 50);
    });

    expect(nextCalled).toBe(false);                 // handler must NOT run on replay
    expect(res.statusOf()).toBe(201);
    expect(res.body()).toEqual({ id: 'wl-1', title: 'X' });
    expect(res.getHeader('x-idempotent-replay')).toBe('1');
    expect(logCalls.find(c => c.obj.event === 'api.idempotency_replay')).toBeTruthy();
  });

  it('returns 409 when same key used with a different body', async () => {
    const { tgActorHashFromTelegramId } = await import('./security/ipHash');
    prismaMock.idempotencyKey.create.mockRejectedValue(new FakeP2002());
    prismaMock.idempotencyKey.findUnique.mockResolvedValue({
      actorHash: tgActorHashFromTelegramId(12345),
      requestHash: 'a-totally-different-hash',
      responseStatus: 200,
      responseBody: { id: 'wl-1' },
      responseTruncated: false,
      status: 'completed',
      lockedUntil: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const req = makeReq();
    const res = makeRes();
    let nextCalled = false;
    await new Promise<void>((resolve) => {
      mw()(req, res as any, () => { nextCalled = true; resolve(); });
      setTimeout(resolve, 50);
    });

    expect(nextCalled).toBe(false);
    expect(res.statusOf()).toBe(409);
    expect(res.body().error).toBe('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
    expect(logCalls.find(c => c.obj.event === 'api.idempotency_conflict')).toBeTruthy();
  });

  it('returns 409 IN_PROGRESS for an active processing row', async () => {
    const { tgActorHashFromTelegramId } = await import('./security/ipHash');
    prismaMock.idempotencyKey.create.mockRejectedValue(new FakeP2002());
    prismaMock.idempotencyKey.findUnique.mockResolvedValue({
      actorHash: tgActorHashFromTelegramId(12345),
      requestHash: 'irrelevant',
      status: 'processing',
      lockedUntil: futureLock(),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const req = makeReq();
    const res = makeRes();
    let nextCalled = false;
    await new Promise<void>((resolve) => {
      mw()(req, res as any, () => { nextCalled = true; resolve(); });
      setTimeout(resolve, 50);
    });

    expect(nextCalled).toBe(false);
    expect(res.statusOf()).toBe(409);
    expect(res.body().error).toBe('IDEMPOTENCY_REQUEST_IN_PROGRESS');
    expect(res.getHeader('retry-after')).toBe('5');
  });

  it('returns 409 KEY_STALE for a processing row with expired lock', async () => {
    const { tgActorHashFromTelegramId } = await import('./security/ipHash');
    prismaMock.idempotencyKey.create.mockRejectedValue(new FakeP2002());
    prismaMock.idempotencyKey.findUnique.mockResolvedValue({
      actorHash: tgActorHashFromTelegramId(12345),
      requestHash: 'irrelevant',
      status: 'processing',
      lockedUntil: pastLock(),
      createdAt: new Date(Date.now() - 120_000),
      updatedAt: new Date(Date.now() - 120_000),
    });
    const req = makeReq();
    const res = makeRes();
    let nextCalled = false;
    await new Promise<void>((resolve) => {
      mw()(req, res as any, () => { nextCalled = true; resolve(); });
      setTimeout(resolve, 50);
    });

    expect(nextCalled).toBe(false);
    expect(res.statusOf()).toBe(409);
    expect(res.body().error).toBe('IDEMPOTENCY_KEY_STALE');
  });

  it('takes over a failed row whose cooldown has elapsed (handler runs)', async () => {
    const { tgActorHashFromTelegramId } = await import('./security/ipHash');
    prismaMock.idempotencyKey.create.mockRejectedValue(new FakeP2002());
    prismaMock.idempotencyKey.findUnique.mockResolvedValue({
      actorHash: tgActorHashFromTelegramId(12345),
      requestHash: 'old-hash',
      status: 'failed',
      lockedUntil: pastLock(),
      createdAt: new Date(Date.now() - 600_000),
      updatedAt: new Date(Date.now() - 600_000),
    });
    const req = makeReq();
    const res = makeRes();
    let nextCalled = false;
    await new Promise<void>((resolve) => {
      mw()(req, res as any, () => { nextCalled = true; resolve(); });
      setTimeout(resolve, 50);
    });

    expect(nextCalled).toBe(true);
    expect(prismaMock.idempotencyKey.update).toHaveBeenCalled();
    expect(logCalls.find(c => c.obj.event === 'api.idempotency_retry_after_failed')).toBeTruthy();
  });

  it('returns 409 IDEMPOTENCY_RESPONSE_NOT_REPLAYABLE for noResponseReplay endpoint replay', async () => {
    const { computeRequestHash } = await import('./security/requestHash');
    const { tgActorHashFromTelegramId } = await import('./security/ipHash');
    prismaMock.idempotencyKey.create.mockRejectedValue(new FakeP2002());
    const hash = computeRequestHash({
      method: 'POST',
      originalUrl: '/tg/wishlists',
      actorKey: tgActorHashFromTelegramId(12345),
      body: { title: 'X' },
      query: {},
    });
    prismaMock.idempotencyKey.findUnique.mockResolvedValue({
      actorHash: tgActorHashFromTelegramId(12345),
      requestHash: hash,
      responseStatus: 200,
      responseBody: null,
      responseTruncated: true,
      status: 'completed',
      lockedUntil: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const req = makeReq();
    const res = makeRes();
    let nextCalled = false;
    await new Promise<void>((resolve) => {
      mw({ noResponseReplay: true })(req, res as any, () => { nextCalled = true; resolve(); });
      setTimeout(resolve, 50);
    });

    expect(nextCalled).toBe(false);
    expect(res.statusOf()).toBe(409);
    expect(res.body().error).toBe('IDEMPOTENCY_RESPONSE_NOT_REPLAYABLE');
  });
});

// ─── Critical endpoint behaviour ─────────────────────────────────────────────

describe('idempotency middleware — critical=true (billing/account-delete)', () => {
  it('logs idem_missing_on_critical_endpoint when no header is present, and passes through', async () => {
    const req = makeReq({ headers: {}, originalUrl: '/tg/billing/pro/checkout', path: '/billing/pro/checkout' });
    const res = makeRes();
    let nextCalled = false;
    await new Promise<void>((resolve) => {
      mw({ critical: true, endpointKey: 'POST /tg/billing/pro/checkout' })(req, res as any, () => {
        nextCalled = true;
        resolve();
      });
      setTimeout(resolve, 50);
    });
    expect(nextCalled).toBe(true);                 // soft-require: never blocks
    expect(prismaMock.idempotencyKey.create).not.toHaveBeenCalled();
    const logged = logCalls.find(c => c.obj.event === 'api.idem_missing_on_critical_endpoint');
    expect(logged).toBeTruthy();
    expect(logged!.obj.reason).toBe('no_header');
  });
});

// ─── Rate limit (uses the same logger mock — both produce structured events) ─

describe('rate limit — comment.minute (limit 10 / 60 s)', () => {
  it('returns 429 + Retry-After once the limit is exceeded, with hashed actor + no raw IP in logs', async () => {
    process.env.SECURITY_RATE_LIMIT_ENABLED = 'true';
    const { createRateLimiter } = await import('./security/rateLimits');
    const limiter = createRateLimiter('comment.minute');

    let lastRes: any;
    for (let i = 0; i < 11; i++) {
      const req = makeReq({ method: 'POST', originalUrl: `/tg/items/abc/comments` });
      const res = makeRes();
      await new Promise<void>((resolve) => {
        (limiter as any)(req, res, () => resolve());
        setTimeout(resolve, 30);
      });
      lastRes = res;
    }

    expect(lastRes.statusOf()).toBe(429);
    expect(lastRes.body().error).toBe('RATE_LIMITED');
    expect(lastRes.body().retryAfterSec).toBeGreaterThan(0);
    expect(lastRes.getHeader('retry-after')).toBeTruthy();

    const limitLog = logCalls.find(c => c.obj.event === 'api.rate_limited');
    expect(limitLog).toBeTruthy();
    expect(limitLog!.obj.actorHash).toMatch(/^[0-9a-f]{8}-/);
    expect(limitLog!.obj.ipHash).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(limitLog)).not.toContain('1.2.3.4');
  });
});

// ─── Log redaction guarantees (cross-cutting) ────────────────────────────────

describe('idempotency middleware — log redaction', () => {
  it('never logs the raw Idempotency-Key or raw IP in any captured event', async () => {
    const { tgActorHashFromTelegramId } = await import('./security/ipHash');
    prismaMock.idempotencyKey.create.mockRejectedValue(new FakeP2002());
    prismaMock.idempotencyKey.findUnique.mockResolvedValue({
      actorHash: tgActorHashFromTelegramId(12345),
      requestHash: 'differs',
      status: 'completed',
      responseStatus: 200,
      responseBody: { ok: true },
      responseTruncated: false,
      lockedUntil: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const req = makeReq();
    const res = makeRes();
    await new Promise<void>((resolve) => {
      mw()(req, res as any, () => resolve());
      setTimeout(resolve, 50);
    });

    expect(logCalls.length).toBeGreaterThan(0);
    for (const c of logCalls) {
      const dump = JSON.stringify(c);
      expect(dump.includes(VALID_KEY)).toBe(false);   // raw key
      expect(dump.includes('1.2.3.4')).toBe(false);   // raw IP
    }
  });
});
