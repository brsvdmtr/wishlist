# Onboarding and Activation

How new users are onboarded and what counts as activation.

**Last updated:** 2026-04-02

---

## Onboarding Flow (v2)

Six screens in sequence:

1. **entry** — welcome screen
2. **try** — interactive demo prompt
3. **success** — confirmation after demo interaction
4. **recovery** — fallback if user skips or fails
5. **catalog** — browse existing wishlists
6. **create-wishlist** / **share** — create first wishlist and share it

### Entry Points

Five distinct entry points trigger the onboarding flow (e.g., first launch, deep link, etc.).

### Completion Reasons

Seven possible reasons the onboarding terminates (completed, dismissed, skipped, etc.).

## A/B Experiment

- Experiment concluded: **v2_try** variant won
- `ONBOARDING_V2_ROLLOUT` env controls rollout (default: `ab50`, now effectively 100%)
- `ONBOARDING_FORCED_USERS` env forces specific Telegram IDs into onboarding

## Activation Definition

**True activation** = user creates a real (non-demo) item in a REGULAR wishlist.

- Demo items do not count
- Items in non-REGULAR wishlists do not count

## Eligibility

A user is eligible for onboarding when:

- They have **no real items** (only demo or none)
- Their onboarding state is not `COMPLETED` or `DISMISSED`

## Key Events

- `onboarding_*` — tracks screen views and transitions
- `demo_item_*` — tracks demo item creation and conversion

## Source Paths

- Onboarding screens: `apps/web/app/miniapp/` (onboarding components)
- Onboarding API logic: `apps/api/src/` (onboarding routes/services)
