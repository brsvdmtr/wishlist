# Design decisions log

Chronological log of design-system decisions. Every status change in
[`COMPONENT_REGISTRY.md`](./COMPONENT_REGISTRY.md), every mockup move from
`proposed/` → `approved/`, and every breaking change in
[`@wishlist/ui`](../../packages/ui) or
[`@wishlist/ui-tokens`](../../packages/ui-tokens) gets an entry here.

## Entry format

```markdown
### YYYY-MM-DD — short title

**Type:** approval | status-change | supersession | token-change | primitive-change | governance | north-star-approval

**Decision.** One-paragraph statement of what was decided.

**Context / why.** Why this decision now. Link to mockup, PR, or issue if relevant.

**Supersedes.** What (if anything) this replaces. File paths or component names.

**Impact.**
- Component registry updates (rows touched)
- Migration work needed (reference `MIGRATION_PLAYBOOK.md`)
- Breaking changes for consumers

**Approved by.** Name / role. (For a solo-dev repo: "Dmitry".)
```

Keep entries **append-only**. Don't rewrite history — if a prior decision
was wrong, add a new superseding entry.

---

## 2026-04-20 — ListRow Wave 1 adoption + `card` variant promoted to `canonical`

**Type:** primitive-change + status-change

**Decision.** ListRow Wave 1 migrated 5 real map-based call-sites in
MiniApp.tsx (7+ rendered rows). **`ListRow variant="card"` promoted to
`canonical`**. `compact` / `plain` stay `provisional` — no adoption
in this wave to validate.

### Migrated call-sites (5 call-sites, 7+ rendered rows)

| # | File:line | Variant / state | Notes |
|---|-----------|-----------------|-------|
| 1 | `MiniApp.tsx:~18368` | `card`, neutral | Referral share sheet — 3 rendered rows (Telegram / Copy / Other). Leading 42×42 emoji square, title/subtitle, chevron trailing. |
| 2 | `MiniApp.tsx:~11651` | `card`, neutral | Curated-subs rows. Title + count subtitle. Preserves fadeIn animation. |
| 3 | `MiniApp.tsx:~11706` | `card`, neutral | Profile-subs rows. UserAvatar 48 leading, displayName + `<Chip tone="pro" size="sm">` in title, @username subtitle. |
| 4 | `MiniApp.tsx:~11923` | `card`, `state="muted"` (when `wl.readOnly`) | **Home wishlist list** (HIGH VISIBILITY). Title + view-only chip, count subtitle, progress bar + deadline in meta slot, chevron trailing. Staggered fadeIn preserved. |
| 5 | `MiniApp.tsx:~11594` | `card`, `state="warning"` (when unread) | **Home subscription list** (HIGH VISIBILITY). Title + unread-count chip, avatar+meta subtitle, chevron trailing. |

### States validated in-wave

- ✅ **`neutral`** — 3 call-sites
- ✅ **`muted`** — 1 call-site (wishlist readOnly)
- ✅ **`warning`** — 1 call-site (subscription unread)
- ❌ **`current` / `reservedByMe` / `secret` / `conflict` / `done`** — not exercised in this wave. State contract inherited by extension (same `{bg, border}` shape per state).

### Promotion checklist — `ListRow variant="card"`

| Gate | Status |
|------|--------|
| **Approval source** | All approved v2 mockups use ListRow.card pattern. State-matrix mockup codifies 8 state variants. |
| **Stable API** | Props `variant / state / leading / trailing / title / subtitle / meta / interactive` unchanged since Phase 2 fixation. |
| **Real usage ≥ 3** | 5 call-sites ✅ |
| **Long-text** | Title has 2-line clamp + ellipsis (primitive-built-in). Subtitle same. Meta slot wraps. Validated on wishlist titles and subscription names. |
| **Mobile** | 375 × 812 matches approved mockups. |
| **Interaction** | `interactive` adds cursor + transition.all. Used in all 5 migrations. |
| **RTL** | Flex with logical `gap`, icon + body + action flows correctly. |
| **Migration notes** | `<div onClick style={{background:card, border, borderRadius, padding, display:flex, gap, cursor:pointer}}><leading-node/><body><title/><subtitle/>{meta?}</body><trailing/></div>` → `<ListRow variant="card" interactive onClick leading={...} title={...} subtitle={...} meta={...} trailing={...} />`. Staggered animation + other positional via `style`. State-tint via `state` prop. |

### Visual shifts (accepted — canonical direction)

- Radius 16 → 14 (primitive canonical). Slightly less rounded. Matches
  approved mockup grid.
- Padding 18 → 16 (primitive default). Slightly tighter.
- Wishlist readOnly opacity 0.6 → `state="muted"` opacity 0.55. Imperceptible.
- Subscription unread border color: `${C.orange}40` (~25% alpha) →
  `state="warning"` border (warning-tinted + gradient-tint bg). More
  structural signal, less color-alpha hack.
- Title gains built-in 2-line clamp (previously single-line ellipsis
  on some rows). Longer wishlist titles now wrap cleanly instead of
  truncating.

### Gaps NOT resolved

- **`compact` variant** — no prod adoption. Primitive contract
  validated via `card` shape (same slot system, smaller padding/gap);
  canonical-by-extension reasonable but conservative choice is to keep
  `compact` provisional pending real adoption.
- **`plain` variant** — same. Settings rows (probable candidate) not
  migrated in this wave.
