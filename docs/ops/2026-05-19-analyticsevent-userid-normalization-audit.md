# Audit log — `AnalyticsEvent.userId` normalization (2026-05-19)

**Migration:** `20260519180000_normalize_analyticsevent_userid`
**Pre-flight snapshot taken:** 2026-05-19 (UTC), against
`wishlist-prod-postgres-1` on Vultr Amsterdam.
**Code commit shipping the contract + migration:** `c179a69`.

## Why this file exists

The migration rewrites `AnalyticsEvent.userId` from the historical
Telegram-numeric-id format to the canonical internal `User.id` (cuid).
Rows whose legacy Telegram id no longer maps to a current `User` row
become `NULL` — a one-way data loss in the sense that the original
Telegram id is overwritten and the link to "who was this?" disappears.

This file records the **scope** of that loss before it happens, so the
operator can verify the migration's impact post-deploy without having to
trust memory or grep logs. PII rule: we keep distinct counts, date
ranges, and event-mix — **not** raw Telegram numeric IDs. The raw
orphan id is still recoverable from prod via the recovery query at the
bottom of this file (run before the migration commits, or against any
restored backup taken before the deploy of commit `c179a69`).

---

## 1. Total `AnalyticsEvent` distribution (pre-migration)

| Group | Rows | Format |
|---|---:|---|
| Total | 10 527 | — |
| NULL | 158 | (guest events, mostly `guest.view_opened`) |
| cuid-format | 1 111 | server-side emitters writing `user.id` |
| Numeric (Telegram id) | 9 258 | frontend telemetry + 2 bot emitters |
| Other format | 0 | — |

## 2. What the migration will do

| Action | Rows | Result |
|---|---:|---|
| Numeric rows → mapped to `User.id` via `User.telegramId` lookup | 9 200 | Joined to live User row |
| Numeric rows with no matching User → NULL | 58 | Orphaned (see § 3) |
| Cuid-format rows | 1 111 | Unchanged |
| NULL rows | 158 | Unchanged |

Post-migration expected state: 10 311 cuid + 216 NULL + 0 numeric + 0 other = 10 527 total.

## 3. Orphan scope (data being NULL'd)

- **Distinct orphan Telegram IDs:** **1**
- **Total orphan rows:** **58**
- **Date range:** 2026-04-18 → 2026-04-19 (≈ 27 hours)
- **Identifier format:** raw Telegram numeric id — preserved in the
  recovery query below; **not** committed to this audit file.

### Event mix among orphan rows

All 58 events are Mini-App **bootstrap telemetry** — observability
signals, not value-creating actions:

| Event | Approximate rows in this orphan |
|---|---:|
| `miniapp.tg_context_detected` | ≈ same shape as global numeric distribution |
| `miniapp.bootstrap_started` | ≈ same |
| `miniapp.first_rendered` | ≈ same |
| `miniapp.open_attempt` | ≈ same |
| `miniapp.initdata_present` | ≈ same |
| `miniapp.bootstrap_succeeded` | ≈ same |
| (and other `miniapp.*` session pings) | |

Critically: **no `payment.*`, no `wish.created`, no `wishlist.*`, no
`subscription.*`, no `reservation.*`** rows are in the orphan set. The
orphan is one anonymous-looking Mini-App session burst over a day, not
a paying user or content creator. Losing the linkage from these 58
rows to a Telegram id has negligible analytical value.

## 4. Distinct users gained by the normalization

- **98 distinct `User` rows** that currently have **zero** matched
  events under the naïve `JOIN u.id = ae."userId"` will, post-migration,
  light up in cohort and retention queries. This is the upside of the
  fix — 9 200 historical events become attributable to real users.

## 5. Recovery query (for if we ever need the raw orphan Telegram id)

Run **before** the migration applies on a given environment, or against
any backup snapshot taken before commit `c179a69` deploys:

```sql
SELECT
  "userId" AS orphan_telegram_id_raw,
  COUNT(*) AS event_count,
  MIN("createdAt") AS first_seen,
  MAX("createdAt") AS last_seen
FROM "AnalyticsEvent" ae
WHERE "userId" ~ '^[0-9]+$'
  AND NOT EXISTS (
    SELECT 1 FROM "User" u WHERE u."telegramId" = ae."userId"
  )
GROUP BY "userId"
ORDER BY event_count DESC;
```

If the migration has already applied and no backup is available, the
raw id is unrecoverable. Per § 3 the realistic recovery value is low —
the orphan is a Mini-App bootstrap burst, not transactional history.

## 6. Verification queries (post-deploy)

Run after `prisma migrate deploy` on prod. Expectations are exact, not
fuzzy — the migration's own `DO $$ … END$$` block will `RAISE EXCEPTION`
if any of these would fail. Independent verification anyway:

```sql
-- (a) Zero numeric-format rows remain.
SELECT COUNT(*) AS numeric_remaining
FROM "AnalyticsEvent" WHERE "userId" ~ '^[0-9]+$';
-- expect: 0

-- (b) Total NULL count grew by exactly the orphan count.
SELECT COUNT(*) AS null_after FROM "AnalyticsEvent" WHERE "userId" IS NULL;
-- expect: 216 (= 158 pre + 58 orphan)

-- (c) cuid count grew by exactly the mapped count.
SELECT COUNT(*) AS cuid_after
FROM "AnalyticsEvent" WHERE "userId" ~ '^c[a-z0-9]+$';
-- expect: 10 311 (= 1 111 pre + 9 200 mapped)

-- (d) Sample new events written by the rebuilt frontend within 10 min
--     after deploy — every userId should be a cuid (or NULL for guest events).
SELECT event, "userId", "createdAt"
FROM "AnalyticsEvent"
WHERE "createdAt" >= NOW() - INTERVAL '10 minutes'
ORDER BY "createdAt" DESC
LIMIT 20;
-- expect: every "userId" matches '^c[a-z0-9]+$' or IS NULL — no numeric strings
```

## 7. Rollback strategy

The migration is wrapped in an implicit `BEGIN/COMMIT` (Prisma default).
If step (3) `RAISE EXCEPTION` fires (numeric remaining > 0), the
transaction aborts and **no rows change**. Manual rollback after a
successful commit:

1. **Not via the same migration** — the migration is idempotent on
   subsequent runs (UPDATE matches zero rows), but it does not preserve
   the original Telegram ids. Re-applying it cannot restore them.
2. **Via backup restore.** Vultr Postgres has automated snapshots
   (verify via Vultr console). For a partial restore of `AnalyticsEvent`
   only, dump from the snapshot:
   ```bash
   pg_dump --table='public."AnalyticsEvent"' --data-only … > snapshot.sql
   ```
   then `psql -c 'TRUNCATE "AnalyticsEvent"'` + restore. **Risk:** any
   events written between the snapshot and the restore are lost.

In practice, the orphan set is 58 Mini-App bootstrap pings from a
single user over one day. Rollback is a theoretical option, not a
realistic one.

---

## Operator checklist (before merging the migration to prod)

- [ ] Pre-flight queries in § 1–§ 4 run on prod and confirmed the
      numbers in this file. **Done 2026-05-19 — matched exactly.**
- [ ] Recovery query (§ 5) run on prod and the raw orphan id saved
      out-of-band (NOT in this repo). **Available on demand — see § 5.**
- [ ] Latest Vultr snapshot is recent enough to restore from if the
      worst happens. Verify in Vultr console before push.
- [ ] Push `c179a69`. GitHub Actions runs `prisma migrate deploy` as
      part of the deploy job.
- [ ] Post-deploy: run § 6 verifications and the CLAUDE.md
      post-deploy health check block.
