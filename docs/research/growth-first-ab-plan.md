# Growth-first limits — A/B plan (`growth-first-limits`)

> **Status: PREPARED, NOT LAUNCHED. OFF BY DEFAULT.**
> Created 2026-05-29. Owner: Dmitry.
> Config + read-only resolver shipped; **no env flag set, no users enrolled,
> production limits unchanged.** This doc is the contract for *if/when* we turn
> it on.

## 0. The one-paragraph warning (read this first)

Growth-first is the proposed step **after** the Conservative pricing patch — a
materially more generous FREE tier to lift activation, sharing and virality. It
carries a real, known risk: **a more generous FREE tier can suppress PRO
revenue** (less reason to upgrade). Therefore it ships as a **bucketed A/B with
a 5% holdout and hard revenue guardrails — never as a global flip.** Enabling
Variant B for everyone at once is not "growth"; it is an un-measured bet on
revenue. The whole point of this setup is to *measure* the conversion/ARPPU hit
against the activation/virality lift before committing a single percentage point
of permanent rollout. If you are tempted to set `ROLLOUT=100` on day one, stop
and re-read this paragraph.

---

## 1. Hypothesis

**If** FREE users get a more generous quantity allowance (more wishlists, items,
subscriptions, categories), **then** activation, retention and sharing rise
enough that the larger top-of-funnel **more than offsets** any drop in
FREE→PRO conversion — net revenue (revenue per *assigned* user) flat-or-up.

The experiment is built to falsify this cheaply. The kill condition is a
sustained drop in revenue-per-assigned-user beyond the guardrail band (§6).

## 2. Variants

`control` = current production limits (Variant A). `treatment` = growth-first
(Variant B). PRO is **unchanged** in both arms — varying PRO simultaneously
would confound the PRO-revenue guardrails, so the only moving part is the FREE
tier.

### 2a. Plan limits — **WIRED in Phase-1** (live the moment the flag is on)

These flow through the entitlement resolver (`getUserEntitlement` →
`getEffectiveEntitlements`), so both the displayed limits (`GET /tg/me/plan`)
and enforcement (wishlist/item/subscription/category gates) move together — no
display-vs-enforcement skew possible.

| Lever (FREE)            | Variant A (prod) | Variant B (growth) | Δ        |
|-------------------------|:----------------:|:------------------:|----------|
| wishlists               | 2                | **3**              | +1       |
| items (per wishlist)    | 20               | **30**             | +10      |
| participants            | 10               | 10                 | unchanged¹|
| subscriptions           | 2                | **5**              | +3       |
| categories per wishlist | 1                | **3**              | +2       |
| PRO (all numeric limits)| —                | unchanged          | —        |

¹ Variant B's spec lists participants = 10, which already equals production —
so it is intentionally *not* a lever here. Listed for completeness.

Source of truth: [`GROWTH_FIRST_FREE_PLAN`](../../apps/api/src/services/limits-experiment.ts).
Production values are never mutated — `treatment` substitutes a separate
`PlanLimits` object; `control`/holdout/disabled return the production plan
byte-for-byte.

### 2b. Credit / curated levers — **DECLARED, enforcement DEFERRED to launch**

These three are part of Variant B but live in separate enforcement paths (or
need new product surface). Their numbers are declared in
[`GROWTH_FIRST_DECLARED_QUOTAS`](../../apps/api/src/services/limits-experiment.ts)
as the single source of truth, but the Phase-1 resolver does **not** vary them —
wiring display without enforcement would create a "shows 10, allows 5" landmine.
See §7 for the exact launch wiring.

| Lever (FREE)              | Variant A (prod) | Variant B (growth) | Why deferred |
|---------------------------|:----------------:|:------------------:|--------------|
| URL imports / month       | 5                | **10**             | `services/import-credits.ts` — separate quota + raw-SQL enforcement |
| hints / month             | 3                | **5**              | `services/hint-credits.ts` — separate quota + advisory-lock charge tx |
| curated selections / month| 0 (hard PRO gate)| **1**              | currently PRO-only; needs a **new FREE monthly counter** + gate change |

