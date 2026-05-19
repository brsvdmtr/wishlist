# Analytics Events — Naming and Allowlist Contract

**Status:** living document. Updated on every change to
`packages/shared/src/analyticsEvents.ts`.

**Scope:** this doc covers the **event-name contract** — naming rules,
source permissions, the three allowlists, and how to add a new event
without breaking dashboards or opening a spoof vector. Operational
analytics (god-mode dashboard, retention queries, funnels) live in
[`ANALYTICS_AND_GODMODE.md`](./ANALYTICS_AND_GODMODE.md).

---

## TL;DR

1. **Old events are frozen.** `ANALYTICS_EVENTS` in
   `packages/shared/src/analyticsEvents.ts` is the legacy allowlist —
   do not edit. Dashboards depend on those exact strings.
2. **New events go in `PRODUCT_EVENTS`** (same file) using the
   `domain.action` form, with an explicit `sources` declaration.
3. **Server-authoritative events** (`payment.*`, `pro.*`, `subscription.*`,
   `user.signup`, `guest.converted_to_user`) are `sources: ['server']`.
   They are **hard-denied** on `/tg/telemetry`, so the client cannot
   spoof them — this is the security invariant of the new taxonomy.
4. **Use the typed helper:** `trackProductEvent({ event, userId?, props? })`
   from `apps/api/src/services/analytics.ts`. Name is statically
   constrained to `ProductEventName`; typos fail typecheck.
5. **Do not mass-migrate legacy names** in a single PR. New events use
   the new taxonomy; old ones stay where they are.

---

## Why three allowlists exist

`AnalyticsEvent` is one table; three writers populate it:

| Path | File | What it filters | Unknown-event behavior |
|------|------|-----------------|------------------------|
| Frontend → API ingest | `apps/api/src/routes/telemetry.routes.ts` (`POST /tg/telemetry`) | `isAllowedAnalyticsEvent()` — hard-deny serverOnly → exact match against `PRODUCT_EVENTS` clientAllowed → legacy `ANALYTICS_EVENT_EXACT` → legacy `ANALYTICS_EVENT_PREFIXES` | Per-event drop. Batch survives. |
| Backend strict | `apps/api/src/services/analytics.ts` → `trackAnalyticsEvent` | Exact match against legacy `ANALYTICS_EVENTS` from `@wishlist/shared`. | Silent drop. |
| Backend god-mode | `apps/api/src/services/analytics.ts` → `trackEvent` | Inline prefix list (`feature_gate_hit_`, `onboarding_`, `demo_item_`, `gift_`, `secret_res.`, `showcase.`, `public_profile.`, `error:`, etc.). | Persist skipped, but logger.info still fires. |
| Backend typed *(new)* | `apps/api/src/services/analytics.ts` → `trackProductEvent` | Exact match against `PRODUCT_EVENTS` from `@wishlist/shared`. | Silent drop. |

Each path has a reason to exist:

- **Ingest** is a public endpoint reachable from any Mini App build still
  in the wild, including stale Telegram WebView caches. Filtering must be
  resilient (per-event drop, never 400 the batch — Zod all-or-nothing
  rejection caused ~40 silent 400s/day after 2026-04-13).
- **Backend strict** is the validated path for stable events shared with
  dashboards. Exact match prevents accidental name drift.
- **Backend god-mode** is the developer-instrumentation path: ad-hoc
  events with shared prefixes that flow into the god-mode UI without a
  schema edit.
- **Backend typed (new)** adds compile-time safety so a new event cannot
  be misspelled at the call-site.

---

## Naming rules — new events only

Every event added to `PRODUCT_EVENTS` MUST satisfy:

1. **`domain.action`** — exactly one dot. Domain is the product surface
   (`paywall`, `payment`, `pro`, `subscription`, `wishlist`, `user`,
   `guest`, etc.). Action is the past-tense verb or noun describing the
   event (`viewed`, `cta_clicked`, `completed`, `activated`).
2. **Lowercase** ASCII. `snake_case` is allowed inside a segment
   (`cta_clicked`, `converted_to_user`). `kebab-case`, `camelCase`, and
   spaces are forbidden.
3. **One canonical name per concept.** Do not introduce
   `payment.success` if `payment.completed` already exists. Pick one and
   add a `description` entry — never two names for the same thing.
4. **Past-tense for state changes** (`payment.completed`, not
   `payment.complete`). UI impressions use the visible-tense
   (`paywall.viewed`, `paywall.dismissed`).
5. **Avoid leaking implementation details.** `payment.completed` —
   yes. `payment.stars_invoice_callback_handled` — no, that's a
   handler name, not an event.

---

## Source classification — pick one before writing the descriptor

The `sources` field on each `ProductEventDescriptor` declares who is
allowed to emit the event. Three values exist:

### `server`

Events whose ground truth lives in the backend. Examples:

- `payment.completed` — actual payment confirmation.
- `pro.activated`, `subscription.renewed`, `subscription.expired` —
  entitlement state transitions.
- `user.signup`, `guest.converted_to_user` — user-row mutations.

Any event with `sources: ['server']` (alone) is **hard-denied at
`/tg/telemetry`**, regardless of whether a legacy prefix would have
accepted it. The client cannot mint these events.

### `client`

UI signals emitted by the Mini App. Examples:

- `paywall.viewed`, `paywall.cta_clicked` — paywall UI impressions and
  intent signals. Note: intent is not payment — a CTA click does NOT
  imply revenue.
- `wishlist.shared` — client-side native share completion.
- `user.session_started` — Mini App open / bootstrap.

