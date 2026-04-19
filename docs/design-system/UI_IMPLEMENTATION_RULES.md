# UI Implementation Rules

Strict, short, and non-negotiable. These rules apply to every human and every
AI agent touching UI code in this repo. A PR that violates them should not
land.

---

## Rule 0 — The core principle

> **New visual values are not allowed when a token exists. Feature-local
> clones of canonical primitives are not allowed when the primitive exists.**

Legacy code stays as it is until migrated (see
[`MIGRATION_PLAYBOOK.md`](./MIGRATION_PLAYBOOK.md)), but **no new visual debt
is added**.

---

## Rule 1 — Tokens only, no raw values

- ❌ `style={{ color: '#7C6AFF' }}` — use `colors.accent`.
- ❌ `style={{ padding: 13 }}` — pick the nearest scale value from `spacing`.
- ❌ `style={{ borderRadius: 18 }}` — use `radius.xl` (14) or `radius.xxl` (16).
- ❌ `className="bg-[#7C6AFF]"` — use `bg-accent` (Tailwind token).
- ❌ `className="p-[13px]"` — arbitrary Tailwind values are banned in new code.

### Escape hatch

There is **one** escape hatch: if a mockup calls for a value that is genuinely
outside the scale and the design decision has been validated, add a new
**semantic** token to `packages/ui-tokens` (with a one-line comment on its
role), then consume it. Don't inline the raw value.

### Detection

`pnpm ui:audit` reports the current raw-value count per file. The goal is
**monotonic decrease** — a PR that raises the count in an already-migrated
file is rejected.

---

## Rule 2 — Primitives only, no clones

Before writing a new component:

1. Search `packages/ui/src/` for an existing one.
2. Search `docs/design-system/COMPONENTS.md` for a documented primitive.
3. Search the MiniApp monolith for a similar inline pattern — if the pattern
   already exists inline, the correct fix is often to **extract** it into
   `packages/ui`, not to duplicate it.

If a primitive needs a new variant, add the variant to the primitive — don't
create a sibling component.

### Examples of banned clones

- ❌ `PaywallButton` — use `<Button variant="primary-gradient" size="lg">`.
- ❌ `WishCard` with hand-rolled `style={{ borderRadius: 14, padding: 16, ...}}` — use `<ListRow variant="card">`.
- ❌ `CustomBottomSheet` — use `<Sheet>`. If you need a variant the current
  `Sheet` doesn't have (e.g. a right-side drawer), **extend** `Sheet`.

---

## Rule 3 — Touched UI must migrate

If your PR touches a screen or component in `MiniApp.tsx`, the visual values
you change in that touched region must come from tokens, and any inline
pattern that already has a primitive equivalent should be replaced.

**In plain terms:** you don't have to migrate the whole file, but the lines
you edit must land clean. "Migrate on touch."

---

## Rule 4 — All states, not just the happy path

Every new interactive surface ships with:

- default state,
- pressed / focused state (visually distinct — focus ring via `shadows.ringFocus`),
- disabled state (opacity 0.55, cursor `not-allowed`),
- loading state if async (spinner via `Button loading` or skeleton block),
- empty state if the surface shows a collection,
- error state if the surface fetches data.

Merging a PR with only the default state is not acceptable for new screens.

---

## Rule 5 — Long-text behavior

Every text region that can receive user input must handle:

