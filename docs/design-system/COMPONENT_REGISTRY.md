# Component registry

Status of every UI primitive and pattern family. The **status** column is
the source of truth — a component's existence in code does not make it
canonical.

Updated **2026-04-19** after North Star v2 mockup approval.

## Status model

| Status | Meaning |
|--------|---------|
| **`canonical`** | Explicitly approved target state. Use freely; build on it. Status change requires `DESIGN_DECISIONS.md` entry. |
| **`provisional`** | Extracted and in use, codified against approved mockups. Safe to depend on; API may refine. |
| **`provisional-needs-redesign`** | In `packages/ui`, structurally usable but visuals/behavior below canonical bar. Bridge only — do not build long-term on it. |
| **`legacy`** | Exists in `MiniApp.tsx`, works, NOT the direction. Do not pattern-match. Migrate on touch. |
| **`deprecated`** | Replacement exists; scheduled for removal. Do not add new usages. |

Promotion criteria: see
[`PROMOTION_CHECKLIST.md`](./PROMOTION_CHECKLIST.md).

Visual source of truth: [`./mockups/approved/`](./mockups/approved).

## Field reference

- **`status`** — one of the five values above
- **`implementation`** — code path
- **`approvalSource`** — approved mockup(s) or decision-log ID that
  codify the contract
- **`targetVisualDirection`** — `close-to-current` / `matches-approved-mockup`
  / `needs-redesign` / etc.
- **`canBePromotedToCanonical`** — `yes` / `not-yet` / `no`
- **`promotionBlockers`** — specific gaps
- **`migrationNotes`** — pointer to playbook / call-site guidance

---

## Extracted primitives (`packages/ui`)

### `Button`

