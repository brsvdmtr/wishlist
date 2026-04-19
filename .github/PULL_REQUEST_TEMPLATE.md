# Summary

<!-- What changed and why. 1-3 sentences. -->

## Test plan

<!-- How you verified it works. Paste commands / screenshots. -->
- [ ] ...

---

## UI / Design-system checklist

_Skip this section only if the PR has no user-visible UI changes._

- [ ] **Mockup referenced** — link the `docs/design-system/mockups/approved/...` file this PR implements. If the design is still in `mockups/proposed/`, explain why (prototype? not yet approved?).
- [ ] **Primitives used** — list the `@wishlist/ui` primitives the PR touches or introduces. If the PR hand-rolls JSX that could be a primitive, say why.
- [ ] **Tokens only** — no raw hex colors, `rgba(...)` strings, magic spacing / radius / shadow numbers, or arbitrary Tailwind values in new code. Migration of adjacent legacy inline styles is welcome.
- [ ] **States covered** — default / pressed / disabled / loading / empty / error where applicable. Not just the happy path.
- [ ] **Long text tested** — titles wrap/ellipsize, descriptions don't break the layout.
- [ ] **Mobile screenshot attached** — at 375 × 812 (iPhone SE / Mini WebView). Include dark mode if the surface differs.
- [ ] **RTL checked** — for directional layouts / strings. Not required for symmetric surfaces.
- [ ] **Motion discipline** — uses `transition.*` / `animation.*` tokens, respects `prefers-reduced-motion`.
- [ ] **Tap targets ≥ 44 × 44** — especially for icon-only buttons.
- [ ] **`pnpm ui:audit` didn't worsen** — raw-value count in touched files must not rise.
- [ ] **Registry / decisions updated if needed** — new primitive or status change logged in `docs/design-system/COMPONENT_REGISTRY.md` + `docs/design-system/DESIGN_DECISIONS.md`.

<!-- Reference: docs/design-system/UI_IMPLEMENTATION_RULES.md -->
