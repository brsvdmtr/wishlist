# Screen patterns

Recurring layouts in the Mini App. Every pattern references a concrete
approved mockup in [`./mockups/approved/`](./mockups/approved) as its
visual spec.

**Source-of-truth rule:** when this doc and a mockup conflict, the mockup
wins.

---

## Pattern 1: Home tab shell

**Mockup:** [`v2-home-all-tabs.html`](./mockups/approved/v2-home-all-tabs.html)
(all 3 tabs: Wishlists / Wishes / Reservations)

**Role:** persistent surface the user opens most often. Three distinct
mental modes via tab switch.

### Anatomy

```
┌─────────────────────────────────────┐
│ avatar │ greeting │ PRO │ ⚙ settings │  ← app-header (persistent across tabs)
├─────────────────────────────────────┤
│ [Вишлисты | Желания | Брони ⁵]       │  ← tab-bar with CounterBadge on Брони
├─────────────────────────────────────┤
│ (optional) sticky quick-filter chips │  ← Wishes / Reservations tabs
├─────────────────────────────────────┤
│                                       │
│   Tab-specific content                │
│                                       │
│                                       │
├─────────────────────────────────────┤
│ [   Sticky primary-gradient CTA   ]   │  ← tab-specific or absent
└─────────────────────────────────────┘
```

### Rules

- **App-header** is persistent. Avatar = tap-to-profile (iOS convention).
  ⚙ is an explicit settings entry next to PRO-chip.
- **Tab-bar** pill style: `colors.card` container, active tab gets
  `colors.accent` fill, counter-badge on top-right of tab with content.
- **Sticky CTA** varies by tab:
  - Wishlists → "+ Создать вишлист" (primary-gradient)
  - Wishes → "+ Добавить желание" (primary-gradient)
  - Reservations → **none** (броней не создают отсюда)

### Primitives used

`AvatarStack` · `Chip tone="pro"` · tab-bar (not yet primitive) ·
`CounterBadge` · `ListRow variant="card"` · `ListRow state="current"`
(for active wishlist) · `Banner tone="promo"` (for upsells) ·
`Button variant="primary-gradient" size="lg"` (sticky).

---

## Pattern 2: Wishlist detail — owner view

**Mockup:** [`v2-wishlist-detail-owner.html`](./mockups/approved/v2-wishlist-detail-owner.html)

### Anatomy

```
← back  |  "Мои вишлисты" small  |  ⋯ overflow
┌─────────────────────────────────────┐
│ 🎂 │ Title (22/800)                   │
│    │ "28 апреля · через 3 дня"        │
├─────────────────────────────────────┤
│ [🔗 link-only] [💬 все] [🚫 3]         │  ← meta chips
├─────────────────────────────────────┤
│ [12 желаний] [4 забр] [2 куплено]      │  ← StatTile row
├─────────────────────────────────────┤
│ ⏱ Smart reservation: 48 часов ›        │  ← settings-row
├─────────────────────────────────────┤
│ ▸ Техника (3)                         │  ← Category
│   • item card (shared, reserved, etc.) │
│   • item card                          │
│ ▸ Книги (2)                           │
│   • item card                          │
│ ▸ Прочее (0)                          │
│   [+ Add in Прочее] (dashed tile)     │
│                                       │
│ ⚙ Управление категориями               │
├─────────────────────────────────────┤
│ [   + Добавить желание   ]            │  ← sticky primary-gradient
└─────────────────────────────────────┘
```

### Rules

- WL-emoji (48×48 radius-12) + title (22/800) + sub (deadline).
- Meta chips after title — visibility, comment policy, don't-gift count.
- **StatTile row ×3** (tone neutral / success / accent) — instant summary.
- Smart-reservation as a single settings-row (not separate screen).
- Categories as collapsible cat-headers; empty category shows dashed
  "+add" tile (not "no items").
- Items: 56×56 thumb + priority-dot + title + desc + meta-row
  (price / shared chip / source chip).
- Shared wishes use `ListRow state` light-variant (border-tinted), not
  a separate variant.

### Primitives used

`SectionHeader` (cat-headers) · `StatTile` · `Chip` (meta + item meta) ·
`ListRow` (item cards) · `Button` sticky.

---

## Pattern 3: Wishlist detail — guest view (the gift-giving moment)