PRO keeps the feature set that justifies it — unlimited URL/hints, advanced
privacy, showcase, reservation pro, birthday advanced, santa advanced, higher
limits — all already feature-gated, none touched by this experiment.

## 3. Mechanism

```
Mini App on bootstrap (LAUNCH step, §7)        useExperiment(tgFetch, 'growth-first-limits')
  → GET /tg/experiments/growth-first-limits    getExperimentAssignment  ← WRITES the sticky row + experiment.assigned
                                                                            (enrolment + exposure happen ONLY here)

every limit check / GET /tg/me/plan            getUserEntitlement
  → resolveGrowthFirstVariant(userId)          peekExperimentVariant     ← READ-ONLY: reads the row, never writes
  → growth-first FREE plan iff treatment
```

- **Experiment key:** `growth-first-limits`.
- **Env flags** (in `/opt/wishlist/.env`, name = key upcased, `-`→`_`):
  `EXP_GROWTH_FIRST_LIMITS_ENABLED`, `EXP_GROWTH_FIRST_LIMITS_ROLLOUT`.
  Unset → disabled → everyone `control`. **Fails closed.**
- **Read-only resolution.** The entitlement resolver reads the variant via
  `peekExperimentVariant` — it **never enrolls a user and never emits an
  exposure event.** This is the critical safety property: schedulers
  (`birthday-reminders`, `lifecycle`, `billing`) and bot callbacks resolve
  entitlements too; if reading limits enrolled users, a cron would pollute the
  cohort and hand growth-first limits to people who never opened the app.
  Enrolment + exposure stay with the user-initiated
  `GET /tg/experiments/:key` (the standard `useExperiment` flow).
- **Sticky & deterministic.** Variant is `sha256('exp::growth-first-limits::' +
  userId)` vs rollout, persisted once. Same user → same variant forever;
  monotonic in rollout (raising it only ever moves `control → treatment`).
- **Holdout.** The global 5% holdout is always `control` — the clean,
  never-touched revenue baseline.
- **When disabled (the default), the resolver does ZERO extra DB work** —
  `peekExperimentVariant` short-circuits before touching the ledger. No cost
  until launch.

### Turning it on (at launch, after §7 wiring)

```sh
# /opt/wishlist/.env
EXP_GROWTH_FIRST_LIMITS_ENABLED=true
EXP_GROWTH_FIRST_LIMITS_ROLLOUT=50      # start ≤50; ramp, never start at 100
```
```sh
ssh vultr 'cd /opt/wishlist && docker compose up -d --force-recreate api'
```
> `--force-recreate` because compose only re-reads `.env` at `up` time, not on
> `restart` (see `feedback_docker_compose_recreate`).

### Kill switch (incident)

Set `EXP_GROWTH_FIRST_LIMITS_ENABLED=false` and recreate `api`. Every user —
including already-assigned `treatment` — drops to production limits on the next
call. Assignment rows stay for audit but go inert.

---

## 4. Decide ROLLOUT before traffic

Assignment is **sticky**: a user exposed during a `ROLLOUT=0` window is pinned
to `control` forever. Enroll at the target split (start at 50, ramp during a
quiet period), and only ever **raise** rollout. Lowering it un-assigns nobody
and just skews the new-user split — avoid mid-measurement.

---

## 5. Guardrails

Five metrics. **Activation / share / K-factor are the *upside* we expect to
win; PRO conversion / ARPPU are the *guardrails* we must not break.** The ship
decision is the trade between them (§6).

| # | Metric | What it answers | Type | Direction |
|---|--------|-----------------|------|-----------|
| G1 | **PRO conversion** | Does a fatter FREE tier stop people upgrading? | **Guard** | treatment must not fall > **10% relative** vs control |
| G2 | **ARPPU** (+ ARPU) | Revenue per paying user; and the bottom line, revenue per *assigned* user | **Guard** | ARPU (per-assigned) must not fall > **5% relative** |
| G3 | **Activation** | Do more new users reach the aha (first wish in a list)? | Primary (win) | expect **up**; flat is a yellow flag |
| G4 | **Share rate** | Do more users share a list/selection? | Primary (win) | expect **up** |
| G5 | **K-factor** | Does each user bring more new users (virality)? | Primary (win) | expect **up**; must not fall |

