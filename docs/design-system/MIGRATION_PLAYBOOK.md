# Migration playbook

How to move legacy UI (mostly `MiniApp.tsx`, 30k lines, 3631 inline styles)
to the token + primitive system **safely and incrementally**.

This is not a rewrite plan. It's a discipline plan.

---

## Core principles

> **1. Migrate on touch.** Don't do a big-bang migration. Whenever you edit a
> region of `MiniApp.tsx`, leave that region cleaner than you found it —
> swap inline styles for tokens, swap hand-rolled elements for primitives.
>
> **2. "Legacy" is not "canonical."** Migrating _away_ from inline styles
> into a Phase-1 primitive moves code from `legacy` to `provisional`, not
> to `canonical`. Canonical status requires explicit approval (see
> [`DESIGN_DECISIONS.md`](./DESIGN_DECISIONS.md)).
>
> **3. Migration ≠ approval.** Don't assume the current shape of the legacy
> pattern is the target. When implementing a migrated surface, look at
> [`mockups/approved/`](./mockups/approved) first; if the surface doesn't
> have an approved mockup, the migrated output matches the provisional
> primitive's current contract and is still subject to redesign.

Backed by `pnpm ui:audit`, which reports raw-value counts and only ratchets
down over time.

---

## UI inventory (as of 2026-04-17)

Evidence-based; harvested from `MiniApp.tsx`:

| Pattern family | Unique variants | Abstraction today | Drift risk |
|----------------|----------------|-------------------|------------|
| Buttons | 10–15 | `btnBase / btnPrimary / btnSecondary / btnGhost` inline | **High** |
| Cards | ~6 | Inline styled `<div>`s | Moderate |
| Sheets / Modals | 6–8 | Inline styled `<div>`s | **High** |
| Banners | 3–4 | Inline styled `<div>`s | Moderate |
| List rows | ~4 | Inline styled `<div>`s | Moderate |
| Section headers | ~1 (consistent) | Inline styled `<div>`s | Low |
| Typography | 7–8 named roles | Implicit (no map) | **High** |
| Colors | 1 source of truth (`C = {...}`) | Well-abstracted | Very Low |
| Motion | 11 keyframes (global) | Well-centralized | Low |
| Toast | 1 system (`pushToast`) | Ad-hoc but consistent | Low |

Raw values in `MiniApp.tsx`:

- 3631 inline `style={{}}` objects,
- 337 hardcoded hex values,
- 1 Tailwind `className` (the rest is inline).

---

## Drift map — canonicalize vs deprecate

### Buttons (13 variants → 5 canonical + sizes)

- **Canonical:** `Button` variants `primary`, `primary-gradient`, `secondary`,
  `ghost`, `danger`; sizes `sm`, `md`, `lg`. See
  [`packages/ui/src/Button.tsx`](../../packages/ui/src/Button.tsx).
- **Deprecate:** `btnBase`, `btnPrimary`, `btnSecondary`, `btnGhost` constants
  in `MiniApp.tsx:645-653`. Kept in place until all call sites migrated (~200
  references) — then delete.
- **Merge:** every `<button style={{...}}>` with hand-rolled gradient →
  `variant="primary-gradient"`.
- **Legacy:** the handful of buttons with unique glow tuples stay as inline
  style until the surface is touched; then pick the nearest variant or add a
  new variant to the primitive.

### Cards (6 variants → 3 canonical)

- **Canonical:** `Card` variants `default`, `flat`, `interactive`.
- **Deprecate:** hand-rolled `<div style={{ background: C.card, borderRadius:
  14, padding: 16, border: ... }}>` — direct `<Card>` replacement.
- **Merge:** wish card, reservation card, profile card all share the
  same contract — differences are **content**, not card shape.
- **Legacy (leave):** custom cards that are part of a paywall hero (gradient
  fill, oversized radius) — those should evolve into the `Banner tone="promo"`
  + content pattern.

### Sheets / modals (8 types → 1 primitive + subpatterns)

- **Canonical:** `Sheet`.
- **Deprecate:** every hand-rolled `position: fixed; bottom: 0; ...`
  implementation.
- **Keep separate:** onboarding splashes (full-viewport, not bottom sheets)
  — those are a different pattern and get their own primitive in Phase 2
  (`OnboardingSplash`).
- **Dropdowns / context menus:** not a Sheet — their own primitive
  (`Menu`) in Phase 2.

### Banners (4 types → 5 tones on one primitive)

- **Canonical:** `Banner` tones `info`, `success`, `warning`, `danger`, `promo`.
- **Deprecate:** every tinted-background info strip and every gradient
  upsell tile.

### List rows (4 types → 3 variants)

- **Canonical:** `ListRow` variants `card`, `compact`, `plain`.
- **Deprecate:** hand-rolled flex rows inside cards.
- **Merge:** wishlist-item row, reservation row, subscription row — same
  shape, different content.

### Section headers (already consistent)

- **Canonical:** `SectionHeader`.
- **Deprecate:** the ~12 copies of `<div style={{ fontSize: 17, fontWeight:
  700, marginBottom: 16 }}>` — mechanical replacement.

### Typography (implicit scale → named roles)

