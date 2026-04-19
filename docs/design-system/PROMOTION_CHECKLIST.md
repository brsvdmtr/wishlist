# Promotion checklist

How a primitive or pattern moves between statuses. Every status transition is
a decision recorded in [`DESIGN_DECISIONS.md`](./DESIGN_DECISIONS.md).

## Status model

```
  legacy                                           deprecated
    │                                                   ▲
    │ extract                                           │ replace with canonical
    ▼                                                   │
  provisional  ⇄  provisional-needs-redesign  →→→→  canonical
                                                       │
                                                       ▼
                                                  superseded → (new canonical)
```

| Status | Meaning | Allowed to consume? | Can new features build on it? |
|--------|---------|---------------------|-------------------------------|
| `legacy` | Exists in code, works, not the target direction | Only if you're migrating it on touch | No — pattern-match on the registry target instead |
| `provisional` | Extracted, usable, API may evolve, contract is reasonable | **Yes** — default path for new UI during Phase 1/2 | Yes, with awareness that minor evolution is possible |
| `provisional-needs-redesign` | Structurally in `packages/ui`, but visuals/behavior are not yet acceptable as target. Safe as a bridge, not a destination. | Only if no better option exists; prefer not to | No — do not build long-term on it; flag in PR description |
| `canonical` | Explicitly approved as target state | **Yes — preferred** | Yes |
| `deprecated` | Replacement exists (canonical or better provisional); scheduled for removal | Not in new code | No |

## Criteria for `provisional` → `canonical` (promotion)

A promotion PR must tick every box below. Missing even one → stay provisional.

- [ ] **Approval source** — one of:
  - [ ] Approved mockup in [`mockups/approved/`](./mockups/approved) that this
        primitive implements (preferred), **or**
  - [ ] Explicit owner approval recorded in this PR's
        `DESIGN_DECISIONS.md` entry, with the phrase "approved as canonical
        target" and a reason.
- [ ] **Stable API** — the primitive's props haven't changed in the last 2
      PRs that used it. If they have, extend the provisional period.
- [ ] **Real usage** — used in **≥ 3** distinct call-sites in the app, not
      counting the file it was extracted from. Show the grep result in the
      PR.
- [ ] **Long-text behavior reviewed** — a screenshot or description of how
      the primitive handles the longest plausible content (title that wraps,
      description that ellipsizes, button label at ≥ 30 chars).
- [ ] **Mobile behavior reviewed** — screenshot at 375 × 812. If layout
      depends on viewport width, also 320 × 568.
- [ ] **Interaction reviewed** (if interactive) — default, pressed, focused,
      disabled, loading, error states. Link the screenshot / Storybook.
- [ ] **RTL reviewed** (if directional) — screenshot or confirmation the
      layout mirrors correctly.
- [ ] **Migration / supersession note** — which legacy pattern this now
      supersedes. Registry row for the legacy pattern must be updated to
      `deprecated` (or remain `legacy` if mass-migration isn't scoped yet,
      but with a note).
- [ ] **`DESIGN_DECISIONS.md` entry** — typed `approval` or `status-change`,
      naming the primitive, dated, with owner name.
- [ ] **Registry fields updated** — `status`, `approvalSource`,
      `targetVisualDirection`, `canBePromotedToCanonical: true` becomes
      `— (already canonical)`, `promotionBlockers: []`.

## Criteria for `provisional-needs-redesign` → `canonical`

All of the promotion criteria above, **plus**:

- [ ] **Redesign completed** — explicitly approved mockup in `mockups/approved/`
      drives the new shape.
- [ ] **Visible improvements verified** — screenshot comparison
      (before / after) included in the PR.
- [ ] **No residual drift** — the component fully implements the approved
      mockup; no "good enough" compromises.

## Criteria for `provisional` → `provisional-needs-redesign` (downgrade)

When a primitive is used in the wild and the result is judged visually
unacceptable, downgrade rather than leave it `provisional`:

- [ ] **Specific deficiency named** — "padding feels cramped vs. approved
      mockup X"; "press state feedback insufficient"; "doesn't support the
      secondary layout mockup Y shows."
- [ ] **Blocker recorded in registry** — `promotionBlockers: [...]`.
- [ ] **Target mockup referenced** if one exists; if not, add an item to the
      decision backlog ("produce mockup for ...").
- [ ] **`DESIGN_DECISIONS.md` entry** logs the downgrade and why.

