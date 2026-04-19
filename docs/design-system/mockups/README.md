# Mockups — three-bucket governance

Mockups are separated by **status**, not by feature. A file's physical
location encodes what is (and isn't) a source of truth.

```
mockups/
├── current-prod/   ← reference snapshots of what's shipped
├── proposed/       ← candidate designs, not yet approved
└── approved/       ← designs explicitly approved as canonical target
```

> **A mockup's presence in this repo does not make it canonical.**
> Only files in `approved/` are binding. `proposed/` is input for product
> discussion. `current-prod/` is for audit/comparison, never an aspiration.

## Bucket definitions

### `current-prod/`

Read-only HTML snapshots of what the app currently ships. Useful for:

- reviewing drift between what was designed and what was implemented,
- providing a starting reference when proposing an upgrade,
- regression baselines for Phase 3 visual diffs of _current_ surfaces.

**Do not edit files here to fix bugs** — fix the code and recapture.

### `proposed/`

New design proposals not yet approved. May include:

- redesigns of existing surfaces,
- feature-new mockups,
- multiple competing variants (`foo-v1.html`, `foo-v2.html`).

**Do not implement a `proposed/` mockup as if it were approved.** Proposals
inform conversation; approval is a separate act logged in
[`../DESIGN_DECISIONS.md`](../DESIGN_DECISIONS.md).

### `approved/`

Designs explicitly approved as the canonical target state. Moving a file
here is a **product decision**, documented in
[`../DESIGN_DECISIONS.md`](../DESIGN_DECISIONS.md).

When a mockup is approved:

1. It moves from `proposed/` (or `current-prod/`) into `approved/`.
2. A decision entry is added to `../DESIGN_DECISIONS.md` with:
   - what was approved,
   - what it supersedes (if any),
   - who approved and when.
3. The matching entry in [`../COMPONENT_REGISTRY.md`](../COMPONENT_REGISTRY.md)
   is updated: the target direction points here, and the previous pattern is
   marked `legacy` or `deprecated`.
4. If primitives or tokens need to change to match, that's tracked as a
   separate migration PR.

## Current index

As of 2026-04-19:

- **`approved/`** contains 11 North Star v2 mockups — binding visual spec.
  See [`./approved/README.md`](./approved/README.md).
- **`proposed/`** contains 17 earlier feature mockups (pre-North-Star).
  They are candidates / references — none approved. See
  [`./proposed/README.md`](./proposed/README.md).
- **`current-prod/`** is empty — reference snapshots to be added as
  migration surfaces enter Phase 2.

See [`../COMPONENT_REGISTRY.md`](../COMPONENT_REGISTRY.md) for how each
surface maps to primitive status.

## Approving a mockup (workflow)

1. Product/design identifies a `proposed/` mockup as the target.
2. A PR moves the file(s) to `approved/` and:
   - adds an entry to `../DESIGN_DECISIONS.md`,
   - updates the relevant row in `../COMPONENT_REGISTRY.md`,
   - flags any primitive / token work required to align.
3. Implementation happens in a follow-up PR. Until implementation lands,
   the component's status stays `legacy` or `provisional`; only when
   implementation matches the approved mockup does the component become
   `canonical`.

## Anti-patterns

- ❌ Treating every HTML in this directory as equivalent. Location matters.
- ❌ Moving a file to `approved/` without a decision log entry.
- ❌ Silently editing an `approved/` file — approved designs are immutable;
  if they need to change, create a new proposal, then re-approve.
