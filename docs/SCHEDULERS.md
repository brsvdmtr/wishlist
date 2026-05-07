# API Schedulers

**Last updated:** 2026-05-07 (post P5s-1..10 — services layer fully closed; scheduler layer unchanged from P5r-6) · **Owner:** backend

Operator reference for the nine scheduler modules under
`apps/api/src/schedulers/`. Each module is a factory invoked exactly once
from `index.ts` (the composition root); cron timers run in-process via
`setInterval` / `setTimeout`. There is no separate cron container.

`index.ts` no longer contains any actual `setInterval` / `setTimeout`
scheduler call (one `setTimeout(r, PAUSE_MS)` Promise sleep helper inside
a route helper is the sole exception). All cron logic lives in modules
listed below.

---

## Quick reference

| Module | Cadence | What | Heartbeat | Headline log |
|---|---|---|---|---|
| `cleanup.ts` | 60 min | TTL comments + curated selections + archive purge | — | `idempotency-cleanup …` (label varies per sub-job) |
| `billing.ts` | 60 min | Subscription / promo / degradation expiry | — | `subscription-expiry job failed`, `pro-renewal-reminder job failed` (error labels — success is silent) |
| `referral.ts` | 15 min | Expired-attribution sweep | — | `[referral] sweep: expired pending attributions` (when `expired > 0`) |
| `santa.ts` | 60 min × 4 jobs | Hint expiry + deadline missed + deadline warning + seasonal events | — | `santa-hints: expired hint requests`, `santa-deadlines: marked assignments as MISSED_DEADLINE`, `santa-deadlines: sent DEADLINE_WARNING to givers` |
| `reservations.ts` | 15 min + 5 min + 15 min | Reservation reminder + smart-res auto-release + smart-res reminder | — | `reservation-reminders: sent reminders`, `smart-res: auto-released`, `smart-res: reminder sent` |
| `events.ts` | 5 min | Gift-occasion calendar reminders | — | `gift-occasion-reminders: sent reminders` |
| `lifecycle.ts` | 60 min | Win-back DM (segments S1–S4) + dead-air alarm | — | `lifecycle_cycle_completed`, `lifecycle_dead_air` (warn at threshold) |
| `pro-renewal.ts` | 60 min | PRO renewal reminders (7d / 1d milestones) | — | `pro-renewal-reminder cycle failed` (error label — success is silent) |
| `birthday-reminders.ts` | 60 min + 30s startup kick | Friend + owner birthday DMs | **`ServiceHeartbeat['birthday_reminders']`** | `birthday_scheduler_completed` (info, every cycle) |

**Heartbeats:** only `birthday_reminders` writes a `ServiceHeartbeat` row;
the bot writes one for itself (long-polling liveness). Other schedulers
have no DB-side heartbeat; observe via log presence + sibling proof-of-life.

**Send-window guards:**
- `birthday-reminders.ts` returns early if MSK hour ∉ [9, 22] — quiet hours.
- All other schedulers run unconditionally.

---

## 1. `cleanup.ts` — TTL + archive

**Cadence:** 60 min (one `setInterval` registers three sub-jobs internally).

**What it does**
- **TTL comments cleanup** — hard-deletes `Comment` rows where
  `scheduledDeleteAt <= now`. Logs `count` if any deleted.
- **Curated selection cleanup** — hard-deletes ended `CuratedSelection`
  rows past their TTL plus any orphaned subscriptions / item links.
- **Archive purge** — finds `Item` rows where `purgeAfter <= now`,
  hard-deletes up to 100 per run; calls `deleteUploadFile()` for each
  associated photo.

**Tables:** `Comment`, `CuratedSelection`, `CuratedSubscription`, `Item`,
upload files via `deleteUploadFile`.

**Deps:** `prisma`, `logger`, `deleteUploadFile`.

**Behaviour:** best-effort; errors logged, never bubble out of the cron
callback. Next 60-minute cycle re-attempts pending work.

---

## 2. `billing.ts` — subscription / promo / degradation expiry

**Cadence:** 60 min.

**What it does**
- **Subscription expiry** — flips `Subscription` rows past
  `currentPeriodEnd` from `ACTIVE`/`CANCELLED` → `EXPIRED`. Triggers
  PRO-loss flow (degradation `GRACE_PERIOD` start) for affected users.
- **Promo expiry** — flips `PromoRedemption` rows past `expiresAt` from
  `ACTIVE` → `EXPIRED`. If the user has no other active PRO source,
  starts `GRACE_PERIOD`.