Definitions:

- **G1 PRO conversion** — of users assigned **while FREE**, the share who start
  a PRO subscription after assignment. The headline risk metric.
- **G2 ARPPU** — `Σ revenue / distinct paying users`, per variant. Pair with
  **ARPU = `Σ revenue / assigned users`**: ARPPU can hold steady while ARPU
  drops (fewer payers, same basket) — **ARPU is the true bottom line.**
- **G3 Activation** — assigned users who create a first wish (`wish.created`)
  and/or a wishlist (`wishlist.created`) after assignment.
- **G4 Share rate** — assigned users who generate a share token
  (`share.token_generated`) or complete a native share (`wishlist.shared`)
  after assignment.
- **G5 K-factor** — new qualified invitees produced per assigned user. Proxy:
  `referral.share_completed` (invites out) → `referral.qualified` (invitees in).

---

## 6. Readout SQL (self-check #4)

Run on prod:
```sh
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "<query>"'
```

`ExperimentAssignment` is **permanent**; `AnalyticsEvent` is pruned at **90
days**; `Subscription` / `PaymentEvent` / `Purchase` are **permanent**. So
**revenue/conversion readouts join the durable billing tables** (good for any
horizon); activation/share/K-factor join `AnalyticsEvent` (measure within 90
days). Every readout counts outcomes **after** assignment (`>= ea."createdAt"`)
and excludes the holdout unless stated.

### 6.0 Enrolment sanity — who got what

```sql
SELECT variant, holdout, COUNT(*) AS users
FROM "ExperimentAssignment"
WHERE "experimentKey" = 'growth-first-limits'
GROUP BY variant, holdout
ORDER BY holdout, variant;
```
Expect treatment ≈ rollout × 95%, control ≈ (1−rollout) × 95%, holdout ≈ 5%.

### 6.1 G1 — PRO conversion (durable; never-paid-before cohort)

"Conversion" = of users who had **never** paid for PRO before assignment, the
share who make their **first** successful PRO payment after assignment. Both
sides use `PaymentEvent` (one row per charge, each with its own `createdAt`)
rather than `Subscription.createdAt` — under `@@unique([userId, planCode])` that
column is the *first-ever* PRO date and never advances, so a lapse→re-subscribe
after assignment would be missed.

```sql
SELECT ea.variant,
       COUNT(DISTINCT ea."userId")                                       AS assigned_never_paid,
       COUNT(DISTINCT pe."userId")                                       AS converted,
       ROUND(100.0 * COUNT(DISTINCT pe."userId")
             / NULLIF(COUNT(DISTINCT ea."userId"), 0), 2)                AS conversion_pct
FROM "ExperimentAssignment" ea
-- Denominator = users with NO successful subscription payment BEFORE assignment
-- (the population that can actually convert to first-time paid PRO).
LEFT JOIN LATERAL (
  SELECT 1 FROM "PaymentEvent" pre
  WHERE pre."userId" = ea."userId"
    AND pre."eventType" IN ('payment_success', 'payment_success_yearly', 'payment_success_lifetime')
    AND pre."createdAt" < ea."createdAt"
  LIMIT 1
) paid_before ON true
-- Numerator = a successful subscription payment AFTER assignment.
LEFT JOIN "PaymentEvent" pe
       ON pe."userId" = ea."userId"
      AND pe."eventType" IN ('payment_success', 'payment_success_yearly', 'payment_success_lifetime')
      AND pe."createdAt" >= ea."createdAt"
WHERE ea."experimentKey" = 'growth-first-limits'
  AND ea.holdout = false
  AND paid_before IS NULL
GROUP BY ea.variant;
```
**Guard:** `treatment.conversion_pct` ≥ 0.90 × `control.conversion_pct`.
> Minor dilution: promo-PRO / godMode users are entitled without a payment, so
> they sit in the never-paid denominator and never "convert". Small cohort; for
> precision add `AND NOT EXISTS (SELECT 1 FROM "PromoRedemption" pr WHERE pr."userId" = ea."userId" AND pr.status = 'ACTIVE')`.

