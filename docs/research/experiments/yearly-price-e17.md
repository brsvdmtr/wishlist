# E17 — Yearly Pro price elasticity (`yearly-price`)

A 3-way price test on the [A/B infrastructure](./README.md) — the first
experiment to use the **multi-variant** path (`getWeightedAssignment`).

**Status: PREPARED, DORMANT** (since 2026-05-30). Shipped with
`EXP_YEARLY_PRICE_ENABLED` unset → everyone pays the flat 800 ⭐, no assignment
rows, byte-identical to pre-E17. Do **not** enable until the launch checklist
below is green.

## Hypothesis

800 ⭐/yr is untested. A cheaper **600 ⭐** may lift yearly conversion enough
that revenue per yearly-paywall impression rises despite the lower ticket; a
pricier **1000 ⭐** may raise revenue per buyer without materially hurting
conversion. We test both directions at once. See
[`06-experiment-backlog.md`](../06-experiment-backlog.md) E17.

| Arm | Variant | Price | Env default |
|-----|---------|-------|-------------|
| Control | `control` (+ holdout, + experiment disabled) | **800 ⭐** | `PRO_YEARLY_PRICE_XTR` |
| Test A | `a` | **600 ⭐** (cheaper) | `PRO_YEARLY_PRICE_A_XTR` |
| Test B | `b` | **1000 ⭐** (pricier) | `PRO_YEARLY_PRICE_B_XTR` |

- **Primary metric:** revenue per yearly-paywall impression.
- **Secondary:** yearly conversion (yearly purchases ÷ impressions).
- **Guardrail:** monthly cannibalization — the cheaper arm must not just pull
  would-be *monthly* (recurring, higher-LTV) subscribers into a one-time cheap
  yearly with no net revenue gain.

## How the price is resolved

Single source of truth: [`services/yearly-pricing.ts`](../../../apps/api/src/services/yearly-pricing.ts)
→ `resolveYearlyProPrice(userId)`, which wraps the sticky multi-variant
`getWeightedAssignment`. The variant is **pinned for life** on first exposure,
so the price a user sees == the price they are charged, even across rollout
changes. Three server surfaces call the same resolver — they can never disagree:

| Surface | File | Role |
|---------|------|------|
| Bootstrap `GET /tg/wishlists` | `routes/wishlists.routes.ts` | sets `proYearly.priceXtr` (→ the Mini App paywall tile + CTA price) + `proYearly.priceVariant` (so the client tags its impression) |
| Invoice `POST /tg/billing/pro/checkout` (`plan: yearly`) | `routes/billing.routes.ts` | the Stars amount actually charged; the bucket is also appended to the invoice payload (`pro_yearly:<tgId>:<uuid>:<bucket>`) |
| Pricing `GET /tg/me/plan` | `routes/me.routes.ts` | `proYearlyPriceStars` / `proYearlyPriceVariant` — the canonical pricing endpoint, kept consistent with the charged price |