- **Degradation grace → archive** — after 14-day grace, archives
  newest wishlists beyond FREE limit (2) and items beyond per-wishlist
  FREE limit (20). Sets `DegradationState.phase = 'ARCHIVED'`,
  `purgeAfter = +90d`. If the user regained PRO, resets to `NONE`.
- **Degradation archive → purge** — after `purgeAfter`, hard-deletes
  archived data unless the user regained PRO (then restores it).

**Tables:** `Subscription`, `PromoRedemption`, `DegradationState`,
`Wishlist`, `Item`, `User`, `UserAddOn` (for slot capacity check).

**Deps:** `prisma`, `logger`, `getUserEntitlement`, `PLANS`.

**Headline error labels:** `subscription-expiry job failed`,
`degradation-grace job failed`, `degradation-archive job failed`,
`degradation-purge job failed`. Success path is silent (logs only when
work happened).

---

## 3. `referral.ts` — expired-attribution sweep

**Cadence:** 15 min.

**What it does**
- Drains `PENDING_ACTIVATION` rows past `windowDeadlineAt` →
  `REJECTED` with reason `QUALIFICATION_TIMEOUT`. Up to
  `SWEEP_BATCH_SIZE × SWEEP_MAX_ITERATIONS` per run (~configurable in
  `packages/db/referral.ts`).
- Emits one aggregated analytics event per run if `expired > 0`:
  `referral.qualification_timeout` with `props: { expired, source: 'cron' }`.

**Tables:** `ReferralAttribution`.

**Deps:** `prisma`, `logger`, `trackAnalyticsEvent`, `sweepExpiredPendingAttributions`.

**Headline log:** `[referral] sweep: expired pending attributions`
(info, only when `expired > 0`). Error label: `[referral] sweep failed`.

---

## 4. `santa.ts` — hint expiry / deadline missed / deadline warning / seasonal events

**Cadence:** four independent 60-min `setInterval` blocks.

**What each block does**
1. **Hint expiry** — flips `SantaHintRequest.status = 'PENDING'` past
   `expiresAt` to `EXPIRED`.
2. **Deadline missed** — for ACTIVE campaigns whose `drawAt` has passed,
   flips `SantaAssignment.giftStatus IN (PENDING, BUYING)` to
   `MISSED_DEADLINE`. Inserts `SantaNotification` rows with
   `type='DEADLINE_MISSED'` (deduped via `dedupeKey: 'missed:<assignmentId>'`).
3. **Deadline warning** — same population as #2 but with `drawAt` in
   72–96h window. Inserts `DEADLINE_WARNING` notifications
   (`dedupeKey: 'warn:<assignmentId>'`).
4. **Seasonal events** — calls `maybeRunSeasonalEvents()` hourly to
   check for Nov 1 (PROMO) and Feb 1 (CLOSING_SOON) calendar
   milestones. Idempotent via `SantaSeasonalBroadcastLog` unique
   constraint on `(year, type)`.

**Tables:** `SantaHintRequest`, `SantaRound`, `SantaCampaign`,
`SantaAssignment`, `SantaParticipant`, `SantaNotification`,
`SantaSeasonalBroadcastLog`.

**Deps:** `prisma`, `logger`, `maybeRunSeasonalEvents` (closure over
helpers in index.ts: `getSeasonStartYear`, `getSantaSeasonInfo`,
`sendSeasonalBroadcast`).

**Startup job:** `runSantaStartupJobs(deps)` (also in `santa.ts`) is
called from `app.listen` callback — fire-and-forget. Two tasks:
- Idempotent `SantaGlobalConfig` singleton upsert.
- Alias backfill for DRAW_DONE rounds without aliases.

**Headline error labels:** `santa-hints expiry check failed`,
`santa-deadlines missed-deadline job failed`,
`santa-deadlines deadline-warning job failed`.

---

## 5. `reservations.ts` — reservation reminder + smart-res schedulers

**Cadence:** three independent timers, registered through two exported
factories to preserve pre-extraction order
(reservation-reminder → events-calendar → smart-res-auto-release →
smart-res-reminder):
- `startReservationReminderScheduler({ … })` — 15 min cadence.
- `startSmartReservationSchedulers({ … })` — 5 min auto-release + 15 min reminder.

