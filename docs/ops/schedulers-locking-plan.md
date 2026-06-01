# Distributed-Lock Plan for Schedulers

**Status:** PLANNING — code-only on single instance today. Required reading before any horizontal scale-out (`api` replicas > 1).
**Last updated:** 2026-05-27
**Owner:** backend

---

## 1. Why this doc exists

Every scheduler in `apps/api/src/schedulers/` runs via in-process
`setInterval` and assumes **exactly one Node.js process** holds the
cron timers. The API is a single Docker container on a single VPS
today; that assumption holds.

Scale-out scenarios that break this assumption:

- Adding a second `api` replica behind nginx for capacity / HA.
- Blue-green deploys that run both versions briefly.
- A staging replica accidentally pointing at prod `DATABASE_URL`.
- An ops-driven manual `docker run` of a second API container for
  one-off backfill that doesn't disable the scheduler bootstrap.

In any of those, every replica will fire every cron at every cadence
simultaneously. The damage ranges from "wasted DB cycles" (cleanup
jobs) to "every user gets the same Telegram DM N times" (lifecycle,
reservation reminders, birthday DMs).

This document inventories every scheduler, classifies its double-fire
blast radius, and prescribes the locking primitive each one needs
**before** scale-out, not after.

**No code is changed by this document.** Implementation is a separate
PR per the rollout plan in § 4.

---

## 2. Inventory — every in-process timer

The canonical operator reference is [`docs/SCHEDULERS.md`](../SCHEDULERS.md).
That doc covers the **9 scheduler modules** documented at the
P5s-1..10 closure (2026-05-07). Since then three additional schedulers
landed:

- `referral-retention.ts` (2026-05-15 — d7/d30 retention analytics)
- `research-survey-send.ts` (2026-05-20 — research survey invites)
- `daily-activity-rollup.ts` (2026-05-22 — UserDailyActivity rollup)

Plus two timer-bearing modules outside the `schedulers/` folder:

- `apps/api/src/security/cleanupJob.ts` — idempotency-key TTL purge
- `apps/api/src/security/ipThrottle.ts` — in-memory bucket GC
  (in-memory only, intentionally per-replica)

Bot side (`apps/bot/src/index.ts`) has heartbeat + startupCheck timers.

**Total count:** 12 scheduler modules + 2 security timers + 2 bot
timers = **16 timer-bearing modules**, registering **~24 distinct
`setInterval` calls** when broken out per sub-job (e.g. `cleanup.ts`
registers 3 sub-jobs; `billing.ts` registers 4; `santa.ts` registers
4; `reservations.ts` registers 3).

---

## 3. Per-scheduler risk + lock recommendation

Risk classes:

- **HIGH** — double-fire sends user-visible Telegram messages, billing
  state changes with external side effects, or any operation whose
  "second run" can't be made idempotent by a DB unique constraint
  alone. Requires a lock before scale-out.
- **MEDIUM** — double-fire produces wasted DB write/read load OR
  inserts that would hit a unique constraint (P2002 caught by
  application code). Lock is strong nice-to-have; not strictly required
  if you accept duplicate-work overhead.
- **LOW** — double-fire is purely wasted CPU/IO with no user-facing
  effect. Lock is optional.
- **NONE** — per-replica execution is *intentional* (heartbeat,
  in-memory caches). Lock would be wrong.

Lock primitives:

- **PG-advisory** — `pg_try_advisory_lock(hashtext('<scheduler-name>'))`
  inside each tick. Auto-released on session close. Zero new infra.
  See § 4.1 for the helper sketch.
- **PG-row-lock** — `SELECT … FOR UPDATE SKIP LOCKED` on the work-queue
  rows themselves. Already used implicitly by some schedulers via
  `prisma.$transaction` + status flip. Where applicable, beats advisory
  locking because it parallelizes safely (replica A picks half the
  rows, replica B the other half).
- **Redis-distlock** — only if Postgres becomes a contention bottleneck
  (we are nowhere near that) or if we ever want cross-region multi-
  cluster. **Out of scope** for the foreseeable.
- **None** — keep per-replica behavior.

### 3.1 `cleanup.ts` — TTL + archive

