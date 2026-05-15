# apps/api Integration Tests

Tests in this directory hit a real Postgres database. They auto-skip when
`DATABASE_URL` is not set, so `pnpm test` stays fast on a fresh laptop with
no Docker running.

## When to put a test here

- Behaviour depends on **real Prisma engine semantics** the in-memory mock
  can't reproduce (P2002 race, transaction isolation, `ON CONFLICT`).
- Behaviour depends on **constraint enforcement** (unique indexes, FK
  cascades, NOT NULL guards).
- Behaviour depends on **query-shape correctness** under real data (the
  exact SQL Prisma generates matters).

The recurring 2026-04-30 `getOrCreateProfile` P2002 race was caught by
unit-level mock testing only AFTER prod hit it. The integration tests
here pin that class of bug against the real engine.

## Running locally

```bash
# 1. Start Postgres
docker compose -f docker-compose.dev.yml up -d postgres

# 2. Create test database (one-time)
docker exec wishlist-dev-postgres-1 psql -U wishlist -c \
  "CREATE DATABASE wishlist_test;"

# 3. Push schema (db push, not migrate deploy — see test.yml comment)
DATABASE_URL=postgresql://wishlist:wishlist@localhost:5432/wishlist_test \
  pnpm -C packages/db exec prisma db push --schema=prisma/schema.prisma \
  --skip-generate --accept-data-loss

# 4. Run integration tests only
DATABASE_URL=postgresql://wishlist:wishlist@localhost:5432/wishlist_test \
  pnpm -C apps/api test test/integration/
```

CI provides `DATABASE_URL` via the postgres service container in
`.github/workflows/test.yml`, so these run on every PR and push without
manual setup.

## Auto-skip pattern

```ts
const SKIP = !process.env.DATABASE_URL;
const suite = SKIP ? describe.skip : describe;

if (SKIP) {
  console.warn('[integration] DATABASE_URL not set — skipping ...');
}

suite('my integration suite', () => {
  // ...
});
```

The console.warn makes the skip visible in CI logs even when the suite
isn't a hard failure.

## Test isolation

Each file uses `resetDb()` in `beforeAll` to TRUNCATE all tables before
seeding. Inside a suite, tests share the seeded fixtures and clean up only
the rows they create (typically in `beforeEach`).

For tests that need a clean slate per test, call `resetDb()` in
`beforeEach` — at the cost of re-seeding fixtures every time.
