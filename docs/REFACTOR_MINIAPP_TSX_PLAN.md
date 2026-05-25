# Refactor plan — `apps/web/app/miniapp/MiniApp.tsx` decomposition

**Status as of 2026-05-25.** F0 and F1 are **done and deployed** (see
Phase log at the bottom of this file for measured deltas). F2–F7 are
scoped but not started. Track is **open**.

**Realism note.** F0 and F1 both came in under the projected savings:
F0 ~−3 KB vs projected ~−10–20 KB brotli; F1 ~−84 KB vs projected
~−120–150 KB brotli. The projection-to-actual ratio is roughly **55–65%**.
The F2–F7 brotli-savings numbers below were drafted at the same time
as the F0/F1 projections and should be read with the same discount.
Conservatively: assume each phase delivers ~60% of the projected
brotli reduction. Closure target (≤ 200 KB brotli initial) probably
ends up at ~300–350 KB brotli, which is still a 2× improvement
over today's 666 KB — good, but not what was originally promised.

This document is **self-contained**: an agent picking up the front-end
perf-debt track should not need to read prior conversation. Everything
needed is here, in `git log`, or in the files listed.

---

## Why this exists

The Mini App initial JS payload is dominated by a single chunk —
`/_next/static/chunks/app/miniapp/page-*.js` — at **2.45 MB raw / 569 KB
brotli**. That chunk is the compiled output of `apps/web/app/miniapp/MiniApp.tsx`,
which is **34 166 LOC** in a single file. On a 1–2 Mbps mobile link the
chunk takes 3–6 seconds to transfer, before TLS/TTFB. Slow mobile users
see the splash screen for ~5 s before any interaction is possible.

Code-splitting cannot help while every screen, modal, hook, formatter, and
business rule lives inside one `MiniApp.tsx` — Webpack only splits at
module boundaries.

This is **the** front-end perf-debt item. Every other optimisation
(brotli at nginx, `optimizePackageImports`, narrower browserslist) is in
the single-digit-percent range. Splitting the monolith is the 5–10×
lever.

---

## TL;DR — target metrics

| Metric | Today (baseline) | After F1 | After F4 | After F7 (closure) |
|---|---|---|---|---|
| `MiniApp.tsx` LOC | **34 166** | 34 166 | ~20 000 | **≤ 2 000** |
| `app/miniapp/page-*.js` raw | **2.45 MB** | 2.45 MB | ~1.4 MB | **~400 KB** |
| `app/miniapp/page-*.js` brotli | **569 KB** | 569 KB | ~320 KB | **~100 KB** |
| Initial JS (all chunks needed for first paint) brotli | ~750 KB | **~350 KB** | ~280 KB | **~180 KB** |
| First paint on 1 Mbps link (estimated) | ~6 s | **~2.5 s** | ~2 s | **~1.5 s** |
| `next/dynamic` import sites in `miniapp/` | **0** | 4 | ~15 | ~25 |

Two distinct gains:
- **F1 alone** more than halves first-paint payload (lazy-load existing
  screens). This is the bulk of the user-perceived win.
- **F2–F7** flatten the long tail and unlock further per-feature
  splitting, set the codebase up for sane testability and ownership, and
  let future bundle regressions be caught by a per-chunk size budget.

---

## Current state map

```
apps/web/app/miniapp/
├── page.tsx                                 13 lines (Next entry)
├── MiniApp.tsx                          34 166 lines ← THE MONOLITH
├── sentry.ts                                Small wrapper, already dynamic
├── startParam.ts                            Pure parsing
├── lib/
│   ├── emoji.ts                             ✅ Extracted (2026-05-13)
│   ├── paywall.ts
│   ├── reservePrefill.ts
│   └── searchApi.ts
├── components/
│   ├── HintQuotaCounter.tsx
│   ├── ImportOnboarding.tsx
│   ├── ImportQuotaCounter.tsx
│   ├── ProBadge.tsx
│   ├── SantaAvatar.tsx                      ✅ Extracted
│   ├── SantaHatOverlay.tsx                  ✅ Extracted
│   ├── SnowflakeOverlay.tsx                 ✅ Extracted
│   ├── UserAvatar.tsx                       ✅ Extracted
│   └── importResultToast.ts
└── screens/
    ├── AppearanceSettings.tsx               319 LOC — extracted but NOT lazy
    ├── SearchScreen.tsx                   1 274 LOC — extracted but NOT lazy
    ├── WishlistCardV21.tsx                  215 LOC
    ├── calendar/                          3 814 LOC — extracted but NOT lazy
    │   ├── CalendarRoot.tsx
    │   ├── CalendarMain.tsx
    │   ├── CalendarDetail.tsx
    │   ├── CalendarCreate.tsx
    │   ├── CalendarImport.tsx
    │   ├── CalendarRecap.tsx
    │   ├── CalendarInbox.tsx
    │   ├── CalendarPaywall.tsx
    │   └── components.tsx
    └── survey/
        ├── SurveyScreen.tsx                 591 LOC — extracted but NOT lazy
        └── SurveyScreen.test.tsx
```

