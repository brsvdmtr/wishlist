# Interaction system

Unified rules for motion, feedback, and transient UI. Codified against
approved v2 mockups (2026-04-19).

**Source-of-truth rule:** when text here and an approved mockup
conflict, the mockup wins.

---

## Motion

### Duration scale (canonical)

All durations come from
[`@wishlist/ui-tokens motion.duration`](../../packages/ui-tokens/src/motion.ts):

| Token | Value | Purpose |
|-------|-------|---------|
| `duration.instant` | 0.12s | Micro-interactions (list item insert, chip tap) |
| `duration.fast` | 0.15s | **Default** interactive feedback |
| `duration.normal` | 0.2s | State change (tab, toggle) |
| `duration.slow` | 0.3s | Entrance (modal/sheet/toast) |
| `duration.slower` | 0.4s | Progress fill |
| `duration.slowest` | 1s | Long progress (linear) |

### Easings (approved)

- `easing.standard` (`ease`) — default
- `easing.emphasized` (`cubic-bezier(0.4, 0, 0.2, 1)`) — toggle knobs only
- `easing.linear` — progress bars only
- `easing.springOut` — **success pops** (onboarding success check)

### Canonical transitions

Prefer string constants over inline custom:

```ts
transition: transition.all            // default for interactive
transition: transition.transformFast  // pressed-state scale
transition: transition.colors         // bg/color/border hover
transition: transition.transform      // position/scale
```

### Pressed-state scale (approved rule)

**Tactile feedback — mandatory for every interactive surface.**

| Surface | Scale factor | Token |
|---------|--------------|-------|
| Button | 0.98 | `pressedScale.button` |
| Card / ListRow (interactive) | 0.995 | `pressedScale.card` |
| Tile (occasion pick, StatTile tap) | 0.97 | `pressedScale.tile` |

Wired via CSS hook in [`globals.css`](../../apps/web/app/globals.css):

```css
.wb-btn-pressed:active { transform: scale(var(--pressed-scale, 0.98)); }
.wb-card-pressed:active { transform: scale(var(--pressed-scale, 0.995)); }
```

Primitives opt in by setting the `--pressed-scale` custom property and
the matching class. `Button` has `pressedEffect` prop (default `true`);
opt out with `pressedEffect={false}`.

### Canonical animations

```ts
animation: animation.fadeIn        // entrance 0.3s
animation: animation.slideUp       // sheet/modal slide up
animation: animation.toastIn       // toast appear
animation: animation.pulse         // 1.5s loop (loading skeleton accent)
animation: animation.dotPulse      // 2s loop (active-dot indicator)
animation: animation.shimmer       // skeleton shimmer
animation: animation.spin          // spinner

// Approved v2-specific:
animation: animation.successPop    // 0.6s springOut — onboarding success
animation: animation.float         // 4s loop — floating hero emoji
animation: animation.glowPulse     // 3s loop — halo behind floating hero
animation: animation.sparkle       // 1.5s loop — twinkle decorations
```

Keyframes registered in
[`apps/web/app/globals.css`](../../apps/web/app/globals.css) — MUST stay
in sync with `motion.keyframes`.

### When motion is allowed

- **Entrance** of a surface that genuinely appears (Sheet, Toast, newly
  inserted list item).
- **State change** that would otherwise snap (toggle knob, tab indicator).
- **Progress** (progress bar, skeleton shimmer).
- **Tactile feedback** (pressed-state scale).
- **Earned moments** (success check pop, hero-gradient shimmer on load).

### When motion is not allowed

- Every render (no auto-animating lists).
- Cinematic flourishes / parallax / multi-stage orchestrations.
- Motion > 500 ms that blocks the user for non-hero actions.
- On text content shifts (reading distraction).

### Reduced motion

`prefers-reduced-motion` in `globals.css` globally shortens animations
to 0.01 ms. **Don't re-enable motion inside a component.**

