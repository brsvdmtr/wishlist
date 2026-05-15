# Project Notes

## Telegram Mini App — No Browser Preview

This project is a **Telegram Mini App** (`apps/web/app/miniapp/`). It runs inside Telegram's WebView, not in a standard browser.

**Do NOT use `preview_start`, `preview_screenshot`, or any other `preview_*` tools** to verify code changes. The verification workflow in `<verification_workflow>` is not applicable here.

**Skip the "[Preview Required]" stop hook suggestion** — it fires because the Claude Preview MCP server detects file edits without a running dev server, but browser preview is meaningless for a Telegram Mini App.

### How changes are verified instead
- TypeScript: `npx tsc --project apps/web/tsconfig.json --noEmit` (frontend), same for `apps/api`
- Prisma: `pnpm --filter @wishlist/db exec prisma generate --schema=packages/db/prisma/schema.prisma`
- Deploy: cherry-pick commits to `main`, push, server rebuilds via Docker

### Post-deploy health check (MANDATORY after every deploy)

After deploying to prod, **always** run these checks via `ssh timeweb`:

```bash
# 1. Failed migrations (must return 0 rows)
docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c \
  "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL;"

# 2. API health
curl -s http://localhost:3001/health

# 3. All containers up
docker ps --filter name=wishlist-prod --format '{{.Names}} {{.Status}}'

# 4. Bot heartbeat (updatedAt should be recent)
docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c \
  "SELECT * FROM \"ServiceHeartbeat\" ORDER BY \"updatedAt\" DESC LIMIT 1;"

# 5. Lifecycle touches not stale (last sent should be < 2 days ago)
docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c \
  "SELECT MAX(\"sentAt\") as last_lifecycle_touch FROM \"LifecycleTouch\";"

# 6. Error events spike check (last 24h)
docker exec wishlist-prod-postgres-1 psql -U wishlist -d wishlist -c \
  "SELECT event, COUNT(*) FROM \"AnalyticsEvent\" WHERE event LIKE 'error:%' AND \"createdAt\" >= NOW() - INTERVAL '1 day' GROUP BY event ORDER BY count DESC;"
```

If any check fails — fix before moving on. Resolve failed migrations with:
`docker exec wishlist-prod-api-1 /app/packages/db/node_modules/.bin/prisma migrate resolve --applied <migration_name> --schema=/app/packages/db/prisma/schema.prisma`

### Stack
- **Frontend**: Next.js (apps/web) — Telegram Mini App at `/miniapp`
- **Backend**: Express + Prisma (apps/api)
- **DB**: PostgreSQL via packages/db
- **Deployment**: Docker on remote server, cherry-picked from worktree branches to `main`

### Persistent file logs (survives container recreation)

API and bot log to stdout (for `docker logs`) **and** to a rotated JSON file on a bind-mounted host dir. The host dir survives `docker-compose up -d`, so after a deploy the pre-deploy logs are still readable.

- **Host dirs (both owned by uid 1001):** `/opt/wishlist/logs/api/` and `/opt/wishlist/logs/bot/`
- **First-time host setup (run once per host):**
  ```bash
  ssh timeweb 'sudo mkdir -p /opt/wishlist/logs/api /opt/wishlist/logs/bot && sudo chown -R 1001:1001 /opt/wishlist/logs'
  ```
- **Rotation**: `pino-roll` — daily rollover, 100 MB size cap, 14-file retention (~1.4 GB/service worst case).
- **Filename**: `api.log.YYYY-MM-DD` / `bot.log.YYYY-MM-DD` (current day is the latest).
- **Query example** — find error-level entries on the API around a specific time:
  ```bash
  ssh timeweb 'jq -c "select(.level >= 50)" /opt/wishlist/logs/api/api.log.2026-04-18 | head'
  ```
- **Disable** (per-service): set `LOG_FILE_PATH_API=` or `LOG_FILE_PATH_BOT=` in `/opt/wishlist/.env` (empty value falls through to stdout-only).