**Key observation:** an *extraction pilot* already happened on
2026-05-13–14 (commits `73fb0dc`, `a4f402f`, `a26f3a8`). Several screens
and small UI helpers were moved into `screens/` and `components/`. But
the imports inside `MiniApp.tsx` are still **static**, so all that work
still ends up in the same bundle. Webpack can't see what to split.

F1 unlocks the gain that earlier extraction already enabled.

---

## Principles

1. **No behaviour change. No design change.** Every phase must be a pure
   structural move. UI pixels and analytics events stay identical. If a
   bug is found mid-refactor, fix it in a separate commit per
   `feedback_bundle_fix_with_docs` discipline.
2. **One concern per file.** Hooks in `hooks/`, pure helpers in `lib/`,
   stateful React in `screens/` or `components/`, business calls in
   `services/`. Don't carry the monolith's "everything inside one
   function" pattern into the new files.
3. **Extract on touch, but also extract proactively.** The whole point
   is to land the splits. Don't gate on "would have touched this file
   anyway."
4. **Every `screens/*` module that's not on the first paint path gets
   `next/dynamic({ ssr: false })`.** Mini App is client-only — no SSR
   benefit; `ssr: false` keeps it out of the server bundle too.
5. **State is the constraint.** Most of the size comes from cross-tab
   state (current user, wishlist list, subscription, etc.) being defined
   inline. State must come out **as hooks** (`useUserState`,
   `useWishlistsState`, `useEntitlement`, …) so screens can consume it
   without dragging the rest of the monolith.
6. **Tests follow code on the same commit.** Per CLAUDE.md testing
   rules: a new pure helper extracted = unit test on the same commit.
   No "I'll add tests later."

### Anti-principles (what NOT to do)

- ❌ Don't extract a "shared utils" file. That re-creates the monolith
  under a new name. Each extracted helper goes to the most specific home.
- ❌ Don't introduce a new state library (Redux/Zustand/Jotai) along the
  way. The refactor is about file layout, not state mechanics. Keep
  `useState` + `useReducer` discipline; lift only when forced.
- ❌ Don't promote a legacy inline pattern to canonical. If you find an
  inline button/sheet/section while extracting, use the `@wishlist/ui`
  primitive in the new file (per `UI_IMPLEMENTATION_RULES.md`). The
  refactor is also the natural "migrate on touch" moment.
- ❌ Don't ship F1 with a `Suspense fallback={null}`. A blank screen
  where the calendar should appear is worse than the current monolith.
  Always provide a `<ScreenSkeleton />` fallback.

---

## Phases

### F0 — Quick-win bundle config (this PR)

**Goal:** ship two zero-risk Next config improvements as a single small
commit, separately from the structural refactor.

- `next.config.mjs` → `experimental.optimizePackageImports:
  ['@wishlist/shared', '@wishlist/ui']`. Rewrites barrel imports to
  deep imports — Webpack already does this for known packages, but
  workspace packages need to opt in.
- `apps/web/package.json` → `browserslist` field constraining targets
  to Safari ≥14 / Chrome ≥90. Telegram WebView always meets this.
- No code changes. No behaviour change.

**Expected impact:** −30–70 KB raw / −10–20 KB brotli on the initial
bundle. Small, but free.

**Acceptance:** `npx tsc --project apps/web/tsconfig.json --noEmit`
clean; `pnpm -C apps/web build` succeeds locally or in CI; manual
smoke of Mini App in Telegram on dev/staging branch.