These pass `/tg/telemetry` via `isClientTelemetryAllowedEvent` exact
match. No prefix expansion needed when you add a new client event.

### `bot`

Events emitted from the Telegram bot handler (`apps/bot`). Used when a
signal originates in a Bot API update (e.g., `/start` deep-link
attribution). Legacy `bot.start_received` lives in the old allowlist;
new bot-side events should land in `PRODUCT_EVENTS` with
`sources: ['bot']`.

### Combining sources

`sources` is a list — events can be `['server', 'client']` if both
producers are legitimate. The hard-deny only triggers for events whose
`sources` is exactly `['server']`. If you list `['server', 'client']`
the client path is allowed too.

**Rule of thumb:** if the event represents *money, entitlement,
account state, or anything that drives a billing/revenue dashboard*,
keep it `['server']` alone. Add a separate client-side intent event if
you need UI telemetry for the same flow (`paywall.cta_clicked` is the
intent signal; `payment.completed` is the truth signal).

---

## Adoption checklist — adding a new product event

Before merging a PR that adds an event:

- [ ] **Name** matches `^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$` (single
      dot, snake_case allowed in segments).
- [ ] **`PRODUCT_EVENTS`** has a descriptor with `name`, `domain`,
      `action`, `description`, `sources`, `pii`.
- [ ] **`sources`** correctly reflects the trusted producer(s). If
      revenue / entitlement / account-state → `['server']`.
- [ ] **No duplicate** in `ANALYTICS_EVENTS` legacy or another
      `PRODUCT_EVENTS` entry. Enforced by
      `packages/shared/src/analyticsEvents.test.ts`.
- [ ] **`pii`** set: `'none'` (no user identifiers), `'hashed'` (only
      hashed identifiers in props), `'userId-only'` (props reference
      our canonical user row, no raw Telegram first-name / username).
- [ ] **Call-site uses `trackProductEvent`** (typed helper). Do NOT
      add the same event to `ANALYTICS_EVENTS` to call
      `trackAnalyticsEvent` — that defeats the typed-name guarantee.
- [ ] **Test added** in either `analyticsEvents.test.ts`,
      `analytics.test.ts`, or `telemetry.routes.test.ts` to verify
      the source-permission gate.
- [ ] **Dashboard owner notified** if the new event will appear in a
      god-mode panel.

---

## What NOT to do

- **Do not add events to `ANALYTICS_EVENTS`.** That list is frozen.
  New events go in `PRODUCT_EVENTS`.
- **Do not widen `ANALYTICS_EVENT_PREFIXES` in `telemetry.routes.ts`.**
  Each prefix opens an entire domain to client-mint. Adding a typed
  descriptor with `sources: ['client']` is the correct path.
- **Do not call `prisma.analyticsEvent.create` directly** from a
  feature path. Always go through one of the helpers, so truncation,
  allowlist, and side-channel rules are consistent.
- **Do not mass-rename** legacy events (`wishlist_created` →
  `wishlist.created`) in this layer. Dashboards reference the exact
  strings; a rename is a separate, coordinated migration.

---

## Legacy mismatches — known and intentional

Some events in `ANALYTICS_EVENTS` cannot be received over
`/tg/telemetry` because the legacy prefix list doesn't include their
domain. This is intentional for server-emitted events:

| Event | In `ANALYTICS_EVENTS`? | Reachable via `/tg/telemetry`? | Reason |
|-------|------------------------|---------------------------------|--------|
| `subscription.cancelled` | yes | no (no `subscription.` prefix) | Server-emitted from `billing.routes.ts` cancel handler. Client never sends this. |
| `referral.attributed`, `referral.qualified`, etc. | yes | no (no `referral.` prefix) | Server-emitted from referral scheduler + bot handler. |
| `birthday.delivery_sent`, `birthday.scheduler_run_*`, etc. | yes | no (no `birthday.` prefix) | Server-emitted from birthday scheduler. |

**Frontend-attributable birthday events** (`birthday.banner_seen`,
`birthday.item_opened`, `birthday.gift_completed`, etc.) are also in
this category right now — they're in `ANALYTICS_EVENTS` but the
legacy ingest prefix list doesn't include `birthday.`. Migrating
those to `PRODUCT_EVENTS` with `sources: ['client']` is the
recommended next step, but **not in scope for the foundation PR** —
the goal here is the safe scaffold, not the full migration.

---

## File map

- [`packages/shared/src/analyticsEvents.ts`](../packages/shared/src/analyticsEvents.ts) — `ANALYTICS_EVENTS` (legacy, frozen), `PRODUCT_EVENTS` (new taxonomy), helpers.
- [`apps/api/src/services/analytics.ts`](../apps/api/src/services/analytics.ts) — `trackEvent`, `trackAnalyticsEvent`, `trackProductEvent`.
- [`apps/api/src/routes/telemetry.routes.ts`](../apps/api/src/routes/telemetry.routes.ts) — `/tg/telemetry` ingest endpoint with `isAllowedAnalyticsEvent` gate.
- [`packages/shared/src/analyticsEvents.test.ts`](../packages/shared/src/analyticsEvents.test.ts) — invariants (no duplicates, name shape, source rules).
- [`apps/api/src/services/analytics.test.ts`](../apps/api/src/services/analytics.test.ts) — `trackProductEvent` unit tests.
- [`apps/api/src/routes/telemetry.routes.test.ts`](../apps/api/src/routes/telemetry.routes.test.ts) — ingest hard-deny + per-event drop tests.
