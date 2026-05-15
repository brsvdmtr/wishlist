# apps/api Test Infrastructure

Lightweight test scaffolding for integration tests against a real Postgres.

## Layout

- `setup-pg.ts` — connects to a Postgres URL from `DATABASE_URL`, exposes a Prisma client and a `resetDb()` helper for between-test isolation.
- `factories/` — test data builders for `User`, `Wishlist`, `Item`, `Reservation`, etc. Keep them small and explicit; prefer obvious overrides to clever defaults.
- `mock-ctx.ts` — Express request/response mocks for unit-testing route handlers in isolation. Integration tests should use `supertest` against a real Express app instead.

## Running locally

```bash
# 1. Start Postgres
docker compose -f docker-compose.dev.yml up -d postgres

# 2. Create test database (one-time)
docker exec wishlist-dev-postgres-1 psql -U wishlist -c \
  "CREATE DATABASE wishlist_test;"

# 3. Apply migrations against test DB
DATABASE_URL=postgresql://wishlist:wishlist@localhost:5432/wishlist_test \
  pnpm -C packages/db db:migrate:deploy

# 4. Run tests
DATABASE_URL=postgresql://wishlist:wishlist@localhost:5432/wishlist_test \
  pnpm -C apps/api test
```

CI does the equivalent via `.github/workflows/test.yml` — see that file for the canonical setup.

## Conventions

- **One Prisma client per test process**, not per test. Created in `setup-pg.ts` globalSetup hook.
- **Isolate between tests with `resetDb()`** (TRUNCATE all tables) — not transactions, since Prisma transactions don't span nested operations cleanly.
- **Factories return objects suitable for direct Prisma create.** Keep builder API: `userFactory({ id: 't123' })` not `new UserFactory().build({...})`.
- **Real DB only.** Don't mock Prisma in integration tests — the whole point is catching P2002, constraint, and query-shape bugs that mocks hide.
