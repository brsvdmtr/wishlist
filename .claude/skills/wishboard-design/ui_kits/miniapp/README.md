# Mini App UI Kit — v2 archive

> **Status: v2 visual archive.** This kit was built before the v2.1 refresh (2026-04-21) and uses the old palette (`#7C6AFF`, `#1B1B1F`, solid `#2F2F38` cards). It's retained as a structural reference for screen layouts and interaction wiring, **not** as a current visual spec. For v2.1 colors/radii/typography, see `colors_and_type.css` and `packages/ui-tokens/src/` in the bundle root, and `mockups/approved/v2.1-refresh-all-screens.html`.

Interactive, pixel-adjacent recreation of the WishBoard Telegram Mini App. Mirrors the approved v2 mockups in `docs/design-system/mockups/approved/v2-*.html`.

## Files

| File | Role |
|---|---|
| `index.html` | Entry point. Click-through demo with 4 screens + state persistence. |
| `miniapp.css` | Tokens + component CSS (prefixed `wb-`). Derived from `_north-star-v2.css`. |
| `Primitives.jsx` | `Phone`, `Header`, `Tabs`, `StatRow`, `Chip`, `Button`, `AvatarStack`, `Banner`, `BottomNav`, `Fab`, `Sheet`. |
| `HomeScreen.jsx` | "Мои вишлисты" home — 4 stat tiles, 3 segmented tabs, owned-wishlist cards. |
| `WishlistDetailScreen.jsx` | Guest view of a friend's wishlist: hero gradient, state matrix rows, surprise-mode banner, bottom sheet for confirming a reservation. |
| `PaywallScreen.jsx` | PRO upsell, 100 ⭐/mo CTA, promo code hint. |
| `OnboardingScreen.jsx` | 3-slide first-run, violet glow halo, pagination dots. |

## Screens covered

1. **Onboarding** (3 slides) — `v2-onboarding.html`
2. **Home — Мои вишлисты** — `v2-home-all-tabs.html`
3. **Wishlist detail (guest · surprise)** — `v2-wishlist-detail-guest.html`
4. **Paywall** — `v2-paywall.html`

## Not covered (intentional)

- `v2-group-gift.html`, `v2-santa-campaign.html`, `v2-reservations-pro.html`, `v2-secret-reservation.html`, `v2-showcase-profile.html`, `v2-wish-state-matrix.html`, `v2-wishlist-detail-owner.html` — out of scope for this first pass; add on demand.

## Interactions wired

- Onboarding → Home
- Home → Wishlist detail (tap any card)
- Home → Paywall (tap FAB)
- Wishlist detail → reservation sheet (tap an active wish)
- Bottom nav → switches between screens (reservations routes to detail)
- Screen selection persists in `localStorage` (key `wb-uikit-screen-v1`)

## How interactions simplify vs. production

- No real Telegram `WebApp.initData` handshake
- No API calls; data is in-component fixtures
- No RTL / i18n switching (ru only)
- Status bar icons are glyph placeholders (`􀙇` SF Pro private codepoint)
- FAB always opens the paywall to demo the flow; in prod it opens the composer
