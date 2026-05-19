# Core-Loop Dashboard

Durable retention and core-loop metrics, queryable past the 90-day
`AnalyticsEvent` TTL.

**Source-of-truth table**: `UserDailyActivity`. One row per (userId,
UTC calendar day). Filled by
[`apps/api/src/schedulers/daily-activity-rollup.ts`](../../apps/api/src/schedulers/daily-activity-rollup.ts)
on an hourly tick and backfilled by
[`apps/api/src/scripts/backfill-daily-activity.ts`](../../apps/api/src/scripts/backfill-daily-activity.ts).

Column ↔ source-event mapping lives in
[`apps/api/src/services/daily-activity.service.ts`](../../apps/api/src/services/daily-activity.service.ts)
under `EVENT_TO_FIELD`. The aggregator is idempotent — every hourly
tick re-computes yesterday + today and upserts on `(userId, date)`,
so re-running, retro-deploying, or replaying a backfill never
duplicates rows.

---

## 1. Timezone choice — read this before reading any SQL

**All dates in `UserDailyActivity` are UTC calendar days.** This is a
single, explicit choice; the alternative (TZ-aware buckets) costs more
than it pays back at our scale.

| Time of action               | UTC date           | Europe/Berlin date          |
|------------------------------|--------------------|-----------------------------|
| 2026-05-19 23:30 Berlin (UTC+2, summer) | 2026-05-19 21:30Z → `2026-05-19` | `2026-05-19` |
| 2026-05-20 00:30 Berlin (UTC+2, summer) | 2026-05-19 22:30Z → `2026-05-19` | `2026-05-20` |
| 2026-05-20 02:30 Berlin (UTC+2, summer) | 2026-05-20 00:30Z → `2026-05-20` | `2026-05-20` |
| 2026-01-19 23:30 Berlin (UTC+1, winter) | 2026-01-19 22:30Z → `2026-01-19` | `2026-01-19` |
| 2026-01-20 00:30 Berlin (UTC+1, winter) | 2026-01-19 23:30Z → `2026-01-19` | `2026-01-20` |

Trade-off:
- **UTC (what we picked):** stable boundaries regardless of DST, one
  source of truth for all dashboards. A Berlin user active near
  midnight may show up "the day before" relative to their local
  calendar — but the cohort math (D0/D7/D30) is unaffected because
  every user's "day 0" is the UTC day of their `User.createdAt`,
  and `day N` is `day 0 + N` UTC days. Consistent reference frame.
- **Europe/Berlin:** matches local product reporting but breaks
  twice a year on DST (a "day" is 23h or 25h) and forces every
  query to remember the conversion. Not worth it for product
  metrics.

If a TZ-localised view is ever needed (e.g. for a country-specific
go-to-market dashboard), build it as a thin SQL view on top:

```sql
-- Example: re-bucket UTC days into Europe/Berlin local days.
-- DO NOT use this for cohort math — it breaks DST boundaries.
SELECT
  ("date"::timestamp AT TIME ZONE 'UTC' AT TIME ZONE 'Europe/Berlin')::date AS berlin_date,
  SUM("sessionStarted") AS sessions
FROM "UserDailyActivity"
GROUP BY 1
ORDER BY 1;
```

---

## 2. Cohort definition (used by every query below)

A **cohort of day D** = all `User` rows where
`date_trunc('day', "createdAt" AT TIME ZONE 'UTC') = D`. Every D-N
metric is computed against the same cohort with the day offset.

`UserDailyActivity` covers the entire authenticated user base — guest
viewers without a User row don't appear (no `userId`). For events
that happen pre-account (`guest.view_opened`), only the
`convertedGuestToOwner` row tells us they came in through the guest
funnel; the pre-conversion `guestOpened` count belongs to the *new*
user after conversion.

---

## 3. D0 activation

> "Of users who signed up on day D, what % did something meaningful on
> their first UTC day?"

"Meaningful" = created a wishlist or created a real wish on day 0.
This is the strictest core-loop interpretation; we deliberately do
**not** count `sessionStarted` alone — opening the app without
content creation isn't activation.

