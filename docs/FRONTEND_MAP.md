# FRONTEND_MAP.md — Frontend Architecture

> Date: 2026-05-20. Verified from source code.

---

## 1. File / Folder Structure

```
apps/web/
  middleware.ts                  - Basic Auth for /admin/*, www->canonical redirect
  app/
    layout.tsx                   - Root layout (fonts, metadata)
    page.tsx                     - Home/landing page
    globals.css                  - Global styles (Tailwind)
    app/
      page.tsx                   - Redirects /app -> /miniapp
    miniapp/
      layout.tsx                 - Mini App layout (viewport meta, Telegram script)
      page.tsx                   - Mini App page entry (renders <MiniApp />)
      MiniApp.tsx                - THE ENTIRE MINI APP (~30,000+ lines, single component)
      TelegramWebApp.tsx         - Telegram WebApp type declarations / helper
    admin/
      page.tsx                   - Admin: wishlist list
      new/page.tsx               - Admin: create wishlist
      [id]/page.tsx              - Admin: edit wishlist
    w/[slug]/
      page.tsx                   - Public wishlist page (SSR)
      WishlistClient.tsx         - Client-side wishlist component
      error.tsx                  - Error boundary
      not-found.tsx              - 404 page

packages/shared/src/
  i18n.ts                        - 6-locale i18n: t(), detectLocale(), pluralize(), isRTL()
  index.ts                       - Package exports
```

---

## 2. Screen State Machine

`MiniApp.tsx` manages navigation exclusively through a `useState<Screen>` hook. There is no routing library.

### Screen Type Union (61 screens)

```typescript
type Screen =
  // Core (6)
  | 'loading' | 'error' | 'maintenance'
  | 'my-wishlists' | 'wishlist-detail' | 'item-detail'
  // Social (4)
  | 'share' | 'guest-view' | 'guest-item-detail' | 'my-reservations'
  // Settings & Profile (3)
  | 'settings' | 'profile' | 'public-profile'
  // Archive / Drafts (2)
  | 'archive' | 'drafts'
  // Onboarding v2 (10)
  | 'onboarding-entry' | 'onboarding-demo' | 'onboarding-complete'
  | 'onboarding-try' | 'onboarding-success' | 'onboarding-recovery'
  | 'onboarding-catalog' | 'onboarding-create-wishlist' | 'onboarding-share'
  | 'onboarding-manual'
  // Secret Santa (9)
  | 'santa-hub' | 'santa-create' | 'santa-campaign' | 'santa-join'
  | 'santa-chat' | 'santa-polls' | 'santa-exclusions'
  | 'santa-organizer' | 'santa-receiver-wishlist'
  // Gift Notes (4)
  | 'gift-notes' | 'gift-notes-occasion' | 'gift-notes-paywall'
  | 'gift-notes-onboarding'
  // Group Gift (5)
  | 'group-gift-paywall' | 'group-gift-create' | 'group-gift-detail'
  | 'group-gift-join' | 'group-gift-chat'
  // Showcase (2)
  | 'showcase-editor' | 'showcase-preview'
  // Secret Reservations (2)
  | 'secret-reservation-detail' | 'secret-reservation-paywall'
  // Curated Selections (2)
  | 'curated-view' | 'guest-link-expired'
  // Referral (2)
  | 'referral' | 'referral-history'
  // Utility (3)
  | 'item-unavailable' | 'first-share-prompt' | 'link-management'
  // Settings extras (4)
  | 'faq' | 'changelog' | 'legal' | 'legal-doc'
  // Calendar (1) — Events Calendar v2.1 (full feature, shipped 2026-04-28)
  | 'calendar';
```

Navigation is done by calling `setScreen(...)` together with supporting state (`setSelectedWishlist(...)`, `setSelectedItem(...)`, etc.). There are no URL changes.

### Screen Descriptions by Subsystem

#### Core (6)