Downgrade is **not** a failure — it's honest state tracking. It tells future
PR authors "don't build long-term on this."

## Criteria for `legacy` → `provisional`

When a pattern in `MiniApp.tsx` gets extracted into `packages/ui`:

- [ ] **Extraction PR** with the new primitive in `packages/ui/src/`.
- [ ] **Registry row added** with `status: provisional`.
- [ ] **Legacy row status** either stays `legacy` (if not yet migrating
      call-sites) or moves to `deprecated` (if migration is in-progress or
      complete).
- [ ] **`@status provisional` JSDoc** on the new primitive.
- [ ] **Proof-of-use** — at least one real call-site using the new primitive
      in the same PR or a tightly-coupled follow-up.

## Criteria for `*` → `deprecated`

- [ ] **A replacement exists** — registry rows linked.
- [ ] **Migration path** documented in `MIGRATION_PLAYBOOK.md` or the
      decision entry.
- [ ] **Retirement date** (soft — can slip) recorded in the decision entry.

## Criteria for `deprecated` → _removed_ (delete from code)

- [ ] **Zero remaining usages.** Grep evidence in the PR.
- [ ] **Decision entry** noting removal.
- [ ] **Registry row** marked as deleted (row kept for history with a
      strikethrough, or row removed — either is acceptable).

---

## Operational flow for mockup-driven canonicalization

Exact steps, in order:

### Step 1 — Propose

- A new HTML mockup is added to [`mockups/proposed/`](./mockups/proposed).
- A row may be added to `COMPONENT_REGISTRY.md` with
  `targetVisualDirection: "see mockups/proposed/foo.html"` — but the primitive's
  status does not change yet.
- Team/owner discusses.

### Step 2 — Approve (or reject)

**If rejected:** the mockup stays in `proposed/` or is deleted; no further
action.

**If approved:**

1. File moves from `mockups/proposed/foo.html` → `mockups/approved/foo.html`.
   (Use `git mv` to preserve history.)
2. A new entry is added to `DESIGN_DECISIONS.md`:
   - Type: `approval`
   - Names the mockup file
   - Names what was approved (feature / pattern / surface)
   - Supersedes: links any previously-approved mockup this replaces
   - Approved by
3. If the approved mockup supersedes a previous `approved/` mockup, the old
   file moves to an `approved/archive/` subfolder (or is renamed
   `foo-v1.html`) — `approved/` must always reflect the current source of
   truth.

### Step 3 — Align components and tokens

Once approved:

1. The matching `COMPONENT_REGISTRY.md` row's `targetVisualDirection`
   updates to point at the approved mockup path.
2. If the current primitive implementation doesn't match the mockup, the
   row's `status` stays `provisional` (or moves to
   `provisional-needs-redesign` if the gap is structural).
3. A follow-up PR implements the mockup: updates tokens, updates primitive
   code, adds stories. That PR includes:
   - Code changes
   - Screenshot evidence that implementation matches mockup
   - `DESIGN_DECISIONS.md` entry (type: `primitive-change` or
     `token-change`)

### Step 4 — Promote

After implementation matches the approved mockup **and** the promotion
checklist above is complete, a separate (or combined, for small primitives)
PR flips the status to `canonical`.

### Step 5 — Deprecate the replaced pattern

In the same PR that flips to canonical, update the registry row(s) for any
legacy/provisional pattern the new canonical replaces:

- Status → `deprecated`
- Add `migrationNotes` pointing at the canonical row + the relevant
  `MIGRATION_PLAYBOOK.md` section.
- If the deprecated pattern still has many call-sites, add it to the
  migration backlog; retirement date is a soft goal.

## Anti-patterns (do not do this)

- ❌ **"Our current button matches the accent color so let's promote" —**
  matching current prod is not enough. Approval is an explicit act against a
  target, not a ratification of current state.
- ❌ **Silent status changes** — never edit `COMPONENT_REGISTRY.md` without
  also adding a `DESIGN_DECISIONS.md` entry.
- ❌ **Approving mockups verbally in Slack without moving the file** — if
  the file isn't in `approved/`, it's not approved.
- ❌ **Promoting to canonical to unblock a feature PR** — features build on
  provisional freely; promotion is its own decision with its own PR.
- ❌ **"Canonical means frozen"** — no. Canonical can evolve via supersession
  (step 2 workflow). The design system is evolvable by design.