**Mockup:** [`v2-wishlist-detail-guest.html`](./mockups/approved/v2-wishlist-detail-guest.html)

### Anatomy

```
← back  |  "🎂 День рождения"  |  ⤴ share
┌─────────────────────────────────────┐
│ 👤 Anna Smirnova  · 28 апр, through 3d │  ← owner-card (tappable → showcase)
│    [+ Подписаться]                    │
├─────────────────────────────────────┤
│ 🚫 Что не дарить                      │  ← don't-gift banner (danger-soft)
│ [💄 косметика] [💐 цветы] [🍫 сладкое]  │
│ "Аллергия на никель..."               │
├─────────────────────────────────────┤
│ [Все 12] [😍 5] [😊 6] [🙂 1]           │  ← priority filter chips
├─────────────────────────────────────┤
│ item card (available) with Reserve + Secret buttons │
│ item card (reserved by me - green tint)  │
│ item card (reserved by other - muted)    │
│ item card (secret by me - accent tint)   │
│ item card (purchased - strike + faded)   │
├─────────────────────────────────────┤
│ 👥 Хочешь подарить вскладчину?          │  ← group-gift promo banner
└─────────────────────────────────────┘
```

### Rules

- Owner-card at top: avatar + name + deadline + "+ Подписаться" pill.
- **Don't-gift block FIRST** (before items) — critical for gift-giver.
- Per-item: `ListRow` with `state` prop driving the tint matrix.
- Reserve-CTA pattern: **two buttons side-by-side** — primary "✓ Забронировать"
  + soft accent "🔒 Тайно" (PRO). Not hidden in overflow.
- Group-gift promo is a `Banner tone="promo"` after the list.

### Primitives used