| # | Screen | Description |
|---|--------|-------------|
| 1 | `loading` | Spinner while Telegram initData is validated and initial data is fetched |
| 2 | `error` | Error state with retry button; shown when init fetch fails |
| 3 | `maintenance` | Shown when API responds 503 with `code: 'MAINTENANCE'` |
| 4 | `my-wishlists` | Home: v2.1 IA — StatRow (4 tiles) + inner tabs (Wishlists / Wishes / Reservations / Архив). FloatingNav replaces the outer 3-tab bar (W69) |
| 5 | `wishlist-detail` | Items list for a specific wishlist (owner view). Filter/sort, item counter, privacy settings, share button, add item, drag-to-reorder within priority group |
| 6 | `item-detail` | Full item edit/view for owner: title, description, price, priority, currency, URL, photo. Complete/delete. Comments thread. Hint button (PRO). Move to another wishlist |

#### Social (4)

| # | Screen | Description |
|---|--------|-------------|
| 7 | `share` | Share screen: share token link, Telegram share button, copy link |
| 8 | `guest-view` | Wishlist seen by a friend: items + reservation statuses. Filter/sort (price_asc, price_desc, priority_desc, recommended[PRO]). Budget filter. Subscribe button |
| 9 | `guest-item-detail` | Single item seen by guest: reserve/unreserve button, comments (PRO), purchased button |
| 10 | `my-reservations` | Items reserved by current user across all wishlists. Unread comment count badge per item. **PRO layer**: Active/History segment, filters bar (unread, owner, sort), inline note/purchased/reminder controls per card, history tab with filter chips (All/Gifted/Cancelled/Archived). Non-PRO users see lock icons and upsell prompts |

#### Settings & Profile (3)

| # | Screen | Description |
|---|--------|-------------|
| 11 | `settings` | Plan card (FREE: upgrade block; PRO: subscription info + cancel/resume). Notifications. Privacy (profileVisibility, subscribePolicy, commentsEnabled, hintsEnabled). App behavior (currency, wishlist position). Subscriptions (wishlists user follows with unread counts). God Mode dashboard (A/B onboarding metrics, feature toggles, locale segments analytics, retention stats) |
| 12 | `profile` | User profile: avatar, displayName, username, bio, birthday. Stats (wishlists count, total wishes, reservations, archived). Plan card. Edit profile. Delete account |
| 13 | `public-profile` | View another user's public profile via `profile_` deep link |

#### Archive / Drafts (2)

| # | Screen | Description |
|---|--------|-------------|
| 14 | `archive` | Archived/completed items -- either wishlist-specific or global. Restore/purge. Bulk restore, bulk hard-delete |
| 15 | `drafts` | SYSTEM_DRAFTS wishlist: URL-imported items awaiting curation. Move to real wishlist or edit. Bulk move, bulk delete, bulk archive |

#### Onboarding v2 (10)

Multi-step welcome flow for new users. Controlled by server-side onboarding status (`/tg/onboarding/status`).

| # | Screen | Description |
|---|--------|-------------|
| 16 | `onboarding-entry` | Welcome entry point; presents the onboarding flow |
| 17 | `onboarding-demo` | Interactive demo of app features |
| 18 | `onboarding-complete` | Onboarding completion confirmation |
| 19 | `onboarding-try` | Try URL import: paste a product URL to test the import flow |
| 20 | `onboarding-success` | Success state after a successful try-import |
| 21 | `onboarding-recovery` | Recovery flow when try-import fails |
| 22 | `onboarding-catalog` | Browse catalog items to select for first wishlist |
| 23 | `onboarding-create-wishlist` | Create first wishlist during onboarding |
| 24 | `onboarding-share` | Share newly created wishlist; final onboarding step |

#### Secret Santa (9)

Full Secret Santa campaign system with group chat, polls, exclusions, and gift tracking.

| # | Screen | Description |
|---|--------|-------------|
| 25 | `santa-hub` | Dashboard listing all Secret Santa campaigns the user participates in |
| 26 | `santa-create` | Create a new Secret Santa campaign (title, budget, deadline) |
| 27 | `santa-campaign` | Campaign detail: participants, status, draw, gift tracking, hints, linked wishlist. Actions vary by role (organizer vs participant) |
| 28 | `santa-join` | Join preview / confirmation for a Secret Santa invite link |
| 29 | `santa-chat` | Group chat within a campaign (messages, pagination, mute toggle, read tracking) |
| 30 | `santa-polls` | Polls within a campaign: create, vote, close |
| 31 | `santa-exclusions` | Manage draw exclusions: individual pairs and exclusion groups |
| 32 | `santa-organizer` | Organizer summary dashboard: participant statuses, exit requests (approve/deny) |
| 33 | `santa-receiver-wishlist` | View the receiver's wishlist items within a Santa campaign context; reserve items for gift |