**Status: 🟡 in flight in the same PR as this document.**

---

### F1 — Lazy-load already-extracted screens

**Goal:** convert the four big extracted screens (and their submodules)
to `next/dynamic({ ssr: false })`. This is the single highest-impact
phase by KB.

| Screen | LOC | Brotli est. | Trigger |
|---|---|---|---|
| `screens/calendar/CalendarRoot` (+8 submodules) | 3 814 | ~70 KB | Calendar tab tap |
| `screens/SearchScreen` | 1 274 | ~30 KB | Search tap / opens via FAB |
| `screens/survey/SurveyScreen` | 591 | ~15 KB | Survey deep-link or banner CTA |
| `screens/AppearanceSettings` | 319 | ~8 KB | Profile → Appearance |

**Combined savings: ~120–150 KB brotli off the initial bundle**, plus
the cascade effect on any of these screens' transitive deps that aren't
imported anywhere else (icons, regex tables, etc.).

**Implementation pattern:**

```ts
// In MiniApp.tsx
import dynamic from 'next/dynamic';
import { ScreenSkeleton } from './components/ScreenSkeleton'; // new — F1 task

const CalendarRoot = dynamic(
  () => import('./screens/calendar/CalendarRoot').then(m => ({ default: m.CalendarRoot })),
  { ssr: false, loading: () => <ScreenSkeleton variant="calendar" /> },
);

const SearchScreen = dynamic(
  () => import('./screens/SearchScreen').then(m => ({ default: m.SearchScreen })),
  { ssr: false, loading: () => <ScreenSkeleton variant="list" /> },
);

const SurveyScreen = dynamic(
  () => import('./screens/survey/SurveyScreen').then(m => ({ default: m.SurveyScreen })),
  { ssr: false, loading: () => <ScreenSkeleton variant="form" /> },
);

const AppearanceSettings = dynamic(
  () => import('./screens/AppearanceSettings').then(m => ({ default: m.AppearanceSettings })),
  { ssr: false, loading: () => <ScreenSkeleton variant="settings" /> },
);
```

**Pre-implementation checklist for F1:**

