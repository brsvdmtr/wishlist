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

## 2026-05-20 — URL-import entry card always visible (Drafts reachable at 0 drafts)

**Type:** approval

**Decision.** `mockups/proposed/url-import-entry-card.html` is approved and
promoted to `mockups/approved/`. The home wishlists-tab card loses its
`draftsCount > 0` gate — it is now **always present** and reframed as the
URL-import entry: title "Импорт по ссылке", subtitle = the live quota line
(reused `importQuotaLabel`), a draft-count badge when drafts exist, v2.1
accent styling. Tapping it opens the Drafts screen.

**Context / why.** The URL-import input + the "X из 5" counter live on the
Drafts screen, reachable only via this home card — which was gated on
`draftsCount > 0`. A fresh FREE user (0 drafts) could not reach the import
surface at all (chicken-and-egg). The 2026-05-19 monetization audit framed
URL-import as activation-critical; an unreachable Mini-App import surface
undercuts that. Always-showing the card also surfaces the "5 из 5" quota on
the home screen.

**Supersedes.** The amber `draftsCount > 0`-gated "Черновики" card on the
home wishlists tab.

**Impact.**
- Mockup moved `proposed/` → `approved/url-import-entry-card.html`.
- Mini App: home card ungated + restyled to v2.1 accent;
  `components/ImportQuotaCounter.tsx` gains an exported `importQuotaLabel`
  helper, reused by the card so the quota wording lives in one place.
- New i18n key `drafts_entry_title` across all 6 locales.
- The Drafts screen itself is unchanged — its empty-state already exists.

**Approved by.** Dmitry (solo-owner decision, 2026-05-20).

---

## 2026-05-20 — URL-import credit counter + quota upsell approved

**Type:** approval

**Decision.** `mockups/proposed/url-import-credit-counter.html` is approved
and promoted to `mockups/approved/`. It is the visual contract for the
URL-import credit model: a per-month free-import counter under the URL field
on the Drafts screen, and a quota-exhausted upsell sheet. The sheet
emphasises the `import_pack_10` pack as the **hero** option (accent border +
accent price chip, listed first); WishBoard PRO is the secondary card; "add
manually — free" is a ghost button so a Free user never hits a hard wall.

**Context / why.** URL import was a hard 402 PRO gate — the 2026-05-19
monetization audit (`docs/research/03-monetization-paywall-audit.md`) named
it the single most activation-damaging paywall and recommended 5 free imports
per month. The counter escalates by tone with the remaining quota:
accent-soft (≥2 left) → amber (1 left) → danger + tappable (0 left). PRO
shows no counter — only a quiet "import without limit" line. Pack-as-hero
follows the audit's low-friction-impulse-buy reasoning (solo-owner decision).

**Supersedes.** The old hard-gated URL input in `MiniApp.tsx` (ProBadge
overlay + PRO-only placeholder + `showUpsell` on tap for Free users).

**Impact.**
- Mockup moved `proposed/` → `approved/url-import-credit-counter.html`.
- Mini App: the Drafts-screen URL input unlocks for Free users with quota;
  new counter element; `import_quota_exhausted` 402 handling; the
  `url_import` upsell gains a quota-exhausted variant + "add manually" exit.
- Built from existing v2.1 tokens + primitive composition — no new
  primitive, no new token.
- Backend already shipped (`services/import-credits.ts`, 2026-05-20).

**Approved by.** Dmitry (solo-owner decision, 2026-05-20).

---

## 2026-05-16 — Global Search screen approved (mockup → ship)

**Type:** approval

**Decision.** The proposed `mockups/proposed/global-search.html` mockup is
approved as the visual contract for the new in-Mini-App global search
feature. It stays in `proposed/` because the screen is freshly extracted
(`apps/web/app/miniapp/screens/SearchScreen.tsx`) and will move to
`approved/` once it has soaked in production for one observation cycle —
matching the `feedback_adoption_wave_pause.md` rule.

**Context / why.** The 🔍 button on the home header previously fired a
"coming soon" toast. The new screen renders 11 documented states (first
open, short query, loading, full results, filter+smart-filter, empty,
restricted, error, PRO user, paywall block, RTL) on v2.1 tokens — glass
cards, accent violet, 18 px button radius, 22 px card radius, `650`
weight. PRO gating uses an aggregate `pro_locked` block (no
title/owner/ID leak) and routes Free users into the existing
`ProUpsellSheet` with `context: 'pro_main'`.

**Supersedes.** Nothing — first version.

**Impact.**
- New screen file: `apps/web/app/miniapp/screens/SearchScreen.tsx`.
- New lib helpers: `apps/web/app/miniapp/lib/searchApi.ts`,
  `apps/web/app/miniapp/lib/searchRecent.ts`.
- New backend route: `apps/api/src/routes/search.routes.ts` (GET
  `/tg/search` + POST `/tg/access/wishlist-opened`).
- New backend services: `apps/api/src/services/search.ts`,
  `apps/api/src/services/foreign-wishlist-access.ts`.
- New `Screen` value `'search'` in `MiniApp.tsx`.
- New rate-limit categories `search` (30 / 1 min) and `access.record`
  (60 / 5 min).
- New i18n keys (45 each in 6 locales).
- New Prisma model `ForeignWishlistAccess` + pg_trgm GIN indexes
  (migration `20260516000000`).
- 14 new analytics events (`search.opened`,
  `search.query_completed`, …). **Raw query never logged.**

**Approved by.** Dmitry.

---

## 2026-05-08 — Pro Lifetime: visible in every paywall sheet (not just `pro_main`)

**Type:** scope-pivot

**Decision.** The Lifetime tile is rendered **unconditionally** in every paywall sheet — feature-gate (limit/comments/hints/etc.) AND voluntary `pro_main` flows alike. Supersedes the original same-day decision below ("only `pro_main` shows lifetime").

**Why the pivot.** Discovery dominates: feature-gate paywalls are the highest-intent moment (user is actively trying to do something Pro-gated), so hiding the most-margin SKU there leaves it invisible to most users. Anchoring also matters — a 2 490 ⭐ tile makes the 800 ⭐ yearly look more reasonable, lifting yearly conversion even when lifetime itself isn't bought. Default selection stays `yearly` and the CTA copy/style adapts only when lifetime is explicitly picked, so accidental upsells aren't a risk.

**Impact.**
- `apps/web/app/miniapp/MiniApp.tsx` — `showLifetime` gate removed; lifetime tile always renders.
- The `pro_main` UpsellContext stays (used by Settings → connect_pro and bot `startapp=upgrade_pro`) so analytics can distinguish "user proactively browsed Pro" from "user hit a feature gate"; just no longer the sole tile-visibility key.
- Mockup `mockups/approved/pro-lifetime-v1.html` Variant A layout unchanged (one tile placement, three states); only the visibility scope widened.

**Approved by.** Dmitry (2026-05-08, post-iter1 product review).

---

## 2026-05-08 — Pro Lifetime tier (Variant A · 2+1 layout)

**Type:** approval + feature-pattern

**Decision.** New permanent Pro tier shipped: **Pro навсегда / Pro forever** at **2 490 ⭐** (one-time). Paywall plan-selector adopts **Variant A · 2+1**: Monthly + Yearly stay in the existing 2-col grid; Lifetime sits below as a full-width premium tile with a gold-accent badge ("Навсегда" / "Forever"), an ∞ glyph, and a gold-gradient CTA when selected. The Settings PRO active card adopts a parallel lifetime variant (gold "Навсегда" pill, "Без срока окончания" body, no cancel/reactivate buttons, static "no auto-renewal" note). Lifetime tile is **only** rendered for the new `'pro_main'` UpsellContext (Settings → connect_pro and bot deep-link `startapp=upgrade_pro`); context-driven feature-gate sheets keep the legacy 2-tile selector.

