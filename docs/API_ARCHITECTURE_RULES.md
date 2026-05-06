# API Architecture Rules

**Status:** mandatory · **Last updated:** 2026-05-06 (after P5r-6) · **Owner:** backend

These rules are non-negotiable for any change under `apps/api/`. They exist
because `index.ts` was a ~20 k-line monolith that grew uncontrollably. The
decomposition (P1–P5 + P5r-1..6; see
[REFACTOR_API_INDEX_HANDOFF.md](REFACTOR_API_INDEX_HANDOFF.md)) **is
done as of 2026-05-06**: `index.ts` is 3 110 LOC, 0 inline `tg`
handlers, 0 actual scheduler calls, all 9 cron jobs and the first 2
cross-scheduler services have been extracted. The follow-up P5s wave
moves the remaining ~50 helper functions into `services/`. If new
features keep landing in `index.ts`, the work is wasted in a few months.

If a rule conflicts with a quick fix, the rule wins. Open a discussion before
bending it.

---

## TL;DR

- `apps/api/src/index.ts` is a **composition root**: bootstrap, middleware,
  router registration, schedulers, `app.listen`, process handlers. Nothing else.
- New API features live in **domain routers** under
  `apps/api/src/routes/<domain>.routes.ts`.
- Route handlers stay **thin**. Business logic, Prisma state transitions, and
  side effects move to **service / domain / integration** layers.
- Every new state-changing route picks **idempotency + rate-limit + analytics**
  explicitly. No silent state-changers.
- No `misc.routes.ts` / `common.routes.ts` / `new.routes.ts` dumping grounds.
  Each router = one named domain.
- Schedulers live in `schedulers/`. Route modules don't run cron.

Full canonical contract below.

---

## 1. `index.ts` is a composition root

`apps/api/src/index.ts` exists for, and only for:

- Bootstrap (`bootstrap/dns`, `bootstrap/env`, `bootstrap/sentry`).
- Middleware registration (cors, json body, request logger, error handler).
- Router registration (`app.use('/tg', tgRouter)`, `/public`, `/internal`,
  admin, etc.).
- Scheduler / job registration.
- `app.listen(...)`.
- Process-level handlers (`uncaughtException`, `unhandledRejection`).

**Forbidden in `index.ts`:**

- New route handlers.
- New business logic.
- New Prisma queries scoped to a feature.
- New large helper functions.
- Telegram notification flow.
- Billing / payment flow.
- Domain state transitions.

If a new feature needs an endpoint, it goes to a domain router:

```
apps/api/src/routes/<domain>.routes.ts
```

If no fitting router exists, **create the domain first, then the feature**.
Don't reach back into `index.ts`.

### ✅ Можно

```ts
// apps/api/src/index.ts
import { registerWishlistsRouter } from './routes/wishlists.routes.js';
const wishlistsRouter = registerWishlistsRouter(deps);
tgRouter.use(wishlistsRouter);
```

### ❌ Нельзя

```ts
// apps/api/src/index.ts
tgRouter.post('/wishlists/:id/duplicate', async (req, res) => {
  // 200 lines of business logic + 5 Prisma queries + Telegram notify
});
```

---

## 2. New feature code goes to the domain layout

A new feature touches some or all of:

| Layer | Path | Responsibility |
|---|---|---|
| HTTP | `routes/<domain>.routes.ts` | Express handlers (thin). |
| Service | `services/<domain>.service.ts` | Orchestration, use-cases, business logic. |
| Domain rules | `domain/<domain>/<domain>.rules.ts` | Pure rules, invariants. |
| Domain state | `domain/<domain>/<domain>.state.ts` | State transitions (`AVAILABLE → RESERVED`, etc.). |
| Domain perms | `domain/<domain>/<domain>.permissions.ts` | Authorisation predicates. |
| Repository | `repositories/<domain>.repo.ts` | Complex / repeated Prisma queries. |
| Integration | `integrations/<vendor>/*` | Telegram, Stars, URL imports, external APIs. |
| Scheduler | `schedulers/<job>.ts` | Cron / interval jobs. |