```sql
WITH cohort AS (
  SELECT
    "id" AS user_id,
    date_trunc('day', "createdAt" AT TIME ZONE 'UTC')::date AS d0
  FROM "User"
  WHERE "createdAt" >= NOW() - INTERVAL '60 days'
    AND "createdAt" <  NOW() - INTERVAL '1 day'  -- exclude today (incomplete)
),
day0 AS (
  SELECT
    c.user_id,
    c.d0,
    COALESCE(a."createdWishlist", 0) AS wishlists,
    COALESCE(a."createdRealWish",  0) AS wishes
  FROM cohort c
  LEFT JOIN "UserDailyActivity" a
    ON a."userId" = c.user_id
   AND a."date"   = c.d0
)
SELECT
  d0,
  COUNT(*)                                                       AS signups,
  COUNT(*) FILTER (WHERE wishlists > 0 OR wishes > 0)            AS activated,
  ROUND(100.0
    * COUNT(*) FILTER (WHERE wishlists > 0 OR wishes > 0)
    / NULLIF(COUNT(*), 0), 2)                                    AS activation_pct
FROM day0
GROUP BY d0
ORDER BY d0;
```

Weekly roll-up (replace `d0` with `date_trunc('week', d0)::date`
in both `SELECT` and `GROUP BY`).

---

## 4. D7 share rate

> "Of users who signed up in week W, what % shared a wishlist within
> their first 7 UTC days?"

`sharedWishlist` is incremented by the server-side
`share.token_generated` event (one increment per token generated;
re-shares of the same wishlist re-use the existing token and don't
re-fire the event, so this counts distinct shares per day).

**Semantic caveat.** This counter measures **"created the share
affordance"** — i.e. the user minted a share token — not "actually
delivered the link to a friend who opened it". A user who clicks
"Share" and then closes the modal still bumps this counter.
For end-to-end share success (the link reached someone), cross-join
with `guestOpened` (someone opened a public link) and `reservedItem`
(someone reserved) in the same or adjacent days. Treat `sharedWishlist`
as an **upper bound on intent**, not as proof of social distribution.

```sql
WITH cohort AS (
  SELECT
    "id"                                                              AS user_id,
    date_trunc('day',  "createdAt" AT TIME ZONE 'UTC')::date          AS d0,
    date_trunc('week', "createdAt" AT TIME ZONE 'UTC')::date          AS cohort_week
  FROM "User"
  WHERE "createdAt" >= NOW() - INTERVAL '90 days'
    AND "createdAt" <  NOW() - INTERVAL '8 days'  -- need full D0..D7 window
),
shared_in_d7 AS (
  SELECT
    c.user_id,
    c.cohort_week,
    SUM(a."sharedWishlist") AS shares
  FROM cohort c
  LEFT JOIN "UserDailyActivity" a
    ON a."userId" = c.user_id
   AND a."date"  >= c.d0
   AND a."date"  <  c.d0 + INTERVAL '7 days'
  GROUP BY c.user_id, c.cohort_week
)
SELECT
  cohort_week,
  COUNT(*)                                                AS signups,
  COUNT(*) FILTER (WHERE shares > 0)                      AS shared_d7,
  ROUND(100.0 * COUNT(*) FILTER (WHERE shares > 0)
        / NULLIF(COUNT(*), 0), 2)                         AS share_rate_pct
FROM shared_in_d7
GROUP BY cohort_week
ORDER BY cohort_week;
```

---

## 5. Guest → owner D7

> "Of users who signed up in week W, what % came in through the guest
> funnel (had at least one `guest.converted_to_user` event in their
> first 7 days)?"

`convertedGuestToOwner` is server-emitted at the moment a guest
session is associated with a brand-new `User` row. The event's
`userId` is the new owner's id, so the row lands on the post-conversion
user's day-0 (or day-1, if the conversion bridge crosses midnight UTC).

```sql
WITH cohort AS (
  SELECT
    "id"                                                              AS user_id,
    date_trunc('day',  "createdAt" AT TIME ZONE 'UTC')::date          AS d0,
    date_trunc('week', "createdAt" AT TIME ZONE 'UTC')::date          AS cohort_week
  FROM "User"
  WHERE "createdAt" >= NOW() - INTERVAL '90 days'
    AND "createdAt" <  NOW() - INTERVAL '8 days'
),
conv AS (
  SELECT
    c.user_id,
    c.cohort_week,
    SUM(a."convertedGuestToOwner") AS conversions
  FROM cohort c
  LEFT JOIN "UserDailyActivity" a
    ON a."userId" = c.user_id
   AND a."date"  >= c.d0
   AND a."date"  <  c.d0 + INTERVAL '7 days'
  GROUP BY c.user_id, c.cohort_week
)
SELECT
  cohort_week,
  COUNT(*)                                                AS signups,
  COUNT(*) FILTER (WHERE conversions > 0)                 AS guest_origin,
  ROUND(100.0 * COUNT(*) FILTER (WHERE conversions > 0)
        / NULLIF(COUNT(*), 0), 2)                         AS guest_to_owner_pct
FROM conv
GROUP BY cohort_week
ORDER BY cohort_week;
```

