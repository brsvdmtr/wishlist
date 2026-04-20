# Components

UI primitives live in [`packages/ui`](../../packages/ui). All new UI must
compose from these — no feature-local clones.

**Visual source of truth:** approved v2 mockups in
[`./mockups/approved/`](./mockups/approved). When text and mockups
conflict, mockups win.

## Status matters — check the registry

Every primitive has a **status** in
[`COMPONENT_REGISTRY.md`](./COMPONENT_REGISTRY.md):

- `canonical` — approved direction, depend freely.
- `provisional` — codified against approved mockups; API may refine. All
  Phase-1 primitives here.
- `provisional-needs-redesign` — structurally usable but visuals/behavior
  below canonical bar (current: `Sheet` — needs iOS-behavior absorption).
- `legacy` — ad-hoc pattern in the monolith, migrate on touch.
- `deprecated` — do not add new usages.

## Current primitives (Phase 2 — all `provisional`)

### Core (Phase 1 extractions — refined under approved mockups)
- [Button](#button)
- [Card](#card)
- [Sheet](#sheet)
- [SectionHeader](#sectionheader)
- [ListRow](#listrow)
- [Banner](#banner)

### Extensions (added 2026-04-19 from approved v2 mockups)
- [Chip](#chip)
- [CounterBadge](#counterbadge)
- [StatTile](#stattile)
- [AvatarStack](#avatarstack)

### Not yet extracted (Phase 3 targets — all `legacy` today)
`Input`, `TextArea`, `IconButton`, `Toast`, `ScreenHeader`, `StickyCTA`,
`EmptyState`, `Skeleton`, `Menu`, `OnboardingSplash`, `GroupGiftProgress`,
`PaywallHero`, `ReservationTTLControl`, `SecretReservationStateStrip`.

Do not clone any of these in feature code — lift into `packages/ui`
first with a registry entry.

---

## Button

```tsx
import { Button } from '@wishlist/ui';

<Button variant="primary" onClick={onReserve}>Reserve</Button>
<Button variant="primary-gradient" size="lg" leftIcon={<StarIcon />}>Начать PRO</Button>
<Button variant="secondary">Cancel</Button>
<Button variant="ghost" size="sm" fullWidth={false}>Skip</Button>
<Button variant="danger" loading={deleting}>Delete</Button>
<Button variant="surface">📧 Отправить напоминание</Button>
```

**Codified in:** every v2 mockup. Hero CTAs in `v2-paywall.html`,
`v2-onboarding.html`, `v2-home-all-tabs.html`.

### Variants (approved)

| Variant | Usage | Source |
|---------|-------|--------|
| `primary` | Most commit actions — single per screen | Wishlist detail "Save", reserve buttons |
| `primary-gradient` | Hero CTA — paywall, onboarding, sticky create-wishlist | `v2-paywall.html` bottom sticky, `v2-home` sticky "Создать вишлист", `v2-onboarding.html` "Дальше" |
| `secondary` | Secondary positive — accent-soft fill | Extension actions, secondary confirms |
| `ghost` | Tertiary — transparent, muted | "Не сейчас", "Отменить бронь" |
| `danger` | Destructive — danger-soft fill | "Отменить кампанию", delete confirmations |
| `surface` | Neutral — card-colored + border | Group-gift "📧 Отправить напоминание", secondary utility |

### Sizes (approved)

- `sm` (h 36) — inline row buttons, compact layouts
- `md` (h 44) — default; meets touch-target minimum
- `lg` (h 50) — hero CTAs (paywall, onboarding, sticky creates)

### States (approved)

- **Pressed:** `transform: scale(0.98)` via CSS `:active` (default; opt out
  via `pressedEffect={false}`). Tactile feedback within 30 ms.
- **Loading:** spinner replaces leading icon, label stays visible, button
  stays same width. `aria-busy` set.
- **Disabled:** opacity 0.55 + `cursor: not-allowed`. No press feedback.
- **Focus:** outline via `shadows.ringFocus` on keyboard focus (TODO:
  wire programmatically; today relies on browser default).

### Haptics (approved)

Primary and primary-gradient buttons fire Telegram WebApp haptic `'light'`
on click by default. Override with `haptic={null}` (disable) or
`haptic="medium"` (emphasis).

### Anti-patterns

- ❌ Writing `<button style={{ padding: '14px 24px', borderRadius: 14, ... }}>` — use `<Button>`.
- ❌ Overriding `background` / `color` via `style` — pick a different variant.
- ❌ Custom shadow passed via `style={{ boxShadow }}` — use `primary-gradient`
  for brand glow.
- ❌ Multiple `primary-gradient` on one screen — it signals "this is THE
  CTA." One per screen. Max.

---

## Card

**Status (per-variant):** `default` / `interactive` are **`canonical`**
(promoted 2026-04-19, 5 live call-sites). `flat` / `current` / `hero`
are `provisional`.

```tsx
<Card>{/* default: radius 14, padding 16, bordered */}</Card>
<Card variant="interactive" onClick={open}>Clickable item card</Card>
<Card variant="flat" padding="lg">Flat surface (provisional)</Card>
<Card variant="current">Active / selected state (provisional)</Card>
<Card variant="hero" padding="lg">Paywall hero (provisional)</Card>
```

**Codified in:** all v2 mockups. Hero variant in `v2-paywall.html`;
current variant in `v2-home-all-tabs.html` (active wishlist).

### Variants

| Variant | Background | Border | Used for | Status |
|---------|-----------|--------|----------|--------|
| `default` | `colors.card` | 1px `colors.border` | Standard content cards | canonical |
| `interactive` | same as default + cursor + transition | same | Tappable cards (wishlist rows) | canonical |
| `flat` | `colors.surface` | none | Container-in-container nesting | provisional |
| `current` | `gradients.accentStateTint` | 1px accent-30% + inset ring | Active / selected state | provisional |
| `hero` | `gradients.paywallHero` | none + `shadows.paywallHero` | Paywall hero, other premium surfaces | provisional |

### Padding scale

`none` (0) · `sm` (12) · `md` (16, default) · `lg` (20).

### Anti-patterns

- ❌ `<div style={{ background: C.card, borderRadius: 14, padding: 16, border: ... }}>` in new code — use `<Card>`.
- ❌ Style overrides of `background`, `border`, `borderRadius` — pick a
  different variant. Only positional props (`margin`, `opacity`,
  `animation`, `WebkitTapHighlightColor`) belong in `style`.
- ❌ Passing `onClick` to `variant="default"` — use `variant="interactive"`
  so you get cursor + hover transition.

---

## Sheet

```tsx
<Sheet open={open} onClose={close} title="Reservation note">
  <p>...</p>
  <Button onClick={save}>Save</Button>
</Sheet>
```

**Status: `provisional-needs-redesign`.** Visual shell correct; iOS
behavior (swipe / inertia / keyboard-blur) must be absorbed from the
local `BottomSheet` in `MiniApp.tsx:2023` before canonical promotion.

Codified visual target: `v2-reservations-pro.html` detail sheet.

### Contract (current)

- Fixed bottom, slide-up entrance.
- Backdrop 60% black; dismiss on click unless `dismissOnBackdrop={false}`.
- Radius 20 on top corners only.
- Body scroll locked; max-height 85 vh.
- Respects `safeArea.sheetContentBottom`.
- Drag handle visible (40×4 pill).

### Blockers for canonical

1. iOS swipe-to-dismiss with velocity / inertia (exists in BottomSheet).
2. Keyboard-aware layout (focused input visible).
3. Blur-on-scroll threshold (≥ 20 px cumulative → blur active field).
4. Exit animation.
5. Destructive-confirm variant (centered short sheet, 2 buttons).

### Anti-patterns

- ❌ Rolling your own bottom-sheet — use `Sheet` (today) or the existing
  `BottomSheet` function for iOS-critical flows until absorption lands.
- ❌ Nested sheets. If a choice requires further input, current sheet
  dismisses and a new surface opens.

---

## SectionHeader

**Status: `canonical`** (promoted 2026-04-19).

```tsx
// Default: left-aligned section-break header
<SectionHeader>Мои вишлисты</SectionHeader>
<SectionHeader icon={<span>⭐</span>} action={<a>Все</a>}>Закреплённые</SectionHeader>
<SectionHeader marginTop={24}>Подписки</SectionHeader>

// Centered: dialog/sheet content title
<SectionHeader center marginBottom={8}>Delete wishlist?</SectionHeader>
```

**Codified in:** every v2 mockup. Default shape is identical across all
surfaces. `center` variant codified by 2026-04-19 promotion PR for
dialog/sheet-content titles.

### Contract (canonical)

- Text: `textStyles.sectionHeader` (17 × 700 × 1.2, letter-spacing -0.01em).
- Color: `colors.text`.
- Font family: `fontFamily.sans`.
- Default `marginBottom: 16`; pass `marginTop` to override.
- Dividerless by intent — space separates.
- Optional leading `icon` + trailing `action` slot (default variant only).
- **Default variant** (`center: false`, default): flex layout, space-between
  justification. Title ellipsizes; action stays far right.
- **`center` variant**: plain block, `textAlign: center`, icon inline
  with 8px right-margin. Action slot is **ignored** when `center` is true
  (centered dialog titles don't use inline actions).

### When to use

| Context | Example | Props |
|---------|---------|-------|
| Section header above a list | "Мои вишлисты", "Подписки" | Default + optional `action`/`icon` |
| Dialog / sheet content title | "Delete wishlist?", "Reservation confirmed" | `center` + custom `marginBottom` |

### Anti-patterns

- ❌ Using for page titles (those live in the screen-header pattern).
- ❌ Setting `center` when an `action` slot is needed (contradiction —
  use the default variant).
- ❌ Styling child text via `style` prop — the component owns typography.
- ❌ `<div style={{ fontSize: 17, fontWeight: 700 }}>` in new code — use
  `SectionHeader` instead. If centered: pass `center` prop.

---

## ListRow

**Status (per-variant):** `card` is **`canonical`** (promoted 2026-04-20,
5 live call-sites + 3 states validated). `compact` / `plain` are
`provisional`.

```tsx
<ListRow
  variant="card"
  state="current"
  leading={<Thumb>🎂</Thumb>}
  title="День рождения"
  meta={<>
    <Chip tone="warning">⏱ через 3 дня</Chip>
  </>}
  trailing={<ChevronRight />}
  interactive
  onClick={open}
/>
```

**Codified in:** all v2 mockups. State-tint matrix in
`v2-wish-state-matrix.html`.

### Variants (approved)

- `card` (default) — bordered dark card; 16 padding; main wishlist lists.
- `compact` — 12/14 padding; denser lists (reservations).
- `plain` — no bg/border; 14 px vertical padding; inside sheets/forms.

### States (approved — visual tint matrix)

| `state` | Visual | Used for |
|---------|--------|----------|
| `neutral` | `colors.card` + subtle border | Available items (default) |
| `current` | `gradients.accentStateTint` + accent border + inset ring | Active wishlist, selected |
| `reservedByMe` | `gradients.successStateTint` + success border | Guest-reserved-by-viewer |
| `secret` | `gradients.accentStateTint` + accent border | Secret reservation cards |
| `warning` | `gradients.warningStateTint` + warning border | Expiring / item updated |
| `conflict` | `gradients.dangerStateTint` + danger border | Public-reserved-by-other |
| `muted` | Card + opacity 0.55 | Reserved by someone else |
| `done` | Card + opacity 0.45 + strike title | Purchased / completed / deleted |

### Slots

- `leading` — thumbnail, avatar, icon (flex-shrink: 0)
- `title` — main text, up to 2-line clamp, ellipsized
- `subtitle` — secondary text, 2-line clamp, ellipsized
- `meta` — chips / price row under subtitle
- `trailing` — chevron, badge, action (centered vertically)

### Anti-patterns

- ❌ Using a `<Card>` and hand-rolling the row grid — use `ListRow`.
- ❌ Setting color / opacity / border via `style` for state purposes —
  use the `state` prop. If a state is missing, extend `ListRowState`.

---

## Banner

**Status (per-tone):** `info` / `success` / `warning` / `danger` are
**`canonical`** (promoted 2026-04-19). `promo` is `provisional` (pending
first paywall-wave migration).

```tsx
<Banner tone="success" bordered icon={<span>✅</span>}>Подарено</Banner>
<Banner tone="warning">{t('comments_archive_warning', locale)}</Banner>
<Banner tone="info" icon={<span>👁</span>}>{t('surprise_notice', locale)}</Banner>
<Banner tone="danger" title="Couldn't load">Retry in a moment</Banner>
<Banner tone="promo" icon={<StarIcon />} action={<Button size="sm">Upgrade</Button>}>
  Unlock PRO for secret reservations
</Banner>
```

**Codified in:** `v2-wishlist-detail-guest.html` (don't-gift danger +
group-gift promo), state-matrix, 5+ real call-sites in MiniApp after
Wave 1.

### Contract (canonical for neutral tones)

- Background: `colors.{tone}Soft` · foreground: `colors.{tone}`.
- Radius: `radius.xl` (14) · padding: `12px 14px`.
- Font: `fontSize.base` (13), `lineHeight: 1.5`.
- Icon: leading slot, 16 px default (override via `<span style={{ fontSize: 18 }}>`).
- Optional `title` (14 × 700, `marginBottom: 2`).
- `action` (trailing) or `onClose` × (trailing). Not both.
- `center` — single-line centered messages.
- `bordered` — adds `1px solid rgba(tone-rgb, 0.2-0.25)` for emphasis.
  Ignored for `promo`.

### Tones

| Tone | Use | Status |
|------|-----|--------|
| `info` | Neutral info strips (surprise-notice, inline notes) | canonical |
| `success` | Positive state (purchased, reserved) | canonical |
| `warning` | Caution / expiring / read-only / archived | canonical |
| `danger` | Error / destructive / conflict | canonical |
| `promo` | Hero upsell (paywall, group-gift invites) | provisional |

### Anti-patterns

- ❌ Using `tone="promo"` for low-emphasis info — it reads as CTA.
- ❌ Two banners stacked in the same surface — rethink hierarchy.
- ❌ Close-button + action-button together — pick one.
- ❌ `style={{ borderRadius, padding, fontSize, background, color }}` —
  these are the canonical contract, not overridable. Only positional
  overrides (`margin`, `marginTop`, `flexShrink`) belong in `style`.

---

## Chip

**Status: `canonical`** (promoted 2026-04-20 — 15 live call-sites across
accent / success / warning / surface tones).

```tsx
import { Chip } from '@wishlist/ui';

<Chip tone="success">3 забронировано</Chip>
<Chip tone="warning">⏱ через 3 дня</Chip>
<Chip tone="accent" size="lg">🔗 в 2 вишлистах</Chip>
<Chip tone="pro">⭐ PRO</Chip>
<Chip tone="new">3 новых</Chip>
<Chip tone="prio-3">😍</Chip>
```

**Codified in:** every v2 mockup — approved state-chip language.

### Tones (approved)

`accent` · `success` · `warning` · `danger` · `surface` · `prio-1` /
`prio-2` / `prio-3` · `new` (accent fill + glow) · `pro` (brand gradient,
always pill-shaped).

### Sizes

- `sm` — micro (counter-like, 10px font, 2×7 padding, radius 6)
- `md` (default) — 11px font, 3×8 padding, radius 6
- `lg` — 12px font, 5×10 padding, **pill** radius

### Anti-patterns

- ❌ Hand-rolling `<span style={{ padding: '3px 8px', background, color, ... }}>` — use `<Chip>`.
- ❌ Stacking >3 chips in one meta row — collapse or reprioritize.

---

## CounterBadge

```tsx
import { CounterBadge } from '@wishlist/ui';

<div style={{ position: 'relative' }}>
  Брони<CounterBadge count={5} />
</div>
```

**Codified in:** `v2-home-all-tabs.html` Брони-tab counter.

### Contract

- Position: **absolute, top-right** (`top: -6px`, `right: -6px`). Parent
  must be `position: relative`.
- Circle shape, 20px (`md`) / 16px (`sm`), 2px border-blend to parent bg.
- Tones: `danger` (default, red) · `accent` · `success` · `warning`.
- Hides at `count <= 0` unless `showZero` set. Caps at `max` (default 99),
  shows `"99+"`.
- Has `pointer-events: none` — doesn't intercept parent clicks.
- Shadow tone-matched via `shadows.notificationDanger` etc.

### Anti-patterns

- ❌ Placing counter-value inline inside text (`"Брони 5"`) — the badge is
  a notification, not a count label.
- ❌ Overriding positioning — only edge-cases should pass `style`.

---

## StatTile

```tsx
import { StatTile } from '@wishlist/ui';

<div style={{ display: 'flex', gap: 10 }}>
  <StatTile n={12} label="желаний" />
  <StatTile n={4} label="забронировано" tone="success" />
  <StatTile n={2} label="куплено" tone="accent" />
</div>
```

**Codified in:** `v2-wishlist-detail-owner.html` stat-row,
`v2-secret-reservation.html` hero-meta.

### Contract

- Card with tone-tinted background + tone-color border.
- Big `n` (20px extrabold, tone-colored) on top.
- Label (11px muted, letter-spacing) below.
- Default `flex: 1` — fits in grid/flex row.
- Tones: `neutral` · `accent` · `success` · `warning` · `danger`.
- `inline` prop — compact version for hero blocks (no card background,
  22/800 number, 11px opacity-0.8 label).

---

## AvatarStack

```tsx
import { AvatarStack } from '@wishlist/ui';

<AvatarStack
  avatars={[
    { label: 'А' },
    { label: 'М', gradient: 'amber' },
    { label: 'К', gradient: 'green' },
    { label: '?', gradient: 'blue' },
    { label: '!', gradient: 'pink' },
  ]}
  max={3}
/>
```

**Codified in:** `v2-home-all-tabs.html` shared-wishlist avatars,
`v2-group-gift.html` participants, `v2-santa-campaign.html` participant
grid.

### Contract

- Overlapping avatars with 2px border-blend to parent bg.
- Overlap -6px (sm) / -8px (md).
- Beyond `max`, tail collapses into `"+N"` slot.
- `gradient` prop picks from `avatarGradients` token: `accent` / `amber`
  / `green` / `pink` / `blue`.
- `borderColor` defaults to `colors.card` — pass parent bg for seamless
  blending.

---

## Composition rules

1. **Screens compose from primitives.** A screen is mostly a screen-header
   (still ad hoc — Phase 3 extract), a vertical stack of `SectionHeader`
   / `ListRow` / `Card` / `Banner`, and optionally a sticky `Button`
   footer.
2. **Never override the primitive's core contract.** Radii, heights,
   shadows are the contract, not parameters.
3. **Accept the `style` prop only for positional adjustments** (margin,
   flex-grow). If you need to override colors / padding — that's a
   missing variant; add it.
4. **If a pattern appears 3+ times, extract it.** Don't wait for the
   fourth.

---

## Component lifecycle

- New variant → PR adds it to the primitive in `packages/ui`, documents
  here, adds a proof-of-use.
- New primitive → PR adds to `packages/ui`, adds a section here, adds a
  row to `COMPONENT_REGISTRY.md` with `provisional` status, adds a
  `DESIGN_DECISIONS.md` entry.
- Status change → follow [`PROMOTION_CHECKLIST.md`](./PROMOTION_CHECKLIST.md).
- Deprecation → keep alive ≥ 1 release, add `@deprecated` JSDoc with
  migration pointer.

---

## Not yet primitives (Phase 3 targets)

Approved visual targets in mockups but not extracted:

- `ScreenHeader` — back + title + overflow/contextual icons. Visible in
  every wishlist-detail / item-detail / profile mockup.
- `StickyCTA` — `position: fixed` bottom + fade-to-bg gradient + safe-area
  + primary button. Every screen with primary action.
- `Toast` — visual language **not codified yet** in approved mockups.
  Phase 2 extraction needs its own mockup.
- `EmptyState` — warm empty-state with emoji + title + CTA.
- `Skeleton` — per-layout loading skeletons.
- `OnboardingSplash` — `v2-onboarding.html` four-screen template.
- `PaywallHero` — specific `Card variant="hero"` composition.
- `SecretReservationStateStrip` — left-edge 3px state-colored strip.
- `GroupGiftProgress` — progress card with gradient bar + momentum indicator.
- `ReservationTTLControl` — extend-button + progress bar + extension counter.

Until extracted, compose from existing primitives.
