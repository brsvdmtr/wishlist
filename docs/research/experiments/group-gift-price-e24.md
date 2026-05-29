# E24 — Group Gift unlock price elasticity (`group-gift-price`)

The first concrete experiment on the [A/B infrastructure](./README.md).

## Hypothesis

79 ⭐ may be too steep a gate for a one-time Group Gift unlock. A lower 39 ⭐
price may lift the unlock-rate enough that **revenue per paywall impression**
rises despite the lower ticket — and may also widen the top of the Group Gift
funnel. See [`06-experiment-backlog.md`](../06-experiment-backlog.md) E24.

| Arm | Variant | Price | Env default |
|-----|---------|-------|-------------|
| Control | `control` (+ holdout, + experiment disabled) | **79 ⭐** | `GROUP_GIFT_PRICE_XTR` |
| Test | `treatment` | **39 ⭐** | `GROUP_GIFT_PRICE_TEST_XTR` |

- **Primary metric:** revenue per Group-Gift-paywall impression.
- **Guardrail:** Group Gift completion rate (completed ÷ created) per arm — the
  cheaper price must not attract unlockers who never finish a collection.

## How the price is resolved

Single source of truth: [`services/group-gift-pricing.ts`](../../../apps/api/src/services/group-gift-pricing.ts)
→ `resolveGroupGiftUnlockPrice(userId)`, which wraps the sticky
`getExperimentAssignment`. The variant is **pinned for life** on first
exposure, so the price a user sees == the price they are charged, even across
rollout changes. Three server surfaces call the same resolver, so they can
never disagree:

| Surface | File | Role |
|---------|------|------|
| Bootstrap `GET /tg/wishlists` | `routes/wishlists.routes.ts` | sets `groupGift.priceXtr` (→ Mini App `ggAccess`, the paywall SCREEN price) + `groupGift.priceVariant` (so the client tags its impression) |
| Invoice `POST /tg/billing/addon/checkout` | `routes/billing.routes.ts` | the Stars amount actually charged for `group_gift_unlock` |
| 402 backstop `POST /tg/items/:id/group-gift` | `routes/group-gifts.routes.ts` | paywall price quoted when a stale client lets a non-entitled user reach create |

Only **non-entitled** users are resolved (entitled users never see or pay the
price). When the experiment is **disabled** (the default) the resolver returns
`control`/79 with **no DB work** — the system is byte-identical to pre-E24, and
existing purchases are unaffected (the bot grants `group_gift_unlock` by SKU
code, not by price — `apps/bot/src/payments.ts:applyAddonPayment`).

**Snapshot vs charge-time.** The paywall SCREEN shows the price captured in the
bootstrap (`ggAccess.priceXtr`), a per-session snapshot; the invoice re-resolves
at charge time. Because the variant is *sticky*, these agree for the entire
lifetime of an assigned user even as `ROLLOUT` changes. The one transient
divergence is an operator flipping `ENABLED` ON/OFF **mid-session**: a client
holding a stale bootstrap can show one price while the invoice re-resolves to
the other (e.g. a kill-switch flip shows 39 but charges 79). Telegram's native
invoice sheet always displays the real charge amount before the user confirms,
so this is a cosmetic in-app/Telegram mismatch during the flip window, not a
silent overcharge — and readouts are unaffected (they attribute via the
`ExperimentAssignment` ledger, not the client event's `variant` prop).

## Events

| Event | Source | Notes |
|-------|--------|-------|
| `experiment.assigned` | server | once per user, props `{ key:'group-gift-price', variant, holdout }` |
| `group_gift.unlock_paywall_variant` | client | **paywall impression** (denominator). props `{ variant, priceXtr }`. Fires when the `group-gift-paywall` screen opens. |
| `addon_checkout_started` / `addon_checkout_failed` | server (log) | now carry `bucket` for `group_gift_unlock` checkouts |
| `feature_gate_hit_group_gift` | server | now carries `{ priceXtr, bucket }` |

Revenue itself is the durable `Purchase` row (`skuCode='group_gift_unlock'`,
`starsPrice` = the bucket price). Variant attribution for all readouts comes
from the permanent `ExperimentAssignment` ledger, **not** from a client event.

## Configure & enable

Two env vars on prod (`/opt/wishlist/.env`); the price test variant is a third,
optional override (defaults to 39):

```sh
EXP_GROUP_GIFT_PRICE_ENABLED=true
EXP_GROUP_GIFT_PRICE_ROLLOUT=50      # treatment share; decide BEFORE traffic
# GROUP_GIFT_PRICE_TEST_XTR=39       # optional; default 39
```

Apply with **no code deploy** (env interpolates only at `up` time — use
`up -d`, not `restart`):

```sh
ssh vultr 'cd /opt/wishlist && docker compose up -d api'
```

Kill switch: `EXP_GROUP_GIFT_PRICE_ENABLED=false` + `up -d api` → everyone back
to 79 immediately, assignment rows go inert.

## Reading results

Run on prod: `ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "<query>"'`

### Primary — revenue per paywall impression

```sql
WITH assigned AS (
  SELECT "userId", variant
  FROM "ExperimentAssignment"
  WHERE "experimentKey" = 'group-gift-price'
),
-- Numerator (Purchase, durable) and denominator (AnalyticsEvent, 90-day TTL)
-- live on different clocks. Bound BOTH to the same window so revenue-per-
-- impression isn't overstated once impressions start aging out. Widen the
-- interval to the experiment's actual run length if it ran < 90 days.
impressions AS (
  SELECT a.variant, COUNT(*) AS impressions
  FROM "AnalyticsEvent" e
  JOIN assigned a ON a."userId" = e."userId"
  WHERE e.event = 'group_gift.unlock_paywall_variant'
    AND e."createdAt" >= NOW() - INTERVAL '90 days'
  GROUP BY a.variant
),
revenue AS (
  SELECT a.variant,
         COUNT(*)                          AS unlocks,
         COALESCE(SUM(p."starsPrice"), 0)  AS revenue_xtr
  FROM "Purchase" p
  JOIN assigned a ON a."userId" = p."userId"
  WHERE p."skuCode" = 'group_gift_unlock' AND p.status = 'completed'
    AND p."createdAt" >= NOW() - INTERVAL '90 days'
  GROUP BY a.variant
)
SELECT v.variant,
       COALESCE(i.impressions, 0) AS impressions,
       COALESCE(r.unlocks, 0)     AS unlocks,
       COALESCE(r.revenue_xtr, 0) AS revenue_xtr,
       ROUND(COALESCE(r.unlocks,0)::numeric     / NULLIF(i.impressions,0), 4) AS unlock_rate,
       ROUND(COALESCE(r.revenue_xtr,0)::numeric / NULLIF(i.impressions,0), 4) AS revenue_per_impression
FROM (SELECT DISTINCT variant FROM assigned) v
LEFT JOIN impressions i ON i.variant = v.variant
LEFT JOIN revenue    r ON r.variant = v.variant
ORDER BY v.variant;
```

`revenue_per_impression` is the metric to compare across arms. The cheaper arm
wins only if its `revenue_per_impression` exceeds control's (a higher
`unlock_rate` at a lower ticket can still net more per impression — or not).