### Layer status

`schedulers/` and `services/` are now **real** layers (not future
carve-outs). As of 2026-05-06:

- `schedulers/` ships **9 modules** (cleanup, billing, referral, santa,
  reservations, events, lifecycle, pro-renewal, birthday-reminders) —
  see [SCHEDULERS.md](SCHEDULERS.md).
- `services/` ships **2 modules** (lifecycle, birthday-reminders) and
  has ~10 planned during the P5s wave — see [SERVICES.md](SERVICES.md).

`domain/`, `repositories/`, `integrations/` remain **target** folders —
create them when the first real file lands; don't pre-seed empty
directories. Folders that already exist (`bootstrap/`, `lib/`,
`middleware/`, `notifications/`, `placements/`, `routes/`, `security/`,
`telegram/`, `uploads/`, `wishlists/`, `health/`, `schedulers/`,
`services/`) cover what already exists.

If a feature needs something that has no fitting layer yet, **create
that layer in this PR**. Don't fold the logic back into `index.ts` or
stuff it sideways into a router file.

### When to extract a helper into `services/`

Pull a helper out of `index.ts` (or out of a router file) into
`services/<name>.ts` when **any** of the following hold:

- **3+ consumers** across `routes/` and/or `schedulers/` (cross-cutting).
- **Cross-scheduler** dependency: two or more schedulers need the same
  factory or pure helper. Putting it in one scheduler module would
  create a scheduler→scheduler import.
- **Routes + scheduler share a pure utility** (timezone math,
  occurrence keys, name picker). Service is the only correct home if
  both consume it.
- The helper is otherwise still inline in `index.ts` and the file
  exceeds the composition-root role.

Single-router helpers stay in the router file or move to
`services/<domain>.service.ts` only when the **handler size** crosses
the ~80–120 LOC smell test (see § 3).

### Composition-root target

The end-state for `apps/api/src/index.ts`:

- Bootstrap (`bootstrap/dns`, `bootstrap/env`, `bootstrap/sentry`).
- Express middleware registration (cors, json body, request logger,
  error handler, /uploads, /health).
- Auth-gate registration (`tgRouter.use(...)` chain, `protectTgRoute`
  entries — these are gate registration, not handlers).
- Router registration (`tgRouter.use(<domain>Router)`,
  `app.use('/public', publicRouter)`, etc.).
- Scheduler registration (`start*Scheduler({ ... })` × 9).
- `app.listen(...)` + process handlers.

Everything else moves to a layer module.

---

## 3. Route handlers stay thin

A route handler does only:

1. Read `req.params`, `req.query`, `req.body`.
2. Validate input (Zod, etc.).
3. Resolve the current user.
4. Call a service / use-case.
5. Shape the HTTP response.

A handler **does not** contain long business logic.

**Soft cap: ~80–120 lines.** Past that, you almost certainly have a service
hiding inside the handler. Extract to:

```
apps/api/src/services/<domain>.service.ts
```

The cap is a smell test, not a hard limiter. A handler with 90 lines of
trivial DTO mapping is fine; a handler with 60 lines of state-machine logic
is not.

### ✅ Можно

```ts
router.post('/wishlists/:id/archive', async (req, res) => {
  const userId = req.userId!;
  const { id } = req.params;
  const result = await wishlistService.archive({ userId, wishlistId: id });
  res.json(result);
});
```

### ❌ Нельзя

```ts
router.post('/wishlists/:id/archive', async (req, res) => {
  // 200 lines: ownership check, state transition, archive items,
  // notify subscribers, write analytics, schedule purge…
});
```

---

## 4. Prisma mutations that change entity state belong in service / domain

If a Prisma write changes status or state, it is **not** route-handler code.
Put it in the service / domain layer.

State transitions covered by this rule include (non-exhaustive):