### 6.2 G2 — ARPPU and ARPU (durable revenue: subscriptions + add-ons, XTR)

> Revenue sources are kept **disjoint** to avoid double-counting (verified
> against the payment-write paths in `apps/bot/src/payments.ts` +
> `apps/api/src/routes/billing.routes.ts`): **subscription** revenue from
> `PaymentEvent` filtered to the successful-charge eventTypes (the canonical
> paid-set used in `apps/bot/src/analytics.ts`); **add-on** revenue from
> `Purchase` only. An add-on sale writes **both** a `Purchase` row AND a
> `PaymentEvent` (`eventType='addon_payment_success'`), so counting add-ons from
> `PaymentEvent` too would double them. Invoice-intent rows (`invoice_created`,
> `addon_invoice_created`, `gift_notes_invoice_created`) carry a positive
> `totalAmount` but mean **no money received** — the eventType filter drops them.
> One further real-money eventType, `payment_success_post_lifetime` (a duplicate
> charge after a user already owns lifetime PRO — audited, not refunded), is
> deliberately **excluded**: it occurs only for existing lifetime owners, a
> cohort a FREE-tier experiment cannot influence, so it is variant-independent
> and would add only symmetric absolute revenue to both arms (no effect on the
> relative guard). Add it to the filter only if you want absolute revenue totals.

```sql
WITH rev AS (
  -- subscription revenue: successful subscription charges only
  SELECT "userId", "totalAmount"::numeric AS xtr, "createdAt"
  FROM "PaymentEvent"
  WHERE "eventType" IN ('payment_success', 'payment_success_yearly', 'payment_success_lifetime')
  UNION ALL
  -- add-on revenue: from Purchase only (its addon_payment_success PaymentEvent
  -- is intentionally excluded above so add-ons are counted exactly once)
  SELECT "userId", "starsPrice"::numeric AS xtr, "createdAt"
  FROM "Purchase" WHERE status = 'completed'
)
SELECT ea.variant,
       COUNT(DISTINCT ea."userId")                                  AS assigned,
       COUNT(DISTINCT r."userId")                                   AS payers,
       COALESCE(SUM(r.xtr), 0)                                      AS revenue_xtr,
       ROUND(COALESCE(SUM(r.xtr),0) / NULLIF(COUNT(DISTINCT r."userId"),0), 1) AS arppu_xtr,
       ROUND(COALESCE(SUM(r.xtr),0) / NULLIF(COUNT(DISTINCT ea."userId"),0), 2) AS arpu_xtr
FROM "ExperimentAssignment" ea
LEFT JOIN rev r ON r."userId" = ea."userId" AND r."createdAt" >= ea."createdAt"
WHERE ea."experimentKey" = 'growth-first-limits'
  AND ea.holdout = false
GROUP BY ea.variant;
```
**Guard:** `treatment.arpu_xtr` ≥ 0.95 × `control.arpu_xtr` (ARPU is the bottom
line; report ARPPU alongside to diagnose *why* it moved).

### 6.3 G3 — Activation (AnalyticsEvent, ≤90-day window)

```sql
SELECT ea.variant,
       COUNT(DISTINCT ea."userId")                                  AS assigned,
       COUNT(DISTINCT ae."userId")                                  AS activated,
       ROUND(100.0 * COUNT(DISTINCT ae."userId")
             / NULLIF(COUNT(DISTINCT ea."userId"),0), 2)            AS activation_pct
FROM "ExperimentAssignment" ea
LEFT JOIN "AnalyticsEvent" ae
       ON ae."userId" = ea."userId"
      AND ae.event = 'wish.created'                 -- first-item aha; swap for 'wishlist.created'
      AND ae."createdAt" >= ea."createdAt"
WHERE ea."experimentKey" = 'growth-first-limits'
  AND ea.holdout = false
GROUP BY ea.variant;
```
**Expect:** treatment ≥ control (this is a win metric).

