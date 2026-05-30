# E23 — Santa pre-season teaser DM

**Experiment key:** `santa-preseason-dm`
**Env flags:** `EXP_SANTA_PRESEASON_DM_ENABLED` / `EXP_SANTA_PRESEASON_DM_ROLLOUT`
**Status:** shipped **dormant** (flag OFF) — flip near Nov 1.
**Primary metric:** `santa.campaign_created` rate, treatment vs control.
**Success:** **+30% Santa campaigns vs control** over the season.

A one-shot teaser DM sent around **Nov 1** to a segmented, opt-out-respecting
audience, priming them to create a Secret Santa campaign once the season opens
(**Nov 15**). Built on the Phase-0 A/B infrastructure
([README.md](./README.md)) — treatment receives the DM, control is tracked but
not messaged, so the lift is measurable.

> This is a **seasonal** experiment. The whole thing is inert until Nov 1 *and*
> the flag is on. Today it changes nothing in prod.

---

## Audience (segments)

Union of three segments (a user in any one qualifies), minus marketing
opt-outs, minus anyone already touched this season:

| Segment | Definition |
|---|---|
| `past_santa` | Has a `SantaParticipant` row or owns a `SantaCampaign` |
| `active_owner`| Seen in the last 90 days **and** owns a live REGULAR wishlist with ≥1 `AVAILABLE`/`RESERVED` item |
| `social` | Has a wishlist/profile subscription, or organised/joined a group gift |

Marketing opt-out is **null-safe**: `NOT(profile.notifyMarketing = false)`. Users
with no `UserProfile` row (default marketing "on") are **included**; only PRO
users who explicitly turned marketing off are excluded. (Notification opt-out is
PRO-only — FREE users always have `notifyMarketing = true`.)

