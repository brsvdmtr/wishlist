# Event pushes (P0.3 «Событийные пуши») — success-metric readout SQL

**Status:** living doc. Companion to the pipeline in
[`apps/api/src/services/event-notifications.ts`](../../apps/api/src/services/event-notifications.ts)
(+ its scheduler), the deep-link encode/decode pair
([`apps/api/src/telegram/deepLinks.ts`](../../apps/api/src/telegram/deepLinks.ts) ↔
[`apps/web/app/miniapp/startParam.ts`](../../apps/web/app/miniapp/startParam.ts)),
and the taxonomy entries in
[`packages/shared/src/analyticsEvents.ts`](../../packages/shared/src/analyticsEvents.ts)
(`push.sent`, `push.opened`).

The P0.3 spec lists six success metrics: **delivery rate**, **CTR by type**,
**opt-out rate**, **mute rate**, **sessions attributed to push**, and **D7
uplift** (received vs control). This doc is the SQL for each.

Two data sources, by design:

| source | what it answers | why |
|--------|-----------------|-----|
| **`EventNotification`** table | delivery / suppression / deferral, opt-out & mute state | the outbox is the authoritative record of what the flush did to every row |
| **`AnalyticsEvent`** (`push.sent`, `push.opened`) | type-tagged delivery feed + click-through, joined to sessions | the outbox can't be joined to client behaviour; the product-event stream can |

`push.sent` fires **only on a confirmed delivery** (one event per delivered
*message* — a grouped digest of N rows is ONE `push.sent`), so the count of
`push.sent` equals the count of delivered messages. `push.opened` fires when the
recipient taps the deep link and the Mini App bootstraps. Both are gated by the
`EVENT_NOTIFICATIONS_ENABLED` kill switch (off ⇒ the flush no-ops ⇒ neither
fires).

---

## Event shapes (what lands in `AnalyticsEvent.props`)

`AnalyticsEvent` columns: `event` (text), `userId` (internal `User.id` cuid or
NULL), `props` (jsonb), `createdAt` (timestamptz; for client events
**server-clamped** to `[now()-1h, now()]` at ingest — see `telemetry.routes.ts`).

| event | source | key props |
|-------|--------|-----------|
| `push.sent` | **server** (flush) | `pushType` (`event_7d`\|`event_3d`\|`new_wish`\|`reservation_changed`\|`circle_joined`\|`grouped`) · `grouped` bool (the message bundled >1 outbox row). `userId` = the **recipient**. |
| `push.opened` | **client** (bootstrap) | `pushType` (same set, or `'unknown'` for an older cached link that predated the `__p_` param) · `bootSessionId` · `clientEventId`. |

> **Why the type label matches on both sides.** The label is computed once in
> `renderEventMessage` and carried verbatim into the deep-link `__p_<type>`
> param, so the `pushType` on `push.sent` and the `pushType` decoded into
> `push.opened` are the same string. CTR-by-type is therefore a clean join.

`EventNotification` columns used below: `recipientUserId`, `type` (enum
`EVENT_UPCOMING_7D`\|`EVENT_UPCOMING_3D`\|`NEW_WISH`\|`RESERVATION_CHANGED`\|`CIRCLE_JOINED`),
`status` (`PENDING`\|`SENDING`\|`SENT`\|`SUPPRESSED`), `delivered` bool,
`groupKey`, `sentAt`, `createdAt`. A delivered **message** = distinct
`(groupKey, sentAt)` with `delivered = true` (every row in a bucket is stamped
with the same `sentAt`).

All examples scope to a window — adjust the interval.

---

## Metric 1 — Delivery rate

Authoritative from the outbox. `SUPPRESSED` rows are *intentional* non-sends
(opt-out / mute / no-chat / un-renderable) and are excluded from the rate; a
`SENT` row with `delivered = false` is a **burned** bucket (gave up after
`MAX_SEND_ATTEMPTS` transient failures) and is the only true delivery failure.