| Sub-job | Cadence | Side effect | Idempotent? | Double-fire risk | Lock |
|---|---|---|---|---|---|
| TTL comments cleanup | 60m | `Comment.deleteMany WHERE scheduledDeleteAt <= now` | Yes (delete is idempotent) | LOW (wasted IO; same row touched twice) | PG-advisory `cleanup.comments` |
| Curated selection cleanup | 60m | `CuratedSelection / Subscription / item-link` deletes past TTL | Yes | LOW | PG-advisory `cleanup.curated` |
| Archive purge | 60m | `Item.deleteMany` (up to 100/run) + `deleteUploadFile()` per photo | **Mixed** — file delete is not transactional with DB row delete; double-run could try to delete an already-deleted file (ENOENT, harmless) | LOW | PG-advisory `cleanup.archive` |

**Recommendation:** single advisory lock `cleanup` covering all three
sub-jobs is fine; they were one factory call originally and share a
container.

### 3.2 `billing.ts` — subscription / promo / degradation

| Sub-job | Cadence | Side effect | Idempotent? | Double-fire risk | Lock |
|---|---|---|---|---|---|
| Subscription expiry | 60m | `Subscription.status` ACTIVE/CANCELLED → EXPIRED + triggers PRO-loss flow (`DegradationState.phase = 'GRACE_PERIOD'`) | **Partial** — the flip itself is idempotent at row level, but the `GRACE_PERIOD` start triggers downstream notifications | **MEDIUM** | PG-advisory `billing.subscription_expiry` (REQUIRED) |
| Promo expiry | 60m | `PromoRedemption.status` ACTIVE → EXPIRED + same GRACE_PERIOD trigger | Same as above | MEDIUM | PG-advisory `billing.promo_expiry` |
| Degradation grace → archive | 60m | After 14d, archives newest wishlists/items beyond FREE limits; sets `DegradationState.phase = 'ARCHIVED'`, `purgeAfter = +90d` | The archival is conditional on `phase === 'GRACE_PERIOD'`; double-fire on the same row would no-op the second time (state already advanced) | **MEDIUM** | PG-advisory `billing.degradation_archive` |
| Degradation archive → purge | 60m | After `purgeAfter`, hard-deletes archived data unless user regained PRO | State machine guards against double-execution; **but hard-delete + Telegram "data purged" notification is irrevocable** | **HIGH** if any notification is added in future; **MEDIUM** today | PG-advisory `billing.degradation_purge` (REQUIRED) |

**Recommendation:** one advisory lock per sub-job (4 locks), since the
state machine transitions matter at finer granularity. Or wrap the
whole factory in `billing` lock — both work, finer is safer.

### 3.3 `referral.ts` — expired-attribution sweep

| Cadence | Side effect | Idempotent? | Double-fire risk | Lock |
|---|---|---|---|---|
| 15m | `ReferralAttribution` PENDING_ACTIVATION → REJECTED past `windowDeadlineAt`; emits one aggregated `referral.qualification_timeout` analytics event per run | Status flip is idempotent (row already REJECTED → no-op); **analytics event would be emitted twice (different `expired` counts, no dedup)** | **MEDIUM** — duplicate analytics rows muddy funnel | PG-advisory `referral.sweep` |

**Recommendation:** required before scale-out — analytics integrity
demands it.

### 3.4 `referral-retention.ts` — d7/d30 retention analytics

| Cadence | Side effect | Idempotent? | Double-fire risk | Lock |
|---|---|---|---|---|
| 24h (first tick at +5min from boot) | Emits `referral.invitee_retained_d7` / `_d30` analytics events for eligible invitees | Yes — checks `AnalyticsEvent` for existing event with same `attributionId` in props before emit | LOW | PG-advisory `referral.retention` |

**Recommendation:** advisory lock is nice-to-have. The dedup query
makes correctness safe; lock just saves duplicate query work.

### 3.5 `santa.ts` — 4 independent hourly jobs

| Sub-job | Cadence | Side effect | Idempotent? | Double-fire risk | Lock |
|---|---|---|---|---|---|
| Hint expiry | 60m | `SantaHintRequest.status` PENDING → EXPIRED past `expiresAt` | Yes (state flip) | LOW | PG-advisory `santa.hint_expiry` |
| Deadline missed | 60m | `SantaAssignment.giftStatus` PENDING/BUYING → MISSED_DEADLINE + inserts `SantaNotification` (`dedupeKey: missed:<assignmentId>`) | Yes (`dedupeKey` unique constraint) | LOW-MEDIUM (P2002 caught) | PG-advisory `santa.deadline_missed` |
| Deadline warning | 60m | Same as above with `dedupeKey: warn:<assignmentId>` in 72-96h window | Yes (unique constraint) | LOW-MEDIUM | PG-advisory `santa.deadline_warning` |
| Seasonal events (Nov 1 / Feb 1) | 60m | Broadcast notification + `SantaSeasonalBroadcastLog` row | Yes (unique on `(year, type)`) | LOW (constraint catches) | PG-advisory `santa.seasonal` |