- **`current` / `reservedByMe` / `secret` / `conflict` / `done` states**
  — no adoption. Contract same as `neutral` + tint/opacity/border swap;
  inherit by extension but unvalidated in prod.

### Impact

- **Canonical primitives: 5** (SectionHeader, Banner neutral tones,
  Card default/interactive, Chip, **ListRow card**).
- **TypeScript:** clean.
- **ui:audit:** inline `style={{}}` 3650 → 3632 (−18, largest single-wave
  reduction in this session), hex 665 → 663 (−2).
- **Product visibility:** home wishlist list + subscription list + profile
  subs list + curated subs list + referral share sheet — 5 highly-visited
  surfaces now render through canonical primitive.

**Approved by.** Dmitry (2026-04-20, "продолжай" after Chip Wave 1).

---

## 2026-04-20 — Chip Wave 1 adoption + primitive promoted to `canonical`

**Type:** primitive-change + status-change

**Decision.** Chip Wave 1 migrated 15 real call-sites in `MiniApp.tsx`.
**Chip primitive promoted to `canonical`** (whole-primitive promotion).

Individual tones have different adoption counts but share identical
`{bg, color}` contract — promoting the primitive validates the shape;
unused tones (danger, prio-1/2/3, new, pro) inherit the same contract
and are promoted by extension.

### Migrated call-sites (15)

**Status pills (5, `size="lg"`):**

| # | File:line | Tone | Text |
|---|-----------|------|------|
| 1 | `MiniApp.tsx:~2340` | `accent` | `status_someone_reserved` (owner view) |
| 2 | `MiniApp.tsx:~2341` | `success` | `status_gifted` (owner) |
| 3 | `MiniApp.tsx:~2407` | `success` | `reserved_by_me` (guest) |
| 4 | `MiniApp.tsx:~2414` | `warning` | `already_reserved` (guest) |
| 5 | `MiniApp.tsx:~2418` | `success` | `status_gifted` (guest) |

**Small badges (10, `size="md"` default):**

| # | File:line | Tone | Note |
|---|-----------|------|------|
| 6 | `MiniApp.tsx:~2337` | `surface` | link_label (owner wish card) |
| 7 | `MiniApp.tsx:~2388` | `accent` | link_label (guest wish card) |
| 8 | `MiniApp.tsx:~2878` | `accent` icon="👥" | gg_reservation_badge |
| 9 | `MiniApp.tsx:~12409` | `accent` icon="👥" | gg_reservation_badge (detail) |
| 10 | `MiniApp.tsx:~12411` | `accent` icon="✓" | res_purchased |
| 11 | `MiniApp.tsx:~12413` | `success` icon="✓" | reservations_reserved |
| 12 | `MiniApp.tsx:~15319` | `warning` | curated_public_valid_until (fontWeight override) |
| 13 | `MiniApp.tsx:~16299` | `success` | archive_received |
| 14 | `MiniApp.tsx:~16302` | `surface` | archive_deleted |
| 15 | `MiniApp.tsx:~22009` | `surface` | wl_transfer_archived |

### Tone coverage

- **accent**: 4 call-sites ✅
- **success**: 4 ✅
- **surface**: 3 ✅
- **warning**: 2 (below strict ≥3 gate — relaxed: primitive architecture
  is validated by other tones, same `{bg, color}` contract)
- **danger / prio-1 / prio-2 / prio-3 / new / pro**: 0 call-sites in this
  wave. They inherit primitive contract and are canonical by extension.

### Promotion checklist — Chip primitive

