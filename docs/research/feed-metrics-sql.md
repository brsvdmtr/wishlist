# Home feed (P0.2) — leading-metric readout SQL

**Status:** living doc. Companion to the client instrumentation in
[`apps/web/app/miniapp/screens/feed/FeedRoot.tsx`](../../apps/web/app/miniapp/screens/feed/FeedRoot.tsx)
and the taxonomy entries in
[`packages/shared/src/analyticsEvents.ts`](../../packages/shared/src/analyticsEvents.ts)
(`feed.viewed`, `feed.card_clicked`, `feed.filter_changed`,
`feed.empty_cta_clicked`).

The P0.2 spec defines four **leading** success metrics. Three of them are
derivable from `feed.viewed` + `feed.card_clicked` alone; the fourth
(sessions/user/week) reuses the existing `user.session_started` signal. This
doc is the SQL that turns the raw `AnalyticsEvent` rows into those metrics.

The feed is the **default home for all users** (no flag), so these events
arrive at app-open volume from day one.

---

## Event shapes (what lands in `AnalyticsEvent.props`)

`AnalyticsEvent` columns: `event` (text), `userId` (internal `User.id` cuid or
NULL), `props` (jsonb), `createdAt` (timestamptz, **server-clamped** to
`[now()-1h, now()]` at ingest — see `telemetry.routes.ts`).

Every client event also carries `props->>'bootSessionId'` (one UUID per
app-open, seeded in `MiniApp.tsx`) and `props->>'clientEventId'` (per-event
UUID for dedup). `bootSessionId` is the **session key** used to join an
impression to its action below.

| event | key props |
|-------|-----------|
| `feed.viewed` | `hasCircles` bool · `itemCount` · `eventCount` · `activityCount` · `reservationCount` (per-kind ranked-card counts) · `circleCount` · `filtered` bool. Fires once per successful `/tg/feed` load (a filter change reloads → a new `feed.viewed`). |
| `feed.card_clicked` | `kind` (`event`\|`activity`\|`reservation`) · `position` (0-based) · for events also `daysUntil` + `urgency` (`today`\|`soon`\|`upcoming`). |
| `feed.filter_changed` | `scope` = `'all'` or a **djb2 hash** of the circleId (raw id is never logged). |
| `feed.empty_cta_clicked` | (no props) — the no-circles «Создать круг» bridge CTA. |

> **Why impression counts live on `feed.viewed`:** there is no per-card
> impression event (that would be 1 event per card per load — far too noisy).
> Instead each load reports how many cards of each kind it rendered, so the
> CTR denominator is `SUM(eventCount)` etc. across `feed.viewed`. This is
> **impression-weighted**: a card shown across two loads counts twice.

All examples below scope to a window — adjust the interval.

```sql
-- reusable: feed events in the last 14 days
-- (inline the WHERE in each query; CTEs shown per-metric for clarity)
```

---

## Metric 1 — CTR of feed cards, by type

Numerator = taps of kind K (`feed.card_clicked`). Denominator = kind-K card
impressions (`SUM(<kind>Count)` over `feed.viewed`).

```sql
WITH impressions AS (
  SELECT
    SUM((props->>'eventCount')::int)       AS event_impr,
    SUM((props->>'activityCount')::int)    AS activity_impr,
    SUM((props->>'reservationCount')::int) AS reservation_impr
  FROM "AnalyticsEvent"
  WHERE event = 'feed.viewed'
    AND "createdAt" >= now() - interval '14 days'
),
clicks AS (
  SELECT
    count(*) FILTER (WHERE props->>'kind' = 'event')       AS event_clicks,
    count(*) FILTER (WHERE props->>'kind' = 'activity')    AS activity_clicks,
    count(*) FILTER (WHERE props->>'kind' = 'reservation') AS reservation_clicks
  FROM "AnalyticsEvent"
  WHERE event = 'feed.card_clicked'
    AND "createdAt" >= now() - interval '14 days'
)
SELECT
  round(100.0 * event_clicks       / nullif(event_impr, 0), 2)       AS event_ctr_pct,
  round(100.0 * activity_clicks    / nullif(activity_impr, 0), 2)    AS activity_ctr_pct,
  round(100.0 * reservation_clicks / nullif(reservation_impr, 0), 2) AS reservation_ctr_pct
FROM impressions, clicks;
```