Only **non-Pro** users are resolved (Pro users never see the paywall; a Pro
user stacking a yearly purchase keeps the control 800, and **existing yearly
subscribers are never re-priced** — a subscription's entitlement is its
`billingPeriod` + `currentPeriodEnd`, never recomputed from the price —
**self-check #3**). The shared display gating lives in `resolveYearlyDisplay`
(non-Pro + active → bucket price/variant; otherwise null), used by both read
surfaces so they resolve identically to the charge path. When the experiment is
**disabled** (the default), the resolver returns `control`/800 with
`active:false` and **no DB work**; every surface then omits the bucket plumbing
entirely, so the system is byte-identical to pre-E17 and existing purchases are
unaffected.

> **Fallback caveat.** "Byte-identical flat 800" assumes the control price
> `PRO_YEARLY_PRICE_XTR` is at its 800 default. The Mini App's pre-server /
> dormant fallback is the hardcoded `PRO_PRICE_YEARLY_STARS = 800`
> (`miniapp-constants.ts`) — a *pre-existing* coupling, not introduced by E17. If
> an operator ever overrides `PRO_YEARLY_PRICE_XTR` away from 800, update that
> client constant in lockstep (the constant file already documents this rule).

### Multi-variant infrastructure (new in E17)

The binary `control`/`treatment` path could not express three arms. E17 adds
`getWeightedAssignment` / `assignWeightedVariant` to
[`experiments.service.ts`](../../../apps/api/src/services/experiments.service.ts):
the same hash seed, the same 5% holdout, the same env config, the same sticky
first-exposure write + once-only `experiment.assigned` — only the bucketing is
N-way and the stored label (`a`/`b`) is kept verbatim instead of being coerced
to the binary union. **Invariant:** a given experiment key uses EITHER the
binary OR the weighted path, never both (the binary read-back would flatten
`a`/`b` to control). `yearly-price` only ever uses the weighted path.

### `ROLLOUT` semantics (3-way)

`EXP_YEARLY_PRICE_ROLLOUT` is the share of (non-holdout) users enrolled into a
**test arm**, split 50/50 between `a` and `b`; the rest stay `control`. Control
is the first weight, so raising the rollout only ever moves a not-yet-assigned
user one-way out of control (monotonic, like the binary path).

| ROLLOUT | control | a | b | use |
|--------:|--------:|--:|--:|-----|
| 0   | 100% | 0%   | 0%   | dormant / ramp start |
| 67  | ~33% | ~33.5% | ~33.5% | **balanced 3-way (recommended at launch)** |
| 100 | 0%   | 50%  | 50%  | no in-experiment control — the 5% holdout is the only baseline |

> Set `ROLLOUT=67` for a clean, balanced 3-arm read. The 5% global holdout is
> always `control`/800 and is a clean never-touched baseline on top of the
> in-experiment control arm.

### Snapshot vs charge-time

The paywall tile shows the price captured in the bootstrap (`proYearly`), a
per-session snapshot; the invoice re-resolves at charge time. Because the
variant is *sticky*, these agree for the lifetime of an assigned user even as
`ROLLOUT` changes. The one transient divergence is an operator flipping
`ENABLED` mid-session (the kill switch): a client holding a stale bootstrap can
show a test price while the invoice re-resolves to control 800. Telegram's
native invoice sheet always shows the real charge amount before the user
confirms, so this is a cosmetic in-app/Telegram mismatch during the flip
window, not a silent overcharge — and readouts attribute via the
`ExperimentAssignment` ledger, not the client event.

## Events

| Event | Source | Notes |
|-------|--------|-------|
| `experiment.assigned` | server | once per user, props `{ key:'yearly-price', variant, holdout }` |
| `paywall.viewed` | client | the Pro upsell sheet (which always shows the yearly tile) — the **impression denominator**. When the experiment is active, props also carry `yearlyVariant` + `yearlyPriceXtr`. |
| `payment.completed` | bot (server) | carries `priceBucket` (the arm) for yearly purchases made while live — **self-check #4** |
| `pro.activated` | bot (server) | first-time activations also carry `priceBucket` |
| `checkout_started` / `checkout_failed` | server (log) | carry `bucket` for yearly checkouts |

Revenue itself is the durable `PaymentEvent` row (`eventType='payment_success_yearly'`,
`totalAmount`=the bucket price) and the `Subscription.starsPrice`. Variant
attribution for all readouts comes from the permanent `ExperimentAssignment`
ledger, **not** from a client event (`AnalyticsEvent` is pruned at 90 days).

## Configure & enable

Env on prod (`/opt/wishlist/.env`); the two test prices are optional overrides:

```sh
EXP_YEARLY_PRICE_ENABLED=true
EXP_YEARLY_PRICE_ROLLOUT=67       # balanced 3-way; decide BEFORE traffic
# PRO_YEARLY_PRICE_A_XTR=600      # optional; default 600 (cheaper arm)
# PRO_YEARLY_PRICE_B_XTR=1000     # optional; default 1000 (pricier arm)
```

Apply with **no code deploy** (env interpolates only at `up` time — use
`up -d`, NOT `restart`; see `feedback_docker_compose_recreate`). Both the API
and the bot read the same `.env`, so recreate both:

```sh
ssh vultr 'cd /opt/wishlist && docker compose up -d api bot'
```

Kill switch: `EXP_YEARLY_PRICE_ENABLED=false` + `up -d api bot` → everyone back
to 800 immediately, assignment rows go inert.

## 🚦 Launch checklist — do NOT enable until ALL are green

This experiment ships dormant on purpose. Enable only after:

1. **`payment.completed` works** — verify rows land with `billingPeriod='yearly'`
   and (once live) a `priceBucket` prop. Spot-check on prod:
   `SELECT props FROM "AnalyticsEvent" WHERE event='payment.completed' ORDER BY "createdAt" DESC LIMIT 5;`
2. **`paywall.viewed` works** — verify pro-upsell impressions land:
   `SELECT COUNT(*) FROM "AnalyticsEvent" WHERE event='paywall.viewed' AND props->>'surface'='pro_upsell_sheet' AND "createdAt" >= NOW() - INTERVAL '7 days';`
3. **`pro.activated` works** — verify first-time activations land with
   `billingPeriod='yearly'`.
4. **June pricing readout ready** — the baseline yearly conversion + revenue per
   impression for the *current* 800 ⭐ price is computed for June, so we have a
   pre-experiment reference before perturbing the price.

### ⛔ Coordination constraint — never run alongside Event Pass (E21)

**E17 and E21 (Event Pass) MUST NOT run at the same time** — both change the
paywall structure, so running them concurrently confounds each other's read
(you can't attribute a conversion change to the yearly price vs. the new pass
surface). Confirm E21 is OFF (`EXP_*EVENT_PASS*_ENABLED` unset, or whatever key
E21 ships under) before enabling E17, and vice-versa. This is called out
directly in the backlog.

## Reading results

Run on prod: `ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "<query>"'`

### Primary — revenue per yearly-paywall impression (+ secondary: yearly conversion)

```sql
WITH assigned AS (
  SELECT "userId", variant
  FROM "ExperimentAssignment"
  WHERE "experimentKey" = 'yearly-price'
),
-- Numerator (PaymentEvent, durable) and denominator (AnalyticsEvent, 90-day TTL)
-- live on different clocks. Bound BOTH to the same window so revenue-per-
-- impression isn't overstated once impressions start aging out. Widen the
-- interval to the experiment's actual run length if it ran < 90 days.
impressions AS (
  -- The Pro upsell sheet always shows the yearly tile, so a pro_upsell_sheet
  -- paywall.viewed IS a yearly-paywall impression.
  SELECT a.variant, COUNT(*) AS impressions
  FROM "AnalyticsEvent" e
  JOIN assigned a ON a."userId" = e."userId"
  WHERE e.event = 'paywall.viewed'
    AND e.props->>'surface' = 'pro_upsell_sheet'
    AND e."createdAt" >= NOW() - INTERVAL '90 days'
  GROUP BY a.variant
),
revenue AS (
  SELECT a.variant,
         COUNT(*)                           AS yearly_purchases,
         COALESCE(SUM(pe."totalAmount"), 0)  AS revenue_xtr
  FROM "PaymentEvent" pe
  JOIN assigned a ON a."userId" = pe."userId"
  WHERE pe."eventType" = 'payment_success_yearly'
    AND pe."createdAt" >= NOW() - INTERVAL '90 days'
  GROUP BY a.variant
)
SELECT v.variant,
       COALESCE(i.impressions, 0)      AS impressions,
       COALESCE(r.yearly_purchases, 0) AS yearly_purchases,
       COALESCE(r.revenue_xtr, 0)      AS revenue_xtr,
       ROUND(COALESCE(r.yearly_purchases,0)::numeric / NULLIF(i.impressions,0), 4) AS yearly_conversion,
       ROUND(COALESCE(r.revenue_xtr,0)::numeric      / NULLIF(i.impressions,0), 4) AS revenue_per_impression
FROM (SELECT DISTINCT variant FROM assigned) v
LEFT JOIN impressions i ON i.variant = v.variant
LEFT JOIN revenue    r ON r.variant = v.variant
ORDER BY v.variant;
```

`revenue_per_impression` is the metric to compare across arms. The cheaper arm
`a` wins only if its `revenue_per_impression` exceeds control's (a higher
`yearly_conversion` at a lower ticket can still net more per impression — or
not). The pricier arm `b` wins if conversion holds well enough that the higher
ticket lifts `revenue_per_impression`.

