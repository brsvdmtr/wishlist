# Experiments — A/B infrastructure

Phase 0 of the [experiment backlog](../06-experiment-backlog.md): the minimal,
shared machinery for running A/B experiments. Without it every experiment is
ad-hoc ("we changed something, then argue in chat about whether it worked").

This is **infrastructure only** — it ships no experiments. It gives you a
`useExperiment` hook, a server-side sticky bucket, env-flag controls, and a
durable assignment ledger you can query.

## How it works

```
useExperiment(tgFetch, key)            apps/web/app/miniapp/lib/experiments.ts
  → GET /tg/experiments/:key           apps/api/src/routes/experiments.routes.ts
  → getExperimentAssignment(...)       apps/api/src/services/experiments.service.ts
  → ExperimentAssignment row + experiment.assigned event
```

- **Sticky bucket.** A user's variant is `sha256(key + userId)` compared to the
  rollout %. The same `userId` always lands in the same bucket — deterministic,
  no per-call randomness, stable across restarts.
- **First exposure persists.** The first time a user hits an experiment, an
  `ExperimentAssignment` row is written and the variant is **pinned for life**.
  Read-through: later calls return the stored variant, so it never moves when
  you change `ROLLOUT` afterwards.
- **Two variants:** `control` and `treatment`. (Multi-variant is a future
  extension — not in Phase 0.)
- **Holdout.** A fixed **5%** of users (global, `sha256("holdout" + userId)`)
  are held out of *every* experiment — always `control`. They are the clean
  baseline cohort.
- **`experiment.assigned`** fires exactly once per `(user, experiment)` — the
  `(userId, experimentKey)` unique index is the dedup guard, even under
  concurrent requests.
- **Fail-safe.** The hook returns `control` until the server answers and on any
  error. An experiment that is misconfigured or unreachable degrades to current
  behaviour.

## Creating an experiment

### 1. Pick a key

Lowercase kebab-case, 2-49 chars: `new-onboarding`, `paywall-v2`. This is the
identifier you pass to `useExperiment` and the name you query results by.

### 2. Add the env flags

Two variables per experiment, in `/opt/wishlist/.env` on prod. The name is the
key uppercased with hyphens → underscores (`new-onboarding` →
`EXP_NEW_ONBOARDING_*`):

```sh
EXP_NEW_ONBOARDING_ENABLED=true
EXP_NEW_ONBOARDING_ROLLOUT=50
```

Apply by recreating the API container — **no code deploy, no rebuild**:

```sh
ssh vultr 'cd /opt/wishlist && docker compose up -d api'
```

An experiment with no env flags is **disabled** (everyone `control`) — config
fails closed.

### 3. Use the hook in the Mini App

```tsx
import { useExperiment } from '../lib/experiments';

function OnboardingScreen({ tgFetch }: { tgFetch: TgFetch }) {
  const { variant, isReady } = useExperiment(tgFetch, 'new-onboarding');

  if (!isReady) return <OnboardingControl />;       // safe default while loading
  return variant === 'treatment' ? <OnboardingV2 /> : <OnboardingControl />;
}
```

`tgFetch` is the Mini App API client — passed down as a prop exactly like for
every other endpoint. `variant` is `control` until the server answers; gate the
flicker on `isReady` if the two variants differ visually above the fold.

### 4. Add a test

Cover the `control` and `treatment` branches of the component you gated. The
infra itself is already tested (`experiments.service.test.ts`,
`test/integration/experiments.test.ts`, `experiments.test.ts`).

## The two knobs: ENABLED vs ROLLOUT

| Flag                    | Type      | Effect |
|-------------------------|-----------|--------|
| `EXP_<NAME>_ENABLED`    | boolean   | Master switch. `false`/unset → everyone `control`, nothing persisted. Setting it `false` is the **kill switch** — it overrides already-persisted assignments immediately. |
| `EXP_<NAME>_ROLLOUT`    | 0-100     | Treatment share for users assigned **while this value is live**. Does **not** re-bucket users who already have an assignment — they are sticky. |

`ROLLOUT=0` → all `control`; `50` → ~half treatment; `100` → all treatment
(holdout users excluded — always `control`).

## Reading results

Run on the prod database:

```sh
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "<query>"'
```

**Who got what** — from the durable `ExperimentAssignment` ledger (no TTL):

```sql
SELECT variant, holdout, COUNT(*)
FROM "ExperimentAssignment"
WHERE "experimentKey" = 'new-onboarding'
GROUP BY variant, holdout;
```

**Did treatment beat control** — join the assignment ledger to the outcome
event you care about, by `userId`, counting only outcomes *after* assignment:

```sql
SELECT ea.variant,
       COUNT(DISTINCT ea."userId")                                   AS assigned,
       COUNT(DISTINCT ae."userId")                                   AS converted,
       ROUND(100.0 * COUNT(DISTINCT ae."userId")
             / NULLIF(COUNT(DISTINCT ea."userId"), 0), 1)            AS pct
FROM "ExperimentAssignment" ea
LEFT JOIN "AnalyticsEvent" ae
       ON ae."userId" = ea."userId"
      AND ae.event = 'wishlist.created'          -- the outcome being measured
      AND ae."createdAt" >= ea."createdAt"
WHERE ea."experimentKey" = 'new-onboarding'
  AND ea.holdout = false
GROUP BY ea.variant;
```

To include the holdout cohort as a third arm, drop `AND ea.holdout = false` and
group by `ea.holdout` too.

> **TTL note.** `AnalyticsEvent` is pruned after 90 days; `ExperimentAssignment`
> is permanent. Measure outcomes within the 90-day window, or roll them into a
> durable table first.

The exposure event itself is also queryable (`experiment.assigned`, props carry
`key` / `variant` / `holdout`), but the `ExperimentAssignment` table is the
authoritative, untruncated source — prefer it.

## Turning an experiment off

- **Hard kill (incident):** set `EXP_<NAME>_ENABLED=false` and recreate the API
  container. Every user — including ones already assigned `treatment` — is
  served `control` on the next call. The assignment rows stay (audit) but go
  inert.
- **Stop new enrolment, keep current users:** set `EXP_<NAME>_ROLLOUT=0`.
  Already-assigned users keep their sticky variant; no new user enters
  `treatment`.
- **Finished — ship the winner:** delete both env flags, replace the
  `useExperiment` branch in the component with the winning variant, and remove
  the loser's code.

## Rules & caveats

- **Decide `ROLLOUT` before the experiment gets traffic.** Assignment is sticky:
  users exposed during a `ROLLOUT=0` window are pinned to `control` forever.
  Enable at the target split, or ramp during a quiet period.
- **Rollout is monotonic — only raise it.** Raising `ROLLOUT` moves
  not-yet-assigned users one-way `control → treatment`. Lowering it does not
  un-assign anyone, but skews the split of new users — avoid it mid-measurement.
- **Holdout users never see a treatment.** Don't design an experiment that
  needs the holdout 5% — by definition they only ever get `control`.
- **The hook is fail-safe.** Backend down, bad config, slow network → `control`.
  Never put irreversible or destructive behaviour behind `treatment` without a
  `control`-equivalent fallback.