**Recommendation:** all four protected by `dedupeKey` / unique
constraints — DB will catch a double-fire, but it costs a wasted
constraint-violation per attempt. Advisory locks reduce noise.

### 3.6 `reservations.ts` — reservation + smart-res schedulers

| Sub-job | Cadence | Side effect | Idempotent? | Double-fire risk | Lock |
|---|---|---|---|---|---|
| Reservation reminder | 15m | Telegram DM to reserver + `reminderSent` flag flip | **Partial** — flag flips after DM sends; on the second replica seeing `reminderSent=false`, both send the DM, then race to flip the flag | **HIGH** — duplicate user-visible DM | PG-advisory `reservations.reminder` (REQUIRED) OR row-lock via `SELECT … FOR UPDATE SKIP LOCKED` on `ReservationMeta WHERE reminderAt <= now AND reminderSent = false` |
| Smart-res auto-release | 5m | Reverts `Item` to AVAILABLE + `UNRESERVED` event + SYSTEM comment + notifies gifter+owner. Wrapped in `prisma.$transaction`. | Transaction protects against double-flip of item.status, but the **Telegram notifications fire before transaction completes** in current code | **HIGH** — duplicate "your reservation was released" DMs to both parties | PG-advisory `reservations.smart_release` (REQUIRED) |
| Smart-res reminder | 15m | Telegram DM to reserver once | Same race as reservation reminder | **HIGH** | PG-advisory `reservations.smart_reminder` (REQUIRED) |

**Recommendation:** REQUIRED before scale-out. Preferred long-term:
move to `SELECT … FOR UPDATE SKIP LOCKED` on the query that picks
rows — replica A and B can then process disjoint slices in parallel,
no false serialization.

### 3.7 `events.ts` — gift-occasion calendar reminders

| Cadence | Side effect | Idempotent? | Double-fire risk | Lock |
|---|---|---|---|---|
| 5m | Sends Telegram DM + writes `CalendarInboxEntry` + `GiftOccasionReminder.sentAt` flip. For recurring occasions, schedules the next occurrence via `getNextOccurrenceDate` / `computeReminderSchedule`. | **Partial** — `sentAt IS NULL AND scheduledFor <= now` filter races between replicas; both send before either flips `sentAt`. Reschedule logic doubles the calendar (next occurrence scheduled twice). | **HIGH** — duplicate DM + duplicate `CalendarInboxEntry` + drifted recurrence schedule | PG-advisory `events.gift_occasion_reminders` (REQUIRED) |

**Recommendation:** REQUIRED. Same row-lock alternative as reservations.

### 3.8 `lifecycle.ts` — win-back DM (S1–S4)

| Cadence | Side effect | Idempotent? | Double-fire risk | Lock |
|---|---|---|---|---|
| 60m | Telegram DM via `sendLifecycleDM`; writes `LifecycleTouch` row AFTER successful send; tracks `lifecycle_<segment>_touch<N>` analytics. 24-cycle dead-air alarm. | **Partial** — frequency caps + cooldowns read `LifecycleTouch` but row is inserted after send; replica A and B both see "no recent touch" and both send | **HIGH** — duplicate DMs across all segments. User who'd get one S2 wave 2 DM gets two. | PG-advisory `lifecycle.scheduler` (REQUIRED) |

**Recommendation:** REQUIRED. The dead-air counter is module-scope
state and would diverge between replicas; with a lock, the counter
stays on whichever replica holds the lock at the moment.

### 3.9 `pro-renewal.ts` — PRO renewal reminders

| Cadence | Side effect | Idempotent? | Double-fire risk | Lock |
|---|---|---|---|---|
| 60m | Telegram DM for 7d/1d renewal windows; writes synthetic `PaymentEvent` row with `telegramPaymentChargeId = "reminder:<7d|1d>:<subId>:<periodEndISO>"` (unique constraint) | **Yes** — unique constraint on `PaymentEvent.telegramPaymentChargeId` catches double-insert; **but DM sends before insert** | **MEDIUM** — DB catches on second attempt but first DM may still ship twice if both replicas send-then-insert in interleaved order | PG-advisory `pro_renewal.scheduler` |

**Recommendation:** advisory lock is correct. The unique constraint
is belt-and-suspenders but DM-then-insert ordering means a real race
window exists.