#### Gift Notes (4)

Occasion-based gift idea tracker. Requires add-on purchase (`gift_notes_unlock`).

| # | Screen | Description |
|---|--------|-------------|
| 34 | `gift-notes` | List of gift occasions (birthdays, holidays, etc.). Create/edit occasions with recurrence |
| 35 | `gift-notes-occasion` | Detail view for a single occasion: ideas list, add/complete/delete ideas, edit occasion metadata, complete/archive/delete occasion |
| 36 | `gift-notes-paywall` | Paywall gate for Gift Notes add-on purchase via Telegram Stars |
| 37 | `gift-notes-onboarding` | 4-step demo-first onboarding for the Gift Notes feature, shown on first access. Walks through occasions, ideas, reminders, and the paywall CTA |

#### Group Gift (5)

Full group gift collection system with shared contributions, chat, and invite links.

| # | Screen | Description |
|---|--------|-------------|
| 38 | `group-gift-paywall` | Purchase screen for `group_gift_unlock` (79 Stars). Shows features list, buy button |
| 39 | `group-gift-create` | Create form: target amount, deadline (optional), note, initial contribution amount |
| 40 | `group-gift-detail` | Main dashboard: progress bar, participants list with amounts, chat button, share button. Organizer sees management section (edit payment details, complete, cancel). Participant sees own amount editor and leave option |
| 41 | `group-gift-join` | Join screen via invite link: shows item, organizer name, progress, amount input |
| 42 | `group-gift-chat` | Chat messages between participants. Supports USER and SYSTEM message types. Auto-polls every 5s |

#### Showcase (2)

PRO profile showcase editor and preview. Accessible from the profile screen.

| # | Screen | Description |
|---|--------|-------------|
| 43 | `showcase-editor` | PRO profile showcase editor: upload cover photo, set bio, pin up to 3 wishlists, configure sizing preferences and brand preferences |
| 44 | `showcase-preview` | Preview of how your profile showcase appears to other users before publishing |

#### Secret Reservations (2)

Add-on (`secret_reservation_unlock`, 24 XTR one-time) that lets guests reserve an item without the owner seeing who reserved it.

| # | Screen | Description |
|---|--------|-------------|
| 45 | `secret-reservation-detail` | Detail view for a secret reservation: shows item snapshot, reservation status, option to cancel (releases item), acknowledge item updates, or promote to a public reservation |
| 46 | `secret-reservation-paywall` | Paywall for the Secret Reservation add-on (24 XTR one-time purchase). Shown when a guest attempts a secret reserve without the unlock |

#### Curated Selections (2)

PRO feature — share a curated subset of wishlist items via a temporary token link (`часть вишлиста`).

| # | Screen | Description |
|---|--------|-------------|
| 47 | `curated-view` | In-app guest view of a curated selection (by deep link or tap from notification). Shows title, owner, selected items snapshot, subscribe button |
| 48 | `guest-link-expired` | Shown when a guest opens an expired or revoked curated selection link. Explains the link is no longer active |

#### Referral (2)

Invite-a-friend screen and attribution history. Feature-flagged off by default (`ReferralProgramConfig.enabled = false`).

| # | Screen | Description |
|---|--------|-------------|
| 49 | `referral` | Invite-a-friend screen: displays unique referral link, share button, and stats on invited friends |
| 50 | `referral-history` | History of referral attributions and their reward status (pending / qualified / rewarded) |

#### Utility (3)

| # | Screen | Description |
|---|--------|-------------|
| 51 | `item-unavailable` | Shown when a wish item is no longer accessible (deleted, moved, or access revoked). Provides a back-navigation option |
| 52 | `first-share-prompt` | Celebratory prompt shown after user's first real wish is added — invites them to share the wishlist with friends |
| 53 | `link-management` | Settings subscreen listing all active share links (wishlists + curated selections) with per-link detail sheets, view counters, and revoke controls |

#### Settings Extras (4)

Additional screens accessible from the settings area.

