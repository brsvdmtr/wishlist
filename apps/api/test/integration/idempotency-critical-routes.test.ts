// Integration tests for the Idempotency-Key middleware against a real
// Postgres `IdempotencyKey` table. Pins the contract for the four critical
// route classes that, if a duplicate slips through, hurt users in concrete
// ways: double wishlists, double items, double-billed Stars purchases.
//
// We mount the *production* middleware (apps/api/src/security/idempotency)
// in front of a stub handler in a thin Express app per test, using the
// exact `endpointKey` / `category` / `ttlMinutes` / `critical` options the
// real routes use in apps/api/src/index.ts (see § "Wishlists" / "Items
// (single)" / "Billing / Stars"). The harness deliberately bypasses the
// real route handlers — they pull in entitlements, Telegram notifications,
// services, and analytics; none of that is what we are pinning here. The
// invariant under test is "same key in, same effect, same body out", and
// that invariant lives entirely in the middleware + the unique index on
// `IdempotencyKey(key, actorKey, method, path)`.
//
// What this file pins, for each of: wishlist create, item create, billing
// PRO checkout, billing add-on checkout:
//
//   1. Same Idempotency-Key replayed → handler runs exactly once;
//      the second response is byte-equal to the first and carries
//      `X-Idempotent-Replay: 1`.
//   2. Different Idempotency-Key → handler runs again (business logic
//      gets to produce a fresh entity).
//   3. First attempt 5xx → the response body is NOT cached; a retry
//      with the same key during the 5-min cooldown returns
//      409 IDEMPOTENCY_FAILED_RECENTLY with `Retry-After`. (Pins the
//      "errors don't poison the cache" guarantee — important for
//      billing in particular, where a flaky Stars API must not lock
//      the user out of paying.)
//
// Plus one cross-cutting describe pinning the explicit 4xx-IS-cached
// contract — see `instrumentResponseAndPersist` comment "2xx/3xx/4xx —
// business outcome; cache so retries get the same answer." A 400 (e.g.
// validation error) on the first attempt is replayed on retry; the user
// has to mint a NEW key to get a fresh try. This is intentional and
// protects billing against double-tap retries that change a body slightly
// and end up double-charging.
//
// Auto-skip when DATABASE_URL is not set so local `pnpm test` stays fast.
// CI provides the Postgres service via .github/workflows/test.yml.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

import { getTestPrisma, disconnectTestPrisma } from '../setup-pg';
import { createIdempotencyMiddleware, type IdempotencyOptions } from '../../src/security/idempotency';
import { tgActorHashFromTelegramId } from '../../src/security/ipHash';
import {
  IDEMPOTENCY_BILLING_TTL_MINUTES,
  IDEMPOTENCY_DEFAULT_TTL_MINUTES,
} from '../../src/security/types';
import { CRITICAL_IDEMPOTENCY_ROUTES } from '../../src/security/idempotencyRoutes';

const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;

// Per-file telegramId base. Picked far above other integration suites
// (default-wishlist-race uses string prefixes; this one uses numeric IDs
// in a high range so the actorHash space is disjoint).
const TG_ID_BASE = 9_900_000;
let nextTgId = TG_ID_BASE;
const allActorKeys: string[] = [];
// Tracks User rows we explicitly seed (only the userId-column assertion
// needs a real User; everything else relies on the middleware's null-userId
// fallback path). Cleared together with IdempotencyKey rows in afterAll.
const seededUserIds: string[] = [];

function freshActor(): { telegramId: number; actorKey: string } {
  const telegramId = ++nextTgId;
  // The middleware computes actorKey via tgActorHashFromTelegramId for
  // Telegram-auth'd requests; we mirror that here so cleanup can target
  // own rows by actorKey without touching other suites' fixtures.
  const actorKey = tgActorHashFromTelegramId(telegramId);
  allActorKeys.push(actorKey);
  return { telegramId, actorKey };
}