Preview the live audience without sending — the **dry-run** (self-check #5):

```sh
ssh vultr 'docker exec wishlist-prod-api-1 node /app/apps/api/dist/scripts/santa-preseason-dryrun.js --season 2026'
# → eligible total, per-segment breakdown (past_santa / social / active_owner), a sample of userIds
```

---

## How it works

```
hourly tick → maybeRunSeasonalEvents (services/santa-season.ts)
  └─ if EXP_…_ENABLED && Nov 1–14 UTC:
       runPreseasonWave (services/santa-preseason.ts)   ← segments, A/B, phased send, kill-switch
       (on Nov 1) tombstone the legacy PROMO broadcast   ← supersede, no double-send
```

- **Supersede.** When enabled, E23 **owns** Nov 1 and suppresses the legacy
  `sendSeasonalBroadcast('PROMO')` blast (it writes a `SantaSeasonalBroadcastLog`
  PROMO tombstone on Nov 1 so the legacy path treats it as already-sent). When
  **disabled**, the legacy PROMO fires as before — no Nov-1 regression.
- **One DM per user.** `SantaPreseasonTouch @@unique([userId, seasonYear])` is
  the dedup guard (self-check #2). Control users get a `variant='control'`,
  `stopReason='control'` row and are never messaged (self-check #3).
- **Phased wave (why not a single blast).** The teaser is paced over the
  Nov 1–14 window — a **canary** of 500 sends on the first sending day, then up
  to 2000/day — with a 6-hour settle window before a sent user counts toward the
  mute rate. This is what gives the kill-switch teeth: a single blast would
  finish before any mute signal landed.
- **>15% mute kill-switch (self-check #4).** Each tick, if ≥200 *delivered*
  treatment DMs have settled (sent ≥6h ago) and >15% of them were muted, the
  wave latches `stopped` and pings the admin. Counted from `SantaPreseasonTouch`
  directly — race-free across the API + bot processes (no denormalized counters).
- **Events.** `santa_preseason.dm_sent` (server, on delivery),
  `santa_preseason.dm_clicked` (client, on deep-link land),
  `santa_preseason.muted` (bot callback), `santa.campaign_created` (server, the
  success metric), plus the standard `experiment.assigned` exposure.

---

## Turning it on (near Nov 1)

```sh
# /opt/wishlist/.env on prod
EXP_SANTA_PRESEASON_DM_ENABLED=true
EXP_SANTA_PRESEASON_DM_ROLLOUT=85      # ~15% control (+ the global 5% holdout)
```

```sh
ssh vultr 'cd /opt/wishlist && docker compose up -d api'   # no rebuild; env picked up at `up`
```

**Recommended split:** `ROLLOUT=85`. A teaser is generally positive, so most
users should get it; ~15% control (plus the global 5% holdout) is enough to
measure the +30% lift. Decide the split **before** Nov 1 — assignment is sticky,
so users assigned during a `ROLLOUT=0` window are pinned to control forever
([README.md](./README.md#rules--caveats)).

**Kill switch (incident):** `EXP_SANTA_PRESEASON_DM_ENABLED=false` + recreate the
API container. The wave stops dispatching immediately (and the in-band >15%-mute
kill-switch is automatic). The global Santa kill-switch (`SantaGlobalConfig.santaEnabled=false`)
also disables it.

---

## Reading results

Run on the prod DB: `ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "<query>"'`

**Primary — did treatment beat control by ≥30%** (campaign-creation rate,
counting only campaigns created *after* assignment):

```sql
SELECT ea.variant,
       COUNT(DISTINCT ea."userId")                                          AS assigned,
       COUNT(DISTINCT ae."userId")                                          AS created_campaign,
       ROUND(100.0 * COUNT(DISTINCT ae."userId")
             / NULLIF(COUNT(DISTINCT ea."userId"), 0), 2)                   AS pct
FROM "ExperimentAssignment" ea
LEFT JOIN "AnalyticsEvent" ae
       ON ae."userId" = ea."userId"
      AND ae.event = 'santa.campaign_created'
      AND ae."createdAt" >= ea."createdAt"
WHERE ea."experimentKey" = 'santa-preseason-dm'
  AND ea.holdout = false
GROUP BY ea.variant;
-- success = treatment.pct / control.pct - 1 >= 0.30
```

> **TTL note.** `AnalyticsEvent` is pruned after 90 days; the season runs Nov→Feb
> (~107 days). Snapshot the campaign-creation counts before the Nov events age
> out, or measure off `SantaCampaign.createdAt` joined to the assignment ledger
> (campaigns are durable):
>
> ```sql
> SELECT ea.variant, COUNT(DISTINCT ea."userId") AS assigned,
>        COUNT(DISTINCT sc."ownerId") AS owners_created
> FROM "ExperimentAssignment" ea
> LEFT JOIN "SantaCampaign" sc
>        ON sc."ownerId" = ea."userId" AND sc."createdAt" >= ea."createdAt"
> WHERE ea."experimentKey" = 'santa-preseason-dm' AND ea.holdout = false
> GROUP BY ea.variant;
> ```

**Kill-switch / delivery health** — the settled mute rate (the >15% trigger):

```sql
SELECT segment,
       COUNT(*) FILTER (WHERE delivered)                                AS delivered,
       COUNT(*) FILTER (WHERE delivered AND "mutedAt" IS NOT NULL)      AS muted,
       ROUND(100.0 * COUNT(*) FILTER (WHERE delivered AND "mutedAt" IS NOT NULL)
             / NULLIF(COUNT(*) FILTER (WHERE delivered), 0), 1)         AS mute_pct
FROM "SantaPreseasonTouch"
WHERE "seasonYear" = 2026 AND variant = 'treatment'
GROUP BY ROLLUP (segment);

SELECT * FROM "SantaPreseasonBroadcast" WHERE "seasonYear" = 2026;   -- running | completed | stopped
```

**Teaser CTR** — `dm_clicked` over `dm_sent` (joined on userId+seasonYear):

```sql
SELECT
  (SELECT COUNT(*) FROM "AnalyticsEvent" WHERE event='santa_preseason.dm_sent'
     AND (props->>'seasonYear')::int = 2026)                                AS sent,
  (SELECT COUNT(DISTINCT "userId") FROM "AnalyticsEvent"
     WHERE event='santa_preseason.dm_clicked' AND (props->>'seasonYear')::int = 2026) AS clicked;
```

---

## Caveats

- **Rollout ≠ pacing.** `ROLLOUT` governs the treatment/control split only. Send
  pace is the canary/daily-cap (`services/santa-preseason.ts`), independent of
  rollout.
- **Mid-send crash is lossy by design.** A treatment user whose touch is created
  but whose send crashes before the status write is *not* retried (the
  dedup-by-existence rule excludes them). Transient Telegram failures (429/5xx)
  *are* retried — the touch is deleted so the next tick re-surfaces the user.
  Acceptable: the >15%-mute tolerance already assumes a lossy channel.
- **CTA lands on the Santa hub, not create.** On Nov 1 the season isn't open
  (`canCreate=false` until Nov 15), so the copy is "get ready", and the deep
  link (`spsn_<seasonYear>`) routes to `santa-hub`.