> **Impression-denominator caveat.** One pro context — `url_import` — opens the
> sheet on a focused `options` sub-view that does NOT show the yearly tile until
> the user taps "PRO". So a `pro_upsell_sheet` impression for `context='url_import'`
> can be counted before the yearly price was actually shown, slightly inflating
> the denominator and *understating* absolute `yearly_conversion`. The over-count
> is symmetric across arms (attribution is by the durable ledger), so the
> **relative** arm comparison stays valid. For a precise absolute conversion,
> add `AND e.props->>'context' <> 'url_import'` to the `impressions` CTE.

### Guardrail — monthly cannibalization

```sql
WITH assigned AS (
  SELECT "userId", variant FROM "ExperimentAssignment" WHERE "experimentKey" = 'yearly-price'
),
by_period AS (
  SELECT a.variant,
         pe."eventType",
         COUNT(*)                           AS purchases,
         COALESCE(SUM(pe."totalAmount"), 0)  AS revenue_xtr
  FROM "PaymentEvent" pe
  JOIN assigned a ON a."userId" = pe."userId"
  WHERE pe."eventType" IN ('payment_success', 'payment_success_yearly')   -- monthly + yearly
    AND pe."createdAt" >= NOW() - INTERVAL '90 days'
  GROUP BY a.variant, pe."eventType"
)
SELECT variant,
       COALESCE(SUM(purchases)   FILTER (WHERE "eventType" = 'payment_success'), 0)        AS monthly_purchases,
       COALESCE(SUM(purchases)   FILTER (WHERE "eventType" = 'payment_success_yearly'), 0) AS yearly_purchases,
       COALESCE(SUM(revenue_xtr), 0)                                                       AS total_sub_revenue_xtr
FROM by_period
GROUP BY variant
ORDER BY variant;
```