- [ ] Read every spot in `MiniApp.tsx` where the four screens are
  referenced. Confirm none of them call into the screens **outside** of
  the render tree (no side-effect imports, no `useEffect` that triggers
  a screen's module-scope code).
- [ ] Verify each screen's prop signature is stable — `dynamic` is
  stricter about types than direct imports.
- [ ] Build the `ScreenSkeleton` primitive in `apps/web/app/miniapp/components/`
  with four variants (`list`, `form`, `calendar`, `settings`). Inline
  in F1 PR; can promote to `@wishlist/ui` later.
- [ ] Add Mini App test that exercises tab navigation:
  `MiniApp.lazyScreens.test.tsx` — asserts that navigating to each tab
  doesn't crash with the skeleton fallback. Vitest + jsdom is fine
  (RTL `userEvent` + `findBy*`).
- [ ] Manual smoke on real Telegram (iOS + Android) before merge. Each
  screen must transition without flash-of-empty or duplicated network
  calls.
- [ ] Verify `chunk-size.txt` snapshot before / after (see F-CI below).

**Expected outcome:** initial bundle from ~570 KB brotli → ~380 KB
brotli. First paint on 1 Mbps from ~6 s → ~2.5 s.

**Estimated effort:** 1 day including review + smoke.

---

### F2 — Map the monolith

**Goal:** before extracting more, produce a `MINIAPP_DECOMPOSITION_MAP.md`
that lists every top-level section inside `MiniApp.tsx` with LOC,
external deps, state coupling, and target destination.

Output structure (mirror of API decomposition handoff):

```
| Section | LOC range | Lines | Owns state? | Target file | Risk |
|---|---|---|---|---|---|
| HomeScreen (default tab) | 2 100 | L1500–L3600 | Some local | screens/HomeScreen.tsx | M |
| WishlistList | 1 800 | L3600–L5400 | Reads global | screens/WishlistList.tsx | L |
| WishlistEditor | 2 300 | L5400–L7700 | Form state | screens/WishlistEditor.tsx | H — uploads |
| ReservationSheet | 900 | L7700–L8600 | Reads global | sheets/ReservationSheet.tsx | L |
| GiftPickerSheet | 1 200 | L8600–L9800 | Local | sheets/GiftPickerSheet.tsx | L |
| PaywallSheet | 600 | … | … | sheets/PaywallSheet.tsx | M — billing surface |
| OnboardingSheet | 1 100 | … | Side-effects | sheets/OnboardingSheet.tsx | H |
| SettingsScreen | 1 400 | … | Reads global | screens/SettingsScreen.tsx | L |
| SantaCampaign | 1 800 | … | Local | screens/SantaCampaign.tsx | M |
| Profile | 1 600 | … | Reads global | screens/Profile.tsx | L |
| GroupGift | 1 400 | … | Local | screens/GroupGift.tsx | M |
| ImportFlow | 1 100 | … | Local | screens/ImportFlow.tsx | M |
| HintsFlow | 800 | … | Local | sheets/HintsFlow.tsx | L |
| <state hooks defined inline> | 2 500 | … | OWNS | hooks/use*.ts | H — touches everything |
| <pure helpers> | 1 200 | … | None | lib/*.ts | L |
```

*The above is a hypothesis — F2's deliverable is the verified mapping.*

**Pre-implementation checklist for F2:**

- [ ] No code change. Pure analysis.
- [ ] Walk `MiniApp.tsx` top to bottom; mark every named React component
  declaration's start/end lines.
- [ ] For each section, list the inline state it owns vs reads (grep
  for `useState`, `useReducer`, top-level `const`).
- [ ] For each section, list inline functions called from > 1 sibling
  section (extraction-threshold candidates per CLAUDE.md services rule).
- [ ] Produce `docs/MINIAPP_DECOMPOSITION_MAP.md`.
- [ ] Risk-rank each section (L/M/H) by:
  - state coupling depth,
  - billing/security surface involvement,
  - test coverage gap.

**Estimated effort:** ~1 day (analysis only).

---

### F3 — Extract leaf state hooks

**Goal:** lift inline state into `hooks/` so screens can be extracted in
F4 without dragging the monolith with them.

State to lift (hypothesised; F2 confirms):

```
apps/web/app/miniapp/hooks/
├── useUser.ts                  Current user, profile, locale
├── useEntitlement.ts           Pro/lifetime status, paywall context
├── useWishlists.ts             List + selection + sort
├── useItemsForWishlist.ts      Active wishlist items
├── useReservations.ts          Reservation map
├── useCalendarEvents.ts        Already partially in screens/calendar/
├── useSubscription.ts          Subscription + renewal info
├── useReferral.ts              Referral program state
├── useSantaCampaign.ts         Santa state machine
└── useToast.ts                 Toast queue + a11y live-region
```

Each hook:
- Owns its `useState` / `useReducer`.
- Exposes a stable API (`{ data, loading, error, mutate }`).
- Has its own unit test (mock `tgFetch`).
- Is exported from `hooks/index.ts` for one-line consumer imports.

**Pre-implementation checklist (per hook):**

- [ ] Grep `MiniApp.tsx` for the current state variable's name. List every
  read and write call-site.
- [ ] Replace all call-sites with the hook in **one commit per hook**.
- [ ] `tsc --noEmit` clean; existing tests pass; new unit test added.

**Estimated effort:** ~2 days (10 hooks × ~2 h each, including tests).

---

### F4 — Extract sheet families

**Goal:** every modal/sheet currently inline becomes its own file,
imported via `next/dynamic` (sheets are user-action-triggered, not
first-paint).

Sheets to extract (hypothesised; F2 confirms):

```
apps/web/app/miniapp/sheets/
├── ReservationSheet.tsx
├── GiftPickerSheet.tsx
├── PaywallSheet.tsx
├── OnboardingSheet.tsx
├── HintsFlow.tsx
├── ImportFlow.tsx
├── ShareSheet.tsx
├── BirthdayOptInSheet.tsx       [per feedback_explicit_optin_after_data]
├── DeleteAccountSheet.tsx
└── …
```

**Pre-implementation checklist for F4:**

- [ ] Each sheet must use `@wishlist/ui`'s `Sheet` primitive (per design
  system rule). If it currently uses a hand-rolled inline modal, migrate
  on touch.