// 32-char hex key — matches IDEMPOTENCY_KEY_REGEX `[A-Za-z0-9_-]{16,128}`.
function freshIdempotencyKey(): string {
  return randomUUID().replace(/-/g, '');
}

if (SKIP) {
  // eslint-disable-next-line no-console
  console.warn('[integration] DATABASE_URL not set — skipping idempotency-critical-routes integration tests');
}

// ─── Test harness ────────────────────────────────────────────────────────────
// Mounts the production idempotency middleware in front of a stub handler.
// The stub auth middleware lets each test pick its own telegramId via the
// `X-Test-Tg-Id` header, which is how we exercise the actor-mismatch /
// distinct-actor branches without booting the real Telegram-auth stack.

type StubHandler = (req: express.Request, res: express.Response) => void;

type Harness = {
  app: express.Express;
  // Counts how many times Express's middleware chain advances PAST the idem
  // middleware. On a successful replay the middleware short-circuits and
  // never invokes next(), so this stays 0 for that request — gives us an
  // explicit "next was never called" assertion independent of whether the
  // user's handler happens to also be a vi.fn() with its own call counter.
  // Catches future drift where someone adds another middleware after idem
  // that runs unconditionally and silently breaks the replay contract.
  downstreamHits: () => number;
};

function makeApp(opts: { idem: IdempotencyOptions; handler: StubHandler }): Harness {
  const app = express();
  app.use(express.json());
  // Stand-in for the real Telegram-auth middleware: pull the telegramId from
  // a test-only header so the security layer's `resolveActorKey` picks up the
  // tgUser path (actorHash UUID) rather than the unauth IP-fallback path.
  // Header absent → tgUser stays undefined → middleware uses the unauth
  // `ip:<hash>` actorKey path; that's intentional and exercised by the
  // unauth-vs-auth isolation describe below.
  app.use((req, _res, next) => {
    const tgIdHeader = req.header('x-test-tg-id');
    if (tgIdHeader) {
      (req as express.Request & { tgUser?: { id: number; first_name: string } }).tgUser = {
        id: Number(tgIdHeader),
        first_name: 'TestUser',
      };
    }
    next();
  });
  let downstream = 0;
  app.post(
    '/test',
    createIdempotencyMiddleware(opts.idem),
    (_req, _res, next) => {
      downstream += 1;
      next();
    },
    opts.handler,
  );
  return { app, downstreamHits: () => downstream };
}

// A stub handler that emits a sequential id each call so we can tell
// "handler actually ran" from "middleware replayed the cached body".
function makeCountingHandler(opts: { status?: number; bodyPrefix: string } = { bodyPrefix: 'created' }) {
  const calls = vi.fn();
  let n = 0;
  const handler: StubHandler = (req, res) => {
    calls(req.body);
    n += 1;
    const body = { id: `${opts.bodyPrefix}-${n}`, attempt: n };
    res.status(opts.status ?? 201).json(body);
  };
  return { handler, calls };
}