- `Item.status`: `AVAILABLE → RESERVED`, `RESERVED → AVAILABLE`,
  `→ COMPLETED`, `→ DELETED`, `→ ARCHIVED`.
- `Wishlist.archivedAt = now / null`.
- `SecretReservation.status` transitions.
- `ReservationMeta` writes that imply ownership change.
- `Subscription.status`: `ACTIVE → CANCELLED → EXPIRED`.
- `Hint.status`: `PENDING → SENT → CONSUMED / EXPIRED`.
- `SantaCampaign.status`, `SantaParticipant.status`, etc.
- `PromoRedemption.status`: `PENDING → ACTIVE → EXPIRED`.
- `DegradationState.phase` transitions.
- Any `*At = now` field that gates downstream behaviour
  (`completedAt`, `archivedAt`, `purgeAfter`).

These belong in:

- `services/<domain>.service.ts` (orchestration), or
- `domain/<domain>/<domain>.state.ts` (the transition definition), or
- `domain/<domain>/<domain>.rules.ts` (the invariant a transition must respect),
- and may use `repositories/<domain>.repo.ts` for the actual Prisma write.

The route handler **calls** the service. It does not write the transition itself.

### ✅ Можно

```ts
// services/items.service.ts
export async function reserveItem({ itemId, actorHash }: …) {
  return prisma.$transaction(async (tx) => {
    const item = await tx.item.findUnique({ where: { id: itemId } });
    assertReservable(item);  // domain rule
    return tx.item.update({
      where: { id: itemId },
      data: { status: 'RESERVED', /* … */ },
    });
  });
}
```

### ❌ Нельзя

```ts
// routes/items.routes.ts
router.post('/items/:id/reserve', async (req, res) => {
  // Prisma update with status: 'RESERVED' written inline + Telegram notify
});
```

---

## 5. Idempotency, rate-limit, and analytics are explicit decisions

A new state-changing endpoint (POST / PATCH / DELETE) **must** explicitly
answer all three:

- **Idempotency:** needed / not needed? If yes — `critical: true`?
  What is the action key (`domain.verb` or `domain.verb:${entityId}`)?
- **Rate limit:** which category from
  [`apps/api/src/security/rateLimits.ts`](../apps/api/src/security/rateLimits.ts)?
  New categories require a doc entry in [API_SECURITY.md § 5](API_SECURITY.md).
- **Analytics:** which `event` strings, which props, where emitted?

These decisions are recorded:

- Idempotency middleware → registered centrally; **not** glued inside handler bodies.
- Rate-limit category → declared at route registration / via the central
  middleware factory; not inlined.
- Analytics → emitted from the service or a thin wrapper. Don't sprinkle
  `trackEvent` calls across deeply nested branches.

State-changing routes without an explicit answer to all three are not ready to
ship. The full security contract lives in [API_SECURITY.md](API_SECURITY.md).

---

## 6. No dumping-ground routers

The following filenames are **forbidden**:

- `misc.routes.ts`
- `other.routes.ts`
- `new.routes.ts`
- `helpers.routes.ts`
- `common.routes.ts` (when used to mix unrelated domains)

Every router file = one identifiable domain. Examples:

`items.routes.ts`, `wishlists.routes.ts`, `reservations.routes.ts`,
`billing.routes.ts`, `santa.routes.ts`, `comments.routes.ts`, `hints.routes.ts`,
`onboarding.routes.ts`, `gift-notes.routes.ts`, `promo.routes.ts`, etc.

If you have a few one-off endpoints that don't fit any existing domain, the
answer is **not** "make a misc bucket". The answer is: identify the domain,
even if small, and name it after that domain (`telemetry.routes.ts`,
`maintenance.routes.ts` — both already exist and are valid). One-route
domains are fine. Generic catch-alls are not.

---

## 7. Side effects are explicit

Telegram messages, push notifications, analytics events, billing calls,
external HTTP — **none** of these silently live inside a long handler.

They live in:

- `integrations/telegram/*` — Bot API calls, deep links, invoices.
- `notifications/*` — debounced / fan-out notification dispatch.
- `services/<domain>.service.ts` — orchestration that calls integrations.
- `analytics/*` (when introduced) — event emission helpers.
- `billing/*` (when introduced) — Stars / charge flow.

A reader scanning a handler must see "calls `wishlistService.create(...)`"
and find every side effect by following one import. They must **not** have
to read 200 lines of inline branching to discover that the handler also
pings Telegram and writes an analytics event.

---

## 8. Scheduler / job logic is not in route modules

Cron, `setInterval`, background loops live in:

```
apps/api/src/schedulers/*
```

`index.ts` only **registers** schedulers (one
`start*Scheduler({ ... })` factory call per module). Route modules
**never** start them.

As of 2026-05-06 the folder ships **9 modules** covering every
existing cron job (cleanup, billing, referral, santa, reservations,
events, lifecycle, pro-renewal, birthday-reminders). Cadences,
tables, log labels, and monitoring notes for each are in
[SCHEDULERS.md](SCHEDULERS.md). New jobs land directly in
`schedulers/`, not anywhere else.

---

## 9. Pre-implementation checklist

Before writing a single line for a new API feature, answer all ten:

1. **Domain.** Which domain does this belong to?
2. **Router.** Which router file gets the endpoint? If none — what is the
   new domain name?
3. **Service.** Does the feature need a service? (If logic is non-trivial — yes.)
4. **State transition.** Does any entity change state? Which entity, which
   transition?
5. **Prisma mutation.** What writes happen? Wrapped in a transaction?
6. **Idempotency.** Needed? `critical: true`? Action key?
7. **Rate limit.** Which category from `security/rateLimits.ts`?
8. **Side effects.** Telegram message? Billing call? External HTTP?
9. **Analytics.** Which events? Which props? Where emitted?
10. **Smoke checks.** What is verified post-deploy?

If any answer is "I don't know yet" — don't start coding. Resolve first.

---

## 10. Review checklist

Before opening / merging the PR:

- [ ] No route handlers added to `index.ts`.
- [ ] `index.ts` did not grow except for router registration / scheduler
      registration.
- [ ] Handlers ≤ ~120 lines, or the size is justified (mapping-only).
- [ ] No state transitions inline in route bodies.
- [ ] No raw Prisma writes for `*.status`, `archivedAt`, `completedAt`,
      `purgeAfter` in handlers.
- [ ] Idempotency / rate-limit category / analytics decisions are explicit
      and visible in the diff.
- [ ] No `misc` / `other` / `new` / `helpers` / generic `common` router file
      introduced.
- [ ] Side effects (Telegram, billing, external) live in `integrations/`,
      `notifications/`, or `services/`, not inline in a handler.
- [ ] No scheduler started from a route module.
- [ ] `pnpm --filter @wishlist/api build` clean.
- [ ] `pnpm --filter @wishlist/api test` clean (baseline 247 / 3,
      `sort.test.ts` failures pre-existing).
- [ ] If the endpoint is new → smoke plan in PR description.

---

## Pointers

- Refactor handoff (P1–P5/P5r status, P5s roadmap): [REFACTOR_API_INDEX_HANDOFF.md](REFACTOR_API_INDEX_HANDOFF.md).
- Schedulers reference (9 modules, cadence, monitoring): [SCHEDULERS.md](SCHEDULERS.md).
- Services layer (2 existing + ~10 planned): [SERVICES.md](SERVICES.md).
- Security contract (idempotency / rate limits / Wave-2 status): [API_SECURITY.md](API_SECURITY.md).
- Architecture overview: [ARCHITECTURE.md](ARCHITECTURE.md).
- Route inventory: [BACKEND_MAP.md](BACKEND_MAP.md).
- Iron-rule summary for agents: [CLAUDE.md](../CLAUDE.md#api-architecture--mandatory-for-new-backend-code).
- Post-deploy smoke checklist: [CLAUDE.md](../CLAUDE.md#post-deploy-health-check-mandatory-after-every-deploy).