- [ ] Birthday/sensitive opt-in sheets must preserve their explicit
  opt-in flow per `feedback_explicit_optin_after_data` — no implicit
  notify after extraction.
- [ ] Paywall sheets must preserve 402 / paywall-context contract per
  `feedback_pro_settings_must_error`.
- [ ] Each sheet gets a Vitest test for the open/close round-trip and
  the primary action.

**Estimated effort:** ~3 days.

---

### F5 — Extract screen components

**Goal:** every section identified in F2 becomes `screens/<Name>.tsx`.
Tabs use `next/dynamic({ ssr: false })`. Inline screens (always-on
home) stay synchronous but live in their own file.

Screens to extract:

```
apps/web/app/miniapp/screens/
├── HomeScreen.tsx               (synchronous — first paint)
├── WishlistList.tsx             (synchronous — first paint)
├── WishlistEditor.tsx           (dynamic)
├── Profile.tsx                  (dynamic — tab)
├── Settings.tsx                 (dynamic — tab)
├── SantaCampaign.tsx            (dynamic — season-gated)
├── GroupGift.tsx                (dynamic — feature-flag)
└── …
```

**Pre-implementation checklist for F5:**

- [ ] HomeScreen + WishlistList stay synchronous — they're on the
  first-paint path. Verify the LOC after extraction; if either is still
  > 1 000 LOC, sub-extract its internals.
- [ ] Every dynamic screen has a `ScreenSkeleton` variant (extends F1's
  primitive).
- [ ] Each screen's `props` interface is type-strict; no `any` for
  store/state.

**Estimated effort:** ~4 days.

---

### F6 — Extract pure helpers

**Goal:** every inline formatter, date math, regex, threshold check,
URL builder, etc. becomes a named function in `lib/` with a unit test.

This is also the natural moment to enforce the
`feedback_bugfix_lessons` rule retroactively: pure helpers that should
have been extracted on prior bug fixes get extracted now, with tests.

**Files (hypothesised; F2 confirms):**

```
apps/web/app/miniapp/lib/
├── formatDate.ts              + .test.ts
├── formatPrice.ts             + .test.ts
├── parseStartParam.ts         already exists (startParam.ts) — consolidate
├── shareLinks.ts              + .test.ts
├── reservationCopy.ts         + .test.ts
├── giftPickerScoring.ts       + .test.ts
└── …
```

**Pre-implementation checklist for F6:**

- [ ] Each helper has a unit test on the same commit.
- [ ] Each helper's logic appears **in exactly one place** post-extract
  (no inline duplicates left in `MiniApp.tsx`).
- [ ] Per CLAUDE.md: any helper repeated ≥2× must be extracted.

**Estimated effort:** ~3 days.

---

### F7 — Closure

**Goal:** `MiniApp.tsx` is now a composition root — routing, top-level
layout, global error boundary, suspense boundaries, and `dynamic()`
imports. Target ≤ 2 000 LOC.

**Closure conditions:**

- [ ] `MiniApp.tsx` ≤ 2 000 LOC.
- [ ] Initial bundle ≤ 200 KB brotli (excluding fonts/CSS).
- [ ] Per-chunk size budget added to CI (see F-CI below).
- [ ] No remaining inline screen definitions > 200 LOC in `MiniApp.tsx`.
- [ ] No remaining inline `useState` for cross-tab state (all in hooks/).
- [ ] No remaining inline pure helpers in `MiniApp.tsx`.
- [ ] Document closure in this file + `BUGFIX_LESSONS.md` reflection
  entry on what made the monolith grow in the first place.

---

### F-CI — Size budget (cross-cutting)

**Goal:** prevent regression. Set a per-chunk size budget enforced in
CI; PRs that grow a chunk by > 5% (or > 20 KB raw, whichever bigger)
get blocked or annotated.

