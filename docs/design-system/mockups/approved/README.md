# approved/ — binding visual source of truth

Mockups in this directory are the **canonical visual spec** for WishBoard.

> **⚠️ Files here are immutable within their approved state.**
> Changing any HTML requires a new entry in
> [`../../DESIGN_DECISIONS.md`](../../DESIGN_DECISIONS.md). Superseding a
> design means adding a new file to [`../proposed/`](../proposed) and
> running through the approval flow in
> [`../../PROMOTION_CHECKLIST.md`](../../PROMOTION_CHECKLIST.md).

## Current approved set

### North Star v2.1 — "modern 2026 refresh" (2026-04-21) · **binding visual direction**

Single-file click-through prototype with live theme/accent switching.
Shifts visual language from solid dark → **glass surfaces over mesh
gradient**, adds **themeable backgrounds & accents** (PRO-gated).

| File | Surface | Approved |
|------|---------|----------|
| `v2.1-refresh-all-screens.html` | Onboarding · Home · Wishlist guest · Create wish · Paywall · Settings (theme+accent picker) · Profile · Calendar | **2026-04-21** |

Decision log entry:
[`DESIGN_DECISIONS.md#2026-04-21--v21-refresh-approved-as-new-visual-direction-glass--mesh--theme-system`](../../DESIGN_DECISIONS.md).

### North Star v2 — feature-surface reference (2026-04-19) · `superseded-visual`

**Visual language superseded by v2.1** at the token level. Files stay
here as reference for **feature surface & information architecture** —
consult them when v2.1 prototype omits a screen (reservations,
secret-res, group-gift, santa, showcase, wish-state-matrix,
wishlist-owner). Shared stylesheet (`_north-star-v2.css`) is
historical; migrate to v2.1 tokens on touch.

| File | Surface | Approved | Status |
|------|---------|----------|--------|
| `v2-home-all-tabs.html` | Home × 3 tabs | 2026-04-19 | `superseded-visual` · v2.1 covers |
| `v2-wishlist-detail-owner.html` | Owner wishlist editing | 2026-04-19 | feature-ref · v2.1 pending |
| `v2-wishlist-detail-guest.html` | Guest share-link landing | 2026-04-19 | `superseded-visual` · v2.1 covers |
| `v2-wish-state-matrix.html` | All 15 item state combinations | 2026-04-19 | feature-ref · v2.1 pending |
| `v2-paywall.html` | Paywall — 19-PRO feature stack | 2026-04-19 | `superseded-visual` · v2.1 covers |
| `v2-reservations-pro.html` | Reservations PRO workflow | 2026-04-19 | feature-ref · v2.1 pending |
| `v2-secret-reservation.html` | 5 secret-reservation derived states | 2026-04-19 | feature-ref · v2.1 pending |
| `v2-showcase-profile.html` | Public PRO showcase profile | 2026-04-19 | feature-ref · v2.1 pending |
| `v2-group-gift.html` | Group-gift detail + chat | 2026-04-19 | feature-ref · v2.1 pending |
| `v2-santa-campaign.html` | Secret Santa participant + organizer | 2026-04-19 | feature-ref · v2.1 pending |
| `v2-onboarding.html` | Onboarding entry (4 screens) | 2026-04-19 | `superseded-visual` · v2.1 covers |

## How to use

- **Open in any browser** (double-click). HTML is self-contained, CSS is
  inlined — works from `file://` without a server.
- **Compare implementation against these files**, not against current prod
  screenshots, when deciding whether an implementation is correct.
- **Do not edit** without a decision log entry.

## Superseding an approved mockup

1. Add a new file to `../proposed/` (use a versioned name like
   `v3-<surface>.html` if incrementing on an existing approved mockup).
2. Review against the North Star principles.
3. If approved: `git mv` the superseded file here to `archive/` (create
   subdir if needed) or rename with `-v1` suffix. Move the new file into
   `approved/`.
4. Add a `supersession` entry to `../../DESIGN_DECISIONS.md`.
5. Update the table above.
