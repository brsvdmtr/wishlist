# WishBoard Design System

Canonical design foundation for the WishBoard Telegram Mini App. Tokens,
primitives, docs and rules that every new piece of UI in the repo must follow.

## Where things live

| Concern | Location |
|---------|----------|
| **🌟 UI North Star** — top-level visual vision (APPROVED 2026-04-19) | [`./NORTH_STAR.md`](./NORTH_STAR.md) |
| **📋 Feature inventory** — authoritative feature surface map (48 screens, 3 home tabs, 19 PRO features) | [`./FEATURE_INVENTORY.md`](./FEATURE_INVENTORY.md) |
| 📝 Haptic policy proposal (pending owner pick) | [`./HAPTIC_POLICY_PROPOSAL.md`](./HAPTIC_POLICY_PROPOSAL.md) |
| 📝 Banner Wave 1 plan (prepared, pending go-signal) | [`./BANNER_WAVE_1_PLAN.md`](./BANNER_WAVE_1_PLAN.md) |
| Design tokens (colors, spacing, radius, shadows, motion, etc.) | [`packages/ui-tokens/`](../../packages/ui-tokens) |
| Reusable UI primitives (Button, Card, Sheet, ...) | [`packages/ui/`](../../packages/ui) |
| Visual specs — split by status (proposed / approved / current-prod) | [`./mockups/`](./mockups) |
| **Component registry** (status per primitive & pattern) | [`./COMPONENT_REGISTRY.md`](./COMPONENT_REGISTRY.md) |
| **Promotion checklist** (provisional → canonical) | [`./PROMOTION_CHECKLIST.md`](./PROMOTION_CHECKLIST.md) |
| **Design decisions log** (status changes, approvals) | [`./DESIGN_DECISIONS.md`](./DESIGN_DECISIONS.md) |
| Foundations docs (scales, principles) | [`./FOUNDATIONS.md`](./FOUNDATIONS.md) |
| Component docs (when to use what) | [`./COMPONENTS.md`](./COMPONENTS.md) |
| Screen pattern docs | [`./SCREEN_PATTERNS.md`](./SCREEN_PATTERNS.md) |
| Implementation rules (developers & Claude) | [`./UI_IMPLEMENTATION_RULES.md`](./UI_IMPLEMENTATION_RULES.md) |
| Interaction system (motion, toasts, feedback) | [`./INTERACTION_SYSTEM.md`](./INTERACTION_SYSTEM.md) |
| Migration playbook (legacy → tokens/primitives) | [`./MIGRATION_PLAYBOOK.md`](./MIGRATION_PLAYBOOK.md) |

## Document hierarchy

```
NORTH_STAR.md                ← character, principles, target direction
        │
        ▼
mockups/approved/            ← concrete visual spec per surface
        │
        ▼
COMPONENT_REGISTRY.md        ← status, blockers, promotion readiness
        │
        ▼
FOUNDATIONS / COMPONENTS     ← implementation contracts
packages/ui-tokens, ui/
```

The North Star sits above everything. Every approved mockup, every canonical
promotion, every new primitive must trace back to the character and
direction it codifies.

## Start here

1. Read [`NORTH_STAR.md`](./NORTH_STAR.md) — the visual character and
   direction the product is moving toward. Everything below serves this.
2. Read [`UI_IMPLEMENTATION_RULES.md`](./UI_IMPLEMENTATION_RULES.md) — the
   short, strict contract every PR must follow.
3. Check [`COMPONENT_REGISTRY.md`](./COMPONENT_REGISTRY.md) for the status of
   every primitive and pattern family before relying on it.
4. When building a new screen, scan [`SCREEN_PATTERNS.md`](./SCREEN_PATTERNS.md)
   to see if a pattern already exists.
5. When building new UI, pick primitives from [`COMPONENTS.md`](./COMPONENTS.md).
6. Never put a raw color/spacing/radius value in a component — pull from
   [`@wishlist/ui-tokens`](../../packages/ui-tokens).

## Governance model (read this)

The design system is a **mechanism of controlled evolution**, not an archive
of today's patterns. Three rules:

- **"It exists in code" ≠ "it's canonical."** Every primitive and pattern has
  a status in [`COMPONENT_REGISTRY.md`](./COMPONENT_REGISTRY.md):
  `legacy` / `provisional` / `canonical` / `deprecated`. Status changes are
  logged in [`DESIGN_DECISIONS.md`](./DESIGN_DECISIONS.md).
- **Mockups are bucketed by status.** [`./mockups/proposed/`](./mockups/proposed)
  is input for discussion, [`./mockups/approved/`](./mockups/approved) is the
  source of truth for implementation, [`./mockups/current-prod/`](./mockups/current-prod)
  is reference material. Moving between buckets is a product decision with
  a log entry.
- **Phase 1 primitives start `provisional`.** They were extracted from
  current prod to stop drift, not because their current shape was approved.
  Approval happens mockup-by-mockup via the decision log.

## Running the audit

```bash
pnpm ui:audit
```

Reports the current count of inline `style` objects, raw hex values, unique
radius/spacing/shadow values still present in the Mini App monolith. Baseline
metric for the migration plan in
[`MIGRATION_PLAYBOOK.md`](./MIGRATION_PLAYBOOK.md).

## Phase plan

- **Phase 1 (done):** tokens, primitives, docs, audit script, 2–3 proof-of-use
  integrations.
- **Phase 2:** Storybook (in `apps/web/.storybook`), stories for all six
  primitives, gradual migration of paywall + list-row patterns.
- **Phase 3:** Playwright screenshot diffs in CI against baselines generated
  from the mockups in [`./mockups/`](./mockups).
- **Phase 4:** ESLint rule banning raw hex + arbitrary Tailwind values in
  touched files; `no-new-raw-values` enforcement.