---

## 6. Reservation rate (D7)

> "Of users who signed up in week W, what % reserved an item within
> their first 7 days?"

Note: `reservedItem` tracks the *reserver*, not the wishlist owner.
This metric measures gift-giver activation. If you want "what % of
*new wishlists* received a reservation," that's a different query
that joins `Item` and `ReservationEvent` directly — out of scope
for this rollup table.

```sql
WITH cohort AS (
  SELECT
    "id"                                                              AS user_id,
    date_trunc('day',  "createdAt" AT TIME ZONE 'UTC')::date          AS d0,
    date_trunc('week', "createdAt" AT TIME ZONE 'UTC')::date          AS cohort_week
  FROM "User"
  WHERE "createdAt" >= NOW() - INTERVAL '90 days'
    AND "createdAt" <  NOW() - INTERVAL '8 days'
),
res AS (
  SELECT
    c.user_id,
    c.cohort_week,
    SUM(a."reservedItem") AS reservations
  FROM cohort c
  LEFT JOIN "UserDailyActivity" a
    ON a."userId" = c.user_id
   AND a."date"  >= c.d0
   AND a."date"  <  c.d0 + INTERVAL '7 days'
  GROUP BY c.user_id, c.cohort_week
)
SELECT
  cohort_week,
  COUNT(*)                                                AS signups,
  COUNT(*) FILTER (WHERE reservations > 0)                AS reserved_d7,
  ROUND(100.0 * COUNT(*) FILTER (WHERE reservations > 0)
        / NULLIF(COUNT(*), 0), 2)                         AS reservation_rate_pct
FROM res
GROUP BY cohort_week
ORDER BY cohort_week;
```

---

## 7. Paywall conversion

> "Of users who saw the paywall in week W, what % completed a payment
> within 7 days of their first view?"

This is a different cohort than D0/D7 retention — the cohort is
"users with `paywallViewed > 0` in week W", not signups. Run weekly.

**Semantic caveat — `checkoutStarted`.** The counter sums two
disjoint source events: legacy `checkout_started` (server-side, fired
when a Telegram billing invoice is actually generated) and new
`paywall.cta_clicked` (client-side, fired when the user taps the
upgrade CTA on the paywall sheet). The second is **monetization
intent**, not a guarantee of invoice creation — the modal can be
dismissed, the network call can fail, the user can rage-quit. So
`view_to_checkout_pct` below is more accurately "viewed and showed
intent to pay" than "viewed and actually reached the Telegram
checkout sheet". `paymentCompleted` is the only ground-truth revenue
signal in this table; if your dashboard needs a clean intent→payment
funnel, prefer `view_to_payment_pct` and treat the intermediate step
as directional.

```sql
WITH paywall_first_view AS (
  -- One row per user: the date of their first paywall view.
  SELECT
    "userId" AS user_id,
    MIN("date") AS first_view
  FROM "UserDailyActivity"
  WHERE "paywallViewed" > 0
    AND "date" >= (CURRENT_DATE - INTERVAL '90 days')
    AND "date" <  (CURRENT_DATE - INTERVAL '7 days')  -- D7 window must close
  GROUP BY "userId"
),
funnel AS (
  SELECT
    p.user_id,
    date_trunc('week', p.first_view)::date AS cohort_week,
    SUM(a."checkoutStarted")  AS started,
    SUM(a."paymentCompleted") AS completed
  FROM paywall_first_view p
  LEFT JOIN "UserDailyActivity" a
    ON a."userId" = p.user_id
   AND a."date"  >= p.first_view
   AND a."date"  <  p.first_view + INTERVAL '7 days'
  GROUP BY p.user_id, cohort_week
)
SELECT
  cohort_week,
  COUNT(*)                                                AS paywall_views_unique,
  COUNT(*) FILTER (WHERE started > 0)                     AS checkout_started_d7,
  COUNT(*) FILTER (WHERE completed > 0)                   AS payment_completed_d7,
  ROUND(100.0 * COUNT(*) FILTER (WHERE started > 0)
        / NULLIF(COUNT(*), 0), 2)                         AS view_to_checkout_pct,
  ROUND(100.0 * COUNT(*) FILTER (WHERE completed > 0)
        / NULLIF(COUNT(*), 0), 2)                         AS view_to_payment_pct,
  ROUND(100.0 * COUNT(*) FILTER (WHERE completed > 0)
        / NULLIF(COUNT(*) FILTER (WHERE started > 0), 0), 2)
                                                          AS checkout_to_payment_pct
FROM funnel
GROUP BY cohort_week
ORDER BY cohort_week;
```