Decorative motion (`float`, `glowPulse`, `sparkle`, `snowfall`) must
have its own `@media (prefers-reduced-motion: reduce)` block disabling
it entirely.

### Sheet motion

- Open: `animation.slideUp` + backdrop `fadeIn` (both 0.3s).
- Close: unmount (exit animation TBD — tracked in `COMPONENTS.md#sheet`).

### Toast motion

- Enter: `animation.toastIn` (0.3s).
- Exit: auto-dismiss at 2.8s (see Toasts section below).

### List insert / remove

- Inserted: `animation.fadeIn` with staggered delay
  `animation-delay: ${index * 40}ms` for first visible batch; 0 after.
- Removed: no animation today. Phase 3: add slide-out-left.

### Dot-indicator pulse

Small status-dots (e.g. active-wishlist indicator, Santa campaign
"active" dot) use `animation.dotPulse` (2s slow loop).

---

## Toasts

**Visual target not yet codified in approved mockups.** Current contract
describes how Toast behaves today; Phase 2 Toast extraction needs its
own mockup cycle OR direct owner approval of extracted visual.

### Contract (current prod, validated)

```ts
type Toast = {
  id: string;
  message: string;
  kind: 'success' | 'error' | 'info' | 'warning';
};
```

### Position

- `position: fixed`, `bottom: 24`, `left: 16`, `right: 16`.
- Safe-area aware via `safeArea.stickyCtaBottom`.
- `zIndex: zIndex.toast` (200).

### Visuals

- Background: `colors.card`, border `1px solid colors.borderLight`.
- Radius `radius.xl` (14), padding `'14px 18px'`.
- Text: 14 × 600, centered.
- Color by kind: `success` → `colors.success`, `warning` →
  `colors.warning`, `info` → `colors.textSecondary`, `error` →
  `colors.danger`.
- Shadow: `shadows.deepMax`.

### Stacking

- Max 3 visible.
- Newest on top (FIFO; rendered from index 0 upward).
- Gap 8 px.
- Container `pointerEvents: none`; individual toast `auto` only if
  actionable.

### Timing

- Auto-dismiss at **2.8s**.
- No pause-on-hover (mobile target).

### Target improvements (Phase 2 mockup needed)

1. **Priority stack:** `error > warning > success > info`. A higher
   priority toast never gets pushed off by lower.
2. **Coalescence:** same `message` within 1.5s increments `×N` counter.
3. **Tone indicator on leading edge** (small colored dot/bar) —
   visually stronger than text-color alone.
4. **Optional action** — `pushToast(msg, kind, { action: { label,
   onClick } })` renders a ghost button trailing.
5. **Exit animation** (fade-out + slide-down).

### CTA inside toast

- **Not allowed today.** If you need a CTA, use a `Banner` instead.
- Phase 2 adds the action slot per target above.

### Severity mapping

- `success` — confirms completed action (save, reserve, purchase).
- `warning` — something may go wrong soon (reservation expiring).
- `error` — transient failure user can retry (save failed). For
  screen-blocking errors, use inline `Banner`.
- `info` — low-importance status (syncing). Avoid overuse.

---

## Counter-badge (approved 2026-04-19)

Notification counter as a circle, **never inline in text**.

- Position: absolute, top-right of parent (`top: -6px`, `right: -6px`).
- Parent must be `position: relative`.
- Circle, 20 px (`md`) / 16 px (`sm`), 2 px border-blend to parent bg.
- Tone: `danger` default (most common notification signal).
- Shadow: tone-matched (`shadows.notificationDanger`).
- Hides at `count <= 0` unless `showZero`.
- `pointer-events: none`.

