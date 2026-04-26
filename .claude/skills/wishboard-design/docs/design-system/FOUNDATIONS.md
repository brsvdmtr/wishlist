# Foundations

All visual values in the app come from [`@wishlist/ui-tokens`](../../packages/ui-tokens).
Aligned with **approved v2 North Star mockups** (2026-04-19) in
[`./mockups/approved/`](./mockups/approved).

> **If a value isn't here, it doesn't exist yet.** Don't invent one ad hoc —
> add a semantic token to the package, then consume it.

## Status of tokens (2026-04-19)

| Token family | Status | Notes |
|--------------|--------|-------|
| `colors.*` | **approved values** | Palette codified against approved mockups. Santa palette distinct. |
| `avatarGradients.*` | **approved** | 5 named avatar gradients (accent/amber/green/pink/blue). |
| `spacing.*` / `spacingSemantic.*` | **approved** | 4 / 8 / 14 / 16 / 24 are the daily-used values. |
| `radius.*` / `radiusSemantic.*` | **approved, iteration pending** | May shift +2–4px rounder (backlog in `DESIGN_DECISIONS.md`). |
| `shadows.*` | **approved** | Full tier system + composed hero shadows + notification glows. |
| `typography.*` | **approved roles** | Semantic roles canonical; raw sizes 10/11/22/32 may prune later. |
| `motion.*` | **canonical** | Durations, easings, pressed-scale, keyframes, animations. |
| `zIndex.*` | **canonical** | Finite layered stack. |
| `sizing.*` | **canonical** | Touch-target 44 min; icon / avatar / button sizes. |
| `gradients.*` | **approved** | 15 presets incl. paywallHero, santaHero, profileCover, state-tints. |
| `safeArea.*` | **canonical** | `env(safe-area-inset-bottom)` helpers. |
| `breakpoints.*` | **canonical** | Phone-first. |

"Approved" = codified against approved mockups and binding for new code.
"Canonical" = promoted explicitly via `DESIGN_DECISIONS.md` entry.

---

## Colors

Dark-first palette. Values in
[`packages/ui-tokens/src/colors.ts`](../../packages/ui-tokens/src/colors.ts).

### Surfaces

| Token | Value |
|-------|-------|
| `colors.bg` | `#1B1B1F` |
| `colors.surface` | `#26262C` |
| `colors.surfaceHover` | `#2E2E36` |
| `colors.card` | `#2F2F38` |
| `colors.cardElevated` | `#33333D` |

### Brand

| Token | Value |
|-------|-------|
| `colors.accent` | `#7C6AFF` |
| `colors.accentSoft` | `rgba(124,106,255,0.12)` |
| `colors.accentGlow` | `rgba(124,106,255,0.25)` |
| `colors.accentStrong` | `#9B8AFF` |
| `colors.accentLight` | `#A78BFA` |
| `colors.accentDeep` | `#5B4BD6` |
| `colors.accentDeeper` | `#6B5CE7` (paywall gradient endpoint) |

### Semantic states

| Token | Value | Purpose |
|-------|-------|---------|
| `colors.success` / `.successSoft` / `.successStrong` | `#34D399` / tinted / `#10b981` | Reserved / purchased / positive |
| `colors.warning` / `.warningSoft` / `.warningStrong` | `#FBBF24` / tinted / `#f59e0b` | Expiring / attention |
| `colors.danger` / `.dangerSoft` | `#F87171` / tinted | Error / destructive / conflict |

### Seasonal (Santa sub-product only)

`colors.santaGreenDark` (`#0f5f3c`), `colors.santaGreen` (`#1a8552`),
`colors.santaRed` (`#d92020`). **Do NOT use outside Santa surfaces** — the
brand palette stays accent-purple.

### Priority scale

3 levels × {main / soft / glow / gradient-end}:
`priorityLow` (`#6B7FD4`), `priorityMedium` (`#E8930A`), `priorityHigh` (`#F04E6E`).

### Avatar gradients

Named identity-colors for user avatars (`avatarGradients.accent` / `.amber`
/ `.green` / `.pink` / `.blue`). Consumed by `AvatarStack`.

---

## Spacing

Evidence-based scale in [`spacing.ts`](../../packages/ui-tokens/src/spacing.ts).
Daily-use scale: **4 / 8 / 14 / 16 / 24**. Secondary: 12 / 20.