Owner-card (not yet primitive — compose with `Card` + avatar) · `Banner
tone="danger"` (don't-gift) · `Chip tone="prio-*"` (filter) · `ListRow
state="*"` · 2× inline `Button size="sm"` per available item · `Banner
tone="promo"` (group-gift invite).

---

## Pattern 4: Paywall

**Mockup:** [`v2-paywall.html`](./mockups/approved/v2-paywall.html)

### Anatomy

```
(context-chip top) "🔒 Чтобы разблокировать Тайные брони"
× close (top-right)
┌─────────────────────────────────────┐
│       👑 hero-gradient card          │  ← Card variant="hero"
│    WishBoard PRO (26/800)            │
│    "19 функций для тех кто дарит"    │
├─────────────────────────────────────┤
│ ✨ Новое в PRO                        │
│ [feature row × 4 with NEW badge]     │
├─────────────────────────────────────┤
│ ⏱ Reservation PRO                     │
│ [feature row × 6]                    │
├─────────────────────────────────────┤
│ 📦 Основные PRO                        │
│ [feature row × 10]                   │
├─────────────────────────────────────┤
│ [Месяц 299 ₽]  [Год 1990 ₽ -45%]     │  ← plan selector
├─────────────────────────────────────┤
│ 🎁 Или получи PRO бесплатно           │  ← referral-alt (dashed accent)
│    Пригласи 3 друзей →               │
├─────────────────────────────────────┤
│ [   Начать PRO · 1 990 ₽/год   ]     │  ← primary-gradient sticky
│ [      Не сейчас (ghost)       ]     │
│ ⭐ Stars · Отмена в любой момент     │  ← trust line
└─────────────────────────────────────┘
```

### Rules

- **Context-chip** at top tells which `UpsellContext` triggered. Pulls
  from the 15-context enum.
- **Hero** uses `Card variant="hero"` — `gradients.paywallHero` +
  `shadows.paywallHero`. Never roll custom.
- **3 feature sections** — Новое / Reservation PRO / Основные.
  `ListRow variant="plain"` rows with 40-sq icon in accent-soft square.
  NEW-badge on recent features.
- **Plan selector** — 2-tile grid. Selected = accent border + tint +
  `shadows.ringSelected`. Save-badge as absolute-positioned success chip.
- **Referral-alt** — dashed-border accent-soft tile with "→" — equal
  optical weight to paywall, not tiny fine-print.
- **Sticky footer** — primary-gradient with price on button ("Начать PRO
  · 1 990 ₽/год"), ghost "Не сейчас", trust-line tiny muted.

### Primitives used

Context-chip (not yet primitive) · `Card variant="hero"` · feature-row
(Phase 3 primitive) · Plan tile (Phase 3 primitive) · `Chip tone="new"` ·
`Button variant="primary-gradient" size="lg"` · `Button variant="ghost"`.

---

## Pattern 5: Sticky CTA

**Mockup:** everywhere (Home, Wishlist detail, Paywall, Onboarding)

### Contract

```tsx
<div style={{
  position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: zIndex.sticky,
  background: gradients.fadeToBg,
  padding: `24px ${spacingSemantic.screenPaddingX}px 28px`,
  paddingBottom: safeArea.stickyCtaBottom,
  pointerEvents: 'none',
  display: 'flex', flexDirection: 'column', gap: 10,
}}>
  <Button style={{ pointerEvents: 'auto' }}
          variant="primary-gradient" size="lg">Save</Button>
</div>
```

### Rules

- Content container must have bottom padding ≥ 120 px so the last row
  isn't hidden under the sticky.
- `pointerEvents: none` on container, `auto` on inner actions —
  passthrough scroll.
- Exactly **one** primary action. If two needed: primary-gradient +
  ghost below (paywall pattern).
- Always safe-area-aware (`safeArea.stickyCtaBottom`).
- Fade-gradient prevents text-bleeding-through-button.

Phase 3: extract as `<StickyCTA>` primitive.

---

## Pattern 6: Bottom sheet with form

**Mockup:** [`v2-reservations-pro.html`](./mockups/approved/v2-reservations-pro.html)
(detail sheet)

### Anatomy

```
(dimmed backdrop 60%)
┌─────────────────────────────────────┐
│ ▬ (drag handle, centered)            │
│ Sheet title (17/700)                 │
├─────────────────────────────────────┤
│ ┌─ item preview row (thumb + title) ┐│
│ └───────────────────────────────────┘│
│                                       │
│ ⏱ Smart reservation control           │
│ [+ Продлить на 48ч]  2 of 3 left     │
│                                       │
│ 📝 Моя заметка                        │
│ "Белый, с USB-C..."                  │
│                                       │
│ [☑ Куплено] - toggle row             │
│                                       │
│ [Отменить бронь] [Закрыть]           │  ← two-button footer
└─────────────────────────────────────┘
```

### Rules

- Sheet owns its CTA. No sticky-outside-sheet.
- Primary-action + destructive/ghost in 2-column flex at bottom.
- Controls are compact cards within the sheet (TTL control + note +
  toggle are individual card containers).

### Pending

Target sheet needs iOS swipe/inertia/keyboard absorption (see
`COMPONENTS.md#sheet`).

---

## Pattern 7: Empty state

**Mockup:** implied in all list screens (not yet a dedicated mockup —
target direction via onboarding success emotional language).

### Shape

```
        🎁 (large emoji or illustration, ~56-72px)
        
    Title (textStyles.sectionHeader)
    Subtitle (textStyles.body, muted)

       [Primary CTA]
```

Centered vertically. Warm, not fallback-ish. Phase 3 extract as
`EmptyState` primitive.

---

## Pattern 8: Secret-reservation derived state

**Mockup:** [`v2-secret-reservation.html`](./mockups/approved/v2-secret-reservation.html)

Unique WishBoard-specific pattern. Each item has:

- **State-strip** (left edge, 3px colored bar) — instant visual signal.
- **🔒 bade** on thumb (20×20 circle, accent fill, white border-blend).
- **State chip** in meta-row — tone-colored pill with state name.
- **Contextual action row** below meta — changes per state:
  - `ACTIVE` → no actions
  - `ITEM_UPDATED` → [👁 Сравнить] [Принять]
  - `PUBLIC_RESERVED_BY_OTHER` → [Отказаться] [→ Сделать публичной]
  - `ITEM_FULFILLED` / `ITEM_UNAVAILABLE` → inline prose, no actions

Phase 3: extract `<SecretReservationStateStrip>` as a primitive that
wraps any content.

---

## Pattern 9: Group-gift detail + chat

**Mockup:** [`v2-group-gift.html`](./mockups/approved/v2-group-gift.html)

### Components

- Hero wish preview — rose-tinted card with item image + price.
- Progress card — amount (20/800 success-colored) + momentum line +
  gradient-fill progress bar + "60% — осталось X" + deadline.
- Participants card — gradient-avatar rows with amount and time; pending
  slot with dashed border "+".
- Pinned payment message — dashed accent-soft tile (organizer's
  instructions).
- Sticky "💳 Внести свою долю" — primary-gradient.

Separate chat screen pattern: Telegram-style bubbles (me = accent,
them = surface), system-messages for contributions (dashed green border).

---

## Pattern 10: Secret Santa (sub-product)

**Mockup:** [`v2-santa-campaign.html`](./mockups/approved/v2-santa-campaign.html)

Distinct visual language — green/red seasonal gradient, not brand purple.

### Participant view

- Santa-hero (green→red gradient, ❄ decor, animated status-dot).
- Alias-card (animal emoji 56px + "Храбрый Лось" in `colors.priorityLow`).
- Assignment-card (accent-tint, "Ты даришь → 🦊" + budget).
- Participants grid — 2-col, animal-emoji avatars.
- Polls — inline bar-chart with lead-option accent-border.

### Organizer view

- Status tiles + "Ты не видишь кто кому" privacy statement.
- Aggregate gift-progress with 5 state-dots + counts.
- Timeline — 4 stages: approved ✓ / current accent-ring / pending dashed.
- Sticky dual buttons: surface + danger.

**Do NOT mix Santa gradient with brand accent-purple** on the same
screen. They are separate visual vocabularies.

---

## Pattern 11: Onboarding

**Mockup:** [`v2-onboarding.html`](./mockups/approved/v2-onboarding.html)

4 screens: **Hello → Why → Occasion pick → Success**.

### Shared shell

- Progress dots on bottom (`active` = 20px pill; `done` = accent-soft;
  `pending` = muted).
- Skip button top-right (screens 2–3 only; hello has no escape).
- Primary-gradient "Дальше" CTA.

### Screen-specific

- **Hello:** floating gift emoji (120px, `animation.float` + `glowPulse`
  halo + sparkles). Title 30/800 with accent-color brand word. Subtitle
  30-line intention statement.
- **Why:** 3 value-cards (tone: accent / green / amber) — 40sq icon +
  title + sub. Conversational wording.
- **Occasion pick:** 2×3 grid of occasions (🎂 ДР / 🎄 НГ / 💍 Свадьба /
  🎓 Выпуск / 🏡 Новоселье / 🎁 Просто так). Selected = accent-border +
  tint + ring-shadow.
- **Success:** pop-animated green check (100px, `animation.successPop` +
  `shadows.successPopGlow`). Sparkles. Tip-card after title. Dual CTA:
  "+ Добавить желание" primary + "Сразу поделиться" ghost.

### Rules

- Tone: разговорный русский, не перевод.
- No skip on hello (single entry point).
- `primary-gradient` CTA on every screen.

---

## Pattern inventory — summary by mockup

| Pattern | Mockup(s) | Primitives used |
|---------|-----------|-----------------|
| Home tab shell | `v2-home-all-tabs.html` | App-header, tab-bar, `CounterBadge`, `ListRow`, `Banner`, `Button` |
| Wishlist owner | `v2-wishlist-detail-owner.html` | `SectionHeader`, `StatTile`, `Chip`, `ListRow`, `Button` |
| Wishlist guest | `v2-wishlist-detail-guest.html` | `Banner` (don't-gift + promo), `Chip` (filters), `ListRow state="*"`, inline `Button`s |
| Wish state matrix | `v2-wish-state-matrix.html` | `ListRow state="*"`, `Chip` |
| Paywall | `v2-paywall.html` | `Card variant="hero"`, context-chip, plan tile, `Button primary-gradient` |
| Reservations PRO | `v2-reservations-pro.html` | Summary tiles (`StatTile`-like), filter chips, detail sheet |
| Secret reservation | `v2-secret-reservation.html` | State-strip pattern, `Chip state` matrix, contextual actions |
| Showcase profile | `v2-showcase-profile.html` | Cover gradient, avatar-over-cover, pinned wishlists, `Banner tone="danger"` (don't-gift) |
| Group gift | `v2-group-gift.html` | Progress card, participants list, pinned payment, chat bubbles |
| Santa | `v2-santa-campaign.html` | Santa-hero, alias-card, assignment-card, participant grid, timeline |
| Onboarding | `v2-onboarding.html` | Animated hero art, value-cards, occasion grid, success-pop |

Any screen you build should recognize itself in one of these patterns.
If it doesn't fit — start a new decision entry, don't invent silently.
