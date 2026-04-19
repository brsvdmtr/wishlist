# UI North Star — WishBoard

> **Status: APPROVED — 2026-04-19**
>
> This document is the top-level **visual source of truth** for the
> WishBoard Mini App. Tokens, primitives, migrations and governance all
> serve the vision here.
>
> Approval logged in
> [`DESIGN_DECISIONS.md`](./DESIGN_DECISIONS.md#2026-04-19--north-star-direction-approved-v2-mockups-binding).
>
> **When text and mockups conflict, the approved mockups win.** Text in
> sections 3–4 is prose guidance; mockups in `mockups/approved/` are the
> binding visual spec.
>
> Future evolution flows through the cycle in
> [`PROMOTION_CHECKLIST.md`](./PROMOTION_CHECKLIST.md): new proposed
> mockups → review → approved mockups → North Star refresh → primitive
> alignment → canonical promotion.
>
> ## 📱 Visual companion mockups — APPROVED binding spec
>
> 11 HTML mockups in [`./mockups/approved/`](./mockups/approved), sharing
> [`_north-star-v2.css`](./mockups/approved/_north-star-v2.css) as the
> token-language mirror. Open any file directly (self-contained, inline
> CSS).
>
> | # | File | Shows | Phone-screens |
> |---|------|-------|---------------|
> | 1 | [`v2-home-all-tabs.html`](./mockups/approved/v2-home-all-tabs.html) | Home: Wishlists + Wishes + Reservations tabs with counter-badge + ⚙ settings | 3 |
> | 2 | [`v2-wishlist-detail-owner.html`](./mockups/approved/v2-wishlist-detail-owner.html) | Owner editing a wishlist: categories, smart-res TTL, items, stats | 1 |
> | 3 | [`v2-wishlist-detail-guest.html`](./mockups/approved/v2-wishlist-detail-guest.html) | Guest arrives via share link: owner card, don't-gift, reserve CTAs | 1 |
> | 4 | [`v2-wish-state-matrix.html`](./mockups/approved/v2-wish-state-matrix.html) | All 15 real state combos (owner/guest × available/reserved/secret/shared/TTL/group/santa/etc) | grid |
> | 5 | [`v2-paywall.html`](./mockups/approved/v2-paywall.html) | Paywall with real 19-feature PRO stack grouped in 3 sections + context-chip | 1 |
> | 6 | [`v2-reservations-pro.html`](./mockups/approved/v2-reservations-pro.html) | Reservations PRO: active + history + detail sheet with TTL/note/purchase | 2 |
> | 7 | [`v2-secret-reservation.html`](./mockups/approved/v2-secret-reservation.html) | All 5 `SecretReservationDerivedState` visualized with strip + actions | 1 |
> | 8 | [`v2-showcase-profile.html`](./mockups/approved/v2-showcase-profile.html) | Public PRO showcase: cover, bio, sizes, don't-gift, pinned + all lists | 1 |
> | 9 | [`v2-group-gift.html`](./mockups/approved/v2-group-gift.html) | Group gift: progress + participants + pinned payment info + chat | 2 |
> | 10 | [`v2-santa-campaign.html`](./mockups/approved/v2-santa-campaign.html) | Secret Santa: participant (alias + assignment + poll) + organizer (gift progress + timeline) | 2 |
> | 11 | [`v2-onboarding.html`](./mockups/approved/v2-onboarding.html) | Onboarding: hello → why → occasion pick → success | 4 |
>
> ~20 phone-screens total. Changing any of these files requires a
> `DESIGN_DECISIONS.md` entry — they are immutable within their approved
> state. Creating a superseding design means adding a new proposed
> mockup and running through the approval flow.
>
> ### Forward-iteration notes (approved as direction, not blocking)
>
> - **Radius scale** may shift slightly rounder («меньше острых углов»):
>   candidate `xl` 14→16, `xxl` 16→20, `xxxl` 20→24. Evaluate after first
>   canonical primitive promotion. Backlog entry in
>   [`DESIGN_DECISIONS.md`](./DESIGN_DECISIONS.md#decision-backlog-pending-explicit-approval).
> - **Toast visual target** not codified in approved mockups yet. Phase 2
>   Toast extraction needs a separate mockup or direct owner approval.
> - **Sections 3–4 below** are the pre-approval prose — they remain as
>   supporting text but the mockups take precedence when they conflict.

---

## 1. North Star summary

WishBoard is a **gifting concierge**, not a task manager.

The product lives inside an emotional moment — a friend's birthday, a
partner's surprise, a shared list at a holiday. The UI must feel like the
difference between a thoughtful gift and a default one. Warm, calm, premium,
decisive. Every interaction either expresses care or helps someone find
something that will.

On the axis of "playful ↔ serious," the product sits at **warm-serious**.
Not silly. Not corporate. Not clinical. Think: a premium gift-wrapping
service that happens to live on a phone.

On the axis of "dense ↔ breathable," it sits at **compactly breathable**.
Thumb-first, one-handed, used in glanceable moments — but never crammed.
Dark UI by intent, not by default. PRO surfaces earn the premium vocabulary;
free surfaces don't over-use it.

The current product ships most of the right features, but the visual layer
drifted during fast iteration. The North Star is not a rewrite — it's the
stable image that lets us judge every PR from here on: "does this feel like
the WishBoard we're building, or just the one we have?"

## 2. Core design principles

Seven principles. Any PR reviewer can ask "does this honor X?" for each.

1. **Warm, not cold.**
   Rounded radii. Accent-soft tints. Emoji where they earn their place
   (reservation states, priority, empty states). Never enterprise gray.
   Avoid clinical labels ("Entity", "Item ID"); prefer human ones.

2. **Decisive, not busy.**
   One primary action per screen. If four actions are possible, three go
   into an overflow menu or a sheet. Sticky CTAs are always the most
   important action on the screen — never secondary.

3. **Premium feels premium.**
   PRO surfaces (paywall, secret reservation, advanced features) use a
   distinct visual vocabulary — gradients, glow shadows, emphasized motion.
   Free surfaces are clean; they do not borrow the premium vocabulary for
   cheap weight. When a user sees the premium vocabulary, it should mean
   "this is the upgrade."

4. **Calm over playful.**
   Gift-giving carries anxiety ("am I picking the right thing?" "will they
   notice?"). Motion is short, purposeful, and fades where it shouldn't
   distract. No ambient animation. No decorative parallax. Moments of
   delight (reservation confirmed, gift sent) are _earned_, not sprinkled.

5. **State is unmistakable.**
   Reserved / purchased / public / secret / expired / shared / solo — the
   user never has to guess. Each state has a visual contract: color, icon,
   position. If a reviewer can't tell what state a wish is in from the
   card alone, the design is wrong.

6. **Compactly breathable.**
   8 / 14 / 16 / 24 vertical rhythm. Nothing is crammed; nothing wastes a
   row. The screen feels full of signal, empty of noise.

7. **Thumb-first.**
   44 pt touch minimums, always. Primary actions sit in the bottom third.
   Keyboard handling is a first-class concern (WebView on mobile — the
   keyboard steals half the viewport). RTL and long-text behavior are
   primitives' responsibility, not feature code's.

## 3. Pattern-by-pattern target direction

Focus on the three priorities (Button, Sheet, Toast), then lighter coverage
for the rest.

### Button

**Current common issues**
- Variant sprawl: `btnBase / btnPrimary / btnSecondary / btnGhost` + ~141 spread usages with one-off `padding` / `fontSize` / `borderRadius` overrides that drift from each other.
- Multiple `primary-gradient` implementations in the wild (paywall uses one gradient, secret-reservation uses another, onboarding a third).
- No pressed state beyond `transition: all 0.15s` on hover — feels soft, not tactile.
- Disabled is `opacity: 0.5` only — reads as "temporarily hidden," not "can't use."
- No haptics anywhere.

**Target visual direction**
- **Three variants cover 95% of surfaces:**
  - `primary` (accent fill, white text) — the default commit action.
  - `primary-gradient` (canonical brand gradient + glow) — reserved for hero / paywall moments. One gradient across the app, no variants.
  - `ghost` (transparent, secondary text) — low-emphasis actions.
  Plus `secondary` (accent-soft fill) and `danger` as situational variants; not on every screen.
- **Three sizes:** `sm` 36, `md` 44, `lg` 50. Nothing between. A hero variant = `lg` + `primary-gradient`; do not invent a fourth size.
- **Pressed state:** `transform: scale(0.98)` + subtle shadow depression. Visible feedback within 30 ms.
- **Disabled state:** dimmed fill (not just opacity) + `cursor: not-allowed` + no press feedback. Reads as "can't use," not "hidden."

**Target interaction direction**
- **Haptics** on press via Telegram WebApp `HapticFeedback.impactOccurred('light')` for primary / primary-gradient; not for ghost / secondary.
- **Loading** replaces the leading icon with a spinner; the label stays visible. Button remains the same width (no layout jump).
- **Focus ring** via `shadows.ringFocus`, visible on keyboard focus only.

**Canonical-worthy when**
- Approved mockup codifies the 3-variant × 3-size grid with pressed / disabled / loading states shown explicitly.
- Haptics wired.
- ≥ 90% of existing call-sites migrated; no `{ ...btnPrimary, padding, ... }` inline overrides in the top 10 surfaces.
- One canonical gradient, committed as a token, used by every gradient button.

### Sheet

**Current common issues**
- The local `BottomSheet` (MiniApp.tsx:2023, ~200 lines) is **behaviorally excellent**: iOS-native swipe-to-dismiss with velocity-based inertia, keyboard-blur-on-scroll, touchmove guarding, momentum. But it lives in the monolith with no typed contract.
- The extracted `Sheet` primitive (packages/ui) is visually close but **behaviorally a regression** — no swipe, no inertia, no keyboard handling.
- No exit animation on close anywhere — sheets abruptly unmount.
- Nested sheets are inconsistent; sometimes they stack, sometimes they replace.
- No dedicated "destructive confirm" variant — those are open-coded inside a generic bottom sheet.

**Target visual direction**
- Bottom sheet, 20 px top-corner radius, `colors.surface` background, `shadows.deepMax`.
- **Exit animation** mirrors the entrance — slide-down + backdrop fade.
- Scrim is 60% black; could optionally add subtle backdrop blur (Telegram WebView supports it). To decide at approval time.
- Drag handle always visible (40 × 4 px pill, `colors.textMuted`, 0.3 opacity).
- Title slot uses `textStyles.sectionHeader` (17 × 700).
- Safe-area-aware bottom padding, not negotiable.
- A **compact confirm variant** exists as a distinct shape: shorter height (`max-content` up to 40 % viewport), centered layout, two buttons side-by-side (`ghost` cancel + `primary` / `danger` confirm). This is not a generic sheet with short content — it's its own pattern.

**Target interaction direction**
- All current `BottomSheet` iOS behavior, preserved verbatim, absorbed into the primitive.
- Swipe-to-dismiss via velocity: absolute finger travel ≥ 80 px OR finger velocity ≥ 0.12 px/ms at release → slide out + fire `onClose`. Otherwise, spring-back to rest.
- Keyboard-aware: focused input inside a sheet pushes the sheet up (via `visualViewport` API) so the input never hides behind the keyboard.
- Keyboard-blur on scroll ≥ 20 px cumulative — keeps the UX predictable.
- Backdrop tap blurs any focused field before calling `onClose` — avoids the WebView "keyboard flash" bug.
- Max sheet height = 85 vh; overflow scrolls internally with momentum.
- No nested sheets. If a choice requires further input, the current sheet dismisses and a new surface opens.

**Canonical-worthy when**
- `Sheet` primitive fully absorbs `BottomSheet`'s iOS behavior (no regressions).
- Exit animation + keyboard-aware layout implemented.
- Destructive-confirm variant documented and used.
- ≥ 4 distinct call-sites migrated (form sheet, picker sheet, confirm sheet, ready-share sheet).
- `BottomSheet` local function deleted from MiniApp.tsx.

### Toast

**Current common issues**
- Visual language is close to right (card bg, radius 14, tone-colored text).
- But: no exit animation (abrupt unmount).
- No priority — a success toast can push an unseen error off-screen.
- No coalescence — repeated failure retries spam three identical error toasts.
- No action slot (can't offer "Undo" on destructive confirmations).
- Tone indicator is only the text color; the toast itself looks the same.

**Target visual direction**
- Bottom-centered stack, max 3 visible, safe-area-aware.
- Card bg (`colors.card`), 1 px `colors.borderLight`, radius 14, padding 14 × 18.
- **Tone indicator on the leading edge** — a 4 × 20 px rounded bar in the tone color, or a small tone-colored icon. Not just colored text.
- Text: 14 × 600, base `colors.text`. Tone color shows via the indicator, not the whole text.
- Entrance: `animation.toastIn`. Exit: fade-out + slide-down (`animation.toastOut`, to add).

**Target interaction direction**
- **2.8 s auto-dismiss**, unchanged.
- **Priority:** `error` > `warning` > `success` > `info`. A lower-priority toast never pushes a higher-priority one off the stack. If 3 slots are full, a new info toast is dropped (not queued); a new error replaces the oldest non-error.
- **Coalescence:** same `message` within 1.5 s — increment a `×N` counter on the existing toast, refresh its timer.
- **Optional action:** `pushToast(msg, kind, { action: { label, onClick }})`. The action is a ghost button inside the toast, trailing. Max one action per toast.
- **Tap dismisses** (mobile). Don't implement pause-on-hover — target is mobile.
- **Safe-area bottom:** `max(16px, env(safe-area-inset-bottom, 16px))`.

**Canonical-worthy when**
- Exit animation, priority, coalescence, and optional-action slot all shipped.
- `pushToast` API extended (not replaced) — 362 existing call-sites keep working.
- Visual indicator (the tone bar/icon) approved in a mockup.

---

### Lighter coverage (Banner, Card, SectionHeader, ScreenHeader, Input, Paywall)

### Banner
- Persistent attention surface (vs. Toast, which is transient).
- Five tones: `info` / `success` / `warning` / `danger` / `promo`.
- `promo` is visually distinct (brand gradient, white text, reads as "this is a CTA surface"). Approving the promo tone requires the paywall mockup.
- Info / success / warning / danger are tone-soft bg + tone-strong text — close to canonical once approved.
- Close (×) affordance is consistent and small — banners should feel stable, not anxious to leave.

### Card
- Three variants: `default` (bordered dark card), `flat` (borderless surface), `interactive` (hover feedback).
- Content cards (wish item, reservation) share the contract — 14 px radius, 16 px padding, 1 px `colors.border`.
- Hero cards (paywall, onboarding splash) are a distinct variant — larger radius, gradient fill, oversized padding. Waiting on approved mockup before codifying.

### SectionHeader
- 17 × 700 text, 16 px bottom margin, optional leading emoji + trailing action.
- Dividerless by intent — space separates, not lines.
- Easiest canonical candidate in the system — minimal structural risk.

### ScreenHeader (not yet extracted)
- 44 pt back button on the left, title (centered or left — mockup decides), trailing slot for one action or overflow.
- Unread / status badges sit in the title area, not the right slot — the right slot is reserved for actions.
- Scroll-aware: when content scrolls under the header, a subtle border or shadow appears (currently not implemented; target direction).

### Input / TextArea (not yet extracted)
- 48 px single-line input height, radius 12, 16 px font (iOS zoom avoidance), subtle accent focus ring.
- Error state: 1 px `colors.danger` border + danger-tone helper text below. No floating labels.
- Auto-grow for TextArea, hard cap at ~10 rows + scroll after that.
- Placeholder in `colors.textMuted`; value in `colors.text`.
- Helper / error text: 13 × 600, 4 px top margin.

### Paywall block (composed pattern, not a primitive)
- `Banner tone="promo"` hero + 3–5 `ListRow variant="plain"` benefit rows + plan selector + `Button variant="primary-gradient" size="lg"` CTA + `Button variant="ghost" size="sm"` "maybe later."
- Canonical status requires an approved paywall mockup — multiple paywall implementations exist in prod today, none approved.

## 4. Reference screen concepts

Four reference screens, in priority order. When all four feel right in
approved mockups, the canonical promotions underneath can follow fast.

### RS-1. Paywall

- **Role:** conversion moment. Every free user encounters this.
- **What should feel different:** premium must actually feel premium. Not a
  price-first form. The user should want what's inside before they notice
  the price.
- **Composition:** `Banner tone="promo"` hero → benefit list (3–5) → plan
  selector (month / year toggle) → `Button variant="primary-gradient" size="lg"`
  → quiet `ghost` "maybe later" or × dismissal.
- **Primitives it approves:** `Banner tone="promo"`, `ListRow variant="plain"`,
  `Button variant="primary-gradient"` & `Button size="lg"`, one canonical
  gradient token.

### RS-2. Home / My Wishlists

- **Role:** first surface after onboarding. "What I own + what I'm expecting."
- **What should feel different:** less utilitarian, more anticipatory. Cards
  hint at emotional content (upcoming deadline, unread comment count,
  shared-with chips) without over-decorating. Empty state is warm, not
  "you-have-nothing."
- **Composition:** screen header → `SectionHeader` (e.g., "Your lists") →
  `ListRow variant="card"` items (thumbnail + title + meta + chevron) →
  sticky `Button size="lg"` "Create wishlist."
- **Primitives it approves:** `SectionHeader`, `ListRow variant="card"`,
  `StickyCTA` pattern, `Button variant="primary" size="lg"`, the Wishlist
  card row contract (thumbnail size, meta layout, shared-with chip).

### RS-3. Wish item detail

- **Role:** one wish, its state, its actions. Emotional moment — the user is
  either committing to a gift or confirming what they want.
- **What should feel different:** the reservation state is unmistakable —
  public / reserved / secret-reserved / purchased each read at a glance.
  Hero image feels like a gift, not a product catalogue thumbnail.
- **Composition:** screen header (back + overflow) → hero `Card padding="lg"`
  (image or fallback emoji + title + price) → role-aware actions (owner vs.
  guest vs. reservor) → optional `Banner` for state context → sticky
  primary action (reserve / edit / share).
- **Primitives it approves:** `Card padding="lg"`, reservation-state chip
  design, `Button variant="primary" size="lg"`, `Banner tone="info"`.

### RS-4. Bottom sheet with form

- **Role:** any edit or quick action that doesn't deserve a full screen.
  Widely-used pattern.
- **What should feel different:** scroll feels native, swipe-to-dismiss
  feels native, keyboard never hides the input. Primary action at the
  sheet's bottom (not sticky outside) — the sheet owns its CTA.
- **Composition:** `Sheet` → title (from `Sheet`'s `title` prop) → vertical
  stack of `Input` / `TextArea` / `Card padding="none"` blocks → primary
  `Button` + optional secondary action.
- **Primitives it approves:** the canonical `Sheet` (post-absorption of
  `BottomSheet` behavior), `Input`, `TextArea`, keyboard-aware layout
  contract.

### (Optional) RS-5. Settings / profile

- **Role:** persistent profile + preferences. Tight, quiet, settled.
- **What should feel different:** emphasizes state (PRO badge,
  subscription status) without selling constantly. Destructive actions live
  at the bottom, visually separated.
- **Composition:** profile header (avatar + name + PRO badge) → grouped
  `SectionHeader` + `ListRow variant="plain"` rows → destructive section at
  bottom.
- **Primitives it approves:** `SectionHeader` (finalizes the canonical
  shape), `ListRow variant="plain"`, toggle pattern, destructive action
  language.

## 5. Current state vs target state

Honest assessment. What we keep, what we polish, what we redesign.

### Can evolve forward (current ≈ target)

Small alignments, not rewrites. These parts of current prod are solid.

- **Color palette** — `#7C6AFF` accent + dark surfaces + semantic states
  work. Minor gray pruning (`#555` / `#444` drifting in) is cleanup, not
  redesign.
- **Typography scale** — 10–32 with weights 500 / 600 / 700 / 800 is the
  right compressed scale for phone WebView.
- **Radius scale** — 4 / 6 / 10 / 12 / 14 / 16 / 20, with 14 as the
  primary card/button radius. Some scale values (2 / 18) are candidates to
  prune.
- **Shadow tiers** — the five-tier system (subtle / elevated / deep /
  overlay / glow) is correct. Specific glow values may retune when the
  paywall mockup lands.
- **Bottom sheet interaction (iOS-native feel)** — current `BottomSheet` is
  behaviorally canonical-grade. Keep verbatim; absorb into the primitive.
- **Toast visual vocabulary** — card bg, tone-colored text, 14 / 600 / 14×18 /
  radius 14. Near-final; needs exit animation and tone-indicator to be
  canonical.
- **Motion system** — durations 0.15 / 0.2 / 0.3, easings, canonical
  keyframes. Approved as canonical at Phase 1.
- **Safe area handling** — correct semantics, correct tokens.

### Structurally useful but visually weak (keep shape, refine polish)

Skeleton is right; surface is not yet canonical.

- **`Sheet` primitive** — visually fine, behaviorally regressed vs.
  `BottomSheet`. Needs to absorb the iOS logic. Status:
  `provisional-needs-redesign`.
- **Button set** — variants are right; pressed state, haptics, focus ring
  are missing.
- **`ListRow` `card` variant** — the `card` variant needs refinement
  (title clamp rule, thumbnail size contract). `compact` and `plain` are
  closer to done.
- **Reservation state badges** — colors exist, but visual hierarchy between
  reserved / purchased / expiring / secret is weak. Each state is readable
  in isolation but the set doesn't sing together.
- **Toast stacking** — max 3 is right, but no priority means the wrong toast
  can survive.

### Needs redesign before canonical (do not freeze current shape)

Current prod here is a compromise, not a target.

- **Paywall surfaces** — multiple ad-hoc implementations (promo tile, hero
  sheet, upsell banner). Visual language inconsistent. The single biggest
  design decision pending.
- **Onboarding splash screens** — 7 variants in current prod, all
  `proposed/`, none approved. Redesign in progress.
- **Empty states** — currently fallback-ish ("no items"). Should feel
  intentional and warm.
- **Error-recovery UI** — banners work but don't feel calm. Retry /
  degraded / network-out patterns have no visual spec.
- **Sticky CTA shell** — works mechanically, but the fade-to-bg gradient
  can read as a bug when content scrolls behind. Target shape undecided.
- **Multiple `primary-gradient` implementations** — paywall / secret
  reservation / onboarding each use subtly different gradients. Target:
  one canonical gradient token, used everywhere the variant applies.
- **Legacy colors (`#555`, `#444`, `#60A5FA` outside badge context)** —
  drift. To prune on touch.
- **Dropdown / menu** — no consistent pattern today.
- **`primary-gradient` button glow values** — at least three different
  shadow tuples in use. Pick one.

## 6. How approved mockups govern canonical evolution

The North Star is the top of the pyramid. Approved mockups are the rungs
that connect it to code.

```
    North Star (this doc)          ← character, principles, target direction
           │
           ▼
    Approved mockups               ← concrete visual spec per surface
     (docs/design-system/
      mockups/approved/)
           │
           ▼
    Component registry             ← status, blockers, promotion readiness
    (COMPONENT_REGISTRY.md)
           │
           ▼
    Primitive + token              ← implementation
    implementation
     (packages/ui, ui-tokens)
```

Flow:

1. **A UI moment needs direction.** Either a not-yet-canonical pattern, or
   a pattern whose visual direction should evolve (e.g., redesigned
   paywall). The owner identifies it; the decision backlog in
   `DESIGN_DECISIONS.md` tracks it.

2. **A mockup is produced** in any medium (design tool, HTML, even a
   polished hand sketch turned into HTML). It lands in
   `mockups/proposed/`.

3. **Review against the North Star.** The reviewer asks, explicitly:
   - Does it honor the core principles? (warm-not-cold, decisive, calm,
     state-unmistakable, premium-feels-premium, compactly-breathable,
     thumb-first)
   - Does it elevate current state, or match it?
   - Is it coherent with other already-approved mockups?
   - Does it expose missing primitives or variants?

4. **Approval is an explicit act.** The mockup moves to `mockups/approved/`
   (via `git mv`), and a `DESIGN_DECISIONS.md` entry is added — typed
   `approval`, stating what was approved, what (if anything) it
   supersedes, and **what specifically elevates it above current state**.
   The last point is critical: future PR authors need to understand the
   WHY, not just the WHAT.

5. **The North Star evolves.** Approved mockups update this document.
   Section 3 (pattern-by-pattern direction) and Section 4 (reference
   screens) are append-and-refine, not write-once. The approval entry
   links the North Star section it updates.

6. **Components align.** A follow-up PR implements the mockup — updates
   tokens, updates primitive code, adds stories. That PR carries a
   `primitive-change` or `token-change` decision entry with screenshot
   evidence matching the approved mockup.

7. **Canonical promotion** runs the
   [`PROMOTION_CHECKLIST.md`](./PROMOTION_CHECKLIST.md). Implementation
   must match the approved mockup; promotion flips the status and — in
   the same PR — deprecates replaced legacy patterns.

8. **Deprecation closes the loop.** Legacy rows go to `deprecated`;
   migration playbook gets a retirement entry.

**What this prevents:** canonicalizing whatever happens to exist in code.
**What this enables:** continuously raising the visual bar while keeping
the system auditable.

## 7. Recommended next step

**Recommendation: produce mockups for reference screens 1 and 2 — Paywall
and Home — first. In that order.**

Justification:

**Paywall first (highest business leverage):**
- Largest source of design drift (three `primary-gradient` variants, many
  promo tones, inconsistent sticky CTAs).
- Once approved, unblocks:
  - `Banner tone="promo"` for canonical promotion
  - `Button variant="primary-gradient"` canonical state
  - Paywall-block composed pattern as canonical
  - The canonical brand gradient token
- Gives the "premium feels premium" principle a concrete anchor, which
  then calibrates how conservative we are with the premium vocabulary on
  free surfaces.

**Home second (highest-visibility surface):**
- Every user sees it. Drives emotional first impression.
- Once approved, unblocks:
  - `ListRow variant="card"` canonical
  - `SectionHeader` canonical (lowest-risk promotion in the system)
  - `StickyCTA` pattern canonical
  - Wishlist-card meta contract (shared-with chip, deadline, unread badge)

**Wish detail and Sheet-with-form follow.** Wish detail builds on Home's
card vocabulary. Sheet-with-form depends on the Sheet behavioral absorption
(a behavioral mockup, not a visual one — the approval is "we're folding
BottomSheet's iOS behavior into the primitive without regressing any
interaction").

**Why not one giant composite first?** One comp forces coherent decisions
but is hard to iterate on and easy to stall. Two focused mockups give
faster iteration and still exercise most primitives in context.

**Why not Button/Sheet/Toast mockups in isolation first?** Patterns look
right in isolation and wrong in situ. A button on a white page feels
different from a button anchoring a sticky CTA under a scrolling list.
Reference screens catch this.

### Cadence once mockups land

One approved mockup triggers one canonical promotion cycle:

1. Mockup approved → `DESIGN_DECISIONS.md` entry → North Star (this doc)
   updated
2. Implementation PR: token / primitive changes, stories, screenshot proof
3. Promotion PR: status flip per `PROMOTION_CHECKLIST.md`, deprecate
   replaced legacy
4. Migration wave: replace remaining legacy call-sites on touch

Target: **two canonical primitives per month** once reference-screen
mockups start landing. Faster is fine; slower means the mockup pipeline is
the bottleneck, not the code.

---

## Appendix — what this document is not

- **Not a style guide.** Style guides list colors and fonts. This document
  defines character and direction. Style sits below it (in
  [`FOUNDATIONS.md`](./FOUNDATIONS.md)).
- **Not a roadmap.** The roadmap sits in
  [`MIGRATION_PLAYBOOK.md`](./MIGRATION_PLAYBOOK.md) and in the decision
  backlog.
- **Not immutable.** This document evolves with every approved mockup. But
  it evolves by refining, not by being overwritten — each change is a
  decision with a trace.
- **Not a substitute for mockups.** It sets direction; mockups carry the
  concrete visual spec per surface.

## Appendix — when to re-read this document

- Before approving any mockup.
- Before promoting any primitive to `canonical`.
- When two reviewers disagree on whether a design is on-direction.
- When onboarding a new collaborator (human or AI).
- Quarterly, to check drift between the written vision and the lived
  product.