| # | Screen | Description |
|---|--------|-------------|
| 54 | `faq` | FAQ screen: 50 questions in 15 sectioned accordion groups (About, Plans, Payments, Reservations, Secret Reservations, Smart Reservations, Group Gift, Gift Notes & Don't Gift, Showcase & Selections, Links & Access, Comments & Subscriptions, Secret Santa, Archive & Deletion, Support, Upcoming Features) |
| 55 | `changelog` | Release notes / What's New |
| 56 | `legal` | Legal documents list (v2.0, effective 30.04.2026): Privacy Policy, Terms of Use, Pro & Purchase Terms |
| 57 | `legal-doc` | Single legal document viewer (renders chosen v2.0 legal doc in user's locale) |

#### Onboarding Extra (1)

| # | Screen | Description |
|---|--------|-------------|
| 58 | `onboarding-manual` | Manual item creation in onboarding |

#### Calendar (1)

| # | Screen | Description |
|---|--------|-------------|
| 59 | `calendar` | **Events Calendar v2.1** — full feature: occasions, holidays import, friend-birthdays import, per-occasion reminders, in-app inbox, today-context banner, year-recap, expandable idea cards with photo upload, custom-emoji + date picker (day/month/year sheets), 4-step onboarding (server-persisted via `User.calendarOnboardingSeenAt`). Backend wired to `/tg/calendar/*` and `/tg/gift-occasions/*` routes |

---

## 3. Home Tabs

The `my-wishlists` screen has a segmented control with three tabs, tracked by `useState<HomeTab>`:

```typescript
type HomeTab = 'wishlists' | 'wishes' | 'reservations';
```

| Tab | Content | API call |
|-----|---------|----------|
| `wishlists` | User's wishlists with item counts, FREE/PRO `readOnly` badge, drag-to-reorder | `GET /tg/wishlists` |
| `wishes` | Flat list of all items across all non-archived wishlists | `GET /tg/items` |
| `reservations` | Items reserved by the current user. PRO: Active/History tabs, filters, notes, reminders | `GET /tg/reservations`, `GET /tg/reservations/history` (PRO) |

The `wishlists` tab also shows:
- A drafts banner (if SYSTEM_DRAFTS has pending items) -- tapping navigates to the `drafts` screen
- A PRO upsell card for FREE users (limit info + upgrade CTA)
- A "My Reservations" quick link if `reservationsCount > 0`

---

## 4. Design System

> **v2.1 refresh shipped 2026-04-21 (W22–W80, 80 total wave items).** All screens updated to glass + mesh + accent-gradient styling. The `C` constant values below reflect the v2.1 palette.

All legacy colors are defined in the `C` constant at the top of `MiniApp.tsx`. New primitives from `@wishlist/ui` use CSS custom properties (`var(--wb-*)`) defined in `packages/ui-tokens`.

### Colors (v2.1 values)

| Token | Value | Usage |
|-------|-------|-------|
| `C.bg` | `#0F0F12` | Page background (darker than v1) |
| `C.surface` | `#26262C` | Cards, bottom sheets |
| `C.surfaceHover` | `#2E2E36` | Hover / press states |
| `C.card` | `#2F2F38` | Item cards |
| `C.accent` | `#8B7BFF` | Primary violet: buttons, active states (v2.1) |
| `C.accentSoft` | `rgba(139,123,255,0.14)` | Secondary button backgrounds |
| `C.accentGlow` | `rgba(139,123,255,0.25)` | Glow effects |
| `C.green` | `#4ADE80` | Success, available status (v2.1) |
| `C.greenSoft` | `rgba(74,222,128,0.14)` | Green tinted backgrounds |
| `C.orange` | `#FBBF24` | Warning, medium priority |
| `C.orangeSoft` | `rgba(251,191,36,0.14)` | Orange tinted backgrounds |
| `C.red` | `#FB7185` | Error, destructive, deleted (v2.1) |
| `C.redSoft` | `rgba(251,113,133,0.14)` | Red tinted backgrounds |
| `C.text` | `#FFFFFF` | Primary text (pure white in v2.1) |
| `C.textSec` | `#C7CAD1` | Secondary text (v2.1) |
| `C.textMuted` | `#8F94A3` | Muted / placeholder text (v2.1) |
| `C.border` | `rgba(255,255,255,0.06)` | Subtle borders |
| `C.borderLight` | `rgba(255,255,255,0.1)` | Input borders |

### v2.1 Appearance Themes (PRO-gated)

The v2.1 refresh introduced runtime theme + accent customisation, stored in `User.themePreference` / `User.accentPreference` and served in `GET /tg/me/plan` as `appearance`.

| Theme | Value | Notes |
|-------|-------|-------|
| Dark | `"dark"` | Default; available to all users |
| Black | `"black"` | PRO only |

| Accent | Value | Notes |
|--------|-------|-------|
| Violet | `"violet"` | Default; available to all users |
| Blue | `"blue"` | PRO only |
| Pink | `"pink"` | PRO only |
| Green | `"green"` | PRO only |

On PRO → FREE downgrade, the server normalises both to `dark` + `violet`.

### Priority Colors

| Level | num | Color | Background |
|-------|-----|-------|-----------|
| LOW | 1 | `#6B7FD4` | `rgba(107,127,212,0.13)` |
| MEDIUM | 2 | `#E8930A` | `rgba(232,147,10,0.13)` |
| HIGH | 3 | `#F04E6E` | `rgba(240,78,110,0.13)` |

### Typography

```typescript
const font = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif";
```

v2.1 display titles: `fontSize: 26`, `fontWeight: 700`, `letterSpacing: '-0.035em'`, `lineHeight: 1.05`.

### Button Styles (inline CSSProperties — v2.1)

| Const | Background | Text color | Width | Usage |
|-------|-----------|------------|-------|-------|
| `btnPrimary` | accent→accentDeep gradient + inset glow | `#fff` | 100% | Primary actions |
| `btnSecondary` | `C.accentSoft` + accentSoft border | `C.accent` | 100% | Secondary / ghost accent |
| `btnGhost` | transparent | `C.textSec` | auto | Subtle actions |
| `inputStyle` | `C.surface` (glass) | `C.text` | 100% | Text inputs and textareas |

Buttons: `borderRadius: 16` (v2.1, was 12), `fontSize: 15`, `fontWeight: 600`, `padding: '14px 24px'`.

### FloatingNav

`FloatingNav` (from `@wishlist/ui`) was adopted globally in W47. It provides an Instagram-like persistent bottom navigation bar across all main screens. Replaces the outer 3-tab segmented control that was previously shown only on the home screen (W69). Navigation tabs: Home (🏠), Archive (📦), Profile (👤), Reservations (🎁).

### Wave 4 primitives (provisional)

The Wave 4 sweep (April–May 2026) extracted 5 additional primitives into `packages/ui/src/`, all status `provisional` per [docs/design-system/COMPONENT_REGISTRY.md](design-system/COMPONENT_REGISTRY.md):

- `PageTitle` — page-level title block with optional subtitle
- `PickerRow` — settings-style row for picker fields (label + selected value + chevron)
- `SettingsList` — grouped settings list container with section dividers
- `TabBar` — local-tab segmented control (distinct from global `FloatingNav`)
- `TextField` — token-driven text input with label / hint / error states

In the same wave, every `btnPrimary` / `btnGhost` / `btnSecondary` spread-style button was migrated to `<Button>` from `@wishlist/ui`, and the legacy `C` color constants were swept across remaining screens to CSS custom properties (~330 sites). Result: `pnpm ui:audit` raw-value count fell monotonically across the wave.

### Pro Lifetime tile (paywall + Settings, since 2026-05-09)

The Pro paywall sheet now renders **three plan options** in a "2 + 1" layout:

- Row 1 (existing 2-col grid): Monthly · Yearly
- Row 2 (full-width premium tile): **Lifetime — 2 490 ⭐**, gold accent (`var(--wb-warning)`, no new tokens), ∞ glyph, "Навсегда" / "Forever" badge.

Default selection stays `yearly`. When Lifetime is picked, the CTA flips to a gold gradient with copy "Купить навсегда · 2 490 ⭐". The Lifetime tile appears in **every paywall sheet** — both feature-gate paywalls and the voluntary `pro_main` flow — for discovery + price anchoring (post-iter1 product decision; pivot from "headline-only" Variant A to "show in every sheet" Variant Б, logged in [docs/design-system/DESIGN_DECISIONS.md](design-system/DESIGN_DECISIONS.md)).

Settings PRO card has a parallel **lifetime variant**:

- Gold "Навсегда" pill replaces the period chip
- "Без срока окончания" line replaces the next-charge date
- Cancel / reactivate CTAs hidden (backend also returns 409 `lifetime_cannot_cancel`)
- Static info note `pro_lifetime_existing_monthly_warning` reminds the user to cancel any pre-existing monthly auto-renewal separately (Telegram keeps charging until cancelled client-side)

A celebratory bottom-sheet (`pro_lifetime_success_*` i18n) opens after a successful lifetime purchase. Mockup: [docs/design-system/mockups/approved/pro-lifetime-v1.html](design-system/mockups/approved/pro-lifetime-v1.html) (Variant A approved 2026-05-09).

### Bulk-select bottom bar (2026-05-08)

Two-defect fix: the bulk-action bar previously used `C.surface` (translucent 3.5% white elevation token) as background — items, the floating "+" FAB, and the item-counter all bled through. Switched to `C.bg` (solid). `gridTemplateColumns` synced with child count after the `curated_bulk_btn` add. The "+" Add-Wish FAB is hidden while bulk- or curated-selection mode is active (adding a wish during selection is semantically wrong and the FAB at `z:50` visually overlapped the bar). Container scroll-padding is now mode-aware:

- `bulkSelectionMode`: 210px (76 offset + 116 bar height + 18 breathing)
- `curatedSelectionMode`: 110px (70 single-row bar + 40 breathing)
- default: 90px (floating bottom-nav alone)

### Item image rendering (2026-05-08)

All 19 `<img>` renders of item photos in `MiniApp.tsx` carry `loading="lazy"` and `decoding="async"` (or just `decoding="async"` for in-modal full-size views). Image sources for URL-imported items now resolve to locally-cached `/api/uploads/<uuid>-full.jpg` (sharp pipeline: 1600px resize, mozjpeg q80) rather than raw external CDN URLs.

---

## 5. PRO Upsell System

### UpsellContext type (9 trigger points)

```typescript
type UpsellContext =
  | 'comments' | 'url_import' | 'hints'
  | 'wishlist_limit' | 'item_limit' | 'participant_limit'
  | 'subscription_limit' | 'sort_recommended'
  | 'reservation_pro'
  | 'appearance'; // v2.1: triggers when FREE user taps a locked theme or accent
```

Each context can trigger either a PRO upgrade sheet or an add-on purchase offer (when available).

### Add-on SKUs by Context

| Context | Add-on SKUs |
|---------|-------------|
| `wishlist_limit` | `extra_wishlist_slot` |
| `item_limit` | `extra_items_5`, `extra_items_15` |
| `subscription_limit` | `extra_subscription_slot` |
| `hints` | `hints_pack_5`, `hints_pack_10` |
| `url_import` | `import_pack_10`, `import_pack_25` |

Additional standalone add-ons: `seasonal_decoration`, `gift_notes_unlock`.

### getProBenefits(locale)

Returns an array of 13 PRO feature items (icon + title + subtitle from i18n):

| # | Icon | Feature |
|---|------|---------|
| 1 | -- | More wishlists (10 vs 2) |
| 2 | -- | More items per wishlist (70 vs 20) |
| 3 | -- | More participants (20 vs 5) |
| 4 | -- | Comments between owner and reserver |
| 5 | -- | URL import / auto-fill from product pages |
| 6 | -- | Hint waves to friends |
| 7 | -- | Advanced wishlist visibility (public profile / private) |
| 8 | -- | Privacy controls (allowSubscriptions, commentPolicy) |
| 10 | -- | Reservation history |
| 11 | -- | Private notes on reservations |
| 12 | -- | Reservation reminders |
| 13 | -- | "Already bought" flag |
| 14 | -- | Reservation filters & sort |

### getUpsellContent(locale)

Returns context-specific upsell sheet content:

| Context | showTable | bullets |
|---------|:---------:|:-------:|
| `comments` | false | 3 |
| `url_import` | false | 3 |
| `hints` | false | 3 |
| `wishlist_limit` | true | -- |
| `item_limit` | true | -- |
| `participant_limit` | true | -- |
| `subscription_limit` | true | -- |
| `sort_recommended` | true | -- |
| `reservation_pro` | false | 5 (history, notes, reminders, purchased, filters) |

### ProUpsellSheet component

Bottom sheet rendered when `upsellSheet: UpsellSheetState` is non-null. Shows either feature-specific bullet list or a FREE vs PRO comparison table. Always includes an "Upgrade to PRO" CTA that calls `POST /tg/billing/pro/checkout` and opens the Telegram Stars invoice link. When add-on SKUs are available for the context, also shows add-on purchase options via `POST /tg/billing/addon/checkout`.

### ProBadge component

Renders inline `PRO` text in a gradient-bordered pill (`C.accent` color family, `fontSize: 9`, `fontWeight: 800`).

---

## 6. Guest View Specifics

The `guest-view` screen is shown when the current user opens a wishlist they do not own (via share link or subscription).

### Sort Options

```typescript
type GuestSort = 'default' | 'price_asc' | 'price_desc' | 'priority_desc' | 'recommended';
```

| Option | Description | PRO Required |
|--------|-------------|:------------:|
| `default` | Server order (priority groups + position) | No |
| `price_asc` | Price low -> high | No |
| `price_desc` | Price high -> low | No |
| `priority_desc` | High priority first | No |
| `recommended` | Scored sort (see below) | Yes |

### Recommended Sort Algorithm (`guestRecommendedScore`)

Computed client-side. Higher score = shown first:

| Condition | Score bonus |
|-----------|------------|
| Priority MEDIUM | +100 |
| Priority HIGH | +200 |
| Status is `available` (not reserved) | +50 |
| Has `imageUrl` | +10 |
| Has `url` | +5 |
| Has `description` | +5 |
| Price fits within `budgetMax` | +0 to +15 (proportional) |

### Budget Filter Presets

| Label | Max value |
|-------|-----------|
| All | null |
| Under 3 000 | 3 000 |
| Under 5 000 | 5 000 |
| Under 10 000 | 10 000 |
| Under 25 000 | 25 000 |

### Subscribe Button

Guests can follow a wishlist to receive Telegram notifications. Calls `POST /tg/wishlists/:id/subscribe`. Plan-limited: FREE=2 subscriptions, PRO=5 subscriptions. Respects `allowSubscriptions` wishlist setting and owner's `subscribePolicy` profile setting.

---

## 7. Key Patterns

### No Router

Every screen transition is:
```typescript
setScreen('wishlist-detail');
setSelectedWishlist(wl);
```
No URL changes, no browser history management.

### All Styles Inline

No CSS modules, no Tailwind classes inside `MiniApp.tsx`. Every element uses `style={{ ... }}` with values from `C` or the pre-built `btnPrimary` / `inputStyle` / etc. objects.

### API Calls via fetch

```typescript
const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';

const res = await fetch(`${API_BASE}/tg/wishlists`, {
  headers: { 'X-TG-INIT-DATA': initData },
});
```

When `NEXT_PUBLIC_API_URL` is not set, `/api` is proxied to the backend by Next.js `rewrites`, avoiding CORS in development. A wrapper `tgFetch()` function auto-injects the `X-TG-INIT-DATA` header and handles JSON parsing.

### Telegram Auth

On mount the component reads `window.Telegram.WebApp.initData` into a `ref`. Every authenticated API call sends it as `X-TG-INIT-DATA`. If `initData` is empty (opened outside Telegram), the app renders an error screen.

### Telegram Keyboard Scroll Fix

`handleTextareaFocus(textarea: HTMLElement)` is attached to every `<textarea>` `onFocus`:
1. Finds the nearest scrollable parent
2. Appends a `data-kb-spacer` div with `height: 50vh` to create extra scroll room
3. On the next animation frame, scrolls the textarea to 35% from the viewport top
4. Removes the spacer on `blur`

This compensates for Telegram WebView not shrinking the viewport when the software keyboard opens.

### ActorHash

Guest identity is represented as a deterministic UUID derived from `SHA-256('tg_actor:' + telegramId)`. This is computed both client-side (`computeActorHash`) and server-side (`tgActorHash`) for reservation ownership checks. The owner never sees the guest's Telegram ID -- only the actorHash (opaque to owner).

---

## 8. Internationalization

Source: `packages/shared/src/i18n.ts`

### 6-Locale Model

```typescript
type Locale = 'ru' | 'en' | 'zh-CN' | 'hi' | 'es' | 'ar';
```

| Locale | Language | Direction |
|--------|----------|-----------|
| `ru` | Russian | LTR |
| `en` | English | LTR |
| `zh-CN` | Chinese (Simplified) | LTR |
| `hi` | Hindi | LTR |
| `es` | Spanish | LTR |
| `ar` | Arabic | RTL |

### Core Functions

- `t(key, locale, params?)` -- interpolates `{param}` placeholders in dictionary strings
- `detectLocale(languageCode?)` -- maps Telegram `language_code` to one of the 6 supported locales
- `pluralize(count, one, few, many, locale)` -- Russian-aware pluralization
- `isRTL(locale)` -- returns `true` for Arabic (`ar`)

### Locale Resolution

- Locale is resolved once on mount from `tg.initDataUnsafe.user?.language_code`
- All API notifications default to Russian (`notifLocale: 'ru'`) regardless of user locale

### RTL Support (Arabic)

The root container sets `dir={isRTL(locale) ? 'rtl' : 'ltr'}` to flip the entire layout direction for Arabic users. All inline styles use logical properties or are mirrored via the `dir` attribute.

---

## 9. Key State Variable Categories

The main component has ~300 `useState` calls. Major categories:

| Category | Examples | Approx. count |
|----------|----------|---------------|
| Screen / navigation | `screen`, `screenHistory`, `previousScreen` | ~5 |
| Wishlist data | `wishlists`, `currentWl`, `items`, `archiveItems`, `draftsItems` | ~15 |
| Item editing | `editingItem`, `viewingItem`, `editForm*` fields | ~20 |
| Guest/reservation | `guestWl`, `guestItems`, `reservations`, `reservingItem`, `reservationPro`, `resTab`, `resHistory`, `resSort`, `resStatusFilter`, `resOwnerFilter`, `resHistoryFilter` | ~25 |
| Comments | `comments`, `commentText`, `commentRole` | ~5 |
| PRO / billing | `upsellSheet`, `planLimits`, `billingLoading` | ~8 |
| Onboarding v2 | `onboardingStatus`, `onboardingTryUrl`, `onboardingCatalog*` | ~15 |
| Secret Santa | `santaCampaigns`, `currentSantaCampaign`, `santaChat*`, `santaExcl*`, `santaPolls*` | ~30 |
| Gift Notes | `gnOccasions`, `gnViewingOccasion`, `gnForm*`, `gnIdea*` | ~15 |
| Profile / settings | `profileData`, `settingsData`, `displayName`, `avatarUrl` | ~10 |
| God Mode | `godStats`, `retentionStats`, `godMode` | ~5 |
| UI state | `toasts`, `bottomSheet*`, `searchQuery`, `dragState` | ~20 |
| Subscriptions | `subscriptions`, `subscriptionsMeta` | ~5 |

---

## 10. Non-Mini-App Pages

### Admin Panel (`/admin/*`)

Protected by HTTP Basic Auth enforced in `apps/web/middleware.ts` using `ADMIN_BASIC_USER` / `ADMIN_BASIC_PASS` env vars. Admin pages call the private router on the API using `X-ADMIN-KEY`.

| Route | Purpose |
|-------|---------|
| `/admin` | List all wishlists |
| `/admin/new` | Create a wishlist |
| `/admin/[id]` | Edit wishlist title / description |

### Public Wishlist Page (`/w/:slug`)

SSR Next.js page. Fetches `GET /public/wishlists/:slug` at request time (server-side). Renders:
- Wishlist title and deadline
- Item list with status badges (available / reserved / purchased)
- Reserve / unreserve / purchased buttons powered by `actorHash` from `localStorage`
- `WishlistClient.tsx` handles all client-side interactivity

If `visibility === 'PRIVATE'` and the requester is not the owner or a subscriber, the API returns 403 and the page shows a locked state. `error.tsx` and `not-found.tsx` handle fetch errors and missing wishlists respectively.

### Middleware (`apps/web/middleware.ts`)

Runs on all routes except `_next/static`, `_next/image`, `favicon.ico`:

1. `/admin/*` -- HTTP Basic Auth gate; returns `401 WWW-Authenticate` if credentials are missing or wrong
2. Production `www.*` hostname -- `301` redirect to canonical (non-www) host
3. After successful admin auth -- adds `X-Robots-Tag: noindex, nofollow` response header