**What it does**
1. **Reservation reminder** — for `ReservationMeta` rows where
   `reminderAt <= now` and `reminderSent === false` and `active`,
   sends a Telegram bot message to the reserver. Cycles to next
   scheduled `reminderDates` entry or marks `reminderSent`.
2. **Smart-res auto-release** — for `ReservationMeta` rows where
   `isSmartRes && active && expiresAt <= now`: reverts `Item` to
   `AVAILABLE`, writes `UNRESERVED` `ReservationEvent` + SYSTEM
   `auto_released` comment (with 30d TTL on all comments for that item),
   notifies gifter + owner. Wrapped in `prisma.$transaction`.
3. **Smart-res reminder** — for active SmartRes rows in the reminder
   window (lead hours before `expiresAt`): notifies reserver once.

**Tables:** `ReservationMeta`, `Item`, `ReservationEvent`, `Comment`,
`User`, `Wishlist`.

**Deps:** `prisma`, `logger`, `sendTgBotMessage`, `sendTgNotification`,
`getSmartResLeadHours`, `SYSTEM_ACTOR_HASH`.

**Headline logs:** `reservation-reminders: sent reminders`,
`smart-res: auto-released`, `smart-res: reminder sent`. Error labels:
`reservation-reminders job failed`, `smart-res: auto-release cron failed`,
`smart-res: auto-release item failed`, `smart-res: reminder cron failed`,
`smart-res: reminder item failed`.

---

## 6. `events.ts` — gift-occasion calendar reminders

**Cadence:** 5 min.

**What it does**
- Finds `GiftOccasionReminder` rows where `scheduledFor <= now`,
  `sentAt IS NULL`, `enabled`. For each: formats locale-specific
  notification text + emoji (BIRTHDAY / ANNIVERSARY / HOLIDAY / OTHER),
  sends Telegram bot message + writes a `CalendarInboxEntry`, then
  marks `sentAt` + `delivered`. For recurring occasions, schedules
  the next occurrence using `getNextOccurrenceDate` /
  `computeReminderSchedule` / `buildReminderEpisodeKey`.

**Tables:** `GiftOccasionReminder`, `GiftOccasion`, `User`,
`UserProfile`, `CalendarInboxEntry`.

**Deps:** `prisma`, `logger`, `sendTgBotMessage`, `BOT_TOKEN_FOR_DM`,
`getNextOccurrenceDate`, `computeReminderSchedule`,
`buildReminderEpisodeKey`.

**Headline log:** `gift-occasion-reminders: sent reminders` (info, when
`sent > 0`). Error label: `gift-occasion-reminders job failed`.

---

## 7. `lifecycle.ts` — win-back DM (segments S1–S4)

**Cadence:** 60 min.

**What it does**
- Scans users (with `telegramChatId`, inactive ≥ 6h, `notifyMarketing`
  not opted-out). Classifies each into `S1`–`S4` via
  `classifyLifecycleSegment`. Checks stop conditions (`unsubscribed`,
  `bought_pro`, `returned`), frequency caps (72h cooldown, 45-day max
  5 touches, 60-day promo cooldown, max 3 touches/episode, max waves
  per segment), and cadence timing.
- Sends Telegram DM via `sendLifecycleDM` (factory in `services/lifecycle.ts`).
  Optionally offers WISHPRO promo on eligible touches (S2 wave 2,
  S3 waves 1+2, S4 waves 2+3).
- Auto-unsubscribes users who blocked the bot
  (`UserProfile.notifyMarketing = false`).
- Tracks `lifecycle_<segment>_touch<N>` analytics events on delivery.
- Dead-air alarm: if 24+ cycles in a row produce 0 sends despite
  non-empty candidate pool, logs `lifecycle_dead_air` (warn).
- Counter `lifecycleDeadCycles` is module-scope `let`, resets on
  container restart.

**Tables:** `User`, `UserProfile`, `LifecycleTouch`, `PromoCampaign`,
`PromoRedemption`.

**Deps:** `prisma`, `logger`, `sendLifecycleDM`, `getUserEntitlement`,
`trackEvent`, `MINI_APP_URL_FOR_DM`, `LIFECYCLE_PROMO_CODE`,
`BOT_TOKEN_FOR_DM`.

**Headline log:** `lifecycle_cycle_completed` (info, every cycle, with
`{ candidatesFound, touchesSent, touchesFailed, durationMs }`). Error
labels: `lifecycle scheduler error`, `lifecycle DM rejected by Telegram`
(warn, expected fraction), `lifecycle DM fetch error (transient)`,
`lifecycle touch transient failure; will retry next cycle`.

