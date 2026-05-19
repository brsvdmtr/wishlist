# AnalyticsEvent.props GIN index — apply / verify / rollback

**Status:** living runbook. Touch on every change to
[`ops/migrations/2026-05-19-analytics-props-gin-index.sql`](../../ops/migrations/2026-05-19-analytics-props-gin-index.sql).

**Audience:** the operator applying the index to prod. Mini-app +
backend devs reading this should skip to [§ 5](#5-why-this-is-not-a-prisma-migration)
and [§ 7](#7-how-to-actually-use-the-index-from-application-code).

---

## TL;DR

1. The index is **not** in any Prisma migration. It is applied
   out-of-band via `psql` against the prod database. Reason:
   `CREATE INDEX CONCURRENTLY` cannot run inside Prisma's per-migration
   transaction.
2. The script at
   [`ops/migrations/2026-05-19-analytics-props-gin-index.sql`](../../ops/migrations/2026-05-19-analytics-props-gin-index.sql)
   is a **single statement**. No `DO` block, no `BEGIN/COMMIT`, no
   transactions of any kind. Invalid-index cleanup is a separate
   manual step ([§ 3](#3-invalid-cleanup-manual)).
3. **DO NOT** run this script via:
   - any Prisma migration command (`prisma migrate dev/deploy/reset`),
   - any transaction-wrapped migration runner,
   - `psql --single-transaction` or `psql -1`,
   - a wrapping `BEGIN; ... COMMIT;`,
   - a `DO $$ ... END $$` block (DO bodies are transactional).
   All of these will fail with errcode `25001` / `0A000` ("active SQL
   transaction" / "CREATE INDEX CONCURRENTLY cannot run inside a
   transaction block").
4. To actually benefit from the index, god-mode queries must use the
   `@>` (containment) operator, not `props->>'k' = 'v'`. See [§ 7](#7-how-to-actually-use-the-index-from-application-code).
5. Rollback is a one-liner — `DROP INDEX CONCURRENTLY` — and also is
   non-transactional, same DO-NOT list as above.

---

## 1. Pre-flight checks

Before running anything, capture the baseline so you have a known-good
state to compare against on failure.

```bash
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "
SELECT
  pg_size_pretty(pg_total_relation_size('\''\"AnalyticsEvent\"'\'')) AS total_size,
  pg_size_pretty(pg_relation_size('\''\"AnalyticsEvent\"'\'')) AS heap_size,
  count(*) AS rowcount
FROM \"AnalyticsEvent\";
"'
```

Record `rowcount` in the deploy log. Build time scales with row count;
on the first apply it gives the next operator a baseline.

Check whether a previous attempt left an INVALID index:

```bash
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "
SELECT
  c.relname AS index_name,
  i.indisvalid,
  i.indisready
FROM pg_class c
JOIN pg_index i ON i.indexrelid = c.oid
WHERE c.relname = '\''idx_analytics_event_props_gin'\'';
"'
```

Outcomes:

| Result                      | What it means                          | Next step                          |
| --------------------------- | -------------------------------------- | ---------------------------------- |
| 0 rows                      | Index does not exist                   | Skip to [§ 2 — Apply](#2-apply-to-prod) |
| `indisvalid = t`            | Index is healthy from a previous apply | Nothing to do — done               |
| `indisvalid = f`            | Build failed mid-flight, INVALID       | Run [§ 3 — Invalid cleanup](#3-invalid-cleanup-manual), then go to [§ 2](#2-apply-to-prod) |

---

## 2. Apply to prod

The script **must not** run inside a transaction. `psql` is in autocommit
mode by default; do not change that. Do not pass `--single-transaction`
or `-1`. Do not pre-wrap with `BEGIN`. Do not pipe through any tool
that opens a transaction (Prisma migrate, dbmate, sqitch, etc.).

```bash
# Copy the SQL into the prod container.
scp ops/migrations/2026-05-19-analytics-props-gin-index.sql \
    vultr:/tmp/analytics-props-gin.sql

ssh vultr 'docker cp /tmp/analytics-props-gin.sql wishlist-prod-postgres-1:/tmp/'

# Run, stop on first error, NO --single-transaction.
ssh vultr 'docker exec wishlist-prod-postgres-1 \
  psql -U wishlist -d wishlist \
       -v ON_ERROR_STOP=1 \
       -f /tmp/analytics-props-gin.sql'
```

Build time will be measured in seconds-to-low-minutes depending on row
count. You can `^C` the SSH session safely — the index build continues
server-side. To monitor:

```bash
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "
SELECT pid, now() - query_start AS elapsed, state, query
FROM pg_stat_activity
WHERE query ILIKE '\''%CREATE INDEX CONCURRENTLY%idx_analytics_event_props_gin%'\'';
"'
```

If the build fails or you interrupt it: go to [§ 3 — Invalid cleanup](#3-invalid-cleanup-manual)
before re-running [§ 2](#2-apply-to-prod).

---

## 3. Invalid cleanup (manual)

If the pre-flight check or a build interruption shows an INVALID
index (`indisvalid = f`), drop it manually. This is **not** part of
the apply script — it's a separate one-liner the operator runs.

Same constraint as `CREATE INDEX CONCURRENTLY`: do **not** wrap in
`BEGIN/COMMIT`, do **not** use `--single-transaction`, do **not**
embed in a `DO` block.

```bash
ssh vultr 'docker exec wishlist-prod-postgres-1 \
  psql -U wishlist -d wishlist \
       -v ON_ERROR_STOP=1 \
       -c "DROP INDEX CONCURRENTLY IF EXISTS \"idx_analytics_event_props_gin\";"'
```

Verify:

```bash
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "
SELECT count(*) AS still_there
FROM pg_class
WHERE relname = '\''idx_analytics_event_props_gin'\'';
"'
```

Expected: `still_there = 0`. Now re-run [§ 2](#2-apply-to-prod).

> **Why not automate this inside the apply script?** Both
> `CREATE INDEX CONCURRENTLY` and `DROP INDEX CONCURRENTLY` reject any
> transaction context. A conditional `DO $$ ... END $$` block to drop
> an invalid index would itself be transactional — it would either
> fail with `0A000` if it tries `DROP INDEX CONCURRENTLY`, or work but
> take `AccessExclusiveLock` on the table if it falls back to plain
> `DROP INDEX`, which violates the no-write-block guarantee. Keeping
> cleanup manual keeps the apply path unambiguously safe.

---

## 4. Post-apply verification

```bash
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "
SELECT
  i.indexrelid::regclass AS index_name,
  i.indisvalid,
  i.indisready,
  pg_size_pretty(pg_relation_size(i.indexrelid)) AS index_size,
  am.amname AS access_method
FROM pg_index i
JOIN pg_class c ON c.oid = i.indexrelid
JOIN pg_am am ON am.oid = c.relam
WHERE i.indrelid = '\''\"AnalyticsEvent\"'\''::regclass
  AND c.relname = '\''idx_analytics_event_props_gin'\'';
"'
```

Expected output:

| index_name                       | indisvalid | indisready | index_size | access_method |
| -------------------------------- | ---------- | ---------- | ---------- | ------------- |
| idx_analytics_event_props_gin    | t          | t          | (varies)   | gin           |

**Both `indisvalid` and `indisready` must be `t`.** If `indisvalid = f`,
go to [§ 3](#3-invalid-cleanup-manual) and retry.

Smoke test with EXPLAIN — see [§ 7](#7-how-to-actually-use-the-index-from-application-code)
for the exact queries.

---

## 5. Why this is not a Prisma migration

Prisma wraps each `migration.sql` in `BEGIN; ... COMMIT;`. PostgreSQL
rejects `CREATE INDEX CONCURRENTLY` inside any transaction block
(errcode `25001`).

Options considered:

| Option                                            | Verdict                  | Reason                                                                                                                                                                                                                       |
| ------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add `@@index([props], type: Gin)` to `schema.prisma` | ❌                       | Prisma generates plain `CREATE INDEX` (no CONCURRENTLY) inside its txn. With AnalyticsEvent's write rate, that holds AccessExclusiveLock long enough to block god-mode inserts and tank the dashboard.                       |
| Plain Prisma migration with raw SQL               | ❌                       | Same — the SQL still runs inside Prisma's BEGIN/COMMIT.                                                                                                                                                                       |
| Standalone ops SQL + Prisma untouched             | ✅ (this doc's approach) | Apply once via psql, document, move on. Prisma's view of the schema does not include perf-only indexes, which is fine; future `prisma db pull` will pick the index up if a dev decides to add it to the schema literal.     |
| Standalone ops SQL + empty Prisma migration + `prisma migrate resolve --applied` | considered, rejected | More moving parts, no real benefit. The index has no model-level meaning (perf-only, not a constraint).                                                                                                                       |

The 2026-05-16 `global_search_pg_trgm_and_foreign_wishlist_access`
migration's header already called this out:

> If the prod row count grows past ~5M, future GIN additions should
> migrate via raw SQL outside Prisma's transaction wrapper using
> `CREATE INDEX CONCURRENTLY`. The indexes here are the baseline;
> follow-up indexes go in their own migrations.

This is that follow-up.

---

## 6. Rollback

Non-blocking, same non-transactional constraint:

```bash
ssh vultr 'docker exec wishlist-prod-postgres-1 \
  psql -U wishlist -d wishlist \
       -v ON_ERROR_STOP=1 \
       -c "DROP INDEX CONCURRENTLY IF EXISTS \"idx_analytics_event_props_gin\";"'
```

Verify the index is gone:

```bash
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "
SELECT count(*) FROM pg_class WHERE relname = '\''idx_analytics_event_props_gin'\'';
"'
```

Expected: `count = 0`.

---

## 7. How to actually use the index from application code

The pitfall: a GIN index on `jsonb` does **not** accelerate
`props->>'key' = 'value'` predicates. The `->>` operator extracts text
and is opaque to GIN. The index can only be used by the operators its
operator class supports.

`jsonb_path_ops` supports exactly:

| Operator | Meaning                  | Example                                    |
| -------- | ------------------------ | ------------------------------------------ |
| `@>`     | contains                 | `props @> '{"onboarding_key":"foo"}'::jsonb` |
| `@?`     | jsonpath exists          | `props @? '$.onboarding_key ? (@ == "foo")'` |
| `@@`     | jsonpath match (boolean) | `props @@ '$.onboarding_key == "foo"'`     |

### Rewriting existing god-mode queries

Concrete examples from `apps/api/src/routes/me.routes.ts`:

```sql
-- BEFORE — sequential scan, no index used
SELECT props->>'variant_key' AS variant_key, COUNT(*)
FROM "AnalyticsEvent"
WHERE event = 'onboarding_started'
  AND props->>'onboarding_key' = 'hello_activation'
GROUP BY 1;

-- AFTER — GIN index used to narrow rows before the GROUP BY
SELECT props->>'variant_key' AS variant_key, COUNT(*)
FROM "AnalyticsEvent"
WHERE event = 'onboarding_started'
  AND props @> '{"onboarding_key":"hello_activation"}'::jsonb
GROUP BY 1;
```

`props->>'variant_key'` in the **SELECT list** is fine — it doesn't
prevent the index from being used in the `WHERE`.

### EXPLAIN smoke test (run after apply)

Post-rewrite (containment query against the new index) — should show
`Bitmap Index Scan on idx_analytics_event_props_gin`:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*)
FROM "AnalyticsEvent"
WHERE props @> '{"onboarding_key":"hello_activation"}'::jsonb;
```

The legacy form (still in the code today) — should show `Seq Scan` and
serves as the "before" comparison:

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT count(*)
FROM "AnalyticsEvent"
WHERE props->>'onboarding_key' = 'hello_activation';
```

Run both. Paste the timings into `docs/BUGFIX_LESSONS.md` (or the
deploy log) so the rewrite of god-mode queries can be prioritised
against the measured win.

### Composite predicates

The dashboard usually combines `event` + `props`-filter:

```sql
WHERE event = 'onboarding_started'
  AND props @> '{"onboarding_key":"hello_activation"}'::jsonb
```

Postgres can BitmapAnd between the existing `AnalyticsEvent_event_createdAt_idx`
and the new GIN index — both narrow the candidate rows before the heap
fetch. No new composite index needed for now.

---

## 8. Local dev / CI

The index is **not** auto-applied in dev or CI:

- Dev DB (`docker compose -f docker-compose.dev.yml up -d postgres`):
  no GIN index. Queries still return the same results, just via seq
  scan. Apply manually to mirror prod — same psql invocation, no
  transaction wrapping:

  ```bash
  docker exec wishlist-dev-postgres-1 \
    psql -U wishlist -d wishlist \
         -v ON_ERROR_STOP=1 \
         -f ops/migrations/2026-05-19-analytics-props-gin-index.sql
  ```

- CI (`.github/workflows/test.yml` Postgres service): no GIN index.
  Tests do not assert on index presence; `EXPLAIN`-asserting tests are
  out of scope for the current suite. If a query-plan regression test
  is added later, it must apply this script in the test fixture, NOT
  add the index to a Prisma migration (same transaction-wrap reason).

---

## 9. Cross-references

- SQL script: [`ops/migrations/2026-05-19-analytics-props-gin-index.sql`](../../ops/migrations/2026-05-19-analytics-props-gin-index.sql)
- Sibling migration that scoped this work for follow-up:
  [`packages/db/prisma/migrations/20260516000000_global_search_pg_trgm_and_foreign_wishlist_access/migration.sql`](../../packages/db/prisma/migrations/20260516000000_global_search_pg_trgm_and_foreign_wishlist_access/migration.sql)
- AnalyticsEvent contract: [`docs/analytics-events.md`](../analytics-events.md)
- God-mode queries: [`docs/ANALYTICS_AND_GODMODE.md`](../ANALYTICS_AND_GODMODE.md)
- Post-deploy health checks: top of [`CLAUDE.md`](../../CLAUDE.md)