If the cheaper arm `a` shows materially **fewer monthly purchases** AND its
`total_sub_revenue_xtr` (per impression — divide by the impressions from the
primary query) isn't higher than control's, the discount is pulling would-be
monthly subscribers into a cheaper one-time yearly — **cannibalization without
net gain.** Stop the test.

### Sanity checks

```sql
-- Assignment split (the durable ledger; no TTL).
SELECT variant, holdout, COUNT(*)
FROM "ExperimentAssignment" WHERE "experimentKey" = 'yearly-price'
GROUP BY variant, holdout ORDER BY variant, holdout;

-- Price actually charged per arm — MUST be control→800, a→600, b→1000
-- (validates self-checks #1 & #2 in production).
SELECT a.variant, pe."totalAmount", COUNT(*)
FROM "PaymentEvent" pe
JOIN "ExperimentAssignment" a
  ON a."userId" = pe."userId" AND a."experimentKey" = 'yearly-price'
WHERE pe."eventType" = 'payment_success_yearly'
GROUP BY a.variant, pe."totalAmount" ORDER BY a.variant, pe."totalAmount";

-- payment.completed's denormalized priceBucket MUST match the ledger variant
-- (validates self-check #4 plumbing end-to-end).
SELECT a.variant AS ledger_variant, e.props->>'priceBucket' AS event_bucket, COUNT(*)
FROM "AnalyticsEvent" e
JOIN "ExperimentAssignment" a
  ON a."userId" = e."userId" AND a."experimentKey" = 'yearly-price'
WHERE e.event = 'payment.completed' AND e.props->>'billingPeriod' = 'yearly'
  AND e."createdAt" >= NOW() - INTERVAL '90 days'
GROUP BY a.variant, e.props->>'priceBucket' ORDER BY a.variant;
```

> **TTL note.** `AnalyticsEvent` is pruned after 90 days; `ExperimentAssignment`,
> `PaymentEvent`, and `Subscription` are permanent. Measure the impression-based
> metric within the 90-day window; revenue and assignment are durable.

## Ship the winner

Delete the env flags, then in `services/yearly-pricing.ts` collapse the resolver
to the chosen constant and remove the bucket plumbing: `proYearly.priceVariant`
(bootstrap), `proYearlyPriceVariant` (/me/plan), the payload's 4th segment, and
the `priceBucket` analytics prop (or, if a test price wins, set
`PRO_YEARLY_PRICE_XTR=<winner>` and retire the experiment). The `paywall.viewed`
impression event stays as-is.