- **Canonical:** `textStyles.*` roles.
- **Migration approach:** when touching text styles, replace
  `style={{ fontSize: 15, fontWeight: 600 }}` with the matching role. A
  codemod is feasible later (Phase 4).

---

## Migration waves

Priority = horizontal leverage first, then highest-visibility surfaces, then
long-tail. Each wave is a separate PR (or small batch of PRs) with visible
diff in `pnpm ui:audit` output.

### Wave 1 — horizontal primitives (highest leverage)

- `Button` adoption: replace `btnPrimary` / `btnSecondary` / `btnGhost` call
  sites. Start with the hottest 5 call-sites (reserve, save, cancel, add,
  delete), then expand.
- `Sheet` adoption: replace bottom-sheet scaffolding. 6 call sites.
- `SectionHeader` adoption: mechanical — ~12 call sites.
- `Banner` adoption: ~10 call sites for error / info strips.

**Goal:** end of Wave 1 → raw-value count drops ~20%. All new UI from here
on uses primitives.

### Wave 2 — high-visibility surfaces

- Paywall upsell sheet (promo, benefits list, CTA). Replace with
  `Sheet` + `Banner tone="promo"` + `ListRow variant="plain"` + `Button
  variant="primary-gradient" size="lg"`.
- Main list shell (wishlists home): replace list rows with `ListRow
  variant="card"`.
- Reservation list: replace rows with `ListRow variant="compact"`.
- Sticky CTA pattern: extract `<StickyCTA>` primitive (Phase 2 primitive
  addition) once wave 1 has validated the style.
- Loading / empty / error states on the home list: convert to the canonical
  patterns from `SCREEN_PATTERNS.md`.

### Wave 3 — secondary / long-tail

- Profile blocks, settings screens, subscription screens.
- Remaining ad-hoc pieces in rarely-visited surfaces (history, archive,
  secret reservations — these have good mockups already).

### Wave 4 — cleanup

- Delete `btnBase` / `btnPrimary` / `btnSecondary` / `btnGhost` once all call
  sites migrated.
- Delete the `C = {...}` constant once all references go through
  `@wishlist/ui-tokens`.
- Flip `pnpm ui:audit` target thresholds to "hard fail" if raw values rise.

---

## Safe migration recipe

For any given PR that touches UI:

1. **Identify the region** you're changing. Call it a "migration unit" —
   could be one component, one sheet, one section.
2. **Run `pnpm ui:audit`** and note the file-level count. That's your
   baseline.
3. **Plan the swap on paper.**
   - Which primitive will replace which inline block?
   - Which inline style becomes which token?
   - Are there variants missing? If yes, add them to `packages/ui` first.
4. **Swap the easiest tokens first** — colors are the safest: mechanical
   find/replace from `C.accent` → `colors.accent`.
5. **Swap the primitive** — one component at a time, verify the render
   hasn't changed visually (diff screenshot if possible; Phase 3 enables
   automatic visual regression).
6. **Re-run `pnpm ui:audit`** — the count must drop.
7. **Commit.** Small commits.

### Pitfalls

- **Don't rewrite logic while migrating styles.** If you need to change
  behavior, do it in a separate commit / PR.
- **Don't add new primitives mid-migration.** Extract primitives in their own
  PRs so other migrations can consume them.
- **Don't migrate everything you see.** Scope creep kills the migration.
  Migrate the region you're already touching.
- **Beware of hidden state.** Some inline styles depend on variables
  (`opacity: purchased ? 0.5 : 1`). The new primitive must preserve them
  (e.g. `ListRow muted={purchased}`).
- **Beware of z-index neighborhoods.** A `Sheet` uses `zIndex.sheet` (101).
  If the surrounding page has custom `zIndex: 105` blocks, check interactions.

---

## Choosing migration candidates

**Good candidates:**

- High visibility (seen often by users).
- Low behavioral complexity (styling-heavy, logic-light).
- Backed by an approved mockup in `docs/design-system/mockups/`.

**Bad candidates (defer):**

- Onboarding flows (many conditional paths, high regression risk — migrate
  once stable).
- Santa/campaign flows (complex state machines).
- Any surface being actively redesigned (wait for new mockup).

---

## Validation after migration

Until Phase 3 visual regression lands, rely on:

- Manual: run the app on the phone, touch the migrated flow end-to-end.
- `npx tsc --project apps/web/tsconfig.json --noEmit` — the baseline check.
- `pnpm ui:audit` — raw-value count must not rise.
- Compare against the mockup in `docs/design-system/mockups/`.

Phase 3 plans:

- Playwright renders the Mini App in a test runner with mocked Telegram
  WebApp bridge.
- Baseline screenshots live in `docs/design-system/mockups/baselines/`.
- CI diffs per-commit; flagged diffs require a new baseline via an
  "approve baseline" workflow.

---

## When a migration can't finish safely

If you start migrating a region and find a behavioral bug / dependency
you can't resolve in the same PR:

- Revert the style changes in that region for the PR.
- Open a follow-up note in `docs/design-system/MIGRATION_PLAYBOOK.md` under
  "Known blockers" (section below).
- Keep shipping the feature change the PR was really about.

---

## Known blockers (empty — add as they appear)

_None yet. Add entries as PRs surface migration hazards._