### Guardrail — completion rate

```sql
WITH assigned AS (
  SELECT "userId", variant FROM "ExperimentAssignment" WHERE "experimentKey" = 'group-gift-price'
),
created AS (
  SELECT a.variant, COUNT(*) AS created
  FROM "AnalyticsEvent" e JOIN assigned a ON a."userId" = e."userId"
  WHERE e.event = 'group_gift_created'
    AND e."createdAt" >= NOW() - INTERVAL '90 days'
  GROUP BY a.variant
),
completed AS (
  SELECT a.variant, COUNT(*) AS completed
  FROM "AnalyticsEvent" e JOIN assigned a ON a."userId" = e."userId"
  WHERE e.event = 'group_gift_completed'
    AND e."createdAt" >= NOW() - INTERVAL '90 days'
  GROUP BY a.variant
)
SELECT v.variant,
       COALESCE(c.created, 0)    AS created,
       COALESCE(cp.completed, 0) AS completed,
       ROUND(COALESCE(cp.completed,0)::numeric / NULLIF(c.created,0), 4) AS completion_rate
FROM (SELECT DISTINCT variant FROM assigned) v
LEFT JOIN created   c  ON c.variant = v.variant
LEFT JOIN completed cp ON cp.variant = v.variant
ORDER BY v.variant;
```

If `treatment.completion_rate` drops materially below `control` while revenue is
flat/down, the discount is pulling in low-intent unlockers — stop the test.

### Sanity checks

```sql
-- Assignment split (the durable ledger; no TTL).
SELECT variant, holdout, COUNT(*)
FROM "ExperimentAssignment" WHERE "experimentKey" = 'group-gift-price'
GROUP BY variant, holdout;

-- Price actually charged per arm — MUST be control→79, treatment→39
-- (validates self-checks #1 & #2 in production).
SELECT a.variant, p."starsPrice", COUNT(*)
FROM "Purchase" p
JOIN "ExperimentAssignment" a
  ON a."userId" = p."userId" AND a."experimentKey" = 'group-gift-price'
WHERE p."skuCode" = 'group_gift_unlock' AND p.status = 'completed'
GROUP BY a.variant, p."starsPrice"
ORDER BY a.variant;
```

> **TTL note.** `AnalyticsEvent` is pruned after 90 days; `ExperimentAssignment`
> and `Purchase` are permanent. Measure the impression-based metric within the
> 90-day window; revenue and assignment are durable.

## Ship the winner

Delete both env flags, then in `services/group-gift-pricing.ts` collapse the
resolver to the chosen constant and drop the `priceVariant` plumbing (or, if 39
wins, set `GROUP_GIFT_PRICE_XTR=39` and retire the experiment). The
`group_gift.unlock_paywall_variant` event can stay as a permanent paywall
impression counter.