- long single-word strings (`overflow-wrap: anywhere` for description fields),
- 2-line ellipsis for titles (`WebkitLineClamp: 2`),
- overflow ellipsis for single-line secondary text,
- RTL locales (see [FOUNDATIONS.md — RTL](./FOUNDATIONS.md#rtl)).

Don't hide overflow by shrinking fonts. Use truncation + tooltips / detail
screens for full content.

---

## Rule 6 — Tap targets & accessibility

- Every tappable element must be ≥ 44 × 44 (Apple HIG). `Button` sizes `md`
  and `lg` already meet this. Icon buttons must set explicit min-width / height.
- `aria-label` on icon-only buttons.
- Role + aria-modal on sheets (the `Sheet` primitive handles this).
- Keyboard focus must be visible (focus ring via `shadows.ringFocus`). Don't
  set `outline: none` without a replacement focus indicator.
- Screen-reader order should match visual order — no absolute positioning
  that swaps logical order.

---

## Rule 7 — Motion discipline

- Use canonical `transition.*` / `animation.*` tokens. Don't write custom
  transition strings unless you've documented why in a code comment.
- Respect `prefers-reduced-motion` — the global CSS in
  [`globals.css`](../../apps/web/app/globals.css) already short-circuits
  animations; don't re-enable them inside your component.
- Entrance animations only for surfaces that _appear_ (sheets, toasts, newly
  inserted list items). Don't animate every render.
- No parallax, no cinematic effects. Motion is functional, not decorative.

---

## Rule 8 — One sticky CTA per screen

- A screen has at most one sticky primary action at the bottom.
- Use the [sticky CTA pattern from SCREEN_PATTERNS](./SCREEN_PATTERNS.md#pattern-1-header--scrolling-content--sticky-cta).
- Content must have bottom padding ≥ 96 px so the last row isn't hidden.

---

## Rule 9 — Safe area always

Any fixed-to-bottom region (sticky CTA, tab bar, toast container, sheet)
respects `safeArea.*`. Never inline `env(safe-area-inset-bottom)` — the
helper tokens already do it.

---

## Rule 10 — PR checklist

Every UI PR includes in its description:

- link to the mockup in `docs/design-system/mockups/` (if applicable),
- list of primitives used / modified,
- mobile screenshot(s) at 375 × 812,
- confirmation that long text / empty / loading / error states were checked.

See [`.github/PULL_REQUEST_TEMPLATE.md`](../../.github/PULL_REQUEST_TEMPLATE.md).

---

## Claude-specific rules

A Claude / codegen agent generating UI in this repo must follow every rule
above, **plus**:

1. **Before writing any inline style**, grep for the value in
   `packages/ui-tokens/src/*.ts`. If it's there, use the token.
2. **Before writing any component-ish JSX block**, check
   `packages/ui/src/index.ts`. If the primitive exists, import it.
3. **Before adding a new component**, check `COMPONENTS.md`. If the pattern
   is documented (even as "not yet extracted"), implement as documented —
   don't invent a new shape.
4. **Never** introduce raw hex values, raw `rgba(...)` strings, or magic
   spacing/radius numbers in new code. If tempted, add a token first.
5. **Never** copy-paste a block from `MiniApp.tsx` without either (a)
   refactoring it to use tokens / primitives as you go, or (b) explicitly
   flagging in your response that you're preserving legacy inline styles and
   why (rare — requires a concrete reason).
6. When asked to "match the mockup," actually open the HTML file from
   `docs/design-system/mockups/` and read the styles — don't guess.
7. Prefer extending a primitive in `packages/ui` over hand-rolling something
   in `MiniApp.tsx`. If a PR would add 40 lines of styled JSX for a single
   button variant, the PR should instead add a `Button` variant (10 lines)
   and call it.
8. When a mockup and the current code conflict, the mockup wins unless the
   human explicitly says otherwise.

---

## Status discipline

"It exists in code" does **not** mean "it's canonical." Every primitive and
every pattern has a **status** recorded in
[`COMPONENT_REGISTRY.md`](./COMPONENT_REGISTRY.md):

- `canonical` — approved, depend on it freely.
- `provisional` — in `packages/ui`, usable, but not yet approved as the
  final direction. All Phase-1 primitives start here.
- `legacy` — lives in `MiniApp.tsx`, still working, **do not pattern-match
  on it for new code**. Migrate on touch.
- `deprecated` — do not add new usages.

**Rules:**

1. Before using a primitive, check its registry row.
2. If the registry doesn't list it, add a row before the PR merges.
3. Promoting a primitive to `canonical` requires an entry in
   [`DESIGN_DECISIONS.md`](./DESIGN_DECISIONS.md) — typically backed by a
   mockup in [`mockups/approved/`](./mockups/approved).
4. A legacy pattern is not a spec. When implementing a new screen, do not
   copy a legacy block and call it done — find the target canonical direction
   in the registry, or propose one in a decision entry.

---

## Mockup discipline

Mockups live in three buckets under [`mockups/`](./mockups):

- `mockups/current-prod/` — reference snapshots of shipped UI. **Not
  aspirational.**
- `mockups/proposed/` — candidate designs. **Not binding.**
- `mockups/approved/` — explicitly approved source-of-truth. Binding.

Only `approved/` mockups drive canonical implementation. If you're told "match
the mockup" and the file lives in `proposed/`, flag it: is the intent to
approve it, or to explore it? If approval — add a decision entry and move
the file first, then implement.

---

## Primitives available in Phase 1 (status: `provisional`)

- `Button`
- `Card`
- `Sheet`
- `SectionHeader`
- `ListRow`
- `Banner`

Anything else is `legacy` or a Phase 2+ target. See
[`COMPONENTS.md`](./COMPONENTS.md#not-in-scope-for-phase-1) and
[`COMPONENT_REGISTRY.md`](./COMPONENT_REGISTRY.md).