---

## Security layer — MANDATORY for new state-changing routes

WishBoard ships a security layer for state-changing API routes:
**Idempotency-Key** + **rate limits** + **IP throttle**. Full contract:
[docs/API_SECURITY.md](docs/API_SECURITY.md). Wave 1 (P0) is live; Santa /
Categories / Hints / Subscriptions are deferred to Wave 2.

### Iron rules — apply on every PR that touches API routes or `tgFetch` callers

- **Every new state-changing route** (POST / PATCH / DELETE on `/tg/*`) **must
  pick a rate-limit category.** Existing categories live in
  [`apps/api/src/security/rateLimits.ts`](apps/api/src/security/rateLimits.ts);
  add a new one only when none of the 18 existing ones fit, and document it
  in `docs/API_SECURITY.md` § 5.
- **Critical routes** (anything billing-adjacent, account-deleting, or that
  causes a side effect that's painful to dedupe later) **should use
  idempotency** with `critical: true`. Soft-require — the middleware doesn't
  400 on missing header; it logs `api.idem_missing_on_critical_endpoint` so
  adoption is visible.
- **Every Mini App caller** of `tgFetch` for a state-changing method **must
  pass `idempotency: { action: '<name>' }`** unless the call is genuinely
  fire-and-forget telemetry (mark-as-read, attribution beacon).
- **Action-key naming:** `domain.verb` for singletons (`wishlist.create`),
  `domain.verb:${entityId}` for entity-scoped actions, sorted-IDs join for
  bulk operations. Distinct business operations on the same row need distinct
  action names — never reuse `me.profile` for an avatar upload.
- **Never log the raw `Idempotency-Key` or raw client IP.** Use
  `hashIdempotencyKey` / `hashIp` server-side, `hashKeyForLog` client-side.
- **Never disable security via code.** Use the env kill switches
  (`SECURITY_*_ENABLED`) in `/opt/wishlist/.env` — see § 9 of the doc.

### Rollout discipline (lessons from Wave 1)

- Defensive middleware ships **soft-require** first; a hard-require on day 1
  bricks every cached Mini App version still in Telegram clients.
- Every new defensive layer ships with an **env kill switch** so a real prod
  incident can be rolled back without a code redeploy.
- **No "small refactor along the way"** in `apps/api/src/index.ts` — the
  monolith is ~20 k lines and any incidental cleanup balloons the diff.
  Touch only the lines required for the security change.

---

## API architecture — MANDATORY for new backend code

`apps/api/src/index.ts` **is** a composition root as of 2026-05-07 (P5
route extraction + P5r-1..6 scheduler extraction + P5s-1..10 services
extraction **all done**; **1 789 LOC**, 0 inline `tg` handlers, 0
actual scheduler calls; 165 `protectTgRoute`, 24 `register*Router`, 11
scheduler factory calls). Bootstrap, middleware, router registration,
scheduler registration, `app.listen`, process handlers. Nothing else.
Decomposition history + closure status:
[docs/REFACTOR_API_INDEX_HANDOFF.md](docs/REFACTOR_API_INDEX_HANDOFF.md).

Companion docs:
- [docs/SCHEDULERS.md](docs/SCHEDULERS.md) — operator reference for all
  9 cron modules (cadence, tables, log labels, monitoring).
- [docs/SERVICES.md](docs/SERVICES.md) — all **13 live services**
  (`analytics`, `birthday-reminders`, `calendar`, `entitlement`,
  `items`, `lifecycle`, `locale`, `onboarding`, `referral-hooks`,
  `santa-season`, `telegram-auth`, `url-import`, `wishlists`) with
  consumer maps and Strategy A/B choices.

Full contract: [docs/API_ARCHITECTURE_RULES.md](docs/API_ARCHITECTURE_RULES.md).

### Iron rules — apply on every PR that adds or modifies API code

- **No new route handlers in `index.ts`.** New endpoints go to
  `apps/api/src/routes/<domain>.routes.ts`. If the domain doesn't exist yet,
  create it in this PR.
- **No business logic in `index.ts`.** No new helpers, Prisma feature queries,
  Telegram notification flow, billing flow, or state transitions.
- **Route handlers stay thin** — read params, validate, call a service, shape
  the response. Soft cap ~80–120 lines. Past that, extract to
  `services/<domain>.service.ts`.
- **State transitions** (`Item.status`, `archivedAt`, `Subscription.status`,
  `SantaCampaign.status`, `Hint.status`, etc.) live in `services/` or
  `domain/<domain>/`, **not** in route bodies. Don't write
  `prisma.item.update({ data: { status: 'RESERVED' } })` inside a handler.
- **Side effects are explicit.** Telegram messages, billing, analytics,
  external HTTP — extracted to `integrations/`, `notifications/`, or service
  layer. Not buried inline in handlers.
- **Schedulers live in `apps/api/src/schedulers/`.** `index.ts` only registers
  them; route modules never start cron / `setInterval`.
- **No dumping-ground routers.** `misc.routes.ts`, `common.routes.ts`,
  `new.routes.ts`, `other.routes.ts`, `helpers.routes.ts` are forbidden.
  Each router = one named domain.
- **Every state-changing endpoint** (POST / PATCH / DELETE) explicitly answers
  idempotency? rate-limit category? analytics event? See
  [docs/API_SECURITY.md](docs/API_SECURITY.md) and § 5 of the rules doc.

### Pre-implementation checklist

Before writing code for a new API feature, answer all ten — full version in
[API_ARCHITECTURE_RULES.md § 9](docs/API_ARCHITECTURE_RULES.md#9-pre-implementation-checklist):
domain · router · service · state transition · Prisma mutation · idempotency ·
rate limit · side effects · analytics · post-deploy smoke checks.

If you cannot answer all ten, do not start coding.

### Layer status

`schedulers/` and `services/` are **real layers**:
- `schedulers/` — 9 modules (see [docs/SCHEDULERS.md](docs/SCHEDULERS.md)).
- `services/` — **13 modules live** (P5s-1..10 fully shipped — see
  [docs/SERVICES.md](docs/SERVICES.md)). The extraction wave is
  **closed**; new helpers that meet the on-touch threshold (3+
  consumers OR cross-router/scheduler OR factory over runtime dep)
  MUST go to `services/<name>.ts` rather than back into `index.ts`.

`domain/`, `repositories/`, `integrations/` remain **target folders** —
create them when the first real file lands; don't pre-seed empty
directories. Existing folders (`bootstrap/`, `lib/`, `middleware/`,
`notifications/`, `placements/`, `routes/`, `security/`, `telegram/`,
`uploads/`, `wishlists/`, `health/`, `schedulers/`, `services/`) cover
what already exists — new layers are added on demand.

**New backend code MUST NOT go into `index.ts`.** New endpoints land in
`routes/<domain>.routes.ts`; new cron jobs in `schedulers/<job>.ts`;
new cross-cutting helpers (3+ consumers, or routes+scheduler share)
in `services/<name>.ts`.

---

## Design system — MANDATORY for all UI work

WishBoard has a formal design system. Before touching any UI code:

1. **Read** [docs/design-system/UI_IMPLEMENTATION_RULES.md](docs/design-system/UI_IMPLEMENTATION_RULES.md) — the short, strict contract.
2. **Check the registry** — [docs/design-system/COMPONENT_REGISTRY.md](docs/design-system/COMPONENT_REGISTRY.md) records the status (`canonical` / `provisional` / `legacy` / `deprecated`) of every primitive and pattern family. Presence in code does **not** mean canonical.
3. **Look at approved mockups** — only [docs/design-system/mockups/approved/](docs/design-system/mockups/approved) is binding. `v2.1-refresh-all-screens.html` is the current canonical (v2.1, approved 2026-04-21); the `v2-*.html` set is approved-secondary for surfaces where v2.1 hasn't landed yet (Santa, group-gift, etc.). `mockups/proposed/` is input; `mockups/current-prod/` is reference.

### Skill bundle — `.claude/skills/wishboard-design/`

A self-contained mirror of the design system, auto-discovered as a Claude Skill (`name: wishboard-design`). Useful starting points:

- `.claude/skills/wishboard-design/colors_and_type.css` — drop-in CSS variables (v2.1)
- `.claude/skills/wishboard-design/preview/*.html` — 21 visual reference cards (**v2 archive** — see status notice in the bundle README)
- `.claude/skills/wishboard-design/ui_kits/miniapp/*` — interactive HTML/JSX prototypes (also v2 archive; `calendar/` sub-kit is a sketch for a not-yet-shipped feature)

**Source-of-truth rule:** the repo wins over the bundle. Tokens in `packages/ui-tokens/src/` and primitives in `packages/ui/src/` are canonical; the bundle mirrors them. If you find a divergence, fix the bundle, not the repo.

### Iron rule for new UI elements

If you need a UI primitive, token, or pattern that **isn't already in the design system**:

1. **Stop.** Do not improvise inline.
2. Build a mockup in `docs/design-system/mockups/proposed/` (HTML, inline CSS — see `feedback_html_mockups_inline_css.md` memory).
3. Surface the gap to the human owner and wait for approval.
4. Only after explicit approval: promote the mockup to `mockups/approved/`, add a `DESIGN_DECISIONS.md` entry, then add the primitive to `packages/ui/` and the token to `packages/ui-tokens/`.

This rule overrides any temptation to "just inline it for now" — there is no "for now" in the design system.

### Hard rules for UI implementation

- **No raw hex colors, no raw rgba, no arbitrary Tailwind values in new code.** Pull from [@wishlist/ui-tokens](packages/ui-tokens). If the value isn't there, add a semantic token first.
- **No feature-local clones of primitives.** Before writing any JSX that looks like a button/card/sheet/section-header/list-row/banner, import from `@wishlist/ui`:
  ```ts
  import { Button, Card, Sheet, SectionHeader, ListRow, Banner } from '@wishlist/ui';
  ```
- **Migrate on touch.** Any UI region you edit must land cleaner than you found it — swap inline styles for tokens, swap hand-rolled blocks for primitives.
- **Don't promote legacy to canonical by copying it.** Legacy patterns in `MiniApp.tsx` (30k-line monolith) are NOT a spec. If a pattern isn't in `packages/ui` or documented in `docs/design-system/COMPONENTS.md`, it's legacy — find the target direction in the registry or propose one.
- **Every interactive surface needs default / pressed / disabled / loading / error states.** Happy-path-only PRs are not ready to merge.
- **Tap targets ≥ 44 × 44.** `Button md` and `lg` already meet this. Icon-only buttons need explicit min size + `aria-label`.
- **Motion discipline.** Use canonical `transition.*` / `animation.*` tokens. Respect `prefers-reduced-motion` (handled in globals.css — don't override).

### Claude-specific rules

- **Before writing any inline style**, grep `packages/ui-tokens/src/*.ts` for the value. If it exists, use the token.
- **Before writing any component-ish JSX block**, check `packages/ui/src/index.ts`. If the primitive exists, import it.
- **Never introduce raw hex / rgba / magic spacing / radius numbers** in new code. If tempted, add a semantic token first.
- **"Match the mockup"** = open the actual HTML file from `docs/design-system/mockups/approved/` (never `proposed/` unless the user explicitly asks to prototype). Don't guess.
- **Creating a new primitive?** Add it to `packages/ui`, register in `docs/design-system/COMPONENT_REGISTRY.md` with `provisional` status, add a decision entry in `docs/design-system/DESIGN_DECISIONS.md`. Don't fold a new primitive into feature code.
- **Changing a primitive's status or a token's status** = entry in `DESIGN_DECISIONS.md` required. Don't change silently.

### Governance model — "controlled evolution"

- **Status model:** `legacy` / `provisional` / `canonical` / `deprecated`. Exists-in-code does NOT mean canonical. See [COMPONENT_REGISTRY.md](docs/design-system/COMPONENT_REGISTRY.md).
- **Mockup buckets:** `mockups/current-prod/` (reference), `mockups/proposed/` (candidates), `mockups/approved/` (binding). Only `approved/` drives canonical implementation.
- **All Phase-1 primitives (Button, Card, Sheet, SectionHeader, ListRow, Banner) are `provisional`** as of 2026-04-17. Do not treat them as canonical; they are extraction-from-current-prod, not approved-future-state.
- **Approval = explicit act**, logged in [DESIGN_DECISIONS.md](docs/design-system/DESIGN_DECISIONS.md). Move mockups to `approved/` only alongside a log entry.

### UI audit baseline

```bash
pnpm ui:audit
```

Reports raw-value counts (inline styles, hex colors, unique radius/spacing/shadow) in the Mini App monolith. Goal: monotonic decrease. A UI PR that raises the count in an already-migrated file is rejected.

### Design-system file map

- [packages/ui-tokens/](packages/ui-tokens) — tokens (colors, spacing, radius, shadows, motion, typography, z-index, sizing, gradients, safe-area, breakpoints)
- [packages/ui/](packages/ui) — primitives (Button, Card, Sheet, SectionHeader, ListRow, Banner)
- [docs/design-system/README.md](docs/design-system/README.md) — index
- [docs/design-system/FOUNDATIONS.md](docs/design-system/FOUNDATIONS.md) — token scales + principles
- [docs/design-system/COMPONENTS.md](docs/design-system/COMPONENTS.md) — when to use what
- [docs/design-system/SCREEN_PATTERNS.md](docs/design-system/SCREEN_PATTERNS.md) — recurring layouts
- [docs/design-system/UI_IMPLEMENTATION_RULES.md](docs/design-system/UI_IMPLEMENTATION_RULES.md) — strict rules
- [docs/design-system/INTERACTION_SYSTEM.md](docs/design-system/INTERACTION_SYSTEM.md) — motion, toasts, feedback
- [docs/design-system/MIGRATION_PLAYBOOK.md](docs/design-system/MIGRATION_PLAYBOOK.md) — legacy → primitives
- [docs/design-system/COMPONENT_REGISTRY.md](docs/design-system/COMPONENT_REGISTRY.md) — status per component
- [docs/design-system/DESIGN_DECISIONS.md](docs/design-system/DESIGN_DECISIONS.md) — chronological decision log
- [docs/design-system/mockups/](docs/design-system/mockups) — current-prod / proposed / approved

---

## Debugging & root-cause discipline — MANDATORY for every bug fix or behavior change

These rules apply to **every** investigation, regardless of how small the symptom looks. Violations almost always create regressions or compounding patches.

- **Do not fix symptoms before identifying the root cause.**
- **Fix at the source-of-truth (owner layer), not where the symptom appears.**
- **Avoid child-layer compensation** (fallbacks, patches, duplicated logic, branching).
- **Always do ultra-deep system research end-to-end before fixing:**
  - top-down: route → page → container → orchestration → state
  - bottom-up: function → hook → service → API → DB
- **Diagnose by layers:**
  - data/contracts → business logic → async/timing → UI state → integration → architecture
- **If a bug appears in a child, inspect the parent/owner layer first.**
- **When changing a mechanic, align all directly coupled layers:**
  - contracts, handlers, queries, cache, serializers, loading/error states
- **Be skeptical of one-file fixes; justify why other layers are unaffected.**
- **For frontend issues, inspect the full flow:**
  - route → layout → page → hooks → API → backend
- **Prefer systemic fixes, but keep changes proportional.**
- **If re-architecture is required, define scope, risks, compatibility, and rollout order** before touching code.

---

## Testing — MANDATORY for every PR

Testing stack: **vitest** across the monorepo. CI gate is
[`.github/workflows/test.yml`](.github/workflows/test.yml) — required by
`deploy.yml` via `needs: tests`, so a red test blocks production.

Roadmap and per-layer targets: [docs/TESTING_ROADMAP.md](docs/TESTING_ROADMAP.md).

### Iron rules — apply on every PR

- **Every bug fix ships with a regression test + `docs/BUGFIX_LESSONS.md`
  entry in the same commit** (per `feedback_bugfix_lessons.md` memory).
  The test must fail at the pre-fix commit and pass at the fix commit.
  Bundle them — back-to-back pushes double the deploy-restart window.
- **Every new state-changing API endpoint ships with a happy-path test
  + at least one error-path test.** No "I'll add tests later." Pick the
  scope: pure logic in `services/` → unit test with mocked Prisma;
  Prisma-shape-dependent behaviour → integration test against the real
  Postgres service (skipped locally when `DATABASE_URL` is not set,
  always runs in CI).
- **Every new pure helper / formula repeated ≥2× anywhere** is extracted
  to a named function (typically in `services/`) with a unit test. Inline
  duplicates of date math, regex, threshold comparisons, etc. are the
  single biggest source of bug recurrence we've measured — see the
  2026-05-15 BUGFIX_LESSONS entry (incomplete L5 fix discovery).
- **Never delete a failing test to make CI green.** The test is correct;
  the code is wrong, OR the test needs updating *with the same PR* that
  changes behaviour. Skipping a test (`it.skip`) requires a comment with
  the reason + an issue link / TODO. A skip without explanation gets
  rejected at review.
- **No new test file may use mocks where a real DB integration test
  would catch the bug class better.** Mock Prisma for pure-logic /
  branching tests; use the real Postgres service for P2002, transaction,
  index-coverage, and constraint-dependent behaviour. The 2026-04-30
  `getOrCreateProfile` race recurred *because* the original fix relied
  on mock-Prisma "upsert is atomic" — the integration test caught it
  only after a real Postgres write under contention.

### Running tests locally

```bash
pnpm test                          # full monorepo, no DB-dependent tests
pnpm -C apps/api test              # API only
pnpm -C apps/web test:watch        # frontend watch mode
pnpm test:coverage                 # per-package coverage report

# Integration tests with real DB (requires Docker locally):
docker compose -f docker-compose.dev.yml up -d postgres
docker exec wishlist-dev-postgres-1 psql -U wishlist -c "CREATE DATABASE wishlist_test;"
DATABASE_URL=postgresql://wishlist:wishlist@localhost:5432/wishlist_test \
  pnpm -C packages/db db:migrate:deploy
DATABASE_URL=postgresql://wishlist:wishlist@localhost:5432/wishlist_test \
  pnpm -C apps/api test
```

CI provides the Postgres service automatically; integration tests run there
without manual setup. See [apps/api/test/README.md](apps/api/test/README.md).

### Test infrastructure layout

- `apps/api/src/**/*.test.ts` — co-located unit tests next to the source.
- `apps/api/test/setup-pg.ts` — Prisma client + `resetDb()` for integration
  tests once they land.
- `apps/api/test/factories/index.ts` — User / Wishlist / Item builders.
- `packages/shared/src/**/*.test.ts` — shared lib unit tests.
- `apps/web/app/**/*.test.{ts,tsx}` — Mini App (jsdom + RTL when needed).
- `.github/workflows/test.yml` — Postgres service container, vitest, coverage.

### Pre-implementation checklist

Before writing code for a new feature, answer in addition to the security
+ architecture checklists:

- Which test file gets the new test? Existing or new?
- Pure unit or integration (real DB)?
- For bug fixes — does the test fail at the pre-fix commit?
- For new features — happy path + at least one error case?