---

## 8. `pro-renewal.ts` — PRO renewal reminders

**Cadence:** 60 min.

**What it does**
- For PRO subscriptions with `currentPeriodEnd` 7 days (window 6–8d) or
  1 day (window 12–36h) ahead, AND either `billingPeriod = 'yearly'` or
  `cancelAtPeriodEnd = true`, sends a Telegram DM reminder to the user
  via `sendLifecycleDM` (shared with the lifecycle scheduler).
- Idempotent: each send writes a synthetic `PaymentEvent` row with
  `telegramPaymentChargeId = "reminder:<7d|1d>:<subId>:<periodEndISO>"`.
  The unique constraint prevents double-sends.
- Active monthly auto-renewals are silent (Telegram charges
  automatically, no action needed).
- Tracks `pro_renewal_reminder_<7d|1d>` analytics events on delivery.

**Tables:** `Subscription`, `User`, `UserProfile`, `PaymentEvent`.

**Deps:** `prisma`, `logger`, `sendLifecycleDM`, `trackEvent`,
`PRO_PLAN_CODE`, `MINI_APP_URL_FOR_DM`.

**Headline error label:** `pro-renewal-reminder cycle failed`. Success
is silent. Inserting the reminder marker may emit
`reminder marker insert failed` (warn) if a race causes a duplicate
insert; non-fatal — the unique constraint guarantees one send.

---

## 9. `birthday-reminders.ts` — friend + owner birthday DMs

**Cadence:** 60 min + one-shot startup kick at +30s after boot.

**What it does**
- **Send-window guard:** returns early if MSK hour ∉ [9, 22].
- **Phase 1 (retry):** picks up stuck `pending` deliveries (created
  >30 min ago) and `deferred` rows whose `deferredUntil <= now`. Limit
  50 per run. Re-runs `sendBirthdayDelivery` for each.
- **Phase 2 (scan):** for each offset in `[30, 14, 7, 1, 0]` days,
  finds `UserProfile` rows whose `birthday` (month+day in MSK) matches
  today + offset. Feb-29 collapses to Feb-28 in non-leap years (in 4
  call-sites: `getMskBirthdayDay`, `daysUntilNextBirthday`,
  `buildOccurrenceKey`, isFeb28InNonLeap candidate filter). For each
  matched user calls `maybeCreateOwnerDelivery` and/or
  `maybeCreateFriendDeliveries` based on offset.
- **Friend deliveries:** audience is `SUBSCRIBERS` (FREE:
  `ProfileSubscription` + `WishlistSubscription`) or `EXTENDED` (PRO:
  + active `ReservationMeta` reservers + `SecretReservation` reservers
  + commenters resolved via `tgActorHash` matching against
  `Comment.authorActorHash`). Daily cap: 3 friend reminders / recipient
  / MSK day; excess goes to `status='deferred'`,
  `deferredUntil = next MSK 10:00`. `friend_today` bypasses cap.
- **Owner deliveries:** 30d (always for FREE; soft "update wishlist"),
  14d/7d (only if there's a "problem" — no public wishlist OR no
  active items), today (soft congratulations).
- **Pro split:** windows `7d`/`1d` (friend) and `14d`/`7d` (owner) gated
  via `birthdayAdvancedWindowsEnabled` + `isPro`. EXTENDED audience,
  primary wishlist, custom message — PRO only.
- **Idempotency:** unique
  `(birthdayUserId, recipientUserId, occurrenceKey, reminderKind)` on
  `BirthdayReminderDelivery`. P2002 catches mean reruns are dup-safe.
- **Telegram DM:** `sendBirthdayBotPost` (re-implements POST inline,
  classifies bot_blocked / transient / permanent / sent).
- **Skip reasons (14):** `no_public_wishlist`, `no_active_public_items`,
  `primary_wishlist_unavailable`, `profile_private`, `birthday_hidden`,
  `friend_reminders_disabled`, `recipient_opted_out`, `muted`,
  `no_chat_id`, `bot_blocked`, `daily_cap`, `pro_required`,
  `self_excluded`, `no_problem_to_solve`.

**Heartbeat:** `prisma.serviceHeartbeat.upsert({ serviceName: 'birthday_reminders', metadata: JSON.stringify(stats) })`
at the end of every successful cycle. Stats payload:
`{ candidatesFound, deliveriesCreated, sent, skipped, deferred, failed, retried, byKind, bySkipReason }`.

