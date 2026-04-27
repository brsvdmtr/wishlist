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