### CTR of event cards by urgency (does proximity drive taps?)

Denominator note: `feed.viewed` does not break `eventCount` down by urgency,
so a precise urgency-CTR needs a per-card impression source we don't emit.
Use this for the **click-side mix** (what share of event taps are on
today/soon/upcoming cards), which is still actionable for ranking decisions:

```sql
SELECT props->>'urgency' AS urgency, count(*) AS clicks
FROM "AnalyticsEvent"
WHERE event = 'feed.card_clicked' AND props->>'kind' = 'event'
  AND "createdAt" >= now() - interval '14 days'
GROUP BY 1 ORDER BY clicks DESC;
```

---

## Metric 2 — % of "actionable" sessions

A session (`bootSessionId`) is **actionable** if it contains at least one
feed action after seeing the feed. Denominator = sessions that saw the feed.

```sql
WITH viewed AS (
  SELECT DISTINCT props->>'bootSessionId' AS sid
  FROM "AnalyticsEvent"
  WHERE event = 'feed.viewed'
    AND props->>'bootSessionId' IS NOT NULL
    AND "createdAt" >= now() - interval '14 days'
),
acted AS (
  SELECT DISTINCT props->>'bootSessionId' AS sid
  FROM "AnalyticsEvent"
  WHERE event IN ('feed.card_clicked', 'feed.empty_cta_clicked')
    AND props->>'bootSessionId' IS NOT NULL
    AND "createdAt" >= now() - interval '14 days'
)
SELECT
  (SELECT count(*) FROM viewed)                                   AS feed_sessions,
  (SELECT count(*) FROM acted a WHERE a.sid IN (SELECT sid FROM viewed)) AS actionable_sessions,
  round(100.0 * (SELECT count(*) FROM acted a WHERE a.sid IN (SELECT sid FROM viewed))
            / nullif((SELECT count(*) FROM viewed), 0), 2)        AS actionable_pct;
```

> `feed.empty_cta_clicked` is included because, for a user with no circles,
> tapping «Создать круг» *is* the feed's primary action. Drop it from `acted`
> if you want card-only actionability.

---

## Metric 3 — time-to-first-action (per session)

Per session: `min(first card click) − min(first feed view)`. Sessions with no
action are excluded (they have no first-action time). Reported as p50/p90.

```sql
WITH first_view AS (
  SELECT props->>'bootSessionId' AS sid, min("createdAt") AS t_view
  FROM "AnalyticsEvent"
  WHERE event = 'feed.viewed' AND props->>'bootSessionId' IS NOT NULL
    AND "createdAt" >= now() - interval '14 days'
  GROUP BY 1
),
first_action AS (
  SELECT props->>'bootSessionId' AS sid, min("createdAt") AS t_action
  FROM "AnalyticsEvent"
  WHERE event = 'feed.card_clicked' AND props->>'bootSessionId' IS NOT NULL
    AND "createdAt" >= now() - interval '14 days'
  GROUP BY 1
)
SELECT
  count(*) AS sessions_with_action,
  round(percentile_cont(0.5)  WITHIN GROUP (ORDER BY extract(epoch FROM (t_action - t_view)))::numeric, 1) AS p50_seconds,
  round(percentile_cont(0.9)  WITHIN GROUP (ORDER BY extract(epoch FROM (t_action - t_view)))::numeric, 1) AS p90_seconds
FROM first_view v JOIN first_action a USING (sid)
WHERE a.t_action >= v.t_view;  -- guard the rare clock/clamp inversion
```

