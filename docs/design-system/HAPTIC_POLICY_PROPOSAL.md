# Haptic policy proposal — DRAFT

> **Status:** PROPOSAL, pending owner observation (1-day live window after
> Button Wave 1 deploy).
>
> Decision lands in [`DESIGN_DECISIONS.md`](./DESIGN_DECISIONS.md) once
> owner picks option. Until then, Button's default `haptic="light"` on
> `primary` / `primary-gradient` stays as-is.

## Background

Button Wave 1 (2026-04-19) shipped 6 `primary` button migrations with
`haptic="light"` default firing via Telegram WebApp
`HapticFeedback.impactOccurred('light')` on click. This is **net-new
behavior** — no previous button in WishBoard fired haptics.

Call-sites that now vibrate:

| Scenario | Call-site | Semantic |
|----------|-----------|----------|
| **Reserve CTA** | guest-view inline reserve | Action-confirming, high emotional moment |
| **Sticky create-wishlist CTA** | home sticky footer | Action-confirming, frequent |
| **Onboarding step** | onboarding next | Navigation-confirming, first-run |
| **Onboarding customize** | onboarding settings | Action-confirming, first-run |
| **Retry** | error screen retry | Recovery, low-frequency but fail-state |
| **Wishlist share inline** | wishlist-detail Share | Navigation, moderate frequency |

## Observation window

Before deciding policy, owner observes live Telegram Mini App (1 day).

### What to check

1. **Does the button feel more premium / collected with haptic?**
2. **Is the interface becoming nervous / over-stimulating?**
3. **Are any haptic firings clearly wrong** (feel out-of-place / jarring)?
4. **Does the same `light` pulse feel weird across different action types?**
   (reserve = committed gift choice; retry = recovery; navigation = neutral step)

### Scenarios to exercise explicitly

- Tap **Reserve** on a wishlist you're browsing (emotional commit)
- Tap **Create wishlist** from sticky CTA multiple times
- Run **onboarding** end-to-end (several "Далее" taps in a row)
- Trigger an **error** and tap **Retry**
- Tap **Share** inline on a wishlist

## Three policy options

### Option A — Status quo: `light` default for all primary

**State:** no code change. Every `<Button variant="primary">` or
`<Button variant="primary-gradient">` vibrates `light` on click unless
caller passes `haptic={null}`.

**Pros:**
- Consistent "button press feels tangible" signal across product.
- No caller coordination — primitive handles it.

**Cons:**
- Onboarding: 4 consecutive taps = 4 consecutive vibrations. Reads as
  nervous.
- Retry in a failure state: the pulse feels like celebration at a
  wrong moment.
- Frequent utility actions (share inline) pulse every time — noisy
  over many repetitions.

**Best if:** observation shows the product genuinely feels more premium
with universal tactile feedback and no scenario feels out-of-place.

---

### Option B — Policy-based: haptic only on action-confirming CTAs

**State:** Button default changes to **no haptic**. Call-sites that
qualify pass `haptic="light"` (or `"medium"` for high-commit moments)
explicitly.

**Policy:**

| Scenario | Haptic |
|----------|--------|
| Reserve / Unreserve / Purchase-toggle | `medium` — high-commitment gift moment |
| Create wishlist (sticky CTA, new wishlist create, first-run commit) | `light` |
| Paywall "Start PRO" / plan-confirm | `medium` |
| Secret-reservation activate / promote | `medium` |
| Group-gift "Внести свою долю" / contribution commit | `medium` |
| Onboarding next-step | `null` — frequent, not commit-moment |
| Error retry | `null` — unfortunate moment, don't celebrate |
| Inline share | `null` — utility |
| Every secondary / ghost / surface | `null` |

**Pros:**
- Matches user's predicted outcome (per follow-up message): "дорогие" для
  commit-CTA, осторожно для onboarding next, скорее нет для retry/utility.
- Heightens signal-to-noise — when haptic fires, it means something.
- Allows `medium` for truly high-commit moments (reserve, purchase,
  paywall) — signals weight of action.

**Cons:**
- Call-sites must opt in → discipline burden. New feature code needs to
  think about haptic intent.
- Inconsistent at first: some primary buttons vibrate, some don't. Could
  feel uneven if policy lines aren't clearly communicated.

**Implementation:**

```ts
// Button.tsx — flip default
haptic === null ? null : haptic ?? null
// (instead of current: variant==='primary' || variant==='primary-gradient' ? 'light' : null)
```

Then each action-confirming CTA adds `haptic="light"` or `haptic="medium"`.

**Best if:** observation confirms universal haptic feels noisy but specific
CTAs feel right.

---

### Option C — Opt-in per call-site: default off, explicit when needed

**State:** Button default changes to `haptic={null}`. Callers must
explicitly pass `haptic="light"` (or another) to opt in.

**Pros:**
- Safest — no haptic without explicit intent.
- Future-proof — if haptic policy evolves, no silent side-effects.

**Cons:**
- Easy to forget at call-site level → haptic feature goes underused.
- Loses the "primary = tactile" default convention.

**Best if:** observation shows haptic feels nice but policy isn't clear
yet; defer policy design by making it fully explicit.

---

## Recommendation

**Option B (policy-based)** is the probable fit. User's own initial
reasoning aligns:
- "да для ключевых action-confirming CTA (reserve / create / continue)"
- "осторожно для onboarding next"
- "скорее нет для retry/error или слишком частых действий"
- "точечно для premium/purchase/paywall CTA"

If observation flags onboarding-sequence or retry as specifically bad,
Option B can ship immediately. If universal `light` feels great, Option A
stays. Option C is the cautious fallback if things feel mixed.

## Decision path

1. **Deploy Button Wave 1** (current state — Option A live).
2. **1 day observation** against scenarios above.
3. **Owner picks** A / B / C with one-line rationale.
4. **If B or C**: I ship the Button default flip + per-callsite updates
   in a small focused PR. Single-file change (`packages/ui/src/Button.tsx`)
   + ~6 call-site updates for the policy-based haptic assignments.
5. **Decision entry** added to `DESIGN_DECISIONS.md` with the chosen
   option and rationale.

## Do not

- Change Button default pre-observation.
- Promote Button to canonical before policy is decided (haptic policy
  is part of the canonical contract).
- Assume observation must be complete-ish — 1 day is plenty if signals
  are clear.