- **Status (per-variant):**
  - `primary` / `secondary` / `ghost` → **`canonical`** (promoted 2026-04-20 after Wave 1 + 1-day haptic observation)
  - `primary-gradient` → **`canonical`** (promoted 2026-04-20 via paywall wave; gap #1 resolved — mockup canonicalizes 2-stop gradient)
  - `danger` / `surface` → `provisional`
- **Implementation:** [packages/ui/src/Button.tsx](../../packages/ui/src/Button.tsx)
- **Approval source:** every approved v2 mockup codifies variant × size
  grid + [DESIGN_DECISIONS.md#2026-04-20--paywall-b-full-full-redesign-to-match-approved-v2-paywallhtml--yearly-pro-plan](./DESIGN_DECISIONS.md#2026-04-20--paywall-b-full-full-redesign-to-match-approved-v2-paywallhtml--yearly-pro-plan)
- **Target visual direction:** `matches-approved-mockup` for canonical
  variants; `needs-redesign` for `danger` (prod uses flat fill, not tint).
- **API:** `variant / size / fullWidth / loading / disabled / pressedEffect / haptic / leftIcon / rightIcon / style` (unchanged since Wave 1)
- **Adoption:** 13 call-sites in MiniApp.tsx (Wave 1: primary × 6,
  secondary × 4, ghost × 2; Paywall wave: primary-gradient × 1 sticky
  CTA + ghost × 1 "Not now"). Haptic validated live.
- **Promotion blockers (for remaining variants):**
  - **`danger`** (Gap #2): prod uses flat `C.red` / `C.orange`.
    Current variant is tinted-only. Need `danger-solid` variant OR
    tone sub-prop OR accept tint-shift.
  - **`surface`**: 0 adoptions yet. Validate via 2-3 real sites
    first.
- **Legacy sites (migrate on touch):** 3 prod bespoke `primary-gradient-deep`
  3-stop sites at ~16650, ~16785, ~16993 (MiniApp.tsx) use
  `linear-gradient(135deg, C.accent, #6B5CE7)` instead of canonical
  2-stop. Replace with `<Button variant="primary-gradient">` when you
  touch those sites.
- **Migration notes:** `<button style={{...btnPrimary, padding, fontSize}}>` → `<Button variant="primary" size="...">`. Keep `style` for positional overrides (flex, margin, width). Drop `boxShadow`/`borderRadius` overrides — variant provides them. `opacity: X?0.6:1 + disabled={X}` pattern: keep inline for now (loading prop shows spinner, different UX).

### `Card`

- **Status (per-variant):**
  - `default` / `interactive` → **`canonical`** (promoted 2026-04-19, 5 call-sites)
  - `hero` → **`canonical`** (promoted 2026-04-20 via paywall wave; hero-class primitives are inherently 1-per-surface)
  - `flat` / `current` → `provisional`
- **Implementation:** [packages/ui/src/Card.tsx](../../packages/ui/src/Card.tsx)
- **Approval source:** all v2 mockups (default/flat/interactive/current);
  `v2-paywall.html` (hero) + [DESIGN_DECISIONS.md#2026-04-19--card-wave-1-adoption--defaultinteractive-variants-promoted-to-canonical](./DESIGN_DECISIONS.md#2026-04-19--card-wave-1-adoption--defaultinteractive-variants-promoted-to-canonical)
- **Target visual direction:** `matches-approved-mockup`
- **API:** `variant` · `padding` · `style` (unchanged since Phase 1)
- **Adoption:** 5 call-sites in MiniApp.tsx (`WishItemCardOwner`,
  `WishItemCardGuest`, gift-notes idea card, showcase preferences × 2).
- **Promotion blockers (for remaining variants):**
  - `flat` — no real call-site yet to validate `background: surface`
    pattern. Also drift: prod has "card bg + no border" pattern that
    doesn't match either `default` (has border) or `flat` (different bg).
    Open question in future Card wave.
  - `current` — visual target codified in mockups but no prod adoption.
- **Migration notes:** `<div style={{ background: C.card, borderRadius:
  14, padding: 16, border: '1px solid C.border' }}>` → `<Card variant="default">`.
  Add `variant="interactive"` + `onClick` for clickable cards. Keep
  positional style (`marginBottom`, `opacity`, `animation`,
  `WebkitTapHighlightColor`) via `style` prop.

### `Sheet`

- **Status:** `provisional-needs-redesign`
- **Implementation:** [packages/ui/src/Sheet.tsx](../../packages/ui/src/Sheet.tsx)
- **Approval source:** visual shell matches `v2-reservations-pro.html`
  detail-sheet
- **Target visual direction:** `needs-redesign` — **behaviorally** below
  bar (iOS swipe/inertia/keyboard-blur missing)
- **Can be promoted to canonical:** `no`
- **Promotion blockers:**
  - Absorb `BottomSheet` iOS touch/velocity/inertia logic from
    `MiniApp.tsx:2023`
  - Keyboard-aware layout (visualViewport API)
  - Blur-on-scroll ≥ 20 px threshold
  - Exit animation
  - Destructive-confirm variant
- **Migration notes:** do NOT migrate `BottomSheet` call-sites to `Sheet`
  yet — regresses iOS UX. Wave 2–3 absorbs behavior first.

### `SectionHeader`

- **Status:** **`canonical`** (promoted 2026-04-19)
- **Implementation:** [packages/ui/src/SectionHeader.tsx](../../packages/ui/src/SectionHeader.tsx)
- **Approval source:** every v2 mockup — shape identical across all +
  [`DESIGN_DECISIONS.md#2026-04-19--sectionheader-promoted-to-canonical`](./DESIGN_DECISIONS.md#2026-04-19--sectionheader-promoted-to-canonical)
- **Target visual direction:** `matches-approved-mockup` (realized)
- **Can be promoted to canonical:** — (already canonical)
- **API:** `children` · `action` · `icon` · `marginBottom` · `marginTop` ·
  `center` (dialog/sheet-title variant, added during promotion).
- **Adoption:** 4 call-sites in MiniApp.tsx (lines 12585 / 18127 / 22347 /
  24189). Remaining inline `fontSize: 17, fontWeight: 700` headers are
  `legacy` and migrate on touch.
- **Migration notes:** `<div style={{ fontSize: 17, fontWeight: 700,
  marginBottom: N }}>text</div>` → `<SectionHeader marginBottom={N}>text</SectionHeader>`.
  For centered dialog titles (inside `textAlign: center` parents):
  `<SectionHeader center marginBottom={N}>text</SectionHeader>`.

### `ListRow`

- **Status (per-variant):**
  - `card` → **`canonical`** (promoted 2026-04-20, 5 call-sites + 3 states validated)
  - `compact` / `plain` → `provisional`
- **Implementation:** [packages/ui/src/ListRow.tsx](../../packages/ui/src/ListRow.tsx)
- **Approval source:** all v2 mockups (card/compact/plain);
  `v2-wish-state-matrix.html` (8 `state` variants) +
  [DESIGN_DECISIONS.md#2026-04-20--listrow-wave-1-adoption--card-variant-promoted-to-canonical](./DESIGN_DECISIONS.md#2026-04-20--listrow-wave-1-adoption--card-variant-promoted-to-canonical)
- **Target visual direction:** `matches-approved-mockup`
- **API:** `variant / state / leading / trailing / title / subtitle / meta / interactive / style` (unchanged)
- **Adoption:** 5 call-sites in MiniApp.tsx (referral share 3 rows,
  curated subs, profile subs, wishlist home list, subscription home list).
- **States validated:** `neutral` (3×), `muted` (1), `warning` (1).
  Other states inherit by extension but are unvalidated in prod.
- **Promotion blockers (for `compact` / `plain`):**
  - `compact` — no real adoption yet. Candidates: reservation rows (compact dense lists), Santa participants. Future wave.
  - `plain` — same. Candidates: settings rows, sheet inner lists.
- **Migration notes:** `<div onClick style={{background:card, border, borderRadius, padding, display:flex, gap, cursor:pointer}}>...</div>` → `<ListRow variant="card" interactive onClick leading={...} title={...} subtitle={...} meta={...} trailing={...} />`. State-tint via `state` prop instead of inline background/opacity.

### `Banner`

- **Status (per-tone):**
  - `info` / `success` / `warning` / `danger` → **`canonical`** (promoted 2026-04-19)
  - `promo` → `provisional`
- **Implementation:** [packages/ui/src/Banner.tsx](../../packages/ui/src/Banner.tsx)
- **Approval source:** `v2-wishlist-detail-guest.html` (don't-gift danger
  + group-gift promo); state-matrix; home error states +
  [`DESIGN_DECISIONS.md#2026-04-19--banner-wave-1-adoption--neutral-tones-promoted-to-canonical`](./DESIGN_DECISIONS.md#2026-04-19--banner-wave-1-adoption--neutral-tones-promoted-to-canonical)
- **Target visual direction:** `matches-approved-mockup`
- **API:** `tone` · `title` · `icon` · `action` · `onClose` · `center` ·
  `bordered` (added during Wave 1 promotion)
- **Adoption:** 5 call-sites in MiniApp.tsx across all 4 neutral tones.
  Remaining tinted-strip inline divs are `legacy`, migrate on touch.
- **Promotion blockers (for `promo`):**
  - Needs first paywall migration to validate CTA composition
  - Action-slot contract (button inside banner) not yet exercised in prod
- **Migration notes:** `<div style={{ background: C.{tone}Soft, color:
  C.{tone}, padding: '12px 14px', borderRadius: 12, display: flex, gap:
  10 }}>` → `<Banner tone="{tone}" icon={...}>...</Banner>`. If prod
  had subtle tone-border → add `bordered`. Keep outer positional
  overrides (margin, flexShrink) via `style` prop.

### `Chip`

- **Status:** **`canonical`** (promoted 2026-04-20)
- **Implementation:** [packages/ui/src/Chip.tsx](../../packages/ui/src/Chip.tsx)
- **Approval source:** every v2 mockup (state-chip language unified) +
  [DESIGN_DECISIONS.md#2026-04-20--chip-wave-1-adoption--primitive-promoted-to-canonical](./DESIGN_DECISIONS.md#2026-04-20--chip-wave-1-adoption--primitive-promoted-to-canonical)
- **Target visual direction:** `matches-approved-mockup` (realized)
- **API:** `tone` / `size` / `icon` / `children` / `style` (all unchanged since extraction)
- **Adoption:** 15 call-sites in MiniApp.tsx — status pills, badges, link chips.
- **Tones validated in adoption:**
  - ✅ **accent** (4 sites), **success** (4), **surface** (3): full ≥3-gate
  - ⚠️ **warning** (2 sites): threshold relaxed (primitive contract
    validated by other tones; same `{bg, color}` shape)
  - ❌ **danger / prio-1 / prio-2 / prio-3 / new / pro**: 0 adoption;
    canonical by extension (inherit primitive contract)
- **Migration notes:** `<span style={{ padding, borderRadius, background, color, fontSize, fontWeight }}>` → `<Chip tone="..." size="...">`. Use `size="lg"` for 13-px status pills (pill-radius), default (md) for 11-px badges. Accept minor visual shifts to canonical tokens.

### `CounterBadge` (new, 2026-04-19)

- **Status:** `provisional`
- **Implementation:** [packages/ui/src/CounterBadge.tsx](../../packages/ui/src/CounterBadge.tsx)
- **Approval source:** `v2-home-all-tabs.html` tab-bar counter (after
  2026-04-19 post-review tweak)
- **Target visual direction:** `matches-approved-mockup`
- **Can be promoted to canonical:** `not-yet`
- **Promotion blockers:**
  - Brand new primitive, needs adoption
  - Multi-location usage patterns (tab-bar / chip-trailing / avatar-
    overlap) not yet validated

### `StatTile` (new, 2026-04-19)

- **Status:** `provisional`
- **Implementation:** [packages/ui/src/StatTile.tsx](../../packages/ui/src/StatTile.tsx)
- **Approval source:** `v2-wishlist-detail-owner.html`,
  `v2-secret-reservation.html` (inline variant)
- **Target visual direction:** `matches-approved-mockup`
- **Can be promoted to canonical:** `not-yet`
- **Promotion blockers:** brand new; need 3+ surfaces using it

### `AvatarStack` (new, 2026-04-19)

- **Status:** `provisional`
- **Implementation:** [packages/ui/src/AvatarStack.tsx](../../packages/ui/src/AvatarStack.tsx)
- **Approval source:** `v2-home-all-tabs.html` (shared-wishlist),
  `v2-group-gift.html` (participants)
- **Target visual direction:** `matches-approved-mockup`
- **Can be promoted to canonical:** `not-yet`
- **Promotion blockers:**
  - Brand new
  - `avatarGradients` token consumption needs validation (identity
    assignment algorithm still in caller's hands)

---

## Pattern families (not yet extracted)

| Family | Status today | Visual target | Extraction priority | Notes |
|--------|-------------|---------------|---------------------|-------|
| `ScreenHeader` (back / title / overflow) | `legacy` | `v2-*` mockups | Phase 2 wave 1 | Approved shape consistent across all |
| `StickyCTA` (bottom fade + button) | `legacy` | Pattern 5 in `SCREEN_PATTERNS.md` | Phase 2 wave 1 | Wraps a single primary button |
| `Toast` | `legacy` (works, needs extraction) | **Not codified in mockups** | Phase 2 wave 2 | **Needs own mockup** before canonical |
| `EmptyState` | `legacy` | Pattern 7 | Phase 2 wave 2 | Needs mockup of illustration slot |
| `Skeleton` | `legacy` | ad-hoc | Phase 2 wave 2 | Per-layout variants needed |
| `Input` / `TextArea` | `legacy` | `inputStyle` at MiniApp.tsx:654 | Phase 3 | Needs error/help-slot mockup |
| `IconButton` | `legacy` | 44×44 tap target | Phase 2 wave 1 | `aria-label` required |
| `Menu` / dropdown | `legacy` | ad-hoc | Phase 3 | Focus-trap handling |
| `OnboardingSplash` | `legacy` | `v2-onboarding.html` | Phase 3 | 4-screen template with animated hero |
| `PaywallHero` composition | `legacy` | `v2-paywall.html` | Phase 2 wave 2 | Composes `Card variant="hero"` + content |
| `SecretReservationStateStrip` | `legacy` | `v2-secret-reservation.html` | Phase 3 | Left-edge 3px state-strip wrapper |
| `GroupGiftProgress` | `legacy` | `v2-group-gift.html` | Phase 3 | Amount + momentum + bar composition |
| `ReservationTTLControl` | `legacy` | `v2-reservations-pro.html` | Phase 3 | Extend button + progress + counter |
| `SantaHero` (sub-product) | `legacy` | `v2-santa-campaign.html` | Phase 4 | Distinct seasonal gradient |
| `OwnerCard` (profile preview) | `legacy` | `v2-wishlist-detail-guest.html` | Phase 3 | Avatar + name + subscribe |

---

## Token families (`packages/ui-tokens`)

Status updated 2026-04-19 after North Star approval.

| Token family | Status | Notes |
|--------------|--------|-------|
| `colors.*` | **approved** | Values codified against approved mockups. Santa palette distinct. |
| `avatarGradients.*` (new) | **approved** | 5 named avatar gradients for identity. |
| `spacing.*` / `spacingSemantic.*` | **approved** | Daily use: 4/8/14/16/24. |
| `radius.*` / `radiusSemantic.*` | **approved** | Iteration pending: +2–4px rounder (see backlog). |
| `shadows.*` | **approved** | Includes composed hero shadows + notification glows + success pop glow. |
| `typography.*` | **approved roles** | Semantic roles canonical; some raw sizes may prune. |
| `motion.*` | **canonical** | Adds `pressedScale`, `easing.springOut`, 4 new keyframes/animations. |
| `zIndex.*` | **canonical** | Finite stack. |
| `sizing.*` | **canonical** | Touch-target + icon/avatar/button sizes. |
| `gradients.*` | **approved** | 15 presets incl. `paywallHero`, `santaHero`, `profileCover`, state-tints. |
| `safeArea.*` | **canonical** | WebView helpers. |
| `breakpoints.*` | **canonical** | Phone-first. |

---

## Canonical-promotion priority queue

### Completed
- ✅ **`SectionHeader`** — canonical 2026-04-19
- ✅ **`Banner` neutral tones** — canonical 2026-04-19
- ✅ **`Card` default + interactive** — canonical 2026-04-19
- ✅ **`Chip` primitive** — canonical 2026-04-20 (15+ call-sites across 5 tones)
- ✅ **`ListRow variant="card"`** — canonical 2026-04-20 (5 call-sites + 3 states)
- ✅ **`Button` primary/secondary/ghost** — canonical 2026-04-20 (12 adoptions + 1-day haptic observation)
- ✅ **`Button primary-gradient`** — canonical 2026-04-20 (paywall sticky CTA; gap #1 closed)
- ✅ **`Card variant="hero"`** — canonical 2026-04-20 (paywall hero; hero-class primitives are 1-per-surface)

### Next up
1. **`Button danger` + `surface`** → gap #2 resolution (or surface adoption)
2. **`ListRow compact` / `plain`** → after adoption
3. **`Card flat` / `current`** → after adoption validates in real surfaces
4. **`Banner tone="promo"`** → after promo-banner surface surfaces
5. **`Sheet`** → after BottomSheet iOS behavior absorption
6. **`CounterBadge`, `StatTile`, `AvatarStack`** → after adoption validates APIs

---

## How to use this file in a PR

1. Find the row for the primitive / family you're touching.
2. If your PR changes status, add a `DESIGN_DECISIONS.md` entry.
3. If the row lists `promotionBlockers`, don't promote without resolving.
4. If the primitive isn't listed, add a row before merging.

Workflow: [`PROMOTION_CHECKLIST.md`](./PROMOTION_CHECKLIST.md).