```sql
-- Row-level outcome breakdown (the raw truth).
SELECT
  status,
  delivered,
  count(*) AS rows
FROM "EventNotification"
WHERE "createdAt" >= now() - interval '14 days'
GROUP BY 1, 2 ORDER BY 1, 2;

-- Message-level delivery rate (distinct groupKey+sentAt buckets that reached a
-- terminal SENT state — delivered vs burned).
WITH messages AS (
  SELECT "groupKey", "sentAt", bool_or(delivered) AS delivered
  FROM "EventNotification"
  WHERE status = 'SENT' AND "sentAt" >= now() - interval '14 days'
  GROUP BY 1, 2
)
SELECT
  count(*) FILTER (WHERE delivered)      AS delivered_messages,
  count(*) FILTER (WHERE NOT delivered)  AS burned_messages,
  round(100.0 * count(*) FILTER (WHERE delivered) / nullif(count(*), 0), 2) AS delivery_rate_pct
FROM messages;
```

> Cross-check: `delivered_messages` here should equal the count of `push.sent`
> in the same window (both are "one per delivered message"). A divergence means
> a flush delivered but `trackPushSent` didn't fire (or vice-versa) — worth a look.

```sql
-- push.sent count (the AnalyticsEvent mirror of delivered_messages).
SELECT count(*) AS push_sent
FROM "AnalyticsEvent"
WHERE event = 'push.sent' AND "createdAt" >= now() - interval '14 days';
```

### Suppression mix (why pushes didn't go out)

The outbox doesn't store a suppression *reason* column, but the breakdown of
deferral vs suppression is still useful operationally:

```sql
SELECT
  count(*) FILTER (WHERE status = 'SUPPRESSED')                       AS suppressed,
  count(*) FILTER (WHERE status = 'PENDING'  AND "createdAt" < now() - interval '1 hour') AS still_pending_deferred,
  count(*) FILTER (WHERE status = 'SENT' AND delivered)              AS delivered_rows,
  count(*) FILTER (WHERE status = 'SENT' AND NOT delivered)          AS burned_rows
FROM "EventNotification"
WHERE "createdAt" >= now() - interval '14 days';
```

---

## Metric 2 — CTR by type

Numerator = `push.opened` of type T; denominator = `push.sent` of type T.

```sql
WITH sent AS (
  SELECT props->>'pushType' AS push_type, count(*) AS sent
  FROM "AnalyticsEvent"
  WHERE event = 'push.sent' AND "createdAt" >= now() - interval '14 days'
  GROUP BY 1
),
opened AS (
  SELECT props->>'pushType' AS push_type, count(*) AS opened
  FROM "AnalyticsEvent"
  WHERE event = 'push.opened' AND "createdAt" >= now() - interval '14 days'
  GROUP BY 1
)
SELECT
  coalesce(s.push_type, o.push_type)                       AS push_type,
  coalesce(s.sent, 0)                                      AS sent,
  coalesce(o.opened, 0)                                    AS opened,
  round(100.0 * coalesce(o.opened, 0) / nullif(s.sent, 0), 2) AS ctr_pct
FROM sent s FULL OUTER JOIN opened o USING (push_type)
ORDER BY sent DESC NULLS LAST;
```

> **Reading the table.**
> - **`ctr_pct` can exceed 100%** — `push.opened` counts taps, so a user who
>   re-opens the same push is counted twice. For a unique-open CTR, dedupe opens
>   by `count(DISTINCT props->>'bootSessionId')` (one open per app-open).
> - **`push_type = 'unknown'`** appears only on the `opened` side: a cached
>   deep link from before this instrumentation carried no `__p_` param. It has
>   no `sent` denominator (those messages predate `push.sent`), so its row shows
>   `sent = 0`. It shrinks to zero as old messages age out.
> - **`grouped`** is its own bucket: a mixed-type digest. Its CTR measures how
>   well the bundled "updates in <circle>" message pulls a tap vs the focused
>   single-type pushes.

### Unique-open CTR (dedup re-taps)

```sql
WITH sent AS (
  SELECT props->>'pushType' AS push_type, count(*) AS sent
  FROM "AnalyticsEvent"
  WHERE event = 'push.sent' AND "createdAt" >= now() - interval '14 days'
  GROUP BY 1
),
opened AS (
  SELECT props->>'pushType' AS push_type,
         count(DISTINCT props->>'bootSessionId') AS unique_opens
  FROM "AnalyticsEvent"
  WHERE event = 'push.opened' AND "createdAt" >= now() - interval '14 days'
  GROUP BY 1
)
SELECT push_type, sent, unique_opens,
       round(100.0 * unique_opens / nullif(sent, 0), 2) AS unique_ctr_pct
FROM sent FULL OUTER JOIN opened USING (push_type)
ORDER BY sent DESC NULLS LAST;
```

