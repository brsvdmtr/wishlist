# Secret Santa — Funnel SQL

Operator reference for the seasonal Secret Santa funnel. All queries run
against the `AnalyticsEvent` table (Postgres, JSONB `props`).

**Season window:** Secret Santa is active **Nov 15 → Feb 15**. Prepare and
sanity-check these queries *before* the season opens — the funnel is only as
good as the events flowing into it, and a broken emit discovered on Nov 14
at midnight is not a good time.

> ⚠️ **Read [§ 5 Caveats](#5-caveats) before trusting any number.** The
> `AnalyticsEvent` 90-day TTL is shorter than the season is long, and
> `seasonYear` is the *calendar* year of campaign creation — not the
> season-start year. Both bite if ignored.

---

## 1. Events

Five **server-emitted** funnel stages (added 2026-05-30), plus the two
pre-existing **client-emitted** paywall events. All live in the typed
`PRODUCT_EVENTS` taxonomy
([`packages/shared/src/analyticsEvents.ts`](../../packages/shared/src/analyticsEvents.ts));
server stages are emitted from
[`apps/api/src/routes/santa.routes.ts`](../../apps/api/src/routes/santa.routes.ts).

| Stage | Event | Source | `userId` (actor) | `props` |
|------:|-------|--------|------------------|---------|
| 1 | `santa.campaign_created` | server | organizer | `campaignId`, `type` (`CLASSIC`\|`MULTI_WAVE`), `seasonYear` |
| 2 | `santa.invite_clicked` | server | invitee (link opener) | `campaignId`, `alreadyJoined` |
| 3 | `santa.joined` | server | joiner | `campaignId`, `rejoin` |
| 4 | `santa.draw_completed` | server | organizer | `campaignId`, `roundId`, `roundNumber`, `participantCount`, `assignmentCount` |
| 5 | `santa.reveal_opened` | server | receiver | `campaignId`, `isFirstReveal` |
| — | `santa.paywall_viewed` | client | viewer | `context` |
| — | `santa.paywall_cta_clicked` | client | clicker | `context`, `plan` |
| — | `santa.gate_hit` | server | FREE user | `feature`, (`plan`, `limit`, `previousCount`, `campaignId` for `santa_hint`) |

**Actor differs by stage.** `userId` on stage 1 / 4 is the *organizer*; on
stage 2 / 3 / 5 it is the *invitee / joiner / receiver*. Do not sum distinct
`userId` across stages and call it "users in the funnel" — those are
different populations. Join stages on `campaignId`, not `userId`.

### Privacy contract — what is deliberately NOT here

The Secret Santa draw is anonymous: a giver never learns their receiver's
real identity, and a receiver only ever sees the giver's *alias*. That
guarantee extends into analytics. **No funnel event carries giver↔receiver
assignment identity** — no `giverParticipantId`, `receiverParticipantId`,
giver/receiver `userId`, alias, or the `assignments` array. `draw_completed`
emits only aggregate counts; `reveal_opened` emits only `campaignId` +
`isFirstReveal` and the receiver's own `userId`.

This is enforced **at the emit call-site**, not by the props sanitizer:
[`sanitizeAnalyticsProps`](../../packages/shared/src/sanitizeAnalyticsProps.ts)
is a *name denylist* and would happily pass a key like `giverParticipantId`
through. So "don't put it in props" is a hard rule, pinned by the
`leaks no giver/receiver identity` test in
[`apps/api/src/routes/santa.routes.test.ts`](../../apps/api/src/routes/santa.routes.test.ts).
There is therefore **no SQL in this doc that reconstructs who gave to whom** —
it cannot be written, by design.

---

## 2. Season scoping — do this first

Downstream stages (2–5) carry **only `campaignId`**, not `seasonYear`. The
robust way to scope a whole logical season is to derive the campaign set
from stage 1 and join everything else to it. This CTE is the spine of every
query below.

```sql
-- Campaigns belonging to ONE logical winter season (Nov 15 → Feb 15).
-- Scope by createdAt window, NOT by seasonYear (see § 5.2 for why).
WITH season_campaigns AS (
  SELECT
    props->>'campaignId'        AS campaign_id,
    props->>'type'              AS campaign_type,
    (props->>'seasonYear')::int AS season_year,
    MIN("createdAt")            AS created_at
  FROM "AnalyticsEvent"
  WHERE event = 'santa.campaign_created'
    AND "createdAt" >= '2025-11-15' AND "createdAt" < '2026-02-16'
  GROUP BY 1, 2, 3
)
SELECT count(*) AS campaigns, count(*) FILTER (WHERE campaign_type = 'MULTI_WAVE') AS multi_wave
FROM season_campaigns;
```

Adjust the two date literals per season. Everything below reuses
`season_campaigns`.

---

## 3. The funnel

### 3.1 Campaign-level funnel (organizer side)

How far do *campaigns* get: created → drawn → at least one reveal.

```sql
WITH season_campaigns AS (
  SELECT props->>'campaignId' AS campaign_id, props->>'type' AS campaign_type
  FROM "AnalyticsEvent"
  WHERE event = 'santa.campaign_created'
    AND "createdAt" >= '2025-11-15' AND "createdAt" < '2026-02-16'
  GROUP BY 1, 2
),
drawn AS (
  SELECT DISTINCT props->>'campaignId' AS campaign_id
  FROM "AnalyticsEvent" WHERE event = 'santa.draw_completed'
),
revealed AS (
  SELECT DISTINCT props->>'campaignId' AS campaign_id
  FROM "AnalyticsEvent" WHERE event = 'santa.reveal_opened'
)
SELECT
  count(*)                                                       AS campaigns_created,
  count(*) FILTER (WHERE d.campaign_id IS NOT NULL)              AS campaigns_drawn,
  count(*) FILTER (WHERE r.campaign_id IS NOT NULL)              AS campaigns_with_reveal,
  round(100.0 * count(*) FILTER (WHERE d.campaign_id IS NOT NULL) / nullif(count(*), 0), 1) AS pct_created_to_draw,
  round(100.0 * count(*) FILTER (WHERE r.campaign_id IS NOT NULL)
              / nullif(count(*) FILTER (WHERE d.campaign_id IS NOT NULL), 0), 1)            AS pct_draw_to_reveal
FROM season_campaigns sc
LEFT JOIN drawn    d ON d.campaign_id = sc.campaign_id
LEFT JOIN revealed r ON r.campaign_id = sc.campaign_id;
```

### 3.2 Participant-level funnel (invitee side)

How far do *people* get: clicked an invite → joined → opened their reveal.
Counted as distinct `(userId, campaignId)` pairs within season campaigns.

```sql
WITH season_campaigns AS (
  SELECT props->>'campaignId' AS campaign_id
  FROM "AnalyticsEvent"
  WHERE event = 'santa.campaign_created'
    AND "createdAt" >= '2025-11-15' AND "createdAt" < '2026-02-16'
  GROUP BY 1
),
clicked AS (
  SELECT DISTINCT props->>'campaignId' AS campaign_id, "userId"
  FROM "AnalyticsEvent" WHERE event = 'santa.invite_clicked' AND "userId" IS NOT NULL
),
joined AS (
  SELECT DISTINCT props->>'campaignId' AS campaign_id, "userId"
  FROM "AnalyticsEvent" WHERE event = 'santa.joined' AND "userId" IS NOT NULL
),
revealed AS (
  SELECT DISTINCT props->>'campaignId' AS campaign_id, "userId"
  FROM "AnalyticsEvent" WHERE event = 'santa.reveal_opened' AND "userId" IS NOT NULL
)
SELECT
  (SELECT count(*) FROM clicked  c JOIN season_campaigns s ON s.campaign_id = c.campaign_id) AS invite_clickers,
  (SELECT count(*) FROM joined   j JOIN season_campaigns s ON s.campaign_id = j.campaign_id) AS joiners,
  (SELECT count(*) FROM revealed r JOIN season_campaigns s ON s.campaign_id = r.campaign_id) AS revealers;
```

`invite_clicked → joined` is the conversion that matters most for growth:
it measures how compelling the invite preview is. Note a joiner need not have
fired `invite_clicked` first — a user can reach `POST .../join` via a direct
deep link or the campaign screen without first hitting the invite-preview
endpoint (`GET /santa/invite/:token`) that emits `invite_clicked`. So
`joiners > invite_clickers` is possible and not a bug. (The organizer is not
auto-added as a participant at creation — they join like anyone else.)

### 3.3 Reach vs. re-engagement (`isFirstReveal`, `rejoin`)

```sql
-- First reveals (reached the bottom of the funnel) vs. total reveal opens (engagement).
SELECT
  count(*)                                                          AS total_reveal_opens,
  count(*) FILTER (WHERE (props->>'isFirstReveal')::boolean)        AS first_reveals,
  count(DISTINCT "userId") FILTER (WHERE (props->>'isFirstReveal')::boolean) AS distinct_first_revealers
FROM "AnalyticsEvent"
WHERE event = 'santa.reveal_opened'
  AND "createdAt" >= '2025-11-15' AND "createdAt" < '2026-02-16';

-- Rejoin rate: how many joins were a left→JOINED transition vs. a fresh join.
SELECT
  count(*)                                              AS joins_total,
  count(*) FILTER (WHERE (props->>'rejoin')::boolean)   AS rejoins,
  count(*) FILTER (WHERE NOT (props->>'rejoin')::boolean) AS fresh_joins
FROM "AnalyticsEvent"
WHERE event = 'santa.joined'
  AND "createdAt" >= '2025-11-15' AND "createdAt" < '2026-02-16';
```

### 3.4 Type split (CLASSIC vs MULTI_WAVE)

`MULTI_WAVE` is PRO-gated, so its created→draw rate is a monetization signal.

```sql
WITH season_campaigns AS (
  SELECT props->>'campaignId' AS campaign_id, props->>'type' AS campaign_type
  FROM "AnalyticsEvent"
  WHERE event = 'santa.campaign_created'
    AND "createdAt" >= '2025-11-15' AND "createdAt" < '2026-02-16'
  GROUP BY 1, 2
),
drawn AS (
  SELECT DISTINCT props->>'campaignId' AS campaign_id
  FROM "AnalyticsEvent" WHERE event = 'santa.draw_completed'
)
SELECT
  sc.campaign_type,
  count(*)                                            AS created,
  count(*) FILTER (WHERE d.campaign_id IS NOT NULL)   AS drawn,
  round(100.0 * count(*) FILTER (WHERE d.campaign_id IS NOT NULL) / nullif(count(*), 0), 1) AS pct_drawn
FROM season_campaigns sc
LEFT JOIN drawn d ON d.campaign_id = sc.campaign_id
GROUP BY sc.campaign_type
ORDER BY sc.campaign_type;
```

### 3.5 Per-campaign drill-down

One row per campaign with every stage count side by side — useful for
spotting a campaign that drew but where nobody revealed (gift logistics
stalled), or huge invite-click counts with low joins (invite friction).

> The four `LEFT JOIN`s fan out into a cartesian product per campaign (a
> campaign with 5 clicks × 4 joins yields 20 intermediate rows). Every
> aggregate below is **deliberately fan-out-safe** — `count(DISTINCT "userId")`,
> `bool_or`, `max(...)`. Do **not** add a bare `count(*)`: it would count the
> multiplied rows, not events. For a large season, prefer the per-event CTE
> shape used in § 3.1 / § 3.2 over this wide join.

```sql
WITH season_campaigns AS (
  SELECT props->>'campaignId' AS campaign_id, props->>'type' AS campaign_type, MIN("createdAt") AS created_at
  FROM "AnalyticsEvent"
  WHERE event = 'santa.campaign_created'
    AND "createdAt" >= '2025-11-15' AND "createdAt" < '2026-02-16'
  GROUP BY 1, 2
)
-- Aggregates are fan-out-safe (DISTINCT / bool_or / max) — see note above.
SELECT
  sc.campaign_id,
  sc.campaign_type,
  sc.created_at,
  count(DISTINCT ic."userId")                                        AS invite_clickers,
  count(DISTINCT jn."userId")                                        AS joiners,
  max((dr.props->>'participantCount')::int)                          AS draw_participants,
  bool_or(dr.id IS NOT NULL)                                         AS drew,
  count(DISTINCT rv."userId") FILTER (WHERE (rv.props->>'isFirstReveal')::boolean) AS first_revealers
FROM season_campaigns sc
LEFT JOIN "AnalyticsEvent" ic ON ic.event = 'santa.invite_clicked'  AND ic.props->>'campaignId' = sc.campaign_id
LEFT JOIN "AnalyticsEvent" jn ON jn.event = 'santa.joined'          AND jn.props->>'campaignId' = sc.campaign_id
LEFT JOIN "AnalyticsEvent" dr ON dr.event = 'santa.draw_completed'  AND dr.props->>'campaignId' = sc.campaign_id
LEFT JOIN "AnalyticsEvent" rv ON rv.event = 'santa.reveal_opened'   AND rv.props->>'campaignId' = sc.campaign_id
GROUP BY sc.campaign_id, sc.campaign_type, sc.created_at
ORDER BY sc.created_at;
```

---

## 4. Monetization side-funnel (paywall + gate)

The PRO gate (`santa.gate_hit`, server) and the paywall UI funnel
(`santa.paywall_viewed` → `santa.paywall_cta_clicked`, client) measure the
upsell, not the gift funnel. `context` / `feature` names the surface
(`santa_multi_wave`, `santa_exclusions`, `santa_exclusion_groups`,
`santa_hint`).

```sql
-- Paywall funnel by surface. paywall_cta_clicked is INTENT, not payment —
-- join to payment.completed / pro.activated for true conversion.
SELECT
  v.props->>'context'                                          AS surface,
  count(*) FILTER (WHERE v.event = 'santa.paywall_viewed')     AS viewed,
  count(*) FILTER (WHERE v.event = 'santa.paywall_cta_clicked') AS cta_clicked
FROM "AnalyticsEvent" v
WHERE v.event IN ('santa.paywall_viewed', 'santa.paywall_cta_clicked')
  AND v."createdAt" >= '2025-11-15' AND v."createdAt" < '2026-02-16'
GROUP BY 1
ORDER BY viewed DESC;

-- Gate hits by feature (server-authoritative — which gate fires most often).
SELECT
  props->>'feature' AS feature,
  count(*)          AS gate_hits,
  count(DISTINCT "userId") AS distinct_users
FROM "AnalyticsEvent"
WHERE event = 'santa.gate_hit'
  AND "createdAt" >= '2025-11-15' AND "createdAt" < '2026-02-16'
GROUP BY 1
ORDER BY gate_hits DESC;
```

---

## 5. Caveats

### 5.1 The 90-day TTL is shorter than the season

`AnalyticsEvent` rows are pruned after **90 days**. The season runs ~92 days
(Nov 15 → Feb 15). **Events from the opening week begin expiring while the
season is still live.** Consequences:

- A full-season funnel query run *after* Feb 15 will under-count the early
  stages (campaigns created in mid-November are gone) while still seeing late
  reveals — inflating every conversion ratio.
- **Harvest during the season.** Run the per-campaign drill-down (§ 3.5)
  weekly and snapshot it, or build a durable rollup table (the pattern
  [`UserDailyActivity`](./core-loop-dashboard.md) uses for core-loop metrics)
  before trusting end-of-season aggregates. A dedicated `SantaFunnelDaily`
  rollup is the right future step if this funnel becomes load-bearing — it is
  **not built yet**; today these are ad-hoc queries against the live table.

### 5.2 `seasonYear` is the calendar year, not the season-start year

`santa.campaign_created.props.seasonYear` is set to `now.getFullYear()` at
creation time. A single winter season therefore **splits across two
`seasonYear` values**: campaigns created Nov 15–Dec 31 2025 carry
`seasonYear = 2025`; those created Jan 1–Feb 15 2026 carry `seasonYear =
2026`. Filtering `WHERE seasonYear = 2026` silently drops the Nov–Dec half of
the 2025/26 season. **Scope by the `createdAt` window instead** (as every
query above does); treat `seasonYear` only as a coarse label.

### 5.3 `userId` is the internal cuid, never the Telegram id

Per the
[`AnalyticsEvent.userId` contract](../analytics-events.md#analyticseventuserid-contract--internal-userid-only),
`userId` is the internal `User.id` (cuid) or `NULL`. Join to `"User"."id"`
directly — no `OR u."telegramId" = ae."userId"` fallback needed. `NULL`
`userId` rows (deleted accounts) are excluded by the `"userId" IS NOT NULL`
guards above.

### 5.4 Server stages cannot be client-spoofed

All five funnel stages are `sources: ['server']`, so `/tg/telemetry`
hard-denies them on ingest (`isServerOnlyProductEvent`) and the `santa.`
domain is not in the telemetry prefix allowlist. Every row for these events
was written by the API route handler — a client cannot mint a fake
`santa.draw_completed`. The two `santa.paywall_*` events are `['client']` and
*are* client-emitted; treat `paywall_cta_clicked` as intent, never as revenue.

### 5.5 Actor populations differ per stage

Restated because it is the most common analysis error: stages 1 & 4 are
emitted by the **organizer**, stages 2/3/5 by the **invitee/joiner/receiver**.
Join stages on `campaignId`. A "distinct users across all santa.* events"
count mixes organizers and participants and means nothing on its own.

### 5.6 These are at-least-once events — never bare-`count(*)` them

The emits are fire-and-forget signals, not deduplicated facts. Three places
where a raw row count over-counts (every query above already uses `DISTINCT` /
`bool_or` / `max`, so they are safe — this is a trap only for ad-hoc counts):

- **`invite_clicked`** fires on *every* successful preview resolution, including
  an already-joined user re-opening the link (`props.alreadyJoined = true`) and
  repeat opens by the same person. Count distinct `(userId, campaignId)` for
  "clickers"; a bare `count(*)` is "preview loads", a different (and noisier)
  metric.
- **`draw_completed`** is **at-least-once per successful round**: a draw whose
  assignment transaction commits but whose subsequent (non-transactional)
  audit-log write fails rolls the campaign back to `LOCKED` and 500s, so the
  organizer retries and a *new* round fires a *second* `draw_completed` (new
  `roundId`). Rare, but real. Dedup on `props->>'roundId'` if you ever count
  draw rows directly; campaign-level `DISTINCT campaignId` (§ 3.1) is immune.
- **`reveal_opened`** with `isFirstReveal = true` can fire more than once for
  the same receiver if the cosmetic `revealedAt` write fails on the first open.
  Use `count(DISTINCT "userId")` for "distinct first-revealers" (as § 3.3 does),
  not `count(*) FILTER (WHERE isFirstReveal)`.

---

## 6. Related docs

- [`docs/analytics-events.md`](../analytics-events.md) — event naming + allowlist contract.
- [`docs/research/analytics-pii-audit.md`](./analytics-pii-audit.md) — why user content stays out of `props`.
- [`docs/research/core-loop-dashboard.md`](./core-loop-dashboard.md) — durable-rollup pattern (TTL escape hatch).
- [`packages/shared/src/analyticsEvents.ts`](../../packages/shared/src/analyticsEvents.ts) — `PRODUCT_EVENTS` descriptors.
- [`apps/api/src/routes/santa.routes.ts`](../../apps/api/src/routes/santa.routes.ts) — emit call-sites.