// `instrumentResponseAndPersist` registers a fire-and-forget DB write on
// res.on('finish') (idempotency.ts:369-379). The handler's response is sent
// to the client BEFORE that write lands. If the next request in the test
// fires while the row is still status='processing', the middleware returns
// 409 IDEMPOTENCY_REQUEST_IN_PROGRESS instead of replaying — silently
// breaking the contract we mean to assert.
//
// Earlier revision used `await sleep(50)` which is enough on a clean dev
// box but is the classic recipe for CI flakes under load. We now poll the
// row until it reaches a terminal state ('completed' or 'failed') with a
// short backoff. Budget is generous (3 s) — local writes settle in <10 ms,
// the Postgres-service-on-GitHub-Actions sits comfortably under 100 ms.
async function waitForRowSettle(
  actorKey: string,
  endpointKey: string,
  method = 'POST',
): Promise<void> {
  const db = getTestPrisma();
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const row = await db.idempotencyKey.findFirst({
      where: { actorKey, path: endpointKey, method },
      orderBy: { createdAt: 'desc' },
    });
    if (row && (row.status === 'completed' || row.status === 'failed')) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Idempotency row never settled for ${method} ${endpointKey} (actorKey=${actorKey})`);
}

// ─── Route options under test ────────────────────────────────────────────────
// Imported from `apps/api/src/security/idempotencyRoutes.ts` — the same
// constants `apps/api/src/index.ts` uses to wire production middleware.
// Any change to wiring (endpointKey, TTL, critical flag) lands in the
// shared module and forces both call sites to update together. A drift
// becomes a TypeScript error, not a silent "test keeps passing while prod
// is broken" regression.

const ROUTE_WISHLIST_CREATE: IdempotencyOptions = CRITICAL_IDEMPOTENCY_ROUTES.wishlistCreate;
const ROUTE_ITEM_CREATE: IdempotencyOptions = CRITICAL_IDEMPOTENCY_ROUTES.itemCreate;
const ROUTE_BILLING_PRO_CHECKOUT: IdempotencyOptions = CRITICAL_IDEMPOTENCY_ROUTES.billingProCheckout;
const ROUTE_BILLING_ADDON_CHECKOUT: IdempotencyOptions = CRITICAL_IDEMPOTENCY_ROUTES.billingAddonCheckout;

// ─── Shared test scenarios ───────────────────────────────────────────────────
// Each describe block calls into these to keep the four sections terse;
// the per-route describes only customise the route options + the body shape
// being POSTed (so different routes can't be confused even if a future
// refactor accidentally collapses endpointKey values).

function expectRowExpiresAtApprox(expiresAt: Date, wantTtlMinutes: number) {
  const diffMinutes = Math.abs((expiresAt.getTime() - Date.now()) / 60_000 - wantTtlMinutes);
  // 30-second tolerance: tight enough to catch unit-of-time confusion
  // (someone passing seconds-as-minutes would be off by ~24 h or ~7 d for
  // the two TTL classes we test), loose enough to absorb handler+persist
  // latency on a slow runner.
  expect(diffMinutes).toBeLessThan(0.5);
}

async function runReplayScenario(
  routeOpts: IdempotencyOptions,
  body: Record<string, unknown>,
  wantTtlMinutes: number,
) {
  const { handler, calls } = makeCountingHandler({ bodyPrefix: routeOpts.category });
  const { app, downstreamHits } = makeApp({ idem: routeOpts, handler });
  const { telegramId, actorKey } = freshActor();
  const key = freshIdempotencyKey();

  const r1 = await request(app).post('/test').set('Idempotency-Key', key).set('X-Test-Tg-Id', String(telegramId)).send(body);
  await waitForRowSettle(actorKey, routeOpts.endpointKey);
  const r2 = await request(app).post('/test').set('Idempotency-Key', key).set('X-Test-Tg-Id', String(telegramId)).send(body);

  // Handler runs exactly once — the replay short-circuits before next().
  // downstreamHits is the explicit "middleware never called next() on
  // replay" assertion; calls === 1 alone could miss a future regression
  // where a handler-adjacent middleware runs unconditionally.
  expect(calls).toHaveBeenCalledTimes(1);
  expect(downstreamHits()).toBe(1);
  expect(r1.status).toBe(201);
  expect(r2.status).toBe(201);
  expect(r2.body).toEqual(r1.body);
  expect(r2.headers['x-idempotent-replay']).toBe('1');

  // Confirm the row landed with the right shape: completed, scoped to the
  // route's endpointKey, scoped to this actor, with the right TTL, and
  // with lockedUntil cleared (per persistFinish — a stale lock on a
  // completed row would break support tooling that assumes the field
  // means "in-flight" once present).
  const db = getTestPrisma();
  const rows = await db.idempotencyKey.findMany({
    where: { actorKey, path: routeOpts.endpointKey, method: 'POST' },
  });
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe('completed');
  expect(rows[0]!.responseStatus).toBe(201);
  expect(rows[0]!.responseBody).toEqual(r1.body);
  expect(rows[0]!.lockedUntil).toBeNull();
  // No User row seeded for this telegramId → `resolveUserIdSafe` returns
  // null (and must NOT throw on the missing-user case). The "userId is
  // populated" describe pins the symmetric positive branch.
  expect(rows[0]!.userId).toBeNull();
  expectRowExpiresAtApprox(rows[0]!.expiresAt, wantTtlMinutes);
}

async function runDifferentKeyScenario(
  routeOpts: IdempotencyOptions,
  body: Record<string, unknown>,
) {
  const { handler, calls } = makeCountingHandler({ bodyPrefix: routeOpts.category });
  const { app, downstreamHits } = makeApp({ idem: routeOpts, handler });
  const { telegramId, actorKey } = freshActor();

  const r1 = await request(app).post('/test').set('Idempotency-Key', freshIdempotencyKey()).set('X-Test-Tg-Id', String(telegramId)).send(body);
  await waitForRowSettle(actorKey, routeOpts.endpointKey);
  const r2 = await request(app).post('/test').set('Idempotency-Key', freshIdempotencyKey()).set('X-Test-Tg-Id', String(telegramId)).send(body);

  // Different keys → handler ran twice → distinct entities. The business
  // logic decides whether the user is *allowed* to create two; the middleware
  // never blocks based on body content alone.
  expect(calls).toHaveBeenCalledTimes(2);
  expect(downstreamHits()).toBe(2);
  expect(r1.status).toBe(201);
  expect(r2.status).toBe(201);
  expect(r2.body).not.toEqual(r1.body);
  expect(r2.headers['x-idempotent-replay']).toBeUndefined();

  const db = getTestPrisma();
  const rows = await db.idempotencyKey.findMany({
    where: { actorKey, path: routeOpts.endpointKey, method: 'POST' },
  });
  expect(rows).toHaveLength(2);
}

async function run5xxNotCachedScenario(
  routeOpts: IdempotencyOptions,
  body: Record<string, unknown>,
) {
  // First attempt returns 500. Per the middleware contract, 5xx responses
  // are NOT cached as a replayable body — the row goes to status='failed'
  // with a 5-minute cooldown lock. A retry during cooldown must get a
  // 409 IDEMPOTENCY_FAILED_RECENTLY with Retry-After, not the cached 500.
  const { handler: failHandler } = makeCountingHandler({ status: 500, bodyPrefix: 'boom' });
  const harness1 = makeApp({ idem: routeOpts, handler: failHandler });
  const { telegramId, actorKey } = freshActor();
  const key = freshIdempotencyKey();

  const r1 = await request(harness1.app).post('/test').set('Idempotency-Key', key).set('X-Test-Tg-Id', String(telegramId)).send(body);
  expect(r1.status).toBe(500);
  await waitForRowSettle(actorKey, routeOpts.endpointKey);

  // Verify the row state directly — status='failed', no replayable body,
  // lockedUntil in the future = cooldown active.
  const db = getTestPrisma();
  const row = await db.idempotencyKey.findFirst({
    where: { actorKey, path: routeOpts.endpointKey, method: 'POST' },
  });
  expect(row).not.toBeNull();
  expect(row!.status).toBe('failed');
  expect(row!.responseBody).toBeNull();
  expect(row!.lockedUntil).not.toBeNull();
  expect(row!.lockedUntil!.getTime()).toBeGreaterThan(Date.now());

  // Now retry with the SAME key, mounted with a handler that would succeed
  // if it ran. The middleware MUST short-circuit with 409 — proving the
  // 5xx body wasn't cached as if it were a valid 2xx replay, AND that the
  // handler chain was never advanced (so a hypothetical post-idem analytics
  // shim wouldn't double-fire on retry either).
  const { handler: successHandler, calls: successCalls } = makeCountingHandler({ bodyPrefix: 'recovered' });
  const harness2 = makeApp({ idem: routeOpts, handler: successHandler });
  const r2 = await request(harness2.app).post('/test').set('Idempotency-Key', key).set('X-Test-Tg-Id', String(telegramId)).send(body);

  expect(successCalls).not.toHaveBeenCalled();
  expect(harness2.downstreamHits()).toBe(0);
  expect(r2.status).toBe(409);
  expect(r2.body.error).toBe('IDEMPOTENCY_FAILED_RECENTLY');
  expect(Number(r2.headers['retry-after'])).toBeGreaterThan(0);
  expect(r2.headers['x-idempotent-replay']).toBeUndefined();
}

// ─── Suite ───────────────────────────────────────────────────────────────────

suite('Idempotency-Key middleware — critical routes (real Postgres)', () => {
  // Save/restore the kill-switch env var: it defaults to "off in NODE_ENV=test"
  // (see isSecurityFeatureEnabled in security/types.ts), so we opt in here,
  // but we mutate process.env which is process-wide. Restoring in afterAll
  // keeps this suite self-contained if vitest ever shares a worker process
  // between files in the future.
  let prevSecurityEnv: string | undefined;
  beforeAll(() => {
    prevSecurityEnv = process.env.SECURITY_IDEMPOTENCY_ENABLED;
    process.env.SECURITY_IDEMPOTENCY_ENABLED = 'true';
  });

  // No beforeAll cleanup: `allActorKeys` is populated by `freshActor()` at
  // test-body invocation time, so a sweep here would always target an empty
  // list. Cross-test isolation comes from the per-test fresh telegramId +
  // fresh idempotency key — collisions across tests (or across parallel
  // integration files using the same Postgres) are statistically impossible.

  afterAll(async () => {
    const db = getTestPrisma();
    // IdempotencyKey rows first (no FK out), then any seeded Users (FK back
    // from IdempotencyKey.userId, so order matters when both exist).
    await db.idempotencyKey.deleteMany({ where: { actorKey: { in: allActorKeys } } });
    if (seededUserIds.length > 0) {
      await db.user.deleteMany({ where: { id: { in: seededUserIds } } });
    }
    await disconnectTestPrisma();
    if (prevSecurityEnv === undefined) {
      delete process.env.SECURITY_IDEMPOTENCY_ENABLED;
    } else {
      process.env.SECURITY_IDEMPOTENCY_ENABLED = prevSecurityEnv;
    }
  });

  // ── 1. POST /tg/wishlists ────────────────────────────────────────────────
  describe('wishlist create — POST /tg/wishlists', () => {
    it('same key → handler runs once, response replayed byte-equal', async () => {
      await runReplayScenario(ROUTE_WISHLIST_CREATE, { title: 'Birthday list' }, IDEMPOTENCY_DEFAULT_TTL_MINUTES);
    });

    it('different keys → handler runs twice (two wishlists created)', async () => {
      await runDifferentKeyScenario(ROUTE_WISHLIST_CREATE, { title: 'Birthday list' });
    });

    it('5xx first attempt is NOT cached — retry during cooldown returns 409 IDEMPOTENCY_FAILED_RECENTLY', async () => {
      await run5xxNotCachedScenario(ROUTE_WISHLIST_CREATE, { title: 'Birthday list' });
    });
  });

  // ── 2. POST /tg/wishlists/:id/items ──────────────────────────────────────
  describe('item create — POST /tg/wishlists/:id/items', () => {
    it('same key → handler runs once, response replayed byte-equal', async () => {
      await runReplayScenario(ROUTE_ITEM_CREATE, { title: 'Lego set', priority: 'HIGH' }, IDEMPOTENCY_DEFAULT_TTL_MINUTES);
    });

    it('different keys → handler runs twice (two items created)', async () => {
      await runDifferentKeyScenario(ROUTE_ITEM_CREATE, { title: 'Lego set', priority: 'HIGH' });
    });

    it('5xx first attempt is NOT cached — retry during cooldown returns 409 IDEMPOTENCY_FAILED_RECENTLY', async () => {
      await run5xxNotCachedScenario(ROUTE_ITEM_CREATE, { title: 'Lego set', priority: 'HIGH' });
    });
  });

  // ── 3. POST /tg/billing/pro/checkout (7-day TTL, critical=true) ──────────
  describe('billing PRO checkout — POST /tg/billing/pro/checkout', () => {
    it('same key → handler runs once, response replayed byte-equal (no double-billed Stars invoice)', async () => {
      await runReplayScenario(ROUTE_BILLING_PRO_CHECKOUT, { plan: 'pro_year' }, IDEMPOTENCY_BILLING_TTL_MINUTES);
    });

    it('different keys → handler runs twice (user is allowed to start a fresh checkout)', async () => {
      await runDifferentKeyScenario(ROUTE_BILLING_PRO_CHECKOUT, { plan: 'pro_year' });
    });

    it('5xx first attempt is NOT cached — retry during cooldown returns 409 IDEMPOTENCY_FAILED_RECENTLY (Stars outage must not lock the user out)', async () => {
      await run5xxNotCachedScenario(ROUTE_BILLING_PRO_CHECKOUT, { plan: 'pro_year' });
    });
  });

  // ── 4. POST /tg/billing/addon/checkout (7-day TTL, critical=true) ────────
  describe('billing add-on checkout — POST /tg/billing/addon/checkout', () => {
    it('same key → handler runs once, response replayed byte-equal', async () => {
      await runReplayScenario(ROUTE_BILLING_ADDON_CHECKOUT, { sku: 'hint_pack_5' }, IDEMPOTENCY_BILLING_TTL_MINUTES);
    });

    it('different keys → handler runs twice (two distinct add-on invoices)', async () => {
      await runDifferentKeyScenario(ROUTE_BILLING_ADDON_CHECKOUT, { sku: 'hint_pack_5' });
    });

    it('5xx first attempt is NOT cached — retry during cooldown returns 409 IDEMPOTENCY_FAILED_RECENTLY', async () => {
      await run5xxNotCachedScenario(ROUTE_BILLING_ADDON_CHECKOUT, { sku: 'hint_pack_5' });
    });
  });

  // ── Cross-cutting: 4xx IS cached (explicit current contract) ─────────────
  // Pins the "2xx/3xx/4xx — business outcome; cache so retries get the same
  // answer" branch of instrumentResponseAndPersist. A validation failure on
  // attempt 1 is replayed on attempt 2 with the SAME key — the client has to
  // mint a NEW key to get a fresh try. This is deliberate: it stops a buggy
  // client from looping `submit → 400 → retry` and accidentally double-charging
  // the moment validation passes (e.g. timezone-corrected timestamp). If this
  // ever needs to flip to "4xx is NOT cached", this test is the canary.
  describe('4xx response IS cached per current contract', () => {
    it('replays the cached 400 body on retry with the same key', async () => {
      let calls = 0;
      const handler: StubHandler = (_req, res) => {
        calls += 1;
        res.status(400).json({ error: 'VALIDATION_FAILED', field: 'title' });
      };
      const { app, downstreamHits } = makeApp({ idem: ROUTE_WISHLIST_CREATE, handler });
      const { telegramId, actorKey } = freshActor();
      const key = freshIdempotencyKey();

      const r1 = await request(app).post('/test').set('Idempotency-Key', key).set('X-Test-Tg-Id', String(telegramId)).send({ title: '' });
      await waitForRowSettle(actorKey, ROUTE_WISHLIST_CREATE.endpointKey);
      const r2 = await request(app).post('/test').set('Idempotency-Key', key).set('X-Test-Tg-Id', String(telegramId)).send({ title: '' });

      expect(calls).toBe(1);
      expect(downstreamHits()).toBe(1); // explicit: middleware never advanced past itself on replay
      expect(r1.status).toBe(400);
      expect(r2.status).toBe(400);
      expect(r2.body).toEqual(r1.body);
      expect(r2.headers['x-idempotent-replay']).toBe('1');
    });
  });

  // ── Cross-cutting: actor isolation ───────────────────────────────────────
  // Two distinct Telegram users sending the SAME idempotency key + SAME body
  // must each get their own row (and each handler invocation), because the
  // unique index is `(key, actorKey, method, path)` — the actorHash is part
  // of the key. Without this, user A could brick user B's first POST by
  // pre-claiming a key, OR (worse) replay B's stored response. This pins the
  // defence in depth that the existing unit test mocks can only assert about.
  describe('actor isolation — same key, different telegramIds → two independent rows', () => {
    it('user A and user B each get their own row + their own response', async () => {
      const { handler, calls } = makeCountingHandler({ bodyPrefix: 'wl' });
      const { app } = makeApp({ idem: ROUTE_WISHLIST_CREATE, handler });
      const userA = freshActor();
      const userB = freshActor();
      const sharedKey = freshIdempotencyKey();

      const rA = await request(app).post('/test').set('Idempotency-Key', sharedKey).set('X-Test-Tg-Id', String(userA.telegramId)).send({ title: 'A' });
      await waitForRowSettle(userA.actorKey, ROUTE_WISHLIST_CREATE.endpointKey);
      const rB = await request(app).post('/test').set('Idempotency-Key', sharedKey).set('X-Test-Tg-Id', String(userB.telegramId)).send({ title: 'B' });

      expect(calls).toHaveBeenCalledTimes(2);
      expect(rA.body).not.toEqual(rB.body);
      expect(rA.headers['x-idempotent-replay']).toBeUndefined();
      expect(rB.headers['x-idempotent-replay']).toBeUndefined();

      const db = getTestPrisma();
      const rowA = await db.idempotencyKey.findUnique({
        where: { key_actorKey_method_path: { key: sharedKey, actorKey: userA.actorKey, method: 'POST', path: ROUTE_WISHLIST_CREATE.endpointKey } },
      });
      const rowB = await db.idempotencyKey.findUnique({
        where: { key_actorKey_method_path: { key: sharedKey, actorKey: userB.actorKey, method: 'POST', path: ROUTE_WISHLIST_CREATE.endpointKey } },
      });
      expect(rowA).not.toBeNull();
      expect(rowB).not.toBeNull();
      expect(rowA!.actorKey).not.toBe(rowB!.actorKey);
    });
  });

  // ── Cross-cutting: unauth → auth cannot replay across the auth boundary ──
  // The unique index keys on `actorKey`, not `actorHash`. For an auth'd
  // Telegram user actorKey is a UUID; for an unauth caller it's
  // `ip:<hash>`. Same Idempotency-Key value sent first as unauth, then as
  // auth, produces two distinct rows — proving an unauth attacker cannot
  // pre-claim a key to hijack a future authed user's response, AND that
  // an authed user's cached body never leaks to an unauth retry. supertest
  // sends from 127.0.0.1 so the unauth actorKey is deterministic; trust
  // proxy is left off, which is the right default for this stub app.
  describe('unauth and auth requests with same key never share a row', () => {
    it('unauth POST followed by auth POST with same Idempotency-Key → two rows, no replay', async () => {
      const { handler, calls } = makeCountingHandler({ bodyPrefix: 'mixed' });
      const { app } = makeApp({ idem: ROUTE_WISHLIST_CREATE, handler });
      const sharedKey = freshIdempotencyKey();
      const { telegramId, actorKey: authActorKey } = freshActor();
      const db = getTestPrisma();

      // r1: unauth — no X-Test-Tg-Id header → tgUser undefined → middleware
      // falls back to `ip:<hash>` actorKey. Poll on key+path because we
      // don't know the unauth actorKey ahead of time (depends on supertest's
      // ephemeral 127.0.0.1 + IP_HASH_SALT).
      const r1 = await request(app).post('/test').set('Idempotency-Key', sharedKey).send({ title: 'unauth' });
      const settledByKey = async () => {
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          const rows = await db.idempotencyKey.findMany({
            where: { key: sharedKey, path: ROUTE_WISHLIST_CREATE.endpointKey, method: 'POST' },
          });
          const settled = rows.find((r) => r.status === 'completed' || r.status === 'failed');
          if (settled) return settled;
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error('Unauth row never settled');
      };
      const unauthRow = await settledByKey();
      // Track the unauth actorKey for afterAll cleanup IMMEDIATELY — before
      // any assertion that could throw and orphan the row in the shared DB.
      // (`freshActor()` would have done this for an auth'd request; the
      // unauth path bypasses that helper, so we mirror its bookkeeping here.)
      allActorKeys.push(unauthRow.actorKey);

      const r2 = await request(app).post('/test').set('Idempotency-Key', sharedKey).set('X-Test-Tg-Id', String(telegramId)).send({ title: 'auth' });

      // Handler ran twice — once per actorKey — and neither response is a replay.
      expect(calls).toHaveBeenCalledTimes(2);
      expect(r1.body).not.toEqual(r2.body);
      expect(r1.headers['x-idempotent-replay']).toBeUndefined();
      expect(r2.headers['x-idempotent-replay']).toBeUndefined();

      const rows = await db.idempotencyKey.findMany({
        where: { key: sharedKey, path: ROUTE_WISHLIST_CREATE.endpointKey, method: 'POST' },
        orderBy: { createdAt: 'asc' },
      });
      expect(rows).toHaveLength(2);
      const unauth = rows.find((r) => r.actorHash === null);
      const auth = rows.find((r) => r.actorHash !== null);
      expect(unauth).toBeDefined();
      expect(auth).toBeDefined();
      expect(unauth!.actorKey.startsWith('ip:')).toBe(true);
      expect(auth!.actorKey).toBe(authActorKey);
    });
  });

  // ── Cross-cutting: userId column is populated when the User row exists ──
  // `resolveUserIdSafe` does a `findUnique({where:{telegramId}})` and writes
  // the internal User.id onto the IdempotencyKey row for support tooling.
  // The other tests in this file deliberately skip seeding User rows (the
  // middleware's null-fallback path is also valid), so this one explicitly
  // pins the populated branch.
  describe('IdempotencyKey.userId is populated when a User row exists for the actor', () => {
    it('seeded telegramId → row.userId matches the User.id', async () => {
      const { handler } = makeCountingHandler({ bodyPrefix: 'wl' });
      const { app } = makeApp({ idem: ROUTE_WISHLIST_CREATE, handler });
      const { telegramId, actorKey } = freshActor();

      const db = getTestPrisma();
      const user = await db.user.create({ data: { telegramId: String(telegramId) } });
      seededUserIds.push(user.id);

      const r = await request(app).post('/test').set('Idempotency-Key', freshIdempotencyKey()).set('X-Test-Tg-Id', String(telegramId)).send({ title: 'with user' });
      await waitForRowSettle(actorKey, ROUTE_WISHLIST_CREATE.endpointKey);
      expect(r.status).toBe(201);

      const row = await db.idempotencyKey.findFirst({ where: { actorKey, path: ROUTE_WISHLIST_CREATE.endpointKey } });
      expect(row).not.toBeNull();
      expect(row!.userId).toBe(user.id);
    });
  });
});