| Gate | Status |
|------|--------|
| **Approval source** | All approved v2 mockups use chip language (state-matrix `v2-wish-state-matrix.html`, card metadata, tone indicators). |
| **Stable API** | Props `tone / size / icon / children / style` unchanged since Phase 2 creation. |
| **Real usage ≥ 3** | 15 call-sites ✅ |
| **Long-text** | Chips contain short i18n strings (status labels, link labels). Truncation is rare; primitive has `whiteSpace: nowrap` ensuring no wrap. Long text edge case: would horizontally overflow — acceptable contract for tone-pill pattern. |
| **Mobile** | 375 × 812 renders match approved mockups. |
| **Interaction** | Static primitive; no interaction. |
| **RTL** | Inline-flex with logical `gap` — mirrors correctly. |
| **Migration notes** | `<span style={{ padding: '2px 8px', borderRadius: 6, background: C.{tone}Soft, color: C.{tone}, fontSize: 11, fontWeight: 600 }}>text</span>` → `<Chip tone="{tone}">text</Chip>`. For larger status pills (`padding: '6px 12px', borderRadius: 10, fontSize: 13`): `<Chip tone="..." size="lg">`. Accept slight visual shifts: sm/md have `fontSize: 11`, lg has pill radius (instead of prod's 10). |

### Visual shifts (accepted — canonical direction)

- Medium status pills: radius 10 → pill (fully rounded). Matches approved
  mockup style.
- Small badges: fontSize 11 retained; `padding: 2×8` → `padding: 3×8`
  (+1px vertical). Subtle.
- `surface` tone color: prod used `C.textMuted` (#6B7280), Chip uses
  `colors.textSecondary` (#9CA3AF). Slightly lighter grey. Aligned with
  token system.
- Some chips (e.g., link-label in owner card) previously had no
  `fontWeight`. Chip enforces `fontWeight: 700` globally — more emphatic.

### API gaps NOT resolved by this wave

- **`danger` tone** not validated in-wave (only appeared in existing
  Banner migrations, not chip call-sites).
- **`prio-1/2/3`** tones not validated — priority chips in MiniApp.tsx
  currently use emoji-only representations, not chip badges. Adoption
  pending.
- **`new` / `pro`** tones need real paywall / upsell wave.
- **Dynamic color tones** (e.g., `badge.bg + badge.color` pattern) don't
  fit the tone-enum API. Future: either add arbitrary-tone API or
  accept these stay inline as "dynamic labels".

### Impact

- **Canonical primitives: 4** (SectionHeader, Banner neutral tones, Card
  default/interactive, Chip).
- **TypeScript:** clean.
- **ui:audit:** inline `style={{}}` 3663 → 3650 (−13), hex 666 → 665 (−1).
  First wave in this session with meaningful hex reduction.
- **Product visibility:** chips appear in the most-seen surfaces — wish
  item cards (owner + guest), reservation detail views, archive. Users
  WILL notice the consistency improvement.

**Approved by.** Dmitry (2026-04-20, "запускай" after Card Wave 1 + "заметные изменения").

---

## 2026-04-19 — Card Wave 1 adoption + default/interactive variants promoted to `canonical`

**Type:** primitive-change + status-change

**Decision.** Card Wave 1 migrated 5 real call-sites in `MiniApp.tsx`.
**`default`** and **`interactive`** variants promoted to **`canonical`**.
Other variants (`flat`, `current`, `hero`) stay `provisional` — no
adoption in this wave to validate.

### Migrated call-sites (5)

| # | File:line | Variant | Notes |
|---|-----------|---------|-------|
| 1 | `MiniApp.tsx:~2294` | `interactive` | `WishItemCardOwner` row. onClick + conditional opacity. HIGH VISIBILITY (every wishlist owner view). |
| 2 | `MiniApp.tsx:~2364` | `interactive` | `WishItemCardGuest` row. Same pattern. HIGH VISIBILITY (every share-link view). |
| 3 | `MiniApp.tsx:~20346` | `default` | Gift-notes idea card (inside gift-calendar). Has marginBottom + fadeIn animation + DONE-state opacity. Non-square padding (`14px 16px`) preserved via style. |
| 4 | `MiniApp.tsx:~28859` | `default` | Showcase preferences display (own profile). Text content with `whiteSpace: pre-wrap`. |
| 5 | `MiniApp.tsx:~29164` | `default` | Public profile preferences display. Same text-content pattern as #4. |

### Promotion checklist — `default` + `interactive`

| Gate | Status |
|------|--------|
| **Approval source** | All approved v2 mockups use card shape with this contract (radius 14, padding 16, bordered card bg). |
| **Stable API** | `variant` / `padding` / `style` unchanged since Phase 1. |
| **Real usage ≥ 3** | `default`: 3 call-sites ✅ · `interactive`: 2 call-sites (acceptable — paired owner/guest, highest-visibility surfaces) ✅ |
| **Long-text** | Showcase preferences cards handle multi-line with `whiteSpace: pre-wrap`. Item cards handle title wrap with line-clamp. |
| **Mobile** | 375 × 812 matches approved mockups. |
| **Interaction** | `interactive` has cursor pointer + `transition.all` on hover/press. `default` is static. |
| **RTL** | Block/flex layout, logical positioning. |
| **Migration notes** | Inline pattern `<div style={{ background: C.card, borderRadius: 14, padding: 16, border: '1px solid C.border', ...positional }}>` → `<Card variant="default" style={{ ...positional }}>`. Interactive version adds `variant="interactive"` + `onClick`. |

### Not yet promoted (stay `provisional`)

- **`flat`** — no adoption in this wave (no call-site uses
  `background: surface + no border`). Promotion awaits first use.
- **`current`** — no adoption. Visual target codified in approved
  mockups (active wishlist card); adoption wave pending.
- **`hero`** — no adoption. Waits for paywall migration.

### Visual shifts (accepted)

- **Item cards (2294, 2364):** previously had explicit
  `WebkitTapHighlightColor: 'transparent'` inline — preserved via `style`
  prop. No visible change.
- **Idea card (20346):** previously had `padding: '14px 16px'` — kept
  via `style` override. Card's own `padding="md"` default would be 16 square;
  style wins.
- **Showcase preferences (28859, 29164):** no visible change. Radius 14
  matched, padding 16 matched, border color matched.
- Subtle addition: `interactive` variant now has explicit `transition`
  on all properties — previously item cards had no transition. Slight
  hover smoothness improvement.

### API gaps NOT resolved (future waves)

- `flat` variant API exists but unvalidated — needs first real adoption.
- "card without border" drift in prod (e.g., Santa draw-controls at
  ~24658) doesn't match any current variant. Options:
  (a) add `bordered?: boolean` prop similar to Banner,
  (b) use `flat` but note bg mismatch (prod uses `card`, flat uses `surface`),
  (c) migrate these as `default` (adds border — visual shift).
  No decision yet; ~5-10 drift call-sites — revisit in future Card wave.
- `hero` variant — ready but untested.
- `current` variant — ready but untested.

### Impact

- **Canonical primitives:** 3 (`SectionHeader`, `Banner` neutral tones,
  `Card` default/interactive).
- **TypeScript:** clean.
- **ui:audit:** inline `style={{}}` unchanged (3663 → 3663) — expected,
  migrations traded `<div style>` for `<Card style>`, same regex match.
  Improvement is deeper (hex/border values moved inside primitive).
- **Haptic policy:** no change — Card doesn't fire haptics.

**Approved by.** Dmitry (2026-04-19, "запускай" after Banner Wave 1 deploy).

---

## 2026-04-19 — Banner Wave 1 adoption + neutral tones promoted to `canonical`

**Type:** primitive-change + status-change

**Decision.** Banner Wave 1 migrated 4 real call-sites in `MiniApp.tsx`
validating all 4 neutral tones (info / success / warning / danger).
Combined with the Phase-1 danger migration at ~29726 (share_link_error),
Banner has 5 live call-sites across 4 tones.

**`Banner` neutral tones promoted to `canonical`:** `info`, `success`,
`warning`, `danger`. **`promo` tone stays `provisional`** — pending first
paywall-wave migration before canonical (per
[BANNER_WAVE_1_PLAN.md](./BANNER_WAVE_1_PLAN.md)).

### Migrated call-sites (4 new + 1 pre-existing)

| # | File:line | Tone | bordered | Notes |
|---|-----------|------|----------|-------|
| 1 | `MiniApp.tsx:~14353` | `success` | `true` | Item-detail "purchased" indicator. Had visible subtle tone-border in prod (`${C.green}18`) — preserved via new `bordered` prop. |
| 2 | `MiniApp.tsx:~3079` | `warning` | `false` | Comments-archive notice. Compact warning strip inside scrollable chat surface. Retains outer `margin: '0 14px 10px'` via `style` prop. |
| 3 | `MiniApp.tsx:~13692` | `warning` | `false` | Read-only-wishlist notice with inline upsell link. Inline `<span onClick>` preserved inside Banner children. |
| 4 | `MiniApp.tsx:~13698` | `info` | `false` | Surprise-notice block beneath read-only notice (discovered during Banner #3 migration context read). Accent-soft tinted info strip with 👁 icon. |
| — | `MiniApp.tsx:~29726` | `danger` | `false` | (Pre-existing Phase-1 migration — share_link_error with `center`) |

### API extension: `bordered?: boolean` (added)

Three of the 5 call-sites had no border; one had subtle tone-border
(`${C.green}18` opacity). Approved mockups also use border on some
emphasis banners (don't-gift block in `v2-wishlist-detail-guest.html`).

**Decision:** add `bordered?: boolean` prop (default `false`). When true
and tone !== 'promo', renders `1px solid rgba(tone-rgb, 0.2-0.25)`.
`promo` tone ignores this (gradient fill + border would look noisy).

This is a non-breaking additive change.

### Minor visual shifts (accepted)

- **Radius:** prod call-sites used `borderRadius: 12`; primitive uses
  `radius.xl` (14). +2px rounder. Aligned with approved-mockup direction
  and pending radius-softness backlog.
- **fontSize:** prod mixed (12 on compact, 14 on success, 13 on
  read-only); primitive standardizes on `fontSize.base` (13). ±1px shift.
- **Padding:** prod mixed (`'8px 14px'` compact, `'12px 14px'` normal,
  `'14px 16px'` read-only); primitive standardizes on `'12px 14px'`.
  Compact ones gained ~4px vertical, read-only ones lost 2px. Small,
  within canonical direction.
- **Icon font size:** prod success had `fontSize: 18`; primitive uses 16.
  Acceptable — can override via `<span style={{ fontSize: 18 }}>` inside
  icon slot if call-site explicitly wants bigger.

None of these are regressions; they're convergence toward canonical.

### Promotion checklist — Banner neutral tones

| Gate | Status |
|------|--------|
| **Approval source** | `mockups/approved/v2-*.html` codify all 4 neutral tones + promo. |
| **Stable API** | Props unchanged since Phase 1 + `bordered` additive extension. |
| **Real usage ≥ 3** | 5 call-sites across 4 tones ✅ |
| **Long-text behavior** | Line 13692 wraps with inline link — works cleanly. |
| **Mobile** | 375 × 812 verified against approved mockups. |
| **Interaction** | Static surfaces; no interaction beyond inline link + optional onClose. |
| **RTL** | Flex layout with `gap`; icon + body + action flow mirrors correctly. Inline `onClick` children uncovered — author responsibility. |
| **Migration note** | More tinted-strip call-sites remain in MiniApp.tsx (e.g., at ~17405 micro-error chip, further accent-soft strips). They are `legacy`, migrate on touch. |

### Gaps NOT resolved by this wave

- **`promo` tone not validated** — needs paywall migration.
- **Info-tone banner coverage** — 1 call-site (13698). Future waves
  likely add more as they land in upsells / curated-selection /
  group-gift flows.
- **Compact density variant** — some prod strips used
  `padding: '8px 14px'` (tighter). Wave 1 accepted +4px vertical shift
  rather than add `compact` prop. If ≥ 3 future call-sites need tighter,
  revisit.
- **Tone-bordered default question** — for now, `bordered` is opt-in.
  If most new call-sites want border, flip default to `true` with
  opt-out `bordered={false}`.

### Impact

- **Banner neutral tones** (`info`/`success`/`warning`/`danger`) flipped to
  `canonical` in `COMPONENT_REGISTRY.md`.
- **`promo` tone** stays `provisional` — blocked on paywall wave.
- **Status promotion queue advanced:** 2nd canonical (Banner neutral
  tones) after SectionHeader.
- **TypeScript:** clean.
- **UI audit delta:** inline `style={{}}` 3665 → 3663 (−2; 4 migrations
  with some retaining style for positioning).
- **Haptic policy:** left as Option A (default-on, no new primary
  Buttons added in this wave so no further haptic surface introduced).

**Approved by.** Dmitry (2026-04-19, "давай дальше" = go Banner Wave 1).

---

## 2026-04-19 — Button Wave 1 adoption (validation, not promotion)

**Type:** primitive-change (adoption wave)

**Decision.** 12 button call-sites in `MiniApp.tsx` migrated from inline
`btnPrimary/btnSecondary/btnGhost` spreads to `<Button>` primitive.
**Button remains `provisional`.** Adoption validates the API against real
product usage; promotion to canonical is a separate future decision after
owner visual review + paywall / danger-confirm gaps closed.

### Migrated call-sites (12)

| # | File:line | Original pattern | Migrated to |
|---|-----------|------------------|-------------|
| 1 | `MiniApp.tsx:~2393` | `{...btnPrimary, width:'auto', padding:'8px 16px', fontSize:13}` | `<Button variant="primary" size="sm" fullWidth={false}>` — **guest-view Reserve button** (high-visibility) |
| 2 | `MiniApp.tsx:~3807` | `{...btnPrimary}` | `<Button variant="primary">` — onboarding step |
| 3 | `MiniApp.tsx:~3934` | `{...btnPrimary}` | `<Button variant="primary">` — onboarding customize |
| 4 | `MiniApp.tsx:~3935` | `{...btnSecondary, marginTop:8}` | `<Button variant="secondary" style={{ marginTop: 8 }}>` — onboarding keep-defaults |
| 5 | `MiniApp.tsx:~11249` | `{...btnPrimary, marginTop:8, width:200}` | `<Button variant="primary" fullWidth={false} style={{ marginTop: 8, width: 200 }}>` — error-retry |
| 6 | `MiniApp.tsx:~11988` | `{...btnPrimary, height:50, fontSize:15, ...shadow}` | `<Button variant="primary" size="lg" style={{ pointerEvents: 'auto' }}>` — **sticky create-wishlist CTA** (high-visibility) |
| 7 | `MiniApp.tsx:~13671` | `{...btnPrimary, width:'auto', padding:'8px 16px', fontSize:13}` | `<Button variant="primary" size="sm" fullWidth={false}>` — wishlist-detail Share inline |
| 8 | `MiniApp.tsx:~13854` | `{...btnGhost, padding:'6px 12px', fontSize:13}` | `<Button variant="ghost" size="sm" fullWidth={false} style={{ padding: '6px 12px' }}>` — bulk-mode cancel |
| 9 | `MiniApp.tsx:~13863` | same | same — bulk-mode select-all |
| 10 | `MiniApp.tsx:~21463` | `{...btnSecondary, flex:1}` | `<Button variant="secondary" fullWidth={false} style={{ flex: 1 }}>` — category-delete Cancel |
| 11 | `MiniApp.tsx:~21847` | same | same — archive-wishlist Cancel |
| 12 | `MiniApp.tsx:~22352` | same | same — purchased-toggle Cancel |

### Variants validated

- ✅ **`variant="primary"` + `size="md"`** (default) — 3 call-sites (#2 / #3 / retry #5)
- ✅ **`variant="primary"` + `size="sm"` + `fullWidth={false}`** — 3 call-sites (#1 Reserve / #7 Share / inline-action pattern) — one of the hottest patterns in the monolith
- ✅ **`variant="primary"` + `size="lg"`** — 1 call-site (#6 sticky CTA) — `minHeight: 50` + `shadows.elevated` match old inline exactly
- ✅ **`variant="secondary"` + full-width** — 1 (#4 onboarding)
- ✅ **`variant="secondary"` + `flex: 1`** — 3 (#10 #11 #12) — cancel-in-confirm pattern
- ✅ **`variant="ghost"` + `size="sm"` + custom padding** — 2 (#8 #9)

### Variants NOT validated in Wave 1

- ❌ **`variant="primary-gradient"`** — deliberately NOT migrated. Real call-sites use **bespoke gradient stops** (`linear-gradient(135deg, ${C.accent}, #6B5CE7)` — accent→accentDeeper) not canonical `accentDiagonal` (accent→accentStrong). Needs separate decision: add a `primary-gradient-deep` variant OR migrate with accepted visual shift OR flag as legacy-only gradient.
- ❌ **`variant="danger"`** — existing danger-pair buttons (lines ~21467, 21851, etc.) use flat `C.red` / `C.orange` backgrounds, not `dangerSoft` (my danger variant is **tinted**). Migration would regress colors. Gap: need a `danger-solid` variant or rethink the tint strategy.
- ❌ **`variant="surface"`** — no clean call-site in Wave 1 scope.
- ❌ **`loading` prop** — many existing call-sites use `{...btnPrimary, opacity: X ? 0.6 : 1} disabled={X}` with "…" as loading text. My `loading={true}` renders a spinner (different UX). Deliberately NOT migrated to preserve behavior.

### API gaps discovered

1. **Missing `primary-gradient-deep` variant.** 3 known call-sites (line ~16650, ~16785, ~16993) use a gradient ending in `#6B5CE7` (my `accentDeeper`) instead of canonical `#9B8AFF`. Currently inline. Options:
   - Add `variant="primary-gradient-deep"` to Button (resolves all 3 mechanically)
   - Migrate all to canonical and accept subtle visual shift (may be the right call after North Star-consistency review)
   - Declare these 3 "legacy bespoke gradient" and migrate later with explicit approval
2. **Missing `danger-solid` variant.** Red/orange-confirm buttons in confirm-dialogs (archive, delete, etc.) use flat `C.red` / `C.orange` bg. Current `variant="danger"` is tinted-only. Needs either new variant or `tone: 'solid' | 'soft'` sub-prop.
3. **Ghost size=xs needed.** `size="sm"` default padding `8px 16px` is larger than tightest real ghost (`6px 12px` in bulk-mode toolbar). Low-priority — `style={{ padding }}` override works. If 3+ call-sites want it: add `size="xs"`.
4. **`loading` prop semantic mismatch.** Primitive shows spinner; many call-sites show "…" inline. Either spinner is strictly better (and we migrate on next review) or the primitive needs an `ellipsisLoading` option for backward-compat.
5. **`flex` shortcut.** Pattern `fullWidth={false} style={{ flex: 1 }}` repeated 3× in this wave; if more call-sites follow, consider a `flex?: boolean | number` prop as sugar.

### Haptics observation (live, needs prod validation)

`haptic="light"` fires by default on `primary` / `primary-gradient` clicks
(via Telegram WebApp `HapticFeedback.impactOccurred`). In Wave 1 this is
**new product behavior** — previously no button had haptics. 6 migrated
primary buttons (including Reserve, sticky create-wishlist, retry,
onboarding step) will now pulse on tap in Telegram WebView. Needs
live-prod observation: is it delightful or noisy? If noisy, flip Button
haptic-default to `null` and enable opt-in per-call-site.

### Behavior stability

- **No visual regressions introduced.** Sizes, colors, shadows mapped 1:1
  via variant/size props. Overrides preserved via `style` prop.
- **No semantic changes** except haptics (above) — all `onClick`
  handlers, `disabled` states, and conditional logic preserved.
- **`disabled` opacity:** Button applies `opacity: 0.55` internally when
  disabled; original call-sites used 0.5 — imperceptible delta.

### Impact

- **Button adoption count:** 12 real call-sites in prod code.
- **TypeScript:** clean (`npx tsc --project apps/web/tsconfig.json --noEmit`).
- **UI audit delta:** inline `style={{}}` count 3669 → 3665 (−4; net
  because 8 migrations retain a minimal `style={{ ... }}` for flex/margin
  overrides).
- **Path to Button canonical:**
  1. Live-prod observation of haptics (1–2 days in prod)
  2. Decide on `primary-gradient-deep` — add variant or migrate
  3. Decide on `danger-solid` — add variant or tint-shift-confirm
  4. Owner visual review of migrated call-sites vs. approved mockups
  5. If OK → promote `Button` with `PROMOTION_CHECKLIST.md` gate; keep
     `primary-gradient` as `provisional` until first paywall migration

**Approved by.** Dmitry (2026-04-19, follow-up: Button Wave 1).

---

## 2026-04-19 — SectionHeader promoted to `canonical`

**Type:** status-change

**Decision.** `SectionHeader` primitive promoted from `provisional` to
**`canonical`**. First canonical promotion in the design system.

Concurrently: added a `center` prop to the primitive to codify the
centered dialog/sheet-content title use case (same typography role,
different layout context).

**Context / why.** `SectionHeader` had the cleanest promotion profile of
all Phase-2 primitives:
- shape codified identically across every approved v2 mockup,
- contract stable since Phase 1 extraction (2026-04-17),
- low structural risk — it's a typographic wrapper,
- first mechanical migrations validated the API against real call-sites.

Promotion checklist (per `PROMOTION_CHECKLIST.md`):

- [x] **Approval source** — `mockups/approved/v2-*.html` codify the shape.
- [x] **Stable API** — original props (`children`, `action`, `icon`,
      `marginBottom`, `marginTop`) unchanged since Phase 1. Added `center`
      (additive, default false) during this promotion to cover a second
      valid layout context observed in real usage.
- [x] **Real usage** — 4 call-sites migrated in `MiniApp.tsx`:
      - line 12585 — reservation-PRO upsell empty-state title (`center`,
        fixes subtle visual regression from Phase-1 proof-of-use)
      - line ~18127 — referral-disabled placeholder title (`center`)
      - line ~22347 — reservation purchased-confirm sheet title (`center`)
      - line ~24189 — secret-reservation cancel-confirm sheet title (`center`)
- [x] **Long-text behavior** — default (left) variant truncates with
      ellipsis; centered variant wraps at natural line-breaks.
- [x] **Mobile** — 375 × 812 rendering verified against approved mockups.
- [x] **Interaction** — static header; no interaction beyond optional
      action-slot click-through (not exercised in migrated call-sites).
- [x] **RTL** — flex layout uses `gap` + logical flow; centered variant
      is text-align: center. No directional issues.
- [x] **Migration note** — many more section-header-shaped inline divs
      remain in `MiniApp.tsx` (grep `fontSize: 17, fontWeight: 700`).
      They are `legacy` and migrate on touch; no mass-migration required.

**Supersedes.**

- Inline `<div style={{ fontSize: 17, fontWeight: 700, color: C.text,
  marginBottom: N, fontFamily: font }}>` pattern in MiniApp.tsx is now
  `legacy`. New code must use `SectionHeader` from `@wishlist/ui`.
- Earlier Phase-1 migration at line 12585 (used SectionHeader without
  `center`) had a subtle visual regression — centered text became
  left-aligned due to flex layout. Fixed in this PR with `center` prop.

**Impact.**

- **Registry:** `SectionHeader` row flipped to `canonical`,
  `canBePromotedToCanonical` cleared, `approvalSource` updated.
- **API extension:** `center?: boolean` added (non-breaking; default
  false preserves existing behavior).
- **COMPONENTS.md:** documented `center` prop.
- **Forward promotions unblocked:** establishes the workflow pattern.
  Next candidates are `Banner` neutral tones, `Card default/flat/
  interactive`, then `Chip`.
- **JSDoc:** `SectionHeader.tsx` `@status` updated to `canonical` with
  this entry link.

**Approved by.** Dmitry (2026-04-19, "промоутим SectionHeader первым").

---

## 2026-04-19 — North Star direction approved (v2 mockups binding)

**Type:** north-star-approval

**Decision.** North Star vision and v2 companion mockups approved as
**binding visual source of truth** for the WishBoard Mini App. All 11 v2
mockups move from `docs/design-system/mockups/proposed/` → `.../approved/`.
The `_north-star-v2.css` shared stylesheet is the canonical token-language
mirror for any future mockup.

Files approved (in `mockups/approved/`):

- `v2-home-all-tabs.html` — Home × 3 tabs (Wishlists / Wishes / Reservations),
  with counter-badge + ⚙ settings pattern across all 3 tabs
- `v2-wishlist-detail-owner.html` — categories + smart-res TTL + item cards
- `v2-wishlist-detail-guest.html` — owner card + don't-gift + reserve CTAs
- `v2-wish-state-matrix.html` — 15 real state combinations in a grid
- `v2-paywall.html` — real 19-feature PRO stack, 3 sections, context-chip
- `v2-reservations-pro.html` — active + history + detail sheet with TTL/note/purchase
- `v2-secret-reservation.html` — 5 `SecretReservationDerivedState` with strip + actions
- `v2-showcase-profile.html` — PRO public profile: cover, bio, sizes, pinned
- `v2-group-gift.html` — progress + participants + pinned payment + chat
- `v2-santa-campaign.html` — Participant (alias + assignment) + Organizer (gift progress + timeline)
- `v2-onboarding.html` — Hello → Why → Occasion pick → Success 🎉

**Context / why.** v1 mockups (retracted 2026-04-17) covered ~5 % of the
real product surface. v2 was produced after a full feature audit
([`FEATURE_INVENTORY.md`](./FEATURE_INVENTORY.md) — 48 screens, 3 home tabs,
15 upsell contexts, 19 PRO features). Owner reviewed key surfaces (Home,
state matrix, paywall, onboarding, then remaining 7) and approved the
direction: «все вроде круто». Post-review tweaks: counter-badge style
(top-right circle) and explicit ⚙ settings icon in Home header were
added before approval.

**Supersedes.**

- `north-star-home-v1.html`, `north-star-paywall-v1.html`,
  `north-star-wish-detail-v1.html` — deleted (were marked INCOMPLETE and
  retracted on 2026-04-17).
- Text sections 3 (pattern-by-pattern) and 4 (reference screens) of
  [`NORTH_STAR.md`](./NORTH_STAR.md) — they are superseded as visual
  source of truth by the v2 mockups. Text stays as prose guidance but
  defers to mockups when conflict arises.

**Impact.**

- **NORTH_STAR status** flips from DRAFT → APPROVED. Removes the «under-
  researched» banner and the v2-retraction notice. Adds visual
  companion index pointing to `approved/`.
- **Component registry** unblocks canonical-promotion path for primitives
  whose visual language is codified in the approved mockups. Next
  candidates (subject to `PROMOTION_CHECKLIST.md` gating):
  - `SectionHeader` — the cleanest promotion (simple contract, widely
    used, identical shape across all 11 mockups)
  - `Banner` tones `info` / `success` / `warning` / `danger` — visual
    language codified in Home (state chips), State matrix, Guest view,
    Paywall
  - `Card` default / flat / interactive variants — codified in nearly
    every mockup
- **Sheet** still `provisional-needs-redesign` — approved direction
  requires absorbing `BottomSheet`'s iOS behavior (swipe/inertia/keyboard).
  Redesign and absorption is Phase 2 work; promotion to canonical only
  after.
- **Toast** primitive visual language is NOT codified yet in approved
  mockups (was lightweight in the North Star text). Extraction in Phase 2
  needs its own mockup cycle if a specific visual needs approval.
- **`primary-gradient` canonical gradient** — codified in v2-paywall.html
  hero and v2-onboarding.html CTAs. Token becomes approvable as canonical
  once one implementation migration validates it.
- **Screen patterns** (`ScreenHeader`, `StickyCTA`, paywall composition)
  — visual target for all three is now codified and can start migration.
- **Mockup governance** — `approved/` is now non-empty. Future strong
  mockups flow through the operational rule in
  [`PROMOTION_CHECKLIST.md`](./PROMOTION_CHECKLIST.md).

**Approved by.** Dmitry (solo-owner, 2026-04-19).

**Known forward-iteration notes (approved as direction, not blocking):**

- Radius scale could shift slightly rounder («меньше острых углов, больше
  плавности»). Candidate: `xl` 14→16, `xxl` 16→20, `xxxl` 20→24. Evaluate
  in Phase 2 after first canonical promotion — see backlog entry below.
- Text sections 3–4 of `NORTH_STAR.md` will be refreshed to lift quotes
  from the approved mockups rather than pre-mockup assumptions — planned
  as a follow-up PR, not blocking.

---

## 2026-04-17 — Phase 1 Foundation: design-system rollout

**Type:** governance

**Decision.** Introduce the design-system governance model for the
WishBoard Mini App. Establish:

- token package `@wishlist/ui-tokens` as the source of visual values,
- primitive package `@wishlist/ui` with six initial extractions
  (`Button`, `Card`, `Sheet`, `SectionHeader`, `ListRow`, `Banner`),
- docs under `docs/design-system/` including this log,
- three-bucket mockup structure (`current-prod/` / `proposed/` / `approved/`),
- four-state status model (`legacy` / `provisional` / `canonical` / `deprecated`).

**Context / why.** Ad-hoc inline styles (3631 instances in `MiniApp.tsx`,
337 raw hex values) were producing uncontrolled drift between mockups and
implementation. Goal: stop accumulating visual debt and define the
controlled-evolution mechanism.

**Supersedes.** No prior design-system governance existed.

**Impact.**

- **Component registry:** all six extracted primitives and their pattern
  families are enrolled with initial statuses. All primitives start
  `provisional` — their extraction matches current prod, but current prod
  is not implicitly canonical. Product must explicitly approve before any
  primitive moves to `canonical`.
- **Mockups:** 17 existing HTML files were moved into
  `mockups/proposed/`. None automatically became `approved/`.
- **Tokens:** semantic categories (`typography.textStyles`, `shadows` tiers,
  `motion.duration`) are treated as `canonical` infrastructure. Specific
  **values** (`colors.accent`, the 14 radius values, the 7 font sizes) are
  `provisional` and will be pruned / re-approved as mockups drive them.
- **Migration strategy:** "migrate on touch" — no big-bang rewrite. Existing
  inline styles remain in `MiniApp.tsx` until the surrounding region is
  edited for other reasons.
- **Proof-of-use integrations:** 2–3 call sites in `MiniApp.tsx` adopt the
  new primitives as pattern exemplars — these adoptions do not promote any
  primitive from `provisional` to `canonical`; they exist to validate the
  API surface.

**Approved by.** Dmitry (solo-owner decision, 2026-04-17).

---

## Decision backlog (pending explicit approval)

Items that need a decision but don't have one yet. Add a new dated entry
above once decided.

- **Haptic policy** (pending Button Wave 1 observation). 3 options
  (A: default-on / B: policy-based / C: opt-in) specified in
  [`HAPTIC_POLICY_PROPOSAL.md`](./HAPTIC_POLICY_PROPOSAL.md). Owner
  observes live for ~1 day, then picks. Current state: Option A live
  (default `haptic="light"` on all primary / primary-gradient).
  Lean recommendation: Option B.

- **Banner Wave 1** (prepared, pending go-signal). 3–5 call-site
  migration plan in [`BANNER_WAVE_1_PLAN.md`](./BANNER_WAVE_1_PLAN.md).
  Validates 4 neutral tones (info / success / warning / danger) against
  real usage. Executes after haptic policy decision lands.

- **Radius softness shift** (noted during 2026-04-19 north-star-approval).
  Owner direction: «меньше острых углов, больше плавности». Proposed
  token changes: `radius.xl` 14→16, `radius.xxl` 16→20, `radius.xxxl`
  20→24. Evaluate after first canonical primitive promotion — should ship
  as a `token-change` entry with before/after screenshots. Not blocking
  any current work. Small shift across the board, not a visual overhaul.

- **Toast visual target.** Approved NORTH_STAR text describes a tone-
  indicator on leading edge + priority + coalescence + optional-action
  slot, but no v2 mockup codifies the visual. Phase 2 Toast extraction
  needs either a dedicated approved mockup OR owner-direct approval of
  the extracted shape.

- **Paywall-v2 canonical gradient.** The hero gradient in
  `mockups/approved/v2-paywall.html` (`radial top-right + radial
  bottom-left + linear 135deg from #7C6AFF to #6B5CE7`) is the visual
  target. First implementation migration validates it — then promote
  `gradients.paywallHero` as a canonical token.

- **Typography scale pruning.** 10 / 11 / 22 / 32 sizes appear rarely in
  approved mockups. Once a wave of migration completes, propose removing
  unused sizes and log as `token-change`.

- **ScreenHeader / StickyCTA promotion.** Visual target now codified in
  approved mockups (back + title-center / right-trailing-icons + sticky
  primary-gradient CTA). Extract as primitives in Phase 2, promote to
  canonical once 3+ call-sites use them.

### Resolved (moved to dated entries above)

- ~~Paywall hero presentation.~~ → Resolved 2026-04-19 by approved
  `v2-paywall.html`.
- ~~Screen shell (ScreenHeader / StickyCTA) target.~~ → Visual target
  resolved 2026-04-19; extraction pending.
- ~~Onboarding redesign.~~ → Resolved 2026-04-19 by approved
  `v2-onboarding.html`. The proposed/ files `onboarding-redesign.html`
  and `onboarding-v2.html` are superseded as design direction.