**Tables:** `UserProfile`, `User`, `BirthdayReminderDelivery`,
`BirthdayReminderMute`, `Wishlist`, `Item`, `ProfileSubscription`,
`WishlistSubscription`, `ReservationMeta`, `SecretReservation`,
`Comment`, `ServiceHeartbeat`.

**Deps:** `prisma`, `logger`, `getEffectiveEntitlements`, `tgActorHash`,
`trackEvent`, `BIRTHDAY_REMINDERS_ENABLED`. Pure helpers
(`getMskBirthdayDay`, `getMskToday`, `daysUntilNextBirthday`,
`buildOccurrenceKey`, `nextMskMorning`, `pickBirthdayDisplayName` +
`BIRTHDAY_TZ_OFFSET_HOURS`) live in `services/birthday-reminders.ts`
(shared with `routes/birthday-reminders.routes.ts`).

**Kill switch:** env `BIRTHDAY_REMINDERS_ENABLED` (default `true`; set
to `'false'` to disable without redeploy). Both the scheduler and the
admin metrics endpoint read the same const.

**Headline log:** `birthday_scheduler_completed` (info, every cycle).
Error labels: `birthday: scheduler run failed`, `birthday: retry failed`,
`birthday: candidate processing failed`,
`birthday: friend delivery loop error`. Analytics events:
`birthday.scheduler_run_started/completed/failed`,
`birthday.delivery_created/sent/skipped/deferred/failed`,
`birthday.primary_wishlist_unavailable`. Note: `birthday.*` events flow
to `logger.info` only — `trackEvent` does NOT persist them to
`AnalyticsEvent` (only prefixes `feature_gate_/onboarding_/demo_item_/
gift_/error:/etc` do).

---

## Deploy monitoring

After each deploy, the standard ops checks (`CLAUDE.md` § Post-deploy
health check) cover the foundation: failed migrations, container
status, `/health/deep`, bot heartbeat, error events.

**Per-scheduler observation cadence:**

| When | What to verify |
|---|---|
| Immediate (0–60s) | Container Up; 0 `birthday: scheduler run failed`; 0 `lifecycle scheduler error`. Bot heartbeat fresh. |
| +30s | `birthday-reminders` startup kick fires (heartbeat updates if MSK ∈ [9, 22]). |
| +5 min | First `events.ts` tick (gift-occasion-reminders) — silent OK if no due rows. |
| +15 min | First `referral.ts` sweep + `reservations.ts` reminder/reminder ticks. |
| +60 min | First hourly tick across `cleanup`, `billing`, `santa`, `lifecycle`, `pro-renewal`, `birthday-reminders`. Look for `birthday_scheduler_completed` info entry, `lifecycle_cycle_completed` info entry. |
| +24h | Heartbeat on `ServiceHeartbeat['birthday_reminders']` should be < 1h old. `lifecycle_dead_air` should NOT have fired (24-cycle threshold). |

**Sibling-cron sanity:** if a brand-new module breaks while siblings
keep producing logs, the breakage is module-local. If silent across all
schedulers — investigate setInterval registration / process state.

**Error-event spike check (24h after deploy):**

```bash
ssh vultr 'docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c "SELECT event, COUNT(*) FROM \"AnalyticsEvent\" WHERE event LIKE '\''error:%'\'' AND \"createdAt\" >= NOW() - INTERVAL '\''1 day'\'' GROUP BY event ORDER BY count DESC;"'
```

---

## Constraints (preserved across all schedulers)

- **Cadence is byte-identical to pre-extraction implementation.** No
  scheduler had its interval changed during P5r-1..6.
- **Best-effort error handling:** every `setInterval` callback wraps
  the body in `try/catch` and logs but never re-throws. The next cycle
  re-attempts.
- **Idempotency** is enforced via unique DB constraints (e.g.
  `BirthdayReminderDelivery` quad-key, `PaymentEvent.telegramPaymentChargeId`,
  `SantaSeasonalBroadcastLog.year+type`). Restart-safe.
- **Module-scope mutable state** (`lifecycleDeadCycles`) resets on
  container start by design. Reset is rare (only at deploys) and
  reflected in counter semantics.
- **No business logic from schedulers calls into route handlers** —
  schedulers operate directly on Prisma + Telegram. Route helpers
  (e.g. `attributeLifecycleReturn`) live in `routes/wishlists.routes.ts`
  but are not re-entered from scheduler code.