---

## Metric 3 — Opt-out rate (per type)

State lives on `UserProfile` (4 booleans, default `true`). Opt-out rate =
share of profiled users who flipped a toggle off. (Users with no `UserProfile`
row inherit all-on defaults and are counted as opted-in.)

```sql
SELECT
  count(*)                                                              AS profiled_users,
  round(100.0 * count(*) FILTER (WHERE NOT "notifyCircleEvents")
                / nullif(count(*), 0), 2)                               AS optout_events_pct,
  round(100.0 * count(*) FILTER (WHERE NOT "notifyCircleNewWishes")
                / nullif(count(*), 0), 2)                               AS optout_new_wishes_pct,
  round(100.0 * count(*) FILTER (WHERE NOT "notifyCircleReservationChanges")
                / nullif(count(*), 0), 2)                               AS optout_reservations_pct,
  round(100.0 * count(*) FILTER (WHERE NOT "notifyCircleJoins")
                / nullif(count(*), 0), 2)                               AS optout_joins_pct
FROM "UserProfile";
```

> **Denominator choice.** Dividing by *all* `UserProfile` rows understates
> nothing but mixes in users who never had a circle. For an engaged-cohort rate,
> restrict to profiles whose `userId` appears in an `ACTIVE` `CircleMembership`:
> `WHERE "userId" IN (SELECT "userId" FROM "CircleMembership" WHERE status = 'ACTIVE')`.

---

## Metric 4 — Mute rate (per circle membership)

Circle mute is `CircleMembership.mutedAt` (non-null ⇒ muted). Mute rate = muted
active memberships / all active memberships.

```sql
SELECT
  count(*) FILTER (WHERE status = 'ACTIVE')                              AS active_memberships,
  count(*) FILTER (WHERE status = 'ACTIVE' AND "mutedAt" IS NOT NULL)    AS muted_memberships,
  round(100.0 * count(*) FILTER (WHERE status = 'ACTIVE' AND "mutedAt" IS NOT NULL)
                / nullif(count(*) FILTER (WHERE status = 'ACTIVE'), 0), 2) AS mute_rate_pct
FROM "CircleMembership";
```

---

## Metric 5 — Sessions attributed to push

A push-attributed session = a `bootSessionId` that contains a `push.opened`.
`push.opened` carries the same `bootSessionId` as the `user.session_started`
fired on the same app-open (both seeded in `MiniApp.tsx`), so the attribution is
a session-key match.

```sql
WITH push_sessions AS (
  SELECT DISTINCT props->>'bootSessionId' AS sid
  FROM "AnalyticsEvent"
  WHERE event = 'push.opened' AND props->>'bootSessionId' IS NOT NULL
    AND "createdAt" >= now() - interval '14 days'
),
all_sessions AS (
  SELECT DISTINCT props->>'bootSessionId' AS sid
  FROM "AnalyticsEvent"
  WHERE event = 'user.session_started' AND props->>'bootSessionId' IS NOT NULL
    AND "createdAt" >= now() - interval '14 days'
)
SELECT
  (SELECT count(*) FROM push_sessions)                                       AS push_attributed_sessions,
  (SELECT count(*) FROM all_sessions)                                        AS total_sessions,
  round(100.0 * (SELECT count(*) FROM push_sessions)
            / nullif((SELECT count(*) FROM all_sessions), 0), 2)             AS push_attributed_pct;
```

> A push-opened session usually *is* a `user.session_started` session (the deep
> link cold-starts the app). The `INTERSECT` form below is stricter if you want
> only sessions confirmed in both streams:
> `SELECT count(*) FROM (SELECT sid FROM push_sessions INTERSECT SELECT sid FROM all_sessions) x;`

---

## Metric 6 — D7 uplift (received vs control)

**Read this first.** The kill switch (`EVENT_NOTIFICATIONS_ENABLED`) is
**global** — there is no per-user randomized holdout today, so a *causal* D7
uplift is not directly measurable. Push *receivers* are, by construction, more
socially active (they have active circles with events firing), so a naïve
"receivers vs non-receivers" gap is **confounded by selection**, not a clean
treatment effect. Two honest readouts:

