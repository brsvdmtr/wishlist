# Banner Wave 1 — adoption plan (PRE-EXECUTION)

> **Status:** PREPARED, execution paused until Button Wave 1 observation
> completes and haptic policy lands. Not a specification — a plan for the
> next PR.
>
> Banner remains `provisional` through this wave. Promotion of neutral
> tones (`info` / `success` / `warning` / `danger`) is a post-wave
> decision, typically packaged with this wave's PR if the validation is
> clean.

## Goal

Migrate 3–5 real Banner-shaped call-sites in `MiniApp.tsx` from inline
tinted-strip patterns to `<Banner>` primitive, validating the 4 neutral
tones (info / success / warning / danger) against real product usage.

**Out of scope:**
- `tone="promo"` — needs own paywall-wave mockup-driven validation
- Chip-shaped tinted pills (those are `Chip`, not Banner)
- Button-shaped tinted surfaces (`btnBase + C.redSoft` confirm buttons —
  those are Button-variant gap #2 "danger-solid")

## Candidate call-sites (recon'd 2026-04-19)

Banner-shape detection: `background: *Soft + padding ≥ 10-14px +
borderRadius + not inline-block`.

### Tier-1 (highest confidence, clean migration)

| # | File:line | Current pattern | → Migrate to |
|---|-----------|-----------------|--------------|
| 1 | `MiniApp.tsx:14353` | `padding: '12px 14px', borderRadius: 12, display: flex, gap: 10, background: C.greenSoft, border: '1px solid ${C.green}18'` — success confirmation with icon | `<Banner tone="success" icon={...}>` |
| 2 | `MiniApp.tsx:~3079` | `background: C.orangeSoft, padding: '8px 14px', borderRadius: 12, margin: '0 14px 10px'` — warning strip | `<Banner tone="warning">` |
| 3 | `MiniApp.tsx:~2958` | `background: C.redSoft, border: '1px solid rgba(248,113,113,0.3)'` — danger notice | `<Banner tone="danger">` |
| 4 | `MiniApp.tsx:~13692` | `background: C.orangeSoft, color: C.orange, lineHeight: 1.5` — warning text block (needs context re-read) | `<Banner tone="warning">` |

### Tier-2 (likely candidates, need deeper context read before migration)

Exist but need to verify they're actual banners (info strips) vs chips
(status badges). Deferred unless Tier-1 doesn't yield 3+ clean migrations.

- Accent-soft banner candidates — need grep narrowed to banner-shape
  paddings.
- Secret-reservation inline info strips.
- Don't-gift summary banner (approved mockup has it — need to find the
  current-prod counterpart).

### Existing Banner call-site

1 already in prod from Phase 1 proof-of-use:

- `MiniApp.tsx:~29726` — share-link error → `<Banner tone="danger" center>`

## Tone coverage target

Wave 1 goal is **≥ 1 migration per neutral tone** (4 tones) to validate
the tone contract under real-data conditions. If 2 of the 4 neutral
tones don't have clean Tier-1 candidates after deeper recon, acceptable
to ship Wave 1 with 3 tones and plan Wave 2 for the missing ones.

| Tone | Target count | Current Tier-1 candidates |
|------|--------------|---------------------------|
| `info` | 1 | _(need further recon; accent-soft banner-shapes)_ |
| `success` | 1 | #1 (14353) |
| `warning` | 1–2 | #2 (3079), #4 (13692) |
| `danger` | 1 | #3 (2958) + existing Phase-1 Banner at 29726 already deployed |

## Expected API gaps

Before migration I already know these may surface:

1. **Optional border.** Some prod call-sites have `border: '1px solid
   rgba(*, 0.2-0.3)'`. My Banner doesn't encode this. Approved mockup
   `v2-wishlist-detail-guest.html` (don't-gift block) has a border.
   Candidate solutions: (a) add border by default to all tones, (b)
   add `bordered?: boolean` prop, (c) keep as `style` override. **Lean
   toward (a)** — matches approved mockup + approved v2 state-matrix
   tinted cards. Will evaluate during migration.

2. **Text-color vs full-body-color.** My Banner sets `color: tone-fg`
   (banner-wide text color). Some prod call-sites have muted body text
   (textSecondary) inside a tinted banner, with only title in tone-color.
   If ≥ 2 call-sites want this, add a separate prop or use `title` +
   `children` split (title auto-colored, children can be neutral).

3. **Compact vs regular density.** Some inline info strips use
   `padding: '8px 14px'` (compact). My Banner defaults to `12px 14px`.
   Decision: accept the tighter padding as visual shift OR add
   `compact?: boolean`. Lean toward accepting shift for consistency.

4. **Inline icon sizing.** Prod icons vary 14–16 px. Banner uses 16 px
   fixed. Small deltas — acceptable.

## Sequencing after Button Wave 1 observation

### Pre-condition (GO / NO-GO)

- Button haptic policy decided (Option A / B / C from `HAPTIC_POLICY_PROPOSAL.md`).
- No Button visual regressions flagged in observation.
- No TypeScript errors in prod deploy.

If pre-condition passes → execute this plan as the next main PR.

### Execution checklist (when go-signal arrives)

1. **Deep recon** — reread Tier-1 candidate contexts to confirm they're
   Banner-shape, not Chip-shape or card-shape.
2. **Decide border contract** — examine 4+ approved mockup banners and
   decide: always-border / optional / never.
3. **Primitive adjustment** (if needed) — add `bordered` or change default;
   update COMPONENTS.md + DESIGN_DECISIONS entry (`primitive-change`).
4. **Migrate 3–5 call-sites** — keep onClick/behavior stable; document
   any skipped candidates with rationale.
5. **TypeScript check** — `npx tsc --project apps/web/tsconfig.json --noEmit`.
6. **UI audit delta** — `pnpm ui:audit`.
7. **Decision entry** — `DESIGN_DECISIONS.md` "Banner Wave 1 adoption"
   with tone validation table + gaps.
8. **Registry update** — per-tone `canBePromotedToCanonical` evaluation.

## Success criteria

- ≥ 3 call-sites migrated across ≥ 3 neutral tones.
- TypeScript clean.
- ui:audit inline-style delta ≤ 0 (decrease or equal).
- Any visual shifts (padding / border / density) documented with
  rationale in DESIGN_DECISIONS.
- Border contract for Banner neutral tones resolved (decision logged).

## Promotion path after Wave 1

If Wave 1 ships cleanly with ≥ 1 call-site per neutral tone:

- **Promote 4 neutral tones** (`info` / `success` / `warning` / `danger`)
  to **`canonical`** in the same PR (consolidating promotion with
  adoption is efficient when validation is clean).
- **`promo` tone stays `provisional`** — needs paywall / upsell migration
  wave before promotion.

If Wave 1 surfaces unexpected API gaps that can't be closed in the same
PR, ship the adoption and defer promotion to a follow-up PR.

## Coupling to Button Wave 1

This plan assumes Button's `haptic` / `danger-variant` / `primary-gradient`
gaps are tracked but NOT blocking Banner. Banner and Button are
orthogonal primitives — Banner Wave 1 can ship regardless of Button's
canonical status.

However, if Button Wave 1 observation reveals a deeper "interaction voice"
issue (e.g., haptic feel + visual tone need unification), the user may
elect to detour through **Toast mockup first** instead. This plan stays
filed for when that detour completes.