### 6.4 G4 — Share rate (AnalyticsEvent, ≤90 days)

```sql
SELECT ea.variant,
       COUNT(DISTINCT ea."userId")                                  AS assigned,
       COUNT(DISTINCT ae."userId")                                  AS sharers,
       ROUND(100.0 * COUNT(DISTINCT ae."userId")
             / NULLIF(COUNT(DISTINCT ea."userId"),0), 2)            AS share_pct
FROM "ExperimentAssignment" ea
LEFT JOIN "AnalyticsEvent" ae
       ON ae."userId" = ea."userId"
      AND ae.event IN ('share.token_generated', 'wishlist.shared')
      AND ae."createdAt" >= ea."createdAt"
WHERE ea."experimentKey" = 'growth-first-limits'
  AND ea.holdout = false
GROUP BY ea.variant;
```

### 6.5 G5 — K-factor proxy (AnalyticsEvent, ≤90 days)

**Event keying matters here** (verified against
[`services/referral-hooks.ts`](../../apps/api/src/services/referral-hooks.ts)):
`referral.share_completed` is **inviter-keyed** (`userId` = the sharer), but
`referral.qualified` is **invitee-keyed** (`userId` = the invitee who just
qualified; the inviter is carried in `props.inviterUserId`). To measure
"qualified invitees produced **per assigned inviter**", join invites by `userId`
and qualifications by `props.inviterUserId` — joining both on `userId` would
mis-count (it would credit a qualification to the *invitee's* assignment row).

```sql
SELECT ea.variant,
       COUNT(DISTINCT ea."userId")                                            AS assigned,
       COUNT(*) FILTER (WHERE ae.event = 'referral.share_completed')          AS invites_out,
       COUNT(*) FILTER (WHERE ae.event = 'referral.qualified')                AS invitees_qualified,
       ROUND(1.0 * COUNT(*) FILTER (WHERE ae.event = 'referral.qualified')
             / NULLIF(COUNT(DISTINCT ea."userId"),0), 4)                      AS k_factor_proxy
FROM "ExperimentAssignment" ea
LEFT JOIN "AnalyticsEvent" ae
       ON ae."createdAt" >= ea."createdAt"
      AND (
            -- invites the assigned user SENT (inviter-keyed)
            (ae.event = 'referral.share_completed' AND ae."userId" = ea."userId")
            -- invitees who QUALIFIED, attributed to the assigned inviter
            -- (qualified is invitee-keyed; the inviter is in props.inviterUserId)
        OR  (ae.event = 'referral.qualified' AND ae.props->>'inviterUserId' = ea."userId")
          )
WHERE ea."experimentKey" = 'growth-first-limits'
  AND ea.holdout = false
GROUP BY ea.variant;
```
> `k_factor_proxy` = qualified invitees attributed to the cohort ÷ cohort size.
> A *true* K-factor would also weight by the invitees' own downstream activation;
> this proxy is sufficient for the treatment-vs-control directional read the
> guardrail needs.

To add the holdout as a third arm in any readout, drop `AND ea.holdout = false`
and add `holdout` to `GROUP BY`.

---

## 7. Decision framework

Run ≥ **2–3 weeks** at the chosen rollout, and only read once each arm has a
**meaningful payer count** (conversion is the low-frequency metric — don't call
it on a few hundred users per arm).

- **SHIP (ramp rollout):** G1 within guard **and** G2 ARPU within guard **and**
  ≥1 of G3/G4/G5 clearly up. Ramp 50 → 75 → 100, re-reading guards at each step.
- **ITERATE:** upside (G3–G5) is up but G1/G2 just outside guard → trim the
  generosity (e.g. items 30 → 25, subscriptions 5 → 3) and re-run, rather than
  kill outright.
- **KILL (`ENABLED=false`):** G2 ARPU drop > guard with no offsetting virality,
  or any abrupt revenue cliff. This is the financial-roulette tripwire from §0.

---

## 8. Launch wiring checklist (everything deferred from Phase-1)

When promoting from prepared → live, in order:

1. **Enrolment hook (required — nothing happens without it).** Add
   `useExperiment(tgFetch, 'growth-first-limits')` to the Mini App bootstrap so
   app-open writes the sticky assignment + fires `experiment.assigned`. The
   server resolver only *reads* assignments; with no hook, no row is ever
   written and every user stays `control` even with the flag on.
2. **Import quota lever (§2b).** Thread a per-user resolved limit through
   `resolveFreeImports` / `getImportAllowance` / `consumeImportCredit`
   (`services/import-credits.ts`) + the `import` / `internal` routes, defaulting
   to `FREE_IMPORT_QUOTA_PER_MONTH` so production stays byte-identical. Display
   (`/tg/me/plan` `freeImportsLimit`) must move in lockstep with enforcement.
3. **Hint quota lever (§2b).** Same for `resolveFreeHints` / `getHintAllowance`
   / `getFreeHintsState` / `consumeHintCharge` (`services/hint-credits.ts`) + the
   `hints` / `internal` routes (the charge tx inlines the cap under an advisory
   lock — thread the resolved limit there too).
4. **Curated selection lever (§2b).** New FREE monthly counter +
   change the hard PRO gate in
   [`wishlists.routes.ts`](../../apps/api/src/routes/wishlists.routes.ts)
   (`POST /tg/wishlists/:id/selections`) to allow FREE up to the resolved
   `freeCuratedSelectionsPerMonth` under `treatment`.
5. **Billing downgrade slice — GATING, data-loss risk.** The billing scheduler
   (`schedulers/billing.ts` ~L169/179/186) slices writable wishlists/items at the
   **literal** `PLANS.FREE.wishlists` / `.items`, not the per-user effective
   limit. Once the flag is ON, a lapsing `treatment` FREE user who created
   wishlist #3 or items 21–30 would have that real content **archived** at the
   production `2`/`20`. Harmless while disabled (a FREE user never enters the
   grace/downgrade path), but this MUST be made experiment-aware **before**
   enabling, with its own regression test (item 6) — it is the single
   highest-blast-radius launch dependency.
6. **Tests for each wired lever** — happy + error path, per the testing rules —
   including the §8.5 billing-slice regression test (lapsing `treatment` user
   keeps wishlist #3 / items 21–30).

Until then: only the **plan-limit levers (§2a)** vary under `treatment`, and
they do so consistently across display and enforcement.

---

## 9. Self-check status

| Self-check | Where verified |
|---|---|
| #1 Variant A/B return different limits | `limits-experiment.test.ts` (Variant B vs `PLANS.FREE`), `entitlement.test.ts` (resolver swap) |
| #2 Existing users outside the experiment unaffected | `entitlement.test.ts` + `experiments.service.test.ts` — disabled / control / holdout / unenrolled → production; kill switch overrides persisted rows |
| #3 Entitlement resolver deterministic | `experiments.service.test.ts` (`assignVariant`, `peekExperimentVariant`), `limits-experiment.test.ts`, `entitlement.test.ts` (same user → same plan) |
| #4 Readout SQL ready | §6 above |

## 10. File map

- [`apps/api/src/services/limits-experiment.ts`](../../apps/api/src/services/limits-experiment.ts) — Variant B values + read-only resolver (single source of truth)
- [`apps/api/src/services/entitlement.ts`](../../apps/api/src/services/entitlement.ts) — `getUserEntitlement` consumes the variant; `PlanLimits` type
- [`apps/api/src/services/experiments.service.ts`](../../apps/api/src/services/experiments.service.ts) — `peekExperimentVariant` (read-only primitive)
- Tests: `limits-experiment.test.ts`, `entitlement.test.ts`, `experiments.service.test.ts`
- Infra reference: [`docs/research/experiments/README.md`](experiments/README.md)