---

## 8. Bonus: long-window cohort retention (the reason this table exists)

Without `UserDailyActivity`, `AnalyticsEvent`'s 90-day TTL caps every
cohort query at D90 max. With it, D30/D60/D90/D180 are trivial:

```sql
-- Of users who signed up on day D, what % had ANY activity on D + N?
WITH cohort AS (
  SELECT
    "id" AS user_id,
    date_trunc('day', "createdAt" AT TIME ZONE 'UTC')::date AS d0
  FROM "User"
  WHERE "createdAt" >= NOW() - INTERVAL '200 days'
    AND "createdAt" <  NOW() - INTERVAL '90 days'  -- need full D0..D90
),
returned AS (
  SELECT
    c.d0,
    c.user_id,
    EXISTS (
      SELECT 1 FROM "UserDailyActivity" a
      WHERE a."userId" = c.user_id
        AND a."date" >= c.d0 + INTERVAL '7 days'
        AND a."date" <  c.d0 + INTERVAL '8 days'
        AND a."sessionStarted" > 0
    ) AS d7,
    EXISTS (
      SELECT 1 FROM "UserDailyActivity" a
      WHERE a."userId" = c.user_id
        AND a."date" >= c.d0 + INTERVAL '30 days'
        AND a."date" <  c.d0 + INTERVAL '31 days'
        AND a."sessionStarted" > 0
    ) AS d30,
    EXISTS (
      SELECT 1 FROM "UserDailyActivity" a
      WHERE a."userId" = c.user_id
        AND a."date" >= c.d0 + INTERVAL '90 days'
        AND a."date" <  c.d0 + INTERVAL '91 days'
        AND a."sessionStarted" > 0
    ) AS d90
  FROM cohort c
)
SELECT
  d0,
  COUNT(*)                                          AS signups,
  ROUND(100.0 * COUNT(*) FILTER (WHERE d7)
        / NULLIF(COUNT(*), 0), 2)                   AS d7_pct,
  ROUND(100.0 * COUNT(*) FILTER (WHERE d30)
        / NULLIF(COUNT(*), 0), 2)                   AS d30_pct,
  ROUND(100.0 * COUNT(*) FILTER (WHERE d90)
        / NULLIF(COUNT(*), 0), 2)                   AS d90_pct
FROM returned
GROUP BY d0
ORDER BY d0;
```

---

## 9. Known gaps / not in this table

The fields below were considered but deliberately left out — they
don't fit the per-user-day-counter shape or live in other tables:

- **Revenue per new user** — `paymentCompleted` is a count, not a
  $ amount. For revenue cohorts, join `PaymentEvent` (durable) on
  `User.id` and bucket by `User.createdAt`.
- **Sessions per day length** — only the binary "had a session"
  count. Session duration belongs to client-side analytics, not
  this rollup.
- **Owner-side reservation rate** — `reservedItem` tracks the
  reserver, not the wishlist owner. For owner-perspective metrics
  join `Item` + `ReservationEvent` directly.
- **`feature_gate_hit_*`** (paywall misses) — distinct concept
  from `paywallViewed`; add separately if/when needed.

---

## 10. Operational notes

- **Backfill**: see
  [`scripts/backfill-daily-activity.ts`](../../apps/api/src/scripts/backfill-daily-activity.ts).
  Defaults to last 90 days; use `--from / --to` for a range or
  `--days N` for a rolling window. Pass `--dry-run` to count
  without writing.
- **Idempotency**: every cell is recomputed from `AnalyticsEvent`,
  not incremented in-place. Running the rollup twice for the same
  day produces the same row. Running the backfill over a range
  that overlaps a scheduler-written range is safe.
- **TTL alignment**: `AnalyticsEvent` is purged at 90 days. The
  rollup must run inside that window for any given day; the
  hourly scheduler covers this trivially, and the backfill caps
  at 90 days by default for the same reason.
- **Cost**: at 2026-05 baseline the table grows at roughly
  `daily_active_users` rows/day (≪ 5k/day today). One `INT * 13`
  per row + a few bookkeeping columns; 1y of data is well under
  100 MB.
