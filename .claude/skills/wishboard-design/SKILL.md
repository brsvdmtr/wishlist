---
name: wishboard-design
description: Use this skill to generate well-branded interfaces and assets for WishBoard (a Telegram Mini App for wishlists, brsvdmtr/wishlist), either for production or throwaway prototypes/mocks. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

## Key starting points

- `README.md` — full system overview (content, visual foundations, iconography)
- `colors_and_type.css` — canonical CSS variables (drop-in)
- `ui_kits/miniapp/` — interactive screen recreations + primitive JSX components
- `docs/design-system/mockups/approved/` — binding HTML mockups (source of truth)
- `packages/ui-tokens/src/` — raw TypeScript tokens (colors, spacing, radii, shadows, motion, gradients, typography)
- `packages/ui/src/` — production React primitives (Button, Card, Sheet, SectionHeader, ListRow, Banner, Chip, CounterBadge, StatTile, AvatarStack)

## Hard brand rules (v2.1, approved 2026-04-21)

- **Dark first, glass-on-mesh.** Background `#0F0F12` with a mesh-gradient backdrop painted as `::before`; surfaces are translucent glass (`rgba(255,255,255,0.045)`) with `backdrop-filter: blur(14–16px)`. There is no light theme.
- **One accent:** violet `#8B7BFF`. Gradients use `#8B7BFF → #B4A6FF`. Deep variant for pressed: `#8B7BFF → #5B48E5`.
- **Russian-first copy.** Informal "ты", concise, warm. Emoji used as iconography (🎁 🎄 ⭐ 🤫 💡) — never as decoration.
- **Telegram-dense.** 44 px tap targets minimum; phone frame is 375 × 812.
- **Radii v2.1:** PRIMARY radius is `18 px` (buttons, sheet-inner cards), `22 px` for cards, `28 px` for sheet top. New `650` font weight is the default for most UI text.
- **No raw hex** in new code — reach for tokens. If the value isn't there, add one.
- **Source of truth = the repo, not this skill bundle.** Tokens in `packages/ui-tokens/src/` and primitives in `packages/ui/src/` are canonical. This bundle mirrors them. If they diverge, the repo wins.