### 3.10 `birthday-reminders.ts` — friend + owner birthday DMs

| Cadence | Side effect | Idempotent? | Double-fire risk | Lock |
|---|---|---|---|---|
| 60m + 30s startup kick | Telegram DM + `BirthdayReminderDelivery` row insert; **unique constraint on `(birthdayUserId, recipientUserId, occurrenceKey, reminderKind)`** catches double-insert via P2002 | Yes (quad-key unique constraint) | LOW-MEDIUM — DB catches; same DM-then-insert race as pro-renewal but mitigated by row insert *before* DM send (per inspection of `maybeCreateOwnerDelivery` / `maybeCreateFriendDeliveries`) | PG-advisory `birthday_reminders.scheduler` |

**Recommendation:** advisory lock is nice-to-have. Quad-key constraint
+ insert-before-send semantics give correctness today; lock avoids
constraint-violation log noise at scale.

### 3.11 `research-survey-send.ts` — research survey invites

| Cadence | Side effect | Idempotent? | Double-fire risk | Lock |
|---|---|---|---|---|
| Configured tick + 1 startup tick (gated by `RESEARCH_SURVEY_SEND_ENABLED` env + send-window guard) | Telegram DM with survey invite + `applyOutcome` writes invite status | **Partial** — invite status guards re-send, but DM-then-update window allows double-send across replicas | **HIGH** — duplicate survey invite to same user, plus inflated denominator in survey analytics | PG-advisory `research_survey.send` (REQUIRED) |

**Recommendation:** REQUIRED if `RESEARCH_SURVEY_SEND_ENABLED=true`
at scale-out time. Default is `false`.

### 3.12 `daily-activity-rollup.ts` — UserDailyActivity rollup

| Cadence | Side effect | Idempotent? | Double-fire risk | Lock |
|---|---|---|---|---|
| 60m (re-aggregates last 2 UTC days each tick) | UPSERT into `UserDailyActivity`; aggregator is idempotent by design | Yes (re-running produces same row) | LOW (wasted aggregation CPU) | PG-advisory `daily_activity.rollup` |

**Recommendation:** advisory lock nice-to-have; correctness is safe
without it.

### 3.13 `security/cleanupJob.ts` — idempotency-key TTL purge

| Cadence | Side effect | Idempotent? | Double-fire risk | Lock |
|---|---|---|---|---|
| 60m + 30s startup | `IdempotencyKey.deleteMany WHERE expiresAt < now` | Yes (delete idempotent) | LOW | PG-advisory `security.idempotency_cleanup` |

**Recommendation:** advisory lock nice-to-have. Existing module
comment already notes this: *"If we ever shard the API, gate this
behind a leader-election flag so only one replica deletes (Prisma
deleteMany is safe under contention, just wasteful)."* — see
`apps/api/src/security/cleanupJob.ts` lines 6–10.

### 3.14 `security/ipThrottle.ts` — in-memory bucket GC

| Cadence | Side effect | Lock |
|---|---|---|
| 60s | Drops untouched buckets from in-memory `Map` | **NONE — per-replica execution is intentional.** Each replica has its own throttle state and must GC its own map. |

### 3.15 Bot timers (`apps/bot/src/index.ts`)

| Timer | Cadence | Side effect | Lock |
|---|---|---|---|
| Heartbeat | 60s | Upserts `ServiceHeartbeat['bot']` row | Per-replica is correct IF heartbeat identifies the replica; today `serviceName='bot'` is a single key — adding replicas would have them stomp each other's heartbeat. **Per-replica scheduling but distinct `serviceName` per replica** (e.g. `bot:<hostname>`) when scale-out happens. |
| Startup check | once at boot | Verifies Telegram connectivity | None needed (per-process). |