Primitive: [`CounterBadge`](./COMPONENTS.md#counterbadge).

Source: `v2-home-all-tabs.html` tab-bar counter on "Брони".

---

## Feedback patterns

### Inline validation

- Below the input, 13 × 600, `colors.danger`.
- On blur or submit attempt; NOT on every keystroke.
- Clears as soon as the value becomes valid.

### Destructive confirmation

- `Sheet` with title "Delete {thing}?" + body + two buttons:
  `<Button variant="danger">Delete</Button>` + `<Button variant="ghost">Cancel</Button>`.
- Don't use browser `confirm()` — breaks on mobile WebView.
- Irreversible actions (account deletion) require typed confirmation.

### Success confirmation

- **Quick action** (save, reserve) → `pushToast(msg, 'success')`.
- **Multi-step completion** (onboarding finish) → full-screen success
  state with emoji + title + CTA — see `v2-onboarding.html` screen 4.
  Uses `animation.successPop` + `shadows.successPopGlow`.

### Save feedback

- Button switches to `loading` state while request in flight.
- Success: toast + optional navigation.
- Failure: toast kind `'error'`; form stays filled; button returns to
  idle.

### Retry patterns

- **Auto-retry** only for idempotent GETs with clear network errors —
  max 3 attempts, exponential backoff.
- **Manual retry:** `Banner tone="danger"` with
  `action={<Button size="sm" variant="secondary">Retry</Button>}`.

### Loading feedback

- Skeleton blocks matching final layout shape.
- `Button loading={true}` for action-in-flight.
- Full-screen spinner ONLY for hard app-boot. Not for per-screen loads.

### Empty states

- Not an error — visual language: emoji + title + subtitle + CTA.
- See Pattern 7 in [`SCREEN_PATTERNS.md`](./SCREEN_PATTERNS.md).

### Error states

- Scoped tightly: broken section shows `Banner tone="danger"`; rest of
  screen still works.
- Catastrophic errors (auth expired, no network) → full-screen surface
  with retry CTA.

---

## Sticky CTA pattern

Per [`SCREEN_PATTERNS.md` Pattern 5](./SCREEN_PATTERNS.md#pattern-5-sticky-cta):

- `position: fixed; bottom: 0`, fade-to-bg gradient (`gradients.fadeToBg`).
- Safe-area bottom padding (`safeArea.stickyCtaBottom`).
- `z-index: zIndex.sticky` (50).
- `pointer-events: none` on container, `auto` on action.
- Exactly **one** primary action.
- Content above must have bottom padding ≥ 120 px.

Haptic `'light'` fires on primary/primary-gradient button press by default
(see `Button` haptics rules).

---

## Keyboard / form interactions

- `Enter` in an input submits the surrounding form's primary CTA if it's
  a single-input form; otherwise moves focus to next field.
- Telegram WebView quirks:
  - Viewport shrinks when keyboard opens. Use `100dvh` or JS fallback,
    not `100vh`.
  - Input `type=number` with `inputMode="decimal"` gives a better mobile
    keyboard for prices.
  - Bottom-sheet with focused input: push sheet up via `visualViewport`
    API so input stays visible (pending absorption into `Sheet`).
- Blur-on-scroll inside sheets: ≥ 20 px cumulative move → blur focused
  input (approved iOS UX from current `BottomSheet`).

---

## Haptics

Approved touch points (Telegram WebApp `HapticFeedback.impactOccurred`):

- **Primary / primary-gradient button press** → `'light'` (default via
  `Button` primitive).
- **Reservation confirmed** → `'medium'` (emotional moment).
- **Secret reservation activated** → `'medium'`.
- **Destructive action completed** → `'heavy'` (rare; reserved for
  intentional destructive confirms).
- **Toggle switch** → `'light'`.

Don't use haptics for:

- Every screen transition.
- Content scrolling.
- Low-emphasis interactions (ghost/secondary/surface buttons default to
  no haptic).

---

## Accessibility quick rules

- Every interactive element ≥ 44 × 44 tap target.
- `aria-label` on icon-only buttons.
- Focus ring via `shadows.ringFocus` visible on keyboard focus.
- Screen-reader order matches visual order — no absolute-positioned
  reflow that swaps logical order.
- RTL: logical properties (`paddingInlineStart` etc) preferred over
  `left` / `right`. Directional icons (chevrons) flip.