Prefer **semantic spacing tokens** in component code:

- `spacingSemantic.cardPadding` (16), `cardGap` (14)
- `spacingSemantic.sheetPadding` (24), `sheetTitleGap` (16)
- `spacingSemantic.buttonPaddingY` (14), `buttonPaddingX` (24)
- `spacingSemantic.listRowPadding` (16), `listRowGap` (14)
- `spacingSemantic.inlineIconGap` (8) — gap between icon and label

---

## Radius

```
 0   4    6    10   12   14   16   20    full
     xs   sm   md   lg   xl   xxl  xxxl
                         ↑
                       PRIMARY: cards / buttons / sheets
```

- `radius.sm` (6) — badges / micro chips
- `radius.md` (10) — status pills, medium thumbnails
- `radius.lg` (12) — inputs, plan-selector tiles, detail-row containers
- `radius.xl` (14) — **PRIMARY** cards, buttons, banners
- `radius.xxl` (16) — hero cards, profile prefs
- `radius.xxxl` (20) — bottom-sheet top, paywall hero, hero cards
- `radius.full` (9999) — long pills (chips `size="lg"`, circles)
- `radius.circle` (`'50%'`) — avatars, counter-badge, priority-dot

**Semantic aliases** (`radiusSemantic.card` / `.button` / `.input` / etc.)
are preferred in component code.