The bot is currently single-replica by design (Telegram long-polling
can't be sharded trivially — would need to migrate to webhooks first).
Out of scope for this plan, flagged for awareness.

---

## 4. Implementation plan

### 4.1 Lock primitive — `withSchedulerLock` helper

Single helper, lives in `apps/api/src/services/scheduler-lock.ts` (new
module — fits the services layer per `docs/API_ARCHITECTURE_RULES.md`).
Wraps a function in a Postgres advisory lock:

```ts
// SKETCH — not for paste; final API TBD in implementation PR.
import { prisma } from '@wishlist/db';
import { Logger } from 'pino';

export async function withSchedulerLock<T>(
  name: string,
  logger: Logger,
  fn: () => Promise<T>,
): Promise<T | null> {
  // Hash name to a stable bigint for pg_try_advisory_lock.
  // hashtext returns int4 → cast to bigint with namespace prefix to
  // partition our locks from anyone else's (e.g. Prisma's own
  // advisory locks for migrations).
  return prisma.$transaction(async (tx) => {
    const NAMESPACE = 0xC0DE; // 16-bit namespace prefix
    const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(${NAMESPACE}, hashtext(${name})) AS locked
    `;
    if (!locked) {
      logger.debug({ scheduler: name }, 'scheduler_lock_skipped (another replica holds it)');
      return null;
    }
    return fn();
  });
}
```

Why `pg_try_advisory_xact_lock` (transaction-scoped) over the
session-scoped variant:

- **Auto-released on transaction commit/rollback.** No risk of a stuck
  lock if the tick body throws before reaching an unlock call.
- **No leaked locks on connection death.** Session locks survive idle
  connections held by Prisma's pool until the connection is recycled.
- **Trade-off:** the entire tick body runs inside one DB transaction.
  Long-running ticks (lifecycle, birthday-reminders) may hold a tx
  for minutes. Acceptable for schedulers that already wrap their core
  work in `prisma.$transaction`, but for the chatty ones (e.g.
  birthday-reminders processes hundreds of users per tick) we may
  prefer the session-scoped variant + explicit `pg_advisory_unlock`
  in a finally block.

**Decision deferred to implementation PR** — measure tick duration in
prod first; pick xact-scoped where possible, session-scoped where not.

### 4.2 Per-scheduler rollout order

Driven by risk class (§ 3) — the HIGH ones first so scale-out can
land safely incrementally:

| Wave | Schedulers | Rationale |
|---|---|---|
| 1 — must-have before scale-out | `lifecycle.ts`, `reservations.ts` (3 sub-jobs), `events.ts`, `billing.ts` (4 sub-jobs), `research-survey-send.ts` | HIGH risk — duplicate user-visible DMs or duplicate billing state side effects |
| 2 — should-have | `referral.ts`, `pro-renewal.ts`, `birthday-reminders.ts`, `santa.ts` (4 sub-jobs) | MEDIUM risk — DB constraints catch double-fire but reduce noise |
| 3 — nice-to-have | `cleanup.ts` (3 sub-jobs), `referral-retention.ts`, `daily-activity-rollup.ts`, `security/cleanupJob.ts` | LOW risk — pure DB cycles wasted on double-fire |
| Excluded | `security/ipThrottle.ts` GC, bot heartbeat, bot startupCheck | Per-replica is correct |

Each wave is one PR per scheduler module. Per-wave smoke check:

1. Deploy with `WITH_SCHEDULER_LOCK_<NAME>=true` env flag.
2. Watch logs for `scheduler_lock_skipped` events — if a single-replica
   prod sees them, the lock helper is buggy. If none appear in 24h of
   single-replica operation, the wrapper is transparent (correct).
3. Verify no scheduler-specific regressions (cycle-completed logs at
   expected cadence, no error spike).

### 4.3 Row-lock alternative for queue-like schedulers

For `reservations.ts`, `events.ts`, `birthday-reminders.ts` — the
underlying query is "find rows where status flag = ready" + "process
each + flip status". Postgres `SELECT … FOR UPDATE SKIP LOCKED`
parallelizes this safely:

```sql
SELECT * FROM "ReservationMeta"
WHERE "reminderAt" <= NOW() AND "reminderSent" = false AND active
ORDER BY "reminderAt"
FOR UPDATE SKIP LOCKED
LIMIT 50;
```

Replica A picks rows 1-50, replica B picks 51-100 — both work in
parallel, neither double-processes a row. Advisory lock serializes
the *entire scheduler*; row-lock serializes *per row*. The row-lock
approach is preferred when the workload is large and you want to
horizontally split it across replicas; advisory lock is preferred
when serialization is fine (most cases — schedulers don't have huge
backlogs).

**Decision per scheduler in the implementation PR.** Wave 1 candidates
to evaluate row-lock variant: `reservations.ts` (Smart Reservations
auto-release loop), `events.ts` (gift-occasion-reminders), `lifecycle.ts`
(per-user loop).

### 4.4 Observability hooks

Each `withSchedulerLock` call:

- On acquire: `logger.debug({ scheduler: name }, 'scheduler_lock_acquired')`.
- On skip: `logger.debug({ scheduler: name }, 'scheduler_lock_skipped')`
  + analytics event `scheduler.lock_skipped` (props: `{ scheduler }`).
  Skipped events on single-replica prod are a smoke alarm; expected
  >0 on multi-replica.
- On error inside `fn`: existing scheduler error handling continues to
  apply (logged via existing `logger.error` paths).

A separate metrics view in admin dashboard (`/admin/scheduler-health`)
should aggregate `scheduler_lock_skipped` per scheduler per day post-
rollout — empty before scale-out, non-zero after.

### 4.5 Kill switch

`SCHEDULER_LOCKS_DISABLED=true` env disables the helper globally
(short-circuits to "always acquired"). Same pattern as security-layer
kill switches in `apps/api/src/security/` — see `docs/API_SECURITY.md`
§ 9 — gives us a one-edit-no-redeploy escape if the lock helper itself
causes problems in prod.

### 4.6 What scale-out itself requires (out of scope here)

This plan covers ONLY the scheduler locking. Actual horizontal scale-
out also needs:

- nginx upstream block updates / proxy_pass to a load-balanced group.
- API replicas with shared / sticky session handling (already mostly
  stateless — only `lifecycleDeadCycles` is module-scope `let` in
  `lifecycle.ts`; covered by lock above).
- Bot replica strategy — long-polling can't multi-replica without
  webhook migration first (separate planning doc).
- Shared file storage for uploads (today bind-mounted to
  `/opt/wishlist/uploads`; would need S3-equivalent or NFS for HA).
- Postgres connection pool sizing per replica.
- Health-check semantics across multiple endpoints.

These are tracked in a separate "scale-out readiness" doc that does
not yet exist; this lock plan is the first deliverable on that path.

---

## 5. Summary table

| Scheduler module | Sub-jobs | Highest risk class | Required lock kind | Wave |
|---|---|---|---|---|
| `lifecycle.ts` | 1 | HIGH | PG-advisory | 1 |
| `reservations.ts` | 3 | HIGH | PG-advisory or row-lock | 1 |
| `events.ts` | 1 | HIGH | PG-advisory or row-lock | 1 |
| `billing.ts` | 4 | HIGH (purge); MEDIUM (others) | PG-advisory per sub-job | 1 |
| `research-survey-send.ts` | 1 | HIGH | PG-advisory | 1 |
| `referral.ts` | 1 | MEDIUM | PG-advisory | 2 |
| `pro-renewal.ts` | 1 | MEDIUM | PG-advisory | 2 |
| `birthday-reminders.ts` | 1 | LOW-MEDIUM | PG-advisory or row-lock | 2 |
| `santa.ts` | 4 | LOW-MEDIUM | PG-advisory per sub-job | 2 |
| `cleanup.ts` | 3 | LOW | PG-advisory | 3 |
| `referral-retention.ts` | 1 | LOW | PG-advisory | 3 |
| `daily-activity-rollup.ts` | 1 | LOW | PG-advisory | 3 |
| `security/cleanupJob.ts` | 1 | LOW | PG-advisory | 3 |
| `security/ipThrottle.ts` GC | 1 | NONE | None (per-replica) | — |
| Bot heartbeat | 1 | NONE | None (per-replica + serviceName change) | — |
| Bot startup check | 1 | NONE | None (per-process) | — |

**Effort estimate (very rough):**

- Wave 1 (5 modules): ~1 day implementation + 1 day soak.
- Wave 2 (4 modules): ~0.5 day.
- Wave 3 (4 modules): ~0.5 day.
- Lock helper + tests + observability: ~0.5 day.
- **Total before-scale-out work: ~3-4 dev-days.**

---

## 6. Verification — answers to the task's self-checks

1. **Полный список scheduler jobs** — § 2 (count) + § 3.1–§ 3.15 (per
   module) + § 5 (summary). 16 timer-bearing modules; ~24 distinct
   `setInterval` calls when broken out per sub-job. Includes the three
   schedulers added post-SCHEDULERS.md (referral-retention,
   research-survey-send, daily-activity-rollup) and the two security
   timers.
2. **Risk class per scheduler** — every entry in § 3 ends with a
   HIGH/MEDIUM/LOW/NONE classification. Summary in § 5.
3. **Redis vs Postgres advisory lock recommendation** — § 4.1
   (Postgres advisory chosen, Redis explicitly out of scope) plus
   per-scheduler "Lock" column in § 3 tables.
4. **No code changed** — only `docs/ops/schedulers-locking-plan.md`
   created. Confirmed by `git diff`.