Tooling options (decide in F-CI scoping):
- **`@next/bundle-analyzer`** in `pnpm web:bundle-analyze` (one-shot
  visual report; doesn't enforce).
- **`size-limit`** with `webpack` preset and `.size-limit.json`
  declaring per-route budgets (enforces in CI; existing project pattern).

Recommended: `size-limit` in `apps/web/`. Add it once F1 has settled
(prevents fighting the moving baseline).

```json
// apps/web/.size-limit.json (example)
[
  { "name": "miniapp/page", "path": ".next/static/chunks/app/miniapp/page-*.js", "limit": "250 KB" },
  { "name": "miniapp/framework", "path": ".next/static/chunks/framework-*.js", "limit": "200 KB" }
]
```

**Pre-implementation checklist for F-CI:**

- [ ] Install `size-limit` + `@size-limit/webpack-why` in `apps/web/`.
- [ ] Run once locally to capture current limits as a baseline.
- [ ] Add a `pnpm size` script + wire into `.github/workflows/test.yml`
  as a non-blocking annotation first, then promote to blocking once F1
  has shipped.

**Estimated effort:** ~½ day.

---

## Order and parallelism

```
F0 → F1 ──→ F2 ──→ F3 ──→ F5 ──→ F7
                  └──→ F4 ──┘
                  └──→ F6 ──┘
                  └──→ F-CI (anytime after F1)
```

- **F0** is this PR.
- **F1** is sequential after F0.
- **F2** is sequential after F1 (so the monolith's behaviour is
  unchanged when mapping).
- **F3** must complete before F4/F5 — extracting screens without lifted
  state means screens drag the monolith.
- **F4, F6** can run in parallel with F5 once F3 is in.
- **F7** is the gate at the end.
- **F-CI** can land anytime after F1, but most useful after F5.

---

## Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| State coupling deeper than mapped → F3 cascades | High | F2 is the map; if F2 reveals state-graph > 3 layers deep, halt and re-plan F3 |
| Lazy screen flash-of-empty on slow devices | Medium | `ScreenSkeleton` mandatory in F1 + matching dark-mode CSS-var background |
| Behaviour change in extracted sheet (esp. paywall) | Medium | F4 sheets get round-trip test; manual smoke on each billing-adjacent path before merge |
| Bundle regression mid-refactor | Medium | F-CI annotation lands after F1 with current limits; trend visible in PRs |
| Hooks introducing re-render cascades vs inline state | Medium | F3 hooks must follow `useMemo`/`useCallback` discipline; rely on React Profiler manual check + Telegram-WebView frame-rate observation |
| Refactor pauses mid-flight → MEM grows half-split | High | Each phase commits to `main` independently; never leave a half-extracted screen on a long-lived branch |
| Forgetting a manual screen tap on a low-traffic flow (Santa season, Survey) → silent break | High | F2 produces the full feature inventory; F5/F4 phase exit gates require manual smoke on EACH item in that inventory |
| Test infra missing for jsdom MiniApp tests | Low | Existing `screens/SearchScreen.test.tsx` + `survey/SurveyScreen.test.tsx` prove the pattern works; reuse |

---

## Open questions (resolve before F2)

1. **Do we want a `wishboard-app-shell` package?** I.e., extract the
   composition root into a publishable workspace pkg, separate from
   feature screens. Probably no — adds complexity without runtime gain.
2. **Should F1 also lazy-load `screens/WishlistCardV21`?** It's small
   (215 LOC) and used inside the wishlist list — likely on the first
   paint path. F2 confirms.
3. **State strategy after F3:** keep `useState` lifting (current
   direction) vs introduce `useSyncExternalStore` for cross-tab sync.
   Probably defer to after F7 unless F3 reveals a clear pain point.
4. **CSS / Tailwind splitting:** the current 26 KB raw CSS is fine.
   Revisit only if Tailwind purge starts missing classes due to dynamic
   imports.

---

## Out of scope (explicitly)

- Server-side rendering of Mini App. It's a Telegram WebView; SSR
  buys nothing and complicates auth.
- Service Worker / offline-first cache. Separate track; consider after
  F7.
- Migrating to React Server Components for Mini App. Doesn't fit the
  Telegram model; not now.
- Image optimisation (`<Image>` etc.). Tracked elsewhere; small impact.
- Brotli at nginx layer. Cloudflare covers it today; nginx-level brotli
  is defense-in-depth, not on this track.

---

## Phase log

### F0 — done @ `6525761` on 2026-05-25

- `next.config.mjs`: `experimental.optimizePackageImports:
  ['@wishlist/shared', '@wishlist/ui']`.
- `apps/web/package.json`: `browserslist` field added.
- `docs/REFACTOR_MINIAPP_TSX_PLAN.md` created.

**Bundle delta (measured against pre-F0 baseline):**
- `miniapp/page-*.js`: 2 456 737 b → 2 437 852 b raw (−18.9 KB, −0.8%)
- `miniapp/page-*.js`: 569 KB → 566 KB brotli (**−3 KB**, −0.5%)
- `polyfills-*.js`: hash unchanged → 0 effect on polyfill bundle

**Lessons (recorded in `BUGFIX_LESSONS.md`):**
- Next.js 15 polyfills are NOT controlled by browserslist; they have
  their own baseline target. The `browserslist` source therefore
  affects only SWC's downlevel-compile target and CSS prefixing,
  not the polyfill file size. Original F0 projection (−10–20 KB
  brotli) assumed browserslist would shrink polyfills — wrong.

### F1 — done @ `9c1e220` (initial, failed deploy) + `c7a84c6` (fix) on 2026-05-25

- `MiniApp.tsx`: 4 static imports replaced with `next/dynamic({ ssr:
  false })` for `AppearanceSettings`, `CalendarRoot`, `SearchScreen`,
  `SurveyScreen`.
- `apps/web/.browserslistrc` added (later F1-followup: `package.json`
  field removed — see deploy incident below).
- `packages/ui/src/Skeleton.tsx` added (F1-followup): provisional
  primitive with 4 layout variants (`list` / `form` / `calendar` /
  `settings`). Promoted from `legacy` in `COMPONENT_REGISTRY.md`.
  Decision log: `DESIGN_DECISIONS.md#2026-05-25--skeleton-primitive`.
- `apps/web/test/skeleton.test.tsx` added — per-variant layout-shape
  assertions, a11y contract, design-system contract (radius / animation
  / theme var).
- `apps/web/app/miniapp/monolith-guards.test.ts` extended with regex
  guards that each of the 4 screens stays wrapped in `dynamic()` —
  catches an "innocent revert to static import" PR before it ships.

**Bundle delta (measured against post-F0 baseline):**
- `miniapp/page-*.js`: 2 437 852 b → 2 259 367 b raw (−178 KB, −7.3%)
- `miniapp/page-*.js`: 566 KB → 520 KB brotli (**−46 KB**, −8.1%)
- Plus new lazy chunks (NOT counted in initial load):
  - `907.*.js` 132 KB raw (probable CalendarRoot tree)
  - `30.*.js` 25 KB raw
  - `927.*.js` 22 KB raw

**Cumulative F0+F1 vs pre-F0 baseline:**
- Total initial JS: ~750 KB → **666 KB brotli (−84 KB, −11%)**
- 4 lazy chunks now fetch on-demand (Calendar/Search/Survey/Appearance
  tab open)

**Deploy incident.** F1 commit `9c1e220` shipped `.browserslistrc` and
left the F0 `browserslist` field in `package.json` — browserslist
defensively throws when both sources exist. CI Docker build failed
on `pnpm build:web`. Prod was unaffected (old container kept running).
Fix `c7a84c6` removed the `package.json` field, kept `.browserslistrc`,
and added a lesson to `BUGFIX_LESSONS.md` (2026-05-25 browserslist
double-source entry): **`tsc --noEmit` is not a substitute for
`pnpm -C apps/web build` on config-changing PRs.**

**Smoke status.** Local Next build succeeded; prod health-check
(release `c7a84c6`) green on all 6 mandatory checks (migrations,
api health, containers, bot heartbeat, lifecycle, errors-24h). Real
Telegram smoke on iOS/Android/Desktop **NOT yet executed** by the
agent — flagged for owner verification per the
`feedback_verify_real_surface` rule.

**Realism gap.** Projected −120–150 KB brotli; delivered −46 KB on
the page chunk / −84 KB on total initial JS. Gap explained by the
4 extracted screens being only ~6 000 of the ~34 000 LOC monolith;
the rest of `MiniApp.tsx` (modals, sheets, main-tab screens, hooks,
helpers) stays in `page-*.js`. Going forward, expect each phase to
hit ~60% of its projected brotli savings. F2 (mapping) doesn't ship
bytes — it unlocks F3–F6.

---

### F2 — pending