> **Forward iteration:** candidate token shift toward rounder —
> `xl` 14→16, `xxl` 16→20, `xxxl` 20→24. Not applied yet. See
> [`DESIGN_DECISIONS.md#decision-backlog`](./DESIGN_DECISIONS.md#decision-backlog-pending-explicit-approval).

---

## Shadows

Tiered system in [`shadows.ts`](../../packages/ui-tokens/src/shadows.ts).

| Tier | Tokens | Example use |
|------|--------|-------------|
| Subtle | `subtle`, `subtleStronger` | Checkboxes, inline chips |
| Elevated | `elevated` | Primary buttons |
| Deep | `deep`, `deepStronger`, `deepMax` | Sheets, floating cards |
| Overlay | `overlay`, `overlayCritical` | Dropdowns, menus |
| Brand glow | `glowSoft`, `glowMedium`, `glowStrong`, `glowCta` | Gradient CTAs |
| **Composed glow** | `glowCtaComposed` | **Canonical primary-gradient button** (triple-layer: glow + depression + inner highlight) |
| **Composed hero** | `paywallHero` | **Canonical paywall hero** (triple-layer with brand purple) |
| **Santa hero** | `santaHero` | Secret Santa (seasonal, no accent-color) |
| Ring focus | `ringFocus`, `ringSelected` | Focus rings / plan-selector |
| Notification | `notificationDanger`, `notificationAccent` | Counter-badge circles |
| Success pop | `successPopGlow` | Onboarding success check (green glow) |

---

## Typography

Semantic roles in [`typography.ts`](../../packages/ui-tokens/src/typography.ts).

| Role | Size × Weight × LH | Example |
|------|--------------------|---------|
| `splashTitle` | 22 × 800 × 1 | Onboarding hero, hero screens |
| `sectionHeader` | 17 × 700 × 1.2 | `<SectionHeader>` — "Мои вишлисты", "Подписки" |
| `cardTitle` | 15 × 600 × 1.3 | Wishlist card titles, item cards |
| `body` | 15 × 500 × 1.4 | Default body |
| `bodyStrong` | 15 × 600 × 1.4 | Emphatic body |
| `secondary` | 14 × 600 × 1.3 | Price, reservation meta |
| `caption` | 13 × 600 × 1.2 | Status badges, help text |
| `label` | 12 × 600 × 1.2 | Small labels, meta rows |
| `micro` | 10 × 700 × 1 | Badge chips (smallest) |

Font family: **`fontFamily.sans`** only (`-apple-system` stack). No web fonts.

Don't inline raw `fontSize: 15, fontWeight: 600` tuples. Use a role.

---

## Motion

Durations (`motion.duration`):

- `instant` 0.12s · `fast` 0.15s (PRIMARY) · `normal` 0.2s
- `slow` 0.3s (entrance) · `slower` 0.4s · `slowest` 1s

Easings (`motion.easing`):

- `standard` (`ease`) — default 95 % of cases
- `emphasized` (`cubic-bezier(0.4, 0, 0.2, 1)`) — toggle knobs
- `linear` — progress bars
- **`springOut`** (`cubic-bezier(0.34, 1.56, 0.64, 1)`) — **approved** for
  success pops

**Canonical transitions** — prefer these:

```ts
style={{ transition: transition.all }}
style={{ transition: transition.transformFast }}  // pressed-state
style={{ transition: transition.colors }}
```

**Pressed-state scale** (`motion.pressedScale`):
`button` 0.98 · `card` 0.995 · `tile` 0.97. Applied via CSS hook
`.wb-btn-pressed:active { transform: scale(var(--pressed-scale)) }` in
`globals.css`.

**Canonical animations** (`motion.animation`):

- `fadeIn`, `slideUp`, `toastIn` — entrance (0.3s)
- `pulse` / `dotPulse` — attention (1.5s / 2s loop)
- `shimmer` — skeleton (1.5s loop)
- `spin` — spinner (0.8s linear)
- **`successPop`** — success check on onboarding (0.6s springOut)
- **`float`** — floating hero emoji (4s loop)
- **`glowPulse`** — halo behind floating hero (3s loop)
- **`sparkle`** — twinkle decorations on success (1.5s loop)

All keyframes registered globally in
[`apps/web/app/globals.css`](../../apps/web/app/globals.css).

Full interaction rules: see
[`INTERACTION_SYSTEM.md`](./INTERACTION_SYSTEM.md).

---

## Z-index

Discrete layers — no intermediate values:

- `0` base · `10` raised · `50` sticky CTA bar
- `100`/`101` backdrop / sheet · `150` dropdown
- `200` toast · `500` critical overlay (reserved)

---

## Sizing

- **Touch target minimum** `touchTarget.min` = 44 px (hard rule).
- **Icons:** `iconSize` 12 / 14 / 16 / 20 / 24.
- **Avatars:** `avatarSize` 24 / 32 / 40 / 52 / 72 / 88 (xs / sm / md / lg / xl).
- **List thumbnails:** `thumbnailSize.md` = 52.
- **Button heights:** `buttonHeight.sm` 36 · `md` 44 · `lg` 50.

---

## Safe area

Telegram WebView safe-area helpers:

- `safeArea.stickyCtaBottom` — sticky CTA container bottom padding
- `safeArea.sheetBottom` — onboarding splash / fullscreen modal bottom
- `safeArea.sheetContentBottom` — bottom-sheet internal bottom padding

Never hard-code `calc(Xpx + env(safe-area-inset-bottom))` in feature code.

---

## Layout rules

- **Screen horizontal padding:** `spacingSemantic.screenPaddingX` = 16.
- **Section-to-section gap:** `spacingSemantic.sectionGap` = 16; 24–28 for
  major separators (state-matrix group gaps, onboarding sections).
- **Sticky footer pattern:** `position: fixed; bottom: 0`, fade-to-bg
  gradient (`gradients.fadeToBg`), `z-index: zIndex.sticky`, bottom
  padding `safeArea.stickyCtaBottom`, container `pointer-events: none` +
  inner button `pointer-events: auto`.
- **Card / list contract:** radius 14, padding 16, border
  `1px solid colors.border`, background `colors.card`.

---

## Responsive

- Target: 375–414 px phones.
- Must survive at 320 px without horizontal scroll.
- No breakpoint-driven layout outside rare tablet-and-up tweaks.

---

## RTL

App ships Arabic. Directional styling rules:

- Prefer **logical properties** (`paddingInlineStart`, `marginInlineEnd`,
  `insetInlineStart`).
- When layout genuinely needs sides, read `isRTL(locale)` and swap.
- Chevrons / back-arrows flip with locale. Check / heart / star don't.

---

## Adding a new token

1. Is there an existing semantic token that fits? Check first.
2. Is it a new **role** (not just a new value)? A new role earns a token;
   a new value for an existing role should align to the scale.
3. Add it in the appropriate `packages/ui-tokens/src/*.ts` with a
   one-line comment on its role.
4. Re-export from `packages/ui-tokens/src/index.ts`.
5. Update this file.
6. If it's a color / spacing / radius / shadow used by Tailwind
   consumers, mirror into `apps/web/tailwind.config.ts`.
7. Decision entry in `DESIGN_DECISIONS.md` (type: `token-change`).