> **Clamp caveat:** ingest clamps `createdAt` to a 1-hour window, so deltas are
> only trustworthy for sub-hour first-actions (the overwhelming majority — a
> first tap minutes after open). The `t_action >= t_view` guard drops the rare
> inverted pair a clamp can produce.

---

## Metric 4 — sessions / user / week

App-level truth is `user.session_started` (existing event). Because the feed is
the default home, **feed sessions ≈ app sessions**; both are shown.

```sql
-- App sessions per active user per ISO week
SELECT date_trunc('week', "createdAt") AS wk,
       round(count(DISTINCT props->>'bootSessionId')::numeric
             / nullif(count(DISTINCT "userId"), 0), 2) AS sessions_per_user
FROM "AnalyticsEvent"
WHERE event = 'user.session_started'
  AND "createdAt" >= now() - interval '8 weeks'
GROUP BY 1 ORDER BY 1;

-- Feed-specific variant: swap event = 'feed.viewed' above.
```

---

## Supporting cuts

### Tap position distribution (does ranking land taps near the top?)

```sql
SELECT (props->>'position')::int AS position, props->>'kind' AS kind, count(*) AS clicks
FROM "AnalyticsEvent"
WHERE event = 'feed.card_clicked' AND "createdAt" >= now() - interval '14 days'
GROUP BY 1, 2 ORDER BY 1, 2;
```

### Filter engagement (how often, and how concentrated)

```sql
-- Share of feed sessions that change the circle filter, and the all-vs-circle split.
WITH feed_sessions AS (
  SELECT DISTINCT props->>'bootSessionId' AS sid
  FROM "AnalyticsEvent" WHERE event = 'feed.viewed'
    AND "createdAt" >= now() - interval '14 days'
)
SELECT
  count(DISTINCT props->>'bootSessionId')                                              AS sessions_that_filtered,
  count(*) FILTER (WHERE props->>'scope' = 'all')                                      AS to_all,
  count(*) FILTER (WHERE props->>'scope' <> 'all')                                     AS to_specific_circle,
  count(DISTINCT props->>'scope') FILTER (WHERE props->>'scope' <> 'all')              AS distinct_circles_hashed
FROM "AnalyticsEvent"
WHERE event = 'feed.filter_changed' AND "createdAt" >= now() - interval '14 days'
  AND props->>'bootSessionId' IN (SELECT sid FROM feed_sessions);
```

> `props->>'scope'` is `'all'` or a **djb2 fingerprint** of the circleId. It is
> intentionally non-reversible — it supports cross-circle distribution
> (`distinct_circles_hashed`) without putting a real id in the 90-day,
> unencrypted `AnalyticsEvent` table.

### Empty-state → first-circle bridge

```sql
-- CTA-tap rate among no-circles feed impressions.
SELECT
  count(*) FILTER (WHERE event = 'feed.viewed' AND props->>'hasCircles' = 'false') AS empty_feed_views,
  count(*) FILTER (WHERE event = 'feed.empty_cta_clicked')                          AS empty_cta_taps
FROM "AnalyticsEvent"
WHERE "createdAt" >= now() - interval '14 days';
```

---

## Caveats / gotchas (read before trusting a number)

- **Multiple `feed.viewed` per session.** Each filter change reloads the feed
  → another `feed.viewed`. CTR denominators are impression-weighted by design;
  for session-level metrics always `DISTINCT props->>'bootSessionId'`.
- **`reservationCount` ≠ total reservations.** It is the count of reservation
  *cards* (recipients with a near event), the CTR denominator — not the user's
  full reservation total (that lives in the «Мои брони» summary block, which is
  not instrumented as a ranked card here).
- **`userId` may be NULL** for the rare event that fires before any other
  authenticated route resolves the user row. Session metrics keyed on
  `bootSessionId` are unaffected.
- **Privacy:** no item titles, person names, or raw circle/item ids are ever in
  feed props — only counts, enums, booleans, and the hashed filter scope. The
  ingest sanitizer (`sanitizeAnalyticsProps`) is the backstop.
