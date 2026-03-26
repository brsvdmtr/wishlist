# FRONTEND_MAP.md — Frontend Architecture

> Date: 2026-03-26. Verified from source code.

---

## 1. File / Folder Structure

```
apps/web/
  middleware.ts                  - Basic Auth for /admin/*, www→canonical redirect
  app/
    layout.tsx                   - Root layout (fonts, metadata)
    page.tsx                     - Home/landing page
    globals.css                  - Global styles (Tailwind)
    app/
      page.tsx                   - Redirects /app → /miniapp
    miniapp/
      layout.tsx                 - Mini App layout (viewport meta, Telegram script)
      page.tsx                   - Mini App page entry (renders <MiniApp />)
      MiniApp.tsx                - THE ENTIRE MINI APP (~10000+ lines, single component)
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
  i18n.ts                        - ru + en dictionaries, t(), detectLocale(), pluralize()
  index.ts                       - Package exports
```

---

## 2. Screen State Machine

`MiniApp.tsx` manages navigation exclusively through a `useState<Screen>` hook. There is no routing library.

```typescript
type Screen =
  | 'loading'
  | 'error'
  | 'maintenance'
  | 'my-wishlists'
  | 'wishlist-detail'
  | 'item-detail'
  | 'share'
  | 'guest-view'
  | 'guest-item-detail'
  | 'archive'
  | 'drafts'
  | 'settings'
  | 'my-reservations'
  | 'profile';
```

Navigation is done by calling `setScreen(...)` together with supporting state (`setSelectedWishlist(...)`, `setSelectedItem(...)`, etc.). There are no URL changes.

### Screen Descriptions

| # | Screen | Description |
|---|--------|-------------|
| 1 | `loading` | Spinner while Telegram initData is validated and initial data is fetched |
| 2 | `error` | Error state with retry button; shown when init fetch fails |
| 3 | `maintenance` | Shown when API responds 503 with `code: 'MAINTENANCE'` |
| 4 | `my-wishlists` | Home: 3-tab segmented nav (My Wishlists / All Wishes / My Reservations) |
| 5 | `wishlist-detail` | Items list for a specific wishlist (owner view). Filter/sort, item counter, privacy settings, share button, add item, drag-to-reorder within priority group |
| 6 | `item-detail` | Full item edit/view for owner: title, description, price, priority, currency, URL, photo. Complete/delete. Comments thread. Hint button (PRO). Move to another wishlist |
| 7 | `share` | Share screen: share token link, Telegram share button, copy link |
| 8 | `guest-view` | Wishlist seen by a friend: items + reservation statuses. Filter/sort (price_asc, price_desc, priority_desc, recommended[PRO]). Budget filter. Subscribe button |
| 9 | `guest-item-detail` | Single item seen by guest: reserve/unreserve button, comments (PRO), purchased button |
| 10 | `archive` | Archived/completed items — either wishlist-specific or global. Restore/purge |
| 11 | `drafts` | SYSTEM_DRAFTS wishlist: URL-imported items awaiting curation. Move to real wishlist or edit |
| 12 | `settings` | Plan card (FREE: upgrade block; PRO: subscription info + cancel/resume). Notifications. Privacy (profileVisibility, subscribePolicy, commentsEnabled, hintsEnabled). App behavior (currency, wishlist position). Subscriptions (wishlists user follows with unread counts) |
| 13 | `my-reservations` | Items reserved by current user across all wishlists. Unread comment count badge per item |
| 14 | `profile` | User profile: avatar, displayName, username, bio, birthday. Stats (wishlists count, total wishes, reservations, archived). Plan card. Edit profile |

### Screens added since March 17

The screen count has grown from 14 to 35+. New screen types include:

- **Onboarding v2 screens** — multi-step welcome flow (welcome, import, share, reserve, complete)
- **Promo redemption screen** — enter promo code, see result
- **Public profile screen** — view another user's public profile via `profile_` deep link
- **Profile sharing screen** — share own profile link
- **Card display mode settings** — configure wishlist card appearance
- **Lifecycle messaging screens** — winback and engagement prompts
- **God mode dashboard** — A/B onboarding metrics, feature toggles

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
| `reservations` | Items reserved by the current user | `GET /tg/reservations` |

The `wishlists` tab also shows:
- A drafts banner (if SYSTEM_DRAFTS has pending items) — tapping navigates to the `drafts` screen
- A PRO upsell card for FREE users (limit info + upgrade CTA)
- A "My Reservations" quick link if `reservationsCount > 0`

---

## 4. Design System

All colors are defined in the `C` constant at the top of `MiniApp.tsx`.

### Colors