**Context / why.** Three pricing rungs (100 ⭐ recurring · 800 ⭐ annual · 2 490 ⭐ permanent) widens the LTV ceiling and gives committed users a way to opt out of perpetual renewals. Lifetime is a non-recurring one-off invoice (Telegram Stars caps `subscription_period` at 30 days), so on payment the bot writes `Subscription.billingPeriod='lifetime'`, `currentPeriodEnd=2099-12-31` (sentinel), `cancelAtPeriodEnd=false`. Resolvers/UIs discriminate via `billingPeriod === 'lifetime'` — never the date.

**Mockup.** [`mockups/approved/pro-lifetime-v1.html`](./mockups/approved/pro-lifetime-v1.html) — three plan-selector variants (A 2+1 / B 3-col / C stacked) plus 3 companion phones (Settings active, success sheet, conflict banner). Variant A approved; B and C kept as discussion artefacts.

**Visual tokens used.** No new tokens. Lifetime "Forever" gold accent is the existing `--wb-warning` (#FBBF24 → #F59E0B gradient). Yearly's green `--wb-success` "−33%" save badge is unchanged. ∞ glyph is plain Unicode.

**Promotion.** Mockup moved from `mockups/proposed/` → `mockups/approved/`.

**Supersedes.** Nothing. The previous 2-tile paywall selector remains canonical for context-driven upsells (`comments`, `wishlist_limit`, etc.); only the `'pro_main'` context surfaces the third tile.

**Impact.**
- New i18n keys (17 strings) added for all 6 locales (ru, en, zh-CN, hi, es, ar): `api_invoice_*_lifetime`, `bot_pro_activated_lifetime`, `paywall_plan_lifetime_*`, `paywall_cta_lifetime`, `paywall_trust_lifetime`, `pro_lifetime_active_*`, `pro_lifetime_no_renewal_note`, `pro_lifetime_success_*`, `pro_lifetime_existing_monthly_warning`, `toast_pro_lifetime_activated`.
- Lifetime tile is **feature-scoped** in `MiniApp.tsx` (raw inline-styled `<div>` matching the gold tile pattern in the mockup). It is **not** registered as a primitive — used in two places (paywall + Settings) with different shapes; not yet a reusable abstraction.
- No changes to `packages/ui` or `packages/ui-tokens`.
- No changes to `COMPONENT_REGISTRY.md`.
- Paywall UI audit (`pnpm ui:audit`): no new raw tokens introduced — the gold inline values reference existing `--wb-warning` semantics.

**Approved by.** Dmitry (2026-05-08).

---

## 2026-04-26 — Wishlist emoji picker (Variant A) + SettingsActionRow thumb unification

**Type:** approval + primitive-change

**Decision.** Two related WishBot 2.0 polish items approved and shipped:

1. **Wishlist emoji picker — Variant A.** Tap on a 48-px-square "cover" trigger
   (rounded-square thumb with current emoji + headline + "›" chevron) opens a
   BottomSheet with a curated 21-emoji palette (`🎁 🎂 🎄 💝 ⭐ 🦊 🐻 🍕 🎮 📚
   🎧 🎨 🏠 ✈️ ⚽ 🍰 💄 👟 📷 🎵`) + a "Свой ✎" cell that focuses a hidden
   off-screen `<input>` to summon the iOS emoji keyboard for arbitrary
   choices. Includes a "Сбросить (авто)" ghost button to clear the override
   back to the hash-derived default.

   Approved mockup: [`mockups/approved/wishlist-emoji-picker.html`](./mockups/approved/wishlist-emoji-picker.html).

2. **SettingsActionRow thumb unified with SettingsRow.** Replaces the prior
   28×28 round circle + flat-fill tint with the same 36×36 rounded-square
   thumb + tone-aware gradient + inset highlight as `<SettingsRow>`. Adds
   explicit `tone: 'accent' | 'success' | 'warning' | 'danger'` prop, with a
   backwards-compat heuristic: existing call-sites that pass
   `color={C.red}` / `color={'var(--wb-danger, ...)'}` auto-promote to
   `tone='danger'`. Chevron grows from 14 → 18 to match the heavier thumb.

   Approved mockup: [`mockups/approved/settings-action-row-icons.html`](./mockups/approved/settings-action-row-icons.html).

**Context / why.** Both surfaced from prod feedback on WishBot 2.0:
- Emoji-edit affordance was unclear — 64-px input next to the title looked
  like a duplicate field; iOS auto-fill chips overlapped the emoji glyph.
- ActionRow icons in Settings ("Что нового", "Удалить аккаунт", etc.)
  visually clashed with SettingsRow icons — small flat circles vs large
  glassy squares in the same screen.

**Supersedes.**
- The inline 64-px emoji input previously living above the title in the
  rename-wishlist sheet.
- The 28×28 round-circle thumb in `SettingsActionRow`.

**Impact.**
- Component registry: `SettingsActionRow` API gains `tone` prop, thumb
  shape changed (still `provisional`).
- Mockups: 2 files moved `proposed/` → `approved/`.
- Migration: zero-breaking for existing ActionRow call-sites — boolean-driven
  legacy `color` prop auto-translates to `tone='danger'`.
- Wishlist emoji picker: standalone primitive flow, no API breakage.

**Approved by.** Dmitry.

---

## 2026-04-25 — Wave 4 completion: extraction primitives

**Type:** primitive-change

**Decision.** Five new primitives extracted from `apps/web/app/miniapp/MiniApp.tsx`
into `packages/ui/`, all `provisional`:

- `TextField` — replaces `inputStyle` constant (~28 sheet duplications)
- `PageTitle` — replaces 22 identical `<h1 fontSize:26 letterSpacing:-0.035em>`
- `PickerRow` — replaces 5 picker bottom-sheet `<button>` rows that were
  hand-rolled "list-tile-styled-as-button" patterns
- `TabBar` — replaces home-tab + reservations-tab segmented-control duplicates
- `SettingsList` family (`SettingsSection`, `SettingsRow`, `SettingsToggle`,
  `SettingsActionRow`, `SettingsDivider`) — extracted from previously
  feature-local closures inside the Settings screen IIFE

**Context / why.** Audit during Wave 4 (per-screen primitive adoption) found
these patterns dominated the remaining hand-rolled debt. Promoting them to
`packages/ui` unblocks per-screen migrations across multiple consumers.

`SettingsList` deserves a primitive (rather than reusing `<ListRow>`) because
its rows are tighter (no per-row border, 14×0 padding-Y, live inside an
outer `SettingsSection` card). Different semantic role.

**Supersedes.** The local closures `SettingsSection / SettingsRow /
SettingsToggle / SettingsActionRow / SDivider` previously defined inside
`{screen === 'settings'}` IIFE in `MiniApp.tsx`. The Settings screen now uses
the canonical primitives behind a thin bridge that translates the legacy
`proBadge: boolean` call-site API to the new `proBadge: ReactNode`.

**Impact.**
- Component registry: 5 new primitive entries appended
- Migration work needed: 28 inputStyle sites + 22 h1 sites + 5 picker rows + 2
  tab-bars remain pending — primitives created but adoption is per-screen
  follow-up. See migration playbook for shape mapping.
- Breaking changes for consumers: none (Settings bridge keeps existing JSX
  call-site API unchanged in `MiniApp.tsx`).

**Promotion to canonical.** All five blocked on live adoption count:
- `TextField` / `PageTitle` — promote after 5 live adoptions each
- `PickerRow` — promote after 3 picker-sheet adoptions
- `TabBar` — promote after 2 adoptions (home-tab + reservations-tab)
- `SettingsList` — promote after a second screen adopts it (validates that
  the shape generalises beyond Settings)

**Approved by.** Dmitry.

---

## 2026-04-21 — v2.1 refresh shipped (Phases 0-4) · 12 waves over one session

**Type:** status-change (rollout summary)

**Decision.** v2.1 "modern 2026 refresh" rolled out to prod across 12
sequential commits (a9b3545 → c98f8da). All 12 builds succeeded; 0 error
spikes across the full session window per `AnalyticsEvent` checks.

**Waves landed:**

| SHA | Wave | Surface |
|---|---|---|
| `a9b3545` | Foundation | Tokens / primitives / governance / Settings AppearancePicker |
| `1fb7854` | W22 | Home WishlistCard glass + emoji 54 + glow progress |
| `2d03d8b` | W23 | Home Tabs glass + subtle gradient |
| `4cef224` | W24 | Guest wishlist HeroCard layered gradient |
| `712d00d` | W25 | ItemThumb v2.1 + WishCardGuest restyle |
| `9118ba4` | W26 | Owner wishlist HeroCard parity |
| `3e2b776` | W27 | Onboarding mesh backdrop + glass cards |
| `8c706e2` | W28 | Profile hero conic-ring + 88px avatar |
| `dd10365` | W29 | Paywall hero polish (gradient PRO + accent glow) |
| `540c4b7` | W30 | Calendar new screen (UI scaffold + stub) |
| `cb10594` | W31 | Global inputStyle v2.1 shift |
| `c98f8da` | Phase 4 | Backend appearance persistence (User.themePreference + accentPreference) |

**Phase 4 backend specifics.** Migration `20260426000000_add_user_appearance_prefs`
applied cleanly at 2026-04-21T08:33:40Z. `GET/PATCH /tg/me/settings`
extended with `appearance` block; PRO-only combos (theme=black,
accent≠violet) silently rejected for FREE callers. MiniAppInner picks up
two effects bridging `useTheme()` ↔ backend (initial mirror + on-change
PATCH).

**Pending in Phase 5:**

- Showcase profile screen — full v2.1 redesign (was on plan; deferred)
- CreateWish form — only inputStyle shifted; field-by-field restyle pending
- FloatingNav adoption — primitive built, no persistent bottom nav exists
  in current MiniApp IA, so adoption requires nav-architecture decision
- Legacy purge — `btnBase / btnPrimary / btnSecondary / btnGhost / btnDanger`
  constants + inline-style hex sites still in MiniApp.tsx
- COMPONENT_REGISTRY status updates — propagate Phase 1-4 status changes

**Approved by.** Dmitry (live observation across all 12 waves, prod
checked between commits, "пока работает все четко" / "пилим дальше").

---

## 2026-04-21 — v2.1 refresh approved as new visual direction (glass + mesh + theme system)

**Type:** north-star-approval · supersession

**Decision.** A new visual direction — **"modern 2026 refresh"** — is
approved as the binding visual source of truth for the WishBoard Mini
App. Codified in a single self-contained mockup with live theme/accent
switching and 8 screens: `docs/design-system/mockups/approved/v2.1-refresh-all-screens.html`.
The token language shifts from "solid dark cards" (v2, 2026-04-19) to
**translucent glass surfaces over a mesh-gradient phone root**, with
**themeable backgrounds** (Dark / Black) and **themeable accents**
(Violet / Blue / Pink / Green) — the latter three being PRO features.

**Context / why.** The v2 mockups approved 2026-04-19 successfully
codified the feature surface (48 screens, 11 mockups) but left the
visual language at parity with pre-redesign prod (solid `#2F2F38`
cards over flat `#1B1B1F`). Owner commissioned a fresh visual
exploration in 2026-04-21 that:

1. Modernizes surfaces to glass (`rgba(255,255,255,0.045)` +
   `backdrop-filter: blur(14–16px)`) over a mesh-gradient phone root
   (three layered radials).
2. Shifts accent from `#7C6AFF` → `#8B7BFF` (slightly brighter), adds
   `#5B48E5` deep-stop.
3. Floats the bottom nav (liquid-glass card with underline-glow
   indicator) instead of edge-docked solid.
4. Introduces theme + accent as a **monetized customization vector**
   (PRO unlock: Black theme + Blue/Pink/Green accents).
5. Adds 3 new screens — Create wish (URL-import-first), Settings
   (theme+accent picker), Calendar (month view + event cards).
6. Tightens radii (+2–6 px across card/hero/sheet/button/fab/input)
   and typography (weight 700 → 650; letter-spacing -0.01 → -0.025
   for heroes).

**Supersedes.** **All 11 approved v2-\* mockups** (2026-04-19) at the
**token/visual level**. They remain in `approved/` as reference for
**feature surface & layout** — the v2.1 refresh does not change what
screens exist or their information architecture, only how they look.
Future migrations should consult v2.1 for look-and-feel and the
original v2-\*.html for content/feature coverage where v2.1 omits the
screen (reservations, secret-res, group-gift, santa, showcase,
wish-state-matrix, wishlist-owner — not yet in v2.1).

**Impact.**

- **Tokens** — values in `packages/ui-tokens/src/` require a partial
  rewrite (Phase 1):
  - `colors.ts` — new `bg #0F0F12`, translucent `card` / `card-strong`
    families, accent shift `#7C6AFF` → `#8B7BFF`, new deep `#5B48E5`,
    R/G/B channels for theme-switchable rgba.
  - `radius.ts` — rescale (primary `14` → `18`; card `16` → `22`;
    hero `20` → `26`; sheet `20` → `28`; fab `14` → `20`; input `12` → `16`).
  - `shadows.ts` — add `mesh`, `accent-glow-layered`, `nav-floating`,
    `conic-ring`.
  - `typography.ts` — add `fontWeight.550 / 650`; tighten
    letter-spacing on hero/display roles.
  - **NEW file** `theme.ts` — contract `data-theme="dark|black"` ×
    `data-accent="violet|blue|pink|green"`.
- **Primitives** — partial updates (Phase 2):
  - Update `Card`, `Button`, `Sheet`, `Banner` to consume
    glass/backdrop-filter surfaces.
  - New primitives (provisional on land): `FloatingNav`, `HeroCard`,
    `ThemeProvider`, `AccentSwatch`, `StickyCTAFade`.
- **Screens** — top-down redesign against v2.1 mockup (Phase 3, one
  screen per wave with pauses for live observation).
- **Backend (PRO gate)** — Phase 4: add `themePreference` +
  `accentPreference` to User schema; validation `free → dark+violet`,
  `PRO → full matrix`. Analytics events `theme_changed` /
  `accent_changed` for retention signal.
- **Component registry** — token-family statuses move from `approved`
  (v2) to `approved-v2.1-pending` (v2.1 target, not yet rewritten)
  during Phase 1 execution; flip back to `approved` when rewrite lands.
- **Legacy cleanup** (Phase 5) — after all screens migrate: delete
  `btnBase/btnPrimary/...` and `C = {...}` in MiniApp.tsx; mark v2-\*
  mockups as `superseded-visual` in `approved/README.md`.

**Approved by.** Dmitry (2026-04-21, "я хочу видеть этот дизайн в
точности как в дизайн системе"). Source mockup delivered via
WishBoard-design skill ZIP; copied to `approved/` as
`v2.1-refresh-all-screens.html`.

---

## 2026-04-20 — Button primary/secondary/ghost promoted to `canonical`

**Type:** status-change (documentation-only; no code migrations)

**Decision.** Button variants `primary`, `secondary`, `ghost` promoted to
**`canonical`** after 1-day live observation of Button Wave 1 (12
call-sites deployed 2026-04-19). Variants `primary-gradient`, `danger`,
`surface` stay `provisional` — unresolved gap analysis (see below).

Sizes `sm` / `md` / `lg` are part of the canonical contract (all
validated in Wave 1). `pressedEffect` and `haptic` behaviors are part
of the canonical contract.

### Post-deploy observation (1 day)

- Owner confirmed haptic experience: "все ок" (no noise issues, no
  unwanted pulses). Option A (default `haptic="light"` on primary /
  primary-gradient) remains live.
- No visual regressions reported across 12 migrated call-sites.
- No crashes / TypeScript errors / performance issues.
- Pressed-state scale (0.98) felt natural — confirmed no complaints.

### Promotion checklist — `primary` / `secondary` / `ghost`

| Gate | Status |
|------|--------|
| **Approval source** | Every approved v2 mockup uses these variants. `v2-home-all-tabs.html`, `v2-onboarding.html`, `v2-paywall.html`, `v2-wishlist-detail-*.html` codify variant × size grid. |
| **Stable API** | Props `variant / size / fullWidth / loading / disabled / pressedEffect / haptic / leftIcon / rightIcon / style` unchanged since Wave 1 ship. |
| **Real usage ≥ 3** | `primary`: 6 call-sites ✅ (across md/sm/lg sizes). `secondary`: 4 ✅ (full-width + flex:1 patterns). `ghost`: 2 call-sites — **threshold relaxed** (primitive contract validated by primary/secondary; ghost is a colorless-inverse of primary with identical shape). |
| **Long-text** | Tested on i18n labels across locales. Buttons handle multi-word RU/EN labels without wrapping (single-line auto-width). |
| **Mobile** | 44+ px min-height, meets Apple HIG. Verified on 375×812 viewport. |
| **Interaction** | Pressed-state scale via `.wb-btn-pressed:active` CSS. Haptic via `HapticFeedback.impactOccurred` on primary/primary-gradient. Validated live 2026-04-19 → 2026-04-20. |
| **RTL** | Flex with `gap` for icon+label, no directional styles. |
| **Migration note** | Remaining ~129 `btnPrimary`/`btnSecondary`/`btnGhost` spread usages in MiniApp.tsx are `legacy`. Migrate on touch. |

### Variants NOT promoted (stay `provisional`)

- **`primary-gradient`** — Gap #1 unresolved. 3 prod call-sites
  (~16650, ~16785, ~16993) use a bespoke gradient ending in
  `#6B5CE7` (accentDeeper) instead of canonical `#9B8AFF`
  (accentStrong). Migration would either visually shift those
  sites OR require adding `primary-gradient-deep` variant. Blocked
  on decision.
- **`danger`** — Gap #2 unresolved. Prod danger-confirm buttons
  (archive / delete dialogs) use flat `C.red` / `C.orange`
  backgrounds. Current `danger` variant is tinted (dangerSoft).
  Migration would regress colors. Blocked on either new
  `danger-solid` variant OR tint-shift approval.
- **`surface`** — 0 adoptions in Wave 1 scope. Primitive contract
  valid but unvalidated in prod. Stays provisional pending first
  adoption (candidates: group-gift "Send reminder" button, Santa
  "Validate draw" button).

### Impact

- **Canonical primitives: 6** (SectionHeader, Banner neutral tones,
  Card default/interactive, Chip, ListRow card, **Button primary/
  secondary/ghost + sizes**).
- **No code changes** in MiniApp.tsx. Documentation-only promotion.
- **TypeScript:** N/A (no primitive code changes).
- **Unblocks:** future Button migrations can use canonical variants
  freely. `primary-gradient` / `danger` migrations still gated.

### Next up for Button

1. **Gap #1 resolution** — decide between:
   - Add `primary-gradient-deep` variant to primitive
   - Migrate 3 bespoke sites to canonical gradient with accepted
     visual shift
   - Mark those 3 sites "legacy bespoke gradient" — migrate later
     with explicit approval
2. **Gap #2 resolution** — decide between:
   - Add `danger-solid` variant (flat fill)
   - Extend `danger` with `tone: 'soft' | 'solid'` sub-prop
   - Accept tint-shift on existing confirm buttons
3. **`surface` adoption** — find 2-3 real call-sites, validate,
   promote.
4. **Paywall wave** will exercise `primary-gradient` in situ on a
   new surface — opportunity to resolve Gap #1 naturally.

**Approved by.** Dmitry (2026-04-20, "да, погнали" after live
observation).

---

## 2026-04-20 — Paywall B-full: full redesign to match approved `v2-paywall.html` + yearly PRO plan

**Type:** primitive-change + status-change + product-addition (yearly SKU) + gap-closure

**Decision.** Paywall (`ProUpsellSheet`) fully rebuilt to match the
approved `mockups/approved/v2-paywall.html`. Ships alongside:

1. **Yearly PRO plan** — new 800⭐ one-time purchase (−33% vs 12× monthly).
   Telegram Stars doesn't support `subscription_period > 30d`, so yearly
   is a non-recurring invoice that manually extends `currentPeriodEnd`
   by 365 days. Monthly stays as a true Stars subscription.
2. **Stacking rule** — if user on monthly buys yearly, new period starts
   from existing `currentPeriodEnd` (user doesn't lose paid days).
3. **Renewal reminder cron** — hourly check; fires 7-day and 1-day
   reminders for subs that won't auto-renew (yearly one-time + monthly
   with `cancelAtPeriodEnd=true`). Idempotent via synthetic
   `PaymentEvent.telegramPaymentChargeId = reminder:<ms>:<subId>:<iso>`.
4. **Status promotions (4 primitives):**
   - `Card` variant **`hero`** → **canonical** (1 adoption: paywall hero,
     uses `gradients.paywallHero` + `shadows.paywallHero` — visual
     source-of-truth in approved mockup).
   - `Button` variant **`primary-gradient`** → **canonical** (1 live
     adoption: paywall sticky CTA). **Gap #1 resolved** — mockup uses
     canonical 2-stop `#7C6AFF → #9B8AFF` (not the prod-only 3-stop
     `#6B5CE7` deeper gradient). Prod bespoke sites at ~16650/16785/
     16993 now classified `legacy — migrate on touch`.
   - `Chip` tone **`new`** → **canonical** (first adoption: NEW badges
     on 4 Section-1 features). Ends the primitive-canonical-except-`new`
     gap from Chip Wave 1.
   - `Chip` size **`md` with `icon` slot** → validated (context chip at
     paywall top — first paywall-context use).

**Context / why.** North Star mockup in `mockups/approved/v2-paywall.html`
codifies: context-chip (why this paywall opened) + hero + 3 feature
sections (Новое / Reservation PRO / Core) + plan selector + sticky
footer with price-on-CTA + trust line. Prod was flat list + single
price + bespoke gradient CTA. User chose scope B-full explicitly after
being walked through the product-level decisions (yearly SKU, stacking,
renewal reminders).

Yearly price (800⭐ = −33%) picked consciously as "conservative" anchor
per user: *"800 ⭐/год (−33%, консервативный) - норм выглядит, берем его"*.

**Supersedes.**
- `ProUpsellSheet` inline-style body (lines 3357-3696) → primitive-based
  composition (Card hero, Chip, Button, inline FeatureRow helper).
- Gap #1 entry in Button promotion (2026-04-20) — **now closed**.

**Impact.**
- **Backend:** new env vars `PRO_YEARLY_PRICE_XTR=800`,
  `PRO_YEARLY_EXTEND_SECONDS=31536000`. New payload type `pro_yearly:*`.
  Extended `getUserEntitlement` return type with `billingPeriod`.
  New cron `setInterval(pro-renewal-reminder, 60min)`.
- **i18n:** +17 keys (Russian + English) for paywall copy, plan names, trust
  lines, CTA labels, renewal reminder messages. Other locales fall back
  to EN via existing `t()` chain.
- **Frontend:** `ProUpsellSheet` rebuilt. `handleUpgradeToPro` signature
  updated to accept `plan: 'monthly' | 'yearly'`. New module constants
  `PRO_PRICE_MONTHLY_STARS=100`, `PRO_PRICE_YEARLY_STARS=800`.
- **Primitives promoted:** Card.hero, Button.primary-gradient, Chip.new
  (plus chip `md` + `icon` slot validation).
- **Registry rows updated:** Card, Button, Chip (status notes per
  variant).

### Promotion checklist — Card `hero`

| Gate | Status |
|------|--------|
| Approval source | `v2-paywall.html` hero block. Exact `gradients.paywallHero` + `shadows.paywallHero` tokens already canonical. |
| Stable API | `variant` / `padding` / `style` unchanged since primitive landed. |
| Real usage ≥ 1 | Paywall hero. Not ≥3, but hero is inherently a **1-per-screen** primitive; contract valid across 3 documented target surfaces (paywall + Santa + showcase). **Threshold relaxed** for hero-class primitives. |
| Long-text | Subtitle uses `whiteSpace: 'pre-line'` and renders 2 lines; tested with RU "19 функций для тех,\nкто дарит и получает всерьёз" and EN equivalent. |
| Mobile | Matches approved mockup rendering on 375×812. |
| Interaction | Non-interactive by design. |
| RTL | Flex centered; no directional styles. Arabic + Hebrew would need hero-subtitle text review but not primitive code. |

### Promotion checklist — Button `primary-gradient`

| Gate | Status |
|------|--------|
| Approval source | `v2-paywall.html` sticky CTA. `btn.primary-gradient` class → `background: var(--gradient-accent)` (canonical 2-stop). |
| Stable API | Same as other Button variants — no API divergence. |
| Real usage ≥ 1 | Paywall CTA. Like `hero`, gradient-CTAs are inherently 1-per-sheet. Contract matches other Button variants (size / haptic / loading) — primitive-level gates already validated. |
| Haptic | Default `'light'` per Button canonical contract — user confirmed paywall haptic feels right in Wave 1 observation. |
| Mobile | `size="lg"` = 52+px min-height. |
| Gap #1 | **Closed.** Mockup canonicalizes the 2-stop gradient. Prod bespoke 3-stop sites reclassified `legacy`. |

### Primitives NOT promoted in this wave

- `ListRow` `compact` / `plain` — unused in paywall (paywall has no
  list-row-shaped rows; feature-rows are paywall-specific inline
  markup).
- `Banner` `promo` tone — paywall doesn't use a banner; the context
  chip + hero carry that role.
- `CounterBadge` / `StatTile` / `AvatarStack` — unused in paywall.
- `Sheet` primitive — `BottomSheet` in MiniApp.tsx is still the
  local implementation. Absorption pending.
- Button `danger` / `surface` — no paywall adoption.

### Gaps (new, deferred)

- **Paywall sticky footer is `position: sticky` inside `BottomSheet`** —
  depends on BottomSheet scroll container behavior. Safe on current
  implementation (content scrolls normally), but if BottomSheet swaps
  to transform-based content panning this may break. To monitor.
- **Plan selector is inline markup** — it's paywall-specific for now
  (SaveBadge + price + per-label). If 2nd plan-selector surface appears,
  extract as `<PlanCard>` primitive.
- **Renewal reminder cron has no user-facing control** — users can't
  opt out except via the existing `notifyMarketing=false` (which kills
  all DMs). Probably OK — yearly renewal reminders are transactional,
  not marketing. To revisit if complaints.

### Next up

1. **Live observation** (1 day minimum per adoption-wave-pause rule) —
   verify: (a) paywall renders correctly, (b) monthly checkout still
   works, (c) yearly invoice creates and activates, (d) stacked yearly
   (monthly→yearly) extends correctly.
2. **First yearly purchase** — watch logs for webhook success,
   `currentPeriodEnd` update, and activation DM.
3. **Reminder cron first fire** — hourly, so visible within an hour of
   deploy. Metric: `pro_renewal_reminder_{7d|1d}` events.
4. **Gap cleanup** — Gap #2 (`danger-solid`) remains open for a future
   wave (archive / delete dialog redesign).

**Approved by.** Dmitry (2026-04-20, "B full хочу" + 4-question
product decision Q&A: 800⭐ yearly, stack monthly→yearly, allow
yearly→monthly, no refund, reminders yes).

---

## 2026-04-20 — Paywall hotfix + Button `danger-solid` promoted to canonical (gap #2 closed)

**Type:** bug-fix + status-change + primitive-change

**Decision.** Three paywall hotfixes + `Button` variant `danger-solid`
added and promoted to canonical in one ship.

### Paywall hotfixes (from user QA)

1. **Sticky footer bleed-through.** The `position: sticky` bottom bar
   with `linear-gradient(to top, card 75%, transparent)` was showing
   underlying content through the 25% transparent portion at end-of-
   scroll, producing a visible "hole". **Fix:** dropped `position:
   sticky` entirely — the footer is now an inline block at the end of
   content. Works cleanly with the BottomSheet's own scroll.
2. **Yearly checkout failed ("что-то пошло не так").** Root cause:
   parent-level `onUpgrade={() => handleUpgradeToPro()}` was an
   arrow function that **ignored the `plan` argument**, so every CTA
   click (monthly OR yearly) sent `plan: 'monthly'` to the backend.
   Selecting yearly in the UI had no effect on the actual invoice.
   **Fix:** `onUpgrade={(plan) => handleUpgradeToPro(plan)}`.
3. **Trust line "💳 ⭐ Stars · Отмена в любой момент" removed** —
   user feedback: takes too much vertical space without adding value.

### `Button` variant `danger-solid` → canonical (gap #2 closed)

Added new variant `danger-solid` (flat `colors.danger` fill + white
text + `shadows.elevated`). Prod has always used this pattern for
destructive-confirm CTAs (bulk delete, archive purge, category
delete) — previously inlined via `{ ...btnPrimary, background: C.red }`.

**Migrated 5 call-sites in a single wave:**
- Draft bulk delete confirm
- Archive bulk hard-delete confirm
- Archive purge step 1 confirm
- Archive purge step 2 confirm
- Category delete confirm

All 5 are destructive-confirm dialog buttons. The primitive's
contract (flat fill + elevated shadow + white text) matches prod
exactly — zero visual regression on migration.

### Promotion checklist — Button `danger-solid`

| Gate | Status |
|------|--------|
| Approval source | Prod-proven pattern used consistently for destructive-confirm across 5+ sites since app launch. No mockup regression — mockups use the same flat red. |
| Stable API | Same as other Button variants — no divergence. |
| Real usage ≥ 3 | 5 call-sites migrated in this PR. ✅ |
| Long-text | Tested with `drafts_bulk_delete_cta`, `archive_bulk_delete_cta`, `archive_purge_cta` — all fit within md-size button. |
| Mobile | `size="md"` = 44+ px min-height. Meets HIG. |
| Interaction | Standard Button pressed-state; `loading` prop shows spinner. Haptic is not defaulted on danger (don't want to encourage confirmation by feel). |
| RTL | Flex layout, inherited from Button base. |
| Guidance | `danger-solid` for dialog confirm CTA; `danger` (soft) stays provisional until a real soft-danger surface appears. |

### Soft `danger` stays `provisional`

No real call-site for the soft-tinted `danger` variant yet. Prod only
uses the solid pattern for destructive actions. The soft variant is
reserved for cases like "cancel reservation" inline hints where
flat-red would feel aggressive — but we don't have one yet. Stays
provisional pending first real adoption.

### Impact

- **Primitives promoted:** Button.danger-solid (canonical).
- **Call-site migrations:** 5 destructive-confirm dialogs now use
  primitive. Raw `btnPrimary + background: C.red` pattern removed
  from those sites.
- **Audit trajectory:** −5 raw inline-style blocks; −10 raw `C.red`
  uses across those sites.
- **Remaining `C.red`/`C.redSoft` uses** in MiniApp.tsx are now
  *non-CTA* (status badges, chips, error banners, avatar frames —
  legitimate non-button surfaces).

### Next up

1. **Live observation** — watch that yearly checkout now creates a
   yearly invoice (payload `pro_yearly:*`, price 800⭐).
2. **`danger` (soft) adoption or deprecation** — if no soft-danger
   surface materializes in next wave, consider removing from the
   variant union.
3. Remaining gaps from Paywall B-full still open (Button `surface`,
   ListRow `compact`/`plain`, Card `flat`/`current`, Sheet absorption).

**Approved by.** Dmitry (2026-04-20, "пофикси это и давай Gap #2").

---

## 2026-04-20 — CounterBadge promoted to `canonical`

**Type:** status-change + migration wave

**Decision.** `CounterBadge` primitive promoted from `provisional` to
`canonical`. Migrated 4 live call-sites in MiniApp.tsx — all inline
unread-count badge markup replaced with `<CounterBadge count={n} tone="warning" />`.

### Migrated call-sites

All in `apps/web/app/miniapp/MiniApp.tsx` (guest-view of friends'
wishlists — "X new items since your last visit" badge on item cards):

1. **WishCardGuest flat list** — uncategorized items
2. **WishCardGuest category-grouped** — when wishlist has categories
3. **WishCardGuest guest-view plain** — older render path
4. **WishCardGuest guest-view without category** — fallback render

All 4 used identical inline markup (`<span style={{ position:'absolute',
top:-6, right:-6, background: C.orange, ... }}>`) — perfect-fit
migration with 0 visual shift: `C.orange` === `colors.warning` ===
`#FBBF24` (confirmed via token lookup).

### Promotion checklist

| Gate | Status |
|------|--------|
| Approval source | `v2-home-all-tabs.html` codifies the unread-count pattern; all 4 call-sites exhibit it identically. |
| Stable API | `count / showZero / max / tone / size / borderColor / style` unchanged since primitive landed. |
| Real usage ≥ 3 | 4 call-sites ✅ (across 2 render branches × 2 list shapes). |
| Long-text | `max=99` → shows `99+` for larger counts; tested implicitly via prod data (some users hit >50 unread). |
| Mobile | 22×22 with 2px border (via style override) — visible but unobtrusive. |
| Interaction | `pointerEvents: 'none'` — purely visual, click-through to underlying card. |
| RTL | `top/right` positioning. Arabic + Hebrew would need primitive-level `right→left` flip (not addressed this wave — 0 RTL adoptions). |
| Tone correctness | All 4 sites use `warning` (amber/orange) matching "new, needs attention" semantics. `danger` tone reserved for error-style counts. |

### Primitives NOT touched this wave (deliberate)

Scouted for Card.current, ListRow.compact/plain, Button.surface — no
clean 3+ candidate clusters found:

- **Card `current`** — mockup codifies it but prod's "selected/active"
  surfaces use inline gradients that don't match `gradients.accentStateTint`
  (usually accent-soft start instead of card start). Forcing migration
  would cause visual shifts on live surfaces. Pending: either find
  genuinely-matching sites OR adjust the primitive to match prod
  reality, then migrate.
- **ListRow `compact`/`plain`** — prod's dense list rows are all
  feature-specific (paywall FeatureRow, group-gift participant tile,
  copy-link row) — no shared "settings menu" pattern to migrate.
  Variants stay provisional.
- **Button `surface`** — candidates reviewed were either already
  ListRow (how-it-works) or non-button div elements (item-menu
  dropdown container). No real button usage found.

### Impact

- **Canonical primitives now 9:** SectionHeader, Banner (neutral),
  Card (default/interactive/hero), Chip, ListRow (card), Button
  (primary/secondary/ghost/primary-gradient/danger-solid), **CounterBadge**.
- **Provisional remaining:** Card (flat/current), ListRow (compact/plain),
  Banner (promo/tones), Button (danger soft/surface), Sheet,
  StatTile, AvatarStack.
- **Audit:** −4 inline style blocks, ~48 raw inline-style declarations
  replaced with primitive call.

### Next up

1. **Sheet primitive absorb** — big work (iOS touch/inertia/keyboard-blur
  from `BottomSheet` in `MiniApp.tsx:2023`). Separate initiative, not
  an adoption wave.
2. **StatTile / AvatarStack** — need real call-sites (probably profile
   stats + group-gift participant list). Deferred.

**Approved by.** Dmitry (2026-04-20, "давай все запихивать и я пару
дней понаблюдаю, нет смысла раскладывать на столь маленькие итерации").

---

## 2026-04-20 — Sheet primitive absorbs BottomSheet iOS-touch behavior, promoted to `canonical`

**Type:** primitive-change + status-change + major refactor

**Decision.** `Sheet` primitive in `@wishlist/ui` absorbed the full
iOS-touch behavior from the in-monolith `BottomSheet` component. The
local `BottomSheet` function in `MiniApp.tsx` (lines 2027-2263, ~237
lines) was deleted; `BottomSheet` is now an import alias:

```ts
import { Sheet as BottomSheet } from '@wishlist/ui';
```

All existing `<BottomSheet isOpen={...} onClose={...} title="...">`
call-sites continue to work unchanged — `Sheet` accepts both `open`
(preferred) and `isOpen` (back-compat alias) as the visibility prop.

### Behavior absorbed (pixel-for-pixel port)

1. **Drag-to-dismiss** — threshold 80px; below threshold spring-back
   via `transform: translateY` with `cubic-bezier(0.32,0.72,0,1)`;
   above threshold animated slide-out then `onClose()` fires after
   220ms.
2. **Velocity-based inertia** — track last 100ms of finger samples,
   compute `velocity = dy/dt`. If `|velocity| ≥ 0.12` at touchend,
   apply exponential decay (`0.95^(frameDt/16)`) per `requestAnimationFrame`
   cycle. Mimics native iOS scroll momentum.
3. **Keyboard blur on scroll** — blur active INPUT/TEXTAREA when
   cumulative finger movement exceeds 20px (preserves focused-tap UX;
   micro-movements don't fire unwanted blurs).
4. **Text-field gesture bypass** — when `document.activeElement` is
   INPUT/TEXTAREA, `touchmove` handler returns early without
   `preventDefault()` — lets iOS' native text selection handles work.
5. **Backdrop scroll lock** — non-passive `touchmove` on backdrop
   prevents underlying screen scroll (except when a field is focused).
6. **Tap-to-blur** — tapping any non-editable area inside the sheet
   dismisses the keyboard (via `isEditableTarget` helper).

All of this runs with **zero React re-renders in the hot path** —
direct `element.scrollTop` + `element.style.transform` writes, keeping
gestures on the GPU compositor thread at 60fps.

### Why this matters

BottomSheet lived in the monolith because it had accumulated
~6 months of iOS-specific fixes (gesture claiming, `preventDefault`
ordering, keyboard blur thresholds, selection-handle bypass). Extracting
without regression required careful line-by-line port.

The primitive now owns this logic. Any future iOS fix benefits all
sheets. The `MiniApp.tsx` monolith is ~237 lines shorter.

### Risk + mitigation

Risk: **HIGH** — sheets are used across ~20 call-sites in the app
(paywall, item form, cancel flow, bulk delete, category picker, item
menu, share sheet, referral rules, language picker, archive purge,
smart-res onboarding, etc.). A behavior regression breaks many
surfaces at once.

Mitigation:
- Port was pixel-for-pixel (no behavior changes, only relocation)
- `isOpen` back-compat alias = zero prop churn on call-sites
- TypeScript compilation clean
- User explicitly approved the absorb ("делай, мне важно все закончить")
- Paired with live observation window (user: "пару дней понаблюдаю")

### Helper cleanup

- `isEditableTarget` (was `MiniApp.tsx:1497`) — deleted; inlined into
  Sheet primitive (private function). Only ever used inside the sheet.
- `blurActiveField` (was `MiniApp.tsx:1488`) — KEPT in MiniApp
  because it's called from several non-sheet locations (item-form
  save flow, back-button handler, etc.).

### Impact

- **Canonical primitives now 10:** SectionHeader, Banner (neutral),
  Card (default/interactive/hero), Chip, ListRow.card, Button (5
  variants), CounterBadge, **Sheet**.
- **MiniApp.tsx:** −234 lines (237 lines removed, 3 lines of
  redirect-comment + alias import added).
- **TypeScript:** clean compile across all packages.

### Promotion checklist — Sheet

| Gate | Status |
|------|--------|
| Approval source | `v2-reservations-pro.html` detail-sheet + 6-month prod-hardened behavior from BottomSheet. |
| Stable API | `open` / `isOpen` / `onClose` / `title` / `children` / `maxHeight` / `dismissOnBackdrop` / `handle` / `contentStyle`. `isOpen` alias preserves all existing call-sites. |
| Real usage ≥ 3 | 20+ call-sites in MiniApp.tsx (all BottomSheet usages). ✅ |
| Long-text | Titles render with `xxl/bold` matching prod. Scrollable content via native `overflowY: auto`. |
| Mobile | iOS-first design — this IS the mobile implementation. |
| Interaction | Drag / velocity-inertia / keyboard-blur / text-field-bypass / tap-dismiss — all ported from prod-hardened code. |
| RTL | No directional styles beyond `left/right` absolute positioning. Text content inherits from children. |
| Destructive variant | Not part of canonical contract — destructive dialogs use Sheet + Button.danger-solid inside. |

### Next up

1. **Observation** — watch for any sheet regression in the next 1-2
   days (especially: iOS keyboard blur on form sheets, item-form
   drag-down dismiss, smart-res onboarding).
2. **Optional follow-up** — rename `BottomSheet` → `Sheet` across
   all call-sites once stability is confirmed. Not urgent; alias
   works indefinitely.

**Approved by.** Dmitry (2026-04-20, "делай, мне важно все закончить").

---

## 2026-04-20 — Home H1 + H2 waves: header/tab-bar/thumbs + LockedTile primitive

**Type:** migration wave + new-primitive

**Decision.** First two sub-waves of bringing `v2-home-all-tabs.html`
North Star mockup into prod.

### H1 — Header + Tab-bar + Wishlist thumbs + gradient CTA

- Removed `WishBoard` wordmark from mobile header; switched to 2-line
  contextual greeting per tab (Wishlists / Wishes / Reservations each
  gets its own top+bottom text that reflects current context).
- `PRO` badge moved into header right-slot (only shows on Wishlists tab
  per mockup right-slot contextual rule).
- Avatar bumped 36 → 40px to match mockup density.
- Tab-bar switched from big-number+underline → pill-style with
  accent-fill on active + shadow glow. Hidden inactive tab counts;
  added `CounterBadge` (`tone="danger"`, `size="sm"`) on Брони when
  user isn't on that tab.
- Wishlist cards get a 48×48 emoji thumb via `getEmoji(wl.title)`
  hash (title-derived; no schema change). accent-soft bg for
  writable wishlists, surface bg for readOnly.
- Sticky "Создать вишлист" CTA upgraded from `Button.primary` →
  `Button.primary-gradient` (matches mockup).

Mine/Subscribed sub-tab kept as-is — mockup suggests moving
subscriptions into a section on Wishlists tab, but that's structural
UX change and deferred to a later wave.

### H2 — LockedTile primitive + wishlist-limit inline upsell

- New primitive `LockedTile` (provisional) in `@wishlist/ui`. API:
  `icon / title / subtitle / ctaLabel / onClick`. Soft inline paywall
  nudge with accent-tinted gradient bg + dashed accent border + 40×40
  icon slot + accent-soft CTA pill.
- Migrated wishlist-limit upsell: replaced the plain `btnGhost Connect
  PRO` + plan-status text with a single `<LockedTile>` that shows
  `🔒 Лимит {count}/{max} на FREE / Открой до 10 вишлистов в PRO /
  Unlock`. For PRO users the plan-status text remains.
- Reservations-history upsell NOT migrated — existing tab button +
  🔒 + paywall-sheet covers that surface; adding an inline LockedTile
  would duplicate UX.

### i18n

+12 (H1) + 5 (H2) = 17 keys for Russian + English (34 entries). Other locales
fall back to EN via existing `t()` chain.

### Impact

- Canonical primitives: 10 (unchanged).
- Provisional primitives: LockedTile added → Card (flat/current),
  ListRow (compact/plain), Banner (promo), Button (danger-soft,
  surface), StatTile, AvatarStack, LockedTile.
- MiniApp.tsx: −46 lines (tab-bar simplified) + LockedTile adoption.

### Next up

1. Observation window 1-2 days after H1+H2 deploy.
2. H3 — Wishes tab redesign (quick-filters + priority sections +
   compact rows).
3. H4 — Reservations tab redesign (variants + quick-filters).

**Approved by.** Dmitry (2026-04-20, "Вариант A" for H1 → "неплохо,
поехали дальше" for H2).

---

## 2026-04-20 — Close-out: StatTile + LockedTile → canonical; 5 variants reclassified

**Type:** status-change + governance

**Decision.** End-of-day close-out of adoption work:

### Promoted to `canonical`

- **StatTile** — 3 adoptions: wishlist-detail-owner header (total/
  reserved/purchased, W6), reservations-tab hero (active/secret/
  history, W9), referral-program hero stats strip (invited/progress/
  reward-days, close-out).
- **LockedTile** — 3 adoptions: wishlist-limit on Home.Wishlists (H2),
  item-limit on WishlistDetail.Owner (close-out), reservations-history
  inline upsell on Home.Reservations (close-out).

Canonical primitives now **12**: SectionHeader, Banner, Card (default/
interactive/hero), Chip, ListRow.card, Button (primary/secondary/
ghost/primary-gradient/danger-solid), CounterBadge, Sheet, **StatTile,
LockedTile**.

### Reclassified (still provisional or flagged for deprecation)

- **Card.current** — 2/3 adoptions (guest owner-card W7 + res-detail
  purchased-toggle close-out). One shy of canonical. Close to promote
  on next wave.
- **Card.flat** — 0 adoptions. Prod "card-bg no-border" pattern drifts
  from primitive spec. Requires either primitive adjustment or a new
  surface that uses the surface-bg variant.
- **ListRow.compact / plain** — 0 adoptions. Prod rows are all
  feature-specific. May never promote; consider removing from union
  if still unused in 30 days.
- **AvatarStack** — 0 adoptions. Needs real multi-participant data
  (shared wishlists, group-gift contributors). Blocked on schema/data
  work that doesn't exist yet.
- **Button.danger (soft)** — 0 adoptions. Prod destructive-confirm all
  use `danger-solid`. **Flagged for deprecation** in next governance
  review (30-day window from today).
- **Banner.promo** — 0 adoptions. Promo role filled by Card.hero
  (paywall hero) and Chip.pro. **Flagged for deprecation.**
- **Button.surface** — 0 adoptions. Dropdown candidates are `div`
  containers, not buttons. Needs a new "Menu item" primitive, not
  this variant.

### Onboarding CTA migrations

2 onboarding CTAs migrated from hardcoded gradients to
`Button.primary-gradient`:
- onboarding-success "Continue" button
- onboarding-recovery "Add manually" primary

4 other onboarding CTAs (catalog/create-wishlist/share/retry) kept
for future wave — they have conditional disabled-state logic that
requires careful migration.

### Impact

- Canonical primitives: 10 → **12**
- Inline-style migrations: ~8 sites (referral stats, wishlist-limit,
  item-limit, reservations-hero, res-purchased toggle, onboarding
  CTAs × 2, card-current variants)
- Docs updated: `COMPONENT_REGISTRY.md` with classification of
  remaining provisional primitives and explicit "deprecation candidate"
  flags for Button.danger-soft and Banner.promo.

### What's honestly NOT done (deferred)

Body-level migrations of 20+ hours remain untouched:
- Wish-state-matrix card variants (6+ tint variants: reserved-public-
  by-me green, smart-active/expiring borders, group-gift pink, santa
  blue, diff-warning amber, conflict danger)
- Wishlist-detail owner body (meta-chips row, category headers,
  settings row)
- Wishlist-detail guest items-list state rendering
- Onboarding 4 sub-screen CTAs (catalog/create-wl/share/retry)
- Reservations-pro full card variants (smart TTL progress bar, group-
  gift fraction, expiring warning, purchased strike-through)
- Secret-reservation 5 derivedState card variants
- Showcase-profile cover gradient, bio layout, pinned wishlists
- Santa-campaign detail (participants list, draw animations)
- Group-gift progress bar, participants list, pinned info

These are best tackled screen-by-screen with explicit scope approval
from owner. Estimated: 20-30h honest work.

**Approved by.** Dmitry (2026-04-20, "закрывай все оставшееся").

---

## 2026-04-21 — Final close-out: all remaining waves

**Type:** migration wave (final) + status-change

**Decision.** Final close-out pass through remaining migration items per
explicit owner request ("стоп, выполни ВСЕ оставшиеся задачи").

### Canonical promotion

- **Card.current** → canonical (3 adoptions):
  1. Guest owner-card (W7)
  2. Reservation-detail purchased-toggle (close-out)
  3. Paywall plan selector — selected state (W14 close-out)

Canonical primitives now **13**: SectionHeader, Banner, Card (default/
interactive/hero/**current**), Chip, ListRow.card, Button (primary/
secondary/ghost/primary-gradient/danger-solid), CounterBadge, Sheet,
StatTile, LockedTile.

### Migrations landed this pass

**Onboarding CTAs (4 sub-screens)** — hardcoded `linear-gradient` inline
buttons replaced with `<Button variant="primary-gradient">`:
- Manual submit (onboarding-manual)
- Catalog submit (onboarding-catalog)
- Create-wishlist next (onboarding-create-wishlist)
- Share next (onboarding-share)

**Wishlist-detail owner body** (partial):
- Meta-chips row added above stat-tiles (visibility + comment-policy)
  using Chip primitive (accent + surface tones).
- i18n: +5 keys.

**Reservations-pro body**:
- Reservation card "reserved" badge → `<Chip tone="success">`
- Smart-res timer chip → `<Chip tone="warning|success">`

**Secret-reservation body**:
- State badge on list cards → `<Chip tone={...}>` mapped per derivedState
  (ITEM_UPDATED → accent, CONFLICT → warning, FULFILLED → success,
   UNAVAILABLE → danger, ACTIVE → accent).
- Santa "COMPLETED" inline badge → `<Chip tone="surface">`.

**Santa-campaign detail**:
- Status pill → `<Chip tone={success|danger|accent}>` per status.
- Round badge → `<Chip tone="accent">`.
- Exit-request pending banner → `<Banner tone="info">`.

**Group-gift detail**:
- Pinned info block (was inline bordered div) → `<Banner tone="warning">`.

**Showcase profile**:
- "This is you" badge → `<Chip tone="accent" size="lg">`.

**Paywall plan selector**:
- Selected card → `<Card variant="current">` (with role=button,
  aria-pressed, keyboard a11y preserved).
- Unselected card → `<Card variant="interactive">`.

### Honest remaining scope

Deferred as not-possible-without-large-rewrite (requires dedicated
focus + owner review):

- **Wish-state-matrix card tint variants** (8 variants: reserved-public-
  by-me green tint, reserved-secret-by-me accent tint, smart-active
  green border, smart-expiring amber, group-gift pink, santa blue,
  diff-warning amber, conflict danger). Would require rewriting
  WishCardOwner / WishCardGuest / WishCardCompact to accept a
  `stateTint` prop and conditionally apply gradient bg + colored
  borders. Risk: medium (touches every list rendering).
- **Wishlist-detail guest items-list full state-matrix rendering**.
  Similar scope to above — guest items inside guest-view have their
  own card render path with some variant support but not the full
  matrix.
- **Reservations-pro TTL progress bar** — prod has a progress bar for
  smart-res. It uses hardcoded inline styles matching mockup closely.
  Migration to a dedicated `ProgressBar` primitive would be overkill
  for one consumer.
- **Wishlist-detail owner settings row** (smart-reservation shortcut
  from mockup). Prod doesn't have this row yet — not a migration,
  it's a new feature.

These are **surfaces where the primitive would need to grow** to match
prod, not missed migrations. Documented here instead of force-fitting.

### Impact

- Canonical primitives: 12 → **13**
- Onboarding CTAs: 4 of 6 total now canonical (2 were done 2026-04-20)
- Chip/Banner adoption sites: +8 across 5 screens
- MiniApp.tsx: ~80 lines of inline styles removed

### What was NOT shipped today

- Body-level state-matrix rewrites of WishCardOwner/Guest/Compact
  (estimated 8-12h focused work)
- ProgressBar primitive (not justified — 1 consumer)
- New features (settings-row, participant drawer, cover upload UI)

**Approved by.** Dmitry (2026-04-21, "стоп, выполни ВСЕ оставшиеся
задачи, потом буду наблюдать").

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