**(a) D7 return rate of push receivers** (descriptive baseline — "do people who
got a push come back a week later?"). Retention truth is
`UserDailyActivity.sessionStarted` (the rollup of `user.session_started`).

```sql
WITH receivers AS (
  -- first push each user received in the cohorting window
  SELECT "userId", min("createdAt")::date AS day0
  FROM "AnalyticsEvent"
  WHERE event = 'push.sent'
    AND "createdAt" >= now() - interval '35 days'
    AND "createdAt" <  now() - interval '7 days'   -- need a full D7 to have elapsed
    AND "userId" IS NOT NULL
  GROUP BY 1
)
SELECT
  count(*)                                                             AS receivers,
  count(*) FILTER (WHERE a."userId" IS NOT NULL)                       AS returned_d7,
  round(100.0 * count(*) FILTER (WHERE a."userId" IS NOT NULL)
                / nullif(count(*), 0), 2)                              AS d7_return_pct
FROM receivers r
LEFT JOIN "UserDailyActivity" a
  ON a."userId" = r."userId"
 AND a.date = r.day0 + 7
 AND a."sessionStarted" > 0;
```

**(b) Matched-cohort comparison** (control = active circle members who did NOT
receive a push in the window). Confounded — present the gap WITH the caveat, and
prefer matching on a pre-period activity covariate if the gap is being used to
justify investment.

```sql
WITH cohort_day AS (SELECT (now() - interval '14 days')::date AS d0),
active_members AS (
  SELECT DISTINCT m."userId"
  FROM "CircleMembership" m
  WHERE m.status = 'ACTIVE'
),
received AS (
  SELECT DISTINCT "userId"
  FROM "AnalyticsEvent", cohort_day
  WHERE event = 'push.sent'
    AND "createdAt" >= cohort_day.d0
    AND "createdAt" <  cohort_day.d0 + interval '1 day'
    AND "userId" IS NOT NULL
),
labelled AS (
  SELECT am."userId",
         (am."userId" IN (SELECT "userId" FROM received)) AS treated
  FROM active_members am
)
SELECT
  treated,
  count(*)                                                             AS users,
  count(*) FILTER (WHERE a."userId" IS NOT NULL)                       AS returned_d7,
  round(100.0 * count(*) FILTER (WHERE a."userId" IS NOT NULL)
                / nullif(count(*), 0), 2)                              AS d7_return_pct
FROM labelled l, cohort_day
LEFT JOIN "UserDailyActivity" a
  ON a."userId" = l."userId"
 AND a.date = cohort_day.d0 + 7
 AND a."sessionStarted" > 0
GROUP BY treated
ORDER BY treated;
```

> **To get a clean uplift number**, introduce a per-user holdout: a sticky
> `experiment.assigned` bucket (the infra already exists) that suppresses
> enqueue for a random N% while still logging a counterfactual `push.sent`-shaped
> row. Until then, treat (b) as directional and lean on (a) + the CTR/engagement
> metrics, which are not confounded by selection.

---

## Caveats / gotchas (read before trusting a number)

- **`push.sent` = delivered messages, not delivered rows.** A grouped digest of
  N outbox rows is ONE `push.sent`. Don't compare it to `EventNotification` row
  counts — compare it to distinct `(groupKey, sentAt)` delivered buckets.
- **CTR can exceed 100%** (re-taps). Use the unique-open variant for a bounded
  rate.
- **`pushType = 'unknown'`** is the pre-instrumentation cached-link bucket on the
  opened side only; it has no `sent` denominator and decays over time.
- **Kill switch.** With `EVENT_NOTIFICATIONS_ENABLED=false` the flush no-ops, so
  `push.sent` / `push.opened` stop entirely — a sudden zero is the switch, not a
  delivery outage.
- **`userId` may be NULL** for the rare client event that fires before the user
  row resolves; session metrics keyed on `bootSessionId` are unaffected, but the
  D7 cohort (keyed on `userId`) drops those rows.
- **Privacy.** No item titles, person names, or raw circle/item ids are in push
  props — only the `pushType` enum, the `grouped` bool, and session UUIDs. The
  ingest sanitizer (`sanitizeAnalyticsProps`) is the backstop, and `push.sent`
  is `sources:['server']` so a client can never spoof a delivery into the CTR
  denominator.