| Token | Value | Usage |
|-------|-------|-------|
| `C.bg` | `#1B1B1F` | Page background |
| `C.surface` | `#26262C` | Cards, bottom sheets |
| `C.surfaceHover` | `#2E2E36` | Hover / press states |
| `C.card` | `#2F2F38` | Item cards |
| `C.accent` | `#7C6AFF` | Primary purple: buttons, active states |
| `C.accentSoft` | `rgba(124,106,255,0.12)` | Secondary button backgrounds |
| `C.accentGlow` | `rgba(124,106,255,0.25)` | Glow effects |
| `C.green` | `#34D399` | Success, available status |
| `C.greenSoft` | `rgba(52,211,153,0.12)` | Green tinted backgrounds |
| `C.orange` | `#FBBF24` | Warning, medium priority |
| `C.orangeSoft` | `rgba(251,191,36,0.12)` | Orange tinted backgrounds |
| `C.red` | `#F87171` | Error, destructive, deleted |
| `C.redSoft` | `rgba(248,113,113,0.12)` | Red tinted backgrounds |
| `C.text` | `#F4F4F6` | Primary text |
| `C.textSec` | `#9CA3AF` | Secondary text |
| `C.textMuted` | `#6B7280` | Muted / placeholder text |
| `C.border` | `rgba(255,255,255,0.06)` | Subtle borders |
| `C.borderLight` | `rgba(255,255,255,0.1)` | Input borders |

### Priority Colors

| Level | num | Emoji | Color | Background |
|-------|-----|-------|-------|-----------|
| LOW | 1 | 🙂 | `#6B7FD4` | `rgba(107,127,212,0.13)` |
| MEDIUM | 2 | 😊 | `#E8930A` | `rgba(232,147,10,0.13)` |
| HIGH | 3 | 😍 | `#F04E6E` | `rgba(240,78,110,0.13)` |

### Typography

```typescript
const font = "-apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', sans-serif";
```

### Button Styles (inline CSSProperties)

| Const | Background | Text color | Width | Usage |
|-------|-----------|------------|-------|-------|
| `btnPrimary` | `C.accent` | `#fff` | 100% | Primary actions |
| `btnSecondary` | `C.accentSoft` | `C.accent` | 100% | Secondary / ghost accent |
| `btnGhost` | transparent | `C.textSec` | auto | Subtle actions |
| `inputStyle` | `C.surface` | `C.text` | 100% | Text inputs and textareas |

All buttons: `borderRadius: 14`, `fontSize: 15`, `fontWeight: 600`, `padding: '14px 24px'`.

---

## 5. PRO Upsell System

### UpsellContext type

```typescript
type UpsellContext =
  | 'comments'
  | 'url_import'
  | 'hints'
  | 'wishlist_limit'
  | 'item_limit'
  | 'participant_limit'
  | 'subscription_limit'
  | 'sort_recommended';
```

### getProBenefits(locale)

Returns an array of 8 PRO feature items (icon + title + subtitle from i18n):

| # | Icon | Feature |
|---|------|---------|
| 1 | 📋 | More wishlists (10 vs 2) |
| 2 | 🎁 | More items per wishlist (70 vs 20) |
| 3 | 👥 | More participants (20 vs 5) |
| 4 | 💬 | Comments between owner and reserver |
| 5 | 🔗 | URL import / auto-fill from product pages |
| 6 | 💡 | Hint waves to friends |
| 7 | 👁 | Advanced wishlist visibility (public profile / private) |
| 8 | 🛡 | Privacy controls (allowSubscriptions, commentPolicy) |

### getUpsellContent(locale)

Returns context-specific upsell sheet content:

| Context | Emoji | showTable | bullets |
|---------|-------|:---------:|:-------:|
| `comments` | 💬 | false | 3 |
| `url_import` | 🔗 | false | 3 |
| `hints` | 💡 | false | 3 |
| `wishlist_limit` | 📋 | true | — |
| `item_limit` | 🎁 | true | — |
| `participant_limit` | 👥 | true | — |
| `subscription_limit` | 🔔 | true | — |
| `sort_recommended` | ✨ | true | — |

### ProUpsellSheet component

Bottom sheet rendered when `upsellSheet: UpsellSheetState` is non-null. Shows either feature-specific bullet list or a FREE vs PRO comparison table. Always includes an "Upgrade to PRO" CTA that calls `POST /tg/billing/pro/checkout` and opens the Telegram Stars invoice link.

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
| `price_asc` | Price low → high | No |
| `price_desc` | Price high → low | No |
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

When `NEXT_PUBLIC_API_URL` is not set, `/api` is proxied to the backend by Next.js `rewrites`, avoiding CORS in development.

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

Guest identity is represented as a deterministic UUID derived from `SHA-256('tg_actor:' + telegramId)`. This is computed both client-side (`computeActorHash`) and server-side (`tgActorHash`) for reservation ownership checks. The owner never sees the guest's Telegram ID — only the actorHash (opaque to owner).

---

## 8. Internationalization

Source: `packages/shared/src/i18n.ts`

- Two dictionaries: `ru` and `en`
- `t(key, locale, params?)` — interpolates `{param}` placeholders in dictionary strings
- `detectLocale(languageCode?)` — returns `'ru'` if code starts with `'ru'`, otherwise `'en'`
- `pluralize(count, one, few, many, locale)` — Russian-aware pluralization
- Locale is resolved once on mount from `tg.initDataUnsafe.user?.language_code`
- All API notifications default to Russian (`notifLocale: 'ru'`) regardless of user locale

---

## 9. Non-Mini-App Pages

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

1. `/admin/*` — HTTP Basic Auth gate; returns `401 WWW-Authenticate` if credentials are missing or wrong
2. Production `www.*` hostname → `301` redirect to canonical (non-www) host
3. After successful admin auth — adds `X-Robots-Tag: noindex, nofollow` response header
